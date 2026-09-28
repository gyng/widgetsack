import { describe, it, expect } from 'vitest';
import { patchContainerOp, setGridTracks, distributeEvenly } from './useEditorModel';
import { container, leaf, type Container, type MonitorLayout } from '../../core/layoutTree';
import type { EditorState } from './types';

function stub(root: Container): EditorState {
	return {
		mode: { kind: 'layout' },
		monitor: { root, floating: [] } as MonitorLayout,
		library: undefined,
		selectedId: null,
		selectedIds: [],
		lastPrimary: null,
		selectedTheme: '',
		themeLock: true,
		tokenOverrides: {},
		undoStack: [],
		redoStack: [],
		lastSnap: null,
		historyReady: true,
		savedBaseline: null,
		pendingExtras: [],
		saveSeq: 0,
		studio: true
	} as EditorState;
}

const cell = (id: string) => container(id, 'col', [], { align: 'stretch' });
// A 2×2 grid: four cells, the last carrying a widget (so we prove content is dropped on shrink).
const grid2x2 = () =>
	container('g', 'grid', [cell('c0'), cell('c1'), cell('c2'), withWidget('c3')], {
		cols: 2,
		rows: 2
	});
const withWidget = (id: string) =>
	container(
		id,
		'col',
		[leaf({ id: 'w', type: 'clock', rect: { x: 0, y: 0, w: 10, h: 10 }, config: {} })],
		{
			align: 'stretch'
		}
	);

const gridOf = (p: ReturnType<typeof patchContainerOp>) =>
	(p.monitor as MonitorLayout).root.children[0] as Container;

describe('patchContainerOp — grid cell reconciliation', () => {
	it('drops the now-excess cells when rows is reduced (2×2 → 2×1)', () => {
		const root = container('root', 'col', [grid2x2()]);
		const g = gridOf(patchContainerOp(stub(root), 'g', { rows: 1 }));
		expect(g.children.map((c) => c.id)).toEqual(['c0', 'c1']);
	});

	it('drops excess cells when cols is reduced (2×2 → 1×2)', () => {
		const root = container('root', 'col', [grid2x2()]);
		const g = gridOf(patchContainerOp(stub(root), 'g', { cols: 1 }));
		expect(g.children).toHaveLength(2); // 1 col × 2 rows
	});

	it('keeps every cell when the grid grows (2×2 → 3×2) — placeholders fill the rest', () => {
		const root = container('root', 'col', [grid2x2()]);
		const g = gridOf(patchContainerOp(stub(root), 'g', { cols: 3 }));
		expect(g.children).toHaveLength(4);
	});

	it('leaves a non-grid container untouched on a cols patch', () => {
		const root = container('root', 'col', [
			container('r', 'row', [cell('a'), cell('b'), cell('c')])
		]);
		const r = gridOf(patchContainerOp(stub(root), 'r', { cols: 1 }));
		expect(r.children).toHaveLength(3);
	});
});

describe('setGridTracks — grid column/row weights', () => {
	it('stores the two given column weights (others default to 1)', () => {
		const root = container('root', 'col', [grid2x2()]);
		const g = gridOf(
			setGridTracks(stub(root), 'g', 'col', [
				{ index: 0, fr: 2 },
				{ index: 1, fr: 1 }
			])
		);
		expect(g.colFr).toEqual([2, 1]);
	});

	it('writes rowFr independently of colFr', () => {
		const root = container('root', 'col', [grid2x2()]);
		const g = gridOf(
			setGridTracks(stub(root), 'g', 'row', [
				{ index: 0, fr: 1 },
				{ index: 1, fr: 3 }
			])
		);
		expect(g.rowFr).toEqual([1, 3]);
		expect(g.colFr).toBeUndefined();
	});

	it('is a no-op on a non-grid container', () => {
		const root = container('root', 'col', [container('r', 'row', [cell('a'), cell('b')])]);
		expect(setGridTracks(stub(root), 'r', 'col', [{ index: 0, fr: 2 }]).monitor).toBeUndefined();
	});
});

describe('distributeEvenly on a grid', () => {
	it('clears colFr/rowFr back to a uniform split', () => {
		const g0 = grid2x2();
		g0.colFr = [3, 1];
		g0.rowFr = [1, 2];
		const root = container('root', 'col', [g0]);
		const g = gridOf(distributeEvenly(stub(root), 'g'));
		expect(g.colFr).toBeUndefined();
		expect(g.rowFr).toBeUndefined();
	});
});
