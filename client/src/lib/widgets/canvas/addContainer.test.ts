import { describe, it, expect } from 'vitest';
import { addContainer } from './useEditorModel';
import { container, isContainer, type Container, type MonitorLayout } from '../../core/layoutTree';
import type { EditorState } from './types';

function stub(root: Container, selectedId: string | null = null): EditorState {
	return {
		mode: { kind: 'layout' },
		monitor: { root, floating: [] } as MonitorLayout,
		library: undefined,
		selectedId,
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

function child(c: Container, id: string): Container {
	const hit = c.children.find((n): n is Container => isContainer(n) && n.id === id);
	if (!hit) throw new Error(`no container child ${id}`);
	return hit;
}

describe('addContainer targeting (context-menu Add inside)', () => {
	it('inserts a child of the given kind into the targeted container', () => {
		const root = container('root', 'col', [container('cell-a', 'col', [])]);
		const patch = addContainer(stub(root), 'row', 'cell-a');
		const next = (patch.monitor as MonitorLayout).root;
		const cellA = child(next, 'cell-a');
		expect(cellA.children).toHaveLength(1);
		expect((cellA.children[0] as Container).kind).toBe('row');
	});

	it('falls back to the selected container when no target is given', () => {
		const root = container('root', 'col', [container('cell-a', 'col', [])]);
		const patch = addContainer(stub(root, 'cell-a'), 'col');
		const cellA = child((patch.monitor as MonitorLayout).root, 'cell-a');
		expect(cellA.children).toHaveLength(1);
		expect((cellA.children[0] as Container).kind).toBe('col');
	});

	it('is a no-op when the target id is not a container', () => {
		const root = container('root', 'col', [container('cell-a', 'col', [])]);
		expect(addContainer(stub(root), 'row', 'does-not-exist')).toEqual({});
	});

	it('with a cell index, pads earlier empty cells so the band lands in the CLICKED cell', () => {
		// grid has 1 child (cell 0); right-click the 3rd cell (index 2) → pad cell 1, new band at cell 2.
		const grid = container('g', 'grid', [container('filled', 'col', [])], { cols: 3 });
		const patch = addContainer(stub(container('root', 'col', [grid])), 'row', 'g', 2);
		const g = child((patch.monitor as MonitorLayout).root, 'g');
		expect(g.children).toHaveLength(3); // filled, spacer, new row
		expect(g.children[0].id).toBe('filled'); // existing content untouched at cell 0
		expect((g.children[2] as Container).kind).toBe('row'); // new band lands in cell index 2
	});

	it('with an index equal to the child count, just appends (no spacer)', () => {
		const grid = container('g', 'grid', [container('filled', 'col', [])], { cols: 3 });
		const patch = addContainer(stub(container('root', 'col', [grid])), 'row', 'g', 1);
		const g = child((patch.monitor as MonitorLayout).root, 'g');
		expect(g.children).toHaveLength(2);
		expect((g.children[1] as Container).kind).toBe('row');
	});
});
