// Plugins section (extracted from Canvas): the registered-plugin list (with live status dots) +
// the selected plugin's detail/settings pane. Which plugin is selected stays Canvas state (it
// survives section switches); everything else — the failed-registration rows, the settings panel
// behind its ErrorBoundary, the sources/widget-types fallback — renders here. Lazy-loaded like
// the other studio panels, so the overlay never fetches it.
import { useMemo, useState } from 'react';
import { useStore } from '../../stores/createStore';
import type { TelemetryHub } from '../core/telemetry';
import { statusDotFrom, type Plugin } from './plugin';
import { pluginLoadErrors } from './plugins';
import {
	checkPackageUpdate,
	enabledPackages,
	installPackage,
	packagesStore,
	removePackage,
	togglePackage,
	updatePackage,
	type PackageRow
} from './plugins/packages';
import ErrorBoundary from './ErrorBoundary';
import SensorList from './SensorList';
import { useSensor } from './useSensor';

type Props = {
	hub: TelemetryHub;
	plugins: Plugin[];
	selectedId: string | null;
	onSelect: (id: string) => void;
};

// What a package row says under its name: contents when healthy, the failure when not.
function packageSubtext(row: PackageRow): string {
	if (row.error) return 'failed to load';
	const parts: string[] = [];
	if (row.templates) parts.push(`${row.templates} template${row.templates === 1 ? '' : 's'}`);
	if (row.themeName) parts.push(`theme “${row.themeName}”`);
	if (row.sensors) parts.push(`${row.sensors} sensor${row.sensors === 1 ? '' : 's'}`);
	return parts.length ? parts.join(' · ') : 'empty';
}

// The per-row state of the manual update-check flow (local to the row — closing the panel resets
// it, which is fine for an on-demand check).
type UpdateState =
	| { kind: 'idle' }
	| { kind: 'busy'; label: string }
	| { kind: 'current' }
	| { kind: 'update'; current: string; latest: string }
	| { kind: 'error'; message: string };

// One third-party package row: opt-in enable toggle + name/version + a contents line; a parse
// failure shows as an untoggleable warn row (the reason rides the title), dropped-template
// warnings keep the toggle but carry a warn dot. Rows installed from a URL also show their
// source plus manual "Check updates"/Update actions; Remove works for every row (a hand-dropped
// folder is still just a directory).
function PackageItem({ row, enabled }: { row: PackageRow; enabled: boolean }) {
	const warn = row.error ?? (row.warnings.length ? row.warnings.join('\n') : null);
	const [update, setUpdate] = useState<UpdateState>({ kind: 'idle' });
	const busy = update.kind === 'busy';

	const onCheck = async () => {
		setUpdate({ kind: 'busy', label: 'checking…' });
		const r = await checkPackageUpdate(row.id);
		if (!r.ok) setUpdate({ kind: 'error', message: r.error });
		else if (r.updateAvailable) setUpdate({ kind: 'update', current: r.current, latest: r.latest });
		else setUpdate({ kind: 'current' });
	};
	const onUpdate = async () => {
		setUpdate({ kind: 'busy', label: 'updating…' });
		const r = await updatePackage(row.id);
		if (!r.ok) setUpdate({ kind: 'error', message: r.error ?? 'update failed' });
		else setUpdate({ kind: 'idle' });
	};
	// Destructive → still a confirm(); the failure reason shows inline on the row, not in an alert.
	const onRemove = async () => {
		if (!window.confirm(`Remove the package “${row.name}”? Its folder is deleted from disk.`)) {
			return;
		}
		setUpdate({ kind: 'busy', label: 'removing…' });
		const r = await removePackage(row.id);
		if (!r.ok) setUpdate({ kind: 'error', message: `Remove failed: ${r.error}` });
		else setUpdate({ kind: 'idle' });
	};

	return (
		<div
			className={['pkg-item', row.error && 'pl-failed'].filter(Boolean).join(' ')}
			title={warn ?? row.description ?? ''}
		>
			<label className="pkg-toggle">
				<input
					type="checkbox"
					checked={enabled}
					disabled={!!row.error}
					aria-label={`Enable ${row.name}`}
					onChange={(e) =>
						// togglePackage composes the full first-enable consent message (flagged theme
						// CSS and/or network hosts, one dialog) — the panel just asks it.
						void togglePackage(row.id, e.currentTarget.checked, (message) =>
							window.confirm(message)
						)
					}
				/>
				<span className="pkg-name">{row.name}</span>
				{row.version && <span className="dim">v{row.version}</span>}
				{warn && <span className="pl-dot pl-dot--warn" aria-label="Package warning" />}
			</label>
			<span className="pkg-sub dim">{packageSubtext(row)}</span>
			{row.hosts.length > 0 && (
				<span className="pkg-sub pkg-net dim">network: {row.hosts.join(', ')}</span>
			)}
			{row.installedFrom && <span className="pkg-sub pkg-src dim">from {row.installedFrom}</span>}
			<div className="pkg-actions">
				{row.installedFrom && (
					<button type="button" disabled={busy} onClick={() => void onCheck()}>
						Check updates
					</button>
				)}
				{update.kind === 'update' && (
					<button type="button" className="pkg-update" onClick={() => void onUpdate()}>
						Update
					</button>
				)}
				<button type="button" className="rp-danger" disabled={busy} onClick={() => void onRemove()}>
					Remove
				</button>
				{update.kind === 'busy' && <span className="pkg-status dim">{update.label}</span>}
				{update.kind === 'current' && <span className="pkg-status dim">up to date</span>}
				{update.kind === 'update' && (
					<span className="pkg-status">
						v{update.current} → v{update.latest} available
					</span>
				)}
				{update.kind === 'error' && (
					<span className="pkg-status pkg-status--err" title={update.message}>
						{update.message}
					</span>
				)}
			</div>
		</div>
	);
}

