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
	let largestOwnGap = 0;
	for (const reading of await readings.all()) {
		const graph = reading.locator('.text-sparkline');
		await expect(graph).toBeVisible();
		await expect(graph).toHaveCSS('margin-inline-start', '2px');
		await expect(graph).toHaveCSS('flex-grow', '1');
		boxes.push((await reading.boundingBox())!);
		const colour = await reading.evaluate((e) => getComputedStyle(e).color);
		await expect(graph.locator('.np-sparkline')).toHaveCSS('color', colour);
		await expect(graph).toHaveCSS(
			'font-size',
			await reading.locator('.value').evaluate((el) => getComputedStyle(el).fontSize)
		);
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
			const glyphEnd = await reading.locator('.value').evaluate((el) => {
				const range = document.createRange();
				range.selectNodeContents(el);
				return range.getBoundingClientRect().right;
			});
			largestOwnGap = Math.max(largestOwnGap, next.x - glyphEnd);
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
	const scale = boxes[0].width / (await readings.first().evaluate((el) => el.clientWidth));
	const groupGap = boxes[1].x - boxes[0].x - boxes[0].width;
	expect(groupGap / scale).toBeCloseTo(48, 0);
	expect(groupGap).toBeGreaterThan(largestOwnGap);
});

test('system inline uses fixed number columns even for one and three digit readings', async ({
	page
}) => {
	await gotoStudio(page);
	await previewTemplate(page, 'System monitor · Inline');
	const readings = page.locator('.world .np-text');
	await expect(readings).toHaveCount(5);
	await expect(page.locator('.world .text-sparkline')).toHaveCount(5);
	// At 100% the chart must stop at the digit cap, not the taller font em box.
	// A baseline marker and real font metrics keep this independent of installed fonts/zoom.
	for (const size of [16, 20]) {
		for (const reading of await readings.all()) {
			const bounds = await reading.evaluate((row, fontSize) => {
				(row as HTMLElement).style.setProperty('--np-text-body', `${fontSize}px`);
				const value = row.querySelector('.value')!;
				value.textContent = '100';
				const marker = document.createElement('span');
				marker.style.cssText = 'display:inline-block;width:0;height:0';
				value.append(marker);
				const baseline = marker.getBoundingClientRect().bottom;
				marker.remove();
				const canvas = document.createElement('canvas');
				const ctx = canvas.getContext('2d')!;
				const style = getComputedStyle(value);
				ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
				const digits = ctx.measureText('100');
				const graph = row.querySelector('.text-sparkline')!.getBoundingClientRect();
				const scale = row.getBoundingClientRect().width / (row as HTMLElement).offsetWidth;
				return {
					top: graph.top,
					bottom: graph.bottom,
					baseline,
					cap: digits.actualBoundingBoxAscent * scale
				};
			}, size);
			expect(bounds.top).toBeGreaterThanOrEqual(bounds.baseline - bounds.cap - 1);
			expect(Math.abs(bounds.bottom - bounds.baseline)).toBeLessThan(1);
		}
	}
	const offsets = await readings.evaluateAll((rows) =>
		rows.map((row, i) => {
			const value = row.querySelector('.value')!;
			value.textContent = i % 2 ? '100' : '1';
			const cell = row.getBoundingClientRect(),
				number = value.getBoundingClientRect();
			const spark = row.querySelector('.text-sparkline')!.getBoundingClientRect();
			const scale = cell.width / (row as HTMLElement).offsetWidth;
			if (spark.left - number.right < 6 * scale - 1)
				throw Error('Number and sparkline need a visible six-pixel separation');
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
	await page.locator('.inspector').getByRole('tab', { name: 'Appearance', exact: true }).click();
	await page.getByLabel('show sparkline', { exact: true }).check();
	await expect(graph).toBeVisible();
	await page.getByLabel('sparkline width', { exact: true }).fill('24');
	await expect(graph).toHaveCSS('width', '24px');
	await page.getByLabel('show sparkline', { exact: true }).uncheck();
	await expect(graph).toHaveCount(0);
	await expect(widget.locator('.value')).not.toBeEmpty();
});
