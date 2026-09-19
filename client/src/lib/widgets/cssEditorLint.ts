// CSS-fragment diagnostics for the studio editors. Combines the pure bracket-balance check
// (core/cssLint) with a parse over the CodeMirror CSS grammar and an optional `CSS.supports`
// declaration check. The editors hold a FRAGMENT (declarations and/or nested rules), not a full
// stylesheet, so we parse it the way assembleStyles uses it — wrapped in a scope `.x { … }` — and
// map error positions back to the fragment. `supports` is injectable so the unknown-property path is
// unit-testable without a DOM (real callers pass the runtime `CSS.supports`). Co-located test in
// cssEditorLint.test.ts.
import { cssLanguage } from '@codemirror/lang-css';
import { balanceDiagnostics, type CssDiag } from '../core/cssLint';

export type { CssDiag } from '../core/cssLint';

// Scope wrapper used only for parsing (same shape scopeCss emits). OFFSET maps positions back.
const WRAP_OPEN = '.x{\n';
const WRAP_CLOSE = '\n}';
const OFFSET = WRAP_OPEN.length;

type SupportsFn = (property: string, value: string) => boolean;

// Default: defer to the runtime CSS.supports when present; assume valid where it isn't (tests / no
// DOM) so we never false-flag. Wrapped in try/catch — CSS.supports throws on malformed input.
function runtimeSupports(property: string, value: string): boolean {
	if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return true;
	try {
		return CSS.supports(property, value);
	} catch {
		return true;
	}
}

/**
 * Diagnostics for a CSS fragment: unbalanced brackets (pure), then syntax errors from the CSS
 * parser, then unknown/unsupported declarations via `supports`. Returns CM-agnostic diagnostics
 * (offsets into `src`). An unbalanced fragment short-circuits to the balance diagnostics — parsing
 * it would emit a noisy cascade of errors.
 */
export function cssDiagnostics(src: string, opts: { supports?: SupportsFn } = {}): CssDiag[] {
	if (!src.trim()) return [];

	const balance = balanceDiagnostics(src);
	if (balance.length) return balance;

	const supports = opts.supports ?? runtimeSupports;
	const text = WRAP_OPEN + src + WRAP_CLOSE;
	const tree = cssLanguage.parser.parse(text);
	const out: CssDiag[] = [];
	const clamp = (p: number): number => Math.min(src.length, Math.max(0, p - OFFSET));

	tree.iterate({
		enter: (node) => {
			if (node.type.isError) {
				const from = clamp(node.from);
				const to = clamp(node.to);
				out.push({ from, to: Math.max(to, from + 1), severity: 'error', message: 'Syntax error' });
				return;
			}
			if (node.name !== 'Declaration') return;
			// PropertyName : value  — check the value is a thing CSS understands for this property.
			const prop = node.node.getChild('PropertyName');
			if (!prop) return;
			const property = text.slice(prop.from, prop.to);
			/* v8 ignore next -- Lezer represents custom declarations with a different property node. */
			if (property.startsWith('--')) return; // custom properties accept anything
			const colon = text.indexOf(':', prop.to);
			/* v8 ignore next -- a parsed Declaration with PropertyName necessarily contains its colon. */
			if (colon < 0 || colon >= node.to) return;
			const value = text
				.slice(colon + 1, node.to)
				.replace(/;+\s*$/, '')
				.trim();
			// Can't statically validate var()/nested content, and skip empties.
			if (!value || value.includes('var(') || value.includes('{')) return;
			if (!supports(property, value)) {
				out.push({
					from: clamp(prop.from),
					to: clamp(prop.to),
					severity: 'warning',
					message: `Unknown property or unsupported value: ${property}`
				});
			}
		}
	});

	// De-dupe identical ranges/messages and cap to keep the gutter sane on a very broken doc.
	const seen = new Set<string>();
	const deduped = out.filter((d) => {
		const k = `${d.from}:${d.to}:${d.message}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	return deduped.slice(0, 50);
}
