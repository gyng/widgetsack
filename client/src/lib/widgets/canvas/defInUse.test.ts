import { describe, it, expect } from 'vitest';
import { defInUse } from './useEditorModel';
import {
	container,
	group,
	leaf,
	type LayoutNode,
	type Library,
	type MonitorLayout
} from '../../core/layoutTree';
import type { EditorState } from './types';

// A floating leaf that is an instance (group) of `defId`.
const instanceOf = (defId: string) =>
	leaf(group(`grp-${defId}`, { w: 10, h: 10 }, container('inner', 'col', []), { def: defId }));

function stub(over: Partial<EditorState>): EditorState {
	const empty: MonitorLayout = { root: container('root', 'col', []), floating: [] };
	return {
		mode: { kind: 'layout' },
		monitor: empty,
		library: { version: 1, defs: [] },
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
		studio: true,
		...over
	} as EditorState;
}

describe('defInUse (guards widget deletion)', () => {
	it('is true when an instance of the def is placed on the monitor', () => {
		const monitor: MonitorLayout = {
			root: container('root', 'col', []),
			floating: [instanceOf('def-x')]
		};
		expect(defInUse(stub({ monitor }), 'def-x')).toBe(true);
	});

	it('is false when no instance is placed', () => {
		const plain = leaf({ id: 'w', type: 'text', rect: { x: 0, y: 0, w: 1, h: 1 }, config: {} });
		const monitor: MonitorLayout = { root: container('root', 'col', [plain]), floating: [] };
		expect(defInUse(stub({ monitor }), 'def-x')).toBe(false);
	});

	it('checks the REAL monitor (savedMonitor) while designing another def', () => {
		const savedMonitor: MonitorLayout = {
			root: container('root', 'col', []),
			floating: [instanceOf('def-x')]
		};
		const scoped: MonitorLayout = { root: container('scoped', 'col', []), floating: [] };
		const s = stub({
			mode: { kind: 'definition', defId: 'def-y', desktop: savedMonitor, baseline: scoped },
			monitor: scoped
		});
		expect(defInUse(s, 'def-x')).toBe(true);
	});

	it('counts an instance on another saved monitor', () => {
		const other: MonitorLayout = {
			root: container('r2', 'col', [instanceOf('def-x')]),
			floating: []
		};
		expect(defInUse(stub({}), 'def-x', [other])).toBe(true);
		expect(defInUse(stub({}), 'def-x', [])).toBe(false);
	});

	it('counts an instance queued to move to another monitor', () => {
		expect(
			defInUse(stub({ pendingExtras: [{ key: 'm2', leaf: instanceOf('def-x') }] }), 'def-x')
		).toBe(true);
	});

	it('counts an instance nested in an inline group', () => {
		const inline = leaf(group('inline', { w: 10, h: 10 }, instanceOf('def-x')));
		const monitor: MonitorLayout = { root: container('root', 'col', [inline]), floating: [] };
		expect(defInUse(stub({ monitor }), 'def-x')).toBe(true);
	});

	it('counts another library def that nests it, transitively', () => {
		const def = (id: string, child: LayoutNode) => ({
			id,
			name: id,
			size: { w: 10, h: 10 },
			child
		});
		const library: Library = {
			version: 1,
			defs: [
				def('def-x', container('x', 'col', [])),
				def('def-mid', instanceOf('def-x')),
				def('def-top', instanceOf('def-mid'))
			]
		};
		expect(defInUse(stub({ library }), 'def-x')).toBe(true);
		expect(defInUse(stub({ library }), 'def-mid')).toBe(true);
		expect(defInUse(stub({ library }), 'def-top')).toBe(false);
		expect(defInUse(stub({ library: undefined }), 'def-x')).toBe(false);
	});
});
