import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

// Stub the Tauri-backed media source; resolve a known MediaCaps for an active source so the
// capabilities grid renders, and null for no source (mirrors the off-Windows / no-session case).
vi.mock('../../components/NowPlaying/source', () => ({
	startMediaSource: () => undefined,
	getMediaCapabilities: vi.fn((source?: string) =>
		Promise.resolve(
			source
				? {
						play: true,
						pause: true,
						playpause: true,
						stop: false,
						next: true,
						previous: true,
						shuffle: false,
						repeat: false,
						seek: true
				  }
				: null
		)
	)
}));
vi.mock('../../overlay', () => ({ copyToClipboard: vi.fn(() => Promise.resolve(true)) }));

import NowPlayingSettings from './NowPlayingSettings';
import { defaultState, mediaStore, type SessionRecord } from '../../../stores/stores';
import { copyToClipboard } from '../../overlay';

const session = (source: string, title: string): SessionRecord => ({
	session_id: 1,
	source,
	timestamp_created: null,
	timestamp_updated: null,
	last_media_update: {
		Media: [
			{
				source,
				playback: {
					auto_repeat: 'None',
					rate: 1,
					shuffle: false,
					status: 'Playing',
					type: 'Music'
				},
				timeline: { start: 0, end: 100, position: 25, last_updated_at_ms: 0 },
				media: {
					album: null,
					artist: 'A',
					genres: [],
					playback_type: 'Music',
					subtitle: '',
					title,
					track_number: null
				}
			},
			null
		]
	},
	last_model_update: { Model: { playback: null, timeline: null, media: null, source: '' } }
});

beforeEach(() => {
	vi.clearAllMocks();
	mediaStore.set({
		...defaultState,
		sourcePriority: '',
		ignoreList: 'blocked',
		sessions: { 1: session('spotify.exe', 'Track'), 2: session('blocked.exe', 'Nope') }
	});
});

