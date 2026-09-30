// E. Tauri Rust pty-host — desktop fast path for PiPanel.
//
// The operator's harness UI normally talks to /api/harness/:slug/pty/*
// in the Node sidecar (option B above). On desktop, we want to bypass
// the sidecar and the network entirely: the pty is forked in this Rust
// process, output is delivered to the webview via Tauri events
// (in-process IPC), input arrives via invoke().
//
// Why: localhost WebSocket is ~5 ms RTT in the best case; Tauri IPC is
// ~1 ms because there's no socket, no parser, no network stack — just
// a function call across the webview/host boundary. The user-visible
// effect on a typing-heavy session is pretty close to "feels native".
//
// Wire format (mirrors lib/pty-ws.ts so PiPanel's branching is minimal):
//   - pty_spawn(opts) -> { id, pid }
//   - pty_write(id, base64_bytes)
//   - pty_resize(id, cols, rows)
//   - pty_kill(id)
//   - pty_history(id) -> base64_bytes  (for tab-switch resume)
//   - emits event "pty-data" with payload { id, data: base64 }
//   - emits event "pty-exit" with payload { id, code }
//
// We base64-encode bytes for the IPC boundary because Tauri events
// take serializable payloads, and round-tripping arbitrary bytes
// through utf-8 strings is not safe (TUIs emit non-utf8 escape state
// during transitions).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtyPair, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const HISTORY_CAP_BYTES: usize = 1024 * 1024;

struct PtyEntry {
    /// Master side of the pty. Read+Write trait objects are owned here
    /// so we can serialize writes through one mutex while a separate
    /// reader thread owns the read end.
    writer: Mutex<Box<dyn Write + Send>>,
    /// We hold the master to keep the pair alive and to call resize()
    /// when the UI's xterm changes geometry.
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Persistent ring of bytes the pty has emitted. Replayed on the
    /// next resume call (PiPanel sessionStorage round-trip across
    /// dashboard tab switches). Capped at HISTORY_CAP_BYTES.
    history: Mutex<Vec<u8>>,
    /// Marked true after the child exits so subsequent commands fail
    /// fast instead of writing to a half-dead pty.
    killed: Mutex<bool>,
}

static REGISTRY: Lazy<Mutex<HashMap<String, Arc<PtyEntry>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Deserialize, specta::Type)]
pub struct PtySpawnOpts {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}
fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

