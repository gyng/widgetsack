import { describe, expect, it } from 'vitest';
import { desktopMonitor, editedLibrary, type EditorMode } from './editorMode';
import { container, type Library } from './layoutTree';

describe('editor mode projections', () => {
	it('folds the edited definition without changing the desktop, sibling definitions or input library', () => {
		const desktop = { root: container('desktop', 'row', []), floating: [] };
		const monitor = { root: container('edited', 'col', []), floating: [] };
		const def = {
			id: 'd',
			name: 'd',
			size: { w: 100, h: 100 },
			child: container('original', 'col', [])
		};
		const sibling = { ...def, id: 'other' };
		const library: Library = { version: 1, defs: [def, sibling] };
		const mode: EditorMode = { kind: 'definition', defId: 'd', desktop, baseline: monitor };
		const next = editedLibrary({ mode, monitor, library })!;
		expect(next.defs[0].child).toBe(monitor.root);
		expect(next.defs[1]).toBe(sibling);
		expect(library.defs[0].child.id).toBe('original');
		expect(desktopMonitor({ mode, monitor })).toBe(desktop);
		expect(editedLibrary({ mode, monitor, library: next })).toBe(next);
	});
	it('never promotes a read-only preview into the library', () => {
		const monitor = { root: container('preview', 'col', []), floating: [] };
		const desktop = { root: container('desktop', 'row', []), floating: [] };
		const definition = { id: 'd', name: 'd', size: { w: 100, h: 100 }, child: monitor.root };
		const library: Library = { version: 1, defs: [] };
		const mode: EditorMode = { kind: 'preview', definition, desktop };
		expect(editedLibrary({ mode, monitor, library })).toBe(library);
		expect(desktopMonitor({ mode, monitor })).toBe(desktop);
	});
});
