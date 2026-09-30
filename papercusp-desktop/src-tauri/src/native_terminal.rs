// native_terminal — the native sibling terminal window glued to the GUI.
//
// Owner directive (native-terminal-desktop-2026-06-06): the desktop terminal
// must be a fully NATIVE terminal, NOT xterm.js. A webview renders HTML and
// can only host a *web* terminal, so the native terminal cannot be a Tauri /
// dockview pane. Option A: the terminal surface runs in its OWN native window,
// a SIBLING of the Tauri GUI window, glued visually so the pair reads as one
// app. The DESKTOP-DOCKED surface is the chat dock (`pui chat` = zellij with
// exactly two panes: operator chat | brain — P-013 / D-011); the full
// workbench (`pui workbench`, HUD + work-area agent panes) stays the
// STANDALONE surface a human launches from a plain terminal.
//
// Strategy (P-001 / P-008):
//   - Linux/X11  → GluedGhosttyX11 (D-003): spawn a borderless GPU-native
//     Ghostty window hosting `pui chat`, share the app-id (WM_CLASS) with
//     the Tauri window, matched theme, and pin it flush-adjacent on every
//     Tauri-window move/resize (EWMH _NET_MOVERESIZE_WINDOW). GPU-native +
//     one-window-look, X11-only (only X11 lets you position a foreign window).
//   - Wayland / macOS / Windows → EmbeddedView (D-004, Phase 2): the app owns
//     a terminal window and renders a native terminal VIEW in it
//     (VTE / SwiftTerm / ConPTY — CPU-native, D-005). Not buildable/testable
//     on this X11 box; until those land we fall back to NewWindow (launch
//     `pui chat` in a real native terminal window — still native, just
//     not glued). The seam is kept clean so a future embeddable libghostty
//     drops into the EmbeddedView path without rework.
//   - No display (headless / CI) → Disabled.
//
// The glue is VISUAL ONLY (D-006): the terminal coordinates with the GUI
// through the durable substrate (operator API / coord / roster), exactly as
// the standalone pui does — never through the window relationship. Nothing in
// this module touches that; the pui is already a standalone substrate client.

use std::sync::Mutex;

// The desktop's matched dock background. No longer the DEFAULT (owner ask
// 2026-06-22 — the dock now inherits the user's plain Ghostty config bg); kept as
// the value to restore via PAPERCUSP_NATIVE_TERMINAL_BG, and used by tests.
#[allow(dead_code)]
const BLUE_FROST_TERMINAL_BG: &str = "#07101d";

// ───────────────────────────────────────────────────────────────────────────
// P-001 — runtime session detection + strategy selection (pure, testable)
// ───────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayServer {
    X11,
    Wayland,
    /// No display at all (headless / CI / a TTY-only session).
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Linux,
    Mac,
    Windows,
}

/// The per-OS embedded native terminal VIEW backend (Phase 2 / D-004).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedBackend {
    /// Linux/GTK — a VTE terminal widget beside the WebKitGTK webview.
    /// Wayland-safe (in-window, no foreign positioning).
    Vte,
    /// macOS — SwiftTerm in an NSWindow child window.
    SwiftTerm,
    /// Windows — a ConPTY-backed terminal control.
    ConPty,
}

/// The chosen terminal strategy for this desktop session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalStrategy {
    /// Linux/X11 v1: borderless GPU-native Ghostty sibling, glued by geometry.
    GluedGhosttyX11,
    /// Phase 2 portable path: an owned window with an embedded native view.
    EmbeddedView(EmbedBackend),
    /// Interim cross-platform fallback while the embedded views are unbuilt:
    /// launch the chat dock (`pui chat`) in a real native terminal NEW WINDOW
    /// (native, not glued). Reuses the proven `native_console` new-window
    /// spawner.
    NewWindow,
    /// Headless / no display — no terminal window.
    Disabled,
}

impl TerminalStrategy {
    /// Stable label for logs + the `native_terminal_status` command, so the
    /// rest of the desktop (and a debugging human) can see what was chosen.
    pub fn label(self) -> &'static str {
        match self {
            TerminalStrategy::GluedGhosttyX11 => "glued-ghostty-x11",
            TerminalStrategy::EmbeddedView(EmbedBackend::Vte) => "embedded-vte",
            TerminalStrategy::EmbeddedView(EmbedBackend::SwiftTerm) => "embedded-swiftterm",
            TerminalStrategy::EmbeddedView(EmbedBackend::ConPty) => "embedded-conpty",
            TerminalStrategy::NewWindow => "new-window",
            TerminalStrategy::Disabled => "disabled",
        }
    }
}

/// What we resolved about the running session. Built from env (X11/Wayland)
/// + the compile-time OS so the selection logic stays a pure function we can
/// unit-test on any host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionInfo {
    pub os: Os,
    pub display: DisplayServer,
}

/// Resolve the display server from the standard env vars. `xdg_session_type`
/// is authoritative when present ("x11"/"wayland"/"tty"); otherwise fall back
/// to WAYLAND_DISPLAY (wayland) / DISPLAY (x11) presence. Pure over its inputs.
pub fn detect_display_server(
    xdg_session_type: Option<&str>,
    wayland_display: Option<&str>,
    x11_display: Option<&str>,
) -> DisplayServer {
    let nonempty = |o: Option<&str>| o.map(|s| !s.is_empty()).unwrap_or(false);
    match xdg_session_type.map(|s| s.trim().to_ascii_lowercase()) {
        Some(ref s) if s == "wayland" => return DisplayServer::Wayland,
        Some(ref s) if s == "x11" => return DisplayServer::X11,
        // "tty" / unknown → fall through to the var-presence heuristic.
        _ => {}
    }
    if nonempty(wayland_display) {
        DisplayServer::Wayland
    } else if nonempty(x11_display) {
        DisplayServer::X11
    } else {
        DisplayServer::None
    }
}

/// Compile-time OS. Kept as a fn so tests can construct any `SessionInfo`.
pub fn current_os() -> Os {
    if cfg!(target_os = "macos") {
        Os::Mac
    } else if cfg!(target_os = "windows") {
        Os::Windows
    } else {
        Os::Linux
    }
}

/// The core routing decision (P-001 / P-008). Pure over `SessionInfo`.
///
///   Linux + X11      → glued foreign Ghostty (the v1).
///   Linux + Wayland  → embedded VTE view (Phase 2).
///   Linux + None     → Disabled (headless).
///   macOS            → embedded SwiftTerm view (Phase 2).
///   Windows          → embedded ConPTY control (Phase 2).
pub fn select_strategy(info: SessionInfo) -> TerminalStrategy {
    match info.os {
        Os::Linux => match info.display {
            DisplayServer::X11 => TerminalStrategy::GluedGhosttyX11,
            DisplayServer::Wayland => TerminalStrategy::EmbeddedView(EmbedBackend::Vte),
            DisplayServer::None => TerminalStrategy::Disabled,
        },
        Os::Mac => TerminalStrategy::EmbeddedView(EmbedBackend::SwiftTerm),
        Os::Windows => TerminalStrategy::EmbeddedView(EmbedBackend::ConPty),
    }
}

/// Resolve the strategy from the live process environment, applying the
/// `PAPERCUSP_NATIVE_TERMINAL` opt-out and an interim policy: the Phase-2
/// embedded views aren't built yet, so any `EmbeddedView` selection is served
/// by the `NewWindow` fallback for now (still a real native terminal). When a
/// backend ships, drop it from this downgrade set.
///
/// `PAPERCUSP_NATIVE_TERMINAL=0` forces Disabled (no sibling terminal).
/// `PAPERCUSP_NATIVE_TERMINAL_FORCE=<label>` overrides detection for testing
/// (`glued-ghostty-x11` / `new-window` / `disabled`).
pub fn resolve_strategy_from_env() -> TerminalStrategy {
    let get = |k: &str| std::env::var(k).ok();
    if get("PAPERCUSP_NATIVE_TERMINAL").as_deref() == Some("0") {
        return TerminalStrategy::Disabled;
    }
    if let Some(forced) = get("PAPERCUSP_NATIVE_TERMINAL_FORCE") {
        match forced.trim() {
            "glued-ghostty-x11" => return TerminalStrategy::GluedGhosttyX11,
            "new-window" => return TerminalStrategy::NewWindow,
            "disabled" => return TerminalStrategy::Disabled,
            "embedded-vte" => return TerminalStrategy::EmbeddedView(EmbedBackend::Vte),
            "embedded-swiftterm" => return TerminalStrategy::EmbeddedView(EmbedBackend::SwiftTerm),
            "embedded-conpty" => return TerminalStrategy::EmbeddedView(EmbedBackend::ConPty),
            _ => {}
        }
    }
    let info = SessionInfo {
        os: current_os(),
        display: detect_display_server(
            get("XDG_SESSION_TYPE").as_deref(),
            get("WAYLAND_DISPLAY").as_deref(),
            get("DISPLAY").as_deref(),
        ),
    };
    downgrade_unbuilt(select_strategy(info))
}

/// Serve unbuilt/unavailable Phase-2 backends with a fallback. The Linux VTE
/// embed and the macOS SwiftTerm embed (D-009) ARE built — each stays
/// selected whenever its runtime library/shim is loadable (both are dlopen'd,
/// not linked, so absence is a runtime question). ConPTY remains an
/// unverified force-only spike (see win_embed). The NewWindow fallback is
/// itself Linux-only (ghostty hosting the dock command) — on mac/Windows a
/// failed embed downgrades to Disabled instead, so boot doesn't log a
/// guaranteed launch failure every start (P-020 @
/// windows-desktop-release-readiness-2026-06-11). Centralised here so
/// enabling a backend is a one-line change.
fn downgrade_unbuilt(s: TerminalStrategy) -> TerminalStrategy {
    #[cfg(target_os = "linux")]
    let vte_available = vte_embed::available();
    #[cfg(not(target_os = "linux"))]
    let vte_available = false;
    #[cfg(target_os = "macos")]
    let swiftterm_available = swiftterm_embed::available();
    #[cfg(not(target_os = "macos"))]
    let swiftterm_available = false;
    // WI-4448: the new-window launcher is no longer Linux-only — Windows now has
    // one (the chat dock in a Windows Terminal window, hosted in the
    // papercup-runtime WSL distro). Without this, Windows selects
    // EmbeddedView(ConPty), finds that spike unavailable, and lands on Disabled —
    // i.e. no dock at all, which is precisely the bug.
    let out = downgrade_unbuilt_with(
        s,
        vte_available,
        swiftterm_available,
        cfg!(any(target_os = "linux", target_os = "windows")),
    );
    if out == TerminalStrategy::Disabled && s != TerminalStrategy::Disabled {
        println!(
            "[papercusp-desktop] native-terminal: no embedded backend available on this platform and the new-window launcher is Linux-only — native terminal disabled"
        );
    }
    out
}

/// The pure policy behind `downgrade_unbuilt` (availability injected for tests).
fn downgrade_unbuilt_with(
    s: TerminalStrategy,
    vte_available: bool,
    swiftterm_available: bool,
    new_window_available: bool,
) -> TerminalStrategy {
    match s {
        TerminalStrategy::EmbeddedView(EmbedBackend::Vte) if vte_available => s,
        TerminalStrategy::EmbeddedView(EmbedBackend::SwiftTerm) if swiftterm_available => s,
        TerminalStrategy::EmbeddedView(_) if new_window_available => TerminalStrategy::NewWindow,
        TerminalStrategy::EmbeddedView(_) => TerminalStrategy::Disabled,
        other => other,
    }
}

// ───────────────────────────────────────────────────────────────────────────
// P-005 — glue geometry (pure, testable)
// ───────────────────────────────────────────────────────────────────────────

/// A screen rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Which edge of the GUI window the terminal sibling docks against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DockSide {
    Right,
    Left,
    Bottom,
    Top,
}

impl DockSide {
    pub fn from_env(v: Option<&str>) -> DockSide {
        match v.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            Some("right") => DockSide::Right,
            Some("bottom") => DockSide::Bottom,
            Some("top") => DockSide::Top,
            Some("left") => DockSide::Left,
            // Default (unset / unrecognized) = LEFT: the native terminal docks on
            // the LEFT and the Tauri GUI sits on the right (native-terminal-desktop
            // D-011 / P-014). Override with PAPERCUSP_NATIVE_TERMINAL_SIDE=right.
            _ => DockSide::Left,
        }
    }
}

/// Compute the sibling terminal's rect so it sits flush against `main` on the
/// chosen side. `extent` is the terminal's size on the docking axis (width for
/// Left/Right, height for Top/Bottom); the other axis matches the GUI window
/// so the two read as one tiled surface. `gap` is the inter-window gap in px
/// (0 = seamless).
pub fn compute_sibling_geometry(main: Rect, side: DockSide, extent: i32, gap: i32) -> Rect {
    let extent = extent.max(1);
    match side {
        DockSide::Right => Rect {
            x: main.x + main.w + gap,
            y: main.y,
            w: extent,
            h: main.h,
        },
        DockSide::Left => Rect {
            x: main.x - extent - gap,
            y: main.y,
            w: extent,
            h: main.h,
        },
        DockSide::Bottom => Rect {
            x: main.x,
            y: main.y + main.h + gap,
            w: main.w,
            h: extent,
        },
        DockSide::Top => Rect {
            x: main.x,
            y: main.y - extent - gap,
            w: main.w,
            h: extent,
        },
    }
}

/// Whether two rects are within `tol` px on every coordinate. Used by the glue
/// to decide if the sibling has drifted far enough from its target to re-assert.
/// The tolerance is deliberately larger than a terminal cell (terminals snap
/// width/height to the character grid) so a snapped size isn't mistaken for
/// drift and re-sent forever — but small enough to catch a real reset (a window
/// that jumped back to its default origin/size is off by hundreds of px).
pub fn rects_close(a: Rect, b: Rect, tol: i32) -> bool {
    (a.x - b.x).abs() <= tol
        && (a.y - b.y).abs() <= tol
        && (a.w - b.w).abs() <= tol
        && (a.h - b.h).abs() <= tol
}

/// The terminal's extent on the docking axis: a fraction of the GUI window's
/// size on that axis, clamped to sane bounds so the terminal is never a sliver
/// or wider than the GUI. Pure.
pub fn sibling_extent(main: Rect, side: DockSide, fraction: f32, min_px: i32, max_px: i32) -> i32 {
    let axis = match side {
        DockSide::Right | DockSide::Left => main.w,
        DockSide::Top | DockSide::Bottom => main.h,
    };
    let raw = (axis as f32 * fraction).round() as i32;
    raw.clamp(min_px.min(max_px), max_px.max(min_px))
}

// ───────────────────────────────────────────────────────────────────────────
// P-015 — draggable split: the extent is USER-DRIVEN, not a fixed fraction
// ───────────────────────────────────────────────────────────────────────────

/// The (boundary, far) coordinates of the GUI window along the docking axis. The
/// *boundary* is the GUI edge the terminal docks flush against (the visible seam
/// between the two windows); the *far* edge is the opposite one. Horizontal axis
/// for Left/Right, vertical for Top/Bottom.
fn axis_edges(g: Rect, side: DockSide) -> (i32, i32) {
    match side {
        DockSide::Left => (g.x, g.x + g.w),
        DockSide::Right => (g.x + g.w, g.x),
        DockSide::Top => (g.y, g.y + g.h),
        DockSide::Bottom => (g.y + g.h, g.y),
    }
}

/// +1 when pushing the boundary edge outward (Left/Top: boundary coordinate
/// increasing) GROWS the terminal; -1 when it's the other way (Right/Bottom).
fn growth_sign(side: DockSide) -> i32 {
    match side {
        DockSide::Left | DockSide::Top => 1,
        DockSide::Right | DockSide::Bottom => -1,
    }
}

/// The terminal extent for this tick, given how the GUI window moved since the
/// last tick. Implements the **draggable split** (P-015): the terminal's inner
/// edge stays flush to the GUI's boundary edge (`compute_sibling_geometry` does
/// that), and its OUTER edge is anchored — so *dragging the boundary edge*
/// RESIZES the terminal, while *moving the whole window* only TRANSLATES it.
///
/// Along the docking axis the boundary edge moves by `d_boundary` and the far
/// edge by `d_far`. With a single pointer only one gesture happens per tick, so:
///   - whole-window move  → both edges shift equally (`d_boundary == d_far`)
///     → resize component 0 → extent unchanged (the terminal just translates).
///   - boundary-edge drag → far edge fixed (`d_far == 0`) → resize component
///     `d_boundary` → the terminal grows/shrinks by it.
///   - far-edge drag      → boundary fixed (`d_boundary == 0`) → extent unchanged.
/// The resize component is `d_boundary - d_far`, applied with the side's growth
/// sign and re-clamped to the configured bounds. (X11 v1 drives the split from
/// the GUI's WM-resizable edge; the embedded-view one-window path gets true
/// bidirectional drag for free — native-terminal-desktop D-012.)
pub fn resized_extent(
    side: DockSide,
    prev_gui: Rect,
    cur_gui: Rect,
    extent: i32,
    min_px: i32,
    max_px: i32,
) -> i32 {
    let lo = min_px.min(max_px);
    let hi = max_px.max(min_px);
    let (boundary_prev, far_prev) = axis_edges(prev_gui, side);
    let (boundary_cur, far_cur) = axis_edges(cur_gui, side);
    let d_boundary = boundary_cur - boundary_prev;
    if d_boundary == 0 {
        return extent.clamp(lo, hi);
    }
    let resize = d_boundary - (far_cur - far_prev);
    (extent + growth_sign(side) * resize).clamp(lo, hi)
}

// ───────────────────────────────────────────────────────────────────────────
// D-012 — BIDIRECTIONAL drag: a TERMINAL-edge drag drives the split too
//
// P-015's first cut drove the split only from the GUI's WM-resizable edge;
// a direct resize of the borderless terminal was indistinguishable from
// ghostty drift and got snapped back. These helpers classify how the
// sibling's ACTUAL geometry departed from its glue target so the tick can
// tell a user terminal-edge drag (adopt it; on a seam drag reflow the GUI)
// from a real reset (snap back). The WM-fight D-012 warned about is avoided
// structurally: we never re-assert the window the user is dragging — on a
// seam drag we move the OTHER window (the GUI), and a short settle window
// keeps the GUI-edge inference from double-applying the same delta.
// ───────────────────────────────────────────────────────────────────────────

/// How the sibling terminal's actual geometry departed from its glue target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiblingDelta {
    /// Within tolerance of the target — nothing to do.
    InPlace,
    /// The user dragged the terminal's SEAM edge (the one facing the GUI):
    /// outer edge + cross axis anchored, seam moved. Adopt `extent` and
    /// reflow the GUI so the seam follows the drag (GUI far edge anchored).
    SeamResize { extent: i32 },
    /// The user dragged the terminal's OUTER edge: seam + cross axis anchored.
    /// Adopt `extent`; the GUI stays put (the glued pair grows outward).
    OuterResize { extent: i32 },
    /// Anything else — wholesale move, cross-axis change, a ghostty geometry
    /// reset. Treated as drift: the glue snaps the sibling back.
    Jump,
}

/// (seam, outer) edge coordinates of a SIBLING rect on the docking axis. The
/// seam is the edge facing the GUI window; the outer edge is the opposite one.
/// (Distinct from `axis_edges`, which reads the GUI window's edges.)
fn sibling_edges(r: Rect, side: DockSide) -> (i32, i32) {
    match side {
        // Terminal left of the GUI → its RIGHT edge is the seam.
        DockSide::Left => (r.x + r.w, r.x),
        DockSide::Right => (r.x, r.x + r.w),
        DockSide::Top => (r.y + r.h, r.y),
        DockSide::Bottom => (r.y, r.y + r.h),
    }
}

