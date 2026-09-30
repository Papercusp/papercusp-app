//! Semantic glyph vocabulary (Brief 27 / `tui-glyph-vocabulary-2026-06-05`).
//!
//! The ONE source of truth for every status / kind / severity / liveness /
//! action / nav glyph rendered in the TUI. Before this module these were
//! ad-hoc inline string literals scattered across ~10 files (only
//! `fleet::signal_glyph` mapped anything), which is how the vocabulary
//! drifted and how double-width emoji leaked into row content and broke
//! column alignment.
//!
//! ## Rules (enforced by the `width_safety` test below)
//! - Every glyph in `liveness` / `status` / `kind` / `severity` / `action` /
//!   `nav` is a **single display column** — safe to render inside a list row
//!   or table cell without shifting the columns after it.
//! - Double-width (East-Asian-width `W`) emoji are confined to [`header`],
//!   which is used ONLY in `Block` titles, where a width-2 glyph is harmless.
//! - Geometric Unicode, not Nerd-Font (D-003) — a Nerd Font isn't guaranteed
//!   present, and a missing-font codepoint renders as tofu. The override seam
//!   for an optional Nerd-Font set is a deferred enhancement.
//!
//! Colour is paired separately in [`crate::theme`] (`Theme::status_marker`
//! etc.) — the glyph is the shape, the theme is the colour. Call sites pull
//! the glyph (or the styled `Span`) from here; they never inline a literal.

// This module is the SINGLE SOURCE OF TRUTH for the vocabulary (D-001): it
// deliberately defines every semantic glyph + mapper even when a given entry
// has no production call site yet (e.g. `kind_for` / the `kind` glyphs await a
// per-item kind display; some consts are exercised only by the width-safety
// tests). Completeness is the point, so dead-code on the forward-looking
// entries is expected and allowed here rather than pruned.
#![allow(dead_code)]

/// Agent presence dot. Colour (in `theme`) carries freshness; the fill
/// carries liveness: empty → stale, half → idle, full → live.
pub mod liveness {
    pub const LIVE: &str = "●";
    pub const IDLE: &str = "◐";
    pub const STALE: &str = "○";
}

/// Work-item / plan-item / feature lifecycle. The circle-fill family
/// (`○ ◐`) shares the "progress" axis with `liveness` on purpose.
pub mod status {
    pub const TODO: &str = "○";
    pub const WIP: &str = "◐";
    pub const BLOCKED: &str = "⊘";
    pub const DONE: &str = "✓";
    pub const FAILED: &str = "✗";
    pub const DROPPED: &str = "·";
    pub const NEEDS_HUMAN: &str = "◆";
    /// Neutral fallback for an unrecognised status token.
    pub const UNKNOWN: &str = "·";
}

/// Object type (work-item kind). The most taste-sensitive row — every glyph
/// here is a one-line swap if the owner vetoes it (D-005).
pub mod kind {
    pub const FEATURE: &str = "✦";
    pub const BUG: &str = "▲";
    pub const CHANGE: &str = "◇";
    pub const PLAN: &str = "▤";
    pub const CHUNK: &str = "▪";
    pub const TASK: &str = "•";
    pub const RESEARCH: &str = "◎";
    pub const UNKNOWN: &str = "•";
}

/// Issue / curated-signal severity.
pub mod severity {
    pub const INFO: &str = "•";
    pub const WARN: &str = "▲";
    pub const ERROR: &str = "⊘";
    pub const CRITICAL: &str = "◆";
    /// Inbox "alert" tier marker (ASCII on purpose — reads as urgency).
    pub const ALERT: &str = "!";
    /// Decision-owed signal (curator `decision` kind).
    pub const DECISION: &str = "?";
    /// Routine bullet (curator `progress`/default kind).
    pub const ROUTINE: &str = "•";
}

/// Row actions.
pub mod action {
    pub const EDIT: &str = "✎";
    pub const RUN: &str = "▶";
}

