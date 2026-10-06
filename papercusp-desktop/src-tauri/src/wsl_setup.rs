// WSL2 onboarding for Windows.
//
// On Windows, papercup runs inside a WSL2 distro because the harness
// stack assumes POSIX (bash scripts, overmind, unix sockets, fs.watch
// semantics). Rather than make users manually `wsl --install`, this
// module drives the install + bootstrap from inside the desktop app.
//
// Lifecycle (state machine, persisted to app-local-data/wsl-state.json):
//
//   NotSupported  ── platform not Windows, or wsl.exe missing.
//   NotInstalled  ── `wsl.exe` not present or `wsl --status` errors.
//                    User clicks Install → we run `wsl --install`,
//                    transition to PendingReboot.
//   PendingReboot ── WSL kernel installed, distro install pending reboot.
//                    Persisted across launches; on next launch we check
//                    if reboot has happened and transition.
//   InstalledNoDistro ── WSL works but no `papercup-runtime` distro.
//                    Run `wsl --import` from the bundled rootfs tarball.
//   PendingBootstrap ── Distro exists, papercup setup hasn't run inside
//                    yet. Run the bootstrap script.
//   Ready         ── Everything's good. Sidecar can spawn into WSL.
//   Error         ── A step failed. Frontend surfaces the message + retry.
//
// All shelling out goes through std::process::Command; output is captured
// and returned to the frontend as structured data (no TTY parsing).
//
// Types + commands always compile so the Specta bindings are stable
// across platforms; the actual implementations are #[cfg]'d to Windows.
// On non-Windows the commands return WslState::NotSupported / errors.

use serde::{Deserialize, Serialize};
use specta::Type;

#[cfg(any(target_os = "windows", test))]
#[path = "wsl_runtime_resources.rs"]
mod runtime_resources;

// Distro name we register via `wsl --import`. Custom name avoids
// colliding with a user's existing Ubuntu distro and lets us cleanly
// uninstall on user request. (`test` included so the pure shim-content
// helpers below are unit-testable from Linux.)
#[cfg(any(target_os = "windows", test))]
const DISTRO_NAME: &str = "papercup-runtime";

/// Public version of DISTRO_NAME — used by main.rs when constructing
/// `wsl.exe --distribution …` to spawn the sidecar inside the runtime.
#[cfg(target_os = "windows")]
pub const DISTRO_NAME_PUB: &str = DISTRO_NAME;

