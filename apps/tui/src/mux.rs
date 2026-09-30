//! Multiplexer driver (SP-TUI A1): open native agent sessions in REAL panes so
//! `claude`/`codex`/`omp` run at full fidelity. Decision: ride zellij; the trait
//! keeps a tmux impl possible later. This module BUILDS the command and exposes
//! `open_pane`; actually spawning/driving a live zellij is exercised manually
//! (the deferred live part) — the unit tests cover command construction only.
#![allow(dead_code)] // wired into the Sessions panel's launch action in a later step.

use std::process::Command;

/// A request to open a command in a new pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneSpec {
    /// Argv of the command to run in the pane (e.g. ["psu","--no-picker","--agent=claude"]).
    pub argv: Vec<String>,
    /// Optional pane title.
    pub title: Option<String>,
    /// Optional working directory to run the command in (zellij `--cwd`). Used by
    /// plugin-contributed panes (D-002) that must run inside a specific repo dir.
    pub cwd: Option<String>,
    /// Open the pane into the focused pane's STACK (`--stacked`) — the dock's
    /// agent stack (pui-dock-agent-stack-2026-06-07) rather than a new tile.
    pub stacked: bool,
    /// Close the pane when its command exits (`--close-on-exit`) — watch panes
    /// exit themselves when their agent leaves the roster; no EXITED husk.
    pub close_on_exit: bool,
}

impl PaneSpec {
    pub fn new(argv: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            argv: argv.into_iter().map(Into::into).collect(),
            title: None,
            cwd: None,
            stacked: false,
            close_on_exit: false,
        }
    }
    /// Open into the focused stack + auto-close on exit — the dock agent-stack
    /// pane shape (pui-dock-agent-stack-2026-06-07).
    pub fn stacked_autoclose(mut self) -> Self {
        self.stacked = true;
        self.close_on_exit = true;
        self
    }
    pub fn titled(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }
    /// Set the working directory the pane's command runs in (zellij `--cwd`).
    pub fn cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }
}

/// A workbench control action (D-001: pui drives the multiplexer via
/// `zellij action ...` from a pinned HUD pane — it is NOT a zellij plugin,
/// because the WASM plugin sandbox can't reach our Unix-socket IPC). This is the
/// vocabulary pui issues to arrange the workbench; the live spawn is deferred.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MuxAction {
    /// Open a command in a new pane.
    NewPane(PaneSpec),
    /// Open a new tab (optionally named, optionally from a layout file).
    NewTab {
        name: Option<String>,
        layout: Option<String>,
    },
    /// Close the focused pane.
    ClosePane,
    /// Move focus to the next pane.
    FocusNextPane,
    /// Focus a specific pane by its zellij pane id (`zellij action
    /// focus-pane-id <id>` — bare numeric id accepted). Used to snap focus
    /// back to the chat pane after a dock pane burst
    /// (pui-dock-agent-stack-2026-06-07).
    FocusPaneId(u32),
    /// Jump to a tab by 1-based index.
    GoToTab(u32),
    /// Rename the focused tab.
    RenameTab(String),
    /// Cycle to the next swap-layout preset (the `:layout next` fallback when no
    /// companion is linked — `Alt+]`'s action; dockview-workbench D-008).
    NextSwapLayout,
    /// Cycle to the previous swap-layout preset (`:layout prev` fallback).
    PrevSwapLayout,
    /// Float the focused pane / embed it if floating (the bare `:float` fallback;
    /// when typed in the palette the focused pane IS the pui HUD, so this floats
    /// the HUD — matching the companion path's bare-verb semantics, D-002).
    ToggleFloat,
}

pub trait Multiplexer {
    /// Build the argv that opens a new pane running `spec` (pure; no spawn).
    fn new_pane_argv(&self, spec: &PaneSpec) -> Vec<String>;

    /// Build the argv for an arbitrary control action (pure; no spawn).
    fn action_argv(&self, action: &MuxAction) -> Vec<String>;

    /// Spawn a new pane via the OS. Default impl runs `new_pane_argv`.
    fn open_pane(&self, spec: &PaneSpec) -> std::io::Result<()> {
        spawn(self.new_pane_argv(spec))
    }

