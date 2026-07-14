// The controls registry: the single source of truth for every user input — keyboard chords, pointer
// gestures, and the wheel — across the live overlay (`widget`), the studio editor (`studio`), and
// always-on (`global`) scopes. Pure domain (no React/Tauri/DOM): the hooks build a plain
// `ControlContext` from their refs/state, ask this module which `Control` an event matches, then run
// their own handler for that control's id. The contextual hint bar and the Settings panel both derive
// from the SAME registry, so they can no longer drift from real behavior. Co-located tests in
// controls.test.ts. Mirrors the register()-style registry of core/plugin.ts.

export type ControlScope = 'global' | 'studio' | 'widget';
export type ControlGroup = 'edit' | 'view' | 'selection' | 'navigation' | 'file' | 'widget';

// A normalized key chord. `key` is the lowercased KeyboardEvent.key ('s', 'z', 'arrowleft', 'escape');
// `code` is the physical-key form ('Space') preferred for layout-independent keys. A trigger sets one
// of key/code plus the modifiers it REQUIRES — an omitted modifier must be UP (modifier-exact match),
// which keeps Ctrl+Z (undo) from also firing on Ctrl+Shift+Z (redo).
export type KeyChord = {
	key?: string;
	code?: string;
	ctrl?: boolean;
	shift?: boolean;
	alt?: boolean;
	meta?: boolean;
};

export type PointerButton = 'left' | 'middle' | 'right';
export type PointerKind = 'click' | 'drag';
// Where the press landed (the hook hit-tests). 'any' is a wildcard on either side of a match.
export type PointerTarget = 'canvas' | 'widget' | 'any';

export type PointerGesture = {
	button: PointerButton;
	kind: PointerKind;
	target: PointerTarget;
	ctrl?: boolean;
	shift?: boolean;
	alt?: boolean;
	meta?: boolean;
	// Space-as-a-modifier (the studio's Figma-style Space+drag pan); the hook supplies it from its ref.
	spaceHeld?: boolean;
};

export type WheelChord = { ctrl?: boolean; shift?: boolean; alt?: boolean };

// A trigger is one of the three input kinds, discriminated by `type`. Triggers are the ONLY part of a
// control that is user-remappable + persisted (see ControlOverride / controls.json).
export type Trigger =
	| ({ type: 'key' } & KeyChord)
	| ({ type: 'pointer' } & PointerGesture)
	| ({ type: 'wheel' } & WheelChord);

// Everything a `when`/hint predicate needs, as PLAIN DATA the hook assembles each event. No functions,
// no DOM, no per-widget state (the movable/in-flow checks stay in WidgetHost, not here).
export type ControlContext = {
	scope: ControlScope;
	studio: boolean;
	editMode: boolean;
	menuOpen: boolean;
	dirty: boolean;
	hasSelection: boolean;
	spaceDown: boolean;
	panning: boolean;
	previewing: boolean;
	pointerTarget?: PointerTarget;
	// Optional context, supplied by the studio for hint gating/labels (absent elsewhere → treated as
	// false/0): whether Undo has anything to undo, and how many nodes are selected.
	canUndo?: boolean;
	selectionCount?: number;
};

export type Control = {
	id: string; // stable, namespaced for plugins ('studio.save', 'plugin:home-assistant.foo')
	scope: ControlScope;
	group: ControlGroup;
	label: string; // action text for the hint bar / settings ('Save draft', 'Pan view')
	triggers: Trigger[]; // effective triggers (defaults in code; replaced by an override at merge time)
	when?: (ctx: ControlContext) => boolean; // enablement: matched only when this passes
	repeatable?: boolean; // allow OS key-repeat (nudge yes; save/undo no — default false)
	preventDefault?: boolean; // hook calls event.preventDefault on match (default true)
	// Still fires while a text field (INPUT/TEXTAREA/SELECT) is focused. Command chords like Ctrl+S /
	// Ctrl+E / Escape set this; editing keys (undo, delete, arrows, Space) leave it false so they don't
	// hijack text editing. Key controls only; ignored for pointer/wheel.
	allowInInput?: boolean;
	// --- hint-bar derivation (a control is advertised in the powerbar IFF hintOrder is set) ---
	hintOrder?: number; // sort key + inclusion flag for the bar
	hintWhen?: (ctx: ControlContext) => boolean; // extra visibility gate (defaults to `when`)
	hint?: (ctx: ControlContext, triggers: Trigger[]) => string; // custom key text (default: format triggers[0])
	hintLabel?: (ctx: ControlContext) => string; // ctx-aware action text for the bar (default: `label`)
};

