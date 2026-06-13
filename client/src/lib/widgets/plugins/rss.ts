// The RSS plugin: a server-side feed poller (widgetsack/src/rss.rs), a settings panel (feed URL +
// count), and a self-sourcing RSS widget. Calling `registerRssPlugin()` (via plugins/index.ts)
// registers the source + the settings panel + the `rss` widget type.

import { registerPlugin } from '../plugin';
import { rssSource } from './rss-source';
import RssSettings from './RssSettings';
import Rss from '../meters/Rss';
import { asMeter } from '../registry';

export const registerRssPlugin = (): void =>
	registerPlugin({
		id: 'rss',
		name: 'RSS',
		description:
			'Headlines from any public RSS / Atom feed. Set the feed URL in this panel, then drop an RSS widget.',
		sources: [rssSource],
		settings: RssSettings,
		statusSensor: 'rss.status',
		widgets: [
			{
				meta: {
					// Self-sourcing (binds:'none'): reads the rss.list JSON sensor from the hub (which
					// demand-gates the backend poll), like the Connections widget.
					type: 'rss',
					binds: 'none',
					label: 'RSS',
					description: 'A list of headlines from your configured RSS / Atom feed.',
					defaultSize: { w: 260, h: 150 },
					defaultConfig: { title: '', maxRows: 8 },
					configFields: [
						{ key: 'title', label: 'header', kind: 'text', help: 'optional title above the list' },
						{
							key: 'maxRows',
							label: 'headlines',
							kind: 'number',
							min: 1,
							max: 30,
							step: 1,
							help: 'how many headlines to show'
						},
						{ key: 'color', label: 'accent', kind: 'color' }
					]
				},
				component: asMeter(Rss)
			}
		]
	});
