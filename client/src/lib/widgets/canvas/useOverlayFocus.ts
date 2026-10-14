// Overlay activation policy (WS_EX_NOACTIVATE) for THIS overlay window. Overlays are non-activating by
// default so clicking an interactive widget (media controls, HA buttons) doesn't steal focus from the
// foreground app; pressing a text entry (HA text input, sticky note, chat input, checklist entry, …)
// makes the window focusable and activates it so the keyboard reaches the field, and focus leaving
// the text entry (or the window) restores the policy. Edit mode / windowed-debug keep it focusable.
// The decision is the pure `overlayFocusPolicy`; this hook only tracks the DOM signal and applies it.
import { useEffect, useState } from 'react';
import { isTextEntry, overlayFocusPolicy, type FocusTarget } from './overlayPresentation';

export type UseOverlayFocusArgs = {
	/** False for the studio (never participates). */
	enabled: boolean;
	editMode: boolean;
	windowed: boolean;
	/** The window adapter (overlay.ts `setOverlayFocusable`). */
	apply: (focusable: boolean, activate: boolean) => Promise<void> | void;
};

const asTarget = (t: EventTarget | null): FocusTarget | null =>
	t instanceof HTMLElement ? (t as FocusTarget) : null;

export function useOverlayFocus({ enabled, editMode, windowed, apply }: UseOverlayFocusArgs): void {
	const [textEntry, setTextEntry] = useState(false);

	useEffect(() => {
		if (!enabled) return;
		// pointerdown (not focusin): only a user PRESS may activate the overlay — a widget that
		// autofocuses its input on mount must not pull activation from the foreground app.
		const onPointerDown = (e: PointerEvent) => {
			if (isTextEntry(asTarget(e.target))) setTextEntry(true);
		};
		const onFocusOut = (e: FocusEvent) => {
			if (!isTextEntry(asTarget(e.relatedTarget))) setTextEntry(false);
		};
		const onBlur = () => setTextEntry(false);
		document.addEventListener('pointerdown', onPointerDown, true);
		document.addEventListener('focusout', onFocusOut, true);
		window.addEventListener('blur', onBlur);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown, true);
			document.removeEventListener('focusout', onFocusOut, true);
			window.removeEventListener('blur', onBlur);
			setTextEntry(false);
		};
	}, [enabled]);

	const { focusable, activate } = overlayFocusPolicy({ windowed, editMode, textEntry });
	useEffect(() => {
		if (!enabled) return;
		void apply(focusable, activate);
	}, [enabled, focusable, activate, apply]);
}
