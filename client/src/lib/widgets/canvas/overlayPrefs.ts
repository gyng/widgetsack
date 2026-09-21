// Small localStorage-backed overlay rendering preferences, shared across same-origin windows
// (studio writes them in Settings; overlays read them). Currently just taskbar awareness: respect
// the monitor work area (don't draw over the taskbar) vs cover the full monitor. Reactive to writes
// in other windows via the 'storage' event. Pure read/write helpers are unit-tested.

import { useEffect, useState } from 'react';

import { readJson, writeJson } from '../../../stores/persist';

const KEY = 'widgetsack.overlay.prefs';

// The overlay's window z-order:
//   'bottom'    — always-on-bottom (the DEFAULT): widgets sit BELOW application windows (but above
//                 the desktop icons; Show Desktop / Win+D hides them). Frontend-only (setAlwaysOnBottom).
//   'top'       — always-on-top: widgets float above every window.
//   'wallpaper' — parented to the desktop's WorkerW so widgets render ON the wallpaper, behind the
//                 icons, surviving Show Desktop. EXPERIMENTAL + Windows-only (a native SetParent).
export type OverlayLayer = 'top' | 'bottom' | 'wallpaper';

export type OverlayPrefs = {
	// true (default): the flow layout fills the monitor WORK AREA (excludes the taskbar);
	// false: it fills the whole monitor (draws over the taskbar).
	respectWorkArea: boolean;
	// Where the overlay sits in the window z-order (see OverlayLayer). Default 'bottom'.
	overlayLayer: OverlayLayer;
	// DEBUG: render overlays as ordinary decorated, interactive, alt-tab-able windows (opaque
	// background, taskbar-present, not topmost, not click-through). Off by default. Makes a crashing
	// or misbehaving overlay visible, clickable (e.g. its "Reload" page), and inspectable — the
	// borderless click-through overlay otherwise hides all of that. Persisted so it survives the
	// reload you use to reproduce a crash.
	debugWindowed: boolean;
	// Developer mode (Settings → Diagnostics): shows node/widget ids in the studio and the devtools
	// items (inspect this window, …) that are noise for everyone else. Off by default.
	developerMode: boolean;
};

export const OVERLAY_PREF_DEFAULTS: OverlayPrefs = {
	respectWorkArea: true,
	overlayLayer: 'bottom',
	debugWindowed: false,
	developerMode: false
};

export function readOverlayPrefs(): OverlayPrefs {
	const raw = readJson(KEY);
	if (!raw) return OVERLAY_PREF_DEFAULTS;
	return { ...OVERLAY_PREF_DEFAULTS, ...(raw as Partial<OverlayPrefs>) };
}

export function writeOverlayPrefs(p: OverlayPrefs): void {
	writeJson(KEY, p);
}

// Current overlay prefs + a patch setter; re-renders this window when ANY same-origin window writes.
export function useOverlayPrefs(): [OverlayPrefs, (patch: Partial<OverlayPrefs>) => void] {
	const [prefs, setPrefs] = useState<OverlayPrefs>(() => readOverlayPrefs());
	useEffect(() => {
		const onStorage = (e: StorageEvent) => {
			if (e.key === KEY) setPrefs(readOverlayPrefs());
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	}, []);
	const update = (patch: Partial<OverlayPrefs>) => {
		const next = { ...readOverlayPrefs(), ...patch };
		writeOverlayPrefs(next);
		setPrefs(next);
	};
	return [prefs, update];
}
