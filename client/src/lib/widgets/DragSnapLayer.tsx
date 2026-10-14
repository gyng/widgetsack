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
import {
	armedZone,
	collectDockedZoneMatches,
	localToPhysical,
	matchOf,
	type Pointer
} from '../core/dragSnap';
import { planArrangement } from '../core/arrange';
import { decodeLayoutDocument } from '../core/layoutDocument';
import { isGroup, type LayoutV2 } from '../core/layoutTree';
import { screenRectToLayout } from '../core/measureMath';
import { loadLayoutRaw, pointerProbe, snapWindow, listWindows, monitorParam } from '../overlay';
import { EVENTS } from '../bridge/contract';
import { disposalScope } from '../core/disposalScope';
import './DragSnapLayer.css';

const POLL_MS = 33; // ~30Hz cursor poll while a drag is in progress

type DragPayload = { hwnd: number };
type DragEndPayload = DragPayload & { pointer: Pointer | null };
type Mon = { pos: { x: number; y: number }; scale: number };
type ZoneSet = { phys: Zone[]; localById: Map<string, Rect> };
type ZoneSnapshot = ZoneSet & { revision: number };

/** Parse the FLOATING `zone` widgets for `key` into logical-px zones (+ a local-rect map for the
 * highlight). A floating zone carries its own absolute `unit.rect`; DOCKED zones are handled separately
 * (their rect is measured off the rendered DOM, since the CSS flow positions them). */
function readFloatingZones(layout: LayoutV2 | null, key: string): ZoneSet {
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
			rect: unit.rect,
			match: matchOf(unit.config)
		});
	}
	return { phys, localById };
}

