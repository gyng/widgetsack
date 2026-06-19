import { afterEach, describe, expect, it } from 'vitest';
import {
	chordMatches,
	clearControls,
	deriveHints,
	detectConflicts,
	formatTrigger,
	getControl,
	listControls,
	matchKeyChord,
	matchPointer,
	matchWheel,
	mergeOverrides,
	parseControlOverrides,
	parseKeyEvent,
	registerControl,
	type Control,
	type ControlContext,
	type Trigger
} from './controls';

const baseCtx: ControlContext = {
	scope: 'studio',
	studio: true,
	editMode: true,
	menuOpen: false,
	dirty: false,
	hasSelection: false,
	spaceDown: false,
	panning: false,
	previewing: false
};

const ctrl = (over: Partial<Control> & Pick<Control, 'id' | 'triggers'>): Control => ({
	scope: 'studio',
	group: 'edit',
	label: over.id,
	...over
});

afterEach(() => clearControls());

describe('parseKeyEvent', () => {
	it('lowercases key, keeps code, captures all modifiers', () => {
		expect(
			parseKeyEvent({
				key: 'S',
				code: 'KeyS',
				ctrlKey: true,
				shiftKey: false,
				altKey: false,
				metaKey: false
			})
		).toEqual({ key: 's', code: 'KeyS', ctrl: true, shift: false, alt: false, meta: false });
	});
});

describe('chordMatches', () => {
	const chord = (o: Partial<ReturnType<typeof parseKeyEvent>>) => ({
		key: '',
		code: '',
		ctrl: false,
		shift: false,
		alt: false,
		meta: false,
		...o
	});

	it('is modifier-exact: an omitted modifier must be up', () => {
		// undo trigger (Ctrl+Z, shift implicitly up) must NOT match Ctrl+Shift+Z (that is redo)
		expect(chordMatches({ key: 'z', ctrl: true }, chord({ key: 'z', ctrl: true }))).toBe(true);
		expect(
			chordMatches({ key: 'z', ctrl: true }, chord({ key: 'z', ctrl: true, shift: true }))
		).toBe(false);
	});

	it('matches by code when present (Space), ignoring key', () => {
		expect(chordMatches({ code: 'Space' }, chord({ code: 'Space', key: ' ' }))).toBe(true);
		expect(chordMatches({ code: 'Space' }, chord({ code: 'KeyA', key: 'a' }))).toBe(false);
	});

	it('fails on each modifier mismatch independently (ctrl / alt / meta)', () => {
		// trigger requires the modifier UP, chord has it DOWN → bail at that exact check.
		expect(chordMatches({ key: 'a' }, chord({ key: 'a', ctrl: true }))).toBe(false); // ctrl
		expect(chordMatches({ key: 'a' }, chord({ key: 'a', alt: true }))).toBe(false); // alt
		expect(chordMatches({ key: 'a' }, chord({ key: 'a', meta: true }))).toBe(false); // meta
	});

	it('matches a plain key when no code is set', () => {
		expect(chordMatches({ key: 'a' }, chord({ key: 'a' }))).toBe(true);
		expect(chordMatches({ key: 'a' }, chord({ key: 'b' }))).toBe(false);
	});

	it('returns false for a trigger with neither key nor code', () => {
		expect(chordMatches({}, chord({ key: 'a' }))).toBe(false);
	});
});

describe('matchKeyChord', () => {
	it('returns the first enabled control whose key trigger matches', () => {
		const save = ctrl({
			id: 'save',
			triggers: [{ type: 'key', key: 's', ctrl: true }],
			when: (c) => c.dirty
		});
		const undo = ctrl({ id: 'undo', triggers: [{ type: 'key', key: 'z', ctrl: true }] });
		const controls = [save, undo];
		const chord = parseKeyEvent({
			key: 's',
			code: 'KeyS',
			ctrlKey: true,
			shiftKey: false,
			altKey: false,
			metaKey: false
		});
		// when=dirty fails → save skipped → no match
		expect(matchKeyChord(chord, controls, baseCtx)).toBeNull();
		// dirty → save matches
		expect(matchKeyChord(chord, controls, { ...baseCtx, dirty: true })?.id).toBe('save');
	});
});

