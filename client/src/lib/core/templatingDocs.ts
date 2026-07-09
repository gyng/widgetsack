// Generate the Markdown reference for the widget templating / formula language straight from the
// code that defines it: the helper functions (core/templateFns.ts → formula/engine.ts sandbox), the
// named scalar formats (core/format.ts), and the `expr` config fields across the widget registry
// (core/widget.ts). Pure: pass it `listMetas()` and it returns the doc string. Emitted to
// docs/templating.md by scripts/gen-widget-docs.ts. Co-located tests in templatingDocs.test.ts.

import type { ConfigField, WidgetMeta } from './widget';
import { TEMPLATE_FUNCTIONS } from './templateFns';
import { SCALAR_FORMATS } from './format';

// Escape a cell value so a literal `|` / newline can't break the Markdown table.
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();

function functionsTable(): string {
	const rows = TEMPLATE_FUNCTIONS.map(
		(f) => `| \`${f.signature}\` | ${cell(f.summary)} | \`${f.example}\` |`
	);
	return ['| function | description | example |', '| --- | --- | --- |', ...rows].join('\n');
}

function formatsTable(): string {
	const rows = SCALAR_FORMATS.map(
		(f) => `| \`${f.name}\` | ${cell(f.summary)} | ${cell(f.example)} |`
	);
	return ['| format | description | example |', '| --- | --- | --- |', ...rows].join('\n');
}

// Every `expr` config field across the registry — the exact places a formula/template is accepted.
function exprFieldsTable(metas: WidgetMeta[]): string {
	const isExpr = (f: ConfigField): f is Extract<ConfigField, { kind: 'expr' }> => f.kind === 'expr';
	const rows: string[] = [];
	for (const m of metas) {
		for (const f of (m.configFields ?? []).filter(isExpr)) {
			const accepts = f.result === 'text' ? 'template → text' : 'formula → number';
			const note = f.target && f.target !== f.key ? `overrides \`${f.target}\`` : (f.help ?? '');
			rows.push(`| \`${m.type}\` | \`${f.key}\` | ${accepts} | ${cell(note)} |`);
		}
	}
	if (!rows.length) return '_No formula fields in the current registry._';
	return ['| widget | field | accepts | notes |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

const PREAMBLE = `# Templating & formulas

> **Generated** from the code that defines the language — do not hand-edit. Run \`npm run gen:docs\`
> (in \`client/\`) to regenerate. Sources of truth: \`client/src/lib/core/templateFns.ts\` (helper
> functions), \`client/src/lib/core/format.ts\` (named formats), \`client/src/lib/formula/engine.ts\`
> (the sandbox), and the widget registry (\`core/widget.ts\`).

Many widget fields accept a small expression language so a value can be **computed** or **composed**
from live sensors instead of bound 1:1. There are two flavours, both built on the same expressions:

- **Formula** — a single expression that evaluates to a **number**, used to override a numeric field
  (a gauge/bar \`value\`, \`min\`, \`max\`). Example: \`clamp(cpu.total, 0, 100)\` or \`mem.used.bytes / mem.total * 100\`.
- **Template** — literal text interleaved with \`{ expression }\` segments that evaluates to a
  **string** (the Text widget's \`value\`). Example: \`CPU {round(cpu.total)}% · {bytes(mem.used.bytes)}\`.

## Template syntax

A template is plain text with \`{ … }\` holes; each hole is an expression evaluated against the live
sensor values, and its result is substituted in. Everything outside the braces is literal.

- \`{{\` and \`}}\` produce literal \`{\` and \`}\`.
- Braces and quotes **inside** an expression are balanced/skipped, so \`{ round(x, 2) + ' }' }\` is one hole.
- A hole whose expression is \`null\`, errors, or is non-finite renders as **\`–\`** (an en dash) —
  never the literal \`null\` or \`NaN\`. A formula field that fails simply falls back to its plain value.

## Expressions

Each \`{ … }\` (and each formula) is **real JavaScript**, evaluated in a sandboxed QuickJS interpreter:

- **Sensors are namespaced globals.** A dotted sensor id reads as ordinary member access:
  \`cpu.total\`, \`mem.used\`, \`net.down\`, \`gpu.util\`, \`ha.<entity_id>\`. (The studio **Sensors**
  section lists what's available; the full id reference is in [widgets.md](widgets.md).)
- **Standard JavaScript works:** arithmetic and comparisons, \`Math.*\`, \`Number\`, \`String\`,
  \`(x).toFixed(2)\`, ternaries (\`cpu.total > 90 ? 'HOT' : 'ok'\`), string concatenation (\`cpu.total + '%'\`).
- **Plus the helper functions below.**
- **It is a true sandbox:** no DOM, no Tauri, no network, no host globals (\`typeof fetch\` is
  \`'undefined'\`) — formulas travel inside shared sacks, so they can't do more than compute. Each eval
  is bounded (~50 ms + ~16 MiB); a runaway or oversized expression is killed and renders as \`–\`.
- **A sensor that hasn't emitted yet is absent**, so referencing it makes the expression fail (→ \`–\`)
  rather than coercing to \`0\` — a fresh widget shows \`–\`, not a misleading zero.

## Helper functions

Available in every expression, on top of native JavaScript:
`;

const FORMATS_SECTION = `## Named value formats

A scalar widget's \`format\` field is a quicker alternative to a template when you just want one value
shown nicely. It names how the bound sensor's number is rendered; any unlisted value renders the raw
number. (For anything fancier — labels, maths, multiple sensors — use a template in the \`value\` field.)
`;

const EXAMPLES_SECTION = `## Examples

\`\`\`text
{round(cpu.total)}%                            → 37%
CPU {round(cpu.total)}% · {bytes(mem.used.bytes)}   → CPU 37% · 12.4 GiB
↓ {rate(net.down)}  ↑ {rate(net.up)}           → ↓ 1.2 MiB/s  ↑ 64.0 KiB/s
{round(mem.used)}% of {bytes(mem.total)} used  → 37% of 32.0 GiB used
{cpu.total > 90 ? 'HOT' : 'ok'}                → conditional text
{{literal braces}}                             → {literal braces}
\`\`\`

Formula fields (numeric) take just the expression — no braces:

\`\`\`text
clamp(cpu.total, 0, 100)
mem.used.bytes / mem.total * 100
\`\`\`
`;

/** The full templating/formula reference, generated from the language sources (pass `listMetas()`). */
export function templatingReferenceMarkdown(metas: WidgetMeta[]): string {
	return [
		PREAMBLE,
		functionsTable(),
		'',
		FORMATS_SECTION,
		formatsTable(),
		'',
		'## Where formulas & templates are accepted',
		'',
		'Config fields that take an expression (the studio Inspector marks them “(formula)”):',
		'',
		exprFieldsTable(metas),
		'',
		EXAMPLES_SECTION
	].join('\n');
}
