// useThemes wires the themes/ file I/O AROUND the selected-theme state, but it carries real logic
// worth pinning: themeLabel (built-in catalog name / '(default)' / filename), the duplicate-name
// collision loop (-copy / -copyN), the destructive-overwrite confirm guard, the built-in FORK
// branch in the editor, the delete-active-theme fallback to default, adoptTheme/setTheme CSS swaps,
// and the per-user-theme swatch effect. We mock only the overlay adapter + window prompts, keep the
// real tokens/builtinThemes core, and assert observable state + the dispatch/commit it drives.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useThemes } from './useThemes';
import type { EditorModel } from './useEditorModel';

const resolveThemeCss = vi.fn<[string], Promise<string>>();
const loadThemeCss = vi.fn<[string], Promise<string>>();
const listThemes = vi.fn<[], Promise<string[]>>();
const saveThemeCss = vi.fn<[string, string], Promise<void>>();
const deleteThemeCss = vi.fn<[string], Promise<void>>();
vi.mock('../../overlay', () => ({
	resolveThemeCss: (...a: [string]) => resolveThemeCss(...a),
	loadThemeCss: (...a: [string]) => loadThemeCss(...a),
	listThemes: (...a: []) => listThemes(...a),
	saveThemeCss: (...a: [string, string]) => saveThemeCss(...a),
	deleteThemeCss: (...a: [string]) => deleteThemeCss(...a)
}));

function setup(opts: { studio?: boolean; selectedTheme?: string } = {}) {
	const dispatch = vi.fn() as unknown as EditorModel['dispatch'];
	const commitOp = vi.fn() as unknown as EditorModel['commitOp'];
	const hook = renderHook(
		(p: { studio: boolean; selectedTheme: string }) =>
			useThemes({ studio: p.studio, selectedTheme: p.selectedTheme, dispatch, commitOp }),
		{
			initialProps: {
				studio: opts.studio ?? true,
				selectedTheme: opts.selectedTheme ?? ''
			}
		}
	);
	return {
		...hook,
		dispatch: dispatch as unknown as ReturnType<typeof vi.fn>,
		commitOp: commitOp as unknown as ReturnType<typeof vi.fn>
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
	resolveThemeCss.mockReset().mockResolvedValue('/*resolved*/');
	loadThemeCss.mockReset().mockResolvedValue('/*loaded*/');
	listThemes.mockReset().mockResolvedValue([]);
	saveThemeCss.mockReset().mockResolvedValue(undefined);
	deleteThemeCss.mockReset().mockResolvedValue(undefined);
});

describe('themeLabel', () => {
	it('maps a built-in selection to its catalog name, blank to (default), and a user name verbatim', () => {
		const { result } = setup();
		expect(result.current.themeLabel('builtin:nord')).toBe('Nord');
		expect(result.current.themeLabel('')).toBe('(default)');
		expect(result.current.themeLabel('mytheme.css')).toBe('mytheme.css');
		// An unknown built-in id falls back to the bare id.
		expect(result.current.themeLabel('builtin:does-not-exist')).toBe('does-not-exist');
	});
});

