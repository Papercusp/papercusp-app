//! `pui-companion` — a thin companion zellij plugin: `pui`'s eyes + hands inside
//! zellij (SP-TUI P-004 / D-008).
//!
//! It holds **no backend connection** and renders nothing. It does only what
//! needs zellij internals:
//!   * **observe** the live session — `PaneUpdate` / `TabUpdate` /
//!     `CommandPaneExited` / `PaneClosed` (via `ReadApplicationState`); and
//!   * **execute** in-zellij orchestration — focus / close / open-command-pane /
//!     new-tab / rename (via `ChangeApplicationState`).
//!
//! It is linked full-duplex to the external `pui` binary over ONE long-lived
//! `zellij pipe -p <this-plugin>` child: `pui` writes [`Command`] lines to the
//! child's stdin (→ `ZellijPlugin::pipe`); this plugin writes [`PluginEvent`]
//! lines back via `cli_pipe_output` (→ the child's stdout → `pui`). The whole
//! contract lives in `pui-companion-proto` so both ends can't drift.
//!
//! ## Routing fact (verified in zellij 0.44.3 source — do not "simplify")
//! `cli_pipe_output(pipe_name, …)` routes back to a CLI pipe by its **`pipe_id`**
//! (a per-invocation UUID), NOT by its `--name`: the server's
//! `associate_pipe_with_client` and the CLI's `if pipe_name == pipe_id` both key
//! on the id. So we capture the id from `PipeSource::Cli(id)` on the first
//! inbound message and echo every event back on it. We *match* on `--name`
//! (`pui`) only to ignore unrelated CLI pipes.
//!
//! ## Build / test split — and why this is a `bin`, not a `cdylib`
//! zellij's loader requires a callable `_start` (it runs the module's `fn main`
//! once, then calls the `#[no_mangle]` load/update/pipe/render exports). On
//! modern Rust a `wasm32-wasip1` *cdylib* is a "reactor" (only `_initialize`, no
//! `_start`) → zellij fails with "could not find exported function". So this is
//! a **`bin`** (a "command" module): `register_plugin!`'s generated `fn main`
//! becomes `_start`, while the `#[no_mangle]` exports are still emitted.
//!
//! Every host-shim call is `#[cfg(target_arch = "wasm32")]`-gated; on wasm the
//! macro supplies `fn main`, off-wasm a tiny empty `fn main` lets the same crate
//! build so `cargo test` runs the pure [`build_topology`] unit tests (zellij's
//! wasm host imports don't link natively, so the `ZellijPlugin` impl is absent
//! off-wasm by design).

// Native is purely the unit-test vehicle: the `PuiCompanion` runtime half is
// wasm-only, so off-wasm it is legitimately dead. Allow it there only — the real
// `wasm32` target stays fully strict, so genuine dead code in the plugin is still
// caught by `cargo clippy --target wasm32-wasip1`.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

// Off-wasm, `register_plugin!` (which generates `fn main`) is gated out, so this
// `bin` needs a no-op entry point to build for the native test harness.
#[cfg(not(target_arch = "wasm32"))]
fn main() {}

// Data types are pure (no host imports) and used by `build_topology` + tests on
// every target. The shim functions + event/command enums are wasm-only.
#[cfg(target_arch = "wasm32")]
use zellij_tile::prelude::*;
#[cfg(not(target_arch = "wasm32"))]
use zellij_tile::prelude::{PaneManifest, TabInfo};

use pui_companion_proto::{PaneNode, TabNode, Topology};

/// The `--name` `pui` opens the pipe with. We bind only to this name.
const PIPE_NAME: &str = "pui";

