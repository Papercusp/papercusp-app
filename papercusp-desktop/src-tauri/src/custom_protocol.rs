//! Phase 4 — `papercusp://` custom URI scheme: take the webview off HTTP.
//!
//! Plan: `desktop-ipc-transport-completion-2026-05-20.md` (Phase 4).
//!
//! Phases 1–3 moved the webview's `fetch` / `EventSource` traffic onto the
//! IPC bridge, but the webview still loads its *page + assets* over
//! `http://localhost:<port>/…`. This module closes that last gap: when
//! `PAPERCUSP_DESKTOP_CUSTOM_PROTOCOL=1`, the main window loads
//! `papercusp://localhost/…` and this handler forwards each page/asset
//! request to the operator's own loopback HTTP base, relaying the response.
//! The *webview* then opens zero HTTP connections — the Rust→sidecar hop is
//! an internal loopback, not subject to the browser's per-host pool (the
//! connection-pool bug the plan set out to kill).
//!
//! The operator SPA's own `/api/*` `fetch` + `EventSource` calls do NOT
//! reach this handler: under the new `papercusp://localhost` origin they are
//! still same-origin `/api/*`, so the desktop-ipc polyfill intercepts them
//! and routes them over IPC exactly as before (see
//! `@papercusp/desktop-ipc`'s `desktop-bootstrap.ts`). This handler only
//! ever serves what the browser loads directly: the document and the
//! JS/CSS/font/image chunks — all GETs, all bufferable.
//!
//! DEFAULT-ON (shipped 2026-06-01). The scheme was live-verified end-to-end
//! by driving the running webview via the dev-shell bridge on GL hardware:
//! navigated the top frame onto `papercusp://localhost`, confirmed the SPA
//! rendered (origin `papercusp://localhost`, secure context, `crypto.subtle`)
//! and that the same-origin `/api` round-trips through the desktop-ipc
//! polyfill (200). Rollback is a single env var: set
//! `PAPERCUSP_DESKTOP_CUSTOM_PROTOCOL=0` to point the window back at
//! `http://localhost:<port>` (see `enabled()`).
//!
//! STREAMING CAVEAT: this handler buffers (`reqwest::blocking` + `.bytes()`)
//! and Tauri's URI-scheme responder is itself buffered (`Response<Vec<u8>>`,
//! no streaming API), so SSE under `papercusp://` must ride the IPC polyfill
//! (`sys:http`), not this handler. That holds as long as the desktop-ipc IPC
//! handshake succeeds in the packaged sidecar; if IPC is unavailable the SPA's
//! `/api` falls back to this buffering handler and SSE would not stream.

use tauri::http::{Request, Response};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder, Wry};

use crate::SidecarState;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CspPolicy {
    enforcing_header: String,
    report_only_header: String,
    enforcing_policy: String,
    report_only_policy: String,
}

fn csp_policy() -> &'static CspPolicy {
    static POLICY: std::sync::OnceLock<CspPolicy> = std::sync::OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../libs/generic/desktop-ipc/src/csp-policy.json"
        ))
        .expect("shared desktop CSP policy must be valid JSON")
    })
}

/// Attach the shared D-002 policy pair to document responses only. Code/content
/// origins enforce; the strict local-only connection policy remains report-only
/// so preserved voice signaling is observed without being blocked. CSP on a
/// script, stylesheet, image, or font response has no effect.
fn with_csp(mut response: Response<Vec<u8>>) -> Response<Vec<u8>> {
    let is_html = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/html"));
    if is_html {
        let policy = csp_policy();
        for (name, value) in [
            (&policy.enforcing_header, &policy.enforcing_policy),
            (&policy.report_only_header, &policy.report_only_policy),
        ] {
            let header_name = tauri::http::header::HeaderName::from_bytes(name.as_bytes())
                .expect("shared desktop CSP header name must be valid");
            let header_value = tauri::http::header::HeaderValue::from_str(value)
                .expect("shared desktop CSP policy must be a valid header value");
            response.headers_mut().insert(header_name, header_value);
        }
    }
    response
}

/// The scheme name. On Windows/Android Tauri maps custom schemes onto
/// `http://papercusp.localhost`; on Linux/macOS it is `papercusp://localhost`.
pub const SCHEME: &str = "papercusp";

/// Whether the window loads `papercusp://localhost` instead of the HTTP base.
///
/// DEFAULT: **Linux only** — for ONE surviving reason, not the two this comment
/// used to give. The custom scheme exists to dodge WebKitGTK's ~6-connection
/// libsoup pool cap (the connection-pool bug this scheme was built to kill) — a
/// WebKitGTK/Linux problem. macOS `WKWebView` and Windows `WebView2` have no
/// such cap, so the scheme buys them nothing. **That reason stands.**
///
/// ⚠ The second reason — "AND the buffered scheme handler renders a BLANK
/// webview there (found live 2026-07-01 on macOS)" — is **REFUTED**. P-017
/// re-tested on REAL hardware 2026-08-03: macOS/WKWebView mounts and fully
/// renders under `papercusp://localhost`, and Windows/WebView2 under
/// `http://papercusp.localhost` (D-054, `no-http-anywhere-2026-07-28`; the
/// Windows half was already refuted 2026-07-04 by WI-2734). The 2026-07-01
/// observation was confounded — `install_load_failure_recovery` is Linux-only
/// (EI-19425361953094049), so any operator boot-race presents as a permanent
/// blank window that is indistinguishable from a scheme failure.
///
/// So the default stays Linux-only because the scheme is POINTLESS elsewhere,
/// not because it is BROKEN elsewhere. Flipping it is P-031, gated on the
/// packaged E2E battery under the override plus cross-platform load-failure
/// recovery.
///
/// Explicit override wins on every platform: `PAPERCUSP_DESKTOP_CUSTOM_PROTOCOL=1`
/// forces it on, `=0` forces it off. With NO override the default is
/// **Linux-only ON**, because neither macOS nor Windows has the WebKitGTK
/// connection-pool cap the scheme exists to dodge, so they ride HTTP by default.
/// (The "render the buffered scheme handler BLANK" rationale that used to appear
/// here is REFUTED — see the note above.)
///
/// (Before this, the default was ON on every platform — the documented
/// Linux-only intent above was never implemented, which shipped a blank webview
/// in the packaged macOS app. Note the CAUSE of that blank is now in doubt: the
/// scheme itself renders fine on real macOS hardware, so the 2026-07-01 blank is
/// better explained by the missing cross-platform load-failure recovery. The
/// LESSON stands regardless, and is why `scheme_default` is a pure function with
/// Linux-runnable tests: an intent expressed only in a `cfg!` + a docstring is
/// an intent nothing verifies.)
pub fn enabled() -> bool {
    scheme_default(
        std::env::var("PAPERCUSP_DESKTOP_CUSTOM_PROTOCOL")
            .ok()
            .as_deref(),
        std::env::consts::OS,
    )
}

