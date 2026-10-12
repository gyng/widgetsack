export class ToolBridge {
	#pending = new Map();
	#next = 0;
	constructor(send) { this.send = send; }
	call(name, args, signal) {
		if (signal?.aborted) return Promise.reject(new Error('Stopped'));
		const id = String(++this.#next);
		return new Promise((resolve, reject) => {
			const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#pending.delete(id); };
			const abort = () => { clean(); reject(new Error('Stopped')); };
			const timer = setTimeout(() => { clean(); reject(new Error('Studio did not answer the tool request')); }, 30_000);
			this.#pending.set(id, (result) => { clean(); resolve(result); });
			signal?.addEventListener('abort', abort, { once: true });
			this.send({ type: 'tool', id, name, args });
		});
	}
	resolve(id, result) { this.#pending.get(id)?.(result); }
}

export function cliReply(backend, output) {
	let text;
	if (backend === 'claude') {
		const result = JSON.parse(output);
		if (result.is_error) throw new Error(result.result || 'Claude request failed');
		text = result.result;
	} else {
		for (const line of output.split('\n').filter(Boolean)) {
			const event = JSON.parse(line);
			if (backend === 'pi' && event.type === 'message_end' && event.message?.role === 'assistant') {
				if (['error', 'aborted'].includes(event.message.stopReason)) throw new Error(event.message.errorMessage || 'Pi request failed');
				text = event.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
			}
			if (event.type === 'turn.failed' || event.type === 'error') throw new Error(event.error?.message || event.message || 'Codex request failed');
			if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
		}
	}
	if (typeof text !== 'string' || !text.trim()) throw new Error('Agent returned no reply');
	try {
		const reply = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
		if (['studio_read', 'studio_apply'].includes(reply.tool) && reply.args && typeof reply.args === 'object') return reply;
		if (typeof reply.message === 'string') return { message: reply.message };
	} catch { /* A plain conversational reply is also valid. */ }
	return { message: text };
}
