import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// happy-dom (bumped to v20) no longer implements the window dialog methods that browsers and the
// previous test env provided. Define no-op defaults so component code that calls them doesn't throw
// and tests can `vi.spyOn(window, 'prompt' | 'confirm' | 'alert')` (spyOn needs the property to exist).
window.prompt ??= () => null;
window.confirm ??= () => false;
window.alert ??= () => {};

// Vitest's happy-dom adapter does not expose Storage on every supported Node runtime (notably Node
// 26). Real webviews do; use a faithful in-memory seam only when the environment omitted it.
const memoryStorage = (): Storage => {
	const values = new Map<string, string>();
	return {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => values.delete(key),
		setItem: (key, value) => values.set(key, String(value))
	};
};
globalThis.localStorage ??= window.localStorage ?? memoryStorage();
globalThis.sessionStorage ??= window.sessionStorage ?? memoryStorage();

// Iframes are DOM attributes in unit tests, not network integrations. Disable happy-dom child-frame
// navigation globally so every iframe test stays offline and teardown has no aborted-fetch noise.
const happy = (
	window as unknown as {
		happyDOM?: { settings?: { navigation?: { disableChildFrameNavigation?: boolean } } };
	}
).happyDOM;
if (happy?.settings?.navigation) happy.settings.navigation.disableChildFrameNavigation = true;

// Unmount React trees + reset jsdom between tests (RTL doesn't auto-cleanup with globals).
afterEach(() => cleanup());
