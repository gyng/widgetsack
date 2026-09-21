import { describe, expect, it } from 'vitest';
import type { WidgetInstance } from './layout';
import {
	container,
	emptyRoot,
	group,
	leaf,
	type LayoutNode,
	type Leaf,
	type MonitorLayout,
	type WidgetDef
} from './layoutTree';
import {
	isRemoteUrl,
	sanitizeImportedTree,
	scanDefsThreats,
	scanTreeThreats,
	treeThreatSummary
} from './treeThreats';

const unit = (
	id: string,
	type: string,
	config: Record<string, unknown> = {},
	extra: Partial<WidgetInstance> = {}
): WidgetInstance => ({ id, type, rect: { x: 0, y: 0, w: 10, h: 10 }, config, ...extra });

describe('isRemoteUrl', () => {
	it('is true for http(s) and protocol-relative, false for local/data/asset/non-strings', () => {
		expect(isRemoteUrl('https://x.example/a.png')).toBe(true);
		expect(isRemoteUrl('  HTTP://x.example')).toBe(true);
		expect(isRemoteUrl('//cdn.example/a.png')).toBe(true);
		expect(isRemoteUrl('wallpaper.jpg')).toBe(false);
		expect(isRemoteUrl('data:image/png;base64,AAAA')).toBe(false);
		expect(isRemoteUrl('asset://localhost/x.png')).toBe(false);
		expect(isRemoteUrl(undefined)).toBe(false);
		expect(isRemoteUrl(42)).toBe(false);
	});
});

