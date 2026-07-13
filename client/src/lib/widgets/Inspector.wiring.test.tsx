import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import Inspector from './Inspector';
import {
	container,
	group,
	leaf,
	type Group,
	type WidgetDef,
	type WidgetInstance
} from '../core/layoutTree';
import type { ConfigField } from '../core/widget';
import type { LayoutOp } from './ops';
import { registerTemplates, unregisterTemplates } from '../core/templates';

// The hover popover renders real meters; every wiring test asserts on the popover's text, never a
// live render, so stub it to a cheap div.
vi.mock('./WidgetPreview', () => ({ default: () => null }));

// CodeMirror is lazy-loaded (Suspense) and never resolves under happy-dom, so the real CssEditor
// renders only its loading placeholder and its onBlur never fires. Swap it for a plain textarea whose
// blur forwards the current text — that's the exact contract the Inspector's css setters consume.
vi.mock('./CssEditor', () => ({
	default: (props: {
		value?: string;
		ariaLabel?: string;
		placeholder?: string;
		onBlur: (value: string) => void;
	}) => (
		<textarea
			aria-label={props.ariaLabel}
			placeholder={props.placeholder}
			defaultValue={props.value ?? ''}
			onBlur={(e) => props.onBlur(e.currentTarget.value)}
		/>
	)
}));

// The monitor-sources field's effect calls the Tauri-backed DDC adapter; stub it to "no inputs".
vi.mock('../ddc/monitors', () => ({
	listMonitorInputs: vi.fn().mockResolvedValue([]),
	setMonitorInput: vi.fn().mockResolvedValue(true)
}));

const originalConsoleError = console.error;
let inspectorErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	// The Inspector wiring matrix mounts/unmounts the async monitor probe and external template
	// registry dozens of times. Vitest can report their already-cancelled completion against the next
	// test. Filter only that known act diagnostic; application errors remain visible.
	inspectorErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		const text = args.map(String).join(' ');
		if (text.includes('not wrapped in act') && text.includes('Inspector')) return;
		originalConsoleError(...args);
	});
});
afterEach(() => inspectorErrorSpy.mockRestore());

const w = (over: Partial<WidgetInstance> = {}): WidgetInstance => ({
	id: 'w1',
	type: 'clock',
	rect: { x: 0, y: 0, w: 160, h: 40 },
	config: {},
	...over
});
const gaugeWidget = (config: Record<string, unknown> = {}): WidgetInstance => ({
	id: 'w1',
	type: 'gauge',
	rect: { x: 0, y: 0, w: 110, h: 110 },
	config
});

const panel = (): HTMLElement => screen.getByRole('tabpanel');
const palette = (): HTMLElement =>
	screen.getByText(/＋ Add widget/).closest('details') as HTMLElement;
const lastOp = (onOp: ReturnType<typeof vi.fn>, op: string): LayoutOp | undefined =>
	onOp.mock.calls
		.map((c) => c[0] as LayoutOp)
		.reverse()
		.find((o) => o.op === op);
const configPatch = (onOp: ReturnType<typeof vi.fn>): Record<string, unknown> | undefined => {
	const p = lastOp(onOp, 'patchWidget');
	return p && p.op === 'patchWidget' ? (p.patch.config as Record<string, unknown>) : undefined;
};

