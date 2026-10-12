import { expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { listenMcpStudio, mcpSetPreferences, mcpStatus, mcpStudioPorts } from './mcp';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
it('uses the matching native settings and studio-request contracts', async () => {
	await mcpStatus();
	expect(invoke).toHaveBeenLastCalledWith('mcp_status');
	await mcpSetPreferences(true, false);
	expect(invoke).toHaveBeenLastCalledWith('mcp_set_preferences', {
		enabled: true,
		browserAccess: false
	});
	await mcpStudioPorts.claim('request');
	expect(invoke).toHaveBeenLastCalledWith('mcp_studio_claim', { requestId: 'request' });
	await mcpStudioPorts.reply('request', { applied: 1 });
	expect(invoke).toHaveBeenLastCalledWith('mcp_studio_reply', {
		requestId: 'request',
		result: { applied: 1 }
	});
	const receive = vi.fn();
	const cleanup = await listenMcpStudio(receive);
	expect(listen).toHaveBeenCalledWith('mcp_studio_request', expect.any(Function));
	const payload = { id: 'request', name: 'studio_read', args: {} };
	const callback = vi.mocked(listen).mock.calls[0][1];
	callback({ id: 1, event: 'mcp_studio_request', payload });
	expect(receive).toHaveBeenCalledWith(payload);
	cleanup();
});
