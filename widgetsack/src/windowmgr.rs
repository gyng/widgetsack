//! Foreign-window manager: enumerate other applications' top-level windows and snap them into
//! "landing zones" (FancyZones-style). This is the Win32 anti-corruption edge for the feature —
//! all `unsafe` and `windows::Win32::*` calls live here, mirroring `listener.rs` (gsmtc) and
//! `sensors.rs` (sysinfo/nvml): a thin I/O outer layer wrapping pure, unit-tested seams.
//!
//! What it can and cannot do (verified): a normal-integrity process CAN move/resize another
//! normal-integrity window via `SetWindowPos`, but CANNOT touch a window owned by a HIGHER-integrity
//! (elevated/admin) process — UIPI blocks it and `SetWindowPos` returns `ERROR_ACCESS_DENIED`. We
//! surface that as an `Err` and never panic. Placement compensates for the invisible DWM resize
//! border via `DWMWA_EXTENDED_FRAME_BOUNDS` and restores a maximized/minimized window first.
//!
//! Scope here is MVP1 (enumerate + snap a specific window to a rect). Live drag-to-zone (a
//! `SetWinEventHook` message-pump thread) and the studio zone editor build on these seams later.

use serde::Serialize;

use crate::clickthrough::ScreenRect;

/// A foreign top-level window. Mirrors the TS `WindowDescriptor` (client/src/lib/core/windowMatch.ts)
/// 1:1 across the bridge (AGENTS.md §5). `hwnd` is the raw handle as an i64 — opaque to the frontend,
/// passed back only to act on the window. It crosses to JS as a number (exact below 2^53, which all
/// real Win64 handle-table values are).
#[derive(Clone, Debug, Serialize)]
// REQUIRED for the TS bridge: the camelCase rename makes `class_name` serialize as `className`, which
// the mirror type `WindowDescriptor` in client/src/lib/core/windowMatch.ts expects. Dropping it would
// silently send `class_name`, leaving `win.className` undefined and breaking appOpen class matching.
#[serde(rename_all = "camelCase")]
pub struct WindowDescriptor {
    pub hwnd: i64,
    pub exe: String,
    pub class_name: String,
    pub title: String,
    pub rect: ScreenRect,
}

// ---- pure seams (cross-platform, unit-tested; the Win32 layer below feeds them real data) ----

/// The `EnumWindows` keep/skip predicate: a window is "arrangeable" only if it is a real, visible,
/// non-tool, non-cloaked, titled, top-level (unowned, non-child) window that we don't own. Pure so
/// it is table-tested without a desktop. (`cloaked` covers DWM-cloaked windows — other virtual
/// desktops / suspended UWP; `is_own` excludes widgetsack's own overlays/studio by PID; `owned`
/// excludes splash/installer/dialog popups that have an owner window or the WS_CHILD style.)
#[allow(clippy::too_many_arguments)]
pub fn is_arrangeable(
    visible: bool,
    toolwindow: bool,
    cloaked: bool,
    has_title: bool,
    width: i32,
    height: i32,
    is_own: bool,
    owned: bool,
) -> bool {
    visible && !toolwindow && !cloaked && has_title && width > 0 && height > 0 && !is_own && !owned
}

/// The largest plausible DWM invisible border (px). A real border is ~7-8px (≤ ~16 even at 200%
/// DPI); a larger computed delta means an inconsistent window-rect/frame-bounds read (e.g. a window
/// measured mid open/restore animation) — we treat it as bogus and skip compensation for that edge
/// rather than mis-snapping the window by ~100px (caught by the snap_moves_a_real_window smoke test).
const MAX_DWM_BORDER: f64 = 24.0;

/// The invisible DWM-border margins (left, right, bottom) — `window` (GetWindowRect) minus `frame`
/// (DWMWA_EXTENDED_FRAME_BOUNDS). Top is intentionally never compensated (it has ~1px and no
/// invisible border; subtracting a top margin would misplace the window). Out-of-range deltas
/// (negative — classic theme / DWM off / no frame; or implausibly large — a bad read) clamp to 0.
/// Twin of `frameMargins` in core/snapMath.ts.
fn frame_margins(window: ScreenRect, frame: Option<ScreenRect>) -> (f64, f64, f64) {
    let clamp = |m: f64| {
        if (0.0..=MAX_DWM_BORDER).contains(&m) {
            m
        } else {
            0.0
        }
    };
    match frame {
        None => (0.0, 0.0, 0.0),
        Some(f) => {
            let left = clamp(f.x - window.x);
            let right = clamp((window.x + window.w) - (f.x + f.w));
            let bottom = clamp((window.y + window.h) - (f.y + f.h));
            (left, right, bottom)
        }
    }
}

/// The rect to feed `SetWindowPos` so the window's VISIBLE frame fills `zone`, expanding the target
/// by the invisible-border margins (L/R/B only). Twin of `computeSnapRect` in core/snapMath.ts so
/// both sides of the bridge agree. Physical px.
pub fn adjust_for_frame_bounds(
    zone: ScreenRect,
    window: ScreenRect,
    frame: Option<ScreenRect>,
) -> ScreenRect {
    let (left, right, bottom) = frame_margins(window, frame);
    ScreenRect {
        x: (zone.x - left).round(),
        y: zone.y.round(), // top margin is always 0 — never shift the top up
        w: (zone.w + left + right).round(),
        h: (zone.h + bottom).round(),
    }
}

/// Lowercased final path segment of an exe path; tolerates `\` and `/` and a bare basename.
/// Twin of `exeBasename` in core/windowMatch.ts.
pub fn exe_basename(path: &str) -> String {
    let cut = path.rfind(['\\', '/']).map(|i| i + 1).unwrap_or(0);
    path[cut..].to_ascii_lowercase()
}

