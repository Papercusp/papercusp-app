//! docs_search — the global-hotkey Quick Panel (WI-2648 feature #5; tabbed
//! panel: quick-panel-saved-prompts-2026-07-13).
//!
//! A user-configurable global shortcut — **OFF by default** — which, when the
//! user turns it on, opens (or focuses) a small, always-on-top WebviewWindow
//! loading the SPA's `/quick-panel` route: a tabbed palette whose DEFAULT tab
//! is the saved-prompts organizer, with the original Pagefind docs search
//! (`/internal/docs/search-palette.html`, embedded as an iframe) and the
//! brainstorm partner as sibling tabs. Cross-platform:
//! `tauri_plugin_global_shortcut` handles the OS registration on
//! macOS/Windows/Linux.
//!
//! OFF BY DEFAULT (owner directive, 2026-07-12). A global shortcut is a
//! SYSTEM-WIDE key grab: while registered, the accelerator is stolen from every
//! other app on the machine, whether or not Papercusp is focused. `CmdOrCtrl+K`
//! is "focus the search box" in Slack, VS Code, every browser — so the old
//! register-on-first-launch behavior silently broke a key the user relies on
//! elsewhere, and did it before they had ever asked for the feature. A grab that
//! broad must be opt-IN. This is enforced STRUCTURALLY, not by a default
//! constant: the shortcut is registered ONLY when a valid preset has been
//! explicitly persisted by a user choice (`current_shortcut() -> Option<String>`,
//! `None` = disabled), so there is no code path on which a fresh install grabs a
//! key. Missing file, malformed file, unknown accelerator, explicit `null` — all
//! land on `None`, i.e. OFF. The user turns it on (and picks the key) from the
//! Server tray's "Docs search shortcut" submenu, whose first item is `Off`.
//!
//! Ownership (packaged builds): the **Server** process owns the shortcut +
//! palette, NOT the GUI. The Server is the always-on process (auto-starts at
//! login, stays up when the GUI is closed), so a global docs-search key works
//! "whether or not the GUI is open" — exactly the owner's requirement — and the
//! rebind control lives in the Server's own tray, same-process (main.rs
//! `install_server_tray`). In dev there is a single process, which registers it
//! directly. (`open_palette` resolves the content origin from the main window
//! when there is one, else from the Server's sidecar port — see `resolve_base`.)
//!
//! Rebinding: the chosen accelerator is one of `PRESET_SHORTCUTS` (a native tray
//! menu can't capture arbitrary keystrokes, so we offer a small curated list —
//! enough to dodge a desktop environment that already owns `Cmd+K`). It is
//! persisted to `~/.papercusp/docs-search-shortcut.json` (desktop-local,
//! sidecar-independent, read at Tauri startup before the operator/PG is up —
//! mirroring `env_switch`'s `desktop-build-target.json`; a UI keybinding is the
//! storage-policy file case) and re-registered live on change.
//!
//! Best-effort like env_switch's shortcuts: a shortcut the desktop environment
//! already owns just fails to register (logged, never fatal — the palette is
//! additive, not load-bearing).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/// The palette window's label — stable so `get_webview_window` can find + focus
/// an already-open palette instead of spawning a duplicate.
pub const WINDOW_LABEL: &str = "docs-search-palette";

/// The diagnostic window's label — DISTINCT from `WINDOW_LABEL` on purpose.
///
/// Sharing the palette's label would be a trap: the reuse branch at the top of
/// `open_palette` would then find the ERROR window on the next press, toggle it,
/// and `location.reload()` a `data:` URL — re-rendering the error forever. The
/// user could never reach the real panel again even after the operator came
/// back. Separate label ⇒ the error window is hidden the moment a real palette
/// opens, and the palette path is never shadowed by it.
pub const UNAVAILABLE_WINDOW_LABEL: &str = "quick-panel-unavailable";

/// Injected into the palette webview BEFORE any page script, on every load, so
/// the SPA's Quick Panel window-sandbox guard (operator-core
/// `client-navigation.ts`) knows it is running in the panel window: a navigation
/// that would leave the chromeless panel is handed to the main app window
/// (Spotlight-style) instead of turning this small popup into the whole operator
/// app (WI-4827). The main app window never sets this global.
pub const QUICK_PANEL_WINDOW_INIT_JS: &str = "window.__PAPERCUSP_QUICK_PANEL_WINDOW__ = true;";

