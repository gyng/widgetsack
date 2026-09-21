import { describe, expect, it } from 'vitest';
import { HA_UNCONFIGURED_MESSAGE, haTileState } from './haTileState';

describe('haTileState', () => {
	it('renders the value as-is when the host supplied no status (standalone render)', () => {
		expect(haTileState(undefined, null)).toEqual({ kind: 'ok' });
		expect(haTileState(undefined, { state: 'unavailable' })).toEqual({ kind: 'ok' });
	});

	it('points at Plugins → Home Assistant when no ha.status sample exists (never configured)', () => {
		expect(haTileState(null, null)).toEqual({
			kind: 'unconfigured',
			message: HA_UNCONFIGURED_MESSAGE
		});
		expect(haTileState('', { state: 'on' }).kind).toBe('unconfigured');
		expect(HA_UNCONFIGURED_MESSAGE).toMatch(/Plugins → Home Assistant/);
	});

	it.each([
		['connecting', 'Connecting to Home Assistant…'],
		['disconnected', 'Home Assistant offline'],
		['error', 'Home Assistant offline'],
		['something-new', 'Home Assistant offline']
	])('says offline while the connection is down (%s)', (status, message) => {
		// Even a stale cached entity value must not read as live data while offline.
		expect(haTileState(status, { state: 'on' })).toEqual({ kind: 'offline', message });
	});

	it('waits for the entity when connected but no sample has arrived yet', () => {
		expect(haTileState('connected', null)).toEqual({
			kind: 'waiting',
			message: 'Waiting for the entity…'
		});
		expect(haTileState('connected', undefined).kind).toBe('waiting');
	});

	it('flags an entity HA itself reports as unavailable', () => {
		expect(haTileState('connected', { state: 'unavailable' })).toEqual({
			kind: 'unavailable',
			message: 'Entity unavailable'
		});
	});

	it('is ok when connected with a live entity (unknown/off/on are all real states)', () => {
		expect(haTileState('connected', { state: 'on' })).toEqual({ kind: 'ok' });
		expect(haTileState('connected', { state: 'unknown' })).toEqual({ kind: 'ok' });
		// A scene has no state field at all — still a delivered entity.
		expect(haTileState('connected', { attributes: {} })).toEqual({ kind: 'ok' });
	});
});
