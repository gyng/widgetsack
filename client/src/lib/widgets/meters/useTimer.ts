// Stateful tick for the self-sourcing Timer widget (the documented self-sourcing exception, like Clock
// drives its own time). Timestamp-anchored so it stays accurate despite interval drift; pure formatting
// lives in core/timer.ts. An optional per-widget storage key keeps studio/overlay copies synchronized.
import { useCallback, useEffect, useState } from 'react';

export type TimerMode = 'countdown' | 'stopwatch';
export type TimerConfig = {
	mode: TimerMode;
	duration: number;
	loop?: boolean;
	storageKey?: string;
};
export type TimerState = {
	/** Seconds remaining (countdown) or elapsed (stopwatch). */
	seconds: number;
	running: boolean;
	/** A countdown has reached zero. */
	done: boolean;
	start: () => void;
	pause: () => void;
	reset: () => void;
	toggle: () => void;
};

type Runtime = { running: boolean; accumulatedMs: number; startedAt: number | null };
type Model = { identity: string; runtime: Runtime };
type StoredTimer = { version: 1; config: string; runtime: Runtime };

const TIMER_EVENT = 'widgetsack:timer-state';
const freshRuntime = (): Runtime => ({ running: false, accumulatedMs: 0, startedAt: null });
const sameRuntime = (a: Runtime, b: Runtime): boolean =>
	a.running === b.running && a.accumulatedMs === b.accumulatedMs && a.startedAt === b.startedAt;

const validRuntime = (value: unknown): value is Runtime => {
	if (!value || typeof value !== 'object') return false;
	const runtime = value as Partial<Runtime>;
	return (
		typeof runtime.running === 'boolean' &&
		typeof runtime.accumulatedMs === 'number' &&
		Number.isFinite(runtime.accumulatedMs) &&
		(runtime.startedAt === null ||
			(typeof runtime.startedAt === 'number' && Number.isFinite(runtime.startedAt)))
	);
};

const loadRuntime = (storageKey: string | undefined, config: string): Runtime => {
	if (!storageKey) return freshRuntime();
	try {
		const raw = localStorage.getItem(storageKey);
		if (!raw) return freshRuntime();
		const stored = JSON.parse(raw) as Partial<StoredTimer>;
		return stored.version === 1 && stored.config === config && validRuntime(stored.runtime)
			? stored.runtime
			: freshRuntime();
	} catch {
		return freshRuntime();
	}
};

export function useTimer(cfg: TimerConfig): TimerState {
	const config = `${cfg.mode}:${cfg.duration}:${cfg.loop ? 1 : 0}`;
	const identity = `${cfg.storageKey ?? ''}\n${config}`;
	const [model, setModel] = useState<Model>(() => ({
		identity,
		runtime: loadRuntime(cfg.storageKey, config)
	}));
	const [now, setNow] = useState(() => Date.now());

	// A widget definition/config change starts a fresh timer instead of inheriting incompatible state.
	if (model.identity !== identity) {
		setModel({ identity, runtime: loadRuntime(cfg.storageKey, config) });
		setNow(Date.now());
	}

	const runtime = model.identity === identity ? model.runtime : freshRuntime();
	const elapsedMs =
		runtime.accumulatedMs +
		(runtime.running && runtime.startedAt != null ? now - runtime.startedAt : 0);
	const durationMs = Math.max(0, cfg.duration * 1000);
	const elapsedSec = elapsedMs / 1000;
	const seconds = cfg.mode === 'countdown' ? Math.max(0, cfg.duration - elapsedSec) : elapsedSec;
	const done = cfg.mode === 'countdown' && cfg.duration > 0 && seconds <= 0;

	// Complete or loop before paint. Looping retains overshoot so delayed ticks do not introduce drift.
	if (done && runtime.running) {
		const next = cfg.loop
			? {
					running: true,
					accumulatedMs: durationMs > 0 ? elapsedMs % durationMs : 0,
					startedAt: now
				}
			: { running: false, accumulatedMs: durationMs, startedAt: null };
		setModel({ identity, runtime: next });
	}

	useEffect(() => {
		if (!runtime.running) return;
		const id = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(id);
	}, [runtime.running]);

	useEffect(() => {
		const storageKey = cfg.storageKey;
		if (!storageKey) return;
		const stored: StoredTimer = { version: 1, config, runtime };
		try {
			localStorage.setItem(storageKey, JSON.stringify(stored));
		} catch {
			// Timer controls remain usable when storage is disabled or full.
		}
		window.dispatchEvent(new CustomEvent(TIMER_EVENT, { detail: { storageKey, config, runtime } }));
	}, [cfg.storageKey, config, runtime]);

	useEffect(() => {
		const storageKey = cfg.storageKey;
		if (!storageKey) return;
		const accept = (incoming: Runtime): void => {
			setModel((current) =>
				current.identity === identity && sameRuntime(current.runtime, incoming)
					? current
					: { identity, runtime: incoming }
			);
			setNow(Date.now());
		};
		const onTimer = (event: Event): void => {
			const detail = (event as CustomEvent).detail as Partial<{
				storageKey: string;
				config: string;
				runtime: Runtime;
			}>;
			if (
				detail.storageKey === storageKey &&
				detail.config === config &&
				validRuntime(detail.runtime)
			) {
				accept(detail.runtime);
			}
		};
		const onStorage = (event: StorageEvent): void => {
			if (event.key !== storageKey || !event.newValue) return;
			try {
				const stored = JSON.parse(event.newValue) as Partial<StoredTimer>;
				if (stored.version === 1 && stored.config === config && validRuntime(stored.runtime)) {
					accept(stored.runtime);
				}
			} catch {
				// Ignore malformed state written by an older build or another origin client.
			}
		};
		window.addEventListener(TIMER_EVENT, onTimer);
		window.addEventListener('storage', onStorage);
		return () => {
			window.removeEventListener(TIMER_EVENT, onTimer);
			window.removeEventListener('storage', onStorage);
		};
	}, [cfg.storageKey, config, identity]);

	const start = useCallback(() => {
		if (runtime.running) return;
		const startedAt = Date.now();
		setNow(startedAt);
		setModel({ identity, runtime: { ...runtime, running: true, startedAt } });
	}, [identity, runtime]);
	const pause = useCallback(() => {
		if (!runtime.running) return;
		const pausedAt = Date.now();
		setNow(pausedAt);
		setModel({
			identity,
			runtime: {
				running: false,
				accumulatedMs:
					runtime.accumulatedMs + (runtime.startedAt == null ? 0 : pausedAt - runtime.startedAt),
				startedAt: null
			}
		});
	}, [identity, runtime]);
	const reset = useCallback(() => {
		const resetAt = Date.now();
		setNow(resetAt);
		setModel({
			identity,
			runtime: {
				running: runtime.running,
				accumulatedMs: 0,
				startedAt: runtime.running ? resetAt : null
			}
		});
	}, [identity, runtime.running]);
	const toggle = useCallback(
		() => (runtime.running ? pause() : start()),
		[runtime.running, pause, start]
	);

	return { seconds, running: runtime.running, done, start, pause, reset, toggle };
}
