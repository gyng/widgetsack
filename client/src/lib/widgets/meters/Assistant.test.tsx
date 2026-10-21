import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import Assistant from './Assistant';

describe('Assistant (pure view)', () => {
	it('renders the generated text + label', () => {
		const { getByText } = render(<Assistant text="All quiet — CPU at 12%." label="AI" />);
		expect(getByText('All quiet — CPU at 12%.')).toBeTruthy();
		expect(getByText('AI')).toBeTruthy();
	});

	it('shows a waiting placeholder when empty, and a thinking state when busy', () => {
		const { getByText, rerender } = render(<Assistant text="" />);
		expect(getByText('No response yet. Generate now.')).toBeTruthy();
		rerender(<Assistant text="" busy />);
		expect(getByText(/Thinking/)).toBeTruthy();
	});

	it('shows an error', () => {
		const { getByText } = render(<Assistant error="no API key" />);
		expect(getByText(/no API key/)).toBeTruthy();
	});

	it('fires onRefresh when the refresh control is clicked', () => {
		const onRefresh = vi.fn();
		const { getByLabelText } = render(<Assistant text="hi" onRefresh={onRefresh} />);
		fireEvent.click(getByLabelText('Generate now'));
		expect(onRefresh).toHaveBeenCalledOnce();
	});

	it('omits the refresh control when no handler is given', () => {
		const { queryByLabelText } = render(<Assistant text="hi" />);
		expect(queryByLabelText('Generate now')).toBeNull();
	});
});
