//! Bee-dossier dock pane (pui-bee-dossier-pane-2026-06-06).
//!
//! The 6th chat-dock pane (`pui bee-pane`), to the RIGHT of the swarm pane. It
//! renders the swarm-SELECTED bee's dossier as THREE regions in ONE pui process:
//!   - **Top 50%**: the bee's FULL task list in priority (rank) order — the
//!     `queued` work-list from `fleet:assignments { agent }` (the externalized
//!     per-bee TodoWrite the Queen reads).
//!   - **Bottom 50%**, split horizontally:
//!       - **UPPER**: the bee's coord INBOX (messages addressed to / broadcast
//!         at it).
//!       - **LOWER**: the bee's coord OUTBOX (messages FROM it).
//!         Both from ONE `coord:feed { owner }` read, split client-side — the old
//!         `fleet:bee_mail` transport was retired with the bee tier (P-003
//!         own-tui-full-divorce-2026-08-24).
//!
//! Selection is driven IN-PROCESS by the Fleet-tab roster cursor (the
//! `Action::PublishBeeSelection` arm in main.rs) — the old `fleet:selected_bee`
//! relay between co-located pui processes was retired server-side. Empty
//! state ("select a bee in the swarm pane") shows until a bee is selected.
//!
//! All state + render live here; `app.rs`/`ui.rs`/`main.rs` only hold a `bee`
//! field, a `pinned_bee` flag, the poll task + events, and a draw delegation.

use crate::app::App;
use crate::glyph;
use crate::models::{BeeAssignment, BeeMailEntry, BeeMailPayload, BeeWorkItem};
use crate::theme::Theme;
use crate::ui::trunc;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    text::{Line, Span},
    widgets::{List, ListItem, ListState, Paragraph},
    Frame,
};

/// Bee-pane state: which bee is selected + its fetched dossier.
#[derive(Debug, Clone, Default)]
pub struct BeeState {
    /// The selected bee's ownerId (from the relay). None = nothing selected yet.
    pub owner_id: Option<String>,
    /// The selected bee's adopted name, when the relay carried it (display only).
    pub name: Option<String>,
    /// The bee's assignment (ranked work-list), for `owner_id`. None until fetched.
    pub assignment: Option<BeeAssignment>,
    /// The bee's coord inbox + outbox, for `owner_id`. None until fetched.
    pub mail: Option<BeeMailPayload>,
}

impl BeeState {
    /// Apply a new selection from the relay. Returns true when the selected
    /// ownerId CHANGED (so the run loop knows to refetch the dossier). Clears the
    /// stale assignment/mail on a change so the pane never shows the wrong bee.
    pub fn set_selection(&mut self, owner_id: Option<String>, name: Option<String>) -> bool {
        let changed = self.owner_id != owner_id;
        if changed {
            self.assignment = None;
            self.mail = None;
        }
        self.owner_id = owner_id;
        self.name = name;
        changed
    }

    /// Record a fetched dossier — but only if it's for the currently selected bee
    /// (a stale fetch for a bee we've since moved off is dropped).
    pub fn set_dossier(
        &mut self,
        owner_id: &str,
        assignment: Option<BeeAssignment>,
        mail: Option<BeeMailPayload>,
    ) {
        if self.owner_id.as_deref() != Some(owner_id) {
            return;
        }
        self.assignment = assignment;
        self.mail = mail;
    }

    /// A short header label for the selected bee — its name, else the ownerId.
    pub fn display_label(&self) -> Option<String> {
        self.name
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| self.owner_id.clone())
    }
}

