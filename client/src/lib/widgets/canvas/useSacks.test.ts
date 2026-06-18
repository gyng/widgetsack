// useSacks owns the sacks/ + themes/ file I/O around the pure pack/unpack core, plus real branch
// logic worth pinning: the refreshSacks peek-mapping (def count / theme / token / unreadable null),
// the mid-def-edit export+import guards, the CSS-threat confirm gate, the theme name-collision
// (-imported) resolution, and the SINGLE import commit patch. We mock only the overlay adapter +
// window prompts, keep the real sack/cssThreats/mergeLibrary core, and assert observable effects.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { sackSummary, useSacks } from './useSacks';
import { packSack } from '../../core/sack';
import type { Library } from '../../core/layoutTree';
import { container } from '../../core/layoutTree';
import type { EditorState } from './types';
import type { Themes } from './useThemes';

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

const listSacks = vi.fn<[], Promise<string[]>>();
const readSack = vi.fn<[string], Promise<string | null>>();
const writeSack = vi.fn<[string, string], Promise<string | null>>();
const listThemes = vi.fn<[], Promise<string[]>>();
const resolveThemeCss = vi.fn<[string], Promise<string>>();
const saveThemeCss = vi.fn<[string, string], Promise<void>>();
vi.mock('../../overlay', () => ({
	listSacks: (...a: []) => listSacks(...a),
	readSack: (...a: [string]) => readSack(...a),
	writeSack: (...a: [string, string]) => writeSack(...a),
	listThemes: (...a: []) => listThemes(...a),
	resolveThemeCss: (...a: [string]) => resolveThemeCss(...a),
	saveThemeCss: (...a: [string, string]) => saveThemeCss(...a)
}));

const themeLabel = vi.fn((n: string) => n || '(default)');
const setThemeList = vi.fn<[string[]], void>();
const adoptTheme = vi.fn<[string], Promise<void>>();

// A library with one def (so packSack keeps it).
function libWith(id = 'd1'): Library {
	return {
		version: 1,
		defs: [{ id, name: id, size: { w: 100, h: 60 }, child: container('c', 'col', []) }]
	};
}

type Opts = {
	navSection?: 'sacks' | 'widgets';
	editingDefId?: string | null;
	selectedTheme?: string;
	library?: Library | undefined;
	tokenOverrides?: Record<string, string>;
};
function setup(opts: Opts = {}) {
	const commitOp = vi.fn<[(s: EditorState) => Partial<EditorState>], void>();
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
		setup({ navSection: 'widgets' });
		expect(listSacks).not.toHaveBeenCalled();
	});
});

