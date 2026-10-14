import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from './contract';
import { builtinCss } from '../core/builtinThemes';

/** Theme names available in the config dir's `themes/` folder (Phase 7c). */
export async function listThemes(requireComplete = false): Promise<string[]> {
	try {
		return await invoke<string[]>(COMMANDS.listThemes);
	} catch (err) {
		if (requireComplete) throw err;
		console.warn('list_themes failed', err);
		return [];
	}
}

/** The CSS of a USER theme `name` (empty for '(default)' / a missing theme). Disk-backed. */
// Editing and export requireReadable so missing/unreadable files cannot be copied as empty CSS.
export async function loadThemeCss(name: string, requireReadable = false): Promise<string> {
	if (!name) return '';
	try {
		const css = await invoke<string | null>(COMMANDS.loadTheme, { name });
		if (requireReadable && css === null) throw new Error(`Theme "${name}" was not found.`);
		return css ?? '';
	} catch (err) {
		if (requireReadable) throw err;
		console.warn('load_theme failed', err);
		return '';
	}
}

/** The CSS for any selected theme: a `builtin:<id>` preset resolves synchronously from the in-app
 * registry (no disk), anything else is a user theme loaded from `themes/<name>.css`. '' = default. */
export async function resolveThemeCss(name: string, requireReadable = false): Promise<string> {
	if (!name) return '';
	const built = builtinCss(name);
	if (built != null) return built;
	return loadThemeCss(name, requireReadable);
}

/** Write a theme. Pass overwrite=false for imports and new files to reject a concurrent collision. */
export async function saveThemeCss(
	name: string,
	contents: string,
	overwrite = true
): Promise<void> {
	await invoke(COMMANDS.saveTheme, { name, contents, overwrite });
}

/** Delete theme `name` → removes `themes/<name>.css` (idempotent). Used by the studio theme list. */
export async function deleteThemeCss(name: string): Promise<void> {
	await invoke(COMMANDS.deleteTheme, { name });
}
