import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { asMeter, getMeta, paletteItems, registry, registerWidget } from './registry';
import type { WidgetMeta } from '../core/widget';
import type { MeterProps } from './meterProps';

// A trivial presentational meter for registration tests. Narrower-than-MeterProps props prove
// `registerWidget`'s generic accepts a correctly-typed component without a cast.
function StubMeter({ value }: { value?: MeterProps['value'] }) {
	return <div data-testid="stub">{String(value ?? '')}</div>;
}

describe('registry', () => {
	it('exposes built-in types in the back-compat `registry` alias', () => {
		// A sample of the built-ins wired in this module.
		expect(typeof registry.gauge).toBe('function');
		expect(typeof registry.button).toBe('function');
		expect(typeof registry.note).toBe('function');
	});

	it('re-exports getMeta resolving a built-in meta', () => {
		const meta = getMeta('gauge');
		expect(meta?.type).toBe('gauge');
	});

	it('asMeter passes the component through (identity adapter)', () => {
		expect(asMeter(StubMeter)).toBe(StubMeter as unknown);
	});

	it('paletteItems lists registered metas that have a component', () => {
		const items = paletteItems();
		const types = items.map((i) => i.type);
		// Built-ins with components show up...
		expect(types).toContain('gauge');
		expect(types).toContain('button');
		// ...and each item carries a label (falls back to the type when meta has no label).
		const gauge = items.find((i) => i.type === 'gauge')!;
		expect(typeof gauge.label).toBe('string');
		expect(gauge.label.length).toBeGreaterThan(0);
	});

	it('registerWidget registers the meta + component and surfaces it in the palette', () => {
		const meta: WidgetMeta = {
			type: 'test-plugin-widget',
			label: 'Test Plugin Widget',
			category: 'Test Pack'
		};
		registerWidget(meta, StubMeter);

		// Component attached to the registry under its type.
		expect(typeof registry['test-plugin-widget']).toBe('function');
		// Meta resolvable via the re-exported getMeta.
		expect(getMeta('test-plugin-widget')?.label).toBe('Test Plugin Widget');

		// It now appears in the palette with its label + category.
		const item = paletteItems().find((i) => i.type === 'test-plugin-widget');
		expect(item).toEqual({
			type: 'test-plugin-widget',
			label: 'Test Plugin Widget',
			category: 'Test Pack'
		});

		// And the registered component renders as the meter it was given.
		const Comp = registry['test-plugin-widget'];
		const { getByTestId } = render(<Comp value={42} />);
		expect(getByTestId('stub').textContent).toBe('42');
	});

	it('paletteItems falls back to the type as label when meta has none', () => {
		registerWidget({ type: 'test-nolabel-widget' }, StubMeter);
		const item = paletteItems().find((i) => i.type === 'test-nolabel-widget')!;
		// No label on the meta → label defaults to the type; no category → undefined.
		expect(item.label).toBe('test-nolabel-widget');
		expect(item.category).toBeUndefined();
	});
});
