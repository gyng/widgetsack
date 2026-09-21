// useSacks owns the sacks/ + themes/ file I/O around the pure pack/unpack core, plus real branch
// logic worth pinning: the refreshSacks peek-mapping (def count / theme / token / unreadable null),
// the mid-def-edit export+import guards, the CSS-threat confirm gate, the theme name-collision
// (-imported) resolution, and the SINGLE import commit patch. We mock only the overlay adapter +
// window prompts, keep the real sack/cssThreats/mergeLibrary core, and assert observable effects.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { importSummary, sackNameError, sackSummary, useSacks } from './useSacks';
import { packSack } from '../../core/sack';
import type { Library } from '../../core/layoutTree';
import { container } from '../../core/layoutTree';
import type { EditorState } from './types';
import type { Themes } from './useThemes';

describe('sackNameError', () => {
	it('accepts the backend allowlist (letters, digits, spaces, _ -; 1–64 chars)', () => {
		expect(sackNameError('my sack_v2-final')).toBeNull();
		expect(sackNameError('  padded  ')).toBeNull(); // trimmed before the check
	});
	it('names the problem for an empty, over-long, or unsafe name', () => {
		expect(sackNameError('')).toBe('Enter a name for the sack');
		expect(sackNameError('   ')).toBe('Enter a name for the sack');
		expect(sackNameError('x'.repeat(65))).toBe('Keep the name under 64 characters');
		expect(sackNameError('../etc')).toBe('Use letters, numbers, spaces, _ or - only');
		expect(sackNameError('a:b')).toBe('Use letters, numbers, spaces, _ or - only');
	});
});

describe('importSummary', () => {
	it('lists what landed, singular/plural aware, omitting absent parts', () => {
		expect(importSummary({ widgets: 3, theme: 'Nord-imported', sandboxed: 1 })).toBe(
			'Imported 3 widgets · theme saved as Nord-imported · 1 iframe sandboxed'
		);
		expect(importSummary({ widgets: 1, theme: null, sandboxed: 2 })).toBe(
			'Imported 1 widget · 2 iframes sandboxed'
		);
		expect(importSummary({ widgets: 0, theme: null, sandboxed: 0 })).toBe('Imported 0 widgets');
	});
});

describe('sackSummary', () => {
	it('joins widgets, theme, and overrides with middots (singular/plural aware)', () => {
		expect(sackSummary({ name: 's', widgets: 5, theme: 'Nord', tokens: 3 })).toBe(
			'5 widgets · theme “Nord” · 3 token overrides'
		);
		expect(sackSummary({ name: 's', widgets: 1, theme: null, tokens: 1 })).toBe(
			'1 widget · 1 token override'
		);
	});

	it('reports an empty sack and an unreadable file distinctly', () => {
		expect(sackSummary({ name: 's', widgets: 0, theme: null, tokens: 0 })).toBe('empty');
		expect(sackSummary({ name: 's', widgets: null, theme: null, tokens: 0 })).toBe(
			'unreadable — not a sack?'
		);
	});
});

// --- the hook itself ---

const listSacks = vi.fn<() => Promise<string[]>>();
const readSack = vi.fn<(name: string) => Promise<string | null>>();
const writeSack = vi.fn<(name: string, json: string) => Promise<string | null>>();
const listThemes = vi.fn<() => Promise<string[]>>();
const resolveThemeCss = vi.fn<(id: string) => Promise<string>>();
const saveThemeCss = vi.fn<(name: string, css: string) => Promise<void>>();
vi.mock('../../overlay', () => ({
	listSacks: (...a: []) => listSacks(...a),
	readSack: (...a: [string]) => readSack(...a),
	writeSack: (...a: [string, string]) => writeSack(...a),
	listThemes: (...a: []) => listThemes(...a),
	resolveThemeCss: (...a: [string]) => resolveThemeCss(...a),
	saveThemeCss: (...a: [string, string]) => saveThemeCss(...a)
}));

const invoke = vi.fn<(cmd: string) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
	invoke: (cmd: string) => invoke(cmd)
}));

const themeLabel = vi.fn((n: string) => n || '(default)');
const setThemeList = vi.fn<(names: string[]) => void>();
const adoptTheme = vi.fn<(name: string) => Promise<void>>();

// A library with one def (so packSack keeps it).
function libWith(id = 'd1'): Library {
	return {
		version: 1,
		defs: [{ id, name: id, size: { w: 100, h: 60 }, child: container('c', 'col', []) }]
	};
}