/// Classify the sibling's actual rect against its last glue target (D-012).
/// `seam_tol` is the dead-band on the dock-axis edges — bigger than the
/// rounding noise of a flush placement but small enough that a deliberate
/// drag registers; a sub-tolerance ghostty cell-snap reads as `InPlace`
/// (and a supra-tolerance one is ADOPTED like a drag, which keeps the seam
/// flush against a size ghostty refuses to hold — self-stabilising either
/// way). `cross_tol` is the drift tolerance on the other axis. Pure.
pub fn classify_sibling_change(
    side: DockSide,
    target: Rect,
    actual: Rect,
    seam_tol: i32,
    cross_tol: i32,
) -> SiblingDelta {
    let cross_ok = match side {
        DockSide::Left | DockSide::Right => {
            (actual.y - target.y).abs() <= cross_tol && (actual.h - target.h).abs() <= cross_tol
        }
        DockSide::Top | DockSide::Bottom => {
            (actual.x - target.x).abs() <= cross_tol && (actual.w - target.w).abs() <= cross_tol
        }
    };
    let (seam_t, outer_t) = sibling_edges(target, side);
    let (seam_a, outer_a) = sibling_edges(actual, side);
    let seam_moved = (seam_a - seam_t).abs() > seam_tol;
    let outer_moved = (outer_a - outer_t).abs() > seam_tol;
    if !cross_ok {
        return SiblingDelta::Jump;
    }
    let extent = match side {
        DockSide::Left | DockSide::Right => actual.w,
        DockSide::Top | DockSide::Bottom => actual.h,
    };
    match (seam_moved, outer_moved) {
        (false, false) => SiblingDelta::InPlace,
        (true, false) => SiblingDelta::SeamResize { extent },
        (false, true) => SiblingDelta::OuterResize { extent },
        // Both edges moved together = a wholesale move (or a reset) — the
        // terminal isn't independently movable while glued; snap it back.
        (true, true) => SiblingDelta::Jump,
    }
}

/// P-005 minimize follow: what to do with the sibling when the GUI's
/// hidden/iconified state changes. `Some(true)` = iconify the sibling too,
/// `Some(false)` = restore it, `None` = no transition. Pure.
pub fn iconify_transition(gui_hidden: bool, last_hidden: bool) -> Option<bool> {
    if gui_hidden == last_hidden {
        None
    } else {
        Some(gui_hidden)
    }
}

/// P-005 "share focus sensibly": which window of the glued pair to restack
/// when the WM's active window changes. When ONE of the pair becomes active
/// (the user clicked/alt-tabbed to it), the OTHER is raised just above it so
/// the pair surfaces together — without this, focusing the GUI leaves the
/// terminal buried behind whatever app was covering it. Returns
/// `(window_to_raise, above_whom)`; `None` when focus didn't change or went
/// to an unrelated window (never fight other apps' stacking). Pure.
pub fn partner_to_raise(
    active: Option<u32>,
    last: Option<u32>,
    gui: u32,
    sibling: u32,
) -> Option<(u32, u32)> {
    if active == last {
        return None;
    }
    match active {
        Some(w) if w == gui => Some((sibling, gui)),
        Some(w) if w == sibling => Some((gui, sibling)),
        _ => None,
    }
}

/// The GUI rect that follows a SEAM drag of the sibling (D-012): the GUI's
/// boundary edge moves flush to the sibling's dragged seam (+`gap`), its FAR
/// edge stays anchored, the cross axis is untouched. Pure.
pub fn reflow_gui_for_seam(side: DockSide, gui: Rect, sibling: Rect, gap: i32) -> Rect {
    match side {
        DockSide::Left => {
            let far = gui.x + gui.w; // anchored right edge
            let x = sibling.x + sibling.w + gap;
            Rect {
                x,
                y: gui.y,
                w: (far - x).max(1),
                h: gui.h,
            }
        }
        DockSide::Right => {
            // Terminal right of the GUI; the GUI's LEFT edge is anchored.
            Rect {
                x: gui.x,
                y: gui.y,
                w: (sibling.x - gap - gui.x).max(1),
                h: gui.h,
            }
        }
        DockSide::Top => {
            let far = gui.y + gui.h;
            let y = sibling.y + sibling.h + gap;
            Rect {
                x: gui.x,
                y,
                w: gui.w,
                h: (far - y).max(1),
            }
        }
        DockSide::Bottom => Rect {
            x: gui.x,
            y: gui.y,
            w: gui.w,
            h: (sibling.y - gap - gui.y).max(1),
        },
    }
}

/// The GUI rect after a collapsed terminal releases its whole docking band.
///
/// Unlike `reflow_gui_for_seam`, this is not driven by a new sibling seam: the
/// sibling is about to be unmapped, so the GUI must grow by the remembered
/// terminal extent plus the inter-window gap. The pair's far outer edge stays
/// anchored. Pure, and exactly inverted by `gui_geometry_for_terminal_reopen`.
pub fn gui_geometry_after_terminal_collapse(
    side: DockSide,
    gui: Rect,
    extent: i32,
    gap: i32,
) -> Rect {
    let band = extent.max(1).saturating_add(gap).max(0);
    match side {
        DockSide::Left => Rect {
            x: gui.x.saturating_sub(band),
            y: gui.y,
            w: gui.w.saturating_add(band),
            h: gui.h,
        },
        DockSide::Right => Rect {
            x: gui.x,
            y: gui.y,
            w: gui.w.saturating_add(band),
            h: gui.h,
        },
        DockSide::Top => Rect {
            x: gui.x,
            y: gui.y.saturating_sub(band),
            w: gui.w,
            h: gui.h.saturating_add(band),
        },
        DockSide::Bottom => Rect {
            x: gui.x,
            y: gui.y,
            w: gui.w,
            h: gui.h.saturating_add(band),
        },
    }
}

/// Restore the GUI rect before remapping a collapsed terminal into its saved
/// docking band. This consumes the same `extent + gap` that collapse released;
/// dimensions stay at least one pixel for defensive behavior on tiny windows.
pub fn gui_geometry_for_terminal_reopen(side: DockSide, gui: Rect, extent: i32, gap: i32) -> Rect {
    let band = extent.max(1).saturating_add(gap).max(0);
    match side {
        DockSide::Left => Rect {
            x: gui.x.saturating_add(band),
            y: gui.y,
            w: gui.w.saturating_sub(band).max(1),
            h: gui.h,
        },
        DockSide::Right => Rect {
            x: gui.x,
            y: gui.y,
            w: gui.w.saturating_sub(band).max(1),
            h: gui.h,
        },
        DockSide::Top => Rect {
            x: gui.x,
            y: gui.y.saturating_add(band),
            w: gui.w,
            h: gui.h.saturating_sub(band).max(1),
        },
        DockSide::Bottom => Rect {
            x: gui.x,
            y: gui.y,
            w: gui.w,
            h: gui.h.saturating_sub(band).max(1),
        },
    }
}

// ───────────────────────────────────────────────────────────────────────────
// P-004 — the Ghostty launch argv (pure, testable)
// ───────────────────────────────────────────────────────────────────────────

/// Inputs to the Ghostty launch — kept as data so the argv builder is pure and
/// unit-testable without spawning anything.
#[derive(Debug, Clone)]
pub struct GhosttySpec {
    /// WM_CLASS *class* — shared with the Tauri window's app-id so taskbar /
    /// alt-tab group the pair as one app (P-004).
    pub class: String,
    /// WM_CLASS *instance* — unique so we can find the window deterministically.
    pub instance: String,
    /// Background hex (e.g. "#07101d"). EMPTY ⇒ omit `--background` so the dock
    /// inherits the user's default Ghostty config bg (owner ask 2026-06-22 — plain
    /// native look; accepts a slight color seam vs the GUI window).
    pub background: String,
    /// The command Ghostty hosts. Normally `["pui", "chat"]` (the chat dock).
    pub command: Vec<String>,
    /// ghostty binary (overridable via PAPERCUSP_GHOSTTY_BIN for tests / snaps).
    pub bin: String,
}

impl GhosttySpec {
    /// The default desktop-docked spec: a borderless GPU-native Ghostty hosting
    /// the chat dock — `pui chat`, zellij with exactly two panes (operator chat
    /// | brain), no workbench HUD / work area (P-013 / D-011) — sharing the
    /// desktop app-id. Override the hosted command with
    /// PAPERCUSP_NATIVE_TERMINAL_CMD (e.g. `pui workbench` for the full HUD).
    pub fn dock() -> GhosttySpec {
        let class = std::env::var("PAPERCUSP_NATIVE_TERMINAL_CLASS")
            .unwrap_or_else(|_| "com.papercusp.desktop".to_string());
        // Empty default ⇒ omit --background so the dock inherits the user's Ghostty
        // config bg (owner ask 2026-06-22). Set PAPERCUSP_NATIVE_TERMINAL_BG (e.g.
        // BLUE_FROST_TERMINAL_BG "#07101d") to restore the matched/seamless look.
        let background = std::env::var("PAPERCUSP_NATIVE_TERMINAL_BG").unwrap_or_default();
        let bin = std::env::var("PAPERCUSP_GHOSTTY_BIN").unwrap_or_else(|_| "ghostty".to_string());
        let command = match std::env::var("PAPERCUSP_NATIVE_TERMINAL_CMD") {
            Ok(s) if !s.trim().is_empty() => s.split_whitespace().map(|x| x.to_string()).collect(),
            _ => vec!["pui".to_string(), "chat".to_string()],
        };
        GhosttySpec {
            class,
            instance: "papercusp-terminal".to_string(),
            background,
            command,
            bin,
        }
    }

    /// Build the full ghostty argv (everything after the binary). Borderless,
    /// shared class, matched background, spawn-per-process (so the PID owns the
    /// window and is trackable), hosting the command via `-e`.
    pub fn argv(&self) -> Vec<String> {
        let mut a = vec![
            format!("--class={}", self.class),
            format!("--x11-instance-name={}", self.instance),
            "--window-decoration=false".to_string(),
            "--gtk-single-instance=false".to_string(),
            "--quit-after-last-window-closed=true".to_string(),
            "--confirm-close-surface=false".to_string(),
            // Thin left/right padding strip ghostty (NOT zellij) owns: zellij only
            // captures mouse inside its terminal grid, so this strip lets a drag on
            // the dock's edge reach the WM / desktop-glue resize (D-012) instead of
            // being swallowed by zellij content — restores edge drag-resize WITHOUT
            // pane frames (owner ask 2026-06-22 — keep the slim look + resizable).
            "--window-padding-x=8".to_string(),
        ];
        // Custom background only when set; empty ⇒ the user's default Ghostty
        // config bg (owner ask 2026-06-22 — plain native look).
        if !self.background.is_empty() {
            a.push(format!("--background={}", self.background));
        }
        // `-e <cmd...>` MUST be last — ghostty treats everything after it as the
        // hosted command line.
        a.push("-e".to_string());
        a.extend(self.command.iter().cloned());
        a
    }
}

// ───────────────────────────────────────────────────────────────────────────
// The live manager (Tauri-managed state)
// ───────────────────────────────────────────────────────────────────────────

/// Per-run config resolved once at boot.
#[derive(Debug, Clone)]
pub struct GlueConfig {
    pub side: DockSide,
    pub fraction: f32,
    pub min_px: i32,
    pub max_px: i32,
    pub gap: i32,
}

impl GlueConfig {
    pub fn from_env() -> GlueConfig {
        let f = |k: &str, d: f32| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d)
        };
        let i = |k: &str, d: i32| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d)
        };
        GlueConfig {
            side: DockSide::from_env(
                std::env::var("PAPERCUSP_NATIVE_TERMINAL_SIDE")
                    .ok()
                    .as_deref(),
            ),
            fraction: f("PAPERCUSP_NATIVE_TERMINAL_FRACTION", 0.42),
            min_px: i("PAPERCUSP_NATIVE_TERMINAL_MIN_PX", 480),
            // Drag ceiling, not the default size (fraction governs that). 1200
            // capped the dock at a sliver of a 4K monitor — unusable for the
            // 5-pane chat dock (owner report 2026-06-06). A monitor-fraction
            // ceiling is the better long-term shape (P-015's owner); until
            // then a generous fixed ceiling unblocks wide displays.
            max_px: i("PAPERCUSP_NATIVE_TERMINAL_MAX_PX", 2800),
            gap: i("PAPERCUSP_NATIVE_TERMINAL_GAP", 0),
        }
    }
}

struct Live {
    /// The spawned ghostty process. Killing it SIGHUPs the hosted zellij/pui.
    /// All the X11 glue state (window ids, extent, last target) lives in the
    /// loop thread's `GlueSession`, not here.
    child: std::process::Child,
}

// ───────────────────────────────────────────────────────────────────────────
// WI-3388 — user-driven layout: draggable divider + collapse-to-rail
//
// Owner ask 2026-07-08: every backend rebuilds onto ONE divider mechanism —
// a draggable divider (in the web UI, at the boundary between the native
// terminal and the webview) that sets the terminal's width, persisted across
// relaunch, plus a full collapse to a thin re-open rail. This is layout
// STATE the backends apply live; the rail's `‹/›` toggle button itself is a
// web UI element (`<TerminalDivider>`) at the shared edge — collapsing a
// backend just frees its native screen/widget space back to the GUI so the
// webview's own edge (now flush) can host the control, exactly the same
// shape across GluedGhosttyX11 (a real sibling window), the embedded views
// (one window, native widget/view resized in place), and NewWindow/Disabled
// (layout is inert — nothing native to resize).
// ───────────────────────────────────────────────────────────────────────────

/// The terminal's user-controlled layout. `fraction` is resolution-
/// independent (a fraction of the GUI window's docking-axis size, like
/// `GlueConfig::fraction`) so it's meaningful after a relaunch on a
/// differently-sized display; `collapsed` fully hides the terminal's native
/// surface, leaving only the webview's rail control. Persisted as "a
/// setting" (native window chrome — the owner explicitly ruled out a nuqs
/// URL param, which the webview's location bar has no reach into anyway).
#[derive(
    Debug, Default, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize, specta::Type,
)]
pub struct TerminalLayout {
    pub fraction: f32,
    pub collapsed: bool,
}

impl TerminalLayout {
    /// The extent (px) this layout resolves to against a GUI window whose
    /// docking-axis size is `axis`, given the configured bounds. Collapsed
    /// always resolves to 0 — the native surface takes no space at all, so
    /// the GUI (and the webview's own rail control at its now-flush edge)
    /// gets the full axis back. Pure.
    pub fn extent(&self, axis: i32, min_px: i32, max_px: i32) -> i32 {
        if self.collapsed {
            0
        } else {
            (axis as f32 * self.fraction)
                .round()
                .clamp(min_px.min(max_px) as f32, max_px.max(min_px) as f32) as i32
        }
    }
}

/// Load the persisted layout from `path`, falling back to `default` on any
/// error (missing file — first run — or a corrupt/foreign JSON blob; never a
/// reason to fail terminal startup). Pure over the read.
fn load_layout(path: &std::path::Path, default: TerminalLayout) -> TerminalLayout {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<TerminalLayout>(&s).ok())
        .map(|mut l| {
            l.fraction = l.fraction.clamp(0.05, 0.95);
            l
        })
        .unwrap_or(default)
}

/// Persist `layout` to `path` (best-effort — a write failure is logged, not
/// fatal: the in-memory layout still applies for this session).
fn save_layout(path: &std::path::Path, layout: TerminalLayout) {
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!(
                "[papercusp-desktop] native-terminal: layout persist dir {dir:?} failed: {e}"
            );
            return;
        }
    }
    match serde_json::to_string(&layout) {
        Ok(json) => {
            if let Err(e) = std::fs::write(path, json) {
                eprintln!("[papercusp-desktop] native-terminal: layout persist write failed: {e}");
            }
        }
        Err(e) => eprintln!("[papercusp-desktop] native-terminal: layout serialize failed: {e}"),
    }
}

pub struct NativeTerminal {
    pub strategy: TerminalStrategy,
    pub config: GlueConfig,
    /// D-004 (operator-chat-sidebar-revival P-014): the dock is gated behind
    /// FLAGS.TESTING. Rust cannot read the flag store (it is client-loaded in
    /// the webview), so the gate defaults CLOSED and the webview relays the
    /// resolved flag across the seam via `native_terminal_set_enabled` once
    /// flags load (and on live flips). Gate closed ⇒ no spawn (boot or
    /// toggle) and `native_terminal_status` reports `disabled`; all code +
    /// bundled pui/zellij binaries stay in the app — flag on restores the
    /// dock exactly.
    gate_enabled: std::sync::atomic::AtomicBool,
    live: Mutex<Option<Live>>,
    /// The current user layout, shared with whichever backend loop/handler
    /// needs to apply it live (the X11 glue-loop thread reads it every
    /// tick; the embedded-view backends re-read it on each `set_layout`
    /// call). `None` persist path ⇒ layout still works for this session,
    /// just doesn't survive relaunch (e.g. no resolvable app-config dir).
    /// `NativeTerminal` itself is Tauri-managed ('static, shared by
    /// reference across threads via `State`), so a plain `Mutex` — no `Arc`
    /// — is enough here.
    layout: Mutex<TerminalLayout>,
    persist_path: Mutex<Option<std::path::PathBuf>>,
    /// Backend-specific live handle so `set_layout` can re-layout an
    /// already-embedded view without re-attaching it. Linux VTE: the
    /// `GtkPaned*` as a `usize` (dereferenced only on the GTK main thread).
    #[cfg(target_os = "linux")]
    vte_paned: Mutex<Option<(usize, DockSide)>>,
    /// macOS SwiftTerm: (NSWindow*, retained LocalProcessTerminalView*) as
    /// `usize`s (dereferenced only on the AppKit main thread).
    #[cfg(target_os = "macos")]
    swiftterm_handle: Mutex<Option<(usize, usize)>>,
    /// Windows ConPTY: (parent HWND, term HWND, webview HWND) as `isize`s
    /// (HWND is a thin pointer wrapper; Win32 calls are thread-safe by
    /// window handle, unlike the GTK/AppKit main-thread-only widgets).
    #[cfg(target_os = "windows")]
    win_handles: Mutex<Option<(isize, isize, isize)>>,
}

impl NativeTerminal {
    pub fn new(strategy: TerminalStrategy) -> NativeTerminal {
        let config = GlueConfig::from_env();
        let default_layout = TerminalLayout {
            fraction: config.fraction,
            collapsed: false,
        };
        NativeTerminal {
            strategy,
            config,
            gate_enabled: std::sync::atomic::AtomicBool::new(false),
            live: Mutex::new(None),
            layout: Mutex::new(default_layout),
            persist_path: Mutex::new(None),
            #[cfg(target_os = "linux")]
            vte_paned: Mutex::new(None),
            #[cfg(target_os = "macos")]
            swiftterm_handle: Mutex::new(None),
            #[cfg(target_os = "windows")]
            win_handles: Mutex::new(None),
        }
    }

    pub fn is_running(&self) -> bool {
        self.live.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// D-004: is the FLAGS.TESTING gate open? Defaults false (dock dark)
    /// until the webview relays the flag via `native_terminal_set_enabled`.
    pub fn gate_enabled(&self) -> bool {
        self.gate_enabled.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// D-004: open/close the FLAGS.TESTING gate (webview-relayed).
    pub fn set_gate_enabled(&self, on: bool) {
        self.gate_enabled
            .store(on, std::sync::atomic::Ordering::Relaxed);
    }

    /// PID of the spawned ghostty process, if running. The glue loop resolves
    /// the sibling X11 window by this pid (`_NET_WM_PID`).
    pub fn ghostty_pid(&self) -> Option<u32> {
        self.live
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|l| l.child.id()))
    }

    /// Wire up persistence: load any layout already on disk at `path` (a
    /// no-op default when there's none yet) and remember `path` for future
    /// `set_layout` writes. Call once, right after `new`, before launch.
    pub fn init_layout_persistence(&self, path: std::path::PathBuf) {
        let loaded = load_layout(&path, *self.layout.lock().unwrap());
        *self.layout.lock().unwrap() = loaded;
        *self.persist_path.lock().unwrap() = Some(path);
    }

    pub fn get_layout(&self) -> TerminalLayout {
        *self.layout.lock().unwrap()
    }

