import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createTelemetryHub } from '../core/telemetry';
import type { ExprField } from '../core/widget';
import { __disposeFormulaEngine, evalExpr, initFormulaEngine } from './engine';
import { useFormulaFields } from './useFormula';

const scalar = (value: number) => ({ kind: 'scalar' as const, value });

beforeAll(async () => {
	await initFormulaEngine();
});
afterAll(() => __disposeFormulaEngine());

describe('useFormulaFields', () => {
	it('evaluates a numeric formula against live sensors and overrides the prop', async () => {
		const hub = createTelemetryHub();
		const fields: ExprField[] = [
			{ key: 'value', result: 'number', target: 'value' },
			{ key: 'maxExpr', result: 'number', target: 'max' }
		];
		const config = { value: 'cpu.total / 2', maxExpr: '100' };
		const { result } = renderHook(() => useFormulaFields(hub, fields, config));

		// A const sub-expression resolves immediately; the sensor-dependent one waits for a sample.
		expect(result.current.overrides).toEqual({ max: 100 });
		act(() => hub.ingest({ sensor: 'cpu.total', ts_ms: 0, value: scalar(80) }));
		await waitFor(() => expect(result.current.overrides).toEqual({ value: 40, max: 100 }));
	});

	it('renders a text template (literal text + {expr}) into a string', async () => {
		const hub = createTelemetryHub();
		const fields: ExprField[] = [{ key: 'value', result: 'text', target: 'value' }];
		const config = { value: 'CPU {round(cpu.total)}%' };
		const { result } = renderHook(() => useFormulaFields(hub, fields, config));

		act(() => hub.ingest({ sensor: 'cpu.total', ts_ms: 0, value: scalar(37.4) }));
		await waitFor(() => expect(result.current.overrides.value).toBe('CPU 37%'));
	});

	it('produces no overrides for a widget with no formula fields', () => {
		const hub = createTelemetryHub();
		const { result } = renderHook(() => useFormulaFields(hub, [], { label: 'x' }));
		expect(result.current.overrides).toEqual({});
	});

	it('drops a numeric override when the expression errors (falls back to the sensor)', async () => {
		const hub = createTelemetryHub();
		const fields: ExprField[] = [{ key: 'value', result: 'number', target: 'value' }];
		const { result } = renderHook(() => useFormulaFields(hub, fields, { value: 'cpu.total +' }));
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(result.current.overrides).toEqual({}); // syntax error → null → no override
	});

	it('releases its formula contexts on unmount and when a formula changes', () => {
		const hub = createTelemetryHub();
		const fields: ExprField[] = [
			{ key: 'value', result: 'number', target: 'value' },
			{ key: 'label', result: 'text', target: 'label' }
		];
		const counter = '(globalThis.u = (globalThis.u || 0) + 1)';
		const tally = '(globalThis.t = (globalThis.t || 0) + 1)';
		const { result, rerender, unmount } = renderHook(
			({ config }) => useFormulaFields(hub, fields, config),
			{ initialProps: { config: { value: counter, label: `#{${tally}}` } } }
		);
		expect(result.current.overrides).toEqual({ value: 1, label: '#1' });
		// The same sources in a new config object keep their contexts.
		rerender({ config: { value: counter, label: `#{${tally}}` } });
		expect(result.current.overrides).toEqual({ value: 2, label: '#2' });
		rerender({ config: { value: '1', label: `#{${tally}}` } });
		expect(evalExpr(counter, {})).toBe(1);
		unmount();
		expect(evalExpr(tally, {})).toBe(1);
	});
});
