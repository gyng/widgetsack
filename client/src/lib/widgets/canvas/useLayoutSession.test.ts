import { act, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEditorModel } from './useEditorModel';
import { useLayoutSession } from './useLayoutSession';
import { container } from '../../core/layoutTree';
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('../../overlay', () => ({
	logClient: vi.fn(),
	onStudioCloseRequested: vi.fn(async () => () => undefined),
	mainWindowExists: vi.fn(async () => true),
	reconcileOverlays: vi.fn(),
	recreateMain: vi.fn()
}));
const adoptTheme = vi.fn(async (): Promise<void> => undefined);
const applyTheme = vi.fn(async () => undefined);
const setMyMonitor = vi.fn();
const onMonitorSwitch = vi.fn();
const document = (key: string, id: string) =>
	JSON.stringify({
		version: 2,
		monitors: { [key]: { root: container(id, 'row', []), floating: [] } }
	});
function useSession(key: string) {
	const model = useEditorModel(true, []);
	const theme = useRef('');
	const session = useLayoutSession({
		state: model.state,
		dispatch: model.dispatch,
		myMonitor: key,
		setMyMonitor,
		stateThemeRef: theme,
		adoptTheme,
		applyTheme,
		onMonitorSwitch
	});
	return { ...session, state: model.state, commitOp: model.commitOp };
}
afterEach(() => {
	vi.resetAllMocks();
});

describe('layout session', () => {
	it('does not apply a completed Save baseline to a reloaded session on the same monitor', async () => {
		invoke.mockResolvedValue(document('a', 'old'));
		const { result } = renderHook(() => useSession('a'));
		await act(async () => {
			await result.current.reloadLayout();
		});
		let release!: () => void;
		invoke.mockImplementation((command: string) =>
			command === 'save_layout'
				? new Promise<void>((resolve) => {
						release = resolve;
					})
				: Promise.resolve(document('a', 'reloaded'))
		);
		let saving!: Promise<boolean>;
		await act(async () => {
			saving = result.current.commitSave();
		});
		await act(async () => {
			await result.current.reloadLayout();
		});
		await act(async () => {
			release();
			await saving;
		});
		expect(result.current.state.savedBaseline?.monitor.root.id).toBe('reloaded');
		expect(result.current.dirty).toBe(false);
	});

	it.each(['save', 'close'] as const)(
		'anchors %s to the written snapshot when editing continues during the write',
		async (action) => {
			invoke.mockResolvedValue(document('a', 'loaded'));
			const { result } = renderHook(() => useSession('a'));
			await act(async () => {
				await result.current.reloadLayout();
			});
			act(() =>
				result.current.commitOp(() => ({
					monitor: { root: container('saved', 'row', []), floating: [] }
				}))
			);
			let release!: () => void;
			invoke.mockImplementation((command: string) =>
				command === 'load_layout'
					? Promise.resolve(document('a', 'loaded'))
					: new Promise<void>((resolve) => {
							release = resolve;
						})
			);
			let saving!: Promise<boolean>;
			await act(async () => {
				saving = action === 'save' ? result.current.commitSave() : result.current.prepareClose();
			});
			act(() =>
				result.current.commitOp(() => ({
					monitor: { root: container('newer', 'row', []), floating: [] }
				}))
			);
			await act(async () => {
				release();
				expect(await saving).toBe(action === 'save');
			});
			expect(result.current.state.savedBaseline?.monitor.root.id).toBe('saved');
			expect(result.current.state.monitor.root.id).toBe('newer');
			expect(result.current.dirty).toBe(true);
			invoke.mockResolvedValue(null);
			await act(async () => {
				await result.current.flushPreviewWrite();
			});
		}
	);
	it('preserves edits and Undo made while a loaded theme is still resolving', async () => {
		invoke.mockResolvedValue(document('a', 'old'));
		const { result } = renderHook(() => useSession('a'));
		await act(async () => {
			await result.current.reloadLayout();
		});
		invoke.mockResolvedValue(
			JSON.stringify({
				version: 2,
				theme: 'slow-theme',
				monitors: { a: { root: container('loaded', 'row', []), floating: [] } }
			})
		);
		let release!: () => void;
		adoptTheme.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		let loading!: Promise<boolean>;
		await act(async () => {
			loading = result.current.reloadLayout();
		});
		act(() =>
			result.current.commitOp(() => ({
				monitor: { root: container('edited', 'row', []), floating: [] }
			}))
		);
		await act(async () => {
			release();
			await loading;
		});
		await act(async () => {
			await result.current.flushPreviewWrite();
		});
		expect(result.current.state.monitor.root.id).toBe('edited');
		expect(result.current.state.savedBaseline?.monitor.root.id).toBe('loaded');
		expect(result.current.dirty).toBe(true);
		expect(result.current.state.undoStack).toHaveLength(1);
	});

	it('loads a document and anchors a clean baseline', async () => {
		invoke.mockResolvedValue(document('a', 'loaded'));
		const { result } = renderHook(() => useSession('a'));
		await act(async () => {
			await result.current.reloadLayout();
		});
		expect(result.current.state.monitor.root.id).toBe('loaded');
		expect(result.current.state.savedBaseline?.monitor).toBe(result.current.state.monitor);
		expect(result.current.dirty).toBe(false);
	});
	it('does not apply an older monitor load after a newer session has loaded', async () => {
		let resolve!: (raw: string) => void;
		invoke.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				})
		);
		invoke.mockResolvedValue(document('b', 'new'));
		const { result, rerender } = renderHook(({ key }) => useSession(key), {
			initialProps: { key: 'a' }
		});
		let old!: Promise<boolean>;
		act(() => {
			old = result.current.reloadLayout();
		});
		rerender({ key: 'b' });
		await act(async () => {
			await result.current.reloadLayout();
		});
		await act(async () => {
			resolve(document('a', 'stale'));
			await old;
		});
		expect(result.current.state.monitor.root.id).toBe('new');
		expect(result.current.state.savedBaseline?.monitor.root.id).toBe('new');
	});
});