/// Top region: the bee's full work-list in rank (priority) order. `sel` is the
/// highlighted task cursor when this pane is the focused/entered dossier
/// (owner ask 2026-06-16); `None` renders it cursor-free (the read-only embeds).
pub(crate) fn draw_tasklist(
    f: &mut Frame,
    app: &App,
    area: Rect,
    focused: bool,
    sel: Option<usize>,
) {
    let label = app.bee.display_label().unwrap_or_else(|| "?".into());
    let asn = app.bee.assignment.as_ref();
    let queued: &[BeeWorkItem] = asn.map(|a| a.queued.as_slice()).unwrap_or(&[]);

    let items: Vec<ListItem> = queued
        .iter()
        .enumerate()
        .map(|(i, w)| task_row(i, w))
        .collect();

    let body = if items.is_empty() {
        let msg = if asn.is_some() {
            "(no work-items claimed — this cup holds nothing right now)"
        } else {
            "(loading task list…)"
        };
        vec![ListItem::new(Line::from(Span::styled(msg, Theme::dim())))]
    } else {
        items
    };

    let load = asn.map(|a| a.load).unwrap_or(0);
    let intent = asn
        .map(|a| a.intent.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    let alive = asn.map(|a| a.alive).unwrap_or(false);
    let dot = if alive {
        glyph::status::DONE
    } else {
        glyph::status::DROPPED
    };
    let title = format!(
        " {} {} · task list ({} claimed) ",
        dot,
        trunc(&label, 18),
        load
    );
    let body_area = crate::ui::block_with_header(
        f,
        area,
        Theme::block(Line::from(title), focused),
        &format!(" {:<6}{:<5}{}", "rank", "st", "task"),
    );
    // The bee's self-declared intent rides just under the header when present.
    let body_area = if !intent.is_empty() && body_area.height > 1 {
        let split = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(1), Constraint::Min(0)])
            .split(body_area);
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(
                format!("  ↳ {}", trunc(&intent, 56)),
                Theme::info(),
            ))),
            split[0],
        );
        split[1]
    } else {
        body_area
    };
    // A highlighted cursor + auto-scroll when the dossier is focused/entered
    // (owner ask 2026-06-16) — the same idiom as the roster / plan-progress; an
    // unselectable embed (sel=None) or empty list just renders the rows.
    let mut state = ListState::default();
    if let (Some(i), false) = (sel, queued.is_empty()) {
        state.select(Some(i.min(queued.len().saturating_sub(1))));
    }
    let list = List::new(body)
        .style(Theme::panel())
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);
}

/// One task row: rank · status glyph · title (head-of-line — rank 0 / index 0 —
/// is highlighted as "doing").
pub(crate) fn task_row(idx: usize, w: &BeeWorkItem) -> ListItem<'static> {
    let rank = w
        .rank
        .map(|r| format!("#{r}"))
        .unwrap_or_else(|| "—".into());
    let st = glyph::status_for(w.status.as_deref().unwrap_or("todo"));
    let title = if w.title.is_empty() {
        w.id.clone()
    } else {
        w.title.clone()
    };
    // Head-of-line (the bee's current focus) reads brighter than the queue tail.
    let title_style = if idx == 0 {
        Theme::selected()
    } else {
        Theme::panel()
    };
    let writer = w
        .rank_writer
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|wri| format!(" [{}]", &wri[..wri.len().min(5)]))
        .unwrap_or_default();
    ListItem::new(Line::from(vec![
        Span::styled(format!(" {:<6}", rank), Theme::dim()),
        Span::raw(format!("{st:<5}")),
        Span::styled(trunc(&title, 40), title_style),
        Span::styled(writer, Theme::dim()),
    ]))
}

/// Bottom-upper region: the bee's coord INBOX (messages addressed TO it).
/// `sel` is the focused-row cursor (rendered newest-first, so 0 = newest) when
/// this panel holds comms focus, else `None` (quiet — no highlight/active border).
pub(crate) fn draw_inbox(f: &mut Frame, app: &App, area: Rect, sel: Option<usize>) {
    let side = app.bee.mail.as_ref().map(|m| &m.inbox);
    let entries: &[BeeMailEntry] = side.map(|s| s.entries.as_slice()).unwrap_or(&[]);
    let total = side.map(|s| s.total).unwrap_or(0);
    draw_mail(
        f,
        area,
        &format!(" ↘ inbox ({total}) — to this cup "),
        entries,
        app.bee.mail.is_some(),
        true,
        sel,
    );
}

