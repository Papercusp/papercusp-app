use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
#[cfg(test)]
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Instant;
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Response, Server};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// Bridge protocol version exposed via `GET /version`. Bumped whenever the
/// HTTP surface changes shape so CLI clients can feature-detect.
pub const BRIDGE_VERSION: &str = "0.8.1";

/// Reserved object key used by the injected callback to carry a thrown
/// in-page exception back to the HTTP handler without making it look like a
/// successful primitive result. Normal object results are JSON-stringified
/// before they cross this seam, so this tagged object cannot collide with a
/// user expression's ordinary return value.
const EVAL_ERROR_RESULT_KEY: &str = "__papercusp_dev_bridge_error";

/// Owns the discovery token for exactly as long as the Tauri application.
///
/// This must be registered as managed app state. A function-local drop guard
/// removes the token as soon as `start_bridge` returns, while the bridge thread
/// and desktop process are still healthy, making every later PID-targeted CLI
/// call report `No bridge found`.
struct BridgeTokenFileGuard {
    path: PathBuf,
}

impl BridgeTokenFileGuard {
    fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

impl Drop for BridgeTokenFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn bridge_token_path_in(temp_dir: impl AsRef<Path>, pid: u32) -> PathBuf {
    temp_dir
        .as_ref()
        .join(format!("tauri-dev-bridge-{pid}.token"))
}

/// Write the bridge discovery token readable by the owning user ONLY.
///
/// The token authorizes `eval` inside the webview (which can invoke Tauri
/// commands), and it lives in the shared temp directory. `fs::write` would
/// create it under the process umask — 0644 on a typical box — so any other
/// local account could read it and drive the app (open-source-release P-010).
/// On unix the file is created fresh with O_EXCL + mode 0600: a stale file is
/// removed first, and `create_new` refuses to follow a pre-planted symlink.
fn write_private_token_file(path: &Path, contents: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(contents.as_bytes())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, contents)
    }
}

fn bridge_token_path(pid: u32) -> PathBuf {
    bridge_token_path_in(std::env::temp_dir(), pid)
}

#[derive(Deserialize)]
struct EvalRequest {
    js: String,
    token: String,
    #[serde(default)]
    window: Option<String>,
}

#[derive(Deserialize)]
struct LogRequest {
    token: String,
}

#[derive(Serialize)]
struct EvalResponse {
    result: serde_json::Value,
}

#[derive(Clone, Serialize)]
pub struct LogEntry {
    pub timestamp: u64,
    pub level: String,
    pub target: String,
    pub message: String,
    pub source: String,
}

#[derive(Serialize)]
struct LogResponse {
    entries: Vec<LogEntry>,
}

#[derive(Deserialize)]
struct DescribeRequest {
    token: String,
}

#[derive(Serialize, Default)]
struct DescribeResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    windows: Option<Vec<String>>,
    capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    surfaces: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exports: Option<HashMap<String, String>>,
}

#[derive(Serialize)]
struct VersionResponse {
    version: String,
    endpoints: Vec<String>,
}

#[derive(Deserialize)]
struct AuthedRequest {
    token: String,
}

#[derive(Serialize, Clone)]
struct SidecarSummary {
    name: String,
    pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    exe: Option<String>,
    args: Vec<String>,
    alive: Option<bool>,
}

#[derive(Serialize)]
struct ProcessResponse {
    tauri: TauriProcessInfo,
    sidecars: Vec<SidecarSummary>,
}

#[derive(Serialize)]
struct TauriProcessInfo {
    pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    exe: Option<String>,
    args: Vec<String>,
    uptime_ms: u64,
}

#[derive(Serialize, Clone)]
struct CapabilityEntry {
    identifier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    windows: Vec<String>,
    permissions: Vec<String>,
}

#[derive(Serialize)]
struct CapabilitiesResponse {
    /// Capabilities as declared in tauri.conf.json (best-effort: tauri 2 stores
    /// these as either bare strings or inline objects; we surface both shapes).
    declared: Vec<CapabilityEntry>,
    /// Window labels currently registered with Tauri.
    windows: Vec<String>,
}

#[derive(Serialize)]
struct DevtoolsResponse {
    platform: String,
    inspectable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    hint: String,
}

#[derive(Serialize)]
struct HealthResponse {
    uptime_ms: u64,
    webview_ready: bool,
    sidecars_alive: bool,
    sidecars: Vec<SidecarSummary>,
    /// EI-19357343092509867: the operator port THIS bridge's desktop routes
    /// `/api/*` to right now. Read from the live atomic for every request so
    /// an environment switch is visible immediately; a startup/persisted
    /// target can be stale after `retarget_api` runs.
    selected_api_port: u16,
    /// EI-13218: is the origin the main webview is CURRENTLY displaying
    /// actually answering HTTP right now? `sidecars_alive` above is PID-based
    /// only (`pid_alive`, a signal-0 check) and — in production — `sidecars`
    /// is always empty (nothing ever calls the test-only `register_sidecar` /
    /// `spawn_sidecar_monitored` outside this file's own tests, since the dev
    /// operator is spawned by a shell script, not by this process), so
    /// `sidecars_alive` was vacuously `true` regardless of whether the
    /// operator origin (:3270 in dev) could serve a request. That let
    /// `tauri-agent-tools probe`/`health` report a healthy bridge while the
    /// webview's own fetches to `/api/health` and `/` failed outright. `None`
    /// when there is no main webview or its URL can't be read (nothing to
    /// check); `Some(false)` means the origin refused/timed out/errored.
    operator_reachable: Option<bool>,
}

