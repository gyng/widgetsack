import { expect, test } from '@playwright/test';
import { gotoStudio, openSection } from './helpers';

test('Settings navigation and shortcuts stay readable beside Assistant', async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 768 });
	await gotoStudio(page);
	await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
	await openSection(page, 'settings');
	const panel = page.locator('.settings-panel');
	await panel.getByRole('button', { name: 'Shortcuts', exact: true }).click();
	await expect(panel.locator('.controls-panel')).toBeVisible();
	expect(await panel.locator('.pl-list').evaluate((el) => el.clientWidth)).toBeLessThanOrEqual(200);
	expect(
		await panel.locator('.controls-panel').evaluate((el) => el.scrollWidth <= el.clientWidth)
	).toBe(true);
	await expect(panel.locator('.pl-title')).toHaveCSS('text-transform', 'none');
	await expect(panel.getByRole('button', { name: 'Danger zone', exact: true })).toHaveCSS(
		'display',
		'flex'
	);
});

test('MCP setup uses the same tabs, cards and controls in Settings and Your agent', async ({
	page
}) => {
	await gotoStudio(page);
	await openSection(page, 'settings');
	await page
		.locator('.settings-panel .pl-list')
		.getByRole('button', { name: 'MCP', exact: true })
		.click();
	const settings = page.locator('.settings-panel .mcp-settings');
	await expect(settings.getByLabel('MCP client configuration')).not.toBeVisible();
	await settings.getByRole('tab', { name: 'Manual setup', exact: true }).click();
	await expect(settings.getByLabel('MCP client configuration')).toBeVisible();
	await expect(settings.getByRole('button', { name: 'Copy setup prompt' })).not.toBeVisible();
	await settings.getByRole('tab', { name: 'Setup prompt', exact: true }).click();
	await expect(settings.getByRole('tab', { name: 'Setup prompt', exact: true })).toHaveCSS(
		'border-bottom-width',
		'2px'
	);
	await expect(settings.locator('.mcp-setup')).toHaveCSS('border-radius', '6px');
	await expect(settings.getByRole('button', { name: 'Copy setup prompt' })).toHaveCSS(
		'border-radius',
		'4px'
	);
	await page.getByRole('button', { name: 'Studio AI assistant', exact: true }).click();
	const agent = page.locator('.studio-assistant .mcp-settings');
	await expect(agent.getByRole('tab', { name: 'Setup prompt', exact: true })).toHaveCSS(
		'border-bottom-color',
		await settings
			.getByRole('tab', { name: 'Setup prompt', exact: true })
			.evaluate((el) => getComputedStyle(el).borderBottomColor)
	);
});

test('shell controls follow the shared control radius and remain inside a narrow title bar', async ({
	page
}) => {
	await page.setViewportSize({ width: 980, height: 680 });
	await gotoStudio(page);
	const shell = page.locator('.studio-bar:not(.studio-subbar)');
	await expect(shell.getByRole('button', { name: 'Menu', exact: true })).toHaveCSS(
		'border-radius',
		'4px'
	);
	for (const button of await shell.getByRole('button').all()) {
		if (!(await button.isVisible())) continue;
		const box = await button.boundingBox();
		expect(box!.height).toBeGreaterThanOrEqual(32);
		expect(box!.x + box!.width).toBeLessThanOrEqual(980);
	}
});

test('remaining panes share heading and form sizing at narrow and wide widths', async ({
	page
}) => {
	test.setTimeout(60_000);
	await gotoStudio(page);
	await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
	for (const width of [1024, 1600]) {
		await page.setViewportSize({ width, height: 900 });
		for (const [section, heading] of [
			['sensors', 'Sensors & live values'],
			['themes', 'Themes'],
			['background', 'Background'],
			['sacks', 'Share'],
			['saved-layouts', 'Saved layouts']
		]) {
			await openSection(page, section);
			const panel = page.locator('.rail-panel');
			await expect(panel.getByRole('heading', { name: heading, exact: true })).toHaveCSS(
				'font-size',
				'20px'
			);
			expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
			if (section === 'sacks') {
				await expect(panel.getByLabel('Sack name')).toHaveAttribute('aria-invalid', 'false');
				await expect(panel.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
			}
			if (['background', 'sacks', 'saved-layouts'].includes(section)) {
				const form = panel.locator('form, .bg-field').first();
				expect((await form.boundingBox())!.width).toBeLessThanOrEqual(640);
			}
		}
	}
});

test('all integration settings fit beside Assistant and identify their selected page', async ({
	page
}) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1024, height: 768 });
	await gotoStudio(page);
	await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
	await openSection(page, 'plugins');
	const panel = page.locator('.plugins-panel');
	for (const name of [
		'Home Assistant',
		'Now Playing',
		'MQTT',
		'Stocks',
		'Weather',
		'RSS',
		'Agenda',
		'AI Provider'
	]) {
		const choose = panel.locator('.pl-list').getByRole('button', { name, exact: true });
		await choose.click();
		await expect(choose).toHaveAttribute('aria-current', 'page');
		await expect(panel.getByRole('heading', { name, exact: true })).toHaveCSS(
			'text-transform',
			'none'
		);
		expect(
			await panel.locator('.pl-detail').evaluate((el) => el.scrollWidth <= el.clientWidth)
		).toBe(true);
		for (const input of await panel
			.locator('.pl-detail input[type="text"], .pl-detail input[type="password"]')
			.all()) {
			await expect(input).toHaveCSS('font-size', '14px');
		}
	}
});

test('Settings stays readable at 125 percent zoom with a light theme', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 960 });
	await gotoStudio(page);
	await openSection(page, 'themes');
	await page.locator('.theme-row', { hasText: 'Solarized Light' }).click();
	await page.getByRole('button', { name: 'Studio AI assistant', exact: true }).click();
	await openSection(page, 'settings');
	await page.evaluate(() => {
		document.documentElement.style.zoom = '1.25';
	});
	const panel = page.locator('.settings-panel');
	await panel.getByRole('button', { name: 'Shortcuts', exact: true }).click();
	expect(
		await panel.locator('.controls-panel').evaluate((el) => el.scrollWidth <= el.clientWidth)
	).toBe(true);
	await panel.locator('.pl-list').getByRole('button', { name: 'MCP', exact: true }).click();
	const setup = panel.locator('.mcp-settings');
	await expect(setup.getByRole('button', { name: 'Copy setup prompt' })).toBeVisible();
	await expect(setup.getByLabel('MCP client configuration')).not.toBeVisible();
	const contrast = await panel.evaluate((el) => {
		const luminance = (color: string) => {
			const channels = color
				.match(/[\d.]+/g)!
				.slice(0, 3)
				.map(Number)
				.map((value) => {
					const channel = value / 255;
					return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
				});
			return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
		};
		const text = luminance(getComputedStyle(el.querySelector('.pl-title')!).color);
		const background = luminance(getComputedStyle(el).backgroundColor);
		return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
	});
	expect(contrast).toBeGreaterThanOrEqual(4.5);
	await page.screenshot({ path: 'test-results/studio-light-zoom-settings.png' });
});
