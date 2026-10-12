import { test, expect } from '@playwright/test';
import { gotoStudio, previewTemplate, watchConsole } from './helpers';

test('mixer controls align across long app names and mute states at narrow widths', async ({
	page
}) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	await page.evaluate(() => {
		const internals = (
			window as unknown as {
				__TAURI_INTERNALS__: {
					invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
				};
			}
		).__TAURI_INTERNALS__;
		const original = internals.invoke.bind(internals);
		internals.invoke = (command, args) =>
			command === 'get_audio_mixer'
				? Promise.resolve({
						sessions: [
							{ id: 'one', name: 'Music', level: 0.5, muted: false },
							{
								id: 'two',
								name: 'An application with a very long display name',
								level: 1,
								muted: true
							}
						],
						microphone: { level: 1, muted: false }
					})
				: original(command, args);
	});
	await previewTemplate(page, 'App Audio / Microphone');
	const mixer = page.getByRole('region', { name: 'App audio mixer' }).first();
	await expect(mixer.locator('.mixer-session')).toHaveCount(2);
	for (const width of [340, 220]) {
		await mixer.evaluate((node, size) => {
			node.style.width = `${size}px`;
		}, width);
		const positions = await mixer.locator('.mixer-controls').evaluateAll((nodes) =>
			nodes.map((node) => {
				return Array.from(node.children, (child) => {
					const rect = child.getBoundingClientRect();
					return { left: rect.left, width: rect.width };
				});
			})
		);
		expect(positions[0]).toEqual(positions[1]);
		expect(await mixer.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
		const mic = await mixer.locator('.mixer-microphone button').boundingBox();
		const app = await mixer.locator('.mixer-controls button').first().boundingBox();
		expect(mic!.x).toBe(app!.x);
	}
	expect(log.errors).toEqual([]);
});
