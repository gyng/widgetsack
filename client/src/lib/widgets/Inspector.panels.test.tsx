import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import Inspector from './Inspector';
import { container, group, leaf, type Group, type WidgetDef } from '../core/layoutTree';
import type { LayoutOp } from './ops';

// The hover-preview popover renders real meters; the panel tests never touch it.
vi.mock('./WidgetPreview', () => ({ default: () => null }));

const panel = (): HTMLElement => screen.getByRole('tabpanel');
const lastOp = (onOp: ReturnType<typeof vi.fn>, op: string): LayoutOp | undefined =>
	onOp.mock.calls
		.map((c) => c[0] as LayoutOp)
		.reverse()
		.find((o) => o.op === op);

describe('Inspector container property panel', () => {
	it('shows the "<Kind> container" header (id in the tooltip) and emits patchContainer on a kind change', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const c = container('root', 'col', [], { align: 'stretch' });
		render(<Inspector container={c} onOp={onOp} />);
		const hd = within(panel()).getByText('Column container');
		expect(hd.getAttribute('title')).toBe('Column container · root');
		fireEvent.click(within(panel()).getByLabelText('kind'));
		fireEvent.click(screen.getByText('row (hsplit)', { selector: '.np-select-opt-label' }));
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'root',
			patch: { kind: 'row' }
		});
	});

	it('shows grid cols/rows only for a grid and patches them', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const colC = container('root', 'col', []);
		const { rerender } = render(<Inspector container={colC} onOp={onOp} />);
		expect(within(panel()).queryByRole('spinbutton', { name: 'cols' })).toBeNull();

		const gridC = container('g', 'grid', [], { cols: 2, rows: 2 });
		rerender(<Inspector container={gridC} onOp={onOp} />);
		fireEvent.input(within(panel()).getByRole('spinbutton', { name: 'cols' }), {
			target: { value: '3' }
		});
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'g',
			patch: { cols: 3 }
		});
	});

	it('patches the gap', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector container={container('root', 'col', [])} onOp={onOp} />);
		fireEvent.input(within(panel()).getByRole('spinbutton', { name: 'gap' }), {
			target: { value: '8' }
		});
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'root',
			patch: { gap: 8 }
		});
	});

	it('toggles "stack children (overlap)"', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector container={container('root', 'col', [])} onOp={onOp} />);
		fireEvent.click(within(panel()).getByRole('checkbox', { name: /stack children/i }));
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'root',
			patch: { overlap: true }
		});
	});

	it('reflects an fr basis as "grow" and clears it to fit on "hug — fit children"', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const c = container('root', 'col', [], { basis: { fr: 1 } });
		render(<Inspector container={c} onOp={onOp} />);
		const trigger = within(panel()).getByLabelText('container size in parent');
		expect(trigger).toHaveTextContent(/grow/i);
		fireEvent.click(trigger);
		fireEvent.click(screen.getByText('hug — fit children', { selector: '.np-select-opt-label' }));
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'root',
			patch: { basis: undefined }
		});
	});

	it('shows a fixed-px size input when the basis is numeric and patches it', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const c = container('root', 'col', [], { basis: 120 });
		render(<Inspector container={c} onOp={onOp} />);
		fireEvent.input(within(panel()).getByRole('spinbutton', { name: 'size (px)' }), {
			target: { value: '200' }
		});
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'root',
			patch: { basis: 200 }
		});
	});

	it('shows grid-cell sizing fields only when isGridCell, and patches cellW', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const c = container('cell', 'col', []);
		const { rerender } = render(<Inspector container={c} onOp={onOp} />);
		expect(within(panel()).queryByText('Grid cell', { selector: '.hd' })).toBeNull();

		rerender(<Inspector container={c} isGridCell onOp={onOp} />);
		expect(within(panel()).getByText('Grid cell', { selector: '.hd' })).toBeTruthy();
		fireEvent.input(within(panel()).getByRole('spinbutton', { name: 'width (px)' }), {
			target: { value: '64' }
		});
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'cell',
			patch: { cellW: 64 }
		});
	});

	it('emits makeWidget and remove from the container actions', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector container={container('root', 'col', [])} onOp={onOp} />);
		fireEvent.click(within(panel()).getByRole('button', { name: 'Save as custom widget' }));
		expect(lastOp(onOp, 'makeWidget')).toEqual({ op: 'makeWidget', id: 'root' });
		fireEvent.click(within(panel()).getByRole('button', { name: 'Remove' }));
		expect(lastOp(onOp, 'remove')).toEqual({ op: 'remove', id: 'root' });
	});

	it('turns the container conditional via the Visibility editor', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector container={container('root', 'col', [])} onOp={onOp} />);
		fireEvent.click(within(panel()).getByRole('checkbox', { name: /Conditional — show \/ hide/i }));
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'root',
			patch: { condition: { kind: 'appOpen' } }
		});
	});
});

