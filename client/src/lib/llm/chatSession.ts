// One window-local chat session owns the bridge and every request in the shared transcript.
import { pushUser, startTurn, toMessages } from '../core/llm';
import { handleDelta, llmStore, resetChat } from '../../stores/llmStore';
import { llmCancel, llmStream } from '../widgets/plugins/llm-commands';
import { startLlmSource } from './source';
import { disposalScope } from '../core/disposalScope';

let refs = 0;
let epoch = 0;
let seq = 0;
const namespace = crypto.randomUUID();
let ready: Promise<void> | null = null;
let stop: (() => void) | null = null;
type Request = { cancelled: boolean; started: boolean };
const requests = new Map<string, Request>();
const cancelRemote = (id: string) => {
	void Promise.resolve(llmCancel(id)).catch(() => undefined);
};

export function cancelChatRequest(id: string): void {
	const request = requests.get(id);
	if (request) {
		request.cancelled = true;
		if (request.started) cancelRemote(id);
		requests.delete(id);
	} else cancelRemote(id);
	handleDelta({ requestId: id, token: '', done: true });
}
function cancelAll(): void {
	epoch++;
	for (const [id, request] of requests) {
		if (llmStore.getSnapshot().turns.some((t) => t.id === id && t.streaming)) cancelChatRequest(id);
		else request.cancelled = true;
	}
	requests.clear();
}
export function resetChatSession(): void {
	cancelAll();
	resetChat();
}

export function acquireChatSession(): () => void {
	refs++;
	if (refs === 1) {
		const scope = disposalScope((error) => console.warn('chat listener cleanup failed', error));
		ready = startLlmSource().then((release) => scope.add(release));
		// send awaits and reports attachment failures; prevent an unhandled rejection before a send.
		void ready.catch(() => undefined);
		stop = scope.dispose;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (--refs !== 0) return;
		cancelAll();
		stop?.();
		stop = null;
		ready = null;
	};
}

export async function sendChat(text: string): Promise<string> {
	const trimmed = text.trim();
	if (!trimmed || !ready) return '';
	const at = epoch;
	const id = 'chat-' + namespace + '-' + ++seq;
	const request: Request = { cancelled: false, started: false };
	requests.set(id, request);
	llmStore.update((s) => startTurn(pushUser(s, 'u-' + id, trimmed), id));
	const messages = toMessages(llmStore.getSnapshot());
	try {
		await ready;
		if (request.cancelled || at !== epoch) return id;
		await llmStream(id, messages);
		request.started = true;
		if (request.cancelled || at !== epoch) cancelRemote(id);
	} catch (error) {
		if (!request.cancelled && at === epoch)
			handleDelta({ requestId: id, token: '', done: true, error: String(error) });
		requests.delete(id);
	}
	return id;
}
