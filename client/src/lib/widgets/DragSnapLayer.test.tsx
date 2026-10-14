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

// LAYOUT with its only floating zone under a DIFFERENT id — for the stale-probe test, where a drag
// snapshot taken against z1 resolves after the zone set has been re-snapshotted to this one.
const OTHER_ZONE_LAYOUT = JSON.stringify({
	version: 2,
	monitors: {
		default: {
			root: { id: 'root', kind: 'col', children: [] },
			floating: [
				{
					id: 'z2',
					unit: {
						id: 'z2',
						type: 'zone',
						rect: { x: 960, y: 0, w: 960, h: 1080 },
						config: { matchExe: 'notepad.exe' }
					}
				}
			]
		}
	}
});

// The layout loadLayoutRaw() serves; swapped per test, reset in beforeEach.
let layoutJson = LAYOUT;
const readLayout = vi.fn(() => Promise.resolve(layoutJson));

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
	loadLayoutRaw: () => readLayout(),
	pointerProbe: () => pointerProbe(),
	snapWindow: (hwnd: number, rect: unknown) => snapWindow(hwnd, rect),
	listWindows: () => listWindows()
}));

import DragSnapLayer from './DragSnapLayer';
import { currentMonitor } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const pollOnce = () => act(async () => void (await new Promise((r) => setTimeout(r, 80))));

beforeEach(() => {
	readLayout.mockReset().mockImplementation(() => Promise.resolve(layoutJson));
	vi.mocked(currentMonitor)
		.mockReset()
		.mockResolvedValue({
			position: { x: 0, y: 0 },
			size: { width: 1920, height: 1080 },
			scaleFactor: 1
		} as Awaited<ReturnType<typeof currentMonitor>>);
	for (const k of Object.keys(handlers)) delete handlers[k];
	pointerProbe.mockReset();
	snapWindow.mockReset();
	snapWindow.mockResolvedValue(true);
	layoutJson = LAYOUT;
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
	document.querySelectorAll('.world').forEach((el) => el.remove());
});