describe('matchPointer', () => {
	const pan = ctrl({
		id: 'pan',
		group: 'view',
		triggers: [
			{ type: 'pointer', button: 'middle', kind: 'drag', target: 'any' },
			{ type: 'pointer', button: 'left', kind: 'drag', target: 'any', spaceHeld: true }
		]
	});
	const marquee = ctrl({
		id: 'marquee',
		triggers: [{ type: 'pointer', button: 'left', kind: 'drag', target: 'canvas' }]
	});
	const controls = [pan, marquee];

	it('middle-drag and Space+left-drag both match pan; plain left-drag on canvas is marquee', () => {
		expect(
			matchPointer({ button: 'middle', kind: 'drag', target: 'canvas' }, controls, baseCtx)?.id
		).toBe('pan');
		expect(
			matchPointer(
				{ button: 'left', kind: 'drag', target: 'canvas', spaceHeld: true },
				controls,
				baseCtx
			)?.id
		).toBe('pan');
		expect(
			matchPointer({ button: 'left', kind: 'drag', target: 'canvas' }, controls, baseCtx)?.id
		).toBe('marquee');
	});

	it('a widget-target drag does not match a canvas-target trigger', () => {
		expect(
			matchPointer({ button: 'left', kind: 'drag', target: 'widget' }, controls, baseCtx)
		).toBeNull();
	});

	it('does not match on a different button or kind', () => {
		const click = ctrl({
			id: 'click',
			triggers: [{ type: 'pointer', button: 'left', kind: 'click', target: 'widget' }]
		});
		// wrong button
		expect(
			matchPointer({ button: 'right', kind: 'click', target: 'widget' }, [click], baseCtx)
		).toBeNull();
		// wrong kind (drag vs click)
		expect(
			matchPointer({ button: 'left', kind: 'drag', target: 'widget' }, [click], baseCtx)
		).toBeNull();
	});

	it('does not match on each pointer modifier mismatch (ctrl / shift / alt / meta)', () => {
		const plain = ctrl({
			id: 'plain',
			triggers: [{ type: 'pointer', button: 'left', kind: 'click', target: 'any' }]
		});
		for (const mod of ['ctrl', 'shift', 'alt', 'meta'] as const) {
			expect(
				matchPointer(
					{ button: 'left', kind: 'click', target: 'any', [mod]: true },
					[plain],
					baseCtx
				)
			).toBeNull();
		}
	});

	it('skips a control whose only trigger is not a pointer trigger', () => {
		const keyOnly = ctrl({ id: 'k', triggers: [{ type: 'key', key: 'a' }] });
		expect(
			matchPointer({ button: 'left', kind: 'click', target: 'any' }, [keyOnly], baseCtx)
		).toBeNull();
	});

	it('skips a disabled-by-when control before testing its trigger', () => {
		const gated = ctrl({
			id: 'gated',
			when: (c) => c.hasSelection,
			triggers: [{ type: 'pointer', button: 'left', kind: 'click', target: 'any' }]
		});
		expect(
			matchPointer({ button: 'left', kind: 'click', target: 'any' }, [gated], baseCtx)
		).toBeNull();
		expect(
			matchPointer({ button: 'left', kind: 'click', target: 'any' }, [gated], {
				...baseCtx,
				hasSelection: true
			})?.id
		).toBe('gated');
	});
});

