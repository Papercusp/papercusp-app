// native_console — open an OS-native terminal window for the user.
//
// Triggered by the operator UI's "+" button (next to the voice button)
// in the global chrome. The flow is:
//
//   1. UI calls /api/agent-mcp/console/resolve which returns a
//      ConsoleEnvelope { cwd, env, mcpJsonContents, greetingCmd,
//      needsSuperuserBootstrap, ... }.
//   2. UI calls Tauri command `console_launch(envelope)` (this module).
//   3. This module:
//      a. Runs install-standalone-mcp.sh if needsSuperuserBootstrap.
//      b. Backs up any existing .mcp.json in cwd, writes the new one.
//      c. Spawns the user's terminal in a NEW WINDOW with cwd + env.
//      d. Schedules a sentinel-file watcher to restore the prior
//         .mcp.json when the user closes their terminal.
//
// Per-OS spawners follow:
//   macOS  — write a one-shot .command file in /tmp, `open -na` it.
//            `open -na` forces a fresh app instance = new window every
//            time (Terminal.app's AppleScript do-script reuses the
//            frontmost window).
//   Linux  — cascade through gnome-terminal / konsole / alacritty /
//            kitty / wezterm / xterm, each with its new-window flag.
//            Honor $TERMINAL first. Hard-error when none found.
//   Win+WSL — `wt.exe -w new --profile papercup-runtime new-tab
//            wsl.exe -d papercup-runtime -- bash -lc <one-liner>`.
//            Fallback: `wsl.exe -d ... ` with CREATE_NEW_CONSOLE.
//
// All paths produce a NEW WINDOW. No tabs.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Mirror of the TS-side `ConsoleEnvelope` from
/// packages/operator-core/lib/console-launcher.ts.
#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEnvelope {
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub mcp_json_contents: String,
    pub greeting_cmd: String,
    pub needs_superuser_bootstrap: bool,
    /// windows-desktop-feature-parity-2026-07-02 P-010: a fresh UUID minted
    /// per launch (console-launcher.ts `buildConsoleEnvelope`) — the WINDOW's
    /// own identity. Every spawner titles the OS window
    /// `Papercup — <session_id>` (see `window_title_for` below) so a
    /// launched terminal can be found + focused by TITLE, which matters most
    /// on Windows: the agent runs inside the `papercup-runtime` WSL2 distro
    /// while the terminal window is a native Win32 process, so there is no
    /// Windows window-ancestor for a WSL pid and pid->window mapping is
    /// structurally impossible — title is the only durable link.
    pub session_id: String,
}

/// The window title every OS-native console spawn uses. Kept as one
/// function so all three spawners (+ the OSC-0 fallback escape in the
/// launcher one-liner) stay byte-for-byte consistent with each other and
/// with the `windows-desktop-windows.ts` lookup prefix (`"Papercup — "`,
/// em dash U+2014 — this is the shared contract other lanes build against;
/// don't change the format without updating that helper + adv-sessions.ts).
fn window_title_for(session_id: &str) -> String {
    format!("Papercup — {session_id}")
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ConsoleLaunchResult {
    Ok {
        pid: Option<u32>,
        displaced_mcp_json: bool,
        bootstrapped: bool,
    },
    Err {
        error: String,
    },
}

#[tauri::command]
#[specta::specta]
pub async fn console_launch(envelope: ConsoleEnvelope) -> ConsoleLaunchResult {
    match launch_inner(envelope).await {
        Ok((pid, displaced, bootstrapped)) => ConsoleLaunchResult::Ok {
            pid,
            displaced_mcp_json: displaced,
            bootstrapped,
        },
        Err(e) => ConsoleLaunchResult::Err { error: e },
    }
}

// ─────────────────────────────────────────────────────────────────────────
// windows-desktop-feature-parity-2026-07-02 D-002 — window enumeration + focus
// as Tauri commands (the D-001 pivot).
//
// The operator runs INSIDE the `papercup-runtime` WSL2 distro. A `powershell.exe`
// it spawns via WSL interop lands in SESSION 0 (the services window-station), from
// which it sees ZERO interactive Session-1 desktop windows (VM-verified 2026-07-02:
// its own SessionId is 0 and EnumWindows returns []). So window enum/focus CANNOT
// be done operator-side. It must run in THIS process (`papercusp-desktop.exe`) — a
// Session-1 native app that CAN enumerate the interactive desktop. The renderer
// invokes these commands (in-process IPC, also Session 1); the operator reaches
// them THROUGH the renderer (focus = user click in /adv; liveness = a periodic
// renderer push of the window list to the operator's reaper cache).
// ─────────────────────────────────────────────────────────────────────────

/// A visible top-level desktop window. `hwnd` is the raw handle as a decimal
/// string (opaque to JS — only round-tripped back into `focus_window_by_title`).
/// Mirrors the TS `WindowsDesktopWindow` shape in windows-desktop-windows.ts.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindow {
    pub title: String,
    pub pid: u32,
    pub hwnd: String,
}

/// EnumWindows over visible titled top-level windows, optionally filtered to
/// titles starting with `prefix`. Windows-only; mirrors win_embed's callback
/// style (a `Ctx` passed through `LPARAM`).
#[cfg(target_os = "windows")]
fn enumerate_windows(prefix: Option<&str>) -> Vec<DesktopWindow> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    };
    struct Ctx {
        prefix: Option<String>,
        out: Vec<DesktopWindow>,
    }
    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = unsafe { &mut *(lparam.0 as *mut Ctx) };
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return BOOL(1);
        }
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return BOOL(1);
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
        if n <= 0 {
            return BOOL(1);
        }
        let title = String::from_utf16_lossy(&buf[..n as usize]);
        if let Some(p) = &ctx.prefix {
            if !title.starts_with(p.as_str()) {
                return BOOL(1);
            }
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        ctx.out.push(DesktopWindow {
            title,
            pid,
            hwnd: (hwnd.0 as isize).to_string(),
        });
        BOOL(1) // keep enumerating
    }
    let mut ctx = Ctx {
        prefix: prefix.map(|s| s.to_string()),
        out: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.out
}

/// Enumerate visible top-level desktop windows, optionally filtered to titles
/// starting with `prefix` (pass `"Papercup — "` for session terminals). Runs
/// natively in this Session-1 process — the ONLY place window enumeration works
/// on Windows (D-002). Returns `[]` on non-Windows (Linux uses the operator's
/// wmctrl path) so the binding exists cross-platform and is always fail-soft.
#[tauri::command]
#[specta::specta]
pub fn list_windows_by_title(prefix: Option<String>) -> Vec<DesktopWindow> {
    #[cfg(target_os = "windows")]
    {
        enumerate_windows(prefix.as_deref())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = prefix;
        Vec::new()
    }
}

/// Bring the window whose title EXACTLY equals `title` to the foreground
/// (restoring it first if minimized). USER-INITIATED ONLY — mirrors the
/// `feedback_e2e_no_focus_steal` memory; never call from an automated driver.
/// Returns true iff a matching window was found and the foreground call issued.
/// No-op returning false on non-Windows (Linux focus stays the wmctrl path).
#[tauri::command]
#[specta::specta]
pub fn focus_window_by_title(title: String) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::c_void;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
        };
        let handle = enumerate_windows(None)
            .into_iter()
            .find(|w| w.title == title)
            .and_then(|w| w.hwnd.parse::<isize>().ok());
        match handle {
            Some(h) => {
                let hwnd = HWND(h as *mut c_void);
                unsafe {
                    if IsIconic(hwnd).as_bool() {
                        let _ = ShowWindow(hwnd, SW_RESTORE);
                    }
                    SetForegroundWindow(hwnd).as_bool()
                }
            }
            None => false,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = title;
        false
    }
}

/// True when an fs-relay error String indicates the source path was missing
/// (a `mv`/rename whose source vanished under us). Lets the .mcp.json backup
/// tolerate a concurrent sibling launch racing on the same cwd instead of
/// hard-failing the whole spawn. Matches the wsl.exe `mv` stderr ("cannot
/// stat … No such file or directory") and the native std::io ENOENT text.
fn is_missing_path_err(e: &str) -> bool {
    let l = e.to_ascii_lowercase();
    l.contains("no such file")           // linux/mac std::fs + wsl.exe `mv`
        || l.contains("cannot stat")     // GNU coreutils `mv` stderr
        || l.contains("not found")
        || l.contains("cannot find the file")   // Windows-native ENOENT
        || l.contains("cannot find the path")
}

