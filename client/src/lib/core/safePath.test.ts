import { describe, expect, it } from 'vitest';
import { isForbiddenKey, isSafeParamSpec, isSafePath, sanitizeParamSpecs } from './safePath';

describe('isSafePath', () => {
	it('accepts ordinary dotted paths and rejects prototype-walking segments', () => {
		expect(isSafePath('unit.config.core')).toBe(true);
		expect(isSafePath('sensor')).toBe(true);
		expect(isSafePath('unit.__proto__.polluted')).toBe(false);
		expect(isSafePath('constructor.prototype.x')).toBe(false);
		expect(isSafePath('a.prototype')).toBe(false);
	});

	it('rejects non-strings, empty strings and empty segments', () => {
		expect(isSafePath(undefined)).toBe(false);
		expect(isSafePath(42)).toBe(false);
		expect(isSafePath('')).toBe(false);
		expect(isSafePath('a..b')).toBe(false);
		expect(isSafePath('.a')).toBe(false);
	});

	it('isForbiddenKey names exactly the three prototype keys', () => {
		expect(isForbiddenKey('__proto__')).toBe(true);
		expect(isForbiddenKey('constructor')).toBe(true);
		expect(isForbiddenKey('prototype')).toBe(true);
		expect(isForbiddenKey('config')).toBe(false);
	});
});

describe('isSafeParamSpec / sanitizeParamSpecs', () => {
	it('validates key, target and every targets entry', () => {
		expect(isSafeParamSpec({ key: 'core' })).toBe(true);
		expect(isSafeParamSpec({ key: 'core', target: 'unit.sensor' })).toBe(true);
		expect(isSafeParamSpec({ key: 'core', targets: ['unit.sensor', 'unit.config.label'] })).toBe(
			true
		);
		expect(isSafeParamSpec({ key: '__proto__' })).toBe(false);
		expect(isSafeParamSpec({ key: 'core', target: 'unit.__proto__.x' })).toBe(false);
		expect(isSafeParamSpec({ key: 'core', targets: ['unit.sensor', 'constructor.x'] })).toBe(false);
		// a non-array `targets` (hand-edited JSON) is malformed, not a free pass
		expect(isSafeParamSpec({ key: 'core', targets: 'unit.sensor' as unknown as string[] })).toBe(
			false
		);
	});

	it('sanitizeParamSpecs drops unsafe / non-object entries and keeps undefined as undefined', () => {
		expect(sanitizeParamSpecs(undefined)).toBeUndefined();
		expect(sanitizeParamSpecs('nope' as unknown as [])).toBeUndefined();
		const out = sanitizeParamSpecs([
			{ key: 'a', target: 'unit.config.a' },
			{ key: 'b', target: '__proto__.b' },
			null as unknown as { key: string },
			{ key: 'c', targets: ['prototype.x'] }
		]);
		expect(out).toEqual([{ key: 'a', target: 'unit.config.a' }]);
	});
});
