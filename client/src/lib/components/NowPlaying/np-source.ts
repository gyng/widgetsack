// The now-playing data SOURCE: a SensorSource that bridges the media feed (mediaStore) into the
// telemetry hub so the active track's values (np.title, np.progress, …) are bindable by any
// Text/Gauge/Sparkline widget. Outer-ring adapter, mirroring telemetry/source.ts — it touches the
// hub + the store, not React. Registered (silently) via the now-playing plugin's `sources`, so it
// starts alongside the built-in `system` source through startAllSources(hub).

import type { SensorSource } from '../../core/plugin';
import type { TelemetryHub } from '../../core/telemetry';
import { mediaStore } from '../../../stores/stores';
import { filterIgnored, sortSessionsByPriority } from './priority';
import { startMediaSource } from './source';
import { mediaSensorSamples, NP_SENSOR_IDS } from './sensors';

export const npSource: SensorSource = {
	id: 'now-playing',
	start: async (hub: TelemetryHub) => {
		// Make sure the media feed is flowing into mediaStore (idempotent), then mirror the active
		// session into the hub on every change. Re-derives selection the same way the widget does
		// (ignore filter + priority sort) so the sensors track exactly what's shown.
		await startMediaSource();
		const push = () => {
			const s = mediaStore.getSnapshot();
			const active = sortSessionsByPriority(
				filterIgnored(s.sessions, s.ignoreList),
				s.sourcePriority
			).at(0);
			hub.ingestBatch(mediaSensorSamples(active, Date.now()));
		};
		push(); // seed once so np.* have a value before the first media event
		return mediaStore.subscribe(push);
	},
	catalog: () => NP_SENSOR_IDS
};
