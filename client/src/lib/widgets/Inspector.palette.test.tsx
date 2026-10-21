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

it('remembers preview view across catalog tabs and keeps the choice usable without storage', () => {
	const onOp = vi.fn();
	const def: WidgetDef = {
		id: 'my-clock',
		name: 'My Clock',
		size: { w: 100, h: 40 },
		child: {
			id: 'clock',
			unit: { id: 'clock', type: 'clock', rect: { x: 0, y: 0, w: 100, h: 40 }, config: {} }
		}
	};
	const view = render(
		<Inspector workspace pane="add" widgetTypes={widgetTypes} defs={[def]} onOp={onOp} />
	);
	fireEvent.click(screen.getByRole('button', { name: 'Previews' }));
	expect(localStorage.getItem('widgetsack.palette.view')).toBe('tiles');
	expect(view.container.querySelectorAll('.catalog-preview').length).toBeGreaterThan(0);
	fireEvent.click(screen.getByRole('tab', { name: 'Templates' }));
	expect(view.container.querySelector('.template-options-card .catalog-preview')).toBeTruthy();
	fireEvent.click(screen.getByRole('tab', { name: 'My widgets' }));
	expect(screen.getByRole('button', { name: 'My Clock' })).toBeVisible();
	fireEvent.click(screen.getByRole('tab', { name: 'Widgets' }));
	fireEvent.change(screen.getByLabelText('Filter the add palette'), {
		target: { value: 'My Clock' }
	});
	expect(screen.getByRole('button', { name: 'My Clock' })).toBeVisible();
	fireEvent.click(screen.getByRole('button', { name: 'List' }));
	expect(localStorage.getItem('widgetsack.palette.view')).toBe('rows');
	view.unmount();
	const get = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
		throw new Error('unavailable');
	});
	const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
		throw new Error('unavailable');
	});
	try {
		render(<Inspector workspace pane="add" onOp={onOp} />);
		fireEvent.click(screen.getByRole('button', { name: 'Previews' }));
		expect(screen.getByRole('button', { name: 'Previews' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
	} finally {
		get.mockRestore();
		set.mockRestore();
		localStorage.clear();
	}
});

describe('Inspector add-palette — widget types', () => {
	it('groups widget types by category and emits addWidget on click', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widgetTypes={widgetTypes} onOp={onOp} />);
		// Category headers + the entries under them.
		expect(
			within(palette()).getByText(/^Meters/, { selector: '.palette-section-name' })
		).toBeTruthy();
		expect(
			within(palette()).getByText(/^Clocks/, { selector: '.palette-section-name' })
		).toBeTruthy();
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
		expect(screen.getByText('＋ Add widget · into this column')).toBeTruthy();
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
		// "Now playing" is a built-in template with no params → a plain insert button.
		fireEvent.click(within(palette()).getByRole('button', { name: /^Now playing/ }));
		expect(onOp).toHaveBeenCalledWith({ op: 'insertTemplate', templateId: 'nowplaying' });
	});

	it('renders a param template as an options form and passes the chosen options on insert', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector onOp={onOp} />);
		expect(screen.queryByRole('dialog')).toBeNull();
		fireEvent.click(within(palette()).getByRole('button', { name: 'Set up Clock (JP weekday)' }));
		// "Clock (JP weekday)" (clock-jp) carries ParamSpecs → an options form with selects + Insert.
		const weekday = screen.getByLabelText('Clock (JP weekday) — Weekday');
		fireEvent.click(weekday);
		fireEvent.click(screen.getByText('English', { selector: '.np-select-opt-label' }));
		const insert = within(screen.getByRole('dialog')).getByRole('button', {
			name: 'Add to layout'
		});
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
			within(palette()).getByLabelText('Preview System monitor in the widget builder')
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
		expect(
			within(palette()).getByText(/^My widgets/, { selector: '.palette-section-name' })
		).toBeTruthy();
		fireEvent.click(within(palette()).getByRole('button', { name: 'My Widget' }));
		expect(onOp).toHaveBeenCalledWith({ op: 'insertWidget', defId: 'd1' });
	});

	it('hides defs that would make the designed definition contain itself', () => {
		const wrapper: WidgetDef = {
			...def('wrap', 'Wrapper'),
			child: {
				id: 'g',
				unit: {
					id: 'g',
					kind: 'group',
					def: 'self',
					size: { w: 1, h: 1 },
					child: def('x', 'x').child
				}
			}
		};
		render(
			<Inspector
				defs={[def('self', 'Designed'), wrapper, def('d1', 'My Widget')]}
				editingDefId="self"
				onOp={vi.fn()}
			/>
		);
		const items = within(palette())
			.getAllByRole('button')
			.map((b) => b.getAttribute('aria-label'));
		expect(items).toContain('My Widget');
		expect(items).not.toContain('Designed');
		expect(items).not.toContain('Wrapper');
	});

	it('routes the ✕ delete through onDeleteDef when provided', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const onDeleteDef = vi.fn<(id: string, name: string) => void>();
		render(<Inspector defs={[def('d1', 'My Widget')]} onOp={onOp} onDeleteDef={onDeleteDef} />);
		fireEvent.click(within(palette()).getByLabelText('Delete My Widget from My widgets'));
		expect(onDeleteDef).toHaveBeenCalledWith('d1', 'My Widget');
		// With a handler supplied, the plain deleteDef op is NOT emitted.
		expect(onOp.mock.calls.some((c) => c[0].op === 'deleteDef')).toBe(false);
	});

	it('falls back to a deleteDef op when no onDeleteDef handler is given (overlay)', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector defs={[def('d1', 'My Widget')]} onOp={onOp} />);
		fireEvent.click(within(palette()).getByLabelText('Delete My Widget from My widgets'));
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

