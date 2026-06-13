// Error-isolated registration of the built-in plugins. Canvas calls `registerBuiltinPlugins()`
// once (idempotent — Canvas remounts on role switches) instead of side-effect-importing each
// module: a plugin whose registration throws is recorded here and surfaced in the studio's
// Plugins list as a "failed to load" row, rather than taking the whole Canvas down with it.

import { registerHomeAssistantPlugin } from './home-assistant';
import { registerNowPlayingPlugin } from './now-playing';
import { registerMqttPlugin } from './mqtt';
import { registerStocksPlugin } from './stocks';
import { registerWeatherPlugin } from './weather';
import { registerRssPlugin } from './rss';
import { registerAgendaPlugin } from './agenda';
import { registerLlmPlugin } from './llm';

export type PluginLoadError = { id: string; name: string; error: string };

// id/name duplicated from each plugin's registerPlugin call on purpose: when registration
// throws, the plugin object never materializes, so this table is all the list row has.
const BUILTINS: { id: string; name: string; register: () => void }[] = [
	{ id: 'home-assistant', name: 'Home Assistant', register: registerHomeAssistantPlugin },
	{ id: 'now-playing', name: 'Now Playing', register: registerNowPlayingPlugin },
	{ id: 'mqtt', name: 'MQTT', register: registerMqttPlugin },
	{ id: 'stocks', name: 'Stocks', register: registerStocksPlugin },
	{ id: 'weather', name: 'Weather', register: registerWeatherPlugin },
	{ id: 'rss', name: 'RSS', register: registerRssPlugin },
	{ id: 'agenda', name: 'Agenda', register: registerAgendaPlugin },
	{ id: 'ai-provider', name: 'AI Provider', register: registerLlmPlugin }
];

let registered = false;
const errors: PluginLoadError[] = [];

export function registerBuiltinPlugins(): void {
	if (registered) return;
	registered = true;
	for (const b of BUILTINS) {
		try {
			b.register();
		} catch (err) {
			console.error(`plugin "${b.id}" failed to register`, err);
			errors.push({
				id: b.id,
				name: b.name,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}
}

/** Registration failures recorded by registerBuiltinPlugins, for the Plugins-list rows. */
export function pluginLoadErrors(): PluginLoadError[] {
	return errors.slice();
}
