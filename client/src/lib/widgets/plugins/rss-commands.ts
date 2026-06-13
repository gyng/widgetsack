// The RSS Tauri command adapter (outer ring) — every `invoke` behind a typed function so the source +
// settings panel share the command-name strings and tests can mock this module.

import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';
import type { RssStatus } from './rss-types';

export type RssConfigInput = {
	url: string;
	count: number;
	title: string;
	pollSeconds: number;
};

/** The (non-secret) config. */
export const rssConfigStatus = (): Promise<RssStatus> =>
	invoke<RssStatus>(COMMANDS.rssConfigStatus);

/** Persist `plugins/rss.json`. */
export const saveRssConfig = (cfg: RssConfigInput): Promise<void> =>
	invoke(COMMANDS.saveRssConfig, { ...cfg });

/** Start the poll task (idempotent; demand-gated server-side). */
export const rssConnect = (): Promise<void> => invoke(COMMANDS.rssConnect);

/** Stop the poll task (if any). */
export const rssDisconnect = (): Promise<void> => invoke(COMMANDS.rssDisconnect);
