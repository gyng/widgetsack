// safePath.ts — the ONE prototype-pollution guard for dotted paths + object keys that come from
// untrusted data (sack defs, plugin-package templates, MQTT topic ids, assistant ops). A dotted path
// like `unit.config.x` is walked by solve.ts `setPath` / textTemplate.ts `buildScope`; a segment of
// `__proto__` / `constructor` / `prototype` would walk UP into a shared prototype and poison every
// object in the window. Pure (no I/O), unit-tested in safePath.test.ts.

import type { ParamSpec } from './layoutTree';

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** True for a key/segment that must never be written through (`__proto__`, `constructor`, `prototype`). */
export function isForbiddenKey(seg: string): boolean {
	return FORBIDDEN_PATH_SEGMENTS.has(seg);
}

/** A non-empty dotted path whose every segment is non-empty and not a prototype-walking key. */
export function isSafePath(v: unknown): v is string {
	if (typeof v !== 'string' || !v.length) return false;
	return v.split('.').every((seg) => seg.length > 0 && !isForbiddenKey(seg));
}

/** Whether a ParamSpec's `key`, `target`, and every `targets` entry are safe paths. */
export function isSafeParamSpec(spec: ParamSpec): boolean {
	if (!isSafePath(spec.key)) return false;
	if (spec.target !== undefined && !isSafePath(spec.target)) return false;
	if (spec.targets !== undefined) {
		if (!Array.isArray(spec.targets) || !spec.targets.every(isSafePath)) return false;
	}
	return true;
}

/** Drop the unsafe specs from a def's params (undefined stays undefined; an all-unsafe list → []). */
export function sanitizeParamSpecs(specs: ParamSpec[] | undefined): ParamSpec[] | undefined {
	if (!Array.isArray(specs)) return undefined;
	return specs.filter((s) => !!s && typeof s === 'object' && isSafeParamSpec(s));
}
