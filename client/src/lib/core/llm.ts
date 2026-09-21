// Framework-agnostic AI/LLM domain (inner ring, AGENTS.md §5) — NO React, NO Tauri, NO DOM. Pure
// data in → data out, unit-tested directly. Three concerns live here:
//   1. Provider metadata (the catalog the settings UI renders) — mirrors the providers in
//      widgetsack/src/llm.rs.
//   2. The chat transcript reducer (`applyDelta` / `startTurn` / …) consumed by the llm store, mirroring
//      the streamed `llm_delta` shape from Rust.
//   3. The natural-language LAYOUT ASSISTANT: a constrained op vocabulary the model emits, a prompt
//      builder that teaches it the available widgets/sensors, a tolerant reply parser, and a pure
//      applier that turns ops into a new MonitorLayout via the core layoutEdit primitives.
//
// Keep the types here in lock-step with the serde structs in widgetsack/src/llm.rs (the bridge
// contract) and with llm-types.ts (the adapter mirror).

import type { WidgetInstance } from './layout';
import {
	container,
	emptyRoot,
	isContainer,
	isGroup,
	isLeaf,
	leaf,
	type Container,
	type Leaf,
	type LayoutNode,
	type MonitorLayout
} from './layoutTree';
import { findNode, insertChild, removeNode, updateNode } from './layoutEdit';
import { normalizeMacro } from './macro';
import { isForbiddenKey } from './safePath';
import { createWidget, getMeta, type ConfigField, type WidgetMeta } from './widget';

// =====================================================================================
// 1. Providers
// =====================================================================================

export type ProviderId = 'anthropic' | 'openai' | 'ollama';

export type ProviderMeta = {
	id: ProviderId;
	label: string;
	/** Shown as the placeholder/effective base when the user leaves Base URL blank. */
	defaultBaseUrl: string;
	/** Keyless providers (ollama) don't need an API key. */
	needsKey: boolean;
	help: string;
	/** A couple of example model ids for the placeholder (the live list comes from llm_list_models). */
	sampleModels: string[];
	/** Whether the provider exposes OpenAI-style speech endpoints (/audio/transcriptions + /audio/speech).
	 * Gates the STT/TTS model fields in the settings UI; mirrors `supports_transcription`/`supports_tts`
	 * in widgetsack/src/llm.rs (OpenAI-compatible only — anthropic + ollama have none). */
	supportsAudio: boolean;
	/** Example speech-to-text (whisper) model ids for the placeholder. */
	sampleSttModels: string[];
	/** Example text-to-speech model ids for the placeholder. */
	sampleTtsModels: string[];
	/** Selectable TTS voices for the placeholder/picker. */
	sampleVoices: string[];
};

// OpenAI's speech voices + model families — the placeholders/typeahead for any OpenAI-compatible provider.
const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

export const PROVIDERS: ProviderMeta[] = [
	{
		id: 'anthropic',
		label: 'Anthropic (Claude)',
		defaultBaseUrl: 'https://api.anthropic.com',
		needsKey: true,
		help: 'Claude models. Get a key at console.anthropic.com.',
		sampleModels: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'],
		supportsAudio: false,
		sampleSttModels: [],
		sampleTtsModels: [],
		sampleVoices: []
	},
	{
		id: 'openai',
		label: 'OpenAI / compatible',
		defaultBaseUrl: 'https://api.openai.com/v1',
		needsKey: true,
		help: 'OpenAI, or any OpenAI-compatible endpoint (Groq, OpenRouter, LM Studio, llama.cpp, Ollama’s /v1) — set Base URL to point elsewhere.',
		sampleModels: ['gpt-4o-mini', 'gpt-4o', 'o4-mini'],
		supportsAudio: true,
		sampleSttModels: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
		sampleTtsModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'],
		sampleVoices: OPENAI_VOICES
	},
	{
		id: 'ollama',
		label: 'Ollama (local)',
		defaultBaseUrl: 'http://localhost:11434',
		needsKey: false,
		help: 'A local Ollama server — private, free, no key. Pull a model first (e.g. `ollama pull llama3.2`).',
		sampleModels: ['llama3.2', 'qwen2.5', 'mistral'],
		supportsAudio: false,
		sampleSttModels: [],
		sampleTtsModels: [],
		sampleVoices: []
	}
];

