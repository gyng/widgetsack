// The stocks Tauri command adapter (outer ring) — every `invoke` behind a typed function, so the
// source + settings panel share the command-name strings and tests can mock this module.

import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';
import type { StocksStatus } from './stocks-types';

export type StocksConfigInput = {
	provider: string;
	symbols: string[];
	pollSeconds: number;
};

/** The (non-secret) config. */
export const stocksConfigStatus = (): Promise<StocksStatus> =>
	invoke<StocksStatus>(COMMANDS.stocksConfigStatus);

/** Persist `plugins/stocks.json`. */
export const saveStocksConfig = (cfg: StocksConfigInput): Promise<void> =>
	invoke(COMMANDS.saveStocksConfig, { ...cfg });

/** Start the poll task iff configured (idempotent). */
export const stocksConnect = (): Promise<void> => invoke(COMMANDS.stocksConnect);

/** Stop the poll task (if any). */
export const stocksDisconnect = (): Promise<void> => invoke(COMMANDS.stocksDisconnect);

/** Atomically replace the app-owned worker with the saved configuration (studio only). */
export const stocksReconnect = (): Promise<void> =>
	invoke(COMMANDS.stocksConnect, { restart: true });
