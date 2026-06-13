// The weather Tauri command adapter (outer ring) — every `invoke` behind a typed function so the
// source + settings panel share the command-name strings and tests can mock this module.

import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';
import type { WeatherStatus } from './weather-types';

export type WeatherConfigInput = {
	latitude: number;
	longitude: number;
	unit: string;
	pollSeconds: number;
};

/** The (non-secret) config. */
export const weatherConfigStatus = (): Promise<WeatherStatus> =>
	invoke<WeatherStatus>(COMMANDS.weatherConfigStatus);

/** Persist `plugins/weather.json`. */
export const saveWeatherConfig = (cfg: WeatherConfigInput): Promise<void> =>
	invoke(COMMANDS.saveWeatherConfig, { ...cfg });

/** Start the poll task (idempotent; demand-gated server-side). */
export const weatherConnect = (): Promise<void> => invoke(COMMANDS.weatherConnect);

/** Stop the poll task (if any). */
export const weatherDisconnect = (): Promise<void> => invoke(COMMANDS.weatherDisconnect);
