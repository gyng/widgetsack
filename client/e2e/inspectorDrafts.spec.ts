import { test, expect, type Page } from '@playwright/test';
import { addWidget, gotoStudio } from './helpers';

// Inspector commit-on-blur fields must not lose a draft when the selection moves: the stage selects
// on pointerdown, before the field blurs, which used to remount the CSS editor (dropping the draft)
// or reset the config JSON box to the NEW widget's config before its blur committed.

const moveHandle = (page: Page, name: string) =>
	page.getByRole('button', { name: `Move ${name} widget`, exact: true });

test('a config JSON draft lands on its own widget when another widget is selected', async ({
	page
}) => {
	await gotoStudio(page);
	await addWidget(page, 'Text');
	await page.locator('.inspector').getByRole('tab', { name: 'Layout', exact: true }).click();
	// Park it clear of the button's resize handles so the stage click below lands on it.
	for (const [field, value] of [
		['x', '900'],
		['y', '600'],
		['w', '300'],
		['h', '200']
	]) {
		await page.getByRole('spinbutton', { name: field, exact: true }).fill(value);
		await page.getByRole('spinbutton', { name: field, exact: true }).press('Enter');
	}
	await moveHandle(page, 'button').click();
	await page.locator('.inspector').getByRole('tab', { name: 'Appearance', exact: true }).click();
	await page.getByText('Advanced — config JSON / CSS').click();
	const json = page.getByRole('textbox', { name: /config \(JSON\)/ });
	await json.fill('{ "label": "draft-for-button" }');

	// Select the Text widget straight from the stage (pointerdown selects before the box blurs).
	await page.locator('.widget[data-type="text"] button.drag-overlay').click();
	await expect(json).not.toHaveValue(/draft-for-button/);

	await moveHandle(page, 'button').click();
	await expect(json).toHaveValue(/"label": "draft-for-button"/);
});

test('Escape in an Inspector text field keeps the selection', async ({ page }) => {
	await gotoStudio(page);
	await moveHandle(page, 'button').click();
	await page.locator('.inspector').getByRole('tab', { name: 'Appearance', exact: true }).click();
	await page.getByText('Advanced — config JSON / CSS').click();
	await page.getByRole('textbox', { name: /config \(JSON\)/ }).focus();
	await page.keyboard.press('Escape');
	await expect(page.locator('.widget.selected')).toHaveCount(1);
	// Outside a text field Escape still deselects.
	await page.getByRole('textbox', { name: /config \(JSON\)/ }).blur();
	await page.keyboard.press('Escape');
	await expect(page.locator('.widget.selected')).toHaveCount(0);
});
