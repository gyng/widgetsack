// The MQTT plugin's settings pane (studio → Plugins → MQTT). A container (AGENTS.md §6): owns the
// broker-config form and drives the Tauri commands via mqtt-commands.ts; the password is write-only
// (a blank save keeps the saved one). The live badge reads the `mqtt.status` telemetry sample
// through the hub (reusing the HA status→badge mapping — same vocabulary). Below the form, a browser
// lists seen + discovered topics with copy-id, the bindable `mqtt.<topic>` sensor reference.
import { useEffect, useState } from 'react';
import { useTelemetryHub } from '../telemetryContext';
import { useSensor } from '../useSensor';
import { haStatusBadge } from '../../core/haStatus';
import { copyToClipboard } from '../../overlay';
import { mqttConfigStatus, mqttConnect, mqttDisconnect, saveMqttConfig } from './mqtt-commands';
import { refreshMqttCatalog } from './mqtt-source';
import type { MqttCatalogEntry } from './mqtt-types';
import TokenListField from './TokenListField';

// Split on newline only — MQTT topic names may legitimately contain commas (unlike stock tickers).
const parseTopics = (text: string): string[] =>
	text
		.split('\n')
		.map((t) => t.trim())
		.filter(Boolean);

export default function MqttSettings() {
	const hub = useTelemetryHub();
	const status = useSensor(hub, 'mqtt.status');
	const badge = haStatusBadge(status.value?.kind === 'text' ? status.value.value : null);

	const [host, setHost] = useState('');
	const [port, setPort] = useState(1883);
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [clientId, setClientId] = useState('');
	const [topics, setTopics] = useState<string[]>([]);
	const [tls, setTls] = useState(false);
	const [insecure, setInsecure] = useState(false);
	const [discovery, setDiscovery] = useState(false);
	const [configured, setConfigured] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [entries, setEntries] = useState<MqttCatalogEntry[]>([]);
	const [refreshing, setRefreshing] = useState(false);

	// Auto-dismiss the "Saved ✓" tick like a toast (it otherwise lingers until the next edit).
	useEffect(() => {
		if (!saved) return;
		const t = setTimeout(() => setSaved(false), 2500);
		return () => clearTimeout(t);
	}, [saved]);

	useEffect(() => {
		let alive = true;
		mqttConnect().catch(() => undefined);
		mqttConfigStatus()
			.then((s) => {
				if (!alive) return;
				setHost(s.host);
				setPort(s.port);
				setUsername(s.username);
				setTopics(s.topics);
				setTls(s.tls);
				setInsecure(s.insecure);
				setDiscovery(s.discovery);
				setConfigured(s.configured);
			})
			.catch(() => undefined);
		refreshMqttCatalog().then((list) => {
			if (alive) setEntries(list);
		});
		return () => {
			alive = false;
		};
	}, []);

	const dirtied = () => setSaved(false);
	const canSubmit = host.trim().length > 0 && !saving;

	const onSave = async () => {
		if (!canSubmit) return;
		setSaving(true);
		setSaveError(null);
		try {
			await saveMqttConfig({
				host: host.trim(),
				port,
				username: username.trim(),
				password,
				clientId: clientId.trim(),
				topics,
				tls,
				insecure,
				discovery
			});
			await mqttDisconnect();
			await mqttConnect();
			setConfigured(true);
			setPassword(''); // back to write-only / unchanged
			setSaved(true);
			setEntries(await refreshMqttCatalog());
		} catch (err) {
			// Surface the failure instead of swallowing it (was a silent try/finally → unhandled rejection).
			setSaved(false);
			setSaveError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const onRefresh = async () => {
		setRefreshing(true);
		try {
			setEntries(await refreshMqttCatalog());
		} finally {
			setRefreshing(false);
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

			<div className="rp-hd">Broker</div>
			<div className="has-help">
				Connect to any MQTT broker and bind topics as <code>mqtt.&lt;topic&gt;</code> sensors. A
				JSON payload also exposes <code>mqtt.&lt;topic&gt;.&lt;field&gt;</code>; a numeric payload
				exposes
				<code> mqtt.&lt;topic&gt;.value</code>.
			</div>

			<div className="has-browser-bar">
				<label className="has-field" style={{ flex: 3 }}>
					Host
					<input
						type="text"
						placeholder="192.168.1.10 or broker.local"
						value={host}
						onChange={(e) => {
							setHost(e.currentTarget.value);
							dirtied();
						}}
					/>
				</label>
				<label className="has-field" style={{ flex: 1 }}>
					Port
					<input
						type="number"
						min={1}
						max={65535}
						value={port}
						onChange={(e) => {
							setPort(Number(e.currentTarget.value) || 1883);
							dirtied();
						}}
					/>
				</label>
			</div>

			<label className="has-field">
				Username
				<input
					type="text"
					autoComplete="off"
					placeholder="(optional)"
					value={username}
					onChange={(e) => {
						setUsername(e.currentTarget.value);
						dirtied();
					}}
				/>
			</label>

			<label className="has-field">
				Password
				<input
					type="password"
					autoComplete="off"
					placeholder={configured ? '•••••••• saved — leave blank to keep' : '(optional)'}
					value={password}
					onChange={(e) => {
						setPassword(e.currentTarget.value);
						dirtied();
					}}
				/>
			</label>

			<TokenListField
				label={
					<>
						Topics (wildcards ok: <code>zigbee2mqtt/#</code>)
					</>
				}
				values={topics}
				onChange={(next) => {
					setTopics(next);
					dirtied();
				}}
				parse={parseTopics}
				placeholder="zigbee2mqtt/# — Enter to add"
				listLabel="Subscribed topics"
				emptyHint="No topics yet — add one above (e.g. tasmota/+/SENSOR)."
			/>

			<label className="has-check">
				<input
					type="checkbox"
					checked={discovery}
					onChange={(e) => {
						setDiscovery(e.currentTarget.checked);
						dirtied();
					}}
				/>
				Consume Home Assistant MQTT discovery (auto-subscribe to discovered topics)
			</label>
			<label className="has-check">
				<input
					type="checkbox"
					checked={tls}
					onChange={(e) => {
						setTls(e.currentTarget.checked);
						dirtied();
					}}
				/>
				Use TLS (port is usually 8883)
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
					⚠ Skips certificate <em>and</em> hostname verification — only for a trusted LAN broker.
				</div>
			)}

			<details className="has-advanced">
				<summary>Advanced</summary>
				<label className="has-field">
					Client ID
					<input
						type="text"
						placeholder="widgetsack (default)"
						value={clientId}
						onChange={(e) => {
							setClientId(e.currentTarget.value);
							dirtied();
						}}
					/>
				</label>
			</details>

			<div className="has-actions">
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
			{saveError && <div className="has-test err">Couldn&rsquo;t save: {saveError}</div>}

			<div className="rp-hd">Topics</div>
			<div className="has-help">
				Topics seen + discovered since connecting. Copy an id (⧉) and bind it to a Text, Gauge or
				Sparkline widget.
			</div>
			<div className="has-browser-bar">
				<span className="has-state-dim">{entries.length} topics</span>
				<button type="button" onClick={onRefresh} disabled={refreshing}>
					{refreshing ? 'Refreshing…' : '↻ Refresh'}
				</button>
			</div>
			{entries.length ? (
				<ul className="has-entities" aria-label="MQTT topics">
					{entries.map((e) => (
						<li key={e.topic} className="has-entity">
							<span className="has-entity-name" title={e.topic}>
								{e.label ?? e.topic}
							</span>
							<code className="has-entity-id" title={e.id}>
								{e.topic}
							</code>
							<button
								type="button"
								className="has-copy"
								title="Copy sensor id"
								aria-label={`Copy sensor id ${e.id}`}
								onClick={() => void copyToClipboard(e.id)}
							>
								⧉
							</button>
						</li>
					))}
				</ul>
			) : (
				<div className="has-help">
					No topics yet — save a broker + topics above, then values appear here as they arrive.
				</div>
			)}
		</div>
	);
}
