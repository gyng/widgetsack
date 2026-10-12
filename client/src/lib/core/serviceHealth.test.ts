import { describe, expect, it } from 'vitest';
import { serviceHealthLevel, servicePollDelay, type ServiceHealthSnapshot } from './serviceHealth';
const good: ServiceHealthSnapshot = {
	status: 200,
	latencyMs: 30,
	certificateDays: null,
	error: null
};
describe('service health classification', () => {
	it('separates failures, redirects, certificate warnings, slow responses, and healthy services', () => {
		expect(serviceHealthLevel(null, 1000, 14).state).toBe('unknown');
		for (const patch of [
			{ error: 'TLS failure' },
			{ status: null },
			{ status: 100 },
			{ status: 404 },
			{ status: 503 }
		])
			expect(serviceHealthLevel({ ...good, ...patch }, 1000, 14).state).toBe('down');
		expect(serviceHealthLevel({ ...good, status: 302 }, 1000, 14)).toEqual({
			state: 'warning',
			label: 'redirect'
		});
		expect(serviceHealthLevel({ ...good, certificateDays: 14 }, 1000, 14)).toEqual({
			state: 'warning',
			label: 'certificate warning'
		});
		expect(serviceHealthLevel({ ...good, latencyMs: 1000 }, 1000, 14).state).toBe('slow');
		expect(serviceHealthLevel(good, 1000, 14).state).toBe('up');
		expect(serviceHealthLevel({ ...good, certificateDays: 15 }, 1000, 14).state).toBe('up');
	});
	it('bounds polling and falls back for non-finite settings', () => {
		expect(servicePollDelay(1)).toBe(15000);
		expect(servicePollDelay(60)).toBe(60000);
		expect(servicePollDelay(10000)).toBe(3600000);
		expect(servicePollDelay(NaN)).toBe(60000);
		expect(servicePollDelay(Infinity)).toBe(60000);
	});
});
