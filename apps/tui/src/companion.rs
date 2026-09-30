//! Companion zellij-plugin link (SP-TUI P-004 / D-008).
//!
//! `pui` stays the external brain; the companion plugin is its eyes + hands
//! *inside* zellij. They're joined by ONE long-lived `zellij pipe -p <plugin>`
//! child this module owns:
//!
//! ```text
//!   pui  ──cmd lines──▶ child stdin ──▶ plugin pipe()      (focus / open / close…)
//!   pui  ◀──ev lines── child stdout ◀── plugin cli_pipe_output  (topology / pane-exit)
//! ```
//!
//! The wire types live in `pui-companion-proto` (one source of truth for both
//! ends). Inbound plugin events are normalised into the app's [`Event`] stream;
//! outbound commands go through a [`Companion`] handle the run-loop holds.
//!
//! ### Why the heartbeat
//! The `zellij pipe` CLI only drains the plugin's async `cli_pipe_output` while
//! it is in its server-recv loop (between sending a stdin line and the
//! auto-unblock); when idle it blocks on `read_line`. So a pane that exits while
//! `pui` is idle wouldn't surface until `pui`'s next write. We send a periodic
//! [`Command::Ping`] to keep that loop cycling — it *bounds* event latency, it
//! is not busy-work. (Verified against zellij 0.44.3 `cli_client::pipe_client`.)
//!
//! ### When it's active
//! Only when `pui` runs inside zellij (`$ZELLIJ` set) AND the plugin wasm is
//! resolvable. Otherwise `spawn` returns `None` and `pui` falls back to firing
//! `zellij action` (see `mux`). Everything here is best-effort and never panics.
#![allow(dead_code)] // focus/close/snapshot are the orchestration API the
                     // workbench wires in as it grows (focus-following etc.),
                     // same forward-looking surface as `mux`/`client`.

use crate::event::Event;
use crate::mux::PaneSpec;
use pui_companion_proto::{Command, PluginEvent};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::{self, UnboundedSender};

/// The `--name` the pipe is opened with; the plugin binds only to this name.
const PIPE_NAME: &str = "pui";

/// Heartbeat cadence — bounds how stale an async plugin event can get (see the
/// module doc). 750ms is imperceptible for a workbench yet cheap.
const HEARTBEAT: Duration = Duration::from_millis(750);

/// A handle to the live companion link. Cloneable-ish via the command sender;
/// dropping the last handle ends the writer task and (via `kill_on_drop`) the
/// `zellij pipe` child.
pub struct Companion {
    cmd_tx: UnboundedSender<Command>,
}

