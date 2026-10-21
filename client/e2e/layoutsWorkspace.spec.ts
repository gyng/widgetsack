import { test, expect } from '@playwright/test';
import { gotoStudio, addWidget } from './helpers';

test('Custom templates become named reusable widgets and preserve browsing state', async ({
	page
}) => {
	await gotoStudio(page);
	await page.locator('[data-section="widget-designer"]').click();
	const list = page.locator('.designer-list');
	const templates = list
		.locator('.palette-section')
		.filter({ has: page.locator('summary', { hasText: /^Templates/ }) });
	await templates.locator(':scope > summary').click();
	await expect(templates).not.toHaveAttribute('open');
	const search = list.getByRole('searchbox');
	await search.fill('Network');
	await expect(templates).toHaveAttribute('open');
	await list.getByRole('button', { name: 'Network', exact: true }).click();
	await expect(page.locator('.def-banner')).toContainText('read-only');
	await list.getByRole('button', { name: 'Use Network template', exact: true }).click();
	const name = list.getByRole('textbox', { name: 'Custom widget name' });
	await name.fill('Desk traffic');
	await name.press('Tab');
	await expect(page.locator('.def-banner')).toContainText('Desk traffic');
	await page.locator('.def-banner').getByRole('button', { name: 'Done', exact: true }).click();
	await search.fill('');
	await expect(templates).not.toHaveAttribute('open');
	await expect(list.getByRole('button', { name: 'Desk traffic', exact: true })).toBeVisible();
	await page.locator('[data-section="layouts"]').click();
	await page.getByRole('tab', { name: 'My widgets', exact: true }).click();
	await page
		.locator('.inspector')
		.getByRole('button', { name: /^Desk traffic/ })
		.click();
	const meters = page.locator('.widget[data-def]');
	const beforeUndo = await meters.count();
	await expect(page.locator('.widget.selected')).toHaveCount(4);
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(meters).toHaveCount(beforeUndo - 4);
});

test('Custom editing hides monitor navigation and keeps the definition banner clear', async ({
	page
}) => {
	await page.setViewportSize({ width: 1024, height: 768 });
	await gotoStudio(page);
	await page.locator('[data-section="widget-designer"]').click();
	await page.getByRole('button', { name: /New custom widget/ }).click();
	await page.getByRole('dialog').getByText('Advanced', { exact: true }).click();
	await page.getByRole('button', { name: 'Create blank widget' }).click();
	await expect(page.locator('.def-banner')).toContainText('Editing');
	await expect(page.getByRole('combobox', { name: 'Canvas monitor', exact: true })).toHaveCount(0);
	const banner = await page.locator('.def-banner').boundingBox();
	const toolbar = await page.locator('.studio-subbar').boundingBox();
	expect(banner!.y).toBeGreaterThanOrEqual(toolbar!.y + toolbar!.height);
	expect(banner!.width).toBeLessThan(480);
});

