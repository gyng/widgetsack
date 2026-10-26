import { describe, it, expect } from 'vitest';
import {
	overlayPresentation,
	isWholeWindowInteractive,
	isTextEntry,
	overlayFocusPolicy
} from './overlayPresentation';

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

	it("'desktop' layer stays below windows (the backend only lifts it during Show Desktop)", () => {
		expect(
			overlayPresentation({ windowed: false, layer: 'desktop', editMode: false })
		).toMatchObject({ alwaysOnTop: false, alwaysOnBottom: true, clickThrough: true });
	});

	it('a passive overlay is click-through on every layer — main and secondaries alike', () => {
		// The window's role is not an input any more: `main` used to be always interactive, which made
		// the whole primary monitor swallow clicks. Recovery from a stuck window is the backend rescue.
		for (const layer of ['bottom', 'desktop', 'top', 'wallpaper'] as const) {
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

describe('isTextEntry', () => {
	it.each([
		['a text input', { tagName: 'INPUT', type: 'text' }],
		['an input with no type (defaults to text)', { tagName: 'input' }],
		['a search / number / password input', { tagName: 'INPUT', type: 'search' }],
		['a textarea (sticky note, chat box)', { tagName: 'TEXTAREA' }],
		['a select', { tagName: 'SELECT', type: 'select-one' }],
		['a contenteditable region (or a node inside one)', { tagName: 'DIV', isContentEditable: true }]
	])('%s needs the keyboard', (_label, target) => {
		expect(isTextEntry(target)).toBe(true);
	});

	it.each([
		['nothing', null],
		['a button (media control)', { tagName: 'BUTTON', type: 'submit' }],
		['a checkbox (HA toggle, checklist tick)', { tagName: 'INPUT', type: 'checkbox' }],
		['a range slider (volume, HA brightness)', { tagName: 'INPUT', type: 'range' }],
		['a plain div', { tagName: 'DIV', isContentEditable: false }],
		['a read-only input', { tagName: 'INPUT', type: 'text', readOnly: true }],
		['a read-only textarea', { tagName: 'TEXTAREA', readOnly: true }],
		['a disabled input', { tagName: 'INPUT', type: 'text', disabled: true }]
	])('%s does not', (_label, target) => {
		expect(isTextEntry(target)).toBe(false);
	});
});

describe('overlayFocusPolicy', () => {
	it('a passive overlay is non-activating, so a widget click never steals focus', () => {
		expect(overlayFocusPolicy({ windowed: false, editMode: false, textEntry: false })).toEqual({
			focusable: false,
			activate: false
		});
	});

	it('a pressed text entry makes the overlay focusable AND activates it for the keyboard', () => {
		expect(overlayFocusPolicy({ windowed: false, editMode: false, textEntry: true })).toEqual({
			focusable: true,
			activate: true
		});
	});

	it('edit mode and windowed-debug are focusable without forcing activation', () => {
		for (const input of [
			{ windowed: false, editMode: true, textEntry: false },
			{ windowed: false, editMode: true, textEntry: true },
			{ windowed: true, editMode: false, textEntry: true }
		]) {
			expect(overlayFocusPolicy(input)).toEqual({ focusable: true, activate: false });
		}
	});
});