impl Companion {
    /// Spawn the companion child, wiring its stdout into `tx` as [`Event`]s and
    /// returning a handle to send it commands. Returns `None` (and, for a
    /// *resolvable-but-missing* wasm, emits an `Event::Error`) when the link
    /// can't be established — `pui` then runs exactly as before.
    ///
    /// Must be called inside the tokio runtime (it spawns reader/writer tasks).
    pub fn spawn(tx: UnboundedSender<Event>) -> Option<Companion> {
        if !inside_zellij() {
            // Standalone pane / not under zellij — nothing to drive. Silent: this
            // is the normal case for `pui` opened outside the workbench.
            return None;
        }
        let wasm = match companion_wasm_path() {
            Some(p) => p,
            None => {
                let _ = tx.send(Event::Error(
                    "companion: pui-companion.wasm not found (build apps/pui-zellij-plugin \
                     and install to ~/.papercusp/, or set PUI_COMPANION_WASM)"
                        .to_string(),
                ));
                return None;
            }
        };
        let url = plugin_url(&wasm);

        let mut child = match tokio::process::Command::new("zellij")
            .args(pipe_argv(&url).into_iter().skip(1)) // skip "zellij" (program name)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(Event::Error(format!("companion: spawn zellij pipe: {e}")));
                return None;
            }
        };

        let stdout = child.stdout.take()?;
        let stdin = child.stdin.take()?;

        // Reader: child stdout (JSON lines from the plugin) → Event stream.
        let tx_reader = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                match PluginEvent::from_line(&line) {
                    Ok(ev) => {
                        if tx_reader.send(map_plugin_event(ev)).is_err() {
                            return; // app gone
                        }
                    }
                    // zellij may emit the odd non-JSON log line; ignore it.
                    Err(_) => continue,
                }
            }
        });

        // Writer: drain the command channel + heartbeat → child stdin. Owns the
        // `child` so the process is killed when this task ends (pui shutdown).
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Command>();
        // Prime the link: Hello makes the plugin capture our pipe id and send an
        // immediate snapshot.
        let _ = cmd_tx.send(Command::Hello);
        tokio::spawn(async move {
            let _child = child; // keep alive for kill_on_drop
            let mut stdin = stdin;
            let mut hb = tokio::time::interval(HEARTBEAT);
            hb.tick().await; // drop the immediate first tick
            loop {
                let line = tokio::select! {
                    cmd = cmd_rx.recv() => match cmd {
                        Some(c) => c.to_line(),
                        None => break, // all handles dropped → shut down
                    },
                    _ = hb.tick() => Command::Ping.to_line(),
                };
                if stdin
                    .write_all(format!("{line}\n").as_bytes())
                    .await
                    .is_err()
                {
                    break; // pipe closed → child gone
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        Some(Companion { cmd_tx })
    }

    /// Send a raw command (best-effort; a dead link is a silent no-op).
    pub fn send(&self, cmd: Command) {
        let _ = self.cmd_tx.send(cmd);
    }

    /// Open a pane for `spec` via the plugin's real host command (vs the
    /// fire-and-forget `zellij action new-pane` fallback). Agent launches are a
    /// DOCKVIEW launch (`stack: true`): the plugin stacks the new pane into the
    /// work-area group so agents pile up tab-like instead of tiling thinner
    /// (dockview-workbench D-008).
    pub fn open_pane(&self, spec: &PaneSpec) {
        self.send(spec_to_open_command(spec, true));
    }

    /// Focus a terminal pane by id.
    pub fn focus_pane(&self, pane_id: u32) {
        self.send(Command::FocusPane { pane_id });
    }

    /// Close a terminal pane by id.
    pub fn close_pane(&self, pane_id: u32) {
        self.send(Command::ClosePane { pane_id });
    }

    /// Ask for a fresh topology snapshot now.
    pub fn snapshot(&self) {
        self.send(Command::Snapshot);
    }

    /// `:stack` — gather these terminal panes into one stacked group (D-008).
    pub fn stack_panes(&self, pane_ids: Vec<u32>) {
        self.send(Command::StackPanes { pane_ids });
    }

    /// `:float` — float a tiled pane / embed a floating one (D-008).
    pub fn toggle_float(&self, pane_id: u32) {
        self.send(Command::TogglePaneFloat { pane_id });
    }

    /// `:dock <side>` / `:layout <name>` — switch to a named swap-layout preset
    /// (the plugin cycles until the active preset matches, D-008).
    pub fn select_swap_layout(&self, name: String) {
        self.send(Command::SelectSwapLayout { name });
    }

    /// `:layout next` — cycle to the next swap-layout preset.
    pub fn next_swap_layout(&self) {
        self.send(Command::NextSwapLayout);
    }

    /// `:layout prev` — cycle to the previous swap-layout preset.
    pub fn prev_swap_layout(&self) {
        self.send(Command::PrevSwapLayout);
    }
}

/// Are we running inside a zellij session? (`$ZELLIJ` is set by zellij for every
/// pane/command it owns.)
fn inside_zellij() -> bool {
    std::env::var_os("ZELLIJ").is_some()
}

/// Resolve the plugin wasm: `$PUI_COMPANION_WASM` override, else the companion
/// named by the release manifest beside the running binary (an installed release
/// unit carries its own matched companion — P-011 / D-016 — and must never pick
/// up a stale developer copy), else `~/.papercusp/pui-companion.wasm`. Returns
/// `None` if none exists.
fn companion_wasm_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("PUI_COMPANION_WASM") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Some(pb) = std::env::current_exe()
        .ok()
        .and_then(|exe| crate::install::release_companion_of(&exe))
        .filter(|pb| pb.exists())
    {
        return Some(pb);
    }
    let pb = dirs::home_dir()?
        .join(".papercusp")
        .join("pui-companion.wasm");
    pb.exists().then_some(pb)
}

/// zellij plugin URL for a local wasm file (absolute path → `file:/abs/path`).
fn plugin_url(path: &Path) -> String {
    format!("file:{}", path.display())
}

/// argv for the long-lived duplex child: `zellij pipe --name pui --plugin <url>`.
/// No payload arg → the CLI listens on stdin and streams plugin output to stdout.
fn pipe_argv(plugin_url: &str) -> Vec<String> {
    vec![
        "zellij".to_string(),
        "pipe".to_string(),
        "--name".to_string(),
        PIPE_NAME.to_string(),
        "--plugin".to_string(),
        plugin_url.to_string(),
    ]
}

/// Turn a [`PaneSpec`] into the open-command-pane command. `argv[0]` is the
/// program (`psu` resolves beside the running pui first, D-031); the rest are
/// args. cwd is left to zellij's default (the workbench cwd); the title rides
/// along for traceability. `stack` requests the dockview stack-on-open
/// behavior (D-008).
fn spec_to_open_command(spec: &PaneSpec, stack: bool) -> Command {
    let (command, args) = spec
        .argv
        .split_first()
        .map(|(c, rest)| (crate::remote_connect::pane_program(c), rest.to_vec()))
        .unwrap_or_else(|| (String::new(), Vec::new()));
    Command::OpenCommandPane {
        command,
        args,
        cwd: None,
        title: spec.title.clone(),
        stack,
    }
}

/// Normalise one plugin event into the app's [`Event`] stream.
fn map_plugin_event(ev: PluginEvent) -> Event {
    match ev {
        PluginEvent::Hello { plugin_version } => Event::CompanionReady(plugin_version),
        PluginEvent::Topology(t) => Event::Topology(t),
        PluginEvent::PaneExited { pane_id, exit_code } => Event::PaneExited { pane_id, exit_code },
        PluginEvent::PaneClosed { pane_id } => Event::PaneClosed { pane_id },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pui_companion_proto::{PaneNode, TabNode, Topology};

    #[test]
    fn pipe_argv_shape() {
        assert_eq!(
            pipe_argv("file:/home/u/.papercusp/pui-companion.wasm"),
            vec![
                "zellij",
                "pipe",
                "--name",
                "pui",
                "--plugin",
                "file:/home/u/.papercusp/pui-companion.wasm"
            ]
        );
    }

    #[test]
    fn plugin_url_prefixes_file_scheme() {
        let p = PathBuf::from("/home/u/.papercusp/pui-companion.wasm");
        assert_eq!(plugin_url(&p), "file:/home/u/.papercusp/pui-companion.wasm");
    }

    #[test]
    fn spec_becomes_open_command_pane() {
        let spec = PaneSpec::new(["psu", "--no-picker", "--agent=claude"]).titled("pui · claude");
        match spec_to_open_command(&spec, true) {
            Command::OpenCommandPane {
                command,
                args,
                cwd,
                title,
                stack,
            } => {
                assert_eq!(command, "psu");
                assert_eq!(args, vec!["--no-picker", "--agent=claude"]);
                assert_eq!(cwd, None);
                assert_eq!(title.as_deref(), Some("pui · claude"));
                assert!(
                    stack,
                    "agent launches request stack-on-open (dockview D-008)"
                );
            }
            other => panic!("expected OpenCommandPane, got {other:?}"),
        }
        // A non-stacking open (e.g. a plain shell) carries stack:false.
        match spec_to_open_command(&PaneSpec::new(["bash"]), false) {
            Command::OpenCommandPane { stack, .. } => assert!(!stack),
            other => panic!("expected OpenCommandPane, got {other:?}"),
        }
    }

    #[test]
    fn maps_each_plugin_event() {
        assert!(matches!(
            map_plugin_event(PluginEvent::Hello { plugin_version: "0.1.0".into() }),
            Event::CompanionReady(v) if v == "0.1.0"
        ));
        assert!(matches!(
            map_plugin_event(PluginEvent::Topology(Topology::default())),
            Event::Topology(_)
        ));
        assert!(matches!(
            map_plugin_event(PluginEvent::PaneExited {
                pane_id: 3,
                exit_code: Some(1)
            }),
            Event::PaneExited {
                pane_id: 3,
                exit_code: Some(1)
            }
        ));
        assert!(matches!(
            map_plugin_event(PluginEvent::PaneClosed { pane_id: 7 }),
            Event::PaneClosed { pane_id: 7 }
        ));
    }

    #[test]
    fn topology_event_carries_the_payload() {
        let topo = Topology {
            tabs: vec![TabNode {
                pos: 0,
                name: "papercup".into(),
                active: true,
                swap_layout: None,
                swap_dirty: false,
            }],
            panes: vec![PaneNode {
                id: 1,
                tab: 0,
                title: "claude".into(),
                focused: true,
                is_plugin: false,
                exited: false,
                command: None,
            }],
        };
        match map_plugin_event(PluginEvent::Topology(topo.clone())) {
            Event::Topology(t) => assert_eq!(t, topo),
            other => panic!("expected Topology, got {other:?}"),
        }
    }
}
