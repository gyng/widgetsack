import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
	container,
	group,
	leaf,
	type Library,
	type MonitorLayout,
	type WidgetInstance
} from '../core/layoutTree';
import { collectContainerRects, collectRenderables, type Solved } from '../core/solve';
import FlowNode, { type RenderLeaf } from './FlowNode';

const prim = (id: string, w = 10, h = 10): WidgetInstance => ({
	id,
	type: 'gauge',
	rect: { x: 0, y: 0, w, h },
	config: {}
});

// A trivial leaf renderer that tags the slot so we can find primitives if needed.
const renderLeaf: RenderLeaf = (_lf, id) => <span data-prim={id} />;

// A tree exercising row/col/grid + an inline group (to check id namespacing).
function tree(): MonitorLayout {
	return {
		root: container(
			'root',
			'col',
			[
				container('row1', 'row', [leaf(prim('A'), { fr: 1 }), leaf(prim('B'))], {
					align: 'stretch'
				}),
				leaf(group('G', { w: 40, h: 40 }, container('gcol', 'col', [leaf(prim('C'))]))),
				container('grid1', 'grid', [leaf(prim('D'))], { cols: 2 })
			],
			{ align: 'stretch' }
		),
		floating: []
	};
}

const lib: Library = { version: 1, defs: [] };

describe('FlowNode — data-id parity with the collectors (drop-in guard)', () => {
	it('renders a data-id for every collector key (renderables + container boxes)', () => {
		const mon = tree();
		const view = render(
			<FlowNode node={mon.root} parentKind="col" renderLeaf={renderLeaf} library={lib} />
		);
		const rendered = new Set(
			Array.from(view.container.querySelectorAll('[data-id]')).map((el) =>
				el.getAttribute('data-id')
			)
		);

		// A hand-built measured Map with every id in `tree()`: containers (root/row1/grid1 — group
		// internals are NOT surfaced by collectContainerRects), the flow leaves (A/B/D), and the
		// group descendant (G/C, namespaced by the group leaf id). Rects are arbitrary — the
		// collectors only key off presence in the map. No solver involved.
		const solved: Solved = new Map([
			['root', { x: 0, y: 0, w: 800, h: 600 }],
			['row1', { x: 0, y: 0, w: 800, h: 200 }],
			['A', { x: 0, y: 0, w: 400, h: 200 }],
			['B', { x: 400, y: 0, w: 400, h: 200 }],
			['G/C', { x: 0, y: 200, w: 40, h: 40 }],
			['grid1', { x: 0, y: 240, w: 800, h: 360 }],
			['D', { x: 0, y: 240, w: 400, h: 360 }]
		]);
		const leafKeys = collectRenderables(mon, solved, lib).map((r) => r.id);
		const containerKeys = collectContainerRects(mon, solved).map((c) => c.id);

		// Every key the editor/click-through looks up must exist in the rendered DOM to be measured.
		for (const k of [...leafKeys, ...containerKeys]) {
			expect(rendered.has(k), `missing data-id "${k}"`).toBe(true);
		}
		// The group descendant is namespaced by the group leaf id (G/C).
		expect(rendered.has('G/C')).toBe(true);
	});
});

