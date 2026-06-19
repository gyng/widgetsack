import { describe, expect, it } from 'vitest';
import { toHexColor } from './colorHex';

describe('toHexColor', () => {
	it('expands short hex', () => {
		expect(toHexColor('#abc')).toBe('#aabbcc');
		expect(toHexColor('#ABC')).toBe('#aabbcc');
		expect(toHexColor('#abcd')).toBe('#aabbcc'); // #rgba → drop alpha
	});
	it('passes through / truncates long hex', () => {
		expect(toHexColor('#aabbcc')).toBe('#aabbcc');
		expect(toHexColor('#AABBCC')).toBe('#aabbcc');
		expect(toHexColor('#aabbccdd')).toBe('#aabbcc'); // #rrggbbaa → drop alpha
	});
	it('parses rgb / rgba (numbers, alpha ignored)', () => {
		expect(toHexColor('rgb(119, 196, 211)')).toBe('#77c4d3');
		expect(toHexColor('rgba(255, 255, 255, 0.15)')).toBe('#ffffff');
		expect(toHexColor('rgb(0,0,0)')).toBe('#000000');
	});
	it('parses percentage channels', () => {
		expect(toHexColor('rgb(50%, 0%, 100%)')).toBe('#8000ff');
	});
	it('clamps out-of-range channels', () => {
		expect(toHexColor('rgb(300, -10, 128)')).toBe('#ff0080');
	});
	it('returns null for empty / unparseable / non-rgb colours', () => {
		expect(toHexColor('')).toBeNull();
		expect(toHexColor('   ')).toBeNull();
		expect(toHexColor('tomato')).toBeNull();
		expect(toHexColor('hsl(200, 50%, 50%)')).toBeNull();
		expect(toHexColor('var(--np-accent)')).toBeNull();
		expect(toHexColor('#ab')).toBeNull();
	});
	it('returns null for 5- and 7-digit hex (matched length but not a valid form)', () => {
		expect(toHexColor('#abcde')).toBeNull(); // 5 nibbles
		expect(toHexColor('#abcdef0')).toBeNull(); // 7 nibbles
	});
	it('rejects rgb() with fewer than three channels', () => {
		expect(toHexColor('rgb(10, 20)')).toBeNull();
	});
	it('rejects rgb() with a non-numeric channel', () => {
		expect(toHexColor('rgb(10, abc, 30)')).toBeNull();
	});
	it('treats a null value as empty', () => {
		expect(toHexColor(null as unknown as string)).toBeNull();
	});
});