// Persisted user remap (controls.json holds ONLY these — defaults live in code, so adding/renaming a
// built-in never corrupts the file and unknown ids are simply ignored on merge).
export type ControlOverride = { triggers?: Trigger[]; disabled?: boolean };
export type ControlOverrides = Record<string, ControlOverride>;

export type ControlConflict = { a: string; b: string; trigger: Trigger };

// ---- registry (module-level, mirrors core/plugin.ts) ----
const registry = new Map<string, Control>();

/** Register (or replace by id) a control. Built-ins register at import; plugins via registerPlugin. */
export function registerControl(control: Control): void {
	registry.set(control.id, control);
}
export function listControls(): Control[] {
	return Array.from(registry.values());
}
export function getControl(id: string): Control | undefined {
	return registry.get(id);
}
/** Reset the registry — for tests only (vitest cases register synthetic controls). */
export function clearControls(): void {
	registry.clear();
}

// ---- pure matching helpers ----

// Modifier-exact: an undefined requirement means "must be up". `!!` collapses undefined→false.
function modMatch(required: boolean | undefined, actual: boolean | undefined): boolean {
	return !!required === !!actual;
}

/** Normalize a raw KeyboardEvent-shaped object into a chord (DOM-free so it is trivially testable). */
export function parseKeyEvent(e: {
	key: string;
	code: string;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	metaKey: boolean;
}): KeyChord {
	return {
		key: e.key.toLowerCase(),
		code: e.code,
		ctrl: e.ctrlKey,
		shift: e.shiftKey,
		alt: e.altKey,
		meta: e.metaKey
	};
}

/** Does a key trigger match a live chord? Modifier-exact; `code` (e.g. 'Space') wins over `key`. */
export function chordMatches(trigger: KeyChord, chord: KeyChord): boolean {
	if (!modMatch(trigger.ctrl, chord.ctrl)) return false;
	if (!modMatch(trigger.shift, chord.shift)) return false;
	if (!modMatch(trigger.alt, chord.alt)) return false;
	if (!modMatch(trigger.meta, chord.meta)) return false;
	if (trigger.code) return trigger.code === chord.code;
	if (trigger.key) return trigger.key === chord.key;
	return false;
}

function pointerMatches(trigger: PointerGesture, gesture: PointerGesture): boolean {
	if (trigger.button !== gesture.button) return false;
	if (trigger.kind !== gesture.kind) return false;
	if (trigger.target !== 'any' && gesture.target !== 'any' && trigger.target !== gesture.target)
		return false;
	if (!modMatch(trigger.ctrl, gesture.ctrl)) return false;
	if (!modMatch(trigger.shift, gesture.shift)) return false;
	if (!modMatch(trigger.alt, gesture.alt)) return false;
	if (!modMatch(trigger.meta, gesture.meta)) return false;
	if (!modMatch(trigger.spaceHeld, gesture.spaceHeld)) return false;
	return true;
}

function enabled(c: Control, ctx: ControlContext): boolean {
	return c.when ? c.when(ctx) : true;
}

/** First enabled control whose key trigger matches `chord` (registration order = priority). */
export function matchKeyChord(
	chord: KeyChord,
	controls: Control[],
	ctx: ControlContext
): Control | null {
	for (const c of controls) {
		if (!enabled(c, ctx)) continue;
		for (const t of c.triggers) {
			if (t.type === 'key' && chordMatches(t, chord)) return c;
		}
	}
	return null;
}

/** First enabled control whose pointer trigger matches `gesture`. */
export function matchPointer(
	gesture: PointerGesture,
	controls: Control[],
	ctx: ControlContext
): Control | null {
	for (const c of controls) {
		if (!enabled(c, ctx)) continue;
		for (const t of c.triggers) {
			if (t.type === 'pointer' && pointerMatches(t, gesture)) return c;
		}
	}
	return null;
}

