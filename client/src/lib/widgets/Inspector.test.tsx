import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import Inspector, { groupPalette } from './Inspector';
import {
	container,
	leaf,
	type Group,
	type WidgetDef,
	type WidgetInstance
} from '../core/layoutTree';
import type { LayoutOp } from './ops';

describe('groupPalette', () => {
	it('groups by category in first-seen order, keeping registration order within a group', () => {
		const groups = groupPalette([
			{ type: 'gauge', label: 'Gauge', category: 'Meters' },
			{ type: 'clock', label: 'Clock', category: 'Clocks' },
			{ type: 'bar', label: 'Bar', category: 'Meters' }
		]);
		expect(groups.map((g) => g.category)).toEqual(['Meters', 'Clocks']);
		expect(groups[0].items.map((i) => i.type)).toEqual(['gauge', 'bar']);
	});

	it('sinks uncategorized entries to a trailing "Other" group', () => {
		const groups = groupPalette([
			{ type: 'mystery', label: 'Mystery' },
			{ type: 'gauge', label: 'Gauge', category: 'Meters' }
		]);
		expect(groups.map((g) => g.category)).toEqual(['Meters', 'Other']);
		expect(groups[1].items[0].type).toBe('mystery');
	});
});

const flowWidget: WidgetInstance = {
	id: 'w1',
	type: 'clock',
	rect: { x: 0, y: 0, w: 160, h: 40 },
	config: {}
};

describe('Inspector Data tab (JSON/YAML representation)', () => {
	it('applies an edited JSON node via replaceNode, coercing the id back to the slot', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const node = leaf(flowWidget); // { id: 'w1', unit: flowWidget }
		const { getByText, getByLabelText } = render(
			<Inspector widget={flowWidget} placement="floating" node={node} onOp={onOp} />
		);
		fireEvent.click(getByText('Data'));
		const area = getByLabelText('Node JSON') as HTMLTextAreaElement;
		const edited = JSON.stringify(
			{ ...node, id: 'CHANGED', unit: { ...flowWidget, config: { format: 'HH:mm' } } },
			null,
			2
		);
		fireEvent.change(area, { target: { value: edited } });
		fireEvent.click(getByText('Apply'));
		const call = onOp.mock.calls.map((c) => c[0]).find((o) => o.op === 'replaceNode');
		expect(call).toBeTruthy();
		expect(call && call.op === 'replaceNode' && call.id).toBe('w1');
		// id is coerced back to the slot id even though the edit changed it
		expect(call && call.op === 'replaceNode' && call.node.id).toBe('w1');
	});

	it('rejects invalid JSON without emitting replaceNode', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const node = leaf(flowWidget);
		const { getByText, getByLabelText } = render(
			<Inspector widget={flowWidget} placement="floating" node={node} onOp={onOp} />
		);
		fireEvent.click(getByText('Data'));
		fireEvent.change(getByLabelText('Node JSON'), { target: { value: '{ not json' } });
		fireEvent.click(getByText('Apply'));
		expect(onOp.mock.calls.some((c) => c[0].op === 'replaceNode')).toBe(false);
	});

	it('shows a read-only YAML view and copies it via onCopy', () => {
		const onCopy = vi.fn<(t: string) => void>();
		const node = leaf(flowWidget);
		const { getByText, getByLabelText } = render(
			<Inspector widget={flowWidget} placement="floating" node={node} onCopy={onCopy} />
		);
		fireEvent.click(getByText('Data'));
		fireEvent.click(getByText('YAML'));
		const yaml = getByLabelText('Node YAML (read-only)') as HTMLTextAreaElement;
		expect(yaml.readOnly).toBe(true);
		expect(yaml.value).toContain('type: clock');
		fireEvent.click(getByText('⧉ Copy'));
		expect(onCopy).toHaveBeenCalledWith(expect.stringContaining('type: clock'));
	});
});

describe('Inspector pad/gap guardrail', () => {
	it('clamps an over-large pad to the selected container box', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const c = container('root', 'col', [], { align: 'stretch' });
		const { getByLabelText } = render(
			<Inspector container={c} containerBox={{ x: 0, y: 0, w: 166, h: 98 }} onOp={onOp} />
		);
		// pad 111 on a 166×98 box would collapse the content; the guardrail caps it at 24 (¼ of 98).
		// The pad control is now a BoxField (locked → one "all sides" input that clamps each side).
		fireEvent.input(getByLabelText('pad all sides'), { target: { value: '111' } });
		expect(onOp).toHaveBeenCalledWith({ op: 'patchContainer', id: 'root', patch: { pad: 24 } });
	});

	it('passes a within-range pad through unchanged', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const c = container('root', 'col', [], { align: 'stretch' });
		const { getByLabelText } = render(
			<Inspector container={c} containerBox={{ x: 0, y: 0, w: 166, h: 98 }} onOp={onOp} />
		);
		fireEvent.input(getByLabelText('pad all sides'), { target: { value: '8' } });
		expect(onOp).toHaveBeenCalledWith({ op: 'patchContainer', id: 'root', patch: { pad: 8 } });
	});
});

