// Pure "what should an HA tile say instead of its value?" seam. A Home Assistant tile can be in
// four non-data states that all used to render as a bare "—": the plugin was never set up (no
// `ha.status` sample has ever arrived), the connection is down (connecting / disconnected /
// error), the entity itself is `unavailable` in HA, or we're connected but the entity hasn't been
// delivered yet. Data in → a kind + user-facing message out; the HA meters render it in place of
// their value. Framework-agnostic (AGENTS.md §5). The `status` string is the `ha.status` bridge
// contract from ha.rs::emit_status — keep the cases in sync with core/haStatus.ts.

export type HaTileState =
	| { kind: 'ok' }
	| { kind: 'unconfigured'; message: string }
	| { kind: 'offline'; message: string }
	| { kind: 'unavailable'; message: string }
	| { kind: 'waiting'; message: string };

export const HA_UNCONFIGURED_MESSAGE = 'Not configured — set up in Plugins → Home Assistant';

type HaSample = { state?: unknown } | null | undefined;

/**
 * @param status the current `ha.status` text sample: `undefined` when the host supplied none
 *   (a standalone render — the tile shows whatever value it has), `null` when the host looked
 *   and no status sample exists (the plugin is not configured), else the raw status string.
 * @param sample the tile's entity JSON (`{ state, attributes }`) or null when absent.
 */
export function haTileState(status: string | null | undefined, sample: unknown): HaTileState {
	if (status === undefined) return { kind: 'ok' };
	if (status === null || status === '')
		return { kind: 'unconfigured', message: HA_UNCONFIGURED_MESSAGE };
	if (status !== 'connected') {
		return {
			kind: 'offline',
			message: status === 'connecting' ? 'Connecting to Home Assistant…' : 'Home Assistant offline'
		};
	}
	const s = (sample ?? null) as HaSample;
	if (!s) return { kind: 'waiting', message: 'Waiting for the entity…' };
	if (s.state === 'unavailable') return { kind: 'unavailable', message: 'Entity unavailable' };
	return { kind: 'ok' };
}
