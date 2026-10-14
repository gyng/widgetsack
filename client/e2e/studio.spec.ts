import { test, expect } from '@playwright/test';
import { addWidget, gotoStudio, navItem, openSection, watchConsole } from './helpers';

// Boot + the canonical template-geometry regression. Layout geometry the happy-dom unit tests can't do
// (no layout engine) is asserted here in a real browser via the dev Tauri mock.

test('studio boots clean: chrome renders, no console errors, no unmocked commands', async ({
	page
}) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	// The whole chrome is gated behind editMode — assert it actually rendered (guards the regression
	// where setEditModeImmediate never fires and the studio shows a bare canvas).
	// the primary toolbar (a secondary `.studio-bar.studio-subbar` may also exist)
	await expect(page.locator('.studio-bar:not(.studio-subbar)')).toBeVisible();
	await expect(page.locator('.nav-rail')).toBeVisible();
	await expect(page.locator('.powerbar')).toBeVisible();
	expect(log.errors, `console errors:\n${log.errors.join('\n')}`).toEqual([]);
	// Self-policing: a new boot-time Tauri command that the dev mock doesn't answer must fail the suite
	// here, not silently return null and corrupt a later test.
	expect(log.mockWarns, `unmocked Tauri commands:\n${log.mockWarns.join('\n')}`).toEqual([]);
});

test('powerline hint bar shows only on an edit stage (layouts / designing), not off-stage sections', async ({
	page
}) => {
	await gotoStudio(page);
	// Default boot = Layouts (an edit stage) → the canvas-gesture hints are relevant and shown.
	const powerbar = page.locator('.powerbar');
	await expect(powerbar).toBeVisible();

	// An off-stage section (Sensors is a full-width browser, no canvas) has no gestures to hint — the
	// bar must disappear and the section panel must reclaim the row (no dead gap above the window edge).
	await openSection(page, 'sensors');
	await expect(navItem(page, 'sensors')).toHaveClass(/active/);
	await expect(powerbar).toHaveCount(0);
	const panelBottom = await page
		.locator('.rail-panel')
		.evaluate((el) => el.getBoundingClientRect().bottom);
	expect(
		panelBottom,
		'panel reaches the window bottom with no reserved hint-bar gap'
	).toBeGreaterThan((await page.evaluate(() => window.innerHeight)) - 2);

	// Back to an edit stage → the hints come back.
	await openSection(page, 'layouts');
	await expect(powerbar).toBeVisible();
});

test('Clock (JP weekday): analog icon stays visible (fill meter) + date row is one line', async ({
	page
}) => {
	await gotoStudio(page);
	await openSection(page, 'widget-designer');
	await page.getByRole('button', { name: 'Clock (JP weekday)', exact: true }).click();

	// The analog clock is a FILL meter; this guards the regression where halign:'left' collapsed its
	// width to 0 and it vanished — it must render with a real box.
	const dial = page.locator('.analog-clock').first();
	await expect(dial).toBeVisible();
	const box = await dial.boundingBox();
	expect(box, 'analog clock has a layout box').not.toBeNull();
	expect((box?.width ?? 0) > 8 && (box?.height ?? 0) > 8, 'analog dial not collapsed').toBeTruthy();

	// The cluster's four digital clocks (time · weekday · date · month) rendered…
	const clocks = page.locator('.np-clock');
	await expect(clocks).toHaveCount(4);

	// …and the last two (date + month) share ONE row, adjacent — the content-basis fix (was spaced /
	// wrapped before). DOM order is time, weekday, date, month.
	const rects = await clocks.evaluateAll((els) =>
		els.map((e) => {
			const r = e.getBoundingClientRect();
			return { x: r.x, y: r.y };
		})
	);
	const date = rects[2];
	const month = rects[3];
	expect(Math.abs(date.y - month.y), 'date + month on the same row').toBeLessThan(24);
	expect(month.x, 'month sits to the right of the day-of-month').toBeGreaterThan(date.x);
});

test('Sensors pane: per-sensor "stays active after the studio closes?" dots + legend', async ({
	page
}) => {
	await gotoStudio(page);
	// A fresh Gauge binds cpu.total — so that sensor must read as kept-alive-by-a-widget.
	await addWidget(page, 'Gauge');

	await openSection(page, 'sensors');
	await expect(navItem(page, 'sensors')).toHaveClass(/active/);
	// The legend gives the at-a-glance answer.
	await expect(page.locator('.rp-sensor-legend')).toContainText('stay active after close');

	const filter = page.locator('.rp-filter input');
	const dotFor = (id: string) => page.locator('.rp-row', { hasText: id }).locator('.sensor-dot');

	// Referenced by the gauge → mint ★ (.on): stays sampled because a widget uses it. Distinct SHAPE
	// (star, not just colour) from the always-on dot below.
	await filter.fill('cpu.total');
	await expect(dotFor('cpu.total')).toHaveClass(/\bon\b/);
	await expect(dotFor('cpu.total')).toHaveText('★');

	// Cheap always-on system sensor, unused → amber ● (.amb): still sampled regardless.
	await filter.fill('cpu.cores.logical');
	await expect(dotFor('cpu.cores.logical')).toHaveClass(/\bamb\b/);
	await expect(dotFor('cpu.cores.logical')).toHaveText('●');

	// Demand-gated sensor, no widget → hollow ○ (.off): stops once the studio closes.
	await filter.fill('net.linkspeed.rx');
	await expect(dotFor('net.linkspeed.rx')).toHaveClass(/\boff\b/);
	await expect(dotFor('net.linkspeed.rx')).toHaveText('○');
});

test('tab navigation switches directly without capturing whole-window fade snapshots', async ({
	page
}) => {
	await page.addInitScript(() => {
		const state = window as unknown as { sectionTransitions: number };
		state.sectionTransitions = 0;
		const original = document.startViewTransition.bind(document);
		document.startViewTransition = ((...args: Parameters<typeof document.startViewTransition>) => {
			state.sectionTransitions++;
			return Reflect.apply(original, document, args);
		}) as typeof document.startViewTransition;
	});
	await gotoStudio(page);
	for (const id of ['settings', 'plugins', 'sensors', 'layouts']) {
		await openSection(page, id);
		await expect(navItem(page, id)).toHaveClass(/active/);
	}
	await page.keyboard.press('Control+9');
	await expect(navItem(page, 'settings')).toHaveClass(/active/);
	await page.keyboard.press('Control+1');
	await expect(navItem(page, 'layouts')).toHaveClass(/active/);
	await page.keyboard.press('Control+Tab');
	await expect(navItem(page, 'widget-designer')).toHaveClass(/active/);
	expect(
		await page.evaluate(
			() => (window as unknown as { sectionTransitions: number }).sectionTransitions
		)
	).toBe(0);
});
