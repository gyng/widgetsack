import { describe, it, expect } from 'vitest';
import { setWidgetToken, clearWidgetTokens } from './useEditorModel';
import {
	container,
	group,
	leaf,
	type Container,
	type Group,
	type MonitorLayout,
	type WidgetInstance
} from '../../core/layoutTree';
import type { EditorState } from './types';

const w = (id: string, tokens?: Record<string, string>) =>
	leaf({
		id,
		type: 'gauge',
		rect: { x: 0, y: 0, w: 10, h: 10 },
		config: {},
		tokens
	} as WidgetInstance);

function stub(root: Container, floating: MonitorLayout['floating'] = []): EditorState {
	return {
		mode: { kind: 'layout' },
		monitor: { root, floating } as MonitorLayout,
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

const unitOf = (m: MonitorLayout, id: string): WidgetInstance => {
	const n = m.root.children.find((k) => k.id === id);
	if (!n || !('unit' in n)) throw new Error(`no leaf ${id}`);
	return n.unit as WidgetInstance;
};

describe('setWidgetToken', () => {
	it('adds a per-widget token override on a primitive', () => {
		const root = container('root', 'row', [w('a')]);
		const m = setWidgetToken(stub(root), 'a', '--np-accent', 'gold').monitor as MonitorLayout;
		expect(unitOf(m, 'a').tokens).toEqual({ '--np-accent': 'gold' });
	});

	it('merges with existing overrides', () => {
		const root = container('root', 'row', [w('a', { '--np-fg': '#000' })]);
		const m = setWidgetToken(stub(root), 'a', '--np-accent', 'gold').monitor as MonitorLayout;
		expect(unitOf(m, 'a').tokens).toEqual({ '--np-fg': '#000', '--np-accent': 'gold' });
	});

	it('clears one key with an empty value, dropping tokens when it empties', () => {
		const root = container('root', 'row', [w('a', { '--np-accent': 'gold' })]);
		const m = setWidgetToken(stub(root), 'a', '--np-accent', '').monitor as MonitorLayout;
		expect(unitOf(m, 'a').tokens).toBeUndefined();
	});

	it('works on a group unit (floating)', () => {
		const g = group('g1', { w: 1, h: 1 }, w('inner'), {});
		const m = setWidgetToken(stub(container('root', 'row', []), [leaf(g)]), 'g1', '--np-fg', '#111')
			.monitor as MonitorLayout;
		const gu = m.floating[0].unit as Group;
		expect(gu.tokens).toEqual({ '--np-fg': '#111' });
	});
});

describe('clearWidgetTokens', () => {
	it('drops the whole override', () => {
		const root = container('root', 'row', [w('a', { '--np-accent': 'gold', '--np-fg': '#000' })]);
		const m = clearWidgetTokens(stub(root), 'a').monitor as MonitorLayout;
		expect(unitOf(m, 'a').tokens).toBeUndefined();
	});

	it('is a no-op when there are no overrides', () => {
		const root = container('root', 'row', [w('a')]);
		expect(clearWidgetTokens(stub(root), 'a')).toEqual({});
	});
});
