import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AiUsageMeter, { type UsageReading } from './AiUsage';
import { defaultUsageProviders, usageSourceKey, type UsageMetric } from '../../core/aiUsage';
const AiUsage = (props: Parameters<typeof AiUsageMeter>[0]) => (
	<AiUsageMeter compact={false} remaining={false} showResets showHeader {...props} />
);
afterEach(cleanup);
const p = defaultUsageProviders()[0];
const hour = 3600000;
const now = 10 * hour;
const quota: UsageMetric = {
	id: 'q',
	label: 'Weekly',
	kind: 'quota',
	used: 98,
	limit: 100,
	unit: '%',
	period: 'week',
	scope: 'account',
	resetsAt: now + hour
};
const reading = (
	metrics: UsageMetric[] = [quota],
	extra: Partial<UsageReading> = {}
): Record<string, UsageReading> => ({
	[usageSourceKey(p)]: {
		snapshot: { version: 1, metrics },
		history: [],
		error: '',
		busy: false,
		at: now,
		...extra
	}
});
describe('AI usage meter', () => {
	it('breaks graph lines at top-ups, counter resets and missing intervals', () => {
		for (const balance of [false, true]) {
			const metric: UsageMetric = balance
				? {
						...quota,
						used: undefined,
						remaining: 5,
						kind: 'credits',
						unit: 'USD',
						period: 'balance'
					}
				: quota;
			const values = balance ? [5, 4, 8, 7] : [5, 6, 2, 3];
			const history = values.map((value, i) => ({
				at: now - (3 - i) * 300000,
				metrics: [balance ? { ...metric, remaining: value } : { ...metric, used: value }]
			}));
			const view = render(
				<AiUsage
					providers={[{ ...p, graph: true }]}
					readings={reading([metric], { history })}
					now={now}
					graphMetric={metric.kind}
				/>
			);
			const path = view.container.querySelector('path')!.getAttribute('d')!;
			expect(path.match(/M/g)).toHaveLength(2);
			expect(path.match(/L/g)).toHaveLength(2);
			view.unmount();
		}
	});
	it('shows burn without an invented ETA when a token allowance is unknown', () => {
		const tokens: UsageMetric = {
			id: 'tokens',
			label: 'Tokens',
			kind: 'tokens',
			used: 100,
			unit: 'tokens',
			period: 'lifetime',
			scope: 'account'
		};
		const allowance: UsageMetric = {
			id: 'left',
			label: 'Allowance',
			kind: 'tokens',
			remaining: 25,
			unit: 'tokens',
			period: 'allowance',
			scope: 'account'
		};
		render(
			<AiUsage
				providers={[p]}
				readings={reading([tokens, allowance], {
					history: [
						{ at: now - hour, metrics: [{ ...tokens, used: 50 }] },
						{ at: now, metrics: [tokens] }
					]
				})}
				now={now}
				rateHours={6}
			/>
		);
		expect(screen.getByText('50 tokens/h')).toBeVisible();
		expect(screen.getByText('25 tokens')).toBeVisible();
	});
	it('plots remaining balances and skips missing history values', () => {
		const balance: UsageMetric = {
			id: 'b',
			label: 'Balance',
			kind: 'credits',
			remaining: 10,
			unit: 'USD',
			period: 'balance',
			scope: 'account'
		};
		const tokens: UsageMetric = {
			id: 't',
			label: 'Tokens',
			kind: 'tokens',
			used: 10,
			unit: 'tokens',
			period: 'today',
			scope: 'local'
		};
		const history = [
			{ at: now - 100 * hour, metrics: [] },
			{
				at: now - hour,
				metrics: [
					{ ...balance, remaining: 20 },
					{ ...tokens, used: 5 }
				]
			},
			{ at: now - hour / 2, metrics: [] },
			{ at: now, metrics: [balance, tokens] }
		];
		const view = render(
			<AiUsage
				providers={[{ ...p, graph: true, compact: 'detailed' }]}
				readings={reading([balance, tokens], { history })}
				now={now}
				graphMetric="credits"
				rateHours={6}
			/>
		);
		expect(screen.getAllByText('Rate: collecting history')).toHaveLength(2);
		expect(screen.getByRole('img')).toBeVisible();
		view.rerender(
			<AiUsage
				providers={[p]}
				readings={reading([{ ...quota, used: 10, resetsAt: now + 48 * hour }], {
					at: now - 3600000
				})}
				now={now}
			/>
		);
		expect(screen.getByText('Stale')).toBeVisible();
		expect(screen.getByText('2d')).toBeVisible();
		view.rerender(
			<AiUsage providers={[p]} readings={reading([quota])} now={now} resetDisplay="date" />
		);
		expect(screen.getByRole('meter')).toBeVisible();
	});
	it('shows real quota and zero banked resets, with stale errors retaining the reading', () => {
		const view = render(
			<AiUsage
				providers={[p]}
				readings={reading([quota], {
					snapshot: {
						version: 1,
						metrics: [quota],
						bankedResets: { available: 0, expiresAt: now + hour },
						note: 'Source note'
					},
					error: 'Offline'
				})}
				now={now}
				compact={false}
			/>
		);
		expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '98');
		expect(screen.getByText('0')).toBeVisible();
		expect(screen.getByText('Stale')).toBeVisible();
		expect(screen.getByText('Offline')).toBeVisible();
		expect(screen.getByText('Source note')).toBeVisible();
		view.rerender(
			<AiUsage providers={[{ ...p, session: false, week: false }]} readings={reading()} now={now} />
		);
		expect(screen.getByText('No selected usage readings available.')).toBeVisible();
	});
	it('distinguishes waiting, refreshing, disabled providers and unknown allowances', () => {
		const view = render(<AiUsage providers={[p]} readings={{}} now={now} />);
		expect(screen.getByText('Waiting')).toBeVisible();
		view.rerender(<AiUsage providers={[p]} readings={reading([], { busy: true })} now={now} />);
		expect(screen.getByText('Refreshing…')).toBeVisible();
		const tokens: UsageMetric = {
			id: 't',
			label: 'Tokens',
			kind: 'tokens',
			used: 1200,
			unit: 'tokens',
			period: 'today',
			scope: 'local'
		};
		view.rerender(
			<AiUsage
				providers={[{ ...p, compact: 'detailed', graph: true }]}
				readings={reading([tokens])}
				now={now}
				remaining
			/>
		);
		expect(screen.getByText('1.2K tokens')).toBeVisible();
		expect(screen.getByText('Collecting graph history')).toBeVisible();
		view.rerender(<AiUsage providers={[{ ...p, enabled: false }]} readings={{}} now={now} />);
		expect(screen.getByText('Add or enable a provider in Studio.')).toBeVisible();
	});
	it('renders dates, due resets, remaining amounts, currency and cumulative graphs', () => {
		const credits: UsageMetric = {
			id: 'c',
			label: 'Balance',
			kind: 'credits',
			remaining: 24.8,
			unit: 'USD',
			period: 'balance',
			scope: 'account'
		};
		const history = [
			{ at: now - hour, metrics: [{ ...quota, used: 90 }, credits] },
			{ at: now, metrics: [quota, credits] }
		];
		const view = render(
			<AiUsage
				providers={[{ ...p, graph: true, compact: 'detailed' }]}
				readings={reading([quota, credits], { history })}
				now={now}
				remaining
				graphMetric="quota"
				resetDisplay="both"
			/>
		);
		expect(screen.getByText('2% left')).toBeVisible();
		expect(screen.getByText('$24.80')).toBeVisible();
		expect(screen.getByRole('img')).toBeVisible();
		view.rerender(
			<AiUsage
				providers={[{ ...p, graph: true }]}
				readings={reading([{ ...quota, resetsAt: now }])}
				now={now}
				graphMetric="credits"
				resetDisplay="date"
			/>
		);
		expect(screen.getByText('due')).toBeVisible();
		expect(screen.getByText('No credits readings available')).toBeVisible();
		view.rerender(
			<AiUsage
				providers={[p]}
				readings={reading([{ ...quota, used: 85, resetsAt: now + 48 * hour }])}
				now={now}
				resetDisplay="date"
			/>
		);
		expect(screen.getByRole('meter')).toHaveClass('warning');
	});
	it('shows measured burn, idle state and reset-first projections', () => {
		const earlier = { ...quota, used: 97 };
		const history = [
			{ at: now - hour, metrics: [earlier] },
			{ at: now, metrics: [quota] }
		];
		const view = render(
			<AiUsage providers={[p]} readings={reading([quota], { history })} now={now} rateHours={6} />
		);
		expect(screen.getByText(/reset expected first/)).toBeVisible();
		view.rerender(
			<AiUsage
				providers={[p]}
				readings={reading([quota], {
					history: [
						{ at: now - hour, metrics: [quota] },
						{ at: now, metrics: [quota] }
					]
				})}
				now={now}
				rateHours={6}
			/>
		);
		expect(screen.getByText('Rate: idle')).toBeVisible();
		view.rerender(
			<AiUsage
				providers={[p]}
				readings={reading([{ ...quota, resetsAt: now + 20 * hour }], {
					history: [
						{ at: now - hour, metrics: [{ ...earlier, resetsAt: now + 20 * hour }] },
						{ at: now, metrics: [{ ...quota, resetsAt: now + 20 * hour }] }
					]
				})}
				now={now}
				rateHours={6}
			/>
		);
		expect(screen.getByText(/~2h/)).toBeVisible();
	});
});
