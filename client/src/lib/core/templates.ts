// Built-in layout templates ("presets"): the author's `gyng\*` desktop skins recreated as
// RESPONSIVE FLOW GROUPS. Each template is a flow TREE (row/col + basis + halign) that becomes a
// reusable WidgetDef (one draggable group) when dropped from the studio — so the layout hugs/fills
// instead of being pinned to fixed pixel rects. Framework-agnostic and pure (no Svelte/Tauri), so
// it's testable and reusable; node ids here are template-local and are remapped to fresh ids on
// insert (useEditorModel.templateDef).

import type {
	AlignH,
	Container,
	LayoutNode,
	Leaf,
	Length,
	Pad,
	ParamSpec,
	WidgetInstance
} from './layoutTree';
import { container, group, isContainer, isGroup, leaf } from './layoutTree';
import { applyParams } from './solve';
import { NOWPLAYING_DEFAULT_CSS, createWidget } from './widget';
import { dashboardMetas } from './dashboardMetas';
import { aiUsageTemplates } from './aiUsageTemplates';
import { LOCAL_DESKTOP_DEF } from './localDesktop';

const rand = (): string => Math.random().toString(36).slice(2, 8);

// A primitive widget instance. `rect` is the leaf's stored box — it's the slot size for an 'auto'/
// 'content' FILL meter (gauge/sparkline/analogclock) and a fallback; intrinsic text meters on
// 'content' ignore it and shrink-wrap their text instead (flowStyle).
const prim = (
	id: string,
	type: string,
	config: Record<string, unknown> = {},
	opts: { sensor?: string; css?: string; w?: number; h?: number } = {}
): WidgetInstance => ({
	id,
	type,
	/* v8 ignore next -- built-in templates always provide their reviewed size. */
	rect: { x: 0, y: 0, w: opts.w ?? 100, h: opts.h ?? 24 },
	config,
	...(opts.sensor ? { sensor: opts.sensor } : {}),
	...(opts.css ? { css: opts.css } : {})
});

// Wrap a primitive as a flow leaf with an optional main-axis basis + horizontal placement, plus an
// optional per-side box (outer `margin` between this leaf and its flow siblings, inner `pad`).
const lf = (
	unit: WidgetInstance,
	basis: Length,
	halign?: AlignH,
	box?: { margin?: Pad; pad?: Pad }
): Leaf => ({
	id: unit.id,
	unit,
	basis,
	/* v8 ignore next -- current built-ins either provide a concrete alignment or omit the field. */
	...(halign ? { halign } : {}),
	/* v8 ignore next -- optional box sides are only emitted when a built-in defines them. */
	...(box?.margin !== undefined ? { margin: box.margin } : {}),
	/* v8 ignore next -- optional box sides are only emitted when a built-in defines them. */
	...(box?.pad !== undefined ? { pad: box.pad } : {})
});

// gyng\DateTime (+ the Enigma analog icon on top, as in the saved layout): a small clock icon, the
// time, the weekday glyph, and a "D MMMM" date row. Text leaves use basis 'content' so each hugs its
// own text (the date "5" + month "JUNE" sit adjacent); the icon is a fixed square with a bottom margin
// so it sits clear of the time. The tree bakes the DEFAULTS (ja weekday, en date, 24-hour "HHmm" →
// "1700 / 火 / 5 JUNE"); the languages + time format are PARAMS (ParamSpec, below) applied onto the
// built tree via the same applyParams mechanism library defs use — so a template cloned into the
// library keeps its options, switchable per instance.
function clockTree(): Container {
	const weekdayLang = 'ja';
	const dateLang = 'en';
	const time = 'HHmm';
	return container(
		'dt-root',
		'col',
		[
			lf(
				prim(
					'dt-icon',
					'analogclock',
					{ showSeconds: true, showTicks: false, showNumbers: false, showCap: false, lineWidth: 2 },
					{ w: 30, h: 30 }
				),
				'content',
				'left',
				{ margin: { t: 0, r: 0, b: 8, l: 0 } }
			),
			lf(prim('dt-time', 'clock', { format: time }, { w: 150, h: 34 }), 'content'),
			lf(
				prim('dt-day', 'clock', { format: 'ddd', locale: weekdayLang }, { w: 60, h: 34 }),
				'content'
			),
			container(
				'dt-date-row',
				'row',
				[
					lf(
						prim('dt-date', 'clock', { format: 'D', locale: dateLang }, { w: 30, h: 22 }),
						'content'
					),
					lf(
						prim(
							'dt-month',
							'clock',
							{ format: 'MMMM', locale: dateLang },
							{ w: 100, h: 22, css: 'text-transform: uppercase;' }
						),
						'content'
					)
				],
				{ align: 'end', gap: 6, basis: 'content' }
			)
		],
		{ align: 'stretch', gap: 2 }
	);
}

