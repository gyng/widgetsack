import { describe, it, expect } from 'vitest';
import { commonConfigFields, commonBasisMode } from './multiSelect';
import type { WidgetInstance } from '../../core/layout';

const w = (type: string, config: Record<string, unknown> = {}): WidgetInstance => ({
	id: type,
	type,
	rect: { x: 0, y: 0, w: 10, h: 10 },
	config
});

describe('commonConfigFields', () => {
	it('returns every field of a single type when all widgets are that type', () => {
		const fields = commonConfigFields([
			w('clock', { format: 'HH:mm' }),
			w('clock', { format: 'HH:mm' })
		]);
		expect(fields.map((f) => f.field.key)).toEqual(['format', 'locale', 'label', 'color']);
		expect(fields.every((f) => !f.mixed)).toBe(true);
	});

	it('flags a field as mixed when the selected widgets disagree', () => {
		const fields = commonConfigFields([
			w('clock', { format: 'HH:mm' }),
			w('clock', { format: 'ss' })
		]);
		const format = fields.find((f) => f.field.key === 'format');
		expect(format?.mixed).toBe(true);
		expect(format?.value).toBeUndefined();
		// a field they agree on is not mixed
		expect(fields.find((f) => f.field.key === 'locale')?.mixed).toBe(false);
	});

	it('intersects fields across DIFFERENT types (clock + gauge share label + color)', () => {
		const fields = commonConfigFields([w('clock'), w('gauge')]);
		expect(fields.map((f) => f.field.key)).toEqual(['label', 'color']);
	});

	it('is empty for an empty selection', () => {
		expect(commonConfigFields([])).toEqual([]);
	});

	it('shares nothing with a widget of an unregistered type (no meta → no fields)', () => {
		expect(commonConfigFields([w('mystery'), w('clock')])).toEqual([]);
	});
});

describe('commonBasisMode', () => {
	it('summarizes a shared mode', () => {
		expect(commonBasisMode([{ fr: 1 }, { fr: 2 }])).toBe('grow');
		expect(commonBasisMode(['content', 'content'])).toBe('content');
		expect(commonBasisMode([undefined, 'auto'])).toBe('fixed');
	});

	it('reports "mixed" when the bases disagree', () => {
		expect(commonBasisMode([{ fr: 1 }, undefined])).toBe('mixed');
		expect(commonBasisMode(['content', { fr: 1 }])).toBe('mixed');
	});

	it('defaults to "fixed" for an empty selection', () => {
		expect(commonBasisMode([])).toBe('fixed');
	});
});