/// Navigation / tree affordances.
pub mod nav {
    /// Selected-row / focus cursor.
    pub const CURSOR: &str = "▸";
    pub const EXPANDED: &str = "▾";
    pub const COLLAPSED: &str = "▸";
    /// The Fleet identity marker (label is "Fleet"; the cup-theme rename was
    /// reverted by the owner 2026-06-05, Pot/Cup naming unchanged).
    pub const FLEET: &str = "⚑";
    /// Workbench / tiled-panes indicator (the companion HUD). Single-width
    /// replacement for the old inline `⚡`, which is double-width and broke
    /// the right-aligned status-bar HUD sizing (it counts chars, not columns).
    pub const PANES: &str = "▦";
}

/// Voice-pipeline phase markers (the PTT / realtime composer badges).
pub mod voice {
    /// Reply being synthesized / played back.
    pub const SPEAKING: &str = "♪";
}

/// Binary on/off markers (focus dots, radio/selection state). Shares the
/// circle-fill family with `liveness`/`status` (D-004) but named for what
/// the call site means: "is this thing on?".
pub mod toggle {
    pub const ON: &str = "●";
    pub const OFF: &str = "○";
}

/// Double-width glyphs — permitted ONLY in `Block` titles (header context),
/// NEVER in row content. The `width_safety` test asserts this is the only
/// namespace allowed to hold a width-2 glyph.
pub mod header {
    pub const BOLT: &str = "⚡";
    pub const BELL: &str = "🔔";
    pub const SCROLL: &str = "📜";

    /// The full header-only set — the ONLY glyphs allowed to be double-width
    /// in a rendered frame. Buffer-level alignment tests use this as the
    /// exception list when asserting no wide symbol leaked into row content.
    pub const SET: &[&str] = &[BOLT, BELL, SCROLL];
}

/// Fold a free-string status token (work-item / plan-item / report status)
/// to its glyph. Permissive — an unknown token degrades to a neutral mark
/// rather than dropping the row. Mirrors the tolerance the `<report>`
/// protocol ([[structured-report-protocol-2026-06-05]] D-002) wants.
pub fn status_for(token: &str) -> &'static str {
    match token.trim().to_ascii_lowercase().as_str() {
        "todo" | "pending" | "open" | "ready" | "queued" => status::TODO,
        "wip" | "doing" | "in_progress" | "in-progress" | "active" | "validating" | "running"
        | "review" => status::WIP,
        "blocked" => status::BLOCKED,
        "done" | "completed" | "complete" | "passed" | "shipped" | "resolved" | "closed" => {
            status::DONE
        }
        "failing" | "failed" | "error" => status::FAILED,
        "dropped" | "deprecated" | "cancelled" | "canceled" | "skipped" => status::DROPPED,
        "needs-human" | "needs_human" | "needshuman" => status::NEEDS_HUMAN,
        _ => status::UNKNOWN,
    }
}

/// The presence dot for an agent. `stale` wins (an expired heartbeat reads
/// stale regardless of its last-known liveness); otherwise `"live"` → full,
/// anything else → half. Replaces the inline `if/else` chain in `fleet.rs`.
pub fn liveness_dot(stale: bool, liveness: &str) -> &'static str {
    if stale {
        liveness::STALE
    } else if liveness.eq_ignore_ascii_case("live") {
        liveness::LIVE
    } else {
        liveness::IDLE
    }
}

/// Fold a curated-signal kind to its glyph (replaces `fleet::signal_glyph`).
pub fn signal_for(kind: &str) -> &'static str {
    match kind.trim().to_ascii_lowercase().as_str() {
        "escalation" => severity::WARN,
        "blocker" => severity::ERROR,
        "decision" => severity::DECISION,
        "completion" => status::DONE,
        "progress" => severity::INFO,
        _ => severity::ROUTINE,
    }
}

