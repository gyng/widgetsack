import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import WidgetHost from './WidgetHost';
import HaSensor from './meters/HaSensor';
import { registerWidget } from './registry';
import { createTelemetryHub, type SensorState } from '../core/telemetry';
import type { MeterProps } from './meterProps';
import type { WidgetInstance } from '../core/layout';

// A binds:'json' widget type for the test (reuses the HA sensor meter as the renderer —
// registerWidget is generic over the meter's props, so no cast).
registerWidget({ type: 'test.json', binds: 'json', label: 'T' }, HaSensor);

// A scalar meter that shows its value + history and exposes a button that bubbles an onControl call.
// Declared interactive in the meta (not on the instance) so the meta-fallback path is exercised.
function ScalarProbe({ value, history, onControl }: MeterProps) {
	return (
		<div>
			<span data-testid="scalar">
				{value === null || value === undefined ? '–' : String(value)}
			</span>
			<span data-testid="hist">{(history ?? []).join(',')}</span>
			<button
				type="button"
				onClick={() => onControl?.({ domain: 'light', service: 'toggle', data: { x: 1 } })}
			>
				act
			</button>
		</div>
	);
}
registerWidget(
	{ type: 'test.scalar', binds: 'scalar', label: 'S', interactive: true },
	ScalarProbe
);

// A text-bound meter (binds:'text') — proves the rawValue path distinct from scalar.
function TextProbe({ value }: MeterProps) {
	return <div data-testid="text">{String(value ?? '')}</div>;
}
registerWidget({ type: 'test.text', binds: 'text', label: 'TX' }, TextProbe);

// A formula type: an `expr` config field whose key is also the meter prop. WidgetHost strips the raw
// source from the meter config (so the literal formula never renders before the engine resolves).
function ExprProbe(props: MeterProps) {
	return <div data-testid="expr">{props.foo === undefined ? 'stripped' : String(props.foo)}</div>;
}
registerWidget(
	{
		type: 'test.expr',
		binds: 'none',
		label: 'E',
		configFields: [{ key: 'foo', label: 'Foo', kind: 'expr', result: 'number' }]
	},
	ExprProbe
);

describe('WidgetHost binds-driven value passing', () => {
	it('forwards the raw JSON SensorValue payload to a binds:json meter', () => {
		const hub = createTelemetryHub();
		const instance: WidgetInstance = {
			id: 'w1',
			type: 'test.json',
			sensor: 'x',
			rect: { x: 0, y: 0, w: 150, h: 44 },
			config: {}
		};
		const { getByText } = render(<WidgetHost hub={hub} instance={instance} editMode={false} />);

		// ingest happens OUTSIDE React's render — wrap in act() so the useSyncExternalStore subscriber
		// commits before the assertion (otherwise the re-render hasn't flushed).
		act(() => {
			hub.ingest({
				sensor: 'x',
				ts_ms: 0,
				value: { kind: 'json', value: { state: '42', attributes: { friendly_name: 'Foo' } } }
			});
		});

		expect(() => getByText('Foo')).not.toThrow();
		expect(() => getByText(/42/)).not.toThrow();
	});

	it('content-fit mode renders the box at max-content instead of the fixed rect size', () => {
		const hub = createTelemetryHub();
		const instance: WidgetInstance = {
			id: 'w2',
			type: 'test.json',
			sensor: 'x',
			rect: { x: 0, y: 0, w: 150, h: 44 },
			config: {}
		};
		const { container } = render(
			<WidgetHost hub={hub} instance={instance} contentSize editMode={false} />
		);
		const box = container.querySelector('.widget') as HTMLElement;
		expect(box.style.width).toBe('max-content');
		expect(box.style.height).toBe('max-content');
	});
});

describe('WidgetHost multi-sensor binding (meta.sensors)', () => {
	// A props-only probe meter: renders the named states the host resolves from the meta's id map.
	const Probe = ({ sensors }: { sensors?: Record<string, SensorState> }) => (
		<div data-testid="probe">
			{sensors?.a?.value?.kind === 'scalar' ? String(sensors.a.value.value) : 'a:–'}/
			{sensors?.b?.value?.kind === 'text' ? sensors.b.value.value : 'b:–'}
		</div>
	);
	registerWidget(
		{
			type: 'test.multi',
			binds: 'none',
			label: 'M',
			sensors: (config) => ({ a: `t.${config.id}.a`, b: `t.${config.id}.b` })
		},
		Probe
	);

	it('derives the id map from the config, subscribes, and passes a live `sensors` prop', () => {
		const hub = createTelemetryHub();
		const instance: WidgetInstance = {
			id: 'w3',
			type: 'test.multi',
			rect: { x: 0, y: 0, w: 100, h: 40 },
			config: { id: 'x' }
		};
		const { getByTestId } = render(<WidgetHost hub={hub} instance={instance} editMode={false} />);
		expect(getByTestId('probe').textContent).toBe('a:–/b:–');

		act(() => {
			hub.ingest({ sensor: 't.x.a', ts_ms: 0, value: { kind: 'scalar', value: 42 } });
			hub.ingest({ sensor: 't.x.b', ts_ms: 0, value: { kind: 'text', value: 'hi' } });
		});
		expect(getByTestId('probe').textContent).toBe('42/hi');
	});
});