/// Bottom-lower region: the bee's coord OUTBOX (messages FROM it).
pub(crate) fn draw_outbox(f: &mut Frame, app: &App, area: Rect, sel: Option<usize>) {
    let side = app.bee.mail.as_ref().map(|m| &m.outbox);
    let entries: &[BeeMailEntry] = side.map(|s| s.entries.as_slice()).unwrap_or(&[]);
    let total = side.map(|s| s.total).unwrap_or(0);
    draw_mail(
        f,
        area,
        &format!(" ↗ outbox ({total}) — from this cup "),
        entries,
        app.bee.mail.is_some(),
        false,
        sel,
    );
}

/// Shared coord-mail renderer (newest-LAST is how both readers return; we show
/// newest-first here for the inbox-style read). `is_inbox` toggles which peer the
/// row names (sender for inbox, recipients for outbox).
fn draw_mail(
    f: &mut Frame,
    area: Rect,
    title: &str,
    entries: &[BeeMailEntry],
    loaded: bool,
    is_inbox: bool,
    sel: Option<usize>,
) {
    let items: Vec<ListItem> = entries
        .iter()
        .rev() // newest-first for the pane
        .enumerate()
        .map(|(idx, e)| {
            let peer = if is_inbox {
                e.from.clone().unwrap_or_else(|| "?".into())
            } else {
                let to = &e.to;
                if to.iter().any(|t| t == "*") {
                    "*".to_string()
                } else {
                    to.first().cloned().unwrap_or_else(|| "?".into())
                }
            };
            let text = e
                .summary
                .clone()
                .filter(|s| !s.is_empty())
                .or_else(|| e.body.clone())
                .unwrap_or_else(|| e.kind.clone());
            let kind_style = if e.kind == "escalation" || e.kind == "handoff" {
                Theme::warn()
            } else {
                Theme::dim()
            };
            let item = ListItem::new(Line::from(vec![
                Span::styled(format!("{:<7} ", trunc(&hms(&e.ts), 7)), Theme::dim()),
                Span::styled(format!("{:<8} ", trunc(&peer, 8)), kind_style),
                Span::raw(trunc(&text, 34)),
            ]));
            if sel == Some(idx) {
                item.style(Theme::selected())
            } else {
                item
            }
        })
        .collect();
    let body = if items.is_empty() {
        let msg = if loaded { "(none)" } else { "(loading…)" };
        vec![ListItem::new(Line::from(Span::styled(msg, Theme::dim())))]
    } else {
        items
    };
    // Active border when this panel holds comms focus (`sel.is_some()`).
    f.render_widget(
        List::new(body)
            .style(Theme::panel())
            .block(Theme::block(Line::from(title.to_string()), sel.is_some())),
        area,
    );
}

