import { describe, expect, it, vi } from 'vitest';
import { createTelemetryHub } from './telemetry';
import {
	listSources,
	registerSource,
	sourceCatalogEntries,
	sourceCatalogIds,
	startAllSources,
	unregisterSource
} from './plugin';

describe('sensor sources', () => {
	it('starts all registered sources against the hub and stops them', async () => {
		let stopped = 0;
		registerSource({
			id: 'fake-a',
			start: async (hub) => {
				hub.ingest({ sensor: 'fake.a', ts_ms: 0, value: { kind: 'scalar', value: 7 } });
				return () => {
					stopped += 1;
				};
			},
			catalog: () => ['fake.a']
		});
		registerSource({
			id: 'fake-b',
			start: async () => () => {
				stopped += 1;
			}
		});

		const hub = createTelemetryHub();
		const stop = await startAllSources(hub);
		expect(hub.sensorIds()).toContain('fake.a');
		stop();
		expect(stopped).toBe(2);
	});

	it('skips (does not reject on) a source whose start() throws, still stopping the rest', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		let stopped = 0;
		registerSource({
			id: 'boom',
			start: async () => {
				throw new Error('unreachable HA');
			}
		});
		registerSource({
			id: 'survivor',
			start: async () => () => {
				stopped += 1;
			}
		});

		const hub = createTelemetryHub();
		const stop = await startAllSources(hub); // must resolve despite 'boom' rejecting
		expect(warn).toHaveBeenCalledWith('source "boom" failed to start', expect.any(Error));
		// stop() runs every source's stopper, including the failed source's no-op (must not throw).
		expect(() => stop()).not.toThrow();
		expect(stopped).toBe(1);
		warn.mockRestore();
		unregisterSource('boom');
		unregisterSource('survivor');
	});

	it('registering by id replaces; catalog ids are the deduped union', () => {
		registerSource({ id: 'dup', start: async () => () => undefined, catalog: () => ['x', 'y'] });
		registerSource({ id: 'dup', start: async () => () => undefined, catalog: () => ['y', 'z'] });
		// 'dup' replaced (one entry), catalog union deduped
		expect(listSources().filter((s) => s.id === 'dup')).toHaveLength(1);
		const ids = sourceCatalogIds();
		expect(ids).toContain('y');
		expect(ids).toContain('z');
		expect(ids.filter((i) => i === 'y')).toHaveLength(1);
	});

	it('sourceCatalogEntries: uses catalogEntries when present, falls back to bare ids, dedupes', () => {
		registerSource({
			id: 'rich',
			start: async () => () => undefined,
			catalog: () => ['ha.light.kitchen'],
			catalogEntries: () => [{ id: 'ha.light.kitchen', label: 'Kitchen Light', unit: undefined }]
		});
		registerSource({
			id: 'plain',
			start: async () => () => undefined,
			catalog: () => ['cpu.total', 'ha.light.kitchen'] // overlaps 'rich' — first (rich) wins
		});

		const entries = sourceCatalogEntries();
		const kitchen = entries.find((e) => e.id === 'ha.light.kitchen');
		expect(kitchen?.label).toBe('Kitchen Light'); // rich entry kept, not the plain fallback
		// A catalog-only source contributes a bare-id entry (no label).
		const cpu = entries.find((e) => e.id === 'cpu.total');
		expect(cpu).toEqual({ id: 'cpu.total' });
		// Deduped: one entry per id.
		expect(entries.filter((e) => e.id === 'ha.light.kitchen')).toHaveLength(1);
	});

	it('unregisterSource drops the source and its catalog entries live (no-op when absent)', () => {
		registerSource({
			id: 'pkg:wx',
			start: async () => () => undefined,
			catalogEntries: () => [{ id: 'pkg.wx.temp', label: 'Temperature' }]
		});
		expect(sourceCatalogEntries().some((e) => e.id === 'pkg.wx.temp')).toBe(true);
		unregisterSource('pkg:wx');
		expect(listSources().some((s) => s.id === 'pkg:wx')).toBe(false);
		expect(sourceCatalogEntries().some((e) => e.id === 'pkg.wx.temp')).toBe(false);
		unregisterSource('pkg:wx'); // absent → no-op, no throw
	});
});