describe('WidgetHost selection vs drag (multi-select group drag)', () => {
	// happy-dom doesn't implement pointer capture; stub it so begin()'s setPointerCapture won't throw.
	beforeAll(() => {
		Element.prototype.setPointerCapture = () => undefined;
	});

	const inst: WidgetInstance = {
		id: 'w1',
		type: 'test.json',
		sensor: 'x',
		rect: { x: 0, y: 0, w: 150, h: 44 },
		config: {}
	};
	const overlayOf = (el: HTMLElement) => el.querySelector('.drag-overlay') as HTMLElement;

	it('selects an unselected widget immediately on press', () => {
		const onSelect = vi.fn();
		const hub = createTelemetryHub();
		const { container } = render(
			<WidgetHost hub={hub} instance={inst} editMode onSelect={onSelect} />
		);
		fireEvent.pointerDown(overlayOf(container), {
			button: 0,
			pointerId: 1,
			clientX: 10,
			clientY: 10
		});
		expect(onSelect).toHaveBeenCalledWith({ id: 'w1' });
	});

	it('defers selection when pressing an already-selected widget, so a drag never collapses it', () => {
		const onSelect = vi.fn();
		const onChange = vi.fn();
		const onCommit = vi.fn();
		const hub = createTelemetryHub();
		const { container } = render(
			<WidgetHost
				hub={hub}
				instance={inst}
				editMode
				selected
				onSelect={onSelect}
				onChange={onChange}
				onCommit={onCommit}
			/>
		);
		const overlay = overlayOf(container);
		fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
		expect(onSelect).not.toHaveBeenCalled(); // deferred → the (multi-)selection survives the press
		fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 40, clientY: 10 }); // past DRAG_SLOP
		expect(onChange).toHaveBeenCalled();
		fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 40, clientY: 10 });
		expect(onCommit).toHaveBeenCalled();
		expect(onSelect).not.toHaveBeenCalled(); // a real drag never re-selects → group stays selected
	});

	it('collapses to just this widget on a click (no drag) when it was already selected', () => {
		const onSelect = vi.fn();
		const hub = createTelemetryHub();
		const { container } = render(
			<WidgetHost hub={hub} instance={inst} editMode selected onSelect={onSelect} />
		);
		const overlay = overlayOf(container);
		fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
		fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 10, clientY: 10 }); // no movement
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith({ id: 'w1' });
	});

	it('collapses on press when starting a resize (so resize acts on the single widget, not the group)', () => {
		const onSelect = vi.fn();
		const hub = createTelemetryHub();
		const { container } = render(
			<WidgetHost hub={hub} instance={inst} editMode selected onSelect={onSelect} />
		);
		const handle = container.querySelector('.handle.nw') as HTMLElement;
		fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
		expect(onSelect).toHaveBeenCalledWith({ id: 'w1' });
	});
});

