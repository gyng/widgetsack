// Pure mapping from the layout grammar's cross/main alignment (`align` / `justify`) to the
// intuitive Horizontal / Vertical controls the Inspector shows — so the editor speaks in screen
// directions (left / center / right, top / middle / bottom) instead of flexbox axes.
//
// For a ROW the main axis is horizontal, so Horizontal ← justify (incl. space-between/around)
// and Vertical ← align. For a COL it's flipped. A GRID aligns its cells diagonally via the
// single `align`, so it gets one "Cell alignment" control. No React/Tauri — unit-tested.

import type { Align, AlignH, AlignV, Container, Justify } from '../../core/layoutTree';

export type ScreenAxis = 'horizontal' | 'vertical' | 'cell';
export type AlignField = 'align' | 'justify';
export type AlignOption = { value: string; label: string };

export type AlignControl = {
	axis: ScreenAxis;
	label: string; // 'Horizontal' | 'Vertical' | 'Cell alignment'
	field: AlignField; // which container field this select writes
	value: string; // current model value (Align | Justify), defaulted
	options: AlignOption[];
};

const ALIGN_VALUES: Align[] = ['start', 'center', 'end', 'stretch']; // cross axis
const JUSTIFY_VALUES: Justify[] = ['start', 'center', 'end', 'between', 'around']; // main axis

// Screen-direction labels for each model value, per axis.
const H_LABELS: Record<string, string> = {
	start: 'left',
	center: 'center',
	end: 'right',
	stretch: 'fill',
	between: 'space-between',
	around: 'space-around'
};
const V_LABELS: Record<string, string> = {
	start: 'top',
	center: 'middle',
	end: 'bottom',
	stretch: 'fill',
	between: 'space-between',
	around: 'space-around'
};
// A grid aligns cell content diagonally (one value for both axes via the solver's alignInCell).
const GRID_LABELS: Record<Align, string> = {
	stretch: 'fill cells',
	start: 'top-left',
	center: 'center',
	end: 'bottom-right'
};

function optionsFor(axis: 'horizontal' | 'vertical', field: AlignField): AlignOption[] {
	const labels = axis === 'horizontal' ? H_LABELS : V_LABELS;
	const values = field === 'align' ? ALIGN_VALUES : JUSTIFY_VALUES;
	return values.map((v) => ({ value: v, label: labels[v] }));
}

/**
 * The Horizontal + Vertical alignment controls for a container (or a single Cell-alignment
 * control for a grid). Each control knows which model field it writes (`align` or `justify`),
 * its current (defaulted) value, and its screen-labelled options. Pure.
 */
export function containerAlignControls(c: Container): AlignControl[] {
	if (c.kind === 'grid') {
		return [
			{
				axis: 'cell',
				label: 'Cell alignment',
				field: 'align',
				value: c.align ?? 'stretch',
				options: ALIGN_VALUES.map((v) => ({ value: v, label: GRID_LABELS[v] }))
			}
		];
	}
	const mainHorizontal = c.kind === 'row';
	const horizontal: AlignControl = mainHorizontal
		? {
				axis: 'horizontal',
				label: 'Horizontal',
				field: 'justify',
				value: c.justify ?? 'start',
				options: optionsFor('horizontal', 'justify')
			}
		: {
				axis: 'horizontal',
				label: 'Horizontal',
				field: 'align',
				value: c.align ?? 'stretch',
				options: optionsFor('horizontal', 'align')
			};
	const vertical: AlignControl = mainHorizontal
		? {
				axis: 'vertical',
				label: 'Vertical',
				field: 'align',
				value: c.align ?? 'stretch',
				options: optionsFor('vertical', 'align')
			}
		: {
				axis: 'vertical',
				label: 'Vertical',
				field: 'justify',
				value: c.justify ?? 'start',
				options: optionsFor('vertical', 'justify')
			};
	return [horizontal, vertical];
}

// The per-widget alignment option lists (Leaf.halign / Leaf.valign). 'fill' = span the box (default).
export const LEAF_H_OPTIONS: { value: AlignH; label: string }[] = [
	{ value: 'fill', label: 'fill' },
	{ value: 'left', label: 'left' },
	{ value: 'center', label: 'center' },
	{ value: 'right', label: 'right' }
];
export const LEAF_V_OPTIONS: { value: AlignV; label: string }[] = [
	{ value: 'fill', label: 'fill' },
	{ value: 'top', label: 'top' },
	{ value: 'middle', label: 'middle' },
	{ value: 'bottom', label: 'bottom' }
];