describe('Inspector group property panel', () => {
	const groupUnit = (over: Partial<Group> = {}): Group =>
		group(
			'grp1',
			{ w: 100, h: 40 },
			{ id: 'c', unit: { id: 'w', type: 'clock', rect: { x: 0, y: 0, w: 1, h: 1 }, config: {} } },
			{ name: 'My Group', ...over }
		);

	it('shows the group name as the header (id in the tooltip) and patches the name', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector groupUnit={groupUnit()} onOp={onOp} />);
		const hd = screen.getByText('My Group', { selector: '.node-hd' });
		expect(hd.getAttribute('title')).toBe('Group · My Group · grp1');
		fireEvent.input(screen.getByDisplayValue('My Group'), { target: { value: 'Renamed' } });
		expect(lastOp(onOp, 'patchGroup')).toEqual({
			op: 'patchGroup',
			id: 'grp1',
			patch: { name: 'Renamed' }
		});
	});

	it('shows "inline group (not a custom widget)" when no def backs the group', () => {
		render(<Inspector groupUnit={groupUnit()} onOp={vi.fn()} />);
		expect(screen.getByText('inline group (not a custom widget)')).toBeTruthy();
	});

	it('renders def fields when a def is supplied, and renames the def', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const def: WidgetDef = {
			id: 'def1',
			name: 'Lib Widget',
			size: { w: 120, h: 50 },
			child: {
				id: 'c',
				unit: { id: 'w', type: 'clock', rect: { x: 0, y: 0, w: 1, h: 1 }, config: {} }
			}
		};
		render(<Inspector groupUnit={groupUnit({ def: 'def1' })} def={def} onOp={onOp} />);
		fireEvent.input(screen.getByDisplayValue('Lib Widget'), { target: { value: 'New Name' } });
		expect(lastOp(onOp, 'renameDef')).toEqual({ op: 'renameDef', defId: 'def1', name: 'New Name' });
		fireEvent.click(screen.getByRole('button', { name: 'Edit custom widget…' }));
		expect(lastOp(onOp, 'editDef')).toEqual({ op: 'editDef', defId: 'def1' });
	});

	it('adds a def param from the key/target inputs', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const def: WidgetDef = {
			id: 'def1',
			name: 'Lib Widget',
			size: { w: 120, h: 50 },
			child: {
				id: 'c',
				unit: { id: 'w', type: 'clock', rect: { x: 0, y: 0, w: 1, h: 1 }, config: {} }
			}
		};
		render(<Inspector groupUnit={groupUnit({ def: 'def1' })} def={def} onOp={onOp} />);
		fireEvent.change(screen.getByPlaceholderText('param key'), { target: { value: 'core' } });
		fireEvent.change(screen.getByPlaceholderText('path, e.g. unit.sensor'), {
			target: { value: 'unit.sensor' }
		});
		fireEvent.click(screen.getByRole('button', { name: 'Add param' }));
		expect(lastOp(onOp, 'addDefParam')).toEqual({
			op: 'addDefParam',
			defId: 'def1',
			key: 'core',
			target: 'unit.sensor'
		});
	});

	it('emits ungroup and remove from the group actions', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector groupUnit={groupUnit()} onOp={onOp} />);
		fireEvent.click(screen.getByRole('button', { name: 'Ungroup' }));
		expect(lastOp(onOp, 'ungroup')).toEqual({ op: 'ungroup', id: 'grp1' });
		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		expect(lastOp(onOp, 'remove')).toEqual({ op: 'remove', id: 'grp1' });
	});
});

describe('Inspector detail tabs (Fields / Data roving)', () => {
	const flowWidget = {
		id: 'w1',
		type: 'clock' as const,
		rect: { x: 0, y: 0, w: 160, h: 40 },
		config: {}
	};

	it('switches Fields ↔ Data with the arrow keys (WAI-ARIA roving tabs)', () => {
		const node = leaf(flowWidget);
		render(<Inspector widget={flowWidget} placement="floating" node={node} onOp={vi.fn()} />);
		const tablist = screen.getByRole('tablist');
		const fieldsTab = within(tablist).getByRole('tab', { name: 'Fields' });
		const dataTab = within(tablist).getByRole('tab', { name: 'Data' });
		expect(fieldsTab.getAttribute('aria-selected')).toBe('true');

		fireEvent.keyDown(tablist, { key: 'ArrowRight' });
		expect(dataTab.getAttribute('aria-selected')).toBe('true');
		expect(screen.getByLabelText('Node JSON')).toBeTruthy(); // the Data panel is now shown

		fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
		expect(fieldsTab.getAttribute('aria-selected')).toBe('true');
	});
});

