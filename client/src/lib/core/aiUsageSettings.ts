export type UsageLayout = 'detailed' | 'compact' | 'minimal';

/** Saved layouts using the original two toggles keep their density until explicitly changed. */
export function resolveUsageLayout(config: Record<string, unknown>): UsageLayout {
	if (config.layout === 'minimal' || config.layout === 'compact' || config.layout === 'detailed')
		return config.layout;
	return config.minimal === true ? 'minimal' : config.compact === false ? 'detailed' : 'compact';
}

export type UsageSettings = {
	remaining: boolean;
	showMode: boolean;
	showResets: boolean;
	resetDisplay: 'countdown' | 'date' | 'both';
	warning: number;
	critical: number;
	graphHours: number;
	graphMetric: 'tokens' | 'credits' | 'quota';
	rateHours: number;
};
const numeric = {
	warning: [0, 100],
	critical: [0, 100],
	graphHours: [1, 720],
	rateHours: [0.25, 24]
} as const;
export function readUsageSettings(value: unknown): Partial<UsageSettings> {
	const input =
		value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	const result: Partial<UsageSettings> = {};
	for (const key of ['remaining', 'showResets', 'showMode'] as const)
		if (typeof input[key] === 'boolean') result[key] = input[key];
	for (const key of ['warning', 'critical', 'graphHours', 'rateHours'] as const) {
		const n = input[key];
		const [min, max] = numeric[key];
		if (typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max) result[key] = n;
	}
	if (
		input.resetDisplay === 'countdown' ||
		input.resetDisplay === 'date' ||
		input.resetDisplay === 'both'
	)
		result.resetDisplay = input.resetDisplay;
	if (
		input.graphMetric === 'tokens' ||
		input.graphMetric === 'credits' ||
		input.graphMetric === 'quota'
	)
		result.graphMetric = input.graphMetric;
	return result;
}
export function resolveUsageSettings(
	value: Partial<UsageSettings>,
	defaults: Partial<UsageSettings> = {}
): UsageSettings {
	return {
		remaining: true,
		showMode: false,
		showResets: false,
		resetDisplay: 'countdown',
		warning: 80,
		critical: 95,
		graphHours: 24,
		graphMetric: 'tokens',
		rateHours: 1,
		...defaults,
		...value
	};
}
export function usageResetText(at: number, now: number): string {
	const minutes = (at - now) / 60000;
	if (minutes <= 0) return 'due';
	if (minutes >= 10080) return `${Math.floor(minutes / 10080)}w`;
	if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d`;
	if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
	return `${Math.max(1, Math.ceil(minutes))}m`;
}