export function providerMeta(id: string): ProviderMeta {
	return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[1];
}

// =====================================================================================
// 2. Chat transcript (streamed)
// =====================================================================================

export type ChatRole = 'system' | 'user' | 'assistant';
/** One message sent INTO the model (mirrors `ChatMessage` in widgetsack/src/llm.rs). */
export type ChatMessage = { role: ChatRole; content: string };

/** One streamed delta frame (mirrors the camelCase `LlmDelta` emitted on `llm_delta`). */
export type LlmDelta = { requestId: string; token: string; done: boolean; error?: string };

/** A turn in the visible transcript. An assistant turn streams in by id (id === the stream requestId). */
export type ChatTurn = {
	id: string;
	role: ChatRole;
	content: string;
	streaming?: boolean;
	error?: string;
};
export type ChatState = { turns: ChatTurn[] };

export const emptyChat = (): ChatState => ({ turns: [] });

/** Append a user turn. */
export function pushUser(state: ChatState, id: string, content: string): ChatState {
	return { turns: [...state.turns, { id, role: 'user', content }] };
}

/** Open an empty assistant turn that subsequent `llm_delta` frames (same id) stream into. */
export function startTurn(state: ChatState, id: string): ChatState {
	return { turns: [...state.turns, { id, role: 'assistant', content: '', streaming: true }] };
}

/** Pure reducer: fold one streamed delta into the matching assistant turn. An `error` frame ends the
 * turn with the message; a `done` frame clears `streaming`; otherwise the token is appended. */
export function applyDelta(state: ChatState, delta: LlmDelta): ChatState {
	let found = false;
	let changed = false;
	const turns = state.turns.map((t) => {
		if (t.id !== delta.requestId) return t;
		found = true;
		const next: ChatTurn = delta.error
			? { ...t, streaming: false, error: delta.error }
			: { ...t, content: t.content + delta.token, streaming: !delta.done };
		// Skip the allocation (and the re-render it triggers) when the frame changed nothing observable
		// — e.g. a duplicate terminal `done` for an already-finalized turn.
		if (next.content === t.content && next.streaming === t.streaming && next.error === t.error) {
			return t;
		}
		changed = true;
		return next;
	});
	if (!found) {
		// A `done` frame for an unknown id is a no-op — return the SAME state (no re-render). Otherwise
		// seed a turn so nothing is silently dropped (streaming unless this seed frame is itself an error).
		if (delta.done) return state;
		return {
			turns: [
				...state.turns,
				{
					id: delta.requestId,
					role: 'assistant',
					content: delta.token,
					streaming: !delta.error,
					...(delta.error ? { error: delta.error } : {})
				}
			]
		};
	}
	return changed ? { turns } : state;
}

/** The messages to send for the next turn: the prior transcript (system+user+assistant) as ChatMessages. */
export function toMessages(state: ChatState): ChatMessage[] {
	return state.turns
		.filter((t) => t.content.length > 0 && !t.error)
		.map((t) => ({ role: t.role, content: t.content }));
}

// =====================================================================================
// 3a. Briefing (the overlay "AI status line" widget's prompt)
// =====================================================================================

export const BRIEFING_SYSTEM =
	'You are a desktop status assistant. Given live system sensor readings, write ONE short, friendly sentence summarizing how the machine is doing right now. No preamble, no markdown, no lists.';

/** Render a `{ sensorId: value }` snapshot as a compact `k=v, k=v` string (blank/missing dropped). */
export function formatReadings(readings: Record<string, number | string>): string {
	const entries = Object.entries(readings).filter(
		([, v]) => v !== '' && v !== null && v !== undefined
	);
	if (!entries.length) return '(no readings available)';
	return entries.map(([k, v]) => `${k}=${v}`).join(', ');
}

/** The messages for a one-sentence system briefing from a sensor snapshot. */
export function buildBriefingMessages(readings: Record<string, number | string>): ChatMessage[] {
	return [
		{ role: 'system', content: BRIEFING_SYSTEM },
		{
			role: 'user',
			content: `Live readings: ${formatReadings(readings)}. Summarize in one sentence.`
		}
	];
}