// gyng\System: CPU/RAM/SWAP on one row, GPU/VRAM on the next, then the per-core CPU widget (its own
// 8-wide sparkline grid) filling the rest. Each value cell grows to an equal share of its row.
function systemTree(showSparklines = false): Container {
	const val = (id: string, label: string, sensor: string): Leaf =>
		lf(
			prim(
				id,
				'text',
				{
					label,
					format: 'integer',
					showSparkline: showSparklines,
					sparklineWidth: 28,
					sparklineSeconds: 60,
					sparklineScale: 'percent',
					sparklineSmooth: true
				},
				{
					sensor,
					w: 50,
					h: showSparklines ? 24 : 16,
					css: showSparklines
						? '.np-text { display: grid; grid-template-columns: var(--system-label-width, 44px) var(--system-value-width, 32px) minmax(0, 1fr); column-gap: var(--system-column-gap, 4px); }\n.np-text .label { white-space: nowrap; }\n.np-text .value { min-width: 0; text-align: right; white-space: nowrap; }'
						: undefined
				}
			),
			{ fr: 1 }
		);
	return container(
		'sys-root',
		'col',
		[
			container(
				'sys-row1',
				'row',
				[
					val('sys-cpu', 'CPU', 'cpu.total'),
					val('sys-ram', 'RAM', 'mem.used'),
					val('sys-swap', 'SWAP', 'swap.used')
				],
				{
					gap: 6,
					basis: 'content'
				}
			),
			container(
				'sys-row2',
				'row',
				[
					val('sys-gpu', 'GPU', 'gpu.util'),
					val('sys-vram', 'VRAM', 'gpu.vram'),
					// Empty third column so VRAM sits under RAM (col 2 of 3), matching the CPU/RAM/SWAP row.
					container('sys-row2-pad', 'col', [], { basis: { fr: 1 } })
				],
				{ gap: 6, basis: 'content' }
			),
			// Per-core lines: thin, foreground-coloured (no baked literal → follows --np-fg / the active
			// theme), short window + rounded joins to match the classic LINE meters. `cols: 8` → 8 cores
			// per row (the System skin's grid), wrapping as needed. A top margin clears the number row above.
			lf(
				prim(
					'sys-cores',
					'cpu',
					{ mode: 'cores', cols: 8, seconds: 20, lineWidth: 1, smooth: showSparklines },
					{ w: 150, h: 70 }
				),
				{ fr: 1 },
				undefined,
				{ margin: { t: showSparklines ? 4 : 8, r: 0, b: 0, l: 0 } }
			)
		],
		{ align: 'stretch', gap: 4 }
	);
}

