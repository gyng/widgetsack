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
		const { getAllByLabelText, getByText } = render(
			<Outline root={tree()} selectedId="c" onOp={() => undefined} />
		);
		// these would be ✕ / ⋯ / ⤓ glyphs without an aria-label
		expect(getAllByLabelText('Remove').length).toBeGreaterThan(0);
		expect(getAllByLabelText('More actions').length).toBeGreaterThan(0);
		// The structural moves live in the ⋯ overflow menu.
		fireEvent.click(within(getByText('▦ row').closest('.row')!).getByLabelText('More actions'));
		expect(getAllByLabelText('Move up').length).toBe(1);
		expect(getAllByLabelText('Move down').length).toBe(1);
	});
});

describe('Outline leaf-drop feedback', () => {
	it('marks a leaf row as an invalid drop target on dragover (no reparent)', () => {
		const onOp = vi.fn();
		const { getAllByText } = render(<Outline root={tree()} onOp={onOp} />);
		const leafRow = getAllByText('• Text', { selector: '.label' })[0].closest(
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
		const row = getAllByText('• Text', { selector: '.label' })[0].closest('.row') as HTMLElement;
		const ev = fireEvent.contextMenu(row, { clientX: 40, clientY: 60, button: 2 });
		expect(onMenu).toHaveBeenCalledWith({ id: 'a', x: 40, y: 60 });
		expect(ev).toBe(false); // fireEvent returns false when preventDefault() was called
	});

	it('a keyboard-initiated contextmenu (no pointer position) anchors the menu at the row', () => {
		const onMenu = vi.fn();
		const { getAllByText } = render(
			<Outline root={tree()} onOp={() => undefined} onNodeContextMenu={onMenu} />
		);
		const row = getAllByText('• Text', { selector: '.label' })[0].closest('.row') as HTMLElement;
		row.getBoundingClientRect = () => ({ left: 10, top: 100, width: 200, height: 24 }) as DOMRect;
		fireEvent.contextMenu(row, { clientX: 0, clientY: 0, button: 0 });
		expect(onMenu).toHaveBeenCalledWith({ id: 'a', x: 110, y: 112 });
	});

	it('leaves right-click native when no handler is supplied (overlay / preview)', () => {
		const { getAllByText } = render(<Outline root={tree()} onOp={() => undefined} />);
		const row = getAllByText('• Text', { selector: '.label' })[0].closest('.row') as HTMLElement;
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
		expect(getByText('• Text')).toBeTruthy();
		expect(getByText('• Gauge')).toBeTruthy();
		expect(getByText('• Clock')).toBeTruthy();
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

	it('falls back to the def id, then the node id, when a group has no name', () => {
		// No name → surface the backing def id as the recognisable hint.
		const withDef = group('g-def', { w: 50, h: 50 }, leaf(prim('inner', 'text')), {
			def: 'clockDef'
		});
		const r1 = container('root', 'col', [leaf(withDef)]);
		const { getByText, unmount } = render(<Outline root={r1} />);
		expect(getByText('clockDef')).toBeTruthy();
		unmount();
		// No name AND no def → the node id is the last-resort hint.
		const bare = group('g-bare', { w: 50, h: 50 }, leaf(prim('inner', 'text')));
		const r2 = container('root', 'col', [leaf(bare)]);
		expect(render(<Outline root={r2} />).getByText('g-bare')).toBeTruthy();
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
		fireEvent.click(getByText('• Text'));
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
		// The moves sit behind the row's ⋯ menu (which closes after each action).
		const aRow = within(getByText('• Text').closest('.row')!);
		fireEvent.click(aRow.getByLabelText('More actions'));
		fireEvent.click(aRow.getByLabelText('Move down'));
		expect(onOp).toHaveBeenCalledWith({ op: 'moveDown', id: 'a-text' });
		expect(aRow.queryByRole('menu')).toBeNull(); // closed after acting
		fireEvent.click(aRow.getByLabelText('More actions'));
		fireEvent.click(aRow.getByLabelText('Move out'));
		expect(onOp).toHaveBeenCalledWith({ op: 'outdent', id: 'a-text' });
		fireEvent.click(aRow.getByLabelText('More actions'));
		fireEvent.click(aRow.getByLabelText('Float'));
		expect(onOp).toHaveBeenCalledWith({ op: 'float', id: 'a-text' });
		// ⋯ toggles: a second click closes without acting.
		fireEvent.click(aRow.getByLabelText('More actions'));
		fireEvent.click(aRow.getByLabelText('More actions'));
		expect(aRow.queryByRole('menu')).toBeNull();
	});

	it('disables Move up for a first child and Move out for a direct child of root', () => {
		// Two direct children of root so the disabled flags are unambiguous.
		const root = container('root', 'col', [leaf(prim('x', 'text')), leaf(prim('y', 'text'))]);
		const { getAllByText } = render(<Outline root={root} />);
		// x is the first direct child of root → Move up disabled; its parent IS root → Move out disabled.
		const xRow = within(getAllByText('• Text')[0].closest('.row')!);
		fireEvent.click(xRow.getByLabelText('More actions'));
		expect((xRow.getByLabelText('Move up') as HTMLButtonElement).disabled).toBe(true);
		expect((xRow.getByLabelText('Move out') as HTMLButtonElement).disabled).toBe(true);
	});

	it('marks the selected node row with the .sel class', () => {
		const { getByText } = render(<Outline root={labelledRoot()} selectedId="b-clock" />);
		expect(getByText('• Clock').closest('.row')!.className).toContain('sel');
	});
});

describe('Outline hover cross-highlight', () => {
	it('reports hover enter/leave for a row via onHover', () => {
		const onHover = vi.fn();
		const { getByText } = render(<Outline root={labelledRoot()} onHover={onHover} />);
		const row = getByText('• Clock').closest('.row')!;
		fireEvent.mouseEnter(row);
		expect(onHover).toHaveBeenCalledWith('b-clock');
		fireEvent.mouseLeave(row);
		expect(onHover).toHaveBeenCalledWith(null);
	});

	it('marks the hovered row with the .hover class from the hoverId prop', () => {
		const { getByText } = render(<Outline root={labelledRoot()} hoverId="b-clock" />);
		expect(getByText('• Clock').closest('.row')!.className).toContain('hover');
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
		const leafRow = getByText('• Clock').closest('.row')!;
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

	it('tolerates drag events that carry no dataTransfer (synthetic drags)', () => {
		const { getByText } = render(<Outline root={labelledRoot()} />);
		const leafRow = getByText('• Clock').closest('.row')!;
		const containerRow = getByText('▦ row').closest('.row')!;
		// No dataTransfer on any of these — the handlers must skip the payload/effect writes without
		// crashing, and the visual target feedback still applies (it doesn't depend on the payload).
		fireEvent.dragStart(leafRow);
		fireEvent.dragOver(leafRow);
		expect(leafRow.className).toContain('dropno');
		fireEvent.dragOver(containerRow);
		expect(containerRow.className).toContain('dropok');
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
		fireEvent.click(getByLabelText('Snap into layout'));
		expect(onOp).toHaveBeenCalledWith({ op: 'dock', id: 'fl-1' });
	});

	it('omits the Floating section when there are no floating leaves', () => {
		const { queryByText } = render(<Outline root={labelledRoot()} />);
		expect(queryByText('Floating')).toBeNull();
	});

	it('marks a floating row selected / hovered, drags it, and selects it on click', () => {
		const onOp = vi.fn();
		const onHover = vi.fn();
		const { getByText } = render(
			<Outline
				root={labelledRoot()}
				floating={floating}
				selectedId="fl-1"
				hoverId="fl-1"
				onHover={onHover}
				onOp={onOp}
			/>
		);
		const flRow = getByText('Floater').closest('.row') as HTMLElement;
		expect(flRow.className).toContain('sel');
		expect(flRow.className).toContain('hover');
		// Dragging a floating row writes its node id as the drag payload.
		const store: Record<string, string> = {};
		const dt = {
			effectAllowed: '',
			setData: (k: string, v: string) => {
				store[k] = v;
			},
			getData: (k: string) => store[k] ?? ''
		};
		fireEvent.dragStart(flRow, { dataTransfer: dt });
		expect(store['text/x-node-id']).toBe('fl-1');
		// Clicking the floating row's label selects it.
		fireEvent.click(getByText('Floater'));
		expect(onOp).toHaveBeenCalledWith({ op: 'select', id: 'fl-1' });
	});
});

describe('Outline root row', () => {
	it('adds a "docked" class to the panel when docked', () => {
		const { container: root } = render(<Outline root={labelledRoot()} docked />);
		expect(root.querySelector('.outline')!.className).toContain('docked');
	});

	it('marks the root row selected / hovered from the props', () => {
		const { getByText } = render(
			<Outline root={labelledRoot()} selectedId="root" hoverId="root" />
		);
		const rootRow = getByText('▦ root (col)').closest('.row') as HTMLElement;
		expect(rootRow.className).toContain('sel');
		expect(rootRow.className).toContain('root');
		expect(rootRow.className).toContain('hover');
	});

	it('accepts a drop onto the root row (highlight + reparent into root)', () => {
		const onOp = vi.fn();
		const { getByText } = render(<Outline root={labelledRoot()} onOp={onOp} />);
		const rootRow = getByText('▦ root (col)').closest('.row') as HTMLElement;
		const store: Record<string, string> = { 'text/x-node-id': 'b-clock' };
		const dt = {
			dropEffect: '',
			effectAllowed: '',
			setData: (k: string, v: string) => {
				store[k] = v;
			},
			getData: (k: string) => store[k] ?? ''
		};
		fireEvent.dragOver(rootRow, { dataTransfer: dt });
		expect(rootRow.className).toContain('dropok'); // root is a container → a valid drop target
		fireEvent.drop(rootRow, { dataTransfer: dt });
		expect(onOp).toHaveBeenCalledWith({ op: 'reparent', id: 'b-clock', containerId: 'root' });
	});
});

// --- keyboard tree: roving tabindex + arrow navigation + collapse/expand -----------------------------
describe('Outline keyboard tree', () => {
	// root(col) > [rowA > [a-text, a-gauge], b-clock] + floating fl-1
	const floating: Leaf[] = [leaf(prim('fl-1', 'text', { config: { label: 'Floater' } }))];
	const items = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')];
	const tabStops = (root: HTMLElement) => items(root).filter((el) => el.tabIndex === 0);

	it('has exactly one tab stop: the selected row (else the root)', () => {
		const { container: c, rerender } = render(
			<Outline root={labelledRoot()} floating={floating} selectedId="a-gauge" />
		);
		let stops = tabStops(c);
		expect(stops.length).toBe(1);
		expect(stops[0].textContent).toContain('cpu.total');
		// Inner buttons (label / actions) are not extra stops.
		expect(
			[...c.querySelectorAll<HTMLElement>('.row button')].every((b) => b.tabIndex === -1)
		).toBe(true);
		// Selecting another node re-homes the stop onto it.
		rerender(<Outline root={labelledRoot()} floating={floating} selectedId="b-clock" />);
		stops = tabStops(c);
		expect(stops.length).toBe(1);
		expect(stops[0].textContent).toContain('Clock');
		// Deselecting keeps the stop where it was (the last row the user was on) — still just one.
		rerender(<Outline root={labelledRoot()} floating={floating} selectedId={null} />);
		stops = tabStops(c);
		expect(stops.length).toBe(1);
		expect(stops[0].textContent).toContain('Clock');
		// A fresh tree with nothing selected starts at the root.
		const { container: c2 } = render(<Outline root={labelledRoot()} />);
		expect(tabStops(c2).length).toBe(1);
		expect(tabStops(c2)[0].className).toContain('root');
	});

	it('ArrowDown / ArrowUp / Home / End move focus through root → tree rows → floating', () => {
		const { container: c } = render(<Outline root={labelledRoot()} floating={floating} />);
		const rows = items(c); // [root, rowA, a-text, a-gauge, b-clock, fl-1]
		rows[0].focus();
		fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
		expect(document.activeElement).toBe(rows[1]);
		expect(rows[1].tabIndex).toBe(0);
		expect(rows[0].tabIndex).toBe(-1);
		fireEvent.keyDown(rows[1], { key: 'End' });
		expect(document.activeElement).toBe(rows[5]);
		fireEvent.keyDown(rows[5], { key: 'ArrowDown' }); // already last → stays
		expect(document.activeElement).toBe(rows[5]);
		fireEvent.keyDown(rows[5], { key: 'ArrowUp' });
		expect(document.activeElement).toBe(rows[4]);
		fireEvent.keyDown(rows[4], { key: 'Home' });
		expect(document.activeElement).toBe(rows[0]);
		fireEvent.keyDown(rows[0], { key: 'ArrowUp' }); // already first → stays
		expect(document.activeElement).toBe(rows[0]);
	});

	it('Enter / Space select the focused row; unhandled keys pass through', () => {
		const onOp = vi.fn();
		const { container: c } = render(<Outline root={labelledRoot()} onOp={onOp} />);
		const rows = items(c);
		fireEvent.keyDown(rows[4], { key: 'Enter' });
		expect(onOp).toHaveBeenLastCalledWith({ op: 'select', id: 'b-clock' });
		fireEvent.keyDown(rows[1], { key: ' ' });
		expect(onOp).toHaveBeenLastCalledWith({ op: 'select', id: 'rowA' });
		// An unhandled key is neither prevented nor swallowed (bubbles to the studio bindings).
		expect(fireEvent.keyDown(rows[1], { key: 'x' })).toBe(true);
		// A handled navigation key IS prevented (so it can't also nudge the selected widget).
		expect(fireEvent.keyDown(rows[1], { key: 'ArrowDown' })).toBe(false);
	});

	it('ArrowLeft collapses an expanded container (hiding its children); ArrowRight expands it', () => {
		const { container: c, getByText, queryByText } = render(<Outline root={labelledRoot()} />);
		const rowA = getByText('▦ row').closest('.row') as HTMLElement;
		expect(rowA.getAttribute('aria-expanded')).toBe('true');
		fireEvent.keyDown(rowA, { key: 'ArrowLeft' });
		expect(rowA.getAttribute('aria-expanded')).toBe('false');
		expect(queryByText('• Gauge')).toBeNull();
		expect(items(c).length).toBe(3); // root, rowA, b-clock
		// Left again on a collapsed container moves to the parent (root).
		fireEvent.keyDown(rowA, { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(items(c)[0]);
		// Right on the collapsed container expands it; Right again moves into the first child.
		fireEvent.keyDown(rowA, { key: 'ArrowRight' });
		expect(rowA.getAttribute('aria-expanded')).toBe('true');
		expect(getByText('• Gauge')).toBeTruthy();
		fireEvent.keyDown(rowA, { key: 'ArrowRight' });
		expect(document.activeElement?.textContent).toContain('Hello'); // a-text
		// Left on a leaf moves to its parent row.
		fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(rowA);
		// Leaves have no aria-expanded and ignore ArrowRight.
		const clock = getByText('• Clock').closest('.row') as HTMLElement;
		expect(clock.getAttribute('aria-expanded')).toBeNull();
		fireEvent.keyDown(clock, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(rowA);
	});

	it('the ▸/▾ chevron toggles collapse with the mouse, and the root ignores ArrowLeft', () => {
		const {
			container: c,
			getByText,
			getByLabelText,
			queryByText
		} = render(<Outline root={labelledRoot()} />);
		fireEvent.click(getByLabelText('Collapse'));
		expect(queryByText('Hello')).toBeNull();
		fireEvent.click(getByLabelText('Expand'));
		expect(getByText('Hello')).toBeTruthy();
		const rootRow = items(c)[0];
		rootRow.focus();
		fireEvent.keyDown(rootRow, { key: 'ArrowLeft' }); // no parent, no collapse of root
		expect(document.activeElement).toBe(rootRow);
		expect(items(c).length).toBe(5);
		// ArrowRight on the root moves into its first child.
		fireEvent.keyDown(rootRow, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(items(c)[1]);
		// A floating row has no parent: ArrowLeft is a no-op there, and Alt+Arrow (tree-only) too.
		const { container: c2 } = render(<Outline root={emptyRoot()} floating={floating} />);
		const fl = items(c2)[1];
		fl.focus();
		fireEvent.keyDown(fl, { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(fl);
		expect(fireEvent.keyDown(fl, { key: 'ArrowUp', altKey: true })).toBe(true);
		// An empty root has nothing to expand into.
		const emptyRootRow = items(c2)[0];
		fireEvent.keyDown(emptyRootRow, { key: 'ArrowRight' });
		expect(emptyRootRow.getAttribute('aria-expanded')).toBeNull();
	});

	it('Alt+Arrow runs the structural moves (up / down / out / in) for the focused tree row', () => {
		const onOp = vi.fn();
		const { getByText } = render(<Outline root={labelledRoot()} onOp={onOp} />);
		const gauge = getByText('• Gauge').closest('.row') as HTMLElement; // 2nd child of rowA
		fireEvent.keyDown(gauge, { key: 'ArrowUp', altKey: true });
		expect(onOp).toHaveBeenLastCalledWith({ op: 'moveUp', id: 'a-gauge' });
		fireEvent.keyDown(gauge, { key: 'ArrowLeft', altKey: true });
		expect(onOp).toHaveBeenLastCalledWith({ op: 'outdent', id: 'a-gauge' });
		fireEvent.keyDown(gauge, { key: 'ArrowRight', altKey: true });
		expect(onOp).toHaveBeenLastCalledWith({ op: 'indent', id: 'a-gauge' });
		onOp.mockClear();
		fireEvent.keyDown(gauge, { key: 'ArrowDown', altKey: true }); // last sibling → no-op
		expect(onOp).not.toHaveBeenCalled();
		const text = getByText('Hello').closest('.row') as HTMLElement; // 1st child of rowA
		fireEvent.keyDown(text, { key: 'ArrowDown', altKey: true });
		expect(onOp).toHaveBeenLastCalledWith({ op: 'moveDown', id: 'a-text' });
		onOp.mockClear();
		fireEvent.keyDown(text, { key: 'ArrowUp', altKey: true }); // first sibling → no-op
		fireEvent.keyDown(text, { key: 'ArrowRight', altKey: true }); // no previous sibling → no-op
		const rowA = getByText('▦ row').closest('.row') as HTMLElement;
		fireEvent.keyDown(rowA, { key: 'ArrowLeft', altKey: true }); // direct child of root → no-op
		expect(fireEvent.keyDown(rowA, { key: 'x', altKey: true })).toBe(true);
		expect(onOp).not.toHaveBeenCalled();
	});

	it('falls back to the root tab stop when the focused row gets hidden by a collapse', () => {
		const { container: c, getByText } = render(<Outline root={labelledRoot()} />);
		const gauge = getByText('• Gauge').closest('.row') as HTMLElement;
		gauge.focus();
		fireEvent.keyDown(gauge, { key: 'ArrowUp' }); // focus a-text (roving stop moves with it)
		expect(tabStops(c)[0].textContent).toContain('Hello');
		fireEvent.click(within(getByText('▦ row').closest('.row')!).getByLabelText('Collapse'));
		expect(tabStops(c).length).toBe(1);
		expect(tabStops(c)[0].className).toContain('root');
	});

	it('labels a row by the widget type label, falling back to the raw type when unregistered', () => {
		const root = container('root', 'col', [leaf(prim('m', 'mystery.type'))]);
		const { getByText } = render(<Outline root={root} />);
		expect(getByText('• mystery.type')).toBeTruthy();
	});

	it('Escape inside the ⋯ menu closes it and returns focus to the row', () => {
		const { getByText, queryByRole } = render(<Outline root={labelledRoot()} />);
		const rowA = getByText('▦ row').closest('.row') as HTMLElement;
		fireEvent.click(within(rowA).getByLabelText('More actions'));
		const menuBtn = within(rowA).getByLabelText('Move up');
		menuBtn.focus();
		expect(fireEvent.keyDown(menuBtn, { key: 'ArrowDown' })).toBe(true); // menu keys pass through
		fireEvent.keyDown(menuBtn, { key: 'Escape' });
		expect(queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(rowA);
	});
});
