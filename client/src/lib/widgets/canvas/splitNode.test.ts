import { describe, it, expect } from 'vitest';
import { splitNode } from './useEditorModel';
import {
	container,
	leaf,
	isContainer,
	type Container,
	type MonitorLayout
} from '../../core/layoutTree';
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

const rootOf = (p: ReturnType<typeof splitNode>) => (p.monitor as MonitorLayout).root;
const kinds = (c: Container) => c.children.filter(isContainer).map((k) => (k as Container).kind);

describe('splitNode band orientation', () => {
	it('"into rows" → a col parent holding row bands', () => {
		const root = rootOf(splitNode(stub(container('root', 'col', [])), 'root', 'rows'));
		expect(root.kind).toBe('col'); // the stacker
		expect(kinds(root)).toEqual(['row', 'row']); // the two rows
	});

	it('"into cols" → a row parent holding col strips', () => {
		const root = rootOf(splitNode(stub(container('root', 'col', [])), 'root', 'cols'));
		expect(root.kind).toBe('row');
		expect(kinds(root)).toEqual(['col', 'col']);
	});

	it('preserves the existing content kind in the kept band, new band takes the orientation', () => {
		// A populated grid node split into rows: keep stays grid (so its content does not re-flow),
		// the freshly added band is a row.
		const populated = container('root', 'grid', [
			leaf({ id: 'w', type: 'clock', rect: { x: 0, y: 0, w: 10, h: 10 }, config: {} })
		]);
		const root = rootOf(splitNode(stub(populated), 'root', 'rows'));
		expect(root.kind).toBe('col');
		expect(kinds(root)).toEqual(['grid', 'row']);
	});

	it('"into grid" → a 2×2 grid of col cells', () => {
		const root = rootOf(splitNode(stub(container('root', 'col', [])), 'root', 'grid'));
		expect(root.kind).toBe('grid');
		expect(root.cols).toBe(2);
		expect(kinds(root)).toEqual(['col', 'col', 'col', 'col']);
	});
});

describe('splitNode on an empty grid cell (cellIndex)', () => {
	const gridChild = (p: ReturnType<typeof splitNode>) =>
		(p.monitor as MonitorLayout).root.children[0] as Container;

	it('materialises a band cell AT that index — the grid itself is NOT wrapped/re-leveled', () => {
		const root = container('root', 'col', [container('g', 'grid', [], { cols: 2, rows: 2 })]);
		const g = gridChild(splitNode(stub(root), 'g', 'rows', 0));
		expect(g.kind).toBe('grid'); // unchanged — the regression was the grid getting wrapped a level
		expect(g.children).toHaveLength(1);
		const band = g.children[0] as Container;
		expect(band.kind).toBe('col'); // "into rows" → a col…
		expect(kinds(band)).toEqual(['row', 'row']); // …holding two row bands
	});

	it('pads earlier empty cells so the band lands at the clicked index', () => {
		const root = container('root', 'col', [container('g', 'grid', [], { cols: 2, rows: 2 })]);
		const g = gridChild(splitNode(stub(root), 'g', 'cols', 2));
		expect(g.children).toHaveLength(3); // 2 padding cells + the band at index 2
		expect((g.children[2] as Container).kind).toBe('row'); // "into cols" → a row of cols
	});

	it('"into grid" on an empty cell nests a 2×2 grid at that cell', () => {
		const root = container('root', 'col', [container('g', 'grid', [], { cols: 2, rows: 2 })]);
		const g = gridChild(splitNode(stub(root), 'g', 'grid', 0));
		expect(g.kind).toBe('grid');
		const band = g.children[0] as Container;
		expect(band.kind).toBe('grid');
		expect(band.children).toHaveLength(4);
	});
});
