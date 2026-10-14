// Pure policy (AGENTS.md §5): given an overlay window's role + the current mode, decide every
// presentation flag in ONE place — OS decorations, taskbar/alt-tab presence, z-order, whole-window
// click-through, and whether the page should paint an opaque background. No Tauri/DOM/React; the
// lib/overlay.ts adapter applies the result to the real window. Tested directly.
import type { OverlayLayer } from './overlayPrefs';

export type OverlayPresentation = {
	/** OS window chrome (title bar + border). Off for a normal overlay; on for windowed-debug. */
	decorations: boolean;
	/** Visible in the taskbar / alt-tab. Off for a normal overlay; on for windowed-debug. */
	taskbar: boolean;
	/** Float above every other window. */
	alwaysOnTop: boolean;
	/** Sit below application windows (above the desktop icons). */
	alwaysOnBottom: boolean;
	/** Whole-window click-through (ignore cursor events) — clicks pass through to whatever's behind. */
	clickThrough: boolean;
	/** Paint an opaque app background (windowed-debug) instead of the see-through overlay surface. */
	opaque: boolean;
};

export type PresentationInput = {
	/** Windowed-debug mode: render the overlay as an ordinary decorated, interactive, alt-tab-able
	 *  window so a crash (or anything else) is visible, clickable, and inspectable. */
	windowed: boolean;
	/** The chosen z-order when NOT windowed. */
	layer: OverlayLayer;
	/** Editing the layout: the whole window is interactive so widgets can be selected/dragged. */
	editMode: boolean;
};

/**
 * The single source of truth for how an overlay window should present itself.
 *
 * - Windowed-debug wins over everything: a normal decorated, interactive, taskbar-present, non-topmost
 *   window with an opaque background.
 * - Otherwise it's a borderless, taskbar-skipping overlay whose z-order follows `layer`, and it is
 *   click-through whenever it is passive (not in edit mode). Every overlay — the primary `main` one
 *   included — follows the same rule: a passive overlay is whole-window click-through and the Rust
 *   cursor watcher re-enables it over interactive widget rects, so per-widget interactivity still
 *   works. A window stuck un-clickable (e.g. a crash page) is recovered from the backend: the rescue
 *   hotkey / "Rescue all windows" (rescue_all) and Diagnostics → Reload, which work even when the
 *   window's own JS is dead.
 */
export function overlayPresentation(i: PresentationInput): OverlayPresentation {
	if (i.windowed) {
		return {
			decorations: true,
			taskbar: true,
			alwaysOnTop: false,
			alwaysOnBottom: false,
			clickThrough: false,
			opaque: true
		};
	}
	return {
		decorations: false,
		taskbar: false,
		alwaysOnTop: i.layer === 'top',
		alwaysOnBottom: i.layer === 'bottom',
		clickThrough: !i.editMode,
		opaque: false
	};
}

/** Whether THIS window's whole surface is interactive (so the per-widget click-through rects are
 *  unnecessary and should be cleared). The complement of `clickThrough`. Pure. */
export function isWholeWindowInteractive(i: PresentationInput): boolean {
	return !overlayPresentation(i).clickThrough;
}

/** The minimal element shape the focus policy reads (an HTMLElement satisfies it) — keeps this
 *  module DOM-free and testable with plain objects. */
export type FocusTarget = {
	tagName: string;
	type?: string;
	isContentEditable?: boolean;
	readOnly?: boolean;
	disabled?: boolean;
};

/** `<input>` types that are pressed, not typed into — a click on one needs no keyboard focus. */
const NON_TEXT_INPUT_TYPES = new Set([
	'button',
	'checkbox',
	'color',
	'file',
	'hidden',
	'image',
	'radio',
	'range',
	'reset',
	'submit'
]);

/** Whether `t` is a text entry that needs the keyboard (and so the overlay window must be able to
 *  take activation): an editable text-like `<input>`, a `<textarea>`, a `<select>` (its dropdown and
 *  type-ahead need focus), or anything inside a contenteditable. Buttons, toggles and sliders don't —
 *  clicking them must leave the foreground app active. Pure. */
export function isTextEntry(t: FocusTarget | null | undefined): boolean {
	if (!t || t.disabled) return false;
	if (t.isContentEditable) return true;
	switch (t.tagName.toUpperCase()) {
		case 'TEXTAREA':
			return !t.readOnly;
		case 'SELECT':
			return true;
		case 'INPUT':
			return !t.readOnly && !NON_TEXT_INPUT_TYPES.has((t.type ?? 'text').toLowerCase());
		default:
			return false;
	}
}

export type FocusPolicyInput = {
	/** Windowed-debug: an ordinary window, always focusable. */
	windowed: boolean;
	/** Overlay edit mode: the whole window is interactive (and Inspector fields take typing). */
	editMode: boolean;
	/** A text entry in this overlay was just pressed and still holds focus. */
	textEntry: boolean;
};

export type FocusPolicy = {
	/** `false` = WS_EX_NOACTIVATE: clicking the overlay doesn't steal activation. */
	focusable: boolean;
	/** Bring the window to the foreground now (only for a pressed text entry on an otherwise
	 *  passive overlay — edit mode / windowed windows activate on click like any window). */
	activate: boolean;
};

/** The overlay's activation policy (WS_EX_NOACTIVATE). A passive overlay never takes activation, so
 *  clicking a media button or an HA toggle leaves the foreground app focused; it becomes focusable
 *  only while a text entry needs the keyboard, in overlay edit mode, or as a windowed-debug window.
 *  The studio never participates. Pure. */
export function overlayFocusPolicy(i: FocusPolicyInput): FocusPolicy {
	const focusable = i.windowed || i.editMode || i.textEntry;
	return { focusable, activate: i.textEntry && !i.windowed && !i.editMode };
}
