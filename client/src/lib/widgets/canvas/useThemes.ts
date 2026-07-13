// Theme state + actions (extracted from Canvas): the active theme's CSS, the user-theme list +
// per-theme swatches, the set/duplicate/delete actions, and the theme-editor dialog state. The
// SELECTED theme name itself stays in the editor model (it persists with the layout); this hook
// owns the side-effects around it — resolving CSS, the themes/ file I/O, and the editor draft.
// `themeRef` mirrors the latest selection for listeners (reloadLayout / imports) that run outside
// the render; `adoptTheme` is the one call that flips both the ref and the live CSS.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
	deleteThemeCss,
	listThemes,
	loadThemeCss,
	resolveThemeCss,
	saveThemeCss
} from '../../overlay';
import { parseTokens, swatchFromTokens, type Swatch } from '../../core/tokens';
import { builtinById, builtinIdOf } from '../../core/builtinThemes';
import type { EditorModel } from './useEditorModel';

type Deps = {
	studio: boolean;
	selectedTheme: string;
	dispatch: EditorModel['dispatch'];
	commitOp: EditorModel['commitOp'];
};

export type Themes = {
	/** The active theme's resolved CSS (a side-effect of selectedTheme; held in component state). */
	themeCss: string;
	themeList: string[];
	setThemeList: (names: string[]) => void;
	/** Per-USER-theme {bg,accent,fg} swatch for the picker + app-bar dropdown. */
	userThemeSwatches: Record<string, Swatch>;
	/** Latest selectedTheme for callbacks running outside the render (listeners / async). */
	themeRef: React.MutableRefObject<string>;
	/** Re-resolve + apply the CSS for the CURRENT selection (startup / themes_changed / cancel). */
	applyTheme: () => Promise<void>;
	/** Display label for a selection string (built-in catalog name / '(default)' / bare filename). */
	themeLabel: (name: string) => string;
	/** Make `name` the live theme WITHOUT dispatching: sync the ref + swap the CSS (load/import). */
	adoptTheme: (name: string) => Promise<void>;
	/** User picked a theme: dispatch + apply CSS + commit (a history no-op that triggers a write). */
	setTheme: (name: string) => Promise<void>;
	// The theme-editor dialog (a real focus-managed dialog).
	themeEditorOpen: boolean;
	setThemeEditorOpen: (open: boolean) => void;
	themeDraft: string;
	setThemeDraft: (css: string) => void;
	themeDraftName: string;
	setThemeDraftName: (name: string) => void;
	themeNameRef: React.RefObject<HTMLInputElement | null>;
	openThemeEditor: (name?: string) => Promise<void>;
	saveThemeEditor: () => Promise<void>;
	duplicateTheme: (name: string) => Promise<void>;
	deleteTheme: (name: string) => Promise<void>;
};

