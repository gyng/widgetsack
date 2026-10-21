import { expect, it, vi } from 'vitest';
import {
	createStudioIntegrationTools,
	decodeIntegrationRequest,
	INTEGRATIONS,
	publicIntegrationStatus
} from './studioIntegrationTools';

const statuses: Record<string, Record<string, unknown>> = {
	'home-assistant': {
		configured: true,
		url: 'https://ha.local',
		base_path: '/proxy',
		insecure: false
	},
	'ai-provider': {
		configured: true,
		active: 'openai',
		providers: {
			openai: {
				baseUrl: 'https://api.example/v1',
				model: 'model-a',
				hasKey: true,
				insecure: false,
				sttModel: 'stt',
				ttsModel: 'tts',
				ttsVoice: 'voice'
			}
		},
		temperature: 0.7,
		maxTokens: 1000,
		agentControl: false
	},
	mqtt: {
		configured: true,
		host: 'broker.local',
		port: 8883,
		username: 'user',
		client_id: 'personal-client',
		topics: ['home/#'],
		tls: true,
		insecure: false,
		discovery: true
	},
	stocks: { configured: true, provider: 'yahoo', symbols: ['NVDA'], pollSeconds: 60 },
	weather: { configured: true, latitude: 1, longitude: 103, unit: 'C', pollSeconds: 1800 },
	rss: {
		configured: true,
		url: 'https://feed.example/rss',
		count: 5,
		title: 'News',
		pollSeconds: 1800
	},
	agenda: { configured: true, host: 'calendar.local', title: 'Calendar', pollSeconds: 1800 }
};
const setup = () => {
	const call = vi.fn(async (command: string, _args?: Record<string, unknown>): Promise<unknown> => {
		const integration = INTEGRATIONS.find((item) => item.status === command);
		return integration ? structuredClone(statuses[integration.id]) : undefined;
	});
	return { call, tool: createStudioIntegrationTools(call) };
};
it('discovers all schemas and redacts secrets and authenticated URLs', async () => {
	const { tool, call } = setup();
	call.mockImplementationOnce(async () => ({
		configured: true,
		url: 'https://user:secret@ha.local/path?token=secret#private',
		token: 'secret',
		basePath: '/path',
		extraSecret: 'secret'
	}));
	const result = (await tool('studio_integrations', {})) as { id: string; status: unknown }[];
	expect(result).toHaveLength(7);
	expect(JSON.stringify(result)).not.toContain('secret');
	expect(result[0].status).toMatchObject({ url: 'https://ha.local/path', configured: true });
	expect(result[1].status).toMatchObject({ providers: { openai: { hasKey: true } } });
	call.mockRejectedValueOnce(new Error('private backend failure'));
	expect(await tool('studio_integrations', {})).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: 'home-assistant', error: 'Status unavailable.' })
		])
	);
	await expect(tool('studio_integrations', { invalid: true })).rejects.toThrow('no arguments');
});
it.each(INTEGRATIONS)(
	'patches $id without clearing omitted settings or returning secrets',
	async (integration) => {
		const { tool, call } = setup();
		const patch = integration.id === 'ai-provider' ? { model: 'model-b' } : {};
		expect(
			await tool('studio_configure_integration', { integration: integration.id, settings: patch })
		).toMatchObject({ persisted: true, undoable: false });
		const args = call.mock.calls.find(([command]) => command === integration.save)?.[1];
		expect(args).toBeDefined();
		for (const [key, field] of Object.entries(integration.fields))
			if (field.writeOnly) expect(args).toHaveProperty(key, '');
		if (integration.id === 'home-assistant')
			expect(args).toMatchObject({ url: 'https://ha.local', basePath: '/proxy', insecure: false });
		if (integration.id === 'ai-provider')
			expect(args).toMatchObject({
				provider: 'openai',
				model: 'model-b',
				baseUrl: 'https://api.example/v1',
				temperature: 0.7,
				maxTokens: 1000,
				agentControl: false
			});
		if (integration.id === 'mqtt')
			expect(args).toMatchObject({ clientId: 'personal-client', topics: ['home/#'], tls: true });
		if (integration.connect)
			expect(call).toHaveBeenCalledWith(integration.connect, { restart: true });
	}
);
it('tests proposed settings without saving, and gives safe failures', async () => {
	const { tool, call } = setup();
	expect(
		await tool('studio_test_integration', {
			integration: 'home-assistant',
			settings: { token: 'new-secret' }
		})
	).toMatchObject({ connected: true, persisted: false });
	expect(call).toHaveBeenCalledWith(
		'ha_test_connection',
		expect.objectContaining({ token: 'new-secret' })
	);
	expect(call).not.toHaveBeenCalledWith('save_ha_config', expect.anything());
	await expect(tool('studio_test_integration', { integration: 'mqtt' })).rejects.toThrow(
		'Direct connection testing'
	);
	call.mockRejectedValueOnce(new Error('credentials=private'));
	const failed = await tool('studio_test_integration', { integration: 'ai-provider' });
	expect(failed).toMatchObject({ persisted: false, error: expect.any(String) });
	expect(JSON.stringify(failed)).not.toContain('private');
	call.mockImplementation(async (command) => {
		if (command === 'ha_connect') throw new Error('private');
		const item = INTEGRATIONS.find((item) => item.status === command);
		return item ? statuses[item.id] : undefined;
	});
	expect(
		await tool('studio_configure_integration', { integration: 'home-assistant', settings: {} })
	).toMatchObject({ persisted: true, error: expect.stringContaining('reconnect failed') });
});
it('handles new AI providers with defaults and omits unexpected provider payloads', async () => {
	const { tool, call } = setup();
	await tool('studio_configure_integration', {
		integration: 'ai-provider',
		settings: {
			provider: 'ollama',
			baseUrl: 'http://localhost:11434',
			model: 'llama',
			insecure: false
		}
	});
	expect(call).toHaveBeenCalledWith(
		'save_llm_config',
		expect.objectContaining({ provider: 'ollama', apiKey: '', sttModel: '' })
	);
	const ai = INTEGRATIONS[1];
	expect(
		publicIntegrationStatus(ai, { providers: { invalid: null }, active: 'none' })
	).toMatchObject({ configured: false, providers: {} });
	expect(publicIntegrationStatus(ai, {})).toMatchObject({ providers: {} });
	expect(
		publicIntegrationStatus(INTEGRATIONS[0], { url: 'broken://[', insecure: false })
	).toMatchObject({ url: '[invalid URL]' });
});
it('serializes mutations, skips cancelled queued reads and finishes a committed restart', async () => {
	const { tool, call } = setup();
	let release!: () => void;
	call.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = () => resolve(statuses['home-assistant']);
			})
	);
	const abort = new AbortController();
	const first = tool(
		'studio_configure_integration',
		{ integration: 'home-assistant', settings: {} },
		abort.signal
	);
	await vi.waitFor(() => expect(release).toBeDefined());
	abort.abort();
	release();
	expect(await first).toMatchObject({ persisted: false });
	expect(call).not.toHaveBeenCalledWith('save_ha_config', expect.anything());
	await expect(tool('studio_integrations', {}, abort.signal)).rejects.toThrow('cancelled');
	const secondAbort = new AbortController();
	call.mockImplementation(async (command) => {
		if (command === 'save_ha_config') secondAbort.abort();
		return command === 'ha_config_status' ? statuses['home-assistant'] : undefined;
	});
	await tool(
		'studio_configure_integration',
		{ integration: 'home-assistant', settings: {} },
		secondAbort.signal
	);
	expect(call).toHaveBeenCalledWith('ha_connect', { restart: true });
	await expect(tool('unknown', {})).rejects.toThrow('Unknown integration tool');
});
it('validates supported fields and boundaries before touching credentials', () => {
	for (const args of [
		null,
		[],
		{},
		{ integration: 'bad' },
		{ integration: 'mqtt', other: 1 },
		{ integration: 'mqtt', settings: [] },
		{ integration: 'mqtt', settings: { unknown: 1 } },
		{ integration: 'mqtt', settings: { port: 0 } },
		{ integration: 'mqtt', settings: { port: 65536 } },
		{ integration: 'mqtt', settings: { port: NaN } },
		{ integration: 'mqtt', settings: { tls: 'yes' } },
		{ integration: 'mqtt', settings: { topics: [1] } },
		{ integration: 'mqtt', settings: { topics: Array(257).fill('x') } },
		{ integration: 'mqtt', settings: { host: 'x'.repeat(8193) } },
		{ integration: 'weather', settings: { unit: 'invalid' } },
		{ integration: 'mqtt', settings: JSON.parse('{"__proto__":true}') }
	])
		expect(() => decodeIntegrationRequest(args)).toThrow();
	expect(
		decodeIntegrationRequest({
			integration: 'mqtt',
			settings: { host: 'localhost', port: 1883, tls: false, topics: ['a/#'] }
		}).settings
	).toMatchObject({ port: 1883 });
	expect(
		decodeIntegrationRequest({
			integration: 'weather',
			settings: { latitude: 0, longitude: 0, unit: 'F', pollSeconds: 60 }
		}).settings
	).toHaveProperty('unit', 'F');
});

it('does not write malformed saved settings and redacts nullable or unqualified URLs safely', async () => {
	expect(publicIntegrationStatus(INTEGRATIONS[0], { url: null })).toMatchObject({ url: null });
	expect(publicIntegrationStatus(INTEGRATIONS[0], { url: 'ha.local' })).toMatchObject({
		url: 'ha.local'
	});
	const call = vi.fn(
		async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => ({})
	);
	const tool = createStudioIntegrationTools(call);
	expect(
		await tool('studio_configure_integration', { integration: 'weather', settings: {} })
	).toMatchObject({ persisted: false });
	expect(call).not.toHaveBeenCalledWith('save_weather_config', expect.anything());
	call.mockResolvedValueOnce({
		configured: true,
		active: 'ollama',
		providers: {},
		temperature: 0.7,
		maxTokens: 1000,
		agentControl: false
	});
	expect(
		await tool('studio_test_integration', {
			integration: 'ai-provider',
			settings: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'local' }
		})
	).toMatchObject({ connected: true });
});
