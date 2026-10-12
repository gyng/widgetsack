import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { COMMANDS, EVENTS } from './contract';
import type { McpStudioRequest } from '../llm/mcpStudioController';
export type McpStatus = {
	enabled: boolean;
	browserAccess: boolean;
	running: boolean;
	endpoint: string | null;
	browserUrl: string | null;
	config: unknown;
};
export const mcpStatus = () => invoke<McpStatus>(COMMANDS.mcpStatus);
export const mcpSetPreferences = (enabled: boolean, browserAccess: boolean) =>
	invoke<McpStatus>(COMMANDS.mcpSetPreferences, { enabled, browserAccess });
export const mcpStudioPorts = {
	claim: (requestId: string) => invoke<boolean>(COMMANDS.mcpStudioClaim, { requestId }),
	reply: (requestId: string, result: unknown) =>
		invoke<void>(COMMANDS.mcpStudioReply, { requestId, result })
};
export const listenMcpStudio = (receive: (request: McpStudioRequest) => void) =>
	listen<McpStudioRequest>(EVENTS.mcpStudioRequest, (event) => receive(event.payload));