type Opts = {
	navSection?: 'sacks' | 'settings';
	editingDefId?: string | null;
	selectedTheme?: string;
	library?: Library | undefined;
	tokenOverrides?: Record<string, string>;
};
function setup(opts: Opts = {}) {
	const commitOp = vi.fn<(run: (s: EditorState) => Partial<EditorState>) => void>();
	const themes: Pick<Themes, 'themeLabel' | 'setThemeList' | 'adoptTheme'> = {
		themeLabel,
		setThemeList,
		adoptTheme
	};
	const hook = renderHook(() =>
		useSacks({
			studio: true,
			navSection: opts.navSection ?? 'sacks',
			editingDefId: opts.editingDefId ?? null,
			selectedTheme: opts.selectedTheme ?? '',
			library: 'library' in opts ? opts.library : undefined,
			tokenOverrides: opts.tokenOverrides ?? {},
			commitOp,
			themes
		})
	);
	return { ...hook, commitOp };
}

beforeEach(() => {
	vi.restoreAllMocks();
	listSacks.mockReset().mockResolvedValue([]);
	readSack.mockReset().mockResolvedValue(null);
	writeSack.mockReset().mockResolvedValue('C:/cfg/sacks/x.sack.json');
	listThemes.mockReset().mockResolvedValue([]);
	resolveThemeCss.mockReset().mockResolvedValue('');
	saveThemeCss.mockReset().mockResolvedValue(undefined);
	themeLabel.mockClear();
	setThemeList.mockClear();
	adoptTheme.mockClear();
});

