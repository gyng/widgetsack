import { describe, expect, it, vi } from 'vitest';
import { fitMismatch, fitWindowVerified, type PhysicalBox } from './windowFit';

const target: PhysicalBox = { x: 652, y: 2160, w: 2560, h: 720 };

/** A fake window whose "OS" applies each set immediately, except where a test scripts drift. */
function fakeWindow(opts: { driftOnce?: Partial<PhysicalBox>; alwaysDrift?: PhysicalBox } = {}) {
	let box: PhysicalBox = { x: 0, y: 0, w: 800, h: 600 };
	let drifted = false;
	const setPosition = vi.fn(async (x: number, y: number) => {
		box = { ...box, x, y };
		// Mirror tao's WM_DPICHANGED handling: Windows' suggested rect can override the position we
		// just set — once (a real DPI hop settles) or forever (a window we can never fit).
		if (opts.alwaysDrift) box = { ...opts.alwaysDrift };
		else if (opts.driftOnce && !drifted) {
			drifted = true;
			box = { ...box, ...opts.driftOnce };
		}
	});
	const setSize = vi.fn(async (w: number, h: number) => {
		box = { ...box, w, h };
		if (opts.alwaysDrift) box = { ...opts.alwaysDrift };
	});
	const readBack = vi.fn(async () => ({ ...box }));
	return {
		setPosition,
		setSize,
		readBack,
		get box() {
			return box;
		}
	};
}

describe('fitMismatch', () => {
	it('is null when the window exactly matches its target', () => {
		expect(fitMismatch(target, { ...target })).toBeNull();
	});

	it('names the axes that differ', () => {
		expect(fitMismatch(target, { ...target, y: 2100 })).toBe('y 2100≠2160');
		expect(fitMismatch(target, { x: 0, y: 1080, w: 3840, h: 1080 })).toBe(
			'x 0≠652, y 1080≠2160, w 3840≠2560, h 1080≠720'
		);
	});
});

describe('fitWindowVerified', () => {
	it('sets position then size and reports a clean fit on the first attempt', async () => {
		const win = fakeWindow();
		const sleep = vi.fn(async () => undefined);
		const result = await fitWindowVerified(win, target, { sleep });
		expect(result).toEqual({ ok: true, attempts: 1, mismatch: null });
		expect(win.setPosition).toHaveBeenCalledWith(652, 2160);
		expect(win.setSize).toHaveBeenCalledWith(2560, 720);
		expect(win.box).toEqual(target);
		expect(sleep).not.toHaveBeenCalled();
	});

	it('re-applies the fit when the OS moved the window off target (DPI hop / auto-restore)', async () => {
		// First set lands at y=2100 (as Windows' suggested rect would); the retry must fix it.
		const win = fakeWindow({ driftOnce: { y: 2100 } });
		const sleep = vi.fn(async () => undefined);
		const result = await fitWindowVerified(win, target, { sleep, attempts: 3 });
		expect(result).toEqual({ ok: true, attempts: 2, mismatch: 'y 2100≠2160' });
		expect(win.box).toEqual(target);
		expect(win.setPosition).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(1);
	});

	it('gives up after the attempt budget and reports the last mismatch', async () => {
		const stuck: PhysicalBox = { x: 0, y: 1080, w: 3840, h: 1080 };
		const win = fakeWindow({ alwaysDrift: stuck });
		const result = await fitWindowVerified(win, target, {
			sleep: async () => undefined,
			attempts: 3
		});
		expect(result.ok).toBe(false);
		expect(result.attempts).toBe(3);
		expect(result.mismatch).toBe('x 0≠652, y 1080≠2160, w 3840≠2560, h 1080≠720');
		expect(win.setPosition).toHaveBeenCalledTimes(3);
	});

	it('treats an unreadable position as a clean fit (best-effort, never throws)', async () => {
		const win = fakeWindow();
		win.readBack.mockRejectedValue(new Error('window gone'));
		const result = await fitWindowVerified(win, target, { sleep: async () => undefined });
		expect(result).toEqual({ ok: true, attempts: 1, mismatch: null });
	});
});
