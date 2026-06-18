import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import WidgetPreview from './WidgetPreview';
import { createWidget } from '../core/widget';
import { container, leaf } from '../core/layoutTree';

// WidgetPreview is a molecule: it renders palette entries through the REAL FlowNode + WidgetHost
// against a seeded telemetry hub. We don't mock the render layer (ThemePreview's test renders the
// same WidgetHost happily in happy-dom) — we assert the host's OWN decisions: the NO_DEMO
// placeholder branch, type→one-leaf-tree normalisation, the def/template tree path, the
// scale-to-fit math, and the null (nothing to draw) branch.

const stage = (c: HTMLElement): HTMLElement | null =>
	c.querySelector('div[style*="transform-origin"]') as HTMLElement | null;

describe('WidgetPreview — NO_DEMO placeholder', () => {
	it('renders the "shows live data" placeholder for a backend/device-bound type (no meter)', () => {
		const { getByText, container: c } = render(<WidgetPreview type="spectrum" />);
		expect(getByText('shows live data')).toBeTruthy();
		// The real widget render path (a FlowNode data-id slot) must NOT be present.
		expect(c.querySelector('[data-id]')).toBeNull();
	});

	it('treats nowplaying / image / iframe / monitorswitch as NO_DEMO too', () => {
		// Each render is scoped to its own container (the prior renders persist in the shared document).
		for (const type of ['nowplaying', 'image', 'iframe', 'monitorswitch']) {
			const { container: c } = render(<WidgetPreview type={type} />);
			expect(c.textContent).toBe('shows live data');
			expect(c.querySelector('[data-id]')).toBeNull();
		}
	});
});

describe('WidgetPreview — single widget type', () => {
	it('normalises a demoable type into a one-leaf tree and renders it via WidgetHost (data-id slot)', () => {
		const { container: c, queryByText } = render(<WidgetPreview type="clock" />);
		// type → leaf(createWidget('clock', 'preview-clock')); FlowNode emits its data-id.
		expect(c.querySelector('[data-id="preview-clock"]')).toBeTruthy();
		// NOT the placeholder — clock is data-independent and previews fine.
		expect(queryByText('shows live data')).toBeNull();
	});

	it('renders a demoable type at scale 1 (box == native size → no transform)', () => {
		const { container: c } = render(<WidgetPreview type="gauge" w={180} h={100} />);
		const st = stage(c);
		expect(st).toBeTruthy();
		// scale === 1 → transform omitted; the inner stage carries the box size.
		expect(st!.style.transform).toBe('');
		expect(st!.style.width).toBe('180px');
		expect(st!.style.height).toBe('100px');
	});
});

describe('WidgetPreview — def / template tree (scale-to-fit)', () => {
	const tree = () =>
		container('preview-root', 'col', [leaf(mk('gauge', 'g1'))], { align: 'stretch' });
	function mk(type: string, id: string) {
		const inst = createWidget(type, id);
		inst.rect = { x: 0, y: 0, w: 400, h: 300 };
		return inst;
	}

	it('draws a tree at its native size and scales it down to fit the preview box', () => {
		const { container: c } = render(
			<WidgetPreview node={tree()} size={{ w: 400, h: 300 }} w={200} h={120} />
		);
		const st = stage(c);
		expect(st).toBeTruthy();
		// native 400x300 in a 200x120 box → min(200/400, 120/300, 1) = min(0.5, 0.4, 1) = 0.4
		expect(st!.style.transform).toBe('scale(0.4)');
		// the inner stage keeps the AUTHORED size; the wrapper clips to the box.
		expect(st!.style.width).toBe('400px');
		expect(st!.style.height).toBe('300px');
	});

	it('never scales a tree UP past 1 even when the box is larger than native', () => {
		const small = () =>
			container('preview-root', 'col', [leaf(mk('gauge', 'g2'))], { align: 'stretch' });
		const { container: c } = render(
			<WidgetPreview node={small()} size={{ w: 50, h: 40 }} w={300} h={300} />
		);
		const st = stage(c);
		// min(300/50, 300/40, 1) = 1 → no transform.
		expect(st!.style.transform).toBe('');
	});
});

describe('WidgetPreview — nothing to draw', () => {
	it('renders null when given neither a type nor a node', () => {
		const { container: c } = render(<WidgetPreview />);
		expect(c.firstChild).toBeNull();
	});

	it('renders null when given a node but no size', () => {
		const node = container('preview-root', 'col', [leaf(createWidget('text', 't1'))]);
		const { container: c } = render(<WidgetPreview node={node} />);
		expect(c.firstChild).toBeNull();
	});
});
