import { describe, it, expect, beforeEach } from 'vitest';
import { recordWidgetRender, widgetCosts, resetWidgetProfile } from './widgetProfile';

const render = (id: string, ms: number, at: number) =>
	recordWidgetRender(id, 'update', ms, ms, at, at);

beforeEach(() => resetWidgetProfile());

describe('widgetCosts', () => {
	it('aggregates commits, derives renders/sec + avg ms, busiest first', () => {
		// clock: 3 commits over 2s → 2 intervals / 2s = 1.0/s; avg 0.5ms.
		render('clock-aa', 0.4, 1000);
		render('clock-aa', 0.6, 2000);
		render('clock-aa', 0.5, 3000);
		// gauge: 5 commits over 2s → 4/2 = 2.0/s (busier).
		render('gauge-bb', 1, 1000);
		render('gauge-bb', 1, 1500);
		render('gauge-bb', 1, 2000);
		render('gauge-bb', 1, 2500);
		render('gauge-bb', 1, 3000);

		const costs = widgetCosts();
		expect(costs.map((c) => c.id)).toEqual(['gauge-bb', 'clock-aa']); // busiest first
		const clock = costs.find((c) => c.id === 'clock-aa');
		expect(clock?.type).toBe('clock');
		expect(clock?.commits).toBe(3);
		expect(clock?.perSec).toBeCloseTo(1.0, 5);
		expect(clock?.avgMs).toBeCloseTo(0.5, 5);
		expect(costs.find((c) => c.id === 'gauge-bb')?.perSec).toBeCloseTo(2.0, 5);
	});

	it('reports 0/s for a single commit (no interval yet)', () => {
		render('text-cc', 0.2, 5000);
		expect(widgetCosts()[0]).toMatchObject({ id: 'text-cc', commits: 1, perSec: 0 });
	});

	it('falls back to the full id as the type when the prefix is empty (id starts with "-")', () => {
		render('-orphan', 1, 1000);
		expect(widgetCosts()[0]).toMatchObject({ id: '-orphan', type: '-orphan' });
	});

	it('reports 0/s for repeat commits with no elapsed span and tie-breaks by avg ms', () => {
		// Both widgets read 0/s (same-timestamp commits → zero span; single commit → no interval), so
		// the sort falls through to the slowest-average tie-break.
		render('slow-x', 5, 1000);
		render('slow-x', 5, 1000); // 2 commits, zero span → still 0/s
		render('fast-y', 1, 1000);
		const costs = widgetCosts();
		expect(costs.map((c) => c.id)).toEqual(['slow-x', 'fast-y']); // avg 5ms before avg 1ms
		expect(costs[0].perSec).toBe(0);
	});
});