    /// Update the layout (either field may be omitted to leave it
    /// unchanged), persist it, and return the resolved value. Does NOT apply
    /// it live — the caller (the `terminal_set_layout` command) does that
    /// per-backend, since only it knows which window/widget handles to hop
    /// to which main thread.
    pub fn set_layout(&self, fraction: Option<f32>, collapsed: Option<bool>) -> TerminalLayout {
        let mut guard = self.layout.lock().unwrap();
        if let Some(f) = fraction {
            guard.fraction = f.clamp(0.05, 0.95);
        }
        if let Some(c) = collapsed {
            guard.collapsed = c;
        }
        let resolved = *guard;
        drop(guard);
        if let Some(path) = self.persist_path.lock().unwrap().clone() {
            save_layout(&path, resolved);
        }
        resolved
    }
}

#[cfg(target_os = "linux")]
mod x11_glue {
    //! The X11 glue. One PERSISTENT connection drives the whole loop: opening a
    //! fresh connection per op (the naive approach) is too slow under Xvfb — the
    //! handshake dominates and the effective tick rate collapses to ~1/s, so the
    //! sibling lags the GUI by seconds. We resolve both windows by `_NET_WM_PID`
    //! once, read the GUI window's TRUE geometry from the server each tick
    //! (Tauri's `outer_position` lags WM moves), and pin the borderless Ghostty
    //! sibling with EWMH `_NET_MOVERESIZE_WINDOW` (what wmctrl uses; works under
    //! reparenting WMs). Foreign-window positioning is exactly what X11 uniquely
    //! allows (D-003) and Wayland forbids.
    use super::{
        classify_sibling_change, compute_sibling_geometry, gui_geometry_after_terminal_collapse,
        gui_geometry_for_terminal_reopen, iconify_transition, partner_to_raise, rects_close,
        reflow_gui_for_seam, resized_extent, sibling_extent, DockSide, GlueConfig, Rect,
        SiblingDelta,
    };
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{
        AtomEnum, ClientMessageEvent, ConnectionExt, EventMask, StackMode,
    };
    use x11rb::rust_connection::RustConnection;

    fn intern(conn: &RustConnection, name: &[u8]) -> Option<u32> {
        conn.intern_atom(false, name)
            .ok()?
            .reply()
            .ok()
            .map(|r| r.atom)
    }

    /// A live glue session: the connection + resolved windows + the dock config
    /// + the fixed extent and last target. Owned by the glue-loop thread.
    pub struct GlueSession {
        conn: RustConnection,
        root: u32,
        net_client_list: u32,
        net_wm_pid: u32,
        net_moveresize: u32,
        net_frame_extents: u32,
        net_active_window: u32,
        net_restack_window: u32,
        net_wm_state: u32,
        net_wm_state_hidden: u32,
        net_wm_state_skip_taskbar: u32,
        net_wm_state_skip_pager: u32,
        wm_change_state: u32,
        gui: u32,
        sibling: u32,
        side: DockSide,
        fraction: f32,
        min_px: i32,
        max_px: i32,
        gap: i32,
        extent: Option<i32>,
        last_target: Option<Rect>,
        /// Previous tick's GUI outer rect — the baseline the draggable split
        /// (P-015) diffs against to tell a boundary-edge RESIZE from a
        /// whole-window MOVE. `None` until the first tick seeds it.
        last_gui: Option<Rect>,
        /// Ticks left of the settle window after WE commanded a GUI
        /// move_resize (the D-012 seam reflow). While >0 the GUI-edge
        /// inference (`resized_extent`) is suspended so the WM applying our
        /// own command isn't re-read as a user boundary drag (which would
        /// double-apply — or, applied late, revert — the adopted extent).
        gui_settle: u8,
        /// The WM's `_NET_ACTIVE_WINDOW` last tick — the focus-share baseline
        /// (P-005): a TRANSITION to one of the pair raises the other.
        last_active: Option<u32>,
        /// Whether the GUI was hidden/iconified last tick — the minimize-follow
        /// baseline (P-005): a transition iconifies/restores the sibling.
        last_gui_hidden: bool,
        /// Whether the sibling is currently collapsed (WI-3388 — unmapped,
        /// GUI grown to fill its space). Distinct from `last_gui_hidden`
        /// (that's the GUI's own iconify state, which collapse-follows too).
        collapsed: bool,
    }

