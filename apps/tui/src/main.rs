//! `pui` — Papercusp terminal workbench (SP-TUI, tui-workbench-ratatui-2026-06-04).
//!
//! Architecture: `App` holds state, `event` normalises inputs onto one mpsc
//! channel, `App::update` is the single reducer, `ui::draw` is a pure renderer.
//! Data is **push-driven (D-003, no polling)**: we fetch once on startup, then
//! subscribe to the operator's `/api/zero-harness/sse` invalidation stream OVER
//! IPC and refetch the affected views when an `invalidate`/`update` arrives. A
//! slow (60s) safety-net refetch is the only timer, and it is a fallback — not a
//! poll. P1 = the Create tab (Plans / Inbox / Sessions).

mod agent_chats;
mod agent_ctx;
mod agent_pane_kind;
mod app;
mod audio_proto;
mod bee;
mod brain_view;
mod card_view;
/// Surface × state coverage census (P-007 / WI-573215) — test-only: renders
/// every `Tab::ALL` destination in every state and pins the census table.
#[cfg(test)]
mod census;
mod change_card;
mod chat_commands;
mod chat_copy;
mod chat_tags;
mod client;
mod companion;
mod event;
mod file_picker;
mod fleet;
mod framing;
mod fresh_exec;
mod glyph;
mod hives;
mod http;
mod identity;
mod install;
mod ipc;
mod keyboard;
mod layout;
mod lexicon;
mod markdown;
mod models;
mod mux;
mod network;
mod notify;
mod operator_voice_bus;
mod plans_board;
mod reap;
mod remote_connect;
mod self_install;
mod semantic_tool_cards;
mod session_config;
mod session_panes;
mod shared_cache;
mod sse;
mod su_session;
mod theme;
mod tool_display;
mod transcript;
mod tutorial;
mod ui;
#[path = "voice_proxy.rs"]
mod voice;
mod voice_convai;
mod voice_stream;
mod voice_ui;
mod wake_board;
mod workbench;
mod zellij_theme;

use anyhow::{Context, Result};
use crossterm::{
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::Backend, backend::CrosstermBackend, Terminal};
use std::io::stdout;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use app::{Action, App, DockCmd};
use client::OperatorClient;
use companion::Companion;
use event::{spawn_input_listener, Event};
use mux::{Multiplexer, MuxAction, Zellij};

const CLI_HELP: &str = "pui — Papercusp terminal agent

Usage:
  pui [OPTIONS]              Chat with an agent in the current directory
  pui [OPTIONS] [SUBCOMMAND]

Subcommands:
  workbench                  Open the full zellij workbench (boards, fleet, panes)
  doctor                     Verify local artifacts, stale panes, and selected operator identity
  self <COMMAND>             Install, update, roll back or uninstall this PUI (`pui self --help`)
  hud                      Open the HUD pane
  chat                       Open the operator chat dock
  brain-view [SCOPE]         View the live Queen/Overwatch transcript
  reap                       Remove leaked app-managed zellij sessions
  dock-driver                Run the dock driver and Fleet pane
  wake-pane [SCOPE]          Open the staged-wake board
  prompt-pane [OWNER]        Open the agent prompt board
  mail-pane [OWNER]          Open the agent coordination board
  work-pane [OWNER]          Open the agent work board
  network-pane               Open the cross-Hive network board
  hive-pane <KEY>            Open a Hive dossier
  context-pane [SOURCE ID]   Open Context for the live Sentinel or an exact session

Options:
  --fleet=<slug>             Join fresh PUI SU sessions to an existing fleet
  --seat=<ref>               Consume that fleet's delegated seat (requires --fleet)
  -h, --help                 Print this help text
  -V, --version              Print version information

Remote hosts (the same saved connections psu uses):
  --connect[=<name>[/<workspace>]]  Run pui on a saved remote host; no name opens a picker
  --connect-login[=<portal>]        Sign in to Papercusp cloud to reach its workspaces
  --connect-list                    List saved remote hosts
  Other --connect-* options are psu's; see `psu --help`.
";

const PUI_FLEET_ENV: &str = "PUI_FLEET";
const PUI_SEAT_ENV: &str = "PUI_SEAT";

/// Process-wide launch context. The top-level workbench exports it before
/// zellij starts, so every child `pui hud`/dock pane carries the same fleet and
/// delegated-seat selection without copying it into each generated command.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct CliInvocation {
    positionals: Vec<String>,
    fleet: Option<String>,
    seat: Option<String>,
}

impl CliInvocation {
    fn parse(
        args: impl IntoIterator<Item = String>,
        inherited_fleet: Option<&str>,
        inherited_seat: Option<&str>,
    ) -> Result<Self> {
        fn set_cli_value(slot: &mut Option<String>, name: &str, raw: &str) -> Result<()> {
            let value = raw.trim();
            if value.is_empty() {
                anyhow::bail!("{name} requires a non-empty value");
            }
            if let Some(existing) = slot {
                if existing != value {
                    anyhow::bail!("conflicting {name} values: {existing:?} and {value:?}");
                }
                return Ok(());
            }
            *slot = Some(value.to_string());
            Ok(())
        }

        fn merge_value(
            name: &str,
            explicit: Option<String>,
            inherited: Option<&str>,
        ) -> Result<Option<String>> {
            let inherited = inherited
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            if let (Some(explicit), Some(inherited)) = (&explicit, &inherited) {
                if explicit != inherited {
                    anyhow::bail!(
                        "conflicting {name} selectors: CLI resolves to {explicit:?}, environment resolves to {inherited:?}"
                    );
                }
            }
            Ok(explicit.or(inherited))
        }

        let mut positionals = Vec::new();
        let mut fleet = None;
        let mut seat = None;
        let mut pending: Option<&'static str> = None;

        for arg in args {
            if let Some(name) = pending.take() {
                if arg.starts_with("--") {
                    anyhow::bail!("{name} requires a value before {arg}");
                }
                match name {
                    "--fleet" => set_cli_value(&mut fleet, name, &arg)?,
                    "--seat" => set_cli_value(&mut seat, name, &arg)?,
                    _ => unreachable!("only fleet/seat can be pending"),
                }
                continue;
            }
            match arg.as_str() {
                "--fleet" => pending = Some("--fleet"),
                "--seat" => pending = Some("--seat"),
                _ if arg.starts_with("--fleet=") => {
                    set_cli_value(&mut fleet, "--fleet", &arg["--fleet=".len()..])?
                }
                _ if arg.starts_with("--seat=") => {
                    set_cli_value(&mut seat, "--seat", &arg["--seat=".len()..])?
                }
                _ => positionals.push(arg),
            }
        }
        if let Some(name) = pending {
            anyhow::bail!("{name} requires a value");
        }

        let fleet = merge_value("--fleet/PUI_FLEET", fleet, inherited_fleet)?;
        let seat = merge_value("--seat/PUI_SEAT", seat, inherited_seat)?;
        if seat.is_some() && fleet.is_none() {
            anyhow::bail!(
                "--seat/PUI_SEAT requires --fleet/PUI_FLEET because delegated seats belong to a fleet"
            );
        }
        Ok(Self {
            positionals,
            fleet,
            seat,
        })
    }

    fn positional(&self, index: usize) -> Option<&str> {
        self.positionals.get(index).map(String::as_str)
    }

    fn export_launch_env(&self) {
        if let Some(fleet) = &self.fleet {
            std::env::set_var(PUI_FLEET_ENV, fleet);
        }
        if let Some(seat) = &self.seat {
            std::env::set_var(PUI_SEAT_ENV, seat);
        }
    }
}

fn print_cli_help(subcommand: Option<&str>, subcommand_arg: Option<&str>) -> bool {
    if matches!(subcommand, Some("-h") | Some("--help"))
        || matches!(subcommand_arg, Some("-h") | Some("--help"))
    {
        print!("{CLI_HELP}");
        true
    } else {
        false
    }
}

fn print_cli_version(subcommand: Option<&str>, subcommand_arg: Option<&str>) -> bool {
    if matches!(subcommand, Some("-V") | Some("--version"))
        || matches!(subcommand_arg, Some("-V") | Some("--version"))
    {
        println!("pui {}", env!("CARGO_PKG_VERSION"));
        true
    } else {
        false
    }
}

/// Whether this process owns the pending-workbench-launch → native-pane transition.
///
/// `pui workbench` materializes its primary full TUI as `pui hud`, so `hud` is a
/// launch-capable mode even though it is spelled as a subcommand. The pinned data
/// boards remain non-reactive; otherwise every board races to open the same pane.
/// Bare `pui` is chat-first (P-001): one conversation with no multiplexer, so
/// it has nowhere to open a pane and must never claim a pending launch.
fn reactive_launch_mode(subcommand: Option<&str>) -> bool {
    matches!(subcommand, Some("hud") | Some("dock-driver"))
}

#[tokio::main]
async fn main() -> Result<()> {
    // Subcommand dispatch — bare `pui` is ONE full-screen chat in the current
    // directory, the way `claude` and `codex` start (pui-chat-first-ux P-001):
    //   pui           → chat-first: no zellij, tab strip, fleet rail or boards
    //   pui workbench → the zellij workbench with every board (D-001)
    //   pui hud       → just the full HUD (what the workbench's own HUD pane runs;
    //                   the workbench never launches bare `pui`, so it cannot nest).
    // `pui --connect…` runs pui on a remote host through psu's saved
    // connections (P-017 / D-025). Checked before any other parsing: psu owns
    // every `--connect*` cell, which PUI's own parser would misread as a
    // subcommand.
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    // Setup's `l` / `h` re-exec PUI into this TUI-free supervisor (P-021).
    if let Some(sign_in) = remote_connect::parse_setup_connect(&raw_args) {
        return remote_connect::supervise_setup_connect(sign_in).await;
    }
    if remote_connect::requests_connection(&raw_args) {
        std::process::exit(remote_connect::hand_off(&raw_args)?);
    }
    let inherited_fleet = std::env::var(PUI_FLEET_ENV).ok();
    let inherited_seat = std::env::var(PUI_SEAT_ENV).ok();
    let cli = CliInvocation::parse(
        raw_args,
        inherited_fleet.as_deref(),
        inherited_seat.as_deref(),
    )?;
    cli.export_launch_env();
    let subcommand = cli.positional(0).map(str::to_string);
    let subcommand_arg = cli.positional(1).map(str::to_string);
    // `pui self …` owns its own help and flags (P-011 / D-016), so it is routed
    // before the global --help/--version handling would swallow them.
    if subcommand.as_deref() == Some("self") {
        return self_install::run(&cli.positionals[1..]);
    }
    install::prefer_bundled_tools();
    if print_cli_help(subcommand.as_deref(), subcommand_arg.as_deref()) {
        return Ok(());
    }
    if print_cli_version(subcommand.as_deref(), subcommand_arg.as_deref()) {
        return Ok(());
    }
    match subcommand.as_deref() {
        Some("workbench") => return run_workbench().await,
        Some("doctor") => return run_doctor().await,
        // The chat-only DOCK (operator chat | brain) — the desktop-docked native
        // terminal surface (native-terminal-desktop P-013 / D-011). Materialises
        // its own 2-pane layout and hands off to zellij.
        Some("chat") => return run_chat_dock().await,
        // Manual sweep of leaked app-managed zellij sessions (EI-186) — the same
        // sweep every workbench/dock launch runs. For ops + smoke-testing.
        Some("reap") => {
            reap::reap_stale(&layout::session_name("reap"));
            return Ok(());
        }
        // Read-only live transcript view of the autonomous Queen / Overwatch
        // (queen-overwatch-live-visibility D-003): the dock's ♛ queen / 👁 overwatch
        // panes. Tails the ONE shared session transcript so every desktop instance
        // shows the SAME live agent + survives shell exit (not a per-window psu shell).
        Some("brain-view") => {
            return brain_view::run(brain_view::Scope::from_arg(cli.positional(1))).await;
        }
        Some("hud") => {}
        // Dock pane modes — fall through to the normal run loop. The old
        // main-pane (tab-subset) + voice-/swarm-/bee-pane standalone modes are
        // GONE (tab surfaces live in the pui app, not zellij), and
        // hive-agent-tabs P-014 retired `chat-pane` (the dock's operator-chat
        // widget — the Sentinel is a real psu session now) and
        // `watch-pane <owner>` (the read-only per-bee view — claude bees
        // resume as real Claude TUIs via the dock-driver).
        // dock-driver (hive-agent-tabs P-004/D-009): the operator pane is psu,
        // so the reactive agent stack needs a dedicated driver pane — it runs
        // the reactive loop + renders the Fleet roster as the dock controller.
        // wake-pane (EI-312): the dock's staged-wake board — every manual-mode
        // agent's pending wakes (queen first) with release / edit / skip and
        // the release-all / skip-all drains. Pinned to the pane-only Tab::Wake.
        // prompt-/mail-/work-pane (dock 4-pane split, owner ask 2026-06-11): one
        // agent-context board each — the prompt the agent runs on, the coord mail, the work
        // items + plan linkage. Scope arg like wake-pane (--queen | <owner>).
        // network-pane / hive-pane (hive-network-surface-2026-06-11 B-09): the
        // dock `network` tab's cross-Hive board, and the per-hive drill-in
        // tab's dossier pane (B-10's generated tabs run `pui hive-pane <key>`).
        // context-pane: the dock's canonical context projection. `plans-pane`
        // remains an unadvertised compatibility alias for existing layouts.
        Some("dock-driver") | Some("wake-pane") | Some("prompt-pane") | Some("mail-pane")
        | Some("work-pane") | Some("network-pane") | Some("hive-pane") | Some("context-pane")
        | Some("plans-pane") => {}
        _ => {}
    }
    // Pinned single-tab dock pane: render JUST that tab's body (no tab strip /
    // HUD / work area); the full data wiring in run() is unchanged.
    let pinned = match subcommand.as_deref() {
        // dock-driver: render the Fleet roster (the dock controller) while driving
        // the reactive bee stack (hive-agent-tabs P-004/D-009).
        Some("dock-driver") => Some(app::Tab::Fleet),
        // wake-pane: the staged-wake board (EI-312).
        Some("wake-pane") => Some(app::Tab::Wake),
        Some("prompt-pane") | Some("mail-pane") | Some("work-pane") => Some(app::Tab::AgentCtx),
        // network-pane: the cross-Hive board; hive-pane: one row's dossier
        // (same tab — `network_focus` below selects the mode).
        Some("network-pane") | Some("hive-pane") => Some(app::Tab::Network),
        Some("context-pane") | Some("plans-pane") => Some(app::Tab::PlansBoard),
        _ => None,
    };
    // Slim dock theme (owner ask 2026-06-23): a pinned dock pane renders base
    // surfaces TRANSPARENT so the ratatui dock panes (Fleet/colony, the queen
    // boards, wakes) inherit the user's plain Ghostty bg — matching the slim
    // plain-text brain-view panes + the Claude TUI, instead of painting the
    // opaque `frost` panel over the dock (the colony pane was the lone holdout
    // that "didn't get the new theme"). Off in the standalone workbench
    // (pinned == None), which keeps the opaque dashboard surfaces.
    if pinned.is_some() {
        crate::theme::Theme::set_transparent_surfaces(true);
    }
    // Colour-disabled mode (P-013, https://no-color.org): honour NO_COLOR for
    // every frame this process draws, the standalone workbench and dock panes alike.
    crate::theme::Theme::set_monochrome(crate::theme::no_color_requested(
        std::env::var_os("NO_COLOR").as_deref(),
    ));
    let agent_ctx_mode = match subcommand.as_deref() {
        Some("mail-pane") => app::AgentCtxMode::Mail,
        Some("work-pane") => app::AgentCtxMode::Work,
        _ => app::AgentCtxMode::Prompt,
    };
    // Hive drill-in pane (hive-network-surface B-09, the B-10 tab seam): the
    // C-3 row key (slug or pubkey-b64) this instance renders full-pane.
    // Required argv[2] for `hive-pane`; `network-pane` renders the board.
    let network_focus: Option<String> = match subcommand.as_deref() {
        Some("hive-pane") => match cli.positional(1) {
            Some(k) if !k.trim().is_empty() => Some(k.trim().to_string()),
            _ => {
                eprintln!("usage: pui hive-pane <key>");
                std::process::exit(2);
            }
        },
        _ => None,
    };
    // An explicit source/session pair pins Context to that exact producer. With
    // no pair, the roster reducer binds the pane to the live Sentinel native
    // session; one half of the pair is rejected rather than guessed.
    let context_target = match subcommand.as_deref() {
        Some("context-pane") | Some("plans-pane") => match (cli.positional(1), cli.positional(2)) {
            (None, None) => None,
            (Some(source), Some(id)) if !source.trim().is_empty() && !id.trim().is_empty() => {
                Some(models::ConversationContextProjectionTarget::new(
                    source.trim(),
                    id.trim(),
                    cli.positional(3)
                        .filter(|h| !h.trim().is_empty())
                        .map(str::to_string),
                ))
            }
            _ => {
                eprintln!("usage: pui context-pane [SOURCE_KIND SESSION_ID [HARNESS]]");
                std::process::exit(2);
            }
        },
        _ => None,
    };
    // Wake-pane scope (owner ask 2026-06-11): bare `wake-pane` = the fleet-wide
    // board; `wake-pane --queen` = the live queen's queue (resolved from the
    // roster each refresh — her owner id isn't known at layout time); `wake-pane
    // <owner-id>` = one explicit agent's queue; `wake-pane --hive <slug>` = one
    // hive's attributed owners (P-014 item 3 — the drill-in tab's wake board,
    // server-filtered via `network.hive.wakes`).
    let wake_filter: app::WakeFilter = match subcommand.as_deref() {
        Some("wake-pane") => match cli.positional(1) {
            Some("--queen") => app::WakeFilter::Queen,
            Some("--hive") => match cli.positional(2) {
                Some(h) if !h.trim().is_empty() => app::WakeFilter::Hive(h.trim().to_string()),
                _ => {
                    eprintln!("usage: pui wake-pane --hive <slug>");
                    std::process::exit(2);
                }
            },
            Some(o) if !o.trim().is_empty() => app::WakeFilter::Owner(o.trim().to_string()),
            _ => app::WakeFilter::All,
        },
        // The agent-context panes share the wake-pane's scope grammar; their
        // bare default is the QUEEN (they sit in her dock column).
        Some("prompt-pane") | Some("mail-pane") | Some("work-pane") => match cli.positional(1) {
            Some("--queen") | None => app::WakeFilter::Queen,
            Some(o) if !o.trim().is_empty() => app::WakeFilter::Owner(o.trim().to_string()),
            _ => app::WakeFilter::Queen,
        },
        _ => app::WakeFilter::All,
    };
    // The dock-driver drives the reactive agent stack (hive-agent-tabs
    // P-004/D-009): one live `claude --resume` pane per resumable bee + one
    // interactive pane per new local launch, appended to the dock's stack.
    let dock_agent_panes = subcommand.as_deref() == Some("dock-driver");
    // EI-358: only launch-capable modes react to pending workbench launches —
    // the full TUI (bare or the workbench's explicit `pui hud`) and the
    // dock-driver. Board panes (wake/prompt/mail/work/network/hive) must never
    // open launch panes.
    // Races among the capable modes are settled by claim-then-open.
    let reactive_launch_panes = reactive_launch_mode(subcommand.as_deref());
    // The dock-driver is the only mode with the driver-only surfaces (frame
    // tabs, the regroup repair, the Fleet roster's glyph/badge columns).
    let hive_agent_tabs = subcommand.as_deref() == Some("dock-driver");
    let chat_first = subcommand.is_none();
    if chat_first {
        // Like `claude`, the chat inherits the terminal's own background
        // rather than painting the workbench's opaque dashboard panels.
        crate::theme::Theme::set_transparent_surfaces(true);
    }

    enable_raw_mode()?;
    let mut out = stdout();
    // Bracketed paste makes the terminal hand us a paste as ONE `Paste` frame
    // instead of replaying it as keystrokes. Without it every newline in a
    // pasted snippet arrives as `Enter` and submits, so pasting three lines sent
    // three separate half-messages. Disabled again on teardown below.
    // Focus-change reporting (P-007): hold-to-talk stops on a key RELEASE, and a
    // release can only be delivered to whoever holds focus. Without this, moving
    // focus away mid-hold — alt-tabbing, or hopping zellij panes in the dock —
    // leaves the microphone open indefinitely with nothing on screen to explain
    // it. `FocusLost` is the one signal that says the keys we believe are held
    // can never be released to us. Disabled again on teardown below.
    execute!(
        out,
        EnterAlternateScreen,
        crossterm::event::EnableBracketedPaste,
        crossterm::event::EnableFocusChange
    )?;
    // Voice hold-to-talk (voice-mode-tui-port-2026-06-05 D-007): request key
    // RELEASE events when the terminal speaks the kitty keyboard protocol, so
    // holding `v` can drive PTT. Without support no release events arrive and
    // PTT falls back to press-to-toggle. Best-effort.
    //
    // DISAMBIGUATE_ESCAPE_CODES (pui-chat-first-ux P-004) makes Shift+Enter
    // arrive as Enter+SHIFT, so it can insert a newline the way Claude Code and
    // Codex do; without it the terminal sends a plain CR and Shift+Enter would
    // send the message. Text keys still arrive as text under this flag. Where
    // the protocol is absent, a trailing `\` + Enter and Alt+Enter still work.
    //
    // That probe waits up to 2 s in a terminal that never answers it, so show
    // startup progress first (pui-first-party-public-release P-013: "display
    // meaningful startup progress immediately"). Cleared before the first frame.
    let _ = execute!(
        out,
        crossterm::cursor::MoveTo(0, 0),
        crossterm::style::Print("Starting PUI…")
    );
    let kbd_enhanced = crossterm::terminal::supports_keyboard_enhancement().unwrap_or(false);
    if kbd_enhanced {
        let _ = execute!(
            out,
            crossterm::event::PushKeyboardEnhancementFlags(
                crossterm::event::KeyboardEnhancementFlags::REPORT_EVENT_TYPES
                    | crossterm::event::KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
            )
        );
    }
    // ratatui diffs against a blank screen; leave it one.
    let _ = execute!(
        out,
        crossterm::terminal::Clear(crossterm::terminal::ClearType::All)
    );
    let mut terminal = Terminal::new(CrosstermBackend::new(out))?;

    let result = run(
        &mut terminal,
        cli.fleet,
        cli.seat,
        pinned,
        network_focus,
        context_target,
        wake_filter,
        agent_ctx_mode,
        dock_agent_panes,
        hive_agent_tabs,
        reactive_launch_panes,
        chat_first,
        kbd_enhanced,
    )
    .await;

    // Always restore the terminal, even on error.
    if kbd_enhanced {
        let _ = execute!(
            terminal.backend_mut(),
            crossterm::event::PopKeyboardEnhancementFlags
        );
    }
    disable_raw_mode().ok();
    // Paired with the EnableBracketedPaste / EnableFocusChange above: leaving
    // either armed would outlive the TUI — corrupting pastes in the user's shell
    // after pui exits, and spraying focus escape sequences into it.
    execute!(
        terminal.backend_mut(),
        crossterm::event::DisableFocusChange,
        crossterm::event::DisableBracketedPaste,
        LeaveAlternateScreen
    )
    .ok();
    terminal.show_cursor().ok();
    // pui-chat-first-ux P-009: end (or, after /detach, keep) the attached
    // conversation's engine. This runs on every way out of `run`, including
    // the error return a closed terminal causes, and before anything is
    // printed: a write to a hung-up terminal must not be able to skip it.
    let exit_note = finish_su_session_on_exit().await;
    // pui-chat-first-ux P-004 "clean scrollback": now that the alternate screen
    // is gone, print the conversation to the normal screen so it stays in the
    // terminal's own scrollback (set by `run` for the chat-first surface only).
    // `writeln!`, not `println!`: after SIGHUP stdout is gone and println panics.
    {
        use std::io::Write as _;
        if let Some(text) = EXIT_TRANSCRIPT.get() {
            let _ = writeln!(std::io::stdout(), "{text}");
        }
        if let Some(note) = exit_note {
            let _ = writeln!(std::io::stderr(), "{note}");
        }
    }
    result
}

/// pui-chat-first-ux P-009: what quitting does to the attached conversation's
/// engine, handed from `run` (which owns the `App`) to `main`. Refreshed on
/// every event instead of computed once at the end, because a closed terminal
/// makes the next draw fail and `run` returns early with that error.
static SU_SESSION_EXIT: std::sync::Mutex<Option<su_session::SuSessionExit>> =
    std::sync::Mutex::new(None);

/// How long quitting waits for the host to end (or detach) the engine. The
/// host's attendance lease still ends an engine this call failed to reach.
const SU_SESSION_EXIT_TIMEOUT: Duration = Duration::from_secs(3);

/// After a quit signal, pui exits within this long even if teardown hangs.
const SIGNAL_QUIT_DEADLINE: Duration = Duration::from_secs(5);

fn record_su_session_exit(app: &App) {
    let plan = app.su_session_exit();
    if let Ok(mut slot) = SU_SESSION_EXIT.lock() {
        if *slot != plan {
            *slot = plan;
        }
    }
}

/// Carry out the recorded quit plan and return the one line to tell the user.
async fn finish_su_session_on_exit() -> Option<String> {
    let plan = SU_SESSION_EXIT
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())?;
    let detach = matches!(plan, su_session::SuSessionExit::Detach { .. });
    let outcome = tokio::time::timeout(SU_SESSION_EXIT_TIMEOUT, async move {
        let client = OperatorClient::from_discovery().await?;
        match plan {
            su_session::SuSessionExit::End {
                harness,
                chat_id,
                command,
            } => {
                client
                    .send_su_session_command(&harness, &chat_id, command)
                    .await
            }
            su_session::SuSessionExit::Detach { harness, chat_id } => {
                client.detach_su_session(&harness, &chat_id).await
            }
        }
    })
    .await;
    Some(su_session_exit_note(detach, outcome.map_err(|_| ())))
}

/// The line pui prints after quitting a conversation (P-009).
fn su_session_exit_note(
    detach: bool,
    outcome: std::result::Result<Result<serde_json::Value>, ()>,
) -> String {
    let failure = match outcome {
        Ok(Ok(_)) => None,
        Ok(Err(error)) => Some(format!("{error:#}")),
        Err(()) => Some("the operator did not answer in time".to_string()),
    };
    match (detach, failure) {
        (false, None) => {
            "Conversation ended. Open pui and use /resume to continue it.".to_string()
        }
        (true, None) => {
            "This conversation is still running. Open pui and use /resume to return to it."
                .to_string()
        }
        (false, Some(why)) => format!(
            "pui could not end this conversation ({why}); the operator ends it shortly because nothing is attached."
        ),
        (true, Some(why)) => format!(
            "pui could not keep this conversation running ({why}); it ends shortly because nothing is attached."
        ),
    }
}

/// pui-chat-first-ux P-009: SIGHUP (the terminal closed), SIGTERM and SIGINT
/// become an ordinary quit, so the attached conversation's engine ends as it
/// does on /exit. Registering them replaces the default disposition, which
/// killed pui with no teardown at all; so a watchdog bounds the quit, and a
/// second signal exits at once.
#[cfg(unix)]
async fn terminate_signal_listener(tx: UnboundedSender<Event>) {
    use tokio::signal::unix::{signal, SignalKind};
    let (Ok(mut hangup), Ok(mut terminate), Ok(mut interrupt)) = (
        signal(SignalKind::hangup()),
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) else {
        return;
    };
    let mut received = false;
    loop {
        // The exit code a shell expects for each signal: 128 + its number.
        let code = tokio::select! {
            _ = hangup.recv() => 129,
            _ = terminate.recv() => 143,
            _ = interrupt.recv() => 130,
        };
        if received {
            std::process::exit(code);
        }
        received = true;
        std::thread::spawn(move || {
            std::thread::sleep(SIGNAL_QUIT_DEADLINE);
            std::process::exit(code);
        });
        // A closed channel means the run loop already ended; main's teardown
        // is running and the watchdog above bounds it.
        let _ = tx.send(Event::Terminate);
    }
}

#[cfg(not(unix))]
async fn terminate_signal_listener(_tx: UnboundedSender<Event>) {}

#[cfg(test)]
mod su_session_exit_tests {
    use super::su_session_exit_note;

    #[test]
    fn the_exit_note_says_what_happened_to_the_conversation() {
        let ended = su_session_exit_note(false, Ok(Ok(serde_json::json!({"ok": true}))));
        assert!(ended.contains("ended") && ended.contains("/resume"));
        let kept = su_session_exit_note(true, Ok(Ok(serde_json::json!({"ok": true}))));
        assert!(kept.contains("still running") && kept.contains("/resume"));
        let failed = su_session_exit_note(true, Ok(Err(anyhow::anyhow!("409 session_terminal"))));
        assert!(failed.contains("could not keep") && failed.contains("409"));
        let late = su_session_exit_note(false, Err(()));
        assert!(late.contains("could not end") && late.contains("in time"));
    }
}

/// The chat-first conversation as plain text, handed from `run` (which owns the
/// `App`) to `main` (which owns terminal teardown) so it can be printed AFTER
/// the alternate screen is left — printing it earlier would land on the
/// alternate screen and vanish with it.
static EXIT_TRANSCRIPT: std::sync::OnceLock<String> = std::sync::OnceLock::new();

#[cfg(test)]
mod cli_help_tests {
    use super::{print_cli_help, print_cli_version, CliInvocation, CLI_HELP};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn top_level_help_is_recognized() {
        assert!(print_cli_help(Some("--help"), None));
        assert!(print_cli_help(Some("-h"), None));
    }

    #[test]
    fn subcommand_help_is_recognized_before_dispatch() {
        assert!(print_cli_help(Some("workbench"), Some("--help")));
        assert!(print_cli_help(Some("doctor"), Some("-h")));
    }

    #[test]
    fn ordinary_subcommand_arguments_do_not_trigger_help() {
        assert!(!print_cli_help(Some("hive-pane"), Some("engineering")));
    }

    #[test]
    fn top_level_version_is_recognized() {
        assert!(print_cli_version(Some("--version"), None));
        assert!(print_cli_version(Some("-V"), None));
    }

    #[test]
    fn subcommand_version_is_recognized_before_dispatch() {
        assert!(print_cli_version(Some("workbench"), Some("--version")));
        assert!(print_cli_version(Some("doctor"), Some("-V")));
    }

    #[test]
    fn ordinary_subcommand_arguments_do_not_trigger_version() {
        assert!(!print_cli_version(Some("hive-pane"), Some("engineering")));
    }

    #[test]
    fn seat_context_flags_are_global_and_preserve_subcommand_positionals() {
        let equals = CliInvocation::parse(
            args(&[
                "--fleet=fed-drill",
                "hive-pane",
                "engineering",
                "--seat=opus[1m]:xhigh:AUTO",
            ]),
            None,
            None,
        )
        .unwrap();
        assert_eq!(equals.positionals, ["hive-pane", "engineering"]);
        assert_eq!(equals.fleet.as_deref(), Some("fed-drill"));
        assert_eq!(equals.seat.as_deref(), Some("opus[1m]:xhigh:AUTO"));

        let split = CliInvocation::parse(
            args(&[
                "workbench",
                "--fleet",
                "fed-drill",
                "--seat",
                "sonnet:high:auto",
            ]),
            None,
            None,
        )
        .unwrap();
        assert_eq!(split.positionals, ["workbench"]);
        assert_eq!(split.fleet.as_deref(), Some("fed-drill"));
        assert_eq!(split.seat.as_deref(), Some("sonnet:high:auto"));
    }

    #[test]
    fn inherited_seat_context_is_reused_by_zellij_child_panes() {
        let child =
            CliInvocation::parse(args(&["hud"]), Some("fed-drill"), Some("sonnet:high:auto"))
                .unwrap();
        assert_eq!(child.positionals, ["hud"]);
        assert_eq!(child.fleet.as_deref(), Some("fed-drill"));
        assert_eq!(child.seat.as_deref(), Some("sonnet:high:auto"));
    }

    #[test]
    fn seat_context_refuses_missing_fleet_and_conflicting_sources() {
        let missing =
            CliInvocation::parse(args(&["--seat=sonnet:high:auto", "workbench"]), None, None)
                .unwrap_err();
        assert!(missing.to_string().contains("requires --fleet"));

        let conflict = CliInvocation::parse(
            args(&["--fleet=fleet-a", "workbench"]),
            Some("fleet-b"),
            None,
        )
        .unwrap_err();
        assert!(conflict.to_string().contains("conflicting --fleet"));
    }

    #[test]
    fn help_documents_remote_seat_consumption() {
        assert!(CLI_HELP.contains("--fleet=<slug>"));
        assert!(CLI_HELP.contains("--seat=<ref>"));
        assert!(CLI_HELP.contains("--connect[=<name>[/<workspace>]]"));
        assert!(CLI_HELP.contains("--connect-login"));
        assert!(CLI_HELP.contains("requires --fleet"));
    }
}

#[cfg(test)]
mod doctor_tests {
    use super::{operator_failure_lines, operator_failure_status_line};
    use crate::http::IdentityMismatchError;

    /// R1 (UI half): the status line must carry the SAME classification doctor
    /// prints. It previously shipped the raw anyhow chain, which names no kind,
    /// no endpoint and no action — leaving the status bar saying that something
    /// went wrong and nothing about what to do.
    #[test]
    fn the_status_line_carries_the_classification_not_a_raw_error_chain() {
        let error = anyhow::Error::new(IdentityMismatchError {
            endpoint: "https://op.example:9443".into(),
            detail: "serves pg-b".into(),
        });

        let line = operator_failure_status_line("https://op.example:9443", &error);
        assert!(
            line.starts_with("operator identity-mismatch"),
            "the status line must LEAD with the failure kind: {line}"
        );
        assert!(
            line.contains("https://op.example:9443"),
            "the status line must name the operator it is about: {line}"
        );
        assert!(
            !line.contains('\n'),
            "the status bar renders a single line; a multi-line message would \
             be silently clipped: {line}"
        );
    }

    /// R1/R2: an unreachable or wrong backend must come out of doctor as a
    /// NAMED failure carrying its endpoint and a repair — the three things that
    /// make the output actionable.
    #[test]
    fn doctor_reports_a_classified_failure_with_an_endpoint_and_a_repair() {
        let error = anyhow::Error::new(IdentityMismatchError {
            endpoint: "https://op.example:9443".into(),
            detail: "bound to store pg-a, but that operator serves pg-b".into(),
        });

        let lines = operator_failure_lines("https://op.example:9443", &error).join("\n");
        assert!(
            lines.contains("PUI operator identity: FAILED (identity-mismatch)"),
            "doctor must name the failure KIND, not just report a problem: {lines}"
        );
        assert!(
            lines.contains("https://op.example:9443"),
            "doctor must name the endpoint the failure is about: {lines}"
        );
        assert!(
            lines.contains("pg-b"),
            "doctor must keep the underlying detail: {lines}"
        );
        assert!(
            lines.contains("repair:"),
            "doctor must print an action, not just a diagnosis: {lines}"
        );
    }

