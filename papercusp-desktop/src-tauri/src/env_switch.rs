//! env_switch — desktop-side env-target plumbing for the cross-platform
//! in-webview `EnvSwitcherBar` and its native backstop.
//!
//! This REPLACES two retired implementations: the Linux-only native GTK "dev
//! wrapper" bar (desktop-build-switcher-wrapper-2026-06-09) and the
//! chrome-webview experiment (persistent-env-bar-chrome-webview, which hit an
//! X11 `set_bounds` wall). The VISIBLE bar is now the single in-webview
//! `EnvSwitcherBar` (apps/operator-vite) on every platform; this module is:
//!
//!  - `list_envs` (command) — the AUTHORITATIVE env set + reachability, probed
//!    in Rust. The bar reads THIS, not a routable `/api` fetch, so a misrouted
//!    `/api` (Trap 5) or a bad target build can NEVER make it self-hide. On the
//!    dev box it lists all 4 TARGETS (never-hide floor); on a packaged (release)
//!    build — where "ALL INSTALLS ARE DOGFOOD INSTALLS" and provisioning spawns
//!    bundled per-branch sidecars — it lists only the REACHABLE envs.
//!  - `retarget_for_url` (on_page_load) — point `/api` at whatever env the
//!    webview navigated to + persist it, so the bar's `window.location` switch,
//!    the native backstop, and manual reloads all retarget `/api` with NO bar in
//!    the loop (this is the wiring the GTK bar's `switch_to` used to own).
//!  - `apply_persisted_target` (startup) — restore the last env + pin `/api`.
//!  - `navigate_to_env` — used by the native menu + global-shortcut backstop
//!    (the unkillable escape hatch if a target build white-screens).
//!  - `install_rail_signal` (Linux) — the document-start
//!    `__PAPERCUSP_DEV_WRAPPER__` user-script that flips operator-vite's
//!    DevAdminRail runtime gate.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tauri::Manager;

/// (display label, persisted name, port, hover tooltip). The dev-box builds.
/// `dev :3270` is the session's OWN working-tree operator; `prod :3070` the
/// deployed green-`main` release; `staging :3170` the integration tree; `local
/// :3055` the bare Vite HMR SPA (its `/api` proxies to the :3070 release).
const TARGETS: [(&str, &str, u16, &str); 4] = [
    (
        "dev",
        "dev",
        3270,
        "Dev operator (:3270) — this desktop session's OWN working-tree build, spawned with the dev shell and restarted by nothing else. /api also targets :3270. The default target.",
    ),
    (
        "prod",
        "prod",
        3070,
        "Production operator (:3070) — the deployed green-`main` release build (what the release pipeline auto-ships). /api targets :3070.",
    ),
    (
        "staging",
        "staging",
        3170,
        "Staging operator (:3170) — the shared integration-tree build (latest `staging`, ahead of the green release). /api targets :3170.",
    ),
    (
        "local",
        "local",
        3055,
        "Local Vite SPA (:3055) — the hot-reloading dev frontend with no operator of its own; its /api proxies to the :3070 release operator.",
    ),
];

fn fixed_targets_for_profile(
    profile: Option<&str>,
) -> &'static [(&'static str, &'static str, u16, &'static str)] {
    if profile == Some("vm-release") {
        &[]
    } else {
        &TARGETS
    }
}

fn fixed_targets() -> &'static [(&'static str, &'static str, u16, &'static str)] {
    let profile = std::env::var("PAPERCUSP_DISTRIBUTION_PROFILE").ok();
    fixed_targets_for_profile(profile.as_deref())
}

/// One env button the in-webview bar renders. Serialized camelCase for JS.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EnvInfo {
    pub id: String,
    pub label: String,
    pub port: u16,
    pub origin: String,
    pub tooltip: String,
    pub reachable: bool,
    pub is_self: bool,
}

/// EI-190: which operator serves `/api` for a given content target. :3055 (the
/// bare Vite SPA) has no operator of its own; its `/api` proxies to the :3070
/// release, so the green release operator backs it here too.
pub(crate) fn api_port_for_target(target_port: u16) -> u16 {
    if target_port == 3055 {
        3070
    } else {
        target_port
    }
}

// ---------------------------------------------------------------------------
// Persistence (~/.papercusp/desktop-build-target.json)
// ---------------------------------------------------------------------------