// gyng\Network: out (cyan ▲) over in (mint ▼) throughput histograms — FIXED-height rows so the
// cluster never shifts vertically — then a rate row (up left, down right). Each rate cell is a fixed
// fr half with tabular digits, the up value right-anchored + the down value left-anchored, so the
// numbers grow OUTWARD from the centre arrows and never shove the layout as the magnitude changes.
const HIST_H = 60; // fixed histogram row height (px)
const HIST_GAP = 4; // margin between the up + down histograms
const HIST_TEXT_GAP = 8; // margin between the histogram cluster and the rate text row
const RATE_H = 18; // the rate-text row height (the leaf hint + line-height headroom)
const HIST_SECONDS = 90; // 1.5× the default 60s window — the histograms retain more history
// The template's def box must fit the stacked content (two fixed histograms + their margins + the
// rate row), else the bottom rows clip. Derived from the constants so it can't drift when they change.
const NETWORK_H = HIST_H * 2 + HIST_GAP + HIST_TEXT_GAP + RATE_H; // 150
function networkTree(): Container {
	const rate = (
		id: string,
		label: string,
		sensor: string,
		color: string,
		alignEnd: boolean
	): Leaf =>
		lf(
			prim(
				id,
				'text',
				{ format: 'rate', label, color },
				{
					sensor,
					w: 75,
					h: RATE_H,
					// This legacy 170px instrument has intentionally small, fixed readouts. The
					// wider inline preset inherits density tokens instead.
					css: `.np-text { gap: 4px; justify-content: ${alignEnd ? 'flex-end' : 'flex-start'}; }
.np-text .label { font-size: 11px; }
.np-text.rate .value { font-size: 12px; }`
				}
			),
			{ fr: 1 }
		);
	return container(
		'net-root',
		'col',
		[
			lf(
				prim(
					'net-up',
					'sparkline',
					{ histogram: true, min: 0, seconds: HIST_SECONDS, color: 'var(--np-accent)' },
					{ sensor: 'net.up', w: 150, h: HIST_H }
				),
				HIST_H,
				undefined,
				{ margin: { t: 0, r: 0, b: HIST_GAP, l: 0 } }
			),
			lf(
				prim(
					'net-down',
					'sparkline',
					{ histogram: true, min: 0, seconds: HIST_SECONDS, color: 'var(--np-label)' },
					{ sensor: 'net.down', w: 150, h: HIST_H }
				),
				HIST_H,
				undefined,
				{ margin: { t: 0, r: 0, b: HIST_TEXT_GAP, l: 0 } }
			),
			container(
				'net-rates',
				'row',
				[
					rate('net-up-txt', '▲', 'net.up', 'var(--np-accent)', true), // up: left cell, right-anchored
					rate('net-down-txt', '▼', 'net.down', 'var(--np-label)', false) // down: right cell, left-anchored
				],
				{ gap: 6, basis: 'content' }
			)
		],
		// Inter-row spacing comes from the histograms' own bottom margins (HIST_GAP, HIST_TEXT_GAP)
		// so the two gaps differ; the root col adds none of its own.
		{ align: 'stretch', gap: 0 }
	);
}

function inlineNetworkTree(): Container {
	const css = `.np-text { display: grid; font-size: var(--np-text-body, 14px); grid-template-columns: 0.8em 7ch minmax(24px, 1fr); column-gap: 4px; }
.np-text.rate .value { font-size: inherit; min-width: 0; text-align: left; white-space: nowrap; }`;
	return container(
		'net-inline',
		'row',
		[
			lf(
				prim(
					'net-inline-down',
					'text',
					{
						label: '▼',
						format: 'rate-short',
						color: 'var(--np-label)',
						showSparkline: true,
						sparklineSeconds: 90,
						sparklineWidth: 32,
						sparklineStretch: true,
						sparklineSmooth: true,
						sparklineScale: 'auto'
					},
					{ sensor: 'net.down', w: 174, h: 28, css }
				),
				{ fr: 1 },
				undefined,
				{ margin: { t: 0, r: 18, b: 0, l: 0 } }
			),
			lf(
				prim(
					'net-inline-up',
					'text',
					{
						label: '▲',
						format: 'rate-short',
						color: 'var(--np-accent)',
						showSparkline: true,
						sparklineSeconds: 90,
						sparklineWidth: 32,
						sparklineStretch: true,
						sparklineSmooth: true,
						sparklineScale: 'auto'
					},
					{ sensor: 'net.up', w: 174, h: 28, css }
				),
				{ fr: 1 },
				undefined,
				{ margin: { t: 0, r: 0, b: 0, l: 18 } }
			)
		],
		// 48px between readings: 12px row gap + balanced 18px inner margins.
		// Keep the gap below the short-row spacing guard without increasing its height.
		{ gap: 12, align: 'center' }
	);
}

// gyng\Music: the now-playing widget (cover above title/artist), seeded with the default editable css.
function musicLeaf(): Leaf {
	return lf(prim('np', 'nowplaying', {}, { w: 180, h: 200, css: NOWPLAYING_DEFAULT_CSS }), {
		fr: 1
	});
}

export type Template = {
	id: string;
	name: string;
	description: string;
	size: { w: number; h: number }; // the group def's canvas size
	/** The template's configurable options as library ParamSpecs (select specs carry
	 * `choices` + a `default` + a dotted `target`/`targets` path into the tree). ONE spec drives both
	 * the insert-time options form AND the params of a def cloned from the template (newFromTemplate),
	 * so a cloned clock still switches 12/24-hour per instance. Absent → a one-click insert. */
	params?: ParamSpec[];
	/** The flow tree (the def's child) with the params' DEFAULTS baked in. Template-local ids;
	 * remapped to fresh ids on insert. Options apply on top via applyParams (instantiateTemplate). */
	tree: () => LayoutNode;
};

