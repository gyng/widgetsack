// The RSS plugin's settings pane (studio → Plugins → RSS). A container (AGENTS.md §6): owns the form
// state, drives the Tauri commands via rss-commands.ts. Public feeds, nothing secret. The live badge
// reads the `rss.status` telemetry sample through the hub, the same path meters use. Reuses the shared
// `has-*` settings styling.
import { useEffect, useState } from 'react';
import { useTelemetryHub } from '../telemetryContext';
import { useSensor } from '../useSensor';
import { haStatusBadge } from '../../core/haStatus';
import { rssConfigStatus, saveRssConfig, rssConnect, rssDisconnect } from './rss-commands';

export default function RssSettings() {
	const hub = useTelemetryHub();
	const status = useSensor(hub, 'rss.status');
	const statusText = status.value?.kind === 'text' ? status.value.value : null;
	const badge = haStatusBadge(statusText);

	const [url, setUrl] = useState('');
	const [title, setTitle] = useState('');
	const [count, setCount] = useState(8);
	const [poll, setPoll] = useState(15); // minutes (the backend stores seconds)
	const [configured, setConfigured] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		let alive = true;
		rssConnect().catch(() => undefined);
		rssConfigStatus()
			.then((s) => {
				if (!alive) return;
				setUrl(s.url || '');
				setTitle(s.title || '');
				setCount(s.count || 8);
				setPoll(Math.round((s.pollSeconds || 900) / 60));
				setConfigured(s.configured);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, []);

	useEffect(() => {
		if (!saved) return;
		const t = setTimeout(() => setSaved(false), 2500);
		return () => clearTimeout(t);
	}, [saved]);

	const valid = /^https?:\/\//i.test(url.trim());
	const dirtied = () => setSaved(false);

	const onSave = async () => {
		if (!valid || saving) return;
		setSaving(true);
		try {
			await saveRssConfig({
				url: url.trim(),
				count: Math.max(1, Math.min(30, count)),
				title,
				pollSeconds: Math.max(5, poll) * 60
			});
			// Apply live: the running task holds the OLD config, so restart it.
			await rssDisconnect();
			await rssConnect();
			setConfigured(true);
			setSaved(true);
		} finally {
			setSaving(false);
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

			<div className="rp-hd">Feed</div>
			<div className="has-help">
				Any public RSS or Atom feed URL. The fetch + parse run on the Rust side; only the headline
				titles cross to the overlay.
			</div>

			<label className="has-field">
				Feed URL
				<input
					type="text"
					inputMode="url"
					placeholder="https://example.com/feed.xml"
					value={url}
					onChange={(e) => {
						setUrl(e.currentTarget.value);
						dirtied();
					}}
				/>
			</label>
			<label className="has-field">
				Title (optional)
				<input
					type="text"
					placeholder="Headlines"
					value={title}
					onChange={(e) => {
						setTitle(e.currentTarget.value);
						dirtied();
					}}
				/>
			</label>
			<label className="has-field">
				Headlines
				<input
					type="number"
					min={1}
					max={30}
					value={count}
					onChange={(e) => {
						setCount(Number(e.currentTarget.value));
						dirtied();
					}}
				/>
			</label>
			<label className="has-field">
				Refresh (minutes)
				<input
					type="number"
					min={5}
					max={360}
					value={poll}
					onChange={(e) => {
						setPoll(Number(e.currentTarget.value));
						dirtied();
					}}
				/>
			</label>

			<div className="has-actions">
				<button
					type="button"
					className="has-primary"
					onClick={onSave}
					disabled={!valid || saving}
					aria-busy={saving}
				>
					{saving ? 'Saving…' : 'Save & fetch'}
				</button>
				{saved && <span className="has-ok">Saved ✓</span>}
				{!valid && url !== '' && <span className="has-state-dim">enter a http(s) feed URL</span>}
			</div>

			<div className="has-help">
				Drop an <strong>RSS</strong> widget (its plugin category in the palette) to show the
				headlines.
			</div>
		</div>
	);
}
