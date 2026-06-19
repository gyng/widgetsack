import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ConditionEditor from './ConditionEditor';
import type { Condition } from '../core/condition';

describe('ConditionEditor', () => {
	it('enabling emits a default appOpen condition; disabling clears it', () => {
		const onChange = vi.fn();
		const { rerender } = render(<ConditionEditor onChange={onChange} />);
		fireEvent.click(screen.getByRole('checkbox', { name: /Conditional/i }));
		expect(onChange).toHaveBeenCalledWith({ kind: 'appOpen' });

		onChange.mockClear();
		rerender(<ConditionEditor value={{ kind: 'appOpen' }} onChange={onChange} />);
		fireEvent.click(screen.getByRole('checkbox', { name: /Conditional/i }));
		expect(onChange).toHaveBeenCalledWith(undefined);
	});

	it('commits an exe match on blur (not per keystroke)', () => {
		const onChange = vi.fn();
		render(<ConditionEditor value={{ kind: 'appOpen' }} onChange={onChange} />);
		const exe = screen.getByLabelText(/exe/i);
		fireEvent.change(exe, { target: { value: 'spotify.exe' } });
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.blur(exe);
		expect(onChange).toHaveBeenCalledWith({ kind: 'appOpen', matchExe: 'spotify.exe' });
	});

	it('clears the exe match to undefined when blurred empty', () => {
		const onChange = vi.fn();
		render(<ConditionEditor value={{ kind: 'appOpen', matchExe: 'x.exe' }} onChange={onChange} />);
		const exe = screen.getByLabelText(/exe/i);
		fireEvent.change(exe, { target: { value: '   ' } });
		fireEvent.blur(exe);
		expect(onChange).toHaveBeenCalledWith({ kind: 'appOpen', matchExe: undefined });
	});

	it('switching to a sensor condition seeds a sensor shape, keeping negate', () => {
		const onChange = vi.fn();
		const value: Condition = { kind: 'appOpen', matchExe: 'a.exe', negate: true };
		render(<ConditionEditor value={value} sensors={['cpu.total']} onChange={onChange} />);
		// The kind picker is a Downshift listbox (a button + menu), not a native <select>: open it, pick.
		fireEvent.click(screen.getByLabelText('condition type'));
		fireEvent.click(screen.getByText('a sensor value'));
		expect(onChange).toHaveBeenCalledWith({
			kind: 'sensor',
			sensorId: 'cpu.total',
			op: '>',
			value: '',
			negate: true
		});
	});

	it('renders sensor fields and commits the value on blur', () => {
		const onChange = vi.fn();
		const value: Condition = { kind: 'sensor', sensorId: 'cpu.total', op: '>', value: '' };
		render(<ConditionEditor value={value} sensors={['cpu.total']} onChange={onChange} />);
		const val = screen.getByLabelText('value');
		fireEvent.change(val, { target: { value: '80' } });
		fireEvent.blur(val);
		expect(onChange).toHaveBeenCalledWith({
			kind: 'sensor',
			sensorId: 'cpu.total',
			op: '>',
			value: '80'
		});
	});

	it('does not switch to a sensor condition when no sensors exist (avoids losing the condition)', () => {
		const onChange = vi.fn();
		render(
			<ConditionEditor
				value={{ kind: 'appOpen', matchExe: 'a.exe' }}
				sensors={[]}
				onChange={onChange}
			/>
		);
		fireEvent.click(screen.getByLabelText('condition type'));
		fireEvent.click(screen.getByText('a sensor value'));
		// Never emits a sensor condition with an empty sensorId (which would be dropped on reload).
		for (const call of onChange.mock.calls) expect(call[0]?.kind).not.toBe('sensor');
	});

	it('commits a window-title match on blur, and clears it to undefined when emptied', () => {
		const onChange = vi.fn();
		const { rerender } = render(
			<ConditionEditor value={{ kind: 'appOpen' }} onChange={onChange} />
		);
		const title = screen.getByLabelText(/window title/i);
		fireEvent.change(title, { target: { value: '  YouTube  ' } });
		fireEvent.blur(title);
		expect(onChange).toHaveBeenCalledWith({ kind: 'appOpen', matchTitle: 'YouTube' });

		onChange.mockClear();
		rerender(
			<ConditionEditor value={{ kind: 'appOpen', matchTitle: 'YouTube' }} onChange={onChange} />
		);
		const title2 = screen.getByLabelText(/window title/i);
		fireEvent.change(title2, { target: { value: '   ' } });
		fireEvent.blur(title2);
		expect(onChange).toHaveBeenCalledWith({ kind: 'appOpen', matchTitle: undefined });
	});

	it('commits a window-class match on blur', () => {
		const onChange = vi.fn();
		render(<ConditionEditor value={{ kind: 'appOpen' }} onChange={onChange} />);
		const cls = screen.getByLabelText(/window class/i);
		fireEvent.change(cls, { target: { value: 'Chrome_WidgetWin_1' } });
		fireEvent.blur(cls);
		expect(onChange).toHaveBeenCalledWith({ kind: 'appOpen', matchClass: 'Chrome_WidgetWin_1' });

		onChange.mockClear();
		fireEvent.change(cls, { target: { value: '  ' } });
		fireEvent.blur(cls);
		expect(onChange).toHaveBeenCalledWith({ kind: 'appOpen', matchClass: undefined });
	});

	it('picks a sensor id and an operator', () => {
		const onChange = vi.fn();
		const value: Condition = { kind: 'sensor', sensorId: 'cpu.total', op: '>', value: '' };
		render(
			<ConditionEditor value={value} sensors={['cpu.total', 'gpu.total']} onChange={onChange} />
		);
		fireEvent.click(screen.getByLabelText('condition sensor'));
		fireEvent.click(screen.getByText('gpu.total'));
		expect(onChange).toHaveBeenCalledWith({ ...value, sensorId: 'gpu.total' });

		onChange.mockClear();
		fireEvent.click(screen.getByLabelText('condition operator'));
		fireEvent.click(screen.getByText('≥ at least'));
		expect(onChange).toHaveBeenCalledWith({ ...value, op: '>=' });
	});

	it('toggles negate on, then off (clearing it to undefined)', () => {
		const onChange = vi.fn();
		const { rerender } = render(
			<ConditionEditor value={{ kind: 'appOpen', matchExe: 'a.exe' }} onChange={onChange} />
		);
		fireEvent.click(screen.getByRole('checkbox', { name: /Invert/i }));
		expect(onChange).toHaveBeenCalledWith({ kind: 'appOpen', matchExe: 'a.exe', negate: true });

		onChange.mockClear();
		rerender(
			<ConditionEditor
				value={{ kind: 'appOpen', matchExe: 'a.exe', negate: true }}
				onChange={onChange}
			/>
		);
		fireEvent.click(screen.getByRole('checkbox', { name: /Invert/i }));
		expect(onChange).toHaveBeenCalledWith({
			kind: 'appOpen',
			matchExe: 'a.exe',
			negate: undefined
		});
	});

	it('applies the dirty class when dirty is set', () => {
		const { container } = render(<ConditionEditor onChange={() => undefined} dirty />);
		expect(container.querySelector('.cond-editor')!.classList.contains('dirty')).toBe(true);
	});
});
