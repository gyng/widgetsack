import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import HaInput from './HaInput';

afterEach(cleanup);

describe('HaInput infers the control from the entity domain', () => {
	it('input_boolean → a toggle that emits ha toggle and reflects on/off', () => {
		const onControl = vi.fn();
		const { container } = render(
			<HaInput value={{ entity_id: 'input_boolean.x', state: 'on' }} onControl={onControl} />
		);
		const btn = container.querySelector('[data-part="toggle"]') as HTMLButtonElement;
		expect(btn.textContent).toBe('ON');
		expect(btn.getAttribute('aria-pressed')).toBe('true');
		expect(btn.className).toContain('on');
		fireEvent.click(btn);
		expect(onControl).toHaveBeenCalledWith({ domain: 'input_boolean', service: 'toggle' });
	});

	it('input_boolean off renders OFF and is not pressed', () => {
		const { container } = render(
			<HaInput value={{ entity_id: 'input_boolean.x', state: 'off' }} />
		);
		const btn = container.querySelector('[data-part="toggle"]') as HTMLButtonElement;
		expect(btn.textContent).toBe('OFF');
		expect(btn.getAttribute('aria-pressed')).toBe('false');
		expect(btn.className).not.toContain(' on');
	});

	it('input_button → a press button emitting the press service', () => {
		const onControl = vi.fn();
		const { container } = render(
			<HaInput value={{ entity_id: 'input_button.doit' }} onControl={onControl} />
		);
		fireEvent.click(container.querySelector('[data-part="press"]') as HTMLButtonElement);
		expect(onControl).toHaveBeenCalledWith({ domain: 'input_button', service: 'press' });
	});

	it('input_select → a dropdown of options emitting select_option', () => {
		const onControl = vi.fn();
		const { container } = render(
			<HaInput
				value={{
					entity_id: 'input_select.mode',
					state: 'a',
					attributes: { options: ['a', 'b', 'c'] }
				}}
				onControl={onControl}
			/>
		);
		const sel = container.querySelector('[data-part="select"]') as HTMLSelectElement;
		expect(Array.from(sel.options).map((o) => o.value)).toEqual(['a', 'b', 'c']);
		expect(sel.value).toBe('a');
		fireEvent.change(sel, { target: { value: 'c' } });
		expect(onControl).toHaveBeenCalledWith({
			domain: 'input_select',
			service: 'select_option',
			data: { option: 'c' }
		});
	});

	it('input_select with no options attribute renders an empty dropdown', () => {
		const { container } = render(<HaInput value={{ entity_id: 'input_select.mode' }} />);
		const sel = container.querySelector('[data-part="select"]') as HTMLSelectElement;
		expect(sel.options).toHaveLength(0);
	});

	it('input_number → a range slider clamped to the helper min/max emitting set_value', () => {
		const onControl = vi.fn();
		const { container } = render(
			<HaInput
				value={{
					entity_id: 'input_number.temp',
					state: '21',
					attributes: { min: 10, max: 30, step: 0.5 }
				}}
				onControl={onControl}
			/>
		);
		const range = container.querySelector('[data-part="number"]') as HTMLInputElement;
		expect(range.min).toBe('10');
		expect(range.max).toBe('30');
		expect(range.step).toBe('0.5');
		expect(range.value).toBe('21');
		// The current numeric state is also shown as text.
		expect(container.querySelector('.hi-num')?.textContent).toBe('21');
		fireEvent.change(range, { target: { value: '25' } });
		expect(onControl).toHaveBeenCalledWith({
			domain: 'input_number',
			service: 'set_value',
			data: { value: 25 }
		});
	});

	it('input_number with a non-finite state falls back to the min for the slider value', () => {
		const { container } = render(
			<HaInput
				value={{ entity_id: 'input_number.temp', state: '', attributes: { min: 5, max: 9 } }}
			/>
		);
		const range = container.querySelector('[data-part="number"]') as HTMLInputElement;
		expect(range.value).toBe('5');
	});

	it('input_number with no min/max attributes defaults the slider value to 0', () => {
		const { container } = render(
			<HaInput value={{ entity_id: 'input_number.temp', state: 'NaN' }} />
		);
		const range = container.querySelector('[data-part="number"]') as HTMLInputElement;
		expect(range.min).toBe('0');
		expect(range.max).toBe('100');
		expect(range.value).toBe('0');
	});

	it('input_text → a text field emitting set_value on Enter and on blur', () => {
		const onControl = vi.fn();
		const { container } = render(
			<HaInput value={{ entity_id: 'input_text.note', state: 'hi' }} onControl={onControl} />
		);
		const text = container.querySelector('[data-part="text"]') as HTMLInputElement;
		expect(text.defaultValue).toBe('hi');
		fireEvent.change(text, { target: { value: 'typed' } });
		// A non-Enter key does nothing.
		fireEvent.keyDown(text, { key: 'a' });
		expect(onControl).not.toHaveBeenCalled();
		fireEvent.keyDown(text, { key: 'Enter' });
		expect(onControl).toHaveBeenLastCalledWith({
			domain: 'input_text',
			service: 'set_value',
			data: { value: 'typed' }
		});
		fireEvent.blur(text);
		expect(onControl).toHaveBeenCalledTimes(2);
	});

	it('an unknown / missing domain falls back to a plain value display', () => {
		const { container } = render(<HaInput value={{ entity_id: 'sensor.x', state: '42' }} />);
		expect(container.querySelector('[data-part="value"]')?.textContent).toBe('42');
		expect(container.querySelector('[data-part="toggle"]')).toBeNull();
	});

	it('uses an explicit label, then the friendly_name attribute, then "Input"', () => {
		const explicit = render(<HaInput value={{ entity_id: 'input_boolean.x' }} label="My Switch" />);
		expect(explicit.container.querySelector('[data-part="label"]')?.textContent).toBe('My Switch');
		explicit.unmount();

		const friendly = render(
			<HaInput value={{ entity_id: 'input_boolean.x', attributes: { friendly_name: 'Lamp' } }} />
		);
		expect(friendly.container.querySelector('[data-part="label"]')?.textContent).toBe('Lamp');
		friendly.unmount();

		const fallback = render(<HaInput value={null} />);
		expect(fallback.container.querySelector('[data-part="label"]')?.textContent).toBe('Input');
	});

	it('does not throw when onControl is omitted', () => {
		const { container } = render(<HaInput value={{ entity_id: 'input_button.x' }} />);
		expect(() =>
			fireEvent.click(container.querySelector('[data-part="press"]') as HTMLButtonElement)
		).not.toThrow();
	});
});
