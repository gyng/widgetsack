import { describe, expect, it } from 'vitest';
import { dropBarAt, dropZoneAt } from './dropFeedback';
import { container, leaf } from './layoutTree';
import { createWidget } from './widget';

describe('drop feedback geometry', () => {
	it.each(['row', 'col'] as const)(
		'shows before/after edges along a %s parent axis, excluding the dragged leaf',
		(kind) => {
			const monitor = {
				root: container('root', kind, [leaf(createWidget('text', 'target'))]),
				floating: []
			};
			const solved = new Map([['target', { x: 20, y: 30, w: 100, h: 60 }]]);
			expect(dropBarAt(monitor, solved, { x: 21, y: 31 }, 'other')).toEqual(
				kind === 'row' ? { x: 19, y: 30, w: 2, h: 60 } : { x: 20, y: 29, w: 100, h: 2 }
			);
			expect(dropBarAt(monitor, solved, { x: 119, y: 89 }, 'other')).toEqual(
				kind === 'row' ? { x: 119, y: 30, w: 2, h: 60 } : { x: 20, y: 89, w: 100, h: 2 }
			);
			expect(dropBarAt(monitor, solved, { x: 21, y: 31 }, 'target')).toBeNull();
			expect(dropBarAt(monitor, solved, { x: 120, y: 90 }, 'other')).toBeNull();
		}
	);
	it('uses the target container for an into drop and hides it when an edge bar is present', () => {
		const monitor = { root: container('root', 'col', []), floating: [] };
		const box = { x: 0, y: 0, w: 200, h: 100 };
		const solved = new Map([['root', box]]);
		expect(dropZoneAt(monitor, solved, { parentId: 'root', index: 0 }, null)).toEqual(box);
		expect(dropZoneAt(monitor, solved, { parentId: 'root', index: 0 }, box)).toBeNull();
		expect(dropZoneAt(monitor, solved, null, null)).toBeNull();
	});
});