/// Pure decision behind [`enabled()`]: does the window default to the
/// `papercusp://` scheme, given an explicit env override and the target OS?
///
/// Kept free of `env` / `cfg!` reads so it is unit-testable for EVERY platform
/// from CI — which builds on Linux and so can NEVER exercise the macOS/Windows
/// `cfg!` arm directly. The blank-macOS-webview regression (2026-07-01) shipped
/// precisely because the Linux-only intent lived only in a `cfg!` + a docstring,
/// with no test the Linux CI host could run. `target_os` takes the values of
/// [`std::env::consts::OS`] (`"linux"`, `"macos"`, `"windows"`, …), so
/// `enabled()` stays byte-for-byte equivalent to the old `cfg!(target_os = …)`.
fn scheme_default(env_override: Option<&str>, target_os: &str) -> bool {
    match env_override {
        Some("1") => true,
        Some("0") => false,
        _ => target_os == "linux",
    }
}

/// Whether the bundled-SPA custom-protocol origin is used for the **pre-operator**
/// phase: register the scheme handler, point the window at [`APP_ORIGIN`] before
/// any operator is up, and serve the bundled onboarding SPA from disk
/// ([`serve_bundled_spa`]). This is DISTINCT from [`enabled()`], which decides
/// whether the scheme is ALSO the *steady-state* origin.
///
/// DEFAULT: **Linux + Windows**.
///   - Linux: same as [`enabled()`] — the scheme is the app origin throughout.
///   - Windows: a fresh machine has NO operator until the user drives the WSL
///     onboarding gate (`WslOnboardingGate`, `wsl_install`/`import`/`bootstrap`
///     `#[tauri::command]`s), and that gate lives in the bundled SPA which ONLY
///     this handler serves pre-operator. WebView2 renders the mapped
///     `http://papercusp.localhost` origin fine — **verified live 2026-07-04 on
///     the Windows VM** (WI-2734): the gate rendered ("Papercup setup — Windows"),
///     0 console errors/exceptions. The earlier "WebView2 renders the scheme
///     blank" note was over-generalized from macOS WKWebView. WITHOUT this,
///     the window strands on the dead `:3070` frontendDist, the gate never
///     renders, WSL never bootstraps, and the GUI FATALs at 120s — the shipped
///     Windows first-run dead-end.
///   - macOS: **NO** — but NOT for the reason this comment used to give. The
///     "WKWebView renders the raw `papercusp://` scheme blank (verified live
///     2026-07-01)" claim is **REFUTED**: P-017 re-tested on REAL macOS
///     hardware 2026-08-03 and WKWebView mounts and fully renders under
///     `papercusp://localhost` (D-054, `no-http-anywhere-2026-07-28`). The
///     2026-07-01 observation was confounded — see the note on
///     `install_load_failure_recovery` being Linux-only
///     (EI-19425361953094049), which makes any operator boot-race present as a
///     permanent blank window and is indistinguishable from a scheme failure.
///     What SURVIVES as the reason to stay off: macOS has no long pre-operator
///     onboarding (the operator spawns natively), so the bundled bootstrap page
///     already covers it — this default buys nothing here. Flipping it is
///     P-031, gated on the packaged E2E battery under the override.
///
/// Post-operator the window still navigates to the real loopback HTTP port on
/// Windows/macOS (see `point_window_at_operator` gated on [`enabled()`]), so
/// steady-state SSE streams natively rather than through this buffered handler.
///
/// ⚠ The trailing clause here used to read "which matters on Windows where
/// endpoint-IPC is unavailable (the WSL operator publishes a Unix socket the
/// Windows host rejects)". That is **STALE** — WI-3395 fixed exactly this. The
/// launcher now sets `PAPERCUSP_IPC_TCP=1` across `WSLENV` when routing via
/// WSL, so the sidecar binds `tcp://127.0.0.1:0` instead of a Unix socket and
/// the Windows host dials it as loopback TCP (`IpcStream::Tcp`,
/// `endpoint_ipc.rs`). Endpoint-IPC IS available on Windows, and that TCP path
/// is what lights up the `/api` connection-cap bypass there (D-065/D-066,
/// `no-http-anywhere-2026-07-28`).
///
/// Same explicit env override as [`enabled()`]: `=1` forces on, `=0` forces off.
pub fn onboarding_origin_enabled() -> bool {
    onboarding_origin_default(
        std::env::var("PAPERCUSP_DESKTOP_CUSTOM_PROTOCOL")
            .ok()
            .as_deref(),
        std::env::consts::OS,
    )
}

/// Pure decision behind [`onboarding_origin_enabled()`] — kept `env`/`cfg!`-free
/// so CI (which builds on Linux) can exercise the Windows/macOS arms it can never
/// reach through a raw `cfg!(target_os)`, exactly as [`scheme_default`] does.
fn onboarding_origin_default(env_override: Option<&str>, target_os: &str) -> bool {
    match env_override {
        Some("1") => true,
        Some("0") => false,
        _ => matches!(target_os, "linux" | "windows"),
    }
}

