// Structural validation shared by imports and parameter updates. No library resolution.
export const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
export const optionalText = (value: unknown): boolean =>
	value === undefined || typeof value === 'string';
const finite = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);
export const stringMap = (value: unknown): boolean =>
	record(value) && Object.values(value).every((entry) => typeof entry === 'string');
export const style = (value: Record<string, unknown>): boolean =>
	optionalText(value.css) && (value.tokens === undefined || stringMap(value.tokens));
export const size = (value: unknown): boolean =>
	record(value) && finite(value.w) && finite(value.h);

export function validTree(value: unknown, depth = 0): boolean {
	if (depth > 64 || !record(value) || typeof value.id !== 'string') return false;
	if (value.kind === 'row' || value.kind === 'col' || value.kind === 'grid') {
		return (
			Array.isArray(value.children) && value.children.every((child) => validTree(child, depth + 1))
		);
	}
	const unit = value.unit;
	if (!record(unit) || typeof unit.id !== 'string' || !style(unit)) return false;
	if (unit.kind === 'group') {
		return size(unit.size) && optionalText(unit.def) && validTree(unit.child, depth + 1);
	}
	return (
		typeof unit.type === 'string' &&
		optionalText(unit.sensor) &&
		record(unit.config) &&
		record(unit.rect) &&
		finite(unit.rect.x) &&
		finite(unit.rect.y) &&
		size(unit.rect)
	);
}
