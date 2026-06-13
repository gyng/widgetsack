// Pure: the distinct volume letters present in a flat sensor-id list — extracted from the dynamic
// `disk.<letter>.<metric>` ids the backend emits (e.g. `disk.C.used.pct`). Sorted for a stable order.
// The match requires a metric segment after the letter, so the Disks widget's `disk._probe` demand
// sentinel (no second dot) is naturally excluded. No React/DOM — unit-tested (disks.test.ts).
export function diskLetters(ids: string[]): string[] {
	const set = new Set<string>();
	for (const id of ids) {
		const m = /^disk\.([^.]+)\./.exec(id);
		if (m) set.add(m[1]);
	}
	return [...set].sort();
}
