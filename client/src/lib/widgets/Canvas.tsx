// Canvas (organism): owns the telemetry hub, wires the backend source, and lays out this
// monitor's widgets. Holds the versioned v2 MonitorLayout (an in-flow root tree + a floating
// layer) in the editor model (useEditorModel); persists/loads widgets.json as v2 via parseLayoutAny.
// The solver (solveMonitor) positions the flow tree; floating widgets are free-moved. Edit mode
// shows the Outline (structure) + Inspector (props) which funnel every change through handleOp →
// core/layoutEdit. React port of Canvas.svelte (behaviour parity is paramount).
import {
	lazy,
	Profiler,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState
} from 'react';
import { flushSync } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { COMMANDS, EVENTS } from '../bridge/contract';
import { createTelemetryHub } from '../core/telemetry';
import { sourceCatalogEntries, sourceCatalogIds } from '../core/plugin';
import { actionHandlerFor, listPlugins, pluginSensorNames } from './plugin';
import type { StudioApi } from './plugin';
import '../telemetry/source'; // side-effect: registers the built-in `system` source
import { registerBuiltinPlugins } from './plugins';
import { initPackages, refreshPackages } from './plugins/packages';
import { DEFAULT_MONITOR, type Rect, type WidgetInstance } from '../core/layout';
import {
	emptyRoot,
	isContainer,
	isGroup,
	isLeaf,
	leaf,
	monitorHasWidgets,
	type Container,
	type Group,
	type Leaf,
	type Library,
	type MonitorLayout,
	type WidgetDef
} from '../core/layoutTree';
import { parseLayoutAny } from '../core/migration';
import { demoSeed } from '../core/templates';
import {
	collectContainerRects,
	collectGridPlaceholders,
	collectRenderables,
	collectSplitters,
	gridCellRects,
	resolveGroup
} from '../core/solve';
import { assembleStyles } from '../core/style';
import { DEFAULT_SWATCH, extractFontFamilies, tokensToCss } from '../core/tokens';
import BackgroundLayer from './BackgroundLayer';
import {
	dropTarget,
	findNode,
	findParent,
	flowLeaves,
	insertChild,
	moveNode,
	removeNode,
	type Drop
} from '../core/layoutEdit';
import WidgetHost from './WidgetHost';
import FlowNode, { type RenderLeaf } from './FlowNode';
import { startWindowSource } from '../windows/source';
import { collectConditions } from './canvas/conditionVisibility';
import { useConditionHidden } from './canvas/useConditionHidden';
import GroupFrame from './GroupFrame';
import { useMeasuredRects } from './canvas/useMeasuredRects';
import { useOverlayPrefs } from './canvas/overlayPrefs';
import { overlayPresentation, isWholeWindowInteractive } from './canvas/overlayPresentation';
import { screenRectToLayout } from '../core/measureMath';
import { collectSensorRefs, sensorActivity } from '../core/sensorActivity';
import { SYSTEM_GROUP } from '../core/sensorList';
// StyleLayer renders on BOTH roles (overlay + studio), so it stays eager. The studio-only panels
// below are lazy()-loaded (see the const block after the imports) so the OVERLAY renderer never
// fetches/parses/retains them — they only load when this Canvas runs as the studio.
import StyleLayer from './StyleLayer';
import { startDiagResponder, startMemoryTrail } from '../diag';
import { paletteItems } from './registry';
import type { LayoutOp } from './ops';
import { snapRectToPeers } from '../core/align';
import { sensorCatalog } from '../core/sensors';
import { getMeta } from '../core/widget';
import { normalizeMacro, runMacro, type MacroAction } from '../core/macro';
import CssEditor from './CssEditor';
import {
	copyToClipboard,
	ensureFont,
	isAutostartEnabled,
	setAutostart,
	monitorParam,
	monitorWorkArea,
	openDevtools,
	minimizeWindow,
	toggleMaximizeWindow,
	closeWindow,
	onStudioCloseRequested,
	reconcileOverlays,
	recreateMain,
	setMainWindowVisible,
	syncInteractiveRects,
	applyOverlayPresentation
} from '../overlay';
import { startViewTransition } from '../viewTransition';
import { TelemetryHubContext } from './telemetryContext';
import { listMicrophones } from '../stt';
import {
	useEditorModel,
	lookup,
	setSolvedForFloat,
	editHelpers,
	bulkPatchConfig,
	bulkSetBasis
} from './canvas/useEditorModel';
import { usePersistence } from './canvas/usePersistence';
import { applyAssistantOps } from '../core/llm';
import { decideDesignerLeave } from './canvas/designerLeave';
import { useStageSize } from './canvas/useStageSize';
import { useZoomFit } from './canvas/useZoomFit';
import { useCanvasPointer } from './canvas/useCanvasPointer';
import { useKeyboard } from './canvas/useKeyboard';
import { useControls } from './canvas/useControls';
import { clampMenuToViewport } from './canvas/menuPosition';
import { buildMenuPreview } from './canvas/menuPreview';
import { innermostContainerAt } from './canvas/containerAt';
import { readStudioMonitor, writeStudioMonitor } from './canvas/studioMonitorPref';
import { studioHints } from './canvas/studioHints';
import { buildDebugInfo } from './canvas/debugInfo';
import { commonConfigFields, commonBasisMode } from './canvas/multiSelect';
import { usePaneSizes } from './canvas/usePaneSizes';
import { RAIL_ORDER, type SectionId } from './canvas/studioSections';
import { BUILTIN_THEMES, builtinGroups, builtinName } from '../core/builtinThemes';
import { useThemes } from './canvas/useThemes';
import { sackSummary, useSacks } from './canvas/useSacks';
import { useSavedLayouts } from './canvas/useSavedLayouts';
import { useBackground } from './canvas/useBackground';
import { useAutoTheme } from './canvas/useAutoTheme';
import { useDefEditor } from './canvas/useDefEditor';
import { useSplitters } from './canvas/useSplitters';
import { useStudioInit } from './canvas/useStudioInit';
import { recordWidgetRender } from './canvas/widgetProfile';
import type { EditorState, Extra, MonitorOption } from './canvas/types';
import type { SettingsTab } from './StudioSettingsPanel';
import mascotUrl from '../../assets/mascot.png';
import './Canvas.css';

// Register the built-in plugins (HA, Now Playing, MQTT, Stocks, AI Provider) before the first
// render. Idempotent + error-isolated: a plugin that throws during registration is recorded
// (pluginLoadErrors) and shown as "failed to load" in the Plugins list instead of taking
// Canvas down (it used to be five bare side-effect imports).
registerBuiltinPlugins();

// Lazy-loaded editor panels: each lives in its OWN chunk (loaded on demand) instead of the eager
// bundle. The PASSIVE overlay (not in edit mode) renders none of these, so it never loads them — that
// is the memory win. Most are studio-only; Inspector/Outline/MultiInspector ALSO render on an overlay
// IN EDIT MODE (Ctrl+E / tray "Edit layout"), so they load when edit mode is first entered — under the
// local <Suspense> wrapping the `{editMode && (…)}` block below, which keeps the desktop widgets visible
// while a chunk loads. The studio warms ALL of these on mount (effect below) so section-switching never
// suspends. StyleLayer is NOT lazy — both roles render it on every paint.
const Inspector = lazy(() => import('./Inspector'));
const ThemePreview = lazy(() => import('./ThemePreview'));
const TokenFields = lazy(() => import('./TokenFields'));
const Outline = lazy(() => import('./Outline'));
const NavRail = lazy(() => import('./NavRail'));
const Select = lazy(() => import('./Select'));
const SensorList = lazy(() => import('./SensorList'));
const ThemeList = lazy(() => import('./ThemeList'));
const StudioSettingsPanel = lazy(() => import('./StudioSettingsPanel'));
const BackgroundPanel = lazy(() => import('./BackgroundPanel'));
const PluginsPanel = lazy(() => import('./PluginsPanel'));
const DesignerListPanel = lazy(() => import('./DesignerListPanel'));
const MultiInspector = lazy(() => import('./MultiInspector'));

type Props = { studio?: boolean };

const GRID = 8;
const ALIGN_THRESHOLD = 6;
// What counts as a widget's interactive control for passive click-through (its rendered rect, if
// visible, becomes a catch region). A widget with none of these but marked interactive catches over
// its whole box. data-seekable="true" is the now-playing seek bar; data-interactive is an opt-in.
const INTERACTIVE_SELECTOR =
	'button, a[href], input, select, textarea, [data-interactive], [data-seekable="true"]';
// Docked-panel selector: a palette-widget drop over any of these is the panel's own (e.g. the
// Outline's container drop), so the stage-level drop handler bails on it.
const PANEL_SEL =
	'.outline, .inspector, .studio-bar, .powerbar, .theme-editor, .ctx, .nav-rail, .rail-panel, .designer-list, .designer-empty';

// Dispatch ONE control action: a thin lookup into the plugin action-handler registry (the
// side-effecting Tauri calls live in the plugins' command adapters, AGENTS.md §5/§6). The
// Now Playing plugin claims `media`; Home Assistant claims the `*` catch-all (any other
// {domain, service} is an HA service call, with the `ha.<entity>` sensor fallback). Re-throws
// handler failures so a macro run can record the failed step; single callers wrap it.
async function dispatchControl(sensor: string | undefined, action: MacroAction): Promise<void> {
	const handler = actionHandlerFor(action.domain);
	if (!handler) {
		console.warn(`no action handler registered for control domain "${action.domain}"`, action);
		return;
	}
	await handler(action, { sensor });
}

