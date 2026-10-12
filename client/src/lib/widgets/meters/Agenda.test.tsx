import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import Agenda from './Agenda';
import { createTelemetryHub, type SensorSample } from '../../core/telemetry';
import { TelemetryHubContext } from '../telemetryContext';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const list = (rows: unknown[]): SensorSample => ({
	sensor: 'agenda.list',
	ts_ms: 0,
	value: { kind: 'json', value: rows }
});

const renderWith = async (
	hub: ReturnType<typeof createTelemetryHub> | null,
	props: Record<string, unknown> = {}
) => {
	let container!: HTMLElement;
	await act(async () => {
		container = render(
			<TelemetryHubContext.Provider value={hub}>
				<Agenda {...props} />
			</TelemetryHubContext.Provider>
		).container;
	});
	return container;
};

describe('Agenda meter', () => {
	it('groups dates once, labels all-day events, and reports events beyond the row limit', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2027, 0, 1, 13));
		const hub = createTelemetryHub();
		hub.ingestBatch([
			list([
				{ summary: 'Holiday', start: '2027-01-01', allDay: true },
				{ summary: 'Review', start: new Date(2027, 0, 1, 15).toISOString() },
				{ summary: 'Planning', start: new Date(2027, 0, 2, 9).toISOString() },
				{ summary: 'Lunch', start: new Date(2027, 0, 2, 12).toISOString() }
			])
		]);
		const c = await renderWith(hub, { maxRows: 3 });
		expect(Array.from(c.querySelectorAll('.ag-day'), (el) => el.textContent)).toEqual([
			'Today',
			'Tomorrow'
		]);
		expect(c.querySelector('.ag-when')?.textContent).toBe('All day');
		expect(c.querySelector('.ag-more')?.textContent).toBe('+1 more event');
		const capped = await renderWith(hub, { maxRows: 1 });
		expect(capped.querySelector('.ag-more')?.textContent).toBe('+3 more events');
	});
	it('renders upcoming events with friendly when-labels, filtering the past', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2027, 0, 1, 13, 0, 0)); // Fri 1 Jan 2027
		const hub = createTelemetryHub();
		hub.ingestBatch([
			list([
				{ summary: 'Design review', start: new Date(2027, 0, 1, 15, 0).toISOString() },
				{ summary: 'Long gone', start: new Date(2026, 11, 1, 10, 0).toISOString() }
			])
		]);
		const c = await renderWith(hub);
		const rows = c.querySelectorAll('.ag-row');
		expect(rows).toHaveLength(1); // the past event is filtered out
		expect(rows[0].querySelector('.ag-day')?.textContent).toBe('Today');
		expect(rows[0].querySelector('.ag-when')?.textContent).toBe('15:00');
		expect(rows[0].querySelector('.ag-summary')?.textContent).toBe('Design review');
	});

	it('shows an empty state with no upcoming events', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2027, 0, 1, 13, 0, 0));
		const c = await renderWith(createTelemetryHub());
		expect(c.querySelector('.ag-empty')?.textContent).toBe('No upcoming events');
	});

	it('renders a header with the configured title (and applies the accent var)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2027, 0, 1, 13, 0, 0));
		const c = await renderWith(createTelemetryHub(), { title: 'My Calendar', color: 'tomato' });
		expect(c.querySelector('.ag-head .ag-title')?.textContent).toBe('My Calendar');
		expect((c.querySelector('.agenda') as HTMLElement).style.getPropertyValue('--ag-accent')).toBe(
			'tomato'
		);
	});

	it('shows locations alongside the event and preserves the full name in its tooltip', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2027, 0, 1, 13, 0, 0));
		const hub = createTelemetryHub();
		hub.ingestBatch([
			list([
				{
					summary: 'Standup',
					start: new Date(2027, 0, 1, 15, 0).toISOString(),
					location: 'Room 4'
				}
			])
		]);
		const c = await renderWith(hub);
		expect(c.querySelector('.ag-summary')?.getAttribute('title')).toBe('Standup');
		expect(c.querySelector('.ag-location')?.textContent).toBe('Room 4');
	});

	it('renders nothing-but-empty (no subscription) when there is no telemetry hub', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2027, 0, 1, 13, 0, 0));
		const c = await renderWith(null);
		expect(c.querySelector('.ag-empty')?.textContent).toBe('No upcoming events');
	});

	it('skips the re-render when a re-ingest produces an identical event list', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2027, 0, 1, 13, 0, 0));
		const hub = createTelemetryHub();
		const rows = [{ summary: 'Design review', start: new Date(2027, 0, 1, 15, 0).toISOString() }];
		hub.ingestBatch([list(rows)]);
		const c = await renderWith(hub);
		expect(c.querySelectorAll('.ag-row')).toHaveLength(1);
		// Re-ingest the exact same batch: the subscriber fires, read() re-runs, but the parsed list's
		// JSON matches the previous signature so `setEvents` (and a re-render) is skipped.
		await act(async () => {
			hub.ingestBatch([list(rows)]);
		});
		expect(c.querySelectorAll('.ag-row')).toHaveLength(1);
	});

	it('re-evaluates the relative "when" labels on the minute tick', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2027, 0, 1, 13, 0, 0));
		const hub = createTelemetryHub();
		hub.ingestBatch([
			list([{ summary: 'Design review', start: new Date(2027, 0, 1, 15, 0).toISOString() }])
		]);
		const c = await renderWith(hub);
		expect(c.querySelector('.ag-when')?.textContent).toBe('15:00');
		// Jump a day forward and let the minute tick fire — "when" should re-derive relative to `now`.
		vi.setSystemTime(new Date(2027, 0, 2, 13, 0, 0));
		await act(async () => {
			vi.advanceTimersByTime(60_000);
		});
		expect(c.querySelector('.ag-empty')?.textContent).toBe('No upcoming events'); // now in the past
	});
});
