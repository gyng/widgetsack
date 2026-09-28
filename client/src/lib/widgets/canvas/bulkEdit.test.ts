import { describe, it, expect } from 'vitest';
import { bulkPatchConfig, bulkSetBasis } from './useEditorModel';
import {
	container,
	leaf,
	type Container,
	type MonitorLayout,
	type WidgetInstance
} from '../../core/layoutTree';
import type { EditorState } from './types';

const w = (id: string, config: Record<string, unknown> = {}) =>
	leaf({ id, type: 'clock', rect: { x: 0, y: 0, w: 10, h: 10 }, config } as WidgetInstance);

function stub(root: Container, selectedIds: string[]): EditorState {
	return {
		mode: { kind: 'layout' },
		monitor: { root, floating: [] } as MonitorLayout,
		library: undefined,
		selectedId: selectedIds[0] ?? null,
		selectedIds,
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

const unitOf = (c: Container, id: string): WidgetInstance => {
	const n = c.children.find((k) => k.id === id);
	if (!n || !('unit' in n)) throw new Error(`no leaf ${id}`);
	return n.unit as WidgetInstance;
};

describe('bulkPatchConfig', () => {
	it('sets one config key on EVERY selected widget, leaving the rest', () => {
		const root = container('root', 'row', [
			w('a', { format: 'X' }),
			w('b', { format: 'Y' }),
			w('c')
		]);
		const next = bulkPatchConfig(stub(root, ['a', 'b']), 'color', 'red').monitor as MonitorLayout;
		expect(unitOf(next.root, 'a').config).toEqual({ format: 'X', color: 'red' });
		expect(unitOf(next.root, 'b').config).toEqual({ format: 'Y', color: 'red' });
		expect(unitOf(next.root, 'c').config).toEqual({}); // not selected → untouched
	});

	it('is a no-op with no selection', () => {
		const root = container('root', 'row', [w('a')]);
		expect(bulkPatchConfig(stub(root, []), 'color', 'red')).toEqual({});
	});
});

describe('bulkSetBasis', () => {
	it('sets the basis on every selected flow leaf', () => {
		const root = container('root', 'row', [w('a'), w('b'), w('c')]);
		const next = bulkSetBasis(stub(root, ['a', 'b']), { fr: 1 }).monitor as MonitorLayout;
		const basisOf = (id: string) =>
			(next.root.children.find((k) => k.id === id) as { basis?: unknown }).basis;
		expect(basisOf('a')).toEqual({ fr: 1 });
		expect(basisOf('b')).toEqual({ fr: 1 });
		expect(basisOf('c')).toBeUndefined();
	});

	it('clears the basis when set to undefined (fixed)', () => {
		const root = container('root', 'row', [
			leaf(
				{ id: 'a', type: 'clock', rect: { x: 0, y: 0, w: 1, h: 1 }, config: {} } as WidgetInstance,
				{ fr: 1 }
			)
		]);
		const next = bulkSetBasis(stub(root, ['a']), undefined).monitor as MonitorLayout;
		expect((next.root.children[0] as { basis?: unknown }).basis).toBeUndefined();
	});
});