/// Whether the sidecar is being routed through WSL this session — set once
/// by setup() (from `should_route_via_wsl`) so AppHandle-less call sites
/// (the native pty spawn) can route their commands into the distro too.
static WSL_ROUTE_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_route_active(active: bool) {
    WSL_ROUTE_ACTIVE.store(active, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(any(target_os = "windows", test))]
pub fn detect_ready_cached() -> bool {
    WSL_ROUTE_ACTIVE.load(std::sync::atomic::Ordering::Relaxed)
}

// Filename of the rootfs tarball shipped as a Tauri resource. Built in
// CI by running our bootstrap script inside an Ubuntu container then
// `tar -czf papercup-runtime.tar.gz /`. See
// `papercusp-desktop/scripts/build-rootfs.sh` (TODO).
#[cfg(target_os = "windows")]
const ROOTFS_FILENAME: &str = "papercup-runtime.tar.gz";

// Written beside the tarball by scripts/build-rootfs.sh: the fingerprint of the
// recipe that produced the SHIPPED rootfs, and the bootstrap that recipe runs.
#[cfg(any(target_os = "windows", test))]
const ROOTFS_RECIPE_FILENAME: &str = "papercup-rootfs-recipe";
#[cfg(target_os = "windows")]
const ROOTFS_BOOTSTRAP_FILENAME: &str = "papercup-bootstrap.sh";

/// Does the distro need re-provisioning before it can be trusted?
///
/// `shipped` is the recipe fingerprint of the rootfs in THIS build; `provisioned`
/// is the one recorded when the distro was last bootstrapped. They diverge when a
/// user updates the app: the new build carries a new rootfs recipe, but the distro
/// on disk was imported by an older one and — until this check existed — was
/// trusted forever, because a distro that exists and starts looks Ready.
///
/// Unknown (`None`) means an install that predates this marker, so we cannot show
/// the distro matches. Treat that as stale: re-running the bootstrap is idempotent
/// and cheap, while trusting it is how the rootfs half of a fix silently never
/// ships. Fail toward doing the work.
#[cfg(any(target_os = "windows", test))]
fn distro_needs_reprovision(shipped: Option<&str>, provisioned: Option<&str>) -> bool {
    match (shipped, provisioned) {
        // We don't know what we shipped — cannot justify re-provisioning on every
        // launch, and re-running blind would loop forever with nothing to record.
        (None, _) => false,
        (Some(_), None) => true,
        (Some(want), Some(have)) => want.trim() != have.trim(),
    }
}

/// Hosts the shipped bootstrap MUST reach before it can provision anything
/// (EI-20574262390154687).
///
/// Deliberately in lockstep with `resources/papercup-bootstrap.sh` — every host
/// that script downloads from appears here, and a test below fails if the two
/// ever drift apart.
///
/// `apt` mirrors are deliberately NOT listed. They are baked into the rootfs and
/// are only knowable from INSIDE the distro, so the bootstrap's own preflight
/// probes those against the image's real sources. Guessing a mirror here would
/// let this check block an install that would otherwise have worked, and a false
/// block is a worse regression than the confusing failure this replaces.
#[cfg(any(target_os = "windows", test))]
const BOOTSTRAP_NETWORK_HOSTS: &[(&str, u16, &str)] = &[
    ("github.com", 443, "the overmind process supervisor"),
    ("kopia.io", 443, "the kopia signing key"),
    (
        "packages.kopia.io",
        80,
        "the kopia apt repository (backup engine)",
    ),
    ("nodejs.org", 443, "the pinned Node runtime"),
];

/// Render the user-facing failure for a set of unreachable hosts, or `None` when
/// everything is reachable and provisioning may proceed.
///
/// Kept pure and separate from the probe on purpose. The probe can only run on
/// Windows, but this DECISION — including "empty means proceed" — is pinned from
/// Linux by the tests below, exactly like `distro_needs_reprovision` above.
///
/// THE bug this addresses: the bootstrap apt-installs and then downloads three
/// pinned binaries, so on a machine that is offline, behind a strict proxy, or
/// on a network blocking any one of those hosts, provisioning failed PARTWAY
/// THROUGH — after the Windows installer had already reported success and
/// written its uninstall entry — surfacing a raw curl/apt error from inside a
/// WSL distro. The user could not tell which host was unreachable, or that the
/// network was the problem at all.
#[cfg(any(target_os = "windows", test))]
fn bootstrap_network_failure(unreachable: &[(&str, u16, &str)]) -> Option<String> {
    if unreachable.is_empty() {
        return None;
    }
    let mut msg = String::from(
        "Papercup cannot finish setting up because the network is unreachable.\n\n\
         Setting up the papercup runtime downloads system packages and three pinned \
         binaries, so it cannot run offline. These are unreachable from this machine:\n",
    );
    for (host, _port, purpose) in unreachable {
        msg.push_str(&format!("  - {host} — needed for {purpose}\n"));
    }
    msg.push_str(
        "\nNothing has been installed yet: setup stopped before importing the runtime, \
         so simply launch Papercup again once this is fixed.\n\n\
         Fix: connect this machine to the internet, or allow the hosts above through \
         your proxy or firewall, then relaunch.\n\n\
         If you believe this check is wrong — for example an HTTP proxy that only \
         accepts CONNECT, which a plain TCP probe cannot see — set \
         PAPERCUP_SKIP_NETWORK_PREFLIGHT=1 to skip it.",
    );
    Some(msg)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind")]
pub enum WslState {
    /// Not on Windows; nothing to do.
    ///
    /// Note: NO `rename_all = "camelCase"` here. The frontend
    /// (apps/operator/lib/wsl-tauri.ts) and the WslOnboardingGate
    /// component check `state.kind === 'NotSupported' | 'NotInstalled'
    /// | …` in PascalCase. Adding camelCase here makes the gate's
    /// pass-through check fail on Linux — the wizard then shows on
    /// machines that should never see it.
    NotSupported,
    /// `wsl.exe` not on PATH, or `wsl --status` errored.
    NotInstalled,
    /// User has launched the install but reboot hasn't happened yet.
    PendingReboot,
    /// WSL works, but our papercup-runtime distro hasn't been imported.
    InstalledNoDistro,
    /// Distro exists, papercup bootstrap hasn't run.
    PendingBootstrap,
    /// Ready to use.
    Ready,
    /// Something went wrong. `message` carries detail; frontend shows a
    /// retry button.
    Error { message: String },
}

/// Typed error for the install commands. Frontend uses the variant tag
/// to decide whether to re-launch with elevation, retry, or show a
/// generic error.
// Same PascalCase-tag rule as WslState above — the frontend matches
// on `err.kind === 'NeedsElevation' | 'Failed'`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "message")]
pub enum WslOpError {
    /// `wsl --install` returned 740 (ERROR_ELEVATION_REQUIRED). User
    /// must re-launch the app with admin privileges. Message is the
    /// stderr we got back, mostly for diagnostics.
    NeedsElevation(String),
    /// Generic failure — exit code + stderr.
    Failed(String),
}

impl WslOpError {
    #[cfg(target_os = "windows")]
    fn from_exit(label: &str, code: Option<i32>, stderr: String) -> Self {
        // Win32 ERROR_ELEVATION_REQUIRED = 740. wsl.exe forwards this
        // when a sub-step (DISM, optional component install) needs
        // elevation we don't have.
        if code == Some(740) {
            return WslOpError::NeedsElevation(format!("{}: {}", label, stderr));
        }
        WslOpError::Failed(format!(
            "{} exit={} stderr={}",
            label,
            code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
            stderr
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WslStatus {
    pub state: WslState,
    /// `true` if `wsl.exe` exists on PATH at all (regardless of version
    /// / install state).
    pub wsl_exe_available: bool,
    /// Listed via `wsl --list --quiet`. Empty before WSL is installed.
    pub distros: Vec<String>,
    /// Default WSL version (1 or 2). 0 if unknown.
    pub default_version: u8,
}

impl WslStatus {
    #[cfg(any(not(target_os = "windows"), test))]
    fn unsupported() -> Self {
        Self {
            state: WslState::NotSupported,
            wsl_exe_available: false,
            distros: vec![],
            default_version: 0,
        }
    }
}

/// Parse the default WSL major version out of `wsl --status` output.
///
/// The "Default Version: 2" label is locale-dependent, so no English text is
/// matched: this takes the LAST line whose value — the segment after the
/// final `:`, or the whole line when there is no `:` — trims to a bare
/// integer. Distro names (`Ubuntu-18.04`), kernel versions (`5.15.133.1-1`)
/// and WSL build versions (`2.0.9.0`) never parse as a bare integer, so they
/// can't shadow the version line. (The previous implementation took the
/// FIRST ASCII digit anywhere in the output, so a digit-bearing
/// `Default Distribution:` line above the version line — e.g. Ubuntu-18.04 —
/// made it report version 1.)
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn parse_default_version(status_output: &str) -> u8 {
    status_output
        .lines()
        .filter_map(|line| {
            line.rsplit(':')
                .next()
                .unwrap_or(line)
                .trim()
                .parse::<u8>()
                .ok()
        })
        .next_back()
        .unwrap_or(0)
}

/// Decode wsl.exe's own output (--list, --status, error messages).
///
/// The Store/MSI WSL honors `WSL_UTF8=1`; the INBOX (Windows-feature) WSL
/// ignores it and emits UTF-16-LE to pipes. Found live 2026-06-11: on an
/// inbox-WSL Win11, `--list --quiet` decoded via from_utf8_lossy yields
/// `"U\0b\0u\0n\0t\0u\0…"`, so the distro name never matches and detect()
/// reports InstalledNoDistro forever. Sniff the encoding instead of
/// trusting the env var: real UTF-16-LE ASCII text has a NUL high byte at
/// every odd index; UTF-8 output never contains NULs.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn decode_wsl_output(raw: &[u8]) -> String {
    let looks_utf16 = raw.len() >= 2
        && (raw.starts_with(&[0xFF, 0xFE]) || raw.iter().skip(1).step_by(2).any(|&b| b == 0));
    if looks_utf16 {
        let units: Vec<u16> = raw
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let s = String::from_utf16_lossy(&units);
        s.strip_prefix('\u{FEFF}').unwrap_or(&s).to_string()
    } else {
        String::from_utf8_lossy(raw).into_owned()
    }
}

#[cfg(test)]
mod decode_tests {
    use super::decode_wsl_output;

    #[test]
    fn utf16le_list_output_decodes() {
        // "Ubuntu\r\npapercup-runtime\r\n" as UTF-16-LE, as inbox WSL emits.
        let text = "Ubuntu\r\npapercup-runtime\r\n";
        let raw: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let decoded = decode_wsl_output(&raw);
        let names: Vec<&str> = decoded
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        assert_eq!(names, vec!["Ubuntu", "papercup-runtime"]);
    }

    #[test]
    fn utf16le_with_bom_decodes() {
        let text = "\u{FEFF}Default Version: 2\r\n";
        let raw: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decode_wsl_output(&raw), "Default Version: 2\r\n");
    }

    #[test]
    fn utf8_output_passes_through() {
        assert_eq!(
            decode_wsl_output(b"Ubuntu\npapercup-runtime\n"),
            "Ubuntu\npapercup-runtime\n"
        );
        assert_eq!(decode_wsl_output(b""), "");
    }
}

// ─── Windows implementation ─────────────────────────────────────────

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    #[derive(Debug, Clone, Serialize, Deserialize, Default)]
    struct PersistedState {
        install_kicked_off: bool,
        bootstrapped: bool,
        /// Fingerprint of the rootfs recipe that provisioned this distro
        /// (`resources/papercup-rootfs-recipe`, written by scripts/build-rootfs.sh).
        ///
        /// Without it, a distro imported once is trusted forever: `detect()` sees
        /// a distro that exists and starts, returns Ready, and never asks what is
        /// INSIDE it. So a fix to the rootfs recipe reaches new installs only —
        /// every existing user updates the app and keeps a distro provisioned by
        /// the old recipe. That is how the Windows chat dock would have shipped
        /// "fixed" and still opened onto a dead `pui` for everyone who already
        /// had the app.
        ///
        /// Absent (older installs, or state we never wrote) ⇒ unknown ⇒ treated as
        /// stale, which re-runs the idempotent bootstrap. Failing toward
        /// re-provisioning is the safe direction: the cost is one bootstrap run,
        /// the cost of the other direction is a silently broken distro.
        #[serde(default)]
        rootfs_recipe: Option<String>,
        /// Legacy cross-process guard for post-onboarding finalize restarts,
        /// keyed per bundle role. The GUI no longer restarts: `gui_setup` waits
        /// for WSL Ready and then attaches its existing window to the Server.
        /// Keep the persisted GUI field readable for existing state files; its
        /// restart path is disabled because the GUI still owns its single-instance
        /// lock while the gate is running. The Server flag remains for the legacy
        /// Server restart fallback.
        #[serde(default)]
        gui_finalize_restart_done: bool,
        #[serde(default)]
        server_finalize_restart_done: bool,
    }

    fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        // SHARED across the GUI + Server bundles. wsl-state.json carries the
        // `bootstrapped` flag; the headless Server OWNS the sidecar and reads it,
        // but onboarding is driven in the GUI. app_local_data_dir() is PER-BUNDLE
        // (identifiers com.papercusp.gui vs com.papercusp.server), so each bundle
        // got its OWN file — the Server never saw the GUI's onboarding and sat at
        // PendingBootstrap forever, never spawning the sidecar. Windows-only:
        // mac/linux have no WSL onboarding, so the split-state bug was never
        // exercised there. Store it in the shared data dir both bundles resolve
        // identically. (2026-07-02 Windows GUI/Server-split parity fix.)
        let _ = app;
        let dir = crate::workspaces::shared_data_dir();
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
        Ok(dir.join("wsl-state.json"))
    }

    fn load_state(app: &tauri::AppHandle) -> PersistedState {
        state_path(app)
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save_state(app: &tauri::AppHandle, st: &PersistedState) -> Result<(), String> {
        let p = state_path(app)?;
        let s = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
        std::fs::write(&p, s).map_err(|e| format!("write {}: {}", p.display(), e))?;
        Ok(())
    }

    pub fn distro_install_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        use tauri::Manager;
        let dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("app_local_data_dir: {}", e))?
            .join("wsl-distro");
        std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {}", e))?;
        Ok(dir)
    }

    fn wsl_command() -> Command {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (0x0800_0000): the packaged GUI + Server processes are
        // console-less (the GUI is launched via `start`; the Server via
        // launch_bundle's DETACHED_PROCESS). wsl.exe spawned from a console-less
        // parent WITHOUT this flag intermittently returns empty/failure — which
        // made detect() report NotInstalled / distros:[] on a machine where WSL is
        // installed AND warm, kicking off the defer→finalize→respawn window-cascade
        // loop (WI-2749). The working sidecar path (make_sidecar_command) already
        // sets it; align the management commands here so detect() is reliable.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = Command::new("wsl.exe");
        c.creation_flags(CREATE_NO_WINDOW);
        // wsl.exe by default emits UTF-16-LE; force UTF-8 so we can
        // parse its output without a transcode layer.
        c.env("WSL_UTF8", "1");
        c
    }

    fn wsl_exe_on_path() -> bool {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // Prefer the canonical location check: wsl.exe ships in %SystemRoot%\
        // System32 on every WSL-capable Windows. It's a plain fs::exists — no
        // child process — so it can't be defeated by the console-less-spawn quirk
        // that made shelling to `where` flaky from the packaged app (WI-2749: the
        // app read wsl_exe_available:false while a cmd in the same launch context
        // resolved it fine).
        if let Some(sysroot) = std::env::var_os("SystemRoot") {
            let p = PathBuf::from(sysroot).join("System32").join("wsl.exe");
            if p.exists() {
                return true;
            }
        }
        // Fallback: `where wsl.exe`, now with CREATE_NO_WINDOW for the same
        // console-less-parent reason as wsl_command().
        Command::new("where")
            .arg("wsl.exe")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn list_distros() -> Vec<String> {
        let out = match wsl_command().args(["--list", "--quiet"]).output() {
            Ok(o) => o,
            Err(e) => {
                // Diagnostic (WI-2749): a failed spawn here silently yields [] →
                // detect() → InstalledNoDistro/NotInstalled → the defer/finalize
                // loop. Surface it in the boot log (now captured on Windows via
                // the WI-2762 SetStdHandle redirect).
                eprintln!("[wsl_setup] list_distros: spawn `wsl --list --quiet` failed: {e}");
                return vec![];
            }
        };
        if !out.status.success() {
            eprintln!(
                "[wsl_setup] list_distros: `wsl --list --quiet` exited {:?} — stdout={:?} stderr={:?}",
                out.status.code(),
                super::decode_wsl_output(&out.stdout),
                super::decode_wsl_output(&out.stderr),
            );
            return vec![];
        }
        let list: Vec<String> = super::decode_wsl_output(&out.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        if list.is_empty() {
            eprintln!(
                "[wsl_setup] list_distros: parsed EMPTY distro list from raw stdout={:?}",
                super::decode_wsl_output(&out.stdout),
            );
        }
        list
    }

    fn read_default_version() -> u8 {
        let out = wsl_command()
            .args(["--status"])
            .output()
            .ok()
            .filter(|o| o.status.success());
        let Some(out) = out else { return 0 };
        super::parse_default_version(&super::decode_wsl_output(&out.stdout))
    }

    /// Probe whether the registered `papercup-runtime` distro can actually
    /// START. `wsl --list` reports the REGISTRATION, not the backing disk, so a
    /// husk whose ext4.vhdx is gone still lists — but starting it fails. Returns
    /// Some(err) on failure (→ caller re-imports), None if it boots + runs a
    /// trivial command. (owner-reported 2026-07-08 on 0.0.3-alpha: a stale
    /// registration from an older `com.papercusp.desktop` build — its per-bundle
    /// data dir removed — listed fine but died on boot with "Failed to attach
    /// disk …ext4.vhdx… ERROR_PATH_NOT_FOUND".)
    fn distro_start_failure() -> Option<String> {
        let out = wsl_command()
            .args([
                "--distribution",
                DISTRO_NAME,
                "--user",
                "root",
                "--",
                "true",
            ])
            .output();
        match out {
            Ok(o) if o.status.success() => None,
            Ok(o) => Some(format!(
                "exit={:?} stderr={}",
                o.status.code(),
                super::decode_wsl_output(&o.stderr).trim()
            )),
            Err(e) => Some(format!("spawn failed: {e}")),
        }
    }

    pub(crate) fn detect(app: &tauri::AppHandle) -> WslStatus {
        let exe = wsl_exe_on_path();
        if !exe {
            return WslStatus {
                state: WslState::NotInstalled,
                wsl_exe_available: false,
                distros: vec![],
                default_version: 0,
            };
        }

        let distros = list_distros();
        let default_version = read_default_version();
        let persisted = load_state(app);

        if persisted.install_kicked_off && distros.is_empty() {
            return WslStatus {
                state: WslState::PendingReboot,
                wsl_exe_available: true,
                distros,
                default_version,
            };
        }

        if !distros.iter().any(|d| d == DISTRO_NAME) {
            return WslStatus {
                state: WslState::InstalledNoDistro,
                wsl_exe_available: true,
                distros,
                default_version,
            };
        }

        if !persisted.bootstrapped {
            // A distro NAME in `wsl --list` does not mean it can START — a
            // registration can outlive its backing ext4.vhdx (e.g. a husk left
            // by an OLDER build under the retired single `com.papercusp.desktop`
            // data dir). Bootstrapping such a husk dies with "Failed to attach
            // disk …ext4.vhdx… ERROR_PATH_NOT_FOUND" (owner 2026-07-08,
            // 0.0.3-alpha). Probe by actually starting it; if it can't start,
            // treat as InstalledNoDistro so onboarding re-imports a fresh distro
            // (import_rootfs unregisters the husk first). Safe to re-import here:
            // a not-yet-bootstrapped distro holds no user data. Gated behind
            // !bootstrapped so a healthy Ready distro is never probed or
            // re-imported (its data is never at risk).
            if let Some(err) = distro_start_failure() {
                eprintln!(
                    "[wsl_setup] detect: `{DISTRO_NAME}` is registered but failed to start ({err}) — treating as InstalledNoDistro to force a clean re-import"
                );
                return WslStatus {
                    state: WslState::InstalledNoDistro,
                    wsl_exe_available: true,
                    distros,
                    default_version,
                };
            }
            return WslStatus {
                state: WslState::PendingBootstrap,
                wsl_exe_available: true,
                distros,
                default_version,
            };
        }

        // The distro is bootstrapped — but bootstrapped BY WHAT? An app update
        // ships a new rootfs recipe while the distro on disk keeps whatever
        // provisioned it months ago, and a distro that exists and starts looks
        // Ready forever. That is how a fix to the rootfs (a library the distro
        // needs, say) reaches new installs and NOBODY WHO ALREADY HAS THE APP.
        //
        // Re-import is the wrong hammer — it destroys the user's workspaces inside
        // the distro. The bootstrap is idempotent, so re-run the CURRENT one and
        // record which recipe it was.
        let shipped = match shipped_rootfs_recipe(app) {
            Ok(recipe) => recipe,
            Err(message) => {
                return WslStatus {
                    state: WslState::Error { message },
                    wsl_exe_available: true,
                    distros,
                    default_version,
                };
            }
        };
        if super::distro_needs_reprovision(Some(&shipped), persisted.rootfs_recipe.as_deref()) {
            eprintln!(
                "[wsl_setup] detect: `{DISTRO_NAME}` was provisioned by recipe {:?} but this build ships {:?} — re-running the bootstrap so the distro matches the app",
                persisted.rootfs_recipe.as_deref().unwrap_or("<unknown>"),
                shipped,
            );
            return WslStatus {
                state: WslState::PendingBootstrap,
                wsl_exe_available: true,
                distros,
                default_version,
            };
        }

        WslStatus {
            state: WslState::Ready,
            wsl_exe_available: true,
            distros,
            default_version,
        }
    }

    /// One Server-owned resource source for detection, bootstrap, and import.
    pub(super) fn runtime_resource(
        app: &tauri::AppHandle,
        filename: &str,
    ) -> Result<PathBuf, String> {
        use tauri::Manager;
        let root = app.path().resource_dir().map_err(|e| e.to_string())?;
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let installed_gui =
            !cfg!(debug_assertions) && crate::app_role::detect(&app.config().identifier).is_gui();
        super::runtime_resources::resolve(&root, local.as_deref(), installed_gui, filename)
    }

    /// Copy the Server's shipped bootstrap into the distro, replacing the one
    /// baked in when the distro was first imported.
    ///
    /// Feeding it over stdin (`bash -c 'cat > …'`) rather than a `/mnt/c/...`
    /// path keeps this independent of Windows→WSL path translation and of where
    /// the app happens to be installed — the resource path contains spaces
    /// ("Papercusp GUI"), which is exactly the kind of thing that works on the
    /// dev box and breaks in the field.
    ///
    /// Never run an old bootstrap and then record the new recipe as completed.
    fn install_shipped_bootstrap(app: &tauri::AppHandle) -> Result<(), String> {
        use std::io::Write;
        let path = runtime_resource(app, super::ROOTFS_BOOTSTRAP_FILENAME)?;
        let script = std::fs::read(&path)
            .map_err(|e| format!("Read shipped WSL bootstrap {}: {e}", path.display()))?;
        if script.is_empty() {
            return Err(format!("Shipped WSL bootstrap {} is empty", path.display()));
        }
        let mut child = wsl_command()
            .args([
                "--distribution",
                DISTRO_NAME,
                "--user",
                "root",
                "--exec",
                "bash",
                "-c",
                "mkdir -p /opt/papercup && cat > /opt/papercup/bootstrap && chmod +x /opt/papercup/bootstrap",
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Install shipped WSL bootstrap: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            if let Err(e) = stdin.write_all(&script) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Write shipped WSL bootstrap: {e}"));
            }
        }
        match child.wait_with_output() {
            Ok(out) if out.status.success() => {
                eprintln!("[wsl_setup] install_shipped_bootstrap: refreshed /opt/papercup/bootstrap from the shipped resource");
                Ok(())
            }
            Ok(out) => Err(format!(
                "Install shipped WSL bootstrap: exit={:?} stderr={}",
                out.status.code(),
                super::decode_wsl_output(&out.stderr)
            )),
            Err(e) => Err(format!("Wait for shipped WSL bootstrap install: {e}")),
        }
    }

    /// Read the Server-owned recipe, never treating absence as Ready.
    fn shipped_rootfs_recipe(app: &tauri::AppHandle) -> Result<String, String> {
        let path = runtime_resource(app, super::ROOTFS_RECIPE_FILENAME)?;
        super::runtime_resources::read_recipe(&path)
    }

    /// Kick off `wsl --install --no-launch --no-distribution`. Requires
    /// admin — on `ERROR_ELEVATION_REQUIRED` (exit 740) we return
    /// `WslOpError::NeedsElevation` so the frontend can offer a
    /// one-click "re-launch as admin" instead of a raw error.
    pub fn install(app: &tauri::AppHandle) -> Result<(), WslOpError> {
        let out = wsl_command()
            .args(["--install", "--no-launch", "--no-distribution"])
            .output()
            .map_err(|e| WslOpError::Failed(format!("spawn wsl --install: {}", e)))?;
        if !out.status.success() {
            let stderr = super::decode_wsl_output(&out.stderr);
            return Err(WslOpError::from_exit(
                "wsl --install",
                out.status.code(),
                stderr,
            ));
        }
        let mut st = load_state(app);
        st.install_kicked_off = true;
        save_state(app, &st).map_err(WslOpError::Failed)?;
        Ok(())
    }

    fn ensure_wsl2_default() {
        let _ = wsl_command().args(["--set-default-version", "2"]).output();
    }

    /// TCP-connect probe against one host. A DNS failure counts as unreachable:
    /// if the name does not resolve, the download cannot happen either.
    fn host_reachable(host: &str, port: u16, timeout: std::time::Duration) -> bool {
        use std::net::ToSocketAddrs;
        match (host, port).to_socket_addrs() {
            Ok(addrs) => addrs
                .into_iter()
                .any(|addr| std::net::TcpStream::connect_timeout(&addr, timeout).is_ok()),
            Err(_) => false,
        }
    }

    /// Fail BEFORE the multi-GB `wsl --import` — and before any WSL mutation —
    /// when the hosts the bootstrap downloads from cannot be reached
    /// (EI-20574262390154687).
    ///
    /// This is the FAIL-FAST half of the preflight. The AUTHORITATIVE half lives
    /// at the top of `resources/papercup-bootstrap.sh`, because only code running
    /// inside the distro sees the network stack that will really do the
    /// downloads: its resolver, its proxy environment, and its actual apt mirror.
    /// Both exist on purpose — this one saves the user a multi-GB import they
    /// were always going to lose, the in-distro one cannot be fooled.
    ///
    /// A plain TCP connect cannot see a Windows-only CONNECT proxy, so this CAN
    /// misjudge a working setup. That is why the failure names an override rather
    /// than being a dead end.
    fn preflight_bootstrap_network() -> Result<(), String> {
        if std::env::var("PAPERCUP_SKIP_NETWORK_PREFLIGHT").as_deref() == Ok("1") {
            eprintln!(
                "[wsl_setup] network preflight SKIPPED (PAPERCUP_SKIP_NETWORK_PREFLIGHT=1) — \
                 provisioning may still fail later if a download host is blocked"
            );
            return Ok(());
        }
        let timeout = std::time::Duration::from_secs(6);
        let unreachable: Vec<(&str, u16, &str)> = super::BOOTSTRAP_NETWORK_HOSTS
            .iter()
            .copied()
            .filter(|(host, port, _)| !host_reachable(host, *port, timeout))
            .collect();
        for (host, _, _) in &unreachable {
            eprintln!("[wsl_setup] network preflight: {host} unreachable");
        }
        match super::bootstrap_network_failure(&unreachable) {
            Some(msg) => Err(msg),
            None => Ok(()),
        }
    }

    pub fn import_rootfs(app: &tauri::AppHandle, tarball: &PathBuf) -> Result<(), String> {
        let install_dir = distro_install_dir(app)?;
        if !tarball.exists() {
            return Err(format!("rootfs tarball not found: {}", tarball.display()));
        }
        // Before ANY mutation — the unregister below and `--set-default-version`
        // both change machine state, and the import itself is multi-GB. If the
        // bootstrap's downloads cannot succeed, stopping here leaves the machine
        // exactly as it was and tells the user which host is blocked.
        preflight_bootstrap_network()?;
        ensure_wsl2_default();
        // `wsl --import` fails if the name already exists. We only reach
        // import_rootfs when the distro is ABSENT or detected BROKEN (a husk
        // with a missing ext4.vhdx — no usable data to preserve), so clear any
        // lingering registration first so the fresh import can take the name.
        // (owner 2026-07-08, 0.0.3-alpha stale-registration bug)
        if list_distros().iter().any(|d| d == DISTRO_NAME) {
            eprintln!(
                "[wsl_setup] import_rootfs: `{DISTRO_NAME}` already registered — unregistering husk before fresh import"
            );
            let _ = wsl_command().args(["--unregister", DISTRO_NAME]).output();
        }
        let out = wsl_command()
            .args([
                "--import",
                DISTRO_NAME,
                install_dir
                    .to_str()
                    .ok_or_else(|| "install_dir not utf8".to_string())?,
                tarball
                    .to_str()
                    .ok_or_else(|| "tarball path not utf8".to_string())?,
                "--version",
                "2",
            ])
            .output()
            .map_err(|e| format!("spawn wsl --import: {}", e))?;
        if !out.status.success() {
            let code = out.status.code().unwrap_or(-1);
            let stderr = super::decode_wsl_output(&out.stderr);
            return Err(format!("wsl --import exit={} stderr={}", code, stderr));
        }
        // Opt the WSL2 VM into mirrored networking BEFORE the distro's first
        // boot (run_bootstrap), so a fresh install's operator localhost ports
        // are reachable from Windows without the flaky NAT proxy (WI-3360).
        // Best-effort; never fails the import.
        super::ensure_wsl_networking_config();
        Ok(())
    }

    pub fn run_bootstrap(app: &tauri::AppHandle) -> Result<String, String> {
        // Refresh /opt/papercup/bootstrap from the bootstrap THIS BUILD SHIPS
        // before running it. The copy already inside the distro was baked in at
        // image-build time, so on an existing install it is the OLD one — re-running
        // it would faithfully re-apply the old recipe and change nothing, which is
        // the entire failure we are here to fix. Read both required inputs before
        // provisioning; failures must not falsely stamp the new recipe Ready.
        let recipe = shipped_rootfs_recipe(app)?;
        install_shipped_bootstrap(app)?;

        // --user root: the rootfs bakes /etc/wsl.conf default=papercup, so a
        // bare `wsl -d` runs as that user — and bootstrap writes /etc/* and
        // apt-installs, which die with Permission denied as non-root
        // (found live 2026-06-11: "/opt/papercup/bootstrap: line 16:
        // /etc/wsl.conf: Permission denied").
        let out = wsl_command()
            .args([
                "--distribution",
                DISTRO_NAME,
                "--user",
                "root",
                "--",
                "/opt/papercup/bootstrap",
            ])
            .output()
            .map_err(|e| format!("spawn wsl bootstrap: {}", e))?;
        let stdout = super::decode_wsl_output(&out.stdout);
        let stderr = super::decode_wsl_output(&out.stderr);
        if !out.status.success() {
            let code = out.status.code().unwrap_or(-1);
            return Err(format!(
                "bootstrap exit={}\n--- stdout ---\n{}\n--- stderr ---\n{}",
                code, stdout, stderr
            ));
        }
        let mut st = load_state(app);
        st.bootstrapped = true;
        // Record WHICH recipe provisioned this distro. Only after a SUCCESSFUL
        // bootstrap — a failed run must leave the distro marked stale so the next
        // launch tries again, rather than recording a provisioning that never
        // happened.
        st.rootfs_recipe = Some(recipe);
        // A fresh bootstrap is a fresh onboarding: re-allow BOTH roles' single
        // post-onboarding finalize RESTART (see the per-role flags above).
        st.gui_finalize_restart_done = false;
        st.server_finalize_restart_done = false;
        save_state(app, &st)?;
        Ok(format!("{}\n{}", stdout, stderr))
    }

    /// The current process's bundle role (GUI vs Server) — the finalize guard is
    /// keyed on it so each role takes its OWN single post-onboarding restart.
    fn is_gui_role(app: &tauri::AppHandle) -> bool {
        use tauri::Manager;
        crate::app_role::detect(&app.config().identifier).is_gui()
    }

    /// Has THIS ROLE's post-onboarding finalize RESTART already fired (persisted,
    /// cross-process)? Guards the WI-2749 respawn/window-cascade loop while still
    /// letting the GUI and the Server each restart once (they need different
    /// outcomes — see the per-role flags on `PersistedState`).
    pub(crate) fn finalize_restart_already_done(app: &tauri::AppHandle) -> bool {
        let st = load_state(app);
        if is_gui_role(app) {
            st.gui_finalize_restart_done
        } else {
            st.server_finalize_restart_done
        }
    }

    /// Persist that THIS ROLE's finalize RESTART has fired, so no other spawned
    /// instance of the SAME role repeats it (WI-2749).
    pub(crate) fn mark_finalize_restart_done(app: &tauri::AppHandle) {
        let mut st = load_state(app);
        if is_gui_role(app) {
            st.gui_finalize_restart_done = true;
        } else {
            st.server_finalize_restart_done = true;
        }
        let _ = save_state(app, &st);
    }

    pub fn uninstall(app: &tauri::AppHandle) -> Result<(), String> {
        let _ = wsl_command().args(["--unregister", DISTRO_NAME]).output();
        let p = state_path(app)?;
        let _ = std::fs::remove_file(p);
        Ok(())
    }
}

// ─── Programmatic detect (used by main.rs to gate sidecar routing) ──

pub fn detect(_app: &tauri::AppHandle) -> WslStatus {
    #[cfg(target_os = "windows")]
    {
        return imp::detect(_app);
    }
    #[cfg(not(target_os = "windows"))]
    {
        WslStatus::unsupported()
    }
}

// ─── Tauri command surface (always compiles) ────────────────────────

#[tauri::command]
#[specta::specta]
pub fn wsl_status(app: tauri::AppHandle) -> WslStatus {
    detect(&app)
}

#[tauri::command]
#[specta::specta]
pub fn wsl_install(_app: tauri::AppHandle) -> Result<(), WslOpError> {
    #[cfg(target_os = "windows")]
    {
        return imp::install(&_app);
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(WslOpError::Failed(
            "wsl_install: only supported on Windows".to_string(),
        ))
    }
}

/// Re-launch the desktop app with admin elevation via PowerShell's
/// `Start-Process -Verb RunAs`. The current process exits as soon as
/// the elevated child is spawned. The user sees the UAC prompt,
/// approves, and the app reopens with admin rights — `wsl --install`
/// will then succeed.
#[tauri::command]
#[specta::specta]
pub fn wsl_relaunch_elevated(_app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let exe = std::env::current_exe().map_err(|e| format!("current_exe: {}", e))?;
        let exe_str = exe
            .to_str()
            .ok_or_else(|| "exe path not utf8".to_string())?;
        // PowerShell `Start-Process -Verb RunAs` triggers the UAC prompt.
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &format!("Start-Process -FilePath \"{}\" -Verb RunAs", exe_str),
            ])
            .spawn()
            .map_err(|e| format!("spawn powershell: {}", e))?;
        // Exit so the elevated child takes over.
        _app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("wsl_relaunch_elevated: only supported on Windows".to_string())
    }
}

