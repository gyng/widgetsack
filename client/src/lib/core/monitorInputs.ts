// Pure shaping for the Monitor Switch widget (a DDC/CI input-source switcher). No React/Tauri —
// unit-tested. The backend (widgetsack/src/ddc.rs) enumerates monitors and reads/sets VCP 0x60; this
// module names the standard MCCS input codes, parses the user's `sources` config, and merges the
// discovered + configured + current inputs into display rows for the meter.

/** `volume` (0–100) is a volume to apply when this input is chosen — which volume (the Windows
 *  master level, or the monitor's own speakers over DDC/CI) is the widget's `volumeTarget` config;
 *  absent, or `volumeTarget: 'off'` (the default), = leave every volume alone. */
export type VolumeTarget = 'off' | 'system' | 'monitor';
export const VOLUME_TARGETS: readonly VolumeTarget[] = ['off', 'system', 'monitor'];
export const DEFAULT_VOLUME_TARGET: VolumeTarget = 'off';

/** Normalise the `volumeTarget` config (unknown / missing → 'off'). Pure. */
export function parseVolumeTarget(raw: unknown): VolumeTarget {
	return raw === 'system' || raw === 'monitor' ? raw : 'off';
}

/** What to do with a source's paired volume for a given target: null = nothing (feature off, or
 *  no volume on this source). Pure. */
export function volumeAction(
	target: VolumeTarget,
	volume: number | undefined
): { target: 'system' | 'monitor'; volume: number } | null {
	if (target === 'off' || volume === undefined) return null;
	return { target, volume };
}
export type MonitorInputRow = { value: number; label: string; active: boolean; volume?: number };
export type SourceSpec = { value: number; label: string; volume?: number };

/** Normalise a volume as typed in the editor: blank → null (leave the volume alone), anything
 *  non-numeric → null, else rounded and clamped to 0–100. Pure. */
export function parseVolumeInput(raw: string): number | null {
	const trimmed = raw.trim();
	if (trimmed === '') return null;
	const n = Number(trimmed);
	if (!Number.isFinite(n)) return null;
	return Math.max(0, Math.min(100, Math.round(n)));
}

/** Parse the optional `@NN` volume suffix off a spec entry: `('NS2@35') → ['NS2', 35]`. A missing,
 *  blank or non-numeric suffix yields no volume; numbers clamp to 0–100. Pure. */
export function splitVolumeSuffix(entry: string): [string, number | undefined] {
	const at = entry.lastIndexOf('@');
	if (at < 0) return [entry, undefined];
	const head = entry.slice(0, at);
	const raw = entry.slice(at + 1).trim();
	if (!/^-?\d+$/.test(raw)) return [head, undefined];
	return [head, Math.max(0, Math.min(100, Number(raw)))];
}

// Standard MCCS v2.x VCP 0x60 ("Input Select") values. Real monitors deviate (these codes are
// vendor-specific in practice), so this is only a friendly FALLBACK name — discovery comes from the
// monitor's own capabilities and the user can rename/choose per source via the `sources` spec.
export const MCCS_INPUT_NAMES: Record<number, string> = {
	0x01: 'VGA 1',
	0x02: 'VGA 2',
	0x03: 'DVI 1',
	0x04: 'DVI 2',
	0x05: 'Composite 1',
	0x06: 'Composite 2',
	0x07: 'S-Video 1',
	0x08: 'S-Video 2',
	0x09: 'Tuner 1',
	0x0a: 'Tuner 2',
	0x0b: 'Tuner 3',
	0x0c: 'Component 1',
	0x0d: 'Component 2',
	0x0e: 'Component 3',
	0x0f: 'DisplayPort 1',
	0x10: 'DisplayPort 2',
	0x11: 'HDMI 1',
	0x12: 'HDMI 2',
	0x15: 'USB-C' // common vendor extension (USB-C / Thunderbolt on some panels)
};

// A usable fallback when neither the user's spec nor capability discovery yields any inputs (some
// monitors don't report a 0x60 list). The user can always narrow this with the `sources` spec.
const DEFAULT_INPUTS = [0x0f, 0x10, 0x11, 0x12]; // DP 1, DP 2, HDMI 1, HDMI 2