#[derive(Default)]
struct PuiCompanion {
    /// CLI pipe id we echo events back on (see the routing fact above). `None`
    /// until `pui`'s first message arrives, which gates [`PuiCompanion::emit`].
    pipe_id: Option<String>,
    /// Latest pane manifest (tab position → panes) from `PaneUpdate`.
    panes: PaneManifest,
    /// Latest tab list from `TabUpdate`.
    tabs: Vec<TabInfo>,
    /// In-flight `SelectSwapLayout` target (dockview-workbench D-008): the preset
    /// name we're cycling toward + the remaining attempt budget. zellij has no
    /// "select preset by name" primitive, so we fire `next_swap_layout` and
    /// re-check on each `TabUpdate` until the active preset matches (bounded so an
    /// unknown name can't loop forever). `None` when not seeking.
    pending_swap: Option<(String, u8)>,
    /// Command panes opened with `stack:true` can be returned by zellij before
    /// they appear in the next `PaneUpdate`. Keep their terminal ids until a
    /// manifest proves they exist, then stack the complete current work set.
    /// The queue is bounded per pane so a failed open cannot leave stale state
    /// forever; exit/close events remove entries immediately.
    pending_stack_panes: Vec<(u32, u8)>,
    /// One-shot latch for the EI-9 self-hide retry. zellij launches a
    /// `zellij pipe -p` plugin in a focused **floating** pane by default (the
    /// CLI's `floating_plugin` defaults to floating) — but this companion is
    /// headless: `render()` is empty. We `hide_self()` in `load()` to suppress
    /// that pane, then once more on the first `PaneUpdate` in case the pane
    /// wasn't part of the session yet when `load()` ran. A suppressed pane is no
    /// longer in the tiled/floating sets, so the retry is an idempotent no-op
    /// when load-time hiding already worked. `false` until that retry flips it.
    self_hide_retried: bool,
}

impl PuiCompanion {
    /// One-shot guard for the post-load `hide_self()` retry (EI-9): returns
    /// `true` exactly the first time it is called, then `false` forever, so the
    /// companion re-suppresses its floating pane on the *first* `PaneUpdate`
    /// after load and never spams `hide_self()` on later updates. Pure +
    /// native-testable; the `hide_self()` host call it gates is wasm-only.
    fn should_retry_self_hide(&mut self) -> bool {
        !std::mem::replace(&mut self.self_hide_retried, true)
    }
}

/// Marker substring identifying the pui HUD pane by its command (`pui hud`). The
/// work area is "everything beside the HUD", so the HUD is excluded from the
/// stack/work set (D-004/D-008).
const HUD_CMD_MARKER: &str = "pui hud";

/// The terminal-pane ids of the active tab's WORK area: non-plugin panes minus
/// the HUD (D-004). Pure (no host calls) so it's unit-testable off-wasm. Used by
/// the stack-on-open launch path and as the default `:stack` set. The active tab
/// is the one flagged `active`; with no tab info, falls back to tab position 0.
fn work_terminal_pane_ids(panes: &PaneManifest, tabs: &[TabInfo]) -> Vec<u32> {
    let active_tab = tabs
        .iter()
        .find(|t| t.active)
        .map(|t| t.position)
        .unwrap_or(0);
    let Some(list) = panes.panes.get(&active_tab) else {
        return Vec::new();
    };
    list.iter()
        .filter(|p| !p.is_plugin && !is_hud_pane(p))
        .map(|p| p.id)
        .collect()
}

/// Return the current work set plus the pending stack targets that are visible
/// in the manifest. `None` means every open-command-pane result raced ahead of
/// its corresponding `PaneUpdate`, so the caller should retain every pending
/// target. Keeping the visible subset separate is important when several panes
/// open together: one pane becoming visible must not discard a later pane that
/// has not reached the manifest yet. Pure so both delayed-manifest races are
/// covered by native tests.
fn stack_ids_when_ready(
    panes: &PaneManifest,
    tabs: &[TabInfo],
    pending_ids: &[u32],
) -> Option<(Vec<u32>, Vec<u32>)> {
    let ids = work_terminal_pane_ids(panes, tabs);
    let visible_pending: Vec<u32> = pending_ids
        .iter()
        .copied()
        .filter(|pending_id| ids.contains(pending_id))
        .collect();
    (!visible_pending.is_empty()).then_some((ids, visible_pending))
}

/// Is this pane the pui HUD? Matches its command (`pui hud`) first, then falls
/// back to the title (`pui`) for panes whose command zellij didn't surface.
fn is_hud_pane(p: &zellij_tile::prelude::PaneInfo) -> bool {
    if let Some(cmd) = &p.terminal_command {
        if cmd.contains(HUD_CMD_MARKER) {
            return true;
        }
    }
    p.title == "pui"
}

