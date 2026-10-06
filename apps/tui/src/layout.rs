//! Workbench zellij layout (D-001, dockview-workbench-2026-06-05). The workbench
//! is a zellij session whose `pui` HUD pane rides alongside a "work" area where
//! native agent panes (claude/codex/omp) open via the companion plugin
//! (`open_command_pane` + imperative `stack_panes`) or the `zellij action
//! new-pane` fallback (`mux::MuxAction`). pui is NOT a zellij plugin — the WASM
//! plugin sandbox can't reach our Unix-socket IPC — so it runs as a normal pane
//! and drives the session from the outside.
//!
//! ## Dockview shape (Brief 50)
//! The full PUI is the **primary** pane on launch; the work area remains a
//! stacked auxiliary group (tab-like: one agent expanded, the rest collapsed
//! to title rows) so N agents stay readable without making an empty shell the
//! first thing a user sees. Four `swap_tiled_layout` presets cycle with
//! `Alt+[`/`Alt+]`
//! (zellij's default Previous/NextSwapLayout binds — we ship layouts, never
//! config, D-006):
//!   * `stacked`      — PUI 70% │ work stack 30%  (the launch default)
//!   * `stacked-left` — the mirror (HUD docked left; the `:dock left` target, D-008)
//!   * `split`        — work area as even rows │ HUD  (good for 2–3 visible at once)
//!   * `grid`         — work area auto-tiled 2D, no split_direction → zellij BSP (4/6 visible)
//!
//! Each preset's work container holds the single `children` placeholder where
//! zellij flows the runtime panes. The fixed HUD command pane (`pui hud`) and the
//! tab/status bars are re-declared in every preset so a swap re-slots them into
//! place — verified in an isolated zellij 0.44.3 session that the HUD command
//! pane reliably lands in its declared slot, including the mirrored template
//! (D-007). Materialising + launching is the same single command as before; only
//! the KDL grew the stacked default + the presets.

use std::path::{Path, PathBuf};

use crate::hives::HiveGroup;

/// The workbench layout in zellij KDL: the full `pui` as the primary pane beside
/// a stacked work area, plus four swap presets (see the module doc). The base
/// arrangement matches the `stacked` preset so the session opens directly into
/// the TUI instead of focusing an empty shell.
pub const WORKBENCH_KDL: &str = r#"// Papercusp workbench — primary pui TUI + stacked work area, with dockview swap presets.
// (dockview-workbench-2026-06-05 / Brief 50). Alt+[ / Alt+] cycle the presets.
layout {
    pane size=1 borderless=true {
        plugin location="zellij:tab-bar"
    }
    pane split_direction="vertical" {
        pane name="pui" focus=true size="70%" {
            command "pui"
            args "hud"
        }
        pane name="work" stacked=true size="30%" {
            pane
        }
    }
    pane size=2 borderless=true {
        plugin location="zellij:status-bar"
    }

    // ── Preset: stacked (default) — the full TUI is primary; agents stack beside it ──
    swap_tiled_layout name="stacked" {
        tab {
            pane size=1 borderless=true {
                plugin location="zellij:tab-bar"
            }
            pane split_direction="vertical" {
                pane name="pui" focus=true size="70%" {
                    command "pui"
                    args "hud"
                }
                pane name="work" stacked=true size="30%" {
                    children
                }
            }
            pane size=2 borderless=true {
                plugin location="zellij:status-bar"
            }
        }
    }

    // ── Preset: stacked-left — the mirror; HUD docked on the left (:dock left) ──
    swap_tiled_layout name="stacked-left" {
        tab {
            pane size=1 borderless=true {
                plugin location="zellij:tab-bar"
            }
            pane split_direction="vertical" {
                pane name="pui" size="40%" {
                    command "pui"
                    args "hud"
                }
                pane name="work" stacked=true size="60%" {
                    children
                }
            }
            pane size=2 borderless=true {
                plugin location="zellij:status-bar"
            }
        }
    }

    // ── Preset: split — work area as even rows beside the HUD (2–3 agents) ──
    swap_tiled_layout name="split" {
        tab {
            pane size=1 borderless=true {
                plugin location="zellij:tab-bar"
            }
            pane split_direction="vertical" {
                pane name="work" split_direction="horizontal" size="60%" {
                    children
                }
                pane name="pui" size="40%" {
                    command "pui"
                    args "hud"
                }
            }
            pane size=2 borderless=true {
                plugin location="zellij:status-bar"
            }
        }
    }

    // ── Preset: grid — work area auto-tiled 2D (no split_direction → zellij BSP) ──
    swap_tiled_layout name="grid" {
        tab {
            pane size=1 borderless=true {
                plugin location="zellij:tab-bar"
            }
            pane split_direction="vertical" {
                pane name="work" size="65%" {
                    children
                }
                pane name="pui" size="35%" {
                    command "pui"
                    args "hud"
                }
            }
            pane size=2 borderless=true {
                plugin location="zellij:status-bar"
            }
        }
    }
}
"#;

/// The swap-preset names, in cycle order (matches the `swap_tiled_layout` blocks
/// in [`WORKBENCH_KDL`]). `pui` uses this to label the active preset + to drive
/// `:dock`/`:layout` (D-008). The first entry is the default arrangement.
pub const SWAP_PRESETS: &[&str] = &["stacked", "stacked-left", "split", "grid"];

/// One key the DOCK layout binds at the MULTIPLEXER level.
///
/// This slice is the single source for both halves of that fact: the dock's KDL
/// `keybinds` block is GENERATED from it by [`dock_keybinds_kdl`], and
/// [`crate::keyboard::Host::swallows`] reads it to decide whether a key can
/// reach this program at all. Hand-maintaining the second copy is how a hint
/// ends up naming a key the multiplexer ate (P-007).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DockBind {
    /// The key name as zellij's KDL spells it.
    pub kdl: &'static str,
    /// The KDL action body, without the surrounding braces.
    pub action: &'static str,
    /// The crossterm code this key arrives as, when it arrives at all.
    pub code: Option<crossterm::event::KeyCode>,
    /// Does the pane's PROGRAM still see the keystroke?
    ///
    /// Binding a key and stealing it are different: `Write`-ing the key's own
    /// escape sequence straight back to the focused pane rebinds it at the
    /// zellij level while leaving it fully available to us.
    pub reaches_pane: bool,
}

/// The dock's multiplexer-level binds (owner asks 2026-06-11 + 2026-06-17).
///
/// `Tab` is a genuine steal — it becomes zellij's native zoom toggle, so no
/// `Tab` keystroke reaches a dock pane's program. `up`/`down` are rebinds that
/// hand the key straight back: zellij 0.44 reserves plain ↑/↓ to move focus
/// between the panes of a vertical stack, so without these two the arrows never
/// reached the focused pane at all.
pub const DOCK_BINDS: &[DockBind] = &[
    DockBind {
        kdl: "Tab",
        action: "ToggleFocusFullscreen;",
        code: Some(crossterm::event::KeyCode::Tab),
        reaches_pane: false,
    },
    DockBind {
        kdl: "up",
        action: "Write 27 91 65;",
        code: Some(crossterm::event::KeyCode::Up),
        reaches_pane: true,
    },
    DockBind {
        kdl: "down",
        action: "Write 27 91 66;",
        code: Some(crossterm::event::KeyCode::Down),
        reaches_pane: true,
    },
];

/// Render [`DOCK_BINDS`] as the dock layout's KDL `keybinds` block.
///
/// Bound at the LAYOUT level so it MERGES with the user's own zellij config and
/// applies only inside this dock session.
pub fn dock_keybinds_kdl() -> String {
    keybinds_kdl(DOCK_BINDS)
}

/// Render a bind slice as a layout-level KDL `keybinds` block (merged with the
/// user's own zellij config, scoped to the one session the layout starts).
fn keybinds_kdl(binds: &[DockBind]) -> String {
    let mut s = String::from("keybinds {\n    normal {\n");
    for b in binds {
        s.push_str(&format!("        bind \"{}\" {{ {} }}\n", b.kdl, b.action));
    }
    s.push_str("    }\n}");
    s
}

/// The key that hides and shows the chat workbench's side panes, as hints
/// spell it (pui-chat-first-ux P-030).
pub const CHAT_WORKBENCH_TOGGLE_HINT: &str = "Alt+z";

/// The multiplexer-level binds of the bare-`pui` chat workbench (P-030).
///
/// One key: `Alt+z` zooms the focused pane to the whole window and back. With
/// the chat focused that is "collapse the side panes" / "bring them back".
/// zellij 0.44's default config leaves `Alt z` unbound and pui binds no Alt
/// letter, so nothing is taken from the user. `code` is `None` because
/// [`crate::keyboard::Host::swallows`] matches a bare key code, and a plain
/// `z` must keep reaching the message box.
pub const CHAT_WORKBENCH_BINDS: &[DockBind] = &[DockBind {
    kdl: "Alt z",
    action: "ToggleFocusFullscreen;",
    code: None,
    reaches_pane: false,
}];

/// Session kind of the bare-`pui` chat workbench. Unlike `wb` / `dock` it is
/// pid-keyed (`pui-chat-<pid>`, see [`chat_workbench_session_name`]).
pub const CHAT_WORKBENCH_KIND: &str = "chat";

/// The bare-`pui` chat workbench session name: `pui-chat-<launcher pid>`.
///
/// Deliberately NOT a stable attach-if-exists name like `pui-wb`. A chat
/// belongs to the directory and terminal it was started in, so a second `pui`
/// in another directory must never attach to the first one's session, and no
/// older session (a crashed chat, an old `pui-wb`) can take a launch over.
/// When the launcher dies without cleaning up, [`crate::reap::plan`]'s
/// dead-owner rule sweeps the leftover on the next launch.
pub fn chat_workbench_session_name(launcher_pid: u32) -> String {
    format!("{}-{launcher_pid}", session_name(CHAT_WORKBENCH_KIND))
}

/// Terminals narrower than this open the chat workbench with the chat zoomed
/// to the full window (side panes collapsed), so 80x24 still gets a usable
/// chat. `Alt+z` brings the panes back.
pub const CHAT_WORKBENCH_MIN_SIDE_COLS: u16 = 120;

/// Environment set by the chat-workbench launcher for the session it starts.
/// The chat pane reads it to recognise its own session (and to stop it on
/// exit); every other pane ignores it.
pub const CHAT_WORKBENCH_SESSION_ENV: &str = "PUI_CHAT_WORKBENCH";
/// Set to `1` when the launch terminal was narrower than
/// [`CHAT_WORKBENCH_MIN_SIDE_COLS`]: the chat zooms itself on start.
pub const CHAT_WORKBENCH_ZOOM_ENV: &str = "PUI_CHAT_WORKBENCH_ZOOMED";
/// Where the chat pane leaves its conversation text on exit, so the launcher
/// can print it into the real terminal's scrollback after zellij is gone
/// (the chat-first "clean scrollback" promise, P-004).
pub const CHAT_WORKBENCH_TRANSCRIPT_ENV: &str = "PUI_CHAT_WORKBENCH_TRANSCRIPT";
/// Undocumented flag only the layout's chat pane is started with. The
/// session env above is inherited by EVERY pane, so a `pui --solo` typed into
/// the work shell would otherwise also believe it owns the session and stop it
/// on exit. The flag marks the one process that does.
pub const CHAT_WORKBENCH_PANE_FLAG: &str = "--workbench-pane";

/// The bare-`pui` layout (pui-chat-first-ux P-030 / D-020): the chat is the
/// main, focused pane, and the workbench panes Avi asked to keep sit beside it
/// in one stack — the full HUD (fleet/colony, plans, mail, every tab;
/// expanded, and the owner of reactive agent-pane launches), the staged-wake
/// board, the network board, and the work shell where agent panes open.
///
/// The chat runs `pui --solo`, so it can never re-enter this launcher and nest.
/// No swap presets: they would each have to re-declare the chat pane, and the
/// one control this surface needs is the zoom toggle in
/// [`CHAT_WORKBENCH_BINDS`].
pub fn chat_workbench_kdl() -> String {
    format!(
        r#"// Papercusp chat workbench — bare `pui` (pui-chat-first-ux P-030).
// The chat is the main pane; {toggle} hides or shows the side panes.
{keybinds}
layout {{
    pane size=1 borderless=true {{
        plugin location="zellij:tab-bar"
    }}
    pane split_direction="vertical" {{
        pane name="chat" focus=true size="65%" {{
            command "pui"
            args "--solo" "{pane_flag}"
        }}
        pane name="side" stacked=true size="35%" {{
            pane name="hud" expanded=true {{
                command "pui"
                args "hud"
            }}
            pane name="wake" {{
                command "pui"
                args "wake-pane"
            }}
            pane name="network" {{
                command "pui"
                args "network-pane"
            }}
            pane name="work"
        }}
    }}
    pane size=2 borderless=true {{
        plugin location="zellij:status-bar"
    }}
}}
"#,
        toggle = CHAT_WORKBENCH_TOGGLE_HINT,
        keybinds = keybinds_kdl(CHAT_WORKBENCH_BINDS),
        pane_flag = CHAT_WORKBENCH_PANE_FLAG,
    )
}

