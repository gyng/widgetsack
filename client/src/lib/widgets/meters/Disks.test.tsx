import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import Disks from './Disks';
import { createTelemetryHub } from '../../core/telemetry';
import { TelemetryHubContext } from '../telemetryContext';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});
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

	it('shows a dash (no rows) when there is no telemetry hub', async () => {
		let container!: HTMLElement;
		await act(async () => {
			container = render(
				<TelemetryHubContext.Provider value={null}>
					<Disks />
				</TelemetryHubContext.Provider>
			).container;
		});
		expect(container.querySelector('.disk-empty')?.textContent).toBe('—');
		expect(container.querySelectorAll('.disk-row')).toHaveLength(0);
	});

	it('omits the byte meta when showBytes is off (percent only)', async () => {
		const hub = createTelemetryHub();
		hub.ingestBatch([
			s('disk.C.used.pct', 50),
			s('disk.C.used', 500_000_000_000),
			s('disk.C.total', 1_000_000_000_000)
		]);
		let container!: HTMLElement;
		await act(async () => {
			container = render(
				<TelemetryHubContext.Provider value={hub}>
					<Disks showBytes={false} />
				</TelemetryHubContext.Provider>
			).container;
		});
		const meta = container.querySelector('.disk-meta')?.textContent;
		expect(meta).toBe('50%'); // no " · 500GB/1TB" tail
		expect(meta).not.toContain('·');
	});

	it('renders a discovered volume with no percent sample (blank meta, no byte tail)', async () => {
		// total present (so the letter is discovered) but neither used.pct nor used → pct is null:
		// the bar floors at 0% and the meta is empty (the byte tail also needs `used`, which is absent).
		const hub = createTelemetryHub();
		hub.ingestBatch([s('disk.E.total', 2_000_000_000_000)]);
		let container!: HTMLElement;
		await act(async () => {
			container = render(
				<TelemetryHubContext.Provider value={hub}>
					<Disks />
				</TelemetryHubContext.Provider>
			).container;
		});
		const row = container.querySelector('.disk-row') as HTMLElement;
		expect(row.querySelector('.disk-label')?.textContent).toBe('E:');
		expect(row.style.getPropertyValue('--disk-pct')).toBe('0%'); // null pct → clamped to 0
		expect(row.querySelector('.disk-meta')?.textContent).toBe(''); // null pct → blank meta
	});

	it('applies the accent color as a CSS var on the container', async () => {
		const hub = createTelemetryHub();
		hub.ingestBatch([s('disk.C.used.pct', 10)]);
		let container!: HTMLElement;
		await act(async () => {
			container = render(
				<TelemetryHubContext.Provider value={hub}>
					<Disks color="cyan" />
				</TelemetryHubContext.Provider>
			).container;
		});
		expect(
			(container.querySelector('.disks') as HTMLElement).style.getPropertyValue('--disk-accent')
		).toBe('cyan');
	});

	it('bails the re-render on the 5s re-read when capacity is unchanged (sameVols dedupe)', async () => {
		vi.useFakeTimers();
		const hub = createTelemetryHub();
		hub.ingestBatch([
			s('disk.C.used.pct', 40),
			s('disk.C.used', 400_000_000_000),
			s('disk.C.total', 1_000_000_000_000)
		]);
		let container!: HTMLElement;
		await act(async () => {
			container = render(
				<TelemetryHubContext.Provider value={hub}>
					<Disks />
				</TelemetryHubContext.Provider>
			).container;
		});
		const before = container.querySelector('.disk-meta')?.textContent;
		// The interval re-reads the same hub snapshot → next equals prev (same length, every field equal),
		// so sameVols's .every callback runs and returns true; React keeps the prior array (no churn).
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(container.querySelectorAll('.disk-row')).toHaveLength(1);
		expect(container.querySelector('.disk-meta')?.textContent).toBe(before);
	});

	it('does not crash if the demand-probe sensor unexpectedly receives a sample', async () => {
		// disk._probe is a pure demand sentinel (subscribing gates backend sampling on); the widget
		// itself never reads a value off it. Its subscribe callback is a no-op — this just proves that
		// holds even if something upstream ever did emit on it.
		const hub = createTelemetryHub();
		hub.ingestBatch([s('disk.C.used.pct', 40)]);
		let container!: HTMLElement;
		await act(async () => {
			container = render(
				<TelemetryHubContext.Provider value={hub}>
					<Disks />
				</TelemetryHubContext.Provider>
			).container;
		});
		expect(() =>
			hub.ingest({ sensor: 'disk._probe', ts_ms: 0, value: { kind: 'scalar', value: 1 } })
		).not.toThrow();
		expect(container.querySelector('.disk-meta')?.textContent).toBe('40%');
	});

	it('updates rows on the 5s re-read when a volume capacity changes', async () => {
		vi.useFakeTimers();
		const hub = createTelemetryHub();
		hub.ingestBatch([s('disk.C.used.pct', 40)]);
		let container!: HTMLElement;
		await act(async () => {
			container = render(
				<TelemetryHubContext.Provider value={hub}>
					<Disks />
				</TelemetryHubContext.Provider>
			).container;
		});
		expect(container.querySelector('.disk-meta')?.textContent).toBe('40%');
		hub.ingestBatch([s('disk.C.used.pct', 88)]); // same letter, changed pct → sameVols returns false
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(container.querySelector('.disk-meta')?.textContent).toBe('88%');
	});
});
