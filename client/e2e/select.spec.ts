import { test, expect } from '@playwright/test';
import { gotoStudio, addWidget } from './helpers';

// The shared <Select> control in a real browser: the sensor typeahead (filter / pick / free-text) and a
// small closed listbox select. The unit tests cover the logic in happy-dom; these prove the Downshift
// keyboard/portal/typeahead actually work against a real layout + the studio wiring.
//
// NB: a freshly added Gauge starts with its meta defaultSensor (cpu.total), so we filter on 'battery'
// (distinct from the default) and replace the field with fill() to make assertions unambiguous.

test('sensor field is a typeahead: typing filters the options', async ({ page }) => {
	await gotoStudio(page);
	await addWidget(page, 'Gauge');
	const sensor = page.getByRole('combobox', { name: 'sensor' });
	await sensor.fill('battery'); // replaces the default sensor and drives the filter
	const options = page.locator('.np-select-menu .np-select-option');
	// poll until the filter settles: a non-empty menu where every option matches the query
	await expect
		.poll(async () => {
			const texts = await options.allTextContents();
			return texts.length > 0 && texts.every((t) => /battery/i.test(t));
		})
		.toBe(true);
});

test('picking a sensor option binds it to the widget', async ({ page }) => {
	await gotoStudio(page);
	const gauge = await addWidget(page, 'Gauge');
	const sensor = page.getByRole('combobox', { name: 'sensor' });
	await sensor.fill('battery'); // filter away from the cpu.total default
	await page.locator('.np-select-menu .np-select-option').first().click();
	await expect(gauge).toHaveAttribute('data-sensor', /^battery\./);
});

test('sensor field is keyboard-driven (type → ArrowDown → Enter)', async ({ page }) => {
	await gotoStudio(page);
	const gauge = await addWidget(page, 'Gauge');
	const sensor = page.getByRole('combobox', { name: 'sensor' });
	await sensor.fill('battery'); // replace the default + open the filtered menu
	await page.keyboard.press('ArrowDown'); // highlight the first match
	await page.keyboard.press('Enter'); // commit it via keyboard
	await expect(gauge).toHaveAttribute('data-sensor', /^battery\./);
});

test('sensor field accepts a free-typed custom id (allowCustom commits once, on Enter / blur)', async ({
	page
}) => {
	await gotoStudio(page);
	const gauge = await addWidget(page, 'Gauge');
	const sensor = page.getByRole('combobox', { name: 'sensor' });
	await sensor.fill('my.custom.metric');
	// Typing alone holds the text (one change per id, not per keystroke); Enter commits it.
	await expect(gauge).not.toHaveAttribute('data-sensor', 'my.custom.metric');
	await sensor.press('Enter');
	await expect(gauge).toHaveAttribute('data-sensor', 'my.custom.metric');
});

test('a closed listbox select (Bar orientation) opens and applies the choice', async ({ page }) => {
	await gotoStudio(page);
	const bar = await addWidget(page, 'Bar');
	const orient = page.getByRole('combobox', { name: 'orientation' });
	const before = ((await orient.textContent()) ?? '').trim();
	const target = before === 'vertical' ? 'horizontal' : 'vertical';
	await orient.click();
	await page.locator('.np-select-option', { hasText: target }).click();
	await expect(bar.locator('.np-bar')).toHaveClass(new RegExp(target));
});
