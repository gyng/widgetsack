// useSavedLayouts owns the layouts/ file I/O AROUND the pure pack/unpack core, but it has real
// branch logic worth pinning: the mid-def-edit guards, the overwrite-confirm, the name trim/empty
// guard, the save-failure alert, and the load confirm → single commit (which clears selection). We
// mock the overlay adapter + window prompts, keep the real packLayout/unpackLayout, and assert the
// observable effects (what got written, what the commit patch was, which alert fired).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSavedLayouts } from './useSavedLayouts';
import { container, leaf, type MonitorLayout } from '../../core/layoutTree';
import { createWidget } from '../../core/widget';
import { packLayout } from '../../core/savedLayout';
import type { EditorState } from './types';

const listLayouts = vi.fn<[], Promise<string[]>>();
const readLayout = vi.fn<[string], Promise<string | null>>();
const saveLayoutAs = vi.fn<[string, string], Promise<string | null>>();
const deleteLayout = vi.fn<[string], Promise<boolean>>();
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
	navSection?: 'saved-layouts' | 'widgets';
	editingDefId?: string | null;
	monitor?: MonitorLayout;
};
function setup(opts: Opts = {}) {
	const commitOp = vi.fn<[(s: EditorState) => Partial<EditorState>], void>();
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

beforeEach(() => {
	vi.restoreAllMocks();
	listLayouts.mockReset().mockResolvedValue([]);
	readLayout.mockReset().mockResolvedValue(null);
	saveLayoutAs.mockReset().mockResolvedValue('C:/cfg/layouts/x.json');
	deleteLayout.mockReset().mockResolvedValue(true);
});

describe('section load', () => {
	it('loads the layout names when the Saved-layouts section is open', async () => {
		listLayouts.mockResolvedValue(['Home', 'Work']);
		const { result } = setup({ navSection: 'saved-layouts' });
		await waitFor(() => expect(result.current.layoutNames).toEqual(['Home', 'Work']));
	});

	it('does NOT load names while a different section is open', async () => {
		setup({ navSection: 'widgets' });
		expect(listLayouts).not.toHaveBeenCalled();
	});
});

describe('saveCurrentLayout', () => {
	it('refuses (alerts) while editing a def', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		const { result } = setup({ editingDefId: 'd1' });
		await act(async () => {
			await result.current.saveCurrentLayout();
		});
		expect(alert).toHaveBeenCalledWith(expect.stringContaining('Finish editing'));
		expect(saveLayoutAs).not.toHaveBeenCalled();
	});

	it('aborts when the name prompt is cancelled or blank', async () => {
		vi.spyOn(window, 'prompt').mockReturnValue('   '); // trims to empty
		const { result } = setup();
		await act(async () => {
			await result.current.saveCurrentLayout();
		});
		expect(saveLayoutAs).not.toHaveBeenCalled();
	});

	it('packs the live monitor (from the ref) under the typed name and refreshes', async () => {
		vi.spyOn(window, 'prompt').mockReturnValue('Gaming');
		const mon = monitorWith('live');
		// 'widgets' section → no mount auto-load; the pre-check sees no existing 'Gaming' (skip the
		// overwrite confirm), then the post-save refresh returns the new name.
		listLayouts.mockResolvedValueOnce([]).mockResolvedValueOnce(['Gaming']);
		const { result } = setup({ monitor: mon, navSection: 'widgets' });
		await act(async () => {
			await result.current.saveCurrentLayout();
		});
		expect(saveLayoutAs).toHaveBeenCalledTimes(1);
		const [name, json] = saveLayoutAs.mock.calls[0];
		expect(name).toBe('Gaming');
		expect(JSON.parse(json)).toEqual(packLayout(mon, 'Gaming'));
		await waitFor(() => expect(result.current.layoutNames).toEqual(['Gaming']));
	});

	it('confirms before overwriting an existing name; declining aborts the write', async () => {
		vi.spyOn(window, 'prompt').mockReturnValue('Home');
		vi.spyOn(window, 'confirm').mockReturnValue(false);
		listLayouts.mockResolvedValue(['Home']);
		const { result } = setup();
		await act(async () => {
			await result.current.saveCurrentLayout();
		});
		expect(saveLayoutAs).not.toHaveBeenCalled();
	});

	it('proceeds past the overwrite confirm when accepted', async () => {
		vi.spyOn(window, 'prompt').mockReturnValue('Home');
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		listLayouts.mockResolvedValue(['Home']);
		const { result } = setup();
		await act(async () => {
			await result.current.saveCurrentLayout();
		});
		expect(saveLayoutAs).toHaveBeenCalledWith('Home', expect.any(String));
	});

	it('alerts on a rejected save (saveLayoutAs returned null)', async () => {
		vi.spyOn(window, 'prompt').mockReturnValue('Bad/Name');
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		saveLayoutAs.mockResolvedValue(null);
		const { result } = setup();
		await act(async () => {
			await result.current.saveCurrentLayout();
		});
		expect(alert).toHaveBeenCalledWith(expect.stringContaining('Could not save'));
	});
});

describe('loadSavedLayout', () => {
	it('refuses (alerts) while editing a def', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		const { result, commitOp } = setup({ editingDefId: 'd1' });
		await act(async () => {
			await result.current.loadSavedLayout('Home');
		});
		expect(alert).toHaveBeenCalledWith(expect.stringContaining('Finish editing'));
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('alerts and bails when the slot is unreadable', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		readLayout.mockResolvedValue('not json');
		const { result, commitOp } = setup();
		await act(async () => {
			await result.current.loadSavedLayout('Home');
		});
		expect(alert).toHaveBeenCalledWith(expect.stringContaining('Could not read'));
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('alerts and bails when the slot read returns null (missing file)', async () => {
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		readLayout.mockResolvedValue(null);
		const { result, commitOp } = setup();
		await act(async () => {
			await result.current.loadSavedLayout('Gone');
		});
		expect(alert).toHaveBeenCalledWith(expect.stringContaining('Could not read'));
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('asks to confirm the replace; declining does not commit', async () => {
		readLayout.mockResolvedValue(JSON.stringify(packLayout(monitorWith('saved'), 'Home')));
		vi.spyOn(window, 'confirm').mockReturnValue(false);
		const { result, commitOp } = setup();
		await act(async () => {
			await result.current.loadSavedLayout('Home');
		});
		expect(commitOp).not.toHaveBeenCalled();
	});

	it('commits the loaded monitor + clears the selection on confirm', async () => {
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
	});
});

describe('deleteSavedLayout', () => {
	it('confirms first; declining skips the delete', async () => {
		vi.spyOn(window, 'confirm').mockReturnValue(false);
		const { result } = setup();
		await act(async () => {
			await result.current.deleteSavedLayout('Home');
		});
		expect(deleteLayout).not.toHaveBeenCalled();
	});

	it('deletes + refreshes the list on confirm', async () => {
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		listLayouts.mockResolvedValue(['Work']); // post-delete list
		const { result } = setup({ navSection: 'widgets' }); // avoid the section-open auto-load
		await act(async () => {
			await result.current.deleteSavedLayout('Home');
		});
		expect(deleteLayout).toHaveBeenCalledWith('Home');
		await waitFor(() => expect(result.current.layoutNames).toEqual(['Work']));
	});
});