    /// Run an arbitrary control action via the OS.
    fn run_action(&self, action: &MuxAction) -> std::io::Result<()> {
        spawn(self.action_argv(action))
    }
}

/// Spawn an argv, returning the process status as `()`.
fn spawn(argv: Vec<String>) -> std::io::Result<()> {
    let (prog, rest) = argv.split_first().expect("multiplexer argv is never empty");
    Command::new(prog).args(rest).status().map(|_| ())
}

/// zellij driver: `zellij action new-pane [--name <title>] -- <argv...>`.
pub struct Zellij;

impl Multiplexer for Zellij {
    fn new_pane_argv(&self, spec: &PaneSpec) -> Vec<String> {
        let mut v = vec![
            "zellij".to_string(),
            "action".to_string(),
            "new-pane".to_string(),
        ];
        if let Some(t) = &spec.title {
            v.push("--name".to_string());
            v.push(t.clone());
        }
        if let Some(c) = &spec.cwd {
            v.push("--cwd".to_string());
            v.push(c.clone());
        }
        if spec.stacked {
            v.push("--stacked".to_string());
        }
        if spec.close_on_exit {
            v.push("--close-on-exit".to_string());
        }
        v.push("--".to_string());
        if let Some((program, args)) = spec.argv.split_first() {
            // `psu` resolves beside the running pui first (D-031).
            v.push(crate::remote_connect::pane_program(program));
            v.extend(args.iter().cloned());
        }
        v
    }