describe('matchWheel', () => {
	it('matches a plain wheel zoom control', () => {
		const zoom = ctrl({ id: 'zoom', group: 'view', triggers: [{ type: 'wheel' }] });
		expect(matchWheel({ ctrl: false, shift: false, alt: false }, [zoom], baseCtx)?.id).toBe('zoom');
		expect(matchWheel({ ctrl: true, shift: false, alt: false }, [zoom], baseCtx)).toBeNull();
	});

	it('skips a control whose only trigger is not a wheel trigger', () => {
		const keyOnly = ctrl({ id: 'k', triggers: [{ type: 'key', key: 'a' }] });
		expect(matchWheel({ ctrl: false, shift: false, alt: false }, [keyOnly], baseCtx)).toBeNull();
	});

	it('respects shift/alt modifier requirements on a wheel trigger', () => {
		const ctrlZoom = ctrl({ id: 'z', triggers: [{ type: 'wheel', ctrl: true }] });
		expect(matchWheel({ ctrl: true, shift: false, alt: false }, [ctrlZoom], baseCtx)?.id).toBe('z');
		expect(matchWheel({ ctrl: true, shift: true, alt: false }, [ctrlZoom], baseCtx)).toBeNull();
		expect(matchWheel({ ctrl: true, shift: false, alt: true }, [ctrlZoom], baseCtx)).toBeNull();
	});

	it('skips a disabled-by-when control', () => {
		const gated = ctrl({ id: 'g', when: (c) => c.dirty, triggers: [{ type: 'wheel' }] });
		expect(matchWheel({ ctrl: false, shift: false, alt: false }, [gated], baseCtx)).toBeNull();
	});
});

describe('mergeOverrides', () => {
	const save = ctrl({ id: 'save', triggers: [{ type: 'key', key: 's', ctrl: true }] });
	const del = ctrl({ id: 'del', triggers: [{ type: 'key', key: 'delete' }] });

	it('replaces triggers, drops disabled, ignores unknown ids', () => {
		const merged = mergeOverrides([save, del], {
			save: { triggers: [{ type: 'key', key: 's', ctrl: true, shift: true }] },
			del: { disabled: true },
			ghost: { disabled: true }
		});
		expect(merged.map((c) => c.id)).toEqual(['save']); // del dropped, ghost ignored
		expect((merged[0].triggers[0] as { shift?: boolean }).shift).toBe(true);
	});

	it('passes a control through unchanged when it has no override', () => {
		const merged = mergeOverrides([save, del], {});
		expect(merged).toEqual([save, del]); // both untouched
		expect(merged[0]).toBe(save); // same reference (no clone)
	});

	it('keeps the original control when an override has neither triggers nor disabled', () => {
		const merged = mergeOverrides([save], { save: {} });
		expect(merged).toHaveLength(1);
		expect(merged[0]).toBe(save); // the `: c` arm — override present but inert
	});
});

describe('parseControlOverrides', () => {
	it('keeps valid overrides and drops malformed ones', () => {
		const obj = {
			version: 1,
			overrides: {
				save: { triggers: [{ type: 'key', key: 's', ctrl: true }] },
				del: { disabled: true },
				bad1: { triggers: 'nope' },
				bad2: 42
			}
		};
		const o = parseControlOverrides(obj);
		expect(Object.keys(o).sort()).toEqual(['del', 'save']);
		expect(o.del.disabled).toBe(true);
	});

	it('returns empty for garbage input', () => {
		expect(parseControlOverrides(null)).toEqual({});
		expect(parseControlOverrides({ nope: true })).toEqual({});
	});

	it('returns empty when overrides is not an object', () => {
		expect(parseControlOverrides({ overrides: 'nope' })).toEqual({});
		expect(parseControlOverrides({ overrides: null })).toEqual({});
	});

	it('accepts pointer and wheel triggers (every isTrigger arm)', () => {
		const o = parseControlOverrides({
			overrides: {
				pan: { triggers: [{ type: 'pointer', button: 'middle', kind: 'drag', target: 'any' }] },
				zoom: { triggers: [{ type: 'wheel', ctrl: true }] }
			}
		});
		expect(Object.keys(o).sort()).toEqual(['pan', 'zoom']);
	});

	it('drops an override whose triggers array contains a non-object or wrong-type element', () => {
		const o = parseControlOverrides({
			overrides: {
				// 42 is truthy but not an object → isTrigger false → every() false → triggers dropped,
				// and with no disabled the whole override is dropped.
				a: { triggers: [{ type: 'key', key: 's' }, 42] },
				// an object with a bad `type` → isTrigger false
				b: { triggers: [{ type: 'nope' }] },
				// null element → the `!t` arm of isTrigger
				c: { triggers: [null] }
			}
		});
		expect(o).toEqual({});
	});

	it('skips an override value that is not an object', () => {
		expect(parseControlOverrides({ overrides: { a: 5, b: 'x' } })).toEqual({});
	});
});