describe('exportSack', () => {
	it('refuses (alerts) mid def-edit', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		const { result } = setup({ editingDefId: 'd1', navSection: 'widgets' });
		await act(async () => {
			await result.current.exportSack();
		});
		expect(alert).toHaveBeenCalledWith(expect.stringContaining('Finish editing'));
		expect(writeSack).not.toHaveBeenCalled();
	});

	it('aborts when the name prompt is cancelled', async () => {
		vi.spyOn(window, 'prompt').mockReturnValue(null);
		const { result } = setup({ navSection: 'widgets' });
		await act(async () => {
			await result.current.exportSack();
		});
		expect(writeSack).not.toHaveBeenCalled();
	});

	it('packs library + resolved theme CSS + tokens, writes, and alerts the saved path', async () => {
		vi.spyOn(window, 'prompt').mockReturnValue('my-sack');
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		resolveThemeCss.mockResolvedValue(':root{--np-accent:#abc}');
		themeLabel.mockReturnValue('Nord');
		writeSack.mockResolvedValue('C:/cfg/sacks/my-sack.sack.json');
		const lib = libWith();
		const { result } = setup({
			navSection: 'widgets',
			selectedTheme: 'builtin:nord',
			library: lib,
			tokenOverrides: { '--x': '1' }
		});
		await act(async () => {
			await result.current.exportSack();
		});
		expect(resolveThemeCss).toHaveBeenCalledWith('builtin:nord');
		const [name, json] = writeSack.mock.calls[0];
		expect(name).toBe('my-sack');
		const sack = JSON.parse(json);
		expect(sack.library).toEqual(lib);
		expect(sack.theme).toEqual({ name: 'Nord', css: ':root{--np-accent:#abc}' });
		expect(sack.tokens).toEqual({ '--x': '1' });
		expect(alert).toHaveBeenCalledWith(expect.stringContaining('C:/cfg/sacks/my-sack.sack.json'));
	});

	it('omits the theme (no resolve) when nothing is selected, and skips the path alert when write returns null', async () => {
		const prompt = vi.spyOn(window, 'prompt').mockReturnValue('plain');
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		writeSack.mockResolvedValue(null); // write produced no path
		themeLabel.mockReturnValue(''); // empty label → prompt falls back to the 'my-sack' default
		const { result } = setup({ navSection: 'widgets', selectedTheme: '' });
		await act(async () => {
			await result.current.exportSack();
		});
		expect(resolveThemeCss).not.toHaveBeenCalled();
		expect(JSON.parse(writeSack.mock.calls[0][1]).theme).toBeUndefined();
		expect(prompt).toHaveBeenCalledWith(expect.any(String), 'my-sack'); // the || fallback default
		expect(alert).not.toHaveBeenCalled(); // no path → no "Saved sack" alert
	});
});

describe('importSack', () => {
	it('refuses (alerts) mid def-edit', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		const { result, commitOp } = setup({ editingDefId: 'd1', navSection: 'widgets' });
		await act(async () => {
			await result.current.importSack('s');
		});
		expect(alert).toHaveBeenCalledWith(expect.stringContaining('Finish editing'));
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('alerts and bails on an unreadable sack', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		readSack.mockResolvedValue('garbage');
		const { result, commitOp } = setup({ navSection: 'widgets' });
		await act(async () => {
			await result.current.importSack('s');
		});
		expect(alert).toHaveBeenCalledWith(expect.stringContaining('Could not read'));
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('also bails when readSack returns null', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		readSack.mockResolvedValue(null);
		const { result, commitOp } = setup({ navSection: 'widgets' });
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
		const { result, commitOp } = setup({ navSection: 'widgets' });
		await act(async () => {
			await result.current.importSack('s');
		});
		// The theme was written under its own (uncollided) name + the picker list refreshed.
		expect(saveThemeCss).toHaveBeenCalledWith('Imported', ':root{}');
		expect(setThemeList).toHaveBeenCalled();
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
		const { result } = setup({ navSection: 'widgets' });
		await act(async () => {
			await result.current.importSack('s');
		});
		expect(saveThemeCss).toHaveBeenCalledWith('Nord-imported', ':root{}');
		expect(adoptTheme).toHaveBeenCalledWith('Nord-imported');
	});

	it('confirms before importing a theme whose CSS contains threats; declining aborts everything', async () => {
		const sack = packSack({
			name: 's',
			theme: { name: 'Evil', css: '@import url(https://evil.example/x.css);' }
		});
		readSack.mockResolvedValue(JSON.stringify(sack));
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
		const { result, commitOp } = setup({ navSection: 'widgets' });
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
		const { result, commitOp } = setup({ navSection: 'widgets' });
		await act(async () => {
			await result.current.importSack('s');
		});
		expect(saveThemeCss).toHaveBeenCalledWith('Risky', expect.any(String));
		expect(commitOp).toHaveBeenCalledTimes(1);
	});

	it('imports a themeless sack: commit applies only library/tokens, no theme adopt', async () => {
		const sack = packSack({ name: 's', library: libWith('only'), tokens: { '--z': '0' } });
		readSack.mockResolvedValue(JSON.stringify(sack));
		const { result, commitOp } = setup({ navSection: 'widgets' });
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
