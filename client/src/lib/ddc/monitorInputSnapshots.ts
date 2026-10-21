import type { MonitorInputs } from './monitors';

const PREFIX = 'widgetsack.monitor-inputs.v1:';
const key = (target: string) => PREFIX + encodeURIComponent(target);
const nonnegative = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;
const input = (value: unknown): value is number =>
	nonnegative(value) && Number.isInteger(value) && value <= 255;

/** Persist the last successful response, never optimistic input changes or credentials. */
export function readMonitorInputSnapshot(target: string): MonitorInputs | null {
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(key(target)) ?? 'null');
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
		const value = raw as Partial<MonitorInputs>;
		if (
			typeof value.gdi !== 'string' ||
			typeof value.stable !== 'string' ||
			typeof value.friendly !== 'string' ||
			typeof value.primary !== 'boolean' ||
			!(value.current_input === null || input(value.current_input)) ||
			!Array.isArray(value.supported) ||
			!value.supported.every(input) ||
			!nonnegative(value.width) ||
			!nonnegative(value.height) ||
			!nonnegative(value.refresh_hz)
		)
			return null;
		return value as MonitorInputs;
	} catch {
		return null;
	}
}

export function saveMonitorInputSnapshot(target: string, value: MonitorInputs): void {
	try {
		localStorage.setItem(key(target), JSON.stringify(value));
	} catch {
		// A full or unavailable cache must not prevent a live monitor refresh.
	}
}