/// Name for an app-managed zellij session: STABLE `pui-<kind>` (kind = `wb` |
/// `dock`) — P-001, own-tui-full-divorce-2026-08-24. One well-known session per
/// kind: a relaunch ATTACHES to a live survivor (crash recovery) instead of
/// leaking a fresh uniquely-named server beside it. LEGACY `pui-<kind>-<pid>`
/// sessions (the EI-186 scheme) are still recognized + swept by [`crate::reap`].
pub fn session_name(kind: &str) -> String {
    format!("pui-{kind}")
}

/// Argv to attach to an existing LIVE app-managed session (attach-if-exists,
/// P-001): plain `zellij attach <name>`.
pub fn attach_argv(session: &str) -> Vec<String> {
    vec![
        "zellij".to_string(),
        "attach".to_string(),
        session.to_string(),
    ]
}

/// Argv to start a zellij session with the workbench layout. The session is
/// explicitly named (see [`session_name`]) so exits/crashes can be reaped
/// instead of leaking an auto-named detached server. The `options` subcommand
/// layers per-session config overrides WITHOUT replacing the user's config:
/// startup tips AND first-run release notes are suppressed — these are
/// app-managed sessions (the workbench, the desktop chat dock, the bare-`pui`
/// chat workbench), and either popup floats over the app's panes blocking
/// everything until dismissed. On a machine that has never run this zellij
/// version the release-notes popup ("What's new?") covers the chat on the very
/// first `pui` (P-030 PTY acceptance, 2026-10-06).
///
/// ⚠ The layout MUST be passed as `--new-session-with-layout`, NOT `--layout`:
/// on zellij 0.44 `--layout` + `--session` does not create a session — it is
/// dispatched as "open this layout as a new tab IN the existing session
/// `<name>`" (`send_action_to_session`), which exits 1 with "There is no
/// active session!" / "Session '<name>' not found" since our freshly-named
/// session never exists yet. That regression broke every dock/workbench
/// launch when EI-186 added `--session` for reapability (2026-06-09).
pub fn launch_argv(layout_path: &str, session: &str) -> Vec<String> {
    vec![
        "zellij".to_string(),
        "--session".to_string(),
        session.to_string(),
        "--new-session-with-layout".to_string(),
        layout_path.to_string(),
        "options".to_string(),
        "--show-startup-tips".to_string(),
        "false".to_string(),
        "--show-release-notes".to_string(),
        "false".to_string(),
    ]
}

/// `PATH` for an app-managed zellij session: the directory of the `pui` that
/// starts it goes first. Every layout runs its panes as `command "pui"`, which
/// zellij resolves on `PATH`; without this a launch from `./target/debug/pui`
/// (or any `pui` that is not first on the user's `PATH`) fills its panes with
/// a DIFFERENT build — the P-030 PTY acceptance caught the chat pane running
/// an older installed `pui` that has no `--solo` and drew the dashboard
/// instead. Panes, and a `pui` typed in the work shell, now run the same
/// build as the launcher. `None` when `exe` has no directory to add.
pub fn session_path_env(
    exe: &Path,
    inherited: Option<&std::ffi::OsStr>,
) -> Option<std::ffi::OsString> {
    let dir = exe.parent().filter(|d| !d.as_os_str().is_empty())?;
    let mut dirs = vec![dir.to_path_buf()];
    if let Some(path) = inherited {
        dirs.extend(std::env::split_paths(path).filter(|d| d != dir));
    }
    std::env::join_paths(dirs).ok()
}