describe('Inspector flow-widget sizing (fixed / content / grow)', () => {
	// The sizing control is now the shared <Select> (a button + portaled menu), so we open it and click
	// the option rather than firing change on a native <select>.
	it('reflects an fr basis as "grow" and emits cleared basis for "fixed"', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widget={flowWidget} placement="flow" widgetBasis={{ fr: 1 }} onOp={onOp} />);
		const trigger = screen.getByLabelText(/size along the row/i);
		expect(trigger).toHaveTextContent(/grow/i);
		fireEvent.click(trigger);
		fireEvent.click(
			screen.getByText('fixed — use the w/h above', { selector: '.np-select-opt-label' })
		);
		expect(onOp).toHaveBeenCalledWith({ op: 'setBasis', id: 'w1', basis: undefined });
	});

	it('defaults to "fixed" with no basis, and emits an fr basis for "grow"', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		render(<Inspector widget={flowWidget} placement="flow" onOp={onOp} />);
		const trigger = screen.getByLabelText(/size along the row/i);
		expect(trigger).toHaveTextContent(/fixed/i);
		fireEvent.click(trigger);
		fireEvent.click(screen.getByText('fill — grow to share', { selector: '.np-select-opt-label' }));
		expect(onOp).toHaveBeenCalledWith({ op: 'setBasis', id: 'w1', basis: { fr: 1 } });
	});

	it('reflects "content" and emits the measured-content basis when picking "fit to content"', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		// content shows as "hug — fit to content"…
		const { rerender } = render(
			<Inspector widget={flowWidget} placement="flow" widgetBasis="content" onOp={onOp} />
		);
		expect(screen.getByLabelText(/size along the row/i)).toHaveTextContent(/hug/i);
		// …and picking it from a DIFFERENT current value emits the content basis (Downshift only fires on
		// an actual change, so we start from grow).
		rerender(
			<Inspector widget={flowWidget} placement="flow" widgetBasis={{ fr: 1 }} onOp={onOp} />
		);
		fireEvent.click(screen.getByLabelText(/size along the row/i));
		fireEvent.click(screen.getByText('hug — fit to content', { selector: '.np-select-opt-label' }));
		expect(onOp).toHaveBeenCalledWith({ op: 'setBasis', id: 'w1', basis: 'content' });
	});

	it('hides the sizing control for a floating widget (no row to size within)', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const { queryByLabelText } = render(
			<Inspector widget={flowWidget} placement="floating" onOp={onOp} />
		);
		expect(queryByLabelText(/size along the row/i)).toBeNull();
	});
});

describe('Inspector sensor typeahead options', () => {
	it('labels options with the friendly name (+ unit) and shows the raw id as a hint', () => {
		render(
			<Inspector
				widget={flowWidget}
				placement="floating"
				sensors={['ha.sensor.temp', 'cpu.total']}
				sensorMeta={{ 'ha.sensor.temp': { label: 'Temp', unit: '°C' } }}
				onOp={vi.fn()}
			/>
		);
		fireEvent.click(screen.getByLabelText('Toggle options')); // open the sensor combobox
		expect(screen.getByText('Temp (°C)')).toBeInTheDocument();
		expect(
			screen.getByText('ha.sensor.temp', { selector: '.np-select-opt-hint' })
		).toBeInTheDocument();
		// An id without metadata is its own label, with no separate hint.
		expect(screen.getByText('cpu.total', { selector: '.np-select-opt-label' })).toBeInTheDocument();
	});
});