/// New top-left for a window being dragged OUT of a zone: as it resizes from its snapped size
/// (`snapped`) back to `restore_w`×`restore_h`, keep the cursor at the same PROPORTIONAL point on the
/// window so the grabbed title bar stays under the cursor. Pure seam (the restore reposition math).
pub fn restore_top_left(
    snapped: ScreenRect,
    cursor: (f64, f64),
    restore_w: f64,
    restore_h: f64,
) -> (f64, f64) {
    let rel_x = (cursor.0 - snapped.x) / snapped.w.max(1.0);
    let rel_y = (cursor.1 - snapped.y) / snapped.h.max(1.0);
    (cursor.0 - rel_x * restore_w, cursor.1 - rel_y * restore_h)
}

// ---- pure drag-detection state machine (the custom-titlebar fallback) ----

/// Which kind of foreign-window drag is in flight. `Real` = the standard OS modal move/size loop
/// (EVENT_SYSTEM_MOVESIZESTART…END). Custom-titlebar apps — Electron (`-webkit-app-region: drag`),
/// WinUI/UWP (the Windows 11 Notepad), Java — never enter that loop, so we INFER a `Synthetic` drag for
/// them from the window MOVING while the left mouse button is held (EVENT_OBJECT_LOCATIONCHANGE + button
/// state). The two paths converge on the same `win_drag_start`/`win_drag_end` the overlay already rides.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum DragKind {
    #[default]
    None,
    Real,
    Synthetic,
}

/// What the Win32 edge should do after feeding the detector one input.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DragAction {
    None,
    Start(i64),
    End(i64),
}

/// Pure state machine turning the raw Win32 drag signals into clean start/end actions, unifying the
/// standard move/size loop (classic windows) with the move-while-pressed fallback (custom titlebars).
/// Driven only from the watcher's single message-pump thread, so it needs no locking; unit-tested
/// without a window. The Win32 edge supplies `lmb_down` (GetAsyncKeyState) and `arrangeable`
/// (is_arrangeable) — keeping every OS call out of the logic.
#[derive(Clone, Copy, Debug, Default)]
pub struct DragDetector {
    kind: DragKind,
    hwnd: i64,
}

impl DragDetector {
    /// The standard modal move/size loop began (a classic titlebar grab): always a real drag start.
    pub fn move_size_start(&mut self, hwnd: i64) -> DragAction {
        self.kind = DragKind::Real;
        self.hwnd = hwnd;
        DragAction::Start(hwnd)
    }

    /// The standard modal move/size loop ended — ends a real drag (a synthetic one ends via `tick`).
    pub fn move_size_end(&mut self, hwnd: i64) -> DragAction {
        if self.kind == DragKind::Real {
            self.kind = DragKind::None;
            DragAction::End(hwnd)
        } else {
            DragAction::None
        }
    }

    /// A top-level window moved. With NOTHING dragging yet, the left button held, and the window
    /// arrangeable, infer a synthetic drag start (a custom-titlebar app being dragged). A move during an
    /// existing drag — including the real loop's own LOCATIONCHANGE noise — is ignored (no double start).
    pub fn window_moved(&mut self, hwnd: i64, lmb_down: bool, arrangeable: bool) -> DragAction {
        if self.kind == DragKind::None && lmb_down && arrangeable {
            self.kind = DragKind::Synthetic;
            self.hwnd = hwnd;
            DragAction::Start(hwnd)
        } else {
            DragAction::None
        }
    }

    /// Poll while a synthetic drag is in flight: when the button is released, end it (custom drags have
    /// no MOVESIZEEND to ride). No-op for a real / no drag.
    pub fn tick(&mut self, lmb_down: bool) -> DragAction {
        if self.kind == DragKind::Synthetic && !lmb_down {
            let hwnd = self.hwnd;
            self.kind = DragKind::None;
            DragAction::End(hwnd)
        } else {
            DragAction::None
        }
    }

    /// Nothing is being dragged (the edge skips the per-LOCATIONCHANGE arrangeable probe unless idle).
    pub fn is_idle(&self) -> bool {
        self.kind == DragKind::None
    }

    /// A synthetic drag is in flight (the edge runs its release-polling timer only then).
    pub fn in_synthetic_drag(&self) -> bool {
        self.kind == DragKind::Synthetic
    }
}

// ---- Tauri command surface (cross-platform; delegates to the cfg-split helpers below) ----

/// Foreign-window manipulation is powerful and has NO Tauri capability/sandbox gate (the moves are
/// raw Win32), so the access control is restricting these commands to our own windows — the same
/// label-guard shape `ha.rs` / `mqtt.rs` use. Enumeration (`list_windows`) and actuation
/// (`snap_window`) are both reachable from the studio AND the overlays: the overlay runs the live
/// drag-to-zone snap and the conditional-container "is app X open" poll.
///
/// The studio OR an overlay (main / overlay-N) — the windows allowed to manage foreign windows.
fn require_app_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label();
    if label == "studio" || label == "main" || label.starts_with("overlay-") {
        Ok(())
    } else {
        Err("window management is not allowed from this window".to_string())
    }
}

/// List the arrangeable top-level windows. Used by the studio's window picker AND by the overlay's
/// conditional-container poller ("is app X open"), so it's allowed from any app window (not just the
/// studio) — same trust boundary as `snap_window`. It only enumerates window metadata we already
/// surface in the studio; no new capability is exposed to web content.
#[tauri::command]
pub fn list_windows(window: tauri::WebviewWindow) -> Result<Vec<WindowDescriptor>, String> {
    require_app_window(&window)?;
    list_arrangeable()
}

/// Snap the window `hwnd` so its visible frame fills `rect` (physical px). Restores a maximized /
/// minimized window first and compensates the DWM border. Returns an error (rather than panicking)
/// when the target is an elevated window UIPI won't let us touch. Studio-only.
#[tauri::command]
pub fn snap_window(
    window: tauri::WebviewWindow,
    hwnd: i64,
    rect: ScreenRect,
) -> Result<(), String> {
    require_app_window(&window)?;
    snap(hwnd, rect)
}