/// Lowercase + kdl-safe a lexicon label for use as a zellij pane `name`
/// (pui-hive-lexicon-2026-06-06). Keeps ASCII alphanumerics + dash; collapses
/// any run of other chars (spaces, etc.) to a single dash; trims dashes. So
/// "Hive Mind" → "hive-mind", "Queen" → "queen". Never returns empty (a wholly
/// unsafe label falls back to `fallback`).
fn kdl_pane_name(label: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut prev_dash = false;
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

/// The chat-only DOCK layout (native-terminal-desktop-2026-06-06 P-013 / D-011;
/// consolidated pui-dock-consolidation-2026-06-07): the surface the
/// desktop-docked native terminal runs. A **three-tab** zellij session:
///   * tab **"this hive"** (focus) — the live-TUI dock VERBATIM: the queen
///     split (`pui brain-view --queen` + her data boards) over the agent stack
///     (operator/sentinel chat, the reactive dock-driver, the fleet wake board).
///     No workbench HUD, no work-area agent panes, no swap presets.
///   * tab **"network"** — `pui network-pane`, the cross-hive capability-ladder
///     board (own hives, shared-Hive peer Swarms, foreign directory hives);
///     selecting a row drills into an on-demand per-hive tab (`hive_tab_kdl`).
///   * tab **"context"** — `pui context-pane`, the shared projection for the
///     live Sentinel (the former plans board refitted in place for P-006).
///     The tab-bar + status-bar move into a `default_tab_template` shared by all
///     tabs; "this hive" is the FIRST tab + focus=true so the dock opens where it
///     always did (and tier-1 `GoToTab(1)` lands on it). The workbench swap presets
///     are untouched.
///
/// Pane DISPLAY names route through the active Hive lexicon (`lex`): the
/// operator pane is the `operator` term (Queen). The pinned-pane ARGS
/// (`network-pane`, `wake-pane`, …) are internal identifiers and never change.
/// `_brain_argv` is retained for a future "take control" action; the ♛ queen
/// + 👁 overwatch dock panes now render the
///   READ-ONLY shared transcript view (`pui brain-view`, queen-overwatch-live-
///   visibility D-003) so every instance shows the SAME live agent and survives a
///   shell exit, instead of a per-window interactive shell. Pure (no I/O) so it is
///   unit-tested. (hive-agent-tabs P-014 retired the `pui chat-pane` flag-off dock
///   shape — the queen-split layout is the only dock now.)
pub fn chat_dock_kdl(_brain_argv: &[String], lex: &crate::lexicon::Lexicon) -> String {
    // Lexicon-resolved, kdl-safe pane display names ("chat" is fixed). Under
    // the-hive pack: operator → sentinel, brain → queen (owner naming, 2026-06-07;
    // operator renamed "Sentinel Bee"→"Sentinel" 2026-06-09 — hive-agent-tabs P-003).
    // P-010: prefix the per-type glyph into the zellij pane NAME (zellij has no
    // per-pane color — D-008 — so the glyph is how a type reads at a glance).
    // the cups stack (the driver) is infrastructure, not an agent type → unglyphed.
    use crate::agent_pane_kind::AgentPaneKind;
    let glyph_name = |term: &str, fallback: &str, kind: AgentPaneKind| {
        let n = kdl_pane_name(&lex.lex(term), fallback);
        format!("{} {n}", kind.glyph())
    };
    let sentinel_name = glyph_name("operator", "sentinel", AgentPaneKind::Sentinel);
    let brain_name = glyph_name("brain", "brain", AgentPaneKind::Queen);
    let overwatch_name = glyph_name("overwatch", "overwatch", AgentPaneKind::Overwatch);
    let this_pot_tab = format!("this {}", kdl_pane_name(&lex.lex("pot"), "pot"));
    // The Sentinel pane is a REAL psu/Claude TUI — the FRONT-DOOR Sentinel the
    // user talks to (sentinel-as-claude-tui-2026-06-22): the `sentinel` role
    // (Sentinel persona = sentinel.persona.md), NOT the `operator` placement
    // role it used to launch. It launches via the `psu-sentinel` wrapper
    // (~/.local/bin, repo src apps/operator/scripts/psu-sentinel.sh), which
    // FIRST records THIS zellij pane's id ($ZELLIJ_PANE_ID + session) to
    // ~/.papercusp/sentinel-pane so /api/operator/sentinel-input can write voice
    // straight to the Sentinel pane (Phase C pane-targeting, not the focused
    // pane), THEN execs the exact same no-picker launch:
    // `psu --no-picker --agent=claude --role=sentinel`.
    let sentinel_cmd_block = "command \"psu-sentinel\"";
    // P-014 (voice-public-release-readiness-2026-07-12, D-005/D-006): directly
    // UNDER the front-door pane sits the papercup-DEEP pane — the hidden heavy
    // half of the ONE "Papercup" identity. It launches via the
    // `psu-sentinel-deep` wrapper (repo src apps/operator/scripts/
    // psu-sentinel-deep.sh; packaged twin writeSentinelDeepShim), which records
    // THIS pane to ~/.papercusp/sentinel-deep-pane then execs
    // `psu --no-picker --agent=claude --role=papercup-deep` (default opus:xhigh,
    // override ~/.papercusp/sentinel-deep-model). D-001: its pane NAME is the
    // SAME lexed front-door label — the fast/deep split is builder detail the
    // user never sees; the deep session is parked-until-woken (the front-end
    // wakes it over coord with delegated questions), never user-facing. Same
    // Sentinel glyph/kind ⇒ same group_rank, and it sits adjacent to the
    // front pane, so the P-011 regroup never reorders it.
    // WI-4485: there is NO papercup-deep pane in the dock — not tiled, not floating.
    //
    // P-014 shipped it as a TILED SIBLING carrying the SAME "🥤 papercup" label, on the
    // theory that an identical name made the fast/deep split invisible. It does the
    // opposite: two visible identically-named panes read as a DUPLICATE. The owner
    // reported it ("why do I see 2x papercup agents ... there should only be 1").
    // The first fix attempt moved it to a `floating_panes` block with the tab's
    // hide_floating_panes=true — zellij 0.44.3 PARSES that attribute but still RENDERS
    // the pane, so the owner then saw "one in a floating panel and one in the dock". A
    // pane you cannot reliably hide is a pane you should not create.
    //
    // The deep half never needed a pane at all:
    //   - it is discovered via presence (listPresence, agentRole='papercup-deep') and
    //     woken over coord (sendMessage + wakeRecipients) — see papercup-deep-delegate-deps.ts.
    //     It NEVER takes pane input.
    //   - ~/.papercusp/sentinel-deep-pane (which the psu-sentinel-deep shim writes) is
    //     WRITE-ONLY — nothing in the tree reads it. It was copy-pasted from the
    //     front-door pane, whose ~/.papercusp/sentinel-pane IS read (voice pane-targeting).
    //   - papercup-deep-delegate.ts documents the no-pane configuration as SUPPORTED and
    //     TESTED: "FALLBACK (kept for the NO-DEEP-PANE case): when NO live papercup-deep
    //     session exists, spawn an EPHEMERAL background agent with the question as its
    //     brief — same work_item, same answer-return seam."
    // So deep thinking still works with zero dock surface: the delegate spawns the deep
    // agent on demand. D-001's "the fast/deep split must never be visible in the dock" is
    // honoured by NOT PUTTING IT IN THE DOCK — the only way that actually holds.
    // P-004 / D-009: the operator pane is psu, so the reactive agent stack has a
    // dedicated driver — the `pui dock-driver` pane runs the reactive loop
    // (dock_agent_panes) and renders the fleet roster as the dock's controller.
    // The bee panes it appends resume as real Claude TUIs
    // (RosterEntry::dock_pane_argv → claude --resume). Named via the `fleet`
    // lexicon term.
    let driver_name = kdl_pane_name(&lex.lex("fleet"), "fleet");
    // The worker-stack CONTAINER (was "🐝 colony", old bee-brand). It is
    // infrastructure, not an agent type, so it MUST stay UNGLYPHED — every cup
    // glyph (☕🍵🫖🥤) is a kind-glyph, and a 🍵 prefix here makes
    // AgentPaneKind::from_glyph_prefix mis-read the driver as a worker Bee/Cup and
    // pull it into the P-011 regroup (the icon-pass 🐝→cup-glyph sed, 7beaba771c, did
    // exactly that). Lexicon-routed so it reads "cups"/"bees" per active pack.
    let cups_name = kdl_pane_name(&lex.lex_plural("contributor"), "cups");
    // 12-space indent: the driver is a member of the `chat` stack, which is
    // nested one level deep inside the queen|stack split.
    let driver_pane_block = format!(
        "\n            pane name=\"{driver_name}\" {{\n                command \"pui\"\n                args \"dock-driver\"\n            }}"
    );
    // The fleet-wide staged-wake board (EI-312): every manual-mode agent's
    // pending wakes (queen first) with release / edit / skip + the release-all/
    // skip-all drains. A stack member alongside the bees + driver (the wake-mode
    // UI, P-008/P-009).
    let wake_pane_block =
        "\n            pane name=\"⏸ wakes\" {\n                command \"pui\"\n                args \"wake-pane\"\n            }";
    // The dock body between the tab-bar and status-bar (hive-agent-tabs flag
    // RETIRED 2026-06-12 — the flag-on shape is the only shape; the classic
    // pui-chat-pane single stack is gone with it):
    //
    // EVERY agent chat in the dock is a LIVE TUI (owner directive 2026-06-11)
    // — never a pui-rendered substitute. The QUEEN is now the shared read-only
    // brain view with her staged-wake board (`pui wake-pane --queen`) in a pane
    // directly beside it (zellij owns the split). A one-pane pui-internal
    // [chat | wakes] split (`pui agent-pane`) was tried 2026-06-11 and REVERTED:
    // pui could only render a DIFFERENT conversation (the sentinel's), which
    // both showed the wrong agent and dropped the interactive queen. Below her:
    // the agent
    // STACK — the sentinel (ElevenLabs voice) psu chat, the dock-driver (which
    // reactively appends one live `claude --resume` TUI per bee), and the
    // fleet-wide wake board (per-bee queues grouped there).
    //
    // The queen's side column (dock 4-pane split, owner ask 2026-06-11): the
    // 38% column right of her chat is FOUR stacked data boards — the prompt
    // the agent runs on (brief led first), the staged-wake queue, her coord mail, and her
    // work items + plan linkage. Each is its own `pui <x>-pane --queen`
    // process (one pinned Tab each); zellij owns the vertical stack.
    // overwatch-role-2026-06-15 (owner ask 2026-06-15): the OVERWATCH supervisor's
    // interactive pane sits ABOVE the ♛ queen block — a fully-scoped no-picker psu
    // launch as role=overwatch, mirroring the sentinel pane's --role=operator launch
    // (--role=overwatch MUST use `=`; psu-launcher drops a space-separated --role).
    // 👁 glyph + indigo identity come from AgentPaneKind::Overwatch (B-01). It is the
    // Queen's sibling system-health supervisor. Pane order (owner ask 2026-06-22):
    // top-to-bottom: 🥤 sentinel (the front-door agent leads the dock), 🫖 overwatch,
    // ☕ mug, cups (dock-driver + its worker TUIs), ⏸ wakes.
    //
    // WI-4485 — the papercup-DEEP pane is NOT in this tiled list. P-014 originally
    // emitted it as a TILED SIBLING at 12% carrying the SAME "🥤 papercup" label
    // (front 40% → 28% to make room), on the theory that an identical label made the
    // fast/deep split invisible. It does the OPPOSITE: two visible identically-named
    // panes read as a DUPLICATE — strictly worse than a distinct name — and the owner
    // reported exactly that ("why do I see 2x papercup agents ... there should only be
    // 1", 2026-07-13). Same-naming conceals nothing; only NOT RENDERING it does.
    // D-001 says the split "must never be visible in the dock" and the deep half is
    // "never user-facing" (it speaks only over coord), so the deep pane is now a
    // HIDDEN FLOATING pane (see `sentinel_deep_floating_block` + the tab's
    // hide_floating_panes=true) and the front pane takes its 12% back (28% → 40%).
    // Falsification-tested on zellij 0.44.3: a pane declared in `floating_panes` under
    // a `hide_floating_panes=true` tab STILL LAUNCHES ITS COMMAND — so the deep session
    // still starts, still records ~/.papercusp/sentinel-deep-pane, and stays wakeable
    // over coord. That was the load-bearing risk; a deep half that never launched would
    // be a far worse regression than a cosmetic duplicate.
    // The Mug's stacked sub-panes (prompt/wakes/mail/work) are glyph-PREFIXED with the
    // Mug's own kind-glyph so AgentPaneKind::from_glyph_prefix regroups them with the
    // Mug (P-011), not as loose panes. DERIVE it — these four used to hardcode the
    // literal, so when the owner swapped the Mug/Cup glyphs (2026-07-12) they silently
    // kept the CUP's glyph and would have regrouped as workers. One source of truth.
    let q = AgentPaneKind::Queen.glyph();
    let dock_body = {
        format!(
            r#"    pane split_direction="horizontal" {{
        pane name="{sentinel_name}" focus=true size="40%" {{
            {sentinel_cmd_block}
        }}
        pane name="{overwatch_name}" size="12%" {{
            command "pui"
            args "brain-view" "--overwatch"
        }}
        pane name="{brain_name}" split_direction="vertical" size="30%" {{
            pane name="{brain_name}" {{
                command "pui"
                args "brain-view" "--queen"
            }}
            pane stacked=true size="38%" {{
                pane name="{q}✉ prompt" expanded=true {{
                    command "pui"
                    args "prompt-pane" "--mug"
                }}
                pane name="{q}⏸ wakes" {{
                    command "pui"
                    args "wake-pane" "--mug"
                }}
                pane name="{q}✉ mail" {{
                    command "pui"
                    args "mail-pane" "--mug"
                }}
                pane name="{q}☑ work" {{
                    command "pui"
                    args "work-pane" "--mug"
                }}
            }}
        }}
        pane name="{cups_name}" stacked=true size="12%" {{{driver_pane_block}
        }}{wake_pane_block}
    }}"#
        )
    };
    let keybinds = dock_keybinds_kdl();
    format!(
        r#"// Papercusp chat dock (owner directive 2026-06-11): every agent chat is a
// LIVE TUI. The QUEEN is the shared read-only `pui brain-view --queen` pane with
// her staged-wake board directly beside it; below her, the agent
// STACK — the operator (ElevenLabs voice) sentinel chat, the dock-driver that
// reactively appends one live `claude --resume` TUI per bee, and the fleet-wide
// wake board. Alt+↑/↓ (or clicking a title bar) scrolls the stack through ALL
// active agents. Pane display names route through the lexicon. (The
// hive-agent-tabs flag is RETIRED — this shape is the only shape.)
//
// Dock tabs: the dock is a THREE-TAB zellij session.
// Tab 1 "this hive" holds the whole dock above VERBATIM (the queen split /
// agent stack — nothing about it changed); tab 2 "network" hosts `pui
// network-pane`, the cross-hive capability-ladder board; tab 3 "context" hosts
// `pui context-pane`, the canonical conversation-context projection. The tab-bar + status-bar move into
// a `default_tab_template` so ALL tabs carry them; "this hive" is the first tab
// + focus=true so the dock opens exactly where it always did. Selecting a row
// in the network board opens an on-demand per-hive drill-in tab (see
// `hive_tab_kdl`). The workbench swap presets are untouched.
//
// Tab → fullscreen the focused pane (owner ask 2026-06-11): focus an agent
// chat and press Tab to zoom it full (hiding its wakes pane + the rest); Tab
// again restores the split. zellij `ToggleFocusFullscreen` is its native zoom,
// bound here at the LAYOUT level so it MERGES with the user's config and applies
// only inside this dock session. Trade-off: plain Tab no longer reaches a pane's
// program here (it's the zoom toggle) — but Shift+Tab is a separate bind, so
// Claude's permission-mode toggle is unaffected; only plain-Tab prompt
// completion in the chat panes is given up.
//
// ↑/↓ → the focused PANE, not the stack (owner ask 2026-06-17): the chat group
// is a vertical `stacked=true` group (sentinel/colony/wakes), and zellij 0.44
// reserves plain ↑/↓ to move focus BETWEEN stacked panes — so they never reach
// the focused pane's program (e.g. the Colony pane's two-level pane nav, which
// is why only ←/→ worked there). The dock's stack scroll is `Alt+↑/↓` (the agent
// stack nav), so plain ↑/↓ belong to the pane: re-bind them to `Write` the CSI
// cursor-up/down sequences (ESC[A / ESC[B) straight to the focused pane. This
// also makes ↑/↓ reach the psu/claude chat panes for history/scroll. ←/→ already
// reach the pane (no vertical-stack meaning), so they're left alone.
{keybinds}
layout {{
    default_tab_template {{
        pane size=1 borderless=true {{
            plugin location="zellij:tab-bar"
        }}
        children
        pane size=2 borderless=true {{
            plugin location="zellij:status-bar"
        }}
    }}
    tab name="{this_pot_tab}" focus=true {{
{dock_body}
    }}
    tab name="network" {{
        pane name="network" {{
            command "pui"
            args "network-pane"
        }}
    }}
    tab name="context" {{
        pane name="context" {{
            command "pui"
            args "context-pane"
        }}
    }}
}}
"#
    )
}

/// A deployed frame's zellij TAB layout (hive-agent-tabs P-013): one tab named
/// for the frame, holding a single shell pane as the placeholder. (P-014
/// retired the read-only `pui watch-pane` surface, and remote agents have no
/// local PTY to attach a real TUI to — so the frame tab is a marker; the
/// remote agents' live view is the STREAMED desktop in the webview Frames tab,
/// `hive-frame-desktops-live-view`.) Pure (no I/O) — unit-tested. The
/// companion's `new_tabs_with_layout` consumes the whole `layout { tab … }`
/// string.
pub fn frame_tab_kdl(tab_name: &str) -> String {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        r#"layout {{
    tab name="{name}" {{
        pane size=1 borderless=true {{
            plugin location="zellij:tab-bar"
        }}
        pane {{
            pane
        }}
        pane size=2 borderless=true {{
            plugin location="zellij:status-bar"
        }}
    }}
}}
"#,
        name = esc(tab_name),
    )
}

/// The input to [`hive_tab_kdl`] — a selected `network`-board row reduced to
/// what the per-hive drill-in tab needs (hive-network-surface-2026-06-11 P-008 /
/// B-10). B-09's network-pane Enter handler maps a C-3 `NetworkBoardRow` into
/// this and sends `Command::NewTab { name: hive_tab_name(&spec), layout: hive_tab_kdl(&spec) }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HiveTabSpec {
    /// The C-3 capability tier (1|2|3|4). Tiers 2/3 are substrate-backed (own
    /// hives / shared-Hive peer Swarms); tier 4 is a foreign directory hive.
    /// Tier 1 is the local hive — the dock's own "this hive" tab — which B-09
    /// routes to GoToTab(1), never here (treated as substrate if it ever lands).
    pub tier: u8,
    /// The C-3 row key — a hive slug (tiers 1–2) or a peer pubkey-b64 (tiers
    /// 3–4). Passed to the pui detail/watch panes as-is; NOT lexicon-routed.
    pub key: String,
    /// The C-3 row title — the human label shown in the tab + detail-pane name.
    pub title: String,
}

/// The zellij tab name for a per-hive drill-in (P-008). The ⌕ prefix marks it a
/// drill-in (distinct from the dock's "this hive"/"network" tabs and the ☁
/// frame tabs) and keeps it from colliding with a user-named tab. Names by the
/// row title, falling back to the key when the title is blank. B-09 passes this
/// as the companion `Command::NewTab { name }` so it matches the KDL's own
/// `tab name=`. Pure.
pub fn hive_tab_name(spec: &HiveTabSpec) -> String {
    let label = if spec.title.trim().is_empty() {
        spec.key.as_str()
    } else {
        spec.title.as_str()
    };
    format!("⌕ {label}")
}

