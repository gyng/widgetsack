// Stateful tick for the self-sourcing Timer widget (the documented self-sourcing exception, like Clock
// drives its own time). Timestamp-anchored so it stays accurate despite interval drift; pure formatting
// lives in core/timer.ts.
import { useCallback, useEffect, useState } from 'react';

export type TimerMode = 'countdown' | 'stopwatch';
export type TimerConfig = { mode: TimerMode; duration: number; loop?: boolean };
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

export function useTimer(cfg: TimerConfig): TimerState {
	const [running, setRunning] = useState(false);
	const [now, setNow] = useState(() => Date.now()); // advanced by the tick while running
	const [accum, setAccum] = useState(0); // ms accumulated while paused
	const [startAt, setStartAt] = useState<number | null>(null); // Date.now() at the last start

	// Elapsed ms, derived purely from state — no ref reads and no Date.now() during render.
	const elapsedMs = accum + (running && startAt != null ? now - startAt : 0);

	useEffect(() => {
		if (!running) return;
		const id = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(id);
	}, [running]);

	const start = useCallback(() => {
		if (running) return;
		const t = Date.now();
		setStartAt(t);
		setNow(t);
		setRunning(true);
	}, [running]);
	const pause = useCallback(() => {
		if (!running) return;
		setAccum((a) => a + (startAt != null ? Date.now() - startAt : 0));
		setStartAt(null);
		setRunning(false);
	}, [running, startAt]);
	const reset = useCallback(() => {
		const t = Date.now();
		setAccum(0);
		setStartAt(running ? t : null);
		setNow(t);
	}, [running]);
	const toggle = useCallback(() => (running ? pause() : start()), [running, pause, start]);

	const elapsedSec = elapsedMs / 1000;
	const seconds = cfg.mode === 'countdown' ? Math.max(0, cfg.duration - elapsedSec) : elapsedSec;
	const done = cfg.mode === 'countdown' && cfg.duration > 0 && seconds <= 0;

	// On a countdown reaching zero: loop (re-anchor to now) or auto-stop, frozen exactly at 0. Handled
	// as an adjust-during-render (React re-renders before paint) so it isn't a setState-in-effect. The
	// loop re-anchors to the state `now` rather than Date.now() (which would be impure during render).
	const [prevDone, setPrevDone] = useState(done);
	if (done !== prevDone) {
		setPrevDone(done);
		if (done && running) {
			if (cfg.loop) {
				setAccum(0);
				setStartAt(now);
			} else {
				setStartAt(null);
				setAccum(cfg.duration * 1000);
				setRunning(false);
			}
		}
	}

	return { seconds, running, done, start, pause, reset, toggle };
}
