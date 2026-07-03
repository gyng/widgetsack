// Overlay-role live drag-to-zone + on-demand auto-arrange (MVP2/3). Zones are authored as `zone`
// WIDGETS (widgets.json). This reads the zone widgets for THIS overlay's monitor and snaps foreign
// windows into them: (a) while a window is dragged with Shift held, it highlights the zone under the
// cursor and snaps the window in on release; (b) on `arrange_zones`, it snaps every open window that
// matches a zone's rule. A zone can be FLOATING (its `unit.rect` IS its absolute logical-px rect) or
// DOCKED in the flow tree (the browser positions it — so its rect is MEASURED off the rendered element,
// the same `.world`-relative measurement the click-through sync uses). Self-contained — mounted only on
// overlay windows (not the studio). Outer-ring wiring around the pure core/dragSnap + arrange.
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { currentMonitor } from '@tauri-apps/api/window';
import type { Rect } from '../core/layout';
import { DEFAULT_MONITOR } from '../core/layout';
import type { Zone, ZoneMatch } from '../core/zones';
import { armedZone, collectDockedZoneMatches, localToPhysical, matchOf } from '../core/dragSnap';
import { planArrangement } from '../core/arrange';
import { parseLayoutAny } from '../core/migration';
import { isGroup, type LayoutV2 } from '../core/layoutTree';
import { screenRectToLayout } from '../core/measureMath';
import { loadLayoutRaw, pointerProbe, snapWindow, listWindows, monitorParam } from '../overlay';
import { EVENTS } from '../bridge/contract';
import './DragSnapLayer.css';

const POLL_MS = 33; // ~30Hz cursor poll while a drag is in progress

type DragPayload = { hwnd: number };
type Mon = { pos: { x: number; y: number }; scale: number };
type ZoneSet = { phys: Zone[]; localById: Map<string, Rect> };

/** Parse the FLOATING `zone` widgets for `key` into physical-px zones (+ a local-rect map for the
 * highlight). A floating zone carries its own absolute `unit.rect`; DOCKED zones are handled separately
 * (their rect is measured off the rendered DOM, since the CSS flow positions them). */
function readFloatingZones(layout: LayoutV2 | null, key: string, mon: Mon): ZoneSet {
	const phys: Zone[] = [];
	const localById = new Map<string, Rect>();
	const monitor = layout?.monitors[key];
	if (!monitor) return { phys, localById };
	for (const lf of monitor.floating) {
		const unit = lf.unit;
		if (isGroup(unit) || unit.type !== 'zone') continue;
		localById.set(unit.id, unit.rect);
		phys.push({
			id: unit.id,
			rect: localToPhysical(unit.rect, mon.pos, mon.scale),
			match: matchOf(unit.config)
		});
	}
	return { phys, localById };
}

