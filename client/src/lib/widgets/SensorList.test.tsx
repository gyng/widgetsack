import { describe, expect, it } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import SensorList from './SensorList';
import { createTelemetryHub, type TelemetryHub } from '../core/telemetry';
import type { SensorActivity } from '../core/sensorActivity';

// SensorList rows subscribe live via useSensor; ingest happens outside React, so wrap in act().
function ingest(hub: TelemetryHub, id: string, value: number | string): void {
	act(() => {
		hub.ingest({
			sensor: id,
			ts_ms: 0,
			value: typeof value === 'number' ? { kind: 'scalar', value } : { kind: 'text', value }
		});
	});
}

describe('SensorList — flat (no filter)', () => {
	it('renders one row per id with its live value, ticking in place', () => {
		const hub = createTelemetryHub();
		const ids = ['mqtt.alpha', 'mqtt.beta'];
		const { container, getByTitle } = render(<SensorList hub={hub} ids={ids} />);
		// Both ids render as rows (title carries the id); value shows the em-dash placeholder until a sample.
		expect(getByTitle('mqtt.alpha')).toBeTruthy();
		expect(getByTitle('mqtt.beta')).toBeTruthy();
		expect(container.querySelectorAll('.rp-row').length).toBe(2);

		ingest(hub, 'mqtt.alpha', 42);
		// The row's value cell now reflects the ingested sample (integer id → plain number).
		const alphaRow = getByTitle('mqtt.alpha').closest('.rp-row') as HTMLElement;
		expect(alphaRow.querySelector('.dim')?.textContent).toBe('42');
	});

	it('shows an empty stub when there are no ids', () => {
		const hub = createTelemetryHub();
		const { getByText, container } = render(<SensorList hub={hub} ids={[]} />);
		expect(() => getByText('No sensors yet.')).not.toThrow();
		expect(container.querySelector('.rp-row')).toBeNull();
	});

	it('renders a per-row badge from badgeFor in the ungrouped list', () => {
		const hub = createTelemetryHub();
		const { getByText } = render(
			<SensorList hub={hub} ids={['mqtt.alpha']} badgeFor={() => 'mqtt'} />
		);
		const badge = getByText('mqtt');
		expect(badge.className).toContain('rp-badge');
	});
});

describe('SensorList — filter box', () => {
	it('shows the total count and filters rows by a case-insensitive substring', () => {
		const hub = createTelemetryHub();
		const ids = ['cpu.total.pct', 'mem.used.pct', 'net.rx'];
		const { container, getByLabelText, getByText, queryByTitle } = render(
			<SensorList hub={hub} ids={ids} filter />
		);
		// Count starts as the full total.
		expect(() => getByText('3')).not.toThrow();

		fireEvent.input(getByLabelText('Filter sensors'), { target: { value: 'CPU' } });
		expect(queryByTitle('cpu.total.pct')).toBeTruthy();
		expect(queryByTitle('mem.used.pct')).toBeNull();
		expect(container.querySelectorAll('.rp-row').length).toBe(1);
		// Count switches to "shown / total" while filtered.
		expect(() => getByText('1 / 3')).not.toThrow();
	});

	it('shows a "no match" stub when the filter excludes everything (ids present)', () => {
		const hub = createTelemetryHub();
		const { getByLabelText, getByText } = render(
			<SensorList hub={hub} ids={['cpu.total.pct']} filter />
		);
		fireEvent.input(getByLabelText('Filter sensors'), { target: { value: 'zzz' } });
		expect(() => getByText('No sensors match.')).not.toThrow();
	});

	it('shows the empty stub (not "no match") when there were never any ids', () => {
		const hub = createTelemetryHub();
		const { getByText } = render(<SensorList hub={hub} ids={[]} filter />);
		expect(() => getByText('No sensors yet.')).not.toThrow();
	});
});