/// The HH:MM:SS slice of an ISO/PG timestamp (mirrors fleet.rs::hms).
fn hms(ts: &str) -> String {
    let time = ts
        .split_once(' ')
        .map(|(_, t)| t)
        .or_else(|| ts.split_once('T').map(|(_, t)| t))
        .unwrap_or(ts);
    let clock = time.split(['.', '-', '+', 'Z']).next().unwrap_or(time);
    let clock = clock.trim();
    if clock.is_empty() {
        trunc(ts, 8)
    } else {
        trunc(clock, 8)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{BeeAssignment, BeeMailEntry, BeeMailPayload, BeeMailSide, BeeWorkItem};
    use ratatui::{backend::TestBackend, Terminal};

    fn wi(id: &str, title: &str, rank: Option<i64>, status: &str) -> BeeWorkItem {
        BeeWorkItem {
            id: id.into(),
            item_kind: Some("chunk".into()),
            title: title.into(),
            status: Some(status.into()),
            rank,
            rank_writer: Some("queen".into()),
        }
    }

    fn mail_entry(kind: &str, from: &str, to: &[&str], summary: &str) -> BeeMailEntry {
        BeeMailEntry {
            ts: "2026-06-06T18:53:58Z".into(),
            msg_id: "m1".into(),
            kind: kind.into(),
            from: Some(from.into()),
            to: to.iter().map(|s| s.to_string()).collect(),
            summary: Some(summary.into()),
            body: None,
        }
    }

    fn render(app: &App, w: u16, h: u16) -> String {
        let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
        // Compose the dossier pieces the Fleet tab renders (tasklist over
        // inbox/outbox) — the old full-screen bee pane is gone
        // (pui-dock-consolidation-2026-06-07).
        term.draw(|f| {
            let rows = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(f.area());
            draw_tasklist(f, app, rows[0], false, None);
            let bottom = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(rows[1]);
            draw_inbox(f, app, bottom[0], None);
            draw_outbox(f, app, bottom[1], None);
        })
        .unwrap();
        term.backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect()
    }

    #[test]
    fn set_selection_detects_change_and_clears_stale() {
        let mut s = BeeState::default();
        assert!(s.set_selection(Some("su-a".into()), None));
        s.assignment = Some(BeeAssignment::default());
        // Same selection again → no change, dossier kept.
        assert!(!s.set_selection(Some("su-a".into()), None));
        assert!(s.assignment.is_some());
        // Different bee → change, stale dossier cleared.
        assert!(s.set_selection(Some("su-b".into()), None));
        assert!(s.assignment.is_none());
    }

    #[test]
    fn set_dossier_drops_stale_fetch() {
        let mut s = BeeState::default();
        s.set_selection(Some("su-a".into()), None);
        // A fetch for a DIFFERENT bee than the current selection is ignored.
        s.set_dossier("su-old", Some(BeeAssignment::default()), None);
        assert!(s.assignment.is_none());
        // A fetch for the current bee lands.
        s.set_dossier("su-a", Some(BeeAssignment::default()), None);
        assert!(s.assignment.is_some());
    }

    #[test]
    fn renders_tasklist_in_rank_order_and_mail_both_sides() {
        let mut app = App::new();
        app.bee
            .set_selection(Some("su-bee".into()), Some("forager".into()));
        app.bee.set_dossier(
            "su-bee",
            Some(BeeAssignment {
                agent_id: "su-bee".into(),
                name: Some("forager".into()),
                alive: true,
                intent: "porting handlers".into(),
                queued: vec![
                    wi("WI-1", "head of line task", Some(0), "in_progress"),
                    wi("WI-2", "second task", Some(1), "todo"),
                ],
                load: 2,
                ..Default::default()
            }),
            Some(BeeMailPayload {
                owner_id: "su-bee".into(),
                inbox: BeeMailSide {
                    total: 1,
                    entries: vec![mail_entry("message", "queen", &["su-bee"], "do the thing")],
                },
                outbox: BeeMailSide {
                    total: 1,
                    entries: vec![mail_entry("message", "su-bee", &["queen"], "thing done")],
                },
            }),
        );
        let text = render(&app, 80, 30);
        // Header names the bee + its load.
        assert!(text.contains("forager"));
        assert!(text.contains("task list (2 claimed)"));
        assert!(text.contains("porting handlers"));
        // Both work-items render, head-of-line first.
        assert!(text.contains("head of line task"));
        assert!(text.contains("second task"));
        // Inbox + outbox sections + their entries.
        assert!(text.contains("inbox (1)"));
        assert!(text.contains("outbox (1)"));
        assert!(text.contains("do the thing"));
        assert!(text.contains("thing done"));
    }

    #[test]
    fn shows_loading_until_dossier_arrives() {
        let mut app = App::new();
        app.bee.set_selection(Some("su-bee".into()), None);
        // Selected but not yet fetched → loading hints, not empty-state.
        let text = render(&app, 70, 24);
        assert!(!text.contains("select a bee in the swarm pane"));
        assert!(text.contains("loading task list"));
    }

    #[test]
    fn empty_worklist_distinct_from_loading() {
        let mut app = App::new();
        app.bee.set_selection(Some("su-bee".into()), None);
        app.bee.set_dossier(
            "su-bee",
            Some(BeeAssignment {
                agent_id: "su-bee".into(),
                load: 0,
                ..Default::default()
            }),
            Some(BeeMailPayload::default()),
        );
        let text = render(&app, 70, 24);
        assert!(text.contains("no work-items claimed"));
    }
}
