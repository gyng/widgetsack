// The per-package poll loop for sandboxed sensor sources (Phase 2, adapter ring). One loop per
// enabled package with a manifest `source`, owned by packages.ts applyPackage. Each tick:
//
//   sandbox requests() ──▶ host fetch (Rust package_fetch, allowlist enforced server-side)
//        ──▶ sandbox transform(responses) ──▶ validate/cap/namespace (core seams) ──▶ hub
//
// Errors NEVER escape the loop: every failure path lands in a console.warn plus the package's
// implicit `pkg.<id>.status` text sensor ('ok' / 'error: …'), which the Plugins row and any text
// widget can watch like the first-party plugin status sensors.
import {
	packageSensorId,
	validateSourceRequests,
	validateSourceSamples,
	type PluginPackageManifest
} from '../../core/pluginPackage';
import type { SensorSample, TelemetryHub } from '../../core/telemetry';
import { createPackageSandbox, type SandboxResponse } from '../../formula/packageSandbox';
import { packageFetch, readPluginPackageAsset } from './packages-commands';

/** source.js size cap — a poll script is a screenful, not a bundle. */
const MAX_SCRIPT_BYTES = 64 * 1024;

/**
 * Start one package's source: load + compile source.js once, tick immediately, then every
 * `pollSeconds`. Always resolves to a stop function (a broken script just reports an error status
 * and the stop is a no-op beyond the status guard) — the caller doesn't branch on failure.
 */
export async function startPackageSource(
	manifest: PluginPackageManifest,
	hub: TelemetryHub
): Promise<() => void> {
	const src = manifest.source;
	if (!src) return () => undefined;
	const id = manifest.id;
	const statusSensor = packageSensorId(id, 'status');
	let stopped = false;
	const status = (text: string): void => {
		if (stopped) return;
		hub.ingest({ sensor: statusSensor, ts_ms: Date.now(), value: { kind: 'text', value: text } });
	};
	const fail = (reason: string): (() => void) => {
		console.warn(`[pkg ${id}] source not started: ${reason}`);
		status(`error: ${reason}`);
		return () => {
			stopped = true;
		};
	};

	const script = await readPluginPackageAsset(id, src.file);
	if (script == null) return fail(`${src.file} is missing`);
	if (script.length > MAX_SCRIPT_BYTES) return fail(`${src.file} exceeds 64 KiB`);
	const made = await createPackageSandbox(script);
	if (!made.ok) return fail(made.error);
	const sandbox = made.sandbox;
	const declared = manifest.sensors.map((s) => s.id);

	const tick = async (): Promise<void> => {
		if (stopped) return;
		try {
			const req = sandbox.requests();
			if (!req.ok) {
				status(`error: requests() failed: ${req.error}`);
				return;
			}
			const { urls, dropped: droppedUrls } = validateSourceRequests(req.value);
			if (droppedUrls.length) console.warn(`[pkg ${id}] dropped requests:`, droppedUrls);
			// Failures become { status: 0, body: '' } — transform sees every URL it asked for, in
			// order, and decides what a miss means.
			const responses: SandboxResponse[] = await Promise.all(
				urls.map(async (url) => {
					try {
						return await packageFetch(id, url);
					} catch (err) {
						console.warn(`[pkg ${id}] fetch failed`, url, err);
						return { url, status: 0, body: '' };
					}
				})
			);
			if (stopped) return; // stop() during the fetches — the sandbox is already disposed
			const out = sandbox.transform(responses);
			if (!out.ok) {
				status(`error: transform() failed: ${out.error}`);
				return;
			}
			const { samples, dropped } = validateSourceSamples(declared, out.value);
			if (dropped.length) console.warn(`[pkg ${id}] dropped samples:`, dropped);
			const ts = Date.now();
			const batch: SensorSample[] = samples.map((s) => ({
				sensor: packageSensorId(id, s.sensor),
				ts_ms: ts,
				value:
					typeof s.value === 'number'
						? { kind: 'scalar', value: s.value }
						: { kind: 'text', value: s.value }
			}));
			hub.ingestBatch(batch);
			status('ok');
		} catch (err) {
			// Belt-and-braces: nothing above should throw, but the loop must outlive a surprise.
			console.warn(`[pkg ${id}] tick failed`, err);
			status(`error: ${String(err)}`);
		}
	};

	// A slow host can outlast the poll interval: skip a tick while one is in flight so ticks never
	// overlap and a stale transform can't land after (and overwrite) a newer one.
	let inFlight = false;
	const guardedTick = (): void => {
		if (inFlight) return;
		inFlight = true;
		void tick().finally(() => {
			inFlight = false;
		});
	};
	guardedTick();
	const timer = setInterval(guardedTick, src.pollSeconds * 1000);
	return () => {
		stopped = true;
		clearInterval(timer);
		sandbox.dispose();
	};
}
