import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import Inspector from './Inspector';
import type { WidgetDef } from '../core/layoutTree';
import type { LayoutOp } from './ops';

// WidgetPreview (rendered into the hover popover) seeds a telemetry hub + renders real meters; the
// palette tests only assert on the palette list + emitted ops, never the popover, so we stub it to a
// cheap div to keep these tests fast and free of meter-render churn.
vi.mock('./WidgetPreview', () => ({ default: () => null }));

const palette = () =>
	screen.getByText('＋ Add widget · floating').closest('details') as HTMLElement;

const widgetTypes = [
	{ type: 'gauge', label: 'Gauge', category: 'Meters' },
	{ type: 'clock', label: 'Clock', category: 'Clocks' }
];

describe('Inspector add-palette — widget types', () => {
	it('groups widget types by category and emits addWidget on click', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widgetTypes={widgetTypes} onOp={onOp} />);
		// Category headers + the entries under them.
		expect(within(palette()).getByText('Meters', { selector: '.hd2' })).toBeTruthy();
		expect(within(palette()).getByText('Clocks', { selector: '.hd2' })).toBeTruthy();
		fireEvent.click(within(palette()).getByRole('button', { name: /^Gauge/ }));
		expect(onOp).toHaveBeenCalledWith({ op: 'addWidget', widgetType: 'gauge' });
	});

	it('names its destination "into <container.kind>" when a container is selected', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(
			<Inspector
				widgetTypes={widgetTypes}
				container={{ id: 'root', kind: 'col', children: [] }}
				onOp={onOp}
			/>
		);
		expect(screen.getByText('＋ Add widget · into col')).toBeTruthy();
	});

	it('puts the widget type on the dataTransfer when dragged from the palette', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widgetTypes={widgetTypes} onOp={onOp} />);
		const setData = vi.fn();
		fireEvent.dragStart(within(palette()).getByRole('button', { name: /^Gauge/ }), {
			dataTransfer: { setData }
		});
		expect(setData).toHaveBeenCalledWith('text/x-widget-type', 'gauge');
	});
});

describe('Inspector add-palette — templates', () => {
	it('inserts a no-param built-in template via insertTemplate', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector onOp={onOp} />);
		// "System monitor" is a built-in template with no params → a plain insert button.
		fireEvent.click(within(palette()).getByRole('button', { name: /^System monitor/ }));
		expect(onOp).toHaveBeenCalledWith({ op: 'insertTemplate', templateId: 'system' });
	});

	it('renders a param template as an options form and passes the chosen options on insert', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector onOp={onOp} />);
		// "Clock (JP weekday)" (clock-jp) carries ParamSpecs → an options form with selects + Insert.
		const weekday = within(palette()).getByLabelText('Clock (JP weekday) — Weekday');
		fireEvent.click(weekday);
		fireEvent.click(screen.getByText('English', { selector: '.np-select-opt-label' }));
		const insert = within(palette())
			.getAllByText('＋ Insert')
			.find((b) => b.getAttribute('title')?.includes('Analog icon'))!;
		fireEvent.click(insert);
		const call = onOp.mock.calls.map((c) => c[0]).find((o) => o.op === 'insertTemplate');
		expect(call && call.op === 'insertTemplate' && call.templateId).toBe('clock-jp');
		expect(call && call.op === 'insertTemplate' && call.options?.weekdayLang).toBe('en');
	});

	it('shows a 👁 preview affordance per template and routes it to onPreviewTemplate', () => {
		const onPreviewTemplate = vi.fn<(id: string) => void>();
		render(<Inspector onOp={vi.fn()} onPreviewTemplate={onPreviewTemplate} />);
		// The 👁 button next to "System monitor" jumps to the designer's read-only preview.
		fireEvent.click(
			within(palette()).getByLabelText('Preview System monitor in the widget designer')
		);
		expect(onPreviewTemplate).toHaveBeenCalledWith('system');
	});
});

describe('Inspector add-palette — library defs', () => {
	const def = (id: string, name: string): WidgetDef => ({
		id,
		name,
		size: { w: 100, h: 40 },
		child: {
			id: `${id}-c`,
			unit: { id: `${id}-w`, type: 'clock', rect: { x: 0, y: 0, w: 1, h: 1 }, config: {} }
		}
	});

	it('lists library defs and inserts an instance on click', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector defs={[def('d1', 'My Widget')]} onOp={onOp} />);
		expect(within(palette()).getByText('Library', { selector: '.hd' })).toBeTruthy();
		fireEvent.click(within(palette()).getByRole('button', { name: 'My Widget' }));
		expect(onOp).toHaveBeenCalledWith({ op: 'insertWidget', defId: 'd1' });
	});

	it('routes the ✕ delete through onDeleteDef when provided', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const onDeleteDef = vi.fn<(id: string, name: string) => void>();
		render(<Inspector defs={[def('d1', 'My Widget')]} onOp={onOp} onDeleteDef={onDeleteDef} />);
		fireEvent.click(within(palette()).getByLabelText('Delete My Widget from library'));
		expect(onDeleteDef).toHaveBeenCalledWith('d1', 'My Widget');
		// With a handler supplied, the plain deleteDef op is NOT emitted.
		expect(onOp.mock.calls.some((c) => c[0].op === 'deleteDef')).toBe(false);
	});

	it('falls back to a deleteDef op when no onDeleteDef handler is given (overlay)', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector defs={[def('d1', 'My Widget')]} onOp={onOp} />);
		fireEvent.click(within(palette()).getByLabelText('Delete My Widget from library'));
		expect(onOp).toHaveBeenCalledWith({ op: 'deleteDef', defId: 'd1' });
	});
});

describe('Inspector add-palette — filter', () => {
	it('narrows widgets, templates and library to the query, then shows an empty state', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widgetTypes={widgetTypes} onOp={onOp} />);
		const filter = screen.getByLabelText('Filter the add palette');
		fireEvent.change(filter, { target: { value: 'gauge' } });
		// The Gauge widget survives; the Clock widget + every (non-matching) template is filtered out.
		expect(within(palette()).getByRole('button', { name: /^Gauge/ })).toBeTruthy();
		expect(within(palette()).queryByRole('button', { name: /^Clock$/ })).toBeNull();
		expect(within(palette()).queryByRole('button', { name: /^System monitor/ })).toBeNull();

		fireEvent.change(filter, { target: { value: 'zzz-no-such-widget' } });
		expect(within(palette()).getByText(/No matches for/)).toBeTruthy();
	});
});
