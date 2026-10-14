import type { Container } from './layoutTree';
/** Explicit grid dimensions are bounded; automatic rows still fit every authored child. */
export const MAX_GRID_TRACKS = 64;
export function validGridTrackCount(value: unknown): value is number {
	return (
		typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_GRID_TRACKS
	);
}
export function normalizeGridTrackCount(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.max(1, Math.min(MAX_GRID_TRACKS, Math.floor(value)))
		: 1;
}
export function gridDimensions(grid: Pick<Container, 'cols' | 'rows' | 'children'>) {
	const cols = normalizeGridTrackCount(grid.cols);
	return {
		cols,
		rows: Math.max(normalizeGridTrackCount(grid.rows), Math.ceil(grid.children.length / cols))
	};
}
