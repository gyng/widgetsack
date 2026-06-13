// Container (organism): positions one widget and wires its sensor to the presentational meter.
// The meter stays prop-only; all subscription lives here. In edit mode a transparent overlay drags
// the widget and corner/edge handles resize it; both report rect changes up via the `onChange`
// callback. The seven Svelte dispatch events become seven callback props.
import {
	memo,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent
} from 'react';
import type { TelemetryHub } from '../core/telemetry';
import type { Rect, WidgetInstance } from '../core/layout';
import { moveRect, resizeRect, type ResizeHandle } from '../core/geometry';
import { exprFieldsOf, getMeta } from '../core/widget';
import { registry } from './registry';
import { useSensor } from './useSensor';
import { useSensorMap } from './useSensorMap';
import { useFormulaFields } from '../formula/useFormula';
import { dragMoveIntent } from './canvas/dragIntent';
import WidgetErrorBoundary from './WidgetErrorBoundary';
import './WidgetHost.css';

type Props = {
	hub: TelemetryHub;
	instance: WidgetInstance;
	editMode?: boolean;
	selected?: boolean;
	// This widget is part of a MULTI-selection (>1 selected). Gives it a focal, on-stage cue (a dashed
	// vs solid outline) so the user can see "more than one is selected" without reading the Inspector —
	// the count-blind Del/nudge slip lives here, where the gaze is.
	multi?: boolean;
	// Cross-highlight from the Outline tree (studio): glow this widget while its tree row is hovered.
	highlighted?: boolean;
	grid?: number;
	// Zoom factor of the surrounding world layer; pointer deltas (screen px) are divided by it.
	scale?: number;
	// Absolute rect to render at (the solver's result); defaults to instance.rect (floating).
	rect?: Rect;
	// Floating widgets free-move/resize; in-flow widgets are solver-positioned (select-only here).
	movable?: boolean;
	// CSS-layout (flow) mode: the widget fills its FlowNode slot (the parent owns position/size)
	// instead of absolutely positioning itself at `rect`. Used by the native-CSS render path.
	flow?: boolean;
	// What clicking selects (a group's descendants select the group), defaults to this widget.
	selectId?: string;
	// Styling hooks: the unique DOM id + the group/def this widget belongs to (data-w/def/group).
	domId?: string;
	defId?: string;
	groupId?: string;
	onChange?: (e: { id: string; rect: Rect }) => void;
	// `skipFlow` (set by a right-button free-move) tells the Canvas not to dock this drag into the
	// flow/grid, regardless of the studio "into grids" toggle.
	onCommit?: (e?: { skipFlow?: boolean }) => void;
	onSelect?: (e: { id: string }) => void;
	onDragOver?: (e: { id: string; x: number; y: number; skipFlow?: boolean }) => void;
	onDrop?: (e: { id: string; x: number; y: number }) => void;
	onContextMenu?: (e: { id: string; x: number; y: number }) => void;
	onControl?: (e: {
		id: string;
		sensor?: string;
		domain: string;
		service: string;
		data?: Record<string, unknown>;
	}) => void;
	// Report hover enter/leave (selectId) so the Canvas can cross-highlight the Outline row.
	onHover?: (id: string | null) => void;
	// Content-fit sizing: render the box at its natural (max-content) size instead of the solved rect,
	// and report the measured size up so the solver can lay out siblings against it (basis 'content').
	contentSize?: boolean;
	onMeasure?: (id: string, size: { w: number; h: number }) => void;
	// Right-button free-move suppresses the trailing contextmenu. Because Chromium fires the
	// contextmenu on whatever is under the cursor at right-up (NOT necessarily this widget, after a
	// grid-snap drift), suppression is armed canvas-side: end() calls onSuppressContextMenu after a
	// real right-drag, and every contextmenu entry point consults suppressContextMenu (consume-once).
	onSuppressContextMenu?: () => void;
	suppressContextMenu?: () => boolean;
};

const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
// A press only becomes a drag past this screen-px slop; below it the press is a click that just
// selects. Without this, clicking an in-flow widget dispatches a `drop` = moves it to a slot.
const DRAG_SLOP = 3;

