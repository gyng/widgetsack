import { test, expect } from '@playwright/test';
import { gotoStudio, previewTemplate, watchConsole, openSection } from './helpers';
test('Gaming preset keeps its media text and cover readable at the shipped size', async ({
	page
}) => {
	const log = watchConsole(page);
	await page.goto('/gallery/?presets');
	const media = page.locator('[data-shot="preset-gaming"] .np-nowplaying');
	await expect(media.locator('.np-title')).toHaveText('Midnight Drive');
	for (const selector of ['.np-title', '.np-artist']) {
		expect(
			await media.locator(selector).evaluate((node) => node.scrollWidth <= node.clientWidth)
		).toBe(true);
	}
	const cover = await media.locator('.np-thumb-stack').boundingBox();
	expect(cover!.height).toBeGreaterThan(30);
	expect(log.errors).toEqual([]);
});
test('new dashboard widgets preview and built-in sacks can be imported', async ({ page }) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	for (const name of [
		'Status / Alerts',
		'Service Health',
		'App Audio / Microphone',
		'Task Checklist',
		'Sensor History'
	]) {
		await previewTemplate(page, name);
		await expect(page.locator('.np-dashboard').first()).toBeVisible();
	}
	await openSection(page, 'sacks');
	const minimal = page.getByRole('button', { name: /Built-in: Minimal/ });
	await expect(minimal).toBeVisible();
	page.on('dialog', (dialog) => dialog.accept());
	await minimal.click();
	await expect(page.getByText(/Imported 1 widget/)).toBeVisible();
	await openSection(page, 'widget-designer');
	await expect(page.getByRole('button', { name: 'Minimal dashboard', exact: true })).toBeVisible();
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});

test('all dashboard sacks import and insert as a styled group', async ({ page }) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	page.on('dialog', (dialog) => dialog.accept());
	for (const name of ['Work', 'Gaming', 'Home', 'Minimal']) {
		await openSection(page, 'sacks');
		await page.getByRole('button', { name: new RegExp(`Built-in: ${name}`) }).click();
		await expect(page.getByText(/Imported 1 widget/)).toBeVisible();
		await openSection(page, 'layouts');
		const summary = page.locator('.inspector .add-panel > summary');
		await expect(summary).toBeVisible();
		if (!(await page.locator('.inspector .add-panel[open]').count())) await summary.click();
		await page
			.locator('.inspector')
			.getByRole('button', { name: `${name} dashboard`, exact: true })
			.click();
		await page.getByRole('button', { name: 'Zoom to content', exact: true }).click();
		const group = page
			.locator(`[data-group=""][data-def="dashboard-${name.toLowerCase()}"]`)
			.first();
		await expect(group).toBeVisible();
		await expect(group).toHaveCSS('border-radius', '14px');
		await expect(group).toHaveCSS('width', '392px');
		for (const control of await group.locator('.np-dashboard button, .np-dashboard input').all())
			await expect(control).toBeDisabled();
		await group.screenshot({ path: `test-results/dashboard-${name.toLowerCase()}.png` });
	}
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});

test('service warnings use theme colors and long errors stay inside the widget', async ({
	page
}) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	await page.addStyleTag({
		content: '.canvas { --np-warn: rgb(244, 180, 75); --np-danger: rgb(255, 80, 80); }'
	});
	await page.evaluate(() => {
		const internals = (
			window as unknown as {
				__TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
			}
		).__TAURI_INTERNALS__;
		const invoke = internals.invoke.bind(internals);
		internals.invoke = (command, args) => {
			if (command === 'check_service_health') {
				const down = (args as { url: string }).url.endsWith('/down');
				return Promise.resolve({
					status: down ? null : 302,
					latencyMs: 20,
					certificateDays: 60,
					error: down ? `Unavailable: ${'x'.repeat(300)}` : null
				});
			}
			return invoke(command, args);
		};
	});
	const summary = page.locator('.inspector .add-panel > summary');
	await expect(summary).toBeVisible();
	if (!(await page.locator('.inspector .add-panel[open]').count())) await summary.click();
	await page
		.locator('.palette')
		.filter({ has: page.locator('.hd2', { hasText: /^System$/ }) })
		.getByRole('button', { name: /^Service Health —/ })
		.click();
	const endpoint = page
		.locator('.inspector')
		.getByRole('textbox', { name: 'endpoint URL', exact: true });
	await endpoint.fill('https://home.example/health');
	const health = page.locator('.world [data-type="servicehealth"] .np-dashboard');
	await expect(health).toHaveAttribute('data-state', 'warning');
	await expect(health).toHaveCSS('color', 'rgb(244, 180, 75)');
	await endpoint.fill('https://home.example/down');
	await expect(health).toHaveAttribute('data-state', 'down');
	await expect(health).toHaveCSS('color', 'rgb(255, 80, 80)');
	expect(await health.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});
