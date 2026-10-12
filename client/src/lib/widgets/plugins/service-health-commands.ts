import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';
import type { ServiceHealthSnapshot } from '../../core/serviceHealth';
export type ServiceHealth = ServiceHealthSnapshot;
export const checkServiceHealth = (url: string): Promise<ServiceHealth> =>
	invoke(COMMANDS.checkServiceHealth, { url });