    /// Recurrence guard for the defect this replaced: `run_doctor` used to do
    /// `selected_backend_identity().await?`, so an unreachable operator aborted
    /// the whole command and printed NOTHING — no local-install section, and
    /// never the "operator identity" section at all. Doctor is the tool you run
    /// when the backend is broken; it must not require the backend to work.
    ///
    /// Falsifiable by construction: restore the `?` and this fails.
    #[test]
    fn doctor_renders_the_backend_failure_instead_of_aborting_on_it() {
        let src = include_str!("main.rs");

        // The needles are ASSEMBLED, never written as literals: this test lives
        // in the same file it searches, so a literal delimiter would appear in
        // the source ahead of the function and `split_once` would happily match
        // THIS TEST instead of `run_doctor` — the self-match trap, and it does
        // not fail loudly, it silently measures the wrong region.
        let open = format!("async fn run_{}() -> Result<()> {{", "doctor");
        let close = format!("\nasync fn run_{}", "workbench");
        let body = src
            .split_once(open.as_str())
            .expect("run_doctor not found — did it get renamed?")
            .1
            .split_once(close.as_str())
            .expect("could not delimit run_doctor body")
            .0;

        // Positive control: prove the delimiters actually captured run_doctor.
        // Without this, a drifted delimiter yields some unrelated slice and the
        // "must not contain" assertion below passes vacuously — a broken
        // instrument reading exactly like a satisfied guard.
        assert!(
            body.contains("PUI local install:"),
            "delimiters did not capture run_doctor's body; this guard would \
             otherwise pass without measuring anything:\n{body}"
        );
        let propagates = format!("selected_backend_identity().await{}", "?");
        assert!(
            !body.contains(propagates.as_str()),
            "run_doctor must not propagate the rendezvous failure — doing so \
             makes doctor print nothing in the exact case it exists to \
             diagnose. Render it with operator_failure_lines instead.\n{body}"
        );
        assert!(
            body.contains("operator_failure_lines("),
            "run_doctor must render the classified rendezvous failure:\n{body}"
        );
    }
}

/// Materialise the workbench layout and hand off to zellij. Replaces this
/// process's foreground with the zellij session; on exit we mirror its code.
/// The session is app-managed with a STABLE name (`pui-wb`, P-001 refit): a
/// live survivor from a crashed/detached predecessor is ATTACHED to instead of
/// leaked around; otherwise stale leftovers (EXITED husks + legacy pid-keyed
/// sessions, EI-186) are reaped and a fresh session is created. zellij
/// returning — exit OR detach — still kills the session, so no detached server
/// (whose dead-pane PTYs busy-spin) is left behind.
async fn selected_backend_identity() -> Result<(OperatorClient, client::BackendIdentity)> {
    let client = OperatorClient::from_discovery()
        .await
        .context("resolve canonical PUI operator endpoint")?;
    let identity = client
        .backend_identity()
        .await
        .context("probe canonical PUI operator/store identity")?;
    Ok((client, identity))
}

/// The `pui doctor` operator-identity section for a FAILED rendezvous (R1/R2).
/// Pure and separate from the printing so the guard below can assert doctor
/// stays diagnostic exactly when the backend is not.
fn operator_failure_lines(endpoint_label: &str, error: &anyhow::Error) -> Vec<String> {
    let failure = http::RendezvousError::classify(endpoint_label, error);
    vec![
        format!("PUI operator identity: FAILED ({})", failure.kind.label()),
        format!("endpoint:       {}", failure.endpoint),
        format!("detail:         {}", failure.detail),
        format!("repair:         {}", failure.repair()),
    ]
}

/// One doctor line per app-managed stable session + whether it is an orphan
/// (counts as a doctor failure). Pure so the verdict wording is testable.
fn doctor_session_line(
    name: &str,
    exited: bool,
    verdict: Option<identity::LauncherVerdict>,
) -> (String, bool) {
    use identity::LauncherVerdict as V;
    match (exited, verdict) {
        (true, _) => (format!("{name} — EXITED husk (deleted on next launch)"), false),
        (false, Some(V::Alive(l))) => (format!("{name} — live, launcher alive ({})", l.label()), false),
        (false, Some(V::Dead { launcher, reason })) => (
            format!(
                "{name} — ORPHAN: {reason}; launched by {} — the next launch would attach to it",
                launcher.label()
            ),
            true,
        ),
        (false, Some(V::Unknown)) => (
            format!("{name} — live, launcher unknown (legacy stamp; attach allowed)"),
            false,
        ),
        (false, None) => (
            format!("{name} — live, no identity stamp (attach is refused; `zellij kill-session {name}` to clear)"),
            false,
        ),
    }
}

#[cfg(test)]
mod doctor_session_tests {
    use super::*;
    use identity::{Launcher, LauncherVerdict};

    fn l(pid: u32) -> Launcher {
        Launcher {
            pid,
            boot_id: None,
            sid: Some("su-ed29de9b-4ca0".into()),
            agent: Some("codex".into()),
            created_at_epoch: 0,
        }
    }

    #[test]
    fn orphan_is_the_only_failing_verdict_and_names_the_launcher() {
        let (line, fail) = doctor_session_line(
            "pui-wb",
            false,
            Some(LauncherVerdict::Dead {
                launcher: l(2053474),
                reason: "launcher pid 2053474 is gone".into(),
            }),
        );
        assert!(fail);
        assert!(
            line.contains("ORPHAN") && line.contains("2053474") && line.contains("codex"),
            "{line}"
        );
        for (exited, v) in [
            (false, Some(LauncherVerdict::Alive(l(1)))),
            (false, Some(LauncherVerdict::Unknown)),
            (false, None),
            (true, None),
        ] {
            let (line, fail) = doctor_session_line("pui-wb", exited, v);
            assert!(!fail, "{line}");
        }
    }
}

/// The status-line form of the same classified failure (R1, UI half).
///
/// The status bar is ONE line and is the only place most users will ever see
/// this, so it leads with the two things that orient them — what kind of
/// failure, and against which operator — and carries the repair behind them.
/// A wide terminal shows the whole thing; a narrow one still shows the part
/// that says where to look, and `pui doctor` prints it in full.
fn operator_failure_status_line(endpoint_label: &str, error: &anyhow::Error) -> String {
    http::RendezvousError::classify(endpoint_label, error).status_line()
}

async fn run_doctor() -> Result<()> {
    let local = install::inspect_local_install();
    // NOT `?`. Doctor is the tool you reach for WHEN the backend is broken, so
    // propagating here made it print nothing at all in exactly the case it
    // exists to explain — and left the "operator identity: OK" line below
    // unconditional, because the failing path could never reach it. The
    // rendezvous failure is classified and RENDERED instead (R1/R2).
    let selected = selected_backend_identity().await;
    let mut failures = 0usize;

    match &local {
        Ok(check) => {
            println!(
                "PUI local install: {}",
                if check.is_ok() { "OK" } else { "STALE" }
            );
            println!(
                "binary:         v{} source {}{} · {} · {}",
                install::BUILD_VERSION,
                install::BUILD_SHA,
                if install::BUILD_DIRTY == "1" {
                    " (dirty)"
                } else {
                    ""
                },
                install::age_label(check.binary_modified_epoch),
                &check.binary_sha256[..12]
            );
            println!(
                "companion:      {} · {}",
                install::age_label(check.companion_modified_epoch),
                &check.companion_sha256[..12]
            );
            println!("manifest:       {}", check.manifest_path.display());
            for warning in &check.warnings {
                println!("warning:        {warning}");
            }
            for problem in &check.problems {
                failures += 1;
                println!("problem:        {problem}");
            }
        }
        Err(error) => {
            failures += 1;
            println!("PUI local install: ERROR");
            println!("problem:        {error:#}");
            println!(
                "repair:         run {}",
                install::update_command(install::current_install_origin())
            );
        }
    }

    match &selected {
        Ok((_client, identity)) => {
            println!("PUI operator identity: OK");
            println!("endpoint:       {}", identity.endpoint);
            println!("selection:      {}", identity.selection_source);
            println!("transport:      {}", identity.transport);
            println!("workspace:      {}", identity.workspace_id);
            println!(
                "store:          {} ({}, {})",
                identity.store.id, identity.store.target, identity.store.source
            );
            println!(
                "build:          v{} ({})",
                identity.build.version,
                identity.build.sha.as_deref().unwrap_or("sha unavailable")
            );
            println!(
                "agent chat:     {} via {}",
                identity.agent_chat.scope, identity.agent_chat.route
            );
            let installed_sha = local
                .as_ref()
                .map(|check| check.manifest.source_sha.as_str())
                .unwrap_or(install::BUILD_SHA);
            // Best-effort (EI-22066271581968324): when the manifest recorded the
            // worktree `installed_sha` was built from, ask git whether the
            // operator's differing sha is already covered by it — distinguishes
            // "operator is pinned behind by design" (nothing to rebuild) from a
            // genuinely stale local install (rebuild is the real fix). A release
            // install has no checkout, so it answers the same question from the
            // source-ancestry listing its unit ships (WI-10003535). `None`
            // (neither source available, or ancestry can't be determined)
            // preserves the original STALE+repair verdict unchanged.
            let operator_generation_caught_up = local.as_ref().ok().and_then(|check| {
                let operator_sha = identity.build.sha.as_deref()?;
                check
                    .manifest
                    .source_root
                    .as_deref()
                    .and_then(|root| {
                        install::operator_generation_contained(root, operator_sha, installed_sha)
                    })
                    .or_else(|| {
                        install::release_generation_contained(&check.binary_path, operator_sha)
                    })
            });
            let freshness = install::operator_install_freshness(
                installed_sha,
                identity.build.sha.as_deref(),
                &identity.endpoint,
                operator_generation_caught_up,
            )
            .for_origin(
                install::current_install_origin(),
                identity.build.sha.as_deref(),
            );
            println!("PUI operator install: {}", freshness.status.label());
            println!("freshness:      {}", freshness.detail);
            if let Some(repair) = freshness.repair.as_deref() {
                println!("repair:         {repair}");
            }
            if !freshness.is_ok() {
                failures += 1;
            }
        }
        Err(error) => {
            failures += 1;
            for line in operator_failure_lines(&client::selected_endpoint_label(), error) {
                println!("{line}");
            }
        }
    }

    if let Ok(check) = &local {
        let panes = install::stale_zellij_panes(&check.binary_path);
        if panes.is_empty() {
            println!("zellij panes:   OK (no stale installed pui process)");
        } else {
            failures += panes.len();
            println!("zellij panes:   STALE ({})", panes.len());
            for pane in panes {
                println!("relaunch:       {}", pane.relaunch_guidance());
            }
        }
    }

    // Stable-session launcher audit (pui-tui-next-wave P-005,
    // EI-22440755576757822): a live `pui-*` session whose launcher is gone is
    // an ORPHAN the next launch would have attached to; name it and the repair.
    let sessions = reap::stable_sessions(&reap::list_sessions_output());
    if sessions.is_empty() {
        println!("zellij sessions: none");
    } else {
        for (name, exited) in sessions {
            let (line, orphan) =
                doctor_session_line(&name, exited, identity::launcher_verdict(&name));
            println!("session:        {line}");
            if orphan {
                failures += 1;
                println!("repair:         pui reap   (or `zellij kill-session {name}`)");
            }
        }
    }

    if failures > 0 {
        // Each problem printed its OWN repair line above; pointing at the local
        // install command unconditionally would misdirect a backend failure,
        // which no amount of reinstalling pui can fix.
        anyhow::bail!(
            "pui doctor found {failures} issue(s); act on the repair line printed for each (local artifacts: {})",
            install::update_command(install::current_install_origin())
        );
    }
    Ok(())
}

/// Attach-if-exists (P-001) with the ORPHAN rule (pui-tui-next-wave P-004,
/// EI-22440755576757822): a live survivor is attached to only while its
/// recorded launcher is alive. A survivor whose launcher is gone (an ended
/// agent's `pui-wb`, a killed background launch) is reaped and re-stamped so
/// the new user never inherits the dead launcher's environment. Returns
/// whether the caller should ATTACH (`true`) or CREATE (`false`).
fn resolve_survivor(session: &str, backend: &client::BackendIdentity) -> Result<bool> {
    let live = reap::live_session_exists(session);
    match identity::bind(session, backend, live)? {
        identity::Binding::Attached => Ok(true),
        identity::Binding::Created => Ok(false),
        identity::Binding::Orphaned { reason } => {
            eprintln!("pui: {session} is an orphaned survivor — {reason}; reaping it instead of attaching");
            reap::kill_and_delete(session);
            identity::clear(session);
            identity::bind(session, backend, false)?;
            Ok(false)
        }
    }
}

/// zellij needs a real terminal. A non-PTY launch (a backgrounded
/// `pui workbench`, EI-22373168217321170) used to create the session, fail to
/// hand off, and exit 0 — leaving a half-built `pui-wb` for the next launch to
/// attach to. Refuse up front, loudly, before any session exists.
fn require_interactive_terminal(command: &str) -> Result<()> {
    use std::io::IsTerminal;
    if std::io::stdin().is_terminal() && std::io::stdout().is_terminal() {
        return Ok(());
    }
    anyhow::bail!(
        "`pui {command}` needs an interactive terminal (stdin/stdout are not a TTY): run it in a terminal window, from the desktop launcher, or via capability:terminal — a background launch would leave an incomplete zellij session behind"
    )
}

async fn run_workbench() -> Result<()> {
    require_interactive_terminal("workbench")?;
    let session = layout::session_name("wb");
    let (_client, backend) = match selected_backend_identity().await {
        Ok(backend) => backend,
        Err(_) => {
            // A clean machine must reach the repair form even with no operator.
            // No multiplexer/session binding exists yet on this path.
            use std::os::unix::process::CommandExt;
            let error = std::process::Command::new(std::env::current_exe()?)
                .arg("hud")
                .env(session_config::SETUP_DRAFT_ENV, "")
                .exec();
            return Err(error.into());
        }
    };
    let live = resolve_survivor(&session, &backend)?;
    identity::inherit(&backend);
    let argv = if live {
        layout::attach_argv(&session)
    } else {
        reap::reap_stale(&session);
        let path = layout::materialize()?;
        layout::launch_argv(&path.to_string_lossy(), &session)
    };
    let (prog, rest) = argv.split_first().expect("launch argv is never empty");
    let status = std::process::Command::new(prog).args(rest).status()?;
    reap::kill_and_delete(&session);
    identity::clear(&session);
    std::process::exit(status.code().unwrap_or(0));
}

/// Materialise the chat-only dock (operator chat | brain) and hand off to zellij
/// — the surface the desktop-docked native terminal runs (native-terminal-desktop
/// P-013 / D-011). `psu --brain` was retired on 2026-06-21; the default brain
/// pane is the backend-neutral shared brain view. Override the whole brain
/// command with PAPERCUSP_BRAIN_CMD for local experiments.
async fn run_chat_dock() -> Result<()> {
    // SINGLE dock, STABLE name (`pui-dock`, P-001 refit; owner decision
    // 2026-06-25 stands): exactly ONE chat dock exists at a time — with a
    // stable name that is now STRUCTURAL (a second launch attaches to the
    // first's session) rather than enforced by killing uniquely-named peers.
    // WHY single: the Sentinel voice-in path keys off one global
    // `~/.papercusp/sentinel-pane` registration; several live docks race
    // last-writer-wins, sending voice to a background window's pane. The
    // queen/overwatch panes stay read-only views of the SHARED BACKEND roster,
    // so dock content is identical regardless of which window owns it.
    // Legacy pid-keyed `pui-dock-*` sessions (EI-186 scheme) are still reaped
    // on the create path, and zellij returning kills our own session.
    require_interactive_terminal("chat")?;
    let session = layout::session_name("dock");
    let (client, backend) = selected_backend_identity().await?;
    let live = resolve_survivor(&session, &backend)?;
    identity::inherit(&backend);
    let argv = if live {
        layout::attach_argv(&session)
    } else {
        let env = std::env::var("PAPERCUSP_BRAIN_CMD").ok();
        let brain_argv = layout::default_brain_argv(env.as_deref());
        // Resolve the active Hive lexicon (pane DISPLAY names) from the
        // operator; unreachable → classic lexicon. (The hive-agent-tabs flag
        // is RETIRED — the live-TUI dock shape is the only shape.)
        let lex = match client.lexicon_active_pack().await {
            Ok(pack) => lexicon::Lexicon::from_payload(&pack),
            Err(_) => lexicon::Lexicon::default(),
        };
        let path = layout::materialize_chat_dock(&brain_argv, &lex)?;
        reap::reap_stale(&session);
        layout::launch_argv(&path.to_string_lossy(), &session)
    };
    let (prog, rest) = argv.split_first().expect("launch argv is never empty");
    let status = std::process::Command::new(prog).args(rest).status()?;
    reap::kill_and_delete(&session);
    identity::clear(&session);
    std::process::exit(status.code().unwrap_or(0));
}