/// Menu payload for the tray's "Off" item — the disable affordance. Not an
/// accelerator, and deliberately not a member of `PRESET_SHORTCUTS` (it must
/// never be handed to the OS registrar).
///
/// There is deliberately no `DEFAULT_SHORTCUT` constant any more: a default
/// accelerator is precisely the thing that used to get registered on a fresh
/// install. "Off" is the default, and it is expressed by `current_shortcut()`
/// returning `None` — not by a constant a caller could decide to fall back to.
pub const SHORTCUT_OFF: &str = "off";

/// The curated set of accelerators the tray rebind offers. A native tray menu
/// can't capture an arbitrary keystroke, so we present a small, valid, mutually
/// non-conflicting preset list. Each MUST parse as a tauri global-shortcut
/// accelerator; order = tray menu order. The persisted value is validated
/// against this list, so shrinking it in a future build safely falls back to
/// the default rather than registering an accelerator that's no longer offered.
pub const PRESET_SHORTCUTS: &[&str] = &[
    "CmdOrCtrl+K",
    "CmdOrCtrl+Shift+K",
    "CmdOrCtrl+Shift+Space",
    "CmdOrCtrl+/",
    "Alt+Space",
];

// ---------------------------------------------------------------------------
// Persistence (~/.papercusp/docs-search-shortcut.json)
// ---------------------------------------------------------------------------

fn persisted_shortcut_path() -> Option<PathBuf> {
    // HOME on macOS/Linux, USERPROFILE on native Windows. Only needs to be a
    // stable per-user path (the same process reads it at startup and writes it
    // on rebind) — it need not match the WSL sidecar home on Windows.
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".papercusp/docs-search-shortcut.json"))
}

/// Serialize the persisted payload. `None` (disabled) persists as an explicit
/// `null`, which is a RECORD OF A CHOICE — distinct on disk from "never chosen",
/// even though both read back as OFF. Pure (no I/O) so it's unit-testable.
fn serialize_shortcut(accel: Option<&str>) -> String {
    serde_json::json!({ "accelerator": accel }).to_string()
}

/// Parse a persisted payload into the accelerator to register, or `None` for
/// DISABLED. `None` is returned for every uncertain input — malformed JSON, a
/// missing key, a non-string value, an explicit `null`, or an accelerator that is
/// not a known preset (e.g. persisted by a build that offered a key this one no
/// longer does). That is the safe direction: the failure mode of guessing wrong
/// here is a system-wide key grab the user never asked for, so anything we cannot
/// positively confirm as an explicit, still-valid user choice means OFF.
/// Pure so it's unit-testable.
fn parse_persisted(txt: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(txt).ok()?;
    let accel = v.get("accelerator")?.as_str()?.to_string();
    PRESET_SHORTCUTS.contains(&accel.as_str()).then_some(accel)
}

fn read_persisted_shortcut() -> Option<String> {
    let txt = std::fs::read_to_string(persisted_shortcut_path()?).ok()?;
    parse_persisted(&txt)
}

fn write_persisted_shortcut(accel: Option<&str>) {
    let Some(path) = persisted_shortcut_path() else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, serialize_shortcut(accel)) {
        eprintln!("[docs-search] could not persist shortcut: {e}");
    }
}

/// The accelerator currently in effect, or `None` when the global shortcut is
/// DISABLED — which is the state of every fresh install (see the module doc).
///
/// There is deliberately no "fall back to the default accelerator" branch: the
/// ONLY way this returns `Some` is a valid preset the user explicitly chose and
/// we persisted. That is what makes "off by default" structural rather than a
/// constant some future caller can forget to honor.
pub fn current_shortcut() -> Option<String> {
    read_persisted_shortcut()
}

// ---------------------------------------------------------------------------
// Palette window
// ---------------------------------------------------------------------------

/// Resolve the app's current content origin, mirroring `workspaces_open_window`
/// (main.rs): the MAIN window's live URL when there is one (dev + the GUI
/// process), else the Server process's spawned-sidecar port. The Server has no
/// window, so the sidecar-port fallback is what makes the palette work there.
fn resolve_base(app: &AppHandle) -> Option<String> {
    if let Some(base) = app
        .get_webview_window("main")
        .and_then(|w| w.url().ok())
        .map(|u| {
            let port = u.port().map(|p| format!(":{}", p)).unwrap_or_default();
            format!(
                "{}://{}{}",
                u.scheme(),
                u.host_str().unwrap_or("localhost"),
                port
            )
        })
    {
        return Some(base);
    }
    let state: tauri::State<crate::SidecarState> = app.state();
    let guard = state.port.lock().ok()?;
    (*guard).map(|p| format!("http://localhost:{}", p))
}

