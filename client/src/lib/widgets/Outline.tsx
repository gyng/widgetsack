// The layout outline (edit mode): a flattened, indented tree of the flow `root` plus
// the floating layer. Structural editing only — select, reorder (↑/↓), reparent
// (⟸ out / ⟹ in), dock (⤒) / float (⤓), remove (✕), and add containers. All changes
// go up as a single `op` event; the Canvas applies them via core/layoutEdit.
//
// Keyboard: a WAI-ARIA tree with a roving tabindex — ONE tab stop (the focused row), then
// ArrowUp/Down move between rows, Home/End jump, ArrowLeft/Right collapse/expand a container (or
// move to its parent / first child), Enter or Space selects. Alt+Arrow runs the structural moves
// (up/down/out/in) so they stay keyboard-reachable while the row's action glyphs are mouse-only;
// Delete removes the focused row (the ✕) and the Menu key / Shift+F10 opens its ⋯ menu.
import {
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
	type DragEvent as ReactDragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent
} from 'react';
import { isContainer, type Container, type LayoutNode, type Leaf } from '../core/layoutTree';
import { isGroup } from '../core/layoutTree';
import { outlineRows, type OutlineRow } from '../core/layoutEdit';
import { getMeta } from '../core/widget';
import type { LayoutOp } from './ops';
import './Outline.css';
import { contextMenuAnchor } from './canvas/menuPosition';

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
	// When set (e.g. the custom widget being designed), appended to the header so the user can tell
	// the tree is scoped to that custom widget, not the monitor layout.
	scopeLabel?: string;
	onOp?: (op: LayoutOp) => void;
	// Right-click on a ROW opens the same node context menu as right-clicking the widget on the
	// stage (the Canvas supplies the handler and owns the menu). Only rows claim the event — the
	// rest of the panel keeps the native menu (text fields keep copy/paste). Absent (overlay /
	// preview) → rows stay native too.
	onNodeContextMenu?: (e: { id: string; x: number; y: number }) => void;
};