/// The origin the window is pointed at when `enabled()`.
///
/// WebKitGTK (Linux) and WKWebView (macOS) load registered schemes as raw
/// `papercusp://` URLs; WebView2 (Windows) instead maps them onto
/// `http://<scheme>.localhost` (`useHttpsScheme: false` default) — a raw
/// `papercusp://localhost` navigation there silently no-ops and the window
/// stays on whatever it was showing (found live 2026-06-11, run 8).
#[cfg(not(target_os = "windows"))]
pub const APP_ORIGIN: &str = "papercusp://localhost";
#[cfg(target_os = "windows")]
pub const APP_ORIGIN: &str = "http://papercusp.localhost";

/// Resolve the upstream loopback base this handler forwards to.
///   - Packaged: the spawned sidecar's picked port (`SidecarState.port`).
///   - Dev / no-sidecar: `PAPERCUSP_CUSTOM_PROTOCOL_UPSTREAM` override, else
///     (dev builds only) the dev-nohmr Hono host on :3070.
///   - Packaged with NO sidecar yet (Windows pre-onboarding): None — the
///     handler serves the BUNDLED SPA statics instead (see serve_bundled_spa).
fn upstream_base(app: &tauri::AppHandle) -> Option<String> {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(guard) = state.port.lock() {
            if let Some(port) = *guard {
                return Some(format!("http://127.0.0.1:{}", port));
            }
        }
    }
    if let Ok(upstream) = std::env::var("PAPERCUSP_CUSTOM_PROTOCOL_UPSTREAM") {
        return Some(upstream);
    }
    // WI-3282 self-heal: SidecarState.port can be left None on a packaged build
    // when the boot-time discovery poll (or the restart watcher) fails to latch
    // the port — observed live on the Linux deb: the operator was HEALTHY on its
    // picked port, but the port was never stored, so upstream_base returned None,
    // serve_bundled_spa answered every /api with 503, and onboarding hung forever
    // on "Starting onboarding…". Re-resolve the live port from the operator's
    // discovery file on each miss (only reached when the fast path above is None),
    // so /api follows the running operator instead of dead-ending the whole app.
    if let Some(port) = crate::operator_discovery_port_from_home() {
        // LATCH it (WI-37798): this branch is reached per /api request while the
        // port is unlatched, and on Windows each re-resolve is a `wsl.exe` spawn.
        // Storing it promotes every subsequent request to the fast path above, so
        // the self-heal costs one probe rather than one per request. Only fills a
        // None — never overwrites a port the boot/restart watcher owns.
        if let Some(state) = app.try_state::<SidecarState>() {
            if let Ok(mut guard) = state.port.lock() {
                if guard.is_none() {
                    *guard = Some(port);
                }
            }
        }
        return Some(format!("http://127.0.0.1:{}", port));
    }
    if cfg!(debug_assertions) {
        return Some("http://127.0.0.1:3070".to_string());
    }
    None
}

/// Serve the webview straight off the bundled SPA dist (sidecar/spa/**) —
/// the pre-operator path AND (EI-18892233692082064) the operator-forward-failed
/// fallback for document navigations. On a clean Windows machine the sidecar
/// can't spawn until WSL onboarding finishes, but the onboarding UI
/// (WslOnboardingGate, mounted in the SPA's __root) needs the SPA rendered
/// to exist; separately, `forward()` also calls this when a *known* upstream
/// port fails to answer the document request (connect error / 5xx) so a
/// transient sidecar miss shows the bundled shell (which can retry / show its
/// own connection state) instead of a plaintext 502 that bricks the window
/// forever. Statics come from disk; /api/* answers 503 so the frontend sees
/// clean fetch failures instead of HTML-shaped JSON. (D-009)
///
/// Thin `tauri::AppHandle`-resolving wrapper around [`render_bundled_spa`] —
/// the app-independent core the unit tests below exercise directly against a
/// real temp directory, mirroring [`try_serve_static_asset`] /
/// [`resolve_static_or_forward`]'s split (WI-3225).
fn serve_bundled_spa(app: &tauri::AppHandle, path: &str) -> Response<Vec<u8>> {
    use tauri::Manager;
    let spa_root = match app
        .path()
        .resolve("sidecar/spa", tauri::path::BaseDirectory::Resource)
    {
        Ok(p) => p,
        Err(e) => return error_response(500, &format!("papercusp: no bundled spa: {e}")),
    };
    render_bundled_spa(&spa_root, path)
}

/// The app-independent core of [`serve_bundled_spa`]: given an already-resolved
/// SPA root and the request path, serve the bundled onboarding/fallback SPA from
/// disk. `/api/*` answers 503 (clean fetch failure, not HTML-shaped JSON); a
/// nonexistent / route-shaped path falls back to `index.html` (SPA routing).
fn render_bundled_spa(spa_root: &std::path::Path, path: &str) -> Response<Vec<u8>> {
    if path.starts_with("/api/") || path == "/api" {
        return error_response(503, "papercusp: operator not running yet (pre-onboarding)");
    }
    // Normalize + reject traversal. Windows ALSO treats `\` as a separator
    // and `join` with an absolute/drive path REPLACES the base, so reject
    // those shapes outright, then enforce containment on the canonicalized
    // path (covers symlinks). Bare "/" and unknown extension-less paths
    // (SPA routes) fall back to index.html.
    let rel = path.trim_start_matches('/');
    if rel
        .split(['/', '\\'])
        .any(|seg| seg == ".." || seg.contains(':'))
        || std::path::Path::new(rel).is_absolute()
    {
        return error_response(400, "papercusp: bad path");
    }
    let spa_root_canon = match std::fs::canonicalize(spa_root) {
        Ok(p) => p,
        Err(e) => return error_response(500, &format!("papercusp: spa root unreadable: {e}")),
    };
    let mut file = spa_root.join(rel);
    // Nonexistent path = SPA route → index.html; an existing path must
    // canonicalize INSIDE the spa root.
    if rel.is_empty() || !file.is_file() {
        file = spa_root.join("index.html");
    }
    match std::fs::canonicalize(&file) {
        Ok(canon) if canon.starts_with(&spa_root_canon) => {}
        Ok(_) => return error_response(400, "papercusp: bad path"),
        Err(e) => return error_response(404, &format!("papercusp: {e}")),
    }
    let body = match std::fs::read(&file) {
        Ok(b) => b,
        Err(e) => return error_response(404, &format!("papercusp: {e}")),
    };
    let response = Response::builder()
        .status(200)
        .header("content-type", mime_for(&file))
        .body(body)
        .unwrap_or_else(|_| error_response(500, "papercusp: failed to build static response"));
    with_csp(response)
}

