import { describe, it, expect } from 'vitest';
import { container, group, leaf, type WidgetInstance, type Leaf } from './layoutTree';
import { containerStyle, itemStyle, overlapChildStyle } from './flowStyle';

const prim = (id: string, w = 10, h = 10): WidgetInstance => ({
	id,
	type: 'gauge',
	rect: { x: 0, y: 0, w, h },
	config: {}
});
// A 'clock' is an INTRINSIC meter (widget.ts) — used to exercise content-fit basis.
const textPrim = (id: string, w = 10, h = 10): WidgetInstance => ({
	id,
	type: 'clock',
	rect: { x: 0, y: 0, w, h },
	config: {}
});

describe('containerStyle', () => {
	it('row → flex row, default align stretch', () => {
		expect(containerStyle(container('r', 'row', []))).toMatchObject({
			display: 'flex',
			flexDirection: 'row',
			alignItems: 'stretch'
		});
	});

	it('col → flex column', () => {
		expect(containerStyle(container('c', 'col', []))).toMatchObject({
			display: 'flex',
			flexDirection: 'column'
		});
	});

	it('align/justify map to align-items / justify-content', () => {
		const s = containerStyle(container('r', 'row', [], { align: 'center', justify: 'between' }));
		expect(s.alignItems).toBe('center');
		expect(s.justifyContent).toBe('space-between');
	});

	it('gap + pad emit px', () => {
		const s = containerStyle(container('c', 'col', [], { gap: 8, pad: 6 }));
		expect(s.gap).toBe('8px');
		expect(s.padding).toBe('6px 6px 6px 6px');
	});

	it('per-side pad', () => {
		const s = containerStyle(container('c', 'col', [], { pad: { t: 1, r: 2, b: 3, l: 4 } }));
		expect(s.padding).toBe('1px 2px 3px 4px');
	});

	it('grid → grid with N columns and cell alignment', () => {
		const s = containerStyle(container('g', 'grid', [], { cols: 3, align: 'center' }));
		expect(s.display).toBe('grid');
		expect(s.gridTemplateColumns).toBe('repeat(3, 1fr)');
		expect(s.justifyItems).toBe('center');
		expect(s.alignItems).toBe('center');
	});

	it('grid with a fixed-width cell emits explicit tracks (px for fixed, 1fr splits the rest)', () => {
		const c0 = container('c0', 'col', [], { cellW: 150 });
		const s = containerStyle(
			container('g', 'grid', [c0, leaf(prim('B')), leaf(prim('C'))], { cols: 3 })
		);
		expect(s.gridTemplateColumns).toBe('150px 1fr 1fr');
	});

	it('grid with a fixed-height cell emits explicit rows', () => {
		const c0 = container('c0', 'col', [], { cellH: 50 });
		// 2 children in 1 col → 2 rows; row 0 fixed 50px, row 1 flexible.
		const s = containerStyle(container('g', 'grid', [c0, leaf(prim('B'))], { cols: 1 }));
		expect(s.gridTemplateRows).toBe('50px 1fr');
	});

	it('overlap → single-cell grid stack', () => {
		const s = containerStyle(container('o', 'col', [], { overlap: true }));
		expect(s.display).toBe('grid');
		expect(s.gridTemplate).toContain('stack');
		expect(overlapChildStyle().gridArea).toBe('stack');
	});

	it('no gap / no pad / no justify → those keys are omitted', () => {
		const s = containerStyle(container('r', 'row', []));
		expect('gap' in s).toBe(false);
		expect('padding' in s).toBe(false);
		expect('justifyContent' in s).toBe(false);
	});
});