#[expect(
    clippy::too_many_arguments,
    reason = "top-level run wiring mirrors independent CLI launch dimensions"
)]
async fn run<B: Backend>(
    terminal: &mut Terminal<B>,
    launch_fleet: Option<String>,
    launch_seat: Option<String>,
    pinned: Option<app::Tab>,
    network_focus: Option<String>,
    context_target: Option<models::ConversationContextProjectionTarget>,
    wake_filter: app::WakeFilter,
    agent_ctx_mode: app::AgentCtxMode,
    dock_agent_panes: bool,
    hive_agent_tabs: bool,
    reactive_launch_panes: bool,
    chat_first: bool,
    kbd_enhanced: bool,
) -> Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();
    let mut app = App::new();
    // The starting geometry; every later change arrives as Event::Resize.
    if let Ok(size) = terminal.size() {
        app.viewport = (size.width, size.height);
    }
    app.require_session_setup = true;
    app.su_launch_fleet = launch_fleet;
    app.su_launch_seat = launch_seat;
    // Resolve the same canonical record `pui doctor` prints. This is an
    // independent process inside zellij, but both endpoint variables were
    // normalized/inherited by the session launcher above.
    tokio::spawn(backend_identity_fetch(tx.clone()));
    // Attention pops (transient toast + OS desktop notification) are MUTED by
    // default (owner ask 2026-06-14); `PUI_NOTIFY=1` (or true/on/yes) re-enables
    // them. The Inbox badge + `N` history overlay stay live regardless.
    app.notify_enabled = matches!(
        std::env::var("PUI_NOTIFY").ok().as_deref(),
        Some("1" | "true" | "on" | "yes")
    );
    // Pinned single-tab dock pane (P-013 / D-011): render JUST that tab's body —
    // the renderer short-circuits to it, and the run loop re-pins on each event
    // (below) so a stray nav key can't switch to an unrendered tab.
    app.pinned = pinned;
    if let Some(p) = pinned {
        app.tab = p;
    }
    // Chat-first (P-001): open on the conversation with the composer already
    // focused, so the first keystroke is the first word of the message.
    app.chat_first = chat_first;
    if chat_first {
        app.tab = app::Tab::Operator;
        app.chat_composing = true;
    }
    // hive-pane (B-09/B-10 drill-in): pin the dossier to one C-3 row key.
    app.network_focus = network_focus;
    app.context_projection_target_explicit = context_target.is_some();
    app.context_projection_target = context_target;
    app.dock_agent_panes = dock_agent_panes;
    app.hive_agent_tabs = hive_agent_tabs;
    app.reactive_launch_panes = reactive_launch_panes;
    // The wake-pane (EI-312): keep the staged-wake board fresh while pinned.
    app.wake_filter = wake_filter.clone();
    if pinned == Some(app::Tab::Wake) {
        tokio::spawn(wake_board_loop(wake_filter.clone(), tx.clone()));
    }
    // The agent-context panes (dock 4-pane split, owner ask 2026-06-11): keep
    // the brief/mail/work board fresh while pinned. The brief is launch-static
    // but the pane still polls — the agent itself can appear/exit.
    app.agent_ctx_mode = agent_ctx_mode;
    if pinned == Some(app::Tab::AgentCtx) {
        tokio::spawn(agent_ctx_loop(agent_ctx_mode, wake_filter, tx.clone()));
    }
    // pui's own zellij pane id = the HUD pane (dockview-workbench D-008). zellij
    // sets `$ZELLIJ_PANE_ID` for every pane it owns; the bare `:float`/`:dock`
    // dock-verbs target this pane. Absent outside zellij (the run loop then uses
    // focused-pane CLI fallbacks).
    app.hud_pane_id = std::env::var("ZELLIJ_PANE_ID")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok());
    // Show the first-run tutorial until this device has dismissed it once (P9).
    // A pinned dock pane is one of several panes a single launch opens; the
    // tutorial belongs to the main surface, not repeated (or, before the
    // full-screen overlay fix, drawn nowhere while swallowing keys) in each.
    app.show_tutorial = pinned.is_none() && !tutorial::seen();
    let setup_draft = std::env::var(session_config::SETUP_DRAFT_ENV).ok();
    let restoring_setup = setup_draft.is_some();
    if let Some(draft) = setup_draft {
        std::env::remove_var(session_config::SETUP_DRAFT_ENV);
        app.restore_setup_draft(draft);
    }
    if let Ok(note) = std::env::var(session_config::SETUP_NOTE_ENV) {
        std::env::remove_var(session_config::SETUP_NOTE_ENV);
        app.set_setup_note(note);
    }
    spawn_input_listener(tx.clone());
    tokio::spawn(terminate_signal_listener(tx.clone()));
    let sync_pane = PaneFetchScope {
        pinned,
        selected: Arc::new(Mutex::new(app.tab)),
    };
    let sync_refetch = spawn_sync(
        tx.clone(),
        app.active_harness.clone(),
        app.active_doc.clone(),
        app.active_plan.clone(),
        app.network_focus.clone(),
        sync_pane.clone(),
    );
    // Debounced persistence of the quiet view-state (P12 / D-002): the run loop
    // ships a snapshot on each nav change; the saver coalesces a burst + PUTs.
    let (save_tx, save_rx) = mpsc::unbounded_channel::<models::ViewState>();
    tokio::spawn(view_state_saver(save_rx));
    // Agent control surface (P12b / D-002 A6 — tui:dispatch): one task subscribes
    // the intent SSE → Event::TuiIntent (applied in the reducer); a poster ships
    // each result back. pui never polls — it holds the one SSE connection.
    let (intent_result_tx, intent_result_rx) =
        mpsc::unbounded_channel::<(i64, String, Option<String>)>();
    tokio::spawn(intent_result_poster(intent_result_rx));
    tokio::spawn(tui_intent_loop(tx.clone()));
    // Operator chat pane (tui-operator-surface-2026-06-04): load the workspace's
    // operator conversation on open so the transcript is seeded from the same
    // thread the desktop surface shares.
    let chat_load_token = app.next_agent_chat_load_token();
    if !restoring_setup {
        tokio::spawn(agent_chat_load(
            app.harness.clone(),
            None,
            chat_load_token,
            tx.clone(),
        ));
    }
    if let Some(target) = app.context_projection_target.clone() {
        tokio::spawn(fetch_context_projection(target, tx.clone()));
    }
    // Inline cards (sentinel-tui-shared-backend-and-cards-2026-06-22 Phase 2a):
    // subscribe the state-channel snapshot SSE so open `chat:ask_choice` cards
    // render inline in the operator pane (and resolve the active workspace once
    // for the `/card-response` defense-in-depth gate).
    tokio::spawn(card_snapshot_loop(tx.clone()));
    // Companion zellij plugin (P-004 / D-008): `pui`'s eyes + hands inside
    // zellij over a long-lived `zellij pipe` child. `None` when not running
    // inside zellij / without the plugin — orchestration then falls back to
    // fire-and-forget `zellij action` (below). Its events (topology, pane-exit)
    // arrive on `tx` like any other. NOT spawned in the dock modes (P-013 /
    // pui-dock-agent-stack): there is no work area to orchestrate there, and
    // loading the plugin surfaces an empty floating pane over the dock.
    let companion = if pinned.is_some() {
        None
    } else {
        Companion::spawn(tx.clone())
    };

    // Hive lexicon (pui-hive-lexicon-2026-06-06): fetch the ACTIVE resolved term
    // pack once at startup so user-facing labels (tab titles, dock pane names)
    // route through the SAME server-twin source as the desktop — flag flips
    // respected. Fail-soft: an unreachable operator leaves the classic fallback.
    tokio::spawn(lexicon_fetch(tx.clone()));

    // Bee dossier (pui-dock-consolidation-2026-06-07): the dossier renders
    // INSIDE the Fleet tab now, driven in-process by the roster cursor (see the
    // Action::PublishBeeSelection arm) — the old relay-polling pane loop is
    // gone, and the relay itself (`fleet:selected_bee`) was retired server-side
    // with the bee tier (P-003 own-tui-full-divorce-2026-08-24).

    // Voice mode (voice-mode-tui-port-2026-06-05 P2): the run loop owns the
    // audio handles — the long-lived playback `Player` and the in-flight mic
    // `CaptureSession` — so `App` stays pure/testable (the cpal/rodio objects
    // never enter app state). The PTT pipeline is driven from the `Action::Voice`
    // arm + a Tick-driven mic-meter pump.
    let voice_player = voice::Player::spawn();
    let mut voice_capture: Option<voice::CaptureSession> = None;
    // Realtime operator voice (voice-realtime-tui-2026-06-05): the run loop
    // owns the session handle too. A handle whose task already ended is inert
    // (stop() goes nowhere), so Start always replaces.
    let mut convai_session: Option<voice_convai::ConvAiHandle> = None;
    // P2P voice channels (holepunch-voice-channels P-008): the run loop owns the
    // long-lived voice socket (an Arc so the cpal capture callback can hold it)
    // and the in-flight mic-capture handle (dropping it stops transmitting).
    let mut voice_chan: Option<std::sync::Arc<voice_stream::VoiceStream>> = None;
    let mut voice_mic: Option<voice_stream::MicHandle> = None;
    // Open-mic (P-010): auto-start the mic once per channel join when
    // input_mode=open-mic, so it isn't restarted after a manual MicOff.
    let mut open_mic_started = false;

    terminal.draw(|f| ui::draw(f, &app))?;

    // Tracks the last notification we surfaced to the OS so we fire exactly one
    // system notification per new event (the reducer bumps notif_seq).
    let mut last_notif_seq = app.notif_seq;
    // Persist the tutorial dismissal exactly once, the first time it closes.
    let mut tutorial_persisted = !app.show_tutorial;

    'event_loop: while let Some(ev) = rx.recv().await {
        record_su_session_exit(&app);
        let prior_tab = app.tab;
        let prior_harness = app.harness.clone();
        let prior_context_target = app.context_projection_target.clone();
        let is_key = matches!(ev, Event::Key(_));
        let is_tick = matches!(ev, Event::Tick);
        let restoring_view = matches!(ev, Event::ViewStateLoaded(_));
        // The operator voice socket dropped (P-013 reconnect-on-drop): detect it
        // before the reducer consumes the event so we can free the run-loop-owned
        // handles below.
        let voice_dropped = matches!(
            &ev,
            Event::VoiceUi(crate::voice_ui::VoiceUiEvent::Stream(
                voice_stream::VoiceEvent::Disconnected
            ))
        );
        let action = app.update(ev);
        if app.harness != prior_harness {
            app.reset_agent_chat_binding();
            app.agent_chat_role = "operator".to_string();
            app.agent_chat_summaries.clear();
            app.su_session_inventory.clear();
            if app.session_setup.is_none() {
                tokio::spawn(agent_chat_load(
                    app.harness.clone(),
                    None,
                    app.chat_load_token,
                    tx.clone(),
                ));
            }
        }
        if app.context_projection_target != prior_context_target {
            if let Some(target) = app.context_projection_target.clone() {
                tokio::spawn(fetch_context_projection(target, tx.clone()));
            }
        }

        // Pinned dock pane (P-013 / D-011): never leave the pinned tab — re-pin
        // so a stray nav key can't switch to an unrendered tab (which on the
        // chat pane would also strand the composer: `i` composes on Operator).
        if let Some(p) = app.pinned {
            if app.tab != p {
                app.tab = p;
            }
        }
        app.keep_chat_first_surface();
        if let Ok(mut selected) = sync_pane.selected.lock() {
            *selected = app.tab;
        }
        if app.tab != prior_tab && app.tab == app::Tab::Overview {
            let _ = sync_refetch.send(RefetchSignal::SkipPlanReads);
        }
        // A saved Network view bypasses the normal tab-entry action.
        if restoring_view && app.tab == app::Tab::Network && app.pinned.is_none() {
            tokio::spawn(fetch_network_board(tx.clone()));
        }
        if restoring_view && app.tab == app::Tab::Sessions && app.pinned.is_none() {
            tokio::spawn(fetch_session_browser(
                app.harness.clone(),
                String::new(),
                tx.clone(),
            ));
        }
        // Per-bee wake-pane lifecycle (owner ask 2026-06-11): an Owner-scoped
        // wake-pane exits once its bee is gone AND its queue is drained — the
        // pane was opened close-on-exit, so it leaves the dock stack on its own.
        if app.wake_pane_should_exit() {
            break;
        }

        if voice_dropped {
            // Release the now-dead stream + mic so the next Connect re-establishes
            // a fresh socket. The reducer already flipped the Voice tab to
            // disconnected + surfaced the drop; clearing these run-loop handles is
            // what actually re-enables reconnection (Connect gates on is_none()).
            voice_chan = None;
            voice_mic = None;
            open_mic_started = false;
        }

        // Open-mic (P-010): once we're in a channel with input_mode=open-mic,
        // auto-start the mic (no PTT) with the VAD transmit-gate on. Fires once
        // per join (open_mic_started) so a manual MicOff isn't fought.
        if !open_mic_started && voice_mic.is_none() {
            let open_mic = app
                .voice_ui
                .prefs
                .as_ref()
                .map(|p| p.input_mode == "open-mic")
                .unwrap_or(false);
            let in_channel = app
                .voice_ui
                .status
                .as_ref()
                .map(|st| st.channel.is_some())
                .unwrap_or(false);
            if open_mic && in_channel {
                if let Some(vs) = &voice_chan {
                    match voice_stream::start_mic(vs.clone()) {
                        Ok(h) => {
                            vs.set_tx_gate(true);
                            voice_mic = Some(h);
                            open_mic_started = true;
                            let _ = tx.send(Event::VoiceUi(
                                crate::voice_ui::VoiceUiEvent::MicState(true),
                            ));
                        }
                        Err(e) => {
                            let _ = tx.send(Event::VoiceUi(crate::voice_ui::VoiceUiEvent::Error(
                                format!("open-mic: {e}"),
                            )));
                            open_mic_started = true; // don't retry-spam on failure
                        }
                    }
                }
            }
        }

        // Pump the live mic meter while recording: read the capture level on each
        // idle Tick and repaint so the meter animates (no per-frame event spam —
        // the level is an atomic the audio callback writes; plan D-007).
        if is_tick {
            if let Some(cap) = &voice_capture {
                app.set_voice_level(cap.level());
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            // P2P voice-channel mic meter (P-008): same atomic-on-Tick pump as
            // the PTT meter — no per-frame event spam.
            if voice_mic.is_some() {
                if let Some(vs) = &voice_chan {
                    app.voice_ui.mic_level = vs.mic_level();
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
            }
        }

        // Persist the quiet view-state on each nav change (the saver debounces).
        // Workbench dispatches count too: `:theme` flips state the snapshot
        // carries (P1 / D-002), and saving nav state on the other palette
        // commands is an idempotent no-op.
        if is_key && matches!(action, Action::Render | Action::Workbench(_)) {
            let _ = save_tx.send(app.capture_view_state());
        }

        // Best-effort OS notification on each new attention event (P8). Gated on
        // notify_enabled (muted by default, owner ask 2026-06-14) — the badge +
        // history surfaces still update via the reducer regardless.
        if app.notif_seq != last_notif_seq {
            last_notif_seq = app.notif_seq;
            if app.notify_enabled {
                if let Some(t) = app.toast.clone() {
                    notify::os_notify("Papercusp", &t.message);
                }
            }
        }

        // Record the first-run tutorial as seen the moment it's dismissed (P9).
        if !tutorial_persisted && !app.show_tutorial {
            tutorial_persisted = true;
            tutorial::mark_seen();
        }

        // A control intent can carry a tab-entry side effect. Process that
        // follow-up through the same dispatcher as key-driven actions instead
        // of dropping it after posting the intent result.
        let mut action_queue = vec![action];
        while let Some(action) = action_queue.pop() {
            match action {
                Action::Render => {
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                // P-007 transcript copy: emit the OSC 52 sequence the reducer
                // already built. Written straight to the tty and flushed rather
                // than through `terminal` — the sequence paints nothing, so it
                // must not go through the draw buffer (ratatui would diff it as
                // cell content), and it has to reach the emulator the human is
                // actually looking at, which is what OSC 52 is for. A failed
                // write is not fatal: the toast already told the user what was
                // copied, and killing the session over a clipboard byte would be
                // a far worse outcome than a copy that did not land.
                Action::CopyToClipboard { sequence } => {
                    use std::io::Write as _;
                    let mut out = stdout();
                    if out
                        .write_all(sequence.as_bytes())
                        .and_then(|()| out.flush())
                        .is_err()
                    {
                        app.toast = Some(models::Notif {
                            level: "error".to_string(),
                            message:
                                "Clipboard write failed — the terminal did not accept the copy"
                                    .to_string(),
                            harness: None,
                            ts: None,
                        });
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::PublishBeeSelection { owner_id, name } => {
                    // In-process selection drive (pui-dock-consolidation-2026-06-07):
                    // the dossier renders inside the Fleet tab now — apply the
                    // selection to app state and fetch the bee's dossier directly.
                    // (The old `fleet:selected_bee` relay POST is gone — the
                    // endpoint was retired with the bee tier, P-003 2026-08-24.)
                    let changed = app.bee.owner_id != owner_id;
                    app.update(Event::BeeSelection {
                        owner_id: owner_id.clone(),
                        name,
                    });
                    if changed {
                        if let Some(o) = owner_id {
                            tokio::spawn(bee_dossier_fetch(o, tx.clone()));
                        }
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FetchFleetAssignments => {
                    // Whole-fleet liveness + canonical work frontier are independent
                    // reads and land as separate events; either can still render if
                    // the other is temporarily unavailable.
                    tokio::spawn(fetch_fleet_assignments(tx.clone()));
                    let harness = app
                        .active_harness
                        .lock()
                        .map(|value| value.clone())
                        .unwrap_or_default();
                    tokio::spawn(fetch_work_frontier(harness.clone(), tx.clone()));
                    if let Some(fleet) = app.fleet.leader_fleet.clone() {
                        tokio::spawn(fetch_fleet_leader_brief(fleet, harness, tx.clone()));
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::RunFleetControl { intent } => {
                    let harness = app
                        .active_harness
                        .lock()
                        .map(|value| value.clone())
                        .unwrap_or_default();
                    tokio::spawn(run_fleet_control(intent, harness, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::SetWakeMode { agent, mode } => {
                    // P-008: set the agent's wake mode via coord:wake-mode (run_tool).
                    // Best-effort; the next roster poll refreshes the ⏸MANUAL badge.
                    tokio::spawn(set_wake_mode(agent, mode, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FetchWakeQueue { agent } => {
                    // P-009: list the agent's staged wakes for the review overlay.
                    tokio::spawn(fetch_wake_queue(agent, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::WakeQueueAct {
                    agent,
                    release,
                    id,
                    edited,
                } => {
                    // P-009: release (as-is or edited) / skip one staged wake, then
                    // re-list so the overlay refreshes.
                    tokio::spawn(wake_queue_act(agent, release, id, edited, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FetchWakeBoard => {
                    // EI-312: re-snapshot the staged-wake board (this pane's scope).
                    tokio::spawn(fetch_wake_board(app.wake_filter.clone(), tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::WakeBoardAct {
                    agent,
                    verb,
                    id,
                    edited,
                } => {
                    // EI-312: act on the board (release/skip one, or drain all),
                    // then re-snapshot so the pane refreshes.
                    tokio::spawn(wake_board_act(
                        agent,
                        verb,
                        id,
                        edited,
                        app.wake_filter.clone(),
                        tx.clone(),
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::CreateFrameTabs { tabs } => {
                    // P-013: one zellij tab per deployed frame, created via the
                    // companion's NewTab (new_tabs_with_layout). The reducer's diff
                    // is topology-gated, so tabs are only ever offered while a
                    // companion is linked; the None arm is a defensive no-op.
                    if let Some(c) = &companion {
                        for (name, layout) in tabs {
                            c.send(pui_companion_proto::Command::NewTab {
                                name: Some(name),
                                layout: Some(layout),
                            });
                        }
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::CreateHiveTabs { tabs } => {
                    // B4 (P-004): one persistent zellij tab per live federated peer,
                    // created via the companion's NewTab — same path + linked-companion
                    // gating as the per-frame tabs (the reducer's diff is roster-gated).
                    if let Some(c) = &companion {
                        for (name, layout) in tabs {
                            c.send(pui_companion_proto::Command::NewTab {
                                name: Some(name),
                                layout: Some(layout),
                            });
                        }
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FetchContextProjection => {
                    if let Some(target) = app.context_projection_target.clone() {
                        tokio::spawn(fetch_context_projection(target, tx.clone()));
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FetchSessionSwitcher { query } => {
                    // D-009: search the live + ended roster and indexed session
                    // corpus off the UI thread. The query rides the response so
                    // the reducer can reject a stale result after more typing.
                    tokio::spawn(fetch_session_switcher(query, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FetchSessionBrowser { harness, query } => {
                    tokio::spawn(fetch_session_browser(harness, query, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::ResolveSessionTranscript {
                    session_key,
                    target,
                } => {
                    tokio::spawn(resolve_session_transcript(session_key, target, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FetchSessionTranscript {
                    session_key,
                    reference,
                } => {
                    tokio::spawn(fetch_session_transcript(session_key, reference, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::RenameAgentChat {
                    session_key,
                    harness,
                    chat_id,
                    title,
                } => {
                    tokio::spawn(rename_browser_agent_chat(
                        session_key,
                        harness,
                        chat_id,
                        title,
                        tx.clone(),
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::ArchiveAgentChat {
                    session_key,
                    harness,
                    chat_id,
                } => {
                    tokio::spawn(archive_browser_agent_chat(
                        session_key,
                        harness,
                        chat_id,
                        tx.clone(),
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::ContinueAgentChat {
                    session_key,
                    harness,
                    source_chat_id,
                } => {
                    tokio::spawn(continue_browser_agent_chat(
                        session_key,
                        harness,
                        source_chat_id,
                        tx.clone(),
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FetchPlanItemStates { harness, plan } => {
                    // pui-plans-status-board P-008: the plans board's selection
                    // moved — fetch the selected plan's per-item states for the
                    // right-side work-items detail. → Event::PlanItemStates.
                    tokio::spawn(fetch_plan_item_states(harness, plan, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::PreviewFleetLaunch { fleet, args } => {
                    tokio::spawn(preview_fleet_launch(fleet, args, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::LaunchFleetOnPlan { fleet, args } => {
                    tokio::spawn(launch_fleet_on_plan(fleet, args, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FetchNetworkBoard => {
                    // B-09: the network-pane's manual `g` refresh — the refetch
                    // loop covers the push-driven cadence (SSE + 60s safety net).
                    // A pinned hive-pane also re-pulls its drill-in dossier
                    // (beacon history + ask log, P-014 item 2).
                    tokio::spawn(fetch_network_board(tx.clone()));
                    // Network ABSORBED the retired Hives shell (audit plan
                    // pui-tui-tab-audit-2026-08-27 D-005; D-003), so it owns
                    // that destination's other two read models as well: the
                    // federated roster (`Event::Hives` → `app.hives`, which
                    // network.rs renders via `present_in_hive`) and the
                    // browseable discovery directory (`Event::HiveDirectory`).
                    // These used to hang off `Action::FetchHives`, which the
                    // consolidation left with no emitter — so both streams were
                    // never fetched and their Network subviews rendered
                    // permanently empty. Fetching them here is what makes the
                    // absorbed capability actually functional (P-007).
                    tokio::spawn(fetch_hives(tx.clone()));
                    tokio::spawn(fetch_hive_directory(tx.clone()));
                    if let Some(key) = &app.network_focus {
                        tokio::spawn(hive_dossier_fetch(key.clone(), tx.clone()));
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::OpenNetworkDrillIn(req) => {
                    // B-10 SEAM: the per-hive drill-in open action (hive-network-
                    // surface B-09→B-10, coord 2026-06-11). Tier 1 is the local
                    // hive — its "drill-in" is the dock's `this hive` tab (always
                    // the FIRST tab, agreed with B-10). Tiers 2-4 open B-10's
                    // generated per-hive tab (hive-pane detail; tier 2 adds the
                    // hive-scoped wake board; the per-bee watch panes were dropped
                    // when hive-agent-tabs P-014 retired the watch-pane surface).
                    // The KDL goes through a materialized file + the zellij CLI
                    // because the companion is NEVER spawned in pinned panes
                    // (Companion::spawn gating above) — `Command::NewTab` over
                    // the companion can't fire from the pinned network-pane.
                    if req.tier <= 1 {
                        let _ = Zellij.run_action(&MuxAction::GoToTab(1));
                    } else {
                        let spec = layout::HiveTabSpec {
                            tier: req.tier,
                            key: req.key.clone(),
                            title: req.title.clone(),
                        };
                        match materialize_hive_tab(&spec) {
                            Ok(path) => {
                                let _ = Zellij.run_action(&MuxAction::NewTab {
                                    name: Some(layout::hive_tab_name(&spec)),
                                    layout: Some(path.to_string_lossy().into_owned()),
                                });
                            }
                            Err(e) => {
                                let _ = tx.send(Event::Error(format!("pot tab: {e}")));
                            }
                        }
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::JoinHive { slug, links } => {
                    // Join every member harness of a discovered hive (P-006): POST each
                    // link to /api/harness/join-link off the UI thread → Notify/Error.
                    tokio::spawn(join_hive(slug, links, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::DocsAction { action, doc_id } => {
                    // Fire the docs action (regenerate|verify) off the UI thread; the
                    // periodic refetch loop refreshes the badges on its next tick
                    // (harness-docs-integration P-009).
                    tokio::spawn(apply_docs_action(
                        app.harness.clone(),
                        action,
                        doc_id,
                        tx.clone(),
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::Launch(spec) => {
                    // Record the launch into the crew roster (P12b) before spawning.
                    app.record_launch(&spec);
                    // Prefer the companion plugin's real host command (reliable +
                    // observable — its CommandPaneExited feeds pane-exit detection);
                    // fall back to fire-and-forget `zellij action new-pane` when no
                    // companion is linked.
                    match &companion {
                        Some(c) => c.open_pane(&spec),
                        None => {
                            if let Err(e) = Zellij.open_pane(&spec) {
                                app.update(Event::Error(format!("launch: {e}")));
                            }
                        }
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::LaunchMany(specs) => {
                    // P-031: resume the crew's ended members the user confirmed in
                    // the crew-restore prompt. Each spec follows the exact `Launch`
                    // path (companion when linked, else the zellij CLI); the
                    // reducer already `record_launch`ed each spec — no re-record.
                    for spec in specs {
                        match &companion {
                            Some(c) => c.open_pane(&spec),
                            None => {
                                if let Err(e) = Zellij.open_pane(&spec) {
                                    app.update(Event::Error(format!("launch: {e}")));
                                }
                            }
                        }
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::LaunchPanes { sessions, bees } => {
                    // Reactive work-area panes for new LOCAL workbench launches
                    // (pui-reactive-session-panes D-006). EI-358 CLAIM-THEN-OPEN:
                    // mark-launched is the ATOMIC claim (`launched_at IS NULL` —
                    // stamped=true for exactly one caller across EVERY pui process),
                    // so we claim FIRST and open only on a won claim. The old order
                    // (open, then fire-and-forget mark) let every roster-watching
                    // pui process open its own pane for one click — the owner got
                    // five planner chats. A lost claim = another instance owns the
                    // launch (skip forever, stays tracked); a transport error is
                    // RETRYABLE (un-track via LaunchClaimRetry so a later roster
                    // tick re-attempts — the row is still pending server-side).
                    for p in sessions {
                        let claim = match OperatorClient::from_discovery().await {
                            Ok(c) => c.mark_session_launched(p.adv_session_id).await,
                            Err(e) => Err(e),
                        };
                        match claim {
                            Ok(true) => { /* won — open below */ }
                            Ok(false) => continue,
                            Err(_) => {
                                app.update(Event::LaunchClaimRetry(p.adv_session_id));
                                continue;
                            }
                        }
                        match &companion {
                            Some(c) => c.open_pane(&p.spec),
                            None => {
                                if let Err(e) = Zellij.open_pane(&p.spec) {
                                    app.update(Event::Error(format!("launch pane: {e}")));
                                }
                            }
                        }
                    }
                    // Dock agent stack (hive-agent-tabs P-004): live `claude
                    // --resume` panes for active fleet bees — CLI only (no
                    // companion in the dock, nothing to mark consumed).
                    let opened_bees = bees.len();
                    for spec in bees {
                        if let Err(e) = Zellij.open_pane(&spec) {
                            app.update(Event::Error(format!("cup pane: {e}")));
                        }
                    }
                    // Snap focus BACK to this pane (the operator chat) after a dock
                    // pane burst: zellij expands + focuses every new stacked pane as
                    // it opens, so a launch-time burst of bee panes flips the dock
                    // around for seconds and strands focus on the last bee (owner
                    // report 2026-06-07 "keeps refreshing like crazy ... before it
                    // settles"). One focus-restore per batch ends the flip on the
                    // chat. Workbench (companion) launches keep their own focus
                    // semantics — this is the dock-CLI path only.
                    if app.dock_agent_panes && opened_bees > 0 {
                        if let Some(id) = app.hud_pane_id {
                            if let Err(e) =
                                Zellij.run_action(&crate::mux::MuxAction::FocusPaneId(id))
                            {
                                app.update(Event::Error(format!("focus restore: {e}")));
                            }
                        }
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::IntentResult {
                    id,
                    result_json,
                    error,
                } => {
                    // An agent intent was applied (P12b) — ship the result back, redraw.
                    let _ = intent_result_tx.send((id, result_json, error));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::IntentResultWithFollowup {
                    id,
                    result_json,
                    error,
                    follow_up,
                } => {
                    let _ = intent_result_tx.send((id, result_json, error));
                    action_queue.push(*follow_up);
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::Workbench(cmd) => {
                    // Execute a palette workbench command (P12b) off the UI thread; it
                    // reports results back as toasts. SaveCrew needs the current crew
                    // roster, and RestoreCrew routes members by liveness against the
                    // ACTIVE agent roster (P-031) — both snapshotted here from App.
                    tokio::spawn(execute_workbench_command(
                        cmd,
                        app.launched.clone(),
                        app.roster.clone(),
                        tx.clone(),
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::Lifecycle { op, confirmed } => {
                    // Install lifecycle (P-011 / D-016) is local filesystem work
                    // that must succeed with no operator reachable, so it runs on
                    // a blocking thread instead of the operator-bound workbench task.
                    let tx = tx.clone();
                    let endpoint = client::selected_endpoint_label();
                    tokio::task::spawn_blocking(move || {
                        let ctx = self_install::LifecycleContext::current(endpoint);
                        let view = match self_install::Layout::from_env() {
                            Ok(layout) if confirmed => self_install::apply(&op, &layout, &ctx),
                            Ok(layout) => self_install::preview(&op, &layout, &ctx),
                            Err(error) => self_install::LifecycleView {
                                title: op.title().to_string(),
                                lines: vec![format!("{error:#}")],
                                armed: None,
                            },
                        };
                        let _ = tx.send(Event::Lifecycle(view));
                    });
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::RunInboxAction {
                    target,
                    action_id,
                    answer_text,
                } => {
                    tokio::spawn(execute_inbox_action(
                        target,
                        action_id,
                        answer_text,
                        tx.clone(),
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::SaveCrewSelection { name, members } => {
                    // P-030 hands one selected browser row to the existing crew
                    // executor; it does not mutate the launched-pane roster.
                    tokio::spawn(execute_workbench_command(
                        app::PaletteCommand::SaveCrew(name),
                        members,
                        app.roster.clone(),
                        tx.clone(),
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::Dock(cmd) => {
                    // Dockview dock-verbs (Brief 50 / D-008). Prefer the companion
                    // (id-addressed, reliable inside zellij); fall back to focused-
                    // pane / cycle `zellij action` CLI verbs when no companion is
                    // linked. The reducer already resolved ids/preset names + emitted
                    // a friendly error for the cases a fallback can't cover.
                    match cmd {
                        DockCmd::Stack { pane_ids } => match &companion {
                            // :stack is id-addressed → companion-only (the reducer
                            // already error-toasted when there was no topology).
                            Some(c) => c.stack_panes(pane_ids),
                            None => {
                                app.update(Event::Error(
                                    "stack: needs the companion plugin (run inside the workbench)"
                                        .into(),
                                ));
                            }
                        },
                        DockCmd::Float { pane_id } => match (&companion, pane_id) {
                            (Some(c), Some(id)) => c.toggle_float(id),
                            // Bare :float with a known HUD id → float that pane.
                            (Some(c), None) if app.hud_pane_id.is_some() => {
                                c.toggle_float(app.hud_pane_id.unwrap())
                            }
                            // Bare :float without a HUD id, or no companion: the
                            // focused pane in the palette IS the HUD, so the CLI
                            // focused-pane toggle floats it (D-002).
                            _ => {
                                if let Err(e) = Zellij.run_action(&MuxAction::ToggleFloat) {
                                    app.update(Event::Error(format!("float: {e}")));
                                }
                            }
                        },
                        DockCmd::SelectLayout { name } => match &companion {
                            Some(c) => c.select_swap_layout(name),
                            // No companion → no select-by-name primitive; :dock needs
                            // it. Tell the user (cycling can't reliably hit a target).
                            None => {
                                app.update(Event::Error(format!(
                                "dock/layout {name}: needs the companion plugin (use :layout next/prev without it)"
                            )));
                            }
                        },
                        DockCmd::CycleLayout { next } => match &companion {
                            Some(c) => {
                                if next {
                                    c.next_swap_layout()
                                } else {
                                    c.prev_swap_layout()
                                }
                            }
                            None => {
                                let act = if next {
                                    MuxAction::NextSwapLayout
                                } else {
                                    MuxAction::PrevSwapLayout
                                };
                                if let Err(e) = Zellij.run_action(&act) {
                                    app.update(Event::Error(format!("layout: {e}")));
                                }
                            }
                        },
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::CheckSessionSetup => {
                    tokio::spawn(session_setup_fetch(tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::ReconnectSessionSetup(reconnect) => {
                    // Replace the process as a unit; detached readers and SSE
                    // tasks cannot keep publishing from the previous operator.
                    if let Err(error) = reconnect_setup_process(&reconnect, kbd_enhanced) {
                        if let Some(setup) = app.session_setup.as_mut() {
                            setup.note = Some(format!(
                                "Could not reconnect: {error}. Your draft is retained."
                            ));
                        }
                        terminal.clear()?;
                        terminal.draw(|f| ui::draw(f, &app))?;
                    }
                }
                Action::ConnectSessionSetup { sign_in } => {
                    // Like reconnect: a fresh process replaces this one, so no
                    // reader of this TUI competes with psu for the terminal.
                    let draft = app
                        .session_setup
                        .as_ref()
                        .map(|setup| setup.message.clone())
                        .unwrap_or_default();
                    if let Err(error) = connect_setup_process(sign_in, &draft, kbd_enhanced) {
                        if let Some(setup) = app.session_setup.as_mut() {
                            setup.note = Some(format!(
                                "Could not start psu: {error:#}. Your draft is retained."
                            ));
                        }
                        terminal.clear()?;
                        terminal.draw(|f| ui::draw(f, &app))?;
                    }
                }
                Action::RegisterSetupProject { slug, path } => {
                    tokio::spawn(register_setup_project(slug, path, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::OpenSuSession {
                    harness,
                    role,
                    backend,
                    carry,
                    launch,
                    initial_turn,
                } => {
                    let pending = initial_turn
                        .and_then(|text| app.su_pending_turn.clone().filter(|p| p.content == text));
                    let existing_chat = pending.as_ref().and(app.agent_chat_id.clone());
                    let session_tx = SuSessionEventSender {
                        tx: tx.clone(),
                        harness: harness.clone(),
                        load_token: app.next_agent_chat_load_token(),
                    };
                    tokio::spawn(open_su_session_task(
                        harness,
                        role,
                        backend,
                        carry,
                        launch,
                        (pending, existing_chat),
                        session_tx,
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::OpenContinuedSuSession {
                    harness,
                    chat_id,
                    role,
                    backend,
                    launch,
                } => {
                    let session_tx = SuSessionEventSender {
                        tx: tx.clone(),
                        harness: harness.clone(),
                        load_token: app.next_agent_chat_load_token(),
                    };
                    tokio::spawn(open_su_session_task(
                        harness,
                        role,
                        backend,
                        "warm".into(),
                        launch,
                        (None, Some(chat_id)),
                        session_tx,
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::SendSuSessionTurn(_) => {
                    if let Some(state) = app.su_session.as_ref() {
                        if let (Some(chat_id), Some(pending)) =
                            (app.agent_chat_id.clone(), app.su_pending_turn.clone())
                        {
                            tokio::spawn(send_su_session_turn_task(
                                app.harness.clone(),
                                chat_id,
                                state.binding.clone(),
                                pending,
                                SuSessionEventSender {
                                    tx: tx.clone(),
                                    harness: app.harness.clone(),
                                    load_token: app.chat_load_token,
                                },
                            ));
                        } else {
                            app.update(Event::SuSessionError(
                                "SU-session has no agent-chat identity; reattach before sending"
                                    .into(),
                            ));
                        }
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::SendSuSessionCommand {
                    harness,
                    chat_id,
                    command,
                } => {
                    let session_tx = SuSessionEventSender {
                        tx: tx.clone(),
                        harness: harness.clone(),
                        load_token: app.chat_load_token,
                    };
                    tokio::spawn(send_su_session_command_task(
                        harness, chat_id, command, session_tx,
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::AttachSuSession {
                    harness,
                    chat_id,
                    adv_session_id,
                    backend,
                } => {
                    let session_tx = SuSessionEventSender {
                        tx: tx.clone(),
                        harness: harness.clone(),
                        load_token: app.next_agent_chat_load_token(),
                    };
                    tokio::spawn(attach_su_session_task(
                        harness,
                        chat_id,
                        adv_session_id,
                        backend,
                        session_tx,
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::LoadAgentChat {
                    harness,
                    chat_id,
                    load_token,
                } => {
                    tokio::spawn(agent_chat_load(
                        harness,
                        Some(chat_id),
                        load_token,
                        tx.clone(),
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::CancelChat => {
                    app.update(Event::ChatError(
                        "chat cancellation is unavailable without an attached SU session".into(),
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::ResolveAgentChatApproval { call_id, approved } => {
                    // Answer a parked HITL request (P-005 slice 2). Guarded rather
                    // than unwrapped: the prompt cannot render without a bound chat,
                    // but a decision arriving in that state should be a no-op, not a
                    // panic that takes the whole TUI down.
                    if let Some(chat_id) = app.agent_chat_id.clone() {
                        tokio::spawn(resolve_agent_chat_approval_send(
                            app.harness.clone(),
                            chat_id,
                            call_id,
                            approved,
                            tx.clone(),
                        ));
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::MutateAgentChatTask {
                    harness,
                    chat_id,
                    mutation,
                } => {
                    tokio::spawn(mutate_agent_chat_task_send(
                        harness,
                        chat_id,
                        mutation,
                        tx.clone(),
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::CardRespond {
                    conversation_id,
                    correlation_id,
                    workspace_id,
                    action,
                    payload,
                } => {
                    // Inline card answer (sentinel-tui-shared-backend-and-cards Phase
                    // 2a): POST /card-response so the server resolves the brain's
                    // blocked tool call. The server's close event removes the card;
                    // a failed POST leaves the same response available to retry.
                    // Prefer the card's OWN workspace (wire snapshot) over the
                    // loop-resolved one for the defense-in-depth gate.
                    let ws = workspace_id.or_else(|| app.card_workspace.clone());
                    tokio::spawn(card_respond_send(
                        conversation_id,
                        correlation_id,
                        ws,
                        action,
                        payload,
                        tx.clone(),
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::SetMaxAgents(n) => {
                    // Overview top-bar cap edit (Brief 23 P-005): PUT the new
                    // `maxSimultaneousAgents` then refetch the read-model so the
                    // optimistic local value reconciles with truth.
                    tokio::spawn(set_max_agents(n, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::VoiceSessionStart => {
                    // Realtime operator voice (voice-realtime-tui P-007): replace
                    // any prior (possibly already-ended) session outright.
                    if let Some(h) = convai_session.take() {
                        h.stop();
                    }
                    convai_session = Some(voice_convai::start_session(
                        workbench::workbench_owner(),
                        voice_player.clone(),
                        tx.clone(),
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::VoiceSessionStop => {
                    if let Some(h) = convai_session.take() {
                        h.stop();
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::VoiceSessionControl(control) => {
                    if let Some(h) = convai_session.as_ref() {
                        h.control(control);
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::VoiceChan(cmd) => {
                    use crate::voice_ui::{VoiceCmd as VC, VoiceUiEvent as VE};
                    match cmd {
                        VC::Connect => {
                            if voice_chan.is_none() {
                                match voice_stream::VoiceStream::connect() {
                                    Ok((vs, ev_rx, mix_rx)) => {
                                        let vs = std::sync::Arc::new(vs);
                                        voice_chan = Some(vs.clone());
                                        // Forward socket events (status/error/disconnect)
                                        // onto the run-loop event channel.
                                        let tx2 = tx.clone();
                                        std::thread::spawn(move || {
                                            while let Ok(ev) = ev_rx.recv() {
                                                if tx2.send(Event::VoiceUi(VE::Stream(ev))).is_err()
                                                {
                                                    break;
                                                }
                                            }
                                        });
                                        // Mixed peer audio → local playback.
                                        if let Err(e) = voice_stream::start_playback(mix_rx) {
                                            let _ = tx.send(Event::VoiceUi(VE::Error(format!(
                                                "voice playback: {e}"
                                            ))));
                                        }
                                        let _ = vs.request_status();
                                        let _ = tx.send(Event::VoiceUi(VE::Connected(true)));
                                    }
                                    Err(e) => {
                                        let _ = tx.send(Event::VoiceUi(VE::Error(e.to_string())));
                                    }
                                }
                            } else if let Some(vs) = &voice_chan {
                                let _ = vs.request_status();
                            }
                            // (Re)fetch the channel registry + voice prefs over HTTP
                            // (prefs drive the open-mic auto-start; P-010).
                            tokio::spawn(voice_channels_fetch(tx.clone()));
                            tokio::spawn(voice_prefs_get(tx.clone()));
                            terminal.draw(|f| ui::draw(f, &app))?;
                        }
                        VC::Join(id) => {
                            if let Some(vs) = &voice_chan {
                                let _ = vs.join(&id);
                            }
                        }
                        VC::Leave => {
                            if let Some(vs) = &voice_chan {
                                let _ = vs.leave();
                            }
                            voice_mic = None;
                            open_mic_started = false; // re-arm open-mic for the next join
                            let _ = tx.send(Event::VoiceUi(VE::MicState(false)));
                        }
                        VC::SetMuted(m) => {
                            if let Some(vs) = &voice_chan {
                                let _ = vs.set_muted(m);
                            }
                        }
                        VC::MicOn => {
                            if let Some(vs) = &voice_chan {
                                match voice_stream::start_mic(vs.clone()) {
                                    Ok(h) => {
                                        // PTT → gate off (the held key IS the gate);
                                        // open-mic manual restart → VAD gate on (P-010).
                                        let open_mic = app
                                            .voice_ui
                                            .prefs
                                            .as_ref()
                                            .map(|p| p.input_mode == "open-mic")
                                            .unwrap_or(false);
                                        vs.set_tx_gate(open_mic);
                                        voice_mic = Some(h);
                                        let _ = tx.send(Event::VoiceUi(VE::MicState(true)));
                                    }
                                    Err(e) => {
                                        let _ =
                                            tx.send(Event::VoiceUi(VE::Error(format!("mic: {e}"))));
                                    }
                                }
                            }
                        }

                        VC::MicOff => {
                            voice_mic = None;
                            // User explicitly stopped — don't let open-mic auto-start
                            // immediately re-arm it (P-010 restart-fight guard).
                            open_mic_started = true;
                            let _ = tx.send(Event::VoiceUi(VE::MicState(false)));
                        }
                        VC::Create(name) => {
                            tokio::spawn(voice_channel_create(name, tx.clone()));
                        }
                        VC::PrefsGet => {
                            tokio::spawn(voice_prefs_get(tx.clone()));
                        }
                        VC::PrefsSet(key, value) => {
                            tokio::spawn(voice_prefs_set(key.to_string(), value, tx.clone()));
                        }
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FocusPane { intent_id, pane_id } => {
                    // Operator pane-driving affordance (P2): drive the companion to
                    // focus the pane, then POST the intent result back.
                    let (result_json, error) = match &companion {
                    Some(c) => {
                        c.focus_pane(pane_id);
                        (format!("{{\"ok\":true,\"pane_id\":{pane_id}}}"), None)
                    }
                    None => (
                        "null".to_string(),
                        Some(
                            "focus_pane: no companion link (pui is not inside a zellij workbench)"
                                .to_string(),
                        ),
                    ),
                };
                    let _ = intent_result_tx.send((intent_id, result_json, error));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FocusLocalPane { pane_id } => {
                    // Enter-by-location LOCAL route (pui-workbench-usability D-001):
                    // bring the selected agent's workbench pane to front. Companion-
                    // only (id-addressed); without a link, tell the user.
                    match &companion {
                        Some(c) => c.focus_pane(pane_id),
                        None => {
                            app.update(Event::Error(
                                "focus: needs the companion plugin (run inside the workbench)"
                                    .into(),
                            ));
                        }
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FocusWindow {
                    adv_session_id,
                    pid,
                    window_id,
                    label,
                } => {
                    // Enter-by-location EXTERNAL-WINDOW route (D-001): wmctrl the
                    // agent's terminal window to the front off the UI thread; the
                    // outcome returns as a toast (Event::Notify/Error).
                    tokio::spawn(focus_session_window(
                        adv_session_id,
                        pid,
                        window_id,
                        label,
                        tx.clone(),
                    ));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::LoadEarlierChat => {
                    // Load-earlier history (scroll-back). The reducer set the in-flight
                    // flag; spawn the fetch with a snapshot of the conversation id +
                    // oldest cursor. A missing cursor/conversation just clears the flag.
                    match (app.conversation_id.clone(), app.chat_oldest_seq) {
                        (Some(conv_id), Some(before_seq)) => {
                            tokio::spawn(load_earlier_chat(conv_id, before_seq, tx.clone()));
                        }
                        _ => {
                            let _ = tx.send(Event::ChatEarlier {
                                messages: Vec::new(),
                                has_more_earlier: false,
                                oldest_seq: None,
                            });
                        }
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FetchTestingFiles { harness, domain_id } => {
                    // Testing run-on-click (D-004a): resolve the selected domain's
                    // runnable files off the UI thread.
                    tokio::spawn(fetch_testing_files(harness, domain_id, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::RunTest { harness, file } => {
                    // Start the detached run and poll its rolling snapshot off the
                    // UI thread. This keeps the pane responsive and gives Esc a
                    // stable run id to cancel.
                    tokio::spawn(run_test_file(harness, file, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::CancelTest {
                    harness,
                    run_id,
                    file,
                } => {
                    // Cancellation is a request only; the existing status poller
                    // remains the authority for the terminal `cancelled` state.
                    tokio::spawn(cancel_test_run(harness, run_id, file, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::SearchMemory { query, harness } => {
                    // Memory semantic search (D-006 Step 2) off the UI thread.
                    tokio::spawn(search_memory(query, harness, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::ConfigEdit {
                    harness,
                    key,
                    value,
                } => {
                    // Config-tab edit (D-013): read→edit→PUT→refetch off the UI
                    // thread; the refreshed effective view returns as Event::Config.
                    tokio::spawn(config_edit(harness, key, value, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::LoadPluginConfig { harness, plugin } => {
                    // Plugin-settings load (D-014): fetch the selected plugin's saved
                    // per-harness config; returns as Event::PluginConfig.
                    tokio::spawn(load_plugin_config(harness, plugin, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::PluginConfigEdit {
                    harness,
                    plugin,
                    key,
                    value,
                } => {
                    // Plugin-settings edit (D-014): read→edit-path→PUT→refetch off
                    // the UI thread; the refreshed config returns as Event::PluginConfig.
                    tokio::spawn(plugin_config_edit(harness, plugin, key, value, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FetchCupboard {
                    kind,
                    query,
                    cursor,
                    append,
                } => {
                    // Cupboard browse (D-011): GET the listings for the active
                    // (kind, query) filter off the UI thread.
                    tokio::spawn(fetch_cupboard(kind, query, cursor, append, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::CupboardAct { listing } => {
                    // A confirmed per-kind Cupboard action (D-011): join / fork /
                    // install. Outcomes ride Notify/Error events.
                    tokio::spawn(cupboard_act(listing, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FetchConversations { state, kind } => {
                    // Conversations browse (Brief 25): GET the list for the active
                    // state/kind filter off the UI thread → Event::Conversations.
                    tokio::spawn(fetch_conversations(state, kind, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::FetchConversationDetail { id } => {
                    // Load the selected conversation's full thread → ConversationDetail.
                    tokio::spawn(fetch_conversation_detail(id, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::PromoteConversation { id } => {
                    // Promote a conversation → engineer issue (carries the thread);
                    // outcome rides Notify/Error + a list/detail refetch.
                    tokio::spawn(promote_conversation(id, tx.clone()));
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::Voice(cmd) => {
                    // Push-to-talk lifecycle (voice-mode-tui-port-2026-06-05 P2).
                    // The run loop owns the mic CaptureSession; the turn pipeline
                    // (transcribe → converse → speak) runs in a spawned task and
                    // feeds Event::Voice / Chat* events back.
                    use app::VoiceCmd;
                    match cmd {
                        VoiceCmd::Start => match voice::start_capture() {
                            Ok(session) => {
                                voice_capture = Some(session);
                                let _ = tx.send(Event::Voice(event::VoiceMsg::Started(Ok(()))));
                            }
                            Err(e) => {
                                let _ = tx.send(Event::Voice(event::VoiceMsg::Started(Err(
                                    e.to_string()
                                ))));
                            }
                        },
                        VoiceCmd::Cancel => {
                            if let Some(session) = voice_capture.take() {
                                tokio::task::spawn_blocking(move || session.cancel());
                            }
                            let _ = tx.send(Event::Voice(event::VoiceMsg::Finished));
                        }
                        VoiceCmd::Stop => {
                            if let Some(session) = voice_capture.take() {
                                // Reflect the transcribing phase immediately, then run
                                // the turn with a snapshot of the converse context
                                // (the pipeline appends the transcribed text itself).
                                app.voice_phase = app::VoicePhase::Transcribing;
                                tokio::spawn(voice_turn(
                                    session,
                                    app.conversation_id.clone(),
                                    app.chat_history_for_send(),
                                    workbench::workbench_owner(),
                                    voice_player.clone(),
                                    tx.clone(),
                                ));
                            } else {
                                let _ = tx.send(Event::Voice(event::VoiceMsg::Finished));
                            }
                        }
                    }
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
                Action::Quit => break 'event_loop,
                Action::None => {}
            }
        }
    }
    record_su_session_exit(&app);
    // pui-chat-first-ux P-004 "clean scrollback": hand the chat-first transcript
    // to `main`, which prints it once the alternate screen is gone.
    if app.chat_first {
        if let Some(text) = crate::chat_copy::plain_transcript(&app.chat_messages) {
            let _ = EXIT_TRANSCRIPT.set(text);
        }
    }
    Ok(())
}

/// Fetch the selected testing domain's runnable files (D-004a) and emit
/// `Event::TestingFiles` (stale-guarded in the reducer by domain id). On error
/// an empty file list still ships so the loading state resolves; the error
/// itself lands in the status bar.
async fn backend_identity_fetch(tx: UnboundedSender<Event>) {
    let result = selected_backend_identity()
        .await
        .map(|(_, identity)| identity)
        .map_err(|error| operator_failure_status_line(&client::selected_endpoint_label(), &error));
    let _ = tx.send(Event::BackendIdentity(result));
}

async fn session_setup_fetch(tx: UnboundedSender<Event>) {
    let client = match selected_backend_identity().await {
        Ok((client, identity)) => {
            let _ = tx.send(Event::BackendIdentity(Ok(identity)));
            client
        }
        Err(error) => {
            let _ = tx.send(Event::BackendIdentity(Err(operator_failure_status_line(
                &client::selected_endpoint_label(),
                &error,
            ))));
            return;
        }
    };
    // Setup reads do not queue behind unrelated pane/plan/status reads.
    tokio::join!(
        async {
            match client.harnesses().await {
                Ok(projects) => {
                    let _ = tx.send(Event::Harnesses(projects));
                }
                Err(error) => {
                    let _ = tx.send(Event::Error(format!("Setup projects: {error}")));
                }
            }
        },
        async {
            match client.operator_config().await {
                Ok(config) => {
                    let _ = tx.send(Event::OperatorConfig(config));
                }
                Err(error) => {
                    let _ = tx.send(Event::Error(format!("Setup runtime: {error}")));
                }
            }
        },
        async {
            match client.accounts_status().await {
                Ok(status) => {
                    let _ = tx.send(Event::AccountRows(status.accounts));
                    let _ = tx.send(Event::AccountPoolVerdicts(status.pool_verdict));
                }
                Err(error) => {
                    let _ = tx.send(Event::Error(format!("Setup accounts: {error}")));
                }
            }
        },
    );
}

async fn register_setup_project(slug: String, path: String, tx: UnboundedSender<Event>) {
    let result = tokio::time::timeout(Duration::from_secs(45), async {
        let client = OperatorClient::from_discovery().await?;
        let response = client.create_harness(&slug, &path).await?;
        if let Some(error) = response.error { anyhow::bail!("{error}"); }
        if !response.ok { anyhow::bail!("Operator did not confirm registration. Refresh projects before retrying."); }
        if let Some(provisioning) = response.provisioning {
            if !provisioning.ok {
                anyhow::bail!("Project was registered but its data store is not ready: {}. Repair it on the operator, then refresh projects.",
                    provisioning.error.as_deref().unwrap_or("provisioning failed"));
            }
        } else {
            anyhow::bail!("Project was registered, but this operator did not report data-store readiness. Refresh projects and check its status before starting.");
        }
        client.harnesses().await
    }).await.map_err(|_| "Registration has not been confirmed. Esc returns to Context; r refreshes projects before retrying.".to_string())
        .and_then(|result| result.map_err(|error| format!("Project registration: {error}")));
    let _ = tx.send(Event::SetupProjectCreated { slug, result });
}

fn setup_reconnect_command(
    executable: &std::path::Path,
    reconnect: &session_config::SetupReconnect,
) -> std::process::Command {
    let mut command = std::process::Command::new(executable);
    command
        .arg("hud")
        .env("PUI_OPERATOR", &reconnect.endpoint)
        .env("PAPERCUSP_OPERATOR_URL", &reconnect.endpoint)
        .env(session_config::SETUP_DRAFT_ENV, &reconnect.message);
    // An explicit env bearer belongs to the old origin. Never carry it to a
    // different one, including when the new endpoint is another local port.
    if !reconnect.token.0.is_empty() {
        command.env(http::OPERATOR_TOKEN_ENV, &reconnect.token.0);
    } else if !reconnect.keep_existing_token {
        command.env_remove(http::OPERATOR_TOKEN_ENV);
    }
    command
}

fn reconnect_setup_process(
    reconnect: &session_config::SetupReconnect,
    enhanced: bool,
) -> Result<()> {
    use std::os::unix::process::CommandExt;
    let executable = std::env::current_exe()?;
    let mut command = setup_reconnect_command(&executable, reconnect);
    exec_restoring_terminal(enhanced, || command.exec().into())
}

/// Setup's `l` / `h`: hand the terminal to the bundled psu (D-031), which signs
/// in when asked and runs PUI on the chosen remote host. PUI re-execs itself as
/// the psu supervisor so a cancelled or failed sign-in returns here (P-021).
fn connect_setup_process(sign_in: bool, draft: &str, enhanced: bool) -> Result<()> {
    use std::os::unix::process::CommandExt;
    let mut command = setup_connect_command(&std::env::current_exe()?, sign_in, draft);
    exec_restoring_terminal(enhanced, || command.exec().into())
}

fn setup_connect_command(
    executable: &std::path::Path,
    sign_in: bool,
    draft: &str,
) -> std::process::Command {
    let mut command = std::process::Command::new(executable);
    command
        .args(remote_connect::setup_connect_supervisor_args(sign_in))
        .env(session_config::SETUP_DRAFT_ENV, draft)
        .env_remove(session_config::SETUP_NOTE_ENV);
    command
}

/// Leave the TUI's terminal modes, run `exec` (which only returns on failure),
/// then restore this same UI so the caller can show the error beside the
/// retained draft.
fn exec_restoring_terminal(enhanced: bool, exec: impl FnOnce() -> anyhow::Error) -> Result<()> {
    // Restore termios before exec: crossterm's saved original state is in
    // process memory, and would otherwise be lost across replacement.
    let mut out = stdout();
    if enhanced {
        let _ = execute!(out, crossterm::event::PopKeyboardEnhancementFlags);
    }
    disable_raw_mode()?;
    let _ = execute!(
        out,
        crossterm::event::DisableFocusChange,
        crossterm::event::DisableBracketedPaste,
        LeaveAlternateScreen
    );
    let error = exec();
    // exec only returns on failure. Restore this same UI and retained draft.
    enable_raw_mode()?;
    execute!(
        out,
        EnterAlternateScreen,
        crossterm::event::EnableBracketedPaste,
        crossterm::event::EnableFocusChange
    )?;
    if enhanced {
        let _ = execute!(
            out,
            crossterm::event::PushKeyboardEnhancementFlags(
                crossterm::event::KeyboardEnhancementFlags::REPORT_EVENT_TYPES
                    | crossterm::event::KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
            )
        );
    }
    Err(error)
}

#[cfg(test)]
mod setup_reconnect_tests {
    use super::*;

    #[test]
    fn session_setup_reconnect_scopes_token_and_keeps_draft_out_of_argv() {
        let mut request = session_config::SetupReconnect {
            endpoint: "https://other.example".into(),
            message: "private draft λ".into(),
            token: Default::default(),
            keep_existing_token: false,
        };
        let command = setup_reconnect_command(std::path::Path::new("/test/pui"), &request);
        assert_eq!(command.get_args().collect::<Vec<_>>(), vec!["hud"]);
        let env = command
            .get_envs()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(env[std::ffi::OsStr::new(http::OPERATOR_TOKEN_ENV)], None);
        assert_eq!(
            env[std::ffi::OsStr::new(session_config::SETUP_DRAFT_ENV)].unwrap(),
            "private draft λ"
        );
        request.token.0 = "new-operator-token".into();
        let command = setup_reconnect_command(std::path::Path::new("/test/pui"), &request);
        let env = command
            .get_envs()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            env[std::ffi::OsStr::new(http::OPERATOR_TOKEN_ENV)].unwrap(),
            "new-operator-token"
        );
        assert!(!format!("{request:?}").contains("new-operator-token"));
    }
}

async fn fetch_testing_files(harness: String, domain_id: String, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("testing files: {e}")));
            let _ = tx.send(Event::TestingFiles {
                domain_id,
                files: Vec::new(),
            });
            return;
        }
    };
    match client.testing_domain_files(&harness, &domain_id).await {
        Ok(files) => {
            let _ = tx.send(Event::TestingFiles { domain_id, files });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("testing files: {e}")));
            let _ = tx.send(Event::TestingFiles {
                domain_id,
                files: Vec::new(),
            });
        }
    }
}

/// Fire a pui docs action (regenerate|verify) for the selected doc
/// (harness-docs-integration P-009). Success is silent — the periodic refetch loop
/// refreshes the source/freshness badges within a tick; failures surface as a
/// status-bar toast so the keypress never silently no-ops.
async fn apply_docs_action(
    harness: String,
    action: String,
    doc_id: String,
    tx: UnboundedSender<Event>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("docs {action}: {e}")));
            return;
        }
    };
    if let Err(e) = client.docs_action(&harness, &action, &doc_id).await {
        let _ = tx.send(Event::Error(format!("docs {action}: {e}")));
    }
}

/// Semantic memory search (D-006 Step 2): call `memory:search` and emit
/// `Event::MemoryHits` for the query (the reducer drops hits for a query that
/// is no longer active). Errors resolve to an empty hit list + a status-bar
/// error so the search never hangs.
async fn search_memory(query: String, harness: String, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("memory search: {e}")));
            let _ = tx.send(Event::MemoryHits {
                query,
                results: Vec::new(),
            });
            return;
        }
    };
    match client.memory_search(&query, Some(&harness), 20).await {
        Ok(payload) => {
            let _ = tx.send(Event::MemoryHits {
                query,
                results: payload.results,
            });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("memory search: {e}")));
            let _ = tx.send(Event::MemoryHits {
                query,
                results: Vec::new(),
            });
        }
    }
}

/// Overview top-bar cap edit (Brief 23 P-005): PUT the new
/// `maxSimultaneousAgents`, then refetch the fleet-rate read-model so the
/// reducer's optimistic value reconciles with what the backend persisted. A
/// failed PUT surfaces in the status bar; the refetch (or the next poll)
/// restores truth either way.
async fn set_max_agents(n: u32, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("max agents: {e}")));
            return;
        }
    };
    if let Err(e) = client.set_max_agents(n).await {
        let _ = tx.send(Event::Error(format!("max agents: {e}")));
    }
    if let Ok(s) = client.fleet_rate_status().await {
        let _ = tx.send(Event::FleetRate(s));
    }
    let _ = tx.send(Event::PipelineStatus(Box::new(
        client.pipeline_status().await,
    )));
}

// (mark_session_launched moved inline into the LaunchPanes arm — EI-358
// claim-then-open: the claim verdict now GATES the pane open, so it can no
// longer be a fire-and-forget task.)

/// Bring the selected agent's terminal window to the front via
/// `/api/adv/sessions/focus` (wmctrl). Best-effort — a resolved window toasts
/// success; an unresolvable one (no wmctrl/DISPLAY/window, or a remote host)
/// toasts a friendly "couldn't bring … to front" rather than failing silently.
async fn focus_session_window(
    adv_session_id: Option<i64>,
    pid: Option<i64>,
    window_id: Option<String>,
    label: String,
    tx: UnboundedSender<Event>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("focus window: {e}")));
            return;
        }
    };
    match client.focus_session(adv_session_id, pid, window_id).await {
        Ok(true) => {
            let _ = tx.send(Event::Notify(models::Notif {
                level: "info".to_string(),
                message: format!("focused {label}"),
                harness: None,
                ts: None,
            }));
        }
        Ok(false) => {
            let _ = tx.send(Event::Error(format!(
                "couldn't bring {label} to front (no window — try resume/launch)"
            )));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("focus window: {e}")));
        }
    }
}

// ─── P2P voice channels (holepunch-voice-channels P-008) ───
// HTTP-side helpers: the channel REGISTRY + voice-prefs ride agent-tools (not
// realtime); join/leave/mute + audio ride the voice socket in the run loop.

async fn voice_channels_fetch(tx: UnboundedSender<Event>) {
    use crate::voice_ui::VoiceUiEvent as VE;
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("voice channels: {e}"))));
            return;
        }
    };
    match client.voice_channels_list().await {
        Ok(list) => {
            let _ = tx.send(Event::VoiceUi(VE::Channels(list)));
        }
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("voice channels: {e}"))));
        }
    }
}

async fn voice_channel_create(name: String, tx: UnboundedSender<Event>) {
    use crate::voice_ui::VoiceUiEvent as VE;
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("create channel: {e}"))));
            return;
        }
    };
    match client.voice_channel_create(&name).await {
        Ok(list) => {
            let _ = tx.send(Event::VoiceUi(VE::Channels(list)));
        }
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("create channel: {e}"))));
        }
    }
}

async fn voice_prefs_get(tx: UnboundedSender<Event>) {
    use crate::voice_ui::VoiceUiEvent as VE;
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("voice prefs: {e}"))));
            return;
        }
    };
    match client.voice_prefs_get().await {
        Ok(p) => {
            let _ = tx.send(Event::VoiceUi(VE::Prefs(p)));
        }
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("voice prefs: {e}"))));
        }
    }
}

async fn voice_prefs_set(key: String, value: serde_json::Value, tx: UnboundedSender<Event>) {
    use crate::voice_ui::VoiceUiEvent as VE;
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("voice prefs: {e}"))));
            return;
        }
    };
    match client.voice_prefs_set(&key, value).await {
        Ok(p) => {
            let _ = tx.send(Event::VoiceUi(VE::Prefs(p)));
        }
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("voice prefs: {e}"))));
        }
    }
}

/// Apply one `:set`/`:unset` Config-tab edit (D-013): fetch the current file
/// body, edit the dotted path (`value: Some` sets, `None` removes), PUT the
/// result back, then refetch the effective view so the tab re-renders from
/// what the backend actually persisted. Every failure lands in the status bar
/// and the view is refetched anyway (so the tab never shows a phantom edit).
async fn config_edit(
    harness: String,
    key: String,
    value: Option<String>,
    tx: UnboundedSender<Event>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("config edit: {e}")));
            return;
        }
    };
    let apply = async {
        let current = client.claude_settings_effective(&harness).await?;
        let mut root: serde_json::Value = if current.content.trim().is_empty() {
            serde_json::json!({})
        } else {
            // An invalid file is never silently clobbered — surface the parse
            // error and make the user fix or `:set` after clearing manually.
            serde_json::from_str(&current.content).map_err(|e| {
                anyhow::anyhow!("settings file is invalid JSON ({e}) — fix it before :set")
            })?
        };
        app::edit_json_path(
            &mut root,
            &key,
            value.as_deref().map(app::parse_config_value),
        )
        .map_err(|e| anyhow::anyhow!(e))?;
        // An object emptied by :unset deletes the file (backend delete path).
        let body = if root.as_object().map(|o| o.is_empty()).unwrap_or(false) {
            String::new()
        } else {
            serde_json::to_string_pretty(&root)?
        };
        client.put_claude_settings(&harness, &body).await?;
        anyhow::Ok(())
    };
    if let Err(e) = apply.await {
        let _ = tx.send(Event::Error(format!("config edit: {e}")));
    }
    // Always refetch — success re-renders the new truth; failure restores it.
    match client.claude_settings_effective(&harness).await {
        Ok(v) => {
            let _ = tx.send(Event::Config { harness, config: v });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("config refetch: {e}")));
        }
    }
}

/// Load one plugin's saved per-harness config (D-014) → `Event::PluginConfig`.
async fn load_plugin_config(harness: String, plugin: String, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("plugin config: {e}")));
            return;
        }
    };
    match client.plugin_config(&harness, &plugin).await {
        Ok(config) => {
            let _ = tx.send(Event::PluginConfig { plugin, config });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("plugin config: {e}")));
        }
    }
}

/// Apply one `:pset`/`:punset` plugin-settings edit (D-014): fetch the current
/// config, edit the dotted path, PUT it back, then refetch so the settings view
/// re-renders from what the backend persisted (it validates against the
/// manifest's configSchema + prunes defaults, so the round-trip is the truth).
async fn plugin_config_edit(
    harness: String,
    plugin: String,
    key: String,
    value: Option<String>,
    tx: UnboundedSender<Event>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("plugin edit: {e}")));
            return;
        }
    };
    let apply = async {
        let mut root = client.plugin_config(&harness, &plugin).await?;
        if !root.is_object() {
            root = serde_json::json!({});
        }
        app::edit_json_path(
            &mut root,
            &key,
            value.as_deref().map(app::parse_config_value),
        )
        .map_err(|e| anyhow::anyhow!(e))?;
        client.put_plugin_config(&harness, &plugin, &root).await?;
        anyhow::Ok(())
    };
    if let Err(e) = apply.await {
        let _ = tx.send(Event::Error(format!("plugin edit: {e}")));
    }
    match client.plugin_config(&harness, &plugin).await {
        Ok(config) => {
            let _ = tx.send(Event::PluginConfig { plugin, config });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("plugin refetch: {e}")));
        }
    }
}

/// Start one test file through the detached harness route, then poll its
/// observable snapshot until a terminal status. A transport error becomes a
/// terminal `error` snapshot so the run pane always resolves.
async fn run_test_file(harness: String, file: String, tx: UnboundedSender<Event>) {
    let fail_file = file.clone();
    let fail = move |run_id: String, msg: String| models::TestRunSnapshot {
        run_id,
        file_path: Some(fail_file.clone()),
        status: "error".to_string(),
        output: msg,
        ..Default::default()
    };
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::TestRunProgress {
                file,
                snapshot: fail(String::new(), format!("{e}")),
            });
            return;
        }
    };
    let started = match client.testing_run_detached(&harness, &file).await {
        Ok(snapshot) => snapshot,
        Err(e) => {
            let _ = tx.send(Event::TestRunProgress {
                file,
                snapshot: fail(String::new(), format!("{e}")),
            });
            return;
        }
    };
    let run_id = started.run_id.clone();
    let terminal = |status: &str| matches!(status, "pass" | "fail" | "cancelled" | "error");
    let is_terminal = terminal(&started.status);
    let _ = tx.send(Event::TestRunProgress {
        file: file.clone(),
        snapshot: started,
    });
    if is_terminal {
        return;
    }

    loop {
        // A short interval gives useful rolling output without turning the
        // status endpoint into a tight request loop.
        tokio::time::sleep(Duration::from_millis(250)).await;
        match client.testing_run_status(&harness, &run_id).await {
            Ok(snapshot) => {
                let done = terminal(&snapshot.status);
                let _ = tx.send(Event::TestRunProgress {
                    file: file.clone(),
                    snapshot,
                });
                if done {
                    break;
                }
            }
            Err(e) => {
                let _ = tx.send(Event::TestRunProgress {
                    file: file.clone(),
                    snapshot: fail(run_id.clone(), format!("status poll: {e}")),
                });
                break;
            }
        }
    }
}

/// Request cancellation for a detached test run. The run's polling task keeps
/// running independently and will paint the authoritative terminal snapshot.
async fn cancel_test_run(
    harness: String,
    run_id: String,
    _file: String,
    tx: UnboundedSender<Event>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("cancel test: {e}")));
            return;
        }
    };
    if let Err(e) = client.testing_run_cancel(&harness, &run_id).await {
        let _ = tx.send(Event::Error(format!("cancel test: {e}")));
    }
}

/// Execute a command-palette workbench command (P12b / D-002): list/save/restore
/// layouts + crews, plus P-012's live tool-catalog flow, via the backend. Ordinary
/// results surface as toasts; tool discovery/invocation returns typed palette
/// events so the reducer can preserve stale-result guards and semantic cards. The
/// SAVE-LAYOUT capture + RESTORE spawn are LIVE (zellij/psu) — real code that only
/// fires inside a running pui (never exercised by the offline test suite).
async fn execute_workbench_command(
    cmd: app::PaletteCommand,
    members: Vec<models::CrewMember>,
    roster: Vec<models::RosterEntry>,
    tx: UnboundedSender<Event>,
) {
    use app::PaletteCommand as P;
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("workbench: {e}")));
            return;
        }
    };
    let owner = workbench::workbench_owner();
    let toast = |msg: String| {
        Event::Notify(models::Notif {
            level: "info".to_string(),
            message: msg,
            harness: None,
            ts: None,
        })
    };
    match cmd {
        P::FindTool {
            query,
            harness,
            plan,
        } => {
            let tool_query = query.clone();
            let recipe_query = query.clone();
            let tool_search = async {
                let envelope = client
                    .run_tool("tools:find", serde_json::json!({ "query": tool_query }))
                    .await
                    .map_err(|error| error.to_string())?;
                let inner = crate::client::run_tool_inner_json(&envelope)
                    .map_err(|error| error.to_string())?;
                let hits = inner
                    .get("hits")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!([]));
                serde_json::from_value::<Vec<models::ToolPaletteHit>>(hits)
                    .map_err(|error| format!("tools:find result: {error}"))
            };
            let recipe_search = async {
                let mut context = serde_json::Map::new();
                if let Some(harness) = harness.filter(|value| value != "all") {
                    context.insert("harness".into(), serde_json::Value::String(harness));
                }
                if let Some(plan) = plan {
                    context.insert("plan".into(), serde_json::Value::String(plan));
                }
                let mut args = serde_json::json!({
                    "query": recipe_query,
                    "limit": 5,
                });
                if !context.is_empty() {
                    args["context"] = serde_json::Value::Object(context);
                }
                let envelope = client
                    .run_tool("recipes:search", args)
                    .await
                    .map_err(|error| error.to_string())?;
                let inner = crate::client::run_tool_inner_json(&envelope)
                    .map_err(|error| error.to_string())?;
                let recipes = inner
                    .get("recipes")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!([]));
                serde_json::from_value::<Vec<models::ToolPaletteRecipe>>(recipes)
                    .map_err(|error| format!("recipes:search result: {error}"))
            };
            let (tools, recipes) = tokio::join!(tool_search, recipe_search);
            let _ = tx.send(Event::ToolPaletteSearchFinished {
                query,
                tools,
                recipes,
            });
        }
        P::InvokeTool { query, tool, args } => {
            let result = client
                .run_tool(
                    "tools:invoke",
                    serde_json::json!({
                        "name": tool.name.clone(),
                        "args": args.clone(),
                    }),
                )
                .await
                .and_then(|envelope| crate::client::run_tool_inner_json(&envelope))
                .map_err(|error| error.to_string());
            let _ = tx.send(Event::ToolPaletteInvocationFinished {
                query,
                tool,
                args,
                result,
            });
        }
        P::ListLayouts => match client.list_layouts(&owner).await {
            Ok(ls) => {
                let names = if ls.is_empty() {
                    "(none saved)".to_string()
                } else {
                    ls.iter()
                        .map(|l| l.name.clone())
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                let _ = tx.send(toast(format!("layouts: {names}")));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("layouts: {e}")));
            }
        },
        P::ListCrews => match client.list_crews(&owner).await {
            Ok(cs) => {
                let names = if cs.is_empty() {
                    "(none saved)".to_string()
                } else {
                    cs.iter()
                        .map(|c| format!("{} ({})", c.name, c.member_count))
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                let _ = tx.send(toast(format!("crews: {names}")));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("crews: {e}")));
            }
        },
        P::SaveCrew(name) => match client.save_crew(&owner, &name, &members, None, None).await {
            Ok(()) => {
                let _ = tx.send(toast(format!(
                    "saved crew '{name}' ({} agents)",
                    members.len()
                )));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("save-crew: {e}")));
            }
        },
        P::SaveLayout(name) => match workbench::capture_zellij_layout() {
            Some(kdl) => match client.save_layout(&owner, &name, &kdl, None).await {
                Ok(()) => {
                    let _ = tx.send(toast(format!("saved layout '{name}'")));
                }
                Err(e) => {
                    let _ = tx.send(Event::Error(format!("save-layout: {e}")));
                }
            },
            None => {
                let _ = tx.send(Event::Error(
                    "save-layout: not inside a zellij session".to_string(),
                ));
            }
        },
        P::RestoreLayout(name) => match client.get_layout(&owner, &name).await {
            Ok(Some(row)) => {
                // Write the KDL to a temp file + start a session from it (LIVE).
                let path = std::env::temp_dir().join(format!("pui-layout-{name}.kdl"));
                match std::fs::write(&path, &row.kdl) {
                    Ok(()) => {
                        let argv = workbench::restore_layout_argv(&path.to_string_lossy());
                        if let Some((prog, rest)) = argv.split_first() {
                            let _ = std::process::Command::new(prog).args(rest).spawn();
                        }
                        let _ = tx.send(toast(format!("restoring layout '{name}'")));
                    }
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("restore-layout: {e}")));
                    }
                }
            }
            Ok(None) => {
                let _ = tx.send(Event::Error(format!("restore-layout: '{name}' not found")));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("restore-layout: {e}")));
            }
        },
        P::RestoreCrew(name) => match client.get_crew(&owner, &name).await {
            Ok(Some(crew)) => {
                // P-031 (crews are the multi-session switch): route each saved
                // member by LIVENESS instead of blind-spawning a pane per row —
                // fresh members spawn, live members get focused by the reducer,
                // parked members are WOKEN (coord:wake), and ended members
                // PROMPT in the reducer (never a silently smaller workspace,
                // D-009).
                let part = workbench::partition_crew(&crew.members, &roster);
                // Fire-and-forget each fresh pane (LIVE — the companion isn't
                // reachable from this task; the run loop's fallback is mirrored).
                for spec in &part.fresh {
                    let _ = Zellij.open_pane(spec);
                }
                let mut woken: Vec<String> = Vec::new();
                let mut wake_failed: Vec<String> = Vec::new();
                for entry in &part.parked {
                    let args = serde_json::json!({
                        "to": entry.owner_id,
                        "note": format!("crew '{name}' restore: resume your lane"),
                    });
                    match client.run_tool("coord:wake", args).await {
                        Ok(_) => woken.push(entry.owner_id.clone()),
                        Err(_) => wake_failed.push(entry.owner_id.clone()),
                    }
                }
                let _ = tx.send(Event::CrewRestoreResolved {
                    name: name.clone(),
                    fresh_spawned: part.fresh.len(),
                    live: part.live,
                    woken,
                    wake_failed,
                    ended: part.ended,
                });
            }
            Ok(None) => {
                let _ = tx.send(Event::Error(format!("restore-crew: '{name}' not found")));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("restore-crew: {e}")));
            }
        },
        // `:pickup [<plan>] <item>` — convert-at-pickup (D-015): the plan item
        // becomes a claimed work_item (lease + mint/resume + back-link) via
        // POST /api/tui/plan-item-convert; the server-side emits broadcast the
        // claim + flip the item todo→wip. Refetch the item states right after
        // so the pane reflects the new holder without waiting for the poller.
        P::PickupPlanItem {
            harness,
            plan,
            item,
        } => {
            let harness = harness.unwrap_or_else(|| "all".to_string());
            let Some(plan) = plan else {
                let _ = tx.send(Event::Error("pickup: no plan selected".to_string()));
                return;
            };
            match client
                .plan_item_convert(&owner, &harness, &plan, &item)
                .await
            {
                Ok(v) => {
                    let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
                    if ok {
                        let status = v
                            .get("status")
                            .and_then(|s| s.as_str())
                            .unwrap_or("converted");
                        let wi = v
                            .pointer("/workItem/id")
                            .and_then(|s| s.as_str())
                            .unwrap_or("?");
                        let _ = tx.send(toast(format!("pickup {item}: {status} → {wi} (claimed)")));
                    } else {
                        let why = v
                            .get("reason")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string())
                            .or_else(|| {
                                v.pointer("/conflict/ownerLabel")
                                    .or_else(|| v.pointer("/conflict/owner"))
                                    .and_then(|s| s.as_str())
                                    .map(|holder| format!("held by {holder}"))
                            })
                            .or_else(|| {
                                v.get("error")
                                    .and_then(|s| s.as_str())
                                    .map(|s| s.to_string())
                            })
                            .unwrap_or_else(|| "refused".to_string());
                        let _ = tx.send(Event::Error(format!("pickup {item}: {why}")));
                    }
                    if let Ok(s) = client.plan_item_states(&harness, &plan).await {
                        let _ = tx.send(Event::PlanItemStates(s));
                    }
                }
                Err(e) => {
                    let _ = tx.send(Event::Error(format!("pickup: {e}")));
                }
            }
        }
        // `:release [<plan>] <item>` — the `:pickup` inverse (P-005b release
        // half): POST /api/tui/plan-item-release releases the converted
        // work_item (server-side reflect rules flip the item back to todo +
        // drop the lease) or just the bare lease when nothing live exists.
        // Refetch the item states right after, same as pickup.
        P::ReleasePlanItem {
            harness,
            plan,
            item,
        } => {
            let harness = harness.unwrap_or_else(|| "all".to_string());
            let Some(plan) = plan else {
                let _ = tx.send(Event::Error("release: no plan selected".to_string()));
                return;
            };
            match client
                .plan_item_release(&owner, &harness, &plan, &item)
                .await
            {
                Ok(v) => {
                    let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
                    if ok {
                        let msg = match v.pointer("/workItem/id").and_then(|s| s.as_str()) {
                            // Released the live execution record — the reflect
                            // rules put the plan item back in the pool.
                            Some(wi) => format!("release {item}: {wi} released (back to pool)"),
                            // Bare-lease path (`released` rides plan_items:release).
                            None => {
                                if v.get("released").and_then(|b| b.as_bool()).unwrap_or(true) {
                                    format!("release {item}: lease released")
                                } else {
                                    format!("release {item}: no claim held")
                                }
                            }
                        };
                        let _ = tx.send(toast(msg));
                    } else {
                        let why = v
                            .get("note")
                            .or_else(|| v.get("error"))
                            .and_then(|s| s.as_str())
                            .unwrap_or("refused");
                        let _ = tx.send(Event::Error(format!("release {item}: {why}")));
                    }
                    if let Ok(s) = client.plan_item_states(&harness, &plan).await {
                        let _ = tx.send(Event::PlanItemStates(s));
                    }
                }
                Err(e) => {
                    let _ = tx.send(Event::Error(format!("release: {e}")));
                }
            }
        }
        // Config-tab (D-013) + plugin-settings (D-014) commands, the dockview
        // dock-verbs (Brief 50 / D-008) and the install lifecycle (P-011 /
        // D-016) are routed to their own Actions in the reducer and never reach
        // the workbench executor — defensive no-op.
        P::Lifecycle(_)
        | P::ConfigSet { .. }
        | P::ConfigUnset { .. }
        | P::PluginSet { .. }
        | P::PluginUnset { .. }
        | P::Stack
        | P::Float { .. }
        | P::Dock { .. }
        | P::Layout { .. }
        | P::Theme { name: None }
        | P::Themes => {}
        // `:theme <name>` (workbench-theme-system P2 / D-003): the reducer
        // already flipped the pui palette + persisted the selection; this arm
        // syncs the zellij CHROME — regenerate + install the theme KDL files
        // (additive, marker-guarded) and point the single managed `theme` line
        // in config.kdl at the selection, so zellij's config watcher re-themes
        // the same instant pui re-rendered. Off the UI thread; small files.
        P::Theme { name: Some(name) } => match zellij_theme::sync(&name) {
            Ok(out) => {
                let mut msg = format!("theme: zellij chrome → {name}");
                if let zellij_theme::ConfigOutcome::RespectedUser(user) = &out.config {
                    msg = format!(
                        "theme: {name} set in pui only — config.kdl has your own `theme \"{user}\"` line (left untouched; remove it to let pui manage the chrome)"
                    );
                }
                if !out.skipped.is_empty() {
                    msg.push_str(&format!(
                        " · kept your own theme file(s): {}",
                        out.skipped.join(", ")
                    ));
                }
                let _ = tx.send(toast(msg));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("theme: zellij sync: {e}")));
            }
        },
        // `:create <slug> <path-or-github-url>` (D-010) — register a new pot,
        // then refresh the pot list so it appears in the selector immediately.
        P::CreatePot { slug, source } => match client.create_harness(&slug, &source).await {
            Ok(resp) => {
                if let Some(err) = resp.error {
                    let _ = tx.send(Event::Error(format!("create '{slug}': {err}")));
                } else {
                    let path = resp
                        .project
                        .as_ref()
                        .and_then(|p| p.path.clone())
                        .unwrap_or_default();
                    let _ = tx.send(toast(format!("created pot '{slug}' at {path}")));
                    if let Ok(hs) = client.harnesses().await {
                        let _ = tx.send(Event::Harnesses(hs));
                    }
                }
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("create '{slug}': {e}")));
            }
        },
        // `:share <slug> [invite|public|private]` — hive-native sharing.
        P::SharePot { slug, visibility } => {
            share_pot(&client, &slug, visibility, &tx).await;
        }
        // `:message <text>` (inbox-tiering D-004) — "Message owner": open a
        // work-item-scoped conversation with the selected inbox item's owning
        // agent. The thread is browsable + repliable in the Conversations tab.
        P::MessageOwner {
            to,
            harness,
            plan_slug,
            item_ref,
            title,
            body,
        } => {
            match client
                .message_agent(
                    to.as_deref(),
                    harness.as_deref(),
                    plan_slug.as_deref(),
                    item_ref.as_deref(),
                    &title,
                    &body,
                )
                .await
            {
                Ok(conv_id) => {
                    let who = to.as_deref().unwrap_or("the owning agent");
                    let _ = tx.send(toast(format!(
                        "messaged {who} — thread {conv_id} (open the Conversations tab to continue)"
                    )));
                }
                Err(e) => {
                    let _ = tx.send(Event::Error(format!("message owner: {e}")));
                }
            }
        }
        // `:resolve <note>` (EI-50) — triage-resolve the selected inbox item.
        // `item_id` is always `Some` by the time it reaches here (the palette
        // Enter handler resolves it from the selection, or errors before ever
        // dispatching this action).
        P::TriageResolve { item_id, note } => {
            let Some(item_id) = item_id else {
                let _ = tx.send(Event::Error(
                    "resolve: no inbox item selected (Inbox tab)".to_string(),
                ));
                return;
            };
            match client.resolve_inbox_item(&item_id, &note).await {
                Ok(()) => {
                    let _ = tx.send(toast(format!("resolved {item_id}")));
                }
                Err(e) => {
                    let _ = tx.send(Event::Error(format!("resolve: {e}")));
                }
            }
        }
    }
}

/// P-013 quick answer/ack execution. On success, refetch through the same
/// `attention_typed` client path as the normal sync loop so the visible queue
/// reconciles from source truth rather than optimistically deleting a row.
async fn execute_inbox_action(
    target: app::InboxActionTarget,
    action_id: String,
    answer_text: Option<String>,
    tx: UnboundedSender<Event>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(client) => client,
        Err(error) => {
            let _ = tx.send(Event::Error(format!("inbox action: {error}")));
            return;
        }
    };
    match client
        .run_inbox_action(&target, &action_id, answer_text.as_deref())
        .await
    {
        Ok(()) => {
            let _ = tx.send(Event::Notify(models::Notif {
                level: "info".into(),
                message: format!(
                    "{}: {}",
                    target.title,
                    if action_id == "ack" {
                        "acknowledged"
                    } else {
                        "answered"
                    }
                ),
                harness: target.harness_slug.clone(),
                ts: None,
            }));
            match client.attention_typed().await {
                Ok(items) => {
                    let _ = tx.send(Event::Inbox(items));
                }
                Err(error) => {
                    let _ = tx.send(Event::Error(format!("inbox refetch: {error}")));
                }
            }
        }
        Err(error) => {
            let _ = tx.send(Event::Error(format!("inbox action: {error}")));
        }
    }
}

/// Hive-native `:share` (pui-tui-next-wave D-005): read the owner's current
/// metadata, then call the one set-pot composition. The retired GitHub binding /
/// shared.json / generic harness-publish generation is deliberately absent.
async fn share_pot(
    client: &OperatorClient,
    slug: &str,
    visibility: models::HiveVisibility,
    tx: &UnboundedSender<Event>,
) {
    let toast = |message: String| {
        Event::Notify(models::Notif {
            level: "info".to_string(),
            message,
            harness: Some(slug.to_string()),
            ts: None,
        })
    };

    let meta = match client.hive_share_meta(slug).await {
        Ok(meta) => meta,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("share: read '{slug}' metadata: {e}")));
            return;
        }
    };
    let title = if meta.title.trim().is_empty() {
        slug.to_string()
    } else {
        meta.title.clone()
    };
    let invite_secret = if visibility == models::HiveVisibility::Invite {
        match meta
            .invite_secret
            .clone()
            .filter(|secret| valid_invite_secret(secret))
        {
            Some(secret) => Some(secret),
            None => match mint_invite_secret() {
                Ok(secret) => Some(secret),
                Err(e) => {
                    let _ = tx.send(Event::Error(format!("share: mint invite secret: {e}")));
                    return;
                }
            },
        }
    } else {
        None
    };
    let request = models::SetHiveListingRequest {
        pot_id: slug.to_string(),
        title,
        description: meta.description.clone(),
        visibility,
        invite_secret: invite_secret.clone(),
    };
    let outcome = match client.set_hive_listing(&request).await {
        Ok(outcome) if outcome.ok && outcome.saved => outcome,
        Ok(_) => {
            let _ = tx.send(Event::Error(format!(
                "share: '{slug}' listing returned without a saved outcome"
            )));
            return;
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("share: save '{slug}': {e}")));
            return;
        }
    };

    let invite_link = invite_secret
        .as_deref()
        .map(|secret| format_hive_invite_link(secret, meta.hive_pubkey.as_deref(), &request.title));
    if let Some(error) = outcome.announce_error.as_deref() {
        let artifact = invite_link
            .as_deref()
            .map(|link| format!(" — invite: {link}"))
            .unwrap_or_default();
        let _ = tx.send(Event::Error(format!(
            "share: '{slug}' saved as {}, but publish failed: {error}{artifact}",
            visibility.as_str()
        )));
        return;
    }

    let _ = tx.send(toast(share_completion_message(
        slug,
        visibility,
        &outcome,
        invite_link.as_deref(),
    )));
}

/// 24 CSPRNG bytes as lowercase hex — the current desktop share dialog's
/// invite-secret shape, without adding a one-use dependency to the Unix TUI.
fn mint_invite_secret() -> Result<String> {
    use std::io::Read;
    let mut bytes = [0u8; 24];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn valid_invite_secret(secret: &str) -> bool {
    (32..=128).contains(&secret.len()) && secret.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn encode_query_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn format_hive_invite_link(secret: &str, pubkey: Option<&str>, title: &str) -> String {
    let mut params = Vec::with_capacity(3);
    if let Some(pubkey) = pubkey.filter(|value| !value.is_empty()) {
        params.push(format!("pubkey={}", encode_query_component(pubkey)));
    }
    params.push(format!("secret={}", encode_query_component(secret)));
    if !title.is_empty() {
        params.push(format!("title={}", encode_query_component(title)));
    }
    format!("papercusp://pot?{}", params.join("&"))
}

fn share_completion_message(
    slug: &str,
    visibility: models::HiveVisibility,
    outcome: &models::SetHiveListingResponse,
    invite_link: Option<&str>,
) -> String {
    if visibility == models::HiveVisibility::Private {
        return if outcome.withdrawn {
            format!("withdrew '{slug}' from the directory + Cupboard")
        } else {
            format!("set '{slug}' private")
        };
    }

    let peers = outcome.reachable_peers.unwrap_or(0);
    let reach = if outcome.announced && peers > 0 {
        format!(
            "; reached {peers} peer{}",
            if peers == 1 { "" } else { "s" }
        )
    } else if outcome.announced {
        "; no reachable peers yet".to_string()
    } else {
        "; saved locally, not announced".to_string()
    };
    match visibility {
        models::HiveVisibility::Public => {
            format!("published '{slug}' to the directory + Cupboard{reach}")
        }
        models::HiveVisibility::Invite => format!(
            "shared '{slug}' invite-only{reach} — {}",
            invite_link.unwrap_or("invite artifact unavailable")
        ),
        models::HiveVisibility::Private => unreachable!("handled above"),
    }
}

/// Fetch Cupboard listings for the active (kind, query) filter (D-011) and emit
/// `Event::CupboardListings` (stale-guarded in the reducer by kind+query). On
/// error an empty page still ships so the loading state resolves; the error
/// itself lands in the status bar.
async fn fetch_cupboard(
    kind: String,
    query: String,
    cursor: Option<String>,
    append: bool,
    tx: UnboundedSender<Event>,
) {
    let empty = || Event::CupboardListings {
        kind: kind.clone(),
        query: query.clone(),
        requested_cursor: cursor.clone(),
        append,
        failed: true,
        listings: Vec::new(),
        next_cursor: None,
        total: None,
        kind_facets: std::collections::BTreeMap::new(),
    };
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("cupboard: {e}")));
            let _ = tx.send(empty());
            return;
        }
    };
    match client
        .cupboard_listings(
            Some(kind.as_str()),
            Some(query.as_str()),
            100,
            cursor.as_deref(),
        )
        .await
    {
        Ok(page) => {
            let _ = tx.send(Event::CupboardListings {
                kind,
                query,
                requested_cursor: cursor,
                append,
                failed: false,
                listings: page.listings,
                next_cursor: page.next_cursor,
                total: page.total,
                kind_facets: page.kind_facets,
            });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("cupboard: {e}")));
            let _ = tx.send(empty());
        }
    }
}

/// Execute a confirmed per-kind Cupboard action (D-011). Unsupported catalog
/// kinds never reach this function because the reducer keeps them read-only;
/// the fallback remains as defense against stale/injected actions.
/// Conversations browse (Brief 25): fetch the list under the active state/kind
/// filter ("all" → no filter). Mirrors `fetch_cupboard` — emits an empty list on
/// error so the tab degrades to its empty state instead of hanging on "loading".
async fn fetch_conversations(state: String, kind: String, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("conversations: {e}")));
            let _ = tx.send(Event::Conversations(Vec::new()));
            return;
        }
    };
    let st = if state == "all" {
        None
    } else {
        Some(state.as_str())
    };
    let kd = if kind == "all" {
        None
    } else {
        Some(kind.as_str())
    };
    match client.conversations_list(st, kd, None).await {
        Ok(list) => {
            let _ = tx.send(Event::Conversations(list));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("conversations: {e}")));
            let _ = tx.send(Event::Conversations(Vec::new()));
        }
    }
}

/// Load one conversation's full thread (seed + topics + posts + accepted answer +
/// linked work-item). Stale-guarded by id in the reducer.
async fn fetch_conversation_detail(id: String, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("conversation: {e}")));
            return;
        }
    };
    match client.conversation_get(&id).await {
        Ok(detail) => {
            let _ = tx.send(Event::ConversationDetail { id, detail });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("conversation: {e}")));
        }
    }
}

/// Promote a conversation → engineer issue (carries the thread), then refresh the
/// detail so the linked work-item + closed state show. The list refreshes on the
/// next `r`/filter change.
async fn promote_conversation(id: String, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("promote: {e}")));
            return;
        }
    };
    match client.conversation_promote(&id).await {
        Ok(issue) => {
            let message = if issue.is_empty() {
                "conversation promoted to an issue".to_string()
            } else {
                format!("promoted → {issue}")
            };
            let _ = tx.send(Event::Notify(models::Notif {
                level: "info".to_string(),
                message,
                harness: None,
                ts: None,
            }));
            if let Ok(detail) = client.conversation_get(&id).await {
                let _ = tx.send(Event::ConversationDetail { id, detail });
            }
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("promote: {e}")));
        }
    }
}

async fn cupboard_act(listing: models::CupboardListing, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("cupboard action: {e}")));
            return;
        }
    };
    let name = listing.display_name().to_string();
    let kind = listing.normalized_kind().to_string();
    let toast = |msg: String| {
        Event::Notify(models::Notif {
            level: "info".to_string(),
            message: msg,
            harness: None,
            ts: None,
        })
    };
    // The (outcome, success message, whether the pot list changed).
    let (result, ok_msg, pots_changed) = match kind.as_str() {
        "plugin" | "pack" => (
            client.cupboard_install_plugin(&listing.id).await,
            format!("installed {kind} '{name}'"),
            false,
        ),
        "blueprint" => (
            client.cupboard_install_blueprint(&listing.id).await,
            format!("installed blueprint '{name}' — start a pot from it with :create"),
            false,
        ),
        "template" => (
            client.cupboard_install_template(&listing.id).await,
            format!("installed template '{name}' — materialize it with templates:new-app"),
            false,
        ),
        "knowledge-pack" => (
            client.cupboard_stage_knowledge_pack(&listing.id).await,
            format!("staged knowledge pack '{name}' — review/install it from Learnings"),
            false,
        ),
        "app" if listing.delivery_type.as_deref() == Some("bundle") => (
            client.cupboard_install_app(&listing.id).await,
            format!("installed app bundle '{name}'"),
            false,
        ),
        // ("snapshot" listings are RETIRED — the Cupboard's kinds are now
        // harness | blueprint | plugin | pack, and /api/snapshots/
        // fork-from-cupboard has no successor. P-003 2026-08-24.)
        "harness" => {
            let Some(link) = listing.join_link() else {
                let _ = tx.send(Event::Error(format!(
                    "join '{name}': listing has no topic/github join link"
                )));
                return;
            };
            // Local slug defaults to the listing's name fields.
            let slug = listing
                .listing_ref
                .clone()
                .or_else(|| listing.github_name.clone())
                .unwrap_or_else(|| name.clone());
            (
                client.harness_join_link(&slug, &link).await,
                format!("joined '{name}' as pot '{slug}'"),
                true,
            )
        }
        other => {
            let _ = tx.send(Event::Error(format!(
                "cupboard: listing kind '{other}' is read-only in PUI"
            )));
            return;
        }
    };
    match result {
        Ok(v) => {
            if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
                let _ = tx.send(Event::Error(format!("cupboard {}: {e}", kind)));
                return;
            }
            // Surface the blueprint dep-checker's missing-deps note when present.
            let dep_note = v
                .get("depCheck")
                .and_then(|d| d.get("ok"))
                .and_then(|b| b.as_bool())
                .map(|ok| {
                    if ok {
                        String::new()
                    } else {
                        " (missing deps — see desktop)".into()
                    }
                })
                .unwrap_or_default();
            let _ = tx.send(toast(format!("{ok_msg}{dep_note}")));
            if pots_changed {
                if let Ok(hs) = client.harnesses().await {
                    let _ = tx.send(Event::Harnesses(hs));
                }
            }
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("cupboard {}: {e}", kind)));
        }
    }
}

/// Fetch the active Hive lexicon pack ONCE at startup (pui-hive-lexicon-2026-06-06)
/// and emit `Event::LexiconPack`. Fail-soft: an unreachable operator / parse
/// error leaves the classic fallback in place (no rebrand), silently — branding
/// must never block the UI.
async fn lexicon_fetch(tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    if let Ok(pack) = client.lexicon_active_pack().await {
        let _ = tx.send(Event::LexiconPack(pack));
    }
}

/// P-008: set an agent's wake mode via `coord:wake-mode` (the run_tool bridge).
/// Best-effort — an error surfaces in the status bar; the next roster poll
/// refreshes the ⏸MANUAL badge (no dedicated re-fetch event needed).
async fn set_wake_mode(agent: String, mode: String, tx: UnboundedSender<Event>) {
    let res = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .run_tool(
                "coord:wake-mode",
                serde_json::json!({ "agent": agent, "mode": mode }),
            )
            .await
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    if let Err(e) = res {
        let _ = tx.send(Event::Error(format!("wake-mode: {e}")));
    }
}

/// P-009: list an agent's staged wakes (`coord:wake-queue {action:'list'}`) for
/// the review overlay → `Event::WakeQueue`.
async fn fetch_wake_queue(agent: String, tx: UnboundedSender<Event>) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .run_tool(
                "coord:wake-queue",
                serde_json::json!({ "agent": agent, "action": "list" }),
            )
            .await
            .map_err(|e| e.to_string())
            .and_then(|v| crate::client::parse_wake_queue_list(&v).map_err(|e| e.to_string())),
        Err(e) => Err(e.to_string()),
    };
    let _ = tx.send(Event::WakeQueue { agent, result });
}

/// P-009: release (as-is or with edited content) / skip ONE staged wake, then
/// re-list the queue so the overlay refreshes. An act error rides the same
/// `Event::WakeQueue` rail (Err → shown inline in the overlay).
async fn wake_queue_act(
    agent: String,
    release: bool,
    id: i64,
    edited: Option<String>,
    tx: UnboundedSender<Event>,
) {
    let action = if release { "release" } else { "skip" };
    let res = match OperatorClient::from_discovery().await {
        Ok(client) => {
            let mut args = serde_json::json!({ "agent": agent, "action": action, "id": id });
            if let Some(e) = edited {
                args["edited"] = serde_json::Value::String(e);
            }
            client
                .run_tool("coord:wake-queue", args)
                .await
                .map_err(|e| e.to_string())
                .and_then(|v| {
                    // Surface a tool-level { ok:false, reason } as an error.
                    let inner =
                        crate::client::run_tool_inner_json(&v).map_err(|e| e.to_string())?;
                    if inner.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
                        Ok(())
                    } else {
                        Err(inner
                            .get("reason")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("wake-queue act failed")
                            .to_string())
                    }
                })
        }
        Err(e) => Err(e.to_string()),
    };
    match res {
        Ok(()) => fetch_wake_queue(agent, tx).await,
        Err(e) => {
            let _ = tx.send(Event::WakeQueue {
                agent,
                result: Err(e),
            });
        }
    }
}

/// EI-312: snapshot the staged-wake board — an agent-LESS `coord:wake-queue`
/// list (every owner's queue, including stale owners the roster no longer
/// carries) joined with the roster for labels/kinds, scoped by this pane's
/// [`app::WakeFilter`] (fleet-wide, the live queen, or one owner), plus the
/// GLOBAL default wake-mode (a fleet-wide pause reads differently from one
/// paused agent) → `Event::WakeBoard`. The `Hive` scope (P-014 item 3) swaps
/// the source to the server-filtered `network.hive.wakes` query instead —
/// same rows, pre-scoped to the hive's attributed owners.
async fn fetch_wake_board(filter: app::WakeFilter, tx: UnboundedSender<Event>) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => {
            let pending = match &filter {
                app::WakeFilter::Hive(hive) => {
                    client.hive_wakes(hive).await.map_err(|e| e.to_string())
                }
                // EI-597 Step B: the non-Hive scopes (fleet/queen/owner) now read
                // the `network.fleet.wakes` SSE-rail query instead of polling
                // coord:wake-queue{action:list}. Same full-queue payload; the
                // filter_wake_groups call below still narrows it to the scope.
                _ => client.fleet_wakes().await.map_err(|e| e.to_string()),
            };
            match pending {
                Ok(pending) => {
                    // Roster join is best-effort: a fetch error degrades to raw
                    // owner-id labels, never an empty board.
                    let roster = client
                        .roster_typed()
                        .await
                        .map(|(active, _)| active)
                        .unwrap_or_default();
                    // The global default mode: coord:wake-mode with no agent.
                    let global_mode = client
                        .run_tool("coord:wake-mode", serde_json::json!({}))
                        .await
                        .ok()
                        .and_then(|v| crate::client::run_tool_inner_json(&v).ok())
                        .and_then(|inner| {
                            inner
                                .get("mode")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_string)
                        });
                    let groups = crate::app::filter_wake_groups(
                        crate::client::assemble_wake_board(pending, &roster),
                        &filter,
                        &roster,
                    );
                    Ok((groups, global_mode))
                }
                Err(e) => Err(e),
            }
        }
        Err(e) => Err(e.to_string()),
    };
    let _ = tx.send(Event::WakeBoard { result });
}

/// EI-312: act on the wake board — verb is the coord:wake-queue action
/// (release / skip take an id; release_all / skip_all drain the whole agent
/// queue), then re-snapshot. An act error rides Event::WakeBoard (Err →
/// shown inline in the pane).
async fn wake_board_act(
    agent: String,
    verb: &'static str,
    id: Option<i64>,
    edited: Option<String>,
    filter: app::WakeFilter,
    tx: UnboundedSender<Event>,
) {
    let res = match OperatorClient::from_discovery().await {
        Ok(client) => {
            let mut args = serde_json::json!({ "agent": agent, "action": verb });
            if let Some(id) = id {
                args["id"] = serde_json::Value::from(id);
            }
            if let Some(e) = edited {
                args["edited"] = serde_json::Value::String(e);
            }
            client
                .run_tool("coord:wake-queue", args)
                .await
                .map_err(|e| e.to_string())
                .and_then(|v| {
                    let inner =
                        crate::client::run_tool_inner_json(&v).map_err(|e| e.to_string())?;
                    if inner.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
                        Ok(())
                    } else {
                        Err(inner
                            .get("reason")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("wake-board act failed")
                            .to_string())
                    }
                })
        }
        Err(e) => Err(e.to_string()),
    };
    match res {
        Ok(()) => fetch_wake_board(filter, tx).await,
        Err(e) => {
            let _ = tx.send(Event::WakeBoard { result: Err(e) });
        }
    }
}

/// EI-312: the wake-pane's refresh loop — re-snapshot the board every ~10s.
/// Safety-net fallback (NOT a freshness poll): the pending-wakes push rail
/// EXISTS — pushWakeBoard() (pending-wakes.ts) fires notifySyncInvalidate(
/// 'network.hive.wakes') on every stage/clear, and the HIVE scope already
/// consumes it over SSE (fetch_wake_board → WakeFilter::Hive → client.hive_wakes,
/// no poll). The non-Hive scopes (fleet/queen/owner) are not yet on that SSE
/// query, so this loop still refreshes them — but DEMOTED 10s→60s (EI-597 Step A,
/// su-dfe5e + su-cf7b0): it is now a slow safety fallback, no longer the fleet's
/// #1/#2 tool-call driver. The board is a human review surface for paused
/// (manual-mode) agents, so 60s freshness is ample; user actions already refetch
/// immediately (the keymap's `fetch_wake_board` on r/e/s/R/S).
///
/// EI-597 Step B (full fix, in review): generalize the `network.hive.wakes` SSE
/// query to the non-Hive scopes + route fetch_wake_board's non-Hive branches to
/// it (mirroring the proven Hive branch), after which this fallback can drop.
async fn wake_board_loop(filter: app::WakeFilter, tx: UnboundedSender<Event>) {
    // 10s→60s safety-only fallback (EI-597 Step A): the Hive scope is SSE-driven;
    // this backstops the non-Hive scopes until Step B puts them on the rail too.
    let mut ticker = tokio::time::interval(Duration::from_millis(60_000));
    loop {
        ticker.tick().await;
        if tx.is_closed() {
            return;
        }
        fetch_wake_board(filter.clone(), tx.clone()).await;
    }
}

/// Dock 4-pane split (owner ask 2026-06-11): the agent-context pane's refresh
/// loop — re-snapshot every ~5s (mail/work mutate from many writers; the brief
/// is static but the AGENT can appear/exit). Justified poll: same rationale as
/// the wake board, one consumer per pane, no push rail for these reads.
async fn agent_ctx_loop(
    mode: app::AgentCtxMode,
    scope: app::WakeFilter,
    tx: UnboundedSender<Event>,
) {
    let mut ticker = tokio::time::interval(Duration::from_millis(5000));
    loop {
        ticker.tick().await;
        if tx.is_closed() {
            return;
        }
        fetch_agent_ctx(mode, scope.clone(), tx.clone()).await;
    }
}

/// One agent-context snapshot: resolve the scope to an owner id off the live
/// roster (Queen = the roster's queen-kind entry, same rule the wake board
/// uses), then fetch ONLY the pinned mode's data — brief via `fleet:tree`
/// (the nursery row of the owner's own spawn id), mail via `fleet:bee_mail`,
/// work via `fleet:assignments`.
async fn fetch_agent_ctx(
    mode: app::AgentCtxMode,
    scope: app::WakeFilter,
    tx: UnboundedSender<Event>,
) {
    let result: Result<models::AgentCtxData, String> = async {
        let client = OperatorClient::from_discovery()
            .await
            .map_err(|e| e.to_string())?;
        let roster = client
            .roster_typed()
            .await
            .map(|(active, _)| active)
            .unwrap_or_default();
        let entry = match &scope {
            app::WakeFilter::Owner(id) => roster.iter().find(|r| &r.owner_id == id),
            // Queen (and the never-used All fallback): the roster's canonical
            // Mug-kind row (`queen` remains a legacy alias).
            _ => roster.iter().find(|r| {
                r.agent_pane_kind
                    .as_deref()
                    .is_some_and(crate::agent_pane_kind::AgentPaneKind::is_mug_wire)
            }),
        };
        let owner = match (&scope, entry) {
            (app::WakeFilter::Owner(id), None) => Some(id.clone()), // gone but addressable
            (_, Some(r)) => Some(r.owner_id.clone()),
            (_, None) => None,
        };
        let mut data = models::AgentCtxData {
            owner: owner.clone(),
            label: entry.map(|r| r.label.clone()),
            ..Default::default()
        };
        let Some(owner) = owner else { return Ok(data) };
        match mode {
            app::AgentCtxMode::Prompt => {
                // The prompt the agent runs on (GET /api/fleet/agent-prompt):
                // an s-… owner gets its RECORDED run prompt (brief led
                // separately); a non-spawn owner under Queen scope gets a live
                // render of the queen role persona. The role hint follows the
                // roster entry's kind when known.
                let role_hint = if owner.starts_with("s-") {
                    None
                } else {
                    entry.and_then(|r| r.agent_pane_kind.clone()).or_else(|| {
                        matches!(scope, app::WakeFilter::Queen).then(|| "mug".to_string())
                    })
                };
                let v = client
                    .agent_prompt(Some(&owner), role_hint.as_deref())
                    .await
                    .map_err(|e| e.to_string())?;
                let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
                data.prompt = s("prompt");
                data.source = s("source");
                data.brief = s("brief");
                data.model = s("model");
                data.tier = s("tier");
            }
            app::AgentCtxMode::Mail => {
                data.mail = Some(
                    client
                        .bee_mail(&owner, 30)
                        .await
                        .map_err(|e| e.to_string())?,
                );
            }
            app::AgentCtxMode::Work => {
                data.assignment = client
                    .bee_assignment(&owner)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(data)
    }
    .await;
    let _ = tx.send(Event::AgentCtx { result });
}

/// Fetch the federated p2p roster (`coord:presence`, federated rows only) and
/// emit `Event::Hives` — the Hives tab's per-device swarm roster
/// (pui-hives-tab-2026-06-07). Best-effort: transport loss keeps the previous
/// list; the next Hives entry retries.
async fn fetch_hives(tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    match client.federated_hives().await {
        Ok(rows) => {
            let _ = tx.send(Event::Hives(rows));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("network nodes: {e}")));
        }
    }
}

/// Write a per-hive drill-in tab's KDL (`layout::hive_tab_kdl`, B-10) to
/// `~/.papercusp/pui-hive-tab-<key>.kdl` and return the path. The zellij CLI's
/// `new-tab --layout` takes a layout FILE; the companion (which takes raw KDL
/// text) is never spawned in pinned panes, so the network-pane's drill-in
/// rides the file + CLI. One file per hive key — re-opening overwrites it.
fn materialize_hive_tab(spec: &layout::HiveTabSpec) -> std::io::Result<std::path::PathBuf> {
    let base = dirs::home_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?
        .join(".papercusp");
    std::fs::create_dir_all(&base)?;
    // The key can be a pubkey-b64 (`/`, `+`, `=`) — slug it for the filename.
    let slug: String = spec
        .key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let path = base.join(format!("pui-hive-tab-{slug}.kdl"));
    std::fs::write(&path, layout::hive_tab_kdl(spec))?;
    Ok(path)
}

/// Fetch the cross-Hive network board (hive-network-surface B-09) off the UI
/// thread and emit `Event::NetworkBoard` — the network-pane's manual `g`
/// refresh. Errors surface in the status bar (the user asked, so a failure is
/// an answer); the refetch loop's passes stay quietly optional instead.
async fn fetch_network_board(tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    match client.network_board().await {
        Ok(rows) => {
            let _ = tx.send(Event::NetworkBoard(rows));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("network board: {e}")));
        }
    }
}

/// Fetch the one canonical Context projection. Capability-tier absence is an
/// explicit `None`; the client never reconstructs missing frames locally.
async fn fetch_context_projection(
    target: models::ConversationContextProjectionTarget,
    tx: UnboundedSender<Event>,
) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    match client.conversation_context_projection(&target).await {
        Ok(projection) => {
            let _ = tx.send(Event::ConversationContextProjectionLoaded { target, projection });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("context projection: {e}")));
        }
    }
}

/// Fetch global session-switcher candidates (D-009) and preserve the request
/// query on the event so the reducer can discard out-of-order completions.
async fn fetch_session_switcher(query: String, tx: UnboundedSender<Event>) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .session_switcher_rows(None, &query)
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let _ = tx.send(Event::SessionSwitcher { query, result });
}

async fn fetch_session_browser(harness: String, query: String, tx: UnboundedSender<Event>) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .session_switcher_rows(Some(&harness), &query)
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let _ = tx.send(Event::SessionBrowser { query, result });
}

async fn rename_browser_agent_chat(
    session_key: String,
    harness: String,
    chat_id: String,
    title: String,
    tx: UnboundedSender<Event>,
) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .rename_agent_chat(&harness, &chat_id, &title)
            .await
            .map(|title| format!("Renamed session to {title}"))
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let _ = tx.send(Event::SessionBrowserMutation {
        session_key,
        result,
    });
}

async fn archive_browser_agent_chat(
    session_key: String,
    harness: String,
    chat_id: String,
    tx: UnboundedSender<Event>,
) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .archive_agent_chat(&harness, &chat_id)
            .await
            .map(|()| "Archived session (history remains recoverable)".to_string())
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let _ = tx.send(Event::SessionBrowserMutation {
        session_key,
        result,
    });
}

async fn continue_browser_agent_chat(
    session_key: String,
    harness: String,
    source_chat_id: String,
    tx: UnboundedSender<Event>,
) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .continue_agent_chat(&harness, &source_chat_id)
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let _ = tx.send(Event::SessionBrowserContinued {
        session_key,
        source_chat_id,
        harness,
        result,
    });
}

async fn resolve_session_transcript(
    session_key: String,
    target: models::ConversationContextProjectionTarget,
    tx: UnboundedSender<Event>,
) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .resolve_session_transcript(&target)
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let _ = tx.send(Event::SessionTranscriptResolved {
        session_key,
        result,
    });
}

async fn fetch_session_transcript(
    session_key: String,
    reference: String,
    tx: UnboundedSender<Event>,
) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .session_transcript(&reference)
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let _ = tx.send(Event::SessionTranscript {
        session_key,
        result,
    });
}

/// Fetch one plan's per-item assignment/claim/liveness (pui-plans-status-board
/// P-008) → `Event::PlanItemStates`, for the plans board's right-side work-items
/// detail. The reducer guards the render on `plan == selected`, so a stale fetch
/// from a prior selection never paints the wrong plan. Errors are swallowed (the
/// detail just keeps its last state / shows its loading hint).
async fn fetch_plan_item_states(harness: String, plan: String, tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    if let Ok(s) = client.plan_item_states(&harness, &plan).await {
        let _ = tx.send(Event::PlanItemStates(s));
    }
}

async fn preview_fleet_launch(fleet: String, args: serde_json::Value, tx: UnboundedSender<Event>) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .run_tool("scheduler:preview_spec_delta", args)
            .await
            .and_then(|value| crate::client::run_tool_inner_json(&value))
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let _ = tx.send(Event::FleetLaunchPreview { fleet, result });
}

async fn launch_fleet_on_plan(fleet: String, args: serde_json::Value, tx: UnboundedSender<Event>) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .run_tool("fleet:launch-on-plan", args)
            .await
            .and_then(|value| crate::client::run_tool_inner_json(&value))
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let _ = tx.send(Event::FleetLaunchFinished { fleet, result });
}

/// Fetch the per-hive drill-in dossier data (hive-network-surface P-014
/// item 2 / D-007 GAP 2) for the pinned `pui hive-pane <key>` instance: the
/// captured beacon HISTORY + the full C-1 ask log, via the `network.hive.*`
/// sync queries. Quietly best-effort BOTH ways: a tier-2/3 slug key simply
/// matches no beacon/peer rows (→ empty lists, sections hidden), and a host
/// predating the queries renders the C-3 detail alone — never a toast per pass.
async fn hive_dossier_fetch(key: String, tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    let beacons = client.hive_beacons(&key).await.unwrap_or_default();
    let asks = client.hive_asks(&key).await.unwrap_or_default();
    let _ = tx.send(Event::HiveDossier { beacons, asks });
}

/// Fetch the P2P hive directory (`GET /api/discovery/pots`) and emit
/// `Event::HiveDirectory` — the Hives tab's browseable directory list
/// (p2p-hive-directory P-006). Best-effort: a fetch failure keeps the prior list.
async fn fetch_hive_directory(tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    match client.discovered_hives().await {
        Ok(rows) => {
            let _ = tx.send(Event::HiveDirectory(rows));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("pot directory: {e}")));
        }
    }
}

/// Join every member harness of a discovered hive (p2p-hive-directory P-006):
/// POST each link to `/api/harness/join-link`. Emits one `Notify` summarising
/// how many succeeded (best-effort per link).
async fn join_hive(slug: String, links: Vec<String>, tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        let _ = tx.send(Event::Error("join: operator unreachable".to_string()));
        return;
    };
    let mut ok = 0usize;
    for (i, link) in links.iter().enumerate() {
        let member_slug = format!("{slug}-{i}");
        match client.join_hive_link(&member_slug, link).await {
            Ok(_) => ok += 1,
            Err(e) => {
                let _ = tx.send(Event::Error(format!("join {member_slug}: {e}")));
            }
        }
    }
    let _ = tx.send(Event::Notify(models::Notif {
        level: "info".to_string(),
        message: format!("pot {slug}: joined {ok}/{} member harness(es)", links.len()),
        harness: None,
        ts: None,
    }));
}

/// Fetch the whole-fleet assignments (`fleet:assignments`, no agent filter) and
/// emit `Event::FleetAssignments` — the default Swarm dossier's task list
/// (pui-dock-consolidation-2026-06-07 #2). Best-effort: a transport loss keeps
/// the "(loading fleet task list…)" placeholder; the next Fleet entry retries.
async fn fetch_fleet_assignments(tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    match client.fleet_assignments_all().await {
        Ok(agents) => {
            let _ = tx.send(Event::FleetAssignments(agents));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("fleet assignments: {e}")));
        }
    }
}

async fn fetch_work_frontier(harness: String, tx: UnboundedSender<Event>) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .work_frontier(&harness)
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let _ = tx.send(Event::WorkFrontier { harness, result });
}

async fn fetch_fleet_leader_brief(fleet: String, harness: String, tx: UnboundedSender<Event>) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .fleet_leader_brief(&fleet, &harness)
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let _ = tx.send(Event::FleetLeaderBrief { fleet, result });
}

/// Execute one y-confirmed leader-cockpit mutation. Every write uses the
/// existing loopback projected-tool dispatcher with `confirmed:true`, retaining
/// its authorization, safety checks and audit log. The spec bump is the sole
/// composite action: read the current fleet sentinel, clone its exact JSON
/// object, change only `revision`, then write it back.
async fn run_fleet_control(
    intent: crate::fleet::FleetControlIntent,
    harness: String,
    tx: UnboundedSender<Event>,
) {
    let fleet = intent.fleet.clone();
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => execute_fleet_control(&client, &intent, &harness)
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let _ = tx.send(Event::FleetControlFinished { fleet, result });
}

async fn execute_fleet_control(
    client: &OperatorClient,
    intent: &crate::fleet::FleetControlIntent,
    harness: &str,
) -> Result<String> {
    use crate::fleet::FleetControlKind;

    let (verb, outcome) = match intent.kind {
        FleetControlKind::Bench => {
            let gate = intent
                .gate
                .as_deref()
                .context("bench intent lost its announced gate")?;
            let value = run_confirmed_fleet_tool(
                client,
                "fleet:bench",
                serde_json::json!({
                    "fleet": intent.fleet,
                    "harness": harness,
                    "member": intent.member,
                    "wakeEvent": gate,
                    "stagedAssignment": format!(
                        "Resume the current fleet lane after announced gate {gate} fires"
                    ),
                }),
            )
            .await?;
            (
                "fleet:bench",
                summarize_control_result("fleet:bench", &value),
            )
        }
        FleetControlKind::Wake => {
            let value = run_confirmed_fleet_tool(
                client,
                "coord:wake",
                serde_json::json!({
                    "to": intent.member,
                    "note": format!("Fleet leader requested resume in {}", intent.fleet),
                }),
            )
            .await?;
            ("coord:wake", summarize_control_result("coord:wake", &value))
        }
        FleetControlKind::Relaunch => {
            let agent = intent
                .agent
                .as_deref()
                .context("relaunch intent lost the selected member's agent backend")?;
            let value = run_confirmed_fleet_tool(
                client,
                "fleet:respawn-member",
                serde_json::json!({
                    "fleet": intent.fleet,
                    "harness": harness,
                    "member": intent.member,
                    "agent": agent,
                    "reason": "y-confirmed relaunch from the pui Fleet cockpit",
                }),
            )
            .await?;
            (
                "fleet:respawn-member",
                summarize_control_result("fleet:respawn-member", &value),
            )
        }
        FleetControlKind::FireGate => {
            let gate = intent
                .gate
                .as_deref()
                .context("fire-gate intent lost its announced gate")?;
            let value = run_confirmed_fleet_tool(
                client,
                "events:emit",
                serde_json::json!({
                    "event": gate,
                    "summary": format!("Gate fired from the pui Fleet cockpit for {}", intent.fleet),
                }),
            )
            .await?;
            (
                "events:emit",
                summarize_control_result("events:emit", &value),
            )
        }
        FleetControlKind::BumpSpec => {
            let read_envelope = client
                .run_tool(
                    "scheduler:get_claim_spec",
                    serde_json::json!({ "fleet": intent.fleet }),
                )
                .await?;
            let current = crate::client::run_tool_inner_json(&read_envelope)?;
            ensure_tool_ok("scheduler:get_claim_spec", &current)?;
            let (spec, previous, next) = bumped_claim_spec(&current)?;
            let value = run_confirmed_fleet_tool(
                client,
                "scheduler:set_claim_spec",
                serde_json::json!({
                    "fleet": intent.fleet,
                    "harness": harness,
                    "spec": spec,
                }),
            )
            .await?;
            let reported = value
                .get("revision")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(next);
            (
                "scheduler:set_claim_spec",
                format!("revision {previous}→{reported}"),
            )
        }
    };
    Ok(format!("{verb} audited · {outcome}"))
}

async fn run_confirmed_fleet_tool(
    client: &OperatorClient,
    name: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value> {
    let envelope = client.run_tool_confirmed(name, args).await?;
    let value = crate::client::run_tool_inner_json(&envelope)?;
    ensure_tool_ok(name, &value)?;
    Ok(value)
}

fn ensure_tool_ok(name: &str, value: &serde_json::Value) -> Result<()> {
    if value.get("ok").and_then(serde_json::Value::as_bool) != Some(false) {
        return Ok(());
    }
    let detail = value
        .get("message")
        .or_else(|| value.get("reason"))
        .or_else(|| value.get("error"))
        .or_else(|| value.get("errors"))
        .map(|part| match part.as_str() {
            Some(text) => text.to_string(),
            None => part.to_string(),
        })
        .unwrap_or_else(|| "tool returned ok:false".into());
    anyhow::bail!("{name}: {detail}")
}

fn bumped_claim_spec(value: &serde_json::Value) -> Result<(serde_json::Value, i64, i64)> {
    let mut spec = value
        .get("spec")
        .cloned()
        .context("scheduler:get_claim_spec returned no spec")?;
    let previous = spec
        .get("revision")
        .and_then(serde_json::Value::as_i64)
        .context("scheduler:get_claim_spec returned a spec without an integer revision")?;
    let next = previous
        .checked_add(1)
        .context("claim-spec revision overflow")?;
    spec.as_object_mut()
        .context("scheduler:get_claim_spec returned a non-object spec")?
        .insert("revision".into(), serde_json::Value::from(next));
    Ok((spec, previous, next))
}

fn summarize_control_result(name: &str, value: &serde_json::Value) -> String {
    let fields: &[(&str, &str)] = match name {
        "fleet:bench" => &[("registered", "registered"), ("forced", "forced")],
        "coord:wake" => &[
            ("queued", "queued"),
            ("woken", "woken"),
            ("pickupConfirmed", "pickup"),
            ("recipient_dead", "recipient-dead"),
        ],
        "fleet:respawn-member" => &[
            ("verified", "verified"),
            ("replacementOwner", "replacement"),
        ],
        "events:emit" => &[("waiters", "waiters"), ("woken", "woken")],
        _ => &[],
    };
    let mut parts = Vec::new();
    for (key, label) in fields {
        if let Some(item) = value.get(*key) {
            if item.is_string() || item.is_number() || item.is_boolean() {
                let rendered = item
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| item.to_string());
                parts.push(format!("{label} {rendered}"));
            }
        }
    }
    if name == "fleet:bench" {
        if let Some(verdict) = value
            .pointer("/lane/verdict")
            .and_then(serde_json::Value::as_str)
        {
            parts.push(format!("lane {verdict}"));
        }
    }
    if parts.is_empty() {
        "ok".into()
    } else {
        parts.join(" · ")
    }
}

/// Fetch one bee's dossier — its ranked work-list (`fleet:assignments { agent }`)
/// + coord inbox/outbox (`fleet:bee_mail`) — and emit `Event::BeeDossier`. Each
///   half is best-effort: a failure of one still ships the other (the reducer
///   stale-guards on `owner_id`). On a total transport failure nothing is sent (the
///   pane keeps its "loading…" state; the next selection re-triggers).
async fn bee_dossier_fetch(owner_id: String, tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    let assignment = client.bee_assignment(&owner_id).await.ok().flatten();
    let mail = client.bee_mail(&owner_id, 50).await.ok();
    let _ = tx.send(Event::BeeDossier {
        owner_id,
        assignment,
        mail,
    });
}

// (`publish_bee_selection` was removed with the retired `fleet:selected_bee`
// relay — selection is purely in-process now; P-003 2026-08-24.)

/// Fetch the next older page of operator turns (load-earlier / scroll-back) and
/// emit `Event::ChatEarlier` to prepend them. Best-effort — a fetch error just
/// clears the in-flight flag (via an empty ChatEarlier) so the user can retry.
async fn load_earlier_chat(conversation_id: String, before_seq: i64, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(_) => {
            let _ = tx.send(Event::ChatEarlier {
                messages: Vec::new(),
                has_more_earlier: true,
                oldest_seq: None,
            });
            return;
        }
    };
    match client
        .load_earlier_turns(&conversation_id, before_seq, 200)
        .await
    {
        Ok(page) => {
            let oldest_seq = page.turns.iter().map(|t| t.seq).min();
            let messages: Vec<models::ChatMessage> =
                page.turns.into_iter().filter_map(turn_to_message).collect();
            let _ = tx.send(Event::ChatEarlier {
                messages,
                has_more_earlier: page.has_more_earlier,
                oldest_seq,
            });
        }
        Err(e) => {
            // Keep has_more_earlier=true so the user can retry; clear the flag.
            let _ = tx.send(Event::ChatEarlier {
                messages: Vec::new(),
                has_more_earlier: true,
                oldest_seq: None,
            });
            let _ = tx.send(Event::Error(format!("operator chat (earlier): {e}")));
        }
    }
}

/// Map a persisted turn to a rendered chat message. Only user/assistant turns
/// surface (system turns are internal); the persisted assistant text is already
/// the finalized `<say>` body, so it renders directly.
fn turn_to_message(t: models::TurnDto) -> Option<models::ChatMessage> {
    if t.role != "user" && t.role != "assistant" {
        return None;
    }
    let tools = t
        .tools
        .unwrap_or_default()
        .into_iter()
        .map(|x| models::ChatToolCall::plain(x.name))
        .collect();
    Some(models::ChatMessage {
        role: t.role,
        content: t.text,
        reasoning: String::new(),
        provenance: None,
        tools,
        streaming: false,
    })
}

fn native_turn_to_message(t: agent_chats::AgentChatTranscriptTurn) -> Option<models::ChatMessage> {
    if t.role != "user" && t.role != "assistant" {
        return None;
    }
    let content = if t.error {
        format!("{} {}", crate::glyph::severity::WARN, t.content)
    } else {
        t.content
    };
    let provenance =
        t.engine
            .zip(t.model)
            .zip(t.account_route)
            .map(|((engine, model), account_route)| models::ChatProvenance {
                engine,
                model,
                account_route,
            });
    Some(models::ChatMessage {
        role: t.role,
        content,
        reasoning: String::new(),
        provenance,
        tools: t
            .tools
            .into_iter()
            .map(|tool| models::ChatToolCall::plain(tool.name))
            .collect(),
        streaming: false,
    })
}

fn surface_agent_chat_approval_hydration_failure(
    tx: &UnboundedSender<Event>,
    chat_id: &str,
    error: &impl std::fmt::Display,
) {
    let _ = tx.send(Event::Error(format!(
        "native agent chat approval hydration ({chat_id}): {error}"
    )));
}

/// Startup and pot switches must land in a writable conversation. Legacy and
/// unclassified chats stay in the history picker, but are not the chat front
/// door. A canonical live binding takes precedence over an old policy stamp.
///
/// pui-chat-first-ux P-009 / D-008: quitting a PUI ends its engine, so the chat
/// it left normally reads `EndedArchived`. When no live chat qualifies, the most
/// recent ended chat that can resume from its native transcript is the default,
/// and the inventory adoption arm resumes it. A live chat always outranks an
/// ended one; a failed/orphaned runtime, or an ended one with no native session
/// id, is history only.
fn default_operator_chat<'a>(
    summaries: &'a [agent_chats::AgentChatSummary],
    inventory: &[crate::su_session::SuSessionInventoryEntry],
    launch_cwd: Option<&str>,
) -> Option<&'a agent_chats::AgentChatSummary> {
    // 2 = live (or an SU chat with no inventory row), 1 = resumable ended.
    let rank = |chat: &agent_chats::AgentChatSummary| -> Option<u8> {
        if chat.role != "operator" || chat.feature_id.is_some() || chat.archived_at.is_some() {
            return None;
        }
        if let Some(session) = inventory
            .iter()
            .find(|entry| entry.agent_chat_id == chat.id)
        {
            // pui-chat-first-ux P-010: never reattach a session that was
            // started in ANOTHER directory — `pui` in project A must not
            // pick up project B's running session. A session whose
            // directory is unknown stays eligible (older operators).
            if let (Some(launch), Some(session_cwd)) = (launch_cwd, session.cwd.as_deref()) {
                if !crate::su_session::session_in_directory(Some(session_cwd), Some(launch)) {
                    return None;
                }
            }
            return match session.reconciliation {
                crate::su_session::SuSessionReconciliation::Attached if !session.terminal => {
                    Some(2)
                }
                crate::su_session::SuSessionReconciliation::EndedArchived
                    if !session.native_session_id.is_empty() =>
                {
                    Some(1)
                }
                _ => None,
            };
        }
        (crate::su_session::PuiRuntimeClass::parse(chat.su_runtime_class.as_deref())
            == crate::su_session::PuiRuntimeClass::SuSession)
            .then_some(2)
    };
    summaries
        .iter()
        .filter_map(|chat| rank(chat).map(|rank| (rank, chat)))
        .max_by(|(rank_a, a), (rank_b, b)| {
            rank_a
                .cmp(rank_b)
                .then_with(|| a.updated_at.cmp(&b.updated_at))
        })
        .map(|(_, chat)| chat)
}

async fn agent_chat_load(
    harness: String,
    selected_chat_id: Option<String>,
    load_token: u64,
    tx: UnboundedSender<Event>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(client) => client,
        Err(error) => {
            let _ = tx.send(Event::Error(format!("native agent chat: {error}")));
            return;
        }
    };
    let options = agent_chats::AgentChatListOptions {
        // Keep archived chats in the inventory so an ended SU session remains
        // selectable for transcript inspection after a restart.  The default
        // operator selection below still excludes archived rows.
        include_archived: true,
        limit: Some(100),
        ..Default::default()
    };
    let summaries = match client.list_agent_chats(&harness, &options).await {
        Ok(chats) => chats,
        Err(error) => {
            let _ = tx.send(Event::Error(format!("native agent chat: {error}")));
            return;
        }
    };
    // Probe each bounded chat summary against the canonical SU-session route.
    // A 404 means this is a legacy chat; any successful snapshot is retained
    // even when terminal so the picker can inspect it after a restart.
    let inventory = probe_su_session_inventory(&client, &harness, &summaries).await;
    let selected = if let Some(id) = selected_chat_id.as_deref() {
        match summaries.iter().find(|chat| chat.id == id).cloned() {
            Some(chat) => Some(chat),
            None => {
                let _ = tx.send(Event::Error(format!(
                    "native agent chat: selected session {id} is unavailable in pot {harness}"
                )));
                return;
            }
        }
    } else {
        let launch_cwd = crate::su_session::launch_cwd();
        default_operator_chat(&summaries, &inventory, launch_cwd.as_deref()).cloned()
    };
    let _ = tx.send(Event::SuSessionInventory {
        harness: harness.clone(),
        selected_chat_id: selected_chat_id.clone(),
        entries: inventory,
    });
    let Some(summary) = selected else {
        let _ = tx.send(Event::AgentChatLoaded {
            harness,
            chat_id: None,
            role: "operator".to_string(),
            load_token,
            summaries,
            messages: Vec::new(),
            owner_turn_ids: Vec::new(),
            approvals: Vec::new(),
        });
        return;
    };
    match client.get_agent_chat(&harness, &summary.id).await {
        Ok(mut chat) => {
            // Stored order ≠ conversation order for SU chats (owner turns are
            // appended at accept, replies when recorded) — P-007.
            agent_chats::in_time_order(&mut chat.transcript);
            let approvals = match client.list_agent_chat_approvals(&harness, &chat.id).await {
                Ok(pending) => pending
                    .into_iter()
                    .map(|approval| models::PendingApproval {
                        call_id: approval.call_id,
                        tool_name: approval.tool_name,
                    })
                    .collect(),
                Err(error) => {
                    // Keep the transcript usable, but never turn an unreadable
                    // parked-approval set into a confident empty set. The status
                    // error remains visible after the chat itself loads.
                    surface_agent_chat_approval_hydration_failure(&tx, &chat.id, &error);
                    Vec::new()
                }
            };
            let _ = tx.send(Event::AgentChatLoaded {
                harness: harness.clone(),
                chat_id: Some(chat.id.clone()),
                role: chat.role,
                load_token,
                summaries,
                owner_turn_ids: chat
                    .transcript
                    .iter()
                    .filter_map(|turn| {
                        turn.su_command
                            .as_ref()?
                            .get("command")?
                            .get("turnId")?
                            .as_str()
                            .map(str::to_owned)
                    })
                    .collect(),
                messages: chat
                    .transcript
                    .into_iter()
                    .filter_map(native_turn_to_message)
                    .collect(),
                approvals,
            });
            // Existing chat rows may already be bound to a durable SU session.
            // Probe the canonical host by chat id; a 404 simply means this is
            // an older legacy chat and must not be treated as a fallback
            // success for the corrected path.
            if let Ok(snapshot) = client.su_session_snapshot(&harness, &chat.id).await {
                let tx = SuSessionEventSender {
                    tx: tx.clone(),
                    harness: harness.clone(),
                    load_token,
                };
                let identity = snapshot.descriptor.identity.clone();
                let binding = crate::su_session::SuSessionBinding {
                    operation: "attached".into(),
                    backend: identity.backend,
                    adv_session_id: identity.adv_session_id,
                    owner_id: Some(identity.owner_id.clone()),
                    workspace_id: Some(identity.workspace_id.clone()),
                    harness_slug: identity.harness_slug.clone(),
                    plan_slug: None,
                    native_session: None,
                };
                let _ = tx.send(Event::SuSessionOpened(binding.clone()));
                let _ = tx.send(Event::SuSessionSnapshot(snapshot));
                tokio::spawn(stream_su_session_events(
                    client,
                    harness,
                    chat.id,
                    binding,
                    None,
                    tx.clone(),
                ));
            }
        }
        Err(error) => {
            let _ = tx.send(Event::Error(format!("native agent chat resume: {error}")));
        }
    }
}

async fn probe_su_session_inventory(
    client: &OperatorClient,
    harness: &str,
    summaries: &[agent_chats::AgentChatSummary],
) -> Vec<crate::su_session::SuSessionInventoryEntry> {
    // One snapshot request per chat (up to the 100-row list limit). Issued
    // one-at-a-time this held the whole Agent Chat load — and with it the
    // /resume list — for seconds after launch (P-007). Bounded fan-out keeps
    // the operator from taking 100 simultaneous requests.
    const PROBE_CONCURRENCY: usize = 8;
    let limit = std::sync::Arc::new(tokio::sync::Semaphore::new(PROBE_CONCURRENCY));
    let mut probes = tokio::task::JoinSet::new();
    for summary in summaries {
        let client = client.clone();
        let harness = harness.to_string();
        let chat_id = summary.id.clone();
        let limit = limit.clone();
        probes.spawn(async move {
            let _permit = limit.acquire_owned().await.ok()?;
            client
                .su_session_snapshot(&harness, &chat_id)
                .await
                .ok()
                .map(|snapshot| {
                    crate::su_session::SuSessionInventoryEntry::from_snapshot(&snapshot)
                })
        });
    }
    let mut entries = Vec::new();
    while let Some(joined) = probes.join_next().await {
        if let Ok(Some(entry)) = joined {
            entries.push(entry);
        }
    }
    entries.sort_by_key(|entry| entry.adv_session_id);
    entries
}

/// Open one PUI SU session and attach its canonical stream.  The first owner
/// turn is held until the stream's identity snapshot arrives, which gives us a
/// complete target identity (including native session id) and prevents a
/// create/attach race from dispatching to the wrong runtime.
#[derive(Clone)]
struct SuSessionEventSender {
    tx: UnboundedSender<Event>,
    harness: String,
    load_token: u64,
}

impl SuSessionEventSender {
    fn send(&self, event: Event) -> Result<(), Box<tokio::sync::mpsc::error::SendError<Event>>> {
        self.tx
            .send(Event::SuSessionAsync {
                harness: self.harness.clone(),
                load_token: self.load_token,
                event: Box::new(event),
            })
            .map_err(Box::new)
    }
}

async fn open_su_session_task(
    harness: String,
    role: String,
    backend: crate::su_session::SuSessionBackend,
    carry: String,
    launch: crate::su_session::SuSessionLaunchOptions,
    (initial_turn, existing_chat): (Option<crate::app::PendingSuTurn>, Option<String>),
    tx: SuSessionEventSender,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(client) => client,
        Err(error) => {
            let _ = tx.send(Event::SuSessionError(format!("open SU session: {error}")));
            return;
        }
    };
    let chat_id = if let Some(chat_id) = existing_chat {
        chat_id
    } else {
        match client
            .create_agent_chat(
                &harness,
                &crate::agent_chats::NewAgentChat {
                    role,
                    feature_id: launch.feature_id.clone(),
                    title: Some(crate::su_session::conversation_title(
                        initial_turn.as_ref().map(|turn| turn.draft.as_str()),
                    )),
                },
            )
            .await
        {
            Ok(chat) => chat.id,
            Err(error) => {
                let _ = tx.send(Event::SuSessionError(format!(
                    "create SU agent chat: {error}"
                )));
                return;
            }
        }
    };
    let _ = tx.send(Event::AgentChatBound(chat_id.clone()));
    let request = crate::su_session::SuSessionOpenRequest::Create(
        crate::su_session::SuSessionCreateRequest {
            agent: backend,
            harness_slug: Some(harness.clone()),
            plan_slug: launch.plan_slug,
            fleet: launch.fleet,
            seat: launch.seat,
            model: launch.model,
            effort: launch.effort,
            account: launch.account,
            mode: launch.mode,
            kickoff: launch.kickoff,
            kickoff_prompt: launch.kickoff_prompt,
            carry,
            attached_engine: true,
            agent_chat_id: chat_id.clone(),
            cwd: crate::su_session::launch_cwd(),
        },
    );
    let binding = match client.open_su_session(&request).await {
        Ok(binding) => binding,
        Err(error) => {
            let _ = tx.send(su_open_failure(&error));
            return;
        }
    };
    let _ = tx.send(Event::SuSessionOpened(binding.clone()));
    stream_su_session_events(client, harness, chat_id, binding, initial_turn, tx).await;
}

