import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

// A child that throws during render (what an error boundary catches) when given a value to throw.
function Boom({ thrown }: { thrown?: unknown }) {
	if (thrown !== undefined) throw thrown;
	return <div>healthy</div>;
}

describe('ErrorBoundary', () => {
	beforeEach(() => {
		// React logs every caught render error to console.error; silence it (and let us assert on it).
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
	});
	afterEach(() => vi.restoreAllMocks());

	it('renders its children when they do not throw', () => {
		const { getByText, queryByRole } = render(
			<ErrorBoundary label="settings">
				<Boom />
			</ErrorBoundary>
		);
		expect(getByText('healthy')).toBeTruthy();
		expect(queryByRole('alert')).toBeNull();
	});

	it('shows a labelled inline fallback with the error message when a child throws', () => {
		const { getByRole } = render(
			<ErrorBoundary label="HA settings">
				<Boom thrown={new Error('kaboom')} />
			</ErrorBoundary>
		);
		expect(getByRole('alert').textContent).toContain('HA settings failed to render: kaboom');
	});

	it('falls back to the default label when none is given', () => {
		const { getByRole } = render(
			<ErrorBoundary>
				<Boom thrown={new Error('kaboom')} />
			</ErrorBoundary>
		);
		expect(getByRole('alert').textContent).toContain('This panel failed to render: kaboom');
	});

	it('stringifies a non-Error throw (a plugin can throw anything)', () => {
		const { getByRole } = render(
			<ErrorBoundary>
				<Boom thrown="plain failure" />
			</ErrorBoundary>
		);
		expect(getByRole('alert').textContent).toContain('failed to render: plain failure');
	});

	it('"Reload section" remounts the children (a fixed child renders again)', () => {
		let thrown: unknown = new Error('kaboom');
		function Flaky() {
			if (thrown !== undefined) throw thrown;
			return <div>recovered</div>;
		}
		const { getByRole, getByText, queryByRole } = render(
			<ErrorBoundary label="Themes">
				<Flaky />
			</ErrorBoundary>
		);
		expect(getByRole('alert').textContent).toContain('Themes failed to render: kaboom');
		thrown = undefined; // the underlying fault is gone (e.g. a plugin reconnected)
		fireEvent.click(getByText('Reload section'));
		expect(queryByRole('alert')).toBeNull();
		expect(getByText('recovered')).toBeTruthy();
	});

	it('a resetKey change clears the caught error (the selection / monitor moved on)', () => {
		let thrown: unknown = new Error('kaboom');
		function Flaky() {
			if (thrown !== undefined) throw thrown;
			return <div>fresh</div>;
		}
		const { getByText, queryByRole, rerender } = render(
			<ErrorBoundary resetKey="a">
				<Flaky />
			</ErrorBoundary>
		);
		expect(queryByRole('alert')).not.toBeNull();
		thrown = undefined;
		rerender(
			<ErrorBoundary resetKey="b">
				<Flaky />
			</ErrorBoundary>
		);
		expect(queryByRole('alert')).toBeNull();
		expect(getByText('fresh')).toBeTruthy();
	});

	it('"Copy error" hands the label + message + stack to the copy adapter', () => {
		const onCopy = vi.fn();
		const { getByText } = render(
			<ErrorBoundary label="Sacks" onCopy={onCopy}>
				<Boom thrown={new Error('kaboom')} />
			</ErrorBoundary>
		);
		fireEvent.click(getByText('Copy error'));
		expect(onCopy).toHaveBeenCalledTimes(1);
		const text = onCopy.mock.calls[0][0] as string;
		expect(text.split('\n')[0]).toBe('Sacks failed: kaboom');
		expect(text).toContain('Boom'); // the component stack names the throwing child
	});

	it('"Copy error" falls back to the clipboard API (and survives a non-Error throw with no stack)', () => {
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const { getByText } = render(
			<ErrorBoundary>
				<Boom thrown="plain failure" />
			</ErrorBoundary>
		);
		fireEvent.click(getByText('Copy error'));
		expect(writeText).toHaveBeenCalledWith(expect.stringContaining('panel failed: plain failure'));
		// An Error stripped of its stack still copies (the message alone, plus React's component stack).
		const bare = new Error('no stack');
		bare.stack = undefined;
		const onCopy = vi.fn();
		const r2 = render(
			<ErrorBoundary onCopy={onCopy}>
				<Boom thrown={bare} />
			</ErrorBoundary>
		);
		fireEvent.click(r2.getAllByText('Copy error')[1]);
		expect(onCopy.mock.calls[0][0]).toContain('panel failed: no stack');
	});

	it('logs the crash to console.error, using the label when given and "panel" otherwise', () => {
		render(
			<ErrorBoundary>
				<Boom thrown={new Error('kaboom')} />
			</ErrorBoundary>
		);
		expect(console.error).toHaveBeenCalledWith('panel crashed', expect.any(Error));
		render(
			<ErrorBoundary label="HA settings">
				<Boom thrown={new Error('kaboom')} />
			</ErrorBoundary>
		);
		expect(console.error).toHaveBeenCalledWith('HA settings crashed', expect.any(Error));
	});
});