// ---- live drag detection (MVP2): a SetWinEventHook message-pump thread + a pointer probe ----

/// Pointer state for the drag-to-zone highlight: cursor in PHYSICAL px + whether Shift is held (the
/// modifier that ARMS snapping — snapping only engages while Shift is down). The overlay polls this
/// between `win_drag_start` and `win_drag_end`.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PointerState {
    pub x: f64,
    pub y: f64,
    pub shift: bool,
}

/// Cursor position (physical px) + Shift state. Not studio-gated — it is read-only and the overlay
/// (not the studio) polls it during a drag.
#[tauri::command]
pub fn pointer_probe(app: tauri::AppHandle) -> PointerState {
    let (x, y) = app
        .cursor_position()
        .map(|p| (p.x, p.y))
        .unwrap_or((0.0, 0.0));
    PointerState {
        x,
        y,
        shift: shift_held(),
    }
}

/// Payload for `win_drag_start` / `win_drag_end`.
#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DragEvent {
    hwnd: i64,
}

#[cfg(target_os = "windows")]
fn shift_held() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_SHIFT};
    (unsafe { GetAsyncKeyState(VK_SHIFT.0 as i32) } as u16 & 0x8000) != 0
}

#[cfg(not(target_os = "windows"))]
fn shift_held() -> bool {
    false
}

/// Spawn the live-drag watcher: a dedicated thread that installs `SetWinEventHook`s and runs a Windows
/// MESSAGE PUMP (required for WINEVENT_OUTOFCONTEXT delivery — the clickthrough watcher is a sleep loop
/// with no pump, so this MUST be its own thread). TWO hooks feed one `DragDetector`: the standard modal
/// move/size loop (classic titlebars), AND `EVENT_OBJECT_LOCATIONCHANGE` — the fallback for
/// custom-titlebar apps (Electron / WinUI-UWP like the Windows 11 Notepad / Java) that never enter that
/// loop, whose drag we infer from the window moving while the left button is held (a ~30 Hz WM_TIMER
/// catches the release). Emits `win_drag_start` / `win_drag_end` (with the dragged HWND); the overlay
/// polls `pointer_probe` between them to highlight the hovered zone and snap on release. No-op off Windows.
#[cfg(target_os = "windows")]
pub fn run_drag_watcher(app: tauri::AppHandle) {
    if DRAG_APP.set(app).is_err() {
        return; // already running
    }
    spawn_drag_pump();
}