#[tauri::command]
#[specta::specta]
pub fn wsl_import(_app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let tarball = imp::runtime_resource(&_app, ROOTFS_FILENAME)?;
        return imp::import_rootfs(&_app, &tarball);
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("wsl_import: only supported on Windows".to_string())
    }
}

#[tauri::command]
#[specta::specta]
pub fn wsl_bootstrap(_app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        return imp::run_bootstrap(&_app);
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("wsl_bootstrap: only supported on Windows".to_string())
    }
}

/// Finalize the GUI's WSL onboarding transition. `gui_setup` already waits
/// for WSL Ready and attaches the existing window to the Server in-process.
/// The GUI must not relaunch here: its parent still owns the single-instance
/// lock, so a child launched before `app.exit` is rejected as a duplicate
/// (WI-10003674). Keep the legacy restart path for an explicit Server caller;
/// the normal Server deferred-boot watcher now spawns the sidecar in-process.
#[tauri::command]
#[specta::specta]
pub fn wsl_finalize_ready(app: tauri::AppHandle) -> Result<(), String> {
    // Idempotency guard: the finalize can be requested by BOTH the gate (on
    // its observed PendingBootstrap→Ready transition) and the Rust-side
    // deferred-boot watcher in main.rs (the reload-proof safety net) —
    // whichever fires first wins, the other becomes a no-op instead of
    // spawning a second instance.
    static FINALIZED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if FINALIZED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;

        if !should_restart_after_wsl_finalize(crate::app_role::detect(&app.config().identifier)) {
            println!(
                "[papercusp-gui] wsl_finalize_ready: keeping the existing GUI process; gui_setup already waits for WSL Ready and attaches to the Server"
            );
            return Ok(());
        }

        // Cross-process idempotency (WI-2749): the per-process FINALIZED atomic
        // above only guards THIS process, but this fn breakaway-SPAWNS a fresh
        // instance that can itself re-enter here (its detect() may still read
        // not-Ready during WSL warm-up) → restart→restart→… = the window-cascade
        // loop users saw. A persisted flag makes the restart fire AT MOST ONCE
        // per onboarding across every spawned instance (reset by run_bootstrap).
        if imp::finalize_restart_already_done(&app) {
            println!(
                "[papercusp-desktop] wsl_finalize_ready: post-onboarding restart already done (persisted) — skipping to avoid a respawn loop"
            );
            return Ok(());
        }
        use std::os::windows::process::CommandExt;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        if let Ok(exe) = std::env::current_exe() {
            // Persist BEFORE spawning: if the child boots and re-enters this
            // path before we'd otherwise record it, it must already see "done".
            imp::mark_finalize_restart_done(&app);
            let spawned = std::process::Command::new(&exe)
                .creation_flags(CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP)
                .spawn()
                .or_else(|_| {
                    // Job may not permit breakaway — a plain spawn still
                    // survives parent exit unless the job kills by tree.
                    std::process::Command::new(&exe).spawn()
                });
            if spawned.is_ok() {
                app.exit(0);
                return Ok(());
            }
        }
    }
    app.restart();
}

