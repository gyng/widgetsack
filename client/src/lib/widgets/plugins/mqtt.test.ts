import { describe, expect, it } from 'vitest';
import { registerMqttPlugin } from './mqtt';
import { listSources } from '../../core/plugin';

registerMqttPlugin();

describe('mqtt plugin', () => {
	it('registers the mqtt sensor source (source + settings only, no widget)', () => {
		expect(listSources().some((s) => s.id === 'mqtt')).toBe(true);
	});
});
