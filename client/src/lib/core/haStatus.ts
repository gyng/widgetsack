// Pure mapping from the `ha.status` telemetry string (emitted by ha.rs::emit_status as
// unconfigured | connecting | connected | disconnected | error) to a display badge. Framework-agnostic domain
// (AGENTS.md §5): no React/Tauri — just data in, data out — so it is unit-tested directly and the
// settings panel stays a thin container. The string is a bridge contract; keep the cases in sync
// with ha.rs's emit_status calls.

export type HaStatusTone = 'ok' | 'busy' | 'warn' | 'idle';

export type HaStatusBadge = { label: string; tone: HaStatusTone };

export function haStatusBadge(raw: string | null | undefined): HaStatusBadge {
	switch (raw) {
		case 'connected':
			return { label: 'Connected', tone: 'ok' };
		case 'connecting':
			return { label: 'Connecting…', tone: 'busy' };
		case 'error':
			return { label: 'Error', tone: 'warn' };
		case 'disconnected':
			return { label: 'Disconnected', tone: 'idle' };
		case 'unconfigured':
			return { label: 'Not configured', tone: 'idle' };
		default:
			return { label: 'Not connected', tone: 'idle' };
	}
}