describe('Inspector group + def params block', () => {
	const child = leaf({
		id: 'g1.child',
		type: 'clock',
		rect: { x: 0, y: 0, w: 80, h: 40 },
		config: {}
	});
	const groupUnit: Group = {
		id: 'g1',
		kind: 'group',
		name: 'My clock',
		def: 'd1',
		size: { w: 120, h: 60 },
		child,
		params: { tz: 'UTC' },
		config: { x: 10, y: 20 }
	};
	const def: WidgetDef = {
		id: 'd1',
		name: 'ClockDef',
		size: { w: 120, h: 60 },
		child,
		params: [
			{ key: 'tz', label: 'Timezone', target: 'unit.config.tz' },
			{
				key: 'hours',
				label: 'Clock',
				default: '24',
				choices: [
					{ value: '12', label: '12-hour' },
					{ value: '24', label: '24-hour' }
				]
			}
		]
	};

	it('renders the def fields + params and emits ops for every editable control (floating)', () => {
		const onOp = vi.fn<(op: LayoutOp) => void>();
		const {
			getByText,
			getByLabelText,
			container: root
		} = render(<Inspector groupUnit={groupUnit} def={def} placement="floating" onOp={onOp} />);
		const lastOp = (pred: (o: LayoutOp) => boolean) => onOp.mock.calls.map((c) => c[0]).find(pred);

		// The group header + name field.
		expect(getByText('group · g1')).toBeTruthy();
		const name = root.querySelector('input[value="My clock"]') as HTMLInputElement;
		fireEvent.input(name, { target: { value: 'Renamed' } });
		expect(lastOp((o) => o.op === 'patchGroup' && !!o.patch.name)).toMatchObject({
			op: 'patchGroup',
			id: 'g1',
			patch: { name: 'Renamed' }
		});

		// Floating x/y/w/h write into the group's config (anchor + size override).
		const floatRow = root.querySelector('.row') as HTMLElement;
		const numInputs = [...floatRow.querySelectorAll('input[type="number"]')];
		fireEvent.input(numInputs[0], { target: { value: '99' } }); // x
		expect(lastOp((o) => o.op === 'patchGroup' && o.patch.config?.x === 99)).toBeTruthy();

		// def name / def w / def h. The def w/h live in their own `.row2` (the floating row also has a w
		// input at value 120, so scope to .row2 to hit the def-size inputs specifically).
		const defName = root.querySelector('input[value="ClockDef"]') as HTMLInputElement;
		fireEvent.input(defName, { target: { value: 'NewName' } });
		expect(lastOp((o) => o.op === 'renameDef')).toMatchObject({ op: 'renameDef', defId: 'd1' });
		const row2 = root.querySelector('.row2') as HTMLElement;
		const [defW, defH] = [...row2.querySelectorAll('input[type="number"]')];
		fireEvent.input(defW, { target: { value: '200' } });
		expect(lastOp((o) => o.op === 'setDefSize' && o.w === 200)).toBeTruthy();
		fireEvent.input(defH, { target: { value: '80' } });
		expect(lastOp((o) => o.op === 'setDefSize' && o.h === 80)).toBeTruthy();

		// Edit def…
		fireEvent.click(getByText('Edit def…'));
		expect(lastOp((o) => o.op === 'editDef')).toMatchObject({ op: 'editDef', defId: 'd1' });

		// A text param writes the override into group.params.
		const tz = root.querySelector('input[value="UTC"]') as HTMLInputElement;
		fireEvent.input(tz, { target: { value: 'Asia/Tokyo' } });
		expect(
			lastOp((o) => o.op === 'patchGroup' && o.patch.params?.tz === 'Asia/Tokyo')
		).toBeTruthy();

		// A select param (the 12/24-hour choice) — open the combobox + pick 12-hour.
		fireEvent.click(getByLabelText('param Clock'));
		fireEvent.click(screen.getByText('12-hour', { selector: '.np-select-opt-label' }));
		expect(lastOp((o) => o.op === 'patchGroup' && o.patch.params?.hours === '12')).toBeTruthy();

		// Add a new param from the key/target inputs (the row above the "Add param" button).
		const addRow = getByText('Add param').previousElementSibling as HTMLElement;
		const [keyInput, targetInput] = [...addRow.querySelectorAll('input')];
		fireEvent.change(keyInput, { target: { value: 'fmt' } });
		fireEvent.change(targetInput, { target: { value: 'unit.config.fmt' } });
		fireEvent.click(getByText('Add param'));
		expect(lastOp((o) => o.op === 'addDefParam')).toMatchObject({
			op: 'addDefParam',
			defId: 'd1',
			key: 'fmt',
			target: 'unit.config.fmt'
		});

		// Unlink + Remove.
		fireEvent.click(getByText('⛓ Unlink'));
		expect(lastOp((o) => o.op === 'ungroup')).toMatchObject({ op: 'ungroup', id: 'g1' });
		fireEvent.click(getByText('Remove'));
		expect(lastOp((o) => o.op === 'remove')).toMatchObject({ op: 'remove', id: 'g1' });
	});

	it('shows the "inline group (no def)" hint when the group has no def, and flow sizing controls', () => {
		const inline: Group = { ...groupUnit, def: undefined, params: undefined };
		const { getByText, getByLabelText } = render(
			<Inspector groupUnit={inline} placement="flow" onOp={vi.fn()} />
		);
		expect(getByText('inline group (no def)')).toBeTruthy();
		// flow placement shows the group's leaf sizing control (aria-label "size in parent").
		expect(getByLabelText('size in parent')).toBeTruthy();
	});

	it('does not render the Params section when the def declares none', () => {
		const noParams: WidgetDef = { ...def, params: [] };
		const noParamGroup: Group = { ...groupUnit, params: undefined };
		const { queryByText } = render(
			<Inspector groupUnit={noParamGroup} def={noParams} placement="floating" onOp={vi.fn()} />
		);
		expect(queryByText('Params')).toBeNull();
	});
});
