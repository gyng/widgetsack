import { describe, expect, it } from 'vitest';
import { buildCustomHtmlDocument, customHtmlSensors, isCustomHtmlReady } from './customHtml';
import { customHtmlMeta } from './customHtmlMeta';
import { agentUnitRefusal, sanitizeAssistantConfig } from './llm';

describe('custom HTML contract', () => {
	it('allows agents to author isolated custom content through declared config fields', () => {
		const config = {
			html: '<main>Hi</main>',
			javascript: 'console.log(1)',
			sensorIds: 'cpu.total'
		};
		expect(sanitizeAssistantConfig('customhtml', config)).toEqual({ config, errors: [] });
		expect(
			agentUnitRefusal({
				id: 'custom',
				type: 'customhtml',
				rect: { x: 0, y: 0, w: 320, h: 100 },
				config
			})
		).toBeNull();
	});
	it('advertises config-driven sensor subscriptions with an empty safe default', () => {
		expect(customHtmlMeta.sensors!({})).toEqual({});
		expect(customHtmlMeta.sensors!({ sensorIds: 'cpu.total,mem.used' })).toEqual({
			'cpu.total': 'cpu.total',
			'mem.used': 'mem.used'
		});
	});
	it('only subscribes to a bounded explicit list of sensor IDs', () => {
		expect(customHtmlSensors('cpu.total, mem.used\ncpu.total, bad id, __proto__')).toEqual({
			'cpu.total': 'cpu.total',
			'mem.used': 'mem.used'
		});
		expect(
			Object.keys(customHtmlSensors(Array.from({ length: 40 }, (_, i) => `s.${i}`).join(',')))
		).toHaveLength(32);
	});
	it('validates the sole incoming message and session token', () => {
		expect(isCustomHtmlReady({ type: 'widgetsack:ready', version: 1, token: 'abc' }, 'abc')).toBe(
			true
		);
		for (const message of [
			null,
			[],
			{},
			{ type: 'widgetsack:ready', version: 2, token: 'abc' },
			{ type: 'widgetsack:ready', version: 1, token: 'other' }
		]) {
			expect(isCustomHtmlReady(message, 'abc')).toBe(false);
		}
	});
	it('keeps code out of bootstrap markup and exposes read-only state updates', () => {
		const doc = buildCustomHtmlDocument(
			'<main>CPU</main>',
			'main { color: red }',
			'console.log("</script><script>oops")',
			'abc'
		);
		expect(doc).toContain('<main>CPU</main>');
		expect(doc).toContain('widgetsack:ready');
		expect(doc).toContain('event.source !== parent');
		expect(doc).toContain('new Blob');
		expect(doc).not.toContain('console.log("</script>');
		expect(doc).toContain('window.widgetsack');
	});
});