/// One on-demand per-hive DRILL-IN tab (hive-network-surface-2026-06-11 P-008 /
/// B-10), opened when a row in the `network` board (`pui network-pane`) is
/// selected. Mirrors [`frame_tab_kdl`]: a standalone `layout {{ tab … }}` string
/// the companion's `new_tabs_with_layout` injects into the running dock session.
///
/// Composition rides the capability ladder (D-001) via `spec.tier`:
///   * tiers 2/3 (own hives / shared-Hive peer Swarms — substrate-backed): the
///     `pui hive-pane <key>` queen-status / live-counts DETAIL pane (focused).
///     (Per-bee read-only watch panes rode here until hive-agent-tabs P-014
///     retired the `pui watch-pane` surface — live-bee counts stay on the
///     detail pane.)
///   * tier 2 ONLY additionally gets the hive-scoped WAKE board pane
///     (`pui wake-pane --hive <key>`, P-014 item 3 / D-007 GAP 1 closed):
///     tier-2 keys are hive slugs the `network.hive.wakes` query scopes by.
///     Tier-3 keys are peer DEVICE pubkeys — that peer's wake queue lives in
///     their PG, not ours, so tier 3 keeps the detail-header wake summary.
///   * tier 4 (foreign directory hives): a lone `pui hive-pane <key>` DOSSIER
///     (tier badge, trust, beacon fields, grants in/out, ask counts from the
///     C-3 row, plus beacon HISTORY + the C-1 ask log via the dossier
///     queries — P-014 item 2 / D-007 GAP 2 closed).
///
/// Every pane is `close_on_exit=true` — the drill-in tab is never auto-opened
/// and tears itself down when its panes exit (no EXITED husk). The detail pane
/// invokes `pui hive-pane <key>`, rendered tier-aware by B-09. Pure — unit-tested.
pub fn hive_tab_kdl(spec: &HiveTabSpec) -> String {
    // The transient drill-in (P-008): ⌕-named, close-on-exit so it tears down.
    hive_tab_kdl_named(spec, &hive_tab_name(spec), true)
}

/// The zellij tab name for a PERSISTENT per-hive AXIS tab (B4 / P-004). The ◆
/// prefix marks it a STANDING hive tab — distinct from the ⌕ transient drill-in
/// (P-008), the ☁ frame tabs, and the plain "this hive"/"network" dock tabs — so
/// the axis reads as a coherent group and a persistent tab never collides with a
/// transient drill-in of the same hive. Pure.
pub fn hive_axis_tab_name(spec: &HiveTabSpec) -> String {
    let label = if spec.title.trim().is_empty() {
        spec.key.as_str()
    } else {
        spec.title.as_str()
    };
    format!("◆ {label}")
}

/// One PERSISTENT per-hive AXIS tab (B4 / P-004): the same tier-aware pane
/// composition as the transient drill-in [`hive_tab_kdl`], but ◆-named and NOT
/// close-on-exit — it stays for as long as the hive is on the axis (the sync diff
/// in `main.rs` opens it when the hive appears and lets it ride until the hive
/// goes quiet). B5 (P-005) adds the presence-roster pane inside it. Pure.
pub fn hive_axis_tab_kdl(spec: &HiveTabSpec) -> String {
    hive_tab_kdl_named(spec, &hive_axis_tab_name(spec), false)
}

/// Shared generator for the per-hive tab KDL — the transient drill-in
/// ([`hive_tab_kdl`], close-on-exit) and the persistent axis tab
/// ([`hive_axis_tab_kdl`]) differ only in their tab NAME and whether the panes
/// close on exit, so they share this body (no duplicated KDL). Pure.
fn hive_tab_kdl_named(spec: &HiveTabSpec, tab_name: &str, close_on_exit: bool) -> String {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let tab = esc(tab_name);
    let key = esc(&spec.key);
    let detail_label = esc(if spec.title.trim().is_empty() {
        spec.key.as_str()
    } else {
        spec.title.as_str()
    });
    // tier 2 only: the hive-scoped wake board (`network.hive.wakes` scopes by
    // hive SLUG — exactly the tier-2 key; tier-3 keys are peer device pubkeys
    // whose wake queues aren't in our PG).
    let wake_pane = spec.tier == 2;
    // A stack needs ≥2 children (zellij is picky about a one-pane stack); the
    // lead (detail) pane is the expanded one.
    let stacked = wake_pane;
    let detail_attrs = if stacked {
        "focus=true expanded=true"
    } else {
        "focus=true"
    };
    // A persistent axis tab omits close_on_exit so it rides the hive's lifetime;
    // the transient drill-in keeps it so it leaves no EXITED husk.
    let coe = if close_on_exit {
        " close_on_exit=true"
    } else {
        ""
    };
    let mut panes = format!(
        "\n            pane name=\"{detail_label}\" {detail_attrs}{coe} {{\n                command \"pui\"\n                args \"hive-pane\" \"{key}\"\n            }}",
    );
    if wake_pane {
        panes.push_str(&format!(
            "\n            pane name=\"⏸ wakes\"{coe} {{\n                command \"pui\"\n                args \"wake-pane\" \"--hive\" \"{key}\"\n            }}",
        ));
    }
    let stacked_attr = if stacked { " stacked=true" } else { "" };
    format!(
        r#"layout {{
    tab name="{tab}" {{
        pane size=1 borderless=true {{
            plugin location="zellij:tab-bar"
        }}
        pane{stacked_attr} {{{panes}
        }}
        pane size=2 borderless=true {{
            plugin location="zellij:status-bar"
        }}
    }}
}}
"#,
    )
}

/// The PERSISTENT per-hive tab axis (B4 / shared-hive-collaboration P-004): which
/// hives earn a STANDING dock tab, as opposed to the on-demand ⌕ drill-in (P-008,
/// transient/close-on-exit). Owner decision (2026-06-14): member hives + LIVE
/// federated peers. So a quiet/stale hive drops OFF the axis (the sync diff in
/// `main.rs` retires its tab), and self-reported gossip never earns one (it stays
/// browseable on the Network board until a join admits it).
///
/// One [`HiveTabSpec`] per LIVE federated peer device (C-3 tier 3, substrate-
/// verified — the only multi-hive source the TUI roster carries today). The LOCAL
/// hive is the dock's own `this hive` tab (tier 1, always first) and is
/// intentionally NOT re-emitted here. Pure (no I/O) — `main.rs` diffs this against
/// the open tab set (`hive_tabs_to_create`, mirroring the frame-tab reactive-open)
/// and opens each missing one with the persistent KDL; B5 (P-005) renders the
/// presence roster inside the tab.
pub fn desired_hive_tabs(groups: &[HiveGroup]) -> Vec<HiveTabSpec> {
    groups
        .iter()
        .filter(|g| !g.stale) // the axis tracks who is ACTUALLY here — a quiet hive's tab is retired
        .map(|g| {
            let key = if g.device_pubkey.is_empty() {
                g.machine.clone()
            } else {
                g.device_pubkey.clone()
            };
            let title = if g.machine.is_empty() {
                key.clone()
            } else {
                g.machine.clone()
            };
            HiveTabSpec {
                tier: 3,
                key,
                title,
            }
        })
        .collect()
}

/// The chat dock's brain-pane command fallback. `psu --brain` was retired on
/// 2026-06-21, so the default is the backend-neutral read-only brain view.
/// `env` is PAPERCUSP_BRAIN_CMD's value when set — a whitespace-split
/// full-command override. Pure — unit-tested.
pub fn default_brain_argv(env: Option<&str>) -> Vec<String> {
    match env {
        Some(s) if !s.trim().is_empty() => s.split_whitespace().map(|x| x.to_string()).collect(),
        _ => vec![
            "pui".to_string(),
            "brain-view".to_string(),
            "--queen".to_string(),
        ],
    }
}

fn base_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".papercusp"))
}

/// Write the workbench KDL to `~/.papercusp/pui-workbench.kdl` and return it.
pub fn materialize() -> std::io::Result<PathBuf> {
    let base = base_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?;
    materialize_at(&base)
}

fn materialize_at(base: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(base)?;
    let path = base.join("pui-workbench.kdl");
    std::fs::write(&path, WORKBENCH_KDL)?;
    Ok(path)
}

/// Write the bare-`pui` chat-workbench KDL to
/// `~/.papercusp/pui-chat-workbench.kdl` and return it (P-030).
pub fn materialize_chat_workbench() -> std::io::Result<PathBuf> {
    let base = base_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?;
    materialize_chat_workbench_at(&base)
}

fn materialize_chat_workbench_at(base: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(base)?;
    let path = base.join("pui-chat-workbench.kdl");
    std::fs::write(&path, chat_workbench_kdl())?;
    Ok(path)
}

/// Is terminal pane `pane_id` fullscreen, per `zellij action list-panes
/// --json --state` output? `None` when the output does not parse or does not
/// list that pane (yet). Plugin panes share the id space, so only
/// `is_plugin: false` entries match.
pub fn pane_fullscreen(list_panes_json: &[u8], pane_id: u64) -> Option<bool> {
    let panes: Vec<serde_json::Value> = serde_json::from_slice(list_panes_json).ok()?;
    panes
        .iter()
        .find(|p| {
            p.get("is_plugin").and_then(serde_json::Value::as_bool) == Some(false)
                && p.get("id").and_then(serde_json::Value::as_u64) == Some(pane_id)
        })
        .and_then(|p| p.get("is_fullscreen").and_then(serde_json::Value::as_bool))
}

/// zellij settings for pui's own sessions, used ONLY when the user has no
/// zellij config of their own ([`user_zellij_config_exists`]).
pub const SESSION_ZELLIJ_CONFIG_KDL: &str = "// Papercusp: zellij settings for pui's own sessions.\n\
// Used only while you have no zellij config of your own; create\n\
// ~/.config/zellij/config.kdl and pui uses yours instead.\n\
show_startup_tips false\n\
show_release_notes false\n";

/// Does the user have a zellij config of their own? Mirrors where zellij
/// looks for `config.kdl`: `$ZELLIJ_CONFIG_FILE`, `$ZELLIJ_CONFIG_DIR`,
/// `$XDG_CONFIG_HOME/zellij` (default `~/.config/zellij`), `/etc/zellij`.
///
/// With none, zellij 0.44 opens its first-run `configuration` wizard as a
/// FOCUSED floating pane over the layout, so on a new machine the first keys
/// typed into bare `pui` went to zellij's wizard instead of the chat, and
/// the chat's own zoom-on-start landed on the wizard (P-030 PTY acceptance,
/// measured 2026-10-06 with `zellij action list-panes --json --all`).
pub fn user_zellij_config_exists(
    env: impl Fn(&str) -> Option<String>,
    home: Option<&Path>,
    is_file: impl Fn(&Path) -> bool,
) -> bool {
    let set = |key: &str| env(key).filter(|v| !v.is_empty());
    if set("ZELLIJ_CONFIG_FILE").is_some() {
        return true;
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = set("ZELLIJ_CONFIG_DIR") {
        dirs.push(PathBuf::from(dir));
    }
    match set("XDG_CONFIG_HOME") {
        Some(xdg) => dirs.push(Path::new(&xdg).join("zellij")),
        None => dirs.extend(home.map(|h| h.join(".config").join("zellij"))),
    }
    dirs.push(PathBuf::from("/etc/zellij"));
    dirs.iter().any(|dir| is_file(&dir.join("config.kdl")))
}

/// The `ZELLIJ_CONFIG_DIR` for an app-managed session: `None` when the user
/// has a zellij config of their own (theirs is never overridden), otherwise
/// `~/.papercusp/zellij` with [`SESSION_ZELLIJ_CONFIG_KDL`] written into it.
pub fn session_config_dir() -> Option<PathBuf> {
    let home = dirs::home_dir();
    if user_zellij_config_exists(|k| std::env::var(k).ok(), home.as_deref(), Path::is_file) {
        return None;
    }
    materialize_session_config_at(&base_dir()?).ok()
}

fn materialize_session_config_at(base: &Path) -> std::io::Result<PathBuf> {
    let dir = base.join("zellij");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("config.kdl"), SESSION_ZELLIJ_CONFIG_KDL)?;
    Ok(dir)
}

/// Write the chat-dock KDL (for `brain_argv`, with pane names resolved through
/// `lex`) to `~/.papercusp/pui-chat-dock.kdl` and return it. Launched the same
/// way as the workbench (`launch_argv`). (P-013 / pui-hive-lexicon-2026-06-06)
pub fn materialize_chat_dock(
    brain_argv: &[String],
    lex: &crate::lexicon::Lexicon,
) -> std::io::Result<PathBuf> {
    let base = base_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?;
    materialize_chat_dock_at(&base, brain_argv, lex)
}

