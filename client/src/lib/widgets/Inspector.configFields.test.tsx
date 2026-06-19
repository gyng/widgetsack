import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import Inspector from './Inspector';
import type { WidgetInstance } from '../core/layoutTree';
import type { ConfigField } from '../core/widget';
import type { LayoutOp } from './ops';

// Mock the Tauri-backed DDC adapter so the monitorSources field's effect resolves to "no inputs"
// (its detect path calls a backend command via lib/ddc/monitors) instead of hitting `invoke`.
vi.mock('../ddc/monitors', () => ({
	listMonitorInputs: vi.fn().mockResolvedValue([]),
	setMonitorInput: vi.fn().mockResolvedValue(true)
}));

// A `gauge`-typed widget: a real meta is registered (widget.ts BUILTIN_METAS), so fieldDefault can
// fall back to the type's defaultConfig where a field declares no explicit `default`.
const gaugeWidget = (config: Record<string, unknown> = {}): WidgetInstance => ({
	id: 'w1',
	type: 'gauge',
	rect: { x: 0, y: 0, w: 110, h: 110 },
	config
});

// Pull the single patchWidget(config) op out of the recorded calls (the only op these fields emit).
const lastConfigPatch = (onOp: ReturnType<typeof vi.fn>): Record<string, unknown> | undefined => {
	const calls = onOp.mock.calls.map((c) => c[0] as LayoutOp);
	const patch = [...calls].reverse().find((o) => o.op === 'patchWidget');
	return patch && patch.op === 'patchWidget'
		? (patch.patch.config as Record<string, unknown>)
		: undefined;
};

// The properties form is a `role="tabpanel"`; scope queries to it so the (always-rendered, just
// collapsed) Add-palette above — which has its own buttons/selects/textareas — never aliases a match.
const panel = (): HTMLElement => screen.getByRole('tabpanel');

describe('Inspector config-field rendering (per ConfigField kind)', () => {
	it('renders a text field and emits the typed value into config (empty → undefined)', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [{ key: 'label', label: 'label', kind: 'text' }];
		render(
			<Inspector widget={gaugeWidget()} placement="floating" configFields={fields} onOp={onOp} />
		);
		const input = within(panel()).getByRole('textbox', { name: 'label' });
		fireEvent.input(input, { target: { value: 'CPU' } });
		expect(lastConfigPatch(onOp)).toEqual({ label: 'CPU' });

		onOp.mockClear();
		fireEvent.input(input, { target: { value: '' } });
		expect(lastConfigPatch(onOp)).toEqual({ label: undefined });
	});

	it('renders a number field and coerces the value (empty → undefined, else Number)', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [{ key: 'max', label: 'max', kind: 'number' }];
		render(
			<Inspector widget={gaugeWidget()} placement="floating" configFields={fields} onOp={onOp} />
		);
		const input = within(panel()).getByRole('spinbutton', { name: 'max' });
		fireEvent.input(input, { target: { value: '42' } });
		expect(lastConfigPatch(onOp)).toEqual({ max: 42 });

		onOp.mockClear();
		fireEvent.input(input, { target: { value: '' } });
		expect(lastConfigPatch(onOp)).toEqual({ max: undefined });
	});

	it('renders a color field as a text input with a "css color" placeholder', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [{ key: 'color', label: 'color', kind: 'color' }];
		render(
			<Inspector widget={gaugeWidget()} placement="floating" configFields={fields} onOp={onOp} />
		);
		const input = within(panel()).getByRole('textbox', { name: 'color' }) as HTMLInputElement;
		expect(input.placeholder).toBe('css color');
		fireEvent.input(input, { target: { value: '#0f0' } });
		expect(lastConfigPatch(onOp)).toEqual({ color: '#0f0' });
	});

	it('renders a select field as a Select and emits the picked option', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [
			{ key: 'style', label: 'style', kind: 'select', options: ['arc', 'circle', 'linear'] }
		];
		render(
			<Inspector
				widget={gaugeWidget({ style: 'arc' })}
				placement="floating"
				configFields={fields}
				onOp={onOp}
			/>
		);
		// The shared <Select> is a trigger + portaled menu; open it (in-panel, found by aria-label) and
		// pick a different value (the menu itself is portaled to <body>, so screen-level for the option).
		fireEvent.click(within(panel()).getByLabelText('style'));
		fireEvent.click(screen.getByText('circle', { selector: '.np-select-opt-label' }));
		expect(lastConfigPatch(onOp)).toEqual({ style: 'circle' });
	});

	it('fills a select with a runtime catalog (audioOutputs) plus the system-default row', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [
			{
				key: 'device',
				label: 'output device',
				kind: 'select',
				options: [],
				catalog: 'audioOutputs'
			}
		];
		render(
			<Inspector
				widget={gaugeWidget()}
				placement="floating"
				configFields={fields}
				audioOutputs={[{ id: 'spk', name: 'Speakers' }]}
				onOp={onOp}
			/>
		);
		fireEvent.click(within(panel()).getByLabelText('output device'));
		expect(screen.getByText('System default', { selector: '.np-select-opt-label' })).toBeTruthy();
		fireEvent.click(screen.getByText('Speakers', { selector: '.np-select-opt-label' }));
		expect(lastConfigPatch(onOp)).toEqual({ device: 'spk' });
	});

	it('renders an expr (formula) field as a textarea with an ExprHint flagging unknown sensors', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [
			{ key: 'value', label: 'value (formula)', kind: 'expr', result: 'number' }
		];
		render(
			<Inspector
				widget={gaugeWidget({ value: 'cpu.total + mystery.sensor' })}
				placement="floating"
				configFields={fields}
				sensors={['cpu.total']}
				onOp={onOp}
			/>
		);
		// The hint lists referenced sensors; the unknown one carries a "?" + the .unknown class.
		const hint = document.querySelector('.cfg-expr-refs') as HTMLElement;
		expect(hint).toBeTruthy();
		expect(within(hint).getByText(/cpu\.total/)).toBeTruthy();
		expect(hint.querySelector('.unknown')?.textContent).toContain('mystery.sensor');

		// The expr textarea has no aria-label; its placeholder identifies it ('expression' for a number
		// result). Querying by role+name would fold in the ExprHint text the label also wraps.
		const area = within(panel()).getByPlaceholderText('expression');
		fireEvent.input(area, { target: { value: 'cpu.total / 2' } });
		expect(lastConfigPatch(onOp)).toEqual({ value: 'cpu.total / 2' });
	});

	it('renders a toggle as a labelled checkbox and emits the boolean', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [{ key: 'fill', label: 'fill', kind: 'toggle' }];
		render(
			<Inspector
				widget={gaugeWidget({ fill: false })}
				placement="floating"
				configFields={fields}
				onOp={onOp}
			/>
		);
		const box = within(panel()).getByRole('checkbox', { name: 'fill' }) as HTMLInputElement;
		expect(box.checked).toBe(false);
		fireEvent.click(box);
		expect(lastConfigPatch(onOp)).toEqual({ fill: true });
	});

	it('renders a macro field as a list editor that adds an action via setConfig', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [{ key: 'actions', label: 'actions (macro)', kind: 'macro' }];
		render(
			<Inspector
				widget={{ ...gaugeWidget(), type: 'button', config: { actions: [] } }}
				placement="floating"
				configFields={fields}
				onOp={onOp}
			/>
		);
		// Empty macro shows the inert hint; "+ action" appends one row.
		expect(within(panel()).getByText(/the button is inert/i)).toBeTruthy();
		fireEvent.click(within(panel()).getByRole('button', { name: '+ action' }));
		const patch = lastConfigPatch(onOp);
		expect(Array.isArray(patch?.actions)).toBe(true);
		expect((patch?.actions as unknown[]).length).toBe(1);
	});

	it('renders a monitorSources field, degrading to a manual code entry when none detected', async () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [{ key: 'sources', label: 'sources', kind: 'monitorSources' }];
		render(
			<Inspector
				widget={{ ...gaugeWidget(), type: 'monitorswitch', config: {} }}
				placement="floating"
				configFields={fields}
				onOp={onOp}
			/>
		);
		// The header label appears immediately; the manual fallback shows after the (mocked) detect resolves.
		expect(within(panel()).getByText('sources', { selector: '.hd' })).toBeTruthy();
		const manual = await screen.findByPlaceholderText('0x11=Desktop, 0x12=Switch');
		fireEvent.change(manual, { target: { value: '0x11=Desktop' } });
		expect(lastConfigPatch(onOp)).toEqual({ sources: '0x11=Desktop' });
	});
});

