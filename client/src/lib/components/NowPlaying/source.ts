// Wire the GSMTC media feed (the Rust `session_update`/`session_delete` events + the initial
// snapshot) into the `mediaStore`, so the `nowplaying` widget can render the active session.
// Idempotent: safe to call from every nowplaying widget instance — the listeners attach once.

import { invoke } from '@tauri-apps/api/core';
import * as tauriEvent from '@tauri-apps/api/event';
import {
	handleInitialize,
	handleUpdate,
	handleDelete,
	type SessionRecord
} from '../../../stores/stores';
import { COMMANDS, EVENTS } from '../../bridge/contract';

// Which transport controls the active session supports (mirrors the Rust `MediaCaps` struct in
// widgetsack/src/media.rs — keep both sides in sync, AGENTS.md §5). The widget hides buttons a
// player doesn't expose.
export type MediaCaps = {
	play: boolean;
	pause: boolean;
	playpause: boolean;
	stop: boolean;
	next: boolean;
	previous: boolean;
	shuffle: boolean;
	repeat: boolean;
	seek: boolean;
};

/** Ask the backend which controls the matched (or current) session supports. Returns null when the
 * query can't run (non-Windows, no backend in tests) so the caller shows every button by default. */
export function getMediaCapabilities(source?: string | null): Promise<MediaCaps | null> {
	return invoke<MediaCaps | null>(COMMANDS.mediaCapabilities, { source: source ?? null }).catch(
		() => null
	);
}

/** Send a transport action (play/pause/next/seek/…) to the backend's media controller. `source`
 * targets a specific session (null = the active one); `value` carries a seek position. Rejects on
 * invoke failure so a macro run can record the failed step. */
export function mediaControl(
	action: string,
	source: string | null,
	value: number | null
): Promise<void> {
	return invoke(COMMANDS.mediaControl, { action, source, value });
}

type MediaDelta = { kind: 'update' | 'delete'; record: SessionRecord };

let startPromise: Promise<void> | null = null;

function applyDelta(delta: MediaDelta): void {
	if (delta.kind === 'delete') handleDelete({ sessionRecord: delta.record });
	else handleUpdate({ sessionRecord: delta.record });
}

async function attachMediaSource(): Promise<void> {
	// Subscribe before asking for the snapshot. Deltas arriving while invoke is in flight are queued,
	// then replayed after initialization, so an update/delete can never be overwritten by an older
	// snapshot. Session-create is an upsert just like session-update on the frontend.
	let live = false;
	const queued: MediaDelta[] = [];
	const receive = (delta: MediaDelta): void => {
		if (live) applyDelta(delta);
		else queued.push(delta);
	};
	const listeners = await Promise.allSettled([
		tauriEvent.listen<SessionRecord>(EVENTS.sessionCreate, (ev) =>
			receive({ kind: 'update', record: ev.payload })
		),
		tauriEvent.listen<SessionRecord>(EVENTS.sessionUpdate, (ev) =>
			receive({ kind: 'update', record: ev.payload })
		),
		tauriEvent.listen<SessionRecord>(EVENTS.sessionDelete, (ev) =>
			receive({ kind: 'delete', record: ev.payload })
		)
	]);
	const failed = listeners.find((result) => result.status === 'rejected');
	if (failed?.status === 'rejected') {
		for (const result of listeners) if (result.status === 'fulfilled') result.value();
		throw failed.reason;
	}

	try {
		const initial = await invoke<{ sessions: Record<number, SessionRecord> }>(
			COMMANDS.getInitialSessions,
			{ message: '' }
		);
		handleInitialize({ sessions: initial.sessions });
	} catch (error) {
		// The live listeners are still useful when the initial snapshot is unavailable.
		console.warn('Could not load the initial media sessions', error);
	}
	for (const delta of queued) applyDelta(delta);
	live = true;
}

/** Start the per-webview media feed once. A listener-attachment failure resets the singleton so a
 * later widget/settings mount can retry; an initial-snapshot failure keeps the live feed running. */
export function startMediaSource(): Promise<void> {
	if (startPromise) return startPromise;
	startPromise = attachMediaSource().catch((error) => {
		startPromise = null;
		console.warn('Could not start the media event source', error);
	});
	return startPromise;
}
