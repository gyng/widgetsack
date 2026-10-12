// Persist dismissal of the studio hint beside the monitor selector.
import { readString, writeString } from '../../../stores/persist';

const KEY = 'widgetsack.studio.firstRunDismissed';

/** True until the hint has been dismissed on this machine (or storage is unavailable → show). */
export function isFirstRun(): boolean {
	return readString(KEY) !== '1';
}

export function dismissFirstRun(): void {
	writeString(KEY, '1');
}
