import { test, expect } from '@playwright/test';
import { watchConsole, gotoStudio, addWidget } from './helpers';

test('dial timer previews the setting, starts on release, and returns toward zero', async ({
	page
}) => {
	const log = watchConsole(page);
	await page.route('**/gallery/iframe-demo.html', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<p>Embedded page</p>' })
	);
	await page.goto('/gallery/');
	const timer = page.locator('[data-shot="widget-timer-dial"]');
	const dial = timer.getByRole('slider', { name: 'Timer duration' });
	await expect(dial).toBeVisible();
	await dial.scrollIntoViewIfNeeded();
	await page.clock.install();
	const box = await dial.boundingBox();
	expect(Math.abs(box!.width - box!.height)).toBeLessThan(1);
	const x = box!.x + box!.width / 2,
		y = box!.y + 8;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await expect(timer.locator('[data-part="value"]')).toHaveText('30:00');
	await page.clock.runFor(1000);
	await expect(timer.locator('[data-part="value"]')).toHaveText('30:00');
	await page.mouse.up();
	await expect(timer.getByRole('button', { name: 'Pause' })).toBeVisible();
	await page.clock.runFor(1000);
	await expect(timer.locator('[data-part="value"]')).toHaveText('29:59');
	await timer.getByRole('button', { name: 'Pause' }).click();
	await page.clock.runFor(2000);
	await expect(timer.locator('[data-part="value"]')).toHaveText('29:59');
	await timer.getByRole('button', { name: 'Reset' }).click();
	await expect(timer.locator('[data-part="value"]')).toHaveText('00:00');
	expect(log.errors).toEqual([]);
});

test('timer style is selectable in the studio and design gestures cannot start it', async ({
	page
}) => {
	await gotoStudio(page);
	const timer = await addWidget(page, 'Timer');
	await expect(timer.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
	await expect(timer.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
	await page.locator('.inspector').getByRole('tab', { name: 'Appearance', exact: true }).click();
	await page.getByRole('combobox', { name: 'style', exact: true }).click();
	await page.locator('.np-select-option', { hasText: /^dial$/ }).click();
	await expect(timer.locator('.timer-dial')).toBeVisible();
	await expect(timer.getByRole('slider')).toHaveAttribute('aria-disabled', 'true');
});
