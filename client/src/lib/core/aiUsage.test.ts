import { describe, expect, it } from 'vitest';
import {
	defaultUsageProviders,
	usageProviders,
	parseUsage,
	appendUsageHistory,
	usageTrend,
	visibleUsageMetrics,
	usageSourceKey,
	usagePollingSpec
} from './aiUsage';

const quota = (used: number, resetsAt = 10000000) => ({
	id: 'week',
	label: 'Weekly',
	kind: 'quota' as const,
	used,
	limit: 100,
	unit: '%',
	period: 'week',
	scope: 'account',
	resetsAt
});
describe('AI usage contracts', () => {
	it('rejects malformed metric identities and banked reset metadata', () => {
		const base = quota(1);
		for (const metric of [
			null,
			[],
			{ ...base, id: '' },
			{ ...base, label: 1 },
			{ ...base, kind: 'bad' },
			{ ...base, unit: null },
			{ ...base, period: 0 },
			{ ...base, scope: false },
			{ ...base, used: undefined, remaining: undefined }
		])
			expect(() => parseUsage({ version: 1, metrics: [metric] })).toThrow();
		expect(() => parseUsage({ version: 1, metrics: [base, base] })).toThrow();
		for (const bankedResets of [
			{ available: -1 },
			{ available: 1.5 },
			{ available: 1, expiresAt: -1 }
		])
			expect(() => parseUsage({ version: 1, metrics: [], bankedResets })).toThrow();
		expect(
			parseUsage({
				version: 1,
				metrics: [
					{ ...base, used: undefined, remaining: 5, limit: undefined, resetsAt: undefined }
				],
				bankedResets: { available: 2, expiresAt: 12 },
				note: 'Local'
			})
		).toMatchObject({
			note: 'Local',
			metrics: [{ remaining: 5 }],
			bankedResets: { expiresAt: 12 }
		});
		const providers = usageProviders([
			{
				source: 'omp',
				compact: 'compact',
				env: 'KEY',
				account: 'a',
				enabled: false,
				icon: 'deepseek'
			},
			{ source: 'command', compact: 'detailed', graph: true, credits: false }
		]);
		expect(providers[0]).toMatchObject({ id: 'omp-0', label: 'omp', enabled: false });
		expect(providers[0].icon).toBe('deepseek');
		expect(providers[1].compact).toBe('detailed');
		expect(visibleUsageMetrics([{ ...base, kind: 'credits' }], providers[1])).toEqual([]);
	});
	it('does not bridge missing readings, counter resets, top-ups or long gaps', () => {
		const m = { ...quota(40), resetsAt: undefined };
		for (const other of [
			undefined,
			{ ...m, used: undefined },
			{ ...m, scope: 'other' },
			{ ...m, unit: 'requests' },
			{ ...m, kind: 'tokens' as const },
			{ ...m, period: 'session' }
		]) {
			expect(
				usageTrend(
					[
						{ at: 0, metrics: [m] },
						{ at: 300000, metrics: other ? [other] : [] },
						{ at: 600000, metrics: [m] }
					],
					m,
					600000,
					6
				).state
			).toBe('collecting');
		}
		expect(
			usageTrend(
				[
					{ at: 0, metrics: [m] },
					{ at: 9000000, metrics: [m] }
				],
				m,
				9000000,
				6
			).state
		).toBe('collecting');
		const credits = { ...m, used: undefined, remaining: 10 };
		expect(
			usageTrend(
				[
					{ at: 0, metrics: [credits] },
					{ at: 300000, metrics: [{ ...credits, remaining: 20 }] }
				],
				credits,
				300000,
				6
			).state
		).toBe('collecting');
		const tokens = { ...m, kind: 'tokens' as const, limit: undefined };
		expect(
			usageTrend(
				[
					{ at: 0, metrics: [{ ...tokens, used: 20 }] },
					{ at: 3600000, metrics: [tokens] }
				],
				tokens,
				3600000,
				6
			)
		).toEqual({ state: 'active', rate: 20 });
		expect(usageTrend([{ at: 4000000, metrics: [m] }], m, 3600000, 6).state).toBe('collecting');
		expect(
			appendUsageHistory([{ at: 4000, metrics: [] }], { at: 1000, metrics: [] }, 1000)
		).toHaveLength(1);
	});
	it('defaults to Codex and Claude, while preserving independent provider settings', () => {
		expect(defaultUsageProviders().map((p) => p.source)).toEqual(['codex', 'claude']);
		expect(usageProviders(null)).toEqual(defaultUsageProviders());
		expect(usageProviders([])).toEqual([]);
		const p = usageProviders([
			{ id: 'x', source: 'command', label: 'Mine', command: 'usage', session: false }
		])[0];
		expect(p).toMatchObject({ label: 'Mine', session: false, week: true, enabled: true });
		expect(usageProviders([null, { source: 'invalid' }])).toEqual([]);
		expect(usageSourceKey(p)).not.toBe(usageSourceKey({ ...p, command: 'other' }));
		expect(usageSourceKey(p)).toBe(usageSourceKey({ ...p, label: 'renamed' }));
	});
	it('validates finite, nonnegative readings and preserves unknowns', () => {
		expect(
			parseUsage({ version: 1, metrics: [quota(0)], bankedResets: { available: 0 } })
		).toMatchObject({ metrics: [{ used: 0 }], bankedResets: { available: 0 } });
		for (const input of [
			null,
			{},
			{ version: 2 },
			{ version: 1, metrics: [{}] },
			{ version: 1, metrics: [quota(NaN)] },
			{ version: 1, metrics: [{ ...quota(2), remaining: -1 }] }
		])
			expect(() => parseUsage(input)).toThrow();
		expect(parseUsage({ version: 1, metrics: [] }).bankedResets).toBeUndefined();
	});
	it('filters windows without inventing unavailable readings', () => {
		const p = defaultUsageProviders()[0];
		const metrics = [
			quota(20),
			{ ...quota(3), id: 's', period: 'session' },
			{ ...quota(4), id: 'o', period: 'month' },
			{ ...quota(5), id: 't', kind: 'tokens' as const }
		];
		expect(visibleUsageMetrics(metrics, p)).toHaveLength(4);
		expect(
			visibleUsageMetrics(metrics, {
				...p,
				session: false,
				week: false,
				other: false,
				tokens: false
			})
		).toEqual([]);
	});
	it('bounds and merges history without replacing newer samples', () => {
		expect(
			appendUsageHistory([{ at: 0, metrics: [] }], { at: 300000, metrics: [] }, 300000)
		).toHaveLength(2);
		let h = appendUsageHistory([], { at: 1000, metrics: [quota(1)] }, 1000);
		h = appendUsageHistory(h, { at: 2000, metrics: [quota(2)] }, 2000);
		expect(h).toHaveLength(1);
		expect(h[0].metrics[0].used).toBe(2);
		expect(appendUsageHistory(h, { at: 1500, metrics: [quota(9)] }, 2000)).toEqual(h);
		expect(appendUsageHistory(h, { at: 40 * 86400000, metrics: [] }, 40 * 86400000)).toHaveLength(
			1
		);
	});
	it('estimates quota exhaustion, credit runway and token depletion with reset boundaries', () => {
		const h = [
			{ at: 0, metrics: [quota(20)] },
			{ at: 3600000, metrics: [quota(40)] }
		];
		expect(usageTrend(h, quota(40), 3600000, 6)).toMatchObject({
			rate: 20,
			etaHours: 3,
			resetFirst: true
		});
		const credit = {
			...quota(0),
			kind: 'credits' as const,
			used: undefined,
			remaining: 10,
			resetsAt: undefined
		};
		expect(
			usageTrend(
				[
					{ at: 0, metrics: [{ ...credit, remaining: 20 }] },
					{ at: 3600000, metrics: [credit] }
				],
				credit,
				3600000,
				6
			)
		).toMatchObject({ rate: 10, etaHours: 1 });
		expect(
			usageTrend(
				[
					{ at: 0, metrics: [quota(50)] },
					{ at: 3600000, metrics: [quota(20, 20000000)] }
				],
				quota(20, 20000000),
				3600000,
				6
			).state
		).toBe('collecting');
		expect(usageTrend(h, quota(40), 99999999, 1).state).toBe('collecting');
		expect(
			usageTrend(
				[
					{ at: 0, metrics: [quota(40)] },
					{ at: 3600000, metrics: [quota(40)] }
				],
				quota(40),
				3600000,
				6
			).state
		).toBe('idle');
		expect(
			usageTrend(
				[
					{ at: 0, metrics: [quota(50)] },
					{ at: 3600000, metrics: [quota(40)] }
				],
				quota(40),
				3600000,
				6
			).state
		).toBe('collecting');
	});
});
it('normalizes saved reading order and sorts selected metrics without changing history identity', () => {
	const original = defaultUsageProviders()[0];
	const p = usageProviders([
		{ ...original, order: ['tokens', 'week', 'tokens', 'unknown', null] }
	])[0];
	expect(p.order).toEqual([
		'tokens',
		'week',
		'session',
		'other',
		'credits',
		'banked',
		'graph',
		'eta',
		'resets'
	]);
	const week = quota(1);
	const session = { ...week, id: 'session', period: 'session' };
	const token = { ...week, id: 'tokens', kind: 'tokens' as const, unit: 'tokens' };
	const other = { ...week, id: 'month', period: 'month' };
	const credits = { ...week, id: 'credits', kind: 'credits' as const, unit: 'USD' };
	const metrics = [session, week, other, credits, token];
	expect(visibleUsageMetrics(metrics, p).map((m) => m.id)).toEqual([
		'tokens',
		'week',
		'session',
		'month',
		'credits'
	]);
	expect(metrics[0]).toBe(session);
	expect(usageSourceKey(p)).toBe(usageSourceKey(original));
});
it('normalizes label overrides without changing the source or history identity', () => {
	const p = usageProviders([
		{
			source: 'codex',
			labels: { week: ' Weekly ', tokens: '', session: 4, graph: 'Trend', bogus: 'No' }
		}
	])[0];
	expect(p.labels).toEqual({ week: ' Weekly ', graph: 'Trend' });
	expect(usageSourceKey(p)).toBe(usageSourceKey(defaultUsageProviders()[0]));
});

