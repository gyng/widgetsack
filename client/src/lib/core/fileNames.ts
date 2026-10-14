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
