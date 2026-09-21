import { test, expect, type Page } from '@playwright/test';
import { addWidget, gotoStudio, navItem, openSection, watchConsole } from './helpers';

// UX round 1: the sticky add target, first-free-spot placement + the just-added flash, the Text
// placeholder, the empty-stage card + first-run strip, per-section error boundaries, the
// corrupt-layout banner, the inline sack export, the theme-editor dirty check, Ctrl+9 and
// zoom-to-content. Geometry / flow behaviour that happy-dom can't prove lives here.

// A v2 widgets.json with an EMPTY primary monitor (the boot seed is the demo layout otherwise).
const EMPTY_LAYOUT = JSON.stringify({
	version: 2,
	monitors: {
		default: { root: { id: 'root', kind: 'col', children: [], align: 'stretch' }, floating: [] }
	}
});

async function gotoStudioWithLayout(page: Page, layout: string): Promise<void> {
	await page.goto(`/?mockLayout=${encodeURIComponent(layout)}`);
	await expect(page.locator('.canvas.studio.edit')).toBeVisible();
}

test('sticky add target: Outline "+ Row" → Gauge, Bar, Text all land in the row', async ({
	page
}) => {
	await gotoStudioWithLayout(page, EMPTY_LAYOUT); // (the demo seed has rows of its own)
	await page.locator('.outline button', { hasText: '＋ Row' }).first().click();
	const row = page.locator('[data-kind="row"]');
	await expect(row).toHaveCount(1);

	for (const type of ['Gauge', 'Bar', 'Text']) {
		await addWidget(page, type);
		// The palette heading says where the next add goes — and stays while the new widget (not the
		// row) is what's selected.
		await expect(page.locator('.inspector .add-panel > summary')).toContainText('into row');
	}
	await expect(row.locator('.widget[data-type="gauge"]')).toHaveCount(1);
	await expect(row.locator('.widget[data-type="bar"]')).toHaveCount(1);
	await expect(row.locator('.widget[data-type="text"]')).toHaveCount(1);

	// Clearing the Text widget's label leaves it with no content → the dashed "Text" placeholder.
	const textHost = row.locator('.widget[data-type="text"]');
	await page.locator('.inspector').getByRole('textbox', { name: 'label' }).fill('');
	await expect(textHost.locator('.np-text.empty .placeholder')).toHaveCount(1);

	// ✕ on the palette chip drops the target: the next add floats instead.
	const summary = page.locator('.inspector .add-panel > summary');
	if (!(await page.locator('.inspector .add-panel[open]').count())) await summary.click();
	await page.locator('.inspector .add-target-chip button').click();
	await expect(summary).not.toContainText('into row');
	await addWidget(page, 'Gauge');
	await expect(row.locator('.widget[data-type="gauge"]')).toHaveCount(1); // still just the first
	await expect(page.locator('.widget[data-type="gauge"]')).toHaveCount(2);
});

test('new floating widgets take the first free spot (never stacked) and flash into view', async ({
	page
}) => {
	await gotoStudioWithLayout(page, EMPTY_LAYOUT);
	const a = await addWidget(page, 'Gauge');
	await expect(a).toHaveAttribute('data-just-added', '');
	const ra = await a.boundingBox();
	const b = await addWidget(page, 'Gauge');
	const rb = await b.boundingBox();
	expect(ra && rb).toBeTruthy();
	// Same row, side by side — the second never lands on top of the first.
	expect(Math.abs(rb!.y - ra!.y)).toBeLessThan(2);
	expect(rb!.x).toBeGreaterThanOrEqual(ra!.x + ra!.width - 1);
	// The flash attribute is transient (1s).
	await expect(a).not.toHaveAttribute('data-just-added', '', { timeout: 3000 });
});

test('empty stage shows the "Nothing on this monitor yet" card; first-run strip is dismissible once', async ({
	page
}) => {
	await gotoStudioWithLayout(page, EMPTY_LAYOUT);
	const card = page.locator('.stage-empty');
	await expect(card).toBeVisible();
	await expect(card).toContainText('Nothing on this monitor yet');
	const strip = page.locator('.first-run-strip');
	await expect(strip).toBeVisible();
	await strip.getByRole('button', { name: 'Dismiss' }).click();
	await expect(strip).toHaveCount(0);
	// Dismissal persists across a reload.
	await page.reload();
	await expect(page.locator('.canvas.studio.edit')).toBeVisible();
	await expect(page.locator('.first-run-strip')).toHaveCount(0);
	// The card's button opens the Add palette; adding a widget clears the card.
	await card.getByRole('button', { name: /Add a widget/ }).click();
	await expect(page.locator('.inspector .palette-filter')).toBeFocused();
	await addWidget(page, 'Clock');
	await expect(card).toHaveCount(0);
});