#[derive(Serialize)]
struct TokenFile {
    port: u16,
    token: String,
    pid: u32,
}

/// Per-process sidecar metadata captured at spawn time. Used by `/process`
/// and `/health` so an external diagnostic tool can see the process tree
/// without scraping `ps`.
struct SidecarRecord {
    name: String,
    pid: u32,
    exe: Option<String>,
    args: Vec<String>,
}

/// Thread-safe registry of sidecars known to this bridge. Populated by
/// `spawn_sidecar_monitored` automatically; users with their own spawn flow
/// can call `register_sidecar` after spawning. Aliveness is computed at
/// request time via a cheap signal-0 check.
pub struct SidecarRegistry {
    records: Mutex<Vec<SidecarRecord>>,
}

impl SidecarRegistry {
    pub fn new() -> Self {
        Self {
            records: Mutex::new(Vec::new()),
        }
    }

    #[cfg(test)]
    fn add(&self, record: SidecarRecord) {
        let mut recs = self.records.lock().unwrap();
        recs.push(record);
    }

    fn snapshot(&self) -> Vec<SidecarSummary> {
        let recs = self.records.lock().unwrap();
        recs.iter()
            .map(|r| SidecarSummary {
                name: r.name.clone(),
                pid: r.pid,
                exe: r.exe.clone(),
                args: r.args.clone(),
                alive: pid_alive(r.pid),
            })
            .collect()
    }
}

impl Default for SidecarRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Best-effort liveness probe for a sidecar PID. Returns `Some(true)` if the
/// process is running, `Some(false)` if it has exited, and `None` when we
/// can't determine (e.g., on Windows where we don't ship a probe in v1).
#[cfg(unix)]
fn pid_alive(pid: u32) -> Option<bool> {
    // SAFETY: libc::kill with signal 0 just checks process existence and never
    // delivers a signal. Returns 0 on success, -1 on error (e.g., ESRCH).
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    Some(rc == 0)
}

#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> Option<bool> {
    None
}

/// EI-13218: real HTTP reachability probe for the origin the main webview is
/// currently pointed at — the ground truth `sidecars_alive`'s PID-only check
/// (and the always-empty-in-production sidecar registry) never captures. ANY
/// response (even a 4xx/5xx) means the origin is answering, so this reports
/// `Some(true)`; a connect-refused/timeout/other transport error reports
/// `Some(false)`; an empty `url` (no webview / unreadable URL upstream)
/// reports `None` — "nothing to check", never a false failure. `client` is
/// injected so tests never depend on a real Tauri webview.
fn origin_reachable(client: &reqwest::blocking::Client, url: &str) -> Option<bool> {
    if url.is_empty() {
        return None;
    }
    Some(client.get(url).send().is_ok())
}

/// Register a sidecar process with the bridge so it shows up in `/process`
/// and `/health` responses. Callers that use `spawn_sidecar_monitored` get
/// this for free; callers who spawn their own children can register them
/// here. Idempotent in the sense that re-registering a name is allowed
/// (both entries will be reported).
#[cfg(test)]
pub fn register_sidecar(
    registry: &Arc<SidecarRegistry>,
    name: &str,
    pid: u32,
    exe: Option<String>,
    args: Vec<String>,
) {
    registry.add(SidecarRecord {
        name: name.to_string(),
        pid,
        exe,
        args,
    });
}

/// Ring buffer for log entries. Thread-safe, capped at 1000 entries.
pub struct LogBuffer {
    entries: Mutex<VecDeque<LogEntry>>,
}

impl LogBuffer {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(VecDeque::new()),
        }
    }

    pub fn push(&self, entry: LogEntry) {
        let mut buf = self.entries.lock().unwrap();
        if buf.len() >= 1000 {
            buf.pop_front();
        }
        buf.push_back(entry);
    }

    pub fn drain(&self) -> Vec<LogEntry> {
        let mut buf = self.entries.lock().unwrap();
        buf.drain(..).collect()
    }
}

/// A tracing layer that captures log events into a `LogBuffer`.
struct BridgeLogLayer {
    buffer: Arc<LogBuffer>,
}

impl<S> tracing_subscriber::Layer<S> for BridgeLogLayer
where
    S: tracing::Subscriber,
{
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let mut visitor = MessageVisitor {
            message: String::new(),
        };
        event.record(&mut visitor);

        let entry = LogEntry {
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            level: event.metadata().level().to_string().to_lowercase(),
            target: event.metadata().target().to_string(),
            message: visitor.message,
            source: "rust".to_string(),
        };

        self.buffer.push(entry);
    }
}

struct MessageVisitor {
    message: String,
}

impl tracing::field::Visit for MessageVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{:?}", value);
            // Remove surrounding quotes if present
            if self.message.starts_with('"') && self.message.ends_with('"') {
                self.message = self.message[1..self.message.len() - 1].to_string();
            }
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        }
    }
}

/// Create a tracing layer that captures logs into the given buffer.
/// Use this if you already have a tracing subscriber and want to add log capture.
///
/// ```rust
/// use tracing_subscriber::layer::SubscriberExt;
/// use tracing_subscriber::util::SubscriberInitExt;
///
/// let buffer = std::sync::Arc::new(dev_bridge::LogBuffer::new());
/// tracing_subscriber::registry()
///     .with(dev_bridge::create_log_layer(buffer.clone()))
///     .with(tracing_subscriber::fmt::layer())
///     .init();
/// ```
#[cfg(test)]
pub fn create_log_layer(
    buffer: Arc<LogBuffer>,
) -> impl tracing_subscriber::Layer<tracing_subscriber::Registry> {
    BridgeLogLayer { buffer }
}

