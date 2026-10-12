import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';

test('calendar weekday headers align with dates and today stays legible on weekends', async ({
	page
}) => {
	const log = watchConsole(page);
	await page.route('**/gallery/iframe-demo.html', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<p>Embedded page</p>' })
	);
	await page.goto('/gallery/');
	const calendar = page.locator('[data-shot="widget-calendar"] .calendar');
	await expect(calendar.locator('.cal-today')).toHaveCount(1);
	for (const width of [220, 180]) {
		await calendar.evaluate((node, size) => {
			node.style.width = `${size}px`;
		}, width);
		const columns = await calendar.evaluate((node) => {
			const centers = (selector: string) =>
				Array.from(node.querySelectorAll(selector), (cell) => {
					const rect = cell.getBoundingClientRect();
					return rect.x + rect.width / 2;
				});
			return { headers: centers('.cal-wd') };
		});
		const firstWeek = calendar.locator('.cal-row:not(.cal-head)').first();
		const cells = await firstWeek.locator('.cal-day').evaluateAll((nodes) =>
			nodes.map((node) => {
				const rect = node.getBoundingClientRect();
				return rect.x + rect.width / 2;
			})
		);
		for (let i = 0; i < 7; i++) expect(cells[i]).toBeCloseTo(columns.headers[i], 1);
		expect(await calendar.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
		const cell = await calendar.locator('.cal-today').boundingBox();
		const marker = await calendar.locator('.cal-today .cal-number').boundingBox();
		expect(marker!.x + marker!.width / 2).toBeCloseTo(cell!.x + cell!.width / 2, 1);
		expect(marker!.y + marker!.height / 2).toBeCloseTo(cell!.y + cell!.height / 2, 1);
	}
	await calendar.locator('.cal-today').evaluate((node) => node.classList.add('cal-weekend'));
	const todayColor = await calendar
		.locator('.cal-today .cal-number')
		.evaluate((node) => getComputedStyle(node).color);
	const weekendColor = await calendar
		.locator('.cal-weekend:not(.cal-out):not(.cal-today) .cal-number')
		.first()
		.evaluate((node) => getComputedStyle(node).color);
	expect(todayColor).not.toBe(weekendColor);
	expect(log.errors).toEqual([]);
});