/// MIME type for a bundled static file, by extension.
fn mime_for(file: &std::path::Path) -> &'static str {
    match file.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" | "map" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// EI-18892233692082064: is `path` a top-level document / SPA-route navigation
/// (i.e. NOT an `/api/*` request)? `forward()` falls back to the bundled SPA
/// ([`serve_bundled_spa`]) for this class of request when the operator forward
/// fails outright (connect error) or answers 5xx — the document is the single
/// request whose failure cannot be recovered from (nothing reloads a plaintext
/// 502 body), whereas an `/api/*` failure is left to the caller (the SPA's own
/// fetch/IPC-polyfill error handling) exactly as before.
fn is_document_navigation(path: &str) -> bool {
    !(path == "/api" || path.starts_with("/api/"))
}

/// Fix B (WI-2902): is `path` eligible to be served from the bundled SPA on disk
/// instead of forwarded to the operator? True for concrete asset paths; false for
/// `/api*`, the document root, and empty — those keep forwarding (index.html may
/// carry operator-side injection; SPA routes need the served shell). Pure (no
/// fs/env reads) so CI can exercise it; the actual disk-serve additionally requires
/// the path to resolve to a real bundled file (see [`try_serve_static_asset`]).
fn is_static_asset_path(path: &str) -> bool {
    !(path.is_empty() || path == "/" || path == "/api" || path.starts_with("/api/"))
}

/// Fix B (WI-2902): serve an EXISTING bundled static file (`sidecar/spa/**`, e.g.
/// the hashed `/assets/*` JS/CSS chunks, fonts, images) straight from disk. Returns
/// `None` for `/api`, the root / SPA routes, path traversal, or any path that is not
/// a real file — those fall through to the operator forward in [`forward`].
///
/// WHY: [`forward`] relayed every page/asset load to the operator over
/// `reqwest::blocking`; under the concurrent chunk burst on initial load / reload
/// (~100+ hashed chunks at once) that forward flaked, a module script failed, and
/// the SPA error boundary showed the full-screen "This view hit an error" card on
/// BOTH the .deb and the AppImage. Bundled chunks are immutable + byte-identical to
/// what the operator would serve, so disk-serving them removes the operator and the
/// flaky forward from the chunk-load critical path (and makes chunk loads
/// independent of operator readiness, subsuming the fresh-boot race Fix A softened).
/// index.html is deliberately NOT disk-served here — it stays forwarded so any
/// operator-side templating is preserved; it is a single request, not the burst.
///
/// This is now a thin `tauri::AppHandle`-resolving wrapper around
/// [`resolve_static_or_forward`] — the app-independent core that actually decides +
/// performs the disk serve, and that unit tests below exercise directly against a
/// real temp directory (WI-3225: the pure `is_static_asset_path` gate alone didn't
/// guard the end-to-end wiring — the method check, traversal/containment
/// enforcement, and the disk read itself — so a refactor could silently drop or
/// reorder any of that here without a single test failing).
fn try_serve_static_asset(
    app: &tauri::AppHandle,
    method: &str,
    path: &str,
) -> Option<Response<Vec<u8>>> {
    let spa_root = app
        .path()
        .resolve("sidecar/spa", tauri::path::BaseDirectory::Resource)
        .ok()?;
    resolve_static_or_forward(&spa_root, method, path)
}

/// The app-independent core of [`try_serve_static_asset`]: given an already-resolved
/// SPA root, the request method, and the URI path, decide whether the request should
/// be served straight from disk — and if so, do it. Kept free of `tauri::AppHandle`
/// (which can't be constructed in a plain unit test without the "test" cargo feature)
/// so it is directly unit-testable against a real temp directory: real bytes, real
/// mime types, real traversal/symlink checks, AND the method + path gating order that
/// [`forward`] relies on to short-circuit the flaky operator forward — not just the
/// pure boolean [`is_static_asset_path`] gate. `forward()` calls [`try_serve_static_asset`]
/// unconditionally now (no separate outer `if method == "GET"` guard), so the ONLY way
/// to silently drop this short-circuit is to delete that one call — a much more visible
/// change than reordering/loosening a guard inside a larger function.
fn resolve_static_or_forward(
    spa_root: &std::path::Path,
    method: &str,
    path: &str,
) -> Option<Response<Vec<u8>>> {
    if method != "GET" || !is_static_asset_path(path) {
        return None;
    }
    // Normalize + reject traversal / absolute / drive-letter shapes (same rules as
    // serve_bundled_spa), then enforce containment on the canonicalized path.
    let rel = path.trim_start_matches('/');
    if rel
        .split(['/', '\\'])
        .any(|seg| seg == ".." || seg.contains(':'))
        || std::path::Path::new(rel).is_absolute()
    {
        return None;
    }
    let file = spa_root.join(rel);
    if !file.is_file() {
        return None; // SPA route / missing → forward (operator serves index.html)
    }
    let spa_root_canon = std::fs::canonicalize(spa_root).ok()?;
    let canon = std::fs::canonicalize(&file).ok()?;
    if !canon.starts_with(&spa_root_canon) {
        return None; // symlink escape — don't serve
    }
    let body = std::fs::read(&canon).ok()?;
    let response = Response::builder()
        .status(200)
        .header("content-type", mime_for(&canon))
        .body(body)
        .ok()?;
    Some(with_csp(response))
}