fn persisted_target_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join(".papercusp/desktop-build-target.json"))
}

/// The persisted target port (only if it's one of the known TARGETS), or None.
fn read_persisted_target() -> Option<u16> {
    let txt = std::fs::read_to_string(persisted_target_path()?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
    let port = v.get("port")?.as_u64()? as u16;
    fixed_targets()
        .iter()
        .any(|(_, _, p, _)| *p == port)
        .then_some(port)
}

fn write_persisted_target(name: &str, port: u16) {
    let Some(path) = persisted_target_path() else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let payload = serde_json::json!({ "name": name, "port": port });
    if let Err(e) = std::fs::write(&path, payload.to_string()) {
        eprintln!("[env-switch] could not persist build target: {e}");
    }
}

/// EI-296 escape hatch: `PAPERCUSP_DEV_API_TARGET=<port>` pins BOTH the content
/// webview and `/api` to an arbitrary localhost operator — an isolated test
/// stack or a fault proxy — bypassing the fixed TARGETS allowlist. Runtime-only:
/// it is NEVER persisted, so a test launch can't repoint the next launch. Ports
/// <1024 are rejected as obviously wrong.
fn env_api_target() -> Option<u16> {
    parse_api_target(std::env::var("PAPERCUSP_DEV_API_TARGET").ok())
}

fn startup_api_port(explicit_target: Option<u16>, current: u16) -> u16 {
    explicit_target.map(api_port_for_target).unwrap_or(current)
}

/// Prime the process-wide `/api` target before the dev endpoint-IPC
/// supervisor starts. `env_switch::init` applies the same override later when
/// it navigates the window, but letting the supervisor start first gives it a
/// real window to connect to the static :3070 default and hydrate live state
/// into an otherwise isolated test WebView.
pub(crate) fn prime_explicit_api_target() {
    let Some(target_port) = env_api_target() else {
        return;
    };
    let current = crate::SELECTED_API_PORT.load(Ordering::Relaxed);
    let api_port = startup_api_port(Some(target_port), current);
    crate::SELECTED_API_PORT.store(api_port, Ordering::Relaxed);
    println!(
        "[env-switch] PAPERCUSP_DEV_API_TARGET :{target_port} — primed /api :{api_port} before IPC supervisor"
    );
}

/// Accepts a bare port (`"3170"`), a `host:port` pair (`"127.0.0.1:3170"`), or a
/// full URL (`"http://127.0.0.1:3170"`) — the natural thing to pass, and what
/// docs/runbooks have specified — extracting the port from whichever form was
/// given. Ports <1024 are rejected as obviously wrong. When the env var IS set
/// but doesn't resolve to a usable port, this WARNS instead of silently
/// dropping the override (EI-729: a full-URL value used to silently no-op and
/// fall back to the default target with zero indication anything was wrong).
fn parse_api_target(raw: Option<String>) -> Option<u16> {
    let raw = raw?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let port = trimmed
        .parse::<u16>()
        .ok()
        .or_else(|| url::Url::parse(trimmed).ok().and_then(|u| u.port()))
        .or_else(|| {
            trimmed
                .rsplit_once(':')
                .and_then(|(_, p)| p.parse::<u16>().ok())
        });
    match port.filter(|p| *p >= 1024) {
        Some(p) => Some(p),
        None => {
            eprintln!(
                "[env-switch] PAPERCUSP_DEV_API_TARGET={trimmed:?} is not a usable port — accepts a bare port, host:port, or URL, all >=1024 — ignoring, falling back to the default target"
            );
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Probes + /api routing
// ---------------------------------------------------------------------------

fn port_reachable(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

/// Safety-ranked launch-default candidates (WI-3381): the env the webview
/// already loaded FIRST (on the dev box that's the dev operator the shell
/// spawned — devUrl `:3270`), then prod `:3070` (the deployed green-`main`
/// release), then staging `:3170`. De-duped, order preserved. Pure, so the
/// ranking is unit-tested without sockets.
///
/// NOTE: the only caller, `apply_persisted_target`, is DEV-ONLY (main.rs runs
/// `env_switch::init` inside `if is_dev`). Packaged installs pick their launch
/// env a different way — content boots to the bundled self operator, marked
/// `release` by the in-webview bar (WI-3284) — so this ranking never runs there.
fn ranked_default_candidates(current: Option<u16>) -> Vec<u16> {
    let mut ranked: Vec<u16> = Vec::with_capacity(3);
    if let Some(cur) = current {
        ranked.push(cur);
    }
    for p in [3070u16, 3170] {
        if !ranked.contains(&p) {
            ranked.push(p);
        }
    }
    ranked
}

/// The safest env that is actually REACHABLE (see `ranked_default_candidates`),
/// so the dev shell never strands `/api` on a dead port. Falls back to `:3070`
/// — the old unconditional default — when nothing answers, so `/api` always has
/// a definite target. `reachable` is injected for unit tests.
fn pick_default_target(current: Option<u16>, reachable: impl Fn(u16) -> bool) -> u16 {
    first_reachable(&ranked_default_candidates(current), reachable).unwrap_or(3070)
}

/// The first candidate the `reachable` predicate accepts, order preserved, or
/// `None`. Pure, so both the dev launch-default pick and the packaged boot
/// fallback share one unit-tested core (no sockets).
fn first_reachable(candidates: &[u16], reachable: impl Fn(u16) -> bool) -> Option<u16> {
    candidates.iter().copied().find(|p| reachable(*p))
}

/// The safest env that is actually up to FALL BACK to — prod `:3070` then
/// staging `:3170` — when the bundled self/release operator fails to boot, or
/// `None` when neither answers (the caller then shows the boot-error page).
/// Pointing content + `/api` here lands the user on the deployed release instead
/// of a dead-end error page, on every packaged platform (WI-3381, owner
/// directive 2026-07-08: "make this work on all platforms"). Called from
/// `finish_boot` (main.rs) — the shared packaged mac/win/linux boot path — so
/// unlike the dev-only `pick_default_target` this one DOES run in packaged
/// installs. Self is excluded: it just failed, so only the deployed fixed-port
/// envs are fallback candidates.
pub fn reachable_fallback_env() -> Option<u16> {
    if fixed_targets().is_empty() {
        return None;
    }
    first_reachable(&[3070, 3170], port_reachable)
}

/// Point `/api` at `target_port`'s operator (EI-190) + drop the live IPC
/// connection so the next call dials the selected operator's socket.
fn retarget_api(app: &tauri::AppHandle, target_port: u16) {
    let api_port = api_port_for_target(target_port);
    crate::SELECTED_API_PORT.store(api_port, Ordering::Relaxed);
    if let Some(ipc) = app.try_state::<Arc<crate::endpoint_ipc::IpcClientHandle>>() {
        ipc.reset();
        println!("[env-switch] /api target → :{api_port} (IPC re-dial)");
    } else {
        println!("[env-switch] /api target → :{api_port} (no IPC handle managed — HTTP only)");
    }
}

/// on_page_load(Started): if the webview navigated to a known env port, point
/// `/api` there + persist it. This is what makes the in-webview bar's
/// `window.location` switch (and the native backstop, and a manual reload)
/// follow through to `/api` — with NO bar in the loop. A
/// `PAPERCUSP_DEV_API_TARGET` pin (EI-296) is never overridden or persisted.
pub fn retarget_for_url(app: &tauri::AppHandle, url: &url::Url) {
    if env_api_target().is_some() {
        return;
    }
    let Some(port) = url.port() else { return };
    let Some((_, name, _, _)) = fixed_targets().iter().find(|(_, _, p, _)| *p == port) else {
        return;
    };
    retarget_api(app, port);
    write_persisted_target(name, port);
}

// ---------------------------------------------------------------------------
// Commands + navigation
// ---------------------------------------------------------------------------

/// Whether an env button should be surfaced by `list_envs`. On the dev box
/// (`dev_build`) every TARGET is listed — the never-hide floor; unreachable ones
/// render greyed. On a packaged (release) build only the envs that are actually
/// REACHABLE (or the one we're currently on) are listed, so a user install shows
/// just the envs it genuinely provisions (the bundled per-branch sidecars —
/// prod/staging) and never paints a ghost `dev`/`local` button for an env that
/// needs a source tree the package doesn't ship. Pure so it's unit-tested.
fn env_visible(dev_build: bool, reachable: bool, is_self: bool) -> bool {
    dev_build || reachable || is_self
}

/// The canonical env set the in-webview `EnvSwitcherBar` renders — the
/// AUTHORITATIVE source. The bar reads THIS (never a routable `/api` fetch), so
/// it can't self-hide on a `/api` routing glitch. On the dev box it returns all
/// 4 TARGETS (the never-hide floor — unreachable ones render greyed). On a
/// packaged (release) build it returns only the REACHABLE envs (+ the one we're
/// on): "ALL INSTALLS ARE DOGFOOD INSTALLS" (owner, 2026-07-06), so a user
/// install legitimately runs multiple envs (bundled per-branch sidecars —
/// prod/staging), but must not paint ghost dev/local buttons for envs that need a
/// source tree it doesn't ship. Reachability is probed here because Rust can
/// reach the sibling operators a webview can't (CORS).
#[tauri::command]
#[specta::specta]
pub fn list_envs(window: tauri::WebviewWindow) -> Vec<EnvInfo> {
    let dev_build = cfg!(debug_assertions);
    let cur = window.url().ok().and_then(|u| u.port());
    fixed_targets()
        .iter()
        .filter_map(|(label, name, port, tooltip)| {
            let reachable = port_reachable(*port);
            let is_self = cur == Some(*port);
            if !env_visible(dev_build, reachable, is_self) {
                return None;
            }
            Some(EnvInfo {
                id: (*name).to_string(),
                label: (*label).to_string(),
                port: *port,
                origin: format!("http://127.0.0.1:{port}"),
                tooltip: (*tooltip).to_string(),
                reachable,
                is_self,
            })
        })
        .collect()
}

/// Navigate the content webview to an env by port, carrying the current SPA
/// route + query. Driven from RUST (the global-shortcut escape hatch), so it
/// works even when the loaded build's own bar + IPC are dead; `/api` retargets
/// via on_page_load → `retarget_for_url`.
pub fn navigate_to_env(window: &tauri::WebviewWindow, port: u16) {
    let path_q = window
        .url()
        .ok()
        .map(|u| {
            let q = u.query().map(|q| format!("?{q}")).unwrap_or_default();
            format!("{}{}", u.path(), q)
        })
        .unwrap_or_else(|| "/".into());
    let target = format!("http://127.0.0.1:{port}{path_q}");
    match url::Url::parse(&target) {
        Ok(u) => {
            if let Err(e) = window.navigate(u) {
                eprintln!("[env-switch] shortcut navigate to {target} failed: {e}");
            } else {
                println!("[env-switch] shortcut switched content webview → {target}");
            }
        }
        Err(e) => eprintln!("[env-switch] bad shortcut url {target}: {e}"),
    }
}

/// The INVISIBLE escape hatch (no menu bar): OS-level global shortcuts
/// `CmdOrCtrl+Alt+1..4` → dev / prod / staging / local, handled in Rust so they
/// fire even when the switched-to build white-screens or breaks its IPC. Best-
/// effort — a shortcut the desktop environment already owns just won't register
/// (logged, not fatal). Dev-only.
pub fn register_backstop_shortcuts(app: &tauri::App) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let gs = app.global_shortcut();
    for (idx, (_, _, port, _)) in fixed_targets().iter().enumerate() {
        let accel = format!("CmdOrCtrl+Alt+{}", idx + 1);
        let p = *port;
        let res = gs.on_shortcut(accel.as_str(), move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Some(window) = app.get_webview_window("main") {
                    navigate_to_env(&window, p);
                }
            }
        });
        match res {
            Ok(()) => println!("[env-switch] escape-hatch shortcut {accel} → :{p}"),
            Err(e) => {
                eprintln!("[env-switch] shortcut {accel} not registered (DE may own it): {e}")
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/// Re-apply the persisted build target on launch (P-004) — only when it's
/// alive, so a stale selection can't boot into a blank webview. Either way,
/// point `/api` at the EFFECTIVE build (EI-190): the persisted target when
/// restored, else the default the webview actually shows.
pub fn apply_persisted_target(window: &tauri::WebviewWindow) {
    let app = window.app_handle();
    // EI-296: an explicit env target outranks the persisted selection. `/api`
    // is pinned even when the content navigation fails (the target may be a
    // fault proxy deliberately down mid-test); nothing is persisted.
    if let Some(port) = env_api_target() {
        if !port_reachable(port) {
            eprintln!("[env-switch] PAPERCUSP_DEV_API_TARGET :{port} is not reachable — pinning /api anyway, keeping default content");
        } else {
            let url = format!("http://127.0.0.1:{port}/");
            match url::Url::parse(&url)
                .map_err(|e| e.to_string())
                .and_then(|u| window.navigate(u).map_err(|e| e.to_string()))
            {
                Ok(()) => println!("[env-switch] PAPERCUSP_DEV_API_TARGET :{port} — content + /api pinned (not persisted)"),
                Err(e) => eprintln!("[env-switch] PAPERCUSP_DEV_API_TARGET :{port} navigate failed: {e}"),
            }
        }
        retarget_api(app, port);
        return;
    }
    // No explicit override: when there is no reachable persisted selection,
    // point `/api` at the SAFEST env that is actually UP (self:3270 → prod:3070
    // → staging:3170) rather than a hardcoded :3070 that won't match the dev
    // shell's content origin (devUrl :3270) — so `/api` follows the content
    // instead of stranding on a dead/mismatched port (WI-3381). DEV-ONLY: this
    // whole fn runs only under `if is_dev`; packaged installs default to
    // release=self via the boot flow + WI-3284, not this path.
    let current = window.url().ok().and_then(|u| u.port());
    let fallback = pick_default_target(current, port_reachable);
    let effective = 'restore: {
        let Some(port) = read_persisted_target() else {
            break 'restore fallback;
        };
        if current == Some(port) {
            break 'restore port;
        }
        if !port_reachable(port) {
            println!("[env-switch] persisted build target :{port} is down — falling back to the safest reachable env :{fallback}");
            break 'restore fallback;
        }
        let url = format!("http://127.0.0.1:{port}/");
        match url::Url::parse(&url)
            .map_err(|e| e.to_string())
            .and_then(|u| window.navigate(u).map_err(|e| e.to_string()))
        {
            Ok(()) => {
                println!("[env-switch] restored persisted build target :{port}");
                port
            }
            Err(e) => {
                eprintln!("[env-switch] could not restore target :{port}: {e}");
                fallback
            }
        }
    };
    retarget_api(app, effective);
}

/// Document-start user script that sets `window.__PAPERCUSP_DEV_WRAPPER__ =
/// true` on every navigation, flipping operator-vite's DevAdminRail runtime gate
/// on whichever build is loaded (production SPA builds included). WebKitGTK-only;
/// a no-op elsewhere (the rail's other gate, `MODE !== 'production'`, covers the
/// dev shells on every platform).
#[cfg(target_os = "linux")]
fn install_rail_signal(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        use webkit2gtk::{UserContentManagerExt, WebViewExt};
        let wv: webkit2gtk::WebView = webview.inner();
        match wv.user_content_manager() {
            Some(ucm) => {
                let script = webkit2gtk::UserScript::new(
                    "window.__PAPERCUSP_DEV_WRAPPER__ = true;",
                    webkit2gtk::UserContentInjectedFrames::TopFrame,
                    webkit2gtk::UserScriptInjectionTime::Start,
                    &[],
                    &[],
                );
                ucm.add_script(&script);
            }
            None => {
                eprintln!("[env-switch] no user_content_manager — dev-rail signal not installed")
            }
        }
    });
}

#[cfg(not(target_os = "linux"))]
fn install_rail_signal(_window: &tauri::WebviewWindow) {}

/// Startup hook (called from setup's dev path): install the dev-rail signal +
/// restore the persisted env target. Compiled on every platform; the caller
/// only runs it in dev.
pub fn init(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[env-switch] no main window — skipping startup");
        return;
    };
    install_rail_signal(&window);
    apply_persisted_target(&window);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_port_mapping() {
        assert_eq!(api_port_for_target(3070), 3070);
        assert_eq!(api_port_for_target(3170), 3170);
        assert_eq!(api_port_for_target(3270), 3270);
        // :3055 (bare Vite) has no operator — /api proxies to the :3070 release.
        assert_eq!(api_port_for_target(3055), 3070);
    }

    #[test]
    fn parse_api_target_rejects_low_ports() {
        assert_eq!(parse_api_target(Some("3170".into())), Some(3170));
        assert_eq!(parse_api_target(Some("  3070 ".into())), Some(3070));
        assert_eq!(parse_api_target(Some("80".into())), None);
        assert_eq!(parse_api_target(None), None);
    }

    #[test]
    fn parse_api_target_accepts_url_and_host_port_forms() {
        // EI-729: a full URL (the natural thing to pass, and what the e2e
        // runbook literally specifies) must extract the port, not silently
        // no-op back to the default target.
        assert_eq!(
            parse_api_target(Some("http://127.0.0.1:3370".into())),
            Some(3370)
        );
        assert_eq!(
            parse_api_target(Some("https://127.0.0.1:3370/adv".into())),
            Some(3370)
        );
        // Bare host:port (no scheme) also resolves.
        assert_eq!(parse_api_target(Some("127.0.0.1:3370".into())), Some(3370));
        // A URL/host:port whose port is below the floor is still rejected.
        assert_eq!(parse_api_target(Some("http://127.0.0.1:80".into())), None);
        // Garbage input (no parseable port anywhere) is rejected, not panics.
        assert_eq!(parse_api_target(Some("not-a-target".into())), None);
        assert_eq!(parse_api_target(Some("".into())), None);
    }

    #[test]
    fn explicit_api_target_is_primed_before_ipc_start() {
        assert_eq!(startup_api_port(Some(3370), 3070), 3370);
        // The bare Vite target has no operator and deliberately maps to prod.
        assert_eq!(startup_api_port(Some(3055), 3170), 3070);
        // Without an explicit override, preserve the already-selected target.
        assert_eq!(startup_api_port(None, 3170), 3170);
    }

    #[test]
    fn ranked_candidates_put_self_first_then_prod_then_staging() {
        // The loaded env (self/release) ranks first, then prod, then staging.
        assert_eq!(
            ranked_default_candidates(Some(3270)),
            vec![3270, 3070, 3170]
        );
        // A self that IS prod/staging isn't duplicated — order still preserved.
        assert_eq!(ranked_default_candidates(Some(3070)), vec![3070, 3170]);
        assert_eq!(ranked_default_candidates(Some(3170)), vec![3170, 3070]);
        // No loaded port yet → just the fixed prod-then-staging ranking.
        assert_eq!(ranked_default_candidates(None), vec![3070, 3170]);
    }

    #[test]
    fn pick_default_target_picks_safest_reachable() {
        // Self reachable → boot self/release (the safest, top-ranked env).
        assert_eq!(pick_default_target(Some(3270), |p| p == 3270), 3270);
        // Self down, prod up → prod.
        assert_eq!(pick_default_target(Some(3270), |p| p == 3070), 3070);
        // Self + prod down, staging up → staging.
        assert_eq!(pick_default_target(Some(3270), |p| p == 3170), 3170);
        // Nothing reachable → the old unconditional default :3070 (definite
        // /api target) rather than a dead self port.
        assert_eq!(pick_default_target(Some(3270), |_| false), 3070);
        // No loaded port, prod up → prod.
        assert_eq!(pick_default_target(None, |p| p == 3070), 3070);
    }

    #[test]
    fn first_reachable_returns_first_accepted_in_order() {
        // Order is preserved — the first accepted candidate wins.
        assert_eq!(first_reachable(&[3070, 3170], |_| true), Some(3070));
        assert_eq!(first_reachable(&[3070, 3170], |p| p == 3170), Some(3170));
        // Nothing reachable → None (the boot fallback then shows the error page).
        assert_eq!(first_reachable(&[3070, 3170], |_| false), None);
        assert_eq!(first_reachable(&[], |_| true), None);
    }

    #[test]
    fn env_visibility_dev_vs_packaged() {
        // Dev box: the never-hide floor — every env is listed regardless of
        // reachability (unreachable ones just render greyed in the bar).
        assert!(env_visible(true, false, false));
        assert!(env_visible(true, true, false));

        // Packaged (release): only reachable envs, or the one we're on, surface —
        // so a user install never paints a ghost dev/local button for an env it
        // can't provision (no source tree ⇒ that sidecar never comes up).
        assert!(!env_visible(false, false, false)); // unreachable + not self → hidden
        assert!(env_visible(false, true, false)); // a provisioned bundled sidecar → shown
        assert!(env_visible(false, false, true)); // the env we're currently on → always shown
    }

    #[test]
    fn vm_release_has_no_fixed_dogfood_environment_targets() {
        assert!(fixed_targets_for_profile(Some("vm-release")).is_empty());
        assert_eq!(fixed_targets_for_profile(Some("dogfood")).len(), 4);
        assert_eq!(fixed_targets_for_profile(None).len(), 4);
    }
}
