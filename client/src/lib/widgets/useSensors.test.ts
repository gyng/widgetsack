import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createTelemetryHub } from '../core/telemetry';
import { useSensors } from './useSensors';

describe('useSensors', () => {
	it('returns null for each id until a sample arrives, then the live value', () => {
		const hub = createTelemetryHub();
		const { result } = renderHook(() => useSensors(hub, ['cpu.total', 'mem.used']));
		expect(result.current).toEqual({ 'cpu.total': null, 'mem.used': null });

		act(() => hub.ingest({ sensor: 'cpu.total', ts_ms: 0, value: { kind: 'scalar', value: 37 } }));
		expect(result.current).toEqual({ 'cpu.total': 37, 'mem.used': null });
	});

	it('keeps a stable snapshot reference when nothing relevant changed', () => {
		const hub = createTelemetryHub();
		const { result, rerender } = renderHook(() => useSensors(hub, ['cpu.total']));
		const first = result.current;
		rerender();
		expect(result.current).toBe(first); // no churn → same object (no tearing)

		act(() => hub.ingest({ sensor: 'other', ts_ms: 0, value: { kind: 'scalar', value: 1 } }));
		expect(result.current).toBe(first); // an unsubscribed sensor doesn't notify us
	});

	it('passes through text and takes the latest point of a series', () => {
		const hub = createTelemetryHub();
		const { result } = renderHook(() => useSensors(hub, ['np.title', 'cpu.total']));
		act(() => {
			hub.ingest({ sensor: 'np.title', ts_ms: 0, value: { kind: 'text', value: 'Song' } });
			hub.ingest({ sensor: 'cpu.total', ts_ms: 0, value: { kind: 'series', value: [1, 2, 3] } });
		});
		expect(result.current).toEqual({ 'np.title': 'Song', 'cpu.total': 3 });
	});

	it('an empty series yields null (no latest point)', () => {
		const hub = createTelemetryHub();
		const { result } = renderHook(() => useSensors(hub, ['cpu.total']));
		act(() => hub.ingest({ sensor: 'cpu.total', ts_ms: 0, value: { kind: 'series', value: [] } }));
		expect(result.current).toEqual({ 'cpu.total': null }); // .at(-1) ?? null
	});

	it('treats an opaque json value as null (a formula can not read it)', () => {
		const hub = createTelemetryHub();
		const { result } = renderHook(() => useSensors(hub, ['ha.entity']));
		act(() =>
			hub.ingest({ sensor: 'ha.entity', ts_ms: 0, value: { kind: 'json', value: { on: true } } })
		);
		expect(result.current).toEqual({ 'ha.entity': null });
	});

	it('returns an empty snapshot for no ids (no subscriptions)', () => {
		const hub = createTelemetryHub();
		const { result } = renderHook(() => useSensors(hub, []));
		expect(result.current).toEqual({});
	});
});
