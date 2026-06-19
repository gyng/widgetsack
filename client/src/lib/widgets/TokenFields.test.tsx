import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import TokenFields from './TokenFields';
import { TOKEN_FIELDS } from './themeTokens';

const COLOR = TOKEN_FIELDS.find((t) => t.kind === 'color')!;
const FONT = TOKEN_FIELDS.find((t) => t.kind === 'font')!;
const TEXT = TOKEN_FIELDS.find((t) => t.kind === 'text')!;

describe('TokenFields', () => {
	it('renders a field per token: colour fields get a swatch, text/font get a text input', () => {
		const { getByLabelText, getAllByText, container } = render(
			<TokenFields values={{}} onSet={vi.fn()} onClear={vi.fn()} />
		);
		for (const t of TOKEN_FIELDS) {
			expect(getAllByText(t.label).length).toBeGreaterThan(0); // the <label> text
		}
		// Each colour token renders a ColorField (swatch + text); each font/text token a plain input.
		const colorCount = TOKEN_FIELDS.filter((t) => t.kind === 'color').length;
		expect(container.querySelectorAll('.color-field').length).toBe(colorCount);
		// A colour field exposes a swatch control labelled by the token.
		expect(getByLabelText(`${COLOR.label} swatch`)).toBeTruthy();
		// Font/text tokens render a labelled text input that is not a ColorField.
		expect(getByLabelText(FONT.label).closest('.color-field')).toBeNull();
		expect(getByLabelText(TEXT.label).closest('.color-field')).toBeNull();
	});

	it('only the font field references the shared datalist', () => {
		const { getByLabelText } = render(
			<TokenFields values={{}} onSet={vi.fn()} onClear={vi.fn()} />
		);
		const fontInput = getByLabelText(FONT.label) as HTMLInputElement;
		const textInput = getByLabelText(TEXT.label) as HTMLInputElement;
		const listId = fontInput.getAttribute('list');
		expect(listId).toBeTruthy();
		expect(textInput.getAttribute('list')).toBeNull();
		// The datalist with that id exists and is populated with suggestions.
		const datalist = document.getElementById(listId!) as HTMLDataListElement;
		expect(datalist?.tagName.toLowerCase()).toBe('datalist');
		expect(datalist.querySelectorAll('option').length).toBeGreaterThan(0);
	});

	it('commits a changed text/font value on blur', () => {
		const onSet = vi.fn();
		const { getByLabelText } = render(
			<TokenFields values={{ [TEXT.key]: '2px' }} onSet={onSet} onClear={vi.fn()} />
		);
		const input = getByLabelText(TEXT.label) as HTMLInputElement;
		fireEvent.change(input, { target: { value: '8px' } });
		fireEvent.blur(input);
		expect(onSet).toHaveBeenCalledWith(TEXT.key, '8px');
	});

	it('does not commit when the text/font value is unchanged on blur', () => {
		const onSet = vi.fn();
		const { getByLabelText } = render(
			<TokenFields values={{ [TEXT.key]: '2px' }} onSet={onSet} onClear={vi.fn()} />
		);
		const input = getByLabelText(TEXT.label);
		fireEvent.blur(input); // no edit
		expect(onSet).not.toHaveBeenCalled();
	});

	it('editing the colour text field commits via onSet', () => {
		const onSet = vi.fn();
		const { container } = render(<TokenFields values={{}} onSet={onSet} onClear={vi.fn()} />);
		// The colour fields render first; the first .cf-text is the first colour token's text input.
		const input = container.querySelector('.cf-text') as HTMLInputElement;
		fireEvent.change(input, { target: { value: '#123456' } });
		fireEvent.blur(input);
		expect(onSet).toHaveBeenCalledWith(TOKEN_FIELDS[0].key, '#123456');
	});

	it('marks a field dirty when its value differs from baseValues', () => {
		const { container } = render(
			<TokenFields
				values={{ [TEXT.key]: '8px' }}
				baseValues={{ [TEXT.key]: '2px' }}
				onSet={vi.fn()}
				onClear={vi.fn()}
				labelClassName="full"
			/>
		);
		const dirtyLabels = container.querySelectorAll('label.full.dirty');
		expect(dirtyLabels.length).toBe(1);
	});

	it('treats a field matching baseValues (and a missing base key) as not dirty', () => {
		const { container } = render(
			<TokenFields
				values={{ [TEXT.key]: '2px' }}
				baseValues={{ [TEXT.key]: '2px' }}
				onSet={vi.fn()}
				onClear={vi.fn()}
			/>
		);
		expect(container.querySelectorAll('label.dirty').length).toBe(0);
	});

	it('shows a singular clear button for one override and calls onClear', () => {
		const onClear = vi.fn();
		const { getByRole } = render(
			<TokenFields
				values={{ [COLOR.key]: '#fff' }}
				onSet={vi.fn()}
				onClear={onClear}
				clearTitle="Clear all"
			/>
		);
		const btn = getByRole('button', { name: 'Clear 1 override' });
		expect(btn.getAttribute('title')).toBe('Clear all');
		fireEvent.click(btn);
		expect(onClear).toHaveBeenCalledTimes(1);
	});

	it('pluralises the clear button for multiple overrides', () => {
		const { getByRole } = render(
			<TokenFields
				values={{ [COLOR.key]: '#fff', [TEXT.key]: '2px' }}
				onSet={vi.fn()}
				onClear={vi.fn()}
			/>
		);
		expect(getByRole('button', { name: 'Clear 2 overrides' })).toBeTruthy();
	});

	it('renders no clear button when there are no overrides', () => {
		const { queryByRole } = render(<TokenFields values={{}} onSet={vi.fn()} onClear={vi.fn()} />);
		expect(queryByRole('button', { name: /Clear/ })).toBeNull();
	});
});