function WidgetHost({
	hub,
	instance,
	editMode = false,
	selected = false,
	multi = false,
	highlighted = false,
	grid = 8,
	scale = 1,
	rect: rectProp,
	movable = true,
	flow = false,
	selectId: selectIdProp,
	domId: domIdProp,
	defId,
	groupId,
	onChange,
	onCommit,
	onSelect,
	onDragOver,
	onDrop,
	onContextMenu,
	onControl,
	onHover,
	onSuppressContextMenu,
	suppressContextMenu,
	contentSize = false,
	onMeasure
}: Props) {
	const rect = rectProp ?? instance.rect;
	const selectId = selectIdProp ?? instance.id;
	const domId = domIdProp ?? instance.id;

	// Content-fit: observe the box's rendered size and report it (deduped) so the solver can size the
	// flow around it. Guarded for ResizeObserver (absent in the test DOM). Measured at natural size
	// because the box renders width/height:max-content in this mode (see the style below).
	const boxRef = useRef<HTMLDivElement | null>(null);
	const lastMeasured = useRef<{ w: number; h: number } | null>(null);
	useLayoutEffect(() => {
		if (!contentSize || !onMeasure || typeof ResizeObserver === 'undefined') return;
		const el = boxRef.current;
		if (!el) return;
		const report = () => {
			const w = Math.round(el.offsetWidth);
			const h = Math.round(el.offsetHeight);
			const last = lastMeasured.current;
			if (last && last.w === w && last.h === h) return; // dedupe → no solve churn
			lastMeasured.current = { w, h };
			onMeasure(domId, { w, h });
		};
		report();
		const ro = new ResizeObserver(report);
		ro.observe(el);
		return () => ro.disconnect();
	}, [contentSize, onMeasure, domId]);

	// A sentinel id keeps the hook valid for self-sourcing widgets (no sensor).
	const sensorState = useSensor(hub, instance.sensor ?? '__none__');
	// Config-driven multi-sensor binding (WidgetMeta.sensors): resolve the named id map from the
	// instance config and subscribe to each — the meter receives a `sensors` prop (name →
	// SensorState) and stays props-only (AGENTS.md §6). Undefined for single/no-sensor types.
	const sensorIds = useMemo(
		() => getMeta(instance.type)?.sensors?.(instance.config),
		[instance.type, instance.config]
	);
	const sensorMap = useSensorMap(hub, sensorIds);
	// Only passed when the meta declares the binding — never collide with a config key `sensors`
	// (e.g. the AI Briefing's sensor-id CSV) on types that don't.
	const multiSensorProps = sensorIds ? { sensors: sensorMap } : undefined;
	const Comp = registry[instance.type];
	// How this widget binds to its sensor drives the meter's value-shape (Phase 8).
	const binds = getMeta(instance.type)?.binds ?? 'scalar';
	// Interactive (catches clicks in passive mode) if the instance OR its type meta says so — the
	// meta fallback makes a type interactive for already-saved instances without re-creating them.
	const interactive = instance.interactive || getMeta(instance.type)?.interactive;
	const scalar =
		sensorState.value && sensorState.value.kind === 'scalar' ? sensorState.value.value : null;
	const rawValue = sensorState.value ? sensorState.value.value : null;
	const history = sensorState.history;
	// Formula support: evaluate any `kind:'expr'` config fields (e.g. a Gauge `value` of `mem.used / 2`,
	// or a Text template `CPU {round(cpu.total)}%`) in the sandbox and override the matching meter prop.
	// Empty for widgets with no formula fields → the WASM engine never loads (useFormulaFields gates it).
	const exprFields = useMemo(() => exprFieldsOf(getMeta(instance.type)), [instance.type]);
	const { overrides: formulaOverrides } = useFormulaFields(hub, exprFields, instance.config);
	// The config passed to the meter, with the expr fields' OWN keys removed: a formula's config key
	// holds the raw source string (e.g. config.value = "cpu.total / 2"), and for a numeric field that
	// key IS the target prop — so without this the meter would receive the source string as its value
	// during every not-yet-resolved window (engine still loading, sensor unemitted, or eval error),
	// rendering NaN / the literal formula. Stripped → the bound sensor value (or –) shows until the
	// evaluated override lands. (formulaOverrides, spread last, then wins.)
	const meterConfig = useMemo(() => {
		if (exprFields.length === 0) return instance.config;
		const cfg = { ...instance.config };
		for (const f of exprFields) delete cfg[f.key];
		return cfg;
	}, [instance.config, exprFields]);
	// Error-boundary reset key: the widget's user-editable definition (type + config). Changing it
	// in the studio clears a caught crash and re-renders; the live sensor value is intentionally
	// excluded (see WidgetErrorBoundary). type prefixes the JSON object so the pair can't collide.
	const resetKey = useMemo(
		() => `${instance.type} ${JSON.stringify(instance.config)}`,
		[instance.type, instance.config]
	);

	// Authoritative drag bookkeeping in a ref (read synchronously by move/end — no stale closures);
	// only the render-affecting bits (active class + ghost transform) live in state.
	const drag = useRef<{
		action: 'move' | 'flow' | ResizeHandle | null;
		startX: number;
		startY: number;
		startRect: Rect;
		moved: boolean;
		skipFlow: boolean; // a right-button move-drag never docks (free-move)
		wasSelected: boolean; // selected at press → defer the select so a drag can move the group
	}>({
		action: null,
		startX: 0,
		startY: 0,
		startRect: instance.rect,
		moved: false,
		skipFlow: false,
		wasSelected: false
	});
	const [action, setAction] = useState<'move' | 'flow' | ResizeHandle | null>(null);
	const [ghost, setGhost] = useState({ dx: 0, dy: 0 });

	// A plugin widget (e.g. an HA light) asks to actuate; the host adds its identity and bubbles up —
	// the side-effecting Tauri call lives in the container (Canvas), not here (AGENTS.md §5/§6).
	const handleControl = (e: { domain: string; service: string; data?: Record<string, unknown> }) =>
		onControl?.({ id: instance.id, sensor: instance.sensor, ...e });

	const handleContextMenu = (e: ReactMouseEvent) => {
		if (!editMode) return;
		e.preventDefault();
		e.stopPropagation();
		// Swallow the contextmenu that trails a right-button free-move (consume-once, canvas-armed).
		if (suppressContextMenu?.()) return;
		onSelect?.({ id: selectId });
		onContextMenu?.({ id: selectId, x: e.clientX, y: e.clientY });
	};

	function begin(kind: 'move' | ResizeHandle, e: ReactPointerEvent) {
		// Left starts a normal (dockable) drag; right starts a free-move (skipFlow) but only for a
		// movable widget's MOVE — resize handles + in-flow ghost-drag stay left-only. Middle/other: no-op.
		const intent = dragMoveIntent(e.button);
		if (!intent || !intent.start) return; // middle-drag is reserved for panning
		if (intent.skipFlow && !(movable && kind === 'move')) return;
		if (!editMode) return;
		const d = drag.current;
		d.wasSelected = selected;
		// Select on press EXCEPT when starting a MOVE on an already-selected widget — then defer to
		// end(): pressing a member of a multi-selection must not collapse it (otherwise only the pressed
		// widget would drag); a click without a drag collapses to just it. A resize still collapses on
		// press so it acts on the single widget (onChange's group-move only applies to a move drag).
		if (!selected || kind !== 'move') onSelect?.({ id: selectId });
		d.moved = false;
		d.skipFlow = intent.skipFlow;
		if (!movable) {
			// In-flow widgets ghost-drag to reorder/reparent; the solver owns their base position, so
			// we translate a ghost and only mutate the tree on drop (5e).
			d.action = 'flow';
			d.startX = e.clientX;
			d.startY = e.clientY;
			setAction('flow');
			setGhost({ dx: 0, dy: 0 });
			e.currentTarget.setPointerCapture(e.pointerId);
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		d.action = kind;
		d.startX = e.clientX;
		d.startY = e.clientY;
		d.startRect = rect;
		setAction(kind);
		e.currentTarget.setPointerCapture(e.pointerId);
		// Don't preventDefault a right-button (free-move) press — preventDefault on a right pointerdown
		// must never be allowed to cancel the trailing native contextmenu (a stationary right-click
		// still has to open the menu). Left-button keeps preventDefault (suppresses text-selection).
		if (!d.skipFlow) e.preventDefault();
		e.stopPropagation();
	}

	function move(e: ReactPointerEvent) {
		const d = drag.current;
		if (d.action === null) return;
		// Below the slop the press is still a click-to-select: don't ghost, move, resize or preview.
		if (!d.moved) {
			if (
				Math.abs(e.clientX - d.startX) <= DRAG_SLOP &&
				Math.abs(e.clientY - d.startY) <= DRAG_SLOP
			)
				return;
			d.moved = true;
		}
		if (d.action === 'flow') {
			setGhost({ dx: (e.clientX - d.startX) / scale, dy: (e.clientY - d.startY) / scale });
			onDragOver?.({ id: selectId, x: e.clientX, y: e.clientY });
			return;
		}
		const dx = (e.clientX - d.startX) / scale;
		const dy = (e.clientY - d.startY) / scale;
		const next =
			d.action === 'move'
				? moveRect(d.startRect, dx, dy, grid)
				: resizeRect(d.startRect, d.action, dx, dy, grid);
		onChange?.({ id: instance.id, rect: next });
		// A floating widget dragged over the flow tree can dock there (checked on commit) — unless this
		// is a right-button free-move (skipFlow), which the Canvas keeps floating.
		if (d.action === 'move')
			onDragOver?.({ id: selectId, x: e.clientX, y: e.clientY, skipFlow: d.skipFlow });
	}

	function end(e: ReactPointerEvent) {
		const d = drag.current;
		if (d.action === null) return;
		const wasFlow = d.action === 'flow';
		const wasMove = d.action === 'move';
		const didMove = d.moved;
		const wasSelected = d.wasSelected;
		d.action = null;
		setAction(null);
		if (wasFlow) {
			setGhost({ dx: 0, dy: 0 });
			// A real drag reparents/reorders; a click (no movement) on an already-selected widget
			// collapses the (multi-)selection to just this one — selecting an unselected one already
			// happened in begin(), so only re-select here when it was selected at press.
			if (didMove) onDrop?.({ id: selectId, x: e.clientX, y: e.clientY });
			else if (wasSelected) onSelect?.({ id: selectId });
			return;
		}
		// Likewise a click (no drag) on an already-selected floating widget collapses a multi-selection
		// to just it — only for a MOVE (a resize already selected on press); a real drag commits instead.
		if (didMove) onCommit?.({ skipFlow: d.skipFlow });
		else if (wasSelected && wasMove) onSelect?.({ id: selectId });
		// A real right-button free-move arms canvas-side suppression of the contextmenu that follows
		// (a right-CLICK without movement must still open the menu, so only arm when it actually moved).
		if (didMove && d.skipFlow) onSuppressContextMenu?.();
	}

	const cls = ['widget'];
	if (flow) cls.push('flow');
	if (editMode) cls.push('editable');
	if (selected) cls.push('selected');
	if (multi) cls.push('multi-member');
	if (highlighted) cls.push('hl');
	if (action !== null) cls.push('active');
	if (!editMode && interactive) cls.push('catch');
	if (action === 'flow') cls.push('dragging');

	return (
		<div
			ref={boxRef}
			className={cls.join(' ')}
			style={
				flow
					? // Slot mode (CSS layout): fill the FlowNode slot that owns position/size; only the
					  // live drag ghost is applied here.
					  { width: '100%', height: '100%', transform: `translate(${ghost.dx}px, ${ghost.dy}px)` }
					: {
							left: `${rect.x}px`,
							top: `${rect.y}px`,
							// Content-fit: let the box shrink-wrap its content (and report that size); otherwise
							// use the solved rect (which for a 'content' leaf already equals the measured size).
							width: contentSize ? 'max-content' : `${rect.w}px`,
							height: contentSize ? 'max-content' : `${rect.h}px`,
							transform: `translate(${ghost.dx}px, ${ghost.dy}px)`
					  }
			}
			data-w={domId}
			data-type={instance.type}
			data-sensor={instance.sensor}
			data-def={defId}
			data-group={groupId}
			onContextMenu={handleContextMenu}
			onMouseEnter={onHover ? () => onHover(selectId) : undefined}
			onMouseLeave={onHover ? () => onHover(null) : undefined}
		>
			{Comp ? (
				<WidgetErrorBoundary resetKey={resetKey} label={instance.type}>
					{!instance.sensor || binds === 'none' ? (
						<Comp
							{...meterConfig}
							{...formulaOverrides}
							{...multiSensorProps}
							widgetId={instance.id}
							editMode={editMode}
							onControl={handleControl}
						/>
					) : binds === 'json' || binds === 'text' ? (
						<Comp
							value={rawValue}
							{...meterConfig}
							{...formulaOverrides}
							{...multiSensorProps}
							onControl={handleControl}
						/>
					) : (
						<Comp
							value={scalar}
							history={history}
							{...meterConfig}
							{...formulaOverrides}
							{...multiSensorProps}
							onControl={handleControl}
						/>
					)}
				</WidgetErrorBoundary>
			) : (
				<div className="missing">?{instance.type}</div>
			)}

			{editMode && (
				<>
					<button
						type="button"
						className="drag-overlay"
						aria-label={`Move ${instance.type} widget`}
						onPointerDown={(e) => begin('move', e)}
						onPointerMove={move}
						onPointerUp={end}
					/>
					{movable &&
						HANDLES.map((handle) => (
							<button
								key={handle}
								type="button"
								className={`handle ${handle}`}
								aria-label={`Resize ${handle}`}
								onPointerDown={(e) => begin(handle, e)}
								onPointerMove={move}
								onPointerUp={end}
							/>
						))}
				</>
			)}
		</div>
	);
}

// Memoized: Canvas owns ALL editor state, so any selection/hover/drag/menu tick re-renders Canvas.
// Without this every WidgetHost (and its sensor/formula machinery) reconciles on each interaction.
// The render-affecting props are primitives/stable refs and Canvas useCallback's the callbacks, so
// this memoizes cleanly — the single highest-leverage perf win in the studio tree.
export default memo(WidgetHost);