#[cfg(any(target_os = "windows", test))]
fn should_restart_after_wsl_finalize(role: crate::app_role::Role) -> bool {
    !role.is_gui()
}

#[tauri::command]
#[specta::specta]
pub fn wsl_uninstall(_app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return imp::uninstall(&_app);
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("wsl_uninstall: only supported on Windows".to_string())
    }
}

// ─── Windows CLI shims (WI-3044) ────────────────────────────────────
//
// Mac/Linux users open their own terminal and type `psu`; on Windows psu
// is a Linux CLI living INSIDE the papercup-runtime distro, invisible to
// cmd/PowerShell. Parity: drop a `psu.cmd` launcher into
// %LOCALAPPDATA%\Papercusp\bin and put that dir on the USER PATH, so a
// bare `psu` works in any cmd / PowerShell / Windows Terminal window.
// (A real console window is also the PROVEN-working host for wsl.exe —
// the WI-3033 ConPTY wedge only bites portable_pty's pseudoconsole.)

/// Contents of a generated Windows CLI shim (`psu.cmd`, `papercusp.cmd`). Pure so
/// the invariants are unit-testable from Linux: `--distribution/--cd/--exec` form
/// (WI-2955 — never let wsl.exe cwd-translate or shell-re-parse), TERM threaded
/// (WI-3033), args forwarded via bash `"$@"` positionals (never re-parsed as a
/// shell string), `$HOME` shim path preferred with a login-PATH fallback, and a
/// post-exit terminal-mode reset (WI-3295 — a hard-killed TUI, e.g. wsl shutdown
/// mid-session, leaves mouse-tracking/bracketed-paste armed and the surviving
/// prompt types `^[[<35;12;7M` on every mouse move).
///
/// `cmd` is a bare Linux CLI identifier (`psu` | `papercusp`) — the SINGLE source
/// of the hardened invocation form for every Windows shim, so a second command can
/// never drift from it (WI-3044; papercusp added 2026-07-08 so `papercusp tutorial`
/// works from cmd/PowerShell exactly like `psu`).
#[cfg(any(target_os = "windows", test))]
fn windows_cli_cmd_contents(cmd: &str) -> String {
    let exit_var = format!("{}_EXIT", cmd.to_ascii_uppercase());
    format!(
        "@echo off\r\n\
         rem Papercusp `{cmd}` launcher (WI-3044) - auto-generated by the desktop app\r\n\
         rem on every launch; manual edits are overwritten.\r\n\
         wsl.exe --distribution {DISTRO_NAME} --cd ~ --exec /usr/bin/env TERM=xterm-256color \
         /bin/bash -lc \"if [ -x \\\"$HOME/.papercusp/bin/{cmd}\\\" ]; then exec \\\"$HOME/.papercusp/bin/{cmd}\\\" \\\"$@\\\"; fi; exec {cmd} \\\"$@\\\"\" {cmd} %*\r\n\
         set {exit_var}=%ERRORLEVEL%\r\n\
         rem WI-3295: reset terminal modes a hard-killed TUI leaves armed (alt-screen,\r\n\
         rem DECSTR soft reset, mouse tracking 1000/1002/1003 + SGR 1006, bracketed\r\n\
         rem paste 2004, cursor visibility, SGR attributes). Written to STDERR so\r\n\
         rem `{cmd} ... > file` redirections stay byte-clean.\r\n\
         powershell -NoProfile -NonInteractive -Command \"$e=[char]27;[Console]::Error.Write(\\\"$e[?1049l$e[!p$e[?1000l$e[?1002l$e[?1003l$e[?1006l$e[?2004l$e[?25h$e[0m\\\")\"\r\n\
         exit /b %{exit_var}%\r\n"
    )
}