/// Spawn a sidecar process with monitored stdout/stderr.
/// Lines from stdout are logged as "info", lines from stderr as "warn".
/// Returns the `std::process::Child` handle. If a `SidecarRegistry` is
/// supplied (recommended), the child is also recorded for `/process` and
/// `/health` responses; pass `None` to opt out of registry tracking.
#[cfg(test)]
pub fn spawn_sidecar_monitored(
    name: &str,
    command: &str,
    args: &[&str],
    log_buffer: &Arc<LogBuffer>,
    registry: Option<&Arc<SidecarRegistry>>,
) -> Result<std::process::Child, String> {
    let mut child = Command::new(command)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar {name}: {e}"))?;

    if let Some(reg) = registry {
        reg.add(SidecarRecord {
            name: name.to_string(),
            pid: child.id(),
            exe: Some(command.to_string()),
            args: args.iter().map(|s| s.to_string()).collect(),
        });
    }

    let source = format!("sidecar:{name}");

    // Monitor stdout
    if let Some(stdout) = child.stdout.take() {
        let buffer = log_buffer.clone();
        let source = source.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                buffer.push(LogEntry {
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                    level: "info".to_string(),
                    target: "stdout".to_string(),
                    message: line,
                    source: source.clone(),
                });
            }
        });
    }

    // Monitor stderr
    if let Some(stderr) = child.stderr.take() {
        let buffer = log_buffer.clone();
        let source = source.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                buffer.push(LogEntry {
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                    level: "warn".to_string(),
                    target: "stderr".to_string(),
                    message: line,
                    source: source.clone(),
                });
            }
        });
    }

    Ok(child)
}

/// Shared state for pending eval results.
/// The HTTP handler thread waits on the Condvar; the Tauri command inserts
/// the result and signals.
pub struct PendingResults {
    results: Mutex<HashMap<String, serde_json::Value>>,
    notify: Condvar,
}

/// Tauri command invoked from injected JS to deliver eval results back to Rust.
#[tauri::command]
#[specta::specta]
pub fn __dev_bridge_result(
    id: String,
    value: serde_json::Value,
    state: tauri::State<'_, Arc<PendingResults>>,
) {
    // Poison recovery (P-057): a panicking bridge thread poisons this mutex;
    // the map itself can't be torn by a panic between insert/notify, so
    // recover the guard instead of letting every later eval result die.
    let mut results = state
        .results
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    results.insert(id, value);
    state.notify.notify_all();
}

