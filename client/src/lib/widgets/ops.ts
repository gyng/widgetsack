// The single editor-operation message both the Inspector and the Outline dispatch up to
// the Canvas (which holds the layout state and applies it via core/layoutEdit). One
// discriminated union keeps the wiring flat — Canvas has one `handleOp` switch.

import type {
	AlignH,
	AlignV,
	BackgroundSpec,
	Container,
	Group,
	LayoutNode,
	Length,
	Pad,
	WidgetInstance
} from '../core/layoutTree';

export type LayoutOp =
	| { op: 'select'; id: string }
	| { op: 'addWidget'; widgetType: string }
	// Drop a palette widget onto the stage at world coords (x,y) → a new floating widget there.
	| { op: 'addWidgetAt'; widgetType: string; x: number; y: number }
	// Add a child container of `kind`. Targets `containerId` (the container context menu's Add) or,
	// when omitted, the selected container / root (the Outline's +Row/+Col/+Grid). `index` (a grid
	// cell's context menu) drops the band into THAT cell — padding earlier empty cells with spacers —
	// instead of the first free one; omitted → append.
	| { op: 'addContainer'; kind: 'row' | 'col' | 'grid'; containerId?: string; index?: number }
	// Add a sibling container of `kind` directly AFTER node `id`, in id's parent (the context
	// menu's "Add beside"). No-op at the root, which has no siblings.
	| { op: 'addBeside'; kind: 'row' | 'col' | 'grid'; id: string }
	// Reset a container's children to an even proportional split (every child basis {fr:1}) — the
	// "Distribute evenly" reset for a custom row/col/grid split.
	| { op: 'distributeEvenly'; containerId: string }
	// Split a container (cell/pane) in two: 'rows' stacks (a col), 'cols' is side-by-side (a row),
	// 'grid' makes it a 2×2 grid. Existing content is preserved as the first region. (item 1)
	// `cellIndex` (set only from an EMPTY grid placeholder) splits THAT cell: a new band container is
	// materialised at that index of the grid `id`, instead of splitting the whole grid.
	| { op: 'split'; id: string; dir: 'rows' | 'cols' | 'grid'; cellIndex?: number }
	// Collapse a split container: flatten its sub-cells one level, dropping empty ones (inverse of split).
	| { op: 'collapse'; id: string }
	| { op: 'remove'; id: string }
	| { op: 'moveUp'; id: string }
	| { op: 'moveDown'; id: string }
	| { op: 'outdent'; id: string } // move out to the grandparent
	| { op: 'indent'; id: string } // move into the previous sibling container
	| { op: 'dock'; id: string } // floating → flow (into root)
	| { op: 'float'; id: string } // flow leaf → floating
	| { op: 'makeWidget'; id: string } // wrap a node into a reusable group + def (6a)
	| { op: 'ungroup'; id: string } // inline a group back to its subtree (6a)
	| { op: 'insertWidget'; defId: string } // instantiate a library def as a new group (6d)
	// Instantiate a built-in template (core/templates.ts) directly onto the canvas as a self-contained
	// group (its tree inline, no library def) — the one-click "drop this template as a widget". `options`
	// carries the picker's chosen template options (e.g. the clock's language / 12-24h / separator);
	// omitted → the template's defaults (resolveTemplateOptions fills the rest).
	| { op: 'insertTemplate'; templateId: string; options?: Record<string, string> }
	// Set a leaf's per-side margin (outer) or padding (inner inset); `value` undefined clears the field.
	| { op: 'setLeafBox'; id: string; field: 'margin' | 'pad'; value?: Pad }
	| { op: 'renameDef'; defId: string; name: string } // rename a library def (6d)
	| { op: 'deleteDef'; defId: string } // remove a library def if unused (6d)
	| { op: 'addDefParam'; defId: string; key: string; target?: string } // declare a param (6c)
	| { op: 'editDef'; defId: string } // enter the scoped def editor (6b)
	| { op: 'endDefEdit' } // leave the def editor, saving back (6b)
	| { op: 'setDefSize'; defId: string; w: number; h: number } // resize a def's box (6b)
	| { op: 'patchGroup'; id: string; patch: Partial<Group> } // group name / params / css
	| { op: 'setDefCss'; defId: string; css: string } // a def's css (7d)
	| { op: 'setToken'; key: string; value: string } // a global token override (7d, '' clears)
	| { op: 'setTokens'; tokens: Record<string, string> } // apply a whole map at once (wallpaper auto-theme)
	| { op: 'clearTokens' } // drop ALL global token overrides at once (the panel's "Clear" button)
	// Set (or clear, when undefined) the current monitor's full-screen background/wallpaper layer.
	| { op: 'setBackground'; spec?: BackgroundSpec }
	// Per-widget token override (scoped to [data-w]/[data-group]): the Inspector's "Override theme for
	// this widget" group. `value:''` clears that one key; clearWidgetTokens drops the whole override.
	| { op: 'setWidgetToken'; id: string; key: string; value: string }
	| { op: 'clearWidgetTokens'; id: string }
	// A node's main-axis sizing inside its flow parent: 'auto'/px = fixed, {fr} = stretch/grow.
	| { op: 'setBasis'; id: string; basis: Length | undefined }
	// A leaf's placement within the box the layout gives it (per screen axis; 'fill' = span the box).
	| { op: 'setLeafAlign'; id: string; halign: AlignH; valign: AlignV }
	| { op: 'patchWidget'; id: string; patch: Partial<WidgetInstance> }
	| { op: 'resetWidget'; id: string } // restore config/css/sensor to the widget type's defaults
	| { op: 'patchContainer'; id: string; patch: Partial<Container> }
	// Outline drag-and-drop (build the tree directly, no canvas coords):
	| { op: 'dropWidget'; containerId: string; widgetType: string } // palette item → container
	| { op: 'reparent'; id: string; containerId: string } // move a node into a container
	// Replace a node wholesale from the Inspector's Data tab (edited JSON). `id` keeps the slot; the
	// supplied node carries the new content (its id is coerced to `id` by the Inspector).
	| { op: 'replaceNode'; id: string; node: LayoutNode };
