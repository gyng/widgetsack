import { type Page, type Locator, expect } from '@playwright/test';

// Shared helpers for the studio e2e suite. Everything runs against the SPA served by Vite with the dev
// Tauri mock (src/lib/devMock.ts) installed — a real browser drives the studio with a stubbed backend.
// See playwright.config.ts for the why (real layout engine vs happy-dom; no live sensors/persistence).

/** Boot the studio (the dev mock forces the 'studio' window role + edit mode) and wait for the chrome. */
export async function gotoStudio(page: Page): Promise<void> {
	await page.goto('/');
	// editMode is auto-enabled on studio boot (useStudioInit.setEditModeImmediate); ALL chrome is gated
	// behind it, so .canvas.studio.edit being visible is the signal the editor is fully up.
	await expect(page.locator('.canvas.studio.edit')).toBeVisible();
}

/**
 * Attach console/error watchers BEFORE navigating. Returns the two things a clean boot must never
 * produce: real JS errors (the benign favicon-404 is filtered) and the harness's own unmocked-command
 * warning — so a NEW unmocked Tauri command surfaces immediately instead of silently returning null.
 */
export function watchConsole(page: Page): { errors: string[]; mockWarns: string[] } {
	const errors: string[] = [];
	const mockWarns: string[] = [];
	page.on('console', (m) => {
		const t = m.text();
		if (m.type() === 'error' && !/favicon/i.test(t)) errors.push(t);
		if (m.type() === 'warning' && t.includes('[devMock] unhandled command')) mockWarns.push(t);
	});
	page.on('pageerror', (e) => errors.push(String(e)));
	return { errors, mockWarns };
}

/**
 * A left NavRail section button by its stable section id (layouts/widget-designer/sensors/plugins/
 * themes/sacks/controls/settings). Keyed off data-section, NOT the visible short label, which is
 * responsive ("Design"↔"Defs").
 */
export function navItem(page: Page, id: string): Locator {
	return page.locator(`.nav-rail .nav-item[data-section="${id}"]`);
}

/** Switch the studio to a NavRail section (by id). */
export async function openSection(page: Page, id: string): Promise<void> {
	await navItem(page, id).click();
}

/** Open the designer and read-only-preview a built-in template by its exact name. */
export async function previewTemplate(page: Page, name: string): Promise<void> {
	await openSection(page, 'widget-designer');
	await page.getByRole('button', { name, exact: true }).click();
}

/**
 * Add a widget from the Inspector palette (Layouts section) and return the now-selected host.
 * `type` is the palette LABEL (e.g. "Gauge", "Analog Clock"). The palette button's accessible name
 * is "<label> — <description>" (the description was folded into the aria-label), so we anchor on the
 * label: the accessible name is exactly the label, or the label followed by the " — " separator. The
 * anchor avoids the substring collisions a bare name match would hit (e.g. "Bar" ⊂ Gauge's
 * "…linear bar…", "Text" ⊂ Transcribe's "…speech-to-text…").
 */
export async function addWidget(page: Page, type: string): Promise<Locator> {
	await openSection(page, 'layouts');
	// The Add palette lives in a <details> that auto-collapses once a node is selected, so re-open it
	// (a no-op on a fresh boot where nothing is selected) before reaching for a palette button.
	const summary = page.locator('.inspector .add-panel > summary');
	if (!(await page.locator('.inspector .add-panel[open]').count())) await summary.click();
	const label = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape regex metachars in the label
	await page
		.locator('.inspector .palette')
		.getByRole('button', { name: new RegExp(`^${label}( — |$)`) })
		.click();
	const selected = page.locator('.widget.selected');
	await expect(selected).toBeVisible();
	return selected;
}

/**
 * Right-click an EMPTY spot on the stage so the canvas/root context menu opens (not a widget menu).
 * Scans for a point whose top element is the canvas/world/flow-frame (i.e. not a widget or a panel).
 */
export async function rightClickEmptyCanvas(page: Page): Promise<void> {
	const pt = await page.evaluate(() => {
		const c = document.querySelector('.canvas.studio')?.getBoundingClientRect();
		if (!c) return null;
		for (let fy = 0.9; fy > 0.3; fy -= 0.05)
			for (let fx = 0.3; fx < 0.78; fx += 0.05) {
				const x = c.x + c.width * fx;
				const y = c.y + c.height * fy;
				const el = document.elementFromPoint(x, y);
				if (
					el &&
					(el.classList.contains('canvas') ||
						el.classList.contains('world') ||
						el.classList.contains('flow-frame'))
				)
					return { x, y };
			}
		return null;
	});
	if (!pt) throw new Error('no empty canvas point found to right-click');
	await page.mouse.click(pt.x, pt.y, { button: 'right' });
}
