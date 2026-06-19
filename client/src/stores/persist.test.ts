import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPersistedStore, readJson, readString, writeJson, writeString } from './persist';

afterEach(() => vi.restoreAllMocks());

describe('readJson / writeJson', () => {
	beforeEach(() => localStorage.clear());

	it('round-trips a JSON value', () => {
		writeJson('t.json', { a: 1 });
		expect(readJson('t.json')).toEqual({ a: 1 });
	});

	it('returns null for a missing key', () => {
		expect(readJson('t.missing')).toBeNull();
	});

	it('returns null for corrupt JSON instead of throwing', () => {
		localStorage.setItem('t.corrupt', '{not json');
		expect(readJson('t.corrupt')).toBeNull();
	});

	it('swallows a setItem failure (quota / unavailable) on writeJson', () => {
		const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
			throw new DOMException('QuotaExceededError');
		});
		expect(() => writeJson('t.json', { a: 1 })).not.toThrow();
		expect(spy).toHaveBeenCalledWith('t.json', JSON.stringify({ a: 1 }));
		spy.mockRestore();
	});
});

describe('readString / writeString', () => {
	beforeEach(() => localStorage.clear());

	it('round-trips a bare string without JSON quoting', () => {
		writeString('t.str', '\\\\.\\DISPLAY1');
		expect(localStorage.getItem('t.str')).toBe('\\\\.\\DISPLAY1');
		expect(readString('t.str')).toBe('\\\\.\\DISPLAY1');
	});

	it('returns null for a missing key', () => {
		expect(readString('t.missing')).toBeNull();
	});

	it('returns null instead of throwing when getItem is unavailable', () => {
		const spy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
			throw new DOMException('SecurityError');
		});
		expect(readString('t.str')).toBeNull();
		spy.mockRestore();
	});

	it('swallows a setItem failure on writeString', () => {
		const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
			throw new DOMException('QuotaExceededError');
		});
		expect(() => writeString('t.str', 'value')).not.toThrow();
		expect(spy).toHaveBeenCalledWith('t.str', 'value');
		spy.mockRestore();
	});
});

describe('createPersistedStore', () => {
	beforeEach(() => localStorage.clear());

	const parse = (raw: unknown): { n: number } =>
		typeof raw === 'object' && raw !== null && typeof (raw as { n?: unknown }).n === 'number'
			? { n: (raw as { n: number }).n }
			: { n: 0 };

	it('seeds from storage via parse', () => {
		localStorage.setItem('t.store', JSON.stringify({ n: 7 }));
		const store = createPersistedStore('t.store', parse);
		expect(store.getSnapshot()).toEqual({ n: 7 });
	});

	it('falls back to parse(null) when storage is empty or corrupt', () => {
		localStorage.setItem('t.store', '{not json');
		const store = createPersistedStore('t.store', parse);
		expect(store.getSnapshot()).toEqual({ n: 0 });
	});

	it('persists once at creation (defaults land on first run)', () => {
		createPersistedStore('t.store', parse);
		expect(JSON.parse(localStorage.getItem('t.store') ?? '')).toEqual({ n: 0 });
	});

	it('persists on every change without a React subscriber', () => {
		const store = createPersistedStore('t.store', parse);
		store.set({ n: 3 });
		expect(JSON.parse(localStorage.getItem('t.store') ?? '')).toEqual({ n: 3 });
		store.update((cur) => ({ n: cur.n + 1 }));
		expect(JSON.parse(localStorage.getItem('t.store') ?? '')).toEqual({ n: 4 });
	});

	it('writes through serialize so runtime-only fields stay out of storage', () => {
		const store = createPersistedStore(
			't.store',
			(raw) => ({ ...parse(raw), runtime: 'live' }),
			(v) => ({ n: v.n })
		);
		store.set({ n: 9, runtime: 'live' });
		expect(JSON.parse(localStorage.getItem('t.store') ?? '')).toEqual({ n: 9 });
	});
});