/// Fold a work-item kind token to its glyph. Part of the centralized
/// vocabulary's public API (Brief 27 / P-002, D-001) for the forthcoming
/// per-item kind display + the `<report>` renderer; no in-tree call site
/// renders a work-item *kind* glyph yet (fleet only aggregates work-item
/// counts) — covered by the module-level `allow(dead_code)` above.
pub fn kind_for(token: &str) -> &'static str {
    match token.trim().to_ascii_lowercase().as_str() {
        "feature" => kind::FEATURE,
        "bug" => kind::BUG,
        "change" => kind::CHANGE,
        "plan" => kind::PLAN,
        "chunk" => kind::CHUNK,
        "task" => kind::TASK,
        "research" | "research-task" | "research_task" => kind::RESEARCH,
        _ => kind::UNKNOWN,
    }
}

/// Tab stop used when text carrying tabs is laid out into cells.
const TAB_STOP: usize = 8;

/// Text safe to lay out into terminal cells (pui-chat-first-ux P-011): tabs
/// expanded to the next tab stop, ANSI escape sequences (CSI, OSC and
/// two-byte escapes) removed, and every other control character except `\n`
/// dropped. Tool output is the usual carrier: Claude's Read result is
/// `     1\tconst …`, and command output can carry colour codes.
pub fn terminal_safe_text(s: &str) -> String {
    use unicode_width::UnicodeWidthChar;
    let mut out = String::with_capacity(s.len());
    let mut col = 0usize;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\n' => {
                out.push('\n');
                col = 0;
            }
            '\t' => {
                let pad = TAB_STOP - col % TAB_STOP;
                out.extend(std::iter::repeat(' ').take(pad));
                col += pad;
            }
            '\u{1b}' => match chars.peek() {
                // CSI: parameters and intermediates, then one final byte.
                Some('[') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&next) {
                            break;
                        }
                    }
                }
                // OSC: runs to BEL or ST (ESC \).
                Some(']') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            },
            c if c.is_control() => {}
            c => {
                out.push(c);
                col += c.width().unwrap_or(0);
            }
        }
    }
    out
}

