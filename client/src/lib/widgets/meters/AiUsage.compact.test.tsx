import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import AiUsage from './AiUsage';
import { defaultUsageProviders, usageSourceKey, type UsageMetric } from '../../core/aiUsage';
afterEach(cleanup);

it('keeps quota sparklines on the percentage scale instead of stretching low usage to full height', () => {
	const provider = { ...defaultUsageProviders()[0], graph: true };
	const metric: UsageMetric = {
		id: 'week',
		label: 'Week',
		kind: 'quota',
		unit: '%',
		used: 5,
		limit: 100,
		period: 'week',
		scope: 'account'
	};
	const view = render(
		<AiUsage
			providers={[provider]}
			graphMetric="quota"
			readings={{
				[usageSourceKey(provider)]: {
					snapshot: { version: 1, metrics: [metric] },
					history: [
						{ at: 0, metrics: [metric] },
						{ at: 300000, metrics: [metric] }
					],
					at: 300000,
					error: '',
					busy: false
				}
			}}
			now={300000}
		/>
	);
	expect(view.container.querySelector('path')!.getAttribute('d')).toMatch(/,41(?:\s|$)/);
});
it('fits both default providers into two single-line rows without a heading', () => {
	const providers = defaultUsageProviders();
	const readings = Object.fromEntries(
		providers.map((p) => [
			usageSourceKey(p),
			{
				snapshot: {
					version: 1 as const,
					metrics: [
						{
							id: 'week',
							label: 'Weekly',
							kind: 'quota' as const,
							unit: '%',
							used: 98,
							limit: 100,
							period: 'week',
							scope: 'account'
						}
					],
					bankedResets: { available: 0 }
				},
				history: [],
				error: '',
				busy: false,
				at: 1000
			}
		])
	);
	const view = render(
		<AiUsage providers={providers} readings={readings} now={1000} remaining={false} />
	);
	expect(view.container.querySelectorAll('.usage-compact-row')).toHaveLength(2);
	expect(view.container.querySelectorAll('.usage-metric,.usage-track,.usage-graph')).toHaveLength(
		0
	);
	expect(screen.getAllByText('98%')).toHaveLength(2);
	expect(screen.getAllByText('↺ 0')).toHaveLength(2);
	expect(view.container.querySelector('header')).toBeNull();
	view.rerender(
		<AiUsage providers={providers} readings={readings} now={1000} remaining showHeader />
	);
	expect(screen.getAllByText('2%')).toHaveLength(2);
	expect(screen.queryByText('left')).toBeNull();
	view.rerender(
		<AiUsage
			providers={providers.map((p) => ({
				...p,
				settings: { ...p.settings, week: { showMode: true } }
			}))}
			readings={readings}
			now={1000}
			remaining
			showHeader
		/>
	);
	expect(screen.getAllByText('left')).toHaveLength(2);
	expect(screen.getByText('Left')).toBeVisible();
	view.rerender(
		<AiUsage
			providers={providers.map((p) => ({
				...p,
				settings: { ...p.settings, week: { showMode: true, remaining: false } }
			}))}
			readings={readings}
			now={1000}
		/>
	);
	expect(screen.getAllByText('used')).toHaveLength(2);
});