describe('refreshSacks (section-open peek)', () => {
	it('summarizes each sack: def count, theme name, token count — and flags unreadable files', async () => {
		listSacks.mockResolvedValue(['good', 'bad']);
		readSack.mockImplementation(async (name: string) =>
			name === 'good'
				? JSON.stringify(
						packSack({
							name: 'good',
							library: libWith(),
							theme: { name: 'Nord', css: 'x' },
							tokens: { '--a': '1', '--b': '2' }
						})
					)
				: 'not a sack'
		);
		const { result } = setup({ navSection: 'sacks' });
		await waitFor(() => expect(result.current.sackInfos).toHaveLength(2));
		const byName = Object.fromEntries(result.current.sackInfos.map((i) => [i.name, i]));
		expect(byName.good).toEqual({ name: 'good', widgets: 1, theme: 'Nord', tokens: 2 });
		// A file that doesn't parse as a sack → widgets:null (renders as "unreadable").
		expect(byName.bad).toEqual({ name: 'bad', widgets: null, theme: null, tokens: 0 });
	});

	it('reports zeros for a sack with no library/theme/tokens', async () => {
		listSacks.mockResolvedValue(['empty']);
		readSack.mockResolvedValue(JSON.stringify(packSack({ name: 'empty' })));
		const { result } = setup();
		await waitFor(() => expect(result.current.sackInfos).toHaveLength(1));
		expect(result.current.sackInfos[0]).toEqual({
			name: 'empty',
			widgets: 0,
			theme: null,
			tokens: 0
		});
	});

	it('flags a sack whose file read returns null as unreadable', async () => {
		listSacks.mockResolvedValue(['missing']);
		readSack.mockResolvedValue(null);
		const { result } = setup();
		await waitFor(() => expect(result.current.sackInfos).toHaveLength(1));
		expect(result.current.sackInfos[0]).toEqual({
			name: 'missing',
			widgets: null,
			theme: null,
			tokens: 0
		});
	});

	it('does not load while a different section is open', async () => {
		setup({ navSection: 'settings' });
		expect(listSacks).not.toHaveBeenCalled();
	});

	it('drops a stale section-open load once the section closes mid-flight', async () => {
		// listSacks resolves only AFTER the section flips away — the effect's cancel guard must drop
		// the late result instead of clobbering state for a section that is no longer open.
		let resolveNames!: (names: string[]) => void;
		listSacks.mockReturnValue(new Promise<string[]>((r) => (resolveNames = r)));
		const commitOp = vi.fn<(run: (s: EditorState) => Partial<EditorState>) => void>();
		const { result, rerender } = renderHook(
			(p: { navSection: 'sacks' | 'settings' }) =>
				useSacks({
					studio: true,
					navSection: p.navSection,
					editingDefId: null,
					selectedTheme: '',
					library: undefined,
					tokenOverrides: {},
					commitOp,
					themes: { themeLabel, setThemeList, adoptTheme }
				}),
			{ initialProps: { navSection: 'sacks' as 'sacks' | 'settings' } }
		);
		rerender({ navSection: 'settings' }); // cleanup flips the cancel guard
		await act(async () => {
			resolveNames(['late']);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(readSack).toHaveBeenCalledWith('late'); // the load DID finish…
		expect(result.current.sackInfos).toEqual([]); // …but the stale result never landed
	});
});

describe('exportSack', () => {
	it('refuses (alerts) mid def-edit', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		const { result } = setup({ editingDefId: 'd1', navSection: 'settings' });
		await act(async () => {
			await result.current.exportSack();
		});
		expect(alert).toHaveBeenCalledWith(expect.stringContaining('Finish editing'));
		expect(writeSack).not.toHaveBeenCalled();
	});

	it('the inline name is seeded from the active theme label, validated live, and editable', () => {
		themeLabel.mockReturnValue('Nord');
		const { result } = setup({ navSection: 'settings', selectedTheme: 'builtin:nord' });
		expect(result.current.exportName).toBe('Nord');
		expect(result.current.exportNameError).toBeNull();
		act(() => result.current.setExportName('bad/name'));
		expect(result.current.exportName).toBe('bad/name');
		expect(result.current.exportNameError).toBe('Use letters, numbers, spaces, _ or - only');
	});

	it('refuses an invalid name with an inline error (no write, no alert)', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		const { result } = setup({ navSection: 'settings' });
		act(() => result.current.setExportName(''));
		await act(async () => {
			await result.current.exportSack();
		});
		expect(writeSack).not.toHaveBeenCalled();
		expect(alert).not.toHaveBeenCalled();
		expect(result.current.notice).toEqual({ tone: 'error', text: 'Enter a name for the sack' });
		act(() => result.current.clearNotice());
		expect(result.current.notice).toBeNull();
	});

	it('packs library + resolved theme CSS + tokens, writes, and reports the saved path inline', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		resolveThemeCss.mockResolvedValue(':root{--np-accent:#abc}');
		themeLabel.mockReturnValue('Nord');
		writeSack.mockResolvedValue('C:/cfg/sacks/my-sack.sack.json');
		const lib = libWith();
		const { result } = setup({
			navSection: 'settings',
			selectedTheme: 'builtin:nord',
			library: lib,
			tokenOverrides: { '--x': '1' }
		});
		act(() => result.current.setExportName(' my-sack '));
		await act(async () => {
			await result.current.exportSack();
		});
		expect(resolveThemeCss).toHaveBeenCalledWith('builtin:nord');
		const [name, json] = writeSack.mock.calls[0];
		expect(name).toBe('my-sack'); // trimmed
		const sack = JSON.parse(json);
		expect(sack.library).toEqual(lib);
		expect(sack.theme).toEqual({ name: 'Nord', css: ':root{--np-accent:#abc}' });
		expect(sack.tokens).toEqual({ '--x': '1' });
		expect(alert).not.toHaveBeenCalled(); // success is an inline line, not a modal
		expect(result.current.notice).toEqual({
			tone: 'ok',
			text: 'Exported my-sack',
			path: 'C:/cfg/sacks/my-sack.sack.json'
		});
	});

	it('omits the theme (no resolve) when nothing is selected; a failed write alerts + shows an error line', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		writeSack.mockResolvedValue(null); // the backend rejected (writeSack logged + returned null)
		themeLabel.mockReturnValue(''); // empty label → the field seeds with the 'my-sack' default
		const { result } = setup({ navSection: 'settings', selectedTheme: '' });
		expect(result.current.exportName).toBe('my-sack');
		await act(async () => {
			await result.current.exportSack();
		});
		expect(resolveThemeCss).not.toHaveBeenCalled();
		expect(JSON.parse(writeSack.mock.calls[0][1]).theme).toBeUndefined();
		expect(alert).toHaveBeenCalledWith(
			expect.stringContaining('Could not write the sack "my-sack"')
		);
		expect(result.current.notice?.tone).toBe('error');
		expect(result.current.notice?.path).toBeUndefined();
	});
});

describe('revealSacksDir', () => {
	it('invokes the backend reveal command; a failure only warns', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		invoke.mockReset().mockResolvedValue(undefined);
		const { result } = setup({ navSection: 'settings' });
		await act(async () => {
			await result.current.revealSacksDir();
		});
		expect(invoke).toHaveBeenCalledWith('reveal_sacks_dir');
		invoke.mockRejectedValue(new Error('not registered'));
		await act(async () => {
			await result.current.revealSacksDir();
		});
		expect(warn).toHaveBeenCalledWith('reveal_sacks_dir failed', expect.any(Error));
	});
});

