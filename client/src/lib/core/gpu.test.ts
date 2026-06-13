import { describe, it, expect } from 'vitest';
import { gpuStats } from './gpu';

describe('gpuStats', () => {
	it('formats the present metrics and skips missing ones', () => {
		const stats = gpuStats({
			temp: 64.7,
			vramUsed: 6_000_000_000,
			vramTotal: 12_000_000_000,
			power: 180.4,
			clockCore: 1980,
			fan: null
		});
		expect(stats.map((s) => s.key)).toEqual(['temp', 'vram', 'power', 'clock']); // fan dropped
		expect(stats.find((s) => s.key === 'temp')?.value).toBe('65°');
		expect(stats.find((s) => s.key === 'power')?.value).toBe('180 W');
		expect(stats.find((s) => s.key === 'clock')?.value).toBe('1980 MHz');
		expect(stats.find((s) => s.key === 'vram')?.value).toContain('/');
	});

	it('needs both vram used + total, and returns [] when nothing is reported', () => {
		expect(gpuStats({ vramUsed: 1e9 }).some((s) => s.key === 'vram')).toBe(false);
		expect(gpuStats({})).toEqual([]);
	});
});
