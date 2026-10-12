import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';

test('agenda remains readable in a narrow widget and scrolls to later events', async ({ page }) => {
	const log = watchConsole(page);
	// The unrelated iframe demo is sandboxed; keep Vite's injected scripts out of it.
	await page.route('**/gallery/iframe-demo.html', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<p>Embedded page</p>' })
	);
	await page.goto('/gallery/');
	const agenda = page.locator('[data-shot="widget-agenda"] .agenda');
	await expect(agenda.locator('.ag-location').first()).toHaveText('Room 2');
	await expect(agenda.locator('.ag-when').filter({ hasText: 'All day' }).first()).toBeVisible();
	await agenda.evaluate((node) => {
		node.style.width = '180px';
		node.style.height = '150px';
	});
	const list = agenda.getByRole('list', { name: 'Upcoming events' });
	expect(await list.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
	expect(await list.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
	await list.focus();
	await page.keyboard.press('End');
	await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
	expect(log.errors).toEqual([]);
});
