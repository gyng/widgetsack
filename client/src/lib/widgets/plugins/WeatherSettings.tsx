import { useSettingsOperations } from './useSettingsOperations';
// The Weather plugin's settings pane (studio → Plugins → Weather). A container (AGENTS.md §6): owns
// the form state, drives the Tauri commands via weather-commands.ts. Open-Meteo is keyless, so this is
// just a location + units + refresh form. The live badge reads the `weather.status` telemetry sample
// through the hub, the same path meters use. Reuses the shared `has-*` settings styling.
import { useEffect, useState } from 'react';
import { useTelemetryHub } from '../telemetryContext';
import { useSensor } from '../useSensor';
import { haStatusBadge } from '../../core/haStatus';
import {
	weatherConfigStatus,
	saveWeatherConfig,
	weatherConnect,
	weatherReconnect
} from './weather-commands';

export default function WeatherSettings() {
	const hub = useTelemetryHub();
	const status = useSensor(hub, 'weather.status');
	const statusText = status.value?.kind === 'text' ? status.value.value : null;
	const badge = haStatusBadge(statusText);

	const [lat, setLat] = useState('');
	const [lon, setLon] = useState('');
	const [unit, setUnit] = useState('celsius');
	const [poll, setPoll] = useState(15); // minutes (the backend stores seconds)
	const [configured, setConfigured] = useState(false);
	const { saving, saved, error: saveError, invalidate, capture, save } = useSettingsOperations();

	useEffect(() => {
		let alive = true;
		const current = capture();
		weatherConnect().catch(() => undefined);
		weatherConfigStatus()
			.then((s) => {
				if (!alive || !current()) return;
				setLat(s.latitude ? String(s.latitude) : '');
				setLon(s.longitude ? String(s.longitude) : '');
				setUnit(s.unit || 'celsius');
				setPoll(Math.round((s.pollSeconds || 900) / 60));
				setConfigured(s.configured);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [capture]);

	const latN = parseFloat(lat);
	const lonN = parseFloat(lon);
	const latValid = Number.isFinite(latN) && latN >= -90 && latN <= 90;
	const lonValid = Number.isFinite(lonN) && lonN >= -180 && lonN <= 180;
	const valid = latValid && lonValid;

	const dirtied = invalidate;

	const onSave = async () => {
		/* v8 ignore next -- the only Save control is disabled for invalid or in-flight submissions. */
		if (!valid || saving) return;
		await save(
			async () => {
				await saveWeatherConfig({
					latitude: latN,
					longitude: lonN,
					unit,
					pollSeconds: Math.max(5, poll) * 60
				});
				await weatherReconnect();
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

			<div className="rp-hd">Location</div>
			<div className="has-help">
				Weather comes from <a href="https://open-meteo.com">Open-Meteo</a> — free, no API key. Enter
				your latitude / longitude (search your city on open-meteo.com to find them). Stored locally;
				the fetch runs on the Rust side.
			</div>

			<label className="has-field">
				Latitude
				<input
					type="text"
					inputMode="decimal"
					placeholder="51.5072"
					value={lat}
					aria-invalid={lat !== '' && !latValid}
					onChange={(e) => {
						setLat(e.currentTarget.value);
						dirtied();
					}}
				/>
				{lat !== '' && !latValid && (
					<small className="has-field-err">Must be a number between −90 and 90.</small>
				)}
			</label>
			<label className="has-field">
				Longitude
				<input
					type="text"
					inputMode="decimal"
					placeholder="-0.1276"
					value={lon}
					aria-invalid={lon !== '' && !lonValid}
					onChange={(e) => {
						setLon(e.currentTarget.value);
						dirtied();
					}}
				/>
				{lon !== '' && !lonValid && (
					<small className="has-field-err">Must be a number between −180 and 180.</small>
				)}
			</label>
			<label className="has-field">
				Units
				<select
					value={unit}
					onChange={(e) => {
						setUnit(e.currentTarget.value);
						dirtied();
					}}
				>
					<option value="celsius">Celsius (°C, km/h)</option>
					<option value="fahrenheit">Fahrenheit (°F, mph)</option>
				</select>
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
				Drop a <strong>Weather</strong> widget (its plugin category in the palette), or bind{' '}
				<code>weather.*</code> sensors on any meter.
			</div>
		</div>
	);
}
