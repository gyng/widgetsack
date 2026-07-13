// The Now Playing plugin's settings pane (studio → Plugins → Now Playing). Two regions, separated
// visually: (1) an EDITABLE "source filtering" region — the priority + ignore lists as structured,
// reorderable/removable rows (with a collapsed raw-text fallback for a process that isn't running
// right now), plus the detected-sources quick-add; and (2) a READ-ONLY "live session" region — the
// active source, the live `np.*` sensor values (which double as the bindable-sensor reference), and
// the active session's supported transport controls. It's a container (reads/writes mediaStore);
// persistence rides mediaStore's localStorage subscriber.
import { useEffect, useMemo, useRef, useState } from 'react';
import { defaultState, mediaStore, type State } from '../../../stores/stores';
import { useStore } from '../../../stores/createStore';
import { filterIgnored, sortSessionsByPriority } from '../../components/NowPlaying/priority';
import {
	appendEntry,
	listEntries,
	moveEntry,
	normalizeList,
	removeAt
} from '../../components/NowPlaying/sourceList';
import {
	getMediaCapabilities,
	startMediaSource,
	type MediaCaps
} from '../../components/NowPlaying/source';
import { mediaSensorSamples } from '../../components/NowPlaying/sensors';
import type { SensorValue } from '../../core/telemetry';
import { copyToClipboard } from '../../overlay';

const CAP_KEYS: (keyof MediaCaps)[] = [
	'play',
	'pause',
	'playpause',
	'stop',
	'next',
	'previous',
	'shuffle',
	'repeat',
	'seek'
];

// Format a live sensor value for the read-out (text as-is, scalar tidied). '—' for empty/idle.
function fmtSensorValue(v: SensorValue): string {
	if (v.kind === 'text') return v.value || '—';
	if (v.kind === 'scalar') return Number.isInteger(v.value) ? String(v.value) : v.value.toFixed(1);
	return '—';
}

