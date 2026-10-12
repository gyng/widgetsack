import { test, expect } from '@playwright/test';
import { gotoStudio, openSection, watchConsole } from './helpers';

test('assistant stays open across studio sections without replacing their content', async ({
	page
}) => {
	const log = watchConsole(page);
	await page.setViewportSize({ width: 1024, height: 768 });
	await gotoStudio(page);
	await page.getByRole('button', { name: 'Studio AI assistant', exact: true }).click();
	const sidebar = page.getByRole('complementary', { name: 'Studio AI assistant' });
	await expect(page.locator('.inspector.docked')).toBeVisible();
	await sidebar.getByLabel('Message to studio assistant').fill('My draft request');
	for (const section of [
		'sensors',
		'plugins',
		'themes',
		'sacks',
		'background',
		'saved-layouts',
		'settings',
		'widget-designer'
	]) {
		await openSection(page, section);
		await expect(sidebar).toBeVisible();
		await expect(sidebar.getByLabel('Message to studio assistant')).toHaveValue('My draft request');
		const panel = page.locator('.rail-panel, .designer-list').first();
		await expect(panel).toBeVisible();
		const bounds = await panel.boundingBox();
		const assistant = await sidebar.boundingBox();
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(assistant!.x);
		expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
	}
	await openSection(page, 'settings');
	await page.getByRole('button', { name: 'Overlay', exact: true }).click();
	await expect(page.locator('.set-help-list').first()).toBeVisible();
	await page.screenshot({ path: 'test-results/studio-overlay-assistant.png' });
	await openSection(page, 'layouts');
	await expect(page.locator('.inspector.docked')).toBeVisible();
	await sidebar.getByRole('button', { name: 'Close assistant' }).click();
	await expect(page.locator('.canvas')).not.toHaveClass(/assistant-open/);
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});

test('native agent setup fits a compact studio and refresh discovers an installed agent', async ({
	page
}) => {
	const log = watchConsole(page);
	await page.setViewportSize({ width: 1024, height: 768 });
	await gotoStudio(page);
	await page.evaluate(() => {
		const internals = (
			window as unknown as {
				__TAURI_INTERNALS__: {
					invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
				};
			}
		).__TAURI_INTERNALS__;
		const invoke = internals.invoke.bind(internals);
		let refresh = 0;
		internals.invoke = (command, args) =>
			command === 'studio_agent_status'
				? Promise.resolve({
						defaultBackend: refresh++ ? 'codex' : '',
						backends: [
							{ id: 'pi', label: 'Pi', available: false },
							{ id: 'codex', label: 'Codex', available: refresh > 1 },
							{ id: 'claude', label: 'Claude', available: false }
						],
						models: [],
						defaultModel: ''
					})
				: invoke(command, args);
	});
	await page.getByRole('button', { name: 'Studio AI assistant', exact: true }).click();
	const sidebar = page.getByRole('complementary', { name: 'Studio AI assistant' });
	await expect(sidebar.getByText(/No installed agent found/)).toBeVisible();
	await expect(sidebar.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
	await expect(sidebar.getByRole('button', { name: 'Add a clock', exact: true })).toBeDisabled();
	await sidebar.screenshot({ path: 'test-results/native-agent-setup.png' });
	await sidebar.getByRole('button', { name: 'Refresh agents' }).click();
	await expect(sidebar.getByLabel('Agent backend')).toHaveValue('codex');
	await sidebar.getByRole('button', { name: 'Add a clock', exact: true }).click();
	await expect(sidebar.getByLabel('Message to studio assistant')).toHaveValue('Add a clock');
	await expect(sidebar.getByLabel('Message to studio assistant')).toBeFocused();
	await expect(sidebar.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
	const overflow = await sidebar.evaluate((element) => element.scrollWidth > element.clientWidth);
	expect(overflow).toBe(false);
	await sidebar.screenshot({ path: 'test-results/native-agent-ready.png' });
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});

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
	await expect(page.locator('.inspector.docked')).toBeVisible();
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
	const inspector = await page.locator('.inspector.docked').boundingBox();
	expect(inspector!.x).toBeGreaterThanOrEqual(stage!.x + stage!.width);
	expect(inspector!.x + inspector!.width).toBeLessThanOrEqual(panel!.x);
	await page.screenshot({ path: 'test-results/native-agent-docks.png' });
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