it('polling identity ignores display changes, duplicates and provider order', () => {
	const providers = defaultUsageProviders();
	const original = usagePollingSpec(providers);
	expect(
		usagePollingSpec(
			[...providers]
				.reverse()
				.map((p) => ({ ...p, label: 'Renamed', week: false, order: [...p.order].reverse() }))
		)
	).toBe(original);
	expect(usagePollingSpec([...providers, providers[0]])).toBe(original);
	expect(
		JSON.parse(usagePollingSpec([{ ...providers[0], enabled: false }, providers[1]]))
	).toHaveLength(1);
});

it('keeps Claude observations in the same quota window despite reset timestamp jitter', () => {
	const reset = 7 * 86400000;
	const history = [0, 4, 770].map((jitter, i) => ({
		at: i * 900000,
		metrics: [quota(4, reset + jitter)]
	}));
	expect(usageTrend(history, quota(4, reset + 770), 1800000, 1)).toEqual({ state: 'idle' });
	const rising = history.map((point, i) => ({
		...point,
		metrics: [{ ...point.metrics[0], used: 2 + i }]
	}));
	expect(usageTrend(rising, quota(4, reset + 770), 1800000, 1)).toMatchObject({
		state: 'active',
		rate: 4,
		etaHours: 24
	});
});
it('still separates actual quota resets and missing reset identities', () => {
	const latest = quota(4);
	for (const [before, after] of [
		[latest.resetsAt - 60001, latest.resetsAt],
		[undefined, latest.resetsAt],
		[latest.resetsAt, undefined]
	]) {
		const metric = { ...latest, resetsAt: after };
		expect(
			usageTrend(
				[
					{ at: 0, metrics: [{ ...latest, used: 2, resetsAt: before }] },
					{ at: 900000, metrics: [metric] }
				],
				metric,
				900000,
				1
			).state
		).toBe('collecting');
	}
});