/// Spawn the hook-install + message-pump thread. Split out of `run_drag_watcher` so the live pipeline
/// can be smoke-tested via `DRAG_SINK` without a Tauri app handle (see `synthetic_drag_*` below).
#[cfg(target_os = "windows")]
fn spawn_drag_pump() {
    std::thread::spawn(|| unsafe {
        use windows::Win32::UI::Accessibility::SetWinEventHook;
        use windows::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, EVENT_OBJECT_LOCATIONCHANGE, EVENT_SYSTEM_MOVESIZEEND,
            EVENT_SYSTEM_MOVESIZESTART, GetMessageW, MSG, WINEVENT_OUTOFCONTEXT, WM_TIMER,
        };
        // Hook 1: the standard modal move/size loop (classic titlebars) → real drags.
        let move_hook = SetWinEventHook(
            EVENT_SYSTEM_MOVESIZESTART,
            EVENT_SYSTEM_MOVESIZEEND,
            None,
            Some(win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        // Hook 2: window location changes → the fallback for custom-titlebar apps. Filtered to
        // OBJID_WINDOW + gated on the left button inside the proc so this (frequent) event stays cheap.
        let loc_hook = SetWinEventHook(
            EVENT_OBJECT_LOCATIONCHANGE,
            EVENT_OBJECT_LOCATIONCHANGE,
            None,
            Some(win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        if move_hook.is_invalid() && loc_hook.is_invalid() {
            return; // nothing to listen on
        }
        // OUTOFCONTEXT callbacks (and our synthetic-drag WM_TIMER) are delivered while this thread
        // retrieves messages.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            if msg.message == WM_TIMER {
                on_synth_tick();
            }
            let _ = DispatchMessageW(&msg);
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn run_drag_watcher(_app: tauri::AppHandle) {}

#[cfg(target_os = "windows")]
static DRAG_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

// The drag detector + its release-polling timer id live on the watcher's pump thread (the ONLY thread
// that touches them — both `win_event_proc` and the WM_TIMER handler run there), so a thread-local
// needs no locking.
#[cfg(target_os = "windows")]
thread_local! {
    static DETECTOR: std::cell::RefCell<DragDetector> = std::cell::RefCell::new(DragDetector::default());
    static SYNTH_TIMER: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Poll cadence (ms) for the button release that ends a synthetic (custom-titlebar) drag.
#[cfg(target_os = "windows")]
const SYNTH_POLL_MS: u32 = 30;

/// Is the left mouse button physically down right now? The arming signal for inferring a custom drag.
#[cfg(target_os = "windows")]
fn lbutton_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    (unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000) != 0
}

/// Is `hwnd` a window we'd snap — the same predicate `list_arrangeable` applies, for ONE window? Used
/// to qualify a LOCATIONCHANGE as a real app-window drag (not our own overlay, a tooltip, a child …).
#[cfg(target_os = "windows")]
fn arrangeable_hwnd(hwnd: windows::Win32::Foundation::HWND) -> bool {
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
    use windows::Win32::UI::WindowsAndMessaging::{
        GW_OWNER, GWL_EXSTYLE, GWL_STYLE, GetWindow, GetWindowLongW, GetWindowRect,
        GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible, WS_CHILD,
        WS_EX_TOOLWINDOW,
    };
    unsafe {
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        let mut cloaked: u32 = 0;
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut c_void,
            size_of::<u32>() as u32,
        );
        let mut rc = RECT::default();
        if GetWindowRect(hwnd, &mut rc).is_err() {
            return false;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let has_owner = !GetWindow(hwnd, GW_OWNER).unwrap_or_default().0.is_null();
        let is_child = GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_CHILD.0 != 0;
        is_arrangeable(
            IsWindowVisible(hwnd).as_bool(),
            ex_style & WS_EX_TOOLWINDOW.0 != 0,
            cloaked != 0,
            GetWindowTextLengthW(hwnd) > 0,
            rc.right - rc.left,
            rc.bottom - rc.top,
            pid == std::process::id(),
            has_owner || is_child,
        )
    }
}

// Drag signals normally fan out on the Tauri bridge; a test can install a capturing sink (set once) to
// smoke-test the live SetWinEventHook pipeline without a Tauri app handle.
#[cfg(target_os = "windows")]
#[allow(clippy::type_complexity)]
static DRAG_SINK: std::sync::OnceLock<Box<dyn Fn(DragAction) + Send + Sync>> =
    std::sync::OnceLock::new();

/// Emit the bridge event for a detector action. A `Start` first pops a previously-snapped window back to
/// its pre-snap size (so dragging it out of a zone restores it) — for BOTH real and synthetic drags.
#[cfg(target_os = "windows")]
fn apply_drag_action(action: DragAction) {
    if let DragAction::Start(id) = action {
        let hwnd = windows::Win32::Foundation::HWND(id as isize as *mut std::ffi::c_void);
        unsafe { restore_on_drag_out(hwnd) };
    }
    // A test sink intercepts the signal so the pipeline is observable without a Tauri app.
    if let Some(sink) = DRAG_SINK.get() {
        sink(action);
        return;
    }
    use tauri::Emitter;
    let Some(app) = DRAG_APP.get() else { return };
    match action {
        DragAction::Start(id) => {
            let _ = app.emit(crate::bridge::WIN_DRAG_START_EVENT, DragEvent { hwnd: id });
        }
        DragAction::End(id) => {
            let _ = app.emit(crate::bridge::WIN_DRAG_END_EVENT, DragEvent { hwnd: id });
        }
        DragAction::None => {}
    }
}

/// Start the release-polling timer while (and only while) a synthetic drag is in flight; stop it
/// otherwise. Idempotent — safe to call after every detector input.
#[cfg(target_os = "windows")]
fn sync_synth_timer() {
    use windows::Win32::UI::WindowsAndMessaging::{KillTimer, SetTimer};
    let want = DETECTOR.with(|d| d.borrow().in_synthetic_drag());
    SYNTH_TIMER.with(|t| {
        let cur = t.get();
        if want && cur == 0 {
            // Thread timer (no window) → WM_TIMER lands in our message pump.
            t.set(unsafe { SetTimer(None, 0, SYNTH_POLL_MS, None) });
        } else if !want && cur != 0 {
            let _ = unsafe { KillTimer(None, cur) };
            t.set(0);
        }
    });
}

/// WM_TIMER tick: poll the button to see if a synthetic drag has been released, then resync the timer.
#[cfg(target_os = "windows")]
fn on_synth_tick() {
    let action = DETECTOR.with(|d| d.borrow_mut().tick(lbutton_down()));
    apply_drag_action(action);
    sync_synth_timer();
}

/// hwnd → pre-snap outer size (w, h). Populated by `snap` (first snap only) and consumed by
/// `restore_on_drag_out` so dragging a snapped window out of its zone pops it back to its prior size.
#[cfg(target_os = "windows")]
static SNAPPED: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<i64, (i32, i32)>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// If `hwnd` was previously snapped by us, resize it back to its remembered pre-snap size — keeping
/// the grabbed title bar under the cursor — and forget it. Called on a drag START (real or synthetic),
/// so dragging a snapped window out of its zone restores its prior dimensions (Windows-Snap behavior).
/// No-op for a window we never snapped.
#[cfg(target_os = "windows")]
unsafe fn restore_on_drag_out(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetWindowRect, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos,
    };

    let id = hwnd.0 as isize as i64;
    let size = SNAPPED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    let Some((rw, rh)) = size else { return };
    if rw <= 0 || rh <= 0 {
        return;
    }

    let mut rc = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rc) }.is_err() {
        return;
    }
    let mut cur = POINT::default();
    if unsafe { GetCursorPos(&mut cur) }.is_err() {
        return;
    }
    let snapped = ScreenRect {
        x: rc.left as f64,
        y: rc.top as f64,
        w: (rc.right - rc.left) as f64,
        h: (rc.bottom - rc.top) as f64,
    };
    let (nx, ny) = restore_top_left(snapped, (cur.x as f64, cur.y as f64), rw as f64, rh as f64);
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            None,
            nx as i32,
            ny as i32,
            rw,
            rh,
            SWP_NOACTIVATE | SWP_NOZORDER,
        )
    };
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn win_event_proc(
    _hook: windows::Win32::UI::Accessibility::HWINEVENTHOOK,
    event: u32,
    hwnd: windows::Win32::Foundation::HWND,
    id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    use windows::Win32::UI::WindowsAndMessaging::{
        EVENT_OBJECT_LOCATIONCHANGE, EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZESTART,
        OBJID_WINDOW,
    };
    // Only the window itself (OBJID_WINDOW), not its caret/cursor/child accessible objects — the
    // LOCATIONCHANGE stream is otherwise very noisy.
    if id_object != OBJID_WINDOW.0 {
        return;
    }
    let id = hwnd.0 as isize as i64;
    let action = DETECTOR.with(|d| {
        let mut d = d.borrow_mut();
        match event {
            EVENT_SYSTEM_MOVESIZESTART => d.move_size_start(id),
            EVENT_SYSTEM_MOVESIZEEND => d.move_size_end(id),
            // Custom-titlebar fallback: a top-level arrangeable window moving while the left button is
            // held is an inferred drag. The cheap idle + button gates run BEFORE the heavier arrangeable
            // probe, so an idle desktop's ordinary window moves cost almost nothing.
            EVENT_OBJECT_LOCATIONCHANGE if d.is_idle() && lbutton_down() => {
                d.window_moved(id, true, arrangeable_hwnd(hwnd))
            }
            _ => DragAction::None,
        }
    });
    apply_drag_action(action);
    sync_synth_timer();
}

// ---- Windows implementation ----

#[cfg(target_os = "windows")]
fn list_arrangeable() -> Result<Vec<WindowDescriptor>, String> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GWL_EXSTYLE, GWL_STYLE, GetClassNameW, GetWindow, GetWindowLongW,
        GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, WS_CHILD,
        WS_EX_TOOLWINDOW,
    };
    use windows::core::BOOL;

    // Collect raw HWNDs first (do nothing heavy inside the enum callback). The body is push-only and
    // cannot panic, so no `catch_unwind` is needed across the `extern "system"` FFI boundary.
    extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // Safety: `lparam` carries a &mut Vec<HWND> for the lifetime of EnumWindows (below).
        let acc = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
        acc.push(hwnd);
        true.into()
    }

    let mut hwnds: Vec<HWND> = Vec::new();
    unsafe {
        EnumWindows(Some(collect), LPARAM(&mut hwnds as *mut _ as isize))
            .map_err(|e| format!("EnumWindows failed: {e}"))?;
    }

    let own_pid = std::process::id();
    let mut out = Vec::new();
    for hwnd in hwnds {
        unsafe {
            let visible = IsWindowVisible(hwnd).as_bool();

            let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            let toolwindow = ex_style & WS_EX_TOOLWINDOW.0 != 0;

            // On the rare failure path `cloaked` stays 0 (treated as not-cloaked → included), a safe
            // default; `cb = size_of::<u32>()` is the attribute's size.
            let mut cloaked: u32 = 0;
            let _ = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as *mut c_void,
                size_of::<u32>() as u32,
            );

            let mut title_buf = [0u16; 512];
            let n = GetWindowTextW(hwnd, &mut title_buf);
            let title = String::from_utf16_lossy(&title_buf[..n as usize]);

            let mut rc = RECT::default();
            if GetWindowRect(hwnd, &mut rc).is_err() {
                continue;
            }
            let width = rc.right - rc.left;
            let height = rc.bottom - rc.top;

            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let is_own = pid == own_pid;

            // Owned (has an owner window) or child windows are splash/installer/dialog popups, not
            // top-level app windows — skip them. GetWindow(GW_OWNER) errors → no owner (null).
            let has_owner = !GetWindow(hwnd, GW_OWNER).unwrap_or_default().0.is_null();
            let is_child = GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_CHILD.0 != 0;

            if !is_arrangeable(
                visible,
                toolwindow,
                cloaked != 0,
                !title.is_empty(),
                width,
                height,
                is_own,
                has_owner || is_child,
            ) {
                continue;
            }

            let mut class_buf = [0u16; 256];
            let cn = GetClassNameW(hwnd, &mut class_buf);
            let class_name = String::from_utf16_lossy(&class_buf[..cn as usize]);

            out.push(WindowDescriptor {
                hwnd: hwnd.0 as isize as i64,
                exe: exe_path(pid).unwrap_or_default(),
                class_name,
                title,
                rect: ScreenRect {
                    x: rc.left as f64,
                    y: rc.top as f64,
                    w: width as f64,
                    h: height as f64,
                },
            });
        }
    }
    Ok(out)
}

