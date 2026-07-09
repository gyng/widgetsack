import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion, startViewTransition } from './viewTransition';

// TS 6's lib.dom types `startViewTransition` as a required overload; override it with an optional,
// loose signature so the test can assign a mock (or undefined) to it.
type VTDoc = Omit<Document, 'startViewTransition'> & {
	startViewTransition?: (cb: () => void) => unknown;
};
const doc = document as unknown as VTDoc;
const origMatchMedia = window.matchMedia;
const origVT = doc.startViewTransition;

afterEach(() => {
	window.matchMedia = origMatchMedia;
	doc.startViewTransition = origVT;
});

const setReducedMotion = (reduced: boolean): void => {
	window.matchMedia = vi.fn(() => ({ matches: reduced }) as unknown as MediaQueryList);
};

describe('viewTransition', () => {
	it('prefersReducedMotion reflects the media query', () => {
		setReducedMotion(true);
		expect(prefersReducedMotion()).toBe(true);
		setReducedMotion(false);
		expect(prefersReducedMotion()).toBe(false);
	});

	it('prefersReducedMotion is false when matchMedia is unavailable', () => {
		window.matchMedia = undefined as unknown as typeof window.matchMedia;
		expect(prefersReducedMotion()).toBe(false);
	});

	it('runs the update directly when the View Transitions API is unavailable', () => {
		setReducedMotion(false);
		doc.startViewTransition = undefined;
		const update = vi.fn();
		startViewTransition(update);
		expect(update).toHaveBeenCalledTimes(1);
	});

	it('uses startViewTransition when available and motion is allowed', () => {
		setReducedMotion(false);
		const vt = vi.fn((cb: () => void) => {
			cb();
			return {};
		});
		doc.startViewTransition = vt;
		const update = vi.fn();
		startViewTransition(update);
		expect(vt).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledTimes(1); // the stub invokes the callback
	});

	it('skips the transition (runs update directly) under reduced motion', () => {
		setReducedMotion(true);
		const vt = vi.fn();
		doc.startViewTransition = vt;
		const update = vi.fn();
		startViewTransition(update);
		expect(vt).not.toHaveBeenCalled();
		expect(update).toHaveBeenCalledTimes(1);
	});
});
