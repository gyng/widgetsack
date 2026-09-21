# Widget platform plan

Turning the single-purpose now-playing app into a generic, Rainmeter-style widget
platform — so the existing Rainmeter skins under `C:\Users\gng\Documents\Rainmeter\Skins\gyng`
can move here, with **better layouting** for the Corsair Xeneon and **easier config**
than hand-editing `.ini` files.

> Status: **shipped to `main`** — full sensor/meter platform, transparent multi-monitor
> click-through overlay, visual editor (drag/resize/snap/align/inspector/palette), persistence
> + live-reload, tauri 2.11 + global hotkey, renamed to `widgetsack` (frontend later ported
> Svelte→React), all verified on hardware.
> Remaining stretch items are deferred/skipped (see Phase 4).
>
> **Phases 5 & 6 implemented (gates green; pending hardware verification).** The **layout
> designer** (containers row/col/grid, align/gap/pad/justify/grow, floating, outline, drag-and-drop
> reorder/dock, taskbar-aware work area) and the **widget designer** (group/ungroup → reusable
> `WidgetDef`, in-place def editor, params/sensor-remap, library insert/rename/delete-guard) both
> run on one recursive `core/` model + one pure solver, rendered on the per-monitor **overlay**
> and editable in a **studio** app window (model A′). 152 client tests + 6 Rust tests; `cargo
> build`/`test`/`clippy` + `npm check`/`lint`/`test`/`build` all green. Only the native passive-mode
> right-click menu (5d) is deferred — see Phase 5d. See "Layout tree + groups (v2)" and Phases 5–6.

## Tray & global shortcuts (current)

The tray icon is the app's only always-present chrome. **Left-click opens the studio**; the
right-click menu is:

| Item | What it does |
|------|--------------|
| Open studio | Focuses (or spawns) the studio window — same as a left-click / the Start-menu shortcut. |
| Arrange windows | Snaps every open window that matches a zone widget's rule into that zone. |
| Re-fit overlays to monitors | Re-fits the overlays after monitors are moved/added/removed at runtime. |
| Launch at login (check item) | Mirrors Settings → Startup (the durable HKCU preference, see `autostart.rs`). |
| Update available: vX / Update checks off | Disabled until the opt-in background check finds a newer release; clicking opens the release page (no auto-installer). |
| Quit | |

Global shortcuts (registered with Windows by `main.rs`, listed read-only as "built-in" under
Settings → Shortcuts):

- **`Ctrl+Alt+E`** — toggle desktop edit mode on every overlay (`Ctrl+E` is the in-window alias).
- **`Ctrl+Alt+Shift+E`** — rescue: force every widgetsack window interactive and bring it
  forward, even if its webview crashed. Settings → Diagnostics has the same button.

Settings → Diagnostics also hosts the live **logs** pane (the backend's structured log ring buffer,
filterable by level/target), **Copy diagnostics** (a text report of versions, process stats, and
recent logs for bug reports), and the **Developer mode** toggle (shows node ids and the devtools
items). Settings → About has the **check for updates automatically** toggle — **off by default**;
when on, the app asks GitHub for the latest release every 6 hours and only ever shows it (tray
item + badge); nothing is downloaded.

## Goals

- Replace Rainmeter with a homegrown, web-tech-themed widget system.
- **Better layouting** on the Xeneon; **easier editing/config** than `.ini`.
- Keep current wins: transparent borderless window, user-CSS theming, OBS capture,
  monitor management, now-playing via GSMTC.
- **Stay framework-portable**: the UI has since been ported from Svelte to React, so the
  rendering framework must stay a thin, swappable layer over a framework-agnostic core.

## Migration target (the actual skins to replace)

Source: `C:\Users\gng\Documents\Rainmeter\Skins\gyng`

| Skin | Contents | Maps to |
| --- | --- | --- |
| **DateTime** | time `%H%M`, day-of-week (pictographic font via Substitute), date `%d`, month `%B` upper | `clock` / `text` meter, no backend |
| **System** | CPU avg (smoothed), **32 per-core** LINE graphs in an 8×4 grid, RAM %, Swap %, GPU load (UsageMonitor), dedicated VRAM (~10 GB card) | `cpu.total`, `cpu.core.N`, `mem.used`, `swap.used`, `gpu.util`, `gpu.vram` → gauge/bar/sparkline |
| **Network** | NetIn/NetOut mirrored histograms (one flipped) + autoscaled text | `net.down` / `net.up` → sparkline + text |
| **Music** | cover, progress bar, position/duration, title, artist | already covered by current NowPlaying widget |

**Palette:** white text `255,255,255`; pale-green labels `218,237,226`; teal accent `119,196,211`.
**Fonts:** a condensed grotesque (Bahnschrift by default); a pictographic day-of-week font in DateTime (see Risks → fonts).

## Decisions (locked)

- **Window model: A′ — overlay canvas + studio window** (revised 2026-06-02 from
  overlay-only). Two surfaces, clean split: a transparent, normally click-through **overlay
  per monitor** is the *display + in-place layout canvas* (live widgets, selection, drag/
  resize/align, native context menu); a normal, focusable, taskbar-present **studio window**
  (`/studio` route, own capability label) is the *design surface* — widget designer, library,
  params, per-monitor outline, settings. Both consume the same `widgets.json` /
  `widgets.lib.json` (single source of truth) and the framework-agnostic core; a lightweight
  in-memory `layout_draft` event channel keeps the two surfaces live during a drag, with the
  file as the commit point. One webview per monitor stays efficient even with 32 core graphs.
  Mirrors Rainmeter (skins on the desktop + a Manage window). See "Window topology" below.
- **Editing: Both.** `widgets.json` + live reload is the foundation; an in-app visual
  editor (edit-mode toggle: drag/resize/snap, palette, inspector) is layered on top,
  reading/writing the same JSON.
- **GPU: NVIDIA (NVML) + generic perf-counter fallback.** NVML for clean
  load/VRAM/temp; Windows perf counters (PDH) as the vendor-agnostic fallback — the
  same source Rainmeter's UsageMonitor uses. Only NVIDIA is confirmed present.
- **Framework-portable core (now React).** All durable logic lives in a
  **framework-agnostic TypeScript core** with zero framework imports. Only the component
  layer (meters, canvas, editor) is React. The Svelte→React port reused the core verbatim
  and reimplemented only the components. See "Framework portability" below — this
  constrained every phase, not just the UI. Outcome: **components reimplemented, `core/`
  shared unchanged** (no web-component investment up front).
- **Z-order & input: always-on-top overlay, click-through by default, per-region
  interactivity required.** Some widgets (now-playing controls, the editor) must catch
  clicks while the rest passes through. This is **in scope, not deferred**, and must be
  **perf-conscious** (see Risks → click-through). WorkerW "on-desktop" z-order stays
  out of scope.
- **Multi-monitor from day one, no cross-monitor widgets (yet).** One overlay window
  per monitor on all monitors; each widget is bound to a single monitor; no
  spanning/dragging widgets across monitors initially.
- **Fonts: system fonts by default, any installed font allowed.** Default to Bahnschrift (ships
  with Windows); any widget can set `fontFamily` to an installed font, which the system-fonts
  loader @font-faces by name so it resolves even for per-user installs (and the day-pictograph
  font). Avoids bundling/licensing.
- **Sensor cadence: per-sensor configurable interval, 1 Hz default.**
- **Rename `np` → `widgetsack`.** Product identity change; staged as its own commit
  (Phase R) given the build-path blast radius — see Environment notes.

## Architecture

```
Rust (widgetsack/)                  Framework-AGNOSTIC core (client/src/lib/core/, no framework)
┌──────────────────────────┐       ┌──────────────────────────────────────────┐
│ sensors: trait + sched    │ emit  │ telemetry client: 1 listener → per-sensor  │
│  - system  (sysinfo)      │"tele- │   latest + ring-buffer history             │
│  - gpu     (nvml/PDH)     │ metry"│   subscribe(id,cb)->unsub  +  getSnapshot  │
│  - media   (gsmtc, push)  │──────▶│ layout: schema + validate + migrate        │
│ commands:                 │       │ sensors: id catalog + metadata             │
│  list_sensors             │◀─────▶│ format: clock / byte-rate autoscale / %    │
│  load_layout/save_layout  │invoke │ geometry: snap / align / rect              │
└──────────────────────────┘       └───────────────┬────────────────────────────┘
        │                                           │ (consumed via tiny adapter)
   widgets.json (app data dir)          ┌───────────┴───────────────┐
   notify file-watch → live reload      │ React layer (swappable)    │  ← ported from
                                         │  stores ← core.subscribe   │     Svelte; swaps
                                         │  registry: type → cmpt     │     only this box
                                         │  Canvas (per monitor)      │
                                         │   └ WidgetHost × instances │
                                         │      └ meters, editor      │
                                         └────────────────────────────┘
```