describe('SensorList — grouped', () => {
	const groupFor = (id: string) => (id.startsWith('cpu.') ? 'System' : 'MQTT');

	it('renders a header per group with its id-count, and collapses on click', () => {
		const hub = createTelemetryHub();
		const ids = ['cpu.total.pct', 'mqtt.alpha', 'mqtt.beta'];
		const { container, getByText, getByTitle } = render(
			<SensorList hub={hub} ids={ids} filter groupFor={groupFor} />
		);
		// System group floats to the top; both group headers present.
		expect(() => getByText('System')).not.toThrow();
		expect(() => getByText('MQTT')).not.toThrow();
		// Rows from both groups are visible while expanded.
		expect(getByTitle('cpu.total.pct')).toBeTruthy();
		expect(getByTitle('mqtt.alpha')).toBeTruthy();

		// Collapsing the MQTT group hides its rows but keeps the header.
		const mqttHeader = getByText('MQTT').closest('button') as HTMLButtonElement;
		expect(mqttHeader.getAttribute('aria-expanded')).toBe('true');
		fireEvent.click(mqttHeader);
		expect(mqttHeader.getAttribute('aria-expanded')).toBe('false');
		expect(container.querySelector('[title="mqtt.alpha"]')).toBeNull();
		// The System group is unaffected.
		expect(getByTitle('cpu.total.pct')).toBeTruthy();
	});

	it('suppresses per-row badges in grouped mode (the header carries the source)', () => {
		const hub = createTelemetryHub();
		const { queryByText } = render(
			<SensorList
				hub={hub}
				ids={['mqtt.alpha']}
				filter
				groupFor={groupFor}
				badgeFor={() => 'mqtt'}
			/>
		);
		// The MQTT group header exists, but no per-row .rp-badge "mqtt" pill.
		expect(queryByText('mqtt')).toBeNull();
	});
});

describe('SensorList — activity dots + legend', () => {
	const activityFor =
		(map: Record<string, SensorActivity>) =>
		(id: string): SensorActivity | null =>
			map[id] ?? null;

	const referenced: SensorActivity = { active: true, referenced: true, reason: 'used by gauge' };
	const alwaysOn: SensorActivity = {
		active: true,
		referenced: false,
		reason: 'always sampled (a cheap system sensor)'
	};
	const studioOnly: SensorActivity = {
		active: false,
		referenced: false,
		reason: 'stops when the studio closes'
	};

	it('renders a shaped status dot per row reflecting its after-close fate', () => {
		const hub = createTelemetryHub();
		const map = { 'a.ref': referenced, 'b.on': alwaysOn, 'c.studio': studioOnly };
		const { getByTitle } = render(
			<SensorList hub={hub} ids={Object.keys(map)} activityFor={activityFor(map)} />
		);
		// ★ referenced, ● always-on, ○ studio-only (shape, not colour alone — WCAG 1.4.1).
		const dotFor = (id: string) =>
			getByTitle(id).closest('.rp-row')?.querySelector('.sensor-dot') as HTMLElement;
		expect(dotFor('a.ref').textContent).toBe('★');
		expect(dotFor('a.ref').className).toContain('on');
		expect(dotFor('b.on').textContent).toBe('●');
		expect(dotFor('b.on').className).toContain('amb');
		expect(dotFor('c.studio').textContent).toBe('○');
		expect(dotFor('c.studio').className).toContain('off');
	});

	it('summarizes the after-close legend counts in filter mode', () => {
		const hub = createTelemetryHub();
		const map = { 'a.ref': referenced, 'b.on': alwaysOn, 'c.studio': studioOnly };
		const { getByText } = render(
			<SensorList hub={hub} ids={Object.keys(map)} filter activityFor={activityFor(map)} />
		);
		// 1 referenced, (2 active − 1 referenced) = 1 always-on, (3 total − 2 active) = 1 studio-only.
		expect(() => getByText('1 used by widgets')).not.toThrow();
		expect(() => getByText('1 always-on')).not.toThrow();
		expect(() => getByText('1 studio-only')).not.toThrow();
		expect(() => getByText('2/3 stay active after close')).not.toThrow();
	});
});