export default function NowPlayingSettings() {
	// Ensure the media feed is running in this (studio) window so detected sources + live values
	// populate even when no now-playing widget is on the studio's own layout. Idempotent.
	useEffect(() => {
		void startMediaSource();
	}, []);

	const state = useStore(mediaStore);
	const set = (patch: Partial<State>) => mediaStore.update((s) => ({ ...s, ...patch }));

	// The session the widget would actually show (same selection the widget + np-source use).
	const current = useMemo(
		() =>
			sortSessionsByPriority(
				filterIgnored(state.sessions, state.ignoreList),
				state.sourcePriority
			).at(0),
		[state.sessions, state.ignoreList, state.sourcePriority]
	);

	// The active session's np.* values — the SAME derivation the bridge ingests, so this table is
	// both the live read-out and the documentation of what each sensor emits (ts irrelevant here).
	const sensorRows = useMemo(() => mediaSensorSamples(current, 0), [current]);

	const priorityEntries = useMemo(() => listEntries(state.sourcePriority), [state.sourcePriority]);
	const ignoreEntries = useMemo(() => listEntries(state.ignoreList), [state.ignoreList]);

	// Lowercased ids of sources detected right now — used to flag which list entries are currently
	// active (an inactive entry is one whose process isn't running; edit those via the text fallback).
	const detectedLower = useMemo(
		() =>
			Object.values(state.sessions)
				.map((r) => (r?.source ?? '').toLowerCase())
				.filter(Boolean),
		[state.sessions]
	);
	const entryActive = (entry: string) => detectedLower.some((s) => s.includes(entry.toLowerCase()));

	const ignoreTerms = useMemo(() => ignoreEntries.map((t) => t.toLowerCase()), [ignoreEntries]);

	// Distinct detected sources, alphabetical with ignored ones grouped last (the quick-add helper).
	const detected = useMemo(() => {
		const sources = new Set<string>();
		for (const rec of Object.values(state.sessions)) {
			if (rec?.source) sources.add(rec.source);
		}
		const off = (s: string) => ignoreTerms.some((t) => s.toLowerCase().includes(t));
		return Array.from(sources, (source) => ({ source, off: off(source) })).sort(
			(a, b) => Number(a.off) - Number(b.off) || a.source.localeCompare(b.source)
		);
	}, [state.sessions, ignoreTerms]);

	// Drag-to-reorder the priority list (mouse); ↑/↓ buttons give the keyboard-accessible path.
	const dragIndex = useRef<number | null>(null);
	const dropPriority = (to: number) => {
		const from = dragIndex.current;
		dragIndex.current = null;
		if (from === null || from === to) return;
		set({ sourcePriority: moveEntry(state.sourcePriority, from, to) });
	};

	// Which transport controls the active session supports (null off-Windows / no session / in tests).
	const [caps, setCaps] = useState<MediaCaps | null>(null);
	useEffect(() => {
		let alive = true;
		getMediaCapabilities(current?.source).then((c) => {
			if (alive) setCaps(c);
		});
		return () => {
			alive = false;
		};
	}, [current?.source]);

	// Two-step reset (no window.confirm): first click arms for 3s, a second click within commits.
	const [armed, setArmed] = useState(false);
	const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (armTimer.current) clearTimeout(armTimer.current);
		},
		[]
	);
	const onReset = () => {
		if (!armed) {
			setArmed(true);
			armTimer.current = setTimeout(() => setArmed(false), 3000);
			return;
		}
		if (armTimer.current) clearTimeout(armTimer.current);
		setArmed(false);
		// Keep the live sessions; restore only the saved settings.
		mediaStore.update((s) => ({ ...defaultState, sessions: s.sessions }));
	};

	const dot = (entry: string) => (
		<span
			className={['nps-dot', entryActive(entry) && 'on'].filter(Boolean).join(' ')}
			title={entryActive(entry) ? 'running now' : 'not running now'}
			aria-hidden="true"
		/>
	);

	return (
		<div className="nps">
			{/* ── Editable region: source filtering ── */}
			<div className="nps-config">
				<div className="nps-help nps-intro">
					Choose which media source the widget shows. Priority ranks sources (top wins); the ignore
					list hides them entirely.
				</div>

				<div className="rp-hd">Source priority</div>
				<div className="nps-help">
					Drag (or use ↑ ↓) to reorder — top = preferred. Add a running app from “Detected sources”
					below; for one that isn’t running now, use “Edit as text”.
				</div>
				{priorityEntries.length ? (
					<ul className="nps-entries" aria-label="Source priority order">
						{priorityEntries.map((entry, i) => (
							<li
								key={`${i}-${entry}`}
								className="nps-entry"
								draggable
								onDragStart={() => {
									dragIndex.current = i;
								}}
								onDragOver={(e) => e.preventDefault()}
								onDrop={() => dropPriority(i)}
								onDragEnd={() => {
									dragIndex.current = null;
								}}
							>
								<span className="nps-grip" aria-hidden="true">
									⠿
								</span>
								{dot(entry)}
								<span className="nps-entry-id" title={entry}>
									{entry}
								</span>
								<button
									type="button"
									className="nps-mini"
									aria-label={`Move ${entry} up`}
									disabled={i === 0}
									onClick={() => set({ sourcePriority: moveEntry(state.sourcePriority, i, i - 1) })}
								>
									↑
								</button>
								<button
									type="button"
									className="nps-mini"
									aria-label={`Move ${entry} down`}
									disabled={i === priorityEntries.length - 1}
									onClick={() => set({ sourcePriority: moveEntry(state.sourcePriority, i, i + 1) })}
								>
									↓
								</button>
								<button
									type="button"
									className="nps-mini nps-x"
									aria-label={`Remove ${entry} from priority`}
									onClick={() => set({ sourcePriority: removeAt(state.sourcePriority, i) })}
								>
									✕
								</button>
							</li>
						))}
					</ul>
				) : (
					<div className="nps-help">No priority set — sources rank by most-recently-active.</div>
				)}
				<details className="nps-raw">
					<summary>✎ Edit as text (add an app that isn’t running now)</summary>
					<textarea
						className="nps-area"
						rows={4}
						spellCheck={false}
						aria-label="Source priority list, one id per line"
						value={state.sourcePriority}
						onChange={(e) => set({ sourcePriority: e.currentTarget.value })}
						onBlur={(e) => set({ sourcePriority: normalizeList(e.currentTarget.value) })}
					/>
				</details>

				<div className="rp-hd">Ignore list</div>
				<div className="nps-help">
					Sources to hide entirely. Each entry matches as a case-insensitive substring, so
					<code> foobar2000</code> blocks <code>foobar2000.exe</code>.
				</div>
				{ignoreEntries.length ? (
					<ul className="nps-entries" aria-label="Ignored sources">
						{ignoreEntries.map((entry, i) => (
							<li key={`${i}-${entry}`} className="nps-entry">
								{dot(entry)}
								<span className="nps-entry-id" title={entry}>
									{entry}
								</span>
								<button
									type="button"
									className="nps-mini nps-x"
									aria-label={`Remove ${entry} from the ignore list`}
									onClick={() => set({ ignoreList: removeAt(state.ignoreList, i) })}
								>
									✕
								</button>
							</li>
						))}
					</ul>
				) : (
					<div className="nps-help">Nothing ignored.</div>
				)}
				<details className="nps-raw">
					<summary>✎ Edit as text (add an app that isn’t running now)</summary>
					<textarea
						className="nps-area"
						rows={3}
						spellCheck={false}
						aria-label="Ignore list, one id per line"
						value={state.ignoreList}
						onChange={(e) => set({ ignoreList: e.currentTarget.value })}
						onBlur={(e) => set({ ignoreList: normalizeList(e.currentTarget.value) })}
					/>
				</details>

				<button
					type="button"
					className={['rp-danger', armed && 'nps-armed'].filter(Boolean).join(' ')}
					title="Reset the source priority + ignore lists to defaults"
					onClick={onReset}
				>
					{armed ? '↺ Click again to confirm reset' : '↺ Reset settings (priority + ignore)'}
				</button>

				<div className="rp-hd">Detected sources</div>
				{detected.length ? (
					<ul className="nps-sources" aria-label="Detected media sources">
						{detected.map((d) => (
							<li
								key={d.source}
								className={['nps-source', d.off && 'off'].filter(Boolean).join(' ')}
							>
								{d.source === current?.source && <span className="nps-badge-now">NOW</span>}
								<span className="nps-src-id" title={d.source}>
									{d.off && <span className="sr-only">(ignored) </span>}
									{d.source}
								</span>
								<button
									type="button"
									className="nps-add nps-priority"
									aria-label={`Add ${d.source} to the priority list`}
									onClick={() =>
										set({ sourcePriority: appendEntry(state.sourcePriority, d.source) })
									}
								>
									＋ priority
								</button>
								<button
									type="button"
									className="nps-add nps-ignore"
									aria-label={`Add ${d.source} to the ignore list`}
									disabled={d.off}
									title={
										d.off
											? 'Already ignored — remove it from the ignore list to re-enable'
											: undefined
									}
									onClick={() => set({ ignoreList: appendEntry(state.ignoreList, d.source) })}
								>
									＋ ignore
								</button>
							</li>
						))}
					</ul>
				) : (
					<div className="nps-help">
						No media sources detected yet — start playing in Spotify, foobar2000, a browser, or
						another app and it will appear here.
					</div>
				)}
			</div>

			{/* ── Read-only region: live session ── */}
			<div className="nps-live">
				<div className="rp-hd">Active session</div>
				<div className="nps-cur" aria-live="polite" aria-atomic="true">
					Currently showing: <span>{current?.source || '—'}</span>
				</div>

				<div className="rp-hd">Live values (bindable sensors)</div>
				<div className="nps-help">
					Bind any id below to a Text, Gauge or Sparkline widget from its sensor dropdown.
				</div>
				<div className="nps-readout">
					{sensorRows.map((s) => (
						<div key={s.sensor} className="nps-sensor">
							<code className="nps-sensor-id">{s.sensor}</code>
							<span className="nps-sensor-val">{fmtSensorValue(s.value)}</span>
							<button
								type="button"
								className="nps-copy"
								aria-label={`Copy sensor id ${s.sensor}`}
								title="Copy sensor id"
								onClick={() => {
									void copyToClipboard(s.sensor);
								}}
							>
								⧉
							</button>
						</div>
					))}
				</div>

				<div className="rp-hd">Supported controls</div>
				{caps ? (
					<div className="nps-caps">
						{CAP_KEYS.map((k) => (
							<span key={k} className={['nps-cap', caps[k] ? 'yes' : 'no'].join(' ')}>
								{caps[k] ? '✓' : '✗'} {k}
							</span>
						))}
					</div>
				) : (
					<div className="nps-help">
						{current ? 'Controls unavailable for this session.' : 'No active session.'}
					</div>
				)}
			</div>
		</div>
	);
}
