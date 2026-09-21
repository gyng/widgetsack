// Pure parsing for widget formulas (the inner domain ring — no engine, no React, no Tauri). This
// module decides WHAT to evaluate and WHICH sensors a formula touches; the actual sandboxed
// evaluation lives in the QuickJS adapter (lib/formula/engine.ts).
//
// A widget value can be a TEMPLATE: literal text interleaved with `{ expr }` segments, where each
// expr is JavaScript evaluated against the live sensor values. Sensor ids are dotted (`cpu.total`,
// `mem.used`) and are exposed to the expression as NAMESPACED globals — `cpu.total` is a plain
// member access on a `{ cpu: { total: n } }` scope, so formulas read like ordinary JS.

import { isSafePath } from './safePath';

export type TemplatePart = { kind: 'text'; text: string } | { kind: 'expr'; src: string };

// First segments that are JS built-ins, not sensors — excluded from sensor-reference extraction so a
// formula like `Math.round(cpu.total)` only subscribes to `cpu.total`.
const JS_GLOBALS = new Set([
	'Math',
	'Number',
	'JSON',
	'Object',
	'Array',
	'String',
	'Boolean',
	'Date',
	'globalThis',
	'console',
	'NaN',
	'Infinity',
	'undefined'
]);

const dedupe = (xs: string[]): string[] => Array.from(new Set(xs));

/** Replace the contents of string/template literals with spaces so identifiers written INSIDE a
 *  string (e.g. `'cpu.total'`) aren't mistaken for sensor references. Escapes are honoured. */
function stripStringLiterals(src: string): string {
	let out = '';
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === '"' || c === "'" || c === '`') {
			const quote = c;
			i++;
			while (i < src.length && src[i] !== quote) {
				if (src[i] === '\\') i++; // skip the escaped char
				i++;
			}
			i++; // past the closing quote
			out += ' ';
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

const CHAIN = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g;

/** Dotted sensor ids referenced in a single raw expression. If `known` is given, only ids present in
 *  it are returned (so a typo or a method chain like `(mem.used).toFixed` can't add a dead subscription). */
export function exprRefs(exprSrc: string, known?: string[]): string[] {
	const cleaned = stripStringLiterals(exprSrc);
	const chains = (cleaned.match(CHAIN) ?? []).filter((ch) => !JS_GLOBALS.has(ch.split('.')[0]));
	const knownSet = known ? new Set(known) : null;
	return dedupe(knownSet ? chains.filter((ch) => knownSet.has(ch)) : chains);
}

/** Split a template into literal-text and `{ expr }` parts. `{{` / `}}` are literal braces; braces and
 *  quotes inside an expr are balanced/skipped so `{ round(x, 2) + ' }' }` parses as one expr. */
export function parseTemplate(src: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	let text = '';
	let i = 0;
	const flush = () => {
		if (text) parts.push({ kind: 'text', text });
		text = '';
	};
	while (i < src.length) {
		const c = src[i];
		if (c === '{' && src[i + 1] === '{') {
			text += '{';
			i += 2;
			continue;
		}
		if (c === '}' && src[i + 1] === '}') {
			text += '}';
			i += 2;
			continue;
		}
		if (c === '{') {
			flush();
			i++; // past the opening brace
			let depth = 1;
			let expr = '';
			while (i < src.length && depth > 0) {
				const d = src[i];
				if (d === '"' || d === "'" || d === '`') {
					expr += d;
					i++;
					while (i < src.length && src[i] !== d) {
						if (src[i] === '\\') {
							expr += src[i];
							i++;
						}
						expr += src[i];
						i++;
					}
					if (i < src.length) {
						expr += src[i]; // closing quote
						i++;
					}
					continue;
				}
				if (d === '{') depth++;
				else if (d === '}') {
					depth--;
					if (depth === 0) {
						i++;
						break;
					}
				}
				expr += d;
				i++;
			}
			parts.push({ kind: 'expr', src: expr.trim() });
			continue;
		}
		text += c;
		i++;
	}
	flush();
	return parts;
}

/** Dotted sensor ids referenced across all `{expr}` parts of a template (de-duped). */
export function templateRefs(template: string, known?: string[]): string[] {
	const refs: string[] = [];
	for (const part of parseTemplate(template)) {
		if (part.kind === 'expr') refs.push(...exprRefs(part.src, known));
	}
	return dedupe(refs);
}

/** Turn a flat sensor map into the namespaced object the sandbox reads:
 *  `{ 'cpu.total': 37, 'net.down': 5 }` → `{ cpu: { total: 37 }, net: { down: 5 } }`.
 *  Sensor ids are untrusted (an MQTT topic or a package sensor can spell `__proto__`), so an id with
 *  a prototype-walking segment is DROPPED and only own-property objects are descended into. */
export function buildScope(
	values: Record<string, number | string | null>
): Record<string, unknown> {
	const root: Record<string, unknown> = {};
	for (const [id, v] of Object.entries(values)) {
		if (!isSafePath(id)) continue;
		const segs = id.split('.');
		let node = root;
		for (let k = 0; k < segs.length - 1; k++) {
			const s = segs[k];
			if (!Object.hasOwn(node, s) || typeof node[s] !== 'object' || node[s] === null) node[s] = {};
			node = node[s] as Record<string, unknown>;
		}
		node[segs[segs.length - 1]] = v;
	}
	return root;
}

/** Render a parsed template to a string given an expression evaluator (the engine, injected so this
 *  stays pure/testable). A null/failed sub-expression renders as `–`, never the literal "null". */
export function renderTemplate(
	parts: TemplatePart[],
	evaluate: (exprSrc: string) => number | string | null
): string {
	return parts.map((p) => (p.kind === 'text' ? p.text : stringifyResult(evaluate(p.src)))).join('');
}

function stringifyResult(v: number | string | null): string {
	return v === null || (typeof v === 'number' && !Number.isFinite(v)) ? '–' : String(v);
}
