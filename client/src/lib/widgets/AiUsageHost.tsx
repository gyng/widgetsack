import { useEffect, useState } from 'react';
import {
	usageProviders,
	usagePollingSpec,
	usageSourceKey,
	nextUsagePollAt,
	type UsageProvider,
	type UsagePoint,
	type UsageSnapshot
} from '../core/aiUsage';
import { readAiUsage } from './plugins/ai-usage-commands';
import { commandApproved, loadUsageHistory, saveUsageHistory } from './plugins/ai-usage-source';
import AiUsage, { type AiUsageOptions, type UsageReading } from './meters/AiUsage';

export default function AiUsageHost({
	providers,
	interval = 900,
	timeout = 20,
	...options
}: AiUsageOptions & { providers?: unknown; interval?: number; timeout?: number }) {
	const spec = usagePollingSpec(providers);
	const [readings, setReadings] = useState<Record<string, UsageReading>>({});
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const tick = setInterval(() => setNow(Date.now()), 15000);
		return () => clearInterval(tick);
	}, []);
	useEffect(() => {
		const items = usageProviders(JSON.parse(spec));
		let alive = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let running = false;
		let nextPoll = 0;
		const refreshMs = Math.max(60, Math.min(3600, Number(interval) || 900)) * 1000;
		const initial: Record<string, UsageReading> = {};
		const snapshots = new Map<string, UsageSnapshot>();
		for (const p of items) {
			const restored = loadUsageHistory(p);
			if (restored.snapshot) snapshots.set(usageSourceKey(p), restored.snapshot);
			initial[usageSourceKey(p)] = {
				...restored,
				at: restored.history.at(-1)?.at,
				error: '',
				busy: false
			};
		}
		setReadings(initial);
		const update = (
			p: UsageProvider,
			snapshot: UsageSnapshot | undefined,
			history: UsagePoint[] | undefined,
			error: string,
			busy: boolean,
			at?: number
		) => {
			if (!alive) return;
			setReadings((previous) => {
				const key = usageSourceKey(p);
				return {
					...previous,
					[key]: { ...previous[key], ...(snapshot ? { snapshot, history, at } : {}), error, busy }
				};
			});
		};
		const poll = async () => {
			if (!alive || running || document.visibilityState === 'hidden') return;
			if (Date.now() < nextPoll) {
				timer = setTimeout(() => {
					void poll();
				}, nextPoll - Date.now());
				return;
			}
			const attemptedAt = Date.now();
			running = true;
			await Promise.all(
				items.map(async (p) => {
					if (!commandApproved(p)) {
						update(
							p,
							undefined,
							undefined,
							'Activate this command in Studio provider settings.',
							false
						);
						return;
					}
					update(p, undefined, undefined, '', true);
					try {
						const snapshot = await readAiUsage(p, timeout);
						if (!alive) return;
						snapshots.set(usageSourceKey(p), snapshot);
						const at = Date.now();
						const history = saveUsageHistory(p, snapshot, at);
						update(p, snapshot, history, '', false, at);
					} catch (err) {
						update(p, undefined, undefined, String(err), false);
					}
				})
			);
			running = false;
			if (alive) {
				nextPoll = nextUsagePollAt([...snapshots.values()], attemptedAt, Date.now(), refreshMs);
				timer = setTimeout(() => {
					void poll();
				}, nextPoll - Date.now());
			}
		};
		const refresh = () => {
			clearTimeout(timer);
			void poll();
		};
		void poll();
		document.addEventListener('visibilitychange', refresh);
		const activate = () => {
			nextPoll = 0;
			refresh();
		};
		window.addEventListener('aiusage:approval', activate);
		return () => {
			alive = false;
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', refresh);
			window.removeEventListener('aiusage:approval', activate);
		};
	}, [spec, interval, timeout]);
	return (
		<AiUsage
			{...options}
			providers={usageProviders(providers)}
			readings={readings}
			now={now}
			interval={interval}
		/>
	);
}
