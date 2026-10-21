import { readUsageSettings, type UsageSettings } from './aiUsageSettings';
import { readProviderIcon, type ProviderIconChoice } from './providerIcons';
// Provider-independent usage contract. No credentials or IO belong in this module.
export type UsageSource = 'codex' | 'claude' | 'openrouter' | 'omp' | 'command';
export const usageItems = [
	'session',
	'week',
	'other',
	'tokens',
	'credits',
	'banked',
	'graph',
	'eta',
	'resets'
] as const;
export type UsageItem = (typeof usageItems)[number];
export type UsageProvider = {
	icon?: ProviderIconChoice;
	order: UsageItem[];
	settings: Record<UsageItem | 'eta', Partial<UsageSettings>>;
	labels: Partial<Record<UsageItem, string>>;
	id: string;
	source: UsageSource;
	label: string;
	enabled: boolean;
	command: string;
	env: string;
	account: string;
	compact: 'inherit' | 'compact' | 'detailed';
	session: boolean;
	week: boolean;
	other: boolean;
	tokens: boolean;
	credits: boolean;
	banked: boolean;
	eta: boolean;
	resets: boolean;
	graph: boolean;
};
export type UsageMetric = {
	id: string;
	label: string;
	kind: 'quota' | 'tokens' | 'credits';
	used?: number;
	remaining?: number;
	limit?: number;
	unit: string;
	period: string;
	scope: string;
	resetsAt?: number;
};
export type UsageSnapshot = {
	version: 1;
	metrics: UsageMetric[];
	bankedResets?: { available: number; expiresAt?: number };
	note?: string;
};
export type UsagePoint = { at: number; metrics: UsageMetric[] };
const sources = ['codex', 'claude', 'openrouter', 'omp', 'command'];
const record = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export function usageProviders(value: unknown): UsageProvider[] {
	if (!Array.isArray(value)) return defaultUsageProviders();
	return value.flatMap((v, i) => {
		const p = record(v);
		if (!sources.includes(String(p.source))) return [];
		const source = p.source as UsageSource;
		return [
			{
				icon: readProviderIcon(p.icon),
				settings: Object.fromEntries(
					usageItems.map((key) => [key, readUsageSettings(record(p.settings)[key])])
				) as UsageProvider['settings'],
				labels: Object.fromEntries(
					usageItems.flatMap((key) => {
						const label = record(p.labels)[key];
						return typeof label === 'string' && label.trim() ? [[key, label]] : [];
					})
				),
				order: [
					...new Set([
						...(Array.isArray(p.order)
							? p.order.filter((key): key is UsageItem => usageItems.includes(key))
							: []),
						...usageItems
					])
				],
				id: String(p.id ?? `${source}-${i}`),
				source,
				label: String(p.label ?? source),
				enabled: p.enabled !== false,
				command: String(p.command ?? ''),
				env: String(p.env ?? 'OPENROUTER_API_KEY'),
				account: String(p.account ?? ''),
				compact: p.compact === 'compact' || p.compact === 'detailed' ? p.compact : 'inherit',
				session: p.session !== false,
				week: p.week !== false,
				other: p.other !== false,
				tokens: p.tokens !== false,
				credits: p.credits !== false,
				banked: p.banked !== false,
				eta: p.eta !== false,
				resets: p.resets === true,
				graph: p.graph === true
			}
		];
	});
}
export function defaultUsageProviders(): UsageProvider[] {
	return usageProviders([
		{ id: 'codex', source: 'codex', label: 'Codex' },
		{ id: 'claude', source: 'claude', label: 'Claude' }
	]);
}
export function usageSourceKey(p: UsageProvider): string {
	return JSON.stringify([p.source, p.command, p.env, p.account]);
}
export function usagePollingSpec(value: unknown): string {
	const sources = new Map(
		usageProviders(value)
			.filter((p) => p.enabled)
			.map((p) => [
				usageSourceKey(p),
				{ source: p.source, command: p.command, env: p.env, account: p.account }
			])
	);
	return JSON.stringify(
		[...sources.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, source]) => source)
	);
}
function positive(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}
export function parseUsage(input: unknown): UsageSnapshot {
	const data = record(input);
	if (data.version !== 1 || !Array.isArray(data.metrics))
		throw new Error('Expected usage JSON version 1 with a metrics array');
	const ids = new Set<string>();
	const metrics = data.metrics.map((raw): UsageMetric => {
		const m = record(raw);
		if (
			typeof m.id !== 'string' ||
			!m.id ||
			ids.has(m.id) ||
			typeof m.label !== 'string' ||
			!['quota', 'tokens', 'credits'].includes(String(m.kind)) ||
			typeof m.unit !== 'string' ||
			typeof m.period !== 'string' ||
			typeof m.scope !== 'string'
		)
			throw new Error('Invalid or duplicate usage metric');
		ids.add(m.id);
		for (const key of ['used', 'remaining', 'limit', 'resetsAt'])
			if (m[key] !== undefined && !positive(m[key]))
				throw new Error(`Invalid ${key} in usage metric`);
		if (m.used === undefined && m.remaining === undefined)
			throw new Error('Usage metric needs used or remaining');
		return {
			id: m.id,
			label: m.label,
			kind: m.kind as UsageMetric['kind'],
			unit: m.unit,
			period: m.period,
			scope: m.scope,
			...(m.used !== undefined ? { used: m.used as number } : {}),
			...(m.remaining !== undefined ? { remaining: m.remaining as number } : {}),
			...(m.limit !== undefined ? { limit: m.limit as number } : {}),
			...(m.resetsAt !== undefined ? { resetsAt: m.resetsAt as number } : {})
		};
	});
	const out: UsageSnapshot = { version: 1, metrics };
	if (data.bankedResets !== undefined) {
		const b = record(data.bankedResets);
		if (
			!positive(b.available) ||
			!Number.isInteger(b.available) ||
			(b.expiresAt !== undefined && !positive(b.expiresAt))
		)
			throw new Error('Invalid banked reset count');
		out.bankedResets = {
			available: b.available,
			...(b.expiresAt !== undefined ? { expiresAt: b.expiresAt as number } : {})
		};
	}
	if (typeof data.note === 'string') out.note = data.note;
	return out;
}
export function usageMetricItem(m: UsageMetric): UsageItem {
	return m.kind !== 'quota'
		? m.kind
		: m.period === 'session'
			? 'session'
			: m.period === 'week'
				? 'week'
				: 'other';
}
export function visibleUsageMetrics(metrics: UsageMetric[], p: UsageProvider): UsageMetric[] {
	return metrics
		.filter((m) =>
			m.kind === 'tokens'
				? p.tokens
				: m.kind === 'credits'
					? p.credits
					: m.period === 'session'
						? p.session
						: m.period === 'week'
							? p.week
							: p.other
		)
		.sort((a, b) => p.order.indexOf(usageMetricItem(a)) - p.order.indexOf(usageMetricItem(b)));
}
// Five-minute buckets, thirty-day retention. Never mutate another consumer's snapshot.
export function appendUsageHistory(
	history: UsagePoint[],
	point: UsagePoint,
	now: number
): UsagePoint[] {
	const buckets = new Map<number, UsagePoint>();
	for (const p of [...history, point]) {
		if (p.at < now - 30 * 86400000 || p.at > now) continue;
		const key = Math.floor(p.at / 300000);
		const existing = buckets.get(key);
		if (!existing || existing.at < p.at) buckets.set(key, p);
	}
	return [...buckets.values()].sort((a, b) => a.at - b.at).slice(-8641);
}
// Provider reset estimates can drift slightly between reads (observed with Claude). Keep
// minute-level rounding jitter inside one window; counter drops still reset the trend below.
function sameUsageReset(a: number | undefined, b: number | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && Math.abs(a - b) <= 60000);
}
export function usageTrend(
	history: UsagePoint[],
	metric: UsageMetric,
	now: number,
	hours: number
): {
	state: 'collecting' | 'idle' | 'active';
	rate?: number;
	etaHours?: number;
	resetFirst?: boolean;
} {
	let points: { at: number; value: number }[] = [];
	const balance = metric.used === undefined;
	for (const point of history) {
		if (point.at < now - hours * 3600000 || point.at > now) continue;
		const m = point.metrics.find((m) => m.id === metric.id);
		if (
			!m ||
			!sameUsageReset(m.resetsAt, metric.resetsAt) ||
			m.period !== metric.period ||
			m.scope !== metric.scope ||
			m.kind !== metric.kind ||
			m.unit !== metric.unit
		) {
			points = [];
			continue;
		}
		const value = balance ? m.remaining : m.used;
		if (value === undefined) {
			points = [];
			continue;
		}
		const previous = points.at(-1);
		if (
			previous &&
			(point.at - previous.at > 7200000 ||
				(balance ? value > previous.value : value < previous.value))
		)
			points = [];
		points.push({ at: point.at, value });
	}
	const first = points[0];
	const last = points.at(-1);
	if (!first || !last || last.at - first.at < 300000 || now - last.at > 1800000)
		return { state: 'collecting' };
	const rate =
		(balance ? first.value - last.value : last.value - first.value) /
		((last.at - first.at) / 3600000);
	if (rate <= 0) return { state: 'idle' };
	const remaining =
		metric.remaining ??
		// A validated metric without remaining always has used.
		(metric.limit === undefined ? undefined : Math.max(0, metric.limit - metric.used!));
	const etaHours = remaining === undefined ? undefined : remaining / rate;
	return {
		state: 'active',
		rate,
		...(etaHours !== undefined
			? {
					etaHours,
					resetFirst:
						metric.resetsAt !== undefined &&
						metric.resetsAt > now &&
						metric.resetsAt < now + etaHours * 3600000
				}
			: {})
	};
}
