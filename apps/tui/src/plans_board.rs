//! The dock's Context pane (P-006), refitted in place from the former plans
//! board. It renders only the server-normalized
//! `conversations.contextProjection` contract shared with the GUI (D-004).
//! Missing frames stay missing: this renderer never reconstructs context from
//! plans, roster, work-items, locks, or transcripts.

use crate::app::App;
use crate::glyph;
use crate::models::{ConversationContextFrame, ConversationContextProjection};
use crate::theme::Theme;
use crate::ui::trunc;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::Modifier,
    text::{Line, Span},
    widgets::{Paragraph, Wrap},
    Frame,
};

fn task_marker(status: &str) -> (&'static str, ratatui::style::Style) {
    match status {
        "completed" => (glyph::status::DONE, Theme::success()),
        "in_progress" => (glyph::status::WIP, Theme::info()),
        "blocked" => (glyph::status::BLOCKED, Theme::warn()),
        "dropped" => (glyph::status::DROPPED, Theme::dim()),
        _ => (glyph::status::TODO, Theme::dim()),
    }
}

fn context_state_style(state: Option<&str>) -> ratatui::style::Style {
    match state {
        Some("blocked" | "ended" | "dead" | "critical") => Theme::warn(),
        Some("live" | "done" | "green") => Theme::success(),
        Some("parked" | "waiting") => Theme::info(),
        _ => Theme::dim(),
    }
}

fn projection_lines(app: &App, projection: &ConversationContextProjection) -> Vec<Line<'static>> {
    let mut lines = vec![Line::from(vec![
        Span::styled("Capabilities  ", Theme::dim()),
        Span::styled(
            if projection.capabilities.live_frames {
                "live frames"
            } else {
                "snapshot"
            },
            Theme::info(),
        ),
        Span::styled(
            if projection.capabilities.task_write {
                " · task write"
            } else {
                " · tasks read-only"
            },
            if projection.capabilities.task_write {
                Theme::success()
            } else {
                Theme::dim()
            },
        ),
        Span::styled(
            if projection.capabilities.approval_write {
                " · approval write"
            } else {
                ""
            },
            Theme::success(),
        ),
    ])];

    for frame in &projection.frames {
        if let ConversationContextFrame::Context { title, entries, .. } = frame {
            lines.push(Line::from(Span::styled(
                format!("\n{title}"),
                Theme::title().add_modifier(Modifier::BOLD),
            )));
            for entry in entries {
                let mut spans = vec![
                    Span::styled(format!("  {:<13}", trunc(&entry.label, 12)), Theme::dim()),
                    Span::styled(
                        entry.value.clone(),
                        entry
                            .state
                            .as_deref()
                            .map(|state| context_state_style(Some(state)))
                            .unwrap_or_else(Theme::panel),
                    ),
                ];
                if !entry.badges.is_empty() {
                    spans.push(Span::raw("  "));
                    for (index, badge) in entry.badges.iter().enumerate() {
                        if index > 0 {
                            spans.push(Span::raw(" "));
                        }
                        spans.push(Span::styled(
                            badge.label.clone(),
                            context_state_style(badge.state.as_deref()),
                        ));
                    }
                }
                lines.push(Line::from(spans));
            }
        }
    }

    let tasks = projection.tasks();
    if !tasks.is_empty() {
        lines.push(Line::from(Span::styled(
            format!("\nTasks ({})", tasks.len()),
            Theme::title().add_modifier(Modifier::BOLD),
        )));
        for (index, frame) in tasks.into_iter().enumerate() {
            if let ConversationContextFrame::Task {
                content,
                active_form,
                status,
                blocker_ref,
                explanation,
                links,
                ..
            } = frame
            {
                let selected = index == app.context_task_sel;
                let (marker, style) = task_marker(status);
                let label = if status == "in_progress" {
                    active_form.clone()
                } else {
                    content.clone()
                };
                let mut spans = vec![
                    Span::styled(if selected { "▸ " } else { "  " }, Theme::selected()),
                    Span::styled(format!("{marker} "), style),
                    Span::styled(
                        label,
                        if selected {
                            Theme::selected()
                        } else {
                            Theme::panel()
                        },
                    ),
                ];
                if let Some(blocker) = blocker_ref {
                    spans.push(Span::styled(
                        format!("  blocked on {blocker}"),
                        Theme::warn(),
                    ));
                }
                lines.push(Line::from(spans));
                if let Some(note) = explanation {
                    lines.push(Line::from(Span::styled(
                        format!("      {note}"),
                        Theme::dim(),
                    )));
                }
                if !links.is_empty() {
                    lines.push(Line::from(vec![
                        Span::styled("      evidence ", Theme::dim()),
                        Span::styled(
                            links
                                .iter()
                                .map(|link| {
                                    let relation = match link.relation {
                                        crate::models::ConversationTaskLinkRelation::For => "for",
                                        crate::models::ConversationTaskLinkRelation::Relates => {
                                            "relates"
                                        }
                                    };
                                    format!("{} ({relation})", link.work_item_id)
                                })
                                .collect::<Vec<_>>()
                                .join(" · "),
                            Theme::info(),
                        ),
                    ]));
                }
            }
        }
    }

    if let Some(editor) = &app.context_task_editor {
        lines.push(Line::default());
        lines.push(Line::from(vec![
            Span::styled(format!("{} > ", editor.kind.label()), Theme::header()),
            Span::styled(editor.input.clone(), Theme::selected()),
        ]));
        lines.push(Line::from(Span::styled(
            if app.context_task_pending {
                "  saving… exact draft retained until the canonical projection returns"
            } else {
                "  Enter save · Esc cancel · Ctrl-U clear"
            },
            Theme::dim(),
        )));
    }
    // Task keys are ignored while a mutation is in flight (context_key), so a
    // status/move/drop key must say so too, not only the text editor.
    if app.context_task_pending && app.context_task_editor.is_none() {
        lines.push(Line::from(Span::styled(
            "  saving… task keys resume when the canonical projection returns",
            Theme::dim(),
        )));
    }

    if let Some(error) = app.last_error.as_deref() {
        lines.push(Line::from(Span::styled(
            format!("\n{error}"),
            Theme::warn(),
        )));
    }

    let approvals = projection
        .frames
        .iter()
        .filter_map(|frame| match frame {
            ConversationContextFrame::Approval {
                tool_name,
                status,
                reason,
                ..
            } => Some((tool_name, status, reason)),
            _ => None,
        })
        .collect::<Vec<_>>();
    if !approvals.is_empty() {
        lines.push(Line::from(Span::styled(
            format!("\nNeeds you ({})", approvals.len()),
            Theme::warn().add_modifier(Modifier::BOLD),
        )));
        for (tool, status, reason) in approvals {
            lines.push(Line::from(vec![
                Span::styled("  ! ", Theme::warn()),
                Span::styled(
                    tool.clone().unwrap_or_else(|| "tool".to_string()),
                    Theme::panel(),
                ),
                Span::styled(format!(" · {status}"), Theme::dim()),
                Span::styled(
                    reason
                        .as_deref()
                        .map(|r| format!(" · {r}"))
                        .unwrap_or_default(),
                    Theme::dim(),
                ),
            ]));
        }
    }
    lines
}

