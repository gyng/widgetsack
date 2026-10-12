import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import CommandHost from './CommandHost';
beforeEach(() => {
	invoke.mockReset();
});
it('never runs on mount and requires a configured command', () => {
	render(<CommandHost />);
	expect(invoke).not.toHaveBeenCalled();
	expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
});
it('runs explicitly, prevents overlap, and shows exit code, bounded output and errors', async () => {
	let finish!: (value: unknown) => void;
	invoke.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	render(<CommandHost command="Get-Date" label="Date" />);
	const runButton = screen.getByRole('button', { name: 'Run' });
	act(() => {
		runButton.click();
		runButton.click();
	});
	expect(invoke).toHaveBeenCalledTimes(1);
	expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled();
	expect(invoke).toHaveBeenCalledWith('run_widget_command', { command: 'Get-Date' });
	await act(async () => finish({ stdout: 'Today', stderr: 'Oops', exitCode: 1, truncated: true }));
	expect(screen.getByText('Today')).toBeTruthy();
	expect(screen.getByText('Oops')).toBeTruthy();
	expect(screen.getByText('Exit 1 · Output truncated')).toBeTruthy();
	invoke.mockRejectedValue('Command timed out');
	await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run' })));
	expect(screen.getByRole('alert').textContent).toBe('Command timed out');
});
it('handles empty successful output and completion after disposal', async () => {
	invoke.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, truncated: false });
	const view = render(<CommandHost command="exit 0" />);
	await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run' })));
	expect(screen.getByText('Exit 0')).toBeTruthy();
	let reject!: (error: unknown) => void;
	invoke.mockImplementation(
		() =>
			new Promise((_r, r) => {
				reject = r;
			})
	);
	fireEvent.click(screen.getByRole('button', { name: 'Run' }));
	view.unmount();
	await act(async () => reject('late failure'));
});

it('handles an unavailable exit status and ignores late successful completion', async () => {
	invoke.mockResolvedValue({ stdout: 'signal', stderr: '', exitCode: null, truncated: false });
	const view = render(<CommandHost command="Get-Date" />);
	await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run' })));
	expect(screen.getByText('Exit unknown')).toBeTruthy();
	let finish!: (value: unknown) => void;
	invoke.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	fireEvent.click(screen.getByRole('button', { name: 'Run' }));
	view.unmount();
	await act(async () => finish({ stdout: 'late', stderr: '', exitCode: 0, truncated: false }));
});
