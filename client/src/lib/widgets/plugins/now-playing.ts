// The Now Playing plugin: the GSMTC media widget, a media->hub data source, and a settings panel,
// registered as a first-class plugin (like Home Assistant). The widget renders the active track; the
// `npSource` bridges the media feed (mediaStore) into the telemetry hub so the track's values are
// also bindable as `np.*` sensors by other widgets. Calling `registerNowPlayingPlugin()` (via
// plugins/index.ts) registers the `nowplaying` widget type + the source + the settings panel + the
// `media` control-action handler. The default LOOK ships as the instance's editable css
// (NOWPLAYING_DEFAULT_CSS, kept in core/widget so layout templates can seed it too).

import { registerPlugin } from '../plugin';
import { NOWPLAYING_DEFAULT_CSS } from '../../core/widget';
import NowPlayingHost from '../NowPlayingHost';
import NowPlayingSettings from './NowPlayingSettings';
import { npSource } from '../../components/NowPlaying/np-source';
import { mediaControl } from '../../components/NowPlaying/source';
import { asMeter } from '../registry';

export const registerNowPlayingPlugin = (): void =>
	registerPlugin({
		id: 'now-playing',
		name: 'Now Playing',
		description: 'Currently-playing media (Windows GSMTC) with a source-priority + ignore list.',
		// The `media` control domain: transport bangs (play/pause/next/seek/…) from the widget's
		// buttons and button macros go to the backend media controller via the command adapter.
		actions: [
			{
				domain: 'media',
				dispatch: ({ service, data }) =>
					mediaControl(service, (data?.source as string) ?? null, (data?.value as number) ?? null)
			}
		],
		widgets: [
			{
				meta: {
					// No bound sensor (binds:none): the NowPlayingHost container subscribes to the GSMTC media
					// feed and passes the active session to the pure NowPlaying meter as props.
					type: 'nowplaying',
					binds: 'none',
					label: 'Now Playing',
					defaultSize: { w: 160, h: 200 },
					defaultConfig: {},
					defaultCss: NOWPLAYING_DEFAULT_CSS,
					// Catches clicks in passive mode so the transport buttons work (un-hide them via css).
					interactive: true,
					configFields: [
						{
							key: 'label',
							label: 'label (when idle)',
							kind: 'text',
							group: 'Data',
							help: 'text shown while nothing is playing'
						}
					]
				},
				component: asMeter(NowPlayingHost)
			}
		],
		sources: [npSource],
		settings: NowPlayingSettings
	});
