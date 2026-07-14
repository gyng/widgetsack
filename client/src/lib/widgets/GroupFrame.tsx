// GroupFrame — the single interactive surface for a placed group ("grouped"/custom widget) on the
// floating layer. The group already renders as one absolute CSS box (its composed children, a
// FlowNode, passed as `children`); this frame makes it behave like ONE widget: select, free-move and
// resize the whole group as a unit. It carries no WidgetInstance — its `id` IS the group leaf id, so
// selection + the multi-select group-drag wiring treat it as one. Drag math mirrors WidgetHost's
// floating path (moveRect/resizeRect + the press/click/drag deferral) but with no meter, sensor, or
// flow/content-fit modes. Free-move/resize only — a group frame never docks into the flow tree.
import {
	useRef,
	useState,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	type ReactNode
} from 'react';
import type { Rect } from '../core/layout';
import { moveRect, resizeRect, type ResizeHandle } from '../core/geometry';
import { dragMoveIntent } from './canvas/dragIntent';

const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const DRAG_SLOP = 3;

type Props = {
	id: string; // the group leaf id (== selectId)
	rect: Rect; // absolute box (floatingGroupBox)
	name?: string;
	editMode?: boolean;
	selected?: boolean;
	multi?: boolean; // part of a multi-selection → focal dashed outline (see WidgetHost)
	highlighted?: boolean;
	grid?: number;
	scale?: number;
	children?: ReactNode; // the group's composed FlowNode
	onChange?: (e: { id: string; rect: Rect }) => void;
	onCommit?: (e?: { skipFlow?: boolean }) => void;
	onSelect?: (e: { id: string }) => void;
	onContextMenu?: (e: { id: string; x: number; y: number }) => void;
	onHover?: (id: string | null) => void;
	onSuppressContextMenu?: () => void;
	suppressContextMenu?: () => boolean;
};

export default function GroupFrame({
	id,
	rect,
	name,
	editMode = false,
	selected = false,
	multi = false,
	highlighted = false,
	grid = 8,
	scale = 1,
	children,
	onChange,
	onCommit,
	onSelect,
	onContextMenu,
	onHover,
	onSuppressContextMenu,
	suppressContextMenu
}: Props) {
	const drag = useRef<{
		action: 'move' | ResizeHandle | null;
		startX: number;
		startY: number;
		startRect: Rect;
		moved: boolean;
		skipFlow: boolean;
		wasSelected: boolean;
	}>({
		action: null,
		startX: 0,
		startY: 0,
		startRect: rect,
		moved: false,
		skipFlow: false,
		wasSelected: false
	});
	const [action, setAction] = useState<'move' | ResizeHandle | null>(null);

	const handleContextMenu = (e: ReactMouseEvent) => {
		if (!editMode) return;
		e.preventDefault();
		e.stopPropagation();
		if (suppressContextMenu?.()) return;
		onSelect?.({ id });
		onContextMenu?.({ id, x: e.clientX, y: e.clientY });
	};

	function begin(kind: 'move' | ResizeHandle, e: ReactPointerEvent) {
		const intent = dragMoveIntent(e.button);
		if (!intent || !intent.start) return; // middle-drag is reserved for panning
		if (intent.skipFlow && kind !== 'move') return; // right-button free-move only for a move
		/* v8 ignore next -- begin is wired only on edit-mode overlay/handles, which are absent otherwise. */
		if (!editMode) return;
		const d = drag.current;
		d.wasSelected = selected;
		// Defer selecting an already-selected group when starting a MOVE so a multi-selection isn't
		// collapsed before the drag (mirrors WidgetHost); a resize / unselected press selects now.
		if (!selected || kind !== 'move') onSelect?.({ id });
		d.action = kind;
		d.startX = e.clientX;
		d.startY = e.clientY;
		d.startRect = rect;
		d.moved = false;
		d.skipFlow = intent.skipFlow;
		setAction(kind);
		e.currentTarget.setPointerCapture(e.pointerId);
		if (!d.skipFlow) e.preventDefault();
		e.stopPropagation();
	}

	function move(e: ReactPointerEvent) {
		const d = drag.current;
		if (d.action === null) return;
		if (!d.moved) {
			if (
				Math.abs(e.clientX - d.startX) <= DRAG_SLOP &&
				Math.abs(e.clientY - d.startY) <= DRAG_SLOP
			)
				return;
			d.moved = true;
		}
		const dx = (e.clientX - d.startX) / scale;
		const dy = (e.clientY - d.startY) / scale;
		// The box follows via the `rect` prop once onChange updates config (no ghost transform needed).
		const next =
			d.action === 'move'
				? moveRect(d.startRect, dx, dy, grid)
				: resizeRect(d.startRect, d.action, dx, dy, grid);
		onChange?.({ id, rect: next });
	}

	function end() {
		const d = drag.current;
		if (d.action === null) return;
		const wasMove = d.action === 'move';
		const didMove = d.moved;
		const wasSelected = d.wasSelected;
		d.action = null;
		setAction(null);
		// A real drag commits the move/resize; a click (no drag) on an already-selected group collapses
		// a multi-selection to just it (selecting an unselected group happened in begin()).
		if (didMove) onCommit?.({ skipFlow: d.skipFlow });
		else if (wasSelected && wasMove) onSelect?.({ id });
		if (didMove && d.skipFlow) onSuppressContextMenu?.();
	}

	const cls = ['widget', 'floating-group'];
	if (editMode) cls.push('editable');
	if (selected) cls.push('selected');
	if (multi) cls.push('multi-member');
	if (highlighted) cls.push('hl');
	if (action !== null) cls.push('active');

	return (
		<div
			data-id={id}
			data-group=""
			className={cls.join(' ')}
			style={{
				position: 'absolute',
				left: `${rect.x}px`,
				top: `${rect.y}px`,
				width: `${rect.w}px`,
				height: `${rect.h}px`,
				boxSizing: 'border-box'
			}}
			onContextMenu={handleContextMenu}
			onMouseEnter={onHover ? () => onHover(id) : undefined}
			onMouseLeave={onHover ? () => onHover(null) : undefined}
		>
			{children}
			{editMode && (
				<>
					<button
						type="button"
						className="drag-overlay"
						aria-label={`Move ${name ?? 'group'} widget`}
						onPointerDown={(e) => begin('move', e)}
						onPointerMove={move}
						onPointerUp={end}
					/>
					{HANDLES.map((handle) => (
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