describe('formatTrigger', () => {
	const cases: [Trigger, string][] = [
		[{ type: 'key', key: 's', ctrl: true }, 'Ctrl+S'],
		[{ type: 'key', key: 'z', ctrl: true, shift: true }, 'Ctrl+Shift+Z'],
		[{ type: 'key', key: 'f', alt: true }, 'Alt+F'],
		[{ type: 'key', key: 'k', meta: true }, 'Cmd+K'],
		[{ type: 'key', key: 'escape' }, 'Esc'],
		[{ type: 'key', key: 'delete' }, 'Del'],
		[{ type: 'key', code: 'Space' }, 'Space'],
		[{ type: 'key', key: 'arrowleft' }, '←'],
		// a multi-char key with no map entry → title-cased (the k.length !== 1 arm of keyLabel)
		[{ type: 'key', key: 'home' }, 'Home'],
		// code-only key, code !== 'Space' → key falls back to '' (the `t.key ?? ''` arm)
		[{ type: 'key', code: 'F13' }, ''],
		[{ type: 'pointer', button: 'middle', kind: 'drag', target: 'any' }, 'Middle-drag'],
		[{ type: 'pointer', button: 'right', kind: 'click', target: 'any' }, 'Right-click'],
		[{ type: 'pointer', button: 'right', kind: 'drag', target: 'widget' }, 'Right-drag'],
		[
			{ type: 'pointer', button: 'left', kind: 'drag', target: 'canvas', shift: true },
			'Shift+Drag'
		],
		[{ type: 'pointer', button: 'left', kind: 'click', target: 'any', ctrl: true }, 'Ctrl+Click'],
		[{ type: 'pointer', button: 'left', kind: 'click', target: 'any', alt: true }, 'Alt+Click'],
		[{ type: 'pointer', button: 'left', kind: 'click', target: 'any', meta: true }, 'Cmd+Click'],
		[
			{ type: 'pointer', button: 'left', kind: 'drag', target: 'any', spaceHeld: true },
			'Space+Drag'
		],
		[{ type: 'pointer', button: 'left', kind: 'drag', target: 'widget' }, 'Drag'],
		[{ type: 'pointer', button: 'left', kind: 'click', target: 'widget' }, 'Click'],
		[{ type: 'wheel' }, 'Scroll'],
		[{ type: 'wheel', ctrl: true }, 'Ctrl+Scroll'],
		[{ type: 'wheel', shift: true }, 'Shift+Scroll'],
		[{ type: 'wheel', alt: true }, 'Alt+Scroll']
	];
	it.each(cases)('formats %j as %s', (trigger, expected) => {
		expect(formatTrigger(trigger)).toBe(expected);
	});
});

