// Pure seam for fitting an overlay window onto a monitor: set → read back → re-apply. No Tauri,
// no DOM; the window operations are injected so the retry policy is unit-tested without a window.
//
// Why verify at all: on Windows a position/size we set is NOT the last word. Moving a window onto a
// monitor with a different DPI fires WM_DPICHANGED *inside* our own SetWindowPos, and tao (Windows 11
// branch) answers it by applying the rect Windows suggests — which can differ from what we asked for.
// A display topology change (HDMI input switched away and back) can also have the OS relocate the
// window before or after our fit. Reading the geometry back and re-applying it (bounded) makes the
// fit converge instead of silently landing a few pixels off (widgets clipped at a monitor edge).

/** A window rect in PHYSICAL screen pixels (what Tauri's monitor + outer* APIs speak). */
export type PhysicalBox = { x: number; y: number; w: number; h: number };

/** The window operations a fit needs, in physical px. `readBack` returns the current outer box. */
export type FitOps = {
	setPosition: (x: number, y: number) => Promise<void>;
	setSize: (w: number, h: number) => Promise<void>;
	readBack: () => Promise<PhysicalBox>;
};

export type FitResult = {
	/** True when the final read-back matched `target` (or the geometry couldn't be read at all). */
	ok: boolean;
	/** Fit passes made (1 = clean on the first try). */
	attempts: number;
	/** The LAST observed mismatch (null when the first pass was already clean) — for the log line. */
	mismatch: string | null;
};

/** Describe how `actual` differs from `target`, axis by axis (`"y 2100≠2160"`), or null when equal. */
export function fitMismatch(target: PhysicalBox, actual: PhysicalBox): string | null {
	const diffs: string[] = [];
	for (const k of ['x', 'y', 'w', 'h'] as const) {
		if (actual[k] !== target[k]) diffs.push(`${k} ${actual[k]}≠${target[k]}`);
	}
	return diffs.length ? diffs.join(', ') : null;
}

/** Apply `target` to the window (position, then size — the size last so a DPI-hop rescale inside the
 * move can't be the final word), read the geometry back, and re-apply while it differs, up to
 * `attempts` passes with `sleep` between them. Best-effort: a read-back failure counts as a clean
 * fit (nothing sensible to retry against), and no operation error is swallowed — callers keep their
 * own try/catch. */
export async function fitWindowVerified(
	ops: FitOps,
	target: PhysicalBox,
	opts: { attempts?: number; sleep: (ms: number) => Promise<void>; retryDelayMs?: number }
): Promise<FitResult> {
	const attempts = Math.max(1, opts.attempts ?? 3);
	const delay = opts.retryDelayMs ?? 60;
	let mismatch: string | null = null;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		await ops.setPosition(target.x, target.y);
		await ops.setSize(target.w, target.h);
		let actual: PhysicalBox;
		try {
			actual = await ops.readBack();
		} catch {
			return { ok: true, attempts: attempt, mismatch };
		}
		const diff = fitMismatch(target, actual);
		if (diff === null) return { ok: true, attempts: attempt, mismatch };
		mismatch = diff;
		if (attempt < attempts) await opts.sleep(delay);
	}
	return { ok: false, attempts, mismatch };
}

/** Drift-poll decision: given the mismatch the previous tick recorded (`last`, null = none) and the one
 * seen now (`current`, null = the window sits exactly on its monitor), should a refit fire? Fires on a
 * NEW mismatch only — a mismatch identical to the one a refit already failed to clear is not retried
 * every tick (no 4 s refit loop against a window the OS won't let us place), but any change to it,
 * or a clean interval in between, arms the trigger again. Returns the value to remember as `last`. */
export function driftTrigger(
	last: string | null,
	current: string | null
): { fire: boolean; next: string | null } {
	return { fire: current !== null && current !== last, next: current };
}
