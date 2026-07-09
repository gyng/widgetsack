import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import MultiInspector from './MultiInspector';
import type { MergedField } from './canvas/multiSelect';
import type { ConfigField } from '../core/widget';

// Presentational pane: the merged fields/basis are computed upstream (canvas/multiSelect.ts) and the
// bulk apply lives in the Canvas. So the test feeds MergedField[] + a BasisSummary directly and
// asserts what each control RENDERS and what editing it EMITS via the callbacks.

const field = (f: ConfigField, value: unknown, mixed = false): MergedField => ({
	field: f,
	value,
	mixed
});

const textField: ConfigField = { key: 'label', label: 'Label', kind: 'text' };
const numField: ConfigField = { key: 'size', label: 'Size', kind: 'number' };
const toggleField: ConfigField = { key: 'bold', label: 'Bold', kind: 'toggle' };
const selectField: ConfigField = {
	key: 'align',
	label: 'Align',
	kind: 'select',
	options: ['left', 'center', 'right']
};

const items = [
	{ id: 'w1', label: 'Gauge' },
	{ id: 'w2', label: 'Clock' }
];

const baseProps = {
	items,
	fields: [] as MergedField[],
	basis: null,
	onFocus: vi.fn(),
	onPatchConfig: vi.fn(),
	onSetBasis: vi.fn(),
	onDelete: vi.fn()
};

describe('MultiInspector header + item list', () => {
	it('shows the selection count and one button per selected item', () => {
		const { getByText } = render(<MultiInspector {...baseProps} />);
		expect(getByText('2 widgets selected')).toBeTruthy();
		expect(getByText('Gauge')).toBeTruthy();
		expect(getByText('Clock')).toBeTruthy();
	});

	it('clicking an item focuses just that one (onFocus with its id)', () => {
		const onFocus = vi.fn();
		const { getByText } = render(<MultiInspector {...baseProps} onFocus={onFocus} />);
		fireEvent.click(getByText('Clock'));
		expect(onFocus).toHaveBeenCalledWith('w2');
	});

	it('the delete button reports the count and fires onDelete', () => {
		const onDelete = vi.fn();
		const { getByText } = render(<MultiInspector {...baseProps} onDelete={onDelete} />);
		const del = getByText(/Delete 2/);
		fireEvent.click(del);
		expect(onDelete).toHaveBeenCalledTimes(1);
	});
});

describe('MultiInspector common-properties empty state', () => {
	it('shows the no-shared-properties note when there are no fields', () => {
		const { getByText } = render(<MultiInspector {...baseProps} fields={[]} />);
		expect(getByText(/No shared editable properties/)).toBeTruthy();
	});

	it('shows the "Common properties" heading when fields exist', () => {
		const { getByText } = render(
			<MultiInspector {...baseProps} fields={[field(textField, 'Hi')]} />
		);
		expect(getByText('Common properties')).toBeTruthy();
	});
});

describe('MultiInspector text / number fields', () => {
	it('renders a shared text value and emits the raw string on edit', () => {
		const onPatchConfig = vi.fn();
		const { getByLabelText } = render(
			<MultiInspector
				{...baseProps}
				fields={[field(textField, 'Hi')]}
				onPatchConfig={onPatchConfig}
			/>
		);
		const input = getByLabelText('Label') as HTMLInputElement;
		expect(input.value).toBe('Hi');
		fireEvent.input(input, { target: { value: 'Bye' } });
		expect(onPatchConfig).toHaveBeenCalledWith('label', 'Bye');
	});

	it('renders a number field that emits a coerced number', () => {
		const onPatchConfig = vi.fn();
		const { getByLabelText } = render(
			<MultiInspector {...baseProps} fields={[field(numField, 12)]} onPatchConfig={onPatchConfig} />
		);
		const input = getByLabelText('Size') as HTMLInputElement;
		expect(input.type).toBe('number');
		expect(input.value).toBe('12');
		fireEvent.input(input, { target: { value: '20' } });
		expect(onPatchConfig).toHaveBeenCalledWith('size', 20);
	});

	it('a MIXED text field shows an empty value with a "mixed" placeholder', () => {
		const { getByLabelText } = render(
			<MultiInspector {...baseProps} fields={[field(textField, undefined, true)]} />
		);
		const input = getByLabelText('Label') as HTMLInputElement;
		expect(input.value).toBe('');
		expect(input.placeholder).toBe('mixed');
	});

	it('renders an UNSET (non-mixed) shared value as empty — never the string "undefined"', () => {
		// A field every selected widget leaves unset is shared (mixed=false) with value undefined.
		const { getByLabelText } = render(
			<MultiInspector {...baseProps} fields={[field(textField, undefined)]} />
		);
		const input = getByLabelText('Label') as HTMLInputElement;
		expect(input.value).toBe('');
		expect(input.placeholder).toBe(''); // not the mixed placeholder — the value is just unset
	});

	it('renders a shared null value as empty — never the string "null"', () => {
		const { getByLabelText } = render(
			<MultiInspector {...baseProps} fields={[field(textField, null)]} />
		);
		const input = getByLabelText('Label') as HTMLInputElement;
		expect(input.value).toBe('');
	});
});

