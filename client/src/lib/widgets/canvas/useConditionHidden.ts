// React hook: which conditional containers are currently HIDDEN, recomputed whenever a referenced
// sensor changes. Unlike useSensors (which flattens json/series to null), this reads full SensorValue
// snapshots — needed because appOpen reads the json window-list sensor and HA conditions read json
// `.state`. The pure work lives in conditionVisibility.ts / condition.ts; this is the reactive glue.
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { Container } from '../../core/layoutTree';
import type { SensorValue, TelemetryHub } from '../../core/telemetry';
import type { WindowDescriptor } from '../../core/windowMatch';
import { WINDOWS_SENSOR, type ConditionContext } from '../../core/condition';
import {
	collectConditions,
	conditionSensorRefs,
	hiddenContainerIds,
	windowsKey
} from './conditionVisibility';

const EMPTY: ReadonlySet<string> = new Set();

/** The open-window list carried by the WINDOWS_SENSOR json value (empty until first polled). */
function windowsOf(v: SensorValue | null | undefined): WindowDescriptor[] {
	return v && v.kind === 'json' && Array.isArray(v.value) ? (v.value as WindowDescriptor[]) : [];
}

/**
 * `active` gates the whole thing: in edit/preview (or the studio) we pass false so conditional
 * content always shows and stays editable, and nothing subscribes. On the passive overlay it's true.
 */
export function useConditionHidden(
	hub: TelemetryHub,
	root: Container,
	active: boolean
): ReadonlySet<string> {
	const conds = useMemo(() => collectConditions(root), [root]);
	// Sensors to subscribe to — gated by `active` so the studio / edit mode doesn't keep a condition's
	// sensor marked active (demand-gating). Identity only changes when the conditions or active flag do.
	const refs = useMemo(
		() => (active && conds.length ? conditionSensorRefs(conds) : []),
		[active, conds]
	);

	const subscribe = useCallback(
		(cb: () => void) => {
			const unsubs = refs.map((id) => hub.sensor(id).subscribe(cb));
			return () => unsubs.forEach((u) => u());
		},
		[hub, refs]
	);
	// Change signature: the window list reduces to a move/z-order-INDEPENDENT key (only the exe/class/
	// title appOpen matches on), so window jitter / alt-tab doesn't re-render the whole flow tree every
	// poll; other sensors stringify their small scalar/text/json value.
	const getSig = useCallback(
		() =>
			refs
				.map((id) => {
					const v = hub.sensor(id).getSnapshot().value;
					return id === WINDOWS_SENSOR ? windowsKey(windowsOf(v)) : JSON.stringify(v);
				})
				.join('|'),
		[hub, refs]
	);
	const sig = useSyncExternalStore(subscribe, getSig, getSig);

	return useMemo(() => {
		if (!active || conds.length === 0) return EMPTY;
		const ctx: ConditionContext = {
			windows: windowsOf(hub.sensor(WINDOWS_SENSOR).getSnapshot().value),
			sensorValue: (id) => hub.sensor(id).getSnapshot().value
		};
		return hiddenContainerIds(conds, ctx);
		// `sig` is the reactive trigger (its value is folded into the snapshot reads above).
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [active, conds, hub, sig]);
}