/// What Context says before a projection arrives. The dock pane waits for the
/// operator's live native session; the workbench follows Agent Chat, so with
/// no conversation open there is honestly nothing to describe — never another
/// session's context standing in for it.
fn placeholder_lines(app: &App) -> Vec<Line<'static>> {
    let text = if app.context_projection_target.is_some() {
        "This session's producer does not expose Context at its current capability tier."
    } else if app.pinned.is_some() {
        "Waiting for a live Sentinel native-session identity…"
    } else {
        "No conversation is open — Context follows the session Agent Chat has selected."
    };
    vec![Line::from(Span::styled(text, Theme::dim()))]
}

/// Surface B's 40-column Context rail beside Agent Chat (PUBLIC_RELEASE_UX.md
/// § Wide terminal): the same projection the focused Context renders, for the
/// conversation Agent Chat has selected. The rail is read-only — task keys act
/// once Ctrl-T focuses Context — so it advertises that door rather than keys
/// it cannot take.
pub fn draw_context_rail(f: &mut Frame, app: &App, area: Rect) {
    let lines = match &app.context_projection {
        Some(projection) => projection_lines(app, projection),
        None => placeholder_lines(app),
    };
    f.render_widget(
        Paragraph::new(lines)
            .block(Theme::block(Line::from(" Context · Ctrl-T "), false))
            .wrap(Wrap { trim: false }),
        area,
    );
}