/// A refusal the operator answered with keeps its reason (WI-10004158); any
/// other open failure is a transport or protocol error.
fn su_open_failure(error: &anyhow::Error) -> Event {
    match error.downcast_ref::<crate::client::SuLaunchRefused>() {
        Some(refused) => Event::SuSessionRefused {
            code: refused.code.clone(),
            message: refused.message.clone(),
        },
        None => Event::SuSessionError(format!("{error:#}")),
    }
}

async fn attach_su_session_task(
    harness: String,
    chat_id: String,
    adv_session_id: i64,
    backend: crate::su_session::SuSessionBackend,
    tx: SuSessionEventSender,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(client) => client,
        Err(error) => {
            let _ = tx.send(Event::SuSessionError(format!("attach SU session: {error}")));
            return;
        }
    };
    let request = crate::su_session::SuSessionOpenRequest::Attach(
        crate::su_session::SuSessionAttachRequest {
            agent: backend,
            attach_adv_session_id: adv_session_id,
            harness_slug: Some(harness.clone()),
            plan_slug: None,
        },
    );
    let binding = match client.open_su_session(&request).await {
        Ok(binding) => binding,
        Err(error) => {
            let _ = tx.send(su_open_failure(&error));
            return;
        }
    };
    let _ = tx.send(Event::AgentChatBound(chat_id.clone()));
    let _ = tx.send(Event::SuSessionOpened(binding.clone()));
    stream_su_session_events(client, harness, chat_id, binding, None, tx).await;
}

