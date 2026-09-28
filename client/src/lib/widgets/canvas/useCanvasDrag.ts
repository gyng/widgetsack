import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Rect, WidgetInstance } from '../../core/layout';
import {
	isGroup,
	isLeaf,
	isContainer,
	type Group,
	type Leaf,
	type MonitorLayout
} from '../../core/layoutTree';
import {
	dropTarget,
	findNode,
	insertChild,
	moveNode,
	removeNode,
	type Drop
} from '../../core/layoutEdit';
import type { Solved, Renderable } from '../../core/solve';
import { snapRectToPeers } from '../../core/align';
import { dropBarAt, dropZoneAt } from '../../core/dropFeedback';
import type { EditorState } from './types';
import type { EditorModel } from './useEditorModel';
import { wrapLeafWith, floatingLeafFrom, patchFloating } from './editorOps';
const ALIGN_THRESHOLD = 6;

type Options = {
	solvedRef: RefObject<Solved>;
	renderablesRef: RefObject<Renderable[]>;
	monitorForDragRef: RefObject<MonitorLayout>;
	selectedIdsRef: RefObject<string[]>;
	toWorld: (x: number, y: number) => { x: number; y: number };
	toCanvas: (x: number, y: number) => { x: number; y: number };
	floatingGroupBox: (leaf: Leaf) => Rect;
	translateSelectedFloating: (dx: number, dy: number) => boolean;
	commitOp: EditorModel['commitOp'];
	mutateNoSave: EditorModel['mutateNoSave'];
};

