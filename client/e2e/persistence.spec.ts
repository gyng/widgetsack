import { test, expect } from '@playwright/test';
import { addWidget, gotoStudio } from './helpers';

test('studio stays open after a failed close-save, then closes after retry succeeds', async ({
	page
}) => {
	await gotoStudio(page);
	await page.evaluate(() => {
		const w = window as unknown as {
			__TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
			persistenceTest: { fail: boolean; destroyed: number; saved: string | null };
		};
		const invoke = w.__TAURI_INTERNALS__.invoke;
		w.persistenceTest = { fail: true, destroyed: 0, saved: null };
		w.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
			if (cmd === 'save_layout') {
				if (w.persistenceTest.fail) throw new Error('disk full');
				w.persistenceTest.saved = (args as { contents: string }).contents;
				return;
			}
			if (cmd === 'list_window_labels') return ['main', 'studio'];
			if (cmd === 'plugin:window|destroy') {
				w.persistenceTest.destroyed++;
				return;
			}
			return invoke(cmd, args);
		};
	});
	const widget = await addWidget(page, 'Text');
	const id = await widget.getAttribute('data-w');
	expect(id).toBeTruthy();
	const messages: string[] = [];
	page.on('dialog', async (dialog) => {
		messages.push(dialog.message());
		await dialog.accept();
	});
	const close = () =>
		page.evaluate(async () => {
			const w = window as unknown as {
				__TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
			};
			await w.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
				event: 'tauri://close-requested',
				payload: null
			});
		});
	await close();
	await expect.poll(() => messages.length).toBe(1);
	expect(messages[0]).toContain('NOT saved');
	await expect(page.locator('button.save')).toBeEnabled();
	await expect(widget).toBeVisible();
	expect(
		await page.evaluate(
			() =>
				(window as unknown as { persistenceTest: { destroyed: number } }).persistenceTest.destroyed
		)
	).toBe(0);
	await page.evaluate(() => {
		(window as unknown as { persistenceTest: { fail: boolean } }).persistenceTest.fail = false;
	});
	await close();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as unknown as { persistenceTest: { destroyed: number } }).persistenceTest
						.destroyed
			)
		)
		.toBe(1);
	expect(
		await page.evaluate(
			() => (window as unknown as { persistenceTest: { saved: string } }).persistenceTest.saved
		)
	).toContain(id!);
});
