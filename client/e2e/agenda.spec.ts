import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';

test('agenda times and names align on the Dentist row and rows with locations', async ({
	page
}) => {
	await page.goto('/gallery/');
	for (const shot of ['widget-agenda', 'preset-work', 'preset-home']) {
		const agenda = page.locator(`[data-shot="${shot}"] .agenda`);
		await expect(agenda.getByText('Dentist', { exact: true })).toBeAttached();
		const rows = await agenda.locator('.ag-event').evaluateAll((nodes) =>
			nodes.map((node) => {
				const time = node.querySelector('.ag-when')!.getBoundingClientRect();
				const name = node.querySelector('.ag-summary')!.getBoundingClientRect();
				return { timeY: time.y, nameY: name.y, nameX: name.x };
			})
		);
		for (const row of rows) {
			expect(Math.abs(row.timeY - row.nameY)).toBeLessThan(0.5);
			expect(row.nameX).toBeCloseTo(rows[0].nameX, 1);
		}
		if (shot.startsWith('preset-')) {
			expect(rows).toHaveLength(2);
			expect(
				await agenda.locator('.ag-list').evaluate((node) => node.scrollHeight <= node.clientHeight)
			).toBe(true);
		}
	}
});

test('agenda remains readable in a narrow widget and scrolls to later events', async ({ page }) => {
	const log = watchConsole(page);
	// The unrelated iframe demo is sandboxed; keep Vite's injected scripts out of it.
	await page.route('**/gallery/iframe-demo.html', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<p>Embedded page</p>' })
	);
	await page.goto('/gallery/');
	const agenda = page.locator('[data-shot="widget-agenda"] .agenda');
	await expect(agenda.locator('.ag-location').first()).toHaveText('Room 2');
	await expect(agenda.locator('.ag-when').filter({ hasText: 'All day' }).first()).toBeVisible();
	await agenda.evaluate((node) => {
		node.style.width = '180px';
		node.style.height = '150px';
	});
	const list = agenda.getByRole('list', { name: 'Upcoming events' });
	expect(await list.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
	expect(await list.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
	await list.focus();
	await page.keyboard.press('End');
	await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
	expect(log.errors).toEqual([]);
});

test.describe('calendar feed worker', () => {
	test.use({ timezoneId: 'UTC' });
	test('renders recurring ICS events and meeting reminders through the real worker', async ({
		page
	}) => {
		const log = watchConsole(page);
		await page.clock.install({ time: new Date('2026-10-14T08:25:00Z') });
		const unit = (id: string, type: string, config: Record<string, unknown>, h: number) => ({
			id,
			unit: { id, type, config, rect: { x: 0, y: 0, w: 420, h } }
		});
		const layout = JSON.stringify({
			version: 2,
			monitors: {
				default: {
					root: {
						id: 'root',
						kind: 'col',
						children: [
							unit('agenda', 'agenda', { title: 'Calendar', maxRows: 4 }, 260),
							unit('alerts', 'alerts', { meetingMinutes: 10 }, 150)
						]
					},
					floating: []
				}
			}
		});
		await page.goto(`/?mockLayout=${encodeURIComponent(layout)}`);
		await expect(page.locator('.canvas.studio.edit')).toBeVisible();
		const calendar = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:weekly\nSUMMARY:Standup\nDTSTART;TZID=Europe/London:20261014T093000\nRRULE:FREQ=WEEKLY;COUNT=4\nEXDATE;TZID=Europe/London:20261021T093000\nEND:VEVENT\nEND:VCALENDAR`;
		await page.evaluate(async (calendar) => {
			const bridge = (
				window as unknown as {
					__TAURI_INTERNALS__: {
						invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
					};
				}
			).__TAURI_INTERNALS__;
			await bridge.invoke('plugin:event|emit', {
				event: 'telemetry',
				payload: [
					{
						sensor: 'agenda.calendar',
						ts_ms: Date.now(),
						value: { kind: 'json', value: { version: 1, calendar } }
					}
				]
			});
		}, calendar);
		// The first job spins up a module worker from the dev server (cold under load). The app bounds it
		// with its own 5 s CALENDAR_TIMEOUT_MS; don't let the 5 s default expect timeout race that bound.
		await expect(page.locator('.agenda .ag-summary')).toHaveCount(3, { timeout: 10_000 });
		await expect(page.locator('.agenda .ag-when')).toHaveText(['08:30', '09:30', '09:30']);
		await expect(page.getByText('Standup in 5 minutes', { exact: true })).toBeVisible();
		await expect(
			page.locator('.np-dashboard').getByRole('button', { name: 'Snooze Standup in 5 minutes' })
		).toBeDisabled();
		// A changed source must replace the shared snapshot and expose a partial parse failure.
		await page.evaluate(async () => {
			const bridge = (
				window as unknown as {
					__TAURI_INTERNALS__: {
						invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
					};
				}
			).__TAURI_INTERNALS__;
			const calendar = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:bad\nSUMMARY:Broken\nDTSTART:garbage\nEND:VEVENT\nBEGIN:VEVENT\nUID:good\nSUMMARY:Visible event\nDTSTART:20261014T230000Z\nEND:VEVENT\nEND:VCALENDAR`;
			await bridge.invoke('plugin:event|emit', {
				event: 'telemetry',
				payload: [
					{
						sensor: 'agenda.calendar',
						ts_ms: Date.now(),
						value: { kind: 'json', value: { version: 1, calendar } }
					}
				]
			});
		});
		await expect(page.locator('.agenda .ag-summary')).toHaveText(['Visible event']);
		await expect(page.locator('.agenda .ag-status')).toContainText(
			'Some calendar events could not be read.'
		);
		await expect(page.locator('.np-dashboard [role="status"]')).toContainText(
			'Some calendar events could not be read.'
		);
		expect(log.errors).toEqual([]);
	});
});
