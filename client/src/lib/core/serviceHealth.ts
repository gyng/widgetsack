/** Mirrors ServiceHealth in widgetsack/src/service_health.rs. */
import { boundedNumber } from './dashboard';
export type ServiceHealthSnapshot = {
	status: number | null;
	latencyMs: number;
	certificateDays: number | null;
	error: string | null;
};
export function serviceHealthLevel(
	result: ServiceHealthSnapshot | null,
	slowMs: number,
	warnDays: number
): { state: 'unknown' | 'down' | 'warning' | 'slow' | 'up'; label: string } {
	if (!result) return { state: 'unknown', label: 'Checking…' };
	if (result.error || result.status === null || result.status < 200 || result.status >= 400)
		return { state: 'down', label: 'down' };
	if (result.status >= 300) return { state: 'warning', label: 'redirect' };
	if (result.certificateDays !== null && result.certificateDays <= warnDays)
		return { state: 'warning', label: 'certificate warning' };
	if (result.latencyMs >= slowMs) return { state: 'slow', label: 'slow' };
	return { state: 'up', label: 'up' };
}
/** Guard imported or cleared settings as well as values entered through the Inspector. */
export function servicePollDelay(seconds: number): number {
	return boundedNumber(seconds, 60, 15, 3600) * 1000;
}
