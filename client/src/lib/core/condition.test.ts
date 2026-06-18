import { describe, it, expect } from 'vitest';
import {
	comparableOf,
	conditionMet,
	conditionRefs,
	parseCondition,
	WINDOWS_SENSOR,
	type Condition,
	type ConditionContext
} from './condition';
import type { SensorValue } from './telemetry';
import type { WindowDescriptor } from './windowMatch';

const win = (exe: string, className = 'C', title = 'T'): WindowDescriptor => ({
	hwnd: 1,
	exe,
	className,
	title,
	rect: { x: 0, y: 0, w: 1, h: 1 }
});

const ctx = (
	windows: WindowDescriptor[],
	sensors: Record<string, SensorValue> = {}
): ConditionContext => ({
	windows,
	sensorValue: (id) => sensors[id] ?? null
});

describe('parseCondition', () => {
	it('parses an appOpen with at least one match field, dropping unknowns', () => {
		expect(parseCondition({ kind: 'appOpen', matchExe: 'spotify.exe', junk: 1 })).toEqual({
			kind: 'appOpen',
			matchExe: 'spotify.exe'
		});
	});
	it('drops a fieldless / empty appOpen', () => {
		expect(parseCondition({ kind: 'appOpen' })).toBeUndefined();
		expect(parseCondition({ kind: 'appOpen', matchExe: '  ' })).toBeUndefined();
	});
	it('parses a sensor condition; requires id + valid op', () => {
		expect(parseCondition({ kind: 'sensor', sensorId: 'cpu.total', op: '>', value: '80' })).toEqual(
			{
				kind: 'sensor',
				sensorId: 'cpu.total',
				op: '>',
				value: '80'
			}
		);
		expect(
			parseCondition({ kind: 'sensor', sensorId: 'cpu.total', op: '≈', value: '1' })
		).toBeUndefined();
		expect(parseCondition({ kind: 'sensor', op: '>', value: '1' })).toBeUndefined();
	});
	it('keeps negate and coerces a numeric value to string', () => {
		expect(
			parseCondition({ kind: 'sensor', sensorId: 's', op: '==', value: 5, negate: true })
		).toEqual({ kind: 'sensor', sensorId: 's', op: '==', value: '5', negate: true });
	});
	it('returns undefined for non-objects / unknown kinds', () => {
		expect(parseCondition(null)).toBeUndefined();
		expect(parseCondition({ kind: 'nope' })).toBeUndefined();
		expect(parseCondition('x')).toBeUndefined();
	});
});

describe('conditionRefs', () => {
	it('appOpen depends on the windows sensor; sensor on its id', () => {
		expect(conditionRefs({ kind: 'appOpen', matchExe: 'a.exe' })).toEqual([WINDOWS_SENSOR]);
		expect(conditionRefs({ kind: 'sensor', sensorId: 'cpu.total', op: '>', value: '1' })).toEqual([
			'cpu.total'
		]);
	});
});

describe('comparableOf', () => {
	it('reads scalar/text/series and HA-json .state', () => {
		expect(comparableOf({ kind: 'scalar', value: 42 })).toBe(42);
		expect(comparableOf({ kind: 'text', value: 'hi' })).toBe('hi');
		expect(comparableOf({ kind: 'series', value: [1, 2, 3] })).toBe(3);
		expect(comparableOf({ kind: 'json', value: { state: 'on' } })).toBe('on');
		expect(comparableOf({ kind: 'json', value: { nope: 1 } })).toBeNull();
		expect(comparableOf(null)).toBeNull();
	});
});

describe('conditionMet — appOpen', () => {
	const open: Condition = { kind: 'appOpen', matchExe: 'spotify.exe' };
	it('true when a matching window is open, false otherwise', () => {
		expect(conditionMet(open, ctx([win('x/Spotify.exe')]))).toBe(true);
		expect(conditionMet(open, ctx([win('x/Code.exe')]))).toBe(false);
		expect(conditionMet(open, ctx([]))).toBe(false);
	});
	it('negate flips it (hide when open)', () => {
		const hide: Condition = { kind: 'appOpen', matchExe: 'spotify.exe', negate: true };
		expect(conditionMet(hide, ctx([win('x/Spotify.exe')]))).toBe(false);
		expect(conditionMet(hide, ctx([]))).toBe(true);
	});
});

describe('conditionMet — sensor', () => {
	const s = (v: number): Record<string, SensorValue> => ({
		'cpu.total': { kind: 'scalar', value: v }
	});
	it('numeric comparisons', () => {
		const c: Condition = { kind: 'sensor', sensorId: 'cpu.total', op: '>', value: '80' };
		expect(conditionMet(c, ctx([], s(90)))).toBe(true);
		expect(conditionMet(c, ctx([], s(50)))).toBe(false);
	});
	it('>=, <, <= numeric operators', () => {
		const ge: Condition = { kind: 'sensor', sensorId: 'cpu.total', op: '>=', value: '80' };
		expect(conditionMet(ge, ctx([], s(80)))).toBe(true);
		expect(conditionMet(ge, ctx([], s(79)))).toBe(false);
		const lt: Condition = { kind: 'sensor', sensorId: 'cpu.total', op: '<', value: '80' };
		expect(conditionMet(lt, ctx([], s(79)))).toBe(true);
		expect(conditionMet(lt, ctx([], s(80)))).toBe(false);
		const le: Condition = { kind: 'sensor', sensorId: 'cpu.total', op: '<=', value: '80' };
		expect(conditionMet(le, ctx([], s(80)))).toBe(true);
		expect(conditionMet(le, ctx([], s(81)))).toBe(false);
	});
	it('missing sensor → not satisfied', () => {
		const c: Condition = { kind: 'sensor', sensorId: 'cpu.total', op: '>', value: '80' };
		expect(conditionMet(c, ctx([], {}))).toBe(false);
	});
	it('string equality for text / HA state', () => {
		const c: Condition = { kind: 'sensor', sensorId: 'light', op: '==', value: 'on' };
		expect(conditionMet(c, ctx([], { light: { kind: 'json', value: { state: 'on' } } }))).toBe(
			true
		);
		expect(conditionMet(c, ctx([], { light: { kind: 'text', value: 'off' } }))).toBe(false);
	});
	it('negate flips, and != is the inverse of ==', () => {
		const ne: Condition = { kind: 'sensor', sensorId: 'cpu.total', op: '!=', value: '0' };
		expect(conditionMet(ne, ctx([], s(5)))).toBe(true);
		const neg: Condition = {
			kind: 'sensor',
			sensorId: 'cpu.total',
			op: '>',
			value: '80',
			negate: true
		};
		expect(conditionMet(neg, ctx([], s(90)))).toBe(false);
	});
});
