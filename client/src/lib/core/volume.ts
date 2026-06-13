// Pure helpers for the Volume widget. No React/DOM — unit-tested. The backend (widgetsack/src/audio.rs)
// exposes the system master level (scalar 0..1) + mute; this turns them into a percentage and an icon.

/** Master level (0..1, null before first read) as a clamped 0..100 percentage. */
export function volumePercent(level: number | null): number {
	if (level == null) return 0;
	return Math.round(Math.max(0, Math.min(1, level)) * 100);
}

/** A speaker glyph for the level + mute state: muted / silent → 🔇, then low / mid / high. */
export function volumeIcon(level: number | null, muted: boolean): string {
	if (muted || level == null || level <= 0) return '🔇';
	if (level < 0.34) return '🔈';
	if (level < 0.67) return '🔉';
	return '🔊';
}