describe('NowPlayingSettings', () => {
	it('renders the editable lists + the live bindable-sensor values', async () => {
		const { container, getByText, findByText } = render(<NowPlayingSettings />);
		expect(container.querySelectorAll('textarea').length).toBe(2); // priority + ignore
		// np.* live values reflect the active (non-ignored) session.
		expect(getByText('np.title')).toBeTruthy();
		expect(getByText('Track')).toBeTruthy();
		expect(getByText('np.progress')).toBeTruthy();
		// Capabilities grid appears once the (mocked) query resolves.
		const seekCap = await findByText(/seek/);
		expect(seekCap.textContent).toContain('✓');
		expect(getByText(/stop/).textContent).toContain('✗');
	});

	it('normalizes list input to lowercase on blur (not per keystroke)', () => {
		const { container } = render(<NowPlayingSettings />);
		const ignore = container.querySelectorAll('textarea')[1];
		fireEvent.change(ignore, { target: { value: 'FooBar2000' } });
		expect(mediaStore.getSnapshot().ignoreList).toBe('FooBar2000'); // raw until blur
		fireEvent.blur(ignore);
		expect(mediaStore.getSnapshot().ignoreList).toBe('foobar2000');
	});

	it('disables the ＋ignore button for an already-ignored source', () => {
		const { getByLabelText } = render(<NowPlayingSettings />);
		expect(
			(getByLabelText('Add blocked.exe to the ignore list') as HTMLButtonElement).disabled
		).toBe(true);
		expect(
			(getByLabelText('Add spotify.exe to the ignore list') as HTMLButtonElement).disabled
		).toBe(false);
	});

	it('requires two clicks to reset (guards against an accidental wipe)', () => {
		mediaStore.set({ ...mediaStore.getSnapshot(), sourcePriority: 'zzz' });
		const { container } = render(<NowPlayingSettings />);
		const reset = container.querySelector('.rp-danger') as HTMLButtonElement;
		fireEvent.click(reset);
		expect(mediaStore.getSnapshot().sourcePriority).toBe('zzz'); // armed, not yet reset
		fireEvent.click(reset);
		expect(mediaStore.getSnapshot().sourcePriority).toBe(defaultState.sourcePriority);
	});

	it('removes an ignore entry via its row ✕ button', () => {
		const { getByLabelText } = render(<NowPlayingSettings />); // beforeEach: ignoreList = 'blocked'
		fireEvent.click(getByLabelText('Remove blocked from the ignore list'));
		expect(mediaStore.getSnapshot().ignoreList).toBe('');
	});

	it('reorders the priority list with the ↑ button', () => {
		mediaStore.set({ ...mediaStore.getSnapshot(), sourcePriority: 'a\nb\nc' });
		const { getByLabelText } = render(<NowPlayingSettings />);
		fireEvent.click(getByLabelText('Move b up'));
		expect(mediaStore.getSnapshot().sourcePriority).toBe('b\na\nc');
	});

	it('retains a collapsed raw-text fallback per list (for an app that is not running)', () => {
		const { container } = render(<NowPlayingSettings />);
		expect(container.querySelectorAll('details.nps-raw').length).toBe(2);
	});

	it('formats a fractional scalar sensor to one decimal place', () => {
		// position 1 / end 3 → progress 33.333… → np.progress reads "33.3" (the toFixed(1) arm).
		const s = session('spotify.exe', 'Track');
		const model = s.last_media_update.Media![0]!;
		model.timeline = { start: 0, end: 3, position: 1, last_updated_at_ms: 0 };
		mediaStore.set({ ...defaultState, sourcePriority: '', ignoreList: '', sessions: { 1: s } });
		const { container } = render(<NowPlayingSettings />);
		const rows = Array.from(container.querySelectorAll('.nps-sensor'));
		const progress = rows.find(
			(r) => r.querySelector('.nps-sensor-id')?.textContent === 'np.progress'
		);
		expect(progress?.querySelector('.nps-sensor-val')?.textContent).toBe('33.3');
	});

	it('reorders the priority list by drag-and-drop', () => {
		mediaStore.set({ ...mediaStore.getSnapshot(), sourcePriority: 'a\nb\nc' });
		const { container } = render(<NowPlayingSettings />);
		const rows = container.querySelectorAll('ul[aria-label="Source priority order"] li');
		// Drag the first row (a) onto the third (c).
		fireEvent.dragStart(rows[0]);
		fireEvent.dragOver(rows[2]);
		fireEvent.drop(rows[2]);
		expect(mediaStore.getSnapshot().sourcePriority).toBe('b\nc\na');
	});

	it('ignores a drop onto the same row (no reorder)', () => {
		mediaStore.set({ ...mediaStore.getSnapshot(), sourcePriority: 'a\nb\nc' });
		const { container } = render(<NowPlayingSettings />);
		const rows = container.querySelectorAll('ul[aria-label="Source priority order"] li');
		fireEvent.dragStart(rows[1]);
		fireEvent.dragOver(rows[1]);
		fireEvent.drop(rows[1]); // same index → early return, list unchanged
		fireEvent.dragEnd(rows[1]); // clears the recorded drag origin (rows stay attached here)
		expect(mediaStore.getSnapshot().sourcePriority).toBe('a\nb\nc');
	});

	it('does nothing on a drop without a recorded drag origin', () => {
		mediaStore.set({ ...mediaStore.getSnapshot(), sourcePriority: 'a\nb\nc' });
		const { container } = render(<NowPlayingSettings />);
		const rows = container.querySelectorAll('ul[aria-label="Source priority order"] li');
		fireEvent.drop(rows[2]); // dragIndex.current is null → early return
		expect(mediaStore.getSnapshot().sourcePriority).toBe('a\nb\nc');
	});

	it('moves a priority entry down and removes one', () => {
		mediaStore.set({ ...mediaStore.getSnapshot(), sourcePriority: 'a\nb\nc' });
		const { getByLabelText } = render(<NowPlayingSettings />);
		fireEvent.click(getByLabelText('Move a down'));
		expect(mediaStore.getSnapshot().sourcePriority).toBe('b\na\nc');
		fireEvent.click(getByLabelText('Remove a from priority'));
		expect(mediaStore.getSnapshot().sourcePriority).toBe('b\nc');
	});

	it('edits the priority list as text and normalizes on blur', () => {
		mediaStore.set({ ...mediaStore.getSnapshot(), sourcePriority: 'a' });
		const { container } = render(<NowPlayingSettings />);
		const priority = container.querySelectorAll('textarea')[0];
		fireEvent.change(priority, { target: { value: 'X\nY' } });
		expect(mediaStore.getSnapshot().sourcePriority).toBe('X\nY'); // raw until blur
		fireEvent.blur(priority);
		expect(mediaStore.getSnapshot().sourcePriority).toBe('x\ny');
	});

	it('quick-adds a detected source to the priority and ignore lists', () => {
		mediaStore.set({ ...mediaStore.getSnapshot(), sourcePriority: '', ignoreList: '' });
		const { getByLabelText } = render(<NowPlayingSettings />);
		fireEvent.click(getByLabelText('Add spotify.exe to the priority list'));
		expect(mediaStore.getSnapshot().sourcePriority).toBe('spotify.exe');
		fireEvent.click(getByLabelText('Add spotify.exe to the ignore list'));
		expect(mediaStore.getSnapshot().ignoreList).toContain('spotify.exe');
	});

	it('flags the now-showing source with a NOW badge', () => {
		const { container } = render(<NowPlayingSettings />); // spotify.exe is the active session
		const now = container.querySelector('.nps-badge-now');
		expect(now?.textContent).toBe('NOW');
	});

	it('copies a live sensor id to the clipboard', () => {
		const { getByLabelText } = render(<NowPlayingSettings />);
		fireEvent.click(getByLabelText('Copy sensor id np.title'));
		expect(copyToClipboard).toHaveBeenCalledWith('np.title');
	});

	it('shows the empty-state hint when no media source is detected', () => {
		mediaStore.set({ ...defaultState, sourcePriority: '', ignoreList: '', sessions: {} });
		const { getByText } = render(<NowPlayingSettings />);
		expect(getByText(/No media sources detected yet/)).toBeTruthy();
	});

	it('shows "No active session." when nothing is playing (caps unresolved)', () => {
		mediaStore.set({ ...defaultState, sourcePriority: '', ignoreList: '', sessions: {} });
		const { getByText } = render(<NowPlayingSettings />);
		// No session → getMediaCapabilities is still pending/empty in the no-session branch.
		expect(getByText('No active session.')).toBeTruthy();
	});
});
