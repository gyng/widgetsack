import { describe, expect, it, vi } from 'vitest';
import { createTelemetryHub } from '../../core/telemetry';

let releaseEntities: (list: unknown[]) => void = () => undefined;
const invoke = vi.fn(async (command: string) =>
	command === 'list_ha_entities'
		? new Promise<unknown[]>((resolve) => (releaseEntities = resolve))
		: undefined
);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (command: string) => invoke(command) }));
vi.mock('./ha-backfill', () => ({ startHaBackfill: () => () => undefined }));
import { haSource } from './ha-source';

describe('haSource.start', () => {
	it('does not hold app init on the entity catalog fetch (HA unreachable can take seconds)', async () => {
		const outcome = await Promise.race([
			haSource.start(createTelemetryHub()).then((stop) => {
				stop();
				return 'started';
			}),
			new Promise((resolve) => setTimeout(() => resolve('blocked'), 50))
		]);
		expect(outcome).toBe('started');
		// The catalog still lands once the fetch resolves.
		releaseEntities([{ entity_id: 'light.kitchen', friendly_name: 'Kitchen', state: 'on' }]);
		await vi.waitFor(() => expect(haSource.catalog?.()).toEqual(['ha.light.kitchen']));
	});
});