#[derive(Debug, Serialize, specta::Type)]
pub struct PtySpawnResult {
    pub id: String,
    pub pid: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
struct PtyDataPayload {
    id: String,
    data: String, // base64
}

#[derive(Debug, Serialize, Clone)]
struct PtyExitPayload {
    id: String,
    code: i32,
}

/// Spawn a new native pty and register it under a fresh uuid. Returns
/// the id, the child process PID, and a strong handle to the entry so
/// callers can install their own reader/exit hooks (Tauri command
/// installs hooks that emit IPC events; tests install their own).
fn spawn_internal(
    opts: &PtySpawnOpts,
) -> Result<
    (
        String,
        Option<u32>,
        Arc<PtyEntry>,
        Box<dyn Read + Send>,
        Box<dyn portable_pty::Child + Send + Sync>,
    ),
    String,
> {
    let pty_system = native_pty_system();
    let PtyPair { master, slave } = pty_system
        .openpty(PtySize {
            rows: opts.rows,
            cols: opts.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {}", e))?;

    // Windows + WSL-routed sidecar: the whole agent environment (operator,
    // harness, runtimes, the user's HOME with cwd paths like /home/papercup)
    // lives INSIDE the papercup-runtime distro — a pty spawned on the
    // Windows side would run System32 bash.exe into the DEFAULT distro (or
    // plain Windows), the wrong target for every wizard install/login and
    // PiPanel session. Wrap the command through wsl.exe instead. Spec env
    // vars can't cross wsl.exe without WSLENV plumbing — so thread them
    // through `/usr/bin/env K=V …` instead: argv entries survive --exec
    // verbatim (spaces and all). The old code DROPPED spec env here with
    // only an eprintln warning, which silently broke the onboarding
    // concierge — its PAPERCUSP_OPERATOR_URL never arrived, so it dialed
    // the retired :3070 default forever (WI-3033, owner-hit 2026-07-05).
    #[cfg(target_os = "windows")]
    let via_wsl = crate::wsl_setup::detect_ready_cached();
    #[cfg(target_os = "windows")]
    let mut cmd = if via_wsl {
        let mut c = CommandBuilder::new("wsl.exe");
        c.arg("--distribution");
        c.arg(crate::wsl_setup::DISTRO_NAME_PUB);
        if let Some(cwd) = opts.cwd.as_deref() {
            c.arg("--cd");
            c.arg(cwd);
        }
        // --exec, NOT `--`: the bare separator re-joins everything after it
        // into one string and runs it through the distro's default shell,
        // shredding multi-word args — `bash -c '<multiline script>'` (the
        // wizard's install/login specs) arrives re-tokenized and executes
        // garbage (found live 2026-06-11). --exec preserves the arg vector
        // (same reason make_sidecar_command uses it for serve).
        c.arg("--exec");
        // TERM first (the Windows-side cmd.env("TERM") below cannot cross
        // the boundary either), then the spec env, then the real command.
        c.arg("/usr/bin/env");
        c.arg("TERM=xterm-256color");
        for (k, v) in &opts.env {
            // env(1) takes literal K=V argv entries — a key containing '='
            // (or an empty key) would be misparsed; skip those defensively.
            if k.is_empty() || k.contains('=') {
                eprintln!("[pty] WARNING: skipping invalid env name {k:?} at the wsl.exe boundary");
                continue;
            }
            c.arg(format!("{k}={v}"));
        }
        c.arg(opts.command.clone());
        for arg in &opts.args {
            c.arg(arg);
        }
        c
    } else {
        let mut c = CommandBuilder::new(opts.command.clone());
        for arg in &opts.args {
            c.arg(arg);
        }
        if let Some(cwd) = opts.cwd.as_deref() {
            c.cwd(cwd);
        }
        for (k, v) in &opts.env {
            c.env(k, v);
        }
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = CommandBuilder::new(opts.command.clone());
        for arg in &opts.args {
            c.arg(arg);
        }
        if let Some(cwd) = opts.cwd.as_deref() {
            c.cwd(cwd);
        }
        for (k, v) in &opts.env {
            c.env(k, v);
        }
        c
    };
    cmd.env("TERM", "xterm-256color");

    let child = slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn child: {}", e))?;
    drop(slave);

    let pid = child.process_id();

    let reader = master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {}", e))?;
    let writer = master
        .take_writer()
        .map_err(|e| format!("take writer: {}", e))?;

    let id = Uuid::new_v4().to_string();
    let entry = Arc::new(PtyEntry {
        writer: Mutex::new(writer),
        master: Mutex::new(master),
        history: Mutex::new(Vec::with_capacity(8192)),
        killed: Mutex::new(false),
    });

    REGISTRY.lock().unwrap().insert(id.clone(), entry.clone());

    Ok((id, pid, entry, reader, child))
}

/// Reader-loop that pumps bytes into the entry's history with cap
/// eviction. Calls `on_chunk` for each chunk so callers can forward
/// to their preferred sink (Tauri events for the command path; tests
/// can use a channel).
fn run_reader_loop(
    mut reader: Box<dyn Read + Send>,
    entry: Arc<PtyEntry>,
    mut on_chunk: impl FnMut(&[u8]) + Send + 'static,
) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = &buf[..n];
                {
                    let mut h = entry.history.lock().unwrap();
                    h.extend_from_slice(chunk);
                    if h.len() > HISTORY_CAP_BYTES {
                        let drop = h.len() - HISTORY_CAP_BYTES;
                        h.drain(0..drop);
                    }
                }
                on_chunk(chunk);
            }
            Err(_) => break,
        }
    }
}