test('every nav section boots without a blank window or a crashed boundary', async ({ page }) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	await expect(page.locator('.nav-rail')).toBeVisible(); // (lazy chunk)
	const sections = await page
		.locator('.nav-rail .nav-item[data-section]')
		.evaluateAll((els) => els.map((e) => e.getAttribute('data-section')!));
	expect(sections.length).toBeGreaterThan(5);
	for (const id of sections) {
		await openSection(page, id);
		await expect(navItem(page, id)).toHaveClass(/active/);
		// Something rendered for the section (a rail panel, the designer list, or the stage outline).
		await expect(
			page.locator('.rail-panel, .designer-list, .outline, .presets-panel, .settings-panel').first()
		).toBeVisible();
		await expect(page.locator('.error-boundary')).toHaveCount(0);
	}
	expect(log.errors, `console errors:\n${log.errors.join('\n')}`).toEqual([]);
	expect(log.mockWarns, `unmocked Tauri commands:\n${log.mockWarns.join('\n')}`).toEqual([]);
});

test('Ctrl+9 jumps to Settings (the 9th rail section)', async ({ page }) => {
	await gotoStudio(page);
	await page.locator('.canvas.studio').click({ position: { x: 5, y: 5 } });
	await page.keyboard.press('Control+9');
	await expect(navItem(page, 'settings')).toHaveClass(/active/);
});

test('corrupt widgets.json → banner names the backup path and an empty layout loads', async ({
	page
}) => {
	await gotoStudioWithLayout(page, '{not json');
	const banner = page.locator('.layout-banner', { hasText: 'Couldn’t read widgets.json' });
	await expect(banner).toBeVisible();
	await expect(banner).toContainText('widgets.json.bad-1700000000000');
	await expect(banner).toContainText('loaded an empty layout');
	await expect(page.locator('.widget')).toHaveCount(0);
	await banner.getByRole('button', { name: 'Dismiss' }).click();
	await expect(banner).toHaveCount(0);
});

test('sack export: inline name field validates, exports, and reports the path + folder button', async ({
	page
}) => {
	await gotoStudio(page);
	await openSection(page, 'sacks');
	const name = page.getByLabel('Sack name');
	await expect(name).toBeVisible();
	const exportBtn = page.locator('.sack-export button[type="submit"]');
	await name.fill('bad/name');
	await expect(exportBtn).toBeDisabled();
	await expect(page.locator('.sack-status--err')).toContainText('letters, numbers');
	await name.fill('my-sack');
	await expect(exportBtn).toBeEnabled();
	await exportBtn.click();
	// (The dev mock's write_sack resolves undefined → no path → the failure line + alert; a real
	// backend returns the path. Either way the outcome is inline.)
	page.on('dialog', (d) => void d.dismiss());
	await expect(page.locator('.sack-status')).toBeVisible();
});

test('theme editor: Escape with edits asks before discarding; Tab stays inside the dialog', async ({
	page
}) => {
	await gotoStudio(page);
	await openSection(page, 'themes');
	await page.getByRole('button', { name: /New theme CSS|Edit theme CSS/ }).click();
	const dialog = page.locator('.theme-editor');
	await expect(dialog).toBeVisible();
	// Untouched → Escape just closes.
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	// Edited → Escape asks; declining keeps the dialog.
	await page.getByRole('button', { name: /New theme CSS|Edit theme CSS/ }).click();
	await expect(dialog).toBeVisible();
	const nameField = dialog.locator('.te-name input');
	await nameField.fill('edited-name');
	let asked = '';
	page.once('dialog', (d) => {
		asked = d.message();
		void d.dismiss();
	});
	await nameField.press('Escape');
	await expect(dialog).toBeVisible();
	expect(asked).toContain('Discard theme edits?');
	// Focus trap: Shift+Tab from the first focusable (the ✕) wraps to the last (Save & apply).
	await dialog.locator('.te-close').focus();
	await page.keyboard.press('Shift+Tab');
	await expect(dialog.getByRole('button', { name: /Save & apply/ })).toBeFocused();
	page.once('dialog', (d) => void d.accept());
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
});

test('Zoom to content fits the selection (zoom changes) and the stage subbar says Save, not draft', async ({
	page
}) => {
	await gotoStudio(page);
	const before = await page.locator('.zlevel').textContent();
	await page.locator('.widget[data-type="button"] button.drag-overlay').click();
	await page.getByRole('button', { name: 'Zoom to content' }).click();
	await expect(page.locator('.zlevel')).not.toHaveText(before ?? '');
	// Nothing in the studio chrome calls it a draft.
	const chrome = await page.locator('.studio-bar, .powerbar').allTextContents();
	expect(chrome.join(' ').toLowerCase()).not.toContain('draft');
});
