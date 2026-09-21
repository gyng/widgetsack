// treeThreats.ts — a pure scanner for UNTRUSTED layout trees: a widget def arriving in a shared sack,
// a plugin package's template tree, or a layout the AI assistant proposes. A tree is not just
// geometry — its units can carry capabilities: an `iframe` unit embeds a web page (unsandboxed
// and/or click-catching if its config says so), an `image` unit or a monitor `background` fetches
// a remote URL (an IP-leaking beacon the moment the layout renders), a `button` unit carries a
// macro of Home Assistant / media service calls fired on press, and any unit's `css` / `tokens`
// is injected into the page (the same reach a theme has — see cssThreats.ts). None of that is
// scanned by the structural parser (migration.ts), so this module reports it for a consent
// dialog and `sanitizeImportedTree` forces the iframe sandbox on before the tree is merged.
// Pure (no I/O, no DOM), unit-tested in treeThreats.test.ts.

import type { WidgetInstance } from './layout';
import {
	type Container,
	type Group,
	type LayoutNode,
	type Leaf,
	type MonitorLayout,
	type WidgetDef,
	isContainer,
	isGroup,
	isLeaf
} from './layoutTree';
import { scanCssThreats, type CssThreat } from './cssThreats';
import { normalizeMacro } from './macro';

export type TreeThreatKind =
	| 'iframe' // an embedded web page (its URL)
	| 'iframe-unsandboxed' // `sandbox: false` — the page runs same-origin-capable, can open popups
	| 'iframe-interactive' // `interact: true` — the frame catches clicks on the passive overlay
	| 'remote-image' // an image unit with an http(s) / protocol-relative src
	| 'remote-background' // a monitor wallpaper (`background.src`) that is a remote URL
	| 'button-macro' // a button carrying service calls (domain.service list)
	| 'css'; // unit / def css or token values with CSS threats (cssThreats.ts)

export type TreeThreat = {
	kind: TreeThreatKind;
	/** The unit (or def) id the threat lives on. */
	id: string;
	/** A human-readable, already-truncated description for a confirm() dialog. */
	detail: string;
};

/** What `scanTreeThreats` accepts: a bare layout node, a library def, or a whole monitor layout. */
export type ScannableTree = LayoutNode | WidgetDef | MonitorLayout;

const REMOTE = /^\s*(https?:\/\/|\/\/)/i;

/** True for an absolute http(s) or protocol-relative URL (a local file / data: / asset: is not). */
export function isRemoteUrl(v: unknown): v is string {
	return typeof v === 'string' && REMOTE.test(v);
}

/** First ~80 chars, whitespace-collapsed, for a readable dialog line. */
function snippet(s: string): string {
	const one = s.replace(/\s+/g, ' ').trim();
	return one.length > 80 ? `${one.slice(0, 77)}…` : one;
}

function isDef(x: ScannableTree): x is WidgetDef {
	return 'child' in x && 'size' in x && !('unit' in x) && !('kind' in x);
}

function isMonitor(x: ScannableTree): x is MonitorLayout {
	return 'root' in x && 'floating' in x;
}

/**
 * Walk a tree / def / monitor layout and report every capability-bearing unit. Group units are
 * descended into (their inline child tree ships with the def). A def's own `css` is scanned too.
 * De-duplicated by (kind, id, detail). Never throws on a malformed node — it is simply skipped.
 */