/** Friendly name for a VCP 0x60 value: the MCCS name, else a hex fallback like `Input 0x1B`. */
export function inputName(value: number): string {
	return MCCS_INPUT_NAMES[value] ?? `Input 0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Parse a single input code: decimal (`17`), `0x`-hex (`0x11`), or trailing-`h` hex (`11h`). Returns
 *  null for junk or an out-of-byte-range value. */
function parseCode(s: string): number | null {
	const t = s.trim();
	let v: number;
	if (/^0x[0-9a-f]+$/i.test(t)) v = parseInt(t.slice(2), 16);
	else if (/^[0-9a-f]+h$/i.test(t)) v = parseInt(t.slice(0, -1), 16);
	else if (/^\d+$/.test(t)) v = parseInt(t, 10);
	else return null;
	return Number.isFinite(v) && v >= 0 && v <= 255 ? v : null;
}

/** Parse the optional `sources` config: a comma/newline-separated list of `code`, `code=label`,
 *  `code@volume` or `code=label@volume` entries (code = decimal `17`, hex `0x11`, or `11h`; volume =
 *  0–100, applied to the widget's `volumeTarget` when that input is chosen — ignored while the target
 *  is 'off', the default). Blank/invalid entries are
 *  dropped; a missing label defaults to the MCCS name. Lets a user choose WHICH inputs appear (and
 *  order + rename them, and pair each with a volume) without a multi-select control. Pure. */
export function parseSourceSpec(spec: string | undefined): SourceSpec[] {
	if (!spec) return [];
	const out: SourceSpec[] = [];
	for (const raw of spec.split(/[,\n]/)) {
		const [entry, volume] = splitVolumeSuffix(raw.trim());
		if (!entry) continue;
		const eq = entry.indexOf('=');
		const value = parseCode(eq >= 0 ? entry.slice(0, eq) : entry);
		if (value === null) continue;
		const label = eq >= 0 ? entry.slice(eq + 1).trim() : '';
		const row: SourceSpec = { value, label: label || inputName(value) };
		if (volume !== undefined) row.volume = volume;
		out.push(row);
	}
	return out;
}

/** Build the meter's input rows from the monitor's discovered inputs (caps), the user's `sources`
 *  spec, and the current input. Precedence: an explicit spec wins; else discovered inputs; else a
 *  sensible default set. The active input is always included (even if outside the chosen set) so the
 *  user can see — and switch back to — what's selected. De-duplicated by value, order preserved. Pure. */
export function monitorInputRows(opts: {
	discovered: number[];
	spec?: string;
	current?: number | null;
}): MonitorInputRow[] {
	const { discovered, spec, current = null } = opts;
	const parsed = parseSourceSpec(spec);

	let base: SourceSpec[];
	if (parsed.length > 0) base = parsed;
	else if (discovered.length > 0) base = discovered.map((v) => ({ value: v, label: inputName(v) }));
	else base = DEFAULT_INPUTS.map((v) => ({ value: v, label: inputName(v) }));

	if (current !== null && !base.some((b) => b.value === current)) {
		base = [...base, { value: current, label: inputName(current) }];
	}

	const seen = new Set<number>();
	const rows: MonitorInputRow[] = [];
	for (const b of base) {
		if (seen.has(b.value)) continue;
		seen.add(b.value);
		const row: MonitorInputRow = { value: b.value, label: b.label, active: b.value === current };
		if (b.volume !== undefined) row.volume = b.volume;
		rows.push(row);
	}
	return rows;
}

/** Format the current-mode stats line, e.g. `2560×1440 · 144 Hz`. Empty string when the mode is
 *  unknown (width/height 0); drops the refresh when it's unknown. Pure. */
export function formatStats(
	stats: { width: number; height: number; refreshHz: number } | null | undefined
): string {
	if (!stats || stats.width <= 0 || stats.height <= 0) return '';
	const res = `${stats.width}×${stats.height}`;
	return stats.refreshHz > 0 ? `${res} · ${stats.refreshHz} Hz` : res;
}

// --- Friendly sources editor (the studio Inspector control) ------------------------------------

/** One row in the Inspector's sources editor: an input the user can include/exclude and rename.
 *  `label` is the custom name ('' = use `defaultName`). `detected` is false for a manual entry kept
 *  from the spec that the monitor didn't report. */
export type SourceEditorRow = {
	value: number;
	defaultName: string;
	label: string;
	include: boolean;
	detected: boolean;
	/** Volume (0–100) paired with this input (see `volumeTarget`); null = leave it alone. */
	volume: number | null;
};

/** Build the editor rows from the monitor's detected inputs + the current `sources` spec. Detected
 *  inputs come first (checked when the spec is blank, else only those the spec lists); spec entries the
 *  monitor didn't report follow as manual rows. `label` is '' when it matches the default name. Pure. */
export function sourceEditorRows(detected: number[], spec: string | undefined): SourceEditorRow[] {
	const parsed = parseSourceSpec(spec);
	const specEmpty = parsed.length === 0;
	const byValue = new Map(parsed.map((p) => [p.value, p]));
	const rows: SourceEditorRow[] = [];
	const seen = new Set<number>();
	for (const value of detected) {
		if (seen.has(value)) continue;
		seen.add(value);
		const custom = byValue.get(value);
		const defaultName = inputName(value);
		rows.push({
			value,
			defaultName,
			label: custom && custom.label !== defaultName ? custom.label : '',
			include: specEmpty || byValue.has(value),
			detected: true,
			volume: custom?.volume ?? null
		});
	}
	for (const p of parsed) {
		if (seen.has(p.value)) continue;
		seen.add(p.value);
		const defaultName = inputName(p.value);
		rows.push({
			value: p.value,
			defaultName,
			label: p.label !== defaultName ? p.label : '',
			include: true,
			detected: false,
			volume: p.volume ?? null
		});
	}
	return rows;
}

/** Build the `sources` spec string from editor rows. Included rows become `0xNN` (or `0xNN=label`
 *  when renamed), with `@volume` appended when a volume is set. Returns '' (the clean "auto: show all
 *  detected" default) when the rows are exactly all-detected, all-included, none-renamed, no volumes.
 *  Pure — inverse of `sourceEditorRows`. */
export function buildSourceSpec(rows: SourceEditorRow[]): string {
	const isAuto =
		rows.length > 0 &&
		rows.every((r) => r.detected && r.include && r.label === '' && r.volume === null);
	if (isAuto) return '';
	return rows
		.filter((r) => r.include)
		.map((r) => {
			const code = `0x${r.value.toString(16)}`;
			const named = r.label ? `${code}=${r.label}` : code;
			return r.volume === null ? named : `${named}@${r.volume}`;
		})
		.join(', ');
}