async fn launch_inner(envelope: ConsoleEnvelope) -> Result<(Option<u32>, bool, bool), String> {
    // 1. Bootstrap superuser token if needed.
    let bootstrapped = if envelope.needs_superuser_bootstrap {
        ensure_superuser_token().await?;
        true
    } else {
        false
    };

    // 2. Atomic .mcp.json write with backup-restore.
    //    Via the cfs_* console-fs helpers: on Windows `envelope.cwd` is a
    //    LINUX path inside the WSL distro (where the console will run), so
    //    every fs op must relay through `wsl.exe` — Windows std::fs against
    //    it fails with os error 3 (found live 2026-07-03, WI-2149), and the
    //    \\wsl.localhost mount is unreliable on real installs.
    //    WI-3289: an EMPTY mcp_json_contents means "leave the project's
    //    .mcp.json alone" (buildConsoleEnvelope's skipMcpJson — the agent-
    //    bridged capability:terminal / fleet:launch-on-plan envelopes).
    //    Displacing + writing an empty file here would clobber the real one.
    let mcp_path = console_path_join(&envelope.cwd, ".mcp.json");
    let displaced = if envelope.mcp_json_contents.is_empty() {
        false
    } else {
        let displaced = if cfs_exists(&mcp_path) {
            let bak = console_path_join(&envelope.cwd, ".mcp.json.papercusp.bak");
            // If a stale bak from a previous unclean exit is sitting there,
            // leave it alone — we'd rather lose our restore than clobber
            // the user's real mcp.json on a botched cleanup.
            if !cfs_exists(&bak) {
                match cfs_rename(&mcp_path, &bak) {
                    Ok(()) => true,
                    // TOCTOU: a concurrent sibling launch in the SAME cwd (a
                    // bulk capability:terminal call, or a multi-member
                    // fleet:launch-on-plan) can move/remove .mcp.json between
                    // our cfs_exists() check above and this rename — the `mv`
                    // then fails "cannot stat … No such file". A vanished
                    // source is not a failure: there is nothing to back up, so
                    // proceed to write ours instead of aborting the whole
                    // launch (WI-3360 fleet-launch hardening).
                    Err(e) if is_missing_path_err(&e) => false,
                    Err(e) => return Err(format!("backup .mcp.json: {e}")),
                }
            } else {
                // Best effort: archive ours under a unique name. The user
                // can sort it out manually.
                false
            }
        } else {
            false
        };
        cfs_write(&mcp_path, &envelope.mcp_json_contents)
            .map_err(|e| format!("write .mcp.json: {e}"))?;
        displaced
    };

    // 3. Build the launcher one-liner (same shape on every OS).
    let oneliner = build_launcher_oneliner(&envelope);

    // 4. Per-OS new-window spawn.
    let pid = if cfg!(target_os = "macos") {
        spawn_macos_new_window(&envelope, &oneliner)?
    } else if cfg!(target_os = "linux") {
        spawn_linux_new_window(&envelope, &oneliner)?
    } else if cfg!(target_os = "windows") {
        spawn_windows_wsl_new_window(&envelope, &oneliner)?
    } else {
        return Err(format!("unsupported platform"));
    };

    // 5. Schedule .mcp.json restore when the user's shell exits.
    //    We can't watch the terminal launcher's pid (it exits in ~1s);
    //    we watch for the sentinel files the launcher's bash one-liner
    //    drops in cwd. Cap at 24h so a botched cleanup eventually heals.
    if displaced {
        let cwd_clone = envelope.cwd.clone();
        let mcp_path_clone = mcp_path.clone();
        let backup_path = console_path_join(&envelope.cwd, ".mcp.json.papercusp.bak");
        std::thread::spawn(move || {
            watch_and_restore_mcp_json(cwd_clone, mcp_path_clone, backup_path);
        });
    } else {
        // Even when we didn't displace anything, schedule a cleanup of
        // the .mcp.json we wrote — otherwise it sits in the user's
        // project forever, surprising them later when they `cat .mcp.json`.
        let mcp_path_clone = mcp_path.clone();
        let cwd_clone = envelope.cwd.clone();
        std::thread::spawn(move || {
            watch_and_remove_mcp_json(cwd_clone, mcp_path_clone);
        });
    }

    Ok((pid, displaced, bootstrapped))
}

/// Poll cwd for sentinel files. When none remain (the user closed the
/// last papercup-launched shell), restore the prior `.mcp.json` from
/// the backup. Bounded by a 24h hard timeout so a hung shell doesn't
/// leak our .mcp.json forever.
fn watch_and_restore_mcp_json(cwd: String, mcp_path: String, backup_path: String) {
    if !wait_for_sentinels_to_clear(&cwd) {
        // Hard timeout fired. Restore anyway — better to lose freshness
        // than to leak our config forever.
    }
    // Atomic-ish restore: rename bak over mcp_path. If the user
    // edited .mcp.json in the meantime they lose those edits — but
    // they wrote them into our temporary file, which was always
    // documented as ephemeral.
    let _ = cfs_rename(&backup_path, &mcp_path);
}

/// Same as `watch_and_restore_mcp_json` but for the case where no
/// prior `.mcp.json` existed — we just remove ours when the last
/// console exits.
fn watch_and_remove_mcp_json(cwd: String, mcp_path: String) {
    let _cleared = wait_for_sentinels_to_clear(&cwd);
    // On either clean exit OR 24h timeout we remove our file. Leaving
    // it indefinitely would surprise the user; they can rerun the
    // launcher to get it back.
    cfs_remove(&mcp_path);
}

/// Poll cwd every 5s for `.papercup-console-active.*` files. Returns
/// true when the last sentinel went away (clean exit), false on
/// 24h timeout.
fn wait_for_sentinels_to_clear(cwd: &str) -> bool {
    use std::time::{Duration, Instant};
    const POLL: Duration = Duration::from_secs(5);
    const HARD_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
    let deadline = Instant::now() + HARD_TIMEOUT;

    // Initial grace window: the launcher one-liner needs a few seconds
    // to actually touch the first sentinel after the terminal opens.
    // Without this, a fast-polling loop would see zero sentinels at
    // t=0 and restore immediately, before the user's shell started.
    std::thread::sleep(Duration::from_secs(8));

    loop {
        if Instant::now() > deadline {
            return false;
        }
        let any = count_sentinels(cwd) > 0;
        if !any {
            return true;
        }
        std::thread::sleep(POLL);
    }
}

#[cfg(not(target_os = "windows"))]
fn count_sentinels(cwd: &str) -> usize {
    let Ok(entries) = std::fs::read_dir(cwd) else {
        return 0;
    };
    let prefix = SENTINEL_PREFIX;
    entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_str()
                .map(|n| n.starts_with(prefix))
                .unwrap_or(false)
        })
        .count()
}

/// Windows: the sentinels live in the WSL cwd — count them through the distro.
/// A relay FAILURE conservatively counts as 1 (assume a console is still
/// alive) so a transient WSL hiccup can't trigger a premature .mcp.json
/// restore; the 24h hard timeout still bounds the wait.
#[cfg(target_os = "windows")]
fn count_sentinels(cwd: &str) -> usize {
    let script = format!(
        "ls -1d {}/{}* 2>/dev/null | wc -l",
        shell_escape_single(cwd),
        SENTINEL_PREFIX
    );
    match wsl_fs(&["bash", "-c", &script], None) {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<usize>()
            .unwrap_or(1),
        _ => 1,
    }
}

// ── Console-fs helpers ──────────────────────────────────────────────
// The console's filesystem is OURS on macOS/Linux, but on Windows the
// console (and the operator that built the envelope) runs INSIDE the WSL
// distro, so `envelope.cwd` is a Linux path: Windows std::fs against it
// fails (os error 3), and the \\wsl.localhost mount is unreliable on real
// installs (see main.rs read_operator_discovery_via_wsl). Every path here
// is a STRING joined with '/' — correct on all three targets.

fn console_path_join(cwd: &str, name: &str) -> String {
    format!("{}/{}", cwd.trim_end_matches('/'), name)
}

/// Run a short-lived fs relay inside the WSL distro, hidden (CREATE_NO_WINDOW),
/// optionally feeding `stdin` — the transport every cfs_* helper uses on Windows.
#[cfg(target_os = "windows")]
fn wsl_fs(args: &[&str], stdin: Option<&str>) -> Result<std::process::Output, String> {
    use std::io::Write as _;
    use std::os::windows::process::CommandExt as _;
    let mut cmd = std::process::Command::new("wsl.exe");
    // ROOT-CAUSE FIX (WI-2955): mirror make_sidecar_command's PROVEN-WORKING
    // operator invocation (main.rs: `--distribution <D> --cd <wsl-cwd> --exec
    // <cmd>`). The old `-d <D> -- <cmd>` form let wsl.exe DEFAULT the Linux cwd to
    // the CALLER's translated Windows path (/mnt/c/…). papercup-runtime is a
    // minimal rootfs (`[interop] appendWindowsPath=false`, no guaranteed /mnt
    // automount — build-rootfs.sh), so that cwd translation FAILS and wsl.exe
    // exits non-zero with EMPTY stdout+stderr BEFORE the relayed command runs —
    // the undiagnosable blank `write .mcp.json:` (the operator's own `--exec node`
    // never hit this because it always passes `--cd`). `--cd /` pins the cwd to a
    // path that always exists; `--exec` skips the login-shell tail re-parse. All
    // callers pass a directly-exec'able argv (`bash -c …`, `mv`, `test`), so
    // `--exec` is a drop-in. Verified live on the QEMU Win11 VM: the `cat >
    // <target>` relay returns RC=0 with this form and RC=1/empty without it.
    cmd.arg("--distribution")
        .arg(WSL_DISTRO)
        .arg("--cd")
        .arg("/")
        .arg("--exec")
        .args(args);
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.stdin(if stdin.is_some() {
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    });
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("wsl.exe spawn: {e}"))?;
    if let Some(data) = stdin {
        let mut si = child.stdin.take().ok_or("wsl.exe stdin unavailable")?;
        si.write_all(data.as_bytes())
            .map_err(|e| format!("wsl.exe stdin: {e}"))?;
    }
    child
        .wait_with_output()
        .map_err(|e| format!("wsl.exe wait: {e}"))
}

