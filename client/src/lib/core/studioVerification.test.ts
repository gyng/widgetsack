import { expect, it } from 'vitest';
import { container, group, leaf, type MonitorLayout } from './layoutTree';
import { createWidget } from './widget';
import { verifyStudioLayout } from './studioVerification';
const bounds = { x: 0, y: 0, w: 400, h: 300 };
const widget = () => leaf(createWidget('clock', 'clock'));
const monitor = (): MonitorLayout => ({ root: container('root', 'col', [widget()]), floating: [] });
it('checks rendered geometry, with warnings separated from errors and visual review still required', () => {
	const report = verifyStudioLayout(
		monitor(),
		undefined,
		bounds,
		{
			root: { rect: bounds },
			clock: { rect: { x: 390, y: 0, w: 100, h: 50 }, hidden: true, overflow: true }
		},
		['clock']
	);
	expect(report).toMatchObject({
		ok: true,
		measured: true,
		checked: 2,
		visualReviewRequired: true
	});
	expect(report.issues.map((i) => i.code)).toEqual(['outside', 'hidden', 'overflow']);
});
it('does not pass missing, collapsed, unknown, or failed widgets, including floating widgets', () => {
	const m = monitor();
	m.floating.push(leaf(createWidget('invalid', 'broken')));
	const result = verifyStudioLayout(
		m,
		undefined,
		bounds,
		{
			clock: { rect: { x: 0, y: 0, w: 0, h: 30 }, error: 'Meter failed' },
			broken: { rect: { x: NaN, y: 0, w: 10, h: 10 } }
		},
		['clock']
	);
	expect(result.ok).toBe(false);
	expect(result.issues.map((i) => i.code)).toEqual([
		'missing',
		'collapsed',
		'render-error',
		'collapsed',
		'type'
	]);
});
it('handles empty panes, duplicate identities, and an unavailable work area', () => {
	const m = monitor();
	m.root.children.push(container('empty', 'col', []), widget());
	expect(
		verifyStudioLayout(m, undefined, bounds, { root: { rect: bounds }, clock: { rect: bounds } }, [
			'clock'
		]).issues.map((i) => i.code)
	).toEqual(['duplicate']);
	expect(verifyStudioLayout(m, undefined, { ...bounds, w: 0 }, {}, []).measured).toBe(false);
});
it('verifies library and inline group descendants using their actual namespaced identities', () => {
	const child = container('inside', 'col', [widget()]);
	const m = {
		root: container('root', 'col', []),
		floating: [leaf(group('g', { w: 100, h: 100 }, child, { def: 'missing' }))]
	};
	expect(
		verifyStudioLayout(m, undefined, bounds, {}, ['clock']).issues.some(
			(i) => i.code === 'definition'
		)
	).toBe(true);
	const library = {
		version: 1,
		defs: [{ id: 'missing', name: 'Clock', size: { w: 100, h: 100 }, child }]
	};
	const report = verifyStudioLayout(
		m,
		library,
		bounds,
		{ g: { rect: bounds }, 'g/inside': { rect: bounds }, 'g/clock': { rect: bounds } },
		['clock']
	);
	expect(report.ok).toBe(true);
	expect(report.checked).toBe(3);
});
it('bounds recursive custom definitions instead of hanging', () => {
	const recursive = group('recurse', { w: 100, h: 100 }, container('unused', 'col', []), {
		def: 'loop'
	});
	const library = {
		version: 1,
		defs: [{ id: 'loop', name: 'Loop', size: { w: 100, h: 100 }, child: leaf(recursive) }]
	};
	const m = { root: container('root', 'col', [leaf(recursive)]), floating: [] };
	expect(
		verifyStudioLayout(m, library, bounds, {}, []).issues.some((i) => i.code === 'nesting')
	).toBe(true);
});

it('covers every edge, allows half-pixel seams, and rejects a zero-height box', () => {
	for (const rect of [
		{ x: -1, y: 0, w: 10, h: 10 },
		{ x: 0, y: -1, w: 10, h: 10 },
		{ x: 395, y: 0, w: 10, h: 10 },
		{ x: 0, y: 295, w: 10, h: 10 }
	]) {
		expect(
			verifyStudioLayout(
				monitor(),
				undefined,
				bounds,
				{ root: { rect: bounds }, clock: { rect } },
				['clock']
			).issues.some((i) => i.code === 'outside')
		).toBe(true);
	}
	expect(
		verifyStudioLayout(
			monitor(),
			undefined,
			bounds,
			{ root: { rect: bounds }, clock: { rect: { x: -0.5, y: 0, w: 10, h: 0 } } },
			['clock']
		).issues.map((i) => i.code)
	).toEqual(['collapsed']);
	const inline = {
		root: container('root', 'col', [
			leaf(group('inline', { w: 100, h: 100 }, container('empty', 'col', [])))
		]),
		floating: []
	};
	expect(
		verifyStudioLayout(
			inline,
			undefined,
			bounds,
			{ root: { rect: bounds }, inline: { rect: bounds } },
			[]
		).ok
	).toBe(true);
});

it('reports finite definitions beyond the verification nesting limit', () => {
	const defs = Array.from({ length: 35 }, (_, i) => ({
		id: String(i),
		name: String(i),
		size: { w: 100, h: 100 },
		child: leaf(
			group(`g${i}`, { w: 100, h: 100 }, container('end', 'col', []), { def: String(i + 1) })
		)
	}));
	const m = {
		root: container('root', 'col', [
			leaf(group('start', { w: 100, h: 100 }, container('end', 'col', []), { def: '0' }))
		]),
		floating: []
	};
	expect(
		verifyStudioLayout(m, { version: 1, defs }, bounds, {}, []).issues.some(
			(issue) => issue.message === 'Group nesting exceeds the verification limit.'
		)
	).toBe(true);
});
