import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { waitForStudioRender } from './waitForStudioRender';

let frames: Map<number, FrameRequestCallback>;
let visibility: DocumentVisibilityState;
beforeEach(() => {
	frames = new Map();
	visibility = 'visible';
	let next = 0;
	vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		frames.set(++next, callback);
		return next;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => {
		frames.delete(id);
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function frame() {
	const callbacks = [...frames.values()];
	frames.clear();
	callbacks.forEach((callback) => callback(0));
}

it('waits for two frames before measuring', async () => {
	let completed = false;
	const waiting = waitForStudioRender().then(() => {
		completed = true;
	});
	document.dispatchEvent(new Event('visibilitychange'));
	frame();
	await Promise.resolve();
	expect(completed).toBe(false);
	frame();
	await waiting;
	expect(completed).toBe(true);
});

it.each([0, 1])('cancels and removes pending frames after %s frames', async (count) => {
	const controller = new AbortController();
	const waiting = waitForStudioRender(controller.signal);
	if (count) frame();
	controller.abort();
	const remaining = frames.size;
	frame();
	frame();
	await expect(waiting).rejects.toThrow('cancelled');
	expect(remaining).toBe(0);
});

it('does not schedule work when already cancelled', async () => {
	const controller = new AbortController();
	controller.abort();
	const waiting = waitForStudioRender(controller.signal);
	const scheduled = frames.size;
	frame();
	frame();
	await expect(waiting).rejects.toThrow('cancelled');
	expect(scheduled).toBe(0);
});

it('does not wait for frames while hidden', async () => {
	visibility = 'hidden';
	await waitForStudioRender();
	expect(frames.size).toBe(0);
});

it('releases the wait if Studio becomes hidden', async () => {
	const waiting = waitForStudioRender();
	visibility = 'hidden';
	document.dispatchEvent(new Event('visibilitychange'));
	const remaining = frames.size;
	frame();
	frame();
	await waiting;
	expect(remaining).toBe(0);
});