it('accepts a command when inserting the CLI template', () => {
	const onOp = vi.fn();
	render(<Inspector onOp={onOp} />);
	fireEvent.click(screen.getByRole('button', { name: 'Set up CLI Command' }));
	fireEvent.change(screen.getByRole('textbox', { name: 'CLI Command — PowerShell command' }), {
		target: { value: 'Get-Date' }
	});
	const card = screen
		.getByText('Set up CLI Command', { selector: '.tpl-opts-name' })
		.closest('.tpl-opts') as HTMLElement;
	fireEvent.click(within(card).getByRole('button', { name: 'Add to layout' }));
	expect(onOp).toHaveBeenCalledWith({
		op: 'insertTemplate',
		templateId: 'cli-command',
		options: { command: 'Get-Date' }
	});
});

it('cancels template setup without inserting, retains the draft, and returns focus to its card', () => {
	const onOp = vi.fn();
	render(<Inspector onOp={onOp} />);
	const trigger = screen.getByRole('button', { name: 'Set up CLI Command' });
	fireEvent.click(trigger);
	const input = screen.getByLabelText('CLI Command — PowerShell command');
	expect(input).toHaveFocus();
	fireEvent.change(input, { target: { value: 'Get-Date' } });
	fireEvent.keyDown(input, { key: 'Tab' });
	fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
	expect(screen.queryByRole('dialog')).toBeNull();
	expect(trigger).toHaveFocus();
	fireEvent.click(trigger);
	expect(screen.getByLabelText('CLI Command — PowerShell command')).toHaveValue('Get-Date');
	const handledEscape = new KeyboardEvent('keydown', {
		key: 'Escape',
		bubbles: true,
		cancelable: true
	});
	handledEscape.preventDefault();
	fireEvent(screen.getByRole('dialog'), handledEscape);
	expect(screen.getByRole('dialog')).toBeVisible();
	fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
	expect(screen.queryByRole('dialog')).toBeNull();
	expect(trigger).toHaveFocus();
	expect(onOp).not.toHaveBeenCalled();
});
