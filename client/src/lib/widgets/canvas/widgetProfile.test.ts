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
});
