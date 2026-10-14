import Icon from './Icon';
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
	getEditHotkey,
	openReleasePage,
	setEditHotkey,
	setUpdateCheck,
	useAppUpdate
} from '../appUpdate';
import { updateStatusLine } from '../core/updateNotice';
import { editHotkeyOptions, type EditHotkeyStatus } from '../core/editHotkey';
import ControlsPanel from './ControlsPanel';
import DiagnosticsPanel from './DiagnosticsPanel';
import Select from './Select';
import McpSettingsPanel from './McpSettingsPanel';
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
							<Icon name="external" /> Open release page
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

// Startup → the global edit-mode shortcut. A preset picker (no free-text capture): the backend
// (hotkey.rs) validates, persists and re-registers it at once. The picker shows the backend's status
// on mount; a chord another app already owns comes back as a registration error (and no edit
// shortcut is active), and an invalid value is rejected without changing anything.
function EditHotkeySetting() {
	const [status, setStatus] = useState<EditHotkeyStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let alive = true;
		void getEditHotkey().then((s) => {
			if (alive) setStatus(s);
		});
		return () => {
			alive = false;
		};
	}, []);
	// One change at a time: a second pick before the first lands could finish out of order.
	const [busy, setBusy] = useState(false);
	const onPick = async (hotkey: string) => {
		setError(null);
		setBusy(true);
		try {
			setStatus(await setEditHotkey(hotkey));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	const failed = status?.error ?? null;
	return (
		<>
			<div className="set-row">
				<span className="set-label">edit mode</span>
				{status ? (
					<Select
						value={status.hotkey}
						options={editHotkeyOptions(status.hotkey)}
						onChange={(v) => void onPick(v)}
						disabled={busy}
						searchable={false}
						aria-label="Edit mode shortcut"
					/>
				) : (
					<span className="dim">unavailable</span>
				)}
			</div>
			<div className="pl-desc">
				Turn desktop edit mode on or off from anywhere. Use <code>Ctrl+E</code> inside a Widgetsack
				window. On some keyboard layouts AltGr is the same as <code>Ctrl+Alt</code>, so{' '}
				<code>Ctrl+Alt+E</code> can block typing characters such as ę or €. Choose another shortcut
				or Off if that happens.
			</div>
			{error ? (
				<div className="pl-desc set-error" role="alert">
					Couldn’t change the edit shortcut: {error}
				</div>
			) : (
				failed && (
					<div className="pl-desc set-error" role="alert">
						Couldn’t register {status?.hotkey}: {failed}. No edit shortcut is active.
					</div>
				)
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
	{ id: 'mcp', label: 'MCP' },
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
								This layout uses the selected monitor. Each monitor has its own layout.
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
									Move a widget to another monitor. Right-click it and select “Move to”.
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
									? 'One theme styles every monitor. Clear this option to set a separate theme for each monitor.'
									: 'Each monitor keeps its own theme. Use the picker above to select this monitor’s theme. Select this option to apply one theme to all monitors. Edit themes in Themes.'}
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
								Choose where desktop widgets appear and how their windows behave.
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
							<ul className="pl-desc set-help-list">
								<li>
									<strong>Below windows:</strong> Widgets appear behind apps and above desktop
									icons. Show Desktop hides them.
								</li>
								<li>
									<strong>Always on top:</strong> Widgets appear above other windows.
								</li>
								<li>
									<strong>Behind desktop icons:</strong> Widgets appear below the icons. This
									Windows feature is experimental.
								</li>
							</ul>
							<p className="pl-desc">Changes to the window layer apply immediately.</p>
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
							<p className="pl-desc">
								Use windowed mode to inspect a widget window or recover from an error.
							</p>
							<ul className="pl-desc set-help-list">
								<li>Each widget window has a title bar and an opaque background.</li>
								<li>You can click the window and select it from the taskbar or with Alt+Tab.</li>
								<li>If an error page appears, you can select Reload.</li>
							</ul>
							<p className="pl-desc">
								To recover a window you cannot click, press <code>Ctrl+Alt+Shift+E</code>. The
								shortcut brings all widget windows forward so you can click them.
							</p>
						</>
					)}
					{tab === 'startup' && (
						<>
							<div className="pl-title">Startup</div>
							<div className="pl-desc">What happens when you sign in to Windows.</div>
							<LaunchAtLogin />
							<div className="pl-desc">
								The overlay starts with clicks passing through to the desktop. Open Studio from the
								tray icon or Start menu.
							</div>
							<div className="rp-hd">Global shortcuts</div>
							<EditHotkeySetting />
							<div className="set-row">
								<span className="set-label">
									<code>Ctrl+Alt+Shift+E</code>
								</span>
								<span>
									Bring all widget windows forward so you can click them. Use this shortcut if a
									window stops responding.
								</span>
							</div>
						</>
					)}
					{tab === 'controls' && (
						<>
							<div className="pl-title">Shortcuts</div>
							<div className="pl-desc">
								Change the keyboard shortcuts for Studio and the overlays. The list also shows
								built-in global shortcuts.
							</div>
							<ControlsPanel
								overrides={controls.overrides}
								onRebind={controls.onRebind}
								onReset={controls.onReset}
								onResetAll={controls.onResetAll}
							/>
						</>
					)}
					{tab === 'mcp' && <McpSettingsPanel />}
					{tab === 'diagnostics' && (
						<>
							<div className="pl-title">Diagnostics</div>
							<div className="pl-desc">
								Check memory use, retained media, widget element counts, and logs for Studio and the
								overlays. Use developer tools to inspect a window.
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
									title="Bring all widget windows forward so you can click them. This is the same action as Ctrl+Alt+Shift+E."
								>
									<Icon name="rescue" /> Rescue all windows
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
								Desktop widgets for Windows. Show system meters, clocks, music, and Home Assistant
								controls. Arrange them in Studio.
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
								Clear this monitor’s layout. Press Ctrl+Z to undo it before you open the widget
								designer or reload the layout.
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
