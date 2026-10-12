import { act, fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createTelemetryHub } from '../core/telemetry';
import PalettePluginSetup from './PalettePluginSetup';

it('links to the owning plugin and updates its setup indicator without confusing offline with unconfigured', () => {
	const hub = createTelemetryHub();
	const configure = vi.fn();
	const { getByRole, getByText, queryByText } = render(
		<PalettePluginSetup
			hub={hub}
			id="home-assistant"
			name="Home Assistant"
			sensor="ha.status"
			onConfigure={configure}
		/>
	);
	expect(getByText('Setup status unknown')).toBeVisible();
	fireEvent.click(getByRole('button', { name: 'Configure Home Assistant' }));
	expect(configure).toHaveBeenCalledWith('home-assistant');
	for (const [value, label] of [
		['unconfigured', 'Not configured'],
		['connected', 'Connected'],
		['disconnected', 'Disconnected']
	]) {
		act(() =>
			hub.ingest({ sensor: 'ha.status', ts_ms: Date.now(), value: { kind: 'text', value } })
		);
		expect(getByText(label)).toBeVisible();
	}
	expect(queryByText('Not configured')).toBeNull();
});
