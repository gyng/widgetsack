import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import Ping from './Ping';
import type { SensorState } from '../../core/telemetry';

afterEach(cleanup);
const st = (value: number): SensorState => ({ value: { kind: 'scalar', value }, history: [] });

describe('Ping meter', () => {
	it('shows latency and an "up" level when reachable', () => {
		const { container } = render(<Ping host="1.1.1.1" sensors={{ up: st(1), ms: st(12) }} />);
		expect(container.querySelector('.ping')?.getAttribute('data-level')).toBe('up');
		expect(container.querySelector('.ping-value')?.textContent).toBe('12 ms');
		expect(container.querySelector('.ping-host')?.textContent).toBe('1.1.1.1');
	});

	it('shows "down" when up=0', () => {
		const { container } = render(<Ping sensors={{ up: st(0) }} />);
		expect(container.querySelector('.ping')?.getAttribute('data-level')).toBe('down');
		expect(container.querySelector('.ping-value')?.textContent).toBe('down');
	});

	it('flags slow latency past the threshold', () => {
		const { container } = render(<Ping sensors={{ up: st(1), ms: st(220) }} slowMs={150} />);
		expect(container.querySelector('.ping')?.getAttribute('data-level')).toBe('slow');
	});

	it('shows a dash + unknown before any sample', () => {
		const { container } = render(<Ping sensors={{}} />);
		expect(container.querySelector('.ping')?.getAttribute('data-level')).toBe('unknown');
		expect(container.querySelector('.ping-value')?.textContent).toBe('—');
	});

	it('prefers a custom label over the host', () => {
		const { container } = render(
			<Ping host="1.1.1.1" label="Cloudflare" sensors={{ up: st(1), ms: st(5) }} />
		);
		expect(container.querySelector('.ping-host')?.textContent).toBe('Cloudflare');
	});
});
