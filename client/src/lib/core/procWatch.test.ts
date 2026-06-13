import { describe, it, expect } from 'vitest';
import { procWatchSensors } from './procWatch';

describe('procWatchSensors', () => {
	it('builds the running/cpu/mem/count ids for a name', () => {
		expect(procWatchSensors('obs64.exe')).toEqual({
			running: 'proc.watch.obs64.exe.running',
			cpu: 'proc.watch.obs64.exe.cpu',
			mem: 'proc.watch.obs64.exe.mem',
			count: 'proc.watch.obs64.exe.count'
		});
	});

	it('defaults a blank name to chrome.exe', () => {
		expect(procWatchSensors('').running).toBe('proc.watch.chrome.exe.running');
		expect(procWatchSensors('  ').cpu).toBe('proc.watch.chrome.exe.cpu');
	});
});