export function useThemes({ studio, selectedTheme, dispatch, commitOp }: Deps): Themes {
	// Theme css + list (the CSS is a side-effect of selectedTheme; held in component state).
	const [themeCss, setThemeCss] = useState('');
	const [themeList, setThemeList] = useState<string[]>([]);
	// Per-USER-theme {bg,accent,fg} swatch for the picker + app-bar dropdown (built-ins carry their
	// own). Parsed from each theme's CSS by the effect below; absent until then → a neutral chip.
	const [userThemeSwatches, setUserThemeSwatches] = useState<Record<string, Swatch>>({});

	// applyTheme reads the latest selectedTheme via a ref (it's called from listeners + after sets).
	// Mirrored in a commit effect (not during render); every read happens later, off-render.
	const themeRef = useRef(selectedTheme);
	const cssRequestRef = useRef(0);
	useEffect(() => {
		themeRef.current = selectedTheme;
	});
	const resolveLatest = useCallback(async (name: string) => {
		const request = ++cssRequestRef.current;
		const css = await resolveThemeCss(name);
		if (request === cssRequestRef.current && themeRef.current === name) setThemeCss(css);
	}, []);

	const applyTheme = useCallback(async () => {
		await resolveLatest(themeRef.current);
	}, [resolveLatest]);
	// Display label for a selection string: a built-in shows its catalog name, '' is the default
	// reset, and a user theme is its bare filename. Also the basis for fork/export filenames.
	const themeLabel = useCallback((name: string): string => {
		const id = builtinIdOf(name);
		if (id) return builtinById(id)?.name ?? id;
		return name || '(default)';
	}, []);

	// Sync the ref + the live CSS to `name` WITHOUT dispatching — for callers whose dispatch/commit
	// already set selectedTheme (reloadLayout's load patch, importSack's commit).
	const adoptTheme = useCallback(
		async (name: string) => {
			themeRef.current = name;
			await resolveLatest(name);
		},
		[resolveLatest]
	);

	const setTheme = useCallback(
		async (name: string) => {
			dispatch({ type: 'setTheme', name });
			themeRef.current = name;
			// Persist the selection immediately; stylesheet I/O is a presentation side effect and must
			// neither delay the write nor let an older resolution overwrite a newer selection.
			commitOp(() => ({}));
			await resolveLatest(name);
		},
		[dispatch, commitOp, resolveLatest]
	);

	// Theme editor (item 5). A real (focus-managed) dialog: autofocus on open, focus-return on
	// close, Esc-to-close handled locally (useKeyboard suppresses registry controls while a field
	// is focused).
	const [themeEditorOpen, setThemeEditorOpen] = useState(false);
	const [themeDraft, setThemeDraft] = useState('');
	const [themeDraftName, setThemeDraftName] = useState('');
	// The theme whose CSS we opened in the editor ('' = a brand-new theme). Used to tell an in-place
	// save (no surprise) from a save that would clobber a DIFFERENT existing theme (confirm first).
	const [themeOpenedName, setThemeOpenedName] = useState('');
	const themeNameRef = useRef<HTMLInputElement | null>(null);
	const themeTriggerRef = useRef<HTMLElement | null>(null);
	const themeOpenPrev = useRef(false);
	useEffect(() => {
		if (themeEditorOpen && !themeOpenPrev.current) themeNameRef.current?.focus();
		else if (!themeEditorOpen && themeOpenPrev.current) themeTriggerRef.current?.focus?.();
		themeOpenPrev.current = themeEditorOpen;
	}, [themeEditorOpen]);
	// Open the editor on a SPECIFIC theme (the per-row ✎) or, with no name, the active theme (the
	// toolbar button) — '' falls through to a starter scaffold for a new theme.
	const openThemeEditor = useCallback(
		async (name?: string) => {
			themeTriggerRef.current = document.activeElement as HTMLElement;
			const target = name ?? selectedTheme;
			const builtinId = builtinIdOf(target);
			if (builtinId) {
				// Built-ins are immutable: opening one in the editor FORKS it into a new user theme. Seed
				// the draft from the preset's CSS under its name, and treat it as brand-new (no in-place
				// save).
				setThemeOpenedName('');
				setThemeDraftName(builtinById(builtinId)?.name ?? builtinId);
				setThemeDraft(await resolveThemeCss(target));
			} else {
				setThemeOpenedName(target || '');
				setThemeDraftName(target || 'custom');
				setThemeDraft(
					target
						? await loadThemeCss(target)
						: ':root {\n\t--np-accent: #77c4d3;\n\t--np-fg: #ffffff;\n}\n'
				);
			}
			setThemeEditorOpen(true);
		},
		[selectedTheme]
	);
	const saveThemeEditor = useCallback(async () => {
		const name = themeDraftName.trim();
		if (!name) return;
		// Guard a destructive overwrite: saving under a name that already exists AND isn't the theme
		// we opened in place. (Re-saving the theme you're editing under its own name is expected.)
		if (name !== themeOpenedName && themeList.includes(name)) {
			if (!window.confirm(`Overwrite the existing theme "${name}"?`)) return;
		}
		try {
			await saveThemeCss(name, themeDraft);
		} catch (err) {
			window.alert(`Could not save theme "${name}": ${String(err)}`);
			return;
		}
		setThemeList(await listThemes());
		dispatch({ type: 'setTheme', name });
		themeRef.current = name;
		commitOp(() => ({})); // saveLayout()
		await resolveLatest(name);
		setThemeEditorOpen(false);
	}, [themeDraftName, themeDraft, themeOpenedName, themeList, dispatch, commitOp, resolveLatest]);
	// Duplicate a theme to a free "<name>-copy" stem and open the copy for editing.
	const duplicateTheme = useCallback(
		async (name: string) => {
			const existing = new Set(themeList);
			// A built-in duplicates under its catalog name (e.g. "Nord-copy"), not "builtin:nord-copy".
			const base = `${themeLabel(name).replace(/^\(default\)$/, 'theme')}-copy`;
			let candidate = base;
			let i = 2;
			while (existing.has(candidate)) candidate = `${base}${i++}`;
			try {
				await saveThemeCss(candidate, await resolveThemeCss(name));
			} catch (err) {
				window.alert(`Could not duplicate theme "${name}": ${String(err)}`);
				return;
			}
			setThemeList(await listThemes());
			await openThemeEditor(candidate);
		},
		[themeList, themeLabel, openThemeEditor]
	);
	// Delete a theme's file (after a confirm). If it was the active theme, fall back to (default) so
	// the picker + overlays don't dangle on a now-missing name.
	const deleteTheme = useCallback(
		async (name: string) => {
			if (!window.confirm(`Delete the theme "${name}"? This removes themes/${name}.css.`)) return;
			try {
				await deleteThemeCss(name);
			} catch (err) {
				window.alert(`Could not delete theme "${name}": ${String(err)}`);
				return;
			}
			setThemeList(await listThemes());
			if (themeRef.current === name) {
				dispatch({ type: 'setTheme', name: '' });
				themeRef.current = '';
				cssRequestRef.current++;
				setThemeCss('');
				commitOp(() => ({}));
			}
		},
		[dispatch, commitOp]
	);

	// Parse a {bg,accent,fg} swatch for each USER theme (built-ins carry their own) — load each
	// theme's CSS once and extract its tokens. Runs whenever the theme list changes (NOT gated on
	// the Themes section) so BOTH the panel picker AND the app-bar dropdown have swatches.
	useEffect(() => {
		if (!studio) return;
		let cancelled = false;
		Promise.all(
			themeList.map(async (n) => [n, swatchFromTokens(parseTokens(await loadThemeCss(n)))] as const)
		).then((entries) => {
			if (!cancelled) setUserThemeSwatches(Object.fromEntries(entries));
		});
		return () => {
			cancelled = true;
		};
	}, [studio, themeList]);

	return {
		themeCss,
		themeList,
		setThemeList,
		userThemeSwatches,
		themeRef,
		applyTheme,
		themeLabel,
		adoptTheme,
		setTheme,
		themeEditorOpen,
		setThemeEditorOpen,
		themeDraft,
		setThemeDraft,
		themeDraftName,
		setThemeDraftName,
		themeNameRef,
		openThemeEditor,
		saveThemeEditor,
		duplicateTheme,
		deleteTheme
	};
}
