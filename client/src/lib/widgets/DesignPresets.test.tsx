import { render, screen, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import DesignPresets from './DesignPresets';

it('previews style and density choices, preserves overrides, and applies the selection together', () => {
	const onApply = vi.fn();
	render(
		<DesignPresets
			values={{ '--np-text-body': '22px', '--np-accent': 'orange' }}
			onApply={onApply}
		/>
	);
	for (const name of ['Soft', 'Instrument', 'Transparent']) {
		fireEvent.click(screen.getByRole('combobox', { name: 'Design style' }));
		fireEvent.click(screen.getByText(name, { selector: '.np-select-opt-label' }));
	}
	for (const name of ['Compact', 'Comfortable', 'Large']) {
		fireEvent.click(screen.getByRole('combobox', { name: 'Design density' }));
		fireEvent.click(screen.getByText(name, { selector: '.np-select-opt-label' }));
	}
	fireEvent.click(screen.getByRole('button', { name: 'Apply design preset' }));
	expect(onApply).toHaveBeenLastCalledWith(
		expect.objectContaining({
			'--np-text-body': '22px',
			'--np-design-style': 'transparent',
			'--np-design-density': 'large'
		})
	);
	fireEvent.click(screen.getByRole('checkbox', { name: 'Replace matching token overrides' }));
	fireEvent.click(screen.getByRole('button', { name: 'Apply design preset' }));
	expect(onApply).toHaveBeenLastCalledWith(
		expect.objectContaining({ '--np-text-body': '20px', '--np-accent': 'orange' })
	);
});
