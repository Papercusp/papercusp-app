//! Composer slash commands (pui-chat-first-ux-2026-09-28 P-004 / R-04).
//!
//! Claude Code and Codex both open a command menu when `/` is typed at the
//! start of an empty message: the menu filters as you type, Up/Down pick, Enter
//! or Tab runs, Esc dismisses. The PUI's other command surface — the `:`
//! palette — is only reachable outside the composer, so a person who lives in
//! the chat never finds it. This module is the pure half: which text opens the
//! menu, which commands match, and which one Enter runs. `App` owns the keys
//! and the effects; `ui` draws the menu above the composer.
//!
//! Every command maps onto an action the PUI already has (help overlay, Ctrl+O
//! details, Ctrl+S sessions, copy, quit) — the menu is a discoverable door onto
//! them, not a second implementation.

/// One composer command. `name` is typed without the leading slash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlashCommand {
    pub name: &'static str,
    pub summary: &'static str,
    pub kind: SlashKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlashKind {
    Help,
    Resume,
    Clear,
    Model,
    Effort,
    Backend,
    Status,
    Compact,
    Approvals,
    Details,
    Expand,
    Copy,
    Detach,
    Exit,
}

/// Menu order is the order shown; the most-used commands come first.
pub const COMMANDS: &[SlashCommand] = &[
    SlashCommand {
        name: "help",
        summary: "Keys and commands",
        kind: SlashKind::Help,
    },
    SlashCommand {
        name: "resume",
        summary: "Switch to another conversation (Ctrl+S)",
        kind: SlashKind::Resume,
    },
    // pui-chat-first-ux P-027 (G-4): Claude Code's and Codex's /clear.
    SlashCommand {
        name: "clear",
        summary: "Start a new conversation (this one stays in /resume)",
        kind: SlashKind::Clear,
    },
    // pui-chat-first-ux P-026: both apply from the next turn of a running
    // conversation, or set the model a new one starts on.
    SlashCommand {
        name: "model",
        summary: "Switch the model, from the next turn",
        kind: SlashKind::Model,
    },
    SlashCommand {
        name: "effort",
        summary: "Set the reasoning effort, from the next turn",
        kind: SlashKind::Effort,
    },
    // pui-chat-first-ux P-025: in chat-first Esc stays in the message box
    // (P-027), so the `b` key never reaches the backend picker. This is the
    // only way a bare `pui` user starts a Codex or OMP conversation.
    SlashCommand {
        name: "backend",
        summary: "Engine for a new conversation: Claude, Codex or OMP",
        kind: SlashKind::Backend,
    },
    SlashCommand {
        name: "status",
        summary: "Model, account and engine this conversation runs on",
        kind: SlashKind::Status,
    },
    SlashCommand {
        name: "compact",
        summary: "Summarize the conversation to free up context (Claude)",
        kind: SlashKind::Compact,
    },
    SlashCommand {
        name: "approvals",
        summary: "Ask, auto-edit or read-only; applies from the next message (Shift+Tab)",
        kind: SlashKind::Approvals,
    },
    SlashCommand {
        name: "expand",
        summary: "Show or hide full tool output (Ctrl+R)",
        kind: SlashKind::Expand,
    },
    SlashCommand {
        name: "details",
        summary: "Show or hide session details (Ctrl+O)",
        kind: SlashKind::Details,
    },
    SlashCommand {
        name: "copy",
        summary: "Copy the last reply",
        kind: SlashKind::Copy,
    },
    SlashCommand {
        name: "detach",
        summary: "Quit and keep this conversation running",
        kind: SlashKind::Detach,
    },
    SlashCommand {
        name: "exit",
        summary: "Quit pui and end this conversation (resume it later)",
        kind: SlashKind::Exit,
    },
];

/// The command prefix being typed, or `None` when the composer text is not a
/// command. A command is `/` followed by non-whitespace only: the moment the
/// text holds a space or a newline it is an ordinary message, so
/// `/tmp is full` still sends as typed.
pub fn query(input: &str) -> Option<&str> {
    let rest = input.strip_prefix('/')?;
    if rest.chars().any(char::is_whitespace) {
        return None;
    }
    Some(rest)
}