// The inline "install a package" form: a source field (owner/repo, a github.com repo URL, or an
// https link to a plugin.json) + Install. The outcome shows right under the field — the failure
// reason, or a success line naming the package that just landed (found by diffing the discovered
// rows around the install; a re-install of an existing id falls back to the typed source).
type InstallState =
	| { kind: 'idle' }
	| { kind: 'busy' }
	| { kind: 'ok'; name: string }
	| { kind: 'error'; message: string };

function InstallPackageForm() {
	const [source, setSource] = useState('');
	const [state, setState] = useState<InstallState>({ kind: 'idle' });
	const busy = state.kind === 'busy';
	const onSubmit = async () => {
		const src = source.trim();
		if (!src) return; // Enter in an empty field
		setState({ kind: 'busy' });
		const before = new Set(packagesStore.getSnapshot().map((r) => r.id));
		const r = await installPackage(src);
		if (!r.ok) {
			setState({ kind: 'error', message: r.error ?? 'install failed' });
			return;
		}
		const added = packagesStore.getSnapshot().find((row) => !before.has(row.id));
		setState({ kind: 'ok', name: added?.name ?? src });
		setSource('');
	};
	return (
		<form
			className="pkg-install"
			onSubmit={(e) => {
				e.preventDefault();
				void onSubmit();
			}}
		>
			<label className="pkg-install-field">
				<span>Install a package</span>
				<input
					type="text"
					value={source}
					placeholder="owner/repo or https://…manifest.json"
					aria-label="Package source"
					spellCheck={false}
					disabled={busy}
					onChange={(e) => setSource(e.currentTarget.value)}
				/>
			</label>
			<button type="submit" disabled={busy || !source.trim()}>
				{busy ? 'Installing…' : 'Install'}
			</button>
			{state.kind === 'error' && (
				<div className="pkg-status pkg-status--err" role="alert" title={state.message}>
					Install failed: {state.message}
				</div>
			)}
			{state.kind === 'ok' && (
				<div className="pkg-status" role="status">
					Installed “{state.name}” — enable it below to use its templates.
				</div>
			)}
		</form>
	);
}

// One Plugins-list status dot: subscribes to the plugin's declared status sensor (the same
// `*.status` text samples the detail panels read) and renders an ok/warn/off dot. A component
// (not inline JSX) so the useSensor hook count stays constant per list row.
function PluginStatusDot({ hub, sensor }: { hub: TelemetryHub; sensor?: string }) {
	const state = useSensor(hub, sensor ?? '__none__');
	if (!sensor) return null;
	const dot = statusDotFrom(state.value?.kind === 'text' ? state.value.value : null);
	return (
		<span className={`pl-dot pl-dot--${dot.state}`} title={dot.label} aria-label={dot.label} />
	);
}

