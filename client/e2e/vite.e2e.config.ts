import { mergeConfig } from 'vite';
import base from '../vite.config';

// The e2e server is the app's Vite config plus two test-stability changes:
// - File watching (and so HMR / full reloads) is OFF. With the watcher on, any source edit made while
//   the suite runs — an editor save, a formatter, another agent — hot-swaps modules or reloads EVERY
//   open test page mid-test: state resets (selection, added widgets), effects re-run, and mixed
//   old/new module versions throw. A test run should exercise one consistent snapshot of the source.
// - The calendar worker's module graph is pre-transformed at server start. Nothing in the page warm-up
//   (global-setup.ts) loads it, and cold, its first job measured ~4.7 s under load — against the app's
//   own 5 s worker timeout. (The page graphs are warmed by global-setup.ts instead of a broad warmup
//   glob here: transforming the whole app eagerly competed with the first tests' requests.)
export default mergeConfig(base, {
	server: {
		watch: null,
		hmr: false,
		warmup: { clientFiles: ['./src/lib/calendar/worker.ts'] }
	}
});
