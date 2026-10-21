import { test, expect } from '@playwright/test';
import { addWidget, gotoStudio, watchConsole, openSection } from './helpers';

test('Studio uses readable local typography while widget theme fonts remain independent', async ({
	page
}) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	const widget = await addWidget(page, 'Bar');
	await page.evaluate(() => document.fonts.ready);
	const inspector = page.locator('.inspector.docked');
	await expect(inspector).toHaveCSS('font-size', '14px');
	await expect(inspector).toHaveCSS('line-height', '20px');
	expect(await inspector.evaluate((node) => getComputedStyle(node).fontFamily)).toContain(
		'IBM Plex Sans'
	);
	expect(
		await page.evaluate(() =>
			Array.from(document.fonts).some(
				(font) => font.family.includes('IBM Plex Sans') && font.status === 'loaded'
			)
		)
	).toBe(true);

	expect(
		await page
			.locator('.inspector textarea.cfg-expr')
			.first()
			.evaluate((node) => getComputedStyle(node).fontFamily)
	).toContain('Consolas');
	await page.locator('.inspector').getByRole('tab', { name: 'Appearance', exact: true }).click();
	const control = page.getByRole('combobox', { name: 'orientation' });
	expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(32);
	expect(
		await widget.evaluate((node) => getComputedStyle(node).getPropertyValue('--np-font'))
	).toContain('Bahnschrift');
	for (const width of [1280, 1024]) {
		await page.setViewportSize({ width, height: 960 });
		expect(await control.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
		await openSection(page, 'settings');
		await expect(page.getByRole('button', { name: 'About', exact: true })).toBeVisible();
		await openSection(page, 'layouts');
		await page.locator('.inspector').getByRole('tab', { name: 'Appearance', exact: true }).click();
	}
	await page.evaluate(() => {
		document.documentElement.style.zoom = '1.25';
	});
	const zoomed = await control.boundingBox();
	expect(zoomed!.height).toBeGreaterThanOrEqual(40);
	expect(zoomed!.x + zoomed!.width).toBeLessThanOrEqual(1024);
	await page.evaluate(() => {
		document.documentElement.style.zoom = '';
	});
	expect(log.errors).toEqual([]);
});
