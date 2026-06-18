import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor, fireEvent, cleanup, act } from '@testing-library/react';

// Stub the Tauri-backed DDC adapter (no backend in tests): the host must still resolve the target
// monitor, derive its rows/title/stats, and drive the optimistic switch → reconcile flow through it.
const { listMonitorInputs, setMonitorInput } = vi.hoisted(() => ({
	listMonitorInputs: vi.fn(),
	setMonitorInput: vi.fn()
}));
vi.mock('../ddc/monitors', () => ({ listMonitorInputs, setMonitorInput }));

import MonitorSwitchHost from './MonitorSwitchHost';
import type { MonitorInputs } from '../ddc/monitors';

const mon = (over: Partial<MonitorInputs> = {}): MonitorInputs => ({
	gdi: '\\\\.\\DISPLAY1',
	friendly: 'Dell U2720Q',
	primary: true,
	current_input: 0x11, // HDMI 1
	supported: [0x0f, 0x11], // DisplayPort 1, HDMI 1
	width: 2560,
	height: 1440,
	refresh_hz: 144,
	...over
});

beforeEach(() => {
	listMonitorInputs.mockReset();
	setMonitorInput.mockReset();
	listMonitorInputs.mockResolvedValue([mon()]);
	setMonitorInput.mockResolvedValue(true);
});