/** First enabled control whose wheel trigger matches the wheel modifiers. */
export function matchWheel(
	wheel: { ctrl: boolean; shift: boolean; alt: boolean },
	controls: Control[],
	ctx: ControlContext
): Control | null {
	for (const c of controls) {
		if (!enabled(c, ctx)) continue;
		for (const t of c.triggers) {
			if (
				t.type === 'wheel' &&
				modMatch(t.ctrl, wheel.ctrl) &&
				modMatch(t.shift, wheel.shift) &&
				modMatch(t.alt, wheel.alt)
			)
				return c;
		}
	}
	return null;
}

// ---- overrides ----

/** Apply persisted overrides over the defaults → effective controls. A disabled control is DROPPED
 * (so matchers and hints never see it); an override's `triggers` fully REPLACE the defaults; an
 * override for an unknown id has nowhere to land and is harmlessly ignored. */
export function mergeOverrides(defaults: Control[], overrides: ControlOverrides): Control[] {
	const out: Control[] = [];
	for (const c of defaults) {
		const o = overrides[c.id];
		if (!o) {
			out.push(c);
			continue;
		}
		if (o.disabled) continue;
		out.push(o.triggers ? { ...c, triggers: o.triggers } : c);
	}
	return out;
}

/** Validate a parsed controls.json object into ControlOverrides, dropping anything malformed (so a
 * hand-edited or stale file degrades to defaults rather than throwing). */
export function parseControlOverrides(obj: unknown): ControlOverrides {
	const out: ControlOverrides = {};
	if (!obj || typeof obj !== 'object') return out;
	const root = obj as { overrides?: unknown };
	const raw = root.overrides;
	if (!raw || typeof raw !== 'object') return out;
	for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
		if (!val || typeof val !== 'object') continue;
		const v = val as { triggers?: unknown; disabled?: unknown };
		const override: ControlOverride = {};
		if (v.disabled === true) override.disabled = true;
		if (Array.isArray(v.triggers) && v.triggers.every(isTrigger)) override.triggers = v.triggers;
		if (override.disabled || override.triggers) out[id] = override;
	}
	return out;
}

function isTrigger(t: unknown): t is Trigger {
	if (!t || typeof t !== 'object') return false;
	const type = (t as { type?: unknown }).type;
	return type === 'key' || type === 'pointer' || type === 'wheel';
}

// ---- hint derivation + formatting ----

const ARROW_LABEL: Record<string, string> = {
	arrowleft: '←',
	arrowright: '→',
	arrowup: '↑',
	arrowdown: '↓'
};
const KEY_LABEL: Record<string, string> = {
	escape: 'Esc',
	delete: 'Del',
	backspace: 'Backspace',
	enter: 'Enter',
	tab: 'Tab',
	' ': 'Space'
};

function keyLabel(t: KeyChord): string {
	if (t.code === 'Space') return 'Space';
	const k = t.key ?? '';
	return (
		ARROW_LABEL[k] ??
		KEY_LABEL[k] ??
		(k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1))
	);
}

function withMods(mods: string[], core: string): string {
	return mods.length ? `${mods.join('+')}+${core}` : core;
}

/** Render a trigger as a hint/settings string: 'Ctrl+S', 'Middle-drag', 'Space+Drag', 'Right-click',
 * 'Shift+Drag', 'Scroll', 'Esc', 'Del', '←'. */