/// True when `bytes` contains anything beyond the ConPTY init handshake.
/// Windows pseudoconsoles emit `ESC [ 6 n` (a cursor-position query) at
/// startup before — and regardless of whether — the child writes anything;
/// treating it as child output let a wedged wsl.exe defeat the silent-wedge
/// watchdog below AND hid the UI placeholder (WI-3033: permanently blank
/// terminal with zero guidance). A handshake SPLIT across reads counts as
/// real output — acceptable: the wedge delivers its 4 bytes in one read,
/// and a false "real" merely reverts to pre-fix watchdog behavior.
/// InlinePtyTerminal.tsx `chunkHasRealOutput` mirrors this exactly.
fn contains_real_output(bytes: &[u8]) -> bool {
    const HANDSHAKE: &[u8] = b"\x1b[6n";
    let mut rest = bytes;
    while rest.starts_with(HANDSHAKE) {
        rest = &rest[HANDSHAKE.len()..];
    }
    !rest.is_empty()
}

/// Spawn a new native pty and start a reader thread that emits
/// `pty-data` events as bytes arrive. Returns an id the renderer uses
/// for subsequent write/resize/kill calls.
#[tauri::command]
#[specta::specta]
pub fn pty_spawn(app: AppHandle, opts: PtySpawnOpts) -> Result<PtySpawnResult, String> {
    let (id, pid, entry, reader, mut child) = spawn_internal(&opts)?;

    // First-output flag for the WSL watchdog below.
    let got_output = Arc::new(std::sync::atomic::AtomicBool::new(false));

    // Reader thread: pump bytes into the history buffer + emit Tauri
    // events. We don't coalesce here because IPC events are cheap on
    // localhost.
    {
        let app = app.clone();
        let id_for_reader = id.clone();
        let entry_for_reader = entry.clone();
        let got_output = got_output.clone();
        thread::spawn(move || {
            run_reader_loop(reader, entry_for_reader, move |chunk| {
                // WI-3033: only REAL bytes count — the ConPTY init handshake
                // alone must not disarm the silent-wedge watchdog below.
                if contains_real_output(chunk) {
                    got_output.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                let _ = app.emit(
                    "pty-data",
                    PtyDataPayload {
                        id: id_for_reader.clone(),
                        data: B64.encode(chunk),
                    },
                );
            });
        });
    }

    // WSL silent-wedge watchdog: the INBOX (pre-Store) WSL's wsl.exe can
    // hang at the service handshake when spawned under a pseudoconsole —
    // it never execs the distro command, never writes a byte, never
    // exits (found live 2026-06-12: the wizard's install pty sat blank
    // on "Installing…" indefinitely; the same command via pipes works).
    // Zero bytes AND no exit after 20s is that wedge — kill the child
    // with an explanation so the UI gets a real exit instead of forever.
    #[cfg(target_os = "windows")]
    if crate::wsl_setup::detect_ready_cached() {
        let app = app.clone();
        let id_for_dog = id.clone();
        let entry_for_dog = entry.clone();
        let got_output = got_output.clone();
        let mut killer = child.clone_killer();
        thread::spawn(move || {
            thread::sleep(std::time::Duration::from_secs(20));
            if got_output.load(std::sync::atomic::Ordering::Relaxed)
                || *entry_for_dog.killed.lock().unwrap()
            {
                return;
            }
            let msg = "\r\n\x1b[31m[papercusp] wsl.exe produced no output for 20s — this matches a known hang in older (inbox) WSL installations when run under a terminal. From an elevated PowerShell run:  wsl --update   then restart Papercusp and retry.\x1b[0m\r\n";
            let _ = app.emit(
                "pty-data",
                PtyDataPayload {
                    id: id_for_dog.clone(),
                    data: B64.encode(msg.as_bytes()),
                },
            );
            eprintln!("[pty] watchdog: killing silent wsl.exe pty {}", id_for_dog);
            let _ = killer.kill();
        });
    }

    // Child-watcher thread: when the process exits, mark killed and
    // emit pty-exit. Same shape as pty-bridge's onExit.
    {
        let app = app.clone();
        let id = id.clone();
        let entry = entry.clone();
        thread::spawn(move || {
            let status = child.wait();
            *entry.killed.lock().unwrap() = true;
            let code = status.map(|s| s.exit_code() as i32).unwrap_or(-1);
            let _ = app.emit("pty-exit", PtyExitPayload { id, code });
        });
    }

    Ok(PtySpawnResult { id, pid })
}

#[tauri::command]
#[specta::specta]
pub fn pty_write(id: String, data: String) -> Result<(), String> {
    let entry = REGISTRY
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("unknown pty id: {}", id))?;
    if *entry.killed.lock().unwrap() {
        return Err("pty already exited".into());
    }
    let bytes = B64
        .decode(data.as_bytes())
        .map_err(|e| format!("invalid base64: {}", e))?;
    let mut writer = entry.writer.lock().unwrap();
    writer
        .write_all(&bytes)
        .map_err(|e| format!("pty write: {}", e))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn pty_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    let entry = REGISTRY
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("unknown pty id: {}", id))?;
    let master = entry.master.lock().unwrap();
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {}", e))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn pty_kill(id: String) -> Result<(), String> {
    let entry = REGISTRY
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or_else(|| format!("unknown pty id: {}", id))?;
    *entry.killed.lock().unwrap() = true;
    // Dropping the master closes the pty, which sends SIGHUP to the
    // child group and ends the reader thread on EOF. portable-pty
    // doesn't expose an explicit kill on the master, but drop is
    // sufficient for typical shells.
    drop(entry);
    Ok(())
}