    fn action_argv(&self, action: &MuxAction) -> Vec<String> {
        let s = |x: &str| x.to_string();
        match action {
            MuxAction::NewPane(spec) => self.new_pane_argv(spec),
            MuxAction::NewTab { name, layout } => {
                let mut v = vec![s("zellij"), s("action"), s("new-tab")];
                if let Some(n) = name {
                    v.push(s("--name"));
                    v.push(n.clone());
                }
                if let Some(l) = layout {
                    v.push(s("--layout"));
                    v.push(l.clone());
                }
                v
            }
            MuxAction::ClosePane => vec![s("zellij"), s("action"), s("close-pane")],
            MuxAction::FocusNextPane => {
                vec![s("zellij"), s("action"), s("focus-next-pane")]
            }
            MuxAction::FocusPaneId(id) => {
                vec![s("zellij"), s("action"), s("focus-pane-id"), id.to_string()]
            }
            MuxAction::GoToTab(i) => {
                vec![s("zellij"), s("action"), s("go-to-tab"), i.to_string()]
            }
            MuxAction::RenameTab(name) => {
                vec![s("zellij"), s("action"), s("rename-tab"), name.clone()]
            }
            MuxAction::NextSwapLayout => {
                vec![s("zellij"), s("action"), s("next-swap-layout")]
            }
            MuxAction::PrevSwapLayout => {
                vec![s("zellij"), s("action"), s("previous-swap-layout")]
            }
            MuxAction::ToggleFloat => {
                vec![s("zellij"), s("action"), s("toggle-pane-embed-or-floating")]
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_zellij_new_pane_command() {
        let spec = PaneSpec::new(["psu", "--no-picker", "--agent=claude"]);
        let argv = Zellij.new_pane_argv(&spec);
        assert_eq!(
            argv,
            vec![
                "zellij",
                "action",
                "new-pane",
                "--",
                "psu",
                "--no-picker",
                "--agent=claude"
            ]
        );
    }

    #[test]
    fn includes_pane_title_when_set() {
        let spec = PaneSpec::new(["psu", "--agent=codex"]).titled("codex · F-12");
        let argv = Zellij.new_pane_argv(&spec);
        // title sits before the `--` separator
        let dd = argv.iter().position(|a| a == "--").unwrap();
        assert_eq!(argv[dd - 2], "--name");
        assert_eq!(argv[dd - 1], "codex · F-12");
        assert_eq!(&argv[dd + 1..], &["psu", "--agent=codex"]);
    }

    #[test]
    fn includes_cwd_when_set_and_argv_follows_separator() {
        // A plugin-contributed pane (D-002): the command argv is run inside `cwd`.
        let command = vec!["sh".to_string(), "render.sh".to_string()];
        let spec = PaneSpec::new(command.clone())
            .titled("my-plugin · papercup")
            .cwd("/repo/papercup");
        let argv = Zellij.new_pane_argv(&spec);
        // --cwd sits before the `--` separator, with its value next to it.
        let cwd_at = argv.iter().position(|a| a == "--cwd").unwrap();
        assert_eq!(argv[cwd_at + 1], "/repo/papercup");
        // The contribution's command argv lands verbatim after the `--`.
        let dd = argv.iter().position(|a| a == "--").unwrap();
        assert!(cwd_at < dd);
        assert_eq!(&argv[dd + 1..], &command[..]);
    }

    #[test]
    fn stacked_autoclose_flags_emit_zellij_args() {
        // The dock agent-stack pane shape (pui-dock-agent-stack-2026-06-07):
        // join the focused stack + close when the command exits.
        let spec = PaneSpec::new(["claude", "--resume", "sid-1"])
            .titled("claude · su-x")
            .stacked_autoclose();
        let argv = Zellij.new_pane_argv(&spec);
        assert_eq!(
            argv,
            vec![
                "zellij",
                "action",
                "new-pane",
                "--name",
                "claude · su-x",
                "--stacked",
                "--close-on-exit",
                "--",
                "claude",
                "--resume",
                "sid-1",
            ]
        );
    }

    #[test]
    fn focus_pane_id_argv() {
        // The dock's post-burst focus restore (pui-dock-agent-stack):
        // `focus-pane-id` accepts the bare numeric id zellij exports as
        // $ZELLIJ_PANE_ID.
        assert_eq!(
            Zellij.action_argv(&MuxAction::FocusPaneId(7)),
            vec!["zellij", "action", "focus-pane-id", "7"]
        );
    }

    #[test]
    fn action_new_pane_matches_new_pane_argv() {
        let spec = PaneSpec::new(["psu", "--agent=claude"]);
        assert_eq!(
            Zellij.action_argv(&MuxAction::NewPane(spec.clone())),
            Zellij.new_pane_argv(&spec)
        );
    }

    #[test]
    fn action_new_tab_with_name_and_layout() {
        let argv = Zellij.action_argv(&MuxAction::NewTab {
            name: Some("papercup".into()),
            layout: Some("/tmp/wb.kdl".into()),
        });
        assert_eq!(
            argv,
            vec![
                "zellij",
                "action",
                "new-tab",
                "--name",
                "papercup",
                "--layout",
                "/tmp/wb.kdl"
            ]
        );
    }

    #[test]
    fn action_simple_controls() {
        assert_eq!(
            Zellij.action_argv(&MuxAction::ClosePane),
            vec!["zellij", "action", "close-pane"]
        );
        assert_eq!(
            Zellij.action_argv(&MuxAction::FocusNextPane),
            vec!["zellij", "action", "focus-next-pane"]
        );
        assert_eq!(
            Zellij.action_argv(&MuxAction::GoToTab(3)),
            vec!["zellij", "action", "go-to-tab", "3"]
        );
        assert_eq!(
            Zellij.action_argv(&MuxAction::RenameTab("docs".into())),
            vec!["zellij", "action", "rename-tab", "docs"]
        );
    }

    #[test]
    fn action_dock_verb_fallbacks() {
        // The no-companion CLI fallbacks for the dock-verbs (D-008).
        assert_eq!(
            Zellij.action_argv(&MuxAction::NextSwapLayout),
            vec!["zellij", "action", "next-swap-layout"]
        );
        assert_eq!(
            Zellij.action_argv(&MuxAction::PrevSwapLayout),
            vec!["zellij", "action", "previous-swap-layout"]
        );
        assert_eq!(
            Zellij.action_argv(&MuxAction::ToggleFloat),
            vec!["zellij", "action", "toggle-pane-embed-or-floating"]
        );
    }
}
