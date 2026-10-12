import { decodeStudioOps, type StudioOp } from '../core/studioAssistant';
import type { StudioSnapshot } from './studioAgentSession';
import type { StudioApplyResult } from '../widgets/plugin';
import type { StudioVerification } from '../core/studioVerification';
export type McpStudioRequest = { id: string; name: string; args: unknown };
export function createMcpStudioController(
	ports: { claim(id: string): Promise<boolean>; reply(id: string, result: unknown): Promise<void> },
	studio: {
		read(): StudioSnapshot;
		apply(ops: StudioOp[], expected: StudioSnapshot): StudioApplyResult;
		verify(expected: StudioSnapshot): Promise<StudioVerification>;
	}
) {
	const snapshots = new Map<string, StudioSnapshot>();
	let disposed = false;
	let queue = Promise.resolve();
	const execute = async (request: McpStudioRequest) => {
		if (disposed || !(await ports.claim(request.id)) || disposed) return;
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
			} else if (request.name === 'studio_verify') result = await studio.verify(studio.read());
			else throw new Error('Unknown studio tool.');
		} catch (error) {
			result = { error: String(error) };
		}
		if (!disposed) await ports.reply(request.id, result);
	};
	return {
		handle(request: McpStudioRequest) {
			const next = queue.then(() => execute(request));
			queue = next.catch(() => {});
			return next;
		},
		dispose() {
			disposed = true;
			snapshots.clear();
		}
	};
}