describe('itemStyle (sizing)', () => {
	it('basis {fr} → grow proportionally from a 0 basis (can shrink past content)', () => {
		const s = itemStyle({ ...leaf(prim('A'), { fr: 2 }) }, 'row');
		expect(s).toMatchObject({
			flexGrow: 2,
			flexShrink: 1,
			flexBasis: 0,
			minWidth: 0,
			minHeight: 0
		});
	});

	it('basis number → fixed px basis, no grow/shrink', () => {
		const s = itemStyle({ ...leaf(prim('A'), 120) }, 'row');
		expect(s).toMatchObject({ flexGrow: 0, flexShrink: 0, flexBasis: '120px' });
	});

	it("basis 'auto' / unset → a LEAF keeps its stored size (no collapse); axis-aware", () => {
		// prim default size is 10x10. In a col the main axis is height; in a row it's width.
		expect(itemStyle({ ...leaf(prim('A', 40, 20)) }, 'col')).toMatchObject({
			flexGrow: 0,
			flexShrink: 0,
			flexBasis: '20px'
		});
		expect(itemStyle({ ...leaf(prim('A', 40, 20)) }, 'row').flexBasis).toBe('40px');
	});

	it("basis 'content' on a FILL meter (gauge/gpu/…) → authored box as basis, MAIN axis floored at min-content", () => {
		// Keeps the stored box as the default extent (can't collapse to 0), and floors the MAIN axis at
		// min-content so a content-bearing meter (e.g. GPU VRAM) is never squeezed below its content and
		// clipped by the slot's overflow:hidden — the "hug clips" fix. The CROSS axis is NOT floored
		// (the parent's align-items:stretch bounds it to the container) — flooring it too overflows the
		// container horizontally.
		const s = itemStyle({ ...leaf(prim('A', 40, 20), 'content') }, 'row');
		expect(s).toMatchObject({
			flexGrow: 0,
			flexShrink: 0,
			flexBasis: '40px',
			minWidth: 'min-content' // main axis (row → width)
		});
		expect('minHeight' in s).toBe(false); // cross axis stays unbounded → stretches, no overflow
		// col → main axis is height, so the basis (and the floor) tracks height instead.
		const sc = itemStyle({ ...leaf(prim('A', 40, 20), 'content') }, 'col');
		expect(sc.flexBasis).toBe('20px');
		expect(sc.minHeight).toBe('min-content');
		expect('minWidth' in sc).toBe(false);
	});

	it("basis 'content' on a GROUP (dropped template) → group size as basis, MAIN axis floored at MAX-content", () => {
		// The Network widget is a GROUP; hugging it must fit its FULL content (a collapsing sub-row
		// falls out of min-content), so groups floor at max-content — not min-content like fill meters.
		// Only the MAIN axis is floored: in a col that's height, so the cross axis (width) stays bounded
		// by the container — flooring width too made the Network group overflow horizontally.
		const g = group('g', { w: 80, h: 120 }, container('c', 'col', []));
		const s = itemStyle({ ...leaf(g, 'content') }, 'col');
		expect(s).toMatchObject({
			flexGrow: 0,
			flexShrink: 0,
			flexBasis: '120px', // group size on the main (col) axis
			minHeight: 'max-content' // main axis (col → height)
		});
		expect('minWidth' in s).toBe(false); // cross axis (width) not floored → no horizontal overflow
		// row parent → main axis is width, so the floor lands on minWidth instead.
		const sr = itemStyle({ ...leaf(g, 'content') }, 'row');
		expect(sr.minWidth).toBe('max-content');
		expect('minHeight' in sr).toBe(false);
		// grid parent → no single main axis (2D cell), so BOTH axes keep the content floor.
		const sg = itemStyle({ ...leaf(g, 'content') }, 'grid');
		expect(sg.minWidth).toBe('max-content');
		expect(sg.minHeight).toBe('max-content');
	});

	it("basis 'content' on an INTRINSIC text meter (clock/text) → content-fit (auto basis, shrinkable)", () => {
		const s = itemStyle({ ...leaf(textPrim('A', 40, 20), 'content') }, 'row');
		expect(s).toMatchObject({ flexGrow: 0, flexShrink: 1, flexBasis: 'auto', minWidth: 0 });
	});

	it('a CONTAINER with auto basis shrink-wraps (flex-basis:auto)', () => {
		expect(itemStyle(container('c', 'col', []), 'row').flexBasis).toBe('auto');
	});
});