describe('MultiInspector toggle field', () => {
	it('a shared-on toggle is checked and emits the new boolean', () => {
		const onPatchConfig = vi.fn();
		const { getByLabelText } = render(
			<MultiInspector
				{...baseProps}
				fields={[field(toggleField, true)]}
				onPatchConfig={onPatchConfig}
			/>
		);
		const box = getByLabelText('Bold') as HTMLInputElement;
		expect(box.checked).toBe(true);
		expect(box.indeterminate).toBe(false);
		fireEvent.click(box);
		expect(onPatchConfig).toHaveBeenCalledWith('bold', false);
	});

	it('a MIXED toggle renders indeterminate (neither checked nor unchecked)', () => {
		const { getByLabelText } = render(
			<MultiInspector {...baseProps} fields={[field(toggleField, undefined, true)]} />
		);
		const box = getByLabelText('Bold') as HTMLInputElement;
		expect(box.checked).toBe(false);
		expect(box.indeterminate).toBe(true);
	});
});

describe('MultiInspector select field (Downshift listbox)', () => {
	it('emits onPatchConfig with the picked option value', () => {
		const onPatchConfig = vi.fn();
		const { getByLabelText, getByText } = render(
			<MultiInspector
				{...baseProps}
				fields={[field(selectField, 'left')]}
				onPatchConfig={onPatchConfig}
			/>
		);
		// Open the listbox (the trigger carries the field's aria-label) and pick a value.
		fireEvent.click(getByLabelText('Align'));
		fireEvent.click(getByText('center'));
		expect(onPatchConfig).toHaveBeenCalledWith('align', 'center');
	});

	it('a MIXED select offers a "— mixed —" option', () => {
		const { getByLabelText, getByRole } = render(
			<MultiInspector {...baseProps} fields={[field(selectField, undefined, true)]} />
		);
		fireEvent.click(getByLabelText('Align'));
		// The trigger also shows the selected "— mixed —" label, so target the listbox OPTION specifically.
		expect(getByRole('option', { name: '— mixed —' })).toBeTruthy();
	});
});

describe('MultiInspector basis (size along the row / column)', () => {
	it('renders the basis control only when a basis summary is given', () => {
		const { queryByLabelText, rerender, getByLabelText } = render(
			<MultiInspector {...baseProps} basis={null} />
		);
		expect(queryByLabelText('size along the row / column')).toBeNull();
		rerender(<MultiInspector {...baseProps} basis="fixed" />);
		expect(getByLabelText('size along the row / column')).toBeTruthy();
	});

	it('picking a basis option fires onSetBasis with the chosen mode', () => {
		const onSetBasis = vi.fn();
		const { getByLabelText, getByText } = render(
			<MultiInspector {...baseProps} basis="fixed" onSetBasis={onSetBasis} />
		);
		fireEvent.click(getByLabelText('size along the row / column'));
		fireEvent.click(getByText('grow — stretch to fill'));
		expect(onSetBasis).toHaveBeenCalledWith('grow');
	});

	it('a MIXED basis adds a "— mixed —" option', () => {
		const { getByLabelText, getByRole } = render(<MultiInspector {...baseProps} basis="mixed" />);
		fireEvent.click(getByLabelText('size along the row / column'));
		// The trigger also shows the selected "— mixed —" label, so target the listbox OPTION specifically.
		expect(getByRole('option', { name: '— mixed —' })).toBeTruthy();
	});
});

describe('MultiInspector docked variant', () => {
	it('adds the docked class when docked', () => {
		const { container } = render(<MultiInspector {...baseProps} docked />);
		const root = container.querySelector('.inspector.multi')!;
		expect(root.className).toContain('docked');
		// Sanity: the same scoped query lands a single root node.
		expect(within(root as HTMLElement).getByText('2 widgets selected')).toBeTruthy();
	});
});
