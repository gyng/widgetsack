import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
	OVERLAY_PREF_DEFAULTS,
	readOverlayPrefs,
	useOverlayPrefs,
	writeOverlayPrefs
} from './overlayPrefs';

describe('overlayPrefs', () => {
	beforeEach(() => localStorage.clear());

	it('defaults to respecting the work area, a below-windows (bottom) layer, and no debug windowed mode', () => {
		expect(readOverlayPrefs()).toEqual({
			respectWorkArea: true,
			overlayLayer: 'bottom',
			debugWindowed: false
		});
		expect(OVERLAY_PREF_DEFAULTS).toEqual({
			respectWorkArea: true,
			overlayLayer: 'bottom',
			debugWindowed: false
		});
	});

	it('round-trips written values', () => {
		writeOverlayPrefs({ respectWorkArea: false, overlayLayer: 'wallpaper', debugWindowed: true });
		expect(readOverlayPrefs()).toEqual({
			respectWorkArea: false,
			overlayLayer: 'wallpaper',
			debugWindowed: true
		});
	});

	it('falls back to defaults on malformed storage', () => {
		localStorage.setItem('widgetsack.overlay.prefs', '{not json');
		expect(readOverlayPrefs()).toEqual({
			respectWorkArea: true,
			overlayLayer: 'bottom',
			debugWindowed: false
		});
	});

	it('merges defaults for missing keys (old prefs without overlayLayer/debugWindowed)', () => {
		localStorage.setItem('widgetsack.overlay.prefs', JSON.stringify({ respectWorkArea: false }));
		expect(readOverlayPrefs()).toEqual({
			respectWorkArea: false,
			overlayLayer: 'bottom',
			debugWindowed: false
		});
	});
});

describe('useOverlayPrefs', () => {
	beforeEach(() => localStorage.clear());

	it('seeds from storage and patches persist + re-render', () => {
		const { result } = renderHook(() => useOverlayPrefs());
		expect(result.current[0]).toEqual(OVERLAY_PREF_DEFAULTS);

		act(() => result.current[1]({ overlayLayer: 'top' }));
		expect(result.current[0].overlayLayer).toBe('top');
		// Other keys untouched and the patch was written to storage.
		expect(result.current[0].respectWorkArea).toBe(true);
		expect(readOverlayPrefs().overlayLayer).toBe('top');
	});

	it('a patch merges over the latest persisted value, not stale state', () => {
		const { result } = renderHook(() => useOverlayPrefs());
		// Another window writes directly to storage between renders.
		writeOverlayPrefs({ respectWorkArea: false, overlayLayer: 'wallpaper', debugWindowed: true });
		act(() => result.current[1]({ debugWindowed: false }));
		expect(result.current[0]).toEqual({
			respectWorkArea: false,
			overlayLayer: 'wallpaper',
			debugWindowed: false
		});
	});

	it('reacts to a storage event for the prefs key from another window', () => {
		const { result } = renderHook(() => useOverlayPrefs());
		writeOverlayPrefs({ respectWorkArea: false, overlayLayer: 'top', debugWindowed: true });
		act(() => {
			window.dispatchEvent(new StorageEvent('storage', { key: 'widgetsack.overlay.prefs' }));
		});
		expect(result.current[0]).toEqual({
			respectWorkArea: false,
			overlayLayer: 'top',
			debugWindowed: true
		});
	});

	it('ignores storage events for other keys', () => {
		const { result } = renderHook(() => useOverlayPrefs());
		writeOverlayPrefs({ respectWorkArea: false, overlayLayer: 'top', debugWindowed: true });
		act(() => {
			window.dispatchEvent(new StorageEvent('storage', { key: 'some.other.key' }));
		});
		// Unchanged — the hook didn't re-read for an unrelated key.
		expect(result.current[0]).toEqual(OVERLAY_PREF_DEFAULTS);
	});

	it('detaches the storage listener on unmount', () => {
		const { result, unmount } = renderHook(() => useOverlayPrefs());
		unmount();
		writeOverlayPrefs({ respectWorkArea: false, overlayLayer: 'top', debugWindowed: true });
		act(() => {
			window.dispatchEvent(new StorageEvent('storage', { key: 'widgetsack.overlay.prefs' }));
		});
		// No throw / no update after unmount; the captured snapshot is still the default.
		expect(result.current[0]).toEqual(OVERLAY_PREF_DEFAULTS);
	});
});
