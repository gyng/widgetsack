import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import BoxField from './BoxField';

describe('BoxField', () => {
	it('locked by default: one input; typing emits a uniform number', () => {
		const onChange = vi.fn();
		const { getByLabelText, queryByLabelText } = render(
			<BoxField label="margin" max={100} onChange={onChange} />
		);
		expect(queryByLabelText('margin top')).toBeNull(); // no per-side inputs while locked
		fireEvent.input(getByLabelText('margin all sides'), { target: { value: '8' } });
		expect(onChange).toHaveBeenCalledWith(8);
	});

	it('all sides 0 clears the value (undefined)', () => {
		const onChange = vi.fn();
		const { getByLabelText } = render(
			<BoxField label="pad" max={100} value={5} onChange={onChange} />
		);
		fireEvent.input(getByLabelText('pad all sides'), { target: { value: '0' } });
		expect(onChange).toHaveBeenCalledWith(undefined);
	});

	it('unlock → four side inputs; editing one emits a per-side object', () => {
		const onChange = vi.fn();
		const { getByLabelText } = render(
			<BoxField label="margin" max={100} value={4} onChange={onChange} />
		);
		fireEvent.click(getByLabelText('margin locked'));
		fireEvent.input(getByLabelText('margin top'), { target: { value: '10' } });
		expect(onChange).toHaveBeenCalledWith({ t: 10, r: 4, b: 4, l: 4 });
	});

	it('a non-uniform value shows four inputs even with the lock intent on', () => {
		const { getByLabelText, queryByLabelText } = render(
			<BoxField label="margin" max={100} value={{ t: 1, r: 2, b: 3, l: 4 }} onChange={vi.fn()} />
		);
		expect(queryByLabelText('margin all sides')).toBeNull();
		expect(getByLabelText('margin top')).toBeTruthy();
		expect(getByLabelText('margin per-side')).toBeTruthy(); // lock control reads as per-side
	});

	it('clamps each side to max', () => {
		const onChange = vi.fn();
		const { getByLabelText } = render(<BoxField label="pad" max={20} onChange={onChange} />);
		fireEvent.input(getByLabelText('pad all sides'), { target: { value: '999' } });
		expect(onChange).toHaveBeenCalledWith(20);
	});

	it('re-locking a per-side value collapses it to uniform using the top side', () => {
		const onChange = vi.fn();
		const { getByLabelText, queryByLabelText } = render(
			<BoxField label="margin" max={100} value={{ t: 7, r: 2, b: 3, l: 4 }} onChange={onChange} />
		);
		// Non-uniform value forces the per-side view; the lock control reads as 'per-side'.
		expect(getByLabelText('margin per-side')).toBeTruthy();
		fireEvent.click(getByLabelText('margin per-side'));
		// Collapses to the top side across all four → a uniform number (7).
		expect(onChange).toHaveBeenCalledWith(7);
		// And once re-locked with the value emitted, the single field would show.
		expect(queryByLabelText('margin top')).toBeTruthy(); // value prop unchanged this render → still per-side
	});

	it('unlock then re-lock toggles between single and four inputs', () => {
		const onChange = vi.fn();
		const { getByLabelText, queryByLabelText } = render(
			<BoxField label="pad" max={100} value={6} onChange={onChange} />
		);
		expect(getByLabelText('pad all sides')).toBeTruthy(); // locked + uniform → single input
		fireEvent.click(getByLabelText('pad locked')); // unlock
		expect(queryByLabelText('pad all sides')).toBeNull();
		expect(getByLabelText('pad top')).toBeTruthy();
		fireEvent.click(getByLabelText('pad per-side')); // re-lock (value still uniform 6)
		expect(onChange).toHaveBeenCalledWith(6); // collapse emits the uniform top value
		expect(getByLabelText('pad all sides')).toBeTruthy(); // back to single input
	});

	it('applies the dirty class when dirty', () => {
		const { container } = render(
			<BoxField label="margin" max={100} value={4} dirty onChange={vi.fn()} />
		);
		expect(container.querySelector('.boxfield.dirty')).toBeTruthy();
	});
});
