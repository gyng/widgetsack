// widgetsack MCP server — lets an external agent (Claude Desktop / Claude Code / Cursor / ChatGPT
// developer-mode) read your widget catalog + sensors and EDIT your desktop layout, by reading and
// writing `widgets.json`. The running app's file watcher live-reloads the overlays on every write, so
// the agent's changes appear on the desktop within a moment — no app changes, no backend coupling.
//
// Transport: MCP stdio (newline-delimited JSON-RPC 2.0), hand-rolled so this needs ZERO dependencies.
// All layout mutation goes through the SAME validated op vocabulary the in-app AI assistant uses
// (src/mcp/tools.ts → core/llm.ts applyAssistantOps), so an agent can only emit real widget types,
// real sensors, and well-formed edits.
//
// Run: `npm run mcp` (i.e. `vite-node mcp/server.ts`). Point your MCP client at that command — see
// mcp/README.md. Override the layout file with WIDGETSACK_LAYOUT=/path/to/widgets.json.
//
// NOTE: stdout is the protocol channel — log ONLY to stderr.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import {
	applyOpsToFile,
	currentTheme,
	describeLayoutText,
	describeNowPlayingText,
	describeSensorsText,
	monitorKeys,
	sensorsText,
	setThemeInFile,
	widgetTypesText,
	type LayoutFile,
	type NowPlaying,
	type StateFile
} from '../src/mcp/tools';
import type { AssistantOp } from '../src/lib/core/llm';
import { readLayoutFile, writeLayoutFile } from './layoutFile';

// ---- widgets.json + live-state location + I/O ----

// Tauri app_config_dir = <config dir>/<identifier>. identifier = io.github.gyng (tauri.conf.json).
function configDir(): string {
	const base =
		process.env.APPDATA ??
		(process.platform === 'darwin'
			? path.join(os.homedir(), 'Library', 'Application Support')
			: path.join(os.homedir(), '.config'));
	return path.join(base, 'io.github.gyng');
}

function layoutPath(): string {
	return process.env.WIDGETSACK_LAYOUT ?? path.join(configDir(), 'widgets.json');
}

// The app mirrors live sensor values here every few seconds (sensors.rs write_state_snapshot).
function statePath(): string {
	return process.env.WIDGETSACK_STATE ?? path.join(configDir(), 'mcp', 'state.json');
}

/** For read-only tools: a missing or unreadable layout simply describes as empty. */
function readLayout(): LayoutFile | null {
	const read = readLayoutFile(layoutPath());
	return read.ok ? read.file : null;
}

/** For edits: only a missing file starts fresh. Throws (→ tool error) rather than replacing an
 *  unreadable or corrupt widgets.json with an empty layout. */
function readLayoutForEdit(): LayoutFile | null {
	const read = readLayoutFile(layoutPath());
	if (!read.ok) throw new Error(read.error);
	return read.file;
}

function readState(): StateFile {
	try {
		return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as StateFile;
	} catch {
		return null; // app not running / no snapshot yet
	}
}

// ---- opt-in agent-control server (media / HA actuation) ----

type Control = { url: string; token: string };

function readControl(): Control | null {
	try {
		const c = JSON.parse(fs.readFileSync(path.join(configDir(), 'mcp', 'control.json'), 'utf8'));
		// Validate the shape so a truncated/corrupt file funnels into the helpful "agent control is off"
		// path instead of a cryptic "Invalid URL".
		return c && typeof c.url === 'string' && typeof c.token === 'string' ? (c as Control) : null;
	} catch {
		return null; // agent control off / app not running
	}
}