describe('Inspector config-field reset button', () => {
	it('resets a field to its explicit default', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const fields: ConfigField[] = [
			{ key: 'style', label: 'style', kind: 'select', options: ['arc', 'circle'], default: 'arc' }
		];
		render(
			<Inspector
				widget={gaugeWidget({ style: 'circle' })}
				placement="floating"
				configFields={fields}
				onOp={onOp}
			/>
		);
		// The reset button shows "↺" (which becomes its accessible name); identify it by its title.
		fireEvent.click(within(panel()).getByTitle('Reset to default'));
		expect(lastConfigPatch(onOp)).toEqual({ style: 'arc' });
	});

	it('disables the reset button when neither the field nor the meta defines a default', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		// A bespoke key absent from the gauge meta's defaultConfig → no default → disabled reset.
		const fields: ConfigField[] = [{ key: 'nodefault', label: 'no default', kind: 'text' }];
		render(
			<Inspector widget={gaugeWidget()} placement="floating" configFields={fields} onOp={onOp} />
		);
		expect(within(panel()).getByTitle('Reset to default')).toBeDisabled();
	});
});

describe('Inspector advanced config JSON / CSS escape hatch', () => {
	it('commits valid raw-JSON config on blur via patchWidget', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(
			<Inspector
				widget={gaugeWidget({ label: 'CPU' })}
				placement="floating"
				configFields={[]}
				onOp={onOp}
			/>
		);
		const area = within(panel()).getByRole('textbox', { name: /config \(JSON\)/i });
		expect((area as HTMLTextAreaElement).value).toContain('"label": "CPU"');
		fireEvent.change(area, { target: { value: '{ "label": "RAM", "unit": "%" }' } });
		fireEvent.blur(area);
		const patch = lastConfigPatch(onOp);
		expect(patch).toEqual({ label: 'RAM', unit: '%' });
	});

	it('flags invalid raw JSON (error class) without emitting a patch', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widget={gaugeWidget()} placement="floating" configFields={[]} onOp={onOp} />);
		const area = within(panel()).getByRole('textbox', { name: /config \(JSON\)/i });
		fireEvent.change(area, { target: { value: '{ not json' } });
		fireEvent.blur(area);
		expect(area.className).toContain('error');
		expect(onOp.mock.calls.some((c) => c[0].op === 'patchWidget')).toBe(false);
	});
});