describe('WidgetHost scalar/text/expr value passing', () => {
	const hub = createTelemetryHub();

	it('passes the scalar value + history and bubbles an onControl with the widget identity', () => {
		const onControl = vi.fn();
		const instance: WidgetInstance = {
			id: 'sc',
			type: 'test.scalar',
			sensor: 's',
			rect: { x: 0, y: 0, w: 80, h: 40 },
			config: {}
		};
		const { getByText, getByTestId } = render(
			<WidgetHost hub={hub} instance={instance} editMode={false} onControl={onControl} />
		);
		act(() => {
			hub.ingest({ sensor: 's', ts_ms: 0, value: { kind: 'scalar', value: 7 } });
			hub.ingest({ sensor: 's', ts_ms: 1, value: { kind: 'scalar', value: 9 } });
		});
		expect(getByTestId('scalar').textContent).toBe('9');
		expect(getByTestId('hist').textContent).toBe('7,9');
		fireEvent.click(getByText('act'));
		expect(onControl).toHaveBeenCalledWith({
			id: 'sc',
			sensor: 's',
			domain: 'light',
			service: 'toggle',
			data: { x: 1 }
		});
	});

	it('marks an interactive meta type catchable on the passive overlay', () => {
		const instance: WidgetInstance = {
			id: 'sc2',
			type: 'test.scalar',
			sensor: 's',
			rect: { x: 0, y: 0, w: 80, h: 40 },
			config: {}
		};
		const { container } = render(<WidgetHost hub={hub} instance={instance} editMode={false} />);
		// `interactive` comes from the meta (the instance doesn't set it) → the box catches clicks.
		expect(container.querySelector('.widget')?.classList.contains('catch')).toBe(true);
	});

	it('passes the raw value to a binds:text meter', () => {
		const instance: WidgetInstance = {
			id: 'tx',
			type: 'test.text',
			sensor: 't',
			rect: { x: 0, y: 0, w: 80, h: 40 },
			config: {}
		};
		const { getByTestId } = render(<WidgetHost hub={hub} instance={instance} editMode={false} />);
		act(() => {
			hub.ingest({ sensor: 't', ts_ms: 0, value: { kind: 'text', value: 'hello' } });
		});
		expect(getByTestId('text').textContent).toBe('hello');
	});

	it('strips a formula field’s raw source from the meter config', () => {
		const instance: WidgetInstance = {
			id: 'ex',
			type: 'test.expr',
			rect: { x: 0, y: 0, w: 80, h: 40 },
			config: { foo: 'cpu.total / 2' }
		};
		const { getByTestId } = render(<WidgetHost hub={hub} instance={instance} editMode={false} />);
		// The expr key is removed before reaching the meter (the literal formula must never render).
		expect(getByTestId('expr').textContent).toBe('stripped');
	});

	it('renders a placeholder for an unregistered widget type', () => {
		const instance: WidgetInstance = {
			id: 'missing',
			type: 'nope.unregistered',
			rect: { x: 0, y: 0, w: 80, h: 40 },
			config: {}
		};
		const { getByText } = render(<WidgetHost hub={hub} instance={instance} editMode={false} />);
		expect(getByText('?nope.unregistered')).toBeTruthy();
	});
});

describe('WidgetHost presentation flags', () => {
	const hub = createTelemetryHub();
	const inst: WidgetInstance = {
		id: 'w',
		type: 'test.json',
		sensor: 'x',
		rect: { x: 5, y: 6, w: 150, h: 44 },
		config: {}
	};

	it('flow mode fills the slot (width/height 100%) and adds the flow class', () => {
		const { container } = render(<WidgetHost hub={hub} instance={inst} flow editMode={false} />);
		const box = container.querySelector('.widget') as HTMLElement;
		expect(box.style.width).toBe('100%');
		expect(box.style.height).toBe('100%');
		expect(box.classList.contains('flow')).toBe(true);
	});

	it('applies the multi / highlighted classes', () => {
		const { container } = render(
			<WidgetHost hub={hub} instance={inst} editMode selected multi highlighted />
		);
		const box = container.querySelector('.widget') as HTMLElement;
		expect(box.classList.contains('multi-member')).toBe(true);
		expect(box.classList.contains('hl')).toBe(true);
		expect(box.classList.contains('selected')).toBe(true);
		expect(box.classList.contains('editable')).toBe(true);
	});

	it('reports hover enter/leave through onHover (selectId)', () => {
		const onHover = vi.fn();
		const { container } = render(
			<WidgetHost hub={hub} instance={inst} editMode={false} onHover={onHover} selectId="grp" />
		);
		const box = container.querySelector('.widget') as HTMLElement;
		fireEvent.mouseEnter(box);
		expect(onHover).toHaveBeenLastCalledWith('grp');
		fireEvent.mouseLeave(box);
		expect(onHover).toHaveBeenLastCalledWith(null);
	});
});

