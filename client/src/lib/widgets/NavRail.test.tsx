import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import NavRail from './NavRail';
import { SECTIONS } from './canvas/studioSections';

// NavRail is a presentational molecule: it renders one button per studio section, split into the
// `main` group and the `foot` group around a spacer, and reports clicks via onSelect. The title /
// aria-label / aria-current attribute logic is the interesting surface — drive it through the real
// SECTIONS data so the test tracks the rail.

const noop = () => undefined;

describe('NavRail', () => {
	it('renders one button per section, in two groups around the spacer', () => {
		const { container } = render(<NavRail active="layouts" onSelect={noop} />);
		const buttons = container.querySelectorAll('button.nav-item');
		expect(buttons.length).toBe(SECTIONS.length);

		const spacer = container.querySelector('.nav-spacer');
		expect(spacer).not.toBeNull();

		// The foot group renders after the spacer (Settings is the sole foot item).
		const foot = SECTIONS.filter((s) => s.group === 'foot');
		const lastBtn = container.querySelector(`button[data-section="${foot[0].id}"]`)!;
		// spacer precedes the foot button in document order
		const order = Array.from(container.querySelector('.nav-rail')!.children);
		expect(order.indexOf(spacer!)).toBeLessThan(order.indexOf(lastBtn));
	});

	it('marks only the active section with the active class and aria-current=page', () => {
		const { container } = render(<NavRail active="themes" onSelect={noop} />);
		const active = container.querySelector('button[data-section="themes"]')!;
		expect(active.classList.contains('active')).toBe(true);
		expect(active.getAttribute('aria-current')).toBe('page');

		const other = container.querySelector('button[data-section="layouts"]')!;
		expect(other.classList.contains('active')).toBe(false);
		expect(other.getAttribute('aria-current')).toBeNull();
	});

	it('fires onSelect with the section id on click', () => {
		const onSelect = vi.fn();
		const { container } = render(<NavRail active="layouts" onSelect={onSelect} />);
		fireEvent.click(container.querySelector('button[data-section="sensors"]')!);
		expect(onSelect).toHaveBeenCalledWith('sensors');
	});

	it('sets a title only when the full label differs from the short label, else omits it', () => {
		const { container } = render(<NavRail active="layouts" onSelect={noop} />);

		// widget-designer: label "Widget designer" !== short "Defs" → title is the full label.
		const defs = container.querySelector('button[data-section="widget-designer"]')!;
		expect(defs.getAttribute('title')).toBe('Widget designer');

		// sensors: label "Sensors" === short "Sensors" and not a stub → no redundant title.
		const sensors = container.querySelector('button[data-section="sensors"]')!;
		expect(sensors.getAttribute('title')).toBeNull();
	});

	it('always exposes the full label as the accessible name via aria-label', () => {
		const { container } = render(<NavRail active="layouts" onSelect={noop} />);
		const sensors = container.querySelector('button[data-section="sensors"]')!;
		expect(sensors.getAttribute('aria-label')).toBe('Sensors');
		const backdrop = container.querySelector('button[data-section="background"]')!;
		expect(backdrop.getAttribute('aria-label')).toBe('Background');
		// the visible short label still differs from the accessible name
		expect(backdrop.querySelector('.nav-short')!.textContent).toBe('Backdrop');
	});

	it('does not annotate the (non-stub) real sections with "(coming soon)"', () => {
		const { container } = render(<NavRail active="layouts" onSelect={noop} />);
		for (const s of SECTIONS) {
			const btn = container.querySelector(`button[data-section="${s.id}"]`)!;
			expect(btn.getAttribute('aria-label')).not.toContain('(coming soon)');
		}
	});

	it('hides the decorative glyph from assistive tech and shows the short label', () => {
		const { container } = render(<NavRail active="layouts" onSelect={noop} />);
		const icon = container.querySelector('button[data-section="layouts"] .nav-icon')!;
		expect(icon.getAttribute('aria-hidden')).toBe('true');
		expect(container.querySelector('button[data-section="layouts"] .nav-short')!.textContent).toBe(
			'Layout'
		);
	});
});

// SECTIONS today has no stub:true entry, so the "(coming soon)" arm (NavRail lines 23-24) is only
// reachable for a future stub section. Drive that branch through the real component by mocking the
// studioSections data to include a stub, re-importing NavRail under the mock.
describe('NavRail — stub section ("coming soon" arm)', () => {
	afterEach(() => vi.resetModules());

	it('suffixes a stub section with "(coming soon)" in both title and aria-label', async () => {
		vi.resetModules();
		vi.doMock('./canvas/studioSections', () => ({
			SECTIONS: [
				{ id: 'layouts', label: 'Layouts', short: 'Layout', icon: '▤', group: 'main' },
				{
					id: 'future',
					label: 'Future thing',
					short: 'Future',
					icon: '✦',
					group: 'main',
					stub: true
				}
			]
		}));
		const { default: NavRailMocked } = await import('./NavRail');
		const { render: renderMocked } = await import('@testing-library/react');
		const { container } = renderMocked(<NavRailMocked active="layouts" onSelect={noop} />);

		const stub = container.querySelector('button[data-section="future"]')!;
		// label "Future thing" !== short "Future" AND stub:true → both pieces appended
		expect(stub.getAttribute('title')).toBe('Future thing (coming soon)');
		expect(stub.getAttribute('aria-label')).toBe('Future thing (coming soon)');
	});
});