export default function Canvas({ studio = false }: Props) {
	// The widget palette (built-ins + any registered plugin widgets), with labels (8a). Computed once.
	const widgetTypes = useMemo(() => paletteItems(), []);
	// Registered plugins (Home Assistant, Now Playing, …), for the studio's Plugins section. Once.
	const pluginList = useMemo(() => listPlugins(), []);

	// Stable telemetry hub (item 5): one per Canvas, provided via Context (replaces setContext).
	// Lazy useState (not useRef(...).current) so it isn't a ref read during render — the hub is
	// created once and never replaced, so the value is a stable reference exactly as before.
	const [hub] = useState(() => createTelemetryHub());

	// Diagnostics bridge: every window (overlay + main + studio) answers the studio's Diagnostics-panel
	// poll with its heap/counts and obeys targeted debug commands (open devtools / toggle click-through).
	// Mounted once here so it covers both roles. No StrictMode in this app, so a single mount is correct.
	useEffect(() => {
		let teardown: (() => void) | undefined;
		void startDiagResponder(() => hub).then((un) => {
			teardown = un;
		});
		return () => teardown?.();
	}, [hub]);

	// This window's monitor key. In the studio this is switchable AND sticky across reloads (restored
	// from localStorage); overlays pin to their `?monitor=` param and ignore the stored choice.
	const [myMonitor, setMyMonitor] = useState<string>(
		() => monitorParam() ?? (studio ? readStudioMonitor() : null) ?? DEFAULT_MONITOR
	);
	const [monitorOptions, setMonitorOptions] = useState<MonitorOption[]>([]);

	// The seed floating layer (demo on the primary, empty on secondaries). Computed once. The demo is
	// the actual system/network/nowplaying TEMPLATES instantiated (core/templates.demoSeed) — the
	// default skin has one source of truth instead of a hand-built copy that drifts.
	const seedFloating = useMemo<Leaf[]>(() => (monitorParam() ? [] : demoSeed()), []);

	const model = useEditorModel(studio, seedFloating);
	const { state, dispatch, handleOp, commitOp, mutateNoSave } = model;
	const {
		monitor,
		library,
		selectedId,
		selectedIds,
		selectedTheme,
		themeLock,
		tokenOverrides,
		editingDefId,
		defEditBaseline,
		previewDef,
		savedBaseline,
		undoStack,
		redoStack,
		pendingExtras,
		saveSeq
	} = state;

	// Hand every plugin's `studio` capability the editor surface (StudioApi) so a plugin (e.g. the
	// AI Provider's layout assistant) can read the live monitor and apply model-proposed ops as one
	// undo step (mirrors setSolvedForFloat). Studio role only; the result is computed PURELY from
	// the current monitor before committing, so it never depends on the reducer running
	// synchronously. Re-runs (after the previous cleanups) whenever the monitor changes so the api
	// stays current; a throwing hook is logged and skipped, never fatal.
	useEffect(() => {
		if (!studio) return;
		const api: StudioApi = {
			monitor: () => monitor,
			apply: (ops) => {
				const r = applyAssistantOps(monitor, ops, (type) => `${type}-${editHelpers.rand()}`);
				commitOp((s) => ({
					monitor: r.monitor,
					selectedId: r.addedIds.length ? r.addedIds[r.addedIds.length - 1] : s.selectedId
				}));
				return { applied: r.applied, addedIds: r.addedIds, errors: r.errors };
			}
		};
		const cleanups: (() => void)[] = [];
		for (const p of pluginList) {
			if (!p.studio) continue;
			try {
				const cleanup = p.studio(api);
				if (cleanup) cleanups.push(cleanup);
			} catch (err) {
				console.warn(`plugin "${p.id}" studio hook failed`, err);
			}
		}
		return () => cleanups.forEach((c) => c());
	}, [studio, monitor, commitOp, pluginList]);

	// Theme state + actions (CSS resolution, themes/ file I/O, the editor dialog) — canvas/useThemes.
	const {
		themeCss,
		themeList,
		setThemeList,
		userThemeSwatches,
		themeRef: stateThemeRef,
		applyTheme,
		themeLabel,
		adoptTheme,
		setTheme,
		themeEditorOpen,
		setThemeEditorOpen,
		themeDraft,
		setThemeDraft,
		themeDraftName,
		setThemeDraftName,
		themeNameRef,
		openThemeEditor,
		saveThemeEditor,
		duplicateTheme,
		deleteTheme
	} = useThemes({ studio, selectedTheme, dispatch, commitOp });

	// Theme lock (studio Settings): true = one theme across all monitors (default), false = per-monitor.
	// Theme-only change → commit (a history no-op that triggers the disk write), mirroring setTheme.
	const setThemeLock = useCallback(
		(lock: boolean) => {
			dispatch({ type: 'patch', patch: { themeLock: lock } });
			commitOp(() => ({}));
		},
		[dispatch, commitOp]
	);
	// Flat theme option list for the Settings picker: (default) + every built-in + the user themes,
	// plus the current selection if it isn't otherwise listed (a removed/unknown name still shows).
	const themeOptions = useMemo(() => {
		const opts: { value: string; label: string }[] = [{ value: '', label: '(default)' }];
		for (const t of BUILTIN_THEMES) opts.push({ value: builtinName(t.id), label: t.name });
		for (const n of themeList) opts.push({ value: n, label: n });
		if (selectedTheme && !opts.some((o) => o.value === selectedTheme))
			opts.push({ value: selectedTheme, label: themeLabel(selectedTheme) });
		return opts;
	}, [themeList, selectedTheme, themeLabel]);

	// Edit mode (tray "Edit layout" / Ctrl+E). Entering disables click-through.
	const [editMode, setEditMode] = useState(false);

	// Transient "✓ saved" confirmation in the powerbar after an explicit Save reaches disk — positive
	// feedback proportional to the studio's most consequential action (pushing the layout to overlays).
	const [savedFlash, setSavedFlash] = useState(false);
	const savedFlashTimer = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
		},
		[]
	);

	// Cross-highlight (studio): the id currently hovered in EITHER the Outline tree or on the stage.
	// Hovering a tree row glows the matching widget/container; hovering a widget glows its tree row.
	const [hoverId, setHoverId] = useState<string | null>(null);

	// Studio left-rail nav: which section's panel is showing. Transient UI — never in EditorState, so
	// it doesn't touch undo/redo or the dirty diff.
	const [navSection, setNavSection] = useState<SectionId>('layouts');
	// The top-bar overflow (≡) menu: quick global access to the otherwise section-buried actions.
	const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
	// id → plugin name for the Sensors browser's "from X" badges. Built only while that section is
	// open (and rebuilt on entry, so a plugin connected/refreshed since launch gets badged); system
	// sensors map to none.
	const pluginSensorNameMap = useMemo(
		() => (navSection === 'sensors' ? pluginSensorNames() : new Map<string, string>()),
		[navSection]
	);
	// Which sensors stay sampled after the studio closes — and why. Walk THIS monitor's layout for each
	// widget's sensor demand (bound + formula refs); the per-sensor verdict (referenced → active &
	// names the widgets, cheap → always-on, else stops on close) feeds the Sensors list's status dots.
	const sensorRefs = useMemo(
		() =>
			collectSensorRefs(
				navSection === 'sensors' ? [{ key: myMonitor, layout: monitor }] : [],
				library
			),
		[navSection, myMonitor, monitor, library]
	);
	const sensorActivityFor = useCallback(
		(id: string) => sensorActivity(id, sensorRefs.get(id)),
		[sensorRefs]
	);
	// Plugins section: which plugin's detail/settings pane is showing (transient UI).
	const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
	// Settings section: which subsection the side list has open, and the app version for About.
	const [settingsTab, setSettingsTab] = useState<SettingsTab>('display');
	const [appVersion, setAppVersion] = useState<string | null>(null);
	useEffect(() => {
		if (!studio) return; // the About pane is studio-only
		getVersion()
			.then(setAppVersion)
			.catch(() => undefined);
	}, [studio]);

	const persistence = usePersistence(state, myMonitor);
	const { persistToDisk, writeBaseline, schedulePreviewWrite, clearPreviewWrite } = persistence;

	// The work area this overlay lays its flow tree into (logical px). Set on mount + resize.
	const [workArea, setWorkArea] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });

	// The editor stage + zoom-to-fit.
	const { ref: canvasRef, stageW, stageH } = useStageSize();

	// The selected monitor's logical size (the world dimensions); falls back until loaded.
	const monSel = useMemo(
		() => monitorOptions.find((o) => o.key === myMonitor),
		[monitorOptions, myMonitor]
	);
	const monSize = useMemo(
		() => (monSel ? { w: monSel.w, h: monSel.h } : { w: 1920, h: 1080 }),
		[monSel]
	);
	const monName = monSel?.name ?? '';

	// While designing a widget def, the stage is sized to the DEF (a widget-sized design canvas),
	// not the monitor — so the Widget designer is its own canvas in the window, not the monitor
	// overlay. Everything else (solve, world, zoom-to-fit) keys off `stageSize`.
	const editingDef = useMemo(
		() =>
			previewDef ??
			(editingDefId && library ? (library.defs.find((d) => d.id === editingDefId) ?? null) : null),
		[previewDef, editingDefId, library]
	);
	const designing = studio && editingDef != null;
	// A read-only template preview reuses the design canvas but locks editing (no Inspector/Outline,
	// no widget drag/menu/keyboard) until the user clones it into the library.
	const previewing = studio && previewDef != null;
	// --- conditional containers (show/hide a subtree at runtime) ---
	// Apply conditions only on the PASSIVE render (not while editing/previewing, and never in the
	// studio — there you must still see+edit hidden content). The set of hidden container ids drives
	// visibility:hidden in FlowNode; it recomputes as the referenced sensors / open-window list change.
	const conditionsActive = !editMode && !previewing;
	const hiddenIds = useConditionHidden(hub, monitor.root, conditionsActive);
	// Feed the open-window list (for appOpen conditions) only when it's actually needed.
	const hasAppOpenCondition = useMemo(
		() => collectConditions(monitor.root).some((c) => c.condition.kind === 'appOpen'),
		[monitor.root]
	);
	useEffect(() => {
		if (!conditionsActive || !hasAppOpenCondition) return;
		return startWindowSource(hub);
	}, [conditionsActive, hasAppOpenCondition, hub]);
	// Unsaved edits to the def open in the designer (its scoped tree vs the baseline captured on entry).
	// Drives the "save before leaving the designer?" prompt when a nav-rail icon is clicked mid-edit.
	const defDirty = editingDefId != null && defEditBaseline != null && monitor !== defEditBaseline;
	const stageSize = editingDef ? editingDef.size : monSize;

	// Control remaps (controls.json): overrides state + ref for the dispatch hooks (keyboard/pointer/
	// wheel read the ref synchronously), load/save helpers. setOverride/resetOverride/resetAll feed the
	// Settings → Controls panel (Phase 5); reloadControls is wired into useStudioInit (startup + watcher).
	const controls = useControls();
	const { overrides, overridesRef, reloadControls } = controls;

	const { panX, panY, zoom, setPan, fit } = useZoomFit({
		studio,
		// Re-fit when entering/leaving design mode (the key folds in the design context + size).
		myMonitor: designing ? `def:${editingDefId}` : myMonitor,
		monSize: stageSize,
		stageW,
		stageH,
		canvasRef,
		overrides: () => overridesRef.current
	});

	const worldStyle: React.CSSProperties = studio
		? {
				width: `${stageSize.w}px`,
				height: `${stageSize.h}px`,
				transform: `translate(${panX}px,${panY}px) scale(${zoom})`
			}
		: {};

	// Studio lays out into the stage box — the monitor work area normally, the def's size while
	// designing a widget (so its flow tree solves at the widget's own dimensions). Done during render
	// (store-previous pattern) rather than in a layout effect, so workArea tracks a monitor<->def swap
	// in the SAME render pass (no one-frame mis-solve flash, and no post-commit setState cascade).
	const [prevStageSize, setPrevStageSize] = useState<{ w: number; h: number } | null>(null);
	if (studio && (prevStageSize?.w !== stageSize.w || prevStageSize?.h !== stageSize.h)) {
		setPrevStageSize({ w: stageSize.w, h: stageSize.h });
		setWorkArea({ x: 0, y: 0, w: stageSize.w, h: stageSize.h });
	}

	const updateWorkArea = useCallback(async () => {
		if (studio) return; // the effect above owns the studio work area
		const wa = await monitorWorkArea();
		setWorkArea(wa ?? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
	}, [studio]);

	const worldRef = useRef<HTMLDivElement | null>(null);
	const { measured: measuredDom, measuredRef } = useMeasuredRects({
		worldRef,
		zoom: studio ? zoom : 1,
		deps: [monitor, workArea]
	});

	// --- derived layout (CSS-native; the solver is no longer used) ---
	// The browser lays out the flow tree AND floating GROUPS (FlowNode), and every rect is read back
	// by measuring the DOM (measuredDom). The only non-measured rects are floating PRIMITIVES, which
	// sit absolutely at their own stored rect. combinedSolved unions them into the single Solved-map
	// shape every consumer (renderables / containers / grid / drag / snap / click-through / float)
	// already reads — keyed exactly as the old solver keyed it.
	const floatingGroupBox = useCallback(
		(lf: Leaf): Rect => {
			const g = lf.unit as Group;
			const { size } = resolveGroup(g, library);
			const cfg = g.config ?? {};
			const num = (k: string, d: number) => (typeof cfg[k] === 'number' ? (cfg[k] as number) : d);
			return { x: num('x', 0), y: num('y', 0), w: num('w', size.w), h: num('h', size.h) };
		},
		[library]
	);
	const combinedSolved = useMemo(() => {
		const m = new Map(measuredDom);
		for (const lf of monitor.floating) {
			if (isGroup(lf.unit)) {
				if (!m.has(lf.id)) m.set(lf.id, floatingGroupBox(lf)); // seed box before the first measure
			} else {
				m.set(lf.id, { ...(lf.unit as WidgetInstance).rect }); // floating primitive: its stored rect
			}
		}
		return m;
	}, [measuredDom, monitor.floating, floatingGroupBox]);
	// floatNode (via handleOp) reads the live map; keep the module ref current.
	setSolvedForFloat(combinedSolved);
	const renderables = useMemo(
		() => collectRenderables(monitor, combinedSolved, library),
		[monitor, combinedSolved, library]
	);
	const containerRects = useMemo(
		() => (studio ? collectContainerRects(monitor, combinedSolved) : []),
		[studio, monitor, combinedSolved]
	);
	const gridPlaceholders = useMemo(
		() => (studio ? collectGridPlaceholders(monitor, combinedSolved) : []),
		[studio, monitor, combinedSolved]
	);
	// Draggable boundaries between adjacent fr children of a row/col (custom proportions + snap).
	const splitters = useMemo(
		() => (studio ? collectSplitters(monitor, combinedSolved) : []),
		[studio, monitor, combinedSolved]
	);
	// Splitter drag/keyboard/reset: live resize between adjacent fr children (or grid tracks),
	// committed on release — canvas/useSplitters.
	const { onSplitDown, onSplitMove, onSplitUp, onSplitReset, onSplitKey } = useSplitters({
		zoom,
		commitOp,
		mutateNoSave
	});
	// Look up a flow primitive's renderable (for selectId / group + def hooks) when FlowNode hands us
	// a leaf by its namespaced id.
	const renderablesById = useMemo(() => new Map(renderables.map((r) => [r.id, r])), [renderables]);
	// Overlay rendering prefs (taskbar awareness + z-order layer). Set from studio Settings, read on
	// the overlay (synced cross-window via the 'storage' event).
	const [overlayPrefs, setOverlayPrefs] = useOverlayPrefs();
	// Freshest prefs for the stable syncRects callback (which reads them without re-subscribing).
	// Mirrored in the commit effect S1 below (not during render).
	const overlayPrefsRef = useRef(overlayPrefs);
	// This window's role: the primary `main` overlay carries no ?monitor= param; secondary overlays do.
	// The main overlay is ALWAYS interactive (see overlayPresentation) so its webview can never get stuck
	// behind a click-through surface (e.g. an un-clickable crash page).
	const isMain = !studio && monitorParam() === null;
	// Windowed-debug mode paints an opaque background (styles.css) so the otherwise see-through overlay
	// surface reads as a normal window. The actual window flags are applied by the presentation effect
	// (below, once editMode/syncRects are in scope). The studio never participates.
	useEffect(() => {
		if (studio) return;
		const el = document.documentElement;
		el.classList.toggle('overlay-windowed', overlayPrefs.debugWindowed);
		return () => el.classList.remove('overlay-windowed');
	}, [studio, overlayPrefs.debugWindowed]);
	// Memory trail: persist this window's diagnostics to the rotating log file every interval so an
	// unattended (e.g. overnight) leak's climb survives a crash for post-mortem. Gated on windowed-debug
	// mode — off in normal runs so they stay quiet. (NB: it logs the JS heap, so it can't see a native
	// WebView2/compositor leak; cross-check the renderer's RSS in Task Manager for those.)
	useEffect(() => {
		if (!overlayPrefs.debugWindowed) return;
		return startMemoryTrail(() => hub);
	}, [hub, overlayPrefs.debugWindowed]);
	// The studio listens for each overlay's last layer-apply result (broadcast by applyOverlayLayer)
	// so Settings can show whether the wallpaper/below mode actually took on the overlay.
	const [layerStatus, setLayerStatus] = useState<string>('');
	useEffect(() => {
		if (!studio) return;
		const un = listen<{ layer: string; ok: boolean; detail: string; label: string }>(
			EVENTS.overlayLayerStatus,
			(e) => {
				const { layer, ok, detail, label } = e.payload;
				setLayerStatus(`${label}: ${layer} — ${ok ? 'ok' : 'FAILED'} (${detail})`);
			}
		);
		return () => {
			un.then((f) => f()).catch(() => undefined);
		};
	}, [studio]);
	// "Launch at login" (tauri-plugin-autostart). Read the OS state once in the studio; toggling
	// optimistically updates then reconciles with the actual post-write state (a denied write reverts).
	const [autostart, setAutostartState] = useState(false);
	useEffect(() => {
		if (studio) isAutostartEnabled().then(setAutostartState);
	}, [studio]);
	const toggleAutostart = useCallback((enabled: boolean) => {
		setAutostartState(enabled);
		setAutostart(enabled).then(setAutostartState);
	}, []);

	const tokenCss = useMemo(
		() => (Object.keys(tokenOverrides).length ? tokensToCss(tokenOverrides) : ''),
		[tokenOverrides]
	);
	const styleCss = useMemo(
		() =>
			assembleStyles({
				// Inject the DEFAULT_TOKENS :root base so the token vocabulary is the real runtime source
				// of truth — meters resolve bare var(--np-*) to a defined value, and the theme + overrides
				// (appended after) still win via the cascade.
				themeCss: [themeCss, tokenCss].filter(Boolean).join('\n'),
				library,
				monitor,
				includeDefaults: true
			}),
		[themeCss, tokenCss, library, monitor]
	);

	// Load every font family named ANYWHERE in the assembled stylesheet — the font tokens AND any
	// font-family set by raw theme/def/instance CSS — so a themed font actually @font-faces instead of
	// silently rendering as a fallback. Scans the same string that gets injected; ensureFont is
	// idempotent, so re-scanning on each change is cheap.
	useEffect(() => {
		for (const family of extractFontFamilies(styleCss)) ensureFont(family);
	}, [styleCss]);

	// --- background (wallpaper) layer ---------------------------------------------------------------
	// The spec lives on the monitor; the asset-URL cache, file list and patch helpers live in
	// canvas/useBackground. The overlay only shows a background when it sits BELOW windows (a
	// full-bleed in top-overlay mode would cover the user's apps); the studio always previews it.
	const { bg, resolveWallpaper, wallpaperFiles, refreshWallpapers, patchBg, setBgKind, clearBg } =
		useBackground({ studio, navSection, monitor, handleOp });
	// Wallpaper auto-theme (issue #15) — shared by the Background panel + the Themes section's token
	// overrides. Applies the derived map above any active theme via the setTokens op.
	const autoTheme = useAutoTheme({
		bg,
		resolveWallpaper,
		applyTokens: (tokens) => handleOp({ op: 'setTokens', tokens })
	});
	const showBackground = studio || overlayPrefs.overlayLayer !== 'top';

	// --- selection-derived state ---
	const selectedNode = useMemo(
		() => (selectedId ? lookup(selectedId, monitor) : null),
		[selectedId, monitor]
	);
	const selectedContainer = selectedNode && isContainer(selectedNode) ? selectedNode : null;
	// The selected container's solved box (plain id — flow-tree containers aren't group-namespaced),
	// so the Inspector can cap pad/gap to it (guardrail against collapsing the content out of view).
	const selectedContainerBox = selectedContainer
		? (combinedSolved.get(selectedContainer.id) ?? null)
		: null;
	const isGridCell = !!(
		selectedContainer && findParent(monitor.root, selectedContainer.id)?.kind === 'grid'
	);
	const selectedWidget =
		selectedNode && isLeaf(selectedNode) && !isGroup(selectedNode.unit)
			? (selectedNode.unit as WidgetInstance)
			: null;
	// The selected leaf's main-axis basis (fr = stretch, else fixed) — the leaf wrapper holds it,
	// not the unit, so the Inspector receives it separately to drive the widget's grow toggle.
	const selectedLeafBasis = selectedNode && isLeaf(selectedNode) ? selectedNode.basis : undefined;
	// The selected leaf's placement within its box (halign/valign), surfaced like basis so the
	// Inspector can offer per-widget left/center/right + top/middle/bottom alignment.
	const selectedLeafHalign = selectedNode && isLeaf(selectedNode) ? selectedNode.halign : undefined;
	const selectedLeafValign = selectedNode && isLeaf(selectedNode) ? selectedNode.valign : undefined;
	const selectedGroup =
		selectedNode && isLeaf(selectedNode) && isGroup(selectedNode.unit)
			? (selectedNode.unit as Group)
			: null;
	const selectedDef = useMemo((): WidgetDef | null => {
		const dId = selectedGroup?.def;
		if (!dId || !library) return null;
		return library.defs.find((d) => d.id === dId) ?? null;
	}, [selectedGroup, library]);

	// Manual-save baseline diff (item 2): the selected node as it was at the last save.
	const baseNode = useMemo(
		() =>
			studio && savedBaseline && selectedId ? lookup(selectedId, savedBaseline.monitor) : null,
		[studio, savedBaseline, selectedId]
	);
	const baseWidget =
		baseNode && isLeaf(baseNode) && !isGroup(baseNode.unit)
			? (baseNode.unit as WidgetInstance)
			: null;
	const baseContainer = baseNode && isContainer(baseNode) ? baseNode : null;
	const baseGroup =
		baseNode && isLeaf(baseNode) && isGroup(baseNode.unit) ? (baseNode.unit as Group) : null;
	const nodeIsNew = !!(studio && savedBaseline && selectedId && selectedNode && !baseNode);

	const editingDefName = previewDef
		? previewDef.name
		: editingDefId && library
			? (library.defs.find((d) => d.id === editingDefId)?.name ?? editingDefId)
			: '';

	const placement = useMemo<'flow' | 'floating' | null>(() => {
		if (selectedId === null) return null;
		if (monitor.floating.some((l) => l.id === selectedId)) return 'floating';
		if (findNode(monitor.root, selectedId)) return 'flow';
		return null;
	}, [selectedId, monitor]);

	// Source catalog entries (with friendly label/unit) for the selected widget's sensor dropdown.
	const sensorEntries = useMemo(
		() => (selectedWidget ? sourceCatalogEntries() : []),
		[selectedWidget]
	);
	const sensors = useMemo(
		() =>
			sensorCatalog(selectedWidget ? [...hub.sensorIds(), ...sensorEntries.map((e) => e.id)] : []),
		[selectedWidget, hub, sensorEntries]
	);
	// id → display metadata, so the Inspector's sensor typeahead shows "Kitchen Light" not ha.light.kitchen.
	const sensorMeta = useMemo(() => {
		const m: Record<string, { label?: string; unit?: string }> = {};
		for (const e of sensorEntries)
			if (e.label || e.unit) m[e.id] = { label: e.label, unit: e.unit };
		return m;
	}, [sensorEntries]);
	const configFields = useMemo(
		() => (selectedWidget ? (getMeta(selectedWidget.type)?.configFields ?? []) : []),
		[selectedWidget]
	);
	// Audio output devices for the spectrum widget's device picker (studio only — the inspector lives
	// there). Fetched once; an empty list just falls back to the "system default" option.
	const [audioOutputs, setAudioOutputs] = useState<{ id: string; name: string }[]>([]);
	useEffect(() => {
		if (!studio) return;
		invoke<{ id: string; name: string }[]>(COMMANDS.listAudioOutputs)
			.then(setAudioOutputs)
			.catch(() => undefined);
	}, [studio]);

	// Microphones for the transcribe widget's input picker (studio only). Labels need a prior mic
	// permission; until then they fall back to a short id (still selectable by deviceId).
	const [microphones, setMicrophones] = useState<{ id: string; name: string }[]>([]);
	useEffect(() => {
		if (!studio) return;
		listMicrophones()
			.then(setMicrophones)
			.catch(() => undefined);
	}, [studio]);

	// Monitors for the monitor-switch widget's monitor picker (studio only). Friendly EDID names where
	// known, falling back to the GDI device tag. Empty list just leaves the "Primary monitor" option.
	const [displayNames, setDisplayNames] = useState<{ id: string; name: string }[]>([]);
	useEffect(() => {
		if (!studio) return;
		invoke<{ gdi: string; friendly: string }[]>(COMMANDS.listDisplayNames)
			.then((list) => setDisplayNames(list.map((d) => ({ id: d.gdi, name: d.friendly || d.gdi }))))
			.catch(() => undefined);
	}, [studio]);

	// Dev / extra-instance flag — drives the "dev" badge in the studio title bar (main.rs); lets you
	// tell a --multi / debug instance apart from the installed release at a glance.
	const [devInstance, setDevInstance] = useState(false);
	useEffect(() => {
		if (!studio) return;
		invoke<boolean>(COMMANDS.isDevInstance)
			.then((v) => setDevInstance(Boolean(v)))
			.catch(() => undefined);
	}, [studio]);

	const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

	// --- multi-selection (2+ widgets) → the common-properties details pane ---
	const multiSelected = selectedIds.length > 1;
	const multiNodes = useMemo(
		() =>
			multiSelected
				? selectedIds
						.map((id) => lookup(id, monitor))
						.filter((n): n is NonNullable<typeof n> => n != null)
				: [],
		[multiSelected, selectedIds, monitor]
	);
	const multiItems = useMemo(
		() =>
			multiNodes.map((n) => ({
				id: n.id,
				label: isContainer(n)
					? `▦ ${n.kind} · ${n.id}`
					: isGroup(n.unit)
						? `group ${n.unit.name ?? n.id}`
						: `${(n.unit as WidgetInstance).type} · ${n.id}`
			})),
		[multiNodes]
	);
	const multiWidgets = useMemo(
		() =>
			multiNodes
				.filter((n) => isLeaf(n) && !isGroup(n.unit))
				.map((n) => (n as Leaf).unit as WidgetInstance),
		[multiNodes]
	);
	const multiFields = useMemo(() => commonConfigFields(multiWidgets), [multiWidgets]);
	// Shared sizing only when EVERY selected node is a flow leaf (floating leaves ignore basis).
	const multiBasis = useMemo(() => {
		if (!multiSelected || multiNodes.length === 0) return null;
		const flowLeaves = multiNodes.filter((n) => isLeaf(n) && findNode(monitor.root, n.id));
		if (flowLeaves.length !== multiNodes.length) return null;
		return commonBasisMode(flowLeaves.map((n) => (n as Leaf).basis));
	}, [multiSelected, multiNodes, monitor]);

	const canUndo = undoStack.length > 0;
	const canRedo = redoStack.length > 0;

	// dirty (item 2): immutable edits reassign these to new objects, so reference inequality = unsaved.
	const dirty =
		studio &&
		savedBaseline != null &&
		((!editingDefId && monitor !== savedBaseline.monitor) ||
			// While editing a def, `monitor` is the scoped tree; it's dirty once it diverges from the
			// def-edit baseline (so Save / Ctrl+S work mid-def-edit, as in Svelte).
			(editingDefId != null && defEditBaseline != null && monitor !== defEditBaseline) ||
			library !== savedBaseline.library ||
			selectedTheme !== savedBaseline.theme ||
			themeLock !== savedBaseline.themeLock ||
			tokenOverrides !== savedBaseline.tokens ||
			pendingExtras.length > 0);

	// --- interactive rects (passive click-through) ---
	// Click-through catches a click only over a widget's ACTUAL interactive controls (buttons, the
	// seek bar, …), derived by measuring those sub-elements in the rendered DOM — not the widget's
	// whole box. So a now-playing widget whose transport controls are hidden, or the empty letterbox
	// around contain-fit art, passes clicks through to the desktop. A widget that declares NO discrete
	// controls but is marked interactive still catches over its whole box (whole-widget interactivity).
	const interactiveItems = useCallback((): { rect: Rect; interactive?: boolean }[] => {
		const world = worldRef.current;
		const w0 = world?.getBoundingClientRect();
		const z = studio ? zoom : 1;
		const out: { rect: Rect; interactive?: boolean }[] = [];
		for (const r of renderables) {
			if (!(r.instance.interactive || getMeta(r.instance.type)?.interactive)) continue;
			const el = world?.querySelector<HTMLElement>(`[data-w="${r.id}"]`);
			if (!el || !w0) {
				// Pre-measure / not in the DOM → fall back to the widget box.
				out.push({ rect: measuredRef.current?.get(r.id) ?? r.rect, interactive: true });
				continue;
			}
			const targets = el.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR);
			if (targets.length === 0) {
				out.push({
					rect: screenRectToLayout(el.getBoundingClientRect(), w0, z),
					interactive: true
				});
				continue;
			}
			targets.forEach((t) => {
				const b = t.getBoundingClientRect();
				if (b.width >= 1 && b.height >= 1) {
					out.push({ rect: screenRectToLayout(b, w0, z), interactive: true });
				}
			});
		}
		return out;
	}, [renderables, studio, zoom, measuredRef]);
	// Latest values for callbacks that run outside the render (listeners / async).
	const interactiveItemsRef = useRef(interactiveItems);
	const editModeRef = useRef(editMode);
	// Sync effect S1: keep the refs the passive-overlay syncRects path reads current. Declared ABOVE
	// the effects that call syncRects (measured-rects + presentation) so those see the latest values
	// on every commit — these are the only refs read synchronously inside an effect body.
	useEffect(() => {
		overlayPrefsRef.current = overlayPrefs;
		interactiveItemsRef.current = interactiveItems;
		editModeRef.current = editMode;
	});

	const syncRects = useCallback(() => {
		const p = overlayPrefsRef.current;
		// Send the per-widget interactive rects only when the window is a passive overlay; when the WHOLE
		// window is interactive (edit mode, the main overlay, or windowed-debug) clear them. The studio is
		// always whole-window interactive too.
		const whole =
			studio ||
			isWholeWindowInteractive({
				windowed: p.debugWindowed,
				layer: p.overlayLayer,
				isMain,
				editMode: editModeRef.current
			});
		syncInteractiveRects(interactiveItemsRef.current(), whole).catch((err) =>
			console.warn('set_interactive_rects failed', err)
		);
	}, [studio, isMain]);

	// Overlay (CSS layout): the interactive rects come from the measured DOM, so re-sync whenever the
	// measured map changes (not just on save). Gated on a non-empty map so the first paint doesn't
	// blank the rects before measurement lands.
	useEffect(() => {
		if (!studio && measuredDom.size > 0) syncRects();
	}, [studio, measuredDom, syncRects]);

	// --- the save chokepoint bridge (saveLayout): the reducer bumps saveSeq on each commit; here we
	// run the studio/overlay branch. Cross-monitor extras are queued in the reducer's pendingExtras
	// (set by moveNodeToMonitor before the commit), so the studio preview write omits them. ---
	const firstSave = useRef(true);
	useEffect(() => {
		if (firstSave.current) {
			firstSave.current = false;
			return; // saveSeq starts at 0; don't write on mount
		}
		if (studio) {
			schedulePreviewWrite();
		} else {
			persistToDisk([]);
		}
	}, [saveSeq, studio, schedulePreviewWrite, persistToDisk]);

	// --- reloadLayout ---
	const reloadLayout = useCallback(async () => {
		const myMon = myMonitorRef.current;
		// historyReady=false up front (before the awaits) so neither the load nor any interim commit
		// is recorded as an edit (mirrors Svelte's first line). resetHistory below re-baselines.
		dispatch({ type: 'patch', patch: { historyReady: false } });
		const patch: Partial<EditorState> = {};
		let nextTheme: string | null = null;
		try {
			const raw = await invoke<string | null>(COMMANDS.loadLayout);
			const obj = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
			const saved = obj ? parseLayoutAny(obj) : null;
			const mon = saved?.monitors[myMon];
			if (mon) patch.monitor = mon;
			const lib = obj?.library;
			if (lib && typeof lib === 'object' && Array.isArray((lib as { defs?: unknown }).defs)) {
				patch.library = lib as Library;
			}
			// Theme: LOCKED (default) → the layout's global `theme` on every monitor; UNLOCKED → this
			// monitor's own `theme`, falling back to the global. `themeLock` absent ⇒ locked (back-compat).
			// An explicit '' (default tokens) on the monitor is honored — it's a string, so the ?? keeps it.
			const lock = obj?.themeLock !== false;
			patch.themeLock = lock;
			const t = lock ? obj?.theme : (mon?.theme ?? obj?.theme);
			if (typeof t === 'string' && t !== stateThemeRef.current) {
				patch.selectedTheme = t;
				nextTheme = t;
			}
			const tk = obj?.tokens;
			patch.tokenOverrides =
				tk && typeof tk === 'object' && !Array.isArray(tk) ? (tk as Record<string, string>) : {};
		} catch (err) {
			console.warn('load_layout failed; using default layout', err);
		}
		// historyReady=false during the load + interim awaits; clear pendingExtras; reset history;
		// set baseline — all folded into one dispatch so the loaded layout is the committed baseline.
		dispatch({ type: 'load', patch: { ...patch, historyReady: false, pendingExtras: [] } });
		// Write the loaded monitor into the ref synchronously so syncPrimaryOverlays (called right after
		// reloadLayout during init, before React commits the dispatch) decides primary-window
		// visibility from the post-load monitor — deterministic, like Svelte's synchronous `monitor = mon`.
		if (patch.monitor) monitorRef.current = patch.monitor;
		// Apply the theme css for the new selectedTheme (side-effect), then re-baseline + reset history.
		if (nextTheme !== null) await adoptTheme(nextTheme);
		dispatch({ type: 'resetHistory' });
		dispatch({ type: 'setBaseline' });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dispatch, adoptTheme]);
	// myMonitor latest, for reloadLayout/persist reading inside listeners. Mirrored in the commit
	// effect S3 near the end of the component (not during render).
	const myMonitorRef = useRef(myMonitor);

	// --- third-party plugin packages ---
	// Discover + apply the enabled ones once per window (both roles — an overlay needs an enabled
	// package's theme CSS for its instantiated widgets too), and re-scan when the Plugins section
	// opens so a freshly dropped folder shows up without a restart.
	useEffect(() => {
		void initPackages(hub);
	}, [hub]);
	useEffect(() => {
		if (studio && navSection === 'plugins') void refreshPackages();
	}, [studio, navSection]);

	// --- syncPrimaryOverlays (primary main window only) ---
	// monitorRef is mirrored in the commit effect S3; reloadLayout also writes it imperatively during
	// init so the first syncPrimaryOverlays sees the freshly-loaded monitor.
	const monitorRef = useRef(monitor);
	const syncPrimaryOverlays = useCallback(async () => {
		await reconcileOverlays();
		await setMainWindowVisible(monitorHasWidgets(monitorRef.current));
	}, []);

	// Warm the lazy panel chunks once on the studio so navigating between sections never suspends
	// mid-session. The passive OVERLAY skips this and stays lean; on an overlay these chunks load only
	// if/when edit mode is entered, under the local <Suspense> around the {editMode} block. The studio's
	// first paint may briefly suspend on a panel, but the window is just appearing so it is hidden.
	useEffect(() => {
		if (!studio) return;
		void Promise.all([
			import('./Inspector'),
			import('./Outline'),
			import('./NavRail'),
			import('./ThemePreview'),
			import('./TokenFields'),
			import('./SensorList'),
			import('./ThemeList'),
			import('./StudioSettingsPanel'),
			import('./BackgroundPanel'),
			import('./PluginsPanel'),
			import('./DesignerListPanel'),
			import('./MultiInspector'),
			import('./Select')
		]).catch(() => undefined);
	}, [studio]);

	// --- init (mount effect, non-idempotent) ---
	useStudioInit({
		studio,
		hub,
		updateWorkArea,
		reloadLayout,
		reloadControls,
		editMode: () => editModeRef.current,
		syncRects,
		syncPrimaryOverlays,
		applyTheme,
		setThemeList,
		setEdit: (v) => setEdit(v),
		setEditModeImmediate: () => {
			// studio: editMode=true with no click-through round-trip. Set the ref too so the
			// layout_changed guard (always-edit studio skips auto-reload) sees it without a render lag.
			editModeRef.current = true;
			setEditMode(true);
		},
		setMonitorOptions,
		clearPreviewWrite
	});

	// resize → updateWorkArea (svelte:window on:resize).
	useEffect(() => {
		const onResize = () => updateWorkArea();
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	}, [updateWorkArea]);

	// --- setEdit ---
	const setEdit = useCallback(
		(value: boolean) => {
			setEditMode(value);
			editModeRef.current = value;
			// Whole-window click-through + decorations follow `editMode` via the presentation effect below;
			// refresh the per-widget interactive rects now using the new mode.
			syncRects();
		},
		[syncRects]
	);

	// Overlay presentation: decorations / taskbar / z-order / whole-window click-through, derived in ONE
	// place (overlayPresentation) from the chosen layer, the windowed-debug pref, and the edit state, and
	// re-applied whenever any of them change (incl. on mount, which establishes passive vs. interactive —
	// so the main overlay starts interactive and a secondary starts click-through). The studio never
	// participates. This supersedes the old per-window setClickThrough(true) at init.
	useEffect(() => {
		if (studio) return;
		const input = {
			windowed: overlayPrefs.debugWindowed,
			layer: overlayPrefs.overlayLayer,
			isMain,
			editMode
		};
		void applyOverlayPresentation(overlayPresentation(input), overlayPrefs.overlayLayer);
		syncRects();
	}, [studio, isMain, editMode, overlayPrefs.debugWindowed, overlayPrefs.overlayLayer, syncRects]);

	// --- selection helpers ---
	const setSelection = useCallback(
		(ids: string[], primary: string | null) => dispatch({ type: 'setSelectedIds', ids, primary }),
		[dispatch]
	);
	const clearSelection = useCallback(
		() => dispatch({ type: 'setSelectedIds', ids: [], primary: null }),
		[dispatch]
	);

	// translateSelectedFloating: mutate (no save). Returns whether anything changed.
	const translateSelectedFloating = useCallback(
		(dx: number, dy: number): boolean => {
			let changed = false;
			mutateNoSave((s) => {
				const ids = new Set(
					s.selectedIds.length ? s.selectedIds : s.selectedId ? [s.selectedId] : []
				);
				if (!ids.size || (dx === 0 && dy === 0)) return {};
				const floating = s.monitor.floating.map((l) => {
					if (!ids.has(l.id)) return l;
					changed = true;
					if (isGroup(l.unit)) {
						const g = l.unit;
						const gx = typeof g.config?.x === 'number' ? g.config.x : 0;
						const gy = typeof g.config?.y === 'number' ? g.config.y : 0;
						return leaf({ ...g, config: { ...(g.config ?? {}), x: gx + dx, y: gy + dy } });
					}
					const u = l.unit as WidgetInstance;
					return leaf({ ...u, rect: { ...u.rect, x: u.rect.x + dx, y: u.rect.y + dy } });
				});
				if (!changed) return {};
				return { monitor: { ...s.monitor, floating } };
			});
			return changed;
		},
		[mutateNoSave]
	);

	const deleteSelected = useCallback(() => {
		commitOp((s) => {
			const ids = s.selectedIds.length ? s.selectedIds : s.selectedId ? [s.selectedId] : [];
			if (!ids.length) return {};
			let mon = s.monitor;
			for (const id of ids) {
				mon = mon.floating.some((l) => l.id === id)
					? { ...mon, floating: mon.floating.filter((l) => l.id !== id) }
					: { ...mon, root: removeNodeFromTree(mon, id) };
			}
			return { monitor: mon, selectedId: null, selectedIds: [] };
		});
	}, [commitOp]);

	// --- multi-select bulk edits (one commit → one undo step each) ---
	const focusOne = useCallback((id: string) => dispatch({ type: 'select', id }), [dispatch]);
	const patchSelectedConfig = useCallback(
		(key: string, value: unknown) => commitOp((s) => bulkPatchConfig(s, key, value)),
		[commitOp]
	);
	const setSelectedBasisAll = useCallback(
		(mode: 'fixed' | 'content' | 'grow') =>
			commitOp((s) =>
				bulkSetBasis(s, mode === 'grow' ? { fr: 1 } : mode === 'content' ? 'content' : undefined)
			),
		[commitOp]
	);

	// --- undo/redo/save (used by keyboard + studio bar) ---
	const undo = useCallback(() => dispatch({ type: 'undo' }), [dispatch]);
	const redo = useCallback(() => dispatch({ type: 'redo' }), [dispatch]);

	const commitSave = useCallback(async () => {
		if (!studio) return;
		clearPreviewWrite();
		const ok = await persistToDisk(pendingExtrasRef.current);
		if (!ok) {
			// Hard failure (disk full / file locked / permissions): keep `dirty` true and the pending
			// cross-monitor moves queued (so a retry re-attempts them), and tell the user plainly. Flashing
			// "✓ saved" + clearing the dirty cue here — as we used to — would hide real data loss.
			window.alert(
				'Could not save the layout to disk — your changes are NOT saved. ' +
					'Check that widgets.json is writable, then try again.'
			);
			return;
		}
		dispatch({ type: 'patch', patch: { pendingExtras: [] } });
		dispatch({ type: 'setBaseline' });
		// Flash a transient confirmation in the powerbar (the write reached disk → the overlays reload).
		setSavedFlash(true);
		if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
		savedFlashTimer.current = window.setTimeout(() => setSavedFlash(false), 2200);
	}, [studio, clearPreviewWrite, persistToDisk, dispatch]);
	// Mirrored in the commit effect S3 (read only from the studio-close listener).
	const pendingExtrasRef = useRef(pendingExtras);
	const commitSaveRef = useRef(commitSave);

	// Window-close guard (studio only): if there are unsaved changes, PROMPT to save / discard / keep
	// editing instead of silently closing (the studio live-previews edits to disk, so a blind close
	// would just keep them). Registered once; the handler reads the latest dirty/extras/save/revert
	// via refs. `pendingExtras` (deferred cross-monitor moves) count as unsaved too.
	useEffect(() => {
		if (!studio) return;
		let unlisten: () => void = () => undefined;
		onStudioCloseRequested(async () => {
			// Always close. `window.confirm` is unreliable in the webview (it can silently return false,
			// which previously TRAPPED the close — the ✕ did nothing), and the studio live-previews every
			// edit straight to disk, so closing loses nothing. Persist any not-yet-written work (e.g.
			// queued cross-monitor moves) first; an explicit discard is available via "cancel edits".
			try {
				if (dirtyRef.current || pendingExtrasRef.current.length > 0) await commitSaveRef.current();
			} catch (err) {
				console.warn('save on studio close failed', err);
			}
			// While `main` is destroyed to reclaim its renderer (empty primary), nothing drives overlay
			// reconcile. The studio is the editing surface, so on close it applies the final layout: spawn
			// /close secondary overlays for the edited monitors, and bring `main` back if the primary was
			// re-populated. Both are idempotent no-ops when nothing changed / `main` already exists.
			try {
				await reconcileOverlays();
				await recreateMain();
			} catch (err) {
				console.warn('overlay reconcile on studio close failed', err);
			}
			return true;
		}).then((u) => {
			unlisten = u;
		});
		return () => unlisten();
	}, [studio]);

	const savedBaselineRef = useRef(savedBaseline); // mirrored in the commit effect S3
	// Restore the editor AND the on-disk layout to the saved baseline, reverting the live preview.
	// We write the baseline values DIRECTLY (writeBaseline) rather than via persistToDisk because
	// the reducer's revert set lags a render — the disk write must use the baseline immediately.
	const revertDraftToDisk = useCallback(async () => {
		if (!savedBaselineRef.current) return;
		const b = savedBaselineRef.current;
		dispatch({ type: 'revertToBaseline' });
		clearPreviewWrite();
		await writeBaseline(b, myMonitorRef.current);
	}, [dispatch, clearPreviewWrite, writeBaseline]);

	const cancelEdits = useCallback(async () => {
		if (!studio || !dirtyRef.current || !savedBaselineRef.current) return;
		if (!window.confirm('Discard all unsaved changes since the last save?')) return;
		// drop out of any def edit too, clear selection, revert, re-apply theme, reset history.
		dispatch({
			type: 'patch',
			patch: { editingDefId: null, savedMonitor: null, selectedId: null, selectedIds: [] }
		});
		await revertDraftToDisk();
		applyTheme();
		dispatch({ type: 'resetHistory' });
	}, [studio, dispatch, revertDraftToDisk, applyTheme]);
	const dirtyRef = useRef(dirty); // mirrored in the commit effect S3

	// --- sacks (item 10): export the studio's shareable state, import + merge one back ---
	const { sackInfos, exportSack, importSack } = useSacks({
		studio,
		navSection,
		editingDefId,
		selectedTheme,
		library,
		tokenOverrides,
		commitOp,
		themes: { themeLabel, setThemeList, adoptTheme }
	});

	// --- saved layouts: name the current monitor's arrangement, load it back, delete (named slots) ---
	const { layoutNames, saveCurrentLayout, loadSavedLayout, deleteSavedLayout } = useSavedLayouts({
		studio,
		navSection,
		editingDefId,
		monitorRef,
		commitOp
	});

	// Entering a def edit (from anywhere) switches to the Widget designer section, where its
	// widget-sized design canvas is revealed. Done during render (store-previous pattern) so it isn't
	// a post-commit setState cascade; fires on the transition of editingDefId to a non-null value.
	const [prevEditingDefId, setPrevEditingDefId] = useState(editingDefId);
	if (editingDefId !== prevEditingDefId) {
		setPrevEditingDefId(editingDefId);
		if (studio && editingDefId != null) setNavSection('widget-designer');
	}

	// Settings: remove all widgets on this monitor (undoable; Save to apply).
	const clearMonitor = useCallback(() => {
		if (
			!window.confirm(
				'Remove all widgets on this monitor?\n\nIt clears immediately and writes through to the desktop overlays. Undo with Ctrl+Z right away — undo is lost once you open the widget designer.'
			)
		)
			return;
		commitOp(() => ({
			monitor: { root: emptyRoot(), floating: [] },
			selectedId: null,
			selectedIds: []
		}));
	}, [commitOp]);

	// Context-menu state (5d). Declared here — ahead of switchMonitor and the widget/outline/canvas
	// handlers that call setMenu — so setMenu is never referenced before its declaration. `cellIndex`
	// is set only when opened from an empty grid cell → "Add inside" targets that cell. `wx/wy` capture
	// the opening click in WORLD coords (computed in the opening handlers, where DOM reads are legal)
	// so menuStack can hit-test during render without touching a ref/the DOM.
	const [menu, setMenu] = useState<{
		x: number;
		y: number;
		id: string;
		cellIndex?: number;
		wx?: number;
		wy?: number;
	} | null>(null);

	// --- studio: switch monitor ---
	const switchMonitor = useCallback(
		async (key: string) => {
			if (key === myMonitorRef.current) return;
			if (dirtyRef.current) {
				if (!window.confirm('Discard unsaved changes to this monitor and switch?')) return;
				await revertDraftToDisk();
			}
			setMyMonitor(key);
			// eslint-disable-next-line react-hooks/immutability -- eager latest-ref sync (mirrors the ref-sync effect); read by later async steps in this handler
			myMonitorRef.current = key;
			if (studio) writeStudioMonitor(key); // sticky across reloads
			dispatch({ type: 'patch', patch: { selectedId: null, selectedIds: [] } });
			setMenu(null);
			dispatch({ type: 'replaceMonitor', monitor: { root: emptyRoot(), floating: [] } });
			await reloadLayout();
		},
		[studio, dispatch, revertDraftToDisk, reloadLayout]
	);
	// A sticky choice can point at a monitor that's since been disconnected. Once the live options
	// load, fall back to the primary ('default', always present) so the studio never edits an
	// off-screen monitor or shows a blank picker. Runs once, after the first options arrive.
	const monitorValidated = useRef(false);
	useEffect(() => {
		if (!studio || monitorOptions.length === 0 || monitorValidated.current) return;
		monitorValidated.current = true;
		if (!monitorOptions.some((o) => o.key === myMonitorRef.current)) {
			void switchMonitor(DEFAULT_MONITOR);
		}
	}, [studio, monitorOptions, switchMonitor]);

	// --- def editor entry points (studio bar) ---
	// The wrappers (fold-open-def + new/open/clone/preview/rename/delete) live in canvas/useDefEditor;
	// previewing stays mirrored here too for the canvas-level handlers (context menu / drag / keys).
	const previewingRef = useRef(previewing); // mirrored in the commit effect S3
	// The live-state mirror (read by moveNodeToMonitor + the def editor's in-use check, both at event
	// time). Mirrored in the commit effect S3.
	const stateRef = useRef(state);
	const {
		foldOpenDef,
		startNewWidget,
		openExistingDef,
		cloneDefToEdit,
		newFromTemplate,
		previewTemplate,
		clonePreview,
		closePreview,
		renameWidget,
		deleteWidget
	} = useDefEditor({ editingDefId, previewing, stateRef, dispatch, handleOp });
	// Pick a studio section from the nav rail. While a widget def is open the rail used to be a dead
	// modal (clicks no-opped, which reads as broken); instead a click now leaves the designer. An
	// edited def asks first (Done saves it); a read-only/unedited def leaves silently. foldOpenDef does
	// the actual Done (endDefEdit) / discard-preview (endPreview).
	const navToSection = useCallback(
		(id: SectionId) => {
			if (designing) {
				const action = decideDesignerLeave(
					{ previewing, dirty: defDirty, name: editingDefName },
					(m) => window.confirm(m)
				);
				if (action === 'stay') return;
				foldOpenDef();
			}
			// Cross-fade the section swap (View Transitions where supported): snapshots the old + new
			// panels and blends them, which both polishes the change AND avoids the stage flashing
			// through behind the incoming panel. flushSync so the new section is in the DOM when the
			// transition captures its "after" snapshot.
			startViewTransition(() => flushSync(() => setNavSection(id)));
		},
		[designing, previewing, defDirty, editingDefName, foldOpenDef]
	);
	// =========================================================================================
	// Drag / drop (WidgetHost callbacks). These are transient — onChange mutates without saving;
	// onCommit/onDrop commit (saveLayout). The drop-indicator / hint / guides are local UI state.
	// =========================================================================================
	const [guideXs, setGuideXs] = useState<number[]>([]);
	const [guideYs, setGuideYs] = useState<number[]>([]);
	const [dropIntoFlow, setDropIntoFlow] = useState(true);
	const [dropIntoCells, setDropIntoCells] = useState(false);
	const [dropBar, setDropBar] = useState<Rect | null>(null);
	const [dropZone, setDropZone] = useState<Rect | null>(null);
	const [dragHint, setDragHint] = useState<{ x: number; y: number; text: string } | null>(null);
	// dropIndicator + draggingId are bookkeeping read synchronously across dragover→commit; refs.
	const dropIndicatorRef = useRef<Drop | null>(null);
	const draggingIdRef = useRef<string | null>(null);

	// canvas / world coordinate transforms (port LITERALLY).
	const toCanvas = useCallback(
		(x: number, y: number): { x: number; y: number } => {
			const el = canvasRef.current;
			if (!el) return { x, y };
			const r = el.getBoundingClientRect();
			return { x: x - r.left, y: y - r.top };
		},
		[canvasRef]
	);
	const panRef = useRef({ panX, panY, zoom }); // mirrored in the commit effect S3
	const toWorld = useCallback(
		(x: number, y: number): { x: number; y: number } => {
			const el = canvasRef.current;
			if (!el) return { x, y };
			const r = el.getBoundingClientRect();
			const p = panRef.current;
			return { x: (x - r.left - p.panX) / p.zoom, y: (y - r.top - p.panY) / p.zoom };
		},
		[canvasRef]
	);

	// Latest live values for the drag math (read synchronously — no stale closure).
	// The combined (measured-flow + solver-floating) map drives drag/drop/hit-test, so targeting
	// aligns with what the browser actually laid out.
	// All mirrored in the commit effect S3 (read only from drag/keyboard/menu event handlers).
	const solvedRef = useRef(combinedSolved);
	const renderablesRef = useRef(renderables);
	const monitorForDragRef = useRef(monitor);
	const selectedIdsRef = useRef(selectedIds);

	const computeDropBar = useCallback(
		(p: { x: number; y: number }, dragging: string): Rect | null => {
			const mon = monitorForDragRef.current;
			const sol = solvedRef.current;
			for (const lf of flowLeaves(mon.root)) {
				if (lf.id === dragging) continue;
				const r = sol.get(lf.id);
				if (!r) continue;
				if (p.x < r.x || p.x >= r.x + r.w || p.y < r.y || p.y >= r.y + r.h) continue;
				const parent = findParent(mon.root, lf.id);
				if (!parent) continue;
				if (parent.kind === 'col') {
					const after = p.y >= r.y + r.h / 2;
					return { x: r.x, y: (after ? r.y + r.h : r.y) - 1, w: r.w, h: 2 };
				}
				const after = p.x >= r.x + r.w / 2;
				return { x: (after ? r.x + r.w : r.x) - 1, y: r.y, w: 2, h: r.h };
			}
			return null;
		},
		[]
	);

	const computeDropZone = useCallback((drop: Drop | null, bar: Rect | null): Rect | null => {
		if (!drop || bar) return null;
		const mon = monitorForDragRef.current;
		const box = solvedRef.current.get(drop.parentId);
		if (!box) return null;
		const parent = findNode(mon.root, drop.parentId);
		if (parent && isContainer(parent) && parent.kind === 'grid') {
			return gridCellRects(parent, box)[drop.index] ?? box;
		}
		return box;
	}, []);

	const onChange = useCallback(
		(e: { id: string; rect: WidgetInstance['rect'] }) => {
			const { id, rect } = e;
			const mon = monitorForDragRef.current;
			const selIds = selectedIdsRef.current;
			const lf = mon.floating.find((l) => l.id === id);
			const isGroupLeaf = !!lf && isGroup(lf.unit);
			// Group move (item 3): translate the whole multi-selection by the per-frame delta. The
			// dragged item's current box is its stored rect (primitive) or its config box (group).
			if (selIds.length > 1 && selIds.includes(id)) {
				const curRect = lf
					? isGroupLeaf
						? floatingGroupBox(lf)
						: (lf.unit as WidgetInstance).rect
					: null;
				if (curRect) {
					setGuideXs([]);
					setGuideYs([]);
					translateSelectedFloating(rect.x - curRect.x, rect.y - curRect.y);
					return;
				}
			}
			const peers = renderablesRef.current
				.filter((r) => r.movable && r.id !== id)
				.map((r) => r.rect);
			const snapped = snapRectToPeers(rect, peers, ALIGN_THRESHOLD);
			setGuideXs(snapped.guideXs);
			setGuideYs(snapped.guideYs);
			// A floating group's position+size live in its config (config.x/y/w/h), not a unit rect.
			mutateNoSave((s) =>
				isGroupLeaf
					? patchFloatingGroupBox(s, id, snapped.rect)
					: patchFloating(s, id, { rect: snapped.rect })
			);
		},
		[translateSelectedFloating, mutateNoSave, floatingGroupBox]
	);

	// (A right-button free-move passes {skipFlow} here, but it's intentionally ignored: skipFlow is
	// already enforced upstream in onDragOver — allowDock && !skipFlow keeps dropIndicatorRef null —
	// so the dock branch below is simply never taken for a free-move.)
	const onCommit = useCallback(() => {
		setGuideXs([]);
		setGuideYs([]);
		setDragHint(null);
		const dropIndicator = dropIndicatorRef.current;
		const draggingId = draggingIdRef.current;
		// A floating widget released over the flow tree docks into that slot.
		if (dropIndicator && draggingId) {
			const id = draggingId;
			commitOp((s) => {
				const lf = s.monitor.floating.find((l) => l.id === id);
				if (!lf) return {};
				const floating = s.monitor.floating.filter((l) => l.id !== id);
				const root = dropIndicator.merge
					? editHelpers.wrapLeafWith(s.monitor.root, dropIndicator.merge, id, lf)
					: insertChild(s.monitor.root, dropIndicator.parentId, lf, dropIndicator.index);
				return { monitor: { ...s.monitor, floating, root }, selectedId: id };
			});
		} else {
			commitOp(() => ({})); // saveLayout() (no dock) — commit the drag's onChange edits
		}
		dropIndicatorRef.current = null;
		setDropBar(null);
		setDropZone(null);
		draggingIdRef.current = null;
	}, [commitOp]);

	const onDragOver = useCallback(
		(e: { id: string; x: number; y: number; skipFlow?: boolean }) => {
			const { id } = e;
			const w = toWorld(e.x, e.y);
			const c = toCanvas(e.x, e.y);
			draggingIdRef.current = id;
			const mon = monitorForDragRef.current;
			// A right-button free-move (skipFlow) never docks, regardless of the "into grids" toggle.
			const allowDock =
				(!mon.floating.some((l) => l.id === id) || dropIntoFlowRef.current) && !e.skipFlow;
			const drop = allowDock
				? dropTarget(mon.root, solvedRef.current, w, id, dropIntoCellsRef.current)
				: null;
			dropIndicatorRef.current = drop;
			const bar = !drop || drop.into || drop.merge ? null : computeDropBar(w, id);
			setDropBar(bar);
			setDropZone(computeDropZone(drop, bar));
			if (drop) {
				const parent = findNode(mon.root, drop.parentId);
				const kind = parent && isContainer(parent) ? parent.kind : 'flow';
				setDragHint({ x: c.x, y: c.y, text: `▦ into ${kind}` });
			} else {
				// If this floating widget WOULD have docked but the "into grids" toggle is off, say so —
				// otherwise a widget that refuses to dock reads as a bug rather than a switched-off mode.
				const dockOff =
					mon.floating.some((l) => l.id === id) && !dropIntoFlowRef.current && !e.skipFlow;
				const wouldDock =
					dockOff && dropTarget(mon.root, solvedRef.current, w, id, dropIntoCellsRef.current);
				if (wouldDock) {
					setDragHint({ x: c.x, y: c.y, text: '⊕ float · docking off (into grids)' });
				} else {
					const lf = mon.floating.find((l) => l.id === id);
					const pos = lf && !isGroup(lf.unit) ? (lf.unit as WidgetInstance).rect : null;
					const px = Math.round(pos ? pos.x : w.x);
					const py = Math.round(pos ? pos.y : w.y);
					setDragHint({ x: c.x, y: c.y, text: `⊕ float · ${px}, ${py}` });
				}
			}
		},
		[toWorld, toCanvas, computeDropBar, computeDropZone]
	);
	const dropIntoFlowRef = useRef(dropIntoFlow); // mirrored in the commit effect S3
	const dropIntoCellsRef = useRef(dropIntoCells); // mirrored in the commit effect S3

	const onDrop = useCallback(
		(e: { id: string; x: number; y: number }) => {
			const { id } = e;
			const { x, y } = toWorld(e.x, e.y);
			dropIndicatorRef.current = null;
			setDropBar(null);
			setDropZone(null);
			draggingIdRef.current = null;
			setDragHint(null);
			commitOp((s) => {
				const drop = dropTarget(
					s.monitor.root,
					solvedRef.current,
					{ x, y },
					id,
					dropIntoCellsRef.current
				);
				if (drop?.merge) {
					const dragged = findNode(s.monitor.root, id);
					if (dragged)
						return {
							monitor: {
								...s.monitor,
								root: editHelpers.wrapLeafWith(s.monitor.root, drop.merge, id, dragged)
							},
							selectedId: id
						};
					return { selectedId: id };
				} else if (drop) {
					return {
						monitor: {
							...s.monitor,
							root: moveNode(s.monitor.root, id, drop.parentId, drop.index)
						},
						selectedId: id
					};
				}
				// float at the cursor (floatNode reads the live solved map via setSolvedForFloat).
				const node = findNode(s.monitor.root, id);
				if (!node || !isLeaf(node)) return { selectedId: id };
				const r = solvedRef.current.get(id);
				const lf = editHelpers.floatingLeafFrom(node, x, y, r);
				return {
					monitor: {
						...s.monitor,
						root: removeNodeFromTree(s.monitor, id),
						floating: [...s.monitor.floating, lf]
					},
					selectedId: id
				};
			});
		},
		[toWorld, commitOp]
	);

	const onSelect = useCallback(
		(e: { id: string }) => dispatch({ type: 'selectClick', id: e.id }),
		[dispatch]
	);

	// A widget asked to actuate (HA light toggle, now-playing transport, or a button's macro).
	// Side-effecting Tauri calls live here, not in the prop-only meters (AGENTS.md §6). Each control
	// is one action (HA / media); a `macro` event carries an `actions` list run in sequence.
	const onWidgetControl = useCallback(
		async (e: {
			id: string;
			sensor?: string;
			domain: string;
			service: string;
			data?: Record<string, unknown>;
		}) => {
			const { sensor, domain, service, data } = e;
			// A macro: run its actions in order (an ordered action list). Continue-on-error so one
			// offline call doesn't abort the rest; log any failed steps for debugging.
			if (domain === 'macro') {
				const actions = normalizeMacro((data as { actions?: unknown } | undefined)?.actions);
				const results = await runMacro(actions, (a) => dispatchControl(sensor, a));
				const failed = results.filter((r) => !r.ok);
				if (failed.length)
					console.warn(`macro: ${failed.length}/${results.length} action(s) failed`);
				return;
			}
			try {
				await dispatchControl(sensor, { domain, service, data });
			} catch (err) {
				// Non-fatal: the next state_changed / media telemetry tick reconciles the widget anyway.
				console.warn('control failed', err);
			}
		},
		[]
	);

	// =========================================================================================
	// Context menu (5d). (The `menu` state itself is declared earlier, before switchMonitor.)
	// =========================================================================================
	// Context-menu HOVER PREVIEW: the structural op (split / add inside / add beside) under the pointer
	// or keyboard focus in the menu. A read-only ghost — never mutates the model, undo, or disk (the
	// preview rects are derived analytically from the measured boxes). Cleared when the menu closes.
	const [previewOp, setPreviewOp] = useState<LayoutOp | null>(null);
	// Ghost rects for the hovered/focused menu item, derived analytically from the measured boxes
	// (gridPlaceholders supply the empty-cell targets). Purely additive — no model/undo/disk effect.
	const previewShapes = useMemo(
		() =>
			previewOp
				? buildMenuPreview(previewOp, monitor, combinedSolved, gridPlaceholders, workArea)
				: [],
		[previewOp, monitor, combinedSolved, gridPlaceholders, workArea]
	);
	// The menu opens at the cursor but is clamped inside the window so it isn't clipped at the
	// right/bottom edges. We render at the cursor first, then measure the box and shift it back in a
	// layout effect (runs before paint → no visible jump).
	const ctxRef = useRef<HTMLDivElement | null>(null);
	const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
	// When the menu CLOSES, revert the hover preview and clear the clamped position. Done during render
	// (store-previous pattern) — these were two menu-keyed effects whose synchronous setState on close
	// is exactly what set-state-in-effect flags. Opening/repointing is handled by the layout effect
	// below (a DOM measurement, which the rule allows).
	const [prevMenu, setPrevMenu] = useState(menu);
	if (menu !== prevMenu) {
		setPrevMenu(menu);
		if (!menu) {
			setPreviewOp(null);
			setMenuPos(null);
		}
	}
	useLayoutEffect(() => {
		if (!menu) return; // closing is handled during render (above)
		const el = ctxRef.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		setMenuPos(
			clampMenuToViewport(menu.x, menu.y, r.width, r.height, window.innerWidth, window.innerHeight)
		);
	}, [menu]);

	// a11y (ARIA menu): tag the rendered items as menuitems, move focus to the first on open, and
	// restore focus to wherever it was when the menu closes. A stack re-point keeps focus inside the
	// menu. Roving Arrow/Home/End + Esc/Tab-to-close live in onMenuKeyDown.
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	const hadMenuRef = useRef(false);
	useEffect(() => {
		const el = ctxRef.current;
		if (menu && el) {
			if (!hadMenuRef.current) restoreFocusRef.current = document.activeElement as HTMLElement;
			hadMenuRef.current = true;
			const items = Array.from(el.querySelectorAll<HTMLButtonElement>('button'));
			items.forEach((b) => {
				b.setAttribute('role', 'menuitem');
				b.tabIndex = -1;
			});
			if (!el.contains(document.activeElement)) items[0]?.focus();
		} else if (!menu && hadMenuRef.current) {
			hadMenuRef.current = false;
			restoreFocusRef.current?.focus?.();
			restoreFocusRef.current = null;
		}
	}, [menu]);

	const containerAt = useCallback(
		(world: { x: number; y: number }): string =>
			innermostContainerAt(containerRectsRef.current, world, monitorForDragRef.current.root.id),
		[]
	);
	const containerRectsRef = useRef(containerRects); // mirrored in the commit effect S3

	// menu-derived state.
	const menuNode = menu
		? menu.id === '__canvas__'
			? monitor.root
			: lookup(menu.id, monitor)
		: null;
	const menuLeaf = menuNode && isLeaf(menuNode) ? menuNode : null;
	const menuGroup = menuLeaf && isGroup(menuLeaf.unit) ? (menuLeaf.unit as Group) : null;
	const menuId = menu?.id ?? null;
	const menuFloating = menuId !== null && monitor.floating.some((l) => l.id === menuId);
	const menuCanCollapse =
		menuNode !== null && isContainer(menuNode) && menuNode.children.some(isContainer);
	// A row/col/grid with ≥2 children can be reset to an even proportional split (undo a custom drag).
	const menuCanDistribute =
		menuNode !== null && isContainer(menuNode) && menuNode.children.length >= 2;
	const menuParentId =
		menuId && menuId !== '__canvas__' ? (findParent(monitor.root, menuId)?.id ?? null) : null;
	// A row/col container can be FLIPPED to the other orientation (context-menu "Convert to …").
	const menuConvertKind: Container['kind'] | null =
		menuNode && isContainer(menuNode) && (menuNode.kind === 'row' || menuNode.kind === 'col')
			? menuNode.kind === 'row'
				? 'col'
				: 'row'
			: null;
	// The right-click stack (5d, item 8): every selectable thing under the cursor — overlapping
	// widgets first (front-to-back), then the containers/grid cells nesting them (smallest first).
	// Picking an entry re-points the menu at it, so you can act on a widget OR any container around it.
	const menuStack = useMemo<{ id: string; label: string }[]>(() => {
		if (!menu || !studio || menu.wx == null || menu.wy == null) return [];
		const wx = menu.wx;
		const wy = menu.wy;
		// Overlapping widgets first (front-to-back, deduped by selectId), then the containers/grid cells
		// nesting them (smallest first). Reads the live renderables/containerRects directly (no refs);
		// the opening click's WORLD coords were captured in the handler, so no DOM read is needed here.
		const seen = new Set<string>();
		const widgets: { id: string; label: string }[] = [];
		for (let i = renderables.length - 1; i >= 0; i--) {
			const r = renderables[i];
			const b = r.rect;
			if (wx < b.x || wx >= b.x + b.w || wy < b.y || wy >= b.y + b.h) continue;
			if (seen.has(r.selectId)) continue;
			seen.add(r.selectId);
			widgets.push({ id: r.selectId, label: `${r.instance.type} · ${r.selectId}` });
		}
		const rootId = monitor.root.id;
		const containers = containerRects
			.filter(
				(c) =>
					c.id !== rootId &&
					wx >= c.rect.x &&
					wx < c.rect.x + c.rect.w &&
					wy >= c.rect.y &&
					wy < c.rect.y + c.rect.h
			)
			.sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h)
			.map((c) => ({ id: c.id, label: `▦ ${c.kind} · ${c.id}` }));
		return [...widgets, ...containers];
	}, [menu, studio, renderables, containerRects, monitor]);

	// A right-button free-move (WidgetHost) arms this so the contextmenu that trails the drag is
	// swallowed exactly once — by whichever entry point it lands on (the widget's handleContextMenu
	// via the suppressContextMenu prop, or onCanvasContextMenu if grid-snap drift lands it on bare
	// canvas). The setTimeout safety-clears it if no contextmenu follows on this platform.
	const suppressNextCtxRef = useRef(false);
	const armSuppressCtx = useCallback(() => {
		suppressNextCtxRef.current = true;
		setTimeout(() => {
			suppressNextCtxRef.current = false;
		}, 0);
	}, []);
	const consumeSuppressCtx = useCallback(() => {
		if (suppressNextCtxRef.current) {
			suppressNextCtxRef.current = false;
			return true;
		}
		return false;
	}, []);

	const onWidgetContextMenu = useCallback(
		(e: { id: string; x: number; y: number }) => {
			const w = toWorld(e.x, e.y);
			setMenu({ x: e.x, y: e.y, id: e.id, wx: w.x, wy: w.y });
		},
		[toWorld]
	);
	// Outline rows open the same node menu (the rows name nodes, so no hit-testing needed). The
	// root row maps to the stage's '__canvas__' sentinel like a bare-canvas right-click would.
	const onOutlineContextMenu = useCallback(
		(e: { id: string; x: number; y: number }) => {
			const rootId = monitorForDragRef.current.root.id;
			const w = toWorld(e.x, e.y);
			setMenu({ x: e.x, y: e.y, id: e.id === rootId ? '__canvas__' : e.id, wx: w.x, wy: w.y });
		},
		[toWorld]
	);
	const onCanvasContextMenu = useCallback(
		(event: React.MouseEvent) => {
			if (!editModeRef.current || previewingRef.current) return; // read-only while previewing
			// The stage context menu (split / add inside / add beside / paste / …) only makes sense on a
			// STAGE — the Layouts section or the widget designer. In an off-stage section (Settings,
			// Sensors, Themes, Plugins, …), or on a docked rail/panel (Inspector, Outline, …), there's
			// nothing for those items to act on, so bail BEFORE preventDefault — leaving the right-click
			// to its native behaviour (e.g. a text field keeps its copy/paste menu) instead of popping an
			// irrelevant stage menu. (Overlays have no sections; their whole surface is the stage.)
			if (studio && !(navSection === 'layouts' || designing)) return;
			if ((event.target as HTMLElement | null)?.closest(PANEL_SEL)) return;
			event.preventDefault();
			if (consumeSuppressCtx()) return; // swallow the contextmenu trailing a right-drag free-move
			const mon = monitorForDragRef.current;
			const world = toWorld(event.clientX, event.clientY);
			const id = studio ? containerAt(world) : mon.root.id;
			setMenu({
				x: event.clientX,
				y: event.clientY,
				id: id === mon.root.id ? '__canvas__' : id,
				wx: world.x,
				wy: world.y
			});
		},
		[studio, navSection, designing, containerAt, toWorld, consumeSuppressCtx]
	);
	// Drag a palette widget (the Inspector "Add" buttons set text/x-widget-type) onto the stage to
	// drop a new floating widget at the cursor (item 7). Drops over a docked rail belong to that
	// panel (the Outline's own dropWidget), so bail when the target is inside one.
	const onCanvasDragOver = useCallback(
		(event: React.DragEvent) => {
			if (!studio || !editModeRef.current || previewingRef.current) return;
			if (!event.dataTransfer.types.includes('text/x-widget-type')) return;
			if ((event.target as HTMLElement | null)?.closest(PANEL_SEL)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = 'copy';
		},
		[studio]
	);
	const onCanvasDrop = useCallback(
		(event: React.DragEvent) => {
			if (!studio || !editModeRef.current || previewingRef.current) return;
			const wt = event.dataTransfer.getData('text/x-widget-type');
			if (!wt || (event.target as HTMLElement | null)?.closest(PANEL_SEL)) return;
			event.preventDefault();
			const { x, y } = toWorld(event.clientX, event.clientY);
			handleOp({ op: 'addWidgetAt', widgetType: wt, x, y });
		},
		[studio, toWorld, handleOp]
	);

	const closeMenu = useCallback(() => setMenu(null), []);
	// Roving keyboard navigation within the context menu (ARIA menu pattern). Esc/Tab close it; the
	// arrows/Home/End move focus among the menuitems (tagged in the effect above).
	const onMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
		const el = ctxRef.current;
		if (!el) return;
		if (e.key === 'Escape' || e.key === 'Tab') {
			e.preventDefault();
			setMenu(null);
			return;
		}
		const items = Array.from(el.querySelectorAll<HTMLButtonElement>('button'));
		if (!items.length) return;
		const i = items.indexOf(document.activeElement as HTMLButtonElement);
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			items[(i + 1 + items.length) % items.length].focus();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			items[(i - 1 + items.length) % items.length].focus();
		} else if (e.key === 'Home') {
			e.preventDefault();
			items[0].focus();
		} else if (e.key === 'End') {
			e.preventDefault();
			items[items.length - 1].focus();
		}
	}, []);
	const menuAct = useCallback(
		(op: LayoutOp) => {
			handleOp(op);
			setMenu(null);
		},
		[handleOp]
	);
	// Props for a previewable menu item: apply on click, and PREVIEW on hover/keyboard-focus (the same
	// `op` drives both, so the ghost can't drift from what clicking does). onMouseLeave/onBlur revert;
	// closing the menu reverts too (the effect on `menu`).
	const previewItemProps = useCallback(
		(op: LayoutOp) => ({
			onClick: () => menuAct(op),
			onMouseEnter: () => setPreviewOp(op),
			onMouseLeave: () => setPreviewOp(null),
			onFocus: () => setPreviewOp(op),
			onBlur: () => setPreviewOp(null)
		}),
		[menuAct]
	);
	const mPick = useCallback(
		(sel: string) => {
			dispatch({ type: 'selectClick', id: sel });
			setMenu((m) => (m ? { ...m, id: sel, cellIndex: undefined } : m));
		},
		[dispatch]
	);
	const mSelectNode = useCallback(
		(id: string | null) => {
			if (!id) return;
			dispatch({ type: 'select', id });
			setMenu(null);
		},
		[dispatch]
	);
	const mEditDef = useCallback(() => {
		const d = menuGroup?.def;
		if (d) menuAct({ op: 'editDef', defId: d });
	}, [menuGroup, menuAct]);
	// Copy the right-clicked node's JSON to the clipboard (debug). For a widget leaf this is the full
	// `{ id, unit, basis }` — its type/sensor/config/css/formulas — so it can be pasted into a bug
	// report or the assistant. Falls back to a console log if the clipboard is unavailable.
	const mCopyDebug = useCallback(async () => {
		if (!menuNode) return;
		const json = JSON.stringify(menuNode, null, 2);
		setMenu(null);
		const ok = await copyToClipboard(json);
		if (!ok) console.log('[canvas] copy debug (clipboard unavailable):\n' + json);
	}, [menuNode]);

	// Move a widget/group to ANOTHER monitor's layout (studio).
	const moveNodeToMonitor = useCallback(
		async (id: string, targetKey: string) => {
			if (targetKey === myMonitorRef.current) return;
			const s = stateRef.current;
			const node = lookup(id, s.monitor);
			if (!node || !isLeaf(node)) return;
			const r = solvedRef.current.get(id);
			const moved = editHelpers.floatingLeafFrom(node, r?.x ?? 24, r?.y ?? 24, r);
			// removeById(id) + selectedId=null, then saveLayout({key,leaf}) → queue extra + commit.
			const extra: Extra = { key: targetKey, leaf: moved };
			commitOp((cur) => {
				const next = editHelpers.removeById(cur, id);
				return { ...next, selectedId: null, pendingExtras: [...cur.pendingExtras, extra] };
			});
		},
		[commitOp]
	);

	const mMoveToMonitor = useCallback(
		(key: string) => {
			if (menu) moveNodeToMonitor(menu.id, key);
			setMenu(null);
		},
		[menu, moveNodeToMonitor]
	);

	// Keyboard section switching (Ctrl+1..8 jump, Ctrl+Tab / Ctrl+Shift+Tab cycle). While designing a
	// widget def these stay inert — a nav-rail CLICK instead prompts to finish + leave (navToSection),
	// but a blocking confirm fired from a keystroke would be jarring. Defined before useKeyboard so its
	// handler map can reference them.
	// Both mirrored in the commit effect S3 (read only from gotoSection/cycleSection at event time).
	const navSectionRef = useRef(navSection);
	const designingRef = useRef(designing);
	const gotoSection = useCallback((index: number) => {
		if (designingRef.current) return;
		// Index the SAME grouped sequence the NavRail renders (main group, then foot), so Ctrl+1..8
		// lands on the i-th visible rail button even if the section groups are reordered independently.
		const s = RAIL_ORDER[index];
		if (s) startViewTransition(() => flushSync(() => setNavSection(s.id)));
	}, []);
	const cycleSection = useCallback((delta: number) => {
		if (designingRef.current) return;
		const ids = RAIL_ORDER.map((s) => s.id);
		const i = ids.indexOf(navSectionRef.current);
		const next = ids[(i + delta + ids.length) % ids.length];
		startViewTransition(() => flushSync(() => setNavSection(next)));
	}, []);

	// Select every widget on the monitor (Ctrl+A) — the distinct selectIds across all renderables, i.e.
	// the same set a full-canvas marquee would catch. Reads from the ref so the handler stays stable.
	const selectAll = useCallback(() => {
		const ids = Array.from(new Set(renderablesRef.current.map((r) => r.selectId)));
		if (ids.length) setSelection(ids, ids[ids.length - 1]);
	}, [setSelection]);

	// --- keyboard ---
	const dirtyKbRef = useRef(dirty); // mirrored in the commit effect S3
	const { spaceDownRef, spaceDown } = useKeyboard({
		studio,
		// The plain ControlContext slice; `previewing` folds into the controls' canEdit gate (so
		// delete/nudge/save are suppressed in a read-only overlay preview — the studio short-circuits,
		// matching the prior behavior). spaceDown/panning are filled by the hook/registry.
		ctx: () => ({
			studio,
			editMode: editModeRef.current,
			menuOpen: menuRef.current !== null,
			dirty: dirtyKbRef.current,
			hasSelection: selectedIdsRef.current.length > 0 || selectedIdRef.current !== null,
			previewing: previewingRef.current
		}),
		overrides: () => overridesRef.current,
		handlers: {
			// Escape: close an open menu first; otherwise clear the selection (the control's `when`
			// already gates this to "a menu is open OR something is selected").
			'studio.closeMenu': () => (menuRef.current !== null ? closeMenu() : clearSelection()),
			'global.toggleEdit': () => emit(EVENTS.toggleEdit), // broadcast: every monitor's overlay toggles
			'studio.save': commitSave,
			'studio.undo': undo,
			'studio.redo': redo,
			'studio.delete': deleteSelected,
			'studio.selectAll': selectAll,
			'studio.sectionNext': () => cycleSection(1),
			'studio.sectionPrev': () => cycleSection(-1)
		},
		gotoSection,
		nudge: (dx, dy) => {
			// Compute the translate SYNCHRONOUSLY from current refs and commit only when something
			// moved (Svelte: `if (translateSelectedFloating(...)) saveLayout()`). The reducer-deferred
			// `changed` flag of translateSelectedFloating reads stale here, so nudges would never
			// persist/undo — this records exactly one undo step + triggers the save when changed.
			const ids = selectedIdsRef.current.length
				? selectedIdsRef.current
				: selectedIdRef.current
					? [selectedIdRef.current]
					: [];
			const idSet = new Set(ids);
			if (!idSet.size || (dx === 0 && dy === 0)) return;
			let changed = false;
			const floating = monitorRef.current.floating.map((l) => {
				if (!idSet.has(l.id)) return l;
				changed = true;
				if (isGroup(l.unit)) {
					const g = l.unit;
					const gx = typeof g.config?.x === 'number' ? g.config.x : 0;
					const gy = typeof g.config?.y === 'number' ? g.config.y : 0;
					return leaf({ ...g, config: { ...(g.config ?? {}), x: gx + dx, y: gy + dy } });
				}
				const u = l.unit as WidgetInstance;
				return leaf({ ...u, rect: { ...u.rect, x: u.rect.x + dx, y: u.rect.y + dy } });
			});
			if (!changed) return;
			const next = { ...monitorRef.current, floating };
			commitOp(() => ({ monitor: next }));
		}
	});
	const menuRef = useRef(menu);
	const selectedIdRef = useRef(selectedId);

	// Sync effect S3: mirror the latest render values into the refs that async / event-time consumers
	// read (Tauri listeners, the studio-close guard, drag / keyboard / context-menu handlers, persist).
	// Runs on every commit — after render, before any of those consumers can fire — so they always see
	// current values. The syncRects trio (the only refs read synchronously inside an effect body) is
	// handled by the earlier effect S1; none of the refs below are read during render.
	// (Some refs below are also read by hooks declared above, so react-hooks/immutability wants the
	// write "before the hook" — but a render-time ref write trips react-hooks/refs instead. A latest-ref
	// mirror can't satisfy both rules at once, and this project doesn't run the React Compiler; these are
	// refs, mutable by design, read only after commit.)
	useEffect(() => {
		/* eslint-disable react-hooks/immutability */
		myMonitorRef.current = myMonitor;
		monitorRef.current = monitor;
		pendingExtrasRef.current = pendingExtras;
		commitSaveRef.current = commitSave;
		savedBaselineRef.current = savedBaseline;
		dirtyRef.current = dirty;
		dirtyKbRef.current = dirty;
		previewingRef.current = previewing;
		stateRef.current = state;
		panRef.current = { panX, panY, zoom };
		solvedRef.current = combinedSolved;
		renderablesRef.current = renderables;
		monitorForDragRef.current = monitor;
		selectedIdsRef.current = selectedIds;
		selectedIdRef.current = selectedId;
		dropIntoFlowRef.current = dropIntoFlow;
		dropIntoCellsRef.current = dropIntoCells;
		containerRectsRef.current = containerRects;
		navSectionRef.current = navSection;
		designingRef.current = designing;
		menuRef.current = menu;
		/* eslint-enable react-hooks/immutability */
	});

	// --- canvas pointer (marquee + pan) ---
	const { marquee, panning, onCanvasMouseDown } = useCanvasPointer({
		editMode,
		studio,
		overrides: () => overridesRef.current,
		spaceDown: () => spaceDownRef.current,
		pan: () => panRef.current,
		setPan,
		canvasRef,
		renderables: () => renderablesRef.current,
		selectedIds: () => selectedIdsRef.current,
		setSelection: (ids, primary) => setSelection(ids, primary),
		clearSelection
	});

	// Resizable studio panes: column widths as CSS vars on the canvas root, persisted to localStorage.
	const { vars: paneVars, startResize } = usePaneSizes(studio);

	// Contextual action hints for the studio's bottom powerline bar (item 2).
	const hasSelection = selectedIds.length > 0 || selectedId !== null;
	const selectionCount = selectedIds.length || (selectedId !== null ? 1 : 0);
	const hints = useMemo(
		() =>
			studioHints({ hasSelection, spaceDown, panning, dirty, canUndo, selectionCount }, overrides),
		[hasSelection, spaceDown, panning, dirty, canUndo, selectionCount, overrides]
	);

	// Copy a debug snapshot (tree + solved boxes + workArea/zoom, with collapsed/out-of-bounds panes
	// auto-flagged) to the clipboard, for pasting into a bug report. Also logged to the console.
	const copyDebug = useCallback(async () => {
		const text = buildDebugInfo({
			designing,
			editingDef: editingDef
				? { id: editingDef.id, name: editingDef.name, size: editingDef.size }
				: null,
			monitorKey: myMonitor,
			workArea,
			stageSize,
			zoom,
			panX,
			panY,
			monitor,
			solved: combinedSolved,
			selectedId,
			defs: (library?.defs ?? []).map((d) => ({ id: d.id, name: d.name, size: d.size }))
		});
		console.log(text);
		const ok = await copyToClipboard(text);
		window.alert(
			ok
				? 'Debug info copied — paste it to the assistant.'
				: 'Copy failed; the debug info was logged to the devtools console (Inspect).'
		);
	}, [
		designing,
		editingDef,
		myMonitor,
		workArea,
		stageSize,
		zoom,
		panX,
		panY,
		monitor,
		combinedSolved,
		selectedId,
		library
	]);

	// =========================================================================================
	// Render.
	// =========================================================================================
	// The contextual subbar (canvas controls: undo/redo, zoom, drop, debug) shows only where there's a
	// stage to act on — the Layouts section or while designing a def — and not in read-only preview.
	// `has-subbar` grows --bar-h by one row (Canvas.css) so the whole studio shifts down to make room.
	const showSubbar = studio && (navSection === 'layouts' || designing) && !previewing;

	const canvasCls = ['canvas'];
	if (editMode) canvasCls.push('edit');
	if (studio) canvasCls.push('studio');
	if (panning) canvasCls.push('panning');
	if (spaceDown) canvasCls.push('panmode');
	if (designing) canvasCls.push('designing');
	if (showSubbar) canvasCls.push('has-subbar');

	// One WidgetHost per renderable — shared by the studio (absolute, solver-positioned) and the
	// overlay's floating layer. `flow` slot-mode hosts come from renderFlowLeaf via FlowNode instead.
	// In the STUDIO each host is wrapped in a <Profiler> feeding the Diagnostics "widget render cost"
	// panel (renders/sec + ms per widget — surfaces a churning meter); the overlay skips it (no panel).
	const renderHost = (r: (typeof renderables)[number], flow: boolean) => {
		const host = (
			<WidgetHost
				key={r.id}
				flow={flow}
				hub={hub}
				instance={r.instance}
				rect={r.rect}
				movable={r.movable}
				selectId={r.selectId}
				domId={r.id}
				defId={r.defId}
				groupId={r.groupId}
				editMode={editMode && !previewing}
				selected={r.selectId === selectedId || selectedSet.has(r.selectId)}
				multi={multiSelected && (r.selectId === selectedId || selectedSet.has(r.selectId))}
				highlighted={hoverId !== null && r.selectId === hoverId}
				grid={GRID}
				scale={studio ? zoom : 1}
				onChange={onChange}
				onCommit={onCommit}
				onSelect={onSelect}
				onDragOver={onDragOver}
				onDrop={onDrop}
				onContextMenu={onWidgetContextMenu}
				onControl={onWidgetControl}
				onHover={editMode ? setHoverId : undefined}
				onSuppressContextMenu={armSuppressCtx}
				suppressContextMenu={consumeSuppressCtx}
			/>
		);
		return studio ? (
			<Profiler key={r.id} id={r.id} onRender={recordWidgetRender}>
				{host}
			</Profiler>
		) : (
			host
		);
	};

	// Render a FlowNode primitive leaf as a slot-filling WidgetHost, FULLY wired (incl. edit-mode
	// drag) via the shared renderHost — flow-drag/drop + selection now target the MEASURED rects, so
	// they align with the CSS render. A bare passive host is the fallback before the renderable
	// (which needs a measured/solved rect) exists.
	const renderFlowLeaf: RenderLeaf = (lf, id) => {
		const r = renderablesById.get(id);
		return r ? (
			renderHost(r, true)
		) : (
			<WidgetHost flow hub={hub} instance={lf.unit as WidgetInstance} domId={id} selectId={id} />
		);
	};

	// A floating GROUP's descendant: laid out in CSS (FlowNode inside the group's box) and DISPLAY-ONLY
	// in the editor — the enclosing GroupFrame owns selection / move / resize for the whole group, so a
	// descendant isn't individually selectable (Unlink to edit one). `onControl` is still wired so an
	// interactive descendant (e.g. an HA light) actuates on the passive overlay, where the frame has no
	// edit overlay covering it.
	const renderFloatingLeaf: RenderLeaf = (lf, id) => {
		const r = renderablesById.get(id);
		return (
			<WidgetHost
				flow
				hub={hub}
				instance={lf.unit as WidgetInstance}
				domId={id}
				selectId={r?.selectId ?? id}
				defId={r?.defId}
				groupId={r?.groupId}
				onControl={onWidgetControl}
			/>
		);
	};

	return (
		<TelemetryHubContext.Provider value={hub}>
			<div
				className={canvasCls.join(' ')}
				ref={canvasRef}
				style={paneVars}
				onContextMenu={onCanvasContextMenu}
				onMouseDown={onCanvasMouseDown}
				onDragOver={onCanvasDragOver}
				onDrop={onCanvasDrop}
			>
				<StyleLayer css={styleCss} />
				<div ref={worldRef} className={studio ? 'world scaled' : 'world'} style={worldStyle}>
					{/* The full-monitor wallpaper layer, behind every widget. Inside .world so it scales/pans
					    with the monitor view in the studio and fills the screen 1:1 on an overlay. */}
					<BackgroundLayer spec={showBackground ? bg : undefined} resolveSrc={resolveWallpaper} />
					{studio && (
						<>
							<div
								className="monitor-frame"
								style={{ left: workArea.x, top: workArea.y, width: workArea.w, height: workArea.h }}
							/>
							{containerRects.map((c) =>
								c.id !== monitor.root.id ? (
									<div
										key={c.id}
										className={['cbound', c.id === selectedId && 'csel', c.id === hoverId && 'chl']
											.filter(Boolean)
											.join(' ')}
										style={{ left: c.rect.x, top: c.rect.y, width: c.rect.w, height: c.rect.h }}
									>
										<button
											type="button"
											className="ctag"
											title={`Select this ${c.kind}`}
											onClick={() => dispatch({ type: 'select', id: c.id })}
											onMouseEnter={() => setHoverId(c.id)}
											onMouseLeave={() => setHoverId(null)}
										>
											{c.kind}
										</button>
									</div>
								) : null
							)}
							{gridPlaceholders.map((cell) => (
								<button
									type="button"
									key={`${cell.gridId}:${cell.index}`}
									className="grid-cell"
									style={{
										left: cell.rect.x,
										top: cell.rect.y,
										width: cell.rect.w,
										height: cell.rect.h
									}}
									title="Empty grid cell — click to select the grid; right-click to add a row / column / grid inside"
									onClick={() => dispatch({ type: 'select', id: cell.gridId })}
									onContextMenu={(e) => {
										e.preventDefault();
										e.stopPropagation();
										const w = toWorld(e.clientX, e.clientY);
										setMenu({
											x: e.clientX,
											y: e.clientY,
											id: cell.gridId === monitor.root.id ? '__canvas__' : cell.gridId,
											cellIndex: cell.index,
											wx: w.x,
											wy: w.y
										});
									}}
								/>
							))}
							{splitters.map((sp) => {
								// Keep the grab area a constant ~8px ON SCREEN regardless of zoom: expand the
								// cross-axis thickness in world coords by 1/zoom around the boundary midpoint, so
								// zooming out to see the whole monitor doesn't shrink the splitter below the
								// reliable-pointing floor. The visual line stays thin via the ::after tick.
								const z = (studio ? zoom : 1) || 1;
								const vertical = sp.axis === 'row';
								const pad = (vertical ? sp.rect.w : sp.rect.h) / z;
								const cx = sp.rect.x + sp.rect.w / 2;
								const cy = sp.rect.y + sp.rect.h / 2;
								const style = vertical
									? { left: cx - pad / 2, top: sp.rect.y, width: pad, height: sp.rect.h }
									: { left: sp.rect.x, top: cy - pad / 2, width: sp.rect.w, height: pad };
								return (
									<div
										key={`${sp.aId}|${sp.bId}`}
										className={`splitter ${vertical ? 'v' : 'h'}`}
										role="separator"
										aria-orientation={vertical ? 'vertical' : 'horizontal'}
										aria-label="Resize panes (arrow keys; Shift for a larger step)"
										tabIndex={0}
										style={style}
										title="Drag to resize (snaps to ¼ ⅓ ½ ⅔ ¾) · double-click to even · arrow keys to nudge"
										onPointerDown={(e) => onSplitDown(e, sp)}
										onPointerMove={onSplitMove}
										onPointerUp={onSplitUp}
										onDoubleClick={() => onSplitReset(sp)}
										onKeyDown={(e) => onSplitKey(e, sp)}
									/>
								);
							})}
							{/* Context-menu hover preview: ghost rects for the item under the pointer/focus,
							    drawn on top of the existing overlays. pointer-events:none (CSS) so they never
							    steal the menu hover or stage clicks; in .world so they inherit pan/zoom. */}
							{previewShapes.map((s, i) =>
								s.kind === 'bar' ? (
									<div
										key={`pv${i}`}
										className="ctx-preview-bar"
										style={{ left: s.rect.x, top: s.rect.y, width: s.rect.w, height: s.rect.h }}
									/>
								) : (
									<div
										key={`pv${i}`}
										className={s.kind === 'zone' ? 'ctx-preview-zone' : 'ctx-preview-cell'}
										style={{ left: s.rect.x, top: s.rect.y, width: s.rect.w, height: s.rect.h }}
									/>
								)
							)}
						</>
					)}
					{/* The flow tree, laid out natively by the browser (FlowNode). The frame insets it to
					    the WORK AREA — the full stage in the studio, taskbar-excluded on the overlay
					    (unless the "respect taskbar" pref is off). .world stays window/stage-filling so
					    measured rects rebase to a stable origin (monitor-local for click-through). */}
					<div
						className="flow-frame"
						style={
							studio || overlayPrefs.respectWorkArea
								? {
										position: 'absolute',
										left: `${workArea.x}px`,
										top: `${workArea.y}px`,
										width: `${workArea.w}px`,
										height: `${workArea.h}px`
									}
								: { position: 'absolute', inset: 0 }
						}
					>
						<FlowNode
							node={monitor.root}
							parentKind="col"
							renderLeaf={renderFlowLeaf}
							library={library}
							fill
							hiddenIds={hiddenIds}
						/>
					</div>
					{/* Floating layer: GROUPS lay out in CSS (FlowNode inside an absolute box at their
					    anchor + size); PRIMITIVES sit absolutely at their own stored rect. */}
					{monitor.floating.map((lf) => {
						if (isGroup(lf.unit)) {
							// One interactive frame for the whole group: select / free-move / resize as a
							// single unit (the descendants render display-only inside it). The frame's id is
							// the group leaf id, so selection + multi-drag treat it as one widget.
							const box = floatingGroupBox(lf);
							const child = resolveGroup(lf.unit, library).child;
							return (
								<GroupFrame
									key={lf.id}
									id={lf.id}
									rect={box}
									name={(lf.unit as Group).name}
									editMode={editMode && !previewing}
									selected={lf.id === selectedId || selectedSet.has(lf.id)}
									multi={multiSelected && (lf.id === selectedId || selectedSet.has(lf.id))}
									highlighted={hoverId !== null && lf.id === hoverId}
									grid={GRID}
									scale={studio ? zoom : 1}
									onChange={onChange}
									onCommit={onCommit}
									onSelect={onSelect}
									onContextMenu={onWidgetContextMenu}
									onHover={editMode ? setHoverId : undefined}
									onSuppressContextMenu={armSuppressCtx}
									suppressContextMenu={consumeSuppressCtx}
								>
									{child && (
										<FlowNode
											node={child}
											parentKind="col"
											prefix={`${lf.id}/`}
											renderLeaf={renderFloatingLeaf}
											library={library}
											fill
											hiddenIds={hiddenIds}
										/>
									)}
								</GroupFrame>
							);
						}
						const r = renderablesById.get(lf.id);
						return r ? renderHost(r, false) : null;
					})}
					{editMode && (
						<>
							{guideXs.map((gx) => (
								<div key={`v${gx}`} className="guide v" style={{ left: gx }} />
							))}
							{guideYs.map((gy) => (
								<div key={`h${gy}`} className="guide h" style={{ top: gy }} />
							))}
							{dropBar && (
								<div
									className="dropbar"
									style={{ left: dropBar.x, top: dropBar.y, width: dropBar.w, height: dropBar.h }}
								/>
							)}
							{dropZone && (
								<div
									className="dropzone"
									style={{
										left: dropZone.x,
										top: dropZone.y,
										width: dropZone.w,
										height: dropZone.h
									}}
								/>
							)}
						</>
					)}
				</div>

				{marquee && (
					<div
						className="marquee"
						style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
					/>
				)}

				{editMode && (
					// Local Suspense boundary for the lazy studio/edit-mode panels (declared at the top of this
					// file). It wraps ONLY the edit-mode chrome — the canvas widgets render earlier in `.world`,
					// OUTSIDE this block — so a panel chunk loading (e.g. first time the overlay enters edit mode
					// via Ctrl+E and Inspector/Outline/MultiInspector fetch) shows a brief empty chrome area but
					// NEVER blanks the desktop widgets. fallback={null}: the panels just pop in a frame later.
					<Suspense fallback={null}>
						{studio && (
							<>
								{/* Primary bar (always): identity, current monitor, persistence. The canvas-only
								    controls live in the contextual subbar below, shown only on a stage. */}
								{/* The studio's custom title bar (the window is borderless — decorations:false). The
								    empty areas carry data-tauri-drag-region to move the window; double-clicking them
								    toggles maximize. Window controls sit at the far right. Themed via --ui-* tokens, so
								    it follows the active theme. */}
								<div className="studio-bar" data-tauri-drag-region>
									{/* Persistent polite live region: announces the "✓ saved" confirmation to screen
									    readers in ANY section (the visible flash lives in the section-gated powerbar,
									    so it can't carry the announcement on its own). */}
									<span className="sr-only" role="status" aria-live="polite">
										{savedFlash ? 'Layout saved' : ''}
									</span>
									<img
										className="sb-mascot"
										src={mascotUrl}
										alt=""
										aria-hidden="true"
										data-tauri-drag-region
									/>
									<button
										type="button"
										className="hmenu"
										aria-label="Menu"
										aria-haspopup="menu"
										aria-expanded={headerMenuOpen}
										onClick={() => setHeaderMenuOpen((o) => !o)}
									>
										<span aria-hidden="true">≡</span>
									</button>
									{/* Quick theme switch, mirroring the Themes section's picker — global, so it stays
										    enabled while designing a widget; the full editor lives in the Themes section. */}
									<span className="lbl" data-tauri-drag-region>
										Theme
									</span>
									<Select
										className="sb-select"
										value={selectedTheme}
										options={[
											{ value: '', label: '(default)', swatch: DEFAULT_SWATCH },
											...BUILTIN_THEMES.map((t) => ({
												value: builtinName(t.id),
												label: t.name,
												swatch: t.swatch
											})),
											...themeList.map((n) => ({
												value: n,
												label: n,
												swatch: userThemeSwatches[n]
											}))
										]}
										title="Switch the active theme (edit themes in the Themes section)"
										onChange={setTheme}
										aria-label="Theme"
									/>
									{/* "Monitor", not "Display": Settings has a Display PAGE (monitor info), and the two
									    sharing a name made this read as a duplicate — this switcher picks WHICH monitor's
									    layout the studio edits. */}
									<span className="lbl" data-tauri-drag-region>
										Monitor
									</span>
									<Select
										className="sb-select"
										value={myMonitor}
										options={monitorOptions.map((o) => ({ value: o.key, label: o.label }))}
										disabled={designing}
										title={designing ? 'Finish the widget (Done) to switch monitor' : undefined}
										onChange={switchMonitor}
										aria-label="Monitor"
									/>
									<button
										type="button"
										className={['save', dirty ? 'hot' : 'saved'].join(' ')}
										title="Save to disk — applies to the desktop overlays (Ctrl+S)"
										disabled={!dirty}
										onClick={commitSave}
									>
										{dirty ? '● Save' : '✓ Saved'}
									</button>
									{/* Only rendered while there's something to discard — a permanently visible
									    disabled Cancel is title-bar noise that reads as a broken control. */}
									{dirty && (
										<button type="button" title="Discard unsaved changes" onClick={cancelEdits}>
											Cancel
										</button>
									)}
									{/* Dev/extra-instance badge (main.rs is_dev_instance): a --multi or debug build run
									    alongside the installed release shows this so the two are distinguishable. */}
									{devInstance && (
										<span
											className="dev-badge"
											title="Dev / extra instance (--multi or debug build) — separate, isolated config"
										>
											dev
										</span>
									)}
									{/* Window controls (the borderless window's min / maximize-restore / close). Pushed to
									    the far right (margin-left:auto); the gap before them is a drag region. */}
									<div className="win-controls">
										<button
											type="button"
											className="winbtn"
											title="Minimize"
											aria-label="Minimize"
											onClick={minimizeWindow}
										>
											<span aria-hidden="true">—</span>
										</button>
										<button
											type="button"
											className="winbtn"
											title="Maximize / Restore"
											aria-label="Maximize or restore"
											onClick={toggleMaximizeWindow}
										>
											<span aria-hidden="true">▢</span>
										</button>
										<button
											type="button"
											className="winbtn winbtn-close"
											title="Close"
											aria-label="Close"
											onClick={closeWindow}
										>
											<span aria-hidden="true">✕</span>
										</button>
									</div>
								</div>
								{/* Overflow (≡) menu: quick access to actions otherwise buried in nav sections. A
								    full-screen backdrop catches the outside click to dismiss it. */}
								{headerMenuOpen && (
									<>
										<div
											className="studio-menu-backdrop"
											onClick={() => setHeaderMenuOpen(false)}
										/>
										<div className="studio-menu" role="menu">
											<button
												type="button"
												role="menuitem"
												onClick={() => {
													setHeaderMenuOpen(false);
													exportSack();
												}}
											>
												Export sack…
											</button>
											<button
												type="button"
												role="menuitem"
												onClick={() => {
													setHeaderMenuOpen(false);
													navToSection('sacks');
												}}
											>
												Import sack…
											</button>
											<button
												type="button"
												role="menuitem"
												onClick={() => {
													setHeaderMenuOpen(false);
													setSettingsTab('controls');
													navToSection('settings');
												}}
											>
												Keyboard shortcuts
											</button>
											<button
												type="button"
												role="menuitem"
												onClick={() => {
													setHeaderMenuOpen(false);
													openDevtools();
												}}
											>
												Open DevTools
											</button>
										</div>
									</>
								)}
								{/* Contextual subbar: canvas/stage controls (undo·redo, zoom, drop, debug). Only on
								    the Layouts / Widget-designer stage — irrelevant on Themes / Sensors / Settings. */}
								{showSubbar && (
									<div className="studio-bar studio-subbar">
										<span className="lbl">Edit</span>
										<button type="button" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
											↶ Undo
										</button>
										<button type="button" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={redo}>
											↷ Redo
										</button>
										<span className="lbl">Drop</span>
										<label
											className="chk"
											title="Let a dragged floating widget dock into the flow / grids"
										>
											<input
												type="checkbox"
												checked={dropIntoFlow}
												onChange={(e) => setDropIntoFlow(e.currentTarget.checked)}
											/>{' '}
											into grids
										</label>
										<label
											className="chk"
											title="Drop into an occupied grid cell's interior (vs before/after)"
										>
											<input
												type="checkbox"
												checked={dropIntoCells}
												onChange={(e) => setDropIntoCells(e.currentTarget.checked)}
											/>{' '}
											into cells
										</label>
										<span className="lbl">Zoom</span>
										<button type="button" onClick={fit}>
											Fit
										</button>
										<span className="zlevel">{Math.round(zoom * 100)}%</span>
										<span className="lbl">Debug</span>
										<button
											type="button"
											title="Copy a debug snapshot (tree + solved boxes + flagged issues) to the clipboard"
											onClick={copyDebug}
										>
											⧉ Copy debug
										</button>
									</div>
								)}
								<div className="monitor-badge">▦ {monName}</div>
								{/* The powerline hint bar advertises CANVAS gestures (click/drag/marquee/pan/nudge…),
								    so it belongs only on an edit stage — the Layouts section or while designing a
								    widget def, never in read-only preview or the off-stage sections (Themes / Sensors
								    / …) where those gestures don't apply. Same gate as the contextual subbar; --bar-b
								    collapses with it so the rails/panels reclaim the bottom row (Canvas.css). */}
								{showSubbar && (
									<div className="powerbar" aria-label="Keyboard and pointer shortcuts">
										{savedFlash && (
											<span className="seg flash" key="saved-flash">
												<span className="lbl">✓ saved</span>
											</span>
										)}
										{hints.map((h, i) => (
											<span className="seg" key={i}>
												<kbd>{h.key}</kbd>
												<span className="lbl">{h.label}</span>
											</span>
										))}
									</div>
								)}
								{/* Draggable pane dividers (widths persist to localStorage). Each only renders where its
								    panel actually exists — the full-width section panels (sensors/plugins/themes/…)
								    have nothing to resize, so no handle floats over them. */}
								{(navSection === 'layouts' || navSection === 'widget-designer') && (
									<div
										className="pane-resize left"
										title="Drag to resize the left panel"
										onPointerDown={(e) => startResize('left', e)}
									/>
								)}
								{designing && !previewing && (
									<div
										className="pane-resize tree"
										title="Drag to resize the structure tree"
										onPointerDown={(e) => startResize('tree', e)}
									/>
								)}
								{(navSection === 'layouts' || designing) && !previewing && (
									<div
										className="pane-resize right"
										title="Drag to resize the details panel"
										onPointerDown={(e) => startResize('right', e)}
									/>
								)}
							</>
						)}
						{themeEditorOpen && (
							<div
								className="theme-editor"
								role="dialog"
								aria-modal="true"
								aria-labelledby="theme-editor-title"
								onKeyDown={(e) => {
									if (e.key === 'Escape') {
										e.preventDefault();
										setThemeEditorOpen(false);
									}
								}}
							>
								<div className="te-hd">
									<span id="theme-editor-title">Theme editor</span>
									<button
										type="button"
										className="te-close"
										aria-label="Close theme editor"
										onClick={() => setThemeEditorOpen(false)}
									>
										✕
									</button>
								</div>
								<label className="te-name">
									name
									<input
										ref={themeNameRef}
										value={themeDraftName}
										placeholder="my-theme"
										onChange={(e) => setThemeDraftName(e.currentTarget.value)}
									/>
								</label>
								<CssEditor
									className="te-css"
									value={themeDraft}
									onChange={setThemeDraft}
									placeholder={':root {\n\t--np-accent: #77c4d3;\n\t--np-fg: #ffffff;\n}'}
									ariaLabel="theme css"
								/>
								<div className="te-actions">
									<button
										type="button"
										className="te-cancel"
										onClick={() => setThemeEditorOpen(false)}
									>
										Cancel
									</button>
									<button type="button" onClick={saveThemeEditor}>
										Save &amp; apply
									</button>
								</div>
							</div>
						)}
						{dragHint && (
							<div className="drag-hint" style={{ left: dragHint.x, top: dragHint.y }}>
								{dragHint.text}
							</div>
						)}
						{editingDefId &&
							(previewing ? (
								<div className="def-banner preview">
									Previewing: {editingDefName} (read-only) · {stageSize.w}×{stageSize.h}
									<button type="button" onClick={clonePreview}>
										Clone to edit
									</button>
									<button type="button" onClick={closePreview}>
										Close
									</button>
								</div>
							) : (
								<div className="def-banner">
									Designing widget: {editingDefName} · {stageSize.w}×{stageSize.h}
									<button type="button" onClick={() => handleOp({ op: 'endDefEdit' })}>
										Done
									</button>
								</div>
							))}
						{!studio && <div className="edit-badge">EDIT — Ctrl+E to exit</div>}
						{studio ? (
							<>
								<NavRail active={navSection} onSelect={navToSection} />
								{(navSection === 'layouts' || designing) && !previewing && (
									<Outline
										root={monitor.root}
										floating={monitor.floating}
										selectedId={selectedId}
										hoverId={hoverId}
										onHover={setHoverId}
										docked
										scopeLabel={designing ? editingDefName : undefined}
										onOp={handleOp}
										onNodeContextMenu={previewing ? undefined : onOutlineContextMenu}
									/>
								)}
								{navSection === 'widget-designer' && (
									<DesignerListPanel
										library={library}
										editingDefId={editingDefId}
										previewName={previewDef?.name ?? null}
										designing={designing}
										actions={{
											startNewWidget,
											openExistingDef,
											renameWidget,
											cloneDefToEdit,
											deleteWidget,
											previewTemplate,
											newFromTemplate
										}}
									/>
								)}
								{navSection === 'sensors' && !designing && (
									<div className="rail-panel">
										<div className="rp-hd">Sensors &amp; live values</div>
										<SensorList
											hub={hub}
											ids={sensorCatalog([...hub.sensorIds(), ...sourceCatalogIds()])}
											filter
											groupFor={(id) => pluginSensorNameMap.get(id) ?? SYSTEM_GROUP}
											activityFor={sensorActivityFor}
										/>
									</div>
								)}
								{navSection === 'plugins' && !designing && (
									<PluginsPanel
										hub={hub}
										plugins={pluginList}
										selectedId={selectedPluginId}
										onSelect={setSelectedPluginId}
									/>
								)}
								{navSection === 'themes' && !designing && (
									<div className="rail-panel">
										<div className="rp-hd">Theme</div>
										{/* Built-in presets (grouped Classic / Light / Dark / Fun) are immutable — they offer
										    "duplicate to edit" (⎘) only. Your own themes get raw-CSS edit (✎), duplicate (⎘),
										    and delete (✕); "(default)" stays a plain reset. */}
										<ThemeList
											groups={builtinGroups().map((g) => ({
												key: g.group,
												label: g.group[0].toUpperCase() + g.group.slice(1),
												items: g.themes.map((t) => ({
													value: builtinName(t.id),
													label: t.name,
													swatch: t.swatch
												}))
											}))}
											userThemes={themeList.map((n) => ({
												value: n,
												label: n,
												swatch: userThemeSwatches[n]
											}))}
											active={selectedTheme}
											onPick={setTheme}
											onEdit={openThemeEditor}
											onDuplicate={duplicateTheme}
											onDelete={deleteTheme}
										/>
										<button type="button" onClick={() => openThemeEditor()}>
											{selectedTheme
												? `Edit theme CSS (${themeLabel(selectedTheme)})…`
												: '＋ New theme CSS…'}
										</button>
										{/* Live preview: representative meters under the same global token CSS the overlay
										    gets, so the theme + the overrides below restyle them as you edit. */}
										<div className="rp-hd">Preview</div>
										<ThemePreview />
										{/* The friendly token overrides, colocated with the theme picker (they also appear in
										    the Inspector for per-widget tweaks). These override on top of the selected theme,
										    persist across theme switches, and win until cleared. */}
										<div className="rp-hd">Tokens (override this theme)</div>
										{/* Auto theme from the wallpaper (issue #15): fills these overrides with a readable
										    palette derived from the current image wallpaper. Same action as the Background
										    panel's button; shown here because it WRITES these token overrides. */}
										{autoTheme.canAuto ? (
											<div className="theme-auto">
												<button
													type="button"
													onClick={() => void autoTheme.run()}
													disabled={autoTheme.busy}
													aria-busy={autoTheme.busy}
													title="Derive a readable accent + text colours from your wallpaper"
												>
													{autoTheme.busy ? 'Reading…' : '🎨 From wallpaper'}
												</button>
												{autoTheme.status === 'done' && <span className="rp-id">applied ✓</span>}
												{autoTheme.status === 'fail' && (
													<span className="rp-id">couldn’t read the image</span>
												)}
											</div>
										) : (
											<div className="rp-stub">
												Tip: set an <strong>image</strong> Background to auto-derive colours from
												your wallpaper.
											</div>
										)}
										<TokenFields
											values={tokenOverrides}
											onSet={(key, value) => handleOp({ op: 'setToken', key, value })}
											onClear={() => handleOp({ op: 'clearTokens' })}
											clearTitle="Remove every token override and fall back to the selected theme"
										/>
									</div>
								)}
								{navSection === 'background' && !designing && (
									<BackgroundPanel
										bg={bg}
										wallpaperFiles={wallpaperFiles}
										refreshWallpapers={refreshWallpapers}
										patchBg={patchBg}
										setBgKind={setBgKind}
										clearBg={clearBg}
										autoTheme={autoTheme}
										onClearTokens={() => handleOp({ op: 'clearTokens' })}
									/>
								)}
								{navSection === 'sacks' && !designing && (
									<div className="rail-panel">
										<div className="rp-hd">Sacks</div>
										<div className="rp-stub">
											A sack bundles your reusable widgets, the active theme’s CSS, and your token
											overrides into one shareable file — <code>sacks/&lt;name&gt;.sack.json</code>{' '}
											in the app config folder. Send the file to share your setup; importing merges
											(it never overwrites your own widgets or themes).
										</div>
										<button type="button" onClick={exportSack}>
											⤓ Export current…
										</button>
										<div className="rp-hd">Import</div>
										{sackInfos.length ? (
											<div className="rp-list">
												{sackInfos.map((s) => (
													<button
														key={s.name}
														type="button"
														className="sack-item"
														title="Merge this sack's widgets + theme into the studio"
														onClick={() => importSack(s.name)}
													>
														<span className="sack-name">⤒ {s.name}</span>
														<span className="sack-sub">{sackSummary(s)}</span>
													</button>
												))}
											</div>
										) : (
											<div className="rp-stub">No sacks yet — export one above.</div>
										)}
									</div>
								)}
								{navSection === 'saved-layouts' && !designing && (
									<div className="rail-panel">
										<div className="rp-hd">Saved layouts</div>
										<div className="rp-stub">
											Save this monitor’s arrangement as a named profile, then load it back later.
										</div>
										<button type="button" onClick={saveCurrentLayout}>
											⤓ Save current as…
										</button>
										<div className="rp-hd">Load</div>
										{layoutNames.length ? (
											<div className="rp-list">
												{layoutNames.map((n) => (
													<div className="rp-list-row" key={n}>
														<button
															type="button"
															title="Replace this monitor’s layout with this saved one"
															onClick={() => loadSavedLayout(n)}
														>
															⤒ {n}
														</button>
														<button
															type="button"
															className="rp-danger"
															title="Delete this saved layout"
															aria-label={`Delete saved layout ${n}`}
															onClick={() => deleteSavedLayout(n)}
														>
															✕
														</button>
													</div>
												))}
											</div>
										) : (
											<div className="rp-stub">No saved layouts yet — save one above.</div>
										)}
									</div>
								)}
								{navSection === 'settings' && !designing && (
									<StudioSettingsPanel
										tab={settingsTab}
										onTab={setSettingsTab}
										display={{
											monName,
											monSize,
											workArea,
											multiMonitor: monitorOptions.length > 1,
											zoom,
											fit
										}}
										theme={{
											options: themeOptions,
											selected: selectedTheme,
											setTheme,
											lock: themeLock,
											setLock: setThemeLock
										}}
										overlay={{ prefs: overlayPrefs, setPrefs: setOverlayPrefs, layerStatus }}
										startup={{ autostart, toggleAutostart }}
										controls={{
											overrides,
											onRebind: (id, trigger) => controls.setOverride(id, { triggers: [trigger] }),
											onReset: controls.resetOverride,
											onResetAll: controls.resetAll
										}}
										appVersion={appVersion}
										clearMonitor={clearMonitor}
									/>
								)}
							</>
						) : (
							<Outline
								root={monitor.root}
								floating={monitor.floating}
								selectedId={selectedId}
								hoverId={hoverId}
								onHover={setHoverId}
								onOp={handleOp}
								onNodeContextMenu={previewing ? undefined : onOutlineContextMenu}
							/>
						)}
						{(!studio || navSection === 'layouts' || designing) &&
							!previewing &&
							(multiSelected ? (
								<MultiInspector
									items={multiItems}
									fields={multiFields}
									basis={multiBasis}
									onFocus={focusOne}
									onPatchConfig={patchSelectedConfig}
									onSetBasis={setSelectedBasisAll}
									onDelete={deleteSelected}
									docked={studio}
								/>
							) : (
								<Inspector
									widget={selectedWidget}
									container={selectedContainer}
									groupUnit={selectedGroup}
									def={selectedDef}
									defs={library?.defs ?? []}
									tokens={tokenOverrides}
									baseWidget={baseWidget}
									baseContainer={baseContainer}
									baseGroup={baseGroup}
									baseTokens={savedBaseline?.tokens ?? null}
									nodeIsNew={nodeIsNew}
									isGridCell={isGridCell}
									containerBox={selectedContainerBox}
									placement={placement}
									widgetBasis={selectedLeafBasis}
									widgetHalign={selectedLeafHalign}
									widgetValign={selectedLeafValign}
									widgetTypes={widgetTypes}
									configFields={configFields}
									sensors={sensors}
									sensorMeta={sensorMeta}
									audioOutputs={audioOutputs}
									microphones={microphones}
									displayNames={displayNames}
									docked={studio}
									onOp={handleOp}
									onDeleteDef={studio ? deleteWidget : undefined}
									onPreviewTemplate={studio ? previewTemplate : undefined}
									node={selectedNode}
									onCopy={(t) => copyToClipboard(t)}
								/>
							))}
						{menu && menuNode && (
							<>
								<button
									type="button"
									className="ctx-backdrop"
									aria-label="Close menu"
									onClick={closeMenu}
								/>
								<div
									ref={ctxRef}
									className="ctx"
									role="menu"
									aria-label="Widget actions"
									tabIndex={-1}
									onKeyDown={onMenuKeyDown}
									style={{ left: menuPos?.left ?? menu.x, top: menuPos?.top ?? menu.y }}
								>
									{menuStack.length > 1 && (
										<>
											<span className="ctx-hd">Select ({menuStack.length})</span>
											{menuStack.map((s) => (
												<button
													key={s.id}
													type="button"
													className={s.id === menu.id ? 'cur' : undefined}
													onClick={() => mPick(s.id)}
												>
													{s.label}
												</button>
											))}
											<div className="ctx-sep" />
										</>
									)}
									{menuGroup ? (
										<>
											{menuGroup.def && (
												<button type="button" onClick={mEditDef}>
													Edit def…
												</button>
											)}
											<button
												type="button"
												onClick={() => menu && menuAct({ op: 'ungroup', id: menu.id })}
											>
												Ungroup
											</button>
											<button
												type="button"
												className="rm"
												onClick={() => menu && menuAct({ op: 'remove', id: menu.id })}
											>
												Remove
											</button>
										</>
									) : menuLeaf ? (
										<>
											<button
												type="button"
												onClick={() => menu && menuAct({ op: 'makeWidget', id: menu.id })}
											>
												Make widget
											</button>
											{menuFloating ? (
												<button
													type="button"
													onClick={() => menu && menuAct({ op: 'dock', id: menu.id })}
												>
													Dock →flow
												</button>
											) : (
												<button
													type="button"
													onClick={() => menu && menuAct({ op: 'float', id: menu.id })}
												>
													Float
												</button>
											)}
											<button
												type="button"
												className="rm"
												onClick={() => menu && menuAct({ op: 'remove', id: menu.id })}
											>
												Remove
											</button>
										</>
									) : (
										<>
											<button
												type="button"
												onClick={() =>
													mSelectNode(menuId === '__canvas__' ? monitor.root.id : menuId)
												}
											>
												◉ Select
											</button>
											{menuParentId && (
												<button type="button" onClick={() => mSelectNode(menuParentId)}>
													◉ Select parent
												</button>
											)}
											<div className="ctx-sep" />
											<span className="ctx-hd">Split</span>
											<button
												type="button"
												{...previewItemProps({
													op: 'split',
													id: menu.id === '__canvas__' ? monitor.root.id : menu.id,
													dir: 'rows',
													cellIndex: menu.cellIndex
												})}
											>
												⬍ Into rows
											</button>
											<button
												type="button"
												{...previewItemProps({
													op: 'split',
													id: menu.id === '__canvas__' ? monitor.root.id : menu.id,
													dir: 'cols',
													cellIndex: menu.cellIndex
												})}
											>
												⬌ Into columns
											</button>
											<button
												type="button"
												{...previewItemProps({
													op: 'split',
													id: menu.id === '__canvas__' ? monitor.root.id : menu.id,
													dir: 'grid',
													cellIndex: menu.cellIndex
												})}
											>
												▦ Into 2×2 grid
											</button>
											{menuConvertKind && (
												<button
													type="button"
													onClick={() =>
														menu &&
														menuAct({
															op: 'patchContainer',
															id: menu.id === '__canvas__' ? monitor.root.id : menu.id,
															patch: { kind: menuConvertKind }
														})
													}
												>
													{menuConvertKind === 'col' ? '⬍ Convert to column' : '⬌ Convert to row'}
												</button>
											)}
											<div className="ctx-sep" />
											<span className="ctx-hd">Add inside</span>
											{(['row', 'col', 'grid'] as const).map((kind) => (
												<button
													key={kind}
													type="button"
													{...previewItemProps({
														op: 'addContainer',
														kind,
														containerId: menu.id === '__canvas__' ? monitor.root.id : menu.id,
														index: menu.cellIndex
													})}
												>
													{kind === 'row'
														? '＋ Row inside'
														: kind === 'col'
															? '＋ Column inside'
															: '＋ Grid inside'}
												</button>
											))}
											{menuCanCollapse && (
												<button
													type="button"
													onClick={() =>
														menu &&
														menuAct({
															op: 'collapse',
															id: menu.id === '__canvas__' ? monitor.root.id : menu.id
														})
													}
												>
													⊟ Collapse cells
												</button>
											)}
											{menuCanDistribute && (
												<button
													type="button"
													onClick={() =>
														menu &&
														menuAct({
															op: 'distributeEvenly',
															containerId: menu.id === '__canvas__' ? monitor.root.id : menu.id
														})
													}
												>
													⇿ Distribute evenly
												</button>
											)}
											{menuParentId && (
												<>
													<div className="ctx-sep" />
													<span className="ctx-hd">Add beside</span>
													{(['row', 'col', 'grid'] as const).map((kind) => (
														<button
															key={kind}
															type="button"
															{...previewItemProps({ op: 'addBeside', kind, id: menu.id })}
														>
															{kind === 'row'
																? '＋ Row beside'
																: kind === 'col'
																	? '＋ Column beside'
																	: '＋ Grid beside'}
														</button>
													))}
												</>
											)}
										</>
									)}
									{studio && menuLeaf && !designing && monitorOptions.length > 1 && (
										<>
											<div className="ctx-sep" />
											<span className="ctx-hd">Move to</span>
											{monitorOptions
												.filter((o) => o.key !== myMonitor)
												.map((o) => (
													<button key={o.key} type="button" onClick={() => mMoveToMonitor(o.key)}>
														→ {o.name}
													</button>
												))}
										</>
									)}
									<div className="ctx-sep" />
									<button type="button" onClick={mCopyDebug}>
										Copy debug JSON
									</button>
									<button
										type="button"
										title="Open the webview inspector for CSS development"
										onClick={() => {
											openDevtools();
											setMenu(null);
										}}
									>
										⌗ Inspect (devtools)
									</button>
								</div>
							</>
						)}
					</Suspense>
				)}
			</div>
		</TelemetryHubContext.Provider>
	);
}