export default function DragSnapLayer() {
	const [highlight, setHighlight] = useState<Rect | null>(null);
	// Cached from widgets.json (refreshed on layout_changed): the floating zones (rect known up front)
	// plus the docked zones' match rules (their rects are measured from the DOM at drag/arrange time).
	const floatPhysRef = useRef<Zone[]>([]);
	const floatLocalRef = useRef<Map<string, Rect>>(new Map());
	const dockedMatchRef = useRef<Map<string, ZoneMatch | undefined>>(new Map());
	const monRef = useRef<Mon>({ pos: { x: 0, y: 0 }, scale: 1 });
	// The zone set SNAPSHOTTED at drag start (floating + measured-docked); read by the poll tick.
	const physRef = useRef<Zone[]>([]);
	const localRef = useRef<Map<string, Rect>>(new Map());
	const hoveredRef = useRef<Zone | null>(null);
	const pollRef = useRef<number | null>(null);
	const busyRef = useRef(false);

	// This overlay's monitor geometry + its zone widgets; reload on layout_changed.
	useEffect(() => {
		let alive = true;
		const key = monitorParam() ?? DEFAULT_MONITOR;

		const reload = async () => {
			const raw = await loadLayoutRaw();
			if (!alive) return;
			let layout: LayoutV2 | null = null;
			try {
				layout = raw ? parseLayoutAny(JSON.parse(raw)) : null;
			} catch {
				layout = null;
			}
			const set = readFloatingZones(layout, key, monRef.current);
			floatPhysRef.current = set.phys;
			floatLocalRef.current = set.localById;
			dockedMatchRef.current = collectDockedZoneMatches(layout, key);
		};

		currentMonitor().then((m) => {
			if (!alive) return;
			if (m) monRef.current = { pos: { x: m.position.x, y: m.position.y }, scale: m.scaleFactor };
			reload();
		});

		const unlisten = listen(EVENTS.layoutChanged, reload);
		return () => {
			alive = false;
			unlisten.then((u) => u());
		};
	}, []);

	// Drag lifecycle: poll the cursor between win_drag_start and win_drag_end; highlight + snap.
	// Plus arrange_zones: snap every matching open window into its zone.
	useEffect(() => {
		const stopPoll = () => {
			if (pollRef.current !== null) {
				window.clearInterval(pollRef.current);
				pollRef.current = null;
			}
		};

		// Measure the DOCKED zones' rendered rects off the overlay's `.world` (the stable monitor-local
		// origin the click-through sync also rebases to), converting each to physical px. Floating zones
		// already carry their rect, so they're skipped here. Called when a drag/arrange begins (the
		// layout is settled by then). `.world`/elements absent, no docked zones, or a collapsed
		// (zero-size) docked zone → contributes nothing; the floating set still stands.
		const measureDocked = (): ZoneSet => {
			const phys: Zone[] = [];
			const localById = new Map<string, Rect>();
			const matches = dockedMatchRef.current;
			const world = matches.size ? document.querySelector('.world') : null;
			const w0 = world?.getBoundingClientRect();
			if (!world || !w0) return { phys, localById };
			const mon = monRef.current;
			world.querySelectorAll<HTMLElement>('[data-type="zone"]').forEach((el) => {
				const id = el.getAttribute('data-w');
				if (!id || !matches.has(id)) return; // floating zones aren't in the docked-match map
				const local = screenRectToLayout(el.getBoundingClientRect(), w0, 1);
				if (local.w < 1 || local.h < 1) return; // collapsed/hidden docked zone — not a snap target
				localById.set(id, local);
				phys.push({ id, rect: localToPhysical(local, mon.pos, mon.scale), match: matches.get(id) });
			});
			return { phys, localById };
		};

		// The live zone set: the cached floating zones + the freshly measured docked zones.
		const gatherZones = (): ZoneSet => {
			const docked = measureDocked();
			return {
				phys: [...floatPhysRef.current, ...docked.phys],
				localById: new Map([...floatLocalRef.current, ...docked.localById])
			};
		};

		const tick = async () => {
			if (busyRef.current) return; // don't overlap probes if one is slow
			busyRef.current = true;
			try {
				const z = armedZone(physRef.current, await pointerProbe());
				hoveredRef.current = z;
				setHighlight(z ? (localRef.current.get(z.id) ?? null) : null);
			} finally {
				busyRef.current = false;
			}
		};

		const startP = listen<DragPayload>(EVENTS.winDragStart, () => {
			hoveredRef.current = null;
			const g = gatherZones(); // snapshot floating + docked zone rects for the duration of the drag
			physRef.current = g.phys;
			localRef.current = g.localById;
			stopPoll();
			pollRef.current = window.setInterval(tick, POLL_MS);
		});

		const endP = listen<DragPayload>(EVENTS.winDragEnd, async (e) => {
			stopPoll();
			const zone = hoveredRef.current;
			hoveredRef.current = null;
			setHighlight(null);
			if (zone) await snapWindow(e.payload.hwnd, zone.rect);
		});

		const arrangeP = listen(EVENTS.arrangeZones, async () => {
			const plans = planArrangement(gatherZones().phys, await listWindows());
			for (const p of plans) await snapWindow(p.hwnd, p.rect);
		});

		return () => {
			stopPoll();
			startP.then((u) => u());
			endP.then((u) => u());
			arrangeP.then((u) => u());
		};
	}, []);

	return highlight ? (
		<div
			className="zone-drag-highlight"
			style={{
				left: highlight.x,
				top: highlight.y,
				width: highlight.w,
				height: highlight.h
			}}
		/>
	) : null;
}