### Window topology (overlay canvas + studio)

```
Studio window (normal, taskbar)          Overlay per monitor (transparent, click-through)
  route /studio                             route /?monitor=<i>
  ┌────────────────────────┐                ┌── Monitor 1 ──┐  ┌── Monitor 2 ──┐
  │ widget designer        │   layout_      │  live widgets │  │  live widgets │
  │ library · params       │   draft   ┌───▶│  + in-place   │  │  + in-place   │
  │ outline · settings     │──events───┘    │    editing    │  │    editing    │
  └───────────┬────────────┘                └───────┬───────┘  └───────┬───────┘
              │  save_layout / save_library (commit)        load + listen │
              └──────────────┬──────────────────────────────┴────────────┘
                             ▼
              widgets.json + widgets.lib.json   (single source of truth, notify-watched)
```

- **Overlay** (built): display + WYSIWYG layout editing. Stays transparent/click-through;
  selection, drag/resize, alignment guides, and the native context menu live here.
- **Studio** (new): a normal `WebviewWindow` (decorations, taskbar, focusable) on a `/studio`
  route with its own capability label. Hosts the heavy panels and the widget designer.
- **Sync:** the file stays the source of truth (commit + `notify` live-reload, as today). On
  top, transient `layout_draft` Tauri events mirror in-progress edits between studio ↔ overlays
  so dragging on the canvas updates the outline (and vice-versa) without a per-frame file round-trip.
- **Entry:** a tray left-click (or the tray menu's "Open studio" / the Start-menu shortcut,
  which passes `--studio`) focuses or spawns the studio window. `Ctrl+Alt+E` toggles desktop
  edit mode on the overlays instead (`Ctrl+E` inside a window); there is no "Edit layout" tray
  item any more — see "Tray & global shortcuts (current)" below.

## Stable contracts (the framework-agnostic API)

These three contracts are the platform. They must not depend on any UI framework; a
React port keeps them unchanged.

### 1. Telemetry event (Rust → frontend)

One `telemetry` event per tick carrying a **batch** (cheaper than one event per sensor;
32 cores = 1 event/tick, not 32). Media is push-based and emits its own samples on
change. Backend only runs sensors referenced by the active layout (subscription), so
NVML/PDH don't spin when no GPU widget exists.

```ts
type SensorValue =
  | { kind: 'scalar'; value: number }
  | { kind: 'text';   value: string }
  | { kind: 'series'; value: number[] }
  | { kind: 'json';   value: unknown };   // media session payload, etc.

type SensorSample = { sensor: string; tsMs: number; value: SensorValue };
type TelemetryBatch = SensorSample[];     // payload of the `telemetry` event
```

```rust
enum SensorValue { Scalar(f64), Text(String), Series(Vec<f64>), Json(Value) }
struct SensorSample { sensor: String, ts_ms: u64, value: SensorValue }
```

### 2. Layout JSON (`widgets.json`, versioned)

```ts
type WidgetInstance = {
  id: string;
  type: string;                     // 'clock'|'gauge'|'bar'|'sparkline'|'text'|'nowplaying'
  sensor?: string;                  // 'cpu.total','cpu.core.3','net.down',... (omit if self-sourcing)
  rect: { x: number; y: number; w: number; h: number };  // per-monitor logical px
  layer?: 'top' | 'desktop';        // z-layer (3c); routes widget to that layer's overlay window. default 'top'
  config: Record<string, unknown>;  // min,max,format,color,historyLen,unit,...
  css?: string;                     // per-widget style override (current ThemeInjector)
};
type Layout = {
  version: number;                                        // for migrations
  monitors: Record<string, { widgets: WidgetInstance[] }>; // key = monitor id
};
```

Meters are either **sensor-bound** (gauge → `cpu.total`) or **self-sourcing** (clock →
local `Date`); `sensor` is therefore optional. Each per-monitor overlay window is labelled
with its monitor id and renders only `layout.monitors[<its id>]`.

### 3. Commands (frontend → Rust)

```ts
type SensorMeta = {
  id: string;                       // 'cpu.total','net.down',...
  kind: SensorValue['kind'];        // scalar|text|series|json
  unit?: string;                    // '%','B/s','MiB',...
  min?: number; max?: number;       // suggested gauge/bar bounds
  available: boolean;               // false e.g. GPU sensor with no NVIDIA driver
};
```

`list_sensors() -> SensorMeta[]`, `load_layout() -> Layout`, `save_layout(Layout)`.
The backend **owns the layout file**, so on load/save it derives the set of referenced
sensor ids and runs only those (no NVML/PDH spin-up when unused). Live reload is driven by
a `notify` file-watch on `widgets.json` emitting a `layout_changed` event the frontend
listens for.

**Home Assistant (Phase 8c).** `ha_connect()` / `ha_disconnect()` start/stop the server-side
WS proxy task; `list_ha_entities() -> HaEntity[]` feeds the inspector dropdown (REST);
`ha_call_service(domain, service, data) -> Value` actuates (REST); `save_ha_config(url, token)`
writes `plugins/ha.json`; `ha_config_status() -> { configured, url }` — never returns the token.
HA entity state arrives over the **existing** `telemetry` event as `ha.<entity_id>` (plus
`ha.<entity_id>.state` when numeric, and `ha.status` for the connection state).

### 4. Layout tree + groups (v2 — the model both designers share)

Two designers, **one recursive model**:

- **Layout designer** (Phase 5) arranges **units** on a monitor with containers
  (panes/splits), alignment, gap/padding, and a floating layer that escapes the grid.
- **Widget designer** (Phase 6) composes primitives into a **group** ("a logical widget")
  with its own internal layout; a group is one unit the layout designer places.

