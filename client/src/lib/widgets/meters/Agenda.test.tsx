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

const renderWith = async (hub: ReturnType<typeof createTelemetryHub>) => {
	let container!: HTMLElement;
	await act(async () => {
		container = render(
			<TelemetryHubContext.Provider value={hub}>
				<Agenda />
			</TelemetryHubContext.Provider>
		).container;
	});
	return container;
};

describe('Agenda meter', () => {
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
		expect(rows[0].querySelector('.ag-when')?.textContent).toBe('Today 15:00');
		expect(rows[0].querySelector('.ag-summary')?.textContent).toBe('Design review');
	});

	it('shows an empty state with no upcoming events', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2027, 0, 1, 13, 0, 0));
		const c = await renderWith(createTelemetryHub());
		expect(c.querySelector('.ag-empty')?.textContent).toBe('No upcoming events');
	});
});