// ---------------------------------------------------------------------------
// The "can't open" diagnostic window (WI-5216)
// ---------------------------------------------------------------------------

/// Build the diagnostic page shown when the palette cannot be opened.
///
/// Pure (no I/O, no AppHandle) so the wording + the escaping are unit-testable.
/// `reason` is operator-facing detail, not a user-facing sentence — it is
/// rendered in a de-emphasised block below the plain-English explanation.
///
/// HTML-escaped: `reason` can carry a URL/port/message we did not author.
pub fn unavailable_page_html(reason: &str) -> String {
    let safe = reason
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8">
<title>Quick Panel unavailable</title><style>
:root {{ color-scheme: light dark; }}
body {{ margin:0; padding:28px 30px; font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
  background:#1e1b4b; color:#f4f4f5; }}
h1 {{ margin:0 0 14px; font-size:17px; font-weight:600; }}
p {{ margin:0 0 12px; color:#c7d2fe; }}
code {{ background:rgba(255,255,255,.10); padding:1px 6px; border-radius:4px;
  font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }}
.detail {{ margin-top:18px; padding:10px 12px; border-radius:6px;
  background:rgba(0,0,0,.28); color:#a5b4fc;
  font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-word; }}
.hint {{ margin-top:16px; font-size:13px; color:#818cf8; }}
</style></head><body>
<h1>Quick Panel can’t open right now</h1>
<p>Your shortcut worked — Papercusp received the keypress. The panel itself
couldn’t load because Papercusp’s background service isn’t serving content.</p>
<p>It usually recovers if you quit Papercusp from the tray icon and start it again.
If it keeps happening, the boot log has the reason:</p>
<p><code>~/.papercusp/logs/serve.log</code></p>
<div class="detail">{safe}</div>
<p class="hint">Press your Quick Panel shortcut again to retry, or close this window.</p>
</body></html>"#
    )
}

/// The `data:` URL for the diagnostic page. base64 so the HTML needs no
/// percent-encoding and can contain quotes/newlines freely.
fn unavailable_data_url(reason: &str) -> String {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(unavailable_page_html(reason));
    format!("data:text/html;charset=utf-8;base64,{b64}")
}

/// Show the diagnostic window — the ANSWER to WI-5216's real complaint.
///
/// Before this, a palette that could not resolve an origin `eprintln!`d into
/// `~/.papercusp/logs/server-app.log` and returned. To the user the global
/// shortcut was simply DEAD: no window, no message, nothing. The owner
/// reasonably concluded the KEY was broken and rebound it twice (CmdOrCtrl+K →
/// CmdOrCtrl+Shift+K → Alt+Space) chasing a key bug that never existed, while
/// every press was in fact being delivered and failing downstream.
///
/// A desktop notification is NOT an option here: notifications to the owner are
/// OFF by standing directive (root CLAUDE.md, 2026-07-14 — `notify-send` is a
/// logged no-op shim), so the feedback must be a window.
///
/// Hides (never destroys) on dismiss, exactly like the palette: on the packaged
/// Server this may be the process's ONLY window, and destroying the last one
/// fires an ExitRequested that tears down the operator + embedded PG, and kills
/// the sole GTK frame clock (a webkit2gtk crash on GNOME).
fn open_unavailable_window(app: &AppHandle, reason: &str) {
    if let Some(existing) = app.get_webview_window(UNAVAILABLE_WINDOW_LABEL) {
        // Refresh the reason (the failure may differ from last time), then show.
        let _ = existing.eval(format!(
            "location.replace({});",
            serde_json::to_string(&unavailable_data_url(reason)).unwrap_or_else(|_| "''".into())
        ));
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return;
    }
    let Ok(parsed) = unavailable_data_url(reason).parse::<url::Url>() else {
        eprintln!("[docs-search] could not build the diagnostic page url");
        return;
    };
    // `icon()` CONSUMES the builder and returns a Result, so the error arm needs
    // a fresh one — hence this factory rather than a bare `if let Ok(..)` (which
    // would move the builder away with no way to put it back).
    let make = || {
        tauri::WebviewWindowBuilder::new(
            app,
            UNAVAILABLE_WINDOW_LABEL,
            tauri::WebviewUrl::External(parsed.clone()),
        )
        .title("Quick Panel unavailable")
        .inner_size(560.0, 400.0)
        .min_inner_size(420.0, 320.0)
        .center()
        .always_on_top(true)
        .focused(true)
        .decorations(true)
        .resizable(true)
    };
    let mut builder = make();
    if let Some(icon) = app.default_window_icon().cloned() {
        match builder.icon(icon) {
            Ok(b) => builder = b,
            Err(e) => {
                // Never drop the window over a cosmetic icon failure — the
                // whole point of this window is that the user hears SOMETHING.
                eprintln!("[docs-search] could not set diagnostic window icon: {e}");
                builder = make();
            }
        }
    }
    match builder.build() {
        Ok(win) => {
            let _ = win.set_focus();
            let hide_target = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // HIDE, never destroy — see the doc comment above.
                    api.prevent_close();
                    let _ = hide_target.hide();
                }
            });
        }
        Err(e) => eprintln!("[docs-search] failed to open the diagnostic window: {e}"),
    }
}

/// Hide a diagnostic window left over from an earlier failure. Called when a
/// real palette opens, so a recovered operator doesn't leave a stale "can't
/// open" window sitting on top of the working panel.
fn dismiss_unavailable_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(UNAVAILABLE_WINDOW_LABEL) {
        let _ = w.hide();
    }
}

/// Open the docs-search palette, or focus it if already open. Exposed as a
/// Tauri command too (`#[tauri::command]` below) so a future in-webview menu
/// item / button can trigger the identical path the global shortcut uses.
pub fn open_palette(app: &AppHandle) {
    // Reuse the single palette window across presses. It is created once and
    // then HIDDEN (not destroyed) on close — see the CloseRequested handler
    // below — so a repeat press just re-shows + focuses it. This is the ONLY
    // window the windowless Server ever owns, and destroying it is doubly
    // fatal: (a) the window count drops to 0, firing a window-close
    // ExitRequested that tears the whole Server (operator + embedded PG) down,
    // and (b) it tears down the sole GTK frame clock, which crashed webkit2gtk
    // on GNOME ("GdkWindow unexpectedly destroyed"). Hiding sidesteps both — the
    // app stays alive, the window persists, and the shortcut keeps working after
    // the palette is dismissed (WI-2648, reproduced live on GNOME 2026-07-04:
    // the palette worked exactly once, then "stopped working no matter which key").
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        // WI-3096: TOGGLE, don't blindly re-show. Before this check, a second
        // shortcut press while the palette was already open just re-showed +
        // reloaded it in place — there was no way to dismiss it with the same
        // key that opened it (the ticket's "ctrl+k toggles" UX expectation).
        // Gate on `is_visible()` ALONE, not also `is_focused()`: live-tested
        // (isolated Xvfb+openbox instance, WI-3096) — is_focused() can read
        // false even when the X server confirms the window IS the active,
        // input-focused window (WM_STATE=Normal, IsViewable, and
        // _NET_ACTIVE_WINDOW all agreeing) — Tauri/GTK's focus-tracking on
        // X11 does not reliably reflect real focus in every WM. Requiring it
        // for the toggle meant the second ctrl+k press silently fell through
        // to re-show+reload instead of closing. is_visible() alone is also
        // the more correct UX anyway: a palette the user left open (even if
        // they last interacted with the main window, so the palette itself
        // isn't the X11-focused window) should still close on a repeat press
        // — "toggle" means open/closed, not open/closed-only-if-still-focused.
        eprintln!(
            "[docs-search] DEBUG toggle check: is_visible={:?} is_focused={:?}",
            existing.is_visible(),
            existing.is_focused()
        );
        if existing.is_visible().unwrap_or(false) {
            let _ = existing.hide();
            return;
        }
        // Re-showing the real palette — retire any stale diagnostic window.
        dismiss_unavailable_window(app);
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        // Re-shown = a fresh open from the user's point of view — RELOAD so the
        // palette picks up the CURRENT served page. The hidden window otherwise
        // pins whatever HTML existed when it was first created for the app's
        // whole lifetime: the owner ran an app instance from before the 💬
        // "Chat with an agent" CTA landed and could never see it, however many
        // times the shortcut re-opened the (stale) palette (2026-07-05). A
        // reload here is one local fetch of a static page — imperceptible next
        // to the show/focus, and clearing the previous query matches
        // fresh-open semantics anyway.
        let _ = existing.eval("location.reload()");
        return;
    }
    // WI-5216: origin unresolvable = the operator/sidecar isn't serving. This
    // used to be a bare eprintln! + return, i.e. a DEAD key from the user's
    // side. Never fail silently on a user-initiated action — say so on screen.
    let Some(base) = resolve_base(app) else {
        eprintln!("[docs-search] could not resolve app origin — palette not opened");
        open_unavailable_window(
            app,
            "No content origin: the operator sidecar reported no port and there is no app window \
             to inherit one from. Its boot most likely failed (see serve.log).",
        );
        return;
    };
    let url = format!("{base}/quick-panel");
    // Explicit type: `parsed` is now also `.clone()`d into a second builder
    // below, and `.clone()` on an un-annotated binding leaves `url.parse()`'s
    // target ambiguous (E0282).
    let Ok(parsed) = url.parse::<url::Url>() else {
        eprintln!("[docs-search] bad palette url {url}");
        open_unavailable_window(app, &format!("Resolved an unusable panel address: {url}"));
        return;
    };
    // Base builder. The icon is applied below so the palette carries the SAME
    // papercup icon as the app/taskbar (owner ask 2026-07-05) instead of a
    // generic fallback glyph. `default_window_icon()` is the already-decoded
    // bundle icon; `WebviewWindowBuilder::icon()` returns a Result AND consumes
    // the builder (unlike the tray builder's `.icon()` in main.rs, which returns
    // Self), so on the effectively-never error path we log and rebuild an
    // icon-less builder rather than dropping the palette entirely.
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        tauri::WebviewUrl::External(parsed.clone()),
    )
    .title("Quick Panel")
    .inner_size(760.0, 540.0)
    .min_inner_size(480.0, 360.0)
    .center()
    .always_on_top(true)
    .focused(true)
    .decorations(true)
    .resizable(true)
    .initialization_script(QUICK_PANEL_WINDOW_INIT_JS);
    if let Some(icon) = app.default_window_icon().cloned() {
        match builder.icon(icon) {
            Ok(b) => builder = b,
            Err(e) => {
                eprintln!("[docs-search] could not set palette icon: {e}");
                builder = tauri::WebviewWindowBuilder::new(
                    app,
                    WINDOW_LABEL,
                    tauri::WebviewUrl::External(parsed),
                )
                .title("Quick Panel")
                .inner_size(760.0, 540.0)
                .min_inner_size(480.0, 360.0)
                .center()
                .always_on_top(true)
                .focused(true)
                .decorations(true)
                .resizable(true)
                .initialization_script(QUICK_PANEL_WINDOW_INIT_JS);
            }
        }
    }
    match builder.build() {
        Ok(win) => {
            // A real palette is up — retire any stale "can't open" window.
            dismiss_unavailable_window(app);
            // Bring it to the front — on the Server process (a windowless
            // background app) the WM does not auto-raise the new window.
            let _ = win.set_focus();
            let hide_target = win.clone();
            // WI-3096: click-away dismiss. Guarded by `has_focused_once` so a
            // spurious blur fired during window creation/mapping (some
            // WM/compositor combinations deliver an initial Focused(false)
            // before the window has ever actually been shown to the user)
            // can't hide the palette before it's even been seen — only a
            // REAL loss of focus, after it was genuinely focused at least
            // once, dismisses it.
            let has_focused_once = Arc::new(AtomicBool::new(false));
            win.on_window_event(move |event| match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Dismiss = HIDE, not close. The palette is the Server's
                    // ONLY window; closing/destroying it would exit the app
                    // (last-window ExitRequested) and tear down the sole GTK
                    // frame clock (a webkit2gtk crash on GNOME). Intercept the
                    // titlebar/Escape close, veto it, and hide instead —
                    // open_palette re-shows this same window on the next
                    // shortcut press (WI-2648).
                    api.prevent_close();
                    let _ = hide_target.hide();
                }
                tauri::WindowEvent::Focused(true) => {
                    has_focused_once.store(true, Ordering::Relaxed);
                }
                tauri::WindowEvent::Focused(false) => {
                    if has_focused_once.load(Ordering::Relaxed) {
                        let _ = hide_target.hide();
                    }
                }
                _ => {}
            });
        }
        Err(e) => {
            // The window itself failed to build — still the user's dead-key
            // experience, so still owed an explanation (WI-5216).
            eprintln!("[docs-search] failed to open palette window: {e}");
            open_unavailable_window(app, &format!("The panel window could not be created: {e}"));
        }
    }
}

