import { expect, test } from '@playwright/test';
import { addWidget, gotoStudio } from './helpers';

test('custom HTML executes in isolation, receives selected sensors/theme/size and follows source edits', async ({
	page
}) => {
	await gotoStudio(page);
	const widget = await addWidget(page, 'Custom HTML');
	const frame = widget.frameLocator('iframe');
	await expect(frame.locator('main')).toHaveText('CPU—');
	await page
		.getByRole('textbox', { name: 'HTML', exact: true })
		.fill('<main id="result">Waiting</main>');
	await page.getByRole('textbox', { name: 'JavaScript', exact: true })
		.fill(`widgetsack.subscribe(state => {
 const out = { width: state.size.width, sensors: Object.keys(state.sensors), foreground: state.tokens['--np-fg'] };
 try { parent.document.body; out.parentAccessible = true; } catch { out.parentAccessible = false; }
 document.querySelector('#result').textContent = JSON.stringify(out);
});`);
	await expect(frame.locator('#result')).toContainText('"parentAccessible":false');
	await expect(frame.locator('#result')).toContainText('"sensors":["cpu.total"]');
	await expect(frame.locator('#result')).toContainText('"width":320');
	await expect(frame.locator('#result')).toContainText('"foreground":');
	await widget.evaluate((element) => {
		(element as HTMLElement).style.setProperty('--np-fg', 'rgb(1, 2, 3)');
	});
	await expect(frame.locator('#result')).toContainText('"foreground":"rgb(1, 2, 3)"');
	await page.getByRole('spinbutton', { name: 'w', exact: true }).fill('400');
	await expect(frame.locator('#result')).toContainText('"width":400');
	await page.getByRole('textbox', { name: 'Sensor IDs', exact: true }).fill('mem.used');
	await expect(frame.locator('#result')).toContainText('"sensors":["mem.used"]');
	await expect(widget.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
});