// --- small helpers used by the Canvas closures (kept local; not part of the editor model) ---

// patchFloating, used by onChange's mutateNoSave path (mirrors the model helper). Returns a patch.
function patchFloating(
	s: { monitor: MonitorLayout },
	id: string,
	patch: Partial<WidgetInstance>
): Partial<EditorState> {
	return {
		monitor: {
			...s.monitor,
			floating: s.monitor.floating.map((l) =>
				l.id === id && !isGroup(l.unit)
					? { ...l, unit: { ...(l.unit as WidgetInstance), ...patch } }
					: l
			)
		}
	};
}

// patchFloatingGroupBox: a floating GROUP's position + size live in its `config` (x/y/w/h), not a
// WidgetInstance.rect — so this is the group counterpart to patchFloating (used by GroupFrame's
// drag/resize). Setting all four covers both move and resize. Returns a patch.
function patchFloatingGroupBox(
	s: { monitor: MonitorLayout },
	id: string,
	rect: Rect
): Partial<EditorState> {
	return {
		monitor: {
			...s.monitor,
			floating: s.monitor.floating.map((l) =>
				l.id === id && isGroup(l.unit)
					? {
							...l,
							unit: {
								...(l.unit as Group),
								config: {
									...((l.unit as Group).config ?? {}),
									x: rect.x,
									y: rect.y,
									w: rect.w,
									h: rect.h
								}
							}
						}
					: l
			)
		}
	};
}

// Remove a node from the flow tree (used by deleteSelected + onDrop's float path).
function removeNodeFromTree(mon: MonitorLayout, id: string): Container {
	return removeNode(mon.root, id);
}