// The three clock languages, reused for both the weekday and the date selects.
const CLOCK_LANGS: NonNullable<ParamSpec['choices']> = [
	{ value: 'en', label: 'English' },
	{ value: 'ja', label: '日本語' },
	{ value: 'zh', label: '中文' }
];

// Every hour-width × separator combination as one select: the chosen VALUE is the literal dayjs
// format written to the time clock's `config.format` (a param value must be path-assignable data —
// the old hour+separator pair composed the format in code, which a serialized ParamSpec can't do).
const TIME_CHOICES: NonNullable<ParamSpec['choices']> = [
	{ value: 'HHmm', label: '24-hour · 1700' },
	{ value: 'HH:mm', label: '24-hour · 17:00' },
	{ value: 'HH.mm', label: '24-hour · 17.00' },
	{ value: 'hmm A', label: '12-hour · 500 PM' },
	{ value: 'h:mm A', label: '12-hour · 5:00 PM' },
	{ value: 'h.mm A', label: '12-hour · 5.00 PM' }
];

// Param targets are INDEX paths into clockTree's structure (children.1 = dt-time, children.2 =
// dt-day, children.3 = the date row holding dt-date + dt-month). Index paths survive the fresh-id
// remap on insert/clone, which id-based paths would not. templates.test.ts pins each one to the
// node it must hit, so a clockTree reshuffle fails the suite instead of silently no-op'ing.
const CLOCK_PARAMS: ParamSpec[] = [
	{
		key: 'time',
		label: 'Time',
		default: 'HHmm',
		target: 'children.1.unit.config.format',
		choices: TIME_CHOICES
	},
	{
		key: 'weekdayLang',
		label: 'Weekday',
		default: 'ja',
		target: 'children.2.unit.config.locale',
		choices: CLOCK_LANGS
	},
	{
		key: 'dateLang',
		label: 'Date',
		default: 'en',
		// One language drives BOTH the day-of-month and the month name (they form one phrase).
		targets: [
			'children.3.children.0.unit.config.locale',
			'children.3.children.1.unit.config.locale'
		],
		choices: CLOCK_LANGS
	}
];