describe('deriveHints', () => {
	const controls = (): Control[] => [
		ctrl({
			id: 'move',
			label: 'move',
			triggers: [{ type: 'pointer', button: 'left', kind: 'drag', target: 'widget' }],
			hintOrder: 2
		}),
		ctrl({
			id: 'pan',
			label: 'pan',
			group: 'view',
			triggers: [
				{ type: 'pointer', button: 'middle', kind: 'drag', target: 'any' },
				{ type: 'pointer', button: 'left', kind: 'drag', target: 'any', spaceHeld: true }
			],
			hintOrder: 4,
			hint: (c, ts) => formatTrigger(c.spaceDown ? ts[1] : ts[0])
		}),
		ctrl({
			id: 'marqueeAdd',
			label: 'marquee',
			group: 'selection',
			triggers: [{ type: 'pointer', button: 'left', kind: 'drag', target: 'canvas', shift: true }],
			hintOrder: 5,
			hintWhen: (c) => !c.spaceDown
		}),
		ctrl({
			id: 'nudge',
			label: 'nudge',
			group: 'selection',
			triggers: [{ type: 'key', key: 'arrowleft' }],
			hintOrder: 7,
			hintWhen: (c) => c.hasSelection,
			hint: () => 'Arrows'
		}),
		// not advertised (no hintOrder) — a real control but not bar-worthy
		ctrl({ id: 'save', label: 'save', triggers: [{ type: 'key', key: 's', ctrl: true }] })
	];

	it('advertises only hintOrder controls, sorted; shows Middle-drag for pan (the drift fix)', () => {
		const hints = deriveHints(controls(), baseCtx);
		expect(hints).toEqual([
			{ key: 'Drag', label: 'move' },
			{ key: 'Middle-drag', label: 'pan' },
			{ key: 'Shift+Drag', label: 'marquee' }
		]);
	});

	it('swaps pan to Space+Drag and hides the marquee while Space is held', () => {
		const hints = deriveHints(controls(), { ...baseCtx, spaceDown: true });
		const keys = hints.map((h) => h.key);
		expect(keys).toContain('Space+Drag');
		expect(keys).not.toContain('Shift+Drag');
		expect(keys).not.toContain('Middle-drag');
	});

	it('shows the selection-gated nudge only with a selection', () => {
		expect(deriveHints(controls(), baseCtx).some((h) => h.label === 'nudge')).toBe(false);
		expect(
			deriveHints(controls(), { ...baseCtx, hasSelection: true }).some((h) => h.label === 'nudge')
		).toBe(true);
	});

	it('takes over the bar while panning', () => {
		expect(deriveHints(controls(), { ...baseCtx, panning: true })).toEqual([
			{ key: 'Drag', label: 'panning view' },
			{ key: 'Release', label: 'done' }
		]);
	});

	it('advertises a global-scope control regardless of the active scope', () => {
		const global = ctrl({
			id: 'esc',
			label: 'close',
			scope: 'global',
			triggers: [{ type: 'key', key: 'escape' }],
			hintOrder: 1
		});
		const hints = deriveHints([global], { ...baseCtx, scope: 'widget' });
		expect(hints).toEqual([{ key: 'Esc', label: 'close' }]);
	});

	it('filters out an advertised control from a different (non-global) scope', () => {
		const widgetOnly = ctrl({
			id: 'w',
			label: 'widget thing',
			scope: 'widget',
			triggers: [{ type: 'key', key: 'x' }],
			hintOrder: 1
		});
		expect(deriveHints([widgetOnly], { ...baseCtx, scope: 'studio' })).toEqual([]);
	});

	it('uses a context-aware hintLabel when provided', () => {
		const withLabel = ctrl({
			id: 'undo',
			label: 'Undo',
			triggers: [{ type: 'key', key: 'z', ctrl: true }],
			hintOrder: 1,
			hintLabel: (c) => (c.canUndo ? 'Undo edit' : 'Nothing to undo')
		});
		expect(deriveHints([withLabel], baseCtx)[0].label).toBe('Nothing to undo');
		expect(deriveHints([withLabel], { ...baseCtx, canUndo: true })[0].label).toBe('Undo edit');
	});

	it('advertises a control with neither when nor hintWhen (the default-true predicate)', () => {
		const always = ctrl({
			id: 'always',
			label: 'always',
			triggers: [{ type: 'key', key: 'a' }],
			hintOrder: 1
		});
		expect(deriveHints([always], baseCtx)).toEqual([{ key: 'A', label: 'always' }]);
	});
});

