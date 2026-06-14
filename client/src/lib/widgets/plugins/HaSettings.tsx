// The Home Assistant plugin's settings pane (studio → Plugins → Home Assistant). A container
// (AGENTS.md §6): it owns the form state and drives the Tauri commands via ha-commands.ts; the
// token is write-only (never read back — the bridge omits it), so a blank token on save/test means
// "keep the saved one". The live connection badge reads the existing `ha.status` telemetry sample
// through the hub, the same path meters use. Phase 1: connection config + Test + status; the entity
// browser (Phase 2) mounts below this.
import { useEffect, useMemo, useState } from 'react';
import { useTelemetryHub } from '../telemetryContext';
import { useSensor } from '../useSensor';
import { useStore } from '../../../stores/createStore';
import { haStatusBadge } from '../../core/haStatus';
import { isExposed, normalizeExposed, toggleExposed } from '../../core/haExposed';
import { buildRegistryTree, type HaRegistry, type LiveState } from '../../core/haRegistry';
import { copyToClipboard } from '../../overlay';
import {
	haConfigStatus,
	haConnect,
	haDisconnect,
	haRegistrySnapshot,
	haTestConnection,
	saveHaConfig
} from './ha-commands';
import { haExposedStore } from './ha-exposed-store';
import { refreshHaCatalog } from './ha-source';
import type { HaEntity } from './ha-types';

type TestState =
	| { kind: 'idle' }
	| { kind: 'testing' }
	| { kind: 'ok'; msg: string }
	| { kind: 'err'; msg: string };

