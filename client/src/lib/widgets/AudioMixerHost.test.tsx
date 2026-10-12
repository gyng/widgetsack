import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AudioMixerHost from './AudioMixerHost';
import { getAudioMixer, setAudioSession, setMicrophoneMute } from '../audio/mixer';
vi.mock('../audio/mixer', () => ({
	getAudioMixer: vi.fn(),
	setAudioSession: vi.fn(),
	setMicrophoneMute: vi.fn()
}));
const snapshot = {
	sessions: [{ id: 'session', name: 'Player', level: 0.5, muted: false }],
	microphone: { level: 1, muted: false }
};
beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(getAudioMixer).mockReset().mockResolvedValue(snapshot);
	vi.mocked(setAudioSession).mockReset().mockResolvedValue();
	vi.mocked(setMicrophoneMute).mockReset().mockResolvedValue();
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});
describe('audio mixer host', () => {
	it('lets a newer queued change supersede an older failed write', async () => {
		let reject!: (error: Error) => void;
		vi.mocked(setAudioSession).mockReturnValueOnce(
			new Promise((_r, rej) => {
				reject = rej;
			})
		);
		await act(async () => {
			render(<AudioMixerHost />);
		});
		vi.mocked(getAudioMixer).mockResolvedValue({
			...snapshot,
			sessions: [{ ...snapshot.sessions[0], level: 0.8 }]
		});
		fireEvent.change(screen.getByRole('slider'), { target: { value: '60' } });
		fireEvent.change(screen.getByRole('slider'), { target: { value: '80' } });
		await act(async () => reject(new Error('Old failure')));
		expect(screen.getByRole('slider')).toHaveValue('80');
		expect(screen.queryByRole('alert')).toBeNull();
	});
	it('ignores a write-refresh that completes after disposal', async () => {
		let finish!: (value: typeof snapshot) => void;
		await act(async () => {
			render(<AudioMixerHost />);
		});
		vi.mocked(getAudioMixer).mockReturnValueOnce(
			new Promise((r) => {
				finish = r;
			})
		);
		await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Mute mic' })));
		cleanup();
		await act(async () => finish(snapshot));
		expect(screen.queryByRole('region')).toBeNull();
	});
	it('restores the last confirmed level when a slider write fails', async () => {
		await act(async () => {
			render(<AudioMixerHost />);
		});
		vi.mocked(setAudioSession).mockRejectedValueOnce(new Error('Device unavailable'));
		await act(async () =>
			fireEvent.change(screen.getByRole('slider'), { target: { value: '80' } })
		);
		expect(screen.getByRole('slider')).toHaveValue('50');
		expect(screen.getByRole('alert')).toHaveTextContent('Device unavailable');
	});
	it('coalesces slider changes and suppresses polling until writes finish', async () => {
		let finish!: () => void;
		vi.mocked(setAudioSession).mockReturnValueOnce(
			new Promise((r) => {
				finish = r;
			})
		);
		vi.mocked(getAudioMixer).mockResolvedValue({
			...snapshot,
			sessions: [...snapshot.sessions, { id: 'other', name: 'Other', level: 0.3, muted: false }]
		});
		await act(async () => {
			render(<AudioMixerHost />);
		});
		fireEvent.change(screen.getByRole('slider', { name: 'Player volume' }), {
			target: { value: '60' }
		});
		fireEvent.change(screen.getByRole('slider', { name: 'Player volume' }), {
			target: { value: '70' }
		});
		fireEvent.change(screen.getByRole('slider', { name: 'Player volume' }), {
			target: { value: '80' }
		});
		expect(screen.getByRole('slider', { name: 'Player volume' })).toHaveValue('80');
		expect(screen.getByLabelText('Player volume level')).toHaveTextContent('80%');
		await act(async () => vi.advanceTimersByTimeAsync(3000));
		expect(getAudioMixer).toHaveBeenCalledOnce();
		await act(async () => finish());
		expect(setAudioSession).toHaveBeenCalledTimes(2);
		expect(setAudioSession).toHaveBeenLastCalledWith('session', 0.8, null);
	});
	it('ignores stale poll errors after a write and after disposal', async () => {
		let reject!: (e: Error) => void;
		await act(async () => {
			render(<AudioMixerHost />);
		});
		vi.mocked(getAudioMixer).mockReturnValueOnce(
			new Promise((_r, rej) => {
				reject = rej;
			})
		);
		await act(async () => vi.advanceTimersByTimeAsync(3000));
		await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Mute mic' })));
		await act(async () => reject(new Error('stale')));
		expect(screen.queryByRole('alert')).toBeNull();
		vi.mocked(getAudioMixer).mockReturnValueOnce(
			new Promise((_r, rej) => {
				reject = rej;
			})
		);
		await act(async () => vi.advanceTimersByTimeAsync(3000));
		cleanup();
		await act(async () => reject(new Error('disposed')));
		expect(screen.queryByRole('alert')).toBeNull();
	});
	it('discards queued operations and feedback on disposal', async () => {
		let finish!: () => void;
		vi.mocked(setAudioSession).mockReturnValueOnce(
			new Promise((r) => {
				finish = r;
			})
		);
		await act(async () => {
			render(<AudioMixerHost />);
		});
		fireEvent.change(screen.getByRole('slider'), { target: { value: '60' } });
		fireEvent.change(screen.getByRole('slider'), { target: { value: '80' } });
		cleanup();
		await act(async () => finish());
		expect(setAudioSession).toHaveBeenCalledOnce();
		expect(getAudioMixer).toHaveBeenCalledOnce();
	});
	it('does not show a write failure after disposal', async () => {
		let reject!: (e: Error) => void;
		vi.mocked(setMicrophoneMute).mockReturnValueOnce(
			new Promise((_r, rej) => {
				reject = rej;
			})
		);
		await act(async () => {
			render(<AudioMixerHost />);
		});
		fireEvent.click(screen.getByRole('button', { name: 'Mute mic' }));
		cleanup();
		await act(async () => reject(new Error('disposed')));
		expect(screen.queryByRole('alert')).toBeNull();
	});
	it('writes the targeted session, mute, and microphone then refreshes', async () => {
		await act(async () => {
			render(<AudioMixerHost />);
		});
		await act(async () =>
			fireEvent.change(screen.getByRole('slider'), { target: { value: '75' } })
		);
		expect(setAudioSession).toHaveBeenCalledWith('session', 0.75, null);
		await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Player mute' })));
		expect(setAudioSession).toHaveBeenCalledWith('session', null, true);
		await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Mute mic' })));
		expect(setMicrophoneMute).toHaveBeenCalledWith(true);
	});
	it('does not let an old poll overwrite the result of a newer write', async () => {
		let old!: (v: typeof snapshot) => void;
		await act(async () => {
			render(<AudioMixerHost />);
		});
		vi.mocked(getAudioMixer)
			.mockReturnValueOnce(
				new Promise((r) => {
					old = r;
				})
			)
			.mockResolvedValue({ ...snapshot, sessions: [{ ...snapshot.sessions[0], level: 0.8 }] });
		await act(async () => vi.advanceTimersByTimeAsync(3000));
		await act(async () =>
			fireEvent.change(screen.getByRole('slider'), { target: { value: '80' } })
		);
		await act(async () => old(snapshot));
		expect(screen.getByRole('slider')).toHaveValue('80');
	});
	it('reports read/write errors, pauses hidden polls, and keeps edit mode passive', async () => {
		vi.mocked(getAudioMixer).mockRejectedValueOnce(new Error('Unavailable'));
		const view = render(<AudioMixerHost />);
		await act(async () => {});
		expect(screen.getByRole('alert')).toHaveTextContent('Unavailable');
		await act(async () => vi.advanceTimersByTimeAsync(3000));
		vi.mocked(setAudioSession).mockRejectedValueOnce(new Error('Session ended'));
		await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Player mute' })));
		expect(screen.getByRole('alert')).toHaveTextContent('Session ended');
		const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		const count = vi.mocked(getAudioMixer).mock.calls.length;
		await act(async () => vi.advanceTimersByTimeAsync(3000));
		expect(getAudioMixer).toHaveBeenCalledTimes(count);
		hidden.mockReturnValue('visible');
		await act(async () => document.dispatchEvent(new Event('visibilitychange')));
		view.rerender(<AudioMixerHost editMode />);
		expect(screen.getByRole('slider')).toBeDisabled();
		fireEvent.change(screen.getByRole('slider'), { target: { value: '30' } });
		expect(setAudioSession).toHaveBeenCalledTimes(1);
		view.rerender(<AudioMixerHost previewMode />);
		fireEvent.change(screen.getByRole('slider'), { target: { value: '40' } });
		expect(setAudioSession).toHaveBeenCalledTimes(1);
	});
	it('suppresses updates and further polls after disposal', async () => {
		let finish!: (v: typeof snapshot) => void;
		vi.mocked(getAudioMixer).mockReturnValue(
			new Promise((r) => {
				finish = r;
			})
		);
		const view = render(<AudioMixerHost />);
		await act(async () => vi.advanceTimersByTimeAsync(9000));
		expect(getAudioMixer).toHaveBeenCalledOnce();
		view.unmount();
		await act(async () => finish(snapshot));
		await act(async () => vi.advanceTimersByTimeAsync(3000));
		expect(getAudioMixer).toHaveBeenCalledOnce();
	});
});
