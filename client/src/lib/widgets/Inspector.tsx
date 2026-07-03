// Editor inspector (edit mode): a palette to add widgets, plus a properties panel for
// the selected node — widget props (sensor / rect / config / dock·float) or container
// props (kind / cols / gap / pad / align / justify / grow). Emits a single `op` event;
// all state + persistence lives in Canvas.
import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type DragEvent as ReactDragEvent
} from 'react';
import type {
	Align,
	AlignH,
	AlignV,
	Container,
	Group,
	Justify,
	LayoutNode,
	Leaf,
	Length,
	Rect,
	WidgetDef,
	WidgetInstance
} from '../core/layoutTree';
import { getMeta } from '../core/widget';
import type { ConfigField } from '../core/widget';
import { toYaml } from '../core/yaml';
import { normalizeMacro } from '../core/macro';
import MacroEditor from './MacroEditor';
import MonitorSourcesEditor from './meters/MonitorSourcesEditor';
import WidgetPreview from './WidgetPreview';
import CssEditor from './CssEditor';
import BoxField from './BoxField';
import Select, { type SelectOption } from './Select';
import { BUILTIN_TEMPLATE_GROUP, resolveTemplateOptions, type Template } from '../core/templates';
import { useTemplateGroups } from './useTemplateGroups';
import { exprRefs, templateRefs } from '../core/textTemplate';
import type { LayoutOp } from './ops';
import { clampSpacing, maxGap, maxPad } from './canvas/spacingGuard';
import { containerAlignControls, LEAF_H_OPTIONS, LEAF_V_OPTIONS } from './canvas/alignControls';
import TokenFields from './TokenFields';
import ConditionEditor from './ConditionEditor';
import './Inspector.css';

// Group palette entries by `category` in first-seen order, uncategorized last under "Other".
// Pure (exported for tests): order within a group is registration order, same as before grouping.
export type PaletteEntry = { type: string; label: string; category?: string };
export function groupPalette(items: PaletteEntry[]): { category: string; items: PaletteEntry[] }[] {
	const groups = new Map<string, PaletteEntry[]>();
	for (const it of items) {
		const key = it.category ?? 'Other';
		const list = groups.get(key);
		if (list) list.push(it);
		else groups.set(key, [it]);
	}
	const ordered = Array.from(groups.entries()).map(([category, list]) => ({
		category,
		items: list
	}));
	// "Other" sinks to the end regardless of when the first uncategorized entry appeared.
	return ordered.sort((a, b) => Number(a.category === 'Other') - Number(b.category === 'Other'));
}

type Props = {
	widget?: WidgetInstance | null;
	container?: Container | null;
	groupUnit?: Group | null;
	def?: WidgetDef | null; // the selected group's def (for params)
	defs?: WidgetDef[]; // the whole library (for insert / delete)
	tokens?: Record<string, string>; // global token overrides (7d)
	// Manual-save baseline (item 2): the selected node / tokens as they were at the last save, so
	// changed fields can be flagged. `baseTokens === null` = no baseline (overlay / nothing saved);
	// `nodeIsNew` = the selected node didn't exist at the last save → all its fields read dirty.
	baseWidget?: WidgetInstance | null;
	baseContainer?: Container | null;
	baseGroup?: Group | null;
	baseTokens?: Record<string, string> | null;
	nodeIsNew?: boolean;
	isGridCell?: boolean; // the selected container is a grid cell → show cell sizing fields
	containerBox?: Rect | null; // the selected container's solved box — caps pad/gap to it (guardrail)
	placement?: 'flow' | 'floating' | null;
	widgetBasis?: Length; // the selected in-flow leaf's main-axis basis (drives the grow toggle)
	widgetHalign?: AlignH; // the selected leaf's horizontal placement within its box (default 'fill')
	widgetValign?: AlignV; // the selected leaf's vertical placement within its box (default 'fill')
	// In the studio this docks as the full-height right rail (vs a floating box on an overlay).
	docked?: boolean;
	widgetTypes?: { type: string; label: string; category?: string }[]; // palette (8a)
	configFields?: ConfigField[]; // typed config schema for the selected widget (8a)
	sensors?: string[];
	// Optional id → display metadata, so HA (and other) sensor ids show a friendly label + unit in
	// the dropdown instead of the raw id. Missing entries just render the bare id.
	sensorMeta?: Record<string, { label?: string; unit?: string }>;
	// Runtime options for a `catalog:'audioOutputs'` select field (the spectrum widget's device picker).
	audioOutputs?: { id: string; name: string }[];
	// Runtime options for a `catalog:'microphones'` select (the transcribe widget's mic picker).
	microphones?: { id: string; name: string }[];
	// Runtime options for a `catalog:'displayNames'` select (the monitor-switch widget's monitor
	// picker). `id` is the GDI device name (\\.\DISPLAYn), `name` the friendly/EDID label.
	displayNames?: { id: string; name: string }[];
	onOp?: (op: LayoutOp) => void;
	// Deleting a library def from the Inspector routes through the container (which checks whether the
	// def is in use and explains the block, matching the Widget-designer list) instead of the reducer's
	// silent no-op. Falls back to a plain `deleteDef` op when not provided (e.g. the overlay).
	onDeleteDef?: (defId: string, name: string) => void;
	// Jump to the widget designer's read-only preview of a built-in template (the 👁 buttons in the
	// Templates palette). Supplied by the studio Canvas (useDefEditor.previewTemplate); absent on an
	// overlay, where there is no designer to jump to.
	onPreviewTemplate?: (templateId: string) => void;
	// The full selected node (Leaf or Container), for the "Data" tab's JSON/YAML representation — a
	// structured, agent-friendly view that can be edited and applied back via the `replaceNode` op.
	node?: LayoutNode | null;
	// Copy helper supplied by the container (keeps the Tauri clipboard adapter out of this component).
	onCopy?: (text: string) => void;
};

const RECT_KEYS = ['x', 'y', 'w', 'h'] as const;

// --- dirty-field tracking (item 2): the set of field keys that differ from the saved baseline.
// A `label`/field marks itself dirty via `dirtyKeys.has('<key>')`. Keys: sensor, rect.<x|y|w|h>,
// config.<key>, css, kind/cols/rows/gap/pad/align/justify/basis, name, param.<key>, token.<key>.
const ne = (a: unknown, b: unknown): boolean =>
	JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
