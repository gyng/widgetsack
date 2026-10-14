// React hook over the framework-agnostic SensorObservable (replaces the Svelte sensorStore
// readable; nothing in core/ changes). `hub.sensor(id).getSnapshot()` returns a referentially
// stable SensorState (same object until a sample arrives), so useSyncExternalStore won't tear.
import { useCallback, useSyncExternalStore } from 'react';
import { emptySensorState, type SensorState, type TelemetryHub } from '../core/telemetry';

const EMPTY = emptySensorState();

export function useSensor(hub: TelemetryHub | null, id: string, enabled = true): SensorState {
	// Memoize by [hub, id] so we only re-subscribe when the sensor id changes (mirrors Svelte's
	// `$: store = sensorStore(hub, id)` recreating the readable on id change).
	const subscribe = useCallback(
		(cb: () => void) => (enabled && hub ? hub.sensor(id).subscribe(cb) : () => undefined),
		[hub, id, enabled]
	);
	const getSnapshot = useCallback(() => hub?.sensor(id).getSnapshot() ?? EMPTY, [hub, id]);
	return useSyncExternalStore(subscribe, getSnapshot);
}
