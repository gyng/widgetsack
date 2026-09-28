import { describe, it, expect } from 'vitest';
import { defInUse } from './useEditorModel';
import { container, group, leaf, type MonitorLayout } from '../../core/layoutTree';
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
		expect(defInUse(stub({}), 'def-x')).toBe(false);
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
});
