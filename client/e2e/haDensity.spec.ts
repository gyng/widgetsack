import { expect, test } from '@playwright/test';

test('Home Assistant and ticker text follow every density and controls stay inside authored boxes', async ({
	page
}) => {
	await page.goto('/gallery/?density');
	for (const [density, body, caption, target] of [
		['compact', 14, 12, 28],
		['comfortable', 16, 14, 32],
		['large', 20, 18, 44]
	] as const) {
		const section = page.locator(`[data-density="${density}"]`);
		await expect(section.locator('.density-meter')).toHaveCount(17);
		for (const frame of await section.locator('.density-meter').all()) {
			const scene = (await frame.getAttribute('data-meter')) === 'scene';
			const label = frame.locator('[data-part="label"]').first();
			if (await label.count())
				await expect(label).toHaveCSS('font-size', `${scene ? body : caption}px`);
			const outside = await frame.evaluate((el) => {
				const box = el.getBoundingClientRect();
				return Array.from(
					el.querySelectorAll('button,input,select,[data-part="label"],[data-part="value"]')
				)
					.filter((node) => {
						const r = node.getBoundingClientRect();
						return (
							r.width > 0 &&
							(r.x < box.x - 1 ||
								r.y < box.y - 1 ||
								r.right > box.right + 1 ||
								r.bottom > box.bottom + 1)
						);
					})
					.map((node) => `${node.className}: ${node.textContent?.slice(0, 30)}`);
			});
			expect(outside, `${density}/${await frame.getAttribute('data-meter')} overflow`).toEqual([]);
		}
		await expect(section.locator('.np-ticker-state')).toHaveCSS('font-size', `${caption}px`);
		await expect(section.locator('.np-ticker-symbol')).toHaveCSS('font-size', `${body}px`);
		await expect(section.locator('.np-ticker-spark canvas')).toBeVisible();
		await expect(section.locator('.ha-tile-notice')).toHaveCSS('font-size', `${caption}px`);
		for (const button of await section
			.locator(
				'.ha-fan-osc,.ha-climate-btn,.ha-cover-btns button,.hi-toggle,.hi-press,.ha-media-tx button'
			)
			.all()) {
			expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(target);
		}
	}
});

test('explicit typography overrides remain available after selecting a density', async ({
	page
}) => {
	await page.goto('/gallery/?density');
	const sensor = page.locator('[data-density="large"] [data-meter="sensor"]');
	await sensor.evaluate((el) => (el as HTMLElement).style.setProperty('--ha-caption-size', '15px'));
	await expect(sensor.locator('.label')).toHaveCSS('font-size', '15px');
	const ticker = page.locator('[data-density="large"] [data-meter="ticker"]');
	await ticker.evaluate((el) =>
		(el as HTMLElement).style.setProperty('--ticker-price-size', '30px')
	);
	await expect(ticker.locator('.np-ticker-price')).toHaveCSS('font-size', '30px');
});
