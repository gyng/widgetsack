import { describe, expect, it } from 'vitest';
import { clampMenuToViewport, contextMenuAnchor } from './menuPosition';

describe('clampMenuToViewport', () => {
	const vw = 1000;
	const vh = 800;

	it('leaves a menu that fits where it opened', () => {
		expect(clampMenuToViewport(20, 30, 120, 200, vw, vh)).toEqual({ left: 20, top: 30 });
	});

	it('shifts left when the menu overflows the right edge', () => {
		// 950 + 120 = 1070 > 1000 - 4 → left = 1000 - 4 - 120 = 876
		expect(clampMenuToViewport(950, 30, 120, 200, vw, vh)).toEqual({ left: 876, top: 30 });
	});

	it('shifts up when the menu overflows the bottom edge', () => {
		// 700 + 200 = 900 > 800 - 4 → top = 800 - 4 - 200 = 596
		expect(clampMenuToViewport(20, 700, 120, 200, vw, vh)).toEqual({ left: 20, top: 596 });
	});

	it('clamps both axes at once', () => {
		expect(clampMenuToViewport(950, 700, 120, 200, vw, vh)).toEqual({ left: 876, top: 596 });
	});

	it('pins to the top-left margin when the menu is larger than the viewport', () => {
		expect(clampMenuToViewport(500, 500, 2000, 2000, vw, vh)).toEqual({ left: 4, top: 4 });
	});

	it('honours a custom margin', () => {
		expect(clampMenuToViewport(990, 10, 120, 50, vw, vh, 10)).toEqual({ left: 870, top: 10 });
	});
});

describe('contextMenuAnchor', () => {
	const box = { left: 100, top: 200, width: 60, height: 100 };

	it('a mouse right-click opens at the pointer', () => {
		expect(contextMenuAnchor({ clientX: 120, clientY: 230, button: 2 }, box)).toEqual({
			x: 120,
			y: 230
		});
	});

	it('a keyboard-initiated contextmenu (button 0, 0/0) anchors at the target box, not the corner', () => {
		expect(contextMenuAnchor({ clientX: 0, clientY: 0, button: 0 }, box)).toEqual({
			x: 130,
			y: 216
		});
	});

	it('button !== 2 with a real position still anchors on the target (keyboard on some platforms)', () => {
		expect(contextMenuAnchor({ clientX: 5, clientY: 7, button: 0 }, box)).toEqual({
			x: 130,
			y: 216
		});
	});

	it('a short target anchors at its vertical centre', () => {
		expect(
			contextMenuAnchor({ clientX: 0, clientY: 0, button: 2 }, { ...box, height: 20 })
		).toEqual({ x: 130, y: 210 });
	});
});
