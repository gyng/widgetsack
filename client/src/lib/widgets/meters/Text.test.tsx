import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import Text, { isEmptyText } from './Text';
afterEach(() => vi.restoreAllMocks());

const part = (c: Element, p: string) => {
	const el = c.querySelector(`[data-part="${p}"]`);
	if (!el) throw new Error(`missing data-part="${p}"`);
	return el as HTMLElement;
};

describe('Text', () => {
	it('renders abbreviated network rates with rate styling', () => {
		const view = render(<Text value={24 * 1024 ** 2} format="rate-short" label="▼" />);
		expect(part(view.container, 'value')).toHaveTextContent('24M/s');
		expect(part(view.container, 'value')).toHaveAttribute('title', '24.0 MiB/s');
		expect(view.container.querySelector('.np-text')).toHaveClass('rate');
		view.rerender(<Text value="Offline" format="rate-short" />);
		expect(part(view.container, 'value')).not.toHaveAttribute('title');
	});
	it('keeps percentage history on 0–100 while rate history can auto-scale', () => {
		const context = {
			clearRect: vi.fn(),
			beginPath: vi.fn(),
			moveTo: vi.fn(),
			lineTo: vi.fn(),
			stroke: vi.fn()
		};
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
			context as unknown as CanvasRenderingContext2D
		);
		vi.spyOn(HTMLCanvasElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
		const history = [10, 20];
		const view = render(
			<Text
				value={20}
				history={history}
				showSparkline
				sparklineSmooth={false}
				sparklineScale="percent"
			/>
		);
		expect(context.lineTo).toHaveBeenLastCalledWith(expect.any(Number), 80);
		view.rerender(
			<Text
				value={20}
				history={history}
				showSparkline
				sparklineSmooth={false}
				sparklineScale="auto"
			/>
		);
		expect(context.lineTo).toHaveBeenLastCalledWith(expect.any(Number), 0);
	});
	it('can toggle an inline history graph without losing its current reading', () => {
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
		const view = render(<Text value={30} label="CPU" history={[10, 20, 30]} />);
		expect(view.queryByRole('img', { name: 'history' })).toBeNull();
		view.rerender(
			<Text
				value={30}
				label="CPU"
				history={[10, 20, 30]}
				showSparkline
				sparklineSeconds={90}
				sparklineWidth={32}
			/>
		);
		expect(view.getByRole('img', { name: 'history' })).toBeVisible();
		expect(view.getByText('30')).toBeVisible();
		view.rerender(
			<Text value={30} label="CPU" history={[10, 20, 30]} showSparkline sparklineStretch />
		);
		expect(view.container.querySelector('.text-sparkline.stretch')).toBeVisible();
		view.rerender(<Text value={40} label="CPU" history={[20, 30, 40]} showSparkline={false} />);
		expect(view.queryByRole('img', { name: 'history' })).toBeNull();
		expect(view.getByText('40')).toBeVisible();
	});
	it('formats a numeric value via formatScalar (integer default) and uses the --np-fg token', () => {
		const { container } = render(<Text value={42.7} />);
		const value = part(container, 'value');
		expect(value.textContent).toBe('43'); // integer → rounded
		// The default colour is the --np-fg token (with a literal fallback).
		const root = container.querySelector('.text') as HTMLElement;
		expect(root.style.color).toMatch(/^var\(--np-fg,/);
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
