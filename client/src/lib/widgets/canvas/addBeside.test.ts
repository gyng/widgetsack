import { describe, it, expect } from 'vitest';
import { addBeside } from './useEditorModel';
import { container, type Container, type MonitorLayout } from '../../core/layoutTree';
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

describe('addBeside (context-menu Add beside)', () => {
	it('inserts a sibling of the given kind directly after the target in its parent', () => {
		const root = container('root', 'row', [
			container('cell-a', 'col', []),
			container('cell-b', 'col', [])
		]);
		const patch = addBeside(stub(root), 'cell-a', 'row');
		const next = (patch.monitor as MonitorLayout).root;
		const inserted = next.children[1] as Container;
		expect(next.children.map((c) => c.id)[0]).toBe('cell-a');
		expect(next.children.map((c) => c.id)[2]).toBe('cell-b');
		expect(inserted.kind).toBe('row');
		expect(patch.selectedId).toBe(inserted.id);
	});

	it('selects the newly added sibling', () => {
		const root = container('root', 'col', [container('cell-a', 'col', [])]);
		const patch = addBeside(stub(root), 'cell-a', 'col');
		const next = (patch.monitor as MonitorLayout).root;
		expect(next.children).toHaveLength(2);
		expect(patch.selectedId).toBe((next.children[1] as Container).id);
	});

	it('is a no-op at the root (nothing to sit beside)', () => {
		const root = container('root', 'col', [container('cell-a', 'col', [])]);
		expect(addBeside(stub(root), 'root', 'row')).toEqual({});
	});

	it('is a no-op when the target id is not in the tree', () => {
		const root = container('root', 'col', [container('cell-a', 'col', [])]);
		expect(addBeside(stub(root), 'does-not-exist', 'row')).toEqual({});
	});

	it('builds a 2×2 grid when kind is grid', () => {
		const root = container('root', 'row', [container('cell-a', 'col', [])]);
		const patch = addBeside(stub(root), 'cell-a', 'grid');
		const next = (patch.monitor as MonitorLayout).root;
		const grid = next.children[1] as Container;
		expect(grid.kind).toBe('grid');
		expect(grid.cols).toBe(2);
		expect(grid.rows).toBe(2);
		expect(grid.children).toHaveLength(4);
	});
});