/// Decode bytes emitted by a `wsl.exe` relay. `wsl.exe` writes its OWN
/// diagnostics (e.g. "There is no distribution with the supplied name" /
/// "The system cannot find the path specified") as **UTF-16LE**, whereas a
/// relayed bash command's own output is UTF-8. Detect UTF-16LE via a BOM or a
/// run of interleaved NUL bytes (ASCII text in UTF-16LE has a NUL every other
/// byte) and decode accordingly; otherwise UTF-8-lossy. Ungated + pure so it
/// unit-tests on the Linux dev box (WI-2955).
#[cfg(any(target_os = "windows", test))]
fn decode_wsl_bytes(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let has_bom = bytes.starts_with(&[0xFF, 0xFE]);
    // Sample up to the first 16 even-indexed high bytes: mostly-NUL ⇒ UTF-16LE
    // ASCII. (Odd index holds the low byte of each UTF-16LE code unit.)
    let sampled: Vec<u8> = bytes.iter().skip(1).step_by(2).take(16).copied().collect();
    let nul_run =
        !sampled.is_empty() && sampled.iter().filter(|&&b| b == 0).count() * 2 >= sampled.len();
    if has_bom || nul_run {
        let start = if has_bom { 2 } else { 0 };
        let u16s: Vec<u16> = bytes[start..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s).trim().to_string()
    } else {
        String::from_utf8_lossy(bytes).trim().to_string()
    }
}

/// Rich error for a failed `wsl.exe` relay. The old sites returned ONLY
/// `from_utf8_lossy(stderr)`, so a wsl.exe interop/distro failure — which lands
/// its message on STDOUT as UTF-16LE and leaves stderr empty — surfaced as a
/// blank cause (the useless `write .mcp.json: ` this fixes, WI-2955). Surface
/// the exit code AND both decoded streams. Windows-only (its only callers are the
/// `#[cfg(windows)]` cfs_* sites); `decode_wsl_bytes` carries the `test` cfg so
/// its heuristic is unit-covered on the Linux dev box.
#[cfg(target_os = "windows")]
fn wsl_relay_error(out: &std::process::Output) -> String {
    let code = out
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "terminated-by-signal".to_string());
    let serr = decode_wsl_bytes(&out.stderr);
    let sout = decode_wsl_bytes(&out.stdout);
    let mut parts = vec![format!("wsl.exe exit {code}")];
    if !serr.is_empty() {
        parts.push(format!("stderr: {serr}"));
    }
    if !sout.is_empty() {
        parts.push(format!("stdout: {sout}"));
    }
    if serr.is_empty() && sout.is_empty() {
        parts.push(
            "(no stdout/stderr — wsl.exe produced no output; distro exec/interop unavailable?)"
                .to_string(),
        );
    }
    parts.join("; ")
}

#[cfg(not(target_os = "windows"))]
fn cfs_exists(path: &str) -> bool {
    std::path::Path::new(path).exists()
}

