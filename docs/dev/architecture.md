# Architecture

Widgetsack is a Windows desktop overlay with a Rust/Tauri backend and a React client.
Read [AGENTS.md](../../AGENTS.md) for repository conventions and testing requirements.

## Windows and roles

[App.tsx](../../client/src/App.tsx) selects the role by window label.
Both roles render [Canvas.tsx](../../client/src/lib/widgets/Canvas.tsx).

- Overlay windows display the current layout on each monitor, including live Studio previews. Empty areas let clicks reach the desktop.
- Studio edits layouts, widget definitions, themes, connections, and shared bundles.

The primary overlay uses the `main` label. Studio uses `studio`.
[overlay.ts](../../client/src/lib/overlay.ts) reconciles secondary monitor windows.
Widget interaction rectangles let controls receive input without blocking the rest of the desktop.

## Dependency boundaries

Keep domain logic in `client/src/lib/core/`.
It accepts data and returns data without React, Tauri, DOM, or filesystem dependencies.
Containers own subscriptions and pass readings to presentational widgets.
Bridge adapters own commands, events, and external APIs.

The Rust backend follows the same separation.
External Windows and library types stay in adapters.
Pure reducers, parsers, and calculation functions use application types.
Update both Rust and TypeScript when a serialized bridge contract changes.

## Layouts

The frontend owns layout, widget, theme-token, and sack schemas.
The backend validates filenames, merges touched document fields, and performs file operations.
It does not solve or edit layout trees.

The editor reducer owns selection, modes, undo, redo, and the saved baseline.
The solver converts layout trees into rectangles and renderable widgets.
Library groups reference reusable definitions and can have instance parameters or styles.
See [Layout format](layout-format.md).

Studio writes debounced layout previews to `widgets.json` in the app configuration directory.
Preview, Save, and revert writes share one ordered queue.
Save records the new baseline. Cancel restores the prior baseline.
Closing Studio flushes a pending preview write.
A file watcher emits `layout_changed` so overlays can reload.
Themes use the same write, watch, and reload pattern.
File replacement must preserve a valid prior file when a write fails.

## Telemetry

Backend sources emit batches of `SensorSample` objects through the `telemetry` event.
Each sample contains `sensor`, `ts_ms`, and `value`.
The frontend TelemetryHub stores current readings and bounded history.
Widget subscriptions select the sensor IDs they need.

System sources include CPU, memory, disks, network, battery, and uptime.
NVIDIA GPU readings use NVML when available.
Unsupported readings remain unavailable.

Cheap baseline sources keep their normal cadence.
Expensive sources run only when demanded.
Studio discovers IDs through `get_system_sensor_catalog` without starting expensive reads.
Visible sensor rows subscribe to readings. Hidden Studio releases its demand.
Recycle Bin reads occur on new demand and at most every ten seconds while requested.

Integration workers use serialized ensure, restart, and stop transitions.
Window cleanup releases local subscriptions without stopping shared backend workers.
Settings operations prevent stale loads or tests from replacing newer edits.

## Media and audio

Windows GSMTC events pass through wrappers into the session reducer.
Bridge events update the frontend media store.
The now-playing widget reads the selected session from that store.
Album art uses the backend URI handler instead of embedding image bytes in JSON events.

Audio spectrum frames use a dedicated Tauri Channel.
Native audio commands control devices, application sessions, and microphone state.
Keep hardware operations at the adapter boundary.

## Expressions

Formulas and text templates run in QuickJS-WASM.
The formula sandbox has a 50 ms execution limit and a 16 MiB memory limit.
It has no filesystem, network, DOM, or application-control bindings.
Sensor access and helper functions are explicitly provided.

Package sources use a separate sandbox and host-controlled fetch process.
See [Plugin packages](plugin-packages.md) for its contract and limits.

## Agents

The assistant discovers installed Pi, Codex, and Claude executables.
It does not install an agent runtime.
CLI discovery and reply decoding are separate from process ownership and cancellation.
Prompts use stdin. Process arguments are not passed through a shell.
Windows job objects terminate child processes on cancellation or timeout.

Studio edits use validated tool operations and revision checks.
An edit batch creates one undo step.
External agents use the same editor through [MCP](mcp.md).
Rendered verification and screenshots complement schema validation.

## Verification

Test reducers, geometry, parsers, and scheduling at pure seams.
Use component tests for rendered behavior and adapter contracts.
Use browser tests for layout, focus, dragging, and persistence journeys.
Reserve hardware smoke checks for Windows behavior that deterministic tests cannot prove.
See [Development](development.md) for the required gates.
