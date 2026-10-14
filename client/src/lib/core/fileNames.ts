/** Choose an unused Windows file stem without exceeding the backend's 64-character limit. */
export function unusedFileName(
	name: string,
	existing: readonly string[],
	suffix: string,
	alwaysSuffix = false
): string {
	const taken = new Set(existing.map((value) => value.toLowerCase()));
	if (!alwaysSuffix && !taken.has(name.toLowerCase())) return name;
	let ending = suffix;
	let candidate = name.slice(0, 64 - ending.length) + ending;
	let n = 2;
	while (taken.has(candidate.toLowerCase())) {
		ending = `${suffix}${n++}`;
		candidate = name.slice(0, 64 - ending.length) + ending;
	}
	return candidate;
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[1-9¹²³])$/i;

/** Whether `name` passes the backend file-stem allowlist (file_io.rs valid_name): 1–64 chars of ASCII
 * letters, digits, spaces, `_` and `-`, no surrounding whitespace, not a Windows device name. */
export function isValidFileStem(name: string): boolean {
	return (
		name.length > 0 &&
		name.length <= 64 &&
		name === name.trim() &&
		/^[A-Za-z0-9 _-]+$/.test(name) &&
		!WINDOWS_DEVICE.test(name)
	);
}

/** Turn an arbitrary display name (e.g. a shared sack's theme name) into a stem `isValidFileStem`
 * accepts: accents are folded (`Rosé` → `Rose`), other disallowed runs become `-`, the ends are
 * trimmed, and a Windows device name gets a suffix. Falls back to `fallback` when nothing is left. */
export function safeFileStem(name: string, fallback: string): string {
	if (isValidFileStem(name)) return name;
	const folded = name.normalize('NFKD').replace(/\p{M}/gu, '');
	let stem = folded
		.replace(/[^A-Za-z0-9 _-]+/g, '-')
		.replace(/^[\s-]+|[\s-]+$/g, '')
		.slice(0, 64)
		.trim();
	if (!stem) stem = fallback;
	if (WINDOWS_DEVICE.test(stem)) stem = `${stem}-${fallback}`;
	return stem;
}
