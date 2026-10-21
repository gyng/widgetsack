import { expect, test } from '@playwright/test';
import { addWidget, gotoStudio, openSection, watchConsole } from './helpers';

test('MCP reads, edits and verifies the actual editor with the assistant sidebar closed', async ({
	page
}) => {
	const log = watchConsole(page);
	await gotoStudio(page);
	await page.evaluate(() => {
		const w = window as unknown as {
			__TAURI_INTERNALS__: {
				invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
			};
			mcpReplies: Record<string, unknown>;
		};
		w.mcpReplies = {};
		const invoke = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
		w.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
			if (command === 'mcp_studio_reply') {
				w.mcpReplies[String(args.requestId)] = args.result;
				return Promise.resolve();
			}
			return invoke(command, args);
		};
	});
	const request = async (id: string, name: string, args: unknown) => {
		await page.evaluate(
			({ id, name, args }) =>
				(
					window as unknown as {
						__TAURI_INTERNALS__: { invoke(command: string, args: unknown): Promise<unknown> };
					}
				).__TAURI_INTERNALS__.invoke('plugin:event|emit', {
					event: 'mcp_studio_request',
					payload: { id, name, args }
				}),
			{ id, name, args }
		);
		await expect
			.poll(() =>
				page.evaluate(
					(id) => !!(window as unknown as { mcpReplies: Record<string, unknown> }).mcpReplies[id],
					id
				)
			)
			.toBe(true);
		return page.evaluate(
			(id) => (window as unknown as { mcpReplies: Record<string, unknown> }).mcpReplies[id],
			id
		);
	};
	await expect(page.getByRole('complementary', { name: 'Studio AI assistant' })).toHaveCount(0);
	const read = (await request('read', 'studio_read', {})) as {
		revision: string;
		editorTarget: string;
		widgetTypes: unknown[];
	};
	expect(read.revision).toBe('read');
	expect(read.editorTarget).toContain('monitor:');
	expect(read.widgetTypes.length).toBeGreaterThan(30);
	const changed = (await request('edit', 'studio_apply', {
		revision: read.revision,
		ops: [{ op: 'addWidget', widgetType: 'clock', parent: 'floating', config: { format: 'HH:mm' } }]
	})) as { applied: number; addedIds: string[] };
	expect(changed.applied).toBe(1);
	const widget = page.locator(`[data-w="${changed.addedIds[0]}"]`);
	await expect(widget).toBeVisible();
	const verified = (await request('verify', 'studio_verify', {})) as {
		measured: boolean;
		checked: number;
		issues: { id: string; severity: string }[];
		visualReviewRequired: boolean;
	};
	expect(verified.measured).toBe(true);
	expect(verified.checked).toBeGreaterThan(0);
	expect(verified.visualReviewRequired).toBe(true);
	expect(
		verified.issues.filter(
			(issue) => issue.id === changed.addedIds[0] && issue.severity === 'error'
		)
	).toEqual([]);
	const repeated = (await request('repeat', 'studio_apply', { revision: 'read', ops: [] })) as {
		error: string;
	};
	expect(repeated.error).toContain('revision');
	await request('before-manual', 'studio_read', {});
	await addWidget(page, 'Text');
	const stale = (await request('stale', 'studio_apply', {
		revision: 'before-manual',
		ops: [{ op: 'clear' }]
	})) as { applied: number; errors: string[] };
	expect(stale.applied).toBe(0);
	expect(stale.errors.join(' ')).toContain('layout changed');
	await expect(widget).toBeVisible();
	await openSection(page, 'settings');
	await page.getByRole('button', { name: 'MCP', exact: true }).click();
	await expect(page.getByLabel('Enable MCP')).not.toBeChecked();
	await page.getByLabel('Enable MCP').check();
	await expect(page.getByText('Listening: http://127.0.0.1:12345/mcp')).toBeVisible();
	await page.getByLabel('Allow browser tools').check();
	await expect(
		page.getByText(/Restart Widgetsack to apply changes to browser access/)
	).toBeVisible();
	await page.screenshot({ path: 'test-results/studio-mcp-page.png' });
	expect(log.errors).toEqual([]);
	expect(log.mockWarns).toEqual([]);
});

test('assistant model typeahead filters suggestions and accepts a custom model', async ({
	page
}) => {
	await gotoStudio(page);
	await page.evaluate(() => {
		const ipc = (
			window as unknown as {
				__TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown> };
			}
		).__TAURI_INTERNALS__;
		const invoke = ipc.invoke.bind(ipc);
		ipc.invoke = (command, args) =>
			command === 'studio_agent_status'
				? Promise.resolve({
						defaultBackend: 'pi',
						backends: [{ id: 'pi', label: 'Pi', available: true }],
						models: { pi: ['openai/sample-fast', 'anthropic/sample-large'] }
					})
				: invoke(command, args);
	});
	await page.getByRole('button', { name: 'Studio AI assistant', exact: true }).click();
	await page.getByRole('tab', { name: 'Built-in', exact: true }).click();
	const model = page.getByRole('combobox', { name: 'Agent model', exact: true });
	await expect(model).toBeEnabled();
	await model.fill('sample-fast');
	await expect(page.getByRole('option', { name: 'openai/sample-fast', exact: true })).toBeVisible();
	await expect(
		page.getByRole('option', { name: 'anthropic/sample-large', exact: true })
	).toHaveCount(0);
	await page.getByRole('option', { name: 'openai/sample-fast', exact: true }).click();
	await expect(model).toHaveValue('openai/sample-fast');
	await model.fill('my-local-model');
	await model.press('Tab');
	await expect(model).toHaveValue('my-local-model');
	await page.screenshot({ path: 'test-results/studio-model-typeahead.png' });
});