/// Start the development bridge HTTP server.
///
/// Returns the bound port, a shared log buffer, and a sidecar registry. Both
/// the buffer and registry are intended to be passed back to
/// `spawn_sidecar_monitored` for any sidecar processes you launch; the
/// registry is what powers the `/process` and `/health` endpoints' visibility
/// into the process tree. Callers that don't spawn sidecars can ignore the
/// registry handle.
pub fn start_bridge(
    app: &AppHandle,
) -> Result<(u16, Arc<LogBuffer>, Arc<SidecarRegistry>), String> {
    let server = Server::http("127.0.0.1:0").map_err(|e| format!("Failed to start bridge: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or("Failed to get server address")?
        .port();

    // Generate random token
    let token: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();

    // Write token file
    let token_file = TokenFile {
        port,
        token: token.clone(),
        pid: std::process::id(),
    };
    // Match tauri-agent-tools' discovery contract: its Node client scans
    // os.tmpdir(), so a Codex/runtime-specific TMPDIR must affect the Rust
    // producer too. Hard-coding /tmp makes every bridge undiscoverable when
    // TMPDIR is scoped (the normal verifier/session setup).
    let token_path = bridge_token_path(std::process::id());
    let token_json = serde_json::to_string_pretty(&token_file).unwrap();
    write_private_token_file(&token_path, &token_json)
        .map_err(|e| format!("Failed to write token file: {e}"))?;

    // Keep cleanup state alive for the application lifetime. A local guard is
    // incorrect here: `start_bridge` returns immediately after spawning the
    // HTTP thread, so it would delete the discovery token before the caller's
    // first `tauri-agent-tools eval`.
    if !app.manage(BridgeTokenFileGuard::new(token_path.clone())) {
        let _ = fs::remove_file(&token_path);
        return Err("Bridge token file guard was already registered".to_string());
    }

    // Create log buffer and install tracing layer
    let log_buffer = Arc::new(LogBuffer::new());
    let layer = BridgeLogLayer {
        buffer: log_buffer.clone(),
    };
    let _ = tracing_subscriber::registry().with(layer).try_init();

    // Create shared pending-results state and register it with Tauri
    let pending = Arc::new(PendingResults {
        results: Mutex::new(HashMap::new()),
        notify: Condvar::new(),
    });
    app.manage(pending.clone());

    // Sidecar registry — exposed to integrators via the return tuple and
    // consulted by /process and /health.
    let sidecar_registry = Arc::new(SidecarRegistry::new());
    app.manage(sidecar_registry.clone());

    // Capture process start metadata once so /process and /health don't pay
    // for the lookup on every request.
    let start_instant = Instant::now();
    let tauri_pid = std::process::id();
    let tauri_exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(|s| s.to_string()));
    let tauri_args: Vec<String> = std::env::args().collect();

    let app_handle = app.clone();
    let expected_token = token.clone();
    let server_log_buffer = log_buffer.clone();
    let server_registry = sidecar_registry.clone();
    // EI-13218: short-timeout client for /health's origin-reachability check
    // (built once — a client per request would pay connection-pool setup for
    // no benefit here). A bounded 800ms keeps a wedged/unreachable origin from
    // stalling the bridge's own request thread for long; a healthy localhost
    // round-trip completes in low single-digit ms.
    let health_check_client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new());

    thread::spawn(move || {
        // Survive handler panics (P-057): a panic anywhere in the
        // per-request handling used to unwind this whole thread, silently
        // killing the bridge for the rest of the session. Catch, log, and
        // re-enter the accept loop — `server` outlives the iterator, so
        // incoming_requests() can simply be called again. (The for-body
        // keeps its original indentation; only the wrapper is new.)
        loop {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                for mut request in server.incoming_requests() {
                    let is_post = request.method().as_str() == "POST";
                    let url = request.url().to_string();

                    // Handle GET /version (no auth needed). Clients feature-detect
                    // newer endpoints by checking the `endpoints` array.
                    if url == "/version" && request.method().as_str() == "GET" {
                        let resp = VersionResponse {
                            version: BRIDGE_VERSION.to_string(),
                            endpoints: vec![
                                "/eval".to_string(),
                                "/logs".to_string(),
                                "/describe".to_string(),
                                "/version".to_string(),
                                "/process".to_string(),
                                "/capabilities".to_string(),
                                "/devtools".to_string(),
                                "/health".to_string(),
                            ],
                        };
                        let json = serde_json::to_string(&resp).unwrap();
                        let header =
                            Header::from_bytes("Content-Type", "application/json").unwrap();
                        let _ = request.respond(Response::from_string(json).with_header(header));
                        continue;
                    }

                    let known_post = matches!(
                        url.as_str(),
                        "/eval"
                            | "/logs"
                            | "/describe"
                            | "/process"
                            | "/capabilities"
                            | "/devtools"
                            | "/health"
                    );
                    if !is_post || !known_post {
                        let _ = request
                            .respond(Response::from_string("Not found").with_status_code(404));
                        continue;
                    }

                    // Read body
                    let mut body = String::new();
                    if let Err(_) = request.as_reader().read_to_string(&mut body) {
                        let _ = request
                            .respond(Response::from_string("Bad request").with_status_code(400));
                        continue;
                    }

                    // Handle /logs endpoint
                    if url == "/logs" {
                        let log_req: LogRequest = match serde_json::from_str(&body) {
                            Ok(r) => r,
                            Err(_) => {
                                let _ = request.respond(
                                    Response::from_string("Invalid JSON").with_status_code(400),
                                );
                                continue;
                            }
                        };

                        if log_req.token != expected_token {
                            let _ = request.respond(
                                Response::from_string("Unauthorized").with_status_code(401),
                            );
                            continue;
                        }

                        let entries = server_log_buffer.drain();
                        let resp = LogResponse { entries };
                        let json = serde_json::to_string(&resp).unwrap();
                        let header =
                            Header::from_bytes("Content-Type", "application/json").unwrap();
                        let _ = request.respond(Response::from_string(json).with_header(header));
                        continue;
                    }

                    // Handle /process endpoint — Tauri PID + sidecar registry snapshot.
                    if url == "/process" {
                        let req: AuthedRequest = match serde_json::from_str(&body) {
                            Ok(r) => r,
                            Err(_) => {
                                let _ = request.respond(
                                    Response::from_string("Invalid JSON").with_status_code(400),
                                );
                                continue;
                            }
                        };
                        if req.token != expected_token {
                            let _ = request.respond(
                                Response::from_string("Unauthorized").with_status_code(401),
                            );
                            continue;
                        }
                        let resp = ProcessResponse {
                            tauri: TauriProcessInfo {
                                pid: tauri_pid,
                                exe: tauri_exe.clone(),
                                args: tauri_args.clone(),
                                uptime_ms: start_instant.elapsed().as_millis() as u64,
                            },
                            sidecars: server_registry.snapshot(),
                        };
                        let json = serde_json::to_string(&resp).unwrap();
                        let header =
                            Header::from_bytes("Content-Type", "application/json").unwrap();
                        let _ = request.respond(Response::from_string(json).with_header(header));
                        continue;
                    }

                    // Handle /capabilities endpoint — declared Tauri capability set per window.
                    if url == "/capabilities" {
                        let req: AuthedRequest = match serde_json::from_str(&body) {
                            Ok(r) => r,
                            Err(_) => {
                                let _ = request.respond(
                                    Response::from_string("Invalid JSON").with_status_code(400),
                                );
                                continue;
                            }
                        };
                        if req.token != expected_token {
                            let _ = request.respond(
                                Response::from_string("Unauthorized").with_status_code(401),
                            );
                            continue;
                        }

                        let windows: Vec<String> =
                            app_handle.webview_windows().keys().cloned().collect();
                        let declared = collect_declared_capabilities(&app_handle);
                        let resp = CapabilitiesResponse { declared, windows };
                        let json = serde_json::to_string(&resp).unwrap();
                        let header =
                            Header::from_bytes("Content-Type", "application/json").unwrap();
                        let _ = request.respond(Response::from_string(json).with_header(header));
                        continue;
                    }

                    // Handle /devtools endpoint — inspector URL or platform hint.
                    if url == "/devtools" {
                        let req: AuthedRequest = match serde_json::from_str(&body) {
                            Ok(r) => r,
                            Err(_) => {
                                let _ = request.respond(
                                    Response::from_string("Invalid JSON").with_status_code(400),
                                );
                                continue;
                            }
                        };
                        if req.token != expected_token {
                            let _ = request.respond(
                                Response::from_string("Unauthorized").with_status_code(401),
                            );
                            continue;
                        }
                        let resp = devtools_response();
                        let json = serde_json::to_string(&resp).unwrap();
                        let header =
                            Header::from_bytes("Content-Type", "application/json").unwrap();
                        let _ = request.respond(Response::from_string(json).with_header(header));
                        continue;
                    }

                    // Handle /health endpoint — quick "is this app sick" check.
                    if url == "/health" {
                        let req: AuthedRequest = match serde_json::from_str(&body) {
                            Ok(r) => r,
                            Err(_) => {
                                let _ = request.respond(
                                    Response::from_string("Invalid JSON").with_status_code(400),
                                );
                                continue;
                            }
                        };
                        if req.token != expected_token {
                            let _ = request.respond(
                                Response::from_string("Unauthorized").with_status_code(401),
                            );
                            continue;
                        }
                        let sidecars = server_registry.snapshot();
                        let pid_sidecars_alive = sidecars
                            .iter()
                            .all(|s| matches!(s.alive, Some(true) | None));
                        let webview_ready = !app_handle.webview_windows().is_empty();
                        // EI-13218: cross-check the origin the main webview is
                        // CURRENTLY displaying, not just PID liveness (which
                        // `pid_sidecars_alive` above is — and in production
                        // `sidecars` is always empty, so that alone is a
                        // vacuous `true`). `None` (no webview / no URL) never
                        // fails the gate — only a confirmed-unreachable origin
                        // does, so `sidecars_alive` stays `true` whenever we
                        // genuinely can't check.
                        let webview_url = app_handle
                            .get_webview_window("main")
                            .and_then(|w| w.url().ok())
                            .map(|u| u.to_string());
                        let health_url = webview_url.as_deref().and_then(|u| {
                            reqwest::Url::parse(u).ok().and_then(|parsed| {
                                parsed.join("/api/health").ok().map(|j| j.to_string())
                            })
                        });
                        let operator_reachable = health_url
                            .as_deref()
                            .and_then(|u| origin_reachable(&health_check_client, u));
                        let sidecars_alive =
                            pid_sidecars_alive && operator_reachable.unwrap_or(true);
                        let resp = HealthResponse {
                            uptime_ms: start_instant.elapsed().as_millis() as u64,
                            webview_ready,
                            sidecars_alive,
                            sidecars,
                            selected_api_port: crate::SELECTED_API_PORT
                                .load(std::sync::atomic::Ordering::Relaxed),
                            operator_reachable,
                        };
                        let json = serde_json::to_string(&resp).unwrap();
                        let header =
                            Header::from_bytes("Content-Type", "application/json").unwrap();
                        let _ = request.respond(Response::from_string(json).with_header(header));
                        continue;
                    }

                    // Handle /describe endpoint
                    if url == "/describe" {
                        let desc_req: DescribeRequest = match serde_json::from_str(&body) {
                            Ok(r) => r,
                            Err(_) => {
                                let _ = request.respond(
                                    Response::from_string("Invalid JSON").with_status_code(400),
                                );
                                continue;
                            }
                        };

                        if desc_req.token != expected_token {
                            let _ = request.respond(
                                Response::from_string("Unauthorized").with_status_code(401),
                            );
                            continue;
                        }

                        let windows: Vec<String> =
                            app_handle.webview_windows().keys().cloned().collect();

                        let resp = DescribeResponse {
                            pid: Some(std::process::id()),
                            windows: Some(windows),
                            capabilities: vec![
                                "eval".to_string(),
                                "logs".to_string(),
                                "describe".to_string(),
                            ],
                            ..Default::default()
                        };

                        let json = serde_json::to_string(&resp).unwrap();
                        let header =
                            Header::from_bytes("Content-Type", "application/json").unwrap();
                        let _ = request.respond(Response::from_string(json).with_header(header));
                        continue;
                    }

                    // Handle /eval endpoint
                    let eval_req: EvalRequest = match serde_json::from_str(&body) {
                        Ok(r) => r,
                        Err(_) => {
                            let _ = request.respond(
                                Response::from_string("Invalid JSON").with_status_code(400),
                            );
                            continue;
                        }
                    };

                    // Verify token
                    if eval_req.token != expected_token {
                        let _ = request
                            .respond(Response::from_string("Unauthorized").with_status_code(401));
                        continue;
                    }

                    // Evaluate JS in webview via callback pattern
                    let request_id = uuid::Uuid::new_v4().to_string();

                    let window_label = eval_req.window.as_deref().unwrap_or("main");
                    if let Some(window) = app_handle.get_webview_window(window_label) {
                        let callback_js = build_eval_callback_js(&eval_req.js, &request_id);
                        let _ = window.eval(&callback_js);

                        // Wait for the result with a 5-second timeout. Poison
                        // recovery on both the lock and the Condvar wait (P-057):
                        // one panicked handler must not silently kill eval for the
                        // rest of the session.
                        let mut results = pending
                            .results
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        let deadline = std::time::Duration::from_secs(5);
                        let start = std::time::Instant::now();

                        loop {
                            if let Some(value) = results.remove(&request_id) {
                                let header =
                                    Header::from_bytes("Content-Type", "application/json").unwrap();
                                if let Some(error) = eval_error_message(&value) {
                                    let json = serde_json::json!({ "error": error }).to_string();
                                    let _ = request.respond(
                                        Response::from_string(json)
                                            .with_header(header)
                                            .with_status_code(500),
                                    );
                                } else {
                                    let resp = EvalResponse { result: value };
                                    let json = serde_json::to_string(&resp).unwrap();
                                    let _ = request
                                        .respond(Response::from_string(json).with_header(header));
                                }
                                break;
                            }

                            let elapsed = start.elapsed();
                            if elapsed >= deadline {
                                // Timeout — clean up and respond with 504
                                results.remove(&request_id);
                                let _ = request.respond(
                                    Response::from_string("Eval timeout").with_status_code(504),
                                );
                                break;
                            }

                            let remaining = deadline - elapsed;
                            let (guard, timeout_result) = pending
                                .notify
                                .wait_timeout(results, remaining)
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            results = guard;

                            if timeout_result.timed_out() && !results.contains_key(&request_id) {
                                results.remove(&request_id);
                                let _ = request.respond(
                                    Response::from_string("Eval timeout").with_status_code(504),
                                );
                                break;
                            }
                        }
                    } else {
                        let resp = EvalResponse {
                            result: serde_json::Value::Null,
                        };
                        let json = serde_json::to_string(&resp).unwrap();
                        let header =
                            Header::from_bytes("Content-Type", "application/json").unwrap();
                        let _ = request.respond(Response::from_string(json).with_header(header));
                    }
                }
            }));
            match outcome {
                // incoming_requests() drained — the server socket closed; end
                // the thread for real.
                Ok(()) => break,
                Err(_) => {
                    eprintln!(
                        "[dev-bridge] request handler panicked — recovering; the bridge stays up"
                    );
                }
            }
        }
    });

    eprintln!("Dev bridge {BRIDGE_VERSION} started on port {port}");
    eprintln!("Token file: {}", token_path.display());

    Ok((port, log_buffer, sidecar_registry))
}