/// Read a fresh snapshot (published to the UI), then subscribe to the chat's
/// SU-session event stream, retrying briefly while its host starts or is
/// re-created. The snapshot is read BEFORE subscribing so events above its head
/// are new. Returns the stream, the last snapshot read and the last error.
async fn open_su_event_stream(
    client: &OperatorClient,
    harness: &str,
    chat_id: &str,
    tx: &SuSessionEventSender,
) -> (
    Option<crate::su_session::SuSessionEventStream>,
    Option<crate::su_session::SuSessionSnapshot>,
    Option<String>,
) {
    let mut last_error = None;
    let mut snapshot = None;
    for _ in 0..15 {
        match client.su_session_snapshot(harness, chat_id).await {
            Ok(next) => {
                snapshot = Some(next.clone());
                let _ = tx.send(Event::SuSessionSnapshot(next));
            }
            Err(error) => last_error = Some(error.to_string()),
        }
        match client.subscribe_su_session(harness, chat_id).await {
            Ok(stream) => return (Some(stream), snapshot, last_error),
            Err(error) => {
                last_error = Some(error.to_string());
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
    (None, snapshot, last_error)
}

async fn stream_su_session_events(
    client: OperatorClient,
    harness: String,
    chat_id: String,
    binding: crate::su_session::SuSessionBinding,
    mut initial_turn: Option<crate::app::PendingSuTurn>,
    tx: SuSessionEventSender,
) {
    // Readiness is an executor/stream property, not the mere existence of a
    // descriptor. Bound retries also cover a reconnect during host startup.
    let (stream, startup_snapshot, last_error) =
        open_su_event_stream(&client, &harness, &chat_id, &tx).await;
    let Some(mut stream) = stream else {
        let message = last_error.unwrap_or_else(|| {
            format!(
                "SU-session host is not attached (adv {})",
                binding.adv_session_id
            )
        });
        let _ = tx.send(Event::SuSessionStreamError {
            chat_id: chat_id.clone(),
            message,
        });
        return;
    };

    // The host can become ready between launch-su returning and this stream
    // subscription opening. In that ordering the ready event is already in the
    // snapshot and there may be no later lifecycle transition to wake the
    // event-driven first-turn path below. Use the snapshot we already read,
    // after the stream is attached, and keep the authoritative re-read inside
    // send_su_turn_with_client as the final dispatch gate.
    if let (Some(snapshot), Some(pending)) = (startup_snapshot.as_ref(), initial_turn.as_ref()) {
        let identity_matches =
            su_turn_target_matches(&binding, &snapshot.descriptor.identity, &harness, &chat_id);
        if startup_snapshot_can_send_initial_turn(&binding, snapshot, &harness, &chat_id) {
            let pending = initial_turn.take().expect("checked pending first turn");
            send_su_turn_with_client(&client, &harness, &chat_id, &binding, pending, &tx).await;
        } else if !identity_matches {
            let command_id = pending.command_id.clone();
            initial_turn = None;
            let _ = tx.send(Event::SuTurnFailed {
                command_id,
                message: "Session executor/stream is not ready for this project. Draft retained; reconnect to retry.".into(),
                uncertain: false,
            });
        }
    }

    // A terminal snapshot has no failure reason. Keep the pending draft until
    // its replay supplies the error/lifecycle reason (or the stream closes).
    // Pin terminality now so an older replayed ready event cannot send it.
    let mut terminal_seen = startup_snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot.terminal);
    let startup_terminal = terminal_seen;
    // Events at or below the snapshot head are the retained window replaying,
    // and the snapshot above already judged that state. A replayed ready cannot
    // send, and a replayed failure cannot fail: a reconnect after an engine
    // death replays that death while the recovered runtime is starting. History
    // may only supply the reason for a snapshot that is itself terminal.
    let mut replay_head = startup_snapshot
        .as_ref()
        .map_or(0, |snapshot| snapshot.last_sequence);
    let mut startup_error: Option<String> = None;
    // The host may spend 45 seconds initializing its engine and SU MCP. Keep
    // the draft pending across its starting descriptor and await a ready event.
    let mut startup_deadline = tokio::time::Instant::now() + SU_STARTUP_BUDGET;
    // P-002 (WI-10003622): a RESTORED host with no executor never emits ready
    // by itself — its engine died with the host process that spawned it (a
    // recycle/restart), or lives in another process of a clustered operator.
    // Waiting for ready there was the 60s "Session did not become ready"
    // failure. Resume it through the exact-resume attach path at most once,
    // and re-poll the snapshot while waiting so a host that dies mid-startup
    // is noticed within seconds instead of at the deadline.
    let mut resume_requested = false;
    let mut stream_reopens = 0u32;
    if initial_turn.is_some() {
        if let Some(detached) = startup_snapshot.as_ref().and_then(detached_runtime) {
            match recover_detached_runtime(
                &client,
                &harness,
                &binding,
                detached,
                &mut resume_requested,
            )
            .await
            {
                Some(message) => {
                    let pending = initial_turn.take().expect("checked pending first turn");
                    let _ = tx.send(Event::SuTurnFailed {
                        command_id: pending.command_id,
                        message,
                        uncertain: false,
                    });
                }
                None => startup_deadline = tokio::time::Instant::now() + SU_STARTUP_BUDGET,
            }
        }
    }
    let mut detach_poll =
        tokio::time::interval_at(tokio::time::Instant::now() + SU_DETACH_POLL, SU_DETACH_POLL);
    loop {
        let next = if initial_turn.is_some() {
            tokio::select! {
                next = stream.recv() => next,
                _ = tokio::time::sleep_until(startup_deadline) => {
                    let _ = tx.send(Event::SuSessionStreamError {
                        chat_id: chat_id.clone(),
                        message:
                            "Session did not become ready. Draft retained; reconnect to retry."
                                .into(),
                    });
                    return;
                }
                _ = detach_poll.tick() => {
                    let Ok(snapshot) = client.su_session_snapshot(&harness, &chat_id).await else {
                        continue;
                    };
                    if startup_snapshot_can_send_initial_turn(&binding, &snapshot, &harness, &chat_id) {
                        // The host is ready but this stream never said so, so
                        // it is attached to a host that no longer serves the
                        // chat (a resumed engine lives on a re-created host).
                        // Re-open it first so the reply is observed, then send;
                        // the send path re-reads readiness before dispatching.
                        let (reopened, fresh, _) =
                            open_su_event_stream(&client, &harness, &chat_id, &tx).await;
                        if let Some(reopened) = reopened {
                            stream = reopened;
                            replay_head = fresh.map_or(snapshot.last_sequence, |fresh| fresh.last_sequence);
                        }
                        let pending = initial_turn.take().expect("checked pending first turn");
                        send_su_turn_with_client(&client, &harness, &chat_id, &binding, pending, &tx)
                            .await;
                        continue;
                    }
                    let detached = if resume_requested { None } else { detached_runtime(&snapshot) };
                    if let Some(detached) = detached {
                        match recover_detached_runtime(
                            &client, &harness, &binding, detached, &mut resume_requested,
                        )
                        .await
                        {
                            Some(message) => {
                                let pending =
                                    initial_turn.take().expect("checked pending first turn");
                                let _ = tx.send(Event::SuTurnFailed {
                                    command_id: pending.command_id,
                                    message,
                                    uncertain: false,
                                });
                            }
                            None => {
                                startup_deadline = tokio::time::Instant::now() + SU_STARTUP_BUDGET
                            }
                        }
                    }
                    continue;
                }
            }
        } else {
            stream.recv().await
        };
        let Some(next) = next else { break };
        let event = match next {
            Ok(event) => event,
            Err(error) => {
                // A stream that closes under a pending first turn with no
                // terminal event lost its HOST (the process serving it died or
                // the host was re-created), not its session. Re-open it against
                // whatever host now serves the chat and keep the draft pending;
                // the snapshot poll above then resumes or sends as needed.
                if initial_turn.is_some()
                    && !terminal_seen
                    && stream_reopens < SU_STREAM_REOPENS
                    && tokio::time::Instant::now() < startup_deadline
                {
                    stream_reopens += 1;
                    let (reopened, fresh, _) =
                        open_su_event_stream(&client, &harness, &chat_id, &tx).await;
                    if let Some(reopened) = reopened {
                        stream = reopened;
                        if let Some(fresh) = fresh {
                            replay_head = fresh.last_sequence;
                        }
                        continue;
                    }
                }
                if !terminal_seen || initial_turn.is_some() {
                    let _ = tx.send(Event::SuSessionStreamError {
                        chat_id: chat_id.clone(),
                        message: error.to_string(),
                    });
                }
                return;
            }
        };
        let lifecycle = match &event {
            crate::su_session::SuSessionEvent::Session { descriptor, .. } => {
                Some(descriptor.lifecycle)
            }
            crate::su_session::SuSessionEvent::Lifecycle { state, .. } => Some(*state),
            _ => None,
        };
        let replayed = event.envelope().sequence <= replay_head;
        terminal_seen |= !replayed
            && matches!(
                lifecycle,
                Some(
                    crate::su_session::SuSessionLifecycleState::Ended
                        | crate::su_session::SuSessionLifecycleState::Failed
                )
            );
        let can_send = !replayed
            && matches!(
                lifecycle,
                Some(
                    crate::su_session::SuSessionLifecycleState::Ready
                        | crate::su_session::SuSessionLifecycleState::Running
                )
            );
        let identity_matches = replayed
            || su_turn_target_matches(&binding, &event.envelope().session, &harness, &chat_id);
        if identity_matches && (!replayed || startup_terminal) {
            match &event {
                crate::su_session::SuSessionEvent::Error { message, .. } => {
                    startup_error = Some(message.clone());
                }
                crate::su_session::SuSessionEvent::Lifecycle {
                    state: crate::su_session::SuSessionLifecycleState::Failed,
                    reason: Some(reason),
                    ..
                } if startup_error.is_none() => startup_error = Some(reason.clone()),
                _ => {}
            }
        }
        let _ = tx.send(Event::SuSessionEvent(event));
        if initial_turn.is_some()
            && ((!terminal_seen && can_send)
                || (terminal_seen && startup_error.is_some())
                || !identity_matches)
        {
            let pending = initial_turn.take().expect("checked pending first turn");
            if terminal_seen || !identity_matches {
                let message = if identity_matches { startup_error.take() } else { None }
                    .unwrap_or_else(|| "Session executor/stream is not ready for this project. Draft retained; reconnect to retry.".into());
                let _ = tx.send(Event::SuTurnFailed {
                    command_id: pending.command_id,
                    message,
                    uncertain: false,
                });
            } else {
                // Re-read the authoritative snapshot in the send path: a
                // replayed ready event alone cannot authorize this first turn.
                send_su_turn_with_client(&client, &harness, &chat_id, &binding, pending, &tx).await;
            }
        }
    }
    if let Some(pending) = initial_turn.take() {
        let _ = tx.send(Event::SuTurnFailed {
            command_id: pending.command_id,
            message: startup_error.unwrap_or_else(|| {
                "Session ended before becoming ready. Draft retained; reconnect to retry.".into()
            }),
            uncertain: false,
        });
    } else if !terminal_seen {
        let _ = tx.send(Event::SuSessionStreamError {
            chat_id,
            message: "SU-session stream closed".into(),
        });
    }
}

async fn send_su_session_turn_task(
    harness: String,
    chat_id: String,
    binding: crate::su_session::SuSessionBinding,
    pending: crate::app::PendingSuTurn,
    tx: SuSessionEventSender,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(client) => client,
        Err(error) => {
            let _ = tx.send(Event::SuTurnFailed {
                command_id: pending.command_id,
                message: format!("Cannot connect: {error}"),
                uncertain: pending.command.is_some(),
            });
            return;
        }
    };
    send_su_turn_with_client(&client, &harness, &chat_id, &binding, pending, &tx).await;
}

fn su_turn_target_matches(
    binding: &crate::su_session::SuSessionBinding,
    identity: &crate::su_session::SuSessionIdentity,
    harness: &str,
    chat_id: &str,
) -> bool {
    let native_id = binding
        .native_session
        .as_ref()
        .and_then(|handle| match handle {
            models::NativeSessionHandle::Claude { session_id, .. } => session_id.as_deref(),
            models::NativeSessionHandle::Codex { rollout_id, .. } => rollout_id.as_deref(),
            models::NativeSessionHandle::Omp { omp_thread_id, .. } => omp_thread_id.as_deref(),
        });
    identity.adv_session_id == binding.adv_session_id
        && identity.backend == binding.backend
        && identity.agent_chat_id == chat_id
        && identity.harness_slug.as_deref() == Some(harness)
        && binding.owner_id.as_deref() == Some(identity.owner_id.as_str())
        && binding.workspace_id.as_deref() == Some(identity.workspace_id.as_str())
        && native_id.is_none_or(|expected| expected == identity.native_session_id)
}

fn startup_snapshot_can_send_initial_turn(
    binding: &crate::su_session::SuSessionBinding,
    snapshot: &crate::su_session::SuSessionSnapshot,
    harness: &str,
    chat_id: &str,
) -> bool {
    snapshot.executor_attached
        && snapshot.stream_ready
        && !snapshot.terminal
        && su_turn_target_matches(binding, &snapshot.descriptor.identity, harness, chat_id)
}

/// How long a pending first turn waits for a ready event, restarted when an
/// automatic resume is requested (exact resume re-initializes the engine).
const SU_STARTUP_BUDGET: Duration = Duration::from_secs(60);
/// How often a pending first turn re-reads the snapshot for a lost runtime.
const SU_DETACH_POLL: Duration = Duration::from_secs(3);
/// How many times a pending first turn re-opens a closed event stream.
const SU_STREAM_REOPENS: u32 = 5;

/// A restored host whose engine is not attached to it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum DetachedRuntime {
    /// The native identity survives: exact resume can re-attach an engine.
    Resumable,
    /// Nothing resumable remains (the reason is the host's reconciliation).
    Unrecoverable(String),
}

