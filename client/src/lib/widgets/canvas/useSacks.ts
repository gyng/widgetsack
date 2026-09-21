// Sack import/export (extracted from Canvas, item 10): pack the studio's shareable state
// (library + theme CSS + token overrides) into a named sack file, and import + merge one back.
// The editable state itself stays in the editor model — this hook owns the sacks/ + themes/ file
// I/O around it and funnels the import through ONE commit (one undo step). Theme side-effects go
// through the useThemes seam (adoptTheme / setThemeList) so the live CSS can't drift.
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';
import type { Library } from '../../core/layoutTree';
import {
	mergeLibrary,
	packSack,
	sackConsentMessage,
	sanitizeSack,
	unpackSack
} from '../../core/sack';
import {
	listSacks,
	listThemes,
	readSack,
	resolveThemeCss,
	saveThemeCss,
	writeSack
} from '../../overlay';
import type { SectionId } from './studioSections';
import type { EditorModel } from './useEditorModel';
import type { EditorState } from './types';
import type { Themes } from './useThemes';

type Deps = {
	studio: boolean;
	navSection: SectionId;
	editingDefId: string | null;
	selectedTheme: string;
	library: Library | undefined;
	tokenOverrides: Record<string, string>;
	commitOp: EditorModel['commitOp'];
	themes: Pick<Themes, 'themeLabel' | 'setThemeList' | 'adoptTheme'>;
};

export type SackInfo = {
	name: string;
	/** Reusable widget defs inside; null = the file exists but didn't parse as a sack. */
	widgets: number | null;
	theme: string | null;
	tokens: number;
};

/** One dim summary line for a sack row — what you'd get by importing it. Pure (tested). */
export function sackSummary(info: SackInfo): string {
	if (info.widgets === null) return 'unreadable — not a sack?';
	const parts: string[] = [];
	if (info.widgets) parts.push(`${info.widgets} widget${info.widgets === 1 ? '' : 's'}`);
	if (info.theme) parts.push(`theme “${info.theme}”`);
	if (info.tokens) parts.push(`${info.tokens} token override${info.tokens === 1 ? '' : 's'}`);
	return parts.length ? parts.join(' · ') : 'empty';
}

/** The export name rule, mirroring the backend allowlist (command.rs valid_sack_name): 1–64 chars of
 * letters, digits, spaces, `_` and `-`. Returns the user-facing problem, or null when the name is fine. */
export function sackNameError(name: string): string | null {
	const n = name.trim();
	if (!n) return 'Enter a name for the sack';
	if (n.length > 64) return 'Keep the name under 64 characters';
	if (!/^[A-Za-z0-9 _-]+$/.test(n)) return 'Use letters, numbers, spaces, _ or - only';
	return null;
}

/** The one-line result of an import: what landed. Pure (tested). */
export function importSummary(r: {
	widgets: number;
	theme: string | null;
	sandboxed: number;
}): string {
	const parts = [`Imported ${r.widgets} widget${r.widgets === 1 ? '' : 's'}`];
	if (r.theme) parts.push(`theme saved as ${r.theme}`);
	if (r.sandboxed) parts.push(`${r.sandboxed} iframe${r.sandboxed === 1 ? '' : 's'} sandboxed`);
	return parts.join(' · ');
}

/** A result line for the Sacks section: the outcome of the last export / import. */
export type SackNotice = { tone: 'ok' | 'error'; text: string; path?: string };

export type Sacks = {
	/** The saved sacks (name + contents summary), loaded when the Sacks section is open. */
	sackInfos: SackInfo[];
	/** The inline export name field (seeded from the active theme's name) + its validation problem. */
	exportName: string;
	setExportName: (name: string) => void;
	exportNameError: string | null;
	/** Export under `exportName` (validated). Alerts on a mid-def-edit / write failure. */
	exportSack: () => Promise<void>;
	importSack: (name: string) => Promise<void>;
	/** The last export/import outcome, shown inline in the section; null = nothing yet. */
	notice: SackNotice | null;
	clearNotice: () => void;
	/** Open the sacks/ folder in Explorer (the backend `reveal_sacks_dir` command). */
	revealSacksDir: () => Promise<void>;
};

/** Reveal the `sacks/` folder in Explorer. Best-effort (a missing command just logs). */
async function revealSacksDir(): Promise<void> {
	try {
		await invoke(COMMANDS.revealSacksDir);
	} catch (err) {
		console.warn('reveal_sacks_dir failed', err);
	}
}

