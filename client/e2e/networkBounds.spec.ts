import { test, expect } from '@playwright/test';
import { gotoStudio, previewTemplate } from './helpers';

test('Network preview fits the stage on all four sides, including its rate row', async ({
	page
}) => {
	await gotoStudio(page);
	await previewTemplate(page, 'Network');
	await expect(page.locator('.np-text')).toHaveCount(2);
	// The mock has no network samples. Put wide formatted readings into the real rendered meters
	// to check the text itself, rather than only their fixed-size slots.
	await page.locator('.np-text .value').evaluateAll((values) => {
		values[0].textContent = '1023.9 TiB/s';
		values[1].textContent = '1023.9 TiB/s';
	});
	const bounds = await page.evaluate(() => {
		const stage = document.querySelector('.canvas.studio.designing')?.getBoundingClientRect();
		const frame = document.querySelector('.monitor-frame')?.getBoundingClientRect();
		const rates = [...document.querySelectorAll('.np-text')].map((meter) => {
			const range = document.createRange();
			range.selectNodeContents(meter);
			return range.getBoundingClientRect();
		});
		if (!stage || !frame || rates.length !== 2) throw new Error('Network preview is incomplete');
		return {
			stage: { left: stage.left, right: stage.right, top: stage.top, bottom: stage.bottom },
			frame: { left: frame.left, right: frame.right, top: frame.top, bottom: frame.bottom },
			rates: rates.map((r) => ({ left: r.left, right: r.right, bottom: r.bottom }))
		};
	});
	expect(bounds.frame.left).toBeGreaterThanOrEqual(bounds.stage.left + 1);
	expect(bounds.frame.right).toBeLessThanOrEqual(bounds.stage.right - 1);
	expect(bounds.frame.top).toBeGreaterThanOrEqual(bounds.stage.top + 1);
	expect(bounds.frame.bottom).toBeLessThanOrEqual(bounds.stage.bottom - 1);
	for (const rate of bounds.rates) {
		expect(rate.left).toBeGreaterThanOrEqual(bounds.frame.left - 1);
		expect(rate.right).toBeLessThanOrEqual(bounds.frame.right + 1);
		expect(rate.bottom).toBeLessThanOrEqual(bounds.frame.bottom + 1);
	}
});
