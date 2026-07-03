// Per-instance generation for the AI Briefing widget — the stateful half of the AssistantHost
// container (AGENTS.md §6: wiring lives in the widgets layer, not in meters/). It snapshots the live
// sensor hub, calls the LLM provider on the widget's own schedule (interval or cron), and exposes
// the text; the pure meters/Assistant meter just renders what it's given. Pure logic lives
// elsewhere — the schedule math in core/schedule.ts, the prompt in core/llm.ts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTelemetryHub } from './telemetryContext';
import type { SensorValue, TelemetryHub } from '../core/telemetry';
import { buildAssistantMessages } from '../core/llm';
import { cronMatches, intervalMs, isCron } from '../core/schedule';
import { isStudioWindow } from '../overlay';
import { speakSmart } from './plugins/llm-tts';
import { llmComplete } from './plugins/llm-commands';

// The default sensor snapshot ("auto") — present-only; absent ids are skipped.
const AUTO_WATCH = [
	'cpu.total',
	'mem.used',
	'gpu.util',
	'gpu.temp',
	'net.down',
	'net.up',
	'host.uptime',
	'battery.percent',
	'proc.cpu.top.name',
	'proc.mem.top.name'
];
const MIN_INTERVAL_MS = 15_000; // floor so a misconfigured "1s" can't hammer a paid API
const FIRST_DELAY_MS = 3_000;

function readingOf(v: SensorValue | null): number | string | null {
	if (!v) return null;
	if (v.kind === 'scalar') return Math.round(v.value * 10) / 10;
	if (v.kind === 'text') return v.value;
	return null;
}

function snapshot(hub: TelemetryHub, sensorsCsv: string): Record<string, number | string> {
	const csv = sensorsCsv.trim();
	const ids =
		csv && csv.toLowerCase() !== 'auto'
			? csv
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			: AUTO_WATCH;
	const out: Record<string, number | string> = {};
	for (const id of ids) {
		const r = readingOf(hub.sensor(id).getSnapshot().value);
		if (r !== null) out[id] = r;
	}
	return out;
}

export type AssistantConfig = {
	prompt: string;
	schedule: string;
	sensors: string;
	speak?: boolean;
};
export type AssistantState = { text: string; busy: boolean; error: string; refresh: () => void };

export function useAssistant(cfg: AssistantConfig): AssistantState {
	const hub = useTelemetryHub();
	const [text, setText] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	// Latest config without retriggering the generator's identity on every keystroke. Committed after
	// render (not during it); `generate` only reads it later, from timers/handlers.
	const cfgRef = useRef(cfg);
	useEffect(() => {
		cfgRef.current = cfg;
	});

	const generate = useCallback(async (): Promise<void> => {
		setBusy(true);
		setError('');
		try {
			const readings = snapshot(hub, cfgRef.current.sensors);
			const out = await llmComplete(buildAssistantMessages(cfgRef.current.prompt, readings), {
				temperature: 0.4,
				maxTokens: 200
			});
			const trimmed = out.trim();
			setText(trimmed);
			if (cfgRef.current.speak) void speakSmart(trimmed);
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	}, [hub]);

	useEffect(() => {
		// Auto-generation runs ONLY on the overlay (the always-on surface). The studio shows the last
		// value + a manual refresh, so editing a layout doesn't rack up paid calls.
		if (isStudioWindow()) return;
		let cancelled = false;
		const tick = (): void => {
			if (!cancelled) void generate();
		};
		const timers: ReturnType<typeof setInterval>[] = [];
		const initial = setTimeout(tick, FIRST_DELAY_MS);
		const ms = intervalMs(cfg.schedule);
		if (ms !== null) {
			timers.push(setInterval(tick, Math.max(MIN_INTERVAL_MS, ms)));
		} else if (isCron(cfg.schedule)) {
			// Dedup by the absolute minute (epoch/60000), NOT clock h:m — an h:m key recurs every day, so
			// a daily/weekly cron would fire once and then be permanently suppressed. The minute index is
			// monotonic, so each matching minute fires exactly once.
			let lastFireMinute = -1;
			timers.push(
				setInterval(() => {
					const now = new Date();
					const minute = Math.floor(now.getTime() / 60_000);
					if (cronMatches(cfg.schedule, now) && minute !== lastFireMinute) {
						lastFireMinute = minute;
						tick();
					}
				}, 30_000)
			);
		}
		return () => {
			cancelled = true;
			clearTimeout(initial);
			timers.forEach(clearInterval);
		};
	}, [cfg.schedule, generate]);

	const refresh = useCallback(() => void generate(), [generate]);
	return { text, busy, error, refresh };
}
