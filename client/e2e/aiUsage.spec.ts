import { test, expect } from '@playwright/test';
import { addWidget, gotoStudio, previewTemplate, watchConsole } from './helpers';
test('AI Usage defaults to Codex and Claude and exposes provider options', async ({ page }) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	const widget = await addWidget(page, 'AI Usage');
	const meter = widget.locator('.np-ai-usage');
	const editor = page.locator('.usage-providers-editor');
	await expect(meter.getByRole('region', { name: 'Codex usage' })).toBeVisible();
	await expect(meter).toContainText('58%');
	await expect(meter.locator('[data-provider-icon="claude"]')).toBeVisible();
	await expect(meter.locator('[data-provider-icon="codex"]')).toBeVisible();
	const icon = editor
		.getByRole('group', { name: 'Codex', exact: true })
		.getByLabel('Icon', { exact: true });
	await icon.selectOption('deepseek');
	await expect(meter.locator('[data-provider-icon="deepseek"]')).toBeVisible();
	await icon.selectOption('auto');
	await expect(meter.locator('[data-provider-icon="codex"]')).toHaveCSS(
		'background-color',
		'rgb(255, 255, 255)'
	);
	await page.getByLabel('provider icons', { exact: true }).uncheck();
	await expect(meter.getByRole('region', { name: 'Codex usage' })).toContainText('Codex');
	await page.getByLabel('provider icons', { exact: true }).check();
	await expect(meter.locator('header')).toHaveCount(0);
	await expect(meter).toHaveCSS('font-size', '14px');
	await expect(meter.locator('.usage-value-mode').first()).toHaveCSS('font-size', '12px');
	await editor
		.getByRole('group', { name: 'Codex', exact: true })
		.getByLabel('Rate / ETA', { exact: true })
		.check();
	await expect(meter.locator('.usage-inline-rate').first()).toHaveCSS('font-size', '12px');
	expect((await meter.locator('.usage-inline-rate').first().boundingBox())!.width).toBeLessThan(85);
	await expect(meter.locator('.usage-inline-rate .usage-item-caption')).toHaveCount(0);
	await editor
		.getByRole('group', { name: 'Codex', exact: true })
		.getByRole('button', { name: 'Settings for Codex week' })
		.click();
	await page
		.getByRole('group', { name: 'Codex week settings' })
		.getByRole('combobox', { name: 'Display', exact: true })
		.selectOption('used');
	await expect(meter).toContainText('42%');
	await page
		.getByRole('group', { name: 'Codex week settings' })
		.getByRole('combobox', { name: 'Display', exact: true })
		.selectOption('left');
	await expect(meter).toContainText('58%');
	await page.getByLabel('compact layout', { exact: true }).uncheck();
	await expect(editor.getByRole('group', { name: 'Codex', exact: true })).toBeVisible();
	await editor
		.getByRole('group', { name: 'Codex', exact: true })
		.getByLabel('Label', { exact: true })
		.fill('Work Codex');
	await expect(meter).toContainText('Work Codex');
	await editor
		.getByRole('group', { name: 'Work Codex', exact: true })
		.getByLabel('Graph', { exact: true })
		.check();
	await expect(meter).toContainText('No tokens readings available');
	await expect(meter).toHaveCSS('scrollbar-width', 'thin');
	await expect(meter).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});

test('compact and detailed presets remain centered and use theme-native transparent surfaces', async ({
	page
}) => {
	await gotoStudio(page);
	for (const name of [
		'Minimal quotas',
		'Compact quotas',
		'Detailed activity',
		'Remaining allowance'
	]) {
		await previewTemplate(page, `AI Usage · ${name}`);
		const meter = page.locator('.world .np-ai-usage');
		await expect(meter).toBeVisible();
		await expect(meter).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		if (name !== 'Detailed activity') {
			await expect(meter.locator('.usage-compact-row')).toHaveCount(2);
			expect(await meter.evaluate((e) => e.scrollHeight)).toBeLessThanOrEqual(44);
		}
		const rect = await meter.boundingBox();
		const stage = await page.locator('.canvas').boundingBox();
		expect(Math.abs(rect!.x + rect!.width / 2 - (stage!.x + stage!.width / 2))).toBeLessThan(3);
		await page.screenshot({
			path: `test-results/ai-usage-${name.toLowerCase().replaceAll(' ', '-')}.png`
		});
	}
});