/// Async URI-scheme handler. Forwards the request to the loopback base on a
/// worker thread (blocking HTTP client) and responds when it returns, so the
/// webview's UI thread is never blocked.
pub fn handle(
    ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    std::thread::spawn(move || {
        responder.respond(forward(&app, request));
    });
}

fn forward(app: &tauri::AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    // Fix B (WI-2902): serve immutable bundled static assets (the hashed /assets/*
    // JS/CSS chunks, fonts, images) straight from disk, bypassing the operator
    // forward below. Under the concurrent chunk burst on initial load / reload
    // (~100+ hashed chunks at once) that `reqwest::blocking` forward flaked — a
    // module script failed to load and the SPA error boundary showed the
    // full-screen "This view hit an error" card on BOTH the .deb and the AppImage.
    // Bundled chunks are byte-identical to what the operator would serve, so
    // disk-serving them removes the operator + the flaky forward from the chunk
    // critical path (and makes chunk loads independent of operator readiness,
    // subsuming the fresh-boot race Fix A softened). Only GET (assets are never
    // mutated); index.html / SPA routes / /api* return None here and fall through
    // to the forward below so any operator-side templating + IPC polyfill stay
    // intact. The method + path gating lives inside try_serve_static_asset /
    // resolve_static_or_forward (WI-3225) — this call site is now unconditional so
    // the short-circuit can't be silently narrowed by touching only this line.
    if let Some(resp) = try_serve_static_asset(app, request.method().as_str(), request.uri().path())
    {
        return resp;
    }

    // papercusp://localhost/<path>?<query>  →  <base>/<path>?<query>
    let path = request.uri().path().to_string();
    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let Some(base) = upstream_base(app) else {
        return serve_bundled_spa(app, &path);
    };
    let target = format!("{}{}", base, path_and_query);

    let client = match reqwest::blocking::Client::builder()
        // The webview always reloads from the sidecar; never cache stale assets.
        .timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(e) => return error_response(502, &format!("papercusp: client init failed: {e}")),
    };

    let debug = std::env::var("PAPERCUSP_CUSTOM_PROTOCOL_DEBUG")
        .ok()
        .as_deref()
        == Some("1");
    if debug {
        eprintln!(
            "[custom_protocol] {} {} → {}",
            request.method().as_str(),
            path_and_query,
            target
        );
    }

    let method = reqwest::Method::from_bytes(request.method().as_str().as_bytes())
        .unwrap_or(reqwest::Method::GET);
    let mut req = client.request(method, &target);

    // Forward request headers verbatim, except:
    //   - `host`: reqwest derives it from the target.
    //   - `accept-encoding`: drop it so the upstream replies uncompressed —
    //     this client doesn't decode, and re-buffering a compressed body
    //     while relaying its `content-encoding` is a footgun. Loopback has
    //     no bandwidth cost, so plain is simplest + correct.
    for (k, v) in request.headers() {
        let name = k.as_str();
        if name.eq_ignore_ascii_case("host") || name.eq_ignore_ascii_case("accept-encoding") {
            continue;
        }
        req = req.header(name, v.as_bytes());
    }

    if !request.body().is_empty() {
        req = req.body(request.body().clone());
    }

    match req.send() {
        Ok(up) => {
            let status = up.status().as_u16();
            // EI-18892233692082064: an upstream 5xx for the document/SPA-route
            // navigation is just as unrecoverable to the webview as a connect
            // error below — fall back to the bundled SPA rather than turning a
            // transient sidecar hiccup into a permanently-bricked plaintext
            // error page. /api/* failures are left exactly as before (status
            // relayed to the caller unchanged) — those have their own
            // fetch/IPC-polyfill error handling on the JS side.
            if status >= 500 && is_document_navigation(&path) {
                if debug {
                    eprintln!(
                        "[custom_protocol]   ← {} {} — document nav, falling back to bundled SPA",
                        status, path_and_query
                    );
                }
                return serve_bundled_spa(app, &path);
            }
            let headers = up.headers().clone();
            let body = up.bytes().map(|b| b.to_vec()).unwrap_or_default();
            if debug {
                eprintln!(
                    "[custom_protocol]   ← {} {} ({} bytes)",
                    status,
                    path_and_query,
                    body.len()
                );
            }

            let mut builder = Response::builder().status(status);
            for (k, v) in headers.iter() {
                // Strip hop-by-hop + length/encoding framing headers — the
                // body is fully buffered, so Tauri sets the correct length;
                // a forwarded `content-length`/`transfer-encoding` would lie.
                let lname = k.as_str().to_ascii_lowercase();
                if matches!(
                    lname.as_str(),
                    "content-length" | "transfer-encoding" | "connection" | "keep-alive"
                ) {
                    continue;
                }
                builder = builder.header(k.as_str(), v.as_bytes());
            }
            let response = builder
                .body(body)
                .unwrap_or_else(|_| error_response(500, "papercusp: failed to build response"));
            with_csp(response)
        }
        Err(e) => {
            // EI-18892233692082064: a connect/timeout failure on the document
            // request otherwise bricks the window permanently (no retry, no
            // reload, no error UI — see the module doc). Fall back to the
            // bundled SPA for document navigations so the app can still boot
            // and show its own connection state; /api/* failures still relay
            // the 502 to the caller unchanged.
            if is_document_navigation(&path) {
                if debug {
                    eprintln!(
                        "[custom_protocol]   ← upstream error for {} ({e}) — document nav, falling back to bundled SPA",
                        path_and_query
                    );
                }
                return serve_bundled_spa(app, &path);
            }
            error_response(502, &format!("papercusp: upstream error: {e}"))
        }
    }
}

