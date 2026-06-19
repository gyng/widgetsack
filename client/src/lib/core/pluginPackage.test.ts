import { describe, expect, it } from 'vitest';
import {
	consentFingerprint,
	enableConsentMessage,
	MAX_SOURCE_REQUESTS,
	MAX_SOURCE_SAMPLES,
	packageSensorId,
	packageTemplateId,
	packageTemplates,
	parseInstallSidecar,
	parsePluginPackage,
	reinstallSource,
	validateSourceRequests,
	validateSourceSamples,
	versionsDiffer
} from './pluginPackage';
import { isLeaf } from './layoutTree';

// A minimal valid leaf node (a clock widget) the structural whitelist accepts.
const leafNode = (id = 'w1') => ({
	id,
	unit: { id, type: 'clock', rect: { x: 0, y: 0, w: 160, h: 40 }, config: { format: 'HH:mm' } }
});

const manifest = (over: Record<string, unknown> = {}) =>
	JSON.stringify({
		manifestVersion: 1,
		id: 'weather-pack',
		name: 'Weather pack',
		version: '1.0.0',
		templates: [
			{
				id: 'clock-tpl',
				name: 'Big clock',
				size: { w: 200, h: 80 },
				params: [{ key: 'format', label: 'format', target: 'unit.config.format' }],
				tree: leafNode()
			}
		],
		...over
	});

