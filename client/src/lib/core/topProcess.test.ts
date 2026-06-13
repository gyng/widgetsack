import { describe, it, expect } from 'vitest';
import { topMetric, topProcessSensors, TOP_METRICS } from './topProcess';

describe('topMetric', () => {
	it('returns the matching metric, CPU for unknown', () => {
		expect(topMetric('disk').label).toBe('Disk');
		expect(topMetric('gpu').icon).toBe('🎮');
		expect(topMetric('nonsense').id).toBe('cpu');
	});
	it('uses a rate format for disk, percent for cpu, bytes for the rest', () => {
		expect(topMetric('cpu').format).toBe('percent');
		expect(topMetric('disk').format).toBe('rate');
		expect(topMetric('mem').format).toBe('bytes');
		expect(topMetric('gpu').format).toBe('bytes');
	});
});

describe('topProcessSensors', () => {
	it('maps each metric to its proc.<id>.top.{name,value} ids', () => {
		expect(topProcessSensors('cpu')).toEqual({
			name: 'proc.cpu.top.name',
			value: 'proc.cpu.top.pct'
		});
		expect(topProcessSensors('disk')).toEqual({
			name: 'proc.disk.top.name',
			value: 'proc.disk.top.bytes'
		});
		expect(topProcessSensors('gpu').value).toBe('proc.gpu.top.bytes');
	});
	it('covers every metric in the table', () => {
		for (const m of TOP_METRICS) {
			expect(topProcessSensors(m.id).name).toBe(`proc.${m.id}.top.name`);
		}
	});
});
