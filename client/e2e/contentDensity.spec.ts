import { expect, test } from '@playwright/test';

const captions = [
	'.cal-wd',
	'.gpu-name',
	'.gpu-stat-label',
	'.disk-meta',
	'.tp-label',
	'.pw-status',
	'.nc-title',
	'.nc-summary',
	'.wf-detail',
	'.rb-size',
	'.cd-label',
	'.cd-sub',
	'.timer-label',
	'.dial-hint',
	'.wx-cond',
	'.wx-hilo',
	'.wx-detail',
	'.wx-day-label',
	'.wx-day-hilo',
	'.sm-moon-illum',
	'.aq-title',
	'.aq-detail',
	'.rss-title',
	'.ag-title',
	'.assistant-label',
	'.transcribe-label',
	'.transcribe-source'
];
const bodies = [
	'.cal-day',
	'.gpu-stat-val',
	'.disk-label',
	'.tp-name',
	'.pw-name',
	'.nc-row',
	'.ping-host',
	'.wf-ssid',
	'.rb-count',
	'.note-area',
	'.sm-time',
	'.sm-moon-name',
	'.aq-band',
	'.rss-row',
	'.ag-row',
	'.assistant-text',
	'.transcribe-text'
];

test('content widgets use readable body and caption roles at every density', async ({ page }) => {
	await page.goto('/gallery/?content-density');
	for (const [density, body, caption, target] of [
		['compact', 14, 12, 28],
		['comfortable', 16, 14, 32],
		['large', 20, 18, 44]
	] as const) {
		const section = page.locator(`[data-density="${density}"]`);
		await expect(section.locator('.content-density-meter')).toHaveCount(20);
		// Wait for the seeded subscriptions, then measure every text role in two browser calls.
		await expect(section.locator('.disk-meta').first()).toBeAttached();
		await expect(section.locator('.rss-row').first()).toBeAttached();
		for (const [selectors, size] of [
			[captions, caption],
			[bodies, body]
		] as const) {
			const roles = await section.evaluate(
				(root, selectors) =>
					selectors.map((selector) => ({
						selector,
						fonts: [
							...new Set(
								Array.from(root.querySelectorAll(selector), (el) => getComputedStyle(el).fontSize)
							)
						]
					})),
				selectors
			);
			for (const role of roles)
				expect(role.fonts, `${density} ${role.selector}`).toEqual([`${size}px`]);
		}
		for (const button of await section
			.locator('.timer-btn,.assistant-refresh,.transcribe-mic')
			.all()) {
			const box = (await button.boundingBox())!;
			expect(box.width).toBeGreaterThanOrEqual(target);
			expect(box.height).toBeGreaterThanOrEqual(target);
		}
		for (const frame of await section.locator('.content-density-meter').all()) {
			const overflow = await frame.evaluate((el) => {
				const box = el.getBoundingClientRect();
				return Array.from(
					el.querySelectorAll(
						'button,textarea,.gpu-name,.gpu-util-val,.cal-title,.cal-wd,.cal-number,.wx-main,.wx-hilo,.wx-detail,.wx-forecast,.aq-detail'
					)
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
					.map((node) => node.className);
			});
			expect(overflow, `${density}/${await frame.getAttribute('data-meter')} clips`).toEqual([]);
		}
	}
});

test('dense lists scroll complete rows and local typography overrides keep precedence', async ({
	page
}) => {
	await page.goto('/gallery/?content-density');
	const section = page.locator('[data-density="large"]');
	for (const selector of ['.gpu-stats', '.nc-list', '.rss-list', '.ag-list']) {
		const list = section.locator(selector);
		await expect(list).toHaveCSS('overflow-y', 'auto');
		await list.evaluate((el) => {
			el.parentElement!.style.height = '100px';
			el.scrollTop = el.scrollHeight;
		});
		expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
	}
	const overrides = [
		['calendar', '--cal-wd-size', '.cal-wd'],
		['gpu', '--gpu-stat-label-size', '.gpu-stat-label'],
		['weather', '--wx-detail-size', '.wx-detail'],
		['note', '--note-size', '.note-area']
	];
	for (const [meter, variable, selector] of overrides) {
		const frame = section.locator(`[data-meter="${meter}"]`);
		await frame.evaluate(
			(el, variable) => (el as HTMLElement).style.setProperty(variable, '15px'),
			variable
		);
		await expect(frame.locator(selector).first()).toHaveCSS('font-size', '15px');
	}
	const air = section.locator('.airquality');
	await air.evaluate((el) =>
		(el as HTMLElement).style.setProperty('--aq-fair', 'rgb(120, 180, 140)')
	);
	await expect(air.locator('.aq-band')).toHaveCSS('color', 'rgb(120, 180, 140)');
	await air.evaluate((el) =>
		(el as HTMLElement).style.setProperty('--aq-accent', 'rgb(100, 150, 210)')
	);
	await expect(air.locator('.aq-band')).toHaveCSS('color', 'rgb(100, 150, 210)');
	const mic = section.locator('.transcribe-mic');
	await mic.focus();
	await expect(mic).toHaveCSS('outline-style', 'solid');
});
