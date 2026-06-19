import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// Capture the Tauri event handlers the component registers, so the test can fire drag/arrange events.
const handlers: Record<string, (e: { payload: unknown }) => void> = {};
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
		handlers[name] = cb;
		return Promise.resolve(() => delete handlers[name]);
	})
}));
vi.mock('@tauri-apps/api/window', () => ({
	currentMonitor: vi.fn(() =>
		Promise.resolve({
			position: { x: 0, y: 0 },
			size: { width: 1920, height: 1080 },
			scaleFactor: 1
		})
	)
}));

// A widgets.json (v2) with one floating `zone` widget carrying an exe match rule.
const LAYOUT = JSON.stringify({
	version: 2,
	monitors: {
		default: {
			root: { id: 'root', kind: 'col', children: [] },
			floating: [
				{
					id: 'z1',
					unit: {
						id: 'z1',
						type: 'zone',
						rect: { x: 0, y: 0, w: 960, h: 1080 },
						config: { matchExe: 'notepad.exe' }
					}
				}
			]
		}
	}
});

// A widgets.json (v2) with the zone DOCKED in the flow tree (no floating layer) — its on-screen rect
// is whatever the CSS flow lays out, so the overlay measures the rendered element rather than reading
// `unit.rect`.
const DOCKED_LAYOUT = JSON.stringify({
	version: 2,
	monitors: {
		default: {
			root: {
				id: 'root',
				kind: 'col',
				children: [
					{
						id: 'dz',
						unit: {
							id: 'dz',
							type: 'zone',
							rect: { x: 0, y: 0, w: 10, h: 10 },
							config: { matchExe: 'notepad.exe' }
						}
					}
				]
			},
			floating: []
		}
	}
});

// A layout whose floating layer holds non-zone units (a plain widget + a group) alongside a real
// zone — the non-zone/group entries must be skipped, only the zone becomes a snap target.
const MIXED_FLOATING_LAYOUT = JSON.stringify({
	version: 2,
	monitors: {
		default: {
			root: { id: 'root', kind: 'col', children: [] },
			floating: [
				{ id: 'g1', unit: { id: 'g1', kind: 'group', size: { w: 50, h: 50 }, child: null } },
				{
					id: 'w1',
					unit: { id: 'w1', type: 'clock', rect: { x: 0, y: 0, w: 100, h: 50 }, config: {} }
				},
				{
					id: 'z1',
					unit: {
						id: 'z1',
						type: 'zone',
						rect: { x: 0, y: 0, w: 960, h: 1080 },
						config: { matchExe: 'notepad.exe' }
					}
				}
			]
		}
	}
});

// The layout loadLayoutRaw() serves; swapped per test, reset in beforeEach.
let layoutJson = LAYOUT;

// A DOMRect-like for stubbing getBoundingClientRect (happy-dom has no layout engine).
const domRect = (x: number, y: number, w: number, h: number) => ({
	x,
	y,
	width: w,
	height: h,
	left: x,
	top: y,
	right: x + w,
	bottom: y + h,
	toJSON: () => undefined
});

const pointerProbe = vi.fn(() => Promise.resolve({ x: 0, y: 0, shift: false }));
const snapWindow = vi.fn<(hwnd: number, rect: unknown) => Promise<boolean>>(() =>
	Promise.resolve(true)
);
const listWindows = vi.fn(() =>
	Promise.resolve([
		{
			hwnd: 42,
			exe: 'C:\\Windows\\System32\\Notepad.exe',
			className: 'Notepad',
			title: 'Untitled - Notepad',
			rect: { x: 0, y: 0, w: 100, h: 100 }
		}
	])
);
vi.mock('../overlay', () => ({
	monitorParam: () => null,
	loadLayoutRaw: () => Promise.resolve(layoutJson),
	pointerProbe: () => pointerProbe(),
	snapWindow: (hwnd: number, rect: unknown) => snapWindow(hwnd, rect),
	listWindows: () => listWindows()
}));

