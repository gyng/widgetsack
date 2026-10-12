import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import spawn from 'cross-spawn';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { cliReply } from './protocol.mjs';

export function findCli(name) {
	const directories = [...(process.env.PATH || '').split(path.delimiter), path.join(homedir(), '.local', 'bin'), path.join(homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin'), path.join(homedir(), 'AppData', 'Roaming', 'npm')];
	for (const extension of process.platform === 'win32' ? ['.exe', '.cmd'] : [''])
		for (const directory of directories) {
			const file = path.join(directory, name + extension);
			if (directory && existsSync(file)) return file;
		}
	return null;
}

async function models(config) {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi', 'agent');
	const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'), allowModelNetwork: false });
	let settings = {};
	try { settings = JSON.parse(readFileSync(path.join(agentDir, 'settings.json'), 'utf8')); } catch { /* Use SDK defaults. */ }
	if (config?.model && (config.api_key || config.provider === 'ollama')) {
		const api = runtime.getModel(config.provider, config.model)?.api || (config.provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions');
		let baseUrl = config.base_url || (config.provider === 'anthropic' ? 'https://api.anthropic.com' : config.provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.openai.com/v1');
		baseUrl = baseUrl.replace(/\/+$/, '');
		if (config.provider === 'ollama' && !baseUrl.endsWith('/v1')) baseUrl += '/v1';
		runtime.registerProvider('widgetsack', {
			name: 'Studio AI provider', api, apiKey: config.api_key || 'ollama',
			baseUrl,
			models: [{ id: config.model, name: config.model, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192 }]
		});
		settings = { defaultProvider: 'widgetsack', defaultModel: config.model };
	}
	return { runtime, agentDir, settings };
}

export async function status(config) {
	const installedPi = !!findCli('pi');
	const codex = !!findCli('codex');
	const claude = !!findCli('claude');
	let available = [], settings = {}, modelError = '';
	try {
		const loaded = await models(installedPi ? undefined : config);
		available = await loaded.runtime.getAvailable();
		settings = loaded.settings;
	} catch {
		modelError = 'Pi models could not be loaded. You can still select another installed agent.';
	}
	return {
		backends: [{ id: 'pi', label: 'Pi (installed)', available: installedPi }, { id: 'codex', label: 'Codex (installed)', available: codex }, { id: 'claude', label: 'Claude (installed)', available: claude }, { id: 'pi-bundled', label: 'Pi (bundled SDK)', available: true }],
		defaultBackend: installedPi ? 'pi' : codex ? 'codex' : claude ? 'claude' : 'pi-bundled',
		modelError,
		models: available.map((m) => ({ id: `${m.provider}/${m.id}`, label: `${m.provider} / ${m.name}` })),
		defaultModel: settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : ''
	};
}

export function resourceLoader(systemPrompt) {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt, getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
		extendResources: () => {}, reload: async () => {}
	};
}

export async function runPi(request, bridge, send, signal) {
	const { runtime, agentDir, settings } = await models(request.llmConfig);
	let model;
	if (request.model) {
		const slash = request.model.indexOf('/');
		model = runtime.getModel(request.model.slice(0, slash), request.model.slice(slash + 1));
		if (!model) throw new Error('Selected Pi model is not available. Refresh the model list.');
	}
	const customTools = [
		{ name: 'studio_read', label: 'Read studio', description: 'Read current layout, widget types, config fields, and sensors.', parameters: Type.Object({}) },
		{ name: 'studio_apply', label: 'Edit studio', description: 'Apply up to 32 undoable studio actions.', parameters: Type.Object({ ops: Type.Array(Type.Unknown(), { maxItems: 32 }) }) }
	].map((tool) => ({ ...tool, executionMode: 'sequential', execute: async (_id, args, toolSignal) => {
		const result = await bridge.call(tool.name, args, toolSignal);
		return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
	} }));
	const { session } = await createAgentSession({
		cwd: process.cwd(), agentDir, modelRuntime: runtime, model,
		settingsManager: SettingsManager.inMemory({ defaultProvider: settings.defaultProvider, defaultModel: settings.defaultModel, compaction: { enabled: false }, retry: { enabled: false } }),
		sessionManager: SessionManager.inMemory(), resourceLoader: resourceLoader(request.systemPrompt),
		tools: ['studio_read', 'studio_apply'], customTools
	});
	if (!session.model) { session.dispose(); throw new Error('Configure AI Provider in Plugins, or sign in with Pi, then refresh.'); }
	const abort = () => { void session.abort(); };
	const unsubscribe = session.subscribe((event) => {
		if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') send({ type: 'text', text: event.assistantMessageEvent.delta });
		if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.errorMessage) send({ type: 'error', text: event.message.errorMessage });
	});
	signal.addEventListener('abort', abort, { once: true });
	try {
		if (signal.aborted) throw new Error('Stopped');
		await session.prompt(request.prompt);
	} finally { signal.removeEventListener('abort', abort); unsubscribe(); session.dispose(); }
}

export function cliArgs(backend, model, systemPrompt) {
	if (backend === 'pi') return ['--print', '--mode', 'json', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-session', '--system-prompt', systemPrompt, ...(model ? ['--model', model] : [])];
	if (backend === 'codex') return ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--disable', 'shell_tool', '--disable', 'unified_exec', '-c', 'mcp_servers={}', '-c', 'web_search="disabled"', '--json', ...(model ? ['-m', model] : []), '-'];
	return ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--system-prompt', systemPrompt, ...(model ? ['--model', model] : [])];
}

export function executeCli(file, args, input, signal) {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		let output = '', error = '', settled = false;
		const stop = (reason) => { if (settled) return; settled = true; child.kill(); reject(new Error(reason)); };
		const abort = () => stop('Stopped');
		signal.addEventListener('abort', abort, { once: true });
		child.on('error', (err) => stop(err.message));
		child.stdout.on('data', (chunk) => { output += chunk.toString(); if (output.length > 2_000_000) stop('Agent output exceeded the limit'); });
		child.stderr.on('data', (chunk) => { error = (error + chunk.toString()).slice(-8192); });
		child.on('close', (code) => {
			signal.removeEventListener('abort', abort);
			if (settled) return;
			settled = true;
			if (code === 0) resolve(output); else reject(new Error(error || `Agent exited with code ${code}`));
		});
		child.stdin.on('error', () => {});
		child.stdin.end(input);
		if (signal.aborted) abort();
	});
}

export async function runCli(request, bridge, send, signal) {
	const file = findCli(request.backend);
	if (!file) throw new Error(`${request.backend} is not installed`);
	const system = `${request.systemPrompt}\nYou are a studio adapter. Do not call native tools. Reply ONLY with one JSON object: {"tool":"studio_read","args":{}} or {"tool":"studio_apply","args":{"ops":[...]}} or {"message":"reply to the user"}.`;
	let prompt = `${system}\n\n${request.prompt}`;
	for (let turn = 0; turn < 8; turn++) {
		const output = await executeCli(file, cliArgs(request.backend, request.model, system), prompt, signal);
		const reply = cliReply(request.backend, output);
		if (reply.message !== undefined) { send({ type: 'text', text: reply.message }); return; }
		const result = await bridge.call(reply.tool, reply.args, signal);
		prompt += `\nAssistant: ${JSON.stringify(reply)}\nTool result: ${JSON.stringify(result)}`;
		if (prompt.length > 500_000) throw new Error('Studio context exceeded the limit');
	}
	throw new Error('Agent reached the eight-step limit. Continue with a new message.');
}
