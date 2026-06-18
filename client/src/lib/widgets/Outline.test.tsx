import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import Outline from './Outline';
import { container, emptyRoot, group, leaf, type Container, type Leaf } from '../core/layoutTree';
import type { WidgetInstance } from '../core/layout';

// A small flow tree: root(col) > [row > [a, b], c]
function tree(): Container {
	const w = (id: string): WidgetInstance => ({
		id,
		type: 'text',
		rect: { x: 0, y: 0, w: 10, h: 10 },
		config: {}
	});
	return {
		id: 'root',
		kind: 'col',
		children: [
			{
				id: 'r1',
				kind: 'row',
				children: [leaf(w('a')), leaf(w('b'))]
			} as Container,
			leaf(w('c'))
		]
	} as Container;
}

describe('Outline ARIA tree semantics', () => {
	it('exposes a tree with treeitems carrying level / selection', () => {
		const { getByRole, getAllByRole } = render(
			<Outline root={tree()} selectedId="a" onOp={() => undefined} />
		);
		expect(getByRole('tree')).toHaveAttribute('aria-label');
		const items = getAllByRole('treeitem');
		// root + r1 + a + b + c
		expect(items.length).toBe(5);
		// the row container sits at level 2 (depth 0); its leaf children sit deeper (level 3)
		const rowItem = items.find((el) => el.textContent?.includes('row'));
		expect(rowItem?.getAttribute('aria-level')).toBe('2');
		const deepLeaf = items.find((el) => el.getAttribute('aria-level') === '3');
		expect(deepLeaf).toBeTruthy();
		// the selected node is marked
		expect(items.some((el) => el.getAttribute('aria-selected') === 'true')).toBe(true);
	});

	it('gives every action button an accessible name (not glyph-only)', () => {
		const { getAllByLabelText } = render(
			<Outline root={tree()} selectedId="c" onOp={() => undefined} />
		);
		// these would be ✕ / ⤓ glyphs without an aria-label
		expect(getAllByLabelText('Remove').length).toBeGreaterThan(0);
		expect(getAllByLabelText('Float').length).toBeGreaterThan(0);
		expect(getAllByLabelText('Move up').length).toBeGreaterThan(0);
	});
});

describe('Outline leaf-drop feedback', () => {
	it('marks a leaf row as an invalid drop target on dragover (no reparent)', () => {
		const onOp = vi.fn();
		const { getAllByText } = render(<Outline root={tree()} onOp={onOp} />);
		const leafRow = getAllByText('• text', { selector: '.label' })[0].closest(
			'.row'
		) as HTMLElement;
		const data = {
			getData: () => 'a',
			dropEffect: '',
			effectAllowed: ''
		} as unknown as DataTransfer;
		fireEvent.dragOver(leafRow, { dataTransfer: data });
		expect(leafRow.className).toContain('dropno');
		// dropping on a leaf does not reparent
		fireEvent.drop(leafRow, { dataTransfer: data });
		expect(onOp).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'reparent' }));
	});
});

describe('Outline empty root', () => {
	it('renders a tree even with no children', () => {
		const { getByRole } = render(<Outline root={emptyRoot()} onOp={() => undefined} />);
		expect(getByRole('tree')).toBeTruthy();
	});
});

describe('Outline row context menu', () => {
	it('claims right-click on a row (preventDefault) and reports the node id + position', () => {
		const onMenu = vi.fn();
		const { getAllByText } = render(
			<Outline root={tree()} onOp={() => undefined} onNodeContextMenu={onMenu} />
		);
		const row = getAllByText('• text', { selector: '.label' })[0].closest('.row') as HTMLElement;
		const ev = fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
		expect(onMenu).toHaveBeenCalledWith({ id: 'a', x: 40, y: 60 });
		expect(ev).toBe(false); // fireEvent returns false when preventDefault() was called
	});

	it('leaves right-click native when no handler is supplied (overlay / preview)', () => {
		const { getAllByText } = render(<Outline root={tree()} onOp={() => undefined} />);
		const row = getAllByText('• text', { selector: '.label' })[0].closest('.row') as HTMLElement;
		expect(fireEvent.contextMenu(row)).toBe(true); // not prevented
	});
});

// --- a labelled tree so rows are individually addressable by their hint text -----------------------
const prim = (id: string, type: string, extra: Partial<WidgetInstance> = {}): WidgetInstance => ({
	id,
	type,
	rect: { x: 0, y: 0, w: 100, h: 24 },
	config: {},
	...extra
});

