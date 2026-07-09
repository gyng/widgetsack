// evalExpr's last-resort catch: QuickJS evaluates the expression fine, but bringing the RESULT
// across (ctx.dump) explodes host-side on a pathologically deep value — evalExpr must yield null,
// not an exception. Kept in its OWN file with NO afterAll dispose: the aborted dump strands QuickJS
// handles, and disposing the runtime afterwards would trip QuickJS's leak assertion — the vitest
// worker teardown reclaims the WASM instance instead. (engine.test.ts owns the normal
// init/dispose lifecycle.)
import { describe, expect, it } from 'vitest';
import { evalExpr, initFormulaEngine, isFormulaEngineReady } from './engine';

describe('evalExpr — host-side dump failure', () => {
	it('returns null when the result is too deep to serialize back, and keeps working', async () => {
		await initFormulaEngine();
		expect(isFormulaEngineReady()).toBe(true);
		// Built iteratively (no sandbox recursion): a 100k-deep nested array evaluates fine inside
		// QuickJS but the host-side dump recurses over it and throws → the catch → null.
		const deep =
			'(function () { var a = []; var cur = a; for (var i = 0; i < 100000; i++) { var n = []; cur.push(n); cur = n; } return a; })()';
		expect(evalExpr(deep, {})).toBeNull();
		// The engine survives for subsequent, well-behaved evaluations.
		expect(evalExpr('1 + 1', {})).toBe(2);
	});
});