describe('itemStyle (per-leaf alignment)', () => {
	it('row parent: valign → align-self (cross), halign → auto margins (main)', () => {
		const node: Leaf = { ...leaf(textPrim('A')), halign: 'right', valign: 'middle' };
		const s = itemStyle(node, 'row');
		expect(s.alignSelf).toBe('center'); // valign middle on the vertical cross axis
		expect(s.marginLeft).toBe('auto'); // halign right pushes it along the horizontal main axis
		expect('marginRight' in s).toBe(false);
	});

	it('col parent: halign → align-self (cross), valign → auto margins (main)', () => {
		const node: Leaf = { ...leaf(textPrim('A')), halign: 'center', valign: 'bottom' };
		const s = itemStyle(node, 'col');
		expect(s.alignSelf).toBe('center'); // halign center on the horizontal cross axis
		expect(s.marginTop).toBe('auto'); // valign bottom pushes it down the vertical main axis
	});

	it('row parent: halign center → centered via dual auto margins', () => {
		const s = itemStyle({ ...leaf(prim('A')), halign: 'center' }, 'row');
		expect(s.marginLeft).toBe('auto');
		expect(s.marginRight).toBe('auto');
	});

	it('grid parent: halign/valign → justify-self / align-self (independent 2D)', () => {
		const node: Leaf = { ...leaf(textPrim('A')), halign: 'right', valign: 'top' };
		const s = itemStyle(node, 'grid');
		expect(s.justifySelf).toBe('end');
		expect(s.alignSelf).toBe('start');
	});

	it('fill alignment → stretch', () => {
		const s = itemStyle({ ...leaf(textPrim('A')), halign: 'fill', valign: 'fill' }, 'grid');
		expect(s.justifySelf).toBe('stretch');
		expect(s.alignSelf).toBe('stretch');
	});

	it('a FILL meter (no intrinsic size) keeps cross-axis stretch (no align-self) + gets the placement var', () => {
		// gauge is a fill meter: halign must NOT become align-self (that would collapse width:100% to 0);
		// the dial/content aligns inside the stretched box via --np-halign instead.
		const s = itemStyle({ ...leaf(prim('A')), halign: 'left' }, 'col');
		expect('alignSelf' in s).toBe(false);
		expect(s['--np-halign']).toBe('flex-start');
	});

	it('exposes the leaf halign/valign to the meter as --np-halign / --np-valign vars', () => {
		const s = itemStyle({ ...leaf(prim('A')), halign: 'left', valign: 'top' }, 'row');
		expect(s['--np-halign']).toBe('flex-start');
		expect(s['--np-valign']).toBe('flex-start');
	});
});

describe('itemStyle (per-side margin + padding)', () => {
	it('uniform margin (number) → all four sides', () => {
		const s = itemStyle({ ...leaf(prim('A')), margin: 6 }, 'col');
		expect(s).toMatchObject({ marginTop: 6, marginRight: 6, marginBottom: 6, marginLeft: 6 });
	});

	it('per-side margin {t,r,b,l} → each side independently', () => {
		const s = itemStyle({ ...leaf(prim('A')), margin: { t: 1, r: 2, b: 3, l: 4 } }, 'col');
		expect(s).toMatchObject({ marginTop: 1, marginRight: 2, marginBottom: 3, marginLeft: 4 });
	});

	it('leaf pad → padding on the slot (insets the widget); containers are unaffected here', () => {
		const s = itemStyle({ ...leaf(prim('A')), pad: { t: 1, r: 2, b: 3, l: 4 } }, 'col');
		expect(s.padding).toBe('1px 2px 3px 4px');
		// A container leaf-style still emits no padding from itemStyle (it pads via containerStyle).
		expect('padding' in itemStyle(container('c', 'col', []), 'col')).toBe(false);
	});

	it('placement auto-margin still wins on its axis when an explicit margin is also set', () => {
		// col + valign:bottom pushes to the bottom (marginTop:auto) — it must override the explicit top
		// margin, while the untouched sides keep their explicit values.
		const node: Leaf = { ...leaf(prim('A')), margin: 5, valign: 'bottom' };
		const s = itemStyle(node, 'col');
		expect(s.marginTop).toBe('auto'); // placement overrides the explicit 5
		expect(s.marginBottom).toBe(5); // non-placement side keeps the explicit margin
		expect(s.marginLeft).toBe(5);
		expect(s.marginRight).toBe(5);
	});

	it('no margin / no pad → those keys are omitted', () => {
		const s = itemStyle(leaf(prim('A')), 'col');
		expect('marginTop' in s).toBe(false);
		expect('padding' in s).toBe(false);
	});
});