    impl GlueSession {
        /// Connect, intern atoms, and resolve both windows: the sibling by the
        /// ghostty pid (retried ~4s, since ghostty maps its window late) and our
        /// own GUI window by our process pid. None if X is unreachable or the
        /// sibling never appears.
        pub fn connect(sibling_pid: u32, gui_pid: u32, cfg: &GlueConfig) -> Option<Self> {
            let (conn, screen) = x11rb::connect(None).ok()?;
            let root = conn.setup().roots[screen].root;
            let net_client_list = intern(&conn, b"_NET_CLIENT_LIST")?;
            let net_wm_pid = intern(&conn, b"_NET_WM_PID")?;
            let net_moveresize = intern(&conn, b"_NET_MOVERESIZE_WINDOW")?;
            let net_frame_extents = intern(&conn, b"_NET_FRAME_EXTENTS")?;
            let net_active_window = intern(&conn, b"_NET_ACTIVE_WINDOW")?;
            let net_restack_window = intern(&conn, b"_NET_RESTACK_WINDOW")?;
            let net_wm_state = intern(&conn, b"_NET_WM_STATE")?;
            let net_wm_state_hidden = intern(&conn, b"_NET_WM_STATE_HIDDEN")?;
            let net_wm_state_skip_taskbar = intern(&conn, b"_NET_WM_STATE_SKIP_TASKBAR")?;
            let net_wm_state_skip_pager = intern(&conn, b"_NET_WM_STATE_SKIP_PAGER")?;
            let wm_change_state = intern(&conn, b"WM_CHANGE_STATE")?;
            let mut me = GlueSession {
                conn,
                root,
                net_client_list,
                net_wm_pid,
                net_moveresize,
                net_frame_extents,
                net_active_window,
                net_restack_window,
                net_wm_state,
                net_wm_state_hidden,
                net_wm_state_skip_taskbar,
                net_wm_state_skip_pager,
                wm_change_state,
                gui: 0,
                sibling: 0,
                side: cfg.side,
                fraction: cfg.fraction,
                min_px: cfg.min_px,
                max_px: cfg.max_px,
                gap: cfg.gap,
                extent: None,
                last_target: None,
                last_gui: None,
                gui_settle: 0,
                last_active: None,
                last_gui_hidden: false,
                collapsed: false,
            };
            let mut sibling = None;
            for _ in 0..40 {
                if let Some(w) = me.find_by_pid(sibling_pid) {
                    sibling = Some(w);
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            me.sibling = sibling?;
            me.gui = me.find_by_pid(gui_pid)?;
            Some(me)
        }

        pub fn sibling(&self) -> u32 {
            self.sibling
        }

        fn window_pid(&self, win: u32) -> Option<u32> {
            let r = self
                .conn
                .get_property(false, win, self.net_wm_pid, AtomEnum::CARDINAL, 0, 1)
                .ok()?
                .reply()
                .ok()?;
            r.value32().and_then(|mut it| it.next())
        }

        /// First top-level window (in `_NET_CLIENT_LIST`) owned by `pid`.
        fn find_by_pid(&self, pid: u32) -> Option<u32> {
            let r = self
                .conn
                .get_property(
                    false,
                    self.root,
                    self.net_client_list,
                    AtomEnum::WINDOW,
                    0,
                    4096,
                )
                .ok()?
                .reply()
                .ok()?;
            for w in r.value32()?.collect::<Vec<u32>>() {
                if self.window_pid(w) == Some(pid) {
                    return Some(w);
                }
            }
            None
        }

        /// `_NET_FRAME_EXTENTS` of `win` as (left, right, top, bottom), or all-zero
        /// when the WM hasn't set the property (undecorated / WM-less X).
        fn frame_extents(&self, win: u32) -> (i32, i32, i32, i32) {
            let (mut fl, mut fr, mut ft, mut fb) = (0i32, 0i32, 0i32, 0i32);
            if let Ok(Ok(reply)) = self
                .conn
                .get_property(false, win, self.net_frame_extents, AtomEnum::CARDINAL, 0, 4)
                .map(|c| c.reply())
            {
                let vals: Vec<u32> = reply.value32().map(|it| it.collect()).unwrap_or_default();
                if vals.len() == 4 {
                    fl = vals[0] as i32;
                    fr = vals[1] as i32;
                    ft = vals[2] as i32;
                    fb = vals[3] as i32;
                }
            }
            (fl, fr, ft, fb)
        }

        /// OUTER frame geometry of `win` in root coords (client geom translated
        /// to root, expanded by `_NET_FRAME_EXTENTS`).
        fn geometry(&self, win: u32) -> Option<Rect> {
            let geo = self.conn.get_geometry(win).ok()?.reply().ok()?;
            let t = self
                .conn
                .translate_coordinates(win, self.root, 0, 0)
                .ok()?
                .reply()
                .ok()?;
            let (fl, fr, ft, fb) = self.frame_extents(win);
            Some(Rect {
                x: t.dst_x as i32 - fl,
                y: t.dst_y as i32 - ft,
                w: geo.width as i32 + fl + fr,
                h: geo.height as i32 + ft + fb,
            })
        }

        /// Move/resize `win` to the given OUTER (frame-inclusive) rect —
        /// callers (this module) always compute geometry in the same OUTER
        /// terms `geometry()` reads back, so this is the single conversion
        /// point. `_NET_MOVERESIZE_WINDOW`'s width/height are the CLIENT
        /// window's size (frame excluded), NOT the frame's — a decorated
        /// window (the GUI, `decorations:true` in tauri.conf.json) has
        /// non-zero `_NET_FRAME_EXTENTS`, so sending the OUTER size
        /// unconverted asks the WM for a CLIENT this big, which yields an
        /// OUTER frame bigger again by the frame extent. Repeated collapse/
        /// expand cycles then compound that mismatch every call — reproduced
        /// live (WI-3388 verify, 2026-07-17): 3 collapse/expand cycles under
        /// openbox drifted the GUI window from 1280x800 to 1296x1016. The
        /// undecorated ghostty sibling has zero frame extents, so this
        /// conversion is a no-op for it — only the decorated GUI window was
        /// ever actually affected. x/y, by contrast, are the FRAME's
        /// top-left under gravity 0 (openbox honors it as such empirically —
        /// converting x/y the same way as w/h reintroduced an equal-and-
        /// opposite creep in Y position, so ONLY width/height need the
        /// frame-extent correction here).
        fn move_resize(&self, win: u32, x: i32, y: i32, w: i32, h: i32) {
            let (fl, fr, ft, fb) = self.frame_extents(win);
            let (cw, ch) = (w - fl - fr, h - ft - fb);
            // data.l[0]: low byte = gravity (0); bits 8..=11 flag x,y,w,h present;
            // bits 12..13 = source indication (2 = pager/app per EWMH).
            let flags: u32 = (1 << 8) | (1 << 9) | (1 << 10) | (1 << 11) | (2 << 12);
            let data = [
                flags,
                x as u32,
                y as u32,
                cw.max(1) as u32,
                ch.max(1) as u32,
            ];
            let event = ClientMessageEvent::new(32, win, self.net_moveresize, data);
            let mask = EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT;
            let _ = self.conn.send_event(false, self.root, mask, event);
            let _ = self.conn.flush();
        }

        /// Restack `win` directly ABOVE `above` (z-order), WM-correctly.
        /// Under a reparenting WM (mutter/openbox) toplevels live inside frame
        /// windows, so a raw `configure_window(ABOVE)` only restacks the client
        /// INSIDE its own frame — a visual no-op. The EWMH way is a
        /// `_NET_RESTACK_WINDOW` client message to the root (source=2 pager,
        /// sibling=`above`, detail=Above), which the WM applies to the frames.
        /// The raw configure is still sent as a fallback for WM-less X (bare
        /// Xvfb), where there's no redirect and it applies directly.
        fn restack_above(&self, win: u32, above: u32) {
            let data = [2u32, above, 0 /* Above */, 0, 0];
            let event = ClientMessageEvent::new(32, win, self.net_restack_window, data);
            let mask = EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT;
            let _ = self.conn.send_event(false, self.root, mask, event);
            use x11rb::protocol::xproto::ConfigureWindowAux;
            let aux = ConfigureWindowAux::new()
                .sibling(above)
                .stack_mode(StackMode::ABOVE);
            let _ = self.conn.configure_window(win, &aux);
            let _ = self.conn.flush();
        }

        /// Raise the sibling just above the GUI (keep it with the GUI's
        /// z-order — "share focus sensibly"). Called once after the initial
        /// placement; thereafter `focus_tick` keeps the pair surfacing
        /// together.
        pub fn raise(&self) {
            self.restack_above(self.sibling, self.gui);
        }

        /// Hide the borderless sibling from the taskbar + alt-tab switcher
        /// (P-005 grouping): the pair then presents as ONE entry — the GUI —
        /// and activating it surfaces the terminal via the focus share.
        /// EWMH `_NET_WM_STATE` add (1) of SKIP_TASKBAR + SKIP_PAGER, source
        /// pager (2). Called once after the windows resolve.
        pub fn apply_skip_taskbar(&self) {
            let data = [
                1u32, // _NET_WM_STATE_ADD
                self.net_wm_state_skip_taskbar,
                self.net_wm_state_skip_pager,
                2, // source: pager
                0,
            ];
            let event = ClientMessageEvent::new(32, self.sibling, self.net_wm_state, data);
            let mask = EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT;
            let _ = self.conn.send_event(false, self.root, mask, event);
            let _ = self.conn.flush();
        }

        /// Whether the GUI window is hidden/iconified (`_NET_WM_STATE_HIDDEN`
        /// present in its `_NET_WM_STATE`).
        fn gui_hidden(&self) -> bool {
            let Ok(cookie) =
                self.conn
                    .get_property(false, self.gui, self.net_wm_state, AtomEnum::ATOM, 0, 64)
            else {
                return false;
            };
            let Ok(reply) = cookie.reply() else {
                return false;
            };
            reply
                .value32()
                .map(|mut it| it.any(|a| a == self.net_wm_state_hidden))
                .unwrap_or(false)
        }

        /// P-005 minimize follow: when the GUI is iconified, iconify the
        /// sibling too (ICCCM `WM_CHANGE_STATE` → IconicState); when restored,
        /// map it back and re-pin it just above the GUI. Returns whether the
        /// GUI is currently hidden so the caller can skip the geometry/focus
        /// ticks (never fight the WM over an iconified pair).
        pub fn minimize_tick(&mut self) -> bool {
            let hidden = self.gui_hidden();
            if let Some(hide) = iconify_transition(hidden, self.last_gui_hidden) {
                if hide {
                    let data = [3u32 /* IconicState */, 0, 0, 0, 0];
                    let event =
                        ClientMessageEvent::new(32, self.sibling, self.wm_change_state, data);
                    let mask = EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT;
                    let _ = self.conn.send_event(false, self.root, mask, event);
                    let _ = self.conn.flush();
                } else {
                    // ICCCM: mapping an iconified window restores it.
                    let _ = self.conn.map_window(self.sibling);
                    let _ = self.conn.flush();
                    self.restack_above(self.sibling, self.gui);
                }
                self.last_gui_hidden = hidden;
            }
            hidden
        }

        /// The WM's `_NET_ACTIVE_WINDOW` (the active toplevel), if any.
        fn active_window(&self) -> Option<u32> {
            let r = self
                .conn
                .get_property(
                    false,
                    self.root,
                    self.net_active_window,
                    AtomEnum::WINDOW,
                    0,
                    1,
                )
                .ok()?
                .reply()
                .ok()?;
            r.value32().and_then(|mut it| it.next()).filter(|w| *w != 0)
        }

        /// P-005 focus share: when the user focuses ONE window of the glued
        /// pair, surface the OTHER alongside it (restacked just above the
        /// newly-active one, not top-of-everything). Transition-edge only —
        /// when focus sits on an unrelated app we never touch stacking.
        pub fn focus_tick(&mut self) {
            let active = self.active_window();
            if let Some((win, above)) =
                partner_to_raise(active, self.last_active, self.gui, self.sibling)
            {
                self.restack_above(win, above);
            }
            self.last_active = active;
        }

        /// WI-3388: apply an explicit user layout (the webview divider drag
        /// or the collapse rail) — distinct from the D-012 WM-edge-drag path
        /// below, which classifies an *observed* geometry departure. This is
        /// a *command*: fraction/collapsed changed in the shared layout
        /// state, so pin the sibling (and, on a collapse transition, the
        /// GUI) to the new target right now. Returns `true` if it acted this
        /// tick (the caller should skip the normal at-rest/drift flush —
        /// geometry commands already went out).
        fn apply_user_layout(&mut self, layout: super::TerminalLayout) -> bool {
            let fraction_changed = (layout.fraction - self.fraction).abs() > 0.001;
            let collapse_changed = layout.collapsed != self.collapsed;
            if !fraction_changed && !collapse_changed {
                return false;
            }
            let Some(main) = self.geometry(self.gui) else {
                return false;
            };
            if layout.collapsed {
                if self.collapsed {
                    // A fraction update while collapsed is deliberately
                    // deferred. Keeping `self.fraction` unchanged makes the
                    // reopen transition resolve that new fraction against the
                    // restored (not band-expanded) GUI rect.
                    return false;
                }
                // Unmap the sibling and grow the GUI into the exact band it
                // released. Preserve the terminal extent so reopen can invert
                // this geometry without deriving a larger value from the
                // temporarily expanded GUI.
                let extent = self.extent.filter(|extent| *extent > 0).unwrap_or_else(|| {
                    sibling_extent(main, self.side, self.fraction, self.min_px, self.max_px)
                });
                let grown = gui_geometry_after_terminal_collapse(self.side, main, extent, self.gap);
                let _ = self.conn.unmap_window(self.sibling);
                let _ = self.conn.flush();
                self.move_resize(self.gui, grown.x, grown.y, grown.w, grown.h);
                self.last_gui = Some(grown);
                self.gui_settle = 2;
                self.extent = Some(extent);
                self.last_target = None;
                self.collapsed = true;
                return true;
            }
            if self.collapsed {
                // Was collapsed: remap, then shrink the GUI back to make room
                // before placing the sibling in the reclaimed band. Restore
                // with the extent that collapse saved; only then resolve a
                // newly requested fraction against the original GUI size.
                let prior_extent = self.extent.filter(|extent| *extent > 0).unwrap_or_else(|| {
                    sibling_extent(main, self.side, self.fraction, self.min_px, self.max_px)
                });
                let shrunk =
                    gui_geometry_for_terminal_reopen(self.side, main, prior_extent, self.gap);
                let extent = if fraction_changed {
                    sibling_extent(shrunk, self.side, layout.fraction, self.min_px, self.max_px)
                } else {
                    prior_extent.clamp(self.min_px.min(self.max_px), self.max_px.max(self.min_px))
                };
                let _ = self.conn.map_window(self.sibling);
                self.move_resize(self.gui, shrunk.x, shrunk.y, shrunk.w, shrunk.h);
                self.last_gui = Some(shrunk);
                self.gui_settle = 2;
                let t2 = compute_sibling_geometry(shrunk, self.side, extent, self.gap);
                self.move_resize(self.sibling, t2.x, t2.y, t2.w, t2.h);
                self.restack_above(self.sibling, self.gui);
                self.last_target = Some(t2);
                self.extent = Some(extent);
            } else {
                // Already expanded — just a fraction change (the divider was
                // dragged in the webview): resize the sibling in place, GUI
                // untouched (matches the plain-resize tick's target math).
                let extent =
                    sibling_extent(main, self.side, layout.fraction, self.min_px, self.max_px);
                let target = compute_sibling_geometry(main, self.side, extent, self.gap);
                self.move_resize(self.sibling, target.x, target.y, target.w, target.h);
                self.last_target = Some(target);
                self.last_gui = Some(main);
                self.extent = Some(extent);
            }
            self.fraction = layout.fraction;
            self.collapsed = false;
            true
        }

        /// One glue step: read the GUI geometry and pin the sibling flush to it.
        /// Re-asserts on `force` (warmup), target change (GUI moved), or drift
        /// (the sibling jumped on its own — ghostty occasionally re-applies its
        /// default geometry; the drift check observes the sibling's ACTUAL
        /// geometry, with a tolerance that ignores terminal cell-snap but catches
        /// a real reset). The split is BIDIRECTIONAL (D-012): a drag of the
        /// terminal's own seam/outer edge is classified apart from drift and
        /// adopted (a seam drag reflows the GUI) instead of snapped back.
        /// `layout` is the current WI-3388 user layout (webview divider/rail);
        /// a change there is applied FIRST and short-circuits the rest of the
        /// tick. Returns `(target, changed, drifted)` when it moved.
        pub fn tick(
            &mut self,
            force: bool,
            layout: super::TerminalLayout,
        ) -> Option<(Rect, bool, bool)> {
            if self.apply_user_layout(layout) {
                return self.last_target.map(|t| (t, true, false));
            }
            if self.collapsed {
                // Nothing to track while collapsed — the sibling is unmapped.
                return None;
            }
            /// Drift tolerance: bigger than terminal cell-snap, far smaller
            /// than a real geometry reset.
            const DRIFT_TOL: i32 = 40;
            /// Dock-axis dead-band for the D-012 terminal-edge drag: above
            /// flush-placement rounding noise, low enough that a deliberate
            /// drag registers within a tick or two.
            const SEAM_TOL: i32 = 8;

            let main = self.geometry(self.gui)?;

            // D-012 bidirectional drag: when the GUI is at rest but the sibling
            // departed from target along the dock axis, the user dragged the
            // TERMINAL's edge (one pointer: a moving GUI means the gesture is on
            // the GUI side — the established path below owns that). Never
            // re-assert the window the user is holding; on a seam drag move the
            // OTHER window (the GUI) to follow.
            let gui_at_rest = self.last_gui == Some(main) && self.gui_settle == 0;
            if !force && gui_at_rest {
                if let (Some(t), Some(actual)) = (self.last_target, self.geometry(self.sibling)) {
                    match classify_sibling_change(self.side, t, actual, SEAM_TOL, DRIFT_TOL) {
                        SiblingDelta::SeamResize { extent } => {
                            let lo = self.min_px.min(self.max_px);
                            let hi = self.max_px.max(self.min_px);
                            let clamped = extent.clamp(lo, hi);
                            // At the clamp the split can't follow further — fall
                            // through to the normal flush, which snaps the
                            // sibling back to the bound (standard splitter feel).
                            if Some(clamped) != self.extent {
                                self.extent = Some(clamped);
                                let g = reflow_gui_for_seam(self.side, main, actual, self.gap);
                                self.move_resize(self.gui, g.x, g.y, g.w, g.h);
                                // Predict the commanded GUI rect as the new
                                // baseline + open the settle window so the WM
                                // applying OUR move isn't re-read as a user
                                // boundary drag next tick.
                                self.last_gui = Some(g);
                                self.gui_settle = 2;
                                let t2 = compute_sibling_geometry(g, self.side, clamped, self.gap);
                                self.last_target = Some(t2);
                                return Some((t2, true, false));
                            }
                        }
                        SiblingDelta::OuterResize { extent } => {
                            // Adopt the dragged extent; the GUI stays put. The
                            // normal flush below recomputes the target from the
                            // unchanged GUI + adopted extent — which lands
                            // exactly where the user dragged the outer edge.
                            let lo = self.min_px.min(self.max_px);
                            let hi = self.max_px.max(self.min_px);
                            self.extent = Some(extent.clamp(lo, hi));
                        }
                        SiblingDelta::InPlace | SiblingDelta::Jump => {
                            // Jump = real drift — the flush below snaps it back.
                        }
                    }
                }
            }

            // Resolve the terminal extent. Initial extent = the configured
            // fraction; thereafter the user RESIZES it by dragging the boundary
            // edge between the two windows (P-015) — a draggable split, not a
            // fixed ratio. `resized_extent` distinguishes that boundary drag from
            // a whole-window move (which only translates the sibling). During the
            // settle window after a D-012 GUI reflow the inference is suspended —
            // the GUI deltas in flight are our own command being applied.
            let settling = self.gui_settle > 0;
            let extent = match (self.extent, self.last_gui) {
                (Some(prev), Some(prev_gui)) => {
                    if settling {
                        self.gui_settle -= 1;
                        prev
                    } else {
                        resized_extent(self.side, prev_gui, main, prev, self.min_px, self.max_px)
                    }
                }
                _ => sibling_extent(main, self.side, self.fraction, self.min_px, self.max_px),
            };
            self.extent = Some(extent);
            self.last_gui = Some(main);
            let t = compute_sibling_geometry(main, self.side, extent, self.gap);
            let changed = self.last_target != Some(t);
            // While settling, sibling departure is most likely the user's drag
            // still in flight — don't snap it back; the next at-rest tick
            // classifies (and adopts) it properly.
            let drifted = !settling
                && self
                    .geometry(self.sibling)
                    .map(|cur| !rects_close(cur, t, DRIFT_TOL))
                    .unwrap_or(false);
            if force || changed || drifted {
                self.move_resize(self.sibling, t.x, t.y, t.w, t.h);
                self.last_target = Some(t);
                return Some((t, changed, drifted));
            }
            None
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────
// D-009 — Linux embedded native terminal VIEW (the Wayland-safe Phase-2 path)
//
// The app OWNS the terminal: a real VTE widget (CPU-native, accepted — D-005)
// packed beside the WebKitWebView inside the Tauri window's own GTK tree via
// a GtkPaned — ONE window, no foreign-window glue, so it works on Wayland
// where X11's foreign positioning is forbidden (D-004). The paned handle IS
// the draggable split, so this path gets D-012's bidirectional drag for free.
//
// libvte-2.91 (the GTK3 build, matching tauri/wry's GTK3) is loaded at
// RUNTIME via dlopen — the shipped bundle takes no link-time dependency on
// VTE; when the library is absent `resolve_strategy_from_env` downgrades the
// selection to NewWindow (still a real native terminal).
// ───────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
pub mod vte_embed {
    use super::DockSide;
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::sync::OnceLock;

    /// GTK3 build of VTE (matches tauri/wry's GTK3; the -gtk4 soname is a
    /// different, incompatible build).
    const SONAMES: &[&str] = &["libvte-2.91.so.0", "libvte-2.91.so"];
    /// GSpawnFlags: resolve the command on PATH (G_SPAWN_SEARCH_PATH).
    const G_SPAWN_SEARCH_PATH: c_int = 1 << 2;

    /// `GdkRGBA` — four doubles, by C layout.
    #[repr(C)]
    pub struct GdkRgba {
        pub red: f64,
        pub green: f64,
        pub blue: f64,
        pub alpha: f64,
    }

    type FnTerminalNew = unsafe extern "C" fn() -> *mut c_void;
    #[allow(clippy::type_complexity)]
    type FnSpawnAsync = unsafe extern "C" fn(
        terminal: *mut c_void,
        pty_flags: c_int, // VtePtyFlags; 0 = VTE_PTY_DEFAULT
        working_directory: *const c_char,
        argv: *const *const c_char,
        envv: *const *const c_char,
        spawn_flags: c_int,
        child_setup: *const c_void,
        child_setup_data: *mut c_void,
        child_setup_data_destroy: *const c_void,
        timeout: c_int,
        cancellable: *mut c_void,
        callback: *const c_void,
        user_data: *mut c_void,
    );
    type FnSetColors = unsafe extern "C" fn(
        terminal: *mut c_void,
        foreground: *const GdkRgba,
        background: *const GdkRgba,
        palette: *const GdkRgba,
        palette_size: usize,
    );
    type FnSetSize = unsafe extern "C" fn(terminal: *mut c_void, columns: i64, rows: i64);
    type FnGetCharDim = unsafe extern "C" fn(terminal: *mut c_void) -> i64;
    type FnTermVoid = unsafe extern "C" fn(terminal: *mut c_void);
    type FnCopyFormat = unsafe extern "C" fn(terminal: *mut c_void, format: c_int);
    type FnGetFontScale = unsafe extern "C" fn(terminal: *mut c_void) -> f64;
    type FnSetFontScale = unsafe extern "C" fn(terminal: *mut c_void, scale: f64);

    struct Vte {
        /// Held for the process lifetime — the fn pointers below point into it.
        _lib: libloading::Library,
        terminal_new: FnTerminalNew,
        spawn_async: FnSpawnAsync,
        set_colors: Option<FnSetColors>,
        set_size: Option<FnSetSize>,
        char_width: Option<FnGetCharDim>,
        char_height: Option<FnGetCharDim>,
        paste_clipboard: Option<FnTermVoid>,
        /// `vte_terminal_copy_clipboard_format` (vte ≥ 0.50); the plain
        /// deprecated `copy_clipboard` is the fallback for older sonames.
        copy_clipboard_format: Option<FnCopyFormat>,
        copy_clipboard: Option<FnTermVoid>,
        get_font_scale: Option<FnGetFontScale>,
        set_font_scale: Option<FnSetFontScale>,
    }

    // SAFETY: the library handle + C fn pointers are immutable after load and
    // libvte's entry points are called only from the GTK main thread.
    unsafe impl Send for Vte {}
    unsafe impl Sync for Vte {}

    fn lib() -> Option<&'static Vte> {
        static LIB: OnceLock<Option<Vte>> = OnceLock::new();
        LIB.get_or_init(|| {
            for name in SONAMES {
                // SAFETY: dlopen of a system library; we only resolve C symbols.
                let l = match unsafe { libloading::Library::new(name) } {
                    Ok(l) => l,
                    Err(_) => continue,
                };
                unsafe {
                    let terminal_new = match l.get::<FnTerminalNew>(b"vte_terminal_new\0") {
                        Ok(s) => *s,
                        Err(_) => continue,
                    };
                    let spawn_async = match l.get::<FnSpawnAsync>(b"vte_terminal_spawn_async\0") {
                        Ok(s) => *s,
                        Err(_) => continue,
                    };
                    let set_colors = l
                        .get::<FnSetColors>(b"vte_terminal_set_colors\0")
                        .ok()
                        .map(|s| *s);
                    let set_size = l
                        .get::<FnSetSize>(b"vte_terminal_set_size\0")
                        .ok()
                        .map(|s| *s);
                    let char_width = l
                        .get::<FnGetCharDim>(b"vte_terminal_get_char_width\0")
                        .ok()
                        .map(|s| *s);
                    let char_height = l
                        .get::<FnGetCharDim>(b"vte_terminal_get_char_height\0")
                        .ok()
                        .map(|s| *s);
                    let paste_clipboard = l
                        .get::<FnTermVoid>(b"vte_terminal_paste_clipboard\0")
                        .ok()
                        .map(|s| *s);
                    let copy_clipboard_format = l
                        .get::<FnCopyFormat>(b"vte_terminal_copy_clipboard_format\0")
                        .ok()
                        .map(|s| *s);
                    let copy_clipboard = l
                        .get::<FnTermVoid>(b"vte_terminal_copy_clipboard\0")
                        .ok()
                        .map(|s| *s);
                    let get_font_scale = l
                        .get::<FnGetFontScale>(b"vte_terminal_get_font_scale\0")
                        .ok()
                        .map(|s| *s);
                    let set_font_scale = l
                        .get::<FnSetFontScale>(b"vte_terminal_set_font_scale\0")
                        .ok()
                        .map(|s| *s);
                    return Some(Vte {
                        terminal_new,
                        spawn_async,
                        set_colors,
                        set_size,
                        char_width,
                        char_height,
                        paste_clipboard,
                        copy_clipboard_format,
                        copy_clipboard,
                        get_font_scale,
                        set_font_scale,
                        _lib: l,
                    });
                }
            }
            None
        })
        .as_ref()
    }

    /// Whether the runtime VTE library is present + loadable. Drives the
    /// strategy downgrade: no VTE → NewWindow fallback.
    pub fn available() -> bool {
        lib().is_some()
    }

    /// `#rrggbb` → GdkRGBA (alpha 1). Pure — unit-tested.
    pub fn parse_hex_rgba(hex: &str) -> Option<GdkRgba> {
        let h = hex.trim().strip_prefix('#')?;
        if h.len() != 6 || !h.is_ascii() {
            return None;
        }
        let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
        Some(GdkRgba {
            red: byte(0)? as f64 / 255.0,
            green: byte(2)? as f64 / 255.0,
            blue: byte(4)? as f64 / 255.0,
            alpha: 1.0,
        })
    }

    /// The GtkPaned split position for the configured side + fraction: the
    /// terminal takes `fraction` of `total` on its side of the handle. Pure.
    pub fn initial_split_position(side: DockSide, total: i32, fraction: f32) -> i32 {
        let extent = (total as f32 * fraction).round() as i32;
        match side {
            // Terminal is pane1 → the handle sits at its extent.
            DockSide::Left | DockSide::Top => extent.clamp(1, total.max(1)),
            // Webview is pane1 → the handle sits at total - extent.
            DockSide::Right | DockSide::Bottom => (total - extent).clamp(1, total.max(1)),
        }
    }

    /// The chord-bound terminal actions. Raw VTE ships NO default keyboard
    /// shortcuts — every VTE app (GNOME Terminal, Tilix, …) wires its own —
    /// so without these the dock has no paste path at all (and the widget's
    /// built-in middle-click PRIMARY paste is eaten by zellij's mouse
    /// reporting; only Shift+middle-click bypasses that).
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum TermAction {
        PasteClipboard,
        CopyClipboard,
        ZoomIn,
        ZoomOut,
        ZoomReset,
    }

    // GDK keyvals (gdk/gdkkeysyms.h): printable keys are their ASCII codes;
    // the rest are stable X11 keysyms.
    const KEY_INSERT: u32 = 0xff63;
    const KEY_KP_INSERT: u32 = 0xff9e;
    const KEY_KP_ADD: u32 = 0xffab;
    const KEY_KP_SUBTRACT: u32 = 0xffad;
    const KEY_KP_0: u32 = 0xffb0;

    /// Map a key chord to its terminal action — the conventional set every
    /// desktop terminal binds: Ctrl+Shift+V / Shift+Insert paste,
    /// Ctrl+Shift+C / Ctrl+Insert copy, Ctrl+±/0 zoom. Anything unmapped
    /// (notably plain Ctrl+C/Ctrl+V) falls through to the pty untouched.
    /// Pure — unit-tested.
    pub fn term_action_for_key(keyval: u32, ctrl: bool, shift: bool) -> Option<TermAction> {
        use TermAction::*;
        // With Shift held, letter keys report the UPPERCASE keyval; accept
        // both cases anyway (caps-lock inverts them).
        match keyval {
            k if ctrl && shift && (k == 'v' as u32 || k == 'V' as u32) => Some(PasteClipboard),
            KEY_INSERT | KEY_KP_INSERT if shift && !ctrl => Some(PasteClipboard),
            k if ctrl && shift && (k == 'c' as u32 || k == 'C' as u32) => Some(CopyClipboard),
            KEY_INSERT | KEY_KP_INSERT if ctrl && !shift => Some(CopyClipboard),
            // Ctrl+plus is Ctrl+Shift+equal on US layouts — accept both keyvals.
            k if ctrl && (k == '+' as u32 || k == '=' as u32 || k == KEY_KP_ADD) => Some(ZoomIn),
            k if ctrl && !shift && (k == '-' as u32 || k == KEY_KP_SUBTRACT) => Some(ZoomOut),
            k if ctrl && !shift && (k == '0' as u32 || k == KEY_KP_0) => Some(ZoomReset),
            _ => None,
        }
    }

    /// Zoom bounds + step (multiplicative, GNOME-Terminal-ish). Pure.
    pub fn next_font_scale(current: f64, action: TermAction) -> f64 {
        let next = match action {
            TermAction::ZoomIn => current * 1.1,
            TermAction::ZoomOut => current / 1.1,
            _ => 1.0,
        };
        next.clamp(0.25, 4.0)
    }

    /// Pack a live VTE terminal (hosting `command`) beside the webview inside
    /// the Tauri window's default GTK vbox: the vbox's last child (the
    /// webview) is re-parented into a GtkPaned with the terminal on the
    /// configured side. MUST run on the GTK main thread.
    pub fn embed_into_window(
        win: &gtk::ApplicationWindow,
        vbox: &gtk::Box,
        command: &[String],
        side: DockSide,
        fraction: f32,
        background: &str,
    ) -> Result<usize, String> {
        use glib::translate::ToGlibPtr;
        use gtk::prelude::*;

        let vte = lib().ok_or("libvte-2.91 (gtk3) is not loadable")?;
        // SAFETY: vte_terminal_new returns a floating GtkWidget*.
        let term_ptr = unsafe { (vte.terminal_new)() };
        if term_ptr.is_null() {
            return Err("vte_terminal_new returned null".into());
        }
        // SAFETY: the pointer is a valid GtkWidget; from_glib_none refs it.
        let term: gtk::Widget =
            unsafe { glib::translate::from_glib_none(term_ptr as *mut gtk::ffi::GtkWidget) };

        // Match the GUI theme (no visual seam — P-004's theming goal).
        if let (Some(set_colors), Some(bg)) = (vte.set_colors, parse_hex_rgba(background)) {
            let fg = GdkRgba {
                red: 0xe7 as f64 / 255.0,
                green: 0xf7 as f64 / 255.0,
                blue: 0xff as f64 / 255.0,
                alpha: 1.0,
            };
            // SAFETY: valid terminal pointer + stack GdkRGBAs; null palette is allowed.
            unsafe { set_colors(term_ptr, &fg, &bg, std::ptr::null(), 0) };
        }

        // The GTK tree surgery: tauri's default vbox is [optional menubar…,
        // webview]; re-parent the webview (the LAST child) into a paned with
        // the terminal on the configured side. The paned handle is the
        // user-draggable split (D-012 bidirectional, for free).
        let children = vbox.children();
        let webview = children
            .last()
            .cloned()
            .ok_or("tauri vbox has no children")?;
        vbox.remove(&webview);
        let orientation = match side {
            DockSide::Left | DockSide::Right => gtk::Orientation::Horizontal,
            DockSide::Top | DockSide::Bottom => gtk::Orientation::Vertical,
        };
        let paned = gtk::Paned::new(orientation);
        match side {
            DockSide::Left | DockSide::Top => {
                // resize=true on BOTH panes keeps allocations proportional on
                // window resize. shrink=true (WI-3388 — was false) lets the
                // divider go all the way to 0 for a full collapse-to-rail;
                // the drag itself is still bounded by the divider's own
                // clamp in the web UI (`<TerminalDivider>`), not by GTK.
                paned.pack1(&term, true, true);
                paned.pack2(&webview, true, true);
            }
            DockSide::Right | DockSide::Bottom => {
                paned.pack1(&webview, true, true);
                paned.pack2(&term, true, true);
            }
        }
        let total = match orientation {
            gtk::Orientation::Horizontal => win.allocated_width(),
            _ => win.allocated_height(),
        };
        paned.set_position(initial_split_position(side, total, fraction));
        vbox.pack_start(&paned, true, true, 0);
        paned.show_all();
        // Retained by the vbox container from here on — the raw pointer
        // stays valid for the window's lifetime; `apply_layout` re-wraps it
        // (from_glib_none) for each live divider/collapse update (WI-3388).
        let paned_stash: glib::translate::Stash<'_, *mut gtk::ffi::GtkPaned, gtk::Paned> =
            paned.to_glib_none();
        let paned_ptr: usize = paned_stash.0 as usize;

        // Drive the terminal grid from the widget allocation EXPLICITLY.
        // Inside this embedding VTE's automatic allocation→grid pipeline
        // misbehaves (it latches a boot-time height and keeps computing rows
        // against it — verified via the allocation tree, which is correct on
        // the GTK side), so on every size-allocate we compute cols/rows from
        // the live allocation + VTE's own cell metrics and force them with
        // vte_terminal_set_size (which also WINCHes the pty).
        if let (Some(set_size), Some(cw_fn), Some(ch_fn)) =
            (vte.set_size, vte.char_width, vte.char_height)
        {
            let term_addr = term_ptr as usize;
            term.connect_size_allocate(move |_w, alloc| {
                let t = term_addr as *mut c_void;
                // SAFETY: the VTE widget outlives the signal (it lives in the
                // window's tree for the process lifetime); calls are on the
                // GTK main thread.
                unsafe {
                    let (cw, ch) = ((cw_fn)(t), (ch_fn)(t));
                    if cw > 0 && ch > 0 {
                        let cols = (alloc.width() as i64 / cw).max(2);
                        let rows = (alloc.height() as i64 / ch).max(2);
                        set_size(t, cols, rows);
                    }
                }
            });
        }

        // Standard terminal shortcuts (see `term_action_for_key`): paste /
        // copy / zoom. Propagation::Stop on a hit so VTE doesn't ALSO feed
        // the chord to the pty.
        {
            let term_addr = term_ptr as usize;
            term.connect_key_press_event(move |w, ev| {
                let st = ev.state();
                let action = term_action_for_key(
                    *ev.keyval(),
                    st.contains(gtk::gdk::ModifierType::CONTROL_MASK),
                    st.contains(gtk::gdk::ModifierType::SHIFT_MASK),
                );
                let (Some(action), Some(vte)) = (action, lib()) else {
                    return glib::Propagation::Proceed;
                };
                let t = term_addr as *mut c_void;
                // SAFETY: the VTE widget outlives the signal (it lives in the
                // window's tree for the process lifetime); calls are on the
                // GTK main thread.
                unsafe {
                    match action {
                        TermAction::PasteClipboard => match vte.paste_clipboard {
                            Some(f) => f(t),
                            None => return glib::Propagation::Proceed,
                        },
                        TermAction::CopyClipboard => {
                            // No-op without a selection (VTE leaves the
                            // clipboard untouched), like every terminal.
                            match (vte.copy_clipboard_format, vte.copy_clipboard) {
                                (Some(f), _) => f(t, 1), // 1 = VTE_FORMAT_TEXT
                                (None, Some(f)) => f(t),
                                (None, None) => return glib::Propagation::Proceed,
                            }
                        }
                        TermAction::ZoomIn | TermAction::ZoomOut | TermAction::ZoomReset => {
                            let (Some(get), Some(set)) = (vte.get_font_scale, vte.set_font_scale)
                            else {
                                return glib::Propagation::Proceed;
                            };
                            set(t, next_font_scale(get(t), action));
                            // Re-drive the explicit grid (the size-allocate
                            // hook above won't fire — the allocation is
                            // unchanged, only the cell metrics moved).
                            if let (Some(set_size), Some(cw_fn), Some(ch_fn)) =
                                (vte.set_size, vte.char_width, vte.char_height)
                            {
                                let alloc = w.allocation();
                                let (cw, ch) = ((cw_fn)(t), (ch_fn)(t));
                                if cw > 0 && ch > 0 {
                                    let cols = (alloc.width() as i64 / cw).max(2);
                                    let rows = (alloc.height() as i64 / ch).max(2);
                                    set_size(t, cols, rows);
                                }
                            }
                        }
                    }
                }
                glib::Propagation::Stop
            });
        }

        // Host the chat dock (`pui chat` — P-013/D-011) in the terminal.
        // Spawned AFTER the widget is packed + shown: spawning into an
        // unrealized 80x24 default leaves the pty stuck at the boot-time grid
        // (zellij then paints a corner of the pane and never reflows).
        if command.is_empty() {
            return Err("empty terminal command".into());
        }
        let cstrs: Vec<CString> = command
            .iter()
            .map(|s| CString::new(s.as_str()).map_err(|e| e.to_string()))
            .collect::<Result<_, _>>()?;
        let mut argv: Vec<*const c_char> = cstrs.iter().map(|c| c.as_ptr()).collect();
        argv.push(std::ptr::null());
        // SAFETY: argv/cstrs outlive the call (vte copies them before forking);
        // null envv inherits ours; all callback pointers are optional per VTE docs.
        unsafe {
            (vte.spawn_async)(
                term_ptr,
                0, // VTE_PTY_DEFAULT
                std::ptr::null(),
                argv.as_ptr(),
                std::ptr::null(),
                G_SPAWN_SEARCH_PATH,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                -1,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
            );
        }
        Ok(paned_ptr)
    }

    /// Re-layout an already-embedded terminal paned to `layout` — the live
    /// divider-drag + collapse-to-rail apply (WI-3388). MUST run on the GTK
    /// main thread. `paned_ptr` is the raw `GtkPaned*` `embed_into_window`
    /// returned; it stays alive for the window's lifetime (held by the vbox
    /// container), so re-wrapping it here is safe.
    pub fn apply_layout(paned_ptr: usize, side: DockSide, layout: super::TerminalLayout) {
        use gtk::prelude::*;
        // SAFETY: see the doc comment above — the paned outlives this call.
        let paned: gtk::Paned =
            unsafe { glib::translate::from_glib_none(paned_ptr as *mut gtk::ffi::GtkPaned) };
        let total = match paned.orientation() {
            gtk::Orientation::Horizontal => paned.allocated_width(),
            _ => paned.allocated_height(),
        };
        let position = if layout.collapsed {
            match side {
                DockSide::Left | DockSide::Top => 0,
                DockSide::Right | DockSide::Bottom => total,
            }
        } else {
            initial_split_position(side, total, layout.fraction)
        };
        paned.set_position(position);
    }
}

// ───────────────────────────────────────────────────────────────────────────
// D-009 — macOS embedded native terminal VIEW (SwiftTerm)
//
// Mirrors the Linux VTE pattern one-to-one: the app OWNS the terminal — a
// real SwiftTerm LocalProcessTerminalView (CPU-native, accepted — D-005)
// attached INSIDE the Tauri window's content view, with the WKWebView shrunk
// to the right remainder (terminal left, GUI right — P-014). The Swift side
// lives in `macos-term-shim/` (a SwiftPM dylib exposing a C ABI), and is
// dlopen'd at RUNTIME — the shipped bundle takes no link-time dependency on
// Swift/SwiftTerm; when the dylib is absent the strategy downgrades to
// NewWindow, exactly like a missing libvte on Linux.
// ───────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub mod swiftterm_embed {
    use std::ffi::{c_char, c_void, CString};
    use std::sync::OnceLock;

    type FnAttachLeft = unsafe extern "C" fn(
        ns_window: *mut c_void,
        fraction: f64,
        min_px: f64,
        max_px: f64,
        exe: *const c_char,
        args_blob: *const c_char,
        args_len: i32,
    ) -> *mut c_void;

    /// WI-3388 live re-layout — see `pcterm_set_layout` in Shim.swift.
    type FnSetLayout = unsafe extern "C" fn(
        ns_window: *mut c_void,
        term: *mut c_void,
        fraction: f64,
        min_px: f64,
        max_px: f64,
        collapsed: bool,
    ) -> bool;

    struct Shim {
        _lib: libloading::Library,
        attach_left: FnAttachLeft,
        /// `None` on an older shim dylib built before WI-3388 — the divider/
        /// collapse just becomes a no-op rather than a load failure.
        set_layout: Option<FnSetLayout>,
    }
    // SAFETY: immutable after load; called only on the AppKit main thread.
    unsafe impl Send for Shim {}
    unsafe impl Sync for Shim {}

    /// Candidate dylib locations: the env override, then next to the
    /// executable (bundled), then the in-repo SwiftPM build output (dev).
    fn candidates() -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        if let Ok(p) = std::env::var("PAPERCUSP_TERM_SHIM") {
            if !p.trim().is_empty() {
                out.push(p.into());
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                out.push(dir.join("libPapercuspTermShim.dylib"));
                // Bundled app: the build drops the dylib into src-tauri/resources/,
                // which tauri-bundler ships under Contents/Resources (layout varies
                // by bundler version — probe both).
                out.push(dir.join("../Resources/resources/libPapercuspTermShim.dylib"));
                out.push(dir.join("../Resources/libPapercuspTermShim.dylib"));
                // cargo target/<profile>/ → the repo's src-tauri/, where the
                // SwiftPM package builds its release output (dev workflow).
                out.push(
                    dir.join("../../macos-term-shim/.build/release/libPapercuspTermShim.dylib"),
                );
            }
        }
        out
    }

    fn lib() -> Option<&'static Shim> {
        static LIB: OnceLock<Option<Shim>> = OnceLock::new();
        LIB.get_or_init(|| {
            for path in candidates() {
                if !path.exists() {
                    continue;
                }
                // SAFETY: dlopen of our own shim; we only resolve C symbols.
                let l = match unsafe { libloading::Library::new(&path) } {
                    Ok(l) => l,
                    Err(_) => continue,
                };
                unsafe {
                    let attach_left = match l.get::<FnAttachLeft>(b"pcterm_attach_left\0") {
                        Ok(s) => *s,
                        Err(_) => continue,
                    };
                    let set_layout = l
                        .get::<FnSetLayout>(b"pcterm_set_layout\0")
                        .ok()
                        .map(|s| *s);
                    return Some(Shim {
                        attach_left,
                        set_layout,
                        _lib: l,
                    });
                }
            }
            None
        })
        .as_ref()
    }

