import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TokenListField from './TokenListField';

// Stocks-style parser: split on newline/comma, upper-case, trim, drop empties.
const parse = (raw: string): string[] =>
	raw
		.split(/[\n,]/)
		.map((s) => s.trim().toUpperCase())
		.filter(Boolean);

function setup(values: string[] = []) {
	const onChange = vi.fn();
	render(
		<TokenListField
			label="Tickers"
			values={values}
			onChange={onChange}
			parse={parse}
			addLabel="Add"
		/>
	);
	const input = screen.getByLabelText('Add Tickers') as HTMLInputElement;
	return { onChange, input };
}

describe('TokenListField', () => {
	it('renders a removable chip per value', () => {
		setup(['AAPL', 'MSFT']);
		expect(screen.getByText('AAPL')).toBeTruthy();
		expect(screen.getByText('MSFT')).toBeTruthy();
		expect(screen.getByLabelText('Remove AAPL')).toBeTruthy();
	});

	it('adds a normalised token on Enter and clears the input', () => {
		const { onChange, input } = setup(['AAPL']);
		fireEvent.change(input, { target: { value: 'msft' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onChange).toHaveBeenCalledWith(['AAPL', 'MSFT']);
		expect(input.value).toBe('');
	});

	it('adds via the Add button', () => {
		const { onChange, input } = setup([]);
		fireEvent.change(input, { target: { value: 'tsla' } });
		fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		expect(onChange).toHaveBeenCalledWith(['TSLA']);
	});

	it('does not add a duplicate', () => {
		const { onChange, input } = setup(['AAPL']);
		fireEvent.change(input, { target: { value: 'aapl' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onChange).not.toHaveBeenCalled();
	});

	it('removes a token', () => {
		const { onChange } = setup(['AAPL', 'MSFT']);
		fireEvent.click(screen.getByLabelText('Remove AAPL'));
		expect(onChange).toHaveBeenCalledWith(['MSFT']);
	});

	it('fans a list paste out into multiple deduped chips', () => {
		const { onChange, input } = setup(['AAPL']);
		fireEvent.paste(input, { clipboardData: { getData: () => 'MSFT, AAPL, GOOG' } });
		expect(onChange).toHaveBeenCalledWith(['AAPL', 'MSFT', 'GOOG']);
	});

	it('disables Add when the input parses to nothing', () => {
		setup([]);
		expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true);
	});

	it('shows the empty hint when there are no values', () => {
		const onChange = vi.fn();
		render(
			<TokenListField
				label="Tickers"
				values={[]}
				onChange={onChange}
				parse={parse}
				emptyHint="No tickers yet."
			/>
		);
		expect(screen.getByText('No tickers yet.')).toBeTruthy();
	});

	it('ignores Enter on an empty/blank input (nothing to commit)', () => {
		const { onChange, input } = setup(['AAPL']);
		fireEvent.keyDown(input, { key: 'Enter' }); // empty pending → parse → [] → early return
		fireEvent.change(input, { target: { value: '  ,  ' } }); // parses to nothing either
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onChange).not.toHaveBeenCalled();
		expect(input.value).toBe('  ,  '); // not cleared — nothing was committed
	});

	it('ignores non-Enter keys (no commit while typing)', () => {
		const { onChange, input } = setup([]);
		fireEvent.change(input, { target: { value: 'msft' } });
		fireEvent.keyDown(input, { key: 'a' });
		fireEvent.keyDown(input, { key: 'Escape' });
		expect(onChange).not.toHaveBeenCalled();
		expect(input.value).toBe('msft');
	});

	it('lets a single-token paste fall through to the input (no separator → user reviews + Adds)', () => {
		const { onChange, input } = setup([]);
		fireEvent.paste(input, { clipboardData: { getData: () => 'MSFT' } });
		expect(onChange).not.toHaveBeenCalled(); // not intercepted — no chips yet
	});

	it('clears the input after a paste whose tokens are all duplicates (no onChange)', () => {
		const { onChange, input } = setup(['AAPL', 'MSFT']);
		fireEvent.change(input, { target: { value: 'pending' } });
		fireEvent.paste(input, { clipboardData: { getData: () => 'AAPL, MSFT' } });
		expect(onChange).not.toHaveBeenCalled(); // list unchanged
		expect(input.value).toBe(''); // but the pending text is still cleared post-commit
	});

	it('renders the chip list without an aria-label for a non-string label and no listLabel', () => {
		const onChange = vi.fn();
		const { container } = render(
			<TokenListField
				label={<em>Topics</em>}
				values={['a/b']}
				onChange={onChange}
				parse={(raw) => [raw]}
			/>
		);
		const ul = container.querySelector('ul.has-tokens') as HTMLUListElement;
		expect(ul.hasAttribute('aria-label')).toBe(false);
		// The add input falls back to the generic label too.
		expect(screen.getByLabelText('Add item')).toBeTruthy();
	});
});