/// Resolve a PID to its full executable path (best-effort). `PROCESS_QUERY_LIMITED_INFORMATION` is
/// least-privilege and succeeds across the normal/elevated boundary; it is denied only for PPL /
/// protected processes — those return None and matching falls back to class/title.
#[cfg(target_os = "windows")]
fn exe_path(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::core::PWSTR;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 260];
        let mut len = buf.len() as u32;
        let res = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        res.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

#[cfg(target_os = "windows")]
fn snap(hwnd: i64, zone: ScreenRect) -> Result<(), String> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::thread::sleep;
    use std::time::Duration;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, IsIconic, IsZoomed, SW_RESTORE, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos,
        ShowWindow,
    };

    let hwnd_id = hwnd;
    let hwnd = HWND(hwnd as isize as *mut c_void);
    let read_rect = |h: HWND| -> Option<RECT> {
        let mut rc = RECT::default();
        unsafe { GetWindowRect(h, &mut rc) }.ok().map(|_| rc)
    };
    let same = |a: &Option<RECT>, b: &Option<RECT>| match (a, b) {
        (Some(x), Some(y)) => {
            x.left == y.left && x.top == y.top && x.right == y.right && x.bottom == y.bottom
        }
        _ => false,
    };
    unsafe {
        // A maximized/minimized window ignores SetWindowPos (it snaps back), so restore it first —
        // then WAIT for the restore animation to settle. Measuring the window rect + DWM frame bounds
        // mid-animation reads an inconsistent pair and yields a bogus (~100px) border margin, which
        // mis-snaps the window horizontally (caught by the snap_moves_a_real_window smoke test). Poll
        // until two consecutive rects match and it's no longer zoomed/iconic (cap ~360ms).
        if IsZoomed(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let mut prev = read_rect(hwnd);
            for _ in 0..12 {
                sleep(Duration::from_millis(30));
                let cur = read_rect(hwnd);
                if same(&cur, &prev) && !IsZoomed(hwnd).as_bool() && !IsIconic(hwnd).as_bool() {
                    break;
                }
                prev = cur;
            }
        }

        let mut rc = RECT::default();
        GetWindowRect(hwnd, &mut rc).map_err(|e| format!("GetWindowRect failed: {e}"))?;
        let window = ScreenRect {
            x: rc.left as f64,
            y: rc.top as f64,
            w: (rc.right - rc.left) as f64,
            h: (rc.bottom - rc.top) as f64,
        };

        // Remember the pre-snap outer size so dragging the window OUT of its zone restores it
        // (restore_on_drag_out). `or_insert` keeps the ORIGINAL size across re-snaps into other zones.
        SNAPPED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(hwnd_id)
            .or_insert((rc.right - rc.left, rc.bottom - rc.top));

        let mut fb = RECT::default();
        let frame = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut fb as *mut _ as *mut c_void,
            size_of::<RECT>() as u32,
        )
        .is_ok()
        .then(|| ScreenRect {
            x: fb.left as f64,
            y: fb.top as f64,
            w: (fb.right - fb.left) as f64,
            h: (fb.bottom - fb.top) as f64,
        });

        let t = adjust_for_frame_bounds(zone, window, frame);
        SetWindowPos(
            hwnd,
            None,
            t.x as i32,
            t.y as i32,
            t.w as i32,
            t.h as i32,
            SWP_NOACTIVATE | SWP_NOZORDER,
        )
        .map_err(|e| format!("SetWindowPos failed (the target window may be elevated): {e}"))
    }
}

