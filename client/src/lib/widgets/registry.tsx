// Maps a widget `type` to its React component, and pairs the component layer with the
// framework-agnostic metas in core/widget.ts. `registerWidget` is the plugin entry point
// (Phase 8): register a meta + its component in one call. The built-in metas are
// registered by core/widget on load; this attaches their components.

import type { ComponentType } from 'react';
import { getMeta, listMetas, registerMeta, type WidgetMeta } from '../core/widget';
import { asMeter, type MeterComponent, type MeterProps } from './meterProps';
import Gauge from './meters/Gauge';
import Sparkline from './meters/Sparkline';
import Text from './meters/Text';
import Clock from './meters/Clock';
import Calendar from './meters/Calendar';
import Countdown from './meters/Countdown';
import AnalogClock from './meters/AnalogClock';
import Bar from './meters/Bar';
import Button from './meters/Button';
import Cpu from './meters/Cpu';
import Battery from './meters/Battery';
import GpuPanel from './meters/GpuPanel';
import Disks from './meters/Disks';
import TopProcess from './meters/TopProcess';
import NetConnections from './meters/NetConnections';
import Ping from './meters/Ping';
import Wifi from './meters/Wifi';
import Spectrum from './meters/Spectrum';
import Iframe from './meters/Iframe';
import Zone from './meters/Zone';
import Spacer from './meters/Spacer';
import Timer from './meters/Timer';
import Recyclebin from './meters/Recyclebin';
import AudioSwitcherHost from './AudioSwitcherHost';
import VolumeHost from './VolumeHost';

export type { MeterComponent };
export { asMeter };

const components: Record<string, MeterComponent> = {
	gauge: asMeter(Gauge),
	sparkline: asMeter(Sparkline),
	text: asMeter(Text),
	clock: asMeter(Clock),
	calendar: asMeter(Calendar),
	countdown: asMeter(Countdown),
	analogclock: asMeter(AnalogClock),
	bar: asMeter(Bar),
	button: asMeter(Button),
	cpu: asMeter(Cpu),
	battery: asMeter(Battery),
	gpu: asMeter(GpuPanel),
	disks: asMeter(Disks),
	topproc: asMeter(TopProcess),
	netconn: asMeter(NetConnections),
	ping: asMeter(Ping),
	wifi: asMeter(Wifi),
	spectrum: asMeter(Spectrum),
	iframe: asMeter(Iframe),
	zone: asMeter(Zone),
	spacer: asMeter(Spacer),
	timer: asMeter(Timer),
	recyclebin: asMeter(Recyclebin),
	audioswitch: asMeter(AudioSwitcherHost),
	volume: asMeter(VolumeHost)
};

/** Back-compat alias used by WidgetHost (`registry[instance.type]`). */
export const registry = components;

/** Register a plugin widget: its meta (defaults + config schema) + its component. Generic over the
 * component's (narrower) props so a correctly-typed meter registers without casts. */
export function registerWidget<P extends MeterProps>(
	meta: WidgetMeta,
	component: ComponentType<P>
): void {
	registerMeta(meta);
	components[meta.type] = asMeter(component);
}

/** Palette items (registered metas that have a component), in registration order. `category` is
 * the palette group header (builtins declare one; plugin widgets default to the plugin name). */
export function paletteItems(): { type: string; label: string; category?: string }[] {
	return listMetas()
		.filter((m) => components[m.type])
		.map((m) => ({ type: m.type, label: m.label ?? m.type, category: m.category }));
}

export { getMeta };