const ASSISTANT_SYSTEM =
	'You are a concise desktop widget assistant. Use the live system readings provided. Reply with ONLY the text to display in a small widget — no preamble, no markdown, no quotes.';

/** Messages for a configurable AI widget: a user-authored `prompt` plus a live sensor snapshot. */
export function buildAssistantMessages(
	prompt: string,
	readings: Record<string, number | string>
): ChatMessage[] {
	const instruction = prompt.trim() || 'Summarize my system status in one short sentence.';
	return [
		{ role: 'system', content: ASSISTANT_SYSTEM },
		{ role: 'user', content: `Live readings: ${formatReadings(readings)}.\n\n${instruction}` }
	];
}

// =====================================================================================
// 3b. Translation (the transcribe/translate widget)
// =====================================================================================

/** Messages to translate `text` into `targetLang`. Output is the translation only. */
export function buildTranslateMessages(text: string, targetLang: string): ChatMessage[] {
	const lang = targetLang.trim() || 'English';
	return [
		{
			role: 'system',
			content: `You are a translator. Translate the user's text into ${lang}. Output ONLY the translation — no quotes, no notes, no transliteration, no explanation.`
		},
		{ role: 'user', content: text }
	];
}

// =====================================================================================
// 3. Natural-language layout assistant
// =====================================================================================

/** The constrained op vocabulary the model is allowed to emit. Deliberately a SMALL, safe subset of
 * the editor's internal ops — every op maps to a pure layoutEdit primitive in `applyAssistantOps`. */
export type AssistantOp =
	| {
			op: 'addWidget';
			widgetType: string;
			sensor?: string;
			config?: Record<string, unknown>;
			parent?: string;
	  }
	| { op: 'removeWidget'; id: string }
	| { op: 'setConfig'; id: string; config: Record<string, unknown> }
	| { op: 'setSensor'; id: string; sensor: string }
	| { op: 'addContainer'; kind: 'row' | 'col' | 'grid'; parent?: string }
	| { op: 'clear' };

export type AssistantReply = { ops: AssistantOp[]; summary: string };

/** A compact description of one placed widget, for the prompt's "current layout" context. */
export type LayoutItem = { id: string; type: string; sensor?: string; container: string };

const VALID_OPS = new Set([
	'addWidget',
	'removeWidget',
	'setConfig',
	'setSensor',
	'addContainer',
	'clear'
]);

/** Describe the widgets currently on a monitor (flow tree + floating) so the model can edit/remove by id. */
export function describeLayout(monitor: MonitorLayout): LayoutItem[] {
	const out: LayoutItem[] = [];
	const walk = (node: LayoutNode, parent: string): void => {
		if (isContainer(node)) {
			node.children.forEach((c) => walk(c, node.id));
			return;
		}
		if (!isGroup(node.unit)) {
			const u = node.unit;
			out.push({ id: u.id, type: u.type, sensor: u.sensor, container: parent });
		} else {
			out.push({ id: node.unit.id, type: 'group', container: parent });
		}
	};
	walk(monitor.root, monitor.root.id);
	monitor.floating.forEach((l) => walk(l, 'floating'));
	return out;
}

/** Build the system prompt: teach the model the available widget types (+ their config keys + whether
 * they bind a sensor), the bindable sensor ids, the op format, and the hard rules. */
