import { decodeStudioOps, type StudioOp } from '../core/studioAssistant';
import type { StudioSnapshot } from './studioAgentSession';
import type { StudioApplyResult } from '../widgets/plugin';
import type { StudioVerification } from '../core/studioVerification';
export type McpStudioRequest =
	| { id: string; name: string; args: unknown; cancelled?: false }
	| { id: string; cancelled: true };
type ToolRequest = Extract<McpStudioRequest, { name: string }>;

async function whileActive<T>(task: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	let abort!: () => void;
	const cancelled = new Promise<undefined>((resolve) => {
		abort = () => resolve(undefined);
		signal.addEventListener('abort', abort, { once: true });
	});
	try {
		return await Promise.race([task, cancelled]);
	} finally {
		signal.removeEventListener('abort', abort);
	}
}
export function createMcpStudioController(
	ports: { claim(id: string): Promise<boolean>; reply(id: string, result: unknown): Promise<void> },
	studio: {
		read(): StudioSnapshot;
		apply(ops: StudioOp[], expected: StudioSnapshot): StudioApplyResult;
		verify(expected: StudioSnapshot, signal?: AbortSignal): Promise<StudioVerification>;
	}
) {
	const snapshots = new Map<string, StudioSnapshot>();
	const pending = new Map<string, AbortController>();
	let disposed = false;
	let queue = Promise.resolve();
	const execute = async (request: ToolRequest, signal: AbortSignal) => {
		if (disposed || signal.aborted) return;
		if (!(await whileActive(ports.claim(request.id), signal)) || disposed || signal.aborted) return;
		let result: unknown;
		try {
			if (request.name === 'studio_read') {
				const snapshot = studio.read();
				if (snapshots.size >= 16) snapshots.clear();
				snapshots.set(request.id, snapshot);
				result = { ...snapshot, revision: request.id };
			} else if (request.name === 'studio_apply') {
				const args = request.args as { revision?: string; ops?: unknown } | null;
				const expected = args?.revision ? snapshots.get(args.revision) : undefined;
				if (!expected)
					throw new Error(
						'Read the studio again before editing; the revision is missing or expired.'
					);
				if (expected.editable === false) throw new Error('This editor target is read-only.');
				const ops = decodeStudioOps(args?.ops);
				snapshots.delete(args!.revision!);
				result = studio.apply(ops, expected);
			} else if (request.name === 'studio_verify')
				result = await whileActive(studio.verify(studio.read(), signal), signal);
			else throw new Error('Unknown studio tool.');
		} catch (error) {
			result = { error: String(error) };
		}
		if (!disposed && !signal.aborted) await whileActive(ports.reply(request.id, result), signal);
	};
	return {
		handle(request: McpStudioRequest) {
			if (request.cancelled) {
				pending.get(request.id)?.abort();
				snapshots.delete(request.id);
				return Promise.resolve();
			}
			if (disposed || pending.has(request.id)) return Promise.resolve();
			const controller = new AbortController();
			pending.set(request.id, controller);
			const next = queue
				.then(() => execute(request, controller.signal))
				.finally(() => pending.delete(request.id));
			queue = next.catch(() => {});
			return next;
		},
		dispose() {
			disposed = true;
			for (const controller of pending.values()) controller.abort();
			pending.clear();
			snapshots.clear();
		}
	};
}
