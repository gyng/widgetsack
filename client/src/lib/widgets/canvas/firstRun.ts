// First-boot onboarding flag for the studio: the dismissible 3-step strip above the stage shows
// until the user closes it once (persisted to localStorage, so it never comes back on a reload).
// Pure read/write, unit-tested; the Canvas owns the strip itself.

import { readString, writeString } from '../../../stores/persist';

const KEY = 'widgetsack.studio.firstRunDismissed';

/** True until the strip has been dismissed on this machine (or storage is unavailable → show). */
export function isFirstRun(): boolean {
	return readString(KEY) !== '1';
}

export function dismissFirstRun(): void {
	writeString(KEY, '1');
}