pub fn draw_plans_board(f: &mut Frame, app: &App, body: Rect) {
    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(2),
        ])
        .split(body);
    let tier = app
        .context_projection
        .as_ref()
        .map(|projection| projection.session.capability_tier.as_str())
        .unwrap_or("unavailable");
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" Context", Theme::title().add_modifier(Modifier::BOLD)),
            Span::styled(format!(" · {tier}"), Theme::dim()),
            // The workbench reaches this surface with Ctrl-T; name the way back.
            Span::styled(
                if app.pinned.is_none() {
                    " · Esc/o Agent Chat"
                } else {
                    ""
                },
                Theme::dim(),
            ),
        ])),
        outer[0],
    );
    let lines = match &app.context_projection {
        Some(projection) => projection_lines(app, projection),
        None => placeholder_lines(app),
    };
    f.render_widget(
        Paragraph::new(lines)
            .block(Theme::block(Line::from(" Shared projection "), true))
            .wrap(Wrap { trim: false }),
        outer[1],
    );
    let writable = app
        .context_projection
        .as_ref()
        .is_some_and(|projection| projection.capabilities.task_write);
    let footer = if writable {
        vec![
            Line::from(Span::styled(
                " a/e add/edit · s/x start/done · b/u block/unblock · r reopen ",
                Theme::dim(),
            )),
            Line::from(Span::styled(
                " K/J move · d drop · Shift-P promote · g refresh ",
                Theme::dim(),
            )),
        ]
    } else {
        vec![Line::from(Span::styled(
            " g refresh · unavailable sections stay absent ",
            Theme::dim(),
        ))]
    };
    f.render_widget(Paragraph::new(footer), outer[2]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        ConversationContextBadge, ConversationContextCapabilities, ConversationContextEntry,
        ConversationContextProjectionTarget, ConversationContextSession,
        ConversationTaskLinkRelation, ConversationTaskWorkItemLink,
    };
    use ratatui::{backend::TestBackend, Terminal};

    fn render(app: &App) -> String {
        let backend = TestBackend::new(100, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| draw_plans_board(frame, app, frame.area()))
            .unwrap();
        let buf = terminal.backend().buffer();
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf.cell((x, y)).unwrap().symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn projection(task_write: bool) -> ConversationContextProjection {
        ConversationContextProjection {
            schema_version: "conversation-context-v1".into(),
            session: ConversationContextSession {
                source_kind: "agent_chat".into(),
                session_id: "chat-1".into(),
                harness: Some("papercusp".into()),
                role: Some("sentinel".into()),
                linked_work_item_id: Some("WI-1".into()),
                capability_tier: "owned-loop".into(),
            },
            capabilities: ConversationContextCapabilities {
                live_frames: true,
                task_write,
                approval_write: true,
            },
            frames: vec![
                ConversationContextFrame::Context {
                    id: "context:identity".into(),
                    section: "identity".into(),
                    title: "Identity".into(),
                    entries: vec![ConversationContextEntry {
                        label: "Session".into(),
                        value: "chat-1".into(),
                        state: None,
                        badges: vec![],
                    }],
                },
                ConversationContextFrame::Context {
                    id: "context:fleet".into(),
                    section: "fleet".into(),
                    title: "Fleet".into(),
                    entries: vec![ConversationContextEntry {
                        label: "Roster".into(),
                        value: "2 members".into(),
                        state: None,
                        badges: vec![
                            ConversationContextBadge {
                                label: "●".into(),
                                state: Some("live".into()),
                                title: Some("su-a · live".into()),
                            },
                            ConversationContextBadge {
                                label: "◐".into(),
                                state: Some("parked".into()),
                                title: Some("su-b · parked".into()),
                            },
                        ],
                    }],
                },
                ConversationContextFrame::Task {
                    id: "task:t1".into(),
                    task_id: "t1".into(),
                    content: "Ship the pane".into(),
                    active_form: "Shipping the pane".into(),
                    status: "in_progress".into(),
                    blocker_ref: None,
                    explanation: None,
                    position: 0,
                    updated_at: "now".into(),
                    links: vec![ConversationTaskWorkItemLink {
                        work_item_id: "WI-9".into(),
                        work_item_harness: Some("papercusp".into()),
                        relation: ConversationTaskLinkRelation::For,
                    }],
                },
            ],
        }
    }

    #[test]
    fn renders_only_shared_projection_sections_and_tasks() {
        let mut app = App::new();
        app.context_projection = Some(projection(true));
        let output = render(&app);
        assert!(output.contains("Context · owned-loop"));
        assert!(output.contains("Identity"));
        assert!(output.contains("chat-1"));
        assert!(output.contains("Fleet"));
        assert!(output.contains("2 members  ● ◐"));
        assert!(output.contains("Shipping the pane"));
        assert!(output.contains("evidence WI-9 (for)"));
        assert!(output.contains("task write"));
        assert!(output.contains("a/e add/edit"));
        assert!(output.contains("K/J move"));
    }

    #[test]
    fn renders_the_pending_editor_and_retryable_error_with_the_exact_draft() {
        let mut app = App::new();
        app.context_projection = Some(projection(true));
        app.context_task_editor = Some(crate::app::ContextTaskEditor {
            kind: crate::app::ContextTaskEditorKind::Edit,
            task_id: Some("t1".into()),
            input: "Owner's exact revision".into(),
            expected_updated_at: Some("now".into()),
        });
        app.last_error = Some("context task: task_revision_conflict".into());
        let output = render(&app);
        assert!(output.contains("Edit task > Owner's exact revision"));
        assert!(output.contains("task_revision_conflict"));
    }

    #[test]
    fn a_pending_status_mutation_says_task_keys_are_held() {
        let mut app = App::new();
        app.context_projection = Some(projection(true));
        assert!(!render(&app).contains("saving…"));
        app.context_task_pending = true;
        assert!(render(&app).contains("saving… task keys resume"));
    }

    #[test]
    fn absent_projection_is_an_explicit_degradation() {
        let mut app = App::new();
        app.context_projection_target = Some(ConversationContextProjectionTarget::new(
            "codex",
            "rollout-1",
            None,
        ));
        let output = render(&app);
        assert!(output.contains("unavailable"));
        assert!(output.contains("does not expose Context"));
    }
}
