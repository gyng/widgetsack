// Backend worker lifetime belongs to the app. Window cleanup releases only local subscriptions.
// The MQTT data source (peer to ha-source). A Rust proxy source: the broker connection + password
// live server-side (widgetsack/src/mqtt.rs, plugins/mqtt.json), and topic payloads arrive over the
// EXISTING `telemetry` event as `mqtt.<topic>` samples — ingested by the unchanged hub. This source
// only ensures the connection is running and provides the catalog (seen + discovered topics) for the
// inspector dropdown; it never opens a socket or sees the password.

import type { SensorCatalogEntry, SensorSource } from '../../core/plugin';
import { mqttCatalog, mqttConnect } from './mqtt-commands';
import type { MqttCatalogEntry } from './mqtt-types';

let cached: MqttCatalogEntry[] = [];

const toEntry = (e: MqttCatalogEntry): SensorCatalogEntry => ({
	id: e.id,
	label: e.label ?? e.topic,
	unit: e.unit ?? undefined
});

/** Connect (idempotent) + re-fetch the catalog (seen + discovered topics). Returns the rows so the
 * settings panel can render them; silent on failure (not configured / unreachable). */
export async function refreshMqttCatalog(): Promise<MqttCatalogEntry[]> {
	try {
		await mqttConnect();
		cached = await mqttCatalog();
	} catch {
		// Not configured / unreachable: keep the prior cache.
	}
	return cached;
}

export const mqttSource: SensorSource = {
	id: 'mqtt',
	start: async () => {
		await refreshMqttCatalog();
		return () => undefined;
	},
	catalog: () => cached.map((e) => e.id),
	catalogEntries: () => cached.map(toEntry)
};
