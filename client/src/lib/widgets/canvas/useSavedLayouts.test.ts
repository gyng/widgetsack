// useSavedLayouts owns the layouts/ file I/O AROUND the pure pack/unpack core, but it has real
// branch logic worth pinning: the mid-def-edit guards, the overwrite-confirm, the name trim/empty
// guard, the save-failure status, and the load confirm → single commit (which clears selection).
// The name comes from the Presets panel's inline field (never prompt()); every outcome lands in
// `status` for the panel to render (never alert()). We mock the overlay adapter + window.confirm,
// keep the real packLayout/unpackLayout, and assert the observable effects (what got written, what
// the commit patch was, which status line resulted).
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSavedLayouts } from './useSavedLayouts';
import { container, leaf, type MonitorLayout } from '../../core/layoutTree';
import { createWidget } from '../../core/widget';
import { packLayout } from '../../core/savedLayout';
import type { EditorState } from './types';

const listLayouts = vi.fn<() => Promise<string[]>>();
const readLayout = vi.fn<(name: string) => Promise<string | null>>();
const saveLayoutAs = vi.fn<(name: string, json: string) => Promise<string | null>>();
const deleteLayout = vi.fn<(name: string) => Promise<boolean>>();
vi.mock('../../overlay', () => ({
	listLayouts: (...a: []) => listLayouts(...a),
	readLayout: (...a: [string]) => readLayout(...a),
	saveLayoutAs: (...a: [string, string]) => saveLayoutAs(...a),
	deleteLayout: (...a: [string]) => deleteLayout(...a)
}));

function monitorWith(id = 'w1'): MonitorLayout {
	return { root: container('root', 'col', [leaf(createWidget('text', id))]), floating: [] };
}

// The hook only reads `monitorRef` + the four scalar deps; build a minimal harness.
type Opts = {
	navSection?: 'saved-layouts' | 'settings';
	editingDefId?: string | null;
	monitor?: MonitorLayout;
};
function setup(opts: Opts = {}) {
	const commitOp = vi.fn<(run: (s: EditorState) => Partial<EditorState>) => void>();
	const monitorRef = { current: opts.monitor ?? monitorWith() } as React.RefObject<MonitorLayout>;
	const hook = renderHook(() =>
		useSavedLayouts({
			studio: true,
			navSection: opts.navSection ?? 'saved-layouts',
			editingDefId: opts.editingDefId ?? null,
			monitorRef,
			commitOp
		})
	);
	return { ...hook, commitOp, monitorRef };
}

let promptSpy: ReturnType<typeof vi.spyOn>;
let alertSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	vi.restoreAllMocks();
	promptSpy = vi.spyOn(window, 'prompt').mockImplementation(() => null);
	alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
	listLayouts.mockReset().mockResolvedValue([]);
	readLayout.mockReset().mockResolvedValue(null);
	saveLayoutAs.mockReset().mockResolvedValue('C:/cfg/layouts/x.json');
	deleteLayout.mockReset().mockResolvedValue(true);
});
afterEach(() => {
	// No native dialog but confirm() may ever fire from this hook.
	expect(promptSpy).not.toHaveBeenCalled();
	expect(alertSpy).not.toHaveBeenCalled();
});

describe('section load', () => {
	it('loads the layout names when the Saved-layouts section is open', async () => {
		listLayouts.mockResolvedValue(['Home', 'Work']);
		const { result } = setup({ navSection: 'saved-layouts' });
		await waitFor(() => expect(result.current.layoutNames).toEqual(['Home', 'Work']));
	});

	it('does NOT load names while a different section is open', async () => {
		setup({ navSection: 'settings' });
		expect(listLayouts).not.toHaveBeenCalled();
	});
});