it('clears removed global settings when reloading a smaller document', async () => {
	invoke.mockResolvedValue(
		JSON.stringify({
			...JSON.parse(document('a', 'loaded')),
			theme: 'dark',
			themeLock: false,
			tokens: { accent: 'red' },
			library: { version: 1, defs: [] }
		})
	);
	const { result } = renderHook(() => useSession('a'));
	await act(async () => {
		await result.current.reloadLayout();
	});
	expect(result.current.state.selectedTheme).toBe('dark');
	expect(result.current.state.library).toBeDefined();
	invoke.mockResolvedValue(document('a', 'replaced'));
	await act(async () => {
		await result.current.reloadLayout();
	});
	expect(result.current.state).toMatchObject({
		selectedTheme: '',
		globalTheme: '',
		themeLock: true,
		tokenOverrides: {}
	});
	expect(result.current.state.library).toBeUndefined();
	expect(result.current.dirty).toBe(false);
});

it('keeps unsaved edits and the saved baseline when reloading fails', async () => {
	invoke.mockResolvedValue(document('a', 'saved'));
	const { result } = renderHook(() => useSession('a'));
	await act(async () => {
		await result.current.reloadLayout();
	});
	act(() =>
		result.current.commitOp(() => ({
			monitor: { root: container('edited', 'row', []), floating: [] }
		}))
	);
	const baseline = result.current.state.savedBaseline;
	const history = result.current.state.undoStack;
	invoke.mockRejectedValue(new Error('file temporarily locked'));
	await act(async () => {
		await result.current.reloadLayout();
	});
	expect(result.current.state.savedBaseline).toBe(baseline);
	expect(result.current.state.undoStack).toBe(history);
	expect(result.current.state.historyReady).toBe(true);
	expect(result.current.state.monitor.root.id).toBe('edited');
	expect(result.current.dirty).toBe(true);
	invoke.mockResolvedValue(document('a', 'saved'));
	await act(async () => {
		await result.current.flushPreviewWrite();
	});
});

describe('switching monitors', () => {
	it('stays on the current monitor when the new one cannot be loaded', async () => {
		invoke.mockResolvedValue(document('a', 'kept'));
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		const { result } = renderHook(() => useSession('a'));
		await act(async () => {
			await result.current.reloadLayout();
		});
		invoke.mockImplementation(async (command: string) => {
			if (command === 'load_layout') throw new Error('file temporarily locked');
			return undefined;
		});
		await act(async () => {
			await result.current.switchMonitor('b');
		});
		// The placeholder empty tree must not stay under either key: the next write would replace
		// a monitor's saved layout with it.
		expect(result.current.state.monitor.root.id).toBe('kept');
		expect(setMyMonitor).toHaveBeenLastCalledWith('a');
		expect(alert).toHaveBeenCalled();
	});
});

describe('layout changed on disk', () => {
	it('writes nothing over the external change until the user keeps their edits', async () => {
		invoke.mockImplementation(async (command: string) =>
			command === 'load_layout' ? document('a', 'saved') : undefined
		);
		const { result } = renderHook(() => useSession('a'));
		await act(async () => {
			await result.current.reloadLayout();
		});
		const edit = (id: string) =>
			act(() =>
				result.current.commitOp(() => ({
					monitor: { root: container(id, 'row', []), floating: [] }
				}))
			);
		const saves = () => invoke.mock.calls.filter(([command]) => command === 'save_layout').length;
		edit('first'); // its preview write is still debouncing when the external change lands
		act(() => result.current.onForeignLayoutChangeRef.current());
		expect(result.current.externalChange).toBe(true);
		edit('second');
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
		});
		expect(saves()).toBe(0);
		act(() => result.current.keepMine());
		await act(async () => {
			await result.current.flushPreviewWrite();
		});
		expect(saves()).toBe(1);
	});

	it.each([
		{ answers: [true], saves: 1, closes: true },
		{ answers: [false, true], saves: 0, closes: true },
		{ answers: [false, false], saves: 0, closes: false }
	])(
		'asks before a close overwrites the external change (answers $answers)',
		async ({ answers, saves, closes }) => {
			invoke.mockImplementation(async (command: string) =>
				command === 'load_layout' ? document('a', 'saved') : undefined
			);
			const confirm = vi.spyOn(window, 'confirm');
			for (const answer of answers) confirm.mockReturnValueOnce(answer);
			const { result } = renderHook(() => useSession('a'));
			await act(async () => {
				await result.current.reloadLayout();
			});
			act(() =>
				result.current.commitOp(() => ({
					monitor: { root: container('mine', 'row', []), floating: [] }
				}))
			);
			act(() => result.current.onForeignLayoutChangeRef.current());
			let closed!: boolean;
			await act(async () => {
				closed = await result.current.prepareClose();
			});
			expect(confirm).toHaveBeenCalledTimes(answers.length);
			expect(closed).toBe(closes);
			expect(invoke.mock.calls.filter(([command]) => command === 'save_layout')).toHaveLength(
				saves
			);
			confirm.mockRestore();
		}
	);
});
