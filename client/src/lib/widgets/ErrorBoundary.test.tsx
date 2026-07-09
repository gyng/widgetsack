import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
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