/// Build the compact wire [`Topology`] from the latest manifest + tab list.
/// Pure (no host calls) so it is unit-testable off-wasm — this is the plugin's
/// "serialize side" the brief asks to cover.
fn build_topology(panes: &PaneManifest, tabs: &[TabInfo]) -> Topology {
    let tab_nodes = tabs
        .iter()
        .map(|t| TabNode {
            pos: t.position as u32,
            name: t.name.clone(),
            active: t.active,
            swap_layout: t.active_swap_layout_name.clone(),
            swap_dirty: t.is_swap_layout_dirty,
        })
        .collect();
    let mut pane_nodes = Vec::new();
    for (tab_pos, list) in &panes.panes {
        for p in list {
            pane_nodes.push(PaneNode {
                id: p.id,
                tab: *tab_pos as u32,
                title: p.title.clone(),
                focused: p.is_focused,
                is_plugin: p.is_plugin,
                exited: p.exited,
                command: p.terminal_command.clone(),
            });
        }
    }
    Topology {
        tabs: tab_nodes,
        panes: pane_nodes,
    }
}

/// Build generation embedded by the canonical pui+companion installer. Direct
/// developer builds remain explicit (`unknown`) instead of pretending to be an
/// installed generation.
fn plugin_build_version() -> String {
    let sha = option_env!("PUI_BUILD_SHA").unwrap_or("unknown");
    let short_sha: String = sha.chars().take(12).collect();
    let epoch = option_env!("PUI_BUILD_EPOCH").unwrap_or("unknown");
    format!("{}+{short_sha}@{epoch}", env!("CARGO_PKG_VERSION"))
}

// ───────────────────────────── wasm-only plugin ─────────────────────────────

#[cfg(target_arch = "wasm32")]
use pui_companion_proto::{Command, PluginEvent};
#[cfg(target_arch = "wasm32")]
use std::collections::BTreeMap;
#[cfg(target_arch = "wasm32")]
use std::path::PathBuf;

#[cfg(target_arch = "wasm32")]
register_plugin!(PuiCompanion);

#[cfg(target_arch = "wasm32")]
impl ZellijPlugin for PuiCompanion {
    fn load(&mut self, _configuration: BTreeMap<String, String>) {
        // ReadApplicationState  → PaneUpdate/TabUpdate/CommandPaneExited/PaneClosed
        // ChangeApplicationState → focus / close / new-tab / rename
        // RunCommands           → open_command_pane (the agent-launch path; zellij
        //                         gates command panes behind RunCommands, NOT
        //                         ChangeApplicationState — verified in
        //                         zellij_exports.rs check_command_permission)
        // ReadCliPipes          → cli_pipe_output / block / unblock (the link!)
        request_permission(&[
            PermissionType::ReadApplicationState,
            PermissionType::ChangeApplicationState,
            PermissionType::RunCommands,
            PermissionType::ReadCliPipes,
        ]);
        subscribe(&[
            EventType::PaneUpdate,
            EventType::TabUpdate,
            EventType::CommandPaneExited,
            EventType::PaneClosed,
        ]);
        // Headless companion (D-008): zellij gives a `zellij pipe -p`-launched
        // plugin a focused FLOATING pane by default (EI-9) — and since this
        // plugin renders nothing, that pane sits blank over the workbench and
        // STEALS keystrokes from the tiled `pui` HUD until the user discovers
        // Ctrl-p w. Suppress our own pane immediately. `hide_self()` needs no
        // permission (always granted), and when ours is the only floating pane
        // zellij also hides the floating layer + returns focus to the tiled HUD
        // (tab::extract_pane → hide_floating_panes + move_clients_out_of_pane),
        // so the HUD is driveable on first paint. Re-issued once on the first
        // PaneUpdate (the pane may not be in the session yet here) — see
        // `should_retry_self_hide`.
        hide_self();
    }