describe('scanTreeThreats', () => {
	it('reports iframes with their url, sandbox-off and click-catching flags', () => {
		const tree = container('r', 'col', [
			leaf(unit('f1', 'iframe', { url: 'https://dash.example', sandbox: false, interact: true })),
			leaf(unit('f2', 'iframe', { url: 'https://ok.example' })),
			leaf(unit('f3', 'iframe', {}))
		]);
		const t = scanTreeThreats(tree);
		expect(t).toEqual([
			{ kind: 'iframe', id: 'f1', detail: 'https://dash.example' },
			{ kind: 'iframe-unsandboxed', id: 'f1', detail: 'sandbox: false' },
			{ kind: 'iframe-interactive', id: 'f1', detail: 'interact: true' },
			{ kind: 'iframe', id: 'f2', detail: 'https://ok.example' },
			{ kind: 'iframe', id: 'f3', detail: '(no url)' }
		]);
	});

	it('reports remote image units but not local wallpapers / data URLs', () => {
		const tree = container('r', 'row', [
			leaf(unit('i1', 'image', { src: 'https://evil.example/beacon.png' })),
			leaf(unit('i2', 'image', { src: 'photo.jpg' })),
			leaf(unit('i3', 'image', { src: 'data:image/png;base64,AAAA' })),
			leaf(unit('g', 'gauge', { label: 'https://not-an-image.example' }))
		]);
		expect(scanTreeThreats(tree)).toEqual([
			{ kind: 'remote-image', id: 'i1', detail: 'https://evil.example/beacon.png' }
		]);
	});

	it('reports button macros as a domain.service list (malformed actions are ignored)', () => {
		const tree = leaf(
			unit('b', 'button', {
				actions: [
					{ domain: 'lock', service: 'unlock', data: { entity_id: 'lock.front' } },
					{ domain: 'media', service: 'next' },
					{ nope: true },
					'garbage'
				]
			})
		);
		expect(scanTreeThreats(tree)).toEqual([
			{ kind: 'button-macro', id: 'b', detail: 'lock.unlock, media.next' }
		]);
		expect(scanTreeThreats(leaf(unit('b2', 'button', { actions: [] })))).toEqual([]);
		expect(scanTreeThreats(leaf(unit('b3', 'button', { label: 'x' })))).toEqual([]);
	});

	it('reports CSS threats in unit css and token values, and descends into groups', () => {
		const inner = leaf(
			unit('deep', 'text', {}, { tokens: { '--np-bg': 'url(https://evil.example/t.png)' } })
		);
		const grp = group('grp', { w: 1, h: 1 }, inner, {
			css: '.x { position: fixed }',
			tokens: { '--np-accent': 'gold' }
		});
		const tree = container('r', 'col', [leaf(grp), leaf(unit('plain', 'gauge'))]);
		const t = scanTreeThreats(tree);
		expect(t).toEqual([
			{ kind: 'css', id: 'grp', detail: 'overlay: position: fixed' },
			{ kind: 'css', id: 'deep', detail: 'remote-url: url(https://evil.example/t.png' }
		]);
	});

	it('scans a def (its own css + child tree) and a whole monitor layout (background + floating)', () => {
		const def: WidgetDef = {
			id: 'd',
			name: 'd',
			size: { w: 1, h: 1 },
			child: leaf(unit('f', 'iframe', { url: 'https://a.example' })),
			css: '@import url(https://evil.example/x.css);'
		};
		const t = scanTreeThreats(def);
		expect(t.map((x) => `${x.kind}@${x.id}`)).toEqual(['css@d', 'css@d', 'iframe@f']);

		const mon: MonitorLayout = {
			root: emptyRoot(),
			floating: [leaf(unit('img', 'image', { src: '//cdn.example/a.png' }))],
			background: { kind: 'web', src: 'https://wall.example' }
		};
		expect(scanTreeThreats(mon)).toEqual([
			{ kind: 'remote-background', id: 'background', detail: 'https://wall.example' },
			{ kind: 'remote-image', id: 'img', detail: '//cdn.example/a.png' }
		]);
		// a local wallpaper / no background is not a threat
		expect(
			scanTreeThreats({
				root: emptyRoot(),
				floating: [],
				background: { kind: 'image', src: 'w.jpg' }
			})
		).toEqual([]);
		expect(scanTreeThreats({ root: emptyRoot(), floating: [] })).toEqual([]);
	});

	it('de-duplicates identical sites and truncates long details', () => {
		const long = `https://evil.example/${'a'.repeat(100)}`;
		const tree = container('r', 'col', [
			leaf(unit('a', 'image', { src: long })),
			leaf(unit('a', 'image', { src: long }))
		]);
		const t = scanTreeThreats(tree);
		expect(t).toHaveLength(1);
		expect(t[0].detail.length).toBe(78);
		expect(t[0].detail.endsWith('…')).toBe(true);
	});

	it('skips malformed nodes/units instead of throwing (a hand-edited sack)', () => {
		const ghostChildren = { id: 'c', kind: 'col', children: 'nope' } as unknown as LayoutNode;
		const ghostUnit = { id: 'l', unit: 'nope' } as unknown as LayoutNode;
		const noConfig = leaf({
			id: 'nc',
			type: 'iframe',
			rect: { x: 0, y: 0, w: 1, h: 1 }
		} as WidgetInstance);
		const noChildGroup = leaf({
			id: 'g',
			kind: 'group',
			size: { w: 1, h: 1 }
		} as unknown as Leaf['unit']);
		const badTokens = leaf(
			unit('bt', 'gauge', {}, { tokens: 'x' as unknown as Record<string, string> })
		);
		const numTokens = leaf(
			unit('nt', 'gauge', {}, { tokens: { '--np-x': 5 as unknown as string } })
		);
		const tree = container('r', 'col', [
			ghostChildren,
			ghostUnit,
			null as unknown as LayoutNode,
			noConfig,
			noChildGroup,
			badTokens,
			numTokens
		]);
		expect(scanTreeThreats(tree)).toEqual([{ kind: 'iframe', id: 'nc', detail: '(no url)' }]);
	});

	it('scanDefsThreats flattens across defs', () => {
		const mk = (id: string, src: string): WidgetDef => ({
			id,
			name: id,
			size: { w: 1, h: 1 },
			child: leaf(unit(`${id}-img`, 'image', { src }))
		});
		const t = scanDefsThreats([mk('a', 'https://a.example/x'), mk('b', 'local.png')]);
		expect(t.map((x) => x.id)).toEqual(['a-img']);
	});
});

describe('treeThreatSummary', () => {
	it('is empty for no threats and words each kind for a non-expert', () => {
		expect(treeThreatSummary([])).toBe('');
		const s = treeThreatSummary([
			{ kind: 'iframe', id: 'f', detail: 'https://a' },
			{ kind: 'iframe-unsandboxed', id: 'f', detail: 'sandbox: false' },
			{ kind: 'iframe-interactive', id: 'f', detail: 'interact: true' },
			{ kind: 'remote-image', id: 'i', detail: 'https://b' },
			{ kind: 'remote-background', id: 'background', detail: 'https://c' },
			{ kind: 'button-macro', id: 'b', detail: 'lock.unlock' },
			{ kind: 'css', id: 'x', detail: 'overlay: position: fixed' }
		]);
		expect(s).toBe(
			'1 embedded web page (unsandboxed, click-catching), 2 remote images (could phone home), ' +
				'1 button that runs service calls, 1 CSS rule that reaches outside the app'
		);
	});

	it('uses plurals and omits absent kinds', () => {
		const s = treeThreatSummary([
			{ kind: 'iframe', id: 'f', detail: 'https://a' },
			{ kind: 'iframe', id: 'g', detail: 'https://b' },
			{ kind: 'button-macro', id: 'b', detail: 'lock.unlock' },
			{ kind: 'button-macro', id: 'c', detail: 'lock.open' },
			{ kind: 'css', id: 'x', detail: 'import: @import' },
			{ kind: 'css', id: 'y', detail: 'import: @import 2' }
		]);
		expect(s).toBe(
			'2 embedded web pages, 2 buttons that run service calls, 2 CSS rules that reach outside the app'
		);
		expect(treeThreatSummary([{ kind: 'remote-image', id: 'i', detail: 'https://b' }])).toBe(
			'1 remote image (could phone home)'
		);
	});
});

