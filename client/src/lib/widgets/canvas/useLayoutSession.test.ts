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
const adoptTheme = vi.fn(async () => undefined);
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
		let old!: Promise<void>;
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