A **unit** is a primitive meter (today's `gauge`/`bar`/`sparkline`/`text`/`clock`/`button`)
or a **group**. Same node grammar at both levels — a group is a *leaf* to the layout solver
and a *container-root* to the widget designer — so a single pure solver recurses through both.

```ts
type Length = number | 'auto' | { fr: number };          // px | intrinsic | flex share

type Container = {                                        // the layout designer's panes/splits
  id: string; kind: 'row' | 'col' | 'grid';              // hsplit=row, vsplit=col, multi-pane=grid
  cols?: number;                                          // grid: 2 | 3 | 4
  gap?: number; pad?: number | { t: number; r: number; b: number; l: number };
  align?: 'start' | 'center' | 'end' | 'stretch';        // cross axis
  justify?: 'start' | 'center' | 'end' | 'between' | 'around'; // main axis
  bounds?: Rect;                                          // default = parent content box (root → work area)
  children: LayoutNode[];
};
type Group = {                                            // built in the widget designer; one unit to layout
  id: string; kind: 'group'; name?: string;              // "System", "Network"
  def?: string;                                           // id of a reusable WidgetDef; inline subtree if absent
  size: { w: number; h: number };                        // the group's own box (its intrinsic size)
  child: LayoutNode;                                      // internal tree, local coords
  config?: Record<string, unknown>; css?: string;
};
type Leaf = { id: string; unit: WidgetInstance | Group; basis?: Length };
type LayoutNode = Container | Leaf;

type MonitorLayout = { root: Container; floating: Leaf[] };       // flow tree + escape-the-grid layer
type Layout = { version: 2; monitors: Record<string, MonitorLayout> };

// reusable library (Phase 6c/d) — instantiate one def many times, rebinding params
type WidgetDef = { id: string; name: string; size: { w: number; h: number }; child: LayoutNode; params?: ParamSpec[] };
```

**Pure solver (the heart).** `solveLayout(node, contentRect) -> Map<widgetId, Rect>` recurses:
containers distribute the main axis by `basis`/`fr`, place the cross axis by `align`, apply
`gap`/`pad`/`justify`; a group solves its `child` inside its own `size` box and contributes
that box as the unit's intrinsic size; a primitive contributes its `rect.{w,h}`. **No text
measurement** — intrinsic size is what you set in the inspector. Lives in `core/` (zero framework deps),
unit-tested like `align.ts`. Canvas renders solved primitive rects; `WidgetHost` is unchanged.

**Migration v1 → v2 (no data moves).** `widgets[]` → `floating: widgets.map(leaf)`, `root` =
empty container. Existing/demo layouts render identically (all floating). `parseLayout` accepts
both versions; `rect` means absolute monitor px for floating units and local/solved coords
in-flow or inside a group.

## Framework portability (Svelte → React, done)

The pivot that made the React port cheap: **Svelte's store contract and React's
`useSyncExternalStore` both consume `subscribe(cb) => unsubscribe`.** So the core exposes
a minimal notify-based observable per sensor; each framework adds a ~5-line adapter — which
is exactly how the port landed.

```ts
// core/telemetry.ts — no framework imports
interface SensorObservable {
  subscribe(cb: () => void): () => void;   // notify-only
  getSnapshot(): { value: SensorValue; history: number[] };
}
```

```ts
// before — svelte/store adapter (Svelte store = { subscribe(run) })
const sensorStore = (id) => ({
  subscribe: (run) => { const o = core.sensor(id); run(o.getSnapshot());
                        return o.subscribe(() => run(o.getSnapshot())); }
});
```

```tsx
// after (current): useSensor.ts
const useSensor = (id) => { const o = core.sensor(id);
  return useSyncExternalStore(o.subscribe, o.getSnapshot); };
```

**Repo structure to enforce the boundary**

- `client/src/lib/core/` — telemetry, layout, sensors, format, geometry, commands.
  **Zero React / framework imports.** Unit-tested with vitest (no DOM).
- `client/src/lib/widgets/` — React: registry, `WidgetHost`, meters, `Canvas`, editor.
- The React port imports `core/` unchanged (it happened in place; the `client-react/` /
  `packages/` split never became necessary).

Rule of thumb: **if it would be rewritten for React, it must not live in `core/`; if it
would be copy-pasted, it must.** Meters are the gray area — kept in the component (React)
layer; web-components remain a later option only for runtime plugin loading (see Open decisions).

## Key technical risks & mitigations

- **Per-region click-through (headline risk, in scope).** `set_ignore_cursor_events`
  is all-or-nothing per window; Tauri has **no native per-region hit-testing**
  ([#2090](https://github.com/tauri-apps/tauri/issues/2090),
  [#9250](https://github.com/tauri-apps/tauri/issues/9250)). Modes:
  - Normal + no interactive widgets → window fully click-through; **no watcher runs**.
  - Edit mode → window fully interactive (ignore-cursor off); no per-frame work.
  - Normal + ≥1 interactive widget → cursor watcher hit-tests against the interactive
    rects (synced frontend→Rust only on layout/edit-state change, not per frame).
  - **Perf rules** (the "perf considerations"):
    - Watcher only exists when the active layout has an interactive widget.
    - `GetCursorPos` is ~free; the cost is `set_ignore_cursor_events` (webview IPC) — so
      **toggle only on state transitions**, never per frame, with edge hysteresis to
      avoid flapping.
    - Short-circuit with a precomputed **union bbox** of interactive rects before
      per-rect tests.
    - Pause the watcher when the overlay is hidden/occluded.
    - Start with a gated `GetCursorPos` poll (~60 Hz only while needed); if CPU shows
      up, switch to an event-driven `WH_MOUSE_LL` low-level hook (≈0 CPU when idle).
- **Z-order / "stay on desktop."** Always-on-top is a one-call toggle. True
  Rainmeter-style "pinned to desktop, below windows" needs WorkerW/Progman parenting
  (wallpaper-engine technique) — complex and Windows-specific. Scope: ship
  always-on-top + normal now; WorkerW is a Phase 4 stretch, flagged as optional.
- **GPU.** NVML (`nvml-wrapper`) loads `nvml.dll` at runtime → no build dep; must
  **degrade gracefully** if absent (no NVIDIA driver) and fall back to PDH counters
  (`windows` crate) or disable GPU sensors. VRAM math mirrors the skin
  (`dedicated / total`).
- **DPI / multi-monitor.** Overlay must cover each monitor exactly; Tauri mixes
  physical/logical px and per-monitor scale factors. Reuse existing `monitor.ts` logic;
  store rects in per-monitor logical px.
- **Fonts.** Default to Bahnschrift (ships with Windows; no bundling/licensing). Widgets resolve
  **system-installed** fonts via the system-fonts loader (fontdb → @font-face), so a configured
  font and the custom day-pictograph font work when present, incl. per-user installs; fall back
  to the token stack when absent.
- **Phase 0 refactor risk.** Moving all window/monitor/settings logic out of
  the legacy `NowPlaying` component and onto the canvas is the riskiest change. Mitigation: keep the
  current page working behind a flag/route until the canvas reaches parity; don't delete
  the old path until then.
- **Sparkline rendering.** 32 sparklines @ ~1 Hz: SVG is fine and simplest. Switch to
  `<canvas>` only if update rate climbs. Decide per-meter, not globally.
- **Media event weight.** Thumbnails are sent as byte arrays in events today; folding
  media into `telemetry` must not fatten every batch. Keep media push-only-on-change and
  consider a `get_thumbnail(sessionId)` command instead of inlining bytes (revisit).

## Phased plan

### Phase S — vertical slice (prove the pipe) ✅ code complete, gates green
- [x] `sysinfo` dep + `widgetsack/src/sensors.rs`: loop emits `telemetry` batch with `cpu.total` (+ serde-contract test).
- [x] Wire sensor loop into `main.rs` setup.
- [x] `core/telemetry.ts`: framework-agnostic hub (per-sensor observable, ring buffer) + tests.
- [x] Store adapter (`createStore`) + `Gauge` meter (pure `gaugeFraction` + tests) + `Canvas`/`WidgetHost`/registry; CPU gauge mounted on the page.
- [x] All gates green: `npm run check`/`lint`/`test:unit`/`build`, `cargo test`/`clippy`.
- [ ] Visual confirm: `cargo tauri dev` → live CPU gauge (run by user). Checkpoint.

### Phase R — rename np → widgetsack ✅ done (999b4a3), verified on hardware
Identifier `io.github.gyng` kept so the app data dir / saved settings aren't orphaned.
- [x] crate `name`/`default-run`/description → `widgetsack` (binary `widgetsack.exe`).
- [x] root `Cargo.toml` workspace member; dir `np/` → `widgetsack/` (`git mv`; before-command
      / `frontendDist` paths are relative to the conf dir so they still resolve to `client/`).
- [x] `tauri.conf.json`: `productName` → `widgetsack`, window `title` → `WidgetSack`.
- [x] `.github/workflows/build.yml`: pin a current v2 tauri CLI (old rc.0 can't parse 2.11).
- [ ] README — deferred (has uncommitted local edits). localStorage key `_mediaStore` left as-is.

### Phase 0 — refactor seam (+ core boundary)
- [ ] Establish `core/` (zero framework) vs `widgets/` (React) split; move types into `core/`.
- [ ] Widget registry + `WidgetHost` (dynamic component lookup), instance-as-data.
- [ ] Make NowPlaying one registered widget; extract window/monitor/settings off it (behind flag).
- [ ] Canvas becomes the main view; nothing lost.

### Phase 1 — sensors
- [x] sysinfo: `mem.used`, `swap.used` (%), `net.up`/`net.down` (B/s) — Phase 1a, with pure `percent`/`rate_per_sec` tests; CPU + RAM gauges wired on the canvas.
- [x] sysinfo: `cpu.core.N` per-core scalars (Phase 2a) — one ring-buffered sensor per core.
- [x] GPU: NVML `gpu.util` / `gpu.vram` / `gpu.temp` with graceful degrade (NVML init fails → skipped, no crash) — Phase 1b. PDH fallback for non-NVIDIA still pending.
- [x] **Totals + Rainmeter parity** (zero-dep): absolute-byte sensors alongside the percents —
      `mem.{total,used.bytes,available,free}`, `swap.{total,used.bytes,free}`,
      `gpu.vram.{total,used,free}`; plus `net.total` + cumulative `net.{down,up}.total`,
      dynamic per-drive `disk.<letter>.{total,free,used,used.pct}` (≈ FreeDiskSpace), `host.uptime`
      (+ a `duration` formatter) / `host.procs`, `cpu.{freq,brand,cores.logical,cores.physical}`,
      and `gpu.{mem.util,clock.core,clock.mem,power,power.limit,fan,name}`. The percent ids are
      kept for back-compat; the GPU demand-gate became a `gpu.*` prefix, and the now-expensive
      refreshes (processes, cpu frequency, disks) are gated behind their own active-id checks.
- [x] **Battery** (Windows, when present): `battery.{percent,state,time}` via `GetSystemPowerStatus`
      (no new crate; `Win32_System_Power` feature). Desktops with no battery emit nothing.
- [x] **More Win32 sensors** (windows crate, no new crate; gated): one `GetPerformanceInfo` →
      `mem.commit.{used,limit,peak}` / `mem.cached` / `mem.kernel.{paged,nonpaged}` (bytes) +
      `host.handles` / `host.threads`; one `CallNtPowerInformation(ProcessorInformation)` → live
      `cpu.freq.current` / `cpu.freq.max` + per-core `cpu.core.N.freq` (MHz — sysinfo's `cpu.freq`
      is only the BASE clock on Windows, so this is the boost clock it can't give); `host.idle`
      (seconds since last input, GetLastInputInfo). New features: `Win32_System_ProcessStatus`,
      `Win32_System_SystemInformation`, `Win32_UI_Input_KeyboardAndMouse`.
- [x] **More Win32 (round 2):** live **disk I/O** `disk.<letter>.{read,write}` (bytes/s) +
      `disk.<letter>.busy.pct` (active time) via `DeviceIoControl(IOCTL_DISK_PERFORMANCE)` on a
      zero-access volume handle, with a per-volume prev-sample cache (features `Win32_Security` +
      `Win32_Storage_FileSystem` + `Win32_System_IO` + `Win32_System_Ioctl`); richer **battery**
      `battery.rate` (W, signed) + `battery.capacity.{full,remaining}` (Wh) via
      `CallNtPowerInformation(SystemBatteryState)`; **network link** `net.linkspeed.{rx,tx}` (bytes/s
      — the missing %-utilisation denominator) + `net.adapter` / `net.state` (text) from one
      `GetIfTable2` walk picking the primary connected adapter (features
      `Win32_NetworkManagement_IpHelper` + `_Ndis`). All gated (`is_disk_io_id` / `is_netlink_id`;
      battery presence-gated).
- [ ] **Still deferred:** `audio.peak` for a visualizer (`IAudioMeterInformation`; wants its own
      ~30–60 Hz timer + COM thread — and the parallel audio-spectrum widget already owns the
      WASAPI/COM-audio edge, so coordinate there). Thermal stays out — only the ACPI passive zone is
      reachable from Win32 (usually a static trip point); real die temps need a kernel driver
      (LHM-class). Also available-but-skipped: `net.tcp.{established,retrans}`, disk IOPS, net error counters.
- [ ] **CPU/board temps + fan RPM** — deferred: `sysinfo`'s `Components` is empty on Windows and
      NVML only exposes the GPU die temp (already `gpu.temp`). Real CPU/VRM temps + fan RPM need a
      LibreHardwareMonitor bridge (often admin + a running service) — out of proportion to value for
      now. Likewise GPU `pcie`/`encoder`/`decoder` util are available via NVML but left out as niche.
- [ ] Media (GSMTC) re-expressed as a push sensor emitting `Json` under the same contract.
- [x] Sensor catalog for the editor: live ids from the telemetry hub (`sensorIds`) + a curated
      list → inspector `<datalist>` (tested `sensorCatalog`). Replaces a Rust `list_sensors`.
- [ ] Deferred (low value): per-sensor configurable interval; running sensors only when
      referenced by the layout — all current sensors are cheap at 1 Hz.

### Phase 2 — meters
- [x] `Gauge` (Phase S) + `Sparkline` (Phase 2a, pure geometry + tests); per-core CPU row + net sparkline on the canvas.
- [x] `Text` (byte-rate/percent formatters) + `Clock` (moment-like tokens, `[literal]` escaping) — Phase 2b, pure formatters + tests; clock/date + net up/down readouts on the canvas.
- [x] `Bar` meter (horizontal/vertical fill; shares pure `fraction` scale with Gauge) — Phase 2c. Core meter set complete.
- [ ] Carry palette + fonts (system `fontFamily` override). Rebuild DateTime / System / Network as instances; reach parity.

### Phase 3 — layout + config (the stated priority)
- [x] `widgets.json` in app config dir; `load_layout`/`save_layout` commands + pure `parseLayout` validation (Phase 3a, tested). Canvas loads it on mount, falling back to the demo default.
- [x] `notify` file-watch on widgets.json → `layout_changed`; Canvas live-reloads external edits (ignored while actively editing) — Phase 3b.
- [x] **3c-1 (single overlay):** transparent, always-on-top, skip-taskbar window filled to
      its monitor; `setIgnoreCursorEvents(true)` normally, `false` in edit mode (whole-window
      click-through). Edit toggled by a **tray menu** ("Edit layout" / "Quit"). `layer` field
      added (default `top`); NowPlaying legacy positioning disabled (overlay owns the window;
      settings stay reachable in edit mode). New capability file `overlay.json`. **Verified
      on hardware** (overlay fills monitor, clicks pass through, tray toggles edit).
- [x] **3c-1 follow-up — global hotkey** (Ctrl+Alt+E) ✅ done (29b9ac8). Bumped the whole
      tauri stack to 2.11 (a fresh lock resolve; the earlier conflict was pinned `tauri 2.8.5`
      vs a 2.10 `tauri-runtime-wry` the plugin pulled). Registered in Rust; broadcasts
      `toggle_edit` like the tray/Ctrl+E. Aligned `@tauri-apps/api` to ^2. Verified on hardware.
- [x] **3c-2 (multi-monitor):** the primary window spawns a click-through overlay per other
      monitor (`?monitor=<i>`); each window renders/saves only its monitor's widgets
      (read-modify-write, no clobber). NowPlaying renders on the primary only. Capability
      `overlay.json` covers `overlay-*` (create-window + window perms + core:default).
      Edit toggles broadcast (tray + Ctrl+E) so all monitors stay in sync.
      **Verified on hardware** (multi-monitor overlays, per-monitor add/persist, Ctrl+E all).
- [x] Visual editor v1: Ctrl+E edit mode, drag-to-move with snap-to-grid (tested geometry), save-on-drop to widgets.json — Phase 3d.
- [x] Editor: corner/edge resize handles with tested `resizeRect` — Phase 3d-2.
- [x] Editor: widget palette (add) + inspector (sensor / x/y/w/h / config JSON) + select + remove — Phase 3d-3.
- [x] Editor: alignment guides — snap a dragged widget's edges/centres to peers, with
      teal guide lines (pure tested `snapRectToPeers`) — Phase 4.
- [ ] Per-monitor layouts; Xeneon arrangement. Migrate existing localStorage settings.

### Phase 4 — polish / stretch
- 🚫 **DEFERRED — 3c-3 (desktop-pinned layer):** a second overlay window per monitor pinned
      to the wallpaper via WorkerW/Progman; widgets with `layer: 'desktop'` route to it.
      Fragile / Windows-version-specific. Deferred indefinitely — always-on-top covers the
      need; the `layer` field is already in the model so it can be picked up later additively.
- [x] Per-widget click-through (Phase 4, **verified on hardware**): widgets flagged
      `interactive` catch clicks in passive mode. A Rust cursor watcher (`clickthrough.rs`,
      ~60 Hz, idle when none, toggles on transition) hit-tests `app.cursor_position()` against
      per-window screen rects synced from the frontend, flipping that window's
      ignore-cursor-events. Addable `button` (counter) widget is the fixture; three-way test
      passed (interactive catches, meters/empty pass through).
- [x] Editor: alignment guides — snap a dragged widget's edges/centres to peers, with
      teal guide lines (pure tested `snapRectToPeers`) — Phase 4.
- 🚫 **SKIPPED — PDH GPU fallback for non-NVIDIA** (and temps/fans via HWiNFO/LHM shared
      memory). The target machine is NVIDIA (NVML covers it) and there's no non-NVIDIA
      hardware to verify against — not worth building blind. Revisit only if needed.

## Phase 5 — Layout designer (arrange units: panes, align, taskbar-aware)

A real designer, not just free-drag: containers (multi-pane 2/3/4, h/v split) with align +
gap/padding, a floating layer that escapes the grid, taskbar awareness, and a right-click
context-menu entry. **Additive** — v2 migrates v1 to all-floating, so nothing already placed
moves. Operates on **units** (primitives or groups); groups are atomic here (authored in Phase 6).

Design decisions (proposed; confirm in Open decisions):

- **hsplit = `row`, vsplit = `col`, multi-pane = `grid` (`cols` 2/3/4).** "Align L/C/R" maps to
  `justify` on a row and `align` on a column; the inspector labels them in human terms.
- **Floating stays the default** (today's behavior); the flow `root` is opt-in.
- **Root bounds default to the monitor work area** (taskbar-aware); floating units may sit over
  the taskbar.
- **Context menu = native (muda)** shown by the Rust right-click detector, so it works in
  passive (click-through) mode without a webview round-trip.

### 5a — v2 model + solver + migration (pure core, no UX change) ✅ done, 141 tests green
- [x] `core/layoutTree.ts` (types + `Container.basis` + constructors) and `core/solve.ts`
      (`solveLayout`/`solveMonitor`/`resolveGroup`: row/col/grid, gap/pad/align/justify,
      fr/auto/px, group namespacing). Unit-tested hard (50 cases) — the heart of the feature.
      Designed + adversarially test-spec'd via a 5-agent workflow; critique fixes folded in
      (grid-cell clamp, children-derived grid intrinsic, fail-closed param setPath,
      rect re-validation on migrate, array-monitors rejection, exact-float render = no snap seam).
- [x] `core/migration.ts`: `parseLayoutAny` accepts v1 + v2; `migrateV1` wraps `widgets[]` into
      floating leaves (dropping malformed rects). Tested (10 cases).
- [x] `core/layoutEdit.ts`: pure immutable tree ops (find/parent/insert/remove/move/update +
      flowLeaves/allContainers) — the shared editing core for 5c/5e/6a. Tested (16 cases).
- [x] Canvas migrated to the v2 `MonitorLayout` + v2 file format; renders/edits the **floating**
      layer identically (root round-trips). Flow rendering of the `root` tree → 5c.

### 5b — taskbar / work-area awareness ✅ done — cargo build/test/clippy green
- [x] Rust `current_work_area(window) -> ScreenRect` via `MonitorFromPoint` + `GetMonitorInfoW`
      `.rcWork` (`windows` 0.61 crate, matched to Tauri's; no HWND so no version mismatch).
      Returns physical px.
- [x] Frontend `monitorWorkArea()` rebases to the monitor origin + descales → local logical px;
      the Canvas solves the flow tree into the **work area** (taskbar excluded), falling back to
      the full window. (Work-area snap-guide line is a small follow-up.)

### 5s — studio window ✅ done — cargo green; runtime to verify on hardware
- [x] A normal, decorated, taskbar-present `studio` `WebviewWindow` (980×680) spawned from the
      tray **"Open designer"** item (Rust emits `open_studio`; the primary overlay spawns/focuses
      it via JS — reuses the working `WebviewWindow` path). Detected by window **label** (not a
      route/query — sidesteps dev/prod URL + prerender pitfalls). Capability `overlay.json` now
      covers `"studio"`.
- [x] Studio runs the same `Canvas` in **studio mode**: opaque window, always in edit mode, no
      overlay fill/click-through; lays the layout into the whole window. It edits the primary
      monitor and **syncs to the overlays via `widgets.json` + the existing `layout_changed`
      watch** (the file is the source of truth — a transient `layout_draft` live channel is a
      follow-up if the file-watch lag ever shows).
- [~] Panels currently live in **both** the overlay edit mode and the studio (the overlay editor
      still works). Fully relocating them off the overlay is optional polish.

### 5c — container editing (no DnD yet) ✅ done — built in overlay edit mode (relocates to studio in 5s)
- [x] Container panel (Inspector): kind, cols, gap, pad, align, justify, grow(fr) — live-editing
      the selected container. Widget panel gains dock/float; add-widget palette retained.
- [x] Palette "+Row / +Col / +Grid" (Outline header) — adds into the selected container or root.
- [x] Tree-outline (`Outline.tsx` + pure `outlineRows`): select / reorder (↑↓) / reparent
      (⟸ out, ⟹ in) / dock (⤒) / float (⤓) / remove (✕). All edits funnel through one `op`
      union → `handleOp` → `core/layoutEdit`. Overlay solves + renders the flow tree
      (`collectRenderables`, group-aware); the reusable `library` round-trips in `widgets.json`.

### 5d — right-click context menu ✅ done (in-editor); passive-mode variant deferred
- [x] **In-editor context menu**: right-click any widget → `Make widget` · `Float`/`Dock →flow` ·
      (group) `Edit def…`/`Ungroup` · `Remove`; right-click empty canvas → `+ Row`/`+ Column`/
      `+ Grid`. Pure React (`WidgetHost` emits `contextmenu`, Canvas renders a positioned menu +
      backdrop; Esc / click-away closes). Gate-verified.
- 🚫 **Passive-mode (right-click while NOT editing) deferred** — to fire over a click-through
      overlay without hijacking/duplicating the Windows desktop menu it needs a global
      `WH_MOUSE_LL` hook that **swallows** right-clicks over widget rects (invasive: global input,
      threading/deadlock risk) and can't be runtime-verified without an interactive display. The
      editor already opens three robust ways (tray "Edit layout", tray "Open designer", Ctrl+Alt+E),
      so this is an optional follow-up — best done in a session where it can be tested on hardware.

### 5e — direct manipulation (drag-and-drop) — CORE ✅ done (overlay), 152 tests green
- [x] Overlay: in-flow widgets **ghost-drag** to reorder/reparent with a live teal **insertion
      bar**; pure `dropTarget(root, solved, point, draggingId)` (leaf-hit-test → `{parentId,index}`)
      feeds straight into `moveNode`. Tested.
- [x] Overlay: **dock** a floating widget by releasing it over the flow tree; **float** a flow
      widget by dragging it onto empty canvas (re-anchored at the cursor). Floating free-move +
      snap/guides retained.
- [ ] Studio outline drag-reorder — deferred to 5s (the outline already reorders via buttons;
      HTML5 DnD doesn't cross OS windows, so studio→overlay placement stays click-to-add-then-drag).

## Phase 6 — Widget designer (compose primitives into a reusable widget)

Group a bunch of labels/meters into one composite — "a widget" — that's **reusable from the
start**: grouping creates a named `WidgetDef` in a first-class library, and the layout holds
**instances** (`Group` with `def`) that reference it. A **separate view in the studio window**
(its own tab, not the overlay), but it reuses the same containers / solver / inspector scoped to
the def's box. The
headline payoff: System's 32 per-core graphs become **one def × 32 instances**, each binding a
different `cpu.core.N` via params (6c) — not 32 hand-placed sparklines.

The solver gains a pure `resolveGroup(group, library)` (look up `def`, apply param overrides,
solve its `child` inside `size`); kept in `core/` and tested. The library is its own file
(`widgets.lib.json`), watched + reloaded like `widgets.json`.

### 6a — defs + library + group/ungroup (foundational) ✅ done, 149 tests green
- [x] `Library` (`WidgetDef[]`) **embedded in `widgets.json`** under a `library` key (loaded/saved
      with the layout, round-tripped read-modify-write across monitors) — avoids new Rust commands;
      can split into `widgets.lib.json` later if sharing defs warrants it.
- [x] **Make widget**: select a flow container/widget (or a floating widget) → wraps it into a new
      `WidgetDef` (`size` = `intrinsicSize`, `child` = cloned subtree) + a `Group` instance
      referencing it. **Ungroup** inlines the def's child back (`ungroupNode`, pure + tested;
      floating single-primitive groups handled in the Canvas). Group inspector panel added.
- [x] `resolveGroup` + `collectRenderables` (group-aware, id-namespaced) render instances on the
      canvas — one def × N instances never collide. Tested.

### 6b — group editor (the widget designer proper) ✅ done — in-place, reuses the overlay editor
- [x] "Edit def…" (group inspector) swaps the overlay into a **scoped def editor**: `monitor` is
      replaced by the def's child tree, the real monitor stashed; a teal "Editing widget: <name>
      [Done]" banner shows. All the existing tooling (outline / inspector / add / containers /
      drag) operates on the def; edits fold back into the library on every save, so **every
      instance re-renders live**. Def `size` (w/h) editable from any instance's inspector. Save is
      guarded so the scoped tree never overwrites the real layout. (Full studio-tab scoping → 5s.)

### 6c — params / sensor remap (the reuse power — needed for the 32-core case) ✅ done
- [x] A def declares overridable bindings (`ParamSpec`: `key` + dotted `target`, e.g. `unit.sensor`)
      via the group inspector's "Add param"; each instance sets values in the inspector and
      `resolveGroup`/`applyParams` rebinds them on a cloned child (fail-closed setPath). The
      "one core-graph def × N instances, each binding `cpu.core.N`" workflow works end-to-end.

### 6d — library management ✅ done (detach/duplicate are follow-ups)
- [x] Inspector "Library" palette: insert a def as a new group; rename a def (propagates to
      instances); delete a def **guarded** (refused while any instance references it). Ungroup is
      the current "detach"; duplicate-def is a small follow-up.

### Phase 5–6 risks
- **Solver scope creep.** Constrain v1: single-line row/col (no wrap), uniform grid cells,
  `basis ∈ {auto, px, fr}`. Each rule lands as a unit test before any UI wiring. Recursion (group
  in container in group) must be covered by tests, not eyeballed.
- **Dual drag semantics** (free-move floating vs reorder-in-flow vs dock/undock) is the top UX
  risk and now a **core** interaction (5e). Mitigate with pure, tested `hitInsertionIndex` /
  `dropInto` helpers and clear affordances (insertion line + drop-zone highlight); 5c's
  inspector/outline path stays the precision fallback.
- **Native menu in passive mode.** Right-click must be caught while click-through is on; extend
  the cursor watcher to mouse buttons (or a `WH_MOUSE_LL` hook if polling misses fast clicks).
  Fallback: menu only in edit mode if detection proves flaky.
- **Work area is dynamic** (auto-hide taskbar, DPI, monitor hotplug). Re-query on
  `display-changed`; treat insets as hints recomputed on focus / `layout_changed`.
- **Two coordinate spaces.** Floating = absolute monitor px; in-flow / in-group = local/solved.
  Group/ungroup and float/unfloat must rebase rects correctly — pure, tested helpers only.
- **Migration & React.** v2 types, the solver, and all tree mutations are pure `core/` → the
  React port reuses them verbatim; only the editors (tree / DnD / group canvas) get reimplemented.

### Decisions locked (2026-06-02)
1. **Context-menu tech: native `muda` menu.** A Rust right-click detector pops an OS-native menu;
   works in passive (click-through) mode with no webview round-trip. (In-app HTML rejected — not
   worth the cursor-events plumbing / first-click-miss risk.)
2. **Build order: layout designer first, then the widget designer.** Phase 5 (5a–5e) → Phase 6
   (6a–6d); grouping rides on tooling Phase 5 already builds. **5e (drag-and-drop) is core, not a
   stretch** — mouse-dragging is the primary way to build a layout (decided 2026-06-02).
3. **Groups are reusable from the start.** Grouping creates a `WidgetDef` in a first-class library
   plus an instance referencing it; params / sensor-remap (6c) are **in scope, not deferred** —
   "one core-graph def × 32 instances" is a first-class goal. (One-off-inline-first rejected.)

## Wireframes (Phases 5–6)

Schematic, not final visuals — they pin down the model and the two designers' UX.

**How the model nests** — one recursive tree; a `Group` is a leaf to the layout solver and a
container-root to the widget designer:

```
MonitorLayout
├─ root .............. Container(col)
│  ├─ Container(row)   gap 8 · align center
│  │  ├─ Leaf ─ gauge  cpu.total
│  │  ├─ Leaf ─ gauge  mem.used
│  │  └─ Leaf ─ Group "GPU panel"          ← a widget (built in Phase 6)
│  │            └─ child: Container(col) ─ [gauge, bar, text]
│  └─ Container(grid cols=8)
│     └─ Leaf ×32 ─ Group "core-graph"     ← ONE def, each instance binds core=N
└─ floating ......... [ Leaf ─ Clock,  Leaf ─ NowPlaying ]   ← absolute, escapes the grid
```

**Layout designer** (Phase 5) — monitor overlay in edit mode: containers arrange units, a
floating layer escapes the grid, inspector + outline drive the tree, work-area edge is snappable:

```
Layout designer · Monitor 1 (overlay)                       [ EDIT · Ctrl+E ]
............................................................................
  ┌ row · gap 8 · align center ─────────────────────┐     ┌ floating ┐
  │  ┌──────┐   ┌──────┐   ┌──────┐                  │     │  12:04   │
  │  │ CPU  │   │ RAM  │   │ GPU  │                  │     └──────────┘
  │  └──────┘   └──────┘   └──────┘                  │
  └──────────────────────────────────────────────────┘
  ┌ grid cols=8 · per-core ──────────────────────────┐
  │  ▂▃▅ ▃▅▂ ▅▂▁ ▁▂▃ ▂▃▅ ▃▅▂ ▅▂▁ ▁▂▃    (32 cores)   │
  └──────────────────────────────────────────────────┘

  ┌ Inspector ──────────────┐   ┌ Outline ──────────┐
  │ Add ▸ gauge  bar  text  │   │ ▾ root (col)       │
  │     ▸ Row  Col  Grid…   │   │   ▾ row            │
  │ ─────────────────────── │   │     · CPU          │
  │ row    gap [8] pad [0]  │   │     · RAM          │
  │ align   [ center ▾ ]    │   │     · GPU          │
  │ justify [ start  ▾ ]    │   │   ▾ grid 8         │
  └─────────────────────────┘   └────────────────────┘
═══════════════════════ taskbar · work-area edge ═══════════════════════════
```

**Container kinds** — `row` = hsplit, `col` = vsplit, `grid` = multi-pane (`cols` 2/3/4):

```
row (hsplit)          col (vsplit)        grid cols=3
┌───┬───┬───┐         ┌─────────┐         ┌───┬───┬───┐
│ A │ B │ C │         │    A    │         │ A │ B │ C │
└───┴───┴───┘         ├─────────┤         ├───┼───┼───┤
   ← gap →            │    B    │         │ D │ E │ F │
                      ├─────────┤         └───┴───┴───┘
                      │    C    │
                      └─────────┘
```

**Align vs justify** (a `row`; the inspector labels these "vertical" / "horizontal"):

```
justify · main-axis (horizontal →)        align · cross-axis (vertical ↓)
 start       center      end               start      center     stretch
┌─────────┐ ┌─────────┐ ┌─────────┐       ┌───────┐  ┌───────┐  ┌───────┐
│■■■      │ │  ■■■    │ │      ■■■│       │■ ■ ■  │  │       │  │█ █ █  │
└─────────┘ └─────────┘ └─────────┘       │       │  │■ ■ ■  │  │█ █ █  │
                                          │       │  │       │  │█ █ █  │
                                          └───────┘  └───────┘  └───────┘
```

**Drag-and-drop** (Phase 5e, core) — drop a unit into a pane (insertion line shows the slot);
drag a unit out of a pane to float it again:

```
Dragging "GPU" into a row — the insertion line shows where it lands:

   ┌ row · gap 8 ──────────────────────────┐
   │  ┌─CPU─┐     ┃     ┌─RAM─┐             │     ┃ = insertion line
   │  └─────┘     ┃     └─────┘             │     drop → row reflows to
   └──────────────┃────────────────────────┘     CPU · GPU · RAM
                  ┗━ lands between CPU and RAM
        ┌─GPU─┐
        └drag─┘  ← the unit being dragged

Drag a unit OUT of a pane → it leaves the flow and floats (free move again).
```

**Native right-click menu** (Phase 5d) — popped by the Rust cursor watcher, so it works while
the overlay is click-through (passive):

```
right-click a unit / the canvas
   ┌────────────────────────────┐
   │  Edit layout               │
   │ ─────────────────────────  │
   │  Float / Unfloat           │
   │  Wrap in           ▸  Row  │
   │  Align             ▸  Col  │
   │  Send to layer     ▸  Grid │
   │ ─────────────────────────  │
   │  Group selection           │   ← Phase 6: make a widget
   │  Remove                    │
   │  Settings…                 │
   └────────────────────────────┘
```

**Studio window** (Phase 5s) — a normal app window (chrome, taskbar, alt-tab): the design home.
Selecting on the overlay or in the outline drives the same selection here:

```
WidgetSack · Studio                                              [ – □ × ]
┌ Tabs ──────────────────────────────────────────────────────────────┐
│ [ Layout ]   Widgets    Sensors    Settings                         │
├──────────────────┬──────────────────────────────────────────────────┤
│ Outline          │ Inspector · row (selected)                       │
│ ▾ Monitor 1      │   kind  [ row ▾ ]    cols [ – ]                   │
│   ▾ root (col)   │   gap   [ 8 ]   pad  [ 0 ]                        │
│     ▾ row    ◀── │   align    [ center ▾ ]                          │
│       · CPU      │   justify  [ start  ▾ ]                          │
│       · RAM      │ ─────────────────────────────────────────────────│
│       · GPU      │ Add ▸ gauge bar spark text   ·   + Row Col Grid   │
│     ▸ grid 8     │ Insert widget ▸ core-graph  net-panel  clock      │
│ ▸ Monitor 2      │                                                  │
└──────────────────┴──────────────────────────────────────────────────┘
```

**Widget designer** (Phase 6) — a studio tab: a scoped canvas over one def's local box; same
arrange/inspector tooling, edits propagate to every instance:

```
Widget designer · editing def "core-graph"           [ ‹ back to monitor ]
size [ 40 × 26 ]   params:  core = cpu.core.{i}
............................................................................
  ┌ col · gap 2 ───────────────────────┐
  │  CPU  78%   ████████░░              │     labels + meters laid out in
  │  ┌ sparkline ────────────────────┐ │     the def's OWN local coords
  │  │ ▂▃▅▇▅▃▂▁▂▃▅                    │ │
  │  └─────────────────────────────────┘ │
  └──────────────────────────────────────┘
  Add ▸ gauge  bar  sparkline  text        [ Save as widget ]
```

**Reuse** (Phase 6c) — one def, many instances, each rebinding a param:

```
Library (widgets.lib.json)             Monitor · grid cols=8
┌──────────────────────┐               ┌──┬──┬──┬──┬──┬──┬──┬──┐
│ def "core-graph"     │   instance    │0 │1 │2 │3 │4 │5 │6 │7 │
│  params: core        │ ────────────▶ ├──┼──┼──┼──┼──┼──┼──┼──┤
│  size 40×26          │     × 32      │8 │9 │10│11│..│  │  │  │
└──────────────────────┘               └──┴──┴──┴──┴──┴──┴──┴──┘
            one definition  →  many instances, each binds core = N
```

## Phase 7 — Plugin styling / theming (separate CSS, like NowPlaying)

Make styling a **separate, pluggable layer** — themes/skins live outside the components (the
NowPlaying `ThemeInjector` model, generalized to the whole platform), so the look is swappable
and shareable without touching widget code. The `css?` fields on `WidgetInstance`/`Group`
already round-trip in `widgets.json`; this phase gives them (and a theme layer) real teeth.

> **✅ Implemented (gates green).** 7a meters token-driven (`var(--np-*, fallback)`, visual
> parity) + `np-*`/`data-part`/`data-w`/`data-def`/`data-group` hooks + `core/tokens.ts`. 7b
> `core/style.ts` `scopeCss`/`assembleStyles` (tested) + `<StyleLayer>` injecting theme→def→
> instance css. 7c Rust `list_themes`/`load_theme`/`save_theme` + watch + seeded `amber`/`mono`
> examples; studio theme picker + live-reload; selection persisted in the layout. 7d inspector
> CSS editors (instance / group / def) + a global token panel (persisted under `tokens`).
> 160 client tests + 6 Rust tests; `npm` + `cargo` gates all green.

### The styling stack — four cascading layers

```
1. Tokens        CSS custom properties the meters read (--np-accent, --np-fg, --np-font, …)
   ▲ set by
2. Theme         a pluggable CSS bundle that sets tokens (+ optionally targets stable hooks).
   │             A SEPARATE file: themes/<name>.css — selectable globally / per monitor.
3. Def CSS       WidgetDef.css — restyles every instance of a composite widget (scoped to it).
4. Instance CSS  WidgetInstance.css — a one-off per-widget override (scoped to it).
                 cascade: theme/tokens (global) → def → instance (most specific wins)
```

### 7a — token-drive the meters (default look unchanged)
Meters keep colours/fonts in their own component CSS, so a theme's external CSS can't easily
override them. Fix by reading **tokens with fallbacks** — `fill: var(--np-fg, #fff)`,
`stroke: var(--np-accent, rgb(119,196,211))`, `font-family: var(--np-font-display, 'Bahnschrift', 'Arial Narrow', sans-serif)`, `--np-track`, `--np-label`, … Custom properties
**inherit through the CSS cascade**, so just setting tokens on a parent restyles every meter —
no unscoping needed, default look preserved (the fallbacks ARE today's palette). Starter
vocabulary in `core/tokens.ts` (framework-agnostic data): `--np-accent / -fg / -muted / -label /
-track / -bg`, `--np-font / -display`, `--np-size-value / -label`, `--np-radius / -gap`.

### 7b — stable hooks + scoped css injection
- Each meter exposes a **stable global hook** for structural restyles beyond tokens: a root
  class `np-gauge` / `np-bar` / `np-text` + `data-part="value|label|track|fill"` (plain,
  non-hashed class names so external CSS can match). The `WidgetHost` wrapper carries `data-w="<id>"`,
  `data-type="gauge"`, `data-sensor="cpu.total"` so any layer can match by id / type / sensor.
- A `<StyleLayer>` (generalized `ThemeInjector`) injects, in cascade order: the global **theme**
  CSS verbatim, then **def** and **instance** CSS each **auto-scoped** to their widget via native
  CSS nesting — `[data-w="<id>"] { <user css> }` (WebView2 supports nesting), so a one-off can't
  leak. Pure `core/style.ts` `scopeCss(css, selector)` does the wrap (tested). `@`-rules
  (keyframes/font-face) belong in the global theme, not scoped css — documented.

### 7c — themes as plugins (separate files)
- A theme is a **file**: `themes/<name>.css` in the app config dir, with an optional manifest
  comment (`/* @theme name; author */`). Rust `list_themes()` / `load_theme(name)` + a `notify`
  watch → `theme_changed`, mirroring the layout commands — drop in / live-edit, Rainmeter-style.
- Selection: a `theme` field in the layout (global default) + optional per-monitor override; the
  studio gets a **theme picker**. The bundled default theme reproduces today's look.

### 7d — authoring affordances
- Inspector CSS editor per instance + per def (the `css` fields already persist); a small
  **tokens panel** to set the common ones (accent / fg / font / track) without writing raw CSS.

### Framework portability
`core/tokens.ts` (token vocab + default theme as data) and `core/style.ts` (`scopeCss`) are pure
and framework-agnostic; only `<StyleLayer>` (injection) is React. Consistent with §5's boundary.

### Decisions locked (2026-06-02)
1. **Scoping = native CSS-nesting wrapper** `[data-w="<id>"] { <user css> }` for def/instance css
   (global theme is verbatim). Leans on WebView2's CSS nesting; `@keyframes`/`@font-face` live in
   the theme, not scoped blocks. (Shadow DOM rejected — too heavy for the overlay.)
2. **Themes = separate `themes/*.css` files** in the app config dir (`list_themes`/`load_theme` +
   `notify` watch); the layout stores only the *selection*. Shareable, live-editable, Rainmeter-style.
3. **Build the full stack 7a → 7d in order** (token-drive meters → stable hooks + scoped css
   injection → theme files + picker → inspector css/token editors). Starter token set as listed.

## Phase 8 — Plugin architecture / standard widget API (e.g. Home Assistant)

### What exists today (the implicit API)
A widget type is wired in **three places**, by convention, at build time: `widgets/registry.ts`
(`type → component`), `core/layout.ts` `createWidget` (per-type default sensor/rect/config), and
`WIDGET_TYPES` (palette). `WidgetHost` looks up the component, subscribes the bound sensor, and
passes `value`/`history`/`...config`. Sensors arrive from the Rust `telemetry` event → the hub —
but the **hub is source-agnostic** (`hub.ingestBatch` from anywhere), so new data sources slot in
cleanly. No formal descriptor, no runtime loading (a deliberate "fixed registry" call). Phase 8
formalizes this into a real plugin contract.

### The three contracts a plugin needs

**1. `WidgetDescriptor` (the standard widget API)** — collapse the three places into one object:
```ts
type WidgetDescriptor = {
  type: string;                 // 'gauge' | 'ha.light' | …
  component: MeterComponent;    // presentational: props value?/history?/...config
  binds?: 'scalar' | 'series' | 'text' | 'json' | 'none';  // sensor kind it reads
  label?: string;               // palette name
  defaultSize?: { w: number; h: number };
  defaultConfig?: Record<string, unknown>;
  configFields?: ConfigField[]; // schema-driven inspector (label/key/type/options)
  interactive?: boolean;        // catches clicks (per-widget click-through)
};
```
`registerWidget(descriptor)` replaces the registry; `createWidget` reads `default*`; the palette
+ inspector read `label`/`configFields`. The 6 built-in meters become descriptors. "Add a widget"
becomes one object, not three edits.

**2. `SensorSource` (data plugins)** — formalize the hub feed:
```ts
type SensorSource = {
  id: string;                                     // 'system' | 'home-assistant'
  start(hub: TelemetryHub): Promise<() => void>;  // connect, ingest samples, return unsub
  catalog?(): SensorMeta[];                       // entity ids/units for the inspector dropdown
};
```
The Rust-telemetry feed becomes the built-in `system` source; a plugin adds more. The hub is the
shared sink — meters don't change.

**3. `Plugin`** — bundles the above + settings (and may ship themes from Phase 7):
```ts
type Plugin = {
  id: string; name: string;
  widgets?: WidgetDescriptor[];
  sources?: SensorSource[];
  settings?: SettingsSchema;    // e.g. HA url + token; persisted in the config dir
};
registerPlugin(plugin);         // adds widgets, starts sources, exposes settings
```
Core widgets/sources become a built-in `core` plugin registered the same way.

### Packaging — build-time first, runtime later
- **v1 (build-time):** a plugin is a module under `client/src/lib/plugins/<id>/` exporting a
  `Plugin`; a manifest registers them. Adding one = code + rebuild. React components compile in;
  zero new security surface.
- **Future (runtime drop-in):** load a plugin bundle from the config dir at runtime. Compiled
  React components don't load post-compile, so this needs **web-component widgets** (runtime-
  loadable, aligned with the framework-portability note) or a dynamic-import path + sandboxing/CSP.
  Bigger; deferred.

### Home Assistant plugin (the concrete target)
- **Source (Rust proxy — locked):** a Rust HA client (e.g. `tokio-tungstenite`) holds the WebSocket
  to `ws://<host>/api/websocket` + the long-lived token **server-side**, subscribes to
  `state_changed`, and forwards `ha.<entity_id>` samples through the existing `telemetry` event
  (`scalar` for numeric, `json` for full state) — one pipe, token never in the webview.
- **Control:** `ha.light`/`ha.climate` etc. call back via a Tauri command `ha_call_service(domain,
  service, data)` → Rust → HA. Control widgets are `interactive` → reuse the per-widget
  click-through (`clickthrough.rs`).
- **Widgets:** `ha.sensor` (text/gauge over an entity), `ha.light` (toggle + brightness),
  `ha.climate` (setpoint), …
- **Settings + catalog:** HA URL + token persisted server-side (a Rust-read `plugins/ha.json` in
  the config dir, not in `widgets.json`); a `list_ha_entities` command feeds the sensor dropdown.
  Token stays out of the layout file and the webview.

### Phasing
- 8a — `WidgetMeta` + `registerWidget`; migrate the 6 built-ins; schema-driven inspector
  config (raw JSON stays as the escape hatch). Pure-ish, fully testable. ✅ done
- 8b — `SensorSource` + `registerPlugin`; wrap the system feed as the built-in source. ✅ done
- 8c — the Home Assistant plugin (source + widgets + settings) — the first real plugin. ✅ done
- 8d — (future) runtime plugin loading via web components.

### As-built (Phase 8 ✅ — cargo + client gates green)
The standard widget API split honours the core boundary (AGENTS.md §5): the **pure** half is
`core/widget.ts` (`WidgetMeta`/`ConfigField`/`SensorKind`, `registerMeta`/`getMeta`/`listMetas`,
`createWidget`, `BUILTIN_METAS`); the **component-bearing** half is `widgets/registry.ts`
(`registerWidget(meta, component)` mirrors the meta into the pure registry + stores the React
component). `WidgetDescriptor` is just `WidgetMeta` + `component` — no second registry. The 6
built-ins reproduce the old `createWidget` switch exactly (parity pinned by `widget.test.ts`).

- **8a** — `core/widget.ts` + `widget.test.ts`; `Inspector` renders one typed input per
  `configFields` entry above the raw-JSON `<textarea>` (kept as the escape hatch). The JSON box
  now re-syncs whenever the config object changes by reference, so a typed-field edit can't be
  silently reverted by a later JSON commit.
- **8b** — `core/plugin.ts` (`SensorSource` + `registerSource`/`startAllSources`/
  `sourceCatalogIds`) + `plugin.test.ts`; `telemetry/source.ts` registers the built-in **`system`**
  source; `widgets/plugin.ts` (`Plugin` + `registerPlugin`). Canvas mounts via `startAllSources`
  and merges `sourceCatalogIds()` into the inspector's sensor dropdown.
- **8c** — `widgetsack/src/ha.rs`: a reconnecting HA WebSocket proxy. Token + socket stay
  server-side (`plugins/ha.json`); `state_changed` is forwarded over the **existing** `telemetry`
  event as `ha.<entity_id>` (`Json` always; `ha.<entity_id>.state` `Scalar` when numeric) — the
  unchanged `system` listener ingests it. Connection state rides the same event as `ha.status`
  (Text). Commands: `ha_connect`/`ha_disconnect` (single-owner task, double-spawn-guarded),
  `list_ha_entities` (REST `/api/states`, dropdown catalog), `ha_call_service` (REST control,
  `/`+`.` path-injection guarded), `save_ha_config`/`ha_config_status` (status never returns the
  token). Reconnect backoff (1s→30s + jitter) resets only after a ≥30s-stable session. Pure seams
  (`ws_url_from`, `state_to_samples`, `entity_from_state`) unit-tested. Frontend plugin:
  `widgets/plugins/home-assistant.ts` registers `haSource` + `ha.sensor`/`ha.light`/`ha.climate`
  (all `binds: 'json'`); `ha.light` is `interactive` and dispatches a `control` event that
  `WidgetHost` bubbles to Canvas, which invokes `ha_call_service` (the meter stays Tauri-free,
  §6). `WidgetHost` now passes the value-shape its `binds` dictates (scalar/series byte-identical;
  json/text get the raw payload).
- **TLS (HA):** `wss://`/`https://` are supported via **`native-tls` = Windows SChannel** — no
  OpenSSL, no `aws-lc-rs`/`ring`, so no NASM/cmake build tooling. Valid certs (e.g. Nabu Casa)
  work transparently through `connect_async`/`reqwest`. **Self-signed LAN certs** require an
  explicit, default-off `insecure: true` in `plugins/ha.json`, which wires
  `danger_accept_invalid_certs` into BOTH the WS connector (`connect_async_tls_with_config`) and
  the REST client. `#[serde(default)]` keeps existing config files strict. `ha.climate` is
  read-only (setpoint control deferred). Runtime HA behaviour is unverified here (no live HA
  instance); the pure seams + frontend component tests are green, and `cargo build/test/clippy`
  pass on Windows.

### Decisions locked (2026-06-02)
1. **Packaging = build-time plugin modules first** (`lib/plugins/<id>/`, rebuild to add). Runtime
   drop-in via web components is a later, separate step (8d).
2. **HA = Rust proxy source** (token server-side, forwarded over `telemetry`; control via a Tauri
   `ha_call_service` command). The frontend `SensorSource` API still exists for pure-JS plugins;
   HA specifically lives in Rust for security. (Frontend WebSocket rejected.)
3. **Config = schema-driven** (`configFields` → typed inspector inputs) **with the raw-JSON box as
   the escape hatch** for anything unlisted.

## Resolved decisions (2026-06-01)

1. **Z-order/input (3c, refined):** **whole-window click-through** (fully passive normally,
   interactive in edit mode) on an **always-on-top** overlay. Per-widget `layer: top|desktop`
   field added now; **always-on-top layer first**, WorkerW **desktop layer later** (Phase 4).
   Per-widget click-through deferred. Edit toggled by **global hotkey + tray**. Overlays
   **per monitor, configurable** via the layout map.
2. **Monitors:** multi-monitor overlays from day one; **no cross-monitor widgets** to start.
3. **Fonts:** Bahnschrift default; `fontFamily` override resolves **system fonts** (any installed
   font, incl. the day-pictograph font) for customization.
4. **React:** components reimplemented (port done); **`core/` shared unchanged** (no web components now).
5. **Sensor interval:** **configurable per sensor, 1 Hz default.**
6. **Name:** **rename `np` → `widgetsack`** (Phase R).

## Environment notes

- React 19 + TypeScript, Vite 5, Vitest 2 (migrated from Svelte 3.54 / SvelteKit 1.5 +
  adapter-static), Tauri 2.11, Rust edition 2024.
- Capabilities are scoped to window label `main`; multi-window + fs access will need
  additions under `widgetsack/capabilities/`.
- Dynamic arbitrary-widget-code loading is **not** required — a fixed registry of
  built-in meter types configured by data covers 100% of the listed skins.
</content>