/// Classify a snapshot as a detached runtime. Only a RESTORED host carries a
/// `runtimeReconciliation`; a freshly launched one does not. `wait` (liveness
/// unknown) keeps waiting.
///
/// `runtime_replacement` carries two meanings, told apart by `stalePid`
/// (su-session-persistence.ts `classifySuSessionRuntime` vs su-session-host.ts
/// `attachRuntime`): with `stalePid: true` the recorded engine is DEAD but its
/// native identity survives, which is exactly the case that needs an exact
/// resume; with `stalePid: false` a replacement engine is already being
/// attached, so a second resume would race it.
fn detached_runtime(snapshot: &crate::su_session::SuSessionSnapshot) -> Option<DetachedRuntime> {
    if snapshot.terminal || snapshot.executor_attached {
        return None;
    }
    let reconciliation = snapshot.runtime_reconciliation.as_ref()?;
    match reconciliation.action {
        crate::su_session::SuSessionRuntimeAction::Reattach
            if reconciliation.reason != "runtime_replacement" || reconciliation.stale_pid =>
        {
            Some(DetachedRuntime::Resumable)
        }
        crate::su_session::SuSessionRuntimeAction::Relaunch => Some(
            DetachedRuntime::Unrecoverable(reconciliation.reason.clone()),
        ),
        _ => None,
    }
}

/// Act on a detached runtime for a pending first turn. Returns the message
/// the pending turn must fail with, or `None` when an exact resume was
/// requested and the caller should keep waiting for its ready event.
async fn recover_detached_runtime(
    client: &OperatorClient,
    harness: &str,
    binding: &crate::su_session::SuSessionBinding,
    detached: DetachedRuntime,
    resume_requested: &mut bool,
) -> Option<String> {
    match detached {
        DetachedRuntime::Unrecoverable(reason) => Some(format!(
            "This session's agent runtime is gone and cannot be resumed ({reason}). Draft retained; start a new session to send it."
        )),
        DetachedRuntime::Resumable => {
            *resume_requested = true;
            let request = crate::su_session::SuSessionOpenRequest::Attach(
                crate::su_session::SuSessionAttachRequest {
                    agent: binding.backend,
                    attach_adv_session_id: binding.adv_session_id,
                    harness_slug: Some(harness.to_string()),
                    plan_slug: binding.plan_slug.clone(),
                },
            );
            match client.open_su_session(&request).await {
                Ok(_) => None,
                Err(error) => Some(format!(
                    "Resuming this session's agent runtime failed: {error:#}. Draft retained; reconnect to retry."
                )),
            }
        }
    }
}

/// One acceptance POST's budget, and how many times the SAME command is
/// re-checked before the turn is reported uncertain (~2 min in total).
const SU_TURN_ACCEPT_ATTEMPT: Duration = Duration::from_secs(30);
const SU_TURN_ACCEPT_ATTEMPTS: u32 = 4;

async fn send_su_turn_with_client(
    client: &OperatorClient,
    harness: &str,
    chat_id: &str,
    binding: &crate::su_session::SuSessionBinding,
    pending: crate::app::PendingSuTurn,
    tx: &SuSessionEventSender,
) {
    let fail = |message: String, uncertain| {
        let _ = tx.send(Event::SuTurnFailed {
            command_id: pending.command_id.clone(),
            message,
            uncertain,
        });
    };
    let command = if let Some(command) = pending.command.clone() {
        command // Retry the exact committed payload, including its original timestamp.
    } else {
        let snapshot = match client.su_session_snapshot(harness, chat_id).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                fail(format!("Cannot read session readiness: {error}"), false);
                return;
            }
        };
        // A connected engine remains usable while waiting for its next owner
        // turn or after interruption; readiness is separate from that lifecycle.
        if !snapshot.executor_attached || !snapshot.stream_ready || snapshot.terminal {
            fail(
                "Session is not ready. Draft retained; reconnect to retry.".into(),
                false,
            );
            return;
        }
        let identity = snapshot.descriptor.identity;
        if !su_turn_target_matches(binding, &identity, harness, chat_id) {
            fail(
                "Session identity changed. Draft retained; reattach before sending.".into(),
                false,
            );
            return;
        }
        serde_json::json!({
            "schema": crate::su_session::SU_SESSION_SCHEMA,
            "protocolVersion": crate::su_session::SU_SESSION_PROTOCOL_VERSION,
            "type": "owner_turn",
            "commandId": pending.command_id,
            "issuedAt": chrono_like_now(),
            "target": identity,
            "turnId": format!("pui-turn-{}", pending.command_id),
            "content": pending.content,
        })
    };
    let identity: crate::su_session::SuSessionIdentity =
        match serde_json::from_value(command["target"].clone()) {
            Ok(identity) if su_turn_target_matches(binding, &identity, harness, chat_id) => {
                identity
            }
            _ => {
                fail(
                    "Retained turn belongs to a different session; reconnect that session first."
                        .into(),
                    false,
                );
                return;
            }
        };
    let _ = tx.send(Event::SuTurnPrepared {
        command_id: pending.command_id.clone(),
        command: command.clone(),
    });
    // An acceptance that outlives one attempt is RE-CHECKED with the SAME
    // command (same commandId and payload), never re-minted: the host replays
    // a known commandId instead of executing it again. Without this, a slow
    // durable reserve left the turn "uncertain" until the owner happened to
    // press Enter (EI-24375699124551107).
    let mut attempt = 1;
    let outcome = loop {
        let result = tokio::time::timeout(
            SU_TURN_ACCEPT_ATTEMPT,
            client.send_su_session_command(harness, chat_id, command.clone()),
        )
        .await;
        if result.is_err() && attempt < SU_TURN_ACCEPT_ATTEMPTS {
            attempt += 1;
            continue;
        }
        break result;
    };
    match outcome {
        Ok(Ok(response)) => {
            let ack = &response["accepted"];
            if response["ok"] == true
                && ack["status"] == "accepted"
                && ack["commandId"] == pending.command_id
                && ack["session"] == serde_json::to_value(&identity).unwrap_or_default()
            {
                let replay_snapshot = if response["replayed"] == true {
                    match tokio::time::timeout(
                        Duration::from_secs(30),
                        client.su_session_snapshot(harness, chat_id),
                    )
                    .await
                    {
                        Ok(Ok(snapshot)) if snapshot.descriptor.identity == identity => {
                            Some(Box::new(snapshot))
                        }
                        _ => {
                            fail("Saved acknowledgement found, but the current session could not be reconciled. Draft retained; Enter checks again.".into(), true);
                            return;
                        }
                    }
                } else {
                    None
                };
                let _ = tx.send(Event::SuTurnAcknowledged {
                    command_id: pending.command_id,
                    session: identity,
                    replay_snapshot,
                });
            } else {
                fail("No matching acceptance acknowledgement. Draft retained; Enter checks the same turn.".into(), true);
            }
        }
        Ok(Err(error)) => {
            let status = error
                .chain()
                .find_map(|cause| cause.downcast_ref::<crate::http::HttpStatusError>());
            let body = status
                .and_then(|status| serde_json::from_str::<serde_json::Value>(&status.body).ok());
            let terminal = body.as_ref().map(|body| &body["terminal"]);
            let refused = terminal.is_some_and(|t| {
                t["status"] == "refused"
                    && t["commandId"] == pending.command_id
                    && t["session"] == serde_json::to_value(&identity).unwrap_or_default()
                    && t["refusal"]["code"] != "command_delivery_unknown"
            });
            let rejected_before_dispatch =
                status.is_some_and(|s| matches!(s.status, 400 | 401 | 403 | 404 | 422));
            fail(
                format!("Turn was not confirmed: {error}"),
                !(refused || rejected_before_dispatch),
            );
        }
        Err(_) => fail(
            "Acceptance timed out. Draft retained; Enter checks the same turn.".into(),
            true,
        ),
    }
}

async fn send_su_session_command_task(
    harness: String,
    chat_id: String,
    command: serde_json::Value,
    tx: SuSessionEventSender,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(client) => client,
        Err(error) => {
            let _ = tx.send(Event::SuSessionError(format!(
                "SU-session control: {error}"
            )));
            return;
        }
    };
    match client
        .send_su_session_command(&harness, &chat_id, command)
        .await
    {
        Ok(response) => {
            let status = response
                .get("accepted")
                .and_then(|accepted| accepted.get("status"))
                .and_then(|status| status.as_str())
                .unwrap_or_else(|| {
                    if response.get("ok").and_then(|ok| ok.as_bool()) == Some(true) {
                        "accepted"
                    } else {
                        "refused"
                    }
                });
            let _ = tx.send(Event::SuSessionCommandResult(status.to_string()));
        }
        Err(error) => {
            let _ = tx.send(Event::SuSessionError(format!(
                "SU-session control: {error}"
            )));
        }
    }
}

