import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import Bar from './Bar';

const part = (c: Element, p: string) => {
	const el = c.querySelector(`[data-part="${p}"]`);
	if (!el) throw new Error(`missing data-part="${p}"`);
	return el as HTMLElement;
};

describe('Bar', () => {
	it('horizontal (default): fills width from the value fraction, uses accent/track tokens', () => {
		const { container } = render(<Bar value={42} />);
		const track = part(container, 'track');
		const fill = part(container, 'fill');
		expect(track.className).toContain('horizontal');
		// fraction(42, 0, 100) * 100 → '42.0%' on width
		expect(fill.style.width).toBe('42.0%');
		expect(fill.style.height).toBe('');
		// happy-dom does not serialise a `var(...)` background into the inline style attribute,
		// so the token-driven defaults leave `style.background` empty (look lives in CSS).
		expect(track.style.background).toBe('');
		expect(fill.style.background).toBe('');
		// No label by default.
		expect(container.querySelector('[data-part="label"]')).toBeNull();
	});

	it('vertical orientation drives height instead of width', () => {
		const { container } = render(<Bar value={75} orientation="vertical" />);
		const track = part(container, 'track');
		const fill = part(container, 'fill');
		expect(track.className).toContain('vertical');
		expect(fill.style.height).toBe('75.0%');
		expect(fill.style.width).toBe('');
	});

	it('per-instance color/track override the tokens and a label renders', () => {
		const { container } = render(
			<Bar value={50} min={0} max={200} color="red" track="#222" label="RAM" />
		);
		const track = part(container, 'track');
		const fill = part(container, 'fill');
		// Concrete colours (unlike var() tokens) do serialise into the inline style.
		expect(track.style.background).toBe('#222');
		expect(fill.style.background).toBe('red');
		// fraction(50, 0, 200) = 0.25 → '25.0%'
		expect(fill.style.width).toBe('25.0%');
		expect(part(container, 'label').textContent).toBe('RAM');
	});

	it('null value (default) clamps to 0%', () => {
		const { container } = render(<Bar />);
		expect(part(container, 'fill').style.width).toBe('0.0%');
	});
});