export function useSacks({
	studio,
	navSection,
	editingDefId,
	selectedTheme,
	library,
	tokenOverrides,
	commitOp,
	themes
}: Deps): Sacks {
	const { themeLabel, setThemeList, adoptTheme } = themes;
	const [sackInfos, setSackInfos] = useState<SackInfo[]>([]);
	const [notice, setNotice] = useState<SackNotice | null>(null);
	const clearNotice = useCallback(() => setNotice(null), []);
	// The inline export name: seeded from the active theme's label (what the old prompt defaulted to)
	// until the user types their own (null = untouched → use the seed).
	const [exportNameRaw, setExportName] = useState<string | null>(null);
	const exportName = exportNameRaw ?? (themeLabel(selectedTheme) || 'my-sack');
	const exportNameError = sackNameError(exportName);

	// Names + a peek inside each (count of defs, theme name, override count) so the Import list can
	// say what a sack contains instead of a bare filename. Sacks are small local JSON; reading each
	// on section-open is cheap. A file that doesn't parse still lists (widgets: null → "unreadable").
	// Pure I/O (no setState) so it can be awaited from an effect's async closure without the compiler
	// treating it as a synchronous effect state update.
	const loadSackInfos = useCallback(async (): Promise<SackInfo[]> => {
		const names = await listSacks();
		return Promise.all(
			names.map(async (name): Promise<SackInfo> => {
				const raw = await readSack(name);
				const sack = raw ? unpackSack(raw) : null;
				if (!sack) return { name, widgets: null, theme: null, tokens: 0 };
				return {
					name,
					widgets: sack.library?.defs.length ?? 0,
					theme: sack.theme?.name ?? null,
					tokens: sack.tokens ? Object.keys(sack.tokens).length : 0
				};
			})
		);
	}, []);
	// Reload the list into state — used by event handlers (exportSack), not from an effect body.
	const refreshSacks = useCallback(async () => {
		setSackInfos(await loadSackInfos());
	}, [loadSackInfos]);

	const exportSack = useCallback(async () => {
		if (editingDefId != null) {
			// Mid def-edit the in-progress def isn't folded back into `library` yet — exporting now would
			// pack the stale pre-edit version. Make the user finish first (matches importSack's guard).
			window.alert('Finish editing the current widget (Done) before exporting a sack.');
			return;
		}
		const problem = sackNameError(exportName);
		if (problem) {
			setNotice({ tone: 'error', text: problem });
			return;
		}
		const name = exportName.trim();
		// Re-read the theme CSS at export time so a not-yet-loaded `themeCss` can't silently drop it. A
		// built-in is baked into the sack under its catalog name (the `builtin:` id never leaves the app).
		const css = selectedTheme ? await resolveThemeCss(selectedTheme) : '';
		const sack = packSack({
			name,
			library,
			theme: selectedTheme ? { name: themeLabel(selectedTheme), css } : undefined,
			tokens: tokenOverrides
		});
		const path = await writeSack(name, JSON.stringify(sack, null, '\t'));
		await refreshSacks();
		if (!path) {
			// writeSack swallows the backend error (it logs + returns null): say so plainly, or a failed
			// export reads as a silent success.
			const text = `Could not write the sack "${name}" — check the sacks folder is writable.`;
			setNotice({ tone: 'error', text });
			window.alert(text);
			return;
		}
		setNotice({ tone: 'ok', text: `Exported ${name}`, path });
	}, [editingDefId, exportName, selectedTheme, themeLabel, library, tokenOverrides, refreshSacks]);

	const importSack = useCallback(
		async (name: string) => {
			if (editingDefId != null) {
				window.alert('Finish editing the current widget (Done) before importing a sack.');
				return;
			}
			const raw = await readSack(name);
			const unpacked = raw ? unpackSack(raw) : null;
			if (!unpacked) {
				window.alert('Could not read that sack.');
				return;
			}
			// A sack is shared content: its theme CSS is injected verbatim into the studio + overlays, and
			// its widget defs can carry embedded web pages, remote images, service-call buttons and
			// per-widget CSS. ONE confirm states everything (core/sack sackConsentMessage), then the sack
			// is hardened (iframe sandbox forced on, prototype-walking param specs dropped) before merge.
			const consent = sackConsentMessage(unpacked);
			if (consent && !window.confirm(consent)) return;
			const { sack, changed } = sanitizeSack(unpacked);
			// Theme first: resolve a name collision so an import never clobbers an existing user theme.
			let themeName: string | null = null;
			if (sack.theme) {
				const existing = await listThemes();
				themeName = existing.includes(sack.theme.name)
					? `${sack.theme.name}-imported`
					: sack.theme.name;
				try {
					await saveThemeCss(themeName, sack.theme.css);
				} catch (err) {
					window.alert(`Could not import theme "${themeName}": ${String(err)}`);
					return;
				}
				setThemeList(await listThemes());
			}
			// One commit applies the persisted parts: merged library + token overrides + selected theme.
			commitOp((s) => {
				const patch: Partial<EditorState> = {};
				if (sack.library?.defs.length) {
					patch.library = mergeLibrary(s.library, sack.library.defs).library;
				}
				if (sack.tokens && Object.keys(sack.tokens).length) {
					patch.tokenOverrides = { ...s.tokenOverrides, ...sack.tokens };
				}
				if (themeName) patch.selectedTheme = themeName;
				return patch;
			});
			// Live-apply the theme CSS (the commit set selectedTheme; mirror it for the live styles).
			if (themeName) await adoptTheme(themeName);
			setNotice({
				tone: 'ok',
				text: importSummary({
					widgets: sack.library?.defs.length ?? 0,
					theme: themeName,
					sandboxed: changed
				})
			});
		},
		[editingDefId, commitOp, setThemeList, adoptTheme]
	);

	// Load the saved sacks (+ their summaries) when the Sacks section opens. setState lives in the
	// async .then() (not the effect body), and a cancel guard drops a stale load if the section
	// closes / the studio unmounts mid-flight.
	useEffect(() => {
		if (!(studio && navSection === 'sacks')) return;
		let cancelled = false;
		void loadSackInfos().then((infos) => {
			if (!cancelled) setSackInfos(infos);
		});
		return () => {
			cancelled = true;
		};
	}, [studio, navSection, loadSackInfos]);

	return {
		sackInfos,
		exportName,
		setExportName,
		exportNameError,
		exportSack,
		importSack,
		notice,
		clearNotice,
		revealSacksDir
	};
}