// root(col)
//   ├─ row "rowA"
//   │    ├─ text "a-text"  (config.label "Hello")
//   │    └─ gauge "a-gauge" (sensor "cpu.total")
//   └─ clock "b-clock"
const labelledRoot = (): Container =>
	container(
		'root',
		'col',
		[
			container('rowA', 'row', [
				leaf(prim('a-text', 'text', { config: { label: 'Hello' } })),
				leaf(prim('a-gauge', 'gauge', { sensor: 'cpu.total' }))
			]),
			leaf(prim('b-clock', 'clock'))
		],
		{ align: 'stretch' }
	);

describe('Outline row labels + hints', () => {
	it('shows each node primary text + the recognisable hint (label / sensor)', () => {
		const { getByText } = render(<Outline root={labelledRoot()} />);
		expect(getByText('▦ root (col)')).toBeTruthy();
		expect(getByText('▦ row')).toBeTruthy();
		expect(getByText('• text')).toBeTruthy();
		expect(getByText('• gauge')).toBeTruthy();
		expect(getByText('• clock')).toBeTruthy();
		// hints: text leaf surfaces config.label, gauge surfaces its bound sensor.
		expect(getByText('Hello')).toBeTruthy();
		expect(getByText('cpu.total')).toBeTruthy();
	});

	it('shows a group leaf as "• group" with its name as the hint', () => {
		const g = group('g1', { w: 50, h: 50 }, leaf(prim('inner', 'text')), { name: 'My Widget' });
		const root = container('root', 'col', [leaf(g)]);
		const { getByText } = render(<Outline root={root} />);
		expect(getByText('• group')).toBeTruthy();
		expect(getByText('My Widget')).toBeTruthy();
	});

	it('appends the scopeLabel to the header when given', () => {
		const { getByText } = render(<Outline root={labelledRoot()} scopeLabel="MyDef" />);
		expect(getByText('Outline · MyDef')).toBeTruthy();
	});
});

describe('Outline select + structural ops', () => {
	it('clicking a row label emits a select op for that node', () => {
		const onOp = vi.fn();
		const { getByText } = render(<Outline root={labelledRoot()} onOp={onOp} />);
		fireEvent.click(getByText('• text'));
		expect(onOp).toHaveBeenCalledWith({ op: 'select', id: 'a-text' });
	});

	it('clicking the root row selects the root', () => {
		const onOp = vi.fn();
		const { getByText } = render(<Outline root={labelledRoot()} onOp={onOp} />);
		fireEvent.click(getByText('▦ root (col)'));
		expect(onOp).toHaveBeenCalledWith({ op: 'select', id: 'root' });
	});

	it('the header +Row / +Column / +Grid buttons emit addContainer ops', () => {
		const onOp = vi.fn();
		const { getByText } = render(<Outline root={labelledRoot()} onOp={onOp} />);
		fireEvent.click(getByText('＋ Row'));
		fireEvent.click(getByText('＋ Column'));
		fireEvent.click(getByText('＋ Grid'));
		expect(onOp).toHaveBeenCalledWith({ op: 'addContainer', kind: 'row' });
		expect(onOp).toHaveBeenCalledWith({ op: 'addContainer', kind: 'col' });
		expect(onOp).toHaveBeenCalledWith({ op: 'addContainer', kind: 'grid' });
	});

	it('the per-row action buttons emit move/outdent/remove ops scoped to that node', () => {
		const onOp = vi.fn();
		// a-text is the FIRST child of rowA (siblings: a-text, a-gauge) → Move down/out/float enabled.
		const row = container('rowA', 'row', [
			leaf(prim('a-text', 'text')),
			leaf(prim('a-gauge', 'gauge'))
		]);
		const root = container('root', 'col', [row]);
		const { getByText } = render(<Outline root={root} onOp={onOp} />);
		// Scope the (per-row) action buttons to a-text's own row — every row renders the same set.
		const aRow = within(getByText('• text').closest('.row')!);
		fireEvent.click(aRow.getByLabelText('Move down'));
		expect(onOp).toHaveBeenCalledWith({ op: 'moveDown', id: 'a-text' });
		fireEvent.click(aRow.getByLabelText('Move out'));
		expect(onOp).toHaveBeenCalledWith({ op: 'outdent', id: 'a-text' });
		fireEvent.click(aRow.getByLabelText('Float'));
		expect(onOp).toHaveBeenCalledWith({ op: 'float', id: 'a-text' });
	});

	it('disables Move up for a first child and Move out for a direct child of root', () => {
		// Two direct children of root so the disabled flags are unambiguous.
		const root = container('root', 'col', [leaf(prim('x', 'text')), leaf(prim('y', 'text'))]);
		const { getAllByText } = render(<Outline root={root} />);
		// x is the first direct child of root → Move up disabled; its parent IS root → Move out disabled.
		const xRow = within(getAllByText('• text')[0].closest('.row')!);
		expect((xRow.getByLabelText('Move up') as HTMLButtonElement).disabled).toBe(true);
		expect((xRow.getByLabelText('Move out') as HTMLButtonElement).disabled).toBe(true);
	});

	it('marks the selected node row with the .sel class', () => {
		const { getByText } = render(<Outline root={labelledRoot()} selectedId="b-clock" />);
		expect(getByText('• clock').closest('.row')!.className).toContain('sel');
	});
});