    fn update(&mut self, event: Event) -> bool {
        match event {
            Event::PaneUpdate(manifest) => {
                self.panes = manifest;
                // EI-9 race insurance: if our floating pane wasn't part of the
                // session yet when `load()` fired `hide_self()`, it is now.
                // Re-suppress exactly once (idempotent — a one-shot latch keeps
                // this off every later PaneUpdate).
                if self.should_retry_self_hide() {
                    hide_self();
                }
                self.advance_pending_stack_panes();
                self.emit_topology();
            }
            Event::TabUpdate(tabs) => {
                self.tabs = tabs;
                // Drive any in-flight SelectSwapLayout toward its target: each
                // next_swap_layout fires a fresh TabUpdate, so this re-enters
                // until the active preset matches (or the budget runs out).
                self.advance_pending_swap();
                self.emit_topology();
            }
            // A command pane's command exited (pane is held) — the crash/finish
            // signal `pui` uses to offer/auto-relaunch an agent.
            Event::CommandPaneExited(terminal_pane_id, exit_code, _ctx) => {
                self.pending_stack_panes
                    .retain(|(pane_id, _)| *pane_id != terminal_pane_id);
                self.emit(&PluginEvent::PaneExited {
                    pane_id: terminal_pane_id,
                    exit_code,
                });
            }
            Event::PaneClosed(pane_id) => {
                let id = match pane_id {
                    PaneId::Terminal(i) | PaneId::Plugin(i) => i,
                };
                self.pending_stack_panes
                    .retain(|(pane_id, _)| *pane_id != id);
                self.emit(&PluginEvent::PaneClosed { pane_id: id });
            }
            _ => {}
        }
        // Headless plugin (loaded in the background via `zellij pipe -p`): there
        // is no pane to render to, so never request a render.
        false
    }

    fn pipe(&mut self, pipe_message: PipeMessage) -> bool {
        // Bind only to the `pui` pipe; ignore other CLI pipes / plugin messages.
        if pipe_message.name != PIPE_NAME {
            return false;
        }
        // Capture (or refresh) the id we must echo events back on.
        if let PipeSource::Cli(id) = &pipe_message.source {
            self.pipe_id = Some(id.clone());
        }
        // A `None` payload signals pipe completion (`pui` closed stdin). Nothing
        // to execute; we simply stop emitting once `pui` is gone.
        let Some(payload) = pipe_message.payload else {
            return false;
        };
        // The CLI delivers one stdin line per message; be defensive anyway and
        // handle a payload that happens to carry several lines.
        for line in payload.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(cmd) = Command::from_line(line) {
                self.handle_command(cmd);
            }
            // Malformed lines are ignored on purpose: `pui` validates + logs its
            // own send errors, and a bad line must never wedge the plugin.
        }
        false
    }

    fn render(&mut self, _rows: usize, _cols: usize) {
        // Intentionally empty — D-008: the plugin renders little/nothing.
    }
}

#[cfg(target_arch = "wasm32")]
impl PuiCompanion {
    fn handle_command(&mut self, cmd: Command) {
        match cmd {
            Command::Hello => {
                self.emit(&PluginEvent::Hello {
                    plugin_version: plugin_build_version(),
                });
                self.emit_topology();
            }
            Command::Ping | Command::Snapshot => self.emit_topology(),
            Command::FocusPane { pane_id } => {
                // not floating, not in-place — focus the tiled terminal pane.
                focus_terminal_pane(pane_id, false, false);
            }
            Command::ClosePane { pane_id } => close_terminal_pane(pane_id),
            Command::OpenCommandPane {
                command,
                args,
                cwd,
                title,
                stack,
            } => {
                let to_run = CommandToRun {
                    path: PathBuf::from(command),
                    args,
                    cwd: cwd.map(PathBuf::from),
                };
                // `context` is opaque metadata echoed back in CommandPaneOpened;
                // stash the pui-side title there for traceability (it does not
                // set the pane title — pui keeps its own label).
                let mut context = BTreeMap::new();
                if let Some(t) = title {
                    context.insert("pui_title".to_string(), t);
                }
                let opened = open_command_pane(to_run, context);
                // Dockview launch (D-008): stack the new pane into the work group.
                // zellij returns the new PaneId before the next PaneUpdate, so queue
                // it and converge from the first manifest that contains it. This is
                // focus-independent — the launch may fire from the HUD pane (a plain
                // reflow would split the HUD instead, D-007).
                if stack {
                    if let Some(PaneId::Terminal(new_id)) = opened {
                        self.pending_stack_panes
                            .retain(|(pane_id, _)| *pane_id != new_id);
                        self.pending_stack_panes.push((new_id, 64));
                        self.advance_pending_stack_panes();
                    }
                }
            }
            Command::NewTab { name, layout } => {
                // new_tabs_with_layout needs a stringified KDL layout. An explicit
                // layout wins; a bare name → synthesize a minimal single-pane tab
                // so `{name}` alone still opens a usable named tab.
                match layout {
                    Some(l) => {
                        new_tabs_with_layout(&l);
                    }
                    None => {
                        if let Some(n) = name {
                            let n = n.replace('"', "\\\"");
                            new_tabs_with_layout(&format!(
                                "layout {{ tab name=\"{n}\" {{ pane }} }}"
                            ));
                        }
                    }
                }
            }
            Command::RenameTab { tab_id, name } => {
                rename_tab_with_id(tab_id as u64, name);
            }
            // ── dockview dock-verbs (D-008) ──
            Command::StackPanes { pane_ids } => {
                let ids: Vec<PaneId> = pane_ids.into_iter().map(PaneId::Terminal).collect();
                if ids.len() >= 2 {
                    stack_panes(ids);
                }
            }
            Command::TogglePaneFloat { pane_id } => {
                toggle_pane_embed_or_eject_for_pane_id(PaneId::Terminal(pane_id));
            }
            Command::SelectSwapLayout { name } => {
                // Seek the named preset: if we're already on it, nothing to do;
                // otherwise arm the budget and take the first step. Each step
                // triggers a TabUpdate which re-enters advance_pending_swap.
                if self.active_swap_name().as_deref() == Some(name.as_str()) {
                    self.pending_swap = None;
                } else {
                    // Budget = a small multiple of the preset count so a full
                    // cycle is always reachable; bounded so an unknown name stops.
                    self.pending_swap = Some((name, 8));
                    self.advance_pending_swap();
                }
            }
            Command::NextSwapLayout => {
                self.pending_swap = None; // an explicit cycle cancels any seek
                next_swap_layout();
            }
            Command::PrevSwapLayout => {
                self.pending_swap = None;
                previous_swap_layout();
            }
        }
    }