/// `psu.cmd` — the Linux `psu` TUI, one type away in cmd/PowerShell.
#[cfg(any(target_os = "windows", test))]
fn windows_psu_cmd_contents() -> String {
    windows_cli_cmd_contents("psu")
}

/// `papercusp.cmd` — so `papercusp tutorial` / `papercusp setup` / `papercusp onboard`
/// (the whole `papercusp` CLI, which lives INSIDE papercup-runtime) work from a bare
/// cmd/PowerShell prompt. Mac/Linux get this for free (native operator, `papercusp`
/// on PATH); on Windows it was invisible without this shim.
#[cfg(any(target_os = "windows", test))]
fn windows_papercusp_cmd_contents() -> String {
    windows_cli_cmd_contents("papercusp")
}

/// Contents of the Windows Terminal *fragment extension* that registers a
/// "Papercusp (psu)" profile (WI-3299). Dropped into
/// %LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\Papercusp\ so psu is
/// one dropdown-pick away in Windows Terminal instead of a default-PowerShell
/// hop + a typed `psu`. The profile deliberately DELEGATES to the WI-3044
/// psu.cmd shim (`cmd.exe /c …\psu.cmd`) rather than re-embedding the wsl.exe
/// invocation: psu.cmd is the single, WI-2955/3033/3295-hardened source of
/// truth for the `--distribution/--cd/--exec` form + the post-exit terminal-
/// mode reset, and a duplicated wsl line here would silently drift from it.
/// Built with serde_json so the `\`-heavy Windows path is escaped correctly.
///
/// Notes: Windows Terminal expands `%VAR%` in `commandline`/`startingDirectory`
/// (and cmd.exe re-expands `%LOCALAPPDATA%` at runtime as a belt-and-suspenders),
/// and it synthesizes a stable profile GUID from the fragment source + `name`,
/// so no explicit `guid` is needed for a NEW profile.
#[cfg(any(target_os = "windows", test))]
fn windows_terminal_fragment_contents() -> String {
    serde_json::json!({
        "profiles": [{
            "name": "Papercusp (psu)",
            "commandline": r#"cmd.exe /c "%LOCALAPPDATA%\Papercusp\bin\psu.cmd""#,
            "startingDirectory": "%USERPROFILE%"
        }]
    })
    .to_string()
}

/// PowerShell that idempotently appends %LOCALAPPDATA%\Papercusp\bin to the
/// USER PATH. Reads the raw registry value (DoNotExpandEnvironmentNames) and
/// writes back ExpandString so existing %VAR% entries survive — the naive
/// [Environment]::SetEnvironmentVariable path bakes them expanded as REG_SZ.
/// Broadcasts WM_SETTINGCHANGE so already-running shells' children see it.
#[cfg(any(target_os = "windows", test))]
const WINDOWS_PATH_SETUP_PS1: &str = r#"$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'Papercusp\bin'
$rk = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$cur = [string]$rk.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
if (($cur -split ';') -notcontains $dir) {
  $new = if ($cur.TrimEnd(';')) { $cur.TrimEnd(';') + ';' + $dir } else { $dir }
  $rk.SetValue('Path', $new, 'ExpandString')
  Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
  [UIntPtr]$r = [UIntPtr]::Zero
  [Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r) | Out-Null
}
"#;

/// Install/refresh the Windows-side CLI shims. Called on every Ready boot
/// (main.rs setup) so upgrades refresh the launcher and a deleted one
/// self-heals; the PATH append happens at most once. Best-effort — any
/// failure logs and never blocks boot.
#[cfg(target_os = "windows")]
pub fn ensure_windows_cli_shims() {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Self-heal / upgrade path: ensure mirrored networking on every Ready boot
    // too (import-time covers only fresh installs). Idempotent — a no-op once
    // the key is present — and best-effort. WI-3360.
    ensure_wsl_networking_config();

    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        eprintln!("[papercusp-desktop] cli-shims: LOCALAPPDATA unset — skipping");
        return;
    };
    let bin_dir = std::path::Path::new(&local).join("Papercusp").join("bin");
    if let Err(e) = std::fs::create_dir_all(&bin_dir) {
        eprintln!("[papercusp-desktop] cli-shims: create {bin_dir:?}: {e}");
        return;
    }
    if let Err(e) = std::fs::write(bin_dir.join("psu.cmd"), windows_psu_cmd_contents()) {
        eprintln!("[papercusp-desktop] cli-shims: write psu.cmd: {e}");
        return;
    }
    // papercusp.cmd — same bin dir + PATH so `papercusp tutorial` (and the rest of
    // the papercusp CLI) work from cmd/PowerShell just like `psu`. Non-fatal: a
    // failure here must not abort psu.cmd's PATH setup below.
    if let Err(e) = std::fs::write(
        bin_dir.join("papercusp.cmd"),
        windows_papercusp_cmd_contents(),
    ) {
        eprintln!("[papercusp-desktop] cli-shims: write papercusp.cmd: {e}");
    }

    // PATH append via a temp .ps1 (-File dodges every -Command quoting layer).
    let ps1 = bin_dir.join(".papercusp-path-setup.ps1");
    if let Err(e) = std::fs::write(&ps1, WINDOWS_PATH_SETUP_PS1) {
        eprintln!("[papercusp-desktop] cli-shims: write path-setup ps1: {e}");
        return;
    }
    let out = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&ps1)
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let _ = std::fs::remove_file(&ps1);
    match out {
        Ok(o) if o.status.success() => {
            println!("[papercusp-desktop] cli-shims: psu.cmd + papercusp.cmd installed + user PATH ensured");
        }
        Ok(o) => eprintln!(
            "[papercusp-desktop] cli-shims: PATH setup failed (shim still written): {}",
            String::from_utf8_lossy(&o.stderr)
        ),
        Err(e) => eprintln!("[papercusp-desktop] cli-shims: spawn powershell: {e}"),
    }

    // WI-3299: register a Windows Terminal profile ("Papercusp (psu)") via a
    // fragment extension so the manual `psu` path skips the default-PowerShell
    // hop. Best-effort + last (never blocks the psu.cmd/PATH shims above);
    // rewritten every Ready boot so upgrades refresh it and a deleted one
    // self-heals. WT ignores the dir entirely when it isn't installed.
    let frag_dir = std::path::Path::new(&local)
        .join("Microsoft")
        .join("Windows Terminal")
        .join("Fragments")
        .join("Papercusp");
    match std::fs::create_dir_all(&frag_dir) {
        Ok(()) => match std::fs::write(
            frag_dir.join("papercusp.json"),
            windows_terminal_fragment_contents(),
        ) {
            Ok(()) => {
                println!("[papercusp-desktop] cli-shims: Windows Terminal psu profile registered")
            }
            Err(e) => eprintln!("[papercusp-desktop] cli-shims: write WT fragment: {e}"),
        },
        Err(e) => {
            eprintln!("[papercusp-desktop] cli-shims: create WT fragment dir {frag_dir:?}: {e}")
        }
    }
}

// ─── WSL2 networking: mirror the host so localhost is reliable (WI-3360) ─────
//
// On Windows the operator runs INSIDE the papercup-runtime distro and binds
// 127.0.0.1:<port>. The Tauri shell + webview reach it across the Windows→WSL
// boundary. In WSL2's DEFAULT (NAT) networking that crossing is a localhost
// port-PROXY, and it intermittently drops under load (WI-3270): a perfectly
// healthy in-distro operator looks dead from Windows, driving the respawn →
// respawn-cap → distro-wedge storm that leaves the console-launch bridge
// unregistered and the desktop app disconnected (WI-3360 root cause). MIRRORED
// networking (WSL 2.0.0+ / Win11 22H2+) puts the distro on the host's network
// namespace, so 127.0.0.1 is shared bidirectionally with NO NAT proxy to flake.
// On older WSL the key is parsed-and-ignored — a harmless fallback to NAT.
//
// The setting lives in the per-user GLOBAL `%USERPROFILE%\.wslconfig` and
// affects EVERY WSL2 distro, so we are conservative: only ADD
// networkingMode=mirrored when the user set NO networkingMode of their own (an
// explicit choice — even `nat` — is respected). It takes effect on the next
// `wsl --shutdown` / WSL2-VM restart; we never force one (the app already
// survives distro restarts via the WI-3270 resilience layer).

