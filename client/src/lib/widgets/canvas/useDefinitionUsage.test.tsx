import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { emptyMonitorLayout, container, group, leaf } from '../../core/layoutTree';
import { packLayout } from '../../core/savedLayout';
import { useDefinitionUsage } from './useDefinitionUsage';
import { loadLayoutRaw, listLayouts, readLayout } from '../../bridge/layouts';
vi.mock('../../bridge/layouts', () => ({
	loadLayoutRaw: vi.fn(),
	listLayouts: vi.fn(),
	readLayout: vi.fn()
}));
const mon = () => ({
	root: container('root', 'col', [
		leaf(group('one', { w: 40, h: 40 }, container('empty', 'col', []), { def: 'def' }))
	]),
	floating: []
});
beforeEach(() => {
	vi.mocked(loadLayoutRaw).mockResolvedValue(
		JSON.stringify({ version: 2, monitors: { main: emptyMonitorLayout(), other: mon() } })
	);
	vi.mocked(listLayouts).mockResolvedValue(['Desk']);
	vi.mocked(readLayout).mockResolvedValue(JSON.stringify(packLayout(mon())));
});
it('uses the live desktop instead of its saved snapshot and counts other monitors and saved layouts', async () => {
	const view = renderHook(() => useDefinitionUsage('def', 'main', mon(), undefined, []));
	await waitFor(() => expect(view.result.current.label).toBe('Used in 3 layouts · 3 placements'));
	expect(view.result.current.locations).toEqual([
		{ key: 'main', count: 1 },
		{ key: 'other', count: 1 },
		{ key: 'Saved: Desk', count: 1 }
	]);
});
it('reports incomplete sources, supports refreshing and ignores a stale read after switching targets', async () => {
	let finish!: (value: string | null) => void;
	vi.mocked(loadLayoutRaw).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	const view = renderHook(({ id }) => useDefinitionUsage(id, 'main', mon(), undefined, []), {
		initialProps: { id: 'old' as string | null }
	});
	view.rerender({ id: 'def' });
	await waitFor(() => expect(view.result.current.label).toContain('3 layouts'));
	await act(async () => finish(null));
	expect(view.result.current.label).toContain('3 layouts');
	vi.mocked(loadLayoutRaw).mockRejectedValueOnce(Error('offline'));
	act(() => view.result.current.refresh());
	await waitFor(() => expect(view.result.current.label).toContain('Usage partly unavailable'));
	view.rerender({ id: null });
	expect(view.result.current.label).toBe('');
});
it('handles absent/corrupt documents, failed profile reads and pending moves without hiding known usage', async () => {
	vi.mocked(loadLayoutRaw).mockResolvedValueOnce('broken').mockResolvedValueOnce(null);
	vi.mocked(readLayout).mockResolvedValue(null);
	const view = renderHook(() =>
		useDefinitionUsage('def', 'main', emptyMonitorLayout(), undefined, [
			{ key: 'next', leaf: mon().root.children[0] as ReturnType<typeof leaf> }
		])
	);
	await waitFor(() => expect(view.result.current.label).toContain('Usage partly unavailable'));
	expect(view.result.current.locations).toEqual([{ key: 'next', count: 1 }]);
	vi.mocked(listLayouts).mockRejectedValueOnce(Error('offline'));
	act(() => view.result.current.refresh());
	await waitFor(() => expect(view.result.current.loading).toBe(false));
	view.unmount();
});

it('continues counting known locations after a profile read fails or yields invalid content', async () => {
	vi.mocked(listLayouts).mockResolvedValue(['broken', 'unreadable']);
	vi.mocked(readLayout)
		.mockResolvedValueOnce('broken')
		.mockRejectedValueOnce(Error('permission denied'));
	const view = renderHook(() => useDefinitionUsage('def', 'main', mon(), undefined, []));
	await waitFor(() => expect(view.result.current.loading).toBe(false));
	expect(view.result.current.label).toContain('Usage partly unavailable');
	expect(view.result.current.locations.map((location) => location.key)).toEqual(['main', 'other']);
});
it('deduplicates queued placements already present in a saved destination and retains other placements', async () => {
	const target = mon();
	const placed = target.root.children[0] as ReturnType<typeof leaf>;
	vi.mocked(loadLayoutRaw).mockResolvedValue(
		JSON.stringify({
			version: 2,
			monitors: {
				other: {
					...target,
					root: container('root', 'col', []),
					floating: [placed, { ...placed, id: 'keep', unit: { ...placed.unit, id: 'keep' } }]
				}
			}
		})
	);
	vi.mocked(listLayouts).mockResolvedValue([]);
	const view = renderHook(() =>
		useDefinitionUsage('def', 'main', emptyMonitorLayout(), undefined, [
			{ key: 'other', leaf: placed }
		])
	);
	await waitFor(() => expect(view.result.current.loading).toBe(false));
	expect(view.result.current.locations).toEqual([{ key: 'other', count: 2 }]);
});
