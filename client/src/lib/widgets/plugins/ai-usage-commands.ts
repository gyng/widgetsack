import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';
import { parseUsage, type UsageProvider, type UsageSnapshot } from '../../core/aiUsage';

export async function readAiUsage(provider: UsageProvider, timeout = 20): Promise<UsageSnapshot> {
	const raw = await invoke<Record<string, unknown>>(COMMANDS.readAiUsage, {
		request: {
			source: provider.source,
			command: provider.command,
			env: provider.env,
			account: provider.account,
			timeout
		}
	});
	// Claude's external usage endpoint returns ISO times; our domain uses milliseconds.
	if (Array.isArray(raw.metrics))
		raw.metrics = raw.metrics.map((value: Record<string, unknown>) => {
			if (typeof value.resetIso !== 'string') return value;
			const ts = Date.parse(value.resetIso);
			return { ...value, ...(Number.isFinite(ts) ? { resetsAt: ts } : {}) };
		});
	return parseUsage(raw);
}
