import { test, expect } from '@playwright/test';
import { gotoStudio, addWidget } from './helpers';

test('persisted monitor inputs stay visible and keep their geometry while revalidating', async ({
	page
}) => {
	await gotoStudio(page);
	await page.evaluate(() => {
		const saved = {
			gdi: 'display',
			stable: 'desk',
			friendly: 'Desk monitor',
			primary: true,
			current_input: 17,
			supported: [15, 17],
			width: 2560,
			height: 1440,
			refresh_hz: 144
		};
		localStorage.setItem('widgetsack.monitor-inputs.v1:', JSON.stringify(saved));
		const bridge = (
			window as unknown as {
				__TAURI_INTERNALS__: {
					invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
				};
			}
		).__TAURI_INTERNALS__;
		const original = bridge.invoke.bind(bridge);
		const pending: (() => void)[] = [];
		(window as unknown as { finishMonitorInputs: () => void }).finishMonitorInputs = () => {
			for (const resolve of pending) resolve();
		};
		bridge.invoke = (command, args) =>
			command === 'list_monitor_inputs'
				? new Promise((resolve) => pending.push(() => resolve([{ ...saved, current_input: 15 }])))
				: original(command, args);
	});
	const widget = await addWidget(page, 'Monitor Switch');
	const meter = widget.locator('.np-monitorswitch');
	await expect(meter).toHaveAttribute('aria-busy', 'true');
	await expect(meter.getByRole('button', { name: 'HDMI 1' })).toBeDisabled();
	await expect(meter.getByRole('status', { name: 'Refreshing monitor inputs' })).toBeVisible();
	const geometry = () =>
		meter.locator('.ms-head,.ms-row').evaluateAll((nodes) =>
			nodes.map((node) => {
				const { x, y, width, height } = node.getBoundingClientRect();
				return { x, y, width, height };
			})
		);
	const before = await geometry();
	await page.evaluate(() =>
		(window as unknown as { finishMonitorInputs: () => void }).finishMonitorInputs()
	);
	await expect(meter).toHaveAttribute('aria-busy', 'false');
	await expect(meter.getByRole('button', { name: 'DisplayPort 1' })).toBeEnabled();
	await expect(meter.getByRole('button', { name: 'DisplayPort 1' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	expect(await geometry()).toEqual(before);
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(meter.getByRole('status', { name: 'Refreshing monitor inputs' })).toBeVisible();
	await expect(meter.getByRole('button', { name: 'HDMI 1' })).toBeEnabled();
	await expect(meter.getByRole('button', { name: 'DisplayPort 1' })).toBeEnabled();
	expect(await geometry()).toEqual(before);
	await page.evaluate(() =>
		(window as unknown as { finishMonitorInputs: () => void }).finishMonitorInputs()
	);
	await expect(meter).toHaveAttribute('aria-busy', 'false');
});