describe('importSack', () => {
	it('refuses (alerts) mid def-edit', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		const { result, commitOp } = setup({ editingDefId: 'd1', navSection: 'settings' });
		await act(async () => {
			await result.current.importSack('s');
		});
		expect(alert).toHaveBeenCalledWith(expect.stringContaining('Finish editing'));
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('alerts and bails on an unreadable sack', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		readSack.mockResolvedValue('garbage');
		const { result, commitOp } = setup({ navSection: 'settings' });
		await act(async () => {
			await result.current.importSack('s');
		});
		expect(alert).toHaveBeenCalledWith(expect.stringContaining('Could not read'));
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('also bails when readSack returns null', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		readSack.mockResolvedValue(null);
		const { result, commitOp } = setup({ navSection: 'settings' });
		await act(async () => {
			await result.current.importSack('gone');
		});
		expect(alert).toHaveBeenCalledWith(expect.stringContaining('Could not read'));
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('merges library + tokens + theme through ONE commit and live-applies the theme', async () => {
		const sack = packSack({
			name: 's',
			library: libWith('imp'),
			theme: { name: 'Imported', css: ':root{}' },
			tokens: { '--t': '9' }
		});
		readSack.mockResolvedValue(JSON.stringify(sack));
		listThemes.mockResolvedValue([]); // no collision
		const { result, commitOp } = setup({ navSection: 'settings' });
		await act(async () => {
			await result.current.importSack('s');
		});
		// The theme was written under its own (uncollided) name + the picker list refreshed.
		expect(saveThemeCss).toHaveBeenCalledWith('Imported', ':root{}');
		expect(setThemeList).toHaveBeenCalled();
		expect(result.current.notice?.text).toContain('theme saved as Imported');
		// ONE commit carries the merged library + tokens + selected theme.
		expect(commitOp).toHaveBeenCalledTimes(1);
		const patch = commitOp.mock.calls[0][0]({
			library: undefined,
			tokenOverrides: {}
		} as EditorState);
		expect(patch.library?.defs.map((d) => d.id)).toEqual(['imp']);
		expect(patch.tokenOverrides).toEqual({ '--t': '9' });
		expect(patch.selectedTheme).toBe('Imported');
		// Live-apply mirrored the committed selection onto the live CSS.
		expect(adoptTheme).toHaveBeenCalledWith('Imported');
	});

	it('resolves a theme-name collision by suffixing -imported', async () => {
		const sack = packSack({ name: 's', theme: { name: 'Nord', css: ':root{}' } });
		readSack.mockResolvedValue(JSON.stringify(sack));
		listThemes.mockResolvedValue(['Nord']); // collision!
		const { result } = setup({ navSection: 'settings' });
		await act(async () => {
			await result.current.importSack('s');
		});
		expect(saveThemeCss).toHaveBeenCalledWith('Nord-imported', ':root{}');
		expect(adoptTheme).toHaveBeenCalledWith('Nord-imported');
	});

	it('aborts the import without committing when its theme cannot be persisted', async () => {
		const sack = packSack({
			name: 's',
			library: libWith('imp'),
			theme: { name: 'Imported', css: ':root{}' },
			tokens: { '--t': '9' }
		});
		readSack.mockResolvedValue(JSON.stringify(sack));
		saveThemeCss.mockRejectedValue(new Error('disk full'));
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		const { result, commitOp } = setup({ navSection: 'settings' });

		await act(async () => {
			await result.current.importSack('s');
		});

		expect(commitOp).not.toHaveBeenCalled();
		expect(adoptTheme).not.toHaveBeenCalled();
		expect(alert).toHaveBeenCalledWith(expect.stringContaining('disk full'));
	});

	it('confirms before importing a theme whose CSS contains threats; declining aborts everything', async () => {
		const sack = packSack({
			name: 's',
			theme: { name: 'Evil', css: '@import url(https://evil.example/x.css);' }
		});
		readSack.mockResolvedValue(JSON.stringify(sack));
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
		const { result, commitOp } = setup({ navSection: 'settings' });
		await act(async () => {
			await result.current.importSack('s');
		});
		expect(confirm).toHaveBeenCalled();
		expect(saveThemeCss).not.toHaveBeenCalled();
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('proceeds when the threat confirm is accepted', async () => {
		const sack = packSack({
			name: 's',
			theme: { name: 'Risky', css: '@import url(https://evil.example/x.css);' }
		});
		readSack.mockResolvedValue(JSON.stringify(sack));
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		listThemes.mockResolvedValue([]);
		const { result, commitOp } = setup({ navSection: 'settings' });
		await act(async () => {
			await result.current.importSack('s');
		});
		expect(saveThemeCss).toHaveBeenCalledWith('Risky', expect.any(String));
		expect(commitOp).toHaveBeenCalledTimes(1);
	});

	it('states widget-tree threats in the SAME confirm and merges a hardened library', async () => {
		// A def carrying an unsandboxed iframe: the one confirm must mention the embedded page, and the
		// merged def must have its sandbox forced on (sanitizeSack) — the stranger's flag never lands.
		const lib: Library = {
			version: 1,
			defs: [
				{
					id: 'web',
					name: 'web',
					size: { w: 100, h: 60 },
					child: {
						id: 'fr',
						unit: {
							id: 'fr',
							type: 'iframe',
							rect: { x: 0, y: 0, w: 1, h: 1 },
							config: { url: 'https://dash.example', sandbox: false }
						}
					}
				}
			]
		};
		const sack = packSack({ name: 's', library: lib });
		readSack.mockResolvedValue(JSON.stringify(sack));
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
		const { result, commitOp } = setup({ navSection: 'settings' });
		await act(async () => {
			await result.current.importSack('s');
		});
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0][0]).toContain('1 embedded web page (unsandboxed)');
		expect(commitOp).toHaveBeenCalledTimes(1);
		const patch = commitOp.mock.calls[0][0]({
			library: undefined,
			tokenOverrides: {}
		} as unknown as EditorState);
		const merged = patch.library!.defs[0].child as { unit: { config: Record<string, unknown> } };
		expect(merged.unit.config.sandbox).toBe(true);
		// The result line reports what landed, incl. the hardening the user consented to.
		expect(result.current.notice).toEqual({
			tone: 'ok',
			text: 'Imported 1 widget · 1 iframe sandboxed'
		});
	});

	it('imports a theme-ONLY sack: the commit patch carries just the selection', async () => {
		// No library defs and no tokens → the commit patch must leave both untouched (the false arms
		// of the library/tokens guards), carrying only the newly-adopted theme name.
		const sack = packSack({ name: 's', theme: { name: 'Solo', css: ':root{}' } });
		readSack.mockResolvedValue(JSON.stringify(sack));
		listThemes.mockResolvedValue([]);
		const { result, commitOp } = setup({ navSection: 'settings' });
		await act(async () => {
			await result.current.importSack('s');
		});
		const patch = commitOp.mock.calls[0][0]({
			library: undefined,
			tokenOverrides: {}
		} as EditorState);
		expect(patch).toEqual({ selectedTheme: 'Solo' });
		expect(adoptTheme).toHaveBeenCalledWith('Solo');
	});

	it('an empty tokens object imports as a no-op patch (tokens present but zero keys)', async () => {
		// unpackSack passes the JSON through verbatim, so a hand-edited sack can carry `tokens: {}` —
		// the Object.keys length guard must not spread an empty override set into the state.
		readSack.mockResolvedValue(JSON.stringify({ kind: 'widgetsack/sack', version: 1, tokens: {} }));
		const { result, commitOp } = setup({ navSection: 'settings' });
		await act(async () => {
			await result.current.importSack('s');
		});
		const patch = commitOp.mock.calls[0][0]({
			library: undefined,
			tokenOverrides: {}
		} as EditorState);
		expect(patch).toEqual({});
		expect(adoptTheme).not.toHaveBeenCalled();
	});

	it('imports a themeless sack: commit applies only library/tokens, no theme adopt', async () => {
		const sack = packSack({ name: 's', library: libWith('only'), tokens: { '--z': '0' } });
		readSack.mockResolvedValue(JSON.stringify(sack));
		const { result, commitOp } = setup({ navSection: 'settings' });
		await act(async () => {
			await result.current.importSack('s');
		});
		expect(saveThemeCss).not.toHaveBeenCalled();
		expect(adoptTheme).not.toHaveBeenCalled();
		const patch = commitOp.mock.calls[0][0]({
			library: undefined,
			tokenOverrides: {}
		} as EditorState);
		expect(patch.selectedTheme).toBeUndefined();
		expect(patch.library?.defs.map((d) => d.id)).toEqual(['only']);
	});
});
