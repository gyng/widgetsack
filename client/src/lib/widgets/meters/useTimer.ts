// Stateful tick for the self-sourcing Timer widget (the documented self-sourcing exception, like Clock
// drives its own time). Timestamp-anchored so it stays accurate despite tick drift; the tick itself is
// the shared 250 ms wall clock (useNow), subscribed only while running. Pure formatting lives in
// core/timer.ts. An optional per-widget storage key keeps studio/overlay copies synchronized.
import { useCallback, useEffect, useState } from 'react';
import { useNow } from '../useNow';

export type TimerMode = 'countdown' | 'stopwatch';
export type TimerConfig = {
	mode: TimerMode;
	duration: number;
	loop?: boolean;
	storageKey?: string;
	/** Observe shared state without changing or publishing it. */
	readOnly?: boolean;
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
	setCountdown: (seconds: number) => void;
};

type Runtime = {
	running: boolean;
	accumulatedMs: number;
	startedAt: number | null;
	durationSeconds?: number;
};
type Model = { identity: string; runtime: Runtime };
type StoredTimer = { version: 1; config: string; runtime: Runtime };

const TIMER_EVENT = 'widgetsack:timer-state';
const freshRuntime = (): Runtime => ({ running: false, accumulatedMs: 0, startedAt: null });
const sameRuntime = (a: Runtime, b: Runtime): boolean =>
	a.running === b.running &&
	a.accumulatedMs === b.accumulatedMs &&
	a.startedAt === b.startedAt &&
	a.durationSeconds === b.durationSeconds;

const validRuntime = (value: unknown): value is Runtime => {
	if (!value || typeof value !== 'object') return false;
	const runtime = value as Partial<Runtime>;
	return (
		typeof runtime.running === 'boolean' &&
		typeof runtime.accumulatedMs === 'number' &&
		Number.isFinite(runtime.accumulatedMs) &&
		runtime.accumulatedMs >= 0 &&
		(runtime.durationSeconds === undefined ||
			(typeof runtime.durationSeconds === 'number' &&
				Number.isFinite(runtime.durationSeconds) &&
				runtime.durationSeconds >= 0)) &&
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
	// A widget definition/config change starts a fresh timer instead of inheriting incompatible state.
	if (model.identity !== identity) {
		setModel({ identity, runtime: loadRuntime(cfg.storageKey, config) });
	}

	const runtime = model.identity === identity ? model.runtime : freshRuntime();
	// The shared clock, ticking only while running (period 0 = unsubscribed). A shared tick can be up
	// to one period older than a `startedAt` anchored just now, hence the clamp.
	const now = useNow(runtime.running ? 250 : 0);
	const elapsedMs =
		runtime.accumulatedMs +
		(runtime.running && runtime.startedAt != null ? Math.max(0, now - runtime.startedAt) : 0);
	const duration = runtime.durationSeconds ?? cfg.duration;
	const durationMs = Math.max(0, duration * 1000);
	const elapsedSec = elapsedMs / 1000;
	const seconds = cfg.mode === 'countdown' ? Math.max(0, duration - elapsedSec) : elapsedSec;
	const done = cfg.mode === 'countdown' && duration > 0 && seconds <= 0;

	// Complete or loop before paint. Looping retains overshoot so delayed ticks do not introduce drift.
	if (done && runtime.running) {
		const next = cfg.loop
			? {
					...runtime,
					running: true,
					/* v8 ignore next -- done requires a positive countdown duration. */
					accumulatedMs: durationMs > 0 ? elapsedMs % durationMs : 0,
					startedAt: now
				}
			: { ...runtime, running: false, accumulatedMs: durationMs, startedAt: null };
		setModel({ identity, runtime: next });
	}

	useEffect(() => {
		const storageKey = cfg.storageKey;
		if (!storageKey || cfg.readOnly) return;
		const stored: StoredTimer = { version: 1, config, runtime };
		try {
			localStorage.setItem(storageKey, JSON.stringify(stored));
		} catch {
			// Timer controls remain usable when storage is disabled or full.
		}
		window.dispatchEvent(new CustomEvent(TIMER_EVENT, { detail: { storageKey, config, runtime } }));
	}, [cfg.storageKey, cfg.readOnly, config, runtime]);

	useEffect(() => {
		const storageKey = cfg.storageKey;
		if (!storageKey) return;
		const accept = (incoming: Runtime): void => {
			setModel((current) =>
				current.identity === identity && sameRuntime(current.runtime, incoming)
					? current
					: { identity, runtime: incoming }
			);
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
		if (cfg.readOnly || runtime.running) return;
		const startedAt = Date.now();
		setModel({ identity, runtime: { ...runtime, running: true, startedAt } });
	}, [cfg.readOnly, identity, runtime]);
	const pause = useCallback(() => {
		if (cfg.readOnly || !runtime.running) return;
		const pausedAt = Date.now();
		setModel({
			identity,
			runtime: {
				...runtime,
				running: false,
				/* v8 ignore next -- running runtimes are created only with a numeric startedAt anchor. */
				accumulatedMs:
					runtime.accumulatedMs +
					(runtime.startedAt == null ? 0 : Math.max(0, pausedAt - runtime.startedAt)),
				startedAt: null
			}
		});
	}, [cfg.readOnly, identity, runtime]);
	const reset = useCallback(() => {
		if (cfg.readOnly) return;
		const resetAt = Date.now();
		setModel({
			identity,
			runtime: {
				...runtime,
				running: runtime.running,
				accumulatedMs: 0,
				startedAt: runtime.running ? resetAt : null
			}
		});
	}, [cfg.readOnly, identity, runtime]);
	const setCountdown = useCallback(
		(seconds: number) => {
			if (cfg.readOnly || !Number.isFinite(seconds)) return;
			const durationSeconds = Math.max(0, Math.min(3600, seconds));
			setModel({
				identity,
				runtime: {
					running: durationSeconds > 0,
					accumulatedMs: 0,
					startedAt: durationSeconds > 0 ? Date.now() : null,
					durationSeconds
				}
			});
		},
		[cfg.readOnly, identity]
	);
	const toggle = useCallback(
		() => (runtime.running ? pause() : start()),
		[runtime.running, pause, start]
	);

	return { seconds, running: runtime.running, done, start, pause, reset, toggle, setCountdown };
}
