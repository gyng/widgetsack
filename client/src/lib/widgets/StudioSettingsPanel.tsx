// Settings section (extracted from Canvas): the side tab list + one focused subsection at a time
// (Monitor / Overlay / Startup / Shortcuts / Diagnostics / About / Danger zone). Purely a panel —
// the prefs/handlers it surfaces stay owned by Canvas and arrive as grouped props; the only module
// calls it makes itself are the stateless overlay helpers (devtools / rescue / clipboard / launch at
// login). Lazy-loaded like the other studio panels (Canvas's lazy() block), so the overlay never
// fetches it. Every tab is a ≤640px form: label on the left, its control right beside it.
import { useEffect, useState } from 'react';
import type { Rect } from '../core/layout';
import type { ControlOverrides, Trigger } from '../core/controls';
import type { OverlayLayer, OverlayPrefs } from './canvas/overlayPrefs';
import {
	checkAppUpdate,
	copyToClipboard,
	isAutostartEnabled,
	openDevtools,
	rescueWindows,
	setAutostart
} from '../overlay';
import {
	appUpdateStore,
	getAppPrefs,
	openReleasePage,
	setUpdateCheck,
	useAppUpdate
} from '../appUpdate';
import { updateStatusLine } from '../core/updateNotice';
import ControlsPanel from './ControlsPanel';
import DiagnosticsPanel from './DiagnosticsPanel';
import Select from './Select';
import mascotUrl from '../../assets/mascot.png';
import './StudioSettingsPanel.css';

// The overlay's window layer, in the shared vocabulary (never "WorkerW" on screen). Both the picker
// and the "Current layer:" status line read from this one table.
const OVERLAY_LAYER_LABEL: Record<OverlayLayer, string> = {
	bottom: 'Below windows',
	top: 'Always on top',
	wallpaper: 'Behind desktop icons (experimental)'
};

export const OVERLAY_LAYER_OPTIONS: { value: OverlayLayer; label: string; hint?: string }[] = [
	{ value: 'bottom', label: OVERLAY_LAYER_LABEL.bottom, hint: 'default' },
	{ value: 'top', label: OVERLAY_LAYER_LABEL.top },
	{ value: 'wallpaper', label: OVERLAY_LAYER_LABEL.wallpaper }
];

export function overlayLayerLabel(layer: OverlayLayer): string {
	return OVERLAY_LAYER_LABEL[layer];
}

// About → Updates: the backend's background checker (update.rs) keeps the last result and pushes
// new ones; `useAppUpdate` mirrors that here so the tab shows "vX available — Open release page"
// without a click. "Check for updates" still runs an on-demand check (its result is pushed into the
// same store so the badge / tray agree). There is no auto-installer — opening the release page in
// the browser is the whole affordance. Local state is only the in-flight / error status.
type AppUpdateState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string };

function AppUpdateCheck() {
	const known = useAppUpdate();
	const [state, setState] = useState<AppUpdateState>({ kind: 'idle' });
	// The background check is opt-in (off by default): a periodic call to GitHub the user never
	// asked for. Read the persisted pref on mount; the toggle writes through and, when enabling,
	// the backend runs a check immediately.
	const [autoCheck, setAutoCheck] = useState<boolean | null>(null);
	useEffect(() => {
		let alive = true;
		getAppPrefs().then((p) => {
			if (alive) setAutoCheck(p.update_check);
		});
		return () => {
			alive = false;
		};
	}, []);
	const onToggleAuto = async (enabled: boolean) => {
		setAutoCheck(enabled); // optimistic
		try {
			setAutoCheck((await setUpdateCheck(enabled)).update_check);
		} catch (err) {
			setAutoCheck(!enabled);
			setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
		}
	};
	const onCheck = async () => {
		setState({ kind: 'busy' });
		try {
			appUpdateStore.set(await checkAppUpdate());
			setState({ kind: 'idle' });
		} catch (err) {
			setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
		}
	};
	return (
		<>
			<div className="rp-hd">Updates</div>
			<label className="rp-row set-check">
				<input
					type="checkbox"
					checked={autoCheck ?? false}
					disabled={autoCheck === null}
					onChange={(e) => void onToggleAuto(e.currentTarget.checked)}
					title="Off by default. When on, the app asks GitHub for the latest release every 6 hours and shows it in the tray and here. Nothing is downloaded or installed automatically."
				/>
				<span>check for updates automatically</span>
			</label>
			<div className="pl-desc">{updateStatusLine(known)}</div>
			{known?.updateAvailable && (
				<div className="set-row">
					<span className="set-label">v{known.latest} available</span>
					<span className="set-actions">
						<button
							type="button"
							onClick={() => void openReleasePage(known.url)}
							title="Open the release page in your browser (there is no auto-installer)"
						>
							↗ Open release page
						</button>{' '}
						<button type="button" onClick={() => void copyToClipboard(known.url)}>
							copy link
						</button>
					</span>
				</div>
			)}
			<button type="button" disabled={state.kind === 'busy'} onClick={() => void onCheck()}>
				{state.kind === 'busy' ? 'Checking…' : '⟳ Check for updates'}
			</button>
			{state.kind === 'error' && (
				<div className="pl-desc set-error" title={state.message}>
					Update check failed: {state.message}
				</div>
			)}
		</>
	);
}