#[cfg(not(target_os = "windows"))]
fn list_arrangeable() -> Result<Vec<WindowDescriptor>, String> {
    Err("window management is only available on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
fn snap(_hwnd: i64, _zone: ScreenRect) -> Result<(), String> {
    Err("window management is only available on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clickthrough::ScreenRect;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> ScreenRect {
        ScreenRect { x, y, w, h }
    }

    #[test]
    fn is_arrangeable_requires_visible_titled_real_unowned_window() {
        assert!(is_arrangeable(
            true, false, false, true, 800, 600, false, false
        ));
        assert!(!is_arrangeable(
            false, false, false, true, 800, 600, false, false
        )); // hidden
        assert!(!is_arrangeable(
            true, true, false, true, 800, 600, false, false
        )); // tool window
        assert!(!is_arrangeable(
            true, false, true, true, 800, 600, false, false
        )); // cloaked
        assert!(!is_arrangeable(
            true, false, false, false, 800, 600, false, false
        )); // no title
        assert!(!is_arrangeable(
            true, false, false, true, 0, 600, false, false
        )); // zero width
        assert!(!is_arrangeable(
            true, false, false, true, 800, 600, true, false
        )); // our own window
        assert!(!is_arrangeable(
            true, false, false, true, 800, 600, false, true
        )); // owned/child popup
    }

    #[test]
    fn adjust_returns_zone_unchanged_without_a_frame() {
        let zone = rect(100.0, 200.0, 800.0, 600.0);
        assert_eq!(
            adjust_for_frame_bounds(zone, rect(0.0, 0.0, 800.0, 600.0), None),
            zone
        );
    }

    #[test]
    fn adjust_expands_by_lrb_margins_and_never_the_top() {
        // 7px invisible border L/R/B; the frame's top coincides with the window top.
        let zone = rect(100.0, 200.0, 800.0, 600.0);
        let window = rect(0.0, 0.0, 814.0, 607.0);
        let frame = Some(rect(7.0, 0.0, 800.0, 600.0));
        assert_eq!(
            adjust_for_frame_bounds(zone, window, frame),
            rect(93.0, 200.0, 814.0, 607.0)
        );
    }

    #[test]
    fn adjust_ignores_a_top_inset() {
        let zone = rect(0.0, 50.0, 400.0, 300.0);
        let window = rect(0.0, 0.0, 414.0, 357.0);
        let frame = Some(rect(7.0, 7.0, 400.0, 343.0)); // pretend a 7px top inset — must be ignored
        assert_eq!(adjust_for_frame_bounds(zone, window, frame).y, 50.0);
    }

    #[test]
    fn adjust_ignores_an_implausibly_large_border_read() {
        // A window measured mid open/restore animation yields a bogus ~100px left margin — clamped
        // to 0 so the window lands flush on the zone rather than ~100px off (the smoke-test bug).
        let zone = rect(200.0, 200.0, 800.0, 600.0);
        let window = rect(0.0, 0.0, 1920.0, 1000.0);
        let frame = Some(rect(102.0, 0.0, 1818.0, 1000.0)); // 102px left delta (bogus), rest 0
        assert_eq!(adjust_for_frame_bounds(zone, window, frame), zone);
    }

    #[test]
    fn exe_basename_lowercases_and_strips_dir() {
        assert_eq!(
            exe_basename("C:\\Program Files\\Spotify\\Spotify.exe"),
            "spotify.exe"
        );
        assert_eq!(exe_basename("/usr/bin/Foo"), "foo");
        assert_eq!(exe_basename("Code.exe"), "code.exe");
    }

    #[test]
    fn restore_top_left_keeps_cursor_proportional() {
        // Snapped to the left half (0,0,960,1080), grabbed near the top-center of the title bar.
        let snapped = rect(0.0, 0.0, 960.0, 1080.0);
        let (x, y) = restore_top_left(snapped, (480.0, 10.0), 800.0, 600.0);
        assert!((x - 80.0).abs() < 1e-9); // rel_x=0.5 → 480 - 0.5*800 = 80
        assert!(y > 0.0 && y < 10.0); // title bar stays just under the cursor (rel_y ≈ 0.009)
    }

    #[test]
    fn restore_top_left_guards_zero_size_snapped() {
        // Degenerate snapped size must not divide by zero.
        let (x, y) = restore_top_left(rect(5.0, 5.0, 0.0, 0.0), (5.0, 5.0), 800.0, 600.0);
        assert_eq!((x, y), (5.0, 5.0));
    }

    #[test]
    fn classic_drag_starts_and_ends_via_the_move_size_loop() {
        let mut d = DragDetector::default();
        assert_eq!(d.move_size_start(7), DragAction::Start(7));
        // A window-move during the real drag is suppressed (no synthetic double-start).
        assert_eq!(d.window_moved(7, true, true), DragAction::None);
        assert!(!d.in_synthetic_drag());
        assert_eq!(d.move_size_end(7), DragAction::End(7));
        // A stray end afterwards does nothing.
        assert_eq!(d.move_size_end(7), DragAction::None);
    }

    #[test]
    fn custom_titlebar_drag_is_inferred_from_move_while_pressed() {
        let mut d = DragDetector::default();
        // The window moves while the button is held → synthetic start.
        assert_eq!(d.window_moved(9, true, true), DragAction::Start(9));
        assert!(d.in_synthetic_drag());
        // Subsequent moves don't re-start it.
        assert_eq!(d.window_moved(9, true, true), DragAction::None);
        // Still held → no end yet; released → synthetic end.
        assert_eq!(d.tick(true), DragAction::None);
        assert_eq!(d.tick(false), DragAction::End(9));
        assert!(d.is_idle());
    }

    #[test]
    fn a_move_without_the_button_or_on_an_unarrangeable_window_is_not_a_drag() {
        let mut d = DragDetector::default();
        assert_eq!(d.window_moved(9, false, true), DragAction::None); // button up
        assert_eq!(d.window_moved(9, true, false), DragAction::None); // not arrangeable
        assert!(d.is_idle());
        assert_eq!(d.tick(false), DragAction::None); // tick with no synthetic drag ends nothing
    }

    #[test]
    fn an_active_real_drag_suppresses_synthetic_inference() {
        let mut d = DragDetector::default();
        d.move_size_start(1);
        assert!(!d.is_idle());
        // A move-while-pressed on any window is ignored mid real-drag, and tick never ends a real drag.
        assert_eq!(d.window_moved(2, true, true), DragAction::None);
        assert_eq!(d.tick(false), DragAction::None);
        assert_eq!(d.move_size_end(1), DragAction::End(1));
    }

    #[test]
    fn window_descriptor_serializes_to_the_ts_bridge_shape() {
        // Pins the wire contract for the TS mirror `WindowDescriptor` (core/windowMatch.ts). The
        // `className` camelCase rename is LOAD-BEARING — without it appOpen/zone class matching reads
        // `win.className` as undefined; this test fails loudly if the rename is ever dropped.
        let d = WindowDescriptor {
            hwnd: 123,
            exe: "C:\\X\\app.exe".to_string(),
            class_name: "Chrome_WidgetWin_1".to_string(),
            title: "Title".to_string(),
            rect: ScreenRect {
                x: 1.0,
                y: 2.0,
                w: 3.0,
                h: 4.0,
            },
        };
        let json = serde_json::to_value(&d).unwrap();
        assert_eq!(json["hwnd"], 123);
        assert_eq!(json["exe"], "C:\\X\\app.exe");
        assert_eq!(json["className"], "Chrome_WidgetWin_1"); // camelCase, NOT class_name
        assert!(
            json.get("class_name").is_none(),
            "snake_case class_name must not leak to the bridge"
        );
        assert_eq!(json["title"], "Title");
        assert_eq!(json["rect"]["x"], 1.0);
        assert_eq!(json["rect"]["w"], 3.0);
    }

    #[test]
    fn pointer_state_serializes_to_the_ts_bridge_shape() {
        // Mirrors `Pointer` in core/dragSnap.ts ({ x, y, shift }) — the overlay's drag poll reads these.
        let json = serde_json::to_value(PointerState {
            x: 10.0,
            y: 20.0,
            shift: true,
        })
        .unwrap();
        assert_eq!(json["x"], 10.0);
        assert_eq!(json["y"], 20.0);
        assert_eq!(json["shift"], true);
    }
}

/// Opt-in LIVE smoke test of the real `SetWindowPos` path (the one thing the pure seams can't cover):
/// spawn a throwaway Notepad, snap it into a target rect, read its real geometry back to prove it
/// moved, then close it. `#[ignore]` so normal `cargo test` / CI never spawns a GUI window — run it
/// explicitly:  `cargo test -p widgetsack -- --ignored --nocapture snap_moves_a_real_window`.
/// The window is identified by DIFFING the arrangeable-window set across the spawn, so it can never
/// hijack a window you already had open, and it is closed before any assertion (so a failure never
/// leaves it behind).
#[cfg(all(test, target_os = "windows"))]
mod manual_smoke {
    use super::*;
    use std::collections::HashSet;
    use std::process::Command;
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    fn arrangeable() -> Vec<WindowDescriptor> {
        list_arrangeable().unwrap_or_default()
    }

    fn rect_of(hwnd: i64) -> Option<ScreenRect> {
        arrangeable()
            .into_iter()
            .find(|w| w.hwnd == hwnd)
            .map(|w| w.rect)
    }

    fn close_window(hwnd: i64) {
        use std::ffi::c_void;
        use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
        let h = HWND(hwnd as isize as *mut c_void);
        let _ = unsafe { PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0)) };
    }

    #[test]
    #[ignore = "spawns + moves a real Notepad window; run explicitly with --ignored"]
    fn snap_moves_a_real_window() {
        let before: HashSet<i64> = arrangeable().into_iter().map(|w| w.hwnd).collect();
        let mut child = Command::new("notepad.exe")
            .spawn()
            .expect("failed to spawn notepad.exe");

        // Wait for a NEW arrangeable window (ours) — prefer one whose exe is notepad.exe.
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut hwnd = None;
        while Instant::now() < deadline && hwnd.is_none() {
            sleep(Duration::from_millis(150));
            let cur = arrangeable();
            hwnd = cur
                .iter()
                .find(|w| !before.contains(&w.hwnd) && exe_basename(&w.exe) == "notepad.exe")
                .or_else(|| cur.iter().find(|w| !before.contains(&w.hwnd)))
                .map(|w| w.hwnd);
        }
        let hwnd = match hwnd {
            Some(h) => h,
            None => {
                let _ = child.kill();
                let _ = child.wait(); // reap the process so clippy's zombie_processes lint is satisfied
                panic!("no new window appeared within 5s — did Notepad open?");
            }
        };

        let start = rect_of(hwnd);
        let target = ScreenRect {
            x: 200.0,
            y: 200.0,
            w: 800.0,
            h: 600.0,
        };
        let snapped = snap(hwnd, target);
        sleep(Duration::from_millis(250));
        let end = rect_of(hwnd);

        // Clean up BEFORE asserting so a failed assertion never leaves the window on screen.
        close_window(hwnd);
        let _ = child.kill();
        let _ = child.wait(); // reap the process so clippy's zombie_processes lint is satisfied

        println!("snap result: {snapped:?}");
        println!("target: {target:?}");
        println!("before: {start:?}");
        println!("after:  {end:?}");

        snapped.expect("snap returned Err");
        let end = end.expect("could not read the window rect after snapping");
        // The VISIBLE frame fills ~the target; the window rect sits within a small DWM border of it.
        assert!(
            (end.x - target.x).abs() < 16.0,
            "x off target: {} vs {}",
            end.x,
            target.x
        );
        assert!(
            (end.y - target.y).abs() < 16.0,
            "y off target: {} vs {}",
            end.y,
            target.y
        );
        assert!(
            (end.w - target.w).abs() < 32.0,
            "w off target: {} vs {}",
            end.w,
            target.w
        );
    }

    /// Synthesize the left mouse button down/up (so `GetAsyncKeyState(VK_LBUTTON)` — the synthetic-drag
    /// arming gate — reads it). Injected at the current cursor position.
    fn send_lmb(down: bool) {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEINPUT,
            SendInput,
        };
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: if down {
                        MOUSEEVENTF_LEFTDOWN
                    } else {
                        MOUSEEVENTF_LEFTUP
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    }

    /// LIVE smoke test of the custom-titlebar drag FALLBACK (the new, previously-unverified Win32 wiring:
    /// the EVENT_OBJECT_LOCATIONCHANGE hook + synthetic `DragDetector` + release-polling WM_TIMER). It
    /// installs the real watcher pipeline (routing drag signals into a capturing `DRAG_SINK` instead of
    /// Tauri), spawns a throwaway window, then SYNTHESIZES a custom drag: hold the left button + move the
    /// window with `SetWindowPos` (which fires LOCATIONCHANGE the same way an Electron/UWP titlebar drag
    /// does — WITHOUT entering the OS modal move loop), then release. Asserts a synthetic `Start` fired on
    /// the move and an `End` on release. `#[ignore]`: it spawns a GUI window and injects mouse input, so
    /// run it explicitly:
    ///   `cargo test -p widgetsack -- --ignored --nocapture synthetic_drag_emits_start_then_end`
    #[test]
    #[ignore = "spawns a real window + injects synthetic mouse input; run explicitly with --ignored"]
    fn synthetic_drag_emits_start_then_end() {
        use std::ffi::c_void;
        use std::sync::mpsc;
        use windows::Win32::Foundation::{HWND, RECT};
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowRect, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SetCursorPos, SetWindowPos,
        };

        // Capture drag signals (no Tauri), then start the REAL hook pipeline.
        let (tx, rx) = mpsc::channel::<DragAction>();
        let _ = DRAG_SINK.set(Box::new(move |a| {
            let _ = tx.send(a);
        }));
        spawn_drag_pump();
        sleep(Duration::from_millis(250)); // let the hooks install + the pump start

        // Spawn a throwaway window; identify it by diffing the arrangeable set across the spawn.
        let before: HashSet<i64> = arrangeable().into_iter().map(|w| w.hwnd).collect();
        let mut child = Command::new("notepad.exe")
            .spawn()
            .expect("failed to spawn notepad.exe");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut hwnd_id = None;
        while Instant::now() < deadline && hwnd_id.is_none() {
            sleep(Duration::from_millis(150));
            hwnd_id = arrangeable()
                .into_iter()
                .find(|w| !before.contains(&w.hwnd))
                .map(|w| w.hwnd);
        }
        let Some(hwnd_id) = hwnd_id else {
            let _ = child.kill();
            let _ = child.wait();
            panic!("no new window appeared within 5s — did Notepad open?");
        };
        let hwnd = HWND(hwnd_id as isize as *mut c_void);

        // Press the button over the window's CLIENT area (NOT the caption — pressing a titlebar would
        // start the OS modal move loop = the REAL path; we want the synthetic one), then move the window
        // via SetWindowPos to fire LOCATIONCHANGE, then release.
        let mut rc = RECT::default();
        let _ = unsafe { GetWindowRect(hwnd, &mut rc) };
        let cx = (rc.left + rc.right) / 2;
        let cy = rc.top + (rc.bottom - rc.top) * 3 / 4; // lower portion → client area
        let _ = unsafe { SetCursorPos(cx, cy) };
        send_lmb(true);
        sleep(Duration::from_millis(40));
        for i in 1..=4 {
            let _ = unsafe {
                SetWindowPos(
                    hwnd,
                    None,
                    rc.left + i * 8,
                    rc.top + i * 8,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                )
            };
            sleep(Duration::from_millis(40));
        }
        send_lmb(false);
        sleep(Duration::from_millis(200)); // let the ~30Hz release timer tick

        // Clean up BEFORE asserting so a failure never leaves the window (or a held button) behind.
        send_lmb(false); // belt-and-suspenders: ensure the injected button is released
        close_window(hwnd_id);
        let _ = child.kill();
        let _ = child.wait();

        let signals: Vec<DragAction> = rx.try_iter().collect();
        println!("captured drag signals: {signals:?}");
        assert!(
            signals
                .iter()
                .any(|a| matches!(a, DragAction::Start(h) if *h == hwnd_id)),
            "expected a synthetic Start for the dragged window; got {signals:?}"
        );
        assert!(
            signals
                .iter()
                .any(|a| matches!(a, DragAction::End(h) if *h == hwnd_id)),
            "expected an End after the button release; got {signals:?}"
        );
    }
}
