//! Wire protocol for the `pui` ↔ companion-zellij-plugin full-duplex link
//! (SP-TUI P-004 / D-008).
//!
//! The link is ONE long-lived `zellij pipe -p <plugin>` child process. `pui`
//! writes [`Command`] JSON lines to the child's **stdin** (→ the plugin's
//! `pipe()` handler); the plugin writes [`PluginEvent`] JSON lines back via
//! `cli_pipe_output` → the child's **stdout** (→ `pui` reads). One JSON object
//! per line, newline-delimited — that's what makes the CLI's line-buffered
//! `read_line` deliver exactly one message per `pipe()` call.
//!
//! Both ends — the native `pui` binary and the `wasm32-wasip1` plugin — depend
//! on THIS crate, so there is a single source of truth for the format and the
//! round-trip tests below pin it. Adding a field/variant here updates both
//! sides at once; drift is impossible by construction.

use serde::{Deserialize, Serialize};

/// A command `pui` sends to the plugin (stdin → `pipe()`).
///
/// Serialized with an internal `cmd` tag, e.g. `{"cmd":"focus_pane","pane_id":12}`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    /// Prime the channel and ask for an immediate snapshot. `pui` sends this
    /// first so the plugin learns the pipe id it must echo events back on.
    Hello,
    /// Heartbeat. The CLI pipe only drains the plugin's async `cli_pipe_output`
    /// while it's in its recv loop (between sending a stdin line and the
    /// auto-unblock); when idle it blocks on `read_line`. A periodic `Ping`
    /// keeps that loop cycling so queued events (pane-exit, focus) flush
    /// promptly — it bounds event latency, it is not busy-work.
    Ping,
    /// Request a full [`Topology`] snapshot right now.
    Snapshot,
    /// Focus a terminal pane by id.
    FocusPane { pane_id: u32 },
    /// Close a pane by (terminal) id.
    ClosePane { pane_id: u32 },
    /// Open a command pane running `command` + `args` — the agent-launch path
    /// (reliable host command vs fire-and-forget `zellij action new-pane`).
    ///
    /// `stack: true` makes this a DOCKVIEW launch: the plugin opens the pane,
    /// takes the synchronously-returned PaneId, and stacks it into the work-area
    /// group (the new pane + the other work panes) so agents pile up tab-like
    /// instead of tiling thinner (dockview-workbench D-008). It must be the
    /// plugin (not declarative reflow) because launches fire from the HUD pane,
    /// and a plain open from HUD focus splits the HUD rather than joining the
    /// stack (measured, D-007).
    OpenCommandPane {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        stack: bool,
    },
    /// Open a new tab from a stringified KDL `layout` (and optional `name`).
    NewTab {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        layout: Option<String>,
    },
    /// Rename a tab by id.
    RenameTab { tab_id: u32, name: String },
    /// Gather these terminal panes into one stacked group (the `:stack` dock-verb,
    /// D-008). Id-addressed + focus-independent — the repair path when the user
    /// has re-tiled the work area. Ids are terminal-pane ids (from [`Topology`]).
    StackPanes { pane_ids: Vec<u32> },
    /// Float a tiled pane, or embed a floating one (the `:float` dock-verb) —
    /// `toggle_pane_embed_or_eject` for one terminal pane. Round-trips cleanly:
    /// embedding restores the pane to its declared slot (measured, D-007).
    TogglePaneFloat { pane_id: u32 },
    /// Switch to the named swap-layout preset (`:dock`/`:layout <name>`, D-008).
    /// The plugin advances `next_swap_layout` until the tab's active preset
    /// matches `name` (bounded), so it works regardless of the current preset.
    SelectSwapLayout { name: String },
    /// Cycle to the next swap-layout preset (`:layout next`; mirrors `Alt+]`).
    NextSwapLayout,
    /// Cycle to the previous swap-layout preset (`:layout prev`; mirrors `Alt+[`).
    PrevSwapLayout,
}

/// serde `skip_serializing_if` for a `false` bool — keeps optional bool flags off
/// the wire when unset (so existing message shapes are byte-stable).
fn is_false(b: &bool) -> bool {
    !*b
}

/// An event the plugin sends to `pui` (`cli_pipe_output` → stdout).
///
/// Serialized with an internal `ev` tag, e.g. `{"ev":"pane_exited","pane_id":12,…}`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub enum PluginEvent {
    /// Handshake ack — the first thing the plugin emits once it has the pipe id.
    Hello { plugin_version: String },
    /// The full live topology. Emitted on every `PaneUpdate`/`TabUpdate` and in
    /// response to `Hello`/`Snapshot`/`Ping`. Idempotent: `pui` just replaces
    /// its stored topology, so no diff bookkeeping is needed on either side.
    Topology(Topology),
    /// A command pane's command exited (and the pane is held) — the
    /// crash/finish signal `pui` uses to offer/auto-relaunch an agent. Sent as a
    /// discrete event (not inferred from a snapshot diff) so it's unambiguous.
    PaneExited {
        pane_id: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
    },
    /// A pane was fully closed.
    PaneClosed { pane_id: u32 },
}

