import { test, expect } from '@playwright/test';
import { gotoStudio, openSection, addWidget } from './helpers';
import { designPresetTokens, type DesignDensity } from '../src/lib/core/designPresets';

test('inherited widgets and shared tool controls follow every density', async ({ page }) => {
	await gotoStudio(page);
	for (const [name, selector, role] of [
		['Calendar', '.calendar', 'body'],
		['Battery', '.bat-pct', 'body'],
		['Audio Switcher', '.as-title', 'caption'],
		['Monitor Switch', '.ms-title', 'caption'],
		['Volume', '.vol-pct', 'caption'],
		['CLI Command', '.np-tool-widget', 'body']
	]) {
		const widget = await addWidget(page, name);
		for (const [density, body, caption, control] of [
			['compact', '14px', '12px', '28px'],
			['comfortable', '16px', '14px', '32px'],
			['large', '20px', '18px', '44px']
		]) {
			await widget.evaluate(
				(el, tokens) => {
					for (const [key, value] of Object.entries(tokens)) el.style.setProperty(key, value);
				},
				designPresetTokens('transparent', density as DesignDensity)
			);
			await expect(widget.locator(selector)).toHaveCSS(
				'font-size',
				role === 'body' ? body : caption
			);
			if (name === 'CLI Command') {
				await expect(widget.locator('.np-tool-widget button')).toHaveCSS('min-height', control);
				await expect(widget.locator(selector)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			}
		}
		if (name === 'Volume') {
			await widget.evaluate((el) => el.style.setProperty('--vol-pct-size', '22px'));
			await expect(widget.locator(selector)).toHaveCSS('font-size', '22px');
		}
		if (name === 'CLI Command') {
			await widget.evaluate(
				(el, tokens) => {
					for (const [key, value] of Object.entries(tokens)) el.style.setProperty(key, value);
				},
				designPresetTokens('soft', 'large')
			);
			await expect(widget).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(widget.locator(selector)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		}
	}
});

test('design presets apply to global or widget tokens in one undoable edit', async ({ page }) => {
	await gotoStudio(page);
	await openSection(page, 'themes');
	const rootBody = () =>
		page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue('--np-text-body').trim()
		);
	const original = await rootBody();
	await page.getByRole('combobox', { name: 'Design style', exact: true }).click();
	await page.locator('.np-select-menu').getByRole('option', { name: 'Soft', exact: true }).click();
	await page.getByRole('button', { name: 'Apply design preset', exact: true }).click();
	await expect.poll(rootBody).toBe('20px');
	await page.keyboard.press('Control+z');
	await expect.poll(rootBody).toBe(original);
	const widget = await addWidget(page, 'Text');
	await page.locator('.inspector').getByRole('tab', { name: 'Appearance', exact: true }).click();
	await page.locator('.inspector details.tokens > summary').click();
	await page.getByRole('combobox', { name: 'Design density', exact: true }).click();
	await page
		.locator('.np-select-menu')
		.getByRole('option', { name: 'Comfortable', exact: true })
		.click();
	await page.getByRole('button', { name: 'Apply design preset', exact: true }).click();
	await expect(widget).toHaveCSS('--np-text-body', '16px');
	expect(await rootBody()).toBe(original);
	await page.keyboard.press('Control+z');
	await expect(widget).toHaveCSS('--np-text-body', original);
});

test('presentation presets affect one placement or the layout without changing reusable definitions', async ({
	page
}) => {
	await gotoStudio(page);
	await addWidget(page, 'Clock');
	await page.getByRole('button', { name: 'Save as custom widget', exact: true }).click();
	const group = page.locator('.world .widget.selected[data-group]');
	const groupId = await group.getAttribute('data-id');
	await page.locator('.inspector').getByRole('tab', { name: 'Appearance', exact: true }).click();
	await page.locator('.inspector details.tokens > summary').click();
	const options = page.getByRole('group', { name: 'Widget presentation' });
	await options.getByRole('button', { name: /Minimal/ }).click();
	await page.getByRole('button', { name: 'Apply design preset', exact: true }).click();
	await expect(group).toHaveCSS('--np-presentation-mode', 'minimal');
	await page.keyboard.press('Control+z');
	await expect(group).not.toHaveCSS('--np-presentation-mode', 'minimal');
	await openSection(page, 'themes');
	await page
		.getByRole('group', { name: 'Widget presentation' })
		.getByRole('button', { name: /Detailed/ })
		.click();
	await page.getByRole('button', { name: 'Apply design preset', exact: true }).click();
	await expect(page.locator(`.world [data-id="${groupId}"][data-group]`)).toHaveCSS(
		'--np-presentation-mode',
		'detailed'
	);
	await page.keyboard.press('Control+z');
	await expect(page.locator(`.world [data-id="${groupId}"][data-group]`)).not.toHaveCSS(
		'--np-presentation-mode',
		'detailed'
	);
});