describe('WidgetHost context menu', () => {
	const hub = createTelemetryHub();
	const inst: WidgetInstance = {
		id: 'w',
		type: 'test.json',
		sensor: 'x',
		rect: { x: 0, y: 0, w: 150, h: 44 },
		config: {}
	};

	it('selects + opens the context menu in edit mode', () => {
		const onSelect = vi.fn();
		const onContextMenu = vi.fn();
		const { container } = render(
			<WidgetHost
				hub={hub}
				instance={inst}
				editMode
				onSelect={onSelect}
				onContextMenu={onContextMenu}
			/>
		);
		const box = container.querySelector('.widget') as HTMLElement;
		fireEvent.contextMenu(box, { clientX: 12, clientY: 34 });
		expect(onSelect).toHaveBeenCalledWith({ id: 'w' });
		expect(onContextMenu).toHaveBeenCalledWith({ id: 'w', x: 12, y: 34 });
	});

	it('swallows the context menu when suppression is armed (consume-once)', () => {
		const onContextMenu = vi.fn();
		const suppressContextMenu = vi.fn(() => true);
		const { container } = render(
			<WidgetHost
				hub={hub}
				instance={inst}
				editMode
				onContextMenu={onContextMenu}
				suppressContextMenu={suppressContextMenu}
			/>
		);
		fireEvent.contextMenu(container.querySelector('.widget') as HTMLElement);
		expect(suppressContextMenu).toHaveBeenCalled();
		expect(onContextMenu).not.toHaveBeenCalled();
	});

	it('ignores the context menu outside edit mode', () => {
		const onContextMenu = vi.fn();
		const { container } = render(
			<WidgetHost hub={hub} instance={inst} editMode={false} onContextMenu={onContextMenu} />
		);
		fireEvent.contextMenu(container.querySelector('.widget') as HTMLElement);
		expect(onContextMenu).not.toHaveBeenCalled();
	});
});

describe('WidgetHost drag interactions', () => {
	beforeAll(() => {
		Element.prototype.setPointerCapture = () => undefined;
	});
	const hub = createTelemetryHub();
	const inst: WidgetInstance = {
		id: 'w',
		type: 'test.json',
		sensor: 'x',
		rect: { x: 0, y: 0, w: 150, h: 44 },
		config: {}
	};
	const overlayOf = (el: HTMLElement) => el.querySelector('.drag-overlay') as HTMLElement;

	it('in-flow widget ghost-drags then drops (reparent/reorder)', () => {
		const onDragOver = vi.fn();
		const onDrop = vi.fn();
		const { container } = render(
			<WidgetHost
				hub={hub}
				instance={inst}
				editMode
				movable={false}
				flow
				onDragOver={onDragOver}
				onDrop={onDrop}
			/>
		);
		const overlay = overlayOf(container);
		fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
		expect(container.querySelector('.widget')?.classList.contains('dragging')).toBe(true);
		fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 40, clientY: 10 }); // past slop
		expect(onDragOver).toHaveBeenCalledWith({ id: 'w', x: 40, y: 10 });
		fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 40, clientY: 10 });
		expect(onDrop).toHaveBeenCalledWith({ id: 'w', x: 40, y: 10 });
	});

	it('a click (no movement) on a selected in-flow widget re-selects it on pointer-up', () => {
		const onSelect = vi.fn();
		const onDrop = vi.fn();
		const { container } = render(
			<WidgetHost
				hub={hub}
				instance={inst}
				editMode
				selected
				movable={false}
				flow
				onSelect={onSelect}
				onDrop={onDrop}
			/>
		);
		const overlay = overlayOf(container);
		fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
		fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 10, clientY: 10 }); // no movement
		expect(onDrop).not.toHaveBeenCalled();
		expect(onSelect).toHaveBeenCalledWith({ id: 'w' });
	});

	it('does not move below the drag slop (click-to-select only)', () => {
		const onChange = vi.fn();
		const { container } = render(
			<WidgetHost hub={hub} instance={inst} editMode onChange={onChange} />
		);
		const overlay = overlayOf(container);
		fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
		fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 12, clientY: 12 }); // within slop
		expect(onChange).not.toHaveBeenCalled();
	});

	it('right-button free-move never docks and arms context-menu suppression', () => {
		const onChange = vi.fn();
		const onDragOver = vi.fn();
		const onCommit = vi.fn();
		const onSuppressContextMenu = vi.fn();
		const { container } = render(
			<WidgetHost
				hub={hub}
				instance={inst}
				editMode
				onChange={onChange}
				onDragOver={onDragOver}
				onCommit={onCommit}
				onSuppressContextMenu={onSuppressContextMenu}
			/>
		);
		const overlay = overlayOf(container);
		fireEvent.pointerDown(overlay, { button: 2, pointerId: 1, clientX: 10, clientY: 10 });
		fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 40, clientY: 40 });
		// Free-move reports a skipFlow dragOver (Canvas keeps it floating) + a rect change.
		expect(onDragOver).toHaveBeenCalledWith(expect.objectContaining({ id: 'w', skipFlow: true }));
		expect(onChange).toHaveBeenCalled();
		fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 40, clientY: 40 });
		expect(onCommit).toHaveBeenCalledWith({ skipFlow: true });
		expect(onSuppressContextMenu).toHaveBeenCalled();
	});

	it('ignores a middle-button press (reserved for panning) and a right-button on a resize handle', () => {
		const onSelect = vi.fn();
		const onChange = vi.fn();
		const { container } = render(
			<WidgetHost hub={hub} instance={inst} editMode onSelect={onSelect} onChange={onChange} />
		);
		const overlay = overlayOf(container);
		fireEvent.pointerDown(overlay, { button: 1, pointerId: 1, clientX: 10, clientY: 10 }); // middle
		const handle = container.querySelector('.handle.nw') as HTMLElement;
		fireEvent.pointerDown(handle, { button: 2, pointerId: 2, clientX: 10, clientY: 10 }); // right on handle
		expect(onSelect).not.toHaveBeenCalled();
		fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 40, clientY: 40 });
		expect(onChange).not.toHaveBeenCalled(); // no drag began
	});

	it('ignores a press when not in edit mode', () => {
		const onSelect = vi.fn();
		// editMode false → no overlay rendered; press the box itself does nothing draggable.
		const { container } = render(
			<WidgetHost hub={hub} instance={inst} editMode={false} onSelect={onSelect} />
		);
		expect(container.querySelector('.drag-overlay')).toBeNull();
	});

	it('a pointer move/up with no active drag is a no-op', () => {
		const onChange = vi.fn();
		const onCommit = vi.fn();
		const { container } = render(
			<WidgetHost hub={hub} instance={inst} editMode onChange={onChange} onCommit={onCommit} />
		);
		const overlay = overlayOf(container);
		// Move/up without a preceding pointerdown → drag.action is null → both early-return.
		fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 40, clientY: 40 });
		fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 40, clientY: 40 });
		expect(onChange).not.toHaveBeenCalled();
		expect(onCommit).not.toHaveBeenCalled();
	});

	it('resize-handle drag reports a resized rect', () => {
		const onChange = vi.fn();
		const { container } = render(
			<WidgetHost hub={hub} instance={inst} editMode onChange={onChange} />
		);
		const handle = container.querySelector('.handle.se') as HTMLElement;
		fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
		fireEvent.pointerMove(handle, { pointerId: 1, clientX: 40, clientY: 40 });
		expect(onChange).toHaveBeenCalled();
		const last = onChange.mock.calls.at(-1)![0] as { rect: { w: number; h: number } };
		expect(last.rect.w).toBeGreaterThan(150);
	});
});