/// Pure merge: given the current `.wslconfig` contents (None = no file),
/// return the contents to WRITE so `[wsl2] networkingMode=mirrored` is present,
/// or None when the file already specifies a networkingMode (leave it alone).
/// Never clobbers existing keys/sections. Unit-tested from Linux.
#[cfg(any(target_os = "windows", test))]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn wslconfig_with_mirrored(existing: Option<&str>) -> Option<String> {
    const KEY: &str = "networkingMode";
    const SECTION: &str = "[wsl2]";

    let Some(existing) = existing else {
        return Some(format!("{SECTION}\n{KEY}=mirrored\n"));
    };

    // Single pass: locate the [wsl2] section, whether it already sets
    // networkingMode, and the index of its last line (to insert after).
    let lines: Vec<&str> = existing.lines().collect();
    let mut in_wsl2 = false;
    let mut wsl2_seen = false;
    let mut has_key = false;
    let mut wsl2_last_idx: Option<usize> = None;
    for (i, raw) in lines.iter().enumerate() {
        let line = raw.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_wsl2 = line.eq_ignore_ascii_case(SECTION);
            if in_wsl2 {
                wsl2_seen = true;
                wsl2_last_idx = Some(i);
            }
            continue;
        }
        if in_wsl2 {
            wsl2_last_idx = Some(i);
            // Skip comments (# or ;) — a commented mode isn't an active setting.
            if !line.starts_with('#') && !line.starts_with(';') {
                if let Some((k, _)) = line.split_once('=') {
                    if k.trim().eq_ignore_ascii_case(KEY) {
                        has_key = true;
                    }
                }
            }
        }
    }

    if has_key {
        return None; // user has an explicit networkingMode — respect it.
    }

    if !wsl2_seen {
        // No [wsl2] section — append one, preserving everything above it.
        let sep = if existing.is_empty() || existing.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        return Some(format!("{existing}{sep}{SECTION}\n{KEY}=mirrored\n"));
    }

    // [wsl2] exists but sets no networkingMode — insert the key just after the
    // section's last line so it lands INSIDE the section.
    let insert_after = wsl2_last_idx.expect("wsl2_seen implies an index");
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 1);
    for (i, l) in lines.iter().enumerate() {
        out.push((*l).to_string());
        if i == insert_after {
            out.push(format!("{KEY}=mirrored"));
        }
    }
    let mut joined = out.join("\n");
    if existing.ends_with('\n') {
        joined.push('\n');
    }
    Some(joined)
}

/// Best-effort: ensure the user's `%USERPROFILE%\.wslconfig` opts into mirrored
/// networking (see the section header above). Called at distro-import time
/// (before the distro's first boot — a fresh install gets it immediately) and
/// on every Ready boot (self-heal / upgrade). Never blocks or fails boot.
#[cfg(target_os = "windows")]
pub fn ensure_wsl_networking_config() {
    let Some(profile) = std::env::var_os("USERPROFILE") else {
        eprintln!(
            "[papercusp-desktop] wslconfig: USERPROFILE unset — skipping mirrored-networking setup"
        );
        return;
    };
    let path = std::path::Path::new(&profile).join(".wslconfig");
    let existing = std::fs::read_to_string(&path).ok();
    match wslconfig_with_mirrored(existing.as_deref()) {
        None => println!(
            "[papercusp-desktop] wslconfig: a networkingMode is already set — leaving {} untouched",
            path.display()
        ),
        Some(contents) => match std::fs::write(&path, contents) {
            Ok(()) => println!(
                "[papercusp-desktop] wslconfig: ensured [wsl2] networkingMode=mirrored in {} (applies on next `wsl --shutdown` / WSL restart) — WI-3360",
                path.display()
            ),
            Err(e) => eprintln!("[papercusp-desktop] wslconfig: write {}: {e}", path.display()),
        },
    }
}