/// Blank every cell of a finished frame whose symbol holds a control
/// character (pui-chat-first-ux P-011). A cell symbol is written to the
/// terminal verbatim, and ratatui's `Paragraph` keeps any grapheme but `\n`,
/// so a tab in rendered text reached the terminal: the terminal jumped to its
/// tab stop while ratatui's model advanced one cell, and every later write on
/// the row landed shifted. ratatui then believed cells held what it last
/// wrote, so its diff never repaired them — the stale `1ile_pathconst`,
/// `Sess ons` and stray `{` columns of the P-005 review. Scrubbing at the
/// frame keeps the model and the terminal in agreement whatever a widget was
/// handed; [`terminal_safe_text`] is the readable fix where text enters.
pub fn scrub_control_cells(buf: &mut ratatui::buffer::Buffer) {
    for cell in buf.content.iter_mut() {
        if cell.symbol().chars().any(char::is_control) {
            cell.set_symbol(" ");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use unicode_width::UnicodeWidthStr;

    #[test]
    fn terminal_safe_text_expands_tabs_and_drops_escapes() {
        assert_eq!(terminal_safe_text("     1\tconst a"), "     1  const a");
        assert_eq!(terminal_safe_text("a\tb\n\tc"), "a       b\n        c");
        assert_eq!(terminal_safe_text("\u{1b}[31mred\u{1b}[0m ok"), "red ok");
        assert_eq!(terminal_safe_text("\u{1b}]0;title\u{7}x"), "x");
        assert_eq!(terminal_safe_text("\u{1b}]8;;u\u{1b}\\link"), "link");
        assert_eq!(terminal_safe_text("a\rb\u{7}c\u{7f}d"), "abcd");
        // Wide glyphs advance the tab stop by their display width.
        assert_eq!(terminal_safe_text("界\tx"), "界      x");
    }

    /// The P-011 mechanism, pinned at the widget layer: a Paragraph handed a
    /// tab writes it into a cell, and the frame scrub is what removes it.
    #[test]
    fn scrub_removes_control_symbols_a_paragraph_writes() {
        use ratatui::{backend::TestBackend, widgets::Paragraph, Terminal};
        let mut term = Terminal::new(TestBackend::new(20, 1)).unwrap();
        let has_control = |buf: &ratatui::buffer::Buffer| {
            buf.content
                .iter()
                .any(|c| c.symbol().chars().any(char::is_control))
        };
        let raw = term
            .draw(|f| f.render_widget(Paragraph::new("1\tconst"), f.area()))
            .unwrap()
            .buffer
            .clone();
        assert!(
            has_control(&raw),
            "ratatui passes the tab through; the scrub must exist"
        );
        let scrubbed = term
            .draw(|f| {
                f.render_widget(Paragraph::new("1\tconst"), f.area());
                scrub_control_cells(f.buffer_mut());
            })
            .unwrap()
            .buffer
            .clone();
        assert!(!has_control(&scrubbed));
    }

    /// Every glyph a row/cell may render must be exactly one display column.
    /// This is the load-bearing invariant (D-002): the alignment bug the
    /// owner saw was a double-width emoji (`⛔`) in row content.
    const INLINE: &[&str] = &[
        liveness::LIVE,
        liveness::IDLE,
        liveness::STALE,
        status::TODO,
        status::WIP,
        status::BLOCKED,
        status::DONE,
        status::FAILED,
        status::DROPPED,
        status::NEEDS_HUMAN,
        status::UNKNOWN,
        kind::FEATURE,
        kind::BUG,
        kind::CHANGE,
        kind::PLAN,
        kind::CHUNK,
        kind::TASK,
        kind::RESEARCH,
        kind::UNKNOWN,
        severity::INFO,
        severity::WARN,
        severity::ERROR,
        severity::CRITICAL,
        severity::DECISION,
        severity::ROUTINE,
        severity::ALERT,
        action::EDIT,
        action::RUN,
        nav::CURSOR,
        nav::EXPANDED,
        nav::COLLAPSED,
        nav::FLEET,
        nav::PANES,
        toggle::ON,
        toggle::OFF,
        voice::SPEAKING,
    ];

    /// Header glyphs are allowed to be double-width (Block titles only).
    const HEADER: &[&str] = &[header::BOLT, header::BELL, header::SCROLL];

    #[test]
    fn inline_glyphs_are_single_column() {
        for g in INLINE {
            assert_eq!(
                UnicodeWidthStr::width(*g),
                1,
                "inline glyph {g:?} is not single display column — it will break row alignment"
            );
        }
    }

    #[test]
    fn header_namespace_is_the_only_place_double_width_lives() {
        // The header glyphs are the *intended* wide ones.
        for g in HEADER {
            assert_eq!(
                UnicodeWidthStr::width(*g),
                2,
                "header glyph {g:?} expected width 2"
            );
        }
        // And no inline glyph is wide.
        for g in INLINE {
            assert!(
                UnicodeWidthStr::width(*g) <= 1,
                "inline glyph {g:?} is wide — move it to glyph::header"
            );
        }
    }

    #[test]
    fn status_mapper_folds_known_and_unknown() {
        assert_eq!(status_for("done"), status::DONE);
        assert_eq!(status_for("WIP"), status::WIP);
        assert_eq!(status_for("in_progress"), status::WIP);
        assert_eq!(status_for("blocked"), status::BLOCKED);
        assert_eq!(status_for("needs-human"), status::NEEDS_HUMAN);
        assert_eq!(status_for("flibbertigibbet"), status::UNKNOWN);
    }

    #[test]
    fn liveness_dot_prefers_stale() {
        assert_eq!(liveness_dot(true, "live"), liveness::STALE);
        assert_eq!(liveness_dot(false, "live"), liveness::LIVE);
        assert_eq!(liveness_dot(false, "idle"), liveness::IDLE);
    }

    #[test]
    fn signal_mapper_matches_legacy() {
        // Preserves fleet::signal_glyph's meaning.
        assert_eq!(signal_for("escalation"), severity::WARN);
        assert_eq!(signal_for("blocker"), severity::ERROR);
        assert_eq!(signal_for("completion"), status::DONE);
        assert_eq!(signal_for("anything-else"), severity::ROUTINE);
    }
}
