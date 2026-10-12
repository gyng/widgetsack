import { Channel, invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';
import type { AgentEvent, AgentPorts } from '../../llm/studioAgentSession';
export type AgentStatus = {
	defaultBackend: string;
	models?: Record<string, string[]>;
	backends: { id: string; label: string; available: boolean }[];
};
export const studioAgentStatus = () => invoke<AgentStatus>(COMMANDS.studioAgentStatus);
export const studioAgentPorts: AgentPorts = {
	run(request, receive) {
		const channel = new Channel<AgentEvent>();
		channel.onmessage = receive;
		return invoke(COMMANDS.studioAgentRun, { ...request, channel });
	},
	reply: (requestId, toolId, result) =>
		invoke(COMMANDS.studioAgentReply, { requestId, toolId, result }),
	cancel: (requestId) => invoke(COMMANDS.studioAgentCancel, { requestId })
};