/// Tauri command form — for an in-webview trigger (menu item, button), not just
/// the global shortcut.
#[tauri::command]
#[specta::specta]
pub fn open_docs_search_palette(app: AppHandle) {
    open_palette(&app);
}

// ---------------------------------------------------------------------------
// Global-shortcut registration + live rebind
// ---------------------------------------------------------------------------

/// Register `accel` as the palette's global shortcut, wiring the same
/// `open_palette` handler used everywhere. Shared by startup registration and
/// live rebind. Best-effort: returns the plugin error string on failure.
fn install_shortcut(app: &AppHandle, accel: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let handle = app.clone();
    app.global_shortcut()
        .on_shortcut(accel, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                open_palette(&handle);
            }
        })
        .map_err(|e| e.to_string())
}

/// Register the docs-search global shortcut at startup — ONLY if the user has
/// explicitly enabled one. Call once, on the dev process and the packaged Server
/// process (NOT the packaged GUI; see the module doc).
///
/// On a fresh install `current_shortcut()` is `None` and this registers NOTHING:
/// no OS key grab happens until the user opts in from the tray. Best-effort when
/// enabled: a shortcut the desktop environment already owns just doesn't register
/// (logged, not fatal).
pub fn register_shortcut(app: &tauri::App) {
    let Some(accel) = current_shortcut() else {
        println!("[docs-search] global shortcut disabled (default) — no key registered");
        return;
    };
    match install_shortcut(app.handle(), &accel) {
        Ok(()) => println!("[docs-search] {accel} registered (docs search palette)"),
        Err(e) => eprintln!("[docs-search] {accel} not registered (DE may own it): {e}"),
    }
}

