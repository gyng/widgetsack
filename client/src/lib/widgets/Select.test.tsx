import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import Select from './Select';
import type { SelectOption } from './selectOptions';

const SMALL: SelectOption[] = [
	{ value: 'a', label: 'Apple' },
	{ value: 'b', label: 'Banana' },
	{ value: 'c', label: 'Cherry' }
];

const SENSORS: SelectOption[] = Array.from({ length: 12 }, (_, i) => ({
	value: `s.${i}`,
	label: `Sensor ${i}`,
	hint: `s.${i}`
}));

describe('Select (listbox variant: small closed set)', () => {
	// Downshift's useSelect trigger carries role="combobox" (ARIA 1.2) but is a <button>, not an <input>.
	it('shows the selected option label and the placeholder when empty', () => {
		const { rerender } = render(
			<Select value="" options={SMALL} onChange={vi.fn()} placeholder="(pick)" />
		);
		expect(screen.getByRole('combobox')).toHaveTextContent('(pick)');
		rerender(<Select value="b" options={SMALL} onChange={vi.fn()} placeholder="(pick)" />);
		expect(screen.getByRole('combobox')).toHaveTextContent('Banana');
	});

	it('opens on click and selecting an option calls onChange with its value', () => {
		const onChange = vi.fn();
		render(<Select value="a" options={SMALL} onChange={onChange} />);
		fireEvent.click(screen.getByRole('combobox'));
		fireEvent.click(screen.getByText('Cherry'));
		expect(onChange).toHaveBeenCalledWith('c');
	});

	it('is a button, not a text input, for a small set (no typeahead)', () => {
		render(<Select value="a" options={SMALL} onChange={vi.fn()} />);
		expect(screen.getByRole('combobox').tagName).toBe('BUTTON');
		expect(document.querySelector('.np-select-input')).toBeNull();
	});
});

describe('Select (combobox variant: typeahead)', () => {
	it('renders a typeahead input for a long list and filters as you type', () => {
		const onChange = vi.fn();
		render(<Select value="" options={SENSORS} onChange={onChange} searchable />);
		const input = screen.getByRole('combobox');
		fireEvent.change(input, { target: { value: 'Sensor 7' } });
		fireEvent.click(screen.getByText('Sensor 7'));
		expect(onChange).toHaveBeenCalledWith('s.7');
	});

	it('opens the menu on a plain click of the input (not just the ▾ caret)', () => {
		const onChange = vi.fn();
		render(<Select value="" options={SENSORS} onChange={onChange} searchable />);
		fireEvent.click(screen.getByRole('combobox')); // click the field itself
		fireEvent.click(screen.getByText('Sensor 5')); // the list is open → pick from it
		expect(onChange).toHaveBeenCalledWith('s.5');
	});

	it('accepts a typed custom value when allowCustom (commits live, like the sensor field)', () => {
		const onChange = vi.fn();
		render(<Select value="" options={SENSORS} onChange={onChange} allowCustom />);
		const input = screen.getByRole('combobox');
		fireEvent.change(input, { target: { value: 'my.custom.sensor' } });
		expect(onChange).toHaveBeenLastCalledWith('my.custom.sensor');
	});

	it('shows the option hint (e.g. the raw sensor id) alongside the label', () => {
		render(<Select value="" options={SENSORS} onChange={vi.fn()} allowCustom />);
		fireEvent.click(screen.getByLabelText('Toggle options'));
		// an option row renders both its label and its dim hint (the raw id)
		expect(screen.getByText('Sensor 3')).toBeInTheDocument();
		expect(screen.getByText('s.3', { selector: '.np-select-opt-hint' })).toBeInTheDocument();
	});
});
