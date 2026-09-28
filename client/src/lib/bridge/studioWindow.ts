import { getCurrentWindow } from '@tauri-apps/api/window';
import { getAllWebviewWindows, WebviewWindow } from '@tauri-apps/api/webviewWindow';

/** True when this window is the studio (a normal app window for the designers, 5s). */
export function isStudioWindow(): boolean {
	try {
		return getCurrentWindow().label === 'studio';
	} catch {
		return false;
	}
}

/**
 * Guard the studio window's close: intercept the OS close request, run the caller's `decide` (which
 * persists any pending work), then close. Returning `false` keeps the draft open when persistence fails. No-op off
 * the studio window / outside Tauri. Returns an unlisten fn.
 */
export async function onStudioCloseRequested(
	decide: () => Promise<boolean> | boolean
): Promise<() => void> {
	if (!isStudioWindow()) return () => undefined;
	try {
		const win = getCurrentWindow();
		let unlisten: () => void = () => undefined;
		let handling = false;
		unlisten = await win.onCloseRequested(async (event) => {
			event.preventDefault();
			if (handling) return; // repeat clicks must not bypass an in-flight save
			handling = true;
			let proceed = false;
			try {
				proceed = (await decide()) !== false;
			} catch (err) {
				// An unexpected save failure must not destroy the only copy of the draft.
				console.warn('studio close decision failed', err);
			}
			if (!proceed) {
				handling = false; // the user kept editing; allow a later close attempt
				return;
			}
			// Once a close is preventDefault'd, a programmatic close() is swallowed for that cycle — even
			// deferred or after unlistening (only a fresh native click closed it: the "click twice" bug).
			// destroy() force-tears-down the window directly (not a close *request*), so it closes on the
			// first click. Studio only; the host + overlays keep running.
			try {
				await win.destroy();
			} catch (err) {
				console.warn('studio destroy failed', err);
			}
		});
		return unlisten;
	} catch (err) {
		console.warn('onStudioCloseRequested registration failed', err);
		return () => undefined;
	}
}

/** Open (or focus) the studio window — a borderless, taskbar-present app window that edits the same
 * layout the overlays render (synced via widgets.json + live reload). `decorations:false` removes the
 * OS title bar; the studio draws its OWN themed title bar (drag region + window controls) so the chrome
 * matches the active theme instead of the platform's grey frame. */
export async function openStudio(): Promise<void> {
	const existing = (await getAllWebviewWindows()).find((w) => w.label === 'studio');
	if (existing) {
		await existing.setFocus();
		return;
	}
	const w = new WebviewWindow('studio', {
		url: '/',
		title: 'widgetsack studio',
		width: 980,
		height: 680,
		resizable: true,
		// No OS title bar — the in-app `.studio-bar` is the (themed) title bar (data-tauri-drag-region
		// moves the window; the min/max/close cluster calls the window-control adapters below).
		decorations: false,
		// Disable Tauri's OS-level drag-drop handler so the webview's own HTML5 drag-and-drop fires —
		// the studio needs it for the Inspector palette → canvas drop and Outline row reparenting.
		// (The app uses no OS file-drop, so nothing is lost by turning it off.)
		dragDropEnabled: false
	});
	w.once('tauri://error', (err) => console.warn('studio window error', err));
}

// --- custom title-bar window controls (the studio's borderless window) -----------------------------
// Tauri window API stays at this edge (AGENTS.md §5). All no-op gracefully off Tauri / in a plain
// browser so the studio shell still renders under the dev mock + Playwright.

/** Minimize the current window (title-bar `—`). */
export async function minimizeWindow(): Promise<void> {
	try {
		await getCurrentWindow().minimize();
	} catch (err) {
		console.warn('minimize failed', err);
	}
}

/** Toggle maximize / restore for the current window (title-bar `▢`, and drag-region double-click). */
export async function toggleMaximizeWindow(): Promise<void> {
	try {
		await getCurrentWindow().toggleMaximize();
	} catch (err) {
		console.warn('toggleMaximize failed', err);
	}
}

/** Request the current window to close (title-bar `✕`) after its close guard saves pending edits. */
export async function closeWindow(): Promise<void> {
	try {
		await getCurrentWindow().close();
	} catch (err) {
		console.warn('close failed', err);
	}
}
