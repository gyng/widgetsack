import { createRoot } from 'react-dom/client';
import './styles.css';
import '@fontsource-variable/ibm-plex-sans/wght.css';
import App from './App';

// NOTE: deliberately NOT wrapped in <React.StrictMode>. The Canvas init runs non-idempotent Tauri
// side-effects (window sizing, overlay reconcile, listen() registration, source startup) and
// StrictMode double-invokes effects in dev, which would double-spawn overlays/listeners. Re-enable
// once every effect is proven cleanup-correct (see the migration notes).
// In dev, when running in a PLAIN browser (no Tauri runtime — e.g. `npm run dev` opened for Playwright
// verification), install the Tauri mock so the studio boots without a backend. No-op inside the real
// WebView (which has __TAURI_INTERNALS__) and stripped from production builds.
async function boot() {
	if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
		const { installDevMock } = await import('./lib/devMock');
		installDevMock();
	}
	const root = document.getElementById('root');
	if (root) createRoot(root).render(<App />);
}
void boot();
