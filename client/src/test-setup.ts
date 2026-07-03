import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// happy-dom (bumped to v20) no longer implements the window dialog methods that browsers and the
// previous test env provided. Define no-op defaults so component code that calls them doesn't throw
// and tests can `vi.spyOn(window, 'prompt' | 'confirm' | 'alert')` (spyOn needs the property to exist).
window.prompt ??= () => null;
window.confirm ??= () => false;
window.alert ??= () => {};

// Unmount React trees + reset jsdom between tests (RTL doesn't auto-cleanup with globals).
afterEach(() => cleanup());
