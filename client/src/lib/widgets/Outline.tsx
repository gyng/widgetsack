// The layout outline (edit mode): a flattened, indented tree of the flow `root` plus
// the floating layer. Structural editing only — select, reorder (↑/↓), reparent
// (⟸ out / ⟹ in), dock (⤒) / float (⤓), remove (✕), and add containers. All changes
// go up as a single `op` event; the Canvas applies them via core/layoutEdit.
import {
	memo,
	useMemo,
	useState,
	type DragEvent as ReactDragEvent,
	type MouseEvent as ReactMouseEvent
} from 'react';
import { isContainer, type Container, type LayoutNode, type Leaf } from '../core/layoutTree';
import { isGroup } from '../core/layoutTree';
import { outlineRows } from '../core/layoutEdit';
import type { LayoutOp } from './ops';
import './Outline.css';

type Props = {
	root: Container;
	floating?: Leaf[];
	selectedId?: string | null;
	// Cross-highlight (studio): the id hovered on the stage glows its row here; hovering a row here
	// reports back via onHover so the Canvas glows the matching widget/container.
	hoverId?: string | null;
	onHover?: (id: string | null) => void;
	// In the studio this panel docks as the full-height left rail (vs a floating box on an
	// overlay). The rail size + bar height come from the canvas's shared custom properties.
	docked?: boolean;
	// When set (e.g. the widget def being designed), appended to the header so the user can tell the
	// tree is scoped to that def, not the monitor layout.
	scopeLabel?: string;
	onOp?: (op: LayoutOp) => void;
	// Right-click on a ROW opens the same node context menu as right-clicking the widget on the
	// stage (the Canvas supplies the handler and owns the menu). Only rows claim the event — the
	// rest of the panel keeps the native menu (text fields keep copy/paste). Absent (overlay /
	// preview) → rows stay native too.
	onNodeContextMenu?: (e: { id: string; x: number; y: number }) => void;
};

