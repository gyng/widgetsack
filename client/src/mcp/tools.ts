// Pure tool logic for the widgetsack MCP server (mcp/server.ts). Lives in src/ so it is type-checked
// (`npm run check`) and unit-tested (`npm run test:unit`); it is NOT imported by the app, so it never
// reaches the production bundle. Reuses the SAME pure layout engine the in-app AI assistant uses
// (applyAssistantOps / describeLayout / the AssistantOp vocabulary) so an external agent edits the
// desktop through exactly the validated grammar — no second implementation to drift.
//
// No node: imports and no I/O here — the server passes the parsed widgets.json in and writes the
// returned object back. Keeps this layer framework- and runtime-agnostic (AGENTS.md §5).
import { parseLayoutAny } from '../lib/core/migration';
import { emptyRoot, type MonitorLayout } from '../lib/core/layoutTree';
import {
	applyAssistantOps,
	buildLayoutSystemPrompt,
	describeLayout,
	type ApplyResult,
	type AssistantOp
} from '../lib/core/llm';
import { listMetas } from '../lib/core/widget';
import { KNOWN_SENSORS } from '../lib/core/sensors';

/** The raw parsed widgets.json shape (frontend-owned): `{ version, monitors, library?, theme?, tokens? }`.
 * We keep it loose and only touch `version` + `monitors`, preserving every other key verbatim. */
export type LayoutFile = Record<string, unknown>;

/** The monitor keys present in the file (each is a real monitor identifier the app wrote). */
export function monitorKeys(file: LayoutFile | null): string[] {
	return Object.keys(parseLayoutAny(file ?? {})?.monitors ?? {});
}

function monitorsOf(file: LayoutFile | null): Record<string, MonitorLayout> {
	return { ...parseLayoutAny(file ?? {})?.monitors };
}

/** Resolve which monitor key to act on: the requested one (created if absent), else the first existing,
 * else null when the file has no monitors and none was requested. */
function resolveKey(file: LayoutFile | null, requested?: string): string | null {
	if (requested) return requested;
	return Object.keys(monitorsOf(file))[0] ?? null;
}

/** The widget catalog an agent should read before emitting ops: type, what it binds, its config keys,
 * and a one-line description — the same data the in-app assistant's system prompt is built from. */
export function widgetTypesText(): string {
	return buildLayoutSystemPrompt(listMetas(), KNOWN_SENSORS as unknown as string[]);
}

/** The curated bindable sensor ids (dynamic per-core/per-disk ids only appear once the app is live). */
export function sensorsText(): string {
	return [
		'Bindable sensor ids (curated; the running app also exposes dynamic ids like cpu.core.N, disk.<letter>.*):',
		'',
		(KNOWN_SENSORS as unknown as string[]).join(', ')
	].join('\n');
}

/** The live-state snapshot the running app writes to `<config>/mcp/state.json` (latest sensor values). */
export type StateFile = { ts_ms?: number; sensors?: Record<string, number | string> } | null;

/** Format the live sensor readings for an agent. Empty/absent => a hint that the app must be running. */
export function describeSensorsText(state: StateFile): string {
	const sensors = state?.sensors;
	if (!sensors || Object.keys(sensors).length === 0) {
		return 'No live readings — is widgetsack running? It writes a snapshot every few seconds while open.';
	}
	const lines = Object.entries(sensors)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, v]) => `${id} = ${v}`);
	return `Live sensor readings (${lines.length}):\n${lines.join('\n')}`;
}

/** One now-playing entry from the control server's `/now_playing`. */
export type NowPlaying = { title?: string; artist?: string; status?: string; source?: string };

/** Format the now-playing list for an agent. */
export function describeNowPlayingText(items: NowPlaying[] | null): string {
	if (!items || items.length === 0) return 'Nothing is playing (no active media session).';
	return items
		.map(
			(m) =>
				`${m.status ?? '?'}: ${m.title ?? '(unknown)'}${m.artist ? ` — ${m.artist}` : ''}${
					m.source ? ` [${m.source}]` : ''
				}`
		)
		.join('\n');
}

/** A human/agent-readable description of the current layout: monitor keys + each monitor's widgets. */
export function describeLayoutText(file: LayoutFile | null, monitor?: string): string {
	const monitors = monitorsOf(file);
	const keys = Object.keys(monitors);
	if (!keys.length)
		return 'No layout yet (run widgetsack at least once, or apply ops with a monitor key).';
	const targets = monitor ? [monitor] : keys;
	const lines: string[] = [`Monitors: ${keys.join(', ')}`];
	for (const key of targets) {
		const m = monitors[key];
		lines.push('', `## ${key}`);
		if (!m) {
			lines.push('(no such monitor)');
			continue;
		}
		const items = describeLayout(m);
		if (!items.length) lines.push('(empty)');
		for (const it of items) {
			lines.push(
				`- ${it.id}: ${it.type}${it.sensor ? ` (sensor=${it.sensor})` : ''} in ${it.container}`
			);
		}
	}
	return lines.join('\n');
}

/** The active theme name set on the layout file (the overlay loads `themes/<name>.css`), or null. */
export function currentTheme(file: LayoutFile | null): string | null {
	const t = file?.theme;
	return typeof t === 'string' && t.trim() ? t.trim() : null;
}

/** Set (or clear, when blank) the layout file's active theme, preserving everything else. Pure. */
export function setThemeInFile(file: LayoutFile | null, name: string): LayoutFile {
	const out: LayoutFile = { ...(file ?? { version: 2, monitors: {} }) };
	const trimmed = name.trim();
	if (trimmed) out.theme = trimmed;
	else delete out.theme;
	if (!out.version) out.version = 2;
	return out;
}

export type ApplyOpsOutcome = {
	file: LayoutFile;
	monitorKey: string;
	result: ApplyResult;
};

/** Apply the AssistantOp vocabulary to one monitor of the parsed file, returning a NEW file object
 * (library/theme/tokens preserved) plus what happened. Pure — the caller writes the result to disk. */
export function applyOpsToFile(
	file: LayoutFile | null,
	ops: AssistantOp[],
	makeId: (type: string) => string,
	monitor?: string
): ApplyOpsOutcome {
	const monitors = monitorsOf(file);
	const key = resolveKey(file, monitor);
	if (!key) {
		throw new Error(
			'no monitor to target — run widgetsack once so it records a monitor, or pass a monitor key'
		);
	}
	const target: MonitorLayout = monitors[key] ?? { root: emptyRoot(), floating: [] };
	const result = applyAssistantOps(target, ops, makeId);
	monitors[key] = result.monitor;
	const out: LayoutFile = { ...file, version: 2, monitors };
	return { file: out, monitorKey: key, result };
}