describe('Inspector per-widget token overrides', () => {
	const flowWidget = {
		id: 'w1',
		type: 'clock' as const,
		rect: { x: 0, y: 0, w: 160, h: 40 },
		config: {}
	};

	it('opens the override group pre-expanded with a count and clears all overrides', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(
			<Inspector
				widget={{ ...flowWidget, tokens: { '--np-fg': 'red' } }}
				placement="floating"
				onOp={onOp}
			/>
		);
		// The summary reflects the override count (the section is keyed open when overrides exist).
		expect(screen.getByText(/Override theme for this widget · 1 set/)).toBeTruthy();
		// TokenFields' clear button is labelled by its text ("Clear 1 override"), not its title.
		fireEvent.click(screen.getByRole('button', { name: 'Clear 1 override' }));
		expect(lastOp(onOp, 'clearWidgetTokens')).toEqual({ op: 'clearWidgetTokens', id: 'w1' });
	});
});

describe('Inspector headers: friendly labels, ids only in the tooltip / developer mode', () => {
	const gauge = {
		id: 'gauge-7',
		type: 'gauge',
		rect: { x: 0, y: 0, w: 1, h: 1 },
		config: {}
	};

	afterEach(() => localStorage.removeItem('widgetsack.overlay.prefs'));

	it('shows the widget type label (not the raw type/id); the id lives in the title', () => {
		render(<Inspector widget={gauge} placement="floating" onOp={vi.fn()} />);
		const hd = within(panel()).getByText('Gauge', { selector: '.node-hd' });
		expect(hd.textContent).toBe('Gauge');
		expect(hd.getAttribute('title')).toBe('Gauge (gauge) · gauge-7');
	});

	it('falls back to the raw type for an unregistered widget type', () => {
		render(
			<Inspector widget={{ ...gauge, type: 'mystery' }} placement="floating" onOp={vi.fn()} />
		);
		expect(within(panel()).getByText('mystery', { selector: '.node-hd' })).toBeTruthy();
	});

	it('appends the instance id when developer mode is on (read defensively from the prefs)', () => {
		localStorage.setItem('widgetsack.overlay.prefs', JSON.stringify({ developerMode: true }));
		const { unmount } = render(<Inspector widget={gauge} placement="floating" onOp={vi.fn()} />);
		expect(within(panel()).getByText('Gauge · gauge-7', { selector: '.node-hd' })).toBeTruthy();
		unmount();
		render(<Inspector container={container('c1', 'row', [])} onOp={vi.fn()} />);
		expect(within(panel()).getByText('Row container · c1', { selector: '.node-hd' })).toBeTruthy();
	});

	it('names a group by its custom widget when the group itself has no name', () => {
		const child = leaf({ ...gauge, id: 'g-child' });
		const g = group('g1', { w: 1, h: 1 }, child, { def: 'd1' });
		const def: WidgetDef = { id: 'd1', name: 'Def Name', size: { w: 1, h: 1 }, child };
		localStorage.setItem('widgetsack.overlay.prefs', JSON.stringify({ developerMode: true }));
		render(<Inspector groupUnit={g} def={def} onOp={vi.fn()} />);
		const hd = screen.getByText('Def Name · g1', { selector: '.node-hd' });
		expect(hd.getAttribute('title')).toBe('Custom widget · Def Name · g1');
	});
});

describe('Inspector container: properties first + "Add into this container"', () => {
	it('keeps the Add palette collapsed on selecting a container; the button opens it with the target', () => {
		const onSetAddTarget = vi.fn();
		const c = container('c1', 'row', []);
		render(<Inspector container={c} onOp={vi.fn()} onSetAddTarget={onSetAddTarget} />);
		const details = screen.getByText(/＋ Add widget/).closest('details') as HTMLDetailsElement;
		expect(details.open).toBe(false);
		// The container's own fields render (properties first) — e.g. gap — before any palette.
		expect(within(panel()).getByRole('spinbutton', { name: 'gap' })).toBeTruthy();
		fireEvent.click(within(panel()).getByRole('button', { name: '＋ Add into this container' }));
		expect(onSetAddTarget).toHaveBeenCalledWith('c1');
		expect(details.open).toBe(true);
	});

	it('shows an "Adding into" chip in the palette header for a sticky add target, with a ✕ to clear', () => {
		const onClearAddTarget = vi.fn();
		render(
			<Inspector
				onOp={vi.fn()}
				addTarget="c1"
				addTargetLabel="Row container"
				onClearAddTarget={onClearAddTarget}
			/>
		);
		expect(screen.getByText('＋ Add widget · into Row container')).toBeTruthy();
		expect(screen.getByText(/Adding into: Row container/)).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Clear add target' }));
		expect(onClearAddTarget).toHaveBeenCalled();
	});

	it('names the add target by id when no label is supplied', () => {
		render(<Inspector onOp={vi.fn()} addTarget="c9" />);
		expect(screen.getByText('＋ Add widget · into c9')).toBeTruthy();
	});

	it('names the SELECTED container over the sticky add target (mirrors currentContainer)', () => {
		// A template insert with nothing selected used to leave the root as the sticky target; with a
		// nested row then selected, the add actually lands in that row — the label must say so.
		render(
			<Inspector
				container={container('r1', 'row', [])}
				addTarget="root"
				addTargetLabel="the layout"
				onOp={vi.fn()}
			/>
		);
		expect(screen.getByText('＋ Add widget · into this row')).toBeTruthy();
	});
});
