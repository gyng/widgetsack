// Init is NON-IDEMPOTENT (item 4): on mount run updateWorkArea + startAllSources(hub) + reloadLayout
// + listen(layout_changed/themes_changed/toggle_edit/open_studio) + (primary) fill/reconcile. The
// cleanup MUST call every UnlistenFn + the source stop + clearPreviewWrite. A `cancelled` flag
// guards the async unsubscribe-after-unmount race. Assumes NO React.StrictMode — this runs once.
// Ported verbatim from the Svelte onMount/onDestroy pair (same Tauri event/command strings).
import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { EVENTS } from '../../bridge/contract';
import { startAllSources } from '../../core/plugin';
import type { TelemetryHub } from '../../core/telemetry';
import {
	fillOwnMonitor,
	fillPrimaryMonitor,
	listThemes,
	logClient,
	monitorParam,
	openStudio,
	setMainWindowVisible,
	studioMonitorOptions,
	watchDisplayChanges
} from '../../overlay';
import type { MonitorOption } from './types';

export type StudioInitDeps = {
	studio: boolean;
	hub: TelemetryHub;
	updateWorkArea: () => Promise<void>;
	reloadLayout: () => Promise<void>;
	reloadControls: () => Promise<void>; // load control remaps (startup + controls_changed)
	editMode: () => boolean; // for the layout_changed guard
	syncRects: () => void;
	syncPrimaryOverlays: () => Promise<void>;
	applyTheme: () => Promise<void>;
	setThemeList: (t: string[]) => void;
	setEdit: (v: boolean) => void;
	setEditModeImmediate: () => void; // studio: editMode = true (no click-through round-trip)
	setMonitorOptions: (o: MonitorOption[]) => void;
	clearPreviewWrite: () => void;
};