// Which rows a collapsed set hides: a row is hidden when its parent is collapsed OR hidden itself.
// Rows arrive in DFS order (parents before children), so one pass suffices. Pure (exported for tests).
export function visibleRows(rows: OutlineRow[], collapsed: ReadonlySet<string>): OutlineRow[] {
	const hidden = new Set<string>();
	const out: OutlineRow[] = [];
	for (const r of rows) {
		if (collapsed.has(r.parentId) || hidden.has(r.parentId)) hidden.add(r.node.id);
		else out.push(r);
	}
	return out;
}

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
						// A keyboard-initiated contextmenu (Menu key / Shift+F10 on the focused row) has no
						// pointer position — anchor the menu at the row instead of the window corner.
						const at = contextMenuAnchor(e, e.currentTarget.getBoundingClientRect());
						onNodeContextMenu({ id, x: at.x, y: at.y });
					}
				}
			: undefined;

	const rows = useMemo(() => outlineRows(root), [root]);

	// Collapsed containers (their descendants are hidden). Toggled by the ▸/▾ chevron or ←/→.
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
	const toggleCollapsed = (id: string, next?: boolean) =>
		setCollapsed((prev) => {
			const c = new Set(prev);
			const want = next ?? !c.has(id);
			if (want) c.add(id);
			else c.delete(id);
			return c;
		});
	const shown = useMemo(() => visibleRows(rows, collapsed), [rows, collapsed]);
	// Every focusable row id in visual order: root, the visible tree rows, then the floating layer.
	const order = useMemo(
		() => [root.id, ...shown.map((r) => r.node.id), ...floating.map((f) => f.id)],
		[root.id, shown, floating]
	);
	const byId = useMemo(() => {
		const m = new Map<string, OutlineRow>();
		for (const r of rows) m.set(r.node.id, r);
		return m;
	}, [rows]);

	// Roving tabindex: exactly one row is a tab stop — the selected row when it is visible, else the
	// last row the user moved to, else the root. Selection changes re-home it (store-previous idiom).
	const [focusId, setFocusId] = useState<string>(selectedId ?? root.id);
	const [prevSelected, setPrevSelected] = useState(selectedId);
	if (selectedId !== prevSelected) {
		setPrevSelected(selectedId);
		if (selectedId) setFocusId(selectedId);
	}
	const tabStop = order.includes(focusId) ? focusId : order[0];
	const rowEls = useRef(new Map<string, HTMLElement>());
	const rowRef = (id: string) => (el: HTMLElement | null) => {
		if (el) rowEls.current.set(id, el);
		else rowEls.current.delete(id);
	};
	const moveFocus = (id: string) => {
		setFocusId(id);
		rowEls.current.get(id)?.focus();
	};

	// Per-row "⋯" overflow menu holding the structural moves (up / down / out / in / float / dock), so
	// the resting and hovered row shows only ✕ + ⋯ and the label never gets crushed.
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const closeMenu = () => setMenuFor(null);
	// A keyboard-opened ⋯ menu moves focus onto its first enabled action once it has rendered (the
	// row's buttons are tabIndex -1, so nothing else would put the keyboard inside it).
	const focusMenuFor = useRef<string | null>(null);
	useEffect(() => {
		if (!menuFor || focusMenuFor.current !== menuFor) return;
		focusMenuFor.current = null;
		rowEls.current
			.get(menuFor)
			?.querySelector<HTMLButtonElement>('.row-menu button:not(:disabled)')
			?.focus();
	}, [menuFor]);

	function onRowKeyDown(e: ReactKeyboardEvent, id: string) {
		// Keys typed inside the ⋯ menu belong to it (Escape closes; the rest is native button handling).
		if ((e.target as HTMLElement).closest('.row-menu')) {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				closeMenu();
				rowEls.current.get(id)?.focus();
			}
			return;
		}
		const i = order.indexOf(id);
		const row = byId.get(id);
		const node: LayoutNode =
			id === root.id ? root : (row?.node ?? floating.find((f) => f.id === id)!);
		const container = isContainer(node) ? node : null;
		let handled = true;
		if (e.altKey) {
			// Alt+Arrow = the structural moves (the ⋯ menu's actions, keyboard-reachable).
			if (!row) return;
			if (e.key === 'ArrowUp' && row.index > 0) op({ op: 'moveUp', id });
			else if (e.key === 'ArrowDown' && row.index < row.siblingCount - 1)
				op({ op: 'moveDown', id });
			else if (e.key === 'ArrowLeft' && row.parentId !== root.id) op({ op: 'outdent', id });
			else if (e.key === 'ArrowRight' && row.index > 0) op({ op: 'indent', id });
			else handled = false;
		} else
			switch (e.key) {
				case 'ArrowDown':
					if (i < order.length - 1) moveFocus(order[i + 1]);
					break;
				case 'ArrowUp':
					if (i > 0) moveFocus(order[i - 1]);
					break;
				case 'Home':
					moveFocus(order[0]);
					break;
				case 'End':
					moveFocus(order[order.length - 1]);
					break;
				case 'ArrowRight':
					// Expand a collapsed container; an expanded one moves into its first child.
					if (container && container.children.length) {
						if (collapsed.has(id)) toggleCollapsed(id, false);
						else moveFocus(container.children[0].id);
					}
					break;
				case 'ArrowLeft':
					// Collapse an expanded container; otherwise move to the parent. The root (always
					// expanded — it has no chevron) and floating rows have no parent: a no-op there.
					if (row && container && container.children.length && !collapsed.has(id))
						toggleCollapsed(id, true);
					else if (row) moveFocus(row.parentId);
					break;
				case 'Enter':
				case ' ':
					op({ op: 'select', id });
					break;
				case 'Delete':
					// The ✕ button's op, keyboard-reachable (the button itself is not a tab stop). The
					// root has no ✕: leave the key to the studio's own bindings there.
					if (id === root.id) handled = false;
					else op({ op: 'remove', id });
					break;
				case 'ContextMenu':
				case 'F10':
					// Open the row's ⋯ menu (tree rows only — root and floating rows have none, so the
					// native contextmenu event, and the Canvas menu it opens, still gets through there).
					if (row && (e.key === 'ContextMenu' || e.shiftKey)) {
						focusMenuFor.current = id;
						setMenuFor(id);
					} else handled = false;
					break;
				default:
					handled = false;
			}
		if (handled) {
			e.preventDefault();
			// Keep the arrows from ALSO reaching the studio's global nudge / navigation bindings.
			e.stopPropagation();
		}
	}

	// Primary text (the widget's friendly name) + a dim hint (what makes THIS row recognizable among
	// same-type siblings: a user label, the bound sensor, or a group name) — five "Sparkline" rows
	// are indistinguishable without it.
	function rowParts(node: LayoutNode): { primary: string; hint: string } {
		if (isContainer(node)) return { primary: `▦ ${node.kind}`, hint: node.id };
		if (isGroup(node.unit))
			return { primary: '• group', hint: node.unit.name ?? node.unit.def ?? node.id };
		const label = node.unit.config?.label;
		const hint = (typeof label === 'string' && label) || node.unit.sensor || '';
		return { primary: `• ${getMeta(node.unit.type)?.label ?? node.unit.type}`, hint };
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
	// get the meaning the glyph alone can't carry. Mouse-only (tabIndex -1): the row itself is the
	// tab stop and the keyboard path is Alt+Arrow / Enter / the context menu, so tabbing through the
	// tree costs one stop per row, not six. `mv` buttons reveal on row hover / focus-within (the CSS).
	const actBtn = (
		label: string,
		glyph: string,
		o: LayoutOp,
		opts: { reveal?: boolean; danger?: boolean; disabled?: boolean } = {}
	) => (
		<button
			type="button"
			/* v8 ignore next -- every current outline action is revealable, dangerous, or both. */
			className={[opts.reveal && 'mv', opts.danger && 'rm'].filter(Boolean).join(' ') || undefined}
			title={label}
			aria-label={label}
			disabled={opts.disabled}
			tabIndex={-1}
			onClick={() => {
				closeMenu();
				op(o);
			}}
		>
			{glyph}
		</button>
	);

	// The ⋯ overflow: a small in-row menu of the structural moves for this tree row.
	const moreMenu = (r: OutlineRow) => {
		const isLast = r.index === r.siblingCount - 1;
		return (
			<span className="more-wrap">
				<button
					type="button"
					className="mv more"
					title="More actions"
					aria-label="More actions"
					aria-haspopup="menu"
					aria-expanded={menuFor === r.node.id}
					tabIndex={-1}
					onClick={() => setMenuFor((cur) => (cur === r.node.id ? null : r.node.id))}
				>
					⋯
				</button>
				{menuFor === r.node.id && (
					<span className="row-menu" role="menu" aria-label="Row actions">
						{actBtn(
							'Move up',
							'↑',
							{ op: 'moveUp', id: r.node.id },
							{ reveal: true, disabled: r.index === 0 }
						)}
						{actBtn(
							'Move down',
							'↓',
							{ op: 'moveDown', id: r.node.id },
							{ reveal: true, disabled: isLast }
						)}
						{actBtn(
							'Move out',
							'⟸',
							{ op: 'outdent', id: r.node.id },
							{ reveal: true, disabled: r.parentId === root.id }
						)}
						{actBtn(
							'Move in',
							'⟹',
							{ op: 'indent', id: r.node.id },
							{ reveal: true, disabled: r.index === 0 }
						)}
						{!isContainer(r.node) &&
							actBtn('Float', '⤓', { op: 'float', id: r.node.id }, { reveal: true })}
					</span>
				)}
			</span>
		);
	};

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
				<div
					ref={rowRef(root.id)}
					className={rootRowCls.join(' ')}
					role="treeitem"
					aria-level={1}
					aria-selected={selectedId === root.id}
					aria-expanded={root.children.length ? true : undefined}
					tabIndex={tabStop === root.id ? 0 : -1}
					onKeyDown={(e) => onRowKeyDown(e, root.id)}
					onDragOver={(e) => onRowDragOver(e, root)}
					onDrop={(e) => onRowDrop(e, root)}
					onDragLeave={onRowDragLeave}
					{...hoverProps(root.id)}
					{...ctxProps(root.id)}
				>
					<button
						type="button"
						className="label"
						tabIndex={-1}
						onClick={() => op({ op: 'select', id: root.id })}
					>
						▦ root ({root.kind})
					</button>
				</div>

				{shown.map((r) => {
					const rowCls = ['row'];
					if (selectedId === r.node.id) rowCls.push('sel');
					if (dragOverId === r.node.id) rowCls.push('dropok');
					if (dropNoId === r.node.id) rowCls.push('dropno');
					if (hoverId === r.node.id) rowCls.push('hover');
					if (menuFor === r.node.id) rowCls.push('menu-open');
					const isLast = r.index === r.siblingCount - 1;
					const branch = isContainer(r.node) && r.node.children.length > 0;
					const isCollapsed = collapsed.has(r.node.id);
					return (
						<div
							key={r.node.id}
							ref={rowRef(r.node.id)}
							className={rowCls.join(' ')}
							role="treeitem"
							aria-level={r.depth + 2}
							aria-posinset={r.index + 1}
							aria-setsize={r.siblingCount}
							aria-selected={selectedId === r.node.id}
							aria-expanded={branch ? !isCollapsed : undefined}
							tabIndex={tabStop === r.node.id ? 0 : -1}
							draggable
							onKeyDown={(e) => onRowKeyDown(e, r.node.id)}
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
							{branch ? (
								<button
									type="button"
									className="twisty"
									title={isCollapsed ? 'Expand' : 'Collapse'}
									aria-label={isCollapsed ? 'Expand' : 'Collapse'}
									tabIndex={-1}
									onClick={() => toggleCollapsed(r.node.id)}
								>
									{isCollapsed ? '▸' : '▾'}
								</button>
							) : null}
							<button
								type="button"
								className="label"
								tabIndex={-1}
								onClick={() => op({ op: 'select', id: r.node.id })}
							>
								{rowLabel(r.node)}
							</button>
							<span className="btns">
								{moreMenu(r)}
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
									ref={rowRef(lf.id)}
									className={lfCls.join(' ')}
									role="treeitem"
									aria-level={1}
									aria-selected={selectedId === lf.id}
									tabIndex={tabStop === lf.id ? 0 : -1}
									draggable
									onKeyDown={(e) => onRowKeyDown(e, lf.id)}
									onDragStart={(e) => onRowDragStart(e, lf.id)}
									{...hoverProps(lf.id)}
									{...ctxProps(lf.id)}
								>
									<button
										type="button"
										className="label"
										tabIndex={-1}
										onClick={() => op({ op: 'select', id: lf.id })}
									>
										{rowLabel(lf)}
									</button>
									<span className="btns">
										{actBtn('Snap into layout', '⤒', { op: 'dock', id: lf.id }, { reveal: true })}
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
