import { parseLayoutAny } from './migration';
import type { Library, LayoutV2 } from './layoutTree';

export type DecodedLayoutDocument =
	| { kind: 'missing' }
	| { kind: 'corrupt'; reason: string }
	| {
			kind: 'valid';
			raw: Record<string, unknown>;
			layout: LayoutV2;
			library: Library | undefined;
			theme: string;
			themeLock: boolean;
			tokens: Record<string, string>;
			droppedMonitors: string[];
	  };

/** One interpretation of layout files for editing, persistence and overlay reconciliation.
 * Retain the raw object for key migration, which must preserve extension fields. */
export function decodeLayoutDocument(contents: string | null): DecodedLayoutDocument {
	if (contents === null) return { kind: 'missing' };
	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch {
		return { kind: 'corrupt', reason: 'invalid JSON' };
	}
	const layout = parseLayoutAny(value);
	if (!layout) return { kind: 'corrupt', reason: 'unsupported or invalid layout' };
	const raw = value as Record<string, unknown>;
	const library = raw.library;
	const tokens = raw.tokens;
	return {
		kind: 'valid',
		raw,
		layout,
		library:
			library && typeof library === 'object' && Array.isArray((library as Library).defs)
				? (library as Library)
				: undefined,
		theme: typeof raw.theme === 'string' ? raw.theme : '',
		themeLock: raw.themeLock !== false,
		tokens:
			tokens && typeof tokens === 'object' && !Array.isArray(tokens)
				? Object.fromEntries(
						Object.entries(tokens).filter(
							(entry): entry is [string, string] => typeof entry[1] === 'string'
						)
					)
				: {},
		// parseLayoutAny validates the monitors object before returning a layout.
		droppedMonitors: Object.keys(raw.monitors as Record<string, unknown>).filter(
			(key) => !Object.hasOwn(layout.monitors, key)
		)
	};
}
