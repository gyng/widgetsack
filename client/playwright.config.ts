import { defineConfig, devices } from '@playwright/test';

// End-to-end layout checks against the SPA served by Vite with the dev Tauri mock (src/lib/devMock.ts)
// installed — a REAL browser (so a real layout engine, unlike happy-dom) drives the studio with a
// stubbed backend. This covers the layout/interaction surface the vitest unit tests structurally can't
// (geometry, flexbox, drag). No Tauri runtime → no live sensors/persistence; those need the native app.
//
// One dev server PER RUN, on its own port. With a fixed port + reuseExistingServer, a second concurrent
// `test:e2e` (another terminal, another agent) silently attached to the first run's server — and lost it
// mid-run when the first run finished and shut it down. Pick the port once in the runner; the workers
// inherit it through the environment (they re-evaluate this file). Set E2E_PORT to pin/reuse a server.
process.env.E2E_PORT ||= String(20000 + Math.floor(Math.random() * 10000));
const PORT = Number(process.env.E2E_PORT);

export default defineConfig({
	testDir: './e2e',
	globalSetup: './e2e/global-setup.ts', // warms the dev server's transform cache (see the file)
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	// Cap parallelism: spawning one headless Chromium per core at once is flaky on Windows
	// ("browserType.launch: spawn UNKNOWN" under the launch storm). CI runs E2E in its own job on a
	// 4-vCPU Linux runner, leaving one core for the Vite server.
	workers: process.env.CI ? 3 : 4,
	reporter: 'list',
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		// retain-on-failure (not on-first-retry) so the FIRST failure — incl. CI runs with retries:0 —
		// still leaves a trace/screenshot/video to debug from.
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure'
	},
	// A realistic desktop studio height: the default Desktop Chrome 720px is shorter than the studio's
	// tall context menus render to on Linux/CI fonts, which pushed bottom items (e.g. "Into 2×2 grid")
	// off-screen and timed the click out. 960px gives menus room; the .ctx max-height is the backstop.
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 960 } }
		}
	],
	webServer: {
		// e2e/vite.e2e.config.ts = the app config with the file watcher/HMR off (see the file for why).
		command: `npx vite --config e2e/vite.e2e.config.ts --port ${PORT} --host 127.0.0.1`,
		url: `http://127.0.0.1:${PORT}`,
		reuseExistingServer: !process.env.CI,
		timeout: 60_000
	}
});
