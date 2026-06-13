import { describe, it, expect } from 'vitest';
import { diskLetters } from './disks';

describe('diskLetters', () => {
	it('extracts the distinct volumes, sorted, from the disk.<letter>.<metric> ids', () => {
		const ids = [
			'cpu.total',
			'disk.C.used.pct',
			'disk.C.total',
			'disk.C.used',
			'disk.D.used.pct',
			'disk.D.total',
			'net.up'
		];
		expect(diskLetters(ids)).toEqual(['C', 'D']);
	});

	it('ignores the disk._probe demand sentinel (no metric segment) and non-disk ids', () => {
		expect(diskLetters(['disk._probe', 'mem.used', 'disk.E.free'])).toEqual(['E']);
		expect(diskLetters([])).toEqual([]);
	});
});