// Startup → "launch at login". Self-contained (like AppUpdateCheck): reads the OS state on mount,
// toggles optimistically, then reconciles with the RE-READ state the helper returns — and when the
// write failed (a denied registry write, no plugin off-Windows, …) shows the reason under the box
// instead of silently reverting the tick.
function LaunchAtLogin() {
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let alive = true;
		isAutostartEnabled().then((r) => {
			if (!alive) return;
			setEnabled(r.enabled);
			setError(r.error);
		});
		return () => {
			alive = false;
		};
	}, []);
	const onToggle = async (next: boolean) => {
		setEnabled(next); // optimistic
		setError(null);
		const r = await setAutostart(next);
		setEnabled(r.enabled); // the re-read state: a denied write reverts the tick
		setError(r.error);
	};
	return (
		<>
			<label className="rp-row set-check">
				<input
					type="checkbox"
					checked={enabled ?? false}
					disabled={enabled === null}
					onChange={(e) => void onToggle(e.currentTarget.checked)}
				/>
				<span>launch at login</span>
			</label>
			{error && (
				<div className="pl-desc set-error" role="alert">
					Couldn’t change launch at login: {error}
				</div>
			)}
		</>
	);
}

// Settings subsections — a side list (mirrors the Plugins list+detail split) so the pane shows one
// focused topic at a time (progressive disclosure / chunking) instead of one long scroll, and each
// subsection carries a title + one-line purpose for orientation. Ordered safe → informational →
// destructive; 'danger' is set apart and coloured (error prevention). Ids are stable (Canvas state +
// e2e); only the labels follow the shared vocabulary ("Shortcuts", not "Controls").
export const SETTINGS_TABS = [
	{ id: 'display', label: 'Monitor' },
	{ id: 'overlay', label: 'Overlay' },
	{ id: 'startup', label: 'Startup' },
	{ id: 'controls', label: 'Shortcuts' },
	{ id: 'diagnostics', label: 'Diagnostics' },
	{ id: 'about', label: 'About' },
	{ id: 'danger', label: 'Danger zone' }
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];

type Props = {
	tab: SettingsTab;
	onTab: (tab: SettingsTab) => void;
	// Monitor tab: the monitor this layout drives + the theme + the stage view.
	display: {
		monName: string;
		monSize: { w: number; h: number };
		workArea: Rect;
		multiMonitor: boolean;
		zoom: number;
		fit: () => void;
	};
	// Theme: the all-monitors lock + the picker for the locked GLOBAL theme (or, when unlocked, this
	// monitor's own theme). `options` are pre-built {value,label} entries (default + built-ins + user).
	theme: {
		options: { value: string; label: string }[];
		selected: string;
		setTheme: (name: string) => void;
		lock: boolean;
		setLock: (lock: boolean) => void;
	};
	// Overlay: z-order/taskbar/developer prefs + the overlays' last layer-apply status line.
	overlay: {
		prefs: OverlayPrefs;
		setPrefs: (patch: Partial<OverlayPrefs>) => void;
		layerStatus: string;
	};
	// Shortcuts: pass-through props for ControlsPanel (the remap state lives in useControls).
	controls: {
		overrides: ControlOverrides;
		onRebind: (id: string, trigger: Trigger) => void;
		onReset: (id: string) => void;
		onResetAll: () => void;
	};
	appVersion: string | null;
	clearMonitor: () => void;
};

