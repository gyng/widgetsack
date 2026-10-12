import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AlertsHost from './AlertsHost';
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});
describe('alerts host', () => {
	it('handles cleared rules and restores a safe snooze default', () => {
		const view = render(<AlertsHost rules={null} previewMode />);
		expect(screen.getByText('All clear')).toBeVisible();
		view.rerender(
			<AlertsHost
				rules="cpu|above|90|Busy"
				snoozeMin={NaN}
				sensors={{ cpu: { value: { kind: 'scalar', value: 95 }, history: [] } }}
			/>
		);
		expect(screen.getByRole('button', { name: 'Snooze Busy' })).toHaveTextContent('15m');
	});
	it('snoozes meeting reminders from the shared agenda subscription', () => {
		vi.useFakeTimers();
		vi.setSystemTime('2026-10-12T10:00:00Z');
		render(
			<AlertsHost
				sensors={{
					'agenda.list': {
						history: [],
						value: { kind: 'json', value: [{ summary: 'Call', start: '2026-10-12T10:05:00Z' }] }
					}
				}}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Snooze Call in 5 minutes' }));
		expect(screen.queryByText('Call in 5 minutes')).toBeNull();
	});
	it('snoozes a triggered rule and makes it visible again at expiry', () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000000);
		const props = {
			rules: 'cpu|above|90|CPU busy',
			snoozeMin: 1,
			sensors: { cpu: { value: { kind: 'scalar' as const, value: 95 }, history: [] } }
		};
		const { rerender } = render(<AlertsHost {...props} />);
		fireEvent.click(screen.getByRole('button', { name: 'Snooze CPU busy' }));
		expect(screen.queryByText('CPU busy')).toBeNull();
		rerender(<AlertsHost {...props} rules="cpu|above|90|New warning" />);
		expect(screen.getByText('New warning')).toBeVisible();
		rerender(<AlertsHost {...props} />);
		act(() => vi.advanceTimersByTime(60000));
		expect(screen.getByText('CPU busy')).toBeVisible();
		rerender(<AlertsHost />);
		expect(screen.queryByText('CPU busy')).toBeNull();
		rerender(<AlertsHost editMode />);
		expect(screen.getByText('All clear')).toBeVisible();
		rerender(<AlertsHost previewMode />);
		expect(screen.getByText('All clear')).toBeVisible();
	});
});