export const TEMPLATES: Template[] = [
	...aiUsageTemplates,
	{
		id: 'local-desktop',
		name: 'Local desktop',
		description: 'Clock, media, network, dynamic CPU core charts, and automatic monitor inputs',
		size: LOCAL_DESKTOP_DEF.size,
		tree: () => structuredClone(LOCAL_DESKTOP_DEF.child)
	},
	...dashboardMetas.map((meta) => ({
		id: `dashboard-widget-${meta.type}`,
		name: meta.label!,
		description: meta.description!,
		size: meta.defaultSize!,
		tree: () => leaf(createWidget(meta.type, `template-${meta.type}`))
	})),
	{
		id: 'ai-assistant',
		name: 'AI Chat',
		description: 'Chat with your configured AI provider',
		size: { w: 360, h: 300 },
		tree: () => leaf(prim('ai-chat', 'aichat', { label: 'AI Chat' }, { w: 360, h: 300 }))
	},
	{
		id: 'ai-prompt',
		name: 'AI Prompt',
		description: 'A saved sensor prompt refreshed every 10 minutes; supports cron or manual runs',
		size: { w: 280, h: 96 },
		tree: () =>
			leaf(
				prim(
					'ai-prompt',
					'assistant',
					{
						prompt: 'Summarize my system status in one short, friendly sentence.',
						schedule: '10m',
						sensors: 'auto',
						speak: false,
						label: 'AI Prompt'
					},
					{ w: 280, h: 96 }
				)
			)
	},
	{
		id: 'cli-command',
		name: 'CLI Command',
		description: 'Run a PowerShell command and see its output',
		size: { w: 360, h: 220 },
		tree: () =>
			leaf(
				prim('cli-command', 'command', { label: 'CLI Command', command: '' }, { w: 360, h: 220 })
			),
		params: [
			{ key: 'command', label: 'PowerShell command', default: '', target: 'unit.config.command' }
		]
	},
	{
		id: 'clock-jp',
		name: 'Clock (JP weekday)',
		description: 'Analog icon · time · weekday · date (configurable)',
		size: { w: 170, h: 150 },
		params: CLOCK_PARAMS,
		tree: clockTree
	},
	{
		id: 'system',
		name: 'System monitor',
		description: 'CPU, memory, and GPU readings with a chart for each CPU core.',
		size: { w: 170, h: 140 },
		params: [
			{
				key: 'smooth',
				label: 'Smooth charts',
				default: false,
				target: 'children.2.unit.config.smooth',
				choices: [
					{ value: 'false', label: 'Off' },
					{ value: 'true', label: 'On' }
				]
			}
		],
		tree: systemTree
	},
	{
		id: 'system-inline',
		name: 'System monitor · Inline',
		description:
			'CPU, memory, GPU and VRAM values with optional inline sparklines and per-core charts.',
		size: { w: 360, h: 140 },
		params: [
			{
				key: 'showSparklines',
				label: 'Inline sparklines',
				default: true,
				targets: [
					'children.0.children.0.unit.config.showSparkline',
					'children.0.children.1.unit.config.showSparkline',
					'children.0.children.2.unit.config.showSparkline',
					'children.1.children.0.unit.config.showSparkline',
					'children.1.children.1.unit.config.showSparkline'
				],
				choices: [
					{ value: 'true', label: 'On' },
					{ value: 'false', label: 'Off' }
				]
			},
			{
				key: 'smooth',
				label: 'Smooth charts',
				default: true,
				targets: [
					'children.0.children.0.unit.config.sparklineSmooth',
					'children.0.children.1.unit.config.sparklineSmooth',
					'children.0.children.2.unit.config.sparklineSmooth',
					'children.1.children.0.unit.config.sparklineSmooth',
					'children.1.children.1.unit.config.sparklineSmooth',
					'children.2.unit.config.smooth'
				],
				choices: [
					{ value: 'true', label: 'On' },
					{ value: 'false', label: 'Off' }
				]
			}
		],
		tree: () => systemTree(true)
	},
	{
		id: 'network',
		name: 'Network',
		description: 'Upload and download charts with current transfer rates.',
		size: { w: 170, h: NETWORK_H },
		params: [
			{
				key: 'smooth',
				label: 'Smooth charts',
				default: false,
				targets: ['children.0.unit.config.smooth', 'children.1.unit.config.smooth'],
				choices: [
					{ value: 'false', label: 'Off' },
					{ value: 'true', label: 'On' }
				]
			}
		],
		tree: networkTree
	},
	{
		id: 'network-inline',
		name: 'Network · Inline',
		description: 'Download and upload rates with optional inline sparklines on one row.',
		size: { w: 360, h: 28 },
		params: [
			{
				key: 'showSparklines',
				label: 'Inline sparklines',
				default: true,
				targets: ['children.0.unit.config.showSparkline', 'children.1.unit.config.showSparkline'],
				choices: [
					{ value: 'true', label: 'On' },
					{ value: 'false', label: 'Off' }
				]
			},
			{
				key: 'smooth',
				label: 'Smooth charts',
				default: true,
				targets: [
					'children.0.unit.config.sparklineSmooth',
					'children.1.unit.config.sparklineSmooth'
				],
				choices: [
					{ value: 'true', label: 'On' },
					{ value: 'false', label: 'Off' }
				]
			}
		],
		tree: inlineNetworkTree
	},
	{
		id: 'nowplaying',
		name: 'Now playing',
		description: 'Compact media widget',
		size: { w: 180, h: 200 },
		tree: musicLeaf
	}
];

// ---- template registry (groups) ---------------------------------------------------------------
// The Add palette + widget designer used to read the TEMPLATES const directly; third-party plugin
// packages contribute their own template lists at runtime, so consumers now go through this small
// registry seam instead. The built-ins are the first (immutable) group — with nothing registered,
// listTemplateGroups() is exactly [{ group: 'Built-in', templates: TEMPLATES }], so built-in
// behavior is unchanged. Framework-agnostic: a plain subscribe/list pair (the widgets layer wraps
// it in useSyncExternalStore via useTemplateGroups).

export type TemplateGroup = { group: string; templates: Template[] };

/** The built-in templates' group name (always present, always first, never unregisterable). */
export const BUILTIN_TEMPLATE_GROUP = 'Built-in';

type RegisteredTemplateGroup = { label: string; templates: Template[] };

const templateGroups = new Map<string, RegisteredTemplateGroup>([
	[BUILTIN_TEMPLATE_GROUP, { label: BUILTIN_TEMPLATE_GROUP, templates: TEMPLATES }]
]);
const templateListeners = new Set<() => void>();
// Cached list identity so useSyncExternalStore sees a stable snapshot between changes.
let templateSnapshot: TemplateGroup[] | null = null;

function notifyTemplates(): void {
	templateSnapshot = null;
	for (const listener of templateListeners) listener();
}

