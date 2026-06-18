// Theming injection helpers (Phase 7). `scopeCss` wraps a user CSS block so it's scoped
// to one widget via native CSS nesting; `assembleStyles` builds the full stylesheet for a
// monitor in cascade order (global theme → per-def → per-instance). Pure, ZERO Svelte/
// Tauri — the Svelte <StyleLayer> just injects the returned string; a React port reuses
// this verbatim. Co-located vitest tests in style.test.ts.

import {
	type Leaf,
	type LayoutNode,
	type Library,
	type MonitorLayout,
	isContainer,
	isGroup,
	isLeaf
} from './layoutTree';
import { DEFAULT_TOKENS, tokensToCss } from './tokens';

/**
 * Scope a user CSS block to `selector` via native CSS nesting: `selector { <css> }`. Both
 * bare declarations (`color: red`) and nested selectors (`.value { … }`) work inside the
 * wrapper in a WebView2/Chromium runtime. Returns '' for empty/whitespace css. Pure.
 * (`@keyframes`/`@font-face` can't be nested — those belong in the global theme.)
 */
export function scopeCss(css: string | undefined, selector: string): string {
	const c = (css ?? '').trim();
	if (!c) return '';
	return `${selector} {\n${c}\n}`;
}

/**
 * Assemble a monitor's full stylesheet. Order encodes the cascade:
 *   0. (opt-in) the DEFAULT_TOKENS base at `:root`, so the token vocabulary is the actual runtime
 *      source of truth — a meter can read bare `var(--np-accent)` and a theme/override still wins
 *      because it comes later in the cascade. Off by default so the unit tests (and any non-widget
 *      caller) get just the authored CSS.
 *   1. the global theme, verbatim (sets tokens + may target `np-*` hooks)
 *   2. each library def's css, scoped to `[data-def="<id>"]` (styles every instance)
 *   3. each instance's per-widget token overrides + css (`[data-w="<id>"]`) and each group
 *      instance's (`[data-group="<id>"]`), most-specific last so it wins. The scoped tokens come
 *      just before that unit's css and beat the global `:root` tokens for this widget's subtree.
 * Pure — the host carries the matching `data-w`/`data-def`/`data-group` attributes.
 */
export function assembleStyles(opts: {
	themeCss?: string;
	library?: Library;
	monitor: MonitorLayout;
	includeDefaults?: boolean;
}): string {
	const parts: string[] = [];

	if (opts.includeDefaults) parts.push(tokensToCss(DEFAULT_TOKENS));

	const theme = (opts.themeCss ?? '').trim();
	if (theme) parts.push(theme);

	for (const def of opts.library?.defs ?? []) {
		const s = scopeCss(def.css, `[data-def="${def.id}"]`);
		if (s) parts.push(s);
	}

	const leafCss = (lf: Leaf, prefix: string): void => {
		const fullId = prefix + lf.id;
		const sel = isGroup(lf.unit) ? `[data-group="${fullId}"]` : `[data-w="${fullId}"]`;
		const tk = lf.unit.tokens;
		if (tk && Object.keys(tk).length) parts.push(tokensToCss(tk, sel));
		const s = scopeCss(lf.unit.css, sel);
		if (s) parts.push(s);
	};
	const walk = (node: LayoutNode, prefix: string): void => {
		if (isContainer(node)) {
			node.children.forEach((c) => walk(c, prefix));
			return;
		}
		if (isLeaf(node)) {
			leafCss(node, prefix);
			// A group is a leaf here but owns a NESTED child tree whose widgets render with ids
			// NAMESPACED by the group leaf id + '/' (FlowNode's prefixing — the load-bearing data-id
			// invariant). Recurse with that same prefix so the inner css scopes to the [data-w] those
			// widgets ACTUALLY render with — without this, anything inside a group (incl. the demoSeed
			// templates) renders unstyled (e.g. a now-playing widget showing two stacked covers).
			if (isGroup(node.unit)) walk(node.unit.child, `${prefix}${node.id}/`);
		}
	};
	walk(opts.monitor.root, '');
	// Floating items can be groups too — walk (not just leafCss) so their nested widgets are collected.
	opts.monitor.floating.forEach((lf) => walk(lf, ''));

	return parts.join('\n');
}
