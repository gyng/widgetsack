// The ambient telemetry-hub context. useTelemetryHub returns the provided hub, and throws a
// clear programming-error when used outside a provider.
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { TelemetryHubContext, useTelemetryHub } from './telemetryContext';
import { createTelemetryHub, type TelemetryHub } from '../core/telemetry';

describe('useTelemetryHub', () => {
	it('returns the hub provided by the context provider', () => {
		const hub = createTelemetryHub();
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<TelemetryHubContext.Provider value={hub}>{children}</TelemetryHubContext.Provider>
		);
		const { result } = renderHook(() => useTelemetryHub(), { wrapper });
		expect(result.current).toBe(hub);
	});

	it('throws when used outside a provider (a programming error)', () => {
		expect(() => renderHook(() => useTelemetryHub())).toThrow(/no TelemetryHubContext provider/);
	});

	it('the default context value is null', () => {
		let captured: TelemetryHub | null | undefined;
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<TelemetryHubContext.Consumer>
				{(v) => {
					captured = v;
					return children;
				}}
			</TelemetryHubContext.Consumer>
		);
		renderHook(() => null, { wrapper });
		expect(captured).toBeNull();
	});
});
