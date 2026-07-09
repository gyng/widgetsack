import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import WidgetErrorBoundary from './WidgetErrorBoundary';

// A child that throws during render (what an error boundary catches) when `explode` is set.
function Boom({ explode, text }: { explode: boolean; text?: string }) {
	if (explode) throw new Error('kaboom');
	return <div>{text ?? 'ok'}</div>;
}

// A child that rethrows an arbitrary value — JS lets code throw non-Errors, which have no `.message`.
function BoomValue({ thrown }: { thrown: unknown }): ReactNode {
	throw thrown;
}

describe('WidgetErrorBoundary', () => {
	beforeEach(() => {
		// React logs every caught render error to console.error; silence it + our warn for clean output.
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	});
	afterEach(() => vi.restoreAllMocks());

	it('renders children when they do not throw', () => {
		const { getByText } = render(
			<WidgetErrorBoundary label="clock">
				<Boom explode={false} text="hello" />
			</WidgetErrorBoundary>
		);
		expect(() => getByText('hello')).not.toThrow();
	});

	it('renders a labelled fallback when a child throws, and warns once', () => {
		const { getByText } = render(
			<WidgetErrorBoundary label="clock" resetKey="a">
				<Boom explode={true} />
			</WidgetErrorBoundary>
		);
		expect(() => getByText(/clock/)).not.toThrow();
		expect(console.warn).toHaveBeenCalledTimes(1);
	});

	it('clears the error and re-renders children when resetKey changes', () => {
		const { rerender, getByText, queryByText } = render(
			<WidgetErrorBoundary label="clock" resetKey="a">
				<Boom explode={true} />
			</WidgetErrorBoundary>
		);
		expect(() => getByText(/clock/)).not.toThrow(); // fallback shown
		rerender(
			<WidgetErrorBoundary label="clock" resetKey="b">
				<Boom explode={false} text="recovered" />
			</WidgetErrorBoundary>
		);
		expect(() => getByText('recovered')).not.toThrow();
		expect(queryByText(/clock/)).toBeNull(); // fallback gone
	});

	it('stays on the fallback when resetKey is unchanged', () => {
		const { rerender, getByText, queryByText } = render(
			<WidgetErrorBoundary label="clock" resetKey="a">
				<Boom explode={true} />
			</WidgetErrorBoundary>
		);
		rerender(
			<WidgetErrorBoundary label="clock" resetKey="a">
				<Boom explode={false} text="should-not-show" />
			</WidgetErrorBoundary>
		);
		// Same resetKey → no retry → fallback persists even though children would now render fine.
		expect(() => getByText(/clock/)).not.toThrow();
		expect(queryByText('should-not-show')).toBeNull();
	});

	it('falls back to the "widget" label (and "?" in the warning) when no label is given', () => {
		const { getByText } = render(
			<WidgetErrorBoundary resetKey="a">
				<Boom explode={true} />
			</WidgetErrorBoundary>
		);
		expect(() => getByText(/widget/)).not.toThrow();
		expect(vi.mocked(console.warn).mock.calls[0][0]).toBe('widget "?" crashed; showing fallback');
	});

	it('warns only once when a resetKey retry rethrows the same message (dedupe)', () => {
		const { rerender, getByText } = render(
			<WidgetErrorBoundary label="clock" resetKey="a">
				<Boom explode={true} />
			</WidgetErrorBoundary>
		);
		expect(console.warn).toHaveBeenCalledTimes(1);
		rerender(
			<WidgetErrorBoundary label="clock" resetKey="b">
				<Boom explode={true} />
			</WidgetErrorBoundary>
		);
		// The retry re-threw the identical message: the fallback is back but there is no second warning.
		expect(() => getByText(/clock/)).not.toThrow();
		expect(console.warn).toHaveBeenCalledTimes(1);
	});

	it('stringifies a non-Error throw (no .message) for the dedupe key and still shows the fallback', () => {
		const { container } = render(
			<WidgetErrorBoundary label="clock" resetKey="a">
				<BoomValue thrown="string-crash" />
			</WidgetErrorBoundary>
		);
		expect(container.querySelector('.widget-error')).not.toBeNull();
		expect(console.warn).toHaveBeenCalledTimes(1);
	});
});
