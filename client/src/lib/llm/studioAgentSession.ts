import { decodeStudioOps, STUDIO_AGENT_INSTRUCTIONS, type StudioOp } from '../core/studioAssistant';
import type { StudioVerification } from '../core/studioVerification';
import type { MonitorLayout } from '../core/layoutTree';
import type { StudioApplyResult } from '../widgets/plugin';

export type AgentEvent =
	| { type: 'text'; text: string }
	| { type: 'error'; text: string }
	| { type: 'tool'; id: string; name: string; args: unknown };
export type AgentRequest = {
	requestId: string;
	backend: string;
	model: string;
	prompt: string;
	systemPrompt: string;
};
export type StudioSnapshot = {
	monitorKey: string;
	monitor: MonitorLayout;
	editorTarget?: string;
	editable?: boolean;
	[key: string]: unknown;
};
export type AgentPorts = {
	run(request: AgentRequest, receive: (event: AgentEvent) => void): Promise<void>;
	reply(requestId: string, toolId: string, result: unknown): Promise<void>;
	cancel(requestId: string): Promise<void>;
};
export type AgentState = {
	messages: { role: 'user' | 'assistant'; text: string }[];
	actions: string[];
	busy: boolean;
	error: string;
};
export const emptyAgentState = (): AgentState => ({
	messages: [],
	actions: [],
	busy: false,
	error: ''
});

/** One sidebar owns one run. Late callbacks cannot edit a different monitor or an unmounted editor. */
export function createStudioAgentSession(
	ports: AgentPorts,
	studio: {
		read(): StudioSnapshot;
		apply(ops: StudioOp[], expected: StudioSnapshot): StudioApplyResult;
		verify?(expected: StudioSnapshot): Promise<StudioVerification>;
	},
	publish: (state: AgentState) => void,
	makeId: () => string
) {
	let state = emptyAgentState();
	let active: { id: string; target: string; expected: StudioSnapshot | null } | null = null;
	let disposed = false;
	let stopping: Promise<void> | null = null;
	const update = (patch: Partial<AgentState>) => {
		state = { ...state, ...patch };
		if (!disposed) publish(state);
	};
	const stop = () => {
		const run = active;
		active = null;
		if (run) stopping = ports.cancel(run.id).catch(() => {});
		update({ busy: false });
	};
	const send = async (text: string, backend: string, model: string) => {
		if (active || disposed || !text.trim()) return;
		if (stopping) {
			await stopping;
			if (active || disposed) return;
		}
		const snapshot = studio.read();
		const run = {
			id: makeId(),
			target: snapshot.editorTarget ?? snapshot.monitorKey,
			expected: null as StudioSnapshot | null
		};
		active = run;
		const history = state.messages.slice(-12);
		update({
			messages: [
				...state.messages,
				{ role: 'user', text: text.trim() },
				{ role: 'assistant', text: '' }
			],
			actions: [],
			busy: true,
			error: ''
		});
		const receive = (event: AgentEvent) => {
			if (active !== run) return;
			if (event.type === 'text') {
				update({
					messages: state.messages.map((message, i) =>
						i === state.messages.length - 1
							? { ...message, text: message.text + event.text }
							: message
					)
				});
			} else if (event.type === 'error') update({ error: event.text });
			else {
				let result: unknown;
				try {
					const current = studio.read();
					if ((current.editorTarget ?? current.monitorKey) !== run.target)
						throw new Error(
							'The active monitor changed or the editor target changed. Send a new request.'
						);
					if (event.name === 'studio_read') {
						run.expected = current;
						result = current;
					} else if (event.name === 'studio_apply') {
						if (current.editable === false) throw new Error('This editor target is read-only.');
						if (!run.expected) throw new Error('Read the studio before editing.');
						const ops = decodeStudioOps((event.args as { ops?: unknown } | null)?.ops);
						result = studio.apply(ops, run.expected);
						run.expected = null;
						const applied = result as StudioApplyResult;
						update({
							actions: [
								...state.actions,
								`${applied.applied} action(s) applied${applied.errors.length ? ` · ${applied.errors.join('; ')}` : ''}`
							]
						});
					} else if (event.name === 'studio_verify') {
						if (!studio.verify) throw new Error('Rendered verification is unavailable.');
						void studio
							.verify(current)
							.then((result) => {
								if (active !== run) return;
								update({
									actions: [
										...state.actions,
										`${result.checked} layout node(s) checked · ${result.issues.length} issue(s) · visual review required`
									]
								});
								return ports.reply(run.id, event.id, result);
							})
							.catch((error) => {
								if (active === run) {
									update({ error: String(error) });
									void ports.reply(run.id, event.id, { error: String(error) }).catch(() => {});
								}
							});
						return;
					} else throw new Error('Unknown studio tool');
				} catch (error) {
					result = { error: String(error) };
					update({ error: String(error) });
				}
				void ports.reply(run.id, event.id, result).catch((error) => {
					if (active === run) update({ error: String(error) });
				});
			}
		};
		try {
			await ports.run(
				{
					requestId: run.id,
					backend,
					model,
					systemPrompt: STUDIO_AGENT_INSTRUCTIONS,
					prompt: JSON.stringify({
						conversation: history,
						request: text.trim(),
						monitor: snapshot.monitorKey
					})
				},
				receive
			);
		} catch (error) {
			if (active === run) update({ error: String(error) });
		} finally {
			if (active === run) {
				active = null;
				update({ busy: false });
			}
		}
	};
	return {
		send,
		stop,
		reset() {
			stop();
			update(emptyAgentState());
		},
		dispose() {
			disposed = true;
			stop();
		}
	};
}
