import { beforeEach, describe, expect, it } from 'vitest';
import { dismissFirstRun, isFirstRun } from './firstRun';

describe('first-run strip flag', () => {
	beforeEach(() => localStorage.clear());

	it('is a first run until dismissed, then never again', () => {
		expect(isFirstRun()).toBe(true);
		dismissFirstRun();
		expect(isFirstRun()).toBe(false);
	});
});
