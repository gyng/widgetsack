import { describe, expect, it } from 'vitest';
import { innermostContainerAt, type ContainerBox } from './containerAt';

const box = (id: string, x: number, y: number, w: number, h: number): ContainerBox => ({
	id,
	rect: { x, y, w, h }
});

describe('innermostContainerAt', () => {
	it('picks the deepest container when a nested cell FILLS its parent (equal rects)', () => {
		// Pre-order order (parent before child), all the same rect — the regression case: splitting
		// must target `inner`, the cell actually under the cursor, not the equal-sized `outer` wrapper.
		const boxes = [
			box('root', 0, 0, 100, 100),
			box('outer', 0, 0, 100, 100),
			box('inner', 0, 0, 100, 100)
		];
		expect(innermostContainerAt(boxes, { x: 50, y: 50 }, 'root')).toBe('inner');
	});

	it('picks the strictly-smaller cell the cursor is inside', () => {
		const boxes = [
			box('root', 0, 0, 100, 100),
			box('left', 0, 0, 50, 100),
			box('right', 50, 0, 50, 100)
		];
		expect(innermostContainerAt(boxes, { x: 10, y: 50 }, 'root')).toBe('left');
		expect(innermostContainerAt(boxes, { x: 90, y: 50 }, 'root')).toBe('right');
	});

	it('rejects a LATER but strictly-larger box containing the point (keeps the smaller)', () => {
		// Not pre-order here on purpose: the small box comes first, so the later, larger container
		// must lose to the current best instead of stealing the hit.
		const boxes = [box('inner', 0, 0, 50, 50), box('outer', 0, 0, 100, 100)];
		expect(innermostContainerAt(boxes, { x: 10, y: 10 }, 'root')).toBe('inner');
	});

	it('falls back to the root id when the point is outside every box', () => {
		const boxes = [box('a', 0, 0, 10, 10)];
		expect(innermostContainerAt(boxes, { x: 50, y: 50 }, 'root')).toBe('root');
	});

	it('is right/bottom-edge exclusive (a point on the far edge is outside)', () => {
		const boxes = [box('a', 0, 0, 100, 100)];
		expect(innermostContainerAt(boxes, { x: 100, y: 50 }, 'root')).toBe('root');
		expect(innermostContainerAt(boxes, { x: 0, y: 0 }, 'root')).toBe('a');
	});
});
