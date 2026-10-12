import { test, expect } from '@playwright/test';
import { gotoStudio, previewTemplate, watchConsole } from './helpers';
test('tool widgets are discoverable and preview without executing commands', async ({ page }) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	await previewTemplate(page, 'AI Assistant');
	await expect(page.locator('.np-ai-chat')).toBeVisible();
	await expect(page.locator('.np-ai-chat')).toContainText('Configure it in Settings');
	await page.screenshot({ path: 'test-results/ai-assistant-preview.png' });
	await previewTemplate(page, 'CLI Command');
	await expect(page.locator('.np-command')).toBeVisible();
	await expect(
		page.locator('.np-command').getByRole('button', { name: 'Run', exact: true })
	).toBeDisabled();
	const list = page.locator('.designer-list');
	await expect(list).toHaveCSS('scrollbar-width', 'thin');
	await page.screenshot({ path: 'test-results/cli-command-preview.png' });
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});

test('CLI template accepts a command without running it on insertion', async ({ page }) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	await page.getByRole('textbox', { name: 'CLI Command — PowerShell command' }).fill('Get-Date');
	await page
		.locator('.tpl-opts')
		.filter({ hasText: 'CLI Command' })
		.getByRole('button', { name: '＋ Insert', exact: true })
		.click();
	await expect(page.locator('.np-command code')).toHaveText('Get-Date');
	await expect(page.locator('.np-command')).not.toContainText('Mock command output');
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});
