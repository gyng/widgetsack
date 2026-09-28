import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from './contract';
import { builtinCss } from '../core/builtinThemes';

/** Theme names available in the config dir's `themes/` folder (Phase 7c). */
export async function listThemes(): Promise<string[]> {
	try {
		return await invoke<string[]>(COMMANDS.listThemes);
	} catch (err) {
		console.warn('list_themes failed', err);
		return [];
	}
}

/** The CSS of a USER theme `name` (empty for '(default)' / a missing theme). Disk-backed. */
export async function loadThemeCss(name: string): Promise<string> {
	if (!name) return '';
	try {
		return (await invoke<string | null>(COMMANDS.loadTheme, { name })) ?? '';
	} catch (err) {
		console.warn('load_theme failed', err);
		return '';
	}
}

/** The CSS for any selected theme: a `builtin:<id>` preset resolves synchronously from the in-app
 * registry (no disk), anything else is a user theme loaded from `themes/<name>.css`. '' = default. */
export async function resolveThemeCss(name: string): Promise<string> {
	if (!name) return '';
	const built = builtinCss(name);
	if (built != null) return built;
	return loadThemeCss(name);
}

/** Write theme `name` (a bare stem) → `themes/<name>.css`. Used by the studio theme editor. */
export async function saveThemeCss(name: string, contents: string): Promise<void> {
	await invoke(COMMANDS.saveTheme, { name, contents });
}

/** Delete theme `name` → removes `themes/<name>.css` (idempotent). Used by the studio theme list. */
export async function deleteThemeCss(name: string): Promise<void> {
	await invoke(COMMANDS.deleteTheme, { name });
}
