import { expect, test } from '@playwright/test';
import { addWidget, gotoStudio, openSection } from './helpers';

test('one catalog shares favourites between Layout and Build', async ({ page }) => {
	await gotoStudio(page);
	const catalog = page.locator('.inspector .widget-catalog');
	await catalog.getByRole('button', { name: 'Add Clock to favourites', exact: true }).click();
	await openSection(page, 'widget-designer');
	const build = page.locator('.designer-list .widget-catalog');
	await build.getByRole('combobox', { name: 'Catalog section' }).click();
	await page.getByRole('option', { name: 'Favourites', exact: true }).click();
	const reading = build.getByRole('button', { name: /^Clock —/ });
	await expect(reading).toHaveCSS(
		'color',
		await build.evaluate((node) => getComputedStyle(node).color)
	);
	await expect(build.getByRole('button', { name: /^Clock —/ })).toBeVisible();
	await expect(build.getByRole('button', { name: /^Gauge —/ })).toHaveCount(0);
	await build.getByRole('button', { name: /^Clock —/ }).click();
	await expect(page.locator('.def-banner')).toContainText('Clock');
	await page.locator('.def-banner').getByRole('button', { name: 'Done', exact: true }).click();
});
test('editing a saved widget from Layout retains context and returns to its placement', async ({
	page
}) => {
	await gotoStudio(page);
	await addWidget(page, 'Clock');
	await page.getByRole('button', { name: 'Save as custom widget', exact: true }).click();
	const group = page.locator('.world .widget.selected[data-group]');
	const id = await group.getAttribute('data-id');
	await page.getByRole('button', { name: 'Edit shared widget…', exact: true }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Edit all linked copies' }).click();
	await expect(page.locator('.nav-rail [data-section="layouts"]')).toHaveAttribute(
		'aria-current',
		'page'
	);
	await expect(page.locator('.def-banner')).toContainText('Editing:');
	await expect(
		page.locator('.def-banner').getByRole('button', { name: 'Back to layout', exact: true })
	).toBeVisible();
	await page.locator('.def-banner').getByRole('button', { name: 'Done', exact: true }).click();
	await expect(page.locator('.def-banner')).toHaveCount(0);
	await expect(page.locator(`.world [data-group][data-id="${id}"]`)).toBeVisible();
	await expect(page.locator('.inspector [aria-label="Editing context"]')).toBeVisible();
});

test('starting points keep blank creation under Advanced and create from a working widget', async ({
	page
}) => {
	await gotoStudio(page);
	await openSection(page, 'widget-designer');
	await page.getByRole('button', { name: 'New custom widget', exact: true }).click();
	const start = page.getByRole('dialog', { name: 'Start a widget' });
	await expect(start.getByRole('button', { name: 'Create blank widget' })).not.toBeVisible();
	await start.getByRole('button', { name: 'Start with a built-in widget', exact: true }).click();
	const build = page.locator('.designer-list .widget-catalog');
	await expect(build.getByRole('combobox', { name: 'Catalog section' })).toContainText('Widgets');
	await build.getByRole('button', { name: /^Clock —/ }).click();
	await expect(page.locator('.def-banner')).toContainText('Clock');
	await expect(page.locator('.world .np-clock')).toBeVisible();
});

test('arrangement previews preserve the desktop until Apply and save the result as a reusable selection', async ({
	page
}) => {
	await gotoStudio(page);
	const first = await addWidget(page, 'Clock');
	const second = await addWidget(page, 'Bar');
	await first.click({ modifiers: ['Control'] });
	await expect(page.locator('.world .widget.selected')).toHaveCount(2);
	const readBox = (locator: import('@playwright/test').Locator) =>
		locator.evaluate((node) => ({
			x: parseFloat((node as HTMLElement).style.left),
			y: parseFloat((node as HTMLElement).style.top),
			w: parseFloat((node as HTMLElement).style.width)
		}));
	const before = await readBox(first);
	await page.getByRole('button', { name: 'Arrange…', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Arrange selection' });
	await dialog.getByRole('button', { name: 'Arrange in a row', exact: true }).click();
	await expect(dialog.getByRole('img', { name: 'After arrangement' })).toBeVisible();
	expect(await readBox(first)).toEqual(before);
	await dialog.getByRole('button', { name: 'Apply arrangement' }).click();
	const a = await readBox(first);
	const b = await readBox(second);
	expect(Math.abs(b.x - a.x - a.w - 8)).toBeLessThanOrEqual(1);
	expect(a.y).toBe(b.y);
	await page.keyboard.press('Control+z');
	expect(await readBox(first)).toEqual(before);
	await page.getByRole('button', { name: 'Save selection as widget' }).click();
	await expect(page.locator('.world .widget.selected[data-group]')).toBeVisible();
	await page.getByRole('tab', { name: 'Add', exact: true }).click();
	await page.locator('.inspector').getByRole('tab', { name: 'My widgets', exact: true }).click();
	await expect(
		page.locator('.inspector').getByRole('button', { name: 'Custom panel', exact: true })
	).toBeVisible();
});

test('Fit to content measures an intrinsic widget and remains undoable', async ({ page }) => {
	await gotoStudio(page);
	const clock = await addWidget(page, 'Clock');
	const width = await clock.evaluate((node) => parseFloat((node as HTMLElement).style.width));
	await page.getByRole('button', { name: 'Arrange…', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Arrange selection' });
	await dialog.getByRole('button', { name: 'Fit to content' }).click();
	await dialog.getByRole('button', { name: 'Apply arrangement' }).click();
	const fitted = await clock.evaluate((node) => parseFloat((node as HTMLElement).style.width));
	expect(fitted).toBeGreaterThan(20);
	expect(fitted).toBeLessThan(width);
	await page.keyboard.press('Control+z');
	await expect
		.poll(() => clock.evaluate((node) => parseFloat((node as HTMLElement).style.width)))
		.toBe(width);
});

test('usage is visible before shared editing and a placement-only edit keeps other copies linked', async ({
	page
}) => {
	const child = {
		id: 'clock',
		unit: {
			id: 'clock',
			type: 'clock',
			rect: { x: 0, y: 0, w: 140, h: 40 },
			config: { format: 'HH:mm' }
		}
	};
	const placed = (id: string) => ({
		id,
		unit: { id, kind: 'group', name: 'Shared clock', def: 'shared', size: { w: 140, h: 40 }, child }
	});
	const monitor = (ids: string[]) => ({
		root: { id: 'root', kind: 'col', gap: 8, align: 'start', children: ids.map(placed) },
		floating: []
	});
	const document = {
		version: 2,
		monitors: { default: monitor(['one', 'two']), other: monitor(['three']) },
		library: {
			version: 1,
			defs: [{ id: 'shared', name: 'Shared clock', size: { w: 140, h: 40 }, child }]
		}
	};
	await page.goto('/?mockLayout=' + encodeURIComponent(JSON.stringify(document)));
	await expect(page.locator('.canvas.studio.edit')).toBeVisible();
	await page.locator('.world [data-id="one"] .widget').click();
	await page.getByRole('tab', { name: 'Configure', exact: true }).click();
	await page.getByRole('button', { name: 'Edit shared widget…', exact: true }).click();
	const review = page.getByRole('dialog', { name: 'Edit Shared clock' });
	await expect(review.getByText('Used in 2 layouts · 3 placements', { exact: true })).toBeVisible();
	await review.getByRole('button', { name: 'Edit only this placement' }).click();
	await expect(page.locator('.def-banner')).toContainText('Shared clock copy');
	await page.locator('.world .widget').first().click();
	await page.getByRole('tab', { name: 'Configure', exact: true }).click();
	await page.locator('.inspector').getByLabel('format', { exact: true }).fill('HH');
	await page.locator('.def-banner').getByRole('button', { name: 'Done', exact: true }).click();
	await expect(page.locator('.world [data-id="one"]')).not.toHaveAttribute('data-def', 'shared');
	await expect(page.locator('.world [data-id="two"]')).toHaveAttribute('data-def', 'shared');
	await expect(page.locator('.world [data-id="one"] .np-clock .value')).toHaveText(/^\d{2}$/);
	await expect(page.locator('.world [data-id="two"] .np-clock .value')).toHaveText(/^\d{2}:\d{2}$/);
});