/// Set the palette shortcut: `Some(accel)` binds that preset, `None` DISABLES the
/// shortcut entirely. Unregisters the previous accelerator, registers the new one
/// (if any), and persists the choice. Called from the Server tray's "Docs search
/// shortcut" submenu (whose first item is "Off").
///
/// Unregisters ONLY the previous docs-search accelerator — never
/// `unregister_all()`, which would also drop env_switch's dev backstop
/// shortcuts. Returns `Err` (leaving the persisted value + tray checkmark
/// unchanged) if `new` isn't an offered preset or fails to register.
///
/// Disabling CANNOT fail: releasing a key grab is not an operation the OS can
/// refuse, so the user is never stuck with a shortcut they asked to turn off. The
/// unregister result is intentionally ignored (an accelerator that never
/// registered — because the DE already owned it — is already not grabbed), and
/// `None` is persisted regardless, so the choice survives restart even if the
/// live unregister was a no-op.
pub fn set_shortcut(app: &AppHandle, new: Option<&str>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if let Some(accel) = new {
        if !PRESET_SHORTCUTS.contains(&accel) {
            return Err(format!("{accel} is not an offered preset"));
        }
    }
    let old = current_shortcut();
    if old.as_deref() == new {
        return Ok(()); // already in that state — no-op
    }
    if let Some(prev) = old.as_deref() {
        let _ = app.global_shortcut().unregister(prev);
    }
    match new {
        Some(accel) => {
            // Register BEFORE persisting: a key the OS refuses must not be
            // recorded as the user's active choice (it would come back as a dead
            // shortcut on every future launch). On failure the previous
            // accelerator is already unregistered, but the persisted value is
            // untouched, so a restart restores the last state that actually worked.
            install_shortcut(app, accel)?;
            write_persisted_shortcut(Some(accel));
            println!("[docs-search] shortcut set {old:?} -> {accel}");
        }
        None => {
            write_persisted_shortcut(None);
            println!("[docs-search] shortcut DISABLED (was {old:?})");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for s in PRESET_SHORTCUTS {
            assert!(seen.insert(*s), "duplicate preset {s}");
        }
    }

    #[test]
    fn serialize_parse_roundtrip_for_each_preset() {
        for accel in PRESET_SHORTCUTS {
            let txt = serialize_shortcut(Some(accel));
            assert_eq!(
                parse_persisted(&txt).as_deref(),
                Some(*accel),
                "roundtrip failed for {accel}"
            );
        }
    }

    /// THE owner-directed default (2026-07-12): a fresh install grabs NO key.
    /// `parse_persisted` is the only thing that can turn a shortcut on, so every
    /// state a machine can be in BEFORE the user has made a choice must read as
    /// disabled. If this ever goes green while some input yields `Some`, a fresh
    /// install has started stealing a system-wide key again.
    #[test]
    fn disabled_is_the_default_for_every_unchosen_state() {
        let unchosen = [
            "",                                  // empty file
            "not json",                          // corrupt
            "{}",                                // no key
            r#"{"accelerator": null}"#,          // EXPLICITLY disabled by the user
            r#"{"accelerator": 5}"#,             // wrong type
            r#"{"other": "CmdOrCtrl+K"}"#,       // wrong key
            r#"{"accelerator": "CmdOrCtrl+Q"}"#, // an accelerator we do not offer
            r#"{"accelerator": "off"}"#,         // the tray's OFF payload is not an accelerator
        ];
        for txt in unchosen {
            assert_eq!(
                parse_persisted(txt),
                None,
                "must read as DISABLED (no key grab), got a shortcut from: {txt}"
            );
        }
    }

    /// Disabling must round-trip: the user's "off" survives a restart rather than
    /// reverting to a key on next launch.
    #[test]
    fn off_roundtrips_as_disabled() {
        let txt = serialize_shortcut(None);
        assert_eq!(parse_persisted(&txt), None);
        assert!(
            txt.contains("null"),
            "off should persist as an explicit null (a record of the choice), got {txt}"
        );
    }

    /// The tray's OFF payload must never be registrable as an accelerator — if it
    /// leaked into the preset list, "Off" would try to grab a key literally named
    /// "off".
    #[test]
    fn off_sentinel_is_not_a_preset() {
        assert!(!PRESET_SHORTCUTS.contains(&SHORTCUT_OFF));
    }

    // --- WI-5216: the palette must never fail SILENTLY ---

    /// The diagnostic page's ONE job: tell the user the key WORKED, so they stop
    /// debugging the shortcut. The owner rebound his key twice chasing a key bug
    /// that never existed because this text did not exist.
    #[test]
    fn unavailable_page_tells_the_user_the_shortcut_was_not_the_problem() {
        let html = unavailable_page_html("no port");
        assert!(
            html.contains("Your shortcut worked"),
            "the page must absolve the shortcut — that is the whole point"
        );
        // A concrete next step + where the real reason lives.
        assert!(html.contains("~/.papercusp/logs/serve.log"));
        assert!(html.contains("tray"));
    }

    /// The operator-facing reason must reach the page — a diagnostic window that
    /// says only "something went wrong" would be the silent failure with extra
    /// steps.
    #[test]
    fn unavailable_page_carries_the_reason() {
        assert!(unavailable_page_html("sidecar port was None").contains("sidecar port was None"));
    }

    /// `reason` is not authored by us (it interpolates errors/URLs), so it must
    /// not be able to inject markup into the page.
    #[test]
    fn unavailable_page_escapes_html_in_the_reason() {
        let html = unavailable_page_html("<script>alert('x')</script> a & b");
        assert!(
            !html.contains("<script>alert"),
            "reason must not inject markup"
        );
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("a &amp; b"));
    }

    /// The data: URL must be well-formed and parse as a URL — `open_palette`
    /// feeds it straight to `url::Url::parse`, and a parse failure there would
    /// put us right back to showing the user nothing.
    #[test]
    fn unavailable_data_url_is_parseable_base64_html() {
        let u = unavailable_data_url("boom");
        assert!(u.starts_with("data:text/html;charset=utf-8;base64,"));
        assert!(
            u.parse::<url::Url>().is_ok(),
            "must parse — open_palette depends on it"
        );
        use base64::Engine as _;
        let payload = u.trim_start_matches("data:text/html;charset=utf-8;base64,");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .unwrap();
        let html = String::from_utf8(decoded).unwrap();
        assert!(html.contains("Quick Panel can’t open right now"));
        assert!(html.contains("boom"));
    }

    /// The diagnostic window MUST NOT share the palette's label: the reuse
    /// branch in open_palette would otherwise find the error window on the next
    /// press and reload the data: URL forever, permanently shadowing the real
    /// panel even after the operator recovered.
    #[test]
    fn diagnostic_window_label_is_distinct_from_the_palette() {
        assert_ne!(WINDOW_LABEL, UNAVAILABLE_WINDOW_LABEL);
    }
}
