import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import Disks from './Disks';
import { createTelemetryHub } from '../../core/telemetry';
import { TelemetryHubContext } from '../telemetryContext';

afterEach(cleanup);
const s = (sensor: string, value: number) => ({
	sensor,
	ts_ms: 0,
	value: { kind: 'scalar' as const, value }
});

describe('Disks meter', () => {
	it('renders one usage bar per discovered volume, sorted, flagging near-full', async () => {
		const hub = createTelemetryHub();
		hub.ingestBatch([
			s('disk.C.used.pct', 62),
			s('disk.C.used', 620_000_000_000),
			s('disk.C.total', 1_000_000_000_000),
			s('disk.D.used.pct', 95),
			s('disk.D.used', 1.9e12),
			s('disk.D.total', 2e12)
		]);
		let container!: HTMLElement;
		await act(async () => {
			container = render(
				<TelemetryHubContext.Provider value={hub}>
					<Disks />
				</TelemetryHubContext.Provider>
			).container;
		});
		const rows = container.querySelectorAll('.disk-row');
		expect(rows).toHaveLength(2);
		expect(rows[0].querySelector('.disk-label')?.textContent).toBe('C:');
		expect(rows[1].querySelector('.disk-label')?.textContent).toBe('D:');
		expect(rows[0].querySelector('.disk-meta')?.textContent).toContain('62%');
		expect(rows[1].getAttribute('data-level')).toBe('full'); // 95% ≥ 90
	});

	it('shows a dash before any disk sample arrives', async () => {
		const hub = createTelemetryHub();
		let container!: HTMLElement;
		await act(async () => {
			container = render(
				<TelemetryHubContext.Provider value={hub}>
					<Disks />
				</TelemetryHubContext.Provider>
			).container;
		});
		expect(container.querySelector('.disk-empty')?.textContent).toBe('—');
	});
});