// ---------------------------------------------------------------------------------------------------
describe('Inspector manual-save dirty tracking (computeDirty)', () => {
	it('flags a widget field that differs from its saved baseline, and leaves matching ones clean', () => {
		const widget = w({
			sensor: 'cpu.total',
			rect: { x: 1, y: 2, w: 3, h: 4 },
			config: { a: 1 },
			css: 'x'
		});
		// The baseline differs in sensor / rect.x / config / css; y·w·h match.
		const base = w({ sensor: undefined, rect: { x: 9, y: 2, w: 3, h: 4 }, config: { b: 2 } });
		render(
			<Inspector
				widget={widget}
				baseWidget={base}
				baseTokens={{ '--np-fg': 'blue', '--np-bg': 'x', '--np-label': 'same' }}
				tokens={{ '--np-fg': 'red', '--np-accent': 'z', '--np-label': 'same' }}
				placement="floating"
				node={leaf(widget)}
				onOp={vi.fn()}
			/>
		);
		expect(within(panel()).getByText('sensor').closest('label')!.className).toContain('dirty');
		// y matched the baseline → not flagged.
		expect(within(panel()).getByText('y').closest('label')!.className).not.toContain('dirty');
	});

	it('does not flag any widget field when the baseline is identical', () => {
		const widget = w({ sensor: 'cpu.total', config: { a: 1 } });
		render(
			<Inspector
				widget={widget}
				baseWidget={w({ sensor: 'cpu.total', config: { a: 1 } })}
				placement="floating"
				node={leaf(widget)}
				onOp={vi.fn()}
			/>
		);
		expect(within(panel()).getByText('sensor').closest('label')!.className).not.toContain('dirty');
	});

	it('treats every field of a brand-new node as dirty (nodeIsNew ignores the baseline)', () => {
		const widget = w({ sensor: 'cpu.total' });
		render(
			<Inspector
				widget={widget}
				baseWidget={w({ sensor: 'cpu.total' })}
				nodeIsNew
				placement="floating"
				node={leaf(widget)}
				onOp={vi.fn()}
			/>
		);
		// Same values as the baseline, but a new node reads everything as changed.
		expect(within(panel()).getByText('sensor').closest('label')!.className).toContain('dirty');
	});

	it('flags changed container fields against a baseline', () => {
		const c = container('root', 'col', [], {
			cols: 2,
			rows: 2,
			gap: 4,
			pad: 8,
			margin: 2,
			align: 'center',
			justify: 'center',
			basis: { fr: 1 },
			overlap: true,
			cellW: 10,
			cellH: 20,
			aspect: 1.5,
			condition: { kind: 'appOpen' }
		});
		const baseC = container('root', 'grid', [], {});
		render(<Inspector container={c} baseContainer={baseC} isGridCell onOp={vi.fn()} />);
		expect(within(panel()).getByText('kind').closest('label')!.className).toContain('dirty');
	});

	it('flags changed group name / css / params against a baseline', () => {
		const child = leaf(w({ id: 'c', type: 'clock' }));
		const g = group('g1', { w: 1, h: 1 }, child, { name: 'A', css: 'x', params: { p: 'PVAL' } });
		const base = group('g1', { w: 1, h: 1 }, child, { name: 'B', params: { q: '2' } });
		const def: WidgetDef = {
			id: 'd1',
			name: 'Def',
			size: { w: 1, h: 1 },
			child,
			params: [{ key: 'p', label: 'P', target: 'unit.config.p' }]
		};
		render(<Inspector groupUnit={g} baseGroup={base} def={def} placement="flow" onOp={vi.fn()} />);
		expect(screen.getByText('name').closest('label')!.className).toContain('dirty');
		// The param label's text is split across nodes ("P → unit.config.p"), so getByText('P') can't
		// find it — locate the label through its input's (distinct) display value instead.
		expect(screen.getByDisplayValue('PVAL').closest('label')!.className).toContain('dirty');
	});

	it('leaves group fields clean when they match the baseline exactly', () => {
		const child = leaf(w({ id: 'c', type: 'clock' }));
		const g = group('g1', { w: 9, h: 9 }, child, { name: 'Same', params: { p: 'PVAL' } });
		const base = group('g1', { w: 9, h: 9 }, child, { name: 'Same', params: { p: 'PVAL' } });
		const def: WidgetDef = {
			id: 'd1',
			name: 'Def',
			size: { w: 9, h: 9 },
			child,
			params: [{ key: 'p', label: 'P', target: 'unit.config.p' }]
		};
		render(<Inspector groupUnit={g} baseGroup={base} def={def} placement="flow" onOp={vi.fn()} />);
		expect(screen.getByText('name').closest('label')!.className).not.toContain('dirty');
		expect(screen.getByDisplayValue('PVAL').closest('label')!.className).not.toContain('dirty');
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector add-palette hover preview (debounced popover)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const gaugeType = [{ type: 'gauge', label: 'Gauge', category: 'Meters' }];
	const libDef: WidgetDef = {
		id: 'd1',
		name: 'My Widget',
		size: { w: 100, h: 40 },
		child: leaf(w({ id: 'd1-w', type: 'clock' }))
	};

	it('opens a preview after the debounce and closes it on mouse-leave', () => {
		render(<Inspector widgetTypes={gaugeType} onOp={vi.fn()} />);
		const gauge = within(palette()).getByRole('button', { name: /^Gauge/ });
		fireEvent.mouseEnter(gauge);
		// Debounced — nothing yet.
		expect(document.querySelector('.palette-preview')).toBeNull();
		act(() => vi.advanceTimersByTime(300));
		expect(screen.getByText('Gauge', { selector: '.pp-name' })).toBeTruthy();
		expect(document.querySelector('.pp-desc')).toBeTruthy(); // gauge meta has a description
		expect(screen.getByText('Click to add · drag to place', { selector: '.pp-hint' })).toBeTruthy();
		fireEvent.mouseLeave(gauge);
		expect(document.querySelector('.palette-preview')).toBeNull();
	});

	it('names the destination container in the hint when one is selected', () => {
		render(
			<Inspector widgetTypes={gaugeType} container={container('root', 'col', [])} onOp={vi.fn()} />
		);
		fireEvent.mouseEnter(within(palette()).getByRole('button', { name: /^Gauge/ }));
		act(() => vi.advanceTimersByTime(300));
		expect(screen.getByText(/Click to add into the col/, { selector: '.pp-hint' })).toBeTruthy();
	});

	it('previews a library def with no description (hint only)', () => {
		render(<Inspector defs={[libDef]} onOp={vi.fn()} />);
		fireEvent.mouseEnter(within(palette()).getByRole('button', { name: 'My Widget' }));
		act(() => vi.advanceTimersByTime(300));
		expect(screen.getByText('My Widget', { selector: '.pp-name' })).toBeTruthy();
		expect(document.querySelector('.pp-desc')).toBeNull(); // a def carries no description
	});

	it('previews a template on hover', () => {
		render(<Inspector onOp={vi.fn()} />);
		fireEvent.mouseEnter(within(palette()).getByRole('button', { name: /^System monitor/ }));
		act(() => vi.advanceTimersByTime(300));
		expect(screen.getByText('System monitor', { selector: '.pp-name' })).toBeTruthy();
	});

	it('cancels a pending preview when the pointer moves to another entry', () => {
		render(
			<Inspector
				widgetTypes={[
					{ type: 'gauge', label: 'Gauge', category: 'Meters' },
					{ type: 'clock', label: 'Clock', category: 'Clocks' }
				]}
				onOp={vi.fn()}
			/>
		);
		fireEvent.mouseEnter(within(palette()).getByRole('button', { name: /^Gauge/ }));
		// Re-hover before the first debounce elapses → the first timer is cleared.
		fireEvent.mouseEnter(within(palette()).getByRole('button', { name: /^Clock/ }));
		act(() => vi.advanceTimersByTime(300));
		expect(screen.getByText('Clock', { selector: '.pp-name' })).toBeTruthy();
		expect(screen.queryByText('Gauge', { selector: '.pp-name' })).toBeNull();
	});

	it('clears a pending preview timer on unmount without firing', () => {
		const { unmount } = render(<Inspector widgetTypes={gaugeType} onOp={vi.fn()} />);
		fireEvent.mouseEnter(within(palette()).getByRole('button', { name: /^Gauge/ }));
		unmount();
		// The cleanup cancelled the timer — advancing must not throw or resurrect a popover.
		act(() => vi.advanceTimersByTime(300));
		expect(document.querySelector('.palette-preview')).toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector add-palette open state', () => {
	it('collapses when a node is selected and re-opens when the selection clears', () => {
		const { rerender } = render(<Inspector onOp={vi.fn()} />);
		const details = palette() as HTMLDetailsElement;
		expect(details.open).toBe(true); // nothing selected → the primary add affordance is open
		rerender(<Inspector widget={w()} placement="floating" onOp={vi.fn()} />);
		expect((palette() as HTMLDetailsElement).open).toBe(false); // selecting collapses it
		rerender(<Inspector onOp={vi.fn()} />);
		expect((palette() as HTMLDetailsElement).open).toBe(true); // clearing re-opens it
	});

	it('keeps its open state in sync when the user toggles the panel', () => {
		render(<Inspector onOp={vi.fn()} />);
		const details = palette() as HTMLDetailsElement;
		details.open = false;
		fireEvent(details, new Event('toggle'));
		expect(screen.getByText(/＋ Add widget/)).toBeTruthy(); // still rendered, no crash
	});

	it('shows a plugin template group under its own heading', () => {
		registerTemplates('MyPlugin', [
			{
				id: 'plug-1',
				name: 'Plugin Widget',
				description: 'from a plugin',
				size: { w: 10, h: 10 },
				tree: () => leaf(w({ id: 'p', type: 'text' }))
			}
		]);
		let unmount: () => void = () => undefined;
		try {
			unmount = render(<Inspector onOp={vi.fn()} />).unmount;
			expect(within(palette()).getByText('Templates · MyPlugin', { selector: '.hd' })).toBeTruthy();
			expect(within(palette()).getByRole('button', { name: /^Plugin Widget/ })).toBeTruthy();
		} finally {
			unmount();
			unregisterTemplates('MyPlugin');
		}
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector widget actions + rect + sensor', () => {
	it('emits dock / make widget / reset / remove from a floating widget', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widget={w()} placement="floating" onOp={onOp} />);
		fireEvent.click(within(panel()).getByRole('button', { name: 'Dock →flow' }));
		expect(lastOp(onOp, 'dock')).toEqual({ op: 'dock', id: 'w1' });
		fireEvent.click(within(panel()).getByRole('button', { name: 'Make widget' }));
		expect(lastOp(onOp, 'makeWidget')).toEqual({ op: 'makeWidget', id: 'w1' });
		fireEvent.click(within(panel()).getByRole('button', { name: 'Reset' }));
		expect(lastOp(onOp, 'resetWidget')).toEqual({ op: 'resetWidget', id: 'w1' });
		fireEvent.click(within(panel()).getByRole('button', { name: 'Remove' }));
		expect(lastOp(onOp, 'remove')).toEqual({ op: 'remove', id: 'w1' });
	});

	it('emits float from a flow widget', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widget={w()} placement="flow" onOp={onOp} />);
		fireEvent.click(within(panel()).getByRole('button', { name: 'Float' }));
		expect(lastOp(onOp, 'float')).toEqual({ op: 'float', id: 'w1' });
	});

	it('edits the floating rect via updateRect', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widget={w()} placement="floating" onOp={onOp} />);
		fireEvent.input(within(panel()).getByRole('spinbutton', { name: 'x' }), {
			target: { value: '50' }
		});
		expect(lastOp(onOp, 'patchWidget')).toMatchObject({ patch: { rect: { x: 50 } } });
	});

	it('edits the flow fixed w/h via updateRect', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widget={w()} placement="flow" onOp={onOp} />);
		fireEvent.input(within(panel()).getByRole('spinbutton', { name: 'w (fixed)' }), {
			target: { value: '80' }
		});
		expect(lastOp(onOp, 'patchWidget')).toMatchObject({ patch: { rect: { w: 80 } } });
	});

	it('sets and clears the sensor through the typeahead', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widget={w()} placement="floating" sensors={['gpu.util']} onOp={onOp} />);
		const input = screen.getByRole('combobox', { name: 'sensor' });
		fireEvent.change(input, { target: { value: 'gpu.util' } });
		expect(lastOp(onOp, 'patchWidget')).toMatchObject({ patch: { sensor: 'gpu.util' } });
		fireEvent.change(input, { target: { value: '' } });
		expect(lastOp(onOp, 'patchWidget')).toMatchObject({ patch: { sensor: undefined } });
	});

	it('labels a sensor option by name only when it carries no unit', () => {
		render(
			<Inspector
				widget={w()}
				placement="floating"
				sensors={['ha.x']}
				sensorMeta={{ 'ha.x': { label: 'Kitchen' } }}
				onOp={vi.fn()}
			/>
		);
		fireEvent.click(screen.getByRole('combobox', { name: 'sensor' }));
		expect(screen.getByText('Kitchen', { selector: '.np-select-opt-label' })).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector per-leaf placement controls (flow widget)', () => {
	it('sets horizontal and vertical alignment via setLeafAlign', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widget={w()} placement="flow" widgetValign="top" onOp={onOp} />);
		fireEvent.click(within(panel()).getByLabelText('horizontal align'));
		fireEvent.click(screen.getByText('center', { selector: '.np-select-opt-label' }));
		expect(lastOp(onOp, 'setLeafAlign')).toEqual({
			op: 'setLeafAlign',
			id: 'w1',
			halign: 'center',
			valign: 'top'
		});
	});

	it('sets vertical alignment keeping the current horizontal placement', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widget={w()} placement="flow" widgetHalign="right" onOp={onOp} />);
		fireEvent.click(within(panel()).getByLabelText('vertical align'));
		fireEvent.click(screen.getByText('middle', { selector: '.np-select-opt-label' }));
		expect(lastOp(onOp, 'setLeafAlign')).toEqual({
			op: 'setLeafAlign',
			id: 'w1',
			halign: 'right',
			valign: 'middle'
		});
	});

	it('edits the leaf margin and pad boxes via setLeafBox', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const widget = w();
		render(<Inspector widget={widget} placement="flow" node={leaf(widget)} onOp={onOp} />);
		fireEvent.input(within(panel()).getByLabelText('margin all sides'), { target: { value: '8' } });
		expect(lastOp(onOp, 'setLeafBox')).toEqual({
			op: 'setLeafBox',
			id: 'w1',
			field: 'margin',
			value: 8
		});
		fireEvent.input(within(panel()).getByLabelText('pad all sides'), { target: { value: '4' } });
		expect(lastOp(onOp, 'setLeafBox')).toEqual({
			op: 'setLeafBox',
			id: 'w1',
			field: 'pad',
			value: 4
		});
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector group flow sizing (leafSizingControls)', () => {
	const grp = (): Group =>
		group('g1', { w: 100, h: 40 }, leaf(w({ id: 'c', type: 'clock' })), { name: 'G' });

	// NB: the group branch renders a plain `.fields` div (no role="tabpanel" — only the container and
	// widget branches carry one), so these query at screen level.
	it('shows "grow" for an fr basis and emits a content basis for "hug"', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const g = grp();
		render(
			<Inspector
				groupUnit={g}
				placement="flow"
				widgetBasis={{ fr: 1 }}
				node={leaf(g)}
				onOp={onOp}
			/>
		);
		const trigger = screen.getByLabelText('size in parent');
		expect(trigger).toHaveTextContent(/fill/i);
		fireEvent.click(trigger);
		fireEvent.click(screen.getByText('hug — fit content', { selector: '.np-select-opt-label' }));
		expect(lastOp(onOp, 'setBasis')).toEqual({ op: 'setBasis', id: 'g1', basis: 'content' });
	});

	it('emits an fr basis for "fill" from a fit start', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const g = grp();
		render(<Inspector groupUnit={g} placement="flow" node={leaf(g)} onOp={onOp} />);
		const trigger = screen.getByLabelText('size in parent');
		expect(trigger).toHaveTextContent(/hug/i); // no basis → fit
		fireEvent.click(trigger);
		fireEvent.click(screen.getByText('fill — grow to share', { selector: '.np-select-opt-label' }));
		expect(lastOp(onOp, 'setBasis')).toEqual({ op: 'setBasis', id: 'g1', basis: { fr: 1 } });
	});

	it('emits a 100px basis for "fixed" and edits the px input when the basis is numeric', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const g = grp();
		// Start from grow so picking "fixed" is an actual change.
		const { rerender } = render(
			<Inspector
				groupUnit={g}
				placement="flow"
				widgetBasis={{ fr: 1 }}
				node={leaf(g)}
				onOp={onOp}
			/>
		);
		fireEvent.click(screen.getByLabelText('size in parent'));
		fireEvent.click(screen.getByText('fixed (px)', { selector: '.np-select-opt-label' }));
		expect(lastOp(onOp, 'setBasis')).toEqual({ op: 'setBasis', id: 'g1', basis: 100 });

		// A numeric basis exposes the px input.
		rerender(
			<Inspector groupUnit={g} placement="flow" widgetBasis={120} node={leaf(g)} onOp={onOp} />
		);
		expect(screen.getByLabelText('size in parent')).toHaveTextContent(/fixed/i);
		fireEvent.input(screen.getByRole('spinbutton', { name: 'size (px)' }), {
			target: { value: '75' }
		});
		expect(lastOp(onOp, 'setBasis')).toEqual({ op: 'setBasis', id: 'g1', basis: 75 });
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector container wiring', () => {
	it('writes cross-axis align and main-axis justify via setAlignField', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(
			<Inspector container={container('root', 'col', [], { align: 'stretch' })} onOp={onOp} />
		);
		// A col: "Horizontal" writes align, "Vertical" writes justify.
		fireEvent.click(within(panel()).getByLabelText('Horizontal'));
		fireEvent.click(screen.getByText('left', { selector: '.np-select-opt-label' }));
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'root',
			patch: { align: 'start' }
		});
		fireEvent.click(within(panel()).getByLabelText('Vertical'));
		fireEvent.click(screen.getByText('middle', { selector: '.np-select-opt-label' }));
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'root',
			patch: { justify: 'center' }
		});
	});

	it('sets a fixed 100px container basis via setContainerSizing', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(
			<Inspector container={container('root', 'col', [], { basis: { fr: 1 } })} onOp={onOp} />
		);
		fireEvent.click(within(panel()).getByLabelText('container size in parent'));
		fireEvent.click(screen.getByText('fixed (px)', { selector: '.np-select-opt-label' }));
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'root',
			patch: { basis: 100 }
		});
	});

	it('coerces an emptied fixed-px basis input to 0', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector container={container('root', 'col', [], { basis: 120 })} onOp={onOp} />);
		fireEvent.input(within(panel()).getByRole('spinbutton', { name: 'size (px)' }), {
			target: { value: '' }
		});
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'root',
			patch: { basis: 0 }
		});
	});

	it('clears overlap back to undefined when unchecked', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector container={container('root', 'col', [], { overlap: true })} onOp={onOp} />);
		fireEvent.click(within(panel()).getByRole('checkbox', { name: /stack children/i }));
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'root',
			patch: { overlap: undefined }
		});
	});

	it('edits container rows and the container margin box', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector container={container('g', 'grid', [], { cols: 2, rows: 2 })} onOp={onOp} />);
		fireEvent.input(within(panel()).getByRole('spinbutton', { name: 'rows' }), {
			target: { value: '3' }
		});
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'g',
			patch: { rows: 3 }
		});
		fireEvent.input(within(panel()).getByLabelText('margin all sides'), { target: { value: '6' } });
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'g',
			patch: { margin: 6 }
		});
	});

	it('offers "Reset tracks (even)" once tracks have been dragged, emitting distributeEvenly', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(
			<Inspector
				container={container('g', 'grid', [], { cols: 2, rows: 2, colFr: [2, 1] })}
				onOp={onOp}
			/>
		);
		fireEvent.click(within(panel()).getByRole('button', { name: /Reset tracks/ }));
		expect(lastOp(onOp, 'distributeEvenly')).toEqual({ op: 'distributeEvenly', containerId: 'g' });
	});

	it('edits grid-cell height and aspect, and clears them when emptied', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(
			<Inspector
				container={container('cell', 'col', [], { cellW: 5, cellH: 40, aspect: 1.5 })}
				isGridCell
				onOp={onOp}
			/>
		);
		fireEvent.input(within(panel()).getByRole('spinbutton', { name: 'height (px)' }), {
			target: { value: '64' }
		});
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'cell',
			patch: { cellH: 64 }
		});
		fireEvent.input(within(panel()).getByRole('spinbutton', { name: /aspect/ }), {
			target: { value: '' }
		});
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'cell',
			patch: { aspect: undefined }
		});
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector CSS editors', () => {
	it('commits widget css on blur, mapping an empty value to undefined', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widget={w()} placement="floating" onOp={onOp} />);
		const css = screen.getByLabelText('widget css');
		fireEvent.change(css, { target: { value: 'color: red;' } });
		fireEvent.blur(css);
		expect(lastOp(onOp, 'patchWidget')).toEqual({
			op: 'patchWidget',
			id: 'w1',
			patch: { css: 'color: red;' }
		});
		fireEvent.change(css, { target: { value: '' } });
		fireEvent.blur(css);
		expect(lastOp(onOp, 'patchWidget')).toEqual({
			op: 'patchWidget',
			id: 'w1',
			patch: { css: undefined }
		});
	});

	it('commits group css and def css on blur', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const child = leaf(w({ id: 'c', type: 'clock' }));
		const g = group('g1', { w: 1, h: 1 }, child, { name: 'G', def: 'd1' });
		const def: WidgetDef = { id: 'd1', name: 'Def', size: { w: 1, h: 1 }, child };
		render(<Inspector groupUnit={g} def={def} placement="flow" onOp={onOp} />);
		const groupCss = screen.getByLabelText('group css');
		fireEvent.change(groupCss, { target: { value: '.g {}' } });
		fireEvent.blur(groupCss);
		expect(lastOp(onOp, 'patchGroup')).toMatchObject({ patch: { css: '.g {}' } });
		const defCss = screen.getByLabelText('def css');
		fireEvent.change(defCss, { target: { value: '.d {}' } });
		fireEvent.blur(defCss);
		expect(lastOp(onOp, 'setDefCss')).toEqual({ op: 'setDefCss', defId: 'd1', css: '.d {}' });
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector group def params + floating group', () => {
	it('adds a def param with no target (target omitted)', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const child = leaf(w({ id: 'c', type: 'clock' }));
		const g = group('g1', { w: 1, h: 1 }, child, { name: 'G', def: 'd1' });
		const def: WidgetDef = { id: 'd1', name: 'Def', size: { w: 1, h: 1 }, child };
		render(<Inspector groupUnit={g} def={def} placement="flow" onOp={onOp} />);
		fireEvent.change(screen.getByPlaceholderText('param key'), { target: { value: 'k' } });
		fireEvent.click(screen.getByRole('button', { name: 'Add param' }));
		expect(lastOp(onOp, 'addDefParam')).toEqual({
			op: 'addDefParam',
			defId: 'd1',
			key: 'k',
			target: undefined
		});
	});

	it('does not add a param when the key field is empty', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const child = leaf(w({ id: 'c', type: 'clock' }));
		const g = group('g1', { w: 1, h: 1 }, child, { name: 'G', def: 'd1' });
		const def: WidgetDef = { id: 'd1', name: 'Def', size: { w: 1, h: 1 }, child };
		render(<Inspector groupUnit={g} def={def} placement="flow" onOp={onOp} />);
		fireEvent.click(screen.getByRole('button', { name: 'Add param' })); // key still empty
		expect(onOp.mock.calls.some((c) => (c[0] as LayoutOp).op === 'addDefParam')).toBe(false);
	});

	it('defaults a floating group anchor to 0 when its config carries no coordinates', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const g = group('g1', { w: 30, h: 20 }, leaf(w({ id: 'c', type: 'clock' })), { config: {} });
		render(<Inspector groupUnit={g} placement="floating" onOp={onOp} />);
		const [x, y, wIn, hIn] = within(screen.getByText('group · g1').closest('.fields')!)
			.getAllByRole('spinbutton')
			.slice(0, 4) as HTMLInputElement[];
		// x/y default to 0 (no config), w/h fall back to the group size.
		expect(x.value).toBe('0');
		expect(y.value).toBe('0');
		expect(wIn.value).toBe('30');
		expect(hIn.value).toBe('20');
		fireEvent.input(x, { target: { value: '12' } });
		expect(lastOp(onOp, 'patchGroup')).toMatchObject({ patch: { config: { x: 12 } } });
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector config-field reset (macro / monitorSources / toggle)', () => {
	it('resets a toggle field to its default', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [{ key: 'fill', label: 'fill', kind: 'toggle', default: false }];
		render(
			<Inspector
				widget={gaugeWidget({ fill: true })}
				placement="floating"
				configFields={fields}
				onOp={onOp}
			/>
		);
		fireEvent.click(within(panel()).getByTitle('Reset to default'));
		expect(configPatch(onOp)).toEqual({ fill: false });
	});

	it('resets a macro field to its default', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [
			{ key: 'actions', label: 'actions', kind: 'macro', default: [] }
		];
		render(
			<Inspector
				widget={{
					...gaugeWidget(),
					type: 'button',
					config: { actions: [{ kind: 'media', action: 'playpause' }] }
				}}
				placement="floating"
				configFields={fields}
				onOp={onOp}
			/>
		);
		fireEvent.click(within(panel()).getByTitle('Reset to default'));
		expect(configPatch(onOp)).toEqual({ actions: [] });
	});

	it('resets a monitorSources field to its default', async () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [
			{ key: 'sources', label: 'sources', kind: 'monitorSources', default: '' }
		];
		render(
			<Inspector
				widget={{ ...gaugeWidget(), type: 'monitorswitch', config: { sources: '0x11=A' } }}
				placement="floating"
				configFields={fields}
				onOp={onOp}
			/>
		);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		// With a non-empty spec the editor shows a (manual) row, not the empty-state placeholder —
		// wait for the detect effect to settle on the row-count status before interacting.
		await screen.findByText('1 input');
		fireEvent.click(within(panel()).getByTitle('Reset to default'));
		expect(configPatch(onOp)).toEqual({ sources: '' });
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector select catalogs (microphones / displayNames)', () => {
	it('fills a microphones select with the system-default row and the runtime devices', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [
			{ key: 'mic', label: 'microphone', kind: 'select', options: [], catalog: 'microphones' }
		];
		render(
			<Inspector
				widget={gaugeWidget()}
				placement="floating"
				configFields={fields}
				microphones={[{ id: 'm1', name: 'Boom Mic' }]}
				onOp={onOp}
			/>
		);
		fireEvent.click(within(panel()).getByLabelText('microphone'));
		expect(screen.getByText('System default', { selector: '.np-select-opt-label' })).toBeTruthy();
		fireEvent.click(screen.getByText('Boom Mic', { selector: '.np-select-opt-label' }));
		expect(configPatch(onOp)).toEqual({ mic: 'm1' });
	});

	it('fills a displayNames select with the primary-monitor row and the runtime monitors', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [
			{ key: 'monitor', label: 'monitor', kind: 'select', options: [], catalog: 'displayNames' }
		];
		render(
			<Inspector
				widget={gaugeWidget()}
				placement="floating"
				configFields={fields}
				displayNames={[{ id: '\\\\.\\DISPLAY1', name: 'Dell' }]}
				onOp={onOp}
			/>
		);
		fireEvent.click(within(panel()).getByLabelText('monitor'));
		expect(screen.getByText('Primary monitor', { selector: '.np-select-opt-label' })).toBeTruthy();
		fireEvent.click(screen.getByText('Dell', { selector: '.np-select-opt-label' }));
		expect(configPatch(onOp)).toEqual({ monitor: '\\\\.\\DISPLAY1' });
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector expr-field hint edge cases', () => {
	it('renders no sensor-hint for an empty or reference-free formula', () => {
		const fields: ConfigField[] = [
			{ key: 'value', label: 'value', kind: 'expr', result: 'number' }
		];
		const { rerender } = render(
			<Inspector widget={gaugeWidget()} placement="floating" configFields={fields} onOp={vi.fn()} />
		);
		expect(document.querySelector('.cfg-expr-refs')).toBeNull(); // empty source
		rerender(
			<Inspector
				widget={gaugeWidget({ value: '1 + 2' })}
				placement="floating"
				configFields={fields}
				onOp={vi.fn()}
			/>
		);
		expect(document.querySelector('.cfg-expr-refs')).toBeNull(); // no sensor references
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector per-widget token overrides (set)', () => {
	it('sets a widget token override via a token field', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widget={w()} placement="floating" onOp={onOp} />);
		const radius = screen.getByLabelText('radius');
		fireEvent.change(radius, { target: { value: '6px' } });
		fireEvent.blur(radius);
		expect(lastOp(onOp, 'setWidgetToken')).toEqual({
			op: 'setWidgetToken',
			id: 'w1',
			key: '--np-radius',
			value: '6px'
		});
	});

	it('sets a group token override scoped to the group id', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const g = group('g1', { w: 1, h: 1 }, leaf(w({ id: 'c', type: 'clock' })), { name: 'G' });
		render(<Inspector groupUnit={g} placement="flow" onOp={onOp} />);
		const radius = screen.getByLabelText('radius');
		fireEvent.change(radius, { target: { value: '3px' } });
		fireEvent.blur(radius);
		expect(lastOp(onOp, 'setWidgetToken')).toEqual({
			op: 'setWidgetToken',
			id: 'g1',
			key: '--np-radius',
			value: '3px'
		});
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector Data tab wiring', () => {
	const widget = w();
	const node = leaf(widget);

	it('resyncs the JSON buffer when the selected node identity changes, and hides the tabs when null', () => {
		const { rerender } = render(
			<Inspector widget={widget} placement="floating" node={node} onOp={vi.fn()} />
		);
		fireEvent.click(screen.getByText('Data'));
		expect((screen.getByLabelText('Node JSON') as HTMLTextAreaElement).value).toContain(
			'"id": "w1"'
		);
		const widget2 = w({ id: 'w2' });
		rerender(
			<Inspector widget={widget2} placement="floating" node={leaf(widget2)} onOp={vi.fn()} />
		);
		expect((screen.getByLabelText('Node JSON') as HTMLTextAreaElement).value).toContain(
			'"id": "w2"'
		);
		// Losing the node drops the Fields/Data tabs entirely.
		rerender(<Inspector widget={widget2} placement="floating" node={null} onOp={vi.fn()} />);
		expect(screen.queryByRole('tab', { name: 'Data' })).toBeNull();
	});

	it('rejects a JSON array with "Expected a JSON object"', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widget={widget} placement="floating" node={node} onOp={onOp} />);
		fireEvent.click(screen.getByText('Data'));
		fireEvent.change(screen.getByLabelText('Node JSON'), { target: { value: '[1, 2]' } });
		fireEvent.click(screen.getByText('Apply'));
		expect(screen.getByText(/Expected a JSON object/)).toBeTruthy();
		expect(onOp.mock.calls.some((c) => c[0].op === 'replaceNode')).toBe(false);
	});

	it('rejects an object that is neither a widget nor a container', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widget={widget} placement="floating" node={node} onOp={onOp} />);
		fireEvent.click(screen.getByText('Data'));
		fireEvent.change(screen.getByLabelText('Node JSON'), { target: { value: '{ "foo": 1 }' } });
		fireEvent.click(screen.getByText('Apply'));
		expect(screen.getByText(/Expected a widget .* or a container/)).toBeTruthy();
	});

	it('applies a valid container node via replaceNode', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const c = container('root', 'col', []);
		render(<Inspector container={c} node={c} onOp={onOp} />);
		fireEvent.click(screen.getByText('Data'));
		fireEvent.change(screen.getByLabelText('Node JSON'), {
			target: { value: '{ "kind": "row", "children": [] }' }
		});
		fireEvent.click(screen.getByText('Apply'));
		const applied = lastOp(onOp, 'replaceNode');
		expect(applied && applied.op === 'replaceNode' && applied.node).toMatchObject({
			kind: 'row',
			id: 'root'
		});
	});

	it('reverts the buffer, toggles JSON/YAML formats, and returns to the Fields tab', () => {
		render(<Inspector widget={widget} placement="floating" node={node} onOp={vi.fn()} />);
		fireEvent.click(screen.getByText('Data'));
		const area = () => screen.getByLabelText('Node JSON') as HTMLTextAreaElement;
		fireEvent.change(area(), { target: { value: 'scratch edit' } });
		fireEvent.click(screen.getByText('Revert'));
		expect(area().value).toContain('"id": "w1"');
		// YAML (read-only) then back to JSON.
		fireEvent.click(screen.getByText('YAML'));
		expect(screen.getByLabelText('Node YAML (read-only)')).toBeTruthy();
		fireEvent.click(screen.getByText('JSON'));
		expect(screen.getByLabelText('Node JSON')).toBeTruthy();
		// Back to the form via the Fields tab.
		fireEvent.click(screen.getByRole('tab', { name: 'Fields' }));
		expect(screen.getByRole('tabpanel', { name: /Fields/i })).toBeTruthy();
	});

	it('ignores non-arrow keys on the tablist', () => {
		render(<Inspector widget={widget} placement="floating" node={node} onOp={vi.fn()} />);
		const tablist = screen.getByRole('tablist');
		fireEvent.keyDown(tablist, { key: 'ArrowDown' });
		expect(within(tablist).getByRole('tab', { name: 'Fields' }).getAttribute('aria-selected')).toBe(
			'true'
		);
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector config JSON resync + docked chrome', () => {
	it('resyncs the raw config box on a widget switch and drops it when a container is selected', () => {
		const { rerender } = render(
			<Inspector
				widget={gaugeWidget({ label: 'A' })}
				placement="floating"
				configFields={[]}
				onOp={vi.fn()}
			/>
		);
		const box = () =>
			within(panel()).getByRole('textbox', { name: /config \(JSON\)/i }) as HTMLTextAreaElement;
		expect(box().value).toContain('"label": "A"');
		rerender(
			<Inspector
				widget={gaugeWidget({ label: 'B' })}
				placement="floating"
				configFields={[]}
				onOp={vi.fn()}
			/>
		);
		expect(box().value).toContain('"label": "B"');
		// Selecting a container clears the widget branch (and its config box) without crashing.
		rerender(<Inspector container={container('root', 'col', [])} onOp={vi.fn()} />);
		expect(within(panel()).queryByRole('textbox', { name: /config \(JSON\)/i })).toBeNull();
	});

	it('adds the docked modifier class to the rail', () => {
		const { container: root } = render(<Inspector docked onOp={vi.fn()} />);
		expect(root.querySelector('.inspector')!.className).toContain('docked');
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector nodeIsNew for containers and groups', () => {
	it('reads every container field as dirty when the node is new, despite an identical baseline', () => {
		const c = container('root', 'col', []);
		render(
			<Inspector
				container={c}
				baseContainer={container('root', 'col', [])}
				nodeIsNew
				onOp={vi.fn()}
			/>
		);
		expect(within(panel()).getByText('kind').closest('label')!.className).toContain('dirty');
	});

	it('reads every group field as dirty when the node is new, despite an identical baseline', () => {
		const child = leaf(w({ id: 'c', type: 'clock' }));
		const g = group('g1', { w: 1, h: 1 }, child, { name: 'Same' });
		const base = group('g1', { w: 1, h: 1 }, child, { name: 'Same' });
		render(<Inspector groupUnit={g} baseGroup={base} nodeIsNew placement="flow" onOp={vi.fn()} />);
		expect(screen.getByText('name').closest('label')!.className).toContain('dirty');
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector text-template expr field', () => {
	it('uses the template placeholder, lists {refs} via templateRefs, and clears to undefined', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [{ key: 'tpl', label: 'template', kind: 'expr', result: 'text' }];
		render(
			<Inspector
				widget={gaugeWidget({ tpl: 'CPU {cpu.total}%' })}
				placement="floating"
				configFields={fields}
				sensors={['cpu.total']}
				onOp={onOp}
			/>
		);
		// A text-result formula gets the template placeholder and its refs come from templateRefs.
		const area = within(panel()).getByPlaceholderText('text + {expression}');
		const hint = document.querySelector('.cfg-expr-refs') as HTMLElement;
		expect(within(hint).getByText(/cpu\.total/)).toBeTruthy();
		expect(hint.querySelector('.unknown')).toBeNull(); // the ref is a known sensor
		// Clearing the textarea stores undefined (drop the key), not an empty string.
		fireEvent.input(area, { target: { value: '' } });
		expect(configPatch(onOp)).toEqual({ tpl: undefined });
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector template options form — unlabeled param', () => {
	it('falls back to the param key for the row label and aria-label', () => {
		registerTemplates('KeyOnly', [
			{
				id: 'keyonly-1',
				name: 'Key Only',
				description: 'param without a label',
				size: { w: 10, h: 10 },
				params: [
					{
						key: 'lang',
						default: 'a',
						target: 'unit.config.lang',
						choices: [
							{ value: 'a', label: 'A' },
							{ value: 'b', label: 'B' }
						]
					}
				],
				tree: () => leaf(w({ id: 'p', type: 'text' }))
			}
		]);
		let unmount: () => void = () => undefined;
		try {
			unmount = render(<Inspector onOp={vi.fn()} />).unmount;
			// No `label` on the spec → the key names both the visible row and the select's aria-label.
			expect(within(palette()).getByLabelText('Key Only — lang')).toBeTruthy();
			expect(within(palette()).getByText('lang', { selector: 'label' })).toBeTruthy();
		} finally {
			unmount();
			unregisterTemplates('KeyOnly');
		}
	});
});

// ---------------------------------------------------------------------------------------------------
describe('Inspector remaining branch wiring', () => {
	it('clears group css to undefined on an empty blur', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const g = group('g1', { w: 1, h: 1 }, leaf(w({ id: 'c', type: 'clock' })), {
			name: 'G',
			css: 'x'
		});
		render(<Inspector groupUnit={g} placement="flow" onOp={onOp} />);
		const groupCss = screen.getByLabelText('group css');
		fireEvent.change(groupCss, { target: { value: '' } });
		fireEvent.blur(groupCss);
		expect(lastOp(onOp, 'patchGroup')).toMatchObject({ patch: { css: undefined } });
	});

	it('defaults the untouched leaf-align axis to "fill" when emitting setLeafAlign', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		// Neither halign nor valign supplied: changing one axis defaults the other to 'fill'.
		render(<Inspector widget={w()} placement="flow" onOp={onOp} />);
		fireEvent.click(within(panel()).getByLabelText('horizontal align'));
		fireEvent.click(screen.getByText('center', { selector: '.np-select-opt-label' }));
		expect(lastOp(onOp, 'setLeafAlign')).toEqual({
			op: 'setLeafAlign',
			id: 'w1',
			halign: 'center',
			valign: 'fill'
		});
		fireEvent.click(within(panel()).getByLabelText('vertical align'));
		fireEvent.click(screen.getByText('middle', { selector: '.np-select-opt-label' }));
		expect(lastOp(onOp, 'setLeafAlign')).toEqual({
			op: 'setLeafAlign',
			id: 'w1',
			halign: 'fill',
			valign: 'middle'
		});
	});

	it('coerces an emptied group fixed-px input to a 0 basis', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const g = group('g1', { w: 100, h: 40 }, leaf(w({ id: 'c', type: 'clock' })), { name: 'G' });
		render(
			<Inspector groupUnit={g} placement="flow" widgetBasis={120} node={leaf(g)} onOp={onOp} />
		);
		fireEvent.input(screen.getByRole('spinbutton', { name: 'size (px)' }), {
			target: { value: '' }
		});
		expect(lastOp(onOp, 'setBasis')).toEqual({ op: 'setBasis', id: 'g1', basis: 0 });
	});

	it('emits an fr basis when a container picks "fill — grow to share"', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector container={container('root', 'col', [])} onOp={onOp} />);
		fireEvent.click(within(panel()).getByLabelText('container size in parent'));
		fireEvent.click(screen.getByText('fill — grow to share', { selector: '.np-select-opt-label' }));
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'root',
			patch: { basis: { fr: 1 } }
		});
	});

	it('copies the JSON representation from the Data tab', () => {
		const onCopy = vi.fn<(t: string) => void>();
		const widget = w();
		render(<Inspector widget={widget} placement="floating" node={leaf(widget)} onCopy={onCopy} />);
		fireEvent.click(screen.getByText('Data'));
		fireEvent.click(screen.getByText('⧉ Copy')); // JSON is the initial format
		expect(onCopy).toHaveBeenCalledWith(expect.stringContaining('"id": "w1"'));
	});

	it('shows neither Dock nor Float when the placement is unknown', () => {
		render(<Inspector widget={w()} onOp={vi.fn()} />);
		expect(within(panel()).queryByRole('button', { name: 'Dock →flow' })).toBeNull();
		expect(within(panel()).queryByRole('button', { name: 'Float' })).toBeNull();
	});

	it('defaults grid cols/rows inputs to 1 and flags dirty grid + gap + cell fields', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		// cols/rows unset (→ the ?? 1 display default); baseline differs in cols/rows/gap/cellW/cellH.
		const c = container('g', 'grid', [], { gap: 4, cellW: 5, cellH: 6 });
		const base = container('g', 'grid', [], { cols: 2, rows: 3, gap: 0, cellW: 1, cellH: 2 });
		render(<Inspector container={c} baseContainer={base} isGridCell onOp={onOp} />);
		const cols = within(panel()).getByRole('spinbutton', { name: 'cols' }) as HTMLInputElement;
		expect(cols.value).toBe('1');
		expect(cols.closest('label')!.className).toContain('dirty');
		const rows = within(panel()).getByRole('spinbutton', { name: 'rows' }) as HTMLInputElement;
		expect(rows.value).toBe('1');
		expect(rows.closest('label')!.className).toContain('dirty');
		expect(
			within(panel()).getByRole('spinbutton', { name: 'gap' }).closest('label')!.className
		).toContain('dirty');
		const cellW = within(panel()).getByRole('spinbutton', { name: 'width (px)' });
		expect(cellW.closest('label')!.className).toContain('dirty');
		expect(
			within(panel()).getByRole('spinbutton', { name: 'height (px)' }).closest('label')!.className
		).toContain('dirty');
		// Emptying a cell size clears it back to flex (undefined).
		fireEvent.input(cellW, { target: { value: '' } });
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'g',
			patch: { cellW: undefined }
		});
	});

	it('flags a dirty flow w/h field against the baseline', () => {
		const widget = w({ rect: { x: 0, y: 0, w: 160, h: 40 } });
		const base = w({ rect: { x: 0, y: 0, w: 100, h: 40 } });
		render(<Inspector widget={widget} baseWidget={base} placement="flow" onOp={vi.fn()} />);
		expect(
			within(panel()).getByRole('spinbutton', { name: 'w (fixed)' }).closest('label')!.className
		).toContain('dirty');
		expect(
			within(panel()).getByRole('spinbutton', { name: 'h (fixed)' }).closest('label')!.className
		).not.toContain('dirty');
	});

	it('renders the help line for macro / monitorSources / toggle / generic fields', async () => {
		const fields: ConfigField[] = [
			{ key: 'actions', label: 'actions', kind: 'macro', help: 'macro help' },
			{ key: 'sources', label: 'sources', kind: 'monitorSources', help: 'sources help' },
			{ key: 'fill', label: 'fill', kind: 'toggle', help: 'toggle help' },
			{ key: 'label', label: 'label', kind: 'text', help: 'text help' }
		];
		render(
			<Inspector
				widget={{ ...gaugeWidget(), type: 'button', config: { actions: [] } }}
				placement="floating"
				configFields={fields}
				onOp={vi.fn()}
			/>
		);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(within(panel()).getByText('macro help')).toBeTruthy();
		expect(within(panel()).getByText('sources help')).toBeTruthy();
		expect(within(panel()).getByText('toggle help')).toBeTruthy();
		expect(within(panel()).getByText('text help')).toBeTruthy();
		// Let the (mocked) monitor-inputs detect effect settle inside the test. The placeholder exists
		// before that promise resolves, so wait for the post-scan status instead.
		await screen.findByText('0 inputs');
	});

	it('clears the sources spec to undefined when the last monitor input is unchecked', async () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [{ key: 'sources', label: 'sources', kind: 'monitorSources' }];
		render(
			<Inspector
				widget={{ ...gaugeWidget(), type: 'monitorswitch', config: { sources: '0x11=A' } }}
				placement="floating"
				configFields={fields}
				onOp={onOp}
			/>
		);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		// The manual 0x11 entry appears as one checked row once detection resolves; unchecking it
		// empties the spec, which the Inspector stores as undefined.
		await screen.findByText('1 input');
		fireEvent.click(within(panel()).getByRole('checkbox'));
		expect(configPatch(onOp)).toEqual({ sources: undefined });
	});

	it('renders unlabeled def params with key fallbacks and empty unset values', () => {
		const child = leaf(w({ id: 'c', type: 'clock' }));
		// No params override on the group; specs carry no label and no default.
		const g = group('g1', { w: 1, h: 1 }, child, { name: 'G', def: 'd1' });
		const def: WidgetDef = {
			id: 'd1',
			name: 'Def',
			size: { w: 1, h: 1 },
			child,
			params: [
				{ key: 'plain' },
				{
					key: 'pick',
					choices: [
						{ value: 'x', label: 'X' },
						{ value: 'y', label: 'Y' }
					]
				}
			]
		};
		render(<Inspector groupUnit={g} def={def} placement="flow" onOp={vi.fn()} />);
		// The text param: key as the label, an empty input (no override, no default, no target hint).
		const plainLabel = screen.getByText('plain', { selector: 'label' });
		expect((within(plainLabel).getByRole('textbox') as HTMLInputElement).value).toBe('');
		// The choices param: key drives the aria-label; unset value falls to '' (no default).
		expect(screen.getByLabelText('param pick')).toBeTruthy();
	});

	it('leaves grid + cell fields clean against an identical baseline and clears cellH to flex', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		// Identical baseline → the not-dirty (no class) arm of every grid/cell field label.
		const opts = { cols: 2, rows: 2, gap: 4, cellW: 5, cellH: 6 } as const;
		const c = container('g', 'grid', [], { ...opts });
		const base = container('g', 'grid', [], { ...opts });
		render(<Inspector container={c} baseContainer={base} isGridCell onOp={onOp} />);
		for (const name of ['cols', 'rows', 'gap', 'width (px)', 'height (px)']) {
			expect(
				within(panel()).getByRole('spinbutton', { name }).closest('label')!.className
			).not.toContain('dirty');
		}
		// Emptying the cell height clears it back to flex (undefined), like the width.
		fireEvent.input(within(panel()).getByRole('spinbutton', { name: 'height (px)' }), {
			target: { value: '' }
		});
		expect(lastOp(onOp, 'patchContainer')).toEqual({
			op: 'patchContainer',
			id: 'g',
			patch: { cellH: undefined }
		});
	});

	it('clears a GROUP token override set via the clear-all button', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const g = group('g1', { w: 1, h: 1 }, leaf(w({ id: 'c', type: 'clock' })), {
			name: 'G',
			tokens: { '--np-fg': 'red' }
		});
		render(<Inspector groupUnit={g} placement="flow" onOp={onOp} />);
		fireEvent.click(screen.getByRole('button', { name: 'Clear 1 override' }));
		expect(lastOp(onOp, 'clearWidgetTokens')).toEqual({ op: 'clearWidgetTokens', id: 'g1' });
	});
});
