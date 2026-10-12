import { describe, expect, it } from 'vitest';
import {
	alertRules,
	activeAlerts,
	historySummary,
	historyScale,
	historyWindow,
	decodeTasks,
	meetingAlerts,
	boundedNumber
} from './dashboard';

describe('dashboard contracts', () => {
	it('bounds numeric settings and restores defaults for malformed imports', () => {
		expect(boundedNumber(null, 10, 0, 120)).toBe(10);
		expect(boundedNumber('bad', 10, 0, 120)).toBe(10);
		expect(boundedNumber(NaN, 10, 0, 120)).toBe(10);
		expect(boundedNumber(0, 10, 0, 120)).toBe(0);
		expect(boundedNumber(200, 10, 0, 120)).toBe(120);
	});
	it('reminds only for imminent timed meetings, using stable event IDs for snoozes', () => {
		const now = Date.parse('2026-10-12T10:00:00Z');
		const state = {
			history: [],
			value: {
				kind: 'json' as const,
				value: [
					{ summary: 'Standup', start: '2026-10-12T10:05:00Z' },
					{ summary: 'Past', start: '2026-10-12T09:59:00Z' },
					{ summary: 'Later', start: '2026-10-12T11:00:00Z' },
					{ summary: 'All day', start: '2026-10-12T10:05:00Z', allDay: true },
					{ summary: 'Broken', start: 'invalid' }
				]
			}
		};
		expect(meetingAlerts(state, now, 10)).toEqual([
			expect.objectContaining({
				label: 'Standup in 5 minutes',
				id: 'meeting:2026-10-12T10:05:00Z:Standup'
			})
		]);
		expect(meetingAlerts(state, now, 0)).toEqual([]);
		expect(meetingAlerts(undefined, now, 10)).toEqual([]);
		expect(meetingAlerts({ history: [], value: { kind: 'scalar', value: 5 } }, now, 10)).toEqual(
			[]
		);
	});
	it('parses threshold rules and subscribes only to their sensors', () => {
		expect(alertRules('cpu.total|above|90|CPU busy\nnet.ping.nas.up|below|1|NAS offline')).toEqual([
			{
				id: 'rule:0:cpu.total|above|90|CPU busy',
				sensor: 'cpu.total',
				op: 'above',
				threshold: 90,
				label: 'CPU busy'
			},
			{
				id: 'rule:1:net.ping.nas.up|below|1|NAS offline',
				sensor: 'net.ping.nas.up',
				op: 'below',
				threshold: 1,
				label: 'NAS offline'
			}
		]);
		expect(alertRules('bad\na|other|3|bad\na|above|NaN|bad')).toEqual([]);
	});
	it('ignores missing values, handles boundaries, and expires snoozes', () => {
		const rules = alertRules('cpu|above|90|Busy\nnet|below|1|Offline');
		const sensors = { cpu: { value: { kind: 'scalar' as const, value: 90 }, history: [] } };
		expect(activeAlerts(rules, sensors, {}, 100)).toHaveLength(1);
		expect(activeAlerts(rules, sensors, { [rules[0].id]: 101 }, 100)).toEqual([]);
		expect(activeAlerts(rules, sensors, { [rules[0].id]: 100 }, 100)).toHaveLength(1);
		expect(
			activeAlerts(rules, { net: { value: { kind: 'scalar', value: 0 }, history: [] } }, {}, 0)[0]
				.label
		).toBe('Offline');
	});
	it('summarizes finite samples and gives multiple lines a shared fixed scale', () => {
		expect(historySummary([1, 3, NaN, Infinity])).toEqual({ min: 1, average: 2, max: 3 });
		expect(historySummary([])).toBeNull();
		expect(
			historyScale(
				[
					[10, 20],
					[80, 90]
				],
				null,
				null
			)
		).toEqual([10, 90]);
		expect(historyScale([], null, null)).toEqual([0, 1]);
		expect(historyScale([[20]], 0, 100)).toEqual([0, 100]);
		expect(historyScale([[20]], 20, 20)).toEqual([20, 21]);
		expect(historyScale([[20]], NaN, Infinity)).toEqual([20, 21]);
		expect(historyWindow(NaN)).toBe(60);
		expect(historyWindow(0)).toBe(1);
		expect(historyWindow(10000)).toBe(600);
		expect(historyWindow(30)).toBe(30);
	});
	it('recovers malformed persisted checklists without trusting arbitrary objects', () => {
		expect(decodeTasks(null)).toEqual([]);
		expect(decodeTasks('bad')).toEqual([]);
		expect(decodeTasks('{}')).toEqual([]);
		expect(decodeTasks('[null,{}, {"id":"1","text":"Read","done":true}]')).toEqual([
			{ id: '1', text: 'Read', done: true }
		]);
	});
	it('drops duplicate and empty task identities and copies only checklist fields', () => {
		expect(
			decodeTasks(
				JSON.stringify([
					{ id: 'one', text: 'Keep', done: false, unexpected: 123 },
					{ id: 'one', text: 'Duplicate', done: true },
					{ id: '', text: 'No ID', done: false },
					{ id: 'blank', text: '  ', done: false }
				])
			)
		).toEqual([{ id: 'one', text: 'Keep', done: false }]);
	});
	it('rejects mistyped task fields instead of coercing saved data', () => {
		for (const task of [
			true,
			{ id: 2, text: 'Task', done: false },
			{ id: 'one', text: 2, done: false },
			{ id: 'one', text: 'Task', done: 'false' }
		])
			expect(decodeTasks(JSON.stringify([task]))).toEqual([]);
	});
});
