import { test, expect } from '@playwright/test';
import { addWidget, gotoStudio } from './helpers';

// The clock-cluster TEMPLATE OPTIONS, end to end (the pure resolve/apply logic is unit-tested in
// core/templates.test.ts). In the Inspector's Templates palette the clock renders as an options card
// (TemplateOptionsForm): a <Select> per ParamSpec + an Insert button. Picking options then inserting
// must flow chosen → resolveTemplateOptions → applyParams onto the template tree → the insertTemplate
// op → live clock meters. The specs are the SAME ParamSpecs a def cloned from the template keeps.
//
// DOM order of the cluster's four clocks is time · weekday · date · month (see studio.spec.ts), so
// .np-clock .value .nth(0) is the time and .nth(1) is the weekday.

/** Pick one option on the clock card's `label` Select (a closed listbox), choosing the option whose
 * text contains `choice`. Only the opened menu is in the DOM, so the option locator is unambiguous. */
async function pickClockOption(
	page: import('@playwright/test').Page,
	label: string,
	choice: string
): Promise<void> {
	await page.getByRole('combobox', { name: `Clock (JP weekday) — ${label}` }).click();
	await page.locator('.np-select-option', { hasText: choice }).click();
}

test('clock template options: 12-hour + colon time format applies on insert', async ({ page }) => {
	await gotoStudio(page);

	// The Time select's choice VALUE is the dayjs format itself; '· 5:00 PM' is the 12-hour + colon one.
	await pickClockOption(page, 'Time', '5:00 PM');
	await page
		.locator('.tpl-opts')
		.filter({ hasText: 'Clock (JP weekday)' })
		.locator('.tpl-opts-insert')
		.click();

	// 12-hour + colon → "h:mm AM/PM" (vs the default 24-hour 4-digit "HHmm" with no separator).
	const time = page.locator('.np-clock .value').first();
	await expect(time).toHaveText(/^\d{1,2}:\d{2}\s(AM|PM)$/);
});

test('clock template options: English weekday applies on insert', async ({ page }) => {
	await gotoStudio(page);

	await pickClockOption(page, 'Weekday', 'English');
	await page
		.locator('.tpl-opts')
		.filter({ hasText: 'Clock (JP weekday)' })
		.locator('.tpl-opts-insert')
		.click();

	// The weekday clock (2nd, `ddd`) is an English short day now, not the default Japanese glyph (月…).
	const weekday = page.locator('.np-clock .value').nth(1);
	await expect(weekday).toHaveText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
});

test('System monitor and Network offer smooth charts on insertion', async ({ page }) => {
	await gotoStudio(page);
	await addWidget(page, 'Clock');
	const summary = page.locator('.inspector .add-panel > summary');
	for (const name of ['System monitor', 'Network']) {
		if (!(await page.locator('.inspector .add-panel[open]').count())) await summary.click();
		const option = page.getByRole('combobox', { name: `${name} — Smooth charts`, exact: true });
		await expect(option).toContainText('Off');
		await option.click();
		await page.getByRole('option', { name: 'On', exact: true }).click();
		await expect(option).toContainText('On');
		await page
			.locator('.tpl-opts')
			.filter({ has: page.locator('.tpl-opts-name', { hasText: name }) })
			.locator('.tpl-opts-insert')
			.click();
		await expect(page.locator('.inspector .node-hd')).toHaveText(name);
		await summary.click();
		const smooth = page.getByRole('checkbox', { name: 'Smooth charts', exact: true });
		await expect(smooth, name).toBeChecked();
		await smooth.uncheck();
		await expect(smooth).not.toBeChecked();
		await page.locator('.studio-bar button[title^="Undo"]').click();
		await expect(smooth).toBeChecked();
	}
	await page.screenshot({ path: 'test-results/studio-smooth-charts.png' });
	await addWidget(page, 'CPU');
	await expect(page.locator('.inspector .cfg-group-hd', { hasText: 'Appearance' })).toBeVisible();
	const cpuSmooth = page.getByRole('checkbox', { name: 'Smooth charts', exact: true });
	await expect(cpuSmooth).not.toBeChecked();
	await cpuSmooth.check();
	await expect(cpuSmooth).toBeChecked();
});