#[cfg(target_os = "windows")]
fn cfs_exists(path: &str) -> bool {
    wsl_fs(&["test", "-e", path], None)
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn cfs_rename(from: &str, to: &str) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn cfs_rename(from: &str, to: &str) -> Result<(), String> {
    // WI-3746: same wsl.exe-interop-under-concurrency class as cfs_write below
    // (a 2nd+ fleet member's rename can race a 1st member's already-live,
    // CPU-heavy session). Retry transient failures with the same backoff
    // budget, but return a genuine "source vanished" immediately rather than
    // burning the retry budget — the .mcp.json-backup caller relies on that
    // outcome coming back promptly to tolerate a concurrent sibling launch
    // (is_missing_path_err), not after several seconds of retries.
    let mut last = String::from("cfs_rename: no attempt ran");
    for attempt in 0..WSL_WRITE_MAX_ATTEMPTS {
        match wsl_fs(&["mv", "-f", from, to], None) {
            Ok(out) if out.status.success() => return Ok(()),
            Ok(out) => {
                let err = wsl_relay_error(&out);
                if is_missing_path_err(&err) {
                    return Err(err);
                }
                last = err;
            }
            Err(e) => last = e,
        }
        if cfs_exists(to) {
            return Ok(());
        }
        if attempt + 1 < WSL_WRITE_MAX_ATTEMPTS {
            let jitter = to.bytes().fold(0u64, |a, b| a.wrapping_add(b as u64)) % 100;
            let backoff_ms = (200u64 << attempt).min(2000);
            std::thread::sleep(std::time::Duration::from_millis(backoff_ms + jitter));
        }
    }
    Err(last)
}

#[cfg(not(target_os = "windows"))]
fn cfs_write(path: &str, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
const WSL_WRITE_MAX_ATTEMPTS: u32 = 7;

#[cfg(target_os = "windows")]
fn cfs_write(path: &str, contents: &str) -> Result<(), String> {
    // `cat > path` truncates + rewrites, so the op is IDEMPOTENT and safe to
    // retry. wsl.exe interop intermittently fails under CONCURRENCY: a
    // desktop-bridge fleet launch fires N script writes at once and ~1/3 of a
    // 10-wide batch failed (df2cc 2026-07-08) — either "wsl.exe exit 1" with no
    // output (surface A), or a separate reader wsl.exe not seeing the file →
    // bash exits 127 "No such file" (surface B). Retry with per-path-jittered
    // backoff + a post-write existence check to ride out the transient.
    //
    // WI-3746: the original 4-attempt/~0.5s-total budget was tuned for a brief
    // interop blip, not for a SECOND member's launch racing a FIRST member's
    // already-live, CPU-heavy claude/psu session inside the same distro — that
    // contention can outlast 0.5s. Widened to 7 attempts / ~7s total backoff
    // (capped exponential) so a fleet launch rides out multi-second contention
    // instead of hard-failing the 2nd+ concurrent member.
    let script = format!("cat > {}", shell_escape_single(path));
    // Per-path jitter (no rand dep) decorrelates concurrent writers — each has a
    // unique script path — so their retries don't collide in lockstep.
    let jitter = path.bytes().fold(0u64, |a, b| a.wrapping_add(b as u64)) % 100;
    let mut cat_ever_ok = false;
    let mut last = String::from("cfs_write: no attempt ran");
    for attempt in 0..WSL_WRITE_MAX_ATTEMPTS {
        match wsl_fs(&["bash", "-c", &script], Some(contents)) {
            Ok(out) if out.status.success() => {
                cat_ever_ok = true;
                // Surface B: a `cat >` that exits 0 has, under load, still been
                // followed by a reader that can't see the file. Confirm it
                // landed before reporting success; otherwise retry.
                if cfs_exists(path) {
                    return Ok(());
                }
                last = "write exited 0 but the file was not visible afterward (wsl interop race)"
                    .to_string();
            }
            Ok(out) => last = wsl_relay_error(&out),
            Err(e) => last = e,
        }
        if attempt + 1 < WSL_WRITE_MAX_ATTEMPTS {
            let backoff_ms = (200u64 << attempt).min(2000);
            std::thread::sleep(std::time::Duration::from_millis(backoff_ms + jitter));
        }
    }
    // If the write command itself EVER exited 0, trust it (cfs_exists can race
    // under the same load); only hard-fail when no attempt ever succeeded.
    if cat_ever_ok {
        Ok(())
    } else {
        Err(last)
    }
}

#[cfg(not(target_os = "windows"))]
fn cfs_remove(path: &str) {
    let _ = std::fs::remove_file(path);
}

#[cfg(target_os = "windows")]
fn cfs_remove(path: &str) {
    let _ = wsl_fs(&["rm", "-f", path], None);
}

/// Build the bash one-liner the terminal runs as its first command.
/// Pattern:
///   cd → env exports → stamp process birth identity → drop sentinel →
///   trap-cleanup → greeting → exec shell
///
/// The sentinel file (`.papercup-console-active.$`) is how the Rust
/// side knows the user's shell is still alive. We can't trust the pid
/// of the terminal launcher itself (open/wt.exe/gnome-terminal etc.
/// exit immediately after the window appears), so we use a filesystem
/// fingerprint that survives across process boundaries.
///
/// `exec` chains so the env survives without touching rc files.
fn build_launcher_oneliner(envelope: &ConsoleEnvelope) -> String {
    let env_exports = build_env_exports(&envelope.env);
    // The greeting travels as a shell-escaped LITERAL that a subshell `eval`s
    // at runtime — never spliced in as bare syntax. The old bare
    // `replace('\'', "'\\''")` escaped for a single-quoted context the greeting
    // was never inside, so any greeting containing a quote produced an
    // unparseable one-liner (macOS Terminal: `bash: -c: line 0: unexpected EOF
    // while looking for matching "'"`). Mirrors console-spawn.ts
    // buildConsoleOneliner — keep the two in lockstep.
    let greeting = shell_escape_single(&envelope.greeting_cmd);
    let cwd_escaped = shell_escape_single(&envelope.cwd);
    // OSC-0 title escape: sets the window/tab/conhost title to the same
    // `Papercup — <session_id>` string the Windows wt.exe spawner also
    // passes via `--title`. Redundant-by-design belt-and-suspenders — on
    // Windows this is what titles the window when wt.exe is absent and we
    // fall back to a bare `wsl.exe` in a fresh conhost (which has no
    // --title flag of its own, but conhost/ConPTY honor VT title escapes).
    // Harmless on macOS/Linux (every terminal there honors OSC 0 too).
    let win_title = window_title_for(&envelope.session_id);
    let title_quoted = shell_escape_single(&win_title);
    // WI-40182: run the greeting from the rcfile of a genuinely interactive
    // bash. The terminal emulator initially invokes a non-interactive
    // `bash -lc`; if that shell runs the greeting directly, Ctrl+C targets the
    // wrapper and greeting in the same foreground process group and can close
    // the whole window. Interactive bash gives the greeting its own foreground
    // job while the shell survives to present a prompt. Keep this in lockstep
    // with console-spawn.ts keepWindowOpenOnFailure.
    let interactive_script = format!(
        "trap 'rm -f {sentinel_glob}.$$' EXIT; \
         (eval {greet}); \
         exec \"${{SHELL:-/bin/bash}}\" -l",
        sentinel_glob = SENTINEL_PREFIX,
        greet = greeting,
    );
    let interactive_script_quoted = shell_escape_single(&interactive_script);
    format!(
        "printf '\\033]0;%s\\007' {title} \
         ; cd {cwd} && {exports} \
         && PAPERCUSP_CONSOLE_IDENTITY=\"$( \
              if [ -r /proc/sys/kernel/random/boot_id ] && [ -r /proc/$$/stat ]; then \
                printf 'linux:%s:%s' \
                  \"$(cat /proc/sys/kernel/random/boot_id)\" \
                  \"$(awk '{{print $22}}' /proc/$$/stat)\"; \
              else \
                papercusp_started=\"$(ps -o lstart= -p $$ 2>/dev/null | awk '{{$1=$1; print}}')\"; \
                [ -n \"$papercusp_started\" ] && printf 'darwin:%s' \"$papercusp_started\"; \
              fi; true)\" \
         && export PAPERCUSP_CONSOLE_IDENTITY \
         && printf '%s\n' \"$PAPERCUSP_CONSOLE_IDENTITY\" > {sentinel_glob}.$$ \
         ; exec bash --noprofile --rcfile <(printf '%s\\n' {interactive_script}) -i",
        title = title_quoted,
        cwd = cwd_escaped,
        exports = env_exports,
        sentinel_glob = SENTINEL_PREFIX,
        interactive_script = interactive_script_quoted,
    )
}

/// Sentinel filename prefix. The launcher one-liner writes
/// `<prefix>.<pid>` on entry and deletes it on exit (trap). The
/// cleanup watcher polls for any matching file in cwd.
const SENTINEL_PREFIX: &str = ".papercup-console-active";

fn build_env_exports(env: &HashMap<String, String>) -> String {
    let mut parts = Vec::with_capacity(env.len() + 1);
    // Prepend our shim dir (psu/ptool, ~/.papercusp/bin) and the bundled scripts
    // dir to PATH if the operator sent them — keeps `papercup`/`psu`/`ptool`
    // callable without an absolute path. Bin dir first so a user shim wins over a
    // same-named bundled script (psu-in-desktop-builds-2026-06-23 A2b).
    let mut path_prepend: Vec<String> = Vec::new();
    if let Some(bin) = env.get("PAPERCUSP_BIN_DIR") {
        path_prepend.push(shell_escape_single(bin));
    }
    if let Some(scripts) = env.get("PAPERCUSP_SCRIPTS_DIR") {
        path_prepend.push(shell_escape_single(scripts));
    }
    if !path_prepend.is_empty() {
        parts.push(format!("export PATH={}:${{PATH}}", path_prepend.join(":")));
    }
    // Export every var itself (including PAPERCUSP_BIN_DIR / PAPERCUSP_SCRIPTS_DIR,
    // which are valid bash names) so scripts can introspect them.
    for (k, v) in env {
        // Skip names that aren't safe bash identifiers.
        if !is_valid_env_name(k) {
            continue;
        }
        parts.push(format!("export {}={}", k, shell_escape_single(v)));
    }
    parts.join(" && ")
}

fn is_valid_env_name(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Single-quote a path for safe bash literal use. Replaces internal
/// single quotes with the escape sequence `'\''`.
fn shell_escape_single(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// ─── External console run (WI-3033) ─────────────────────────────────
// On Windows the embedded xterm path (pty_spawn → portable_pty ConPTY →
// wsl.exe) wedges on legacy inbox WSL: wsl.exe under ConPTY never execs
// the distro command (history stays the ConPTY handshake `\x1b[6n`
// forever). The SAME command renders fine inside a real terminal window
// (wt.exe / conhost — proven by console_launch, WI-2955). So Windows
// surfaces that would embed a terminal route the command to an external
// Windows Terminal window instead, via the same transient-script spawner
// console_launch uses.

/// A command to run in an external native terminal window. Mirror of the
/// TS-side spec assembled in OnboardingConsole.tsx (camelCase over the wire).
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalConsoleSpec {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Linux path INSIDE the WSL distro (the operator + command live there).
    pub cwd: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Exact window title — the frontend focuses the window by this title
    /// later (focus_window_by_title), so it must be stable per surface.
    pub title: String,
}

/// The bash one-liner the external window runs: title the window (OSC-0,
/// what titles the conhost fallback — wt gets --title too), cd, export the
/// spec env, exec the command; on non-zero exit hold the window open so
/// the user can read the error instead of the window vanishing.
#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn build_external_oneliner(spec: &ExternalConsoleSpec) -> String {
    let title_quoted = shell_escape_single(&spec.title);
    let cwd_escaped = shell_escape_single(&spec.cwd);
    let exports = build_env_exports(&spec.env);
    let cmd = std::iter::once(&spec.command)
        .chain(spec.args.iter())
        .map(|part| shell_escape_single(part))
        .collect::<Vec<_>>()
        .join(" ");
    let body = if exports.is_empty() {
        format!("cd {cwd_escaped} && {cmd}")
    } else {
        format!("cd {cwd_escaped} && {exports} && {cmd}")
    };
    format!(
        "printf '\\033]0;%s\\007' {title_quoted} ; {body} ; rc=$? ; \
         if [ $rc -ne 0 ]; then \
         printf '\\n[papercusp] exited with code %s — press Enter to close\\n' \"$rc\" ; \
         read -r _ ; fi"
    )
}

/// Run `spec` in a new external NATIVE terminal window.
///
///  - Windows: a new Windows Terminal window (conhost fallback) — WI-3033
///    (the embedded ConPTY path wedges on legacy inbox WSL).
///  - Linux: a new terminal window — the BUNDLED ghostty first (always shipped
///    with the desktop, so a barebones install needs no system emulator), then
///    $TERMINAL / the known-emulator cascade. Owner directive 2026-07-05: the
///    onboarding tutorial runs in a real native terminal window, not an
///    embedded webview pane.
///  - macOS: unchanged (the embedded SwiftTerm pane works and stays the UX).
///
/// Returns the launcher pid when one is observable.
#[tauri::command]
#[specta::specta]
pub async fn external_console_run(spec: ExternalConsoleSpec) -> Result<Option<u32>, String> {
    #[cfg(target_os = "windows")]
    {
        let oneliner = build_external_oneliner(&spec);
        let script_name = format!(
            ".papercup-external-console.{}.sh",
            uuid::Uuid::new_v4().simple()
        );
        spawn_windows_terminal_script(&spec.cwd, &spec.title, &script_name, &oneliner)
    }
    #[cfg(target_os = "linux")]
    {
        let oneliner = build_external_oneliner(&spec);
        spawn_linux_external_window(&spec, &oneliner)
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = spec;
        Err("external_console_run is Windows/Linux-only — use the embedded terminal".to_string())
    }
}

/// Spawn `bash -lc <oneliner>` in a NEW native terminal window on Linux.
///
/// Terminal resolution order:
///  1. `PAPERCUSP_GHOSTTY_BIN` / `ghostty` on PATH — the desktop BUNDLES ghostty
///     (and `prepare_dock_env` prepends `sidecar/bin` to PATH at boot), so this
///     works on a barebones install with no system terminal emulator at all
///     (e.g. the clean-room test VM). Decorated normal window — NOT the
///     borderless glued dock look.
///  2. `$TERMINAL`, then the known-emulator cascade — same policy as
///     `spawn_linux_new_window` (the console_launch path).
///
/// The window titles itself via the OSC-0 escape inside the oneliner, so no
/// per-emulator title flag is needed.
#[cfg(target_os = "linux")]
fn spawn_linux_external_window(
    spec: &ExternalConsoleSpec,
    oneliner: &str,
) -> Result<Option<u32>, String> {
    let ghostty = std::env::var("PAPERCUSP_GHOSTTY_BIN").unwrap_or_else(|_| "ghostty".to_string());
    if is_on_path(&ghostty) {
        // --gtk-single-instance=false: our own pid owns the window (trackable);
        // no --window-decoration=false → a regular, decorated native window.
        return spawn_external_with(
            &ghostty,
            &["--gtk-single-instance=false", "-e"],
            spec,
            oneliner,
        );
    }
    if let Ok(term) = std::env::var("TERMINAL") {
        if is_on_path(&term) {
            return spawn_external_with(&term, &["-e"], spec, oneliner);
        }
    }
    for (bin, args) in LINUX_TERMINALS {
        if is_on_path(bin) {
            return spawn_external_with(bin, args, spec, oneliner);
        }
    }
    let tried: Vec<&str> = LINUX_TERMINALS.iter().map(|(b, _)| *b).collect();
    Err(format!(
        "no terminal emulator found. Set $TERMINAL or install one of: ghostty, {}",
        tried.join(", ")
    ))
}

/// Spawn helper for `spawn_linux_external_window` — the ExternalConsoleSpec
/// twin of `spawn_linux_with` (which takes a ConsoleEnvelope).
#[cfg(target_os = "linux")]
fn spawn_external_with(
    bin: &str,
    args: &[&str],
    spec: &ExternalConsoleSpec,
    oneliner: &str,
) -> Result<Option<u32>, String> {
    let mut cmd = std::process::Command::new(bin);
    cmd.current_dir(&spec.cwd);
    for (k, v) in &spec.env {
        if is_valid_env_name(k) {
            cmd.env(k, v);
        }
    }
    strip_terminal_context_env(&mut cmd);
    for a in args {
        cmd.arg(a);
    }
    cmd.arg("bash").arg("-lc").arg(oneliner);
    // Detach stdio so the window outlives whatever spawned it.
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let child = cmd.spawn().map_err(|e| format!("spawn {bin}: {e}"))?;
    println!(
        "[papercusp-desktop] external-console: spawned {bin} pid={} hosting {:?} (title {:?})",
        child.id(),
        spec.command,
        spec.title,
    );
    Ok(Some(child.id()))
}

/// Run install-standalone-mcp.sh to mint a superuser token. Best-effort
/// — if the script isn't bundled (dev env), we tell the user to install
/// it manually.
async fn ensure_superuser_token() -> Result<(), String> {
    // The script's location depends on whether we're running from the
    // bundled sidecar or a dev checkout. Try a few candidates.
    let candidates: Vec<PathBuf> = ["sidecar", "../sidecar", "../../sidecar"]
        .iter()
        .map(|s| {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.join(s)))
                .unwrap_or_else(|| PathBuf::from(s))
        })
        .flat_map(|root| {
            vec![
                root.join("apps/operator/scripts/install-standalone-mcp.sh"),
                root.join("scripts/install-standalone-mcp.sh"),
            ]
        })
        .collect();

    let script = candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .ok_or_else(|| {
            "superuser-token install script not found. Run \
             apps/operator/scripts/install-standalone-mcp.sh manually."
                .to_string()
        })?;

    let out = std::process::Command::new("bash")
        .arg(&script)
        .output()
        .map_err(|e| format!("running install-standalone-mcp.sh: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "install-standalone-mcp.sh failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

// ─── macOS spawner ───────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn spawn_macos_new_window(
    _envelope: &ConsoleEnvelope,
    oneliner: &str,
) -> Result<Option<u32>, String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    // Write a one-shot .command file. `open -na Terminal.app FILE`
    // always opens a new window; AppleScript `do script` would tab
    // into the frontmost window. The .command extension makes
    // Terminal.app the default handler.
    let tmp = std::env::temp_dir().join(format!(
        "papercup-launch-{}.command",
        uuid::Uuid::new_v4().simple()
    ));
    let script = format!("#!/bin/bash\nset -e\n{}\n", oneliner);
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("create tmp script: {e}"))?;
        f.write_all(script.as_bytes())
            .map_err(|e| format!("write tmp script: {e}"))?;
    }
    let mut perms = std::fs::metadata(&tmp)
        .map_err(|e| format!("metadata: {e}"))?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&tmp, perms).map_err(|e| format!("chmod: {e}"))?;

    let default_term = detect_macos_default_terminal();
    let child = std::process::Command::new("open")
        .arg("-na")
        .arg(&default_term)
        .arg(&tmp)
        .spawn()
        .map_err(|e| format!("open -na {default_term}: {e}"))?;
    Ok(Some(child.id()))
}