    /// Whether the runtime shim dylib is present + loadable. Drives the
    /// strategy downgrade: no shim → NewWindow fallback.
    pub fn available() -> bool {
        lib().is_some()
    }

    /// Make the bundled chat-dock binaries (`pui`, `zellij`) discoverable and
    /// point `pui` at the bundled companion plugin BEFORE the shim spawns
    /// `pui chat`. The SwiftTerm child inherits THIS process's environment (the
    /// shim's C ABI carries no env), so we prepend the bundled `sidecar/bin` to
    /// PATH and set PUI_COMPANION_WASM here. Without this the dock is a blank
    /// pane in a packaged app (nothing is on PATH). Once-guarded + idempotent;
    /// a no-op in a dev/unbundled layout where the files aren't found.
    /// (chat-dock bundling, WI-668.)
    fn prepare_dock_env() {
        use std::sync::Once;
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            let Ok(exe) = std::env::current_exe() else {
                return;
            };
            let Some(dir) = exe.parent() else { return };
            // Bundled mac layout: Contents/MacOS/<exe> → Contents/Resources/sidecar.
            let sidecar = dir.join("../Resources/sidecar");
            if let Ok(bin) = sidecar.join("bin").canonicalize() {
                let cur = std::env::var("PATH").unwrap_or_default();
                std::env::set_var("PATH", format!("{}:{}", bin.display(), cur));
            }
            if std::env::var_os("PUI_COMPANION_WASM").is_none() {
                if let Ok(wasm) = sidecar.join("pui-companion.wasm").canonicalize() {
                    std::env::set_var("PUI_COMPANION_WASM", wasm);
                }
            }
        });
    }

    /// Absolute path to a bundled dock binary
    /// (Contents/Resources/sidecar/bin/<name>), canonicalized. None in a
    /// dev/unbundled layout. SwiftTerm's startProcess posix_spawns the
    /// executable WITHOUT a PATH search, so the dock command's bare "pui" must
    /// be resolved to an absolute path or it fails silently → blank pane.
    /// (zellij — which pui launches itself — is found via the PATH that
    /// prepare_dock_env sets, since pui inherits the forwarded env.)
    fn dock_bin_path(name: &str) -> Option<String> {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        let p = dir
            .join("../Resources/sidecar/bin")
            .join(name)
            .canonicalize()
            .ok()?;
        Some(p.to_string_lossy().into_owned())
    }

    /// Attach the terminal (hosting `command`) to the left `fraction` of the
    /// Tauri window. `ns_window` is tauri's raw NSWindow pointer. MUST run on
    /// the AppKit main thread.
    pub fn embed_into_window(
        ns_window: *mut c_void,
        command: &[String],
        fraction: f32,
        min_px: i32,
        max_px: i32,
    ) -> Result<usize, String> {
        prepare_dock_env();
        // SwiftTerm posix_spawns the exe with NO PATH search → resolve a bare
        // "pui" to its bundled absolute path (else startProcess fails silently
        // and the pane stays blank). Other commands pass through unchanged.
        let owned: Vec<String>;
        let command: &[String] = match command.first() {
            Some(first) if first == "pui" => match dock_bin_path("pui") {
                Some(abs) => {
                    owned = std::iter::once(abs)
                        .chain(command.iter().skip(1).cloned())
                        .collect();
                    &owned
                }
                None => command,
            },
            _ => command,
        };
        let shim = lib().ok_or("PapercuspTermShim dylib not loadable")?;
        let (exe, rest) = command.split_first().ok_or("empty terminal command")?;
        let exe_c = CString::new(exe.as_str()).map_err(|e| e.to_string())?;
        // NUL-separated argv tail (the shim splits on NUL).
        let blob: Vec<u8> = rest
            .iter()
            .flat_map(|a| a.as_bytes().iter().copied().chain(std::iter::once(0u8)))
            .collect();
        // SAFETY: pointers outlive the call; the shim copies what it keeps.
        let handle = unsafe {
            (shim.attach_left)(
                ns_window,
                fraction as f64,
                min_px as f64,
                max_px as f64,
                exe_c.as_ptr(),
                blob.as_ptr() as *const std::ffi::c_char,
                blob.len() as i32,
            )
        };
        if handle.is_null() {
            return Err("pcterm_attach_left returned null".into());
        }
        // Kept (was previously discarded) so `set_layout` can re-layout this
        // exact terminal view later — the shim's retained pointer IS the
        // handle a live divider-drag/collapse re-targets (WI-3388).
        Ok(handle as usize)
    }

    /// Re-layout an already-attached terminal to `layout` — the live
    /// divider-drag + collapse-to-rail apply (WI-3388). MUST run on the
    /// AppKit main thread. A no-op (`Ok(())`) on a shim dylib built before
    /// this landed (`set_layout` unresolved) rather than an error, so an
    /// unrebuilt dev shim doesn't break the terminal — just the resize.
    pub fn set_layout(
        ns_window: *mut c_void,
        term_handle: usize,
        fraction: f32,
        min_px: i32,
        max_px: i32,
        collapsed: bool,
    ) -> Result<(), String> {
        let shim = lib().ok_or("PapercuspTermShim dylib not loadable")?;
        let Some(set_layout) = shim.set_layout else {
            return Ok(());
        };
        // SAFETY: ns_window/term_handle are the live pointers `embed_into_window`
        // returned for this session; the shim only reads them for this call.
        let ok = unsafe {
            set_layout(
                ns_window,
                term_handle as *mut c_void,
                fraction as f64,
                min_px as f64,
                max_px as f64,
                collapsed,
            )
        };
        if ok {
            Ok(())
        } else {
            Err("pcterm_set_layout returned false (stale window/terminal handle)".into())
        }
    }
}

#[cfg(target_os = "macos")]
impl NativeTerminal {
    /// Remember the (NSWindow*, retained LocalProcessTerminalView*) handle
    /// pair (WI-3388) so a later `set_layout` can re-layout it live without
    /// re-attaching. Set once, right after a successful
    /// `swiftterm_embed::embed_into_window`.
    pub fn set_swiftterm_handle(&self, ns_window: usize, term: usize) {
        *self.swiftterm_handle.lock().unwrap() = Some((ns_window, term));
    }

    pub fn swiftterm_handle(&self) -> Option<(usize, usize)> {
        *self.swiftterm_handle.lock().unwrap()
    }
}

// ───────────────────────────────────────────────────────────────────────────
// D-009 — Windows embedded terminal — UNVERIFIED SPIKE (glued-child conhost)
//
// The idea: Win32 (unlike Wayland) lets you SetParent a FOREIGN top-level
// window, so this spawns the console window (conhost hosting the chat dock,
// ConPTY-backed) and re-parents it as a left-band CHILD of the Tauri window,
// WebView2 shrunk right.
//
// ⚠ STATUS (verified 2026-06-06 in the Windows VM): this COMPILES and the
// Win32 calls (SetParent/MoveWindow) return Ok, but the embed is NOT visually
// confirmed — and conhost windows are a known special case: csrss owns their
// painting and they famously resist re-parenting (SetParent can succeed while
// the window stays effectively top-level / fails to render inside the parent).
// A window-tree probe of a running instance could not confirm the console as a
// genuine child. So this path is gated FORCE-ONLY
// (PAPERCUSP_NATIVE_TERMINAL_FORCE=embedded-conpty); the Windows DEFAULT stays
// NewWindow (a real terminal in its own window — see downgrade_unbuilt_with,
// which never keeps ConPty). The KNOWN-CORRECT Windows embed is a ConPTY
// PSEUDOCONSOLE (CreatePseudoConsole) feeding a CUSTOM terminal renderer — the
// same tier of work as building a terminal widget, deferred. This spike is
// kept (compiles, seam wired) so that build drops into the EmbeddedView arm
// without rework.
// ───────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub mod win_embed {
    use std::ffi::c_void;
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GetClassNameW, GetClientRect, GetWindowThreadProcessId,
        MoveWindow, SetParent, SetWindowLongPtrW, GWL_STYLE, WS_CHILD, WS_VISIBLE,
    };

    /// First top-level window owned by `pid` (the spawned console).
    fn find_toplevel_by_pid(pid: u32) -> Option<HWND> {
        struct Ctx {
            pid: u32,
            found: Option<HWND>,
        }
        unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let ctx = unsafe { &mut *(lparam.0 as *mut Ctx) };
            let mut wpid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut wpid)) };
            if wpid == ctx.pid {
                ctx.found = Some(hwnd);
                return BOOL(0); // stop enumerating
            }
            BOOL(1)
        }
        let mut ctx = Ctx { pid, found: None };
        unsafe {
            let _ = EnumWindows(Some(cb), LPARAM(&mut ctx as *mut Ctx as isize));
        }
        ctx.found
    }

    /// The WebView2 host child of the Tauri window (class `Chrome_WidgetWin_*`).
    fn find_webview_child(parent: HWND) -> Option<HWND> {
        struct Ctx {
            found: Option<HWND>,
        }
        unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let ctx = unsafe { &mut *(lparam.0 as *mut Ctx) };
            let mut name = [0u16; 64];
            let n = unsafe { GetClassNameW(hwnd, &mut name) };
            let cls = String::from_utf16_lossy(&name[..n.max(0) as usize]);
            if cls.starts_with("Chrome_WidgetWin") {
                ctx.found = Some(hwnd);
                return BOOL(0);
            }
            BOOL(1)
        }
        let mut ctx = Ctx { found: None };
        unsafe {
            let _ = EnumChildWindows(parent, Some(cb), LPARAM(&mut ctx as *mut Ctx as isize));
        }
        ctx.found
    }

    /// (console pid — for shutdown kill, term HWND, webview HWND) — the
    /// handles WI-3388's `set_layout` re-targets on a live divider drag or
    /// collapse, so the caller doesn't have to re-resolve them.
    pub struct EmbedHandles {
        pub pid: u32,
        pub term_hwnd: isize,
        pub webview_hwnd: Option<isize>,
    }

    /// Spawn the console hosting `command`, wait for its window, glue it as a
    /// left-band CHILD of `tauri_hwnd` and shrink the WebView2 child to the
    /// remainder. Returns the resolved handles (for shutdown kill + a later
    /// `set_layout`).
    pub fn embed_into_window(
        tauri_hwnd: *mut c_void,
        command: &[String],
        fraction: f32,
        min_px: i32,
        max_px: i32,
    ) -> Result<EmbedHandles, String> {
        let parent = HWND(tauri_hwnd);
        let (exe, rest) = command.split_first().ok_or("empty terminal command")?;
        // CREATE_NEW_CONSOLE → the child gets its OWN (ConPTY-backed) console
        // window — the thing we reparent.
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let child = std::process::Command::new(exe)
            .args(rest)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("spawn {exe}: {e}"))?;
        let pid = child.id();

        // The console window maps asynchronously — poll for it (~5s).
        let mut hwnd = None;
        for _ in 0..50 {
            if let Some(h) = find_toplevel_by_pid(pid) {
                hwnd = Some(h);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let term = hwnd.ok_or("console window never appeared")?;

        let mut rc = RECT::default();
        unsafe { GetClientRect(parent, &mut rc) }.map_err(|e| e.to_string())?;
        let w = rc.right - rc.left;
        let h = rc.bottom - rc.top;
        let extent = ((w as f32 * fraction) as i32)
            .clamp(min_px.min(max_px), max_px.max(min_px))
            .min(w - 50);

        let webview = find_webview_child(parent);
        unsafe {
            // Child style BEFORE SetParent (Win32 docs ordering).
            SetWindowLongPtrW(term, GWL_STYLE, (WS_CHILD.0 | WS_VISIBLE.0) as isize);
            SetParent(term, parent).map_err(|e| format!("SetParent: {e}"))?;
            let _ = MoveWindow(term, 0, 0, extent, h, true);
            if let Some(webview) = webview {
                let _ = MoveWindow(webview, extent, 0, w - extent, h, true);
            }
        }
        Ok(EmbedHandles {
            pid,
            term_hwnd: term.0 as isize,
            webview_hwnd: webview.map(|w| w.0 as isize),
        })
    }

    /// Re-layout the glued console + WebView2 child to `layout` — the live
    /// divider-drag + collapse-to-rail apply (WI-3388). `collapsed` moves the
    /// console off-screen-width (0 extent) and grows the webview to fill;
    /// restoring resolves a fresh extent from `fraction`. UNVERIFIED like the
    /// rest of this spike (no Windows box to confirm the console actually
    /// paints — see the module doc) — code-complete, ships gated the same as
    /// the base embed.
    pub fn set_layout(
        parent_hwnd: *mut c_void,
        term_hwnd: isize,
        webview_hwnd: Option<isize>,
        fraction: f32,
        min_px: i32,
        max_px: i32,
        collapsed: bool,
    ) -> Result<(), String> {
        let parent = HWND(parent_hwnd);
        let term = HWND(term_hwnd as *mut c_void);
        let mut rc = RECT::default();
        unsafe { GetClientRect(parent, &mut rc) }.map_err(|e| e.to_string())?;
        let w = rc.right - rc.left;
        let h = rc.bottom - rc.top;
        let extent = if collapsed {
            0
        } else {
            ((w as f32 * fraction) as i32)
                .clamp(min_px.min(max_px), max_px.max(min_px))
                .min(w - 50)
        };
        unsafe {
            let _ = MoveWindow(term, 0, 0, extent, h, true);
            if let Some(webview_hwnd) = webview_hwnd {
                let webview = HWND(webview_hwnd as *mut c_void);
                let _ = MoveWindow(webview, extent, 0, (w - extent).max(1), h, true);
            }
        }
        Ok(())
    }
}