describe('parsePluginPackage', () => {
	it('accepts a valid manifest and maps its template', () => {
		const r = parsePluginPackage('weather-pack', manifest());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.pkg.manifest.name).toBe('Weather pack');
		expect(r.pkg.manifest.templates).toHaveLength(1);
		expect(r.pkg.warnings).toEqual([]);
	});

	it('rejects bad JSON, a wrong manifestVersion, and a folder/id mismatch', () => {
		expect(parsePluginPackage('weather-pack', '{nope').ok).toBe(false);
		expect(parsePluginPackage('weather-pack', manifest({ manifestVersion: 2 })).ok).toBe(false);
		const mismatch = parsePluginPackage('other-folder', manifest());
		expect(mismatch.ok).toBe(false);
		if (!mismatch.ok) expect(mismatch.reason).toContain('does not match its folder');
	});

	it('drops a malformed template with a warning but keeps the package', () => {
		const r = parsePluginPackage(
			'weather-pack',
			manifest({
				templates: [
					{ id: 'bad', name: 'Bad', size: { w: 10, h: 10 }, tree: { not: 'a node' } },
					{ id: 'good', name: 'Good', size: { w: 10, h: 10 }, tree: leafNode('g1') }
				]
			})
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.pkg.manifest.templates.map((t) => t.id)).toEqual(['good']);
		expect(r.pkg.warnings[0]).toContain('"bad" dropped');
	});

	it('drops a template whose param path walks the prototype chain', () => {
		const r = parsePluginPackage(
			'weather-pack',
			manifest({
				templates: [
					{
						id: 'evil',
						name: 'Evil',
						size: { w: 10, h: 10 },
						params: [{ key: '__proto__.polluted' }],
						tree: leafNode()
					}
				]
			})
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.pkg.manifest.templates).toEqual([]);
		expect(r.pkg.warnings[0]).toContain('malformed param spec');
	});

	it('drops a theme whose file is not a plain .css name', () => {
		const r = parsePluginPackage(
			'weather-pack',
			manifest({ theme: { name: 'Sky', file: '../escape.css' } })
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.pkg.manifest.theme).toBeUndefined();
		expect(r.pkg.warnings[0]).toContain('theme dropped');
	});

	it('carries optional metadata (description/author/homepage) through when present', () => {
		const r = parsePluginPackage(
			'weather-pack',
			manifest({ description: 'Live weather', author: 'Acme', homepage: 'https://acme.dev' })
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.pkg.manifest.description).toBe('Live weather');
		expect(r.pkg.manifest.author).toBe('Acme');
		expect(r.pkg.manifest.homepage).toBe('https://acme.dev');
	});

	it('accepts a valid theme and a template with a description', () => {
		const r = parsePluginPackage(
			'weather-pack',
			manifest({
				theme: { name: 'Sky', file: 'sky.css' },
				templates: [
					{
						id: 'desc-tpl',
						name: 'Has desc',
						description: 'a described template',
						size: { w: 10, h: 10 },
						tree: leafNode()
					}
				]
			})
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.pkg.manifest.theme).toEqual({ name: 'Sky', file: 'sky.css' });
		expect(r.pkg.manifest.templates[0].description).toBe('a described template');
		expect(r.pkg.warnings).toEqual([]);
	});

	it('rejects the manifest-level required-string fields when missing/blank/non-string', () => {
		// non-object / array JSON
		expect(parsePluginPackage('weather-pack', '"a string"').ok).toBe(false);
		expect(parsePluginPackage('weather-pack', '[1,2]').ok).toBe(false);
		// id missing
		const noId = parsePluginPackage('weather-pack', JSON.stringify({ manifestVersion: 1 }));
		expect(noId.ok).toBe(false);
		if (!noId.ok) expect(noId.reason).toContain('"id"');
		// name blank (string but trims empty) and non-string version
		const blankName = parsePluginPackage('weather-pack', manifest({ name: '   ' }));
		expect(blankName.ok).toBe(false);
		if (!blankName.ok) expect(blankName.reason).toContain('"name"');
		const badVer = parsePluginPackage('weather-pack', manifest({ version: 42 }));
		expect(badVer.ok).toBe(false);
		if (!badVer.ok) expect(badVer.reason).toContain('"version"');
	});

	it('rejects non-string optional metadata (description/author/homepage)', () => {
		for (const [field, label] of [
			['description', '"description"'],
			['author', '"author"'],
			['homepage', '"homepage"']
		] as const) {
			const r = parsePluginPackage('weather-pack', manifest({ [field]: 123 }));
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toContain(label);
		}
	});

	it('rejects a non-array "templates" outright', () => {
		const r = parsePluginPackage('weather-pack', manifest({ templates: 'nope' }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain('"templates" must be an array');
	});

	it('drops a duplicate template id (second occurrence) with a warning', () => {
		const r = parsePluginPackage(
			'weather-pack',
			manifest({
				templates: [
					{ id: 'dup', name: 'First', size: { w: 10, h: 10 }, tree: leafNode('a') },
					{ id: 'dup', name: 'Second', size: { w: 10, h: 10 }, tree: leafNode('b') }
				]
			})
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.pkg.manifest.templates.map((t) => t.name)).toEqual(['First']);
		expect(r.pkg.warnings.some((w) => w.includes('duplicate id'))).toBe(true);
	});
});

describe('parsePluginPackage — template + param validation', () => {
	const tpl = (over: Record<string, unknown>) =>
		parsePluginPackage(
			'weather-pack',
			manifest({
				templates: [{ id: 't', name: 'T', size: { w: 10, h: 10 }, tree: leafNode(), ...over }]
			})
		);
	const warn = (over: Record<string, unknown>): string => {
		const r = tpl(over);
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('unreachable');
		expect(r.pkg.manifest.templates).toEqual([]); // the only template was dropped
		return r.pkg.warnings[0];
	};

	it('drops a template that is not an object', () => {
		const r = parsePluginPackage('weather-pack', manifest({ templates: ['nope'] }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.pkg.warnings[0]).toContain('not an object');
	});

	it('drops a template with a missing id, blank name, non-string description, or bad size', () => {
		expect(
			parsePluginPackage(
				'weather-pack',
				manifest({ templates: [{ name: 'X', size: { w: 1, h: 1 }, tree: leafNode() }] })
			)
		).toMatchObject({ ok: true });
		// blank name (string-but-trims-empty)
		expect(warn({ name: '  ' })).toContain('missing "name"');
		// non-string description
		expect(warn({ description: 9 })).toContain('"description" must be a string');
		// bad size: missing, non-numeric, zero/negative, NaN
		expect(warn({ size: undefined })).toContain('"size"');
		expect(warn({ size: { w: 'x', h: 1 } })).toContain('"size"');
		expect(warn({ size: { w: 0, h: 5 } })).toContain('"size"');
		expect(warn({ size: { w: NaN, h: 5 } })).toContain('"size"');
		expect(warn({ size: null })).toContain('"size"');
	});

	it('drops a template whose "params" is not an array', () => {
		expect(warn({ params: 'nope' })).toContain('"params" must be an array');
	});

	it('drops a template with a non-object param spec or an invalid key', () => {
		expect(warn({ params: ['nope'] })).toContain('malformed param spec');
		expect(warn({ params: [{ key: '' }] })).toContain('malformed param spec'); // empty key
		expect(warn({ params: [{}] })).toContain('malformed param spec'); // missing key
	});

	it('drops a param whose key has an empty path segment (a.. / trailing dot)', () => {
		// isSafePath rejects empty segments — `a..b` splits to ['a','','b'] (length-0 middle segment).
		expect(warn({ params: [{ key: 'a..b' }] })).toContain('malformed param spec');
	});

	it('drops a param whose target is an empty string (isSafePath rejects the empty path)', () => {
		// key passes (non-empty), but the empty-string target trips isSafePath's `!v.length` guard.
		expect(warn({ params: [{ key: 'k', target: '' }] })).toContain('malformed param spec');
	});

	it('drops a param with a non-string label, bad target, bad targets, or bad choices', () => {
		expect(warn({ params: [{ key: 'k', label: 42 }] })).toContain('malformed param spec');
		expect(warn({ params: [{ key: 'k', target: '__proto__.x' }] })).toContain('malformed');
		expect(warn({ params: [{ key: 'k', targets: 'nope' }] })).toContain('malformed');
		expect(warn({ params: [{ key: 'k', targets: ['ok', 'constructor'] }] })).toContain('malformed');
		expect(warn({ params: [{ key: 'k', choices: 'nope' }] })).toContain('malformed');
		expect(warn({ params: [{ key: 'k', choices: [{ value: 'v' }] }] })).toContain('malformed'); // no label
		expect(warn({ params: [{ key: 'k', choices: ['nope'] }] })).toContain('malformed'); // non-object choice
	});

	it('accepts a fully-populated param (label/default/target/targets/choices) and clones it', () => {
		const r = tpl({
			params: [
				{
					key: 'k',
					label: 'K',
					default: 7,
					target: 'unit.config.k',
					targets: ['unit.config.a', 'unit.config.b'],
					choices: [
						{ value: 'x', label: 'X' },
						{ value: 'y', label: 'Y' }
					]
				}
			]
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const spec = r.pkg.manifest.templates[0].params![0];
		expect(spec).toEqual({
			key: 'k',
			label: 'K',
			default: 7,
			target: 'unit.config.k',
			targets: ['unit.config.a', 'unit.config.b'],
			choices: [
				{ value: 'x', label: 'X' },
				{ value: 'y', label: 'Y' }
			]
		});
	});

	it('keeps a template whose empty params array yields no "params" key', () => {
		const r = tpl({ params: [] });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.pkg.manifest.templates[0].params).toBeUndefined();
	});
});

describe('parsePluginPackage — theme validation', () => {
	const theme = (t: unknown) => {
		const r = parsePluginPackage('weather-pack', manifest({ theme: t }));
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('unreachable');
		return r.pkg;
	};

	it('drops a non-object theme, a theme with a blank name, and a non-string file', () => {
		expect(theme('nope').warnings[0]).toContain('theme dropped: not an object');
		expect(theme({ name: '  ', file: 'a.css' }).warnings[0]).toContain('missing "name"');
		expect(theme({ name: 'Ok', file: 123 }).warnings[0]).toContain('"file"'); // non-string file
		expect(theme({ name: 'Ok', file: 'a.b.css' }).warnings[0]).toContain('"file"'); // extra dot
		expect(theme({ name: 'Ok', file: 'a.json' }).warnings[0]).toContain('"file"'); // wrong ext
	});
});

describe('parsePluginPackage — source + sensors (Phase 2)', () => {
	const source = (over: Record<string, unknown> = {}) => ({
		file: 'source.js',
		pollSeconds: 60,
		hosts: ['api.open-meteo.com'],
		...over
	});
	const sensors = [
		{ id: 'temp', label: 'Temperature', unit: '°C' },
		{ id: 'humidity', label: 'Humidity', unit: '%' }
	];
	const parse = (over: Record<string, unknown>) => {
		const r = parsePluginPackage('weather-pack', manifest(over));
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('unreachable');
		return r.pkg;
	};

	it('accepts a valid source + sensors', () => {
		const pkg = parse({ source: source(), sensors });
		expect(pkg.manifest.source).toEqual({
			file: 'source.js',
			pollSeconds: 60,
			hosts: ['api.open-meteo.com']
		});
		expect(pkg.manifest.sensors).toEqual(sensors);
		expect(pkg.warnings).toEqual([]);
	});

	it('defaults sensors to [] and leaves source undefined when undeclared', () => {
		const pkg = parse({});
		expect(pkg.manifest.source).toBeUndefined();
		expect(pkg.manifest.sensors).toEqual([]);
		expect(pkg.warnings).toEqual([]);
	});

	it('clamps pollSeconds to [15, 3600] and defaults a missing one to 60', () => {
		expect(parse({ source: source({ pollSeconds: 1 }) }).manifest.source?.pollSeconds).toBe(15);
		expect(parse({ source: source({ pollSeconds: 99999 }) }).manifest.source?.pollSeconds).toBe(
			3600
		);
		expect(parse({ source: source({ pollSeconds: undefined }) }).manifest.source?.pollSeconds).toBe(
			60
		);
	});

	it('drops a source (with a warning) when the file is not a plain .js name', () => {
		for (const file of ['source.css', '../escape.js', 'a.b.js', 'noext', 'source.mjs']) {
			const pkg = parse({ source: source({ file }) });
			expect(pkg.manifest.source).toBeUndefined();
			expect(pkg.warnings[0]).toContain('source dropped');
		}
	});

	it('drops a source on bad hosts: empty, uppercase, scheme/port/path/wildcard, IP literal', () => {
		const bad = [
			[],
			['API.Open-Meteo.com'],
			['https://api.open-meteo.com'],
			['api.open-meteo.com:443'],
			['api.open-meteo.com/v1'],
			['*.open-meteo.com'],
			['192.168.1.10'],
			['ok.example.com', ''] // one bad entry poisons the list
		];
		for (const hosts of bad) {
			const pkg = parse({ source: source({ hosts }) });
			expect(pkg.manifest.source).toBeUndefined();
			expect(pkg.warnings[0]).toContain('"hosts"');
		}
	});

	it('drops a non-numeric pollSeconds with a warning', () => {
		const pkg = parse({ source: source({ pollSeconds: 'fast' }) });
		expect(pkg.manifest.source).toBeUndefined();
		expect(pkg.warnings[0]).toContain('pollSeconds');
	});

	it('drops a non-object source (e.g. null) and a non-array sensors block', () => {
		const nullSrc = parse({ source: null });
		expect(nullSrc.manifest.source).toBeUndefined();
		expect(nullSrc.warnings[0]).toContain('source dropped: not an object');
		const badSensors = parse({ source: source(), sensors: 'not-an-array' });
		expect(badSensors.manifest.sensors).toEqual([]);
		expect(badSensors.warnings[0]).toContain('sensors dropped: not an array');
	});

	it('drops malformed sensors (bad id, duplicate, non-string label) but keeps the package', () => {
		for (const bad of [
			[{ id: 'a/b' }],
			[{ id: 'x' }, { id: 'x' }],
			[{ id: 'x', label: 42 }],
			['nope']
		]) {
			const pkg = parse({ source: source(), sensors: bad });
			expect(pkg.manifest.sensors).toEqual([]);
			expect(pkg.warnings[0]).toContain('sensors dropped');
			expect(pkg.manifest.source).toBeDefined(); // source survives a sensors drop
		}
	});
});

describe('packageSensorId / consentFingerprint / enableConsentMessage', () => {
	it('namespaces sensor ids under pkg.<pkgId>.', () => {
		expect(packageSensorId('weather-pack', 'temp')).toBe('pkg.weather-pack.temp');
	});

	it('fingerprints hosts order-insensitively but change-sensitively', () => {
		expect(consentFingerprint(['b.com', 'a.com'])).toBe(consentFingerprint(['a.com', 'b.com']));
		expect(consentFingerprint(['a.com'])).not.toBe(consentFingerprint(['a.com', 'b.com']));
		expect(consentFingerprint(['a.com'])).not.toBe(consentFingerprint(['c.com']));
	});

	it('states the network facts, the css facts, or both in ONE message', () => {
		const net = enableConsentMessage({ hosts: ['api.open-meteo.com'], pollSeconds: 60 });
		expect(net).toContain('polls the network every 60s: api.open-meteo.com');
		expect(net).toContain('Enable?');
		const css = enableConsentMessage({ cssSummary: '1 remote import' });
		expect(css).toContain('theme contains 1 remote import');
		expect(css).toContain('Enable anyway?');
		const both = enableConsentMessage({
			cssSummary: '1 remote import',
			hosts: ['a.com', 'b.com'],
			pollSeconds: 300
		});
		expect(both).toContain('theme contains');
		expect(both).toContain('every 300s: a.com, b.com');
	});

	it('falls back to the default poll interval (60s) when hosts are given without pollSeconds', () => {
		const msg = enableConsentMessage({ hosts: ['a.com'] });
		expect(msg).toContain('polls the network every 60s: a.com');
	});

	it('renders an empty message (just the trailing prompt) when nothing is consent-worthy', () => {
		expect(enableConsentMessage({})).toBe('Enable?');
	});
});

describe('validateSourceRequests', () => {
	it('keeps https string URLs and reports everything else', () => {
		const r = validateSourceRequests(['https://a.com/x', 'http://a.com', 42, 'ftp://x']);
		expect(r.urls).toEqual(['https://a.com/x']);
		expect(r.dropped).toHaveLength(3);
	});

	it('caps at MAX_SOURCE_REQUESTS and rejects non-arrays', () => {
		const many = Array.from({ length: 20 }, (_, i) => `https://a.com/${i}`);
		const r = validateSourceRequests(many);
		expect(r.urls).toHaveLength(MAX_SOURCE_REQUESTS);
		expect(r.dropped[0]).toContain('cap');
		expect(validateSourceRequests('nope').urls).toEqual([]);
		expect(validateSourceRequests('nope').dropped[0]).toContain('array');
	});
});

describe('validateSourceSamples', () => {
	const declared = ['temp', 'label'];

	it('keeps declared finite-number and bounded-string samples', () => {
		const r = validateSourceSamples(declared, [
			{ sensor: 'temp', value: 21.5 },
			{ sensor: 'label', value: 'sunny' }
		]);
		expect(r.samples).toEqual([
			{ sensor: 'temp', value: 21.5 },
			{ sensor: 'label', value: 'sunny' }
		]);
		expect(r.dropped).toEqual([]);
	});

	it('drops undeclared sensors, non-finite numbers, oversized strings, junk entries', () => {
		const r = validateSourceSamples(declared, [
			{ sensor: 'sneaky', value: 1 },
			{ sensor: 'temp', value: Infinity },
			{ sensor: 'temp', value: NaN },
			{ sensor: 'label', value: 'x'.repeat(2000) },
			{ sensor: 'temp', value: { nested: true } },
			'junk',
			{ value: 1 }
		]);
		expect(r.samples).toEqual([]);
		expect(r.dropped).toHaveLength(7);
		expect(r.dropped[0]).toContain('undeclared sensor "sneaky"');
	});

	it('caps at MAX_SOURCE_SAMPLES and rejects non-arrays', () => {
		const many = Array.from({ length: 100 }, () => ({ sensor: 'temp', value: 1 }));
		const r = validateSourceSamples(declared, many);
		expect(r.samples).toHaveLength(MAX_SOURCE_SAMPLES);
		expect(r.dropped[0]).toContain('cap');
		expect(validateSourceSamples(declared, null).dropped[0]).toContain('array');
	});
});

describe('parseInstallSidecar', () => {
	const sidecar = (over: Record<string, unknown> = {}) =>
		JSON.stringify({
			source: 'acme/pack',
			ref: 'main',
			version: '1.0.0',
			installedAt: 1750000000000,
			...over
		});

	it('parses a valid sidecar', () => {
		expect(parseInstallSidecar(sidecar())).toEqual({
			source: 'acme/pack',
			ref: 'main',
			version: '1.0.0',
			installedAt: 1750000000000
		});
	});

	it('fails closed on missing/empty/bad fields, bad JSON, and non-strings', () => {
		expect(parseInstallSidecar(null)).toBeNull();
		expect(parseInstallSidecar(undefined)).toBeNull();
		expect(parseInstallSidecar('{nope')).toBeNull();
		expect(parseInstallSidecar('[1]')).toBeNull();
		expect(parseInstallSidecar(sidecar({ source: '' }))).toBeNull();
		expect(parseInstallSidecar(sidecar({ ref: 42 }))).toBeNull();
		expect(parseInstallSidecar(sidecar({ version: '  ' }))).toBeNull();
		expect(parseInstallSidecar(sidecar({ installedAt: 'soon' }))).toBeNull();
		expect(parseInstallSidecar(sidecar({ installedAt: Infinity }))).toBeNull();
	});
});

describe('versionsDiffer', () => {
	it('treats any string difference (ignoring padding) as an available update', () => {
		expect(versionsDiffer('1.0.0', '1.0.0')).toBe(false);
		expect(versionsDiffer(' 1.0.0 ', '1.0.0')).toBe(false);
		expect(versionsDiffer('1.0.0', '1.0.1')).toBe(true);
		expect(versionsDiffer('2.0.0', '1.0.0')).toBe(true); // downgrade still "differs"
	});
});

describe('reinstallSource', () => {
	const base = { source: 'acme/pack', version: '1.0.0', installedAt: 0 };
	it('round-trips main/direct installs verbatim and pins other refs as tree URLs', () => {
		expect(reinstallSource({ ...base, ref: 'main' })).toBe('acme/pack');
		expect(reinstallSource({ ...base, source: 'https://x.dev/p/plugin.json', ref: 'direct' })).toBe(
			'https://x.dev/p/plugin.json'
		);
		expect(reinstallSource({ ...base, ref: 'v2' })).toBe('https://github.com/acme/pack/tree/v2');
	});
});

describe('packageTemplates', () => {
	it('namespaces ids and hands out a fresh tree per call', () => {
		const r = parsePluginPackage('weather-pack', manifest());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const [tpl] = packageTemplates(r.pkg.manifest);
		expect(tpl.id).toBe(packageTemplateId('weather-pack', 'clock-tpl'));
		expect(tpl.params).toHaveLength(1);
		const a = tpl.tree();
		const b = tpl.tree();
		expect(a).toEqual(b);
		expect(a).not.toBe(b); // private copy per insert
		expect(isLeaf(a)).toBe(true);
	});

	it('omits the params key for a template that declares none', () => {
		const r = parsePluginPackage(
			'weather-pack',
			manifest({
				templates: [
					{ id: 'no-params', name: 'No params', size: { w: 10, h: 10 }, tree: leafNode() }
				]
			})
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const [tpl] = packageTemplates(r.pkg.manifest);
		expect(tpl.params).toBeUndefined();
		expect(tpl.description).toBe(''); // default when the template had no description
	});
});