describe('WidgetHost content-fit measurement (ResizeObserver)', () => {
	let observed: Array<() => void>;
	afterEach(() => {
		// @ts-expect-error -- remove the test double
		delete globalThis.ResizeObserver;
	});

	it('measures the box at natural size and reports it (deduped)', () => {
		observed = [];
		class FakeRO {
			cb: () => void;
			constructor(cb: () => void) {
				this.cb = cb;
			}
			observe() {
				observed.push(this.cb);
			}
			disconnect() {
				// no-op test double
			}
		}
		// @ts-expect-error -- install a test double for the effect's guard
		globalThis.ResizeObserver = FakeRO;

		const hub = createTelemetryHub();
		const instance: WidgetInstance = {
			id: 'cf',
			type: 'test.json',
			sensor: 'x',
			rect: { x: 0, y: 0, w: 150, h: 44 },
			config: {}
		};
		const onMeasure = vi.fn();
		const { container } = render(
			<WidgetHost
				hub={hub}
				instance={instance}
				contentSize
				editMode={false}
				onMeasure={onMeasure}
			/>
		);
		const box = container.querySelector('.widget') as HTMLElement;
		// happy-dom reports 0×0 offsets, but the report still fires once on mount.
		Object.defineProperty(box, 'offsetWidth', { value: 120, configurable: true });
		Object.defineProperty(box, 'offsetHeight', { value: 30, configurable: true });
		// The initial report ran with 0×0 at mount; trigger the observer to pick up the sized box.
		act(() => observed.forEach((cb) => cb()));
		expect(onMeasure).toHaveBeenCalledWith('cf', { w: 120, h: 30 });
		// A second identical observation is deduped (no extra report).
		const calls = onMeasure.mock.calls.length;
		act(() => observed.forEach((cb) => cb()));
		expect(onMeasure.mock.calls.length).toBe(calls);
	});
});
