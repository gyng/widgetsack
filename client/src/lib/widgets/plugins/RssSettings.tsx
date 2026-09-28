import { useSettingsOperations } from './useSettingsOperations';
// The RSS plugin's settings pane (studio → Plugins → RSS). A container (AGENTS.md §6): owns the form
// state, drives the Tauri commands via rss-commands.ts. Public feeds, nothing secret. The live badge
// reads the `rss.status` telemetry sample through the hub, the same path meters use. Reuses the shared
// `has-*` settings styling.
import { useEffect, useState } from 'react';
import { useTelemetryHub } from '../telemetryContext';
import { useSensor } from '../useSensor';
import { haStatusBadge } from '../../core/haStatus';
import { rssConfigStatus, saveRssConfig, rssConnect, rssReconnect } from './rss-commands';

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
	const { saving, saved, error: saveError, invalidate, capture, save } = useSettingsOperations();

	useEffect(() => {
		let alive = true;
		const current = capture();
		rssConnect().catch(() => undefined);
		rssConfigStatus()
			.then((s) => {
				if (!alive || !current()) return;
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
	}, [capture]);

	const valid = /^https?:\/\//i.test(url.trim());
	const dirtied = invalidate;

	const onSave = async () => {
		/* v8 ignore next -- the only Save control is disabled for invalid or in-flight submissions. */
		if (!valid || saving) return;
		await save(
			async () => {
				await saveRssConfig({
					url: url.trim(),
					count: Math.max(1, Math.min(30, count)),
					title,
					pollSeconds: Math.max(5, poll) * 60
				});
				await rssReconnect();
			},
			() => setConfigured(true)
		);
	};
	return (
		<div className="has">
			{saveError && <div className="has-test err">Couldn’t save: {saveError}</div>}
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
					aria-invalid={url !== '' && !valid}
					onChange={(e) => {
						setUrl(e.currentTarget.value);
						dirtied();
					}}
				/>
				{url !== '' && !valid && (
					<small className="has-field-err">Enter a full http(s):// feed URL.</small>
				)}
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
			</div>

			<div className="has-help">
				Drop an <strong>RSS</strong> widget (its plugin category in the palette) to show the
				headlines.
			</div>
		</div>
	);
}