fn chrono_like_now() -> String {
    // Avoid pulling a time crate into the standalone TUI; RFC3339 precision is
    // not semantically significant to command idempotency.
    format!("{}Z", unix_epoch_seconds())
}

fn unix_epoch_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn command_nonce() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Run one operator chat turn (tui-operator-surface P1). Persists the user turn,
/// opens the converse SSE stream over the active transport, relays
/// `delta`/`tool_call`/`done`/`error` as chat events, then persists the
/// finalized assistant turn — exactly the path the desktop operator uses, over
/// the shared `operator` role. `history` is the transcript to send (already
/// includes the just-sent user message).
///
/// When `speak` is `Some(player)` (a voice PTT turn — voice-mode-tui-port P2),
/// the finalized reply is also synthesized via the operator TTS proxy and played
/// through `player`, and the turn's voice phase transitions (Speaking → Finished)
/// ride `Event::Voice`.
/// POST one HITL decision for the native agent-chat seam (P-005 slice 2). The
/// route is PG-backed, so the decision lands even when it reaches a different
/// operator worker than the one streaming the turn. On success the loop resumes
/// on its own — this only has to unblock it.
async fn resolve_agent_chat_approval_send(
    harness: String,
    chat_id: String,
    call_id: String,
    approved: bool,
    tx: UnboundedSender<Event>,
) {
    use crate::agent_chats::AgentChatApprovalDecision;

    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("approval: {e}")));
            return;
        }
    };
    let decision = AgentChatApprovalDecision {
        approved,
        reason: None,
    };
    match client
        .resolve_agent_chat_approval(&harness, &chat_id, &call_id, &decision)
        .await
    {
        // The loop ALSO emits `approval_resolved` on the open stream and the
        // reducer arm is idempotent, so echoing the decision here is safe — it
        // clears the prompt immediately instead of waiting on the next frame.
        Ok(()) => {
            let _ = tx.send(Event::AgentChatApprovalResolved { call_id, approved });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("approval: {e}")));
        }
    }
}

/// Apply one Context-pane task action through the agent-chat task route. The
/// response carries the same typed projection the subscription invalidation
/// refreshes for sibling renderers, so the initiating pui pane updates without
/// waiting for a second round trip.
async fn mutate_agent_chat_task_send(
    harness: String,
    chat_id: String,
    mutation: agent_chats::AgentChatTaskMutation,
    tx: UnboundedSender<Event>,
) {
    let target = models::ConversationContextProjectionTarget::new(
        "agent_chat",
        chat_id.clone(),
        Some(harness.clone()),
    );
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .mutate_agent_chat_task(&harness, &chat_id, &mutation)
            .await
            .map(|response| response.projection)
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let _ = tx.send(Event::AgentChatTaskMutationFinished { target, result });
}

async fn converse_send(
    text: String,
    mut conversation_id: Option<String>,
    history: Vec<(String, String)>,
    owner: String,
    speak: Option<voice::Player>,
    tx: UnboundedSender<Event>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::ChatError(format!("{e}")));
            return;
        }
    };

    // Ensure a conversation id so turns persist (the startup load usually set it;
    // this covers a send that races ahead of the load).
    if conversation_id.is_none() {
        if let Ok(load) = client.load_conversation(1).await {
            conversation_id = Some(load.conversation.id);
        }
    }

    // Persist the user turn (best-effort — the converse stream is transient).
    if let Some(id) = &conversation_id {
        let _ = client.append_turn(id, "user", &text, &[], None).await;
    }

    // Build the converse payload: full transcript + the TUI surface marker so the
    // operator injects the pui affordances (D-003) and skips card tools.
    let messages: Vec<serde_json::Value> = history
        .iter()
        .map(|(role, content)| serde_json::json!({ "role": role, "content": content }))
        .collect();
    let mut body = serde_json::json!({
        "messages": messages,
        "trigger": "user_message",
        "modality": "text",
        "mayAskActive": false,
        "surface": "tui",
        "uiClientId": owner,
    });
    if let Some(id) = &conversation_id {
        body["conversationId"] = serde_json::Value::String(id.clone());
    }

    let mut sub = match client.subscribe_converse(body).await {
        Ok(rx) => rx,
        Err(e) => {
            let _ = tx.send(Event::ChatError(format!("{e}")));
            return;
        }
    };

    let mut raw = String::new();
    let mut tools: Vec<serde_json::Value> = Vec::new();
    while let Some(fr) = sub.recv().await {
        match fr.event.as_str() {
            "delta" => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&fr.data) {
                    if let Some(t) = v.get("text").and_then(|x| x.as_str()) {
                        raw.push_str(t);
                        let _ = tx.send(Event::ChatDelta(t.to_string()));
                    }
                }
            }
            "tool_call" => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&fr.data) {
                    if let Some(name) = v.get("name").and_then(|x| x.as_str()) {
                        tools.push(serde_json::json!({
                            "name": name,
                            "input": v.get("input").cloned().unwrap_or(serde_json::Value::Null),
                        }));
                        let _ = tx.send(Event::ChatToolCall(models::ChatToolCall::plain(
                            name.to_string(),
                        )));
                    }
                }
            }
            "error" => {
                let msg = serde_json::from_str::<serde_json::Value>(&fr.data)
                    .ok()
                    .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
                    .unwrap_or_else(|| "operator error".to_string());
                let _ = tx.send(Event::ChatError(msg));
                return;
            }
            "done" => break,
            _ => {} // heartbeat etc.
        }
    }

    // Finalize: resolve the buffered tag-document to the user-visible say text,
    // tell the pane the turn is done, and persist the assistant turn. The
    // `<report>` payload (if any) is parsed from the raw turn + persisted
    // alongside (the pane sets it on the in-flight bubble via finish_chat_turn).
    let final_text = chat_tags::finalize(&raw);
    let report_val = chat_tags::extract_report(&raw).and_then(|r| serde_json::to_value(r).ok());
    let _ = tx.send(Event::ChatDone);
    if let Some(id) = &conversation_id {
        if !final_text.trim().is_empty() || !tools.is_empty() || report_val.is_some() {
            let _ = client
                .append_turn(id, "assistant", &final_text, &tools, report_val.as_ref())
                .await;
        }
    }

    // Voice PTT turn (P2): speak the finalized reply. Synthesis goes through the
    // operator TTS proxy (engine/voice from voice-prefs server-side) and plays
    // through the run loop's long-lived player. An empty reply just ends the turn.
    if let Some(player) = speak {
        if final_text.trim().is_empty() {
            let _ = tx.send(Event::Voice(event::VoiceMsg::Finished));
        } else {
            let _ = tx.send(Event::Voice(event::VoiceMsg::Speaking));
            match client.tts_speak(&final_text).await {
                Ok(audio) => player.play(audio),
                Err(e) => {
                    let _ = tx.send(Event::Voice(event::VoiceMsg::Error(format!("tts: {e}"))));
                    return;
                }
            }
            // Playback is fire-and-forget on the player thread; the turn is
            // logically done (the meter/phase return to idle now).
            let _ = tx.send(Event::Voice(event::VoiceMsg::Finished));
        }
    }
}

/// One voice PTT turn (voice-mode-tui-port-2026-06-05 P2): finish the mic
/// capture, transcribe it via the operator STT proxy, inject the recognized text
/// as the user's turn, then run the operator converse turn + speak the reply
/// (reusing `converse_send`). Each step's failure surfaces as `Event::Voice(Error)`
/// (which the reducer resets the phase on); a too-short / empty capture ends
/// quietly. The mic `CaptureSession` arrives from the run loop, which owns it.
async fn voice_turn(
    session: voice::CaptureSession,
    conversation_id: Option<String>,
    mut history: Vec<(String, String)>,
    owner: String,
    player: voice::Player,
    tx: UnboundedSender<Event>,
) {
    // 1. Stop recording + encode (blocking DSP + device close) off the runtime.
    let cap = match tokio::task::spawn_blocking(move || session.finish()).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => {
            let _ = tx.send(Event::Voice(event::VoiceMsg::Error(format!(
                "capture: {e}"
            ))));
            return;
        }
        Err(e) => {
            let _ = tx.send(Event::Voice(event::VoiceMsg::Error(format!(
                "capture join: {e}"
            ))));
            return;
        }
    };
    if cap.seconds < 0.3 {
        let _ = tx.send(Event::Voice(event::VoiceMsg::Error(
            "recording too short".into(),
        )));
        return;
    }

    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Voice(event::VoiceMsg::Error(format!("{e}"))));
            return;
        }
    };

    // 2. Transcribe.
    let text = match client.stt_transcribe(&cap.wav).await {
        Ok(t) => t,
        Err(e) => {
            let _ = tx.send(Event::Voice(event::VoiceMsg::Error(format!("stt: {e}"))));
            return;
        }
    };
    if text.trim().is_empty() {
        let _ = tx.send(Event::Voice(event::VoiceMsg::Error(
            "didn't catch that".into(),
        )));
        return;
    }

    // 3. Inject the recognized utterance as the user's turn (the reducer runs
    //    begin_user_send + flips the phase to Thinking) — and append it to the
    //    converse history so the model sees it (mirrors the typed-send path).
    let _ = tx.send(Event::Voice(event::VoiceMsg::Transcribed(text.clone())));
    history.push(("user".to_string(), text.clone()));

    // 4. Run the operator turn over the shared converse path + speak the reply.
    converse_send(text, conversation_id, history, owner, Some(player), tx).await;
}

/// Subscribe to this pui's agent-intent SSE stream (P12b / D-002 A6 —
/// tui:dispatch) and forward each intent as `Event::TuiIntent` (applied in the
/// reducer). Long-lived; resubscribes if the stream drops. A missing backend
/// ends the task quietly.
async fn tui_intent_loop(tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(_) => return,
    };
    let owner = workbench::workbench_owner();
    loop {
        if tx.is_closed() {
            return;
        }
        let mut sub = match client.subscribe_intents(&owner).await {
            Ok(rx) => rx,
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        while let Some(fr) = sub.recv().await {
            if fr.event != "message" {
                continue; // heartbeat etc.
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&fr.data) {
                let id = v.get("id").and_then(|x| x.as_i64());
                let intent = v.get("intent").and_then(|x| x.as_str()).map(String::from);
                if let (Some(id), Some(intent)) = (id, intent) {
                    let args = v.get("args").cloned().unwrap_or(serde_json::Value::Null);
                    if tx.send(Event::TuiIntent { id, intent, args }).is_err() {
                        return;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// POST applied agent-intent results back to the operator (P12b / tui:dispatch).
async fn intent_result_poster(mut rx: UnboundedReceiver<(i64, String, Option<String>)>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(_) => return,
    };
    while let Some((id, result_json, error)) = rx.recv().await {
        let _ = client
            .post_intent_result(id, &result_json, error.as_deref())
            .await;
    }
}

/// Wire up the push-driven data layer (D-003, no polling). `refetch_loop` fetches
/// everything once on startup, then again whenever the invalidation loop signals
/// (debounced) or the slow safety timer fires. `invalidation_loop` subscribes to
/// `/api/zero-harness/sse` over IPC and pings the refetch loop on each
/// `invalidate`/`update`. They run as two tasks over two IPC connections; the
/// refetch loop is the only thing that touches `active_harness`/`active_doc`.
fn spawn_sync(
    tx: UnboundedSender<Event>,
    active_harness: Arc<Mutex<String>>,
    active_doc: Arc<Mutex<Option<String>>>,
    active_plan: Arc<Mutex<Option<(String, String)>>>,
    network_focus: Option<String>,
    pane: PaneFetchScope,
) -> UnboundedSender<RefetchSignal> {
    // Internal signal channel: invalidation_loop -> refetch_loop. Keep the
    // plans-heavy reads scoped so unrelated high-volume invalidations do not
    // re-pull plans:list on every frame.
    let (sig_tx, sig_rx) = mpsc::unbounded_channel::<RefetchSignal>();
    tokio::spawn(refetch_loop(
        tx.clone(),
        active_harness,
        active_doc,
        active_plan,
        network_focus,
        pane,
        sig_rx,
    ));
    // Coord-inbox push (P-002 / D-003b): a 3rd task on its own SSE stream.
    tokio::spawn(coord_inbox_loop(tx.clone()));
    // Live worker-activity overlay (pui-fleet-status-view-2026-06-04, P1): a 4th
    // task on the /api/activity/stream SSE → Event::ActivityLive.
    tokio::spawn(activity_loop(tx.clone()));
    tokio::spawn(invalidation_loop(tx, sig_tx.clone()));
    sig_tx
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefetchSignal {
    IncludePlanReads,
    SkipPlanReads,
}

/// Keep background reads aligned with the pane the workbench currently shows.
/// Tab entry already fetches Network immediately; this scope governs later
/// invalidations and the safety refresh as the owner navigates away and back.
#[derive(Clone)]
struct PaneFetchScope {
    pinned: Option<app::Tab>,
    selected: Arc<Mutex<app::Tab>>,
}

impl PaneFetchScope {
    fn fetches_network(&self) -> bool {
        self.pinned
            .or_else(|| self.selected.lock().ok().map(|selected| *selected))
            == Some(app::Tab::Network)
    }

    fn fetches_pipeline(&self) -> bool {
        self.pinned
            .or_else(|| self.selected.lock().ok().map(|selected| *selected))
            == Some(app::Tab::Overview)
    }
}

impl RefetchSignal {
    fn include_plan_reads(self) -> bool {
        matches!(self, RefetchSignal::IncludePlanReads)
    }
}

fn sync_payload_fetches_plans(data: &str) -> bool {
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(data) else {
        return true;
    };
    let Some(name) = payload.get("name").and_then(|v| v.as_str()) else {
        return true;
    };
    sync_name_fetches_plans(name)
}

fn sync_name_fetches_plans(name: &str) -> bool {
    name.starts_with("plans.")
        || name.starts_with("planItems.")
        || name == "harness_shared.harness_plans.changed"
        || name == "harness_shared.plan_revisions.changed"
        || name == "harness_shared.plan_runs.changed"
}

fn refetch_signal_for_frame_data(data: &str) -> RefetchSignal {
    if sync_payload_fetches_plans(data) {
        RefetchSignal::IncludePlanReads
    } else {
        RefetchSignal::SkipPlanReads
    }
}

/// Subscribe to `/api/activity/stream` (the worker-integration bridge) and
/// forward each `activity` frame as `Event::ActivityLive` (prepended to the Fleet
/// activity feed, P1). The stream pushes only rows that arrive AFTER connect —
/// history is seeded by the `activity:recent` backfill in `refetch_all`. Long-
/// lived; resubscribes if the stream drops. A missing backend ends it quietly.
async fn activity_loop(tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(_) => return,
    };
    loop {
        if tx.is_closed() {
            return;
        }
        let mut sub = match client.subscribe_activity().await {
            Ok(rx) => rx,
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        while let Some(fr) = sub.recv().await {
            if fr.event != "activity" {
                continue; // heartbeat etc.
            }
            if let Ok(row) = serde_json::from_str::<models::ActivityRow>(&fr.data) {
                if tx.send(Event::ActivityLive(row)).is_err() {
                    return;
                }
            }
        }
        // Stream ended (upstream closed / dropped) → resubscribe shortly.
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Subscribe to `/api/operator/state-snapshot` (the state-channel SSE) and
/// forward each `snapshot` frame as `Event::CardSnapshot` — the open
/// `chat:ask_choice` cards the operator brain raises mid-turn (sentinel-tui-
/// shared-backend-and-cards-2026-06-22 Phase 2a). Resolves the active workspace
/// once up front (the `/card-response` defense-in-depth gate). Long-lived;
/// resubscribes if the stream drops. A missing backend ends it quietly.
async fn card_snapshot_loop(tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(_) => return,
    };
    // Resolve the active workspace once so card answers can carry the gate.
    // Best-effort: `None` (dev / unscoped) just omits `expectedWorkspaceId`.
    let ws = client.current_workspace().await.ok().flatten();
    if tx.send(Event::CardWorkspace(ws)).is_err() {
        return;
    }
    loop {
        if tx.is_closed() {
            return;
        }
        let mut sub = match client.subscribe_state_snapshot().await {
            Ok(rx) => rx,
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        while let Some(fr) = sub.recv().await {
            if fr.event != "snapshot" {
                continue; // heartbeat etc.
            }
            if let Some(env) = card_view::SnapshotEnvelope::from_json(&fr.data) {
                if tx.send(Event::CardSnapshot(env)).is_err() {
                    return;
                }
            }
        }
        // Stream ended → resubscribe shortly.
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// POST a card answer to `/card-response` (sentinel-tui-shared-backend-and-cards
/// Phase 2a). The server resolves the brain's blocked tool call with the pick;
/// a fresh state-snapshot then drops the card from `openCards`. Best-effort — a
/// transport failure surfaces as `Event::ChatError` (the card was already
/// optimistically dismissed; the next snapshot reconciles if the POST didn't
/// land). `conversation_id` only feeds the route's audit segment.
async fn card_respond_send(
    conversation_id: String,
    correlation_id: String,
    workspace_id: Option<String>,
    action: String,
    payload: Option<serde_json::Value>,
    tx: UnboundedSender<Event>,
) {
    // P-015: every failure names the card it belongs to, so the TUI reopens
    // exactly that card. A card POST failure is not a turn failure — the agent
    // is still waiting on the card — so it never travels as `ChatError`.
    let failed = |error: String| {
        let _ = tx.send(Event::CardRespondFailed {
            correlation_id: correlation_id.clone(),
            error,
        });
    };
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => return failed(format!("operator unreachable: {e}")),
    };
    let Some(ws) = workspace_id.filter(|id| !id.trim().is_empty()) else {
        return failed("the card's workspace is unknown; reconnect this conversation".into());
    };
    if let Err(e) = client
        .card_respond(
            &conversation_id,
            &correlation_id,
            &ws,
            &action,
            payload,
            None,
        )
        .await
    {
        failed(e.to_string());
    }
}

/// Debounced view-state persistence (P12 / D-002). Receives a `ViewState`
/// snapshot per nav change, coalesces a burst within an 800ms window, and PUTs
/// the latest via its own backend client. Best-effort — a failed save is dropped
/// (the next nav change retries); a missing backend ends the task quietly.
async fn view_state_saver(mut rx: UnboundedReceiver<models::ViewState>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(_) => return,
    };
    let owner = workbench::workbench_owner();
    while let Some(mut latest) = rx.recv().await {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(800)) => break,
                next = rx.recv() => match next {
                    Some(v) => latest = v,
                    None => break,
                },
            }
        }
        let _ = client.put_view_state(&owner, &latest).await;
    }
}

/// Owns an `OperatorClient`; fetches the full view set on startup, then on each
/// debounced signal from the invalidation loop and on a slow safety interval.
async fn refetch_loop(
    tx: UnboundedSender<Event>,
    active_harness: Arc<Mutex<String>>,
    active_doc: Arc<Mutex<Option<String>>>,
    active_plan: Arc<Mutex<Option<(String, String)>>>,
    network_focus: Option<String>,
    pane: PaneFetchScope,
    mut sig_rx: UnboundedReceiver<RefetchSignal>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("client init: {e}")));
            return;
        }
    };

    // Initial load.
    refetch_all(
        &client,
        &tx,
        &active_harness,
        &active_doc,
        &active_plan,
        &pane,
        true,
    )
    .await;
    if let Some(key) = &network_focus {
        // hive-pane: re-pull the drill-in dossier (beacon history + ask
        // log, P-014 item 2) on the same push-driven cadence — the
        // network.hive.* writers fire SSE invalidates on this stream.
        tokio::spawn(hive_dossier_fetch(key.clone(), tx.clone()));
    }
    // Seed notification history once from the toast-log (P8); live
    // `attention.notify` events prepend to it as they arrive.
    match client.recent_toasts(50).await {
        Ok(h) => {
            let _ = tx.send(Event::ToastHistory(h));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("toast-log: {e}")));
        }
    }

    // Restore the persisted workbench view-state once, after the initial data
    // load so selections land against populated lists (P12 / D-002).
    match client.get_view_state(&workbench::workbench_owner()).await {
        Ok(vs) => {
            let _ = tx.send(Event::ViewStateLoaded(vs));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("view-state: {e}")));
        }
    }

    // Safety net only — a slow fallback in case we ever miss an SSE invalidate.
    // This is NOT a poll: it fires once a minute, not on a tight loop.
    let mut safety = tokio::time::interval(Duration::from_secs(60));
    safety.tick().await; // consume the immediate first tick.

    loop {
        tokio::select! {
            sig = sig_rx.recv() => {
                let Some(first_sig) = sig else {
                    break; // invalidation loop gone → nothing left to drive us.
                };
                // Debounce a burst of invalidations into one refetch.
                tokio::time::sleep(Duration::from_millis(250)).await;
                let mut include_plan_reads = first_sig.include_plan_reads();
                while let Ok(next_sig) = sig_rx.try_recv() {
                    include_plan_reads |= next_sig.include_plan_reads();
                }
                refetch_all(
                    &client,
                    &tx,
                    &active_harness,
                    &active_doc,
                    &active_plan,
                    &pane,
                    include_plan_reads,
                )
                .await;
        if let Some(key) = &network_focus {
            // hive-pane: drill-in dossier rides the same cadence (P-014 item 2).
            tokio::spawn(hive_dossier_fetch(key.clone(), tx.clone()));
        }
            }
            _ = safety.tick() => {
                refetch_all(
                    &client,
                    &tx,
                    &active_harness,
                    &active_doc,
                    &active_plan,
                    &pane,
                    true,
                )
                .await;
        if let Some(key) = &network_focus {
            // hive-pane: drill-in dossier rides the same cadence (P-014 item 2).
            tokio::spawn(hive_dossier_fetch(key.clone(), tx.clone()));
        }
            }
        }
        if tx.is_closed() {
            break;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PinnedHydrationPlan {
    /// The dock controller renders the fleet roster, work items, and activity
    /// overlay, so it keeps only that surface's reads.
    Fleet,
    /// The Network pane renders the cross-Hive board (and, for hive-pane,
    /// the separate dossier fetch below).
    Network,
    /// The Context pane needs the roster to resolve the live Sentinel target.
    Roster,
    /// Wake and AgentCtx have their own dedicated refresh loops.
    Dedicated,
    /// The ordinary workbench keeps its full read model.
    Full,
}

fn pinned_hydration_plan(pinned: Option<app::Tab>) -> PinnedHydrationPlan {
    match pinned {
        Some(app::Tab::Fleet) => PinnedHydrationPlan::Fleet,
        Some(app::Tab::Network) => PinnedHydrationPlan::Network,
        Some(app::Tab::PlansBoard) => PinnedHydrationPlan::Roster,
        Some(app::Tab::Wake | app::Tab::AgentCtx) => PinnedHydrationPlan::Dedicated,
        _ => PinnedHydrationPlan::Full,
    }
}

/// Hydrate only the read model a pinned dock pane can render.
///
/// A fresh PUI used to enter the full-workbench `refetch_all` fan-out even for
/// a one-tab dock pane. A dock layout can contain several such panes, so one
/// launch multiplied the same roster/config/work-item/activity reads and could
/// saturate a request-only operator before the first frame. Keep the full
/// workbench path unchanged, but make the dock's dependency boundary explicit.
async fn refetch_pinned(client: &OperatorClient, tx: &UnboundedSender<Event>, pinned: app::Tab) {
    match pinned_hydration_plan(Some(pinned)) {
        PinnedHydrationPlan::Fleet => {
            // P-003: Fleet still gets the bounded first-paint snapshot before
            // its reconciliation reads.
            spawn_first_paint_work_items(client.clone(), tx.clone());
            if let Ok((active, pending)) = client.roster_typed().await {
                let _ = tx.send(Event::Roster { active, pending });
            }
            if let Ok(rate) = client.fleet_rate_status().await {
                let _ = tx.send(Event::FleetRate(rate));
            }
            if let Ok(frames) = client.deploy_frames().await {
                let _ = tx.send(Event::Frames(frames));
            }
            match client.work_items_list().await {
                Ok(work) => {
                    let _ = tx.send(Event::WorkItems { result: Ok(work) });
                }
                Err(error) => {
                    let _ = tx.send(Event::WorkItems {
                        result: Err(error.to_string()),
                    });
                }
            }
            if let Ok(activity) = client
                .activity_recent(None, FLEET_ACTIVITY_BACKFILL_LIMIT)
                .await
            {
                let _ = tx.send(Event::ActivitySeed(activity));
            }
            if let Ok(todos) = client.activity_recent(Some("todos"), 50).await {
                let _ = tx.send(Event::ActivityTodos(todos));
            }
        }
        PinnedHydrationPlan::Network => {
            if let Ok(rows) = client.network_board().await {
                let _ = tx.send(Event::NetworkBoard(rows));
            }
        }
        PinnedHydrationPlan::Roster => {
            if let Ok((active, pending)) = client.roster_typed().await {
                let _ = tx.send(Event::Roster { active, pending });
            }
        }
        PinnedHydrationPlan::Dedicated | PinnedHydrationPlan::Full => {}
    }
}

/// Subscribe to `/api/zero-harness/sse` via the active transport (IPC or HTTP —
/// `client.subscribe_sse` yields a uniform `SseFrame` stream either way). On each
/// `invalidate`/`update` frame, ping `sig_tx` with the affected view scope; an
/// `attention.notify` payload also becomes an `Event::Notify` (P8). The stream is
/// long-lived; if it ends we resubscribe.
async fn invalidation_loop(tx: UnboundedSender<Event>, sig_tx: UnboundedSender<RefetchSignal>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("sync client init: {e}")));
            return;
        }
    };

    loop {
        if sig_tx.is_closed() {
            return;
        }
        let mut sub = match client.subscribe_sse("/api/zero-harness/sse").await {
            Ok(rx) => rx,
            Err(e) => {
                let _ = tx.send(Event::Error(format!("sse subscribe: {e}")));
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };

        while let Some(fr) = sub.recv().await {
            if fr.event != "invalidate" && fr.event != "update" {
                continue; // heartbeat etc.
            }
            // Payload is {name, args?, data?}. The `attention.notify` event (P8)
            // carries a ping-the-human payload in `data`.
            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&fr.data) {
                if payload.get("name").and_then(|v| v.as_str()) == Some("attention.notify") {
                    if let Some(n) = parse_attention_notify(payload.get("data")) {
                        if tx.send(Event::Notify(n)).is_err() {
                            return;
                        }
                    }
                }
            }
            if sig_tx
                .send(refetch_signal_for_frame_data(&fr.data))
                .is_err()
            {
                return; // refetch loop gone.
            }
        }

        // Stream ended (upstream closed / dropped) → resubscribe shortly.
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Subscribe to `/api/coord/inbox/sse` (P-002 / D-003b): on each wake, refetch
/// the human-facing coord inbox and emit `Event::Notify` for entries not seen
/// before. The first fetch only seeds the seen-set (no startup storm). No polling
/// — the wake is the `coord_inbox` NOTIFY, surfaced as an SSE invalidate.
async fn coord_inbox_loop(tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("coord-inbox client init: {e}")));
            return;
        }
    };
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut seeded = false;
    loop {
        if tx.is_closed() {
            return;
        }
        let mut sub = match client.subscribe_sse("/api/coord/inbox/sse").await {
            Ok(rx) => rx,
            Err(e) => {
                let _ = tx.send(Event::Error(format!("coord-inbox sse: {e}")));
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        // Fetch once on (re)connect; the first fetch only seeds (no notify).
        coord_inbox_fetch(&client, &tx, &mut seen, &mut seeded).await;
        while let Some(fr) = sub.recv().await {
            if fr.event != "invalidate" && fr.event != "update" {
                continue; // heartbeat
            }
            coord_inbox_fetch(&client, &tx, &mut seen, &mut seeded).await;
        }
        // Stream ended → resubscribe shortly.
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Refetch the human-facing coord inbox; emit `Event::Notify` for newly-seen
/// entries (only after the seed load). Mutates `seen`/`seeded`.
async fn coord_inbox_fetch(
    client: &OperatorClient,
    tx: &UnboundedSender<Event>,
    seen: &mut std::collections::HashSet<String>,
    seeded: &mut bool,
) {
    match client.coord_inbox().await {
        Ok(items) => {
            for m in &items {
                if m.msg_id.is_empty() {
                    continue;
                }
                if seen.insert(m.msg_id.clone()) && *seeded {
                    let _ = tx.send(Event::Notify(coord_msg_to_notif(m)));
                }
            }
            *seeded = true;
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("coord-inbox: {e}")));
        }
    }
}

/// Map a human-facing coord inbox entry to a notification (P-002).
fn coord_msg_to_notif(m: &models::CoordMsg) -> models::Notif {
    let who = m.from.clone().unwrap_or_else(|| "coord".to_string());
    let body = m
        .summary
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| m.kind.clone());
    models::Notif {
        level: if m.kind.is_empty() {
            "coord".to_string()
        } else {
            m.kind.clone()
        },
        message: format!("{who}: {body}"),
        harness: m.harness_slug.clone(),
        ts: if m.ts.is_empty() {
            None
        } else {
            Some(m.ts.clone())
        },
    }
}

/// Map an `attention.notify` payload (`{kind,title,body,harnessSlug,importance,…}`)
/// into a `Notif`. Returns None if the payload is absent/unusable.
fn parse_attention_notify(data: Option<&serde_json::Value>) -> Option<models::Notif> {
    let d = data?;
    let title = d
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("(attention)");
    let body = d.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let level = d
        .get("importance")
        .and_then(|v| v.as_str())
        .or_else(|| d.get("kind").and_then(|v| v.as_str()))
        .unwrap_or("attention")
        .to_string();
    let harness = d
        .get("harnessSlug")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let message = if body.is_empty() {
        title.to_string()
    } else {
        format!("{title} — {body}")
    };
    Some(models::Notif {
        level,
        message,
        harness,
        ts: None,
    })
}

/// A pinned dock pane renders exactly ONE tab, so it must not refetch the fat
/// payloads only OTHER tabs render (EI-7028: 8+ pinned dock panes × ~1.6MB of
/// plans:list + plans:attention per SSE-invalidate/60s tick ≈ tens of GB/day of
/// loopback traffic for data none of them could ever draw). `app.plans` is
/// consumed by Plans / Fleet (progress) / the plan-filter panel (Inbox|Fleet) /
/// Overview; pinned Wake / AgentCtx / Network / Context panes never read it.
fn pane_fetches_plans(pinned: Option<app::Tab>) -> bool {
    match pinned {
        None => true, // full workbench: every tab reachable
        Some(t) => matches!(t, app::Tab::Plans | app::Tab::Fleet | app::Tab::Inbox),
    }
}

/// `app.inbox` (the plans:attention feed — the single fattest payload, ~1.1MB)
/// is consumed ONLY by Tab::Inbox, the tab-strip Inbox badge, and the Overview
/// tiles — all full-workbench surfaces. OS notifications ride the
/// `attention.notify` SSE events (`push_notif`), NOT this poll, so a pinned
/// pane skipping it loses nothing (verified EI-7028, 2026-07-03).
fn pane_fetches_attention(pinned: Option<app::Tab>) -> bool {
    match pinned {
        None => true,
        Some(t) => matches!(t, app::Tab::Inbox),
    }
}

/// P-003 (pui-psu-exact-launch-and-task-latency-2026-09-01, D-004): the size
/// of the bounded first-paint task snapshot. It covers the visible Fleet task
/// surface several times over; the later full-list refetch (500 rows) is the
/// reconciliation pass, never the first paint.
pub(crate) const FIRST_PAINT_WORK_ITEMS_LIMIT: u32 = 100;

// Keep the raw activity backfill below the MCP result-door budget. A 200-row
// fleet snapshot was measured at 128–145 KB on the shared staging host, where
// repeated refetches also saturated the Hono event loop and delayed unrelated
// reads (including plans:get) past their client deadline. Live activity still
// arrives through SSE, so the backfill is only a recent seed, not a complete
// history read.
pub(crate) const FLEET_ACTIVITY_BACKFILL_LIMIT: u32 = 25;

/// The first-paint snapshot source — the real client, or a test double. The
/// seam exists so the latency/shape guards in `tests` exercise the ACTUAL
/// first-paint code path (`spawn_first_paint_work_items`) rather than a
/// re-description of it.
trait FirstPaintWorkItems: Send + 'static {
    fn work_items_snapshot(
        self,
        limit: u32,
    ) -> impl std::future::Future<Output = Result<Vec<crate::models::WorkItem>>> + Send;
}

impl FirstPaintWorkItems for OperatorClient {
    async fn work_items_snapshot(self, limit: u32) -> Result<Vec<crate::models::WorkItem>> {
        self.work_items_list_bounded(limit).await
    }
}

/// Start the bounded first-paint snapshot WITHOUT awaiting it: the caller goes
/// straight on to its serial reads and the snapshot lands as an
/// `Event::WorkItems` the moment the bounded read returns. D-004: first paint
/// may not wait on enrichment, serial fan-out, or an oversized payload.
fn spawn_first_paint_work_items<S: FirstPaintWorkItems>(
    source: S,
    tx: UnboundedSender<Event>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let result = source
            .work_items_snapshot(FIRST_PAINT_WORK_ITEMS_LIMIT)
            .await
            .map_err(|error| error.to_string());
        let _ = tx.send(Event::WorkItems { result });
    })
}