export function buildLayoutSystemPrompt(metas: WidgetMeta[], sensorIds: string[]): string {
	const widgetLines = metas
		.filter((m) => m.type !== 'spacer')
		.map((m) => {
			const cfg = Object.keys(m.defaultConfig ?? {});
			const binds = m.binds ?? 'scalar';
			const takesSensor =
				binds === 'scalar' || binds === 'series' || binds === 'text' || binds === 'json';
			const cfgStr = cfg.length ? ` config: ${cfg.join(', ')}.` : '';
			const sensorStr = takesSensor ? ' takes a sensor.' : ' self-sourcing (no sensor).';
			return `- ${m.type}: ${m.description ?? m.label ?? m.type}${sensorStr}${cfgStr}`;
		})
		.join('\n');

	const sensors = sensorIds.length ? sensorIds.join(', ') : '(none reported yet)';

	return [
		'You are the layout assistant for "widgetsack", a desktop widget overlay. The user describes a',
		'dashboard in plain language; you reply with a JSON object that edits their layout.',
		'',
		'Reply with ONLY a JSON object, no prose, no markdown fences:',
		'{ "ops": [ ... ], "summary": "one short sentence describing what you did" }',
		'',
		'Allowed ops:',
		'- { "op": "addWidget", "widgetType": "<type>", "sensor": "<id?>", "config": { ... }, "parent": "<containerId?>" }',
		'- { "op": "removeWidget", "id": "<widgetId>" }',
		'- { "op": "setConfig", "id": "<widgetId>", "config": { ... } }',
		'- { "op": "setSensor", "id": "<widgetId>", "sensor": "<id>" }',
		'- { "op": "addContainer", "kind": "row"|"col"|"grid", "parent": "<containerId?>" }',
		'- { "op": "clear" }   // remove every widget',
		'',
		'Rules:',
		'- Use ONLY widget types and sensor ids listed below. Never invent a type, config key, or sensor.',
		'- Only widgets that "take a sensor" may have a "sensor". Self-sourcing widgets must NOT.',
		'- Omit "parent" to add to the root. Use a container id from "Current layout" to nest.',
		'- Prefer a gauge/bar for a single % (cpu/gpu/mem), a sparkline for a trend, a clock for time, text for a label/number.',
		'',
		'Available widget types:',
		widgetLines,
		'',
		'Bindable sensor ids:',
		sensors
	].join('\n');
}

/** Build the per-request user message: the instruction plus the current layout for context. */
export function buildLayoutUserPrompt(instruction: string, monitor: MonitorLayout): string {
	const items = describeLayout(monitor);
	const layout = items.length
		? items
				.map(
					(i) => `${i.id} (${i.type}${i.sensor ? `, sensor=${i.sensor}` : ''}) in ${i.container}`
				)
				.join('\n')
		: '(empty)';
	return `Current layout:\n${layout}\n\nRequest: ${instruction}`;
}

/** Tolerantly extract the `{ ops, summary }` object from a model reply: strips ``` fences and finds the
 * first balanced JSON object that parses. Returns null when no valid ops object is present. */
