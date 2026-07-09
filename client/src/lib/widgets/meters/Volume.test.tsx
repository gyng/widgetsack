import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import Volume from './Volume';

afterEach(cleanup);

describe('Volume meter', () => {
	it('shows the level percent and a speaker icon', () => {
		const { container } = render(<Volume level={0.5} muted={false} />);
		expect(container.querySelector('.vol-pct')?.textContent).toBe('50%');
		expect(container.querySelector('.vol-icon')?.textContent).toBe('🔉');
		expect((container.querySelector('.vol-slider') as HTMLInputElement).value).toBe('50');
	});

	it('shows the muted icon + marks the host muted', () => {
		const { container } = render(<Volume level={0.8} muted />);
		expect(container.querySelector('.vol-icon')?.textContent).toBe('🔇');
		expect(container.querySelector('.volume')?.getAttribute('data-muted')).toBe('true');
	});

	it('calls onSet with a 0..1 level when the slider moves', () => {
		const onSet = vi.fn();
		const { container } = render(<Volume level={0.2} onSet={onSet} />);
		fireEvent.change(container.querySelector('.vol-slider') as HTMLInputElement, {
			target: { value: '75' }
		});
		expect(onSet).toHaveBeenCalledWith(0.75);
	});

	it('calls onToggleMute when the speaker button is clicked', () => {
		const onToggleMute = vi.fn();
		const { container } = render(<Volume level={0.5} onToggleMute={onToggleMute} />);
		fireEvent.click(container.querySelector('.vol-mute') as Element);
		expect(onToggleMute).toHaveBeenCalled();
	});

	it('dashes the readout before the first reading', () => {
		const { container } = render(<Volume level={null} />);
		expect(container.querySelector('.vol-pct')?.textContent).toBe('—');
	});

	it('applies a per-instance color as the --vol-accent CSS variable', () => {
		const { container } = render(<Volume level={0.5} color="rgb(2,9,1)" />);
		const root = container.querySelector('.np-volume') as HTMLElement;
		expect(root.style.getPropertyValue('--vol-accent')).toBe('rgb(2,9,1)');
	});
});
