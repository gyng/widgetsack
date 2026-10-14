// Framework-agnostic layout types. The versioned `Layout` is what `widgets.json`
// (de)serializes to in Phase 3; for now Canvas hardcodes a list of instances.
// No Svelte/Tauri imports — reused as-is by a future React port.

import type { Tokens } from './tokens';

export type Rect = { x: number; y: number; w: number; h: number };

export type WidgetInstance = {
	id: string;
	type: string; // 'gauge' | 'bar' | 'sparkline' | 'clock' | 'text' | 'nowplaying'
	sensor?: string; // omitted for self-sourcing meters (e.g. clock)
	rect: Rect;
	layer?: 'top' | 'desktop'; // z-layer (3c); default 'top'. desktop layer lands in Phase 4
	interactive?: boolean; // catches clicks in passive mode (per-widget click-through)
	config: Record<string, unknown>;
	css?: string;
	// Per-widget theme-token overrides (scoped to [data-w] by assembleStyles, beating the global
	// :root tokens for just this widget). Frontend-owned; rides the unit through migration/persist.
	tokens?: Tokens;
};

export type MonitorLayout = { widgets: WidgetInstance[] };

export type Layout = {
	version: number;
	monitors: Record<string, MonitorLayout>; // key = monitor id
};

export const LAYOUT_VERSION = 1;
export const DEFAULT_MONITOR = 'default';

export function defaultLayout(): Layout {
	return { version: LAYOUT_VERSION, monitors: { [DEFAULT_MONITOR]: { widgets: [] } } };
}

function isWidgetInstance(w: unknown): w is WidgetInstance {
	if (typeof w !== 'object' || w === null) return false;
	const o = w as Record<string, unknown>;
	return (
		typeof o.id === 'string' &&
		typeof o.type === 'string' &&
		typeof o.rect === 'object' &&
		o.rect !== null &&
		typeof o.config === 'object' &&
		o.config !== null
	);
}

/**
 * Validate raw JSON into a Layout. Returns null on structural failure (so the
 * caller can fall back to a default); individually malformed widgets are dropped
 * rather than failing the whole layout. Pure — unit-tested, no I/O.
 */
export function parseLayout(raw: unknown): Layout | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.version !== 'number') return null;
	if (typeof obj.monitors !== 'object' || obj.monitors === null) return null;

	const monitors: Record<string, MonitorLayout> = {};
	for (const [key, mon] of Object.entries(obj.monitors as Record<string, unknown>)) {
		// JSON.parse keeps "__proto__" as an own key; assigning it would rewrite the map's prototype.
		if (key === '__proto__') continue;
		if (typeof mon !== 'object' || mon === null) return null;
		const widgets = (mon as Record<string, unknown>).widgets;
		if (!Array.isArray(widgets)) return null;
		monitors[key] = { widgets: widgets.filter(isWidgetInstance) };
	}

	return { version: obj.version, monitors };
}

// `createWidget` + the widget-type list moved to ./widget.ts (the standard widget API,
// Phase 8a). Import them from there: `import { createWidget, listMetas } from './widget'`.