/// A compact view of the live zellij session: its tabs and panes.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
pub struct Topology {
    pub tabs: Vec<TabNode>,
    pub panes: Vec<PaneNode>,
}

/// One tab in the live session.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct TabNode {
    /// 0-based tab position (what `go-to-tab N` uses as `N-1`).
    pub pos: u32,
    pub name: String,
    pub active: bool,
    /// The active swap-layout preset name, if any (dockview-workbench D-008). pui
    /// shows this as the live preset label and uses it as the feedback signal for
    /// `SelectSwapLayout`. serde-default for wire-compat with older plugins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swap_layout: Option<String>,
    /// Whether the layout has been hand-modified away from the active preset
    /// (zellij's `is_swap_layout_dirty`) — pui can hint "re-tiled" / offer :stack.
    #[serde(default, skip_serializing_if = "is_false")]
    pub swap_dirty: bool,
}

/// One pane in the live session (terminal or plugin).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PaneNode {
    /// Pane id, unique among panes of its kind (terminal vs plugin).
    pub id: u32,
    /// Position of the tab this pane lives in (matches [`TabNode::pos`]).
    pub tab: u32,
    pub title: String,
    pub focused: bool,
    pub is_plugin: bool,
    /// A command pane whose command has exited but the pane is still held.
    pub exited: bool,
    /// Stringified command + args, if this is a command pane.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

impl Command {
    /// Encode to a single newline-free JSON line. Infallible for these types.
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).expect("Command always serializes")
    }
    /// Parse one line (trailing newline / whitespace tolerated).
    pub fn from_line(line: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(line.trim())
    }
}

