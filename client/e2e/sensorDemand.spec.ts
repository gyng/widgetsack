import { expect, test } from '@playwright/test';
import { addWidget, gotoStudio, openSection, watchConsole } from './helpers';

test('Studio discovers hardware IDs and samples only visible sensor rows', async ({ page }) => {
	const log = watchConsole(page);
	await page.setViewportSize({ width: 1280, height: 640 });
	await gotoStudio(page);
	await addWidget(page, 'Clock');
	await page.evaluate(() => {
		const w = window as unknown as {
			__TAURI_INTERNALS__: {
				invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
			};
			sensorReports: string[][];
		};
		w.sensorReports = [];
		const invoke = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
		w.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
			if (command === 'set_active_sensors') w.sensorReports.push(args.ids as string[]);
			return invoke(command, args);
		};
	});
	const latest = () =>
		page.evaluate(
			() => (window as unknown as { sensorReports: string[][] }).sensorReports.at(-1) ?? []
		);
	await openSection(page, 'sensors');
	const filter = page.getByRole('searchbox', { name: 'Filter sensors' });
	await filter.fill('disk.c');
	await expect(page.locator('.rp-row[title="disk.c.free"]')).toBeVisible();
	await expect.poll(async () => (await latest()).includes('disk.c.free')).toBe(true);
	await expect.poll(async () => (await latest()).includes('recyclebin.items')).toBe(false);
	await filter.fill('recyclebin');
	await expect.poll(async () => (await latest()).includes('recyclebin.items')).toBe(true);
	await filter.fill('cpu.total');
	await expect.poll(async () => (await latest()).includes('recyclebin.items')).toBe(false);
	await filter.fill('');
	await page.locator('.rp-row[title="cpu.total"]').scrollIntoViewIfNeeded();
	await expect.poll(async () => (await latest()).includes('recyclebin.items')).toBe(false);
	await page.locator('.rp-row[title="recyclebin.items"]').scrollIntoViewIfNeeded();
	await expect.poll(async () => (await latest()).includes('recyclebin.items')).toBe(true);
	await openSection(page, 'settings');
	await expect.poll(async () => (await latest()).includes('recyclebin.items')).toBe(false);
	expect(
		await page.evaluate(() =>
			(window as unknown as { sensorReports: string[][] }).sensorReports.some((ids) =>
				ids.includes('*')
			)
		)
	).toBe(false);
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});