/** Register (or replace) a template group by stable identity. `label` is only its palette heading,
 * so two plugin packages may share a display name without replacing each other's templates. */
export function registerTemplates(id: string, list: Template[], label = id): void {
	if (id === BUILTIN_TEMPLATE_GROUP) return;
	templateGroups.set(id, { label, templates: list.slice() });
	notifyTemplates();
}

/** Remove a registered template group (no-op for the built-ins / an unknown group). */
export function unregisterTemplates(id: string): void {
	if (id === BUILTIN_TEMPLATE_GROUP) return;
	if (templateGroups.delete(id)) notifyTemplates();
}

/** Every template group, built-ins first then registration order. Stable identity between changes. */
export function listTemplateGroups(): TemplateGroup[] {
	if (!templateSnapshot) {
		templateSnapshot = Array.from(templateGroups.values(), ({ label, templates }) => ({
			group: label,
			templates
		}));
	}
	return templateSnapshot;
}

/** Subscribe to registry changes (register/unregister); returns the unsubscribe. */
export function subscribeTemplates(listener: () => void): () => void {
	templateListeners.add(listener);
	return () => {
		templateListeners.delete(listener);
	};
}

/** Find a template by id across every registered group (built-ins first). */
export function getTemplate(id: string): Template | undefined {
	for (const { templates } of templateGroups.values()) {
		const t = templates.find((tpl) => tpl.id === id);
		if (t) return t;
	}
	return undefined;
}

/** Fill a partial option map with each template param's default, dropping unknown keys and any value
 * that isn't one of the param's choices. Pure — drives both the picker's initial state and the
 * insert. A template with no params resolves to `{}`. */
export function resolveTemplateOptions(
	t: Template,
	partial: Record<string, string> = {}
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const p of t.params ?? []) {
		const v = partial[p.key];
		out[p.key] =
			v !== undefined && (!p.choices || p.choices.some((c) => c.value === v))
				? v
				: String(p.default ?? '');
	}
	return out;
}

/** Build the template's tree with `options` applied: fresh defaults-baked tree + applyParams over the
 * validated option map — the SAME write path resolveGroup uses for def instance params, so insert-time
 * options and library params can never drift. Returns template-local ids (remap via freshIds). */
export function instantiateTemplate(t: Template, options?: Record<string, string>): LayoutNode {
	const tree = t.tree(); // a fresh tree each call — safe to write params onto
	return applyParams(tree, t.params, resolveTemplateOptions(t, options));
}

/** Deep-clone a flow tree (group children included) with fresh, unique node/unit ids. Template-local ids are stable, so two
 * inserts/defs from the same template must not share ids; leaf id mirrors its unit id (leaf()
 * invariant). Pure (modulo Math.random for the ids). */
export function freshIds(node: LayoutNode): LayoutNode {
	if (isContainer(node)) {
		return { ...node, id: `${node.kind}-${rand()}`, children: node.children.map(freshIds) };
	}
	// A group's inline child is remapped too: instances share it, so ungrouping must not repeat ids.
	const unit = isGroup(node.unit)
		? { ...node.unit, id: `group-${rand()}`, child: freshIds(node.unit.child) }
		: { ...node.unit, id: `${node.unit.type}-${rand()}` };
	return { ...node, id: unit.id, unit };
}

/** The primary monitor's first-run demo layout: the actual `system` / `network` / `nowplaying`
 * templates instantiated as floating self-contained groups (the templates ARE the default skin —
 * one source of truth, no hand-built copy to drift), plus a small interactive demo button. Fresh
 * ids per call. */
export function demoSeed(): Leaf[] {
	const place = (templateId: string, x: number, y: number): Leaf => {
		const t = getTemplate(templateId);
		/* v8 ignore next -- demoSeed names only statically registered built-in templates. */
		if (!t) throw new Error(`built-in template ${templateId} missing`);
		const g = group(`grp-${rand()}`, { ...t.size }, freshIds(instantiateTemplate(t)), {
			name: t.name,
			config: { x, y } // a floating group's anchor lives in its config
		});
		return leaf(g);
	};
	const button: WidgetInstance = {
		id: `button-${rand()}`,
		type: 'button',
		rect: { x: 16, y: 310, w: 90, h: 44 },
		config: { label: 'tap' },
		interactive: true
	};
	return [
		place('system', 16, 16),
		place('network', 16, 176),
		place('nowplaying', 210, 16),
		leaf(button)
	];
}
