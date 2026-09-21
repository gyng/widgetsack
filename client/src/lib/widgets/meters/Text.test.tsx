import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import Text, { isEmptyText } from './Text';

const part = (c: Element, p: string) => {
	const el = c.querySelector(`[data-part="${p}"]`);
	if (!el) throw new Error(`missing data-part="${p}"`);
	return el as HTMLElement;
};

describe('Text', () => {
	it('formats a numeric value via formatScalar (integer default) and uses the --np-fg token', () => {
		const { container } = render(<Text value={42.7} />);
		const value = part(container, 'value');
		expect(value.textContent).toBe('43'); // integer → rounded
		// happy-dom does not serialise a `var(...)` colour into the inline style attribute, so the
		// token-driven default leaves `style.color` empty (the look lives in CSS).
		const root = container.querySelector('.text') as HTMLElement;
		expect(root.style.color).toBe('');
		// No label by default.
		expect(container.querySelector('[data-part="label"]')).toBeNull();
	});

	it('honours an explicit format (percent appends %)', () => {
		const { container } = render(<Text value={50} format="percent" />);
		expect(part(container, 'value').textContent).toBe('50%');
	});

	it('passes a string value straight through (formula-rendered) without formatting', () => {
		const { container } = render(<Text value="hello world" format="integer" />);
		expect(part(container, 'value').textContent).toBe('hello world');
	});

	it('renders a label and a per-instance color override', () => {
		const { container } = render(<Text value={7} label="Cores" color="#0f0" />);
		expect(part(container, 'label').textContent).toBe('Cores');
		// A concrete colour (unlike a var() token) does serialise into the inline style.
		const root = container.querySelector('.text') as HTMLElement;
		expect(root.style.color).toBe('#0f0');
	});

	it('null value (default) formats to the placeholder', () => {
		const { container } = render(<Text />);
		expect(part(container, 'value').textContent).toBe('–');
	});

	describe('empty-content placeholder (edit mode)', () => {
		it('renders the "Text" placeholder + empty class when there is no label and no value', () => {
			const { container } = render(<Text />);
			expect(part(container, 'placeholder').textContent).toBe('Text');
			expect(container.querySelector('.np-text.empty')).not.toBeNull();
			// The passive "–" is still rendered (CSS decides which one shows).
			expect(part(container, 'value').textContent).toBe('–');
		});

		it('a blank formula result counts as empty; a label or a value does not', () => {
			expect(isEmptyText('   ', '')).toBe(true);
			expect(isEmptyText(undefined, '')).toBe(true);
			expect(isEmptyText(0, '')).toBe(false);
			expect(isEmptyText('x', '')).toBe(false);
			expect(isEmptyText(null, 'CPU')).toBe(false);
			for (const props of [{ value: 0 }, { label: 'CPU' }, { value: 'hi' }]) {
				const { container } = render(<Text {...props} />);
				expect(container.querySelector('[data-part="placeholder"]')).toBeNull();
				expect(container.querySelector('.np-text.empty')).toBeNull();
			}
		});
	});
});
