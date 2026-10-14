// Outer-ring adapter: pipes the Tauri `telemetry` event into the framework-agnostic
// hub. The Tauri dependency lives here, not in core/ (AGENTS.md §5). A React port
// reuses this file unchanged (Tauri is infra, not a UI framework).

import * as tauriEvent from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { TelemetryBatch, TelemetryHub } from '../core/telemetry';
import { registerSource, type SensorSource } from '../core/plugin';
import { isStudioWindow } from '../overlay';
import { COMMANDS, EVENTS } from '../bridge/contract';
import { sensorCatalog } from '../core/sensors';

export const TELEMETRY_EVENT = EVENTS.telemetry;

let hardwareCatalog: string[] = [];
/** Coalesce active-set churn (a layout re-render can subscribe many sensors at once). */
const REPORT_DEBOUNCE_MS = 250;

const reportActive = (ids: string[]): void => {
	void invoke(COMMANDS.setActiveSensors, { ids }).catch((err) => {
		console.error('set_active_sensors failed', err);
	});
};

/** Subscribe the hub to backend telemetry, and report which sensors have live UI
 * subscribers so the backend can demand-gate expensive sensors (AGENTS.md #9).
 * Resolves to an unlisten function that tears down the listen, the active-set
 * subscription, and any pending debounce timer. */
export async function startTelemetrySource(hub: TelemetryHub): Promise<tauriEvent.UnlistenFn> {
	// Listen as THIS window: an Any-target listener would also receive the cached batches the backend
	// primes into other windows (`emit_to(label)`), re-ingesting old samples here. Broadcasts
	// (`emit`) still reach a window-targeted listener.
	const label = getCurrentWebviewWindow().label;
	const unlisten = await tauriEvent.listen<TelemetryBatch>(
		TELEMETRY_EVENT,
		(ev) => {
			hub.ingestBatch(ev.payload);
		},
		{ target: { kind: 'WebviewWindow', label } }
	);

	// Discovery reads identifiers only. It does not ask the sampler to collect their values.
	const studio = isStudioWindow();
	reportActive(studio && document.visibilityState === 'hidden' ? [] : hub.activeSensorIds());
	try {
		hardwareCatalog = await invoke<string[]>(COMMANDS.getSystemSensorCatalog);
	} catch (error) {
		console.warn('System sensor discovery failed', error);
	}
	const idsToReport = (): string[] =>
		studio && document.visibilityState === 'hidden' ? [] : hub.activeSensorIds();

	let timer: ReturnType<typeof setTimeout> | null = null;
	const scheduleReport = (): void => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			reportActive(idsToReport());
		}, REPORT_DEBOUNCE_MS);
	};
	const offActive = hub.onActiveChange(scheduleReport);
	const visibilityChanged = (): void => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
		reportActive(idsToReport());
	};
	if (studio) document.addEventListener('visibilitychange', visibilityChanged);
	reportActive(idsToReport()); // catches demand acquired while discovery was pending

	return () => {
		if (timer !== null) clearTimeout(timer);
		offActive();
		unlisten();
		if (studio) document.removeEventListener('visibilitychange', visibilityChanged);
		reportActive([]);
	};
}

/** The built-in `system` source: the Rust `telemetry` feed as a SensorSource (Phase 8b).
 * Importing this module registers it; plugins (e.g. Home Assistant) register their own. */
export const systemSource: SensorSource = {
	id: 'system',
	catalog: () => sensorCatalog(hardwareCatalog),
	start: (hub) => startTelemetrySource(hub)
};

registerSource(systemSource);
