import { describe, expect, it } from 'vitest';
import { balanceDiagnostics } from './cssLint';

describe('balanceDiagnostics', () => {
	it('passes balanced fragments (declarations and nested rules)', () => {
		expect(balanceDiagnostics('color: red')).toEqual([]);
		expect(balanceDiagnostics('.value { color: red; }')).toEqual([]);
		expect(balanceDiagnostics('color: var(--np-accent, rgb(1, 2, 3))')).toEqual([]);
	});

	it('flags an unclosed brace at its position', () => {
		const d = balanceDiagnostics('.value { color: red');
		expect(d).toHaveLength(1);
		expect(d[0]).toMatchObject({ from: 7, to: 8, severity: 'error' });
		expect(d[0].message).toMatch(/Unclosed/);
	});

	it('flags an unexpected (extra) closing brace', () => {
		const d = balanceDiagnostics('color: red; }');
		expect(d).toHaveLength(1);
		expect(d[0]).toMatchObject({ from: 12, severity: 'error' });
		expect(d[0].message).toMatch(/Unexpected/);
	});

	it('flags an unbalanced paren', () => {
		const d = balanceDiagnostics('color: rgb(1, 2, 3');
		expect(d).toHaveLength(1);
		expect(d[0].message).toMatch(/Unclosed "\("/);
	});

	it('ignores brackets inside strings and comments', () => {
		expect(balanceDiagnostics('content: "a { b ( c"')).toEqual([]);
		expect(balanceDiagnostics('/* } ) ] */ color: red')).toEqual([]);
		expect(balanceDiagnostics("content: '\\'} ('")).toEqual([]);
	});

	it('does not let one stray closer cascade into the next open', () => {
		// The `)` is stray; the `{ }` pair is still balanced and must not be consumed by it.
		const d = balanceDiagnostics('a ) { color: red }');
		expect(d).toHaveLength(1);
		expect(d[0].message).toMatch(/Unexpected "\)"/);
	});

	it('treats an unterminated /* comment as running to the end of the source', () => {
		// No closing `*/`: indexOf returns -1, so the scan skips straight to the end — brackets
		// inside the dangling comment (the `{` here) are never seen, and nothing is flagged.
		expect(balanceDiagnostics('/* unterminated { comment')).toEqual([]);
	});
});