function computeDirty(
	w: WidgetInstance | null,
	c: Container | null,
	g: Group | null,
	tk: Record<string, string>,
	bw: WidgetInstance | null,
	bc: Container | null,
	bg: Group | null,
	btk: Record<string, string> | null,
	isNew: boolean
): Set<string> {
	const d = new Set<string>();
	if (w) {
		const b = isNew ? null : bw;
		if (!b || ne(w.sensor, b.sensor)) d.add('sensor');
		for (const k of RECT_KEYS) if (!b || w.rect[k] !== b.rect[k]) d.add('rect.' + k);
		const keys = new Set([...Object.keys(w.config ?? {}), ...Object.keys(b?.config ?? {})]);
		for (const k of keys) if (!b || ne(w.config?.[k], b.config?.[k])) d.add('config.' + k);
		if (!b || ne(w.css, b.css)) d.add('css');
	}
	if (c) {
		const b = isNew ? null : bc;
		if (!b || ne(c.kind, b.kind)) d.add('kind');
		if (!b || ne(c.cols, b.cols)) d.add('cols');
		if (!b || ne(c.rows, b.rows)) d.add('rows');
		if (!b || ne(c.gap, b.gap)) d.add('gap');
		if (!b || ne(c.pad, b.pad)) d.add('pad');
		if (!b || ne(c.margin, b.margin)) d.add('margin');
		if (!b || ne(c.align, b.align)) d.add('align');
		if (!b || ne(c.justify, b.justify)) d.add('justify');
		if (!b || ne(c.basis, b.basis)) d.add('basis');
		if (!b || !!c.overlap !== !!b.overlap) d.add('overlap');
		if (!b || ne(c.cellW, b.cellW)) d.add('cellW');
		if (!b || ne(c.cellH, b.cellH)) d.add('cellH');
		if (!b || ne(c.aspect, b.aspect)) d.add('aspect');
		if (!b || ne(c.condition, b.condition)) d.add('condition');
	}
	if (g) {
		const b = isNew ? null : bg;
		if (!b || ne(g.name, b.name)) d.add('name');
		if (!b || ne(g.css, b.css)) d.add('css');
		const keys = new Set([...Object.keys(g.params ?? {}), ...Object.keys(b?.params ?? {})]);
		for (const k of keys) if (!b || ne(g.params?.[k], b.params?.[k])) d.add('param.' + k);
	}
	if (btk) {
		const keys = new Set([...Object.keys(tk), ...Object.keys(btk)]);
		for (const k of keys) if ((tk[k] ?? '') !== (btk[k] ?? '')) d.add('token.' + k);
	}
	return d;
}

// String / boolean views of a config value (avoids `as` casts in the template).
const cfgStr = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
const cfgBool = (v: unknown): boolean => !!v;

// Authoring aid under a formula field: lists the sensors it references and flags any that aren't in
// the known catalog (a typo, or a sensor not present on this machine) with a `?`. Pure — no engine.
function ExprHint({
	src,
	result,
	known
}: {
	src: string;
	result: 'number' | 'text';
	known: string[];
}) {
	if (!src.trim()) return null;
	const refs = result === 'text' ? templateRefs(src) : exprRefs(src);
	if (refs.length === 0) return null;
	const live = new Set(known);
	return (
		<small className="field-help cfg-expr-refs">
			sensors:{' '}
			{refs.map((r, i) => (
				<span key={r} className={live.has(r) ? undefined : 'unknown'}>
					{i > 0 ? ', ' : ''}
					{r}
					{live.has(r) ? '' : ' ?'}
				</span>
			))}
		</small>
	);
}
// Whether a basis means "grow/stretch along the parent's main axis" (an `fr` length).
const isFrBasis = (b?: Length): boolean => typeof b === 'object' && b !== null && 'fr' in b;

// A small "jump to the designer's read-only preview" affordance next to a template entry. The
// preview itself is the existing previewTemplate path (useDefEditor → the design canvas); this is
// just the door to it from the Add palette.
function TemplatePreviewButton({ t, onPreview }: { t: Template; onPreview: (id: string) => void }) {
	return (
		<button
			type="button"
			className="tpl-preview"
			title={`Preview ${t.name} in the widget designer (read-only)`}
			aria-label={`Preview ${t.name} in the widget designer`}
			onClick={() => onPreview(t.id)}
		>
			👁
		</button>
	);
}

// A template that exposes insert-time options (e.g. the clock cluster's languages / time format):
// a name + a select per param + an Insert button. The selects render from the template's ParamSpecs
// — the SAME spec a def cloned from the template keeps as instance params — holding the chosen
// values locally and passing them up on insert. Templates without params render as a plain button
// instead (see the palette below).
function TemplateOptionsForm({
	t,
	onInsert,
	onPreview
}: {
	t: Template;
	onInsert: (options: Record<string, string>) => void;
	onPreview?: (templateId: string) => void;
}) {
	const [opts, setOpts] = useState<Record<string, string>>(() => resolveTemplateOptions(t));
	return (
		<div className="tpl-opts">
			<span className="tpl-opts-head">
				<span className="tpl-opts-name">{t.name}</span>
				{onPreview && <TemplatePreviewButton t={t} onPreview={onPreview} />}
			</span>
			<div className="tpl-opts-fields">
				{(t.params ?? [])
					.filter((p) => p.choices)
					.map((p) => (
						<label key={p.key}>
							{p.label ?? p.key}
							<Select
								value={opts[p.key]}
								options={p.choices ?? []}
								onChange={(v) => setOpts((prev) => ({ ...prev, [p.key]: v }))}
								aria-label={`${t.name} — ${p.label ?? p.key}`}
							/>
						</label>
					))}
			</div>
			<button
				type="button"
				className="tpl-opts-insert"
				title={`${t.description} — inserts a standalone copy onto the canvas (not linked to the library)`}
				onClick={() => onInsert(opts)}
			>
				＋ Insert
			</button>
		</div>
	);
}

