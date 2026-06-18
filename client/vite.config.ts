import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
	plugins: [react()],
	// Dedicated, fixed dev port so the Tauri studio always loads THIS app. `strictPort` makes
	// a clash fail loudly instead of silently moving to 5174 and letting Tauri (which points
	// at the fixed devUrl) load whatever else holds the default port. Keep in sync with
	// `devUrl` in widgetsack/tauri.conf.json.
	server: {
		port: 1420,
		strictPort: true
	},
	// Tauri embeds `client/build` (frontendDist). Plain Vite defaults to `dist/`, so pin the
	// output back to `build/` or the desktop bundle finds no frontend.
	build: {
		outDir: 'build',
		emptyOutDir: true
	},
	// CodeMirror (the studio's CSS editor) throws "Unrecognized extension value … multiple instances
	// of @codemirror/state" if more than one copy of that package loads — its extensions use
	// `instanceof` against the single state package. node_modules already dedupes to one version, but
	// Vite's dev pre-bundler can still split it across optimized chunks, so pin a single instance both
	// ways: dedupe the resolved module, and pre-bundle the whole CodeMirror set together.
	resolve: {
		dedupe: ['@codemirror/state', '@codemirror/view']
	},
	optimizeDeps: {
		include: [
			'@codemirror/state',
			'@codemirror/view',
			'@codemirror/language',
			'@codemirror/commands',
			'@codemirror/autocomplete',
			'@codemirror/lint',
			'@codemirror/lang-css'
		]
	},
	test: {
		environment: 'happy-dom',
		globals: true,
		setupFiles: ['./src/test-setup.ts'],
		include: ['src/**/*.{test,spec}.{js,ts,jsx,tsx}'],
		coverage: {
			provider: 'v8',
			all: true,
			reporter: ['text', 'json-summary', 'text-summary'],
			include: ['src/**/*.{ts,tsx}'],
			// Principled exclusions: code that unit tests can't cover usefully. Bootstrap + dev-only
			// mocks; the Canvas organism + studio interactions are covered by the Playwright e2e suite
			// (test:e2e), not happy-dom; and the thin Tauri IO adapters (invoke/listen/emit + window
			// manipulation) are integration glue, not unit logic. Everything else is held to 100%.
			exclude: [
				'src/**/*.{test,spec}.{ts,tsx}',
				'src/test-setup.ts',
				'src/**/*.d.ts',
				// bootstrap / dev-only
				'src/main.tsx',
				'src/App.tsx',
				'src/lib/devMock.ts',
				// e2e-driven (Playwright)
				'src/lib/widgets/Canvas.tsx',
				// DOM-measurement glue: reads getBoundingClientRect off every [data-id] + reacts to
				// Resize/MutationObserver (happy-dom returns zero rects). Its pure seam screenRectToLayout
				// is unit-tested in core/measureMath.test.ts; the rest is runtime/e2e only.
				'src/lib/widgets/canvas/useMeasuredRects.ts',
				// canvas-2D / FFT-stream draw glue: the substance is imperative draw() on a 2D context
				// happy-dom doesn't provide (getContext returns null, client sizes are 0). The pure geometry
				// is unit-tested in cpuCoresMath / sparklineMath / spectrumMath.test.ts; acquire/release is
				// in Spectrum.test.ts. Same class as audio/**.
				'src/lib/widgets/meters/CpuCoresCanvas.tsx',
				'src/lib/widgets/meters/Spectrum.tsx',
				// Tauri IO adapters (invoke/listen/emit + window/monitor manipulation)
				'src/lib/overlay.ts',
				'src/lib/diag.ts',
				'src/lib/utils/**',
				'src/lib/audio/**',
				'src/lib/windows/**',
				'src/lib/ddc/**',
				'src/lib/telemetry/**',
				'src/lib/components/NowPlaying/source.ts',
				'src/lib/components/NowPlaying/np-source.ts',
				'src/lib/widgets/plugins/*-source.ts',
				'src/lib/widgets/plugins/*-commands.ts',
				'src/mcp/server.ts'
			],
			thresholds: { 100: true }
		}
	}
});
