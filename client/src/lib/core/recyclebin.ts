// Pure helper for the Recycle Bin widget. No React/DOM — unit-tested. The backend
// (widgetsack/src/recyclebin.rs) emits recyclebin.items + recyclebin.bytes; the meta binds them via a
// sensors map and the meter renders count + size, with a "full" cue past an optional size threshold.

export type BinLevel = 'empty' | 'has' | 'full';

/** Classify the bin: empty (no items), full (items + size ≥ the warn threshold, when set), else has.
 * `warnBytes` of 0 disables the "full" cue. Pure. */
export function binLevel(items: number | null, bytes: number | null, warnBytes: number): BinLevel {
	if (!items || items <= 0) return 'empty';
	if (warnBytes > 0 && (bytes ?? 0) >= warnBytes) return 'full';
	return 'has';
}