/// Read declared capabilities from tauri.conf.json via `app.config()`. Returns
/// a flat list of capability entries. Tauri 2 lets capabilities be either bare
/// permission identifiers (strings) or full inline definitions; we surface
/// both as `CapabilityEntry` rows with `permissions` populated where possible.
fn collect_declared_capabilities(app: &AppHandle) -> Vec<CapabilityEntry> {
    let config = app.config();
    let security = &config.app.security;
    let mut out = Vec::new();
    for cap in &security.capabilities {
        let raw = serde_json::to_value(cap).unwrap_or(serde_json::Value::Null);
        match &raw {
            serde_json::Value::String(s) => {
                // Capability declared by reference to a JSON file. We don't have
                // the resolved contents at runtime here, but we surface the
                // identifier so callers know what was requested.
                out.push(CapabilityEntry {
                    identifier: s.clone(),
                    description: None,
                    windows: Vec::new(),
                    permissions: Vec::new(),
                });
            }
            serde_json::Value::Object(map) => {
                let identifier = map
                    .get("identifier")
                    .and_then(|v| v.as_str())
                    .unwrap_or("<inline>")
                    .to_string();
                let description = map
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let windows: Vec<String> = map
                    .get("windows")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                let permissions: Vec<String> = map
                    .get("permissions")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| match v {
                                serde_json::Value::String(s) => Some(s.clone()),
                                serde_json::Value::Object(o) => o
                                    .get("identifier")
                                    .and_then(|i| i.as_str())
                                    .map(|s| s.to_string()),
                                _ => None,
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                out.push(CapabilityEntry {
                    identifier,
                    description,
                    windows,
                    permissions,
                });
            }
            _ => {}
        }
    }
    out
}

/// Build the JS evaluated in the webview for an `/eval` request: run the
/// expression, normalize the result to a string-or-null, and deliver it back
/// to Rust via the `__dev_bridge_result` command. Pure — the user-supplied
/// `js` and the `request_id` are embedded as JSON string literals so quotes,
/// backslashes and newlines in the payload can't escape into the wrapper.
///
/// SECURITY: the `eval` here is the dev bridge's entire purpose — arbitrary
/// JS execution for local diagnostic agents. It is debug-tool surface only:
/// the server binds 127.0.0.1, every request is gated on the random
/// per-session token (mode-0600-equivalent /tmp token file), and the bridge
/// is not part of the shipped production app's request path.
fn build_eval_callback_js(js: &str, request_id: &str) -> String {
    format!(
        r#"
        (async () => {{
            try {{
                let __result = await eval({js});
                if (typeof __result === "undefined") {{
                    __result = null;
                }} else if (typeof __result === "object" && __result !== null) {{
                    __result = JSON.stringify(__result);
                }} else if (typeof __result !== "string") {{
                    __result = String(__result);
                }}
                await window.__TAURI__.core.invoke("__dev_bridge_result", {{
                    id: {id},
                    value: __result
                }});
            }} catch(e) {{
                await window.__TAURI__.core.invoke("__dev_bridge_result", {{
                    id: {id},
                    value: {{
                        {error_key}: "ERROR: " + String(e?.message ?? e)
                    }}
                }});
            }}
        }})();
        "#,
        js = serde_json::to_string(js).unwrap(),
        id = serde_json::to_string(request_id).unwrap(),
        error_key = EVAL_ERROR_RESULT_KEY,
    )
}

fn eval_error_message(value: &serde_json::Value) -> Option<&str> {
    value
        .get(EVAL_ERROR_RESULT_KEY)
        .and_then(serde_json::Value::as_str)
}

/// Build a `/devtools` response for the current platform. v1 emits useful
/// hints rather than always producing a hot inspector URL — Safari attach on
/// macOS requires UI activation, Windows WebView2 needs a launch-time arg.
fn devtools_response() -> DevtoolsResponse {
    if cfg!(target_os = "macos") {
        DevtoolsResponse {
            platform: "wkwebview".to_string(),
            inspectable: cfg!(debug_assertions),
            url: None,
            hint: "Open Safari > Develop > <Mac name> > <App name> to attach. \
                Requires the app to be built with debug_assertions (i.e., `tauri dev`)."
                .to_string(),
        }
    } else if cfg!(target_os = "windows") {
        let port = std::env::var("WEBVIEW2_REMOTE_DEBUGGING_PORT").ok();
        let url = port.as_ref().map(|p| format!("http://127.0.0.1:{p}"));
        DevtoolsResponse {
            platform: "webview2".to_string(),
            inspectable: url.is_some(),
            url,
            hint: "Set WEBVIEW2_REMOTE_DEBUGGING_PORT=9222 before launching, \
                then open http://127.0.0.1:9222 in Chrome/Edge to inspect."
                .to_string(),
        }
    } else {
        let inspector = std::env::var("WEBKIT_INSPECTOR_SERVER").ok();
        DevtoolsResponse {
            platform: "webkitgtk".to_string(),
            inspectable: inspector.is_some(),
            url: inspector.as_ref().map(|s| format!("http://{s}")),
            hint: "Export WEBKIT_INSPECTOR_SERVER=127.0.0.1:9222 before launching, \
                then open http://127.0.0.1:9222 to inspect."
                .to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_response_serializes_the_live_selected_api_port_contract() {
        let response = HealthResponse {
            uptime_ms: 123,
            webview_ready: true,
            sidecars_alive: true,
            sidecars: Vec::new(),
            selected_api_port: 3170,
            operator_reachable: Some(true),
        };

        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["selected_api_port"], 3170);
    }

    #[test]
    fn bridge_token_file_guard_keeps_token_until_application_state_drops() {
        let path = std::env::temp_dir().join(format!(
            "papercusp-dev-bridge-token-guard-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("unnamed")
        ));
        fs::write(&path, "token").unwrap();

        let guard = BridgeTokenFileGuard::new(path.clone());
        assert!(
            path.exists(),
            "managed bridge state must retain the discovery token"
        );

        drop(guard);
        assert!(
            !path.exists(),
            "dropping application state must remove the discovery token"
        );
    }

    #[cfg(unix)]
    #[test]
    fn bridge_token_file_is_owner_only_and_replaces_stale_files() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!(
            "papercusp-dev-bridge-token-mode-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        // A stale, world-readable file from an earlier run must not keep its mode.
        fs::write(&path, "stale").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        write_private_token_file(&path, "{\"token\":\"t\"}").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "bridge token must be readable by its owner only");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"token\":\"t\"}");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn bridge_token_path_uses_the_runtime_temp_directory_contract() {
        let scoped_temp = PathBuf::from("/tmp/papercusp-runtime-scoped-temp");

        assert_eq!(
            bridge_token_path_in(&scoped_temp, 4242),
            scoped_temp.join("tauri-dev-bridge-4242.token")
        );
    }

    #[cfg(unix)]
    #[test]
    fn pid_alive_true_for_current_process() {
        // kill(self, 0) succeeds → the bridge reports its own process alive.
        assert_eq!(pid_alive(std::process::id()), Some(true));
    }

    #[cfg(unix)]
    #[test]
    fn pid_alive_false_for_an_unused_high_pid() {
        // Well above any realistic pid_max (and positive as i32) → ESRCH → false.
        assert_eq!(pid_alive(2_000_000_000), Some(false));
    }

    // ── origin_reachable (EI-13218) ──────────────────────────────────────────

    #[test]
    fn origin_reachable_none_for_an_empty_url() {
        let client = reqwest::blocking::Client::new();
        // Nothing to check (no webview / unreadable URL upstream) — never a
        // false failure.
        assert_eq!(origin_reachable(&client, ""), None);
    }

    #[test]
    fn origin_reachable_true_when_the_origin_answers() {
        // A real tiny_http responder — ANY response (even this bare 200)
        // proves the origin is up.
        let server = Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let handle = thread::spawn(move || {
            if let Ok(req) = server.recv() {
                let _ = req.respond(Response::from_string("ok"));
            }
        });
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(500))
            .build()
            .unwrap();
        let url = format!("http://127.0.0.1:{port}/api/health");
        assert_eq!(origin_reachable(&client, &url), Some(true));
        handle.join().unwrap();
    }

    #[test]
    fn origin_reachable_false_when_nothing_is_listening() {
        // Bind then immediately drop — the OS reclaims the port, so the
        // connection is refused deterministically (no timeout wait needed).
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(500))
            .build()
            .unwrap();
        let url = format!("http://127.0.0.1:{port}/api/health");
        assert_eq!(origin_reachable(&client, &url), Some(false));
    }

    // ── LogBuffer ring semantics ────────────────────────────────────────────

    fn entry(msg: &str) -> LogEntry {
        LogEntry {
            timestamp: 0,
            level: "info".to_string(),
            target: "test".to_string(),
            message: msg.to_string(),
            source: "rust".to_string(),
        }
    }

    #[test]
    fn log_buffer_caps_at_1000_dropping_oldest() {
        let buf = LogBuffer::new();
        for i in 0..1003 {
            buf.push(entry(&i.to_string()));
        }
        let drained = buf.drain();
        assert_eq!(drained.len(), 1000);
        // The three OLDEST entries (0,1,2) were evicted; order is preserved.
        assert_eq!(drained[0].message, "3");
        assert_eq!(drained[999].message, "1002");
    }

    #[test]
    fn log_buffer_drain_empties_and_preserves_order() {
        let buf = LogBuffer::new();
        buf.push(entry("a"));
        buf.push(entry("b"));
        let first = buf.drain();
        assert_eq!(
            first.iter().map(|e| e.message.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert!(buf.drain().is_empty(), "drain consumes the buffer");
    }

    // ── Sidecar registry snapshots ──────────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn sidecar_registry_snapshot_reports_liveness_per_record() {
        let registry = Arc::new(SidecarRegistry::new());
        register_sidecar(
            &registry,
            "self",
            std::process::id(),
            Some("/bin/x".into()),
            vec!["--a".into()],
        );
        register_sidecar(&registry, "dead", 2_000_000_000, None, vec![]);
        // Re-registering a name is allowed — both entries are reported.
        register_sidecar(&registry, "self", std::process::id(), None, vec![]);

        let snap = registry.snapshot();
        assert_eq!(snap.len(), 3);
        assert_eq!(snap[0].name, "self");
        assert_eq!(snap[0].alive, Some(true));
        assert_eq!(snap[0].exe.as_deref(), Some("/bin/x"));
        assert_eq!(snap[0].args, vec!["--a".to_string()]);
        assert_eq!(snap[1].name, "dead");
        assert_eq!(snap[1].alive, Some(false));
        assert_eq!(snap[2].name, "self");
    }

    // ── Tracing capture layer (drives MessageVisitor) ───────────────────────

    #[test]
    fn bridge_log_layer_captures_formatted_events() {
        use tracing_subscriber::layer::SubscriberExt;
        let buffer = Arc::new(LogBuffer::new());
        let subscriber = tracing_subscriber::registry().with(create_log_layer(buffer.clone()));
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!("hello {}", 42);
            tracing::warn!("uh oh");
        });
        let entries = buffer.drain();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].level, "info");
        assert_eq!(entries[0].message, "hello 42");
        assert_eq!(entries[0].source, "rust");
        assert!(entries[0].timestamp > 0);
        assert_eq!(entries[1].level, "warn");
        assert_eq!(entries[1].message, "uh oh");
    }

    #[test]
    fn bridge_log_layer_strips_debug_quotes_from_message() {
        use tracing_subscriber::layer::SubscriberExt;
        let buffer = Arc::new(LogBuffer::new());
        let subscriber = tracing_subscriber::registry().with(create_log_layer(buffer.clone()));
        tracing::subscriber::with_default(subscriber, || {
            // `?` records the message field via Debug — `"quoted"` with quotes —
            // which MessageVisitor::record_debug strips back off.
            tracing::info!(message = ?"quoted");
        });
        let entries = buffer.drain();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].message, "quoted");
    }

    // ── /eval callback JS builder ───────────────────────────────────────────

    #[test]
    fn eval_callback_js_embeds_payload_as_json_literals() {
        let js = build_eval_callback_js("document.title", "req-1");
        assert!(js.contains(r#"await eval("document.title")"#));
        assert!(js.contains(r#"id: "req-1""#));
        assert!(js.contains("__dev_bridge_result"));
    }

    #[test]
    fn eval_callback_js_escapes_hostile_payloads() {
        // Quotes / backslashes / newlines must stay INSIDE the JSON string
        // literal — a raw embedding would let the payload escape the wrapper.
        let hostile = "alert(\"x\");\n\\evil";
        let js = build_eval_callback_js(hostile, "id\"2");
        assert!(js.contains(r#""alert(\"x\");\n\\evil""#), "got: {js}");
        assert!(js.contains(r#""id\"2""#));
        // No unescaped newline from the payload inside the eval(...) call.
        let eval_line = js.lines().find(|l| l.contains("await eval(")).unwrap();
        assert!(eval_line.contains(r#"\n"#));
    }

    #[test]
    fn eval_callback_js_reports_thrown_errors_on_a_dedicated_channel() {
        let js = build_eval_callback_js("throw new Error('boom')", "req-1");
        assert!(js.contains(EVAL_ERROR_RESULT_KEY));
        assert!(js.contains(r#""ERROR: " + String(e?.message ?? e)"#));
        assert!(!js.contains(r#"value: "ERROR: " + e.message"#));
    }

    #[test]
    fn eval_error_message_only_matches_the_reserved_error_object() {
        let error = serde_json::json!({ EVAL_ERROR_RESULT_KEY: "ERROR: boom" });
        assert_eq!(eval_error_message(&error), Some("ERROR: boom"));

        let ordinary_string = serde_json::json!("ERROR: boom");
        assert_eq!(eval_error_message(&ordinary_string), None);
    }

    // ── /devtools platform response ─────────────────────────────────────────

    #[test]
    fn devtools_response_is_consistent_for_this_platform() {
        let resp = devtools_response();
        // Whatever the env says, a URL is advertised iff inspectable.
        // (On macOS inspectable instead tracks debug_assertions and url stays
        // None, so the invariant is url.is_some() → inspectable.)
        if resp.url.is_some() {
            assert!(resp.inspectable);
        }
        assert!(!resp.hint.is_empty());
        #[cfg(target_os = "linux")]
        assert_eq!(resp.platform, "webkitgtk");
        #[cfg(target_os = "macos")]
        assert_eq!(resp.platform, "wkwebview");
        #[cfg(target_os = "windows")]
        assert_eq!(resp.platform, "webview2");
    }
}