function Outline({
	root,
	floating = [],
	selectedId = null,
	hoverId = null,
	onHover,
	docked = false,
	scopeLabel,
	onOp,
	onNodeContextMenu
}: Props) {
	const op = (o: LayoutOp) => onOp?.(o);
	const hoverProps = (id: string) =>
		onHover ? { onMouseEnter: () => onHover(id), onMouseLeave: () => onHover(null) } : undefined;
	const ctxProps = (id: string) =>
		onNodeContextMenu
			? {
					onContextMenu: (e: ReactMouseEvent) => {
						e.preventDefault();
						onNodeContextMenu({ id, x: e.clientX, y: e.clientY });
					}
				}
			: undefined;

	const rows = useMemo(() => outlineRows(root), [root]);

	// Primary text (the structural identity) + a dim hint (what makes THIS row recognizable among
	// same-type siblings: a user label, the bound sensor, or a group name) — five "sparkline" rows
	// are indistinguishable without it.
	function rowParts(node: LayoutNode): { primary: string; hint: string } {
		if (isContainer(node)) return { primary: `▦ ${node.kind}`, hint: node.id };
		if (isGroup(node.unit))
			return { primary: '• group', hint: node.unit.name ?? node.unit.def ?? node.id };
		const label = node.unit.config?.label;
		const hint = (typeof label === 'string' && label) || node.unit.sensor || '';
		return { primary: `• ${node.unit.type}`, hint };
	}

	const rowLabel = (node: LayoutNode) => {
		const { primary, hint } = rowParts(node);
		return (
			<>
				{primary}
				{hint && (
					<span className="hint" title={hint}>
						{hint}
					</span>
				)}
			</>
		);
	};

	// Drag-and-drop into the tree (no canvas coords): drag a row (or a palette widget from the
	// inspector) onto a CONTAINER row to nest it there. Containers are the only drop targets;
	// leaves reject (no preventDefault). `dragOverId` highlights the hovered target.
	const [dragOverId, setDragOverId] = useState<string | null>(null);

	function onRowDragStart(e: ReactDragEvent, id: string) {
		e.dataTransfer?.setData('text/x-node-id', id);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}
	// A row currently signalled as an INVALID drop target (a leaf — only containers accept drops).
	// Without this, dropping on a leaf row silently does nothing; now the row reads as rejected.
	const [dropNoId, setDropNoId] = useState<string | null>(null);
	function onRowDragOver(e: ReactDragEvent, node: LayoutNode) {
		if (!isContainer(node)) {
			// Not a container: claim the event so the browser shows the "no-drop" cursor and we can
			// paint the row as a rejected target, instead of the drop vanishing with no feedback.
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
			setDropNoId(node.id);
			setDragOverId(null);
			return;
		}
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		setDropNoId(null);
		setDragOverId(node.id);
	}
	function onRowDrop(e: ReactDragEvent, node: LayoutNode) {
		setDropNoId(null);
		if (!isContainer(node)) return;
		e.preventDefault();
		setDragOverId(null);
		const wt = e.dataTransfer?.getData('text/x-widget-type');
		if (wt) {
			op({ op: 'dropWidget', containerId: node.id, widgetType: wt });
			return;
		}
		const nid = e.dataTransfer?.getData('text/x-node-id');
		if (nid && nid !== node.id) op({ op: 'reparent', id: nid, containerId: node.id });
	}
	const onRowDragLeave = () => {
		setDragOverId(null);
		setDropNoId(null);
	};

	const outlineCls = ['outline'];
	if (docked) outlineCls.push('docked');

	const rootRowCls = ['row', 'root'];
	if (selectedId === root.id) rootRowCls.push('sel');
	if (dragOverId === root.id) rootRowCls.push('dropok');
	if (hoverId === root.id) rootRowCls.push('hover');

	// An icon-only action button. `aria-label` mirrors the tooltip so screen-reader / keyboard users
	// get the meaning the glyph alone can't carry; `mv` buttons reveal on row hover/selection/focus
	// (the CSS), keeping the resting row uncluttered while giving each control a 24px hit area.
	const actBtn = (
		label: string,
		glyph: string,
		o: LayoutOp,
		opts: { reveal?: boolean; danger?: boolean; disabled?: boolean } = {}
	) => (
		<button
			type="button"
			className={[opts.reveal && 'mv', opts.danger && 'rm'].filter(Boolean).join(' ') || undefined}
			title={label}
			aria-label={label}
			disabled={opts.disabled}
			onClick={() => op(o)}
		>
			{glyph}
		</button>
	);

	return (
		<div className={outlineCls.join(' ')}>
			<div className="hd">
				<span>Outline{scopeLabel ? ` · ${scopeLabel}` : ''}</span>
				<span className="add">
					<button type="button" onClick={() => op({ op: 'addContainer', kind: 'row' })}>
						＋ Row
					</button>
					<button type="button" onClick={() => op({ op: 'addContainer', kind: 'col' })}>
						＋ Column
					</button>
					<button type="button" onClick={() => op({ op: 'addContainer', kind: 'grid' })}>
						＋ Grid
					</button>
				</span>
			</div>

			<div className="tree" role="tree" aria-label="Layout outline">
				<button
					type="button"
					className={rootRowCls.join(' ')}
					role="treeitem"
					aria-level={1}
					aria-selected={selectedId === root.id}
					onClick={() => op({ op: 'select', id: root.id })}
					onDragOver={(e) => onRowDragOver(e, root)}
					onDrop={(e) => onRowDrop(e, root)}
					onDragLeave={onRowDragLeave}
					{...hoverProps(root.id)}
					{...ctxProps(root.id)}
				>
					▦ root ({root.kind})
				</button>

				{rows.map((r) => {
					const rowCls = ['row'];
					if (selectedId === r.node.id) rowCls.push('sel');
					if (dragOverId === r.node.id) rowCls.push('dropok');
					if (dropNoId === r.node.id) rowCls.push('dropno');
					if (hoverId === r.node.id) rowCls.push('hover');
					const isLast = r.index === r.siblingCount - 1;
					return (
						<div
							key={r.node.id}
							className={rowCls.join(' ')}
							role="treeitem"
							aria-level={r.depth + 2}
							aria-posinset={r.index + 1}
							aria-setsize={r.siblingCount}
							aria-selected={selectedId === r.node.id}
							draggable
							onDragStart={(e) => onRowDragStart(e, r.node.id)}
							onDragOver={(e) => onRowDragOver(e, r.node)}
							onDrop={(e) => onRowDrop(e, r.node)}
							onDragLeave={onRowDragLeave}
							{...hoverProps(r.node.id)}
							{...ctxProps(r.node.id)}
						>
							<span className="guides" aria-hidden="true">
								{/* one lane per ancestor (a vertical only while that ancestor still has
								    siblings below), then this node's elbow — └ if it's the last child, else ├ */}
								{r.ancestorsLast.map((last, i) => (
									<span key={i} className={last ? 'lane' : 'lane v'} />
								))}
								<span className={isLast ? 'lane elbow' : 'lane elbow cont'} />
							</span>
							<button
								type="button"
								className="label"
								onClick={() => op({ op: 'select', id: r.node.id })}
							>
								{rowLabel(r.node)}
							</button>
							<span className="btns">
								{actBtn(
									'Move up',
									'↑',
									{ op: 'moveUp', id: r.node.id },
									{
										reveal: true,
										disabled: r.index === 0
									}
								)}
								{actBtn(
									'Move down',
									'↓',
									{ op: 'moveDown', id: r.node.id },
									{
										reveal: true,
										disabled: r.index === r.siblingCount - 1
									}
								)}
								{actBtn(
									'Move out',
									'⟸',
									{ op: 'outdent', id: r.node.id },
									{
										reveal: true,
										disabled: r.parentId === root.id
									}
								)}
								{r.index > 0 &&
									actBtn('Move in', '⟹', { op: 'indent', id: r.node.id }, { reveal: true })}
								{!isContainer(r.node) &&
									actBtn('Float', '⤓', { op: 'float', id: r.node.id }, { reveal: true })}
								{actBtn(
									'Remove',
									'✕',
									{ op: 'remove', id: r.node.id },
									{ reveal: true, danger: true }
								)}
							</span>
						</div>
					);
				})}

				{floating.length > 0 && (
					<div role="group" aria-label="Floating widgets">
						<div className="hd2">Floating</div>
						{floating.map((lf) => {
							const lfCls = ['row'];
							if (selectedId === lf.id) lfCls.push('sel');
							if (hoverId === lf.id) lfCls.push('hover');
							return (
								<div
									key={lf.id}
									className={lfCls.join(' ')}
									role="treeitem"
									aria-level={1}
									aria-selected={selectedId === lf.id}
									draggable
									onDragStart={(e) => onRowDragStart(e, lf.id)}
									{...hoverProps(lf.id)}
									{...ctxProps(lf.id)}
								>
									<button
										type="button"
										className="label"
										onClick={() => op({ op: 'select', id: lf.id })}
									>
										{rowLabel(lf)}
									</button>
									<span className="btns">
										{actBtn('Dock into root', '⤒', { op: 'dock', id: lf.id }, { reveal: true })}
										{actBtn(
											'Remove',
											'✕',
											{ op: 'remove', id: lf.id },
											{ reveal: true, danger: true }
										)}
									</span>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}

// Memoized: the Outline re-renders on every Canvas render (hover, selection, drag) even though its
// props rarely change. Memo so a pointer move on the stage only repaints the two affected rows via
// the hoverId prop diff, not the whole tree. Props are stable (root memo + Canvas useCallback'd).
export default memo(Outline);
