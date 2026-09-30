// Papercusp desktop shell.
//
// Architecture:
//   1. On startup, find a free localhost port.
//   2. Spawn the Node sidecar (`apps/papercusp` running as `next start`)
//      with PORT set to that free port.
//   3. Wait for the sidecar to be reachable.
//   4. Open the main window pointing at http://localhost:<port>/.
//   5. On window-close, kill the sidecar.
//
// The same Node sidecar binary is what we'd run in a cloud container —
// no shell-out into platform-specific tooling here.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, WindowEvent};

struct SidecarState {
    child: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
}

fn find_free_port() -> Option<u16> {
    portpicker::pick_unused_port()
}

/// Spawn the Node sidecar from inside the bundled sidecar dir. In dev
/// (`tauri dev`), we skip this — the developer runs `npm run dev:papercusp`
/// separately and the webview points at devUrl from tauri.conf.json.
fn spawn_sidecar(port: u16, sidecar_dir: &std::path::Path) -> std::io::Result<Child> {
    println!("[papercusp-desktop] spawning sidecar on port {} from {}", port, sidecar_dir.display());

    // Next.js standalone bundle layout: sidecar/apps/papercusp/server.js
    // is the entry point, and it expects to be invoked with cwd = sidecar/
    // (so __dirname-relative .next paths resolve correctly).
    let server_js = sidecar_dir.join("apps").join("papercusp").join("server.js");
    let harness_dir = sidecar_dir.join("harness");

    let mut cmd = Command::new("node");
    cmd.arg(&server_js)
        .current_dir(sidecar_dir)
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("PAPERCUSP_HARNESS_DIR", harness_dir.to_string_lossy().to_string())
        .env("PAPERCUSP_DESKTOP", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    cmd.spawn()
}

fn wait_for_sidecar(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

pub fn run() {
    let state = SidecarState {
        child: Mutex::new(None),
        port: Mutex::new(None),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .manage(state)
        .setup(|app| {
            let is_dev = cfg!(debug_assertions);

            if is_dev {
                // In dev mode we trust the developer to run the Next.js dev
                // server themselves on :3055 (devUrl in tauri.conf.json).
                println!("[papercusp-desktop] dev mode — skipping sidecar spawn (expecting :3055 to be served externally)");
                return Ok(());
            }

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

            let child = match spawn_sidecar(port, &sidecar_dir) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[papercusp-desktop] failed to spawn sidecar: {}", e);
                    return Ok(());
                }
            };

            let state: tauri::State<SidecarState> = app.state();
            *state.child.lock().unwrap() = Some(child);
            *state.port.lock().unwrap() = Some(port);

            // Wait for the sidecar to start accepting connections (up to 30s).
            if !wait_for_sidecar(port, Duration::from_secs(30)) {
                eprintln!("[papercusp-desktop] sidecar did not start within 30s");
                return Ok(());
            }
            println!("[papercusp-desktop] sidecar ready on :{}", port);

            // Tell the bootstrap page where the sidecar is. The JS in
            // web/index.html will poll /api/desktop/preflight on that base,
            // render any missing-prereq UI, then navigate when ready.
            if let Some(window) = app.get_webview_window("main") {
                let base = format!("http://localhost:{}", port);
                let _ = window.eval(&format!(
                    "window.__papercuspBase = '{}'; window.dispatchEvent(new CustomEvent('papercusp:base'));",
                    base
                ));
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                kill_sidecar(app_handle);
            }
            RunEvent::WindowEvent {
                event: WindowEvent::CloseRequested { .. },
                ..
            } => {
                kill_sidecar(app_handle);
            }
            _ => {}
        });
}

/// Take ownership of the sidecar Child (if any) and kill it.
///
/// This is a function rather than inline so the temporary MutexGuard from
/// `state.child.lock()` is dropped before the borrow of `state` ends —
/// inlining triggered borrow-checker E0597 in Rust 2021 because the guard
/// outlived the local `state` binding.
fn kill_sidecar(app_handle: &tauri::AppHandle) {
    let state: tauri::State<SidecarState> = app_handle.state();
    let maybe_child = state.child.lock().unwrap().take();
    if let Some(mut child) = maybe_child {
        println!("[papercusp-desktop] killing sidecar pid={}", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn main() {
    run();
}