export function formatTrigger(trigger: Trigger): string {
	if (trigger.type === 'key') {
		const mods: string[] = [];
		if (trigger.ctrl) mods.push('Ctrl');
		if (trigger.shift) mods.push('Shift');
		if (trigger.alt) mods.push('Alt');
		if (trigger.meta) mods.push('Cmd');
		return withMods(mods, keyLabel(trigger));
	}
	if (trigger.type === 'wheel') {
		const mods: string[] = [];
		if (trigger.ctrl) mods.push('Ctrl');
		if (trigger.shift) mods.push('Shift');
		if (trigger.alt) mods.push('Alt');
		return withMods(mods, 'Scroll');
	}
	// pointer
	const mods: string[] = [];
	if (trigger.ctrl) mods.push('Ctrl');
	if (trigger.shift) mods.push('Shift');
	if (trigger.alt) mods.push('Alt');
	if (trigger.meta) mods.push('Cmd');
	if (trigger.spaceHeld) mods.push('Space');
	if (trigger.button === 'middle' || trigger.button === 'right') {
		const btn = trigger.button === 'middle' ? 'Middle' : 'Right';
		return withMods(mods, `${btn}-${trigger.kind}`); // 'Middle-drag', 'Right-click'
	}
	return withMods(mods, trigger.kind === 'drag' ? 'Drag' : 'Click');
}

/** Derive the studio powerbar hints from the effective controls + context. Only controls with a
 * `hintOrder` are advertised (others are real controls but not bar-worthy); they are scope-filtered,
 * gated by `hintWhen ?? when`, and sorted by hintOrder. While a pan is in progress the bar is taken
 * over by a fixed in-gesture hint (a transient modal state, deliberately not registry-derived). */
export function deriveHints(
	controls: Control[],
	ctx: ControlContext
): { key: string; label: string }[] {
	if (ctx.panning) {
		return [
			{ key: 'Drag', label: 'panning view' },
			{ key: 'Release', label: 'done' }
		];
	}
	const advertised = controls.filter((c) => {
		if (c.hintOrder === undefined) return false;
		if (c.scope !== ctx.scope && c.scope !== 'global') return false;
		const pred = c.hintWhen ?? c.when;
		return pred ? pred(ctx) : true;
	});
	advertised.sort((a, b) => (a.hintOrder as number) - (b.hintOrder as number));
	return advertised.map((c) => ({
		key: c.hint ? c.hint(ctx, c.triggers) : formatTrigger(c.triggers[0]),
		label: c.hintLabel ? c.hintLabel(ctx) : c.label
	}));
}

// ---- conflict detection (for the Settings panel; a unit test guards the built-ins have none) ----

function triggersCollide(a: Trigger, b: Trigger): boolean {
	if (a.type !== b.type) return false;
	if (a.type === 'key' && b.type === 'key') {
		const sameKey = a.code || b.code ? a.code === b.code : a.key === b.key;
		return (
			sameKey &&
			modMatch(a.ctrl, b.ctrl) &&
			modMatch(a.shift, b.shift) &&
			modMatch(a.alt, b.alt) &&
			modMatch(a.meta, b.meta)
		);
	}
	if (a.type === 'pointer' && b.type === 'pointer') {
		const sameTarget = a.target === 'any' || b.target === 'any' || a.target === b.target;
		return (
			a.button === b.button &&
			a.kind === b.kind &&
			sameTarget &&
			modMatch(a.ctrl, b.ctrl) &&
			modMatch(a.shift, b.shift) &&
			modMatch(a.alt, b.alt) &&
			modMatch(a.meta, b.meta) &&
			modMatch(a.spaceHeld, b.spaceHeld)
		);
	}
	/* v8 ignore else -- equal discriminants that reach here can only both be wheel. */
	if (a.type === 'wheel' && b.type === 'wheel') {
		return modMatch(a.ctrl, b.ctrl) && modMatch(a.shift, b.shift) && modMatch(a.alt, b.alt);
	}
	/* v8 ignore next -- equal Trigger discriminants exhaust key, pointer, and wheel above. */
	return false;
}

/** Pairs of same-scope controls whose triggers overlap (could both fire for one input). The matchers
 * are first-match, so a conflict means the later control is shadowed — the Settings panel surfaces it. */
export function detectConflicts(controls: Control[]): ControlConflict[] {
	const conflicts: ControlConflict[] = [];
	for (let i = 0; i < controls.length; i++) {
		for (let j = i + 1; j < controls.length; j++) {
			const a = controls[i];
			const b = controls[j];
			if (a.scope !== b.scope) continue;
			for (const ta of a.triggers) {
				for (const tb of b.triggers) {
					if (triggersCollide(ta, tb)) conflicts.push({ a: a.id, b: b.id, trigger: ta });
				}
			}
		}
	}
	return conflicts;
}
