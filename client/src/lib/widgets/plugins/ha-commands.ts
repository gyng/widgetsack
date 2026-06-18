// The Home Assistant Tauri command adapter (outer ring). Every `invoke` for the HA proxy lives
// here behind a typed function, so the source (ha-source.ts) and the settings panel (HaSettings)
// share one place that knows the command-name strings and arg shapes — and tests can mock this
// module instead of the raw Tauri bridge. The token is passed INWARD only (save/test); it is
// never returned (see ha-types.ts).

import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';
import type { SensorSample } from '../../core/telemetry';
import type { HaEntity, HaRegistry, HaStatus, HaTestResult } from './ha-types';

/** Whether HA is configured + its URL + the self-signed opt-in — NEVER the token. */
export const haConfigStatus = (): Promise<HaStatus> => invoke<HaStatus>(COMMANDS.haConfigStatus);

/** Persist `plugins/ha.json`. A blank `token` keeps the previously-saved one (write-only field). */
export const saveHaConfig = (
	url: string,
	token: string,
	insecure: boolean,
	basePath: string
): Promise<void> => invoke(COMMANDS.saveHaConfig, { url, token, insecure, basePath });

/** Start the streaming WS task iff configured (idempotent — a second call while running is a no-op). */
export const haConnect = (): Promise<void> => invoke(COMMANDS.haConnect);

/** Stop the streaming WS task (if any). */
export const haDisconnect = (): Promise<void> => invoke(COMMANDS.haDisconnect);

/** The HA entities (REST `/api/states`) for the inspector's sensor dropdown. */
export const listHaEntities = (): Promise<HaEntity[]> =>
	invoke<HaEntity[]>(COMMANDS.listHaEntities);

/** The HA registries (areas/devices/entities) over a short-lived WS, for the device browser. */
export const haRegistrySnapshot = (): Promise<HaRegistry> =>
	invoke<HaRegistry>(COMMANDS.haRegistrySnapshot);

/** Validate an UNSAVED url/token/insecure combo via the WS auth handshake (returns HA version). */
export const haTestConnection = (
	url: string,
	token: string,
	insecure: boolean,
	basePath: string
): Promise<HaTestResult> =>
	invoke<HaTestResult>(COMMANDS.haTestConnection, { url, token, insecure, basePath });

/** Call an HA service (REST `POST /api/services/<domain>/<service>`). */
export const haCallService = (
	domain: string,
	service: string,
	data: Record<string, unknown>
): Promise<unknown> => invoke(COMMANDS.haCallService, { domain, service, data });

/** Numeric history for one entity over [start, end] (ISO-8601 UTC), as `ha.<entity>.state` samples —
 * for sparkline backfill. Returns [] when the entity has no numeric history in the window. */
export const haHistory = (entityId: string, start: string, end: string): Promise<SensorSample[]> =>
	invoke<SensorSample[]>(COMMANDS.haHistory, { entityId, start, end });
