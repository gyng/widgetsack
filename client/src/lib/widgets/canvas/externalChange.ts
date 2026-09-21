// Pure decision for the studio when widgets.json changes under it (a `layout_changed` from ANOTHER
// writer — an overlay's edit mode, a hand edit, a sync tool). The studio previously ignored every
// change while editing (it is always editing), so it silently clobbered the external edit on its
// next preview write. No React, no Tauri — unit-tested in externalChange.test.ts.

export type ExternalChangeInput = {
	/** The editor diverges from its saved baseline (unsaved work the reload would discard). */
	dirty: boolean;
	/** A preview write is armed or in flight — the file is about to reflect THIS editor anyway. */
	previewPending: boolean;
	/** The widget designer is open (the editor's `monitor` is a scoped def tree, not the layout). */
	designing: boolean;
};

/**
 * 'reload' — nothing here would be lost: silently reload the file. 'ask' — the editor holds unsaved
 * work (or is about to write, or is mid-design, where a reload would replace the scoped def tree):
 * surface a Reload / Keep-mine choice instead of either clobbering the external edit or throwing
 * the user's away.
 */
export function decideExternalChange(input: ExternalChangeInput): 'reload' | 'ask' {
	return input.dirty || input.previewPending || input.designing ? 'ask' : 'reload';
}

/**
 * Whether a `layout_changed` event came from this window itself (its own save) — those are already
 * reflected in the editor and must not trigger a reload or a banner. An event with no payload (the
 * file watcher: an external edit) or a different writer label is foreign. `ownLabel` is this
 * window's Tauri label.
 */
export function isForeignWriter(writer: string | undefined, ownLabel: string): boolean {
	return writer !== ownLabel;
}