import DragSnapLayer from './DragSnapLayer';

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const pollOnce = () => act(async () => void (await new Promise((r) => setTimeout(r, 80))));

beforeEach(() => {
	for (const k of Object.keys(handlers)) delete handlers[k];
	pointerProbe.mockReset();
	snapWindow.mockReset();
	snapWindow.mockResolvedValue(true);
	layoutJson = LAYOUT;
});
afterEach(() => {
	cleanup();
	document.querySelectorAll('.world').forEach((el) => el.remove());
});

describe('DragSnapLayer (zone widgets)', () => {
	it('snaps the dragged window into the armed zone (physical rect) on drag end', async () => {
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true }); // inside the left zone, armed
		render(<DragSnapLayer />);
		await settle();

		act(() => handlers['win_drag_start']?.({ payload: { hwnd: 7 } }));
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({ payload: { hwnd: 7 } });
			await Promise.resolve();
		});

		expect(snapWindow).toHaveBeenCalledTimes(1);
		expect(snapWindow).toHaveBeenCalledWith(7, { x: 0, y: 0, w: 960, h: 1080 });
	});

	it('does not snap when not armed (Shift up)', async () => {
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: false });
		render(<DragSnapLayer />);
		await settle();

		act(() => handlers['win_drag_start']?.({ payload: { hwnd: 7 } }));
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({ payload: { hwnd: 7 } });
			await Promise.resolve();
		});

		expect(snapWindow).not.toHaveBeenCalled();
	});

	it('arrange_zones snaps a matching window into its zone', async () => {
		pointerProbe.mockResolvedValue({ x: 0, y: 0, shift: false });
		render(<DragSnapLayer />);
		await settle();

		await act(async () => {
			handlers['arrange_zones']?.({ payload: {} });
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapWindow).toHaveBeenCalledWith(42, { x: 0, y: 0, w: 960, h: 1080 });
	});

	it('measures a DOCKED zone off the rendered DOM and snaps a matching window into it', async () => {
		layoutJson = DOCKED_LAYOUT;
		// Fake the rendered overlay: the `.world` origin + the docked zone element, with stubbed geometry
		// (happy-dom does no layout, so getBoundingClientRect is mocked).
		const world = document.createElement('div');
		world.className = 'world';
		world.getBoundingClientRect = () => domRect(0, 0, 1920, 1080) as DOMRect;
		const zoneEl = document.createElement('div');
		zoneEl.setAttribute('data-type', 'zone');
		zoneEl.setAttribute('data-w', 'dz');
		zoneEl.getBoundingClientRect = () => domRect(100, 200, 800, 600) as DOMRect;
		world.appendChild(zoneEl);
		document.body.appendChild(world);

		pointerProbe.mockResolvedValue({ x: 0, y: 0, shift: false });
		render(<DragSnapLayer />);
		await settle();

		await act(async () => {
			handlers['arrange_zones']?.({ payload: {} });
			await new Promise((r) => setTimeout(r, 0));
		});

		// Monitor at (0,0) scale 1 → physical == the measured `.world`-local rect.
		expect(snapWindow).toHaveBeenCalledWith(42, { x: 100, y: 200, w: 800, h: 600 });
	});

	it('tolerates a malformed widgets.json (parse throws → no zones, no snap)', async () => {
		layoutJson = '{ not valid json';
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true });
		render(<DragSnapLayer />);
		await settle();

		act(() => handlers['win_drag_start']?.({ payload: { hwnd: 7 } }));
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({ payload: { hwnd: 7 } });
			await Promise.resolve();
		});
		expect(snapWindow).not.toHaveBeenCalled();
	});

	it('tolerates an empty widgets.json (loadLayoutRaw returns nothing → no zones)', async () => {
		layoutJson = '';
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true });
		render(<DragSnapLayer />);
		await settle();

		await act(async () => {
			handlers['arrange_zones']?.({ payload: {} });
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(snapWindow).not.toHaveBeenCalled();
	});

	it('renders the zone highlight while a Shift-drag hovers an armed zone', async () => {
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true }); // inside the left zone
		const view = render(<DragSnapLayer />);
		await settle();

		act(() => handlers['win_drag_start']?.({ payload: { hwnd: 7 } }));
		await pollOnce();
		const hl = view.container.querySelector('.zone-drag-highlight') as HTMLElement;
		expect(hl).toBeTruthy();
		// The highlight uses the zone's LOCAL rect (logical px), not the physical one.
		expect(hl.style.left).toBe('0px');
		expect(hl.style.width).toBe('960px');

		await act(async () => {
			handlers['win_drag_end']?.({ payload: { hwnd: 7 } });
			await Promise.resolve();
		});
		// Cleared on release.
		expect(view.container.querySelector('.zone-drag-highlight')).toBeNull();
	});

	it('reloads its zones when a layout_changed event fires', async () => {
		layoutJson = JSON.stringify({ version: 2, monitors: {} }); // start with no zones
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true });
		render(<DragSnapLayer />);
		await settle();

		// No zones yet → a drag arms nothing.
		act(() => handlers['win_drag_start']?.({ payload: { hwnd: 7 } }));
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({ payload: { hwnd: 7 } });
			await Promise.resolve();
		});
		expect(snapWindow).not.toHaveBeenCalled();

		// A layout with zones lands; layout_changed triggers a reload.
		layoutJson = LAYOUT;
		await act(async () => {
			handlers['layout_changed']?.({ payload: {} });
			await new Promise((r) => setTimeout(r, 0));
		});
		act(() => handlers['win_drag_start']?.({ payload: { hwnd: 8 } }));
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({ payload: { hwnd: 8 } });
			await Promise.resolve();
		});
		expect(snapWindow).toHaveBeenCalledWith(8, { x: 0, y: 0, w: 960, h: 1080 });
	});

	it('ignores a collapsed (zero-size) docked zone — not a snap target', async () => {
		layoutJson = DOCKED_LAYOUT;
		const world = document.createElement('div');
		world.className = 'world';
		world.getBoundingClientRect = () => domRect(0, 0, 1920, 1080) as DOMRect;
		const zoneEl = document.createElement('div');
		zoneEl.setAttribute('data-type', 'zone');
		zoneEl.setAttribute('data-w', 'dz');
		zoneEl.getBoundingClientRect = () => domRect(0, 0, 0, 0) as DOMRect; // collapsed
		world.appendChild(zoneEl);
		document.body.appendChild(world);

		pointerProbe.mockResolvedValue({ x: 0, y: 0, shift: false });
		render(<DragSnapLayer />);
		await settle();

		await act(async () => {
			handlers['arrange_zones']?.({ payload: {} });
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(snapWindow).not.toHaveBeenCalled();
	});

	it('ignores a docked zone element with no data-w id', async () => {
		layoutJson = DOCKED_LAYOUT;
		const world = document.createElement('div');
		world.className = 'world';
		world.getBoundingClientRect = () => domRect(0, 0, 1920, 1080) as DOMRect;
		const zoneEl = document.createElement('div');
		zoneEl.setAttribute('data-type', 'zone'); // no data-w attribute → skipped
		zoneEl.getBoundingClientRect = () => domRect(100, 200, 800, 600) as DOMRect;
		world.appendChild(zoneEl);
		document.body.appendChild(world);

		pointerProbe.mockResolvedValue({ x: 0, y: 0, shift: false });
		render(<DragSnapLayer />);
		await settle();

		await act(async () => {
			handlers['arrange_zones']?.({ payload: {} });
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(snapWindow).not.toHaveBeenCalled();
	});

	it('skips non-zone floating units (a plain widget + a group), arming only the zone', async () => {
		layoutJson = MIXED_FLOATING_LAYOUT;
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true }); // inside the left zone
		render(<DragSnapLayer />);
		await settle();

		act(() => handlers['win_drag_start']?.({ payload: { hwnd: 7 } }));
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({ payload: { hwnd: 7 } });
			await Promise.resolve();
		});
		// Only the single zone is a snap target; the group + clock contribute nothing.
		expect(snapWindow).toHaveBeenCalledTimes(1);
		expect(snapWindow).toHaveBeenCalledWith(7, { x: 0, y: 0, w: 960, h: 1080 });
	});

	it('unmounting before currentMonitor() resolves cancels the setup (alive guard)', async () => {
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true });
		const view = render(<DragSnapLayer />);
		view.unmount(); // tear down before currentMonitor()/loadLayoutRaw() resolve
		// Let the in-flight currentMonitor()/loadLayoutRaw() promises settle against the dead instance;
		// the `!alive` guard must bail without throwing.
		await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
		expect(true).toBe(true); // reached here = no unhandled rejection / setState-after-unmount throw
	});

	it('unmounting mid-reload cancels it (reload alive guard)', async () => {
		// Mount normally so the layout_changed listener is registered.
		const view = render(<DragSnapLayer />);
		await settle();

		// Fire layout_changed (starts reload(), which suspends at `await loadLayoutRaw()`), then unmount
		// synchronously in the same act() before the awaited continuation runs. When reload resumes its
		// `!alive` guard must bail (line 73) without writing zone refs or throwing.
		await act(async () => {
			handlers['layout_changed']?.({ payload: {} });
			view.unmount();
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(true).toBe(true); // reload's `!alive` branch returned cleanly
	});

	it('snaps a window dragged (Shift held) over a docked zone on release', async () => {
		layoutJson = DOCKED_LAYOUT;
		const world = document.createElement('div');
		world.className = 'world';
		world.getBoundingClientRect = () => domRect(0, 0, 1920, 1080) as DOMRect;
		const zoneEl = document.createElement('div');
		zoneEl.setAttribute('data-type', 'zone');
		zoneEl.setAttribute('data-w', 'dz');
		zoneEl.getBoundingClientRect = () => domRect(100, 200, 800, 600) as DOMRect;
		world.appendChild(zoneEl);
		document.body.appendChild(world);

		pointerProbe.mockResolvedValue({ x: 400, y: 400, shift: true }); // inside the docked zone, armed
		render(<DragSnapLayer />);
		await settle();

		act(() => handlers['win_drag_start']?.({ payload: { hwnd: 9 } }));
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({ payload: { hwnd: 9 } });
			await Promise.resolve();
		});

		expect(snapWindow).toHaveBeenCalledWith(9, { x: 100, y: 200, w: 800, h: 600 });
	});

	// Kept LAST: a slow never-fully-drained probe loop is hard to fully quiesce within a test, so run
	// it after every other case to avoid leaking a stray in-flight probe into a sibling.
	it('does not overlap pointer probes — never more than one in flight at a time (busy guard)', async () => {
		// A slow probe lets several poll ticks pile up. The busy guard must keep exactly one probe in
		// flight: track concurrency and assert it never exceeds 1, even across many overlapping ticks.
		let inFlight = 0;
		let maxInFlight = 0;
		pointerProbe.mockImplementation(async () => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 60)); // slower than POLL_MS (33ms) → ticks overlap
			inFlight -= 1;
			return { x: 0, y: 0, shift: false };
		});
		render(<DragSnapLayer />);
		await settle();

		act(() => handlers['win_drag_start']?.({ payload: { hwnd: 7 } }));
		// Let many poll intervals fire while probes are slow.
		await act(async () => void (await new Promise((r) => setTimeout(r, 250))));
		act(() => handlers['win_drag_end']?.({ payload: { hwnd: 7 } })); // stops the interval

		expect(pointerProbe).toHaveBeenCalled(); // probing happened
		expect(maxInFlight).toBe(1); // the busy guard prevented any overlap

		// Drain the last in-flight probe (60ms) so nothing leaks past this test.
		await act(async () => void (await new Promise((r) => setTimeout(r, 80))));
		expect(inFlight).toBe(0);
	});
});
