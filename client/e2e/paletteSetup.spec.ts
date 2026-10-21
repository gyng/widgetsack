import { test, expect } from '@playwright/test';
import { addWidget, gotoStudio, openSection, watchConsole } from './helpers';

test('palette setup links open the matching integration and use vector icons', async ({ page }) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	await addWidget(page, 'Clock');
	await page.getByRole('tab', { name: 'Add', exact: true }).click();
	await expect(page.locator('.inspector .add-panel')).toHaveAttribute('open', '');
	await expect(page.locator('.nav-icon svg')).toHaveCount(9);
	for (const name of ['Home Assistant', 'AI Provider']) {
		await page.getByRole('button', { name: `Configure ${name}`, exact: true }).click();
		await expect(page.locator('.nav-item[data-section="plugins"]')).toHaveAttribute(
			'aria-current',
			'page'
		);
		await expect(page.locator('.pl-item.cur')).toContainText(name);
		await openSection(page, 'layouts');
		await page.getByRole('tab', { name: 'Add', exact: true }).click();
		await expect(page.locator('.inspector .add-panel')).toHaveAttribute('open', '');
	}
	await page.screenshot({ path: 'test-results/palette-setup-icons.png' });
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});

test('built-in local preset loads onto the selected monitor and discovers hardware', async ({
	page
}) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	page.on('dialog', (dialog) => dialog.accept());
	await openSection(page, 'saved-layouts');
	await expect(
		page.getByRole('button', { name: 'Delete saved layout Built-in: Local desktop' })
	).toHaveCount(0);
	await page.getByRole('button', { name: /Built-in: Local desktop/ }).click();
	await openSection(page, 'layouts');
	await page.getByRole('button', { name: 'Zoom to content', exact: true }).click();
	await expect(
		page.getByRole('img', { name: 'CPU per-core usage', exact: true }).first()
	).toBeVisible();
	await expect(page.locator('.np-monitorswitch').first()).toBeVisible();
	await expect(page.locator('.np-monitorswitch').first()).toContainText('DisplayPort');
	await expect(page.locator('.np-monitorswitch').first()).toContainText('HDMI');
	await page.screenshot({ path: 'test-results/local-desktop-preset.png' });
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});