describe('applyTheme / adoptTheme / setTheme (CSS swaps)', () => {
	it('applyTheme re-resolves the CURRENT selection into themeCss', async () => {
		resolveThemeCss.mockResolvedValue('/*current*/');
		const { result } = setup({ selectedTheme: 'builtin:nord' });
		await act(async () => {
			await result.current.applyTheme();
		});
		expect(resolveThemeCss).toHaveBeenCalledWith('builtin:nord');
		expect(result.current.themeCss).toBe('/*current*/');
	});

	it('adoptTheme swaps the live CSS WITHOUT dispatching', async () => {
		resolveThemeCss.mockResolvedValue('/*adopted*/');
		const { result, dispatch } = setup();
		await act(async () => {
			await result.current.adoptTheme('imported');
		});
		expect(result.current.themeCss).toBe('/*adopted*/');
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('setTheme dispatches setTheme, swaps CSS, and commits (a history no-op write)', async () => {
		resolveThemeCss.mockResolvedValue('/*set*/');
		const { result, dispatch, commitOp } = setup();
		await act(async () => {
			result.current.setTheme('builtin:dark');
		});
		expect(dispatch).toHaveBeenCalledWith({ type: 'setTheme', name: 'builtin:dark' });
		expect(commitOp).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(result.current.themeCss).toBe('/*set*/'));
	});
});

describe('theme editor dialog', () => {
	it('opens a USER theme in place: seeds the draft from its file CSS', async () => {
		loadThemeCss.mockResolvedValue('.user{}');
		const { result } = setup();
		await act(async () => {
			await result.current.openThemeEditor('mine');
		});
		expect(result.current.themeEditorOpen).toBe(true);
		expect(result.current.themeDraftName).toBe('mine');
		expect(result.current.themeDraft).toBe('.user{}');
		expect(loadThemeCss).toHaveBeenCalledWith('mine');
	});

	it('opening a built-in FORKS it: draft seeded from resolved CSS under its catalog name, no in-place save', async () => {
		resolveThemeCss.mockResolvedValue('/*nord css*/');
		const { result } = setup();
		await act(async () => {
			await result.current.openThemeEditor('builtin:nord');
		});
		expect(result.current.themeDraftName).toBe('Nord');
		expect(result.current.themeDraft).toBe('/*nord css*/');
		expect(resolveThemeCss).toHaveBeenCalledWith('builtin:nord');
	});

	it('forking an UNKNOWN built-in id falls back to the bare id as the draft name', async () => {
		// builtinIdOf treats any `builtin:` prefix as a built-in; an id with no catalog entry has no
		// name, so the draft name falls back to the bare id (the `?? builtinId` arm).
		const { result } = setup();
		await act(async () => {
			await result.current.openThemeEditor('builtin:ghost');
		});
		expect(result.current.themeDraftName).toBe('ghost');
	});

	it('open then close drives the focus-management effect (both arms)', async () => {
		const { result } = setup();
		await act(async () => {
			await result.current.openThemeEditor('mine'); // open arm
		});
		expect(result.current.themeEditorOpen).toBe(true);
		act(() => result.current.setThemeEditorOpen(false)); // close arm (focus-return)
		expect(result.current.themeEditorOpen).toBe(false);
	});

	it('opening with NO name + no active theme scaffolds a starter "custom" theme', async () => {
		const { result } = setup({ selectedTheme: '' });
		await act(async () => {
			await result.current.openThemeEditor();
		});
		expect(result.current.themeDraftName).toBe('custom');
		expect(result.current.themeDraft).toContain('--np-accent');
		expect(loadThemeCss).not.toHaveBeenCalled();
	});

	it('saveThemeEditor with a blank name is a no-op', async () => {
		const { result } = setup();
		act(() => result.current.setThemeDraftName('   '));
		await act(async () => {
			await result.current.saveThemeEditor();
		});
		expect(saveThemeCss).not.toHaveBeenCalled();
	});

	it('saveThemeEditor writes, refreshes the list, dispatches the selection, and commits', async () => {
		listThemes.mockResolvedValue(['fresh']);
		loadThemeCss.mockResolvedValue('.fresh{}');
		const { result, dispatch, commitOp } = setup();
		act(() => {
			result.current.setThemeDraftName('fresh');
			result.current.setThemeDraft('.fresh{}');
		});
		await act(async () => {
			await result.current.saveThemeEditor();
		});
		expect(saveThemeCss).toHaveBeenCalledWith('fresh', '.fresh{}');
		expect(dispatch).toHaveBeenCalledWith({ type: 'setTheme', name: 'fresh' });
		expect(commitOp).toHaveBeenCalledTimes(1);
		expect(result.current.themeEditorOpen).toBe(false);
		await waitFor(() => expect(result.current.themeList).toEqual(['fresh']));
	});

	it('saveThemeEditor confirms before clobbering a DIFFERENT existing theme; declining aborts', async () => {
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
		const { result } = setup();
		// The editor list already has "taken"; the user types that name while opened on nothing.
		act(() => result.current.setThemeList(['taken']));
		act(() => result.current.setThemeDraftName('taken'));
		await act(async () => {
			await result.current.saveThemeEditor();
		});
		expect(confirm).toHaveBeenCalled();
		expect(saveThemeCss).not.toHaveBeenCalled();
	});

	it('saveThemeEditor proceeds past the overwrite confirm when accepted', async () => {
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		listThemes.mockResolvedValue(['taken']);
		const { result } = setup();
		act(() => result.current.setThemeList(['taken']));
		act(() => result.current.setThemeDraftName('taken'));
		await act(async () => {
			await result.current.saveThemeEditor();
		});
		expect(saveThemeCss).toHaveBeenCalledWith('taken', expect.any(String));
	});
});

describe('duplicateTheme', () => {
	it('saves to a free "<label>-copy" stem and opens the copy for editing', async () => {
		resolveThemeCss.mockResolvedValue('/*src*/');
		listThemes.mockResolvedValue(['nord-copy']); // post-save refresh
		const { result } = setup();
		await act(async () => {
			await result.current.duplicateTheme('builtin:nord');
		});
		// Built-in duplicates under its catalog label, not the builtin: id.
		expect(saveThemeCss).toHaveBeenCalledWith('Nord-copy', '/*src*/');
		expect(result.current.themeEditorOpen).toBe(true);
	});

	it('bumps the suffix (-copy2, -copy3…) past names already taken', async () => {
		resolveThemeCss.mockResolvedValue('/*src*/');
		const { result } = setup();
		// Seed the editor's themeList so the collision loop has to skip -copy and -copy2.
		act(() => result.current.setThemeList(['base-copy', 'base-copy2']));
		await act(async () => {
			await result.current.duplicateTheme('base');
		});
		expect(saveThemeCss).toHaveBeenCalledWith('base-copy3', '/*src*/');
	});
});

describe('deleteTheme', () => {
	it('confirms first; declining skips the delete', async () => {
		vi.spyOn(window, 'confirm').mockReturnValue(false);
		const { result } = setup();
		await act(async () => {
			await result.current.deleteTheme('mine');
		});
		expect(deleteThemeCss).not.toHaveBeenCalled();
	});

	it('deletes + refreshes the list; a non-active theme leaves the selection alone', async () => {
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		listThemes.mockResolvedValue(['other']);
		const { result, dispatch } = setup({ selectedTheme: 'active' });
		await act(async () => {
			await result.current.deleteTheme('mine'); // not the active one
		});
		expect(deleteThemeCss).toHaveBeenCalledWith('mine');
		await waitFor(() => expect(result.current.themeList).toEqual(['other']));
		expect(dispatch).not.toHaveBeenCalled(); // selection untouched
	});

	it('deleting the ACTIVE theme falls back to (default): dispatch setTheme "" + clears CSS', async () => {
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		listThemes.mockResolvedValue([]);
		const { result, dispatch, commitOp } = setup({ selectedTheme: 'mine' });
		// themeRef tracks selectedTheme; deleting it must reset to default.
		await act(async () => {
			await result.current.deleteTheme('mine');
		});
		expect(dispatch).toHaveBeenCalledWith({ type: 'setTheme', name: '' });
		expect(commitOp).toHaveBeenCalledTimes(1);
		expect(result.current.themeCss).toBe('');
	});
});

describe('per-user-theme swatches', () => {
	it('parses a {bg,accent,fg} swatch for each theme once the list is set (studio only)', async () => {
		loadThemeCss.mockImplementation(async (name: string) =>
			name === 'a'
				? ':root{--ui-bg:#101010;--np-accent:#ff0000;--np-fg:#eeeeee}'
				: ':root{--np-accent:#00ff00}'
		);
		const { result } = setup({ studio: true });
		act(() => result.current.setThemeList(['a', 'b']));
		await waitFor(() => expect(Object.keys(result.current.userThemeSwatches)).toHaveLength(2));
		expect(result.current.userThemeSwatches.a).toEqual({
			bg: '#101010',
			accent: '#ff0000',
			fg: '#eeeeee'
		});
		// Missing tokens fall back to the defaults inside swatchFromTokens.
		expect(result.current.userThemeSwatches.b.accent).toBe('#00ff00');
	});

	it('does not compute swatches outside the studio', async () => {
		const { result } = setup({ studio: false });
		act(() => result.current.setThemeList(['a']));
		// Give any (suppressed) async effect a tick; loadThemeCss must not have been called for swatches.
		await act(async () => {
			await Promise.resolve();
		});
		expect(result.current.userThemeSwatches).toEqual({});
	});
});
