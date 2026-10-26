import { test, expect } from '@playwright/test';
import { gotoStudio, openSection } from './helpers';

test('On desktop is opt-in and survives a Studio reload', async ({ page }) => {
	await gotoStudio(page);
	await openSection(page, 'settings');
	await page.locator('.settings-panel .pl-item', { hasText: 'Overlay', exact: true }).click();
	await expect(page.locator('.set-status')).toContainText('Current layer: Below windows');
	await page.getByLabel('Window layer', { exact: true }).click();
	await page.getByRole('option', { name: 'On desktop', exact: true }).click();
	await expect(page.locator('.set-status')).toContainText('Current layer: On desktop');
	expect(
		await page.evaluate(
			() => JSON.parse(localStorage.getItem('widgetsack.overlay.prefs')!).overlayLayer
		)
	).toBe('desktop');
	await page.reload();
	await expect(page.locator('.canvas.studio.edit')).toBeVisible();
	await openSection(page, 'settings');
	await page.locator('.settings-panel .pl-item', { hasText: 'Overlay', exact: true }).click();
	await expect(page.getByLabel('Window layer', { exact: true })).toContainText('On desktop');
});