describe('FlowNode — emitted CSS', () => {
	it('a row container emits display:flex + flex-direction:row', () => {
		const view = render(
			<FlowNode
				node={container('r', 'row', [leaf(prim('A'))], { align: 'center' })}
				parentKind="col"
				renderLeaf={renderLeaf}
			/>
		);
		const el = view.container.querySelector('[data-id="r"]') as HTMLElement;
		expect(el.style.display).toBe('flex');
		expect(el.style.flexDirection).toBe('row');
		expect(el.style.alignItems).toBe('center');
	});

	it('an fr leaf slot grows; an auto leaf slot keeps its stored main size', () => {
		const mon = container(
			'r',
			'row',
			[leaf(prim('A', 30, 20), { fr: 1 }), leaf(prim('B', 50, 20))],
			{
				align: 'stretch'
			}
		);
		const view = render(<FlowNode node={mon} parentKind="col" renderLeaf={renderLeaf} />);
		const a = view.container.querySelector('[data-id="A"]') as HTMLElement;
		const b = view.container.querySelector('[data-id="B"]') as HTMLElement;
		expect(a.style.flexGrow).toBe('1');
		expect(b.style.flexGrow).toBe('0');
		expect(b.style.flexBasis).toBe('50px'); // row → main axis is width (stored 50)
	});

	it('a grid container emits grid template columns', () => {
		const view = render(
			<FlowNode
				node={container('g', 'grid', [leaf(prim('A'))], { cols: 3 })}
				parentKind="col"
				renderLeaf={renderLeaf}
			/>
		);
		const el = view.container.querySelector('[data-id="g"]') as HTMLElement;
		expect(el.style.display).toBe('grid');
		expect(el.style.gridTemplateColumns).toBe('repeat(3, 1fr)');
	});

	it('the top-level node fills its parent when fill is set (width/height 100%)', () => {
		const view = render(
			<FlowNode
				node={container('root', 'col', [leaf(prim('A'))])}
				parentKind="col"
				renderLeaf={renderLeaf}
				fill
			/>
		);
		const el = view.container.querySelector('[data-id="root"]') as HTMLElement;
		expect(el.style.width).toBe('100%');
		expect(el.style.height).toBe('100%');
	});
});

describe('FlowNode — overlap (stacking) parents', () => {
	it('an overlap container stacks its children into the shared cell (grid 1/1)', () => {
		const view = render(
			<FlowNode
				node={container('ov', 'col', [leaf(prim('A')), leaf(prim('B'))], { overlap: true })}
				parentKind="col"
				renderLeaf={renderLeaf}
			/>
		);
		// overlapChildStyle puts every child in the same grid cell (gridArea 1 / 1 / …).
		const a = view.container.querySelector('[data-id="A"]') as HTMLElement;
		const b = view.container.querySelector('[data-id="B"]') as HTMLElement;
		expect(a.style.gridArea).toBeTruthy();
		expect(b.style.gridArea).toBe(a.style.gridArea);
	});
});

describe('FlowNode — conditional containers (hiddenIds)', () => {
	it('an unmet conditional container keeps its slot but hides its subtree', () => {
		const node = container('cond', 'col', [leaf(prim('A'))]);
		const view = render(
			<FlowNode
				node={node}
				parentKind="col"
				renderLeaf={renderLeaf}
				hiddenIds={new Set(['cond'])}
			/>
		);
		const el = view.container.querySelector('[data-id="cond"]') as HTMLElement;
		expect(el.style.visibility).toBe('hidden');
		expect(el.getAttribute('data-hidden')).toBe('');
	});

	it('a container not in hiddenIds is visible (no data-hidden marker)', () => {
		const node = container('shown', 'col', [leaf(prim('A'))]);
		const view = render(
			<FlowNode
				node={node}
				parentKind="col"
				renderLeaf={renderLeaf}
				hiddenIds={new Set(['other'])}
			/>
		);
		const el = view.container.querySelector('[data-id="shown"]') as HTMLElement;
		expect(el.style.visibility).toBe('');
		expect(el.getAttribute('data-hidden')).toBeNull();
	});
});

describe('FlowNode — groups', () => {
	it('renders an empty group box (resolveGroup yields an empty container) without throwing', () => {
		// A group whose def has no child still resolves to a (col) container, so the group box renders
		// its single empty-container child rather than nothing.
		const emptyGroup = leaf(group('EG', { w: 20, h: 20 }, container('inner', 'col', [])));
		const view = render(
			<FlowNode node={emptyGroup} parentKind="col" renderLeaf={renderLeaf} library={lib} />
		);
		const box = view.container.querySelector('[data-id="EG"]') as HTMLElement;
		expect(box.getAttribute('data-group')).toBe('');
		expect(box.style.flexDirection).toBe('column');
		// The namespaced empty container is rendered inside the group box and fills it.
		const inner = view.container.querySelector('[data-id="EG/inner"]') as HTMLElement;
		expect(inner).toBeTruthy();
		expect(inner.style.width).toBe('100%');
	});
});
