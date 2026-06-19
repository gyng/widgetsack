// Run a DOM-updating callback inside a View Transition where the engine supports it (Chromium /
// WebView2 — the overlay + studio runtime), so a state change cross-fades instead of cutting.
// Everywhere else (older engines, the test happy-dom) it just runs the update directly, so callers
// don't need to feature-check. React state changes inside `update` should be flushed synchronously
// (flushSync) by the caller, so the new DOM is in place when the transition captures the "after"
// snapshot. Honours prefers-reduced-motion — those users get the instant update, no animation.
type DocumentWithViewTransitions = Document & {
	startViewTransition?: (callback: () => void) => unknown;
};

export function prefersReducedMotion(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

export function startViewTransition(update: () => void): void {
	const doc = document as DocumentWithViewTransitions;
	if (typeof doc.startViewTransition === 'function' && !prefersReducedMotion()) {
		doc.startViewTransition(update);
	} else {
		update();
	}
}
