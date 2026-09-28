import { describe, expect, it, vi } from 'vitest';
import { createTelemetryHub } from '../../core/telemetry';
const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) =>
	command === 'stocks_config_status' ? { symbols: [] } : []
);
vi.mock('@tauri-apps/api/core', () => ({
	invoke: (...args: [string, Record<string, unknown>?]) => invoke(...args)
}));
vi.mock('./ha-backfill', () => ({ startHaBackfill: () => () => undefined }));
import { haSource } from './ha-source';
import { stocksSource } from './stocks-source';
import { mqttSource } from './mqtt-source';
import { weatherSource } from './weather-source';
import { rssSource } from './rss-source';
import { agendaSource } from './agenda-source';
describe('app-owned integration workers', () => {
	it.each([haSource, stocksSource, mqttSource, weatherSource, rssSource, agendaSource])(
		'$id: releasing one window does not stop the shared backend worker',
		async (source) => {
			invoke.mockClear();
			const stopFirst = await source.start(createTelemetryHub());
			const stopSecond = await source.start(createTelemetryHub());
			stopFirst();
			expect(invoke.mock.calls.some(([name]) => name.endsWith('_disconnect'))).toBe(false);
			stopSecond();
			expect(invoke.mock.calls.some(([name]) => name.endsWith('_disconnect'))).toBe(false);
		}
	);
});

import { haReconnect } from './ha-commands';
import { stocksReconnect } from './stocks-commands';
import { mqttReconnect } from './mqtt-commands';
import { weatherReconnect } from './weather-commands';
import { rssReconnect } from './rss-commands';
import { agendaReconnect } from './agenda-commands';
it.each([
	['ha_connect', haReconnect] as const,
	['stocks_connect', stocksReconnect] as const,
	['mqtt_connect', mqttReconnect] as const,
	['weather_connect', weatherReconnect] as const,
	['rss_connect', rssReconnect] as const,
	['agenda_connect', agendaReconnect] as const
])('restarts %s in one backend transition', async (command, reconnect) => {
	invoke.mockClear();
	await reconnect();
	expect(invoke).toHaveBeenCalledWith(command, { restart: true });
});
