import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import MacroEditor from './MacroEditor';
import type { Macro } from '../core/macro';

describe('MacroEditor', () => {
	it('shows an empty hint and adds a blank action via "+ action"', () => {
		const onChange = vi.fn();
		const { getByText } = render(<MacroEditor value={[]} onChange={onChange} />);
		expect(() => getByText(/inert until you add one/i)).not.toThrow();
		fireEvent.click(getByText('+ action'));
		expect(onChange).toHaveBeenCalledWith([{ domain: '', service: '' }]);
	});

	it('edits the domain and service of a row', () => {
		const onChange = vi.fn();
		const value: Macro = [{ domain: 'light', service: 'toggle' }];
		const { getByPlaceholderText } = render(<MacroEditor value={value} onChange={onChange} />);
		fireEvent.change(getByPlaceholderText('domain'), { target: { value: 'switch' } });
		expect(onChange).toHaveBeenLastCalledWith([{ domain: 'switch', service: 'toggle' }]);
		fireEvent.change(getByPlaceholderText('service'), { target: { value: 'turn_on' } });
		expect(onChange).toHaveBeenLastCalledWith([{ domain: 'light', service: 'turn_on' }]);
	});

	it('commits a JSON data object on blur', () => {
		const onChange = vi.fn();
		const value: Macro = [{ domain: 'light', service: 'toggle' }];
		const { getByPlaceholderText } = render(<MacroEditor value={value} onChange={onChange} />);
		const data = getByPlaceholderText(/data \(JSON\)/i);
		fireEvent.change(data, { target: { value: '{"entity_id":"light.kitchen"}' } });
		fireEvent.blur(data);
		expect(onChange).toHaveBeenCalledWith([
			{ domain: 'light', service: 'toggle', data: { entity_id: 'light.kitchen' } }
		]);
	});

	it('flags invalid JSON data and does not commit it', () => {
		const onChange = vi.fn();
		const value: Macro = [{ domain: 'light', service: 'toggle' }];
		const { getByPlaceholderText } = render(<MacroEditor value={value} onChange={onChange} />);
		const data = getByPlaceholderText(/data \(JSON\)/i);
		fireEvent.change(data, { target: { value: '{not json' } });
		fireEvent.blur(data);
		expect(onChange).not.toHaveBeenCalled();
		expect(data.className).toContain('error');
	});

	it('removes a row', () => {
		const onChange = vi.fn();
		const value: Macro = [
			{ domain: 'light', service: 'toggle' },
			{ domain: 'media', service: 'pause' }
		];
		const { getAllByLabelText } = render(<MacroEditor value={value} onChange={onChange} />);
		fireEvent.click(getAllByLabelText('Remove action')[0]);
		expect(onChange).toHaveBeenCalledWith([{ domain: 'media', service: 'pause' }]);
	});

	it('reorders rows (move down), with the ends disabled', () => {
		const onChange = vi.fn();
		const value: Macro = [
			{ domain: 'light', service: 'toggle' },
			{ domain: 'media', service: 'pause' }
		];
		const { getAllByTitle } = render(<MacroEditor value={value} onChange={onChange} />);
		const up = getAllByTitle('Move up') as HTMLButtonElement[];
		const down = getAllByTitle('Move down') as HTMLButtonElement[];
		expect(up[0].disabled).toBe(true); // first row can't move up
		expect(down[1].disabled).toBe(true); // last row can't move down
		fireEvent.click(down[0]);
		expect(onChange).toHaveBeenCalledWith([
			{ domain: 'media', service: 'pause' },
			{ domain: 'light', service: 'toggle' }
		]);
	});

	it('commits the entity picker into data.entity_id on blur', () => {
		const onChange = vi.fn();
		const value: Macro = [{ domain: 'light', service: 'toggle' }];
		const { getByPlaceholderText } = render(
			<MacroEditor value={value} onChange={onChange} entities={['light.kitchen', 'light.lounge']} />
		);
		const entity = getByPlaceholderText(/entity \(optional\)/i);
		fireEvent.change(entity, { target: { value: 'light.kitchen' } });
		fireEvent.blur(entity);
		expect(onChange).toHaveBeenCalledWith([
			{ domain: 'light', service: 'toggle', data: { entity_id: 'light.kitchen' } }
		]);
	});

	it('wires domain/service/entity datalists (autocomplete)', () => {
		const value: Macro = [{ domain: '', service: '' }];
		const { container, getByPlaceholderText } = render(
			<MacroEditor value={value} onChange={vi.fn()} entities={['light.kitchen']} />
		);
		expect(getByPlaceholderText('domain').getAttribute('list')).toBe('macro-domains');
		expect(getByPlaceholderText('service').getAttribute('list')).toBe('macro-services');
		expect(container.querySelector('#macro-entities option')?.getAttribute('value')).toBe(
			'light.kitchen'
		);
	});
});