describe('Outline hover cross-highlight', () => {
	it('reports hover enter/leave for a row via onHover', () => {
		const onHover = vi.fn();
		const { getByText } = render(<Outline root={labelledRoot()} onHover={onHover} />);
		const row = getByText('• clock').closest('.row')!;
		fireEvent.mouseEnter(row);
		expect(onHover).toHaveBeenCalledWith('b-clock');
		fireEvent.mouseLeave(row);
		expect(onHover).toHaveBeenCalledWith(null);
	});

	it('marks the hovered row with the .hover class from the hoverId prop', () => {
		const { getByText } = render(<Outline root={labelledRoot()} hoverId="b-clock" />);
		expect(getByText('• clock').closest('.row')!.className).toContain('hover');
	});
});

describe('Outline drag-and-drop into containers', () => {
	// happy-dom has no DataTransfer; a minimal stub that records type/data writes.
	function fakeDataTransfer(initial: Record<string, string> = {}) {
		const store: Record<string, string> = { ...initial };
		return {
			effectAllowed: '',
			dropEffect: '',
			setData: (k: string, v: string) => {
				store[k] = v;
			},
			getData: (k: string) => store[k] ?? ''
		};
	}

	it('dropping a node-id onto a CONTAINER row emits a reparent op', () => {
		const onOp = vi.fn();
		const { getByText } = render(<Outline root={labelledRoot()} onOp={onOp} />);
		const containerRow = getByText('▦ row').closest('.row')!;
		const dt = fakeDataTransfer({ 'text/x-node-id': 'b-clock' });
		fireEvent.dragOver(containerRow, { dataTransfer: dt });
		expect(containerRow.className).toContain('dropok'); // valid target highlight
		fireEvent.drop(containerRow, { dataTransfer: dt });
		expect(onOp).toHaveBeenCalledWith({ op: 'reparent', id: 'b-clock', containerId: 'rowA' });
	});

	it('dropping a palette widget-type onto a container row emits a dropWidget op', () => {
		const onOp = vi.fn();
		const { getByText } = render(<Outline root={labelledRoot()} onOp={onOp} />);
		const containerRow = getByText('▦ row').closest('.row')!;
		const dt = fakeDataTransfer({ 'text/x-widget-type': 'sparkline' });
		fireEvent.dragOver(containerRow, { dataTransfer: dt });
		fireEvent.drop(containerRow, { dataTransfer: dt });
		expect(onOp).toHaveBeenCalledWith({
			op: 'dropWidget',
			containerId: 'rowA',
			widgetType: 'sparkline'
		});
	});

	it('dragging a row writes its node id onto the dataTransfer (so it can be reparented)', () => {
		const { getByText } = render(<Outline root={labelledRoot()} />);
		const leafRow = getByText('• clock').closest('.row')!;
		const dt = fakeDataTransfer();
		fireEvent.dragStart(leafRow, { dataTransfer: dt });
		// The row carries its node id as the drag payload → a later drop reparents THIS node.
		expect(dt.getData('text/x-node-id')).toBe('b-clock');
	});

	it('drag-leave clears the drop-target highlight from a container row', () => {
		const { getByText } = render(<Outline root={labelledRoot()} />);
		const containerRow = getByText('▦ row').closest('.row')!;
		const dt = fakeDataTransfer({ 'text/x-node-id': 'b-clock' });
		fireEvent.dragOver(containerRow, { dataTransfer: dt });
		expect(containerRow.className).toContain('dropok');
		fireEvent.dragLeave(containerRow, { dataTransfer: dt });
		expect(containerRow.className).not.toContain('dropok');
	});
});

describe('Outline floating layer', () => {
	const floating: Leaf[] = [leaf(prim('fl-1', 'text', { config: { label: 'Floater' } }))];

	it('renders a Floating section with a dock + remove action per floating leaf', () => {
		const onOp = vi.fn();
		const { getByText, getByLabelText } = render(
			<Outline root={labelledRoot()} floating={floating} onOp={onOp} />
		);
		expect(getByText('Floating')).toBeTruthy();
		expect(getByText('Floater')).toBeTruthy(); // the floating leaf's label hint
		fireEvent.click(getByLabelText('Dock into root'));
		expect(onOp).toHaveBeenCalledWith({ op: 'dock', id: 'fl-1' });
	});

	it('omits the Floating section when there are no floating leaves', () => {
		const { queryByText } = render(<Outline root={labelledRoot()} />);
		expect(queryByText('Floating')).toBeNull();
	});
});