test('compact Layouts keeps canvas tools visible and swaps properties for Assistant', async ({
	page
}) => {
	await page.setViewportSize({ width: 980, height: 680 });
	await gotoStudio(page);
	const tools = page.locator('.studio-subbar');
	await expect(tools.getByRole('button', { name: 'Fit', exact: true })).toBeVisible();
	expect(await tools.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
	await page.getByRole('button', { name: 'Studio AI assistant', exact: true }).click();
	await expect(page.locator('.studio-assistant')).toBeVisible();
	expect((await page.locator('.canvas.studio').boundingBox())!.width).toBeGreaterThanOrEqual(400);
	await expect(page.locator('.inspector .detail-tabs')).not.toBeVisible();
	await tools.getByRole('button', { name: 'Canvas options' }).click();
	await expect(page.getByLabel('into grids', { exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
});

test('catalog stays docked, remembers collapsed sections and keeps search visible', async ({
	page
}) => {
	await gotoStudio(page);
	const catalog = page.locator('.inspector .add-panel');
	await expect(catalog).toHaveAttribute('open', '');
	const section = catalog.locator('.palette-section').first();
	const summary = section.locator(':scope > summary');
	await expect(summary).toHaveText(/.+ \(\d+\)/);
	const heading = await summary.textContent();
	await summary.click();
	await expect(section).not.toHaveAttribute('open');
	await page.reload();
	await expect(page.locator('.canvas.studio.edit')).toBeVisible();
	await expect(section).not.toHaveAttribute('open');
	await catalog.getByLabel('Filter the add palette').fill('Gauge');
	await expect(section).toHaveAttribute('open', '');
	await expect(catalog.getByRole('button', { name: /^Gauge —/ })).toBeVisible();
	await catalog.getByLabel('Filter the add palette').fill('');
	await expect(summary).toHaveText(heading!);
	await expect(section).not.toHaveAttribute('open');
	await summary.click();
	await expect(section).toHaveAttribute('open', '');
	await catalog.getByRole('tab', { name: 'Templates', exact: true }).click();
	await expect(catalog.getByRole('button', { name: /^AI Usage · Compact quotas/ })).toBeVisible();
	await catalog.getByRole('tab', { name: 'Widgets', exact: true }).click();
	await page.locator('.inspector').evaluate((el) => {
		el.scrollTop = 250;
	});
	const sticky = await catalog.locator('.catalog-tools').boundingBox();
	const rail = await page.locator('.inspector').boundingBox();
	expect(sticky!.y).toBeGreaterThanOrEqual(rail!.y - 1);
	await expect(catalog.getByLabel('Filter the add palette')).toBeInViewport();
});

test('properties separate content, layout and appearance without losing field edits', async ({
	page
}) => {
	await gotoStudio(page);
	await addWidget(page, 'AI Usage');
	const inspector = page.locator('.inspector');
	await expect(inspector.getByRole('tab', { name: 'Content', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(inspector.getByLabel('w', { exact: true })).not.toBeVisible();
	await expect(
		inspector.getByText('PowerShell command override', { exact: true }).first()
	).not.toBeVisible();
	await inspector.getByRole('tab', { name: 'Appearance', exact: true }).click();
	await expect(inspector.getByRole('combobox', { name: 'layout', exact: true })).toBeVisible();
	await inspector.getByRole('tab', { name: 'Layout', exact: true }).click();
	await expect(inspector.getByLabel('w', { exact: true })).toBeVisible();
	await inspector.getByRole('tab', { name: 'Advanced', exact: true }).click();
	await expect(inspector.getByLabel('Node JSON')).toBeVisible();
});

test('preview tiles adapt from two to three columns, remember their view and keep insertion repeatable', async ({
	page
}) => {
	await gotoStudio(page);
	const pane = page.locator('.inspector');
	const grid = pane.locator('.palette:has(>.catalog-widget-item)').first();
	await pane.getByRole('button', { name: 'Previews', exact: true }).click();
	await expect(grid.locator('.catalog-preview [data-preview]').first()).toBeVisible();
	expect(
		await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
	).toBe(2);
	const tiles = grid.locator('>.catalog-widget-item');
	const first = await tiles.first().boundingBox();
	const second = await tiles.nth(1).boundingBox();
	expect(Math.abs(first!.width - second!.width)).toBeLessThan(1);
	await page.setViewportSize({ width: 1600, height: 1000 });
	const divider = await page.locator('.pane-resize.right').boundingBox();
	await page.mouse.move(divider!.x + divider!.width / 2, divider!.y + 100);
	await page.mouse.down();
	await page.mouse.move(900, divider!.y + 100, { steps: 8 });
	await page.mouse.up();
	await expect
		.poll(() => grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length))
		.toBe(3);
	expect((await page.locator('.canvas.studio').boundingBox())!.width).toBeGreaterThanOrEqual(400);
	await page.reload();
	await expect(pane.getByRole('button', { name: 'Previews', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await pane.getByRole('tab', { name: 'Templates', exact: true }).click();
	await expect(pane.locator('.catalog-preview [data-preview]').first()).toBeVisible();
	const optionCard = pane.locator('.template-options-card').first();
	const templateGrid = pane.locator('.palette').first();
	expect((await optionCard.boundingBox())!.width).toBeLessThan(
		(await templateGrid.boundingBox())!.width * 0.5
	);
	const simpleCard = pane.locator('.libitem').filter({ hasText: 'AI Chat' });
	expect((await simpleCard.boundingBox())!.height).toBeLessThan(230);
	expect(
		await pane
			.locator('.palette')
			.first()
			.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
	).toBe(3);
	await pane.getByRole('tab', { name: 'My widgets', exact: true }).click();
	await expect(pane.getByText(/No saved widgets yet/)).toBeVisible();
	await pane.getByRole('tab', { name: 'Widgets', exact: true }).click();
	await pane.getByRole('button', { name: /^Clock —/ }).click();
	await expect(page.getByRole('tab', { name: 'Add', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(pane.getByRole('button', { name: /^Clock —/ })).toBeVisible();
	await page.locator('.widget.selected button.drag-overlay').click();
	await expect(page.getByRole('tab', { name: 'Configure', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
});

test('canvas monitor picker mirrors the main picker and keeps its menu in the viewport', async ({
	page
}) => {
	await page.setViewportSize({ width: 980, height: 680 });
	await gotoStudio(page);
	const main = page.getByRole('combobox', { name: 'Monitor', exact: true });
	const secondary = page.getByRole('combobox', { name: 'Canvas monitor', exact: true });
	await expect(secondary).toContainText('Mock-1920');
	expect((await secondary.textContent())!.trim()).toBe((await main.textContent())!.trim());
	await secondary.click();
	const menu = page.locator('.np-select-menu:visible');
	const bounds = await menu.boundingBox();
	expect(bounds!.x).toBeGreaterThanOrEqual(0);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(980);
	expect(await menu.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	await expect(menu.getByRole('option').first()).toContainText('1920×1080');
	await page.keyboard.press('Escape');
});

test('Templates and My widgets share the Widgets card spacing in list and preview views', async ({
	page
}) => {
	const def = {
		id: 'desk-clock',
		name: 'Desk clock with a deliberately long reusable widget name',
		size: { w: 240, h: 80 },
		child: {
			id: 'clock',
			unit: { id: 'clock', type: 'clock', rect: { x: 0, y: 0, w: 240, h: 80 }, config: {} }
		}
	};
	await page.goto(
		'/?mockLayout=' +
			encodeURIComponent(
				JSON.stringify({
					version: 2,
					monitors: { default: { root: { id: 'root', kind: 'col', children: [] }, floating: [] } },
					library: { version: 1, defs: [def] }
				})
			)
	);
	const pane = page.locator('.inspector');
	const metrics = (button: import('@playwright/test').Locator) =>
		button.evaluate((el) => {
			const style = getComputedStyle(el);
			return {
				padding: style.padding,
				font: style.fontSize,
				line: style.lineHeight,
				align: style.textAlign
			};
		});
	for (const view of ['List', 'Previews']) {
		await pane.getByRole('tab', { name: 'Widgets', exact: true }).click();
		await pane.getByRole('button', { name: view, exact: true }).click();
		const reference = await metrics(pane.locator('.catalog-widget-item > button').first());
		await pane.getByRole('tab', { name: 'Templates', exact: true }).click();
		expect(await metrics(pane.locator('.libitem > button').first())).toEqual(reference);
		await pane.getByRole('tab', { name: 'My widgets', exact: true }).click();
		const insert = pane.getByRole('button', { name: def.name, exact: true });
		expect(await metrics(insert)).toEqual(reference);
		const item = pane.locator('.libitem');
		expect(await item.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		expect((await item.boundingBox())!.width).toBeLessThan((await pane.boundingBox())!.width * 0.6);
		await expect(
			pane.getByRole('button', { name: `Delete ${def.name} from My widgets` })
		).toBeVisible();
	}
});
