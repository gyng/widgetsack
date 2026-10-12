import { createInterface } from 'node:readline';
import { ToolBridge } from './protocol.mjs';
import { runPi, runCli, status } from './runtime.mjs';
const input = createInterface({ input: process.stdin });
const controller = new AbortController();
let secret = '';
const send = (event) => {
	if (secret && typeof event.text === 'string') event = { ...event, text: event.text.split(secret).join('[redacted]') };
	process.stdout.write(JSON.stringify(event) + '\n');
};
const bridge = new ToolBridge(send);
let started = false;
input.on('close', () => controller.abort());
input.on('line', (line) => {
	try {
		const message = JSON.parse(line);
		if (message.type === 'reply') { bridge.resolve(message.id, message.result); return; }
		if (message.type === 'cancel') { controller.abort(); return; }
		if (started) return;
		started = true;
		secret = message.llmConfig?.api_key || '';
		void (async () => {
			try {
				if (message.type === 'status') send({ type: 'status', result: await status(message.llmConfig) });
				else if (message.backend === 'pi-bundled') await runPi(message, bridge, send, controller.signal);
				else if (['pi', 'codex', 'claude'].includes(message.backend)) await runCli(message, bridge, send, controller.signal);
				else throw new Error('Unknown studio agent backend');
			} catch (error) {
				const secret = message.llmConfig?.api_key;
				let text = String(error?.message || error);
				if (secret) text = text.split(secret).join('[redacted]');
				send({ type: 'error', text });
			} finally { send({ type: 'done' }); process.exit(0); }
		})();
	} catch { send({ type: 'error', text: 'Invalid agent protocol message' }); process.exit(1); }
});
