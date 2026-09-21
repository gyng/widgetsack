// Shared types for the Canvas editor model (the reducer + persistence hooks). The editor state
// is the snapshot-relevant slice of the old Canvas.svelte component locals (monitor / library /
// selection / theme / tokens / def-edit / undo-redo / manual-save baseline). Everything else
// (drag/marquee/pan bookkeeping, measured stage size, zoom) lives in refs/hooks, not here —
// it was never part of an undo snapshot or a disk write.

import type { Library, MonitorLayout, WidgetDef } from '../../core/layoutTree';

/** An undo/redo snapshot of the editable state: the {monitor, library} pair plus everything else a
 * commit can change — the queued cross-monitor moves, the token overrides, the selected theme and
 * the theme lock — so Ctrl+Z always undoes the MOST RECENT change regardless of its kind. Immutable
 * ops reassign these to NEW objects, so a snapshot is just the current references — no deep clone. */
export type Snap = {
	monitor: MonitorLayout;
	library: Library | undefined;
	pendingExtras: Extra[];
	tokenOverrides: Record<string, string>;
	selectedTheme: string;
	themeLock: boolean;
};

/** The last-persisted snapshot (studio manual-save): `dirty` compares the live editor state to
 * it; Cancel reverts to it. Captured on load and after every Save. */
export type Baseline = {
	monitor: MonitorLayout;
	library: Library | undefined;
	theme: string;
	themeLock: boolean;
	/** Saved global inherit-theme, distinct from `theme` when per-monitor themes are unlocked. */
	globalTheme?: string;
	tokens: Record<string, string>;
};

/** A floating leaf queued for ANOTHER monitor's layout (a cross-monitor move), merged on Save. */
export type Extra = { key: string; leaf: import('../../core/layoutTree').Leaf };

/** Studio monitor-switcher option (device name + logical size per per-monitor key). */
export type MonitorOption = { key: string; label: string; name: string; w: number; h: number };

/** The full editor model — the reducer's state. Mirrors the Svelte component locals that
 * participated in undo/baseline/persistence. */
export type EditorState = {
	monitor: MonitorLayout;
	library: Library | undefined;
	selectedId: string | null;
	selectedIds: string[];
	// The last selectedId the multi-select set was synced to (Svelte's lastPrimary). When an op
	// sets selectedId without also setting selectedIds, the reducer collapses selectedIds to just
	// the new primary — UNLESS the op set selectedIds itself (marquee / template / group move).
	lastPrimary: string | null;
	selectedTheme: string;
	// Lock the theme to ALL monitors (default true). When true the picker sets the layout's global
	// `theme` and every monitor uses it; when false the picker sets the CURRENT monitor's own theme
	// (MonitorLayout.theme), so each display can differ. Toggled from studio Settings.
	themeLock: boolean;
	/** Last loaded global inherit-theme; `selectedTheme` may instead be this monitor's override. */
	globalTheme?: string;
	tokenOverrides: Record<string, string>;
	// Def editor (6b): while editing a def, `monitor` is the scoped tree and the real monitor is
	// stashed in `savedMonitor`. `defEditBaseline` is the scoped tree as of def-edit START, so the
	// Save indicator (`dirty`) can tell whether the in-progress def has been edited yet (Svelte got
	// this for free because persistToDisk→syncEditingDef reassigned `library` mid-edit).
	editingDefId: string | null;
	savedMonitor: MonitorLayout | null;
	defEditBaseline: MonitorLayout | null;
	// Template preview (read-only): clicking a template previews it without cloning into the library.
	// The transient def lives HERE (not in `library`), `editingDefId` points at it so the canvas sizes
	// to it, and the preview is locked + discardable. The Clone button promotes it into the library.
	previewDef: WidgetDef | null;
	// Undo/redo (item 2).
	undoStack: Snap[];
	redoStack: Snap[];
	lastSnap: Snap | null;
	historyReady: boolean;
	// The last commit's coalesce key + time. A burst of same-key commits (per-keystroke text edits,
	// key-repeat nudges) within COALESCE_MS folds into ONE undo step instead of one per event.
	// Optional (like globalTheme) so the many op-level test fixtures needn't spell it out.
	lastCommit?: { key: string; at: number } | null;
	// Manual-save baseline (studio).
	savedBaseline: Baseline | null;
	pendingExtras: Extra[];
	// Sticky add target: the container the LAST palette add went into. While set, further palette
	// adds (widgets / templates / My widgets) keep landing there even though the new widget — not
	// the container — is what's selected, until the user selects something outside it (or nothing).
	// Cleared automatically when the container leaves the tree. Optional so the many op-level test
	// fixtures needn't spell it out (absent ⇒ none).
	addTarget?: string | null;
	// The id of the node the last add op created (widget or group), so the Canvas can scroll/flash it
	// into view — an add that lands off-screen or under another widget otherwise reads as a no-op.
	justAdded?: string | null;
	// Bumped on every commit (saveLayout); the persistence effect watches it to write to disk.
	saveSeq: number;
	// Distinguishes overlay (auto-save now) from studio (debounced preview) for the save effect.
	studio: boolean;
};
