// The built-in control inventory. Importing this module registers every default control as a
// side-effect (the same pattern as telemetry/source.ts calling registerSource at load) so the studio
// hint bar, the keyboard/pointer hooks, and the Settings panel all read one source of truth. Adding a
// control here makes it appear everywhere. Plugins contribute more via registerPlugin (Phase 6).
//
// Gating lives in `when(ctx)` over the plain ControlContext (NOT per-widget state — the movable /
// in-flow checks stay in WidgetHost). Scope is metadata for hint-filtering + conflict-scoping; actual
// applicability is the `when` predicate (e.g. an "editing" control allows studio OR overlay edit mode).
// A control is advertised in the studio powerbar IFF it has `hintOrder` (also its sort key).
import { formatTrigger, registerControl, type Control, type Trigger } from './controls';

// The "can edit" gate, faithfully reproducing the old keyboard guard `studio || editMode()` where
// editMode() folded in `!previewing`. In the studio (always an editor) this is true; in the live
// overlay it requires Ctrl+E edit mode; a studio template preview is read-only (overlay only — in the
// studio `studio` short-circuits, matching the prior behavior).
const canEdit = (c: { studio: boolean; editMode: boolean; previewing: boolean }): boolean =>
	c.studio || (c.editMode && !c.previewing);

// Nudge accepts the 4 arrows with OR without Shift (Shift = grid step, applied by the hook). With
// modifier-exact matching that means 8 triggers; the hint collapses them to 'Arrows'.
const ARROWS = ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'];
const nudgeTriggers: Trigger[] = ARROWS.flatMap((key) => [
	{ type: 'key', key } as Trigger,
	{ type: 'key', key, shift: true } as Trigger
]);

