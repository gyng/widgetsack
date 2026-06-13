import { describe, it, expect } from 'vitest';
import { pingSensors, pingLevel } from './ping';

describe('pingSensors', () => {
	it('builds the ms/up ids for a host', () => {
		expect(pingSensors('8.8.8.8')).toEqual({
			ms: 'net.ping.8.8.8.8.ms',
			up: 'net.ping.8.8.8.8.up'
		});
		expect(pingSensors('cloudflare.com')).toEqual({
			ms: 'net.ping.cloudflare.com.ms',
			up: 'net.ping.cloudflare.com.up'
		});
	});

	it('defaults a blank host to 1.1.1.1', () => {
		expect(pingSensors('')).toEqual({ ms: 'net.ping.1.1.1.1.ms', up: 'net.ping.1.1.1.1.up' });
		expect(pingSensors('  ')).toEqual({ ms: 'net.ping.1.1.1.1.ms', up: 'net.ping.1.1.1.1.up' });
	});
});

describe('pingLevel', () => {
	it('classifies by reachability then latency', () => {
		expect(pingLevel(null, null)).toBe('unknown');
		expect(pingLevel(0, null)).toBe('down');
		expect(pingLevel(1, 20)).toBe('up');
		expect(pingLevel(1, 200)).toBe('slow');
		expect(pingLevel(1, null)).toBe('up'); // up but no latency reading → treat as up
		expect(pingLevel(1, 150, 150)).toBe('slow'); // boundary is "slow"
	});
});
