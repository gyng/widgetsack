import type { LayoutNode, ParamSpec } from './layoutTree';
import { isSafePath } from './safePath';
import { validTree } from './treeValidation';
import { sanitizeImportedTree } from './treeThreats';

/** Write `params` onto a (cloned) child tree following each spec's dotted path(s) — `targets`
 * (several nodes driven by one value), else `target`, else the default 'unit.config.<key>'.
 * Exported so the template system applies insert-time options through the SAME mechanism. */
export function applyParams(
	child: LayoutNode,
	specs: ParamSpec[] | undefined,
	params: Record<string, unknown>
): LayoutNode {
	if (!specs) return child;
	for (const spec of specs) {
		if (!Object.hasOwn(params, spec.key)) continue;
		const targets = spec.targets ?? [spec.target ?? 'unit.config.' + spec.key];
		for (const target of targets) {
			// Select controls carry strings; boolean defaults preserve the config's boolean type.
			const value =
				typeof spec.default === 'boolean'
					? params[spec.key] === true || params[spec.key] === 'true'
					: params[spec.key];
			setPath(child as unknown as Record<string, unknown>, target, value);
		}
	}
	return specs.some((spec) => spec.imported) ? sanitizeImportedTree(child).value : child;
}

// Fail-closed dotted-path setter: writes the final segment only if every intermediate
// already exists as an OWN object property. So a default target 'unit.config.<key>' resolves on a
// Leaf-rooted child (unit + config exist) but is a NO-OP on a container-rooted child
// (no `unit`) — never auto-vivifying a bogus `unit` object onto a container. Specs come from
// untrusted data (sack defs, package templates), so a path that names `__proto__` /
// `constructor` / `prototype` anywhere is refused outright (prototype pollution), and only OWN
// properties are descended into (an inherited `constructor` etc. is never walked).
function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
	if (!isSafePath(path)) return;
	const parts = path.split('.');
	let cur: Record<string, unknown> = root;
	for (let i = 0; i < parts.length - 1; i++) {
		if (!Object.hasOwn(cur, parts[i])) return;
		const next = cur[parts[i]];
		if (typeof next !== 'object' || next === null) return;
		cur = next as Record<string, unknown>;
	}
	const key = parts[parts.length - 1];
	const existed = Object.hasOwn(cur, key);
	const previous = cur[key];
	// Object overrides belong to the resolved tree, not to the instance/history snapshot.
	cur[key] = typeof value === 'object' && value !== null ? structuredClone(value) : value;
	if (!validTree(root)) {
		if (existed) cur[key] = previous;
		else delete cur[key];
	}
}
