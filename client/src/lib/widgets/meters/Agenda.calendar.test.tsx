import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Agenda from './Agenda';
import AlertsHost from '../AlertsHost';
import { createTelemetryHub } from '../../core/telemetry';
import { TelemetryHubContext } from '../telemetryContext';
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});
function setup() {
	vi.useFakeTimers();
	vi.setSystemTime('2026-10-14T00:00:00Z');
	const hub = createTelemetryHub();
	hub.ingestBatch([
		{
			sensor: 'agenda.parse',
			ts_ms: 1,
			value: { kind: 'json', value: { pending: true, warnings: [] } }
		}
	]);
	render(
		<TelemetryHubContext.Provider value={hub}>
			<Agenda />
		</TelemetryHubContext.Provider>
	);
	return hub;
}
describe('calendar feedback', () => {
	it('shows pending data and partial warnings with the usable events', () => {
		const hub = setup();
		expect(screen.getByText('Reading calendar…')).toBeVisible();
		act(() =>
			hub.ingestBatch([
				{
					sensor: 'agenda.list',
					ts_ms: 2,
					value: {
						kind: 'json',
						value: [{ summary: 'Call', start: '2026-10-14T09:00:00Z', allDay: false, location: '' }]
					}
				},
				{
					sensor: 'agenda.parse',
					ts_ms: 2,
					value: {
						kind: 'json',
						value: { pending: false, warnings: ['Some calendar events could not be read.'] }
					}
				}
			])
		);
		expect(screen.getByText('Call')).toBeVisible();
		expect(screen.getByRole('status')).toHaveTextContent('Some calendar events could not be read.');
	});
	it('shows unavailable rather than an empty successful calendar on failure', () => {
		const hub = setup();
		act(() =>
			hub.ingestBatch([
				{
					sensor: 'agenda.parse',
					ts_ms: 2,
					value: {
						kind: 'json',
						value: { pending: false, warnings: ['The calendar could not be read.'] }
					}
				}
			])
		);
		expect(screen.getByText('Calendar unavailable')).toBeVisible();
		expect(screen.queryByText('No upcoming events')).toBeNull();
	});
	it('keeps reminder loading and failure visible instead of claiming all clear', () => {
		const { rerender } = render(
			<AlertsHost
				sensors={{
					'agenda.parse': {
						history: [],
						value: { kind: 'json', value: { pending: true, warnings: [] } }
					}
				}}
			/>
		);
		expect(screen.getByText('Reading calendar…')).toBeVisible();
		expect(screen.queryByText('All clear')).toBeNull();
		rerender(
			<AlertsHost
				sensors={{
					'agenda.parse': {
						history: [],
						value: {
							kind: 'json',
							value: { pending: false, warnings: ['The calendar could not be read.'] }
						}
					}
				}}
			/>
		);
		expect(screen.getByRole('status')).toHaveTextContent('The calendar could not be read.');
		expect(screen.queryByText('All clear')).toBeNull();
	});
});
