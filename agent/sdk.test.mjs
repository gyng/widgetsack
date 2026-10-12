import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPi } from './runtime.mjs';

test('the real embedded Pi SDK executes only studio tools against a local provider fixture', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'widgetsack-pi-test-'));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const requests = [];
	const server = createServer(async (request, response) => {
		let body = '';
		for await (const chunk of request) body += chunk;
		requests.push(JSON.parse(body));
		response.writeHead(200, { 'Content-Type': 'text/event-stream' });
		const index = requests.length;
		const delta = index < 3
			? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: { name: index === 1 ? 'studio_read' : 'studio_apply', arguments: index === 1 ? '{}' : '{"ops":[{"op":"addWidget","widgetType":"clock"}]}' } }] }
			: { role: 'assistant', content: 'Added the clock.' };
		response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
		response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: index < 3 ? 'tool_calls' : 'stop' }] })}\n\n`);
		response.end('data: [DONE]\n\n');
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const calls = [], events = [];
	try {
		await runPi({ prompt: 'Add a clock', systemPrompt: 'Use studio_read before studio_apply. Then reply.', model: 'widgetsack/fixture', llmConfig: { provider: 'openai', model: 'fixture', api_key: 'fixture-key', base_url: `http://127.0.0.1:${server.address().port}/v1` } }, {
			call: async (name, args) => { calls.push({ name, args }); return name === 'studio_read' ? { monitorKey: 'primary', widgets: [] } : { applied: 1, addedIds: ['clock'], errors: [] }; }
		}, (event) => events.push(event), new AbortController().signal);
		assert.deepEqual(calls.map((call) => call.name), ['studio_read', 'studio_apply']);
		assert.deepEqual(calls[1].args, { ops: [{ op: 'addWidget', widgetType: 'clock' }] });
		assert.equal(events.filter((event) => event.type === 'text').map((event) => event.text).join(''), 'Added the clock.');
		for (const request of requests) assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), ['studio_apply', 'studio_read']);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('widgetsack-pi-test-')) throw new Error('Refusing unexpected test cleanup path');
		await rm(directory, { recursive: true, force: true });
	}
});
