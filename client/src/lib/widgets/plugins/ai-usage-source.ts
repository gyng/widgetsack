// Browser persistence and command activation stay outside the pure model. Shared origin storage
// lets studio and overlays merge samples rather than overwrite each other's history.
import {
	appendUsageHistory,
	parseUsage,
	usageSourceKey,
	type UsagePoint,
	type UsageProvider,
	type UsageSnapshot
} from '../../core/aiUsage';
const prefix = 'np.aiusage.history.';
const approvals = 'np.aiusage.commands';
export function commandApproved(p: UsageProvider): boolean {
	if (!p.command && p.source !== 'command') return true;
	try {
		return (JSON.parse(localStorage.getItem(approvals) ?? '[]') as unknown[]).includes(p.command);
	} catch {
		return false;
	}
}
export function approveUsageCommand(p: UsageProvider): void {
	let values: string[] = [];
	try {
		const data: unknown = JSON.parse(localStorage.getItem(approvals) ?? '[]');
		if (Array.isArray(data)) values = data.filter((v): v is string => typeof v === 'string');
	} catch {
		/* start a fresh local list */
	}
	localStorage.setItem(approvals, JSON.stringify([...new Set([...values, p.command])]));
	window.dispatchEvent(new Event('aiusage:approval'));
}
export function loadUsageHistory(p: UsageProvider): {
	history: UsagePoint[];
	snapshot?: UsageSnapshot;
} {
	try {
		const data = JSON.parse(
			localStorage.getItem(prefix + encodeURIComponent(usageSourceKey(p))) ?? '{}'
		);
		const history = (Array.isArray(data.history) ? data.history : [])
			.filter((v: UsagePoint) => Number.isFinite(v.at))
			.map((v: UsagePoint) => ({
				at: v.at,
				metrics: parseUsage({ version: 1, metrics: v.metrics }).metrics
			}));
		return {
			history: history
				.filter((p: UsagePoint) => p.at >= Date.now() - 30 * 86400000 && p.at <= Date.now())
				.slice(-8641),
			...(data.snapshot ? { snapshot: parseUsage(data.snapshot) } : {})
		};
	} catch {
		return { history: [] };
	}
}
export function saveUsageHistory(
	p: UsageProvider,
	snapshot: UsageSnapshot,
	at: number
): UsagePoint[] {
	const history = appendUsageHistory(
		loadUsageHistory(p).history,
		{ at, metrics: snapshot.metrics },
		at
	);
	try {
		localStorage.setItem(
			prefix + encodeURIComponent(usageSourceKey(p)),
			JSON.stringify({ history, snapshot })
		);
	} catch {
		/* a full store must not stop live readings */
	}
	return history;
}
