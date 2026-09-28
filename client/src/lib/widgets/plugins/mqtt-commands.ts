// The MQTT Tauri command adapter (outer ring) — every `invoke` behind a typed function, so the
// source + settings panel share the command-name strings and tests can mock this module. The
// password is passed INWARD only (save); it is never returned (see mqtt-types.ts).

import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';
import type { MqttCatalogEntry, MqttStatus } from './mqtt-types';

export type MqttConfigInput = {
	host: string;
	port: number;
	username: string;
	password: string; // blank = keep the saved one
	clientId: string;
	topics: string[];
	tls: boolean;
	insecure: boolean;
	discovery: boolean;
};

/** Non-secret config status — never the password. */
export const mqttConfigStatus = (): Promise<MqttStatus> =>
	invoke<MqttStatus>(COMMANDS.mqttConfigStatus);

/** Persist `plugins/mqtt.json`. A blank `password` keeps the previously-saved one. */
export const saveMqttConfig = (cfg: MqttConfigInput): Promise<void> =>
	invoke(COMMANDS.saveMqttConfig, { ...cfg });

/** Start the MQTT client iff configured (idempotent). */
export const mqttConnect = (): Promise<void> => invoke(COMMANDS.mqttConnect);

/** Stop the MQTT client (if any). */
export const mqttDisconnect = (): Promise<void> => invoke(COMMANDS.mqttDisconnect);

/** Seen + discovered topics (id + friendly label + unit) for the inspector dropdown. */
export const mqttCatalog = (): Promise<MqttCatalogEntry[]> =>
	invoke<MqttCatalogEntry[]>(COMMANDS.mqttCatalog);

/** Atomically replace the app-owned worker with the saved configuration (studio only). */
export const mqttReconnect = (): Promise<void> => invoke(COMMANDS.mqttConnect, { restart: true });
