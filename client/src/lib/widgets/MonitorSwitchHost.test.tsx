import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor, fireEvent, cleanup, act } from '@testing-library/react';

// Stub the Tauri-backed DDC adapter (no backend in tests): the host must still resolve the target
// monitor, derive its rows/title/stats, and drive the optimistic switch → reconcile flow through it.
const { listMonitorInputs, setMonitorInput, setMonitorVolume, setAudioVolume } = vi.hoisted(() => ({
	listMonitorInputs: vi.fn(),
	setMonitorInput: vi.fn(),
	setMonitorVolume: vi.fn(),
	setAudioVolume: vi.fn()
}));
vi.mock('../ddc/monitors', () => ({ listMonitorInputs, setMonitorInput, setMonitorVolume }));
vi.mock('../audio/volume', () => ({ setAudioVolume }));

import MonitorSwitchHost from './MonitorSwitchHost';
import type { MonitorInputs } from '../ddc/monitors';

const mon = (over: Partial<MonitorInputs> = {}): MonitorInputs => ({
	gdi: '\\\\.\\DISPLAY1',
	stable: 'DELD154-UID184579',
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
	setAudioVolume.mockReset();
	setMonitorVolume.mockReset();
	listMonitorInputs.mockResolvedValue([mon()]);
	setMonitorInput.mockResolvedValue(true);
	setAudioVolume.mockResolvedValue(true);
	setMonitorVolume.mockResolvedValue(true);
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

	it('resolves a configured target by its stable identity key, never by a blank one', async () => {
		listMonitorInputs.mockResolvedValue([
			mon({ gdi: '\\\\.\\DISPLAY1', stable: '', primary: true, current_input: 0x11 }),
			mon({
				gdi: '\\\\.\\DISPLAY2',
				stable: 'CRXED00-UID184576',
				primary: false,
				current_input: 0x0f
			})
		]);
		const { container } = render(<MonitorSwitchHost monitor="CRXED00-UID184576" />);
		await waitFor(() =>
			expect(container.querySelector('.ms-row[data-active="true"]')?.textContent).toContain(
				'DisplayPort 1'
			)
		);
		expect(listMonitorInputs).toHaveBeenCalledWith('CRXED00-UID184576');
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

	it('shows an unavailable state without inert source buttons when no monitor resolves', async () => {
		listMonitorInputs.mockResolvedValue([]); // empty list, blank target → selected = null
		const { container } = render(<MonitorSwitchHost />);
		await waitFor(() =>
			expect(container.querySelector('[data-part="empty"]')?.textContent).toBe(
				'This monitor doesn’t support input switching (DDC/CI may be off in its menu)'
			)
		);
		expect(container.querySelector('.ms-row')).toBeNull();
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

	it('ignores paired volumes by default (volume target off) — a switch changes no volume', async () => {
		const { container } = render(<MonitorSwitchHost sources="0x11=HDMI, 0xf=DP@35" />);
		await waitFor(() => expect(container.querySelectorAll('.ms-row')).toHaveLength(2));
		const dp = [...container.querySelectorAll('.ms-row')].find((r) =>
			r.textContent?.includes('DP')
		);
		fireEvent.click(dp as Element);
		await waitFor(() => expect(setMonitorInput).toHaveBeenCalledWith('\\\\.\\DISPLAY1', 0x0f));
		expect(setAudioVolume).not.toHaveBeenCalled();
		expect(setMonitorVolume).not.toHaveBeenCalled();
	});

	it('volume target "system": the Windows volume follows a successful switch, only for sources with one', async () => {
		const { container } = render(
			<MonitorSwitchHost sources="0x11=HDMI, 0xf=DP@35" volumeTarget="system" />
		);
		await waitFor(() => expect(container.querySelectorAll('.ms-row')).toHaveLength(2));
		const order: string[] = [];
		setMonitorInput.mockImplementation(async () => (order.push('input'), true));
		setAudioVolume.mockImplementation(async () => (order.push('volume'), true));
		const dp = [...container.querySelectorAll('.ms-row')].find((r) =>
			r.textContent?.includes('DP')
		);
		fireEvent.click(dp as Element);
		await waitFor(() => expect(setAudioVolume).toHaveBeenCalledWith(0.35, undefined)); // 35% → scalar, default output
		expect(order).toEqual(['input', 'volume']);
		expect(setMonitorVolume).not.toHaveBeenCalled();

		setAudioVolume.mockClear();
		setMonitorInput.mockClear();
		const hdmi = [...container.querySelectorAll('.ms-row')].find((r) =>
			r.textContent?.includes('HDMI')
		);
		await waitFor(() => expect(hdmi?.hasAttribute('disabled')).toBe(false));
		fireEvent.click(hdmi as Element);
		await waitFor(() => expect(setMonitorInput).toHaveBeenCalledWith('\\\\.\\DISPLAY1', 0x11));
		expect(setAudioVolume).not.toHaveBeenCalled(); // no @volume on this source
	});

	it('volume target "system" with a chosen output sets THAT device, not the default', async () => {
		const { container } = render(
			<MonitorSwitchHost
				sources="0xf=DP@35"
				volumeTarget="system"
				volumeDevice=" {0.0.0.00000000}.{abcd-1234} "
			/>
		);
		await waitFor(() => expect(container.querySelectorAll('.ms-row')).toHaveLength(2));
		const dp = [...container.querySelectorAll('.ms-row')].find((r) =>
			r.textContent?.includes('DP')
		);
		fireEvent.click(dp as Element);
		await waitFor(() =>
			expect(setAudioVolume).toHaveBeenCalledWith(0.35, '{0.0.0.00000000}.{abcd-1234}')
		);
	});

	it('volume target "monitor": the speaker volume goes out BEFORE the switch, best-effort', async () => {
		const { container } = render(<MonitorSwitchHost sources="0xf=DP@35" volumeTarget="monitor" />);
		// Two rows: DP from the spec, plus the active HDMI input (always shown so it can be re-selected).
		await waitFor(() => expect(container.querySelectorAll('.ms-row')).toHaveLength(2));
		const order: string[] = [];
		setMonitorVolume.mockImplementation(async () => (order.push('volume'), true));
		setMonitorInput.mockImplementation(async () => (order.push('input'), true));
		const dp = [...container.querySelectorAll('.ms-row')].find((r) =>
			r.textContent?.includes('DP')
		);
		fireEvent.click(dp as Element);
		await waitFor(() => expect(setMonitorInput).toHaveBeenCalledWith('\\\\.\\DISPLAY1', 0x0f));
		expect(setMonitorVolume).toHaveBeenCalledWith('\\\\.\\DISPLAY1', 35);
		expect(order).toEqual(['volume', 'input']);
		expect(setAudioVolume).not.toHaveBeenCalled();

		// A rejected speaker volume never blocks the switch.
		setMonitorVolume.mockResolvedValueOnce(false);
		setMonitorInput.mockClear();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await waitFor(() => expect(dp?.hasAttribute('disabled')).toBe(false));
		fireEvent.click(dp as Element);
		await waitFor(() => expect(setMonitorInput).toHaveBeenCalledWith('\\\\.\\DISPLAY1', 0x0f));
		expect(warn).toHaveBeenCalledWith('monitor volume change failed; switching input anyway');
		warn.mockRestore();
	});

	it('volume target "system": a failed switch leaves the volume alone; a failed volume change is logged', async () => {
		setMonitorInput.mockResolvedValueOnce(false);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { container } = render(<MonitorSwitchHost sources="0xf=DP@35" volumeTarget="system" />);
		await waitFor(() => expect(container.querySelectorAll('.ms-row')).toHaveLength(2));
		const dp = [...container.querySelectorAll('.ms-row')].find((r) =>
			r.textContent?.includes('DP')
		);
		fireEvent.click(dp as Element);
		await waitFor(() =>
			expect(warn).toHaveBeenCalledWith(
				'monitor input switch failed; reverted to the reported input'
			)
		);
		expect(setAudioVolume).not.toHaveBeenCalled();

		setAudioVolume.mockResolvedValueOnce(false);
		await waitFor(() => expect(dp?.hasAttribute('disabled')).toBe(false));
		fireEvent.click(dp as Element);
		await waitFor(() =>
			expect(warn).toHaveBeenCalledWith('system volume change after input switch failed')
		);
		warn.mockRestore();
	});

	it('does not reconcile an old target after the configured monitor changes mid-switch', async () => {
		let finishSwitch!: (ok: boolean) => void;
		setMonitorInput.mockImplementationOnce(
			() => new Promise((resolve) => (finishSwitch = resolve))
		);
		const { container, rerender } = render(<MonitorSwitchHost monitor={'\\\\.\\DISPLAY1'} />);
		await waitFor(() => expect(container.querySelectorAll('.ms-row')).toHaveLength(2));
		const dp = [...container.querySelectorAll('.ms-row')].find((r) =>
			r.textContent?.includes('DisplayPort 1')
		);
		fireEvent.click(dp as Element);
		await waitFor(() => expect(setMonitorInput).toHaveBeenCalledTimes(1));
		const callsBeforeTargetChange = listMonitorInputs.mock.calls.length;

		rerender(<MonitorSwitchHost monitor={'\\\\.\\DISPLAY2'} />);
		await act(async () => finishSwitch(true));
		expect(listMonitorInputs.mock.calls.length).toBe(callsBeforeTargetChange + 1);
		expect(listMonitorInputs).toHaveBeenLastCalledWith('\\\\.\\DISPLAY2');
	});

	it('does not update busy state after an in-flight monitor switch unmounts', async () => {
		let finishSwitch!: (ok: boolean) => void;
		setMonitorInput.mockImplementationOnce(
			() => new Promise((resolve) => (finishSwitch = resolve))
		);
		const { container, unmount } = render(<MonitorSwitchHost />);
		await waitFor(() => expect(container.querySelectorAll('.ms-row')).toHaveLength(2));
		const dp = [...container.querySelectorAll('.ms-row')].find((r) =>
			r.textContent?.includes('DisplayPort 1')
		);
		fireEvent.click(dp as Element);
		unmount();
		await act(async () => finishSwitch(true));
		expect(setMonitorInput).toHaveBeenCalledTimes(1);
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

	it('skips an interval tick while a DDC read is still in flight (no pile-up mid input-switch)', async () => {
		vi.useFakeTimers();
		try {
			// A monitor mid input-switch answers DDC slowly: the initial read is still pending when the
			// next poll tick arrives. Ticks must not stack blocking reads behind it.
			let resolveFirst!: (monitors: MonitorInputs[]) => void;
			listMonitorInputs.mockImplementationOnce(
				() => new Promise((resolve) => (resolveFirst = resolve))
			);
			const { container, unmount } = render(<MonitorSwitchHost />);
			expect(listMonitorInputs).toHaveBeenCalledTimes(1);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(8000 * 2); // two ticks while the read is pending
			});
			expect(listMonitorInputs).toHaveBeenCalledTimes(1);
			await act(async () => resolveFirst([mon()]));
			expect(container.querySelectorAll('.ms-row')).toHaveLength(2);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(8000); // the read settled → polling resumes
			});
			expect(listMonitorInputs).toHaveBeenCalledTimes(2);
			unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it('a stray interval tick after teardown is swallowed by the alive guard', async () => {
		const setIntervalSpy = vi.spyOn(window, 'setInterval');
		const { unmount } = render(<MonitorSwitchHost />);
		await act(async () => undefined); // settle the mount refresh
		const tick = setIntervalSpy.mock.calls.at(-1)?.[0] as () => void;
		unmount();
		listMonitorInputs.mockClear();
		// clearInterval normally prevents this; if a queued tick slips through it must not refresh.
		tick();
		expect(listMonitorInputs).not.toHaveBeenCalled();
		setIntervalSpy.mockRestore();
	});

	it('shows a loading state and no source buttons while the target lookup is pending', () => {
		listMonitorInputs.mockReturnValue(new Promise(() => {}));
		const { container } = render(<MonitorSwitchHost monitor={'\\\\.\\DISPLAY7'} />);
		expect(container.querySelector('[data-part="empty"]')?.textContent).toBe('loading…');
		expect(container.querySelector('.ms-row')).toBeNull();
		expect(setMonitorInput).not.toHaveBeenCalled();
	});

	it('ignores an older refresh that resolves after a newer focus refresh', async () => {
		let resolveOld!: (monitors: MonitorInputs[]) => void;
		let resolveNew!: (monitors: MonitorInputs[]) => void;
		listMonitorInputs
			.mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
			.mockImplementationOnce(() => new Promise((resolve) => (resolveNew = resolve)));
		const { container } = render(<MonitorSwitchHost />);
		fireEvent(window, new Event('focus'));
		await act(async () => resolveNew([mon({ current_input: 0x0f })]));
		await waitFor(() =>
			expect(container.querySelector('.ms-row[data-active="true"]')?.textContent).toContain(
				'DisplayPort 1'
			)
		);
		await act(async () => resolveOld([mon({ current_input: 0x11 })]));
		expect(container.querySelector('.ms-row[data-active="true"]')?.textContent).toContain(
			'DisplayPort 1'
		);
	});

	it('never renders a stale monitor when the configured target changes', async () => {
		let resolveFirst!: (monitors: MonitorInputs[]) => void;
		listMonitorInputs
			.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
			.mockResolvedValueOnce([
				mon({ gdi: '\\\\.\\DISPLAY2', friendly: 'Second', primary: false, current_input: 0x0f })
			]);
		const { container, rerender } = render(<MonitorSwitchHost monitor={'\\\\.\\DISPLAY1'} />);
		rerender(<MonitorSwitchHost monitor={'\\\\.\\DISPLAY2'} />);
		await waitFor(() => expect(container.querySelector('.ms-title')?.textContent).toBe('Second'));
		await act(async () =>
			resolveFirst([mon({ gdi: '\\\\.\\DISPLAY1', friendly: 'First', current_input: 0x11 })])
		);
		expect(container.querySelector('.ms-title')?.textContent).toBe('Second');
		expect(container.querySelector('.ms-row[data-active="true"]')?.textContent).toContain(
			'DisplayPort 1'
		);
	});

	it('disables every source and ignores repeated picks while a switch is pending', async () => {
		let resolveSwitch!: (ok: boolean) => void;
		setMonitorInput.mockImplementation(() => new Promise((resolve) => (resolveSwitch = resolve)));
		const { container } = render(<MonitorSwitchHost />);
		await waitFor(() => expect(container.querySelectorAll('.ms-row')).toHaveLength(2));
		const dp = [...container.querySelectorAll('.ms-row')].find((row) =>
			row.textContent?.includes('DisplayPort 1')
		)!;
		fireEvent.click(dp);
		expect(
			[...container.querySelectorAll<HTMLButtonElement>('.ms-row')].every((row) => row.disabled)
		).toBe(true);
		fireEvent.click(dp);
		expect(setMonitorInput).toHaveBeenCalledTimes(1);
		await act(async () => resolveSwitch(true));
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
