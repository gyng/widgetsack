import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { AudioDevice } from '../core/audioDevices';

// Stub the Tauri-backed audio adapter (no backend in tests). The host owns all the wiring (list /
// read default / set default + the refresh cadence); these spies let us drive what it sees and
// assert which command a row click fires.
const { listAudioOutputs, getDefaultAudioOutput, setDefaultAudioOutput } = vi.hoisted(() => ({
	listAudioOutputs: vi.fn<() => Promise<AudioDevice[]>>(),
	getDefaultAudioOutput: vi.fn<() => Promise<string | null>>(),
	setDefaultAudioOutput: vi.fn<(id: string) => Promise<boolean>>()
}));
vi.mock('../audio/devices', () => ({
	listAudioOutputs,
	getDefaultAudioOutput,
	setDefaultAudioOutput
}));

import AudioSwitcherHost from './AudioSwitcherHost';

const DEVICES: AudioDevice[] = [
	{ id: 'spk', name: 'Speakers' },
	{ id: 'hp', name: 'Headphones' }
];

beforeEach(() => {
	listAudioOutputs.mockReset().mockResolvedValue(DEVICES);
	getDefaultAudioOutput.mockReset().mockResolvedValue('spk');
	setDefaultAudioOutput.mockReset().mockResolvedValue(true);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const rowByName = (container: HTMLElement, name: string): HTMLButtonElement => {
	const el = [...container.querySelectorAll<HTMLButtonElement>('.as-row')].find(
		(b) => b.querySelector('.as-name')?.textContent === name
	);
	if (!el) throw new Error(`no row named "${name}"`);
	return el;
};

describe('AudioSwitcherHost (container wiring)', () => {
	it('refreshes on mount and renders the devices with the default marked active', async () => {
		const { container } = render(<AudioSwitcherHost />);
		expect(listAudioOutputs).toHaveBeenCalled();
		expect(getDefaultAudioOutput).toHaveBeenCalled();
		await waitFor(() => expect(container.querySelectorAll('.as-row').length).toBe(2));
		// The active (default) row floats to the top and carries data-active.
		const rows = [...container.querySelectorAll<HTMLButtonElement>('.as-row')];
		expect(rows[0].querySelector('.as-name')?.textContent).toBe('Speakers');
		expect(rows[0].getAttribute('data-active')).toBe('true');
	});

	it('passes the accent color through to the meter', async () => {
		const { container } = render(<AudioSwitcherHost color="#abcdef" />);
		await waitFor(() => expect(container.querySelectorAll('.as-row').length).toBe(2));
		const root = container.querySelector('.audioswitch') as HTMLElement;
		expect(root.style.getPropertyValue('--as-accent')).toBe('#abcdef');
	});

	it('picking a different device sets it optimistically, calls the backend, then re-refreshes', async () => {
		const { container } = render(<AudioSwitcherHost />);
		await waitFor(() => expect(container.querySelectorAll('.as-row').length).toBe(2));
		listAudioOutputs.mockClear();
		getDefaultAudioOutput.mockClear();

		// After the switch the backend reports the new default so the active marker stays on Headphones.
		getDefaultAudioOutput.mockResolvedValue('hp');

		await act(async () => {
			fireEvent.click(rowByName(container, 'Headphones'));
		});

		expect(setDefaultAudioOutput).toHaveBeenCalledWith('hp');
		// refresh() re-runs after the switch.
		expect(listAudioOutputs).toHaveBeenCalled();
		expect(getDefaultAudioOutput).toHaveBeenCalled();
		await waitFor(() =>
			expect(rowByName(container, 'Headphones').getAttribute('data-active')).toBe('true')
		);
	});

	it('clicking the already-default row is a no-op (no backend call)', async () => {
		const { container } = render(<AudioSwitcherHost />);
		await waitFor(() => expect(container.querySelectorAll('.as-row').length).toBe(2));
		await act(async () => {
			fireEvent.click(rowByName(container, 'Speakers')); // 'spk' === currentId
		});
		expect(setDefaultAudioOutput).not.toHaveBeenCalled();
	});

	it('warns and lets refresh restore the real default when the switch fails', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		setDefaultAudioOutput.mockResolvedValue(false);
		const { container } = render(<AudioSwitcherHost />);
		await waitFor(() => expect(container.querySelectorAll('.as-row').length).toBe(2));

		await act(async () => {
			fireEvent.click(rowByName(container, 'Headphones'));
		});

		expect(setDefaultAudioOutput).toHaveBeenCalledWith('hp');
		expect(warn).toHaveBeenCalledWith('audio switch failed; reverted to the real default');
	});

	it('ignores an older refresh that resolves after a newer focus refresh', async () => {
		let resolveOld!: (id: string | null) => void;
		let resolveNew!: (id: string | null) => void;
		getDefaultAudioOutput
			.mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
			.mockImplementationOnce(() => new Promise((resolve) => (resolveNew = resolve)));
		const { container } = render(<AudioSwitcherHost />);
		fireEvent(window, new Event('focus'));
		await act(async () => resolveNew('hp'));
		await waitFor(() =>
			expect(rowByName(container, 'Headphones').getAttribute('data-active')).toBe('true')
		);
		await act(async () => resolveOld('spk'));
		expect(rowByName(container, 'Headphones').getAttribute('data-active')).toBe('true');
	});

	it('disables every row and ignores repeated picks while a switch is pending', async () => {
		let resolveSwitch!: (ok: boolean) => void;
		setDefaultAudioOutput.mockImplementation(
			() => new Promise((resolve) => (resolveSwitch = resolve))
		);
		const { container } = render(<AudioSwitcherHost />);
		await waitFor(() => expect(container.querySelectorAll('.as-row')).toHaveLength(2));
		fireEvent.click(rowByName(container, 'Headphones'));
		expect(
			[...container.querySelectorAll<HTMLButtonElement>('.as-row')].every((row) => row.disabled)
		).toBe(true);
		fireEvent.click(rowByName(container, 'Headphones'));
		expect(setDefaultAudioOutput).toHaveBeenCalledTimes(1);
		await act(async () => resolveSwitch(true));
	});

	it('re-polls on window focus and on the interval tick, and stops after unmount (alive guard)', async () => {
		vi.useFakeTimers();
		const { unmount } = render(<AudioSwitcherHost />);
		// Mount poll.
		expect(listAudioOutputs).toHaveBeenCalledTimes(1);
		await act(async () => undefined); // let the mount refresh settle

		// A focus event triggers a refresh.
		listAudioOutputs.mockClear();
		await act(async () => {
			window.dispatchEvent(new Event('focus'));
		});
		expect(listAudioOutputs).toHaveBeenCalledTimes(1);

		// An interval tick triggers a refresh while alive.
		listAudioOutputs.mockClear();
		await act(async () => {
			vi.advanceTimersByTime(8000); // REFRESH_MS
		});
		expect(listAudioOutputs).toHaveBeenCalledTimes(1);

		// After unmount the focus listener is removed and the interval is cleared.
		unmount();
		listAudioOutputs.mockClear();
		await act(async () => {
			window.dispatchEvent(new Event('focus'));
			vi.advanceTimersByTime(16000);
		});
		expect(listAudioOutputs).not.toHaveBeenCalled();
	});

	it('a stray interval tick after teardown is swallowed by the alive guard', async () => {
		const setIntervalSpy = vi.spyOn(window, 'setInterval');
		const { unmount } = render(<AudioSwitcherHost />);
		await act(async () => undefined); // settle the mount refresh
		const tick = setIntervalSpy.mock.calls.at(-1)?.[0] as () => void;
		unmount();
		listAudioOutputs.mockClear();
		// clearInterval normally prevents this; if a queued tick slips through it must not refresh.
		tick();
		expect(listAudioOutputs).not.toHaveBeenCalled();
	});
});
