//! Agent-context panes (dock 4-pane split, owner ask 2026-06-11) — the three
//! data boards stacked with the wake board in an agent's dock side column:
//!
//!   - `pui prompt-pane` — the prompt the agent RUNS ON: a fleet spawn's
//!     recorded prompt_body (its brief — the per-agent signal — led first,
//!     with the model/tier it launched at), or a live render of the role
//!     persona for interactive agents like the queen (GET
//!     /api/fleet/agent-prompt, sources labeled recorded/rendered);
//!   - `pui mail-pane`   — coord mail addressed to / sent by the agent;
//!   - `pui work-pane`   — its ranked work items + declared plan + claims.
//!
//! Each pane is one pinned `Tab::AgentCtx` pui instance; the mode + agent
//! scope come from argv (default scope: the queen — the panes live in her
//! column). All render lives here; `app.rs` holds the snapshot + keymap
//! (j/k scroll · N notifications) and `ui.rs` a one-line delegation, the
//! wake_board.rs convention.

use crate::app::{AgentCtxMode, App};
use crate::theme::Theme;
use crate::ui::trunc;
use ratatui::{
    layout::Rect,
    text::{Line, Span},
    widgets::{Paragraph, Wrap},
    Frame,
};

/// Short display form of an owner id (mirrors app.rs's short_owner idiom).
fn short(owner: &str) -> String {
    if owner.len() <= 14 {
        owner.to_string()
    } else {
        format!("{}…", &owner[..13])
    }
}

pub fn draw_agent_ctx(f: &mut Frame, app: &App, area: Rect) {
    let mut lines: Vec<Line> = Vec::new();
    match &app.agent_ctx {
        None => lines.push(Line::from(Span::styled("loading…", Theme::dim()))),
        Some(Err(e)) => lines.push(Line::from(Span::styled(
            format!("error: {e}"),
            Theme::warn(),
        ))),
        Some(Ok(d)) => {
            let who = d
                .label
                .clone()
                .or_else(|| d.owner.as_deref().map(short))
                .unwrap_or_else(|| "(no agent)".to_string());
            lines.push(Line::from(vec![
                Span::styled(title(app.agent_ctx_mode), Theme::header()),
                Span::raw(" · "),
                Span::styled(who, Theme::dim()),
            ]));
            lines.push(Line::default());
            if d.owner.is_none() {
                lines.push(Line::from(Span::styled(
                    "agent not on the roster yet",
                    Theme::dim(),
                )));
            } else {
                match app.agent_ctx_mode {
                    AgentCtxMode::Prompt => prompt_lines(d, &mut lines),
                    AgentCtxMode::Mail => mail_lines(d, &mut lines),
                    AgentCtxMode::Work => work_lines(d, &mut lines),
                }
            }
        }
    }
    let para = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((app.agent_ctx_scroll, 0));
    f.render_widget(para, area);
}

fn title(mode: AgentCtxMode) -> &'static str {
    match mode {
        AgentCtxMode::Prompt => "✉ prompt",
        AgentCtxMode::Mail => "✉ mail",
        AgentCtxMode::Work => "☑ work",
    }
}

fn prompt_lines(d: &crate::models::AgentCtxData, lines: &mut Vec<Line<'_>>) {
    if let (Some(m), t) = (&d.model, &d.tier) {
        let tier = t.as_deref().map(|t| format!(" ({t})")).unwrap_or_default();
        lines.push(Line::from(Span::styled(
            format!("model: {m}{tier}"),
            Theme::dim(),
        )));
        lines.push(Line::default());
    }
    // The brief leads when present — it's the per-agent signal; the full
    // prompt below is mostly boilerplate shared across agents of the role.
    if let Some(b) = d.brief.as_deref().filter(|b| !b.trim().is_empty()) {
        lines.push(Line::from(Span::styled("brief", Theme::header())));
        for l in b.lines() {
            lines.push(Line::from(format!("  {l}")));
        }
        lines.push(Line::default());
    }
    match d.prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        Some(p) => {
            let src = match d.source.as_deref() {
                Some("recorded") => "full prompt (recorded — what this run was invoked with)",
                Some("rendered") => "full prompt (rendered — what a fresh session of this role gets)",
                _ => "full prompt",
            };
            lines.push(Line::from(Span::styled(src, Theme::header())));
            for l in p.lines() {
                lines.push(Line::from(l.to_string()));
            }
        }
        None if d.brief.is_none() => lines.push(Line::from(Span::styled(
            "(no prompt available — run predates recording, or the agent is interactive with no role hint)",
            Theme::dim(),
        ))),
        None => lines.push(Line::from(Span::styled(
            "(full prompt not recorded for this run)",
            Theme::dim(),
        ))),
    }
}