#[cfg(not(target_os = "macos"))]
fn spawn_macos_new_window(
    _envelope: &ConsoleEnvelope,
    _oneliner: &str,
) -> Result<Option<u32>, String> {
    unreachable!("macOS spawner called on non-macOS build")
}

#[cfg(target_os = "macos")]
fn detect_macos_default_terminal() -> String {
    // Best-effort detection. If iTerm2 is installed, prefer it; else
    // fall back to Terminal.app which is always present on macOS.
    let iterm = PathBuf::from("/Applications/iTerm.app");
    if iterm.exists() {
        "iTerm.app".to_string()
    } else {
        "Terminal.app".to_string()
    }
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
fn detect_macos_default_terminal() -> String {
    "Terminal.app".to_string()
}

// ─── Linux spawner ───────────────────────────────────────────────────

/// Known Linux terminal emulators in preference order with the args to
/// pass right before the user's command. All entries here open a NEW
/// WINDOW when invoked (not reuse-existing-tab) — flags chosen to make
/// that explicit where the default would be ambiguous.
#[cfg(any(target_os = "linux", test))]
const LINUX_TERMINALS: &[(&str, &[&str])] = &[
    // (binary, args before our command)
    ("gnome-terminal", &["--window", "--"]),
    ("konsole", &["--new-window", "-e"]),
    ("xfce4-terminal", &["--window", "-e"]),
    ("alacritty", &["-e"]),
    ("kitty", &["--"]),
    ("wezterm", &["start", "--always-new-process", "--"]),
    ("xterm", &["-e"]),
];

/// Env vars that IDENTIFY the terminal (or multiplexer) THIS process was
/// started in. A launch's terminal identity is re-derived, never inherited.
///
/// `std::process::Command` inherits our env by default, and the desktop is
/// routinely started by `npm run dev` from inside a gnome-terminal tab — so
/// without this we hand the new emulator a `GNOME_TERMINAL_SCREEN` naming a tab
/// that no longer exists. gnome-terminal then asks the factory for that screen,
/// fails, prints `# Error creating terminal: Failed to get screen from object
/// path …`, and EXITS 0 having opened no window at all.
///
/// Kept in sync with `TERMINAL_CONTEXT_ENV_KEYS` in
/// `packages/operator-core/lib/terminal-spawn.ts`, which fixes the same defect
/// on the operator side (EI-19385011811175105).
#[cfg(any(target_os = "linux", test))]
const TERMINAL_CONTEXT_ENV_KEYS: &[&str] = &[
    // GNOME / VTE
    "GNOME_TERMINAL_SCREEN",
    "GNOME_TERMINAL_SERVICE",
    "VTE_VERSION",
    // KDE
    "KONSOLE_DBUS_SERVICE",
    "KONSOLE_DBUS_SESSION",
    "KONSOLE_DBUS_WINDOW",
    "KONSOLE_PROFILE_NAME",
    // others
    "ALACRITTY_SOCKET",
    "ALACRITTY_WINDOW_ID",
    "WEZTERM_PANE",
    "WEZTERM_UNIX_SOCKET",
    "ITERM_SESSION_ID",
    "TERM_SESSION_ID",
    "TERMINATOR_UUID",
    "TILIX_ID",
    "WINDOWID",
    // multiplexers
    "TMUX",
    "TMUX_PANE",
    "ZELLIJ",
    "ZELLIJ_SESSION_NAME",
    "ZELLIJ_PANE_ID",
    "STY",
];

/// Drop {@link TERMINAL_CONTEXT_ENV_KEYS} from `cmd`'s environment. Call AFTER
/// applying the envelope's own vars, so an inherited-or-explicit stale terminal
/// id can never survive either way.
#[cfg(target_os = "linux")]
fn strip_terminal_context_env(cmd: &mut std::process::Command) {
    for k in TERMINAL_CONTEXT_ENV_KEYS {
        cmd.env_remove(k);
    }
}

#[cfg(target_os = "linux")]
fn spawn_linux_new_window(
    envelope: &ConsoleEnvelope,
    oneliner: &str,
) -> Result<Option<u32>, String> {
    // 1. Honor $TERMINAL if user set one.
    if let Ok(term) = std::env::var("TERMINAL") {
        if is_on_path(&term) {
            return spawn_linux_with(&term, &["-e"], envelope, oneliner);
        }
    }
    // 2. Cascade through known terminals.
    for (bin, args) in LINUX_TERMINALS {
        if is_on_path(bin) {
            return spawn_linux_with(bin, args, envelope, oneliner);
        }
    }
    let tried: Vec<&str> = LINUX_TERMINALS.iter().map(|(b, _)| *b).collect();
    Err(format!(
        "no terminal emulator found. Set $TERMINAL or install one of: {}",
        tried.join(", ")
    ))
}

#[cfg(not(target_os = "linux"))]
fn spawn_linux_new_window(
    _envelope: &ConsoleEnvelope,
    _oneliner: &str,
) -> Result<Option<u32>, String> {
    unreachable!("Linux spawner called on non-Linux build")
}

#[cfg(target_os = "linux")]
fn spawn_linux_with(
    bin: &str,
    args: &[&str],
    envelope: &ConsoleEnvelope,
    oneliner: &str,
) -> Result<Option<u32>, String> {
    let mut cmd = std::process::Command::new(bin);
    cmd.current_dir(&envelope.cwd);
    for (k, v) in &envelope.env {
        if is_valid_env_name(k) {
            cmd.env(k, v);
        }
    }
    strip_terminal_context_env(&mut cmd);
    for a in args {
        cmd.arg(a);
    }
    cmd.arg("bash").arg("-lc").arg(oneliner);
    // Detach stdio so closing the operator's terminal doesn't kill the
    // user's new window.
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let child = cmd.spawn().map_err(|e| format!("spawn {bin}: {e}"))?;
    Ok(Some(child.id()))
}

/// Cheap PATH lookup. We can't pull in the `which` crate without
/// adding a dep, so this walks $PATH manually. Linux-only.
#[cfg(not(target_os = "windows"))]
fn is_on_path(bin: &str) -> bool {
    if bin.contains('/') {
        return std::path::Path::new(bin).exists();
    }
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|d| {
        let candidate = d.join(bin);
        candidate.exists()
    })
}

// ─── Windows (WSL) spawner ───────────────────────────────────────────

/// Distro name installed by wsl_setup::wsl_import (the bootstrap flow).
/// All console launches target this distro — we don't try to detect
/// the user's other distros because the operator's sidecar runs here.
#[cfg(target_os = "windows")]
const WSL_DISTRO: &str = "papercup-runtime";

