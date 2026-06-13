import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import TopProcess from './TopProcess';
import type { SensorState } from '../../core/telemetry';

afterEach(cleanup);
const scalar = (v: number): SensorState => ({ value: { kind: 'scalar', value: v }, history: [] });
const txt = (v: string): SensorState => ({ value: { kind: 'text', value: v }, history: [] });

describe('TopProcess meter', () => {
	it('shows the CPU metric: name + percent + default label', () => {
		const { container } = render(
			<TopProcess by="cpu" sensors={{ name: txt('chrome.exe'), value: scalar(23) }} />
		);
		expect(container.querySelector('.tp-label')?.textContent).toBe('Top CPU');
		expect(container.querySelector('.tp-name')?.textContent).toBe('chrome.exe');
		expect(container.querySelector('.tp-value')?.textContent).toBe('23%');
		expect(container.querySelector('.tp-icon')?.textContent).toBe('🔥');
	});

	it('formats disk as a per-second rate and gpu as bytes', () => {
		const { container: d } = render(
			<TopProcess by="disk" sensors={{ name: txt('game.exe'), value: scalar(1_500_000) }} />
		);
		expect(d.querySelector('.tp-value')?.textContent).toContain('/s');
		cleanup();
		const { container: g } = render(
			<TopProcess by="gpu" sensors={{ name: txt('blender.exe'), value: scalar(2_000_000_000) }} />
		);
		expect(g.querySelector('.tp-label')?.textContent).toBe('Top GPU');
		expect(g.querySelector('.tp-value')?.textContent).not.toContain('/s');
	});

	it('renders dashes with no data', () => {
		const { container } = render(<TopProcess sensors={{}} />);
		expect(container.querySelector('.tp-name')?.textContent).toBe('—');
		expect(container.querySelector('.tp-value')?.textContent).toBe('—');
	});
});
