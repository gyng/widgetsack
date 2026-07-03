// Global keyboard, now DISPATCHED THROUGH the central controls registry: each keydown is normalized
// to a chord, matched (with live overrides) against the registered controls under the current
// ControlContext, and the matched control's id is run via the Canvas-supplied handler map. Two
// controls are serviced locally because they need hook-internal data: `studio.panHold` owns the
// `spaceDown` ref/state shared with the canvas-pointer hook (Space+left-drag pan), and `studio.nudge`
// derives its delta from the arrow key + Shift (grid step). The text-field focus guard and the
// "don't steal Space from a button" guard are DOM concerns and stay here. Importing controls.defaults
// registers the built-in inventory.
import { useEffect, useRef, useState } from 'react';
import '../../core/controls.defaults';
import {
	listControls,
	matchKeyChord,
	mergeOverrides,
	parseKeyEvent,
	type ControlContext,
	type ControlOverrides
} from '../../core/controls';

const GRID = 8;
const NUDGE: Record<string, [number, number]> = {
	arrowleft: [-1, 0],
	arrowright: [1, 0],
	arrowup: [0, -1],
	arrowdown: [0, 1]
};

// The slice of ControlContext the Canvas supplies; the hook fills scope + spaceDown (its own ref) +
// panning (irrelevant to keyboard matching).
export type KeyboardCtx = Pick<
	ControlContext,
	'studio' | 'editMode' | 'menuOpen' | 'dirty' | 'hasSelection' | 'previewing'
>;

export type KeyboardDeps = {
	studio: boolean;
	ctx: () => KeyboardCtx; // read latest
	overrides: () => ControlOverrides; // live remaps (empty until Phase 4)
	handlers: Record<string, () => void>; // control id → action (closeMenu, toggleEdit, save, undo, redo, delete)
	nudge: (dx: number, dy: number) => void; // serviced locally: needs the arrow key + Shift step
	gotoSection?: (index: number) => void; // serviced locally: needs the pressed digit (Ctrl+1..8)
};

export function useKeyboard(deps: KeyboardDeps): {
	spaceDownRef: React.RefObject<boolean>;
	spaceDown: boolean;
} {
	// `spaceDown` is BOTH a ref (read synchronously by the pointer hook for a Space+left-drag pan) AND
	// render state (drives the `panmode` class on the canvas).
	const spaceDownRef = useRef(false);
	const [spaceDown, setSpaceDown] = useState(false);
	const setSpace = (v: boolean) => {
		spaceDownRef.current = v;
		setSpaceDown(v);
	};
	// Hold deps in a ref so the window listeners stay stable (registered once) but read latest.
	// Mirrored in a commit effect (before the mount effect below only reads d.current from listeners).
	const d = useRef(deps);
	useEffect(() => {
		d.current = deps;
	});

	useEffect(() => {
		const onKeydown = (event: KeyboardEvent) => {
			const dep = d.current;
			const chord = parseKeyEvent(event);
			const ctx: ControlContext = {
				scope: dep.studio ? 'studio' : 'widget',
				spaceDown: spaceDownRef.current,
				panning: false,
				...dep.ctx()
			};
			const controls = mergeOverrides(listControls(), dep.overrides());
			const hit = matchKeyChord(chord, controls, ctx);
			if (!hit) return;

			// Text-field guard: editing keys must not hijack typing; command chords opt in via allowInInput.
			const target = event.target as HTMLElement | null;
			if (!hit.allowInInput && target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

			// Space pan-mode (hold): owns spaceDown; never steal Space from a focused button.
			if (hit.id === 'studio.panHold') {
				if (target?.tagName === 'BUTTON') return;
				event.preventDefault();
				setSpace(true);
				return;
			}

			if (hit.preventDefault !== false) event.preventDefault();

			// Nudge derives its delta from the pressed arrow + Shift (grid step), so it can't be a plain
			// id→handler entry. One undo step + persist is the Canvas-supplied `nudge`.
			if (hit.id === 'studio.nudge') {
				const delta = NUDGE[chord.key ?? ''];
				if (delta) {
					const step = event.shiftKey ? GRID : 1;
					dep.nudge(delta[0] * step, delta[1] * step);
				}
				return;
			}

			// Section jump (Ctrl+1..8) derives the index from the digit (like nudge), so it's serviced
			// locally rather than as a fixed id→handler entry.
			if (hit.id === 'studio.section') {
				const n = Number(chord.key);
				if (Number.isInteger(n) && n >= 1 && n <= 8) dep.gotoSection?.(n - 1);
				return;
			}

			dep.handlers[hit.id]?.();
		};
		const onKeyup = (event: KeyboardEvent) => {
			if (event.code === 'Space') setSpace(false);
		};
		window.addEventListener('keydown', onKeydown);
		window.addEventListener('keyup', onKeyup);
		return () => {
			window.removeEventListener('keydown', onKeydown);
			window.removeEventListener('keyup', onKeyup);
		};
	}, []);

	return { spaceDownRef, spaceDown };
}
