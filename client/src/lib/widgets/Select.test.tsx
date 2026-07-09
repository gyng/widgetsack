import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('Select (listbox: controlled value changes, keyboard, positioning, swatches)', () => {
	afterEach(() => vi.restoreAllMocks());

	it('reflects an external value change and empties the trigger when nothing matches', () => {
		const { rerender } = render(<Select value="a" options={SMALL} onChange={vi.fn()} />);
		const value = () => screen.getByRole('combobox').querySelector('.np-select-value')?.textContent;
		expect(value()).toBe('Apple');
		rerender(<Select value="b" options={SMALL} onChange={vi.fn()} />);
		expect(value()).toBe('Banana');
		// a stale/unknown stored value matches no option; with no placeholder the trigger is empty
		rerender(<Select value="zzz" options={SMALL} onChange={vi.fn()} />);
		expect(value()).toBe('');
	});

	it('typeahead: pressing a character key highlights the matching option', () => {
		render(<Select value="" options={SMALL} onChange={vi.fn()} />);
		const trigger = screen.getByRole('combobox');
		fireEvent.click(trigger); // open
		fireEvent.keyDown(trigger, { key: 'c' });
		const cherry = screen.getByText('Cherry').closest('li') as HTMLElement;
		expect(cherry.getAttribute('data-highlighted')).toBe('true');
	});

	it('flips the menu above the trigger when there is little room below', () => {
		// Anchor the trigger near the bottom of the viewport: below < 200 and top > below → flip up.
		const h = window.innerHeight;
		vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
			x: 8,
			y: h - 68,
			top: h - 68,
			left: 8,
			right: 208,
			bottom: h - 44,
			width: 200,
			height: 24,
			toJSON: () => ({})
		} as DOMRect);
		render(<Select value="a" options={SMALL} onChange={vi.fn()} />);
		fireEvent.click(screen.getByRole('combobox'));
		const menu = document.querySelector('.np-select-menu') as HTMLElement;
		expect(menu.style.bottom).toBe('70px'); // innerHeight - top + 2
		expect(menu.style.top).toBe('');
	});

	it('renders swatches in the trigger and swatch + hint in the open menu rows', () => {
		const themed: SelectOption[] = [
			{
				value: 'day',
				label: 'Day',
				hint: 'light',
				swatch: { bg: '#fff', accent: '#09f', fg: '#111' }
			},
			{ value: 'night', label: 'Night', swatch: { bg: '#000', accent: '#f90', fg: '#eee' } },
			{ value: 'mono', label: 'Mono' }
		];
		render(<Select value="day" options={themed} onChange={vi.fn()} />);
		const trigger = screen.getByRole('combobox');
		expect(trigger.querySelector('.np-swatch')).not.toBeNull();
		fireEvent.click(trigger);
		const rows = document.querySelectorAll('.np-select-menu .np-select-option');
		expect(rows[0].querySelector('.np-swatch')).not.toBeNull();
		expect(rows[0].querySelector('.np-select-opt-hint')?.textContent).toBe('light');
		expect(rows[2].querySelector('.np-swatch')).toBeNull(); // no swatch on Mono
	});
});

describe('Select (combobox: external value + selection behaviours)', () => {
	it('re-syncs the input when the value changes from outside, clearing it for an unknown value', () => {
		const { rerender } = render(
			<Select value="s.1" options={SENSORS} onChange={vi.fn()} searchable />
		);
		const input = screen.getByRole('combobox') as HTMLInputElement;
		expect(input.value).toBe('Sensor 1');
		rerender(<Select value="s.2" options={SENSORS} onChange={vi.fn()} searchable />);
		expect(input.value).toBe('Sensor 2');
		rerender(<Select value="nope" options={SENSORS} onChange={vi.fn()} searchable />);
		expect(input.value).toBe('');
	});

	it('Escape with the menu closed clears the filter text without committing a value', () => {
		const onChange = vi.fn();
		render(<Select value="s.1" options={SENSORS} onChange={onChange} searchable />);
		const input = screen.getByRole('combobox') as HTMLInputElement;
		fireEvent.keyDown(input, { key: 'Escape' });
		expect(input.value).toBe('');
		expect(onChange).not.toHaveBeenCalled();
	});

	it('selecting a listed option in free-text mode commits and shows its raw id', () => {
		const onChange = vi.fn();
		render(<Select value="" options={SENSORS} onChange={onChange} allowCustom />);
		const input = screen.getByRole('combobox') as HTMLInputElement;
		fireEvent.click(input); // open
		fireEvent.click(screen.getByText('Sensor 4'));
		expect(onChange).toHaveBeenCalledWith('s.4');
		expect(input.value).toBe('s.4');
	});

	it('shows the full list when the free-text value exactly matches an option id', () => {
		render(<Select value="s.3" options={SENSORS} onChange={vi.fn()} allowCustom />);
		fireEvent.click(screen.getByRole('combobox'));
		expect(document.querySelectorAll('.np-select-option').length).toBe(SENSORS.length);
	});

	it('shows the selected option swatch in the trigger and per-row swatches in the menu', () => {
		const themed: SelectOption[] = [
			{ value: 't1', label: 'Theme One', swatch: { bg: '#123', accent: '#456', fg: '#789' } },
			{ value: 't2', label: 'Theme Two', swatch: { bg: '#abc', accent: '#def', fg: '#012' } }
		];
		render(<Select value="t1" options={themed} onChange={vi.fn()} searchable />);
		expect(document.querySelector('.np-select-trigger .np-swatch')).not.toBeNull();
		fireEvent.click(screen.getByLabelText('Toggle options'));
		const rows = document.querySelectorAll('.np-select-menu .np-select-option');
		expect(rows.length).toBe(2);
		expect(rows[0].querySelector('.np-swatch')).not.toBeNull();
		// these options carry no hint — the hint span is simply absent
		expect(rows[0].querySelector('.np-select-opt-hint')).toBeNull();
	});
});