describe('saveCurrentLayout', () => {
	it('refuses (status error) while editing a custom widget', async () => {
		const { result } = setup({ editingDefId: 'd1' });
		await act(async () => {
			await result.current.saveCurrentLayout('Gaming');
		});
		expect(result.current.status).toEqual({
			kind: 'error',
			message: expect.stringContaining('Finish editing')
		});
		expect(saveLayoutAs).not.toHaveBeenCalled();
	});

	it('asks for a name when the field is blank', async () => {
		const { result } = setup();
		await act(async () => {
			await result.current.saveCurrentLayout('   '); // trims to empty
		});
		expect(saveLayoutAs).not.toHaveBeenCalled();
		expect(result.current.status).toEqual({
			kind: 'error',
			message: 'Enter a name for the preset.'
		});
	});

	it('packs the live monitor (from the ref) under the trimmed name, refreshes, and says so', async () => {
		const mon = monitorWith('live');
		// 'settings' section → no mount auto-load; the pre-check sees no existing 'Gaming' (skip the
		// overwrite confirm), then the post-save refresh returns the new name.
		listLayouts.mockResolvedValueOnce([]).mockResolvedValueOnce(['Gaming']);
		const { result } = setup({ monitor: mon, navSection: 'settings' });
		await act(async () => {
			await result.current.saveCurrentLayout('  Gaming ');
		});
		expect(saveLayoutAs).toHaveBeenCalledTimes(1);
		const [name, json] = saveLayoutAs.mock.calls[0];
		expect(name).toBe('Gaming');
		expect(JSON.parse(json)).toEqual(packLayout(mon, 'Gaming'));
		await waitFor(() => expect(result.current.layoutNames).toEqual(['Gaming']));
		expect(result.current.status).toEqual({
			kind: 'ok',
			message: 'Saved preset Gaming · 1 preset'
		});
	});

	it('confirms before overwriting an existing name; declining aborts the write', async () => {
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
		listLayouts.mockResolvedValue(['Home']);
		const { result } = setup();
		await act(async () => {
			await result.current.saveCurrentLayout('Home');
		});
		expect(confirm).toHaveBeenCalledWith('Overwrite the preset “Home”?');
		expect(saveLayoutAs).not.toHaveBeenCalled();
	});

	it('proceeds past the overwrite confirm when accepted (plural count in the status)', async () => {
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		listLayouts.mockResolvedValue(['Home', 'Work']);
		const { result } = setup();
		await act(async () => {
			await result.current.saveCurrentLayout('Home');
		});
		expect(saveLayoutAs).toHaveBeenCalledWith('Home', expect.any(String));
		expect(result.current.status).toEqual({ kind: 'ok', message: 'Saved preset Home · 2 presets' });
	});

	it('reports a rejected save (saveLayoutAs returned null) in the status', async () => {
		saveLayoutAs.mockResolvedValue(null);
		const { result } = setup();
		await act(async () => {
			await result.current.saveCurrentLayout('Bad/Name');
		});
		expect(result.current.status).toEqual({
			kind: 'error',
			message: expect.stringContaining('Could not save')
		});
	});
});

describe('loadSavedLayout', () => {
	it('refuses (status error) while editing a custom widget', async () => {
		const { result, commitOp } = setup({ editingDefId: 'd1' });
		await act(async () => {
			await result.current.loadSavedLayout('Home');
		});
		expect(result.current.status).toEqual({
			kind: 'error',
			message: expect.stringContaining('Finish editing')
		});
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('reports and bails when the slot is unreadable', async () => {
		readLayout.mockResolvedValue('not json');
		const { result, commitOp } = setup();
		await act(async () => {
			await result.current.loadSavedLayout('Home');
		});
		expect(result.current.status).toEqual({
			kind: 'error',
			message: 'Could not read the preset “Home”.'
		});
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('reports and bails when the slot read returns null (missing file)', async () => {
		readLayout.mockResolvedValue(null);
		const { result, commitOp } = setup();
		await act(async () => {
			await result.current.loadSavedLayout('Gone');
		});
		expect(result.current.status?.kind).toBe('error');
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('asks to confirm the replace; declining does not commit', async () => {
		readLayout.mockResolvedValue(JSON.stringify(packLayout(monitorWith('saved'), 'Home')));
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
		const { result, commitOp } = setup();
		await act(async () => {
			await result.current.loadSavedLayout('Home');
		});
		expect(confirm.mock.calls[0][0]).toMatch(
			/Replace this monitor’s layout with the preset “Home”/
		);
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('commits the loaded monitor + clears the selection on confirm, and says how to undo', async () => {
		const saved = monitorWith('saved');
		readLayout.mockResolvedValue(JSON.stringify(packLayout(saved, 'Home')));
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		const { result, commitOp } = setup();
		await act(async () => {
			await result.current.loadSavedLayout('Home');
		});
		expect(commitOp).toHaveBeenCalledTimes(1);
		// The op patch replaces the monitor and clears selection (the old ids are gone).
		const patch = commitOp.mock.calls[0][0]({} as EditorState);
		expect((patch.monitor as MonitorLayout).root.children.map((c) => c.id)).toEqual(['saved']);
		expect(patch.selectedId).toBeNull();
		expect(patch.selectedIds).toEqual([]);
		expect(result.current.status).toEqual({
			kind: 'ok',
			message: 'Loaded preset Home — Ctrl+Z restores the previous layout.'
		});
	});
});

describe('deleteSavedLayout', () => {
	it('confirms first; declining skips the delete', async () => {
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
		const { result } = setup();
		await act(async () => {
			await result.current.deleteSavedLayout('Home');
		});
		expect(confirm).toHaveBeenCalledWith('Delete the preset “Home”?');
		expect(deleteLayout).not.toHaveBeenCalled();
	});

	it('deletes + refreshes the list on confirm, with the remaining count in the status', async () => {
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		listLayouts.mockResolvedValue(['Work']); // post-delete list
		const { result } = setup({ navSection: 'settings' }); // avoid the section-open auto-load
		await act(async () => {
			await result.current.deleteSavedLayout('Home');
		});
		expect(deleteLayout).toHaveBeenCalledWith('Home');
		await waitFor(() => expect(result.current.layoutNames).toEqual(['Work']));
		expect(result.current.status).toEqual({
			kind: 'ok',
			message: 'Deleted preset Home · 1 preset'
		});
		// The last one gone → the plural form.
		listLayouts.mockResolvedValue([]);
		await act(async () => {
			await result.current.deleteSavedLayout('Work');
		});
		expect(result.current.status?.message).toBe('Deleted preset Work · 0 presets');
	});
});
