import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolBridge, cliReply } from './protocol.mjs';
import { cliArgs, resourceLoader } from './runtime.mjs';

test('tool results correlate by ID and cancellation discards late replies', async () => {
	const sent = [];
	const bridge = new ToolBridge((message) => sent.push(message));
	const signal = new AbortController();
	const pending = bridge.call('studio_read', {}, signal.signal);
	bridge.resolve('unrelated', {});
	bridge.resolve(sent[0].id, { monitor: 'primary' });
	assert.deepEqual(await pending, { monitor: 'primary' });
	const stopped = bridge.call('studio_apply', { ops: [] }, signal.signal);
	signal.abort();
	await assert.rejects(stopped, /Stopped/);
	bridge.resolve(sent[1].id, { applied: 1 });
	await assert.rejects(bridge.call('studio_read', {}, signal.signal), /Stopped/);
});
test('installed backends preserve structured actions and report failures', () => {
	assert.deepEqual(cliReply('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"tool":"studio_read","args":{}}' } })), { tool: 'studio_read', args: {} });
	assert.deepEqual(cliReply('claude', '{"result":"{\\"message\\":\\"Done\\"}"}'), { message: 'Done' });
	assert.throws(() => cliReply('codex', '{"type":"turn.failed","error":{"message":"bad"}}'), /bad/);
	assert.throws(() => cliReply('claude', '{"is_error":true,"result":"login required"}'), /login required/);
	assert.throws(() => cliReply('codex', ''), /no reply/);
});
test('the embedded SDK has no discovered code or files and only explicit resources', () => {
	const loader = resourceLoader('studio only');
	assert.equal(loader.getSystemPrompt(), 'studio only');
	assert.deepEqual(loader.getExtensions().extensions, []);
	assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
	assert.deepEqual(loader.getSkills().skills, []);
	assert.equal(cliArgs('codex', '', '').includes('read-only'), true);
	assert.equal(cliArgs('pi', '', '').includes('--no-tools'), true);
	assert.deepEqual(cliReply('pi', JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '{"message":"Hello"}' }] } })), { message: 'Hello' });
	const claude = cliArgs('claude', '', 'studio');
	assert.equal(claude[claude.indexOf('--tools') + 1], '');
});