const CONTROLS: Control[] = [
	// ---- keyboard (not advertised in the bar: standard shortcuts) ----
	{
		// Escape backs out: close an open context/overflow menu if one is up, else clear the selection.
		// One control owns Escape (a second same-scope Escape binding would register as a conflict); the
		// Canvas handler picks which action based on whether a menu is open.
		id: 'studio.closeMenu',
		scope: 'studio',
		group: 'edit',
		label: 'Close menu / deselect',
		triggers: [{ type: 'key', key: 'escape' }],
		when: (c) => c.menuOpen || (c.studio && c.hasSelection),
		allowInInput: true
	},
	{
		id: 'global.toggleEdit',
		scope: 'global',
		group: 'edit',
		label: 'Toggle edit mode',
		triggers: [{ type: 'key', key: 'e', ctrl: true }],
		allowInInput: true
	},
	{
		id: 'studio.save',
		scope: 'studio',
		group: 'file',
		label: 'Save',
		triggers: [{ type: 'key', key: 's', ctrl: true }],
		when: (c) => c.studio && c.dirty,
		allowInInput: true,
		// Leftmost in the bar, and only while there are unsaved changes (its own `when`), so the user
		// learns Ctrl+S from the primary discoverability surface instead of only the toolbar tooltip.
		// (The bar lowercases the label via CSS.)
		hintOrder: 0
	},
	{
		id: 'studio.undo',
		scope: 'studio',
		group: 'edit',
		label: 'Undo',
		triggers: [{ type: 'key', key: 'z', ctrl: true }],
		when: canEdit,
		// Advertised only when there's history to undo (canEdit alone is always true in the studio).
		hintOrder: 9,
		hintWhen: (c) => c.studio && !!c.canUndo
	},
	{
		id: 'studio.redo',
		scope: 'studio',
		group: 'edit',
		label: 'Redo',
		triggers: [
			{ type: 'key', key: 'y', ctrl: true },
			{ type: 'key', key: 'z', ctrl: true, shift: true }
		],
		when: canEdit
	},
	{
		id: 'studio.panHold',
		scope: 'studio',
		group: 'view',
		label: 'Pan mode (hold)',
		triggers: [{ type: 'key', code: 'Space' }],
		when: (c) => c.studio && c.editMode
	},
	// ---- navigation (keyboard-reachable section switching; not advertised in the bar to avoid
	// crowding the gesture row — discoverable via the Controls panel). The hook derives the section
	// index from the digit (like studio.nudge); Next/Prev cycle via the handler map.
	{
		id: 'studio.section',
		scope: 'studio',
		group: 'navigation',
		label: 'Go to section 1–9',
		triggers: Array.from({ length: 9 }, (_, i) => ({
			type: 'key',
			key: String(i + 1),
			ctrl: true
		})) as Trigger[],
		when: (c) => c.studio
	},
	{
		id: 'studio.sectionNext',
		scope: 'studio',
		group: 'navigation',
		label: 'Next section',
		triggers: [{ type: 'key', key: 'tab', ctrl: true }],
		when: (c) => c.studio
	},
	{
		id: 'studio.sectionPrev',
		scope: 'studio',
		group: 'navigation',
		label: 'Previous section',
		triggers: [{ type: 'key', key: 'tab', ctrl: true, shift: true }],
		when: (c) => c.studio
	},
	// ---- selection (advertised when a selection exists) ----
	{
		id: 'studio.delete',
		scope: 'studio',
		group: 'selection',
		label: 'remove',
		triggers: [
			{ type: 'key', key: 'delete' },
			{ type: 'key', key: 'backspace' }
		],
		when: (c) => canEdit(c) && c.hasSelection,
		hintOrder: 8,
		hint: () => 'Del',
		// Surface the count so a count-blind Del (remove N when you meant 1) reads in the bar too.
		hintLabel: (c) => ((c.selectionCount ?? 0) > 1 ? `remove (${c.selectionCount})` : 'remove')
	},
	{
		id: 'studio.nudge',
		scope: 'studio',
		group: 'selection',
		label: 'nudge',
		triggers: nudgeTriggers,
		when: (c) => canEdit(c) && c.hasSelection,
		repeatable: true,
		hintOrder: 7,
		hint: () => 'Arrows',
		hintLabel: (c) => ((c.selectionCount ?? 0) > 1 ? `nudge (${c.selectionCount})` : 'nudge')
	},
	{
		// Select every widget on the monitor. allowInInput stays false so Ctrl+A inside a text field
		// selects the field's text natively (the hook's text-field guard returns early there).
		id: 'studio.selectAll',
		scope: 'studio',
		group: 'selection',
		label: 'Select all',
		triggers: [{ type: 'key', key: 'a', ctrl: true }],
		when: canEdit
	},
	// ---- pointer (the curated gesture bar) ----
	{
		id: 'studio.selectWidget',
		scope: 'studio',
		group: 'selection',
		label: 'select',
		triggers: [{ type: 'pointer', button: 'left', kind: 'click', target: 'widget' }],
		when: canEdit,
		hintOrder: 1
	},
	{
		id: 'studio.moveWidget',
		scope: 'studio',
		group: 'edit',
		label: 'move',
		triggers: [{ type: 'pointer', button: 'left', kind: 'drag', target: 'widget' }],
		when: canEdit,
		hintOrder: 2
	},
	{
		id: 'studio.freeMoveWidget',
		scope: 'studio',
		group: 'edit',
		label: 'free-move (no docking)',
		triggers: [{ type: 'pointer', button: 'right', kind: 'drag', target: 'widget' }],
		when: canEdit
	},
	{
		id: 'studio.contextMenu',
		scope: 'studio',
		group: 'edit',
		label: 'menu',
		triggers: [{ type: 'pointer', button: 'right', kind: 'click', target: 'any' }],
		when: canEdit,
		hintOrder: 3
	},
	{
		id: 'studio.panDrag',
		scope: 'studio',
		group: 'view',
		label: 'pan',
		triggers: [
			{ type: 'pointer', button: 'middle', kind: 'drag', target: 'any' },
			{ type: 'pointer', button: 'left', kind: 'drag', target: 'any', spaceHeld: true }
		],
		when: (c) => c.studio,
		hintOrder: 4,
		// Advertise the gesture that fits the current mode: Space+Drag while Space is held, else the
		// middle-drag. Picks from the EFFECTIVE triggers so a remap still formats correctly.
		hint: (c, ts) => {
			const pick = c.spaceDown
				? ts.find((t) => t.type === 'pointer' && t.spaceHeld)
				: ts.find((t) => t.type === 'pointer' && t.button === 'middle');
			return formatTrigger(pick ?? ts[0]);
		}
	},
	{
		id: 'studio.marquee',
		scope: 'studio',
		group: 'selection',
		label: 'marquee',
		// Plain left-drag on empty canvas (spaceHeld up so Space+drag pans instead). Not advertised —
		// the bar shows the Shift+Drag (additive) variant so it doesn't collide with 'Drag → move'.
		triggers: [{ type: 'pointer', button: 'left', kind: 'drag', target: 'canvas' }],
		when: canEdit
	},
	{
		id: 'studio.marqueeAdd',
		scope: 'studio',
		group: 'selection',
		label: 'marquee',
		triggers: [{ type: 'pointer', button: 'left', kind: 'drag', target: 'canvas', shift: true }],
		when: canEdit,
		hintOrder: 5,
		// Hidden while Space is held (Space+drag pans, so a marquee hint would mislead).
		hintWhen: (c) => c.studio && !c.spaceDown
	},
	{
		id: 'studio.zoom',
		scope: 'studio',
		group: 'view',
		label: 'zoom',
		triggers: [{ type: 'wheel' }],
		when: (c) => c.studio,
		hintOrder: 6
	}
];

CONTROLS.forEach(registerControl);
