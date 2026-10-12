import { test, expect } from '@playwright/test';
import { gotoStudio, watchConsole } from './helpers';

test('the docked assistant controls real editor state and each batch can be undone', async ({
	page
}) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	const originalGroup = page.locator('.world [data-group=""]').first();
	await expect(originalGroup).toBeVisible();
	const originalGroupId = await originalGroup.getAttribute('data-id');
	await page.evaluate(() => {
		const internals = (
			window as unknown as {
				__TAURI_INTERNALS__: {
					invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
					runCallback(id: number, message: unknown): void;
				};
			}
		).__TAURI_INTERNALS__;
		const invoke = internals.invoke.bind(internals);
		let channel = 0,
			index = 0,
			phase = 0,
			widget = '';
		let finish: () => void = () => {};
		const send = (message: unknown) => internals.runCallback(channel, { index: index++, message });
		internals.invoke = (command, args = {}) => {
			if (command === 'studio_agent_run') {
				channel = (args.channel as { id: number }).id;
				return new Promise<void>((resolve) => {
					finish = resolve;
					send({ type: 'tool', id: 'read', name: 'studio_read', args: {} });
				});
			}
			if (command === 'studio_agent_reply') {
				phase++;
				if (phase === 1)
					send({
						type: 'tool',
						id: 'add',
						name: 'studio_apply',
						args: {
							ops: [
								{
									op: 'moveWidget',
									id: (args.result as { monitor: { floating: { id: string }[] } }).monitor
										.floating[0].id,
									rect: { x: 400, y: 200, w: 300, h: 250 }
								},
								{
									op: 'setStyle',
									id: (args.result as { monitor: { floating: { id: string }[] } }).monitor
										.floating[0].id,
									css: 'color: rgb(197, 163, 255);'
								},
								{
									op: 'addWidget',
									widgetType: 'clock',
									parent: 'floating',
									config: { format: 'HH:mm' }
								}
							]
						}
					});
				if (phase === 2) {
					widget = (args.result as { addedIds: string[] }).addedIds[0];
					send({ type: 'tool', id: 'again', name: 'studio_read', args: {} });
				}
				if (phase === 3)
					send({
						type: 'tool',
						id: 'style',
						name: 'studio_apply',
						args: {
							ops: [
								{ op: 'moveWidget', id: widget, rect: { x: 100, y: 100, w: 220, h: 80 } },
								{ op: 'setStyle', id: widget, css: 'color: rgb(119, 196, 211);' }
							]
						}
					});
				if (phase === 4) {
					send({ type: 'text', text: 'Added and styled the clock.' });
					internals.runCallback(channel, { index, end: true });
					finish();
				}
				return Promise.resolve();
			}
			return invoke(command, args);
		};
	});
	await page.getByRole('button', { name: 'Studio AI assistant', exact: true }).click();
	const sidebar = page.getByRole('complementary', { name: 'Studio AI assistant' });
	await expect(sidebar).toBeVisible();
	await expect(sidebar.getByLabel('Agent backend')).toHaveValue('pi');
	await sidebar.getByLabel('Message to studio assistant').fill('Add and style a clock');
	await sidebar.getByRole('button', { name: 'Send', exact: true }).click();
	await expect(sidebar.getByText('Added and styled the clock.')).toBeVisible();
	const clock = page.locator('.world [data-type="clock"]');
	await expect(clock).toHaveCount(1);
	await expect(clock).toHaveCSS('width', '220px');
	await expect(clock).toHaveCSS('color', 'rgb(119, 196, 211)');
	const group = page.locator(`.world [data-group=""][data-id="${originalGroupId}"]`);
	await expect(group).toHaveCSS('width', '300px');
	await expect(group).toHaveCSS('color', 'rgb(197, 163, 255)');
	const panel = await sidebar.boundingBox();
	const stage = await page.locator('.canvas.studio').boundingBox();
	expect(panel!.x).toBeGreaterThanOrEqual(stage!.x + stage!.width);
	await sidebar.screenshot({ path: 'test-results/studio-assistant.png' });
	await page.getByRole('button', { name: /Undo/ }).click();
	await expect(clock).not.toHaveCSS('width', '220px');
	await page.getByRole('button', { name: /Undo/ }).click();
	await expect(clock).toHaveCount(0);
	await sidebar.getByRole('button', { name: 'Close assistant' }).click();
	await expect(sidebar).toHaveCount(0);
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});