/// WI-4448 — open the CHAT DOCK (`pui chat` = zellij) in its own Windows
/// Terminal window, inside the papercup-runtime distro.
///
/// The dock is the third caller of `spawn_windows_terminal_script`, and it
/// reuses it deliberately rather than hand-rolling a `wt.exe` invocation: that
/// helper already carries two hard-won Windows fixes a fresh launcher would
/// re-earn the hard way — wt splitting a one-liner on its `;`s into separate
/// TABS, and `wsl.exe` re-parsing its tail through the login shell (WI-2149) —
/// plus the conhost fallback for machines with no Windows Terminal.
///
/// `/tmp` is the script's home (not `/` or `$HOME`): it always exists and is
/// always writable by the distro's unprivileged `papercup` user, so the
/// transient launcher never fails on a permission or missing-dir edge.
#[cfg(target_os = "windows")]
pub(crate) fn spawn_windows_dock_window(oneliner: &str) -> Result<Option<u32>, String> {
    spawn_windows_terminal_script(
        "/tmp",
        "Papercup — chat dock",
        ".papercup-dock-launch.sh",
        oneliner,
    )
}

#[cfg(target_os = "windows")]
fn spawn_windows_wsl_new_window(
    envelope: &ConsoleEnvelope,
    oneliner: &str,
) -> Result<Option<u32>, String> {
    let win_title = window_title_for(&envelope.session_id);
    let script_name = format!(".papercup-console-launch.{}.sh", envelope.session_id);
    spawn_windows_terminal_script(&envelope.cwd, &win_title, &script_name, oneliner)
}

/// Shared Windows terminal-window spawner: writes `oneliner` as a transient
/// launch script inside the WSL distro at `<cwd>/<script_name>`, then opens a
/// new Windows Terminal window (bare-wsl.exe conhost fallback) running it.
/// Used by console_launch (via spawn_windows_wsl_new_window) and by
/// external_console_run (WI-3033 embedded-terminal external routing).
#[cfg(target_os = "windows")]
fn spawn_windows_terminal_script(
    cwd: &str,
    win_title: &str,
    script_name: &str,
    oneliner: &str,
) -> Result<Option<u32>, String> {
    use std::os::windows::process::CommandExt as _;

    // wt.exe splits its command line on every unescaped `;` into SEPARATE
    // TABS, and wsl.exe (without --exec) re-parses its tail through the
    // distro's default shell — two independent parsing layers that both
    // mangle a shell one-liner passed inline. Found live 2026-07-03
    // (WI-2149): wt split our one-liner at its `;`s, opened a tab titled
    // " exec " running the fragment after the last one, and the real
    // greeting/sentinel never ran. Sidestep BOTH layers: write the
    // one-liner to a transient launch script INSIDE the distro (cfs_write
    // relays via wsl.exe) and pass only a plain, quote-free path through
    // wt/wsl. The script self-deletes on start (the unlinked inode stays
    // readable for the already-running bash).
    let script_path = console_path_join(cwd, script_name);
    let script = format!(
        "#!/bin/bash\n# Transient Papercup console launcher (WI-2149) — self-deletes on start.\nrm -f -- \"$0\"\n{oneliner}\n"
    );
    cfs_write(&script_path, &script).map_err(|e| format!("write console launch script: {e}"))?;

    // Prefer Windows Terminal — `-w new` forces a new window every
    // invocation. Resolve PATH first, then known absolute Windows Terminal
    // locations. Task Scheduler commonly omits the per-user WindowsApps
    // directory from PATH even when the app-execution alias is installed, so
    // a bare `wt.exe` probe alone is not sufficient here. The resolver only
    // checks fixed roots plus a bounded direct-child package scan; it never
    // recursively walks user profiles. We deliberately DON'T pass wt
    // --startingDirectory: it
    // needs a WINDOWS path, and the only Windows view of the WSL cwd is the
    // \\wsl.localhost UNC — which is UNRELIABLE on real installs (found live
    // 2026-07-03, WI-2149: an unresolvable --startingDirectory makes wt's
    // CreateProcess FAIL, so a titled tab opens but the command never runs —
    // the exact "window appears, psu never starts" symptom). The `wsl.exe
    // --cd <cwd>` below already lands the shell in the right WSL dir, so
    // --startingDirectory was only ever cosmetic for wt's own notion of cwd.
    if let Some(wt_executable) = windows_terminal_executable() {
        let mut cmd = std::process::Command::new(&wt_executable);
        cmd.arg("-w").arg("new");
        // windows-desktop-feature-parity-2026-07-02 P-010: title the window
        // (console_launch: `Papercup — <session_id>`) so it can be found +
        // focused by TITLE later (windows-desktop-windows.ts
        // listWindowsByTitle / focusWindowByTitle, wired through
        // adv-sessions.ts's isWindowsDesktopHost() branch).
        // --title is a new-tab-command option (wt's implicit default command
        // when none is given), so it's valid alongside -w/--startingDirectory
        // here. --suppressApplicationTitle pins it so a later OSC-0/2 title
        // change from the shell (a fancy PS1, a nested app) can't clobber it
        // — MS docs: "If you change the title of a tab and want that title
        // to persist, you must enable suppressApplicationTitle."
        cmd.arg("--title").arg(win_title);
        cmd.arg("--suppressApplicationTitle");
        cmd.arg("wsl.exe")
            .arg("-d")
            .arg(WSL_DISTRO)
            .arg("--cd")
            .arg(cwd)
            .arg("--")
            .arg("bash")
            .arg("-l")
            .arg(&script_path);
        // CREATE_NEW_CONSOLE = 0x00000010 — even when wt is fronted,
        // belt-and-suspenders so we never inherit our parent's console.
        cmd.creation_flags(0x00000010);
        match cmd.spawn() {
            Ok(child) => return Ok(Some(child.id())),
            Err(e) => {
                // Windows Terminal was found but launching it FAILED — don't hard-error,
                // fall through to the bare wsl.exe conhost path below (no Windows
                // Terminal needed). The classic real-machine cause is an ORPHANED
                // WindowsApps execution alias: uninstalling the Store "Windows
                // Terminal" app leaves a 0-byte `wt.exe` reparse point in
                // %LOCALAPPDATA%\Microsoft\WindowsApps (still on PATH, so
                // the resolver sees it), whose execution fails or pops a
                // Store "how do you want to open this?" dialog. The bare-wsl.exe
                // fallback still surfaces its own error rather than hanging if WSL
                // itself is missing.
                eprintln!(
                    "[console] wt.exe at {:?} failed to spawn ({e}); \
                     falling back to bare wsl.exe conhost",
                    wt_executable
                );
            }
        }
    }

    // Fallback: direct wsl.exe in a fresh conhost. Reached when Windows
    // Terminal is absent OR present-but-unlaunchable (above). Works on
    // older Windows installs without Windows Terminal. Same launch script
    // as the wt path — wsl.exe's tail is re-parsed by the distro shell, so
    // an inline one-liner is just as unsafe here.
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.arg("-d")
        .arg(WSL_DISTRO)
        .arg("--cd")
        .arg(cwd)
        .arg("--")
        .arg("bash")
        .arg("-l")
        .arg(&script_path);
    cmd.creation_flags(0x00000010); // CREATE_NEW_CONSOLE
    let child = cmd
        .spawn()
        .map_err(|e| format!("wsl.exe spawn failed: {e}. WSL not installed?"))?;
    Ok(Some(child.id()))
}

#[cfg(not(target_os = "windows"))]
fn spawn_windows_wsl_new_window(
    _envelope: &ConsoleEnvelope,
    _oneliner: &str,
) -> Result<Option<u32>, String> {
    unreachable!("Windows spawner called on non-Windows build")
}

#[cfg(target_os = "windows")]
const WINDOWS_TERMINAL_PACKAGE_PREFIX: &str = "Microsoft.WindowsTerminal_";
#[cfg(any(target_os = "windows", test))]
const WINDOWS_TERMINAL_EXECUTABLE: &str = "wt.exe";
// WindowsApps is normally small, but keep the fallback bounded even if a
// machine has an unusually large package directory. The direct scan is only
// needed for machine-installed packages whose versioned directory is unknown.
#[cfg(target_os = "windows")]
const MAX_WINDOWS_TERMINAL_PACKAGE_SCAN_ENTRIES: usize = 128;