describe('sanitizeImportedTree', () => {
	it('forces sandbox on for every iframe unit (nested in containers and groups), counting changes', () => {
		const inner = leaf(unit('deep', 'iframe', { url: 'https://a', sandbox: false }));
		const tree = container('r', 'col', [
			leaf(unit('f1', 'iframe', { url: 'https://b', sandbox: 0 })),
			container('c', 'row', [leaf(unit('f2', 'iframe', { url: 'https://c', sandbox: true }))]),
			leaf(group('grp', { w: 1, h: 1 }, inner, {})),
			leaf(unit('g', 'gauge'))
		]);
		const before = JSON.stringify(tree);
		const { value, changed } = sanitizeImportedTree(tree);
		expect(changed).toBe(2);
		expect(JSON.stringify(tree)).toBe(before); // input untouched
		const t = scanTreeThreats(value);
		expect(t.filter((x) => x.kind === 'iframe-unsandboxed')).toEqual([]);
		expect(t.filter((x) => x.kind === 'iframe')).toHaveLength(3);
		// unchanged subtrees keep their identity (structural sharing)
		expect((value as typeof tree).children[1]).toBe(tree.children[1]);
		expect((value as typeof tree).children[3]).toBe(tree.children[3]);
	});

	it('returns the same object when nothing needs changing (an absent sandbox key means the default: on)', () => {
		const tree = container('r', 'col', [
			leaf(unit('f', 'iframe', { url: 'https://a' })),
			leaf(group('grp', { w: 1, h: 1 }, leaf(unit('x', 'text')), {}))
		]);
		const r = sanitizeImportedTree(tree);
		expect(r.changed).toBe(0);
		expect(r.value).toBe(tree);
	});

	it('handles a def and a monitor layout (root + floating), returning them unchanged when clean', () => {
		const def: WidgetDef = {
			id: 'd',
			name: 'd',
			size: { w: 1, h: 1 },
			child: leaf(unit('f', 'iframe', { url: 'https://a', sandbox: false }))
		};
		const fixed = sanitizeImportedTree(def);
		expect(fixed.changed).toBe(1);
		expect(fixed.value).not.toBe(def);
		expect(((fixed.value.child as Leaf).unit as WidgetInstance).config.sandbox).toBe(true);
		expect(((def.child as Leaf).unit as WidgetInstance).config.sandbox).toBe(false);
		const cleanDef: WidgetDef = { ...def, child: leaf(unit('t', 'text')) };
		expect(sanitizeImportedTree(cleanDef).value).toBe(cleanDef);

		const mon: MonitorLayout = {
			root: container('root', 'col', [leaf(unit('f1', 'iframe', { sandbox: false }))]),
			floating: [leaf(unit('f2', 'iframe', { sandbox: 'false' })), leaf(unit('t', 'text'))]
		};
		const m = sanitizeImportedTree(mon);
		expect(m.changed).toBe(2);
		expect(m.value).not.toBe(mon);
		expect(scanTreeThreats(m.value).some((x) => x.kind === 'iframe-unsandboxed')).toBe(false);
		expect(m.value.floating[1]).toBe(mon.floating[1]);
		const cleanMon: MonitorLayout = { root: emptyRoot(), floating: [leaf(unit('t', 'text'))] };
		expect(sanitizeImportedTree(cleanMon).value).toBe(cleanMon);
	});

	it('leaves malformed nodes / units alone (no throw, no change)', () => {
		const ghostChildren = { id: 'c', kind: 'col', children: 'nope' } as unknown as LayoutNode;
		const ghostUnit = { id: 'l', unit: 'nope' } as unknown as LayoutNode;
		const noChildGroup = leaf({
			id: 'g',
			kind: 'group',
			size: { w: 1, h: 1 }
		} as unknown as Leaf['unit']);
		const noConfig = leaf({
			id: 'nc',
			type: 'iframe',
			rect: { x: 0, y: 0, w: 1, h: 1 }
		} as WidgetInstance);
		const tree = container('r', 'col', [
			ghostChildren,
			ghostUnit,
			null as unknown as LayoutNode,
			noChildGroup,
			noConfig
		]);
		const r = sanitizeImportedTree(tree);
		expect(r.changed).toBe(0);
		expect(r.value).toBe(tree);
	});
});
