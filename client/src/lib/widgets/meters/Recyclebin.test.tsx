import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import Recyclebin from './Recyclebin';
import type { SensorState } from '../../core/telemetry';

afterEach(cleanup);
const sc = (v: number): SensorState => ({ value: { kind: 'scalar', value: v }, history: [] });

describe('Recyclebin meter', () => {
	it('shows item count + size when it has contents', () => {
		const { container } = render(
			<Recyclebin sensors={{ items: sc(3), bytes: sc(2_500_000_000) }} />
		);
		expect(container.querySelector('.rb-count')?.textContent).toBe('3 items');
		expect(container.querySelector('.rb-size')?.textContent).toContain('GiB');
		expect(container.querySelector('.recyclebin')?.getAttribute('data-level')).toBe('has');
	});

	it('singularises one item', () => {
		const { container } = render(<Recyclebin sensors={{ items: sc(1), bytes: sc(1000) }} />);
		expect(container.querySelector('.rb-count')?.textContent).toBe('1 item');
	});

	it('shows Empty with no items', () => {
		const { container } = render(<Recyclebin sensors={{ items: sc(0), bytes: sc(0) }} />);
		expect(container.querySelector('.rb-empty')?.textContent).toBe('Empty');
		expect(container.querySelector('.recyclebin')?.getAttribute('data-level')).toBe('empty');
	});

	it('flags full past the warn threshold', () => {
		const { container } = render(
			<Recyclebin sensors={{ items: sc(10), bytes: sc(5e9) }} warnGb={2} />
		);
		expect(container.querySelector('.recyclebin')?.getAttribute('data-level')).toBe('full');
	});

	it('treats a missing byte sample as 0 bytes while still counting items', () => {
		const { container } = render(<Recyclebin sensors={{ items: sc(4) }} />);
		expect(container.querySelector('.rb-count')?.textContent).toBe('4 items');
		expect(container.querySelector('.rb-size')?.textContent).toBe('0 B');
	});

	it('ignores a non-scalar items sample (treated as no reading yet → empty)', () => {
		const { container } = render(
			<Recyclebin sensors={{ items: { value: { kind: 'text', value: 'n/a' }, history: [] } }} />
		);
		expect(container.querySelector('.rb-empty')?.textContent).toBe('Empty');
	});

	it('applies a per-instance color as the --rb-accent CSS variable', () => {
		const { container } = render(<Recyclebin sensors={{}} color="rgb(1,1,1)" />);
		const root = container.querySelector('.np-recyclebin') as HTMLElement;
		expect(root.style.getPropertyValue('--rb-accent')).toBe('rgb(1,1,1)');
	});
});
