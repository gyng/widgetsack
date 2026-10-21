import { expect, it } from 'vitest';
import { selectMenuPlacement } from './selectMenuPlacement';
it('keeps wide monitor menus in the viewport and sizes their border box', () => {
	expect(
		selectMenuPlacement({ left: 700, top: 100, bottom: 132, width: 120 }, { w: 800, h: 600 }, 480)
	).toEqual({ left: 312, width: 480, top: 134, maxHeight: 248 });
	expect(
		selectMenuPlacement({ left: -10, top: 550, bottom: 582, width: 300 }, { w: 400, h: 600 }, 480)
	).toEqual({ left: 8, width: 384, bottom: 52, maxHeight: 248 });
});
it('caps menu height to available space and handles narrow and offscreen triggers', () => {
	expect(
		selectMenuPlacement({ left: 20, top: 20, bottom: 52, width: 100 }, { w: 200, h: 100 })
	).toEqual({ left: 20, width: 100, top: 54, maxHeight: 38 });
	expect(
		selectMenuPlacement({ left: 0, top: -40, bottom: -8, width: 300 }, { w: 100, h: 100 })
	).toMatchObject({ left: 8, top: 8, width: 84 });
	expect(
		selectMenuPlacement({ left: 0, top: 120, bottom: 150, width: 10 }, { w: 8, h: 100 })
	).toMatchObject({ left: 8, bottom: 8, width: 0 });
});