    /// The active tab's current swap-layout preset name, if any.
    fn active_swap_name(&self) -> Option<String> {
        self.tabs
            .iter()
            .find(|t| t.active)
            .and_then(|t| t.active_swap_layout_name.clone())
    }

    /// Step an in-flight `SelectSwapLayout` toward its target. Called on each
    /// `TabUpdate` (and once when the command arrives). Clears `pending_swap` when
    /// the active preset matches the target or the attempt budget is exhausted.
    fn advance_pending_swap(&mut self) {
        let Some((target, attempts)) = self.pending_swap.clone() else {
            return;
        };
        if self.active_swap_name().as_deref() == Some(target.as_str()) {
            self.pending_swap = None; // arrived
            return;
        }
        if attempts == 0 {
            self.pending_swap = None; // gave up (unknown/unreachable preset)
            return;
        }
        self.pending_swap = Some((target, attempts - 1));
        next_swap_layout(); // → a fresh TabUpdate re-enters this method
    }

    /// Stack pending command panes after zellij publishes them in a manifest.
    /// Multiple launches may be pending at once; one stack operation gathers
    /// every currently visible work pane, so an earlier launch is not lost when
    /// a later launch arrives before its first `PaneUpdate`.
    fn advance_pending_stack_panes(&mut self) {
        if self.pending_stack_panes.is_empty() {
            return;
        }
        let pending = std::mem::take(&mut self.pending_stack_panes);
        let pending_ids: Vec<u32> = pending.iter().map(|(id, _)| *id).collect();
        let Some((ids, visible_pending)) =
            stack_ids_when_ready(&self.panes, &self.tabs, &pending_ids)
        else {
            self.pending_stack_panes = pending
                .into_iter()
                .filter_map(|(id, attempts)| (attempts > 0).then_some((id, attempts - 1)))
                .collect();
            return;
        };

        // Retire only targets proved visible by this manifest. Another launch
        // can still be in flight even though an earlier one has appeared; keep
        // that unseen id queued so its later PaneUpdate performs the final
        // all-work-panes convergence instead of silently leaving it unstacked.
        self.pending_stack_panes = pending
            .into_iter()
            .filter(|(id, _)| !visible_pending.contains(id))
            .filter_map(|(id, attempts)| (attempts > 0).then_some((id, attempts - 1)))
            .collect();

        if ids.len() >= 2 {
            stack_panes(ids.into_iter().map(PaneId::Terminal).collect());
        }
    }

    fn emit_topology(&self) {
        self.emit(&PluginEvent::Topology(build_topology(
            &self.panes,
            &self.tabs,
        )));
    }

