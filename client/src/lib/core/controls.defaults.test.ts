import { describe, expect, it } from 'vitest';
// Importing the defaults registers the built-in inventory as a side-effect.
import './controls.defaults';
import { detectConflicts, formatTrigger, getControl, listControls } from './controls';
import type { ControlContext, Trigger } from './controls';

const baseCtx: ControlContext = {
	scope: 'studio',
	studio: false,
	editMode: false,
	menuOpen: false,
	dirty: false,
	hasSelection: false,
	spaceDown: false,
	panning: false,
	previewing: false
};

describe('built-in controls', () => {
	it('registers the full inventory with no two controls sharing a trigger', () => {
		const all = listControls();
		expect(all.length).toBeGreaterThan(10);
		expect(detectConflicts(all)).toEqual([]);
	});

	it('pan binds both middle-drag and Space+left-drag', () => {
		const pan = getControl('studio.panDrag');
		expect(pan).toBeDefined();
		const ptrs = (pan?.triggers ?? []).filter((t) => t.type === 'pointer');
		expect(ptrs.some((t) => t.type === 'pointer' && t.button === 'middle')).toBe(true);
		expect(ptrs.some((t) => t.type === 'pointer' && t.spaceHeld)).toBe(true);
	});

	it('undo and redo are distinguished by Shift (no collision)', () => {
		expect(getControl('studio.undo')).toBeDefined();
		expect(getControl('studio.redo')).toBeDefined();
		expect(detectConflicts(listControls())).toEqual([]);
	});

	it('exposes keyboard section navigation (Ctrl+1..8 jump + Ctrl+Tab cycle)', () => {
		expect(getControl('studio.section')?.triggers.length).toBe(8);
		expect(getControl('studio.sectionNext')).toBeDefined();
		expect(getControl('studio.sectionPrev')).toBeDefined();
		// still conflict-free with the new bindings
		expect(detectConflicts(listControls())).toEqual([]);
	});
});

describe('canEdit (the studio.undo `when` gate)', () => {
	// studio.undo's `when` is the bare `canEdit` predicate, so it isolates the branches of
	// `c.studio || (c.editMode && !c.previewing)` without any other gate mixed in.
	const when = getControl('studio.undo')!.when!;

	it('is true in the studio regardless of editMode/previewing (the studio short-circuit)', () => {
		expect(when({ ...baseCtx, studio: true, editMode: false, previewing: true })).toBe(true);
	});

	it('is false in the overlay when edit mode is off', () => {
		expect(when({ ...baseCtx, studio: false, editMode: false, previewing: false })).toBe(false);
	});

	it('is true in the overlay when edit mode is on and not previewing', () => {
		expect(when({ ...baseCtx, studio: false, editMode: true, previewing: false })).toBe(true);
	});

	it('is false in the overlay edit mode while a template preview is showing', () => {
		expect(when({ ...baseCtx, studio: false, editMode: true, previewing: true })).toBe(false);
	});
});

describe('selection-count-aware hint labels (studio.delete, studio.nudge)', () => {
	it('studio.delete reads "remove" for no/singular selection and "remove (N)" for plural', () => {
		const hintLabel = getControl('studio.delete')!.hintLabel!;
		expect(hintLabel({ ...baseCtx })).toBe('remove'); // selectionCount undefined → the `?? 0` arm
		expect(hintLabel({ ...baseCtx, selectionCount: 1 })).toBe('remove');
		expect(hintLabel({ ...baseCtx, selectionCount: 3 })).toBe('remove (3)');
	});

	it('studio.nudge reads "nudge" for no/singular selection and "nudge (N)" for plural', () => {
		const hintLabel = getControl('studio.nudge')!.hintLabel!;
		expect(hintLabel({ ...baseCtx })).toBe('nudge'); // selectionCount undefined → the `?? 0` arm
		expect(hintLabel({ ...baseCtx, selectionCount: 1 })).toBe('nudge');
		expect(hintLabel({ ...baseCtx, selectionCount: 2 })).toBe('nudge (2)');
	});
});

