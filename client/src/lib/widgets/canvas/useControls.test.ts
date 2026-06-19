import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Mock the outer-ring disk IO (overlay loadControls/saveControls). The pure validator
// (core/controls parseControlOverrides) stays REAL so we verify load → parse → state, and that
// mutations both update state AND persist the `{ version, overrides }` envelope.
const loadControls = vi.fn();
const saveControls = vi.fn();
vi.mock('../../overlay', () => ({
	loadControls: () => loadControls(),
	saveControls: (s: string) => saveControls(s)
}));

import { useControls } from './useControls';
import type { ControlOverride } from '../../core/controls';

beforeEach(() => {
	loadControls.mockResolvedValue(null);
});
afterEach(() => vi.clearAllMocks());

const remap: ControlOverride = { triggers: [{ type: 'key', key: 'j', ctrl: true }] };

describe('useControls', () => {
	it('starts empty', () => {
		const { result } = renderHook(() => useControls());
		expect(result.current.overrides).toEqual({});
		expect(result.current.overridesRef.current).toEqual({});
	});

	it('reloadControls loads + validates the on-disk envelope into state', async () => {
		const onDisk = { triggers: [{ type: 'key', key: 'z', ctrl: true }] };
		loadControls.mockResolvedValue(JSON.stringify({ version: 1, overrides: { undo: onDisk } }));
		const { result } = renderHook(() => useControls());
		await act(async () => {
			await result.current.reloadControls();
		});
		expect(result.current.overrides).toEqual({ undo: onDisk });
		expect(result.current.overridesRef.current).toEqual({ undo: onDisk });
	});

	it('reloadControls falls back to defaults (empty) for a null file', async () => {
		loadControls.mockResolvedValue(null);
		const { result } = renderHook(() => useControls());
		await act(async () => {
			await result.current.reloadControls();
		});
		expect(result.current.overrides).toEqual({});
	});

	it('reloadControls falls back to defaults for a corrupt (unparseable) file', async () => {
		loadControls.mockResolvedValue('{ not json');
		const { result } = renderHook(() => useControls());
		await act(async () => {
			await result.current.reloadControls();
		});
		expect(result.current.overrides).toEqual({}); // degraded safely, no throw
	});

	it('setOverride updates state and persists the versioned envelope', async () => {
		const { result } = renderHook(() => useControls());
		act(() => result.current.setOverride('redo', remap));
		expect(result.current.overrides).toEqual({ redo: remap });
		expect(result.current.overridesRef.current).toEqual({ redo: remap });
		expect(JSON.parse(saveControls.mock.calls[0]![0])).toEqual({
			version: 1,
			overrides: { redo: remap }
		});
	});

	it('resetOverride removes a single binding and persists the rest', () => {
		const { result } = renderHook(() => useControls());
		const disabled: ControlOverride = { disabled: true };
		act(() => result.current.setOverride('redo', remap));
		act(() => result.current.setOverride('undo', disabled));
		act(() => result.current.resetOverride('redo'));
		expect(result.current.overrides).toEqual({ undo: disabled });
		expect(JSON.parse(saveControls.mock.calls.at(-1)![0]).overrides).toEqual({ undo: disabled });
	});

	it('resetAll clears every override and persists an empty map', () => {
		const { result } = renderHook(() => useControls());
		act(() => result.current.setOverride('redo', remap));
		act(() => result.current.resetAll());
		expect(result.current.overrides).toEqual({});
		expect(JSON.parse(saveControls.mock.calls.at(-1)![0]).overrides).toEqual({});
	});
});
