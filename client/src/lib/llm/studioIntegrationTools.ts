import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../bridge/contract';

type Field = {
	type: 'string' | 'number' | 'boolean' | 'array';
	writeOnly?: boolean;
	minimum?: number;
	maximum?: number;
	enum?: string[];
};
type Integration = {
	id: string;
	status: string;
	save: string;
	connect?: string;
	test?: string;
	fields: Record<string, Field>;
};
const string: Field = { type: 'string' };
const secret: Field = { type: 'string', writeOnly: true };
const boolean: Field = { type: 'boolean' };
const polling: Field = { type: 'number', minimum: 1, maximum: 86400 };
export const INTEGRATIONS: Integration[] = [
	{
		id: 'home-assistant',
		status: COMMANDS.haConfigStatus,
		save: COMMANDS.saveHaConfig,
		connect: COMMANDS.haConnect,
		test: COMMANDS.haTestConnection,
		fields: { url: string, token: secret, insecure: boolean, basePath: string }
	},
	{
		id: 'ai-provider',
		status: COMMANDS.llmConfigStatus,
		save: COMMANDS.saveLlmConfig,
		test: COMMANDS.llmTestConnection,
		fields: {
			provider: string,
			baseUrl: string,
			apiKey: secret,
			model: string,
			insecure: boolean,
			temperature: { type: 'number', minimum: 0, maximum: 2 },
			maxTokens: { type: 'number', minimum: 1, maximum: 1048576 },
			sttModel: string,
			ttsModel: string,
			ttsVoice: string
		}
	},
	{
		id: 'mqtt',
		status: COMMANDS.mqttConfigStatus,
		save: COMMANDS.saveMqttConfig,
		connect: COMMANDS.mqttConnect,
		fields: {
			host: string,
			port: { type: 'number', minimum: 1, maximum: 65535 },
			username: string,
			password: secret,
			clientId: string,
			topics: { type: 'array' },
			tls: boolean,
			insecure: boolean,
			discovery: boolean
		}
	},
	{
		id: 'stocks',
		status: COMMANDS.stocksConfigStatus,
		save: COMMANDS.saveStocksConfig,
		connect: COMMANDS.stocksConnect,
		fields: { provider: string, symbols: { type: 'array' }, pollSeconds: polling }
	},
	{
		id: 'weather',
		status: COMMANDS.weatherConfigStatus,
		save: COMMANDS.saveWeatherConfig,
		connect: COMMANDS.weatherConnect,
		fields: {
			latitude: { type: 'number', minimum: -90, maximum: 90 },
			longitude: { type: 'number', minimum: -180, maximum: 180 },
			unit: { type: 'string', enum: ['C', 'F'] },
			pollSeconds: polling
		}
	},
	{
		id: 'rss',
		status: COMMANDS.rssConfigStatus,
		save: COMMANDS.saveRssConfig,
		connect: COMMANDS.rssConnect,
		fields: {
			url: string,
			count: { type: 'number', minimum: 1, maximum: 100 },
			title: string,
			pollSeconds: polling
		}
	},
	{
		id: 'agenda',
		status: COMMANDS.agendaConfigStatus,
		save: COMMANDS.saveAgendaConfig,
		connect: COMMANDS.agendaConnect,
		fields: { url: secret, title: string, pollSeconds: polling }
	}
];
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);

/** Validate patches before accessing settings. Errors never echo supplied values or credentials. */
export function decodeIntegrationRequest(args: unknown) {
	if (!object(args) || Object.keys(args).some((key) => !['integration', 'settings'].includes(key)))
		throw new Error('Expected integration and optional settings.');
	const integration = INTEGRATIONS.find((item) => item.id === args.integration);
	if (!integration)
		throw new Error('Unknown integration. Use studio_integrations for supported IDs.');
	const settings = args.settings ?? {};
	if (!object(settings)) throw new Error('Settings must be an object.');
	for (const [key, value] of Object.entries(settings)) {
		const field = integration.fields[key];
		if (!Object.hasOwn(integration.fields, key) || !field)
			throw new Error('Unsupported settings field.');
		const valid =
			field.type === 'array'
				? Array.isArray(value) &&
					value.length <= 256 &&
					value.every((item) => typeof item === 'string' && item.length <= 8192)
				: typeof value === field.type && (typeof value !== 'string' || value.length <= 8192);
		if (
			!valid ||
			(typeof value === 'number' &&
				(!Number.isFinite(value) || value < field.minimum! || value > field.maximum!)) ||
			(field.enum && !field.enum.includes(value as string))
		)
			throw new Error(`Invalid setting: ${key}.`);
	}
	return { integration, settings };
}