describe('DragSnapLayer (zone widgets)', () => {
	it.each(['idle', 'probe', 'monitor'] as const)(
		'refreshes drag highlights after layout changes while %s',
		async (stage) => {
			vi.useFakeTimers();
			pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true });
			const view = render(<DragSnapLayer />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			await act(async () => {
				await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(33);
			});
			expect(view.container.querySelector('.zone-drag-highlight')).not.toBeNull();
			let finishProbe!: (pointer: { x: number; y: number; shift: boolean }) => void;
			let finishMonitor!: (monitor: Awaited<ReturnType<typeof currentMonitor>>) => void;
			if (stage === 'probe') {
				pointerProbe.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							finishProbe = resolve;
						})
				);
				await act(async () => {
					await vi.advanceTimersByTimeAsync(33);
				});
			}
			if (stage === 'monitor') {
				await act(async () => {
					await handlers['layout_changed']?.({ payload: {} });
				});
				vi.mocked(currentMonitor).mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							finishMonitor = resolve;
						})
				);
				await act(async () => {
					await vi.advanceTimersByTimeAsync(33);
				});
			}
			let finishLayout!: (layout: string) => void;
			readLayout.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishLayout = resolve;
					})
			);
			let reload!: Promise<unknown>;
			act(() => {
				reload = Promise.resolve(handlers['layout_changed']?.({ payload: {} }));
			});
			await act(async () => {
				if (stage === 'probe') finishProbe({ x: 480, y: 540, shift: true });
				if (stage === 'monitor') finishMonitor(null);
				await vi.advanceTimersByTimeAsync(33);
			});
			expect(view.container.querySelector('.zone-drag-highlight')).toBeNull();
			await act(async () => {
				finishLayout(OTHER_ZONE_LAYOUT);
				await reload;
			});
			pointerProbe.mockResolvedValue({ x: 1080, y: 540, shift: true });
			await act(async () => {
				await vi.advanceTimersByTimeAsync(33);
			});
			expect((view.container.querySelector('.zone-drag-highlight') as HTMLElement).style.left).toBe(
				'960px'
			);
		}
	);

	it('stops an arrangement between window moves when the layout changes', async () => {
		const layout = JSON.parse(LAYOUT);
		const second = structuredClone(layout.monitors.default.floating[0]);
		second.id = second.unit.id = 'z2';
		second.unit.rect.x = 960;
		layout.monitors.default.floating.push(second);
		layoutJson = JSON.stringify(layout);
		listWindows.mockResolvedValueOnce(
			[42, 43].map((hwnd) => ({
				hwnd,
				exe: 'notepad.exe',
				className: 'Notepad',
				title: 'Notepad',
				rect: { x: 0, y: 0, w: 100, h: 100 }
			}))
		);
		render(<DragSnapLayer />);
		await settle();
		let finish!: (success: boolean) => void;
		snapWindow.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		let arrangement!: Promise<unknown>;
		await act(async () => {
			arrangement = Promise.resolve(handlers['arrange_zones']?.({ payload: {} }));
			await Promise.resolve();
		});
		expect(snapWindow).toHaveBeenCalledOnce();
		await act(async () => {
			await handlers['layout_changed']?.({ payload: {} });
		});
		await act(async () => {
			finish(true);
			await arrangement;
		});
		expect(snapWindow).toHaveBeenCalledOnce();
	});
	it.each(['arrange monitor', 'arrange windows', 'release monitor', 'drag monitor'] as const)(
		'rejects uncertain cached targets when a layout reload starts during %s',
		async (stage) => {
			pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true });
			render(<DragSnapLayer />);
			await settle();
			if (stage === 'release monitor')
				await act(async () => {
					await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
				});
			let finishMonitor!: (monitor: Awaited<ReturnType<typeof currentMonitor>>) => void;
			let finishWindows!: (windows: Awaited<ReturnType<typeof listWindows>>) => void;
			if (stage === 'arrange windows')
				listWindows.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							finishWindows = resolve;
						})
				);
			else
				vi.mocked(currentMonitor).mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							finishMonitor = resolve;
						})
				);
			let operation!: Promise<unknown>;
			await act(async () => {
				operation = Promise.resolve(
					stage === 'release monitor'
						? handlers['win_drag_end']?.({
								payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
							})
						: stage === 'drag monitor'
							? handlers['win_drag_start']?.({ payload: { hwnd: 7 } })
							: handlers['arrange_zones']?.({ payload: {} })
				);
				await Promise.resolve();
			});
			let finishLayout!: (layout: string) => void;
			readLayout.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishLayout = resolve;
					})
			);
			let reload!: Promise<unknown>;
			act(() => {
				reload = Promise.resolve(handlers['layout_changed']?.({ payload: {} }));
			});
			await act(async () => {
				if (stage === 'arrange windows')
					finishWindows([
						{
							hwnd: 42,
							exe: 'notepad.exe',
							className: 'Notepad',
							title: 'Notepad',
							rect: { x: 0, y: 0, w: 100, h: 100 }
						}
					]);
				else finishMonitor(null);
				await operation;
			});
			expect(snapWindow).not.toHaveBeenCalled();
			await act(async () => {
				finishLayout(LAYOUT);
				await reload;
			});
			if (stage === 'drag monitor') {
				await pollOnce();
				expect(document.querySelector('.zone-drag-highlight')).not.toBeNull();
			}
		}
	);
	it('does not snap into a measured zone hidden after the last highlight poll', async () => {
		vi.useFakeTimers();
		layoutJson = DOCKED_LAYOUT;
		const world = document.createElement('div');
		world.className = 'world';
		world.getBoundingClientRect = () => domRect(0, 0, 1920, 1080) as DOMRect;
		const element = document.createElement('div');
		element.setAttribute('data-type', 'zone');
		element.setAttribute('data-w', 'dz');
		element.getBoundingClientRect = () => domRect(100, 200, 800, 600) as DOMRect;
		world.appendChild(element);
		document.body.appendChild(world);
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true });
		const view = render(<DragSnapLayer />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(33);
		});
		expect(view.container.querySelector('.zone-drag-highlight')).not.toBeNull();
		element.style.visibility = 'hidden';
		await act(async () => {
			await handlers['win_drag_end']?.({
				payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
			});
		});
		expect(snapWindow).not.toHaveBeenCalled();
	});
	it('refuses a release when its native pointer capture failed', async () => {
		render(<DragSnapLayer />);
		await settle();
		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
		});
		await act(async () => {
			await handlers['win_drag_end']?.({ payload: { hwnd: 7, pointer: null } });
		});
		expect(snapWindow).not.toHaveBeenCalled();
	});

	it.each(['unmount', 'next drag'] as const)(
		'rejects a release target read after %s',
		async (change) => {
			const view = render(<DragSnapLayer />);
			await settle();
			await act(async () => {
				await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
			});
			let finish!: (monitor: Awaited<ReturnType<typeof currentMonitor>>) => void;
			vi.mocked(currentMonitor).mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					})
			);
			let release!: Promise<unknown>;
			act(() => {
				release = Promise.resolve(
					handlers['win_drag_end']?.({
						payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
					})
				);
			});
			if (change === 'unmount') view.unmount();
			else
				await act(async () => {
					await handlers['win_drag_start']?.({ payload: { hwnd: 8 } });
				});
			await act(async () => {
				finish(null);
				await release;
			});
			expect(snapWindow).not.toHaveBeenCalled();
		}
	);
	it.each(['shift released', 'pointer moved', 'zone removed'] as const)(
		'does not use the last highlight after %s before release',
		async (change) => {
			vi.useFakeTimers();
			pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true });
			render(<DragSnapLayer />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			await act(async () => {
				await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(33);
			});
			if (change === 'zone removed') {
				layoutJson = JSON.stringify({
					version: 2,
					monitors: {
						default: {
							root: { id: 'root', kind: 'col', children: [] },
							floating: []
						}
					}
				});
				await act(async () => {
					await handlers['layout_changed']?.({ payload: {} });
				});
			}
			await act(async () => {
				await handlers['win_drag_end']?.({
					payload: {
						hwnd: 7,
						pointer: {
							x: change === 'pointer moved' ? 1500 : 480,
							y: 540,
							shift: change !== 'shift released'
						}
					}
				});
			});
			expect(snapWindow).not.toHaveBeenCalled();
		}
	);
	it.each(['condition', 'hidden', 'collapse'] as const)(
		'does not arrange into a zone hidden by %s',
		async (mode) => {
			layoutJson = DOCKED_LAYOUT;
			const world = document.createElement('div');
			world.className = 'world';
			world.getBoundingClientRect = () => domRect(0, 0, 1920, 1080) as DOMRect;
			const parent = document.createElement('div');
			if (mode === 'condition') parent.setAttribute('data-hidden', '');
			const element = document.createElement('div');
			element.setAttribute('data-type', 'zone');
			element.setAttribute('data-w', 'dz');
			if (mode !== 'condition') element.style.visibility = mode;
			element.getBoundingClientRect = () => domRect(100, 200, 800, 600) as DOMRect;
			parent.appendChild(element);
			world.appendChild(parent);
			document.body.appendChild(world);
			render(<DragSnapLayer />);
			await settle();
			await act(async () => {
				await handlers['arrange_zones']?.({ payload: {} });
			});
			expect(snapWindow).not.toHaveBeenCalled();
		}
	);
	it.each(['docked', 'floating'] as const)(
		'arranges windows into a measured zone in a %s reusable widget',
		async (placement) => {
			const zone = JSON.parse(DOCKED_LAYOUT).monitors.default.root.children[0];
			zone.unit.config.matchExe = 'other.exe';
			const group = {
				id: 'group',
				unit: {
					id: 'group',
					kind: 'group',
					def: 'zones',
					size: { w: 800, h: 600 },
					child: { id: 'fallback', kind: 'col', children: [] },
					params: { exe: 'notepad.exe' }
				}
			};
			layoutJson = JSON.stringify({
				version: 2,
				monitors: {
					default: {
						root: { id: 'root', kind: 'col', children: placement === 'docked' ? [group] : [] },
						floating: placement === 'floating' ? [group] : []
					}
				},
				library: {
					version: 1,
					defs: [
						{
							id: 'zones',
							name: 'Zones',
							size: { w: 800, h: 600 },
							child: zone,
							params: [{ key: 'exe', target: 'unit.config.matchExe' }]
						}
					]
				}
			});
			const world = document.createElement('div');
			world.className = 'world';
			world.getBoundingClientRect = () => domRect(20, 30, 1920, 1080) as DOMRect;
			const element = document.createElement('div');
			element.setAttribute('data-type', 'zone');
			element.setAttribute('data-w', 'group/dz');
			element.getBoundingClientRect = () => domRect(120, 230, 800, 600) as DOMRect;
			world.appendChild(element);
			document.body.appendChild(world);
			render(<DragSnapLayer />);
			await settle();
			await act(async () => {
				await handlers['arrange_zones']?.({ payload: {} });
			});
			expect(snapWindow).toHaveBeenCalledWith(42, { x: 100, y: 200, w: 800, h: 600 });
		}
	);
	it.each(['release', 'registration'] as const)(
		'handles a late drag-listener %s failure after disposal',
		async (mode) => {
			const original = vi.mocked(listen).getMockImplementation()!;
			let finish!: (stop: () => void) => void;
			let reject!: (error: Error) => void;
			vi.mocked(listen)
				.mockImplementationOnce(original)
				.mockImplementationOnce(
					() =>
						new Promise((resolve, fail) => {
							finish = resolve;
							reject = fail;
						})
				);
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const view = render(<DragSnapLayer />);
			view.unmount();
			const error = new Error('late drag listener failure');
			await act(async () => {
				if (mode === 'release')
					finish(async () => {
						throw error;
					});
				else reject(error);
				await Promise.resolve();
			});
			if (mode === 'release')
				expect(warn).toHaveBeenCalledWith('Zone listener cleanup failed', error);
			else expect(warn).not.toHaveBeenCalled();
		}
	);

	it('reads the current layout before arranging when change notifications are unavailable', async () => {
		vi.mocked(listen).mockRejectedValueOnce(new Error('layout listener unavailable'));
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		render(<DragSnapLayer />);
		await settle();
		layoutJson = JSON.stringify({
			version: 2,
			monitors: { default: { root: { id: 'root', kind: 'col', children: [] }, floating: [] } }
		});
		await act(async () => {
			await handlers['arrange_zones']?.({ payload: {} });
		});
		expect(snapWindow).not.toHaveBeenCalled();
	});

	it('releases a listener acquired after disposal and handles its asynchronous failure', async () => {
		let finish!: (stop: () => void) => void;
		vi.mocked(listen).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		const error = new Error('late unlisten failed');
		const stop = vi.fn(async () => {
			throw error;
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const view = render(<DragSnapLayer />);
		view.unmount();
		await act(async () => {
			finish(stop);
			await Promise.resolve();
		});
		expect(stop).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith('Zone listener cleanup failed', error);
	});
	it('disables partial drag setup when a native listener registration fails', async () => {
		const error = new Error('end listener unavailable');
		const original = vi.mocked(listen).getMockImplementation()!;
		vi.mocked(listen)
			.mockImplementationOnce(original)
			.mockImplementationOnce(original)
			.mockRejectedValueOnce(error);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		render(<DragSnapLayer />);
		await settle();
		expect(warn).toHaveBeenCalledWith('Zone drag listener registration failed', error);
		expect(handlers['win_drag_start']).toBeUndefined();
		expect(handlers['arrange_zones']).toBeUndefined();
	});
	it.each(['mounted', 'disposed'] as const)(
		'handles failed layout-listener registration while %s',
		async (state) => {
			let reject!: (error: Error) => void;
			vi.mocked(listen).mockImplementationOnce(
				() =>
					new Promise((_, fail) => {
						reject = fail;
					})
			);
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const view = render(<DragSnapLayer />);
			if (state === 'disposed') view.unmount();
			const error = new Error('layout listener unavailable');
			await act(async () => {
				reject(error);
				await Promise.resolve();
			});
			if (state === 'mounted')
				expect(warn).toHaveBeenCalledWith('Zone layout listener registration failed', error);
			else expect(warn).not.toHaveBeenCalled();
		}
	);

	it('does not use stale zones when a reload and its retry fail, then recovers on the next operation', async () => {
		render(<DragSnapLayer />);
		await settle();
		readLayout
			.mockRejectedValueOnce(new Error('first failure'))
			.mockRejectedValueOnce(new Error('retry failure'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await act(async () => {
			await handlers['layout_changed']?.({ payload: {} });
		});
		await act(async () => {
			await handlers['arrange_zones']?.({ payload: {} });
		});
		expect(snapWindow).not.toHaveBeenCalled();
		await act(async () => {
			await handlers['arrange_zones']?.({ payload: {} });
		});
		expect(snapWindow).toHaveBeenCalledWith(42, { x: 0, y: 0, w: 960, h: 1080 });
		expect(warn).toHaveBeenCalledTimes(2);
	});
	it('rejects queued drag and arrange events after the component is disposed', async () => {
		const view = render(<DragSnapLayer />);
		await settle();
		const start = handlers['win_drag_start'],
			arrange = handlers['arrange_zones'],
			reload = handlers['layout_changed'];
		view.unmount();
		vi.mocked(currentMonitor).mockClear();
		readLayout.mockClear();
		await act(async () => {
			await start({ payload: { hwnd: 7 } });
			await arrange({ payload: {} });
			await reload({ payload: {} });
		});
		expect(currentMonitor).not.toHaveBeenCalled();
		expect(readLayout).not.toHaveBeenCalled();
		expect(snapWindow).not.toHaveBeenCalled();
	});

	it('retries a failed current layout read before the next arrangement', async () => {
		render(<DragSnapLayer />);
		await settle();
		const error = new Error('temporary layout IO error');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		readLayout.mockRejectedValueOnce(error);
		await act(async () => {
			await handlers['layout_changed']?.({ payload: {} });
		});
		await act(async () => {
			await handlers['arrange_zones']?.({ payload: {} });
		});
		expect(snapWindow).toHaveBeenCalledWith(42, { x: 0, y: 0, w: 960, h: 1080 });
		expect(warn).toHaveBeenCalledWith('Zone layout reload failed', error);
	});
	it.each(['unmount', 'newer read'] as const)(
		'ignores a stale layout IO failure after %s',
		async (reason) => {
			const view = render(<DragSnapLayer />);
			await settle();
			let reject!: (error: Error) => void;
			readLayout.mockImplementationOnce(
				() =>
					new Promise((_, fail) => {
						reject = fail;
					})
			);
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			act(() => {
				void handlers['layout_changed']?.({ payload: {} });
			});
			if (reason === 'unmount') view.unmount();
			else
				await act(async () => {
					await handlers['layout_changed']?.({ payload: {} });
				});
			await act(async () => {
				reject(new Error('obsolete read failed'));
				await Promise.resolve();
			});
			expect(warn).not.toHaveBeenCalled();
		}
	);
	it('loads zones even when the initial monitor query fails', async () => {
		const error = new Error('initial monitor query failed');
		vi.mocked(currentMonitor).mockRejectedValueOnce(error);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		render(<DragSnapLayer />);
		await settle();
		await act(async () => {
			await handlers['arrange_zones']?.({ payload: {} });
		});
		expect(snapWindow).toHaveBeenCalledWith(42, { x: 0, y: 0, w: 960, h: 1080 });
		expect(warn).toHaveBeenCalledWith('Initial zone monitor read failed', error);
	});
	it('ignores an initial monitor failure after disposal', async () => {
		let reject!: (error: Error) => void;
		vi.mocked(currentMonitor).mockImplementationOnce(
			() =>
				new Promise((_, fail) => {
					reject = fail;
				})
		);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const view = render(<DragSnapLayer />);
		view.unmount();
		await act(async () => {
			reject(new Error('closed window'));
			await Promise.resolve();
		});
		expect(warn).not.toHaveBeenCalled();
		expect(readLayout).not.toHaveBeenCalled();
	});

	it('does not restore removed zones when an older layout read completes late', async () => {
		render(<DragSnapLayer />);
		await settle();
		let finish!: (layout: string) => void;
		readLayout.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		act(() => {
			void handlers['layout_changed']?.({ payload: {} });
		});
		layoutJson = JSON.stringify({
			version: 2,
			monitors: { default: { root: { id: 'root', kind: 'col', children: [] }, floating: [] } }
		});
		await act(async () => {
			await handlers['layout_changed']?.({ payload: {} });
		});
		await act(async () => {
			finish(LAYOUT);
			await Promise.resolve();
		});
		await act(async () => {
			await handlers['arrange_zones']?.({ payload: {} });
		});
		expect(snapWindow).not.toHaveBeenCalled();
	});

	it('handles a window closing before its snap completes', async () => {
		vi.useFakeTimers();
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true });
		const view = render(<DragSnapLayer />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
		});
		await act(async () => {
			await vi.advanceTimersToNextTimerAsync();
		});
		const error = new Error('window no longer exists');
		snapWindow.mockRejectedValueOnce(error);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await act(async () => {
			await handlers['win_drag_end']?.({
				payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
			});
		});
		expect(warn).toHaveBeenCalledWith('Zone drag failed', error);
		expect(view.container.querySelector('.zone-drag-highlight')).toBeNull();
	});

	it.each(['monitor', 'enumeration', 'snap'] as const)(
		'handles arrangement %s failures without an unhandled rejection',
		async (failure) => {
			render(<DragSnapLayer />);
			await settle();
			const error = new Error('temporary native failure');
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			if (failure === 'monitor') vi.mocked(currentMonitor).mockRejectedValueOnce(error);
			else if (failure === 'enumeration') listWindows.mockRejectedValueOnce(error);
			else snapWindow.mockRejectedValueOnce(error);
			await act(async () => {
				await handlers['arrange_zones']?.({ payload: {} });
			});
			expect(warn).toHaveBeenCalledWith('Zone arrangement failed', error);
			warn.mockRestore();
		}
	);
	it.each(['unmount', 'newer request'] as const)(
		'ignores an obsolete arrangement error after %s',
		async (reason) => {
			const view = render(<DragSnapLayer />);
			await settle();
			let reject!: (error: Error) => void;
			listWindows.mockImplementationOnce(
				() =>
					new Promise((_, fail) => {
						reject = fail;
					})
			);
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			act(() => {
				void handlers['arrange_zones']?.({ payload: {} });
			});
			if (reason === 'unmount') view.unmount();
			else
				await act(async () => {
					await handlers['arrange_zones']?.({ payload: {} });
				});
			await act(async () => {
				reject(new Error('obsolete failure'));
				await Promise.resolve();
			});
			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
		}
	);
	it('ignores a probe failure after its drag ends', async () => {
		vi.useFakeTimers();
		render(<DragSnapLayer />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		let reject!: (error: Error) => void;
		pointerProbe.mockImplementationOnce(
			() =>
				new Promise((_, fail) => {
					reject = fail;
				})
		);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
		});
		await act(async () => {
			await vi.advanceTimersToNextTimerAsync();
		});
		await act(async () => {
			await handlers['win_drag_end']?.({
				payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
			});
		});
		await act(async () => {
			reject(new Error('obsolete failure'));
			await Promise.resolve();
		});
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it.each(['monitor', 'pointer'] as const)(
		'stops an uncertain drag after a failed %s read',
		async (failure) => {
			vi.useFakeTimers();
			const view = render(<DragSnapLayer />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			const error = new Error('temporary native read failure');
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			if (failure === 'monitor') vi.mocked(currentMonitor).mockRejectedValueOnce(error);
			else pointerProbe.mockRejectedValueOnce(error);
			await act(async () => {
				await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});
			await act(async () => {
				await handlers['win_drag_end']?.({
					payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
				});
			});
			expect(snapWindow).not.toHaveBeenCalled();
			expect(view.container.querySelector('.zone-drag-highlight')).toBeNull();
			expect(warn).toHaveBeenCalledWith('Zone drag failed', error);
			expect(vi.getTimerCount()).toBe(0);
			warn.mockRestore();
		}
	);

	it.each(['end', 'unmount'] as const)(
		'does not start polling when %s occurs during monitor refresh',
		async (ending) => {
			vi.useFakeTimers();
			const view = render(<DragSnapLayer />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			let finish!: (monitor: Awaited<ReturnType<typeof currentMonitor>>) => void;
			vi.mocked(currentMonitor).mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					})
			);
			act(() => {
				void handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
			});
			if (ending === 'end')
				await act(async () => {
					await handlers['win_drag_end']?.({
						payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: false } }
					});
				});
			else view.unmount();
			await act(async () => {
				finish(null);
				await vi.advanceTimersByTimeAsync(100);
			});
			expect(pointerProbe).not.toHaveBeenCalled();
			expect(snapWindow).not.toHaveBeenCalled();
		}
	);
	it.each(['unmount', 'newer request'] as const)(
		'does not apply an arrangement after %s supersedes its window query',
		async (reason) => {
			const view = render(<DragSnapLayer />);
			await settle();
			let finish!: (windows: Awaited<ReturnType<typeof listWindows>>) => void;
			listWindows.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					})
			);
			act(() => {
				void handlers['arrange_zones']?.({ payload: {} });
			});
			if (reason === 'unmount') view.unmount();
			else
				await act(async () => {
					await handlers['arrange_zones']?.({ payload: {} });
				});
			await act(async () => {
				finish([
					{
						hwnd: 7,
						exe: 'notepad.exe',
						className: 'Notepad',
						title: 'Old request',
						rect: { x: 0, y: 0, w: 100, h: 100 }
					}
				]);
				await Promise.resolve();
			});
			expect(snapWindow).not.toHaveBeenCalledWith(7, expect.anything());
			if (reason === 'newer request')
				expect(snapWindow).toHaveBeenCalledWith(42, expect.anything());
		}
	);

	it.each(['drag', 'arrange'] as const)(
		'refreshes monitor position and scale before %s',
		async (mode) => {
			vi.useFakeTimers();
			vi.mocked(currentMonitor).mockResolvedValue({
				position: { x: 0, y: 0 },
				size: { width: 1920, height: 1080 },
				scaleFactor: 1
			} as Awaited<ReturnType<typeof currentMonitor>>);
			render(<DragSnapLayer />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			vi.mocked(currentMonitor).mockResolvedValue({
				position: { x: 2000, y: 100 },
				size: { width: 2880, height: 1620 },
				scaleFactor: 1.5
			} as Awaited<ReturnType<typeof currentMonitor>>);
			pointerProbe.mockResolvedValue({ x: 2480, y: 640, shift: true });
			if (mode === 'drag') {
				await act(async () => {
					await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
				});
				await act(async () => {
					await vi.advanceTimersToNextTimerAsync();
				});
				await act(async () => {
					await handlers['win_drag_end']?.({
						payload: { hwnd: 7, pointer: { x: 2480, y: 640, shift: true } }
					});
				});
			} else {
				listWindows.mockResolvedValueOnce([
					{
						hwnd: 7,
						exe: 'notepad.exe',
						className: 'Notepad',
						title: 'Notepad',
						rect: { x: 0, y: 0, w: 100, h: 100 }
					}
				]);
				await act(async () => {
					await handlers['arrange_zones']?.({ payload: {} });
				});
			}
			expect(snapWindow).toHaveBeenCalledWith(7, { x: 2000, y: 100, w: 1440, h: 1620 });
		}
	);

	it('snaps the dragged window into the armed zone (physical rect) on drag end', async () => {
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true }); // inside the left zone, armed
		render(<DragSnapLayer />);
		await settle();

		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
		});
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({
				payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
			});
			await Promise.resolve();
		});

		expect(snapWindow).toHaveBeenCalledTimes(1);
		expect(snapWindow).toHaveBeenCalledWith(7, { x: 0, y: 0, w: 960, h: 1080 });
	});

	it('does not snap when not armed (Shift up)', async () => {
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: false });
		render(<DragSnapLayer />);
		await settle();

		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
		});
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({
				payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: false } }
			});
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

		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
		});
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({
				payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
			});
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

		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
		});
		await pollOnce();
		const hl = view.container.querySelector('.zone-drag-highlight') as HTMLElement;
		expect(hl).toBeTruthy();
		// The highlight uses the zone's LOCAL rect (logical px), not the physical one.
		expect(hl.style.left).toBe('0px');
		expect(hl.style.width).toBe('960px');

		await act(async () => {
			handlers['win_drag_end']?.({
				payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
			});
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
		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
		});
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({
				payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
			});
			await Promise.resolve();
		});
		expect(snapWindow).not.toHaveBeenCalled();

		// A layout with zones lands; layout_changed triggers a reload.
		layoutJson = LAYOUT;
		await act(async () => {
			handlers['layout_changed']?.({ payload: {} });
			await new Promise((r) => setTimeout(r, 0));
		});
		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 8 } });
		});
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({
				payload: { hwnd: 8, pointer: { x: 480, y: 540, shift: true } }
			});
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

		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
		});
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({
				payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
			});
			await Promise.resolve();
		});
		// Only the single zone is a snap target; the group + clock contribute nothing.
		expect(snapWindow).toHaveBeenCalledTimes(1);
		expect(snapWindow).toHaveBeenCalledWith(7, { x: 0, y: 0, w: 960, h: 1080 });
	});

	it('tolerates currentMonitor() resolving null — keeps the default origin, still loads zones', async () => {
		vi.mocked(currentMonitor).mockResolvedValueOnce(null);
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true });
		render(<DragSnapLayer />);
		await settle();

		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
		});
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({
				payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
			});
			await Promise.resolve();
		});

		// The default monitor (origin 0,0 · scale 1) stands in, so the zone still arms and snaps.
		expect(snapWindow).toHaveBeenCalledWith(7, { x: 0, y: 0, w: 960, h: 1080 });
	});

	it('rejects a stale probe so it cannot snap the next dragged window into an old zone', async () => {
		vi.useFakeTimers();
		// tick() captures the phys zone list BEFORE awaiting the probe but reads the local-rect map
		// AFTER it — so a probe that resolves after a layout change + a new drag re-snapshot can arm a
		// zone that is no longer in the map. The highlight must fall back to null, not crash.
		let resolveProbe: ((p: { x: number; y: number; shift: boolean }) => void) | null = null;
		pointerProbe
			.mockResolvedValueOnce({ x: 480, y: 540, shift: true }) // tick 1: arms z1 → highlight shows
			.mockImplementationOnce(
				() =>
					new Promise((r) => {
						resolveProbe = r;
					})
			) // tick 2: held open across the re-snapshot
			.mockResolvedValue({ x: 0, y: 0, shift: false });
		const view = render(<DragSnapLayer />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		// Drag 1 snapshots zone z1; its first tick arms z1, the second blocks on the deferred probe.
		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(66);
		});
		expect(view.container.querySelector('.zone-drag-highlight')).toBeTruthy();
		expect(resolveProbe).toBeTruthy();

		// The layout is replaced (only zone now z2) and a new drag re-snapshots the refs.
		layoutJson = OTHER_ZONE_LAYOUT;
		await act(async () => {
			handlers['layout_changed']?.({ payload: {} });
			await vi.advanceTimersByTimeAsync(0);
		});
		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 8 } });
		});

		// The stale probe (armed inside z1, absent from the new local map) resolves → highlight null.
		await act(async () => {
			resolveProbe?.({ x: 480, y: 540, shift: true });
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(view.container.querySelector('.zone-drag-highlight')).toBeNull();

		await act(async () => {
			handlers['win_drag_end']?.({
				payload: { hwnd: 8, pointer: { x: 480, y: 540, shift: true } }
			});
			await Promise.resolve();
		});
		expect(snapWindow).not.toHaveBeenCalled();
	});

	it('ignores a drag-end event for a different window', async () => {
		vi.useFakeTimers();
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true });
		const view = render(<DragSnapLayer />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 8 } });
		});
		await act(async () => {
			await vi.advanceTimersToNextTimerAsync();
		});
		await act(async () => {
			await handlers['win_drag_end']?.({
				payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
			});
		});
		expect(snapWindow).not.toHaveBeenCalled();
		expect(view.container.querySelector('.zone-drag-highlight')).toBeTruthy();
		await act(async () => {
			await handlers['win_drag_end']?.({
				payload: { hwnd: 8, pointer: { x: 480, y: 540, shift: true } }
			});
		});
		expect(snapWindow).toHaveBeenCalledWith(8, { x: 0, y: 0, w: 960, h: 1080 });
	});

	it('does not restore a highlight after a drag ends with its probe still pending', async () => {
		vi.useFakeTimers();
		let resolveProbe!: (value: { x: number; y: number; shift: boolean }) => void;
		pointerProbe.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveProbe = resolve;
				})
		);
		const view = render(<DragSnapLayer />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
		});
		await act(async () => {
			await vi.advanceTimersToNextTimerAsync();
		});
		await act(async () => {
			await handlers['win_drag_end']?.({
				payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
			});
		});
		await act(async () => {
			resolveProbe({ x: 480, y: 540, shift: true });
			await Promise.resolve();
		});
		expect(view.container.querySelector('.zone-drag-highlight')).toBeNull();
		expect(snapWindow).toHaveBeenCalledWith(7, { x: 0, y: 0, w: 960, h: 1080 });
	});

	it('unmounting before currentMonitor() resolves cancels the setup (alive guard)', async () => {
		pointerProbe.mockResolvedValue({ x: 480, y: 540, shift: true });
		const view = render(<DragSnapLayer />);
		// A setState-after-unmount (the guard failing to bail) surfaces as a React act warning on
		// console.error; test-setup.ts doesn't fail on it, so assert it explicitly.
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		view.unmount(); // tear down before currentMonitor()/loadLayoutRaw() resolve
		// Let the in-flight currentMonitor()/loadLayoutRaw() promises settle against the dead instance;
		// the `!alive` guard must bail without throwing or writing state.
		await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
		expect(errorSpy).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it('unmounting mid-reload cancels it (reload alive guard)', async () => {
		// Mount normally so the layout_changed listener is registered.
		const view = render(<DragSnapLayer />);
		await settle();

		// Fire layout_changed (starts reload(), which suspends at `await loadLayoutRaw()`), then unmount
		// synchronously in the same act() before the awaited continuation runs. When reload resumes its
		// `!alive` guard must bail without writing zone refs or throwing. A failed bail would setState on
		// the dead instance → a React act warning on console.error (test-setup.ts doesn't fail on it).
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		await act(async () => {
			handlers['layout_changed']?.({ payload: {} });
			view.unmount();
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(errorSpy).not.toHaveBeenCalled(); // reload's `!alive` branch returned cleanly
		errorSpy.mockRestore();
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

		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 9 } });
		});
		await pollOnce();
		await act(async () => {
			handlers['win_drag_end']?.({
				payload: { hwnd: 9, pointer: { x: 480, y: 540, shift: true } }
			});
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

		await act(async () => {
			await handlers['win_drag_start']?.({ payload: { hwnd: 7 } });
		});
		// Let many poll intervals fire while probes are slow.
		await act(async () => void (await new Promise((r) => setTimeout(r, 250))));
		await act(async () => {
			await handlers['win_drag_end']?.({
				payload: { hwnd: 7, pointer: { x: 480, y: 540, shift: true } }
			}); // stops the interval
		});

		expect(pointerProbe).toHaveBeenCalled(); // probing happened
		expect(maxInFlight).toBe(1); // the busy guard prevented any overlap

		// Drain the last in-flight probe (60ms) so nothing leaks past this test.
		await act(async () => void (await new Promise((r) => setTimeout(r, 80))));
		expect(inFlight).toBe(0);
	});
});
