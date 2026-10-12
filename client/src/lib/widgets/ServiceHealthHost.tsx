import { useEffect, useState } from 'react';
import {
	checkServiceHealth,
	type ServiceHealth as Snapshot
} from './plugins/service-health-commands';
import ServiceHealth from './meters/ServiceHealth';
import { servicePollDelay } from '../core/serviceHealth';
export default function ServiceHealthHost({
	url = '',
	label = 'Service health',
	interval = 60,
	slowMs = 1000,
	warnDays = 14
}: {
	url?: unknown;
	label?: string;
	interval?: number;
	slowMs?: number;
	warnDays?: number;
}) {
	const [snapshot, setSnapshot] = useState<{ url: string; result: Snapshot } | null>(null);
	const [busy, setBusy] = useState(false);
	const endpoint = typeof url === 'string' ? url.trim() : '';
	const [target, setTarget] = useState(endpoint);
	if (target !== endpoint) {
		setTarget(endpoint);
		setSnapshot(null);
		setBusy(false);
	}
	useEffect(() => {
		let alive = true;
		let running = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			if (!alive || running || !endpoint || document.visibilityState === 'hidden') return;
			running = true;
			setBusy(true);
			try {
				const result = await checkServiceHealth(endpoint);
				if (alive) setSnapshot({ url: endpoint, result });
			} catch (e) {
				if (alive)
					setSnapshot({
						url: endpoint,
						result: { status: null, latencyMs: 0, certificateDays: null, error: String(e) }
					});
			} finally {
				running = false;
				if (alive) {
					setBusy(false);
					timer = setTimeout(() => {
						void poll();
					}, servicePollDelay(interval));
				}
			}
		};
		const visible = () => {
			clearTimeout(timer);
			if (document.visibilityState !== 'hidden') void poll();
		};
		void poll();
		document.addEventListener('visibilitychange', visible);
		return () => {
			alive = false;
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', visible);
		};
	}, [endpoint, interval]);
	return (
		<ServiceHealth
			result={snapshot?.url === endpoint ? snapshot.result : null}
			url={endpoint}
			label={label}
			slowMs={slowMs}
			warnDays={warnDays}
			busy={busy}
		/>
	);
}
