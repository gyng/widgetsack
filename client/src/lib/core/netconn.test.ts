import { describe, it, expect } from 'vitest';
import { parseConnList, visibleConns, connLevel, type ProcConn } from './netconn';

const row = (p: Partial<ProcConn> & { proc: string }): ProcConn => ({
	pid: 0,
	established: 0,
	listening: 0,
	public: 0,
	remotes: [],
	...p
});

describe('parseConnList', () => {
	it('parses well-formed rows from the json sensor value', () => {
		const rows = parseConnList([
			{
				proc: 'chrome.exe',
				pid: 100,
				established: 3,
				listening: 0,
				public: 2,
				remotes: ['8.8.8.8:443']
			}
		]);
		expect(rows).toEqual([
			{
				proc: 'chrome.exe',
				pid: 100,
				established: 3,
				listening: 0,
				public: 2,
				remotes: ['8.8.8.8:443']
			}
		]);
	});

	it('drops malformed entries instead of throwing', () => {
		expect(parseConnList(null)).toEqual([]);
		expect(parseConnList('nope')).toEqual([]);
		expect(parseConnList([null, 5, { pid: 1 } /* no proc */, { proc: 'ok.exe' }])).toEqual([
			row({ proc: 'ok.exe' })
		]);
	});

	it('coerces missing/garbage numbers to 0 and filters non-string remotes', () => {
		const [r] = parseConnList([
			{ proc: 'x.exe', established: 'NaN', public: undefined, remotes: ['1.1.1.1:443', 7, null] }
		]);
		expect(r).toEqual(row({ proc: 'x.exe', remotes: ['1.1.1.1:443'] }));
	});
});

describe('visibleConns', () => {
	const rows = [
		row({ proc: 'a', established: 2, public: 1 }),
		row({ proc: 'b', listening: 1 }), // listener-only
		row({ proc: 'c', established: 1 })
	];

	it('hides listener-only rows when showListening is off', () => {
		expect(visibleConns(rows, false, 10).map((r) => r.proc)).toEqual(['a', 'c']);
	});

	it('keeps listeners when showListening is on, and caps to max', () => {
		expect(visibleConns(rows, true, 2).map((r) => r.proc)).toEqual(['a', 'b']);
	});
});

describe('connLevel', () => {
	it('classifies a row by its strongest signal', () => {
		expect(connLevel(row({ proc: 'a', established: 3, public: 1 }))).toBe('public');
		expect(connLevel(row({ proc: 'a', established: 2 }))).toBe('local');
		expect(connLevel(row({ proc: 'a', listening: 1 }))).toBe('listening');
		expect(connLevel(row({ proc: 'a' }))).toBe('idle');
	});
});
