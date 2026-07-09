import { describe, it, expect } from 'vitest';
import { container } from '../../core/layoutTree';
import { containerAlignControls } from './alignControls';

describe('containerAlignControls', () => {
	it('row: Horizontal ← justify (with distribute), Vertical ← align (with fill)', () => {
		const [h, v] = containerAlignControls(container('r', 'row', [], { justify: 'end' }));
		expect(h).toMatchObject({ axis: 'horizontal', field: 'justify', value: 'end' });
		expect(h.options.map((o) => o.value)).toEqual(['start', 'center', 'end', 'between', 'around']);
		// horizontal labels are left/right
		expect(h.options.find((o) => o.value === 'start')?.label).toBe('left');
		expect(h.options.find((o) => o.value === 'end')?.label).toBe('right');
		expect(v).toMatchObject({ axis: 'vertical', field: 'align', value: 'stretch' });
		expect(v.options.map((o) => o.value)).toEqual(['start', 'center', 'end', 'stretch']);
		expect(v.options.find((o) => o.value === 'start')?.label).toBe('top');
		expect(v.options.find((o) => o.value === 'stretch')?.label).toBe('fill');
	});

	it('col: Horizontal ← align, Vertical ← justify', () => {
		const [h, v] = containerAlignControls(container('c', 'col', [], { align: 'center' }));
		expect(h).toMatchObject({ axis: 'horizontal', field: 'align', value: 'center' });
		expect(h.options.map((o) => o.value)).toEqual(['start', 'center', 'end', 'stretch']);
		expect(v).toMatchObject({ axis: 'vertical', field: 'justify', value: 'start' });
		expect(v.options.find((o) => o.value === 'around')?.label).toBe('space-around');
	});

	it('grid: a single Cell-alignment control on `align` with diagonal labels', () => {
		const controls = containerAlignControls(container('g', 'grid', [], { cols: 2 }));
		expect(controls).toHaveLength(1);
		expect(controls[0]).toMatchObject({ axis: 'cell', field: 'align', value: 'stretch' });
		expect(controls[0].options.find((o) => o.value === 'start')?.label).toBe('top-left');
		expect(controls[0].options.find((o) => o.value === 'stretch')?.label).toBe('fill cells');
	});

	it('defaults: align → stretch, justify → start', () => {
		const [h, v] = containerAlignControls(container('r', 'row', []));
		expect(h.value).toBe('start'); // justify default
		expect(v.value).toBe('stretch'); // align default
	});

	it('col defaults mirror the row ones on swapped axes', () => {
		const [h, v] = containerAlignControls(container('c', 'col', []));
		expect(h.value).toBe('stretch'); // align default (cross axis)
		expect(v.value).toBe('start'); // justify default (main axis)
	});
});
