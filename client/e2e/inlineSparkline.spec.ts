import { test, expect } from '@playwright/test';
import { addWidget, gotoStudio, previewTemplate } from './helpers';

test('inline network places download then upload on one row with matching value and chart colours', async ({
	page
}) => {
	await gotoStudio(page);
	await previewTemplate(page, 'Network · Inline');
	const readings = page.locator('.world .np-text');
	await expect(readings).toHaveCount(2);
	await expect(readings.first().locator('.label')).toHaveText('▼');
	await expect(readings.last().locator('.label')).toHaveText('▲');
	const boxes = [];
	for (const reading of await readings.all()) {
		const graph = reading.locator('.text-sparkline');
		await expect(graph).toBeVisible();
		await expect(graph).toHaveCSS('flex-grow', '1');
		boxes.push((await reading.boundingBox())!);
		const colour = await reading.evaluate((e) => getComputedStyle(e).color);
		await expect(graph.locator('.np-sparkline')).toHaveCSS('color', colour);
		const value = (await reading.locator('.value').boundingBox())!;
		const spark = (await graph.boundingBox())!;
		const arrow = (await reading.locator('.label').boundingBox())!;
		expect(value.x - arrow.x - arrow.width).toBeLessThan(10);
		await expect(reading.locator('.value')).toHaveCSS('text-align', 'left');
		for (const text of ['0K/s', '<1K/s', '1024K/s', '1.0M/s', '24M/s', '1000M/s']) {
			await reading.locator('.value').evaluate((el, value) => {
				el.textContent = value;
			}, text);
			const next = (await graph.boundingBox())!;
			expect(Math.abs(next.x - spark.x)).toBeLessThan(1);
			expect(Math.abs(next.width - spark.width)).toBeLessThan(1);
		}
		const baseline = await reading.locator('.value').evaluate((el) => {
			const marker = document.createElement('span');
			marker.style.cssText = 'display:inline-block;width:0;height:0';
			el.append(marker);
			const y = marker.getBoundingClientRect().bottom;
			marker.remove();
			return y;
		});
		expect(Math.abs(spark.y + spark.height - baseline)).toBeLessThan(1);
		expect(spark.x).toBeGreaterThanOrEqual(value.x + value.width - 1);
		expect(spark.x + spark.width).toBeLessThanOrEqual(boxes.at(-1)!.x + boxes.at(-1)!.width + 1);
		expect(Math.abs(spark.x + spark.width - boxes.at(-1)!.x - boxes.at(-1)!.width)).toBeLessThan(1);
	}
	expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(1);
});

test('system inline uses fixed number columns even for one and three digit readings', async ({
	page
}) => {
	await gotoStudio(page);
	await previewTemplate(page, 'System monitor · Inline');
	const readings = page.locator('.world .np-text');
	await expect(readings).toHaveCount(5);
	await expect(page.locator('.world .text-sparkline')).toHaveCount(5);
	const offsets = await readings.evaluateAll((rows) =>
		rows.map((row, i) => {
			const value = row.querySelector('.value')!;
			value.textContent = i % 2 ? '100' : '1';
			const cell = row.getBoundingClientRect(),
				number = value.getBoundingClientRect();
			const spark = row.querySelector('.text-sparkline')!.getBoundingClientRect();
			if (number.right > spark.left || spark.right > cell.right + 1)
				throw Error('Number and sparkline columns overlap or clip');
			return number.right - cell.left;
		})
	);
	for (const offset of offsets) expect(Math.abs(offset - offsets[0])).toBeLessThan(1);
});

test('text sparkline can be switched on, resized and hidden in the inspector', async ({ page }) => {
	await gotoStudio(page);
	const widget = await addWidget(page, 'Text');
	const graph = widget.locator('.text-sparkline');
	await expect(graph).toHaveCount(0);
	await page.getByLabel('show sparkline', { exact: true }).check();
	await expect(graph).toBeVisible();
	await page.getByLabel('sparkline width', { exact: true }).fill('24');
	await expect(graph).toHaveCSS('width', '24px');
	await page.getByLabel('show sparkline', { exact: true }).uncheck();
	await expect(graph).toHaveCount(0);
	await expect(widget.locator('.value')).not.toBeEmpty();
});
