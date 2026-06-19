import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, cleanup } from '@testing-library/react';

// Mock the outer-ring Tauri audio adapter; the pure readout/icon math (core/volume) stays REAL via
// the presentational Volume meter. We assert the host's wiring: poll → state, optimistic set + the
// drag-hold suppression, and the mute toggle.
const getAudioVolume = vi.fn();
const setAudioVolume = vi.fn<(level: number) => Promise<void>>(() => Promise.resolve());
const setAudioMute = vi.fn<(muted: boolean) => Promise<void>>(() => Promise.resolve());
vi.mock('../audio/volume', () => ({
	getAudioVolume: () => getAudioVolume(),
	setAudioVolume: (l: number) => setAudioVolume(l),
	setAudioMute: (m: boolean) => setAudioMute(m)
}));

import VolumeHost from './VolumeHost';

beforeEach(() => {
	vi.useFakeTimers();
	getAudioVolume.mockResolvedValue({ level: 0.5, muted: false });
});
afterEach(() => {
	cleanup();
	vi.runOnlyPendingTimers();
	vi.useRealTimers();
	vi.clearAllMocks();
});

function pct(c: HTMLElement): string {
	return c.querySelector('[data-part="value"]')!.textContent ?? '';
}
function slider(c: HTMLElement): HTMLInputElement {
	return c.querySelector('input.vol-slider')!;
}

describe('VolumeHost', () => {
	it('polls the backend on mount and reflects level + mute', async () => {
		const { container } = render(<VolumeHost />);
		await act(async () => {
			await Promise.resolve(); // flush the initial poll()
		});
		expect(getAudioVolume).toHaveBeenCalled();
		expect(pct(container)).toBe('50%');
		expect(container.querySelector('[data-muted]')).toBeNull();
	});

	it('keeps polling on the interval', async () => {
		const { container } = render(<VolumeHost />);
		await act(async () => {
			await Promise.resolve();
		});
		getAudioVolume.mockResolvedValue({ level: 0.8, muted: false });
		await act(async () => {
			vi.advanceTimersByTime(1000);
			await Promise.resolve();
		});
		expect(pct(container)).toBe('80%');
	});

	it('sets the volume optimistically and suppresses a poll that lands during the drag-hold', async () => {
		const { container } = render(<VolumeHost />);
		await act(async () => {
			await Promise.resolve();
		});
		// Advance most of the way to the next poll tick, then drag — so the tick lands inside the
		// 400ms hold window and the (stale) backend value must NOT yank the thumb back.
		await act(async () => {
			vi.advanceTimersByTime(800);
			await Promise.resolve();
		});
		getAudioVolume.mockResolvedValue({ level: 0.5, muted: false }); // stale
		await act(async () => {
			fireEvent.change(slider(container), { target: { value: '30' } });
		});
		expect(setAudioVolume).toHaveBeenCalledWith(0.3);
		expect(pct(container)).toBe('30%'); // optimistic
		// A rapid second drag re-arms the hold timer (clears the pending one — line 42 branch).
		await act(async () => {
			fireEvent.change(slider(container), { target: { value: '35' } });
		});
		expect(setAudioVolume).toHaveBeenLastCalledWith(0.35);
		expect(pct(container)).toBe('35%');
		await act(async () => {
			vi.advanceTimersByTime(200); // poll tick at t=1000, hold still active
			await Promise.resolve();
		});
		expect(pct(container)).toBe('35%'); // suppressed: still the optimistic value

		// After the hold releases, the next poll is accepted again.
		getAudioVolume.mockResolvedValue({ level: 0.65, muted: false });
		await act(async () => {
			vi.advanceTimersByTime(1000); // release hold (t=1200) then next poll tick (t=2000)
			await Promise.resolve();
		});
		expect(pct(container)).toBe('65%');
	});

	it('toggles mute and pushes it to the backend', async () => {
		const { container } = render(<VolumeHost />);
		await act(async () => {
			await Promise.resolve();
		});
		const muteBtn = container.querySelector('button.vol-mute')!;
		await act(async () => {
			fireEvent.click(muteBtn);
		});
		expect(setAudioMute).toHaveBeenCalledWith(true);
		expect(container.querySelector('[data-muted]')).not.toBeNull();
		await act(async () => {
			fireEvent.click(muteBtn);
		});
		expect(setAudioMute).toHaveBeenLastCalledWith(false);
	});

	it('ignores a null reading from the backend (stays at —)', async () => {
		getAudioVolume.mockResolvedValue(null);
		const { container } = render(<VolumeHost />);
		await act(async () => {
			await Promise.resolve();
		});
		expect(pct(container)).toBe('—');
	});

	it('passes the color prop through to the meter accent', async () => {
		const { container } = render(<VolumeHost color="#0f0" />);
		await act(async () => {
			await Promise.resolve();
		});
		const root = container.querySelector('.volume') as HTMLElement;
		expect(root.style.getPropertyValue('--vol-accent')).toBe('#0f0');
	});
});