/// Return the first regular file in a candidate list. This is deliberately a
/// small, platform-neutral helper so the PATH-poor scheduled-task regression
/// can be tested on Linux without compiling or mocking Win32 APIs.
#[cfg(any(target_os = "windows", test))]
fn first_existing_file<I>(candidates: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/// Prefer the normal PATH resolution, but fall back to known absolute paths.
/// Keeping the two phases explicit prevents an absent WindowsApps PATH entry
/// from being mistaken for an uninstalled Windows Terminal.
#[cfg(any(target_os = "windows", test))]
fn resolve_existing_windows_terminal<P, K>(
    path_candidates: P,
    known_candidates: K,
) -> Option<PathBuf>
where
    P: IntoIterator<Item = PathBuf>,
    K: IntoIterator<Item = PathBuf>,
{
    first_existing_file(path_candidates).or_else(|| first_existing_file(known_candidates))
}

/// Build fixed, non-recursive Windows Terminal locations. The per-user
/// execution alias is the important scheduled-task path; the machine roots
/// cover installations where the alias is absent or disabled.
#[cfg(any(target_os = "windows", test))]
fn windows_terminal_known_candidates(
    local_app_data: Option<&std::path::Path>,
    program_file_roots: &[&std::path::Path],
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(local_app_data) = local_app_data {
        candidates.push(
            local_app_data
                .join("Microsoft")
                .join("WindowsApps")
                .join(WINDOWS_TERMINAL_EXECUTABLE),
        );
    }
    for root in program_file_roots {
        candidates.push(root.join("WindowsApps").join(WINDOWS_TERMINAL_EXECUTABLE));
        candidates.push(
            root.join("Microsoft")
                .join("WindowsApps")
                .join(WINDOWS_TERMINAL_EXECUTABLE),
        );
    }
    candidates
}

#[cfg(target_os = "windows")]
fn append_windows_terminal_package_candidates(
    windows_apps_root: &std::path::Path,
    candidates: &mut Vec<PathBuf>,
) {
    let Ok(entries) = std::fs::read_dir(windows_apps_root) else {
        return;
    };

    let mut package_dirs = entries
        .take(MAX_WINDOWS_TERMINAL_PACKAGE_SCAN_ENTRIES)
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            name.to_string_lossy()
                .starts_with(WINDOWS_TERMINAL_PACKAGE_PREFIX)
                .then_some(entry.path())
        })
        .collect::<Vec<_>>();
    // Package names contain the version, so descending lexical order selects
    // the newest-looking installed package without invoking PowerShell or
    // recursively traversing the WindowsApps tree.
    package_dirs.sort_by(|left, right| {
        let left = left
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let right = right
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        right.cmp(&left)
    });
    candidates.extend(
        package_dirs
            .into_iter()
            .map(|package_dir| package_dir.join(WINDOWS_TERMINAL_EXECUTABLE)),
    );
}

#[cfg(target_os = "windows")]
fn windows_terminal_executable() -> Option<PathBuf> {
    let path_candidates = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|directory| directory.join(WINDOWS_TERMINAL_EXECUTABLE))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let mut program_file_roots = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(|name| std::env::var_os(name).map(PathBuf::from))
        .collect::<Vec<_>>();
    program_file_roots.sort();
    program_file_roots.dedup();
    let program_file_root_refs = program_file_roots
        .iter()
        .map(|root| root.as_path())
        .collect::<Vec<_>>();

    let mut known_candidates =
        windows_terminal_known_candidates(local_app_data.as_deref(), &program_file_root_refs);
    for root in &program_file_roots {
        append_windows_terminal_package_candidates(
            &root.join("WindowsApps"),
            &mut known_candidates,
        );
    }
    // Environment variables are expected to be absolute on Windows. Keep the
    // fallback honest if a hostile/test environment supplies a relative one.
    known_candidates.retain(|candidate| candidate.is_absolute());

    resolve_existing_windows_terminal(path_candidates, known_candidates)
}