/** Call the running app's local control server. Throws a helpful error if agent control is off. */
async function callControl(method: string, route: string, body?: unknown): Promise<unknown> {
	const ctl = readControl();
	if (!ctl) {
		throw new Error(
			'agent control is off — enable "Enable agent control" in the AI Provider settings (and Save), with the app running'
		);
	}
	const res = await fetch(ctl.url + route, {
		method,
		headers: {
			Authorization: `Bearer ${ctl.token}`,
			...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
		},
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	const txt = await res.text();
	let json: unknown = null;
	try {
		json = txt ? JSON.parse(txt) : null;
	} catch {
		json = null;
	}
	if (!res.ok) {
		const err =
			json && typeof json === 'object' && 'error' in json
				? String((json as { error: unknown }).error)
				: `HTTP ${res.status}`;
		throw new Error(err);
	}
	return json;
}

function listThemeNames(): string[] {
	try {
		return fs
			.readdirSync(path.join(configDir(), 'themes'))
			.filter((f) => f.endsWith('.css'))
			.map((f) => f.slice(0, -4))
			.sort();
	} catch {
		return [];
	}
}

function writeLayout(obj: LayoutFile): void {
	writeLayoutFile(layoutPath(), obj);
}

let idSeq = 0;
const makeId = (type: string): string =>
	`${type}-${(idSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---- tool definitions (JSON Schema) ----

const OPS_SCHEMA = {
	type: 'array',
	description: 'Edit operations, applied in order. Use list_widget_types + list_sensors first.',
	items: {
		oneOf: [
			{
				type: 'object',
				required: ['op', 'widgetType'],
				properties: {
					op: { const: 'addWidget' },
					widgetType: { type: 'string', description: 'a type from list_widget_types' },
					sensor: { type: 'string', description: 'a sensor id (only for sensor-binding types)' },
					config: {
						type: 'object',
						description: 'config keys for the type (e.g. {label,min,max})'
					},
					parent: { type: 'string', description: 'container id to nest into (omit for root)' }
				}
			},
			{
				type: 'object',
				required: ['op', 'id'],
				properties: { op: { const: 'removeWidget' }, id: { type: 'string' } }
			},
			{
				type: 'object',
				required: ['op', 'id', 'config'],
				properties: {
					op: { const: 'setConfig' },
					id: { type: 'string' },
					config: { type: 'object' }
				}
			},
			{
				type: 'object',
				required: ['op', 'id', 'sensor'],
				properties: {
					op: { const: 'setSensor' },
					id: { type: 'string' },
					sensor: { type: 'string' }
				}
			},
			{
				type: 'object',
				required: ['op', 'kind'],
				properties: {
					op: { const: 'addContainer' },
					kind: { enum: ['row', 'col', 'grid'] },
					parent: { type: 'string' }
				}
			},
			{ type: 'object', required: ['op'], properties: { op: { const: 'clear' } } }
		]
	}
};

const TOOLS = [
	{
		name: 'list_widget_types',
		description:
			'List every widget type that can be placed, with its config keys, whether it binds a sensor, and a one-line description. Read this before apply_layout_ops.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'list_sensors',
		description: 'List the bindable sensor ids (cpu/gpu/memory/network/…) a widget can show.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'read_sensors',
		description:
			"Read the LIVE system readings (CPU/GPU/memory/network/top-process/…) the running widgetsack app last reported — what's actually happening right now. Use this before building or adjusting widgets. Requires the app to be running.",
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'describe_layout',
		description:
			'Describe the current desktop layout: the monitor keys and, for each, the placed widgets (id, type, sensor, container).',
		inputSchema: {
			type: 'object',
			properties: { monitor: { type: 'string', description: 'a monitor key (omit for all)' } }
		}
	},
	{
		name: 'now_playing',
		description:
			'What media is currently playing (title / artist / status). Requires agent control enabled in settings.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'media_control',
		description:
			'Control media playback. Requires agent control enabled. action ∈ play|pause|playpause|next|previous; optional source = a media session id.',
		inputSchema: {
			type: 'object',
			required: ['action'],
			properties: {
				action: { enum: ['play', 'pause', 'playpause', 'next', 'previous'] },
				source: { type: 'string' }
			}
		}
	},
	{
		name: 'ha_call_service',
		description:
			'Call a Home Assistant service (requires agent control + HA configured). e.g. domain=light, service=turn_on, data={ "entity_id": "light.kitchen" }.',
		inputSchema: {
			type: 'object',
			required: ['domain', 'service'],
			properties: {
				domain: { type: 'string' },
				service: { type: 'string' },
				data: { type: 'object' }
			}
		}
	},
	{
		name: 'list_themes',
		description: 'List the available theme names and which one is currently active.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'set_theme',
		description:
			"Set the desktop's active theme by name (from list_themes), or pass an empty name to clear it. The running app applies it on reload.",
		inputSchema: {
			type: 'object',
			required: ['name'],
			properties: { name: { type: 'string', description: 'a theme name from list_themes' } }
		}
	},
	{
		name: 'apply_layout_ops',
		description:
			'Edit the desktop layout by applying a list of ops (addWidget/removeWidget/setConfig/setSensor/addContainer/clear). Writes widgets.json; the running app live-reloads the overlay. Only real widget types and sensors are accepted; invalid ops are reported, not applied.',
		inputSchema: {
			type: 'object',
			required: ['ops'],
			properties: {
				ops: OPS_SCHEMA,
				monitor: { type: 'string', description: 'monitor key to edit (omit = the first one)' }
			}
		}
	}
];

// ---- JSON-RPC plumbing ----

type Params = Record<string, unknown>;
type Rpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Params };
const NO_RESPONSE = Symbol('no-response');
const text = (t: string) => ({ content: [{ type: 'text', text: t }] });

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
	try {
		switch (name) {
			case 'list_widget_types':
				return text(widgetTypesText());
			case 'list_sensors':
				return text(sensorsText());
			case 'read_sensors':
				return text(describeSensorsText(readState()));
			case 'now_playing':
				return text(
					describeNowPlayingText((await callControl('GET', '/now_playing')) as NowPlaying[])
				);
			case 'media_control': {
				const action = String(args.action ?? '');
				await callControl('POST', '/media', { action, source: args.source });
				return text(`media: ${action} ✓`);
			}
			case 'ha_call_service': {
				const domain = String(args.domain ?? '');
				const service = String(args.service ?? '');
				await callControl('POST', '/ha', { domain, service, data: args.data ?? {} });
				return text(`Called ${domain}.${service} ✓`);
			}
			case 'list_themes': {
				const names = listThemeNames();
				const active = currentTheme(readLayout()) ?? '(none)';
				return text(
					`Themes: ${names.length ? names.join(', ') : '(none found)'}\nActive: ${active}`
				);
			}
			case 'set_theme': {
				const name = String(args.name ?? '');
				writeLayout(setThemeInFile(readLayoutForEdit(), name));
				return text(
					name.trim()
						? `Theme set to "${name.trim()}". The overlay applies it on reload.`
						: 'Theme cleared.'
				);
			}
			case 'describe_layout':
				return text(describeLayoutText(readLayout(), args.monitor as string | undefined));
			case 'apply_layout_ops': {
				const ops = (Array.isArray(args.ops) ? args.ops : []) as AssistantOp[];
				const { file, monitorKey, result } = applyOpsToFile(
					readLayoutForEdit(),
					ops,
					makeId,
					args.monitor as string | undefined
				);
				writeLayout(file);
				const issues = result.errors.length ? `\nIssues: ${result.errors.join('; ')}` : '';
				const added = result.addedIds.length ? result.addedIds.join(', ') : '(none)';
				return text(
					`Applied ${result.applied} op(s) to monitor "${monitorKey}". New ids: ${added}.${issues}\n\n` +
						describeLayoutText(file, monitorKey)
				);
			}
			default:
				return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
		}
	} catch (err) {
		return {
			content: [{ type: 'text', text: `Error: ${(err as Error).message ?? err}` }],
			isError: true
		};
	}
}

async function dispatch(method: string | undefined, params: Params | undefined): Promise<unknown> {
	switch (method) {
		case 'initialize':
			return {
				protocolVersion: (params?.protocolVersion as string) ?? '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'widgetsack', version: '0.1.0' }
			};
		case 'notifications/initialized':
			return NO_RESPONSE;
		case 'ping':
			return {};
		case 'tools/list':
			return { tools: TOOLS };
		case 'tools/call':
			return callTool((params?.name as string) ?? '', (params?.arguments as Params) ?? {});
		default: {
			const e = new Error(`method not found: ${method}`) as Error & { code?: number };
			e.code = -32601;
			throw e;
		}
	}
}

function send(obj: unknown): void {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handleLine(line: string): Promise<void> {
	const trimmed = line.trim();
	if (!trimmed) return;
	let msg: Rpc;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		return; // ignore non-JSON noise
	}
	const isNotification = msg.id === undefined || msg.id === null;
	try {
		const result = await dispatch(msg.method, msg.params);
		if (!isNotification && result !== NO_RESPONSE) {
			send({ jsonrpc: '2.0', id: msg.id, result });
		}
	} catch (err) {
		const e = err as Error & { code?: number };
		if (!isNotification) {
			send({
				jsonrpc: '2.0',
				id: msg.id,
				error: { code: e.code ?? -32603, message: e.message ?? String(err) }
			});
		}
	}
}

process.stderr.write(`[widgetsack-mcp] layout file: ${layoutPath()}\n`);
process.stderr.write(
	`[widgetsack-mcp] monitors: ${monitorKeys(readLayout()).join(', ') || '(none yet)'}\n`
);

const rl = createInterface({ input: process.stdin });
rl.on('line', (l) => void handleLine(l));
rl.on('close', () => process.exit(0));