// ───────────────────────────────────────────────────────────────────────────
// WI-4448 — the WINDOWS chat dock (`pui chat` = zellij), inside WSL.
//
// Windows had NO dock at all: `select_strategy` picks EmbeddedView(ConPty),
// the ConPTY embed is an unverified force-only spike, and the NewWindow
// fallback was Linux-only — so Windows fell through to `Disabled`.
//
// It does not need the ConPTY renderer to exist. Windows already runs the whole
// agent runtime inside the `papercup-runtime` WSL2 distro (wsl_setup.rs: "the
// harness stack assumes POSIX"), and zellij/pui/psu are Linux binaries that run
// there natively. So the dock launches as a REAL zellij session in its own
// Windows Terminal window. That is the "or an equivalent" half of the ask — not
// the glued/embedded look Linux-X11 and macOS get; earning that means writing
// the ConPTY pseudoconsole renderer (see win_embed's module doc).
//
// The bundled dock binaries live on the WINDOWS side (`sidecar/bin`), and the
// distro deliberately does NOT inherit the Windows PATH (build-rootfs.sh sets
// `appendWindowsPath=false`), so the launcher hands the distro its own
// PATH-translated view of them. Verified live on the Win11 QEMU VM: zellij
// 0.44.3 execs straight off `/mnt/c`, and `pui` renders its TUI there once the
// distro carries libasound.so.2 (the other half of WI-4448).
// ───────────────────────────────────────────────────────────────────────────

/// Single-quote `s` for bash. The dock's paths routinely contain spaces
/// (`/mnt/c/Program Files/Papercusp GUI/...`), so nothing here may go unquoted.
///
/// Gated to Windows + `test` (the `windows_path_to_wsl` pattern): the only
/// production caller is the Windows launcher, so an ungated build on the Linux
/// dev box would warn dead_code — but the tests below must still exercise it
/// there, which is the whole point of keeping it pure.
#[cfg(any(target_os = "windows", test))]
fn sh_squote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Build the bash one-liner the Windows dock runs INSIDE the distro.
///
/// Pure + platform-free so it is unit-testable on the Linux dev box (the Windows
/// launcher below can only be exercised on a Windows host, and an untested
/// command builder is exactly where the quoting bugs live).
///
/// `exec` replaces the shell so the window's process IS the dock — no stray
/// parent shell to leak, and closing the window takes zellij down with it.
#[cfg(any(target_os = "windows", test))]
fn wsl_dock_oneliner(
    dock_bin_wsl: Option<&str>,
    companion_wasm_wsl: Option<&str>,
    argv: &[String],
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(bin) = dock_bin_wsl {
        // PREPEND: the bundled pui/zellij must win over anything the distro
        // happens to carry, so the dock always runs the versions we shipped
        // (zellij's plugin API is version-coupled to the companion wasm).
        parts.push(format!("export PATH={}:\"$PATH\"", sh_squote(bin)));
    }
    if let Some(wasm) = companion_wasm_wsl {
        parts.push(format!("export PUI_COMPANION_WASM={}", sh_squote(wasm)));
    }
    let cmd = argv
        .iter()
        .map(|a| sh_squote(a))
        .collect::<Vec<_>>()
        .join(" ");
    parts.push(format!("exec {cmd}"));
    parts.join("; ")
}

#[cfg(target_os = "windows")]
impl NativeTerminal {
    pub fn launch_glued(&self) -> Result<(), String> {
        Err("glued terminal is X11-only".into())
    }

    /// Open the chat dock in its own Windows Terminal window, hosted in the
    /// papercup-runtime WSL distro. Idempotent: a live dock is left alone.
    pub fn launch_new_window(&self) -> Result<(), String> {
        let mut guard = self.live.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Ok(());
        }
        // Reuse the dock spec so PAPERCUSP_NATIVE_TERMINAL_CMD still overrides
        // the hosted command on Windows exactly as it does on Linux/macOS.
        let spec = GhosttySpec::dock();
        // prepare_dock_env (main.rs) resolves the bundled sidecar dir from Tauri's
        // Resource resolver and exports these as WINDOWS paths; the distro needs the
        // /mnt/... view of them.
        let to_wsl = |key: &str| -> Option<String> {
            std::env::var_os(key)
                .map(|v| crate::windows_path_to_wsl(std::path::Path::new(&v)))
                .filter(|s| !s.is_empty())
        };
        let oneliner = wsl_dock_oneliner(
            to_wsl("PAPERCUSP_DOCK_BIN").as_deref(),
            to_wsl("PUI_COMPANION_WASM").as_deref(),
            &spec.command,
        );
        let pid = crate::native_console::spawn_windows_dock_window(&oneliner)
            .map_err(|e| format!("spawn windows chat dock: {e}"))?;
        println!(
            "[papercusp-desktop] native-terminal: windows chat dock launched (wt/conhost pid={pid:?}) hosting {:?} in WSL",
            spec.command
        );
        // Deliberately NOT tracked in `self.live`: the spawner returns the
        // wt.exe/conhost PID, and on Windows that process is only the WINDOW —
        // the dock itself is a WSL-side process tree with no Win32 ancestor
        // (the same pid→window gap native_console documents, which is why it
        // finds its windows by TITLE). Killing the launcher pid would not
        // reliably take the dock down, so shutdown stays a no-op and pui's own
        // `reap_stale` kills any leftover zellij session on the next launch.
        let _ = &mut *guard;
        Ok(())
    }

    pub fn run_glue_loop(&self) {}
    pub fn shutdown(&self) {}
}

#[cfg(target_os = "windows")]
impl NativeTerminal {
    /// Remember the (parent, term, webview) HWNDs (WI-3388) so a later
    /// `set_layout` can re-layout without re-resolving the window tree. Set
    /// once, right after a successful `win_embed::embed_into_window`.
    pub fn set_win_handles(&self, parent: isize, term: isize, webview: Option<isize>) {
        *self.win_handles.lock().unwrap() = Some((parent, term, webview.unwrap_or(0)));
    }