describe('MonitorSwitchHost (container wiring)', () => {
	it('lists monitors and renders the primary monitor: title, rows, active input', async () => {
		const { container } = render(<MonitorSwitchHost />);
		expect(listMonitorInputs).toHaveBeenCalledWith(undefined); // blank target = primary
		await waitFor(() => expect(container.querySelectorAll('.ms-row')).toHaveLength(2));
		expect(container.querySelector('.ms-title')?.textContent).toBe('Dell U2720Q');
		const active = [...container.querySelectorAll('.ms-row')].find(
			(r) => r.getAttribute('data-active') === 'true'
		);
		expect(active?.textContent).toContain('HDMI 1');
	});

	it('resolves a configured target by GDI name and flags it missing when absent', async () => {
		listMonitorInputs.mockResolvedValue([mon({ gdi: '\\\\.\\DISPLAY2', primary: false })]);
		// JSX string literals don't process escapes, so pass the GDI name as a JS expression.
		const { container } = render(<MonitorSwitchHost monitor={'  \\\\.\\DISPLAY9  '} />);
		// trimmed target is passed to the adapter
		await waitFor(() => expect(listMonitorInputs).toHaveBeenCalledWith('\\\\.\\DISPLAY9'));
		// no monitor matches that gdi → missing hint, no rows
		await waitFor(() =>
			expect(container.querySelector('[data-part="empty"]')?.textContent).toBe('monitor not found')
		);
		expect(container.querySelector('.ms-row')).toBeNull();
	});

	it('uses the label override as the title when provided', async () => {
		const { container } = render(<MonitorSwitchHost label="  Desk  " />);
		await waitFor(() => expect(container.querySelector('.ms-title')?.textContent).toBe('Desk'));
	});

	it('shows resolution/refresh stats only when showStats is on', async () => {
		const { container, rerender } = render(<MonitorSwitchHost />);
		await waitFor(() => expect(container.querySelector('.ms-row')).not.toBeNull());
		expect(container.querySelector('.ms-stats')).toBeNull();
		rerender(<MonitorSwitchHost showStats />);
		await waitFor(() =>
			expect(container.querySelector('.ms-stats')?.textContent).toBe('2560×1440 · 144 Hz')
		);
	});

	it('drops the active highlight when showCurrent is off', async () => {
		const { container } = render(<MonitorSwitchHost showCurrent={false} />);
		await waitFor(() => expect(container.querySelectorAll('.ms-row')).toHaveLength(2));
		expect(container.querySelector('.ms-row[data-active="true"]')).toBeNull();
	});

	it('falls back to the first monitor when none reports primary', async () => {
		listMonitorInputs.mockResolvedValue([
			mon({ primary: false, supported: [0x0f], current_input: 0x0f }), // list[0]
			mon({ gdi: '\\\\.\\DISPLAY2', primary: false })
		]);
		const { container } = render(<MonitorSwitchHost />);
		// no primary → list[0], whose single supported input is DisplayPort 1
		await waitFor(() => expect(container.querySelectorAll('.ms-row')).toHaveLength(1));
		expect(container.querySelector('.ms-name')?.textContent).toBe('DisplayPort 1');
	});

	it('renders the default input set (and ignores clicks) when no monitor resolves', async () => {
		listMonitorInputs.mockResolvedValue([]); // empty list, blank target → selected = null
		const { container } = render(<MonitorSwitchHost />);
		// monitorInputRows falls back to DEFAULT_INPUTS (DP1, DP2, HDMI1, HDMI2)
		await waitFor(() => expect(container.querySelectorAll('.ms-row')).toHaveLength(4));
		expect(container.querySelector('[data-part="empty"]')).toBeNull(); // not "missing" (no target)
		// no resolved gdi → pick() early-returns, never calls the switch
		fireEvent.click(container.querySelector('.ms-row')!);
		expect(setMonitorInput).not.toHaveBeenCalled();
	});

	it('picks an input: optimistic highlight, then reconciles via setMonitorInput + refresh', async () => {
		// after the switch the monitor reports DP1 as the current input
		listMonitorInputs
			.mockResolvedValueOnce([mon()]) // initial
			.mockResolvedValue([mon({ current_input: 0x0f })]); // post-switch refresh
		const { container } = render(<MonitorSwitchHost />);
		await waitFor(() => expect(container.querySelectorAll('.ms-row')).toHaveLength(2));

		const dp = [...container.querySelectorAll('.ms-row')].find((r) =>
			r.textContent?.includes('DisplayPort 1')
		);
		fireEvent.click(dp as Element);

		await waitFor(() => expect(setMonitorInput).toHaveBeenCalledWith('\\\\.\\DISPLAY1', 0x0f));
		await waitFor(() => {
			const active = [...container.querySelectorAll('.ms-row')].find(
				(r) => r.getAttribute('data-active') === 'true'
			);
			expect(active?.textContent).toContain('DisplayPort 1');
		});
	});

	it('warns and reverts when a switch fails (monitor reports the old input)', async () => {
		setMonitorInput.mockResolvedValue(false);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { container } = render(<MonitorSwitchHost />);
		await waitFor(() => expect(container.querySelectorAll('.ms-row')).toHaveLength(2));

		const dp = [...container.querySelectorAll('.ms-row')].find((r) =>
			r.textContent?.includes('DisplayPort 1')
		);
		fireEvent.click(dp as Element);

		await waitFor(() => expect(warn).toHaveBeenCalled());
		// reconcile snapped back to HDMI 1 (the reported input)
		await waitFor(() => {
			const active = [...container.querySelectorAll('.ms-row')].find(
				(r) => r.getAttribute('data-active') === 'true'
			);
			expect(active?.textContent).toContain('HDMI 1');
		});
		warn.mockRestore();
	});

	it('polls on the relaxed interval to keep the highlight honest', async () => {
		vi.useFakeTimers();
		try {
			listMonitorInputs
				.mockResolvedValueOnce([mon()]) // initial: HDMI 1
				.mockResolvedValue([mon({ current_input: 0x0f })]); // next poll: DP 1
			const { container, unmount } = render(<MonitorSwitchHost />);
			await act(async () => {
				await Promise.resolve(); // flush the initial refresh
			});
			expect(container.querySelectorAll('.ms-row')).toHaveLength(2);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(8000); // one REFRESH_MS tick → interval fires
			});
			const active = [...container.querySelectorAll('.ms-row')].find(
				(r) => r.getAttribute('data-active') === 'true'
			);
			expect(active?.textContent).toContain('DisplayPort 1');
			unmount(); // tears down the interval + focus listener
		} finally {
			vi.useRealTimers();
		}
	});

	it('refreshes the active input on window focus', async () => {
		listMonitorInputs
			.mockResolvedValueOnce([mon()]) // initial: HDMI 1
			.mockResolvedValue([mon({ current_input: 0x0f })]); // on focus: DP 1
		const { container } = render(<MonitorSwitchHost />);
		await waitFor(() => {
			const active = [...container.querySelectorAll('.ms-row')].find(
				(r) => r.getAttribute('data-active') === 'true'
			);
			expect(active?.textContent).toContain('HDMI 1');
		});

		fireEvent(window, new Event('focus'));

		await waitFor(() => {
			const active = [...container.querySelectorAll('.ms-row')].find(
				(r) => r.getAttribute('data-active') === 'true'
			);
			expect(active?.textContent).toContain('DisplayPort 1');
		});
		cleanup(); // unmount tears down the focus listener + interval
	});
});