function safeUrl(value: unknown): unknown {
	if (typeof value !== 'string' || !value.includes('://')) return value;
	try {
		const url = new URL(value);
		url.username = '';
		url.password = '';
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch {
		return '[invalid URL]';
	}
}

/** Copy only declared non-secret fields; backend additions cannot accidentally expose credentials. */
export function publicIntegrationStatus(integration: Integration, status: Record<string, unknown>) {
	status =
		integration.id === 'home-assistant'
			? { ...status, basePath: status.base_path }
			: integration.id === 'mqtt'
				? { ...status, clientId: status.client_id }
				: status;
	const result: Record<string, unknown> = { configured: status.configured === true };
	for (const [key, field] of Object.entries(integration.fields)) {
		if (field.writeOnly || (key === 'provider' && integration.id === 'ai-provider')) continue;
		if (Object.hasOwn(status, key))
			result[key] = /url/i.test(key) ? safeUrl(status[key]) : status[key];
	}
	if (integration.id === 'ai-provider') {
		result.active = status.active;
		const providers = object(status.providers) ? status.providers : {};
		result.providers = Object.fromEntries(
			Object.entries(providers)
				.filter(([, provider]) => object(provider))
				.map(([id, provider]) => {
					const info = provider as Record<string, unknown>;
					return [
						id,
						{
							baseUrl: safeUrl(info.baseUrl),
							model: info.model,
							hasKey: info.hasKey === true,
							insecure: info.insecure === true,
							sttModel: info.sttModel,
							ttsModel: info.ttsModel,
							ttsVoice: info.ttsVoice
						}
					];
				})
		);
	}
	return result;
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** One queue for both MCP and the sidebar. Cancellation cannot let a later save overtake an issued write. */
export function createStudioIntegrationTools(call: Invoke = invoke) {
	let queue: Promise<unknown> = Promise.resolve();
	return (name: string, args: unknown, signal?: AbortSignal): Promise<unknown> => {
		const execute = async () => {
			const check = () => {
				if (signal?.aborted) throw new Error('Integration request cancelled.');
			};
			check();
			if (name === 'studio_integrations') {
				if (!object(args) || Object.keys(args).length)
					throw new Error('studio_integrations takes no arguments.');
				return Promise.all(
					INTEGRATIONS.map(async (integration) => {
						try {
							const status = (await call(integration.status)) as Record<string, unknown>;
							return {
								id: integration.id,
								fields: integration.fields,
								canTest: !!integration.test,
								status: publicIntegrationStatus(integration, status)
							};
						} catch {
							return {
								id: integration.id,
								fields: integration.fields,
								canTest: !!integration.test,
								error: 'Status unavailable.'
							};
						}
					})
				);
			}
			if (name !== 'studio_configure_integration' && name !== 'studio_test_integration')
				throw new Error('Unknown integration tool.');
			const { integration, settings } = decodeIntegrationRequest(args);
			if (name === 'studio_test_integration' && !integration.test)
				throw new Error(
					'Direct connection testing is available for home-assistant and ai-provider. Other integrations reconnect after saving; use telemetry for readiness.'
				);
			let persisted = false;
			try {
				const status = (await call(integration.status)) as Record<string, unknown>;
				check();
				let current = status;
				if (integration.id === 'ai-provider') {
					const provider = (settings.provider ?? status.active) as string;
					const providers = status.providers as Record<string, Record<string, unknown>>;
					current = { ...status, ...providers[provider], provider };
				}
				if (integration.id === 'home-assistant')
					current = { ...current, basePath: status.base_path };
				if (integration.id === 'mqtt') current = { ...current, clientId: status.client_id };
				const config = Object.fromEntries(
					Object.entries(integration.fields).map(([key, field]) => [
						key,
						Object.hasOwn(settings, key)
							? settings[key]
							: field.writeOnly
								? ''
								: (current[key] ??
									(field.type === 'string' ? '' : field.type === 'boolean' ? false : null))
					])
				);
				decodeIntegrationRequest({ integration: integration.id, settings: config });
				if (name === 'studio_test_integration') {
					await call(integration.test!, config);
					return { integration: integration.id, connected: true, persisted: false };
				}
				// agentControl is deliberately not writable through this capability.
				if (integration.id === 'ai-provider') config.agentControl = status.agentControl;
				await call(integration.save, config);
				persisted = true;
				// Finish a committed save's restart even if its client has since cancelled.
				if (integration.connect) await call(integration.connect, { restart: true });
				return {
					integration: integration.id,
					persisted: true,
					restartRequested: !!integration.connect,
					undoable: false
				};
			} catch {
				return {
					integration: integration.id,
					persisted,
					error: persisted
						? 'Settings saved; reconnect failed. Retry from Integration settings.'
						: 'Could not complete the request. Check required fields and credentials. A changed server requires new credentials; existing credentials are never returned.'
				};
			}
		};
		const next = queue.then(execute);
		queue = next.catch(() => {});
		return next;
	};
}

// Shared across consumers so the MCP transport and sidebar cannot race their own settings writes.
export const studioIntegrationTool = createStudioIntegrationTools();
