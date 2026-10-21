import { expect, test } from '@playwright/test';
import { gotoStudio, openSection } from './helpers';

test('Custom uses catalog sample tooltips and styled creation actions', async ({ page }) => {
	await gotoStudio(page);
	await openSection(page, 'widget-designer');
	const create = page.getByRole('button', { name: 'Create a custom widget', exact: true });
	const toolbar = page.getByRole('button', { name: 'New custom widget', exact: true });
	for (const property of [
		'background-color',
		'border-top-color',
		'border-radius',
		'font-family',
		'min-height'
	])
		await expect(create).toHaveCSS(
			property,
			await toolbar.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property)
		);
	const network = page
		.locator('.designer-list')
		.getByRole('button', { name: 'Network', exact: true });
	await expect(network).not.toHaveAttribute('title');
	await network.hover();
	const tooltip = page.getByRole('tooltip');
	await expect(tooltip.locator('.pp-name')).toHaveText('Network');
	await expect(tooltip.locator('.pp-stage')).toBeVisible();
	await expect(tooltip).toContainText('Sample preview');
	await expect(tooltip).toHaveCSS(
		'font-family',
		await toolbar.evaluate((el) => getComputedStyle(el).fontFamily)
	);
	const bounds = (await tooltip.boundingBox())!;
	expect(bounds.x).toBeGreaterThanOrEqual((await network.boundingBox())!.x);
	expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
	await page.keyboard.press('Escape');
	await expect(tooltip).toHaveCount(0);
	await network.focus();
	await expect(tooltip).toBeVisible();
	await network.click();
	await expect(tooltip).toHaveCount(0);
	await expect(page.locator('.def-banner')).toContainText('Previewing: Network');
});

test('navigation labels and bottom status geometry remain stable across Settings', async ({
	page
}) => {
	await gotoStudio(page);
	const settings = page.locator('.nav-rail [data-section="settings"]');
	const before = (await settings.boundingBox())!;
	for (const label of await page.locator('.nav-rail .nav-short').all())
		expect(
			await label.evaluate((el) => el.scrollWidth <= el.clientWidth),
			(await label.textContent()) ?? ''
		).toBe(true);
	await openSection(page, 'settings');
	await expect(page.locator('.powerbar')).toBeVisible();
	const after = (await settings.boundingBox())!;
	expect(after.y).toBe(before.y);
	expect(after.height).toBe(before.height);
});

test('My widgets shares catalog previews and remembers the card view', async ({ page }) => {
	await gotoStudio(page);
	await openSection(page, 'widget-designer');
	const list = page.locator('.designer-list');
	await list.getByRole('button', { name: 'Use Network template', exact: true }).click();
	await list.getByRole('textbox', { name: 'Custom widget name' }).fill('Desk traffic');
	await page.keyboard.press('Tab');
	await page.locator('.def-banner').getByRole('button', { name: 'Done', exact: true }).click();
	const saved = list.getByRole('button', { name: 'Desk traffic', exact: true });
	await saved.hover();
	await expect(page.getByRole('tooltip').locator('.pp-name')).toHaveText('Desk traffic');
	await list.getByRole('button', { name: 'Previews', exact: true }).click();
	const section = list
		.locator('.palette-section')
		.filter({ has: page.getByRole('button', { name: 'Desk traffic', exact: true }) });
	await expect(section.locator('.catalog-preview')).toBeVisible();
	await expect(
		section.getByRole('button', { name: 'Rename Desk traffic', exact: true })
	).toBeVisible();
	await expect(
		section.getByRole('button', { name: 'Duplicate Desk traffic', exact: true })
	).toBeVisible();
	await expect(
		section.getByRole('button', { name: 'Delete Desk traffic', exact: true })
	).toBeVisible();
	await list.getByRole('button', { name: 'List', exact: true }).click();
	await expect(list.locator('.catalog-preview')).toHaveCount(0);
	const savedRow = list
		.locator('.dl-item')
		.filter({ has: page.getByRole('button', { name: 'Desk traffic', exact: true }) });
	await savedRow.scrollIntoViewIfNeeded();
	await savedRow.hover();
	const name = await savedRow
		.getByRole('button', { name: 'Desk traffic', exact: true })
		.boundingBox();
	const actions = await savedRow.locator('.dl-icon').all();
	expect((await savedRow.boundingBox())!.height).toBeLessThanOrEqual(36);
	for (const action of actions) {
		const bounds = (await action.boundingBox())!;
		expect(Math.abs(bounds.y + bounds.height / 2 - name!.y - name!.height / 2)).toBeLessThanOrEqual(
			1
		);
	}
	await list.getByRole('button', { name: 'Previews', exact: true }).click();
	await page.reload();
	await openSection(page, 'widget-designer');
	await expect(list.getByRole('button', { name: 'Previews', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
});
