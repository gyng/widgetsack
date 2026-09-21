import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { SensorState } from '../../core/telemetry';
import Ticker from './Ticker';

type Props = Parameters<typeof Ticker>[0];

const scalar = (value: number, history: number[] = [value]): SensorState => ({
	value: { kind: 'scalar', value },
	history
});
const text = (value: string): SensorState => ({ value: { kind: 'text', value }, history: [] });
const series = (value: number[]): SensorState => ({
	value: { kind: 'series', value },
	history: []
});

// The live states WidgetHost resolves from the plugin meta's `sensors` map (price/change/…).
const aaplSensors = (price = 110, change = 10): NonNullable<Props['sensors']> => ({
	price: scalar(price),
	change: scalar(change),
	currency: text('USD'),
	series: series([100, 105, price])
});

const part = (c: HTMLElement, p: string) => c.querySelector(`[data-part="${p}"]`);
const root = (c: HTMLElement) => c.querySelector('.np-ticker') as HTMLElement;

describe('Ticker', () => {
	it('shows a placeholder when no symbol is set', () => {
		const { container } = render(<Ticker symbol="" />);
		expect(part(container, 'placeholder')?.textContent).toBe('Set a symbol');
		expect(part(container, 'price')).toBeNull();
	});

	it('renders symbol, currency-prefixed price, and a positive change (dir=up, ▲)', () => {
		const { container } = render(<Ticker symbol="aapl" sensors={aaplSensors()} />);
		expect(part(container, 'symbol')?.textContent).toBe('AAPL');
		expect(part(container, 'price')?.textContent).toBe('$110.00');
		expect(part(container, 'change')?.textContent).toContain('+10.00%');
		expect(part(container, 'arrow')?.textContent).toBe('▲');
		expect(root(container).getAttribute('data-dir')).toBe('up');
	});

	it('colors a loss down (▼) and flags the market state', () => {
		const { container } = render(
			<Ticker symbol="AAPL" sensors={{ ...aaplSensors(90, -10), state: text('CLOSED') }} />
		);
		expect(root(container).getAttribute('data-dir')).toBe('down');
		expect(part(container, 'arrow')?.textContent).toBe('▼');
		expect(part(container, 'state')?.textContent).toBe('closed');
	});

	it('reflects the invert-colours toggle as data-invert (CSS swaps up/down)', () => {
		const off = render(<Ticker symbol="AAPL" sensors={aaplSensors()} />);
		expect(root(off.container).getAttribute('data-invert')).toBe('false');
		const on = render(<Ticker symbol="AAPL" invertColors sensors={aaplSensors()} />);
		expect(root(on.container).getAttribute('data-invert')).toBe('true');
		// dir is still 'up' for a gain — only the colour mapping flips, in CSS.
		expect(root(on.container).getAttribute('data-dir')).toBe('up');
	});

	it('uses the label override for the header', () => {
		const { container } = render(<Ticker symbol="AAPL" label="Apple" sensors={aaplSensors()} />);
		expect(part(container, 'symbol')?.textContent).toBe('Apple');
	});

	it('shows a loading dash before the first price', () => {
		const { container } = render(<Ticker symbol="AAPL" />); // no samples yet
		expect(part(container, 'price')?.textContent).toBe('…');
		expect(root(container).getAttribute('data-loading')).toBe('true');
	});

	it('renders the sparkline from the series, and hides it when disabled', () => {
		const on = render(<Ticker symbol="AAPL" showSparkline sensors={aaplSensors()} />);
		expect(on.container.querySelector('.np-ticker-spark canvas')).not.toBeNull();
		const off = render(<Ticker symbol="AAPL" showSparkline={false} sensors={aaplSensors()} />);
		expect(off.container.querySelector('.np-ticker-spark')).toBeNull();
	});

	it('falls back to the price history ring when no series sensor has arrived', () => {
		const { container } = render(
			<Ticker symbol="AAPL" sensors={{ price: scalar(110, [100, 105, 110]), change: scalar(10) }} />
		);
		expect(container.querySelector('.np-ticker-spark canvas')).not.toBeNull();
	});
});