fn mail_lines(d: &crate::models::AgentCtxData, lines: &mut Vec<Line<'_>>) {
    let Some(mail) = &d.mail else {
        lines.push(Line::from(Span::styled("loading…", Theme::dim())));
        return;
    };
    lines.push(Line::from(Span::styled(
        format!("inbox ({})", mail.inbox.total),
        Theme::header(),
    )));
    if mail.inbox.entries.is_empty() {
        lines.push(Line::from(Span::styled("  (empty)", Theme::dim())));
    }
    for m in &mail.inbox.entries {
        let from = m.from.as_deref().map(short).unwrap_or_default();
        lines.push(Line::from(vec![
            Span::styled(format!("  {:<10}", trunc(&m.kind, 10)), Theme::warn()),
            Span::styled(format!("{from} "), Theme::dim()),
            Span::raw(m.summary.clone().unwrap_or_default()),
        ]));
    }
    lines.push(Line::default());
    lines.push(Line::from(Span::styled(
        format!("outbox ({})", mail.outbox.total),
        Theme::header(),
    )));
    if mail.outbox.entries.is_empty() {
        lines.push(Line::from(Span::styled("  (empty)", Theme::dim())));
    }
    for m in &mail.outbox.entries {
        let to = m.to.first().map(|t| short(t)).unwrap_or_default();
        lines.push(Line::from(vec![
            Span::styled(format!("  {:<10}", trunc(&m.kind, 10)), Theme::warn()),
            Span::styled(format!("→{to} "), Theme::dim()),
            Span::raw(m.summary.clone().unwrap_or_default()),
        ]));
    }
}

fn work_lines(d: &crate::models::AgentCtxData, lines: &mut Vec<Line<'_>>) {
    let Some(a) = &d.assignment else {
        lines.push(Line::from(Span::styled(
            "(no assignment — nothing queued for this agent)",
            Theme::dim(),
        )));
        return;
    };
    if !a.intent.is_empty() {
        lines.push(Line::from(vec![
            Span::styled("intent: ", Theme::dim()),
            Span::raw(a.intent.clone()),
        ]));
    }
    if let Some(p) = &a.declared_plan_slug {
        lines.push(Line::from(vec![
            Span::styled("plan:   ", Theme::dim()),
            Span::styled(p.clone(), Theme::header()),
        ]));
    }
    let claimed: Vec<&str> = a
        .claims
        .iter()
        .filter_map(|c| c.plan_slug.as_deref())
        .collect();
    if !claimed.is_empty() {
        lines.push(Line::from(vec![
            Span::styled("claims: ", Theme::dim()),
            Span::raw(claimed.join(", ")),
        ]));
    }
    lines.push(Line::default());
    lines.push(Line::from(Span::styled(
        format!("work items ({})", a.queued.len()),
        Theme::header(),
    )));
    if a.queued.is_empty() {
        lines.push(Line::from(Span::styled("  (none queued)", Theme::dim())));
    }
    for w in &a.queued {
        let status = w.status.as_deref().unwrap_or("-");
        let rank = w
            .rank
            .map(|r| format!("#{r}"))
            .unwrap_or_else(|| "·".to_string());
        lines.push(Line::from(vec![
            Span::styled(format!("  {:<3}", rank), Theme::dim()),
            Span::styled(format!("{:<12}", trunc(&w.id, 12)), Theme::header()),
            Span::styled(format!("{:<9}", trunc(status, 9)), Theme::warn()),
            Span::raw(trunc(&w.title, 60)),
        ]));
    }
}