describe('per-control gating predicates (when / hintWhen / hint)', () => {
	const when = (id: string) => getControl(id)!.when!;
	const studioCtx = { ...baseCtx, studio: true };

	it('studio.closeMenu fires for an open menu OR a studio selection', () => {
		const w = when('studio.closeMenu');
		expect(w({ ...baseCtx, menuOpen: true })).toBe(true);
		expect(w({ ...studioCtx, hasSelection: true })).toBe(true);
		expect(w({ ...baseCtx, hasSelection: true })).toBe(false); // selection alone, outside the studio
		expect(w(baseCtx)).toBe(false);
	});

	it('studio.save requires the studio AND unsaved changes', () => {
		const w = when('studio.save');
		expect(w({ ...studioCtx, dirty: true })).toBe(true);
		expect(w(studioCtx)).toBe(false);
		expect(w({ ...baseCtx, dirty: true })).toBe(false);
	});

	it('studio.undo is advertised only with history to undo', () => {
		const hintWhen = getControl('studio.undo')!.hintWhen!;
		expect(hintWhen({ ...studioCtx, canUndo: true })).toBe(true);
		expect(hintWhen(studioCtx)).toBe(false); // canUndo absent → !! coerces to false
	});

	it('studio.panHold needs studio edit mode', () => {
		const w = when('studio.panHold');
		expect(w({ ...studioCtx, editMode: true })).toBe(true);
		expect(w(studioCtx)).toBe(false);
	});

	it('the studio-only gates (sections, panDrag, zoom) pass in the studio, fail in the overlay', () => {
		for (const id of [
			'studio.section',
			'studio.sectionNext',
			'studio.sectionPrev',
			'studio.panDrag',
			'studio.zoom'
		]) {
			expect(when(id)(studioCtx)).toBe(true);
			expect(when(id)(baseCtx)).toBe(false);
		}
	});

	it('delete and nudge need an editable context AND a selection; their key text is fixed', () => {
		for (const id of ['studio.delete', 'studio.nudge']) {
			expect(when(id)({ ...studioCtx, hasSelection: true })).toBe(true);
			expect(when(id)(studioCtx)).toBe(false); // no selection
			expect(when(id)({ ...baseCtx, hasSelection: true })).toBe(false); // not editable
		}
		expect(getControl('studio.delete')!.hint!(studioCtx, [])).toBe('Del');
		expect(getControl('studio.nudge')!.hint!(studioCtx, [])).toBe('Arrows');
	});

	it('studio.marqueeAdd hides its hint while Space is held (Space+drag pans)', () => {
		const hintWhen = getControl('studio.marqueeAdd')!.hintWhen!;
		expect(hintWhen(studioCtx)).toBe(true);
		expect(hintWhen({ ...studioCtx, spaceDown: true })).toBe(false);
	});
});

describe('studio.panDrag hint (Space+drag vs middle-drag, plus the `pick ?? ts[0]` fallback)', () => {
	const hint = getControl('studio.panDrag')!.hint!;
	const triggers = getControl('studio.panDrag')!.triggers;

	it('picks the middle-drag trigger when Space is not held', () => {
		expect(hint({ ...baseCtx, spaceDown: false }, triggers)).toBe('Middle-drag');
	});

	it('picks the Space+left-drag trigger when Space is held', () => {
		expect(hint({ ...baseCtx, spaceDown: true }, triggers)).toBe('Space+Drag');
	});

	it('falls back to triggers[0] when no trigger matches the search (the `pick ?? ts[0]` arm)', () => {
		// A triggers array with no pointer entry at all: `find` returns undefined for either branch of
		// the spaceDown ternary, so `pick` stays undefined and formatTrigger falls back to ts[0].
		const noMatch: Trigger[] = [{ type: 'key', key: 'a' }];
		expect(hint({ ...baseCtx, spaceDown: false }, noMatch)).toBe(formatTrigger(noMatch[0]));
		expect(hint({ ...baseCtx, spaceDown: true }, noMatch)).toBe(formatTrigger(noMatch[0]));
	});
});
