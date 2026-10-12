// Studio screenshot capture. Unlike the widget gallery (which renders WidgetHosts directly), this
// boots the REAL app in its studio role under the Tauri dev mock — so the README's studio shot shows
// exactly the shipping editor: the two-tier action bar, the left nav + Outline, the stage with the
// built-in demo layout, and the Inspector. A demo SensorSource seeds Canvas's own telemetry hub so
// the seeded gauges/bars/sparklines render live-looking values, and the clock is frozen for a
// deterministic capture. Shot by scripts/screenshots.mjs → docs/img/studio.png. Dev/docs only.
import { createRoot } from 'react-dom/client';
import { installDevMock } from '../src/lib/devMock';
import { registerSource } from '../src/lib/core/plugin';
import { freezeClock, seedHub, seedMedia } from './seed';
import { studioShotLayout } from './studioLayout';
import App from '../src/App';
import '../src/styles.css';

// Forces the studio role + serves the showcase layout for load_layout (a full monitor's worth of
// widgets — the null fallback left the stage nearly empty). Install before the app boots.
installDevMock({ layout: studioShotLayout() });
localStorage.setItem('widgetsack.studio.firstRunDismissed', '1');
freezeClock();
// Seed one playing session so the now-playing card shows a real track + cover (async; lands well
// before the capture's settle waits).
void seedMedia();

// useStudioInit calls startAllSources(hub) on mount → this source's start(hub) runs and fills the hub
// with the same deterministic snapshot the gallery uses (the live `system` source has no backend here).
registerSource({
	id: 'demo-shot',
	start: async (hub) => {
		seedHub(hub);
		return () => undefined;
	}
});

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(<App />);
	// "Ready to shoot" after a couple of painted frames (layout solved, meters filled).
	requestAnimationFrame(() =>
		requestAnimationFrame(() => document.body.setAttribute('data-ready', 'true'))
	);
}