export default function DragSnapLayer() {
	const [highlight, setHighlight] = useState<Rect | null>(null);
	// Cached from widgets.json (refreshed on layout_changed): the floating zones (rect known up front)
	// plus the docked zones' match rules (their rects are measured from the DOM at drag/arrange time).
	const floatZonesRef = useRef<Zone[]>([]);
	const floatLocalRef = useRef<Map<string, Rect>>(new Map());
	const dockedMatchRef = useRef<Map<string, ZoneMatch | undefined>>(new Map());
	const monRef = useRef<Mon>({ pos: { x: 0, y: 0 }, scale: 1 });
	// The zone set SNAPSHOTTED at drag start (floating + measured-docked); read by the poll tick.
	const physRef = useRef<Zone[]>([]);
	const localRef = useRef<Map<string, Rect>>(new Map());
	const pollRef = useRef<number | null>(null);
	const busyRef = useRef(false);
	const zonesCurrent = useRef(false);
	const layoutRevision = useRef(0);
	const dragRevision = useRef(-1);
	const layoutWatching = useRef(false);
	const reloadZones = useRef<(() => Promise<void>) | null>(null);

	// This overlay's monitor geometry + its zone widgets; reload on layout_changed.
	useEffect(() => {
		let alive = true;
		const key = monitorParam() ?? DEFAULT_MONITOR;

		let reloadGeneration = 0;
		const reload = async () => {
			if (!alive) return;
			const at = ++reloadGeneration;
			layoutRevision.current++;
			zonesCurrent.current = false;
			setHighlight(null);
			try {
				const raw = await loadLayoutRaw();
				if (!alive || at !== reloadGeneration) return;
				const decoded = decodeLayoutDocument(raw);
				const valid = decoded.kind === 'valid' ? decoded : null;
				const layout = valid?.layout ?? null;
				const set = readFloatingZones(layout, key);
				floatZonesRef.current = set.phys;
				floatLocalRef.current = set.localById;
				dockedMatchRef.current = collectDockedZoneMatches(layout, key, valid?.library);
				zonesCurrent.current = true;
			} catch (error) {
				if (alive && at === reloadGeneration) console.warn('Zone layout reload failed', error);
			}
		};
		reloadZones.current = reload;
		void currentMonitor()
			.then((m) => {
				if (!alive) return;
				if (m) monRef.current = { pos: { x: m.position.x, y: m.position.y }, scale: m.scaleFactor };
				return reload();
			})
			.catch((error) => {
				if (!alive) return;
				console.warn('Initial zone monitor read failed', error);
				return reload();
			});

		const scope = disposalScope((error) => console.warn('Zone listener cleanup failed', error));
		void listen(EVENTS.layoutChanged, reload)
			.then((unlisten) => {
				if (alive) layoutWatching.current = true;
				scope.add(unlisten);
			})
			.catch((error) => {
				if (alive) console.warn('Zone layout listener registration failed', error);
			});
		return () => {
			alive = false;
			reloadZones.current = null;
			layoutWatching.current = false;
			scope.dispose();
		};
	}, []);

	// Drag lifecycle: poll the cursor between win_drag_start and win_drag_end; highlight + snap.
	// Plus arrange_zones: snap every matching open window into its zone.
	useEffect(() => {
		let alive = true;
		let generation = 0;
		let arrangeGeneration = 0;
		let activeWindow: number | null = null;
		const stopPoll = () => {
			if (pollRef.current !== null) {
				window.clearInterval(pollRef.current);
				pollRef.current = null;
			}
		};

		const failDrag = (at: number, error: unknown) => {
			if (at !== generation) return;
			generation++;
			activeWindow = null;
			stopPoll();
			setHighlight(null);
			console.warn('Zone drag failed', error);
		};

		// Measure the DOCKED zones' rendered rects off the overlay's `.world` (the stable monitor-local
		// origin the click-through sync also rebases to), converting each to physical px. Floating zones
		// already carry their rect, so they're skipped here. Called when a drag/arrange begins (the
		// layout is settled by then). `.world`/elements absent, no docked zones, or a collapsed
		// (zero-size) docked zone → contributes nothing; the floating set still stands.
		const measureDocked = (mon: Mon): ZoneSet => {
			const phys: Zone[] = [];
			const localById = new Map<string, Rect>();
			const matches = dockedMatchRef.current;
			const world = matches.size ? document.querySelector('.world') : null;
			const w0 = world?.getBoundingClientRect();
			if (!world || !w0) return { phys, localById };
			world.querySelectorAll<HTMLElement>('[data-type="zone"]').forEach((el) => {
				const id = el.getAttribute('data-w');
				if (!id || !matches.has(id)) return; // floating zones aren't in the docked-match map
				if (el.closest('[data-hidden]')) return;
				const visibility = getComputedStyle(el).visibility;
				if (visibility === 'hidden' || visibility === 'collapse') return;
				const local = screenRectToLayout(el.getBoundingClientRect(), w0, 1);
				if (local.w < 1 || local.h < 1) return; // collapsed/hidden docked zone — not a snap target
				localById.set(id, local);
				phys.push({ id, rect: localToPhysical(local, mon.pos, mon.scale), match: matches.get(id) });
			});
			return { phys, localById };
		};

		// The live zone set: the cached floating zones + the freshly measured docked zones.
		const gatherZones = async (): Promise<ZoneSnapshot> => {
			if (!zonesCurrent.current || !layoutWatching.current) await reloadZones.current?.();
			if (!zonesCurrent.current)
				return { phys: [], localById: new Map(), revision: layoutRevision.current };
			const monitor = await currentMonitor();
			if (!zonesCurrent.current)
				return { phys: [], localById: new Map(), revision: layoutRevision.current };
			if (monitor) monRef.current = { pos: monitor.position, scale: monitor.scaleFactor };
			const mon = monRef.current;
			const docked = measureDocked(mon);
			return {
				revision: layoutRevision.current,
				phys: [
					...floatZonesRef.current.map((zone) => ({
						...zone,
						rect: localToPhysical(zone.rect, mon.pos, mon.scale)
					})),
					...docked.phys
				],
				localById: new Map([...floatLocalRef.current, ...docked.localById])
			};
		};
		const currentZones = (snapshot: ZoneSnapshot) =>
			zonesCurrent.current && snapshot.revision === layoutRevision.current;

		const tick = async () => {
			if (busyRef.current) return; // don't overlap probes if one is slow
			busyRef.current = true;
			const currentGeneration = generation;
			try {
				if (!zonesCurrent.current) {
					setHighlight(null);
					return;
				}
				if (dragRevision.current !== layoutRevision.current) {
					const snapshot = await gatherZones();
					if (currentGeneration !== generation || !currentZones(snapshot)) return;
					physRef.current = snapshot.phys;
					localRef.current = snapshot.localById;
					dragRevision.current = snapshot.revision;
				}
				const z = armedZone(physRef.current, await pointerProbe());
				if (currentGeneration !== generation) return;
				if (!zonesCurrent.current || dragRevision.current !== layoutRevision.current) {
					setHighlight(null);
					return;
				}
				// Every physical zone has a local rect in the same snapshot; stale generations cannot use it.
				setHighlight(z ? localRef.current.get(z.id)! : null);
			} catch (error) {
				failDrag(currentGeneration, error);
			} finally {
				busyRef.current = false;
			}
		};

		const startP = listen<DragPayload>(EVENTS.winDragStart, async (e) => {
			if (!alive) return;
			generation++;
			activeWindow = e.payload.hwnd;
			setHighlight(null);
			stopPoll();
			const at = generation;
			try {
				const g = await gatherZones();
				if (at !== generation) return;
				physRef.current = g.phys;
				localRef.current = g.localById;
				dragRevision.current = currentZones(g) ? g.revision : -1;
				stopPoll();
				pollRef.current = window.setInterval(tick, POLL_MS);
			} catch (error) {
				failDrag(at, error);
			}
		});

		const endP = listen<DragEndPayload>(EVENTS.winDragEnd, async (e) => {
			if (e.payload.hwnd !== activeWindow) return;
			generation++;
			activeWindow = null;
			stopPoll();
			setHighlight(null);
			const at = generation;
			try {
				const pointer = e.payload.pointer;
				if (!pointer || !pointer.shift) return;
				const zones = await gatherZones();
				if (!alive || at !== generation || !currentZones(zones)) return;
				const zone = armedZone(zones.phys, pointer);
				if (zone) await snapWindow(e.payload.hwnd, zone.rect);
			} catch (error) {
				failDrag(at, error);
			}
		});

		const arrangeP = listen(EVENTS.arrangeZones, async () => {
			if (!alive) return;
			const at = ++arrangeGeneration;
			try {
				const [zones, windows] = await Promise.all([gatherZones(), listWindows()]);
				const plans = planArrangement(zones.phys, windows);
				for (const p of plans) {
					if (!alive || at !== arrangeGeneration || !currentZones(zones)) return;
					await snapWindow(p.hwnd, p.rect);
				}
			} catch (error) {
				if (alive && at === arrangeGeneration) console.warn('Zone arrangement failed', error);
			}
		});

		const scope = disposalScope((error) => console.warn('Zone listener cleanup failed', error));
		const shutdown = () => {
			alive = false;
			generation++;
			activeWindow = null;
			stopPoll();
			scope.dispose();
		};
		for (const registration of [startP, endP, arrangeP]) {
			void registration.then(scope.add).catch((error) => {
				if (!alive) return;
				shutdown();
				setHighlight(null);
				console.warn('Zone drag listener registration failed', error);
			});
		}
		return shutdown;
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
