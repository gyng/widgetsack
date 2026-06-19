import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import MonitorSwitch from './MonitorSwitch';
import type { MonitorInputRow } from '../../core/monitorInputs';

afterEach(cleanup);

const rows: MonitorInputRow[] = [
	{ value: 0x0f, label: 'DisplayPort 1', active: false },
	{ value: 0x11, label: 'HDMI 1', active: true }
];

describe('MonitorSwitch meter', () => {
	it('renders the title and one row per input, marking the active one', () => {
		const { container } = render(
			<MonitorSwitch title="Desk" rows={rows} onPick={() => undefined} />
		);
		expect(container.querySelector('.ms-title')?.textContent).toBe('Desk');
		const els = container.querySelectorAll('.ms-row');
		expect(els).toHaveLength(2);
		const active = [...els].find((r) => r.getAttribute('data-active') === 'true');
		expect(active?.textContent).toContain('HDMI 1');
	});

	it('calls onPick with the VCP value on click', () => {
		const onPick = vi.fn();
		const { container } = render(<MonitorSwitch title="Desk" rows={rows} onPick={onPick} />);
		const dp = [...container.querySelectorAll('.ms-row')].find((r) =>
			r.textContent?.includes('DisplayPort 1')
		);
		fireEvent.click(dp as Element);
		expect(onPick).toHaveBeenCalledWith(0x0f);
	});

	it('shows the stats line only when enabled and present', () => {
		const { container, rerender } = render(
			<MonitorSwitch title="Desk" rows={rows} stats="2560×1440 · 144 Hz" onPick={() => undefined} />
		);
		expect(container.querySelector('.ms-stats')).toBeNull();
		rerender(
			<MonitorSwitch
				title="Desk"
				rows={rows}
				stats="2560×1440 · 144 Hz"
				showStats
				onPick={() => undefined}
			/>
		);
		expect(container.querySelector('.ms-stats')?.textContent).toBe('2560×1440 · 144 Hz');
	});

	it('marks the busy input while a switch is in flight', () => {
		const { container } = render(
			<MonitorSwitch title="Desk" rows={rows} busyValue={0x0f} onPick={() => undefined} />
		);
		const busy = [...container.querySelectorAll('.ms-row')].find(
			(r) => r.getAttribute('data-busy') === 'true'
		);
		expect(busy?.textContent).toContain('DisplayPort 1');
	});

	it('shows a "monitor not found" hint when missing', () => {
		const { container } = render(
			<MonitorSwitch title="Desk" rows={rows} missing onPick={() => undefined} />
		);
		expect(container.querySelector('.ms-empty')?.textContent).toBe('monitor not found');
		expect(container.querySelector('.ms-row')).toBeNull();
	});

	it('shows a dash placeholder when there are no input rows (and not missing)', () => {
		const { container } = render(<MonitorSwitch title="Desk" rows={[]} onPick={() => undefined} />);
		const empty = container.querySelector('.ms-empty');
		expect(empty?.textContent).toBe('—');
		expect(container.querySelector('.ms-row')).toBeNull();
	});

	it('applies the accent color var and compact attribute when set', () => {
		const { container } = render(
			<MonitorSwitch title="Desk" rows={rows} compact color="#abc" onPick={() => undefined} />
		);
		const root = container.querySelector('.monitorswitch') as HTMLElement;
		expect(root.getAttribute('data-compact')).toBe('true');
		expect(root.style.getPropertyValue('--ms-accent')).toBe('#abc');
	});
});