describe('detectConflicts', () => {
	it('flags two same-scope controls that share an identical trigger', () => {
		const a = ctrl({ id: 'a', triggers: [{ type: 'key', key: 'x', ctrl: true }] });
		const b = ctrl({ id: 'b', triggers: [{ type: 'key', key: 'x', ctrl: true }] });
		expect(detectConflicts([a, b])).toHaveLength(1);
	});

	it('does not flag different scopes or different pointer targets', () => {
		const a = ctrl({ id: 'a', scope: 'studio', triggers: [{ type: 'key', key: 'x' }] });
		const b = ctrl({ id: 'b', scope: 'widget', triggers: [{ type: 'key', key: 'x' }] });
		const move = ctrl({
			id: 'move',
			triggers: [{ type: 'pointer', button: 'left', kind: 'drag', target: 'widget' }]
		});
		const marquee = ctrl({
			id: 'marquee',
			triggers: [{ type: 'pointer', button: 'left', kind: 'drag', target: 'canvas' }]
		});
		expect(detectConflicts([a, b])).toHaveLength(0);
		expect(detectConflicts([move, marquee])).toHaveLength(0);
	});

	it('does not flag two triggers of different types (key vs pointer)', () => {
		const a = ctrl({ id: 'a', triggers: [{ type: 'key', key: 'x' }] });
		const b = ctrl({
			id: 'b',
			triggers: [{ type: 'pointer', button: 'left', kind: 'click', target: 'any' }]
		});
		expect(detectConflicts([a, b])).toHaveLength(0);
	});

	it('flags two key triggers that collide by code (not key)', () => {
		const a = ctrl({ id: 'a', triggers: [{ type: 'key', code: 'Space' }] });
		const b = ctrl({ id: 'b', triggers: [{ type: 'key', code: 'Space' }] });
		expect(detectConflicts([a, b])).toHaveLength(1);
		// differing codes do not collide
		const c = ctrl({ id: 'c', triggers: [{ type: 'key', code: 'KeyA' }] });
		expect(detectConflicts([a, c])).toHaveLength(0);
	});

	it('does not flag key triggers that differ only by a modifier', () => {
		const a = ctrl({ id: 'a', triggers: [{ type: 'key', key: 'z', ctrl: true }] });
		const b = ctrl({ id: 'b', triggers: [{ type: 'key', key: 'z', ctrl: true, shift: true }] });
		expect(detectConflicts([a, b])).toHaveLength(0);
	});

	it('flags two identical pointer triggers and respects each modifier + spaceHeld', () => {
		const a = ctrl({
			id: 'a',
			triggers: [{ type: 'pointer', button: 'left', kind: 'drag', target: 'any' }]
		});
		const b = ctrl({
			id: 'b',
			triggers: [{ type: 'pointer', button: 'left', kind: 'drag', target: 'canvas' }]
		});
		// same button/kind, target 'any' overlaps 'canvas', no mods → collide
		expect(detectConflicts([a, b])).toHaveLength(1);
		// a differing modifier (spaceHeld) breaks the collision
		const c = ctrl({
			id: 'c',
			triggers: [{ type: 'pointer', button: 'left', kind: 'drag', target: 'any', spaceHeld: true }]
		});
		expect(detectConflicts([a, c])).toHaveLength(0);
	});

	it('flags two colliding wheel triggers and separates them by a modifier', () => {
		const a = ctrl({ id: 'a', triggers: [{ type: 'wheel' }] });
		const b = ctrl({ id: 'b', triggers: [{ type: 'wheel' }] });
		expect(detectConflicts([a, b])).toHaveLength(1);
		const c = ctrl({ id: 'c', triggers: [{ type: 'wheel', ctrl: true }] });
		expect(detectConflicts([a, c])).toHaveLength(0);
	});
});

describe('registry', () => {
	it('registers, lists, gets, and replaces by id', () => {
		registerControl(ctrl({ id: 'one', triggers: [] }));
		registerControl(ctrl({ id: 'one', label: 'replaced', triggers: [] }));
		registerControl(ctrl({ id: 'two', triggers: [] }));
		expect(listControls().map((c) => c.id)).toEqual(['one', 'two']);
		expect(getControl('one')?.label).toBe('replaced');
	});
});
