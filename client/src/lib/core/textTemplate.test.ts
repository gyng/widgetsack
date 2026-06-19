import { describe, expect, it } from 'vitest';
import {
	buildScope,
	exprRefs,
	parseTemplate,
	renderTemplate,
	templateRefs,
	type TemplatePart
} from './textTemplate';

describe('parseTemplate', () => {
	it('splits literal text and {expr} segments', () => {
		expect(parseTemplate('CPU {round(cpu.total)}% ok')).toEqual([
			{ kind: 'text', text: 'CPU ' },
			{ kind: 'expr', src: 'round(cpu.total)' },
			{ kind: 'text', text: '% ok' }
		]);
	});

	it('treats a lone {expr} as a single expr part (a pure value)', () => {
		expect(parseTemplate('{ mem.used / 2 }')).toEqual([{ kind: 'expr', src: 'mem.used / 2' }]);
	});

	it('escapes literal braces with {{ and }}', () => {
		expect(parseTemplate('{{not an expr}}')).toEqual([{ kind: 'text', text: '{not an expr}' }]);
	});

	it('balances nested braces and ignores braces inside strings', () => {
		expect(parseTemplate(`{ round(x, 2) + ' }' }`)).toEqual([
			{ kind: 'expr', src: `round(x, 2) + ' }'` }
		]);
		expect(parseTemplate('{ {a: 1}.a }')).toEqual([{ kind: 'expr', src: '{a: 1}.a' }]);
	});

	it('keeps an escaped quote inside an expr string literal (escape + char both retained)', () => {
		// The backslash-escaped quote must NOT end the string early — both the \ and the quote
		// stay in the expr src, and the brace that follows the real closing quote still closes it.
		expect(parseTemplate(`{ 'a\\'b' }`)).toEqual([{ kind: 'expr', src: `'a\\'b'` }]);
		expect(parseTemplate(`pre { "x\\"}y" } post`)).toEqual([
			{ kind: 'text', text: 'pre ' },
			{ kind: 'expr', src: `"x\\"}y"` },
			{ kind: 'text', text: ' post' }
		]);
	});

	it('returns plain text unchanged', () => {
		expect(parseTemplate('just text')).toEqual([{ kind: 'text', text: 'just text' }]);
	});
});

describe('exprRefs / templateRefs', () => {
	it('extracts dotted sensor ids and excludes JS globals', () => {
		expect(exprRefs('Math.round(cpu.total) + mem.used').sort()).toEqual(['cpu.total', 'mem.used']);
	});

	it('ignores ids written inside string literals', () => {
		expect(exprRefs(`'cpu.total' + net.down`)).toEqual(['net.down']);
	});

	it('ignores ids written inside double-quoted string literals', () => {
		expect(exprRefs('"cpu.total" + net.down')).toEqual(['net.down']);
	});

	it('ignores ids written inside template (backtick) literals', () => {
		expect(exprRefs('`cpu.total` + net.down')).toEqual(['net.down']);
	});

	it('tolerates an unterminated string literal (runs to end of source)', () => {
		// The string never closes, so the strip loop exhausts the source (the `i < length` guard,
		// not the closing quote, ends it). cpu.total inside the open string is still ignored.
		expect(exprRefs("net.down + 'cpu.total")).toEqual(['net.down']);
	});

	it('tolerates a trailing open-quote (the strip loop exits before testing the char)', () => {
		// The opening quote is the LAST char: after stepping past it i === length, so the inner
		// `src[i] !== quote` is never evaluated (the `i < length` guard short-circuits).
		expect(exprRefs("net.down + '")).toEqual(['net.down']);
	});

	it('honours backslash escapes inside a string so an escaped quote does not end it early', () => {
		// The \' is skipped as one unit; the string only closes at the real trailing quote, so the
		// cpu.total written AFTER the escaped quote is still inside the string and ignored.
		expect(exprRefs("net.down + 'a\\'cpu.total'")).toEqual(['net.down']);
	});

	it('returns [] when an expression has no dotted sensor chains', () => {
		// match() returns null here (no `a.b` chains at all) → the `?? []` fallback.
		expect(exprRefs('42 + 7')).toEqual([]);
		expect(exprRefs('round(x)')).toEqual([]);
	});

	it('filters to known ids when a catalog is supplied', () => {
		expect(exprRefs('mem.used + bogus.sensor', ['mem.used', 'cpu.total'])).toEqual(['mem.used']);
	});

	it('unions refs across all template expr parts', () => {
		expect(templateRefs('{cpu.total} / {mem.used} {cpu.total}').sort()).toEqual([
			'cpu.total',
			'mem.used'
		]);
	});

	it('does not pick up dotted ids in template literal text', () => {
		expect(templateRefs('see cpu.total here {mem.used}')).toEqual(['mem.used']);
	});
});

describe('buildScope', () => {
	it('namespaces a flat sensor map into nested objects', () => {
		expect(buildScope({ 'cpu.total': 37, 'net.down': 5, 'net.up': 1 })).toEqual({
			cpu: { total: 37 },
			net: { down: 5, up: 1 }
		});
	});

	it('keeps nulls (a not-yet-emitted sensor)', () => {
		expect(buildScope({ 'gpu.temp': null })).toEqual({ gpu: { temp: null } });
	});
});

describe('renderTemplate', () => {
	const parts: TemplatePart[] = parseTemplate('CPU {cpu.total}% MEM {mem.used}');

	it('joins literal text with evaluated expressions', () => {
		const out = renderTemplate(parts, (src) => (src === 'cpu.total' ? 37 : 62));
		expect(out).toBe('CPU 37% MEM 62');
	});

	it('renders a null or non-finite result as – (never "null"/"NaN")', () => {
		expect(renderTemplate(parts, () => null)).toBe('CPU –% MEM –');
		expect(renderTemplate(parts, () => NaN)).toBe('CPU –% MEM –');
	});
});
