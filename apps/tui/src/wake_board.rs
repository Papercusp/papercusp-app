//! The staged-wake board pane (EI-312) — the dock's review surface for
//! manual-mode (paused) agents' pending wakes.
//!
//! Rendered by the pinned `pui wake-pane` dock pane next to the Queen: every
//! agent with a staged queue (queen-rank first), each wake one row with its
//! coalesced fire count (`×N` — staging dedupes identical re-fires, migration
//! 224), age, and source. The keymap mirrors the Fleet `W` overlay (j/k ·
//! r release · e edit & release · s skip) plus the per-agent drains the EI-312
//! backend added: `R` release-all (the WHOLE queue delivered as ONE coalesced
//! wake — one turn, not N) and `S` skip-all. `w` toggles the selected agent's
//! wake-mode so a paused queue can be un-paused without leaving the pane.
//!
//! All render lives here; `app.rs` holds the `wake_board` state + keymap and
//! `ui.rs` a one-line `Tab::Wake` delegation (the fleet.rs convention).

use crate::agent_pane_kind::AgentPaneKind;
use crate::app::App;
use crate::theme::Theme;
use crate::ui::trunc;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{List, ListItem, Paragraph},
    Frame,
};

/// One flat render row: an agent header or one staged wake (the selection
/// space is wakes only — headers are skipped by the flat index).
enum Row<'a> {
    Header(&'a crate::models::WakeGroup),
    Wake {
        wake: &'a crate::models::PendingWake,
        selected: bool,
    },
}

/// The board rows in render order, with the flat selection resolved.
fn rows(app: &App) -> Vec<Row<'_>> {
    let b = &app.wake_board;
    let mut out = Vec::new();
    let mut flat = 0usize;
    for g in &b.groups {
        out.push(Row::Header(g));
        for w in &g.pending {
            out.push(Row::Wake {
                wake: w,
                selected: flat == b.sel,
            });
            flat += 1;
        }
    }
    out
}

/// A staged wake's one-line label: summary (or source fallback) + the
/// coalesced fire count when re-fires folded into it.
fn wake_text(w: &crate::models::PendingWake) -> String {
    let base = w
        .summary
        .clone()
        .or_else(|| w.source.clone())
        .unwrap_or_else(|| format!("wake #{}", w.id));
    if w.count > 1 {
        format!("{base} (×{})", w.count)
    } else {
        base
    }
}

