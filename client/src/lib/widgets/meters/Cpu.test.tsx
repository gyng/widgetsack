import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import Cpu from './Cpu';
import { TelemetryHubContext } from '../telemetryContext';
import { createTelemetryHub, type SensorSample, type TelemetryHub } from '../../core/telemetry';

// The per-core grid is now drawn into a <canvas> (CpuCoresCanvas), which has no queryable DOM and no 2D
// context under happy-dom. So we mock it and capture the props Cpu feeds it — that's where the meaningful
// logic lives (which sensors become cores, the column count, colour). The drawing geometry is covered by
// the pure cpuCoresMath + sparklineMath tests.
const cap = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock('./CpuCoresCanvas', () => ({
	default: (p: Record<string, unknown>) => {
		cap.props = p;
		return null;
	}
}));

// A hub seeded with cpu.total + `coreCount` per-core sensors, two ticks each so every core has history.
// When `withFreq` is set it also emits the per-core FREQUENCY sensors (cpu.core.N.freq, MHz) the studio's
// "*" subscription broadcasts — they must NOT be counted as cores.
function hubWith(coreCount: number, withFreq = false): TelemetryHub {
	const hub = createTelemetryHub();
	for (let t = 0; t < 2; t++) {
		const batch: SensorSample[] = [
			{ sensor: 'cpu.total', ts_ms: t, value: { kind: 'scalar', value: 10 } }
		];
		for (let i = 0; i < coreCount; i++) {
			batch.push({ sensor: `cpu.core.${i}`, ts_ms: t, value: { kind: 'scalar', value: 10 + i } });
			if (withFreq) {
				batch.push({
					sensor: `cpu.core.${i}.freq`,
					ts_ms: t,
					value: { kind: 'scalar', value: 4000 }
				});
			}
		}
		hub.ingestBatch(batch);
	}
	return hub;
}

function renderCpu(node: ReactElement, coreCount: number, withFreq = false) {
	cap.props = null;
	return render(
		<TelemetryHubContext.Provider value={hubWith(coreCount, withFreq)}>
			{node}
		</TelemetryHubContext.Provider>
	);
}

describe('Cpu (per-core grid)', () => {
	it('feeds the canvas one history per core', () => {
		renderCpu(<Cpu />, 32);
		expect((cap.props?.cores as number[][]).length).toBe(32);
	});

	it('defaults to an 8-column grid', () => {
		renderCpu(<Cpu />, 32);
		expect(cap.props?.cols).toBe(8);
	});

	it('ignores per-core frequency sensors (cpu.core.N.freq) — usage only', () => {
		// 32 usage + 32 freq present (as when the studio "*" subscription is live); the grid must stay at
		// exactly the 32 usage cores, not pad out with 32 off-scale freq lines.
		renderCpu(<Cpu />, 32, true);
		expect((cap.props?.cores as number[][]).length).toBe(32);
		expect(cap.props?.cols).toBe(8);
	});

	it('respects an explicit cols override (a fixed-width grid)', () => {
		renderCpu(<Cpu cols={4} />, 32);
		expect(cap.props?.cols).toBe(4);
	});

	it('passes the colour through (undefined → CpuCoresCanvas falls back to the --np-fg token)', () => {
		renderCpu(<Cpu />, 4);
		expect(cap.props?.color).toBeUndefined();
	});

	it('lets an explicit color override the token default', () => {
		renderCpu(<Cpu color="red" />, 4);
		expect(cap.props?.color).toBe('red');
	});
});

describe('Cpu (combined gauge)', () => {
	it("renders a Gauge of cpu.total (not the per-core canvas) when mode is 'combined'", () => {
		// The hub seeds cpu.total = 10; combined mode composes the real Gauge (only CpuCoresCanvas is
		// mocked), so the rounded total + unit + label must show up in the gauge text.
		const { container } = renderCpu(<Cpu mode="combined" label="Load" />, 4);
		expect(cap.props).toBeNull(); // the per-core canvas is NOT rendered in combined mode
		expect(container.querySelector('[data-part="value"]')?.textContent).toBe('10%');
		expect(container.querySelector('[data-part="label"]')?.textContent).toBe('Load');
	});

	it('shows a dash in combined mode before any cpu.total sample arrives', () => {
		cap.props = null;
		const { container } = render(
			<TelemetryHubContext.Provider value={createTelemetryHub()}>
				<Cpu mode="combined" />
			</TelemetryHubContext.Provider>
		);
		// Gauge renders the en-dash placeholder for a null value.
		expect(container.querySelector('[data-part="value"]')?.textContent).toBe('–%');
	});
});

describe('Cpu (no hub)', () => {
	it('renders an empty gauge without throwing when there is no telemetry hub', () => {
		// Outside a provider the context is null; the effect bails (no subscription) and combined mode
		// still renders the null-value placeholder gauge.
		const { container } = render(
			<TelemetryHubContext.Provider value={null}>
				<Cpu mode="combined" />
			</TelemetryHubContext.Provider>
		);
		expect(container.querySelector('[data-part="value"]')?.textContent).toBe('–%');
	});
});