    /// (parent, term, webview) — webview is 0 when it was never resolved
    /// (treat as "no webview HWND to move", matching the embed's own
    /// `Option`).
    pub fn win_handles(&self) -> Option<(isize, isize, isize)> {
        *self.win_handles.lock().unwrap()
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Launch + glue driving (Linux). Called from main.rs's setup() + window-event
// hook. Non-Linux builds compile these as no-ops so the call sites stay clean.
// ───────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
impl NativeTerminal {
    /// Remember the embedded VTE paned handle (WI-3388) so a later
    /// `set_layout` can re-layout it live without re-attaching. Set once,
    /// right after a successful `vte_embed::embed_into_window`.
    pub fn set_vte_paned(&self, paned_ptr: usize, side: DockSide) {
        *self.vte_paned.lock().unwrap() = Some((paned_ptr, side));
    }

    pub fn vte_paned(&self) -> Option<(usize, DockSide)> {
        *self.vte_paned.lock().unwrap()
    }

    /// Spawn the borderless Ghostty sibling hosting the chat dock (`pui chat`,
    /// P-013 / D-011). Idempotent
    /// — a no-op if already running. The X11 window is resolved + first-glued
    /// separately via `poll_resolve_window` + the steady glue loop (off the
    /// setup thread) so launch never blocks on the window mapping.
    pub fn launch_glued(&self) -> Result<(), String> {
        if !matches!(self.strategy, TerminalStrategy::GluedGhosttyX11) {
            return Err(format!(
                "launch_glued called for non-glued strategy {}",
                self.strategy.label()
            ));
        }
        let mut guard = self.live.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Ok(());
        }
        let spec = GhosttySpec::dock();
        // The shared app identity is the bundle id `com.papercusp.desktop`
        // (GhosttySpec default / PAPERCUSP_NATIVE_TERMINAL_CLASS). The Tauri
        // window exposes no _GTK_APPLICATION_ID and its WM_CLASS *class*
        // ("Papercusp-desktop") isn't a valid GTK app-id, so there's nothing to
        // copy at runtime; perfect taskbar grouping is a packaging concern (the
        // bundle's .desktop StartupWMClass), not something we can force here.
        let mut cmd = std::process::Command::new(&spec.bin);
        cmd.args(spec.argv());
        // Detach stdio: a chatty terminal shouldn't spam the desktop's logs,
        // and closing the desktop's own stdout shouldn't ripple in.
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let child = cmd
            .spawn()
            .map_err(|e| format!("spawn ghostty ({}): {e}", spec.bin))?;
        println!(
            "[papercusp-desktop] native-terminal: spawned ghostty pid={} class={} hosting {:?}",
            child.id(),
            spec.class,
            spec.command
        );
        *guard = Some(Live { child });
        Ok(())
    }

    /// The steady glue loop — run on a dedicated thread. Establishes one
    /// persistent X11 connection (`GlueSession`), resolves the sibling + GUI
    /// windows, raises the sibling once, then re-pins it to the GUI window every
    /// ~150ms until the terminal is shut down. A persistent connection is what
    /// makes tracking instant: a fresh connect per tick is too slow under Xvfb.
    pub fn run_glue_loop(&self) {
        if !matches!(self.strategy, TerminalStrategy::GluedGhosttyX11) {
            return;
        }
        let Some(gpid) = self.ghostty_pid() else {
            return;
        };
        let mut sess = match x11_glue::GlueSession::connect(gpid, std::process::id(), &self.config)
        {
            Some(s) => s,
            None => {
                println!(
                    "[papercusp-desktop] native-terminal: could not establish X11 glue session for pid={gpid}"
                );
                return;
            }
        };
        println!(
            "[papercusp-desktop] native-terminal: glued window 0x{:x}",
            sess.sibling()
        );
        sess.raise();
        // P-005 grouping: one taskbar/alt-tab entry for the pair (the GUI).
        sess.apply_skip_taskbar();
        let debug = std::env::var("PAPERCUSP_NATIVE_TERMINAL_DEBUG").is_ok();
        let mut tick: u32 = 0;
        loop {
            if !self.is_running() {
                break;
            }
            // P-005 minimize follow — while the GUI is iconified the sibling
            // is too; skip the geometry/focus ticks (don't fight the WM over
            // an iconified pair).
            if sess.minimize_tick() {
                std::thread::sleep(std::time::Duration::from_millis(150));
                continue;
            }
            // Warmup re-asserts the placement for the first ~2s so we win
            // ghostty applying its own initial geometry after we placed it.
            let layout = *self.layout.lock().unwrap();
            if let Some((t, changed, drifted)) = sess.tick(tick < 12, layout) {
                if debug {
                    println!(
                        "[nt-debug] move -> ({},{},{},{}) changed={changed} drifted={drifted}",
                        t.x, t.y, t.w, t.h
                    );
                }
            }
            // P-005 focus share: focusing either window surfaces the pair.
            sess.focus_tick();
            tick = tick.saturating_add(1);
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }

    /// Interim cross-platform fallback (Wayland today): launch the chat dock
    /// (`pui chat`) in a real native terminal window — decorated, normal, NOT
    /// glued. Still a fully native terminal; it just isn't pinned to the GUI
    /// window (foreign positioning is forbidden off X11). Replaced per-OS by
    /// the embedded views.
    pub fn launch_new_window(&self) -> Result<(), String> {
        let mut guard = self.live.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Ok(());
        }
        let spec = GhosttySpec::dock();
        // Same hosted command + shared class (so taskbars still group it), but
        // keep decorations + skip the glue knobs.
        let mut argv = vec![format!("--class={}", spec.class)];
        if !spec.background.is_empty() {
            argv.push(format!("--background={}", spec.background));
        }
        argv.extend(["--gtk-single-instance=false".to_string(), "-e".to_string()]);
        argv.extend(spec.command.iter().cloned());
        let mut cmd = std::process::Command::new(&spec.bin);
        cmd.args(argv);
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let child = cmd
            .spawn()
            .map_err(|e| format!("spawn ghostty new-window ({}): {e}", spec.bin))?;
        println!(
            "[papercusp-desktop] native-terminal: new-window ghostty pid={} hosting {:?}",
            child.id(),
            spec.command
        );
        *guard = Some(Live { child });
        Ok(())
    }

    /// Kill the sibling on shutdown: SIGTERM with a short grace, then
    /// SIGKILL (P-057). The old straight `Child::kill()` was SIGKILL despite
    /// the doc claiming a clean end — the hosted zellij/pui never got to run
    /// its exit handlers, leaving stale zellij sessions/sockets behind.
    pub fn shutdown(&self) {
        // Poison recovery: a panicked glue/launch thread must not make
        // shutdown silently skip the kill and orphan the terminal.
        let mut guard = self
            .live
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(mut live) = guard.take() {
            let pid = live.child.id();
            println!(
                "[papercusp-desktop] native-terminal: terminating ghostty pid={pid} (SIGTERM, 2s grace)"
            );
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2000);
            while std::time::Instant::now() < deadline {
                match live.child.try_wait() {
                    Ok(Some(_status)) => return,
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            let _ = live.child.kill();
            let _ = live.child.wait();
        }
    }
}

// macOS: the glued path is X11-only and the new-window launcher is ghostty
// (Linux). macOS gets its dock from the SwiftTerm embedded view, so these stay
// no-ops and main.rs call sites stay platform-free. Windows is NOT in this set
// any more — it has a real `launch_new_window` (the WSL chat dock, WI-4448).
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
impl NativeTerminal {
    pub fn launch_glued(&self) -> Result<(), String> {
        Err("glued terminal is X11-only".into())
    }
    pub fn launch_new_window(&self) -> Result<(), String> {
        Err("new-window terminal launcher is implemented on Linux only".into())
    }
    pub fn run_glue_loop(&self) {}
    pub fn shutdown(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── D-004 (operator-chat-sidebar-revival P-014/P-015): the TESTING gate ─

    /// The dock gate must default CLOSED: FLAGS.TESTING is parked/off, and
    /// the webview relay is the ONLY thing that opens it. A default-open gate
    /// would spawn the dock at boot before flags load — exactly the behavior
    /// D-004 retires. (The boot callsite no longer spawns at all; both spawn
    /// paths — `native_terminal_set_enabled` and `native_terminal_toggle` —
    /// check this gate first.)
    #[test]
    fn dock_gate_defaults_closed_no_spawn() {
        let nt = NativeTerminal::new(TerminalStrategy::Disabled);
        assert!(
            !nt.gate_enabled(),
            "gate must default CLOSED (flag-off ⇒ no dock spawn)"
        );
        assert!(!nt.is_running());
    }

    /// The webview relay opens/closes the gate; both transitions must stick
    /// (a live /admin/features flip re-relays without an app restart).
    #[test]
    fn dock_gate_relay_round_trips() {
        let nt = NativeTerminal::new(TerminalStrategy::Disabled);
        nt.set_gate_enabled(true);
        assert!(nt.gate_enabled());
        nt.set_gate_enabled(false);
        assert!(!nt.gate_enabled());
    }

    // ── WI-4448: the Windows chat dock ─────────────────────────────────────

    /// The bundled dock dir is `.../Papercusp GUI/sidecar/bin` — it ALWAYS has a
    /// space in it. Unquoted, bash would split it and the dock would launch with
    /// a truncated PATH (and silently fall back to whatever `pui` it could find,
    /// or none). This is the single most likely way this launcher breaks.
    #[test]
    fn dock_oneliner_quotes_paths_containing_spaces() {
        let got = wsl_dock_oneliner(
            Some("/mnt/c/Program Files/Papercusp GUI/sidecar/bin"),
            Some("/mnt/c/Program Files/Papercusp GUI/sidecar/pui-companion.wasm"),
            &["pui".to_string(), "chat".to_string()],
        );
        assert_eq!(
            got,
            "export PATH='/mnt/c/Program Files/Papercusp GUI/sidecar/bin':\"$PATH\"; \
             export PUI_COMPANION_WASM='/mnt/c/Program Files/Papercusp GUI/sidecar/pui-companion.wasm'; \
             exec 'pui' 'chat'"
        );
    }

    /// The bundled binaries must WIN over anything the distro carries: zellij's
    /// plugin API is version-coupled to the companion wasm we ship, so a distro
    /// zellij taking precedence would load an incompatible plugin.
    #[test]
    fn dock_oneliner_prepends_bundled_bin_to_path() {
        let got = wsl_dock_oneliner(Some("/mnt/c/app/bin"), None, &["pui".to_string()]);
        assert!(
            got.starts_with("export PATH='/mnt/c/app/bin':\"$PATH\""),
            "bundled bin must be PREPENDED, got: {got}"
        );
        assert!(!got.contains("PUI_COMPANION_WASM"));
    }

    /// An unbundled/dev layout resolves neither path — the dock must still be
    /// launchable (falling back to whatever `pui` is on the distro PATH) rather
    /// than emitting `export PATH=:"$PATH"` and poisoning it.
    #[test]
    fn dock_oneliner_omits_unresolved_paths_entirely() {
        let got = wsl_dock_oneliner(None, None, &["pui".to_string(), "chat".to_string()]);
        assert_eq!(got, "exec 'pui' 'chat'");
    }

    #[test]
    fn sh_squote_escapes_embedded_single_quotes() {
        assert_eq!(sh_squote("it's"), r#"'it'\''s'"#);
    }

    /// The bug itself: before WI-4448 Windows selected EmbeddedView(ConPty),
    /// found the spike unavailable, and — because the NewWindow fallback was
    /// Linux-only — landed on Disabled, i.e. NO dock at all. It must now reach
    /// NewWindow.
    #[test]
    fn windows_conpty_downgrades_to_new_window_not_disabled() {
        let got = downgrade_unbuilt_with(
            TerminalStrategy::EmbeddedView(EmbedBackend::ConPty),
            false, // no VTE (not Linux)
            false, // no SwiftTerm (not macOS)
            true,  // Windows now HAS a new-window launcher
        );
        assert_eq!(got, TerminalStrategy::NewWindow);
    }

    /// Guard the regression in the other direction: a platform with no embedded
    /// backend AND no new-window launcher must still resolve to Disabled rather
    /// than a strategy whose launcher would hard-error on every boot.
    #[test]
    fn embedded_without_any_launcher_still_disables() {
        let got = downgrade_unbuilt_with(
            TerminalStrategy::EmbeddedView(EmbedBackend::ConPty),
            false,
            false,
            false,
        );
        assert_eq!(got, TerminalStrategy::Disabled);
    }

    // ── P-001 detection ────────────────────────────────────────────────────

    #[test]
    fn display_server_prefers_xdg_session_type() {
        assert_eq!(
            detect_display_server(Some("wayland"), None, Some(":0")),
            DisplayServer::Wayland
        );
        assert_eq!(
            detect_display_server(Some("x11"), Some("wayland-0"), Some(":0")),
            DisplayServer::X11
        );
        // Case + whitespace tolerant.
        assert_eq!(
            detect_display_server(Some(" X11 "), None, None),
            DisplayServer::X11
        );
    }

    #[test]
    fn display_server_falls_back_to_var_presence() {
        assert_eq!(
            detect_display_server(None, Some("wayland-0"), Some(":0")),
            DisplayServer::Wayland
        );
        assert_eq!(
            detect_display_server(None, None, Some(":0")),
            DisplayServer::X11
        );
        assert_eq!(
            detect_display_server(None, Some(""), Some("")),
            DisplayServer::None
        );
        assert_eq!(
            detect_display_server(Some("tty"), None, None),
            DisplayServer::None
        );
    }

    #[test]
    fn strategy_routes_per_os_and_display() {
        assert_eq!(
            select_strategy(SessionInfo {
                os: Os::Linux,
                display: DisplayServer::X11
            }),
            TerminalStrategy::GluedGhosttyX11
        );
        assert_eq!(
            select_strategy(SessionInfo {
                os: Os::Linux,
                display: DisplayServer::Wayland
            }),
            TerminalStrategy::EmbeddedView(EmbedBackend::Vte)
        );
        assert_eq!(
            select_strategy(SessionInfo {
                os: Os::Linux,
                display: DisplayServer::None
            }),
            TerminalStrategy::Disabled
        );
        assert_eq!(
            select_strategy(SessionInfo {
                os: Os::Mac,
                display: DisplayServer::None
            }),
            TerminalStrategy::EmbeddedView(EmbedBackend::SwiftTerm)
        );
        assert_eq!(
            select_strategy(SessionInfo {
                os: Os::Windows,
                display: DisplayServer::None
            }),
            TerminalStrategy::EmbeddedView(EmbedBackend::ConPty)
        );
    }

    #[test]
    fn unbuilt_embedded_views_downgrade_to_new_window() {
        // D-009: the Linux VTE + macOS SwiftTerm embeds are BUILT — each
        // survives whenever its runtime library/shim is loadable, and
        // downgrades only when it isn't.
        assert_eq!(
            downgrade_unbuilt_with(
                TerminalStrategy::EmbeddedView(EmbedBackend::Vte),
                true,
                false,
                true
            ),
            TerminalStrategy::EmbeddedView(EmbedBackend::Vte)
        );
        assert_eq!(
            downgrade_unbuilt_with(
                TerminalStrategy::EmbeddedView(EmbedBackend::Vte),
                false,
                false,
                true
            ),
            TerminalStrategy::NewWindow
        );
        assert_eq!(
            downgrade_unbuilt_with(
                TerminalStrategy::EmbeddedView(EmbedBackend::SwiftTerm),
                false,
                true,
                false
            ),
            TerminalStrategy::EmbeddedView(EmbedBackend::SwiftTerm)
        );
        // SwiftTerm shim missing on mac: NewWindow is Linux-only, so Disabled
        // (a guaranteed-to-fail launcher must not run at every boot — P-020).
        assert_eq!(
            downgrade_unbuilt_with(
                TerminalStrategy::EmbeddedView(EmbedBackend::SwiftTerm),
                true,
                false,
                false
            ),
            TerminalStrategy::Disabled
        );
        // ConPTY stays a force-only spike → falls back per platform: NewWindow
        // where it exists (Linux), Disabled elsewhere (Windows v1 — P-020).
        assert_eq!(
            downgrade_unbuilt_with(
                TerminalStrategy::EmbeddedView(EmbedBackend::ConPty),
                true,
                true,
                true
            ),
            TerminalStrategy::NewWindow
        );
        assert_eq!(
            downgrade_unbuilt_with(
                TerminalStrategy::EmbeddedView(EmbedBackend::ConPty),
                true,
                true,
                false
            ),
            TerminalStrategy::Disabled
        );
        // The X11 glued path is never downgraded.
        assert_eq!(
            downgrade_unbuilt(TerminalStrategy::GluedGhosttyX11),
            TerminalStrategy::GluedGhosttyX11
        );
    }

    // ── D-009 VTE embed (pure parts) ─────────────────────────────────────────

    #[cfg(target_os = "linux")]
    #[test]
    fn vte_hex_parsing_and_split_position() {
        let bg = vte_embed::parse_hex_rgba(BLUE_FROST_TERMINAL_BG).expect("valid hex");
        assert!((bg.red - 0x07 as f64 / 255.0).abs() < 1e-9);
        assert!((bg.green - 0x10 as f64 / 255.0).abs() < 1e-9);
        assert!((bg.blue - 0x1d as f64 / 255.0).abs() < 1e-9);
        assert_eq!(bg.alpha, 1.0);
        assert!(vte_embed::parse_hex_rgba("nope").is_none());
        assert!(vte_embed::parse_hex_rgba("#28c3").is_none());

        // Terminal-left split: handle at the terminal's extent.
        assert_eq!(
            vte_embed::initial_split_position(DockSide::Left, 2000, 0.42),
            840
        );
        // Terminal-right split: handle at total - extent.
        assert_eq!(
            vte_embed::initial_split_position(DockSide::Right, 2000, 0.42),
            1160
        );
        // Degenerate sizes clamp sanely.
        assert_eq!(
            vte_embed::initial_split_position(DockSide::Left, 0, 0.42),
            1
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn vte_term_shortcuts_map_the_standard_chords() {
        use vte_embed::{term_action_for_key, TermAction::*};
        // Shifted letters arrive as their UPPERCASE keyval (both accepted).
        assert_eq!(
            term_action_for_key('V' as u32, true, true),
            Some(PasteClipboard)
        );
        assert_eq!(
            term_action_for_key('v' as u32, true, true),
            Some(PasteClipboard)
        );
        assert_eq!(
            term_action_for_key(0xff63, false, true),
            Some(PasteClipboard)
        ); // Shift+Insert
        assert_eq!(
            term_action_for_key(0xff9e, false, true),
            Some(PasteClipboard)
        ); // Shift+KP_Insert
        assert_eq!(
            term_action_for_key('C' as u32, true, true),
            Some(CopyClipboard)
        );
        assert_eq!(
            term_action_for_key(0xff63, true, false),
            Some(CopyClipboard)
        ); // Ctrl+Insert
        assert_eq!(term_action_for_key('=' as u32, true, false), Some(ZoomIn));
        assert_eq!(term_action_for_key('+' as u32, true, true), Some(ZoomIn));
        assert_eq!(term_action_for_key(0xffab, true, false), Some(ZoomIn)); // Ctrl+KP_Add
        assert_eq!(term_action_for_key('-' as u32, true, false), Some(ZoomOut));
        assert_eq!(
            term_action_for_key('0' as u32, true, false),
            Some(ZoomReset)
        );
        // The plain chords MUST pass through to the pty untouched: Ctrl+C is
        // SIGINT, Ctrl+V is a literal ^V — stealing them breaks the TUIs.
        assert_eq!(term_action_for_key('c' as u32, true, false), None);
        assert_eq!(term_action_for_key('v' as u32, true, false), None);
        assert_eq!(term_action_for_key('v' as u32, false, false), None);
        assert_eq!(term_action_for_key(0xff63, false, false), None); // bare Insert
        assert_eq!(term_action_for_key('-' as u32, false, false), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn vte_font_scale_steps_and_clamps() {
        use vte_embed::{next_font_scale, TermAction::*};
        assert!((next_font_scale(1.0, ZoomIn) - 1.1).abs() < 1e-9);
        assert!((next_font_scale(1.1, ZoomOut) - 1.0).abs() < 1e-9);
        assert_eq!(next_font_scale(2.7, ZoomReset), 1.0);
        assert_eq!(next_font_scale(4.0, ZoomIn), 4.0); // clamped
        assert_eq!(next_font_scale(0.25, ZoomOut), 0.25); // clamped
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn vte_runtime_library_is_loadable_on_this_box() {
        // The dev box ships libvte-2.91.so.0 (runtime, no dev headers needed —
        // the embed dlopens). If this fails the strategy downgrade path is
        // what users without VTE get; the assert documents the dev-box rig.
        assert!(vte_embed::available());
    }

    // ── WI-3388 layout ──────────────────────────────────────────────────────

    #[test]
    fn terminal_layout_extent_resolves_fraction_or_collapses_to_zero() {
        let l = TerminalLayout {
            fraction: 0.5,
            collapsed: false,
        };
        assert_eq!(l.extent(1000, 100, 900), 500);
        // Clamped to bounds.
        assert_eq!(
            TerminalLayout {
                fraction: 0.9,
                collapsed: false
            }
            .extent(1000, 100, 400),
            400
        );
        // Collapsed always resolves to 0, regardless of fraction.
        assert_eq!(
            TerminalLayout {
                fraction: 0.5,
                collapsed: true
            }
            .extent(1000, 100, 900),
            0
        );
    }

    #[test]
    fn load_layout_falls_back_on_missing_or_corrupt_file() {
        let default = TerminalLayout {
            fraction: 0.42,
            collapsed: false,
        };
        // Missing file.
        let missing = std::path::Path::new("/nonexistent/wi-3388/terminal-layout.json");
        assert_eq!(load_layout(missing, default), default);
    }

    #[test]
    fn save_then_load_layout_roundtrips() {
        let dir = std::env::temp_dir().join(format!(
            "papercusp-wi3388-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("terminal-layout.json");
        let layout = TerminalLayout {
            fraction: 0.33,
            collapsed: true,
        };
        save_layout(&path, layout);
        let loaded = load_layout(&path, TerminalLayout::default());
        assert_eq!(loaded, layout);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn strategy_labels_are_stable() {
        assert_eq!(
            TerminalStrategy::GluedGhosttyX11.label(),
            "glued-ghostty-x11"
        );
        assert_eq!(TerminalStrategy::NewWindow.label(), "new-window");
        assert_eq!(TerminalStrategy::Disabled.label(), "disabled");
        assert_eq!(
            TerminalStrategy::EmbeddedView(EmbedBackend::Vte).label(),
            "embedded-vte"
        );
    }

    // ── P-005 geometry ──────────────────────────────────────────────────────

    fn main_rect() -> Rect {
        Rect {
            x: 100,
            y: 50,
            w: 1280,
            h: 800,
        }
    }

    #[test]
    fn sibling_docks_flush_on_each_side() {
        let m = main_rect();
        let r = compute_sibling_geometry(m, DockSide::Right, 500, 0);
        assert_eq!(
            r,
            Rect {
                x: 1380,
                y: 50,
                w: 500,
                h: 800
            }
        );
        let l = compute_sibling_geometry(m, DockSide::Left, 500, 0);
        assert_eq!(
            l,
            Rect {
                x: -400,
                y: 50,
                w: 500,
                h: 800
            }
        );
        let b = compute_sibling_geometry(m, DockSide::Bottom, 300, 0);
        assert_eq!(
            b,
            Rect {
                x: 100,
                y: 850,
                w: 1280,
                h: 300
            }
        );
        let t = compute_sibling_geometry(m, DockSide::Top, 300, 0);
        assert_eq!(
            t,
            Rect {
                x: 100,
                y: -250,
                w: 1280,
                h: 300
            }
        );
    }

    #[test]
    fn gap_offsets_the_sibling() {
        let m = main_rect();
        let r = compute_sibling_geometry(m, DockSide::Right, 500, 8);
        assert_eq!(r.x, 100 + 1280 + 8);
        assert_eq!(r.y, 50);
        assert_eq!(r.h, 800);
    }

    #[test]
    fn right_dock_stays_flush_after_move_and_resize() {
        // The defining property of the glue: the terminal's left edge equals the
        // GUI window's right edge, for any GUI geometry.
        for (x, y, w, h) in [
            (0, 0, 800, 600),
            (640, 360, 1600, 900),
            (-50, 12, 1000, 1000),
        ] {
            let m = Rect { x, y, w, h };
            let r = compute_sibling_geometry(m, DockSide::Right, 400, 0);
            assert_eq!(
                r.x,
                m.x + m.w,
                "terminal left edge must touch GUI right edge"
            );
            assert_eq!(r.y, m.y, "tops aligned");
            assert_eq!(r.h, m.h, "heights matched");
        }
    }

    #[test]
    fn extent_is_a_clamped_fraction() {
        let m = Rect {
            x: 0,
            y: 0,
            w: 1000,
            h: 800,
        };
        // 42% of width = 420, within [480,1200] clamp → 480 (min wins).
        assert_eq!(sibling_extent(m, DockSide::Right, 0.42, 480, 1200), 480);
        // 42% of a wide window = 840, within bounds → 840.
        let wide = Rect {
            x: 0,
            y: 0,
            w: 2000,
            h: 800,
        };
        assert_eq!(sibling_extent(wide, DockSide::Right, 0.42, 480, 1200), 840);
        // Capped at max.
        let huge = Rect {
            x: 0,
            y: 0,
            w: 4000,
            h: 800,
        };
        assert_eq!(sibling_extent(huge, DockSide::Right, 0.42, 480, 1200), 1200);
        // Bottom dock uses height as the axis.
        assert_eq!(sibling_extent(m, DockSide::Bottom, 0.5, 100, 1000), 400);
    }

    #[test]
    fn rects_close_tolerance() {
        let a = Rect {
            x: 100,
            y: 100,
            w: 500,
            h: 800,
        };
        // identical → close
        assert!(rects_close(a, a, 40));
        // within tol on every axis (cell-snap sized) → close
        assert!(rects_close(
            a,
            Rect {
                x: 102,
                y: 98,
                w: 492,
                h: 808
            },
            40
        ));
        // a reset to default origin/size → NOT close (catches the drift)
        assert!(!rects_close(
            a,
            Rect {
                x: 0,
                y: 0,
                w: 800,
                h: 600
            },
            40
        ));
        // just past tol on one axis → not close
        assert!(!rects_close(
            a,
            Rect {
                x: 100,
                y: 141,
                w: 500,
                h: 800
            },
            40
        ));
    }

    #[test]
    fn dock_side_parses_env() {
        assert_eq!(DockSide::from_env(Some("left")), DockSide::Left);
        assert_eq!(DockSide::from_env(Some("BOTTOM")), DockSide::Bottom);
        assert_eq!(DockSide::from_env(Some("right")), DockSide::Right);
        // Default (unset / unrecognized) is LEFT now (D-011 / P-014): the native
        // terminal docks on the left, the Tauri GUI on the right.
        assert_eq!(DockSide::from_env(None), DockSide::Left);
        assert_eq!(DockSide::from_env(Some("nonsense")), DockSide::Left);
    }

    // ── P-015 draggable split ────────────────────────────────────────────────

    #[test]
    fn whole_window_move_keeps_extent() {
        // Translating the GUI (both edges shift equally) only TRANSLATES the
        // terminal — the split is unchanged, on every side.
        let a = Rect {
            x: 100,
            y: 50,
            w: 1280,
            h: 800,
        };
        let b = Rect {
            x: 300,
            y: 120,
            w: 1280,
            h: 800,
        }; // moved, same size
        for side in [
            DockSide::Left,
            DockSide::Right,
            DockSide::Top,
            DockSide::Bottom,
        ] {
            assert_eq!(resized_extent(side, a, b, 500, 100, 2000), 500, "{side:?}");
        }
    }

    #[test]
    fn dragging_boundary_edge_resizes_left_dock() {
        // Left dock: the boundary is the GUI's LEFT edge. Dragging it RIGHT by 120
        // (GUI shrinks from the left, far/right edge fixed at 1500) makes room →
        // the left-docked terminal GROWS by 120.
        let a = Rect {
            x: 500,
            y: 0,
            w: 1000,
            h: 800,
        }; // left=500  right=1500
        let b = Rect {
            x: 620,
            y: 0,
            w: 880,
            h: 800,
        }; //  left=620  right=1500
        assert_eq!(resized_extent(DockSide::Left, a, b, 400, 100, 2000), 520);
        // Dragging the boundary LEFT shrinks the terminal.
        let c = Rect {
            x: 420,
            y: 0,
            w: 1080,
            h: 800,
        }; // left=420  right=1500
        assert_eq!(resized_extent(DockSide::Left, a, c, 400, 100, 2000), 320);
    }

    #[test]
    fn dragging_boundary_edge_resizes_right_dock() {
        // Right dock: the boundary is the GUI's RIGHT edge. Dragging it LEFT by 120
        // (GUI shrinks from the right, left edge fixed at 0) makes room on the
        // right → the right-docked terminal GROWS by 120.
        let a = Rect {
            x: 0,
            y: 0,
            w: 1000,
            h: 800,
        }; // left=0  right=1000
        let b = Rect {
            x: 0,
            y: 0,
            w: 880,
            h: 800,
        }; //  left=0  right=880
        assert_eq!(resized_extent(DockSide::Right, a, b, 400, 100, 2000), 520);
    }

    #[test]
    fn dragging_far_edge_leaves_split_untouched() {
        // Left dock: dragging the GUI's FAR (right) edge moves only the far edge;
        // the boundary (left) is fixed → the terminal split is unchanged.
        let a = Rect {
            x: 500,
            y: 0,
            w: 1000,
            h: 800,
        }; // left=500  right=1500
        let b = Rect {
            x: 500,
            y: 0,
            w: 1200,
            h: 800,
        }; // left=500  right=1700
        assert_eq!(resized_extent(DockSide::Left, a, b, 400, 100, 2000), 400);
    }

    #[test]
    fn resized_extent_clamps_to_min() {
        // A boundary drag that would shrink the terminal below min is clamped.
        let a = Rect {
            x: 500,
            y: 0,
            w: 1000,
            h: 800,
        }; // left=500  right=1500
        let b = Rect {
            x: -100,
            y: 0,
            w: 1600,
            h: 800,
        }; // boundary −600, right fixed
        assert_eq!(resized_extent(DockSide::Left, a, b, 400, 100, 2000), 100);
    }

    #[test]
    fn resized_extent_clamps_to_max() {
        // A boundary drag past max is clamped.
        let a = Rect {
            x: 0,
            y: 0,
            w: 2000,
            h: 800,
        }; //  left=0     right=2000
        let b = Rect {
            x: 1900,
            y: 0,
            w: 100,
            h: 800,
        }; // boundary +1900, right fixed
        assert_eq!(resized_extent(DockSide::Left, a, b, 400, 100, 2000), 2000);
    }

    // ── D-012 bidirectional terminal-edge drag ──────────────────────────────

    /// A Left-docked sibling target: terminal at x=100..600 (w=500), GUI to its
    /// right at x=600.
    fn left_target() -> Rect {
        Rect {
            x: 100,
            y: 0,
            w: 500,
            h: 800,
        }
    }

    #[test]
    fn classify_in_place_within_tolerances() {
        let t = left_target();
        // Cell-snap sized wiggle on every coordinate stays InPlace.
        let a = Rect {
            x: t.x + 3,
            y: t.y + 10,
            w: t.w - 6,
            h: t.h - 12,
        };
        assert_eq!(
            classify_sibling_change(DockSide::Left, t, a, 8, 40),
            SiblingDelta::InPlace
        );
    }

    #[test]
    fn classify_seam_drag_left_dock() {
        let t = left_target();
        // Seam = right edge (x+w): dragged +120, outer edge anchored.
        let a = Rect {
            x: t.x,
            y: t.y,
            w: t.w + 120,
            h: t.h,
        };
        assert_eq!(
            classify_sibling_change(DockSide::Left, t, a, 8, 40),
            SiblingDelta::SeamResize { extent: 620 }
        );
    }

    #[test]
    fn classify_outer_drag_left_dock() {
        let t = left_target();
        // Outer = left edge: dragged -80 (grow outward), seam anchored.
        let a = Rect {
            x: t.x - 80,
            y: t.y,
            w: t.w + 80,
            h: t.h,
        };
        assert_eq!(
            classify_sibling_change(DockSide::Left, t, a, 8, 40),
            SiblingDelta::OuterResize { extent: 580 }
        );
    }

    #[test]
    fn classify_wholesale_move_is_a_jump() {
        let t = left_target();
        // Both dock-axis edges shifted together = a move/reset → snap back.
        let a = Rect {
            x: t.x + 200,
            y: t.y,
            w: t.w,
            h: t.h,
        };
        assert_eq!(
            classify_sibling_change(DockSide::Left, t, a, 8, 40),
            SiblingDelta::Jump
        );
    }

    #[test]
    fn classify_cross_axis_breach_is_a_jump() {
        let t = left_target();
        // A big vertical jump (ghostty geometry reset) → Jump even with the
        // dock-axis edges intact.
        let a = Rect {
            x: t.x,
            y: t.y + 300,
            w: t.w,
            h: t.h,
        };
        assert_eq!(
            classify_sibling_change(DockSide::Left, t, a, 8, 40),
            SiblingDelta::Jump
        );
    }

    #[test]
    fn classify_seam_drag_right_dock() {
        // Right-docked sibling: terminal right of the GUI; seam = its LEFT edge.
        let t = Rect {
            x: 1200,
            y: 0,
            w: 400,
            h: 800,
        };
        // Drag the seam left 100px (terminal grows): x -100, w +100.
        let a = Rect {
            x: 1100,
            y: 0,
            w: 500,
            h: 800,
        };
        assert_eq!(
            classify_sibling_change(DockSide::Right, t, a, 8, 40),
            SiblingDelta::SeamResize { extent: 500 }
        );
    }

    // ── P-005 minimize follow ────────────────────────────────────────────────

    #[test]
    fn iconify_follows_gui_transitions_only() {
        // GUI just minimized → iconify the sibling.
        assert_eq!(iconify_transition(true, false), Some(true));
        // GUI just restored → restore the sibling.
        assert_eq!(iconify_transition(false, true), Some(false));
        // Steady states → leave the sibling alone (no per-tick WM spam).
        assert_eq!(iconify_transition(false, false), None);
        assert_eq!(iconify_transition(true, true), None);
    }

    // ── P-005 focus share ────────────────────────────────────────────────────

    #[test]
    fn focus_transition_to_gui_raises_the_sibling_above_it() {
        // Focus moved from elsewhere onto the GUI → raise the terminal, just
        // above the GUI (travel as a unit, not top-of-everything).
        assert_eq!(partner_to_raise(Some(10), Some(99), 10, 20), Some((20, 10)));
        // ...and symmetrically: focusing the terminal surfaces the GUI.
        assert_eq!(partner_to_raise(Some(20), Some(99), 10, 20), Some((10, 20)));
        // From "nothing active" too (first focus after launch).
        assert_eq!(partner_to_raise(Some(10), None, 10, 20), Some((20, 10)));
    }

    #[test]
    fn focus_share_never_fights_other_apps_or_refires() {
        // Unrelated window became active → leave stacking alone.
        assert_eq!(partner_to_raise(Some(99), Some(10), 10, 20), None);
        // No transition → no restack (don't spam the WM every tick).
        assert_eq!(partner_to_raise(Some(10), Some(10), 10, 20), None);
        assert_eq!(partner_to_raise(None, None, 10, 20), None);
        // Active window vanished (focus lost) → nothing to do.
        assert_eq!(partner_to_raise(None, Some(10), 10, 20), None);
        // Flipping focus BETWEEN the pair still re-asserts the partner — the
        // transition is what matters, not where focus came from.
        assert_eq!(partner_to_raise(Some(20), Some(10), 10, 20), Some((10, 20)));
    }

    #[test]
    fn reflow_left_dock_keeps_far_edge_anchored() {
        // GUI at 600..2000; sibling seam dragged from 600 to 720.
        let gui = Rect {
            x: 600,
            y: 0,
            w: 1400,
            h: 800,
        };
        let sibling = Rect {
            x: 100,
            y: 0,
            w: 620,
            h: 800,
        };
        let g = reflow_gui_for_seam(DockSide::Left, gui, sibling, 0);
        assert_eq!(
            g,
            Rect {
                x: 720,
                y: 0,
                w: 1280,
                h: 800
            }
        );
        // The pair's combined outer rect is preserved: GUI far edge fixed.
        assert_eq!(g.x + g.w, gui.x + gui.w);
    }

    #[test]
    fn reflow_right_dock_keeps_left_edge_anchored() {
        let gui = Rect {
            x: 0,
            y: 0,
            w: 1200,
            h: 800,
        };
        // Sibling (right of GUI) seam dragged left to x=1100.
        let sibling = Rect {
            x: 1100,
            y: 0,
            w: 500,
            h: 800,
        };
        let g = reflow_gui_for_seam(DockSide::Right, gui, sibling, 0);
        assert_eq!(
            g,
            Rect {
                x: 0,
                y: 0,
                w: 1100,
                h: 800
            }
        );
    }

    #[test]
    fn reflow_honors_the_gap() {
        let gui = Rect {
            x: 600,
            y: 0,
            w: 1400,
            h: 800,
        };
        let sibling = Rect {
            x: 100,
            y: 0,
            w: 620,
            h: 800,
        };
        let g = reflow_gui_for_seam(DockSide::Left, gui, sibling, 4);
        assert_eq!(g.x, 724); // seam + gap
        assert_eq!(g.x + g.w, 2000); // far edge still anchored
    }

    #[test]
    fn reflow_vertical_docks() {
        // Top dock: sibling above; GUI's bottom edge anchored.
        let gui = Rect {
            x: 0,
            y: 400,
            w: 1200,
            h: 600,
        };
        let sib_top = Rect {
            x: 0,
            y: 0,
            w: 1200,
            h: 500,
        };
        let g = reflow_gui_for_seam(DockSide::Top, gui, sib_top, 0);
        assert_eq!(
            g,
            Rect {
                x: 0,
                y: 500,
                w: 1200,
                h: 500
            }
        );
        // Bottom dock: sibling below; GUI's top edge anchored.
        let gui2 = Rect {
            x: 0,
            y: 0,
            w: 1200,
            h: 600,
        };
        let sib_bot = Rect {
            x: 0,
            y: 550,
            w: 1200,
            h: 450,
        };
        let g2 = reflow_gui_for_seam(DockSide::Bottom, gui2, sib_bot, 0);
        assert_eq!(
            g2,
            Rect {
                x: 0,
                y: 0,
                w: 1200,
                h: 550
            }
        );
    }

    #[test]
    fn terminal_collapse_claims_the_exact_sibling_band_on_all_sides() {
        let gui = Rect {
            x: 600,
            y: 400,
            w: 1200,
            h: 800,
        };
        let extent = 240;
        let gap = 8;
        let band = extent + gap;

        assert_eq!(
            gui_geometry_after_terminal_collapse(DockSide::Left, gui, extent, gap),
            Rect {
                x: gui.x - band,
                w: gui.w + band,
                ..gui
            }
        );
        assert_eq!(
            gui_geometry_after_terminal_collapse(DockSide::Right, gui, extent, gap),
            Rect {
                w: gui.w + band,
                ..gui
            }
        );
        assert_eq!(
            gui_geometry_after_terminal_collapse(DockSide::Top, gui, extent, gap),
            Rect {
                y: gui.y - band,
                h: gui.h + band,
                ..gui
            }
        );
        assert_eq!(
            gui_geometry_after_terminal_collapse(DockSide::Bottom, gui, extent, gap),
            Rect {
                h: gui.h + band,
                ..gui
            }
        );
    }

    #[test]
    fn terminal_collapse_reopen_geometry_roundtrips_all_sides() {
        let gui = Rect {
            x: 600,
            y: 400,
            w: 1200,
            h: 800,
        };
        for side in [
            DockSide::Left,
            DockSide::Right,
            DockSide::Top,
            DockSide::Bottom,
        ] {
            let collapsed = gui_geometry_after_terminal_collapse(side, gui, 240, 8);
            let reopened = gui_geometry_for_terminal_reopen(side, collapsed, 240, 8);
            assert_eq!(reopened, gui, "{side:?}");
        }
    }

    // ── P-004 launch argv ────────────────────────────────────────────────────

    #[test]
    fn ghostty_argv_is_borderless_shared_class_and_hosts_command() {
        let spec = GhosttySpec {
            class: "com.papercusp.desktop".into(),
            instance: "papercusp-terminal".into(),
            background: BLUE_FROST_TERMINAL_BG.into(),
            command: vec!["pui".into(), "chat".into()],
            bin: "ghostty".into(),
        };
        let argv = spec.argv();
        assert!(argv.contains(&"--class=com.papercusp.desktop".to_string()));
        assert!(argv.contains(&"--x11-instance-name=papercusp-terminal".to_string()));
        assert!(argv.contains(&"--window-decoration=false".to_string()));
        assert!(argv.contains(&"--gtk-single-instance=false".to_string()));
        assert!(argv.contains(&format!("--background={BLUE_FROST_TERMINAL_BG}")));
        // `-e` must be present and everything after it is the hosted command,
        // in order, at the very end.
        let e = argv.iter().position(|a| a == "-e").expect("missing -e");
        assert_eq!(&argv[e + 1..], &["pui".to_string(), "chat".to_string()]);
        assert_eq!(
            e,
            argv.len() - 3,
            "-e must be immediately before the command"
        );
    }

    #[test]
    fn dock_spec_hosts_the_chat_dock_by_default() {
        // The DESKTOP-DOCKED surface is the 2-pane chat dock (`pui chat`,
        // P-013 / D-011) — NOT the full `pui workbench`. Skip (vacuously pass)
        // when the env override is set in this test environment.
        if std::env::var("PAPERCUSP_NATIVE_TERMINAL_CMD").map_or(true, |s| s.trim().is_empty()) {
            assert_eq!(
                GhosttySpec::dock().command,
                vec!["pui".to_string(), "chat".to_string()]
            );
        }
    }

    // ── P-015 draggable split — vertical docks ──────────────────────────────

    #[test]
    fn dragging_boundary_edge_resizes_top_dock() {
        // Top dock: the boundary is the GUI's TOP edge. Dragging it DOWN by 100
        // (GUI shrinks from the top, bottom edge fixed at 900) makes room above
        // → the top-docked terminal GROWS by 100.
        let a = Rect {
            x: 0,
            y: 300,
            w: 1200,
            h: 600,
        }; // top=300 bottom=900
        let b = Rect {
            x: 0,
            y: 400,
            w: 1200,
            h: 500,
        }; // top=400 bottom=900
        assert_eq!(resized_extent(DockSide::Top, a, b, 250, 100, 2000), 350);
        // Dragging it back UP shrinks the terminal.
        let c = Rect {
            x: 0,
            y: 250,
            w: 1200,
            h: 650,
        }; // top=250 bottom=900
        assert_eq!(resized_extent(DockSide::Top, a, c, 250, 100, 2000), 200);
    }

    #[test]
    fn dragging_boundary_edge_resizes_bottom_dock() {
        // Bottom dock: the boundary is the GUI's BOTTOM edge. Dragging it UP by
        // 100 (GUI shrinks from the bottom, top edge fixed at 0) makes room
        // below → the bottom-docked terminal GROWS by 100.
        let a = Rect {
            x: 0,
            y: 0,
            w: 1200,
            h: 600,
        }; // top=0 bottom=600
        let b = Rect {
            x: 0,
            y: 0,
            w: 1200,
            h: 500,
        }; // top=0 bottom=500
        assert_eq!(resized_extent(DockSide::Bottom, a, b, 250, 100, 2000), 350);
    }

    #[test]
    fn dragging_far_edge_leaves_vertical_split_untouched() {
        // Bottom dock: the GUI's TOP edge is the far edge — dragging it only
        // moves the far edge; the split is unchanged.
        let a = Rect {
            x: 0,
            y: 100,
            w: 1200,
            h: 500,
        }; // top=100 bottom=600
        let b = Rect {
            x: 0,
            y: 50,
            w: 1200,
            h: 550,
        }; //  top=50  bottom=600
        assert_eq!(resized_extent(DockSide::Bottom, a, b, 250, 100, 2000), 250);
    }

    // ── D-012 classification — vertical docks + tolerance boundaries ────────

    #[test]
    fn classify_seam_and_outer_drag_bottom_dock() {
        // Bottom-docked sibling (below the GUI): seam = its TOP edge.
        let t = Rect {
            x: 0,
            y: 600,
            w: 1200,
            h: 400,
        };
        // Seam dragged up 100 → terminal grows to 500.
        let seam = Rect {
            x: 0,
            y: 500,
            w: 1200,
            h: 500,
        };
        assert_eq!(
            classify_sibling_change(DockSide::Bottom, t, seam, 8, 40),
            SiblingDelta::SeamResize { extent: 500 }
        );
        // Outer (bottom) edge dragged down 80, seam anchored → OuterResize.
        let outer = Rect {
            x: 0,
            y: 600,
            w: 1200,
            h: 480,
        };
        assert_eq!(
            classify_sibling_change(DockSide::Bottom, t, outer, 8, 40),
            SiblingDelta::OuterResize { extent: 480 }
        );
        // A big horizontal (cross-axis) departure is a Jump even with the
        // dock-axis edges intact.
        let cross = Rect {
            x: 300,
            y: 600,
            w: 1200,
            h: 400,
        };
        assert_eq!(
            classify_sibling_change(DockSide::Bottom, t, cross, 8, 40),
            SiblingDelta::Jump
        );
    }

    #[test]
    fn classify_seam_drag_top_dock() {
        // Top-docked sibling (above the GUI): seam = its BOTTOM edge (y+h).
        let t = Rect {
            x: 0,
            y: 0,
            w: 1200,
            h: 300,
        };
        let a = Rect {
            x: 0,
            y: 0,
            w: 1200,
            h: 380,
        }; // seam dragged down 80
        assert_eq!(
            classify_sibling_change(DockSide::Top, t, a, 8, 40),
            SiblingDelta::SeamResize { extent: 380 }
        );
    }

    #[test]
    fn classify_outer_drag_right_dock() {
        // Right-docked sibling: outer = its RIGHT edge (x+w).
        let t = Rect {
            x: 1200,
            y: 0,
            w: 400,
            h: 800,
        };
        let a = Rect {
            x: 1200,
            y: 0,
            w: 490,
            h: 800,
        }; // outer dragged right 90
        assert_eq!(
            classify_sibling_change(DockSide::Right, t, a, 8, 40),
            SiblingDelta::OuterResize { extent: 490 }
        );
    }

    #[test]
    fn classify_seam_tolerance_is_a_dead_band() {
        let t = left_target();
        // Exactly AT the tolerance → still InPlace (ghostty cell-snap noise).
        let at_tol = Rect {
            x: t.x,
            y: t.y,
            w: t.w + 8,
            h: t.h,
        };
        assert_eq!(
            classify_sibling_change(DockSide::Left, t, at_tol, 8, 40),
            SiblingDelta::InPlace
        );
        // One px past it → a deliberate drag.
        let past_tol = Rect {
            x: t.x,
            y: t.y,
            w: t.w + 9,
            h: t.h,
        };
        assert_eq!(
            classify_sibling_change(DockSide::Left, t, past_tol, 8, 40),
            SiblingDelta::SeamResize { extent: t.w + 9 }
        );
    }

    // ── geometry edge cases ─────────────────────────────────────────────────

    #[test]
    fn sibling_geometry_clamps_nonpositive_extent() {
        let m = main_rect();
        // A zero/negative extent can't produce a zero-width window — X11
        // rejects those; clamp to 1px.
        assert_eq!(compute_sibling_geometry(m, DockSide::Right, 0, 0).w, 1);
        assert_eq!(compute_sibling_geometry(m, DockSide::Left, -50, 0).w, 1);
        assert_eq!(compute_sibling_geometry(m, DockSide::Bottom, 0, 0).h, 1);
    }

    #[test]
    fn sibling_extent_tolerates_inverted_bounds() {
        // Misconfigured min > max (env knobs are free-form) must not panic
        // `clamp` — the helper normalizes the bounds.
        let m = Rect {
            x: 0,
            y: 0,
            w: 2000,
            h: 800,
        };
        let e = sibling_extent(m, DockSide::Right, 0.42, 1200, 480);
        assert!(
            (480..=1200).contains(&e),
            "extent {e} outside normalized bounds"
        );
        // resized_extent normalizes too.
        let r = resized_extent(DockSide::Right, m, m, 840, 1200, 480);
        assert!((480..=1200).contains(&r));
    }

    #[test]
    fn remaining_strategy_labels_are_stable() {
        assert_eq!(
            TerminalStrategy::EmbeddedView(EmbedBackend::SwiftTerm).label(),
            "embedded-swiftterm"
        );
        assert_eq!(
            TerminalStrategy::EmbeddedView(EmbedBackend::ConPty).label(),
            "embedded-conpty"
        );
    }

    #[test]
    fn dock_side_from_env_trims_and_lowercases() {
        assert_eq!(DockSide::from_env(Some("top")), DockSide::Top);
        assert_eq!(DockSide::from_env(Some(" Right ")), DockSide::Right);
        assert_eq!(DockSide::from_env(Some("LEFT")), DockSide::Left);
        assert_eq!(DockSide::from_env(Some("")), DockSide::Left);
    }

    // ── D-009 VTE embed pure helpers — edge cases ───────────────────────────

    #[cfg(target_os = "linux")]
    #[test]
    fn vte_hex_parsing_edge_cases() {
        use vte_embed::parse_hex_rgba;
        // Uppercase hex digits are valid.
        let up = parse_hex_rgba("#07101D").expect("uppercase hex");
        assert!((up.blue - 0x1d as f64 / 255.0).abs() < 1e-9);
        // Surrounding whitespace is trimmed before the '#'.
        assert!(parse_hex_rgba(" #07101d ").is_some());
        // Short form, missing '#', non-hex digits → rejected.
        assert!(parse_hex_rgba("#fff").is_none());
        assert!(parse_hex_rgba("07101d").is_none());
        assert!(parse_hex_rgba("#0g101d").is_none());
        // Non-ASCII input must be rejected, not panic byte-slicing.
        assert!(parse_hex_rgba("#ぁぁぁ").is_none());
        assert!(parse_hex_rgba("").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn vte_split_position_vertical_and_degenerate_fractions() {
        use vte_embed::initial_split_position;
        // Vertical docks use the same pane-1/pane-2 rule.
        assert_eq!(initial_split_position(DockSide::Top, 1000, 0.3), 300);
        assert_eq!(initial_split_position(DockSide::Bottom, 1000, 0.3), 700);
        // A fraction past 1.0 clamps to the window; past-0 stays ≥ 1.
        assert_eq!(initial_split_position(DockSide::Left, 1000, 1.5), 1000);
        assert_eq!(initial_split_position(DockSide::Right, 1000, 1.5), 1);
        assert_eq!(initial_split_position(DockSide::Left, 1000, 0.0), 1);
    }
}
