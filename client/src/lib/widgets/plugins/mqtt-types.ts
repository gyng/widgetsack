// TypeScript mirrors of the MQTT Rust structs that cross the bridge (widgetsack/src/mqtt.rs).
// One place so the field casing stays in lock-step with serde (AGENTS.md §5). The password NEVER
// appears here — it is write-only over the bridge.

/** Non-secret MQTT config status from `mqtt_config_status` — never includes the password. */
export type MqttStatus = {
	configured: boolean;
	host: string;
	port: number;
	username: string;
	client_id: string;
	topics: string[];
	tls: boolean;
	insecure: boolean;
	discovery: boolean;
};

/** One catalog row (seen or discovered topic) from `mqtt_catalog`. */
export type MqttCatalogEntry = {
	id: string; // mqtt.<topic>
	topic: string;
	label: string | null;
	unit: string | null;
};
