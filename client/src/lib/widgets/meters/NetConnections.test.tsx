import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import NetConnections from './NetConnections';
import { createTelemetryHub, type SensorSample } from '../../core/telemetry';
import { TelemetryHubContext } from '../telemetryContext';
import type { ProcConn } from '../../core/netconn';

afterEach(cleanup);

const scalar = (sensor: string, value: number): SensorSample => ({
	sensor,
	ts_ms: 0,
	value: { kind: 'scalar', value }
});
const list = (rows: Partial<ProcConn>[]): SensorSample => ({
	sensor: 'net.conn.list',
	ts_ms: 0,
	value: { kind: 'json', value: rows }
});

const renderWith = async (hub: ReturnType<typeof createTelemetryHub>, props = {}) => {
	let container!: HTMLElement;
	await act(async () => {
		container = render(
			<TelemetryHubContext.Provider value={hub}>
				<NetConnections {...props} />
			</TelemetryHubContext.Provider>
		).container;
	});
	return container;
};

describe('NetConnections meter', () => {
	it('renders the totals summary and a row per talking process, public first', async () => {
		const hub = createTelemetryHub();
		hub.ingestBatch([
			scalar('net.conn.established', 5),
			scalar('net.conn.public', 3),
			scalar('net.conn.listening', 2),
			list([
				{ proc: 'chrome.exe', pid: 100, established: 4, public: 3, remotes: ['8.8.8.8:443'] },
				{ proc: 'code.exe', pid: 200, established: 1, public: 0 }
			])
		]);
		const c = await renderWith(hub);
		expect(c.querySelector('[data-part="summary"]')?.textContent).toContain('5');
		expect(c.querySelector('.nc-pub-total')?.textContent).toBe('3');
		const rows = c.querySelectorAll('.nc-row');
		expect(rows).toHaveLength(2);
		expect(rows[0].querySelector('.nc-proc')?.textContent).toBe('chrome.exe');
		expect(rows[0].getAttribute('data-level')).toBe('public');
		expect(rows[0].querySelector('.nc-pub')?.textContent).toContain('3');
		expect(rows[1].getAttribute('data-level')).toBe('local'); // established, no public
	});

	it('hides listener-only processes unless showListening is set', async () => {
		const hub = createTelemetryHub();
		hub.ingestBatch([
			list([
				{ proc: 'svchost.exe', pid: 9, established: 0, listening: 1 },
				{ proc: 'app.exe', pid: 10, established: 1, public: 1, remotes: ['1.1.1.1:443'] }
			])
		]);

		const hidden = await renderWith(hub);
		expect(hidden.querySelectorAll('.nc-row')).toHaveLength(1);
		expect(hidden.querySelector('.nc-proc')?.textContent).toBe('app.exe');
		cleanup();

		const shown = await renderWith(hub, { showListening: true });
		expect(shown.querySelectorAll('.nc-row')).toHaveLength(2);
	});

	it('shows a dash before any connection sample arrives', async () => {
		const hub = createTelemetryHub();
		const c = await renderWith(hub);
		expect(c.querySelector('.nc-empty')?.textContent).toBe('—');
	});
});
