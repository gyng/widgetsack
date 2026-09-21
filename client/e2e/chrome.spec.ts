import { test, expect } from '@playwright/test';
import { gotoStudio, navItem, openSection, previewTemplate } from './helpers';

// Studio shell: NavRail section switching, leaving a read-only preview via the rail, and two panels
// that work without a backend (Settings autostart, Themes editor). Real-browser state transitions the
// unit tests skip.

test('NavRail switches sections and marks the active one', async ({ page }) => {
	await gotoStudio(page);

	// Layouts is the default section: the Inspector + Outline dock.
	await expect(navItem(page, 'layouts')).toHaveClass(/active/);
	await expect(page.locator('.inspector')).toBeVisible();
	await expect(page.locator('.outline')).toBeVisible();

	// The widget designer → the template/widget designer list.
	await openSection(page, 'widget-designer');
	await expect(navItem(page, 'widget-designer')).toHaveClass(/active/);
	await expect(page.locator('.designer-list')).toBeVisible();

	// Sensors → a rail panel; the Inspector is gone.
	await openSection(page, 'sensors');
	await expect(navItem(page, 'sensors')).toHaveClass(/active/);
	await expect(page.locator('.rail-panel')).toBeVisible();
	await expect(page.locator('.inspector')).toHaveCount(0);

	// Settings → the Monitor/Startup/… panel.
	await openSection(page, 'settings');
	await expect(navItem(page, 'settings')).toHaveClass(/active/);
	await expect(page.locator('.rail-panel')).toContainText('Monitor');
});

test('a NavRail click leaves a read-only template preview (no dead modal)', async ({ page }) => {
	await gotoStudio(page);
	await previewTemplate(page, 'Network');

	// The read-only preview banner shows; the designer section is the active one.
	await expect(page.locator('.def-banner')).toContainText('Previewing');
	await expect(navItem(page, 'widget-designer')).toHaveClass(/active/);

	// The rail is no longer a dead modal: clicking a section leaves the preview (nothing to save) and
	// switches there — instead of the old confusing no-op.
	await openSection(page, 'sensors');
	await expect(navItem(page, 'sensors')).toHaveClass(/active/);
	await expect(page.locator('.def-banner')).toHaveCount(0);

	// And the def-banner's own Close still works as the explicit exit.
	await previewTemplate(page, 'Network');
	await expect(page.locator('.def-banner')).toContainText('Previewing');
	await page.locator('.def-banner button', { hasText: 'Close' }).click();
	await expect(page.locator('.def-banner')).toHaveCount(0);
});

test('Settings: launch-at-login starts off and reverts after toggle (mock reports it disabled)', async ({
	page
}) => {
	await gotoStudio(page);
	await openSection(page, 'settings');
	// Settings is tabbed (default = Display); launch-at-login lives under the Startup tab.
	await page.locator('.settings-panel .pl-item', { hasText: 'Startup' }).click();
	const cb = page
		.locator('label.rp-row', { hasText: 'launch at login' })
		.locator('input[type=checkbox]');
	await expect(cb).not.toBeChecked();
	// Toggling flips optimistically, then reconciles with the OS state (mock is_enabled=false) → reverts.
	await cb.click();
	await expect(cb).not.toBeChecked();
});

test('Settings: About shows the widgetsack mascot (asset actually loads)', async ({ page }) => {
	await gotoStudio(page);
	await openSection(page, 'settings');
	await page.locator('.settings-panel .pl-item', { hasText: 'About' }).click();
	const mascot = page.locator('.settings-panel .about-mascot');
	await expect(mascot).toBeVisible();
	// Not just an <img> in the DOM — the bundled PNG decoded (naturalWidth > 0), so the import resolved.
	await expect
		.poll(() => mascot.evaluate((img) => (img as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(0);
});

test('Themes: Edit theme CSS opens the editor (seeded default) and closes', async ({ page }) => {
	await gotoStudio(page);
	await openSection(page, 'themes');
	// No theme is selected under the mock, so the open-editor button reads "＋ New theme CSS…"; with a
	// theme selected it reads "Edit theme CSS (<name>)…". Match the stable "theme CSS" substring.
	await page.locator('.rail-panel button', { hasText: 'theme CSS' }).click();
	const ed = page.locator('.theme-editor');
	await expect(ed).toBeVisible();
	// The CSS editor (lazy CodeMirror, class te-css) mounts, seeded with the default :root tokens since
	// load_theme → null under the mock. CodeMirror renders the doc text into the DOM.
	await expect(ed.locator('.te-css')).toBeVisible();
	await expect(ed).toContainText('--np-accent');
	await ed.locator('button.te-close').click();
	await expect(ed).toBeHidden();
});

test('Background: picking a colour renders the wallpaper layer behind the widgets', async ({
	page
}) => {
	await gotoStudio(page);
	await openSection(page, 'background');
	const panel = page.locator('.rail-panel.bg-panel');
	await expect(panel).toBeVisible();
	// No background yet → no layer painted.
	await expect(page.locator('.canvas .bg-layer')).toHaveCount(0);
	// Choose the colour kind, then set a colour → the background layer paints a fill behind .world's
	// widgets (the layer lives inside .world, before any widget).
	await panel.locator('.bg-field select').first().selectOption('color');
	await panel.locator('input[type=color]').fill('#123456');
	const fill = page.locator('.canvas .world .bg-layer .bg-fill');
	await expect(fill).toBeVisible();
	// Remove it again → the layer is gone.
	await panel.locator('button.bg-clear').click();
	await expect(page.locator('.canvas .bg-layer')).toHaveCount(0);
});
