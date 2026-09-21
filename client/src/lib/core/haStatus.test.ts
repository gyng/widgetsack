import { describe, expect, it } from 'vitest';
import { haStatusBadge } from './haStatus';

describe('haStatusBadge', () => {
	it('maps each known ha.status string to a label + tone', () => {
		expect(haStatusBadge('connected')).toEqual({ label: 'Connected', tone: 'ok' });
		expect(haStatusBadge('connecting')).toEqual({ label: 'Connecting…', tone: 'busy' });
		expect(haStatusBadge('error')).toEqual({ label: 'Error', tone: 'warn' });
		expect(haStatusBadge('disconnected')).toEqual({ label: 'Disconnected', tone: 'idle' });
		expect(haStatusBadge('unconfigured')).toEqual({ label: 'Not configured', tone: 'idle' });
	});

	it('falls back to an idle "Not connected" badge for null/unknown', () => {
		expect(haStatusBadge(null)).toEqual({ label: 'Not connected', tone: 'idle' });
		expect(haStatusBadge(undefined)).toEqual({ label: 'Not connected', tone: 'idle' });
		expect(haStatusBadge('weird')).toEqual({ label: 'Not connected', tone: 'idle' });
	});
});
