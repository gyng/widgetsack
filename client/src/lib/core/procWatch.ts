// Pure helper for the Process Watcher widget. No React/DOM — unit-tested. The backend
// (widgetsack/src/sensors.rs) aggregates every process matching a configured name into
// proc.watch.<name>.{running,count,cpu,mem}; the meta binds those via a sensors map (and subscribing
// is what tells the backend WHICH process to watch — the demand gate, like ping/stocks).

export type ProcWatchSensors = { running: string; cpu: string; mem: string; count: string };

/** The sensor-id map for a watched process name (blank → chrome.exe). */
export function procWatchSensors(name: string): ProcWatchSensors {
	const n = (name ?? '').trim() || 'chrome.exe';
	return {
		running: `proc.watch.${n}.running`,
		cpu: `proc.watch.${n}.cpu`,
		mem: `proc.watch.${n}.mem`,
		count: `proc.watch.${n}.count`
	};
}
