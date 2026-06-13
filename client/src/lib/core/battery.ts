// Pure presentation helpers for the Battery widget — no React/DOM, unit-tested (battery.test.ts).
import { formatDuration } from './format';

/** The short status line under the percent. `state` is the backend `battery.state`
 * ('charging' | 'ac' | 'discharging' | 'unknown'); `timeSeconds` is `battery.time` (remaining
 * discharge seconds — only meaningful while discharging; null/≤0 = unknown). */
export function batteryStatusText(state: string | null, timeSeconds: number | null): string {
	switch (state) {
		case 'charging':
			return 'Charging';
		case 'ac':
			return 'Plugged in';
		case 'discharging':
			return timeSeconds && timeSeconds > 0 ? `${formatDuration(timeSeconds)} left` : 'On battery';
		default:
			return '';
	}
}

/** Severity bucket for styling the fill: 'critical' ≤10%, 'low' ≤20%, else 'ok'. Charging always
 * reads 'ok' (it's filling), as does an unknown percent. */
export function batteryLevel(percent: number | null, charging: boolean): 'ok' | 'low' | 'critical' {
	if (charging || percent == null) return 'ok';
	if (percent <= 10) return 'critical';
	if (percent <= 20) return 'low';
	return 'ok';
}