// ─── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(cwd: &str) -> ConsoleEnvelope {
        let mut env = HashMap::new();
        env.insert("PAPERCUSP_HARNESS_SLUG".to_string(), "sheets".to_string());
        env.insert("PAPERCUSP_WORKSPACE".to_string(), "default".to_string());
        env.insert(
            "PAPERCUSP_SCRIPTS_DIR".to_string(),
            "/path/to/scripts".to_string(),
        );
        ConsoleEnvelope {
            cwd: cwd.to_string(),
            env,
            mcp_json_contents: "{}".to_string(),
            greeting_cmd: "papercup status".to_string(),
            needs_superuser_bootstrap: false,
            session_id: "test-session-id".to_string(),
        }
    }

    #[cfg(unix)]
    fn interactive_rc_script(oneliner: &str) -> String {
        let marker = "--rcfile <(printf '%s\\n' ";
        let (_, encoded) = oneliner
            .split_once(marker)
            .expect("interactive rcfile marker missing");
        let encoded = encoded
            .strip_suffix(") -i")
            .expect("interactive rcfile suffix missing");
        let output = std::process::Command::new("bash")
            .args(["-c", &format!("printf '%s' {encoded}")])
            .output()
            .expect("decode interactive rcfile");
        assert!(output.status.success(), "rcfile literal did not decode");
        String::from_utf8(output.stdout).expect("rcfile is UTF-8")
    }

    #[test]
    fn oneliner_includes_cwd_env_greeting_and_exec() {
        let e = envelope("/some/harness/dir");
        let out = build_launcher_oneliner(&e);
        #[cfg(unix)]
        let script = interactive_rc_script(&out);
        assert!(out.contains("cd '/some/harness/dir'"));
        assert!(out.contains("export PAPERCUSP_HARNESS_SLUG='sheets'"));
        assert!(out.contains("export PAPERCUSP_WORKSPACE='default'"));
        #[cfg(unix)]
        assert!(script.contains("(eval 'papercup status')"));
        #[cfg(unix)]
        assert!(script.contains("exec \"${SHELL:-/bin/bash}\" -l"));
    }

    /// A greeting containing single quotes (e.g. fleet:launch-on-plan's
    /// shq()-quoted launch-context) must survive as an escaped literal — the
    /// pre-fix bare `replace('\'', "'\\''")` produced an unparseable one-liner
    /// (macOS Terminal: `unexpected EOF while looking for matching "'"`).
    #[test]
    fn oneliner_keeps_quoted_greeting_parseable() {
        let mut e = envelope("/x");
        e.greeting_cmd = "psu --context='it'\\''s quoted' --plan=p1".to_string();
        let out = build_launcher_oneliner(&e);
        #[cfg(unix)]
        let script = interactive_rc_script(&out);
        #[cfg(unix)]
        assert!(
            script.contains(&format!("(eval {})", shell_escape_single(&e.greeting_cmd))),
            "greeting not carried as a shell-escaped eval literal: {out}"
        );
        // The real proof: bash itself must parse the one-liner (`bash -n`
        // compiles without executing). This is exactly what failed pre-fix.
        #[cfg(unix)]
        {
            let status = std::process::Command::new("bash")
                .args(["-n", "-c", &out])
                .status()
                .expect("spawn bash -n");
            assert!(status.success(), "bash cannot parse the one-liner: {out}");
        }
    }

    #[test]
    fn window_title_uses_em_dash_prefix() {
        // Shared contract with windows-desktop-windows.ts's title lookup —
        // don't change this format without updating that helper +
        // adv-sessions.ts's win32 branch in the same change.
        assert_eq!(window_title_for("abc-123"), "Papercup — abc-123");
    }

    #[test]
    fn oneliner_emits_osc0_title_escape() {
        let e = envelope("/x");
        let out = build_launcher_oneliner(&e);
        assert!(
            out.contains("printf '\\033]0;%s\\007' 'Papercup — test-session-id'"),
            "OSC-0 title escape missing or malformed: {out}"
        );
    }

    #[test]
    fn oneliner_drops_sentinel_with_trap() {
        let e = envelope("/x");
        let out = build_launcher_oneliner(&e);
        #[cfg(unix)]
        let script = interactive_rc_script(&out);
        // Writes the kernel-backed process identity to a sentinel whose shell
        // pid suffix is expanded ($$ → <pid>, not a literal $).
        assert!(
            out.contains("PAPERCUSP_CONSOLE_IDENTITY=\"$(")
                && out.contains("export PAPERCUSP_CONSOLE_IDENTITY")
                && out.contains("> .papercup-console-active.$$"),
            "sentinel identity stamp missing or has a literal (unexpanded) $ suffix: {out}"
        );
        // trap fires on EXIT to clean up
        #[cfg(unix)]
        assert!(
            script.contains("trap 'rm -f .papercup-console-active.$$' EXIT"),
            "EXIT trap missing or has a literal (unexpanded) $ suffix: {out}"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn oneliner_exports_the_current_shell_birth_identity() {
        let tmp = std::env::temp_dir().join(format!(
            "papercusp-console-identity-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut e = envelope(tmp.to_str().unwrap());
        e.env.insert("SHELL".to_string(), "/bin/true".to_string());
        e.greeting_cmd = "expected=\"linux:$(cat /proc/sys/kernel/random/boot_id):$(awk '{print $22}' /proc/$$/stat)\"; test \"$PAPERCUSP_CONSOLE_IDENTITY\" = \"$expected\" && printf ok > identity-check"
            .to_string();

        let out = build_launcher_oneliner(&e);
        let status = std::process::Command::new("bash")
            .args(["-c", &out])
            .status()
            .expect("run launcher identity probe");
        assert!(status.success(), "launcher identity probe failed: {out}");
        assert_eq!(
            std::fs::read_to_string(tmp.join("identity-check")).unwrap(),
            "ok"
        );
        std::fs::remove_dir_all(tmp).ok();
    }

    #[test]
    fn scripts_dir_prepended_to_path() {
        let e = envelope("/x");
        let out = build_launcher_oneliner(&e);
        assert!(out.contains("export PATH='/path/to/scripts':${PATH}"));
    }

    #[test]
    fn bin_dir_prepended_before_scripts_dir() {
        // psu-in-desktop-builds-2026-06-23 A2b: ~/.papercusp/bin (the psu/ptool
        // shims) goes on PATH ahead of the bundled scripts dir, so `psu` is
        // runnable and a user shim wins over a same-named bundled script.
        let mut e = envelope("/x");
        e.env.insert(
            "PAPERCUSP_BIN_DIR".to_string(),
            "/home/u/.papercusp/bin".to_string(),
        );
        let out = build_launcher_oneliner(&e);
        assert!(
            out.contains("export PATH='/home/u/.papercusp/bin':'/path/to/scripts':${PATH}"),
            "bin dir not prepended ahead of scripts dir: {out}"
        );
    }

    #[test]
    fn shell_escape_handles_embedded_quotes() {
        assert_eq!(shell_escape_single("simple"), "'simple'");
        assert_eq!(shell_escape_single("a b"), "'a b'");
        assert_eq!(shell_escape_single("it's"), "'it'\\''s'");
    }

    #[test]
    fn windows_terminal_resolution_falls_back_to_user_alias_without_path() {
        // Task Scheduler may omit `%LOCALAPPDATA%\\Microsoft\\WindowsApps`
        // from PATH even though its wt.exe app-execution alias is installed.
        // Keep this regression guard platform-neutral so it runs in the
        // normal Linux-focused test suite as well as the Windows cfg build.
        let root = std::env::temp_dir().join(format!(
            "papercusp-wt-resolver-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let local_app_data = root.join("local-app-data");
        let alias = local_app_data
            .join("Microsoft")
            .join("WindowsApps")
            .join(WINDOWS_TERMINAL_EXECUTABLE);
        std::fs::create_dir_all(alias.parent().unwrap()).unwrap();
        std::fs::write(&alias, b"windows-terminal-alias").unwrap();

        let missing_path_candidate = root.join("path-without-wt").join("wt.exe");
        let known_candidates =
            windows_terminal_known_candidates(Some(local_app_data.as_path()), &[]);
        let selected =
            resolve_existing_windows_terminal(vec![missing_path_candidate], known_candidates);

        assert_eq!(selected, Some(alias.clone()));
        assert!(selected.unwrap().is_absolute());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn windows_terminal_resolution_prefers_path_before_absolute_fallback() {
        let root = std::env::temp_dir().join(format!(
            "papercusp-wt-resolution-order-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let path_hit = root.join("path").join("wt.exe");
        let absolute_fallback = root
            .join("local-app-data")
            .join("Microsoft")
            .join("WindowsApps")
            .join("wt.exe");
        std::fs::create_dir_all(path_hit.parent().unwrap()).unwrap();
        std::fs::create_dir_all(absolute_fallback.parent().unwrap()).unwrap();
        std::fs::write(&path_hit, b"path-wt").unwrap();
        std::fs::write(&absolute_fallback, b"fallback-wt").unwrap();

        let selected =
            resolve_existing_windows_terminal(vec![path_hit.clone()], vec![absolute_fallback]);

        assert_eq!(selected, Some(path_hit));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn missing_path_err_detects_vanished_source() {
        // WI-3360: the .mcp.json backup must treat a raced-away source as
        // "nothing to back up", not a hard launch failure. These are the
        // real error strings cfs_rename surfaces on each platform.
        assert!(is_missing_path_err(
            "wsl.exe exit 1; stderr: mv: cannot stat '/home/papercup/.papercusp/.mcp.json': No such file or directory"
        ));
        assert!(is_missing_path_err(
            "No such file or directory (os error 2)"
        ));
        assert!(is_missing_path_err(
            "The system cannot find the file specified. (os error 2)"
        ));
        // A genuine permission / disk error must STILL abort the launch.
        assert!(!is_missing_path_err("Permission denied (os error 13)"));
        assert!(!is_missing_path_err("No space left on device"));
    }

    #[test]
    fn invalid_env_names_are_filtered() {
        let mut env = HashMap::new();
        env.insert("GOOD_NAME".to_string(), "v".to_string());
        env.insert("123BAD".to_string(), "v".to_string());
        env.insert("BAD-DASH".to_string(), "v".to_string());
        let out = build_env_exports(&env);
        assert!(out.contains("export GOOD_NAME="));
        assert!(!out.contains("123BAD"));
        assert!(!out.contains("BAD-DASH"));
    }

    #[test]
    fn external_oneliner_exports_env_quotes_args_and_holds_on_failure() {
        // WI-3033: the onboarding concierge spec — a node script under a
        // /mnt/c path WITH SPACES, plus the operator URL env the pty path
        // used to drop.
        let mut env = HashMap::new();
        env.insert(
            "PAPERCUSP_OPERATOR_URL".to_string(),
            "http://127.0.0.1:49213".to_string(),
        );
        let spec = ExternalConsoleSpec {
            command: "/usr/local/bin/node".to_string(),
            args: vec![
                "/mnt/c/Users/User/AppData/Local/Papercusp Server/sidecar/scripts/onboard.mjs"
                    .to_string(),
            ],
            cwd: "/home/papercup".to_string(),
            env,
            title: "Papercusp Onboarding".to_string(),
        };
        let out = build_external_oneliner(&spec);
        assert!(
            out.contains("printf '\\033]0;%s\\007' 'Papercusp Onboarding'"),
            "OSC-0 title missing: {out}"
        );
        assert!(out.contains("cd '/home/papercup'"), "cd missing: {out}");
        assert!(
            out.contains("export PAPERCUSP_OPERATOR_URL='http://127.0.0.1:49213'"),
            "operator URL export missing: {out}"
        );
        assert!(
            out.contains(
                "'/usr/local/bin/node' '/mnt/c/Users/User/AppData/Local/Papercusp Server/sidecar/scripts/onboard.mjs'"
            ),
            "command + space-path arg not single-quoted: {out}"
        );
        assert!(
            out.contains("read -r _"),
            "hold-window-open on failure missing: {out}"
        );
    }

    #[test]
    fn external_oneliner_omits_exports_segment_when_env_empty() {
        let spec = ExternalConsoleSpec {
            command: "htop".to_string(),
            args: vec![],
            cwd: "/tmp".to_string(),
            env: HashMap::new(),
            title: "T".to_string(),
        };
        let out = build_external_oneliner(&spec);
        assert!(
            out.contains("cd '/tmp' && 'htop'"),
            "empty env must not leave a dangling `&&  &&` segment: {out}"
        );
        assert!(!out.contains("export "), "no exports expected: {out}");
    }

    #[test]
    fn linux_table_entries_are_well_formed() {
        // Every entry must (a) have a non-empty binary name, (b) have
        // at least one trailing arg so the user's command is positional
        // and not interpreted as an option to the terminal itself.
        for (bin, args) in LINUX_TERMINALS {
            assert!(!bin.is_empty(), "empty binary in LINUX_TERMINALS");
            assert!(
                !args.is_empty(),
                "{bin} has no trailing args — would pass user command as flag"
            );
        }
    }

    #[test]
    fn count_sentinels_finds_only_matching_files() {
        let tmp =
            std::env::temp_dir().join(format!("papercup-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&tmp).unwrap();
        let tmp_s = tmp.to_str().unwrap();
        // None yet.
        assert_eq!(count_sentinels(tmp_s), 0);
        // Drop two sentinels + an unrelated file.
        std::fs::write(tmp.join(".papercup-console-active.123"), "").unwrap();
        std::fs::write(tmp.join(".papercup-console-active.456"), "").unwrap();
        std::fs::write(tmp.join("README.md"), "").unwrap();
        assert_eq!(count_sentinels(tmp_s), 2);
        // Remove one.
        std::fs::remove_file(tmp.join(".papercup-console-active.123")).unwrap();
        assert_eq!(count_sentinels(tmp_s), 1);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn linux_table_covers_common_terminals() {
        let bins: Vec<&str> = LINUX_TERMINALS.iter().map(|(b, _)| *b).collect();
        for must_have in &[
            "gnome-terminal",
            "konsole",
            "alacritty",
            "kitty",
            "wezterm",
            "xterm",
        ] {
            assert!(
                bins.contains(must_have),
                "{must_have} missing from LINUX_TERMINALS"
            );
        }
    }

    // EI-19385011811175105: inheriting the launching tab's GNOME_TERMINAL_SCREEN
    // made gnome-terminal exit 0 with no window at all. Both Linux spawners must
    // strip it, and must NOT strip what a window actually needs to open.
    #[test]
    fn terminal_context_env_keys_cover_the_tab_identity_vars() {
        for must_have in &[
            "GNOME_TERMINAL_SCREEN",
            "GNOME_TERMINAL_SERVICE",
            "TMUX",
            "ZELLIJ",
            "WINDOWID",
        ] {
            assert!(
                TERMINAL_CONTEXT_ENV_KEYS.contains(must_have),
                "{must_have} missing from TERMINAL_CONTEXT_ENV_KEYS"
            );
        }
        for must_keep in &[
            "DISPLAY",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_RUNTIME_DIR",
            "XAUTHORITY",
            "PATH",
            "HOME",
            "TERM",
        ] {
            assert!(
                !TERMINAL_CONTEXT_ENV_KEYS.contains(must_keep),
                "{must_keep} must NOT be scrubbed — the new window needs it"
            );
        }
    }

    #[test]
    fn decode_wsl_bytes_utf8_utf16_and_empty() {
        // Empty → empty (no panic on the sampling logic).
        assert_eq!(decode_wsl_bytes(b""), "");
        // Plain UTF-8 (a relayed bash command's stderr).
        assert_eq!(
            decode_wsl_bytes(b"bash: cannot create file\n"),
            "bash: cannot create file"
        );
        // UTF-16LE WITH BOM — wsl.exe's own diagnostics look like this.
        let mut bom = vec![0xFFu8, 0xFE];
        for u in "no distribution".encode_utf16() {
            bom.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_wsl_bytes(&bom), "no distribution");
        // UTF-16LE WITHOUT BOM — ASCII gives a NUL every other byte, detected by
        // the interleaved-NUL heuristic (the exact "blank error" case WI-2955).
        let mut nobom = Vec::new();
        for u in "The system cannot find the path specified.".encode_utf16() {
            nobom.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(
            decode_wsl_bytes(&nobom),
            "The system cannot find the path specified."
        );
    }
}