export default function Inspector({
	widget = null,
	container = null,
	groupUnit = null,
	def = null,
	defs = [],
	tokens = {},
	baseWidget = null,
	baseContainer = null,
	baseGroup = null,
	baseTokens = null,
	nodeIsNew = false,
	isGridCell = false,
	containerBox = null,
	placement = null,
	widgetBasis = undefined,
	widgetHalign = undefined,
	widgetValign = undefined,
	docked = false,
	widgetTypes = [],
	configFields = [],
	sensors = [],
	sensorMeta = {},
	audioOutputs = [],
	microphones = [],
	displayNames = [],
	onOp,
	onDeleteDef,
	onPreviewTemplate,
	node = null,
	onCopy
}: Props) {
	const op = (o: LayoutOp) => onOp?.(o);
	// Where a clicked palette widget lands: into the selected container, else as a floating widget.
	// Mirrors addWidget in useEditorModel so the button names its real destination (no hidden mode).
	const addDest = container ? `into ${container.kind}` : 'floating';

	// Collapse the Add/Library palette once a node is selected, so the selected node's properties sit
	// at the TOP of the rail (not below the palette you scroll past). Auto-set on selection change but
	// still user-toggleable in between, and re-opens when nothing is selected (the primary add affordance).
	const hasSelection = !!(widget || container || groupUnit);
	const [addOpen, setAddOpen] = useState(!hasSelection);
	// Auto-set on selection change (collapse once something is selected, re-open when nothing is), while
	// staying user-toggleable in between — the store-previous idiom, so the reset happens during render
	// only when `hasSelection` actually flips, not on every render.
	const [prevHasSelection, setPrevHasSelection] = useState(hasSelection);
	if (hasSelection !== prevHasSelection) {
		setPrevHasSelection(hasSelection);
		setAddOpen(!hasSelection);
	}

	// Add-palette hover preview (Tier 2): a floating popover with a live demo render of the hovered
	// entry — a widget type, OR a library def / template tree. Debounced so a quick pass doesn't spin up
	// a render; positioned to the LEFT (the palette is the right rail) and clamped into the viewport.
	type PreviewSpec = {
		label: string;
		desc?: string;
		hint: string;
		type?: string; // a single widget
		node?: LayoutNode; // a def / template tree (with its native size)
		size?: { w: number; h: number };
	};
	const [palettePreview, setPalettePreview] = useState<
		(PreviewSpec & { top: number; left: number }) | null
	>(null);
	const previewTimer = useRef<number | null>(null);
	const previewRef = useRef<HTMLDivElement | null>(null);
	const showPreview = (spec: PreviewSpec, el: HTMLElement): void => {
		if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
		previewTimer.current = window.setTimeout(() => {
			const r = el.getBoundingClientRect();
			const left = Math.max(8, r.left - 232 - 10);
			setPalettePreview({ ...spec, top: Math.max(8, r.top - 8), left });
		}, 280);
	};
	const hidePreview = (): void => {
		if (previewTimer.current !== null) {
			window.clearTimeout(previewTimer.current);
			previewTimer.current = null;
		}
		setPalettePreview(null);
	};
	useEffect(
		() => () => {
			if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
		},
		[]
	);
	// Keep the popover on-screen: after render, clamp its top so the bottom isn't cut off (its height
	// varies with the description, so a fixed estimate clipped tall cards hovered near the bottom).
	useLayoutEffect(() => {
		const el = previewRef.current;
		if (!el || !palettePreview) return;
		const top = Math.min(palettePreview.top, Math.max(8, window.innerHeight - el.offsetHeight - 8));
		el.style.top = `${Math.max(8, top)}px`;
	}, [palettePreview]);
	// Built-ins + one group per enabled plugin package (re-renders on package toggle).
	const templateGroups = useTemplateGroups();

	// Add-palette filter: one search box narrows widgets + templates + library by name/type/description.
	const [paletteFilter, setPaletteFilter] = useState('');
	const pq = paletteFilter.trim().toLowerCase();
	const pmatch = (...parts: (string | undefined)[]): boolean =>
		!pq || parts.some((p) => p?.toLowerCase().includes(pq));
	const fWidgetGroups = groupPalette(
		widgetTypes.filter((w) => pmatch(w.label, w.type, getMeta(w.type)?.description))
	);
	const fDefs = defs.filter((d) => pmatch(d.name));
	const fTemplateGroups = templateGroups
		.map((g) => ({ ...g, templates: g.templates.filter((t) => pmatch(t.name, t.description)) }))
		.filter((g) => g.templates.length);
	const paletteEmpty = !fWidgetGroups.length && !fDefs.length && !fTemplateGroups.length;

	// HA entity ids (e.g. "light.kitchen") for the macro editor's entity picker — from the json
	// `ha.<id>` catalog entries (not the `.state` scalars, nor the `ha.status` connection sensor).
	const haEntityIds = useMemo(
		() =>
			sensors
				.filter((s) => s.startsWith('ha.') && !s.endsWith('.state'))
				.map((s) => s.slice('ha.'.length))
				.filter((e) => e.includes('.')),
		[sensors]
	);

	// Sensor combobox options: friendly "Name (unit)" label, the raw id kept as the value + shown as a
	// dim hint. A bare id (no metadata) is its own label with no hint. Drives the typeahead sensor field.
	const sensorOptions = useMemo<SelectOption[]>(
		() =>
			sensors.map((s) => {
				const m = sensorMeta[s];
				const label = m?.label && m.label !== s ? (m.unit ? `${m.label} (${m.unit})` : m.label) : s;
				return label === s ? { value: s, label: s } : { value: s, label, hint: s };
			}),
		[sensors, sensorMeta]
	);

	// --- "Data" tab: a JSON/YAML view of the whole selected node, for agentic read + edit. The JSON
	// is an editable buffer applied back via replaceNode; YAML is a read-only mirror. ---
	const [detailTab, setDetailTab] = useState<'form' | 'data'>('form');
	const [dataFormat, setDataFormat] = useState<'json' | 'yaml'>('json');
	const [dataJson, setDataJson] = useState(() => (node ? JSON.stringify(node, null, 2) : ''));
	const [dataError, setDataError] = useState<string | null>(null);
	// Re-sync the JSON buffer whenever the selected node changes by identity (selection switch or an
	// applied edit), mirroring the config-JSON box — so the buffer never goes stale under the agent.
	// Store-previous idiom: reset during render on an identity change, not via a set-state effect.
	const [prevNode, setPrevNode] = useState(node);
	if (node !== prevNode) {
		setPrevNode(node);
		if (node) {
			setDataJson(JSON.stringify(node, null, 2));
			setDataError(null);
		}
	}
	function applyNodeJson() {
		if (!node) return;
		try {
			const parsed = JSON.parse(dataJson) as Record<string, unknown>;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
				throw new Error('Expected a JSON object.');
			const looksLeaf = 'unit' in parsed && !!parsed.unit && typeof parsed.unit === 'object';
			const looksContainer =
				parsed.kind === 'row' || parsed.kind === 'col' || parsed.kind === 'grid';
			if (!looksLeaf && !looksContainer)
				throw new Error('Expected a widget (has "unit") or a container ("kind" + "children").');
			// Keep the slot's id stable so selection + any references survive the replace.
			op({
				op: 'replaceNode',
				id: node.id,
				node: { ...parsed, id: node.id } as unknown as LayoutNode
			});
			setDataError(null);
		} catch (e) {
			setDataError((e as Error).message ?? String(e));
		}
	}

	const [paramKey, setParamKey] = useState('');
	const [paramTarget, setParamTarget] = useState('');

	const dirtyKeys = useMemo(
		() =>
			computeDirty(
				widget,
				container,
				groupUnit,
				tokens,
				baseWidget,
				baseContainer,
				baseGroup,
				baseTokens,
				nodeIsNew
			),
		[
			widget,
			container,
			groupUnit,
			tokens,
			baseWidget,
			baseContainer,
			baseGroup,
			baseTokens,
			nodeIsNew
		]
	);
	// The raw-JSON box mirrors the whole config, so it's dirty if any config field changed.
	const configDirty = [...dirtyKeys].some((k) => k.startsWith('config.'));

	const [configText, setConfigText] = useState(() =>
		widget ? JSON.stringify(widget.config, null, 2) : ''
	);
	const [configError, setConfigError] = useState(false);

	// Re-sync the raw-JSON box whenever the config object changes by reference — i.e. on
	// widget switch AND on every typed-field edit (setConfig makes a new config object).
	// This keeps the escape-hatch textarea in step with the schema fields, so committing
	// the JSON can't silently revert a field edit. Typing in the textarea doesn't change
	// widget.config until commit, so an in-progress edit is never clobbered. Store-previous
	// idiom keyed on config identity (widget switch + each committed edit), so the reset runs
	// during render — never on other widget prop changes, which would clobber in-progress typing.
	const widgetConfig = widget?.config;
	const [prevConfig, setPrevConfig] = useState(widgetConfig);
	if (widgetConfig !== prevConfig) {
		setPrevConfig(widgetConfig);
		if (widget) {
			setConfigText(JSON.stringify(widget.config, null, 2));
			setConfigError(false);
		}
	}

	function patchWidget(patch: Partial<WidgetInstance>) {
		if (widget) op({ op: 'patchWidget', id: widget.id, patch });
	}

	function setConfig(key: string, value: unknown) {
		if (widget) patchWidget({ config: { ...widget.config, [key]: value } });
	}

	// A field's reset value: its own explicit `default`, else the widget type's defaultConfig[key].
	const widgetMeta = widget ? getMeta(widget.type) : undefined;
	const fieldDefault = (f: ConfigField): unknown =>
		f.default !== undefined ? f.default : widgetMeta?.defaultConfig?.[f.key];

	function patchContainer(patch: Partial<Container>) {
		if (container) op({ op: 'patchContainer', id: container.id, patch });
	}

	// Guardrail: cap pad/gap to the selected container's box so they can't collapse its content out
	// of existence (a pad larger than the box zeroes every child — panes vanish + become undroppable).
	const padMax = maxPad(containerBox);
	const gapMax = maxGap(containerBox);

	// Typed setters (the casts live here, not in the template).
	const setKind = (v: string) => patchContainer({ kind: v as Container['kind'] });
	// Write one of the orientation-aware alignment controls (align = cross / justify = main).
	const setAlignField = (field: 'align' | 'justify', v: string) =>
		patchContainer(field === 'align' ? { align: v as Align } : { justify: v as Justify });
	// The container's own main-axis sizing inside its parent: fit children / grow / fixed px.
	const setContainerSizing = (mode: string) =>
		patchContainer({
			basis:
				mode === 'grow'
					? { fr: 1 }
					: mode === 'fixed'
						? typeof container?.basis === 'number'
							? container.basis
							: 100
						: undefined
		});

	// Guarded actions.
	const removeContainer = () => container && op({ op: 'remove', id: container.id });
	const removeWidget = () => widget && op({ op: 'remove', id: widget.id });
	const dockWidget = () => widget && op({ op: 'dock', id: widget.id });
	const floatWidget = () => widget && op({ op: 'float', id: widget.id });
	const makeWidgetFromContainer = () => container && op({ op: 'makeWidget', id: container.id });
	const makeWidgetFromWidget = () => widget && op({ op: 'makeWidget', id: widget.id });
	const resetWidget = () => widget && op({ op: 'resetWidget', id: widget.id });
	const ungroupGroup = () => groupUnit && op({ op: 'ungroup', id: groupUnit.id });
	const removeGroup = () => groupUnit && op({ op: 'remove', id: groupUnit.id });
	const setGroupName = (name: string) =>
		groupUnit && op({ op: 'patchGroup', id: groupUnit.id, patch: { name } });
	// A floating group's anchor (x/y) + per-instance size override (w/h) live in its `config`.
	const groupSize = def?.size ?? groupUnit?.size ?? { w: 0, h: 0 };
	const groupCfgNum = (k: 'x' | 'y' | 'w' | 'h'): number => {
		const v = groupUnit?.config?.[k];
		if (typeof v === 'number') return v;
		return k === 'w' ? groupSize.w : k === 'h' ? groupSize.h : 0;
	};
	const setGroupConfig = (k: string, v: number) =>
		groupUnit &&
		op({
			op: 'patchGroup',
			id: groupUnit.id,
			patch: { config: { ...(groupUnit.config ?? {}), [k]: v } }
		});
	const renameDefName = (name: string) => def && op({ op: 'renameDef', defId: def.id, name });
	const editDef = () => def && op({ op: 'editDef', defId: def.id });
	const setDefW = (w: number) => def && op({ op: 'setDefSize', defId: def.id, w, h: def.size.h });
	const setDefH = (h: number) => def && op({ op: 'setDefSize', defId: def.id, w: def.size.w, h });
	const setWidgetCss = (css: string) =>
		widget && op({ op: 'patchWidget', id: widget.id, patch: { css: css || undefined } });
	const setGroupCss = (css: string) =>
		groupUnit && op({ op: 'patchGroup', id: groupUnit.id, patch: { css: css || undefined } });
	const setDefCss = (css: string) => def && op({ op: 'setDefCss', defId: def.id, css });
	const setParam = (key: string, value: string) =>
		groupUnit &&
		op({
			op: 'patchGroup',
			id: groupUnit.id,
			patch: { params: { ...(groupUnit.params ?? {}), [key]: value } }
		});
	function addParam() {
		if (def && paramKey) {
			op({ op: 'addDefParam', defId: def.id, key: paramKey, target: paramTarget || undefined });
			setParamKey('');
			setParamTarget('');
		}
	}

	function updateRect(key: (typeof RECT_KEYS)[number], value: number) {
		if (widget) patchWidget({ rect: { ...widget.rect, [key]: value } });
	}

	function commitConfig() {
		try {
			const parsed = JSON.parse(configText) as Record<string, unknown>;
			setConfigError(false);
			patchWidget({ config: parsed });
		} catch {
			setConfigError(true);
		}
	}

	// Per-leaf placement controls (halign/valign), shared by the primitive-widget and group
	// branches — both are flow leaves whose Leaf wrapper carries the alignment. `id` is the leaf id.
	const leafAlignControls = (id: string) => (
		<>
			<span className="hd">Align in its space</span>
			<div className="row2">
				<label>
					horizontal
					<Select
						value={widgetHalign ?? 'fill'}
						options={LEAF_H_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
						onChange={(v) =>
							op({ op: 'setLeafAlign', id, halign: v as AlignH, valign: widgetValign ?? 'fill' })
						}
						aria-label="horizontal align"
					/>
				</label>
				<label>
					vertical
					<Select
						value={widgetValign ?? 'fill'}
						options={LEAF_V_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
						onChange={(v) =>
							op({ op: 'setLeafAlign', id, halign: widgetHalign ?? 'fill', valign: v as AlignV })
						}
						aria-label="vertical align"
					/>
				</label>
			</div>
		</>
	);

	// Per-leaf box: outer margin + inner padding (per-side, locked together by default). Both live on
	// the Leaf wrapper (read from `node`), so this is shared by the primitive-widget and group flow
	// branches. `id` is the leaf id (= widget.id / groupUnit.id by the leaf invariant).
	const leafBoxControls = (id: string) => {
		const lf = node as Leaf | null;
		return (
			<>
				<BoxField
					label="margin"
					value={lf?.margin}
					onChange={(v) => op({ op: 'setLeafBox', id, field: 'margin', value: v })}
				/>
				<BoxField
					label="pad"
					value={lf?.pad}
					onChange={(v) => op({ op: 'setLeafBox', id, field: 'pad', value: v })}
				/>
			</>
		);
	};

	// A flow leaf's own main-axis sizing inside its parent: fit (its own/def size) / grow / fixed px.
	// Used for groups (custom widgets) — primitives have a richer select with 'content' measuring.
	const leafSizingControls = (id: string) => (
		<>
			<label className="full">
				size (in parent)
				<Select
					value={
						isFrBasis(widgetBasis) ? 'grow' : typeof widgetBasis === 'number' ? 'fixed' : 'fit'
					}
					options={[
						{ value: 'fit', label: 'hug — fit content' },
						{ value: 'grow', label: 'fill — grow to share' },
						{ value: 'fixed', label: 'fixed (px)' }
					]}
					onChange={(v) =>
						op({
							op: 'setBasis',
							id,
							// 'fit' → 'content' (not undefined): a content basis floors the group at its
							// min-content in flowStyle, so hugging a GROUP (e.g. the Network widget) fits its
							// content instead of clipping to a stale stored size.
							basis:
								v === 'grow'
									? { fr: 1 }
									: v === 'fixed'
										? typeof widgetBasis === 'number'
											? widgetBasis
											: 100
										: 'content'
						})
					}
					aria-label="size in parent"
				/>
			</label>
			{typeof widgetBasis === 'number' && (
				<label className="full">
					size (px)
					<input
						type="number"
						min="0"
						value={widgetBasis}
						onInput={(e) => op({ op: 'setBasis', id, basis: Number(e.currentTarget.value) || 0 })}
					/>
				</label>
			)}
		</>
	);

	return (
		<div className={['inspector', docked && 'docked'].filter(Boolean).join(' ')}>
			{/* Add-palette hover preview (Tier 2): a fixed popover with a live demo render of the hovered
			    entry (a widget type, or a library def / template tree), its name, description + a hint. */}
			{palettePreview ? (
				<div
					ref={previewRef}
					className="palette-preview"
					style={{ top: palettePreview.top, left: palettePreview.left }}
				>
					<div className="pp-stage">
						<WidgetPreview
							type={palettePreview.type}
							node={palettePreview.node}
							size={palettePreview.size}
						/>
					</div>
					<div className="pp-meta">
						<span className="pp-name">{palettePreview.label}</span>
						{palettePreview.desc ? <span className="pp-desc">{palettePreview.desc}</span> : null}
						<span className="pp-hint">{palettePreview.hint}</span>
					</div>
				</div>
			) : null}
			<details
				className="add-panel"
				open={addOpen}
				onToggle={(e) => setAddOpen(e.currentTarget.open)}
			>
				<summary>＋ Add widget · {addDest}</summary>
				{/* One search box narrows widgets + templates + library at once — ~20 widgets plus
				    templates + library made find-by-scan slow. */}
				<input
					className="palette-filter"
					type="search"
					placeholder="Filter widgets, templates, library…"
					value={paletteFilter}
					onChange={(e) => setPaletteFilter(e.currentTarget.value)}
					aria-label="Filter the add palette"
				/>

				{/* Widgets, grouped by meta.category (first-seen order; uncategorized falls into "Other"). */}
				{fWidgetGroups.map((g) => (
					<div key={g.category} className="palette">
						<span className="hd2">{g.category}</span>
						{g.items.map((w) => (
							<button
								key={w.type}
								type="button"
								draggable
								// No native `title` tooltip — the hover preview popover is the richer replacement
								// (both at once was redundant). The description stays as the aria-label for a11y.
								aria-label={[w.label, getMeta(w.type)?.description].filter(Boolean).join(' — ')}
								onClick={() => {
									hidePreview();
									op({ op: 'addWidget', widgetType: w.type });
								}}
								onMouseEnter={(e) =>
									showPreview(
										{
											label: w.label,
											desc: getMeta(w.type)?.description,
											hint: container
												? `Click to add into the ${container.kind} · drag to place`
												: 'Click to add · drag to place',
											type: w.type
										},
										e.currentTarget
									)
								}
								onMouseLeave={hidePreview}
								onDragStart={(e: ReactDragEvent) => {
									hidePreview();
									e.dataTransfer?.setData('text/x-widget-type', w.type);
								}}
							>
								{w.label}
							</button>
						))}
					</div>
				))}

				{/* Templates: insert a STANDALONE inline copy (the designer rail's ⎘ clones one into an
				    editable library widget instead). 👁 jumps to the designer's read-only preview. Groups
				    come from the registry: built-ins first, then one per enabled plugin package. */}
				{fTemplateGroups.map((g) => (
					<div key={g.group} className="palette">
						<span className="hd">
							{g.group === BUILTIN_TEMPLATE_GROUP ? 'Templates' : `Templates · ${g.group}`}
						</span>
						{g.templates.map((t) =>
							t.params?.length ? (
								<TemplateOptionsForm
									key={t.id}
									t={t}
									onInsert={(options) => op({ op: 'insertTemplate', templateId: t.id, options })}
									onPreview={onPreviewTemplate}
								/>
							) : (
								<span key={t.id} className="libitem">
									<button
										type="button"
										aria-label={[t.name, t.description].filter(Boolean).join(' — ')}
										onClick={() => {
											hidePreview();
											op({ op: 'insertTemplate', templateId: t.id });
										}}
										onMouseEnter={(e) =>
											showPreview(
												{
													label: t.name,
													desc: t.description,
													hint: 'Click to insert a standalone copy',
													node: t.tree(),
													size: t.size
												},
												e.currentTarget
											)
										}
										onMouseLeave={hidePreview}
									>
										{t.name}
									</button>
									{onPreviewTemplate && (
										<TemplatePreviewButton t={t} onPreview={onPreviewTemplate} />
									)}
								</span>
							)
						)}
					</div>
				))}

				{/* Library: your saved widget defs (insert an instance linked to the def). */}
				{fDefs.length ? (
					<div className="palette">
						<span className="hd">Library</span>
						{fDefs.map((d) => (
							<span key={d.id} className="libitem">
								<button
									type="button"
									aria-label={d.name}
									onClick={() => {
										hidePreview();
										op({ op: 'insertWidget', defId: d.id });
									}}
									onMouseEnter={(e) =>
										showPreview(
											{ label: d.name, hint: 'Click to insert', node: d.child, size: d.size },
											e.currentTarget
										)
									}
									onMouseLeave={hidePreview}
								>
									{d.name}
								</button>
								<button
									type="button"
									className="x"
									title="Delete from library (only if unused)"
									aria-label={`Delete ${d.name} from library`}
									onClick={() =>
										onDeleteDef ? onDeleteDef(d.id, d.name) : op({ op: 'deleteDef', defId: d.id })
									}
								>
									✕
								</button>
							</span>
						))}
					</div>
				) : null}

				{paletteEmpty ? (
					<div className="palette-empty">No matches for “{paletteFilter}”.</div>
				) : null}
			</details>

			{node && (
				<div
					className="detail-tabs"
					role="tablist"
					aria-label="Inspector view"
					// WAI-ARIA tabs pattern: Left/Right move selection (the active tab is the sole tab stop
					// via roving tabindex; the inactive one is -1). With two tabs each arrow toggles.
					onKeyDown={(e) => {
						if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
						e.preventDefault();
						const next = detailTab === 'form' ? 'data' : 'form';
						setDetailTab(next);
						const tabs = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
						(next === 'form' ? tabs[0] : tabs[1])?.focus();
					}}
				>
					<button
						type="button"
						role="tab"
						id="inspector-tab-form"
						aria-controls="inspector-panel-form"
						aria-selected={detailTab === 'form'}
						tabIndex={detailTab === 'form' ? 0 : -1}
						className={detailTab === 'form' ? 'active' : undefined}
						onClick={() => setDetailTab('form')}
					>
						Fields
					</button>
					<button
						type="button"
						role="tab"
						id="inspector-tab-data"
						aria-controls="inspector-panel-data"
						aria-selected={detailTab === 'data'}
						tabIndex={detailTab === 'data' ? 0 : -1}
						className={detailTab === 'data' ? 'active' : undefined}
						onClick={() => setDetailTab('data')}
					>
						Data
					</button>
				</div>
			)}

			{node && detailTab === 'data' ? (
				<div
					className="fields data-tab"
					role="tabpanel"
					id="inspector-panel-data"
					aria-labelledby="inspector-tab-data"
					tabIndex={0}
				>
					<div className="data-bar">
						<button
							type="button"
							className={dataFormat === 'json' ? 'active' : undefined}
							onClick={() => setDataFormat('json')}
						>
							JSON
						</button>
						<button
							type="button"
							className={dataFormat === 'yaml' ? 'active' : undefined}
							onClick={() => setDataFormat('yaml')}
						>
							YAML
						</button>
						<span className="data-spacer" />
						<button
							type="button"
							title="Copy this representation to the clipboard"
							onClick={() => onCopy?.(dataFormat === 'json' ? dataJson : toYaml(node))}
						>
							⧉ Copy
						</button>
					</div>
					{dataFormat === 'json' ? (
						<>
							<textarea
								className={['data-area', dataError && 'error'].filter(Boolean).join(' ')}
								value={dataJson}
								spellCheck={false}
								aria-label="Node JSON"
								onChange={(e) => setDataJson(e.currentTarget.value)}
							/>
							{dataError && <small className="field-help data-err">{dataError}</small>}
							<div className="actions">
								<button type="button" onClick={applyNodeJson}>
									Apply
								</button>
								<button
									type="button"
									onClick={() => {
										setDataJson(JSON.stringify(node, null, 2));
										setDataError(null);
									}}
								>
									Revert
								</button>
							</div>
							<small className="field-help">
								Edit the full node, then Apply (its id is kept). Undo with Ctrl+Z.
							</small>
						</>
					) : (
						<textarea
							className="data-area"
							readOnly
							value={toYaml(node)}
							spellCheck={false}
							aria-label="Node YAML (read-only)"
						/>
					)}
				</div>
			) : container ? (
				<div
					className="fields"
					role="tabpanel"
					id="inspector-panel-form"
					aria-labelledby="inspector-tab-form"
					tabIndex={0}
				>
					<span className="hd node-hd" title={`${container.kind} · ${container.id}`}>
						{container.kind} · {container.id}
					</span>
					<label className={['full', dirtyKeys.has('kind') && 'dirty'].filter(Boolean).join(' ')}>
						kind
						<Select
							value={container.kind}
							options={[
								{ value: 'row', label: 'row (hsplit)' },
								{ value: 'col', label: 'col (vsplit)' },
								{ value: 'grid', label: 'grid (panes)' }
							]}
							onChange={setKind}
							aria-label="kind"
						/>
					</label>
					{container.kind === 'grid' && (
						<>
							<div className="row2">
								<label className={dirtyKeys.has('cols') ? 'dirty' : undefined}>
									cols
									<input
										type="number"
										min="1"
										value={container.cols ?? 1}
										onInput={(e) => patchContainer({ cols: Number(e.currentTarget.value) })}
									/>
								</label>
								<label className={dirtyKeys.has('rows') ? 'dirty' : undefined}>
									rows
									<input
										type="number"
										min="1"
										value={container.rows ?? 1}
										onInput={(e) => patchContainer({ rows: Number(e.currentTarget.value) })}
									/>
								</label>
							</div>
							{!!(container.colFr?.length || container.rowFr?.length) && (
								<button
									type="button"
									className="full"
									title="Reset dragged column/row sizes to an even split"
									onClick={() => op({ op: 'distributeEvenly', containerId: container.id })}
								>
									Reset tracks (even)
								</button>
							)}
						</>
					)}
					<div className="row2">
						<label className={dirtyKeys.has('gap') ? 'dirty' : undefined}>
							gap
							{/* step=2 nudges the steppers onto the canvas spacing scale (2/4/6/8/16);
							    typing any value still works. */}
							<input
								type="number"
								min="0"
								max={gapMax}
								step="2"
								value={container.gap ?? 0}
								onInput={(e) =>
									patchContainer({ gap: clampSpacing(Number(e.currentTarget.value), gapMax) })
								}
							/>
						</label>
					</div>
					<BoxField
						label="pad"
						value={container.pad}
						max={padMax}
						onChange={(v) => patchContainer({ pad: v })}
						dirty={dirtyKeys.has('pad')}
					/>
					<BoxField
						label="margin"
						value={container.margin}
						onChange={(v) => patchContainer({ margin: v })}
						dirty={dirtyKeys.has('margin')}
					/>
					<span className="hd">Align children</span>
					{containerAlignControls(container).map((ctl) => (
						<label
							key={ctl.axis}
							className={['full', dirtyKeys.has(ctl.field) && 'dirty'].filter(Boolean).join(' ')}
						>
							{ctl.label}
							<Select
								value={ctl.value}
								options={ctl.options.map((o) => ({ value: o.value, label: o.label }))}
								onChange={(v) => setAlignField(ctl.field, v)}
								aria-label={ctl.label}
							/>
						</label>
					))}
					<label className={['full', dirtyKeys.has('basis') && 'dirty'].filter(Boolean).join(' ')}>
						size (in parent)
						<Select
							value={
								isFrBasis(container.basis)
									? 'grow'
									: typeof container.basis === 'number'
										? 'fixed'
										: 'fit'
							}
							options={[
								{ value: 'fit', label: 'hug — fit children' },
								{ value: 'grow', label: 'fill — grow to share' },
								{ value: 'fixed', label: 'fixed (px)' }
							]}
							onChange={setContainerSizing}
							aria-label="container size in parent"
						/>
					</label>
					{typeof container.basis === 'number' && (
						<label className="full">
							size (px)
							<input
								type="number"
								min="0"
								value={container.basis}
								onInput={(e) => patchContainer({ basis: Number(e.currentTarget.value) || 0 })}
							/>
						</label>
					)}
					<label
						className={['check', dirtyKeys.has('overlap') && 'dirty'].filter(Boolean).join(' ')}
					>
						<input
							type="checkbox"
							checked={!!container.overlap}
							onChange={(e) => patchContainer({ overlap: e.currentTarget.checked || undefined })}
						/>
						stack children (overlap in one cell)
					</label>
					<span className="hd">Visibility</span>
					<ConditionEditor
						value={container.condition}
						sensors={sensors}
						dirty={dirtyKeys.has('condition')}
						onChange={(condition) => patchContainer({ condition })}
					/>
					{isGridCell && (
						<>
							<span className="hd">Grid cell</span>
							<div className="row2">
								<label className={dirtyKeys.has('cellW') ? 'dirty' : undefined}>
									width (px)
									<input
										type="number"
										min="0"
										value={container.cellW ?? ''}
										placeholder="flex"
										onInput={(e) =>
											patchContainer({ cellW: Number(e.currentTarget.value) || undefined })
										}
									/>
								</label>
								<label className={dirtyKeys.has('cellH') ? 'dirty' : undefined}>
									height (px)
									<input
										type="number"
										min="0"
										value={container.cellH ?? ''}
										placeholder="flex"
										onInput={(e) =>
											patchContainer({ cellH: Number(e.currentTarget.value) || undefined })
										}
									/>
								</label>
							</div>
							<label
								className={['full', dirtyKeys.has('aspect') && 'dirty'].filter(Boolean).join(' ')}
							>
								aspect (w/h, e.g. 1 or 1.78)
								<input
									type="number"
									min="0"
									step="0.01"
									value={container.aspect ?? ''}
									placeholder="off"
									onInput={(e) =>
										patchContainer({ aspect: Number(e.currentTarget.value) || undefined })
									}
								/>
							</label>
						</>
					)}
					<div className="actions">
						<button type="button" onClick={makeWidgetFromContainer}>
							Make widget
						</button>
						<button type="button" className="remove" onClick={removeContainer}>
							Remove
						</button>
					</div>
				</div>
			) : widget ? (
				<div
					className="fields"
					role="tabpanel"
					id="inspector-panel-form"
					aria-labelledby="inspector-tab-form"
					tabIndex={0}
				>
					<span className="hd node-hd" title={`${widget.type} · ${widget.id}`}>
						{widget.type} · {widget.id}
					</span>
					<label className={['full', dirtyKeys.has('sensor') && 'dirty'].filter(Boolean).join(' ')}>
						sensor
						<Select
							value={widget.sensor ?? ''}
							options={sensorOptions}
							onChange={(v) => patchWidget({ sensor: v.trim() || undefined })}
							placeholder="(none)"
							allowCustom
							aria-label="sensor"
						/>
					</label>
					{placement === 'floating' && (
						<div className="row">
							{RECT_KEYS.map((key) => (
								<label key={key} className={dirtyKeys.has('rect.' + key) ? 'dirty' : undefined}>
									{key}
									<input
										type="number"
										value={widget.rect[key]}
										onInput={(e) => updateRect(key, Number(e.currentTarget.value))}
									/>
								</label>
							))}
						</div>
					)}
					{placement === 'flow' && (
						<>
							<div className="row2">
								{(['w', 'h'] as const).map((key) => (
									<label key={key} className={dirtyKeys.has('rect.' + key) ? 'dirty' : undefined}>
										{key} (fixed)
										<input
											type="number"
											value={widget.rect[key]}
											onInput={(e) => updateRect(key, Number(e.currentTarget.value))}
										/>
									</label>
								))}
							</div>
							<label className="full">
								size along the row / column
								<Select
									value={
										isFrBasis(widgetBasis)
											? 'grow'
											: widgetBasis === 'content'
												? 'content'
												: 'fixed'
									}
									options={[
										{ value: 'fixed', label: 'fixed — use the w/h above' },
										{ value: 'content', label: 'hug — fit to content' },
										{ value: 'grow', label: 'fill — grow to share' }
									]}
									onChange={(v) =>
										op({
											op: 'setBasis',
											id: widget.id,
											basis: v === 'grow' ? { fr: 1 } : v === 'content' ? 'content' : undefined
										})
									}
									aria-label="size along the row / column"
								/>
							</label>
							{leafAlignControls(widget.id)}
							{leafBoxControls(widget.id)}
						</>
					)}
					{configFields.map((f) => {
						// The reset button lives OUTSIDE the <label> (positioned over its top-right) so the
						// field's input stays the label's labeled control — a nested button would otherwise
						// become the label's control (a11y regression + clicking the label would reset it).
						const def = fieldDefault(f);
						// A macro field isn't a single labeled control — render its list editor outside a
						// <label> (wrapping the multi-input editor in a label would be an a11y regression).
						if (f.kind === 'macro') {
							return (
								<div
									className={['cfg-field', 'cfg-macro', dirtyKeys.has('config.' + f.key) && 'dirty']
										.filter(Boolean)
										.join(' ')}
									key={f.key}
								>
									<button
										type="button"
										className="reset-field"
										title="Reset to default"
										disabled={def === undefined}
										onClick={() => setConfig(f.key, def)}
									>
										↺
									</button>
									<span className="hd" title={f.help}>
										{f.label}
									</span>
									<MacroEditor
										value={normalizeMacro(widget.config[f.key])}
										onChange={(next) => setConfig(f.key, next)}
										entities={haEntityIds}
									/>
									{f.help ? <small className="field-help">{f.help}</small> : null}
								</div>
							);
						}
						// A monitor-sources field is a multi-row editor (checklist + rename), so like the
						// macro field it renders outside the single-control <label> pattern below.
						if (f.kind === 'monitorSources') {
							return (
								<div
									className={['cfg-field', dirtyKeys.has('config.' + f.key) && 'dirty']
										.filter(Boolean)
										.join(' ')}
									key={f.key}
								>
									<button
										type="button"
										className="reset-field"
										title="Reset to default"
										disabled={def === undefined}
										onClick={() => setConfig(f.key, def)}
									>
										↺
									</button>
									<span className="hd" title={f.help}>
										{f.label}
									</span>
									<MonitorSourcesEditor
										value={cfgStr(widget.config[f.key])}
										monitor={cfgStr(widget.config.monitor)}
										onChange={(spec) => setConfig(f.key, spec || undefined)}
									/>
									{f.help ? <small className="field-help">{f.help}</small> : null}
								</div>
							);
						}
						// A toggle is a checkbox + its label on one aligned row (checkbox left, label
						// vertically centred), help below — not the label-stacked-over-control layout the
						// generic fields use.
						if (f.kind === 'toggle') {
							return (
								<div
									className={[
										'cfg-field',
										'cfg-toggle',
										dirtyKeys.has('config.' + f.key) && 'dirty'
									]
										.filter(Boolean)
										.join(' ')}
									key={f.key}
								>
									<button
										type="button"
										className="reset-field"
										title="Reset to default"
										disabled={def === undefined}
										onClick={() => setConfig(f.key, def)}
									>
										↺
									</button>
									<label className="check" title={f.help}>
										<input
											type="checkbox"
											checked={cfgBool(widget.config[f.key])}
											onChange={(e) => setConfig(f.key, e.currentTarget.checked)}
										/>
										<span>{f.label}</span>
									</label>
									{f.help ? <small className="field-help">{f.help}</small> : null}
								</div>
							);
						}
						return (
							<div className="cfg-field" key={f.key}>
								<button
									type="button"
									className="reset-field"
									title="Reset to default"
									disabled={def === undefined}
									onClick={() => setConfig(f.key, def)}
								>
									↺
								</button>
								<label
									title={f.help}
									className={['full', dirtyKeys.has('config.' + f.key) && 'dirty']
										.filter(Boolean)
										.join(' ')}
								>
									{f.label}
									{f.kind === 'number' ? (
										<input
											type="number"
											value={cfgStr(widget.config[f.key])}
											onInput={(e) =>
												setConfig(
													f.key,
													e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value)
												)
											}
										/>
									) : f.kind === 'select' ? (
										<Select
											value={cfgStr(widget.config[f.key])}
											options={
												f.catalog === 'audioOutputs'
													? [
															{ value: '', label: 'System default' },
															...audioOutputs.map((d) => ({ value: d.id, label: d.name }))
														]
													: f.catalog === 'microphones'
														? [
																{ value: '', label: 'System default' },
																...microphones.map((d) => ({ value: d.id, label: d.name }))
															]
														: f.catalog === 'displayNames'
															? [
																	{ value: '', label: 'Primary monitor' },
																	...displayNames.map((d) => ({ value: d.id, label: d.name }))
																]
															: f.options.map((o) => ({ value: o, label: o }))
											}
											onChange={(v) => setConfig(f.key, v)}
											aria-label={f.label}
										/>
									) : f.kind === 'expr' ? (
										<textarea
											className="cfg-expr"
											rows={2}
											spellCheck={false}
											value={cfgStr(widget.config[f.key])}
											placeholder={f.result === 'text' ? 'text + {expression}' : 'expression'}
											onInput={(e) => setConfig(f.key, e.currentTarget.value || undefined)}
										/>
									) : (
										<input
											type="text"
											value={cfgStr(widget.config[f.key])}
											placeholder={f.kind === 'color' ? 'css color' : ''}
											onInput={(e) => setConfig(f.key, e.currentTarget.value || undefined)}
										/>
									)}
									{f.kind === 'expr' ? (
										<ExprHint
											src={cfgStr(widget.config[f.key])}
											result={f.result}
											known={sensors}
										/>
									) : null}
									{f.help ? <small className="field-help">{f.help}</small> : null}
								</label>
							</div>
						);
					})}
					{/* The raw-JSON + CSS escape hatches are expert-rare — collapsed by default (progressive
					    disclosure) so the common sensor/config fields above aren't buried under them. */}
					<details className="adv">
						<summary>Advanced — config JSON / CSS</summary>
						<label className={['full', configDirty && 'dirty'].filter(Boolean).join(' ')}>
							config (JSON)
							<textarea
								rows={4}
								value={configText}
								className={configError ? 'error' : undefined}
								onChange={(e) => setConfigText(e.currentTarget.value)}
								onBlur={commitConfig}
							/>
						</label>
						<label className={['full', dirtyKeys.has('css') && 'dirty'].filter(Boolean).join(' ')}>
							css
							<CssEditor
								key={widget.id}
								value={widget.css ?? ''}
								onBlur={setWidgetCss}
								placeholder="color: red;  .value …"
								ariaLabel="widget css"
							/>
						</label>
					</details>
					<div className="actions">
						{placement === 'floating' ? (
							<button type="button" onClick={dockWidget}>
								Dock →flow
							</button>
						) : placement === 'flow' ? (
							<button type="button" onClick={floatWidget}>
								Float
							</button>
						) : null}
						<button type="button" onClick={makeWidgetFromWidget}>
							Make widget
						</button>
						<button
							type="button"
							title="Restore config / css / sensor to this widget's defaults"
							onClick={resetWidget}
						>
							Reset
						</button>
						<button type="button" className="remove" onClick={removeWidget}>
							Remove
						</button>
					</div>
				</div>
			) : groupUnit ? (
				<div className="fields">
					<span className="hd node-hd" title={`group · ${groupUnit.id}`}>
						group · {groupUnit.id}
					</span>
					<label className={['full', dirtyKeys.has('name') && 'dirty'].filter(Boolean).join(' ')}>
						name
						<input
							value={groupUnit.name ?? ''}
							onInput={(e) => setGroupName(e.currentTarget.value)}
						/>
					</label>
					{placement === 'flow' && (
						<>
							{leafSizingControls(groupUnit.id)}
							{leafAlignControls(groupUnit.id)}
							{leafBoxControls(groupUnit.id)}
						</>
					)}
					{placement === 'floating' && (
						<div className="row">
							{(['x', 'y', 'w', 'h'] as const).map((k) => (
								<label key={k}>
									{k}
									<input
										type="number"
										value={groupCfgNum(k)}
										onInput={(e) => setGroupConfig(k, Number(e.currentTarget.value))}
									/>
								</label>
							))}
						</div>
					)}
					{def ? (
						<>
							<label className="full">
								def name
								<input value={def.name} onInput={(e) => renameDefName(e.currentTarget.value)} />
							</label>
							<div className="row2">
								<label>
									def w
									<input
										type="number"
										value={def.size.w}
										onInput={(e) => setDefW(Number(e.currentTarget.value))}
									/>
								</label>
								<label>
									def h
									<input
										type="number"
										value={def.size.h}
										onInput={(e) => setDefH(Number(e.currentTarget.value))}
									/>
								</label>
							</div>
							<button type="button" onClick={editDef}>
								Edit def…
							</button>
							{def.params?.length ? (
								<>
									<span className="hd">Params</span>
									{def.params.map((p) => (
										<label
											key={p.key}
											className={['full', dirtyKeys.has('param.' + p.key) && 'dirty']
												.filter(Boolean)
												.join(' ')}
										>
											{p.label ?? p.key}
											{!p.choices && p.target ? <>&nbsp;→ {p.target}</> : null}
											{p.choices ? (
												// A select param (e.g. a template clone's 12/24-hour): unset falls
												// back to the spec default, which is what the baked tree shows.
												<Select
													value={`${groupUnit.params?.[p.key] ?? p.default ?? ''}`}
													options={p.choices}
													onChange={(v) => setParam(p.key, v)}
													aria-label={`param ${p.label ?? p.key}`}
												/>
											) : (
												<input
													value={`${groupUnit.params?.[p.key] ?? ''}`}
													onInput={(e) => setParam(p.key, e.currentTarget.value)}
												/>
											)}
										</label>
									))}
								</>
							) : null}
							<div className="row2">
								<input
									placeholder="param key"
									value={paramKey}
									onChange={(e) => setParamKey(e.currentTarget.value)}
								/>
								<input
									placeholder="target e.g. unit.sensor"
									value={paramTarget}
									onChange={(e) => setParamTarget(e.currentTarget.value)}
								/>
							</div>
							<button type="button" onClick={addParam}>
								Add param
							</button>
							<label className="full">
								def css
								<CssEditor
									key={def.id}
									value={def.css ?? ''}
									onBlur={setDefCss}
									placeholder="color: red;  .value …"
									ariaLabel="def css"
								/>
							</label>
						</>
					) : (
						<div className="meta">inline group (no def)</div>
					)}
					<label className={['full', dirtyKeys.has('css') && 'dirty'].filter(Boolean).join(' ')}>
						css
						<CssEditor
							key={groupUnit.id}
							value={groupUnit.css ?? ''}
							onBlur={setGroupCss}
							placeholder="color: red;  .value …"
							ariaLabel="group css"
						/>
					</label>
					<div className="actions">
						<button
							type="button"
							onClick={ungroupGroup}
							title="Split this grouped widget back into its individual widgets"
						>
							⛓ Unlink
						</button>
						<button type="button" className="remove" onClick={removeGroup}>
							Remove
						</button>
					</div>
				</div>
			) : (
				<div className="hint">Select a widget, container, or group — or add one above.</div>
			)}

			{/* Per-widget theme overrides: tokens scoped to JUST the selected widget/group (cascade in
			    core/style.ts → [data-w]/[data-group]). Global theme + tokens live in the Themes section.
			    Hidden when only a container / nothing is selected (containers have no token scope).
			    Collapsed by default (overriding is the rare action; expanded it buried the widget's own
			    config) — but keyed per selection and pre-opened when THIS widget already has overrides,
			    so an override in effect is never invisible. The summary count says so even when shut. */}
			{widget || groupUnit
				? (() => {
						const tokenValues = widget?.tokens ?? groupUnit?.tokens ?? {};
						const overrideCount = Object.keys(tokenValues).length;
						return (
							<details
								className="fields tokens adv"
								key={widget?.id ?? groupUnit?.id}
								open={overrideCount > 0}
							>
								<summary className="hd">
									Override theme for this widget{overrideCount > 0 ? ` · ${overrideCount} set` : ''}
								</summary>
								<TokenFields
									values={tokenValues}
									baseValues={(widget ? baseWidget?.tokens : baseGroup?.tokens) ?? null}
									labelClassName="full"
									onSet={(key, value) =>
										op({ op: 'setWidgetToken', id: widget?.id ?? groupUnit?.id ?? '', key, value })
									}
									onClear={() =>
										op({ op: 'clearWidgetTokens', id: widget?.id ?? groupUnit?.id ?? '' })
									}
									clearTitle="Remove this widget's token overrides (fall back to the theme)"
								/>
							</details>
						);
					})()
				: null}
		</div>
	);
}
