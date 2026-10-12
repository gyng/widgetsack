import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { container, group, leaf, type Group } from '../core/layoutTree';
import { createWidget } from '../core/widget';
import GroupChartOptions from './GroupChartOptions';
const library = { version: 1 as const, defs: [] };
it('shows mixed chart state and enables or disables the whole group', () => {
	const first = createWidget('sparkline', 'first');
	first.config.smooth = true;
	const unit = group(
		'network',
		{ w: 170, h: 130 },
		container('root', 'col', [leaf(first), leaf(createWidget('sparkline', 'second'))])
	);
	const onChange = vi.fn();
	const view = render(<GroupChartOptions group={unit} library={library} onChange={onChange} />);
	const toggle = view.getByRole('checkbox', { name: 'Smooth charts' });
	expect(toggle).toHaveAttribute('aria-checked', 'mixed');
	expect(toggle).toHaveProperty('indeterminate', true);
	fireEvent.click(toggle);
	const changed = onChange.mock.calls[0][0] as Group;
	view.rerender(<GroupChartOptions group={changed} library={library} onChange={onChange} />);
	expect(toggle).toBeChecked();
	expect(toggle).toHaveProperty('indeterminate', false);
	fireEvent.click(toggle);
	expect(onChange.mock.calls[1][0]).toHaveProperty('child.children.0.unit.config.smooth', false);
	view.unmount();
});
it('omits the control when a group has no charts and explains copies of linked widgets', () => {
	const clock = group('clock', { w: 100, h: 100 }, leaf(createWidget('clock', 'clock')));
	const view = render(<GroupChartOptions group={clock} library={library} onChange={vi.fn()} />);
	expect(view.queryByRole('checkbox')).toBeNull();
	const def = {
		id: 'system',
		name: 'System',
		size: { w: 100, h: 100 },
		child: leaf(createWidget('cpu', 'cpu'))
	};
	view.rerender(
		<GroupChartOptions
			group={group('system', def.size, def.child, { def: def.id })}
			library={{ version: 1, defs: [def] }}
			onChange={vi.fn()}
		/>
	);
	expect(view.getByText(/creates a separate copy/)).toBeTruthy();
});