it('minimal can omit every label or show provider icons, with inline graphs', () => {
	const providers = defaultUsageProviders().map((p) => ({ ...p, graph: true }));
	const metrics: UsageMetric[] = [
		{
			id: 'session',
			label: 'Session',
			kind: 'quota' as const,
			unit: '%',
			used: 10,
			limit: 100,
			period: 'session',
			scope: 'account'
		},
		{
			id: 'other',
			label: 'Tokens',
			kind: 'tokens' as const,
			unit: 'tokens',
			used: 100,
			period: 'today',
			scope: 'local'
		}
	];
	const readings = Object.fromEntries(
		providers.map((p) => [
			usageSourceKey(p),
			{
				snapshot: { version: 1 as const, metrics },
				history: [
					{ at: 0, metrics },
					{ at: 300000, metrics }
				],
				at: 300000,
				error: '',
				busy: false
			}
		])
	);
	const view = render(
		<AiUsage
			layout="minimal"
			compact={false}
			providers={providers}
			readings={readings}
			now={300000}
			graphMetric="quota"
		/>
	);
	expect(screen.queryByText('Codex')).toBeNull();
	expect(screen.queryByText('Used')).toBeNull();
	expect(view.container.querySelectorAll('.usage-inline-graph')).toHaveLength(2);
	expect(view.container.querySelectorAll('.usage-provider-icon')).toHaveLength(0);
	view.rerender(
		<AiUsage
			minimal
			minimalIcons
			providers={providers}
			readings={readings}
			now={300000}
			graphMetric="quota"
		/>
	);
	expect(
		screen
			.getByRole('region', { name: 'Codex usage' })
			.querySelector('[data-provider-icon="codex"]')
	).toBeVisible();
	expect(
		screen
			.getByRole('region', { name: 'Claude usage' })
			.querySelector('[data-provider-icon="claude"]')
	).toBeVisible();
	view.rerender(
		<AiUsage
			minimal
			minimalIcons
			providers={providers.map((p) => ({ ...p, icon: 'none' }))}
			readings={readings}
			now={300000}
		/>
	);
	expect(view.container.querySelectorAll('.usage-provider-icon')).toHaveLength(0);
	view.rerender(
		<AiUsage
			providerIcons={false}
			providers={providers}
			readings={readings}
			now={300000}
			graphMetric="quota"
		/>
	);
	expect(screen.getByText('Codex')).toBeVisible();
	expect(screen.getAllByText('S')).toHaveLength(2);
	expect(screen.getAllByText('Tok')).toHaveLength(2);
});
it('marks old compact readings stale while preserving their last value', () => {
	const provider = defaultUsageProviders()[0];
	const view = render(
		<AiUsage
			providers={[provider]}
			readings={{
				[usageSourceKey(provider)]: {
					at: 0,
					error: '',
					busy: false,
					snapshot: {
						version: 1,
						metrics: [
							{
								id: 'q',
								label: 'Weekly',
								kind: 'quota',
								used: 30,
								unit: '%',
								period: 'week',
								scope: 'account'
							}
						]
					}
				}
			}}
			remaining={false}
			now={2000000}
		/>
	);
	expect(screen.getByText('Stale')).toBeVisible();
	expect(screen.getByText('30%')).toBeVisible();
	expect(view.container.querySelector('section')).toHaveAttribute('title', 'Stale');
});
it('shows optional short reset countdowns and concise token labels', () => {
	const provider = defaultUsageProviders()[0];
	const metrics: UsageMetric[] = [
		{
			id: 's',
			label: 'Session',
			kind: 'quota' as const,
			used: 1,
			limit: 100,
			unit: '%',
			period: 'session',
			scope: 'account',
			resetsAt: 13 * 3600000
		},
		{
			id: 'w',
			label: 'Week',
			kind: 'quota' as const,
			used: 100,
			limit: 100,
			unit: '%',
			period: 'week',
			scope: 'account',
			resetsAt: 5 * 60000
		},
		{
			id: 't',
			label: 'Observed token consumption since tracker started',
			kind: 'tokens' as const,
			used: 1250000,
			unit: 'tokens',
			period: 'lifetime',
			scope: 'local'
		}
	];
	metrics.push({
		...metrics[0],
		id: 'month',
		label: 'Monthly',
		kind: 'quota',
		period: 'month',
		resetsAt: undefined
	});
	const readings = {
		[usageSourceKey(provider)]: {
			at: 0,
			error: '',
			busy: false,
			snapshot: { version: 1 as const, metrics }
		}
	};
	const view = render(<AiUsage providers={[provider]} readings={readings} now={0} />);
	expect(screen.queryByText('13h')).toBeNull();
	expect(screen.getByText('Tok')).toBeVisible();
	expect(screen.getByText('1.25M')).toBeVisible();
	expect(screen.queryByText('Observed token consumption since tracker started')).toBeNull();
	view.rerender(<AiUsage providers={[provider]} readings={readings} now={0} showResets />);
	expect(screen.getByText('13h')).toBeVisible();
	expect(screen.getByText('5m')).toBeVisible();
	view.rerender(
		<AiUsage providers={[provider]} readings={readings} now={13 * 3600000} minimal showResets />
	);
	expect(screen.getAllByText('due')).toHaveLength(2);
});
it('uses label overrides in minimal, compact and detailed layouts', () => {
	const p = {
		...defaultUsageProviders()[0],
		graph: true,
		labels: { week: 'Wk', banked: 'Bank', graph: 'Trend' }
	};
	const readings = {
		[usageSourceKey(p)]: {
			at: 0,
			error: '',
			busy: false,
			snapshot: {
				version: 1 as const,
				metrics: [
					{
						id: 'q',
						label: 'Weekly quota',
						kind: 'quota' as const,
						used: 1,
						unit: '%',
						period: 'week',
						scope: 'account'
					}
				],
				bankedResets: { available: 2 }
			}
		}
	};
	const view = render(<AiUsage providers={[p]} readings={readings} now={0} minimal />);
	expect(screen.getByText('Wk')).toBeVisible();
	expect(screen.getByText('Bank 2')).toBeVisible();
	expect(screen.getByRole('img', { name: 'Codex Trend' })).toBeVisible();
	view.rerender(<AiUsage providers={[p]} readings={readings} now={0} compact={false} />);
	expect(screen.getByText('Wk')).toBeVisible();
	expect(screen.getByText('Bank')).toBeVisible();
	expect(screen.getByText('Trend')).toBeVisible();
});
it('renders independently ordered rate and reset items with row overrides and short ETAs', () => {
	const now = 36000000;
	const metric: UsageMetric = {
		id: 'week',
		label: 'Weekly',
		kind: 'quota',
		used: 10,
		limit: 100,
		unit: '%',
		period: 'week',
		scope: 'account',
		resetsAt: now + 3 * 86400000
	};
	const base = defaultUsageProviders()[0];
	const p = {
		...base,
		resets: true,
		labels: { eta: 'Speed', resets: 'Next' },
		settings: {
			...base.settings,
			week: { remaining: true, warning: 5, critical: 50 },
			eta: { rateHours: 1 },
			graph: { graphMetric: 'quota' as const, graphHours: 48 }
		}
	};
	const readings = {
		[usageSourceKey(p)]: {
			at: now,
			error: '',
			busy: false,
			snapshot: { version: 1 as const, metrics: [metric] },
			history: [
				{ at: now - 3600000, metrics: [{ ...metric, used: 0 }] },
				{ at: now, metrics: [metric] }
			]
		}
	};
	const view = render(<AiUsage providers={[p]} readings={readings} now={now} remaining={false} />);
	expect(screen.getByText('90%')).toBeVisible();
	expect(screen.getByText('10%/h')).toBeVisible();
	expect(screen.getByText('~9h')).toBeVisible();
	expect(screen.getByText('3d')).toBeVisible();
	expect(screen.getByText('Speed')).toBeVisible();
	view.rerender(<AiUsage providers={[p]} readings={readings} now={now} compact={false} />);
	expect(screen.getByRole('meter')).toHaveClass('warning');
	expect(screen.getByText('Next')).toBeVisible();
	for (const resetDisplay of ['date', 'both'] as const) {
		view.rerender(
			<AiUsage
				providers={[{ ...p, settings: { ...p.settings, resets: { resetDisplay } } }]}
				readings={readings}
				now={now}
				compact={false}
			/>
		);
		expect(view.container.querySelector('.usage-resets-row')).toHaveTextContent(
			new Date(metric.resetsAt!).toLocaleString()
		);
	}
});
it('reports filtered successful readings rather than waiting for a provider', () => {
	const p = { ...defaultUsageProviders()[0], week: false };
	render(
		<AiUsage
			providers={[p]}
			now={1000}
			readings={{
				[usageSourceKey(p)]: {
					snapshot: {
						version: 1,
						metrics: [
							{
								id: 'w',
								label: 'Weekly',
								kind: 'quota',
								used: 1,
								limit: 100,
								unit: '%',
								period: 'week',
								scope: 'account'
							}
						]
					},
					at: 1000,
					error: '',
					busy: false
				}
			}}
		/>
	);
	expect(screen.getByText('No selected readings')).toBeVisible();
	expect(screen.queryByText('Waiting')).toBeNull();
});
it('keeps an ETA cell available for active, idle and unbounded compact rates', () => {
	const now = 3600000;
	const base = defaultUsageProviders()[0];
	const quota: UsageMetric = {
		id: 'q',
		label: 'Session',
		kind: 'quota',
		period: 'session',
		scope: 'account',
		unit: '%',
		used: 10,
		limit: 100,
		resetsAt: now + 3600000
	};
	const provider = { ...base, eta: true };
	const reading = (metric: UsageMetric, previous: number) => ({
		[usageSourceKey(provider)]: {
			at: now,
			error: '',
			busy: false,
			snapshot: { version: 1 as const, metrics: [metric] },
			history: [
				{ at: 0, metrics: [{ ...metric, used: previous }] },
				{ at: now, metrics: [metric] }
			]
		}
	});
	const view = render(<AiUsage providers={[provider]} readings={reading(quota, 0)} now={now} />);
	expect(view.container.querySelector('.usage-eta')).toHaveTextContent('↻');
	view.rerender(<AiUsage providers={[provider]} readings={reading(quota, 10)} now={now} />);
	expect(screen.getByText('idle')).toBeVisible();
	const tokens: UsageMetric = {
		...quota,
		kind: 'tokens',
		unit: 'tokens',
		limit: undefined,
		resetsAt: undefined
	};
	view.rerender(<AiUsage providers={[provider]} readings={reading(tokens, 0)} now={now} />);
	expect(view.container.querySelector('.usage-eta')).toHaveTextContent('');
	view.rerender(
		<AiUsage
			providers={[provider]}
			readings={reading({ ...quota, limit: undefined }, 0)}
			now={now}
		/>
	);
	expect(screen.getByText('Unavailable')).toBeVisible();
});

it.each([
	'Provider usage returned HTTP 429; retry paused for 15 minutes',
	'Provider usage returned HTTP 401 Unauthorized',
	'Usage refresh timed out'
])('shows ? for errors with the full message available on hover: %s', (error) => {
	const p = defaultUsageProviders()[0];
	render(
		<AiUsage
			providers={[p]}
			readings={{ [usageSourceKey(p)]: { at: 0, error, busy: false } }}
			now={0}
		/>
	);
	expect(screen.getByRole('status')).toHaveTextContent(/^\?$/);
	expect(screen.getByRole('status')).toHaveAttribute('title', error);
});
