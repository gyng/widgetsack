import { useEffect, useState } from 'react';
import { mergeReport, mergeWindowList, type WindowDiag } from '../core/diagnostics';
import {
	getProcessDiagnostics,
	getSubsystemTimings,
	listenDiagReports,
	listWindowLabels,
	requestDiagnostics,
	setSubsystemProfiling,
	type ProcessDiag,
	type SubsystemTiming
} from '../diag';
import { widgetCosts, resetWidgetProfile } from './canvas/widgetProfile';

const POLL_MS = 1500;
const STALE_MS = 6000;

/** Own the panel's polling, listener, and profiling lifetime. Window membership comes from the
 * backend so a crashed renderer remains visible and rescuable even after it stops reporting. */
export function useDiagnostics() {
	const [reports, setReports] = useState<Record<string, WindowDiag>>({});
	const [labels, setLabels] = useState<string[]>([]);
	const [proc, setProc] = useState<ProcessDiag | null>(null);
	const [timings, setTimings] = useState<SubsystemTiming[]>([]);
	const [costs, setCosts] = useState(widgetCosts);
	const [now, setNow] = useState(() => performance.now());

	useEffect(() => {
		let alive = true;
		let polling = false;
		const offReports = listenDiagReports((report) => {
			if (!alive) return;
			// Renderer clocks have different origins; measure freshness on the studio's clock.
			setReports((prev) => mergeReport(prev, { ...report, at: performance.now() }));
		}).catch((err) => {
			console.warn('diagnostics report listener registration failed', err);
			return () => undefined;
		});
		void setSubsystemProfiling(true);
		const poll = async () => {
			if (!alive) return;
			setCosts(widgetCosts());
			setNow(performance.now());
			// A stalled native call must not accumulate more bridge requests every interval.
			if (polling) return;
			polling = true;
			try {
				requestDiagnostics();
				const [process, windows, timing] = await Promise.all([
					getProcessDiagnostics(),
					listWindowLabels(),
					getSubsystemTimings()
				]);
				if (!alive) return;
				if (process) setProc(process);
				if (windows.length) setLabels(windows);
				setTimings(timing);
			} finally {
				polling = false;
			}
		};
		void poll();
		const timer = window.setInterval(() => void poll(), POLL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
			void offReports.then((off) => off());
			void setSubsystemProfiling(false);
		};
	}, []);

	return {
		rows: mergeWindowList(reports, labels, now, STALE_MS),
		proc,
		timings,
		costs,
		resetCosts: () => {
			resetWidgetProfile();
			setCosts([]);
		}
	};
}
