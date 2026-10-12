import { COMMANDS } from '../../bridge/contract';
import { invoke } from '@tauri-apps/api/core';
import type { CommandResult } from '../../core/commandResult';
export type { CommandResult };
export const runWidgetCommand = (command: string): Promise<CommandResult> =>
	invoke(COMMANDS.runWidgetCommand, { command });
