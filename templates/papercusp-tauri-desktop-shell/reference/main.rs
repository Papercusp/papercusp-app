// reference/main.rs — the thin-shell shape the GUIDE's MUST-1 points at
// ("scaffold `src-tauri` from the reference `main.rs` shape"). Extracted from
// the third independent greenfield validation build, which implemented the
// MUST list from scratch and passed the full checks union (WI-2888 closed the
// gap where this file was cited but not shipped).
//
// This is a SHAPE reference, not drop-in code: rename `MyApp`/`myapp`/`MYAPP_*`
// per your `app-identity` decision. Cargo deps it assumes: tauri (v2), serde
// (derive), serde_json, portpicker, libc (unix). Everything app-shaped lives in
// the SPA + sidecar — this host only: pick a free-port hint, spawn the Node
// sidecar, poll the discovery file until healthy, point the webview at it, and
// SIGTERM the sidecar on window close (graceful ordering is the SIDECAR's job —
// GUIDE MUST-3; the shell only sends the signal and waits).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent};

/// The sidecar's discovery file (GUIDE MUST-2): written at boot to the app
/// home, removed on shutdown. The shell polls it; the CLI reads it.
#[derive(Debug, Deserialize)]
struct Discovery {
    url: String,
    #[allow(dead_code)]
    port: u16,
    pid: u32,
}

struct SidecarState {
    child: Mutex<Option<Child>>,
}

fn app_home() -> PathBuf {
    // MYAPP_HOME env override keeps tests/CI hermetic (boot-e2e sets it).
    if let Ok(custom) = std::env::var("MYAPP_HOME") {
        return PathBuf::from(custom);
    }
    dirs_home().join(".myapp")
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn discovery_path() -> PathBuf {
    app_home().join("operator.json")
}

fn find_free_port() -> Option<u16> {
    portpicker::pick_unused_port()
}

/// Poll the discovery file until it parses AND the sidecar answers /api/health,
/// or until `timeout` elapses. Returns the discovered base URL.
fn wait_for_sidecar(timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(text) = fs::read_to_string(discovery_path()) {
            if let Ok(disc) = serde_json::from_str::<Discovery>(&text) {
                let health_url = format!("{}/api/health", disc.url);
                if let Ok(resp) = health_get(&health_url) {
                    if resp {
                        return Some(disc.url);
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    None
}

/// Minimal blocking HTTP GET via std TcpStream (avoid pulling in a full HTTP
/// client dep for a single loopback health probe). Returns Ok(true) on any 200.
fn health_get(url: &str) -> Result<bool, ()> {
    let rest = url.strip_prefix("http://").ok_or(())?;
    let (hostport, path) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = hostport.split_once(':').ok_or(())?;
    let port: u16 = port.parse().map_err(|_| ())?;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    let mut stream = TcpStream::connect((host, port)).map_err(|_| ())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(800)))
        .ok();
    let req = format!(
        "GET /{} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        path, host
    );
    stream.write_all(req.as_bytes()).map_err(|_| ())?;
    let mut buf = [0u8; 32];
    let n = stream.read(&mut buf).map_err(|_| ())?;
    let status_line = String::from_utf8_lossy(&buf[..n]);
    Ok(status_line.contains("200"))
}

/// Prepend the sidecar's bundled bin dir to PATH so a packaged build (no
/// system `node`) still resolves the interpreter (GUIDE MUST-1, the
/// bundled_path_env pattern).
fn bundled_path_env(sidecar_dir: &std::path::Path) -> String {
    let bundled_bin = sidecar_dir.join("bin");
    let existing = std::env::var("PATH").unwrap_or_default();
    format!("{}:{}", bundled_bin.to_string_lossy(), existing)
}

fn spawn_sidecar(app_handle: &tauri::AppHandle) -> Option<Child> {
    // Dev: run the sidecar from the repo's dist build. Packaged: resolve from
    // resource_dir()/dist-sidecar (GUIDE MUST-1).
    //
    // MYAPP_SIDECAR_ENTRY is an explicit dev/test override — Tauri's runtime
    // cwd is not guaranteed to equal the launching shell's cwd (observed live
    // in the validation build), so current_dir()-relative resolution alone is
    // unreliable for dev; the packaged path below doesn't depend on cwd.
    let dev_entry = std::env::var("MYAPP_SIDECAR_ENTRY")
        .map(PathBuf::from)
        .ok()
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|d| d.join("apps").join("sidecar").join("dist").join("serve.js"))
        })?;
    let (node_bin, entry) = if dev_entry.exists() {
        ("node".to_string(), dev_entry)
    } else if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let packaged = resource_dir.join("dist-sidecar").join("serve.js");
        ("node".to_string(), packaged)
    } else {
        return None;
    };

    let hint = find_free_port();
    let mut cmd = Command::new(&node_bin);
    cmd.arg(&entry).stdin(Stdio::null());
    if let Some(port) = hint {
        cmd.env("MYAPP_HTTP_PORT", port.to_string());
    }
    if let Some(parent) = entry.parent().and_then(|p| p.parent()) {
        cmd.env("PATH", bundled_path_env(parent));
    }
    cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    cmd.spawn().ok()
}

/// SIGTERM, wait up to the sidecar's shutdown grace, then hard-kill. The
/// sidecar owns the graceful ORDERING (host close → sync stop → PG stop →
/// synchronous discovery-file removal — GUIDE MUST-3); the shell only signals.
fn graceful_kill(child: &mut Child) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        let _ = child.kill();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}

fn main() {
    tauri::Builder::default()
        .manage(SidecarState {
            child: Mutex::new(None),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let child = spawn_sidecar(&handle);
            if let Some(state) = app.try_state::<SidecarState>() {
                *state.child.lock().unwrap() = child;
            }

            let handle2 = handle.clone();
            std::thread::spawn(move || {
                if let Some(url) = wait_for_sidecar(Duration::from_secs(60)) {
                    if let Some(window) = handle2.get_webview_window("main") {
                        let _ = window.eval(&format!("window.location.replace({:?})", url));
                    }
                } else {
                    eprintln!("[myapp-desktop] sidecar never became healthy within 60s");
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building MyApp")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<SidecarState>() {
                    if let Some(mut child) = state.child.lock().unwrap().take() {
                        graceful_kill(&mut child);
                    }
                }
            }
        });
}