export function scanTreeThreats(input: ScannableTree): TreeThreat[] {
	const seen = new Set<string>();
	const out: TreeThreat[] = [];
	const add = (kind: TreeThreatKind, id: string, detail: string): void => {
		const key = `${kind}:${id}:${detail}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ kind, id, detail });
	};
	const addCss = (id: string, threats: CssThreat[]): void => {
		for (const t of threats) add('css', id, `${t.kind}: ${t.detail}`);
	};
	const scanStyle = (id: string, css: string | undefined, tokens: unknown): void => {
		addCss(id, scanCssThreats(css));
		if (tokens && typeof tokens === 'object') {
			for (const v of Object.values(tokens as Record<string, unknown>)) {
				if (typeof v === 'string') addCss(id, scanCssThreats(v));
			}
		}
	};
	const scanUnit = (unit: WidgetInstance | Group): void => {
		scanStyle(unit.id, unit.css, unit.tokens);
		if (isGroup(unit)) {
			if (unit.child) walk(unit.child);
			return;
		}
		const cfg = (unit.config ?? {}) as Record<string, unknown>;
		if (unit.type === 'iframe') {
			add('iframe', unit.id, snippet(typeof cfg.url === 'string' ? cfg.url : '(no url)'));
			if (cfg.sandbox === false) add('iframe-unsandboxed', unit.id, 'sandbox: false');
			if (cfg.interact === true) add('iframe-interactive', unit.id, 'interact: true');
		} else if (unit.type === 'image') {
			if (isRemoteUrl(cfg.src)) add('remote-image', unit.id, snippet(cfg.src));
		} else if (unit.type === 'button') {
			const macro = normalizeMacro(cfg.actions);
			if (macro.length) {
				add(
					'button-macro',
					unit.id,
					snippet(macro.map((a) => `${a.domain}.${a.service}`).join(', '))
				);
			}
		}
	};
	const walk = (node: LayoutNode): void => {
		if (!node || typeof node !== 'object') return;
		if (isContainer(node)) {
			if (Array.isArray(node.children)) node.children.forEach(walk);
			return;
		}
		if (isLeaf(node) && node.unit && typeof node.unit === 'object') scanUnit(node.unit);
	};

	if (isMonitor(input)) {
		if (isRemoteUrl(input.background?.src)) {
			add('remote-background', 'background', snippet(input.background.src));
		}
		walk(input.root);
		input.floating.forEach(walk);
	} else if (isDef(input)) {
		addCss(input.id, scanCssThreats(input.css));
		walk(input.child);
	} else {
		walk(input);
	}
	return out;
}

/** Scan several defs (a sack's library) in one go. */
export function scanDefsThreats(defs: readonly WidgetDef[]): TreeThreat[] {
	return defs.flatMap(scanTreeThreats);
}

/**
 * A one-paragraph summary for a confirm() prompt, or '' when there is nothing to warn about. Counts
 * per kind, worded for a non-expert (what the content DOES, not the field name).
 */
export function treeThreatSummary(threats: readonly TreeThreat[]): string {
	if (!threats.length) return '';
	const n = (kind: TreeThreatKind) => threats.filter((t) => t.kind === kind).length;
	const plural = (count: number, one: string, many: string) =>
		`${count} ${count === 1 ? one : many}`;
	const bits: string[] = [];
	const iframes = n('iframe');
	if (iframes) {
		const extras: string[] = [];
		if (n('iframe-unsandboxed')) extras.push('unsandboxed');
		if (n('iframe-interactive')) extras.push('click-catching');
		bits.push(
			plural(iframes, 'embedded web page', 'embedded web pages') +
				(extras.length ? ` (${extras.join(', ')})` : '')
		);
	}
	const remote = n('remote-image') + n('remote-background');
	if (remote) bits.push(plural(remote, 'remote image', 'remote images') + ' (could phone home)');
	const macros = n('button-macro');
	if (macros)
		bits.push(plural(macros, 'button that runs service calls', 'buttons that run service calls'));
	const css = n('css');
	if (css)
		bits.push(
			plural(css, 'CSS rule that reaches outside the app', 'CSS rules that reach outside the app')
		);
	return bits.join(', ');
}

/**
 * Force the iframe sandbox ON for every iframe unit in a tree / def / monitor layout — a stranger's
 * layout never gets to decide it runs unsandboxed. Returns a NEW value (the input is never mutated)
 * plus how many units were changed (0 = nothing to do; the input is returned as-is in that case).
 */
export function sanitizeImportedTree<T extends ScannableTree>(
	input: T
): { value: T; changed: number } {
	let changed = 0;
	const fixUnit = (unit: WidgetInstance | Group): WidgetInstance | Group => {
		if (isGroup(unit)) {
			if (!unit.child) return unit;
			const child = fixNode(unit.child);
			return child === unit.child ? unit : { ...unit, child };
		}
		// Anything but a literal `true` (false, 0, "false", null) reads as "off" downstream (`!!sandbox`);
		// an ABSENT key falls back to the meter's own `sandbox = true` default, so it needs no change.
		const sandbox = unit.config?.sandbox;
		if (unit.type === 'iframe' && sandbox !== undefined && sandbox !== true) {
			changed++;
			return { ...unit, config: { ...unit.config, sandbox: true } };
		}
		return unit;
	};
	const fixNode = (node: LayoutNode): LayoutNode => {
		if (!node || typeof node !== 'object') return node;
		if (isContainer(node)) {
			if (!Array.isArray(node.children)) return node;
			let touched = false;
			const children = node.children.map((c) => {
				const next = fixNode(c);
				if (next !== c) touched = true;
				return next;
			});
			return touched ? { ...node, children } : node;
		}
		if (isLeaf(node) && node.unit && typeof node.unit === 'object') {
			const unit = fixUnit(node.unit);
			return unit === node.unit ? node : { ...node, unit };
		}
		return node;
	};

	if (isMonitor(input)) {
		const root = fixNode(input.root) as Container;
		let touched = root !== input.root;
		const floating = input.floating.map((lf) => {
			const next = fixNode(lf) as Leaf;
			if (next !== lf) touched = true;
			return next;
		});
		return { value: touched ? { ...input, root, floating } : input, changed };
	}
	if (isDef(input)) {
		const child = fixNode(input.child);
		return { value: child === input.child ? input : { ...input, child }, changed };
	}
	const node = fixNode(input);
	return { value: node as T, changed };
}