export default function PluginsPanel({ hub, plugins, selectedId, onSelect }: Props) {
	const selectedPlugin = useMemo(
		() => plugins.find((p) => p.id === selectedId) ?? null,
		[plugins, selectedId]
	);
	// Third-party plugin packages (plugins/<id>/plugin.json dirs) + the opt-in enabled allowlist.
	const packageRows = useStore(packagesStore);
	const enabledIds = useStore(enabledPackages);
	// Capitalized so it can be used as a JSX element when the plugin ships a settings panel.
	const SelectedPluginSettings = selectedPlugin?.settings ?? null;
	return (
		<div className="rail-panel plugins-panel">
			<div className="pl-list">
				<div className="rp-hd">Plugins</div>
				{plugins.length ? (
					plugins.map((p) => (
						<button
							key={p.id}
							type="button"
							className={['pl-item', p.id === selectedId && 'cur'].filter(Boolean).join(' ')}
							onClick={() => onSelect(p.id)}
						>
							<PluginStatusDot hub={hub} sensor={p.statusSensor} />
							{p.name}
						</button>
					))
				) : (
					<div className="rp-stub">No plugins registered.</div>
				)}
				{/* Plugins whose registration threw (registerBuiltinPlugins caught it):
				    they never reach pluginList, so list them as inert warn rows. */}
				{pluginLoadErrors().map((e) => (
					<div key={e.id} className="pl-item pl-failed" title={e.error}>
						<span className="pl-dot pl-dot--warn" aria-label="Failed to load" />
						{e.name} <span className="dim">failed to load</span>
					</div>
				))}
				{/* Third-party packages: declarative template/theme bundles dropped into the app-config
				    plugins/ dir. Opt-in — discovered packages start disabled. */}
				<div className="rp-hd">Packages</div>
				<InstallPackageForm />
				{packageRows.length ? (
					packageRows.map((r) => (
						<PackageItem key={r.id} row={r} enabled={enabledIds.includes(r.id)} />
					))
				) : (
					<div className="rp-stub">
						No packages installed — install one above, or drop a folder at{' '}
						<code>plugins\&lt;id&gt;\plugin.json</code> in the app config dir. See
						docs/third-party-plugins.md.
					</div>
				)}
			</div>
			<div className="pl-detail">
				{!selectedPlugin ? (
					<div className="rp-stub">Select a plugin to view its settings.</div>
				) : (
					<>
						<div className="pl-title">{selectedPlugin.name}</div>
						{selectedPlugin.description && (
							<div className="pl-desc">{selectedPlugin.description}</div>
						)}
						{SelectedPluginSettings ? (
							// Keyed by plugin so a healthy panel never inherits a stale crash
							// state; a throwing panel degrades to an inline error, not a blank
							// studio rail.
							<ErrorBoundary key={selectedPlugin.id} label={`${selectedPlugin.name} settings`}>
								<SelectedPluginSettings />
							</ErrorBoundary>
						) : (
							<>
								{!!selectedPlugin.sources?.length && (
									<>
										<div className="rp-hd">Sources</div>
										{selectedPlugin.sources.map((s) => {
											const ids = s.catalog?.() ?? [];
											return (
												<div key={s.id} className="pl-source">
													<div className="rp-row">
														<span>{s.id}</span>
														<span className="dim">{ids.length} sensors</span>
													</div>
													{ids.length > 0 && <SensorList hub={hub} ids={ids} />}
												</div>
											);
										})}
									</>
								)}
								{!!selectedPlugin.widgets?.length && (
									<>
										<div className="rp-hd">Widget types</div>
										<div className="rp-list">
											{selectedPlugin.widgets.map((w) => (
												<div key={w.meta.type} className="rp-row">
													<span>{w.meta.label ?? w.meta.type}</span>
													<span className="dim">{w.meta.type}</span>
												</div>
											))}
										</div>
									</>
								)}
								{!selectedPlugin.sources?.length && !selectedPlugin.widgets?.length && (
									<div className="rp-stub">This plugin has no configurable settings.</div>
								)}
							</>
						)}
					</>
				)}
			</div>
		</div>
	);
}
