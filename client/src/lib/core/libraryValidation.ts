import type { Library } from './layoutTree';
import { safeGroupReferences } from './groupReferences';

import { record, optionalText, style, size, validTree } from './treeValidation';
export { stringMap } from './treeValidation';

function param(value: unknown): boolean {
	if (
		!record(value) ||
		typeof value.key !== 'string' ||
		!optionalText(value.label) ||
		!optionalText(value.target)
	)
		return false;
	if (
		value.targets !== undefined &&
		(!Array.isArray(value.targets) || !value.targets.every((target) => typeof target === 'string'))
	)
		return false;
	return (
		value.choices === undefined ||
		(Array.isArray(value.choices) &&
			value.choices.every(
				(choice) =>
					record(choice) && typeof choice.value === 'string' && typeof choice.label === 'string'
			))
	);
}

/** Validate reusable definitions before their trees reach scanners, rendering, or persistence. */
export function validLibrary(value: unknown): value is Library {
	if (!record(value) || value.version !== 1 || !Array.isArray(value.defs)) return false;
	const ids = new Set<string>();
	const valid = value.defs.every((def) => {
		if (
			!(
				record(def) &&
				typeof def.id === 'string' &&
				typeof def.name === 'string' &&
				size(def.size) &&
				style(def) &&
				validTree(def.child) &&
				(def.params === undefined || (Array.isArray(def.params) && def.params.every(param)))
			)
		)
			return false;
		if (ids.has(def.id)) return false;
		ids.add(def.id);
		return true;
	});
	if (!valid) return false;
	const library = value as unknown as Library;
	return library.defs.every((def) => safeGroupReferences(def.child, library, [def.id]));
}
