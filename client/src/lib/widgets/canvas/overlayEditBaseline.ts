// When an OVERLAY toggles edit mode (Ctrl+Alt+E), should the editor re-anchor its saved baseline +
// undo history to the current layout? Yes on the RISING edge only, and never in the studio.
//
// Why: an overlay's edits auto-save, and while it is editing it ignores the layout_changed events
// its own writes raise — so nothing re-baselines between sessions. Without this, "Revert" in a later
// session would already show with no edits made, and clicking it would write back the layout from
// app start (or the last foreign reload), discarding the EARLIER session's saved edits. Re-anchoring
// on entry makes Revert mean "since I entered edit mode", which is what the confirm promises. The
// studio never re-anchors here: its baseline is the last explicit Save.
export type EditToggle = {
	studio: boolean;
	wasEditing: boolean;
	editing: boolean;
};

export function rebaselineOnEditToggle({ studio, wasEditing, editing }: EditToggle): boolean {
	return !studio && editing && !wasEditing;
}
