import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import AudioSwitcher from './AudioSwitcher';

afterEach(cleanup);
const devices = [
	{ id: 'a', name: 'Speakers' },
	{ id: 'b', name: 'Headphones' }
];

describe('AudioSwitcher meter', () => {
	it('marks the active device and floats it first', () => {
		const { container } = render(
			<AudioSwitcher devices={devices} currentId="b" onPick={() => undefined} />
		);
		const rows = container.querySelectorAll('.as-row');
		expect(rows).toHaveLength(2);
		expect(rows[0].getAttribute('data-active')).toBe('true');
		expect(rows[0].querySelector('.as-name')?.textContent).toBe('Headphones');
	});

	it('calls onPick with the device id on click', () => {
		const onPick = vi.fn();
		const { container } = render(<AudioSwitcher devices={devices} currentId="a" onPick={onPick} />);
		const headphones = [...container.querySelectorAll('.as-row')].find((r) =>
			r.textContent?.includes('Headphones')
		);
		fireEvent.click(headphones as Element);
		expect(onPick).toHaveBeenCalledWith('b');
	});

	it('marks the busy device while a switch is in flight', () => {
		const { container } = render(
			<AudioSwitcher devices={devices} currentId="a" busyId="b" onPick={() => undefined} />
		);
		const busy = [...container.querySelectorAll('.as-row')].find(
			(r) => r.getAttribute('data-busy') === 'true'
		);
		expect(busy?.textContent).toContain('Headphones');
	});

	it('shows a dash with no devices', () => {
		const { container } = render(
			<AudioSwitcher devices={[]} currentId={null} onPick={() => undefined} />
		);
		expect(container.querySelector('.as-empty')?.textContent).toBe('—');
	});
});
