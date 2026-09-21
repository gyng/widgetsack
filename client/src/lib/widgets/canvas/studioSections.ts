// The studio's left-rail nav: an ordered, top-down list of sections (a permanent thin nav strip
// selects one; the panel area beside it shows that section's panel). Pure data so the order, the
// <gap> before the foot group (Settings), the stub flags, and glyph uniqueness are
// unit-tested without React.
export type SectionId =
	| 'layouts'
	| 'widget-designer'
	| 'sensors'
	| 'plugins'
	| 'themes'
	| 'background'
	| 'sacks'
	| 'saved-layouts'
	| 'settings';

export type Section = {
	id: SectionId;
	label: string; // full name (accessible name; the tooltip when it differs from `short`)
	short: string; // compact label shown under the icon in the narrow strip
	/** Optional tooltip that adds to the label (e.g. what a "sack" is). Overrides the default. */
	title?: string;
	icon: string;
	group: 'main' | 'foot'; // `foot` sits after a spacer at the bottom (the <gap> before Settings)
	stub?: boolean; // not yet a real panel
};

// The ids are stable (e2e + Ctrl+digit jumps key off them); only the user-facing words follow the
// shared vocabulary: "custom widget" (the designer), "Background", "Share" (sacks = your exports),
// "Presets" (saved layouts).
export const SECTIONS: Section[] = [
	{ id: 'layouts', label: 'Layout', short: 'Layout', icon: '▤', group: 'main' },
	{ id: 'widget-designer', label: 'Widget designer', short: 'Custom', icon: '◳', group: 'main' },
	{ id: 'sensors', label: 'Sensors', short: 'Sensors', icon: '∿', group: 'main' },
	// Plugins ❖ (not ⧉ — ⧉ is "copy" elsewhere) and Share ❏ (not ▦ — ▦ is a container/grid/monitor)
	// so each nav glyph is a distinct signifier (the glyph-uniqueness test locks this in).
	{ id: 'plugins', label: 'Plugins', short: 'Plugins', icon: '❖', group: 'main' },
	{ id: 'themes', label: 'Themes', short: 'Themes', icon: '◐', group: 'main' },
	// The per-monitor full-screen background layer. ◧ (a framed picture) is distinct from every
	// other nav glyph and from the in-canvas ▦ signifier.
	{ id: 'background', label: 'Background', short: 'Background', icon: '◧', group: 'main' },
	// Sacks: export your widgets + theme as a shareable bundle, import someone else's.
	{
		id: 'sacks',
		label: 'Share',
		short: 'Share',
		title: 'Sacks — export/import',
		icon: '❏',
		group: 'main'
	},
	// Presets (saved layout profiles: save the current monitor's arrangement, load it back). ⊞ is
	// distinct from the other nav glyphs and from the in-canvas ▦ (container/grid) signifier.
	{ id: 'saved-layouts', label: 'Presets', short: 'Presets', icon: '⊞', group: 'main' },
	// Shortcut remaps moved into Settings → Shortcuts; Settings is the sole foot item now.
	{ id: 'settings', label: 'Settings', short: 'Settings', icon: '⚙', group: 'foot' }
];

// The sections in the exact top-to-bottom order the NavRail renders them: the `main` group first,
// then the `foot` group after the spacer. Keyboard section-jump (Ctrl+1..8) and Next/Prev cycle index
// THIS, so the numeric/cycle order always tracks the visible rail even if the two groups are
// reordered independently (a unit test pins this to the rail order).
export const RAIL_ORDER: Section[] = [
	...SECTIONS.filter((s) => s.group === 'main'),
	...SECTIONS.filter((s) => s.group === 'foot')
];
