import { describe, it, expect } from 'vitest';
import { overlayPresentation, isWholeWindowInteractive } from './overlayPresentation';

describe('overlayPresentation', () => {
	it('a passive secondary overlay (below windows) is borderless + click-through', () => {
		const p = overlayPresentation({
			windowed: false,
			layer: 'bottom',
			editMode: false
		});
		expect(p).toEqual({
			decorations: false,
			taskbar: false,
			alwaysOnTop: false,
			alwaysOnBottom: true,
			clickThrough: true,
			opaque: false
		});
	});

	it("'top' layer floats above windows; 'wallpaper' is neither top nor bottom", () => {
		expect(overlayPresentation({ windowed: false, layer: 'top', editMode: false })).toMatchObject({
			alwaysOnTop: true,
			alwaysOnBottom: false
		});
		expect(
			overlayPresentation({ windowed: false, layer: 'wallpaper', editMode: false })
		).toMatchObject({ alwaysOnTop: false, alwaysOnBottom: false });
	});

	it('a passive overlay is click-through on every layer — main and secondaries alike', () => {
		// The window's role is not an input any more: `main` used to be always interactive, which made
		// the whole primary monitor swallow clicks. Recovery from a stuck window is the backend rescue.
		for (const layer of ['bottom', 'top', 'wallpaper'] as const) {
			expect(overlayPresentation({ windowed: false, layer, editMode: false }).clickThrough).toBe(
				true
			);
			expect(isWholeWindowInteractive({ windowed: false, layer, editMode: false })).toBe(false);
		}
	});

	it('edit mode makes any overlay whole-window interactive', () => {
		const p = overlayPresentation({
			windowed: false,
			layer: 'bottom',
			editMode: true
		});
		expect(p.clickThrough).toBe(false);
	});

	it('windowed-debug mode overrides everything: decorated, interactive, taskbar, opaque, not topmost', () => {
		// even with a 'top' layer + passive secondary, windowed wins
		const p = overlayPresentation({
			windowed: true,
			layer: 'top',
			editMode: false
		});
		expect(p).toEqual({
			decorations: true,
			taskbar: true,
			alwaysOnTop: false,
			alwaysOnBottom: false,
			clickThrough: false,
			opaque: true
		});
	});

	it('isWholeWindowInteractive is the complement of clickThrough', () => {
		const passiveSecondary = {
			windowed: false,
			layer: 'bottom' as const,
			editMode: false
		};
		expect(isWholeWindowInteractive(passiveSecondary)).toBe(false);
	});
});
