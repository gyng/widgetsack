import snapshot from './localDesktop.sack.json';
import type { Sack } from './sack';
import type { WidgetDef, MonitorLayout } from './layoutTree';
import { packLayout } from './savedLayout';

export const LOCAL_DESKTOP_SACK = snapshot as Sack;
export const LOCAL_DESKTOP_DEF = snapshot.library.defs[0] as WidgetDef;
export const LOCAL_DESKTOP_PRESET_NAME = 'Built-in: Local desktop';
export function localDesktopMonitor(): MonitorLayout {
	return { root: structuredClone(LOCAL_DESKTOP_DEF.child) as MonitorLayout['root'], floating: [] };
}
export const localDesktopPreset = () =>
	packLayout(localDesktopMonitor(), LOCAL_DESKTOP_PRESET_NAME);