export default function HaSettings() {
	// Live connection state from the `ha.status` text sample (connecting/connected/error/…).
	const hub = useTelemetryHub();
	const status = useSensor(hub, 'ha.status');
	const statusText = status.value?.kind === 'text' ? status.value.value : null;
	const badge = haStatusBadge(statusText);

	const [url, setUrl] = useState('');
	const [token, setToken] = useState('');
	const [insecure, setInsecure] = useState(false);
	const [basePath, setBasePath] = useState('');
	const [configured, setConfigured] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [test, setTest] = useState<TestState>({ kind: 'idle' });

	// Auto-dismiss the "Saved ✓" tick like a toast (it otherwise lingers until the next edit).
	useEffect(() => {
		if (!saved) return;
		const t = setTimeout(() => setSaved(false), 2500);
		return () => clearTimeout(t);
	}, [saved]);

	// Entity browser state: the fetched entities, a search filter, and the (persisted) exposed
	// allowlist of `ha.<entity_id>` ids that curate the inspector dropdown.
	const [entities, setEntities] = useState<HaEntity[]>([]);
	const [query, setQuery] = useState('');
	const [refreshing, setRefreshing] = useState(false);
	const exposed = useStore(haExposedStore);

	// On mount: ensure the WS task runs in this (studio) window so the live badge populates even
	// when no HA widget is on the studio's own layout (idempotent), prefill the form from the
	// non-secret status, and load the entity catalog. The token field stays blank — never returned.
	useEffect(() => {
		let alive = true;
		haConnect().catch(() => undefined);
		haConfigStatus()
			.then((s) => {
				if (!alive) return;
				setUrl(s.url ?? '');
				setInsecure(s.insecure);
				setBasePath(s.base_path);
				setConfigured(s.configured);
			})
			.catch(() => undefined);
		refreshHaCatalog().then((list) => {
			if (alive) setEntities(list);
		});
		return () => {
			alive = false;
		};
	}, []);

	// Area > device > entity grouping (Phase 3): lazily fetched registry snapshot + the pure tree.
	const [groupByArea, setGroupByArea] = useState(false);
	const [registry, setRegistry] = useState<HaRegistry | null>(null);

	const onRefreshEntities = async () => {
		setRefreshing(true);
		setRegistry(null); // force the grouped view to refetch the registry too
		try {
			setEntities(await refreshHaCatalog());
		} finally {
			setRefreshing(false);
		}
	};

	// Fetch the registry the first time grouping is turned on (or after a Refresh cleared it).
	useEffect(() => {
		if (!groupByArea || registry) return;
		let alive = true;
		haRegistrySnapshot()
			.then((r) => {
				if (alive) setRegistry(r);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [groupByArea, registry]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return entities;
		return entities.filter(
			(e) =>
				e.entity_id.toLowerCase().includes(q) || (e.friendly_name ?? '').toLowerCase().includes(q)
		);
	}, [entities, query]);

	// Live values keyed by entity_id, so the tree can show state/unit + apply name precedence.
	const liveMap = useMemo<Record<string, LiveState>>(() => {
		const m: Record<string, LiveState> = {};
		for (const e of entities)
			m[e.entity_id] = { state: e.state, friendly_name: e.friendly_name, unit: e.unit };
		return m;
	}, [entities]);

	const tree = useMemo(
		() => (registry ? buildRegistryTree(registry, liveMap) : []),
		[registry, liveMap]
	);

	// Apply the search to the grouped tree too, dropping empty devices/areas.
	const treeFiltered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return tree;
		const match = (e: { name: string; entityId: string }) =>
			e.name.toLowerCase().includes(q) || e.entityId.toLowerCase().includes(q);
		return tree
			.map((a) => ({
				...a,
				devices: a.devices
					.map((d) => ({ ...d, entities: d.entities.filter(match) }))
					.filter((d) => d.entities.length),
				looseEntities: a.looseEntities.filter(match)
			}))
			.filter((a) => a.devices.length || a.looseEntities.length);
	}, [tree, query]);

	// The sensor ids currently SHOWN (flat list or grouped tree, after the search filter) — what the
	// bulk expose/clear actions operate on, so they respect a filter ("expose every light.*").
	const visibleSensorIds = useMemo(() => {
		if (groupByArea) {
			const ids: string[] = [];
			for (const a of treeFiltered) {
				for (const d of a.devices) for (const e of d.entities) ids.push(e.sensorId);
				for (const e of a.looseEntities) ids.push(e.sensorId);
			}
			return ids;
		}
		return filtered.map((e) => `ha.${e.entity_id}`);
	}, [groupByArea, treeFiltered, filtered]);
	const visibleExposedCount = useMemo(
		() => visibleSensorIds.reduce((n, id) => (exposed.includes(id) ? n + 1 : n), 0),
		[visibleSensorIds, exposed]
	);
	const exposeAllVisible = () =>
		haExposedStore.update((cur) => normalizeExposed([...cur, ...visibleSensorIds]));
	const clearVisibleExposed = () => {
		const vis = new Set(visibleSensorIds);
		haExposedStore.update((cur) => cur.filter((id) => !vis.has(id)));
	};

	// One entity row, shared by the flat list and the grouped tree (expose toggle + copy id).
	const entityRow = (
		sensorId: string,
		entityId: string,
		name: string,
		state: string,
		unit?: string
	) => (
		<li key={entityId} className="has-entity">
			<label className="has-entity-expose" title="Expose in the sensor dropdown">
				<input
					type="checkbox"
					checked={isExposed(exposed, sensorId)}
					onChange={() => haExposedStore.update((cur) => toggleExposed(cur, sensorId))}
					aria-label={`Expose ${name}`}
				/>
			</label>
			<span className="has-entity-name" title={entityId}>
				{name}
			</span>
			<code className="has-entity-id" title={sensorId}>
				{entityId}
			</code>
			<span className="has-entity-state">
				{state}
				{unit ? ` ${unit}` : ''}
			</span>
			<button
				type="button"
				className="has-copy"
				title="Copy sensor id"
				aria-label={`Copy sensor id ${sensorId}`}
				onClick={() => void copyToClipboard(sensorId)}
			>
				⧉
			</button>
		</li>
	);

	// Any edit invalidates the "Saved"/test feedback.
	const dirtied = () => {
		setSaved(false);
		setTest({ kind: 'idle' });
	};

	const canSubmit = url.trim().length > 0 && !saving;

	const onSave = async () => {
		if (!canSubmit) return;
		setSaving(true);
		try {
			await saveHaConfig(url.trim(), token, insecure, basePath.trim());
			// Apply live without a restart: the running task holds the OLD config, so disconnect
			// first (ha_connect is idempotent and would otherwise be a no-op).
			await haDisconnect();
			await haConnect();
			setConfigured(true);
			setToken(''); // back to write-only / unchanged
			setSaved(true);
		} catch (err) {
			setTest({ kind: 'err', msg: `Save failed: ${String(err)}` });
		} finally {
			setSaving(false);
		}
	};

	const onTest = async () => {
		setTest({ kind: 'testing' });
		try {
			const r = await haTestConnection(url.trim(), token, insecure, basePath.trim());
			setTest({
				kind: 'ok',
				msg: r.ha_version ? `Connected — Home Assistant ${r.ha_version}` : 'Connected'
			});
		} catch (err) {
			setTest({ kind: 'err', msg: String(err) });
		}
	};

	return (
		<div className="has">
			<div className="has-statusline">
				<span className={`has-badge ${badge.tone}`} aria-live="polite">
					● {badge.label}
				</span>
				<span className="has-state-dim">{configured ? 'configured' : 'not configured'}</span>
			</div>

			<div className="rp-hd">Connection</div>
			<div className="has-help">
				Point at your Home Assistant base URL and paste a long-lived access token (HA → your profile
				→ Security → Long-lived access tokens). The token is stored locally and never leaves the
				Rust side.
			</div>

			<label className="has-field">
				URL
				<input
					type="text"
					inputMode="url"
					placeholder="http://homeassistant.local:8123"
					value={url}
					onChange={(e) => {
						setUrl(e.currentTarget.value);
						dirtied();
					}}
				/>
			</label>

			<label className="has-field">
				Access token
				<input
					type="password"
					autoComplete="off"
					placeholder={
						configured ? '•••••••• saved — leave blank to keep' : 'long-lived access token'
					}
					value={token}
					onChange={(e) => {
						setToken(e.currentTarget.value);
						dirtied();
					}}
				/>
			</label>

			<label className="has-check">
				<input
					type="checkbox"
					checked={insecure}
					onChange={(e) => {
						setInsecure(e.currentTarget.checked);
						dirtied();
					}}
				/>
				Allow self-signed / invalid TLS certificate
			</label>
			{insecure && (
				<div className="has-warn">
					⚠ Skips certificate <em>and</em> hostname verification — only for a trusted LAN Home
					Assistant behind a self-signed cert.
				</div>
			)}

			<details className="has-advanced">
				<summary>Advanced</summary>
				<label className="has-field">
					Reverse-proxy subpath
					<input
						type="text"
						placeholder="(none) — e.g. /homeassistant"
						value={basePath}
						onChange={(e) => {
							setBasePath(e.currentTarget.value);
							dirtied();
						}}
					/>
					<small className="has-help">
						Leave blank unless HA is behind a proxy that <em>forwards</em> the prefix (most strip it
						— then leave this empty).
					</small>
				</label>
			</details>

			<div className="has-actions">
				<button
					type="button"
					onClick={onTest}
					disabled={url.trim().length === 0}
					aria-busy={test.kind === 'testing'}
				>
					{test.kind === 'testing' ? 'Testing…' : 'Test connection'}
				</button>
				<button
					type="button"
					className="has-primary"
					onClick={onSave}
					disabled={!canSubmit}
					aria-busy={saving}
				>
					{saving ? 'Saving…' : 'Save & connect'}
				</button>
				{saved && <span className="has-ok">Saved ✓</span>}
			</div>

			{test.kind === 'ok' && <div className="has-test ok">{test.msg}</div>}
			{test.kind === 'err' && <div className="has-test err">{test.msg}</div>}

			<div className="rp-hd">Entities</div>
			<div className="has-help">
				Tick an entity to <strong>expose</strong> it — exposed entities are the ones offered in a
				widget&apos;s sensor dropdown (bind to <code>ha.&lt;entity_id&gt;</code>). Expose none to
				offer them all. Copy an id with ⧉.
			</div>

			<div className="has-browser-bar">
				<input
					type="search"
					className="has-search"
					placeholder="Filter entities…"
					value={query}
					onChange={(e) => setQuery(e.currentTarget.value)}
					aria-label="Filter entities"
				/>
				<button type="button" onClick={onRefreshEntities} disabled={refreshing}>
					{refreshing ? 'Refreshing…' : '↻ Refresh'}
				</button>
			</div>

			<div className="has-browser-count">
				<span>
					{exposed.length} exposed · {entities.length} total
				</span>
				<label className="has-check has-group-toggle">
					<input
						type="checkbox"
						checked={groupByArea}
						onChange={(e) => setGroupByArea(e.currentTarget.checked)}
					/>
					Group by area
				</label>
			</div>

			{entities.length > 0 && (
				<div className="has-bulk">
					<button
						type="button"
						onClick={exposeAllVisible}
						disabled={
							visibleSensorIds.length === 0 || visibleExposedCount === visibleSensorIds.length
						}
						title="Expose every entity currently shown (respects the filter)"
					>
						Expose all{query.trim() ? ' shown' : ''}
					</button>
					<button
						type="button"
						onClick={clearVisibleExposed}
						disabled={visibleExposedCount === 0}
						title="Un-expose every entity currently shown"
					>
						Clear{query.trim() ? ' shown' : ''}
					</button>
				</div>
			)}

			{groupByArea ? (
				treeFiltered.length ? (
					<div className="has-tree" aria-label="Home Assistant entities by area">
						{treeFiltered.map((area) => (
							<div key={area.areaId ?? '__none__'} className="has-area">
								<div className="has-area-hd">{area.name}</div>
								{area.devices.map((d) => (
									<div key={d.id} className="has-device">
										<div className="has-device-hd">{d.name}</div>
										<ul className="has-entities">
											{d.entities.map((e) =>
												entityRow(e.sensorId, e.entityId, e.name, e.state ?? '', e.unit)
											)}
										</ul>
									</div>
								))}
								{area.looseEntities.length ? (
									<ul className="has-entities">
										{area.looseEntities.map((e) =>
											entityRow(e.sensorId, e.entityId, e.name, e.state ?? '', e.unit)
										)}
									</ul>
								) : null}
							</div>
						))}
					</div>
				) : (
					<div className="has-help">
						{registry ? 'No entities match the filter.' : 'Loading registry…'}
					</div>
				)
			) : filtered.length ? (
				<ul className="has-entities" aria-label="Home Assistant entities">
					{filtered.map((e) =>
						entityRow(
							`ha.${e.entity_id}`,
							e.entity_id,
							e.friendly_name ?? e.entity_id,
							e.state,
							e.unit
						)
					)}
				</ul>
			) : (
				<div className="has-help">
					{entities.length
						? 'No entities match the filter.'
						: 'No entities — connect to Home Assistant above, then Refresh.'}
				</div>
			)}
		</div>
	);
}