/// Return the persistent history buffer for a pty as base64. Used by
/// PiPanel on remount: the new xterm starts blank and replays history
/// to reach the same on-screen state. Empty string if the pty is
/// unknown or the history is empty.
#[tauri::command]
#[specta::specta]
pub fn pty_history(id: String) -> Result<String, String> {
    let entry = REGISTRY
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("unknown pty id: {}", id))?;
    let h = entry.history.lock().unwrap();
    if h.is_empty() {
        return Ok(String::new());
    }
    Ok(B64.encode(h.as_slice()))
}

/// Whether a pty id is still alive. Lets the renderer fall through to
/// a fresh spawn when the resume id is stale.
#[tauri::command]
#[specta::specta]
pub fn pty_is_alive(id: String) -> bool {
    let reg = REGISTRY.lock().unwrap();
    match reg.get(&id) {
        Some(entry) => !*entry.killed.lock().unwrap(),
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Tests — exercise the pty manager without going through the Tauri
// AppHandle path. spawn_internal + run_reader_loop are the testable
// core; pty_spawn just adds event emission on top.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    fn wait_for<F: Fn(&[u8]) -> bool>(
        chunks: &mpsc::Receiver<Vec<u8>>,
        pred: F,
        timeout: Duration,
    ) -> Vec<u8> {
        let start = Instant::now();
        let mut acc: Vec<u8> = Vec::new();
        while start.elapsed() < timeout {
            match chunks.recv_timeout(Duration::from_millis(50)) {
                Ok(c) => {
                    acc.extend_from_slice(&c);
                    if pred(&acc) {
                        return acc;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
        acc
    }

    fn spawn_test(args: &[&str]) -> (String, Arc<PtyEntry>, mpsc::Receiver<Vec<u8>>) {
        // portable-pty snapshots HOME when CommandBuilder is created and uses
        // it as the default current directory. The workspace tests also
        // temporarily replace and remove HOME, so let every PTY test share the
        // crate-wide guard or a concurrent spawn can fail with ENOENT before
        // bash starts (the error is reported as "spawn child").
        let _home_guard = crate::HOME_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let opts = PtySpawnOpts {
            command: "bash".into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            env: std::collections::HashMap::new(),
            cols: 80,
            rows: 24,
        };
        let (id, _pid, entry, reader, _child) =
            spawn_internal(&opts).expect("spawn_internal failed");
        let (tx, rx) = mpsc::channel();
        let entry_for_reader = entry.clone();
        thread::spawn(move || {
            run_reader_loop(reader, entry_for_reader, move |chunk| {
                let _ = tx.send(chunk.to_vec());
            });
        });
        (id, entry, rx)
    }

    #[test]
    fn spawn_writes_bytes_to_history() {
        let (id, _entry, rx) = spawn_test(&["-c", "echo PTY_RUST_MARKER && sleep 0.2"]);
        let acc = wait_for(
            &rx,
            |a| {
                std::str::from_utf8(a)
                    .map(|s| s.contains("PTY_RUST_MARKER"))
                    .unwrap_or(false)
            },
            Duration::from_secs(2),
        );
        assert!(
            std::str::from_utf8(&acc)
                .unwrap()
                .contains("PTY_RUST_MARKER"),
            "expected marker in output, got: {:?}",
            String::from_utf8_lossy(&acc)
        );
        let history_b64 = pty_history(id.clone()).expect("pty_history failed");
        let history = B64.decode(history_b64).expect("decode history");
        assert!(
            std::str::from_utf8(&history)
                .unwrap()
                .contains("PTY_RUST_MARKER"),
            "history should contain marker"
        );
        let _ = pty_kill(id);
    }

    #[test]
    fn pty_write_forwards_keystrokes() {
        let (id, _entry, rx) = spawn_test(&["-c", "read x; echo GOT_$x; sleep 0.05"]);
        thread::sleep(Duration::from_millis(150));
        let payload = B64.encode(b"TYPED_RUST\n");
        pty_write(id.clone(), payload).expect("pty_write failed");
        let acc = wait_for(
            &rx,
            |a| {
                std::str::from_utf8(a)
                    .map(|s| s.contains("GOT_TYPED_RUST"))
                    .unwrap_or(false)
            },
            Duration::from_secs(2),
        );
        assert!(
            std::str::from_utf8(&acc)
                .unwrap()
                .contains("GOT_TYPED_RUST"),
            "expected echo, got: {:?}",
            String::from_utf8_lossy(&acc)
        );
        let _ = pty_kill(id);
    }

    #[test]
    fn pty_resize_changes_geometry() {
        let (id, _entry, rx) = spawn_test(&["-c", "stty size; sleep 0.3; stty size; sleep 0.1"]);
        // First reading should be 24 80.
        let first = wait_for(
            &rx,
            |a| {
                std::str::from_utf8(a)
                    .map(|s| s.contains("24 80"))
                    .unwrap_or(false)
            },
            Duration::from_secs(2),
        );
        assert!(
            std::str::from_utf8(&first).unwrap().contains("24 80"),
            "expected initial 24 80, got: {:?}",
            String::from_utf8_lossy(&first)
        );
        pty_resize(id.clone(), 132, 40).expect("pty_resize failed");
        let second = wait_for(
            &rx,
            |a| {
                std::str::from_utf8(a)
                    .map(|s| s.contains("40 132"))
                    .unwrap_or(false)
            },
            Duration::from_secs(2),
        );
        assert!(
            std::str::from_utf8(&second).unwrap().contains("40 132"),
            "expected post-resize 40 132, got: {:?}",
            String::from_utf8_lossy(&second)
        );
        let _ = pty_kill(id);
    }

    #[test]
    fn pty_is_alive_tracks_lifecycle() {
        let (id, _entry, _rx) = spawn_test(&["-c", "sleep 5"]);
        assert!(pty_is_alive(id.clone()), "should be alive before kill");
        pty_kill(id.clone()).expect("pty_kill failed");
        assert!(!pty_is_alive(id), "should report dead after kill");
    }

    #[test]
    fn conpty_handshake_alone_is_not_real_output() {
        // The wedge signature (WI-3033): exactly the ConPTY cursor-position
        // query, possibly repeated — never real child output.
        assert!(!contains_real_output(b""));
        assert!(!contains_real_output(b"\x1b[6n"));
        assert!(!contains_real_output(b"\x1b[6n\x1b[6n"));
        // Anything beyond the handshake is real, wherever it sits.
        assert!(contains_real_output(b"hello"));
        assert!(contains_real_output(b"\x1b[6nhello"));
        assert!(contains_real_output(b"\x1b[2J"));
        // A handshake split across reads counts as real (documented trade-off).
        assert!(contains_real_output(b"\x1b["));
    }

    #[test]
    fn unknown_id_errors_cleanly() {
        let bogus = "00000000-0000-0000-0000-000000000000".to_string();
        assert!(pty_write(bogus.clone(), String::new()).is_err());
        assert!(pty_resize(bogus.clone(), 80, 24).is_err());
        assert!(!pty_is_alive(bogus.clone()));
        assert!(pty_history(bogus).is_err());
    }
}
