// The Agenda plugin's settings pane (studio → Plugins → Agenda). A container (AGENTS.md §6): owns the
// form state, drives the Tauri commands via agenda-commands.ts. A public ICS URL — nothing secret. The
// live badge reads the `agenda.status` telemetry sample through the hub. Reuses the `has-*` styling.
import { useEffect, useState } from 'react';
import { useTelemetryHub } from '../telemetryContext';
import { useSensor } from '../useSensor';
import { haStatusBadge } from '../../core/haStatus';
import {
	agendaConfigStatus,
	saveAgendaConfig,
	agendaConnect,
	agendaDisconnect
} from './agenda-commands';

export default function AgendaSettings() {
	const hub = useTelemetryHub();
	const status = useSensor(hub, 'agenda.status');
	const statusText = status.value?.kind === 'text' ? status.value.value : null;
	const badge = haStatusBadge(statusText);

	const [url, setUrl] = useState('');
	const [title, setTitle] = useState('');
	const [poll, setPoll] = useState(30); // minutes (the backend stores seconds)
	const [configured, setConfigured] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		let alive = true;
		agendaConnect().catch(() => undefined);
		agendaConfigStatus()
			.then((s) => {
				if (!alive) return;
				setUrl(s.url || '');
				setTitle(s.title || '');
				setPoll(Math.round((s.pollSeconds || 1800) / 60));
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

	const valid = /^(https?|webcal):\/\//i.test(url.trim());
	const dirtied = () => setSaved(false);

	const onSave = async () => {
		if (!valid || saving) return;
		setSaving(true);
		try {
			await saveAgendaConfig({ url: url.trim(), title, pollSeconds: Math.max(5, poll) * 60 });
			await agendaDisconnect();
			await agendaConnect();
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

			<div className="rp-hd">Calendar feed</div>
			<div className="has-help">
				A public ICS (iCalendar) URL — most calendars offer a “secret address in iCal format”
				(Google Calendar, Outlook, Fastmail, …). <code>webcal://</code> links work too. The fetch +
				parse run on the Rust side; only the event titles + times cross to the overlay.
			</div>

			<label className="has-field">
				ICS URL
				<input
					type="text"
					inputMode="url"
					placeholder="https://calendar.google.com/…/basic.ics"
					value={url}
					aria-invalid={url !== '' && !valid}
					onChange={(e) => {
						setUrl(e.currentTarget.value);
						dirtied();
					}}
				/>
				{url !== '' && !valid && (
					<small className="has-field-err">Enter an https:// or webcal:// calendar URL.</small>
				)}
			</label>
			<label className="has-field">
				Title (optional)
				<input
					type="text"
					placeholder="Agenda"
					value={title}
					onChange={(e) => {
						setTitle(e.currentTarget.value);
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
				Drop an <strong>Agenda</strong> widget (its plugin category in the palette) to show your
				upcoming events.
			</div>
		</div>
	);
}