export function useStudioInit(deps: StudioInitDeps): void {
	// Hold deps in a ref so the mount effect reads the latest callbacks without re-running. Mirrored in
	// a commit effect (before the mount effect below, which only reads d.current from async callbacks).
	const d = useRef(deps);
	useEffect(() => {
		d.current = deps;
	});

	useEffect(() => {
		let cancelled = false;
		let sourceStop: (() => void) | undefined;
		let unlistenLayout: UnlistenFn | undefined;
		let unlistenControls: UnlistenFn | undefined;
		let unlistenThemes: UnlistenFn | undefined;
		let unlistenStudio: UnlistenFn | undefined;
		let unlistenEdit: UnlistenFn | undefined;
		let unlistenRefit: UnlistenFn | undefined;
		let stopDisplayWatch: (() => void) | undefined;

		(async () => {
			const dep = d.current;
			// A secondary overlay (?monitor=<key>) fits + reveals ITSELF before anything else. The
			// spawn-side `tauri://created` setup in reconcileOverlays runs in the creating window's JS
			// context and dies with it when an empty-primary `main` self-destructs (renderer reclaim)
			// right after spawning us — which left the overlay permanently invisible. Running first also
			// means the work-area read below sees the window on its real monitor, not wherever the
			// window-state plugin parked it.
			const ownKey = dep.studio ? null : monitorParam();
			if (ownKey) await fillOwnMonitor(ownKey);

			// Re-fit this window to the CURRENT display layout — on the tray "Re-fit overlays" trigger AND
			// automatically when monitors are moved/added/removed at runtime (no per-window scale-change
			// event fires for that, so an overlay otherwise stays anchored to stale coordinates and clips).
			// Each role re-runs its own fit: a secondary re-fits itself, the primary re-fits + reconciles
			// its overlays, the studio refreshes its monitor list.
			const refit = async (): Promise<void> => {
				if (dep.studio) {
					d.current.setMonitorOptions(await studioMonitorOptions());
				} else if (ownKey) {
					await fillOwnMonitor(ownKey);
				} else {
					await fillPrimaryMonitor();
					await d.current.syncPrimaryOverlays();
				}
			};
			unlistenRefit = await listen(EVENTS.refitOverlays, () => void refit());
			stopDisplayWatch = watchDisplayChanges(() => void refit());
			if (cancelled) {
				unlistenRefit?.();
				stopDisplayWatch?.();
				return;
			}

			await dep.updateWorkArea();
			sourceStop = await startAllSources(dep.hub); // built-in `system` + any plugin sources
			if (cancelled) {
				sourceStop?.();
				return;
			}
			await dep.reloadLayout();

			// Control remaps (controls.json): load once, then live-reload on external edits or a save
			// from another window. Always applied (not gated by editMode) — a remap should take effect
			// immediately everywhere.
			await dep.reloadControls();
			unlistenControls = await listen(EVENTS.controlsChanged, () => d.current.reloadControls());

			// Live-reload external edits to widgets.json (ignored while actively editing). On the
			// primary main window, also reconcile overlays + own visibility as monitors gain/lose widgets.
			unlistenLayout = await listen(EVENTS.layoutChanged, () => {
				if (d.current.editMode()) return;
				d.current.reloadLayout().then(() => {
					d.current.syncRects();
					if (!monitorParam()) d.current.syncPrimaryOverlays();
				});
			});
			if (cancelled) {
				unlistenControls?.();
				unlistenLayout?.();
				return;
			}

			// Themes: list them + live-reload the active theme when the folder changes.
			const themes = await listThemes();
			if (cancelled) {
				unlistenControls?.();
				unlistenLayout?.();
				return;
			}
			d.current.setThemeList(themes);
			unlistenThemes = await listen(EVENTS.themesChanged, () => {
				d.current.applyTheme();
				listThemes().then((t) => d.current.setThemeList(t));
			});
			if (cancelled) {
				unlistenControls?.();
				unlistenLayout?.();
				unlistenThemes?.();
				return;
			}

			if (dep.studio) {
				dep.setEditModeImmediate(); // the studio is always an editor; no overlay fill/click-through
				const opts = await studioMonitorOptions();
				if (cancelled) {
					unlistenControls?.();
					unlistenLayout?.();
					unlistenThemes?.();
					return;
				}
				d.current.setMonitorOptions(opts);
				return;
			}

			// The main window covers the PRIMARY monitor (rendering the `default` key) and opens
			// overlays on every other monitor.
			if (!monitorParam()) {
				await fillPrimaryMonitor();
				await dep.syncPrimaryOverlays();
				unlistenStudio = await listen(EVENTS.openStudio, () => openStudio());
			}
			if (cancelled) {
				unlistenControls?.();
				unlistenLayout?.();
				unlistenThemes?.();
				unlistenStudio?.();
				return;
			}
			// Initial whole-window click-through is established by Canvas's presentation effect (so the
			// main overlay starts interactive and a secondary starts click-through); here we only seed the
			// per-widget interactive rects for a passive overlay.
			d.current.syncRects();
			unlistenEdit = await listen(EVENTS.toggleEdit, () =>
				d.current.setEdit(!d.current.editMode())
			);
			if (cancelled) {
				unlistenControls?.();
				unlistenLayout?.();
				unlistenThemes?.();
				unlistenStudio?.();
				unlistenEdit?.();
			}
		})().catch((err) => {
			// The primary main window is born hidden (config `visible:false`) and only revealed once
			// init reaches `syncPrimaryOverlays`; a secondary is born hidden and reveals itself via
			// fillOwnMonitor. If init throws before the reveal, reveal anyway so a failure can never
			// strand a window permanently invisible (the old always-visible default). This catch is
			// the choke point for EVERY init failure — logClient it so it survives the webview.
			logClient(
				'error',
				'overlay',
				`init failed (${d.current.studio ? 'studio' : (monitorParam() ?? 'main')}): ${String(err)}`
			);
			if (!cancelled && !d.current.studio) {
				const key = monitorParam();
				if (key) void fillOwnMonitor(key);
				else void setMainWindowVisible(true).catch(() => undefined);
			}
		});

		return () => {
			cancelled = true;
			sourceStop?.();
			unlistenControls?.();
			unlistenLayout?.();
			unlistenThemes?.();
			unlistenStudio?.();
			unlistenEdit?.();
			unlistenRefit?.();
			stopDisplayWatch?.();
			d.current.clearPreviewWrite();
		};
		// Run once on mount (non-idempotent). The body reads only the stable `d` ref, so the empty dep
		// list is intentional and needs no exhaustive-deps suppression.
	}, []);
}