fn error_response(status: u16, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .body(msg.as_bytes().to_vec())
        .expect("static error response always builds")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_response_sets_status_and_plaintext_body() {
        let r = error_response(404, "nope");
        assert_eq!(r.status().as_u16(), 404);
        assert_eq!(
            r.headers().get("content-type").unwrap().to_str().unwrap(),
            "text/plain; charset=utf-8",
        );
        assert_eq!(String::from_utf8_lossy(r.body()), "nope");
    }

    #[test]
    fn error_response_carries_arbitrary_status_and_message() {
        let r = error_response(502, "papercusp: upstream error: boom");
        assert_eq!(r.status().as_u16(), 502);
        assert_eq!(
            String::from_utf8_lossy(r.body()),
            "papercusp: upstream error: boom",
        );
    }

    // --- document-navigation fallback eligibility (EI-18892233692082064) ---
    // is_document_navigation is the pure gate deciding whether forward() falls back
    // to the bundled SPA (instead of relaying a plaintext error page) when the
    // upstream forward fails outright or answers 5xx. Every non-/api path — the
    // document root, SPA routes, and even asset-shaped paths (which would normally
    // be intercepted earlier by try_serve_static_asset, but a defense-in-depth gate
    // here still must agree) — is a document navigation; /api* must NOT be, since
    // those failures are left to the SPA's own fetch/IPC-polyfill error handling.

    #[test]
    fn document_navigation_covers_root_and_spa_routes() {
        assert!(is_document_navigation("/"));
        assert!(is_document_navigation(""));
        assert!(is_document_navigation("/adv"));
        assert!(is_document_navigation("/harness/some-slug"));
        assert!(is_document_navigation("/assets/index-a1b2c3.js"));
    }

    #[test]
    fn document_navigation_excludes_api_paths() {
        assert!(!is_document_navigation("/api"));
        assert!(!is_document_navigation("/api/health"));
        assert!(!is_document_navigation("/api/sync/stream"));
    }

    // --- render_bundled_spa (the app-independent core of serve_bundled_spa) ---
    // Same disk-serve behavior serve_bundled_spa exercises via a real AppHandle;
    // tested directly here (mirroring resolve_static_or_forward vs
    // try_serve_static_asset, WI-3225) against a real temp directory so a refactor
    // can't silently change the pre-operator OR the forward-failed-fallback path
    // without a test failing.

    #[test]
    fn render_bundled_spa_serves_index_html_for_the_root_path() {
        let root = TempSpaRoot::new("render-root");
        let resp = render_bundled_spa(&root.dir, "/");
        assert_eq!(resp.status().as_u16(), 200);
        assert_eq!(
            resp.headers()
                .get(csp_policy().enforcing_header.as_str())
                .unwrap()
                .to_str()
                .unwrap(),
            csp_policy().enforcing_policy,
        );
        assert_eq!(
            resp.headers()
                .get(csp_policy().report_only_header.as_str())
                .unwrap()
                .to_str()
                .unwrap(),
            csp_policy().report_only_policy,
        );
        assert_eq!(
            String::from_utf8_lossy(resp.body()),
            "<html>real index</html>"
        );
    }

    #[test]
    fn render_bundled_spa_serves_index_html_for_an_unknown_spa_route() {
        let root = TempSpaRoot::new("render-spa-route");
        let resp = render_bundled_spa(&root.dir, "/harness/some-slug");
        assert_eq!(resp.status().as_u16(), 200);
        assert_eq!(
            String::from_utf8_lossy(resp.body()),
            "<html>real index</html>"
        );
    }

    #[test]
    fn render_bundled_spa_serves_an_existing_asset_from_disk() {
        let root = TempSpaRoot::new("render-asset");
        let resp = render_bundled_spa(&root.dir, "/assets/index-a1b2c3.js");
        assert_eq!(resp.status().as_u16(), 200);
        assert!(resp
            .headers()
            .get(csp_policy().enforcing_header.as_str())
            .is_none());
        assert!(resp
            .headers()
            .get(csp_policy().report_only_header.as_str())
            .is_none());
        assert_eq!(String::from_utf8_lossy(resp.body()), "console.log('hi')");
    }

    #[test]
    fn csp_is_split_shared_and_html_only() {
        // Pin both literal names and the D-002 directive split. A JSON field
        // asserting itself would not catch the single-header regression.
        assert_eq!(csp_policy().enforcing_header, "Content-Security-Policy");
        assert_eq!(
            csp_policy().report_only_header,
            "Content-Security-Policy-Report-Only"
        );
        assert!(csp_policy()
            .enforcing_policy
            .contains("connect-src 'self' * ws:"));
        assert!(!csp_policy()
            .report_only_policy
            .contains("connect-src 'self' *"));

        let html = Response::builder()
            .header("content-type", "text/html; charset=utf-8")
            .body(Vec::new())
            .unwrap();
        let html = with_csp(html);
        assert_eq!(
            html.headers()
                .get(csp_policy().enforcing_header.as_str())
                .unwrap()
                .to_str()
                .unwrap(),
            csp_policy().enforcing_policy,
        );
        assert_eq!(
            html.headers()
                .get(csp_policy().report_only_header.as_str())
                .unwrap()
                .to_str()
                .unwrap(),
            csp_policy().report_only_policy,
        );

        let script = Response::builder()
            .header("content-type", "text/javascript")
            .body(Vec::new())
            .unwrap();
        assert!(with_csp(script)
            .headers()
            .get(csp_policy().enforcing_header.as_str())
            .is_none());
        let script = Response::builder()
            .header("content-type", "text/javascript")
            .body(Vec::new())
            .unwrap();
        assert!(with_csp(script)
            .headers()
            .get(csp_policy().report_only_header.as_str())
            .is_none());
    }

    #[test]
    fn render_bundled_spa_answers_api_paths_with_a_clean_503_not_html() {
        let root = TempSpaRoot::new("render-api");
        let resp = render_bundled_spa(&root.dir, "/api/health");
        assert_eq!(resp.status().as_u16(), 503);
        assert!(!String::from_utf8_lossy(resp.body()).contains("<html>"));
    }

    #[test]
    fn render_bundled_spa_rejects_path_traversal() {
        let root = TempSpaRoot::new("render-traversal");
        let resp = render_bundled_spa(&root.dir, "/../../etc/passwd");
        assert_eq!(resp.status().as_u16(), 400);
    }

    // --- Fix B static-asset disk-serve eligibility (release-blocking card, WI-2902) ---
    // is_static_asset_path is the pure gate that decides whether forward() may
    // short-circuit a GET to the bundled SPA on disk (removing the flaky operator
    // forward that surfaced the "This view hit an error" card on reload). The
    // document root, empty path, and every /api path MUST stay forwarded (index.html
    // may carry operator templating; /api* rides the IPC polyfill / operator); a
    // concrete asset/route path is eligible (try_serve_static_asset then requires it
    // to resolve to a real bundled file, else it too falls through to the forward).

    #[test]
    fn static_asset_path_serves_concrete_assets_from_disk() {
        // Hashed chunks + top-level bundled files — the burst that flaked the forward.
        assert!(is_static_asset_path("/assets/index-a1b2c3.js"));
        assert!(is_static_asset_path("/assets/index-d4e5f6.css"));
        assert!(is_static_asset_path("/favicon.ico"));
        assert!(is_static_asset_path("/fonts/inter.woff2"));
        assert!(is_static_asset_path("/logo.svg"));
    }

    #[test]
    fn static_asset_path_keeps_root_and_api_forwarded() {
        // These MUST forward: the document root (operator may template index.html),
        // the empty path, and everything under /api (IPC polyfill / operator).
        assert!(!is_static_asset_path(""));
        assert!(!is_static_asset_path("/"));
        assert!(!is_static_asset_path("/api"));
        assert!(!is_static_asset_path("/api/health"));
        assert!(!is_static_asset_path("/api/sync/stream"));
    }

    // --- scheme-default regression guard (blank-macOS-webview, 2026-07-01) ---
    // These assert the invariant that the earlier bug violated: with NO env
    // override the custom scheme defaults ON *only* on Linux, because macOS
    // ⚠ This comment used to read "WKWebView / Windows WebView2 render the
    // buffered scheme handler BLANK." Both halves are now REFUTED on real
    // hardware: Windows/WebView2 on 2026-07-04 (WI-2734) and macOS/WKWebView on
    // 2026-08-03 (D-054, `no-http-anywhere-2026-07-28`, P-017). The defaults
    // below still assert OFF, but that is now a NOT-YET-VERIFIED-END-TO-END
    // decision (P-031: needs the packaged E2E battery under the override, plus
    // cross-platform `install_load_failure_recovery` — EI-19425361953094049),
    // NOT a rendering limitation. Do not re-justify these defaults with "renders
    // blank"; that claim is dead.
    //
    // scheme_default() is pure, so CI (which builds on Linux) can exercise the
    // macOS/Windows arms it could never reach through a raw `cfg!(target_os)`.

    #[test]
    fn scheme_defaults_to_linux_only() {
        assert!(
            scheme_default(None, "linux"),
            "linux must default the papercusp:// scheme ON (WebKitGTK pool-cap dodge)",
        );
        assert!(
            !scheme_default(None, "macos"),
            "macOS must default OFF — pending P-031's packaged E2E battery under \
             the override (NOT because WKWebView renders papercusp:// blank; \
             that claim is REFUTED on real hardware, D-054)",
        );
        assert!(
            !scheme_default(None, "windows"),
            "windows must default OFF — pending P-031's packaged E2E battery under \
             the override (NOT because WebView2 renders papercusp:// blank; that \
             claim is REFUTED, WI-2734 2026-07-04)",
        );
        assert!(
            !scheme_default(None, "ios"),
            "every non-linux target defaults the scheme OFF",
        );
    }

    #[test]
    fn scheme_env_override_wins_on_every_platform() {
        for os in ["linux", "macos", "windows"] {
            assert!(
                scheme_default(Some("1"), os),
                "PAPERCUSP_DESKTOP_CUSTOM_PROTOCOL=1 must force the scheme ON on {os}",
            );
            assert!(
                !scheme_default(Some("0"), os),
                "PAPERCUSP_DESKTOP_CUSTOM_PROTOCOL=0 must force the scheme OFF on {os}",
            );
        }
    }

    #[test]
    fn scheme_unrecognized_env_falls_through_to_platform_default() {
        // Anything other than exactly "1" / "0" is ignored → platform default.
        assert!(scheme_default(Some(""), "linux"));
        assert!(!scheme_default(Some("true"), "macos"));
        assert!(!scheme_default(Some("yes"), "windows"));
    }

    // --- pre-operator onboarding-origin guard (Windows first-run dead-end, WI-2734) ---
    // The invariant the shipped bug violated: the bundled-SPA onboarding origin
    // must be served on Windows (as well as Linux), because a truly-cold Windows
    // machine renders the WslOnboardingGate ONLY through this handler — the gate
    // is what bootstraps WSL, which is what lets the operator (and thus the real
    // app) come up at all. macOS stays OFF because it has no equivalent
    // pre-operator onboarding phase (the operator spawns natively) — NOT because
    // "WKWebView renders papercusp:// blank", which is REFUTED on real hardware
    // (D-054, `no-http-anywhere-2026-07-28`).

    #[test]
    fn onboarding_origin_defaults_to_linux_and_windows() {
        assert!(
            onboarding_origin_default(None, "linux"),
            "linux serves the bundled-SPA onboarding origin (scheme is the app origin throughout)",
        );
        assert!(
            onboarding_origin_default(None, "windows"),
            "windows MUST serve the bundled-SPA onboarding origin — else the \
             WslOnboardingGate never renders and first-run dead-ends (WI-2734)",
        );
        assert!(
            !onboarding_origin_default(None, "macos"),
            "macOS stays OFF — it has no long pre-operator onboarding phase (the \
             operator spawns natively), so this buys nothing. NOT because \
             WKWebView renders papercusp:// blank — that claim is REFUTED on real \
             hardware (D-054); only the no-onboarding-phase reason survives",
        );
        assert!(
            !onboarding_origin_default(None, "ios"),
            "other targets default OFF",
        );
    }

    #[test]
    fn onboarding_origin_env_override_wins_on_every_platform() {
        for os in ["linux", "macos", "windows"] {
            assert!(onboarding_origin_default(Some("1"), os));
            assert!(!onboarding_origin_default(Some("0"), os));
        }
        // Unrecognized value → platform default.
        assert!(!onboarding_origin_default(Some("true"), "macos"));
        assert!(onboarding_origin_default(Some("yes"), "windows"));
    }

    #[test]
    fn onboarding_origin_is_superset_of_enabled() {
        // Every platform where the scheme is the steady-state origin (enabled)
        // must also serve it pre-operator (onboarding). The reverse need not hold
        // (Windows: onboarding yes, steady-state no).
        for os in ["linux", "macos", "windows", "ios"] {
            if scheme_default(None, os) {
                assert!(
                    onboarding_origin_default(None, os),
                    "{os}: enabled() implies onboarding_origin_enabled()",
                );
            }
        }
        // Windows is the intended asymmetric case.
        assert!(!scheme_default(None, "windows"));
        assert!(onboarding_origin_default(None, "windows"));
    }

    // --- resolve_static_or_forward wiring guard (WI-3225) ---
    // Follow-up to Fix B (the release-blocking "This view hit an error" card,
    // WI-2902). The tests above only ever exercise the pure boolean
    // `is_static_asset_path` gate; NOTHING guarded the actual disk-serve wiring —
    // the method check, the traversal/containment enforcement, or the real file
    // read — so a future refactor of `forward()` / `try_serve_static_asset()` could
    // silently drop or reorder any of that without a single test failing (it already
    // recurred once: Fix A softened fresh-boot but not the reload burst). These
    // tests exercise `resolve_static_or_forward` — the app-independent core both
    // `forward()` and `try_serve_static_asset()` now delegate to — against a REAL
    // temp directory: real bytes, real mime type, real traversal checks, and the
    // method gate that used to live as a separate `if` in `forward()` itself.

    struct TempSpaRoot {
        dir: std::path::PathBuf,
    }

    impl TempSpaRoot {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "papercusp-custom-protocol-test-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            ));
            std::fs::create_dir_all(dir.join("assets")).expect("create temp spa root");
            std::fs::write(
                dir.join("assets").join("index-a1b2c3.js"),
                b"console.log('hi')",
            )
            .expect("write test asset");
            std::fs::write(dir.join("index.html"), b"<html>real index</html>")
                .expect("write test index.html");
            Self { dir }
        }
    }

    impl Drop for TempSpaRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn resolve_static_or_forward_serves_an_existing_asset_from_disk_with_its_real_bytes() {
        let root = TempSpaRoot::new("serves-asset");
        let resp = resolve_static_or_forward(&root.dir, "GET", "/assets/index-a1b2c3.js")
            .expect("must serve the real bundled asset from disk");
        assert_eq!(resp.status().as_u16(), 200);
        assert_eq!(
            resp.headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap(),
            "text/javascript",
        );
        assert_eq!(String::from_utf8_lossy(resp.body()), "console.log('hi')");
    }

    #[test]
    fn resolve_static_or_forward_keeps_index_html_and_root_forwarded_even_though_the_file_exists() {
        let root = TempSpaRoot::new("index-forwards");
        // index.html is a REAL file on disk in this fixture, yet the root path and the
        // empty path must still forward (operator-side templating is preserved).
        assert!(resolve_static_or_forward(&root.dir, "GET", "/").is_none());
        assert!(resolve_static_or_forward(&root.dir, "GET", "").is_none());
    }

    #[test]
    fn resolve_static_or_forward_keeps_api_paths_forwarded() {
        let root = TempSpaRoot::new("api-forwards");
        assert!(resolve_static_or_forward(&root.dir, "GET", "/api").is_none());
        assert!(resolve_static_or_forward(&root.dir, "GET", "/api/health").is_none());
    }

    #[test]
    fn resolve_static_or_forward_never_disk_serves_a_non_get_method_even_for_an_asset_path() {
        // This is the method gate that used to live as a separate outer `if` in
        // forward() itself — now it lives inside the tested core, so a refactor that
        // stops checking the method can't silently start disk-serving mutating verbs.
        let root = TempSpaRoot::new("non-get-forwards");
        for method in ["POST", "PUT", "DELETE", "HEAD"] {
            assert!(
                resolve_static_or_forward(&root.dir, method, "/assets/index-a1b2c3.js").is_none(),
                "{method} must forward, never disk-serve",
            );
        }
    }

    #[test]
    fn resolve_static_or_forward_falls_through_to_forward_for_a_missing_asset() {
        let root = TempSpaRoot::new("missing-asset");
        // Path shape is asset-eligible but no such file exists on disk — must forward
        // (the operator may still know how to answer it, or 404 itself).
        assert!(resolve_static_or_forward(&root.dir, "GET", "/assets/does-not-exist.js").is_none());
    }

    #[test]
    fn resolve_static_or_forward_rejects_path_traversal_out_of_the_spa_root() {
        let root = TempSpaRoot::new("traversal");
        assert!(resolve_static_or_forward(&root.dir, "GET", "/../../etc/passwd").is_none());
        assert!(resolve_static_or_forward(&root.dir, "GET", "/assets/../../secret").is_none());
    }
}
