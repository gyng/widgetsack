import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

// Pin the sandbox to "not ready" so this exercises the window BEFORE a formula resolves (engine still
// loading / sensor unemitted / eval error) — the regression guard for the leak where the raw formula
// SOURCE string reached the meter as its value (Gauge → NaN, Text → the literal template).
vi.mock('../formula/engine', () => ({
	initFormulaEngine: () => Promise.resolve(),
	isFormulaEngineReady: () => false,
	onFormulaEngineReady: () => () => undefined,
	evalExpr: () => null,
	retainFormulas: () => () => undefined
}));

import WidgetHost from './WidgetHost';
import { createTelemetryHub } from '../core/telemetry';
import type { WidgetInstance } from '../core/layout';

const inst = (type: string, config: Record<string, unknown>): WidgetInstance => ({
	id: 'w1',
	type,
	rect: { x: 0, y: 0, w: 100, h: 100 },
	config
});

describe('WidgetHost — formula not-ready fallback', () => {
	it('a Gauge value formula never leaks its source / NaN before it resolves', () => {
		const hub = createTelemetryHub();
		const { container } = render(
			<WidgetHost
				hub={hub}
				instance={inst('gauge', { value: 'cpu.total / 2', min: 0, max: 100 })}
			/>
		);
		expect(container.textContent).not.toContain('cpu.total'); // not the raw formula string
		expect(container.textContent).not.toContain('NaN'); // not Math.round('cpu.total / 2')
		// graceful fallback: an unbound, not-yet-resolved value renders as the em dash
		expect(container.textContent).toContain('–');
	});

	it('a Text value template never leaks its literal source before it resolves', () => {
		const hub = createTelemetryHub();
		const { container } = render(
			<WidgetHost hub={hub} instance={inst('text', { value: 'CPU {round(cpu.total)}%' })} />
		);
		expect(container.textContent).not.toContain('{round'); // not the literal template
		expect(container.textContent).not.toContain('cpu.total');
	});
});