fn materialize_chat_dock_at(
    base: &Path,
    brain_argv: &[String],
    lex: &crate::lexicon::Lexicon,
) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(base)?;
    let path = base.join("pui-chat-dock.kdl");
    std::fs::write(&path, chat_dock_kdl(brain_argv, lex))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DRIFT GUARD (P-007). The dock's KDL binds and
    /// `crate::keyboard::Host::swallows` are two readings of one fact, so they
    /// are generated from one slice. This asserts the KDL carries EXACTLY the
    /// binds `DOCK_BINDS` declares — no more (a hand-added bind would steal a key
    /// `swallows` still reports as arriving) and no fewer.
    #[test]
    fn the_dock_kdl_binds_exactly_what_dock_binds_declares() {
        let kdl = chat_dock_kdl(&[], &crate::lexicon::Lexicon::default());
        let bound: Vec<&str> = kdl
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("bind \""))
            .collect();
        assert_eq!(
            bound.len(),
            DOCK_BINDS.len(),
            "dock KDL has {} bind lines but DOCK_BINDS declares {}: {bound:?}",
            bound.len(),
            DOCK_BINDS.len()
        );
        for b in DOCK_BINDS {
            let expected = format!("bind \"{}\" {{ {} }}", b.kdl, b.action);
            assert!(
                bound.contains(&expected.as_str()),
                "DOCK_BINDS declares {expected:?} but the dock KDL has {bound:?}"
            );
        }
    }

    /// CALIBRATION for the guard above: it must be able to FAIL. An empty slice
    /// would make the equality trivially true against a KDL with no binds, and a
    /// `Tab` entry marked `reaches_pane` would make `swallows` answer false for
    /// the one key the dock genuinely steals — the whole reason the slice exists.
    #[test]
    fn dock_binds_is_non_empty_and_tab_is_marked_stolen() {
        assert!(!DOCK_BINDS.is_empty());
        let tab = DOCK_BINDS
            .iter()
            .find(|b| b.code == Some(crossterm::event::KeyCode::Tab))
            .expect("the dock binds Tab");
        assert!(
            !tab.reaches_pane,
            "Tab is bound to zellij's zoom toggle, so it never reaches the pane"
        );
        assert!(
            DOCK_BINDS.iter().any(|b| b.reaches_pane),
            "the ↑/↓ rebinds DO reach the pane — if none does, `swallows` has \
             collapsed into `is bound`"
        );
    }

    /// The `command "pui"` panes of a KDL and the args line under each, in order.
    fn pui_panes(kdl: &str) -> Vec<(String, Option<String>)> {
        let lines: Vec<&str> = kdl.lines().map(str::trim).collect();
        let mut out = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if *line == "command \"pui\"" {
                let opener = lines[..i]
                    .iter()
                    .rev()
                    .find(|l| l.starts_with("pane "))
                    .copied()
                    .unwrap_or_default()
                    .to_string();
                let args = lines
                    .get(i + 1)
                    .and_then(|l| l.strip_prefix("args "))
                    .map(str::to_string);
                out.push((opener, args));
            }
        }
        out
    }

    /// P-030: bare `pui` opens the chat as the main FOCUSED pane, running the
    /// chat-only mode — so it can never re-enter the launcher and nest zellij.
    #[test]
    fn chat_workbench_focuses_a_solo_chat_and_never_nests() {
        let kdl = chat_workbench_kdl();
        let panes = pui_panes(&kdl);
        let chat = panes
            .iter()
            .find(|(opener, _)| opener.contains("name=\"chat\""))
            .expect("the layout has a chat pane");
        assert!(chat.0.contains("focus=true"), "the chat is focused: {chat:?}");
        assert_eq!(
            chat.1.as_deref(),
            Some(format!("\"--solo\" \"{CHAT_WORKBENCH_PANE_FLAG}\"").as_str())
        );
        // Only the chat pane carries the session-owner flag.
        assert_eq!(kdl.matches(CHAT_WORKBENCH_PANE_FLAG).count(), 1);
        // Exactly one focused pane, and it is the chat.
        assert_eq!(kdl.matches("focus=true").count(), 1, "{kdl}");
        // Every pui pane carries args: a bare `pui` pane would launch this
        // same workbench inside itself.
        for (opener, args) in &panes {
            assert!(args.is_some(), "pane {opener:?} runs bare `pui`");
        }
    }

    /// P-030 / #1277 "retain the extra zellij panes": the HUD (every tab, and
    /// the reactive agent-launch owner), the wake and network boards and the
    /// work shell all sit beside the chat, stacked, with the HUD expanded.
    #[test]
    fn chat_workbench_keeps_the_workbench_panes_beside_the_chat() {
        let kdl = chat_workbench_kdl();
        let args: Vec<String> = pui_panes(&kdl)
            .into_iter()
            .filter_map(|(_, a)| a)
            .collect();
        for wanted in ["\"hud\"", "\"wake-pane\"", "\"network-pane\""] {
            assert!(args.iter().any(|a| a == wanted), "missing {wanted}: {args:?}");
        }
        assert!(kdl.contains("pane name=\"side\" stacked=true"));
        assert!(kdl.contains("pane name=\"hud\" expanded=true"));
        assert!(kdl.contains("pane name=\"work\""));
        assert!(kdl.contains("zellij:tab-bar") && kdl.contains("zellij:status-bar"));
        // Exactly one pane is the reactive launch owner (`pui hud`): two would
        // race to open the same agent pane (EI-358).
        assert_eq!(args.iter().filter(|a| *a == "\"hud\"").count(), 1);
    }

    /// DRIFT GUARD: the chat workbench KDL binds exactly CHAT_WORKBENCH_BINDS,
    /// and the one bind is the zoom toggle on Alt+z, which the hint names.
    #[test]
    fn chat_workbench_binds_exactly_the_zoom_toggle() {
        let kdl = chat_workbench_kdl();
        let bound: Vec<&str> = kdl
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("bind \""))
            .collect();
        assert_eq!(bound, vec!["bind \"Alt z\" { ToggleFocusFullscreen; }"]);
        assert_eq!(CHAT_WORKBENCH_BINDS.len(), 1);
        assert_eq!(CHAT_WORKBENCH_TOGGLE_HINT, "Alt+z");
        // A plain `z` must still reach the message box.
        assert!(CHAT_WORKBENCH_BINDS.iter().all(|b| b.code.is_none()));
        assert!(kdl.find("keybinds {").unwrap() < kdl.find("layout {").unwrap());
    }

    /// The session name is pid-keyed, so the reaper's dead-owner rule applies to
    /// it and the stable-name attach path never does.
    #[test]
    fn chat_workbench_session_is_pid_keyed() {
        let name = chat_workbench_session_name(4242);
        assert_eq!(name, "pui-chat-4242");
        assert_eq!(crate::reap::owner_pid(&name), Some(4242));
        assert_eq!(crate::reap::session_kind(&name), Some(CHAT_WORKBENCH_KIND));
        assert_eq!(crate::reap::stable_kind(&name), None);
    }

    /// "A stale pui-wb session must never hijack the launch": a chat launch
    /// sweeps a leftover chat whose launcher died, leaves a live peer chat and
    /// the user's live `pui-wb` alone, and has nothing to attach to.
    #[test]
    fn chat_workbench_launch_reaps_dead_chats_and_leaves_live_sessions() {
        let own = chat_workbench_session_name(10);
        let list = "pui-chat-11 [Created 1h ago]\n\
                    pui-chat-12 [Created 2h ago]\n\
                    pui-chat-13 [Created 3h ago] (EXITED - attach to resurrect)\n\
                    pui-wb [Created 1d ago]\n\
                    pui-chat-10 [Created 5m ago]\n\
                    likable-petunia [Created 1d ago]\n";
        let actions = crate::reap::plan(list, &own, |pid| pid == 12);
        assert_eq!(
            actions,
            vec![
                crate::reap::Action::KillAndDelete("pui-chat-11".into()),
                crate::reap::Action::Delete("pui-chat-13".into()),
            ]
        );
    }

    #[test]
    fn materialize_chat_workbench_writes_the_layout() {
        let dir = std::env::temp_dir().join(format!("pui-chat-wb-{}", std::process::id()));
        let path = materialize_chat_workbench_at(&dir).expect("materialize");
        assert_eq!(path.file_name().unwrap(), "pui-chat-workbench.kdl");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), chat_workbench_kdl());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn kdl_defines_pui_and_work_panes() {
        assert!(WORKBENCH_KDL.contains("command \"pui\""));
        assert!(WORKBENCH_KDL.contains("args \"hud\"")); // HUD pane runs `pui hud`, never bare `pui` (no nesting)
        assert!(WORKBENCH_KDL.contains("name=\"work\""));
        assert!(WORKBENCH_KDL.contains("name=\"pui\""));
        assert!(WORKBENCH_KDL.contains("layout {"));
    }

    #[test]
    fn base_work_area_is_stacked_by_default() {
        // The base arrangement (before any swap) opens docked-and-stacked so N
        // agents are tab-like, not ever-thinner tiles (Brief 50 / D-001).
        assert!(WORKBENCH_KDL.contains("name=\"work\" stacked=true"));
    }

    #[test]
    fn launch_puts_the_full_tui_in_the_primary_focused_pane() {
        let base = WORKBENCH_KDL
            .split_once("swap_tiled_layout")
            .map(|(base, _)| base)
            .expect("workbench declares swap layouts after its base layout");
        let pui = base
            .find("pane name=\"pui\" focus=true size=\"70%\"")
            .expect("base layout must make pui the focused primary pane");
        let work = base
            .find("pane name=\"work\" stacked=true size=\"30%\"")
            .expect("base layout must keep a smaller stacked work area");
        assert!(pui < work, "pui must precede the auxiliary work area");

        let stacked = WORKBENCH_KDL
            .split_once("swap_tiled_layout name=\"stacked\"")
            .map(|(_, stacked)| stacked)
            .expect("stacked preset exists");
        assert!(stacked.contains("pane name=\"pui\" focus=true size=\"70%\""));
        assert!(stacked.contains("pane name=\"work\" stacked=true size=\"30%\""));
    }

    #[test]
    fn declares_all_four_swap_presets_in_cycle_order() {
        for name in SWAP_PRESETS {
            assert!(
                WORKBENCH_KDL.contains(&format!("swap_tiled_layout name=\"{name}\"")),
                "missing swap preset {name}"
            );
        }
        // SWAP_PRESETS order matches the order they appear in the KDL (so the
        // label pui shows tracks the actual Alt+[/] cycle).
        let mut last = 0usize;
        for name in SWAP_PRESETS {
            let at = WORKBENCH_KDL
                .find(&format!("swap_tiled_layout name=\"{name}\""))
                .unwrap();
            assert!(at >= last, "preset {name} out of cycle order");
            last = at;
        }
        // The default (first) preset is `stacked`.
        assert_eq!(SWAP_PRESETS.first().copied(), Some("stacked"));
    }

    #[test]
    fn every_preset_keeps_the_hud_and_a_children_placeholder() {
        // Each swap preset re-declares the HUD command pane (so a swap re-slots
        // it, D-007) and has exactly one `children` placeholder for runtime panes.
        // 4 presets + the base arrangement = 5 HUD command panes.
        assert_eq!(WORKBENCH_KDL.matches("command \"pui\"").count(), 5);
        // One `children` per preset (the base uses a bare `pane`, not children).
        assert_eq!(
            WORKBENCH_KDL.matches("children").count(),
            SWAP_PRESETS.len()
        );
        // Both stacked presets keep the work group stacked.
        assert_eq!(
            WORKBENCH_KDL.matches("stacked=true").count(),
            3 // base + `stacked` + `stacked-left`
        );
        // `split` lays the work area out as rows; `grid` leaves it unconstrained
        // (no split_direction → zellij's adaptive 2D BSP tiling).
        assert!(WORKBENCH_KDL.contains("name=\"work\" split_direction=\"horizontal\""));
    }

    #[test]
    fn keeps_the_tab_and_status_bars_in_every_preset() {
        // 4 presets + base = 5 of each bar.
        assert_eq!(
            WORKBENCH_KDL.matches("zellij:tab-bar").count(),
            SWAP_PRESETS.len() + 1
        );
        assert_eq!(
            WORKBENCH_KDL.matches("zellij:status-bar").count(),
            SWAP_PRESETS.len() + 1
        );
    }

    #[test]
    fn launch_argv_shape() {
        // `--session` names the session so it is reapable (EI-186);
        // `--new-session-with-layout` (NEVER `--layout`: combined with
        // `--session` zellij dispatches that as new-tab-in-EXISTING-session
        // and exits "There is no active session!") creates the named session;
        // `options --show-startup-tips false --show-release-notes false`
        // layers a per-session override (no user-config replacement): either
        // popup floats over the app-managed session blocking the panes until
        // dismissed.
        assert_eq!(
            launch_argv("/home/u/.papercusp/pui-workbench.kdl", "pui-wb-42"),
            vec![
                "zellij",
                "--session",
                "pui-wb-42",
                "--new-session-with-layout",
                "/home/u/.papercusp/pui-workbench.kdl",
                "options",
                "--show-startup-tips",
                "false",
                "--show-release-notes",
                "false"
            ]
        );
    }

    #[test]
    fn session_path_puts_the_launching_build_first_once() {
        let exe = Path::new("/work/target/debug/pui");
        let inherited = std::ffi::OsString::from("/home/u/.cargo/bin:/work/target/debug:/usr/bin");
        let path = session_path_env(exe, Some(&inherited)).unwrap();
        assert_eq!(
            std::env::split_paths(&path).collect::<Vec<_>>(),
            vec![
                PathBuf::from("/work/target/debug"),
                PathBuf::from("/home/u/.cargo/bin"),
                PathBuf::from("/usr/bin"),
            ],
        );
        assert_eq!(
            session_path_env(exe, None).unwrap(),
            std::ffi::OsString::from("/work/target/debug"),
        );
        assert_eq!(session_path_env(Path::new("pui"), Some(&inherited)), None);
    }

    #[test]
    fn a_user_zellij_config_is_found_where_zellij_looks_for_it() {
        let home = Path::new("/home/u");
        let env_of = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| pairs.iter().find(|(key, _)| *key == k).map(|(_, v)| v.to_string())
        };
        let only = |file: &'static str| move |p: &Path| p == Path::new(file);
        // Default location.
        assert!(user_zellij_config_exists(env_of(&[]), Some(home), only("/home/u/.config/zellij/config.kdl")));
        // XDG_CONFIG_HOME moves it; the ~/.config copy is then not where zellij looks.
        assert!(user_zellij_config_exists(
            env_of(&[("XDG_CONFIG_HOME", "/x")]), Some(home), only("/x/zellij/config.kdl")));
        assert!(!user_zellij_config_exists(
            env_of(&[("XDG_CONFIG_HOME", "/x")]), Some(home), only("/home/u/.config/zellij/config.kdl")));
        // An explicit dir or file, and the system-wide one.
        assert!(user_zellij_config_exists(
            env_of(&[("ZELLIJ_CONFIG_DIR", "/c")]), Some(home), only("/c/config.kdl")));
        assert!(user_zellij_config_exists(env_of(&[("ZELLIJ_CONFIG_FILE", "/f.kdl")]), Some(home), |_| false));
        assert!(user_zellij_config_exists(env_of(&[]), Some(home), only("/etc/zellij/config.kdl")));
        // None anywhere (a new machine): pui supplies its own, and an EMPTY
        // variable (as the PTY harness sets) counts as unset.
        assert!(!user_zellij_config_exists(
            env_of(&[("ZELLIJ_CONFIG_FILE", ""), ("ZELLIJ_CONFIG_DIR", "")]), Some(home), |_| false));
    }

    #[test]
    fn pane_fullscreen_reads_the_terminal_pane_not_a_plugin_with_the_same_id() {
        // Shape measured from zellij 0.44.3 `action list-panes --json --all`.
        let listed = br#"[
            {"id":0,"title":"(.) - zellij:link","is_plugin":true,"is_fullscreen":true},
            {"id":1,"title":"configuration","is_plugin":true,"is_focused":true,"is_fullscreen":false},
            {"id":0,"title":"chat","is_plugin":false,"is_focused":true,"is_fullscreen":false},
            {"id":1,"title":"hud","is_plugin":false,"is_fullscreen":true}
        ]"#;
        assert_eq!(pane_fullscreen(listed, 0), Some(false));
        assert_eq!(pane_fullscreen(listed, 1), Some(true));
        assert_eq!(pane_fullscreen(listed, 7), None);
        assert_eq!(pane_fullscreen(b"not json", 0), None);
    }

    #[test]
    fn the_session_config_suppresses_both_zellij_popups() {
        let base = std::env::temp_dir().join(format!("pui-session-config-{}", std::process::id()));
        let dir = materialize_session_config_at(&base).unwrap();
        assert_eq!(dir, base.join("zellij"));
        let written = std::fs::read_to_string(dir.join("config.kdl")).unwrap();
        assert_eq!(written, SESSION_ZELLIJ_CONFIG_KDL);
        assert!(written.contains("show_startup_tips false"));
        assert!(written.contains("show_release_notes false"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn session_name_is_stable_per_kind() {
        assert_eq!(session_name("dock"), "pui-dock");
        assert_eq!(session_name("wb"), "pui-wb");
    }

    #[test]
    fn attach_argv_attaches_by_name() {
        assert_eq!(attach_argv("pui-wb"), vec!["zellij", "attach", "pui-wb"]);
    }

    #[test]
    fn materialize_writes_the_kdl() {
        let d = tempfile::tempdir().unwrap();
        let p = materialize_at(d.path()).unwrap();
        assert!(p.ends_with("pui-workbench.kdl"));
        let written = std::fs::read_to_string(&p).unwrap();
        assert_eq!(written, WORKBENCH_KDL);
    }

    // ── P-013 chat dock ──────────────────────────────────────────────────────

    use crate::lexicon::Lexicon;
    use crate::models::{LexiconPackPayload, TermForms};
    use std::collections::HashMap;

    /// A the-hive lexicon for the pane-name tests.
    fn hive_lex() -> Lexicon {
        let mut terms = HashMap::new();
        for (k, one, other) in [
            ("operator", "Sentinel", "Sentinels"),
            ("brain", "Queen", "Queens"),
            ("fleet", "Colony", "Colonies"),
            ("contributor", "Bee", "Bees"),
            ("pot", "Hive", "Hives"),
            ("node", "Swarm", "Swarms"),
        ] {
            terms.insert(
                k.to_string(),
                TermForms {
                    one: one.to_string(),
                    other: other.to_string(),
                },
            );
        }
        Lexicon::from_payload(&LexiconPackPayload {
            pack_id: "the-hive".into(),
            label: "The Hive".into(),
            terms,
        })
    }

    #[test]
    fn chat_dock_is_the_queen_split_over_the_agent_stack() {
        // The dock (hive-agent-tabs, sole shape since P-014): the queen split
        // (brain-view + her data boards) over the agent stack (psu sentinel,
        // dock-driver, fleet wake board). The retired `pui chat-pane` widget
        // must never reappear.
        let lex = Lexicon::default();
        let kdl = chat_dock_kdl(&["psu".to_string(), "--resume".to_string()], &lex);
        assert!(kdl.contains("name=\"cups\"")); // worker-stack container, UNGLYPHED (infra, not an agent kind)
        assert!(kdl.contains("name=\"🥤 papercup\"")); // lex("operator")=Papercup, P-010 glyph
        assert!(kdl.contains("name=\"☕ mug\""));
        assert!(kdl.contains("stacked=true"));
        assert!(kdl.contains("expanded=true"));
        // sentinel-as-claude-tui-2026-06-22: the sentinel pane (operator chat) now
        // launches via the `psu-sentinel` wrapper (which internally runs `psu
        // --no-picker --agent=claude --role=sentinel`), not a bare `command "psu"`.
        assert!(kdl.contains("command \"psu-sentinel\""));
        // D-003: the brain pane is now the read-only transcript view, not psu --resume.
        assert!(kdl.contains("args \"brain-view\" \"--queen\""));
        // The retired pane modes + old single-tab panes are GONE — tab
        // surfaces live in the pui app, not zellij (chat-pane/watch-pane
        // retired by P-014).
        for gone in [
            "chat-pane",
            "watch-pane",
            "main-pane",
            "apiary-pane",
            "voice-pane",
            "swarm-pane",
            "bee-pane",
            "name=\"main\"",
            "name=\"chat\"", // the old single agent stack — gone in the reorder
        ] {
            assert!(!kdl.contains(gone), "stale dock artifact: {gone}");
        }
        // The Sentinel LEADS the dock — it sits ABOVE the queen split (reorder
        // sentinel-as-claude-tui-2026-06-22: 🛡 sentinel · 👁 overwatch · ♛ queen).
        let (s, q) = (
            kdl.find("name=\"🥤 papercup\"").unwrap(),
            kdl.find("name=\"☕ mug\"").unwrap(),
        );
        assert!(s < q, "the sentinel leads the dock, above the queen split");
        // And NOTHING of the workbench: no HUD, no work area, no swap presets.
        assert!(!kdl.contains("args \"hud\""));
        assert!(!kdl.contains("name=\"work\" "));
        assert!(!kdl.contains("swap_tiled_layout"));
        assert!(kdl.contains("args \"network-pane\""));
    }

    #[test]
    fn chat_dock_is_a_three_tab_session_this_hive_network_context() {
        // P-007 (hive-network-surface B-10) + Context P-006: the dock
        // is a THREE-tab zellij session. Tab 1 "this hive" holds the dock
        // VERBATIM; tab 2 "network" hosts `pui network-pane`; tab 3 "context"
        // hosts `pui context-pane`. The bars live in a `default_tab_template`
        // shared by all tabs. The workbench swap presets never appear here.
        let kdl = chat_dock_kdl(
            &[
                "pui".to_string(),
                "brain-view".to_string(),
                "--queen".to_string(),
            ],
            &Lexicon::default(),
        );
        // A shared tab template carries the bars exactly once.
        assert!(
            kdl.contains("default_tab_template {"),
            "no default_tab_template"
        );
        assert!(
            kdl.contains("children"),
            "template has no children placeholder"
        );
        assert_eq!(
            kdl.matches("zellij:tab-bar").count(),
            1,
            "tab-bar declared once in the template"
        );
        assert_eq!(
            kdl.matches("zellij:status-bar").count(),
            1,
            "status-bar declared once in the template"
        );
        // All three tabs, in order: "this pot" (focus) → "network" → "context".
        assert!(
            kdl.contains("tab name=\"this pot\" focus=true"),
            "missing focused this-pot tab"
        );
        assert!(kdl.contains("tab name=\"network\""), "missing network tab");
        assert!(kdl.contains("tab name=\"context\""), "missing context tab");
        let th = kdl.find("tab name=\"this pot\"").unwrap();
        let nw = kdl.find("tab name=\"network\"").unwrap();
        let context = kdl.find("tab name=\"context\"").unwrap();
        assert!(
            th < nw && nw < context,
            "this pot must be the FIRST tab so tier-1 GoToTab(1) lands on it"
        );
        // The dock body lives inside the this-pot tab (the sentinel pane — the
        // FIRST dock pane after the reorder — sits between the first two tab headers).
        let body = kdl.find("name=\"🥤 papercup\"").unwrap();
        assert!(
            th < body && body < nw,
            "the dock body must live inside the this-pot tab"
        );
        // The network + Context tabs host their respective pinned pui boards.
        let net_pane = kdl.find("args \"network-pane\"").unwrap();
        assert!(
            net_pane > nw && net_pane < context,
            "network-pane must be inside the network tab"
        );
        let context_pane = kdl.find("args \"context-pane\"").unwrap();
        assert!(
            context_pane > context,
            "context-pane must be inside the context tab"
        );
        // The dock is never the workbench.
        assert!(
            !kdl.contains("swap_tiled_layout"),
            "no swap presets in the dock"
        );
    }

    #[test]
    fn chat_dock_context_tab_hosts_the_shared_projection_pane() {
        // Context P-006: the third dock tab "context" hosts the canonical
        // `pui context-pane` projection. It is the LAST tab (after network)
        // so it never displaces tab-1 "this pot" (tier-1 GoToTab(1)).
        let kdl = chat_dock_kdl(
            &["psu".to_string(), "--brain".to_string()],
            &Lexicon::default(),
        );
        assert!(
            kdl.contains("tab name=\"context\""),
            "missing context tab: {kdl}"
        );
        assert!(
            kdl.contains("args \"context-pane\""),
            "context tab must run `pui context-pane`: {kdl}"
        );
        // The Context tab is last (this pot < network < context).
        let context = kdl.find("tab name=\"context\"").unwrap();
        assert!(kdl.find("tab name=\"this pot\"").unwrap() < context);
        assert!(kdl.find("tab name=\"network\"").unwrap() < context);
        // The projection pane runs inside Context, lexicon-independent
        // (the args are internal identifiers — never renamed by the lexicon).
        assert!(kdl.find("args \"context-pane\"").unwrap() > context);
    }

    #[test]
    fn chat_dock_pane_names_route_through_the_hive_lexicon() {
        // With the-hive active: the brain pane routes brain→queen (lowercased,
        // kdl-safe, P-010 glyph-prefixed). The sentinel pane is keyed "sentinel"
        // (no lexicon term → its own 🛡 glyph + name). The old single "chat" stack
        // is gone (sentinel-as-claude-tui-2026-06-22 reorder).
        let kdl = chat_dock_kdl(&["psu".to_string()], &hive_lex());
        assert!(kdl.contains("name=\"🥤 sentinel\""));
        assert!(kdl.contains("name=\"☕ queen\""));
        assert!(!kdl.contains("name=\"chat\""));
        // The classic (Papercup-cast) labels must NOT leak when the-hive is on.
        assert!(!kdl.contains("name=\"🥤 papercup\""));
        assert!(!kdl.contains("name=\"☕ mug\""));
    }

    #[test]
    fn chat_dock_sentinel_is_a_psu_session() {
        // hive-agent-tabs P-003: the operator/Sentinel pane is a real psu/Claude TUI
        // — the `pui chat-pane` widget it replaced was retired by P-014.
        // sentinel-as-claude-tui-2026-06-22: it now launches via the `psu-sentinel`
        // wrapper (~/.local/bin, repo apps/operator/scripts/psu-sentinel.sh), which
        // mints a per-pane sid + spawns `psu --no-picker --agent=claude
        // --role=sentinel` itself — so the KDL pane carries no inline `args` (the
        // wrapper owns the flags). The old `command "psu"` + inline --role=operator
        // form is gone.
        let on = chat_dock_kdl(
            &["psu".to_string(), "--brain".to_string()],
            &Lexicon::default(),
        );
        assert!(
            on.contains("command \"psu-sentinel\""),
            "sentinel launches the wrapper: {on}"
        );
        assert!(!on.contains("--role=operator")); // the wrapper picks role=sentinel; no inline role here
        assert!(!on.contains("args \"--role\" \"operator\"")); // never the dropped space form
        assert!(!on.contains("args \"chat-pane\""));
        // queen-overwatch-live-visibility D-003: the ♛ queen + 👁 overwatch panes
        // now render the READ-ONLY shared transcript view (`pui brain-view`), so the
        // ONLY psu session in the dock is the sentinel (the front-door chat). That is
        // what lets every desktop instance show the SAME live queen/overwatch and
        // survive a shell exit. The one-pane `pui agent-pane` variant stays reverted.
        // NOTE the closing quote in the needle: it keeps "psu-sentinel" from
        // substring-matching "psu-sentinel-deep".
        assert_eq!(on.matches("command \"psu-sentinel\"").count(), 1); // the front pane (queen+overwatch are pui brain-view)
                                                                       // WI-4485: NO deep pane in the dock — not tiled, not floating. P-014 put one here
                                                                       // (a 2nd pane sharing the "🥤 papercup" label) and the owner saw "2x papercup";
                                                                       // moving it to a hidden floating pane still RENDERED (zellij parses
                                                                       // hide_floating_panes but draws the pane anyway). The deep half needs no pane: it
                                                                       // is found via presence + woken over coord, and papercup-deep-delegate.ts
                                                                       // explicitly supports the "no-deep-pane case" by spawning an ephemeral agent.
        assert_eq!(on.matches("command \"psu-sentinel-deep\"").count(), 0);
        // And no BARE `command "psu"` leaks back (brain/queen/overwatch are all pui).
        assert_eq!(on.matches("command \"psu\"\n").count(), 0);
        assert!(
            !on.contains("agent-pane"),
            "the reverted one-pane variant must not return: {on}"
        );
        assert!(
            on.contains("name=\"☕ mug\" split_direction=\"vertical\""),
            "queen split container: {on}"
        );
        // The queen's side column is the FOUR stacked data boards (dock 4-pane
        // split, owner ask 2026-06-11): prompt → wakes → mail → work, top-down.
        assert!(on.contains("args \"prompt-pane\" \"--mug\""));
        assert!(on.contains("args \"wake-pane\" \"--mug\""));
        assert!(on.contains("args \"mail-pane\" \"--mug\""));
        assert!(on.contains("args \"work-pane\" \"--mug\""));
        assert!(on.contains("name=\"☕✉ prompt\""));
        assert!(on.contains("name=\"☕⏸ wakes\""));
        assert!(on.contains("name=\"☕✉ mail\""));
        assert!(on.contains("name=\"☕☑ work\""));
        let brief_at = on.find("☕✉ prompt").expect("prompt pane");
        let queen_wakes_at = on.find("☕⏸ wakes").expect("queen wake pane");
        let mail_at = on.find("☕✉ mail").expect("mail pane");
        let work_at = on.find("☕☑ work").expect("work pane");
        assert!(
            brief_at < queen_wakes_at && queen_wakes_at < mail_at && mail_at < work_at,
            "side column order is prompt → wakes → mail → work"
        );
        // P-004/D-009: the reactive driver + the fleet-wide wake board remain
        // stack members.
        assert!(on.contains("args \"dock-driver\""));
        assert!(on.contains("args \"wake-pane\"\n")); // the fleet-wide pane (bare wake-pane)
        assert!(on.contains("name=\"⏸ wakes\""));
        // queen transcript-view + overwatch transcript-view (D-003) + queen
        // prompt/wakes/mail/work + driver + fleet-wakes + the network tab's
        // network-pane + the Context tab's context-pane = 10.
        assert_eq!(on.matches("command \"pui\"").count(), 10);
        assert!(on.contains("args \"network-pane\""));
        assert!(on.contains("args \"context-pane\""));
        // Order: brain precedes her side column; the queen split precedes the
        // cups stack; the dock-driver is inside that cups stack.
        let queen_at = on.find("name=\"☕ mug\"").expect("queen container");
        let stack_at = on.find("name=\"cups\" stacked=true").expect("cups stack");
        let driver_at = on.find("args \"dock-driver\"").expect("driver pane");
        assert!(queen_at < brief_at, "brain precedes her side column");
        assert!(
            work_at < stack_at,
            "the queen split precedes the cups stack"
        );
        assert!(stack_at < driver_at, "the driver is inside the cups stack");
    }

    #[test]
    fn chat_dock_has_exactly_one_papercup_and_no_deep_pane_at_all() {
        // WI-4485 — REGRESSION PIN, second cut. The owner reported "2x papercup agents";
        // the FIRST fix moved the deep pane into `floating_panes` with the tab's
        // hide_floating_panes=true, and the owner then reported "one is in a floating
        // panel and one is in the dock" — zellij 0.44.3 parses that attribute but still
        // RENDERS the pane. A pane you cannot reliably hide is a pane you must not create.
        //
        // The deep half needs NO pane: it is found via presence (agentRole='papercup-deep')
        // and woken over coord, never by pane input; ~/.papercusp/sentinel-deep-pane is
        // write-only (nothing reads it); and papercup-deep-delegate.ts explicitly supports
        // + tests the "no-deep-pane case" by spawning an ephemeral background agent.
        //
        // The invariant: the dock contains EXACTLY ONE papercup pane and NO psu-sentinel-deep
        // launch of any kind. Deep thinking still works — via the delegate, off-screen.
        let kdl = chat_dock_kdl(
            &["psu".to_string(), "--brain".to_string()],
            &Lexicon::default(),
        );

        // Exactly ONE papercup pane in the entire dock — tiled or otherwise.
        assert_eq!(
            kdl.matches("name=\"🥤 papercup\"").count(),
            1,
            "exactly ONE papercup pane in the dock: {kdl}"
        );
        // The deep pane must not be launched from the dock in ANY form.
        assert!(
            !kdl.contains("psu-sentinel-deep"),
            "the dock must not launch a papercup-deep pane at all (WI-4485): {kdl}"
        );
        // No floating-pane escape hatch — that was the failed first fix.
        assert!(
            !kdl.contains("floating_panes") && !kdl.contains("hide_floating_panes"),
            "a floating pane is still RENDERED by zellij — do not reintroduce it: {kdl}"
        );
        // The front-door pane keeps the full 40% it originally had, and still leads the dock.
        assert!(
            kdl.contains("name=\"🥤 papercup\" focus=true size=\"40%\""),
            "front pane focused at 40%: {kdl}"
        );
        let front = kdl.find("command \"psu-sentinel\"").unwrap();
        let ow = kdl.find("name=\"🫖 kettle\"").unwrap();
        assert!(front < ow, "the front pane leads the dock, above overwatch");
    }

    #[test]
    fn chat_dock_overwatch_pane_sits_above_the_queen() {
        // overwatch-role-2026-06-15 (owner ask 2026-06-15): the OVERWATCH
        // supervisor's interactive pane — a fully-scoped no-picker psu launch as
        // role=overwatch, mirroring the sentinel — sits ABOVE the ♛ queen block.
        let kdl = chat_dock_kdl(
            &["psu".to_string(), "--brain".to_string()],
            &Lexicon::default(),
        );
        // The pane exists with the 👁 glyph + the `=` role form (psu drops a
        // space-separated --role, exactly like the sentinel's --role=operator).
        assert!(
            kdl.contains("name=\"🫖 kettle\""),
            "overwatch pane missing: {kdl}"
        );
        assert!(
            kdl.contains("args \"brain-view\" \"--overwatch\""),
            "overwatch read-only view args (D-003): {kdl}",
        );
        assert!(
            !kdl.contains("args \"--role\" \"overwatch\""),
            "never the dropped space form"
        );
        // It is ABOVE the queen: the overwatch pane precedes the ♛ queen split.
        let ow = kdl.find("name=\"🫖 kettle\"").expect("overwatch pane");
        let queen = kdl.find("name=\"☕ mug\"").expect("queen split");
        assert!(ow < queen, "the overwatch pane sits above the queen split");
    }

    #[test]
    fn chat_dock_binds_tab_to_fullscreen_zoom_at_the_layout_level() {
        // owner ask 2026-06-11: Tab fullscreens the focused pane (chat → hide
        // its wakes pane; Tab again restores). A layout-level keybind (merges
        // with the user's config, dock-session-only).
        let kdl = chat_dock_kdl(
            &["psu".to_string(), "--brain".to_string()],
            &Lexicon::default(),
        );
        assert!(kdl.contains("keybinds {"), "keybinds block missing: {kdl}");
        assert!(
            kdl.contains("bind \"Tab\" { ToggleFocusFullscreen; }"),
            "Tab→fullscreen bind missing: {kdl}",
        );
        // The keybinds block precedes the layout block (zellij wants it as a
        // top-level sibling, not nested in `layout`).
        assert!(
            kdl.find("keybinds {").unwrap() < kdl.find("layout {").unwrap(),
            "keybinds must precede layout",
        );
    }

    #[test]
    fn chat_dock_forwards_up_down_arrows_to_the_focused_pane() {
        // owner ask 2026-06-17: the chat group is a vertical `stacked=true` group,
        // and zellij reserves plain ↑/↓ to move between stacked panes — so they
        // never reach the focused pane's program (the Colony pane's two-level
        // pane nav). Re-bind ↑/↓ to Write the CSI cursor sequences to the pane;
        // the stack scroll stays on Alt+↑/↓.
        let kdl = chat_dock_kdl(
            &["psu".to_string(), "--brain".to_string()],
            &Lexicon::default(),
        );
        assert!(
            kdl.contains("bind \"up\" { Write 27 91 65; }"),
            "↑→pane (ESC[A) forward bind missing: {kdl}",
        );
        assert!(
            kdl.contains("bind \"down\" { Write 27 91 66; }"),
            "↓→pane (ESC[B) forward bind missing: {kdl}",
        );
        // The chat group is genuinely stacked (the reason the forward is needed).
        assert!(kdl.contains("stacked=true"), "chat group should be stacked");
    }

    #[test]
    fn chat_dock_glyphs_the_static_pane_names() {
        // P-010: the sentinel/queen pane NAMES carry their per-type glyph
        // (zellij has no per-pane color, D-008).
        let kdl = chat_dock_kdl(
            &["psu".to_string(), "--brain".to_string()],
            &Lexicon::default(),
        );
        assert!(
            kdl.contains("name=\"🥤 papercup\""),
            "sentinel glyph missing: {kdl}"
        );
        assert!(
            kdl.contains("name=\"☕ mug\""),
            "queen/brain glyph missing: {kdl}"
        );
    }

    #[test]
    fn chat_dock_fresh_brain_omits_args_line() {
        // The dock's only psu session is the sentinel, via the `psu-sentinel`
        // wrapper (sentinel-as-claude-tui-2026-06-22) — the brain/queen pane is a
        // read-only `pui brain-view --queen` tail (D-003), not a psu resume. So
        // brain_argv (the resume handle) NEVER reaches the KDL: no `--resume` line
        // leaks regardless of what brain_argv carries.
        let kdl = chat_dock_kdl(
            &["psu".to_string(), "--resume".to_string(), "x".to_string()],
            &Lexicon::default(),
        );
        assert!(kdl.contains("command \"psu-sentinel\""));
        assert!(
            !kdl.contains("args \"--resume\""),
            "brain_argv must not leak a resume into the KDL: {kdl}"
        );
    }

    #[test]
    fn chat_dock_queen_pane_is_read_only_brain_view() {
        // queen-overwatch-live-visibility D-003: the queen pane no longer threads
        // brain_argv (it is NOT an interactive brain resume) — it renders the
        // READ-ONLY shared transcript view so every instance shows the SAME live queen
        // and survives shell exit. brain_argv is retained for a future "take control"
        // action but is NOT threaded into the default dock pane.
        let kdl = chat_dock_kdl(
            &[
                "psu".to_string(),
                "--resume".to_string(),
                "abc-123".to_string(),
            ],
            &Lexicon::default(),
        );
        assert!(kdl.contains("args \"brain-view\" \"--queen\""));
        assert!(
            !kdl.contains("abc-123"),
            "brain_argv must NOT be threaded into the read-only pane: {kdl}"
        );
    }

    #[test]
    fn brain_default_is_the_backend_neutral_read_only_view() {
        assert_eq!(
            default_brain_argv(None),
            vec!["pui", "brain-view", "--queen"]
        );
        assert_eq!(
            default_brain_argv(Some("")),
            vec!["pui", "brain-view", "--queen"]
        );
        assert_eq!(
            default_brain_argv(Some("   ")),
            vec!["pui", "brain-view", "--queen"]
        );
    }

    #[test]
    fn brain_env_override_is_whitespace_split() {
        assert_eq!(
            default_brain_argv(Some("psu --resume abc-123")),
            vec!["psu", "--resume", "abc-123"]
        );
    }

    #[test]
    fn materialize_chat_dock_writes_the_kdl() {
        let d = tempfile::tempdir().unwrap();
        let p = materialize_chat_dock_at(
            d.path(),
            &["psu".to_string(), "--resume".to_string()],
            &Lexicon::default(),
        )
        .unwrap();
        assert!(p.ends_with("pui-chat-dock.kdl"));
        let written = std::fs::read_to_string(&p).unwrap();
        assert!(written.contains("name=\"☕ mug\""));
        assert!(written.contains("args \"dock-driver\""));
        assert!(written.contains("stacked=true"));
    }

    // ── P-013 per-frame tabs ─────────────────────────────────────────────────

    #[test]
    fn frame_tab_kdl_is_a_named_placeholder_tab() {
        // P-014 retired the watch-pane surface, so the frame tab is a marker:
        // a named tab holding a shell placeholder (the remote agents' live
        // view is the streamed desktop in the webview Frames tab).
        let kdl = frame_tab_kdl("☁ papercup-cloud");
        assert!(kdl.contains("tab name=\"☁ papercup-cloud\""));
        assert!(!kdl.contains("watch-pane"));
        assert!(!kdl.contains("command \"pui\""));
        assert!(!kdl.contains("stacked=true"));
        // The tab keeps its own bars (each zellij tab lays out independently).
        assert!(kdl.contains("zellij:tab-bar"));
        assert!(kdl.contains("zellij:status-bar"));
    }

    #[test]
    fn frame_tab_kdl_escapes_quotes() {
        let kdl = frame_tab_kdl("☁ q\"uote");
        assert!(kdl.contains("tab name=\"☁ q\\\"uote\""));
    }

    // ── P-008 per-hive drill-in tabs ─────────────────────────────────────────

    #[test]
    fn desired_hive_tabs_emits_one_persistent_tab_per_live_federated_peer() {
        use crate::hives::HiveGroup;
        let live = HiveGroup {
            machine: "mbp".into(),
            device_pubkey: "key-a".into(),
            stale: false,
            ..Default::default()
        };
        let stale = HiveGroup {
            machine: "tower".into(),
            device_pubkey: "key-b".into(),
            stale: true,
            ..Default::default()
        };
        let specs = desired_hive_tabs(&[live, stale]);
        // Only the LIVE peer earns a standing tab; the stale hive drops off the axis.
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].tier, 3); // federated, substrate-verified
        assert_eq!(specs[0].key, "key-a");
        assert_eq!(specs[0].title, "mbp");
    }

    #[test]
    fn desired_hive_tabs_keys_by_machine_when_pubkey_is_empty() {
        use crate::hives::HiveGroup;
        let g = HiveGroup {
            machine: "tower".into(),
            device_pubkey: String::new(),
            stale: false,
            ..Default::default()
        };
        let specs = desired_hive_tabs(&[g]);
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].key, "tower"); // falls back to the machine label as the key
        assert_eq!(specs[0].title, "tower");
    }

    #[test]
    fn hive_axis_tab_kdl_is_persistent_and_distinctly_named() {
        let spec = HiveTabSpec {
            tier: 3,
            key: "key-a".into(),
            title: "mbp".into(),
        };
        let axis = hive_axis_tab_kdl(&spec);
        let drill = hive_tab_kdl(&spec);
        // ◆ marks the standing axis tab; ⌕ marks the transient drill-in.
        assert!(axis.contains("tab name=\"◆ mbp\""));
        assert!(drill.contains("tab name=\"⌕ mbp\""));
        // The axis tab rides the hive's lifetime (no close_on_exit); the drill-in tears down.
        assert!(!axis.contains("close_on_exit"));
        assert!(drill.contains("close_on_exit=true"));
        // Both still open the tier-aware hive-pane detail for the key.
        assert!(axis.contains("args \"hive-pane\" \"key-a\""));
    }

    #[test]
    fn hive_axis_tab_name_falls_back_to_key_when_title_blank() {
        assert_eq!(
            hive_axis_tab_name(&HiveTabSpec {
                tier: 3,
                key: "k".into(),
                title: "mbp".into()
            }),
            "◆ mbp"
        );
        assert_eq!(
            hive_axis_tab_name(&HiveTabSpec {
                tier: 3,
                key: "k".into(),
                title: String::new()
            }),
            "◆ k"
        );
    }

    fn hive_spec(tier: u8, key: &str, title: &str) -> HiveTabSpec {
        HiveTabSpec {
            tier,
            key: key.to_string(),
            title: title.to_string(),
        }
    }

    #[test]
    fn hive_tab_name_prefixes_and_falls_back_to_key() {
        // Names by the row title; the ⌕ prefix marks a drill-in. Blank title →
        // the key (a foreign pubkey-b64 still gets a usable tab name).
        assert_eq!(
            hive_tab_name(&hive_spec(4, "AbC+/d", "Acme Hive")),
            "⌕ Acme Hive"
        );
        assert_eq!(hive_tab_name(&hive_spec(2, "papercup", "")), "⌕ papercup");
        assert_eq!(
            hive_tab_name(&hive_spec(2, "papercup", "   ")),
            "⌕ papercup"
        );
    }

    #[test]
    fn hive_tab_kdl_tier4_is_a_lone_dossier_pane() {
        // tier 4 (foreign): ONE `pui hive-pane <key>` dossier pane, not
        // stacked. Carries its own bars (injected into the live session, like
        // frame_tab_kdl).
        let kdl = hive_tab_kdl(&hive_spec(4, "k3y+b64", "Foreign Hive"));
        assert!(kdl.contains("tab name=\"⌕ Foreign Hive\""));
        assert_eq!(kdl.matches("args \"hive-pane\" \"k3y+b64\"").count(), 1);
        assert!(
            !kdl.contains("stacked=true"),
            "a lone dossier pane is not stacked"
        );
        assert!(kdl.contains("focus=true close_on_exit=true"));
        assert!(kdl.contains("zellij:tab-bar"));
        assert!(kdl.contains("zellij:status-bar"));
        // Exactly the one detail pane runs pui.
        assert_eq!(kdl.matches("command \"pui\"").count(), 1);
    }

    #[test]
    fn hive_tab_kdl_tier2_stacks_detail_plus_wake_board() {
        // tier 2 (own hive): the focused detail pane LEADS a stack with the
        // hive-scoped wake board (P-014 item 3 / D-007 GAP 1 —
        // `network.hive.wakes` scopes by the tier-2 hive slug). Every pane is
        // close_on_exit. (Per-bee watch panes rode here until hive-agent-tabs
        // P-014 retired the watch-pane surface.)
        let kdl = hive_tab_kdl(&hive_spec(2, "papercup", "This Box"));
        assert!(kdl.contains("args \"hive-pane\" \"papercup\""));
        assert!(kdl.contains("args \"wake-pane\" \"--hive\" \"papercup\""));
        assert!(kdl.contains("name=\"⏸ wakes\""));
        assert!(!kdl.contains("watch-pane"));
        assert!(kdl.contains("stacked=true"));
        assert!(kdl.contains("focus=true expanded=true close_on_exit=true"));
        // detail (hive-pane) leads the stack, the wake board follows.
        let detail_at = kdl.find("args \"hive-pane\"").unwrap();
        let wake_at = kdl.find("args \"wake-pane\"").unwrap();
        assert!(detail_at < wake_at, "the detail pane leads the stack");
        assert_eq!(kdl.matches("command \"pui\"").count(), 2);
        // Every command pane tears down on exit (no EXITED husk).
        assert_eq!(kdl.matches("close_on_exit=true").count(), 2);
    }

    #[test]
    fn hive_tab_kdl_tier3_is_detail_only() {
        // tier 3 (peer swarm): just the detail pane — no stack and NO wake
        // board (tier-3 keys are peer device pubkeys; that peer's wake queue
        // lives in their PG, not ours).
        let kdl = hive_tab_kdl(&hive_spec(3, "pk-peer", "Peer Swarm"));
        assert!(kdl.contains("args \"hive-pane\" \"pk-peer\""));
        assert!(!kdl.contains("wake-pane"));
        assert!(!kdl.contains("stacked=true"));
        assert!(kdl.contains("focus=true close_on_exit=true"));
        assert_eq!(kdl.matches("command \"pui\"").count(), 1);
    }

    #[test]
    fn hive_tab_kdl_tab_name_matches_hive_tab_name() {
        // The KDL's `tab name=` MUST equal hive_tab_name(spec) (escaped) so the
        // companion `Command::NewTab { name }` B-09 sends agrees with the layout
        // — otherwise zellij would show two names / fail to de-dupe the tab.
        let spec = hive_spec(3, "peer", "Peer Swarm");
        let expected = format!("tab name=\"{}\"", hive_tab_name(&spec));
        assert!(hive_tab_kdl(&spec).contains(&expected));
    }

    #[test]
    fn hive_tab_kdl_escapes_quotes() {
        let kdl = hive_tab_kdl(&hive_spec(2, "ke\"y", "Ti\"tle"));
        assert!(kdl.contains("tab name=\"⌕ Ti\\\"tle\""));
        assert!(kdl.contains("args \"hive-pane\" \"ke\\\"y\""));
    }

    #[test]
    fn kdl_pane_name_is_lowercase_and_safe() {
        assert_eq!(kdl_pane_name("Queen", "operator"), "queen");
        assert_eq!(kdl_pane_name("Hive Mind", "substrate"), "hive-mind");
        assert_eq!(kdl_pane_name("", "fallback"), "fallback");
        assert_eq!(kdl_pane_name("!!!", "fallback"), "fallback");
        assert_eq!(kdl_pane_name("Bees", "contributor"), "bees");
    }
}
