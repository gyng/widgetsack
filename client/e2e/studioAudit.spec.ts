import { test, expect } from '@playwright/test';
import { addWidget, gotoStudio, openSection, watchConsole } from './helpers';

test('outline guides connect between rows and widget previews have balanced insets', async ({
	page
}) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	await page.locator('.outline .add button').first().click();
	await addWidget(page, 'Clock');
	await addWidget(page, 'Bar');
	const guides = page.locator('.outline .row .guides');
	for (let i = 0; i < (await guides.count()); i++) {
		const guide = await guides.nth(i).boundingBox();
		const row = await guides.nth(i).locator('..').boundingBox();
		expect(Math.abs(guide!.y - row!.y)).toBeLessThanOrEqual(1);
		expect(Math.abs(guide!.y + guide!.height - row!.y - row!.height)).toBeLessThanOrEqual(1);
	}
	await page.getByRole('tab', { name: 'Add', exact: true }).click();
	await expect(page.locator('.inspector .add-panel')).toHaveAttribute('open', '');
	const palette = page.locator('.inspector .palette button:has(.catalog-item-name)');
	expect(await palette.count()).toBeGreaterThan(30);
	await palette.first().hover();
	const tooltip = page.getByRole('tooltip');
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toHaveCSS('padding', '12px');
	const preview = await tooltip.boundingBox();
	const metadata = await tooltip.locator('.pp-meta').boundingBox();
	expect(metadata!.x - preview!.x).toBeGreaterThanOrEqual(12);
	await page.screenshot({ path: 'test-results/studio-outline-tooltip.png' });
	const monitor = page.getByRole('combobox', { name: 'Monitor', exact: true });
	expect((await monitor.boundingBox())!.width).toBeGreaterThanOrEqual(150);
	await expect(
		page.locator('.outline').getByRole('combobox', { name: 'Monitor', exact: true })
	).toBeVisible();
	await expect(monitor).toContainText(/Current monitor|Mock/);
	await openSection(page, 'sensors');
	const value = page.locator('.sensor-value').first();
	await expect(value).toBeVisible();
	expect(await value.evaluate((node) => getComputedStyle(node).fontFamily)).toContain('Consolas');
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});

test('plugin list, empty packages, and input controls share readable alignment', async ({
	page
}) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	await openSection(page, 'plugins');
	const panel = page.locator('.plugins-panel');
	const source = panel.getByLabel('Package source');
	await expect(source).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
	await panel.screenshot({ path: 'test-results/studio-plugin-audit.png' });
	await expect(source).toHaveCSS('font-size', '14px');
	expect(await source.evaluate((node) => getComputedStyle(node).fontFamily)).toContain(
		'IBM Plex Sans'
	);
	expect((await source.boundingBox())!.height).toBeGreaterThanOrEqual(32);
	const dot = panel.locator('.pl-item .pl-dot').first();
	const bounds = await dot.boundingBox();
	const row = await dot.locator('..').boundingBox();
	expect(Math.abs(bounds!.y + bounds!.height / 2 - row!.y - row!.height / 2)).toBeLessThanOrEqual(
		1
	);
	for (const width of [1280, 1024]) {
		await page.setViewportSize({ width, height: 768 });
		expect(
			await panel.locator('.pl-list').evaluate((node) => node.scrollWidth <= node.clientWidth)
		).toBe(true);
		await expect(panel.getByText('No packages installed', { exact: true })).toBeVisible();
	}
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});
