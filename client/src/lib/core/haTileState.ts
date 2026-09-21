// Pure "what should an HA tile say instead of its value?" seam. A Home Assistant tile can be in
// several non-data states that all used to render as a bare "—": the plugin was never set up (the
// backend reported `unconfigured`), this window hasn't heard the connection state yet (no
// `ha.status` sample — a late-mounted window before its primed status lands, or boot before the
// first `connecting`), the connection is down (connecting / disconnected / error), the entity
// itself is `unavailable` in HA, or we're connected but the entity hasn't been delivered yet. Data
// in → a kind + user-facing message out; the HA meters render it in place of their value.
// Framework-agnostic (AGENTS.md §5). The `status` string is the `ha.status` bridge contract from
// ha.rs::emit_status (unconfigured | connecting | connected | disconnected | error) — keep the
// cases in sync with core/haStatus.ts.

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
 *   and no status sample has arrived in this window yet (NOT evidence of anything — the tile
 *   waits), else the raw status string. Only an explicit `unconfigured` sends the user to the
 *   Plugins panel.
 * @param sample the tile's entity JSON (`{ state, attributes }`) or null when absent.
 */
export function haTileState(status: string | null | undefined, sample: unknown): HaTileState {
	if (status === undefined) return { kind: 'ok' };
	if (status === null || status === '')
		return { kind: 'waiting', message: 'Waiting for Home Assistant…' };
	if (status === 'unconfigured') return { kind: 'unconfigured', message: HA_UNCONFIGURED_MESSAGE };
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
