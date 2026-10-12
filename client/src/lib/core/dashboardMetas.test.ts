import { describe, expect, it } from 'vitest';
import { dashboardMetas } from './dashboardMetas';
import { configCompleteness, fieldsMissingHelp } from './widget';
describe('dashboard metadata', () => {
	it('exposes every default through documented inspector controls', () => {
		expect(fieldsMissingHelp(dashboardMetas)).toEqual([]);
		for (const meta of dashboardMetas) expect(configCompleteness(meta)).toEqual([]);
	});
	it('derives only configured subscriptions and bounds the comparison chart', () => {
		const alerts = dashboardMetas.find((m) => m.type === 'alerts')!;
		expect(alerts.sensors!({})).toEqual({ 'agenda.list': 'agenda.list' });
		expect(alerts.sensors!({ rules: 'cpu|above|90|Busy', meetingMinutes: 0 })).toEqual({
			cpu: 'cpu'
		});
		const history = dashboardMetas.find((m) => m.type === 'history')!;
		expect(history.sensors!({})).toEqual({});
		expect(history.sensors!({ sensorIds: ' cpu , gpu, ,' })).toEqual({ cpu: 'cpu', gpu: 'gpu' });
		expect(Object.keys(history.sensors!({ sensorIds: '1,2,3,4,5,6,7,8,9' }))).toHaveLength(8);
	});
});
