import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';

test('agenda times and names align on the Dentist row and rows with locations', async ({
	page
}) => {
	await page.goto('/gallery/');
	for (const shot of ['widget-agenda', 'preset-work', 'preset-home']) {
		const agenda = page.locator(`[data-shot="${shot}"] .agenda`);
		await expect(agenda.getByText('Dentist', { exact: true })).toBeAttached();
		const rows = await agenda.locator('.ag-event').evaluateAll((nodes) =>
			nodes.map((node) => {
				const time = node.querySelector('.ag-when')!.getBoundingClientRect();
				const name = node.querySelector('.ag-summary')!.getBoundingClientRect();
				return { timeY: time.y, nameY: name.y, nameX: name.x };
			})
		);
		for (const row of rows) {
			expect(Math.abs(row.timeY - row.nameY)).toBeLessThan(0.5);
			expect(row.nameX).toBeCloseTo(rows[0].nameX, 1);
		}
		if (shot.startsWith('preset-')) {
			expect(rows).toHaveLength(2);
			expect(
				await agenda.locator('.ag-list').evaluate((node) => node.scrollHeight <= node.clientHeight)
			).toBe(true);
		}
	}
});

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
