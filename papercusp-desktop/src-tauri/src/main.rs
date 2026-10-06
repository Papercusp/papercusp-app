// Papercusp desktop shell.
//
// Architecture (SP1 C5 — the desktop is an EMBEDDER of `papercusp serve`,
// plan operator-core-headless-serve-2026-06-04 Decision F):
//   1. On startup, find a free localhost port (cold-start hint).
//   2. Spawn the bundled `serve.mjs --ensure` (apps/operator/bin/serve.ts).
//      serve OWNS the operator lifecycle: embedded Postgres (start,
//      migrations, ~/.papercusp/embedded-pg.json), runBootstrap(), the Hono
//      host, and the ~/.papercusp/operator.json discovery file. `--ensure`
//      reuses an already-healthy operator instead of double-booting.
//   3. Poll operator.json until (pid alive + HTTP reachable); read the REAL
//      port from it (reuse may land on a different port than our hint).
//   4. Open the main window pointing at the discovered operator.
//   5. On window-close, SIGTERM the serve child (it stops PG + removes
//      operator.json on the way down).
//
// Rust retains: webview, endpoint-IPC client, the papercusp:// custom
// protocol, window management, PTY, workspace HOME isolation, and the update
// checker. Everything PG/operator process-management moved INTO serve.
// (code-server is retired — owner directive 2026-07-07 — no longer bundled or
// spawned.)
//
// The same `serve.mjs` is what we'd run in a cloud container — no shell-out
// into platform-specific tooling here.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_role;
mod custom_protocol;
mod dev_bridge;
#[cfg(any(target_os = "windows", test))]
mod sidecar_runtime_identity;
#[cfg(any(target_os = "windows", test))]
mod wsl_sidecar_staging;
// Global-hotkey docs-search palette (WI-2648, feature #5): an opt-in global
// shortcut opens a small always-on-top window loading Pagefind's own default UI
// against the already-built operator-docs search index. OFF BY DEFAULT (owner
// directive 2026-07-12) — a global shortcut is a system-wide key grab, so nothing
// is registered until the user picks a key in the Server tray's "Docs search
// shortcut" submenu (whose first item is "Off").
mod docs_search;
// Env-switch plumbing — the desktop-side source of truth + /api routing for the
// cross-platform in-webview EnvSwitcherBar and its native backstop. Replaces the
// retired Linux-only GTK dev-wrapper bar and the chrome-webview experiment.
// Compiled on every platform (list_envs is a registered command); it returns no
// envs in a packaged single-operator build, so it's inert there.
mod endpoint_ipc;
mod endpoint_ipc_framing;
mod env_switch;
mod fd_limit;
// Boot-time WebKitGTK localStorage WAL reclaim + runaway guard (EI-14135): the
// webview's per-origin localStorage is a SQLite WAL store whose `-wal` never
// resets while a long-lived webview holds a reader (and never checkpoints on a
// hard-killed shell), so it grew to ~127 GiB. Checkpoint-TRUNCATE each store at
// boot, before the webview reopens it.
mod localstorage_wal;
mod native_console;
mod native_terminal;
mod pty;
mod webkit_render;
mod workspaces;
mod wsl_setup;

use endpoint_ipc::is_tcp_endpoint;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_specta::Event as _;

/// Minimal RFC 3986 percent-encoding for the path component. Only the
/// reserved + unsafe set; we avoid pulling in a full url crate dep just
/// for this. Used to encode the workspace id into the harness URL query.
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

struct SidecarState {
    /// The `serve.mjs --ensure` child (SP1 C5). serve owns embedded-PG
    /// in-process, so there is no separate db child anymore. None when
    /// --ensure reused an operator another process owns (we then must NOT
    /// kill it on exit — it isn't ours).
    child: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
    /// Endpoint-IPC socket path resolved from the operator's
    /// `~/.papercusp/endpoint-ipc.json` discovery file (written by
    /// runBootstrap inside serve). None when IPC is disabled or discovery
    /// hadn't completed yet.
    endpoint_ipc_socket: Mutex<Option<String>>,
    /// One-shot guard for the exit teardown (P-051): ExitRequested AND Exit
    /// both fire on a normal quit, and each used to run the full
    /// terminal+sidecar teardown again. `shutdown_children_once` swaps this
    /// to make the teardown idempotent.
    shutdown_done: std::sync::atomic::AtomicBool,
}

fn find_free_port() -> Option<u16> {
    portpicker::pick_unused_port()
}

/// (P-055) Put a child in its own Windows process group so graceful_kill's
/// CTRL_BREAK_EVENT targets that child's group instead of ours (without
/// CREATE_NEW_PROCESS_GROUP the pid isn't a group id and the event would
/// fan out to our whole console group, including this process).
///
/// (EI-8894) On Unix (macOS/Linux) this ALSO puts the child in its own
/// process group (`setpgid(0, 0)` via the stable `process_group(0)` builder
/// — child pid becomes the new group's pgid). Root cause #1 of EI-8894: a
/// hard-killed parent (`launchctl kickstart -k`, `pkill -9`, a crash) skips
/// our own SIGTERM/graceful-shutdown path entirely, and an un-grouped child
/// has no group boundary a sweep can target — only a same-pid kill (which
/// nothing sends) reaches it, so it survives as an orphan holding ports/
/// storage under stale env. A distinct group is a PRECONDITION for any
/// future/external "kill everything this app ever spawned" sweep (`kill
/// -TERM -<pgid>`) to work at all; it does not by itself stop an orphan
/// (see the parent-death self-exit watch in serve.ts for that half).
fn isolate_process_group(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: console children (wsl.exe, node) of this GUI app
        // otherwise get a VISIBLE console window dropped over the webview
        // (found live 2026-06-11: a raw wsl.exe console covered the wizard).
        // The child still owns an (invisible) conhost, so the P-055
        // CTRL_BREAK_EVENT graceful-kill path keeps working.
        cmd.creation_flags(
            windows::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP.0
                | windows::Win32::System::Threading::CREATE_NO_WINDOW.0,
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = cmd;
    }
}

/// Pull the `socketPath` field out of the dev discovery JSON
/// (`~/.papercusp/endpoint-ipc.json`, written by
/// apps/operator/lib/endpoint-ipc-discovery.ts), or `None`. Used as the
/// `IpcClientHandle` socket source in BOTH setup branches (dev points at the
/// externally-run operator; production reads the file serve's runBootstrap
/// writes — SP1 C5), so each reconnect re-reads the file and picks up a
/// restarted operator's new socket.
fn read_dev_ipc_socket(path: &std::path::Path) -> Option<String> {
    let txt = std::fs::read_to_string(path).ok()?;
    parse_endpoint_ipc_socket(&txt)
}

/// Parse + target-validate a `socketPath` out of endpoint-ipc.json text.
/// Shared by the filesystem read (`read_dev_ipc_socket`) and the WSL `cat`
/// read (`read_endpoint_ipc_socket_via_wsl`) so both classify the endpoint
/// identically (Windows accepts `\\.\pipe\` or `tcp://`; others accept a unix
/// socket or `tcp://`).
fn parse_endpoint_ipc_socket(txt: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(txt).ok()?;
    let socket_path = v.get("socketPath")?.as_str()?.trim();
    if endpoint_ipc_socket_path_supported_for_target(socket_path, cfg!(target_os = "windows")) {
        Some(socket_path.to_string())
    } else {
        None
    }
}

fn endpoint_ipc_socket_path_supported_for_target(socket_path: &str, target_windows: bool) -> bool {
    if socket_path.trim().is_empty() {
        return false;
    }
    let is_windows_pipe = is_windows_named_pipe_path(socket_path);
    if target_windows {
        // WI-3395: on Windows the sidecar runs inside WSL2 and reaches the host
        // over loopback TCP, so a `tcp://` endpoint is the real path; a named
        // pipe stays valid for a hypothetical native sidecar. A Unix-socket
        // path is never openable from the Windows host — reject it.
        is_windows_pipe || is_tcp_endpoint(socket_path)
    } else {
        // Non-Windows hosts run the sidecar natively: accept a Unix socket (the
        // usual case) or a `tcp://` loopback endpoint; never a Windows pipe.
        !is_windows_pipe
    }
}

fn is_windows_named_pipe_path(socket_path: &str) -> bool {
    let lower = socket_path.to_ascii_lowercase();
    lower.starts_with("\\\\.\\pipe\\") || lower.starts_with("\\\\?\\pipe\\")
}

/// EI-190: the operator PORT the desktop's /api endpoint-IPC currently
/// targets. Default :3070 (the green release operator — today's implicit
/// behavior made explicit). The dev wrapper's build switcher stores the
/// mapped target here (`env_switch::api_port_for_target`) and resets the
/// IPC client so /api follows the selected build instead of riding
/// whichever operator last rewrote the singleton discovery file.
pub static SELECTED_API_PORT: std::sync::atomic::AtomicU16 =
    std::sync::atomic::AtomicU16::new(3070);

/// Per-port discovery read (EI-190): prefer `endpoint-ipc.<port>.json`
/// (every operator boot publishes it since the per-port change), falling
/// back to the legacy last-writer-wins singleton for an operator that
/// hasn't restarted since the change shipped.
///
/// EI-296: the singleton fallback applies ONLY to the fixed dev-box
/// operators (:3070/:3170) — it is "whichever operator booted last". A
/// CUSTOM target (the PAPERCUSP_DEV_API_TARGET escape hatch, e.g. an
/// isolated test stack or fault proxy) must never silently dial another
/// operator's socket: it either publishes its own per-port file or is
/// reached over HTTP at exactly that port.
///
/// EI-18763945004822208: the runtime `IpcClientHandle` socket-source site now
/// uses `read_dev_ipc_socket_for_port_validated` (this raw form dials a
/// restart-orphaned advertisement straight into ENOENT). Kept as the pure
/// parser exercised directly by `helper_tests` below — `#[allow(dead_code)]`
/// because that's now its only caller in a non-test build.
#[allow(dead_code)]
fn read_dev_ipc_socket_for_port(papercusp_dir: &std::path::Path, port: u16) -> Option<String> {
    let per_port = read_dev_ipc_socket(&papercusp_dir.join(format!("endpoint-ipc.{port}.json")));
    if per_port.is_some() || !matches!(port, 3070 | 3170) {
        return per_port;
    }
    read_dev_ipc_socket(&papercusp_dir.join("endpoint-ipc.json"))
}

/// Like `read_dev_ipc_socket` but also returns the advertised `pid` (0 when
/// absent/non-numeric/unparseable) — the input `discovery_socket_still_live`
/// needs to tell a genuinely-fresh advertisement from a stale one.
fn read_dev_ipc_socket_with_pid(path: &std::path::Path) -> Option<(String, u32)> {
    let txt = std::fs::read_to_string(path).ok()?;
    let socket_path = parse_endpoint_ipc_socket(&txt)?;
    let pid = serde_json::from_str::<serde_json::Value>(&txt)
        .ok()
        .and_then(|v| v.get("pid").and_then(|p| p.as_u64()))
        .unwrap_or(0) as u32;
    Some((socket_path, pid))
}

/// CONFIRMED bug (EI-18763945004822208, measured live 2026-07-27): after an
/// operator restart, its discovery file briefly still names the PREVIOUS
/// (now-dead) pid/socket until the new instance boots and rewrites the file —
/// dialing during that window produces a resolvable-but-ENOENT connect on
/// EVERY `/api` call (measured 160/160 failed invokes). Restarts are constant
/// on this dev box (every agent's `dev:restart`, every deploy, every
/// green-checkpoint promotion), so this window is entered many times a day.
///
/// Validate before trusting: an advertisement is only "live" when (a) its pid
/// is actually running (`discovery_pid_alive`, which itself is strengthened
/// with a cmdline check so a recycled pid can't false-positive), AND (b), for
/// a real unix-domain-socket path (not a `tcp://` loopback endpoint or a
/// Windows named pipe — neither has anything to check on the local
/// filesystem), the socket file itself still exists. Treating a stale
/// advertisement as "no advertisement yet" lets `IpcClientHandle` fall back to
/// HTTP / keep retrying instead of handing it a socket guaranteed to fail.
/// Is the endpoint this advertisement names something that could exist on this
/// machine right now? A `tcp://` loopback endpoint and a Windows named pipe
/// have nothing to check on the local filesystem, so they pass by construction.
fn discovery_socket_file_present(socket_path: &str) -> bool {
    is_tcp_endpoint(socket_path)
        || is_windows_named_pipe_path(socket_path)
        || std::path::Path::new(socket_path).exists()
}

/// Why one discovery advertisement is — or is not — usable.
///
/// These four failure shapes were previously all collapsed into `None` at the
/// `Option`-returning readers below, which is precisely what made a stuck IPC
/// bridge un-diagnosable from inside the app (WI-6512). Keeping them distinct
/// costs nothing and lets `resolve_dev_ipc_socket` say which one happened.
#[derive(Debug, Clone, PartialEq, Eq)]
enum AdvertisementState {
    /// No discovery file — this operator has never published on this port.
    Absent,
    /// File exists but carries no usable `socketPath`.
    Unparseable,
    /// Names a pid that is no longer running (the classic restart orphan).
    DeadPid {
        socket: String,
        pid: u32,
    },
    /// Names a socket file that has since been removed.
    SocketGone {
        socket: String,
        pid: u32,
    },
    Live {
        socket: String,
        pid: u32,
    },
}

impl AdvertisementState {
    fn live_socket(&self) -> Option<&str> {
        match self {
            AdvertisementState::Live { socket, .. } => Some(socket.as_str()),
            _ => None,
        }
    }

    /// One short phrase, suitable for a log line or the status command.
    fn describe(&self) -> String {
        match self {
            AdvertisementState::Absent => "no advertisement published".to_string(),
            AdvertisementState::Unparseable => {
                "advertisement present but has no usable socketPath".to_string()
            }
            AdvertisementState::DeadPid { socket, pid } => {
                format!("advertises {socket} for pid {pid}, which is not running (restart orphan)")
            }
            AdvertisementState::SocketGone { socket, pid } => {
                format!("advertises {socket} (pid {pid}) but that socket file is gone")
            }
            AdvertisementState::Live { socket, pid } => {
                format!("live advertisement {socket} (pid {pid})")
            }
        }
    }
}

/// Classify an already-parsed advertisement. THE single implementation of the
/// validation rules: `discovery_socket_still_live` (the boolean façade) and
/// `inspect_advertisement` (the file-reading form) both route through here, so
/// a "is it usable?" answer and a "why not?" answer can never disagree.
fn classify_advertisement(socket_path: &str, pid: u32, via_wsl: bool) -> AdvertisementState {
    let socket = socket_path.to_string();
    // `discovery_pid_exists`, NOT `discovery_pid_alive` — see the note on
    // `discovery_pid_exists`. A false negative here silently costs the whole
    // IPC transport, so this gate refuses only on proof (the pid is gone), not
    // on a cmdline heuristic that cannot know every entrypoint we might run.
    if pid != 0 && !discovery_pid_exists(pid, via_wsl) {
        return AdvertisementState::DeadPid { socket, pid };
    }
    if !discovery_socket_file_present(&socket) {
        return AdvertisementState::SocketGone { socket, pid };
    }
    AdvertisementState::Live { socket, pid }
}

/// Read one discovery file and classify it.
fn inspect_advertisement(path: &std::path::Path, via_wsl: bool) -> AdvertisementState {
    let Some((socket, pid)) = read_dev_ipc_socket_with_pid(path) else {
        return if path.exists() {
            AdvertisementState::Unparseable
        } else {
            AdvertisementState::Absent
        };
    };
    classify_advertisement(&socket, pid, via_wsl)
}

/// Resolve the dev `/api` operator's IPC endpoint for `port`, **explaining the
/// outcome either way** (see `endpoint_ipc::SocketResolution`).
///
/// Order: the per-port advertisement `endpoint-ipc.<port>.json`, then — for the
/// fixed dev-box operators only — the legacy last-writer-wins singleton.
/// EI-296: a CUSTOM target (an isolated test stack, a fault proxy) deliberately
/// gets NO singleton fallback; silently dialing whichever operator happened to
/// boot last would send `/api` to the wrong process. That is correct, but until
/// now it was also invisible — a custom-port shell with no per-port file simply
/// reported nothing at all, which is exactly the state WI-6512 had to diagnose
/// by hand. The `missing` detail below now names the file it wanted.
fn resolve_dev_ipc_socket(
    papercusp_dir: &std::path::Path,
    port: u16,
    via_wsl: bool,
) -> endpoint_ipc::SocketResolution {
    let per_port_path = papercusp_dir.join(format!("endpoint-ipc.{port}.json"));
    let per_port = inspect_advertisement(&per_port_path, via_wsl);
    if let Some(socket) = per_port.live_socket() {
        // The per-port advertisement is published BY the operator listening on
        // `port`, which is the origin that served this webview — so resolving
        // through it PROVES the IPC owner is the content origin. That fact is what
        // lets `/api/desktop/*` ride IPC instead of being excluded wholesale
        // (D-008). The singleton fallback below deliberately does NOT claim it.
        return endpoint_ipc::SocketResolution::found(
            socket,
            format!("selected port {port}: {}", per_port.describe()),
        )
        .from_content_origin();
    }

    if !matches!(port, 3070 | 3170) {
        return endpoint_ipc::SocketResolution::missing(format!(
            "selected port {port}: {} at {}. A custom port gets no singleton fallback \
             (EI-296) — that operator must publish its own per-port advertisement, or \
             /api stays on HTTP at :{port}.",
            per_port.describe(),
            per_port_path.display()
        ));
    }

    let singleton_path = papercusp_dir.join("endpoint-ipc.json");
    let singleton = inspect_advertisement(&singleton_path, via_wsl);
    match singleton.live_socket() {
        Some(socket) => endpoint_ipc::SocketResolution::found(
            socket,
            format!(
                "selected port {port}: {} — fell back to the shared singleton, which is {}",
                per_port.describe(),
                singleton.describe()
            ),
        ),
        None => endpoint_ipc::SocketResolution::missing(format!(
            "selected port {port}: per-port {} at {}; singleton {} at {}",
            per_port.describe(),
            per_port_path.display(),
            singleton.describe(),
            singleton_path.display()
        )),
    }
}

/// Prepend the bundled runtime dir (sidecar `bin/`, which ships `node` + vendored
/// CLIs) to PATH. The packaged desktop app's process PATH has no `node` (a GUI /
/// `.deb` launch inherits a minimal PATH), so a bare `Command::new("node")`
/// resolves against the child PATH and fails with ENOENT on a clean machine.
/// EVERY node-based sidecar spawn (host, embedded-postgres-server,
/// zero-cache-server) must route through this. `dir` is the sidecar root that
/// contains `bin/`.
fn bundled_path_env(dir: &std::path::Path) -> String {
    let bundled_bin = dir.join("bin");
    let path_sep = if cfg!(windows) { ";" } else { ":" };
    let existing_path = std::env::var("PATH").unwrap_or_default();
    format!(
        "{}{}{}",
        bundled_bin.to_string_lossy(),
        path_sep,
        existing_path
    )
}

/// (SP1 C5) The embedded-postgres + zero-cache process management that used
/// to live here moved INTO `serve.mjs` (apps/operator/bin/serve.ts): PG
/// port selection, the orphan-postmaster sweep, the PG wire-protocol ready
/// probe, migrations, and the embedded-pg.json write are all serve's now.
/// The legacy opt-in zero-cache spawn (PAPERCUSP_USE_ZERO_CACHE=1) was
/// removed outright — the SSE path replaced the Zero WS transport on
/// desktop 2026-05-07 and the bundle no longer ships zero-cache-server.

/// Spawn the Node sidecar from inside the bundled sidecar dir. In dev
/// (`tauri dev`), we skip this — the developer runs `npm run dev:papercusp`
/// separately and the webview points at devUrl from tauri.conf.json.
/// On Windows we route the sidecar through WSL so the harness's POSIX
/// assumptions (bash, overmind, unix sockets, fs.watch semantics) work.
/// Returns true once the user has finished the WslOnboardingGate flow
/// (state == Ready). On non-Windows always returns false.
#[cfg(target_os = "windows")]
fn should_route_via_wsl(app: &tauri::AppHandle) -> bool {
    matches!(wsl_setup::detect(app).state, wsl_setup::WslState::Ready)
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
fn should_route_via_wsl(_app: &tauri::AppHandle) -> bool {
    false
}

/// How often the GUI re-checks for the WSL route while waiting. Each check is a
/// `wsl.exe` spawn (`wsl_setup::detect`), so this matches the Server-role
/// deferred-boot watcher's proven 10s cadence rather than the 300ms discovery
/// poll — an unthrottled spawn loop is the exact pressure `distro_exec_wedged`
/// documents as able to wedge the WSL2 interop layer.
#[cfg(target_os = "windows")]
const WSL_ROUTE_POLL_INTERVAL: Duration = Duration::from_secs(10);

/// WI-37798: re-resolve the WSL route AFTER startup, for the GUI role.
///
/// `should_route_via_wsl` is a snapshot of a value that CHANGES. On a cold
/// first run the distro is not registered yet, so `gui_setup` latches
/// `via_wsl = false` — and nothing in the GUI ever re-evaluated it. The Server
/// bundle the GUI then launches is precisely what performs the WSL onboarding
/// and brings the operator up INSIDE the distro
/// (`/home/papercup/.papercusp/operator.json`). Meanwhile the GUI keeps reading
/// the Windows-side `workspace_home` path that nothing ever writes, on the
/// 120s NON-WSL budget, and then falls back to the dev-only :3070 — the
/// permanent "Operator connection lost" banner, reproduced end-to-end on a cold
/// Windows 11 install of 0.0.15 (operator answering HTTP 200 on its real port
/// the whole time).
///
/// The Server role already corrects exactly this staleness for its own sidecar
/// spawn — the deferred-boot watcher in `setup()` overrides `via_wsl = true`
/// once `detect()` flips Ready (WI-3407). This is that same correction for the
/// GUI's DISCOVERY leg, which was never given it. The stale flag poisons three
/// consumers at once, which is why it is fixed here at the source rather than
/// inside the poll loop: the boot wait's path AND budget, the endpoint-IPC
/// socket read, and the long-lived operator watcher.
///
/// Waiting here costs nothing on Windows: while WSL is not Ready there is no
/// operator to discover at all — on Windows the sidecar only ever runs inside
/// the distro — so this replaces polling a path that cannot appear. It is
/// bounded by the WSL boot budget and returns the ORIGINAL value on timeout,
/// so a genuinely WSL-less machine keeps today's behaviour instead of having a
/// route it does not have asserted for it.
/// The wait's PURE core, with the probe, the sleep and the clock injected.
///
/// Compiled under `test` on every dev platform — the file's standing idiom
/// (`windows_path_to_wsl`, `self_heal_probe_due`, `wsl_papercusp_home_dir`) —
/// so the retry logic is unit-testable here rather than only on Windows.
///
/// ⚠ This comment used to assert that the box had NO working Windows compile
/// gate, and that anything inside a `cfg(windows)` body was therefore
/// UNCOMPILED here. That is FALSE and has been retired: run
/// `npm --prefix papercusp-desktop run check:windows` (cargo-xwin, which
/// supplies the MSVC CRT + Windows SDK) and the whole Windows-only surface of
/// this binary typechecks against the real `x86_64-pc-windows-msvc` target —
/// measured 2026-08-11 and independently re-measured 2026-09-05, exit 0 in
/// ~58s from a COLD target dir. The old claim was only ever measured against
/// bare `cargo check --target x86_64-pc-windows-msvc` (dies in a build script
/// for want of `lib.exe`) and mingw (not installed); neither command covers
/// cargo-xwin, which exists precisely to solve the `lib.exe` failure.
///
/// So keeping the logic in this pure core and the Windows-only part a thin
/// shim is a deliberate CHOICE — it is the better testing idiom — and no
/// longer a workaround for a compile gate that does not exist. It does.
///
/// The general lesson, worth more than the fact: a negative capability claim
/// ("X cannot be done here") is only ever as strong as the specific commands
/// someone tried, yet it propagates as though it were a property of the
/// machine. This one survived months and several re-assertions because every
/// re-check re-ran the same two failing commands. Re-derive such a claim
/// against the tools actually installed before letting it shape a design.
///
/// Returns true when the WSL route is (or becomes) the right one to use.
#[cfg(any(target_os = "windows", test))]
fn resolve_route_upgrade(
    via_wsl: bool,
    budget: Duration,
    poll: Duration,
    mut ready: impl FnMut() -> bool,
    mut wait: impl FnMut(Duration),
    mut elapsed: impl FnMut() -> Duration,
) -> bool {
    if via_wsl {
        return true;
    }
    while elapsed() < budget {
        if ready() {
            return true;
        }
        wait(poll);
    }
    false
}

#[cfg(target_os = "windows")]
fn await_wsl_route_ready(app: &tauri::AppHandle, via_wsl: bool) -> bool {
    let start = Instant::now();
    let upgraded = resolve_route_upgrade(
        via_wsl,
        operator_boot_timeout(true),
        WSL_ROUTE_POLL_INTERVAL,
        || should_route_via_wsl(app),
        std::thread::sleep,
        || start.elapsed(),
    );
    if upgraded && !via_wsl {
        println!(
            "[papercusp-gui] WSL became Ready post-boot — routing discovery through the \
             distro instead of the Windows-side home (WI-37798)"
        );
        // Re-publish for AppHandle-less call sites (native pty), mirroring
        // gui_setup's original set_route_active — otherwise they keep the
        // stale non-WSL route this function just corrected.
        wsl_setup::set_route_active(true);
    } else if !upgraded {
        eprintln!(
            "[papercusp-gui] WSL never became Ready within the boot budget — continuing on the \
             non-WSL discovery path (WI-37798)"
        );
    }
    upgraded
}

#[cfg(not(target_os = "windows"))]
fn await_wsl_route_ready(_app: &tauri::AppHandle, via_wsl: bool) -> bool {
    via_wsl
}

/// Translate a Windows path to a WSL-visible path. Pure string
/// manipulation — doesn't shell out to `wslpath`. Handles:
///
///   - Drive letters:        `C:\foo\bar`     → `/mnt/c/foo/bar`
///   - Long-path syntax:     `\\?\C:\foo`     → `/mnt/c/foo`
///   - UNC long-path:        `\\?\UNC\srv\s` → `//srv/s` (rare; passes
///                           through with forward slashes — WSL mounts
///                           UNC paths via 9p, but only when the user
///                           explicitly mounted them; we leave the path
///                           as a forward-slash UNC and let the kernel
///                           ENOENT if unmounted)
///   - Plain UNC:            `\\srv\share`    → `//srv/share`
///   - Already-posix:        `/foo/bar`       → `/foo/bar` (no-op)
///
/// Defined on every platform so the helper is unit-testable from CI
/// regardless of host OS. Used by the Windows-only sidecar-via-WSL
/// path; see `make_sidecar_command`.
/// Auto-grant getUserMedia (microphone/camera) on Linux WebKitGTK.
///
/// WebKitGTK denies media access by default — the webview emits a
/// `permission-request` signal and refuses if nobody listens. That
/// surfaces in JS as `navigator.mediaDevices.getUserMedia()` rejecting
/// with `NotAllowedError`, which the operator's voice/wake-word/
/// elevenlabs paths report as console errors on every page load when
/// the user has `lastMode != 'off'` saved.
///
/// We auto-grant because the Tauri shell is the only consumer of the
/// webview — there is no third-party site asking; permission gating
/// would just trip up our own code.
#[cfg(target_os = "linux")]
fn grant_media_permission<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.with_webview(|webview| {
        use webkit2gtk::glib::ObjectExt;
        use webkit2gtk::WebViewExt;
        let wv: webkit2gtk::WebView = webview.inner();
        wv.connect_permission_request(|_, req| {
            // Allow audio/video media access requests; pass on everything else.
            if req.is::<webkit2gtk::UserMediaPermissionRequest>() {
                use webkit2gtk::PermissionRequestExt;
                req.allow();
            }
            // Returning false means "we didn't handle it"; for media we
            // already called allow() so the request is satisfied either way.
            false
        });
    });
}

/// EI-239: a main-frame load failure (operator briefly down during a reload
/// or full navigation) used to strand the webview on WebKitGTK's raw
/// "Could not connect" page — where even Ctrl+R after recovery is dead, and
/// production builds (no dev-wrapper target buttons) had NO recovery short
/// of restarting the app. Replace it with a bundled retry page that polls
/// the failed URI and navigates back the moment the origin answers.
///
/// WI-10002878 (#463): the page must not claim the operator was LOST when it
/// never answered in the first place. `tauri dev --no-dev-server-wait` opens
/// the window before `bin/hono-host.ts` is listening, and a production cold
/// start can race its sidecar the same way — so every cold start used to
/// greet the user with "Papercusp lost its operator process". Each webview
/// now remembers which origins have COMMITTED a main-frame load (WebKit only
/// commits once a server returned a response; a refused connection fails
/// provisionally and never commits). A failure on an origin that has never
/// answered renders the "starting" variant; the "lost" wording is reserved
/// for an origin that was up before.
#[cfg(target_os = "linux")]
fn install_load_failure_recovery<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.with_webview(|webview| {
        use std::sync::Arc;
        use webkit2gtk::WebViewExt;
        let wv: webkit2gtk::WebView = webview.inner();
        let tracker = Arc::new(Mutex::new(RecoveryTracker::default()));
        {
            let tracker = Arc::clone(&tracker);
            wv.connect_load_changed(move |wv, event| {
                if event != webkit2gtk::LoadEvent::Committed {
                    return;
                }
                if let Ok(mut t) = tracker.lock() {
                    t.on_committed(wv.uri().as_deref());
                }
            });
        }
        wv.connect_load_failed(move |wv, _event, failing_uri, error| {
            // Cancellations are NORMAL navigation (a load superseded by a
            // newer one, a download) — intercepting them would break the app.
            if error.matches(webkit2gtk::NetworkError::Cancelled)
                || error.matches(webkit2gtk::PolicyError::FrameLoadInterruptedByPolicyChange)
            {
                return false;
            }
            eprintln!(
                "[papercusp-desktop] main-frame load failed for {failing_uri} ({error}) — showing recovery page"
            );
            let kind = tracker
                .lock()
                .map(|mut t| t.on_failed(failing_uri))
                .unwrap_or(RecoveryKind::Starting);
            // content_uri = the failed URI so the page keeps that security
            // origin: its same-origin health poll dials exactly the origin
            // that died.
            wv.load_alternate_html(
                &recovery_page_html(failing_uri, kind),
                failing_uri,
                Some(failing_uri),
            );
            true
        });
    });
}

/// Which story the recovery page tells (WI-10002878): `Starting` when the
/// failing origin has never answered in this webview (a cold start still
/// waiting on the operator's boot), `Lost` when it answered before and has
/// since gone away.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecoveryKind {
    Starting,
    Lost,
}

/// Per-webview bookkeeping behind install_load_failure_recovery, kept pure so
/// the commit/fail sequencing is unit-testable without a WebKit instance.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Default)]
struct RecoveryTracker {
    /// Origins that have COMMITTED a real main-frame load (i.e. answered).
    answered: std::collections::HashSet<String>,
    /// Set when a recovery page is about to load: its own commit carries the
    /// failed URI as content URI and must not count as the operator answering.
    alternate_pending: bool,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
impl RecoveryTracker {
    /// A main-frame load committed at `uri`.
    fn on_committed(&mut self, uri: Option<&str>) {
        if std::mem::take(&mut self.alternate_pending) {
            return;
        }
        if let Some(origin) = uri.and_then(uri_origin) {
            self.answered.insert(origin);
        }
    }

    /// A main-frame load failed at `failing_uri` and the recovery page is
    /// about to be shown: which variant should it be?
    fn on_failed(&mut self, failing_uri: &str) -> RecoveryKind {
        self.alternate_pending = true;
        match uri_origin(failing_uri) {
            Some(origin) if self.answered.contains(&origin) => RecoveryKind::Lost,
            _ => RecoveryKind::Starting,
        }
    }
}

/// `scheme://host[:port]` of a URI, lower-cased, or `None` when it has no
/// authority (about:blank, data:, a bare path). The origin — not the full
/// URI — is what "has this operator answered before" is keyed on, so an
/// in-app navigation to a new route still counts as the same operator.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn uri_origin(uri: &str) -> Option<String> {
    let (scheme, rest) = uri.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if scheme.is_empty() || authority.is_empty() {
        return None;
    }
    Some(format!("{}://{}", scheme.to_ascii_lowercase(), authority.to_ascii_lowercase()))
}

fn restore_window_visibility_once<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    reason: &str,
) {
    #[cfg(target_os = "linux")]
    {
        let reason_for_gtk = reason.to_string();
        let window_for_gtk = window.clone();
        if let Err(e) = window.run_on_main_thread(move || {
            use gtk::prelude::*;
            match window_for_gtk.gtk_window() {
                Ok(gtk_window) => {
                    gtk_window.set_skip_taskbar_hint(false);
                    gtk_window.set_skip_pager_hint(false);
                    gtk_window.deiconify();
                    gtk_window.present();
                }
                Err(e) => {
                    eprintln!(
                        "[papercusp-desktop] window restore ({reason_for_gtk}): gtk_window failed: {e}"
                    );
                }
            }
        }) {
            eprintln!(
                "[papercusp-desktop] window restore ({reason}): main-thread GTK restore failed: {e}"
            );
        }
    }

    if let Err(e) = window.unminimize() {
        eprintln!("[papercusp-desktop] window restore ({reason}): unminimize failed: {e}");
    }
    if let Err(e) = window.show() {
        eprintln!("[papercusp-desktop] window restore ({reason}): show failed: {e}");
    }
    if let Err(e) = window.set_focus() {
        eprintln!("[papercusp-desktop] window restore ({reason}): set_focus failed: {e}");
    }
}

fn restore_window_visibility<R: tauri::Runtime + 'static>(
    window: &tauri::WebviewWindow<R>,
    reason: &'static str,
) {
    restore_window_visibility_once(window, reason);

    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        for delay_ms in [250_u64, 1_000, 2_500] {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            restore_window_visibility_once(&window, reason);
        }
    });
}

/// The bundled offline-recovery page (EI-239). Self-contained inline
/// HTML+JS: polls the failed URI once a second (any HTTP response counts —
/// an error status still proves the origin is back) and navigates to it on
/// recovery; a manual "Retry now" button covers schemes where fetch can't
/// poll. The URI is embedded as a JSON string literal, with `<` further
/// escaped to `<`: JSON alone leaves `</script>` intact inside the
/// literal, which would still terminate the script element.
#[cfg(target_os = "linux")]
fn recovery_page_html(failing_uri: &str, kind: RecoveryKind) -> String {
    let uri_js = serde_json::to_string(failing_uri)
        .unwrap_or_else(|_| "\"/\"".to_string())
        .replace('<', "\\u003c");
    let (title, heading, detail) = match kind {
        RecoveryKind::Starting => (
            "Papercusp — starting",
            "Starting Papercusp…",
            "Waiting for the operator process to finish starting up. This window opens automatically the moment it answers.",
        ),
        RecoveryKind::Lost => (
            "Papercusp — reconnecting",
            "Papercusp lost its operator process",
            "The window will reconnect automatically as soon as the operator is back. Nothing is lost — this page is polling for it.",
        ),
    };
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>{title}</title><style>
  html,body{{height:100%;margin:0;background:#101216;color:#d6dae2;font:14px/1.5 ui-sans-serif,system-ui,sans-serif}}
  .wrap{{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:24px}}
  h1{{font-size:17px;font-weight:600;margin:0}}
  p{{margin:0;color:#8a92a3;max-width:46ch}}
  button{{margin-top:6px;padding:7px 18px;border-radius:8px;border:1px solid #3a4254;background:#1a1f29;color:#d6dae2;font:inherit;cursor:pointer}}
  button:hover{{background:#232a38}}
  .dot{{width:9px;height:9px;border-radius:50%;background:#e0b54a;animation:b 1.2s ease-in-out infinite}}
  @keyframes b{{50%{{opacity:.25}}}}
</style></head><body><div class="wrap">
  <div class="dot"></div>
  <h1>{heading}</h1>
  <p>{detail}</p>
  <button onclick="location.replace(TARGET)">Retry now</button>
  <script>
    const TARGET = {uri_js};
    async function poll() {{
      try {{
        await fetch(TARGET, {{ method: 'HEAD', cache: 'no-store' }});
        location.replace(TARGET);
      }} catch (_e) {{
        setTimeout(poll, 1000);
      }}
    }}
    poll();
  </script>
</div></body></html>"#
    )
}

// Only compiled where it is actually used: the production callers live in the
// `#[cfg(target_os = "windows")]` block of make_sidecar_command, and the unit
// tests below exercise it on every platform. Without this gate a non-test Linux
// build (the dev-box default `cargo check`) sees zero callers → dead_code warn.
#[cfg(any(target_os = "windows", test))]
fn windows_path_to_wsl(path: &std::path::Path) -> String {
    let s = path.to_string_lossy().to_string();
    // Windows PathBuf::join appends backslashes even to a POSIX runtime root.
    // This boundary receives Windows-authored paths, not literal Linux names.
    if s.starts_with('/') && !s.starts_with("//") {
        return s.replace('\\', "/");
    }

    // Strip the long-path prefix (`\\?\` or `\\?\UNC\`). Beyond
    // ~260-char paths, Windows APIs use this prefix — it shows up in
    // resource resolution sometimes.
    let rest = if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
        // \\?\UNC\server\share\... — re-form as a regular UNC path so
        // the rest of the function handles it.
        format!(r"\\{}", stripped)
    } else if let Some(stripped) = s.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        s
    };

    // Plain UNC path (`\\server\share\...`)? Translate to forward
    // slashes; WSL doesn't have a built-in mount for these, but the
    // forward-slash form is what wsl.exe interprets identically when
    // a 9p mount happens to exist.
    if rest.starts_with(r"\\") {
        return rest.replace('\\', "/");
    }

    let normalized = rest.replace('\\', "/");

    // Drive-letter prefix: `C:/foo` → `/mnt/c/foo`.
    if let Some((drive, after)) = normalized.split_once(':') {
        if drive.len() == 1
            && drive
                .chars()
                .next()
                .map(|c| c.is_ascii_alphabetic())
                .unwrap_or(false)
        {
            let drive_lower = drive.to_lowercase();
            // Ensure the rest starts with `/` (handles `C:foo` weirdly
            // by keeping it relative, though that's not a valid
            // Windows resource path in our context).
            let after = if after.starts_with('/') {
                after.to_string()
            } else {
                format!("/{}", after)
            };
            return format!("/mnt/{}{}", drive_lower, after);
        }
    }

    normalized
}

/// Content generation used for the distro-local Windows sidecar snapshot.
///
/// The stamp still gates readiness, but serveSha256 identifies only ONE file.
/// The key covers the entire hot payload so a repaired install cannot reuse an
/// older completed snapshot with the same serve.mjs and obsolete SPA/dependency
/// files.
///
/// WI-10003673: the Windows packer ships that key precomputed, bound to these
/// exact stamp bytes, so a normal boot costs two small reads instead of hashing
/// ~5 GB before the marker probe (measured ~9 min per boot on the VM). The walk
/// stays as the fallback for an install without a matching record.
#[cfg(any(target_os = "windows", test))]
fn sidecar_runtime_generation(sidecar_dir: &std::path::Path) -> std::io::Result<String> {
    let stamp_path = sidecar_dir.join(".sidecar-build-stamp");
    let stamp_bytes = std::fs::read(&stamp_path)?;
    let stamp: serde_json::Value = serde_json::from_slice(&stamp_bytes).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid {}: {error}", stamp_path.display()),
        )
    })?;
    let _serve_sha = stamp
        .get("serveSha256")
        .and_then(serde_json::Value::as_str)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("{} has no valid 64-hex serveSha256", stamp_path.display()),
            )
        })?;
    match sidecar_runtime_identity::precomputed_generation(sidecar_dir, &stamp_bytes) {
        Ok(Some(generation)) => return Ok(generation),
        Ok(None) => eprintln!(
            "[papercusp-desktop] no {} in {}; hashing the installed sidecar tree (slow path)",
            sidecar_runtime_identity::PRECOMPUTED_GENERATION_FILE,
            sidecar_dir.display()
        ),
        Err(error) => eprintln!(
            "[papercusp-desktop] ignoring precomputed sidecar generation ({error}); hashing the installed sidecar tree (slow path)"
        ),
    }
    sidecar_runtime_identity::generation(sidecar_dir)
}

#[cfg(any(target_os = "windows", test))]
fn wsl_runtime_sidecar_path(base: &str, generation: &str) -> std::io::Result<std::path::PathBuf> {
    if generation.len() != 64 || !generation.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "sidecar runtime generation must be exactly 64 hex characters",
        ));
    }
    Ok(std::path::PathBuf::from(format!(
        "{}/runtime-sidecars/{}",
        base.trim_end_matches('/'),
        generation.to_ascii_lowercase()
    )))
}

/// Serializes every test IN THIS BINARY that mutates the process-global
/// `HOME` (or `USERPROFILE`) env var. `cargo test` runs test functions on
/// separate threads within ONE process by default, so two HOME-mutating
/// tests running concurrently is a REAL, observed race — each can read the
/// OTHER's HOME mid-test (WI-5321: `workspaces::tests::
/// ensure_initialized_mints_a_real_non_default_id_and_migrates_legacy_dir`
/// intermittently failed racing this file's own
/// `pending_route_round_trip_is_one_shot_and_sanitized`, in different
/// modules, only visible when the FULL suite's extra concurrent threads
/// made the race land). Any test that calls `std::env::set_var("HOME", ..)`
/// MUST hold this lock for the whole set→act→restore span — `unwrap_or_else`
/// recovers a poisoned lock (a prior panicking test must not deadlock the
/// rest).
#[cfg(test)]
pub(crate) static HOME_ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::{
        provision_env_operators_for, sidecar_runtime_generation, sidecar_wslenv,
        windows_path_to_wsl, wsl_runtime_sidecar_path,
    };
    use std::path::PathBuf;

    fn t(input: &str, expected: &str) {
        let got = windows_path_to_wsl(&PathBuf::from(input));
        assert_eq!(got, expected, "input={:?}", input);
    }

    /// The sidecar runs INSIDE WSL2 on Windows, so a var set with `Command::env`
    /// reaches it ONLY if it is also named in WSLENV. A var that is set but not
    /// listed is dropped SILENTLY — no error, no log, Windows only, at runtime.
    ///
    /// That is how Windows auto-update shipped dead: PAPERCUSP_RELEASE_HOST was
    /// baked into the .exe and set via `.env(...)`, but never crossed into WSL, so
    /// `releaseHostBase()` read undefined, the manifest route answered
    /// `cannot_check`, and the updater rendered that as "you're on the latest" —
    /// permanently. The bake was real; the value never arrived where it was used.
    ///
    /// This test pins the vars whose ABSENCE is silent-but-fatal. It is the only
    /// thing standing between the two lists (`.env(...)` and WSLENV) and the next
    /// silent divergence.
    #[test]
    fn wslenv_forwards_every_var_the_sidecar_reads() {
        let wslenv = super::SIDECAR_WSLENV;
        // Split on ':' and strip any '/p' (path-translation) suffix, so a var is
        // matched as a NAME — never as a substring of a longer var, which would
        // let PAPERCUSP_RELEASE_HOST_FOO satisfy a check for PAPERCUSP_RELEASE_HOST.
        let names: Vec<&str> = wslenv
            .split(':')
            .map(|e| e.trim())
            .map(|e| e.split('/').next().unwrap_or(e))
            .filter(|e| !e.is_empty())
            .collect();

        for required in [
            // THE ONE THIS TEST EXISTS FOR: the sidecar's releaseHostBase() reads
            // process.env.PAPERCUSP_RELEASE_HOST. Without this, auto-update is dead
            // on Windows and reports success while being dead.
            "PAPERCUSP_RELEASE_HOST",
            // WI-4389 follow-up: workspace-registry.ts reads this to resolve the
            // real (unremapped) workspace root; dropped silently the same way
            // PAPERCUSP_RELEASE_HOST was.
            "PAPERCUSP_WORKSPACES_ROOT",
            // Endpoint-IPC: WI-3395 — PAPERCUSP_IPC_ENABLE not crossing is why the
            // IPC server never even STARTED inside WSL2 under packaged production.
            "PAPERCUSP_IPC_ENABLE",
            "PAPERCUSP_IPC_TCP",
            // The sidecar cannot serve or find itself without these.
            "PAPERCUSP_HONO_PORT",
            "PAPERCUSP_BIND_HOST",
            "PAPERCUSP_SIDECAR_BIN",
            "PAPERCUSP_SERVE_UI",
            // D-043/P-050: the immutable runtime guard reads the exact profile.
            "PAPERCUSP_DISTRIBUTION_PROFILE",
            // WI-39304: logical seed restore needs the bundled pg_restore path;
            // dropping it here makes Windows silently fall back to full replay.
            "PAPERCUSP_PG_RESTORE_BIN",
            // WI-5305: the isolation escape hatch (papercusp-root.ts resolve())
            // must cross the WSL boundary too, or a caller's env override
            // silently no-ops on Windows while working on Linux/Mac.
            "PAPERCUSP_HOME",
        ] {
            assert!(
                names.contains(&required),
                "{required} is NOT in WSLENV — on Windows the sidecar runs inside WSL2, so this \
                 var will be set by Command::env and then silently dropped at the boundary. \
                 It will look fine on Linux and Mac and be dead on Windows. WSLENV = {wslenv}"
            );
        }
    }

    #[test]
    fn vm_release_forces_environment_operator_provisioning_off() {
        assert_eq!(provision_env_operators_for("vm-release", false, None), "0");
        assert_eq!(provision_env_operators_for("dogfood", false, None), "1");
        assert_eq!(provision_env_operators_for("", false, None), "1");
    }

    /// WI-10006420: the headless Server never provisions the desktop
    /// env-switcher operators, whatever profile it was built with.
    #[test]
    fn headless_service_forces_environment_operator_provisioning_off() {
        for profile in ["dogfood", "vm-release", ""] {
            assert_eq!(provision_env_operators_for(profile, true, Some("1")), "0", "{profile}");
        }
    }

    #[test]
    fn environment_operator_provisioning_respects_explicit_opt_out() {
        for profile in ["dogfood", "public", ""] {
            assert_eq!(provision_env_operators_for(profile, false, Some("0")), "0", "{profile}");
            for requested in [None, Some("1"), Some(""), Some("false")] {
                assert_eq!(provision_env_operators_for(profile, false, requested), "1", "{profile}");
            }
        }
        assert_eq!(provision_env_operators_for("vm-release", false, Some("1")), "0");
    }

    #[test]
    fn windows_sidecar_runtime_generation_is_content_addressed_and_path_safe() {
        let dir = std::env::temp_dir().join(format!(
            "papercusp-wi305737-generation-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sha = "ABCDEF0123456789".repeat(4);
        std::fs::write(
            dir.join(".sidecar-build-stamp"),
            format!(r#"{{"serveSha256":"{sha}"}}"#),
        )
        .unwrap();

        let generation = sidecar_runtime_generation(&dir).unwrap();
        assert_eq!(generation.len(), 64);
        assert_eq!(generation, sidecar_runtime_generation(&dir).unwrap());
        std::fs::write(dir.join("non-serve-repair.js"), "new dependency").unwrap();
        assert_ne!(generation, sidecar_runtime_generation(&dir).unwrap());
        assert_eq!(
            wsl_runtime_sidecar_path("/home/papercup/.papercusp/", &generation).unwrap(),
            std::path::PathBuf::from(format!(
                "/home/papercup/.papercusp/runtime-sidecars/{generation}"
            ))
        );
        assert!(wsl_runtime_sidecar_path("/home/papercup/.papercusp", "../escape").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// WI-10003673: a record bound to the installed stamp is the key and the
    /// ~5 GB walk never runs; an unbound record falls back to the walk. The
    /// non-UTF-8 filename makes the walk fail loudly, which is how this test
    /// tells "returned the record" apart from "walked and happened to match".
    #[test]
    #[cfg(unix)]
    fn windows_sidecar_runtime_generation_prefers_the_bound_precomputed_record() {
        use sha2::{Digest, Sha256};
        use std::os::unix::ffi::OsStrExt;
        let dir = std::env::temp_dir().join(format!(
            "papercusp-wi10003673-generation-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let stamp = format!(r#"{{"serveSha256":"{}"}}"#, "ab".repeat(32));
        std::fs::write(dir.join(".sidecar-build-stamp"), &stamp).unwrap();
        let walked = sidecar_runtime_generation(&dir).unwrap();

        std::fs::write(dir.join(std::ffi::OsStr::from_bytes(b"not-utf8-\xff")), "x").unwrap();
        assert!(
            sidecar_runtime_generation(&dir).is_err(),
            "without a record the launcher must walk (and this tree makes the walk fail)"
        );

        let precomputed = "cd".repeat(32);
        let record = |stamp_sha: String| {
            format!(
                r#"{{"schema":"papercusp-sidecar-runtime-generation/v1","generation":"{precomputed}","stampSha256":"{stamp_sha}"}}"#
            )
        };
        let bound = format!("{:x}", Sha256::digest(stamp.as_bytes()));
        std::fs::write(dir.join(".sidecar-runtime-generation"), record(bound)).unwrap();
        assert_eq!(sidecar_runtime_generation(&dir).unwrap(), precomputed);

        let other = format!("{:x}", Sha256::digest(b"another build's stamp"));
        std::fs::write(dir.join(".sidecar-runtime-generation"), record(other)).unwrap();
        assert!(
            sidecar_runtime_generation(&dir).is_err(),
            "a record bound to another stamp must fall back to the walk"
        );
        std::fs::remove_file(dir.join(std::ffi::OsStr::from_bytes(b"not-utf8-\xff"))).unwrap();
        assert_eq!(
            sidecar_runtime_generation(&dir).unwrap(),
            walked,
            "the fallback walk ignores the record file itself"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn distro_local_sidecar_paths_are_not_retranslated_by_wslenv() {
        let native = sidecar_wslenv(true);
        let translated = sidecar_wslenv(false);
        for name in [
            "PAPERCUSP_HARNESS_DIR",
            "PAPERCUSP_TEMPLATES_DIR",
            "PAPERCUSP_RUBRICS_DIR",
            "PAPERCUSP_GOAL_PACKAGES_DIR",
            "PAPERCUSP_PG_SQL_DIR",
            "PAPERCUSP_PG_RESTORE_BIN",
            "PAPERCUSP_SPA_DIST",
            "PAPERCUSP_DOCS_ROOT",
            "PAPERCUSP_PROMPTS_DIR",
            "PAPERCUSP_SIDECAR_BIN",
        ] {
            assert!(
                native.split(':').any(|entry| entry == name),
                "{name} must cross unchanged once its value is WSL-native: {native}"
            );
            assert!(
                translated
                    .split(':')
                    .any(|entry| entry == format!("{name}/p")),
                "{name} must retain Windows→WSL translation before staging: {translated}"
            );
        }
        for still_windows_native in [
            "PAPERCUSP_SEED_DIR/p",
            "PAPERCUSP_PG_SEED_PATH/p",
            "PAPERCUSP_SOURCE_ARCHIVE/p",
            "PAPERCUSP_IDENTITY_DIR/p",
        ] {
            assert!(
                native.split(':').any(|entry| entry == still_windows_native),
                "one-time Windows resource {still_windows_native} must keep /p translation"
            );
        }
    }

    /// WI-37736 — the INVERSE of the test above, and the reason it exists:
    /// forwarding is not always the safe default. Some vars are actively
    /// DANGEROUS across the WSL2 boundary, and this pins the one that shipped a
    /// completely dead Windows 0.0.14-alpha.
    ///
    /// `PAPERCUSP_DESKTOP_PARENT_PID` carries the desktop process's
    /// WINDOWS-NATIVE pid. The sidecar runs inside WSL2 and compares it against
    /// its own `process.ppid` — a value from a different kernel and a different
    /// PID namespace, so the two can never legitimately match. The sidecar's
    /// parent-death watch therefore concluded "my parent died" on EVERY launch
    /// and self-terminated ~1s in, before writing operator.json. The UI rendered
    /// and reported the right version; every data call failed.
    ///
    /// The neighbouring test makes "add it to WSLENV" the reflex for any var the
    /// sidecar reads. That reflex is what would silently re-break Windows here,
    /// which is exactly why the prohibition needs a test of its own rather than a
    /// comment: a comment cannot fail a build.
    #[test]
    fn wslenv_never_forwards_windows_native_pids() {
        fn names_of(wslenv: &str) -> Vec<&str> {
            wslenv
                .split(':')
                .map(|e| e.trim())
                .map(|e| e.split('/').next().unwrap_or(e))
                .filter(|e| !e.is_empty())
                .collect()
        }

        // FALSIFIABILITY SELF-CHECK. A guard that has never failed is a guard
        // nobody has tested, and this one asserts an ABSENCE — the failure mode
        // where a broken parser silently reports "not present" for everything and
        // the guard passes forever while protecting nothing. Prove the detection
        // fires on a string that DOES contain the forbidden var before trusting
        // its verdict on the real one. (Done with an in-test fixture rather than
        // by mutating SIDECAR_WSLENV: git-sync commits the whole tree on a timer,
        // so a temporarily-mutated shared file can be committed mid-probe.)
        let poisoned = "PAPERCUSP_DESKTOP:PAPERCUSP_DESKTOP_PARENT_PID:HOME/p";
        assert!(
            names_of(poisoned).contains(&"PAPERCUSP_DESKTOP_PARENT_PID"),
            "the name parser failed to spot the forbidden var in a string that \
             definitely contains it — so a PASS below would prove nothing"
        );

        let wslenv = super::SIDECAR_WSLENV;
        let names = names_of(wslenv);

        for forbidden in ["PAPERCUSP_DESKTOP_PARENT_PID"] {
            assert!(
                !names.contains(&forbidden),
                "{forbidden} is in WSLENV, but it holds a WINDOWS-NATIVE pid and the sidecar \
                 compares it against a WSL2 (Linux) ppid — two different PID namespaces, so it \
                 can NEVER match. This kills the sidecar on every launch and ships a Windows \
                 build whose UI renders while every data call fails (WI-37736). It is set only \
                 on the non-WSL branch in spawn_serve. WSLENV = {wslenv}"
            );
        }
    }

    /// WI-5305: `PAPERCUSP_HOME` must actually redirect the WSL-side discovery
    /// paths a caller reads back (`operator.json` / `endpoint-ipc.json`), not
    /// just cross the WSLENV boundary — a var that arrives but isn't consulted
    /// is exactly as dead as one that never arrives. Covers: the default
    /// (unset) falls back to the shared distro home; a Windows-style override
    /// is translated via `windows_path_to_wsl`; an already-POSIX override is
    /// left alone.
    #[test]
    fn papercusp_home_override_redirects_wsl_discovery_paths() {
        use super::{wsl_endpoint_ipc_json_path, wsl_operator_json_path};

        if std::env::var_os("PAPERCUSP_WSL_DISCOVERY_TEST_CHILD").is_none() {
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "tests::papercusp_home_override_redirects_wsl_discovery_paths", "--nocapture"])
                .env("PAPERCUSP_WSL_DISCOVERY_TEST_CHILD", "1")
                .output().unwrap();
            assert!(result.status.success(), "{}\n{}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
            return;
        }
        // SAFETY: this child runs only this test, so changing its environment
        // cannot race the native discovery tests in the parent Cargo process.
        let prev = std::env::var_os("PAPERCUSP_HOME");

        unsafe {
            std::env::remove_var("PAPERCUSP_HOME");
        }
        assert_eq!(
            wsl_operator_json_path(),
            "/home/papercup/.papercusp/operator.json",
            "unset PAPERCUSP_HOME must fall back to the shared distro home"
        );
        assert_eq!(
            wsl_endpoint_ipc_json_path(),
            "/home/papercup/.papercusp/endpoint-ipc.json"
        );

        unsafe {
            std::env::set_var("PAPERCUSP_HOME", r"C:\Users\User\iso-home\.papercusp");
        }
        assert_eq!(
            wsl_operator_json_path(),
            "/mnt/c/Users/User/iso-home/.papercusp/operator.json",
            "a Windows-style override must be translated, not used verbatim"
        );
        assert_eq!(
            wsl_endpoint_ipc_json_path(),
            "/mnt/c/Users/User/iso-home/.papercusp/endpoint-ipc.json"
        );

        unsafe {
            std::env::set_var("PAPERCUSP_HOME", "/home/other-user/.papercusp");
        }
        assert_eq!(
            wsl_operator_json_path(),
            "/home/other-user/.papercusp/operator.json",
            "an already-POSIX override must be left alone"
        );

        unsafe {
            match prev {
                Some(v) => std::env::set_var("PAPERCUSP_HOME", v),
                None => std::env::remove_var("PAPERCUSP_HOME"),
            }
        }
    }

    /// EI-239: the recovery page embeds the failed URI as a JSON string
    /// literal — quoting in the URL must not escape the script context.
    #[cfg(target_os = "linux")]
    #[test]
    fn recovery_page_embeds_uri_safely() {
        let html = super::recovery_page_html("http://127.0.0.1:3170/adv?ws=x", super::RecoveryKind::Lost);
        assert!(html.contains(r#"const TARGET = "http://127.0.0.1:3170/adv?ws=x";"#));
        assert!(html.contains("Retry now"));

        let hostile = super::recovery_page_html(
            r#"http://x/"</script><script>alert(1)"#,
            super::RecoveryKind::Starting,
        );
        // The quote is JSON-escaped and `<` is unicode-escaped, so neither a
        // raw </script> nor a raw <script> from the URI survives in the HTML.
        assert!(!hostile.contains("</script><script>alert"));
        assert!(hostile.contains(r#"\""#));
        assert!(hostile.contains(r"</script"));
    }

    /// WI-10002878 (#463): a cold start — the operator has never answered —
    /// must not tell the user the operator was LOST. Only an origin that was
    /// up before gets the "lost" wording. Both variants keep polling.
    #[cfg(target_os = "linux")]
    #[test]
    fn recovery_page_cold_start_does_not_claim_the_operator_was_lost() {
        let uri = "http://127.0.0.1:3270/adv?ws=papercusp-workspace";
        let starting = super::recovery_page_html(uri, super::RecoveryKind::Starting);
        assert!(!starting.contains("lost its operator process"), "cold start must not claim a loss");
        assert!(starting.contains("Starting Papercusp"));
        assert!(starting.contains("<title>Papercusp — starting</title>"));
        assert!(starting.contains("poll();"), "the starting page must still poll for the operator");

        let lost = super::recovery_page_html(uri, super::RecoveryKind::Lost);
        assert!(lost.contains("Papercusp lost its operator process"));
        assert!(lost.contains("<title>Papercusp — reconnecting</title>"));
        assert!(lost.contains("poll();"));
    }

    /// WI-10002878: the commit/fail sequencing WebKit drives. The recovery
    /// page's OWN commit (alternate HTML under the failed URI) must not count
    /// as the operator answering, or a retry during a cold start would flip to
    /// the "lost" wording. Mirrors the live A/A2/C/D headless check.
    #[test]
    fn recovery_tracker_tells_cold_start_from_loss() {
        use super::RecoveryKind::{Lost, Starting};
        let mut t = super::RecoveryTracker::default();
        let op = "http://127.0.0.1:3270/adv?ws=papercusp-workspace";

        assert_eq!(t.on_failed(op), Starting, "A: first load before the operator listens");
        t.on_committed(Some(op)); // the recovery page's own commit
        assert_eq!(t.on_failed(op), Starting, "A2: a retry that fails again is still a cold start");
        t.on_committed(Some(op)); // recovery page again
        t.on_committed(Some("http://127.0.0.1:3270/adv?tab=harnesses")); // operator answered
        assert_eq!(t.on_failed(op), Lost, "C: it was up before, now it is gone");
        t.on_committed(Some(op)); // recovery page
        assert_eq!(
            t.on_failed("http://127.0.0.1:3170/adv"),
            Starting,
            "D: a different operator origin that never answered"
        );
        t.on_committed(None); // a commit with no URI must not panic or record anything
        assert_eq!(t.on_failed("http://127.0.0.1:3170/adv"), Starting);
    }

    /// The "has this operator answered before" memory is keyed on origin, so
    /// every route of one operator shares it and a different port does not.
    #[test]
    fn uri_origin_keys_on_scheme_host_and_port() {
        use super::uri_origin;
        assert_eq!(
            uri_origin("http://127.0.0.1:3270/adv?tab=harnesses&ws=x").as_deref(),
            Some("http://127.0.0.1:3270")
        );
        assert_eq!(uri_origin("http://127.0.0.1:3270").as_deref(), Some("http://127.0.0.1:3270"));
        assert_eq!(uri_origin("HTTP://LocalHost:3070?x=1").as_deref(), Some("http://localhost:3070"));
        assert_eq!(uri_origin("tauri://localhost/index.html#/a").as_deref(), Some("tauri://localhost"));
        assert_ne!(uri_origin("http://127.0.0.1:3270/"), uri_origin("http://127.0.0.1:3170/"));
        assert_eq!(uri_origin("about:blank"), None);
        assert_eq!(uri_origin("/relative/path"), None);
        assert_eq!(uri_origin("http:///no-authority"), None);
    }

    #[test]
    fn drive_letter() {
        t(r"C:\foo\bar", "/mnt/c/foo/bar");
        t(r"D:\Users\me\Desktop", "/mnt/d/Users/me/Desktop");
        t(r"c:\lower", "/mnt/c/lower");
    }

    #[test]
    fn long_path_prefix() {
        t(r"\\?\C:\very\long\path", "/mnt/c/very/long/path");
        t(r"\\?\D:\foo", "/mnt/d/foo");
    }

    #[test]
    fn unc_long_path_prefix() {
        // \\?\UNC\server\share\path → //server/share/path
        t(r"\\?\UNC\srv\share\file", "//srv/share/file");
    }

    #[test]
    fn plain_unc() {
        t(r"\\server\share\foo", "//server/share/foo");
    }

    #[test]
    fn already_posix_passthrough() {
        // Forward-slash absolute paths aren't transformed (they may be
        // legitimate Linux paths in the WSL distro).
        t("/home/papercup", "/home/papercup");
    }

    #[test]
    fn forward_slash_drive_letter() {
        // `C:/foo` is an alternate Windows form; treat it the same as
        // backslash form.
        t("C:/foo/bar", "/mnt/c/foo/bar");
    }

    #[test]
    fn mixed_separators() {
        t(r"C:\foo/bar\baz", "/mnt/c/foo/bar/baz");
    }

    /// P-009: the single-instance lock keys on the app IDENTIFIER, so the two
    /// bundles' identifiers MUST stay distinct — otherwise both bundles would
    /// share ONE lock and a GUI + a Server would evict each other instead of
    /// coexisting (the GUI attaching to the sidecar-owning Server). This is the
    /// load-bearing invariant behind per-bundle-identity single-instance.
    #[test]
    fn bundle_ids_are_distinct_for_per_bundle_single_instance() {
        assert_ne!(
            super::SERVER_BUNDLE_ID,
            super::GUI_BUNDLE_ID,
            "GUI and Server bundle ids must differ or their single-instance locks collapse"
        );
        // And each identifier maps to the role on_second_instance() expects.
        use crate::app_role::{detect, Role};
        assert_eq!(detect(super::SERVER_BUNDLE_ID), Role::Server);
        assert_eq!(detect(super::GUI_BUNDLE_ID), Role::Gui);
    }

    #[test]
    fn spaces_in_username_preserved() {
        // WI-792 P-004 / alpha P-010g (spaces-in-username path-translation edge):
        // a Windows username with spaces must survive translation INTACT. The
        // translated path is passed to wsl.exe as a SINGLE argv element by
        // make_sidecar_command (`.args([…, &cwd_wsl, …])`, NOT a shell string),
        // so an embedded space does not split the argument — the only requirement
        // is that translation leave the space untouched. This guards that.
        t(
            r"C:\Users\First Last\AppData\Local\Papercusp",
            "/mnt/c/Users/First Last/AppData/Local/Papercusp",
        );
        t(
            r"C:\Users\Ada Lovelace\.papercusp",
            "/mnt/c/Users/Ada Lovelace/.papercusp",
        );
        // mixed separators + spaces together
        t(
            r"C:\Users\Jane Doe/work\repo",
            "/mnt/c/Users/Jane Doe/work/repo",
        );
    }

    /// WI-4827: the Quick Panel "open in main app" hand-off must only ever point
    /// the main window at a SAME-ORIGIN app path — never an off-origin URL, a
    /// custom scheme, or a protocol-relative `//host` (which resolves to a
    /// different origin). sanitize_app_route is the one gate for both the live
    /// command arg and the cross-process pending-route file.
    #[test]
    fn sanitize_app_route_accepts_only_same_origin_paths() {
        use super::sanitize_app_route;
        // Accepted: ordinary app routes (with query / hash), trimmed.
        assert_eq!(
            sanitize_app_route("/settings/voice").as_deref(),
            Some("/settings/voice")
        );
        assert_eq!(
            sanitize_app_route("/adv?tab=harnesses").as_deref(),
            Some("/adv?tab=harnesses")
        );
        assert_eq!(
            sanitize_app_route("  /settings/user#a  ").as_deref(),
            Some("/settings/user#a")
        );
        // Rejected: not rooted, protocol-relative, absolute URLs, schemes, control chars.
        assert_eq!(sanitize_app_route("settings/voice"), None);
        assert_eq!(sanitize_app_route("//evil.example.com"), None);
        assert_eq!(sanitize_app_route("https://evil.example.com/x"), None);
        assert_eq!(sanitize_app_route("javascript:alert(1)"), None);
        assert_eq!(sanitize_app_route("/foo\nbar"), None);
        assert_eq!(sanitize_app_route(""), None);
    }

    /// The cross-process hand-off file (macOS/Windows two-bundle) round-trips a
    /// route and is one-shot: reading it clears it, and it is sanitized on the
    /// way out so a tampered file can't redirect the main window off-origin.
    #[test]
    fn pending_route_round_trip_is_one_shot_and_sanitized() {
        // WI-5321: HOME is a process-global env var — hold the cross-binary
        // lock for the whole set→act→restore span so this can't race another
        // HOME-mutating test (e.g. workspaces::tests::
        // ensure_initialized_mints_a_real_non_default_id_and_migrates_legacy_dir)
        // running concurrently on another thread.
        let _home_guard = crate::HOME_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Isolate HOME so the test writes to a temp dir, not the real ~/.papercusp.
        let tmp =
            std::env::temp_dir().join(format!("pc-pending-route-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let prev_home = std::env::var_os("HOME");
        unsafe {
            std::env::set_var("HOME", &tmp);
        }

        assert_eq!(
            super::take_pending_route(),
            None,
            "empty when nothing written"
        );
        super::write_pending_route("/settings/voice");
        assert_eq!(
            super::take_pending_route().as_deref(),
            Some("/settings/voice")
        );
        assert_eq!(
            super::take_pending_route(),
            None,
            "one-shot: cleared after read"
        );

        // A tampered off-origin route is rejected on read (still cleared).
        super::write_pending_route("https://evil.example.com");
        assert_eq!(super::take_pending_route(), None, "off-origin rejected");
        assert_eq!(super::take_pending_route(), None);

        unsafe {
            match prev_home {
                Some(h) => std::env::set_var("HOME", h),
                None => std::env::remove_var("HOME"),
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

#[cfg(test)]
mod serve_log_tests {
    // WI-1707: the packaged app has no console, so the sidecar's stdout/stderr
    // must land in a rotated <home>/.papercusp/logs/serve.log. This guards both
    // that the log is created AND that each spawn shifts the ring correctly
    // (live log → .1 → .2), so history survives a crash-respawn.
    #[cfg(target_os = "linux")]
    #[test]
    fn serve_log_creates_and_rotates() {
        use std::fs;
        let home = std::env::temp_dir().join(format!("pcusp-serve-log-{}", std::process::id()));
        let logs = home.join(".papercusp").join("logs");
        let _ = fs::remove_dir_all(&home);

        // First spawn: creates a fresh logs/serve.log.
        assert!(
            super::rotating_log_stdio(&home, "serve.log").is_some(),
            "log setup should succeed"
        );
        // (drop closes the returned Stdio file handles.)
        assert!(logs.join("serve.log").exists());
        // Tag the live log so we can prove rotation moves THIS file next time.
        fs::write(logs.join("serve.log"), b"gen-A").unwrap();

        // Second spawn: serve.log(gen-A) → serve.log.1, fresh serve.log.
        assert!(super::rotating_log_stdio(&home, "serve.log").is_some());
        assert!(logs.join("serve.log").exists());
        assert_eq!(fs::read(logs.join("serve.log.1")).unwrap(), b"gen-A");
        fs::write(logs.join("serve.log"), b"gen-B").unwrap();

        // Third spawn: .1(gen-A) → .2, serve.log(gen-B) → .1.
        assert!(super::rotating_log_stdio(&home, "serve.log").is_some());
        assert_eq!(fs::read(logs.join("serve.log.1")).unwrap(), b"gen-B");
        assert_eq!(fs::read(logs.join("serve.log.2")).unwrap(), b"gen-A");

        let _ = fs::remove_dir_all(&home);
    }

    // WI-1781: rotating_log_stdio is basename-keyed — a second logfile routed
    // through the SAME helper must rotate independently of serve.log (no
    // cross-contamination between distinct log basenames).
    #[cfg(target_os = "linux")]
    #[test]
    fn rotating_log_stdio_isolates_basenames() {
        use std::fs;
        let home = std::env::temp_dir().join(format!("pcusp-aux-log-{}", std::process::id()));
        let logs = home.join(".papercusp").join("logs");
        let _ = fs::remove_dir_all(&home);

        // serve.log gets one generation…
        assert!(super::rotating_log_stdio(&home, "serve.log").is_some());
        fs::write(logs.join("serve.log"), b"serve-A").unwrap();
        // …and a second logfile its own, created fresh alongside it.
        assert!(super::rotating_log_stdio(&home, "aux.log").is_some());
        assert!(logs.join("aux.log").exists());
        fs::write(logs.join("aux.log"), b"aux-A").unwrap();

        // Rotating aux.log must NOT touch serve.log's live file or ring.
        assert!(super::rotating_log_stdio(&home, "aux.log").is_some());
        assert_eq!(fs::read(logs.join("aux.log.1")).unwrap(), b"aux-A");
        assert!(
            !logs.join("serve.log.1").exists(),
            "serve.log ring untouched by aux.log rotation"
        );
        assert_eq!(fs::read(logs.join("serve.log")).unwrap(), b"serve-A");

        let _ = fs::remove_dir_all(&home);
    }

    // WI-1803: the app's OWN process (not just its child sidecars) has fd 1/2 at
    // /dev/null under a console-less packaged launch, so this binary's own boot/
    // navigation eprintln!s — the ones that pin down the WI-1802 blank page —
    // were lost. redirect_own_stdio dup2's a rotated on-disk log over stdout AND
    // stderr. Prove the redirect actually routes BOTH raw fds to gui.log (we
    // write to the raw fds, not println!, because libtest intercepts
    // println!/eprintln! via a thread-local sink BEFORE they reach fd 1/2), then
    // RESTORE the harness's real stdio so its own output isn't clobbered.
    #[cfg(target_os = "linux")]
    #[test]
    fn redirect_own_stdio_captures_process_fds() {
        use std::fs;
        let home = std::env::temp_dir().join(format!("pcusp-gui-log-{}", std::process::id()));
        let logs = home.join(".papercusp").join("logs");
        let _ = fs::remove_dir_all(&home);

        // Save the real stdout/stderr so we can put them back after the swap.
        let saved_out = unsafe { libc::dup(libc::STDOUT_FILENO) };
        let saved_err = unsafe { libc::dup(libc::STDERR_FILENO) };
        assert!(saved_out >= 0 && saved_err >= 0, "dup of real stdio failed");

        super::redirect_own_stdio(&home, "gui.log");
        let out_msg = b"[[MARK-STDOUT-1803]]\n";
        let err_msg = b"[[MARK-STDERR-1803]]\n";
        unsafe {
            libc::write(
                libc::STDOUT_FILENO,
                out_msg.as_ptr() as *const libc::c_void,
                out_msg.len(),
            );
            libc::write(
                libc::STDERR_FILENO,
                err_msg.as_ptr() as *const libc::c_void,
                err_msg.len(),
            );
            // Restore the harness's real stdio and drop the saved copies.
            libc::dup2(saved_out, libc::STDOUT_FILENO);
            libc::dup2(saved_err, libc::STDERR_FILENO);
            libc::close(saved_out);
            libc::close(saved_err);
        }

        let contents = fs::read_to_string(logs.join("gui.log")).unwrap();
        assert!(
            contents.contains("[[MARK-STDOUT-1803]]"),
            "stdout not redirected to gui.log: {contents:?}"
        );
        assert!(
            contents.contains("[[MARK-STDERR-1803]]"),
            "stderr not redirected to gui.log: {contents:?}"
        );

        let _ = fs::remove_dir_all(&home);
    }
}

// WI-1802: the packaged macOS webview dials the operator over PLAINTEXT http on
// the 127.0.0.1 loopback LITERAL (serve binds 127.0.0.1 only; finish_boot forces
// the literal over `localhost` because WebKitGTK may resolve `localhost` to ::1).
// macOS ATS blocks plaintext http by default, and a `localhost`-HOSTNAME
// exception does NOT cover the 127.0.0.1 IP literal — so ATS silently blocked
// every operator request and the GUI rendered a blank white page on packaged Mac
// builds (Linux/webkit2gtk has no ATS, so it only bit the Mac app). The fix is
// the loopback ATS exception `NSAllowsLocalNetworking` in Info.plist. Guard it so
// the key can't be dropped back out (re-blanking the Mac app) without failing CI.
#[cfg(test)]
mod macos_ats_tests {
    const INFO_PLIST: &str = include_str!("../Info.plist");

    #[test]
    fn info_plist_grants_loopback_ats_exception() {
        assert!(
            INFO_PLIST.contains("NSAppTransportSecurity"),
            "Info.plist must declare an ATS policy dict"
        );
        assert!(
            INFO_PLIST.contains("NSAllowsLocalNetworking"),
            "Info.plist must set NSAllowsLocalNetworking so macOS ATS permits the \
             http://127.0.0.1:<port> operator loopback the webview dials — without \
             it the packaged Mac GUI blanks (WI-1802)"
        );
    }
}

// P-302 (EI-20584279536840151): macOS 15+ gates LOCAL-SUBNET traffic behind the
// TCC "Local Network" permission, which an app only gets if it declares
// NSLocalNetworkUsageDescription. Papercusp's whole p2p federation dials peers on
// the local subnet, so without the key the OS drops every datagram with
// EHOSTUNREACH — and because dht-rpc sends via udx's fire-and-forget `trySend`,
// nothing above the socket ever learns. Measured on the two-machine rig: the app's
// DHT was correctly bootstrapped and retrying (918 requests / 917 timeouts / 0
// responses) while a standalone process on the SAME host reached the same peer
// fine, and the app could still reach loopback, itself, and the public internet.
//
// The trap this guards is specifically the LOOK-ALIKE key: Info.plist already had
// `NSAllowsLocalNetworking`, an App Transport Security (HTTP/TLS) setting with no
// bearing on TCC. Asserting BOTH keys here is deliberate — it is what stops a
// future editor from "deduplicating" the two as one concern.
#[cfg(test)]
mod macos_local_network_tests {
    const INFO_PLIST: &str = include_str!("../Info.plist");

    #[test]
    fn info_plist_declares_local_network_usage() {
        assert!(
            INFO_PLIST.contains("NSLocalNetworkUsageDescription"),
            "Info.plist must declare NSLocalNetworkUsageDescription or macOS 15+ \
             denies ALL local-subnet traffic to the app (EHOSTUNREACH on every \
             send), silently breaking p2p federation while loopback and public \
             internet keep working (P-302)"
        );
        // The ATS key is NOT a substitute — both must be present, for different reasons.
        assert!(
            INFO_PLIST.contains("NSAllowsLocalNetworking"),
            "NSAllowsLocalNetworking (ATS) must remain alongside \
             NSLocalNetworkUsageDescription (TCC) — they are different mechanisms"
        );
        // A non-empty purpose string is required; macOS shows it in the permission
        // prompt, and an empty one gets the app rejected at review.
        let idx = INFO_PLIST
            .find("NSLocalNetworkUsageDescription")
            .expect("key presence asserted above");
        let after = &INFO_PLIST[idx..];
        let open = after
            .find("<string>")
            .expect("usage description needs a <string> value");
        let close = after
            .find("</string>")
            .expect("usage description <string> must be closed");
        assert!(
            close > open + "<string>".len(),
            "NSLocalNetworkUsageDescription must have a non-empty purpose string"
        );
    }
}

#[cfg(test)]
mod discovery_tests {
    use std::time::Duration;

    use super::{
        launcher_status_result, next_operator_port, operator_boot_timeout,
        parse_operator_discovery, resolve_route_upgrade, self_heal_probe_due, OperatorDiscovery,
        SELF_HEAL_WSL_PROBE_MIN_INTERVAL,
    };

    #[test]
    fn wsl_cold_boot_budget_covers_database_recovery() {
        assert_eq!(operator_boot_timeout(true), Duration::from_secs(600));
        assert_eq!(operator_boot_timeout(false), Duration::from_secs(120));
    }

    /// WI-37798: `upstream_base`'s self-heal is reached PER `/api` request while
    /// the port is unlatched, and on Windows each probe is a `wsl.exe` spawn.
    /// Unthrottled that is the spawn storm `distro_exec_wedged` documents as able
    /// to wedge the WSL2 interop layer — i.e. the "fix" would be worse than the
    /// 503 it repairs. These assertions pin the throttle that prevents it.
    #[test]
    fn self_heal_probe_is_throttled_between_wsl_spawns() {
        let t0 = std::time::Instant::now();
        let min = SELF_HEAL_WSL_PROBE_MIN_INTERVAL;

        // First probe of the process: nothing recorded yet, so it must run —
        // otherwise the self-heal could never fire at all.
        assert!(
            self_heal_probe_due(None, t0, min),
            "the first probe must always be allowed"
        );

        // A second request arriving immediately after must NOT spawn again.
        assert!(
            !self_heal_probe_due(Some(t0), t0, min),
            "a back-to-back request must be throttled"
        );
        assert!(
            !self_heal_probe_due(Some(t0), t0 + min - Duration::from_millis(1), min),
            "still throttled one millisecond before the interval elapses"
        );

        // Once the interval has elapsed, probing resumes — the operator may have
        // come up since, so this must not latch permanently closed.
        assert!(
            self_heal_probe_due(Some(t0), t0 + min, min),
            "probing must resume exactly at the interval boundary"
        );
        assert!(
            self_heal_probe_due(Some(t0), t0 + min * 3, min),
            "probing must resume well after the interval"
        );
    }

    /// A clock that appears to move BACKWARDS must not wedge the throttle shut
    /// forever. `Instant` is monotonic per-process, but `duration_since` panics
    /// on an earlier instant, so the implementation uses `saturating_*`; this
    /// pins that choice rather than leaving it to a future refactor.
    #[test]
    fn self_heal_probe_survives_a_non_monotonic_reading() {
        let t0 = std::time::Instant::now();
        let future = t0 + Duration::from_secs(60);
        // `last` in the future relative to `now` → saturates to zero elapsed →
        // throttled, but must NOT panic.
        assert!(!self_heal_probe_due(
            Some(future),
            t0,
            SELF_HEAL_WSL_PROBE_MIN_INTERVAL
        ));
    }

    /// The WI-37798 guard's predicate, split out from the file read so it can be
    /// proven FALSIFIABLE against a synthetic body. Proving it the obvious way —
    /// editing main.rs to break it and watching the test go red — is unsafe in
    /// this repo: git-sync sweeps the whole tree on a schedule and would commit
    /// the deliberately-broken intermediate. So the mutant is a string here, and
    /// the shared tree is never dirtied.
    fn assert_windows_discovery_recovery(body: &str) {
        assert!(
            body.contains("target_os = \"windows\""),
            "WI-37798 REGRESSION: operator_discovery_port_from_home() no longer has a \
             Windows-specific branch, so on Windows it can only read $HOME — which Windows \
             does not set. upstream_base() would then have NO recovery in a release build \
             and every /api call would 503 forever after a missed port latch."
        );
        assert!(
            body.contains("read_operator_discovery_via_wsl"),
            "WI-37798 REGRESSION: the Windows branch of operator_discovery_port_from_home() \
             no longer consults the WSL distro. The sidecar writes its discovery file INSIDE \
             the distro (/home/papercup/.papercusp), so a $HOME-only read on Windows always \
             returns None and the self-heal silently stops healing."
        );
    }

    /// WI-37798 CLASS guard — the regression this whole fix exists to prevent,
    /// and the one no other test can see.
    ///
    /// On a PACKAGED WINDOWS build, `upstream_base()`'s only recovery from a
    /// missed port latch is `operator_discovery_port_from_home()`: the
    /// `cfg!(debug_assertions)` :3070 branch below it is compiled OUT of release.
    /// If that function ever goes back to reading `$HOME` ALONE, the recovery
    /// becomes a GUARANTEED no-op on Windows — Windows sets no HOME, and the
    /// sidecar runs inside the WSL distro writing to /home/papercup/.papercusp —
    /// so every /api request 503s for the life of the process, with no way back.
    /// That is the original defect verbatim.
    ///
    /// What makes it worth a guard rather than care: the regression is INVISIBLE
    /// everywhere it would normally be caught. Linux and macOS have a real HOME,
    /// and every dev build still answers via the debug-only :3070 branch, so it
    /// reappears only in a release Windows bundle — the one artifact no unit test
    /// runs in. A source-shape assertion is crude, but it fails on ANY host, and
    /// that is the property that matters here.
    #[test]
    fn windows_discovery_recovery_is_not_home_only() {
        let src = include_str!("main.rs");
        // ASSEMBLED at runtime, never written as one literal: a guard that scans
        // its own file will otherwise match the needle inside THIS test and slice
        // the wrong "body". That is not hypothetical — it is what this test did on
        // its first run, and it failed pointing at the real function, which is the
        // most misleading way a source-shape guard can be wrong.
        let needle = format!(
            "pub(crate) fn {}() -> Option<u16> {{",
            "operator_discovery_port_from_home"
        );
        let start = src.find(&needle).expect(
            "operator_discovery_port_from_home() must exist — it is upstream_base()'s \
                 ONLY recovery path in a release build (WI-37798)",
        );
        let body = &src[start..];
        let end = body
            .find("\n}\n")
            .expect("operator_discovery_port_from_home() must be brace-terminated");
        assert_windows_discovery_recovery(&body[..end]);
    }

    /// A guard that has never failed is a guard nobody has tested. This feeds the
    /// predicate the exact body the fix REPLACED — the pre-WI-37798 `$HOME`-only
    /// read — and asserts it is rejected. Without this, a typo'd `contains(...)`
    /// needle would make the guard above pass unconditionally and silently police
    /// nothing.
    #[test]
    fn the_windows_discovery_guard_rejects_a_home_only_body() {
        // Body only — deliberately WITHOUT the signature line, so this fixture can
        // never be the thing the scanning test above finds and measures.
        let pre_fix_body = "    let home = std::env::var_os(\"HOME\")?;\n\
                            read_operator_discovery(std::path::Path::new(&home)).map(|d| d.port)";
        let verdict = std::panic::catch_unwind(|| assert_windows_discovery_recovery(pre_fix_body));
        assert!(
            verdict.is_err(),
            "the WI-37798 guard accepted the very body the fix replaced — it is not \
             actually checking anything"
        );
    }

    /// An already-resolved route must not cost a `wsl.exe` spawn at all — this
    /// runs on the GUI's boot path on EVERY launch, and the warm case (distro
    /// already Ready at startup) is the overwhelmingly common one.
    #[test]
    fn route_upgrade_short_circuits_when_already_routed() {
        let probes = std::cell::Cell::new(0u32);
        let upgraded = resolve_route_upgrade(
            true,
            Duration::from_secs(600),
            Duration::from_secs(10),
            || {
                probes.set(probes.get() + 1);
                true
            },
            |_| panic!("an already-WSL route must not sleep on the boot path"),
            || Duration::ZERO,
        );
        assert!(upgraded);
        assert_eq!(
            probes.get(),
            0,
            "the warm path must not spawn a WSL probe it does not need"
        );
    }

    /// The cold first-run case this fix exists for: WSL is NOT Ready when the
    /// GUI starts, the Server installs the distro, and the route must upgrade
    /// when that lands — having WAITED between probes rather than spun (each
    /// probe is a `wsl.exe` spawn; an unthrottled loop is the pressure that
    /// wedges the WSL2 interop layer).
    #[test]
    fn route_upgrade_waits_then_upgrades_when_wsl_becomes_ready() {
        let clock = std::cell::Cell::new(Duration::ZERO);
        let probes = std::cell::Cell::new(0u32);
        let upgraded = resolve_route_upgrade(
            false,
            Duration::from_secs(600),
            Duration::from_secs(10),
            || {
                probes.set(probes.get() + 1);
                probes.get() >= 3
            },
            |d| clock.set(clock.get() + d),
            || clock.get(),
        );
        assert!(upgraded, "the route must upgrade once WSL reports Ready");
        assert_eq!(probes.get(), 3);
        assert_eq!(
            clock.get(),
            Duration::from_secs(20),
            "must sleep the poll interval BETWEEN probes, not spin on wsl.exe"
        );
    }

    /// A genuinely WSL-less Windows box must fall back, not hang the GUI boot
    /// forever. The bound is what makes waiting here safe at all.
    #[test]
    fn route_upgrade_gives_up_at_the_budget() {
        let clock = std::cell::Cell::new(Duration::ZERO);
        let probes = std::cell::Cell::new(0u32);
        let upgraded = resolve_route_upgrade(
            false,
            Duration::from_secs(60),
            Duration::from_secs(10),
            || {
                probes.set(probes.get() + 1);
                false
            },
            |d| clock.set(clock.get() + d),
            || clock.get(),
        );
        assert!(
            !upgraded,
            "WSL never becoming Ready must report NO upgrade — asserting a route the machine \
             does not have would be worse than the status quo"
        );
        assert_eq!(probes.get(), 6, "exactly budget/poll probes, then stop");
        assert!(clock.get() >= Duration::from_secs(60));
    }

    /// The WI-37798 GUI-leg guard's predicate, split out from the file read so
    /// it can be proven FALSIFIABLE against a synthetic body — same reason as
    /// `assert_windows_discovery_recovery` above: proving it by editing main.rs
    /// and watching the test go red is unsafe here, because git-sync sweeps the
    /// whole tree on a schedule and would commit the broken intermediate.
    fn assert_gui_boot_reresolves_wsl_route(body: &str) {
        let upgrade = body.find("await_wsl_route_ready");
        assert!(
            upgrade.is_some(),
            "WI-37798 REGRESSION: gui_setup's boot thread no longer re-resolves the WSL route. \
             `via_wsl` there is a STARTUP snapshot and is FALSE on every cold first run (the \
             distro is not registered yet). Without the re-resolve, discovery reads the \
             Windows-side workspace_home path that the WSL sidecar never writes, on the 120s \
             non-WSL budget, and the window strands on \"Operator connection lost\" while the \
             operator answers HTTP 200 the whole time."
        );
        let boot = body.find("finish_boot(").expect(
            "gui_setup must still hand off to finish_boot — it is the GUI's whole boot wait",
        );
        assert!(
            upgrade.unwrap() < boot,
            "WI-37798 REGRESSION: gui_setup re-resolves the WSL route AFTER finish_boot, so \
             finish_boot still receives the stale startup value — it is finish_boot that owns \
             the discovery path, the boot budget, and the endpoint-IPC read."
        );
    }

    /// WI-37798 GUI-leg CLASS guard. The sibling of
    /// `windows_discovery_recovery_is_not_home_only`: that one pins the per-`/api`
    /// self-heal, this one pins the BOOT path that strands the window in the
    /// first place.
    ///
    /// Same reason a source-shape assertion earns its keep here: the regression
    /// is invisible everywhere it would normally be caught. `via_wsl` is
    /// hard-false on Linux and macOS by construction, and on a WARM Windows box
    /// the distro is already Ready at startup so the snapshot happens to be
    /// right — it reappears only on a COLD Windows install, the exact case a
    /// polluted VM base image hides (EI-20108513273736336). A source-shape guard
    /// is crude, but it fails on ANY host, and that is the property that matters.
    #[test]
    fn gui_boot_reresolves_the_wsl_route_before_discovery() {
        let src = include_str!("main.rs");
        // ASSEMBLED at runtime, never one literal — a guard that scans its own
        // file otherwise matches the needle inside THIS test and measures the
        // wrong body (the failure mode documented on the sibling guard above).
        let needle = format!("fn {}(app: &tauri::App)", "gui_setup");
        let start = src
            .find(&needle)
            .expect("gui_setup() must exist — it is the GUI role's whole boot path (WI-37798)");
        let body = &src[start..];
        let end = body
            .find("\n}\n")
            .expect("gui_setup() must be brace-terminated");
        assert_gui_boot_reresolves_wsl_route(&body[..end]);
    }

    fn assert_gui_ipc_registered_before_page_exposure(body: &str) {
        let registration = body
            .find("register_packaged_endpoint_ipc(")
            .expect("the GUI must register endpoint-IPC before exposing the app");
        for exposure in ["restore_window_visibility(", "window.navigate(", "std::thread::spawn("] {
            let position = body.find(exposure).expect("GUI boot exposure must exist");
            assert!(registration < position, "endpoint-IPC registration must precede {exposure}");
        }
    }

    #[test]
    fn gui_boot_registers_ipc_before_page_exposure() {
        let src = include_str!("main.rs");
        let needle = format!("fn {}(app: &tauri::App)", "gui_setup");
        let body = &src[src.find(&needle).expect("GUI setup must exist")..];
        let end = body.find("\n}\n").expect("GUI setup must be brace-terminated");
        assert_gui_ipc_registered_before_page_exposure(&body[..end]);
    }

    #[test]
    fn gui_ipc_registration_guard_rejects_missing_and_late_registration() {
        let exposure = "restore_window_visibility(); window.navigate(); std::thread::spawn();";
        for body in [exposure.to_string(), format!("{exposure} register_packaged_endpoint_ipc();")] {
            assert!(std::panic::catch_unwind(|| assert_gui_ipc_registered_before_page_exposure(&body)).is_err());
        }
        assert_gui_ipc_registered_before_page_exposure(&format!("register_packaged_endpoint_ipc(); {exposure}"));
    }

    /// D-001/P-001 recurrence guard: every packaged GUI, including Linux, is
    /// an attach-only shell. The GUI startup helper may launch the sibling
    /// Server product, but no GUI-only Linux function may spawn serve.mjs.
    #[test]
    fn gui_startup_launches_the_sibling_server_and_has_no_self_host_path() {
        let src = include_str!("main.rs");
        let start_needle = format!("fn {}(", "ensure_server_running");
        let start = src
            .find(&start_needle)
            .expect("ensure_server_running() must remain the GUI's sibling-launch seam");
        let end_needle = format!("/// {}", "Cross-platform \"launch the sibling app bundle");
        let end = src[start..]
            .find(&end_needle)
            .expect("launch_bundle documentation must follow the GUI startup helper");
        let body = &src[start..start + end];

        assert!(
            body.contains("launch_bundle(SERVER_BUNDLE_ID, \"Papercusp Server\")"),
            "GUI startup must launch the separately-installed Server bundle on every platform"
        );
        let removed_self_host = ["spawn", "self", "hosted", "sidecar"].join("_");
        assert!(
            !src.contains(&removed_self_host),
            "a GUI-side serve.mjs spawn seam reappeared: {removed_self_host}"
        );

        // Assemble the needle so include_str!("main.rs") cannot match this
        // assertion's own source before it reaches the production function.
        let launch_needle = format!("fn {}(", "launch_bundle");
        let launch_start = src
            .find(&launch_needle)
            .expect("launch_bundle() must remain the cross-platform sibling-launch seam");
        let linux_start = src[launch_start..]
            .find("#[cfg(target_os = \"linux\")]")
            .map(|offset| launch_start + offset)
            .expect("launch_bundle() must retain a Linux implementation");
        let windows_start = src[linux_start..]
            .find("#[cfg(target_os = \"windows\")]")
            .map(|offset| linux_start + offset)
            .expect("the Windows launch branch must follow Linux");
        let linux = &src[linux_start..windows_start];
        assert!(
            linux.contains(".status()"),
            "Linux must observe gtk-launch's exit status; spawn() only proves the launcher binary exists"
        );
        assert!(
            linux.contains("launcher_status_result(") && linux.contains("status.success()"),
            "a non-zero gtk-launch exit must reach the explicit install-Server UI"
        );
        assert!(
            linux.contains("format!(\"{product_name}.desktop\")"),
            "Linux must launch the desktop filename Tauri derives from productName"
        );
        assert!(
            !linux.contains("format!(\"{bundle_id}.desktop\")"),
            "the reverse-domain bundle identifier is not Tauri's installed desktop filename"
        );

        // Windows resolves each NSIS bundle from its product-specific install
        // directory. Keep this source-shape guard beside the Linux guard so a
        // future cleanup cannot regress sibling launching back to the old
        // "not wired" state without a focused test failure.
        let windows_end = src[windows_start..]
            .find("\n    }\n}\n")
            .map(|offset| windows_start + offset);
        let windows = &src[windows_start
            ..windows_end.expect(
                "the Windows launch branch must have a closed body before launch_bundle ends",
            )];
        for needle in [
            "LOCALAPPDATA",
            "product_name",
            "papercusp-desktop.exe",
            "CREATE_BREAKAWAY_FROM_JOB",
            "CREATE_NEW_PROCESS_GROUP",
            "DETACHED_PROCESS",
            ".creation_flags(",
            ".spawn()",
        ] {
            assert!(
                windows.contains(needle),
                "Windows sibling launch must retain {needle:?}"
            );
        }
    }

    #[test]
    fn sibling_launcher_status_rejects_a_missing_product() {
        assert!(launcher_status_result(true, "Papercusp Server", "gtk-launch ok").is_ok());

        let error = launcher_status_result(
            false,
            "Papercusp Server",
            "gtk-launch Papercusp Server.desktop exited with status 2",
        )
        .expect_err("a failed sibling launcher must not be reported as success");
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        assert!(error.to_string().contains("Papercusp Server"));
        assert!(error.to_string().contains("not installed"));
    }

    /// A guard that has never failed is a guard nobody has tested. This feeds
    /// the predicate the exact shape the fix REPLACED — the startup snapshot
    /// passed straight into `finish_boot` — and asserts it is rejected.
    #[test]
    fn the_gui_boot_guard_rejects_a_stale_route_body() {
        // Body only, deliberately without the signature line, so this fixture
        // can never be what the scanning test above finds and measures.
        let pre_fix_body = "    let via_wsl = should_route_via_wsl(&app.handle());\n\
                            ensure_server_running(&app_handle, &workspace_home, via_wsl);\n\
                            finish_boot(app_handle, workspace_home, via_wsl);";
        let verdict =
            std::panic::catch_unwind(|| assert_gui_boot_reresolves_wsl_route(pre_fix_body));
        assert!(
            verdict.is_err(),
            "the WI-37798 GUI-leg guard accepted the very body the fix replaced — it is not \
             actually checking anything"
        );
    }

    /// The ORDER half of the guard has to be falsifiable too, independently: a
    /// body that calls the re-resolve but only AFTER finish_boot still ships the
    /// stale value into the one consumer that matters, and `contains()` alone
    /// would wave it through.
    #[test]
    fn the_gui_boot_guard_rejects_a_too_late_reresolve() {
        let too_late = "    finish_boot(app_handle, workspace_home, via_wsl);\n\
                        let via_wsl = await_wsl_route_ready(&app_handle, via_wsl);";
        let verdict = std::panic::catch_unwind(|| assert_gui_boot_reresolves_wsl_route(too_late));
        assert!(
            verdict.is_err(),
            "the WI-37798 GUI-leg guard accepted a re-resolve that happens after finish_boot"
        );
    }

    #[test]
    fn parses_valid_payload() {
        let d = parse_operator_discovery(
            r#"{"port":3070,"pid":1234,"processIdentity":"linux:boot-1:99"}"#,
        )
        .unwrap();
        assert_eq!(d.port, 3070);
        assert_eq!(d.pid, 1234);
        assert_eq!(d.process_identity.as_deref(), Some("linux:boot-1:99"));
    }

    #[test]
    fn tolerates_extra_fields() {
        let d = parse_operator_discovery(r#"{"port":1,"pid":2,"startedAt":"2026-06-10"}"#).unwrap();
        // Legacy records remain readable for healthy reuse, but destructive
        // cleanup later refuses them because they have no birth identity.
        assert!(d.process_identity.is_none());
    }

    #[test]
    fn rejects_zero_port_or_pid() {
        // A half-written discovery file must read as "not ready", never as
        // a connect target.
        assert!(parse_operator_discovery(r#"{"port":0,"pid":12}"#).is_none());
        assert!(parse_operator_discovery(r#"{"port":3070,"pid":0}"#).is_none());
    }

    #[test]
    fn rejects_garbage_and_missing_fields() {
        assert!(parse_operator_discovery("not json").is_none());
        assert!(parse_operator_discovery("{}").is_none());
        assert!(parse_operator_discovery(r#"{"port":3070}"#).is_none());
        assert!(parse_operator_discovery(r#"{"pid":3070}"#).is_none());
    }

    // WI-3282 fix direction 1: cmdline verification guards a recycled pid in a
    // stale operator.json from false-positively reading as "our live operator".
    use super::{
        cmdline_is_protected_session_process, cmdline_looks_like_operator,
        linux_process_identity_from_stat,
    };

    #[test]
    fn cmdline_check_matches_serve_mjs_and_ts() {
        assert!(cmdline_looks_like_operator(
            "node /opt/papercusp/sidecar/serve.mjs --ensure"
        ));
        assert!(cmdline_looks_like_operator(
            "/usr/bin/tsx apps/operator/bin/serve.ts --ensure"
        ));
        // /proc/<pid>/cmdline is NUL-joined; callers replace NUL with a space
        // before calling this, so a space-joined argv must still match.
        assert!(cmdline_looks_like_operator("node serve.mjs --ensure"));
    }

    #[test]
    fn cmdline_check_rejects_a_recycled_pid_owned_by_something_else() {
        // The exact class this guards: the OS reassigns a stale operator.json's
        // pid to an unrelated process (a shell, `cat`, another app) — bare
        // pid-aliveness would wrongly call this "our operator".
        assert!(!cmdline_looks_like_operator("/bin/bash -c sleep 100"));
        assert!(!cmdline_looks_like_operator(
            "cat /home/user/.papercusp/operator.json"
        ));
        assert!(!cmdline_looks_like_operator(""));
    }

    #[test]
    fn cmdline_check_is_case_insensitive() {
        assert!(cmdline_looks_like_operator("NODE SERVE.MJS --ensure"));
    }

    /// REGRESSION GUARD (WI-6512). These are VERBATIM `/proc/<pid>/cmdline`
    /// strings captured from live operators on the dev box 2026-07-28, NUL
    /// replaced by space exactly as `discovery_pid_alive` does before calling.
    ///
    /// They are here because the matcher previously accepted only
    /// `serve.mjs`/`serve.ts` — the SUPERVISOR — while the process that
    /// actually writes the endpoint-ipc advertisement and owns the socket is
    /// the HOST, `hono-host`. Every one of these returned false, so
    /// `discovery_pid_alive` declared every live operator dead and `/api`
    /// could never dial IPC. Nothing failed loudly; the app just felt slow.
    ///
    /// If you rename or re-wrap the operator entrypoint, THIS test is what
    /// tells you — instead of a silent transport outage discovered months
    /// later. Add the new cmdline here and to `cmdline_looks_like_operator`.
    #[test]
    fn cmdline_check_accepts_the_real_operator_entrypoints() {
        // Release / staging: the built host, run directly by node.
        assert!(cmdline_looks_like_operator(
            "/home/u/.linuxbrew/Cellar/node/25.9.0_1/bin/node \
             /home/u/papercupai-workspace/papercup-release/apps/operator/dist-host/hono-host.mjs "
        ));
        assert!(cmdline_looks_like_operator("node dist-host/hono-host.mjs "));
        // Dev: the TypeScript host behind the tsx loader. Note the entrypoint
        // is the LAST argv entry, preceded by loader flags — a matcher that
        // anchored on argv[1] would miss it.
        assert!(cmdline_looks_like_operator(
            "/home/u/.linuxbrew/Cellar/node/25.9.0_1/bin/node \
             --require /home/u/papercupai-workspace/papercusp/node_modules/tsx/dist/preflight.cjs \
             --import file:///home/u/papercupai-workspace/papercusp/node_modules/tsx/dist/loader.mjs \
             bin/hono-host.ts "
        ));
    }

    /// The recycled-pid guard must still bite: widening the matcher to cover
    /// the host must not turn it into "anything with node in it".
    #[test]
    fn cmdline_check_still_rejects_an_unrelated_node_process() {
        assert!(!cmdline_looks_like_operator(
            "node /home/u/some-other-app/index.mjs"
        ));
        assert!(!cmdline_looks_like_operator(
            "node dist-host/other-host.mjs"
        ));
    }

    #[test]
    fn linux_identity_uses_boot_id_and_starttime_field_22() {
        let stat =
            "42 (odd process) name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20";
        assert_eq!(
            linux_process_identity_from_stat("boot-abc\n", stat).as_deref(),
            Some("linux:boot-abc:987654")
        );
    }

    #[test]
    fn protected_session_processes_are_never_kill_targets() {
        for cmdline in [
            "/usr/lib/systemd/systemd --user",
            "/usr/bin/gnome-shell",
            "/usr/sbin/gdm-session-worker",
            "/System/Library/CoreServices/loginwindow.app/loginwindow",
            "/sbin/launchd",
        ] {
            assert!(cmdline_is_protected_session_process(cmdline), "{cmdline}");
        }
        assert!(!cmdline_is_protected_session_process(
            "node /opt/papercusp/serve.mjs --ensure"
        ));
    }

    // WI-1869: the operator watcher's re-navigate decision. These run on Linux
    // CI, where the macOS/Windows dynamic-port restart path they guard can never
    // be exercised — the exact blind spot that let strand-on-restart ship.
    #[test]
    fn watcher_follows_a_port_change() {
        // Server restart moved the operator :21385 -> :21927 (the live repro).
        let latest = OperatorDiscovery {
            port: 21927,
            pid: 50461,
            process_identity: None,
        };
        assert_eq!(next_operator_port(21385, Some(&latest)), Some(21927));
    }

    #[test]
    fn watcher_ignores_same_port() {
        // A same-port bounce (dev box: fixed :3070) is NOT a move — don't churn.
        let latest = OperatorDiscovery {
            port: 3070,
            pid: 999,
            process_identity: None,
        };
        assert_eq!(next_operator_port(3070, Some(&latest)), None);
    }

    #[test]
    fn watcher_holds_when_discovery_absent() {
        // operator.json gone / half-written (parse -> None): stay put, don't
        // navigate to nowhere; wait for the next tick to see a valid operator.
        assert_eq!(next_operator_port(3070, None), None);
    }

    // WI-2667: the watcher's Server-respawn decision. Same Linux-CI blind-spot
    // rationale as the port-follow tests above — the macOS respawn path that
    // recovers a dead packaged Server can't run here, so guard the pure decision.
    use super::{decide_server_supervision, ServerSupervisionAction as A};

    // A live Server just resets the dead counter.
    // (Args: process_alive, launchdaemon_installed, server_shell_alive,
    // in_boot_grace, dead_count, dead_threshold, respawns_in_window,
    // max_respawns, already_gave_up.)
    #[test]
    fn supervision_healthy_when_process_alive() {
        assert_eq!(
            decide_server_supervision(true, false, false, false, 0, 10, 0, 5, false),
            A::Healthy
        );
        // …even if it was flapping a moment ago (dead_count carried in).
        assert_eq!(
            decide_server_supervision(true, false, false, false, 7, 10, 0, 5, false),
            A::Healthy
        );
    }

    // A dead Server inside its post-respawn boot grace must NOT be respawned
    // again (double-respawn during boot is the thing the grace prevents).
    #[test]
    fn supervision_waits_during_boot_grace() {
        assert_eq!(
            decide_server_supervision(false, false, false, true, 99, 10, 0, 5, false),
            A::Wait
        );
    }

    // Dead but not yet past the debounce → wait (a normal restart briefly looks
    // dead as the pid rolls over; don't respawn on a transient gap).
    #[test]
    fn supervision_waits_below_debounce_threshold() {
        assert_eq!(
            decide_server_supervision(false, false, false, false, 9, 10, 0, 5, false),
            A::Wait
        );
    }

    // Dead past the debounce, under the respawn cap → respawn. This is the core
    // WI-2667 recovery: SIGTERM force-exit left the Server gone, bring it back.
    #[test]
    fn supervision_respawns_when_dead_past_threshold() {
        assert_eq!(
            decide_server_supervision(false, false, false, false, 10, 10, 0, 5, false),
            A::Respawn
        );
        assert_eq!(
            decide_server_supervision(false, false, false, false, 10, 10, 4, 5, false),
            A::Respawn
        );
    }

    // Respawned too many times in the window → give up (a Server that truly
    // can't boot must not hot-loop `open -b` forever).
    #[test]
    fn supervision_gives_up_at_respawn_cap() {
        assert_eq!(
            decide_server_supervision(false, false, false, false, 10, 10, 5, 5, false),
            A::GiveUp
        );
    }

    // WI-3270 (b): give-up is a BACKOFF, not a terminal latch — the old
    // latch-until-app-restart is exactly what left the VM dead until a manual
    // Server restart.
    #[test]
    fn supervision_gives_up_then_recovers() {
        // While the respawn window is still saturated, a latched give-up holds
        // (and never re-notifies — GiveUp only fires on the transition).
        assert_eq!(
            decide_server_supervision(false, false, false, false, 999, 10, 5, 5, true),
            A::Wait
        );
        // Window drained → retry (the slow-retry tier; the caller clears the latch).
        assert_eq!(
            decide_server_supervision(false, false, false, false, 999, 10, 0, 5, true),
            A::Respawn
        );
        // The Server coming back while latched reads Healthy (caller clears latch).
        assert_eq!(
            decide_server_supervision(true, false, false, false, 0, 10, 0, 5, true),
            A::Healthy
        );
    }

    // WI-3270 (c): operator dead but the Server SHELL is alive (fresh
    // heartbeat) — launching the bundle is a guaranteed single-instance no-op,
    // so the watcher must defer and never burn a respawn-cap slot, no matter
    // how long the operator has been dead or how saturated the window is.
    #[test]
    fn supervision_defers_to_live_shell_instead_of_burning_the_cap() {
        assert_eq!(
            decide_server_supervision(false, false, true, false, 999, 10, 0, 5, false),
            A::DeferToShell
        );
        assert_eq!(
            decide_server_supervision(false, false, true, false, 999, 10, 5, 5, false),
            A::DeferToShell
        );
        // A latched give-up defers too (the shell may still recover it).
        assert_eq!(
            decide_server_supervision(false, false, true, false, 999, 10, 5, 5, true),
            A::DeferToShell
        );
        // A live operator process wins over the shell signal.
        assert_eq!(
            decide_server_supervision(true, false, true, false, 0, 10, 0, 5, false),
            A::Healthy
        );
    }

    #[test]
    fn supervision_defers_to_installed_launchdaemon_while_it_is_temporarily_unloaded() {
        assert_eq!(
            decide_server_supervision(false, true, false, false, 999, 10, 5, 5, true),
            A::DeferToLaunchDaemon
        );
        assert_eq!(
            decide_server_supervision(false, true, true, false, 999, 10, 0, 5, false),
            A::DeferToLaunchDaemon
        );
        assert_eq!(
            decide_server_supervision(true, true, false, false, 0, 10, 0, 5, false),
            A::Healthy
        );
    }

    // WI-3270 (c): the shell-heartbeat freshness rule + JSON round-trip guard
    // the defer-to-shell signal (the live write/read sides need two processes,
    // which Linux CI can't exercise — same blind-spot rationale as above).
    use super::{shell_heartbeat_fresh, ServerShellHeartbeat};

    #[test]
    fn shell_heartbeat_freshness_boundary() {
        let max = Duration::from_secs(10);
        assert!(shell_heartbeat_fresh(100, 100, max));
        assert!(shell_heartbeat_fresh(100, 110, max)); // exactly max age: fresh
        assert!(!shell_heartbeat_fresh(100, 111, max)); // past it: stale
        assert!(shell_heartbeat_fresh(110, 100, max)); // future ts (clock skew): fresh
    }

    #[test]
    fn shell_heartbeat_json_round_trip() {
        let hb = ServerShellHeartbeat {
            pid: 4242,
            ts: 1_720_000_000,
        };
        let body = serde_json::to_string(&hb).unwrap();
        let back: ServerShellHeartbeat = serde_json::from_str(&body).unwrap();
        assert_eq!(back.pid, 4242);
        assert_eq!(back.ts, 1_720_000_000);
    }

    // WI-2667 (defect-2 gap): the SERVER-side serve respawn decision. This is the
    // path the live Mac-VM E2E proved was missing — the operator died, the shell
    // lived, and nothing (GUI `open -b` no-ops on the live single instance) brought
    // it back. Same Linux-CI blind-spot rationale: the macOS respawn can't run here.
    use super::{decide_serve_respawn, serve_unreachable_respawn_ready, ServeRespawnAction as R};

    // Child still running, operator not yet up, debounce not armed (normal boot)
    // → nothing to do. (Args: child_exited, shutting_down, operator_reachable,
    // unreachable_respawn_ready, install_broken, respawns_in_window,
    // max_respawns.)
    #[test]
    fn serve_respawn_healthy_when_child_running() {
        assert_eq!(
            decide_serve_respawn(false, false, false, false, false, 0, 5),
            R::Healthy
        );
    }

    // Operator reachable is GROUND TRUTH → healthy no matter the Child state.
    // Covers the Decision-C case (child exited because `--ensure` reused a foreign
    // operator that is serving) → do NOT double-spawn.
    #[test]
    fn serve_respawn_healthy_when_operator_reachable_despite_exit() {
        assert_eq!(
            decide_serve_respawn(true, false, true, false, false, 0, 5),
            R::Healthy
        );
        // reachable wins even if the unreachable path were somehow armed.
        assert_eq!(
            decide_serve_respawn(true, false, true, true, false, 0, 5),
            R::Healthy
        );
    }

    // The core WI-2667 recovery: operator child exited, no operator reachable,
    // under the cap → respawn serve in-process (the case the Mac-VM E2E showed
    // dead). A fully-exited child respawns immediately, debounce or not.
    #[test]
    fn serve_respawn_when_child_exited_and_unreachable() {
        assert_eq!(
            decide_serve_respawn(true, false, false, false, false, 0, 5),
            R::Respawn
        );
        assert_eq!(
            decide_serve_respawn(true, false, false, false, false, 4, 5),
            R::Respawn
        );
    }

    // Shutting down / self-updating → never resurrect the child we killed on
    // purpose — and that wins even past the respawn cap and with the Windows
    // path armed.
    #[test]
    fn serve_respawn_suppressed_when_shutting_down() {
        assert_eq!(
            decide_serve_respawn(true, true, false, false, false, 0, 5),
            R::Suppressed
        );
        assert_eq!(
            decide_serve_respawn(true, true, false, false, false, 9, 5),
            R::Suppressed
        );
        assert_eq!(
            decide_serve_respawn(false, true, false, true, false, 0, 5),
            R::Suppressed
        );
    }

    // Respawned too many times in the window (crash-loop) → give up until restart.
    #[test]
    fn serve_respawn_gives_up_at_cap() {
        assert_eq!(
            decide_serve_respawn(true, false, false, false, false, 5, 5),
            R::GiveUp
        );
    }

    // WI-3170 (Windows/WSL child-liveness blind spot): the stored serve `Child` is
    // the wsl.exe WRAPPER, which OUTLIVES the dead WSL-internal node operator — so
    // `child_exited` stays false even though the operator is durably gone. Once the
    // operator has been UNREACHABLE past the debounce (unreachable_respawn_ready),
    // respawn REGARDLESS of child_exited. The OLD decider returned Healthy here, so
    // the dead operator was NEVER respawned (VM forensics: down ~11 min).
    #[test]
    fn serve_respawn_when_operator_unreachable_past_debounce_despite_live_wrapper_child() {
        // Wrapper Child alive (child_exited=false), operator unreachable past the
        // debounce, under the cap → respawn (the exact bug case).
        assert_eq!(
            decide_serve_respawn(false, false, false, true, false, 0, 5),
            R::Respawn
        );
        assert_eq!(
            decide_serve_respawn(false, false, false, true, false, 4, 5),
            R::Respawn
        );
        // The crash-loop cap still applies to this path.
        assert_eq!(
            decide_serve_respawn(false, false, false, true, false, 5, 5),
            R::GiveUp
        );
        // But BEFORE the debounce arms (normal boot: serve alive, operator still
        // coming up) we must NOT respawn — that would double-spawn a competing serve.
        assert_eq!(
            decide_serve_respawn(false, false, false, false, false, 0, 5),
            R::Healthy
        );
    }

    // WI-5390: a broken install must SHORT-CIRCUIT the respawn machinery. The
    // live bug: `<install>/sidecar/` was gone, every spawn died instantly on
    // chdir/MODULE_NOT_FOUND, the supervisor read that as an ordinary child exit,
    // and respawned it in a loop that was still running ~18h later — with nothing
    // user-visible ever naming the cause.
    #[test]
    fn serve_respawn_reports_install_broken_instead_of_respawning() {
        // Child exited + unreachable + install broken → InstallBroken, NOT Respawn.
        assert_eq!(
            decide_serve_respawn(true, false, false, false, true, 0, 5),
            R::InstallBroken
        );
        // The Windows/WSL blind-spot path (wrapper child alive, operator durably
        // unreachable) is the shape actually observed on the VM — same verdict.
        assert_eq!(
            decide_serve_respawn(false, false, false, true, true, 0, 5),
            R::InstallBroken
        );
        // And it does NOT degrade into GiveUp at the cap: GiveUp is a backoff that
        // RETRIES once the window drains, which is exactly the forever-loop this
        // fix removes.
        assert_eq!(
            decide_serve_respawn(true, false, false, false, true, 5, 5),
            R::InstallBroken
        );
    }

    // A broken install must not override the two verdicts that outrank it:
    // deliberate teardown, and a reachable (possibly foreign, `--ensure`-reused)
    // operator — reporting "reinstall me" while the app demonstrably works would
    // be a false alarm.
    #[test]
    fn serve_respawn_install_broken_never_outranks_shutdown_or_a_live_operator() {
        assert_eq!(
            decide_serve_respawn(true, true, false, false, true, 0, 5),
            R::Suppressed
        );
        assert_eq!(
            decide_serve_respawn(true, false, true, false, true, 0, 5),
            R::Healthy
        );
    }

    // The preflight itself: which entrypoints are reported missing. Uses a real
    // temp dir (no tempfile dep) because the whole point is a filesystem check.
    #[test]
    fn missing_sidecar_entrypoints_detects_the_half_removed_install() {
        let dir = std::env::temp_dir().join(format!(
            "papercusp-wi5390-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // The observed live state: the sidecar dir is absent entirely.
        let absent = dir.join("sidecar");
        assert_eq!(
            super::missing_sidecar_entrypoints(&absent),
            vec!["serve.mjs", "sidecar-preload.js"]
        );

        // A partially-populated dir reports only what is actually missing.
        std::fs::write(dir.join("serve.mjs"), "//").unwrap();
        assert_eq!(
            super::missing_sidecar_entrypoints(&dir),
            vec!["sidecar-preload.js"]
        );

        // Intact ⇒ empty, so the normal path is never diverted.
        std::fs::write(dir.join("sidecar-preload.js"), "//").unwrap();
        assert!(super::missing_sidecar_entrypoints(&dir).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The seam that actually mattered: `spawn_serve` must REFUSE, not spawn. The
    // live bug was that it happily launched a command that could never work, and
    // the resulting instant death was indistinguishable from a crash — which is
    // what fed the infinite respawn. Safe to call for real: the preflight returns
    // before any `Command` is built, so nothing is executed.
    #[test]
    fn spawn_serve_refuses_a_broken_install_before_launching_anything() {
        // The production latch is process-global because the updater and the
        // sidecar supervisor communicate through it. Keep this test's latch
        // local so a sibling test cannot clear it between spawn and read-back.
        let install_defect = super::InstallDefectLatch::new();
        let missing_dir = std::env::temp_dir().join(format!(
            "papercusp-wi5390-nonexistent-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&missing_dir);

        let err = super::spawn_serve(
            false,
            0,
            &missing_dir,
            None,
            0,
            &missing_dir,
            &missing_dir,
            &install_defect,
            false,
        )
        .expect_err("a sidecar dir with no serve.mjs must not spawn");

        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
        let text = err.to_string();
        assert!(
            text.contains("serve.mjs"),
            "error names the missing file: {text}"
        );
        assert!(
            text.to_lowercase().contains("reinstall"),
            "error is actionable: {text}"
        );

        // And it latched the defect for the updater to report.
        assert!(install_defect.current().is_some());
    }

    // The message a user actually sees must name the missing files AND where they
    // were expected, and must say what to DO — the diagnosis that took the fleet
    // two days should be one line on screen.
    #[test]
    fn install_defect_message_names_the_files_the_dir_and_the_remedy() {
        let msg = super::install_defect_message(
            std::path::Path::new("/opt/Papercusp Server/sidecar"),
            &["serve.mjs", "sidecar-preload.js"],
        );
        assert!(msg.contains("serve.mjs"));
        assert!(msg.contains("sidecar-preload.js"));
        assert!(msg.contains("/opt/Papercusp Server/sidecar"));
        assert!(msg.to_lowercase().contains("reinstall"));
    }

    // WI-5390: the updater must not render a PERMANENT fault as a transient one.
    // "try again after boot completes" is a lie when boot can never complete.
    #[test]
    fn sidecar_port_message_distinguishes_broken_install_from_still_booting() {
        let install_defect = super::InstallDefectLatch::new();
        let booting = super::sidecar_port_unavailable_message_for(&install_defect);
        assert!(booting.contains("try again after boot completes"));

        install_defect.set(Some("installation is incomplete".to_string()));
        let broken = super::sidecar_port_unavailable_message_for(&install_defect);
        assert!(broken.contains("installation is incomplete"));
        assert!(!broken.contains("try again after boot completes"));
    }

    #[test]
    fn serve_unreachable_respawn_ready_stays_disarmed_before_first_successful_boot() {
        let debounce = Duration::from_secs(15);
        assert!(!serve_unreachable_respawn_ready(
            true, false, None, debounce
        ));
        assert!(!serve_unreachable_respawn_ready(
            true,
            false,
            Some(Duration::from_secs(30)),
            debounce
        ));
    }

    #[test]
    fn serve_unreachable_respawn_ready_arms_only_after_continuous_debounce_on_wsl() {
        let debounce = Duration::from_secs(15);
        assert!(!serve_unreachable_respawn_ready(true, true, None, debounce));
        assert!(!serve_unreachable_respawn_ready(
            true,
            true,
            Some(Duration::from_secs(14)),
            debounce
        ));
        assert!(serve_unreachable_respawn_ready(
            true,
            true,
            Some(Duration::from_secs(15)),
            debounce
        ));
        assert!(serve_unreachable_respawn_ready(
            true,
            true,
            Some(Duration::from_secs(16)),
            debounce
        ));
    }

    #[test]
    fn serve_unreachable_respawn_ready_never_arms_off_wsl() {
        assert!(!serve_unreachable_respawn_ready(
            false,
            true,
            Some(Duration::from_secs(60)),
            Duration::from_secs(15)
        ));
    }

    // WI-1878 / P-005: the operator-dead notification body must name WHICH
    // supervisor gave up and the exact attempt/window numbers, so a user (or a
    // later triager reading a bug report) can tell the two give-up paths apart.
    #[test]
    fn operator_dead_notification_body_names_reason_and_counts() {
        let body =
            super::operator_dead_notification_body("serve.mjs in-process respawn cap hit", 5, 300);
        assert!(body.contains("serve.mjs in-process respawn cap hit"));
        assert!(body.contains('5'));
        assert!(body.contains("300"));
        // WI-3270: give-up now keeps retrying in the background — the user-facing
        // text must say so (the old "restart the app to recover" implied a wedge).
        assert!(body.contains("Retries continue"));
    }
}

// WI-2902: readiness must be HTTP-RESPONSIVE, not just TCP-connectable — a
// first-boot operator binds its port ~20s before its starved event loop can
// answer, and gating on TCP-accept re-pointed the webview at a server that then
// failed every SPA chunk fetch (the fatal "Importing a module script failed"
// card). These pin operator_http_ready's contract: a server that COMPLETES an
// HTTP round-trip reads ready; a refused/absent one does not.
#[cfg(test)]
mod http_ready_tests {
    use super::operator_http_ready;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn ready_when_operator_answers_http() {
        // A listener that completes ONE HTTP round-trip stands in for a
        // responsive operator whose event loop is serving requests.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
        let port = listener.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf); // drain the request; content irrelevant
                let _ = sock.write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\ncontent-type: application/json\r\n\r\nok",
                );
                let _ = sock.flush();
            }
        });
        assert!(
            operator_http_ready(port),
            "a server that answers an HTTP request must read as ready",
        );
        let _ = h.join();
    }

    #[test]
    fn not_ready_when_nothing_listens() {
        // A port with nothing listening → connection refused → NOT ready, fast
        // (never a hang): bind to reserve an ephemeral port, then drop it.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
            l.local_addr().unwrap().port()
        };
        assert!(
            !operator_http_ready(port),
            "a refused connection must read as NOT ready",
        );
    }
}

#[cfg(test)]
mod helper_tests {
    use super::{
        bundled_path_env, classify_advertisement, cmdline_looks_like_operator,
        endpoint_ipc_socket_path_supported_for_target, find_endpoint_ipc_socket,
        inspect_advertisement, is_tcp_endpoint, local_process_cmdline, read_dev_ipc_socket,
        read_dev_ipc_socket_for_port, resolve_dev_ipc_socket, resolve_wsl_endpoint_ipc_socket,
        url_encode, AdvertisementState,
    };

    /// Well above any realistic pid_max (and positive as i32) → ESRCH / no
    /// `/proc` entry → definitely dead. Same convention as
    /// `dev_bridge::pid_alive_false_for_an_unused_high_pid`.
    const DEFINITELY_DEAD_PID: u32 = 2_000_000_000;

    // ── url_encode (RFC 3986 component encoding) ────────────────────────────

    #[test]
    fn url_encode_passes_unreserved_through() {
        assert_eq!(url_encode("abcXYZ019.-_~"), "abcXYZ019.-_~");
        assert_eq!(url_encode(""), "");
    }

    #[test]
    fn url_encode_escapes_reserved_with_uppercase_hex() {
        assert_eq!(url_encode("a b"), "a%20b");
        assert_eq!(url_encode("ws/id?x=1&y=2"), "ws%2Fid%3Fx%3D1%26y%3D2");
        assert_eq!(url_encode("a:b#c"), "a%3Ab%23c");
        assert_eq!(url_encode("100%"), "100%25");
    }

    #[test]
    fn url_encode_encodes_utf8_per_byte() {
        // 'é' = 0xC3 0xA9 in UTF-8 — each byte percent-encoded.
        assert_eq!(url_encode("é"), "%C3%A9");
        assert_eq!(url_encode("日"), "%E6%97%A5");
    }

    // ── bundled PATH assembly ───────────────────────────────────────────────

    #[test]
    fn bundled_path_env_prepends_the_sidecar_bin_dir() {
        let dir = std::path::Path::new("/opt/papercusp/sidecar");
        let path = bundled_path_env(dir);
        let sep = if cfg!(windows) { ";" } else { ":" };
        let expected_prefix = format!("{}{}", dir.join("bin").to_string_lossy(), sep);
        assert!(
            path.starts_with(&expected_prefix),
            "PATH must start with the bundled bin dir: {path}"
        );
    }

    // ── endpoint-ipc discovery file parsing ─────────────────────────────────

    /// Fresh temp dir per test — same pattern as the endpoint_ipc
    /// synthetic-server test (no tempfile dev-dep in this crate).
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "papercusp-desktop-test-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_dev_ipc_socket_parses_socket_path() {
        let dir = temp_dir("ipc-sock");
        let file = dir.join("endpoint-ipc.json");
        std::fs::write(
            &file,
            r#"{"socketPath":"/tmp/papercusp/ipc.sock","pid":42}"#,
        )
        .unwrap();
        assert_eq!(
            read_dev_ipc_socket(&file),
            Some("/tmp/papercusp/ipc.sock".to_string())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn endpoint_ipc_socket_path_support_is_platform_aware() {
        assert!(endpoint_ipc_socket_path_supported_for_target(
            "/tmp/papercusp/ipc.sock",
            false
        ));
        assert!(!endpoint_ipc_socket_path_supported_for_target(
            "/tmp/papercusp/ipc.sock",
            true
        ));
        assert!(endpoint_ipc_socket_path_supported_for_target(
            "\\\\.\\pipe\\papercusp-12345",
            true
        ));
        assert!(!endpoint_ipc_socket_path_supported_for_target(
            "\\\\.\\pipe\\papercusp-12345",
            false
        ));
        assert!(!endpoint_ipc_socket_path_supported_for_target("", false));
    }

    #[test]
    fn endpoint_ipc_tcp_endpoint_accepted_on_windows_alongside_pipe() {
        // WI-3395: the WSL2 sidecar reports a `tcp://` loopback endpoint; the
        // Windows host guard must accept it (a Unix socket it can't reach).
        assert!(endpoint_ipc_socket_path_supported_for_target(
            "tcp://127.0.0.1:35745",
            true
        ));
        // A named pipe is still accepted on Windows (native-sidecar path).
        assert!(endpoint_ipc_socket_path_supported_for_target(
            "\\\\.\\pipe\\papercusp-1",
            true
        ));
        // A Unix socket is still rejected on Windows.
        assert!(!endpoint_ipc_socket_path_supported_for_target(
            "/tmp/x.sock",
            true
        ));
        // A `tcp://` endpoint is reachable on a non-Windows host too.
        assert!(endpoint_ipc_socket_path_supported_for_target(
            "tcp://127.0.0.1:35745",
            false
        ));
        // The classifier is strict, trimmed, case-sensitive, and validates
        // both the host and numeric port like the Node server parser.
        assert!(is_tcp_endpoint("tcp://127.0.0.1:0"));
        assert!(!is_tcp_endpoint("  TCP://127.0.0.1:0 "));
        assert!(!is_tcp_endpoint("tcp://127.0.0.1"));
        assert!(!is_tcp_endpoint("tcp://127.0.0.1:not-a-port"));
        assert!(!is_tcp_endpoint("tcp://127.0.0.1:1:2"));
        assert!(!is_tcp_endpoint("/tmp/x.sock"));
        assert!(!is_tcp_endpoint("\\\\.\\pipe\\papercusp-1"));
    }

    #[test]
    fn read_dev_ipc_socket_parses_tcp_endpoint() {
        let dir = temp_dir("ipc-tcp");
        let file = dir.join("endpoint-ipc.json");
        std::fs::write(&file, r#"{"socketPath":"tcp://127.0.0.1:35745","pid":42}"#).unwrap();
        assert_eq!(
            read_dev_ipc_socket(&file),
            Some("tcp://127.0.0.1:35745".to_string())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_endpoint_ipc_socket_reads_workspace_home_when_not_via_wsl() {
        if std::env::var_os("PAPERCUSP_DEFAULT_DISCOVERY_TEST_CHILD").is_none() {
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "helper_tests::find_endpoint_ipc_socket_reads_workspace_home_when_not_via_wsl", "--nocapture"])
                .env("PAPERCUSP_DEFAULT_DISCOVERY_TEST_CHILD", "1")
                .env_remove("PAPERCUSP_HOME")
                .output().unwrap();
            assert!(result.status.success(), "{}\n{}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
            return;
        }
        // WI-3395: the non-WSL path (mac/linux, and the Windows fallback) resolves
        // the socket from workspace_home/.papercusp/endpoint-ipc.json. The WSL
        // read is Windows-only + needs a live distro, so it isn't unit-covered
        // here; this guards the shared filesystem path + the join.
        let dir = temp_dir("ipc-find");
        std::fs::create_dir_all(dir.join(".papercusp")).unwrap();
        std::fs::write(
            dir.join(".papercusp/endpoint-ipc.json"),
            r#"{"socketPath":"tcp://127.0.0.1:40001","pid":7}"#,
        )
        .unwrap();
        assert_eq!(
            find_endpoint_ipc_socket(&dir, false),
            Some("tcp://127.0.0.1:40001".to_string())
        );
        // Missing file → None (client falls back to HTTP, no panic).
        let empty = temp_dir("ipc-find-empty");
        assert_eq!(find_endpoint_ipc_socket(&empty, false), None);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&empty);
    }

    #[test]
    fn native_discovery_respects_papercusp_home() {
        // Each environment case runs in a child of this Cargo test binary.
        // Never mutate the parent process environment while other tests run.
        if let Some(home) = std::env::var_os("PAPERCUSP_DISCOVERY_TEST_HOME") {
            let home = std::path::PathBuf::from(home);
            let expected_port: u16 = std::env::var("PAPERCUSP_DISCOVERY_TEST_PORT")
                .unwrap().parse().unwrap();
            let expected_socket = std::env::var("PAPERCUSP_DISCOVERY_TEST_SOCKET").unwrap();
            let expected_socket = if expected_socket.is_empty() { None } else { Some(expected_socket) };
            assert_eq!(
                super::read_operator_discovery(&home).map(|d| d.port),
                if expected_port == 0 { None } else { Some(expected_port) },
                "HTTP discovery must use the explicitly selected instance",
            );
            assert_eq!(find_endpoint_ipc_socket(&home, false), expected_socket);
            assert_eq!(
                super::find_endpoint_ipc_socket_resolved(&home, false).path,
                expected_socket.map(std::path::PathBuf::from),
                "validated IPC discovery must use the same instance as HTTP",
            );
            if std::env::var_os("PAPERCUSP_HOME").is_some_and(|v| !v.is_empty()) {
                assert_eq!(super::operator_discovery_port_from_home(),
                    if expected_port == 0 { None } else { Some(expected_port) },
                    "the recovery path must honor the same explicit instance");
            }
            return;
        }

        let home = temp_dir("native-discovery-override");
        let canonical = home.join(".papercusp");
        let isolated = home.join("isolated-state");
        let operator = FakeServeProcess::spawn();
        for (dir, port) in [(&canonical, 40001), (&isolated, 40002)] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("operator.json"), serde_json::json!({
                "port": port, "pid": operator.pid(),
            }).to_string()).unwrap();
            let socket = dir.join("endpoint.sock");
            std::fs::write(&socket, b"").unwrap();
            std::fs::write(dir.join("endpoint-ipc.json"), serde_json::json!({
                "socketPath": socket, "pid": operator.pid(),
            }).to_string()).unwrap();
        }
        let missing = home.join("missing-state");
        for (root, port, socket) in [
            (None, 40001, canonical.join("endpoint.sock")),
            (Some(std::path::Path::new("")), 40001, canonical.join("endpoint.sock")),
            (Some(isolated.as_path()), 40002, isolated.join("endpoint.sock")),
            (Some(missing.as_path()), 0, std::path::PathBuf::new()),
        ] {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", "helper_tests::native_discovery_respects_papercusp_home", "--nocapture"])
                .env("PAPERCUSP_DISCOVERY_TEST_HOME", &home)
                .env("PAPERCUSP_DISCOVERY_TEST_PORT", port.to_string())
                .env("PAPERCUSP_DISCOVERY_TEST_SOCKET", socket);
            if let Some(root) = root { command.env("PAPERCUSP_HOME", root); }
            else { command.env_remove("PAPERCUSP_HOME"); }
            let result = command.output().unwrap();
            assert!(result.status.success(), "discovery root {root:?}:\n{}\n{}",
                String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
        }
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn read_dev_ipc_socket_rejects_missing_or_malformed() {
        let dir = temp_dir("ipc-bad");
        // Missing file.
        assert_eq!(read_dev_ipc_socket(&dir.join("nope.json")), None);
        // Malformed JSON (half-written discovery file).
        let truncated = dir.join("truncated.json");
        std::fs::write(&truncated, r#"{"socketPath":"/tmp/x"#).unwrap();
        assert_eq!(read_dev_ipc_socket(&truncated), None);
        // Missing key.
        let nokey = dir.join("nokey.json");
        std::fs::write(&nokey, r#"{"pid":42}"#).unwrap();
        assert_eq!(read_dev_ipc_socket(&nokey), None);
        // Wrong type.
        let wrongtype = dir.join("wrongtype.json");
        std::fs::write(&wrongtype, r#"{"socketPath":42}"#).unwrap();
        assert_eq!(read_dev_ipc_socket(&wrongtype), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn per_port_discovery_prefers_the_port_file_then_falls_back() {
        let dir = temp_dir("ipc-port");
        std::fs::write(
            dir.join("endpoint-ipc.3170.json"),
            r#"{"socketPath":"/tmp/staging.sock"}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("endpoint-ipc.json"),
            r#"{"socketPath":"/tmp/legacy.sock"}"#,
        )
        .unwrap();
        // Port with its own file → the per-port socket (EI-190).
        assert_eq!(
            read_dev_ipc_socket_for_port(&dir, 3170),
            Some("/tmp/staging.sock".to_string())
        );
        // Port without one → the legacy singleton.
        assert_eq!(
            read_dev_ipc_socket_for_port(&dir, 3070),
            Some("/tmp/legacy.sock".to_string())
        );
        // EI-296: a CUSTOM port (escape-hatch target) must NOT inherit the
        // singleton — that would silently dial another operator's socket.
        assert_eq!(read_dev_ipc_socket_for_port(&dir, 3271), None);
        // …but a custom port WITH its own per-port file is honored.
        std::fs::write(
            dir.join("endpoint-ipc.3271.json"),
            r#"{"socketPath":"/tmp/iso.sock"}"#,
        )
        .unwrap();
        assert_eq!(
            read_dev_ipc_socket_for_port(&dir, 3271),
            Some("/tmp/iso.sock".to_string())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn per_port_discovery_returns_none_when_nothing_published() {
        let dir = temp_dir("ipc-empty");
        assert_eq!(read_dev_ipc_socket_for_port(&dir, 3070), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Test façade over `classify_advertisement`. The production code has no
    /// boolean form of this question — it always wants the REASON — so the
    /// predicate lives here rather than shipping an unused one.
    fn still_live(socket_path: &str, pid: u32, via_wsl: bool) -> bool {
        classify_advertisement(socket_path, pid, via_wsl)
            .live_socket()
            .is_some()
    }

    // ── advertisement classification / resolution (EI-18763945004822208) ────
    // Confirmed live: a restarted operator's discovery file briefly still
    // names the PREVIOUS (dead) pid/socket until the new instance rewrites
    // it, and dialing that window produced a measured 160/160 ENOENT
    // failure rate. These validate the fix closes exactly that window
    // without breaking the tcp:// / unknown-pid cases that must fail OPEN.

    /// `discovery_pid_alive` is STRENGTHENED with a cmdline check (WI-3282) —
    /// alive-but-not-`serve.mjs`/`serve.ts` reads as dead, same as this test
    /// process's own pid would. Spawn a short-lived child whose argv0 is
    /// rewritten to `serve.mjs` (bash `exec -a`) so "an alive advertised
    /// operator pid" tests exercise the real check instead of a weaker one.
    /// Killed on drop so a panicking assertion never leaks the process.
    struct FakeServeProcess(std::process::Child);

    impl FakeServeProcess {
        fn spawn() -> Self {
            let child = std::process::Command::new("bash")
                .args(["-c", "exec -a serve.mjs sleep 30"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn a fake serve.mjs-cmdline process for the test");
            // Give /proc a moment to reflect the exec'd argv0 before any
            // caller reads /proc/<pid>/cmdline.
            std::thread::sleep(std::time::Duration::from_millis(50));
            Self(child)
        }

        fn pid(&self) -> u32 {
            self.0.id()
        }
    }

    impl Drop for FakeServeProcess {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn discovery_socket_still_live_true_for_tcp_endpoint_regardless_of_filesystem() {
        // A `tcp://` endpoint has nothing on the local filesystem to check —
        // only the pid is validated (here: unknown pid → fail open).
        assert!(still_live("tcp://127.0.0.1:35745", 0, false));
        // Dead pid still fails a tcp:// endpoint — pid liveness is checked
        // regardless of transport.
        assert!(!still_live(
            "tcp://127.0.0.1:35745",
            DEFINITELY_DEAD_PID,
            false
        ));
    }

    #[test]
    fn discovery_socket_still_live_false_for_dead_pid() {
        let dir = temp_dir("ipc-live-dead-pid");
        let sock = dir.join("real.sock");
        std::fs::write(&sock, b"").unwrap(); // the socket FILE exists…
                                             // …but the advertised pid is dead → the whole advertisement is stale.
        assert!(!still_live(
            &sock.to_string_lossy(),
            DEFINITELY_DEAD_PID,
            false
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discovery_socket_still_live_false_when_socket_file_missing() {
        let dir = temp_dir("ipc-live-missing-sock");
        let sock = dir.join("gone.sock"); // never created
                                          // Pid is alive (this test process) but the socket file itself is
                                          // gone — still stale (e.g. the operator died between writing the
                                          // discovery file and this read).
        assert!(!still_live(
            &sock.to_string_lossy(),
            std::process::id(),
            false
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discovery_socket_still_live_true_for_alive_pid_and_existing_socket() {
        let dir = temp_dir("ipc-live-good");
        let sock = dir.join("real.sock");
        std::fs::write(&sock, b"").unwrap();
        let fake_operator = FakeServeProcess::spawn();
        assert!(still_live(
            &sock.to_string_lossy(),
            fake_operator.pid(),
            false
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE WI-6512 GUARD for the IPC leg.
    ///
    /// This test process is unambiguously alive, and its cmdline (a cargo test
    /// binary) looks nothing like an operator entrypoint. The advertisement
    /// gate must STILL accept it, because it refuses only on proof that the
    /// pid is gone — never on a name heuristic.
    ///
    /// That distinction is the entire bug: when this gate consulted
    /// `discovery_pid_alive` (pid existence AND a `serve.mjs`/`serve.ts`
    /// cmdline match), every real operator — which runs as `hono-host` — was
    /// classified a restart orphan, so `/api` never dialed IPC at all.
    #[test]
    fn advertisement_gate_accepts_a_live_pid_whose_cmdline_is_unrecognized() {
        let dir = temp_dir("ipc-live-unrecognized-cmdline");
        let sock = dir.join("real.sock");
        std::fs::write(&sock, b"").unwrap();
        // Precondition — without this the test could pass for the wrong reason.
        let me = local_process_cmdline(std::process::id()).unwrap_or_default();
        assert!(
            !cmdline_looks_like_operator(&me),
            "precondition: this test binary must not look like an operator, got {me:?}"
        );
        assert!(
            still_live(&sock.to_string_lossy(), std::process::id(), false),
            "a LIVE pid must never be vetoed for having an unanticipated cmdline"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discovery_socket_still_live_true_for_unknown_pid_zero_fail_open() {
        // pid==0 means the discovery file predates the pid field / didn't
        // parse one — we can't validate liveness, so don't reject on it.
        let dir = temp_dir("ipc-live-unknown-pid");
        let sock = dir.join("real.sock");
        std::fs::write(&sock, b"").unwrap();
        assert!(still_live(&sock.to_string_lossy(), 0, false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_dev_ipc_socket_validated_rejects_a_restart_orphaned_advertisement() {
        let dir = temp_dir("ipc-validated-stale");
        let sock = dir.join("stale.sock");
        std::fs::write(&sock, b"").unwrap();
        let file = dir.join("endpoint-ipc.json");
        std::fs::write(
            &file,
            format!(
                r#"{{"socketPath":"{}","pid":{}}}"#,
                sock.to_string_lossy(),
                DEFINITELY_DEAD_PID
            ),
        )
        .unwrap();
        // The raw parser still returns the (stale) path…
        assert_eq!(
            read_dev_ipc_socket(&file),
            Some(sock.to_string_lossy().to_string())
        );
        // …but the validated read treats it as no advertisement at all — and,
        // unlike the old bare `None`, SAYS WHY (the whole point of WI-6512's
        // instrumentation: the reason existed here and was being discarded).
        let state = inspect_advertisement(&file, false);
        assert_eq!(state.live_socket(), None);
        assert!(
            matches!(state, AdvertisementState::DeadPid { .. }),
            "a restart orphan must be distinguishable from an absent file, got {state:?}"
        );
        assert!(
            state.describe().contains("not running"),
            "the reason must be legible to a human reading a log: {}",
            state.describe()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_dev_ipc_socket_validated_accepts_a_fresh_advertisement() {
        let dir = temp_dir("ipc-validated-fresh");
        let sock = dir.join("fresh.sock");
        std::fs::write(&sock, b"").unwrap();
        let fake_operator = FakeServeProcess::spawn();
        let file = dir.join("endpoint-ipc.json");
        std::fs::write(
            &file,
            format!(
                r#"{{"socketPath":"{}","pid":{}}}"#,
                sock.to_string_lossy(),
                fake_operator.pid()
            ),
        )
        .unwrap();
        assert_eq!(
            inspect_advertisement(&file, false).live_socket(),
            Some(sock.to_string_lossy().as_ref())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn per_port_discovery_validated_falls_back_past_a_stale_per_port_file() {
        // Mirrors per_port_discovery_prefers_the_port_file_then_falls_back,
        // but the per-port file names a DEAD pid — a fixed dev-box port
        // (3070/3170) must fall through to the legacy singleton exactly as
        // it would if the per-port file were simply absent.
        let dir = temp_dir("ipc-port-validated");
        let stale_sock = dir.join("staging.sock");
        std::fs::write(&stale_sock, b"").unwrap();
        std::fs::write(
            dir.join("endpoint-ipc.3170.json"),
            format!(
                r#"{{"socketPath":"{}","pid":{}}}"#,
                stale_sock.to_string_lossy(),
                DEFINITELY_DEAD_PID
            ),
        )
        .unwrap();
        let legacy_sock = dir.join("legacy.sock");
        std::fs::write(&legacy_sock, b"").unwrap();
        let fake_operator = FakeServeProcess::spawn();
        std::fs::write(
            dir.join("endpoint-ipc.json"),
            format!(
                r#"{{"socketPath":"{}","pid":{}}}"#,
                legacy_sock.to_string_lossy(),
                fake_operator.pid()
            ),
        )
        .unwrap();
        let fixed = resolve_dev_ipc_socket(&dir, 3170, false);
        assert_eq!(
            fixed.path,
            Some(std::path::PathBuf::from(
                legacy_sock.to_string_lossy().as_ref()
            )),
            "a stale per-port file on a fixed dev port must fall back to a live singleton"
        );
        // A CUSTOM port (EI-296) must NOT fall back even when its own
        // per-port file is merely stale, not absent.
        std::fs::write(
            dir.join("endpoint-ipc.3271.json"),
            format!(
                r#"{{"socketPath":"{}","pid":{}}}"#,
                stale_sock.to_string_lossy(),
                DEFINITELY_DEAD_PID
            ),
        )
        .unwrap();
        let custom = resolve_dev_ipc_socket(&dir, 3271, false);
        assert_eq!(custom.path, None);
        // The EI-296 no-fallback rule is CORRECT but was invisible: a custom-port
        // shell that never connected reported nothing at all, which is the exact
        // dead end WI-6512 hit. The refusal must now name itself and the file it
        // wanted, or the next investigator re-derives it from the filesystem again.
        assert!(
            custom.detail.contains("3271") && custom.detail.contains("endpoint-ipc.3271.json"),
            "a custom-port refusal must name the port and the advertisement it wanted: {}",
            custom.detail
        );
        assert!(
            custom.detail.contains("no singleton fallback"),
            "a custom-port refusal must say it deliberately did not fall back: {}",
            custom.detail
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_dev_ipc_socket_reports_a_port_that_never_advertised() {
        // The plain "operator isn't up yet" case. It must be distinguishable in
        // the detail string from a stale advertisement, because the operator
        // response differs: wait, versus a restart left an orphan behind.
        let dir = temp_dir("ipc-resolve-absent");
        let r = resolve_dev_ipc_socket(&dir, 3070, false);
        assert_eq!(r.path, None);
        assert!(
            r.detail.contains("no advertisement published"),
            "an absent advertisement must say so plainly: {}",
            r.detail
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_dev_ipc_socket_explains_a_successful_resolution_too() {
        // A resolution that WORKS still has to say which advertisement it used:
        // "IPC is connected" is not actionable without knowing to WHICH operator,
        // and on this box several are live on different ports at once.
        let dir = temp_dir("ipc-resolve-live");
        let sock = dir.join("live.sock");
        std::fs::write(&sock, b"").unwrap();
        let fake_operator = FakeServeProcess::spawn();
        std::fs::write(
            dir.join("endpoint-ipc.3070.json"),
            format!(
                r#"{{"socketPath":"{}","pid":{}}}"#,
                sock.to_string_lossy(),
                fake_operator.pid()
            ),
        )
        .unwrap();
        let r = resolve_dev_ipc_socket(&dir, 3070, false);
        assert_eq!(
            r.path,
            Some(std::path::PathBuf::from(sock.to_string_lossy().as_ref()))
        );
        assert!(
            r.detail.contains("3070") && r.detail.contains(&fake_operator.pid().to_string()),
            "a successful resolution must name the port and the pid it reached: {}",
            r.detail
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// D-008 (`no-http-anywhere-2026-07-28`). The webview decides whether
    /// `/api/desktop/*` may ride IPC purely from this flag, so getting it wrong in
    /// either direction is a user-visible bug — and the two directions cost very
    /// differently, which is why this asserts both.
    ///
    /// A false NEGATIVE costs one native HTTP request per poll (the old behaviour).
    /// A false POSITIVE routes a content-origin-scoped call to a FOREIGN operator,
    /// where it 404s and silently hides the env-switcher bar — the exact failure the
    /// original blanket carve-out was added to prevent. So the singleton-fallback
    /// case must never claim content origin, however convenient that would be.
    #[test]
    fn per_port_resolution_proves_content_origin_but_the_singleton_fallback_does_not() {
        let dir = temp_dir("ipc-resolve-content-origin");

        // (1) Per-port advertisement: published BY the operator on :3070, which is
        // the origin serving this webview. Proven same operator.
        let sock = dir.join("live.sock");
        std::fs::write(&sock, b"").unwrap();
        let per_port_operator = FakeServeProcess::spawn();
        std::fs::write(
            dir.join("endpoint-ipc.3070.json"),
            format!(
                r#"{{"socketPath":"{}","pid":{}}}"#,
                sock.to_string_lossy(),
                per_port_operator.pid()
            ),
        )
        .unwrap();
        let per_port = resolve_dev_ipc_socket(&dir, 3070, false);
        assert!(
            per_port.owner_is_content_origin,
            "a per-port advertisement is published by the operator on that port, so it \
             proves the IPC owner is the content origin: {}",
            per_port.detail
        );

        // (2) Same directory, a port whose per-port file is STALE, so resolution
        // falls back to the last-writer-wins singleton. That socket may belong to
        // any operator on the box, so content origin is NOT proven.
        let stale_sock = dir.join("stale.sock");
        std::fs::write(&stale_sock, b"").unwrap();
        std::fs::write(
            dir.join("endpoint-ipc.3170.json"),
            format!(
                r#"{{"socketPath":"{}","pid":{}}}"#,
                stale_sock.to_string_lossy(),
                DEFINITELY_DEAD_PID
            ),
        )
        .unwrap();
        let singleton_sock = dir.join("singleton.sock");
        std::fs::write(&singleton_sock, b"").unwrap();
        let singleton_operator = FakeServeProcess::spawn();
        std::fs::write(
            dir.join("endpoint-ipc.json"),
            format!(
                r#"{{"socketPath":"{}","pid":{}}}"#,
                singleton_sock.to_string_lossy(),
                singleton_operator.pid()
            ),
        )
        .unwrap();
        let fell_back = resolve_dev_ipc_socket(&dir, 3170, false);
        assert_eq!(
            fell_back.path,
            Some(std::path::PathBuf::from(
                singleton_sock.to_string_lossy().as_ref()
            )),
            "precondition: this case must actually take the singleton fallback"
        );
        assert!(
            !fell_back.owner_is_content_origin,
            "the singleton is last-writer-wins and may name a DIFFERENT operator, so it \
             must never claim content origin: {}",
            fell_back.detail
        );

        // (3) A miss proves nothing either — there is no owner at all.
        let absent = resolve_dev_ipc_socket(&dir, 3271, false);
        assert_eq!(absent.path, None);
        assert!(!absent.owner_is_content_origin);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Packaged Windows reads the endpoint advertisement from inside the WSL
    /// distro, where the bundled sidecar is the operator serving this webview.
    /// That successful read must therefore enable content-origin-scoped IPC
    /// (including `/api/desktop/version`) instead of silently taking HTTP.
    #[test]
    fn packaged_wsl_resolution_proves_content_origin_for_a_found_endpoint() {
        let resolved = resolve_wsl_endpoint_ipc_socket(Some("tcp://127.0.0.1:21958".to_string()));
        assert_eq!(
            resolved.path,
            Some(std::path::PathBuf::from("tcp://127.0.0.1:21958"))
        );
        assert!(
            resolved.owner_is_content_origin,
            "the packaged WSL sidecar owns the operator serving this webview: {}",
            resolved.detail
        );

        let missing = resolve_wsl_endpoint_ipc_socket(None);
        assert_eq!(missing.path, None);
        assert!(!missing.owner_is_content_origin);
    }
}

#[cfg(test)]
mod macos_bundle_tests {
    use serde_json::Value;
    use std::{fs, path::PathBuf};

    fn src_tauri_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    #[test]
    fn tauri_config_points_macos_bundle_at_info_and_entitlements() {
        let config_path = src_tauri_dir().join("tauri.conf.json");
        let config: Value =
            serde_json::from_str(&fs::read_to_string(config_path).expect("read tauri.conf.json"))
                .expect("parse tauri.conf.json");
        let mac = &config["bundle"]["macOS"];
        assert_eq!(mac["entitlements"], "entitlements.plist");
        assert_eq!(mac["infoPlist"], "Info.plist");
    }

    #[test]
    fn info_plist_declares_microphone_usage_description() {
        let plist =
            fs::read_to_string(src_tauri_dir().join("Info.plist")).expect("read Info.plist");
        assert!(plist.contains("NSMicrophoneUsageDescription"));
        assert!(plist.contains("voice mode"));
    }

    #[test]
    fn entitlements_enable_macos_audio_input() {
        let plist = fs::read_to_string(src_tauri_dir().join("entitlements.plist"))
            .expect("read entitlements");
        assert!(plist.contains("com.apple.security.device.audio-input"));
        assert!(plist.contains("<true/>"));
    }
}

/// Build the Command that actually runs the sidecar. On Windows with
/// WSL Ready we wrap node in `wsl.exe --distribution papercup-runtime
/// --cd <wsl-cwd> --exec node …`. Otherwise we run node natively.
///
/// Caller still chains `.env(...)` calls; for the WSL path those env
/// vars are forwarded to the Linux side via the `WSLENV` env-var list
/// convention (set automatically here).
fn make_sidecar_command(
    via_wsl: bool,
    sidecar_dir: &std::path::Path,
    preload: &std::path::Path,
    server_js: &std::path::Path,
) -> Command {
    if via_wsl {
        #[cfg(target_os = "windows")]
        {
            let cwd_wsl = windows_path_to_wsl(sidecar_dir);
            let preload_wsl = windows_path_to_wsl(preload);
            let server_js_wsl = windows_path_to_wsl(server_js);
            let mut cmd = Command::new("wsl.exe");
            cmd.env("WSL_UTF8", "1").args([
                "--distribution",
                wsl_setup::DISTRO_NAME_PUB,
                "--cd",
                &cwd_wsl,
                "--exec",
                "node",
                "--require",
                &preload_wsl,
                &server_js_wsl,
            ]);
            isolate_process_group(&mut cmd);
            return cmd;
        }
        #[cfg(not(target_os = "windows"))]
        {
            // unreachable in practice — should_route_via_wsl returns
            // false on non-Windows. Fall through to native.
        }
    }
    let mut cmd = Command::new("node");
    // Cap glibc malloc arenas (host-memory-reduction-2026-09-27 D-027). serve
    // re-execs itself to get the cap when its launcher omits it; setting it
    // here skips that second exec. A no-op outside glibc.
    cmd.env("MALLOC_ARENA_MAX", "2")
        .arg("--require")
        .arg(preload)
        .arg(server_js)
        .current_dir(sidecar_dir);
    isolate_process_group(&mut cmd);
    cmd
}

#[cfg(test)]
mod sidecar_command_env_tests {
    use super::make_sidecar_command;
    use std::ffi::OsStr;
    use std::path::Path;

    #[test]
    fn native_sidecar_command_caps_malloc_arenas() {
        let cmd = make_sidecar_command(
            false,
            Path::new("/opt/papercusp/sidecar"),
            Path::new("sidecar-preload.js"),
            Path::new("serve.mjs"),
        );
        let arena_max = cmd
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("MALLOC_ARENA_MAX"))
            .and_then(|(_, value)| value);
        assert_eq!(arena_max, Some(OsStr::new("2")));
    }
}

/// Minimal operator.json discovery (SP1 C5). Written atomically by `serve`
/// once the host is listening; removed on its clean shutdown. Mirrors the
/// `OperatorDiscovery` interface in apps/operator/bin/serve.ts.
#[derive(Debug, Clone)]
struct OperatorDiscovery {
    port: u16,
    pid: u32,
    process_identity: Option<String>,
}

/// Parse the operator.json discovery payload, or None. Factored from the
/// file read so the validation (port/pid present and nonzero) is unit-tested.
fn parse_operator_discovery(txt: &str) -> Option<OperatorDiscovery> {
    let v: serde_json::Value = serde_json::from_str(txt).ok()?;
    let port = v.get("port")?.as_u64()? as u16;
    let pid = v.get("pid")?.as_u64()? as u32;
    if port == 0 || pid == 0 {
        return None;
    }
    let process_identity = v
        .get("processIdentity")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    Some(OperatorDiscovery {
        port,
        pid,
        process_identity,
    })
}

/// Match serve.ts's established per-instance runtime directory. An explicit
/// root is authoritative: a missing file there must not adopt the user's
/// unrelated default instance. Empty follows Node's `PAPERCUSP_HOME || ...`.
fn native_papercusp_dir(workspace_home: &std::path::Path) -> std::path::PathBuf {
    std::env::var_os("PAPERCUSP_HOME")
        .filter(|root| !root.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| workspace_home.join(".papercusp"))
}

/// Parse this instance's operator.json, or None.
fn read_operator_discovery(workspace_home: &std::path::Path) -> Option<OperatorDiscovery> {
    let path = native_papercusp_dir(workspace_home).join("operator.json");
    let txt = std::fs::read_to_string(path).ok()?;
    parse_operator_discovery(&txt)
}

/// The live operator port straight from `$HOME/.papercusp/operator.json` — the
/// self-heal source for `custom_protocol::upstream_base` when `SidecarState.port`
/// was never latched (WI-3282). `serve` writes this file when it starts listening
/// and removes it on clean shutdown, so a present file with a nonzero port means a
/// live operator. Reading it per `/api` miss (only when the latched port is None)
/// makes the webview→operator proxy resilient to a boot-discovery / watcher latch
/// miss instead of dead-ending the whole app on a permanent 503.
///
/// HOME-based (matches env_switch's persisted_target_path): on Linux/mac the
/// operator's workspace HOME is the user's `$HOME`, where it writes the file.
///
/// WINDOWS (WI-37798): the HOME read alone is a GUARANTEED no-op here — the
/// sidecar runs inside WSL and writes operator.json to the distro user's
/// `/home/papercup/.papercusp`, and Windows doesn't even set `HOME`. This used
/// to just `return None` ("no worse than the pre-fix behaviour"), which quietly
/// made WI-3282's self-heal Linux-only: `upstream_base`'s only remaining step
/// is a `debug_assertions`-gated :3070 guess that is COMPILED OUT of a release
/// build, so a packaged Windows build that ever missed the port latch answered
/// EVERY `/api` with a 503 for the life of the process, with no recovery path —
/// a permanent "Operator connection lost" banner. So probe the distro the same
/// way `find_operator_discovery` already does.
///
/// THROTTLED on purpose: this runs per `/api` request whenever the latched port
/// is None, and each Windows probe is a `wsl.exe` spawn. An unthrottled spawn
/// per request is exactly the pressure `distro_exec_wedged` documents as able to
/// wedge the WSL2 interop layer — that would trade a recoverable 503 for an
/// unrecoverable one. `upstream_base` also LATCHES a resolved port, so in the
/// normal case this probe runs once and then stops being reached at all.
#[cfg(any(target_os = "windows", test))]
const SELF_HEAL_WSL_PROBE_MIN_INTERVAL: Duration = Duration::from_secs(2);

/// Whether a throttled probe is due. Pure + platform-independent so the
/// throttle is unit-testable on every dev platform, not just a Windows build
/// (same rationale as `windows_path_to_wsl`'s `cfg(any(..., test))`).
#[cfg(any(target_os = "windows", test))]
fn self_heal_probe_due(last: Option<Instant>, now: Instant, min_interval: Duration) -> bool {
    match last {
        None => true,
        Some(prev) => now.saturating_duration_since(prev) >= min_interval,
    }
}

pub(crate) fn operator_discovery_port_from_home() -> Option<u16> {
    #[cfg(target_os = "windows")]
    {
        static LAST_WSL_PROBE: std::sync::OnceLock<Mutex<Option<Instant>>> =
            std::sync::OnceLock::new();
        // A poisoned lock / not-yet-due probe both mean "skip the spawn", never
        // "no operator" — we still fall through to the HOME read below.
        let due = match LAST_WSL_PROBE.get_or_init(|| Mutex::new(None)).lock() {
            Ok(mut last) => {
                let now = Instant::now();
                if self_heal_probe_due(*last, now, SELF_HEAL_WSL_PROBE_MIN_INTERVAL) {
                    *last = Some(now);
                    true
                } else {
                    false
                }
            }
            Err(_) => false,
        };
        if due {
            if let Some(d) = read_operator_discovery_via_wsl() {
                return Some(d.port);
            }
        }
    }
    let home = std::env::var_os("HOME")?;
    read_operator_discovery(std::path::Path::new(&home)).map(|d| d.port)
}

/// Spawn a short-lived Windows helper (a per-poll `wsl.exe` read) WITHOUT
/// dropping a visible console window over the webview — same rationale as
/// isolate_process_group, but these reads are fire-and-forget so they don't
/// need the process group.
#[cfg(target_os = "windows")]
fn no_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(windows::Win32::System::Threading::CREATE_NO_WINDOW.0);
}

/// The `.papercusp` dir INSIDE the WSL distro that the sidecar reads/writes
/// discovery state to. The sidecar runs as the distro user `papercup`
/// (HOME=/home/papercup — WSLENV HOME/p forwarding does not survive WSL
/// session init), so this defaults to the shared `/home/papercup/.papercusp`,
/// NOT the forwarded /mnt/c home. Honors `PAPERCUSP_HOME` when the launcher
/// sets it (forwarded via `PAPERCUSP_HOME/p` in SIDECAR_WSLENV, translated
/// from its Windows-side value) — this is the same isolation escape hatch
/// `papercusp-root.ts` already promises on Linux/Mac, letting a caller run an
/// throwaway/isolated sidecar instance instead of always adopting the shared
/// distro home (WI-5305: previously silently ignored on Windows because
/// PAPERCUSP_HOME wasn't in SIDECAR_WSLENV and this path was hardcoded).
///
/// `#[cfg(any(..., test))]` (mirrors `windows_path_to_wsl` above) so this is
/// exercised by `cargo test` on every dev platform, not just a Windows build.
#[cfg(any(target_os = "windows", test))]
fn wsl_papercusp_home_dir() -> String {
    match std::env::var("PAPERCUSP_HOME") {
        Ok(v) if !v.trim().is_empty() => windows_path_to_wsl(std::path::Path::new(&v)),
        _ => "/home/papercup/.papercusp".to_string(),
    }
}

/// operator.json path INSIDE the WSL distro. See `wsl_papercusp_home_dir`.
#[cfg(any(target_os = "windows", test))]
fn wsl_operator_json_path() -> String {
    format!("{}/operator.json", wsl_papercusp_home_dir())
}

/// Read operator.json the ROBUST way when the sidecar runs inside WSL: shell
/// into the distro and `cat` the file. The `\\wsl.localhost` UNC share we used
/// to read through is UNRELIABLE — observed live 2026-07-03 on the Windows VM,
/// `Test-Path` returned False for every `\\wsl.localhost\<distro>\…` path WHILE
/// the distro was running and `wsl.exe -e cat` read the same file fine. When the
/// UNC read fails, wait_for_operator burns its full 120s timeout despite a
/// healthy operator, and the webview strands on the frontendDist :3070 error
/// page — the app never shows its UI. This uses the exact mechanism
/// discovery_pid_alive already relies on, so it works whenever the distro is up.
#[cfg(target_os = "windows")]
fn read_operator_discovery_via_wsl() -> Option<OperatorDiscovery> {
    let path = wsl_operator_json_path();
    let mut cmd = Command::new("wsl.exe");
    cmd.args([
        "--distribution",
        wsl_setup::DISTRO_NAME_PUB,
        "-e",
        "cat",
        &path,
    ]);
    no_console_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_operator_discovery(&String::from_utf8_lossy(&out.stdout))
}

/// Probe whether the WSL distro's exec layer is WEDGED — i.e. `wsl.exe --exec`
/// no longer returns even for a trivial command. A relentless serve respawn
/// storm (each respawn is a `wsl.exe --exec node`) can drive the WSL2 interop
/// into this state, after which EVERY exec (including the respawn itself)
/// produces a dead child and the operator can never recover — the exact outage
/// that on the VM required a manual `wsl --terminate` (WI-3360, 2026-07-08:
/// `wsl -d papercup-runtime -- echo` returned empty until a terminate). Returns
/// true when a trivial `wsl.exe -e true` cannot exit 0 within `timeout`. std has
/// no Command timeout, so we spawn + poll try_wait + kill on the deadline.
#[cfg(target_os = "windows")]
fn distro_exec_wedged(timeout: Duration) -> bool {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["--distribution", wsl_setup::DISTRO_NAME_PUB, "-e", "true"]);
    no_console_window(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return true, // can't even spawn wsl.exe → treat as wedged
    };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return !status.success(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return true; // never returned in time → wedged
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return true,
        }
    }
}

/// Reset a wedged WSL distro so the next serve respawn boots into a fresh VM.
/// `wsl.exe --terminate <distro>` stops the distro (it cold-boots on the next
/// exec) WITHOUT unregistering it — no data loss. This is the single action
/// that clears the interop wedge (WI-3360). Returns true on a clean exit.
#[cfg(target_os = "windows")]
fn terminate_distro() -> bool {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["--terminate", wsl_setup::DISTRO_NAME_PUB]);
    no_console_window(&mut cmd);
    matches!(cmd.status(), Ok(s) if s.success())
}

/// Run one argument-safe command inside the packaged WSL distro with a hard
/// deadline. WSL itself can stall, so `Command::status()` must not wait forever.
/// Staging timeouts must not reset the distro: an older operator can still be
/// serving there. Reap only the child this invocation owns.
#[cfg(target_os = "windows")]
fn run_wsl_exec_with_timeout(
    args: &[String],
    timeout: Duration,
) -> std::io::Result<std::process::ExitStatus> {
    let mut cmd = wsl_sidecar_staging::wsl_command();
    cmd.args(args);
    no_console_window(&mut cmd);
    // A cold WSL boot is not a slow ten-second file operation. The SAME
    // invocation proves readiness before we arm the Linux operation deadline.
    wsl_sidecar_staging::run_wsl_bounded(
        &mut cmd,
        timeout,
        wsl_sidecar_staging::WSL_STARTUP_TIMEOUT + timeout,
    )
}

/// Materialize the hot Windows sidecar tree on WSL ext4 and return its native
/// Linux path. The installed bundle remains the immutable source of truth;
/// its content generation (precomputed at package time and bound to
/// `.sidecar-build-stamp`, WI-10003673) addresses a distro-local snapshot, so
/// normal launches are a single marker probe and updates publish through a
/// temp dir.
///
/// `source.tar.zst` and the DB seed archives are intentionally excluded: they
/// are one-time extraction inputs (and can be multi-gigabyte), not hot runtime
/// files. Their env vars keep pointing at the Windows install with WSLENV `/p`.
#[cfg(target_os = "windows")]
fn prepare_wsl_sidecar_runtime(
    sidecar_dir: &std::path::Path,
) -> std::io::Result<std::path::PathBuf> {
    let generation = sidecar_runtime_generation(sidecar_dir)?;
    let runtime_dir = wsl_runtime_sidecar_path(&wsl_papercusp_home_dir(), &generation)?;
    let marker = runtime_dir.join(".papercusp-runtime-complete");
    let marker_args = vec![
        "/usr/bin/test".to_string(),
        "-f".to_string(),
        windows_path_to_wsl(&marker),
    ];
    if run_wsl_exec_with_timeout(&marker_args, Duration::from_secs(10))?.success() {
        return Ok(runtime_dir);
    }

    let temporary = format!("{}.tmp.{}", runtime_dir.display(), std::process::id());
    // EI-22686884542583537: the old Linux tar -C /mnt/c reintroduced the
    // per-file P9 reads this ext4 cache was meant to remove. Native tar reads
    // NTFS into the ready WSL child's binary stdin handle. D019's full native
    // witness distinguishes this from a user-space/text interop relay.
    let mut producer = Command::new("tar.exe");
    producer
        .arg("-C")
        .arg(sidecar_dir)
        .args(wsl_sidecar_staging::ARCHIVE_ARGS)
        .args(["-b", "2048", "-cf", "-", "."]);
    no_console_window(&mut producer);
    let mut consumer = wsl_sidecar_staging::wsl_command();
    consumer
        .args(["/bin/bash", "-c"])
        .arg(wsl_sidecar_staging::EXTRACT_SCRIPT)
        .arg("papercusp-extract-sidecar")
        .arg("-")
        .arg(&temporary);
    no_console_window(&mut consumer);
    wsl_sidecar_staging::stage_archive(producer, consumer, Duration::from_secs(1_200))?;
    // Never mark a transfer complete under a key computed from a different
    // source generation (for example an installer replacing files mid-copy).
    if sidecar_runtime_generation(sidecar_dir)? != generation {
        return Err(std::io::Error::other(
            "Windows sidecar payload changed during WSL staging; refusing publication",
        ));
    }
    let publish_args = vec![
        "/bin/bash".to_string(),
        "-c".to_string(),
        wsl_sidecar_staging::PUBLISH_SCRIPT.to_string(),
        "papercusp-publish-sidecar".to_string(),
        temporary,
        runtime_dir.to_string_lossy().to_string(),
    ];
    let status = run_wsl_exec_with_timeout(&publish_args, Duration::from_secs(10))?;
    if !status.success() {
        return Err(std::io::Error::other(format!(
            "WSL sidecar staging exited with {status}"
        )));
    }
    Ok(runtime_dir)
}

/// Unified operator discovery shared by BOTH the initial boot wait and the
/// long-lived watcher, so the two can never drift. When routed via WSL
/// (Windows), read through `wsl.exe` (the UNC share is unreliable — see
/// read_operator_discovery_via_wsl); otherwise read the local filesystem path.
/// Routing the WATCHER through this (it previously read only the Windows-side
/// workspace_home, which never holds the WSL operator.json) is what lets it
/// follow an operator restart on the VM instead of being permanently blind.
fn find_operator_discovery(
    workspace_home: &std::path::Path,
    via_wsl: bool,
) -> Option<OperatorDiscovery> {
    #[cfg(target_os = "windows")]
    if via_wsl {
        if let Some(d) = read_operator_discovery_via_wsl() {
            return Some(d);
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = via_wsl;
    read_operator_discovery(workspace_home)
}

/// The endpoint-IPC discovery file INSIDE the WSL distro. Mirrors
/// `wsl_operator_json_path`: the sidecar (running in WSL2) writes it to its
/// WSL-native `$HOME/.papercusp` (or the isolated `PAPERCUSP_HOME` dir when
/// set — see `wsl_papercusp_home_dir`), NOT the Windows-side workspace_home
/// the client reads — see `find_endpoint_ipc_socket` (WI-3395).
#[cfg(any(target_os = "windows", test))]
fn wsl_endpoint_ipc_json_path() -> String {
    format!("{}/endpoint-ipc.json", wsl_papercusp_home_dir())
}

/// Read the endpoint-IPC `socketPath` from INSIDE the WSL distro via `wsl.exe
/// -e cat`, exactly like `read_operator_discovery_via_wsl` (the `\\wsl$` UNC
/// share is unreliable — see that fn). WI-3395: the WSL2 sidecar binds a
/// `tcp://127.0.0.1:<port>` endpoint and records it in its WSL-native
/// `~/.papercusp/endpoint-ipc.json`; the Windows host reaches that port via
/// WSL2 localhost-forwarding (same mechanism as the operator HTTP port).
#[cfg(target_os = "windows")]
fn read_endpoint_ipc_socket_via_wsl() -> Option<String> {
    let path = wsl_endpoint_ipc_json_path();
    let mut cmd = Command::new("wsl.exe");
    cmd.args([
        "--distribution",
        wsl_setup::DISTRO_NAME_PUB,
        "-e",
        "cat",
        &path,
    ]);
    no_console_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_endpoint_ipc_socket(&String::from_utf8_lossy(&out.stdout))
}

/// Classify an endpoint read from the packaged Windows sidecar's WSL-native
/// discovery file. The sidecar launched by this desktop is the operator serving
/// the webview, so a successful WSL read proves the IPC owner is the content
/// origin even though the WSL read does not carry a pid for liveness validation.
/// Keep this classification separate from the read so Linux CI can exercise the
/// owner-origin contract without invoking `wsl.exe`.
#[cfg(any(target_os = "windows", test))]
fn resolve_wsl_endpoint_ipc_socket(socket: Option<String>) -> endpoint_ipc::SocketResolution {
    match socket {
        Some(s) => endpoint_ipc::SocketResolution::found(
            s,
            "read from the WSL distro's ~/.papercusp/endpoint-ipc.json",
        )
        .from_content_origin(),
        None => endpoint_ipc::SocketResolution::missing(
            "no endpoint-ipc.json readable inside the WSL distro yet",
        ),
    }
}

/// Unified endpoint-IPC socket discovery — mirrors `find_operator_discovery`.
/// On Windows routed via WSL, read the discovery JSON from INSIDE the distro
/// (the sidecar's WSL-native `~/.papercusp`, cross-filesystem from the Windows
/// workspace_home), else read the local `workspace_home/.papercusp` path
/// (mac/linux, plus the non-WSL Windows fallback). WI-3395: without the WSL
/// read, the Windows client never finds the file the WSL2 sidecar wrote and
/// `/api` strands on the capped HTTP fallback.
fn find_endpoint_ipc_socket(workspace_home: &std::path::Path, via_wsl: bool) -> Option<String> {
    #[cfg(target_os = "windows")]
    if via_wsl {
        if let Some(s) = read_endpoint_ipc_socket_via_wsl() {
            return Some(s);
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = via_wsl;
    read_dev_ipc_socket(&native_papercusp_dir(workspace_home).join("endpoint-ipc.json"))
}

/// `find_endpoint_ipc_socket`, validated AND explaining the outcome — the
/// production/spawned-sidecar counterpart of `resolve_dev_ipc_socket`, used at
/// that `IpcClientHandle` socket-source site so a restart-orphaned
/// advertisement is treated as "not ready yet" instead of dialed straight into
/// ENOENT. Same reason for the `SocketResolution`: a bare `None` told an
/// operator nothing about whether the sidecar had yet advertised, had died, or
/// had left a stale file behind.
///
/// The WSL cat-read branch carries no pid to validate against, but that does not
/// weaken its ownership proof: in packaged Windows it reads the WSL-native
/// discovery file written by the sidecar that serves this webview. Its explicit
/// owner-origin classification is kept in `resolve_wsl_endpoint_ipc_socket`, a
/// helper also covered by Linux CI.
fn find_endpoint_ipc_socket_resolved(
    workspace_home: &std::path::Path,
    via_wsl: bool,
) -> endpoint_ipc::SocketResolution {
    #[cfg(target_os = "windows")]
    if via_wsl {
        return resolve_wsl_endpoint_ipc_socket(read_endpoint_ipc_socket_via_wsl());
    }
    let path = native_papercusp_dir(workspace_home).join("endpoint-ipc.json");
    let state = inspect_advertisement(&path, via_wsl);
    match state.live_socket() {
        // Production: the sidecar we spawned IS the operator serving this
        // webview, so the IPC owner is the content origin by construction.
        Some(socket) => endpoint_ipc::SocketResolution::found(
            socket,
            format!("sidecar discovery file: {}", state.describe()),
        )
        .from_content_origin(),
        None => endpoint_ipc::SocketResolution::missing(format!(
            "sidecar discovery file {}: {}",
            path.display(),
            state.describe()
        )),
    }
}

/// WI-1869: given the operator port the webview is CURRENTLY pointed at and the
/// latest operator.json discovery, decide whether to re-navigate — and to which
/// port. Returns Some(new_port) iff a discovery is present and names a DIFFERENT
/// port than the applied one (i.e. a Server restart / sidecar crash-respawn
/// moved the operator). Pure, so it is unit-tested on Linux CI — the macOS/
/// Windows dynamic-port path that this guards can never be exercised there,
/// which is exactly the blind spot that let the strand-on-restart bug ship.
fn next_operator_port(applied_port: u16, latest: Option<&OperatorDiscovery>) -> Option<u16> {
    match latest {
        Some(d) if d.port != applied_port => Some(d.port),
        _ => None,
    }
}

/// WI-2667: what the operator watcher should DO about Server liveness this tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServerSupervisionAction {
    /// The Server process is alive — reset the dead counter, nothing to do.
    Healthy,
    /// A system LaunchDaemon plist is installed and owns the Server lifecycle;
    /// the GUI must not launch the Server bundle during a temporary bootout.
    DeferToLaunchDaemon,
    /// Dead, but still inside the debounce window or a post-respawn boot grace —
    /// keep waiting (a normal restart briefly looks dead as the pid rolls over).
    Wait,
    /// Operator dead but the Server SHELL is provably alive (fresh heartbeat) —
    /// a bundle launch would single-instance no-op, so never launch (and never
    /// burn a respawn-cap slot on it); the shell's own serve supervisor is the
    /// one that can act (WI-3270).
    DeferToShell,
    /// Dead past the debounce and under the respawn cap — relaunch the Server.
    Respawn,
    /// Respawned too many times in the window (crash-loop) — back off and
    /// notify. Recoverable (WI-3270): once the respawn window drains the
    /// decision returns to Respawn, so a wedged Server keeps getting slow
    /// retries instead of requiring a manual app restart.
    GiveUp,
}

/// Pure liveness decision for the operator watcher (WI-2667 — packaged operator
/// dies on SIGTERM and nothing brings it back). Extracted + unit-tested (Cargo)
/// for the SAME reason `next_operator_port` is: the macOS/Windows respawn path
/// can't be exercised on Linux CI, and that blind spot is exactly what let the
/// original strand-on-restart bug ship. Keeping the branching pure means every
/// arm (debounce, boot grace, crash-loop cap, latched give-up) has a guard.
///
/// `dead_count` is the tick's accumulated consecutive-dead count (already
/// incremented for this tick when dead & not in grace). `open -b` on the
/// single-instance Server is a no-op when it's actually alive, so a spurious
/// Respawn is harmless — but the debounce + cap keep it from thrashing.
/// `server_shell_alive` is the WI-3270 heartbeat signal: the Server SHELL
/// process is provably up, so a bundle launch can only single-instance no-op.
fn decide_server_supervision(
    process_alive: bool,
    launchdaemon_installed: bool,
    server_shell_alive: bool,
    in_boot_grace: bool,
    dead_count: u32,
    dead_threshold: u32,
    respawns_in_window: usize,
    max_respawns: usize,
    already_gave_up: bool,
) -> ServerSupervisionAction {
    if process_alive {
        // Alive also RECOVERS a latched give-up (WI-3270): something (a manual
        // launch, the shell's own serve supervisor) brought the Server back —
        // the caller clears the latch and re-arms auto-respawn.
        return ServerSupervisionAction::Healthy;
    }
    if launchdaemon_installed {
        return ServerSupervisionAction::DeferToLaunchDaemon;
    }
    if server_shell_alive {
        // WI-3270 (c): operator dead but the Server shell is alive — launching
        // the bundle is a guaranteed single-instance no-op, so never burn a
        // respawn-cap slot on it (that burn is how the watcher gave up on the
        // Windows VM while the shell held the single-instance lock throughout).
        return ServerSupervisionAction::DeferToShell;
    }
    if in_boot_grace || dead_count < dead_threshold {
        return ServerSupervisionAction::Wait;
    }
    if respawns_in_window >= max_respawns {
        // WI-3270 (b): give-up is a BACKOFF, not a terminal latch — notify once
        // (GiveUp), then hold (Wait) only while the respawn window is still
        // saturated. respawn_times drains on the window, after which the branch
        // below resumes Respawn (a slow retry tier), so recovery never requires
        // a manual app restart.
        return if already_gave_up {
            ServerSupervisionAction::Wait
        } else {
            ServerSupervisionAction::GiveUp
        };
    }
    ServerSupervisionAction::Respawn
}

/// WI-2667 (defect-2 gap): what the SERVER role should do about its OWN
/// serve.mjs operator child. The GUI-side `open -b` supervisor
/// (`decide_server_supervision`) can only revive a FULLY-exited Server bundle —
/// it no-ops on the still-alive single-instance shell. So when the operator
/// child dies but this Server shell survives (exactly what defect-1's
/// force-exit produces, and any operator crash), only the Server itself can
/// bring the operator back — and it must, else the app is cleanly dead with no
/// recovery (confirmed live on the Mac VM 2026-07-04: 100s, zero auto-recovery).
/// Pure for the same Linux-CI blind-spot reason as `decide_server_supervision`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServeRespawnAction {
    /// Operator reachable (ground truth), or the child is still running and the
    /// operator has not yet been unreachable long enough to count as dead —
    /// nothing to do. (Reachable-despite-child-exit covers the Decision-C
    /// `--ensure` foreign-operator reuse case.)
    Healthy,
    /// App is quitting or self-updating — never resurrect the child we just
    /// killed on purpose.
    Suppressed,
    /// Child exited and no operator is reachable — respawn serve in-process.
    Respawn,
    /// Respawned too many times in the window (crash-loop) — stop until restart.
    GiveUp,
    /// WI-5390: the install itself is broken (a required sidecar entrypoint is
    /// absent), so no respawn can ever succeed. Structurally distinct from
    /// `GiveUp`: a cap hit is a BACKOFF that retries once the window drains,
    /// while this must NOT retry at all — it needs a reinstall, and saying so
    /// once is worth more than an infinite quiet loop.
    InstallBroken,
}

/// The files a `serve.mjs` spawn STRUCTURALLY requires inside the sidecar dir.
/// Both are written by the installer; neither is optional, and neither can
/// appear later on its own — so an absence is a broken install, not a race.
const REQUIRED_SIDECAR_ENTRYPOINTS: [&str; 2] = ["serve.mjs", "sidecar-preload.js"];

/// WI-5390: which required sidecar entrypoints are MISSING from `sidecar_dir`.
/// Empty ⇒ the install looks structurally intact (this is a cheap existence
/// check, not an integrity check — it catches the half-removed-install class,
/// not corruption).
///
/// WHY THIS EXISTS. A `%LOCALAPPDATA%\Papercusp Server\` holding only the .exe —
/// no `sidecar/`, no `resources/` — spawned `node .../sidecar/serve.mjs` anyway.
/// The spawn died instantly (`chdir(...) failed 2`, then MODULE_NOT_FOUND on
/// sidecar-preload.js), the supervisor classified that as an ordinary child exit,
/// and respawned it — 5 times in 8 seconds, then every window drain, FOREVER
/// (observed still looping ~18h later on the Windows VM, 2026-07-17→18). Nothing
/// user-visible ever said "your install is broken": the process stayed alive and
/// looked idle, and the update check reported the soft, transient-sounding
/// "sidecar port not yet known; try again after boot completes" — when boot can
/// never complete. That silent failure cost two days of fleet diagnosis and
/// actively MANUFACTURED a false root cause (it looked like an uninstaller had
/// deleted user state, because the operator never booted to re-write it).
///
/// A structural fault must fail CLOSED and LOUD, not retry forever.
fn missing_sidecar_entrypoints(sidecar_dir: &std::path::Path) -> Vec<&'static str> {
    REQUIRED_SIDECAR_ENTRYPOINTS
        .iter()
        .copied()
        .filter(|name| !sidecar_dir.join(name).exists())
        .collect()
}

/// Pure text builder for the broken-install diagnostic (same
/// testable-without-a-live-AppHandle rationale as
/// `operator_dead_notification_body`). Names the missing files AND the directory
/// they were expected in — the two facts a user or a support agent needs to
/// confirm the diagnosis without a log dive.
fn install_defect_message(sidecar_dir: &std::path::Path, missing: &[&'static str]) -> String {
    format!(
        "Papercusp's installation is incomplete or corrupt: {} missing from {}. \
         The operator cannot start. Reinstall Papercusp to recover.",
        missing.join(", "),
        sidecar_dir.display()
    )
}

/// Process-global latch for a detected broken install (WI-5390). Set by the
/// spawn preflight / supervisor; read by the updater endpoint builders so a
/// user-facing "can't check for updates" reports the TERMINAL cause instead of
/// the transient-sounding "try again after boot completes".
struct InstallDefectLatch {
    message: std::sync::Mutex<Option<String>>,
}

impl InstallDefectLatch {
    const fn new() -> Self {
        Self {
            message: std::sync::Mutex::new(None),
        }
    }

    fn set(&self, message: Option<String>) {
        if let Ok(mut guard) = self.message.lock() {
            *guard = message;
        }
    }

    fn current(&self) -> Option<String> {
        self.message.lock().ok().and_then(|g| g.clone())
    }
}

static INSTALL_DEFECT: InstallDefectLatch = InstallDefectLatch::new();

fn set_install_defect(message: Option<String>) {
    INSTALL_DEFECT.set(message);
}

fn current_install_defect() -> Option<String> {
    INSTALL_DEFECT.current()
}

/// The error a port-dependent call (update check, rollback) should report while
/// the sidecar port is unknown. WI-5390: distinguish "still booting, retry" from
/// "the install is broken, boot can NEVER complete" — the updater rendering the
/// latter as a soft retry is the same silent-failure shape
/// `assert-release-host-baked.sh` exists to kill.
fn sidecar_port_unavailable_message() -> String {
    sidecar_port_unavailable_message_for(&INSTALL_DEFECT)
}

fn sidecar_port_unavailable_message_for(install_defect: &InstallDefectLatch) -> String {
    match install_defect.current() {
        Some(defect) => format!("cannot check for updates — {defect}"),
        None => "sidecar port not yet known; try again after boot completes".to_string(),
    }
}

/// Pure respawn decision for the Server-side serve supervisor (WI-2667, WI-3170).
///   * `child_exited` — the stored serve `Child` has reaped (`try_wait` → Some).
///     UNRELIABLE on Windows: `spawn_serve` stores the wsl.exe WRAPPER as the
///     `Child`, and the wrapper can OUTLIVE the dead WSL-internal node operator,
///     so `child_exited` stays false while the operator is durably gone (WI-3170).
///   * `shutting_down` — `SidecarState.shutdown_done` (normal quit) or an
///     in-flight self-update; suppresses respawn so we don't fight the teardown.
///   * `operator_reachable` — an operator answers discovery+TCP right now. This is
///     the GROUND-TRUTH liveness signal: if it answers we are healthy no matter
///     what the (possibly-wrapper) `Child` says. Also covers the Decision-C reuse
///     case (child exited because `--ensure` handed off to a foreign operator).
///   * `unreachable_respawn_ready` — the operator has been continuously UNREACHABLE
///     past the supervisor's debounce AND had come up at least once this session
///     (so a slow cold boot never trips it). This closes the Windows/WSL blind
///     spot: respawn a durably-dead operator even when the wrapper `Child` is
///     still alive (`child_exited` == false).
///   * `install_broken` — a required sidecar entrypoint is missing from the
///     install (WI-5390). No respawn can fix this, so it must short-circuit the
///     respawn/backoff machinery entirely rather than feeding it forever.
fn decide_serve_respawn(
    child_exited: bool,
    shutting_down: bool,
    operator_reachable: bool,
    unreachable_respawn_ready: bool,
    install_broken: bool,
    respawns_in_window: usize,
    max_respawns: usize,
) -> ServeRespawnAction {
    if shutting_down {
        return ServeRespawnAction::Suppressed;
    }
    // Operator answering discovery+health is ground truth — healthy regardless of
    // the stored `Child` (on Windows it is the wsl.exe wrapper, which lies). This
    // stays AHEAD of the install check on purpose: under `--ensure` a foreign
    // operator can legitimately be serving us, and a reachable operator is not a
    // problem to report no matter what our own install dir looks like.
    if operator_reachable {
        return ServeRespawnAction::Healthy;
    }
    // Operator unreachable AND our install can't produce one — respawning is
    // futile. Report it instead of looping (WI-5390).
    if install_broken {
        return ServeRespawnAction::InstallBroken;
    }
    // Operator is UNREACHABLE. Respawn if the child fully exited (Linux/mac:
    // definitive death) OR it has been unreachable past the debounce (Windows/WSL:
    // wrapper `Child` alive but inner node dead). Otherwise it is still coming up
    // — wait (the `unreachable_respawn_ready` arming keeps us off a normal boot).
    if child_exited || unreachable_respawn_ready {
        if respawns_in_window >= max_respawns {
            return ServeRespawnAction::GiveUp;
        }
        return ServeRespawnAction::Respawn;
    }
    ServeRespawnAction::Healthy
}

/// Pure arming gate for WI-3170's Windows/WSL wrapper blind spot. This computes
/// the `unreachable_respawn_ready` input to `decide_serve_respawn` from the
/// stateful supervisor loop's latches, keeping the cold-boot/double-spawn guard
/// testable without a live WSL VM.
fn serve_unreachable_respawn_ready(
    via_wsl: bool,
    ever_reachable: bool,
    unreachable_elapsed: Option<Duration>,
    debounce: Duration,
) -> bool {
    via_wsl
        && ever_reachable
        && unreachable_elapsed
            .map(|elapsed| elapsed >= debounce)
            .unwrap_or(false)
}

/// WI-3270 (a): probe the operator from INSIDE the WSL distro. On Windows,
/// `operator_http_ready` crosses the Windows→WSL localhost port-forward, which
/// flakes INDEPENDENTLY of operator health (observed live 2026-07-06: operator
/// + PG fully healthy inside the distro while every Windows-side probe of
/// 127.0.0.1:<port> failed). Treating such a flake as operator death made the
/// serve supervisor kill a healthy serve+PG, exhaust both respawn caps, and
/// take the whole distro down — so before declaring death, re-ask from inside.
/// Same acceptance rule as `operator_http_ready`: ANY completed HTTP response
/// proves the event loop is serving (curl exit 0; deliberately no `-f`, a 4xx
/// still proves liveness).
fn operator_http_ready_in_distro(port: u16) -> bool {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("wsl.exe");
        cmd.args([
            "--distribution",
            wsl_setup::DISTRO_NAME_PUB,
            "--exec",
            "curl",
            "-s",
            "-o",
            "/dev/null",
            "-m",
            "2",
            &format!("http://127.0.0.1:{}/api/health", port),
        ]);
        no_console_window(&mut cmd);
        cmd.status().map(|s| s.success()).unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = port;
        false
    }
}

/// WI-3270 (c): the Server SHELL's liveness beacon. The watcher's
/// `launch_bundle` can NEVER revive an operator while the Server shell is
/// still alive — single-instance dedupes the launch into a guaranteed no-op —
/// yet `decide_server_supervision` keyed only on the OPERATOR pid, so every
/// such no-op burned a respawn-cap slot until the watcher gave up (observed
/// live on the Windows VM; macOS `open -b` has the same burn). The Server's
/// serve supervisor refreshes this file every tick; a FRESH heartbeat tells
/// the watcher "shell alive — defer to its in-process serve supervisor"
/// instead of launching.
const SERVER_SHELL_HEARTBEAT_MAX_AGE: Duration = Duration::from_secs(10);

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct ServerShellHeartbeat {
    pid: u32,
    ts: u64,
}

fn server_shell_heartbeat_path(workspace_home: &std::path::Path) -> std::path::PathBuf {
    workspace_home.join(".papercusp/server-shell-heartbeat.json")
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Written by the Server's serve supervisor each tick (~1.5s). Best-effort: a
/// failed write only degrades the watcher back to the old (cap-burning)
/// behavior — it must never take the supervisor down.
fn write_server_shell_heartbeat(workspace_home: &std::path::Path) {
    let path = server_shell_heartbeat_path(workspace_home);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let hb = ServerShellHeartbeat {
        pid: std::process::id(),
        ts: unix_now_secs(),
    };
    if let Ok(body) = serde_json::to_string(&hb) {
        let _ = std::fs::write(&path, body);
    }
}

/// Pure freshness rule (unit-tested): a heartbeat no older than the max age
/// proves the shell alive. Clock skew that puts `ts` in the future still
/// counts as fresh (saturating); a stale or missing one does not.
fn shell_heartbeat_fresh(ts: u64, now: u64, max_age: Duration) -> bool {
    now.saturating_sub(ts) <= max_age.as_secs()
}

/// Watcher read side: does a fresh heartbeat say the Server shell is up?
fn server_shell_alive(workspace_home: &std::path::Path) -> bool {
    let Ok(body) = std::fs::read_to_string(server_shell_heartbeat_path(workspace_home)) else {
        return false;
    };
    let Ok(hb) = serde_json::from_str::<ServerShellHeartbeat>(&body) else {
        return false;
    };
    shell_heartbeat_fresh(hb.ts, unix_now_secs(), SERVER_SHELL_HEARTBEAT_MAX_AGE)
}

#[cfg(target_os = "macos")]
fn server_launchdaemon_installed() -> bool {
    std::path::Path::new("/Library/LaunchDaemons/com.papercusp.server.plist").is_file()
}

#[cfg(not(target_os = "macos"))]
fn server_launchdaemon_installed() -> bool {
    false
}

/// Build the one successful-attach signal shared by initial boot, fallback,
/// delayed boot recovery, and dynamic-port watcher recovery. The explicit
/// restored latch makes a successful attach win over diagnostic retry loops
/// that were already in flight when the operator became reachable.
fn operator_attach_inject(base: &str, app_base: &str) -> String {
    format!(
        "window.__papercuspBase = '{base}'; window.__papercuspAppBase = '{app_base}'; window.__PAPERCUSP_TAURI__ = {{ kind: 'native' }}; window.__papercuspServerConnectionRestored = true; delete window.__papercuspServerConnectionRequired; delete window.__papercuspBootError; window.dispatchEvent(new CustomEvent('papercusp:base')); window.dispatchEvent(new CustomEvent('papercusp:server-connection-restored'));"
    )
}

/// Point the main window at the operator on `port`: compute the app origin
/// (the custom-protocol origin when it's on — Linux default; otherwise the HTTP
/// loopback base), navigate-or-reload the webview there, and (re-)inject
/// window.__papercuspBase so the SPA/bootstrap dials the right operator.
/// `reinject_ticks` re-evals the base injection every 300ms so a page (re)load
/// racing this thread still receives the port. Shared by the initial attach
/// (finish_boot) AND the operator watcher (WI-1869) so both stay in lockstep.
fn point_window_at_operator<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    port: u16,
    reinject_ticks: u32,
) {
    // Use 127.0.0.1, not localhost: WebKitGTK may resolve `localhost` to ::1
    // while the sidecar binds IPv4 loopback, which fails the bootstrap fetch.
    let base = format!("http://127.0.0.1:{}", port);
    // With the custom protocol on (Linux default) the SPA loads off the
    // `papercusp://localhost` origin; with it off (macOS/Windows) it's the HTTP
    // base — which on those platforms embeds the dynamic port, so a restart's
    // new port means a genuinely different app origin to navigate to.
    let app_base = if custom_protocol::enabled() {
        custom_protocol::APP_ORIGIN.to_string()
    } else {
        base.clone()
    };
    // __PAPERCUSP_TAURI__ tells PiPanel to use the native pty path. The page may
    // (re)load around this thread's timing, dropping __papercuspBase, so re-eval
    // on a short timer — web/index.html's tick() polls it, so a late set lands.
    //
    // ⚠ That re-eval is a BOUNDED BURST, not a guarantee of convergence: the loop
    // below runs `reinject_ticks` times 300ms apart (callers pass 10 or 30 => a
    // 3-9s window) and NOTHING re-injects afterwards, so once that window closes
    // nothing ever sets these globals again. (There IS an on_page_load handler —
    // main.rs:7521, on PageLoadEvent::Started — but it only flushes IPC callbacks
    // and retargets /api via env_switch::retarget_for_url; it does not touch these
    // three. It is, however, exactly where a re-inject would belong.)
    // MEASURED 2026-08-03 (WI-7982), three normal `npm run tauri dev` webviews:
    // all three globals null in every one, while __TAURI_INTERNALS__.invoke was
    // still a function — two instances ~27min into their life AND one only ~30s
    // after a rebuild-restart, i.e. already past the burst. So in a dev shell the
    // steady state is ABSENT, and the burst evidently does not survive (or never
    // lands on) the Vite SPA's document commit. WHICH of those two it is has NOT
    // been determined — the burst races the page load with no readback, so
    // deciding it needs a log line here plus one in the SPA. Do not assume.
    // This is EXPECTED, not a bug: it is exactly why every live consumer treats
    // these as OPTIONAL OVERRIDES rather than requirements:
    // pty-tauri.ts:43-49 keys native-detection off __TAURI_INTERNALS__ and only
    // REJECTS on an explicitly non-native __PAPERCUSP_TAURI__ (a requirement there
    // made the wizard's buttons vanish after a reload — found live on Windows
    // 2026-06-11), and PiPanel.tsx:72 is likewise a set-only branch.
    // ⚠ Also note web/index.html's tick() is the PRODUCTION bootstrap only ("Dev:
    // the webview loads devUrl directly — this page isn't used", index.html:46),
    // so in dev nothing polls for a late set at all.
    // => If you add a consumer, make absence INERT. Do not "fix" this by requiring
    //    the global; if a future consumer genuinely needs it post-reload, add the
    //    re-inject to the EXISTING on_page_load handler (main.rs:7521) rather than
    //    widening this burst. (WI-7982)
    let inject = operator_attach_inject(&base, &app_base);
    // Already on the app origin (custom-protocol statics session) → reload so
    // the SPA boots fresh against the live operator instead of sitting on dead
    // 503'd /api fetches; anywhere else (custom protocol off, or a stale HTTP
    // port after a restart) → navigate to the current origin.
    let already_on_app = window
        .url()
        .ok()
        .map(|u| u.as_str().starts_with(&app_base))
        .unwrap_or(false);
    if already_on_app {
        let _ = window.eval("location.reload()");
    } else {
        match app_base.parse() {
            Ok(parsed) => {
                if let Err(e) = window.navigate(parsed) {
                    eprintln!("[papercusp-desktop] navigate to {} failed: {}", app_base, e);
                }
            }
            Err(e) => eprintln!(
                "[papercusp-desktop] app base {} did not parse: {}",
                app_base, e
            ),
        }
    }
    for _ in 0..reinject_ticks {
        let _ = window.eval(&inject);
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}

/// Payload for the `operator-dead` webview event (WI-1878 / critical-process-
/// supervisor-2026-07-04 P-005). Emitted once per operator-dead EPISODE: since
/// WI-3270 made give-up recoverable (respawns resume when the cap window
/// drains), GiveUp can recur across retry cycles — the callers gate this
/// notify on a once-per-episode flag that resets on recovery, so it still
/// never floods the webview. `reason` distinguishes which supervisor gave up,
/// since the two watchers cover different roles (GUI-side Server-bundle
/// respawn vs. the Server's own in-process serve.mjs child respawn).
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone, specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "operator-dead")]
pub struct OperatorDeadPayload {
    reason: String,
    respawns: usize,
    window_secs: u64,
}

/// Pure text builder for the `operator-dead` OS notification body — split out
/// from `notify_operator_dead` so it's unit-testable without a live
/// `AppHandle` (same Linux-CI-testability rationale as `decide_server_supervision`
/// / `decide_serve_respawn`: the side-effecting emit/notification calls can't
/// run in CI, but the content they build can be verified).
fn operator_dead_notification_body(reason: &str, respawns: usize, window_secs: u64) -> String {
    format!(
        "Auto-restart backing off after {respawns} failed attempts in {window_secs}s ({reason}). \
         Retries continue in the background; restart the app to recover immediately."
    )
}

/// WI-1878 / P-005: surface a LOUD "operator dead" state once auto-respawn
/// gives up — the part of WI-1878's ask ("at minimum surface a loud
/// 'operator dead' state") that the WI-2667 respawn/backoff/give-up machinery
/// didn't yet cover (it only logged to stderr, invisible to a GUI user with
/// no terminal). Emits a webview event (for an in-app persistent banner) AND
/// raises a native OS notification, so the user finds out even if the window
/// is backgrounded/minimized. Best-effort: a notification failure is logged,
/// never fatal — the app is already in a degraded state, we must not panic
/// trying to report it.
fn notify_operator_dead(
    app_handle: &tauri::AppHandle,
    reason: &str,
    respawns: usize,
    window_secs: u64,
) {
    let _ = OperatorDeadPayload {
        reason: reason.to_string(),
        respawns,
        window_secs,
    }
    .emit(app_handle);
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app_handle
        .notification()
        .builder()
        .title("Papercusp operator stopped responding")
        .body(operator_dead_notification_body(
            reason,
            respawns,
            window_secs,
        ))
        .show()
    {
        eprintln!("[papercusp-desktop] operator-dead notification failed: {e}");
    }
}

/// WI-5390: surface a broken/partial install as a distinct TERMINAL state, on
/// the same two channels as `notify_operator_dead` (in-app event for a banner +
/// an OS notification for a backgrounded window). Deliberately a separate event
/// name and wording from `operator-dead`: "stopped responding / retrying" invites
/// the user to wait, and waiting can never help here — the actionable fact is
/// "reinstall". Best-effort; a failed notification is logged, never fatal.
fn notify_install_broken(app_handle: &tauri::AppHandle, message: &str) {
    let _ = app_handle.emit("install-broken", message.to_string());
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app_handle
        .notification()
        .builder()
        .title("Papercusp installation is incomplete")
        .body(message)
        .show()
    {
        eprintln!("[papercusp-desktop] install-broken notification failed: {e}");
    }
}

/// WI-1869: follow the operator across restarts. finish_boot reads operator.json
/// exactly once at attach; on macOS/Windows the operator takes a NEW dynamic
/// port on every Server restart / sidecar crash-respawn, so a one-shot discovery
/// strands the webview on the dead port forever (macOS has no load-failure
/// recovery at all, and the Linux EI-239 recovery only polls the same dead URI,
/// which never returns after a port change). This polls operator.json ~every
/// 1.5s and, when it names a LIVE operator on a different port than the one the
/// webview is on, re-navigates there — the cross-platform generalization of
/// EI-239 to dynamic-port moves. Runs for the life of the app on a daemon thread.
fn spawn_operator_watcher(
    app_handle: tauri::AppHandle,
    workspace_home: std::path::PathBuf,
    via_wsl: bool,
    initial_port: u16,
) {
    // WI-2667 respawn tuning. Tick is 1.5s, so:
    //   * ~15s of continuous unreachability before a respawn (tolerates a normal
    //     restart whose pid briefly rolls over — and single-instance makes a
    //     spurious `open -b` a no-op anyway);
    //   * a fresh Server gets 30s to boot before we count it dead again;
    //   * ≤5 respawns per 5-min window, else latch off (a Server that truly
    //     cannot boot must not hot-loop `open -b`).
    const DEAD_THRESHOLD_TICKS: u32 = 10;
    const POST_RESPAWN_GRACE: Duration = Duration::from_secs(30);
    const RESPAWN_WINDOW: Duration = Duration::from_secs(300);
    const MAX_RESPAWNS_PER_WINDOW: usize = 5;

    std::thread::spawn(move || {
        let mut applied_port = initial_port;
        // WI-2667 supervision state.
        let mut consecutive_dead: u32 = 0;
        let mut grace_until: Option<Instant> = None;
        let mut respawn_times: Vec<Instant> = Vec::new();
        let mut gave_up = false;
        // Defer-to-supervisor logging (once per streak) and the operator-dead
        // notification (once per dead episode — give-up can now recur across
        // retry cycles, the user shouldn't be re-notified every ~5 minutes).
        let mut deferred_to_launchdaemon = false;
        let mut deferred_to_shell = false;
        let mut dead_notified = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let latest = find_operator_discovery(&workspace_home, via_wsl);

            // --- WI-1869: follow the operator's port across restarts (unchanged) ---
            if let Some(new_port) = next_operator_port(applied_port, latest.as_ref()) {
                // Guard against a STALE operator.json whose port was reused by an
                // unrelated process: only follow a discovery whose pid is alive.
                // WI-3282: pid-alive alone is NOT enough — a just-respawned operator
                // can write operator.json the instant it starts listening, before its
                // event loop is actually servicing requests (the exact WI-2902 starved
                // -boot window `wait_for_operator` already guards on initial boot via
                // operator_http_ready). Without the same bar here, a crash-respawn
                // mid-session could re-navigate the webview to a port that then hangs
                // every request for the ~20-50s starved window — indistinguishable from
                // the original "stuck onboarding" bug, just triggered by a later restart
                // instead of first boot. Require BOTH signals, exactly like the boot path.
                let pid_alive = latest
                    .as_ref()
                    .map(|d| discovery_pid_alive(d.pid, via_wsl))
                    .unwrap_or(false);
                if pid_alive && operator_http_ready(new_port) {
                    println!(
                        "[papercusp-desktop] operator moved :{} -> :{} — re-navigating the webview (WI-1869)",
                        applied_port, new_port
                    );
                    if let Some(window) = app_handle.get_webview_window("main") {
                        point_window_at_operator(&window, new_port, 10);
                        {
                            let state: tauri::State<SidecarState> = app_handle.state();
                            *state.port.lock().unwrap() = Some(new_port);
                        }
                        applied_port = new_port;
                    }
                }
            }

            // --- WI-2667: detect a DEAD Server and respawn it ---
            // `open -b` can only revive an EXITED Server (single-instance dedupes
            // a launch while it's alive), so the trigger is pid-liveness, which is
            // precisely the post-force-exit world (SIGTERM → force-exit → pid gone
            // → respawn → launchd-free crash recovery for the desktop GUI case).
            let now = Instant::now();
            let in_boot_grace = grace_until.map(|u| now < u).unwrap_or(false);
            let process_alive = latest
                .as_ref()
                .map(|d| discovery_pid_alive(d.pid, via_wsl))
                .unwrap_or(false);
            // Only count a tick as "dead" when it is dead AND we're not inside a
            // post-respawn boot grace (so a booting Server isn't double-respawned).
            let dead_count = if !process_alive && !in_boot_grace {
                consecutive_dead + 1
            } else {
                consecutive_dead
            };
            respawn_times.retain(|t| now.duration_since(*t) < RESPAWN_WINDOW);
            // An installed system LaunchDaemon owns the Server bundle lifecycle
            // even while its plist is temporarily booted out for a payload swap.
            let launchdaemon_installed = server_launchdaemon_installed();
            // WI-3270 (c): a fresh Server-shell heartbeat means a bundle launch
            // can only single-instance no-op — read it before deciding.
            let shell_alive = server_shell_alive(&workspace_home);
            match decide_server_supervision(
                process_alive,
                launchdaemon_installed,
                shell_alive,
                in_boot_grace,
                dead_count,
                DEAD_THRESHOLD_TICKS,
                respawn_times.len(),
                MAX_RESPAWNS_PER_WINDOW,
                gave_up,
            ) {
                ServerSupervisionAction::Healthy => {
                    consecutive_dead = 0;
                    deferred_to_launchdaemon = false;
                    deferred_to_shell = false;
                    dead_notified = false;
                    if gave_up {
                        eprintln!(
                            "[papercusp-desktop] Papercusp Server is back after a respawn give-up — \
                             re-arming auto-respawn (WI-3270)"
                        );
                        gave_up = false;
                    }
                }
                ServerSupervisionAction::Wait => {
                    consecutive_dead = dead_count;
                    deferred_to_launchdaemon = false;
                    deferred_to_shell = false;
                }
                ServerSupervisionAction::DeferToLaunchDaemon => {
                    consecutive_dead = dead_count;
                    deferred_to_shell = false;
                    if !deferred_to_launchdaemon {
                        eprintln!(
                            "[papercusp-desktop] system/com.papercusp.server.plist is installed; \
                             deferring Server bundle launches to launchd, including during a \
                             temporary bootout for a payload swap"
                        );
                        deferred_to_launchdaemon = true;
                    }
                }
                ServerSupervisionAction::DeferToShell => {
                    consecutive_dead = dead_count;
                    deferred_to_launchdaemon = false;
                    if !deferred_to_shell {
                        eprintln!(
                            "[papercusp-desktop] operator process dead but the Papercusp Server \
                             shell is alive (fresh heartbeat) — a bundle launch would \
                             single-instance no-op, deferring to the Server's own serve supervisor \
                             instead of burning respawn attempts (WI-3270)"
                        );
                        deferred_to_shell = true;
                    }
                }
                ServerSupervisionAction::Respawn => {
                    if gave_up {
                        eprintln!(
                            "[papercusp-desktop] respawn window drained — retrying the Server \
                             respawn after an earlier give-up (WI-3270)"
                        );
                        gave_up = false;
                    }
                    deferred_to_shell = false;
                    deferred_to_launchdaemon = false;
                    // Every platform ships the Server as an independently-installed
                    // sibling product. Re-launch that bundle by identity; the
                    // Server's own in-process supervisor remains responsible for a
                    // serve.mjs child that dies while its shell stays alive.
                    eprintln!(
                        "[papercusp-desktop] Papercusp Server unreachable ~{}s — respawning the Server bundle (WI-2667)",
                        (dead_count as u64) * 1500 / 1000
                    );
                    if let Err(e) = launch_bundle(SERVER_BUNDLE_ID, "Papercusp Server") {
                        eprintln!("[papercusp-desktop] Server respawn failed: {e}");
                    }
                    respawn_times.push(now);
                    consecutive_dead = 0;
                    grace_until = Some(now + POST_RESPAWN_GRACE);
                }
                ServerSupervisionAction::GiveUp => {
                    deferred_to_shell = false;
                    deferred_to_launchdaemon = false;
                    eprintln!(
                        "[papercusp-desktop] Papercusp Server respawn cap hit ({} in {}s) — the Server \
                         keeps dying; backing off until the respawn window drains (WI-2667 / WI-3270)",
                        MAX_RESPAWNS_PER_WINDOW,
                        RESPAWN_WINDOW.as_secs()
                    );
                    if !dead_notified {
                        notify_operator_dead(
                            &app_handle,
                            "Server bundle respawn cap hit",
                            MAX_RESPAWNS_PER_WINDOW,
                            RESPAWN_WINDOW.as_secs(),
                        );
                        dead_notified = true;
                    }
                    gave_up = true;
                }
            }
        }
    });
}

/// WI-3282 fix direction 1: does a process cmdline look like OUR serve
/// process (`serve.mjs` / `serve.ts`), not some unrelated process that
/// happens to have been assigned a recycled pid? Mirrors serve.ts's own
/// `acquireColdStartLock` `ownerIsServe` guard (apps/operator/bin/serve.ts) —
/// a bare "does /proc/<pid> exist" check is defeated by pid reuse, which is
/// near-certain after enough process churn (this desktop already hit the
/// identical class on the WSL cold-start lock, per that function's docs).
/// Pure + unit-tested. The general liveness watcher may fail open when a
/// cmdline read is flaky so it does not tear down a healthy connection; the
/// destructive orphan sweep has a separate fail-CLOSED authority check.
fn cmdline_looks_like_operator(cmdline: &str) -> bool {
    let lower = cmdline.to_ascii_lowercase();
    // `serve` is the SUPERVISOR (embedded PG, migrations) …
    lower.contains("serve.mjs")
        || lower.contains("serve.ts")
        // … and `hono-host` is the HTTP/IPC host it then runs. Both are "our
        // operator" for liveness purposes, and the host is the one that
        // actually writes the endpoint-ipc advertisement and owns the socket.
        //
        // Omitting the host was a silent, total false-negative (WI-6512):
        // measured 2026-07-28, 9 of 9 live operators on this box failed this
        // check — release/staging run `node …/dist-host/hono-host.mjs`, dev runs
        // `node --require tsx/preflight.cjs --import tsx/loader.mjs
        // bin/hono-host.ts` — so `discovery_pid_alive` reported EVERY live
        // operator as dead. Downstream that meant `/api` could never dial IPC
        // (it read every advertisement as a restart orphan) and the respawn /
        // orphan-sweep call sites were reasoning about live operators as dead.
        || lower.contains("hono-host.mjs")
        || lower.contains("hono-host.ts")
}

/// Session roots are never valid cleanup targets, even if a copied record is
/// accidentally paired with their current pid. This is defense in depth
/// behind the stricter serve-role + process-birth checks below.
fn cmdline_is_protected_session_process(cmdline: &str) -> bool {
    let lower = cmdline.to_ascii_lowercase();
    [
        "systemd --user",
        "gnome-shell",
        "gdm-session-worker",
        "plasmashell",
        "loginwindow",
        "windowserver",
        "/launchd",
        " launchd",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// Linux `/proc/<pid>/stat` field 22 (starttime), paired with the kernel boot
/// id. Parsing starts after the LAST ')' because comm may contain spaces or
/// parentheses. This format is shared with operator-core's process-identity.ts.
fn linux_process_identity_from_stat(boot_id: &str, stat: &str) -> Option<String> {
    let close = stat.rfind(')')?;
    let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    // Text after comm begins at field 3 (state); starttime is field 22 => 19.
    let start_ticks = fields.get(19)?;
    if start_ticks.is_empty() || !start_ticks.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let boot_id = boot_id.trim();
    if boot_id.is_empty() {
        return None;
    }
    Some(format!("linux:{boot_id}:{start_ticks}"))
}

/// Current kernel-backed identity for a local process. Any read/parse failure
/// is `None`; destructive callers fail closed on that result.
fn local_process_identity(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        linux_process_identity_from_stat(&boot_id, &stat)
    }
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("ps")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .output()
            .ok()?
            .stdout;
        let started = String::from_utf8_lossy(&output)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        (!started.is_empty()).then(|| format!("darwin:{started}"))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

/// A discovery record grants kill authority only when it names the same
/// kernel process incarnation and that process is still exactly a serve role.
/// Legacy/missing fields, unreadable proc state, protected session roots, and
/// copied/recycled PIDs all refuse the operation.
fn recorded_operator_kill_authority(discovery: &OperatorDiscovery, via_wsl: bool) -> bool {
    // The Windows path never sends POSIX signals from this sweep. Keeping WSL
    // records non-authoritative avoids inventing a second remote kill surface.
    if via_wsl {
        return false;
    }
    let Some(expected) = discovery.process_identity.as_deref() else {
        return false;
    };
    if local_process_identity(discovery.pid).as_deref() != Some(expected) {
        return false;
    }
    let Some(cmdline) = local_process_cmdline(discovery.pid) else {
        return false;
    };
    cmdline_looks_like_operator(&cmdline) && !cmdline_is_protected_session_process(&cmdline)
}

/// Best-effort cmdline read for a LOCAL (non-WSL) pid: `/proc/<pid>/cmdline`
/// on Linux (NUL-separated argv, joined with spaces so the substring check
/// above matches regardless of arg boundaries), `ps` elsewhere. `None` when
/// unreadable (process gone mid-read, permission denied, non-Linux `ps`
/// failure) — callers must treat that as "unknown", not "not serve".
fn local_process_cmdline(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string(format!("/proc/{}/cmdline", pid))
            .ok()
            .map(|s| s.replace('\0', " "))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Command::new("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
    }
}

/// Liveness probe for a discovery-file pid (signal-0 equivalent: /proc on
/// Linux, `kill -0` elsewhere), STRENGTHENED (WI-3282) with a cmdline check
/// so a stale operator.json's pid can't false-positive after the OS recycles
/// it onto an unrelated process — the same class of bug serve.ts's
/// `acquireColdStartLock` already guards against on the lock file. Only
/// tightens the answer (alive-but-not-serve → false); when the cmdline can't
/// be read at all, falls back to the bare pid-alive answer so a flaky
/// WSL UNC read (documented on `read_operator_discovery_via_wsl`) can't
/// wrongly declare a genuinely-live operator dead.
///
/// `via_wsl`: the pid is a LINUX pid inside the papercup-runtime distro —
/// probe its /proc entry through wsl.exe (`kill` doesn't exist on Windows,
/// and a Windows pid check would be meaningless for it).
fn discovery_pid_alive(pid: u32, via_wsl: bool) -> bool {
    if !discovery_pid_exists(pid, via_wsl) {
        return false;
    }
    if via_wsl {
        #[cfg(target_os = "windows")]
        {
            // Best-effort cmdline check via the same wsl.exe route; a failed
            // read (UNC flakiness, distro busy) falls back to "alive" per the
            // fail-open contract above.
            let mut cat_cmd = Command::new("wsl.exe");
            cat_cmd.args([
                "--distribution",
                wsl_setup::DISTRO_NAME_PUB,
                "-e",
                "cat",
                &format!("/proc/{}/cmdline", pid),
            ]);
            no_console_window(&mut cat_cmd);
            return match cat_cmd.output() {
                Ok(out) if out.status.success() => cmdline_looks_like_operator(
                    &String::from_utf8_lossy(&out.stdout).replace('\0', " "),
                ),
                _ => true,
            };
        }
    }
    match local_process_cmdline(pid) {
        Some(cmdline) => cmdline_looks_like_operator(&cmdline),
        None => true, // couldn't read (raced exit, perms) — fail open
    }
}

/// Does a process with this pid exist AT ALL — signal-0 equivalent, with **no
/// cmdline heuristic**.
///
/// Split out from `discovery_pid_alive` because the two questions have
/// opposite failure costs, and conflating them cost WI-6512 two months.
/// "Is it still OUR operator?" is a guard against a RECYCLED pid, and a wrong
/// answer there is cheap. "Does the pid exist?" gates whether `/api` will dial
/// IPC at all, and a wrong answer there is catastrophic AND silent: an
/// unanticipated entrypoint name makes every live operator read as dead, so
/// IPC never connects, every stream falls back to the webview's ~6-socket HTTP
/// pool, and the only symptom is that the app feels slow.
///
/// So the endpoint-ipc advertisement path uses THIS — a name-free check that
/// can never false-negative on a live process. It still fully preserves the
/// measured fix that motivated the validation (EI-18763945004822208), whose
/// failure mode was a restart orphan naming a pid that no longer EXISTS.
/// A recycled pid slips past, and that is a deliberate trade: the cost is one
/// cheap failed connect, which `IpcClientHandle::live` reports precisely and
/// retries — versus a silent, permanent loss of the transport.
fn discovery_pid_exists(pid: u32, via_wsl: bool) -> bool {
    if via_wsl {
        #[cfg(target_os = "windows")]
        {
            let mut cmd = Command::new("wsl.exe");
            cmd.args([
                "--distribution",
                wsl_setup::DISTRO_NAME_PUB,
                "-e",
                "test",
                "-d",
                &format!("/proc/{}", pid),
            ]);
            no_console_window(&mut cmd);
            return cmd.status().map(|s| s.success()).unwrap_or(false);
        }
    }
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new(&format!("/proc/{}", pid)).exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// Whether the operator at `port` can actually SERVE requests — not merely
/// ACCEPT a TCP connection.
///
/// WI-2902: on a fresh first boot the operator BINDS its HTTP port ~20s before
/// its event loop stops being starved by the heavy synchronous boot work
/// (embedded-PG seed extract + initdb / post-seed migrations, swarm peer
/// connect). During that window a `TcpStream::connect` succeeds but every HTTP
/// request HANGS. Declaring the operator "ready" on mere TCP-connectability made
/// `finish_boot` set `SidecarState.port` (which flips the `papercusp://` scheme
/// handler from serving the bundled SPA off DISK to FORWARDING every asset/route
/// chunk to the still-starving operator) and re-point the webview at it — so the
/// SPA's dynamic-import chunks fetched a server that couldn't answer, and the
/// desktop dead-ended on the fatal "This view hit an error / Importing a module
/// script failed" card (measured live: port bound ~36s, first HTTP response
/// ~46s, fully responsive ~55s).
///
/// A short-timeout HTTP probe returns true only once the event loop is actually
/// servicing requests (ANY completed HTTP response — even a 4xx — proves it; a
/// starved loop times out instead), which my measurements show coincides with
/// reliable static-chunk serving. Until then the window keeps serving the
/// bundled SPA from disk over `papercusp://` (`serve_bundled_spa`), so first
/// boot shows the onboarding UI, never a chunk-load card. Accepting any response
/// (not requiring 200) means a genuinely-up operator can never be falsely held
/// "not ready" into the 120s boot-timeout by a non-2xx health route. The probe
/// dials `127.0.0.1:port` exactly like the old TCP check, so it carries the same
/// loopback/WSL reachability assumptions — no platform regression.
fn operator_http_ready(port: u16) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(2000))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .get(format!("http://127.0.0.1:{}/api/health", port))
        .send()
        .is_ok()
}

/// P-013 (desktop-build-hardening-tri-platform-2026-07-11): the post-update
/// self-check verdict. On launch the GUI asks the operator it attached to for
/// its `/api/health` sha and compares it against THIS build's OWN compile-time
/// sha (`option_env!("PAPERCUSP_BUILD_SHA")` — the on-disk artifact's own
/// identity, the same value `emit-build-provenance.sh` records as `buildSha`,
/// NOT "the latest release"). A mismatch means the running operator is NOT the
/// one this installed build shipped — the EI-9002 silent no-op update, where a
/// stale operator survived (e.g. inside WSL) and was adopted instead of
/// replaced. D-002: keying off the installed build's OWN sha makes this the SAME
/// invariant that both forward-install AND rollback verify against — a
/// deliberate downgrade to tag T PASSES when `/api/health` reports T's sha.
#[derive(Debug, PartialEq, Eq)]
enum UpdateSelfCheck {
    /// Both shas known and equal — the running operator matches this build.
    Match,
    /// Both shas known and different — a stale/foreign operator (EI-9002).
    Mismatch { baked: String, running: String },
    /// One side unknown — a dev build with no baked sha, or `/api/health` gave
    /// no sha (e.g. a Windows→WSL forward flake, WI-3270). We only ASSERT when we
    /// can actually compare, so a missing side never raises a false mismatch.
    Skipped,
}

/// Pure comparison — cargo-testable without a live operator. An empty string is
/// treated as "unknown" (both `option_env!` and a missing JSON field surface as
/// empty here); surrounding whitespace is ignored.
fn evaluate_update_self_check(baked_sha: &str, running_sha: &str) -> UpdateSelfCheck {
    let baked = baked_sha.trim();
    let running = running_sha.trim();
    if baked.is_empty() || running.is_empty() {
        return UpdateSelfCheck::Skipped;
    }
    if baked == running {
        UpdateSelfCheck::Match
    } else {
        UpdateSelfCheck::Mismatch {
            baked: baked.to_string(),
            running: running.to_string(),
        }
    }
}

/// Fetch the operator's self-reported build sha from `/api/health` (best-effort;
/// None on any transport/parse failure — the self-check then Skips rather than
/// false-alarming). Mirrors `operator_http_ready`'s short-timeout blocking client.
fn fetch_operator_health_sha(port: u16) -> Option<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(2000))
        .build()
        .ok()?;
    let body = client
        .get(format!("http://127.0.0.1:{}/api/health", port))
        .send()
        .ok()?
        .text()
        .ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    v.get("sha")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// The static release host this build's operator polls for updates
/// (plan desktop-release-hosting-r2-2026-07-12; WI-4389/WI-3875).
///
/// Precedence: a RUNTIME `PAPERCUSP_RELEASE_HOST` wins (so a test build can be
/// aimed at a staging host with no recompile), else the COMPILE-TIME bake that
/// release-local.sh exports. Empty string when neither is set — the operator
/// treats that as "no release host" and falls back to the legacy GitHub
/// discovery path, which is exactly today's behavior, so an un-baked dev build
/// is unaffected.
fn baked_release_host() -> String {
    std::env::var("PAPERCUSP_RELEASE_HOST")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| {
            option_env!("PAPERCUSP_RELEASE_HOST")
                .unwrap_or("")
                .to_string()
        })
}

/// P-013: run the post-update self-check and, on a genuine mismatch, surface it
/// to the SPA (a `papercusp:update-mismatch` event + `window.__papercuspUpdateMismatch`)
/// and the console. Match/Skipped just log. Best-effort and non-fatal — a health
/// hiccup must never block boot, so callers run this OFF the finish_boot thread.
fn run_update_self_check<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, port: u16) {
    let baked = option_env!("PAPERCUSP_BUILD_SHA").unwrap_or("");
    let running = fetch_operator_health_sha(port).unwrap_or_default();
    match evaluate_update_self_check(baked, &running) {
        UpdateSelfCheck::Match => {
            println!(
                "[papercusp-desktop] post-update self-check: OK (operator sha {} matches this build)",
                running
            );
        }
        UpdateSelfCheck::Skipped => {
            println!(
                "[papercusp-desktop] post-update self-check: skipped (baked='{}' running='{}')",
                baked, running
            );
        }
        UpdateSelfCheck::Mismatch { baked, running } => {
            eprintln!(
                "[papercusp-desktop] post-update self-check MISMATCH: this build is {} but the running operator reports {} — the update did not replace the running operator (EI-9002). The app is talking to a STALE operator; restarting Papercusp Server is needed.",
                baked, running
            );
            let payload = serde_json::json!({ "expected": baked, "running": running });
            let inject = format!(
                "window.__papercuspUpdateMismatch = {}; window.dispatchEvent(new CustomEvent('papercusp:update-mismatch', {{ detail: window.__papercuspUpdateMismatch }}));",
                serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())
            );
            // Re-eval for a bit — the SPA may still be mid-handoff when this fires
            // (same rationale as the boot-error inject in finish_boot).
            for _ in 0..20 {
                let _ = window.eval(&inject);
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
}

#[cfg(test)]
mod post_update_self_check_tests {
    use super::{evaluate_update_self_check, UpdateSelfCheck};

    #[test]
    fn matching_shas_pass() {
        assert_eq!(
            evaluate_update_self_check("3cfe4e2-2537dc8", "3cfe4e2-2537dc8"),
            UpdateSelfCheck::Match
        );
    }

    #[test]
    fn differing_shas_are_a_mismatch_carrying_both() {
        // EI-9002: this build is new, the adopted operator is stale.
        assert_eq!(
            evaluate_update_self_check("newbuild-abc", "staleop-xyz"),
            UpdateSelfCheck::Mismatch {
                baked: "newbuild-abc".to_string(),
                running: "staleop-xyz".to_string(),
            }
        );
    }

    #[test]
    fn dev_build_with_no_baked_sha_skips() {
        // option_env!("PAPERCUSP_BUILD_SHA") is unset in a dev build → empty →
        // never a false mismatch alarm.
        assert_eq!(
            evaluate_update_self_check("", "3cfe4e2"),
            UpdateSelfCheck::Skipped
        );
    }

    #[test]
    fn unreadable_health_sha_skips() {
        // /api/health gave no sha (e.g. a Windows→WSL forward flake, WI-3270).
        assert_eq!(
            evaluate_update_self_check("3cfe4e2", ""),
            UpdateSelfCheck::Skipped
        );
    }

    #[test]
    fn surrounding_whitespace_is_ignored() {
        assert_eq!(
            evaluate_update_self_check("  3cfe4e2  ", "3cfe4e2\n"),
            UpdateSelfCheck::Match
        );
    }

    #[test]
    fn rollback_to_older_tag_passes_d002() {
        // D-002 non-negotiable acceptance: a deliberate downgrade installs the
        // OLDER build, whose baked sha == the operator it (re)launches → the
        // self-check must PASS, not false-alarm on "not the latest".
        let older = "0.0.6-rollbacksha";
        assert_eq!(
            evaluate_update_self_check(older, older),
            UpdateSelfCheck::Match
        );
    }
}

/// Cold WSL boots can include distro startup, embedded-PG crash recovery, and
/// migration replay. The measured Windows repro took 5m51s, so the WSL path
/// needs a generous hard ceiling instead of the generic 120s desktop budget.
/// This remains a bounded wait: a genuinely dead sidecar still fails fast in
/// `wait_for_operator` and a hung one surfaces after ten minutes.
fn operator_boot_timeout(via_wsl: bool) -> Duration {
    Duration::from_secs(if via_wsl { 600 } else { 120 })
}

/// Poll operator.json until it names a live, reachable operator (pid alive +
/// HTTP-responsive — see `operator_http_ready`, NOT mere TCP-accept), the serve
/// child dies, or the timeout lapses. This is the embedder's whole boot wait:
/// serve owns PG startup + migrations + host boot internally, so first boot
/// (initdb + full migration replay) can legitimately take a while.
///
/// (P-053) Runs on the finish_boot worker thread — NEVER on the Tauri
/// setup/main thread, where this poll used to freeze the unpainted window
/// for up to ten minutes on a cold WSL boot (macOS uses the 120s budget).
fn wait_for_operator(
    app_handle: &tauri::AppHandle,
    workspace_home: &std::path::Path,
    via_wsl: bool,
    timeout: Duration,
) -> Result<OperatorDiscovery, String> {
    // Discovery goes through find_operator_discovery: on Windows the sidecar
    // runs inside WSL and writes operator.json under the distro user's
    // /home/papercup, which the GUI reads via `wsl.exe cat` (the
    // `\\wsl.localhost` UNC share is unreliable — see
    // read_operator_discovery_via_wsl).
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Some(d) = find_operator_discovery(workspace_home, via_wsl) {
            // Readiness = HTTP-responsive, not just TCP-connectable. The port
            // binds ~20s before the starved-event-loop operator can serve its
            // own SPA chunks; gating on TCP-accept re-pointed the webview at a
            // server that then failed every chunk fetch → the fatal card
            // (WI-2902, see operator_http_ready).
            if discovery_pid_alive(d.pid, via_wsl) && operator_http_ready(d.port) {
                return Ok(d);
            }
        }
        // Fail fast when serve died with an error — no point burning the
        // full timeout polling for a discovery file that will never appear.
        // A SUCCESS exit is different: `serve --ensure` exits 0 after
        // reusing an already-running operator (Decision C), so keep polling
        // for that operator's discovery file.
        {
            let state: tauri::State<SidecarState> = app_handle.state();
            let mut guard = state.child.lock().unwrap();
            if let Some(child) = guard.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    if !status.success() {
                        return Err(format!(
                            "the operator process (serve.mjs) exited with {} before becoming \
                             ready — check the serve boot logs above",
                            status
                        ));
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    let discovery_path = if via_wsl {
        "/home/papercup/.papercusp/operator.json".to_string()
    } else {
        native_papercusp_dir(workspace_home)
            .join("operator.json")
            .display()
            .to_string()
    };
    Err(format!(
        "operator did not become ready within {}s (no live operator.json at {}). \
         Embedded-PG initdb/migrations are the usual first-boot suspects — check the serve logs.",
        timeout.as_secs(),
        discovery_path
    ))
}

/// A credential-free HTTPS document is an intentional remote/hosted Server
/// selection made by the thin GUI's connection gate. Local attach workers are
/// allowed to diagnose the bundled/custom-protocol and loopback documents, but
/// they must never paint a late local-Server failure over this remote document.
fn is_remote_server_navigation(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn window_has_remote_server_navigation<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> bool {
    window
        .url()
        .ok()
        .map(|url| is_remote_server_navigation(&url))
        .unwrap_or(false)
}

fn local_attach_diagnostic_guard(inject: &str) -> String {
    format!(
        "if (!(window.location.protocol === 'https:' && !window.location.username && !window.location.password) && !window.__papercuspServerConnectionRestored) {{ {inject} }}"
    )
}

/// Evaluate a local-attach diagnostic only while the current document still
/// belongs to local boot. The Rust URL check stops the bounded retry loop after
/// a remote navigation. The same predicate is repeated inside the evaluated JS
/// so a navigation that commits between `window.url()` and `window.eval()`
/// cannot receive one final stale event from the previous document generation.
fn eval_local_attach_diagnostic<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    inject: &str,
    ticks: u32,
    delay: Duration,
) {
    let guarded_inject = local_attach_diagnostic_guard(inject);
    for _ in 0..ticks {
        if window_has_remote_server_navigation(window) {
            println!(
                "[papercusp-gui] remote HTTPS Server navigation owns the main window — suppressing stale local attach diagnostic"
            );
            return;
        }
        let _ = window.eval(&guarded_inject);
        std::thread::sleep(delay);
    }
}

#[cfg(test)]
mod remote_server_navigation_tests {
    use super::{
        is_remote_server_navigation, local_attach_diagnostic_guard, operator_attach_inject,
    };

    #[test]
    fn successful_operator_attach_clears_and_outlives_stale_diagnostics() {
        let attach = operator_attach_inject("http://127.0.0.1:3170", "papercusp://localhost");
        for required in [
            "window.__papercuspServerConnectionRestored = true",
            "delete window.__papercuspServerConnectionRequired",
            "delete window.__papercuspBootError",
            "papercusp:server-connection-restored",
        ] {
            assert!(
                attach.contains(required),
                "the central attach seam must retain {required:?}"
            );
        }

        let restored = attach
            .find("papercusp:server-connection-restored")
            .expect("the central attach seam emits restoration");
        assert!(
            attach
                .find("delete window.__papercuspServerConnectionRequired")
                .unwrap()
                < restored
                && attach.find("delete window.__papercuspBootError").unwrap() < restored,
            "stale failure globals must be cleared before React handles restoration"
        );

        let guarded = local_attach_diagnostic_guard("emitFailure()");
        assert!(guarded.contains("!window.__papercuspServerConnectionRestored"));
        assert!(guarded.contains("emitFailure()"));
    }

    #[test]
    fn credential_free_https_is_an_intentional_remote_server_navigation() {
        for endpoint in [
            "https://server.example.com/",
            "https://localhost:19443/",
            "https://server.example.com:8443/harness?ws=demo",
        ] {
            let url = url::Url::parse(endpoint).unwrap();
            assert!(
                is_remote_server_navigation(&url),
                "remote Server endpoint should suppress stale local attach work: {endpoint}"
            );
        }
    }

    #[test]
    fn local_boot_and_credentialed_urls_still_receive_the_local_gate() {
        for endpoint in [
            "papercusp://localhost/",
            "http://127.0.0.1:21835/",
            "https://user:secret@server.example.com/",
            "file:///tmp/index.html",
        ] {
            let url = url::Url::parse(endpoint).unwrap();
            assert!(
                !is_remote_server_navigation(&url),
                "non-remote boot URL must not suppress the local Server gate: {endpoint}"
            );
        }
    }
}

/// Keep a timed-out first boot recoverable on every desktop target.
///
/// install_load_failure_recovery is a WebKitGTK signal hook and therefore
/// only exists on Linux. macOS/WKWebView and Windows/WebView2 can strand the
/// initial document when the operator misses the short GUI boot budget: their
/// native error pages do not run the bundled retry HTML, and the normal
/// cross-platform operator watcher is only started after a successful boot.
/// Continue watching the workspace discovery file from Rust instead. Once a
/// live HTTP operator appears, the existing navigation/injection path can
/// recover even when the webview's first navigation failed completely.
///
/// This is deliberately a separate watcher from spawn_operator_watcher:
/// the latter owns an already-attached operator and follows later dynamic-port
/// moves, while this one owns only the pre-attach gap. It exits as soon as the
/// window closes or the first live operator is attached.
fn spawn_boot_recovery_watcher(
    app_handle: tauri::AppHandle,
    workspace_home: std::path::PathBuf,
    via_wsl: bool,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1500));

        let Some(window) = app_handle.get_webview_window("main") else {
            println!(
                "[papercusp-desktop] initial-load recovery watcher stopping — main window closed"
            );
            return;
        };

        // EI-21230348495664772: the user may have deliberately selected a
        // hosted/remote Server while this local discovery worker was sleeping.
        // That navigation owns the window now; a later local operator must not
        // silently pull it back to loopback.
        if window_has_remote_server_navigation(&window) {
            println!(
                "[papercusp-gui] initial-load recovery stopping — main window intentionally navigated to a remote HTTPS Server"
            );
            return;
        }

        let Some(discovery) = find_operator_discovery(&workspace_home, via_wsl) else {
            continue;
        };
        if !discovery_pid_alive(discovery.pid, via_wsl) || !operator_http_ready(discovery.port) {
            continue;
        }

        let port = discovery.port;
        println!(
            "[papercusp-desktop] initial-load recovery found operator :{} — re-navigating the webview",
            port
        );
        point_window_at_operator(&window, port, 30);
        restore_window_visibility(&window, "initial-load-recovery");
        {
            let state: tauri::State<SidecarState> = app_handle.state();
            *state.port.lock().unwrap() = Some(port);
        }

        // The normal watcher owns the post-attach dynamic-port lifecycle.
        spawn_operator_watcher(app_handle.clone(), workspace_home.clone(), via_wsl, port);
        let window_sc = window.clone();
        std::thread::spawn(move || run_update_self_check(&window_sc, port));
        return;
    });
}

/// Register before exposing the GUI, without waiting for the Server. WI-37771
/// protected finish_boot's early returns; P-007 also observed unmanaged state
/// while gui_setup's worker had not reached finish_boot yet. Reuse this handle
/// when finish_boot runs so it cannot replace state or start a second supervisor.
fn register_packaged_endpoint_ipc(
    app_handle: tauri::AppHandle,
    workspace_home: std::path::PathBuf,
    via_wsl: bool,
) {
    if app_handle
        .try_state::<std::sync::Arc<endpoint_ipc::IpcClientHandle>>()
        .is_some()
    {
        return;
    }
    let ipc_enabled = std::env::var("PAPERCUSP_DESKTOP_IPC").ok().as_deref() != Some("0");
    if ipc_enabled {
        // WI-3395: on Windows the sidecar runs in WSL2 and writes
        // endpoint-ipc.json to its WSL-native ~/.papercusp — a DIFFERENT
        // filesystem from `workspace_home`. `find_endpoint_ipc_socket` reads it
        // from inside the distro when routed via WSL (else the local path), so
        // the client actually finds the `tcp://` endpoint instead of stranding
        // /api on the capped HTTP fallback.
        let disc_home = workspace_home.clone();
        let handle = endpoint_ipc::IpcClientHandle::new(move || {
            // GUI registration precedes cold-install WSL onboarding. The boot
            // worker publishes the upgraded route; reconnects must read it.
            #[cfg(target_os = "windows")]
            let via_wsl = via_wsl || wsl_setup::detect_ready_cached();
            find_endpoint_ipc_socket_resolved(&disc_home, via_wsl)
        });
        if !app_handle.manage(handle.clone()) {
            return;
        }
        let ipc_app_handle = app_handle.clone();
        let warm_home = workspace_home.clone();
        // Record the socket in SidecarState on the FIRST successful connect,
        // then hand off to the permanent supervisor (`keep_warm`), which keeps
        // dialing for the life of the process instead of giving up at 60s.
        tauri::async_runtime::spawn(async move {
            let probe = Duration::from_millis(500);
            loop {
                if handle.warm().await.is_ok() {
                    println!("[papercusp-desktop] endpoint-ipc client connected (discovery file)");
                    #[cfg(target_os = "windows")]
                    let via_wsl = via_wsl || wsl_setup::detect_ready_cached();
                    if let Some(path) = find_endpoint_ipc_socket(&warm_home, via_wsl) {
                        let state: tauri::State<SidecarState> = ipc_app_handle.state();
                        *state.endpoint_ipc_socket.lock().unwrap() = Some(path);
                    }
                    break;
                }
                tokio::time::sleep(probe).await;
            }
            handle.keep_warm(probe).await;
        });
    } else {
        // IPC switched OFF. Register a handle that SAYS SO rather than leaving
        // the state unmanaged: Tauri's generic "state not managed" is
        // indistinguishable from the startup window before this same handle
        // gets registered, and the webview must treat those OPPOSITELY — wait
        // through the startup window (falling back there strands a long-lived
        // stream on one of ~6 HTTP sockets for the session, WI-6257), but fall
        // back to HTTP when IPC is deliberately off. With `requireIpc` on,
        // guessing wrong here turns this kill switch into an app-wide hang
        // instead of the rollback it exists to be.
        app_handle.manage(endpoint_ipc::IpcClientHandle::disabled(
            "PAPERCUSP_DESKTOP_IPC=0",
        ));
        println!(
            "[papercusp-desktop] endpoint-ipc DISABLED (PAPERCUSP_DESKTOP_IPC=0) — /api on HTTP"
        );
    }
}

/// Wait for discovery and attach or report the boot failure off the main thread
/// (P-053). GUI setup has already installed IPC; the windowless Server also uses
/// this path, so ensure registration before any boot-outcome early return.
fn finish_boot(app_handle: tauri::AppHandle, workspace_home: std::path::PathBuf, via_wsl: bool) {
    register_packaged_endpoint_ipc(app_handle.clone(), workspace_home.clone(), via_wsl);
    let discovery = match wait_for_operator(
        &app_handle,
        &workspace_home,
        via_wsl,
        operator_boot_timeout(via_wsl),
    ) {
        Ok(d) => d,
        Err(reason) => {
            // WI-2749 part 1a: during Windows WSL onboarding the operator
            // legitimately isn't up yet — WSL install + rootfs import +
            // `/opt/papercup/bootstrap` + PG initdb/migrations routinely exceed
            // this bounded wait, and the Server's post-onboarding finalize restart
            // brings the operator up shortly after. Injecting the scary terminal
            // boot-error OVER the onboarding gate mid-flow is a FALSE ALARM, so
            // suppress it while WSL is not yet Ready: the gate UI owns onboarding
            // progress + errors, and finish_boot re-runs after the finalize
            // restart (when WSL is Ready) to surface any genuine operator failure.
            #[cfg(target_os = "windows")]
            if !matches!(
                wsl_setup::detect(&app_handle).state,
                wsl_setup::WslState::Ready
            ) {
                println!(
                    "[papercusp-desktop] operator not up within the cold-boot budget but WSL onboarding is still in progress — not a boot failure; deferring to the onboarding gate + the post-onboarding restart ({})",
                    reason
                );
                return;
            }
            // WI-3381 (owner directive 2026-07-08 — "make this work on all
            // platforms"): the bundled self/release operator failed to boot.
            // Before surfacing a dead-end boot error, fall back to the safest
            // reachable env (prod :3070 → staging :3170) so the user lands on the
            // deployed release instead of a stranded error page. Only fires when a
            // fallback env is actually up — a plain single-operator install where
            // nothing else runs shows the boot-error page exactly as before.
            // finish_boot is the shared packaged mac/win/linux boot path, so this
            // covers every platform. point_window_at_operator points BOTH content
            // and the /api base at the fallback (same mechanism as the success
            // path); on_page_load → retarget_for_url then pins /api to match.
            if let Some(fallback_port) = env_switch::reachable_fallback_env() {
                eprintln!(
                    "[papercusp-desktop] self/release operator did not boot ({}) — falling back to the safest reachable env :{}",
                    reason, fallback_port
                );
                if let Some(window) = app_handle.get_webview_window("main") {
                    #[cfg(target_os = "linux")]
                    {
                        grant_media_permission(&window);
                        install_load_failure_recovery(&window);
                    }
                    point_window_at_operator(&window, fallback_port, 30);
                    restore_window_visibility(&window, "fallback-env");
                }
                return;
            }
            // The initial navigation may already have failed by the time this
            // timeout is reached. Linux has a WebKitGTK load-failed callback,
            // but WKWebView/WebView2 do not expose the same hook through the
            // Tauri surface. Keep the Rust-side recovery alive so a slow but
            // ultimately healthy operator can still attach on all platforms.
            spawn_boot_recovery_watcher(app_handle.clone(), workspace_home.clone(), via_wsl);
            eprintln!("[papercusp-desktop] FATAL: {}", reason);
            // Surface the failure ON the bootstrap page — web/index.html
            // renders window.__papercuspBootError as a terminal error
            // state instead of spinning forever. Re-eval for a while:
            // the page may still be mid-load when this fires (same
            // re-eval rationale as the success inject below).
            if let Some(window) = app_handle.get_webview_window("main") {
                let inject = format!(
                        "window.__papercuspBootError = {}; window.dispatchEvent(new CustomEvent('papercusp:boot-error'));",
                        serde_json::to_string(&reason)
                            .unwrap_or_else(|_| "\"operator boot failed\"".to_string())
                    );
                eval_local_attach_diagnostic(&window, &inject, 20, Duration::from_millis(500));
            }
            return;
        }
    };
    // The REAL port comes from discovery — `serve --ensure` may have reused
    // an already-running operator on a different port than our cold-start
    // hint.
    let port = discovery.port;
    {
        let state: tauri::State<SidecarState> = app_handle.state();
        *state.port.lock().unwrap() = Some(port);
    }
    println!(
        "[papercusp-desktop] operator ready on :{} (pid {})",
        port, discovery.pid
    );

    // Endpoint-IPC was already registered at the TOP of this function (WI-37771)
    // — runBootstrap inside serve starts the IPC server and writes
    // ~/.papercusp/endpoint-ipc.json (the discovery file also covers the
    // --ensure reuse case, where there is no fresh child stdout to parse), and
    // the handle registered above re-reads that file on every (re)connect, so
    // it picks the socket up here without a second registration. Registering
    // it at this point instead was the bug: none of the early returns above
    // ever reached it, leaving the state unmanaged for the life of the process.

    // Tell the bootstrap page where the sidecar is. The JS in web/index.html
    // will poll /api/desktop/preflight on that base, render any
    // missing-prereq UI, then navigate when ready.
    if let Some(window) = app_handle.get_webview_window("main") {
        // WebKitGTK denies getUserMedia by default; auto-grant so voice /
        // wake-word / elevenlabs work in the shipped build the same way they
        // do in browsers.
        #[cfg(target_os = "linux")]
        grant_media_permission(&window);
        // EI-239: same-port bounce recovery (Linux-only — the operator port is
        // fixed on the dev box). Dynamic-port restarts are handled cross-platform
        // by the operator watcher installed below (WI-1869).
        #[cfg(target_os = "linux")]
        install_load_failure_recovery(&window);
        // Point the webview at the freshly-discovered operator: navigate/reload
        // to the app origin + inject window.__papercuspBase (see the helper).
        // Packaged builds load the conf's frontendDist URL (:3070) as the INITIAL
        // document — nothing serves it on a user machine — and setup() already
        // moved us to the app origin's bundled statics; this re-points at the
        // now-live operator. reinject_ticks=30 covers a page (re)load racing this
        // thread during the bootstrap→SPA handoff.
        point_window_at_operator(&window, port, 30);
        restore_window_visibility(&window, "operator-ready");
        // P-013: verify the operator we just attached to is the one THIS build
        // shipped (its /api/health sha == our baked sha) — catching the EI-9002
        // silent no-op update where a stale operator was adopted. Off-thread so a
        // mismatch's re-eval surfacing loop never delays the operator watcher below.
        let window_sc = window.clone();
        std::thread::spawn(move || run_update_self_check(&window_sc, port));
    }

    // WI-1869: after the one-shot attach above, KEEP following the operator.
    // finish_boot reads operator.json exactly once; on macOS/Windows the operator
    // takes a NEW dynamic port on every Server restart / sidecar crash-respawn,
    // which would otherwise strand the webview on the dead port forever (macOS
    // has no load-failure recovery, and the Linux one polls the same dead URI).
    // The watcher re-navigates to the current operator whenever its port changes.
    spawn_operator_watcher(app_handle.clone(), workspace_home.clone(), via_wsl, port);
}

// ===========================================================================
// Two-bundle split: GUI (attach) + Server (own the sidecar). See app_role.rs.
// ===========================================================================

/// Bundle identifiers — MUST match the two tauri configs (tauri.conf.json →
/// GUI, tauri.server.conf.json → Server). Every platform uses these identities
/// to launch the independently-installed sibling product.
const SERVER_BUNDLE_ID: &str = "com.papercusp.server";
const GUI_BUNDLE_ID: &str = "com.papercusp.gui";

/// P-009 single-instance callback — fires IN THE PRIMARY instance when a second
/// instance of the SAME bundle is launched (the single-instance plugin closes
/// the duplicate before it boots). Per-bundle by construction: the OS lock keys
/// on the app identifier, so this only ever fires for a same-bundle collision
/// (GUI↔GUI or Server↔Server), never GUI↔Server.
///   * GUI    — raise/unminimize/focus the existing window (the standard
///     "you already have Papercusp open" UX; the duplicate just vanishes).
///   * Server — windowless (tray only); nothing to focus. Rejecting the
///     duplicate is the whole point — one Server owns the sidecar + its ports.
///     Just log, so a double-launch is diagnosable.
/// Only wired in release builds (see run()), so it's dead code in dev.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn on_second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    let role = app_role::detect(&app.config().identifier);
    println!(
        "[papercusp-{}] single-instance: rejected a duplicate launch (args={args:?} cwd={cwd})",
        role.label()
    );
    if role.is_gui() {
        if let Some(window) = app.get_webview_window("main") {
            restore_window_visibility(&window, "second-instance");
            // WI-4827: the Quick Panel palette (a different process in the
            // macOS/Windows two-bundle split) may have launched us to open a
            // specific route in the main app. Apply it now that we're focused.
            apply_pending_route(&window);
        }
    }
}

/// WI-4827 — "open this route in the main app" for the CROSS-PROCESS case: on
/// macOS/Windows the Quick Panel palette lives in the always-on Server bundle,
/// a different process from the GUI's `main` window, so it cannot navigate that
/// window directly. It writes the desired same-origin app route here and
/// launches/focuses the GUI bundle; the GUI reads + clears it (one-shot) and
/// navigates. On Linux/dev the palette and `main` share ONE process, so
/// `open_route_in_app` takes the in-process branch and never touches this file.
fn pending_route_path() -> Option<std::path::PathBuf> {
    // WI-36794: resolve through the channel chokepoint, not a raw HOME read —
    // a side-by-side (nightly) GUI must never hand a route off through the live
    // desktop's `~/.papercusp`. The HOME probe is kept only to preserve the
    // pre-existing "no HOME ⇒ no hand-off file" contract (real_home() would
    // otherwise fall back to `.`).
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(
        workspaces::shared_sidecar_home()
            .join(workspaces::BASE_DATA_HOME_DIR_NAME)
            .join("gui-pending-route"),
    )
}

/// Accept only a same-origin app path: exactly one leading '/', no scheme/host,
/// no protocol-relative '//', no control chars. Anything else → None (ignored),
/// so a hand-off can never point the main window off-origin.
fn sanitize_app_route(input: &str) -> Option<String> {
    let s = input.trim();
    if !s.starts_with('/') || s.starts_with("//") {
        return None;
    }
    if s.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(s.to_string())
}

fn write_pending_route(route: &str) {
    let Some(path) = pending_route_path() else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, route) {
        eprintln!("[papercusp-desktop] could not persist pending GUI route: {e}");
    }
}

/// Read + delete the pending route (one-shot). Sanitized on the way out.
fn take_pending_route() -> Option<String> {
    let path = pending_route_path()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    sanitize_app_route(&raw)
}

/// Navigate `window` to a same-origin app `route` via a soft client navigation
/// (the desktop host's `location.assign` override turns it into a pushState nav;
/// off that host it degrades to a real load — either way it lands there). Shared
/// by the in-process branch and the cross-process apply.
fn navigate_window_to_route<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, route: &str) {
    let js = format!(
        "window.location.assign({})",
        serde_json::to_string(route).unwrap_or_else(|_| "\"/\"".to_string())
    );
    if let Err(e) = window.eval(&js) {
        eprintln!("[papercusp-desktop] open_route_in_app: navigate failed: {e}");
    }
}

/// Apply a one-shot pending route to `window` if one was left by the palette.
fn apply_pending_route<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    if let Some(route) = take_pending_route() {
        navigate_window_to_route(window, &route);
    }
}

/// WI-4827 — open a same-origin app `route` in the MAIN operator window and
/// dismiss the Quick Panel palette (Spotlight-style). Invoked from the panel
/// webview when a control would otherwise navigate the small palette window into
/// the full app. In dev the `main` window is in THIS process — focus +
/// soft-navigate it. In every packaged Server (Linux/macOS/Windows), the GUI is
/// a separate product process — persist the route and launch/focus the GUI
/// bundle, which applies it via `apply_pending_route`.
#[tauri::command]
#[specta::specta]
fn open_route_in_app(app: AppHandle, route: String) {
    let Some(route) = sanitize_app_route(&route) else {
        eprintln!("[papercusp-desktop] open_route_in_app: rejected route {route:?}");
        return;
    };
    if let Some(main) = app.get_webview_window("main") {
        restore_window_visibility(&main, "open-route-in-app");
        navigate_window_to_route(&main, &route);
    } else {
        write_pending_route(&route);
        if let Err(e) = launch_bundle(GUI_BUNDLE_ID, "Papercusp GUI") {
            eprintln!("[papercusp-desktop] open_route_in_app: could not launch GUI bundle: {e}");
        }
    }
    // Dismiss the palette so the main app is what the user sees. Focus loss on
    // the palette also hides it (its blur handler), but be deterministic.
    if let Some(palette) = app.get_webview_window(docs_search::WINDOW_LABEL) {
        let _ = palette.hide();
    }
}

/// GUI role setup: never spawn a sidecar. Point the window at the app origin
/// (bundled statics / booting shell) immediately, then — off the main thread —
/// ensure a Papercusp Server is running (auto-launch its bundle if not) and
/// attach the window to its operator via the shared discovery file. `child`
/// stays None, so quit never tears the Server down (shutdown_children_once →
/// kill_sidecar is a no-op).
fn gui_setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // The GUI reads the discovery file the Server wrote; on Windows the sidecar
    // lives inside WSL, so mirror the same routing to find the right path.
    let via_wsl = should_route_via_wsl(&app.handle());
    wsl_setup::set_route_active(via_wsl);
    let app_handle = app.handle().clone();
    let workspace_home = workspaces::shared_sidecar_home();
    register_packaged_endpoint_ipc(app_handle.clone(), workspace_home.clone(), via_wsl);

    // WI-2648: the docs-search palette shortcut is owned by the always-on
    // SERVER process (registered next to install_server_tray), NOT the GUI —
    // so the global key works whether or not the GUI window is open, and the
    // tray rebind control lives in the same process that owns the shortcut.
    // (The in-webview `open_docs_search_palette` command still works from here.)

    // onboarding_origin_enabled(), not enabled(): on Windows the pre-operator
    // navigate to the bundled-SPA origin is what renders the WslOnboardingGate
    // (enabled() is Linux-only; post-operator the window still moves to the real
    // HTTP port via point_window_at_operator so SSE streams natively). WI-2734.
    if custom_protocol::onboarding_origin_enabled() {
        if let Some(window) = app.get_webview_window("main") {
            restore_window_visibility(&window, "gui-setup");
            match custom_protocol::APP_ORIGIN.parse() {
                Ok(u) => {
                    if let Err(e) = window.navigate(u) {
                        eprintln!("[papercusp-gui] app-origin navigate failed: {e}");
                    }
                }
                Err(e) => eprintln!("[papercusp-gui] APP_ORIGIN did not parse: {e}"),
            }
        }
    }

    std::thread::spawn(move || {
        ensure_server_running(&app_handle, &workspace_home, via_wsl);
        // WI-37798: the `via_wsl` above is a STARTUP snapshot, and on a cold
        // first run it is false — the Server we just launched is the very thing
        // that makes it true. Re-resolve it here, or discovery spends its whole
        // budget reading a Windows-side path the WSL sidecar never writes and
        // the window strands on "Operator connection lost".
        let via_wsl = await_wsl_route_ready(&app_handle, via_wsl);
        let after = app_handle.clone();
        // finish_boot polls operator.json (120s, or the 600s WSL budget once
        // the route above resolves — covers a cold Server boot), and navigates
        // the window to the operator using the already registered IPC handle.
        finish_boot(app_handle, workspace_home, via_wsl);
        // WI-4827 cross-process COLD start (macOS/Windows two-bundle): if the
        // Quick Panel palette launched us to open a route and the GUI wasn't
        // already running, on_second_instance never fired. Now that main is at
        // the operator, apply any one-shot pending route the palette left.
        if let Some(window) = after.get_webview_window("main") {
            apply_pending_route(&window);
        }
    });
    Ok(())
}

/// If no operator is reachable, launch the sibling "Papercusp Server" bundle.
/// Does not block on full readiness — finish_boot's poll handles the boot wait.
fn ensure_server_running(
    app_handle: &tauri::AppHandle,
    workspace_home: &std::path::Path,
    via_wsl: bool,
) {
    if wait_for_operator(app_handle, workspace_home, via_wsl, Duration::from_secs(2)).is_ok() {
        println!("[papercusp-gui] a Papercusp Server is already running — attaching");
        return;
    }
    println!("[papercusp-gui] no Server reachable — launching the Papercusp Server bundle");
    if let Err(e) = launch_bundle(SERVER_BUNDLE_ID, "Papercusp Server") {
        eprintln!(
            "[papercusp-gui] could not launch Papercusp Server ({e}); \
             will keep polling in case it is installed or started another way"
        );
        surface_server_connection_required(
            app_handle,
            &format!("Papercusp Server could not be launched: {e}"),
        );
    }
}

/// P-007: tell the already-rendered bundled SPA that the attach-only GUI has no
/// usable Server endpoint. Keep the diagnostic on `window` as well as emitting
/// an event: the page and this worker race on cold boot, and a one-shot event
/// alone can land before React installs its listener.
fn surface_server_connection_required(app_handle: &tauri::AppHandle, reason: &str) {
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };
    let reason = serde_json::to_string(reason)
        .unwrap_or_else(|_| "\"No Papercusp Server endpoint is available.\"".to_string());
    let inject = format!(
        "window.__papercuspServerConnectionRequired = {reason}; \
         window.dispatchEvent(new CustomEvent('papercusp:server-connection-required', \
           {{ detail: {reason} }}));"
    );
    // A document navigation can replace the JS world during this exact cold-
    // boot window. Re-apply briefly while it remains a local document; an
    // intentional remote HTTPS navigation cancels this stale local result.
    eval_local_attach_diagnostic(&window, &inject, 8, Duration::from_millis(250));
}

/// Turn a platform launcher verdict into the lifecycle signal the thin GUI
/// needs. Starting `gtk-launch` only proves the helper binary exists; when the
/// sibling desktop entry is absent it exits non-zero immediately. Treating that
/// as success strands the bundled SPA on generic reconnect UI for the full boot
/// timeout instead of showing the explicit install-Server gate.
fn launcher_status_result(
    succeeded: bool,
    product_name: &str,
    launcher_diagnostic: &str,
) -> std::io::Result<()> {
    if succeeded {
        return Ok(());
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!("{product_name} is not installed or could not be started ({launcher_diagnostic})"),
    ))
}

/// Cross-platform "launch the sibling app bundle by identity".
///   * macOS  — `open -b <bundle-id>`: LaunchServices resolves the installed
///     .app regardless of where it lives. Solid + used as the primary path.
///   * Linux  — `gtk-launch <product-name>.desktop` (Tauri's Debian bundler
///     names the installed desktop file from productName, not identifier).
///   * Windows — resolve the sibling executable from its product-specific
///     `%LOCALAPPDATA%/<ProductName>/papercusp-desktop.exe` install path and
///     launch it detached. Both bundles share the binary name, so the product
///     directory is the identity boundary (parity fix landed 2026-07-02).
fn launch_bundle(bundle_id: &str, product_name: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let _ = product_name;
        Command::new("open").arg("-b").arg(bundle_id).spawn()?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let _ = bundle_id;
        // Tauri's Debian bundler names these from productName. Verified from
        // the assembled sibling packages, not inferred from the config:
        //   /usr/share/applications/Papercusp GUI.desktop
        //   /usr/share/applications/Papercusp Server.desktop
        // Using the reverse-domain bundle identifier here makes gtk-launch
        // exit 2 even when the sibling package is installed.
        // `spawn()` alone is a false success when the sibling is not installed:
        // gtk-launch itself starts, exits 2 in ~30ms, and the GUI waits 120s on
        // an operator that cannot appear. `status()` returns just as promptly
        // for a valid desktop entry (gtk-launch delegates the app and exits),
        // while letting us surface the explicit install-Server gate immediately.
        let desktop_id = format!("{product_name}.desktop");
        let status = Command::new("gtk-launch").arg(&desktop_id).status()?;
        launcher_status_result(
            status.success(),
            product_name,
            &format!("gtk-launch {desktop_id} exited with {status}"),
        )
    }
    #[cfg(target_os = "windows")]
    {
        let _ = bundle_id;
        // Both bundles ship the SAME binary name (papercusp-desktop.exe) but NSIS
        // installs each to its own per-product dir:
        //   %LOCALAPPDATA%\<ProductName>\papercusp-desktop.exe
        // (verified live: "Papercusp GUI" / "Papercusp Server"). Resolve the
        // sibling by product name and spawn it DETACHED with
        // CREATE_BREAKAWAY_FROM_JOB so it outlives us even when we were started by
        // the installer's run-after-install (which lives in a job object that
        // kills its whole tree — D-010). (2026-07-02 parity fix: previously
        // unimplemented, so the GUI could not auto-launch the Server and the
        // Server tray's "Open Papercusp" could not launch the GUI.)
        use std::os::windows::process::CommandExt;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        let local = std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotFound, "LOCALAPPDATA unset")
            })?;
        let exe = local.join(product_name).join("papercusp-desktop.exe");
        if !exe.exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("'{product_name}' not installed at {}", exe.display()),
            ));
        }
        std::process::Command::new(&exe)
            .creation_flags(CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS)
            .spawn()
            .or_else(|_| std::process::Command::new(&exe).spawn())?;
        Ok(())
    }
}

/// Menu-id prefix for the tray's docs-search-shortcut preset items
/// (`docs-shortcut::<accelerator>`), so the menu-event handler can tell a rebind
/// click from the open/quit items and recover the chosen accelerator.
const DOCS_SHORTCUT_MENU_PREFIX: &str = "docs-shortcut::";

/// The "Quick Panel shortcut" submenu (né "Docs search shortcut" — the palette
/// is now the tabbed Quick Panel, quick-panel-saved-prompts-2026-07-13): an
/// "Off" item followed by one checkable item per preset, with the live state
/// (docs_search::current_shortcut) checked. Rebuilt after each change so the
/// checkmark tracks the selection.
///
/// "Off" is FIRST and is checked on a fresh install — the shortcut ships disabled
/// (owner directive 2026-07-12), so this submenu is also the only place the OS key
/// grab is ever turned ON.
fn build_docs_shortcut_submenu(
    app: &tauri::AppHandle,
) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    use tauri::menu::{CheckMenuItem, IsMenuItem, Submenu};
    let current = docs_search::current_shortcut();
    let mut items: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
    items.push(CheckMenuItem::with_id(
        app,
        format!("{DOCS_SHORTCUT_MENU_PREFIX}{}", docs_search::SHORTCUT_OFF),
        "Off (no global shortcut)",
        true,
        current.is_none(),
        None::<&str>,
    )?);
    for accel in docs_search::PRESET_SHORTCUTS {
        items.push(CheckMenuItem::with_id(
            app,
            format!("{DOCS_SHORTCUT_MENU_PREFIX}{accel}"),
            *accel,
            true,
            current.as_deref() == Some(*accel),
            None::<&str>,
        )?);
    }
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items
        .iter()
        .map(|i| i as &dyn IsMenuItem<tauri::Wry>)
        .collect();
    Submenu::with_items(app, "Quick Panel shortcut", true, &refs)
}

/// Server-role state for the WI-4404 background update poller: the newest
/// version the poller has found available, if any. `None` once installed/
/// consumed. Read by `build_server_tray_menu` to decide whether to show the
/// "Install Update" item; written by `spawn_server_update_poller`.
struct ServerUpdateState {
    pending_version: std::sync::Mutex<Option<String>>,
}

/// Build the full Server tray menu: Open · [Install Update vX ·] Docs search
/// shortcut ▸ · — · Quit. Factored out so the menu-event handler can rebuild
/// it after a rebind, or after the background poller finds/consumes an
/// update (WI-4404).
fn build_server_tray_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let open = MenuItem::with_id(app, "open-gui", "Open Papercusp", true, None::<&str>)?;
    // WI-3382 (owner 2026-07-08): launch the `papercusp tutorial` CLI utility in a
    // native terminal — the tray twin of the "Papercusp Tutorial & setup" icon.
    let tutorial = MenuItem::with_id(app, "open-tutorial", "Open Tutorial", true, None::<&str>)?;
    let shortcut = build_docs_shortcut_submenu(app)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(
        app,
        "quit-server",
        "Quit Papercusp Server",
        true,
        None::<&str>,
    )?;

    // WI-4404: the Server has no webview, so it has no UpdateChip — this is
    // its ONLY update surface. Mirrors the GUI's own stated design ("nothing
    // installs on its own — every install path is behind a confirm",
    // UpdateChip.tsx): the poller only ever offers the item; a click IS the
    // confirm gesture, same as the GUI's confirm+click.
    let pending: Option<String> = app
        .try_state::<ServerUpdateState>()
        .and_then(|s| s.pending_version.lock().ok().and_then(|g| g.clone()));
    if let Some(version) = pending {
        let install = MenuItem::with_id(
            app,
            "install-update",
            format!("Install Update (v{version})…"),
            true,
            None::<&str>,
        )?;
        let sep2 = PredefinedMenuItem::separator(app)?;
        return Menu::with_items(
            app,
            &[&open, &install, &sep2, &tutorial, &shortcut, &sep, &quit],
        );
    }
    Menu::with_items(app, &[&open, &tutorial, &shortcut, &sep, &quit])
}

/// The spec the tray "Open Tutorial" runs on Linux/Windows: the `papercusp
/// tutorial` CLI (opens the "Tutorial & Setup" shell on the Tutorial tab) in a
/// native terminal. `papercusp` is a global CLI on PATH (a login shell resolves
/// it), so no absolute path is needed. cwd defaults to $HOME; "." keeps it
/// cwd-agnostic where HOME is unset (papercusp tutorial ignores cwd).
#[cfg(not(target_os = "macos"))]
fn tutorial_console_spec() -> native_console::ExternalConsoleSpec {
    let cwd = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    native_console::ExternalConsoleSpec {
        command: "papercusp".to_string(),
        args: vec!["tutorial".to_string()],
        cwd,
        env: std::collections::HashMap::new(),
        title: "Papercusp Tutorial".to_string(),
    }
}

/// Open the `papercusp tutorial` CLI utility in a NEW native terminal window —
/// the tray "Open Tutorial" action (WI-3382, owner directive 2026-07-08). Reuses
/// the same external-terminal launcher the onboarding tutorial uses
/// (`native_console::external_console_run`) on Linux/Windows; on macOS that command
/// is unsupported (the onboarding UX there is an embedded pane), so drive
/// Terminal.app directly.
fn launch_tutorial_console() {
    #[cfg(target_os = "macos")]
    {
        // external_console_run is Linux/Windows-only — open Terminal.app instead.
        if let Err(e) = std::process::Command::new("osascript")
            .arg("-e")
            .arg("tell application \"Terminal\" to do script \"papercusp tutorial\"")
            .arg("-e")
            .arg("tell application \"Terminal\" to activate")
            .spawn()
        {
            eprintln!("[papercusp-server] could not launch tutorial (macOS): {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Linux: a real native terminal via the bundled-ghostty / $TERMINAL cascade.
        // Windows: a Windows Terminal window running the command inside WSL
        // (TODO(windows): confirm the WSL cwd for the one-liner on a packaged build).
        let spec = tutorial_console_spec();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = native_console::external_console_run(spec).await {
                eprintln!("[papercusp-server] could not launch tutorial: {e}");
            }
        });
    }
}

#[cfg(all(test, not(target_os = "macos")))]
mod tutorial_console_spec_tests {
    #[test]
    fn spec_launches_papercusp_tutorial_in_a_titled_window() {
        let spec = super::tutorial_console_spec();
        assert_eq!(spec.command, "papercusp");
        assert_eq!(spec.args, vec!["tutorial".to_string()]);
        assert_eq!(spec.title, "Papercusp Tutorial");
    }
}

/// Build the Server's tray/menubar icon (the windowless backend's only surface):
/// open the GUI, change the docs-search shortcut, or quit (which tears the
/// sidecar down via ExitRequested).
fn install_server_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::tray::TrayIconBuilder;

    let menu = build_server_tray_menu(app.handle())?;

    let mut builder = TrayIconBuilder::with_id("papercusp-server")
        .tooltip("Papercusp Server")
        .menu(&menu)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if id == "open-gui" {
                if let Err(e) = launch_bundle(GUI_BUNDLE_ID, "Papercusp GUI") {
                    eprintln!("[papercusp-server] could not launch GUI: {e}");
                }
            } else if id == "open-tutorial" {
                launch_tutorial_console();
            } else if id == "quit-server" {
                app.exit(0);
            } else if id == "install-update" {
                // WI-4404: this click IS the confirm gesture (the Server has no
                // webview to run UpdateChip's confirm dialog in) — go straight to
                // install_update, exactly what the GUI does after its own confirm.
                // install_update ends in app.restart() on success, so nothing after
                // that point runs; on failure it returns an Err we just log (the
                // pending-version tray item stays up so the next poll tick or a
                // retry click can try again).
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    println!("[papercusp-server] update install requested via tray");
                    if let Err(e) = install_update(app2.clone()).await {
                        eprintln!("[papercusp-server] tray-triggered update install failed: {e}");
                        use tauri_plugin_notification::NotificationExt;
                        let _ = app2
                            .notification()
                            .builder()
                            .title("Papercusp Server update failed")
                            .body(format!("{e} — open the tray menu to retry."))
                            .show();
                    }
                });
            } else if let Some(payload) = id.strip_prefix(DOCS_SHORTCUT_MENU_PREFIX) {
                // Rebuild after success OR refusal: native check items toggle
                // before this callback, so a refused key otherwise stays checked
                // alongside the persisted working selection. The "Off" item
                // carries the SHORTCUT_OFF payload → None → disable entirely.
                let choice = (payload != docs_search::SHORTCUT_OFF).then_some(payload);
                if let Err(e) = docs_search::set_shortcut(app, choice) {
                    eprintln!("[papercusp-server] docs-search set to {payload} failed: {e}");
                }
                match build_server_tray_menu(app) {
                    Ok(menu) => {
                        if let Some(tray) = app.tray_by_id("papercusp-server") {
                            let _ = tray.set_menu(Some(menu));
                        }
                    }
                    Err(e) => eprintln!("[papercusp-server] tray menu rebuild failed: {e}"),
                }
            }
        });
    // Reuse the bundle icon (the Server config still ships icons even with no
    // window). If absent, some platforms still render a default tray glyph.
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// Register the Server bundle to launch at login (idempotent).
///
/// Linux is package-owned instead: the Server `.deb` installs and globally
/// enables `papercusp-server.service` for the user manager's `default.target`.
/// Lightweight Linux desktops do not necessarily activate
/// `graphical-session.target`, so using it would leave the Server inactive after
/// a real login. Calling the Tauri plugin here as well would create an XDG
/// autostart entry only after
/// the first manual launch and then double-launch the systemd-managed Server on
/// later logins. Keep the runtime plugin for the macOS/Windows installers,
/// whose login-item registration is intentionally performed by the app.
#[cfg(not(target_os = "linux"))]
fn enable_login_autostart(app: &tauri::App) {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    match mgr.is_enabled() {
        Ok(true) => println!("[papercusp-server] login auto-start already enabled"),
        Ok(false) => match mgr.enable() {
            Ok(()) => println!("[papercusp-server] login auto-start enabled"),
            Err(e) => eprintln!("[papercusp-server] could not enable auto-start: {e}"),
        },
        Err(e) => eprintln!("[papercusp-server] auto-start state unknown: {e}"),
    }
}

#[cfg(target_os = "linux")]
fn enable_login_autostart(_app: &tauri::App) {
    println!("[papercusp-server] login auto-start is managed by papercusp-server.service");
}

/// Prepare rotated stdout+stderr sinks for the sidecar under
/// `<workspace_home>/.papercusp/logs/serve.log` (WI-1707).
///
/// A packaged desktop app is launched with NO controlling console — Finder /
/// `launchd` / a login-item on macOS, an Explorer / login GUI launch on Windows
/// — so the parent process's stdout/stderr are already `/dev/null`. An
/// *inherited* sidecar stdio therefore drops every serve boot / embedded-PG /
/// migration diagnostic on the floor, leaving a wedged install unbootstrappable
/// to debug (the exact gap this fixes). Point them at an on-disk log instead.
///
/// Rotation is per-spawn (each Server-app launch / crash-respawn): `<basename>`
/// → `<basename>.1` → … → `<basename>.5`, dropping the oldest, so history survives
/// a respawn without unbounded growth. Returns two `Stdio` handles onto the SAME
/// fresh file (stdout + a `try_clone`d stderr), or `None` if the log can't be
/// prepared — the caller then falls back to inherit so logging never blocks the
/// child from launching.
///
/// `basename` is the log file name (e.g. `serve.log`) so every
/// console-less child sidecar can route to its own rotated on-disk log via one
/// shared helper rather than each re-implementing the rotation (WI-1707/WI-1781).
/// Rotate `<workspace_home>/.papercusp/logs/<basename>` (…→`.5`, dropping the
/// oldest) and open a FRESH appendable file for it, returning the open handle.
///
/// The shared core of both console-less-stdio sinks: the CHILD-sidecar path
/// (`rotating_log_stdio`, which wraps this in a `(Stdio, Stdio)` pair) and the
/// OWN-process path (`redirect_own_stdio`, which `dup2`s this file's fd over
/// 1/2). Returns `None` if the log dir / file can't be prepared so every caller
/// can fall back without blocking boot.
fn rotate_and_open_log(workspace_home: &std::path::Path, basename: &str) -> Option<std::fs::File> {
    let logs_dir = workspace_home.join(".papercusp").join("logs");
    std::fs::create_dir_all(&logs_dir).ok()?;
    let base = logs_dir.join(basename);
    const KEEP: u32 = 5;
    let rotated = |n: u32| logs_dir.join(format!("{basename}.{n}"));
    // Drop the oldest, shift each older file up one, then the live log → .1.
    let _ = std::fs::remove_file(rotated(KEEP));
    for n in (1..KEEP).rev() {
        let _ = std::fs::rename(rotated(n), rotated(n + 1));
    }
    let _ = std::fs::rename(&base, rotated(1));
    // append: `base` was just rotated away so this creates a fresh file; append
    // (not truncate) is the safe choice if the rename above ever no-ops.
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&base)
        .ok()
}

fn rotating_log_stdio(workspace_home: &std::path::Path, basename: &str) -> Option<(Stdio, Stdio)> {
    let file = rotate_and_open_log(workspace_home, basename)?;
    let file2 = file.try_clone().ok()?;
    Some((Stdio::from(file), Stdio::from(file2)))
}

/// Redirect THIS process's OWN stdout+stderr (fd 1 & 2) to a rotated on-disk log
/// `<workspace_home>/.papercusp/logs/<basename>` — the own-process analogue of
/// `rotating_log_stdio` (WI-1803).
///
/// WI-1707 pointed the CHILD sidecar's (serve) stdio at on-disk
/// logs, but the desktop app's OWN process is ALSO launched with no controlling
/// console (Finder / `launchd` / a login item on macOS), so its inherited fd
/// 1/2 are `/dev/null`. Every `println!` / `eprintln!` in THIS binary — the
/// GUI's `gui_setup` + `finish_boot` navigate/boot diagnostics, the Server's
/// sidecar-spawn errors — was therefore dropped on the floor, leaving a
/// blank-page GUI (WI-1802) undebuggable on a shipped Mac build. `dup2` the
/// rotated log's fd over 1 & 2 so those diagnostics land on disk, exactly like
/// a shell `exec >log 2>&1`.
///
/// Best-effort: any failure (no HOME, open error) leaves stdio untouched and
/// never blocks boot. This is the Unix (`dup2`) variant; the packaged Windows
/// GUI/Server bundles have the SAME console-less gap and get an equivalent
/// `SetStdHandle` variant below (WI-2749 — the missing Windows boot log made the
/// post-onboarding sidecar-spawn failure undebuggable on a shipped build).
/// Caller gates this to release builds so `tauri dev` keeps its inherited
/// terminal console.
///
/// Only WIRED IN release builds (the call site is `cfg(not(debug_assertions))`),
/// so a debug non-test build sees it unused — silence dead_code for exactly that
/// config; the `serve_log_tests` unit test exercises it under `cfg(test)`.
#[cfg(unix)]
#[cfg_attr(all(debug_assertions, not(test)), allow(dead_code))]
fn redirect_own_stdio(workspace_home: &std::path::Path, basename: &str) {
    use std::io::Write;
    use std::os::unix::io::AsRawFd;
    let Some(file) = rotate_and_open_log(workspace_home, basename) else {
        return;
    };
    // Flush anything Rust buffered against the old fds first (stdout is
    // block-buffered when 1 isn't a tty), so no stray bytes race the swap.
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    let fd = file.as_raw_fd();
    // SAFETY: `fd` is a valid open descriptor. `dup2` atomically points fd 1 & 2
    // at the log's open file description; Rust's `stdout()`/`stderr()` keep
    // writing to fd 1/2 (now the log). We `mem::forget` the `File` so its open
    // description outlives this fn — 1/2 must stay valid for the whole process,
    // just as an `exec >log 2>&1` redirect persists after the shell returns.
    unsafe {
        libc::dup2(fd, libc::STDOUT_FILENO);
        libc::dup2(fd, libc::STDERR_FILENO);
    }
    std::mem::forget(file);
}

/// Windows analogue of the Unix `redirect_own_stdio` above (WI-2749). Both
/// packaged bundles ship `windows_subsystem = "windows"` and are launched from
/// Explorer / the NSIS run-after-install checkbox / Task Scheduler with NO
/// console, so `GetStdHandle(STD_OUTPUT/ERROR)` is null and every `println!` /
/// `eprintln!` in this binary — the GUI boot-navigate diagnostics, the Server's
/// sidecar-spawn + WSL-route errors, the post-onboarding finalize/respawn
/// trace — is dropped on the floor, leaving Windows first-run failures (the
/// operator that never spawns after onboarding) undebuggable on a shipped
/// build. Point the process's std OUTPUT/ERROR handles at the rotated log via
/// `SetStdHandle`; Rust's Windows stdio resolves the handle through
/// `GetStdHandle` on every write, so its output now lands on disk — the
/// analogue of the Unix `dup2` swap.
///
/// Best-effort: any failure (no HOME, open error) leaves stdio untouched and
/// never blocks boot.
#[cfg(windows)]
#[cfg_attr(all(debug_assertions, not(test)), allow(dead_code))]
fn redirect_own_stdio(workspace_home: &std::path::Path, basename: &str) {
    use std::io::Write;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
    let Some(file) = rotate_and_open_log(workspace_home, basename) else {
        return;
    };
    // Flush anything Rust buffered against the old handles before the swap.
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    let handle = HANDLE(file.as_raw_handle() as _);
    // SAFETY: `handle` is a valid open file handle. `SetStdHandle` points the
    // process's std OUTPUT/ERROR handles at the log's open file description;
    // Rust resolves the handle via `GetStdHandle` per write, so subsequent
    // `println!`/`eprintln!` land there. We `mem::forget` the `File` so its
    // handle outlives this fn — the std handles must stay valid for the whole
    // process (mirrors the Unix `mem::forget` + shell `exec >log 2>&1`
    // persistence).
    unsafe {
        let _ = SetStdHandle(STD_OUTPUT_HANDLE, handle);
        let _ = SetStdHandle(STD_ERROR_HANDLE, handle);
    }
    std::mem::forget(file);
}

/// Spawn the bundled `serve.mjs --ensure` (SP1 C5). serve owns embedded-PG +
/// the Hono host + the discovery files; this fn just assembles the desktop
/// environment for it:
///   - bundled PATH (node + vendored CLIs), workspace-HOME isolation
///   - the SPA/docs roots (desktop serves the UI: PAPERCUSP_SERVE_UI=1)
///   - PG knobs (picked port, shared data dir, bundled migrations dir)
///   - the cold-start port hint (PAPERCUSP_HONO_PORT)
/// stdout/stderr: in a dev build they're inherited (the developer's `tauri dev`
/// console); in a release (packaged) build — which has NO console — they're
/// redirected to a rotated <home>/.papercusp/logs/serve.log so boot / PG /
/// migration diagnostics survive on disk (WI-1707; see rotating_log_stdio). The
/// endpoint-IPC handshake is NOT parsed from stdout anymore; the discovery file
/// (~/.papercusp/endpoint-ipc.json) is the one channel that also covers the
/// --ensure reuse case, so redirecting stdout is safe.
#[allow(clippy::too_many_arguments)]
/// Spawn the operator sidecar (`papercusp serve`) and wire its respawn
/// supervisor + off-thread boot-wait. Callable from EITHER the Server-role
/// setup fast path (WSL already Ready / non-Windows) OR the Windows
/// deferred-boot watcher once WSL flips Ready — the watcher calls this
/// IN-PROCESS instead of breakaway-restarting a second instance.
///
/// WI-3407: the old deferred path spawned a fresh instance (via
/// `wsl_finalize_ready`) to re-run setup with WSL now Ready. That second
/// instance raced the STILL-ALIVE deferred Server for the per-bundle
/// single-instance lock, lost (`on_second_instance` rejected it), and left the
/// persisted finalize flag latched so no retry ever fired — every pristine
/// first boot wedged with an empty serve.log + the GUI's 120s operator FATAL.
/// This process is already the singleton lock holder, so it just spawns the
/// sidecar itself. Nothing here touches the Tauri main thread (only a process
/// spawn + `app.state()` + thread spawns), so it is safe off the watcher thread.
/// The WSL-independent tray / global shortcut / login-autostart are installed by
/// server setup BEFORE the WSL gate, so this path owns only the sidecar.
fn bring_up_sidecar(
    app: &tauri::AppHandle,
    via_wsl: bool,
    port: u16,
    sidecar_dir: std::path::PathBuf,
    pg_port_hint: u16,
    shared_state_dir: std::path::PathBuf,
    workspace_home: std::path::PathBuf,
) {
    // WI-305737: executing the installed sidecar directly from `/mnt/c` leaves
    // Node's hot code/resource reads on DrvFs. A live Windows guest reproduced
    // the resulting kernel-D `p9_cli` hang with a stale operator.json and closed
    // API port. Materialize one content-addressed ext4 snapshot before spawn;
    // the immutable Windows install remains the source/seed archive location.
    let runtime_sidecar_dir: Option<std::path::PathBuf> = {
        #[cfg(target_os = "windows")]
        {
            if via_wsl {
                match prepare_wsl_sidecar_runtime(&sidecar_dir) {
                    Ok(path) => Some(path),
                    Err(error) => {
                        let message =
                            format!("could not stage the Windows sidecar into WSL ext4: {error}");
                        INSTALL_DEFECT.set(Some(message.clone()));
                        eprintln!("[papercusp-desktop] FATAL: {message} (WI-305737)");
                        notify_install_broken(app, &message);
                        return;
                    }
                }
            } else {
                None
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    };
    // (EI-8894/WI-3633 leg 2) Boot-time orphan sweep — belt-and-suspenders
    // alongside the parent-death self-exit watch (serve.ts), which only
    // self-terminates a sidecar that is ITSELF still alive and polling its
    // own ppid. This catches anything that watch missed (an older build, a
    // crash before it installed) by checking the ONE pid THIS workspace's
    // operator.json actually names, right before we spawn our own fresh one.
    sweep_stale_operator_orphan(&workspace_home, via_wsl);
    let serve_child = match spawn_serve(
        via_wsl,
        port,
        &sidecar_dir,
        runtime_sidecar_dir.as_deref(),
        pg_port_hint,
        &shared_state_dir,
        &workspace_home,
        &INSTALL_DEFECT,
        false,
    ) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[papercusp-desktop] failed to spawn serve: {}", e);
            // WI-5390: a BROKEN INSTALL fails here on the very first spawn — before
            // any supervisor exists to notice or report it. Without this the user
            // gets an app that boots to nothing and says nothing at all (the
            // failure mode is worse at first boot than mid-session). Tell them
            // directly; there is nothing to supervise, so do not start a
            // supervisor that would only re-derive the same verdict.
            if let Some(defect) = current_install_defect() {
                notify_install_broken(app, &defect);
            }
            return;
        }
    };

    let state: tauri::State<SidecarState> = app.state();
    *state.child.lock().unwrap() = Some(serve_child);

    // WI-2667/WI-3170/WI-3270: the Server role owns one respawn-with-backoff
    // supervisor for its serve.mjs child on every platform.
    spawn_serve_supervisor(
        app.clone(),
        via_wsl,
        port,
        sidecar_dir.clone(),
        runtime_sidecar_dir,
        pg_port_hint,
        shared_state_dir.clone(),
        workspace_home.clone(),
    );

    // finish_boot waits for operator readiness + wires endpoint-IPC OFF-thread
    // (P-053): the setup thread / watcher must never block on the ~120s
    // first-boot initdb + migration replay.
    let app_handle = app.clone();
    let workspace_home_bg = workspace_home;
    std::thread::spawn(move || finish_boot(app_handle, workspace_home_bg, via_wsl));
}

/// Env vars forwarded across the Windows→WSL boundary to the sidecar.
///
/// WHY THIS IS A NAMED CONSTANT AND NOT AN INLINE STRING. On Windows the sidecar
/// runs INSIDE WSL2, so `Command::env(...)` alone does not reach it: a var must
/// ALSO be named here or the Linux side never sees it. That makes this list and
/// the `.env(...)` calls in `spawn_serve` two lists that must agree, with nothing
/// enforcing it — and a var set but not listed is dropped SILENTLY, on Windows
/// only, at runtime.
///
/// That is exactly how Windows auto-update shipped dead. `PAPERCUSP_RELEASE_HOST`
/// was baked into the .exe (the byte-gate proved it), set via `.env(...)` below,
/// and then never crossed into WSL — so the sidecar's `releaseHostBase()` read
/// undefined, `/api/updates/manifest` answered `cannot_check`, and the updater
/// rendered that as "you're on the latest". Forever. The bake was real and the
/// gate was honest; the value simply never arrived at the process that uses it.
/// PACKED IS NOT DELIVERED.
///
/// So: if you add a `.env(...)` to `spawn_serve` that the SIDECAR reads, add it
/// here too. `wslenv_forwards_every_var_the_sidecar_reads` pins the ones we know
/// are load-bearing.
const SIDECAR_WSLENV: &str = "PORT:HOSTNAME:NODE_ENV:PAPERCUSP_BUILD_SHA:PAPERCUSP_BUILD_VERSION:PAPERCUSP_DISTRIBUTION_PROFILE:PAPERCUSP_HARNESS_DIR/p:PAPERCUSP_TEMPLATES_DIR/p:PAPERCUSP_RUBRICS_DIR/p:PAPERCUSP_GOAL_PACKAGES_DIR/p:\
     PAPERCUSP_DESKTOP:PAPERCUSP_SHARED_OPERATOR:PAPERCUSP_OPERATOR_BASE:HOME/p:USERPROFILE/p:\
     PAPERCUSP_USE_EMBEDDED_PG:PAPERCUSP_PG_PORT:PAPERCUSP_PG_DATA_DIR:\
     PAPERCUSP_PG_SQL_DIR/p:PAPERCUSP_PG_SEED_PATH/p:PAPERCUSP_PG_RESTORE_BIN/p:PAPERCUSP_IDENTITY_DIR/p:PAPERCUSP_ANNOUNCE_IDENTITY_CACHE/p:\
     PAPERCUSP_HONO_PORT:PAPERCUSP_BIND_HOST:\
     PAPERCUSP_SERVE_UI:PAPERCUSP_DBOS_ENABLE:PAPERCUSP_DBOS_ROUTINES:\
     PAPERCUSP_DBOS_ORCHESTRATOR:PAPERCUSP_PROVISION_ENV_OPERATORS:\
     HARNESS_DATABASE_URL:HARNESS_ADMIN_DATABASE_URL:\
     PAPERCUSP_SPA_DIST/p:PAPERCUSP_DOCS_ROOT/p:\
     PAPERCUSP_PROMPTS_DIR/p:PAPERCUSP_SEED_DIR/p:PAPERCUSP_SIDECAR_BIN/p:\
     PAPERCUSP_SOURCE_ARCHIVE/p:PAPERCUSP_DEV_SOURCE_DIR:\
     PAPERCUSP_IPC_ENABLE:PAPERCUSP_IPC_TCP:\
     PAPERCUSP_RELEASE_HOST:PAPERCUSP_WORKSPACES_ROOT/p:PAPERCUSP_HOME/p";

/// WSLENV shape for the sidecar launch.
///
/// `/p` is directional Windows→WSL translation, not a generic "this is a
/// path" annotation. Live Windows verification for WI-305737 proved that WSL
/// drops an already-POSIX `/home/...` value when its entry still carries `/p`.
/// Once the hot sidecar tree has been staged onto distro ext4, strip `/p` only
/// from the variables whose values now point into that tree. Seed/source
/// archives and Windows-owned identity/state paths deliberately remain on the
/// installed Windows tree and must retain translation.
const WSL_NATIVE_RUNTIME_PATHS: [&str; 10] = [
    "PAPERCUSP_HARNESS_DIR",
    "PAPERCUSP_TEMPLATES_DIR",
    "PAPERCUSP_RUBRICS_DIR",
    "PAPERCUSP_GOAL_PACKAGES_DIR",
    "PAPERCUSP_PG_SQL_DIR",
    "PAPERCUSP_PG_RESTORE_BIN",
    "PAPERCUSP_SPA_DIST",
    "PAPERCUSP_DOCS_ROOT",
    "PAPERCUSP_PROMPTS_DIR",
    "PAPERCUSP_SIDECAR_BIN",
];

fn sidecar_wslenv(runtime_sidecar_is_wsl_native: bool) -> String {
    if !runtime_sidecar_is_wsl_native {
        return SIDECAR_WSLENV.to_string();
    }
    SIDECAR_WSLENV
        .split(':')
        .map(|entry| {
            let name = entry.strip_suffix("/p").unwrap_or(entry).trim();
            if WSL_NATIVE_RUNTIME_PATHS.contains(&name) {
                name
            } else {
                entry
            }
        })
        .collect::<Vec<_>>()
        .join(":")
}

/// The same paths whose `/p` translation is disabled must reach Linux with
/// POSIX separators. Windows PathBuf joins otherwise leave `root\spa` etc.
/// Do not touch Windows-owned seed/source/state paths: WSLENV still translates
/// those, and their native values remain meaningful to Windows callers.
#[cfg(any(target_os = "windows", test))]
fn normalize_wsl_runtime_env(cmd: &mut Command) {
    let normalized: Vec<_> = cmd
        .get_envs()
        .filter_map(|(name, value)| {
            let name = name.to_str()?;
            if !WSL_NATIVE_RUNTIME_PATHS.contains(&name) {
                return None;
            }
            Some((
                name.to_owned(),
                windows_path_to_wsl(std::path::Path::new(value?)),
            ))
        })
        .collect();
    cmd.envs(normalized);
}

fn baked_distribution_profile() -> &'static str {
    option_env!("PAPERCUSP_DISTRIBUTION_PROFILE").unwrap_or("dogfood")
}

/// Whether the operator should provision the local env-switcher operators
/// (dev :3270 / prod :3070 / staging :3170 / local :3055). They exist only to
/// light up the desktop's EnvSwitcherBar, so they are OFF for:
/// - `vm-release` (the immutable customer VM build), and
/// - an explicit `PAPERCUSP_PROVISION_ENV_OPERATORS=0` opt-out (the same
///   opt-out honored by host-bootstrap, including isolated desktop verification),
/// - the `--headless-service` Server whatever its profile (WI-10006420). It has
///   no window, the operators bind loopback so nothing remote can use them, and
///   measured 2026-10-06 on a dogfood-profile Server they cost 2.3-2.9 GB RSS
///   (tsx dev operator + Vite dev server) plus the first-boot source extract. On
///   a shared host a second tenant also found the first tenant's listeners
///   "already reachable" and adopted them as its own.
fn provision_env_operators_for(
    profile: &str,
    headless_service: bool,
    requested: Option<&str>,
) -> &'static str {
    if headless_service || profile == "vm-release" || requested == Some("0") {
        "0"
    } else {
        "1"
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_serve(
    via_wsl: bool,
    port_hint: u16,
    sidecar_dir: &std::path::Path,
    runtime_sidecar_dir: Option<&std::path::Path>,
    pg_port_hint: u16,
    shared_state_dir: &std::path::Path,
    workspace_home: &std::path::Path,
    install_defect: &InstallDefectLatch,
    headless_service: bool,
) -> std::io::Result<Child> {
    // WI-5390: fail CLOSED on a structurally broken install instead of spawning a
    // command that cannot possibly work. Without this the spawn "succeeds" (the
    // wsl.exe / node wrapper starts), dies on chdir/MODULE_NOT_FOUND, and comes
    // back to the supervisor as an ordinary child exit — indistinguishable from a
    // crash, hence respawned forever.
    let missing = missing_sidecar_entrypoints(sidecar_dir);
    if !missing.is_empty() {
        let message = install_defect_message(sidecar_dir, &missing);
        install_defect.set(Some(message.clone()));
        eprintln!("[papercusp-desktop] FATAL: {message} (WI-5390)");
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, message));
    }
    install_defect.set(None);
    println!(
        "[papercusp-desktop] spawning serve --ensure (port hint {}) from {}{}",
        port_hint,
        runtime_sidecar_dir.unwrap_or(sidecar_dir).display(),
        if runtime_sidecar_dir.is_some() {
            " (WSL ext4 snapshot)"
        } else {
            ""
        }
    );

    let runtime_sidecar_dir = runtime_sidecar_dir.unwrap_or(sidecar_dir);
    let server_js = runtime_sidecar_dir.join("serve.mjs");
    let spa_dist = runtime_sidecar_dir.join("spa");
    let docs_root = runtime_sidecar_dir.join("internal-docs");
    let harness_dir = runtime_sidecar_dir.join("harness");
    // First-party app-templates bundled at sidecar/templates (build-desktop-sidecar.sh);
    // template-store.ts resolves them via PAPERCUSP_TEMPLATES_DIR (dev falls back to the
    // in-repo templates/ dir). local-first-party-template-bundling-2026-07-07.
    let templates_dir = runtime_sidecar_dir.join("templates");
    // First-party rubrics bundled at sidecar/rubrics — same design, for the rubric
    // store's bundled layer (dev falls back to the in-repo rubrics/ dir).
    // local-first-party-rubric-bundling-2026-07-07.
    let rubrics_dir = runtime_sidecar_dir.join("rubrics");
    // First-party goal packages bundled at sidecar/goal-packages — same design as
    // templates/rubrics above, for the goal-package store's bundled layer (dev
    // falls back to the in-repo goal-packages/ dir).
    // work-on-everything-goal-2026-08-23 P-007.
    let goal_packages_dir = runtime_sidecar_dir.join("goal-packages");
    let prompts_dir = runtime_sidecar_dir.join("prompts");
    let db_sql_dir = runtime_sidecar_dir.join("db-sql");
    // Installer-bundled hive seed (plan hive-seed-bundle-2026-07-04). Optional:
    // only carries a manifest.json when a release cut a real seed into
    // src-tauri/seed/ (a dev build ships only the placeholder README).
    // restore-hive-seed's resolveSeedDir manifest-checks it, so pointing at a
    // manifest-less dir is safe → unchanged cold join. The TS side ALSO
    // autodetects this dir from a sibling resource env, so this explicit pass is
    // belt-and-suspenders, not the sole channel.
    //
    // WHICH BUNDLES ACTUALLY CARRY IT (WI-6075 — do not read this as "every
    // build"): `seed/**/*` is declared ONLY in the overlays, never in the base
    // tauri.conf.json, because the seed is ~2GB and must not ship inside the GUI
    // product. Server installs — including the live-federation gate's archived
    // deb from bin/build-and-archive-deb.sh — get it via
    // tauri.server.conf.json. A plain `tauri build` — i.e. the GUI — deliberately
    // ships NO seed and never owns the sidecar. test/tauri-config-resources.test.js
    // pins that split; it had silently regressed for a while because nothing ran
    // it.
    //
    // The seed is a SIBLING of the sidecar dir, not inside it: the configs bundle
    // `seed/**` and `sidecar/**` as sibling resources, so both the packaged
    // layouts (Linux .deb `usr/lib/<Product>/seed`, macOS `Contents/Resources/
    // seed`) AND the dev layout (`src-tauri/seed` next to `src-tauri/sidecar`)
    // hold it at `<parent-of-sidecar>/seed`. The previous `sidecar_dir.join(
    // "seed")` pointed INSIDE the sidecar where nothing is bundled, and
    // resolveSeedDir dead-ended on it → every packaged install silently
    // cold-joined (full network re-clone) with its multi-GB seed unused (first
    // seeded Linux .deb E2E, WI-2902 2026-07-05).
    let seed_dir = sidecar_dir
        .parent()
        .map(|p| p.join("seed"))
        .unwrap_or_else(|| sidecar_dir.join("seed"));
    // Pre-migrated logical seed (first-boot fast path). New bundles carry a
    // pg_dump custom archive: the runtime runs a fresh per-install initdb first,
    // preserving a unique system_identifier, then restores schema/data. Keep the
    // old PGDATA tar fallback so upgraded runtimes can still boot older bundles.
    let logical_db_seed_path = sidecar_dir.join("db-seed.dump");
    let legacy_db_seed_path = sidecar_dir.join("db-seed.tar.gz");
    let db_seed_path = if logical_db_seed_path.exists() {
        logical_db_seed_path
    } else {
        legacy_db_seed_path
    };
    // PG data CANNOT live on DrvFs (/mnt/c) when the sidecar runs in WSL:
    // postmaster hard-requires a 0700/0750 data dir and DrvFs without the
    // metadata mount option can't hold one (found live 2026-06-11:
    // `FATAL: data directory ... has invalid permission`). Fsync-heavy PG
    // I/O over 9P would also crawl. Route it to the distro's ext4 under the
    // baked default user instead — forwarded WITHOUT /p translation (it is
    // already a Linux path). Consequence (documented in SHIPPING.md):
    // unregistering the distro deletes the database.
    let pg_data_dir: std::path::PathBuf = if via_wsl {
        std::path::PathBuf::from("/home/papercup/.papercusp/embedded-pg-data")
    } else {
        shared_state_dir.join("embedded-pg-data")
    };
    // WI-3308: writable extract target for the bundled dev/local runnable source
    // tree (sidecar/source.tar.zst — the "all-5-buttons" dogfood bundle). Distro-
    // local on WSL for the SAME reason as PGDATA above (node_modules native bins +
    // .bin symlinks can't live faithfully on DrvFs /mnt/c); shared across
    // workspaces on native (it's code, not per-workspace data). serve extracts the
    // archive here on first boot then sets PAPERCUSP_DEV_SOURCE_ROOT, which the
    // env-operator launcher's defaultDetectSourceRoot prefers.
    let dev_source_dir: std::path::PathBuf = if via_wsl {
        std::path::PathBuf::from("/home/papercup/.papercusp/dev-source")
    } else {
        shared_state_dir.join("dev-source")
    };

    // Per-workspace isolation: override HOME so serve (and any child process
    // it spawns — claude CLI, git, pi, etc.) sees a workspace-scoped home.
    // ~/.papercusp/ (operator.json, embedded-pg.json, endpoint-ipc.json,
    // superuser-token) all resolve into <workspace_home>/. See workspaces.rs.
    let workspace_home_str = workspace_home.to_string_lossy().to_string();
    let new_path = bundled_path_env(runtime_sidecar_dir);

    let preload = runtime_sidecar_dir.join("sidecar-preload.js");
    let mut cmd = make_sidecar_command(via_wsl, runtime_sidecar_dir, &preload, &server_js);
    cmd.arg("--ensure");
    // When routed via WSL, env vars must be listed in WSLENV to cross the
    // Windows→Linux boundary. The `/p` flag translates Windows paths.
    //
    // PATH is deliberately NOT forwarded: `PATH/l` used to be first in this
    // list, and the translated Windows PATH *replaced* the distro PATH inside
    // serve — /usr/bin et al vanished, so every distro-binary spawn from the
    // operator (kopia, locale, git) died ENOENT while the same binaries
    // worked from a fresh `wsl --exec` session (found live 2026-06-11,
    // P-010a). The bundled sidecar bin dir crosses as its own
    // PAPERCUSP_SIDECAR_BIN/p instead; serve prepends it to the DISTRO PATH
    // (see serve.ts main()). Bare `node` in make_sidecar_command still
    // resolves — the rootfs bakes node into /usr/local for exactly that
    // no-shell lookup (P-004).
    if via_wsl {
        cmd.env("WSLENV", sidecar_wslenv(runtime_sidecar_dir != sidecar_dir));
        // WI-3395: the sidecar runs INSIDE WSL2 (process.platform==='linux'),
        // where defaultSocketPath() would otherwise create a UNIX socket the
        // Windows-native webview host can't open (and can't create a `\\.\pipe\`
        // named pipe either) → endpoint-IPC silently disabled → `/api` falls
        // back to the capped WebView2 HTTP stack (fact
        // `windows-ipc-bypass-off-wsl2`). Tell the sidecar to bind a loopback
        // TCP port instead (`tcp://127.0.0.1:0`; the resolved port is reported
        // in endpoint-ipc.json), which WSL2 forwards from 127.0.0.1 to the host
        // — the same path the operator HTTP port rides. It can't be
        // self-detected from inside WSL2, so the launcher must set it.
        //
        // The two IPC vars are ALSO added to WSLENV above: `PAPERCUSP_IPC_ENABLE`
        // (set unconditionally below) previously did NOT cross the WSL boundary,
        // so under the packaged `NODE_ENV=production` the enable gate
        // (host-bootstrap.ts) was false inside WSL2 and the IPC server never
        // even STARTED on Windows — the deeper reason the bypass was off.
        cmd.env("PAPERCUSP_IPC_TCP", "1");
        // WI-37736 — DO NOT set PAPERCUSP_DESKTOP_PARENT_PID on this path, and do
        // not re-add it to SIDECAR_WSLENV (a test pins its absence).
        //
        // It carried OUR pid, which is a WINDOWS-NATIVE pid. The sidecar runs
        // inside WSL2 and compares that declared value against its own
        // `process.ppid` — a number from a DIFFERENT KERNEL and PID namespace.
        // The two can never legitimately be equal, so the parent-death watch
        // concluded "my parent died" on EVERY launch and shut the sidecar down
        // ~1s in, before it wrote operator.json. Windows 0.0.14-alpha shipped
        // with the UI rendering fine and every single data call failing.
        //
        // Unset is the CORRECT state, not a workaround: resolveExpectedParentPid()
        // then falls back to the module-load ppid, so both sides of the comparison
        // come from the same (WSL2) kernel — the documented reparent-only
        // semantics. It also disables the `declaredByLauncher` liveness leg, which
        // would otherwise pidAlive() a Windows pid number inside Linux and fire for
        // the same reason. BOTH legs have to stay off; fixing only one still kills
        // the sidecar.
    } else {
        // (EI-19486216732882752) Declare OUR pid so the sidecar's parent-death
        // watch has an IDENTITY to check rather than an observation to race.
        // Reading `process.ppid` on the sidecar side is only correct if it happens
        // before we die; if we die while it is still booting (concurrent packaged
        // e2e runs contend on its cold-start lock for seconds), it records the
        // already-reparented ppid as its "original" and goes blind forever — 8
        // orphans burning 3 cores and 18.4GB, measured 2026-08-08. With this set,
        // the sidecar can also ask "is that pid still alive?", which no amount of
        // ppid-watching can answer. Sidecar side: resolveExpectedParentPid() in
        // apps/operator/bin/serve.ts.
        //
        // Same-kernel platforms only (Linux/macOS, and any future non-WSL Windows
        // route) — see the WI-37736 note in the `if` branch for why WSL2 is excluded.
        // Packaged native launches are owned by the Tauri process. Keep the
        // parent-death watch explicit so a caller's inherited headless opt-out
        // cannot silently disable supervision in the GUI; the supported SSH
        // launcher sets this to 0 for its detached child instead.
        cmd.env("PAPERCUSP_PARENT_DEATH_WATCH", "1");
        cmd.env(
            "PAPERCUSP_DESKTOP_PARENT_PID",
            std::process::id().to_string(),
        );
    }
    cmd.env("PATH", &new_path)
        // The bundled bin dir, as its own var: on the WSL route it crosses
        // via WSLENV /p and serve prepends it to the distro PATH; on native
        // platforms the PATH above already carries it (harmless duplicate).
        .env(
            "PAPERCUSP_SIDECAR_BIN",
            runtime_sidecar_dir
                .join("bin")
                .to_string_lossy()
                .to_string(),
        )
        // serve reads PAPERCUSP_HONO_PORT (cold-start hint; reuse may differ).
        .env("PAPERCUSP_HONO_PORT", port_hint.to_string())
        .env("PAPERCUSP_BIND_HOST", "127.0.0.1")
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        // Build provenance: baked at compile time via option_env! when the
        // build exports PAPERCUSP_BUILD_SHA (e.g. bin/mac-vm-build.sh), then
        // forwarded so the operator's /api/health self-reports the git sha it
        // was built from (build-info.ts). Empty string when unset → build-info
        // falls back to git rev-parse (null in a packaged, .git-less app). This
        // makes "what commit is this build?" answerable on any shipped build.
        .env(
            "PAPERCUSP_BUILD_SHA",
            option_env!("PAPERCUSP_BUILD_SHA").unwrap_or(""),
        )
        // Same provenance mechanism, for the shipped app VERSION (WI-2644): the
        // bundled sidecar has no npm_package_version in its env (serve.mjs isn't
        // invoked by npm), so build-info.ts silently fell back to '0.0.0' on every
        // real desktop build. release-local.sh / build-windows-on-vm.sh export
        // PAPERCUSP_BUILD_VERSION (from tauri.conf.json's version) before
        // cargo build/tauri build; empty string when unset → build-info falls back
        // to npm_package_version, then '0.0.0'.
        .env(
            "PAPERCUSP_BUILD_VERSION",
            option_env!("PAPERCUSP_BUILD_VERSION").unwrap_or(""),
        )
        .env(
            "PAPERCUSP_DISTRIBUTION_PROFILE",
            baked_distribution_profile(),
        )
        // AUTO-UPDATE: where the shipped app looks for releases (WI-4389,
        // plan desktop-release-hosting-r2-2026-07-12 D-001..D-003).
        //
        // Releases are LOCAL-only [owner:Avi 2026-07-08] — never published to
        // GitHub — so the operator's /api/updates/manifest has nothing to
        // discover unless it is pointed at the static release host. Without
        // this, an installed app polls, gets a 204, and the Tauri updater reads
        // that as "you are up to date" — FOREVER, silently. Baking it into the
        // shipped env is what makes auto-update work at all on a real install
        // (the WI-3875 gap: "real Linux installs need this baked into the
        // shipping operator env").
        //
        // ⚠ This value is PERMANENT (D-003). An installed app polls
        // <host>/latest.json at this baked address forever; changing it strands
        // every existing install on a URL that no longer answers — and it fails
        // SILENTLY, because a failed check is indistinguishable from "no update"
        // to the updater. Only the MANIFEST location is pinned here: the artifact
        // URLs live inside latest.json and can move per release.
        //
        // A runtime env var still wins, so a test build can be pointed at a
        // staging host without a recompile; otherwise the compile-time bake
        // (release-local.sh exports it; build.rs has the matching
        // rerun-if-env-changed so cargo can't freeze a stale value) applies.
        .env("PAPERCUSP_RELEASE_HOST", baked_release_host())
        // The desktop webview consumes the SPA — keep the UI mounted (serve
        // alone defaults it OFF for headless use; Decision E).
        .env("PAPERCUSP_SERVE_UI", "1")
        .env(
            "PAPERCUSP_HARNESS_DIR",
            harness_dir.to_string_lossy().to_string(),
        )
        .env(
            "PAPERCUSP_TEMPLATES_DIR",
            templates_dir.to_string_lossy().to_string(),
        )
        .env(
            "PAPERCUSP_RUBRICS_DIR",
            rubrics_dir.to_string_lossy().to_string(),
        )
        .env(
            "PAPERCUSP_GOAL_PACKAGES_DIR",
            goal_packages_dir.to_string_lossy().to_string(),
        )
        .env("PAPERCUSP_DESKTOP", "1")
        // NOTE: PAPERCUSP_DESKTOP_PARENT_PID is deliberately NOT set here — it is
        // set in the `else` branch of the `if via_wsl` block above, because it is
        // MEANINGLESS (and actively harmful) across the WSL2 boundary. See WI-37736.
        // Autonomous loop (packaged-build fix): the DBOS routines engine +
        // orchestrator must be ON in the shipped sidecar — without these the
        // operator boots normally but schedules NO work (the loop is silently
        // off; only the dev `.env.local` set them). Placement is still gated to
        // STARTED hives, so a fresh install with no started hive runs the loop
        // but places nothing.
        .env("PAPERCUSP_DBOS_ENABLE", "1")
        .env("PAPERCUSP_DBOS_ROUTINES", "1")
        .env("PAPERCUSP_DBOS_ORCHESTRATOR", "1")
        // Env-switcher provisioning (packaged-build fix, WI-3284 — same
        // silently-off class as the DBOS trio above): the install-time
        // env-operator launcher (host-bootstrap.ts, P-017/D-006) is gated on
        // this + PAPERCUSP_DESKTOP=1, and NOTHING ever exported it — so no
        // shipped build provisioned the dev/prod/staging env operators and
        // the EnvSwitcherBar rendered every env permanently greyed
        // (owner-reported on the mac build 2026-07-06; owner directive: the
        // envs SHOULD all run on user builds). The launcher is idempotent +
        // graceful (skips already-served ports / missing source tree or
        // toolchain) and every spawned sibling is request-only (EI-126
        // single-writer), so arming it on every desktop sidecar spawn is safe.
        .env(
            "PAPERCUSP_PROVISION_ENV_OPERATORS",
            provision_env_operators_for(
                baked_distribution_profile(),
                headless_service,
                std::env::var("PAPERCUSP_PROVISION_ENV_OPERATORS").ok().as_deref(),
            ),
        )
        // Phase E (P-051): shared-operator model — per-spawn HOME comes from
        // each job's workspace, set operator-side.
        .env("PAPERCUSP_SHARED_OPERATOR", "1")
        // Descendants that need the operator's HTTP API (run.sh pg-status
        // helpers etc.) use this; the port is dynamic so env is the channel.
        .env(
            "PAPERCUSP_OPERATOR_BASE",
            format!("http://localhost:{}", port_hint),
        )
        // Hono host serves the Vite SPA + Starlight docs from these roots —
        // passed explicitly because a bundled file's __dirname is the sidecar
        // root (see host-spa.ts / host-docs.ts root-resolution comments).
        .env("PAPERCUSP_SPA_DIST", spa_dist.to_string_lossy().to_string())
        .env(
            "PAPERCUSP_DOCS_ROOT",
            docs_root.to_string_lossy().to_string(),
        )
        // Persona/tools prompt root — explicit because the cwd heuristics in
        // prompt-assembly.ts misfire in the sidecar layout: sidecar/apps/
        // operator/prompts exists (desktop-install playbook only) and would
        // shadow the full sidecar/prompts copy (see promptsDir()).
        .env(
            "PAPERCUSP_PROMPTS_DIR",
            prompts_dir.to_string_lossy().to_string(),
        )
        // PG knobs (SP1 C5: PG ownership moved into serve). The port is
        // freshly picked per spawn so two desktops on one host don't collide;
        // data lives in the SHARED state dir (one RLS-scoped PG for all
        // workspaces, D-006), migrations ship at sidecar/db-sql.
        .env("PAPERCUSP_PG_PORT", pg_port_hint.to_string())
        .env(
            "PAPERCUSP_PG_DATA_DIR",
            pg_data_dir.to_string_lossy().to_string(),
        )
        .env(
            "PAPERCUSP_PG_SQL_DIR",
            db_sql_dir.to_string_lossy().to_string(),
        )
        // Installer-bundled hive seed dir (first-boot seed-then-delta-join fast
        // path). Safe to set when only the placeholder is present — the operator
        // manifest-checks it (resolveSeedDir) and cold-joins if there's no seed.
        .env("PAPERCUSP_SEED_DIR", seed_dir.to_string_lossy().to_string())
        // Pre-migrated seed archive (first-boot fast path). Safe to set even when
        // the file is absent — serve existsSync-checks it and falls back to initdb.
        .env(
            "PAPERCUSP_PG_SEED_PATH",
            db_seed_path.to_string_lossy().to_string(),
        )
        .env(
            "PAPERCUSP_PG_RESTORE_BIN",
            runtime_sidecar_dir
                .join("bin/pg_restore")
                .to_string_lossy()
                .to_string(),
        )
        // WI-3308: the bundled dev/local runnable source tree + its writable
        // extract target. Safe to set unconditionally (like PG_SEED_PATH above) —
        // serve's extractDevSourceTree existsSync-checks the archive and no-ops
        // when a build shipped without PAPERCUSP_STAGE_SOURCE=1 (no source.tar.zst),
        // so dev/local stay skipped 'no-source-tree' exactly as before.
        .env(
            "PAPERCUSP_SOURCE_ARCHIVE",
            sidecar_dir
                .join("source.tar.zst")
                .to_string_lossy()
                .to_string(),
        )
        .env(
            "PAPERCUSP_DEV_SOURCE_DIR",
            dev_source_dir.to_string_lossy().to_string(),
        )
        .env(
            "PAPERCUSP_IDENTITY_DIR",
            shared_state_dir
                .join(".papercusp")
                .join("identity")
                .to_string_lossy()
                .to_string(),
        )
        .env(
            "PAPERCUSP_ANNOUNCE_IDENTITY_CACHE",
            shared_state_dir
                .join(".papercusp")
                .join("local-announce-identity.json")
                .to_string_lossy()
                .to_string(),
        )
        // The workspace registry lives ABOVE the per-workspace isolation
        // boundary; HOME below is remapped, so pass the real root explicitly
        // (workspace-registry.ts would otherwise resolve a nested registry).
        .env(
            "PAPERCUSP_WORKSPACES_ROOT",
            workspaces::workspaces_root().to_string_lossy().to_string(),
        )
        .env("HOME", &workspace_home_str)
        .env("USERPROFILE", &workspace_home_str); // Windows

    // PAPERCUSP_USE_EMBEDDED_PG passthrough: default ON (serve's default).
    // =0 attaches external PG via HARNESS_*_DATABASE_URL from our env, which
    // Command inherits by default.
    if let Ok(v) = std::env::var("PAPERCUSP_USE_EMBEDDED_PG") {
        cmd.env("PAPERCUSP_USE_EMBEDDED_PG", v);
    }

    // Endpoint IPC opt-in (default ON — it dodges WebKitGTK's ~6-connection
    // libsoup cap for the webview's SSE/fetch traffic). runBootstrap inside
    // serve starts the IPC server and writes endpoint-ipc.json; we read the
    // file rather than parse stdout, so stdout can stay inherited.
    let ipc_enabled = std::env::var("PAPERCUSP_DESKTOP_IPC").ok().as_deref() != Some("0");
    if ipc_enabled {
        cmd.env("PAPERCUSP_IPC_ENABLE", "1");
    }
    // Dev build: keep the inherited console (the `tauri dev` terminal). Release
    // (packaged) build: no console exists, so an inherited stdout/stderr is
    // /dev/null and every serve diagnostic is lost — tee to a rotated on-disk log
    // instead (WI-1707). If the log can't be prepared, fall back to inherit so
    // logging setup never blocks the sidecar from launching.
    if cfg!(debug_assertions) {
        cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    } else if let Some((out, err)) = rotating_log_stdio(workspace_home, "serve.log") {
        cmd.stdout(out).stderr(err);
    } else {
        cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    }

    #[cfg(target_os = "windows")]
    if via_wsl && runtime_sidecar_dir != sidecar_dir {
        normalize_wsl_runtime_env(&mut cmd);
    }
    cmd.spawn()
}

/// Spawn the background thread that supervises + respawns a `serve.mjs`
/// child we OWN, with a debounced-unreachable check + crash-loop cap.
///
/// WI-2667 (defect-2 gap fix): supervise our OWN serve.mjs child. The
/// GUI-side watcher's `open -b` CANNOT revive an operator that died
/// while this Server shell is still alive (single-instance dedupes the
/// launch → no-op), and nothing else reaps/restarts it — proved live on
/// the Mac VM 2026-07-04 (SIGTERM the operator → 100s, zero recovery, an
/// unreaped zombie). So the Server watches its child: `try_wait` REAPS
/// the zombie AND detects the exit, and we respawn serve in-process
/// (covers the headless-Server-no-GUI case too). Guards: `shutdown_done`
/// (normal quit / self-update — don't fight the teardown), an
/// operator-reachability check (don't double-spawn when `--ensure`
/// reused a foreign operator, Decision C), and a crash-loop cap.
fn spawn_serve_supervisor(
    app_handle: tauri::AppHandle,
    via_wsl: bool,
    port: u16,
    sidecar_dir: std::path::PathBuf,
    runtime_sidecar_dir: Option<std::path::PathBuf>,
    pg_port_hint: u16,
    shared_state_dir: std::path::PathBuf,
    workspace_home: std::path::PathBuf,
) {
    const RESPAWN_WINDOW: Duration = Duration::from_secs(300);
    const MAX_RESPAWNS_PER_WINDOW: usize = 5;
    // WI-3170: how long the operator must be CONTINUOUSLY unreachable
    // (while our serve `Child` still looks alive — on Windows the Child
    // is the wsl.exe WRAPPER, which outlives a dead inner node) before
    // we respawn it. Only armed AFTER the operator has come up once this
    // session (see `ever_reachable`), so a slow cold boot (serve.mjs
    // alive, initdb + migration replay not yet serving) never trips it
    // and double-spawns a competing serve.
    const SERVE_UNREACHABLE_DEBOUNCE: Duration = Duration::from_secs(15);
    let sup_handle = app_handle;
    let sup_via_wsl = via_wsl;
    let sup_port = port;
    let sup_pg_hint = pg_port_hint;
    let sup_sidecar = sidecar_dir;
    let sup_runtime_sidecar = runtime_sidecar_dir;
    let sup_shared = shared_state_dir;
    let sup_home = workspace_home;
    std::thread::spawn(move || {
        let mut respawn_times: Vec<Instant> = Vec::new();
        // WI-3170: start of the current continuous-unreachable streak
        // (None while reachable), and whether the operator has EVER been
        // reachable this session — the latter arms the child-alive
        // respawn path only post-boot so a slow cold boot can't trip it.
        let mut unreachable_since: Option<Instant> = None;
        let mut ever_reachable = false;
        // WI-3270 transition latches: the Windows→WSL forward reading
        // degraded (operator healthy INSIDE the distro, unreachable from
        // outside) and the give-up notification (once per dead episode).
        let mut forward_degraded = false;
        let mut gave_up_notified = false;
        // WI-5390: the broken-install notification, once per defect episode
        // (cleared if a reinstall repairs the install under us).
        let mut install_broken_notified = false;
        // WI-3360: whether we've already `wsl --terminate`d a WEDGED distro this
        // outage — one reset per dead episode (cleared when the operator
        // recovers) so we never terminate-loop a distro that stays down for a
        // reason a reset can't fix.
        #[cfg(target_os = "windows")]
        let mut distro_reset_done = false;
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            // WI-3270 (c): refresh the shell-liveness beacon so the
            // bundle watcher can tell "shell alive, operator dead —
            // defer" from "shell gone — relaunch the bundle".
            write_server_shell_heartbeat(&sup_home);
            let state: tauri::State<SidecarState> = sup_handle.state();
            let shutting_down = state
                .shutdown_done
                .load(std::sync::atomic::Ordering::SeqCst);
            // Detect + REAP an exited serve child (drops the lock before
            // the reachability probe, which also locks state.child).
            let child_exited = {
                let mut guard = state.child.lock().unwrap();
                match guard.as_mut() {
                    Some(c) => matches!(c.try_wait(), Ok(Some(_))),
                    // No child we own → treat as exited; the
                    // reachability guard below still gates the respawn.
                    None => true,
                }
            };
            let outer_reachable = wait_for_operator(
                &sup_handle,
                &sup_home,
                sup_via_wsl,
                Duration::from_millis(600),
            )
            .is_ok();
            // WI-3270 (a): on Windows the probe above crosses the
            // Windows→WSL localhost forward, which flakes independently
            // of operator health. Killing a healthy serve+PG over a
            // forward flake is the WI-3270 false alarm (it exhausted
            // both respawn caps and took the whole distro down), so
            // before treating "unreachable from outside" as death,
            // re-ask from INSIDE the distro: inner-healthy means the
            // FORWARD is degraded, not the operator.
            let inner_reachable = if !outer_reachable && sup_via_wsl {
                find_operator_discovery(&sup_home, sup_via_wsl)
                    .map(|d| operator_http_ready_in_distro(d.port))
                    .unwrap_or(false)
            } else {
                false
            };
            let operator_reachable = outer_reachable || inner_reachable;
            // Transition-only forward-degraded logging (WI-3270 (d)).
            if inner_reachable {
                if !forward_degraded {
                    eprintln!(
                        "[papercusp-desktop] operator HEALTHY inside the distro but \
                         unreachable from Windows — localhost forward degraded, NOT a \
                         dead operator; suppressing respawn until the forward recovers \
                         (WI-3270)"
                    );
                    forward_degraded = true;
                }
            } else if forward_degraded {
                if outer_reachable {
                    eprintln!(
                        "[papercusp-desktop] Windows→WSL localhost forward recovered \
                         (WI-3270)"
                    );
                } else {
                    eprintln!(
                        "[papercusp-desktop] operator no longer answers inside the \
                         distro either — treating as a real operator death, not a \
                         forward flake (WI-3270)"
                    );
                }
                forward_degraded = false;
            }
            let now = Instant::now();
            respawn_times.retain(|t| now.duration_since(*t) < RESPAWN_WINDOW);
            // WI-3170: track the continuous-unreachable streak. The
            // child-alive-but-unreachable respawn path (the Windows/WSL
            // wrapper blind spot) only arms once the operator has served
            // at least once this session, so a slow cold first boot can
            // never double-spawn a competing serve.
            if operator_reachable {
                unreachable_since = None;
                ever_reachable = true;
                gave_up_notified = false;
                // WI-3360: recovery = a fresh outage budget; a FUTURE wedge
                // earns another one-shot `wsl --terminate`.
                #[cfg(target_os = "windows")]
                {
                    distro_reset_done = false;
                }
            } else if unreachable_since.is_none() {
                unreachable_since = Some(now);
                // WI-3270 (d): say WHY the operator reads unreachable,
                // once per streak — a missing discovery, a dead pid, and
                // a hung HTTP probe are different failures, and the VM
                // forensics burned hours re-deriving which one it was.
                match find_operator_discovery(&sup_home, sup_via_wsl) {
                    None => eprintln!(
                        "[papercusp-desktop] operator unreachable: no operator.json \
                         discovery readable (WI-3270)"
                    ),
                    Some(d) => {
                        let pid_alive = discovery_pid_alive(d.pid, sup_via_wsl);
                        eprintln!(
                            "[papercusp-desktop] operator unreachable: discovery pid {} \
                             on :{} — pid_alive={}, HTTP probe failed (WI-3270)",
                            d.pid, d.port, pid_alive
                        );
                    }
                }
            }
            // Gate to the WSL routing (Windows): that is the ONLY place
            // the stored `Child` is a WRAPPER (wsl.exe) that can outlive
            // the inner operator, making child_exited unreliable. On
            // Linux/mac the child IS the operator process, so child_exited
            // is ground truth and we keep the exact existing behavior —
            // this path never arms there (WI-3170, surgical scope).
            let unreachable_respawn_ready = serve_unreachable_respawn_ready(
                sup_via_wsl,
                ever_reachable,
                unreachable_since.map(|t| now.duration_since(t)),
                SERVE_UNREACHABLE_DEBOUNCE,
            );
            // WI-5390: re-checked every tick rather than latched, so an install
            // repaired underneath us (a reinstall over the running app) heals on
            // the next tick instead of needing this supervisor restarted.
            let missing_entrypoints = missing_sidecar_entrypoints(&sup_sidecar);
            match decide_serve_respawn(
                child_exited,
                shutting_down,
                operator_reachable,
                unreachable_respawn_ready,
                !missing_entrypoints.is_empty(),
                respawn_times.len(),
                MAX_RESPAWNS_PER_WINDOW,
            ) {
                ServeRespawnAction::Healthy => {
                    // Install is intact (or a foreign operator serves us) — clear
                    // any latched defect so the updater stops reporting it.
                    if missing_entrypoints.is_empty() {
                        set_install_defect(None);
                        install_broken_notified = false;
                    }
                }
                ServeRespawnAction::Suppressed => return,
                ServeRespawnAction::InstallBroken => {
                    // Terminal by nature: no respawn can conjure the missing
                    // files back. Say it ONCE, loudly, through the same channels
                    // as operator-dead (in-app event + OS notification), then keep
                    // ticking silently in case a reinstall repairs it.
                    let message = install_defect_message(&sup_sidecar, &missing_entrypoints);
                    set_install_defect(Some(message.clone()));
                    if !install_broken_notified {
                        eprintln!(
                            "[papercusp-desktop] FATAL: {message} — NOT respawning (WI-5390)"
                        );
                        notify_install_broken(&sup_handle, &message);
                        install_broken_notified = true;
                    }
                }
                ServeRespawnAction::GiveUp => {
                    // WI-3270 (b): do NOT exit the supervisor thread —
                    // a cap hit is a backoff, not a terminal state (the
                    // old `return` here is why the VM outage needed a
                    // manual app restart). respawn_times drains on the
                    // window, after which decide_serve_respawn resumes
                    // Respawn — a slow retry tier; on Windows the
                    // respawn re-boots a dead distro, so this heals the
                    // whole observed outage class.
                    if !gave_up_notified {
                        eprintln!(
                            "[papercusp-desktop] serve.mjs respawn cap hit ({} in {}s) — \
                             backing off; will retry once the respawn window drains \
                             (WI-2667 / WI-3270)",
                            MAX_RESPAWNS_PER_WINDOW,
                            RESPAWN_WINDOW.as_secs()
                        );
                        notify_operator_dead(
                            &sup_handle,
                            "serve.mjs in-process respawn cap hit",
                            MAX_RESPAWNS_PER_WINDOW,
                            RESPAWN_WINDOW.as_secs(),
                        );
                        gave_up_notified = true;
                    }
                    // WI-3360: a cap hit on Windows can mean the WSL distro's
                    // exec layer is WEDGED — the respawn storm drove the WSL2
                    // interop into a state where every `wsl.exe --exec` returns
                    // a dead child, so re-spawning serve into it can NEVER
                    // recover (the operator stays down until a MANUAL
                    // `wsl --terminate`, which no end user will know to run —
                    // the exact VM brick observed 2026-07-08). If a trivial
                    // exec confirms the wedge, terminate the distro (it
                    // cold-boots on the next exec, no data loss) and clear the
                    // respawn window so the VERY NEXT tick respawns serve into a
                    // FRESH distro. One-shot per outage (distro_reset_done).
                    #[cfg(target_os = "windows")]
                    if sup_via_wsl && !distro_reset_done {
                        if distro_exec_wedged(Duration::from_secs(6)) {
                            eprintln!(
                                "[papercusp-desktop] WSL distro exec WEDGED after respawn cap — \
                                 `wsl --terminate {}` to reset it, then respawning serve into the \
                                 fresh distro (WI-3360)",
                                wsl_setup::DISTRO_NAME_PUB
                            );
                            if terminate_distro() {
                                respawn_times.clear();
                                unreachable_since = None;
                                gave_up_notified = false;
                                distro_reset_done = true;
                            } else {
                                eprintln!(
                                    "[papercusp-desktop] `wsl --terminate` failed — will retry \
                                     next cap window (WI-3360)"
                                );
                            }
                        } else {
                            // Distro exec is fine; the crash has some other
                            // cause. Don't terminate a healthy distro (that
                            // would needlessly kill a working PG); mark done so
                            // we don't re-probe every tick this outage.
                            distro_reset_done = true;
                        }
                    }
                }
                ServeRespawnAction::Respawn => {
                    eprintln!(
                        "[papercusp-desktop] operator unreachable and not recovering \
                         (serve child_exited={child_exited}) — respawning serve.mjs \
                         in-process (WI-2667 / WI-3170 Windows wrapper blind spot)"
                    );
                    match spawn_serve(
                        sup_via_wsl,
                        sup_port,
                        &sup_sidecar,
                        sup_runtime_sidecar.as_deref(),
                        sup_pg_hint,
                        &sup_shared,
                        &sup_home,
                        &INSTALL_DEFECT,
                        false,
                    ) {
                        Ok(c) => {
                            *state.child.lock().unwrap() = Some(c);
                            respawn_times.push(now);
                            // Restart the unreachable streak so the fresh
                            // child gets a full debounce to come up before
                            // we would respawn again (WI-3170).
                            unreachable_since = None;
                        }
                        Err(e) => {
                            eprintln!("[papercusp-desktop] serve.mjs respawn failed: {e}");
                        }
                    }
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Workspace tauri commands
//
// Exposed to the operator UI via `invoke('plugin:...')` — see
// apps/operator/lib/workspaces-tauri.ts for the typed wrapper. Switching
// kills the running sidecar + embedded-postgres-server and restarts the entire app, which
// is the cleanest way to swap a fake-HOME under a process tree mid-flight.
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[derive(serde::Serialize, specta::Type)]
struct UpdateInfo {
    available: bool,
    current_version: String,
    new_version: Option<String>,
    notes: Option<String>,
    /// The update check could not actually be performed — the release host was
    /// unreachable, throttled, or never configured. DISTINCT from `available:
    /// false`, which means "checked, and you are current".
    ///
    /// The Tauri updater protocol has no slot for this: a 204 means "no update",
    /// and the plugin hands back `Ok(None)` whether we compared versions or
    /// never got an answer at all. So an unreachable host reads to the user as
    /// "you are up to date" — silently, forever, and indistinguishable from
    /// success. That is the worst failure mode an updater can have, and it is
    /// exactly how a 0.0.8 with no release host baked in would present: eternally
    /// current, never updating, saying nothing.
    check_failed: bool,
    /// Why the check could not be performed (`no_token` / `fetch_failed` /
    /// `no_candidate` / `manifest_unconfigured`), when the sidecar reports one.
    check_reason: Option<String>,
}

/// Ask the sidecar whether its 204 meant "up to date" or "could not check".
///
/// The sidecar has known the difference since WI-3697 and says so in
/// `X-Update-Check: up_to_date | cannot_check` (+ `X-Update-Reason`) — but the
/// updater plugin parses no headers on a 204, so nothing had ever read them and
/// the distinction died at the wire. Re-ask the same loopback endpoint and read
/// them, so a failed check can be surfaced AS a failed check.
///
/// Loopback + only on the no-update path, so the extra request is cheap. Any
/// failure to probe leaves the verdict unchanged rather than inventing one.
async fn probe_update_check_status(endpoint: String) -> Option<(String, Option<String>)> {
    tokio::task::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .ok()?;
        let res = client.get(&endpoint).send().ok()?;
        let check = res
            .headers()
            .get("x-update-check")?
            .to_str()
            .ok()?
            .to_string();
        let reason = res
            .headers()
            .get("x-update-reason")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        Some((check, reason))
    })
    .await
    .ok()
    .flatten()
}

/// Is the running bundle the "Papercusp Server" product (vs "Papercusp GUI")?
/// Resolved from the bundle's `productName` — the same signal the release
/// pipeline uses to name Server-vs-GUI artifacts (WI-3696), so it stays in
/// lockstep with what `resolve_update_endpoint`/`resolve_rollback_endpoint`
/// actually request from the manifest route. (Deliberately NOT
/// `app_role::detect`, which keys off the bundle *identifier* for a related
/// but distinct purpose — who owns/spawns the sidecar.) WI-4404: this used to
/// be duplicated inline at both call sites; centralized so a future product-
/// name convention change only needs one edit.
fn is_server_product(app: &AppHandle) -> bool {
    app.config()
        .product_name
        .as_deref()
        .map(|n| n.to_ascii_lowercase().contains("server"))
        .unwrap_or(false)
}

/// Build the per-call updater endpoint targeted at the operator sidecar.
///
/// We don't hardcode a single static URL in `tauri.conf.json` because:
///   1. The operator picks a free port at boot — known only at runtime.
///   2. We want the operator's PG-backed `setup_wizard_state.update_channel`
///      to drive which channel's release is served, without baking the
///      channel into compile-time config.
///
/// (P-052) `tauri.conf.json` therefore ships NO static `endpoints` entry:
/// the old baked URL (`https://127.0.0.1:3055/...`) could never work — TLS
/// against a plain-HTTP port the packaged sidecar doesn't even use — so
/// every plugin-driven background check failed. The conf keeps
/// `dangerousInsecureTransportProtocol: true` so the loopback-http URL built
/// here passes the updater's release-build https validation (loopback-only,
/// no transport exposure).
///
/// The operator route at `/api/updates/manifest` handles channel
/// resolution: query-param wins, then stored preference, then 'stable'.
/// Tauri substitutes `{{target}}`, `{{arch}}`, and `{{current_version}}`
/// when it issues the GET.
fn resolve_update_endpoint(app: &AppHandle) -> Result<String, String> {
    let port: u16 = if cfg!(debug_assertions) {
        // Dev: no sidecar process to read a port from — follow the operator
        // the desktop currently targets (devUrl is :3070; the dev wrapper's
        // build switcher retargets SELECTED_API_PORT per selected build,
        // EI-190). The old hardcoded 3055 pointed at Vite, which doesn't
        // serve /api/updates/manifest at all (P-052).
        SELECTED_API_PORT.load(std::sync::atomic::Ordering::Relaxed)
    } else {
        let state: tauri::State<SidecarState> = app.state();
        let guard = state.port.lock().map_err(|e| e.to_string())?;
        guard.ok_or_else(sidecar_port_unavailable_message)?
    };
    // GUI and Server are two products built from this same codebase
    // (tauri.server.conf.json overlays productName) — release assets are
    // product-named, so the manifest route scopes asset matching by this
    // param (desktop-auto-update-operational-2026-07-09 P-003). Without
    // it the route could hand the GUI a Server installer or vice versa.
    let product = if is_server_product(app) {
        "server"
    } else {
        "gui"
    };
    Ok(format!(
        "http://127.0.0.1:{}/api/updates/manifest?target={{{{target}}}}&arch={{{{arch}}}}&current_version={{{{current_version}}}}&product={}",
        port, product
    ))
}

#[tauri::command]
#[specta::specta]
async fn check_for_update(app: AppHandle) -> Result<UpdateInfo, String> {
    use tauri_plugin_updater::UpdaterExt;
    let endpoint = resolve_update_endpoint(&app)?;
    let url = url::Url::parse(&endpoint).map_err(|e| e.to_string())?;
    let current = env!("CARGO_PKG_VERSION").to_string();
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            available: true,
            current_version: current,
            new_version: Some(update.version.clone()),
            notes: update.body.clone(),
            check_failed: false,
            check_reason: None,
        }),
        // `Ok(None)` is the ambiguous one: a 204 that may mean "you are current"
        // OR "we never reached the release host". Ask the sidecar which it was
        // instead of assuming the happy one.
        Ok(None) => {
            let (check_failed, check_reason) = match probe_update_check_status(endpoint).await {
                Some((check, reason)) if check == "cannot_check" => (true, reason),
                _ => (false, None),
            };
            Ok(UpdateInfo {
                available: false,
                current_version: current,
                new_version: None,
                notes: None,
                check_failed,
                check_reason,
            })
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Payload for the `update-download-progress` webview event (WI-5011). Fired
/// repeatedly during `install_update` / `revert_to`'s download phase so the
/// Update Center can render a real progress bar instead of a bare spinner for
/// what is otherwise a multi-GB, multi-minute wait. `total` is `None` when the
/// release host didn't send a `Content-Length` (rare) — the UI falls back to
/// a byte-count-only display in that case.
#[derive(Debug, serde::Serialize, Clone)]
struct UpdateDownloadProgressPayload {
    downloaded: u64,
    total: Option<u64>,
}

/// Pure throttle decision for `make_download_progress_reporter`, split out so
/// it's unit-testable without a live `AppHandle`: should THIS chunk trigger
/// an `update-download-progress` emit? Chunks arrive far more often than any
/// UI needs to redraw (network-buffer-sized, often <64KB against a multi-GB
/// payload), so the reporter only emits when either ~150ms have elapsed
/// since the last emit or the download has completed — bounding event volume
/// to a handful per second regardless of chunk granularity, while still
/// guaranteeing the final 100% emit is never swallowed by the throttle.
fn should_emit_download_progress(
    downloaded: u64,
    total: Option<u64>,
    ms_since_last_emit: u128,
) -> bool {
    let complete = total.map(|t| downloaded >= t).unwrap_or(false);
    complete || ms_since_last_emit >= 150
}

/// Build the `on_chunk` callback for `Update::download_and_install` that
/// turns the plugin's raw per-chunk byte deltas into throttled
/// `update-download-progress` webview events (see
/// `should_emit_download_progress` for the throttle policy).
fn make_download_progress_reporter(app: AppHandle) -> impl FnMut(usize, Option<u64>) {
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    move |chunk_length: usize, total: Option<u64>| {
        downloaded += chunk_length as u64;
        let now = std::time::Instant::now();
        if should_emit_download_progress(
            downloaded,
            total,
            now.duration_since(last_emit).as_millis(),
        ) {
            last_emit = now;
            let _ = app.emit(
                "update-download-progress",
                UpdateDownloadProgressPayload { downloaded, total },
            );
        }
    }
}

#[cfg(test)]
mod download_progress_throttle_tests {
    use super::should_emit_download_progress;

    #[test]
    fn emits_once_150ms_have_elapsed() {
        assert!(should_emit_download_progress(1_000, Some(10_000), 150));
        assert!(should_emit_download_progress(1_000, Some(10_000), 500));
    }

    #[test]
    fn suppresses_a_chunk_that_arrives_before_the_throttle_window() {
        assert!(!should_emit_download_progress(1_000, Some(10_000), 0));
        assert!(!should_emit_download_progress(1_000, Some(10_000), 149));
    }

    #[test]
    fn always_emits_the_completing_chunk_even_inside_the_throttle_window() {
        // WI-5011: the final chunk must land a 100% event immediately —
        // never wait out the throttle and leave the UI stuck at <100%.
        assert!(should_emit_download_progress(10_000, Some(10_000), 0));
        assert!(should_emit_download_progress(12_000, Some(10_000), 0)); // over-total chunk still counts as complete
    }

    #[test]
    fn no_content_length_falls_back_to_pure_time_throttling() {
        // The release host omitted Content-Length (rare) — total is None, so
        // "complete" can never be inferred; only the time throttle governs.
        assert!(!should_emit_download_progress(999_999, None, 0));
        assert!(should_emit_download_progress(999_999, None, 150));
    }
}

/// Download → VERIFY → tear the sidecar down → install, in that order.
///
/// WI-2144851 (P-007, "verify signed updates / rollback FAILURE cases"): the
/// obvious call, `Update::download_and_install(on_chunk, on_download_finish)`,
/// invokes its `on_download_finish` hook BEFORE the minisign check. Measured at
/// the crate source — `tauri-plugin-updater-2.10.1/src/updater.rs`:
///
/// ```text
///   710:  on_download_finish();
///   712:  verify_signature(&buffer, &self.signature, &self.config.pubkey)?;
/// ```
///
/// Passing the sidecar teardown as that hook therefore tore the operator down
/// for an artifact whose signature had NOT been checked yet. When the check then
/// REJECTED the artifact — the security control working exactly as intended, and
/// the only barrier left once `dangerousInsecureTransportProtocol` is on — the
/// `?` returned before `app.restart()`, leaving the app with a killed sidecar and
/// a LATCHED `shutdown_done`. `spawn_serve_supervisor` reads that latch as
/// "normal quit / self-update — don't fight the teardown" and never respawns, so
/// a correctly-refused update (bad signature, tampered bytes, truncated download)
/// bricked the running app until the user manually quit and relaunched it. The
/// same hazard covers the deliberate-downgrade path, which is the rollback half
/// of the same sub-goal.
///
/// Splitting the plugin call restores the ordering the teardown comment always
/// claimed: `download()` returns ONLY after `verify_signature` succeeds, so the
/// teardown now runs on a VERIFIED payload, immediately before the swap — which
/// still satisfies EI-9002 (the bytes stream through the sidecar's own
/// `/api/updates` proxy, so it must stay up for the whole download) and WI-2667
/// (flag `shutdown_done` FIRST so the Server-side serve supervisor does not
/// respawn the operator we are about to swap out). If the swap ITSELF fails, the
/// latch is cleared so the supervisor revives the operator instead of leaving a
/// half-updated app with no backend.
async fn download_verify_then_install(
    app: &AppHandle,
    update: tauri_plugin_updater::Update,
) -> Result<(), String> {
    let progress_reporter = make_download_progress_reporter(app.clone());
    // Nothing is torn down until this returns, and it only returns on a payload
    // whose signature verified against the pubkey baked into tauri.conf.json.
    let bytes = update
        .download(progress_reporter, || {})
        .await
        .map_err(|e| e.to_string())?;

    let set_shutdown = |done: bool| {
        let state: tauri::State<SidecarState> = app.state();
        state
            .shutdown_done
            .store(done, std::sync::atomic::Ordering::SeqCst);
    };

    // Verified payload in hand — NOW tear the sidecar down (children must not
    // outlive the parent across the binary swap).
    set_shutdown(true);
    kill_sidecar(app);

    if let Err(e) = update.install(bytes) {
        // The swap failed with the sidecar already down. Un-latch so the
        // supervisor stops reading this as a deliberate teardown and revives the
        // operator, then surface the real failure to the caller.
        set_shutdown(false);
        return Err(e.to_string());
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    // Linux: the plugin's only install path is an AppImage self-swap. On a
    // .deb install (no APPIMAGE env) the swap fails mid-flight with an opaque
    // rename/permission error — fail EARLY with the sentinel the UpdateChip
    // fallback matches (it opens the releases page instead).
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_none() {
        return Err(
            "no_compatible_assets: this Linux install is not an AppImage — auto-swap unavailable"
                .to_string(),
        );
    }
    let endpoint = resolve_update_endpoint(&app)?;
    let url = url::Url::parse(&endpoint).map_err(|e| e.to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;

    // EI-9002 (P-007 linux E2E, 2026-07-10): the update bytes stream through
    // the sidecar's OWN /api/updates proxy — the download URL captured by
    // `updater.check()` points at it. Killing the sidecar BEFORE the download
    // destroys that endpoint mid-fetch (host log: GET 200 → ConnectionResetError),
    // the update silently no-ops, and the old version keeps running. So the
    // teardown lands AFTER the payload is fully on hand AND VERIFIED, BEFORE the
    // binary swap — see `download_verify_then_install` for why that ordering
    // cannot be expressed as `download_and_install`'s `on_download_finish` hook.
    download_verify_then_install(&app, update).await?;

    // tauri-plugin-process is in scope so we can restart cleanly.
    app.restart();
}

/// WI-4404: the Server product has NO webview, so `check_for_update` /
/// `install_update` — normally invoked only from UpdateChip.tsx / StepAutoUpdate.tsx
/// via the JS `invoke()` bridge — had NO caller at all for it. Confirmed via
/// exhaustive grep: before this, `check_for_update` was referenced only at its own
/// `#[tauri::command]` decl and in `generate_handler!`. The Server manifest gap
/// (`latest-server.json`, fixed earlier this item) was necessary but not sufficient:
/// answering a poll that never happens fixes nothing on its own.
///
/// This spawns the poll loop that makes the Server actually check. It deliberately
/// does NOT auto-install: the GUI's OWN documented design is "nothing installs on
/// its own — every install path is behind a confirm" (UpdateChip.tsx). An unattended
/// silent restart of the backend `psu` and every agent session are attached to is a
/// materially bigger footgun than a stale binary, and no plan/doc states an intent
/// to auto-restart the Server unattended — so this poller surfaces the result (tray
/// item + native notification) and leaves the actual install/restart behind the
/// tray's "Install Update" click (the Server's only available confirm gesture, since
/// it has no window to run a webview confirm dialog in). A human — or an agent
/// driving the tray via capability:terminal/OS automation — triggers the swap
/// explicitly, exactly as the GUI's confirm+click already does.
///
/// Runs only when `is_server_product` (the caller gates it further by only calling
/// this from the Server-only half of `setup()`, but the check is repeated here too
/// so this fn is safe to call unconditionally from anywhere in the future).
/// Interval + startup grace are env-overridable for tests/local iteration; errors
/// (most commonly "sidecar port not yet known" very early in boot) are logged and
/// retried next tick — this must never panic the Server's setup thread.
///
/// EI-13939: a build that predates this poller (or whose call site never runs)
/// produces ZERO log lines, ever — indistinguishable from "polled and found
/// nothing to do", so "the poller is silently absent" reads as healthy forever.
/// `update_poll_heartbeat_line` is the fix for the "checked, nothing to install"
/// branch: it prints an UNCONDITIONAL line every tick (not just when an update is
/// found), so ANY installed build that actually contains a poller is provably
/// distinguishable in the logs from one that doesn't, purely by "did the grace
/// period elapse with no heartbeat line at all". It also stops silently discarding
/// `UpdateInfo.check_failed`/`check_reason` (WI-3697 computed these — "the check
/// could not be performed" vs "checked, you are current" — but the poller loop
/// never read them, so a persistently-unreachable release host looked identical
/// to "up to date" in the logs, the same silent-failure class this item is about).
fn update_poll_heartbeat_line(info: &UpdateInfo) -> String {
    if info.check_failed {
        let reason = info.check_reason.as_deref().unwrap_or("unknown");
        format!(
            "[papercusp-server] update check: COULD NOT CHECK (reason={reason}, current=v{}) — will retry next tick",
            info.current_version
        )
    } else {
        format!(
            "[papercusp-server] update check: up to date (v{})",
            info.current_version
        )
    }
}

#[cfg(test)]
mod update_poll_heartbeat_tests {
    use super::{update_poll_heartbeat_line, UpdateInfo};

    fn info(check_failed: bool, check_reason: Option<&str>) -> UpdateInfo {
        UpdateInfo {
            available: false,
            current_version: "0.0.12".to_string(),
            new_version: None,
            notes: None,
            check_failed,
            check_reason: check_reason.map(str::to_string),
        }
    }

    #[test]
    fn genuinely_up_to_date_is_reported_as_such() {
        let line = update_poll_heartbeat_line(&info(false, None));
        assert!(line.contains("up to date"));
        assert!(line.contains("0.0.12"));
        assert!(!line.contains("COULD NOT CHECK"));
    }

    #[test]
    fn a_failed_check_is_never_reported_as_up_to_date() {
        // EI-13939: this is the exact silent-failure class — a check that
        // could not be performed must NEVER read the same as "you are current".
        let line = update_poll_heartbeat_line(&info(true, Some("fetch_failed")));
        assert!(line.contains("COULD NOT CHECK"));
        assert!(line.contains("fetch_failed"));
        assert!(!line.contains("up to date"));
    }

    #[test]
    fn a_failed_check_with_no_reason_still_says_so_rather_than_panicking() {
        let line = update_poll_heartbeat_line(&info(true, None));
        assert!(line.contains("COULD NOT CHECK"));
        assert!(line.contains("unknown"));
    }
}

fn spawn_server_update_poller(app: &tauri::App) {
    let handle = app.handle().clone();
    if !is_server_product(&handle) {
        return;
    }
    handle.manage(ServerUpdateState {
        pending_version: std::sync::Mutex::new(None),
    });

    let grace_secs: u64 = std::env::var("PAPERCUSP_SERVER_UPDATE_POLL_GRACE_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5 * 60); // 5m: let boot settle before the first check.
    let interval_secs: u64 = std::env::var("PAPERCUSP_SERVER_UPDATE_POLL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(6 * 60 * 60); // 6h: matches typical desktop-app update cadence.

    tauri::async_runtime::spawn(async move {
        println!(
            "[papercusp-server] update poller starting — grace={grace_secs}s interval={interval_secs}s"
        );
        tokio::time::sleep(Duration::from_secs(grace_secs)).await;
        let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
        loop {
            ticker.tick().await;
            // Skip a re-poll while a version is already pending install — no point
            // re-checking until the operator either installs it or a NEWER one ships;
            // the manifest would just keep answering the same candidate.
            let already_pending = handle
                .try_state::<ServerUpdateState>()
                .and_then(|s| s.pending_version.lock().ok().map(|g| g.is_some()))
                .unwrap_or(false);
            if already_pending {
                continue;
            }
            match check_for_update(handle.clone()).await {
                Ok(info) if info.available => {
                    let version = info.new_version.clone().unwrap_or_default();
                    println!("[papercusp-server] update available: v{version}");
                    if let Some(state) = handle.try_state::<ServerUpdateState>() {
                        if let Ok(mut guard) = state.pending_version.lock() {
                            *guard = Some(version.clone());
                        }
                    }
                    if let Ok(menu) = build_server_tray_menu(&handle) {
                        if let Some(tray) = handle.tray_by_id("papercusp-server") {
                            let _ = tray.set_menu(Some(menu));
                        }
                    }
                    use tauri_plugin_notification::NotificationExt;
                    let _ = handle
                        .notification()
                        .builder()
                        .title("Papercusp Server update available")
                        .body(format!(
                            "v{version} is ready — open the tray menu to install."
                        ))
                        .show();
                }
                Ok(info) => {
                    // EI-13939: an UNCONDITIONAL per-tick heartbeat — never skip
                    // logging just because there was "nothing to do". Silence must
                    // not be mistaken for "polled and healthy"; see
                    // `update_poll_heartbeat_line`'s doc comment.
                    println!("{}", update_poll_heartbeat_line(&info));
                }
                Err(e) => {
                    eprintln!("[papercusp-server] update check failed (will retry next tick): {e}");
                }
            }
        }
    });
}

/// Build the per-call rollback endpoint for a SPECIFIC release `tag`, targeted at
/// the operator sidecar's `/api/updates/rollback` route (desktop-update-center-and-
/// release-tooling P-5 Unit A). Mirrors `resolve_update_endpoint`'s port + product
/// resolution but points at the rollback route and pins the requested `tag`. It
/// deliberately passes NO `current_version` — a rollback resolves an explicit tag,
/// not "is there something newer than me". `{{target}}` / `{{arch}}` are left as
/// updater placeholders (the plugin substitutes the running platform, exactly as it
/// does for `resolve_update_endpoint`); the literal `tag` / `product` params pass
/// through untouched. Duplicating the small port/product block (rather than sharing
/// it) keeps this new path from being able to regress `install_update`'s lifeline.
fn resolve_rollback_endpoint(app: &AppHandle, tag: &str) -> Result<String, String> {
    let port: u16 = if cfg!(debug_assertions) {
        SELECTED_API_PORT.load(std::sync::atomic::Ordering::Relaxed)
    } else {
        let state: tauri::State<SidecarState> = app.state();
        let guard = state.port.lock().map_err(|e| e.to_string())?;
        guard.ok_or_else(sidecar_port_unavailable_message)?
    };
    let product = if is_server_product(app) {
        "server"
    } else {
        "gui"
    };
    let encoded_tag: String = url::form_urlencoded::byte_serialize(tag.as_bytes()).collect();
    Ok(format!(
        "http://127.0.0.1:{}/api/updates/rollback?tag={}&target={{{{target}}}}&arch={{{{arch}}}}&product={}",
        port, encoded_tag, product
    ))
}

/// Roll the desktop app BACK to an older, already-released `tag` — the Update
/// Center "Revert" action (desktop-update-center-and-release-tooling P-4). It is the
/// deliberate-downgrade sibling of `install_update`: the SAME download → plugin
/// minisign-verify (against the updater pubkey baked into `tauri.conf.json`) →
/// sidecar-safe teardown → atomic swap → relaunch path, but pointed at
/// `/api/updates/rollback?tag=…` and with the updater's default "remote must be
/// NEWER" gate overridden so an OLDER target is accepted (`version_comparator`).
///
/// The rollback route (P-5 Unit A) already bounds the tag to the caller's channel
/// window, so a stable user can't land on an alpha build; here we only need to tell
/// the plugin to install exactly the release the route resolved. The post-update
/// self-check (P-013, `run_update_self_check`) keys off the INSTALLED build's OWN
/// baked `PAPERCUSP_BUILD_SHA`, so after the downgrade the running operator's sha
/// matches the now-current (older) build — a rollback does not false-alarm (D-002).
#[tauri::command]
#[specta::specta]
async fn revert_to(app: AppHandle, tag: String) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let tag = tag.trim().to_string();
    if tag.is_empty() {
        return Err("revert_to: a target release tag is required".to_string());
    }
    // Same Linux constraint as install_update: only an AppImage install can
    // self-swap; on a .deb the swap fails mid-flight, so fail early with the
    // sentinel the UpdateChip fallback matches.
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_none() {
        return Err(
            "no_compatible_assets: this Linux install is not an AppImage — auto-swap unavailable"
                .to_string(),
        );
    }
    let endpoint = resolve_rollback_endpoint(&app, &tag)?;
    let url = url::Url::parse(&endpoint).map_err(|e| e.to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        // Accept the resolved release regardless of version ordering. The default
        // comparator is `release > current`, which would refuse a downgrade; the
        // user explicitly asked to revert to THIS tag, and the route already
        // channel-gated it, so honor it.
        .version_comparator(|_current, _release| true)
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("rollback target {tag} is not installable"))?;

    // Identical sidecar-safe teardown to install_update (EI-9002 / WI-2667), and
    // identically ordered AFTER the minisign verification (WI-2144851): a
    // downgrade is exactly where an unverified-artifact teardown would hurt most,
    // because the whole point of the path is to install an OLDER build whose
    // "newer than current" gate has been deliberately switched off above.
    download_verify_then_install(&app, update).await?;

    // tauri-plugin-process is in scope so we can restart cleanly.
    app.restart();
}

#[tauri::command]
#[specta::specta]
fn workspaces_list() -> workspaces::Registry {
    workspaces::list()
}

#[tauri::command]
#[specta::specta]
fn workspaces_create(name: String) -> Result<workspaces::Workspace, String> {
    workspaces::create(&name).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn workspaces_rename(id: String, name: String) -> Result<(), String> {
    workspaces::rename(&id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn workspaces_delete(id: String) -> Result<(), String> {
    workspaces::delete(&id).map_err(|e| e.to_string())
}

/// Switch the *registry default* workspace (Phase E, P-050).
///
/// Pre-Phase-E this killed the sidecar + per-workspace PG and `app.restart()`'d
/// — the only way to swap a per-process fake-HOME. Now ONE shared sidecar
/// serves every workspace and scoping is per-request (`?ws=` / the workspace
/// header → ALS → RLS GUC), so a switch is just a per-WINDOW navigation that
/// the frontend performs (`switchWorkspace` → navigate to `/harness?ws=<id>`).
/// This command only persists `registry.current` so a fresh launch / the first
/// window defaults to it. It NO LONGER restarts — other windows are untouched
/// (P-031).
#[tauri::command]
#[specta::specta]
fn workspaces_switch(id: String) -> Result<(), String> {
    workspaces::switch(&id).map_err(|e| e.to_string())
}

/// Open an ADDITIONAL window pinned to a workspace (Phase E, P-053).
///
/// The one shared sidecar serves it; the window self-identifies via `?ws=<id>`
/// in its URL, so `getBrowserWorkspaceId()` + the header/`?ws=` stamping scope
/// every request — and the RLS `app.workspace_id` GUC — to this workspace. The
/// window is labeled `ws-<id>` so it matches the `ws-*` capability pattern that
/// grants IPC (see capabilities/default.json); re-opening focuses the existing
/// one.
#[tauri::command]
#[specta::specta]
fn workspaces_open_window(app: AppHandle, id: String) -> Result<(), String> {
    if !workspaces::workspace_dir(&id).exists() {
        return Err(format!("no workspace dir for {}", id));
    }
    let label = format!("ws-{}", id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }
    // Resolve the app origin from the MAIN window's current URL — the source of
    // truth for "where the app is served" — so this works in BOTH dev (webview
    // → external devUrl :3055/:3070; no sidecar spawned, SidecarState.port is
    // None) and release (→ the spawned sidecar's free port). Fall back to the
    // sidecar port only if the main window's URL is somehow unreadable.
    let base = app
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
        .or_else(|| {
            let state: tauri::State<SidecarState> = app.state();
            let guard = state.port.lock().ok()?;
            (*guard).map(|p| format!("http://localhost:{}", p))
        })
        .ok_or_else(|| {
            "could not resolve app origin (no main window URL, no sidecar port)".to_string()
        })?;
    let url = format!("{}/harness?ws={}", base, url_encode(&id));
    let parsed = url
        .parse()
        .map_err(|e| format!("bad window url {}: {}", url, e))?;
    let win =
        tauri::WebviewWindowBuilder::new(&app, label.clone(), tauri::WebviewUrl::External(parsed))
            .title(format!("Papercusp — {}", id))
            .inner_size(1280.0, 800.0)
            .build()
            .map_err(|e| e.to_string())?;
    // Hand the new window the sidecar base + native PTY mode, exactly like the
    // main window's setup() injection (main.rs ~1463). getBrowserWorkspaceId()
    // reads ?ws= from the URL, so the workspace is known even before this runs.
    let _ = win.eval(&format!(
        "window.__papercuspBase = '{base}'; window.__papercuspAppBase = '{base}'; window.__PAPERCUSP_TAURI__ = {{ kind: 'native' }}; window.dispatchEvent(new CustomEvent('papercusp:base'));"
    ));
    #[cfg(target_os = "linux")]
    grant_media_permission(&win);
    #[cfg(target_os = "linux")]
    install_load_failure_recovery(&win);
    Ok(())
}

/// Raise a native OS notification (planning-attention-importance D-007).
/// Invoked from the webview's DesktopAttentionNotifier on `attention.notify`
/// SSE events (escalation / smoke-fail / plan-review / needs-human≥high).
/// The webview already shows an in-app toast, so a failure here is non-fatal
/// — it's returned as a string and the caller swallows it.
#[tauri::command]
#[specta::specta]
fn show_attention_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Native sibling terminal (native-terminal-desktop-2026-06-06)
//
// The desktop terminal is a fully NATIVE terminal, not xterm.js. On X11 we
// launch a borderless GPU-native Ghostty window hosting the chat dock
// (`pui chat` — operator chat | brain, P-013 / D-011) and
// pin it adjacent to the GUI window so the pair reads as one app. The glue is
// visual only — the terminal coordinates with the GUI through the substrate.
// See src/native_terminal.rs for the strategy + geometry + x11rb glue.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, specta::Type)]
struct NativeTerminalStatus {
    /// One of glued-ghostty-x11 / new-window / embedded-* / disabled.
    strategy: String,
    running: bool,
}

#[tauri::command]
#[specta::specta]
fn native_terminal_status(
    nt: tauri::State<native_terminal::NativeTerminal>,
) -> NativeTerminalStatus {
    // D-004: gate closed (FLAGS.TESTING off — the default) ⇒ the dock is
    // dark. Report `disabled` so webview consumers (TerminalDivider's
    // hasDockedSurface check) stay unmounted without knowing about the flag.
    if !nt.gate_enabled() {
        return NativeTerminalStatus {
            strategy: "disabled".to_string(),
            running: false,
        };
    }
    NativeTerminalStatus {
        strategy: nt.strategy.label().to_string(),
        running: nt.is_running(),
    }
}

/// Show/hide the native sibling terminal. Returns the new running state.
/// D-004: refuses while the FLAGS.TESTING gate is closed — the dock is
/// testing-gated (flip the flag via /admin/features, then relaunch or let
/// the webview relay re-open the gate live).
#[tauri::command]
#[specta::specta]
fn native_terminal_toggle(app: AppHandle) -> Result<bool, String> {
    let running = {
        let nt = app.state::<native_terminal::NativeTerminal>();
        if !nt.gate_enabled() {
            return Err(
                "the native terminal dock is testing-gated (FLAGS.TESTING is off) — \
                 flip it via /admin/features to restore the dock"
                    .into(),
            );
        }
        nt.is_running()
    };
    if running {
        app.state::<native_terminal::NativeTerminal>().shutdown();
        Ok(false)
    } else {
        start_native_terminal(&app);
        Ok(true)
    }
}

/// D-004 (operator-chat-sidebar-revival P-014): the webview relays its
/// resolved FLAGS.TESTING across the seam here, once flags load and again on
/// any live flip. Rust no longer spawns the dock at boot — this is the ONLY
/// path that opens the gate. Enabled + not running ⇒ spawn (restores today's
/// dock exactly); disabled + running ⇒ shutdown (a live flag-off flip hides
/// the dock without a relaunch). Returns the new running state.
#[tauri::command]
#[specta::specta]
fn native_terminal_set_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let running = {
        let nt = app.state::<native_terminal::NativeTerminal>();
        nt.set_gate_enabled(enabled);
        nt.is_running()
    };
    if enabled && !running {
        start_native_terminal(&app);
        Ok(app.state::<native_terminal::NativeTerminal>().is_running())
    } else if !enabled && running {
        app.state::<native_terminal::NativeTerminal>().shutdown();
        Ok(false)
    } else {
        Ok(running)
    }
}

/// WI-3388 — the terminal's current user layout (divider width fraction +
/// collapsed/rail state). Read on mount by the web UI's `<TerminalDivider>`
/// so it renders the persisted position instead of flashing a default.
#[tauri::command]
#[specta::specta]
fn terminal_get_layout(
    nt: tauri::State<native_terminal::NativeTerminal>,
) -> native_terminal::TerminalLayout {
    nt.get_layout()
}

/// WI-3388 — set the terminal's layout (either field optional — pass just
/// `collapsed` for the rail toggle, or just `fraction` for a divider drag),
/// persist it, and apply it LIVE to whichever backend is running. A no-op
/// apply (persisted only) for NewWindow/Disabled — there's no native surface
/// to resize.
#[tauri::command]
#[specta::specta]
fn terminal_set_layout(
    app: AppHandle,
    fraction: Option<f32>,
    collapsed: Option<bool>,
) -> Result<native_terminal::TerminalLayout, String> {
    let nt = app.state::<native_terminal::NativeTerminal>();
    let resolved = nt.set_layout(fraction, collapsed);
    apply_terminal_layout_live(&app, resolved);
    Ok(resolved)
}

/// Apply `layout` to whichever backend is currently running. The X11 glued
/// path reads `NativeTerminal`'s shared layout state directly off its own
/// glue-loop thread (no action needed here beyond the `set_layout` write
/// above); the embedded views (one window, a native widget/view resized in
/// place) need an explicit re-layout call on their own main thread, using
/// the handle each embed stashed at attach time.
fn apply_terminal_layout_live(app: &AppHandle, layout: native_terminal::TerminalLayout) {
    let nt = app.state::<native_terminal::NativeTerminal>();
    match nt.strategy {
        #[cfg(target_os = "linux")]
        native_terminal::TerminalStrategy::EmbeddedView(native_terminal::EmbedBackend::Vte) => {
            let Some((paned_ptr, side)) = nt.vte_paned() else {
                return;
            };
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            let _ = window.run_on_main_thread(move || {
                native_terminal::vte_embed::apply_layout(paned_ptr, side, layout);
            });
        }
        #[cfg(target_os = "macos")]
        native_terminal::TerminalStrategy::EmbeddedView(
            native_terminal::EmbedBackend::SwiftTerm,
        ) => {
            let Some((ns_window, term)) = nt.swiftterm_handle() else {
                return;
            };
            let cfg = nt.config.clone();
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            let _ = window.run_on_main_thread(move || {
                if let Err(e) = native_terminal::swiftterm_embed::set_layout(
                    ns_window as *mut std::ffi::c_void,
                    term,
                    layout.fraction,
                    cfg.min_px,
                    cfg.max_px,
                    layout.collapsed,
                ) {
                    eprintln!("[papercusp-desktop] native-terminal: set_layout failed: {e}");
                }
            });
        }
        #[cfg(target_os = "windows")]
        native_terminal::TerminalStrategy::EmbeddedView(native_terminal::EmbedBackend::ConPty) => {
            let Some((parent, term, webview)) = nt.win_handles() else {
                return;
            };
            let cfg = nt.config.clone();
            std::thread::spawn(move || {
                let webview_hwnd = if webview == 0 { None } else { Some(webview) };
                if let Err(e) = native_terminal::win_embed::set_layout(
                    parent as *mut std::ffi::c_void,
                    term,
                    webview_hwnd,
                    layout.fraction,
                    cfg.min_px,
                    cfg.max_px,
                    layout.collapsed,
                ) {
                    eprintln!("[papercusp-desktop] native-terminal: set_layout failed: {e}");
                }
            });
        }
        // GluedGhosttyX11: the glue-loop thread reads the shared layout
        // state every tick (~150ms) and applies it itself — nothing to do
        // here. NewWindow/Disabled/unbuilt EmbeddedView: no native surface.
        _ => {}
    }
}

/// Make the bundled chat-dock binaries (`pui`, `zellij`) discoverable + point
/// `pui` at the bundled companion plugin, so the dock (`pui chat` = zellij + the
/// pui-companion plugin) works from a PACKAGED app. Every dock launcher — the
/// Linux glued/new-window `ghostty -e pui chat` AND the macOS SwiftTerm embed —
/// spawns its child inheriting THIS process's env, so we prepend the bundled
/// `sidecar/bin` to PATH and set PUI_COMPANION_WASM here. The sidecar dir is
/// resolved via Tauri's CROSS-PLATFORM Resource resolver (the mac `.app`
/// Contents/Resources layout and the Linux `.deb`/AppImage layout differ), so it
/// works on every target. Idempotent (run-once) + a no-op in a dev/unbundled
/// layout where the files aren't found. (linux-chat-dock-parity-2026-06-27 —
/// macOS previously did this in swiftterm_embed::prepare_dock_env, which never
/// ran on Linux, so the Linux dock stayed a blank pane even once the binaries shipped.)
fn prepare_dock_env(app: &AppHandle) {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let Ok(sidecar) = app
            .path()
            .resolve("sidecar", tauri::path::BaseDirectory::Resource)
        else {
            return;
        };
        let bin = sidecar.join("bin");
        if bin.is_dir() {
            let cur = std::env::var("PATH").unwrap_or_default();
            // PATH is `;`-separated on Windows — a `:` here would fuse our dir to
            // the first existing entry and silently discard BOTH.
            let sep = if cfg!(windows) { ';' } else { ':' };
            std::env::set_var("PATH", format!("{}{sep}{}", bin.display(), cur));
            // WI-4448: on Windows the dock runs INSIDE the papercup-runtime WSL
            // distro, which never sees this (Windows) PATH — build-rootfs.sh sets
            // `appendWindowsPath=false`. So the launcher needs the bundled bin dir
            // as a value it can PATH-translate (`windows_path_to_wsl`), not just as
            // an entry in our own PATH. Exported on every platform: it is plain
            // provenance for where the dock binaries came from.
            std::env::set_var("PAPERCUSP_DOCK_BIN", &bin);
        }
        if std::env::var_os("PUI_COMPANION_WASM").is_none() {
            let wasm = sidecar.join("pui-companion.wasm");
            if wasm.is_file() {
                std::env::set_var("PUI_COMPANION_WASM", wasm);
            }
        }
    });
}

/// Launch the native terminal per the resolved strategy. Shared by setup() and
/// the toggle command. For the glued path, the X11 window is resolved + first-
/// glued on a background thread so this never blocks.
fn start_native_terminal(app: &AppHandle) {
    use native_terminal::TerminalStrategy;
    // Ensure the bundled dock binaries (pui/zellij) are on PATH + PUI_COMPANION_WASM
    // is set BEFORE any launcher spawns `pui chat` — cross-platform (was mac-only,
    // so the Linux dock never found them). Idempotent; no-op in dev/unbundled.
    prepare_dock_env(app);
    let strategy = app.state::<native_terminal::NativeTerminal>().strategy;
    match strategy {
        TerminalStrategy::GluedGhosttyX11 => {
            if let Err(e) = app
                .state::<native_terminal::NativeTerminal>()
                .launch_glued()
            {
                eprintln!("[papercusp-desktop] native-terminal launch_glued failed: {e}");
                return;
            }
            // Drive the steady glue loop off-thread. It owns one persistent X11
            // connection and re-pins the sibling to our GUI window's true
            // geometry every ~150ms until shutdown — robust to whichever window
            // events GTK does/doesn't emit (programmatic/WM moves don't reliably
            // surface as Moved, and outer_position lags). See run_glue_loop.
            let handle = app.clone();
            std::thread::spawn(move || {
                handle
                    .state::<native_terminal::NativeTerminal>()
                    .run_glue_loop();
            });
        }
        TerminalStrategy::NewWindow => {
            if let Err(e) = app
                .state::<native_terminal::NativeTerminal>()
                .launch_new_window()
            {
                eprintln!("[papercusp-desktop] native-terminal launch_new_window failed: {e}");
            }
        }
        // D-009: the Linux embedded VTE view — a real terminal widget packed
        // beside the webview in OUR window's GTK tree (one window; Wayland-safe;
        // the GtkPaned handle is the draggable split). Must run on the GTK main
        // thread. Falls back to NewWindow if the surgery fails.
        #[cfg(target_os = "linux")]
        TerminalStrategy::EmbeddedView(native_terminal::EmbedBackend::Vte) => {
            let Some(window) = app.get_webview_window("main") else {
                eprintln!("[papercusp-desktop] native-terminal: no main window for the VTE embed");
                return;
            };
            let handle = app.clone();
            let win = window.clone();
            let res = window.run_on_main_thread(move || {
                // Defer the GTK surgery until the window is fully realized +
                // mapped: creating/re-parenting native-windowed widgets
                // mid-realization wedges VTE's internal geometry (it latches a
                // boot-time inset and computes its grid against it forever —
                // root-caused live: the same surgery a beat after map renders
                // perfectly). Poll until mapped, give the layout one more
                // settle beat, then embed.
                use webkit2gtk::glib;
                let mut settle_beats: u8 = 0;
                glib::timeout_add_local(std::time::Duration::from_millis(250), move || {
                    let mapped = win
                        .gtk_window()
                        .map(|w| gtk::prelude::WidgetExt::is_mapped(&w))
                        .unwrap_or(false);
                    if !mapped {
                        return glib::ControlFlow::Continue;
                    }
                    settle_beats += 1;
                    // ~2s after first map. Shorter settles (500ms) still hit
                    // the mid-realization wedge — verified empirically; wry's
                    // own post-map bootstrap (webview sizing + bounds passes)
                    // has to finish before the tree is safe to cut.
                    if settle_beats < 8 {
                        return glib::ControlFlow::Continue;
                    }
                    let spec = native_terminal::GhosttySpec::dock();
                    let cfg = native_terminal::GlueConfig::from_env();
                    // WI-3388: seed the embed with the PERSISTED fraction
                    // (not the env-configured default) so a relaunch opens
                    // at the user's last divider position.
                    let layout = handle
                        .state::<native_terminal::NativeTerminal>()
                        .get_layout();
                    let embedded = match (win.gtk_window(), win.default_vbox()) {
                        (Ok(gtk_win), Ok(vbox)) => native_terminal::vte_embed::embed_into_window(
                            &gtk_win,
                            &vbox,
                            &spec.command,
                            cfg.side,
                            layout.fraction,
                            &spec.background,
                        ),
                        _ => Err("no gtk window / default vbox".to_string()),
                    };
                    match embedded {
                        Ok(paned_ptr) => {
                            println!("[papercusp-desktop] native-terminal: VTE view embedded");
                            let nt = handle.state::<native_terminal::NativeTerminal>();
                            nt.set_vte_paned(paned_ptr, cfg.side);
                            if layout.collapsed {
                                native_terminal::vte_embed::apply_layout(paned_ptr, cfg.side, layout);
                            }
                        }
                        Err(e) => {
                            eprintln!(
                                "[papercusp-desktop] native-terminal VTE embed failed: {e} — falling back to new-window"
                            );
                            let _ = handle
                                .state::<native_terminal::NativeTerminal>()
                                .launch_new_window();
                        }
                    }
                    glib::ControlFlow::Break
                });
            });
            if let Err(e) = res {
                eprintln!(
                    "[papercusp-desktop] native-terminal: VTE embed main-thread hop failed: {e}"
                );
            }
        }
        // D-009: the macOS embedded SwiftTerm view — a real native terminal
        // attached inside OUR window's content view via the dlopen'd
        // macos-term-shim (terminal left, webview shrunk right — P-014). Must
        // run on the AppKit main thread. Falls back to NewWindow on failure.
        #[cfg(target_os = "macos")]
        TerminalStrategy::EmbeddedView(native_terminal::EmbedBackend::SwiftTerm) => {
            let Some(window) = app.get_webview_window("main") else {
                eprintln!(
                    "[papercusp-desktop] native-terminal: no main window for the SwiftTerm embed"
                );
                return;
            };
            let handle = app.clone();
            let win = window.clone();
            // Same lesson as the Linux VTE embed: surgery mid-realization is
            // hazardous — and here the WKWebView mounts AFTER setup(), at full
            // bounds, covering an early-attached terminal. Defer ~2s off-thread,
            // then hop to the AppKit main thread for the attach.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(2000));
                let win2 = win.clone();
                let res = win.run_on_main_thread(move || {
                    let spec = native_terminal::GhosttySpec::dock();
                    let cfg = native_terminal::GlueConfig::from_env();
                    let layout = handle
                        .state::<native_terminal::NativeTerminal>()
                        .get_layout();
                    let ns_addr: Option<usize> = win2.ns_window().ok().map(|p| p as usize);
                    let embedded = match ns_addr {
                        Some(ns_addr) => native_terminal::swiftterm_embed::embed_into_window(
                            ns_addr as *mut std::ffi::c_void,
                            &spec.command,
                            layout.fraction,
                            cfg.min_px,
                            cfg.max_px,
                        ),
                        None => Err("no ns_window".to_string()),
                    };
                    match embedded {
                        Ok(term_handle) => {
                            println!("[papercusp-desktop] native-terminal: SwiftTerm view embedded");
                            let nt = handle.state::<native_terminal::NativeTerminal>();
                            let ns_addr = ns_addr.unwrap_or(0);
                            nt.set_swiftterm_handle(ns_addr, term_handle);
                            if layout.collapsed {
                                let _ = native_terminal::swiftterm_embed::set_layout(
                                    ns_addr as *mut std::ffi::c_void,
                                    term_handle,
                                    layout.fraction,
                                    cfg.min_px,
                                    cfg.max_px,
                                    true,
                                );
                            }
                        }
                        Err(e) => {
                            eprintln!(
                                "[papercusp-desktop] native-terminal SwiftTerm embed failed: {e} — falling back to new-window"
                            );
                            let _ = handle
                                .state::<native_terminal::NativeTerminal>()
                                .launch_new_window();
                        }
                    }
                });
                if let Err(e) = res {
                    eprintln!(
                        "[papercusp-desktop] native-terminal: SwiftTerm embed main-thread hop failed: {e}"
                    );
                }
            });
        }
        // D-009: the Windows glued-child-HWND terminal — a real ConPTY-backed
        // console window reparented INTO the Tauri window (left band), with
        // the WebView2 child shrunk right. Win32 calls are cross-thread-safe,
        // so the (window-poll-blocking) embed runs on a worker thread.
        #[cfg(target_os = "windows")]
        TerminalStrategy::EmbeddedView(native_terminal::EmbedBackend::ConPty) => {
            let Some(window) = app.get_webview_window("main") else {
                eprintln!(
                    "[papercusp-desktop] native-terminal: no main window for the ConPTY embed"
                );
                return;
            };
            let Ok(hwnd) = window.hwnd() else {
                eprintln!("[papercusp-desktop] native-terminal: no hwnd for the ConPTY embed");
                return;
            };
            let handle = app.clone();
            // Raw pointers aren't Send — carry the HWND across the thread as
            // usize and rebuild it inside.
            let hwnd_addr = hwnd.0 as usize;
            std::thread::spawn(move || {
                // Same lesson as the Linux VTE embed: let the window finish
                // realizing + the WebView2 child mount before cutting the tree.
                std::thread::sleep(std::time::Duration::from_millis(2000));
                let spec = native_terminal::GhosttySpec::dock();
                let cfg = native_terminal::GlueConfig::from_env();
                let layout = handle
                    .state::<native_terminal::NativeTerminal>()
                    .get_layout();
                match native_terminal::win_embed::embed_into_window(
                    hwnd_addr as *mut std::ffi::c_void,
                    &spec.command,
                    layout.fraction,
                    cfg.min_px,
                    cfg.max_px,
                ) {
                    Ok(handles) => {
                        println!(
                            "[papercusp-desktop] native-terminal: ConPTY console embedded (pid={})",
                            handles.pid
                        );
                        let nt = handle.state::<native_terminal::NativeTerminal>();
                        nt.set_win_handles(
                            hwnd_addr as isize,
                            handles.term_hwnd,
                            handles.webview_hwnd,
                        );
                        if layout.collapsed {
                            let _ = native_terminal::win_embed::set_layout(
                                hwnd_addr as *mut std::ffi::c_void,
                                handles.term_hwnd,
                                handles.webview_hwnd,
                                layout.fraction,
                                cfg.min_px,
                                cfg.max_px,
                                true,
                            );
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "[papercusp-desktop] native-terminal ConPTY embed failed: {e} — falling back to new-window"
                        );
                        let _ = handle
                            .state::<native_terminal::NativeTerminal>()
                            .launch_new_window();
                    }
                }
            });
        }
        // Remaining embedded views (a backend on the wrong OS) are downgraded
        // to NewWindow until they land; Disabled = no display / opted out.
        TerminalStrategy::EmbeddedView(_) | TerminalStrategy::Disabled => {}
    }
}

/// Resolve the terminal strategy and manage the `NativeTerminal` state — but
/// do NOT launch it (D-004: the dock is FLAGS.TESTING-gated; the webview's
/// `native_terminal_set_enabled` relay is the only spawn path). Runs in both
/// dev and prod so the state + layout persistence are ready if the gate opens.
fn init_native_terminal(app: &tauri::App, window_owner: bool) {
    // The packaged Server owns the Quick Panel webview even though it has no
    // main window. That webview invokes native-terminal commands during mount,
    // so the state must exist in every role. A Server must never spawn a dock.
    let strategy = if window_owner {
        native_terminal::resolve_strategy_from_env()
    } else {
        native_terminal::TerminalStrategy::Disabled
    };
    println!(
        "[papercusp-desktop] native-terminal strategy: {}",
        strategy.label()
    );
    let nt = native_terminal::NativeTerminal::new(strategy);
    // WI-3388: load any persisted divider width/collapsed state (a no-op
    // default on first run) before the terminal launches, so the very first
    // embed/glue-loop tick already has the user's last layout instead of
    // flashing the default fraction. Best-effort — an unresolvable config
    // dir just means layout won't survive relaunch this session.
    match app.path().app_config_dir() {
        Ok(dir) => nt.init_layout_persistence(dir.join("terminal-layout.json")),
        Err(e) => eprintln!(
            "[papercusp-desktop] native-terminal: no app_config_dir ({e}) — layout won't persist"
        ),
    }
    app.manage(nt);

    // D-004 (operator-chat-sidebar-revival P-014): NO boot-time spawn. The
    // dock is gated behind FLAGS.TESTING, which is client-loaded — Rust can't
    // read it here. The webview relays the resolved flag via
    // `native_terminal_set_enabled` once flags load (NativeTerminalGate in
    // the operator app), and THAT is what spawns the dock when the flag is
    // on. Flag off (the default; TESTING is parked) ⇒ no dock window, while
    // all code + bundled pui/zellij binaries stay in the app.
    // (The glue loop — run_glue_loop — owns move/resize tracking once
    // launched, so there's no per-window-event hook to register here.)
}

/// Whether any DRM render node can provide hardware GL. A 2D virtio GPU also
/// exposes renderD*, but cannot accelerate WebKit's compositor (WI-4480).
/// Keep physical GPUs and virgl-capable guests accelerated; use the existing
/// software fallback only when every node is absent or confirmed 2D virtio.
#[cfg(target_os = "linux")]
fn linux_has_dri_render_node() -> bool {
    linux_has_dri_render_node_at(
        std::path::Path::new("/dev/dri"),
        std::path::Path::new("/sys/class/drm"),
    )
}

#[cfg(target_os = "linux")]
fn linux_has_dri_render_node_at(dri: &std::path::Path, drm: &std::path::Path) -> bool {
    std::fs::read_dir(dri)
        .map(|rd| {
            rd.flatten().any(|e| {
                e.file_name().to_str().is_some_and(|n| {
                    n.starts_with("renderD")
                        && !linux_virtio_gpu_is_2d(&drm.join(n).join("device"))
                })
            })
        })
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn linux_virtio_gpu_is_2d(device: &std::path::Path) -> bool {
    let driver = std::fs::read_link(device.join("driver")).ok();
    if driver.as_ref().and_then(|p| p.file_name()) == Some(std::ffi::OsStr::new("virtio_gpu")) {
        // Linux drivers/virtio/virtio.c features_show writes bit 0 FIRST, not a
        // conventional binary integer. VIRTIO_GPU_F_VIRGL (virtio_gpu.h) is bit
        // 0. Unknown/unreadable features preserve the existing accelerated path.
        return std::fs::read_to_string(device.join("features"))
            .ok()
            .is_some_and(|s| {
                let bits = s.trim();
                bits.starts_with('0') && bits.bytes().all(|b| b == b'0' || b == b'1')
            });
    }
    // DRM's device link on PCI virtio points to the transport, with the actual
    // virtio_gpu device one level below (e.g. .../0000:00:01.0/virtio0).
    if driver.as_ref().and_then(|p| p.file_name()) == Some(std::ffi::OsStr::new("virtio-pci")) {
        return std::fs::read_dir(device)
            .map(|rd| {
                rd.flatten().any(|e| {
                    e.file_name()
                        .to_str()
                        .is_some_and(|n| n.starts_with("virtio"))
                        && linux_virtio_gpu_is_2d(&e.path())
                })
            })
            .unwrap_or(false);
    }
    false
}

/// Whether to force `WEBKIT_DISABLE_DMABUF_RENDERER=1`. The DMA-BUF renderer
/// misbehaves in two Linux GPU situations: the NVIDIA proprietary driver
/// (stale-tile artifacts) and software rendering with no usable GL render node
/// (X-server wedge / black screen on a VM — WI-3282). Pure so it's unit-tested.
fn should_disable_dmabuf(nvidia_present: bool, software_render: bool) -> bool {
    nvidia_present || software_render
}

#[cfg(test)]
mod dmabuf_render_tests {
    use super::should_disable_dmabuf;

    #[test]
    fn disables_on_nvidia_or_software_render() {
        // NVIDIA proprietary driver → stale-tile artifacts → disable.
        assert!(should_disable_dmabuf(true, false));
        // Software render / no hardware render node (VM, llvmpipe) → X wedge → disable.
        assert!(should_disable_dmabuf(false, true));
        // Both → disable.
        assert!(should_disable_dmabuf(true, true));
        // A real hardware GL render node and no NVIDIA → keep the fast DMA-BUF path.
        assert!(!should_disable_dmabuf(false, false));
    }
}

#[cfg(all(test, target_os = "linux"))]
mod render_capability_tests {
    use super::linux_has_dri_render_node_at;
    use std::path::PathBuf;

    struct DrmFixture(PathBuf);

    impl DrmFixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let root = std::env::temp_dir().join(format!(
                "papercusp-drm-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir_all(root.join("dev/dri")).unwrap();
            std::fs::create_dir_all(root.join("sys/class/drm")).unwrap();
            Self(root)
        }

        fn node(&self, name: &str, driver: &str, features: Option<&str>, pci: bool) {
            use std::os::unix::fs::symlink;
            std::fs::write(self.0.join("dev/dri").join(name), "").unwrap();
            let device = self.0.join("devices").join(name);
            std::fs::create_dir_all(&device).unwrap();
            let class = self.0.join("sys/class/drm").join(name);
            std::fs::create_dir_all(&class).unwrap();
            symlink(&device, class.join("device")).unwrap();
            let gpu = if pci {
                symlink("/sys/bus/pci/drivers/virtio-pci", device.join("driver")).unwrap();
                device.join("virtio0")
            } else {
                device
            };
            std::fs::create_dir_all(&gpu).unwrap();
            symlink(format!("/sys/bus/virtio/drivers/{driver}"), gpu.join("driver")).unwrap();
            if let Some(features) = features {
                std::fs::write(gpu.join("features"), features).unwrap();
            }
        }

        fn has_acceleration(&self) -> bool {
            linux_has_dri_render_node_at(&self.0.join("dev/dri"), &self.0.join("sys/class/drm"))
        }
    }

    impl Drop for DrmFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn render_capability_2d_virtio_node_does_not_imply_acceleration() {
        let fixture = DrmFixture::new();
        // Exact sysfs shape and negotiated features from the clean Linux VM.
        fixture.node(
            "renderD128",
            "virtio_gpu",
            Some("0100000000000000000000000000110010000000100000000000000000000000\n"),
            true,
        );
        assert!(!fixture.has_acceleration());
    }

    #[test]
    fn render_capability_direct_2d_virtio_is_software() {
        let fixture = DrmFixture::new();
        fixture.node("renderD128", "virtio_gpu", Some("01000000\n"), false);
        assert!(!fixture.has_acceleration());
    }

    #[test]
    fn render_capability_virgl_retains_acceleration() {
        let fixture = DrmFixture::new();
        fixture.node("renderD128", "virtio_gpu", Some("11000000\n"), true);
        assert!(fixture.has_acceleration());
    }

    #[test]
    fn render_capability_physical_and_hybrid_gpus_retain_acceleration() {
        let fixture = DrmFixture::new();
        fixture.node("renderD128", "virtio_gpu", Some("01000000\n"), true);
        fixture.node("renderD129", "amdgpu", None, false);
        assert!(fixture.has_acceleration());
    }

    #[test]
    fn render_capability_unknown_features_do_not_disable_real_hardware() {
        for features in [None, Some(""), Some("malformed\n")] {
            let fixture = DrmFixture::new();
            fixture.node("renderD128", "virtio_gpu", features, true);
            assert!(fixture.has_acceleration());
        }
    }

    #[test]
    fn render_capability_no_render_nodes_uses_software() {
        let fixture = DrmFixture::new();
        assert!(!fixture.has_acceleration());
        assert!(!linux_has_dri_render_node_at(&fixture.0.join("missing"), &fixture.0));
    }
}

const HEADLESS_SERVICE_ARG: &str = "--headless-service";

fn headless_service_requested<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    args.into_iter()
        .any(|arg| arg.as_ref() == std::ffi::OsStr::new(HEADLESS_SERVICE_ARG))
}

/// The package-owned service starts before a graphical session is guaranteed to
/// exist — Linux's user unit at `default.target`, macOS's LaunchDaemon at boot.
/// Entering Tauri there initializes the GUI toolkit before `setup()` can
/// discover the Server role: on Linux it panics with "Failed to initialize GTK",
/// and on macOS with no console session the process simply stalls with no
/// window server to attach to. The service therefore uses the same `spawn_serve`
/// contract as the desktop Server shell, but takes this pre-Tauri branch and
/// remains the service-manager-owned parent of `serve.mjs`.
///
/// ⚠ This branch is compiled for BOTH Linux and macOS on purpose. It was
/// `#[cfg(target_os = "linux")]` until 2026-08-28, which made
/// `--headless-service` parse-and-be-ignored on macOS (`headless_service_requested`
/// is platform-neutral, so the flag validated and the binary then fell through
/// into `tauri::Builder::default()` anyway). That is why a logged-out Mac peer
/// stalled at 0% CPU instead of serving: an accepted-and-ignored flag looks
/// supported. Do not re-narrow this gate without also rejecting the flag on the
/// excluded platform. See WI-475896.
///
/// `PAPERCUSP_SIDECAR_DIR` is supplied by the packaged service unit because the
/// resource root is a packaging fact (`/usr/lib/Papercusp Server/sidecar` on
/// Linux, `/Applications/Papercusp Server.app/Contents/Resources/sidecar` on
/// macOS), not something the installed binary can derive from its own
/// executable path. `spawn_serve` still owns every runtime env/path decision, so
/// this is not a second headless launch recipe that can drift from the desktop
/// path.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn run_headless_service() -> ! {
    let sidecar_dir = match std::env::var_os("PAPERCUSP_SIDECAR_DIR") {
        Some(path) if !path.is_empty() => std::path::PathBuf::from(path),
        _ => {
            eprintln!(
                "[papercusp-server] FATAL: {HEADLESS_SERVICE_ARG} requires PAPERCUSP_SIDECAR_DIR"
            );
            std::process::exit(1);
        }
    };

    if let Err(error) = workspaces::ensure_initialized() {
        eprintln!(
            "[papercusp-server] workspace registry init failed: {error} (continuing with shared home)"
        );
    }
    let workspace_home = workspaces::shared_sidecar_home();
    let shared_state_dir = workspaces::shared_data_dir();
    if let Err(error) = std::fs::create_dir_all(&shared_state_dir) {
        eprintln!(
            "[papercusp-server] could not create shared state dir {}: {error}",
            shared_state_dir.display()
        );
        std::process::exit(1);
    }

    let port_hint = find_free_port().unwrap_or_else(|| {
        eprintln!("[papercusp-server] no free operator port available");
        std::process::exit(1);
    });
    let pg_port_hint = portpicker::pick_unused_port().unwrap_or(15432);
    println!(
        "[papercusp-server] headless service: sidecar={} operator_hint={} pg_hint={}",
        sidecar_dir.display(),
        port_hint,
        pg_port_hint
    );

    let mut child = match spawn_serve(
        false,
        port_hint,
        &sidecar_dir,
        None,
        pg_port_hint,
        &shared_state_dir,
        &workspace_home,
        &INSTALL_DEFECT,
        true,
    ) {
        Ok(child) => child,
        Err(error) => {
            eprintln!("[papercusp-server] failed to spawn headless operator: {error}");
            std::process::exit(1);
        }
    };

    let status = child.wait();
    eprintln!("[papercusp-server] headless operator exited: {status:?}");

    // `serve --ensure` exits 0 when it found an already-healthy singleton. In
    // that narrow handoff case, stay active while the discovered operator is
    // healthy instead of making systemd restart this shell every five seconds.
    // Once it disappears, exit non-zero so Restart=on-failure creates a fresh
    // owned operator.
    if status.as_ref().is_ok_and(|status| status.success()) {
        while find_operator_discovery(&workspace_home, false)
            .as_ref()
            .is_some_and(|discovery| {
                discovery_pid_alive(discovery.pid, false) && operator_http_ready(discovery.port)
            })
        {
            std::thread::sleep(Duration::from_secs(2));
        }
    }
    std::process::exit(1);
}

#[cfg(test)]
mod headless_service_arg_tests {
    use super::headless_service_requested;

    #[test]
    fn only_the_explicit_headless_service_flag_bypasses_tauri() {
        assert!(headless_service_requested([
            "papercusp-server",
            "--headless-service"
        ]));
        assert!(!headless_service_requested(["papercusp-server"]));
        assert!(!headless_service_requested([
            "papercusp-server",
            "--headless"
        ]));
    }
}

pub fn run() {
    // Must precede `tauri::Builder::default()`: the whole purpose of the service
    // entrypoint is to avoid initializing a GUI toolkit when no display exists —
    // GTK on Linux, the window server on a logged-out Mac.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    if headless_service_requested(std::env::args_os()) {
        run_headless_service();
    }

    // Before anything opens an fd or spawns a child: lift THIS process's fd soft
    // limit off the 256 macOS hands a GUI app. rlimits inherit across fork/exec,
    // so one call here also covers every NON-node child (gateway sidecar,
    // embedded PG, the `claude` CLI).
    //
    // Latent hardening, NOT a fix for an observed crash — WI-4369 was originally
    // filed claiming an impending operator EMFILE, and that was wrong: node
    // raises its OWN RLIMIT_NOFILE at startup (to 1048575), so the operator
    // sidecar was never bounded by 256. See fd_limit.rs for the full correction
    // and the two traps the implementation dodges.
    fd_limit::raise_fd_limit();

    // WebKitGTK's DMA-BUF renderer misbehaves on two Linux GPU situations, so we
    // force it off (before any webview exists — an explicit user value always
    // wins) when either applies:
    //   (a) the NVIDIA proprietary driver — stale-tile artifacts (ghost fragments
    //       of other surfaces composited into the webview; webkit#262607,
    //       tauri#9394/#14924; dev box, webkit2gtk 2.52 + driver 580); and
    //   (b) SOFTWARE rendering with no usable hardware GL render node (llvmpipe,
    //       QXL / 2D virtio in a VM, or headless) — there the DMA-BUF path drove Xorg
    //       to 93% and WEDGED the X server (black, frozen, uninteractable) even
    //       after killing every app process (WI-3282, owner's clean Linux VM). The
    //       A render node alone is insufficient: 2D virtio exposes one too.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
        let software_render = !linux_has_dri_render_node();
        if should_disable_dmabuf(nvidia, software_render) {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            // With software GL also drop accelerated compositing — there
            // is no hardware accel to lose and it forecloses the rest of the
            // GL-compositing X-wedge class. NOT done on the NVIDIA path (a real GPU
            // is present — disabling compositing there would be a perf regression),
            // and LIBGL_ALWAYS_SOFTWARE is deliberately NOT forced (a no-op under
            // llvmpipe, and it would cripple a real GPU).
            if software_render && std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
                std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            }
        }
    }

    // Expose the `SharedArrayBuffer` global in the WebKitGTK webview (WI-4498).
    // JavaScriptCore hides the SAB *global constructor* behind this runtime
    // feature flag and leaves it undefined by DEFAULT — even in a cross-origin
    // isolated document. Measured in the real webview (webkit2gtk 2.52.3):
    //   - COOP:same-origin + COEP:require-corp ALONE → self.crossOriginIsolated
    //     becomes true but `typeof SharedArrayBuffer` stays "undefined", so the
    //     header-only approach is a dead end here.
    //   - `JSC_useSharedArrayBuffer=1` → the global is exposed, `new
    //     SharedArrayBuffer()` works, and cross-thread sharing (Worker +
    //     Atomics, i.e. emscripten pthreads) works — regardless of COOP/COEP.
    // This is what threaded onnxruntime-web needs for on-device wake-word
    // detection (openWakeWord) and Silero VAD; ort 1.24.x ships ONLY threaded
    // wasm, so without SAB the voice stack is stuck on the crude energy-VAD
    // fallback. Set before any webview/JSC init (JSC reads JSC_* env at startup);
    // an explicit user value always wins. Spectre note: browsers gate SAB behind
    // cross-origin isolation to bound side-channel timing attacks between an
    // isolated document and untrusted cross-origin embeds — this webview loads
    // only our own first-party operator content, so there is no cross-origin
    // victim to protect and app-wide exposure is the right trade for a desktop
    // shell. Linux/WebKitGTK only: JSC_* env flags are WebKitGTK-specific;
    // Windows (WebView2/Chromium) and macOS (WKWebView) gate SAB on
    // crossOriginIsolated the spec way and need COOP/COEP headers instead.
    #[cfg(target_os = "linux")]
    if std::env::var_os("JSC_useSharedArrayBuffer").is_none() {
        std::env::set_var("JSC_useSharedArrayBuffer", "1");
    }

    let state = SidecarState {
        child: Mutex::new(None),
        port: Mutex::new(None),
        endpoint_ipc_socket: Mutex::new(None),
        shutdown_done: std::sync::atomic::AtomicBool::new(false),
    };

    // tauri-specta Builder — collects every #[specta::specta] command
    // and emits a typed `bindings.ts` for the frontend on each debug
    // build. The frontend imports typed wrappers from `@/bindings`
    // instead of stringly-typed `invoke('cmd', ...)`.
    let specta_builder = tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            workspaces_list,
            workspaces_create,
            workspaces_rename,
            workspaces_delete,
            workspaces_switch,
            workspaces_open_window,
            show_attention_notification,
            app_version,
            check_for_update,
            install_update,
            revert_to,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_history,
            pty::pty_is_alive,
            wsl_setup::wsl_status,
            wsl_setup::wsl_install,
            wsl_setup::wsl_relaunch_elevated,
            wsl_setup::wsl_import,
            wsl_setup::wsl_bootstrap,
            wsl_setup::wsl_finalize_ready,
            wsl_setup::wsl_uninstall,
            native_console::console_launch,
            native_console::list_windows_by_title,
            native_console::focus_window_by_title,
            native_console::external_console_run,
            native_terminal_status,
            native_terminal_toggle,
            native_terminal_set_enabled,
            terminal_get_layout,
            terminal_set_layout,
            endpoint_ipc::endpoint_invoke,
            endpoint_ipc::endpoint_cancel,
            endpoint_ipc::endpoint_ipc_status,
            dev_bridge::__dev_bridge_result,
            env_switch::list_envs,
            docs_search::open_docs_search_palette,
            open_route_in_app,
        ])
        .events(tauri_specta::collect_events![OperatorDeadPayload]);

    // Export to packages/operator-core — the ONE home for the generated bindings.
    // apps/operator/lib/tauri-bindings.ts is a thin re-export of this file, which
    // keeps the frontend's `import { commands } from '@/lib/tauri-bindings'` working.
    //
    // ⚠ Do NOT point this back at apps/operator (EI-18899708711154370 ·
    // no-http-anywhere-2026-07-28 D-014). It used to write there, and because a
    // PACKAGE CANNOT IMPORT FROM AN APP, operator-core — which needs `commands` for
    // pty/wsl/workspaces/version/native-console — had no choice but to keep its own
    // hand-maintained copy. specta writes exactly ONE file, so that second copy was
    // stale BY CONSTRUCTION and nothing detected it: by 2026-08-02 it was 12 commands
    // behind and missing `endpoint_ipc_status` entirely, while both copies were
    // imported side by side. Generating into the package and re-exporting from the
    // app is the only direction the dependency graph allows.
    //
    // ⚠ Anchored at CARGO_MANIFEST_DIR *deliberately* — do not make this a bare
    // relative path again. Two independent failure modes bit this line:
    //
    //  1. WRONG PREFIX. From the papercup→papercusp rename until 2026-07-28 it read
    //     `../../papercup/apps/operator/lib/tauri-bindings.ts`. specta CREATES
    //     missing parent directories, so a wrong path cannot fail — it just writes
    //     the bindings where nothing imports them. That conjured a one-file
    //     `papercup/` tree and left the real bindings 52 lines stale for ~7 weeks;
    //     every command added in that window (incl. `endpoint_ipc_status`) was
    //     uncallable from the typed frontend.
    //  2. A RELATIVE path resolves against the process CWD, which is NOT stable
    //     here. Cleanup found the SAME misdirected file at three different depths
    //     (`papercup/…`, `tools/papercup/…`, `src-tauri/papercup/…`), which is only
    //     possible if the binary ran from three different working directories. A
    //     compile-time anchor removes that variable entirely.
    //
    // `apps/operator/lib/tauri-bindings-sync.test.ts` asserts both that this path
    // resolves to the canonical bindings file and that every collected command has
    // a binding in it, so neither mode can recur silently.
    //
    // BINDINGS_HEADER is prepended to the generated file by specta's `header` hook.
    // It carries the `Value` declaration the exporter itself fails to emit — see the
    // const's own comment. Safe to use: tauri-specta sets `framework_prelude`, not
    // `header`, so this does not clobber the "generated by Tauri Specta" banner.
    // specta renders `header + "\n" + framework_prelude + "\n" + body`
    // (specta-typescript-0.0.11 exporter.rs:593), so BINDINGS_HEADER must NOT end in
    // a newline or the checked-in file gains a blank line on every regeneration.
    //
    // The lines inside the raw string are deliberately NOT indented — a raw string
    // literal preserves leading whitespace verbatim, so indenting them to match this
    // function would indent the generated TypeScript.
    #[cfg(debug_assertions)]
    const BINDINGS_HEADER: &str = r#"// ── prepended by the specta exporter's `header` hook, NOT hand-written ──────────
// Everything below this block is generated too — see the Tauri Specta banner. The
// text of THIS block lives in the generator config, at the `.header(...)` call in
// papercusp-desktop/src-tauri/src/main.rs. Edit it there; an edit here is lost on
// the next regeneration exactly like an edit to the generated body.
//
// WHY `Value` IS DECLARED HERE. `Value` is `serde_json::Value`. specta
// 2.0.0-rc.24 expands it INLINE at each use site, but its recursive arms cannot be
// inlined, so the exporter emits the bare NAME (`Value[]`,
// `{ [key in string]: Value }`) while never emitting the declaration — leaving the
// generated file referencing a type it does not define (TS2304).
//
// Declaring it in generator CONFIG rather than in the generated OUTPUT is the whole
// point: a hand-added declaration in the output was already dropped once by a
// regeneration (typecheck-ratchet.test.ts's history note records restoring the
// "dropped terminal-layout/Value entries", after which regeneration dropped it
// again). Fix the generator, never its output.
//
// EI-18899708711154370 · no-http-anywhere-2026-07-28 D-014.
export type Value = "Null" | ({ Bool: boolean }) & { Array?: never; Number?: never; Object?: never; String?: never } | ({ Number: ({ f64: number }) & { i64?: never; u64?: never } | ({ i64: number }) & { f64?: never; u64?: never } | ({ u64: number }) & { f64?: never; i64?: never } }) & { Array?: never; Bool?: never; Object?: never; String?: never } | ({ String: string }) & { Array?: never; Bool?: never; Number?: never; Object?: never } | ({ Array: Value[] }) & { Bool?: never; Number?: never; Object?: never; String?: never } | ({ Object: { [key in string]: Value } }) & { Array?: never; Bool?: never; Number?: never; String?: never };"#;

    #[cfg(debug_assertions)]
    specta_builder
        .export(
            specta_typescript::Typescript::default().header(BINDINGS_HEADER),
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../packages/operator-core/lib/tauri-bindings.ts"
            ),
        )
        .ok();

    // P-009 single-instance guard — MUST be the FIRST plugin so a duplicate
    // launch is rejected before any sidecar/window init runs. The plugin keys
    // its OS lock on the app IDENTIFIER, which is distinct per bundle
    // (com.papercusp.gui vs com.papercusp.server) → PER-BUNDLE-IDENTITY: two
    // GUIs (or two Servers) collide — the second is closed and routed to
    // on_second_instance() in the primary — while a GUI and a Server coexist.
    // Release-only so agent-e2e can still run a second `npm run dev` shell;
    // PAPERCUSP_DISABLE_SINGLE_INSTANCE=1 force-disables it in a packaged build.
    // See app_role.rs + the two-bundle split above.
    let base = tauri::Builder::default();
    #[cfg(not(debug_assertions))]
    let base = if std::env::var_os("PAPERCUSP_DISABLE_SINGLE_INSTANCE").is_some() {
        base
    } else {
        base.plugin(tauri_plugin_single_instance::init(on_second_instance))
    };

    let builder = base
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        // Invisible env-switch escape hatch (env_switch::register_backstop_shortcuts):
        // OS-level shortcuts registered from Rust, no menu bar. Inert until the
        // dev-path registers shortcuts, so a packaged build carries nothing.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Runtime login auto-start for the Server role (enabled only in
        // server_setup). macOS uses a LaunchAgent and Windows uses HKCU Run.
        // Linux is package-owned by papercusp-server.service instead; the
        // plugin stays registered there only because this Builder is shared,
        // but enable_login_autostart deliberately does not call `.enable()`.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));

    // MCP bridge for AI coding agents — debug builds only. Lets Claude
    // Code / Cursor connect via @hypothesi/tauri-mcp-server and inspect
    // the running app (IPC, window state, JS eval). Bound to localhost
    // only — the bridge exposes webview_execute_js, so a 0.0.0.0 bind
    // would let anyone on the LAN drive the dev app.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_mcp_bridge::Builder::new()
            .bind_address("127.0.0.1")
            .build(),
    );

    // Phase 4 — `papercusp://` custom protocol (DEFAULT-ON, shipped
    // 2026-06-01). Register the async scheme handler so the window loads
    // `papercusp://localhost/…` (forwarded to the loopback sidecar) and opens
    // zero HTTP connections from the webview. Set
    // PAPERCUSP_DESKTOP_CUSTOM_PROTOCOL=0 to roll back to the HTTP origin.
    // See custom_protocol.rs + the navigate hook in setup().
    // Register on every platform that serves the bundled-SPA origin — Linux
    // (steady-state) AND Windows (pre-operator onboarding gate). Gating this on
    // enabled() (Linux-only) is what left the handler unregistered on Windows,
    // stranding first-run on the dead :3070 frontendDist (WI-2734).
    let builder = if custom_protocol::onboarding_origin_enabled() {
        builder.register_asynchronous_uri_scheme_protocol(
            custom_protocol::SCHEME,
            custom_protocol::handle,
        )
    } else {
        builder
    };

    builder
        .invoke_handler(specta_builder.invoke_handler())
        .manage(state)
        // A page (re)load (Ctrl+R, Vite full-reload, navigation) destroys the
        // JS context that owns every in-flight endpoint-IPC Channel, but the
        // Rust-side registrations survive — the reader loop would keep
        // fanning server stream frames into dead callbacks forever, flooding
        // the console with "[TAURI] Couldn't find callback id" warnings.
        // Flush at Started, before the new page registers any calls.
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                if let Some(handle) =
                    webview.try_state::<std::sync::Arc<endpoint_ipc::IpcClientHandle>>()
                {
                    handle.flush_for_page_load();
                }
                // Make /api follow whatever env the webview navigated to — the
                // in-webview bar's window.location switch + the native backstop +
                // a manual reload all land here, so /api retargets with NO bar in
                // the loop (replaces the GTK bar's switch_to retarget).
                env_switch::retarget_for_url(webview.app_handle(), payload.url());
            }
        })
        .setup(move |app| {
            // Mount the same typed event registry Specta used to generate the
            // frontend listener. This keeps the Rust event name + payload and
            // the TypeScript binding on one authored contract.
            specta_builder.mount_events(app);
            // WI-36794 — FIRST, before anything touches a state dir: the tauri
            // identity overlay and the baked channel stamp are set INDEPENDENTLY
            // at build time, and either one without the other is a build that
            // writes to the wrong app's state. Refuse to boot on a mismatch
            // rather than discover it by corrupting `~/.papercusp`.
            if let Err(msg) = workspaces::verify_channel_identity(&app.config().identifier) {
                eprintln!("[papercusp-desktop] FATAL: {msg}");
                return Err(msg.into());
            }
            let role = app_role::detect(&app.config().identifier);
            // WI-6502: make the WebKitGTK compositor honour the damage rects it
            // already computes, instead of repainting the whole viewport on
            // every keystroke. Unconditional (NOT dev-gated like env_switch
            // below) — the typing lag it fixes is a shipped-product symptom.
            // Fail-soft: logs and continues if the feature is unavailable.
            webkit_render::init(app);
            // WI-1803: BEFORE any boot diagnostic prints, route THIS process's
            // own stdout/stderr to a rotated on-disk log in packaged (release)
            // builds — a Finder/launchd/login-item launch has no console, so
            // fd 1/2 are /dev/null and every eprintln! below (incl. the GUI
            // navigate/boot failure that blanks the page — WI-1802) would
            // otherwise vanish. Role-scoped basename so the GUI and Server
            // processes don't interleave into one file, and distinct from the
            // serve.mjs child's serve.log. Dev keeps its inherited terminal.
            #[cfg(all(not(debug_assertions), any(unix, windows)))]
            {
                let basename = if role.is_gui() { "gui.log" } else { "server-app.log" };
                redirect_own_stdio(&workspaces::shared_sidecar_home(), basename);
            }
            // Now that there IS a log, report the fd-limit raise that ran at the
            // top of run() — before this, a packaged build's fd 1/2 are /dev/null.
            fd_limit::report();
            println!(
                "[papercusp-desktop] role={} (identifier {})",
                role.label(),
                app.config().identifier
            );
            let is_dev = cfg!(debug_assertions);

            // Demo-pipeline version gate (demo-pipeline-version-gate-2026-07-13):
            // write THIS running app's real version to a well-known file so the
            // capture pipeline can assert it is filming the current build, not a
            // stale installed binary (draft 4 filmed a July-4 0.0.2 binary while
            // the repo was already 0.0.9). Best-effort — a self-report failure
            // must never crash the app. Only the GUI/dev process writes it (the
            // windowless Server would otherwise race the same file); the GUI is
            // what the demo films.
            if is_dev || role.is_gui() {
                // Display-scoped filename so two GUI instances on different X
                // displays (e.g. a dev app on :1 and a staged demo app on :110)
                // never clobber each other's report — the capture pipeline reads
                // the file for the exact display it is about to record.
                let disp = std::env::var("DISPLAY").unwrap_or_default();
                let fname = if disp.is_empty() {
                    "desktop-app-version.json".to_string()
                } else {
                    format!(
                        "desktop-app-version-{}.json",
                        disp.replace(':', "").replace('.', "_")
                    )
                };
                let ver_path = workspaces::shared_sidecar_home()
                    .join(".papercusp")
                    .join(&fname);
                let started_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let report = serde_json::json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "pid": std::process::id(),
                    "startedAtMs": started_ms,
                    "display": disp,
                    "role": role.label(),
                    "isDev": is_dev,
                });
                if let Some(parent) = ver_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                match std::fs::write(
                    &ver_path,
                    serde_json::to_vec_pretty(&report).unwrap_or_else(|_| b"{}".to_vec()),
                ) {
                    Ok(_) => println!(
                        "[papercusp-desktop] version self-report v{} pid {} -> {}",
                        env!("CARGO_PKG_VERSION"),
                        std::process::id(),
                        ver_path.display()
                    ),
                    Err(e) => eprintln!(
                        "[papercusp-desktop] failed to write version self-report to {}: {e}",
                        ver_path.display()
                    ),
                }
            }

            // Boot-time WebKitGTK localStorage WAL reclaim (EI-14135). Runs
            // HERE — synchronously in setup, before the async page load reaches
            // the JS that first opens window.localStorage — so no persistent
            // webview reader is present and the TRUNCATE checkpoint can fully
            // reset a runaway `-wal` (observed at ~127 GiB). GUI/dev only (the
            // windowless Server has no webview store); Linux only (macOS
            // WKWebView / Windows WebView2 use different localStorage backends
            // under different paths). Best-effort — never fails boot.
            #[cfg(target_os = "linux")]
            if is_dev || role.is_gui() {
                match app.path().app_local_data_dir() {
                    Ok(dir) => localstorage_wal::reclaim_on_boot(&dir),
                    Err(e) => eprintln!(
                        "[papercusp-desktop] localstorage WAL reclaim skipped — no app_local_data_dir: {e}"
                    ),
                }
            }

            // Every role may host a webview: the Server owns the Quick Panel.
            // Manage terminal state for its commands in every role, with a
            // disabled strategy on the windowless Server.
            init_native_terminal(app, is_dev || role.is_gui());

            if is_dev {
                // In dev mode we trust the developer (or beforeDevCommand's
                // dev-operator-ifneeded.sh) to run the operator dev stack
                // externally; the webview points at devUrl from
                // tauri.conf.json (:3070, the Hono host).
                println!("[papercusp-desktop] dev mode — skipping sidecar spawn (expecting devUrl :3070 to be served externally)");

                // tauri-agent-tools dev bridge — debug-only, localhost-only,
                // token-authenticated. Writes /tmp/tauri-dev-bridge-<pid>.token
                // for the CLI to auto-discover.
                match dev_bridge::start_bridge(app.handle()) {
                    Ok((port, _log_buffer, _sidecar_registry)) => {
                        println!("[papercusp-desktop] dev bridge listening on 127.0.0.1:{port}");
                    }
                    Err(e) => {
                        eprintln!("[papercusp-desktop] failed to start dev bridge: {e}");
                    }
                }

                // Devtools auto-open is OPT-IN via PAPERCUSP_AUTO_DEVTOOLS=1.
                // It used to fire unconditionally in debug, but WebKitGTK opens
                // the Web Inspector ATTACHED — it splits/takes over the main
                // window — so every dev launch shoved an inspector pane into
                // the owner's face, and when webview paint was degraded the
                // inspector chrome was ALL the user saw ("all it says is web
                // inspector", 2026-07-05, WI-2817 fallout). Agents inspect via
                // the dev bridge (tauri-agent-tools) or Ctrl+Shift+I; neither
                // needs the auto-pop.
                if let Some(window) = app.get_webview_window("main") {
                    restore_window_visibility(&window, "dev-setup");
                    // `open_devtools` is compiled out in release unless the
                    // tauri `devtools` feature is on (and we don't want
                    // devtools popping in a shipped/release build anyway).
                    #[cfg(debug_assertions)]
                    if std::env::var_os("PAPERCUSP_AUTO_DEVTOOLS").is_some_and(|v| v == "1") {
                        window.open_devtools();
                    }
                    // WebKitGTK denies getUserMedia by default; auto-grant
                    // so the operator's voice/wake-word/elevenlabs paths
                    // work without surfacing NotAllowedError on every load.
                    #[cfg(target_os = "linux")]
                    grant_media_permission(&window);
                    #[cfg(target_os = "linux")]
                    install_load_failure_recovery(&window);
                }

                // DEV endpoint-IPC: we don't spawn the sidecar in dev, so
                // there's no stdout PAPERCUSP_IPC_READY handshake. The
                // externally-run operator publishes its socket path to
                // ~/.papercusp/endpoint-ipc.json instead. Manage a reconnecting
                // handle whose socket source RE-READS that file on every
                // (re)connect — so the webview's /api fetch + EventSource ride
                // IPC (escaping libsoup's 6-socket pool), AND a restarted
                // operator's new socket is picked up automatically instead of
                // wedging onto the hanging HTTP fallback. Graceful HTTP
                // fallback while the operator is down.
                #[cfg(debug_assertions)]
                if let Some(home) = std::env::var_os("HOME") {
                    // An explicit custom target must be visible to the IPC
                    // socket resolver BEFORE keep_warm can make its first
                    // connection. Applying it only in env_switch::init below
                    // allowed an isolated WebView to hydrate once from the
                    // static :3070 default, then retain that live state after
                    // the later reset/re-dial (EI-22626134896342971).
                    env_switch::prime_explicit_api_target();
                    let papercusp_dir = native_papercusp_dir(std::path::Path::new(&home));
                    // EI-190: resolve the socket for the SELECTED operator
                    // (the dev wrapper's build switcher), re-read on every
                    // (re)connect — so /api deliberately follows the chosen
                    // build instead of the singleton's restart-order accident.
                    // EI-18763945004822208: VALIDATED read — a restart-orphaned
                    // advertisement (dead pid, or its socket file gone) is
                    // treated as "not ready yet" rather than dialed straight
                    // into a measured 100%-failure ENOENT storm.
                    let dir_src = papercusp_dir.clone();
                    let dev_via_wsl = should_route_via_wsl(app.handle());
                    // Honour the same kill switch the packaged path does. It
                    // was previously ignored here, so `PAPERCUSP_DESKTOP_IPC=0`
                    // silently did nothing in dev — the one place people
                    // actually reach for it while debugging transport issues.
                    // (An if/else, not an early return: this closure is Tauri's
                    // `setup`, and returning here would skip everything after
                    // it — env_switch init, the docs palette, the lot.)
                    if std::env::var("PAPERCUSP_DESKTOP_IPC").ok().as_deref() == Some("0") {
                        app.manage(endpoint_ipc::IpcClientHandle::disabled(
                            "PAPERCUSP_DESKTOP_IPC=0",
                        ));
                        println!(
                            "[papercusp-desktop] dev endpoint-ipc DISABLED (PAPERCUSP_DESKTOP_IPC=0) — /api on HTTP"
                        );
                    } else {
                        let handle = endpoint_ipc::IpcClientHandle::new(move || {
                            let port =
                                SELECTED_API_PORT.load(std::sync::atomic::Ordering::Relaxed);
                            resolve_dev_ipc_socket(&dir_src, port, dev_via_wsl)
                        });
                        app.manage(handle.clone());
                        // Supervise for the life of the process. The dev
                        // operator is routinely restarted (every agent's
                        // dev:restart, every deploy) and its embedded-PG boot
                        // can exceed a minute, so the old bounded 60s warm-up
                        // regularly expired BEFORE the operator it was waiting
                        // for existed — and then stopped trying. `keep_warm`
                        // connects the instant an advertisement appears and
                        // re-connects if it drops.
                        tauri::async_runtime::spawn(
                            handle.keep_warm(Duration::from_millis(500)),
                        );
                    }
                }

                // Env-switch startup (env_switch::init): install the dev-rail
                // signal + restore the persisted env target. AFTER the
                // endpoint-IPC manage above — it retargets /api to the persisted
                // build (EI-190), which needs the managed handle to reset.
                // Dev-only by design: the packaged app drives its own sidecar on
                // a dynamic port / papercusp:// origin where the fixed
                // :3070/:3170/:3055 targets are meaningless. The VISIBLE bar is
                // the in-webview EnvSwitcherBar (fed by the list_envs command);
                // the native menu + global-shortcut backstop (install_backstop)
                // is the unkillable escape hatch.
                env_switch::init(app);
                // Invisible escape hatch: CmdOrCtrl+Alt+1..4 switch envs even
                // when the loaded build's own bar + IPC are dead. No menu bar.
                env_switch::register_backstop_shortcuts(app);
                // WI-2648: the docs-search palette global shortcut. Real feature
                // (not a dev-only escape hatch). THIS call site is the DEV process
                // only, which is a single process and so owns the shortcut itself.
                // In PACKAGED builds the always-on SERVER product registers it
                // (next to install_server_tray, `is_server_product`); gui_setup()
                // deliberately does NOT — the GUI must not own a key that has to
                // work while the GUI is closed.
                docs_search::register_shortcut(app);

                // `npm run dev:quickpanel` — preview the Quick Panel from the working
                // tree. PAPERCUSP_DEV_OPEN_QUICK_PANEL controls it:
                //   =1     → keep the full app window, open the palette popup
                //            always-on-top over it (preview the real popup window).
                //   =only  → turn the MAIN window INTO the Quick Panel: navigate it
                //            to /quick-panel (which renders CHROMELESS — no env bar,
                //            sidebars, or chat, see operator-vite CHROMELESS_PREFIXES)
                //            and shrink it to the popup's size, so `dev:quickpanel`
                //            shows JUST the tabbed panel, not the whole operator. No
                //            second window and no window-hide (some Linux WMs don't
                //            honor hide()), so it behaves identically everywhere.
                // Dev-only, opt-in (a no-op unless the env var is set), best-effort.
                // Deferred via run_on_main_thread after a short settle for the
                // beforeDevCommand operator + first paint; the eval preserves the
                // current ?ws=/slug= query so the panel stays workspace-scoped.
                let qp_env = std::env::var("PAPERCUSP_DEV_OPEN_QUICK_PANEL").ok();
                let qp_open = qp_env
                    .as_deref()
                    .map(|v| v != "0" && !v.is_empty())
                    .unwrap_or(false);
                let qp_only = qp_env.as_deref() == Some("only");
                if qp_open {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(3000));
                        let h = handle.clone();
                        let _ = handle.run_on_main_thread(move || {
                            if qp_only {
                                if let Some(main) = h.get_webview_window("main") {
                                    let _ = main.set_title("Quick Panel");
                                    let _ = main
                                        .set_size(tauri::LogicalSize::new(760.0, 540.0));
                                    let _ = main.eval(
                                        "window.location.assign('/quick-panel' + window.location.search)",
                                    );
                                }
                            } else {
                                docs_search::open_palette(&h);
                            }
                        });
                    });
                }

                return Ok(());
            }

            // Packaged builds split into two bundles (one binary, two roles).
            // GUI: attach to a running Server (auto-launch it if needed); it
            // never spawns or owns a sidecar, so quit never tears the backend
            // down. Server: fall through to the sidecar-owning boot below.
            if role.is_gui() {
                return gui_setup(app);
            }

            // ===== Server role: spawn + OWN the operator sidecar. =====
            // Invariant (WI-3170 P-003 / WI-2902 co-install footgun): ONLY the
            // Server role reaches here — the GUI role returned via gui_setup() above
            // and never spawns/owns an operator. Assert it so a future refactor that
            // lets a GUI fall through (spawning a competing operator that fights the
            // Server over PG/ports) fails loudly instead of silently double-owning
            // the operator. A plain assert! (one enum match at boot) so it holds in
            // release too — structurally it can never fire (the GUI returned above).
            assert!(
                role.owns_operator(),
                "only the Server role may spawn/own the operator (got role={})",
                role.label()
            );
            // (EI-8894/WI-3633 leg 2) Boot-time orphan sweep runs later, inside
            // bring_up_sidecar (right before spawn_serve) — that's the single
            // choke point both this fast path AND the Windows deferred-WSL
            // watcher path funnel through, and it's where workspace_home/
            // via_wsl are actually in scope. See sweep_stale_operator_orphan.
            // Production: spawn the sidecar.
            let port = match find_free_port() {
                Some(p) => p,
                None => {
                    eprintln!("[papercusp-desktop] no free port available");
                    return Ok(());
                }
            };

            let sidecar_dir = app
                .path()
                .resolve("sidecar", tauri::path::BaseDirectory::Resource)
                .unwrap_or_else(|_| std::path::PathBuf::from("./sidecar"));

            // Phase E (P-050 / D-008): ONE shared sidecar serves every
            // workspace. It runs under the real user HOME (`shared_sidecar_home`
            // — where ~/.claude / ~/.gitconfig live); per-workspace credential
            // isolation moves to each spawned CHILD's HOME (P-051, set
            // operator-side from the job's workspace). The embedded-PG data
            // lives in a SHARED dir (`shared_data_dir`), NOT under any one
            // workspace, because the DB is a single RLS-scoped instance for all
            // workspaces (D-006). `ensure_initialized()` still runs the
            // first-launch ~/.papercusp migration + provisions each per-workspace
            // dir's credentials, so the per-spawn HOME flip has populated
            // credential homes to point at.
            if let Err(e) = workspaces::ensure_initialized() {
                eprintln!("[papercusp-desktop] workspace registry init failed: {} (continuing with shared home)", e);
            }
            let workspace_home = workspaces::shared_sidecar_home();
            let shared_state_dir = workspaces::shared_data_dir();
            if let Err(e) = std::fs::create_dir_all(&shared_state_dir) {
                eprintln!("[papercusp-desktop] could not create shared state dir {}: {}", shared_state_dir.display(), e);
            }
            println!(
                "[papercusp-desktop] shared sidecar home: {} | shared state dir: {}",
                workspace_home.display(),
                shared_state_dir.display()
            );

            // PG (SP1 C5): embedded Postgres is OWNED BY SERVE now — port
            // selection, the orphan-postmaster sweep, the wire-protocol ready
            // probe, migrations, and the embedded-pg.json write all happen
            // inside serve.mjs. We only pick a fresh TCP port hint per spawn
            // so two desktops on one host don't collide (`serve --ensure`
            // makes same-HOME double-launches converge on ONE operator
            // instead of double-booting PG on one data dir).
            // PAPERCUSP_USE_EMBEDDED_PG=0 (external PG via the inherited
            // HARNESS_*_DATABASE_URL env) passes through inside spawn_serve.
            let pg_port_hint = portpicker::pick_unused_port().unwrap_or(15432);

            // On Windows the harness needs POSIX, so we route the sidecar
            // through `wsl.exe --distribution papercup-runtime` once the
            // user has finished the WslOnboardingGate. Until then we
            // skip the sidecar spawn — the gate covers the whole UI so
            // there's no app to talk to anyway. The frontend can later
            // call a respawn-sidecar command (TODO) once WSL transitions
            // to Ready, or we just rely on a manual app restart.
            let via_wsl = should_route_via_wsl(&app.handle());
            // Publish for AppHandle-less call sites (native pty routes its
            // commands through wsl.exe when the sidecar does).
            wsl_setup::set_route_active(via_wsl);

            // Point the window at the custom-protocol origin IMMEDIATELY —
            // never show the conf's frontendDist URL (:3070), which nothing
            // serves on a user machine: it renders a connection-refused page
            // for the whole 60-90s boot, and its own Refresh button reloads
            // the dead URL, stranding the user there permanently (reported
            // live 2026-06-11). Pre-discovery the handler serves the BUNDLED
            // SPA statics (D-009: renders WslOnboardingGate / a booting
            // shell); once serve is discovered, finish_boot reloads the
            // document against the live proxy.
            // onboarding_origin_enabled(), not enabled() — see the GUI-role
            // navigate above: Windows renders the WslOnboardingGate off this
            // pre-operator origin; the buffered scheme is NOT the steady-state
            // origin there (that stays the real HTTP port for SSE). WI-2734.
            if custom_protocol::onboarding_origin_enabled() {
                if let Some(window) = app.get_webview_window("main") {
                    restore_window_visibility(&window, "server-setup");
                    match custom_protocol::APP_ORIGIN.parse() {
                        Ok(u) => {
                            if let Err(e) = window.navigate(u) {
                                eprintln!("[papercusp-desktop] app-origin navigate failed: {e}");
                            }
                        }
                        Err(e) => {
                            eprintln!("[papercusp-desktop] APP_ORIGIN did not parse: {e}")
                        }
                    }
                }
            }

            // WSL-INDEPENDENT server setup — install NOW, before the WSL gate,
            // so the Windows deferred-boot path (pristine first run, WSL not yet
            // Ready) gets the tray + global shortcut + login-autostart WITHOUT a
            // restart. The old code ran these only in the post-WSL tail and
            // reached that tail via a breakaway restart, which raced the
            // single-instance lock and wedged (WI-3407). None depend on WSL or
            // the sidecar.
            // WI-2648: the always-on Server owns the docs-search palette global
            // shortcut — OFF unless the user opted in (WI-4480) — so it works
            // whether or not the GUI is open, and the tray's rebind control is
            // same-process.
            docs_search::register_shortcut(app);
            // The backend has no window, so the tray both keeps the app alive and
            // gives the user a place to open the GUI, change the docs-search
            // shortcut, or quit; auto-start means psu works right after login.
            if let Err(e) = install_server_tray(app) {
                eprintln!("[papercusp-desktop] tray install failed: {e}");
            }
            enable_login_autostart(app);
            // WI-4404: the Server has no webview, so nothing ever called
            // check_for_update for it — this is what actually makes it poll.
            // See spawn_server_update_poller's doc comment for why it stops at
            // "surface via the tray", not "auto-install".
            spawn_server_update_poller(app);

            #[cfg(target_os = "windows")]
            {
                let status = wsl_setup::detect(&app.handle());
                if !matches!(status.state, wsl_setup::WslState::Ready) {
                    println!(
                        "[papercusp-desktop] WSL not Ready — deferring sidecar spawn until onboarding finishes (detect: {:?})",
                        status
                    );
                    // Reload-proof finalize watcher: watch from the SHELL (not
                    // the reloadable gate page) — when detect() flips Ready,
                    // spawn the sidecar IN-PROCESS. This process is already the
                    // live singleton Server (holds the single-instance lock), so
                    // it just does its deferred job. The OLD path breakaway-
                    // restarted a 2nd instance (wsl_finalize_ready) to re-run
                    // setup with WSL Ready; that instance lost the single-instance
                    // race to this still-alive one and left the sidecar unspawned
                    // forever — every pristine first boot wedged (WI-3407).
                    let watcher_handle = app.handle().clone();
                    std::thread::spawn(move || loop {
                        std::thread::sleep(std::time::Duration::from_secs(10));
                        let status = wsl_setup::detect(&watcher_handle);
                        if matches!(status.state, wsl_setup::WslState::Ready) {
                            println!(
                                "[papercusp-desktop] WSL became Ready post-boot — spawning the sidecar in-process (no restart, WI-3407)"
                            );
                            // WI-3407 (serve-spawn leg): `via_wsl` was computed at
                            // STARTUP (~line 5017) when WSL was InstalledNoDistro, so
                            // it is FALSE here. Reusing that stale value launches
                            // serve.mjs with the WINDOWS `node` from the
                            // `\\?\C:\...\sidecar` cwd, where Node's CJS resolver
                            // realpathSync-EISDIRs on the bare `C:` drive ref → serve
                            // crash-loops → operator FATAL@120s (run C, 2026-07-09).
                            // We only reach this branch BECAUSE WSL is now Ready
                            // (`status` above), which is exactly should_route_via_wsl's
                            // Ready predicate, so routing via WSL is unconditionally
                            // correct — override to true and re-publish the route flag
                            // for AppHandle-less callers (native pty) before spawning.
                            let via_wsl = true;
                            wsl_setup::set_route_active(via_wsl);
                            // WI-3044: WSL is usable now — refresh the Windows
                            // `psu` launcher + PATH off-thread (shells to powershell).
                            std::thread::spawn(wsl_setup::ensure_windows_cli_shims);
                            bring_up_sidecar(
                                &watcher_handle,
                                via_wsl,
                                port,
                                sidecar_dir,
                                pg_port_hint,
                                shared_state_dir,
                                workspace_home,
                            );
                            return;
                        }
                    });
                    return Ok(());
                }
                // WI-3044: WSL is Ready — refresh the Windows-side `psu`
                // launcher + user PATH so a bare `psu` works from any
                // cmd/PowerShell window. Off-thread: it shells out to
                // powershell.exe and must never hold up boot.
                std::thread::spawn(wsl_setup::ensure_windows_cli_shims);
            }
            // Spawn + wire the operator sidecar. On Windows the fast path now
            // stages a content-addressed ext4 runtime before spawn (WI-305737),
            // which can copy several GiB after an update. Keep that finite copy
            // off Tauri's setup thread so the shell/tray remain responsive. The
            // deferred-Windows path above is already running on its watcher
            // thread; non-Windows has no staging leg and keeps the direct path.
            #[cfg(target_os = "windows")]
            {
                let sidecar_handle = app.handle().clone();
                std::thread::spawn(move || {
                    bring_up_sidecar(
                        &sidecar_handle,
                        via_wsl,
                        port,
                        sidecar_dir,
                        pg_port_hint,
                        shared_state_dir,
                        workspace_home,
                    );
                });
            }
            #[cfg(not(target_os = "windows"))]
            bring_up_sidecar(
                app.handle(),
                via_wsl,
                port,
                sidecar_dir,
                pg_port_hint,
                shared_state_dir,
                workspace_home,
            );

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // App-level exit is the ONE teardown trigger. A per-window
            // CloseRequested arm used to sit here too — that killed the
            // shared operator whenever ANY window closed (including a
            // secondary `ws-<id>` workspace window, stranding every other
            // window), and on the plain quit path it ran the teardown again
            // when ExitRequested/Exit followed (P-051). Closing the last
            // window ends the event loop, so ExitRequested → Exit still
            // covers the single-window quit.
            // Safety net for the windowless Server: a window-close-triggered
            // ExitRequested has `code == None`. The Server is kept alive by its
            // TRAY, not a window — its only transient window is the docs-search
            // palette — so vetoing that exit stops the palette's dismissal from
            // tearing the whole Server (operator + embedded PG) down (WI-2648).
            // An explicit tray "Quit" calls app.exit(0) → `code == Some(0)` →
            // falls through to a real teardown. The GUI role keeps the old
            // behavior (closing its window quits it; it owns no operator).
            RunEvent::ExitRequested { code, api, .. } => {
                let is_server = matches!(
                    app_role::detect(&app_handle.config().identifier),
                    app_role::Role::Server
                );
                if code.is_none() && is_server {
                    api.prevent_exit();
                } else {
                    shutdown_children_once(app_handle);
                }
            }
            RunEvent::Exit => {
                shutdown_children_once(app_handle);
            }
            _ => {}
        });
}

// (SP1 C5) sweep_orphan_postgres moved to serve.ts (sweepOrphanPostgres) —
// PG lifecycle ownership lives in `papercusp serve` now, so the orphan
// sweep runs there, right before startEmbeddedPostgresServer.

/// Send SIGTERM to a Child, wait up to `grace_ms` for it to exit, then
/// SIGKILL if still alive. Returns once the child has actually reaped.
///
/// Why not just `Child::kill()`? On Unix that's SIGKILL, which gives the
/// process zero chance to clean up its own children. The embedded-postgres
/// Node wrapper spawns a real postgres binary as a grandchild — SIGKILLing
/// the wrapper orphans the postgres process to PID 1 (init). Diagnostic
/// 2026-05-06 found postgres PIDs persisting across desktop restarts that
/// way, eventually colliding with the new instance's data dir lock.
///
/// SIGTERM lets the Node wrapper run its own SIGTERM handler, which in
/// turn `pg_ctl stop`s its postgres child cleanly. Same logic applies to
/// zero-cache (which manages a change-streamer child).
fn graceful_kill(child: &mut Child, label: &str, grace_ms: u64) {
    let pid = child.id();
    println!(
        "[papercusp-desktop] terminating {} pid={} (soft signal, grace {}ms)",
        label, pid, grace_ms
    );
    // Send SIGTERM via /bin/kill — avoids pulling in a new Rust dep
    // for one syscall. `Command::kill()` from std would send SIGKILL.
    #[cfg(unix)]
    {
        // (EI-8894/WI-3633 leg 1) TERM the whole PROCESS GROUP, not just this
        // pid. `isolate_process_group` (process_group(0)) made this child's
        // pgid == its own pid at spawn, so `-<pid>` (negative = group form of
        // kill(2)) reaches this child AND any grandchildren it forked that
        // never called setsid/setpgid to leave the group (e.g. embedded PG's
        // postmaster) — not just the direct child. Node's own SIGTERM handler
        // still runs identically (it's still the same signal, same target
        // process, just delivered via the group form); this only widens the
        // blast radius to siblings-in-group that a plain per-pid TERM missed.
        let status = Command::new("kill")
            .arg("-TERM")
            // procps-ng parses a bare negative operand as another option-like
            // signal token. `--` is required before the negative process-group
            // id; without it `kill -TERM -5034` can target pgid 5 instead of
            // pgid 5034, silently missing both Node and embedded Postgres.
            .arg("--")
            .arg(format!("-{pid}"))
            .status();
        match status {
            Ok(status) if status.success() => {}
            Ok(status) => eprintln!(
                "[papercusp-desktop] {label} pid={pid}: process-group SIGTERM failed with {status}"
            ),
            Err(error) => eprintln!(
                "[papercusp-desktop] {label} pid={pid}: could not invoke process-group SIGTERM: {error}"
            ),
        }
    }
    #[cfg(windows)]
    {
        // (P-055) CTRL_BREAK_EVENT instead of an immediate TerminateProcess:
        // Node surfaces it as SIGBREAK, so serve.mjs's shutdown handler runs
        // and embedded PG gets a clean `pg_ctl stop`. The children are
        // spawned with CREATE_NEW_PROCESS_GROUP (isolate_process_group) so
        // the event targets exactly that child's group, not ours. Honest
        // limit (not runtime-verified on Windows): the event only reaches
        // processes sharing a console with us, so from a console-less GUI
        // launch it may reach nobody — then the grace below lapses and the
        // TerminateProcess fallback fires, which is the old behavior.
        use windows::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT};
        if unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) }.is_err() {
            eprintln!(
                "[papercusp-desktop] {} pid={}: CTRL_BREAK_EVENT not deliverable — relying on the hard-kill fallback",
                label, pid
            );
        }
    }
    // Poll for exit up to grace_ms.
    let deadline = Instant::now() + Duration::from_millis(grace_ms);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_status)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    // Grace expired — escalate to a hard kill (SIGKILL / TerminateProcess).
    println!(
        "[papercusp-desktop] {} pid={} still alive after grace, hard kill",
        label, pid
    );
    #[cfg(unix)]
    {
        // Same group-vs-pid widening as the TERM stage above: a grandchild
        // that outlived the soft signal (or joined the group after it) still
        // needs to go down here, not just the direct child `child.kill()`
        // below reaches.
        let status = Command::new("kill")
            .arg("-KILL")
            .arg("--")
            .arg(format!("-{pid}"))
            .status();
        match status {
            Ok(status) if status.success() => {}
            Ok(status) => eprintln!(
                "[papercusp-desktop] {label} pid={pid}: process-group SIGKILL failed with {status}"
            ),
            Err(error) => eprintln!(
                "[papercusp-desktop] {label} pid={pid}: could not invoke process-group SIGKILL: {error}"
            ),
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(test, unix))]
mod graceful_kill_process_group_tests {
    use super::{graceful_kill, isolate_process_group};
    use std::fs;
    use std::process::Command;
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    fn temp_marker(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "papercusp-graceful-kill-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn wait_for_file(path: &std::path::Path) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !path.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(path.exists(), "fixture did not create {}", path.display());
    }

    fn process_group_alive(pgid: u32) -> bool {
        Command::new("kill")
            .args(["-0", "--", &format!("-{pgid}")])
            .status()
            .is_ok_and(|status| status.success())
    }

    fn wait_for_group_exit(pgid: u32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if !process_group_alive(pgid) {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn soft_term_reaches_the_isolated_process_group() {
        let marker = temp_marker("term");
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("trap 'printf reached > \"$1\"; exit 0' TERM; printf ready > \"$2\"; while :; do sleep 1; done")
            .arg("sh")
            .arg(&marker)
            .arg(marker.with_extension("ready"));
        isolate_process_group(&mut command);
        let ready = marker.with_extension("ready");
        let mut child = command.spawn().expect("spawn TERM fixture");
        wait_for_file(&ready);

        graceful_kill(&mut child, "TERM fixture", 1_000);

        assert_eq!(
            fs::read_to_string(&marker).expect("read TERM marker"),
            "reached"
        );
        let _ = fs::remove_file(marker);
        let _ = fs::remove_file(ready);
    }

    #[test]
    fn hard_fallback_kills_a_same_group_grandchild() {
        let grandchild_file = temp_marker("grandchild");
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("trap '' TERM; sleep 30 & printf '%s' \"$!\" > \"$1\"; wait")
            .arg("sh")
            .arg(&grandchild_file);
        isolate_process_group(&mut command);
        let mut child = command.spawn().expect("spawn KILL fixture");
        let pgid = child.id();
        wait_for_file(&grandchild_file);
        assert!(process_group_alive(pgid), "fixture process group is live");

        graceful_kill(&mut child, "KILL fixture", 100);

        let exited = wait_for_group_exit(pgid);
        if !exited {
            let _ = Command::new("kill")
                .args(["-KILL", "--", &format!("-{pgid}")])
                .status();
        }
        let _ = fs::remove_file(grandchild_file);
        assert!(exited, "same-group grandchild survived hard fallback");
    }
}

/// Kill the native sibling terminal (if any) on shutdown. `try_state` so it's
/// a no-op when the terminal was never managed (headless / opted out).
fn shutdown_native_terminal(app_handle: &tauri::AppHandle) {
    if let Some(nt) = app_handle.try_state::<native_terminal::NativeTerminal>() {
        nt.shutdown();
    }
}

/// The outcomes `sweep_stale_operator_orphan` can reach, factored out as
/// a PURE decision (no OS calls) so it's unit-testable without a live process
/// table / network. `sweep_stale_operator_orphan` is the thin OS-facing
/// wrapper that gathers the three inputs and acts on the verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OrphanSweepDecision {
    /// No operator.json — first boot ever, or a previous instance shut down
    /// cleanly and removed it. Nothing to sweep.
    NothingRecorded,
    /// operator.json named a pid, but it's already gone at the OS level.
    /// Nothing to kill; the fresh spawn below will overwrite the stale file.
    AlreadyDead,
    /// The pid is alive AND HTTP-responsive — this IS the healthy
    /// `serve --ensure` "Decision C" reuse case (SP1 C5): a still-running,
    /// currently-serving operator from either this boot or a still-alive
    /// prior one. Must NEVER be touched.
    HealthyReuse,
    /// The pid is alive but NOT HTTP-responsive — a genuinely wedged/zombie
    /// leftover (the actual WI-3633 bug case): its own parent-death watch
    /// either never installed (older build) or never ran (crashed before
    /// install), so it never self-terminated on reparenting. Sweep it.
    StaleKill,
    /// A live, unresponsive pid is present, but the discovery record cannot
    /// prove it is the same serve incarnation. Fail closed and leave it alone.
    RefusedUnverified,
}

fn decide_orphan_sweep(
    discovery: Option<&OperatorDiscovery>,
    pid_alive: bool,
    http_ready: bool,
    kill_authority_verified: bool,
) -> OrphanSweepDecision {
    if discovery.is_none() {
        return OrphanSweepDecision::NothingRecorded;
    }
    if !pid_alive {
        return OrphanSweepDecision::AlreadyDead;
    }
    if http_ready {
        return OrphanSweepDecision::HealthyReuse;
    }
    if !kill_authority_verified {
        return OrphanSweepDecision::RefusedUnverified;
    }
    OrphanSweepDecision::StaleKill
}

/// (EI-8894/WI-3633 leg 2) Boot-time orphan sweep for the workspace's tracked
/// operator, run once right before we spawn our own fresh sidecar. Belt-and-
/// suspenders alongside the parent-death self-exit watch in serve.ts (which
/// only self-terminates a sidecar that is itself still alive and polling its
/// own ppid): this catches the case that watch missed — a wedged/zombie
/// leftover from a hard-killed prior Server (`launchctl kickstart -k`,
/// `pkill -9`, a crash) that skipped both our own SIGTERM path AND (an older
/// build, or a crash before the watch installed) its own self-exit watch —
/// so a relaunch doesn't leave it running invisibly forever alongside the new
/// one, fighting over the port / embedded-PG data-dir lock / stale env.
///
/// Deliberately does NOT do a broad process-table scan for any `serve.mjs`.
/// Live macOS verification (2026-07-09, papercup-vm-mac) found MULTIPLE
/// legitimately-running `serve.mjs` processes at once — the tracked operator
/// PLUS a per-env `env-sidecars/staging/serve.mjs` — and BOTH correctly show
/// PPID==1, because on macOS a launchd/login-item-launched process (this
/// Server app itself, and by extension any child that outlives its original
/// spawning instance) NORMALLY reparents to launchd; PPID==1 is NOT itself an
/// orphan signal on this platform the way it would be under a shell/systemd.
/// A blind "PPID==1 + serve.mjs" match would have KILLED a live, in-use,
/// currently-reused operator (`serve --ensure`'s "Decision C" reuse — SP1
/// C5), a real regression this live check caught before it shipped. Scoping to
/// one recorded pid is still insufficient: copied state or PID reuse can make
/// that number identify the desktop session itself. Destructive cleanup also
/// requires the recorded boot + start-time identity to match the current
/// process and a strict serve cmdline. The signal targets that one PID, never
/// a process group.
fn sweep_stale_operator_orphan(workspace_home: &std::path::Path, via_wsl: bool) {
    let discovery = find_operator_discovery(workspace_home, via_wsl);
    let pid_alive = discovery
        .as_ref()
        .is_some_and(|d| discovery_pid_alive(d.pid, via_wsl));
    let http_ready = discovery
        .as_ref()
        .is_some_and(|d| operator_http_ready(d.port));
    let kill_authority_verified = discovery
        .as_ref()
        .is_some_and(|d| recorded_operator_kill_authority(d, via_wsl));
    match decide_orphan_sweep(
        discovery.as_ref(),
        pid_alive,
        http_ready,
        kill_authority_verified,
    ) {
        OrphanSweepDecision::NothingRecorded | OrphanSweepDecision::AlreadyDead => {}
        OrphanSweepDecision::HealthyReuse => {
            println!(
                "[papercusp-server] boot orphan sweep: operator.json pid={} is alive + HTTP-responsive — healthy reuse, leaving it running",
                discovery.as_ref().map(|d| d.pid).unwrap_or(0)
            );
        }
        OrphanSweepDecision::StaleKill => {
            let d = discovery.expect("StaleKill only reached with Some(discovery)");
            println!(
                "[papercusp-server] boot orphan sweep: operator.json pid={} port={} is alive, identity-verified, and NOT HTTP-responsive — terminating that exact process",
                d.pid, d.port
            );
            #[cfg(unix)]
            {
                if !recorded_operator_kill_authority(&d, via_wsl) {
                    eprintln!(
                        "[papercusp-server] boot orphan sweep: pid={} identity changed before TERM — refusing signal",
                        d.pid
                    );
                    return;
                }
                let _ = Command::new("kill")
                    .arg("-TERM")
                    .arg(d.pid.to_string())
                    .status();
                let deadline = Instant::now() + Duration::from_millis(3000);
                while Instant::now() < deadline && discovery_pid_alive(d.pid, via_wsl) {
                    std::thread::sleep(Duration::from_millis(150));
                }
                // Revalidate after grace so a recycled replacement never
                // receives the forceful signal.
                if recorded_operator_kill_authority(&d, via_wsl) {
                    let _ = Command::new("kill")
                        .arg("-KILL")
                        .arg(d.pid.to_string())
                        .status();
                }
            }
            #[cfg(not(unix))]
            {
                // Windows: the tracked pid may be the WSL-side Linux pid, which
                // has no POSIX process-group kill available from here. Out of
                // scope for this Unix-focused leg (WI-3633 is macOS-scoped);
                // the existing wsl_graceful_stop_serve / TerminateProcess paths
                // still run on the NEXT owned-child teardown either way.
                let _ = d;
            }
        }
        OrphanSweepDecision::RefusedUnverified => {
            let d = discovery.expect("RefusedUnverified only reached with Some(discovery)");
            eprintln!(
                "[papercusp-server] boot orphan sweep: refusing recorded pid={} port={} — no matching boot/start identity + serve role; leaving it untouched",
                d.pid, d.port
            );
        }
    }
}

#[cfg(test)]
mod orphan_sweep_decision_tests {
    use super::{decide_orphan_sweep, OperatorDiscovery, OrphanSweepDecision};

    fn disc() -> OperatorDiscovery {
        OperatorDiscovery {
            port: 3070,
            pid: 4242,
            process_identity: Some("linux:test-boot:123".to_string()),
        }
    }

    #[test]
    fn no_discovery_file_is_nothing_recorded() {
        assert_eq!(
            decide_orphan_sweep(None, false, false, false),
            OrphanSweepDecision::NothingRecorded
        );
        // pid_alive/http_ready are meaningless without a discovery record —
        // NothingRecorded wins regardless of what they'd say.
        assert_eq!(
            decide_orphan_sweep(None, true, true, true),
            OrphanSweepDecision::NothingRecorded
        );
    }

    #[test]
    fn dead_pid_is_already_dead_never_killed() {
        let d = disc();
        assert_eq!(
            decide_orphan_sweep(Some(&d), false, false, false),
            OrphanSweepDecision::AlreadyDead
        );
        // Even a (nonsensical) http_ready:true with a dead pid stays AlreadyDead
        // — pid liveness gates before the HTTP check ever matters.
        assert_eq!(
            decide_orphan_sweep(Some(&d), false, true, true),
            OrphanSweepDecision::AlreadyDead
        );
    }

    #[test]
    fn alive_and_responsive_is_healthy_reuse_never_killed() {
        // The exact "Decision C" live-reuse case live macOS verification
        // found — MUST NOT be swept.
        let d = disc();
        assert_eq!(
            decide_orphan_sweep(Some(&d), true, true, false),
            OrphanSweepDecision::HealthyReuse
        );
    }

    #[test]
    fn alive_but_unresponsive_is_the_only_kill_case() {
        let d = disc();
        assert_eq!(
            decide_orphan_sweep(Some(&d), true, false, true),
            OrphanSweepDecision::StaleKill
        );
    }

    #[test]
    fn alive_unresponsive_but_unverified_is_refused_never_killed() {
        let d = disc();
        assert_eq!(
            decide_orphan_sweep(Some(&d), true, false, false),
            OrphanSweepDecision::RefusedUnverified
        );
    }
}

/// Take ownership of the sidecar Child (if any) and kill it.
///
/// This is a function rather than inline so the temporary MutexGuard from
/// `state.child.lock()` is dropped before the borrow of `state` ends —
/// inlining triggered borrow-checker E0597 in Rust 2021 because the guard
/// outlived the local `state` binding.
///
/// (SP1 C5) The serve child owns embedded-PG in-process: SIGTERM triggers
/// serve's own shutdown handler (close host → remove operator.json →
/// pg.stop() → release cold-start lock), so it gets a longer grace than the
/// old bare sidecar before the SIGKILL fallback. When `serve --ensure`
/// REUSED a foreign operator, `state.child` holds the (already-exited)
/// ensure process — killing it is a no-op and the reused operator keeps
/// running, which is the intended singleton semantics (Decision C).
///
/// Each stage uses graceful_kill (SIGTERM with grace, then SIGKILL) so Node
/// intermediates can reap their own grandchildren — see graceful_kill's doc
/// comment for why this matters.
fn kill_sidecar(app_handle: &tauri::AppHandle) {
    let state: tauri::State<SidecarState> = app_handle.state();
    let maybe_child = state.child.lock().unwrap().take();
    if let Some(mut child) = maybe_child {
        // WSL-routed serve: the Child is only the wsl.exe RELAY. No Windows
        // console signal reaches the Linux-side node (CTRL_BREAK needs a
        // shared console; a GUI launch has none), so graceful_kill's soft
        // stage always lapsed into TerminateProcess on the relay — serve
        // never ran its shutdown handler and embedded PG was left needing
        // WAL recovery every boot (observed live 2026-06-11, P-010e).
        // Instead, SIGTERM the Linux pid (from the distro-side
        // operator.json) through wsl.exe itself. Only when we OWN a live
        // relay — an already-exited child means `--ensure` reused a foreign
        // operator that must keep running (Decision C).
        #[cfg(target_os = "windows")]
        let wsl_stopped = matches!(child.try_wait(), Ok(None))
            && wsl_setup::detect_ready_cached()
            && wsl_graceful_stop_serve(8000);
        #[cfg(not(target_os = "windows"))]
        let wsl_stopped = false;
        if wsl_stopped {
            // serve is down (host closed, operator.json removed, pg_ctl
            // stopped); the relay exits by itself — give it a beat, then
            // make sure it's reaped.
            let deadline = Instant::now() + Duration::from_millis(2000);
            while Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                    Err(_) => break,
                }
            }
            let _ = child.kill();
            let _ = child.wait();
            println!("[papercusp-desktop] serve stopped cleanly inside WSL (pg_ctl stop ran)");
        } else {
            graceful_kill(&mut child, "serve (operator + embedded-PG)", 8000);
        }
    }
}

/// Soft-stop the WSL-side serve: read its LINUX pid from the distro-side
/// operator.json, SIGTERM it inside the distro, and wait up to `grace_ms`
/// for the pid to vanish (serve's SIGTERM handler closes the host, removes
/// operator.json, `pg_ctl stop`s embedded PG and releases the cold-start
/// lock). Returns true only when the pid is confirmed gone — any failure
/// falls back to the caller's relay-kill path.
#[cfg(target_os = "windows")]
fn wsl_graceful_stop_serve(grace_ms: u64) -> bool {
    // Read the distro-side operator.json via `wsl.exe cat` — the same robust
    // path find_operator_discovery uses. (Was read via the \\wsl.localhost UNC
    // share, which is unreliable on the VM, so this graceful-stop silently
    // failed and always fell back to the caller's relay-kill.)
    let Some(d) = read_operator_discovery_via_wsl() else {
        return false;
    };
    println!(
        "[papercusp-desktop] terminating serve inside WSL (linux pid={}, SIGTERM, grace {grace_ms}ms)",
        d.pid
    );
    let sent = Command::new("wsl.exe")
        .args([
            "--distribution",
            wsl_setup::DISTRO_NAME_PUB,
            "--exec",
            "kill",
            "-TERM",
            &d.pid.to_string(),
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !sent {
        return false;
    }
    let deadline = Instant::now() + Duration::from_millis(grace_ms);
    while Instant::now() < deadline {
        if !discovery_pid_alive(d.pid, true) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    eprintln!(
        "[papercusp-desktop] serve (linux pid={}) still alive after grace — falling back to relay kill",
        d.pid
    );
    false
}

/// Run the exit teardown (native terminal + sidecar children) exactly once.
/// ExitRequested and Exit both arrive on a normal quit; the AtomicBool in
/// SidecarState gates every invocation after the first (P-051).
/// `install_update` still calls kill_sidecar directly — its children must
/// die before the binary swap — and the subsequent restart's Exit event
/// funnels through here for the terminal teardown.
fn shutdown_children_once(app_handle: &tauri::AppHandle) {
    let state: tauri::State<SidecarState> = app_handle.state();
    if state
        .shutdown_done
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }
    shutdown_native_terminal(app_handle);
    kill_sidecar(app_handle);
}

fn main() {
    run();
}