    /// Emit one event line to `pui` over the captured CLI pipe id. No-op until
    /// the id is known (i.e. before `pui`'s first message). The trailing `\n` is
    /// what makes `pui`'s line-buffered stdout reader frame each event.
    fn emit(&self, ev: &PluginEvent) {
        if let Some(id) = &self.pipe_id {
            cli_pipe_output(id, &format!("{}\n", ev.to_line()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use zellij_tile::prelude::PaneInfo;

    fn pane(id: u32, title: &str, focused: bool) -> PaneInfo {
        PaneInfo {
            id,
            title: title.to_string(),
            is_focused: focused,
            ..Default::default()
        }
    }

    #[test]
    fn build_topology_flattens_manifest_and_tabs() {
        let mut panes = HashMap::new();
        panes.insert(
            0usize,
            vec![pane(1, "claude · F-12", true), pane(2, "pui", false)],
        );
        panes.insert(1usize, vec![pane(5, "docs", false)]);
        let manifest = PaneManifest { panes };
        let tabs = vec![
            TabInfo {
                position: 0,
                name: "papercup".into(),
                active: true,
                ..Default::default()
            },
            TabInfo {
                position: 1,
                name: "docs".into(),
                active: false,
                ..Default::default()
            },
        ];

        let topo = build_topology(&manifest, &tabs);

        assert_eq!(topo.tabs.len(), 2);
        assert!(topo
            .tabs
            .iter()
            .any(|t| t.pos == 0 && t.name == "papercup" && t.active));
        assert_eq!(topo.panes.len(), 3);
        let p1 = topo.panes.iter().find(|p| p.id == 1).unwrap();
        assert_eq!(p1.tab, 0);
        assert!(p1.focused);
        assert!(topo.panes.iter().any(|p| p.id == 5 && p.tab == 1));
    }

    #[test]
    fn topology_command_pane_carries_terminal_command() {
        let mut panes = HashMap::new();
        let mut p = pane(9, "agent", false);
        p.terminal_command = Some("psu --no-picker".into());
        p.exited = true;
        panes.insert(0usize, vec![p]);
        let topo = build_topology(&PaneManifest { panes }, &[]);
        let node = &topo.panes[0];
        assert_eq!(node.command.as_deref(), Some("psu --no-picker"));
        assert!(node.exited);
    }

    #[test]
    fn empty_session_is_empty_topology() {
        let topo = build_topology(&PaneManifest::default(), &[]);
        assert!(topo.tabs.is_empty() && topo.panes.is_empty());
    }

    #[test]
    fn topology_carries_active_swap_layout() {
        let tabs = vec![TabInfo {
            position: 0,
            name: "papercup".into(),
            active: true,
            active_swap_layout_name: Some("stacked".into()),
            is_swap_layout_dirty: true,
            ..Default::default()
        }];
        let topo = build_topology(&PaneManifest::default(), &tabs);
        assert_eq!(topo.tabs[0].swap_layout.as_deref(), Some("stacked"));
        assert!(topo.tabs[0].swap_dirty);
    }

    fn cmd_pane(id: u32, title: &str, cmd: Option<&str>, is_plugin: bool) -> PaneInfo {
        PaneInfo {
            id,
            title: title.to_string(),
            is_plugin,
            terminal_command: cmd.map(String::from),
            ..Default::default()
        }
    }

    #[test]
    fn work_set_excludes_hud_and_plugin_panes() {
        let mut panes = HashMap::new();
        panes.insert(
            0usize,
            vec![
                cmd_pane(1, "claude", Some("psu --agent=claude"), false),
                cmd_pane(2, "pui", Some("pui hud"), false), // the HUD — excluded
                cmd_pane(3, "codex", Some("psu --agent=codex"), false),
                cmd_pane(4, "tab-bar", None, true), // a plugin pane — excluded
            ],
        );
        let tabs = vec![TabInfo {
            position: 0,
            active: true,
            ..Default::default()
        }];
        let ids = work_terminal_pane_ids(&PaneManifest { panes }, &tabs);
        assert_eq!(ids, vec![1, 3]);
    }

    #[test]
    fn work_set_identifies_hud_by_title_when_command_absent() {
        let mut panes = HashMap::new();
        panes.insert(
            0usize,
            vec![
                cmd_pane(1, "claude", None, false),
                cmd_pane(2, "pui", None, false), // HUD by title fallback
            ],
        );
        let tabs = vec![TabInfo {
            position: 0,
            active: true,
            ..Default::default()
        }];
        assert_eq!(
            work_terminal_pane_ids(&PaneManifest { panes }, &tabs),
            vec![1]
        );
    }

    #[test]
    fn work_set_uses_the_active_tab() {
        let mut panes = HashMap::new();
        panes.insert(0usize, vec![cmd_pane(1, "a", None, false)]);
        panes.insert(1usize, vec![cmd_pane(5, "b", None, false)]);
        let tabs = vec![
            TabInfo {
                position: 0,
                active: false,
                ..Default::default()
            },
            TabInfo {
                position: 1,
                active: true,
                ..Default::default()
            },
        ];
        assert_eq!(
            work_terminal_pane_ids(&PaneManifest { panes }, &tabs),
            vec![5]
        );
    }

    #[test]
    fn work_set_empty_when_no_panes() {
        assert!(work_terminal_pane_ids(&PaneManifest::default(), &[]).is_empty());
    }

    #[test]
    fn stack_waits_for_delayed_pane_update_then_uses_complete_work_set() {
        let mut panes = HashMap::new();
        panes.insert(
            0usize,
            vec![
                cmd_pane(1, "existing-agent", Some("psu --agent=claude"), false),
                cmd_pane(2, "pui", Some("pui hud"), false),
            ],
        );
        let tabs = vec![TabInfo {
            position: 0,
            active: true,
            ..Default::default()
        }];

        // open_command_pane returned 9, but the first manifest has not caught
        // up yet: stacking now would race and silently miss the new pane.
        assert_eq!(
            stack_ids_when_ready(
                &PaneManifest {
                    panes: panes.clone()
                },
                &tabs,
                &[9]
            ),
            None
        );

        panes
            .get_mut(&0)
            .unwrap()
            .push(cmd_pane(9, "new-agent", Some("psu --agent=codex"), false));
        assert_eq!(
            stack_ids_when_ready(&PaneManifest { panes }, &tabs, &[9]),
            Some((vec![1, 9], vec![9]))
        );
    }

    #[test]
    fn stack_keeps_staggered_pending_panes_until_each_is_visible() {
        let mut panes = HashMap::new();
        panes.insert(
            0usize,
            vec![
                cmd_pane(1, "existing-agent", Some("psu --agent=claude"), false),
                cmd_pane(2, "pui", Some("pui hud"), false),
            ],
        );
        let tabs = vec![TabInfo {
            position: 0,
            active: true,
            ..Default::default()
        }];

        // Two launches are pending, but only the first has reached PaneUpdate.
        // The caller may stack the visible work set now, but must retire only 9
        // and leave 10 pending for the next manifest.
        panes.get_mut(&0).unwrap().push(cmd_pane(
            9,
            "first-new-agent",
            Some("psu --agent=codex"),
            false,
        ));
        assert_eq!(
            stack_ids_when_ready(
                &PaneManifest {
                    panes: panes.clone()
                },
                &tabs,
                &[9, 10]
            ),
            Some((vec![1, 9], vec![9]))
        );

        panes.get_mut(&0).unwrap().push(cmd_pane(
            10,
            "second-new-agent",
            Some("psu --agent=claude"),
            false,
        ));
        assert_eq!(
            stack_ids_when_ready(&PaneManifest { panes }, &tabs, &[10]),
            Some((vec![1, 9, 10], vec![10]))
        );
    }

    #[test]
    fn self_hide_retry_latch_fires_exactly_once() {
        // EI-9: the companion suppresses its own auto-created floating pane with
        // `hide_self()` in load() and retries once on the first PaneUpdate (the
        // pane may not exist yet at load time). The latch must fire EXACTLY once
        // so the retry never spams `hide_self()` on every subsequent PaneUpdate
        // (PaneUpdates arrive continuously as agent panes open/close).
        let mut c = PuiCompanion::default();
        assert!(
            c.should_retry_self_hide(),
            "the first PaneUpdate after load must trigger the hide_self retry"
        );
        assert!(
            !c.should_retry_self_hide(),
            "subsequent PaneUpdates must NOT re-fire hide_self"
        );
        assert!(!c.should_retry_self_hide());
    }

    #[test]
    fn plugin_handshake_version_carries_build_generation() {
        let version = plugin_build_version();
        assert!(version.starts_with(concat!(env!("CARGO_PKG_VERSION"), "+")));
        assert!(version.contains('@'));
        assert_ne!(version, env!("CARGO_PKG_VERSION"));
    }
}