export function parseAssistantReply(text: string): AssistantReply | null {
	const stripped = text.replace(/```(?:json)?/gi, '').trim();
	// Try each balanced {...} object in turn (a reasoning model may emit a sibling object — e.g. a
	// `{"thinking":...}` envelope — BEFORE the ops object), then the whole string. First with an `ops`
	// array wins, so a leading non-ops object no longer shadows the real reply.
	for (const candidate of [...jsonObjectCandidates(stripped), stripped]) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== 'object') continue;
		const obj = parsed as { ops?: unknown; summary?: unknown };
		if (!Array.isArray(obj.ops)) continue;
		const ops = obj.ops.filter(
			(o): o is AssistantOp =>
				!!o &&
				typeof o === 'object' &&
				typeof (o as { op?: unknown }).op === 'string' &&
				VALID_OPS.has((o as { op: string }).op)
		);
		return { ops, summary: typeof obj.summary === 'string' ? obj.summary : '' };
	}
	return null;
}

/** Yield each balanced top-level `{...}` substring in order (brace-counted; respects string literals
 * and escapes, so braces inside strings don't miscount). */
function* jsonObjectCandidates(s: string): Generator<string> {
	let i = 0;
	while (i < s.length) {
		const start = s.indexOf('{', i);
		if (start < 0) return;
		let depth = 0;
		let inStr = false;
		let esc = false;
		let end = -1;
		for (let j = start; j < s.length; j++) {
			const ch = s[j];
			if (inStr) {
				if (esc) esc = false;
				else if (ch === '\\') esc = true;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') inStr = true;
			else if (ch === '{') depth++;
			else if (ch === '}') {
				depth--;
				if (depth === 0) {
					end = j;
					break;
				}
			}
		}
		if (end < 0) return; // unbalanced tail — nothing more to yield
		yield s.slice(start, end + 1);
		i = end + 1;
	}
}

export type ApplyResult = {
	monitor: MonitorLayout;
	applied: number;
	addedIds: string[];
	errors: string[];
};

/** Whether `value` is the primitive a config field of `kind` holds. */
function fieldAccepts(field: ConfigField, value: unknown): boolean {
	switch (field.kind) {
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'toggle':
			return typeof value === 'boolean';
		case 'macro':
			return Array.isArray(value);
		default:
			// text / color / select / expr / monitorSources all hold a string
			return typeof value === 'string';
	}
}

/**
 * Validate a model-proposed `config` against the widget type's declared meta (core/widget
 * `configFields`, falling back to the primitive `defaultConfig` keys): unknown keys are DROPPED,
 * a wrong primitive type is REJECTED, a macro is normalised, prototype keys never pass, and an
 * iframe may not turn its sandbox off. The model is untrusted text — this is the boundary that
 * keeps a hallucinated or hostile key out of the layout. Pure; each drop is explained in `errors`.
 */
export function sanitizeAssistantConfig(
	widgetType: string,
	config: unknown
): { config: Record<string, unknown>; errors: string[] } {
	const out: Record<string, unknown> = {};
	const errors: string[] = [];
	if (!config || typeof config !== 'object' || Array.isArray(config))
		return { config: out, errors };
	const meta = getMeta(widgetType);
	if (!meta) return { config: out, errors: [`unknown widget type "${widgetType}"`] };
	const fields = new Map((meta.configFields ?? []).map((f) => [f.key, f]));
	const defaults = meta.defaultConfig ?? {};
	for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
		if (isForbiddenKey(key)) {
			errors.push(`"${widgetType}": refused config key "${key}"`);
			continue;
		}
		if (widgetType === 'iframe' && key === 'sandbox' && value !== true) {
			errors.push('"iframe": refused sandbox: false — embedded pages stay sandboxed');
			continue;
		}
		const field = fields.get(key);
		if (field) {
			if (!fieldAccepts(field, value)) {
				errors.push(`"${widgetType}": config "${key}" must be a ${field.kind}`);
				continue;
			}
			out[key] = field.kind === 'macro' ? normalizeMacro(value) : value;
			continue;
		}
		if (Object.hasOwn(defaults, key)) {
			const dflt = defaults[key];
			const primitive =
				typeof dflt === 'string' || typeof dflt === 'number' || typeof dflt === 'boolean';
			if (primitive && typeof value === typeof dflt) {
				out[key] = value;
				continue;
			}
			errors.push(`"${widgetType}": config "${key}" must be a ${typeof dflt}`);
			continue;
		}
		errors.push(`"${widgetType}": dropped unknown config key "${key}"`);
	}
	return { config: out, errors };
}

const SENSOR_BINDS = new Set(['scalar', 'series', 'text', 'json']);

/** Apply assistant ops to a monitor, returning a NEW MonitorLayout (pure — never mutates the input).
 * `makeId` supplies fresh widget ids (the editor passes its rand-based generator; tests a counter).
 * Invalid ops (unknown type, sensor on a self-sourcing widget, missing target) are skipped and noted in
 * `errors` rather than throwing, so one bad op can't abort the batch. */
export function applyAssistantOps(
	monitor: MonitorLayout,
	ops: AssistantOp[],
	makeId: (type: string) => string
): ApplyResult {
	let root = monitor.root;
	const errors: string[] = [];
	const addedIds: string[] = [];
	let applied = 0;

	const parentOr = (id: string | undefined): string => {
		if (!id || id === 'root' || id === root.id) return root.id;
		const node = findNode(root, id);
		if (node && isContainer(node)) return id;
		errors.push(`unknown container "${id}" — added to root instead`);
		return root.id;
	};

	for (const op of ops) {
		switch (op.op) {
			case 'clear': {
				root = emptyRoot();
				applied++;
				break;
			}
			case 'addWidget': {
				const meta = getMeta(op.widgetType);
				if (!meta) {
					errors.push(`unknown widget type "${op.widgetType}"`);
					break;
				}
				const id = makeId(op.widgetType);
				const inst = createWidget(op.widgetType, id);
				const binds = meta.binds ?? 'scalar';
				if (op.sensor && SENSOR_BINDS.has(binds)) inst.sensor = op.sensor;
				else if (op.sensor)
					errors.push(`"${op.widgetType}" is self-sourcing — ignored sensor "${op.sensor}"`);
				if (op.config && typeof op.config === 'object') {
					const safe = sanitizeAssistantConfig(op.widgetType, op.config);
					errors.push(...safe.errors);
					inst.config = { ...inst.config, ...safe.config };
				}
				root = insertChild(root, parentOr(op.parent), leaf(inst));
				addedIds.push(id);
				applied++;
				break;
			}
			case 'addContainer': {
				const id = makeId(op.kind); // makeId already prefixes with the kind (e.g. `row-<rand>`)
				root = insertChild(root, parentOr(op.parent), newContainer(op.kind, id));
				addedIds.push(id);
				applied++;
				break;
			}
			case 'removeWidget': {
				if (!findNode(root, op.id)) {
					errors.push(`cannot remove "${op.id}" — not found`);
					break;
				}
				root = removeNode(root, op.id);
				applied++;
				break;
			}
			case 'setConfig': {
				if (!patchUnitExists(root, op.id)) {
					errors.push(`cannot configure "${op.id}" — not a widget`);
					break;
				}
				// patchUnitExists guarantees a primitive widget leaf, so its type is safe to read here.
				const type = ((findNode(root, op.id) as Leaf).unit as WidgetInstance).type;
				const safe = sanitizeAssistantConfig(type, op.config);
				errors.push(...safe.errors);
				root = updateNode(root, op.id, (n) => {
					// patchUnitExists above guarantees the target passed to this callback is a primitive leaf.
					const leaf = n as Leaf;
					const unit = leaf.unit as WidgetInstance;
					return { ...leaf, unit: { ...unit, config: { ...unit.config, ...safe.config } } };
				});
				applied++;
				break;
			}
			case 'setSensor': {
				const binds = leafBinds(root, op.id);
				if (binds === null) {
					errors.push(`cannot set sensor on "${op.id}" — not a widget`);
					break;
				}
				// Same self-sourcing gate as addWidget: a clock/cpu/spectrum/button/zone (binds 'none')
				// must not carry a sensor the meter ignores. The model is untrusted, so enforce here.
				if (!SENSOR_BINDS.has(binds)) {
					errors.push(`"${op.id}" is self-sourcing — ignored sensor "${op.sensor}"`);
					break;
				}
				root = updateNode(root, op.id, (n) => {
					// non-null leafBinds plus the bind gate guarantee a primitive leaf target.
					const leaf = n as Leaf;
					const unit = leaf.unit as WidgetInstance;
					return { ...leaf, unit: { ...unit, sensor: op.sensor } };
				});
				applied++;
				break;
			}
		}
	}

	return { monitor: { ...monitor, root }, applied, addedIds, errors };
}

function newContainer(kind: 'row' | 'col' | 'grid', id: string): Container {
	if (kind === 'grid') {
		return container(id, 'grid', [], { cols: 2, rows: 2, basis: { fr: 1 }, align: 'stretch' });
	}
	return container(id, kind, [], { basis: { fr: 1 }, align: 'stretch' });
}

/** True when `id` resolves to a primitive widget leaf (not a container, group, or missing). */
function patchUnitExists(root: Container, id: string): boolean {
	const node = findNode(root, id);
	return !!node && isLeaf(node) && !isGroup(node.unit) && isWidgetInstance(node.unit);
}

/** The `binds` kind of the widget leaf `id`, or null if `id` isn't a primitive widget leaf. */
function leafBinds(root: Container, id: string): string | null {
	const node = findNode(root, id);
	if (!node || !isLeaf(node) || isGroup(node.unit)) return null;
	return getMeta(node.unit.type)?.binds ?? 'scalar';
}

function isWidgetInstance(u: unknown): u is WidgetInstance {
	return !!u && typeof u === 'object' && 'type' in (u as object) && 'config' in (u as object);
}
