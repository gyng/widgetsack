import type { SensorState } from './telemetry';
import { parseAgendaList } from './agenda';

export type AlertRule = {
	id: string;
	sensor: string;
	op: 'above' | 'below';
	threshold: number;
	label: string;
};

export function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
	const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
	return Math.max(min, Math.min(max, number));
}

/** One rule per line: sensor|above/below|threshold|message. Invalid rows are ignored. */
export function alertRules(spec: string): AlertRule[] {
	return spec.split(/[;\n]/).flatMap((line, i) => {
		const [sensor, op, raw, label] = line.split('|').map((s) => s.trim());
		const threshold = Number(raw);
		if (
			!sensor ||
			(op !== 'above' && op !== 'below') ||
			!raw ||
			!Number.isFinite(threshold) ||
			!label
		)
			return [];
		return [{ id: `rule:${i}:${line.trim()}`, sensor, op, threshold, label }];
	});
}

export function activeAlerts(
	rules: AlertRule[],
	sensors: Record<string, SensorState>,
	snoozes: Record<string, number>,
	now: number
): AlertRule[] {
	return rules.filter((r) => {
		const value = sensors[r.sensor]?.value;
		if (
			!value ||
			value.kind !== 'scalar' ||
			!Number.isFinite(value.value) ||
			(snoozes[r.id] ?? 0) > now
		)
			return false;
		return r.op === 'above' ? value.value >= r.threshold : value.value <= r.threshold;
	});
}

export function historySummary(
	values: number[]
): { min: number; average: number; max: number } | null {
	const finite = values.filter(Number.isFinite);
	if (!finite.length) return null;
	return {
		min: Math.min(...finite),
		average: finite.reduce((a, b) => a + b, 0) / finite.length,
		max: Math.max(...finite)
	};
}

export function historyScale(
	lines: number[][],
	min: number | null,
	max: number | null
): [number, number] {
	const summary = historySummary(lines.flat());
	const lo = min !== null && Number.isFinite(min) ? min : (summary?.min ?? 0);
	const hi = max !== null && Number.isFinite(max) ? max : (summary?.max ?? 1);
	return [lo, hi > lo ? hi : lo + 1];
}

export function historyWindow(samples: number): number {
	return Math.round(boundedNumber(samples, 60, 1, 600));
}

export type Task = { id: string; text: string; done: boolean };

/** Agenda reminders are derived from the existing ICS source, never from a second calendar poller. */
export function meetingAlerts(
	state: SensorState | undefined,
	now: number,
	minutes: number
): AlertRule[] {
	if (!state?.value || state.value.kind !== 'json' || minutes <= 0) return [];
	return parseAgendaList(state.value.value).flatMap((event) => {
		const remaining = new Date(event.start).getTime() - now;
		if (event.allDay || !Number.isFinite(remaining) || remaining < 0 || remaining > minutes * 60000)
			return [];
		return [
			{
				id: `meeting:${event.start}:${event.summary}`,
				sensor: 'agenda.list',
				op: 'below' as const,
				threshold: 0,
				label: `${event.summary} in ${Math.ceil(remaining / 60000)} minutes`
			}
		];
	});
}
export function decodeTasks(raw: string | null): Task[] {
	try {
		const data: unknown = JSON.parse(raw ?? '[]');
		if (!Array.isArray(data)) return [];
		const seen = new Set<string>();
		return data.flatMap((x) => {
			if (
				!x ||
				typeof x.id !== 'string' ||
				!x.id.trim() ||
				typeof x.text !== 'string' ||
				!x.text.trim() ||
				typeof x.done !== 'boolean' ||
				seen.has(x.id)
			)
				return [];
			seen.add(x.id);
			return [{ id: x.id, text: x.text, done: x.done }];
		});
	} catch {
		return [];
	}
}
