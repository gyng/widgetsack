import { beforeEach, describe, expect, it, vi } from 'vitest';

// startMediaSource()/getMediaCapabilities()/mediaControl() call Tauri (no runtime in tests) — stub
// the module. mediaControl is a spy so the `media` control-action handler can be asserted.
vi.mock('../../components/NowPlaying/source', () => ({
	startMediaSource: () => undefined,
	getMediaCapabilities: () => Promise.resolve(null),
	mediaControl: vi.fn(() => Promise.resolve())
}));
vi.mock('../../overlay', () => ({ copyToClipboard: () => Promise.resolve(true) }));

import { registerNowPlayingPlugin } from './now-playing';
import { mediaControl } from '../../components/NowPlaying/source';
import { listPlugins } from '../plugin';
import { sourceCatalogIds } from '../../core/plugin';
import { configCompleteness, createWidget, getMeta } from '../../core/widget';

// Registers the plugin + the nowplaying widget meta + the np source (was an import side-effect).
registerNowPlayingPlugin();

const nowPlaying = () => {
	const p = listPlugins().find((x) => x.id === 'now-playing');
	if (!p) throw new Error('now-playing plugin not registered');
	return p;
};

beforeEach(() => vi.clearAllMocks());

describe('now-playing plugin', () => {
	it('registers as a plugin with a settings panel + a media source', () => {
		const p = listPlugins().find((x) => x.id === 'now-playing');
		expect(p).toMatchObject({ id: 'now-playing', name: 'Now Playing' });
		expect(p?.settings).toBeTruthy();
		expect(p?.sources?.some((s) => s.id === 'now-playing')).toBe(true);
	});

	it('registers the nowplaying widget meta (its look ships as editable css)', () => {
		expect(getMeta('nowplaying')?.binds).toBe('none');
		const w = createWidget('nowplaying', 'np1');
		expect(w.css).toContain('.np-title');
		// fully UI-driven config (no key reachable only via raw JSON).
		const meta = getMeta('nowplaying');
		if (!meta) throw new Error('nowplaying meta not registered');
		expect(configCompleteness(meta)).toEqual([]);
	});

	it('exposes the now-playing values as bindable np.* sensors via the source catalog', () => {
		expect(sourceCatalogIds()).toEqual(
			expect.arrayContaining(['np.title', 'np.artist', 'np.progress', 'np.status'])
		);
	});

	describe('the media control-action handler', () => {
		const dispatch = () => {
			const a = nowPlaying().actions?.find((x) => x.domain === 'media');
			if (!a) throw new Error('no media action handler');
			return a.dispatch;
		};

		it('routes a transport bang to the backend media controller with source + value', () => {
			dispatch()({ domain: 'media', service: 'seek', data: { source: 'spotify', value: 42 } });
			expect(mediaControl).toHaveBeenCalledWith('seek', 'spotify', 42);
		});

		it('defaults missing source/value to null', () => {
			dispatch()({ domain: 'media', service: 'next' });
			expect(mediaControl).toHaveBeenCalledWith('next', null, null);
		});
	});
});