export function useCanvasDrag({
	solvedRef,
	renderablesRef,
	monitorForDragRef,
	selectedIdsRef,
	toWorld,
	toCanvas,
	floatingGroupBox,
	translateSelectedFloating,
	commitOp,
	mutateNoSave
}: Options) {
	const [guideXs, setGuideXs] = useState<number[]>([]);
	const [guideYs, setGuideYs] = useState<number[]>([]);
	const [dropIntoFlow, setDropIntoFlow] = useState(true);
	const [dropIntoCells, setDropIntoCells] = useState(false);
	const [dropBar, setDropBar] = useState<Rect | null>(null);
	const [dropZone, setDropZone] = useState<Rect | null>(null);
	const [dragHint, setDragHint] = useState<{ x: number; y: number; text: string } | null>(null);
	// dropIndicator + draggingId are bookkeeping read synchronously across dragover→commit; refs.
	const dropIndicatorRef = useRef<Drop | null>(null);
	const draggingIdRef = useRef<string | null>(null);

	const clearFeedback = useCallback(() => {
		setGuideXs([]);
		setGuideYs([]);
		setDragHint(null);
		dropIndicatorRef.current = null;
		draggingIdRef.current = null;
		setDropBar(null);
		setDropZone(null);
	}, []);
	const onCancel = useCallback(
		({ commit }: { commit: boolean }) => {
			clearFeedback();
			if (commit) commitOp(() => ({}));
		},
		[clearFeedback, commitOp]
	);

	const onChange = useCallback(
		(e: { id: string; rect: WidgetInstance['rect'] }) => {
			const { id, rect } = e;
			const mon = monitorForDragRef.current;
			const selIds = selectedIdsRef.current;
			const lf = mon.floating.find((l) => l.id === id);
			const isGroupLeaf = !!lf && isGroup(lf.unit);
			// Group move (item 3): translate the whole multi-selection by the per-frame delta. The
			// dragged item's current box is its stored rect (primitive) or its config box (group).
			if (selIds.length > 1 && selIds.includes(id)) {
				const curRect = lf
					? isGroupLeaf
						? floatingGroupBox(lf)
						: (lf.unit as WidgetInstance).rect
					: null;
				if (curRect) {
					setGuideXs([]);
					setGuideYs([]);
					translateSelectedFloating(rect.x - curRect.x, rect.y - curRect.y);
					return;
				}
			}
			const peers = renderablesRef.current
				.filter((r) => r.movable && r.id !== id)
				.map((r) => r.rect);
			const snapped = snapRectToPeers(rect, peers, ALIGN_THRESHOLD);
			setGuideXs(snapped.guideXs);
			setGuideYs(snapped.guideYs);
			// A floating group's position+size live in its config (config.x/y/w/h), not a unit rect.
			mutateNoSave((s) =>
				isGroupLeaf
					? patchFloatingGroupBox(s, id, snapped.rect)
					: patchFloating(s, id, { rect: snapped.rect })
			);
		},
		[
			translateSelectedFloating,
			mutateNoSave,
			floatingGroupBox,
			monitorForDragRef,
			selectedIdsRef,
			renderablesRef
		]
	);

	// (A right-button free-move passes {skipFlow} here, but it's intentionally ignored: skipFlow is
	// already enforced upstream in onDragOver — allowDock && !skipFlow keeps dropIndicatorRef null —
	// so the dock branch below is simply never taken for a free-move.)
	const onCommit = useCallback(() => {
		const dropIndicator = dropIndicatorRef.current;
		const draggingId = draggingIdRef.current;
		clearFeedback();
		// A floating widget released over the flow tree docks into that slot.
		if (dropIndicator && draggingId) {
			const id = draggingId;
			commitOp((s) => {
				const lf = s.monitor.floating.find((l) => l.id === id);
				if (!lf) return {};
				const floating = s.monitor.floating.filter((l) => l.id !== id);
				const root = dropIndicator.merge
					? wrapLeafWith(s.monitor.root, dropIndicator.merge, id, lf)
					: insertChild(s.monitor.root, dropIndicator.parentId, lf, dropIndicator.index);
				return { monitor: { ...s.monitor, floating, root }, selectedId: id };
			});
		} else {
			commitOp(() => ({})); // saveLayout() (no dock) — commit the drag's onChange edits
		}
	}, [commitOp, clearFeedback]);

	const onDragOver = useCallback(
		(e: { id: string; x: number; y: number; skipFlow?: boolean }) => {
			const { id } = e;
			const w = toWorld(e.x, e.y);
			const c = toCanvas(e.x, e.y);
			draggingIdRef.current = id;
			const mon = monitorForDragRef.current;
			// A right-button free-move (skipFlow) never docks, regardless of the "into grids" toggle.
			const allowDock =
				(!mon.floating.some((l) => l.id === id) || dropIntoFlowRef.current) && !e.skipFlow;
			const drop = allowDock
				? dropTarget(mon.root, solvedRef.current, w, id, dropIntoCellsRef.current)
				: null;
			dropIndicatorRef.current = drop;
			const bar =
				!drop || drop.into || drop.merge ? null : dropBarAt(mon, solvedRef.current, w, id);
			setDropBar(bar);
			setDropZone(dropZoneAt(mon, solvedRef.current, drop, bar));
			if (drop) {
				const parent = findNode(mon.root, drop.parentId);
				const kind = parent && isContainer(parent) ? parent.kind : 'flow';
				setDragHint({ x: c.x, y: c.y, text: `▦ into ${kind}` });
			} else {
				// If this floating widget WOULD have docked but the "into grids" toggle is off, say so —
				// otherwise a widget that refuses to dock reads as a bug rather than a switched-off mode.
				const dockOff =
					mon.floating.some((l) => l.id === id) && !dropIntoFlowRef.current && !e.skipFlow;
				const wouldDock =
					dockOff && dropTarget(mon.root, solvedRef.current, w, id, dropIntoCellsRef.current);
				if (wouldDock) {
					setDragHint({ x: c.x, y: c.y, text: '⊕ float · docking off (into grids)' });
				} else {
					const lf = mon.floating.find((l) => l.id === id);
					const pos = lf && !isGroup(lf.unit) ? (lf.unit as WidgetInstance).rect : null;
					const px = Math.round(pos ? pos.x : w.x);
					const py = Math.round(pos ? pos.y : w.y);
					setDragHint({ x: c.x, y: c.y, text: `⊕ float · ${px}, ${py}` });
				}
			}
		},
		[toWorld, toCanvas, monitorForDragRef, solvedRef]
	);
	const dropIntoFlowRef = useRef(dropIntoFlow); // mirrored in the commit effect S3
	const dropIntoCellsRef = useRef(dropIntoCells); // mirrored in the commit effect S3

	const onDrop = useCallback(
		(e: { id: string; x: number; y: number }) => {
			const { id } = e;
			const { x, y } = toWorld(e.x, e.y);
			clearFeedback();
			commitOp((s) => {
				const drop = dropTarget(
					s.monitor.root,
					solvedRef.current,
					{ x, y },
					id,
					dropIntoCellsRef.current
				);
				if (drop?.merge) {
					const dragged = findNode(s.monitor.root, id);
					if (dragged)
						return {
							monitor: {
								...s.monitor,
								root: wrapLeafWith(s.monitor.root, drop.merge, id, dragged)
							},
							selectedId: id
						};
					return { selectedId: id };
				} else if (drop) {
					return {
						monitor: {
							...s.monitor,
							root: moveNode(s.monitor.root, id, drop.parentId, drop.index)
						},
						selectedId: id
					};
				}
				// Float at the cursor using this editor’s measured geometry.
				const node = findNode(s.monitor.root, id);
				if (!node || !isLeaf(node)) return { selectedId: id };
				const r = solvedRef.current.get(id);
				const lf = floatingLeafFrom(node, x, y, r);
				return {
					monitor: {
						...s.monitor,
						root: removeNode(s.monitor.root, id),
						floating: [...s.monitor.floating, lf]
					},
					selectedId: id
				};
			});
		},
		[toWorld, commitOp, solvedRef, clearFeedback]
	);

	useLayoutEffect(() => {
		dropIntoFlowRef.current = dropIntoFlow;
		dropIntoCellsRef.current = dropIntoCells;
	}, [dropIntoFlow, dropIntoCells]);
	return {
		guideXs,
		guideYs,
		dropBar,
		dropZone,
		dragHint,
		dropIntoFlow,
		setDropIntoFlow,
		dropIntoCells,
		setDropIntoCells,
		onChange,
		onCommit,
		onCancel,
		onDragOver,
		onDrop
	};
}

// patchFloatingGroupBox: a floating GROUP's position + size live in its `config` (x/y/w/h), not a
// WidgetInstance.rect — so this is the group counterpart to patchFloating (used by GroupFrame's
// drag/resize). Setting all four covers both move and resize. Returns a patch.
function patchFloatingGroupBox(
	s: { monitor: MonitorLayout },
	id: string,
	rect: Rect
): Partial<EditorState> {
	return {
		monitor: {
			...s.monitor,
			floating: s.monitor.floating.map((l) =>
				l.id === id && isGroup(l.unit)
					? {
							...l,
							unit: {
								...(l.unit as Group),
								config: {
									...(l.unit as Group).config,
									x: rect.x,
									y: rect.y,
									w: rect.w,
									h: rect.h
								}
							}
						}
					: l
			)
		}
	};
}