/// Commands whose name starts with `prefix` (case-insensitive), in menu order.
pub fn matching(prefix: &str) -> Vec<&'static SlashCommand> {
    let prefix = prefix.to_ascii_lowercase();
    COMMANDS
        .iter()
        .filter(|c| c.name.starts_with(prefix.as_str()))
        .collect()
}

/// Which command Enter runs: an exact name wins over the highlighted row, so
/// typing `/copy` and pressing Enter never runs a different command that
/// merely sorts first. Otherwise the highlighted row (clamped). `None` means
/// nothing matches — the caller reports an unknown command and sends nothing.
pub fn resolve(prefix: &str, selected: usize) -> Option<&'static SlashCommand> {
    let lower = prefix.to_ascii_lowercase();
    if let Some(exact) = COMMANDS.iter().find(|c| c.name == lower) {
        return Some(exact);
    }
    let hits = matching(prefix);
    if hits.is_empty() {
        return None;
    }
    Some(hits[selected.min(hits.len() - 1)])
}

/// The plain sentence shown for text that looks like a command but is not
/// one. It names the way out, because `/` messages are sometimes real text.
pub fn unknown_message(prefix: &str) -> String {
    format!(
        "No command /{prefix}. Type / to see the commands, or start the message with a space to send it as text."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slash_with_no_whitespace_is_a_command_query() {
        assert_eq!(query("/"), Some(""));
        assert_eq!(query("/he"), Some("he"));
        assert_eq!(query("hello"), None);
        assert_eq!(query(" /help"), None, "a leading space sends the text");
        assert_eq!(
            query("/tmp is full"),
            None,
            "text with a space is a message"
        );
        assert_eq!(query("/a\nb"), None, "a multi-line draft is a message");
    }

    #[test]
    fn matching_filters_by_prefix_in_menu_order() {
        let all: Vec<_> = matching("").iter().map(|c| c.name).collect();
        assert_eq!(all, COMMANDS.iter().map(|c| c.name).collect::<Vec<_>>());
        let e: Vec<_> = matching("e").iter().map(|c| c.name).collect();
        assert_eq!(e, vec!["effort", "expand", "exit"]);
        let ex: Vec<_> = matching("ex").iter().map(|c| c.name).collect();
        assert_eq!(ex, vec!["expand", "exit"]);
        assert_eq!(matching("mo")[0].kind, SlashKind::Model);
        assert!(matching("zzz").is_empty());
        assert_eq!(matching("HE")[0].name, "help", "case-insensitive");
    }

    #[test]
    fn resolve_prefers_the_exact_name_then_the_highlighted_row() {
        assert_eq!(resolve("exit", 0).map(|c| c.kind), Some(SlashKind::Exit));
        assert_eq!(resolve("ex", 1).map(|c| c.kind), Some(SlashKind::Exit));
        assert_eq!(
            resolve("ex", 9).map(|c| c.kind),
            Some(SlashKind::Exit),
            "clamped"
        );
        assert_eq!(resolve("", 0).map(|c| c.kind), Some(SlashKind::Help));
        assert_eq!(resolve("nope", 0), None);
    }

    #[test]
    fn detach_is_its_own_command_and_never_shadows_details() {
        assert_eq!(
            resolve("detach", 0).map(|c| c.kind),
            Some(SlashKind::Detach)
        );
        let de: Vec<_> = matching("de").iter().map(|c| c.name).collect();
        assert_eq!(de, vec!["details", "detach"]);
        assert_eq!(
            resolve("de", 0).map(|c| c.kind),
            Some(SlashKind::Details),
            "the highlighted first row, not detach, runs on a bare prefix"
        );
        let exit = COMMANDS.iter().find(|c| c.kind == SlashKind::Exit).unwrap();
        assert!(exit.summary.contains("end"), "the menu says /exit ends it");
    }

    #[test]
    fn backend_is_reachable_from_the_menu() {
        assert_eq!(
            resolve("backend", 0).map(|c| c.kind),
            Some(SlashKind::Backend)
        );
        assert_eq!(
            resolve("b", 0).map(|c| c.kind),
            Some(SlashKind::Backend),
            "the only command starting with b"
        );
    }

    #[test]
    fn the_unknown_message_names_the_escape_hatch() {
        let m = unknown_message("nope");
        assert!(m.contains("/nope"));
        assert!(m.contains("space"));
    }
}