pub fn draw_wake_board(f: &mut Frame, app: &App, body: Rect) {
    let b = &app.wake_board;
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // title / global state
            Constraint::Min(1),    // the board
            Constraint::Length(1), // keymap footer / error
        ])
        .split(body);

    // Title: total staged + the GLOBAL default mode when the whole fleet is
    // paused (that reads very differently from one paused agent).
    let total: i64 = b
        .groups
        .iter()
        .flat_map(|g| g.pending.iter())
        .map(|w| w.count)
        .sum();
    // Per-agent panes (owner ask 2026-06-11) name their scope; the fleet-wide
    // pane stays unadorned.
    let scope = match &app.wake_filter {
        crate::app::WakeFilter::All => String::new(),
        crate::app::WakeFilter::Queen => format!(
            " · {} mug",
            crate::agent_pane_kind::AgentPaneKind::Queen.glyph()
        ),
        crate::app::WakeFilter::Owner(id) => format!(" · {}", trunc(id, 14)),
        crate::app::WakeFilter::Hive(h) => format!(" · ⬡ {}", trunc(h, 14)),
    };
    let mut title = vec![Span::styled(
        format!(" Staged wakes{scope} — {} item(s)", b.total()),
        Theme::title(),
    )];
    if total > b.total() as i64 {
        title.push(Span::styled(
            format!(" ({total} fires coalesced)"),
            Theme::dim(),
        ));
    }
    if b.global_mode.as_deref() == Some("manual") {
        title.push(Span::styled(
            " ⏸ GLOBAL MANUAL — whole fleet paused",
            Theme::warn(),
        ));
    }
    if b.loading {
        title.push(Span::styled(" loading…", Theme::dim()));
    }
    f.render_widget(Paragraph::new(Line::from(title)), chunks[0]);

    // The board: per-agent headers + one row per staged wake.
    if b.groups.is_empty() && !b.loading {
        let empty = match &app.wake_filter {
            crate::app::WakeFilter::All => " no staged wakes".to_string(),
            crate::app::WakeFilter::Hive(_) => format!(
                " no staged wakes for this {}",
                app.lexicon.lex("pot").to_lowercase()
            ),
            _ => " no staged wakes for this agent".to_string(),
        };
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(empty, Theme::dim()))),
            chunks[1],
        );
    } else {
        let items: Vec<ListItem> = rows(app)
            .into_iter()
            .map(|row| match row {
                Row::Header(g) => {
                    let kind = AgentPaneKind::from_opt(&g.kind);
                    let glyph = kind.map(|k| k.glyph()).unwrap_or("·");
                    let mut spans = vec![
                        Span::raw(" "),
                        Span::styled(
                            format!(
                                "{glyph} {}",
                                crate::agent_pane_kind::normalize_agent_label(
                                    &g.label,
                                    &app.lexicon
                                )
                            ),
                            kind.map_or(Theme::title(), |k| Theme::title().fg(k.color())),
                        ),
                        Span::styled(format!(" — {} staged", g.pending.len()), Theme::dim()),
                    ];
                    if g.wake_mode.as_deref() == Some("manual") {
                        spans.push(Span::styled(" ⏸MANUAL", Theme::warn()));
                    }
                    ListItem::new(Line::from(spans))
                }
                Row::Wake { wake, selected } => {
                    let marker = if selected { "▸" } else { " " };
                    let style = if selected {
                        Theme::selected()
                    } else {
                        Style::default()
                    };
                    let mut spans = vec![
                        Span::raw("   "),
                        Span::styled(marker.to_string(), style),
                        Span::styled(format!(" {}", trunc(&wake_text(wake), 90)), style),
                    ];
                    if let Some(src) = &wake.source {
                        spans.push(Span::styled(
                            format!("  [{}]", trunc(src, 24)),
                            Theme::dim(),
                        ));
                    }
                    ListItem::new(Line::from(spans))
                }
            })
            .collect();
        f.render_widget(List::new(items), chunks[1]);
    }

    // Footer: the edit buffer when editing, else the error, else the keymap.
    let footer = if let Some(buf) = &b.edit {
        Line::from(vec![
            Span::styled(" edit→release: ", Theme::warn()),
            Span::styled(buf.clone(), Style::default()),
            Span::styled("▏  Enter send · Esc cancel", Theme::dim()),
        ])
    } else if let Some(err) = &b.error {
        Line::from(Span::styled(format!(" ⚠ {err}"), Theme::warn()))
    } else {
        Line::from(Span::styled(
            " j/k select · r release · e edit · s skip · R release-ALL (one wake) · S skip-ALL · w wake-mode · g refresh",
            Theme::dim(),
        ))
    };
    f.render_widget(Paragraph::new(footer), chunks[2]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{PendingWake, WakeGroup};
    use ratatui::{backend::TestBackend, Terminal};

    fn pw(id: i64, summary: &str, count: i64) -> PendingWake {
        PendingWake {
            id,
            owner_id: "su-q".into(),
            summary: Some(summary.into()),
            source: Some("hive-watchdog:boot".into()),
            created_at: "2026-06-11T02:00:00Z".into(),
            count,
            last_seen_at: None,
        }
    }

    fn board_app() -> App {
        let mut app = App::new();
        app.tab = crate::app::Tab::Wake;
        app.wake_board.loading = false;
        app.wake_board.groups = vec![
            WakeGroup {
                agent: "su-q".into(),
                label: "queen su-75cee".into(),
                kind: Some("queen".into()),
                wake_mode: Some("manual".into()),
                pending: vec![
                    pw(27, "Watchdog wake (boot)", 30),
                    pw(53, "cadence tick", 5),
                ],
            },
            WakeGroup {
                agent: "su-b".into(),
                label: "bee su-664d2".into(),
                kind: Some("bee".into()),
                wake_mode: Some("manual".into()),
                pending: vec![pw(60, "Queen placement — WI-108", 1)],
            },
        ];
        app
    }

    fn render(app: &App) -> String {
        let backend = TestBackend::new(120, 14);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| draw_wake_board(f, app, f.area()))
            .unwrap();
        let buf = terminal.backend().buffer().clone();
        let mut out = String::new();
        for y in 0..buf.area.height {
            for x in 0..buf.area.width {
                out.push_str(buf.cell((x, y)).unwrap().symbol());
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn renders_groups_queen_first_with_coalesced_counts() {
        let app = board_app();
        let s = render(&app);
        // ☕ (Mug) is a double-width glyph — the test backend pads a cell after it
        // (same as the 🍵 cup glyph below), so assert glyph + label separately.
        assert!(s.contains("☕"), "mug glyph: {s}");
        assert!(s.contains("Mug su-75cee"), "mug header: {s}");
        assert!(
            s.contains("Watchdog wake (boot) (×30)"),
            "coalesced count: {s}"
        );
        assert!(s.contains("cadence tick (×5)"), "second wake: {s}");
        // (asserted separately: the 🍵 glyph is double-width, so the test
        // backend pads a cell between it and the label)
        assert!(s.contains("🍵"), "cup glyph: {s}");
        assert!(s.contains("Cup su-664d2 — 1 staged"), "cup header: {s}");
        // ×1 rows render WITHOUT a count suffix.
        assert!(s.contains("Queen placement — WI-108"), "{s}");
        assert!(!s.contains("WI-108 (×1)"), "no ×1 suffix: {s}");
        // Title sums items + coalesced fires (3 items, 36 fires).
        assert!(s.contains("3 item(s)"), "{s}");
        assert!(s.contains("(36 fires coalesced)"), "{s}");
        // The drain keys are advertised.
        assert!(s.contains("R release-ALL"), "{s}");
    }

    #[test]
    fn selection_marker_follows_the_flat_index_across_groups() {
        let mut app = board_app();
        app.wake_board.sel = 2; // third wake — the bee's row
        let s = render(&app);
        let marked: Vec<&str> = s.lines().filter(|l| l.contains('▸')).collect();
        assert_eq!(marked.len(), 1, "{s}");
        assert!(marked[0].contains("WI-108"), "{s}");
    }

    #[test]
    fn empty_board_and_global_manual_states_read_clearly() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Wake;
        app.wake_board.loading = false;
        app.wake_board.global_mode = Some("manual".into());
        let s = render(&app);
        assert!(s.contains("no staged wakes"), "{s}");
        assert!(!s.contains("auto mode"), "{s}");
        assert!(!s.contains("drained"), "{s}");
        assert!(s.contains("GLOBAL MANUAL"), "{s}");
    }

    #[test]
    fn empty_state_does_not_infer_agent_modes_from_missing_wakes() {
        for filter in [
            crate::app::WakeFilter::All,
            crate::app::WakeFilter::Queen,
            crate::app::WakeFilter::Owner("su-agent".into()),
            crate::app::WakeFilter::Hive("papercusp".into()),
        ] {
            let mut app = App::new();
            app.tab = crate::app::Tab::Wake;
            app.wake_board.loading = false;
            app.wake_filter = filter;
            let s = render(&app);
            assert!(s.contains("no staged wakes"), "{s}");
            assert!(!s.contains("auto mode"), "{s}");
            assert!(!s.contains("drained"), "{s}");
        }
    }

    #[test]
    fn per_agent_scope_shows_in_title_and_empty_state() {
        // The queen pane ("wake-pane --queen") names its scope in the title…
        let mut app = board_app();
        app.wake_filter = crate::app::WakeFilter::Queen;
        let s = render(&app);
        assert!(s.contains("Staged wakes · ☕"), "{s}"); // ☕ = Mug (queen scope)
                                                         // …and an owner-pinned pane shows the (truncated) id.
        let mut app = App::new();
        app.tab = crate::app::Tab::Wake;
        app.wake_board.loading = false;
        app.wake_filter = crate::app::WakeFilter::Owner("su-75cee172-9509".into());
        let s = render(&app);
        assert!(s.contains("Staged wakes · su-75cee172-9"), "{s}");
        assert!(s.contains("no staged wakes for this agent"), "{s}");
    }

    #[test]
    fn edit_buffer_and_error_take_over_the_footer() {
        let mut app = board_app();
        app.wake_board.edit = Some("resume: take WI-99".into());
        let s = render(&app);
        assert!(s.contains("edit→release: resume: take WI-99"), "{s}");

        let mut app = board_app();
        app.wake_board.error = Some("operator unreachable".into());
        let s = render(&app);
        assert!(s.contains("⚠ operator unreachable"), "{s}");
    }
}
