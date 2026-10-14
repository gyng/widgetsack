import { resolveGroup } from './solve';
import { describe, expect, it } from 'vitest';
import { applyParams } from './params';
import { leaf, container, group, type Leaf, type ParamSpec } from './layoutTree';
import type { WidgetInstance } from './layout';
const frame = () =>
	leaf({ id: 'f', type: 'iframe', rect: { x: 0, y: 0, w: 100, h: 50 }, config: { sandbox: true } });

describe('imported parameter policy', () => {
	it.each([null, 'not a widget', { id: 'broken', type: 'iframe', config: {} }])(
		'rejects a malformed whole-unit parameter override: %j',
		(replacement) => {
			const child = frame();
			const expected = structuredClone(child);
			expect(
				applyParams(child, [{ key: 'replacement', target: 'unit', imported: true }], {
					replacement
				})
			).toEqual(expected);
		}
	);
	it('removes an invalid newly added field and preserves later valid changes', () => {
		const result = applyParams(frame(), [{ key: 'css', target: 'unit.css' }, { key: 'url' }], {
			css: 42,
			url: 'https://example.com'
		}) as Leaf;
		expect(result.unit).not.toHaveProperty('css');
		expect((result.unit as WidgetInstance).config.url).toBe('https://example.com');
	});
	it('keeps caller-owned trees unchanged when no parameters are declared', () => {
		const tree = frame();
		expect(applyParams(tree, undefined, {})).toBe(tree);
	});
	it('preserves explicit sandbox controls on locally authored definitions', () => {
		const tree = applyParams(frame(), [{ key: 'sandbox', default: true }], {
			sandbox: false
		}) as Leaf;
		expect((tree.unit as WidgetInstance).config.sandbox).toBe(false);
	});
	it('uses the hardened tree for saved group instances', () => {
		const child = frame();
		const instance = group('instance', { w: 100, h: 50 }, child, {
			def: 'def',
			params: { sandbox: false }
		});
		const resolved = resolveGroup(instance, {
			version: 1,
			defs: [
				{
					id: 'def',
					name: 'Frame',
					size: { w: 100, h: 50 },
					child,
					params: [{ key: 'sandbox', default: true, imported: true }]
				}
			]
		});
		expect(((resolved.child as Leaf).unit as WidgetInstance).config.sandbox).toBe(true);
	});

	it('does not use inherited object methods as undeclared parameter values', () => {
		const result = applyParams(frame(), [{ key: 'toString', target: 'unit.type' }], {}) as Leaf;
		expect((result.unit as WidgetInstance).type).toBe('iframe');
	});

	it('hardens imported whole-unit replacements inside nested groups after overrides', () => {
		const tree = leaf(group('g', { w: 100, h: 50 }, container('row', 'row', [frame()])));
		const specs: ParamSpec[] = [
			{ key: 'replacement', target: 'unit.child.children.0.unit', imported: true }
		];
		const replacement = {
			id: 'new',
			type: 'iframe',
			rect: { x: 0, y: 0, w: 100, h: 50 },
			config: { sandbox: false }
		};
		const result = applyParams(tree, specs, { replacement });
		expect(JSON.stringify(result)).toContain('"id":"new"');
		expect(JSON.stringify(result)).toContain('"sandbox":true');
		expect(replacement.config.sandbox).toBe(false);
	});
});

it('does not mutate caller-owned objects through later parameter targets', () => {
	const config = { label: 'Original', sandbox: true };
	const result = applyParams(
		frame(),
		[{ key: 'config', target: 'unit.config' }, { key: 'label' }],
		{ config, label: 'Changed' }
	) as Leaf;
	expect((result.unit as WidgetInstance).config.label).toBe('Changed');
	expect(config.label).toBe('Original');
});
