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

const PREAMBLE = `# Templates and formulas

<!-- Generated from the expression helpers, value formats, and widget registry. -->

Use formulas to calculate numeric values. Use text templates to combine text with sensor readings.
Enter these values in the fields marked **(formula)** in the Inspector.

| Input | Use | Example |
| --- | --- | --- |
| Formula | Set a numeric value. Do not include braces. | \`clamp(cpu.total, 0, 100)\` |
| Text template | Insert readings into text. Put each expression inside braces. | \`CPU {round(cpu.total)}%\` |

## Template syntax

Put an expression inside \`{ }\` to insert its result. Text outside the braces stays unchanged.

- Use \`{{\` and \`}}\` to display literal braces.
- Braces inside quoted strings do not end the expression.
- A missing reading or invalid expression displays \`–\` in a text template.
- If a numeric formula fails, the widget uses its ordinary value.

## Expressions

Use the sensor ID as a value, such as \`cpu.total\`, \`mem.used\`, or \`net.down\`.
Open **Sensors** to find the available IDs.

Expressions support JavaScript arithmetic, comparisons, strings, conditional expressions, and \`Math\` functions.
For example, \`cpu.total > 90 ? 'High' : 'Normal'\` selects text from the CPU reading.
The helper functions below provide common formatting and calculations.

Expressions cannot access the network, files, or app controls.
Invalid expressions show no calculated value. A missing reading does not become zero.
For execution limits, see the [developer architecture guide](dev/architecture.md#expressions).

## Helper functions

These functions are available in formulas and text templates:
`;

const FORMATS_SECTION = `## Named value formats

Use a widget's \`format\` setting to display one numeric reading.
Choose a format from the table below. An unknown format displays the raw number.
Use a text template when you need labels, calculations, or several readings.
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

Enter numeric formulas without braces:

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
		'## Fields that accept formulas and templates',
		'',
		'The Inspector marks these fields **(formula)**:',
		'',
		exprFieldsTable(metas),
		'',
		EXAMPLES_SECTION
	].join('\n');
}
