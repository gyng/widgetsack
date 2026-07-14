// "Which sensors stay sampled after the studio closes, and why." The studio reports the `*` wildcard
// so the backend samples EVERYTHING while it's open (so the Sensors pane can show live values); on
// close, only sensors an overlay widget actually demands keep sampling (demand-gating, sensors.rs).
//
// This module answers, per sensor id:
//   • who references it — a pure walk of the layout collecting each widget's bound `sensor` + its
//     formula/template references (the "why"); and
//   • whether it's cheap-always-on vs demand-gated — mirroring widgetsack/src/sensors.rs so an
//     UNreferenced sensor is labelled honestly (a cheap one still emits; a gated one stops).
// Pure (no Tauri/React); co-located tests in sensorActivity.test.ts. Keep the gating predicates in
// sync with sensors.rs (a test pins the known ids).

import {
	isContainer,
	isGroup,
	type Library,
	type LayoutNode,
	type MonitorLayout,
	type WidgetInstance
} from './layoutTree';
import { exprFieldsOf, getMeta } from './widget';
import { exprRefs, templateRefs } from './textTemplate';

// ---- demand-gating classification (mirrors widgetsack/src/sensors.rs) -----------------------------

/** A demand-gated SYSTEM sensor: only sampled when a widget references it (or the studio forces all).
 * Mirrors the gate predicates in sensors.rs (gpu_wanted / is_perf_id / is_cpufreq_id / is_disk_io_id
 * / is_netlink_id + the disk/procs/freq gates). */
function isGatedSystemSensor(id: string): boolean {
	if (id.startsWith('gpu.')) return true; // NVML block
	if (id.startsWith('disk.')) return true; // per-disk capacity + I/O
	if (id.startsWith('proc.')) return true; // process-top
	if (id === 'host.procs') return true; // process count
	if (id === 'cpu.freq') return true; // sysinfo base clock
	// perf pool (GetPerformanceInfo): commit / cache / kernel pools + handle/thread totals
	if (
		id.startsWith('mem.commit.') ||
		id === 'mem.cached' ||
		id.startsWith('mem.kernel.') ||
		id === 'host.handles' ||
		id === 'host.threads'
	) {
		return true;
	}
	// live CPU clock (CallNtPowerInformation): summary + per-core .freq
	if (
		id === 'cpu.freq.current' ||
		id === 'cpu.freq.max' ||
		(id.startsWith('cpu.core.') && id.endsWith('.freq'))
	) {
		return true;
	}
	// network link table (GetIfTable2): link speed / adapter / state
	if (id.startsWith('net.linkspeed') || id === 'net.adapter' || id === 'net.state') return true;
	return false;
}

// Cheap system-sensor families sampled every tick regardless of demand (sensors.rs always-on batch).
const ALWAYS_ON_PREFIXES = ['cpu.', 'mem.', 'swap.', 'net.', 'host.', 'battery.'];

/** True if `id` is a cheap system sensor sampled every tick whether or not a widget uses it (so it
 * stays active after the studio closes even when unreferenced). Gated system sensors and plugin
 * sensors (ha.* / stock.* / mqtt.* / …) are NOT always-on — they only survive close if referenced. */
export function isAlwaysOnSensor(id: string): boolean {
	if (isGatedSystemSensor(id)) return false;
	return ALWAYS_ON_PREFIXES.some((p) => id.startsWith(p));
}

// ---- who references each sensor (the "why") ------------------------------------------------------

/** One reason a sensor is demanded: the widget that references it, and how (bound vs in a formula). */
export type SensorRef = {
	widgetType: string;
	widgetId: string;
	monitorKey: string;
	via: 'bound' | 'formula';
};

/** Walk the given monitors' layouts and collect every sensor id a widget references — its bound
 * `sensor` field plus all `{expr}` references in its formula/template config fields — paired with the
 * referencing widget. Group leaves are resolved through the library (or their inline child). Pure. */
export function collectSensorRefs(
	monitors: { key: string; layout: MonitorLayout }[],
	library?: Library
): Map<string, SensorRef[]> {
	const out = new Map<string, SensorRef[]>();
	const add = (sensor: string, ref: SensorRef): void => {
		/* v8 ignore next -- callers only pass truthy bound ids or parsed non-empty expression ids. */
		if (!sensor) return;
		const arr = out.get(sensor);
		if (arr) arr.push(ref);
		else out.set(sensor, [ref]);
	};

	const visit = (inst: WidgetInstance, monitorKey: string): void => {
		if (inst.sensor) {
			add(inst.sensor, { widgetType: inst.type, widgetId: inst.id, monitorKey, via: 'bound' });
		}
		for (const f of exprFieldsOf(getMeta(inst.type))) {
			const src = inst.config?.[f.key];
			if (typeof src !== 'string' || !src) continue;
			const refs = f.result === 'text' ? templateRefs(src) : exprRefs(src);
			for (const r of refs) {
				add(r, { widgetType: inst.type, widgetId: inst.id, monitorKey, via: 'formula' });
			}
		}
	};

	const walk = (node: LayoutNode, monitorKey: string): void => {
		if (isContainer(node)) {
			for (const c of node.children) walk(c, monitorKey);
			return;
		}
		const unit = node.unit;
		if (isGroup(unit)) {
			const child = unit.def ? library?.defs.find((d) => d.id === unit.def)?.child : unit.child;
			if (child) walk(child, monitorKey);
			return;
		}
		visit(unit, monitorKey);
	};

	for (const { key, layout } of monitors) {
		walk(layout.root, key);
		for (const lf of layout.floating) walk(lf, key);
	}
	return out;
}

// ---- the verdict per sensor ----------------------------------------------------------------------

export type SensorActivity = {
	/** Stays sampled after the studio window closes. */
	active: boolean;
	/** Active specifically BECAUSE a widget references it (vs a cheap always-on sensor). */
	referenced: boolean;
	/** Human-readable explanation (the tooltip "why"). */
	reason: string;
};

function summarizeRefs(refs: SensorRef[]): string {
	const seen = new Set<string>();
	const labels: string[] = [];
	for (const r of refs) {
		const label = r.via === 'formula' ? `${r.widgetType} (formula)` : r.widgetType;
		if (seen.has(label)) continue;
		seen.add(label);
		labels.push(label);
	}
	return labels.join(', ');
}

/** Classify a sensor's after-close fate from the reference map: referenced → active (with the
 * widgets named); else cheap-always-on → active; else gated/plugin + unreferenced → stops on close. */
export function sensorActivity(id: string, refs: SensorRef[] | undefined): SensorActivity {
	if (refs && refs.length) {
		return { active: true, referenced: true, reason: `used by ${summarizeRefs(refs)}` };
	}
	if (isAlwaysOnSensor(id)) {
		return { active: true, referenced: false, reason: 'always sampled (a cheap system sensor)' };
	}
	return {
		active: false,
		referenced: false,
		reason: 'sampled only while the studio is open — stops when it closes'
	};
}