// ─── Tests ──────────────────────────────────────────────────────────
//
// Everything inside `mod imp` shells out to wsl.exe, so what's unit-
// testable cross-platform is the pure surface: the serde wire shapes
// the frontend matches on (apps/operator/lib/tauri-bindings.ts checks
// `state.kind === 'NotSupported' | …` and `err.kind ===
// 'NeedsElevation' | 'Failed'` — see the PascalCase-tag comments on
// WslState/WslOpError above), plus the 740-elevation mapping (Windows-
// only, gated below).
//
// Deliberately NOT covered here (each would need a non-test refactor):
//
// * `imp::list_distros` — the wsl.exe output parsing is inlined in the
//   same function that spawns the process. To unit test it you'd
//   extract a pure `parse_distro_list(stdout: &str) -> Vec<String>`
//   helper (outside the cfg(windows) gate so it tests on Linux) and
//   have the shelling wrapper call it. `read_default_version` HAD the
//   same shape plus a real bug (first-digit-anywhere scan misread a
//   digit-bearing distro name like "Ubuntu-18.04" as version 1); its
//   parsing is now the extracted `parse_default_version`, tested below.
//   The UTF-16LE pitfall itself is avoided at the source:
//   `wsl_command()` sets WSL_UTF8=1.
// * `detect()` / persisted-state transitions — they take a
//   `tauri::AppHandle`, which can't be constructed in unit tests
//   without enabling tauri's "test" feature (`tauri::test::mock_app`)
//   as a dev-dependency.
// * `imp::PersistedState` round-trip — private to the cfg(windows)
//   `imp` module; only testable from a test module inside it (Windows-
//   only, unverifiable from this Linux box), so skipped.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gui_finalize_keeps_the_single_instance_owner_running() {
        assert!(!should_restart_after_wsl_finalize(crate::app_role::Role::Gui));
    }

    #[test]
    fn server_finalize_keeps_its_legacy_restart_fallback() {
        assert!(should_restart_after_wsl_finalize(crate::app_role::Role::Server));
    }

    fn to_json<T: Serialize>(v: &T) -> serde_json::Value {
        serde_json::to_value(v).expect("serialize")
    }

    // ── distro re-provisioning (WI-4479) ──
    //
    // These live HERE, in the plain #[cfg(test)] module, and NOT in the
    // #[cfg(all(test, target_os = "windows"))] `windows_tests` module below —
    // that one never compiles on the Linux dev box, so tests placed there look
    // written but never run. `distro_needs_reprovision` is deliberately
    // #[cfg(any(target_os = "windows", test))] precisely so its DECISION can be
    // pinned from Linux even though it only ever fires on Windows.

    /// THE regression this guards: an app update ships a new rootfs recipe, but
    /// the distro on disk was imported by an older one. Before this check, a
    /// distro that existed and started was `Ready` forever — so a fix to the
    /// rootfs reached new installs and nobody who already had the app. The
    /// Windows chat dock would have shipped "fixed" and still opened onto a dead
    /// `pui` for every existing user.
    #[test]
    fn a_distro_provisioned_by_an_older_recipe_is_stale() {
        assert!(distro_needs_reprovision(
            Some("new-recipe"),
            Some("old-recipe")
        ));
    }

    #[test]
    fn a_distro_matching_the_shipped_recipe_is_left_alone() {
        assert!(!distro_needs_reprovision(Some("same"), Some("same")));
        // Trailing newline from the resource file must not read as a mismatch —
        // that would re-bootstrap on every single launch, forever.
        assert!(!distro_needs_reprovision(Some("same\n"), Some("same")));
    }

    #[test]
    fn a_distro_with_no_recorded_recipe_is_treated_as_stale() {
        // Installs predating the marker: we cannot show the distro matches, so we
        // re-run the idempotent bootstrap rather than trust it. Failing toward
        // doing the work is the safe direction.
        assert!(distro_needs_reprovision(Some("recipe"), None));
    }

    #[test]
    fn an_unknown_shipped_recipe_never_forces_a_reprovision_loop() {
        // No shipped marker (a build predating it) → nothing to compare and
        // nothing we could record afterwards, so re-running would loop every
        // launch and never converge. Leave the distro alone.
        assert!(!distro_needs_reprovision(None, Some("whatever")));
        assert!(!distro_needs_reprovision(None, None));
    }

    // ── bootstrap network preflight (EI-20574262390154687) ──
    //
    // Same reason these live here as the re-provisioning tests above: the probe
    // itself only ever runs on Windows, so what gets pinned from Linux is the
    // DECISION — which hosts we predict, and what the user is told when one of
    // them is unreachable.

    #[test]
    fn everything_reachable_means_provisioning_proceeds() {
        // The "no news is good news" direction. If this ever returned Some(_),
        // the preflight would block every install on every machine.
        assert!(bootstrap_network_failure(&[]).is_none());
    }

    #[test]
    fn an_unreachable_host_is_named_along_with_what_it_is_for() {
        // The whole complaint being fixed is that the old failure was a raw
        // curl/apt error that named neither. Both halves must survive.
        let msg = bootstrap_network_failure(&[("nodejs.org", 443, "the pinned Node runtime")])
            .expect("an unreachable host must stop provisioning");
        assert!(msg.contains("nodejs.org"), "{msg}");
        assert!(msg.contains("the pinned Node runtime"), "{msg}");
    }

    #[test]
    fn every_unreachable_host_is_listed_not_just_the_first() {
        // A user behind a firewall that blocks two of the three should get to fix
        // both in one trip, not discover them one relaunch at a time.
        let msg = bootstrap_network_failure(&[
            ("github.com", 443, "the overmind process supervisor"),
            ("nodejs.org", 443, "the pinned Node runtime"),
        ])
        .expect("unreachable hosts must stop provisioning");
        assert!(msg.contains("github.com"), "{msg}");
        assert!(msg.contains("nodejs.org"), "{msg}");
    }

    #[test]
    fn the_failure_says_nothing_was_installed_and_names_the_override() {
        // Two promises the message must keep. "Nothing installed" is the entire
        // point of preflighting BEFORE `wsl --import` — the reported harm was a
        // failure landing after the installer claimed success. And because a
        // plain TCP probe cannot see a CONNECT-only proxy, a wrong verdict must
        // never be a dead end for the user.
        let msg = bootstrap_network_failure(&[("kopia.io", 443, "the kopia signing key")])
            .expect("an unreachable host must stop provisioning");
        assert!(msg.contains("Nothing has been installed yet"), "{msg}");
        assert!(msg.contains("PAPERCUP_SKIP_NETWORK_PREFLIGHT=1"), "{msg}");
    }

    #[test]
    fn the_preflight_list_does_not_drift_from_the_shipped_bootstrap_script() {
        // The failure mode this guards: someone adds a fourth download to
        // papercup-bootstrap.sh, the Windows preflight keeps passing, and the
        // user is back to a mid-provisioning curl error against a host nobody
        // checked. The script is the source of truth; this list predicts it.
        let script = include_str!("../resources/papercup-bootstrap.sh");

        for (host, _, _) in BOOTSTRAP_NETWORK_HOSTS {
            assert!(
                script.contains(host),
                "{host} is preflighted but no longer appears in papercup-bootstrap.sh"
            );
        }

        // …and the reverse direction, which is the one that actually catches
        // drift: every host the script fetches from must be preflighted.
        //
        // TWO fetch shapes, because the script has two. Scanning only `curl`
        // would leave this check blind to exactly the category that
        // `packages.kopia.io` belongs to — an apt repository the SCRIPT ITSELF
        // adds — so a second `deb` source could be added and never probed, in
        // the one direction that is supposed to catch drift.
        //
        // Apt MIRRORS baked into the rootfs stay out of scope deliberately (see
        // BOOTSTRAP_NETWORK_HOSTS): Windows cannot know them, so the bootstrap's
        // own preflight reads them from the image instead. Only sources this
        // script writes are statically knowable, and those are checked here.
        let mut fetch_hosts: Vec<String> = Vec::new();
        for line in script.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with('#') {
                continue; // a URL in a comment is documentation, not a fetch
            }
            let is_curl = trimmed.starts_with("curl ");
            let is_apt_source = trimmed.contains("deb [") || trimmed.contains("deb http");
            if !is_curl && !is_apt_source {
                continue;
            }
            let Some(scheme_end) = trimmed.find("://") else {
                continue;
            };
            let host: String = trimmed[scheme_end + 3..]
                .chars()
                .take_while(|c| !matches!(c, '/' | '"' | '\'' | ' '))
                .collect();
            if !host.is_empty() {
                fetch_hosts.push(host);
            }
        }

        // Positive control: a scan that silently matched nothing would make every
        // assertion below vacuous and read exactly like a clean pass.
        assert!(
            !fetch_hosts.is_empty(),
            "parsed zero fetch hosts out of papercup-bootstrap.sh — the scan broke, \
             so this test proves nothing"
        );

        // Per-leg positive control. The check above is satisfied by the curl leg
        // alone, so without this the apt-source leg could silently stop matching
        // and the gap it closes would reopen while the test still passed.
        assert!(
            fetch_hosts.iter().any(|h| h == "packages.kopia.io"),
            "the apt-source leg matched nothing — it has regressed to curl-only, \
             so a `deb` source could drift unprobed. Parsed: {fetch_hosts:?}"
        );

        for host in &fetch_hosts {
            assert!(
                BOOTSTRAP_NETWORK_HOSTS.iter().any(|(h, _, _)| h == host),
                "papercup-bootstrap.sh fetches from {host}, but the Windows preflight \
                 does not probe it — add it to BOOTSTRAP_NETWORK_HOSTS"
            );
        }
    }

    #[test]
    fn shipped_bootstrap_provisions_live_voice_e2e_dependencies() {
        // Regression: the live voice E2E documents and invokes these host
        // commands, but a fresh WSL runtime omitted the packages and failed
        // with an opaque spawnSync ENOENT before connecting. Keep the
        // shipped apt batch, the script's command declarations, and its
        // actionable preflight tied together from the Rust test suite that
        // runs on Linux as well as Windows.
        let bootstrap = include_str!("../resources/papercup-bootstrap.sh");
        let voice = include_str!("../../../apps/tui/scripts/live-operator-voice-e2e.mjs");
        let marker = "apt-get install -y --no-install-recommends \\\n";
        let (_, after_install) = bootstrap
            .split_once(marker)
            .expect("the bootstrap base-package install block must exist");
        let package_block = after_install
            .split_once("\n\n")
            .map(|(block, _)| block)
            .expect("the bootstrap package block must be terminated");

        for package in ["espeak-ng", "ffmpeg"] {
            assert!(
                package_block
                    .lines()
                    .any(|line| { line.trim().trim_end_matches('\\').trim() == package }),
                "{package} must stay in the shipped bootstrap apt batch"
            );
            assert!(
                voice.contains(&format!("command: '{package}'")),
                "live voice E2E must declare {package} for its preflight"
            );
        }
        assert!(
            voice.contains("preflightHostDependencies();"),
            "live voice E2E must preflight before socket discovery"
        );
        assert!(
            voice.contains("sudo apt-get update && sudo apt-get install -y"),
            "missing voice tools must include an actionable Ubuntu/WSL install path"
        );
    }

    // ── wslconfig_with_mirrored (WI-3360) ──

    #[test]
    fn wslconfig_none_creates_minimal_mirrored() {
        let out = wslconfig_with_mirrored(None).expect("a fresh file must be written");
        assert!(out.contains("[wsl2]"), "{out}");
        assert!(out.contains("networkingMode=mirrored"), "{out}");
    }

    #[test]
    fn wslconfig_respects_an_explicit_networkingmode() {
        // A user who picked ANY mode (even nat) keeps it — mirrored is a global
        // setting; we never override an explicit choice.
        assert_eq!(
            wslconfig_with_mirrored(Some("[wsl2]\nnetworkingMode=nat\n")),
            None
        );
        // Tolerate whitespace around the `=`.
        assert_eq!(
            wslconfig_with_mirrored(Some("[wsl2]\nnetworkingMode = mirrored\n")),
            None
        );
    }

    #[test]
    fn wslconfig_adds_key_into_existing_wsl2_section_without_clobbering() {
        let out = wslconfig_with_mirrored(Some("[wsl2]\nmemory=4GB\nprocessors=2\n"))
            .expect("must add the key");
        assert!(out.contains("memory=4GB"), "kept existing keys: {out}");
        assert!(out.contains("processors=2"), "kept existing keys: {out}");
        assert!(
            out.contains("networkingMode=mirrored"),
            "added the key: {out}"
        );
        // The added key sits inside the [wsl2] section.
        assert!(
            out.find("[wsl2]").unwrap() < out.find("networkingMode=mirrored").unwrap(),
            "networkingMode must be under [wsl2]: {out}"
        );
    }

    #[test]
    fn wslconfig_keeps_key_in_wsl2_when_another_section_follows() {
        // Insert must not spill past the [wsl2] section into a later one.
        let out = wslconfig_with_mirrored(Some("[wsl2]\nmemory=4GB\n[boot]\nsystemd=true\n"))
            .expect("must add the key");
        let ni = out.find("networkingMode=mirrored").unwrap();
        let boot = out.find("[boot]").unwrap();
        assert!(ni < boot, "networkingMode must land before [boot]: {out}");
    }

    #[test]
    fn wslconfig_appends_wsl2_section_when_absent() {
        let out = wslconfig_with_mirrored(Some("[boot]\nsystemd=true\n"))
            .expect("must append a [wsl2] section");
        assert!(
            out.contains("[boot]") && out.contains("systemd=true"),
            "kept [boot]: {out}"
        );
        assert!(
            out.contains("[wsl2]") && out.contains("networkingMode=mirrored"),
            "added [wsl2]: {out}"
        );
    }

    #[test]
    fn wslconfig_ignores_a_commented_out_networkingmode() {
        // A commented mode is not active — still add a live one.
        let out = wslconfig_with_mirrored(Some("[wsl2]\n# networkingMode=nat\n"))
            .expect("commented key is not a real setting");
        assert!(out.contains("networkingMode=mirrored"), "{out}");
    }

    // ── windows_psu_cmd_contents (WI-3044) ──

    #[test]
    fn psu_cmd_uses_the_proven_wsl_invocation_form() {
        let cmd = windows_psu_cmd_contents();
        // WI-2955: --distribution/--cd/--exec, never `-d … --` (distro-shell
        // re-parse + cwd-translation failure on the minimal rootfs).
        assert!(cmd.contains("--distribution papercup-runtime"));
        assert!(cmd.contains("--cd ~"));
        assert!(cmd.contains("--exec /usr/bin/env TERM=xterm-256color"));
        assert!(
            !cmd.contains(" -d "),
            "short -d form is the WI-2955 trap: {cmd}"
        );
    }

    #[test]
    fn psu_cmd_forwards_args_as_positionals_not_a_reparsed_string() {
        let cmd = windows_psu_cmd_contents();
        // bash -lc '… "$@"' psu %*  — user args land as $1.. verbatim.
        assert!(
            cmd.contains(r#"\"$@\""#),
            "missing \"$@\" forwarding: {cmd}"
        );
        let wsl_line = cmd
            .lines()
            .find(|l| l.starts_with("wsl.exe"))
            .expect("psu.cmd has a wsl.exe line");
        assert!(
            wsl_line.trim_end().ends_with("psu %*"),
            "missing cmd-side %* tail on the wsl line: {cmd}"
        );
        assert!(
            cmd.contains("$HOME/.papercusp/bin/psu"),
            "missing $HOME shim path: {cmd}"
        );
    }

    #[test]
    fn psu_cmd_resets_terminal_modes_after_exit_and_preserves_exit_code() {
        // WI-3295: a hard-killed TUI (wsl shutdown/crash mid-session) leaves
        // mouse-tracking / bracketed-paste / hidden-cursor armed in the
        // surviving console; the reset tail must run AFTER wsl.exe, disable
        // every mode class, write to stderr (redirected stdout stays clean),
        // and still return psu's real exit code.
        let cmd = windows_psu_cmd_contents();
        for seq in [
            "[?1049l", // leave alt screen
            "[!p",     // DECSTR soft reset (DECCKM etc.)
            "[?1000l", "[?1002l", "[?1003l", "[?1006l", // mouse tracking
            "[?2004l", // bracketed paste
            "[?25h",   // show cursor
            "[0m",     // SGR attributes
        ] {
            assert!(cmd.contains(seq), "reset tail missing {seq}: {cmd}");
        }
        assert!(
            cmd.contains("[Console]::Error.Write"),
            "reset must go to stderr, not stdout: {cmd}"
        );
        let wsl_at = cmd.find("wsl.exe").expect("wsl line");
        let save_at = cmd
            .find("set PSU_EXIT=%ERRORLEVEL%")
            .expect("exit-code capture");
        let reset_at = cmd.find("[?1003l").expect("reset tail");
        assert!(
            wsl_at < save_at && save_at < reset_at,
            "exit code must be captured after wsl.exe and before the reset: {cmd}"
        );
        assert!(
            cmd.trim_end().ends_with("exit /b %PSU_EXIT%"),
            "psu's exit code must survive the reset tail: {cmd}"
        );
    }

    #[test]
    fn psu_cmd_is_crlf_and_ascii() {
        // cmd.exe wants CRLF; and non-ASCII in generated Windows scripts is
        // the encoding trap that broke the build ps1 (BOM-less CP-1252 read).
        let cmd = windows_psu_cmd_contents();
        assert!(cmd.contains("\r\n"));
        assert!(cmd.is_ascii(), "psu.cmd must stay pure ASCII: {cmd}");
    }

    // ── windows_papercusp_cmd_contents (papercusp CLI on Windows, 2026-07-08) ──

    #[test]
    fn papercusp_cmd_mirrors_psu_form_but_targets_the_papercusp_cli() {
        let cmd = windows_papercusp_cmd_contents();
        // Same hardened wsl form as psu.cmd (single source: windows_cli_cmd_contents).
        assert!(cmd.contains("--distribution papercup-runtime"));
        assert!(cmd.contains("--cd ~"));
        assert!(cmd.contains("--exec /usr/bin/env TERM=xterm-256color"));
        assert!(
            !cmd.contains(" -d "),
            "short -d form is the WI-2955 trap: {cmd}"
        );
        // Targets the `papercusp` CLI (so `papercusp tutorial` works), not psu.
        assert!(
            cmd.contains("$HOME/.papercusp/bin/papercusp"),
            "missing papercusp $HOME shim path: {cmd}"
        );
        let wsl_line = cmd
            .lines()
            .find(|l| l.starts_with("wsl.exe"))
            .expect("papercusp.cmd has a wsl.exe line");
        assert!(
            wsl_line.trim_end().ends_with("papercusp %*"),
            "missing papercusp %* tail: {cmd}"
        );
        assert!(
            cmd.contains(r#"\"$@\""#),
            "missing \"$@\" forwarding: {cmd}"
        );
        assert!(
            !cmd.contains("exec psu "),
            "must target papercusp, not psu: {cmd}"
        );
        // exit-code capture uses a papercusp-scoped var and survives the reset tail.
        assert!(cmd.contains("set PAPERCUSP_EXIT=%ERRORLEVEL%"));
        assert!(cmd.trim_end().ends_with("exit /b %PAPERCUSP_EXIT%"));
        assert!(cmd.contains("\r\n") && cmd.is_ascii());
    }

    // ── windows_terminal_fragment_contents (WI-3299) ──

    #[test]
    fn wt_fragment_is_valid_json_with_a_single_psu_profile() {
        let frag = windows_terminal_fragment_contents();
        let v: serde_json::Value =
            serde_json::from_str(&frag).expect("WT fragment must be valid JSON");
        let profiles = v
            .get("profiles")
            .and_then(|p| p.as_array())
            .expect("fragment has a `profiles` array");
        assert_eq!(profiles.len(), 1, "exactly one profile: {frag}");
        assert_eq!(
            profiles[0].get("name").and_then(|n| n.as_str()),
            Some("Papercusp (psu)"),
            "profile name is the WT-dropdown label: {frag}"
        );
    }

    #[test]
    fn wt_fragment_delegates_to_psu_cmd_never_a_duplicated_wsl_line() {
        // The whole point of routing through cmd.exe /c …\psu.cmd is that the
        // wsl invocation lives in ONE place (WI-2955/3033/3295). A wsl.exe line
        // re-embedded here would silently drift from that hardening.
        let frag = windows_terminal_fragment_contents();
        let v: serde_json::Value = serde_json::from_str(&frag).expect("valid JSON");
        let cl = v["profiles"][0]["commandline"]
            .as_str()
            .expect("profile has a `commandline`");
        assert!(
            cl.starts_with("cmd.exe /c"),
            "psu.cmd is a batch file — must run via cmd.exe /c: {cl}"
        );
        assert!(
            cl.contains(r"\Papercusp\bin\psu.cmd"),
            "commandline must launch the psu.cmd shim: {cl}"
        );
        assert!(
            !frag.contains("wsl.exe") && !frag.contains("--distribution"),
            "fragment must delegate to psu.cmd, not re-embed the wsl invocation: {frag}"
        );
    }

    #[test]
    fn wt_fragment_is_ascii() {
        // Same encoding trap as the other generated Windows artifacts.
        assert!(
            windows_terminal_fragment_contents().is_ascii(),
            "WT fragment must stay pure ASCII"
        );
    }

    #[test]
    fn path_setup_ps1_preserves_reg_expand_sz_and_broadcasts() {
        // Raw read (no %VAR% expansion), ExpandString write-back, and the
        // WM_SETTINGCHANGE broadcast — the three invariants that keep the
        // user PATH intact for other apps and visible to new shells.
        assert!(WINDOWS_PATH_SETUP_PS1.contains("DoNotExpandEnvironmentNames"));
        assert!(WINDOWS_PATH_SETUP_PS1.contains("ExpandString"));
        assert!(WINDOWS_PATH_SETUP_PS1.contains("SendMessageTimeout"));
        assert!(
            WINDOWS_PATH_SETUP_PS1.contains("-notcontains $dir"),
            "idempotency guard missing"
        );
        assert!(
            WINDOWS_PATH_SETUP_PS1.is_ascii(),
            "ps1 must stay pure ASCII"
        );
    }

    // ── parse_default_version (extracted from imp::read_default_version) ──

    #[test]
    fn parse_default_version_reads_the_version_line_not_the_first_digit() {
        // Regression: a digit-bearing distro name sits ABOVE the version
        // line in `wsl --status` output; the old first-digit-anywhere scan
        // reported version 1 here.
        let out = "Default Distribution: Ubuntu-18.04\nDefault Version: 2\n";
        assert_eq!(parse_default_version(out), 2);
    }

    #[test]
    fn parse_default_version_is_locale_tolerant() {
        // No English label text is matched — only the bare-integer value
        // shape after the last colon.
        let out = "Distribution par défaut : Ubuntu\nVersion par défaut : 2\n";
        assert_eq!(parse_default_version(out), 2);
    }

    #[test]
    fn parse_default_version_ignores_dotted_version_noise() {
        let out = "WSL version: 2.0.9.0\nKernel version: 5.15.133.1-1\nDefault Version: 1\n";
        assert_eq!(parse_default_version(out), 1);
    }

    #[test]
    fn parse_default_version_returns_zero_when_no_version_line() {
        assert_eq!(parse_default_version(""), 0);
        assert_eq!(parse_default_version("Default Distribution: Ubuntu\n"), 0);
    }

    // ── WslState wire shape ─────────────────────────────────────────

    #[test]
    fn wsl_state_kind_tag_is_pascal_case() {
        // The WslOnboardingGate matches these exact strings; a stray
        // `rename_all = "camelCase"` would make the gate's pass-through
        // check fail on Linux (see the comment on WslState).
        let cases: [(WslState, &str); 6] = [
            (WslState::NotSupported, "NotSupported"),
            (WslState::NotInstalled, "NotInstalled"),
            (WslState::PendingReboot, "PendingReboot"),
            (WslState::InstalledNoDistro, "InstalledNoDistro"),
            (WslState::PendingBootstrap, "PendingBootstrap"),
            (WslState::Ready, "Ready"),
        ];
        for (state, kind) in cases {
            assert_eq!(to_json(&state), serde_json::json!({ "kind": kind }));
        }
    }

    #[test]
    fn wsl_state_error_inlines_message_next_to_kind() {
        let j = to_json(&WslState::Error {
            message: "bootstrap exit=1".into(),
        });
        assert_eq!(
            j,
            serde_json::json!({ "kind": "Error", "message": "bootstrap exit=1" })
        );
    }

    #[test]
    fn wsl_state_rejects_camel_case_kind() {
        // PascalCase deserializes; camelCase must NOT silently work —
        // it would mask a frontend/backend tag-casing drift.
        assert!(serde_json::from_str::<WslState>(r#"{"kind":"NotSupported"}"#).is_ok());
        assert!(serde_json::from_str::<WslState>(r#"{"kind":"notSupported"}"#).is_err());
    }

    #[test]
    fn wsl_state_round_trips_through_json() {
        let states = [
            WslState::NotSupported,
            WslState::NotInstalled,
            WslState::PendingReboot,
            WslState::InstalledNoDistro,
            WslState::PendingBootstrap,
            WslState::Ready,
            WslState::Error {
                message: "boom".into(),
            },
        ];
        for state in states {
            let j = to_json(&state);
            let back: WslState = serde_json::from_value(j.clone()).expect("deserialize");
            assert_eq!(to_json(&back), j, "round-trip changed {:?}", state);
        }
    }

    // ── WslOpError wire shape ───────────────────────────────────────

    #[test]
    fn wsl_op_error_uses_kind_plus_message_layout() {
        // tag = "kind", content = "message" — the frontend reads
        // `err.kind` to decide elevate-vs-retry and `err.message` for
        // diagnostics.
        let j = to_json(&WslOpError::NeedsElevation("wsl --install: denied".into()));
        assert_eq!(
            j,
            serde_json::json!({ "kind": "NeedsElevation", "message": "wsl --install: denied" })
        );
        let j = to_json(&WslOpError::Failed("wsl --install exit=1 stderr=".into()));
        assert_eq!(
            j,
            serde_json::json!({ "kind": "Failed", "message": "wsl --install exit=1 stderr=" })
        );
    }

    #[test]
    fn wsl_op_error_round_trips_through_json() {
        let back: WslOpError =
            serde_json::from_str(r#"{"kind":"NeedsElevation","message":"m"}"#).expect("de");
        assert!(matches!(back, WslOpError::NeedsElevation(ref m) if m == "m"));
        let back: WslOpError =
            serde_json::from_str(r#"{"kind":"Failed","message":"f"}"#).expect("de");
        assert!(matches!(back, WslOpError::Failed(ref m) if m == "f"));
    }

    // ── WslStatus wire shape ────────────────────────────────────────

    #[test]
    fn wsl_status_serializes_camel_case_fields() {
        let st = WslStatus {
            state: WslState::Ready,
            wsl_exe_available: true,
            distros: vec!["papercup-runtime".into()],
            default_version: 2,
        };
        assert_eq!(
            to_json(&st),
            serde_json::json!({
                "state": { "kind": "Ready" },
                "wslExeAvailable": true,
                "distros": ["papercup-runtime"],
                "defaultVersion": 2,
            })
        );
    }

    #[test]
    fn wsl_status_unsupported_is_the_non_windows_shape() {
        // This is what `detect()` returns on every non-Windows platform
        // — the gate must see NotSupported and pass straight through.
        let st = WslStatus::unsupported();
        assert!(matches!(st.state, WslState::NotSupported));
        assert!(!st.wsl_exe_available);
        assert!(st.distros.is_empty());
        assert_eq!(st.default_version, 0);
    }

    #[test]
    fn wsl_status_round_trips_through_json() {
        let j = to_json(&WslStatus::unsupported());
        let back: WslStatus = serde_json::from_value(j.clone()).expect("deserialize");
        assert_eq!(to_json(&back), j);
    }
}

// Windows-only pure logic: the exit-code → error-variant mapping.
// `WslOpError::from_exit` is cfg(windows), so these can't run on the
// Linux dev box (they're compiled out here and execute on a Windows
// `cargo test`); the cross-platform suite above stays runnable
// everywhere.
#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;

    #[test]
    fn from_exit_maps_740_to_needs_elevation() {
        // Win32 ERROR_ELEVATION_REQUIRED — frontend offers "re-launch
        // as admin" instead of a raw error.
        match WslOpError::from_exit("wsl --install", Some(740), "access denied".into()) {
            WslOpError::NeedsElevation(msg) => {
                assert_eq!(msg, "wsl --install: access denied");
            }
            other => panic!("expected NeedsElevation, got {:?}", other),
        }
    }

    #[test]
    fn from_exit_other_codes_map_to_failed() {
        match WslOpError::from_exit("wsl --import", Some(1), "boom".into()) {
            WslOpError::Failed(msg) => {
                assert!(msg.contains("wsl --import"), "label missing: {}", msg);
                assert!(msg.contains("exit=1"), "exit code missing: {}", msg);
                assert!(msg.contains("stderr=boom"), "stderr missing: {}", msg);
            }
            other => panic!("expected Failed, got {:?}", other),
        }
    }

    #[test]
    fn from_exit_without_code_formats_unknown_exit() {
        // No exit code (process killed) → "exit=?", never a panic.
        match WslOpError::from_exit("wsl --install", None, String::new()) {
            WslOpError::Failed(msg) => assert!(msg.contains("exit=?"), "got: {}", msg),
            other => panic!("expected Failed, got {:?}", other),
        }
    }
}
