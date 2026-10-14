import { describe, expect, it } from 'vitest';
import { validLibrary, stringMap } from './libraryValidation';
const unit = () => ({
	id: 'widget',
	type: 'text',
	sensor: 'cpu.total',
	rect: { x: 0, y: 0, w: 100, h: 50 },
	config: {}
});
const leaf = () => ({ id: 'leaf', unit: unit() });
const definition = () => ({
	id: 'def',
	name: 'Definition',
	size: { w: 100, h: 50 },
	child: leaf()
});
const library = (def: unknown) => ({ version: 1, defs: [def] });

describe('library validation', () => {
	it('accepts widget trees, inline groups, styles, and parameter choices', () => {
		const rich = {
			...definition(),
			css: '& { color: red; }',
			child: {
				id: 'row',
				kind: 'row',
				children: [
					{
						id: 'group',
						unit: {
							id: 'group',
							kind: 'group',
							def: 'other',
							size: { w: 100, h: 50 },
							child: leaf(),
							tokens: { '--np-fg': 'red' }
						}
					}
				]
			},
			params: [
				{
					key: 'label',
					label: 'Label',
					target: 'unit.config.label',
					targets: ['unit.config.label'],
					choices: [{ value: 'CPU', label: 'CPU' }]
				}
			]
		};
		expect(validLibrary(library(rich))).toBe(true);
		expect(validLibrary(library({ ...definition(), params: [{ key: 'label' }] }))).toBe(true);
		expect(validLibrary({ version: 1, defs: [] })).toBe(true);
	});

	it.each([null, [], { version: 2, defs: [] }, { version: 1, defs: {} }])(
		'rejects an invalid library envelope: %j',
		(value) => {
			expect(validLibrary(value)).toBe(false);
		}
	);

	it.each([
		null,
		{ ...definition(), id: 42 },
		{ ...definition(), name: 42 },
		{ ...definition(), size: null },
		{ ...definition(), size: { w: Infinity, h: 1 } },
		{ ...definition(), size: { w: 1 } },
		{ ...definition(), css: 42 },
		{ ...definition(), tokens: [] },
		{ ...definition(), tokens: { color: 42 } },
		{ ...definition(), child: null },
		{ ...definition(), child: { ...leaf(), id: 42 } },
		{ ...definition(), child: { id: 'row', kind: 'row', children: {} } },
		{ ...definition(), child: { id: 'row', kind: 'row', children: [null] } },
		{ ...definition(), child: { id: 'leaf', unit: null } },
		...['id', 'type', 'sensor', 'css', 'tokens', 'config', 'rect'].map((field) => ({
			...definition(),
			child: { id: 'leaf', unit: { ...unit(), [field]: 42 } }
		})),
		{
			...definition(),
			child: { id: 'leaf', unit: { ...unit(), rect: { x: 'bad', y: 0, w: 1, h: 1 } } }
		},
		{
			...definition(),
			child: { id: 'leaf', unit: { ...unit(), rect: { x: 0, y: 'bad', w: 1, h: 1 } } }
		},
		{
			...definition(),
			child: { id: 'group', unit: { id: 'g', kind: 'group', size: null, child: leaf() } }
		},
		{
			...definition(),
			child: {
				id: 'group',
				unit: { id: 'g', kind: 'group', def: 42, size: { w: 1, h: 1 }, child: leaf() }
			}
		},
		{ ...definition(), params: {} },
		...[
			null,
			{ key: 42 },
			{ key: 'x', label: 42 },
			{ key: 'x', target: 42 },
			{ key: 'x', targets: {} },
			{ key: 'x', targets: [42] },
			{ key: 'x', choices: {} },
			{ key: 'x', choices: [null] },
			{ key: 'x', choices: [{ value: 42, label: 'A' }] },
			{ key: 'x', choices: [{ value: 'A', label: 42 }] }
		].map((param) => ({ ...definition(), params: [param] }))
	])('rejects malformed definition data before traversal: %j', (value) => {
		expect(validLibrary(library(value))).toBe(false);
	});

	it('rejects excessive tree depth without overflowing the scanner stack', () => {
		let tree: unknown = leaf();
		for (let i = 0; i < 70; i++) tree = { id: `row${i}`, kind: 'col', children: [tree] };
		expect(validLibrary(library({ ...definition(), child: tree }))).toBe(false);
	});

	it('rejects duplicate definition IDs that would make references ambiguous', () => {
		expect(validLibrary({ version: 1, defs: [definition(), definition()] })).toBe(false);
	});

	it('requires string token values and rejects arrays', () => {
		expect(stringMap({ '--np-fg': 'red' })).toBe(true);
		expect(stringMap({ '--np-fg': null })).toBe(false);
		expect(stringMap([])).toBe(false);
	});
});