test('quota columns align one and three digit percentages in every density', async ({ page }) => {
	await page.route('**/src/lib/devMock.ts', async (route) => {
		const response = await route.fetch();
		const body = (await response.text()).replace(
			/used:\s*42,/,
			'used: args.request.source === "codex" ? 99 : 0,'
		);
		await route.fulfill({ response, body });
	});
	await gotoStudio(page);
	for (const name of ['Minimal quotas', 'Compact quotas', 'Detailed activity']) {
		await previewTemplate(page, `AI Usage · ${name}`);
		const meter = page.locator('.world .np-ai-usage');
		const values = [];
		for (const provider of ['Codex', 'Claude']) {
			const region = meter.getByRole('region', { name: `${provider} usage` });
			const value = region
				.locator(
					name === 'Detailed activity'
						? '.usage-metric .usage-row > strong'
						: '.usage-inline-metric[data-kind="quota"] > b'
				)
				.first();
			await expect(value).toHaveText(
				`${provider === 'Codex' ? '1%' : '100%'}${name === 'Detailed activity' ? ' left' : ''}`
			);
			values.push((await value.boundingBox())!);
		}
		expect(Math.abs(values[0].x + values[0].width - values[1].x - values[1].width)).toBeLessThan(1);
	}
});

test('selected readings reorder independently and reset countdowns can be toggled', async ({
	page
}) => {
	await gotoStudio(page);
	const widget = await addWidget(page, 'AI Usage');
	const meter = widget.locator('.np-ai-usage');
	const codex = page
		.locator('.usage-providers-editor')
		.getByRole('group', { name: 'Codex', exact: true });
	const positions = await codex
		.locator('.usage-reading-order li')
		.evaluateAll((rows) =>
			rows.map((row) => [...row.children].map((child) => child.getBoundingClientRect().x))
		);
	for (const row of positions)
		for (let column = 0; column < 4; column++)
			expect(Math.abs(row[column] - positions[0][column])).toBeLessThan(1);
	await codex.getByLabel('Codex week label override', { exact: true }).fill('Wk');
	await expect(meter.getByRole('region', { name: 'Codex usage' })).toContainText('Wk');
	await codex.getByLabel('Tokens', { exact: true }).check();
	await codex.getByRole('button', { name: 'Move Codex tokens earlier', exact: true }).click();
	await codex.getByRole('button', { name: 'Move Codex tokens earlier', exact: true }).click();
	const region = meter.getByRole('region', { name: 'Codex usage' });
	await expect(region.locator('.usage-inline-metric').first()).toContainText('Tok');
	await expect(region).toContainText('1.25M');
	await expect(region).not.toContainText('1.25M tokens');
	await codex.getByRole('button', { name: 'Move Codex banked earlier', exact: true }).click();
	await codex.getByRole('button', { name: 'Move Codex banked earlier', exact: true }).click();
	await codex.getByRole('button', { name: 'Move Codex banked earlier', exact: true }).click();
	const bank = await region.getByTitle('Banked resets', { exact: true }).boundingBox();
	const tokens = await region.locator('[data-kind="tokens"]').boundingBox();
	expect(bank!.x).toBeLessThan(tokens!.x);
	await codex.getByLabel('Resets in', { exact: true }).check();
	await expect(region.locator('.usage-reset-short')).toHaveText(/\d+[hdw]/);
	await codex.getByLabel('Resets in', { exact: true }).uncheck();
	await expect(region.locator('.usage-reset-short')).toHaveCount(0);
});
