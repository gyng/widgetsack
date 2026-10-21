import { expect, test, type Page } from '@playwright/test';
import { gotoStudio } from './helpers';

async function delayModule(page: Page, name: string) {
	let release!: () => void;
	let requested!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const request = new Promise<void>((resolve) => {
		requested = resolve;
	});
	await page.route(`**/${name}.tsx*`, async (route) => {
		requested();
		await gate;
		await route.continue();
	});
	return { release, request };
}

test('a delayed section keeps Studio chrome and Assistant mounted and can be left immediately', async ({
	page
}) => {
	const { release, request } = await delayModule(page, 'BackgroundPanel');
	await gotoStudio(page);
	await request;
	let navigations = 0;
	page.on('framenavigated', (frame) => {
		if (frame === page.mainFrame()) navigations++;
	});
	await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
	await page.getByRole('tab', { name: 'Built-in', exact: true }).click();
	const draft = page.getByLabel('Message to studio assistant');
	await draft.fill('Keep this draft while switching panes');
	const chrome = page.locator('.studio-bar:not(.studio-subbar)');
	await chrome.evaluate((el) => {
		(el as HTMLElement).dataset.preserved = 'yes';
	});
	try {
		await page.locator('[data-section="background"]').click();
		await expect(chrome).toBeVisible();
		await expect(page.locator('.nav-rail')).toBeVisible();
		await expect(draft).toBeVisible();
		await expect(draft).toHaveValue('Keep this draft while switching panes');
		await expect(page.getByText('Loading Background…', { exact: true })).toBeVisible();
		await page.screenshot({ path: 'test-results/pane-loading-section.png' });
		await page.locator('[data-section="layouts"]').click();
		await expect(page.locator('.outline.docked')).toBeVisible();
		await expect(page.getByText('Loading Background…', { exact: true })).toHaveCount(0);
	} finally {
		release();
	}
	await page.locator('[data-section="background"]').click();
	await expect(page.locator('.bg-panel')).toBeVisible();
	await expect(chrome).toHaveAttribute('data-preserved', 'yes');
	await expect(draft).toHaveValue('Keep this draft while switching panes');
	expect(navigations).toBe(0);
});

test('slow details cannot hide navigation, the canvas or the Assistant tab', async ({ page }) => {
	const { release } = await delayModule(page, 'Inspector');
	try {
		await gotoStudio(page);
		await expect(page.getByText('Loading details…', { exact: true })).toBeVisible();
		await expect(page.locator('.studio-bar:not(.studio-subbar)')).toBeVisible();
		await expect(page.locator('.studio-subbar')).toBeVisible();
		await expect(page.locator('.outline.docked')).toBeVisible();
		await expect(page.locator('.widget').first()).toBeVisible();
		await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
		await expect(page.getByRole('tab', { name: 'Your agent', exact: true })).toBeVisible();
		await expect(page.getByText('Loading details…', { exact: true })).not.toBeVisible();
		await page.getByRole('tab', { name: 'Add', exact: true }).click();
		await expect(page.getByText('Loading details…', { exact: true })).toBeVisible();
	} finally {
		release();
	}
	await expect(page.locator('.inspector.docked')).toBeVisible();
});

test('a slow Custom library uses only its own rail and leaves Layout reachable', async ({
	page
}) => {
	await page.setViewportSize({ width: 1024, height: 768 });
	const { release } = await delayModule(page, 'DesignerListPanel');
	try {
		await gotoStudio(page);
		await page.locator('[data-section="widget-designer"]').click();
		const loading = page.getByText('Loading Widget designer…', { exact: true });
		await expect(loading).toBeVisible();
		const bounds = await loading.boundingBox();
		const nav = await page.locator('.nav-rail').boundingBox();
		expect(bounds!.x).toBeGreaterThanOrEqual(nav!.x + nav!.width);
		expect(bounds!.width).toBeLessThan(250);
		await page.locator('[data-section="layouts"]').click();
		await expect(page.locator('.outline.docked')).toBeVisible();
	} finally {
		release();
	}
	await page.locator('[data-section="widget-designer"]').click();
	await expect(
		page.getByRole('searchbox', { name: 'Filter custom widgets and templates' })
	).toBeVisible();
});
