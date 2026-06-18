import { describe, expect, it } from 'vitest';
import {
	addAction,
	moveAction,
	normalizeMacro,
	removeAction,
	runMacro,
	updateAction,
	withEntityId,
	type Macro,
	type MacroAction
} from './macro';

describe('normalizeMacro', () => {
	it('returns [] for non-arrays', () => {
		expect(normalizeMacro(undefined)).toEqual([]);
		expect(normalizeMacro(null)).toEqual([]);
		expect(normalizeMacro('media')).toEqual([]);
		expect(normalizeMacro({ domain: 'light', service: 'toggle' })).toEqual([]);
	});

	it('keeps well-formed actions and their data', () => {
		const actions = [
			{ domain: 'light', service: 'toggle', data: { entity_id: 'light.kitchen' } },
			{ domain: 'media', service: 'playpause' }
		];
		expect(normalizeMacro(actions)).toEqual(actions);
	});

	it('drops entries missing a string domain or service', () => {
		const out = normalizeMacro([
			{ domain: 'light', service: 'toggle' },
			{ domain: 'light' },
			{ service: 'toggle' },
			{ domain: 1, service: 'x' },
			null,
			'nope',
			42
		]);
		expect(out).toEqual([{ domain: 'light', service: 'toggle' }]);
	});

	it('strips a non-plain-object data (array / primitive)', () => {
		expect(normalizeMacro([{ domain: 'light', service: 'toggle', data: [1, 2] }])).toEqual([
			{ domain: 'light', service: 'toggle' }
		]);
		expect(normalizeMacro([{ domain: 'light', service: 'toggle', data: 'x' }])).toEqual([
			{ domain: 'light', service: 'toggle' }
		]);
	});
});

describe('runMacro', () => {
	it('returns [] for an empty macro and never calls dispatch', async () => {
		let calls = 0;
		const results = await runMacro([], () => {
			calls++;
		});
		expect(results).toEqual([]);
		expect(calls).toBe(0);
	});

	it('dispatches every action in order, awaiting each before the next', async () => {
		const order: string[] = [];
		const actions: Macro = [
			{ domain: 'light', service: 'turn_on' },
			{ domain: 'media', service: 'pause' },
			{ domain: 'switch', service: 'toggle' }
		];
		const results = await runMacro(actions, async (a) => {
			order.push(`start:${a.domain}`);
			await Promise.resolve();
			order.push(`end:${a.domain}`);
		});
		// Sequential, not interleaved: each action fully completes before the next starts.
		expect(order).toEqual([
			'start:light',
			'end:light',
			'start:media',
			'end:media',
			'start:switch',
			'end:switch'
		]);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(results.map((r) => r.action)).toEqual(actions);
	});

	it('continues after a failing action and records the error', async () => {
		const ran: string[] = [];
		const boom = new Error('offline');
		const results = await runMacro(
			[
				{ domain: 'light', service: 'turn_on' },
				{ domain: 'light', service: 'explode' },
				{ domain: 'media', service: 'pause' }
			],
			async (a) => {
				ran.push(a.service);
				if (a.service === 'explode') throw boom;
			}
		);
		expect(ran).toEqual(['turn_on', 'explode', 'pause']);
		expect(results.map((r) => r.ok)).toEqual([true, false, true]);
		expect(results[1].error).toBe(boom);
	});
});

describe('macro edit ops (pure / immutable)', () => {
	const base: Macro = [
		{ domain: 'light', service: 'toggle' },
		{ domain: 'media', service: 'pause' }
	];

	it('addAction appends without mutating the input', () => {
		const next = addAction(base);
		expect(next).toHaveLength(3);
		expect(next[2]).toEqual({ domain: '', service: '' });
		expect(base).toHaveLength(2);
	});

	it('addAction can append a provided action', () => {
		const a: MacroAction = { domain: 'switch', service: 'turn_on' };
		expect(addAction(base, a)[2]).toEqual(a);
	});

	it('removeAction drops one and leaves the rest', () => {
		expect(removeAction(base, 0)).toEqual([{ domain: 'media', service: 'pause' }]);
		expect(removeAction(base, 5)).toEqual(base);
		expect(base).toHaveLength(2);
	});

	it('updateAction patches a single field immutably', () => {
		const next = updateAction(base, 0, { service: 'turn_on', data: { entity_id: 'light.x' } });
		expect(next[0]).toEqual({
			domain: 'light',
			service: 'turn_on',
			data: { entity_id: 'light.x' }
		});
		expect(next[1]).toBe(base[1]);
		expect(base[0]).toEqual({ domain: 'light', service: 'toggle' });
	});

	it('moveAction reorders and clamps no-op moves', () => {
		expect(moveAction(base, 0, 1)).toEqual([
			{ domain: 'media', service: 'pause' },
			{ domain: 'light', service: 'toggle' }
		]);
		// Off the ends → unchanged.
		expect(moveAction(base, 0, -1)).toBe(base);
		expect(moveAction(base, 1, 1)).toBe(base);
		expect(base[0]).toEqual({ domain: 'light', service: 'toggle' });
	});

	it('withEntityId sets, preserves other keys, and clears', () => {
		expect(withEntityId(undefined, 'light.x')).toEqual({ entity_id: 'light.x' });
		expect(withEntityId({ brightness_pct: 60 }, 'light.x')).toEqual({
			entity_id: 'light.x',
			brightness_pct: 60
		});
		// clearing removes only entity_id, keeping the rest
		expect(withEntityId({ entity_id: 'light.x', brightness_pct: 60 }, '')).toEqual({
			brightness_pct: 60
		});
		// clearing the last key → undefined (matches optional data)
		expect(withEntityId({ entity_id: 'light.x' }, '')).toBeUndefined();
		expect(withEntityId({ entity_id: 'light.x' }, '   ')).toBeUndefined();
	});
});