/// Fetch every panel's data and forward as `Event`s. Errors per-query become
/// `Event::Error` so one failing endpoint doesn't sink the rest. `pinned`
/// scopes the fat plans/attention reads to panes that actually render them
/// (see `pane_fetches_plans` / `pane_fetches_attention`). `include_plan_reads`
/// is false for non-plan SSE invalidations; the 60s safety tick still includes
/// them, so a missed/unknown plan signal self-heals without a tight poll.
async fn refetch_all(
    client: &OperatorClient,
    tx: &UnboundedSender<Event>,
    active_harness: &Arc<Mutex<String>>,
    active_doc: &Arc<Mutex<Option<String>>>,
    active_plan: &Arc<Mutex<Option<(String, String)>>>,
    pane: &PaneFetchScope,
    include_plan_reads: bool,
) {
    let pinned = pane.pinned;
    if let Some(pinned) = pinned {
        match pinned_hydration_plan(Some(pinned)) {
            PinnedHydrationPlan::Full => {}
            PinnedHydrationPlan::Fleet
            | PinnedHydrationPlan::Network
            | PinnedHydrationPlan::Roster
            | PinnedHydrationPlan::Dedicated => {
                refetch_pinned(client, tx, pinned).await;
                return;
            }
        }
    }
    // P-003: the Fleet task list is the first useful work surface, so start a
    // bounded snapshot immediately instead of making it wait behind the serial
    // plans/roster/config/plugin reads below. The later full-list fetch remains
    // the reconciliation pass and replaces this snapshot when it lands.
    spawn_first_paint_work_items(client.clone(), tx.clone());

    if include_plan_reads && pane_fetches_plans(pinned) {
        match client.plans_typed().await {
            Ok(p) => {
                let _ = tx.send(Event::Plans(p));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("plans: {e}")));
            }
        }
        // P-032: the goals column rides the same plan-reads gate. Quietly
        // optional — an older host without /api/tui/goals renders an empty
        // goals column rather than toasting every poll.
        if let Ok(g) = client.goals_list().await {
            let _ = tx.send(Event::Goals(g.goals));
        }
    }
    match client.roster_typed().await {
        Ok((active, pending)) => {
            let _ = tx.send(Event::Roster { active, pending });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("roster: {e}")));
        }
    }
    // Fleet rate/usage read-model (Overview top-bar, Brief 23 P-005). Quietly
    // optional: a host predating rate-limit-layer-v2 has no route — the
    // top-bar renders dashes rather than the status bar toasting every poll.
    if let Ok(s) = client.fleet_rate_status().await {
        let _ = tx.send(Event::FleetRate(s));
    }
    // The pipeline tile belongs to Overview. Its Git subprocesses must not
    // compete with Agent Chat's bounded turn-start reads in the operator.
    if pane.fetches_pipeline() {
        let _ = tx.send(Event::PipelineStatus(Box::new(
            client.pipeline_status().await,
        )));
    }
    // Deployed cloud frames (per-frame dock tabs, hive-agent-tabs P-013).
    // Quietly optional: nothing deployed / an older host → no tabs, no toasts.
    if let Ok(fr) = client.deploy_frames().await {
        let _ = tx.send(Event::Frames(fr));
    }
    // Network is an explicit destination. Loading its cross-hive read graph
    // during Agent Chat startup competes with the first session's context IO.
    // Preserve the normal push/safety cadence while Network is selected.
    if pane.fetches_network() {
        if let Ok(rows) = client.network_board().await {
            let _ = tx.send(Event::NetworkBoard(rows));
        }
    }
    if include_plan_reads && pane_fetches_attention(pinned) {
        match client.attention_typed().await {
            Ok(i) => {
                let _ = tx.send(Event::Inbox(i));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("inbox: {e}")));
            }
        }
    }
    // Harness list (for the selector).
    match client.harnesses().await {
        Ok(hs) => {
            let _ = tx.send(Event::Harnesses(hs));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("harnesses: {e}")));
        }
    }
    // Features + issues for whichever harness is active (shared cell, updated by
    // the reducer when the user cycles with [ / ]).
    let slug = active_harness
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| "papercup".to_string());
    match client.features_for(&slug).await {
        Ok(fs) => {
            let _ = tx.send(Event::Features {
                harness: slug.clone(),
                features: fs,
            });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("features: {e}")));
        }
    }
    match client.issues_for(&slug).await {
        Ok(is) => {
            let _ = tx.send(Event::Issues {
                harness: slug.clone(),
                issues: is,
            });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("issues: {e}")));
        }
    }
    // Docs for the active harness + selected doc (None → server default).
    let doc = active_doc.lock().ok().and_then(|g| g.clone());
    match client.docs_for(&slug, doc.as_deref()).await {
        Ok(d) => {
            let _ = tx.send(Event::Docs {
                harness: slug.clone(),
                docs: d,
            });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("docs: {e}")));
        }
    }
    match client.testing_domains(&slug).await {
        Ok(t) => {
            let _ = tx.send(Event::Testing {
                harness: slug.clone(),
                testing: t,
            });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("testing: {e}")));
        }
    }
    match client.claude_settings_effective(&slug).await {
        Ok(c) => {
            let _ = tx.send(Event::Config {
                harness: slug.clone(),
                config: c,
            });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("config: {e}")));
        }
    }
    // Plugin-contributed TUI panes for the active harness (D-002).
    match client.tui_panes_for(&slug).await {
        Ok(p) => {
            let _ = tx.send(Event::TuiPanes {
                harness: slug.clone(),
                panes: p,
            });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("tui_panes: {e}")));
        }
    }
    // Installed plugin manifests for the Plugins tab (D-007/D-014). Global, not
    // per-harness, but refetched with the rest on each invalidate.
    match client.plugins_global().await {
        Ok(p) => {
            let _ = tx.send(Event::Plugins(p));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("plugins: {e}")));
        }
    }
    // Operator feature flags for the read-only Settings tab (P10). Global — not
    // per-harness — but refetched with the rest on each invalidate.
    match client.flags().await {
        Ok(f) => {
            let _ = tx.send(Event::Flags(f));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("flags: {e}")));
        }
    }
    // Read-only operator-config overview for the Settings tab (P10b): AI backend +
    // per-role models + connected speech providers. Global; refetched with the rest.
    match client.operator_config().await {
        Ok(c) => {
            let _ = tx.send(Event::OperatorConfig(c));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("operator-config: {e}")));
        }
    }
    // Agent Chat account-route picker. The generic run-tool bridge returns
    // live pool rows; an empty pool still leaves the Auto row available.
    match client.accounts_status().await {
        Ok(status) => {
            let _ = tx.send(Event::AccountRows(status.accounts));
            let _ = tx.send(Event::AccountPoolVerdicts(status.pool_verdict));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("accounts-status: {e}")));
        }
    }
    // Plan-item assignment/claim/liveness for the SELECTED plan (P-005a). A per-plan
    // endpoint, so only the plan the user has focused (published by the reducer while
    // the Plans tab is active) is fetched; None off-tab → skip the request entirely.
    let sel_plan = active_plan.lock().ok().and_then(|g| g.clone());
    if include_plan_reads {
        if let Some((h, p)) = sel_plan {
            match client.plan_item_states(&h, &p).await {
                Ok(s) => {
                    let _ = tx.send(Event::PlanItemStates(s));
                }
                Err(e) => {
                    let _ = tx.send(Event::Error(format!("plan-item-states: {e}")));
                }
            }
        }
    }
    // Fleet status view (pui-fleet-status-view-2026-06-04): fleet-wide work items
    // (P0) + a recent-activity backfill seeding the overlay (P1; the live feed
    // rides the activity SSE) + a kind=todos backfill for worker-todo mirroring
    // (P2). Global — not per-harness — reconciled with the rest on each refetch.
    match client.work_items_list().await {
        Ok(w) => {
            let _ = tx.send(Event::WorkItems { result: Ok(w) });
        }
        Err(e) => {
            let _ = tx.send(Event::WorkItems {
                result: Err(e.to_string()),
            });
        }
    }
    match client
        .activity_recent(None, FLEET_ACTIVITY_BACKFILL_LIMIT)
        .await
    {
        Ok(a) => {
            let _ = tx.send(Event::ActivitySeed(a));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("activity: {e}")));
        }
    }
    match client.activity_recent(Some("todos"), 50).await {
        Ok(a) => {
            let _ = tx.send(Event::ActivityTodos(a));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("activity-todos: {e}")));
        }
    }
    // The Memory tab's list (D-006 Step 2). Preserve backend-disabled,
    // authentication, and transport outcomes as distinct typed states.
    let _ = tx.send(Event::MemoryLoad(
        client.memory_list_state(Some(&slug)).await,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn startup_chat(
        id: &str,
        runtime: Option<&str>,
        updated: &str,
    ) -> agent_chats::AgentChatSummary {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "role": "operator",
            "su_runtime_class": runtime,
            "updated_at": updated,
        }))
        .unwrap()
    }

    /// pui-chat-first-ux P-010: `pui` started in project A never reattaches a
    /// session that is running in project B; a session whose directory is
    /// unknown stays eligible.
    #[test]
    fn default_operator_chat_skips_sessions_started_in_another_directory() {
        let chats = vec![
            startup_chat("here", Some("su-session"), "2026-09-07T01:00:00Z"),
            startup_chat("elsewhere", Some("su-session"), "2026-09-07T02:00:00Z"),
        ];
        use crate::su_session::{
            SuSessionBackend, SuSessionInventoryEntry, SuSessionLifecycleState,
            SuSessionReconciliation,
        };
        let row = |id: &str, cwd: Option<&str>| SuSessionInventoryEntry {
            agent_chat_id: id.into(),
            adv_session_id: 1,
            backend: SuSessionBackend::Codex,
            lifecycle: SuSessionLifecycleState::Ready,
            runtime_generation: 1,
            native_session_id: format!("native-{id}"),
            terminal: false,
            reconciliation: SuSessionReconciliation::Attached,
            cwd: cwd.map(str::to_owned),
        };
        let inventory = vec![
            row("here", Some("/work/a")),
            row("elsewhere", Some("/work/b")),
        ];
        let pick = |launch: Option<&str>| {
            default_operator_chat(&chats, &inventory, launch).map(|chat| chat.id.clone())
        };
        assert_eq!(pick(Some("/work/a")).as_deref(), Some("here"));
        assert_eq!(pick(Some("/work/b/")).as_deref(), Some("elsewhere"));
        assert_eq!(pick(Some("/work/c")), None);
        assert_eq!(pick(None).as_deref(), Some("elsewhere"));
        let unknown = vec![row("here", Some("/work/a")), row("elsewhere", None)];
        assert_eq!(
            default_operator_chat(&chats, &unknown, Some("/work/c")).map(|chat| chat.id.as_str()),
            Some("elsewhere")
        );
    }

    /// pui-chat-first-ux P-009 / D-008: quitting a PUI ends its engine, so the
    /// chat it left reads `EndedArchived`. That chat stays the default (the
    /// inventory adoption arm then resumes it) only while it has a native
    /// transcript to resume; an orphaned row is never picked.
    #[test]
    fn default_operator_chat_keeps_an_ended_chat_that_can_resume() {
        use crate::su_session::{
            SuSessionBackend, SuSessionInventoryEntry, SuSessionLifecycleState,
            SuSessionReconciliation,
        };
        let chats = vec![startup_chat(
            "left",
            Some("su-session"),
            "2026-09-07T01:00:00Z",
        )];
        let row = |native: &str, reconciliation| SuSessionInventoryEntry {
            agent_chat_id: "left".into(),
            adv_session_id: 1,
            backend: SuSessionBackend::Claude,
            lifecycle: SuSessionLifecycleState::Ended,
            runtime_generation: 1,
            native_session_id: native.into(),
            terminal: true,
            reconciliation,
            cwd: Some("/work/a".into()),
        };
        let pick = |entry| {
            default_operator_chat(&chats, &[entry], Some("/work/a")).map(|chat| chat.id.clone())
        };
        assert_eq!(
            pick(row("native-left", SuSessionReconciliation::EndedArchived)).as_deref(),
            Some("left")
        );
        assert_eq!(pick(row("", SuSessionReconciliation::EndedArchived)), None);
        assert_eq!(
            pick(row("native-left", SuSessionReconciliation::FailedOrphaned)),
            None
        );
        // A terminal row that still reads Attached is not live: never the default.
        assert_eq!(
            pick(row("native-left", SuSessionReconciliation::Attached)),
            None
        );
        // The directory rule still applies to an ended chat.
        assert_eq!(
            default_operator_chat(
                &chats,
                &[row("native-left", SuSessionReconciliation::EndedArchived)],
                Some("/work/b")
            )
            .map(|chat| chat.id.as_str()),
            None
        );
    }

    #[test]
    fn default_operator_chat_skips_newer_read_only_history() {
        let mut archived = startup_chat("archived", Some("su-session"), "2026-09-07T05:00:00Z");
        archived.archived_at = Some("2026-09-07T05:00:00Z".into());
        let mut task = startup_chat("task", Some("su-session"), "2026-09-07T06:00:00Z");
        task.feature_id = Some("WI-123".into());
        let mut other_role = startup_chat("other-role", Some("su-session"), "2026-09-07T07:00:00Z");
        other_role.role = "doc-steward".into();
        let chats = vec![
            startup_chat("older-su", Some("su-session"), "2026-09-07T00:00:00Z"),
            startup_chat("writable", Some("su-session"), "2026-09-07T01:00:00Z"),
            startup_chat("legacy", Some("legacy-owned-loop"), "2026-09-07T02:00:00Z"),
            startup_chat("unclassified", None, "2026-09-07T03:00:00Z"),
            startup_chat(
                "unknown-policy",
                Some("future-runtime"),
                "2026-09-07T04:00:00Z",
            ),
            archived,
            task,
            other_role,
        ];
        assert_eq!(
            default_operator_chat(&chats, &[], None).unwrap().id,
            "writable"
        );
        // Historical selection is the regression control: recency alone lands
        // on a conversation that the actual dispatch policy cannot send to.
        let old_default = chats
            .iter()
            .filter(|chat| {
                chat.role == "operator" && chat.feature_id.is_none() && chat.archived_at.is_none()
            })
            .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
            .unwrap();
        assert_eq!(
            crate::su_session::decide_su_dispatch(crate::su_session::SuDispatchInputs {
                attached: false,
                ended_backend: None,
                picked_backend: None,
                configured_backend: None,
                loaded_class: Some(crate::su_session::PuiRuntimeClass::parse(
                    old_default.su_runtime_class.as_deref()
                )),
            })
            .target,
            crate::su_session::SuDispatchTarget::ReadOnly,
        );
    }

    #[test]
    fn default_operator_chat_uses_live_binding_and_excludes_terminal_runtime() {
        use crate::su_session::{
            SuSessionBackend, SuSessionInventoryEntry, SuSessionLifecycleState,
            SuSessionReconciliation,
        };
        let chats = vec![
            startup_chat(
                "bound-legacy",
                Some("legacy-owned-loop"),
                "2026-09-07T01:00:00Z",
            ),
            startup_chat("ended-su", Some("su-session"), "2026-09-07T02:00:00Z"),
        ];
        let live = SuSessionInventoryEntry {
            agent_chat_id: "bound-legacy".into(),
            adv_session_id: 1,
            backend: SuSessionBackend::Codex,
            lifecycle: SuSessionLifecycleState::Ready,
            runtime_generation: 1,
            native_session_id: "native-live".into(),
            terminal: false,
            reconciliation: SuSessionReconciliation::Attached,
            cwd: None,
        };
        let mut ended = live.clone();
        ended.agent_chat_id = "ended-su".into();
        ended.terminal = true;
        ended.reconciliation = SuSessionReconciliation::EndedArchived;
        let mut inventory = vec![live, ended];
        // A live binding outranks a NEWER ended chat.
        assert_eq!(
            default_operator_chat(&chats, &inventory, None).unwrap().id,
            "bound-legacy"
        );
        for reconciliation in [
            SuSessionReconciliation::FailedOrphaned,
            SuSessionReconciliation::Pending,
        ] {
            inventory[0].reconciliation = reconciliation;
            // P-009 / D-008: with no live chat left, the ended chat that can
            // resume from its native transcript is the default …
            assert_eq!(
                default_operator_chat(&chats, &inventory, None).unwrap().id,
                "ended-su"
            );
            // … and one with nothing to resume is history only.
            let mut orphaned = inventory.clone();
            orphaned[1].native_session_id.clear();
            assert!(default_operator_chat(&chats, &orphaned, None).is_none());
        }
    }

    #[test]
    fn initial_turn_snapshot_requires_a_ready_matching_native_runtime() {
        let mut binding: crate::su_session::SuSessionBinding =
            serde_json::from_value(serde_json::json!({
                "operation":"created", "backend":"claude", "advSessionId":7,
                "ownerId":"su-1", "workspaceId":"ws-1", "harnessSlug":"papercup",
                "nativeSession": {"backend":"claude", "source":"adv_sessions", "ownerId":"su-1",
                    "sessionId":"native-1", "configDir":"/fixture", "exactResumeSupported":true}
            }))
            .unwrap();
        let mut identity: crate::su_session::SuSessionIdentity = serde_json::from_value(serde_json::json!({
            "agentChatId":"chat-1", "advSessionId":7, "backend":"claude",
            "nativeSessionId":"native-1", "ownerId":"su-1", "workspaceId":"ws-1", "harnessSlug":"papercup"
        })).unwrap();
        assert!(su_turn_target_matches(
            &binding, &identity, "papercup", "chat-1"
        ));
        let mut snapshot: crate::su_session::SuSessionSnapshot =
            serde_json::from_value(serde_json::json!({
                "ok": true,
                "descriptor": {
                    "identity": identity,
                    "lifecycle": "ready",
                    "runtimeGeneration": 0,
                    "role": "su",
                    "carry": "warm",
                    "modes": [],
                    "capabilities": {"commands": {}, "features": {}},
                    "backendExtension": {"backend": "claude", "configDir": null, "configDirSource": null}
                },
                "floorSequence": 1,
                "lastSequence": 2,
                "terminal": false,
                "executorAttached": true,
                "streamReady": true
            }))
            .unwrap();
        assert!(startup_snapshot_can_send_initial_turn(
            &binding, &snapshot, "papercup", "chat-1"
        ));
        snapshot.stream_ready = false;
        assert!(!startup_snapshot_can_send_initial_turn(
            &binding, &snapshot, "papercup", "chat-1"
        ));
        snapshot.stream_ready = true;
        identity.native_session_id = "replaced-native".into();
        snapshot.descriptor.identity.native_session_id = identity.native_session_id.clone();
        assert!(!su_turn_target_matches(
            &binding, &identity, "papercup", "chat-1"
        ));
        assert!(!startup_snapshot_can_send_initial_turn(
            &binding, &snapshot, "papercup", "chat-1"
        ));
        binding.native_session = None; // A resumed history binds from its canonical snapshot.
        assert!(su_turn_target_matches(
            &binding, &identity, "papercup", "chat-1"
        ));
        identity.owner_id = "unrelated-owner".into();
        assert!(!su_turn_target_matches(
            &binding, &identity, "papercup", "chat-1"
        ));
    }

    /// P-002 (WI-10003622): session 31362's restored host answered
    /// executorAttached:false + reattach/live_pid for good, so the first turn
    /// waited 60s for a ready event no process could emit. That exact
    /// snapshot must classify as resumable; a fresh host, an attached one, a
    /// host already mid-resume and a terminal one must not.
    #[test]
    fn restored_host_without_executor_is_a_detached_runtime() {
        let mut snapshot: crate::su_session::SuSessionSnapshot =
            serde_json::from_value(serde_json::json!({
                "ok": true,
                "descriptor": {
                    "identity": {
                        "agentChatId":"chat-1", "advSessionId":7, "backend":"claude",
                        "nativeSessionId":"native-1", "ownerId":"su-1", "workspaceId":"ws-1",
                        "harnessSlug":"papercup"
                    },
                    "lifecycle": "running",
                    "runtimeGeneration": 0,
                    "role": "su",
                    "carry": "warm",
                    "modes": [],
                    "capabilities": {"commands": {}, "features": {}},
                    "backendExtension": {"backend": "claude", "configDir": null, "configDirSource": null}
                },
                "floorSequence": 1,
                "lastSequence": 1,
                "terminal": false,
                "executorAttached": false,
                "streamReady": true,
                "runtimeReconciliation": {"action": "reattach", "reason": "live_pid", "stalePid": false}
            }))
            .unwrap();
        assert_eq!(
            detached_runtime(&snapshot),
            Some(DetachedRuntime::Resumable)
        );

        snapshot.executor_attached = true;
        assert_eq!(
            detached_runtime(&snapshot),
            None,
            "an attached executor is live"
        );
        snapshot.executor_attached = false;

        snapshot.terminal = true;
        assert_eq!(
            detached_runtime(&snapshot),
            None,
            "a terminal session is not resumed"
        );
        snapshot.terminal = false;

        let reconciliation = snapshot.runtime_reconciliation.as_mut().unwrap();
        reconciliation.reason = "runtime_replacement".into();
        assert_eq!(
            detached_runtime(&snapshot),
            None,
            "a host mid-resume is not resumed again"
        );

        // The same reason with a DEAD recorded engine is the restored-after-
        // crash case (classifySuSessionRuntime): the native identity survives,
        // so the pending first turn must trigger the exact resume.
        snapshot.runtime_reconciliation.as_mut().unwrap().stale_pid = true;
        assert_eq!(
            detached_runtime(&snapshot),
            Some(DetachedRuntime::Resumable),
            "a dead engine with a native identity is resumed"
        );
        snapshot.runtime_reconciliation.as_mut().unwrap().stale_pid = false;

        let reconciliation = snapshot.runtime_reconciliation.as_mut().unwrap();
        reconciliation.action = crate::su_session::SuSessionRuntimeAction::Relaunch;
        reconciliation.reason = "stale_pid_without_native_identity".into();
        assert_eq!(
            detached_runtime(&snapshot),
            Some(DetachedRuntime::Unrecoverable(
                "stale_pid_without_native_identity".into()
            ))
        );

        snapshot.runtime_reconciliation.as_mut().unwrap().action =
            crate::su_session::SuSessionRuntimeAction::Wait;
        assert_eq!(
            detached_runtime(&snapshot),
            None,
            "unknown liveness keeps waiting"
        );

        snapshot.runtime_reconciliation = None;
        assert_eq!(
            detached_runtime(&snapshot),
            None,
            "a freshly launched host is not restored"
        );
    }

    #[test]
    fn default_operator_chat_with_only_legacy_history_leaves_a_sendable_front_door() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let summaries = vec![startup_chat(
            "legacy",
            Some("legacy-owned-loop"),
            "2026-08-27T00:00:00Z",
        )];
        let selected = default_operator_chat(&summaries, &[], None).map(|chat| chat.id.clone());
        let mut app = App::new();
        app.update(Event::AgentChatLoaded {
            harness: app.harness.clone(),
            chat_id: selected,
            role: "operator".into(),
            load_token: app.chat_load_token,
            summaries,
            messages: Vec::new(),
            owner_turn_ids: Vec::new(),
            approvals: Vec::new(),
        });
        assert!(app.agent_chat_id.is_none());
        assert_eq!(
            app.agent_chat_summaries[0].id, "legacy",
            "history remains selectable"
        );
        app.chat_composing = true;
        app.chat_input = "hello from the TUI".into();
        let action = app.update(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert!(
            matches!(action, Action::OpenSuSession { initial_turn: Some(ref text), .. } if text == "hello from the TUI"),
            "{action:?}"
        );
        assert_eq!(
            app.chat_input, "hello from the TUI",
            "keep the draft until host acceptance"
        );
    }

    #[test]
    fn hive_invite_artifact_matches_the_canonical_shape() {
        let link = format_hive_invite_link(
            "deadbeefdeadbeefdeadbeefdeadbeef",
            Some("ab+/="),
            "Acme / Hive",
        );
        assert_eq!(
            link,
            "papercusp://pot?pubkey=ab%2B%2F%3D&secret=deadbeefdeadbeefdeadbeefdeadbeef&title=Acme%20%2F%20Hive"
        );
        assert!(valid_invite_secret("deadbeefdeadbeefdeadbeefdeadbeef"));
        assert!(!valid_invite_secret("too-short"));
    }

    #[test]
    fn share_completion_never_calls_zero_peer_publication_reachable() {
        let outcome = models::SetHiveListingResponse {
            ok: true,
            saved: true,
            announced: true,
            reachable_peers: Some(0),
            ..Default::default()
        };
        assert_eq!(
            share_completion_message("acme", models::HiveVisibility::Public, &outcome, None,),
            "published 'acme' to the directory + Cupboard; no reachable peers yet"
        );
        assert_eq!(
            share_completion_message(
                "acme",
                models::HiveVisibility::Invite,
                &outcome,
                Some("papercusp://pot?secret=abc"),
            ),
            "shared 'acme' invite-only; no reachable peers yet — papercusp://pot?secret=abc"
        );
    }

    #[test]
    fn claim_spec_bump_changes_only_revision() {
        let current = serde_json::json!({
            "ok": true,
            "source": "fleet",
            "spec": {
                "specVersion": "1.0",
                "specId": "fleet-plan",
                "revision": 7,
                "view": { "filter": { "field": "plan", "op": "=", "value": "p-1" } },
                "rank": { "mode": "lexicographic", "terms": [{ "expr": "age", "dir": "asc" }] },
                "states": ["open"]
            }
        });
        let original = current["spec"].clone();
        let (mut bumped, previous, next) = bumped_claim_spec(&current).unwrap();
        assert_eq!((previous, next), (7, 8));
        assert_eq!(bumped["revision"], 8);
        bumped["revision"] = serde_json::json!(7);
        assert_eq!(bumped, original, "no field besides revision may change");
    }

    #[test]
    fn tool_level_refusal_is_not_reported_as_a_successful_http_call() {
        let refusal = serde_json::json!({
            "ok": false,
            "error": "bench_refused_queue_nonempty",
            "message": "member still has two claimable rows"
        });
        let error = ensure_tool_ok("fleet:bench", &refusal).unwrap_err();
        assert!(error
            .to_string()
            .contains("member still has two claimable rows"));
    }

    // --- P-003 first paint (pui-psu-exact-launch-and-task-latency-2026-09-01, D-004) ---

    /// The real client's first-paint shape without a network: records the
    /// limit it was asked for and answers after a deliberate delay.
    struct RecordingSnapshot {
        seen_limit: Arc<Mutex<Option<u32>>>,
        delay: Duration,
        rows: usize,
    }

    impl FirstPaintWorkItems for RecordingSnapshot {
        async fn work_items_snapshot(self, limit: u32) -> Result<Vec<crate::models::WorkItem>> {
            *self.seen_limit.lock().unwrap() = Some(limit);
            tokio::time::sleep(self.delay).await;
            Ok((0..self.rows)
                .map(|i| crate::models::WorkItem {
                    id: format!("WI-{i}"),
                    kind: "task".into(),
                    family: "issue".into(),
                    harness: None,
                    title: format!("row {i}"),
                    state: "open".into(),
                    assignee: None,
                    severity: None,
                })
                .collect())
        }
    }

    /// Shape guard: the first paint asks for the BOUNDED window, and that
    /// window is small — the 500-row queue is the later reconciliation read,
    /// never the first paint.
    #[tokio::test]
    async fn first_paint_work_items_request_is_bounded() {
        assert!(
            (1..=100).contains(&FIRST_PAINT_WORK_ITEMS_LIMIT),
            "first paint must stay a bounded snapshot, got {FIRST_PAINT_WORK_ITEMS_LIMIT}"
        );
        let seen = Arc::new(Mutex::new(None));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let handle = spawn_first_paint_work_items(
            RecordingSnapshot {
                seen_limit: seen.clone(),
                delay: Duration::from_millis(1),
                rows: 3,
            },
            tx,
        );
        handle.await.unwrap();
        assert_eq!(*seen.lock().unwrap(), Some(FIRST_PAINT_WORK_ITEMS_LIMIT));
        let event = rx.try_recv().ok();
        assert!(
            matches!(&event, Some(Event::WorkItems { result: Ok(rows) }) if rows.len() == 3),
            "expected the bounded snapshot event with 3 rows"
        );
    }

    #[test]
    fn fleet_activity_backfill_stays_below_result_door_budget() {
        assert!(
            (1..=25).contains(&FLEET_ACTIVITY_BACKFILL_LIMIT),
            "fleet activity seed must remain a small bounded snapshot, got {}",
            FLEET_ACTIVITY_BACKFILL_LIMIT
        );
    }

    /// Latency guard: the snapshot lands while the serial plans/roster/config
    /// reads are still in flight. If the first paint ever waits on those reads
    /// again (D-004's forbidden shape), the serial branch wins this select.
    #[tokio::test]
    async fn first_paint_work_items_do_not_wait_on_the_serial_reads() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _handle = spawn_first_paint_work_items(
            RecordingSnapshot {
                seen_limit: Arc::new(Mutex::new(None)),
                delay: Duration::from_millis(20),
                rows: 1,
            },
            tx,
        );
        // The serial reads the snapshot must NOT be queued behind.
        let serial_reads = tokio::time::sleep(Duration::from_secs(5));
        tokio::pin!(serial_reads);
        tokio::select! {
            _ = &mut serial_reads => panic!("first paint waited on the serial reads"),
            event = rx.recv() => assert!(
                matches!(event, Some(Event::WorkItems { result: Ok(_) })),
                "expected the snapshot before the serial reads finished"
            ),
        }
    }

    #[test]
    fn workbench_hud_is_a_reactive_launch_owner_but_board_panes_are_not() {
        assert!(
            !reactive_launch_mode(None),
            "bare pui is chat-first: no multiplexer to open a launch pane in"
        );
        for mode in [Some("hud"), Some("dock-driver")] {
            assert!(
                reactive_launch_mode(mode),
                "{mode:?} must consume pending workbench launches"
            );
        }
        for mode in [
            Some("wake-pane"),
            Some("prompt-pane"),
            Some("mail-pane"),
            Some("work-pane"),
            Some("network-pane"),
            Some("hive-pane"),
            Some("context-pane"),
        ] {
            assert!(!reactive_launch_mode(mode), "{mode:?} is a read-only board");
        }
    }

    /// EI-7028: pinned dock panes must not refetch the fat plans/attention
    /// payloads their one tab never renders — 8+ panes × ~1.6MB per
    /// invalidate/60s tick was ~50GB/day of loopback traffic. The full
    /// workbench (pinned == None) keeps full fidelity (Inbox detail, Overview
    /// tiles, tab badge).
    #[test]
    fn pinned_pane_fetch_scope_matches_rendered_tab() {
        // Full workbench: everything.
        assert!(pane_fetches_plans(None));
        assert!(pane_fetches_attention(None));
        // Plans consumers keep the plans list.
        for t in [app::Tab::Plans, app::Tab::Fleet, app::Tab::Inbox] {
            assert!(pane_fetches_plans(Some(t)), "{t:?} renders plans");
        }
        // The current dock panes that never read app.plans skip it.
        for t in [
            app::Tab::Wake,
            app::Tab::AgentCtx,
            app::Tab::Network,
            app::Tab::PlansBoard,
        ] {
            assert!(!pane_fetches_plans(Some(t)), "{t:?} never renders plans");
        }
        // attention (the ~1.1MB feed) is Inbox-only; NO current pinned pane
        // (Fleet/Wake/AgentCtx/Network/Context) fetches it.
        assert!(pane_fetches_attention(Some(app::Tab::Inbox)));
        for t in [
            app::Tab::Fleet,
            app::Tab::Wake,
            app::Tab::AgentCtx,
            app::Tab::Network,
            app::Tab::PlansBoard,
            app::Tab::Plans,
        ] {
            assert!(
                !pane_fetches_attention(Some(t)),
                "{t:?} never renders the attention inbox"
            );
        }
    }

    #[test]
    fn sync_refetch_signal_filters_plan_heavy_reads() {
        for name in [
            "plans.list",
            "plans.attention",
            "plans.get",
            "planItems.byPlan",
            "harness_shared.harness_plans.changed",
            "harness_shared.plan_revisions.changed",
            "harness_shared.plan_runs.changed",
        ] {
            assert!(sync_name_fetches_plans(name), "{name} should refresh plans");
            assert_eq!(
                refetch_signal_for_frame_data(&format!(r#"{{"name":"{name}"}}"#)),
                RefetchSignal::IncludePlanReads
            );
        }

        for name in [
            "activity.recent",
            "coord.inbox",
            "network.board",
            "attention.notify",
            "harness_shared.tool_invocations.changed",
        ] {
            assert!(!sync_name_fetches_plans(name), "{name} should skip plans");
            assert_eq!(
                refetch_signal_for_frame_data(&format!(r#"{{"name":"{name}"}}"#)),
                RefetchSignal::SkipPlanReads
            );
        }

        // Preserve old behavior for malformed or future payloads: include plans
        // rather than risking a stale Create/Plans pane.
        assert_eq!(
            refetch_signal_for_frame_data("not json"),
            RefetchSignal::IncludePlanReads
        );
        assert_eq!(
            refetch_signal_for_frame_data(r#"{"args":{"x":1}}"#),
            RefetchSignal::IncludePlanReads
        );
    }

    #[test]
    fn network_hydration_follows_navigation_and_pinned_panes() {
        let selected = Arc::new(Mutex::new(app::Tab::Operator));
        let pane = PaneFetchScope {
            pinned: None,
            selected: selected.clone(),
        };
        assert!(!pane.fetches_network());
        *selected.lock().unwrap() = app::Tab::Network;
        assert!(pane.fetches_network());
        *selected.lock().unwrap() = app::Tab::Plans;
        assert!(!pane.fetches_network());
        assert!(PaneFetchScope {
            pinned: Some(app::Tab::Network),
            selected: selected.clone(),
        }
        .fetches_network());
        *selected.lock().unwrap() = app::Tab::Network;
        assert!(!PaneFetchScope {
            pinned: Some(app::Tab::Fleet),
            selected,
        }
        .fetches_network());
    }

    #[test]
    fn pipeline_hydration_is_owned_by_overview() {
        let selected = Arc::new(Mutex::new(app::Tab::Operator));
        let pane = PaneFetchScope {
            pinned: None,
            selected: selected.clone(),
        };
        for tab in [
            app::Tab::Operator,
            app::Tab::Plans,
            app::Tab::Network,
            app::Tab::Fleet,
        ] {
            *selected.lock().unwrap() = tab;
            assert!(!pane.fetches_pipeline(), "{tab:?} has no pipeline tile");
        }
        *selected.lock().unwrap() = app::Tab::Overview;
        assert!(pane.fetches_pipeline());
        assert!(!PaneFetchScope {
            pinned: Some(app::Tab::Fleet),
            selected
        }
        .fetches_pipeline());
    }

    fn coord_msg(
        kind: &str,
        from: Option<&str>,
        summary: Option<&str>,
        harness: Option<&str>,
    ) -> models::CoordMsg {
        models::CoordMsg {
            ts: "2026-06-04T16:00:00Z".into(),
            msg_id: "m-1".into(),
            kind: kind.into(),
            from: from.map(|s| s.into()),
            summary: summary.map(|s| s.into()),
            harness_slug: harness.map(|s| s.into()),
        }
    }

    #[test]
    fn coord_msg_maps_to_notif() {
        let n = coord_msg_to_notif(&coord_msg(
            "message",
            Some("su-30a41"),
            Some("review the carve"),
            Some("papercup"),
        ));
        assert_eq!(n.level, "message");
        assert_eq!(n.message, "su-30a41: review the carve");
        assert_eq!(n.harness.as_deref(), Some("papercup"));
        assert_eq!(n.ts.as_deref(), Some("2026-06-04T16:00:00Z"));
    }

    #[test]
    fn coord_msg_falls_back_to_kind_and_coord() {
        // no `from`, empty summary → "coord: <kind>"
        let n = coord_msg_to_notif(&coord_msg("coord-escalation", None, Some(""), None));
        assert_eq!(n.message, "coord: coord-escalation");
        assert_eq!(n.level, "coord-escalation");
        assert_eq!(n.harness, None);
    }

    #[test]
    fn approval_hydration_failures_are_loud_without_becoming_chat_terminal() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        surface_agent_chat_approval_hydration_failure(&tx, "chat-7", &"backend offline");
        let event = rx.try_recv().expect("hydration failure event");
        assert!(matches!(
            event,
            Event::Error(ref message)
                if message.contains("approval hydration (chat-7)")
                    && message.contains("backend offline")
        ));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_tool_palette_discovers_recipes_and_invokes_through_tools_invoke() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        execute_workbench_command(
            app::PaletteCommand::FindTool {
                query: "tool catalog discovery".into(),
                harness: Some("papercusp".into()),
                plan: None,
            },
            vec![],
            vec![],
            tx.clone(),
        )
        .await;
        let event = rx.recv().await.expect("tool-palette search event");
        match event {
            Event::ToolPaletteSearchFinished {
                query,
                tools: Ok(tools),
                recipes: Ok(_),
            } => {
                assert_eq!(query, "tool catalog discovery");
                assert!(!tools.is_empty(), "live catalog returned no matches");
                assert!(tools.iter().all(|tool| !tool.name.is_empty()));
            }
            other => panic!("unexpected search event: {other:?}"),
        }

        let tool = models::ToolPaletteHit {
            name: "tools:find".into(),
            description: "discover tools".into(),
            arg_schema: "query:string(1-500)".into(),
            returns: None,
            via: Some("both".into()),
        };
        execute_workbench_command(
            app::PaletteCommand::InvokeTool {
                query: "tool catalog discovery".into(),
                tool: tool.clone(),
                args: serde_json::json!({"query":"loop status"}),
            },
            vec![],
            vec![],
            tx,
        )
        .await;
        let event = rx.recv().await.expect("tool-palette invocation event");
        match event {
            Event::ToolPaletteInvocationFinished {
                tool: invoked,
                result: Ok(result),
                ..
            } => {
                assert_eq!(invoked.name, tool.name);
                assert!(
                    result
                        .get("hits")
                        .and_then(serde_json::Value::as_array)
                        .is_some(),
                    "tools:invoke did not return the tools:find payload: {result}"
                );
            }
            other => panic!("unexpected invocation event: {other:?}"),
        }
    }
}