impl PluginEvent {
    /// Encode to a single newline-free JSON line. Infallible for these types.
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).expect("PluginEvent always serializes")
    }
    /// Parse one line (trailing newline / whitespace tolerated).
    pub fn from_line(line: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(line.trim())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_round_trips() {
        let cases = vec![
            Command::Hello,
            Command::Ping,
            Command::Snapshot,
            Command::FocusPane { pane_id: 12 },
            Command::ClosePane { pane_id: 3 },
            Command::OpenCommandPane {
                command: "psu".into(),
                args: vec!["--no-picker".into(), "--agent=claude".into()],
                cwd: Some("/home/u/repo".into()),
                title: Some("pui · claude".into()),
                stack: true,
            },
            Command::OpenCommandPane {
                command: "bash".into(),
                args: vec![],
                cwd: None,
                title: None,
                stack: false,
            },
            Command::NewTab {
                name: Some("papercup".into()),
                layout: Some("layout { pane }".into()),
            },
            Command::RenameTab {
                tab_id: 2,
                name: "docs".into(),
            },
            Command::StackPanes {
                pane_ids: vec![1, 4, 7],
            },
            Command::TogglePaneFloat { pane_id: 3 },
            Command::SelectSwapLayout {
                name: "stacked-left".into(),
            },
            Command::NextSwapLayout,
            Command::PrevSwapLayout,
        ];
        for c in cases {
            let line = c.to_line();
            assert!(!line.contains('\n'), "a line must be newline-free: {line}");
            assert_eq!(Command::from_line(&line).unwrap(), c);
            // tolerate the trailing newline the CLI's read_line leaves on.
            assert_eq!(Command::from_line(&format!("{line}\n")).unwrap(), c);
        }
    }

    #[test]
    fn command_tag_and_field_names_are_stable() {
        // These exact strings are the wire contract the plugin parses — pin them.
        assert_eq!(Command::Hello.to_line(), r#"{"cmd":"hello"}"#);
        assert_eq!(Command::Ping.to_line(), r#"{"cmd":"ping"}"#);
        assert_eq!(
            Command::FocusPane { pane_id: 7 }.to_line(),
            r#"{"cmd":"focus_pane","pane_id":7}"#
        );
        // Optional fields are omitted when absent (skip_serializing_if) — incl.
        // the additive `stack` flag, so the existing wire shape is byte-stable.
        assert_eq!(
            Command::OpenCommandPane {
                command: "bash".into(),
                args: vec![],
                cwd: None,
                title: None,
                stack: false,
            }
            .to_line(),
            r#"{"cmd":"open_command_pane","command":"bash","args":[]}"#
        );
        // `stack: true` rides along only when set.
        assert_eq!(
            Command::OpenCommandPane {
                command: "psu".into(),
                args: vec![],
                cwd: None,
                title: None,
                stack: true,
            }
            .to_line(),
            r#"{"cmd":"open_command_pane","command":"psu","args":[],"stack":true}"#
        );
        // The new dock-verb commands.
        assert_eq!(
            Command::StackPanes {
                pane_ids: vec![1, 4]
            }
            .to_line(),
            r#"{"cmd":"stack_panes","pane_ids":[1,4]}"#
        );
        assert_eq!(
            Command::TogglePaneFloat { pane_id: 5 }.to_line(),
            r#"{"cmd":"toggle_pane_float","pane_id":5}"#
        );
        assert_eq!(
            Command::SelectSwapLayout {
                name: "grid".into()
            }
            .to_line(),
            r#"{"cmd":"select_swap_layout","name":"grid"}"#
        );
        assert_eq!(
            Command::NextSwapLayout.to_line(),
            r#"{"cmd":"next_swap_layout"}"#
        );
        assert_eq!(
            Command::PrevSwapLayout.to_line(),
            r#"{"cmd":"prev_swap_layout"}"#
        );
    }

    #[test]
    fn plugin_event_round_trips() {
        let topo = Topology {
            tabs: vec![
                TabNode {
                    pos: 0,
                    name: "papercup".into(),
                    active: true,
                    swap_layout: Some("stacked".into()),
                    swap_dirty: false,
                },
                TabNode {
                    pos: 1,
                    name: "docs".into(),
                    active: false,
                    swap_layout: None,
                    swap_dirty: true,
                },
            ],
            panes: vec![
                PaneNode {
                    id: 1,
                    tab: 0,
                    title: "claude · F-12".into(),
                    focused: true,
                    is_plugin: false,
                    exited: false,
                    command: Some("psu --no-picker --agent=claude".into()),
                },
                PaneNode {
                    id: 2,
                    tab: 0,
                    title: "pui".into(),
                    focused: false,
                    is_plugin: false,
                    exited: false,
                    command: None,
                },
            ],
        };
        let cases = vec![
            PluginEvent::Hello { plugin_version: "0.1.0".into() },
            PluginEvent::Topology(topo),
            PluginEvent::PaneExited { pane_id: 1, exit_code: Some(0) },
            PluginEvent::PaneExited { pane_id: 4, exit_code: None },
            PluginEvent::PaneClosed { pane_id: 2 },
        ];
        for e in cases {
            let line = e.to_line();
            assert!(!line.contains('\n'), "a line must be newline-free: {line}");
            assert_eq!(PluginEvent::from_line(&line).unwrap(), e);
            assert_eq!(PluginEvent::from_line(&format!("{line}\n")).unwrap(), e);
        }
    }

    #[test]
    fn plugin_event_tag_is_stable() {
        assert_eq!(
            PluginEvent::PaneExited { pane_id: 9, exit_code: Some(1) }.to_line(),
            r#"{"ev":"pane_exited","pane_id":9,"exit_code":1}"#
        );
        assert_eq!(
            PluginEvent::PaneClosed { pane_id: 9 }.to_line(),
            r#"{"ev":"pane_closed","pane_id":9}"#
        );
    }

    #[test]
    fn unknown_or_malformed_lines_error_not_panic() {
        assert!(Command::from_line("not json").is_err());
        assert!(Command::from_line(r#"{"cmd":"no_such"}"#).is_err());
        assert!(PluginEvent::from_line("").is_err());
    }

    #[test]
    fn tabnode_swap_fields_are_wire_compatible() {
        // An old plugin emits a TabNode WITHOUT the swap fields — the new pui
        // must still parse it (serde-default), and a TabNode with the defaults
        // must serialize back to the old shape (skip_serializing_if).
        let old = r#"{"pos":0,"name":"papercup","active":true}"#;
        let t: TabNode = serde_json::from_str(old).unwrap();
        assert_eq!(t.swap_layout, None);
        assert!(!t.swap_dirty);
        assert_eq!(serde_json::to_string(&t).unwrap(), old);
        // The fields ride along only when set.
        let t2 = TabNode {
            pos: 0,
            name: "x".into(),
            active: true,
            swap_layout: Some("grid".into()),
            swap_dirty: true,
        };
        assert_eq!(
            serde_json::to_string(&t2).unwrap(),
            r#"{"pos":0,"name":"x","active":true,"swap_layout":"grid","swap_dirty":true}"#
        );
    }
}