export default function StudioSettingsPanel({
	tab,
	onTab,
	display,
	theme,
	overlay,
	controls,
	appVersion,
	clearMonitor
}: Props) {
	const { monName, monSize, workArea, multiMonitor, zoom, fit } = display;
	const { prefs: overlayPrefs, setPrefs: setOverlayPrefs, layerStatus } = overlay;
	return (
		<div className="rail-panel plugins-panel settings-panel">
			<div className="pl-list">
				<div className="rp-hd">Settings</div>
				{SETTINGS_TABS.map((t) => (
					<button
						key={t.id}
						type="button"
						className={['pl-item', t.id === tab && 'cur', t.id === 'danger' && 'set-danger']
							.filter(Boolean)
							.join(' ')}
						onClick={() => onTab(t.id)}
					>
						{t.label}
					</button>
				))}
			</div>
			<div className="pl-detail">
				<div className="set-form">
					{tab === 'display' && (
						<>
							<div className="pl-title">Monitor</div>
							<div className="pl-desc">
								The monitor this layout drives — each monitor keeps its own layout.
							</div>
							<div className="rp-hd">
								{monName || '—'} · {monSize.w}×{monSize.h}
							</div>
							<div className="set-row">
								<span className="set-label">work area</span>
								<span className="dim">
									{Math.round(workArea.w)}×{Math.round(workArea.h)}
								</span>
							</div>
							{multiMonitor && (
								<div className="rp-stub">
									Move a widget to another monitor by right-clicking it → “Move to”.
								</div>
							)}
							<div className="rp-hd">Theme</div>
							<label className="rp-row set-check">
								<input
									type="checkbox"
									checked={theme.lock}
									onChange={(e) => theme.setLock(e.currentTarget.checked)}
								/>
								<span>apply theme to all monitors</span>
							</label>
							<div className="set-row">
								<span className="set-label" id="set-theme-label">
									{theme.lock ? 'theme (all monitors)' : `theme · ${monName || 'this monitor'}`}
								</span>
								<Select
									value={theme.selected}
									options={theme.options}
									onChange={theme.setTheme}
									searchable={false}
									aria-label={theme.lock ? 'Theme for all monitors' : 'Theme for this monitor'}
								/>
							</div>
							<div className="pl-desc">
								{theme.lock
									? 'One theme styles every monitor. Uncheck to give each monitor its own theme.'
									: 'Each monitor keeps its own theme — the picker above sets this monitor’s. Re-check to use one theme everywhere. Build/edit themes in the Themes section.'}
							</div>
							<div className="rp-hd">View</div>
							<button type="button" onClick={fit}>
								⤢ Fit to window ({Math.round(zoom * 100)}%)
							</button>
						</>
					)}
					{tab === 'overlay' && (
						<>
							<div className="pl-title">Overlay</div>
							<div className="pl-desc">
								How the transparent overlay sits on the desktop (window layer + taskbar).
							</div>
							<label className="rp-row set-check">
								<input
									type="checkbox"
									checked={overlayPrefs.respectWorkArea}
									onChange={(e) => setOverlayPrefs({ respectWorkArea: e.currentTarget.checked })}
								/>
								<span>keep clear of the taskbar</span>
							</label>
							<div className="set-row">
								<span className="set-label">window layer</span>
								<Select
									value={overlayPrefs.overlayLayer}
									options={OVERLAY_LAYER_OPTIONS}
									onChange={(v) => setOverlayPrefs({ overlayLayer: v as OverlayLayer })}
									aria-label="Window layer"
								/>
							</div>
							<div className="pl-desc">
								“Below windows” sits behind apps (above desktop icons; Show Desktop hides it).
								“Behind desktop icons” parents the overlay to the desktop so it renders under the
								icons — experimental, Windows-only, takes effect on the live overlay.
							</div>
							<div className="pl-desc set-status">
								Current layer: <strong>{overlayLayerLabel(overlayPrefs.overlayLayer)}</strong>
								{layerStatus && (
									<>
										{' '}
										<span
											className={/FAILED/.test(layerStatus) ? 'set-error' : 'dim'}
											title="The last layer-apply result reported by an overlay window"
										>
											· {layerStatus}
										</span>
									</>
								)}
							</div>
							<div className="rp-hd">Debug</div>
							<label className="rp-row set-check">
								<input
									type="checkbox"
									checked={overlayPrefs.debugWindowed}
									onChange={(e) => setOverlayPrefs({ debugWindowed: e.currentTarget.checked })}
								/>
								<span>windowed mode</span>
							</label>
							<div className="pl-desc">
								Render overlays as ordinary decorated, interactive, alt-tab-able windows (opaque,
								taskbar-present, not click-through), so a crashing or misbehaving overlay is
								visible, clickable (its “Reload” page), and inspectable — the borderless
								click-through overlay otherwise hides all of that. Takes effect on the live overlay.
							</div>
							<div className="pl-desc">
								Stuck behind a click-through window? Press <code>Ctrl+Alt+Shift+E</code> anytime —
								the rescue shortcut forces every window interactive (works even if its webview
								crashed).
							</div>
						</>
					)}
					{tab === 'startup' && (
						<>
							<div className="pl-title">Startup</div>
							<div className="pl-desc">What happens when you sign in to Windows.</div>
							<LaunchAtLogin />
							<div className="pl-desc">
								The overlay starts passive (click-through). Left-click the tray icon or use the
								Start-menu shortcut to open this studio.
							</div>
							<div className="rp-hd">Global shortcuts</div>
							<div className="set-row">
								<span className="set-label">
									<code>Ctrl+Alt+E</code>
								</span>
								<span>
									Toggle desktop edit mode — arrange widgets right on the desktop (
									<code>Ctrl+E</code> does the same inside a widgetsack window).
								</span>
							</div>
							<div className="set-row">
								<span className="set-label">
									<code>Ctrl+Alt+Shift+E</code>
								</span>
								<span>
									Rescue — makes every widgetsack window interactive and brings it forward, even if
									its webview crashed.
								</span>
							</div>
						</>
					)}
					{tab === 'controls' && (
						<>
							<div className="pl-title">Shortcuts</div>
							<div className="pl-desc">
								Rebind the keyboard shortcuts that drive the studio and overlays. Built-in global
								shortcuts are listed for reference.
							</div>
							<ControlsPanel
								overrides={controls.overrides}
								onRebind={controls.onRebind}
								onReset={controls.onReset}
								onResetAll={controls.onResetAll}
							/>
						</>
					)}
					{tab === 'diagnostics' && (
						<>
							<div className="pl-title">Diagnostics</div>
							<div className="pl-desc">
								Inspect the studio and overlays — JS heap, retained media, per-widget DOM weight,
								the logs pane, and devtools.
							</div>
							<label className="rp-row set-check">
								<input
									type="checkbox"
									checked={overlayPrefs.developerMode}
									onChange={(e) => setOverlayPrefs({ developerMode: e.currentTarget.checked })}
								/>
								<span>Developer mode (show ids and devtools items)</span>
							</label>
							<div className="set-actions">
								{overlayPrefs.developerMode && (
									<button type="button" onClick={openDevtools}>
										⌗ Inspect this window (devtools)
									</button>
								)}
								<button
									type="button"
									onClick={() => void rescueWindows()}
									title="Make every window interactive and bring it forward — recovers a click-through or crashed overlay you can't click (same as the Ctrl+Alt+Shift+E shortcut)."
								>
									⛑ Rescue all windows
								</button>
							</div>
							<DiagnosticsPanel appVersion={appVersion} />
						</>
					)}
					{tab === 'about' && (
						<>
							<div className="about-hd">
								<img
									className="about-mascot"
									src={mascotUrl}
									alt="widgetsack mascot: a beckoning cat carrying a sack and a little CRT"
									width={88}
									height={88}
								/>
								<div className="pl-title">widgetsack</div>
							</div>
							<div className="pl-desc">
								A themeable desktop widget overlay for Windows — system meters, clocks, the
								now-playing track, and Home Assistant controls, arranged here in the studio.
							</div>
							<div className="set-row">
								<span className="set-label">version</span>
								<span className="dim">{appVersion ?? '…'}</span>
							</div>
							<div className="set-row">
								<span className="set-label">license</span>
								<span className="dim">MIT OR Apache-2.0</span>
							</div>
							<AppUpdateCheck />
							<div className="rp-hd">Source</div>
							<div className="set-row">
								<span className="set-repo">github.com/gyng/widgetsack</span>
								<span className="set-actions">
									<button
										type="button"
										onClick={() => {
											void copyToClipboard('https://github.com/gyng/widgetsack');
										}}
									>
										copy
									</button>
								</span>
							</div>
						</>
					)}
					{tab === 'danger' && (
						<>
							<div className="pl-title set-danger-title">Danger zone</div>
							<div className="pl-desc">
								Destructive actions for this monitor’s layout. Undoable with Ctrl+Z until you open
								the widget designer or reload the layout.
							</div>
							<button type="button" className="rp-danger" onClick={clearMonitor}>
								✕ Clear this monitor
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
