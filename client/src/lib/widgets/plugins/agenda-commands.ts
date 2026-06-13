// The Agenda Tauri command adapter (outer ring) — every `invoke` behind a typed function so the source
// + settings panel share the command-name strings and tests can mock this module.

import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';
import type { AgendaStatus } from './agenda-types';

export type AgendaConfigInput = {
	url: string;
	title: string;
	pollSeconds: number;
};

export const agendaConfigStatus = (): Promise<AgendaStatus> =>
	invoke<AgendaStatus>(COMMANDS.agendaConfigStatus);

export const saveAgendaConfig = (cfg: AgendaConfigInput): Promise<void> =>
	invoke(COMMANDS.saveAgendaConfig, { ...cfg });

export const agendaConnect = (): Promise<void> => invoke(COMMANDS.agendaConnect);

export const agendaDisconnect = (): Promise<void> => invoke(COMMANDS.agendaDisconnect);
