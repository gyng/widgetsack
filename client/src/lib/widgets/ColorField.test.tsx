import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ColorField from './ColorField';

describe('ColorField', () => {
	it('shows the value in the text field and mirrors it in the swatch', () => {
		render(<ColorField value="rgb(119, 196, 211)" ariaLabel="accent" onChange={vi.fn()} />);
		const text = screen.getByLabelText('accent') as HTMLInputElement;
		const swatch = screen.getByLabelText('accent swatch') as HTMLInputElement;
		expect(text.value).toBe('rgb(119, 196, 211)');
		expect(swatch.value).toBe('#77c4d3');
	});

	it('falls back to the placeholder colour in the swatch when empty', () => {
		render(<ColorField value="" placeholder="#3fb950" ariaLabel="success" onChange={vi.fn()} />);
		expect((screen.getByLabelText('success swatch') as HTMLInputElement).value).toBe('#3fb950');
	});

	it('commits the typed value on blur, not per keystroke', () => {
		const onChange = vi.fn();
		render(<ColorField value="" ariaLabel="accent" onChange={onChange} />);
		const text = screen.getByLabelText('accent');
		fireEvent.change(text, { target: { value: 'gold' } });
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.blur(text);
		expect(onChange).toHaveBeenCalledWith('gold');
	});

	it('commits immediately when the swatch changes', () => {
		const onChange = vi.fn();
		render(<ColorField value="" ariaLabel="accent" onChange={onChange} />);
		fireEvent.change(screen.getByLabelText('accent swatch'), { target: { value: '#112233' } });
		expect(onChange).toHaveBeenCalledWith('#112233');
	});

	it('clears the override', () => {
		const onChange = vi.fn();
		render(<ColorField value="gold" ariaLabel="accent" onChange={onChange} />);
		fireEvent.click(screen.getByLabelText('clear'));
		expect(onChange).toHaveBeenCalledWith('');
	});

	it('does not re-commit an unchanged value on blur', () => {
		const onChange = vi.fn();
		render(<ColorField value="gold" ariaLabel="accent" onChange={onChange} />);
		fireEvent.blur(screen.getByLabelText('accent'));
		expect(onChange).not.toHaveBeenCalled(); // no redundant undo/save entry
	});

	it('falls back to a generic swatch label when no ariaLabel is given', () => {
		render(<ColorField value="#112233" onChange={vi.fn()} />);
		// Without an ariaLabel prop the swatch names itself "colour swatch" (default a11y label).
		expect(screen.getByLabelText('colour swatch')).toBeInTheDocument();
	});

	it('resyncs the text field when the external value prop changes (store-previous idiom)', () => {
		const onChange = vi.fn();
		const { rerender } = render(<ColorField value="red" ariaLabel="accent" onChange={onChange} />);
		const text = screen.getByLabelText('accent') as HTMLInputElement;
		// A local (uncommitted) edit lives only in `text` until blur.
		fireEvent.change(text, { target: { value: 'gr' } });
		expect(text.value).toBe('gr');
		// An external change (Clear / theme switch / selecting another widget) overwrites the local text.
		rerender(<ColorField value="blue" ariaLabel="accent" onChange={onChange} />);
		expect((screen.getByLabelText('accent') as HTMLInputElement).value).toBe('blue');
		// The resync must not have committed the in-progress local edit.
		expect(onChange).not.toHaveBeenCalled();
	});
});
