//! Rendering — a pure function of `&App`. No state mutation, so every view is
//! snapshot-testable against a ratatui `TestBackend`.

use crate::app::{
    App, CupboardFocus, FleetLauncherField, HarnessFocus, InboxFocus, SessionBrowserFacet, Tab,
    TestingFocus, ToolPalettePhase, SESSION_BROWSER_STATES, SESSION_BROWSER_WHEN,
};
use crate::models::{
    contribution_count, contribution_names, tier_glyph, tier_label, Notif,
    SessionTranscriptAvailability, ToolOutcome, INBOX_TIERS,
};
use crate::semantic_tool_cards::SemanticTone;
use crate::theme::Theme;
use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Margin, Position, Rect},
    style::Style,
    text::{Line, Span, Text},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Tabs, Wrap},
    Frame,
};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// Minimum body width for the Surface B cockpit (P-004 / D-005,
/// pui-psu-exact-launch-and-task-latency-2026-09-01).
///
/// DERIVED, not chosen by feel: the Agent Chat dock is a fixed `Length(40)`
/// (see `draw`), and the pane beside it must stay a genuinely usable content
/// body. This suite's own modal render width is 120 columns — more call sites
/// than any other width — so 120 is what this codebase already treats as
/// "wide enough to show a surface's content". 40 + 120 = 160.
///
/// The bare geometric floor is lower (dock 40 + presence rail 30 + body
/// `Min(48)` = 118), but that floor only guarantees nothing is *clipped*; it
/// leaves an 80-column body that squeezes the Fleet, Plans, Cupboard, Docs and
/// Sessions surfaces. 160 is the smallest width at which the cockpit and a
/// conventional content body coexist, so it is the honest gate.
///
/// This was `260` until WI-2140985 — well past any ordinary terminal, so the
/// cockpit never rendered in practice: the same user-visible outcome D-005
/// rejected for the old opt-in toggle ("hiding Agent Chat behind an optional
/// toggle does not satisfy the original layout intent"). The suite could not
/// see it because both dock tests straddled the gap — one renders at 80, the
/// other at 280 — so nothing exercised the band between, where real terminals
/// live. Guarded now by `operator_dock_renders_at_ordinary_terminal_width`
/// (fails under 260) and `surface_b_min_width_matches_the_layout_constraints_it_guards`.
pub(crate) const SURFACE_B_MIN_WIDTH: u16 = 160;

/// PUBLIC_RELEASE_UX.md § Wide terminal is "160 columns by 24 rows or larger";
/// below 24 rows the compact rules apply and Context is reached with Ctrl-T
/// instead of squeezing a rail beside the four-row composer.
pub(crate) const SURFACE_B_MIN_HEIGHT: u16 = 24;

/// The smallest supported terminal (PUBLIC_RELEASE_UX.md "Below 80 columns or
/// 20 rows"). Below it the whole screen is the blocking too-small view.
pub(crate) const MIN_COLS: u16 = 80;
pub(crate) const MIN_ROWS: u16 = 20;

pub(crate) fn too_small(cols: u16, rows: u16) -> bool {
    cols < MIN_COLS || rows < MIN_ROWS
}

pub fn draw(f: &mut Frame, app: &App) {
    if app.too_small() {
        draw_too_small(f);
    } else {
        draw_frame(f, app);
    }
    // Colour-disabled mode (NO_COLOR, P-013) clears the finished frame, so it
    // holds whichever branch below painted it and however a site named a colour.
    Theme::finish_frame(f.buffer_mut());
    // No control character may reach the terminal (P-011): it desyncs the
    // terminal from ratatui's model and leaves stale characters behind.
    crate::glyph::scrub_control_cells(f.buffer_mut());
}

/// The stable blocking view below the supported size: one instruction instead
/// of clipped controls. `App::on_key` holds every key but quit while it shows,
/// so nothing the owner cannot see changes underneath it, and a resize back
/// resumes the surface and draft exactly as they were.
fn draw_too_small(f: &mut Frame) {
    let area = f.area();
    let message = format!(
        "Terminal too small — resize to at least {MIN_COLS}×{MIN_ROWS}. \
         Your session and draft are safe."
    );
    let height = area.height.min(4);
    let text_area = Rect {
        y: area.y + area.height.saturating_sub(height) / 2,
        height,
        ..area
    };
    f.render_widget(Block::default().style(Theme::panel()), area);
    f.render_widget(
        Paragraph::new(message)
            .alignment(Alignment::Center)
            .wrap(Wrap { trim: true })
            .style(Theme::panel()),
        text_area,
    );
}

fn draw_frame(f: &mut Frame, app: &App) {
    // Pinned single-pane dock mode (native-terminal-desktop P-013 / D-011): the
    // desktop-docked native terminal's panes render JUST one tab's body — no
    // tab strip, no HUD, no work area. The tab's state + data wiring are
    // unchanged; only the rendering is reduced to that body full-screen (the
    // tab is re-pinned in main.rs). Help + the latest toast still overlay.
    // Chat-first (P-001) takes the same full-screen branch for whichever of its
    // two surfaces is current: the conversation or its Ctrl-T Context view.
    let full_screen = app.pinned.or(app.chat_first.then_some(app.tab));
    if let Some(pinned) = full_screen {
        draw_tab_body(f, app, pinned, f.area());
        // Every overlay the full layout draws, drawn here too. This branch
        // used to carry its own shorter list, and each state it left out was a
        // modal that captured keys while drawing nothing: 'N' notifications
        // (owner report 2026-06-11), then chat-first's New-session form and
        // first-run tutorial (owner #783 — the first message went nowhere).
        draw_overlays(f, app);
        return;
    }

    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // tab strip
            Constraint::Min(1),    // body
            Constraint::Length(1), // status bar
        ])
        .split(f.area());

    draw_tabs(f, app, root[0]);

    // Operator dock (operator-always-visible-2026-06-05, Brief 24; P-004): the
    // owner-approved cockpit keeps Agent Chat persistently docked on the RIGHT
    // of every tab EXCEPT the tabs that already host the operator themselves —
    // the Operator tab (the whole tab IS the chat) and the Overview tab (its
    // draw_overview renders the same chat as the always-on bottom strip).
    // Reuses `draw_operator_dock`/`draw_chat` and the shared `chat_*` state — one
    // conversation, multiple render sites — so the transcript and composer stay
    // visible beside Sessions/task content. The old optional hidden toggle is no
    // longer a layout decision; only the width gate protects narrow terminals.
    // Carve the pane BEFORE presence and plans-filter splits so the panes never
    // overlap.
    // Surface B needs enough room for a readable main pane, presence rail,
    // and the fixed 40-column side column. Keep the existing full-width layout
    // below this threshold rather than collapsing its content to a sliver.
    // The threshold is the arithmetic of the constraints just below, not a
    // feel-good margin — see SURFACE_B_MIN_WIDTH.
    let surface_b = root[1].width >= SURFACE_B_MIN_WIDTH;
    let side_column = || {
        let cols = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(56), Constraint::Length(40)])
            .split(root[1]);
        (cols[0], cols[1])
    };
    let (work, op_dock, context_rail) =
        if app.tab != Tab::Operator && app.tab != Tab::Overview && surface_b {
            let (work, dock) = side_column();
            (work, Some(dock), None)
        } else if app.tab == Tab::Operator && surface_b && f.area().height >= SURFACE_B_MIN_HEIGHT {
            // PUBLIC_RELEASE_UX.md § Wide terminal: on Agent Chat the same
            // column is the selected conversation's Context rail, so the
            // conversation and its work stay visible together.
            let (work, rail) = side_column();
            (work, None, Some(rail))
        } else {
            (root[1], None, None)
        };

    // P7: an always-visible presence sidebar (who's online + intent), toggled
    // with `p`. Only where there is room for two surfaces: the compact band
    // (80–159 columns) shows one primary surface at a time and never squeezes
    // a second pane beside it (PUBLIC_RELEASE_UX.md).
    let (body, presence) = if app.show_presence && work.width >= SURFACE_B_MIN_WIDTH {
        let cols = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(48), Constraint::Length(30)])
            .split(work);
        (cols[0], Some(cols[1]))
    } else {
        (work, None)
    };

    // D-009: the collapsible plans-filter rail, carved off the LEFT of the body
    // on the two tabs it narrows (Inbox + Fleet). Suppressed on narrow bodies so
    // the lists stay usable; the filter itself still applies when hidden.
    let (rail, body) =
        if app.plan_filter_open && matches!(app.tab, Tab::Inbox | Tab::Fleet) && body.width >= 70 {
            let cols = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Length(32), Constraint::Min(38)])
                .split(body);
            (Some(cols[0]), cols[1])
        } else {
            (None, body)
        };

    draw_tab_body(f, app, app.tab, body);
    if let Some(area) = rail {
        draw_plan_filter(f, app, area);
    }
    if let Some(area) = presence {
        draw_presence(f, app, area);
    }
    // Operator dock (operator-always-visible-2026-06-05): render last of the
    // right-side panes so it owns its carved column outright.
    if let Some(area) = op_dock {
        draw_operator_dock(f, app, area);
    }
    if let Some(area) = context_rail {
        crate::plans_board::draw_context_rail(f, app, area);
    }
    draw_status(f, app, root[2]);
    draw_overlays(f, app);
}

/// Everything drawn over the body, in stacking order. Shared by the full
/// layout and the full-screen branch (pinned dock panes, chat-first) so the
/// two cannot drift: a state whose keys `on_key` captures must have a paint in
/// BOTH, and one list is the only way that stays true.
fn draw_overlays(f: &mut Frame, app: &App) {
    // An open change card sits above the body and BELOW the toast: `y` on the
    // card acknowledges through that same toast, and a copy the reader cannot
    // see confirmed is the one thing this surface must not do. It is likewise
    // below every modal overlay drawn after it, which is where `on_key` puts
    // it — the switcher/question surfaces own their keys ahead of the card.
    draw_change_card(f, app);
    draw_file_picker(f, app);

    // A transient toast for the latest notification sits above the body but
    // below the modal overlays (it shouldn't fight the help/palette/tutorial).
    if let Some(t) = &app.toast {
        if app.notify_enabled
            && !app.show_tutorial
            && !app.show_help
            && !app.palette_open
            && !app.show_notifs
            && !app.pot_picker_open
            && app.fleet_action_menu.is_none()
            && app.wake_review.is_none()
            && app.fleet_launcher.is_none()
            && app.inbox_answer.is_none()
            && app.lifecycle.is_none()
        {
            draw_toast(f, t);
        }
    }

    // Overlays render on top of the body (tutorial wins on first run).
    if app.show_tutorial {
        draw_tutorial(f, app.tutorial_step);
    } else if let Some(panel) = &app.lifecycle {
        draw_lifecycle(f, panel);
    } else if app.show_notifs {
        draw_notifs(f, app);
    } else if app.show_help {
        draw_help(f, app);
    } else if app.palette_open {
        draw_palette(f, app);
    } else if app.pot_picker_open {
        draw_pot_picker(f, app);
    } else if let Some(picker) = &app.session_picker {
        draw_session_picker(f, picker);
    } else if app.session_setup.is_some() && app.chat_first_quiet_wait().is_none() {
        // A chat-first quick start still settling keeps the chat on screen
        // (P-012); the form opens only on a reason the owner must act on.
        draw_session_setup(f, app);
    } else if let Some(menu) = &app.fleet_action_menu {
        draw_fleet_menu(f, menu);
    } else if let Some(prompt) = &app.crew_restore_prompt {
        draw_crew_restore_prompt(f, prompt);
    } else if let Some(rev) = &app.wake_review {
        draw_wake_review(f, rev);
    }
    // The detail popup (Fleet mail/conversation/plan, or the Plans-tab plan)
    // floats above the body + the other overlays.
    if app.fleet_detail_open {
        draw_fleet_detail(f, app);
    }
    if app.critical_path_open {
        draw_critical_path(f, app);
    }
    if app.fleet_launcher.is_some() {
        draw_fleet_launcher(f, app);
    }
    if app.session_switcher.is_some() {
        draw_session_switcher(f, app);
    }
    if app.inbox_answer.is_some() {
        draw_inbox_answer(f, app);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CriticalPathNode {
    item_id: String,
    status: String,
    depth: usize,
    waiters: usize,
    holder: Option<String>,
    pressure: Option<String>,
    unclaimed: bool,
    cycle: bool,
}

fn terminal_plan_item(status: Option<&str>) -> bool {
    matches!(
        status.unwrap_or_default().to_ascii_lowercase().as_str(),
        "done" | "dropped" | "resolved" | "deprecated" | "cancelled" | "canceled"
    )
}

/// Derive P-028's remaining-work DAG at render time. Completed blockers vanish
/// from the scheduling graph, dangling refs are ignored, and cyclic residue is
/// kept visible in a final loud column rather than recursing forever.
fn critical_path_columns(
    states: &crate::models::PlanItemStates,
    assignments: &[crate::models::BeeAssignment],
) -> Vec<Vec<CriticalPathNode>> {
    let active: BTreeMap<String, &crate::models::PlanItemState> = states
        .items
        .iter()
        .filter(|item| item.in_plan && !terminal_plan_item(item.item_status.as_deref()))
        .map(|item| (item.item_id.clone(), item))
        .collect();
    if active.is_empty() {
        return Vec::new();
    }

    let mut indegree: BTreeMap<String, usize> = active.keys().map(|id| (id.clone(), 0)).collect();
    let mut dependents: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (item_id, item) in &active {
        let blockers: BTreeSet<String> = item
            .blocked_by
            .iter()
            .filter(|blocker| active.contains_key(*blocker))
            .cloned()
            .collect();
        indegree.insert(item_id.clone(), blockers.len());
        for blocker in blockers {
            dependents.entry(blocker).or_default().push(item_id.clone());
        }
    }
    for children in dependents.values_mut() {
        children.sort();
        children.dedup();
    }

    let mut ready: BTreeSet<String> = indegree
        .iter()
        .filter(|(_, degree)| **degree == 0)
        .map(|(id, _)| id.clone())
        .collect();
    let mut depth: HashMap<String, usize> = active.keys().map(|id| (id.clone(), 0)).collect();
    let mut processed = HashSet::new();
    while let Some(id) = ready.iter().next().cloned() {
        ready.remove(&id);
        processed.insert(id.clone());
        let next_depth = depth.get(&id).copied().unwrap_or(0) + 1;
        for child in dependents.get(&id).into_iter().flatten() {
            depth
                .entry(child.clone())
                .and_modify(|value| *value = (*value).max(next_depth))
                .or_insert(next_depth);
            if let Some(degree) = indegree.get_mut(child) {
                *degree = degree.saturating_sub(1);
                if *degree == 0 {
                    ready.insert(child.clone());
                }
            }
        }
    }
    let cycle_depth = processed
        .iter()
        .filter_map(|id| depth.get(id))
        .copied()
        .max()
        .unwrap_or(0)
        + 1;
    for id in active.keys().filter(|id| !processed.contains(*id)) {
        depth.insert(id.clone(), cycle_depth);
    }

    let pressure_by_owner: HashMap<&str, &str> = assignments
        .iter()
        .filter_map(|assignment| {
            assignment
                .context_pressure
                .as_deref()
                .map(|pressure| (assignment.agent_id.as_str(), pressure))
        })
        .collect();
    let mut columns: BTreeMap<usize, Vec<CriticalPathNode>> = BTreeMap::new();
    for (item_id, item) in active {
        let mut waiting = HashSet::new();
        let mut stack = dependents.get(&item_id).cloned().unwrap_or_default();
        while let Some(child) = stack.pop() {
            // A cyclic component eventually walks back to its origin. The
            // origin is not a downstream lane waiting on itself, and skipping
            // it here also terminates that back-edge without inflating the
            // criticality count.
            if child == item_id {
                continue;
            }
            if waiting.insert(child.clone()) {
                stack.extend(dependents.get(&child).into_iter().flatten().cloned());
            }
        }
        let item_depth = depth.get(&item_id).copied().unwrap_or(0);
        let pressure = item
            .claim_owner_id
            .as_deref()
            .and_then(|owner| pressure_by_owner.get(owner).copied())
            .map(str::to_string);
        columns
            .entry(item_depth)
            .or_default()
            .push(CriticalPathNode {
                item_id,
                status: item.item_status.clone().unwrap_or_else(|| "unknown".into()),
                depth: item_depth,
                waiters: waiting.len(),
                holder: item.claim_owner.clone(),
                pressure,
                unclaimed: item.claim_owner_id.is_none(),
                cycle: !processed.contains(&item.item_id),
            });
    }
    let mut out: Vec<Vec<CriticalPathNode>> = columns.into_values().collect();
    for column in &mut out {
        column.sort_by(|a, b| {
            b.waiters
                .cmp(&a.waiters)
                .then(b.unclaimed.cmp(&a.unclaimed))
                .then(a.item_id.cmp(&b.item_id))
        });
    }
    out
}

/// P-028: a modal scheduling view whose horizontal axis is dependency depth,
/// never status. Each remaining node carries live holder/context pressure and
/// the number of transitive downstream lanes waiting on it.
fn draw_critical_path(f: &mut Frame, app: &App) {
    let area = centered_rect(94, 82, f.area());
    f.render_widget(Clear, area);
    let plan = app
        .critical_path_target
        .as_ref()
        .map(|(_, plan)| plan.as_str())
        .unwrap_or("plan");
    let block = Block::default()
        .borders(Borders::ALL)
        .title(format!(
            " Critical path · {plan} · dependency depth → · K/Esc close "
        ))
        .style(Theme::panel_active());
    let inner = block.inner(area);
    f.render_widget(block, area);

    let Some(states) = app.critical_path_states.as_ref().filter(|states| {
        app.critical_path_target
            .as_ref()
            .is_some_and(|(harness, plan)| states.harness == *harness && states.plan == *plan)
    }) else {
        f.render_widget(
            Paragraph::new("loading dependency graph…").style(Theme::dim()),
            inner,
        );
        return;
    };
    let columns = critical_path_columns(states, &app.fleet.all_assignments);
    if columns.is_empty() {
        f.render_widget(
            Paragraph::new("No non-terminal plan items — the remaining-work graph is clear.")
                .style(Theme::success()),
            inner,
        );
        return;
    }
    let constraints = vec![Constraint::Ratio(1, columns.len() as u32); columns.len()];
    let areas = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(constraints)
        .split(inner);
    for (column, area) in columns.iter().zip(areas.iter()) {
        let depth = column.first().map(|node| node.depth).unwrap_or(0);
        let rows: Vec<ListItem> = column
            .iter()
            .map(|node| {
                let marker = if node.cycle {
                    "⟳ CYCLE"
                } else if node.unclaimed {
                    "⚠ UNCLAIMED"
                } else {
                    "● CLAIMED"
                };
                let marker_style = if node.cycle {
                    Theme::danger()
                } else if node.unclaimed {
                    Theme::warn()
                } else {
                    Theme::success()
                };
                let holder = node.holder.as_deref().unwrap_or("—");
                let pressure = node.pressure.as_deref().unwrap_or("—");
                let pressure_style = match pressure {
                    "critical" => Theme::danger(),
                    "high" => Theme::warn(),
                    _ => Theme::dim(),
                };
                ListItem::new(Text::from(vec![
                    Line::from(Span::styled(marker, marker_style)),
                    Line::from(Span::styled(
                        format!("{} [{}]", node.item_id, node.status),
                        Theme::title_active(),
                    )),
                    Line::from(vec![
                        Span::styled("holder   ", Theme::dim()),
                        Span::raw(holder.to_string()),
                    ]),
                    Line::from(vec![
                        Span::styled("pressure ", Theme::dim()),
                        Span::styled(pressure.to_string(), pressure_style),
                    ]),
                    Line::from(vec![
                        Span::styled("waiting  ", Theme::dim()),
                        Span::raw(format!(
                            "{} lane{}",
                            node.waiters,
                            if node.waiters == 1 { "" } else { "s" }
                        )),
                    ]),
                    Line::from(""),
                ]))
            })
            .collect();
        f.render_widget(
            List::new(rows).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(format!(" depth {depth} ")),
            ),
            *area,
        );
    }
}

fn preview_item_labels(value: &serde_json::Value, key: &str) -> String {
    let Some(rows) = value.get(key).and_then(serde_json::Value::as_array) else {
        return "—".into();
    };
    let labels: Vec<String> = rows
        .iter()
        .take(4)
        .filter_map(|row| {
            row.get("id")
                .or_else(|| row.get("workItemId"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .collect();
    if labels.is_empty() {
        "—".into()
    } else if rows.len() > labels.len() {
        format!("{} +{}", labels.join(", "), rows.len() - labels.len())
    } else {
        labels.join(", ")
    }
}

/// P-034: the form is a direct view of `fleet:launch-on-plan` args plus the
/// read-only plan-scope preflight. Capacity uses the SAME remaining DAG columns
/// as the critical-path overlay, so the two surfaces cannot disagree on roots.
fn draw_fleet_launcher(f: &mut Frame, app: &App) {
    let Some(launcher) = &app.fleet_launcher else {
        return;
    };
    let area = centered_rect(82, 84, f.area());
    f.render_widget(Clear, area);
    let block = Theme::popup_block(Line::from(format!(
        " Fleet launcher · {} · L/Esc close ",
        trunc(&launcher.scope_label, 42)
    )));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let columns = app
        .plan_item_states
        .as_ref()
        .filter(|states| states.harness == launcher.harness && states.plan == launcher.plan)
        .map(|states| critical_path_columns(states, &app.fleet.all_assignments))
        .unwrap_or_default();
    let ready_width = columns
        .first()
        .map(|column| column.iter().filter(|node| node.unclaimed).count())
        .unwrap_or(0);
    let dag_depth = columns.len();
    let idle = launcher.count.saturating_sub(ready_width as u32);
    let marker = |field| {
        if launcher.field == field {
            if launcher.editing {
                "✎"
            } else {
                ">"
            }
        } else {
            " "
        }
    };
    let mut lines = vec![
        Line::from(vec![
            Span::styled("scope     ", Theme::dim()),
            Span::raw(launcher.scope_label.clone()),
        ]),
        Line::from(vec![
            Span::styled("plan      ", Theme::dim()),
            Span::raw(launcher.plan.clone()),
        ]),
        Line::from(format!(
            "{} name      {}",
            marker(FleetLauncherField::Name),
            launcher.name
        )),
        Line::from(format!(
            "{} count     {}",
            marker(FleetLauncherField::Count),
            launcher.count
        )),
        Line::from(format!(
            "{} agent     {}",
            marker(FleetLauncherField::Agent),
            launcher.agent
        )),
        Line::from(format!(
            "{} model     {}",
            marker(FleetLauncherField::Model),
            launcher.model
        )),
        Line::from(format!(
            "{} account   {}",
            marker(FleetLauncherField::Account),
            launcher.account
        )),
        Line::from(format!(
            "{} carry     {}",
            marker(FleetLauncherField::Carry),
            launcher.carry
        )),
        Line::from(format!(
            "{} headless  {}",
            marker(FleetLauncherField::Headless),
            if launcher.headless { "true" } else { "false" }
        )),
        Line::from(""),
        Line::from(vec![
            Span::styled("capacity   ", Theme::dim()),
            Span::raw(format!(
                "{ready_width} ready/unclaimed · DAG depth {dag_depth} · requested {}",
                launcher.count
            )),
        ]),
    ];
    if idle > 0 {
        lines.push(Line::from(Span::styled(
            format!(
                "⚠ {} agents against {} executable items, {} will idle · [s] use {}",
                launcher.count,
                ready_width,
                idle,
                ready_width.max(1)
            ),
            Theme::warn(),
        )));
    }
    lines.push(Line::from(""));
    if launcher.preview_loading {
        lines.push(Line::from(Span::styled(
            "preview     loading scheduler:preview_spec_delta…",
            Theme::dim(),
        )));
    } else if let Some(preview) = &launcher.preview {
        let counts = preview.get("counts").cloned().unwrap_or_default();
        lines.push(Line::from(format!(
            "preview     proposed {} · retained {} · +{} / -{}",
            counts
                .get("proposedClaimable")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
            counts
                .get("retained")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
            counts
                .get("newlyAdmitted")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
            counts
                .get("newlyExcluded")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        )));
        lines.push(Line::from(format!(
            "admits      {}",
            preview_item_labels(preview, "newlyAdmitted")
        )));
        lines.push(Line::from(format!(
            "excludes    {}",
            preview_item_labels(preview, "newlyExcluded")
        )));
        if preview
            .get("familyScopeIncomplete")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            lines.push(Line::from(Span::styled(
                "⚠ delta preview is issue-family-only; DAG capacity above covers every plan item",
                Theme::warn(),
            )));
        }
    } else {
        lines.push(Line::from(Span::styled(
            "preview     required before launch · [p] refresh",
            Theme::warn(),
        )));
    }
    if let Some(status) = &launcher.status {
        lines.push(Line::from(Span::styled(status.clone(), Theme::dim())));
    }
    lines.extend([
        Line::from(""),
        Line::from(Span::styled(
            "j/k field · Enter edit/cycle · ←/→ adjust · p preview · y CONFIRM LAUNCH",
            Theme::title_active(),
        )),
        Line::from(Span::styled(
            "Defaults are explicit: account=default · model=default · carry=warm · visible",
            Theme::dim(),
        )),
    ]);
    f.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .style(Theme::popup()),
        inner,
    );
}

/// One tab's body. The single dispatch shared by the full workbench layout and
/// the pinned single-pane dock modes (P-013 / D-011), so a pinned pane renders
/// exactly what the tab renders in the workbench — just full-screen.
fn draw_tab_body(f: &mut Frame, app: &App, tab: Tab, body: Rect) {
    match tab {
        Tab::Overview => draw_overview(f, app, body),
        Tab::Operator => draw_chat(f, app, body),
        Tab::Inbox => draw_inbox(f, app, body),
        Tab::Plans => draw_plans(f, app, body),
        // Fleet — the fleet view, which absorbed the old Sessions launcher (D-002b).
        Tab::Fleet => crate::fleet::draw_fleet(f, app, body),
        Tab::Sessions => draw_session_browser(f, app, body),
        Tab::Harnesses => draw_harnesses(f, app, body),
        Tab::Docs => draw_docs(f, app, body),
        Tab::Testing => draw_testing(f, app, body),
        // Configuration is the capability-complete parent for runtime config,
        // provider/plugin settings, and feature flags. The former Settings
        // shell is rendered as the lower subview, never as a top-level tab.
        Tab::Config => draw_configuration(f, app, body),
        Tab::Memory => draw_memory(f, app, body),
        // Cupboard owns discovery plus the Installed plugin inventory. The
        // existing list remains the primary pane and advertises the installed
        // capability in its title/detail contract.
        Tab::Cupboard => draw_cupboard(f, app, body),
        Tab::Voice => crate::voice_ui::draw_voice(f, &app.voice_ui, body),
        // Pane-only (EI-312): the pinned `pui wake-pane` staged-wake board.
        Tab::Wake => crate::wake_board::draw_wake_board(f, app, body),
        // Pane-only (dock 4-pane split): the pinned brief/mail/work boards.
        Tab::AgentCtx => crate::agent_ctx::draw_agent_ctx(f, app, body),
        // Pane-only Context: one server-normalized projection, never a local
        // reconstruction from plans/roster/work-items.
        Tab::PlansBoard => crate::plans_board::draw_plans_board(f, app, body),
        // Pane-only (hive-network-surface B-09): the pinned `pui network-pane`
        // cross-Hive board / `pui hive-pane <key>` dossier.
        // Network is a public destination now: Board and the former Hives /
        // Directory roster are visible together, while `network_focus` still
        // supports the pinned per-hive drill-in pane.
        Tab::Network => draw_network_destination(f, app, body),
    }
}

/// Public Network destination: keep the canonical board renderer and place the
/// verified Hives/Directory roster beside it. Both panes consume their existing
/// typed read models, so consolidation does not fork transport or classifiers.
fn draw_network_destination(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(58), Constraint::Percentage(42)])
        .split(area);
    crate::network::draw_network(f, app, cols[0]);
    crate::hives::draw_hives(f, app, cols[1]);
}

fn draw_session_browser(f: &mut Frame, app: &App, area: Rect) {
    let browser = &app.session_browser;
    let rows = app.visible_session_browser();
    let fleets = app.session_browser_fleets();
    let agents = app.session_browser_agents();
    let state = SESSION_BROWSER_STATES[browser.state_idx.min(SESSION_BROWSER_STATES.len() - 1)];
    let fleet = fleets
        .get(browser.fleet_idx.min(fleets.len().saturating_sub(1)))
        .map(String::as_str)
        .unwrap_or("any");
    let agent = agents
        .get(browser.agent_idx.min(agents.len().saturating_sub(1)))
        .map(String::as_str)
        .unwrap_or("any");
    let when = SESSION_BROWSER_WHEN[browser.when_idx.min(SESSION_BROWSER_WHEN.len() - 1)];
    let facet_style = |facet| {
        if browser.facet == facet {
            Theme::title_active()
        } else {
            Theme::dim()
        }
    };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Min(3),
            Constraint::Length(2),
        ])
        .split(area);
    let search = if let Some(rename) = &browser.rename {
        format!("  RENAME {}▏", rename.title)
    } else if let Some(target) = &browser.archive_confirm {
        format!("  ARCHIVE {}? y confirm · Esc cancel", target.label)
    } else if browser.search_open {
        format!("  /{}▏", browser.query)
    } else if browser.query.is_empty() {
        String::new()
    } else {
        format!("  /{}", browser.query)
    };
    let loading = if browser.loading {
        "  searching…"
    } else {
        ""
    };
    let controls = match app.selected_browser_session() {
        Some(row) if row.agent_chat_id.is_some() && row.session_harness.is_some() => {
            "e rename · d archive · K continue/fork"
        }
        Some(_) => "e/d/K unavailable: selected row is not agent-chat history",
        None => "e/d/K unavailable: no selected session",
    };
    let action_line = if browser.rename.is_some() {
        "Type a title · Enter save · Esc cancel".to_string()
    } else if browser.archive_confirm.is_some() {
        "Archive is reversible · y/Enter confirm · Esc cancel".to_string()
    } else if browser.mutation_key.is_some() {
        "Applying session action… draft and selection are safe".to_string()
    } else {
        format!(
            "Enter attach/resume · n New · N Advanced PSU · {controls} · ^t transcript · / search"
        )
    };
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                format!("STATE {state}"),
                facet_style(SessionBrowserFacet::State),
            ),
            Span::raw("   "),
            Span::styled(
                format!("FLEET {fleet}"),
                facet_style(SessionBrowserFacet::Fleet),
            ),
            Span::raw("   "),
            Span::styled(
                format!("AGENT {agent}"),
                facet_style(SessionBrowserFacet::Agent),
            ),
            Span::raw("   "),
            Span::styled(
                format!("WHEN {when}"),
                facet_style(SessionBrowserFacet::When),
            ),
            Span::styled(search, Theme::title_active()),
            Span::styled(loading, Theme::dim()),
        ])),
        chunks[0],
    );

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(58), Constraint::Percentage(42)])
        .split(chunks[1]);
    let items: Vec<ListItem> = rows
        .iter()
        .map(|row| {
            let state = App::session_browser_state(row);
            let marker = match state {
                "live" => "●",
                "parked" => "◑",
                "ended" | "recorded" => "○",
                _ => "·",
            };
            let agent = row.agent.as_deref().unwrap_or(&row.source);
            let lane = row
                .intent
                .as_deref()
                .or(row.current_plan_slug.as_deref())
                .unwrap_or("no lane");
            let when = row
                .transcript_at
                .as_deref()
                .or(row.heartbeat_at.as_deref())
                .and_then(|value| value.get(..10))
                .unwrap_or("—");
            let transcript = match row.transcript_availability {
                SessionTranscriptAvailability::Available => "TX AVAILABLE",
                SessionTranscriptAvailability::Unknown => "TX UNKNOWN",
                SessionTranscriptAvailability::Unavailable => "TX UNAVAILABLE",
            };
            ListItem::new(Line::from(vec![
                Span::raw(format!("{marker} ")),
                Span::styled(
                    format!("{:<16}", trunc(&row.label, 16)),
                    Theme::title_active(),
                ),
                Span::raw(format!(" {:<8} {:<8} ", state, trunc(agent, 8))),
                Span::styled(format!("{:<24}", trunc(lane, 24)), Theme::dim()),
                Span::styled(format!(" {when}"), Theme::dim()),
                Span::styled(format!("  {transcript}"), Theme::dim()),
            ]))
        })
        .collect();
    let mut list_state = ListState::default();
    if !rows.is_empty() {
        list_state.select(Some(browser.sel.min(rows.len() - 1)));
    }
    f.render_stateful_widget(
        List::new(items)
            .block(Block::default().borders(Borders::ALL).title(" sessions "))
            .highlight_style(Theme::selected())
            .highlight_symbol("> "),
        columns[0],
        &mut list_state,
    );

    let mut preview: Vec<Line> = Vec::new();
    if browser.transcript_loading {
        preview.push(Line::from(Span::styled(
            "loading transcript…",
            Theme::dim(),
        )));
    } else if let Some(error) = &browser.transcript_error {
        preview.push(Line::from(Span::styled(error.clone(), Theme::danger())));
    } else if !browser.transcript.is_empty() {
        let take = if browser.full_transcript {
            browser.transcript.len()
        } else {
            5
        };
        for turn in browser
            .transcript
            .iter()
            .skip(browser.transcript.len().saturating_sub(take))
        {
            preview.push(Line::from(vec![
                Span::styled(format!("{}  ", turn.speaker), Theme::title_active()),
                Span::raw(turn.text.clone()),
            ]));
        }
    } else if app.selected_browser_session().is_some_and(|row| {
        row.transcript_availability == SessionTranscriptAvailability::Unavailable
    }) {
        preview.push(Line::from(Span::styled(
            "Transcript unavailable (exact session lookup returned no indexed turns).",
            Theme::dim(),
        )));
    } else if let Some(excerpt) = app
        .selected_browser_session()
        .and_then(|row| row.transcript_excerpt.as_ref())
    {
        preview.push(Line::from(excerpt.clone()));
    } else {
        preview.push(Line::from(Span::styled(
            "No indexed transcript preview.",
            Theme::dim(),
        )));
    }
    let preview_title = if browser.full_transcript {
        " transcript tail · full "
    } else {
        " preview "
    };
    f.render_widget(
        Paragraph::new(preview)
            .wrap(Wrap { trim: false })
            .block(Block::default().borders(Borders::ALL).title(preview_title)),
        columns[1],
    );
    f.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                format!(
                    "{} sessions · {} shown · {} facet · h/l value · j/k move · ^k save crew",
                    browser.rows.len(),
                    rows.len(),
                    app.cycle_key()
                ),
                Theme::dim(),
            )),
            Line::from(Span::styled(action_line, Theme::dim())),
        ]),
        chunks[2],
    );
}

fn draw_tabs(f: &mut Frame, app: &App, area: Rect) {
    // The dock main pane confines the strip to its subset
    // (pui-dock-consolidation-2026-06-07); otherwise it's the full Tab::ALL.
    let visible = app.visible_tabs();
    let titles: Vec<Line> = visible
        .iter()
        .map(|t| {
            // The switch shortcut: digit (1-9, 0) for the first 10 tabs, a letter
            // for appended tabs — each tab owns its key via `Tab::switch_key`.
            let k = t.switch_key();
            // The DISPLAY label routes through the active Hive lexicon
            // (pui-hive-lexicon-2026-06-06) — Fleet→Swarm, Pots→Hives, Cupboard→
            // Comb, Operator→Queen when the-hive is on; today's labels otherwise.
            // `title()` (the stable identity) is unchanged for persistence/state.
            let label = t.label(&app.lexicon);
            // Inbox badge = the Decisions count (inbox-tiering D-006) — the only
            // tier that demands the user. Falls back to the unseen-notification
            // count when nothing is in the Decisions tier.
            if *t == Tab::Inbox {
                let decisions = app
                    .visible_inbox()
                    .iter()
                    .filter(|it| it.tier_rank() == 0)
                    .count();
                let badge = if decisions > 0 {
                    decisions
                } else {
                    app.unseen_notifs
                };
                if badge > 0 {
                    Line::from(format!(" {}:{} ({}) ", k, label, badge))
                } else {
                    Line::from(format!(" {}:{} ", k, label))
                }
            } else {
                Line::from(format!(" {}:{} ", k, label))
            }
        })
        .collect();
    // Selection index is the position within the VISIBLE list (which differs
    // from Tab::index() when a subset is active).
    let sel = visible.iter().position(|t| *t == app.tab).unwrap_or(0);
    let tabs = Tabs::new(titles)
        .style(Theme::tab_bar())
        .select(sel)
        .highlight_style(Theme::selected());
    f.render_widget(tabs, area);
}

fn draw_plans(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(22),
            Constraint::Percentage(26),
            Constraint::Percentage(52),
        ])
        .split(area);

    // Left column: the GOALS spine (P-032/D-010) — row 0 is the "(all)"
    // pseudo-row so unscoped browsing stays reachable.
    draw_goals_column(f, app, cols[0]);

    // The pot-scope-filtered list (D-003; goal-scoped per P-032) — `plan_sel`
    // indexes THIS list.
    let plans = app.visible_plans();
    let items: Vec<ListItem> = plans
        .iter()
        .map(|p| {
            // P-032: the plans column carries done/total item progress and the
            // working-agent badge (online roster members declaring this plan).
            let agents = app
                .roster
                .iter()
                .filter(|r| {
                    r.is_online() && r.current_plan_slug.as_deref() == Some(p.slug.as_str())
                })
                .count();
            let c = &p.item_counts;
            let mut spans = vec![
                Span::raw(format!("{:<9}", trunc(&p.status, 9))),
                Span::raw(trunc(&p.slug, 28)),
                Span::styled(format!(" {}/{}", c.done, c.total()), Theme::dim()),
            ];
            if agents > 0 {
                spans.push(Span::styled(format!(" ({agents})"), Theme::info()));
            }
            ListItem::new(Line::from(spans))
        })
        .collect();
    let mut state = ListState::default();
    if !plans.is_empty() {
        state.select(Some(app.plan_sel.min(plans.len() - 1)));
    }
    // Two-level pane nav (owner ask 2026-06-16): the focused pane wears the active
    // border + a cursor/inside tag; ←/→ (or ↑/↓ browsing) switch list ↔ items.
    let list_focused = app.plans_focus == crate::app::PlansFocus::List;
    let items_focused = app.plans_focus == crate::app::PlansFocus::Items;
    let body_area = block_with_header(
        f,
        cols[1],
        Theme::block(
            Line::from(format!(
                " {}Plans ({}) ",
                focus_cursor(list_focused, app.plans_entered),
                plans.len()
            )),
            list_focused,
        ),
        &format!("  {:<9}{}", "status", "slug"),
    );
    let list = List::new(items)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);

    // Right column: plan meta (top) + per-item assignment/claim/liveness (bottom, P-005a).
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(8), Constraint::Min(0)])
        .split(cols[2]);

    let detail = match app.selected_plan() {
        Some(p) => format!(
            "{}\n\nstatus:  {}\nharness: {}\nowner:   {}\nupdated: {}\nnext: {}",
            p.title,
            p.status,
            p.harness.clone().unwrap_or_default(),
            p.owner.clone().unwrap_or_default(),
            p.updated,
            p.next_action.clone().unwrap_or_default(),
        ),
        None => "No plans loaded.".to_string(),
    };
    let para = Paragraph::new(detail).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" Detail · L launch · K critical path "),
    );
    f.render_widget(para, right[0]);

    let item_cursor = items_focused.then_some(app.plan_items_sel);
    draw_plan_item_states(f, app, right[1], items_focused, item_cursor);
}

/// Per-item assignment/claim/liveness for the selected plan (P-005a). Renders only
/// when the loaded states belong to the SELECTED plan (a guard so a stale fetch from
/// a prior selection never paints the wrong plan). The block title carries the
/// harness's claim-liveness split (availability=LOCAL vs activity=SHARED); each row
/// is one item's disposition glyph + id + who's on it + the claim's liveness + intent.
fn draw_plan_item_states(
    f: &mut Frame,
    app: &App,
    area: Rect,
    focused: bool,
    cursor: Option<usize>,
) {
    let sel = app.selected_plan().map(|p| p.slug.as_str());
    let states = app
        .plan_item_states
        .as_ref()
        .filter(|s| Some(s.plan.as_str()) == sel);
    let mut item_count = 0usize;
    let (title, items): (String, Vec<ListItem>) = match states {
        Some(s) => {
            item_count = s.items.len();
            let mode = if s.harness_liveness_mode.is_empty() {
                "—"
            } else {
                s.harness_liveness_mode.as_str()
            };
            let rows = s
                .items
                .iter()
                .map(|it| ListItem::new(Line::from(plan_item_line(app, it))))
                .collect();
            // `:pickup` = convert-at-pickup (D-015) and `:release` its inverse
            // (P-005b write surface) — advertised here so both claim actions
            // are discoverable from the pane they act on.
            (
                format!(
                    " {}Items ({}) · liveness: {mode} · :pickup/:release <item> ",
                    focus_cursor(focused, app.plans_entered),
                    s.items.len()
                ),
                rows,
            )
        }
        None => (
            format!(" {}Items ", focus_cursor(focused, app.plans_entered)),
            Vec::new(),
        ),
    };
    let body_area = block_with_header(
        f,
        area,
        Theme::block(Line::from(title), focused),
        &format!(
            "{:<2}{:<8}{:<10}{:<15}{:<7}{:<6}{}",
            "", "item", "state", "who", "live", "press", "intent"
        ),
    );
    // The items here have NO header row in the list body (the column header is a
    // separate band), so the cursor maps directly to the item index.
    let mut state = ListState::default();
    if let Some(c) = cursor {
        if item_count > 0 {
            state.select(Some(c.min(item_count - 1)));
        }
    }
    let list = List::new(items)
        .highlight_style(Theme::selected())
        .highlight_symbol("▸ ");
    f.render_stateful_widget(list, body_area, &mut state);
}

/// The GOALS column of the Plans-tab spine (P-032/D-010). Row 0 is the
/// "(all)" pseudo-row so unscoped browsing stays reachable; each goal row
/// carries its status, title, and the scoped plan count + rolled-up done/total
/// across the plans of its pots — computed over the plans ALREADY loaded (the
/// same pot-scoped list the plans column renders from), never re-fetched.
fn draw_goals_column(f: &mut Frame, app: &App, area: Rect) {
    let goals_focused = app.plans_focus == crate::app::PlansFocus::Goals;
    let all_plans = app.scope_visible_plans();
    let mut rows: Vec<ListItem> = Vec::with_capacity(app.goals.len() + 1);
    rows.push(ListItem::new(Line::from(vec![
        Span::raw(format!("{:<9}", "(all)")),
        Span::styled(format!("{} plans", all_plans.len()), Theme::dim()),
    ])));
    for g in &app.goals {
        let scoped: Vec<_> = all_plans
            .iter()
            .filter(|p| {
                p.harness
                    .as_deref()
                    .is_some_and(|h| g.pots.iter().any(|c| c.harness_slug == h))
            })
            .collect();
        let (done, total) = scoped.iter().fold((0u32, 0u32), |(d, t), p| {
            (d + p.item_counts.done, t + p.item_counts.total())
        });
        let status = g.shown_status();
        let status_style = match status {
            "active" | "achieved" => Theme::success(),
            "dormant" | "killed" | "paused" | "lost" => Theme::warn(),
            _ => Theme::dim(),
        };
        rows.push(ListItem::new(Line::from(vec![
            Span::styled(format!("{:<9}", trunc(status, 9)), status_style),
            Span::raw(trunc(&g.title, 24)),
            Span::styled(
                format!(" {}p {}/{}", scoped.len(), done, total),
                Theme::dim(),
            ),
        ])));
    }
    let body_area = block_with_header(
        f,
        area,
        Theme::block(
            Line::from(format!(
                " {}Goals ({}) ",
                focus_cursor(goals_focused, app.plans_entered),
                app.goals.len()
            )),
            goals_focused,
        ),
        &format!("  {:<9}{}", "status", "goal"),
    );
    let mut state = ListState::default();
    state.select(Some(app.goal_sel.min(app.goals.len())));
    let list = List::new(rows)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);
}

/// The Plans-tab goal-detail popup body (P-032): declared vs effective status,
/// the holder verdict, pot chips, and the open/needs-you/spend counters. The
/// pot list is a bounded sample — the overflow line keeps `potCount` honest
/// (never render `pots.len()` as the pot total).
fn goal_detail_lines(g: &crate::models::GoalSummary) -> Vec<Line<'static>> {
    let mut lines = vec![
        Line::from(Span::styled(g.title.clone(), Theme::title())),
        Line::from(vec![
            Span::styled("status:  ", Theme::dim()),
            Span::raw(g.shown_status().to_string()),
            Span::styled("   holder: ", Theme::dim()),
            Span::raw(g.holder_liveness.clone()),
        ]),
        Line::from(vec![
            Span::styled(format!("pots ({}): ", g.pot_count), Theme::dim()),
            Span::raw(
                g.pots
                    .iter()
                    .map(|c| c.harness_slug.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
            ),
        ]),
        Line::from(vec![
            Span::styled("open items: ", Theme::dim()),
            Span::raw(g.open_work_items.to_string()),
            Span::styled("   needs you: ", Theme::dim()),
            Span::raw(g.needs_human.to_string()),
            Span::styled("   spend: ", Theme::dim()),
            Span::raw(format!("${:.2}", g.spend_usd)),
        ]),
    ];
    let sampled = g.pots.len();
    if (g.pot_count as usize) > sampled {
        lines.push(Line::from(Span::styled(
            format!(
                "(+{} more pots not sampled)",
                g.pot_count as usize - sampled
            ),
            Theme::dim(),
        )));
    }
    lines
}

/// Focus-cursor prefix for pane titles (`▸ ` on the focused pane, empty
/// otherwise). Single source for the cursor glyph (Brief 27 vocabulary).
/// The marker prefixed to a column's title. Empty when the column is not
/// focused; the cursor glyph when it's focused-but-browsing; the cursor plus an
/// "inside" tag once you've drilled in (two-level nav, owner ask 2026-06-15 #2),
/// so browsing vs inside reads at a glance.
fn focus_cursor(focused: bool, entered: bool) -> String {
    if !focused {
        String::new()
    } else if entered {
        format!("{} inside · ", crate::glyph::nav::CURSOR)
    } else {
        format!("{} ", crate::glyph::nav::CURSOR)
    }
}

/// One plan-item row: `<glyph> <id> <disposition> <who> <liveness> <intent>` (P-005a).
/// `who` is the live-claim holder's agent-name, falling back to the durable assignee.
/// Glyphs ride the shared vocabulary (cross-category reuse per its D-004:
/// liveness fill = activity, `◆` = demands routing, `▲` = warn).
fn plan_item_line(app: &App, it: &crate::models::PlanItemState) -> String {
    use crate::glyph::{liveness, severity, status};
    let (glyph, label) = match it.disposition.as_str() {
        "active" => (liveness::LIVE, "active"),
        "assigned-idle" => (liveness::IDLE, "assigned"),
        "claimed-pooled" => (status::NEEDS_HUMAN, "claimed"),
        "claimed-mismatch" => (severity::WARN, "MISMATCH"),
        "pooled" => (severity::INFO, "pooled"),
        other => ("?", other),
    };
    let who = it
        .claim_owner_name
        .as_deref()
        .or(it.assignee_name.as_deref())
        .unwrap_or("");
    let live = match it.claim_liveness_mode.as_deref() {
        Some("availability") => "avail",
        Some("activity") => "activ",
        _ => "",
    };
    let intent = it.claim_intent.as_deref().unwrap_or("");
    // P-032: the holder's context-pressure bucket, joined from the fleet
    // assignments surface via the stable claim-owner id. Absent (no live claim,
    // or no assignment row) renders as "—" — never fabricated.
    let pressure = it
        .claim_owner_id
        .as_deref()
        .and_then(|owner| {
            app.fleet
                .all_assignments
                .iter()
                .find(|a| a.agent_id == owner)
        })
        .and_then(|a| a.context_pressure.as_deref())
        .filter(|b| !b.trim().is_empty())
        .unwrap_or("—");
    format!(
        "{glyph} {:<7} {:<9} {:<14} {:<6} {:<5} {}",
        trunc(&it.item_id, 7),
        label,
        trunc(who, 14),
        live,
        pressure,
        trunc(intent, 40),
    )
}

/// P7 presence sidebar: a glanceable, always-visible list of who's online and
/// what they're doing, rendered from the coord_presence-primary roster. No
/// selection — it's a HUD, not a navigable list; the Sessions tab is the detail.
fn draw_presence(f: &mut Frame, app: &App, area: Rect) {
    // "Who's online" — only non-stale presence (the roster carries the whole
    // fleet incl. long-dead heartbeats; those would drown the live ones). The
    // title still shows online/total so the offline tail is visible at a glance.
    let online: Vec<&crate::models::RosterEntry> = app.roster.iter().filter(|r| !r.stale).collect();
    let items: Vec<ListItem> = online
        .iter()
        .map(|r| {
            let dot = crate::glyph::liveness_dot(r.stale, &r.liveness);
            let who = r.agent.clone().unwrap_or_else(|| r.label.clone());
            // Prefer live intent; fall back to feature, then role.
            let detail = r
                .intent
                .clone()
                .filter(|s| !s.is_empty())
                .or_else(|| r.feature.clone().filter(|s| !s.is_empty()))
                .or_else(|| r.role.clone().filter(|s| !s.is_empty()))
                .unwrap_or_default();
            ListItem::new(Line::from(vec![
                Span::raw(format!("{dot} {:<10} ", trunc(&who, 10))),
                Span::styled(trunc(&detail, 14), Theme::dim()),
            ]))
        })
        .collect();
    let body = if items.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "(nobody online)",
            Theme::dim(),
        )))]
    } else {
        items
    };
    let list = List::new(body).block(Block::default().borders(Borders::ALL).title(Line::from(
        format!(" Presence {}/{} ", online.len(), app.roster.len()),
    )));
    f.render_widget(list, area);
}

/// D-009: the collapsible plans-filter rail (Inbox + Fleet). Lists the
/// pot-scoped plans with a checkbox glyph per slug; while the rail is open,
/// j/k move its cursor, Space/Enter toggles the plan in/out of the filter,
/// `c` clears it, and F/Esc closes the rail (the filter keeps applying when
/// hidden — the list titles carry a badge so it's never invisible).
fn draw_plan_filter(f: &mut Frame, app: &App, area: Rect) {
    let plans = app.visible_plans();
    let items: Vec<ListItem> = plans
        .iter()
        .map(|p| {
            let mark = if app.plan_filter.contains(&p.slug) {
                "[x]"
            } else {
                "[ ]"
            };
            ListItem::new(Line::from(format!("{mark} {}", trunc(&p.slug, 25))))
        })
        .collect();
    let mut state = ListState::default();
    if !plans.is_empty() {
        state.select(Some(app.plan_filter_sel.min(plans.len() - 1)));
    }
    let body_area = block_with_header(
        f,
        area,
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(format!(
                " Filter: plans ({} on) ",
                app.plan_filter.len()
            ))),
        "  ␣ toggle · c clear · F close",
    );
    if items.is_empty() {
        f.render_widget(
            Paragraph::new(Span::styled("(no plans loaded)", Theme::dim())),
            body_area,
        );
        return;
    }
    let list = List::new(items)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);
}

/// Two-tier plan→item lines for a structured `<report>` block — the ONE TUI
/// renderer for report payloads. Lifted verbatim from the old draw_chat
/// rendering; its mount point is now the Inbox detail (an operator report is
/// inbox content, not chat content — report-cards-inbox-reconciliation
/// D-001/D-002). Width-aware; status glyphs ride the shared
/// `Theme::status_marker` vocabulary.
fn report_block_lines(rep: &crate::chat_tags::Report, inner_w: usize) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    if let Some(t) = &rep.title {
        lines.push(Line::from(Span::styled(
            format!("  {} {t}", crate::glyph::nav::EXPANDED),
            Theme::header(),
        )));
    }
    for p in &rep.plans {
        let mut head = vec![
            Span::raw("  "),
            Theme::status_marker(p.status.as_deref().unwrap_or("")),
            Span::raw(" "),
            Span::styled(p.title.clone(), Theme::selected()),
        ];
        if let Some(st) = &p.status {
            head.push(Span::styled(format!("  {st}"), Theme::dim()));
        }
        lines.push(Line::from(head));
        if let Some(sum) = &p.summary {
            for wl in wrap_text(sum, inner_w.saturating_sub(6).max(8)) {
                lines.push(Line::from(Span::styled(
                    format!("      {wl}"),
                    Theme::dim(),
                )));
            }
        }
        for it in &p.items {
            let id_prefix = it
                .id
                .as_deref()
                .map(|i| format!("{i} "))
                .unwrap_or_default();
            let wrapped = wrap_text(&it.text, inner_w.saturating_sub(8).max(8));
            for (li, wl) in wrapped.iter().enumerate() {
                let mut row = vec![Span::raw("    ")];
                if li == 0 {
                    row.push(Theme::status_marker(it.status.as_deref().unwrap_or("")));
                    row.push(Span::raw(" "));
                    if !id_prefix.is_empty() {
                        row.push(Span::styled(id_prefix.clone(), Theme::dim()));
                    }
                } else {
                    row.push(Span::raw("  ")); // align continuation under the text
                }
                row.push(Span::raw(wl.clone()));
                lines.push(Line::from(row));
            }
        }
    }
    lines
}

fn draw_inbox(f: &mut Frame, app: &App, area: Rect) {
    // Three facets, `Tab` cycles: Needs you, all Attention, and the absorbed
    // Convos thread browser. Without this dispatch the conversations that
    // `tab_entry_side_effect` fetches on entering Inbox were never drawn, so
    // the whole absorbed capability was unreachable — the absorption was
    // title-only.
    if app.inbox_focus == InboxFocus::Threads {
        draw_conversations(f, app, area);
        return;
    }
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(48), Constraint::Percentage(52)])
        .split(area);

    // The pot-scope-filtered inbox (D-003) — `inbox_sel` indexes THIS list.
    // `visible_inbox` applies the Needs-you predicate when that facet is active.
    // Items are rendered in four tier SECTIONS (inbox-tiering D-006): Decisions ▸
    // Handled ▸ Alerts ▸ Activity. Each tier gets a header row + its items; the
    // selected item (by id) is highlighted at its display position so selection
    // survives the regrouping regardless of the underlying list order.
    let inbox = app.visible_inbox();
    let mut counts = [0usize; 4];
    for it in &inbox {
        counts[it.tier_rank() as usize] += 1;
    }
    let sel_id = app.selected_inbox().map(|it| it.id.clone());
    let mut list_items: Vec<ListItem> = Vec::new();
    let mut sel_display: Option<usize> = None;
    for tier in INBOX_TIERS {
        let tier_items: Vec<&&crate::models::AttentionItem> =
            inbox.iter().filter(|it| it.tier_str() == tier).collect();
        if tier_items.is_empty() {
            continue;
        }
        list_items.push(ListItem::new(Line::from(Span::styled(
            format!(
                "{} {} ({})",
                tier_glyph(tier),
                tier_label(tier),
                tier_items.len()
            ),
            Theme::header(),
        ))));
        for it in tier_items {
            if sel_id.as_deref() == Some(it.id.as_str()) {
                sel_display = Some(list_items.len());
            }
            let loc = it
                .plan_slug
                .clone()
                .or_else(|| it.harness_slug.clone())
                .unwrap_or_default();
            let r = it.item_ref.clone().unwrap_or_default();
            list_items.push(ListItem::new(Line::from(format!(
                "  {} {:<10} {:<22} {}",
                tier_glyph(tier),
                trunc(&it.status, 10),
                trunc(&format!("{loc}/{r}"), 22),
                trunc(&it.title, 32),
            ))));
        }
    }
    let mut state = ListState::default();
    state.select(sel_display);
    // Title headlines the Decisions count (the only tier that demands the user);
    // the full per-tier counts live in the section headers below. The plans-
    // filter badge (D-009) stays visible. Kept compact so it never truncates the
    // badge in a narrowed (rail-open) pane.
    // Attention and Threads are one destination. Conversations retain their
    // full detail renderer below, but the parent title makes the replacement
    // path visible even when the thread list is empty or still loading.
    // Put the active-filter badge immediately after the stable destination
    // name.  The rail can leave the Inbox pane as narrow as 38 columns; a
    // trailing badge would be clipped behind the longer Attention + Threads
    // title and make an active filter invisible exactly when it is in use.
    let filter_badge = if app.plan_filter.is_empty() {
        String::new()
    } else {
        format!("F:plans({}) · ", app.plan_filter.len())
    };
    // Name the sub-view actually on screen and advertise the key that reaches
    // the other one — the thread list is only discoverable if this says so.
    let (facet, next) = match app.inbox_focus {
        InboxFocus::NeedsYou => ("Needs you", "All"),
        InboxFocus::Attention => ("All", "Threads"),
        InboxFocus::Threads => unreachable!("threads returned above"),
    };
    let title = format!(
        " Inbox · {filter_badge}{facet} ({}) · [Tab] {next} · Threads {} ",
        inbox.len(),
        app.visible_conversations().len(),
    );
    let body_area = block_with_header(
        f,
        cols[0],
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(title)),
        &format!(
            "  a/Enter answer or ack · {} Decisions · {} Handled · {} Alerts · {} Activity",
            crate::glyph::status::NEEDS_HUMAN,
            crate::glyph::status::DONE,
            crate::glyph::severity::ALERT,
            crate::glyph::severity::INFO,
        ),
    );
    let list = List::new(list_items)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);

    let preview: Vec<Line<'static>> = match app.selected_inbox() {
        Some(it) => {
            let owner = it
                .owner_label
                .clone()
                .or_else(|| it.owner_agent_id.clone())
                .unwrap_or_else(|| "—".to_string());
            let triage = match (it.triage_state.as_deref(), it.triage_note.as_deref()) {
                (Some(s), Some(n)) if s != "untriaged" => format!("\ntriage: {s} — {n}"),
                (Some(s), None) if s != "untriaged" => format!("\ntriage: {s}"),
                _ => String::new(),
            };
            // An operator-report item renders its payload as the styled
            // two-tier block (the one report renderer) instead of the plain
            // body text (which duplicates it for text-only surfaces).
            let body = if it.report.is_some() {
                String::new()
            } else {
                it.body.clone().unwrap_or_default()
            };
            let head = format!(
                "{}\n\ntier:   {} ({})\nkind:   {}\nstatus: {}\nplan:   {}\nref:    {}\nowner:  {}\nneedsHuman: {}{}\n\n{}",
                it.title,
                tier_label(it.tier_str()),
                it.tier_str(),
                it.kind,
                it.status,
                it.plan_slug.clone().unwrap_or_default(),
                it.item_ref.clone().unwrap_or_default(),
                owner,
                it.needs_human,
                triage,
                body,
            );
            let mut lines: Vec<Line<'static>> = head
                .split('\n')
                .map(|l| Line::from(l.to_string()))
                .collect();
            if let Some(rep) = &it.report {
                let inner_w = cols[1].width.saturating_sub(2) as usize;
                lines.extend(report_block_lines(rep, inner_w));
            }
            lines.push(Line::from(String::new()));
            if !it.actions.is_empty() {
                lines.push(Line::from(format!(
                    "actions: {}",
                    it.actions
                        .iter()
                        .map(|action| action.label.as_str())
                        .collect::<Vec<_>>()
                        .join(" · ")
                )));
            }
            lines.push(Line::from(
                "[a/Enter] answer or acknowledge · [m] message owner".to_string(),
            ));
            lines.push(Line::from(":resolve <note>  triage-resolve".to_string()));
            lines
        }
        None => vec![Line::from(format!(
            "Inbox facet empty — nothing needs attention here. Threads: {} (Tab to cycle).",
            app.visible_conversations().len()
        ))],
    };
    let para = Paragraph::new(preview)
        .wrap(Wrap { trim: false })
        .block(Block::default().borders(Borders::ALL).title(" Preview "));
    f.render_widget(para, cols[1]);
}

fn draw_inbox_answer(f: &mut Frame, app: &App) {
    let Some(answer) = app.inbox_answer.as_ref() else {
        return;
    };
    let full = f.area();
    let width = (full.width as u32 * 72 / 100).clamp(42, 96) as u16;
    let height = 8.min(full.height);
    let area = Rect {
        x: full.x + full.width.saturating_sub(width) / 2,
        y: full.y + full.height.saturating_sub(height) / 2,
        width: width.max(1),
        height,
    };
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(answer.target.title.clone(), Theme::header())),
            Line::from(""),
            Line::from(vec![
                Span::styled("answer: ", Theme::title_active()),
                Span::styled(answer.input.clone(), Theme::input()),
                Span::styled("▌", Theme::dim()),
            ]),
            Line::from(""),
            Line::from(Span::styled(
                "Enter send through the owning verb · Esc cancel",
                Theme::dim(),
            )),
        ])
        .wrap(Wrap { trim: false })
        .style(Theme::popup())
        .block(Theme::popup_block(Line::from(" Needs you · answer "))),
        area,
    );
}

/// Conversations tab (Brief 25) — the coord conversations browse surface. List
/// (left) of questions/discussions under the active state/kind/topic filter +
/// detail (right): the seed, topics, the thread, the accepted answer, the
/// linked work-item, and the promote hint. Mirrors `draw_inbox`'s split.
fn draw_conversations(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(40), Constraint::Percentage(60)])
        .split(area);

    let convs = app.visible_conversations();
    let topic_badge = app
        .conv_topic
        .as_ref()
        .map(|t| format!(" T:#{t}"))
        .unwrap_or_default();
    let title = if app.conversations_loading {
        " Conversations (loading…) ".to_string()
    } else {
        format!(
            " Inbox · Threads ({}) · [Tab] Attention · S:{} t:{}{} ",
            convs.len(),
            app.conv_state(),
            app.conv_kind(),
            topic_badge,
        )
    };
    let body_area = block_with_header(
        f,
        cols[0],
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(title)),
        "  k  state    title / topics",
    );
    let title_width = body_area.width.saturating_sub(21) as usize;
    let items: Vec<ListItem> = if convs.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "(no conversations)",
            Theme::dim(),
        )))]
    } else {
        convs
            .iter()
            .map(|c| {
                let (kind, kind_style) = match c.kind.as_str() {
                    "question" => ("Q", Theme::warn()),
                    "discussion" => ("D", Theme::info()),
                    _ => ("·", Theme::dim()),
                };
                let title = c.title.clone().unwrap_or_else(|| c.id.clone());
                let tags = if c.topics.is_empty() {
                    String::new()
                } else {
                    format!(
                        " {}",
                        c.topics
                            .iter()
                            .map(|t| format!("#{t}"))
                            .collect::<Vec<_>>()
                            .join(" ")
                    )
                };
                let promoted = if c.promoted_issue_id.is_some() {
                    " issue"
                } else {
                    ""
                };
                ListItem::new(Line::from(vec![
                    Span::styled(format!("{kind} "), kind_style),
                    Span::styled(format!("{:<8} ", trunc(&c.state, 8)), Theme::dim()),
                    Span::raw(trunc(&title, title_width.max(12))),
                    Span::styled(trunc(&tags, 22), Theme::dim()),
                    Span::styled(promoted, Theme::info()),
                ]))
            })
            .collect()
    };
    let mut state = ListState::default();
    if !convs.is_empty() {
        state.select(Some(app.conversation_sel.min(convs.len() - 1)));
    }
    let list = List::new(items)
        .style(Theme::panel())
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);

    // Detail: the loaded ConvDetail if it matches the selected row, else a
    // summary placeholder prompting Enter to load the thread.
    let selected = app.selected_conversation();
    let detail_matches = matches!(
        (&app.conversation_detail, selected),
        (Some(d), Some(sel)) if d.conversation.as_ref().map(|c| c.id.as_str()) == Some(sel.id.as_str())
    );
    let preview: Vec<Line<'static>> =
        if let (true, Some(d)) = (detail_matches, app.conversation_detail.as_ref()) {
            let c = d.conversation.as_ref();
            let title = c
                .and_then(|c| c.title.clone())
                .unwrap_or_else(|| selected.map(|s| s.id.clone()).unwrap_or_default());
            let kind = c.map(|c| c.kind.as_str()).unwrap_or("");
            let st = c.map(|c| c.state.as_str()).unwrap_or("");
            let asker = c.map(|c| c.asker_id.as_str()).unwrap_or("");
            let scope = c.map(|c| c.scope.as_str()).unwrap_or("");
            let harness = c.and_then(|c| c.harness_slug.clone()).unwrap_or_default();
            let topics = if d.topics.is_empty() {
                "—".to_string()
            } else {
                d.topics
                    .iter()
                    .map(|t| format!("#{t}"))
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            let scope_label = if scope == "harness" && !harness.is_empty() {
                format!(" · {harness}")
            } else {
                String::new()
            };
            let mut lines = vec![
                Line::from(Span::styled(title, Theme::title_active())),
                Line::from(vec![
                    Span::styled(format!("{kind} "), Theme::dim()),
                    Span::raw(st.to_string()),
                    Span::styled(
                        format!(" · {} follower(s){scope_label}", d.subscriber_count),
                        Theme::dim(),
                    ),
                    Span::styled(" · asked by ", Theme::dim()),
                    Span::raw(asker.to_string()),
                ]),
                Line::from(vec![
                    Span::styled("topics ", Theme::dim()),
                    Span::raw(topics),
                ]),
            ];
            if let Some(body) = c.map(|c| c.body.as_str()).filter(|b| !b.is_empty()) {
                lines.push(Line::from(""));
                for l in body.lines() {
                    lines.push(Line::from(l.to_string()));
                }
            }
            if let Some(ans) = c.and_then(|c| c.accepted_answer.clone()) {
                lines.push(Line::from(""));
                lines.push(Line::from(vec![
                    Span::styled(crate::glyph::status::DONE.to_string(), Theme::info()),
                    Span::styled(" accepted ", Theme::info()),
                    Span::raw(ans),
                ]));
            }
            if let Some(issue) = c.and_then(|c| c.promoted_issue_id.clone()) {
                lines.push(Line::from(""));
                lines.push(Line::from(vec![
                    Span::styled("linked work-item ", Theme::dim()),
                    Span::styled(issue, Theme::info()),
                    Span::styled(" (promoted; discussion continues there)", Theme::dim()),
                ]));
            } else if c.map(|c| c.state.as_str()) != Some("closed") {
                lines.push(Line::from(""));
                lines.push(Line::from(vec![
                    Span::styled("[i] ", Theme::title_active()),
                    Span::raw("promote to an issue"),
                ]));
            }
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                format!("thread ({})", d.posts.len()),
                Theme::header(),
            )));
            if d.posts.is_empty() {
                lines.push(Line::from(Span::styled("(no replies yet)", Theme::dim())));
            } else {
                for p in &d.posts {
                    let who = p.author_id.clone().unwrap_or_else(|| "unknown".to_string());
                    lines.push(Line::from(""));
                    lines.push(Line::from(Span::styled(who, Theme::dim())));
                    for l in p.body.lines() {
                        lines.push(Line::from(l.to_string()));
                    }
                }
            }
            lines
        } else if let Some(sel) = selected {
            let title = sel.title.clone().unwrap_or_else(|| sel.id.clone());
            let topics = if sel.topics.is_empty() {
                "—".to_string()
            } else {
                sel.topics
                    .iter()
                    .map(|t| format!("#{t}"))
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            vec![
                Line::from(Span::styled(title, Theme::title_active())),
                Line::from(vec![
                    Span::raw(sel.kind.clone()),
                    Span::styled(" · ", Theme::dim()),
                    Span::raw(sel.state.clone()),
                    Span::styled(" · asked by ", Theme::dim()),
                    Span::raw(sel.asker_id.clone()),
                ]),
                Line::from(vec![
                    Span::styled("topics ", Theme::dim()),
                    Span::raw(topics),
                ]),
                Line::from(""),
                Line::from(vec![
                    Span::styled("[Enter] ", Theme::title_active()),
                    Span::raw("load the thread + accepted answer"),
                ]),
            ]
        } else if app.conversations_loading {
            vec![Line::from(Span::styled(
                "Loading conversations…",
                Theme::dim(),
            ))]
        } else {
            vec![
                Line::from(Span::styled(
                    "No conversations under this filter.",
                    Theme::dim(),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "s: state · t: kind · T: topic · r: refresh",
                    Theme::dim(),
                )),
            ]
        };
    let para = Paragraph::new(Text::from(preview))
        .style(Theme::panel())
        .wrap(Wrap { trim: false })
        .block(Block::default().borders(Borders::ALL).title(" Detail "));
    f.render_widget(para, cols[1]);
}

fn draw_harnesses(f: &mut Frame, app: &App, area: Rect) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(8)])
        .split(area);
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(55), Constraint::Percentage(45)])
        .split(rows[0]);

    let feat_focused = app.harness_focus == HarnessFocus::Features;
    let focus_hl = |on: bool| if on { Theme::selected() } else { Theme::dim() };

    // Features (left).
    let fitems: Vec<ListItem> = app
        .features
        .iter()
        .map(|ft| {
            ListItem::new(Line::from(format!(
                "{:<10} {:<8} {}",
                trunc(&ft.id, 10),
                trunc(&ft.status, 8),
                trunc(&ft.title, 28),
            )))
        })
        .collect();
    let mut fstate = ListState::default();
    if !app.features.is_empty() {
        fstate.select(Some(app.feat_sel));
    }
    let fbody = block_with_header(
        f,
        cols[0],
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(format!(
                " {}{} ({}/{}) [/] · features ({}) ",
                focus_cursor(feat_focused, app.pane_entered),
                app.harness,
                app.harness_sel + 1,
                app.harnesses.len().max(1),
                app.features.len()
            ))),
        &format!("  {:<11}{:<9}{}", "id", "status", "title"),
    );
    let flist = List::new(fitems)
        .highlight_style(focus_hl(feat_focused))
        .highlight_symbol("> ");
    f.render_stateful_widget(flist, fbody, &mut fstate);

    // Issues (right) — selectable when focused (Tab toggles focus).
    let ititle = Line::from(format!(
        " {}issues ({}) ",
        focus_cursor(!feat_focused, app.pane_entered),
        app.issues.len()
    ));
    if app.issues.is_empty() {
        f.render_widget(
            Paragraph::new("(no open issues)")
                .block(Block::default().borders(Borders::ALL).title(ititle)),
            cols[1],
        );
    } else {
        let iitems: Vec<ListItem> = app
            .issues
            .iter()
            .map(|is| {
                let fix = is.linked_feature_id.clone().unwrap_or_default();
                ListItem::new(Line::from(format!(
                    "{:<8} {:<11} {} {}",
                    trunc(&is.severity, 8),
                    trunc(&is.status, 11),
                    trunc(&is.title, 22),
                    if fix.is_empty() {
                        String::new()
                    } else {
                        format!("→{fix}")
                    },
                )))
            })
            .collect();
        let mut istate = ListState::default();
        istate.select(Some(app.issue_sel));
        let ibody = block_with_header(
            f,
            cols[1],
            Block::default().borders(Borders::ALL).title(ititle),
            &format!("  {:<9}{:<12}{}", "severity", "status", "title"),
        );
        let ilist = List::new(iitems)
            .highlight_style(focus_hl(!feat_focused))
            .highlight_symbol("> ");
        f.render_stateful_widget(ilist, ibody, &mut istate);
    }

    // Detail (bottom) — follows the focused column.
    let (dtitle, detail) = if feat_focused {
        (
            " feature ",
            match app.selected_feature() {
                Some(ft) => format!(
                    "{}\n\nid: {}    status: {}    attempts: {}",
                    ft.title, ft.id, ft.status, ft.attempts
                ),
                None => "No features.".to_string(),
            },
        )
    } else {
        (
            " issue ",
            match app.selected_issue() {
                Some(is) => format!(
                    "{}\n\nid: {}    severity: {}    status: {}\nsource: {}    foundDuring: {}    →fix: {}    attempts: {}",
                    is.title,
                    is.id,
                    is.severity,
                    is.status,
                    is.source,
                    is.found_during.clone().unwrap_or_default(),
                    is.linked_feature_id.clone().unwrap_or_default(),
                    is.attempts,
                ),
                None => "No issues.".to_string(),
            },
        )
    };
    f.render_widget(
        Paragraph::new(detail)
            .wrap(Wrap { trim: false })
            .block(Block::default().borders(Borders::ALL).title(dtitle)),
        rows[1],
    );
}

/// Source tag + style for a doc badge (harness-docs-integration P-009).
fn doc_source_tag(source: &str) -> (&'static str, Style) {
    match source {
        "generated" => ("G ", Theme::info()),
        "augmented" => ("A ", Theme::notify()),
        _ => ("M ", Theme::dim()),
    }
}
/// Freshness marker + style: ⚠ stale/review · ○ not-drift-tracked · blank fresh.
fn doc_status_marker(status: &str) -> (&'static str, Style) {
    match status {
        "stale" | "review" => ("⚠ ", Theme::warn()),
        "untracked" => ("○ ", Theme::dim()),
        "unknown" => ("? ", Theme::dim()),
        _ => ("  ", Theme::dim()),
    }
}

fn draw_docs(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(34), Constraint::Percentage(66)])
        .split(area);

    // Merged model (P-009): each row carries a source tag (G/M/A) + a freshness
    // marker (⚠ / ○), so generated vs human and stale vs fresh are visible at a glance.
    // Width-aware path presentation (EI-21646357450104414): the path budget
    // follows the pane instead of a fixed 26 columns, and an over-long path
    // elides from the LEFT so the filename — the part that identifies a doc —
    // always survives. The subtracted overhead is the two borders, the
    // highlight symbol, the freshness marker and the source tag.
    let visible: Vec<&String> = app.visible_docs();
    let path_budget = (cols[0].width as usize).saturating_sub(9).max(12);
    let items: Vec<ListItem> = visible
        .iter()
        .map(|p| {
            let entry = app.doc_entries.iter().find(|e| &e.doc_id == *p);
            let (src_tag, src_style) =
                doc_source_tag(entry.map(|e| e.source.as_str()).unwrap_or("manual"));
            let (mark, mark_style) =
                doc_status_marker(entry.map(|e| e.status.as_str()).unwrap_or("untracked"));
            ListItem::new(Line::from(vec![
                Span::styled(mark, mark_style),
                Span::styled(src_tag, src_style),
                Span::raw(elide_left(p.as_str(), path_budget)),
            ]))
        })
        .collect();
    let mut state = ListState::default();
    if !visible.is_empty() {
        state.select(Some(app.doc_sel));
    }
    // shown/total plus the active needle, so a NARROWED list can never be
    // misread as a small or truncated documentation tree.
    let docs_title = if app.docs_query.is_empty() {
        format!(
            " {} · docs ({}) · /:filter R:regen V:verify ",
            app.harness,
            app.docs_files.len()
        )
    } else {
        format!(
            " {} · docs ({}/{} · /{}) · /:edit ",
            app.harness,
            visible.len(),
            app.docs_files.len(),
            trunc(&app.docs_query, 16)
        )
    };
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(Line::from(docs_title)),
        )
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, cols[0], &mut state);

    // Through the FILTER, not the raw list: `doc_sel` indexes visible_docs(), so
    // reading docs_files here would title the reader pane with a different doc
    // than the one the cursor is on whenever a filter is active.
    let title = app.selected_doc().unwrap_or_default();
    // The active doc's source · status, appended to the reader title.
    let meta = app
        .doc_active
        .as_ref()
        .map(|a| {
            let st = if a.status.is_empty() || a.status == "fresh" {
                String::new()
            } else {
                format!(" · {}", a.status)
            };
            let src = if a.source.is_empty() {
                String::new()
            } else {
                format!(" · {}", a.source)
            };
            format!("{src}{st}")
        })
        .unwrap_or_default();
    let reader_title = if title.is_empty() {
        " reader ".to_string()
    } else {
        format!(" {}{} ", trunc(&title, 46), meta)
    };

    // The augmented human overlay (the "why") rides above the generated body.
    let mut body = if app.doc_content.is_empty() {
        "(no docs — select a file)".to_string()
    } else {
        app.doc_content.clone()
    };
    if let Some(ov) = app.doc_active.as_ref().and_then(|a| a.overlay.as_ref()) {
        if !ov.trim().is_empty() {
            let quoted = ov.replace('\n', "\n┃ ");
            body =
                format!("┃ Human note (augmented · survives regeneration)\n┃ {quoted}\n\n{body}");
        }
    }
    let para = Paragraph::new(body)
        .wrap(Wrap { trim: false })
        .scroll((app.doc_scroll, 0))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(Line::from(reader_title)),
        );
    f.render_widget(para, cols[1]);

    // The `/` filter composer floats over the tab while open (Cupboard's
    // pattern). Rendered last so it sits above both panes.
    if app.docs_search_open {
        let overlay = centered_rect(60, 18, f.area());
        f.render_widget(Clear, overlay);
        f.render_widget(
            Paragraph::new(format!("> {}", app.docs_search_input)).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" Filter docs by path (Enter apply · empty clears · Esc cancel) "),
            ),
            overlay,
        );
    }
}

fn draw_testing(f: &mut Frame, app: &App, area: Rect) {
    // Run-on-click (D-004a): domains (left) ▸ the selected domain's runnable
    // files (right, fetched on Enter), with a run-result pane below once a run
    // has started. Tab hops the column focus; Enter/r runs the selected file.
    let rows = if app.test_run.is_some() {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(1), Constraint::Percentage(45)])
            .split(area)
    } else {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(1)])
            .split(area)
    };
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(44), Constraint::Percentage(56)])
        .split(rows[0]);

    let dom_focused = app.testing_focus == TestingFocus::Domains;
    let focus_hl = |on: bool| if on { Theme::selected() } else { Theme::dim() };

    // Domains (left).
    let items: Vec<ListItem> = app
        .testing
        .iter()
        .map(|d| {
            ListItem::new(Line::from(format!(
                "{:<10} {:<20} {}",
                trunc(&d.tier, 10),
                trunc(&d.label, 20),
                trunc(&d.description, 28),
            )))
        })
        .collect();
    let mut state = ListState::default();
    if !app.testing.is_empty() {
        state.select(Some(app.testing_sel));
    }
    let dbody = block_with_header(
        f,
        cols[0],
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(format!(
                " {}{} · domains ({}) ",
                focus_cursor(dom_focused, app.pane_entered),
                app.harness,
                app.testing.len()
            ))),
        &format!("  {:<11}{:<21}{}", "tier", "domain", "description"),
    );
    let list = List::new(items)
        .highlight_style(focus_hl(dom_focused))
        .highlight_symbol("> ");
    f.render_stateful_widget(list, dbody, &mut state);

    // Files of the selected domain (right).
    let ftitle = Line::from(format!(
        " {}files ({}) — Enter/r: run ",
        focus_cursor(!dom_focused, app.pane_entered),
        app.testing_files.len()
    ));
    if app.testing_files.is_empty() {
        let hint = if app.testing_files_loading {
            "loading files…"
        } else {
            "(Enter on a domain loads its runnable files)"
        };
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(hint, Theme::dim())))
                .block(Block::default().borders(Borders::ALL).title(ftitle)),
            cols[1],
        );
    } else {
        let fitems: Vec<ListItem> = app
            .testing_files
            .iter()
            .map(|p| ListItem::new(Line::from(trunc(p, 64))))
            .collect();
        let mut fstate = ListState::default();
        fstate.select(Some(app.testing_file_sel.min(app.testing_files.len() - 1)));
        let flist = List::new(fitems)
            .block(Block::default().borders(Borders::ALL).title(ftitle))
            .highlight_style(focus_hl(!dom_focused))
            .highlight_symbol("> ");
        f.render_stateful_widget(flist, cols[1], &mut fstate);
    }

    // Run result (bottom) — present from the moment a run starts.
    if let Some(run) = &app.test_run {
        let (status_label, style) = if run.running {
            ("running…".to_string(), Theme::dim())
        } else {
            let s = run.status.clone();
            let style = match s.as_str() {
                "pass" => Theme::notify(),
                _ => Theme::warn(),
            };
            (s, style)
        };
        // Tail the output so the verdict + failures are visible without scroll.
        let tail: Vec<&str> = run.output.lines().rev().take(40).collect();
        let body: String = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        let para = Paragraph::new(if run.running && body.is_empty() {
            "vitest is running in the harness worktree — output lands here.".to_string()
        } else {
            body
        })
        .wrap(Wrap { trim: false })
        .style(if run.running {
            Theme::dim()
        } else {
            Style::default()
        })
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(Line::from(vec![
                    Span::raw(format!(
                        " {} {} · ",
                        crate::glyph::action::RUN,
                        trunc(&run.file, 48)
                    )),
                    Span::styled(status_label, style),
                    Span::raw(" "),
                ])),
        );
        f.render_widget(para, rows[1]);
    }
}

/// The installed-plugin list + a detail pane surfacing each plugin's frontend
/// vs backend contributions (D-007) and its schema-driven settings (D-014).
fn draw_plugins_list(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(42), Constraint::Percentage(58)])
        .split(area);

    // Left: plugin list — name vX, FE/BE contribution counts, ⚙ if configurable.
    let items: Vec<ListItem> = app
        .plugins
        .iter()
        .map(|p| {
            let gear = if p.config_schema.is_some() {
                "⚙"
            } else {
                " "
            };
            ListItem::new(Line::from(format!(
                "{:<24} {:>6} FE:{:<2} BE:{:<2} {}",
                trunc(&p.name, 24),
                trunc(&p.version, 6),
                p.frontend_count(),
                p.backend_count(),
                gear,
            )))
        })
        .collect();
    let mut state = ListState::default();
    if !app.plugins.is_empty() {
        state.select(Some(app.plugin_sel));
    }
    let left_body = block_with_header(
        f,
        cols[0],
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(format!(
                " Cupboard · Installed — plugins ({}) — Tab→panes ",
                app.plugins.len()
            ))),
        &format!(
            "  {:<24} {:>6} {:<6}{:<6}{}",
            "name", "ver", "front", "back", "cfg"
        ),
    );
    f.render_stateful_widget(
        List::new(items)
            .highlight_style(Theme::selected())
            .highlight_symbol("> "),
        left_body,
        &mut state,
    );

    // Right: detail for the selected plugin.
    let block = Block::default()
        .borders(Borders::ALL)
        .title(Line::from(" detail "));
    let detail: Vec<Line> = match app.selected_plugin() {
        None => vec![Line::from(Span::styled(
            "(no plugins installed)",
            Theme::dim(),
        ))],
        Some(p) => {
            let mut lines = vec![
                Line::from(Span::styled(p.name.clone(), Theme::header())),
                Line::from(format!("v{}", p.version)),
            ];
            if let Some(d) = &p.description {
                lines.push(Line::from(""));
                lines.push(Line::from(d.clone()));
            }
            // Frontend contributions (D-007).
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled("frontend", Theme::header())));
            push_contrib(&mut lines, "ui", &p.ui);
            push_contrib(&mut lines, "dashboardTabs", &p.dashboard_tabs);
            push_contrib(&mut lines, "sidebarItems", &p.sidebar_items);
            if p.frontend_count() == 0 {
                lines.push(Line::from(Span::styled("  (none)", Theme::dim())));
            }
            // Backend contributions (D-007).
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled("backend", Theme::header())));
            push_contrib(&mut lines, "tools", &p.tools);
            push_contrib(&mut lines, "actions", &p.actions);
            push_contrib(&mut lines, "apiRoutes", &p.api_routes);
            push_contrib(&mut lines, "routines", &p.routines);
            if p.backend_count() == 0 {
                lines.push(Line::from(Span::styled("  (none)", Theme::dim())));
            }
            // Settings (D-014).
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled("settings", Theme::header())));
            if p.config_schema.is_none() {
                lines.push(Line::from(Span::styled(
                    "  (this plugin declares no configSchema)",
                    Theme::dim(),
                )));
            } else {
                match app.selected_plugin_config() {
                    None => lines.push(Line::from(Span::styled(
                        "  press Enter to load this pot's config",
                        Theme::dim(),
                    ))),
                    Some(cfg) => {
                        let rendered = serde_json::to_string_pretty(cfg)
                            .unwrap_or_else(|_| "(unrenderable)".into());
                        if rendered == "{}" {
                            lines.push(Line::from(Span::styled(
                                "  (no config set — defaults apply)",
                                Theme::dim(),
                            )));
                        } else {
                            for l in rendered.lines() {
                                lines.push(Line::from(format!("  {l}")));
                            }
                        }
                        lines.push(Line::from(""));
                        lines.push(Line::from(Span::styled(
                            "  :pset <key.path> <value> · :punset <key.path>",
                            Theme::dim(),
                        )));
                    }
                }
            }
            lines
        }
    };
    f.render_widget(
        Paragraph::new(detail)
            .wrap(Wrap { trim: false })
            .block(block),
        cols[1],
    );
}

/// Append a `  <field>: name, name (+N)` line for a contribution field, or
/// nothing when the field is empty (D-007).
fn push_contrib(lines: &mut Vec<Line>, field: &str, v: &serde_json::Value) {
    let n = contribution_count(v);
    if n == 0 {
        return;
    }
    let mut names = contribution_names(v);
    let extra = names.len().saturating_sub(4);
    names.truncate(4);
    let mut s = format!("  {field}: {}", names.join(", "));
    if extra > 0 {
        s.push_str(&format!(" (+{extra})"));
    }
    lines.push(Line::from(s));
}

/// The launchable plugin-contributed TUI panes (the original D-002 view).
fn draw_plugin_panes(f: &mut Frame, app: &App, area: Rect) {
    let items: Vec<ListItem> = app
        .panes
        .iter()
        .map(|p| {
            let icon = p.icon.as_deref().unwrap_or("•");
            ListItem::new(Line::from(format!(
                "{:<2} {:<22} {:<18} {}",
                trunc(icon, 2),
                trunc(&p.label, 22),
                trunc(&p.plugin_name, 18),
                trunc(&p.command.join(" "), 40),
            )))
        })
        .collect();
    let mut state = ListState::default();
    if !app.panes.is_empty() {
        state.select(Some(app.pane_sel));
    }
    let body_area = block_with_header(
        f,
        area,
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(format!(
                " {} · plugin panes ({}) — Enter to launch · Tab→browse ",
                app.harness,
                app.panes.len()
            ))),
        &format!("  {:<3}{:<23}{:<19}{}", "", "pane", "plugin", "command"),
    );
    let list = List::new(items)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);
}

fn draw_settings(f: &mut Frame, app: &App, area: Rect) {
    // Read-only settings: the operator-config overview (P10b — AI backend + models +
    // connected providers) above the feature-flag state (P10). The write-side settings
    // (Profile/Voice/Keys/OAuth/pairing/wake-word) are interactive and live on the desktop.
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(9), Constraint::Min(0)])
        .split(area);
    draw_operator_config(f, app, rows[0]);

    let items: Vec<ListItem> = app
        .flags
        .iter()
        .map(|(key, on)| {
            let mark = if *on { "[x]" } else { "[ ]" };
            ListItem::new(Line::from(format!("{mark}  {}", trunc(key, 56))))
        })
        .collect();
    let mut state = ListState::default();
    if !app.flags.is_empty() {
        state.select(Some(app.flag_sel));
    }
    let source = if app.flags_source.is_empty() {
        "—"
    } else {
        app.flags_source.as_str()
    };
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(Line::from(format!(
                    " feature flags ({}) · source: {source} — read-only ",
                    app.flags.len()
                ))),
        )
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, rows[1], &mut state);
}

/// Configuration destination (P-006): stack the editable effective
/// `.claude/settings.json` view with the former read-only Settings contract.
/// Keeping both renderers intact preserves their state/error semantics while
/// removing Settings from the public destination registry.
fn draw_configuration(f: &mut Frame, app: &App, area: Rect) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(58), Constraint::Percentage(42)])
        .split(area);
    draw_config(f, app, rows[0]);
    draw_settings(f, app, rows[1]);
}

/// The read-only operator-config overview (P10b): AI backend + cmd + per-role &
/// per-surface model routing + which speech providers are connected (✓/✗, no
/// secrets). Write-side settings (credentials/OAuth/pairing/wake-word) are
/// interactive/desktop-native and intentionally NOT surfaced here.
fn draw_operator_config(f: &mut Frame, app: &App, area: Rect) {
    let cfg = &app.operator_config;
    let mut lines: Vec<Line> = Vec::new();
    match &cfg.agent {
        Some(a) => {
            let backend = if a.effective_backend.is_empty() {
                a.config.backend.as_str()
            } else {
                a.effective_backend.as_str()
            };
            lines.push(Line::from(format!(
                "backend:  {}  ·  {}",
                backend,
                trunc(&a.config.cmd, 50)
            )));
            if !a.config.models.is_empty() {
                let models = a
                    .config
                    .models
                    .iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join("  ");
                lines.push(Line::from(format!("models:   {}", trunc(&models, 70))));
            }
            if !a.config.surface_models.is_empty() {
                let surf = a
                    .config
                    .surface_models
                    .iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join("  ");
                lines.push(Line::from(format!("surfaces: {}", trunc(&surf, 70))));
            }
        }
        None => lines.push(Line::from("backend:  —")),
    }
    if !cfg.providers.is_empty() {
        let provs = cfg
            .providers
            .iter()
            .map(|(name, set)| {
                format!(
                    "{name} {}",
                    if *set {
                        crate::glyph::status::DONE
                    } else {
                        crate::glyph::status::FAILED
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("  ");
        lines.push(Line::from(format!("providers: {}", trunc(&provs, 70))));
    }
    let para = Paragraph::new(lines).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" operator config (read-only) "),
    );
    f.render_widget(para, area);
}

/// Config tab (D-013): renders the *effective* settings — Claude Code defaults
/// overlaid by the harness's `.claude/settings.json` — so an empty file shows
/// the real editable structure instead of a blank. A provenance line says
/// which top-level keys the file provides (or that everything is defaults),
/// and the footer hints the `:set`/`:unset` palette editor.
fn draw_config(f: &mut Frame, app: &App, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .title(Line::from(format!(
            " {} · .claude/settings.json (effective) ",
            app.harness
        )));
    let mut lines: Vec<Line> = Vec::new();
    if let Some(err) = &app.config.parse_error {
        lines.push(Line::from(Span::styled(
            format!("file invalid: {err} — showing defaults"),
            Theme::warn(),
        )));
    } else if app.config.file_keys.is_empty() {
        lines.push(Line::from(Span::styled(
            "(no settings file for this pot — showing Claude Code defaults)",
            Theme::dim(),
        )));
    } else {
        lines.push(Line::from(Span::styled(
            format!(
                "file sets: {} (rest = defaults)",
                app.config.file_keys.join(", ")
            ),
            Theme::dim(),
        )));
    }
    lines.push(Line::from(""));
    let rendered = if app.config.effective.is_null() {
        "(loading…)".to_string()
    } else {
        serde_json::to_string_pretty(&app.config.effective)
            .unwrap_or_else(|_| "(unrenderable)".into())
    };
    lines.extend(rendered.lines().map(|l| Line::from(l.to_string())));
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        ":set <key.path> <value> · :unset <key.path> — edits write .claude/settings.json",
        Theme::dim(),
    )));
    let para = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .block(block);
    f.render_widget(para, area);
}

/// Operator chat pane (tui-operator-surface-2026-06-04): a scrollable transcript
/// over a composer box. The transcript is **pre-wrapped** to the inner width so
/// the bottom-anchored scroll offset is exact; `chat_scroll` counts lines UP from
/// the latest (0 = pinned to the newest). The in-flight assistant bubble shows a
/// live `<say>` preview via `chat_tags::live_preview`.
fn draw_chat(f: &mut Frame, app: &App, area: Rect) {
    // pui-chat-first-ux P-003 / R-03: the default chat carries no internal
    // jargon. Session ids, lifecycle, reconciliation, pot/role and raw errors
    // show only in the Ctrl-O details view (on by default in the workbench).
    let details = app.chat_details_visible();
    // Background reads may clear the global status error. Keep the actual
    // refusal with the unsent turn so the owner can act on it before retrying.
    // Without details it is ONE plain sentence: cause and next step.
    //
    // A start the operator refused (WI-10004164) leads with that sentence in
    // BOTH views: its reason names the owner's next step (an account or model
    // to choose), so the details view adds the raw code beneath it instead of
    // replacing the next step with `SU-session: <code>: …`.
    let turn_error: Vec<String> = {
        let raw = if details {
            app.su_pending_turn
                .as_ref()
                .filter(|_| !app.chat_streaming)
                .and_then(|turn| turn.error.clone())
                .or(app.su_connection_error.clone())
        } else {
            None
        };
        let sentence = if !details || app.su_launch_refusal.is_some() {
            app.chat_failure_sentence()
        } else {
            None
        };
        let wrap_width = area.width.saturating_sub(2).max(1) as usize;
        sentence
            .into_iter()
            .chain(raw)
            .flat_map(|error| wrap_text(&error, wrap_width))
            .take(6)
            .collect()
    };
    // Inline card (sentinel-tui-shared-backend-and-cards Phase 2a): when the
    // operator brain has an open `chat:ask_choice` card, reserve a bottom strip
    // for it (between the transcript and the composer) and render it there. The
    // card's height scales with its content, clamped so the transcript stays
    // visible. No card → the transcript fills the space as before.
    let card_h = card_block_height(app, area);
    // Keep each selected setting together when the Presence rail or a narrow
    // terminal leaves too little room for the complete configuration row.
    let width = area.width.saturating_sub(2).max(1) as usize;
    let mut selection_rows: Vec<String> = Vec::new();
    let selection = if details {
        app.agent_chat_selection_label()
    } else {
        app.chat_status_line()
    };
    for field in selection.split(" · ") {
        if let Some(last) = selection_rows.last_mut() {
            if Line::from(last.as_str()).width() + 3 + Line::from(field).width() <= width {
                last.push_str(" · ");
                last.push_str(field);
                continue;
            }
        }
        selection_rows.extend(wrap_text(field, width));
    }
    // On very short panes keep the draft/error and transcript space available.
    // Normal panes reserve every measured configuration row.
    let selection_limit = area
        .height
        .saturating_sub(card_h)
        .saturating_sub(turn_error.len() as u16 + 5)
        .max(1) as usize;
    selection_rows.truncate(selection_limit);
    // The `/` command menu (pui-chat-first-ux P-004) sits directly above the
    // draft, inside the composer: as selection rows it grows the box and moves
    // the cursor exactly like the status rows above it.
    if app.chat_composing && app.pending_approvals.is_empty() {
        if let Some(prefix) = crate::chat_commands::query(&app.chat_input) {
            let hits = crate::chat_commands::matching(prefix);
            if hits.is_empty() {
                selection_rows.push(trunc(&format!("  no command matches /{prefix}"), width));
            } else {
                let sel = app.chat_slash_selected.min(hits.len() - 1);
                for (i, c) in hits.iter().enumerate() {
                    let marker = if i == sel { "›" } else { " " };
                    selection_rows.push(trunc(
                        &format!("{marker} /{:<8} {}", c.name, c.summary),
                        width,
                    ));
                }
            }
        }
    }
    // Attachments occupy one row each ABOVE the draft, so the composer has to
    // grow by exactly that many or the draft line is pushed out of its own box.
    // The draft is a real multiline editor now. Reserve one row per logical
    // line plus the two composer borders; the old fixed three-row allocation
    // clipped every line after the first and made a cursor row impossible to
    // place reliably.
    let composer_h = 2
        + ctext_line_count(app)
        + selection_rows.len() as u16
        + app.attachments.len() as u16
        + turn_error.len() as u16;
    let constraints = if card_h > 0 {
        vec![
            Constraint::Min(1),
            Constraint::Length(card_h),
            Constraint::Length(composer_h),
        ]
    } else {
        vec![Constraint::Min(1), Constraint::Length(composer_h)]
    };
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(area);
    let transcript_area = rows[0];
    let (card_area, composer_area) = if card_h > 0 {
        (Some(rows[1]), rows[2])
    } else {
        (None, rows[1])
    };

    let inner_w = transcript_area.width.saturating_sub(2).max(1) as usize; // minus borders
    let mut lines: Vec<Line> = Vec::new();
    if !details {
        // Plain progress in product words; a failure is the composer's one
        // sentence instead, so it is never shown twice.
        if let Some(session) = app
            .su_session
            .as_ref()
            .filter(|_| app.chat_failure_sentence().is_none())
        {
            use crate::su_session::SuSessionLifecycleState as L;
            let engine = session.backend().label();
            let progress = if session.stale {
                Some(format!("Reconnecting to {engine}…"))
            } else {
                match session.lifecycle {
                    L::Starting => Some(format!("Starting {engine}…")),
                    L::Resuming => Some(format!("Resuming {engine}…")),
                    L::Compacting => Some("Compacting the conversation…".to_string()),
                    _ => None,
                }
            };
            if let Some(progress) = progress {
                lines.push(Line::from(Span::styled(progress, Theme::dim())));
            }
        } else if let Some(progress) = app.chat_first_quiet_wait() {
            // P-012: no session exists yet; the quick start is settling.
            lines.push(Line::from(Span::styled(progress, Theme::dim())));
        }
    }
    if let Some(session) = app.su_session.as_ref().filter(|_| details) {
        let lifecycle = format!(
            "SU session · {} · adv {} · seq {}{}",
            session.lifecycle,
            session.binding.adv_session_id,
            session.last_sequence,
            if session.stale {
                " · reconnecting"
            } else {
                ""
            }
        );
        lines.push(Line::from(Span::styled(lifecycle, Theme::notify())));
        lines.push(Line::from(Span::styled(
            "  Ctrl+X interrupt · R resume · K fork · F focus · E end",
            Theme::dim(),
        )));
        lines.push(Line::from(Span::styled(
            format!("  reconciliation: {}", session.reconciliation),
            Theme::dim(),
        )));
        // Wrapped, not truncated: a failure's recovery hint ("Please run
        // /login") trails its cause, so a one-row cut drops the actionable part.
        if let Some(error) = session.error.as_deref() {
            for wl in wrap_text(error, inner_w.saturating_sub(2)) {
                lines.push(Line::from(Span::styled(format!("  {wl}"), Theme::danger())));
            }
        }
    }
    if app.chat_messages.is_empty() && app.pending_owner_echo().is_none() {
        lines.push(Line::from(Span::styled(
            if app.backend_identity_error.is_some() {
                crate::app::CHAT_DISCONNECTED_HINT
            } else if app.chat_first && app.chat_composing {
                // Chat-first already focused the composer (P-001). Once a
                // message is typed or waiting to be resent the hint is noise.
                if app.su_pending_turn.is_some() || !app.chat_input.is_empty() {
                    ""
                } else {
                    "Type a message below and press Enter."
                }
            } else {
                "No messages yet — press i to talk to this agent, or s to choose a role/session."
            },
            Theme::dim(),
        )));
    }
    // P-007 copy contract: the block `y`/`Shift-Y` would act on. Resolved once
    // here (not per message) so the marker cannot disagree with what the reducer
    // would actually copy.
    let copy_focus = app.effective_chat_focus();
    for (block_idx, m) in app.chat_messages.iter().enumerate() {
        let (who, who_style) = match m.role.as_str() {
            "user" => ("you", Theme::selected()),
            "assistant" => ("agent", Theme::notify()),
            other => (other, Theme::dim()),
        };
        let header = if m.streaming {
            format!("{who} ▌")
        } else {
            who.to_string()
        };
        // Mark the copy target in the header gutter. A leading glyph rather than
        // a background highlight: the transcript already spends colour on role,
        // tone and tool state, and the marker has to stay legible on a
        // monochrome or high-contrast terminal in the release matrix.
        let focused = Some(block_idx) == copy_focus;
        let header = if focused {
            format!("▸ {header}")
        } else {
            format!("  {header}")
        };
        // P-013: an assistant block that directly follows another one is the
        // same reply continuing after a tool call (the reducer opens a new
        // block there to keep call order). Repeating "agent" above each such
        // block reads as a new speaker, so the header is omitted — except on
        // the copy target, whose marker must stay on the block `y` copies.
        let follows_same_speaker = m.role == "assistant"
            && block_idx > 0
            && app.chat_messages[block_idx - 1].role == "assistant";
        if !follows_same_speaker || focused {
            lines.push(Line::from(Span::styled(header, who_style)));
        }
        if let Some(provenance) = m.provenance.as_ref().filter(|_| details) {
            lines.push(Line::from(Span::styled(
                format!(
                    "  {} · {} · account {}",
                    provenance.engine, provenance.model, provenance.account_route
                ),
                Theme::dim(),
            )));
        }
        if m.role == "assistant" && !m.reasoning.trim().is_empty() {
            lines.push(Line::from(Span::styled("  reasoning", Theme::dim())));
            for line in wrap_text(m.reasoning.trim(), inner_w.saturating_sub(2)) {
                lines.push(Line::from(Span::styled(format!("  {line}"), Theme::dim())));
            }
        }
        let body = if m.streaming {
            let p = crate::chat_tags::live_preview(&m.content);
            if p.is_empty() {
                "…".to_string()
            } else {
                p
            }
        } else {
            m.content.clone()
        };
        // Assistant prose is MARKDOWN; the user's own text is not. A human who
        // types `*` means an asterisk and a pasted path means that path — and
        // showing someone their own message back restyled is a lie about what
        // was sent. Only the model's half goes through the renderer.
        if m.role == "assistant" {
            lines.extend(crate::markdown::render(&body, inner_w, m.streaming));
        } else {
            for wl in wrap_text(&body, inner_w) {
                lines.push(Line::from(wl));
            }
        }
        for tc in &m.tools {
            let semantic = crate::semantic_tool_cards::card_for_tool(tc);
            // Every label here is a RENDER concern applied from raw model fields
            // (D-017 #1): `name` stays the bare tool so the approval prompt and
            // the resolve POST both read it cleanly, and the status is derived
            // from `outcome`/`needs_approval` rather than baked into the name.
            let (status, status_style) = match &tc.outcome {
                // Parked beats running: an approval-gated call is not slow, it is
                // STOPPED and waiting on this user, and the two must never look
                // alike or nobody learns the turn needs them.
                ToolOutcome::Pending if tc.needs_approval => (
                    format!("  {} awaiting approval", crate::glyph::status::NEEDS_HUMAN),
                    Theme::warn(),
                ),
                ToolOutcome::Pending => (format!("  {}", crate::glyph::status::WIP), Theme::dim()),
                ToolOutcome::Ok => (
                    format!("  {}", crate::glyph::status::DONE),
                    Theme::success(),
                ),
                ToolOutcome::Failed(_) => (
                    format!("  {}", crate::glyph::status::FAILED),
                    Theme::danger(),
                ),
                ToolOutcome::Denied => (
                    format!("  {} denied", crate::glyph::status::BLOCKED),
                    Theme::warn(),
                ),
                // P-014: a question the user chose not to answer. Neutral, not
                // a warning and never the failure colour.
                ToolOutcome::Skipped => (
                    format!("  {} skipped", crate::glyph::status::DROPPED),
                    Theme::dim(),
                ),
            };
            // P-008: a readable name + target (`Update(calc.js)`,
            // `papercusp-su · work items claimable (MCP)`), never the wire id.
            let display = crate::tool_display::tool_display(
                &tc.name,
                tc.input.as_ref(),
                app.launch_cwd.as_deref(),
            );
            lines.push(Line::from(vec![
                Span::styled(
                    format!(
                        "  ⚙ {}",
                        semantic
                            .as_ref()
                            .map(|c| c.title.as_str())
                            .unwrap_or(display.title.as_str())
                    ),
                    Theme::dim(),
                ),
                Span::styled(status, status_style),
            ]));
            // Arguments are TRUNCATED, never wrapped: a tool call carrying a file
            // body would otherwise push the whole transcript off screen, and the
            // card exists to let a turn be skimmed.
            if let Some(card) = semantic.as_ref() {
                for row in &card.rows {
                    let style = match row.tone {
                        SemanticTone::Neutral => Theme::dim(),
                        SemanticTone::Positive => Theme::success(),
                        SemanticTone::Warning => Theme::warn(),
                    };
                    lines.push(Line::from(Span::styled(
                        trunc(&format!("    {}: {}", row.label, row.value), inner_w),
                        style,
                    )));
                }
            } else if let Some(summary) = display.summary.as_deref() {
                lines.push(Line::from(Span::styled(
                    trunc(&format!("    {summary}"), inner_w),
                    Theme::dim(),
                )));
            }
            // The raw arguments exist for inspection only: behind the expand
            // toggle, never in the skimmable row (P-008).
            if app.chat_tools_expanded {
                if let Some(raw) = tc
                    .input
                    .as_ref()
                    .and_then(|v| serde_json::to_string(v).ok())
                {
                    lines.push(Line::from(Span::styled(
                        trunc(&format!("    args {}", raw.replace('\n', " ")), inner_w),
                        Theme::dim(),
                    )));
                }
            }
            if let ToolOutcome::Failed(msg) = &tc.outcome {
                for wl in wrap_text(msg, inner_w.saturating_sub(4)) {
                    lines.push(Line::from(Span::styled(
                        format!("    {wl}"),
                        Theme::danger(),
                    )));
                }
            }
            lines.extend(tool_detail_lines(tc, inner_w, app.chat_tools_expanded));
        }
        // P-007 change cards: the affordance. The diff overlay is reachable
        // only by Enter on a CURSORED block, which nothing else on this screen
        // says — a modal no reader can discover is not a shipped feature. So
        // every turn that edited a file states that its diffs exist, and names
        // the key that actually applies from where the reader is standing:
        // `Enter` once the cursor is on this block, `{`/`}` to get it there.
        //
        // `is_change_card` and not `cards_for_message`: this runs for every
        // visible turn on every frame, and building the cards would run an LCS
        // diff per edit call per frame to answer a yes/no question.
        let card_count = m
            .tools
            .iter()
            .filter(|t| crate::change_card::is_change_card(t))
            .count();
        if card_count > 0 {
            let reachable_now = app.chat_focus.is_some() && Some(block_idx) == copy_focus;
            lines.push(Line::from(Span::styled(
                trunc(
                    &format!(
                        "    {card_count} change card{} · {}",
                        if card_count == 1 { "" } else { "s" },
                        if reachable_now {
                            "Enter opens the diff"
                        } else {
                            "{ } to focus this turn, then Enter"
                        }
                    ),
                    inner_w,
                ),
                Theme::info(),
            )));
        }
        lines.push(Line::from("")); // blank separator between turns
    }
    // pui-chat-first-ux P-012: the line the owner just sent, shown the moment
    // Enter is pressed rather than when the engine accepts it. Rendered like
    // an accepted owner line; `App::pending_owner_echo` ends it when that line
    // lands or the send fails.
    if let Some(echo) = app.pending_owner_echo() {
        lines.push(Line::from(Span::styled("  you", Theme::selected())));
        for wl in wrap_text(echo, inner_w) {
            lines.push(Line::from(wl));
        }
        lines.push(Line::from(""));
    }

    let total = lines.len() as u16;
    let visible = transcript_area.height.saturating_sub(2); // block borders
    let max_top = total.saturating_sub(visible);
    // chat_scroll = lines up from the bottom; clamp so it never overscrolls.
    let top = max_top.saturating_sub(app.chat_scroll.min(max_top));

    let earlier = if app.chat_loading_earlier {
        " · ↑ loading…"
    } else if app.chat_has_more_earlier {
        " · ↑ earlier (PgUp)"
    } else {
        ""
    };
    // When draw_chat renders the DOCKED pane (every tab except Operator, where
    // the full tab IS the chat), show a focus marker so the user can tell whether
    // keystrokes reach the dock (● focused) or the active tab (○ — press o to
    // focus). On the Operator tab this is empty, so existing renders are unchanged.
    let dock_focus = if app.tab != Tab::Operator {
        if app.operator_dock_focused {
            format!("{} ", crate::glyph::toggle::ON)
        } else {
            format!("{} o ", crate::glyph::toggle::OFF)
        }
    } else {
        String::new()
    };
    let streaming_title = if app.chat_streaming {
        " · Running · Ctrl+X cancel".to_string()
    } else {
        String::new()
    };
    let title = format!(" {}Agent Chat{}{} ", dock_focus, earlier, streaming_title,);
    let para = Paragraph::new(lines).scroll((top, 0)).block(
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(title)),
    );
    f.render_widget(para, transcript_area);

    // Inline card (Phase 2a): render the focused card into its reserved strip.
    if let Some(ca) = card_area {
        draw_card(f, app, ca);
    }

    // Computed once up front (pure over `app`) so the read-only branch below
    // doesn't call `su_dispatch_decision()` a second time to get the reason.
    let chat_dispatch = app.su_dispatch_decision();
    let chat_dispatch_readonly =
        app.chat_composing && chat_dispatch.target == crate::su_session::SuDispatchTarget::ReadOnly;
    // P-007 draft queuing. Computed once because BOTH in-flight branches need it:
    // the pending-acknowledgement branch wins for the first moments of every turn,
    // so an owner who queues in that window would otherwise get no feedback at all
    // until the ack landed.
    let queued_note = match app.chat_queued.len() {
        0 => String::new(),
        1 => "  · 1 queued".to_string(),
        n => format!("  · {n} queued"),
    };
    let (ctitle, ctext, cstyle) = if app.card_state.focused_answered().is_some() {
        // P-015: the answer is sent; the card is waiting for the agent to take it.
        (
            " Answer sent ",
            "Waiting for the agent…".to_string(),
            Theme::dim(),
        )
    } else if app.card_state.has_card() {
        // A blocking card is open — the composer is suspended; the card owns the
        // keys (arrows/number/space/Enter). Tell the user where to act.
        let details = match app.card_state.focused().and_then(|card| card.details()) {
            Some(_) if app.chat_tools_expanded => " · Ctrl+R hide details",
            Some(_) => " · Ctrl+R details",
            None => "",
        };
        (
            " Card — answer above ",
            format!("↑↓ move · Enter/number pick · Space toggle · Esc skip{details}"),
            Theme::notify(),
        )
    } else if app.voice_phase.is_active() {
        // Voice PTT in flight (voice-mode-tui-port-2026-06-05 P2) — the composer
        // line becomes the voice status: phase badge, plus a live mic meter while
        // recording (key-up / `v` / Esc to end).
        use crate::app::VoicePhase;
        let badge = app.voice_phase.badge();
        let body = if app.voice_phase == VoicePhase::Recording {
            format!(
                "{badge}  {}   (v / release to send · Esc cancel)",
                mic_meter(app.voice_level)
            )
        } else {
            badge.to_string()
        };
        (" Voice ", body, Theme::notify())
    } else if let Some(p) = app.pending_approvals.first() {
        // A parked HITL request outranks the composer: the loop is blocked on a
        // decision and nothing the user types can advance it, so the prompt —
        // not the message box — is what the composer row must show.
        let more = app.pending_approvals.len().saturating_sub(1);
        let queued = if more > 0 {
            format!("  (+{more} more)")
        } else {
            String::new()
        };
        (
            if app.chat_first && !details {
                // pui-chat-first-ux P-004: the permission prompt in plain words —
                // WHAT the tool wants to do, and the Claude Code keys. The call
                // id is internal and stays in the Ctrl+O details view.
                " Allow this? — y / Enter yes · n / Esc no "
            } else {
                " Approval — Ctrl+Y approve · Ctrl+N deny "
            },
            if app.chat_first && !details {
                let wants = approval_request_summary(app, p, width.saturating_sub(24));
                trunc(&format!("⏸ {wants}{queued}"), width)
            } else {
                format!(
                    "⏸ {} · call {} is waiting on your decision{queued}",
                    p.tool_name, p.call_id
                )
            },
            Theme::notify(),
        )
    } else if app.su_pending_turn.is_some() && app.chat_streaming {
        (
            // Chat-first already shows the message in the transcript (P-012);
            // the composer is empty and ready for the next one.
            if app.chat_first && !details {
                " Sending — Enter queues your next message "
            } else {
                " Sending — awaiting acceptance · draft retained "
            },
            format!("> {}{queued_note}", app.chat_input),
            Theme::notify(),
        )
    } else if app.su_pending_turn.as_ref().is_some_and(|p| p.uncertain) {
        (
            " Delivery uncertain — Enter checks the same turn ",
            format!("> {}", app.chat_input),
            Theme::notify(),
        )
    } else if app.su_pending_turn.is_some() {
        (
            // Chat-first states the failure once, in plain words, below the
            // draft (P-003); the title only names the keys.
            if app.chat_first && !app.chat_details_visible() {
                " Message — Enter retries · Ctrl+O details "
            } else {
                " Message not accepted — draft retained · Enter retries "
            },
            format!("> {}", app.chat_input),
            Theme::notify(),
        )
    } else if app.su_connection_error.is_some() {
        (
            " Session unavailable — Esc, then l: choose session to reconnect ",
            format!("> {}", app.chat_input),
            Theme::warn(),
        )
    } else if app.chat_streaming {
        // The bar read " Running — input locked " until P-007 draft queuing, and
        // that is now a statement the app does not honour: Enter queues the line
        // and it sends itself when the turn settles. A bar naming a behaviour the
        // keys do not have is worse than a bare one — an owner who believes the
        // input is locked stops typing and waits, which is the whole cost this
        // slice was meant to remove.
        //
        // The draft LEADS the body for the same reason as the read-only branch
        // below: this is one unwrapped row beside the Presence rail, so the trailing
        // key hints are the part allowed to truncate, never the owner's own text.
        (
            " Running — Enter queues your next message ",
            format!(
                "> {}{queued_note} · Ctrl+X cancels (clears the queue)",
                app.chat_input
            ),
            Theme::notify(),
        )
    } else if chat_dispatch_readonly {
        // EI-22067863854642076: a legacy/unclassified conversation dispatches
        // nowhere (`on_key`'s Enter arm is a no-op there), and the composer
        // deliberately leaves the draft editable so the owner can still copy
        // it out (see `enter_on_a_pre_cutover_conversation_keeps_read_only_
        // history_intact`) — so typing is unchanged, but the bar must say so
        // up front. Without this the box still reads "Enter send" right up
        // until Enter silently does nothing, which is indistinguishable from
        // a dead key.
        //
        // The draft LEADS the line (WI-2140867): this body is one unwrapped
        // row and the reason note alone is ~69 cols, so beside the Presence
        // rail (68 content cols at width 100) a trailing `> draft` was
        // truncated clean off the screen. The title already says Read-only;
        // the note is the explanation, so it is the part allowed to truncate.
        //
        // The title also names the WAY FORWARD, because "you cannot send here"
        // is only half an answer. It points at Sessions rather than offering an
        // in-pane "new session" action: D-003 of
        // pui-psu-exact-launch-and-task-latency-2026-09-01 is that navigation is
        // literal — "the displayed `s:Sessions` mnemonic always navigates to
        // Sessions; Agent Chat may not shadow it. New-session launch belongs to
        // Sessions." So the fix for a dead-ended read-only conversation is to
        // NAME the existing route, never to bind a competing `s` here (which is
        // what EI-22067863854642076 literally asked for, and what D-003 forbids).
        // "Read-only" leads so it survives title clipping on a narrow pane.
        //
        // It says "Esc, THEN s" and not bare "s" because the order is load-
        // bearing: this branch renders while `chat_composing` is still true, and
        // the composer captures every Char (app.rs `chat_input.push(c)`) so that
        // the refused draft stays editable and copyable. A bare `s` there types
        // an "s" into the draft instead of navigating — advertising it as a
        // one-key action would replace the original dead-Enter confusion with a
        // dead-`s` one. Esc leaves compose; `s` then reaches Sessions (app.rs
        // `lowercase_s_reaches_sessions_from_agent_chat`).
        (
            " Read-only — Esc, then s:Sessions for a new session ",
            format!(
                "> {} · {} · nothing typed here can be sent",
                app.chat_input,
                chat_dispatch.reason.note()
            ),
            Theme::notify(),
        )
    } else if app.chat_composing {
        (
            // Chat-first names the Ctrl-O details view (P-003): the ids and raw
            // errors moved there, so the way to them must be on screen.
            if app.chat_first && app.chat_streaming {
                " Message — Enter queue · Esc stop · Ctrl+R output · Ctrl+O details "
            } else if app.chat_first {
                " Message — Enter send · / commands · @ files · ↑↓ history · Ctrl+O details "
            } else {
                " Message — Enter send · ↑↓ history · Esc cancel "
            },
            // Newlines from a bracketed paste are shown as ⏎ rather than stripped:
            // the model keeps the text verbatim (D-017 #1), and a raw \n inside a
            // single-line Span would render as a blank or a tofu box, hiding from
            // the user that their paste spans several lines.
            format!("> {}", app.chat_input),
            Theme::selected(),
        )
    } else if app.convai_phase != crate::app::ConvAiPhase::Off {
        // Realtime Conv-AI session (voice-realtime-tui-2026-06-05 P-007): the
        // composer becomes the live-session status — no PTT, just talk.
        let owner = if app.convai_is_player {
            "host"
        } else {
            "attached"
        };
        let mic = if app.convai_muted { "muted" } else { "live" };
        let mode = if app.convai_mode.is_empty() {
            "always-on"
        } else {
            app.convai_mode.as_str()
        };
        let ptt_hint = if mode == "push-to-talk" {
            " · v hold-talk"
        } else {
            ""
        };
        (
            " Voice — realtime ",
            format!(
                "{} · {owner} · {mode} · mic {mic}{ptt_hint} · A mode · M mute · H host · V stops",
                app.convai_phase.badge()
            ),
            Theme::notify(),
        )
    } else {
        let hint = match &app.voice_error {
            Some(e) => format!("press i to talk · v to speak — last voice: {e}"),
            None => "press i to talk · v PTT · V realtime voice".to_string(),
        };
        (
            " Composer — i type · v speak · j/k scroll ",
            hint,
            Theme::dim(),
        )
    };
    let selection_row_count = selection_rows.len();
    let mut composer_lines: Vec<Line> = selection_rows
        .into_iter()
        .map(|row| Line::from(Span::styled(row, Theme::dim())))
        .collect();
    // Every selected attachment is shown ABOVE the draft by project-relative
    // path, kind, and stable reference (PUBLIC_RELEASE_UX.md:315-317). Rendered
    // from `Attachments::rows()` — the same single source the picker and any
    // copy path read — so what is displayed before send cannot drift from what
    // is attached.
    for row in app.attachments.rows() {
        composer_lines.push(Line::from(Span::styled(row, Theme::selected())));
    }
    // `Paragraph` does not split embedded newlines into independently
    // addressable cursor rows, so expand them into Lines explicitly. The two
    // leading cells (`> ` / `  `) keep the insertion column stable across the
    // first and continuation rows.
    composer_lines.extend(ctext.split('\n').enumerate().map(|(row, text)| {
        let rendered = if row == 0 {
            text.to_string()
        } else {
            format!("  {text}")
        };
        Line::from(Span::styled(rendered, cstyle))
    }));
    composer_lines.extend(
        turn_error
            .into_iter()
            .map(|error| Line::from(Span::styled(error, Theme::warn()))),
    );
    let cpara = Paragraph::new(composer_lines).block(
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(ctitle)),
    );
    f.render_widget(cpara, composer_area);

    // Ratatui 0.29 exposes the terminal cursor on Frame. Keep it in the same
    // coordinate system as the rendered draft: composer border + settings /
    // attachment rows + a two-cell prompt gutter + display-cell column.
    let composer_editable = app.chat_composing
        && !app.card_state.has_card()
        && !app.voice_phase.is_active()
        && app.pending_approvals.is_empty();
    if composer_editable && composer_area.height > 2 && composer_area.width > 2 {
        let (row, column) = app.chat_cursor_line_col();
        let x = composer_area
            .x
            .saturating_add(1)
            .saturating_add(2)
            .saturating_add(column as u16)
            .min(
                composer_area
                    .x
                    .saturating_add(composer_area.width.saturating_sub(2)),
            );
        let y = composer_area
            .y
            .saturating_add(1)
            .saturating_add(selection_row_count as u16)
            .saturating_add(app.attachments.len() as u16)
            .saturating_add(row.min(u16::MAX as usize) as u16)
            .min(
                composer_area
                    .y
                    .saturating_add(composer_area.height.saturating_sub(2)),
            );
        f.set_cursor_position(Position::new(x, y));
    }
}

fn ctext_line_count(app: &App) -> u16 {
    if app.chat_composing {
        app.chat_input.split('\n').count().max(1) as u16
    } else {
        1
    }
}

/// The height (rows, incl. borders) to reserve for the inline card strip, or 0
/// when no card is open. Scales with the rendered card line count, clamped to
/// at most ~60% of the pane so the transcript stays visible.
fn card_block_height(app: &App, area: Rect) -> u16 {
    if !app.card_state.has_card() {
        return 0;
    }
    // P-015: an answered card is one row until the server closes it.
    if app.card_state.focused_answered().is_some() {
        return 1;
    }
    let inner_w = area.width.saturating_sub(2).max(1) as usize;
    let lines = card_lines(app, inner_w);
    let content = lines.len() as u16;
    let want = content.saturating_add(2); // borders
    let cap = (area.height as f32 * 0.6) as u16;
    want.min(cap.max(4)).max(4)
}

/// Build the rendered lines of the focused card (prompt · optional report ·
/// the presentation-specific body: radio/checkbox rows, text/date/slider input).
fn card_lines(app: &App, inner_w: usize) -> Vec<Line<'static>> {
    use crate::card_view::CardPresentation;
    let mut lines: Vec<Line<'static>> = Vec::new();
    let Some(card) = app.card_state.focused() else {
        return lines;
    };
    // Prompt (wrapped).
    for wl in wrap_text(&card.prompt, inner_w.saturating_sub(2).max(8)) {
        lines.push(Line::from(Span::styled(wl, Theme::header())));
    }
    // Optional structured report block (the same two-tier render the inbox uses).
    if let Some(rep) = &card.report {
        lines.extend(report_block_lines(rep, inner_w));
    }
    // P-008: a tool approval's raw arguments stay behind Ctrl+R, like the
    // transcript's tool output; the prompt above is the readable question.
    if app.chat_tools_expanded {
        if let Some(details) = card.details() {
            lines.push(Line::from(""));
            for raw in details.lines() {
                for wl in wrap_text(raw, inner_w.saturating_sub(2).max(8)) {
                    lines.push(Line::from(Span::styled(wl, Theme::dim())));
                }
            }
        }
    }
    lines.push(Line::from(""));
    match &card.presentation {
        CardPresentation::Radio { options } | CardPresentation::Checkbox { options } => {
            let is_checkbox = matches!(card.presentation, CardPresentation::Checkbox { .. });
            for (i, opt) in options.iter().enumerate() {
                let selected = i == app.card_state.sel;
                // marker: radio → ›/space; checkbox → [x]/[ ]
                let marker = if is_checkbox {
                    if app.card_state.is_checked(i) {
                        "[x]"
                    } else {
                        "[ ]"
                    }
                } else if selected {
                    "›"
                } else {
                    " "
                };
                let label = if let Some(hint) = &opt.hint {
                    format!("{}. {} — {}", i + 1, opt.label, hint)
                } else {
                    format!("{}. {}", i + 1, opt.label)
                };
                let style = if selected {
                    Theme::selected()
                } else {
                    Style::default()
                };
                let row = format!("  {marker} {label}");
                for (li, wl) in wrap_text(&row, inner_w).into_iter().enumerate() {
                    // Indent continuation lines under the label.
                    let text = if li == 0 { wl } else { format!("      {wl}") };
                    lines.push(Line::from(Span::styled(text, style)));
                }
            }
        }
        CardPresentation::Text { placeholder, .. } => {
            let shown = if app.card_state.input.is_empty() {
                placeholder
                    .clone()
                    .or_else(|| card.fallback_text.clone())
                    .unwrap_or_else(|| "type your answer".to_string())
            } else {
                app.card_state.input.clone()
            };
            let style = if app.card_state.input.is_empty() {
                Theme::dim()
            } else {
                Theme::selected()
            };
            lines.push(Line::from(vec![
                Span::raw("  > "),
                Span::styled(shown, style),
                Span::styled(" ▌", Theme::notify()),
            ]));
        }
        CardPresentation::Date { .. } => {
            let shown = if app.card_state.input.is_empty() {
                "YYYY-MM-DD".to_string()
            } else {
                app.card_state.input.clone()
            };
            lines.push(Line::from(vec![
                Span::raw("  date: "),
                Span::styled(shown, Theme::selected()),
                Span::styled(" ▌", Theme::notify()),
            ]));
        }
        CardPresentation::Slider { min, max, step } => {
            // A simple text gauge: value plus a bar across [min,max].
            let v = app.card_state.slider;
            let frac = if (max - min).abs() < f64::EPSILON {
                0.0
            } else {
                ((v - min) / (max - min)).clamp(0.0, 1.0)
            };
            let bar_w = inner_w.saturating_sub(20).clamp(8, 40);
            let filled = (frac * bar_w as f64).round() as usize;
            let bar: String = std::iter::repeat_n('█', filled)
                .chain(std::iter::repeat_n('░', bar_w.saturating_sub(filled)))
                .collect();
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(bar, Theme::notify()),
                Span::styled(
                    format!("  {v}  ({min}–{max}, ±{step})  ←/→ adjust"),
                    Theme::dim(),
                ),
            ]));
        }
        CardPresentation::Unknown => {
            let fb = card
                .fallback_text
                .clone()
                .unwrap_or_else(|| "No renderer for this card type.".to_string());
            for wl in wrap_text(&fb, inner_w) {
                lines.push(Line::from(Span::styled(wl, Theme::dim())));
            }
        }
    }

    // P-026 / D-008: an agent's own pushed fleet transitions use the SAME
    // semantic-card registry as transcript tool calls. The activity ring is
    // newest-first; reverse the bounded slice so these read chronologically.
    let own_events = app.visible_own_fleet_events();
    if !own_events.is_empty() {
        lines.push(Line::from(Span::styled("fleet events", Theme::dim())));
    }
    for event in own_events.into_iter().rev() {
        let Some(card) = crate::semantic_tool_cards::card_for_activity(event) else {
            continue;
        };
        lines.push(Line::from(Span::styled(
            format!("  ⚡ {}", card.title),
            Theme::dim(),
        )));
        for row in &card.rows {
            let style = match row.tone {
                SemanticTone::Neutral => Theme::dim(),
                SemanticTone::Positive => Theme::success(),
                SemanticTone::Warning => Theme::warn(),
            };
            lines.push(Line::from(Span::styled(
                trunc(&format!("    {}: {}", row.label, row.value), inner_w),
                style,
            )));
        }
    }
    lines
}

/// The single line an answered card collapses to (P-015):
/// `✓ Approved · <first prompt line> · N more`, clipped to the strip width.
/// Declines and skips use a neutral dash, not a failure mark (P-014).
fn answered_card_line(
    card: &crate::card_view::OpenCard,
    answered: &crate::card_view::AnsweredCard,
    remaining: usize,
    width: usize,
) -> Line<'static> {
    let negative = matches!(
        answered.summary.as_str(),
        "Declined" | "Skipped" | "Cancelled"
    );
    let (mark, style) = if negative {
        ("– ", Theme::dim())
    } else {
        ("✓ ", Theme::success())
    };
    let prompt = card.prompt.lines().next().unwrap_or("").trim().to_string();
    let more = if remaining > 0 {
        format!(" · {remaining} more")
    } else {
        String::new()
    };
    let head = format!("{mark}{}", answered.summary);
    let budget = width
        .saturating_sub(head.chars().count() + more.chars().count() + 3)
        .max(1);
    let prompt: String = if prompt.chars().count() > budget {
        let mut s: String = prompt.chars().take(budget.saturating_sub(1)).collect();
        s.push('…');
        s
    } else {
        prompt
    };
    Line::from(vec![
        Span::styled(head, style),
        Span::styled(format!(" · {prompt}{more}"), Theme::dim()),
    ])
}

/// Render the focused inline card into `area` (Phase 2a). A bordered block whose
/// title carries the queue indicator (N more after this). The card is a blocking
/// modal on the operator surface — the composer is suspended while it's open.
fn draw_card(f: &mut Frame, app: &App, area: Rect) {
    let remaining = app.card_state.remaining();
    if let (Some(card), Some(answered)) =
        (app.card_state.focused(), app.card_state.focused_answered())
    {
        // P-015: the answer is on its way — collapse the card to one line the
        // moment the key lands, so it can't look unanswered and invite a second
        // press. The server's close event removes the row.
        f.render_widget(Clear, area);
        f.render_widget(
            Paragraph::new(answered_card_line(
                card,
                answered,
                remaining,
                area.width as usize,
            )),
            area,
        );
        return;
    }
    let inner_w = area.width.saturating_sub(2).max(1) as usize;
    let lines = card_lines(app, inner_w);
    // Say what the card needs from the person, not which Papercusp component
    // raised it: "Operator" is internal product jargon to someone who launched
    // `pui` to chat (WI-10004211, pui-chat-first-ux-2026-09-28 R-03).
    let title = if remaining > 0 {
        format!(
            " {} Needs your answer · {remaining} more ",
            crate::glyph::nav::EXPANDED
        )
    } else {
        format!(" {} Needs your answer ", crate::glyph::nav::EXPANDED)
    };
    // Clear under the strip so the transcript doesn't bleed through.
    f.render_widget(Clear, area);
    let para = Paragraph::new(lines).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Theme::notify())
            .title(Line::from(Span::styled(title, Theme::notify()))),
    );
    f.render_widget(para, area);
}

/// Render the operator chat into an arbitrary rectangle — the public, render-only
/// entry point for the docked operator pane (operator-always-visible-2026-06-05,
/// Brief 24). It carries NO layout-split logic: the caller owns the geometry (the
/// workbench `draw()` carves a right-hand column; Brief 23's Overview reserves a
/// bottom strip) and this fills it with the SAME transcript + composer the
/// Operator tab shows — one conversation rendered at multiple sites. The focus
/// marker in the title is driven by `app.operator_dock_focused` (see draw_chat).
/// The persistent Agent Chat pane of the owner-approved Surface B cockpit
/// (pui-psu-exact-launch-and-task-latency-2026-09-01 D-005: canonical mockup
/// `docs/mockups/pui-agent-cockpit.html`, SHA-256
/// dc9026de20d3f2b28dfd8fc260de8f79b4ab70149bcd8a9df2e04bd9a0599009, selected
/// by `pui-agent-context-cockpit-2026-08-26#D-001`). It renders the same
/// transcript + composer as the full Agent Chat tab, carved beside the active
/// destination's content on wide terminals — a fixed layout, not a toggle.
pub fn draw_operator_dock(f: &mut Frame, app: &App, area: Rect) {
    draw_chat(f, app, area);
}

/// Overview — the dashboard landing surface (Brief 23,
/// overview-dashboard-2026-06-05). Top bar (usage/spend/max — stub slots until
/// rate-limit-layer-v2 lands its read-model route, D-004) + four tiles
/// (Plans · Needs-you · Agents · Activity; j/k cycle, Enter opens the full
/// tab, D-007) + the always-on operator strip at the bottom (Brief 24's
/// `draw_operator_dock`, D-008). Four navigation tiles read the SAME pot-scoped
/// app state the full tabs render (D-002/D-005); P-008's fifth pipeline tile
/// reads the canonical registered state cells through the operator tool bridge.
fn draw_overview(f: &mut Frame, app: &App, area: Rect) {
    // The operator strip yields on short terminals — the tiles win, and the
    // operator stays reachable via the Operator tab / the `o` dock.
    let strip_h: u16 = if area.height >= 24 { 9 } else { 0 };
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),       // fleet top bar
            Constraint::Min(8),          // tiles
            Constraint::Length(strip_h), // operator strip
        ])
        .split(area);

    draw_overview_topbar(f, app, rows[0]);

    // 3+2 grid on wide bodies; a five-row stack on narrow ones. The four
    // navigation tiles keep their historical cursor order; Pipeline is a
    // read-only status tile and therefore does not steal a focus stop. The
    // grid starts at the terminal width it always did (96 plus the 30-column
    // presence sidebar that no longer shares compact widths); below it the
    // ~40-column tiles clip plan progress and shas.
    let tiles: [Rect; 5] = if area.width >= 126 {
        let halves = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
            .split(rows[1]);
        let top = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(34),
                Constraint::Percentage(33),
                Constraint::Percentage(33),
            ])
            .split(halves[0]);
        let bot = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
            .split(halves[1]);
        [top[0], top[1], bot[0], bot[1], top[2]]
    } else {
        let fifths = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Percentage(20),
                Constraint::Percentage(20),
                Constraint::Percentage(20),
                Constraint::Percentage(20),
                Constraint::Percentage(20),
            ])
            .split(rows[1]);
        [fifths[0], fifths[1], fifths[2], fifths[3], fifths[4]]
    };

    draw_overview_plans_tile(f, app, tiles[0], app.overview_sel == 0);
    draw_overview_needs_you_tile(f, app, tiles[1], app.overview_sel == 1);
    draw_overview_agents_tile(f, app, tiles[2], app.overview_sel == 2);
    draw_overview_activity_tile(f, app, tiles[3], app.overview_sel == 3);
    draw_overview_pipeline_tile(f, app, tiles[4]);

    if strip_h > 0 {
        draw_operator_dock(f, app, rows[2]);
    }
}

/// Compact text for one registered state cell. The state plane's three-way
/// result is preserved verbatim at the boundary: `unknown` and `absent` are
/// visible words, never collapsed to false/zero/green. For value reads the
/// registered assessment code leads when available; callers that need the raw
/// identity (candidate/deploy sha) opt into `prefer_value`.
fn pipeline_cell_text(cell: &crate::models::PipelineCellRead, prefer_value: bool) -> String {
    let Some(read) = cell.read.as_ref() else {
        return "unknown".to_string();
    };
    match read.status.as_str() {
        "absent" => "absent".to_string(),
        "unknown" => read
            .unknown
            .as_ref()
            .map(|u| format!("unknown:{}", u.code))
            .unwrap_or_else(|| "unknown".to_string()),
        "value" => {
            let raw = match &read.value {
                serde_json::Value::String(s) if !s.is_empty() => Some(s.chars().take(12).collect()),
                serde_json::Value::Bool(v) => Some(if *v { "yes" } else { "no" }.to_string()),
                serde_json::Value::Number(v) => Some(v.to_string()),
                _ => None,
            };
            let assessment = read
                .assessment
                .as_ref()
                .and_then(|a| (a.status == "resolved").then(|| a.code.clone()).flatten());
            if prefer_value {
                raw.or(assessment).unwrap_or_else(|| "unknown".to_string())
            } else {
                assessment.or(raw).unwrap_or_else(|| "unknown".to_string())
            }
        }
        _ => "unknown".to_string(),
    }
}

/// P-008: gate verdict, frozen candidate, main/staging buffer, and deployed
/// sha, all from their registered state cells. Two compact rows keep every
/// datum visible even in the narrow five-row Overview layout.
fn draw_overview_pipeline_tile(f: &mut Frame, app: &App, area: Rect) {
    let rows = match app.pipeline_status.as_ref() {
        None => vec![Line::from(Span::styled(
            "Pipeline state loading…",
            Theme::dim(),
        ))],
        Some(s) => vec![
            Line::from(vec![
                Span::styled("gate ", Theme::dim()),
                Span::raw(pipeline_cell_text(&s.gate_verdict, false)),
                Span::styled(" · candidate ", Theme::dim()),
                Span::raw(pipeline_cell_text(&s.frozen_candidate, true)),
            ]),
            Line::from(vec![
                Span::styled("main ", Theme::dim()),
                Span::raw(pipeline_cell_text(&s.main_behind_staging, false)),
                Span::styled(" · deployed ", Theme::dim()),
                Span::raw(pipeline_cell_text(&s.deployed_sha, true)),
            ]),
        ],
    };
    f.render_widget(
        Paragraph::new(rows).block(overview_tile_block(" Pipeline · live cells ".into(), false)),
        area,
    );
}

/// The Overview tile chrome: bordered block, title styled selected/dim so the
/// j/k tile cursor is visible (the focus_hl idiom the column panes use).
fn overview_tile_block(title: String, selected: bool) -> Block<'static> {
    let style = if selected {
        Theme::selected()
    } else {
        Theme::header()
    };
    Block::default()
        .borders(Borders::ALL)
        .title(Line::from(Span::styled(title, style)))
}

fn burn_horizon(ms: i64) -> String {
    if ms <= 0 {
        return "now".into();
    }
    let minutes = (ms + 59_999) / 60_000;
    if minutes < 60 {
        format!("{minutes}m")
    } else if minutes < 48 * 60 {
        format!("{}h", (minutes + 59) / 60)
    } else {
        format!("{}d", (minutes + 1_439) / 1_440)
    }
}

fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// Top bar: canonical per-provider account capacity + burn projection from
/// `accounts:status`, fleet concurrency from the existing rate read-model, and
/// the live alert count. `+`/`-` continue to edit the hard fleet cap (P-005).
fn draw_overview_topbar(f: &mut Frame, app: &App, area: Rect) {
    let alerts = app
        .scope_visible_attention()
        .iter()
        .filter(|i| i.tier_rank() == 2)
        .count();
    let mut spans: Vec<Span> = vec![Span::styled(" acct ", Theme::dim())];
    if app.account_pool_verdicts.is_empty() {
        spans.push(Span::styled("— (connecting…)", Theme::dim()));
    } else {
        let total: usize = app.account_pool_verdicts.iter().map(|v| v.total).sum();
        let serviceable: usize = app
            .account_pool_verdicts
            .iter()
            .map(|v| v.serviceable)
            .sum();
        let walled: usize = app
            .account_pool_verdicts
            .iter()
            .map(|v| v.walled_fresh)
            .sum();
        let unknown: usize = app.account_pool_verdicts.iter().map(|v| v.unknown).sum();
        let pacing: usize = app.account_pool_verdicts.iter().map(|v| v.pacing).sum();
        spans.push(Span::raw(format!("{serviceable}/{total} svc")));
        if walled > 0 {
            spans.push(Span::styled(format!(" · {walled} walled"), Theme::warn()));
        }
        if unknown > 0 {
            spans.push(Span::styled(format!(" · {unknown} unk"), Theme::warn()));
        }
        if pacing > 0 {
            let now = now_epoch_ms();
            let nearest = app
                .account_rows
                .iter()
                .filter_map(|row| row.burn.as_ref())
                .filter(|burn| burn.disposition == "pacing-projection" && burn.action != "none")
                .filter_map(|burn| burn.projected_exhaustion_at)
                .min()
                .map(|at| burn_horizon(at.saturating_sub(now)));
            spans.push(Span::styled(
                format!(
                    " · burn {pacing} pace{}",
                    nearest.map(|v| format!("@{v}")).unwrap_or_default()
                ),
                Theme::warn(),
            ));
        }
    }
    match &app.fleet_rate {
        Some(s) => {
            let fleet = &s.fleet;
            spans.push(Span::styled(" · ag ", Theme::dim()));
            spans.push(Span::raw(fleet.live_agents.to_string()));
            spans.push(Span::styled(" · dsp ", Theme::dim()));
            // Rate-governed in-flight dispatches / AIMD-effective / editable
            // max (eff shown only when the adaptive layer sits under the cap).
            if fleet.effective < fleet.cap {
                spans.push(Span::raw(format!(
                    "{}/e{}/m{}",
                    fleet.in_flight, fleet.effective, fleet.cap
                )));
            } else {
                spans.push(Span::raw(format!("{}/m{}", fleet.in_flight, fleet.cap)));
            }
            spans.push(Span::styled(" +/-", Theme::dim()));
            let paused = s.paused_count();
            if paused > 0 {
                spans.push(Span::styled(
                    format!("  ·  {} {paused} rate-paused", crate::glyph::severity::WARN),
                    Theme::warn(),
                ));
            }
        }
        None => {
            spans.push(Span::styled(" · ag ", Theme::dim()));
            spans.push(Span::styled("—", Theme::dim()));
        }
    }
    spans.push(Span::styled("  ·  ", Theme::dim()));
    if alerts > 0 {
        spans.push(Span::styled(
            format!("{} {} alerts", crate::glyph::severity::WARN, alerts),
            Theme::warn(),
        ));
    } else {
        spans.push(Span::styled("no alerts", Theme::dim()));
    }
    let p = Paragraph::new(Line::from(spans))
        .block(Block::default().borders(Borders::ALL).title(" Fleet "));
    f.render_widget(p, area);
}

/// Plans tile: in-flight plans (pot-scoped, non-archived, non-shipped) with a
/// done/total progress bar per plan — the same `item_counts` aggregation the
/// fleet view uses.
fn draw_overview_plans_tile(f: &mut Frame, app: &App, area: Rect, selected: bool) {
    let plans: Vec<&crate::models::PlanSummary> = app
        .visible_plans()
        .into_iter()
        .filter(|p| !p.archived && p.status != "shipped" && p.status != "superseded")
        .collect();
    let rows_avail = area.height.saturating_sub(2) as usize;
    let items: Vec<ListItem> = plans
        .iter()
        .take(rows_avail.max(1))
        .map(|p| {
            let c = &p.item_counts;
            let done = c.done;
            let total = c.todo + c.wip + c.blocked + c.needs_human + c.done;
            let bar = progress_bar(done, total, 10);
            let title = if p.title.is_empty() {
                &p.slug
            } else {
                &p.title
            };
            ListItem::new(Line::from(vec![
                Theme::status_marker(&p.status),
                Span::raw(format!(" {:<28} ", trunc(title, 28))),
                Span::styled(bar, Theme::notify()),
                Span::styled(format!(" {done}/{total}"), Theme::dim()),
            ]))
        })
        .collect();
    let n = plans.len();
    let list = List::new(items).block(overview_tile_block(
        format!(" Plans ({n}) · Enter: open "),
        selected,
    ));
    f.render_widget(list, area);
}

/// Needs-you tile: the inbox DECISIONS tier only (inbox-tiering D-006) — the
/// items that genuinely demand the user, not the activity firehose.
fn draw_overview_needs_you_tile(f: &mut Frame, app: &App, area: Rect, selected: bool) {
    let decisions: Vec<&crate::models::AttentionItem> = app_decisions(app);
    let rows_avail = area.height.saturating_sub(2) as usize;
    let items: Vec<ListItem> = decisions
        .iter()
        .take(rows_avail.max(1))
        .map(|it| {
            let loc = it
                .plan_slug
                .clone()
                .or_else(|| it.harness_slug.clone())
                .unwrap_or_default();
            ListItem::new(Line::from(vec![
                Span::styled(crate::glyph::status::NEEDS_HUMAN, Theme::warn()),
                Span::raw(format!(" {:<34} ", trunc(&it.title, 34))),
                Span::styled(trunc(&loc, 16), Theme::dim()),
            ]))
        })
        .collect();
    let n = decisions.len();
    let list = List::new(items).block(overview_tile_block(format!(" Needs you ({n}) "), selected));
    f.render_widget(list, area);
}

/// Agents tile: live (non-stale) roster entries — who's on, what each is doing.
fn draw_overview_agents_tile(f: &mut Frame, app: &App, area: Rect, selected: bool) {
    // The same plan-filtered roster the Fleet tab renders (D-002/D-005).
    let live: Vec<&crate::models::RosterEntry> = app
        .visible_roster()
        .into_iter()
        .filter(|r| !r.stale)
        .collect();
    let rows_avail = area.height.saturating_sub(2) as usize;
    let items: Vec<ListItem> = live
        .iter()
        .take(rows_avail.max(1))
        .map(|r| {
            let what = r.intent.clone().unwrap_or_default();
            let who = if r.label.is_empty() {
                &r.owner_id
            } else {
                &r.label
            };
            ListItem::new(Line::from(vec![
                Theme::liveness_marker(r.stale, &r.liveness),
                Span::raw(format!(" {:<14} ", trunc(who, 14))),
                Span::styled(trunc(&what, 40), Theme::dim()),
            ]))
        })
        .collect();
    let n = live.len();
    let list = List::new(items).block(overview_tile_block(
        format!(" Agents ({n} live) "),
        selected,
    ));
    f.render_widget(list, area);
}

/// Activity tile: the most-recent fleet activity rows (the live stream the
/// Fleet tab mirrors; `summary` arrives server-enriched with its own glyph).
fn draw_overview_activity_tile(f: &mut Frame, app: &App, area: Rect, selected: bool) {
    let rows_avail = area.height.saturating_sub(2) as usize;
    let items: Vec<ListItem> = app
        .visible_fleet_activity()
        .into_iter()
        .take(rows_avail.max(1))
        .map(|a| {
            let agent = a.agent.clone().unwrap_or_default();
            let what = a.summary.clone().unwrap_or_else(|| a.kind.clone());
            ListItem::new(Line::from(vec![
                Span::styled(format!("{:<6} ", trunc(&agent, 6)), Theme::dim()),
                Span::raw(trunc(&what, 52)),
            ]))
        })
        .collect();
    let list = List::new(items).block(overview_tile_block(
        " Activity · live ".to_string(),
        selected,
    ));
    f.render_widget(list, area);
}

/// The inbox decisions tier (tier_rank 0), pot-scoped. Split out so the tile
/// and tests share one definition.
fn app_decisions(app: &App) -> Vec<&crate::models::AttentionItem> {
    app.scope_visible_attention()
        .into_iter()
        .filter(|i| i.tier_rank() == 0)
        .collect()
}

/// A `done/total` progress bar of `cells` single-width blocks. Pure.
pub(crate) fn progress_bar(done: u32, total: u32, cells: usize) -> String {
    let filled = if total == 0 {
        0
    } else {
        ((done as f32 / total as f32) * cells as f32).round() as usize
    };
    let mut s = String::with_capacity(cells);
    for i in 0..cells {
        s.push(if i < filled.min(cells) { '█' } else { '·' });
    }
    s
}

/// A small fixed-width mic-level meter for the voice composer line. `level` is
/// an RMS amplitude (0..~1); we map it (with a little gain, since speech RMS sits
/// low) onto a 12-cell bar. Pure — unit-tested.
fn mic_meter(level: f32) -> String {
    const CELLS: usize = 12;
    let filled = ((level * 4.0).clamp(0.0, 1.0) * CELLS as f32).round() as usize;
    let mut s = String::with_capacity(CELLS + 2);
    s.push('[');
    for i in 0..CELLS {
        s.push(if i < filled { '▮' } else { '·' });
    }
    s.push(']');
    s
}

/// Memory tab (D-006 Step 2): the backend's memories, two-pane like Inbox —
/// list (left: kind + fact) + detail (right: full text + metadata). `/` opens
/// the semantic-search composer; an active query shows its hits instead of the
/// list (Esc returns). The tab shows whatever the configured memory BACKEND
/// holds; an unavailable backend renders a clear empty state.
fn draw_memory(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(52), Constraint::Percentage(48)])
        .split(area);

    let entries = app.visible_memories();
    let title = match &app.memory_hits {
        Some((q, hits)) => format!(
            " Memory · \"{}\" ({}) · Esc: back ",
            trunc(q, 24),
            hits.len()
        ),
        None => format!(" Memory ({}) · /: search ", entries.len()),
    };
    let items: Vec<ListItem> = entries
        .iter()
        .map(|m| {
            ListItem::new(Line::from(format!(
                "{:<11} {}",
                trunc(&m.kind(), 11),
                trunc(&m.memory, 52),
            )))
        })
        .collect();
    let body = if items.is_empty() {
        let hint = if !app.memory_available {
            match &app.memory_load_state {
                crate::event::MemoryLoadState::BackendUnavailable { reason } => format!(
                    "(memory backend unavailable — {})",
                    trunc(reason.as_deref().unwrap_or("not configured yet"), 72)
                ),
                crate::event::MemoryLoadState::AuthFailure { message } => {
                    format!("(memory request unauthorized — {})", trunc(message, 72))
                }
                crate::event::MemoryLoadState::TransportFailure { message } => {
                    format!("(memory request failed — {})", trunc(message, 72))
                }
                crate::event::MemoryLoadState::Available { .. } => {
                    "(memory data unavailable)".to_string()
                }
            }
        } else if app.memory_hits.is_some() {
            "(no hits — Esc returns to the list)".to_string()
        } else {
            "(no memories stored yet)".to_string()
        };
        vec![ListItem::new(Line::from(Span::styled(hint, Theme::dim())))]
    } else {
        items
    };
    let mut state = ListState::default();
    if !entries.is_empty() {
        state.select(Some(app.memory_sel.min(entries.len() - 1)));
    }
    let body_area = block_with_header(
        f,
        cols[0],
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(title)),
        &format!("  {:<12}{}", "kind", "fact"),
    );
    let list = List::new(body)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);

    // Detail (right): the full fact + its metadata.
    let detail = match app.selected_memory() {
        Some(m) => {
            let meta = m
                .metadata
                .as_ref()
                .map(|v| serde_json::to_string_pretty(v).unwrap_or_default())
                .unwrap_or_default();
            let score = m
                .score
                .map(|s| format!("\nscore: {s:.3}"))
                .unwrap_or_default();
            format!(
                "{}\n\nid: {}{}\n\nmetadata:\n{}",
                m.memory, m.id, score, meta
            )
        }
        None => "No memory selected.".to_string(),
    };
    f.render_widget(
        Paragraph::new(detail)
            .wrap(Wrap { trim: false })
            .block(Block::default().borders(Borders::ALL).title(" Detail ")),
        cols[1],
    );

    // The `/` search composer floats over the tab while open.
    if app.memory_search_open {
        let overlay = centered_rect(60, 18, f.area());
        f.render_widget(Clear, overlay);
        f.render_widget(
            Paragraph::new(format!("> {}", app.memory_search_input)).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" Search memory (Enter run · Esc cancel) "),
            ),
            overlay,
        );
    }
}

/// The Cupboard tab (D-011): the marketplace listings under the active kind
/// filter + search, with a detail pane and safe per-kind action dispatch. The
/// filter row is derived from the live `kind_facets`; unsupported kinds remain
/// browsable but read-only instead of exposing a confirmation that must fail.
fn draw_cupboard(f: &mut Frame, app: &App, area: Rect) {
    // Three sub-views, `Tab` cycles: the marketplace Browse list below, and
    // the two absorbed installed-plugin views. Without this dispatch the
    // Cupboard advertised "Browse + Installed (N)" in its own title while
    // rendering listings only, and both installed renderers were dead code.
    match app.cupboard_focus {
        CupboardFocus::Browse => {}
        CupboardFocus::Installed => return draw_plugins_list(f, app, area),
        CupboardFocus::Panes => return draw_plugin_panes(f, app, area),
    }
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(52), Constraint::Percentage(48)])
        .split(area);

    // Kind-filter row + search status in the list title.
    let kinds = app
        .cupboard_kind_options()
        .iter()
        .map(|k| {
            let count = app.cupboard_kind_count(k);
            let label = count.map_or_else(|| k.to_string(), |n| format!("{k}:{n}"));
            if k == &app.cupboard_kind_filter {
                format!("[{label}]")
            } else {
                label
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let population = app.cupboard_total.map_or_else(
        || format!("{} loaded", app.cupboard.len()),
        |total| format!("{}/{}", app.cupboard.len(), total),
    );
    let next_hint = if app.cupboard_next_cursor.is_some() {
        " n:next"
    } else {
        ""
    };
    let title = if app.cupboard_query.is_empty() {
        format!(
            " Cupboard · Browse · [Tab] Installed ({}) · {kinds} · {population} · f:kind{next_hint} /:search ",
            app.plugins.len()
        )
    } else {
        format!(
            " Cupboard · Browse · [Tab] Installed ({}) · {kinds} · \"{}\" ({population}){next_hint} ",
            app.plugins.len(),
            trunc(&app.cupboard_query, 18),
        )
    };

    let mut items: Vec<ListItem> = app
        .cupboard
        .iter()
        .map(|l| {
            ListItem::new(Line::from(format!(
                "{:<10} {:<28} {}",
                trunc(l.normalized_kind(), 10),
                trunc(l.display_name(), 28),
                trunc(l.description.as_deref().unwrap_or(""), 40),
            )))
        })
        .collect();
    if !items.is_empty() && app.cupboard_next_cursor.is_some() {
        items.push(ListItem::new(Line::from(Span::styled(
            if app.cupboard_loading_more {
                "… loading next page"
            } else {
                "n  load next page"
            },
            Theme::dim(),
        ))));
    }
    let body = if items.is_empty() {
        let hint = if app.cupboard_loading {
            "(loading the Cupboard…)"
        } else if !app.cupboard_query.is_empty() {
            "(no listings match — /: edit the search, f: change kind)"
        } else {
            "(no listings — r refetches)"
        };
        vec![ListItem::new(Line::from(Span::styled(hint, Theme::dim())))]
    } else {
        items
    };
    let mut state = ListState::default();
    if !app.cupboard.is_empty() {
        state.select(Some(app.cupboard_sel.min(app.cupboard.len() - 1)));
    }
    let body_area = block_with_header(
        f,
        cols[0],
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(title)),
        &format!("  {:<11}{:<29}{}", "kind", "name", "description"),
    );
    let list = List::new(body)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);

    // Detail (right): the selected listing + its per-kind action.
    let sel = app
        .cupboard
        .get(app.cupboard_sel.min(app.cupboard.len().saturating_sub(1)));
    let (detail, action_label) = match sel {
        Some(l) => {
            let action = l.action_label();
            let action_hint = action.map_or_else(
                || "Read-only in PUI — no safe action for this listing kind".to_string(),
                |label| format!("Enter: arm {label} · y: confirm"),
            );
            let gh = l.github_url.as_deref().unwrap_or("—");
            let by = l.publisher_github_login.as_deref().unwrap_or("—");
            let claim = l.claim_status.as_deref().unwrap_or("—");
            let pot = l.project_ref.as_deref().unwrap_or("—");
            let release = l.latest_json_url.as_deref().unwrap_or("—");
            (
                format!(
                    "{}\n\n{}\n\nkind: {}\npot: {}\ngithub: {}\npublisher: {}\nclaim: {}\nrelease: {}\n\n{}",
                    l.display_name(),
                    l.description.as_deref().unwrap_or("(no description)"),
                    l.normalized_kind(),
                    pot,
                    gh,
                    by,
                    claim,
                    release,
                    action_hint,
                ),
                action,
            )
        }
        None => ("No listing selected.".to_string(), None),
    };
    let armed = sel
        .map(|l| {
            l.action_label().is_some() && app.cupboard_confirm.as_deref() == Some(l.id.as_str())
        })
        .unwrap_or(false);
    let detail_title = if armed {
        format!(" Detail — press y to {} ", action_label.unwrap_or("act"))
    } else {
        " Detail ".to_string()
    };
    f.render_widget(
        Paragraph::new(detail)
            .wrap(Wrap { trim: false })
            .block(Block::default().borders(Borders::ALL).title(detail_title)),
        cols[1],
    );

    // The `/` search composer floats over the tab while open (Memory's pattern).
    if app.cupboard_search_open {
        let overlay = centered_rect(60, 18, f.area());
        f.render_widget(Clear, overlay);
        f.render_widget(
            Paragraph::new(format!("> {}", app.cupboard_search_input)).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" Search the Cupboard (Enter run · Esc cancel) "),
            ),
            overlay,
        );
    }
}

fn draw_status(f: &mut Frame, app: &App, area: Rect) {
    // The operator failure leads: while nothing answers, every later error
    // (an SSE subscribe, an inbox stream) is its symptom, and showing the
    // symptom's internal route hid the cause and its repair (P-021).
    let identity_error = app.backend_identity_error.as_ref();
    let error = identity_error.or(app.last_error.as_ref());
    let (text, style) = match error {
        Some(e) => (
            format!("{} {e}", crate::glyph::severity::WARN),
            Theme::warn(),
        ),
        // The POTS scope indicator (D-003) leads the status line.
        None => {
            let mut text = format!("{} · {}", app.scope_label(), app.status);
            if let Some(identity) = app.backend_identity_status() {
                text.push_str(" · ");
                text.push_str(&identity);
            }
            (text, Theme::dim())
        }
    };
    // The right edge carries one of two right-aligned indicators (each in its
    // own sub-rect so it never clobbers the left status text):
    //   • the companion workbench indicator (P-004) when the zellij plugin is
    //     linked ("▦ N panes", glyph::nav::PANES), else
    //   • a standing discoverability hint (D-012) so the help overlay + the
    //     re-openable tutorial stay visible regardless of how long the status
    //     hint-string is (it would otherwise clip off the right edge).
    let mut right = app.workbench_summary().unwrap_or_else(|| {
        if app.tab != Tab::Operator {
            // Must survive restored non-chat state and narrow layouts where the
            // optional dock cannot render: one key always lands in the composer.
            "o:Agent Chat · ?:help".to_string()
        } else {
            "l/m/e/a/u:select · b:backend · i:compose · ?:help".to_string()
        }
    });
    // Reserve disjoint rectangles before either render. Full shortcuts are
    // optional when they would cover a status/error; the compact help hint
    // (and the global chat key outside Agent Chat) remains discoverable.
    let text = Line::from(text);
    if error.is_some()
        || text.width() + Line::from(right.as_str()).width() + 1 > area.width as usize
    {
        right = if app.tab == Tab::Operator || error.is_some() {
            "?:help"
        } else {
            "o:Agent Chat · ?:help"
        }
        .to_string();
    }
    let w = (Line::from(right.as_str()).width() as u16 + 1).min(area.width);
    let left = Rect {
        width: area.width.saturating_sub(w),
        ..area
    };
    f.render_widget(Paragraph::new(text).style(Theme::status_text(style)), left);
    let sub = Rect {
        x: area.x + area.width.saturating_sub(w),
        y: area.y,
        width: w,
        height: area.height,
    };
    f.render_widget(
        Paragraph::new(Line::from(right)).style(Theme::status_bar()),
        sub,
    );
}

/// Gutter marker → style, for one already-rendered change-card row.
///
/// This reads the rendered TEXT rather than the typed `DiffLine` on purpose.
/// The card's paint and its `y` payload are the same `render_lines()` strings,
/// so colouring what is literally on screen cannot drift from what lands on the
/// clipboard — a second pass over the typed hunks could, and the first thing it
/// would get wrong is the degraded whole-block replace, whose lines are still
/// `Added`/`Removed` but mean something else.
fn diff_line_style(line: &str) -> Style {
    if line.starts_with("@@") {
        Theme::info()
    } else if line.starts_with('+') {
        Theme::success()
    } else if line.starts_with('-') {
        Theme::danger()
    } else if line.starts_with("  error:") || line.starts_with('…') {
        Theme::warn()
    } else {
        Theme::popup()
    }
}

/// The open change card (P-007): a scrollable, colourised diff over the
/// transcript.
///
/// # Why rows are truncated and never wrapped
///
/// `OpenChangeCard::scroll` indexes `ChangeCard::render_lines()`, and the app
/// layer clamps it against that same count — so one rendered line MUST occupy
/// exactly one display row, or the clamp is computed against a length the
/// screen does not have and the last screenful becomes unreachable. Wrapping is
/// also wrong for the content: a wrapped `+` line loses the gutter alignment
/// that makes the three markers readable at a glance. Nothing is lost by
/// truncating — `y` copies `render_lines()` verbatim, unbounded by the
/// terminal's width.
///
/// # Why the frame title is the path and not `card.title()`
///
/// `render_lines()[0]` IS `card.title()`, and the body is painted verbatim so
/// that what the reader sees is exactly what `y` copies. Putting the same
/// string in the frame would render it twice, one row apart. The frame instead
/// carries a pager status line — which file, and where in it you are — so the
/// identity survives scrolling past row 0, which is the only thing a frame
/// title is actually for here.
fn draw_change_card(f: &mut Frame, app: &App) {
    let Some(open) = app.open_change_card.as_ref() else {
        return;
    };
    let area = centered_rect(86, 82, f.area());
    // A frame needs two columns/rows of border before it can hold anything.
    if area.width < 4 || area.height < 3 {
        return;
    }
    let inner_w = area.width.saturating_sub(2) as usize;
    let inner_h = area.height.saturating_sub(2) as usize;

    let lines = open.card.render_lines();
    let total = lines.len();
    let start = open.scroll.min(total.saturating_sub(1));
    let rows: Vec<Line> = lines
        .iter()
        .skip(start)
        .take(inner_h)
        .map(|l| Line::from(Span::styled(trunc(l, inner_w), diff_line_style(l))))
        .collect();
    let shown_to = (start + rows.len()).min(total);

    let head = format!(
        " {} · {}-{}/{} ",
        elide_left(&open.card.path, inner_w.saturating_sub(20)),
        start + 1,
        shown_to,
        total
    );
    let foot = " j/k scroll · PgUp/PgDn page · g/G top/bottom · n/p card · y copy · Shift-Y raw · Esc close ";

    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(rows).style(Theme::popup()).block(
            Theme::popup_block(Line::from(trunc(&head, inner_w)))
                .title_bottom(Line::from(Span::styled(trunc(foot, inner_w), Theme::dim()))),
        ),
        area,
    );
}

/// The composer's `@` picker: the project-scoped listing, its filter, and the
/// reason the last choice was refused.
///
/// # Why the refusal row leads
///
/// The contract's hard requirement is that a cross-project or unreadable path
/// is refused WITH the reason, and that the PUI never falls back to a similarly
/// named file. A refusal the owner cannot SEE is indistinguishable from a
/// picker that quietly did nothing — which is exactly the reading that would
/// make a silent wrong-file attachment look like success. So the notice is
/// painted first and is never the row that scrolls away.
fn draw_file_picker(f: &mut Frame, app: &App) {
    let Some(picker) = app.open_file_picker.as_ref() else {
        return;
    };
    let area = centered_rect(72, 70, f.area());
    // A frame needs two columns/rows of border before it can hold anything.
    if area.width < 4 || area.height < 3 {
        return;
    }
    let inner_w = area.width.saturating_sub(2) as usize;
    let inner_h = area.height.saturating_sub(2) as usize;

    let matches = picker.matches();
    let mut rows: Vec<Line> = Vec::new();
    if let Some(notice) = picker.notice.as_deref() {
        rows.push(Line::from(Span::styled(
            trunc(notice, inner_w),
            Theme::warn(),
        )));
    }

    // Keep the highlighted row on screen once the listing is taller than the
    // frame, or selection walks off the bottom invisibly.
    let list_h = inner_h.saturating_sub(rows.len()).max(1);
    let start = picker.selected.saturating_sub(list_h.saturating_sub(1));
    if matches.is_empty() {
        rows.push(Line::from(Span::styled(
            trunc("No file in this project matches the filter.", inner_w),
            Theme::dim(),
        )));
    }
    for (i, path) in matches.iter().enumerate().skip(start).take(list_h) {
        // A tick marks what is already attached, so Enter's toggle is legible
        // as attach-or-remove rather than looking like a no-op on a re-press.
        let attached = app.attachments.contains(&format!("@{path}"));
        let marker = if attached { "✓ " } else { "  " };
        let style = if i == picker.selected {
            Theme::selected()
        } else if attached {
            Theme::notify()
        } else {
            Theme::popup()
        };
        rows.push(Line::from(Span::styled(
            trunc(&format!("{marker}{path}"), inner_w),
            style,
        )));
    }

    let attached_note = if app.attachments.is_empty() {
        String::new()
    } else {
        format!("· {} attached ", app.attachments.len())
    };
    let head = format!(
        " Attach a file · {} match{} {attached_note}",
        matches.len(),
        if matches.len() == 1 { "" } else { "es" }
    );
    let foot = format!(" @{} · Enter attaches/removes · Esc closes ", picker.query);
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(rows).style(Theme::popup()).block(
            Theme::popup_block(Line::from(trunc(&head, inner_w))).title_bottom(Line::from(
                Span::styled(trunc(&foot, inner_w), Theme::dim()),
            )),
        ),
        area,
    );
}

fn draw_help(f: &mut Frame, app: &App) {
    let area = centered_rect(64, 84, f.area());
    let text = "pui — keys\n\n  1..8 / h s m c a n  switch the 14 destinations (Overview · Agent Chat · Inbox · Plans · Fleet · Sessions · Pots · Docs · Testing · Config · Memory · Cupboard · Voice · Network)\n  o           open Agent Chat + focus its composer from any destination\n  i / Enter   compose/send a message · Esc cancels\n  l/m/e/a/u   conversation · model · effort · account · mode · Sessions n new SU (psu)\n  /           search (Memory · Cupboard)\n  < / >       cycle the 14 destinations · Tab changes the focused subview\n  j / k  ↑/↓  move selection / scroll chat\n  [ / ]       cycle pot · P pot selector (All Pots / one)\n  F           plans filter rail (Inbox / Fleet)\n  f Enter y   Cupboard: kind filter · arm · confirm (join/fork/install)\n  n / Enter   Network board refresh/drill-in · Fleet scheduling/inspector panes\n  g           launch git (lazygit)\n  r           relaunch the last-exited pane · Cupboard: refetch\n  p / N       toggle presence sidebar · notifications history\n  O           show/hide the optional Agent Chat side dock\n  V           realtime agent voice on/off (EL Conv-AI · any destination)\n  M / A / H   realtime mute · mode toggle · force host (while live)\n  PgUp/PgDn   scroll (Docs / Agent Chat) · Esc dismiss toast\n  F1          tutorial (also `:tutorial` in the palette)\n  :           command palette (:create · :share <pot> [invite|public|private] · :theme · dock: :stack :float :dock :layout)\n  Alt+[ / ]   cycle workbench layout preset (stacked · split · grid)\n  ?           toggle this help\n  q / Ctrl-C  quit\n\n  (press any key to close)"
        // The dock session binds plain Tab to zellij's zoom toggle
        // (layout::DOCK_BINDS), so there the subview cycle must be advertised as
        // the key that actually arrives — BackTab, which is an alias on every
        // host. A targeted replace keeps the 30-line literal un-escaped.
        .replace("· Tab changes", &format!("· {} changes", app.cycle_key()))
        .replace("Sessions n new SU (psu)", "Sessions n setup · N Advanced PSU");
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(text)
            .style(Theme::popup())
            .block(Theme::popup_block(Line::from(" Help "))),
        area,
    );
}

/// A transient toast for the latest notification, bottom-right above the status
/// bar (P8).
fn draw_toast(f: &mut Frame, n: &Notif) {
    let full = f.area();
    let w = 50.min(full.width.saturating_sub(2));
    let h = 4u16;
    let area = Rect {
        x: full.width.saturating_sub(w + 1),
        y: full.height.saturating_sub(h + 1),
        width: w,
        height: h,
    };
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(n.message.clone())
            .wrap(Wrap { trim: false })
            .style(Theme::notify())
            .block(Theme::popup_block(Line::from(format!(
                " {} {} · N history · Esc ",
                crate::glyph::header::BELL,
                trunc(&n.level, 12)
            )))),
        area,
    );
}

/// The notifications history overlay (P8) — newest first.
fn draw_notifs(f: &mut Frame, app: &App) {
    let area = centered_rect(72, 70, f.area());
    let items: Vec<ListItem> = if app.notifs.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "(no notifications)",
            Theme::dim(),
        )))]
    } else {
        app.notifs
            .iter()
            .map(|n| {
                let h = n
                    .harness
                    .clone()
                    .map(|s| format!(" [{s}]"))
                    .unwrap_or_default();
                ListItem::new(Line::from(vec![
                    Span::styled(format!("{:<8} ", trunc(&n.level, 8)), Theme::warn()),
                    Span::raw(trunc(&n.message, 56)),
                    Span::styled(h, Theme::dim()),
                ]))
            })
            .collect()
    };
    f.render_widget(Clear, area);
    f.render_widget(
        List::new(items)
            .style(Theme::popup())
            .block(Theme::popup_block(Line::from(format!(
                " Notifications ({}) · any key to close ",
                app.notifs.len()
            )))),
        area,
    );
}

/// The guided multi-step tutorial (P9). `step` is clamped to the last page.
/// The install-lifecycle panel (P-011 / D-016): the exact preview of a change
/// with its confirmation hint, or the read-only About / update / result text.
fn draw_lifecycle(f: &mut Frame, panel: &crate::app::LifecyclePanel) {
    let area = centered_rect(90, 80, f.area());
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(panel.view.lines.join("\n"))
            .wrap(Wrap { trim: false })
            .style(Theme::popup())
            .block(Theme::popup_block(Line::from(format!(
                " {}{} ",
                panel.view.title,
                if panel.busy { " …" } else { "" }
            )))),
        area,
    );
}

fn draw_tutorial(f: &mut Frame, step: usize) {
    const STEPS: [(&str, &str); 4] = [
        (
            "Welcome to pui — the Papercusp workbench",
            "PUI runs Papercusp in your terminal: ask an agent to do work, watch it,\n\
             approve or stop it. It shows the same live work as the desktop app.\n\n\
             Destinations (1–8 / h s m c a n, or < / > to cycle):\n\
             \x20 Overview · Agent Chat · Inbox · Plans · Fleet · Sessions · Pots\n\
             \x20 Docs · Testing · Config · Memory · Cupboard · Voice · Network\n\n\
             Sessions > New chooses your project and runtime before launch.",
        ),
        (
            "Start your first PUI session",
            "Move:    j / k   (or ↑ / ↓)        Scroll docs:  PgUp / PgDn\n\
             Switch a split's focus (Harnesses):  Tab\n\n\
             New PUI session:   s then n   (Sessions > New)\n\
             Open git for the active harness:     g   (lazygit)\n\n\
             Context chooses the project and operator; Runtime chooses engine,\n\
             account, model, effort and mode. Review starts your session.\n\
             The conversation, tools and approvals stay inside PUI.\n\
             In setup, ? opens connection and authentication recovery help.",
        ),
        (
            "Your workbench is zellij",
            "Agent Chat is inside PUI. Optional work panes share the zellij\n\
             workbench around it. These keys move between workbench panes:\n\n\
             Move focus:   Alt + ← ↓ ↑ →   (or Alt + h j k l)\n\
             Layouts:      Alt + [  /  Alt + ]   (stacked · split · grid)\n\
             Back to HUD:  Alt-move toward the pui pane\n\n\
             Command bar ( : ):  :stack · :float · :dock <side> · :layout next|prev\n\
             Sessions n opens PUI setup; Sessions N explicitly opens Advanced PSU.",
        ),
        (
            "Staying in the loop",
            "Presence:      p   toggles the who's‑online sidebar (right)\n\
             Notifications: muted by default — the Inbox badge + N history\n\
             \x20              keep you posted (PUI_NOTIFY=1 re-enables pops).\n\
             Command bar:   :        Full keymap:  ?        Quit:  q\n\n\
             You can re‑open this guide any time with  F1 .\n\n\
             That's it — press any key to start.",
        ),
    ];
    let i = step.min(STEPS.len() - 1);
    let (title, body) = STEPS[i];
    let area = centered_rect(72, 70, f.area());
    let footer = format!(
        "\n\n— step {}/{} · any key {}  ·  Esc skips —",
        i + 1,
        STEPS.len(),
        crate::glyph::nav::CURSOR
    );
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(format!("{body}{footer}"))
            .wrap(Wrap { trim: false })
            .style(Theme::popup())
            .block(Theme::popup_block(Line::from(format!(" {title} ")))),
        area,
    );
}

/// The pot-selector overlay (D-003): "All Pots" + each pot. The current choice
/// carries a filled marker; Enter applies, Esc closes.
fn draw_pot_picker(f: &mut Frame, app: &App) {
    let area = centered_rect(50, 60, f.area());
    let mut items: Vec<ListItem> = Vec::with_capacity(app.harnesses.len() + 1);
    let all_marker = if app.all_pots {
        crate::glyph::toggle::ON
    } else {
        crate::glyph::toggle::OFF
    };
    items.push(ListItem::new(Line::from(format!("{all_marker} All Pots"))));
    for h in &app.harnesses {
        let marker = if !app.all_pots && h.slug == app.harness {
            crate::glyph::toggle::ON
        } else {
            crate::glyph::toggle::OFF
        };
        items.push(ListItem::new(Line::from(format!("{marker} {}", h.slug))));
    }
    let mut state = ListState::default();
    state.select(Some(app.pot_picker_sel.min(app.harnesses.len())));
    let list = List::new(items)
        .style(Theme::popup())
        .block(Theme::popup_block(Line::from(
            " Pot — Enter select · Esc close ",
        )))
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_widget(Clear, area);
    f.render_stateful_widget(list, area, &mut state);
}

/// The model/account picker overlay (P-005 final lane, WI-41189).
///
/// A DISABLED row still RENDERS, marked, with its reason underneath — a menu
/// that silently drops rows it cannot apply misreports what the control does,
/// and the reason is usually the thing the operator actually needs to learn
/// (e.g. that a `--account=default` session must be respawned, not re-pinned).
fn draw_session_setup(f: &mut Frame, app: &App) {
    let Some(setup) = &app.session_setup else {
        return;
    };
    let area = f.area().inner(Margin {
        horizontal: 1,
        vertical: 1,
    });
    let title = ["1 Context", "2 Runtime", "3 Review"][setup.step as usize];
    if let Some(field) = setup.project_entry {
        let lines = vec![
            Line::from(format!("Operator: {}", setup.endpoint)),
            Line::from(format!(
                "Project name: {}{}",
                setup.project_name,
                if field == 0 { "▏" } else { "" }
            )),
            Line::from(format!(
                "Existing directory: {}{}",
                setup.project_path,
                if field == 1 { "▏" } else { "" }
            )),
            Line::from("The directory is on the operator host, not necessarily this device."),
            Line::from("Registration adds project configuration and prepares its data store."),
            Line::from(if field == 2 {
                "Enter REGISTER PROJECT · Tab edit · Esc cancel"
            } else {
                "Enter next · Tab switch field · Ctrl-U clear · Esc cancel"
            }),
            Line::from(setup.note.clone().unwrap_or_default()),
        ];
        f.render_widget(Clear, area);
        f.render_widget(
            Paragraph::new(lines)
                .style(Theme::popup())
                .block(Theme::popup_block(" Register project ".into()))
                .wrap(Wrap { trim: false }),
            area,
        );
        return;
    }
    if setup.show_help {
        let text = "Setup and recovery\n\nNo operator on this computer? For a local setup, install and start the separate Papercusp Server package from your Papercusp release download page; the desktop app is optional. l signs in to Papercusp cloud in your browser, then opens PUI on one of your cloud workspaces. h connects to a remote host you saved with psu (a cloud sign-in or an SSH host). Both hand this terminal to the psu bundled with PUI; when the remote PUI exits, this one exits too. Cancel (Ctrl-C) or a failed sign-in returns you here.\n\nContext: e edits the operator address; Tab enters its token (masked). Enter reconnects this PUI; Esc cancels. A different address never receives the old operator token.\n\nRuntime: b engine, a account, m model, e effort, u mode. Default uses the operator host's credential; auto routes its configured account pool. No account? Configure one on that operator, then r refresh.\n\nAuthentication failure: enter a token issued by the selected operator. Provider login belongs on the operator host: use your engine's login or its existing account setup. PUI does not store provider keys.\n\nUnreachable: check the address and start Papercusp Server. TLS: check scheme and certificate. Missing engine: install it on the operator host. Missing capability: update that operator.\n\nManual mode is the initial setting. Review is required before any session starts.\n\nAny key returns to setup (draft retained).";
        let text = format!("{text}\n\nAccount setup: {}/settings/deploy-accounts\nOperator tokens entered here last for this PUI process only.", setup.endpoint);
        f.render_widget(Clear, area);
        f.render_widget(
            Paragraph::new(text)
                .style(Theme::popup())
                .block(Theme::popup_block(
                    " Setup help · ↑/↓ scroll · Esc back ".into(),
                ))
                .scroll((setup.help_scroll, 0))
                .wrap(Wrap { trim: false }),
            area,
        );
        return;
    }
    if let Some(endpoint) = &setup.endpoint_input {
        let lines = vec![
            Line::from("Reconnect this PUI"),
            Line::from(format!(
                "Operator: {endpoint}{}",
                if setup.editing_token { "" } else { "▏" }
            )),
            Line::from(format!(
                "Operator token: {}{}",
                if setup.token.0.is_empty() {
                    "(not entered)"
                } else {
                    "••••••••"
                },
                if setup.editing_token { "▏" } else { "" }
            )),
            Line::from("A full http(s) URL, such as https://host:9443"),
            Line::from("Tab switches address/token · Ctrl-U clears the field"),
            Line::from("Enter reconnects · Esc cancels · first message retained"),
            Line::from("A changed address clears the previous operator token."),
            Line::from(setup.note.clone().unwrap_or_default()),
        ];
        f.render_widget(Clear, area);
        f.render_widget(
            Paragraph::new(lines)
                .style(Theme::popup())
                .block(Theme::popup_block(" Operator connection ".into()))
                .wrap(Wrap { trim: false }),
            area,
        );
        return;
    }
    let mut lines = vec![
        Line::from(format!(
            "Operator: {}",
            if setup.endpoint.is_empty() {
                "(checking)"
            } else {
                &setup.endpoint
            }
        )),
        Line::from(if app.backend_identity_error.is_some() {
            "Connection: Unavailable"
        } else if app.backend_identity.is_some() {
            "Connection: Connected"
        } else {
            "Connection: Checking"
        }),
    ];
    if setup.step == 0 {
        if app.backend_identity_error.is_some() {
            lines.push(Line::from(
                "No operator here? Run PUI on a remote host instead:",
            ));
        }
        lines.push(Line::from(
            "l Sign in to Papercusp cloud · h Connect to a remote host",
        ));
        lines.push(Line::from(
            "e endpoint / token · c register project · r retry · ? help",
        ));
        if app.backend_identity_error.is_some() {
            // Projects come from the operator; with none answering, a search
            // box and "wait for connection" point at nothing (P-021).
            lines.push(Line::from(
                "Projects appear here once PUI reaches an operator.",
            ));
        } else {
            lines.push(Line::from(format!(
                "Project search: {}{}",
                setup.project_query,
                if setup.project_searching { "▏" } else { "" }
            )));
            let projects = app.setup_projects();
            if projects.is_empty() {
                lines.push(Line::from(
                    "No matching projects. Wait for connection or change the search.",
                ));
            }
            // Two more fixed rows than before: the remote-choice line(s) above.
            let available = area.height.saturating_sub(12).max(1) as usize;
            let start = setup
                .project_cursor
                .saturating_sub(available.saturating_sub(1));
            for (index, project) in projects.iter().enumerate().skip(start).take(available) {
                lines.push(Line::from(format!(
                    "{} {project}",
                    if index == setup.project_cursor {
                        ">"
                    } else {
                        " "
                    }
                )));
            }
            lines.push(Line::from(
                "/ search · ↑/↓ choose · Enter select and continue",
            ));
        }
    } else {
        lines.extend([
            Line::from(format!("Project: {}", setup.project)),
            Line::from(format!("b Engine: {}", setup.backend.label())),
            Line::from(format!(
                "a Account: {}",
                crate::session_config::account_label(setup.account.as_deref(), setup.backend)
            )),
            Line::from(format!(
                "m Model: {}",
                setup.model.as_deref().unwrap_or("Server default model")
            )),
            Line::from(format!(
                "e Effort: {}",
                setup.effort.as_deref().unwrap_or("Default effort")
            )),
            Line::from(format!(
                "u Mode: {}",
                setup.mode.as_deref().unwrap_or("Manual")
            )),
            Line::from("Permissions: native approval prompts"),
        ]);
        if setup.step == 2 {
            lines.push(Line::from(format!(
                "First message: {}",
                if setup.message.is_empty() {
                    "(none)"
                } else {
                    &setup.message
                }
            )));
            lines.push(Line::from(if setup.editing_message {
                "Editing first message — Esc returns to review; Enter adds a line"
            } else {
                "i edit first message · Enter START SESSION"
            }));
        } else {
            lines.push(Line::from(if app.operator_config.agent.is_none() {
                "Runtime: Checking"
            } else if app.setup_blocker().is_some() {
                "Runtime: Unavailable — see reason below"
            } else {
                "Runtime: Ready"
            }));
            lines.push(Line::from("b/a/m/e/u edit runtime · Enter review"));
        }
    }
    if let Some(note) = setup.note.as_ref().cloned().or_else(|| app.setup_blocker()) {
        lines.push(Line::from(note));
    }
    lines.push(Line::from(
        "← / Shift-Tab back · Esc close (message retained) · r retry · ? help",
    ));
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(lines)
            .style(Theme::popup())
            .block(Theme::popup_block(
                format!(" New session — {title} ").into(),
            ))
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn draw_session_picker(f: &mut Frame, picker: &crate::session_config::SessionPicker) {
    let area = centered_rect(60, 60, f.area());
    let items: Vec<ListItem> = picker
        .options
        .iter()
        .map(|o| {
            let mut lines = vec![Line::from(Span::styled(
                if o.disabled {
                    format!("{} — not settable", o.label)
                } else {
                    o.label.clone()
                },
                if o.disabled {
                    Theme::dim()
                } else {
                    Theme::popup()
                },
            ))];
            if let Some(h) = &o.hint {
                lines.push(Line::from(Span::styled(format!("  {h}"), Theme::dim())));
            }
            ListItem::new(lines)
        })
        .collect();
    let mut state = ListState::default();
    state.select(Some(picker.sel.min(picker.options.len().saturating_sub(1))));
    let list = List::new(items)
        .style(Theme::popup())
        .block(Theme::popup_block(Line::from(picker.title())))
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_widget(Clear, area);
    f.render_stateful_widget(list, area, &mut state);
}

/// D-009's global session switcher. It is a transient routing overlay, never a
/// destination: every row is still activated through App::resolve_agent_route.
fn draw_session_switcher(f: &mut Frame, app: &App) {
    let Some(switcher) = &app.session_switcher else {
        return;
    };
    let area = centered_rect(84, 76, f.area());
    f.render_widget(Clear, area);
    let block = Theme::popup_block(Line::from(
        " Sessions · Ctrl-S · fuzzy live + parked + ended + recorded ",
    ));
    let inner = block.inner(area);
    f.render_widget(block, area);
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(inner);

    let loading = if switcher.loading {
        "  searching…"
    } else {
        ""
    };
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("filter › ", Theme::title_active()),
            Span::raw(switcher.query.clone()),
            Span::styled(loading, Theme::dim()),
        ]))
        .style(Theme::popup()),
        chunks[0],
    );

    let rows = app.visible_session_switcher();
    if rows.is_empty() {
        f.render_widget(
            Paragraph::new("No sessions match this filter.")
                .style(Theme::dim())
                .wrap(Wrap { trim: false }),
            chunks[1],
        );
    } else {
        let items: Vec<ListItem> = rows
            .iter()
            .map(|row| {
                let state = row
                    .session_state
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .or_else(|| (!row.liveness.is_empty()).then_some(row.liveness.as_str()))
                    .unwrap_or("unknown")
                    .to_ascii_lowercase();
                let (marker, state_style) = match state.as_str() {
                    "live" => ("● LIVE", Theme::success()),
                    "parked" => ("Ⅱ PARKED", Theme::warn()),
                    "ended" => ("○ ENDED", Theme::dim()),
                    "recorded" => ("◇ RECORDED", Theme::dim()),
                    _ => ("· UNKNOWN", Theme::dim()),
                };
                let role = row.role.as_deref().unwrap_or(&row.source);
                let plan = row.current_plan_slug.as_deref().unwrap_or("no plan");
                let detail = row.intent.as_deref().unwrap_or(plan);
                ListItem::new(vec![
                    Line::from(vec![
                        Span::styled(format!("{marker:<12}"), state_style),
                        Span::styled(trunc(&row.label, 28), Theme::title_active()),
                        Span::styled(format!("  · {role}"), Theme::dim()),
                    ]),
                    Line::from(Span::styled(
                        format!("  {} · {}", trunc(&row.owner_id, 24), trunc(detail, 58)),
                        Theme::dim(),
                    )),
                ])
            })
            .collect();
        let mut state = ListState::default();
        state.select(Some(switcher.sel.min(rows.len().saturating_sub(1))));
        f.render_stateful_widget(
            List::new(items)
                .style(Theme::popup())
                .highlight_style(Theme::selected())
                .highlight_symbol("> "),
            chunks[1],
            &mut state,
        );
    }
    f.render_widget(
        Paragraph::new(format!(
            "j/k move · {} MRU · Enter route · Esc close",
            app.cycle_key()
        ))
        .style(Theme::dim()),
        chunks[2],
    );
}

/// The Fleet `[r]/[n]/[f]` no-session action menu (pui-workbench-usability
/// D-002). Surfaced when Enter on a roster agent finds no single reachable
/// session, so Enter never silently focuses empty space. Only the viable choices
/// render; `[n] launch` is always offered.
fn draw_fleet_menu(f: &mut Frame, menu: &crate::app::FleetActionMenu) {
    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled(menu.note.clone(), Theme::dim())),
        Line::from(""),
    ];
    if menu.can_resume {
        lines.push(Line::from(vec![
            Span::styled("[r]", Theme::title_active()),
            Span::raw(" resume the ended session"),
        ]));
    }
    lines.push(Line::from(vec![
        Span::styled("[n]", Theme::title_active()),
        Span::raw(" launch a new agent here"),
    ]));
    if menu.can_focus_window {
        lines.push(Line::from(vec![
            Span::styled("[f]", Theme::title_active()),
            Span::raw(" focus its terminal window"),
        ]));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled("Esc to cancel", Theme::dim())));

    // Height: note + blank + the rendered choices + blank + esc, +2 for borders.
    let h = (lines.len() as u16 + 2).min(f.area().height);
    let full = f.area();
    let w = (full.width as u32 * 56 / 100).clamp(36, 72) as u16;
    let area = Rect {
        x: full.x + (full.width.saturating_sub(w)) / 2,
        y: full.y + (full.height.saturating_sub(h)) / 2,
        width: w.max(1),
        height: h,
    };
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .style(Theme::popup())
            .block(Theme::popup_block(Line::from(format!(
                " {} · reach agent ",
                trunc(&menu.label, 28)
            )))),
        area,
    );
}

/// The crew-restore ended-members prompt (P-031): restoring a crew focuses
/// live members and wakes parked ones; this modal asks before resuming the
/// ENDED ones instead of silently returning a smaller workspace (D-009).
fn draw_crew_restore_prompt(f: &mut Frame, prompt: &crate::app::CrewRestorePrompt) {
    let n = prompt.members.len();
    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled(
            format!("{n} member(s) of this crew have ENDED sessions"),
            Theme::dim(),
        )),
        Line::from(""),
    ];
    for m in &prompt.members {
        let agent = m.agent.clone().unwrap_or_else(|| "agent".to_string());
        let handle = m
            .resume_id
            .clone()
            .map(|r| format!("resume {r}"))
            .unwrap_or_else(|| "no resume handle".to_string());
        lines.push(Line::from(Span::raw(format!("  {agent} · {handle}"))));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled("[y]", Theme::title_active()),
        Span::raw(" resume them too"),
    ]));
    lines.push(Line::from(vec![
        Span::styled("[n]", Theme::title_active()),
        Span::raw(" restore without them"),
    ]));
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled("Esc to skip", Theme::dim())));

    // Height: note + blank + members + blank + 2 choices + blank + esc, +2 borders.
    let h = (lines.len() as u16 + 2).min(f.area().height);
    let full = f.area();
    let w = (full.width as u32 * 56 / 100).clamp(36, 72) as u16;
    let area = Rect {
        x: full.x + (full.width.saturating_sub(w)) / 2,
        y: full.y + (full.height.saturating_sub(h)) / 2,
        width: w.max(1),
        height: h,
    };
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .style(Theme::popup())
            .block(Theme::popup_block(Line::from(format!(
                " crew '{}' · resume ended members? ",
                trunc(&prompt.crew, 24)
            )))),
        area,
    );
}

/// The staged-wake review overlay (hive-agent-tabs P-009 / D-005): a manual-mode
/// agent's pending wakes, oldest-first, with per-wake release / edit & release /
/// skip. The edit layer swaps the footer for a live input line.
fn draw_wake_review(f: &mut Frame, rev: &crate::app::WakeReview) {
    let mut lines: Vec<Line> = Vec::new();
    if rev.loading {
        lines.push(Line::from(Span::styled(
            "(loading staged wakes…)",
            Theme::dim(),
        )));
    } else if let Some(err) = &rev.error {
        lines.push(Line::from(Span::styled(
            format!("error: {err}"),
            Theme::danger(),
        )));
        lines.push(Line::from(""));
    }
    if !rev.loading && rev.pending.is_empty() {
        lines.push(Line::from(Span::styled(
            "(no staged wakes — incoming wakes stage here while the agent is in manual mode)",
            Theme::dim(),
        )));
    }
    for (i, pw) in rev.pending.iter().enumerate() {
        let marker = if i == rev.sel { "> " } else { "  " };
        let summary = pw.summary.clone().unwrap_or_else(|| "(no summary)".into());
        let src = pw.source.clone().unwrap_or_default();
        let mut spans = vec![
            Span::raw(marker.to_string()),
            Span::styled(format!("#{} ", pw.id), Theme::dim()),
            Span::raw(trunc(&summary, 48).to_string()),
        ];
        if !src.is_empty() {
            spans.push(Span::styled(
                format!("  · {}", trunc(&src, 16)),
                Theme::dim(),
            ));
        }
        let line = Line::from(spans);
        lines.push(if i == rev.sel {
            line.style(Theme::selected())
        } else {
            line
        });
    }
    lines.push(Line::from(""));
    if let Some(buf) = &rev.edit {
        // Edit layer: the input line + its own footer.
        lines.push(Line::from(vec![
            Span::styled("edit: ", Theme::title_active()),
            Span::raw(buf.clone()),
            Span::styled("▌", Theme::dim()),
        ]));
        lines.push(Line::from(Span::styled(
            "Enter release edited · Esc cancel edit",
            Theme::dim(),
        )));
    } else {
        let busy = if rev.busy { " · working…" } else { "" };
        lines.push(Line::from(Span::styled(
            format!("r/Enter release · e edit & release · s skip · j/k select · Esc close{busy}"),
            Theme::dim(),
        )));
    }

    let h = (lines.len() as u16 + 2).min(f.area().height);
    let full = f.area();
    let w = (full.width as u32 * 64 / 100).clamp(44, 84) as u16;
    let area = Rect {
        x: full.x + (full.width.saturating_sub(w)) / 2,
        y: full.y + (full.height.saturating_sub(h)) / 2,
        width: w.max(1),
        height: h,
    };
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .style(Theme::popup())
            .block(Theme::popup_block(Line::from(format!(
                " {} · staged wakes ({}) ",
                trunc(&rev.label, 24),
                rev.pending.len()
            )))),
        area,
    );
}

fn draw_palette(f: &mut Frame, app: &App) {
    // A fixed-height box (input + the command/dock-verb hints), centered — a
    // percentage height would over-grow on tall terminals and still clip on
    // short ones. Width tracks the terminal; height is constant.
    let full = f.area();
    let tool_mode = app.tool_palette.is_some();
    let h = if tool_mode { 20 } else { 9 }.min(full.height);
    let width_percent = if tool_mode { 86 } else { 70 };
    let w = (full.width as u32 * width_percent / 100) as u16;
    let area = Rect {
        x: full.x + (full.width.saturating_sub(w)) / 2,
        y: full.y + (full.height.saturating_sub(h)) / 2,
        width: w.max(1),
        height: h,
    };
    f.render_widget(Clear, area);
    if let Some(state) = app.tool_palette.as_ref() {
        let inner_w = area.width.saturating_sub(4).max(1) as usize;
        let mut lines = vec![Line::from(vec![
            Span::styled("query  ", Theme::dim()),
            Span::styled(state.query.clone(), Theme::input()),
        ])];
        let title = match &state.phase {
            ToolPalettePhase::Searching => {
                lines.push(Line::from(""));
                lines.push(Line::from(Span::styled(
                    "Searching the live tool catalog and reusable recipes…",
                    Theme::dim(),
                )));
                " Tools · searching (Esc closes) ".to_string()
            }
            ToolPalettePhase::Results => {
                lines.push(Line::from(Span::styled(
                    format!(
                        "{} tool match{} · ↑/↓ select · Enter arguments",
                        state.tools.len(),
                        if state.tools.len() == 1 { "" } else { "es" }
                    ),
                    Theme::dim(),
                )));
                let start = state.selected.saturating_sub(4);
                for (index, hit) in state.tools.iter().enumerate().skip(start).take(6) {
                    let selected = index == state.selected;
                    let marker = if selected { "▶" } else { " " };
                    lines.push(Line::from(vec![
                        Span::styled(
                            format!("{marker} {}", hit.name),
                            if selected {
                                Theme::selected()
                            } else {
                                Style::default()
                            },
                        ),
                        Span::styled(
                            hit.via
                                .as_deref()
                                .filter(|via| !via.is_empty())
                                .map(|via| format!("  [{via}]"))
                                .unwrap_or_default(),
                            Theme::dim(),
                        ),
                    ]));
                    if selected && !hit.description.trim().is_empty() {
                        lines.push(Line::from(Span::styled(
                            trunc(&format!("    {}", hit.description), inner_w),
                            Theme::dim(),
                        )));
                    }
                }
                if !state.recipes.is_empty() {
                    lines.push(Line::from(Span::styled(
                        "recipes:search suggestions",
                        Theme::header(),
                    )));
                    for recipe in state.recipes.iter().take(3) {
                        lines.push(Line::from(Span::styled(
                            trunc(
                                &format!(
                                    "  ◇ {} — {}",
                                    recipe.id,
                                    if recipe.title.is_empty() {
                                        recipe.description.as_str()
                                    } else {
                                        recipe.title.as_str()
                                    }
                                ),
                                inner_w,
                            ),
                            Theme::dim(),
                        )));
                    }
                }
                if let Some(error) = state.recipe_error.as_deref() {
                    lines.push(Line::from(Span::styled(
                        trunc(&format!("recipe suggestions unavailable: {error}"), inner_w),
                        Theme::warn(),
                    )));
                }
                " Tools · results (Esc closes) ".to_string()
            }
            ToolPalettePhase::Arguments {
                tool,
                required,
                index,
                args,
            } => {
                lines.push(Line::from(vec![
                    Span::styled("tool   ", Theme::dim()),
                    Span::styled(tool.name.clone(), Theme::header()),
                ]));
                for line in wrap_text(&format!("schema  {}", tool.arg_schema), inner_w)
                    .into_iter()
                    .take(3)
                {
                    lines.push(Line::from(Span::styled(line, Theme::dim())));
                }
                lines.push(Line::from(""));
                if let Some(field) = required.get(*index) {
                    lines.push(Line::from(vec![
                        Span::styled(
                            format!("required {}/{}  {}", index + 1, required.len(), field.name),
                            Theme::header(),
                        ),
                        Span::styled(format!(" : {}", field.schema), Theme::dim()),
                    ]));
                } else {
                    lines.push(Line::from(Span::styled(
                        format!(
                            "optional extras JSON object (blank = none) · {} required value{} captured",
                            args.len(),
                            if args.len() == 1 { "" } else { "s" }
                        ),
                        Theme::header(),
                    )));
                }
                lines.push(Line::from(Span::styled(
                    format!("> {}", app.palette_input),
                    Theme::input(),
                )));
                lines.push(Line::from(Span::styled(
                    "Enter accepts · Esc returns to results · paste is safe data",
                    Theme::dim(),
                )));
                format!(" Tools · arguments · {} ", tool.name)
            }
            ToolPalettePhase::Running { tool, args } => {
                lines.push(Line::from(""));
                lines.push(Line::from(Span::styled(
                    format!("{} Invoking {}", crate::glyph::status::WIP, tool.name),
                    Theme::header(),
                )));
                lines.push(Line::from(Span::styled(
                    trunc(&format!("args  {args}"), inner_w),
                    Theme::dim(),
                )));
                lines.push(Line::from(Span::styled(
                    "The server still applies capability and confirmation policy.",
                    Theme::dim(),
                )));
                " Tools · running (Esc dismisses) ".to_string()
            }
            ToolPalettePhase::Result {
                tool,
                card,
                succeeded,
            } => {
                lines.push(Line::from(""));
                lines.push(Line::from(vec![
                    Span::styled(
                        format!(
                            "{} ",
                            if *succeeded {
                                crate::glyph::status::DONE
                            } else {
                                crate::glyph::status::FAILED
                            }
                        ),
                        if *succeeded {
                            Theme::success()
                        } else {
                            Theme::danger()
                        },
                    ),
                    Span::styled(card.title.clone(), Theme::header()),
                ]));
                for row in &card.rows {
                    let style = match row.tone {
                        SemanticTone::Neutral => Theme::dim(),
                        SemanticTone::Positive => Theme::success(),
                        SemanticTone::Warning => Theme::warn(),
                    };
                    lines.push(Line::from(Span::styled(
                        trunc(&format!("  {}: {}", row.label, row.value), inner_w),
                        style,
                    )));
                }
                lines.push(Line::from(""));
                lines.push(Line::from(Span::styled(
                    "Enter or Esc closes",
                    Theme::dim(),
                )));
                format!(" Tools · result · {} ", tool.name)
            }
        };
        if let Some(error) = state.error.as_deref() {
            lines.push(Line::from(Span::styled(
                trunc(&format!("error  {error}"), inner_w),
                Theme::danger(),
            )));
        }
        f.render_widget(
            Paragraph::new(Text::from(lines))
                .wrap(Wrap { trim: true })
                .block(Theme::popup_block(Line::from(title))),
            area,
        );
        return;
    }
    // The active swap-layout preset (Brief 50 / D-008) rides the companion
    // topology; absent a companion link we just show the cycle from the KDL.
    let active_preset = app
        .topology
        .as_ref()
        .and_then(|t| t.tabs.iter().find(|x| x.active))
        .and_then(|x| x.swap_layout.clone());
    let presets = crate::layout::SWAP_PRESETS.join(" · ");
    let layout_line = match active_preset {
        Some(p) => format!("Layout [{p}] of {presets}  (Alt+[ / ] or :layout next|prev|<name>)"),
        None => format!("Layout presets: {presets}  (Alt+[ / ] or :layout next|prev|<name>)"),
    };
    // Input on the first line; the command + dock-verb hints wrap below so they
    // stay visible (a single long block title would truncate them off, D-008).
    let body = Text::from(vec![
        Line::from(Span::styled(format!("> {}", app.palette_input), Theme::input())),
        Line::from(""),
        Line::from(Span::styled(
            "tutorial · tool <query> · layouts · crews (saved session sets — restore focuses live · wakes parked · asks on ended) · save/restore-crew|layout · create <slug> <path|gh-url> · share <slug> [public] · theme <name> · themes",
            Theme::dim(),
        )),
        Line::from(Span::styled(
            "dock — :stack · :float [pane] · :dock left|right",
            Theme::dim(),
        )),
        Line::from(Span::styled(layout_line, Theme::dim())),
        Line::from(Span::styled(
            "install — :about · :update [archive] · :rollback · :diagnostics · :uninstall [purge]",
            Theme::dim(),
        )),
    ]);
    f.render_widget(
        Paragraph::new(body)
            .wrap(Wrap { trim: true })
            .block(Theme::popup_block(Line::from(" Command (Esc closes) "))),
        area,
    );
}

/// Render `block` over `area`, paint a styled column-header line at the top of
/// its inner area (D-005 — the PUI's lists bake column labels into row format
/// strings, so the header is an explicit extra line), and return the remaining
/// rect for the list body. Callers render their `List` WITHOUT a block into
/// the returned rect. Headers start with two spaces to stay aligned with the
/// "> " highlight-symbol indent of stateful lists.
pub(crate) fn block_with_header(f: &mut Frame, area: Rect, block: Block, header: &str) -> Rect {
    block_with_header_rows(
        f,
        area,
        block,
        vec![Line::from(Span::styled(
            header.to_string(),
            Theme::header(),
        ))],
    )
}

/// `block_with_header` for N pre-styled header lines (e.g. the colony roster's
/// kind legend above its column header). Same contract: callers render their
/// list WITHOUT a block into the returned rect.
pub(crate) fn block_with_header_rows(
    f: &mut Frame,
    area: Rect,
    block: Block,
    rows_above: Vec<Line<'static>>,
) -> Rect {
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.height == 0 {
        return inner;
    }
    let n = rows_above.len() as u16;
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(n), Constraint::Min(0)])
        .split(inner);
    f.render_widget(Paragraph::new(rows_above), rows[0]);
    rows[1]
}

/// The Plans tab's item-detail body. This stays local to the Plans surface now
/// that the refitted Context pane renders only the shared projection contract.
fn plan_item_detail_lines(it: &crate::models::PlanItemState) -> Vec<Line<'static>> {
    let mut out = vec![
        Line::from(Span::styled(it.item_id.clone(), Theme::title())),
        Line::from(vec![
            Span::styled("status      ", Theme::dim()),
            Span::raw(it.item_status.clone().unwrap_or_else(|| "—".to_string())),
            Span::styled("   disposition  ", Theme::dim()),
            Span::raw(if it.disposition.is_empty() {
                "—".to_string()
            } else {
                it.disposition.clone()
            }),
        ]),
    ];
    let who = it
        .claim_owner_name
        .clone()
        .or_else(|| it.claim_owner.clone())
        .or_else(|| it.assignee_name.clone());
    if let Some(who) = who.filter(|value| !value.is_empty()) {
        out.push(Line::from(vec![
            Span::styled("who         ", Theme::dim()),
            Span::raw(who),
        ]));
    }
    if let Some(mode) = it
        .claim_liveness_mode
        .clone()
        .filter(|value| !value.is_empty())
    {
        out.push(Line::from(vec![
            Span::styled("liveness    ", Theme::dim()),
            Span::raw(mode),
        ]));
    }
    if let Some(expires) = it
        .claim_expires_ts
        .clone()
        .filter(|value| !value.is_empty())
    {
        out.push(Line::from(vec![
            Span::styled("lease ends  ", Theme::dim()),
            Span::raw(expires),
        ]));
    }
    if let Some(intent) = it.claim_intent.clone().filter(|value| !value.is_empty()) {
        out.push(Line::from(Span::styled("─".repeat(40), Theme::dim())));
        out.push(Line::from(Span::styled("intent", Theme::info())));
        for line in intent.lines() {
            out.push(Line::from(line.to_string()));
        }
    }
    out
}

/// The Fleet comms detail popup (owner ask 2026-06-14): the full mail message or
/// conversation thread under the comms cursor, centered over the dock. Modal —
/// the key handler closes it on Esc/`q`/Enter and steps the item with `j`/`k`.
fn draw_fleet_detail(f: &mut Frame, app: &App) {
    let area = centered_rect(70, 70, f.area());
    f.render_widget(Clear, area);
    let (title, lines): (&str, Vec<Line<'static>>) = fleet_detail_content(app);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(title)
        .style(Theme::panel_active());
    let inner = block.inner(area);
    f.render_widget(block, area);
    // Clamp the scroll offset to the wrapped content so PageDown can't run past
    // the end (owner ask 2026-06-14). Wrapped-row estimate: each logical line
    // occupies ceil(display_width / inner_width) rows.
    let inner_w = inner.width.max(1) as u32;
    let total_rows: u32 = lines
        .iter()
        .map(|l| (l.width() as u32).div_ceil(inner_w).max(1))
        .sum();
    let max_scroll = (total_rows.min(u32::from(u16::MAX)) as u16).saturating_sub(inner.height);
    let scroll = app.fleet_detail_scroll.min(max_scroll);
    f.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0)),
        inner,
    );
}

/// The title + body for the detail popup. The Plans tab shows the selected
/// plan's full detail (owner ask 2026-06-15 #1 — the same rich body as the Fleet
/// plan-progress popup); otherwise the focused Fleet panel decides (mail /
/// conversation / plan).
fn fleet_detail_content(app: &App) -> (&'static str, Vec<Line<'static>>) {
    use crate::app::PlansFocus;
    use crate::fleet::FleetPanel;
    if app.tab == crate::app::Tab::Plans {
        if app.plans_focus == PlansFocus::Goals {
            let lines = match app.selected_goal() {
                Some(g) => goal_detail_lines(g),
                None => vec![Line::from(Span::styled(
                    "(all goals — select a goal for detail)",
                    Theme::dim(),
                ))],
            };
            return (" goal · Esc close · j/k goal · PgUp/Dn scroll ", lines);
        }
        if app.plans_focus == PlansFocus::Items {
            let lines = match app.selected_plan_item() {
                Some(it) => plan_item_detail_lines(it),
                None => vec![Line::from(Span::styled(
                    "(no work item selected)",
                    Theme::dim(),
                ))],
            };
            return (" work item · Esc close · j/k item · PgUp/Dn scroll ", lines);
        }
        let selected_plan = app.selected_plan().map(crate::fleet::plan_detail_lines_for);
        let lines = selected_plan
            .unwrap_or_else(|| vec![Line::from(Span::styled("(no plan selected)", Theme::dim()))]);
        return (" plan · Esc close · j/k plan · PgUp/Dn scroll ", lines);
    }
    match app.fleet.fleet_focus {
        FleetPanel::Inbox | FleetPanel::Outbox => {
            let is_inbox = app.fleet.fleet_focus == FleetPanel::Inbox;
            let title = if is_inbox {
                " inbox · Esc close · j/k item · PgUp/Dn scroll "
            } else {
                " outbox · Esc close · j/k item · PgUp/Dn scroll "
            };
            let lines = match app.selected_comms_mail() {
                Some(e) => mail_detail_lines(e, is_inbox),
                None => vec![Line::from(Span::styled(
                    "(no message selected)",
                    Theme::dim(),
                ))],
            };
            (title, lines)
        }
        FleetPanel::Conversations => (
            " conversation · Esc close · j/k item · PgUp/Dn scroll ",
            conv_detail_lines(app),
        ),
        FleetPanel::PlanProgress => (
            " plan · Esc close · j/k plan · PgUp/Dn scroll ",
            crate::fleet::plan_detail_lines(app),
        ),
        // Dossier (worklist): the selected work item's detail (owner ask 2026-06-16).
        FleetPanel::Dossier => (
            " work item · Esc close · j/k item · PgUp/Dn scroll ",
            crate::fleet::dossier_detail_lines(app),
        ),
        FleetPanel::Roster => (" detail ", Vec::new()),
    }
}

/// The header + full body of one coord-mail entry (the list truncates the body;
/// the popup shows all of it).
fn mail_detail_lines(e: &crate::models::BeeMailEntry, is_inbox: bool) -> Vec<Line<'static>> {
    let (peer_label, peer) = if is_inbox {
        ("from", e.from.clone().unwrap_or_else(|| "?".into()))
    } else if e.to.iter().any(|t| t == "*") {
        ("to", "* (broadcast)".to_string())
    } else {
        ("to", e.to.join(", "))
    };
    let body = e
        .body
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| e.summary.clone())
        .unwrap_or_else(|| "(no body)".to_string());
    let mut out = vec![
        Line::from(vec![
            Span::styled(format!("{peer_label:<5} "), Theme::dim()),
            Span::raw(peer),
        ]),
        Line::from(vec![
            Span::styled("time  ", Theme::dim()),
            Span::raw(e.ts.clone()),
            Span::styled("   kind  ", Theme::dim()),
            Span::raw(e.kind.clone()),
        ]),
        Line::from(Span::styled("─".repeat(40), Theme::dim())),
    ];
    for l in body.lines() {
        out.push(Line::from(l.to_string()));
    }
    out
}

/// The loaded conversation thread (header + body + accepted answer + posts), or a
/// loading placeholder while the fetch is in flight.
fn conv_detail_lines(app: &App) -> Vec<Line<'static>> {
    let Some(d) = app.conversation_detail.as_ref() else {
        return vec![Line::from(Span::styled("loading…", Theme::dim()))];
    };
    let mut out = Vec::new();
    if let Some(c) = &d.conversation {
        out.push(Line::from(Span::styled(
            c.title.clone().unwrap_or_else(|| c.id.clone()),
            Theme::title_active(),
        )));
        out.push(Line::from(vec![
            Span::styled("state ", Theme::dim()),
            Span::raw(c.state.clone()),
            Span::styled("   asker ", Theme::dim()),
            Span::raw(c.asker_id.clone()),
        ]));
        if !c.body.is_empty() {
            out.push(Line::from(""));
            for l in c.body.lines() {
                out.push(Line::from(l.to_string()));
            }
        }
        if let Some(ans) = &c.accepted_answer {
            out.push(Line::from(""));
            out.push(Line::from(Span::styled("✓ accepted answer", Theme::info())));
            for l in ans.lines() {
                out.push(Line::from(l.to_string()));
            }
        }
    }
    if !d.posts.is_empty() {
        out.push(Line::from(""));
        out.push(Line::from(Span::styled(
            format!("─ {} posts ─", d.posts.len()),
            Theme::dim(),
        )));
        for p in &d.posts {
            let who = p.author_id.clone().unwrap_or_else(|| "?".into());
            let first = p.body.lines().next().unwrap_or("").to_string();
            out.push(Line::from(vec![
                Span::styled(format!("{} ", trunc(&who, 12)), Theme::dim()),
                Span::raw(first),
            ]));
        }
    }
    out
}

/// A centered rect `pct_w` × `pct_h` percent of `area`.
fn centered_rect(pct_w: u16, pct_h: u16, area: Rect) -> Rect {
    let v = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - pct_h) / 2),
            Constraint::Percentage(pct_h),
            Constraint::Percentage((100 - pct_h) / 2),
        ])
        .split(area);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - pct_w) / 2),
            Constraint::Percentage(pct_w),
            Constraint::Percentage((100 - pct_w) / 2),
        ])
        .split(v[1])[1]
}

/// Greedy word-wrap `s` to `width` columns, returning display rows. Preserves
/// explicit '\n' breaks; hard-splits a word longer than `width`. The chat
/// transcript pre-wraps with this so its scroll offset is exact (vs. letting
/// Paragraph's own Wrap reflow at unknown line counts).
fn wrap_text(s: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![s.to_string()];
    }
    let mut out = Vec::new();
    for raw_line in s.split('\n') {
        let mut cur = String::new();
        let mut cur_w = 0usize;
        for word in raw_line.split(' ') {
            let wlen = word.chars().count();
            if wlen > width {
                // Flush the current line, then hard-split the over-long word.
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                let mut chunk = String::new();
                for ch in word.chars() {
                    if chunk.chars().count() == width {
                        out.push(std::mem::take(&mut chunk));
                    }
                    chunk.push(ch);
                }
                cur = chunk;
                cur_w = cur.chars().count();
                continue;
            }
            let add = if cur.is_empty() { wlen } else { wlen + 1 };
            if cur_w + add > width {
                out.push(std::mem::take(&mut cur));
                cur.push_str(word);
                cur_w = wlen;
            } else {
                if !cur.is_empty() {
                    cur.push(' ');
                }
                cur.push_str(word);
                cur_w += add;
            }
        }
        out.push(cur);
    }
    out
}

/// Truncate to `n` chars (cheap; ASCII-oriented labels).
pub(crate) fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// Truncate from the LEFT, keeping the tail (EI-21646357450104414).
///
/// For a path the identifying part is the filename, so dropping leading
/// directories preserves strictly more information than [`trunc`], which keeps
/// the head and would render a deep documentation tree as a column of
/// indistinguishable `internal/docs/agent-i…` prefixes.
pub(crate) fn elide_left(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n {
        return s.to_string();
    }
    let keep = n.saturating_sub(1);
    let mut out = String::from("…");
    out.extend(s.chars().skip(count - keep));
    out
}

/// One-line, width-bounded rendering of a tool call's arguments for its card.
///
/// `None` means "render no argument line at all", which is the right answer for
/// arguments that would be pure noise: absent, `null`, or an empty object. A
/// no-argument tool then gets a clean one-line card instead of an empty bracket
/// pair dressed up as information.
/// Collapsed tool output shows this many lines; Ctrl+R shows up to the cap.
const TOOL_OUTPUT_PREVIEW_LINES: usize = 3;
const TOOL_DIFF_PREVIEW_LINES: usize = 8;
const TOOL_EXPANDED_LINE_CAP: usize = 400;

/// The readable text of a tool's terminal result, or `None` when the payload
/// carries none. Only textual shapes are rendered — a string, a `content` /
/// `text` / `output` / `stdout` field, or an array of `{type:'text',text}`
/// parts; anything else (a structured envelope) is left to the semantic card,
/// so the transcript never dumps raw JSON.
pub(crate) fn tool_result_text(result: &serde_json::Value) -> Option<String> {
    use serde_json::Value;
    fn parts(v: &Value) -> Option<String> {
        match v {
            Value::String(s) => Some(s.clone()),
            Value::Array(items) => {
                let texts: Vec<String> = items
                    .iter()
                    .filter_map(|it| match it {
                        Value::String(s) => Some(s.clone()),
                        Value::Object(o) => {
                            o.get("text").and_then(Value::as_str).map(str::to_owned)
                        }
                        _ => None,
                    })
                    .collect();
                (!texts.is_empty()).then(|| texts.join("\n"))
            }
            _ => None,
        }
    }
    let text = match result {
        Value::Object(o) => ["content", "text", "output", "stdout", "result"]
            .iter()
            .find_map(|k| o.get(*k).and_then(parts))?,
        other => parts(other)?,
    };
    let text = crate::glyph::terminal_safe_text(&text);
    let trimmed = text.trim_end();
    (!trimmed.trim().is_empty()).then(|| trimmed.to_string())
}

/// Inline detail under a tool call (pui-chat-first-ux P-004): the diff of a
/// file change, or a preview of the tool's output. Collapsed by default to a
/// few lines with a "+N lines" note; `expanded` (Ctrl+R / `/expand`) shows it
/// all, up to a cap that keeps one huge output from swallowing the transcript.
pub(crate) fn tool_detail_lines(
    tc: &crate::models::ChatToolCall,
    width: usize,
    expanded: bool,
) -> Vec<Line<'static>> {
    use crate::change_card::DiffLine;
    let mut out: Vec<Line<'static>> = Vec::new();
    let more = |hidden: usize, out: &mut Vec<Line<'static>>| {
        let note = if expanded {
            format!("      … {hidden} more lines not shown")
        } else {
            format!("      … +{hidden} lines (Ctrl+R to expand)")
        };
        out.push(Line::from(Span::styled(trunc(&note, width), Theme::dim())));
    };
    if let Some(card) = crate::change_card::card_for_tool(tc, 0, 0) {
        let all: Vec<&DiffLine> = card.hunks.iter().flat_map(|h| h.lines.iter()).collect();
        let limit = if expanded {
            TOOL_EXPANDED_LINE_CAP
        } else {
            TOOL_DIFF_PREVIEW_LINES
        };
        for dl in all.iter().take(limit) {
            let style = match dl {
                DiffLine::Added(_) => Theme::success(),
                DiffLine::Removed(_) => Theme::danger(),
                DiffLine::Context(_) => Theme::dim(),
            };
            out.push(Line::from(Span::styled(
                trunc(
                    &format!(
                        "    {} {}",
                        dl.marker(),
                        crate::glyph::terminal_safe_text(dl.text())
                    ),
                    width,
                ),
                style,
            )));
        }
        let hidden = all.len().saturating_sub(limit);
        if hidden > 0 {
            more(hidden, &mut out);
        }
        return out;
    }
    // A skipped question's result is the note the MODEL was sent ("the user
    // skipped this question…"); the user already knows they skipped it, so
    // echoing it under the row only repeats the status (P-014).
    if tc.outcome == crate::models::ToolOutcome::Skipped {
        return out;
    }
    let Some(text) = tc.result.as_ref().and_then(tool_result_text) else {
        return out;
    };
    let body_w = width.saturating_sub(6).max(1);
    let rows: Vec<String> = if expanded {
        text.lines().flat_map(|l| wrap_text(l, body_w)).collect()
    } else {
        text.lines().map(str::to_owned).collect()
    };
    let limit = if expanded {
        TOOL_EXPANDED_LINE_CAP
    } else {
        TOOL_OUTPUT_PREVIEW_LINES
    };
    for (i, row) in rows.iter().take(limit).enumerate() {
        let lead = if i == 0 { "    ⎿ " } else { "      " };
        out.push(Line::from(Span::styled(
            trunc(&format!("{lead}{row}"), width),
            Theme::dim(),
        )));
    }
    let hidden = rows.len().saturating_sub(limit);
    if hidden > 0 {
        more(hidden, &mut out);
    }
    out
}

/// What a parked tool call wants to do, in words: the semantic card title or
/// tool name, plus its arguments when they summarise to one line.
fn approval_request_summary(app: &App, p: &crate::models::PendingApproval, width: usize) -> String {
    let call = app
        .chat_messages
        .iter()
        .rev()
        .flat_map(|m| m.tools.iter())
        .find(|t| t.id.as_deref() == Some(p.call_id.as_str()));
    let title = call
        .and_then(crate::semantic_tool_cards::card_for_tool)
        .map(|c| c.title)
        .unwrap_or_else(|| {
            crate::tool_display::tool_display(
                &p.tool_name,
                call.and_then(|t| t.input.as_ref()),
                app.launch_cwd.as_deref(),
            )
            .title
        });
    let args = call
        .and_then(|t| t.input.as_ref())
        .and_then(|v| tool_input_summary(v, width.max(8)));
    match args {
        Some(a) => format!("{title} wants to run: {a}"),
        None => format!("{title} is waiting for your permission"),
    }
}

pub(crate) fn tool_input_summary(input: &serde_json::Value, width: usize) -> Option<String> {
    if width == 0 || input.is_null() {
        return None;
    }
    match input {
        serde_json::Value::Object(m) if m.is_empty() => return None,
        serde_json::Value::Array(a) if a.is_empty() => return None,
        _ => {}
    }
    // P-008: `key: value · key: value`, never raw JSON. The helper collapses
    // embedded newlines BEFORE truncating: this is a single-line summary, and
    // a multi-line argument value must not smuggle extra rows into a card
    // whose height the transcript layout has already accounted for.
    let flat = crate::tool_display::human_args(input, usize::MAX)?;
    Some(trunc(&flat, width))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Notif, PlanSummary, RosterEntry};
    use ratatui::{backend::TestBackend, Terminal};

    fn render(app: &App, w: u16, h: u16) -> String {
        let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
        term.draw(|f| draw(f, app)).unwrap();
        term.backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect()
    }

    /// PUBLIC_RELEASE_UX.md "Below 80 columns or 20 rows": the whole screen is
    /// one stable instruction — nothing else, so no clipped control — and the
    /// normal surface returns at exactly the minimum.
    #[test]
    fn below_the_minimum_size_only_the_too_small_view_renders() {
        let mut app = App::new();
        let message = "Terminal too small — resize to at least 80×20. \
                       Your session and draft are safe.";
        for (w, h) in [(79, 40), (200, 19), (40, 10), (12, 3)] {
            // main seeds the viewport from the terminal and Event::Resize keeps it.
            app.viewport = (w, h);
            let text = render(&app, w, h);
            let shown = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if h >= 4 && w >= 40 {
                assert_eq!(shown, message, "{w}x{h}");
            } else {
                // Too tiny to hold the whole sentence: still nothing but it.
                assert!(message.starts_with(&shown), "{w}x{h}: {shown:?}");
            }
        }
        app.viewport = (80, 20);
        assert!(!render(&app, 80, 20).contains("Terminal too small"));
    }

    fn plan(slug: &str, status: &str) -> PlanSummary {
        PlanSummary {
            slug: slug.into(),
            title: format!("Title {slug}"),
            status: status.into(),
            updated: "2026-06-04".into(),
            owner: Some("o@x.z".into()),
            harness: Some("papercup".into()),
            archived: false,
            next_action: Some("do the thing".into()),
            item_counts: Default::default(),
            open: None,
            done: None,
            priority: None,
        }
    }

    fn critical_item(
        id: &str,
        status: &str,
        blocked_by: &[&str],
        owner: Option<(&str, &str)>,
    ) -> crate::models::PlanItemState {
        crate::models::PlanItemState {
            item_id: id.into(),
            item_status: Some(status.into()),
            blocked_by: blocked_by.iter().map(|id| (*id).into()).collect(),
            in_plan: true,
            claim_owner: owner.map(|(_, label)| label.into()),
            claim_owner_id: owner.map(|(id, _)| id.into()),
            ..Default::default()
        }
    }

    #[test]
    fn critical_path_uses_longest_depth_and_live_claim_context() {
        let states = crate::models::PlanItemStates {
            harness: "papercup".into(),
            plan: "critical-demo".into(),
            items: vec![
                critical_item("P-001", "done", &[], None),
                // The completed blocker vanishes, making P-002 a remaining root.
                critical_item("P-002", "todo", &["P-001"], Some(("su-root", "root"))),
                critical_item("P-003", "wip", &["P-002"], None),
                critical_item("P-004", "todo", &["P-002"], Some(("su-side", "side"))),
                // Two parents pin this node to the longest remaining path.
                critical_item(
                    "P-005",
                    "todo",
                    &["P-003", "P-004"],
                    Some(("su-leaf", "leaf")),
                ),
                // A dangling ref is not part of this plan's remaining graph.
                critical_item("P-006", "todo", &["P-999"], None),
            ],
            ..Default::default()
        };
        let assignments = vec![
            crate::models::BeeAssignment {
                agent_id: "su-root".into(),
                context_pressure: Some("critical".into()),
                ..Default::default()
            },
            crate::models::BeeAssignment {
                agent_id: "su-leaf".into(),
                context_pressure: Some("high".into()),
                ..Default::default()
            },
        ];

        let columns = critical_path_columns(&states, &assignments);
        assert_eq!(columns.len(), 3);
        assert_eq!(
            columns[0]
                .iter()
                .map(|n| n.item_id.as_str())
                .collect::<Vec<_>>(),
            ["P-002", "P-006"]
        );
        assert_eq!(
            columns[1]
                .iter()
                .map(|n| n.item_id.as_str())
                .collect::<Vec<_>>(),
            ["P-003", "P-004"]
        );
        assert_eq!(columns[2][0].item_id, "P-005");
        assert_eq!(columns[2][0].depth, 2);
        assert_eq!(columns[0][0].waiters, 3);
        assert_eq!(columns[0][0].pressure.as_deref(), Some("critical"));
        assert_eq!(columns[2][0].pressure.as_deref(), Some("high"));
        assert!(columns[0][1].unclaimed);
        assert!(
            columns[1][0].unclaimed,
            "unclaimed peers sort loudly before claimed peers"
        );
        assert!(columns.iter().flatten().all(|n| n.item_id != "P-001"));
    }

    #[test]
    fn critical_path_keeps_cycles_visible_without_self_waiters() {
        let states = crate::models::PlanItemStates {
            items: vec![
                critical_item("P-001", "todo", &["P-002"], None),
                critical_item("P-002", "todo", &["P-001"], None),
                critical_item("P-003", "todo", &[], None),
            ],
            ..Default::default()
        };

        let columns = critical_path_columns(&states, &[]);
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0][0].item_id, "P-003");
        assert!(columns[1].iter().all(|node| node.cycle));
        assert!(columns[1].iter().all(|node| node.depth == 1));
        assert!(columns[1].iter().all(|node| node.waiters == 1));
    }

    #[test]
    fn critical_path_overlay_renders_depth_pressure_and_unclaimed_warning() {
        let mut app = App::new();
        app.critical_path_open = true;
        app.critical_path_target = Some(("papercup".into(), "critical-demo".into()));
        app.critical_path_states = Some(crate::models::PlanItemStates {
            harness: "papercup".into(),
            plan: "critical-demo".into(),
            items: vec![
                critical_item("P-001", "wip", &[], Some(("su-root", "root"))),
                critical_item("P-002", "todo", &["P-001"], None),
            ],
            ..Default::default()
        });
        app.fleet.all_assignments = vec![crate::models::BeeAssignment {
            agent_id: "su-root".into(),
            context_pressure: Some("critical".into()),
            ..Default::default()
        }];

        let text = render(&app, 160, 40);
        assert!(text.contains("dependency depth"));
        assert!(text.contains("depth 0"));
        assert!(text.contains("depth 1"));
        assert!(text.contains("P-001 [wip]"));
        assert!(text.contains("critical"));
        assert!(text.contains("UNCLAIMED"));
        assert!(text.contains("1 lane"));
    }

    #[test]
    fn fleet_launcher_renders_defaults_capacity_preview_and_confirmation() {
        let mut app = App::new();
        app.tab = Tab::Plans;
        app.plan_item_states = Some(crate::models::PlanItemStates {
            harness: "papercup".into(),
            plan: "launch-demo".into(),
            items: vec![
                critical_item("P-001", "todo", &[], None),
                critical_item("P-002", "todo", &["P-001"], None),
            ],
            ..Default::default()
        });
        app.fleet_launcher = Some(crate::app::FleetLauncher {
            scope_label: "plan launch-demo".into(),
            harness: "papercup".into(),
            plan: "launch-demo".into(),
            brief: "launch test".into(),
            name: "pui-launch-demo".into(),
            count: 3,
            agent: "codex".into(),
            model: "default".into(),
            account: "default".into(),
            carry: "warm".into(),
            headless: false,
            field: FleetLauncherField::Name,
            editing: false,
            preview_loading: false,
            launching: false,
            preview: Some(serde_json::json!({
                "familyScopeIncomplete": true,
                "counts": { "proposedClaimable": 2, "retained": 0, "newlyAdmitted": 2, "newlyExcluded": 1 },
                "newlyAdmitted": [{ "id": "WI-1" }, { "id": "WI-2" }],
                "newlyExcluded": [{ "id": "WI-9" }]
            })),
            status: Some("preview ready · y confirms launch".into()),
        });

        let text = render(&app, 160, 45);
        assert!(text.contains("Fleet launcher"));
        assert!(text.contains("account   default"));
        assert!(text.contains("model     default"));
        assert!(text.contains("carry     warm"));
        assert!(text.contains("headless  false"));
        assert!(text.contains("1 ready/unclaimed · DAG depth 2 · requested 3"));
        assert!(text.contains("3 agents against 1 executable items, 2 will idle"));
        assert!(text.contains("admits      WI-1, WI-2"));
        assert!(text.contains("excludes    WI-9"));
        assert!(text.contains("issue-family-only"));
        assert!(text.contains("y CONFIRM LAUNCH"));
    }

    #[test]
    fn plans_tab_plan_detail_popup_renders() {
        // Owner ask 2026-06-15 #1: the Plans tab's Enter→popup renders the
        // selected plan's full detail via the shared `draw` path.
        let mut app = App::new();
        app.tab = Tab::Plans;
        let mut p = plan("plan-popup-demo", "active");
        p.item_counts = crate::models::ItemCounts {
            todo: 2,
            wip: 1,
            done: 4,
            ..Default::default()
        };
        app.set_plans(vec![p]);
        app.fleet_detail_open = true;
        let text = render(&app, 120, 30);
        assert!(text.contains("Esc close"), "popup title missing: {text}");
        assert!(
            text.contains("plan-popup-demo"),
            "plan slug missing from popup"
        );
        assert!(text.contains("progress"), "progress row missing from popup");
        assert!(
            text.contains("remaining"),
            "remaining count missing from popup"
        );
    }

    #[test]
    fn fleet_plan_detail_popup_renders_selected_plan() {
        // Owner ask 2026-06-15: the plan-progress panel's Enter opens a detail
        // popup. Verify the popup chrome + plan_detail_lines render together via
        // the real `draw` path (not just the pure line builder).
        use crate::fleet::FleetPanel;
        let mut app = App::new();
        app.tab = Tab::Fleet;
        let mut p = plan("plan-detail-demo", "active");
        p.item_counts = crate::models::ItemCounts {
            todo: 4,
            wip: 1,
            done: 3,
            ..Default::default()
        };
        app.set_plans(vec![p]);
        app.fleet.fleet_focus = FleetPanel::PlanProgress;
        app.fleet_detail_open = true;
        let text = render(&app, 120, 30);
        assert!(text.contains("Esc close"), "popup title missing: {text}");
        assert!(
            text.contains("plan-detail-demo"),
            "plan slug missing from popup"
        );
        assert!(text.contains("progress"), "progress row missing from popup");
        assert!(
            text.contains("remaining"),
            "remaining count missing from popup"
        );
    }

    // --- Overview dashboard (Brief 23, overview-dashboard-2026-06-05) ---

    fn overview_attention(id: &str, tier: &str) -> crate::models::AttentionItem {
        crate::models::AttentionItem {
            id: id.into(),
            kind: "plan-item".into(),
            source: "plan".into(),
            harness_slug: Some("papercup".into()),
            plan_slug: Some("overview-dashboard".into()),
            item_ref: Some("P-001".into()),
            title: format!("decide {id}"),
            body: None,
            status: "todo".into(),
            importance: None,
            needs_human: tier == "decision",
            tier: Some(tier.into()),
            owner_agent_id: None,
            owner_label: None,
            triage_state: None,
            triage_note: None,
            report: None,
            actions: Vec::new(),
            reference: serde_json::Value::Null,
        }
    }

    #[test]
    fn overview_renders_topbar_tiles_and_operator_strip() {
        use crate::models::{ActivityRow, ItemCounts};
        let mut app = App::new();
        app.tab = Tab::Overview;
        let mut p = plan("overview-dashboard", "active");
        p.item_counts = ItemCounts {
            todo: 1,
            wip: 1,
            done: 2,
            ..Default::default()
        };
        app.set_plans(vec![p, plan("shipped-one", "shipped")]);
        app.set_inbox(vec![
            overview_attention("d1", "decision"),
            overview_attention("a1", "alert"),
            overview_attention("ac1", "activity"),
        ]);
        app.set_roster(vec![presence_entry("claude", "building the overview")]);
        app.fleet.activity.push(ActivityRow {
            id: "1".into(),
            owner_id: "su-1".into(),
            agent: Some("claude".into()),
            harness_slug: Some("papercup".into()),
            kind: "tool".into(),
            tool_name: None,
            summary: Some("✎ edited ui.rs".into()),
            status: None,
            detail: None,
            created_at: "2026-06-05".into(),
        });

        let text = render(&app, 120, 32);
        // Top bar: no account/fleet reads seeded here → explicit connecting +
        // unknown agent slots, plus the LIVE alert-tier count.
        assert!(text.contains("acct"), "topbar accounts slot missing");
        assert!(text.contains("ag"), "topbar agent-count slot missing");
        assert!(
            text.contains("connecting"),
            "pre-fetch topbar state missing"
        );
        assert!(text.contains("1 alerts"), "alert count missing");
        // Plans tile: shipped plans excluded; progress off item_counts (2 done
        // of 4 active — dropped/unknown excluded from the denominator).
        assert!(
            text.contains("Plans (1)"),
            "plans tile header wrong: {text:?}"
        );
        assert!(text.contains("Title overview-dashboard"));
        assert!(text.contains("2/4"), "plan progress fraction missing");
        // Needs-you tile: ONLY the decision tier (alert/activity stay out).
        assert!(
            text.contains("Needs you (1)"),
            "needs-you should count decisions only"
        );
        assert!(text.contains("decide d1"));
        assert!(
            !text.contains("decide ac1"),
            "activity-tier item leaked into needs-you"
        );
        // Agents tile: live roster + what each is doing.
        assert!(text.contains("Agents (1 live)"));
        assert!(text.contains("building the overview"));
        // Activity tile: server-enriched summary rows.
        assert!(text.contains("edited ui.rs"));
        // Pipeline tile: loading is explicit until the first registered-cell
        // read lands; absence is never painted as an all-clear.
        assert!(text.contains("Pipeline · live cells"));
        assert!(text.contains("Pipeline state loading"));
        // Operator strip at the bottom (Brief 24's render-only dock, D-008).
        assert!(
            text.contains("press i to talk to this agent"),
            "operator strip missing"
        );
    }

    #[test]
    fn overview_narrow_stack_and_short_terminal_drop_strip() {
        let mut app = App::new();
        app.tab = Tab::Overview;
        app.set_plans(vec![plan("p1", "active")]);
        // Narrow (80 cols): the 1×4 stack still renders every tile.
        let narrow = render(&app, 80, 30);
        assert!(narrow.contains("Plans"));
        assert!(narrow.contains("Needs you"));
        assert!(narrow.contains("Agents"));
        assert!(narrow.contains("Activity"));
        // Short terminal (<24 body rows): the operator strip yields to the
        // tiles; the operator stays reachable via the tab / `o` dock.
        let short = render(&app, 120, 18);
        assert!(short.contains("Plans"));
        assert!(!short.contains("press i to talk to this agent"));
    }

    #[test]
    fn overview_topbar_renders_account_burn_and_live_fleet_rate() {
        use crate::models::{FleetRateFleet, FleetRateStatus};
        use crate::session_config::{AccountBurnVerdict, AccountRow, ProviderPoolVerdict};
        let mut app = App::new();
        app.tab = Tab::Overview;
        // Before the read-model lands: dashes + the connecting hint.
        let connecting = render(&app, 120, 30);
        assert!(connecting.contains("connecting"));
        // Live: canonical provider rollup + pacing projection, then live agent
        // count and rate-governed dispatch in/eff/max.
        let mut s = FleetRateStatus::default();
        s.config.max_simultaneous_agents = 6;
        s.fleet = FleetRateFleet {
            cap: 6,
            in_flight: 3,
            live_agents: 165,
            effective: 4,
            floor: 1,
        };
        app.fleet_rate = Some(s);
        app.account_pool_verdicts = vec![ProviderPoolVerdict {
            total: 4,
            serviceable: 2,
            walled_fresh: 1,
            unknown: 1,
            pacing: 1,
        }];
        app.account_rows = vec![AccountRow {
            id: "acct-1".into(),
            burn: Some(AccountBurnVerdict {
                action: "throttle".into(),
                disposition: "pacing-projection".into(),
                projected_exhaustion_at: Some(now_epoch_ms() + 90 * 60_000),
            }),
            ..Default::default()
        }];
        let text = render(&app, 120, 30);
        assert!(text.contains("2/4 svc"), "serviceable rollup missing");
        assert!(text.contains("1 walled"), "measured wall count missing");
        assert!(text.contains("1 unk"), "unknown count missing");
        assert!(
            text.contains("burn 1 pace@2h"),
            "burn disposition/horizon missing"
        );
        assert!(!text.contains("spend"), "retired spend stub still rendered");
        assert!(text.contains("ag 165"), "live agent count missing");
        assert!(text.contains("dsp 3/e4/m6"), "dispatch in/eff/max missing");
        assert!(text.contains("+/-"), "edit hint missing");
        assert!(!text.contains("connecting"));
    }

    #[test]
    fn overview_pipeline_tile_preserves_value_unknown_and_absent() {
        use crate::models::{
            PipelineCellRead, PipelineStatus, StateCellAssessment, StateCellRead, StateCellUnknown,
        };
        let value = |cell: &str, value: serde_json::Value, code: Option<&str>| PipelineCellRead {
            cell: cell.into(),
            read: Some(StateCellRead {
                status: "value".into(),
                cell: cell.into(),
                value,
                assessment: code.map(|code| StateCellAssessment {
                    status: "resolved".into(),
                    code: Some(code.into()),
                }),
                unknown: None,
            }),
            error: None,
        };
        let mut app = App::new();
        app.tab = Tab::Overview;
        app.pipeline_status = Some(PipelineStatus {
            gate_verdict: value(
                "gate.greenCheckpoint.verdict",
                serde_json::json!(0),
                Some("passing-buffered"),
            ),
            frozen_candidate: value(
                "gate.greenCheckpoint.candidate",
                serde_json::json!("abcdef1234567890"),
                Some("active-candidate"),
            ),
            main_behind_staging: PipelineCellRead {
                cell: "git.mainBehindStaging".into(),
                read: Some(StateCellRead {
                    status: "unknown".into(),
                    cell: "git.mainBehindStaging".into(),
                    unknown: Some(StateCellUnknown {
                        code: "resolver-failed".into(),
                        detail: "probe timed out".into(),
                    }),
                    ..Default::default()
                }),
                error: None,
            },
            deployed_sha: PipelineCellRead {
                cell: "deploy.3070.sha".into(),
                read: Some(StateCellRead {
                    status: "absent".into(),
                    cell: "deploy.3070.sha".into(),
                    ..Default::default()
                }),
                error: None,
            },
        });

        let text = render(&app, 120, 32);
        assert!(
            text.contains("passing-buffered"),
            "gate assessment missing: {text}"
        );
        assert!(
            text.contains("abcdef123456"),
            "candidate sha missing: {text}"
        );
        assert!(
            text.contains("unknown:resolver-failed"),
            "unknown code must remain visible: {text}"
        );
        assert!(
            text.contains("absent"),
            "absent must remain visible: {text}"
        );
        assert!(
            !text.contains("gate green"),
            "the TUI must not infer green from zero"
        );
    }

    #[test]
    fn overview_progress_bar_is_pure_and_clamped() {
        assert_eq!(progress_bar(0, 0, 10), "··········");
        assert_eq!(progress_bar(1, 2, 10), "█████·····");
        assert_eq!(progress_bar(2, 2, 10), "██████████");
        assert_eq!(progress_bar(5, 2, 10), "██████████"); // over-done clamps
    }

    #[test]
    fn mic_meter_scales_and_is_fixed_width() {
        // 12 cells + 2 brackets = 14 chars, always.
        assert_eq!(mic_meter(0.0).chars().count(), 14);
        assert_eq!(mic_meter(5.0).chars().count(), 14);
        assert_eq!(mic_meter(0.0), "[············]");
        // Full scale at level 0.25 (the 4× gain ceiling).
        assert_eq!(mic_meter(0.25), "[▮▮▮▮▮▮▮▮▮▮▮▮]");
        assert!(mic_meter(0.05).contains('▮')); // quiet speech still registers
        assert!(mic_meter(0.05).contains('·'));
    }

    #[test]
    fn voice_recording_shows_meter_in_composer() {
        use crate::app::VoicePhase;
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.voice_phase = VoicePhase::Recording;
        app.voice_level = 0.2;
        let text = render(&app, 90, 16);
        assert!(text.contains("REC"), "recording badge missing: {text:?}");
        assert!(text.contains('▮'), "mic meter missing");
    }

    #[test]
    fn voice_idle_hint_mentions_v_to_speak() {
        let mut app = App::new();
        app.tab = Tab::Operator;
        // Idle hint advertises BOTH voice modes (PTT + the realtime session,
        // voice-realtime-tui-2026-06-05).
        let text = render(&app, 90, 16);
        assert!(text.contains("v PTT"));
        assert!(text.contains("V realtime voice"));
    }

    #[test]
    fn convai_live_composer_shows_realtime_badge() {
        // The realtime session replaces the composer with its status line
        // (voice-realtime-tui-2026-06-05 P-007).
        use crate::app::ConvAiPhase;
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.convai_phase = ConvAiPhase::Live;
        let text = render(&app, 140, 16);
        assert!(text.contains("● voice"), "live badge missing");
        assert!(text.contains("V stops"), "stop hint missing");
        app.convai_phase = ConvAiPhase::Connecting;
        assert!(
            render(&app, 100, 16).contains("◐ voice…"),
            "connecting badge missing"
        );
    }

    #[test]
    fn voice_speaking_phase_badge_renders() {
        use crate::app::VoicePhase;
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.voice_phase = VoicePhase::Speaking;
        assert!(render(&app, 90, 16).contains("speaking"));
    }

    #[test]
    fn plans_view_renders_list_and_detail() {
        let mut app = App::new();
        app.tab = Tab::Plans; // the default landing tab is now Operator
        app.set_plans(vec![
            plan("alpha-2026", "todo"),
            plan("beta-2026", "shipped"),
        ]);
        let text = render(&app, 90, 16);
        assert!(text.contains("Plans (2)"));
        assert!(text.contains("alpha-2026"));
        assert!(text.contains("Detail"));
        assert!(text.contains("Title alpha-2026")); // selected plan detail
        assert!(text.contains("papercup"));
    }

    /// P-032: the Plans tab is a three-column GOALS → PLANS → ITEMS spine. The
    /// goals column leads with the "(all)" pseudo-row and each goal row rolls
    /// up its scoped plan count + done/total item progress.
    #[test]
    fn plans_spine_renders_goals_column_with_rollup_and_all_row() {
        use crate::models::{GoalPotChip, GoalSummary};
        let mut app = App::new();
        app.tab = Tab::Plans;
        let mut p1 = plan("alpha-2026", "wip");
        p1.item_counts.done = 2;
        p1.item_counts.todo = 1;
        let p2 = plan("beta-2026", "todo");
        app.set_plans(vec![p1, p2]);
        app.goals = vec![GoalSummary {
            id: "g1".into(),
            title: "Ship".into(),
            status: "active".into(),
            pots: vec![GoalPotChip {
                harness_slug: "papercup".into(),
                ..Default::default()
            }],
            ..Default::default()
        }];
        let text = render(&app, 140, 20);
        assert!(text.contains("Goals (1)"));
        assert!(text.contains("(all)"));
        assert!(text.contains("2 plans")); // the "(all)" row's scope count
                                           // The goal's rollup: both fixture plans sit in its pot, 2 done of 3.
        assert!(text.contains("Ship"));
        assert!(text.contains("2p 2/3"));
        assert!(text.contains("Plans (2)"));
    }

    /// P-032: selecting a goal scopes the plans column to the plans of its
    /// pots (the GoalPotChip.harness_slug join); the "(all)" row un-scopes.
    #[test]
    fn plans_spine_goal_selection_scopes_the_plans_column() {
        use crate::models::{GoalPotChip, GoalSummary};
        let mut app = App::new();
        app.tab = Tab::Plans;
        let mut other = plan("other-plan", "todo");
        other.harness = Some("elsewhere".into());
        app.set_plans(vec![plan("alpha-2026", "wip"), other]);
        app.goals = vec![GoalSummary {
            id: "g1".into(),
            title: "Ship".into(),
            status: "active".into(),
            pots: vec![GoalPotChip {
                harness_slug: "papercup".into(),
                ..Default::default()
            }],
            ..Default::default()
        }];
        assert_eq!(app.visible_plans().len(), 2); // "(all)" leaves both
        app.goal_sel = 1; // select the goal
        let scoped = app.visible_plans();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].slug, "alpha-2026");
        let text = render(&app, 140, 20);
        assert!(text.contains("Plans (1)"));
        assert!(!text.contains("other-plan"));
    }

    /// P-032: the plans column carries the working-agent badge (online roster
    /// members declaring the plan) and the items pane a context-pressure
    /// column joined from the fleet assignments via the claim-owner id.
    #[test]
    fn plans_spine_agent_badge_and_item_pressure_render() {
        use crate::models::{BeeAssignment, PlanItemState, PlanItemStates, RosterEntry};
        let mut app = App::new();
        app.tab = Tab::Plans;
        app.set_plans(vec![plan("my-plan", "wip")]);
        app.roster = vec![RosterEntry {
            owner_id: "su-worker".into(),
            session_state: Some("live".into()),
            current_plan_slug: Some("my-plan".into()),
            ..Default::default()
        }];
        app.fleet.all_assignments = vec![BeeAssignment {
            agent_id: "su-worker".into(),
            context_pressure: Some("critical".into()),
            ..Default::default()
        }];
        app.set_plan_item_states(PlanItemStates {
            harness: "papercup".into(),
            plan: "my-plan".into(),
            harness_liveness_mode: "activity".into(),
            items: vec![PlanItemState {
                item_id: "P-001".into(),
                disposition: "active".into(),
                claim_owner_id: Some("su-worker".into()),
                claim_owner_name: Some("worker".into()),
                ..Default::default()
            }],
        });
        let text = render(&app, 140, 24);
        assert!(text.contains("my-plan 0/0 (1)")); // progress + agent badge
        assert!(text.contains("press")); // the items header carries the column
        assert!(text.contains("critical")); // the holder's pressure bucket
    }

    #[test]
    fn workbench_indicator_shows_when_companion_linked() {
        use pui_companion_proto::{PaneNode, Topology};
        let mut app = App::new();
        // Hidden until the companion plugin links (P-004).
        assert!(!render(&app, 90, 12).contains("panes"));

        app.companion_version = Some("0.1.0".into());
        app.topology = Some(Topology {
            tabs: vec![],
            panes: vec![
                PaneNode {
                    id: 1,
                    tab: 0,
                    title: "claude".into(),
                    focused: true,
                    is_plugin: false,
                    exited: false,
                    command: None,
                },
                PaneNode {
                    id: 2,
                    tab: 0,
                    title: "pui".into(),
                    focused: false,
                    is_plugin: false,
                    exited: false,
                    command: None,
                },
            ],
        });
        let text = render(&app, 90, 12);
        assert!(text.contains(crate::glyph::nav::PANES));
        assert!(text.contains("2 panes"));
    }

    #[test]
    fn brew_view_renders_roster_and_dossier() {
        // The Sessions roster + dossier folded into Fleet (D-002b): the Fleet
        // (Fleet) tab shows the agent list + a dossier for the selected agent,
        // including its open files.
        let mut app = App::new();
        app.tab = Tab::Fleet;
        app.show_presence = false; // full width for the dashboard
        app.set_roster(vec![RosterEntry {
            owner_id: "su-1".into(),
            label: "su · su-1".into(),
            intent: None,
            current_files: vec!["a.rs".into()],
            liveness: "live".into(),
            stale: false,
            agent: Some("claude".into()),
            role: Some("worker".into()),
            feature: None,
            current_plan_slug: None,
            heartbeat_at: None,
            ..Default::default()
        }]);
        // Default (no selection): the whole-fleet task list leads (#2).
        let text = render(&app, 120, 40);
        assert!(text.contains("Fleet")); // headline
        assert!(text.contains("Agents (1)"));
        assert!(text.contains("claude"));
        assert!(text.contains("fleet task list"));
        // Selecting a bee swaps in ITS dossier (the bee tasklist).
        app.bee
            .set_selection(Some("su-1".into()), Some("claude".into()));
        app.bee.set_dossier(
            "su-1",
            Some(crate::models::BeeAssignment {
                agent_id: "su-1".into(),
                intent: "porting handlers".into(),
                load: 1,
                queued: vec![crate::models::BeeWorkItem {
                    id: "WI-1".into(),
                    title: "port the handler".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            None,
        );
        let text = render(&app, 120, 40);
        assert!(text.contains("task list (1 claimed)"));
        assert!(text.contains("port the handler"));
    }

    #[test]
    fn inbox_view_renders_items_and_preview() {
        use crate::models::AttentionItem;
        let mut app = App::new();
        app.tab = Tab::Inbox;
        app.show_presence = false; // keep the compact Inbox title fully visible
        app.set_inbox(vec![AttentionItem {
            id: "coord:esc:9".into(),
            kind: "coord-escalation".into(),
            source: "coord".into(),
            harness_slug: None,
            plan_slug: Some("my-plan".into()),
            item_ref: Some("P-002".into()),
            title: "Needs a human decision".into(),
            body: Some("Details of the escalation.".into()),
            status: "needs-human".into(),
            // Importance is a canonical string level on the live attention
            // wire (urgent/high/normal/low); this renderer fixture does not
            // display it, so keep the value absent while model.rs owns the
            // live-shape decode coverage.
            importance: None,
            needs_human: true,
            tier: Some("decision".into()),
            owner_agent_id: None,
            owner_label: None,
            triage_state: None,
            triage_note: None,
            report: None,
            actions: Vec::new(),
            reference: serde_json::Value::Null,
        }]);
        let text = render(&app, 100, 28);
        assert!(text.contains("Inbox"));
        // Needs-you is the landing facet; Tab reaches the complete feed.
        assert!(text.contains("Needs you (1) · [Tab] All"));
        assert!(text.contains("Decisions (1)")); // the Decisions tier section header
        assert!(text.contains("needs-human"));
        assert!(text.contains("my-plan/P-002"));
        assert!(text.contains("coord-escalation")); // preview
        assert!(text.contains("Details of the escalation")); // body in preview
        assert!(text.contains("tier:")); // preview shows the tier line
    }

    #[test]
    fn inbox_renders_four_tier_sections() {
        // inbox-tiering D-006: items group into Decisions ▸ Handled ▸ Alerts ▸
        // Activity sections, each with a header + count.
        use crate::models::AttentionItem;
        let mk = |id: &str, tier: &str, needs_human: bool| AttentionItem {
            id: id.into(),
            kind: "coord-message".into(),
            source: "coord".into(),
            harness_slug: Some("papercup".into()),
            plan_slug: None,
            item_ref: None,
            title: format!("item {id}"),
            body: None,
            status: "message".into(),
            importance: None,
            needs_human,
            tier: Some(tier.into()),
            owner_agent_id: Some("su-worker".into()),
            owner_label: Some("worker".into()),
            triage_state: if tier == "handled" {
                Some("downgraded".into())
            } else {
                None
            },
            triage_note: if tier == "handled" {
                Some("auto lifecycle, not a decision".into())
            } else {
                None
            },
            report: None,
            actions: Vec::new(),
            reference: serde_json::Value::Null,
        };
        let mut app = App::new();
        app.tab = Tab::Inbox;
        app.inbox_focus = InboxFocus::Attention;
        app.show_presence = false; // assert the title + badge, not sidebar clipping
        app.set_inbox(vec![
            mk("d1", "decision", true),
            mk("h1", "handled", false),
            mk("a1", "alert", false),
            mk("v1", "activity", false),
            mk("v2", "activity", false),
        ]);
        let text = render(&app, 110, 30);
        // All four tier sections render with their counts.
        assert!(text.contains("Decisions (1)"));
        assert!(text.contains("Handled by operator (1)"));
        assert!(text.contains("Alerts (1)"));
        assert!(text.contains("Activity (2)"));
        // The title names the Attention sub-view on screen, advertises the
        // Tab key that reaches Threads, and headlines the Decisions count.
        assert!(text.contains("Inbox · All (5) · [Tab] Threads"));
    }

    fn presence_entry(agent: &str, intent: &str) -> RosterEntry {
        RosterEntry {
            owner_id: "su-1".into(),
            label: "su · su-1".into(),
            intent: if intent.is_empty() {
                None
            } else {
                Some(intent.into())
            },
            current_files: vec![],
            liveness: "live".into(),
            stale: false,
            agent: Some(agent.into()),
            role: Some("worker".into()),
            feature: None,
            current_plan_slug: None,
            heartbeat_at: None,
            ..Default::default()
        }
    }

    #[test]
    fn presence_sidebar_renders_when_wide() {
        let mut app = App::new(); // Plans tab — so the only roster render is the sidebar
        app.set_roster(vec![presence_entry("claude", "porting tui")]);
        let text = render(&app, 160, 12);
        assert!(text.contains("Presence 1/1"));
        assert!(text.contains("claude"));
        assert!(text.contains("porting tui")); // intent shown in the sidebar
    }

    /// PUBLIC_RELEASE_UX.md compact band (80–159 columns): one primary surface
    /// at a time, so the sidebar never squeezes the body, even when toggled on.
    #[test]
    fn presence_sidebar_stays_out_of_the_compact_band() {
        let mut app = App::new();
        app.show_presence = true;
        app.set_roster(vec![presence_entry("claude", "porting tui")]);
        for width in [80, 120, 159] {
            assert!(
                !render(&app, width, 24).contains("Presence 1/1"),
                "{width} cols"
            );
        }
    }

    #[test]
    fn presence_sidebar_hidden_when_toggled_off() {
        let mut app = App::new();
        app.show_presence = false;
        app.set_roster(vec![presence_entry("ghostxyz", "secret")]);
        let text = render(&app, 100, 12); // Plans tab doesn't render the roster itself
        assert!(!text.contains("Presence "));
        assert!(!text.contains("ghostxyz"));
    }

    #[test]
    fn tab_strip_shows_leading_tabs() {
        // The lead tabs after the D-002 reorder: Operator, Inbox, Plans. (At a
        // narrow width the Tabs widget truncates the tail.)
        let app = App::new();
        let text = render(&app, 60, 8);
        assert!(text.contains("Agent Chat"));
        assert!(text.contains("Inbox"));
        assert!(text.contains("Plans"));
    }

    /// Hive lexicon (pui-hive-lexicon-2026-06-06): with the-hive active the tab
    /// strip shows internal skin labels except Agent Chat, whose product name
    /// stays explicit (Fleet→Colony,
    /// Pots→Hives, Nodes→Swarm, Cupboard→Comb); other tabs are unchanged.
    #[test]
    fn tab_strip_uses_the_hive_lexicon_when_active() {
        use crate::models::{LexiconPackPayload, TermForms};
        use std::collections::HashMap;
        let mut terms = HashMap::new();
        for (k, one, other) in [
            ("operator", "Sentinel", "Sentinels"),
            ("fleet", "Colony", "Colonies"),
            ("pot", "Hive", "Hives"),
            ("node", "Swarm", "Swarms"),
            ("cupboard", "Comb", "Combs"),
        ] {
            terms.insert(
                k.to_string(),
                TermForms {
                    one: one.into(),
                    other: other.into(),
                },
            );
        }
        let mut app = App::new();
        app.lexicon = crate::lexicon::Lexicon::from_payload(&LexiconPackPayload {
            pack_id: "the-hive".into(),
            label: "The Hive".into(),
            terms,
        });
        // Wide enough that the Tabs widget doesn't truncate the renamed tabs.
        let text = render(&app, 200, 8);
        assert!(text.contains("Agent Chat"), "Agent Chat stays explicit");
        assert!(text.contains("Colony"), "Fleet→Colony");
        assert!(text.contains("Hives"), "Pots→Hives");
        assert_eq!(
            Tab::Network.label(&app.lexicon),
            "Network",
            "Network keeps its public product name"
        );
        assert!(text.contains("Comb"), "Cupboard→Comb");
        // A tab with no lexicon term keeps its classic title.
        assert!(text.contains("Inbox"));
        assert!(text.contains("Plans"));
    }

    /// Flag-off / unreachable operator: the tab strip shows today's classic
    /// labels (the default empty lexicon falls back to CLASSIC).
    #[test]
    fn tab_strip_uses_classic_labels_by_default() {
        let app = App::new(); // empty lexicon = classic fallback
        let text = render(&app, 200, 8);
        assert!(text.contains("Agent Chat"));
        assert!(text.contains("Fleet"));
        assert!(text.contains("Pots"));
        assert!(text.contains("Cupboard"));
        // The bee labels must NOT appear with the flag off.
        assert!(!text.contains("Sentinel"));
        assert!(!text.contains("Colony"));
        assert!(!text.contains("Swarm"));
    }

    /// Brief 27 / P-010: buffer-level width safety for the Plans tab. Renders
    /// a plan list whose items cover every disposition glyph at 80 and 120
    /// cols; asserts no double-width symbol leaks into the frame (only
    /// `glyph::header::SET` may be wide) and the item-id column stays aligned
    /// across rows (a wide disposition glyph would shift it).
    #[test]
    fn plans_render_width_safe_and_aligned_at_80_and_120() {
        use crate::models::{PlanItemState, PlanItemStates};
        use unicode_width::UnicodeWidthStr;

        let mut app = App::new();
        app.tab = Tab::Plans;
        app.set_plans(vec![plan("my-plan", "wip")]);
        let item = |id: &str, disp: &str| PlanItemState {
            item_id: id.into(),
            disposition: disp.into(),
            assignee_name: Some("builder-1".into()),
            ..Default::default()
        };
        app.set_plan_item_states(PlanItemStates {
            harness: "papercup".into(),
            plan: "my-plan".into(),
            harness_liveness_mode: "activity".into(),
            items: vec![
                item("P-001", "pooled"),
                item("P-002", "active"),
                item("P-003", "assigned-idle"),
                item("P-004", "claimed-pooled"),
                item("P-005", "claimed-mismatch"),
            ],
        });

        for &(w, h) in &[(80u16, 24u16), (120, 24)] {
            let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
            term.draw(|f| draw(f, &app)).unwrap();
            let buf = term.backend().buffer().clone();
            let mut rows: Vec<String> = Vec::with_capacity(h as usize);
            for y in 0..h {
                let mut row = String::with_capacity(w as usize);
                for x in 0..w {
                    let sym = buf.cell((x, y)).unwrap().symbol();
                    if UnicodeWidthStr::width(sym) > 1 {
                        assert!(
                            crate::glyph::header::SET.contains(&sym),
                            "width-2 symbol {sym:?} leaked into the Plans frame \
                             at ({x},{y}) width {w}"
                        );
                    }
                    row.push_str(sym);
                }
                rows.push(row);
            }
            let cols: Vec<usize> = rows.iter().filter_map(|r| r.find("P-00")).collect();
            assert!(
                cols.len() >= 5,
                "expected 5 item rows at width {w}, got {cols:?}"
            );
            assert!(
                cols.windows(2).all(|p| p[0] == p[1]),
                "item-id column drifted at width {w}: {cols:?}"
            );
        }
    }

    #[test]
    fn plans_view_renders_item_assignment_claim_liveness() {
        use crate::models::{PlanItemState, PlanItemStates};
        let mut app = App::new();
        app.tab = Tab::Plans;
        app.set_plans(vec![plan("my-plan", "wip")]);
        app.set_plan_item_states(PlanItemStates {
            harness: "papercup".into(),
            plan: "my-plan".into(),
            harness_liveness_mode: "activity".into(),
            items: vec![
                PlanItemState {
                    item_id: "P-001".into(),
                    disposition: "pooled".into(),
                    ..Default::default()
                },
                PlanItemState {
                    item_id: "P-002".into(),
                    disposition: "active".into(),
                    assignee_name: Some("builder-1".into()),
                    claim_owner_name: Some("builder-1".into()),
                    claim_liveness_mode: Some("activity".into()),
                    claim_intent: Some("building it".into()),
                    ..Default::default()
                },
            ],
        });
        let text = render(&app, 150, 22);
        assert!(text.contains("Items (2)"));
        assert!(text.contains("liveness: activity")); // the harness-level split
        assert!(text.contains("P-001"));
        assert!(text.contains("pooled"));
        assert!(text.contains("P-002"));
        assert!(text.contains("active"));
        assert!(text.contains("builder-1")); // who's on it

        // States for a DIFFERENT plan must NOT render against this selection.
        app.set_plan_item_states(PlanItemStates {
            plan: "other-plan".into(),
            items: vec![PlanItemState {
                item_id: "Z-9".into(),
                disposition: "pooled".into(),
                ..Default::default()
            }],
            ..Default::default()
        });
        let text2 = render(&app, 150, 22);
        assert!(!text2.contains("Z-9"));
    }

    #[test]
    fn config_renders_settings_flags() {
        let mut app = App::new();
        let mut m = std::collections::BTreeMap::new();
        m.insert("papercusp-oracle".to_string(), false);
        m.insert("papercusp-snapshots".to_string(), true);
        app.set_flags(crate::models::FlagsResponse {
            flags: m,
            source: "defaults".into(),
        });
        app.tab = Tab::Config;
        // Config stacks the operator overview above the retained flags renderer.
        let text = render(&app, 90, 44);
        assert!(text.contains("feature flags"));
        assert!(text.contains("papercusp-oracle"));
        assert!(text.contains("[x]"));
        assert!(text.contains("[ ]"));
        assert!(text.contains("defaults"));
    }

    #[test]
    fn config_renders_operator_config_overview() {
        use crate::models::{AgentConfigInner, AgentConfigResponse, OperatorConfig};
        let mut app = App::new();
        app.tab = Tab::Config;
        let mut models = std::collections::BTreeMap::new();
        models.insert("worker".to_string(), "opus".to_string());
        let mut surf = std::collections::BTreeMap::new();
        surf.insert("operator".to_string(), "sonnet".to_string());
        app.set_operator_config(OperatorConfig {
            agent: Some(AgentConfigResponse {
                config: AgentConfigInner {
                    backend: "claude-code".into(),
                    cmd: "claude -p".into(),
                    models,
                    surface_models: surf,
                },
                effective_backend: "claude-code".into(),
                binaries: Default::default(),
                effective_tiers: Vec::new(),
                effort_levels: Vec::new(),
                launchable_modes: Vec::new(),
            }),
            providers: vec![("openai".into(), true), ("elevenlabs".into(), false)],
            ..Default::default()
        });
        let text = render(&app, 100, 22);
        assert!(text.contains("operator config")); // the section header
        assert!(text.contains("claude-code")); // backend
        assert!(text.contains("worker=opus")); // per-role model
        assert!(text.contains("operator=sonnet")); // per-surface model
        assert!(text.contains("openai")); // a connected-provider marker
    }

    fn ui_notif(level: &str, msg: &str, harness: Option<&str>) -> Notif {
        Notif {
            level: level.into(),
            message: msg.into(),
            harness: harness.map(|s| s.into()),
            ts: None,
        }
    }

    #[test]
    fn inbox_badge_and_toast_render() {
        let mut app = App::new();
        app.notify_enabled = true; // the transient toast only pops when enabled
        app.unseen_notifs = 2;
        app.toast = Some(ui_notif("high", "Decide P-002", None));
        let text = render(&app, 90, 12);
        assert!(text.contains("Inbox (2)")); // badge on the tab strip
        assert!(text.contains("🔔")); // toast box title
        assert!(text.contains("Decide P-002")); // toast message
    }

    #[test]
    fn muted_by_default_suppresses_toast_but_keeps_badge() {
        // notify_enabled defaults to false (owner ask 2026-06-14): the transient
        // toast must not render, but the Inbox badge — a separate surface — stays.
        let mut app = App::new();
        app.unseen_notifs = 2;
        app.toast = Some(ui_notif("high", "Decide P-002", None));
        let text = render(&app, 90, 12);
        assert!(text.contains("Inbox (2)")); // badge unaffected by the mute
        assert!(!text.contains("Decide P-002")); // toast suppressed
    }

    #[test]
    fn notifs_history_overlay_renders() {
        let mut app = App::new();
        app.show_notifs = true;
        app.notifs = vec![
            ui_notif("error", "build failed", Some("papercup")),
            ui_notif("high", "needs you", None),
        ];
        let text = render(&app, 90, 16);
        assert!(text.contains("Notifications (2)"));
        assert!(text.contains("build failed"));
        assert!(text.contains("[papercup]"));
    }

    #[test]
    fn notifs_history_renders_in_pinned_panes() {
        // Owner report 2026-06-11: in the zellij dock the alert toast flashed
        // but 'N' opened an overlay that never drew — the pinned render path
        // skipped draw_notifs. Pin it.
        let mut app = App::new();
        app.pinned = Some(crate::app::Tab::Wake);
        app.tab = crate::app::Tab::Wake;
        app.show_notifs = true;
        app.notifs = vec![ui_notif("error", "bee crashed", None)];
        let text = render(&app, 90, 16);
        assert!(
            text.contains("Notifications (1)"),
            "pinned pane must render the history: {text}"
        );
        assert!(text.contains("bee crashed"));
    }

    #[test]
    fn toast_title_advertises_the_history_key() {
        let mut app = App::new();
        app.notify_enabled = true; // the transient toast only pops when enabled
        app.pinned = Some(crate::app::Tab::Wake);
        app.tab = crate::app::Tab::Wake;
        app.toast = Some(ui_notif("high", "Decide P-009", None));
        let text = render(&app, 90, 12);
        assert!(text.contains("N history"), "toast must advertise N: {text}");
    }

    #[test]
    fn a_long_session_error_wraps_so_its_recovery_hint_stays_visible() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Operator;
        app.agent_chat_id = Some("chat-1".into());
        app.set_su_session_binding(crate::su_session::SuSessionBinding {
            operation: "created".into(),
            backend: crate::su_session::SuSessionBackend::Claude,
            adv_session_id: 7,
            owner_id: Some("su-1".into()),
            workspace_id: Some("ws-1".into()),
            harness_slug: Some("papercup".into()),
            plan_slug: None,
            native_session: None,
        });
        app.su_session.as_mut().unwrap().error = Some(
            "Claude ended this turn without a usable reply (success): API Error: 401 \
             authentication_error: OAuth token has expired · Please run /login"
                .into(),
        );
        let text = render(&app, 100, 30);
        assert!(text.contains("401"), "{text}");
        assert!(
            text.contains("/login"),
            "the recovery hint was cut off: {text}"
        );
    }

    #[test]
    fn su_reconnect_refusal_stays_visible_without_a_pending_owner_turn() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Operator;
        app.agent_chat_id = Some("saved-chat".into());
        app.update(crate::event::Event::SuSessionError(
            "The native transcript is unavailable or still being restored".into(),
        ));
        app.last_error = None;
        let text = render(&app, 100, 24);
        assert!(text.contains("native transcript is unavailable"), "{text}");
        assert!(text.contains("choose session to reconnect"), "{text}");
        app.reset_agent_chat_binding();
        assert!(!render(&app, 100, 24).contains("native transcript is unavailable"));
    }

    #[test]
    fn su_launch_refusal_stays_visible_with_the_draft_after_background_success() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Operator;
        app.chat_composing = true;
        app.chat_input = "keep this draft".into();
        app.update(crate::event::Event::Key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Enter,
            crossterm::event::KeyModifiers::NONE,
        )));
        app.update(crate::event::Event::SuSessionError(
            "Codex model is required. Select a model with Esc then m, and retry.".into(),
        ));
        app.last_error = None;
        let text = render(&app, 100, 24);
        assert!(text.contains("keep this draft"), "{text}");
        assert!(text.contains("Codex model is required"), "{text}");
        assert!(text.contains("Esc then m"), "{text}");
        assert!(text.contains("Enter retries"), "{text}");
    }

    /// WI-10004164: the workbench's details view shows raw errors, but a
    /// start the operator refused still leads with the plain sentence that
    /// names the owner's next step; the raw code stays beneath it.
    #[test]
    fn workbench_refused_start_leads_with_the_plain_sentence() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Operator;
        app.chat_composing = true;
        app.chat_input = "keep this draft".into();
        app.update(crate::event::Event::Key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Enter,
            crossterm::event::KeyModifiers::NONE,
        )));
        app.update(crate::event::Event::SuSessionRefused {
            code: "attached_engine_start_failed".into(),
            message: "OMP default account cannot use gateway model 'papercusp-gateway/x'; choose auto or a named gateway account.".into(),
        });
        app.last_error = None;
        assert!(app.chat_details_visible());
        let text = render(&app, 160, 30);
        assert!(text.contains("keep this draft"), "{text}");
        let sentence = text
            .find("could not start: OMP default account cannot use gateway model")
            .unwrap_or_else(|| panic!("no plain sentence:\n{text}"));
        let raw = text
            .find("attached_engine_start_failed")
            .unwrap_or_else(|| panic!("no raw code in details:\n{text}"));
        assert!(sentence < raw, "{text}");
    }

    #[test]
    fn agent_ctx_panes_render_brief_mail_work() {
        use crate::app::AgentCtxMode;
        let mut app = App::new();
        app.pinned = Some(crate::app::Tab::AgentCtx);
        app.tab = crate::app::Tab::AgentCtx;

        // Prompt mode: brief led first, recorded full prompt below.
        app.agent_ctx_mode = AgentCtxMode::Prompt;
        app.agent_ctx = Some(Ok(crate::models::AgentCtxData {
            owner: Some("s-17".into()),
            label: Some("bee-7".into()),
            brief: Some("Watch for the flaky sync test".into()),
            prompt: Some("You are a bee.\nDo the work.".into()),
            source: Some("recorded".into()),
            model: Some("opus:high".into()),
            tier: Some("deep".into()),
            ..Default::default()
        }));
        let text = render(&app, 80, 16);
        assert!(text.contains("brief"));
        assert!(text.contains("bee-7"));
        assert!(text.contains("Watch for the flaky sync test"));
        assert!(text.contains("opus:high"));
        assert!(text.contains("deep"));
        assert!(text.contains("recorded"));
        assert!(text.contains("You are a bee."));

        // Mail mode.
        app.agent_ctx_mode = AgentCtxMode::Mail;
        app.agent_ctx = Some(Ok(crate::models::AgentCtxData {
            owner: Some("s-17".into()),
            mail: Some(crate::models::BeeMailPayload {
                owner_id: "s-17".into(),
                inbox: crate::models::BeeMailSide {
                    total: 1,
                    entries: vec![crate::models::BeeMailEntry {
                        kind: "message".into(),
                        from: Some("queen".into()),
                        summary: Some("pick up WI-9".into()),
                        ..Default::default()
                    }],
                },
                outbox: crate::models::BeeMailSide::default(),
            }),
            ..Default::default()
        }));
        let text = render(&app, 80, 12);
        assert!(text.contains("inbox (1)"));
        assert!(text.contains("pick up WI-9"));

        // Work mode: items + plan linkage.
        app.agent_ctx_mode = AgentCtxMode::Work;
        app.agent_ctx = Some(Ok(crate::models::AgentCtxData {
            owner: Some("s-17".into()),
            assignment: Some(crate::models::BeeAssignment {
                agent_id: "s-17".into(),
                intent: "fixing the sync test".into(),
                declared_plan_slug: Some("sync-fix-2026".into()),
                queued: vec![crate::models::BeeWorkItem {
                    id: "WI-9".into(),
                    title: "deflake sync".into(),
                    status: Some("claimed".into()),
                    rank: Some(1),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        }));
        let text = render(&app, 80, 12);
        assert!(text.contains("work items (1)"));
        assert!(text.contains("WI-9"));
        assert!(text.contains("sync-fix-2026"));
        assert!(text.contains("fixing the sync test"));
    }

    #[test]
    fn error_shows_in_status_bar() {
        let mut app = App::new();
        app.last_error = Some("backend down".into());
        let text = render(&app, 60, 8);
        assert!(text.contains("backend down"));
    }

    #[test]
    fn canonical_backend_identity_and_identity_failures_are_visible() {
        use crate::client::{
            AgentChatIdentity, BackendIdentity, BuildIdentity, OperatorCapabilities, StoreIdentity,
        };
        let mut app = App::new();
        app.backend_identity = Some(BackendIdentity {
            schema_version: 1,
            endpoint: "http://127.0.0.1:3170".into(),
            selection_source: "PUI_OPERATOR".into(),
            transport: "http".into(),
            workspace_id: "papercusp-workspace".into(),
            store: StoreIdentity {
                id: "pg-123456789abc".into(),
                target: "postgresql://127.0.0.1:5432/papercusp".into(),
                source: "env".into(),
            },
            build: BuildIdentity {
                version: "0.1.0".into(),
                sha: Some("abc".into()),
            },
            agent_chat: AgentChatIdentity {
                scope: "workspace:papercusp-workspace".into(),
                route: "/api/agent-chats".into(),
            },
            capabilities: OperatorCapabilities {
                attached_su_session: true,
                attached_su_session_approvals: true,
            },
        });
        let text = render(&app, 260, 12);
        assert!(text.contains("http://127.0.0.1:3170"), "{text}");
        assert!(text.contains("pg-123456789abc"), "{text}");
        assert!(text.contains("workspace:papercusp-workspace"), "{text}");

        app.backend_identity_error = Some("operator identity: selector mismatch".into());
        let text = render(&app, 100, 12);
        assert!(text.contains("selector mismatch"), "{text}");
    }

    #[test]
    fn harnesses_view_renders_features_and_issues() {
        use crate::models::{HarnessFeature, HarnessIssue};
        let mut app = App::new();
        app.tab = Tab::Harnesses;
        app.set_features(vec![HarnessFeature {
            id: "F-001".into(),
            title: "Build X".into(),
            status: "todo".into(),
            attempts: 0,
        }]);
        app.set_issues(vec![HarnessIssue {
            id: "I-1".into(),
            title: "Crash".into(),
            severity: "major".into(),
            status: "open".into(),
            source: "validator".into(),
            found_during: None,
            linked_feature_id: Some("F-FIX-1".into()),
            attempts: 0,
        }]);
        let text = render(&app, 110, 18);
        assert!(text.contains("papercup"));
        assert!(text.contains("features (1)"));
        assert!(text.contains("F-001"));
        assert!(text.contains("Build X"));
        assert!(text.contains("issues (1)"));
        assert!(text.contains("Crash"));
        assert!(text.contains("attempts")); // feature detail pane renders
    }

    #[test]
    fn docs_view_renders_files_and_content() {
        use crate::models::DocsResponse;
        let mut app = App::new();
        app.tab = Tab::Docs;
        app.set_docs(DocsResponse {
            files: vec!["readme.md".into(), "spec/x.md".into()],
            active_path: Some("readme.md".into()),
            content: Some("# Hello docs".into()),
            entries: vec![],
            active_entry: None,
        });
        let text = render(&app, 100, 12);
        assert!(text.contains("docs (2)"));
        assert!(text.contains("readme.md"));
        assert!(text.contains("Hello docs"));
    }

    /// EI-21646357450104414 — paths were rendered through a hard-coded
    /// `trunc(p, 26)`, so a deep documentation tree became a column of
    /// indistinguishable `internal/docs/agent-i…` prefixes no matter how wide
    /// the terminal was. Two independent properties are asserted: the budget
    /// FOLLOWS the pane, and elision drops leading directories rather than the
    /// filename that identifies the doc.
    #[test]
    fn docs_paths_are_width_aware_and_elide_from_the_left() {
        let long = "internal/docs/agent-insights/derived-truth-ladder.md";
        let e = elide_left(long, 24);
        assert_eq!(e.chars().count(), 24);
        assert!(e.starts_with('…'), "{e}");
        assert!(e.ends_with("derived-truth-ladder.md"), "{e}");
        // The old helper keeps the HEAD, losing exactly the identifying tail —
        // this is the calibration that proves the assertion above is not
        // vacuously true of any truncation.
        assert!(!trunc(long, 24).ends_with("derived-truth-ladder.md"));
        assert_eq!(elide_left("short.md", 24), "short.md");

        let mut app = App::new();
        app.tab = Tab::Docs;
        app.set_docs(crate::models::DocsResponse {
            files: vec![long.to_string(), "internal/docs/design/tokens.md".into()],
            active_path: None,
            content: None,
            entries: vec![],
            active_entry: None,
        });
        // A wide terminal has budget for the whole path; a narrow one does not.
        // +40 for the Surface B dock (WI-2140985): above SURFACE_B_MIN_WIDTH the
        // cockpit takes a fixed 40 columns, so 260 leaves this assertion the same
        // 220-column body it was authored against. The negative case at 90 is
        // below the gate, gets no dock, and is unchanged.
        assert!(render(&app, 260, 12).contains(long));
        assert!(!render(&app, 90, 12).contains(long));
    }

    /// A NARROWED list must never be readable as a small documentation tree, so
    /// the title carries shown/total whenever a filter is active.
    #[test]
    fn docs_title_reports_shown_over_total_while_filtered() {
        let mut app = App::new();
        app.tab = Tab::Docs;
        app.set_docs(crate::models::DocsResponse {
            files: vec![
                "internal/docs/testing/agent-e2e.md".into(),
                "internal/docs/design/tokens.md".into(),
            ],
            active_path: None,
            content: None,
            entries: vec![],
            active_entry: None,
        });
        assert!(render(&app, 220, 12).contains("docs (2)"));

        app.docs_query = "testing".into();
        let filtered = render(&app, 220, 12);
        assert!(filtered.contains("1/2"), "{filtered}");
        assert!(!filtered.contains("tokens.md"), "{filtered}");
    }

    /// The reader pane must title itself with the doc the CURSOR is on, resolved
    /// through the filter. The needle here deliberately selects the doc at raw
    /// index 1 while `doc_sel` is 0, so a renderer that indexes `docs_files`
    /// instead of `visible_docs()` titles the pane with the wrong document —
    /// which is exactly the defect this asserts against, and which a needle
    /// matching the first entry would not expose.
    #[test]
    fn docs_reader_title_follows_the_filtered_selection() {
        let mut app = App::new();
        app.tab = Tab::Docs;
        app.set_docs(crate::models::DocsResponse {
            files: vec![
                "internal/docs/testing/agent-e2e.md".into(),
                "internal/docs/design/tokens.md".into(),
            ],
            active_path: None,
            content: None,
            entries: vec![],
            active_entry: None,
        });
        app.docs_query = "design".into();
        app.doc_sel = 0;

        let filtered = render(&app, 220, 12);
        assert!(filtered.contains("tokens.md"), "{filtered}");
        assert!(
            !filtered.contains("agent-e2e"),
            "reader title fell back to the unfiltered list: {filtered}"
        );
    }

    #[test]
    fn testing_and_config_views_render() {
        use crate::models::TestingDomain;
        let mut app = App::new();
        app.tab = Tab::Testing;
        app.set_testing(vec![TestingDomain {
            id: "unit".into(),
            label: "Unit tests".into(),
            description: "fast vitest".into(),
            tier: "universal".into(),
        }]);
        app.show_presence = false; // full width for the two-column testing layout
        let t = render(&app, 100, 8);
        assert!(t.contains("domains (1)"));
        assert!(t.contains("Unit tests"));
        assert!(t.contains("universal"));

        // The empty file pane hints at the Enter-to-load affordance (D-004a).
        assert!(t.contains("Enter on a domain loads"));

        app.tab = Tab::Config;
        // D-013: the Config tab renders the EFFECTIVE settings view — a
        // provenance line (which file keys are set) over the merged JSON.
        app.set_config(crate::models::EffectiveClaudeSettings {
            content: r#"{"permissions":{"defaultMode":"plan"}}"#.into(),
            effective: serde_json::json!({ "permissions": { "defaultMode": "plan" } }),
            file_keys: vec!["permissions".into()],
            parse_error: None,
        });
        // render() is the full frame (tab strip + body + status bar), so a short
        // height clips the Config pane to a few rows; render tall enough that the
        // deep JSON lines + the footer hint land inside the body.
        let c = render(&app, 100, 20);
        assert!(c.contains("settings.json"));
        assert!(c.contains("defaultMode"));
        assert!(c.contains("file sets: permissions"));
        // Empty file → defaults-only provenance line + the :set/:unset hint.
        app.set_config(crate::models::EffectiveClaudeSettings::default());
        let empty = render(&app, 100, 20);
        assert!(empty.contains("showing Claude Code defaults"));
        assert!(empty.contains(":set"));
    }

    #[test]
    fn memory_tab_renders_entries_states_and_composer() {
        use crate::models::MemoryEntry;
        let mut app = App::new();
        app.tab = Tab::Memory;
        app.show_presence = false;
        // Backend unavailable → the clear empty state (mem0 unconfigured today).
        let unavailable = render(&app, 110, 16);
        assert!(unavailable.contains("memory backend unavailable"));
        app.memory_load_state = crate::event::MemoryLoadState::AuthFailure {
            message: "401 principal required".into(),
        };
        let unauthorized = render(&app, 110, 16);
        assert!(unauthorized.contains("memory request unauthorized"));
        assert!(!unauthorized.contains("backend unavailable"));
        app.memory_load_state = crate::event::MemoryLoadState::TransportFailure {
            message: "connection refused".into(),
        };
        let transport = render(&app, 110, 16);
        assert!(transport.contains("memory request failed"));
        assert!(!transport.contains("backend unavailable"));
        // Available but empty.
        app.memory_available = true;
        let empty = render(&app, 110, 16);
        assert!(empty.contains("no memories stored yet"));
        // Entries render with kind + detail pane metadata.
        app.memories = vec![MemoryEntry {
            id: "m1".into(),
            memory: "user prefers rust for systems work".into(),
            metadata: Some(serde_json::json!({ "kind": "preference" })),
            score: None,
        }];
        let text = render(&app, 110, 18);
        assert!(text.contains("Memory (1)"));
        assert!(text.contains("preference"));
        assert!(text.contains("prefers rust"));
        assert!(text.contains("Detail"));
        assert!(text.contains("m1"));
        // The `/` composer overlays.
        app.memory_search_open = true;
        app.memory_search_input = "rust".into();
        let composing = render(&app, 110, 18);
        assert!(composing.contains("Search memory"));
        assert!(composing.contains("> rust"));
        // An active query titles the list with its hit count.
        app.memory_search_open = false;
        app.memory_hits = Some(("rust".into(), vec![]));
        let hits = render(&app, 110, 18);
        assert!(hits.contains("\"rust\" (0)"));
        assert!(hits.contains("no hits"));
    }

    #[test]
    fn cupboard_tab_renders_listings_filter_row_and_detail() {
        use crate::models::CupboardListing;
        let mut app = App::new();
        app.tab = Tab::Cupboard;
        // Keep the long kind/population title visible.
        app.show_presence = false;
        // Empty state first (not loading → the refetch hint).
        let empty = render(&app, 110, 16);
        assert!(empty.contains("Cupboard"));
        assert!(empty.contains("no listings"));
        // A plugin listing renders in the list + detail, with the kind row.
        app.cupboard = vec![CupboardListing {
            id: "11111111-1111-1111-1111-111111111111".into(),
            listing_kind: "plugin".into(),
            title: Some("Papercusp Worker".into()),
            description: Some("Cross-CLI activity bridge".into()),
            publisher_github_login: Some("papercupai".into()),
            ..Default::default()
        }];
        app.cupboard_total = Some(137);
        app.cupboard_next_cursor = Some("v1:50:deep".into());
        app.cupboard_kind_facets = std::collections::BTreeMap::from([
            ("app".into(), 10),
            ("harness".into(), 70),
            ("knowledge-pack".into(), 5),
            ("plugin".into(), 37),
            ("template".into(), 15),
        ]);
        let text = render(&app, 280, 18);
        assert!(text.contains("[all:137]")); // exact corpus count in the active filter
        assert!(text.contains("app:10"));
        assert!(text.contains("knowledge-pack:5"));
        assert!(text.contains("template:15"));
        // The title names the Browse sub-view on screen and advertises the key
        // that reaches the installed inventory. It used to read
        // "Browse + Installed", which claimed to show an inventory this pane
        // never rendered — see
        // `cupboard_installed_subview_renders_the_absorbed_plugin_inventory`.
        assert!(text.contains("Browse · [Tab] Installed"));
        // The page affordance remains visible in the list row; the long title
        // is intentionally allowed to clip its trailing hint at this width.
        assert!(text.contains("load next page"));
        assert!(text.contains("Papercusp Worker"));
        assert!(text.contains("install")); // the plugin action label in detail
        assert!(text.contains("papercupai"));
        // Arming the confirm flips the detail title.
        app.cupboard_confirm = Some("11111111-1111-1111-1111-111111111111".into());
        let armed = render(&app, 280, 18);
        assert!(armed.contains("press y to install"));
        // The search composer floats while open.
        app.cupboard_search_open = true;
        app.cupboard_search_input = "worker".into();
        let search = render(&app, 280, 18);
        assert!(search.contains("Search the Cupboard"));

        // Unsupported live kinds remain browseable without a false arm/confirm
        // promise, even if a stale confirm id is present.
        app.cupboard_search_open = false;
        app.cupboard = vec![CupboardListing {
            id: "plan-1".into(),
            listing_kind: "plan".into(),
            latest_json_url: Some("https://example.test/plan.json".into()),
            ..Default::default()
        }];
        app.cupboard_confirm = Some("plan-1".into());
        let read_only = render(&app, 280, 18);
        assert!(read_only.contains("Read-only in PUI"));
        assert!(read_only.contains("https://example.test/plan.json"));
        assert!(!read_only.contains("press y to"));
    }

    #[test]
    fn session_picker_overlay_renders_rows_and_marks_the_unsettable_one() {
        let mut app = App::new();
        app.session_picker = Some(crate::session_config::SessionPicker::new(
            crate::session_config::PickerAxis::Account,
            crate::session_config::account_options(&[], None),
        ));
        let text = render(&app, 110, 24);
        assert!(text.contains("Account"), "titled by axis");
        assert!(text.contains("Auto"));
        assert!(
            text.contains("not settable"),
            "the default-account row renders MARKED rather than being hidden"
        );
    }

    #[test]
    fn session_setup_review_shows_effective_values_and_action_at_minimum_size() {
        let mut app = App::new();
        let mut setup = crate::session_config::SessionSetup::new(
            "http://127.0.0.1:3170".into(),
            "exact draft λ".into(),
        );
        setup.step = 2;
        setup.project = "project-a".into();
        setup.backend = crate::su_session::SuSessionBackend::Codex;
        app.session_setup = Some(setup);
        let text = render(&app, 80, 20);
        for expected in [
            "3 Review",
            "project-a",
            "Codex",
            "default",
            "Server default model",
            "Default effort",
            "Manual",
            "exact draft λ",
            "START SESSION",
            "message retained",
        ] {
            assert!(text.contains(expected), "missing {expected}:\n{text}");
        }
    }

    /// Owner #783: in chat-first the first Enter opened a New-session form the
    /// full-screen branch never drew, so the message went nowhere. Every modal
    /// that captures keys must paint in the full-screen branch too — chat-first
    /// and a pinned dock pane alike.
    #[test]
    fn full_screen_surfaces_draw_the_modal_overlays_that_capture_keys() {
        for (label, chat_first, pinned) in [
            ("chat-first", true, None),
            ("pinned dock pane", false, Some(crate::app::Tab::Operator)),
        ] {
            let mut app = App::new();
            app.chat_first = chat_first;
            app.pinned = pinned;
            app.tab = crate::app::Tab::Operator;
            let mut setup = crate::session_config::SessionSetup::new(
                "http://127.0.0.1:3170".into(),
                "first words".into(),
            );
            setup.step = 2;
            setup.project = "project-a".into();
            app.session_setup = Some(setup);
            let text = render(&app, 100, 30);
            assert!(
                text.contains("New session") && text.contains("START SESSION"),
                "{label}: the setup form must draw:\n{text}"
            );

            app.session_setup = None;
            app.show_tutorial = true;
            let text = render(&app, 100, 30);
            assert_ne!(
                text,
                {
                    let mut plain = App::new();
                    plain.chat_first = chat_first;
                    plain.pinned = pinned;
                    plain.tab = crate::app::Tab::Operator;
                    render(&plain, 100, 30)
                },
                "{label}: the first-run tutorial must draw over the body"
            );
        }
    }

    #[test]
    fn session_setup_masks_operator_token_in_connection_form() {
        let mut app = App::new();
        let mut setup = crate::session_config::SessionSetup::new(
            "https://operator.example".into(),
            "draft".into(),
        );
        setup.endpoint_input = Some(setup.endpoint.clone());
        setup.editing_token = true;
        setup.token.0 = "fixture-secret-value".into();
        app.session_setup = Some(setup);
        let text = render(&app, 80, 20);
        assert!(!text.contains("fixture-secret-value"));
        assert!(text.contains("Operator token"));
        assert!(text.contains("first message retained"));
    }

    #[test]
    fn pot_picker_overlay_and_scope_indicator_render() {
        use crate::models::HarnessRef;
        let mut app = App::new();
        app.set_harnesses(vec![
            HarnessRef {
                slug: "papercup".into(),
                path: None,
            },
            HarnessRef {
                slug: "restart".into(),
                path: None,
            },
        ]);
        // The status bar carries the scope indicator (D-003).
        let base = render(&app, 100, 12);
        assert!(base.contains("⊙ all pots"));
        // The picker overlay lists All Pots + each pot.
        app.pot_picker_open = true;
        let picker = render(&app, 100, 14);
        assert!(picker.contains("All Pots"));
        assert!(picker.contains("papercup"));
        assert!(picker.contains("restart"));
        assert!(picker.contains("Enter select"));
        // Pot scope narrows the Plans list + flips the indicator.
        app.pot_picker_open = false;
        app.all_pots = false;
        app.tab = Tab::Plans;
        let mut p1 = plan("papercup-plan", "todo");
        p1.harness = Some("papercup".into());
        let mut p2 = plan("restart-plan", "todo");
        p2.harness = Some("restart".into());
        app.set_plans(vec![p1, p2]);
        let scoped = render(&app, 100, 14);
        assert!(scoped.contains("⊙ papercup"));
        assert!(scoped.contains("Plans (1)"));
        assert!(scoped.contains("papercup-plan"));
        assert!(!scoped.contains("restart-plan"));
    }

    #[test]
    fn lists_render_column_headers() {
        // D-005: explicit styled header rows above the column lists (the PUI
        // bakes column labels into row format strings, so headers are added
        // lines). Fleet (agents) leads; Plans/Inbox follow the same helper.
        let mut app = App::new();
        app.show_presence = false;
        app.tab = Tab::Fleet;
        app.set_roster(vec![presence_entry("claude", "working")]);
        let brew = render(&app, 120, 24);
        assert!(brew.contains("doing now")); // agents header
        app.tab = Tab::Plans;
        app.set_plans(vec![plan("alpha-2026", "todo")]);
        let plans = render(&app, 100, 14);
        assert!(plans.contains("status"));
        assert!(plans.contains("slug"));
        app.tab = Tab::Inbox;
        let inbox = render(&app, 100, 14);
        assert!(inbox.contains("Decisions")); // inbox tier-legend header (D-006)
                                              // Mirror firehose header.
        app.tab = Tab::Fleet;
        app.fleet.mode = crate::fleet::FleetMode::Mirror;
        let mirror = render(&app, 120, 16);
        assert!(mirror.contains("time"));
        assert!(mirror.contains("summary"));
    }

    #[test]
    fn testing_run_pane_renders_files_and_result() {
        use crate::app::{TestRunState, TestingFocus};
        use crate::models::TestingDomain;
        let mut app = App::new();
        app.tab = Tab::Testing;
        app.show_presence = false;
        app.set_testing(vec![TestingDomain {
            id: "unit".into(),
            label: "Unit".into(),
            description: "d".into(),
            tier: "universal".into(),
        }]);
        app.testing_files = vec!["lib/a.test.ts".into()];
        app.testing_focus = TestingFocus::Files;
        app.test_run = Some(TestRunState {
            running: false,
            run_id: Some("run-ui".into()),
            file: "lib/a.test.ts".into(),
            cancelling: false,
            status: "pass".into(),
            output: "✓ 3 tests passed".into(),
        });
        let text = render(&app, 110, 24);
        assert!(text.contains("files (1)"));
        assert!(text.contains("lib/a.test.ts"));
        assert!(text.contains("pass"));
        assert!(text.contains("3 tests passed"));
        // The in-flight state labels the pane as running.
        app.test_run = Some(TestRunState {
            running: true,
            run_id: Some("run-ui".into()),
            file: "lib/a.test.ts".into(),
            cancelling: false,
            status: String::new(),
            output: String::new(),
        });
        let running = render(&app, 110, 24);
        assert!(running.contains("running…"));
    }

    fn conv(id: &str, kind: &str, state: &str, title: &str) -> crate::models::ConvSummary {
        crate::models::ConvSummary {
            id: id.into(),
            kind: kind.into(),
            state: state.into(),
            scope: "workspace".into(),
            harness_slug: Some("papercup".into()),
            title: Some(title.into()),
            asker_id: "su-test".into(),
            topics: Vec::new(),
            promoted_issue_id: None,
            created_ts: "2026-08-29".into(),
        }
    }

    /// The Convos→Inbox absorption is only real if entering Inbox can actually
    /// REACH the absorbed thread list. Regression guard for the title-only
    /// absorption: `draw_inbox` rendered the attention list unconditionally
    /// while `tab_entry_side_effect` fetched conversations that nothing ever
    /// drew, so the thread list, its detail, its filters and promote-to-issue
    /// were unreachable from every keystroke.
    ///
    /// This asserts on conversation DATA in the frame and pairs it with an
    /// Attention-focus NEGATIVE CONTROL. That control is the point: a
    /// whole-frame nonblank-cell count is satisfied by the always-drawn tab
    /// strip alone, which is exactly why an 813-test green suite covered this
    /// gap. Never verify this class with `live_all_tabs_render`.
    #[test]
    fn inbox_threads_subview_renders_the_absorbed_conversation_list() {
        let mut app = App::new();
        app.tab = Tab::Inbox;
        app.conversations = vec![
            conv("conv-a1", "question", "open", "Why is the gate red"),
            conv("conv-b2", "discussion", "closed", "Rubric vetting scope"),
        ];

        // NEGATIVE CONTROL — on the Attention sub-view the thread data is
        // absent, so the positive assertions below cannot be satisfied by
        // ambient chrome (tab strip, borders, dock).
        // Rendered wide so the list column does not truncate the titles the
        // assertions below match on.
        app.inbox_focus = InboxFocus::Attention;
        let attention = render(&app, 200, 20);
        assert!(
            !attention.contains("Why is the gate red"),
            "attention sub-view must not already contain thread data, else the \
             positive assertion proves nothing: {attention}"
        );
        assert!(
            !attention.contains("Rubric vetting scope"),
            "attention sub-view must not contain any thread data: {attention}"
        );

        // POSITIVE — Tab to Threads and the fetched conversations are drawn.
        app.inbox_focus = InboxFocus::Threads;
        let threads = render(&app, 200, 20);
        assert!(
            threads.contains("Why is the gate red"),
            "Inbox body must render the absorbed thread list: {threads}"
        );
        // The SECOND thread is the load-bearing assertion: only the selected
        // thread reaches the detail pane, so a non-selected row can appear
        // ONLY if the list itself rendered.
        assert!(
            threads.contains("Rubric vetting scope"),
            "every visible conversation must be listed, not just the selected \
             one in the detail pane: {threads}"
        );
        // The body carries real per-thread columns, not just a count.
        assert!(threads.contains("open"), "thread state column: {threads}");
        assert!(
            threads.contains("Inbox · Threads (2)"),
            "the sub-view must name itself and its live count: {threads}"
        );
    }

    /// The absorbed empty-state string used to read "open Inbox to browse"
    /// while the user was already IN the Inbox — it pointed at a destination
    /// that no longer existed instead of at the keystroke that reveals the
    /// threads.
    #[test]
    fn inbox_attention_advertises_the_key_that_reaches_threads() {
        let mut app = App::new();
        app.tab = Tab::Inbox;
        app.inbox_focus = InboxFocus::Attention;
        app.conversations = vec![conv("conv-a1", "question", "open", "Seeded thread")];
        let text = render(&app, 200, 20);
        assert!(
            text.contains("[Tab] Threads"),
            "the Threads sub-view must be discoverable from Attention: {text}"
        );
        assert!(
            !text.contains("open Inbox to browse"),
            "stale absorption text points at a destination that no longer exists: {text}"
        );
    }

    /// The Plugins→Cupboard absorption is only real if entering Cupboard can
    /// REACH the installed inventory its own title advertises. Regression
    /// guard: `draw_cupboard` titled itself "Browse + Installed (N)" while
    /// rendering `app.cupboard` marketplace listings exclusively, so
    /// `draw_plugins_list` and `draw_plugin_panes` were dead code.
    ///
    /// The Browse-focus negative control is the load-bearing half — the
    /// pre-fix render is exactly what Browse produces, and asserting the
    /// installed data is ABSENT there is what makes the positive assertion
    /// mean something. A whole-frame nonblank count cannot tell them apart.
    #[test]
    fn cupboard_installed_subview_renders_the_absorbed_plugin_inventory() {
        use crate::models::PluginManifest;
        let mut app = App::new();
        app.tab = Tab::Cupboard;
        app.plugins = vec![PluginManifest {
            name: "logs-plugin".into(),
            ..Default::default()
        }];

        // NEGATIVE CONTROL — the marketplace Browse view (what the Cupboard
        // rendered unconditionally before this fix) shows no installed data,
        // even though its title counts it.
        app.cupboard_focus = CupboardFocus::Browse;
        let browse = render(&app, 140, 16);
        assert!(
            !browse.contains("logs-plugin"),
            "browse sub-view must not already contain installed-plugin data, \
             else the positive assertion proves nothing: {browse}"
        );
        assert!(
            browse.contains("[Tab] Installed (1)"),
            "browse must advertise the key that reaches the inventory it counts: {browse}"
        );

        // POSITIVE — Tab to Installed and the inventory is actually drawn.
        app.cupboard_focus = CupboardFocus::Installed;
        let installed = render(&app, 140, 16);
        assert!(
            installed.contains("logs-plugin"),
            "Cupboard body must render the absorbed installed-plugin inventory: {installed}"
        );
        assert!(
            installed.contains("Cupboard · Installed"),
            "the sub-view must name itself: {installed}"
        );
    }

    #[test]
    fn cupboard_panes_view_renders_plugin_panes() {
        use crate::models::TuiPaneContribution;
        let mut app = App::new();
        app.tab = Tab::Cupboard;
        app.cupboard_focus = CupboardFocus::Panes;
        app.set_panes(vec![TuiPaneContribution {
            plugin_name: "logs-plugin".into(),
            slug: "papercup".into(),
            label: "Server logs".into(),
            icon: Some("📜".into()),
            command: vec!["sh".into(), "tail.sh".into()],
            cwd: "/repo/papercup".into(),
        }]);
        let text = render(&app, 110, 8);
        assert!(text.contains("plugin panes (1)"));
        assert!(text.contains("Enter to launch"));
        assert!(text.contains("Server logs"));
        assert!(text.contains("logs-plugin"));
        assert!(text.contains("sh tail.sh"));
    }

    #[test]
    fn cupboard_installed_view_renders_contributions_and_settings() {
        use crate::models::PluginsGlobalResponse;
        let mut app = App::new();
        app.tab = Tab::Cupboard;
        app.cupboard_focus = CupboardFocus::Installed;
        app.show_presence = false; // full width for the two-column plugins layout
        let resp: PluginsGlobalResponse = serde_json::from_str(
            r#"{"plugins":[{
                "name":"github-repo","version":"0.1.0","description":"GitHub repo plugin",
                "actions":[{"name":"create-repo"}],
                "configSchema":{"type":"object","properties":{"owner":{"type":"string"}}}
            }]}"#,
        )
        .unwrap();
        app.set_plugins(resp.plugins);
        let text = render(&app, 120, 24);
        assert!(text.contains("github-repo"));
        assert!(text.contains("BE:1")); // one backend action
        assert!(text.contains("create-repo")); // contribution name in detail
        assert!(text.contains("backend"));
        assert!(text.contains("settings")); // configSchema → settings section
                                            // No config loaded yet → the Enter-to-load affordance.
        assert!(text.contains("press Enter to load"));
    }

    #[test]
    fn cupboard_installed_view_renders_loaded_config() {
        use crate::models::PluginsGlobalResponse;
        let mut app = App::new();
        app.tab = Tab::Cupboard;
        app.cupboard_focus = CupboardFocus::Installed;
        app.show_presence = false; // full width for the two-column plugins layout
        let resp: PluginsGlobalResponse = serde_json::from_str(
            r#"{"plugins":[{"name":"github-repo","version":"0.1.0",
                "configSchema":{"type":"object"}}]}"#,
        )
        .unwrap();
        app.set_plugins(resp.plugins);
        app.plugin_config = Some(("github-repo".into(), serde_json::json!({ "owner": "acme" })));
        let text = render(&app, 120, 24);
        assert!(text.contains("acme")); // the loaded config value renders
        assert!(text.contains(":pset")); // the edit hint
    }

    #[test]
    fn help_overlay_renders_when_shown() {
        let mut app = App::new();
        app.show_help = true;
        let text = render(&app, 140, 28);
        assert!(text.contains("Help"));
        assert!(text.contains("command palette"));
        assert!(text.contains("Network board"));
        assert!(
            text.contains("Fleet scheduling/inspector panes"),
            "help text: {text:?}"
        );
        assert!(text.contains("toggle presence sidebar"));
    }

    /// P-007. The help overlay must advertise the key that will actually ARRIVE.
    /// Inside the dock, zellij binds plain Tab to its zoom toggle, so a "press
    /// Tab" hint there is a promise the binary cannot keep — the same defect
    /// class as a hint naming the wrong key (slice 2) or a bar naming a
    /// behaviour that no longer happens (slice 3), and just as unreachable from
    /// the code that changed. Only a rendered-buffer assertion catches it.
    #[test]
    fn help_overlay_names_the_key_the_host_delivers() {
        let mut plain = App::new();
        plain.show_help = true;
        plain.keyboard_host = crate::keyboard::Host::Plain;
        let text = render(&plain, 140, 28);
        assert!(
            text.contains("Tab changes the focused subview"),
            "a bare terminal delivers Tab: {text:?}"
        );

        let mut dock = App::new();
        dock.show_help = true;
        dock.keyboard_host = crate::keyboard::Host::ZellijDock;
        let text = render(&dock, 140, 28);
        assert!(
            text.contains("Shift+Tab changes the focused subview"),
            "the dock eats plain Tab: {text:?}"
        );
        // NEGATIVE, and it must be anchored: "Shift+Tab changes" CONTAINS
        // "Tab changes", so the positive assertion above passes either way. The
        // separator is what distinguishes advertising Tab from advertising
        // Shift+Tab.
        assert!(
            !text.contains("· Tab changes"),
            "the dock must not still advertise plain Tab: {text:?}"
        );
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_coord_inbox_sse() {
        // P-002 end-to-end: the coord_inbox SSE producer route + the reader.
        let client = crate::client::OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let mut rx = client
            .subscribe_sse("/api/coord/inbox/sse")
            .await
            .expect("subscribe coord-inbox sse");
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
            .await
            .expect("timed out")
            .expect("a frame");
        eprintln!(
            "live coord-inbox SSE frame: {} | {}",
            frame.event, frame.data
        );
        assert!(matches!(frame.event.as_str(), "heartbeat" | "invalidate"));
        let inbox = client.coord_inbox().await.expect("coord inbox read");
        eprintln!("coord inbox: {} human-facing entries", inbox.len());
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_client_subscribe_sse() {
        // Exercises the new transport-agnostic subscribe_sse over the live
        // (IPC) backend end-to-end — the route sends an initial heartbeat.
        let client = crate::client::OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let mut rx = client
            .subscribe_sse("/api/zero-harness/sse")
            .await
            .expect("subscribe");
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
            .await
            .expect("timed out")
            .expect("a frame");
        eprintln!("live client SSE frame: {} | {}", frame.event, frame.data);
        assert!(matches!(
            frame.event.as_str(),
            "heartbeat" | "invalidate" | "update" | "message"
        ));
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_all_tabs_render() {
        // Read-only QA: fetch real data, render EVERY tab to a TestBackend. No
        // live pui process, no keystrokes, no launch path (see the
        // feedback-no-live-keystroke-drive-pui rule).
        let c = crate::client::OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let slug = "papercup";
        let mut app = App::new();
        if let Ok(v) = c.plans_typed().await {
            app.set_plans(v);
        }
        if let Ok((active, _pending)) = c.roster_typed().await {
            app.set_roster(active);
        }
        if let Ok(v) = c.attention_typed().await {
            app.set_inbox(v);
        }
        if let Ok(v) = c.harnesses().await {
            app.set_harnesses(v);
        }
        if let Ok(v) = c.features_for(slug).await {
            app.set_features(v);
        }
        if let Ok(v) = c.issues_for(slug).await {
            app.set_issues(v);
        }
        if let Ok(v) = c.docs_for(slug, None).await {
            app.set_docs(v);
        }
        if let Ok(v) = c.testing_domains(slug).await {
            app.set_testing(v);
        }
        if let Ok(v) = c.claude_settings_effective(slug).await {
            app.set_config(v);
        }
        if let Ok(v) = c.tui_panes_for(slug).await {
            app.set_panes(v);
        }
        if let Ok(v) = c.recent_toasts(20).await {
            app.set_notif_history(v);
        }
        for tab in Tab::ALL {
            app.tab = tab;
            let text = render(&app, 200, 50);
            let nonblank = text.chars().filter(|ch| !ch.is_whitespace()).count();
            eprintln!("--- tab {:?}: {nonblank} non-blank chars ---", tab);
            // Optional visual dump for manual QA: PUI_DUMP=1 writes each render.
            if std::env::var("PUI_DUMP").is_ok() {
                let _ = std::fs::create_dir_all("/tmp/puiqa-render");
                // 200-wide buffer of cell symbols, no newlines → re-wrap per row.
                let chars: Vec<char> = text.chars().collect();
                let wrapped: String = chars
                    .chunks(200)
                    .map(|c| c.iter().collect::<String>())
                    .collect::<Vec<_>>()
                    .join("\n");
                let _ = std::fs::write(format!("/tmp/puiqa-render/{tab:?}.txt"), wrapped);
            }
            assert!(nonblank > 0, "tab {tab:?} rendered blank");
            let label = tab.label(&app.lexicon);
            assert!(
                text.contains(label.as_str()),
                "tab {tab:?} display label missing from strip"
            );

            // A whole-frame non-blank count CANNOT detect an empty destination:
            // the always-drawn tab strip satisfies it on its own, so this test
            // would pass a destination that draws nothing at all. Measure the
            // BODY on its own instead.
            //
            // Pinned dock mode draws ONLY draw_tab_body over the full area —
            // no strip, no HUD — so it is the body-isolating instrument that
            // already exists; do not hand-compute chrome row offsets.
            //
            // SCOPE, stated honestly so nobody trusts this further than it goes:
            // this closes the "destination renders nothing" hole ONLY. It would
            // NOT have caught WI-644841 / WI-644835, whose bodies were never
            // empty — Inbox drew its Attention pane and Cupboard drew its
            // listings; what was missing was a reachable SUB-VIEW behind them.
            // That class is defended at the unit layer by the per-sub-view
            // tests (inbox_threads_subview_renders_the_absorbed_conversation_list,
            // cupboard_installed_subview_renders_the_absorbed_plugin_inventory,
            // and their key-routing peers), each asserting specific body content
            // against a negative control. A non-blank count is a floor, never a
            // capability check — do not add capability claims to this loop.
            assert!(
                !app.show_help && !app.show_notifs && app.toast.is_none(),
                "tab {tab:?}: an overlay is active, so a body-only render would \
                 measure the overlay instead of the destination"
            );
            app.pinned = Some(tab);
            let body_text = render(&app, 200, 50);
            app.pinned = None;
            let body_nonblank = body_text.chars().filter(|ch| !ch.is_whitespace()).count();
            eprintln!("--- tab {tab:?}: body {body_nonblank} non-blank chars ---");
            assert!(
                body_nonblank > 0,
                "tab {tab:?} BODY rendered empty — the full-frame check above still passed, \
                 satisfied by the tab strip alone"
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_toast_log_fetch() {
        let client = crate::client::OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let toasts = client.recent_toasts(10).await.expect("toast-log over IPC");
        eprintln!("live toast-log: {} entries", toasts.len());
        // Shape parsed; an empty log is valid, so just assert the call succeeded.
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_presence_sidebar_render() {
        let client = crate::client::OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let (roster, _pending) = client.roster_typed().await.expect("roster over IPC");
        let n = roster.len();
        let mut app = App::new();
        app.set_roster(roster);
        let text = render(&app, 120, 30);
        eprintln!("--- live presence sidebar render ({n} roster entries) ---\n{text}");
        assert!(text.contains("Presence"), "sidebar title should render");
    }

    #[test]
    fn tutorial_overlay_renders_and_outranks_help() {
        let mut app = App::new();
        app.show_tutorial = true;
        app.show_help = true; // tutorial should win
        let text = render(&app, 90, 26);
        assert!(text.contains("Welcome to pui"));
        assert!(text.contains("step 1/4"));
        assert!(!text.contains("pui — keys")); // help overlay suppressed
    }

    #[test]
    fn tutorial_zellij_layer_step_renders() {
        // D-003: the zellij-layer step teaches the window-manager layer pui runs
        // in (HUD vs work area, layout cycling, the dock verbs).
        let mut app = App::new();
        app.show_tutorial = true;
        app.tutorial_step = 2; // the new third step
        let text = render(&app, 90, 28);
        assert!(text.contains("Your workbench is zellij")); // block title
        assert!(text.contains("step 3/4"));
        assert!(text.contains("Alt")); // the zellij keybinds
        assert!(text.contains("Sessions n opens PUI setup"));
    }

    #[test]
    fn tutorial_last_step_renders() {
        let mut app = App::new();
        app.show_tutorial = true;
        app.tutorial_step = 3; // "Staying in the loop" is now the 4th/last step
        let text = render(&app, 90, 26);
        assert!(text.contains("Staying in the loop"));
        assert!(text.contains("step 4/4"));
    }

    #[test]
    fn palette_renders_input() {
        let mut app = App::new();
        app.palette_open = true;
        app.palette_input = "deploy".into();
        let text = render(&app, 80, 20);
        assert!(text.contains("Command"));
        assert!(text.contains("> deploy"));
    }

    #[test]
    fn palette_shows_dock_verbs_and_layout_presets() {
        // The dockview dock-verbs + the swap-preset cycle are discoverable in
        // the palette (Brief 50 / D-008). Render wide so nothing truncates.
        let mut app = App::new();
        app.palette_open = true;
        let text = render(&app, 120, 22);
        assert!(text.contains(":stack"), "palette lists :stack");
        assert!(text.contains(":dock"), "palette lists :dock");
        // The KDL preset names are surfaced from layout::SWAP_PRESETS.
        for p in crate::layout::SWAP_PRESETS {
            assert!(text.contains(p), "palette lists preset {p}");
        }
    }

    #[test]
    fn palette_shows_active_swap_preset_when_known() {
        use pui_companion_proto::{TabNode, Topology};
        let mut app = App::new();
        app.palette_open = true;
        app.topology = Some(Topology {
            tabs: vec![TabNode {
                pos: 0,
                name: "papercup".into(),
                active: true,
                swap_layout: Some("grid".into()),
                swap_dirty: false,
            }],
            panes: vec![],
        });
        let text = render(&app, 120, 22);
        assert!(text.contains("[grid]"), "palette shows the active preset");
    }

    #[test]
    fn tool_palette_renders_matches_recipes_schema_prompt_and_semantic_result() {
        use crate::app::{ToolArgField, ToolPaletteState};
        use crate::models::{ToolPaletteHit, ToolPaletteRecipe};
        use crate::semantic_tool_cards::{SemanticRow, SemanticToolCard};

        let hit = ToolPaletteHit {
            name: "work_items:get".into(),
            description: "Fetch one or many work items by id".into(),
            arg_schema: "id:string(1-120); detail?:boolean".into(),
            returns: None,
            via: Some("both".into()),
        };
        let mut app = App::new();
        app.palette_open = true;
        app.tool_palette = Some(ToolPaletteState {
            query: "work item detail".into(),
            phase: ToolPalettePhase::Results,
            tools: vec![hit.clone()],
            recipes: vec![ToolPaletteRecipe {
                id: "recipe-work-item-detail".into(),
                title: "Work-item detail".into(),
                description: String::new(),
            }],
            selected: 0,
            error: None,
            recipe_error: None,
        });
        let results = render(&app, 120, 30);
        assert!(results.contains("work_items:get"));
        assert!(results.contains("recipes:search suggestions"));
        assert!(results.contains("recipe-work-item-detail"));

        app.tool_palette.as_mut().unwrap().phase = ToolPalettePhase::Arguments {
            tool: hit.clone(),
            required: vec![ToolArgField {
                name: "id".into(),
                schema: "string(1-120)".into(),
            }],
            index: 0,
            args: serde_json::Map::new(),
        };
        app.palette_input = "WI-7".into();
        let arguments = render(&app, 120, 30);
        assert!(arguments.contains("required 1/1"));
        assert!(arguments.contains("id : string(1-120)"));
        assert!(arguments.contains("> WI-7"));

        app.tool_palette.as_mut().unwrap().phase = ToolPalettePhase::Result {
            tool: hit,
            card: SemanticToolCard {
                title: "Tool result · work_items:get".into(),
                rows: vec![SemanticRow {
                    label: "status",
                    value: "open".into(),
                    tone: SemanticTone::Positive,
                }],
            },
            succeeded: true,
        };
        let result = render(&app, 120, 30);
        assert!(result.contains("Tool result · work_items:get"));
        assert!(result.contains("status: open"));
    }

    // --- Fleet status view (pui-fleet-status-view-2026-06-04) ---

    fn fleet_roster(owner: &str, agent: &str, intent: &str) -> RosterEntry {
        RosterEntry {
            owner_id: owner.into(),
            label: format!("su · {owner}"),
            intent: Some(intent.into()),
            current_files: vec![],
            liveness: "live".into(),
            stale: false,
            agent: Some(agent.into()),
            role: Some("worker".into()),
            feature: None,
            current_plan_slug: None,
            heartbeat_at: None,
            ..Default::default()
        }
    }

    fn fleet_activity(
        owner: &str,
        agent: &str,
        summary: &str,
        ts: &str,
    ) -> crate::models::ActivityRow {
        crate::models::ActivityRow {
            id: "1".into(),
            owner_id: owner.into(),
            agent: Some(agent.into()),
            harness_slug: Some("papercup".into()),
            kind: "tool".into(),
            tool_name: None,
            summary: Some(summary.into()),
            status: None,
            detail: None,
            created_at: ts.into(),
        }
    }

    #[test]
    fn fleet_curated_renders_headline_agents_and_plan_progress() {
        use crate::models::{ItemCounts, WorkItem};
        let mut app = App::new();
        app.tab = Tab::Fleet;
        app.show_presence = false; // full width for the headline assertions
        app.set_roster(vec![fleet_roster("su-a", "claude", "building fleet view")]);
        let mut p = plan("fleet-view-2026", "active");
        p.item_counts = ItemCounts {
            todo: 2,
            done: 3,
            ..Default::default()
        };
        app.set_plans(vec![p]);
        app.fleet.set_work_items(vec![WorkItem {
            id: "F-1".into(),
            kind: "feature".into(),
            family: "feature".into(),
            harness: Some("papercup".into()),
            title: "t".into(),
            state: "passed".into(),
            assignee: None,
            severity: None,
        }]);
        app.update(crate::event::Event::ActivitySeed(vec![fleet_activity(
            "su-a",
            "claude",
            "✎ fleet.rs",
            "2026-06-04 18:53:58-04",
        )]));
        let text = render(&app, 120, 24);
        assert!(text.contains("Fleet")); // D-001 label-only rename of Fleet
        assert!(text.contains("1/1 online")); // headline agent count
        assert!(text.contains("Agents (1)"));
        assert!(text.contains("claude"));
        assert!(text.contains("fleet.rs")); // joined live activity summary
        assert!(text.contains("Plan progress"));
        assert!(text.contains("fleet-view-2026"));
        assert!(text.contains("3/5")); // plan items done/total
        assert!(text.contains("[curated]"));
    }

    #[test]
    fn fleet_agents_title_advertises_enter_and_launch() {
        // The work-area pane is gone (dock consolidation) — the launch + reach
        // affordances live on the Agents column title now.
        let mut app = App::new();
        app.tab = Tab::Fleet;
        app.show_presence = false;
        app.set_roster(vec![fleet_roster("su-a", "claude", "x")]);
        let text = render(&app, 120, 24);
        // D-001: Enter-by-location routing is advertised on the Agents column.
        assert!(text.contains("Enter: reach"));
        assert!(text.contains("n: launch"));
    }

    #[test]
    fn fleet_no_session_menu_overlay_renders() {
        use crate::app::FleetActionMenu;
        let mut app = App::new();
        app.tab = Tab::Fleet;
        // The [r]/[n]/[f] no-session menu (D-002) renders as a modal overlay.
        app.fleet_action_menu = Some(FleetActionMenu {
            label: "su · remote".into(),
            note: "agent is live but not reachable from this workbench".into(),
            can_resume: true,
            can_focus_window: true,
            resume_spec: None,
            focus: None,
        });
        let text = render(&app, 120, 24);
        assert!(text.contains("reach agent")); // overlay title
        assert!(text.contains("resume")); // [r] choice
        assert!(text.contains("launch a new agent")); // [n] choice
        assert!(text.contains("focus its terminal window")); // [f] choice
        assert!(text.contains("Esc to cancel"));
    }

    #[test]
    fn fleet_curated_renders_selected_agent_todos() {
        let mut app = App::new();
        app.tab = Tab::Fleet;
        app.show_presence = false;
        app.set_roster(vec![fleet_roster("su-a", "claude", "x")]);
        let mut todos = fleet_activity("su-a", "claude", "⇄ todos", "2026-06-04 18:00:00-04");
        todos.kind = "todos".into();
        todos.detail = Some(serde_json::json!({
            "count": 3, "done": 1,
            "todos": [
                {"content": "build fleet.rs", "status": "in_progress"},
                {"content": "wire pollers", "status": "pending"},
            ],
        }));
        app.update(crate::event::Event::ActivityTodos(vec![todos]));
        // The roster row carries the mirrored todo progress cell (the old
        // per-agent detail panel folded into the roster — dock consolidation).
        let text = render(&app, 120, 44);
        assert!(text.contains("\u{21c4}1/3")); // ⇄done/count
    }

    #[test]
    fn fleet_mirror_renders_activity_feed() {
        let mut app = App::new();
        app.tab = Tab::Fleet;
        app.show_presence = false;
        app.fleet.mode = crate::fleet::FleetMode::Mirror;
        app.update(crate::event::Event::ActivityLive(fleet_activity(
            "su-a",
            "codex",
            "▶ cargo test",
            "2026-06-04 19:01:02-04",
        )));
        let text = render(&app, 120, 16);
        assert!(text.contains("Activity mirror (1)"));
        assert!(text.contains("19:01:02"));
        assert!(text.contains("codex"));
        assert!(text.contains("cargo test"));
        assert!(text.contains("[mirror]"));
    }

    #[test]
    fn brew_tab_shows_in_strip_with_digit_key() {
        // Fleet titles as "Fleet" (D-001) on digit '4' (D-002).
        let app = App::new();
        let text = render(&app, 160, 8);
        assert!(text.contains("4:Fleet"));
    }

    // --- Operator chat pane (tui-operator-surface-2026-06-04) ---

    #[test]
    fn operator_leads_strip_on_digit_one() {
        let app = App::new();
        let text = render(&app, 220, 8);
        assert!(text.contains("1:Agent Chat"));
    }

    #[test]
    fn chat_view_renders_transcript_and_composer() {
        let mut app = App::new();
        app.tab = Tab::Operator;
        // Empty state prompts the user to compose and names the product.
        let empty = render(&app, 100, 16);
        assert!(empty.contains("Agent Chat"));
        assert!(empty.contains("press i to talk to this agent"));
        assert!(empty.contains("pot papercup"));
        // A seeded transcript renders both roles' bodies.
        app.set_chat_history(
            "c1".into(),
            vec![
                crate::models::ChatMessage::user("how is the carve going"),
                crate::models::ChatMessage::assistant("It landed green."),
            ],
            false,
            None,
        );
        let text = render(&app, 100, 20);
        assert!(text.contains("you"));
        assert!(text.contains("how is the carve"));
        assert!(text.contains("agent"));
        assert!(text.contains("It landed green."));
        // Composing surfaces the input box.
        app.chat_composing = true;
        app.chat_input = "hello".into();
        let typing = render(&app, 100, 20);
        assert!(typing.contains("Enter send"));
        assert!(typing.contains("> hello"));
    }

    #[test]
    fn chat_composer_keeps_selected_account_and_mode_visible_with_presence() {
        for width in [100, 150] {
            let mut app = App::new();
            app.harness = "papercusp".into();
            app.show_presence = true;
            app.chat_account = Some("auto".into());
            app.chat_mode = Some("auto".into());
            app.chat_composing = true;
            app.chat_input = "the unsent draft".into();
            let text = render(&app, width, 44);
            assert!(text.contains("account auto"), "width {width}: {text}");
            assert!(text.contains("mode auto"), "width {width}: {text}");
            assert!(text.contains("> the unsent draft"), "width {width}: {text}");
        }
    }

    #[test]
    fn chat_composer_renders_missing_usage_as_unknown_and_preserves_measured_zero() {
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.agent_chat_id = Some("chat-usage".into());

        let unknown = render(&app, 120, 24);
        assert!(
            unknown.contains("usage in unknown / out unknown / cost unknown / context unknown"),
            "{unknown}"
        );
        assert!(!unknown.contains("cost $0.0000"), "{unknown}");

        app.agent_chat_usage = crate::agent_chats::AgentChatUsage {
            input_tokens: Some(0),
            output_tokens: Some(0),
            cost_usd_cents: Some(0.0),
        };
        let measured_zero = render(&app, 120, 24);
        assert!(
            measured_zero.contains("usage in 0 / out 0 / cost $0.0000 / context unknown"),
            "{measured_zero}"
        );
    }

    /// A chat-first app bound to a live, attached session with every internal
    /// identifier R-03 forbids on the default screen (pui-chat-first-ux P-003).
    fn chat_first_bound_app() -> App {
        use crate::su_session::{
            SuSessionBackend, SuSessionBinding, SuSessionLifecycleState, SuSessionReconciliation,
            SuSessionState,
        };
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.chat_first = true;
        app.chat_composing = true;
        app.harness = "papercusp".into();
        app.agent_chat_id = Some("7d1b0a8d-69e4-4c1e-9a55-00000000c0de".into());
        app.project_root = "/work/demo".into();
        let mut session = SuSessionState::from_binding(SuSessionBinding {
            operation: "launch".into(),
            backend: SuSessionBackend::Claude,
            adv_session_id: 31362,
            owner_id: None,
            workspace_id: None,
            harness_slug: Some("papercusp".into()),
            plan_slug: None,
            native_session: None,
        });
        session.lifecycle = SuSessionLifecycleState::WaitingForOwner;
        session.reconciliation = SuSessionReconciliation::Attached;
        session.last_sequence = 13;
        app.su_session = Some(session);
        app.chat_messages = vec![
            crate::models::ChatMessage::user("hello"),
            crate::models::ChatMessage::assistant("Hi — what are we working on?"),
        ];
        app
    }

    /// The token classes R-03 forbids on the default chat screen: session ids,
    /// sequence numbers, lifecycle and reconciliation states, pot/role/store
    /// names, operator addresses, account routes and "unknown" usage rows.
    fn assert_no_chat_jargon(frame: &str) {
        for forbidden in [
            "adv ",
            "31362",
            "seq ",
            "7d1b0a8d",
            "reconciliation",
            "waiting-for-owner",
            "SU session",
            "SU · ",
            "pot ",
            "role ",
            "store ",
            "http://",
            "account ",
            "unknown",
        ] {
            assert!(
                !frame.contains(forbidden),
                "default chat shows `{forbidden}`:\n{frame}"
            );
        }
    }

    #[test]
    fn chat_first_default_frame_shows_model_directory_and_only_measured_cost() {
        let mut app = chat_first_bound_app();
        let frame = render(&app, 120, 24);
        assert_no_chat_jargon(&frame);
        assert!(frame.contains("Claude · /work/demo"), "{frame}");
        assert!(frame.contains("Ctrl+O details"), "{frame}");
        assert!(
            !frame.contains('$'),
            "no cost before one is measured:\n{frame}"
        );

        app.agent_chat_usage.cost_usd_cents = Some(12.0);
        let priced = render(&app, 120, 24);
        assert_no_chat_jargon(&priced);
        assert!(priced.contains("Claude · /work/demo · $0.12"), "{priced}");
    }

    #[test]
    fn chat_first_names_the_model_that_answered_without_its_account_route() {
        let mut app = chat_first_bound_app();
        app.chat_messages[1].provenance = Some(crate::models::ChatProvenance {
            engine: "claude".into(),
            model: "claude-sonnet-4-5".into(),
            account_route: "ownerhandle3_claude".into(),
        });
        let frame = render(&app, 120, 24);
        assert_no_chat_jargon(&frame);
        assert!(frame.contains("claude-sonnet-4-5 · /work/demo"), "{frame}");
        assert!(!frame.contains("ownerhandle3"), "{frame}");
    }

    #[test]
    fn chat_details_view_holds_the_internal_ids_and_the_workbench_shows_it() {
        let mut app = chat_first_bound_app();
        app.chat_details = Some(true);
        let details = render(&app, 150, 24);
        for shown in [
            "adv 31362",
            "seq 13",
            "reconciliation: attached",
            "pot papercusp",
        ] {
            assert!(
                details.contains(shown),
                "details view lacks `{shown}`:\n{details}"
            );
        }
        // The workbench is the operator console: details are its default.
        let mut workbench = chat_first_bound_app();
        workbench.chat_first = false;
        assert!(workbench.chat_details_visible());
        assert!(render(&workbench, 150, 24).contains("adv 31362"));
    }

    #[test]
    fn chat_first_failure_is_one_plain_sentence_and_the_raw_error_waits_behind_details() {
        let mut app = chat_first_bound_app();
        let raw = "SU-session host is not attached (adv 31362) via http://127.0.0.1:9071";
        let session = app.su_session.as_mut().unwrap();
        session.lifecycle = crate::su_session::SuSessionLifecycleState::Failed;
        session.reconciliation = crate::su_session::SuSessionReconciliation::FailedOrphaned;
        session.error = Some(raw.into());
        let frame = render(&app, 120, 24);
        assert_no_chat_jargon(&frame);
        assert!(
            frame.contains("Claude stopped; send a message to start it again."),
            "{frame}"
        );
        // Shown once, in the composer, not echoed in the transcript header.
        assert_eq!(frame.matches("Claude stopped").count(), 1, "{frame}");

        app.chat_details = Some(true);
        assert!(render(&app, 160, 24).contains("SU-session host is not attached"));
    }

    /// pui-chat-first-ux P-012: while a chat-first quick start is still
    /// settling (here: the operator identity has not answered), the owner
    /// sees the chat with their message and "Starting Claude…" — not the
    /// New-session form. Past the quiet wait the form opens and says why.
    #[test]
    fn chat_first_settling_quick_start_shows_the_chat_not_the_setup_form() {
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.chat_first = true;
        app.chat_composing = true;
        app.harness = "papercusp".into();
        app.open_session_setup();
        app.session_setup.as_mut().unwrap().message = "hello there".into();
        app.chat_first_autostart = true;
        app.chat_first_autostart_since = Some(std::time::Instant::now());
        let frame = render(&app, 120, 40);
        assert!(frame.contains("Starting Claude…"), "{frame}");
        assert!(frame.contains("hello there"), "{frame}");
        assert!(!frame.contains("New session"), "{frame}");
        assert_no_chat_jargon(&frame);

        app.chat_first_autostart_since =
            std::time::Instant::now().checked_sub(crate::app::CHAT_FIRST_QUIET_WAIT);
        let frame = render(&app, 120, 40);
        assert!(frame.contains("New session"), "{frame}");
    }

    #[test]
    fn chat_first_startup_progress_is_plain_words() {
        let mut app = chat_first_bound_app();
        app.su_session.as_mut().unwrap().lifecycle =
            crate::su_session::SuSessionLifecycleState::Starting;
        app.chat_messages.clear();
        let frame = render(&app, 120, 24);
        assert_no_chat_jargon(&frame);
        assert!(frame.contains("Starting Claude…"), "{frame}");
        assert!(
            frame.contains("Type a message below and press Enter."),
            "{frame}"
        );
    }

    /// EI-22067863854642076: a legacy/unclassified conversation's composer
    /// must say it is read-only up front — not keep the "Enter send"
    /// affordance while `on_key`'s Enter arm silently no-ops (see
    /// `enter_on_a_pre_cutover_conversation_keeps_read_only_history_intact`
    /// in app.rs, which pins that the draft itself stays editable).
    #[test]
    fn chat_view_marks_a_read_only_conversation_composer_instead_of_enter_send() {
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.agent_chat_id = Some("chat-legacy".into());
        app.pui_runtime_class = Some(crate::su_session::PuiRuntimeClass::LegacyOwnedLoop);
        app.chat_composing = true;
        app.chat_input = "hello".into();
        let text = render(&app, 100, 20);
        assert!(text.contains("Read-only"), "{text}");
        assert!(text.contains("read-only history"), "{text}");
        assert!(!text.contains("Enter send"), "{text}");
        // The refusal must also name the WAY FORWARD, or it is still a dead end
        // — just a labelled one. Per D-003 of
        // pui-psu-exact-launch-and-task-latency-2026-09-01 that route is the
        // literal `s:Sessions` navigation, NOT an in-pane new-session action
        // shadowing `s` (which is what EI-22067863854642076 asked for and what
        // D-003 forbids), so this pins the pointer and not a competing binding.
        // The "Esc, then" ordering is pinned too, not just the mnemonic: this
        // branch renders while `chat_composing` holds, and the composer swallows
        // every Char, so a bare `s` types into the draft. Advertising a one-key
        // action there would just trade a dead Enter for a dead `s`.
        assert!(text.contains("Esc, then s:Sessions"), "{text}");
        // The draft stays visible/editable — matches the app.rs Enter-key
        // contract that a refused turn is never silently discarded.
        assert!(text.contains("> hello"), "{text}");
    }

    /// pui-chat-first-ux-2026-09-28 P-013: the tool rows render above the
    /// answer they produced, and the answer does not repeat the speaker header
    /// unless it is the copy target (whose `▸` marker lives on that header).
    #[test]
    fn chat_view_renders_tool_rows_above_the_answer_they_produced() {
        use crate::models::{ChatMessage, ChatToolCall};

        let mut calls = ChatMessage::assistant("");
        calls.tools.push(ChatToolCall {
            name: "Read".into(),
            id: Some("call-1".into()),
            needs_approval: false,
            input: Some(serde_json::json!({ "file_path": "calc.js" })),
            result: None,
            outcome: ToolOutcome::Ok,
        });
        let answer = ChatMessage::assistant("P013 calc.js adds two numbers");

        let mut app = App::new();
        app.tab = Tab::Operator;
        app.set_chat_history(
            "c1".into(),
            vec![ChatMessage::user("explain calc.js"), calls, answer],
            false,
            None,
        );
        // `render` concatenates the rows without separators, so positions are
        // byte offsets into the frame and a header is its bordered-row prefix.
        let rows = |text: &str| -> (usize, usize, usize) {
            let tool = text.find("⚙ Read(calc.js)");
            let reply = text.find("P013 calc.js adds");
            let headers = text.matches("│  agent ").count() + text.matches("│▸ agent ").count();
            (tool.expect(text), reply.expect(text), headers)
        };

        let text = render(&app, 100, 30);
        let (tool, reply, headers) = rows(&text);
        assert!(
            tool < reply,
            "tool row must render above its answer:\n{text}"
        );
        // Newest block is the default copy target, so it keeps its marked header.
        assert_eq!(headers, 2, "{text}");

        app.chat_focus = Some(0);
        let text = render(&app, 100, 30);
        let (tool, reply, headers) = rows(&text);
        assert!(tool < reply, "{text}");
        assert_eq!(
            headers, 1,
            "an unfocused follow-on block repeats no header:\n{text}"
        );
    }

    /// pui-chat-first-ux-2026-09-28 P-014: a question the user skipped renders
    /// as a neutral "skipped" row: no failure glyph, no failure wording, and not
    /// the note the model was sent about the skip.
    #[test]
    fn chat_view_renders_a_skipped_question_as_skipped_not_failed() {
        use crate::models::{ChatMessage, ChatToolCall};

        let mut asked = ChatMessage::assistant("");
        asked.tools.push(ChatToolCall {
            name: "AskUserQuestion".into(),
            id: Some("call-q".into()),
            needs_approval: false,
            input: Some(serde_json::json!({ "questions": [{
                "question": "What would you like to work on?",
                "options": [{ "label": "Tests" }] }] })),
            result: Some(serde_json::json!(
                "The user skipped this question without answering. This is not an error"
            )),
            outcome: ToolOutcome::Skipped,
        });
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.set_chat_history(
            "c1".into(),
            vec![ChatMessage::user("hi"), asked],
            false,
            None,
        );
        let text = render(&app, 100, 30);
        assert!(text.contains("· skipped"), "{text}");
        assert!(
            !text.contains("✗"),
            "a skip must not render the failure glyph:\n{text}"
        );
        assert!(!text.contains("failed"), "{text}");
        assert!(!text.contains("The user skipped this question"), "{text}");
    }

    #[test]
    fn chat_view_renders_semantic_tool_rows_and_generic_fallback() {
        use crate::models::{ChatMessage, ChatToolCall};
        use serde_json::json;

        let mut semantic = ChatMessage::assistant("done");
        semantic.tools.push(ChatToolCall {
            name: "work_items:complete".into(),
            id: Some("call-1".into()),
            needs_approval: false,
            input: Some(json!({
                "id": "WI-7",
                "completion": { "summary": "landed it", "testResult": "12 passed" }
            })),
            result: Some(json!({ "ok": true })),
            outcome: ToolOutcome::Ok,
        });
        semantic.tools.push(ChatToolCall {
            name: "capability:read".into(),
            id: Some("call-2".into()),
            needs_approval: false,
            input: Some(json!({ "file_path": "src/main.rs" })),
            result: None,
            outcome: ToolOutcome::Ok,
        });

        let mut app = App::new();
        app.tab = Tab::Operator;
        app.set_chat_history("c1".into(), vec![semantic], false, None);
        let text = render(&app, 120, 24);
        assert!(text.contains("Completed WI-7"), "{text}");
        assert!(text.contains("evidence: landed it"), "{text}");
        assert!(text.contains("tests: 12 passed"), "{text}");
        // P-008: the generic fallback is a readable name + `key: value`
        // summary; the raw JSON object is only behind the expand toggle.
        assert!(text.contains("capability read"), "{text}");
        assert!(text.contains("file path: src/main.rs"), "{text}");
        assert!(!text.contains(r#"{"file_path""#), "{text}");
        app.chat_tools_expanded = true;
        let expanded = render(&app, 120, 24);
        assert!(
            expanded.contains(r#"args {"file_path":"src/main.rs"}"#),
            "{expanded}"
        );
    }

    #[test]
    fn chat_streaming_bubble_shows_live_say_preview() {
        let mut app = App::new();
        app.tab = Tab::Operator; // chat view — Overview is the default landing now (Brief 23)
        app.begin_user_send("hi");
        // The in-flight bubble holds raw tag text; it renders through live_preview.
        if let Some(m) = app.chat_messages.last_mut() {
            m.content = "<say>typing in pro".into();
        }
        app.chat_messages.last_mut().unwrap().provenance = Some(crate::models::ChatProvenance {
            engine: "su-session".into(),
            model: "claude-sonnet-4-6:high".into(),
            account_route: "auto".into(),
        });
        let text = render(&app, 100, 16);
        assert!(text.contains("typing in pro"));
        assert!(!text.contains("<say>")); // tags stripped from the preview
        assert!(text.contains("claude-sonnet-4-6:high"));
        assert!(text.contains("account auto"));
        assert!(text.contains("Running"));
        // Was `input locked` until P-007 draft queuing. Enter now QUEUES the next
        // line, so the bar must advertise that instead — and must not go on
        // claiming a lock the keys no longer enforce.
        assert!(text.contains("Enter queues"), "{text}");
        assert!(!text.contains("input locked"), "{text}");
    }

    /// A line preserved as `undelivered` has to actually REACH THE SCREEN, and
    /// has to be readable as not-sent. Keeping it in `chat_messages` and never
    /// painting it would be the same disappearance the state exists to prevent,
    /// only harder to notice — the data would be right and the owner would
    /// still have lost their message.
    ///
    /// The negative is the load-bearing half: rendering it under the `you`
    /// header would assert the message WAS sent, which is worse than dropping
    /// it, because the owner would never think to retype.
    #[test]
    fn an_undelivered_line_renders_and_is_not_dressed_up_as_a_sent_message() {
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.chat_messages
            .push(crate::models::ChatMessage::user("a sent turn"));
        app.chat_messages
            .push(crate::models::ChatMessage::undelivered("this never went"));

        let text = render(&app, 100, 24);

        assert!(
            text.contains("this never went"),
            "the text must survive: {text}"
        );
        assert!(
            text.contains("undelivered"),
            "and must be labelled as not-sent: {text}"
        );
        // Ordering, not bare presence: each label must precede the text it
        // qualifies, and the sent turn must keep its own `you` header. Offsets
        // into the flat render — `render` returns the whole screen as one
        // string, so a line-based search sees a single line and compares 0 < 0.
        let at = |needle: &str| {
            text.find(needle)
                .unwrap_or_else(|| panic!("missing {needle} in: {text}"))
        };
        assert!(
            at("you") < at("a sent turn")
                && at("a sent turn") < at("undelivered")
                && at("undelivered") < at("this never went"),
            "each block must be headed by its OWN label: {text}"
        );
    }

    /// CALIBRATION for the test above: a `user` message renders under `you`, so
    /// the header gutter really is what distinguishes the two. Without this, a
    /// renderer that stopped emitting headers entirely would still satisfy the
    /// negative assertion there.
    #[test]
    fn a_sent_message_still_renders_under_the_you_header() {
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.chat_messages
            .push(crate::models::ChatMessage::user("a sent turn"));

        let text = render(&app, 100, 24);

        let header = text.find("you").expect("a delivered line is headed `you`");
        let body = text.find("a sent turn").expect("above its text");
        assert!(header < body, "in that order: {text}");
        assert!(
            !text.contains("undelivered"),
            "and is never labelled undelivered: {text}"
        );
    }

    #[test]
    fn the_running_bar_counts_queued_lines_in_both_in_flight_states() {
        // Post-acknowledgement: `su_pending_turn` is clear, so the plain Running
        // branch renders.
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.begin_user_send("first");
        app.chat_queued.push("second".into());
        let text = render(&app, 100, 16);
        assert!(text.contains("1 queued"), "{text}");
        assert!(
            text.contains("Ctrl+X"),
            "cancelling must stay discoverable: {text}"
        );

        app.chat_queued.push("third".into());
        let text = render(&app, 100, 16);
        assert!(text.contains("2 queued"), "{text}");

        // Pre-acknowledgement: the "Sending — awaiting acceptance" branch wins for
        // the first moments of EVERY turn, which is exactly the window an owner
        // types ahead in. A count only on the Running branch would leave those
        // keystrokes looking dropped.
        app.su_pending_turn = Some(crate::app::PendingSuTurn {
            command_id: "pui-1".into(),
            content: "first".into(),
            draft: "first".into(),
            attachment_references: Vec::new(),
            command: None,
            uncertain: false,
            error: None,
        });
        app.chat_streaming = true;
        let text = render(&app, 100, 16);
        assert!(text.contains("awaiting acceptance"), "{text}");
        assert!(text.contains("2 queued"), "{text}");
    }

    /// pui-chat-first-ux P-012: in the default chat the message just sent is
    /// in the TRANSCRIPT while the turn is on its way, the composer is empty,
    /// and the bar says Enter queues the next one — not "draft retained".
    #[test]
    fn chat_first_shows_the_sent_message_in_the_transcript_before_acceptance() {
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.chat_first = true;
        app.chat_composing = true;
        app.su_pending_turn = Some(crate::app::PendingSuTurn {
            command_id: "pui-1".into(),
            content: "please read calc.js".into(),
            draft: "please read calc.js".into(),
            attachment_references: Vec::new(),
            command: None,
            uncertain: false,
            error: None,
        });
        app.chat_streaming = true;
        let text = render(&app, 100, 16);
        let transcript_row = text
            .lines()
            .find(|line| line.contains("please read calc.js"))
            .unwrap_or_else(|| panic!("the sent line must be on screen: {text}"));
        assert!(
            !transcript_row.contains("> please"),
            "it is in the transcript, not the composer: {text}"
        );
        assert!(text.contains("you"), "{text}");
        assert!(
            text.contains("Sending — Enter queues your next message"),
            "{text}"
        );
        assert!(!text.contains("draft retained"), "{text}");
        assert!(!text.contains("Type a message below"), "{text}");
    }

    /// CALIBRATION for the test above: with no queued lines the count must be
    /// ABSENT, not rendered as "0 queued". An always-on suffix would satisfy
    /// every `contains` assertion there while telling the owner nothing.
    #[test]
    fn the_running_bar_says_nothing_about_a_queue_that_is_empty() {
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.begin_user_send("first");
        let text = render(&app, 100, 16);
        assert!(text.contains("Enter queues"), "{text}");
        assert!(!text.contains("queued"), "{text}");
    }

    #[test]
    fn chat_approval_prompt_shows_the_exact_call_id() {
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.begin_user_send("change it");
        app.pending_approvals.push(crate::models::PendingApproval {
            call_id: "call-exact-7f2".into(),
            tool_name: "capability:edit".into(),
        });
        let text = render(&app, 100, 16);
        assert!(text.contains("call-exact-7f2"), "{text}");
        assert!(text.contains("Ctrl+Y approve"), "{text}");
    }

    #[test]
    fn inbox_detail_renders_two_tier_report_block() {
        // report-cards-inbox-reconciliation D-002/D-003: an operator <report>
        // is INBOX content — the detail pane renders the structured two-tier
        // plan→item block natively (the body text fallback is suppressed so
        // the payload doesn't double-render).
        use crate::models::AttentionItem;
        let report = crate::chat_tags::Report {
            title: Some("Fleet status".into()),
            plans: vec![crate::chat_tags::ReportPlan {
                slug: Some("rate-limit-layer-v2".into()),
                title: "Rate-limit v2".into(),
                status: Some("active".into()),
                summary: Some("top half of the layer".into()),
                items: vec![
                    crate::chat_tags::ReportItem {
                        id: Some("P-001".into()),
                        text: "Error classifier".into(),
                        status: Some("done".into()),
                    },
                    crate::chat_tags::ReportItem {
                        id: Some("P-003".into()),
                        text: "Per-call pacing".into(),
                        status: Some("wip".into()),
                    },
                ],
            }],
        };
        let mut app = App::new();
        app.tab = Tab::Inbox;
        app.inbox_focus = InboxFocus::Attention;
        app.set_inbox(vec![AttentionItem {
            id: "operator-report:t-1".into(),
            kind: "operator-report".into(),
            source: "operator".into(),
            harness_slug: None,
            plan_slug: Some("rate-limit-layer-v2".into()),
            item_ref: None,
            title: "Fleet status".into(),
            body: Some("[active] Rate-limit v2 — duplicated text body".into()),
            status: "report".into(),
            importance: None,
            needs_human: false,
            tier: Some("activity".into()),
            owner_agent_id: None,
            owner_label: Some("Operator".into()),
            triage_state: None,
            triage_note: None,
            report: Some(report),
            actions: Vec::new(),
            reference: serde_json::Value::Null,
        }]);
        let text = render(&app, 110, 30);
        // The detail pane renders the structured block (two tiers).
        assert!(text.contains("Fleet status"));
        assert!(text.contains("Rate-limit v2"));
        assert!(text.contains("Error classifier"));
        assert!(text.contains("Per-call pacing"));
        assert!(text.contains("P-001"));
        // The plain-text body fallback is suppressed when the block renders.
        assert!(!text.contains("duplicated text body"));
    }

    #[test]
    fn chat_transcript_carries_no_report_block() {
        // Chat is conversation-only (D-002): a finalized assistant bubble is
        // just the say text — ChatMessage no longer carries a report payload.
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.set_chat_history(
            "c1".into(),
            vec![crate::models::ChatMessage::assistant(
                "Three things need you — they're in your Inbox.",
            )],
            false,
            None,
        );
        let text = render(&app, 100, 24);
        assert!(text.contains("they're in your Inbox."));
    }

    #[test]
    fn wrap_text_wraps_words_and_preserves_breaks() {
        assert_eq!(wrap_text("a b c", 3), vec!["a b", "c"]);
        assert_eq!(wrap_text("line1\nline2", 80), vec!["line1", "line2"]);
        // A word longer than the width is hard-split.
        assert_eq!(wrap_text("abcdef", 3), vec!["abc", "def"]);
        // An empty line is preserved (paragraph break).
        assert_eq!(wrap_text("x\n\ny", 80), vec!["x", "", "y"]);
    }

    #[test]
    fn tool_detail_lines_preview_output_expand_it_and_show_diffs() {
        use crate::models::{ChatToolCall, ToolOutcome};
        let text = |lines: Vec<Line<'static>>| {
            lines
                .iter()
                .map(|l| {
                    l.spans
                        .iter()
                        .map(|s| s.content.as_ref())
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let mut tc = ChatToolCall::plain("Bash".into());
        tc.outcome = ToolOutcome::Ok;
        tc.result = Some(serde_json::json!("r1\nr2\nr3\nr4\nr5"));
        let collapsed = text(tool_detail_lines(&tc, 80, false));
        assert!(
            collapsed.contains("⎿ r1") && collapsed.contains("r3"),
            "{collapsed}"
        );
        assert!(!collapsed.contains("r4"), "{collapsed}");
        assert!(
            collapsed.contains("+2 lines (Ctrl+R to expand)"),
            "{collapsed}"
        );
        let expanded = text(tool_detail_lines(&tc, 80, true));
        assert!(
            expanded.contains("r5") && !expanded.contains("Ctrl+R"),
            "{expanded}"
        );
        // A structured envelope is never dumped; text parts are.
        tc.result = Some(serde_json::json!({ "rows": [1, 2, 3] }));
        assert!(tool_detail_lines(&tc, 80, true).is_empty());
        tc.result =
            Some(serde_json::json!({ "content": [{ "type": "text", "text": "from parts" }] }));
        assert!(text(tool_detail_lines(&tc, 80, false)).contains("⎿ from parts"));
        // P-011: Claude's Read result (`     1\tconst …`) and coloured command
        // output reach the transcript with no control character left.
        tc.result = Some(serde_json::json!(
            "     1\tconst test = 1;\n\u{1b}[32mok\u{1b}[0m"
        ));
        let read = text(tool_detail_lines(&tc, 80, false));
        assert!(
            read.contains("⎿      1  const test = 1;") && read.contains("      ok"),
            "{read}"
        );
        assert!(
            !read.chars().any(|c| c.is_control() && c != '\n'),
            "{read:?}"
        );
        let mut tabbed = ChatToolCall::plain("Edit".into());
        tabbed.input = Some(serde_json::json!({
            "file_path": "a.go", "old_string": "\treturn 1", "new_string": "\treturn 2"
        }));
        let tab_diff = text(tool_detail_lines(&tabbed, 80, false));
        assert!(
            tab_diff.contains("- ") && !tab_diff.contains('\t'),
            "{tab_diff:?}"
        );
        // A file edit shows its diff inline, before and after it completes.
        let mut edit = ChatToolCall::plain("Edit".into());
        edit.input = Some(serde_json::json!({
            "file_path": "src/a.rs", "old_string": "let a = 1;", "new_string": "let a = 2;"
        }));
        let diff = text(tool_detail_lines(&edit, 80, false));
        assert!(
            diff.contains("- let a = 1;") && diff.contains("+ let a = 2;"),
            "{diff}"
        );
    }

    #[test]
    fn tool_input_summary_is_one_bounded_line_or_nothing() {
        use serde_json::json;

        // Nothing worth a line: absent, null, or empty containers.
        assert_eq!(tool_input_summary(&json!(null), 40), None);
        assert_eq!(tool_input_summary(&json!({}), 40), None);
        assert_eq!(tool_input_summary(&json!([]), 40), None);
        // A zero width has no room for a summary at all.
        assert_eq!(tool_input_summary(&json!({ "a": 1 }), 0), None);

        assert_eq!(
            tool_input_summary(&json!({ "command": "ls" }), 40),
            Some("command: ls".to_string())
        );

        // Bounded to the given width, never wider.
        let long = tool_input_summary(&json!({ "command": "x".repeat(200) }), 30).unwrap();
        assert_eq!(long.chars().count(), 30);
        assert!(long.ends_with('…'));

        // A multi-line value collapses: a single-line card must not smuggle in
        // extra rows the transcript layout has not accounted for.
        let multi = tool_input_summary(&json!({ "body": "one\ntwo" }), 80).unwrap();
        assert!(!multi.contains('\n'), "summary must stay one line: {multi}");

        // Multibyte truncation must not panic or split a char.
        let uni = tool_input_summary(&json!({ "s": "café☕".repeat(50) }), 12).unwrap();
        assert_eq!(uni.chars().count(), 12);
    }

    #[test]
    fn plan_filter_rail_renders_with_check_marks_on_inbox() {
        // D-009: the open rail lists the pot-scoped plans with a checkbox per
        // slug + the toggle/clear/close hint, and the Inbox title carries the
        // active-filter badge.
        let mut app = App::new();
        app.tab = Tab::Inbox;
        app.show_presence = false; // keep the consolidated title badge visible
        app.set_plans(vec![
            plan("alpha-2026", "todo"),
            plan("beta-2026", "shipped"),
        ]);
        app.plan_filter_open = true;
        app.plan_filter.insert("alpha-2026".to_string());
        let text = render(&app, 120, 16);
        assert!(
            text.contains("Filter: plans (1 on)"),
            "rail title missing: {text:?}"
        );
        assert!(text.contains("[x]"), "checked plan glyph missing");
        assert!(text.contains("[ ]"), "unchecked plan glyph missing");
        assert!(text.contains("toggle"), "rail hint missing");
        assert!(
            text.contains("F:plans(1)"),
            "inbox filter badge missing: {text:?}"
        );
        // Closing the rail hides it but keeps the badge (filter still applies).
        app.plan_filter_open = false;
        let closed = render(&app, 120, 16);
        assert!(
            !closed.contains("Filter: plans"),
            "rail should be hidden when closed"
        );
        assert!(
            closed.contains("F:plans(1)"),
            "badge should persist while rail hidden"
        );
    }

    #[test]
    fn status_bar_shows_help_and_tutorial_hint() {
        // D-012: the footer always advertises the help overlay. On non-Operator
        // tabs the right edge advertises the one-action Agent Chat jump.
        let mut app = App::new();
        app.tab = Tab::Plans;
        let text = render(&app, 100, 12);
        assert!(
            text.contains("o:Agent Chat"),
            "Agent Chat jump missing on a restored non-chat tab"
        );
        assert!(text.contains("?:help"), "help hint missing from status bar");
        app.tab = Tab::Operator;
        let text = render(&app, 100, 12);
        assert!(text.contains("?:help"), "help hint missing from status bar");
        assert!(text.contains("l/m/e/a/u:select"));
    }

    #[test]
    fn help_overlay_lists_tutorial_and_plans_filter() {
        // D-012 + D-009: the `?` help overlay documents both the re-openable
        // tutorial and the plans-filter rail.
        let mut app = App::new();
        app.show_help = true;
        // Tall enough that the full help text (incl. the F1/:tutorial line near
        // the bottom) renders without clipping.
        let text = render(&app, 100, 40);
        assert!(
            text.contains(":tutorial"),
            "help should mention the :tutorial palette command"
        );
        assert!(
            text.contains("plans filter"),
            "help should mention the plans filter rail"
        );
    }

    // ─── Operator dock (operator-always-visible-2026-06-05, Brief 24) ───

    #[test]
    fn operator_dock_is_persistent_beside_tab_content() {
        let mut app = App::new();
        app.tab = Tab::Plans;
        app.plans = vec![plan("alpha", "todo")];
        app.set_chat_history(
            "c1".into(),
            vec![crate::models::ChatMessage::assistant("docked reply here")],
            false,
            None,
        );
        // Comfortably above SURFACE_B_MIN_WIDTH → the persistent dock is carved
        // on the right alongside Plans without an opt-in toggle.
        let text = render(&app, 280, 20);
        assert!(
            text.contains("Title alpha"),
            "the Plans tab content still renders"
        );
        assert!(
            text.contains("Agent Chat"),
            "the Agent Chat dock renders its title"
        );
        assert!(
            text.contains("docked reply here"),
            "the dock shows the transcript"
        );
    }

    /// P-004 / D-005 (pui-psu-exact-launch-and-task-latency-2026-09-01): the
    /// Surface B cockpit is a FIXED layout — the Agent Chat transcript AND
    /// composer stay beside the Sessions and Fleet task surfaces on a wide
    /// terminal with no opt-in toggle, and each destination's own content
    /// still renders next to them.
    #[test]
    fn surface_b_agent_chat_pane_coexists_with_sessions_and_fleet_content() {
        for (tab, own_content) in [(Tab::Sessions, "STATE all"), (Tab::Fleet, " Fleet ")] {
            let mut app = App::new();
            app.tab = tab;
            app.set_chat_history(
                "c1".into(),
                vec![crate::models::ChatMessage::assistant("cockpit reply")],
                false,
                None,
            );
            app.chat_input = "half typed".into();
            app.chat_composing = true;
            let text = render(&app, 280, 24);
            assert!(
                text.contains("Agent Chat"),
                "{tab:?}: the Agent Chat pane is present without a toggle"
            );
            assert!(
                text.contains("cockpit reply"),
                "{tab:?}: the transcript is visible beside the surface"
            );
            assert!(
                text.contains("> half typed"),
                "{tab:?}: the composer sits in the pane with its draft: {text:?}"
            );
            assert!(
                text.contains(own_content),
                "{tab:?}: the destination's own content renders beside the pane: {text:?}"
            );
        }
    }

    #[test]
    fn operator_card_renders_radio_options_inline() {
        // sentinel-tui-shared-backend-and-cards Phase 2a: an open chat:ask_choice
        // card renders inline over the operator pane with its prompt + numbered
        // options + a queue/action hint in the composer.
        let mut app = App::new();
        app.tab = Tab::Operator;
        let snap = serde_json::json!({
            "runId": "run-1",
            "workspaceId": "ws-1",
            "version": 1,
            "snapshot": { "openCards": [{
                "correlationId": "corr-1",
                "prompt": "Approve the deploy?",
                "presentation": { "kind": "radio", "options": [
                    { "id": "yes", "label": "Approve" },
                    { "id": "no", "label": "Reject" }
                ]},
                "allowDecline": true,
                "createdAt": 1.0
            }]}
        })
        .to_string();
        app.card_state
            .apply_snapshot(crate::card_view::SnapshotEnvelope::from_json(&snap).unwrap());
        let text = render(&app, 100, 24);
        assert!(text.contains("Approve the deploy?"), "card prompt renders");
        assert!(text.contains("1. Approve"), "option 1 renders numbered");
        assert!(text.contains("2. Reject"), "option 2 renders numbered");
        assert!(
            text.contains("Needs your answer"),
            "card block title renders"
        );
        assert!(
            !text.contains("Operator asks"),
            "card title names no internal component (WI-10004211)"
        );
        assert!(
            text.contains("answer above") || text.contains("pick"),
            "composer steers the user to the card"
        );
    }

    /// pui-chat-first-ux P-008: a tool approval shows its readable prompt and
    /// keeps the raw arguments behind Ctrl+R, which the composer names.
    #[test]
    fn approval_card_keeps_raw_arguments_behind_ctrl_r() {
        let mut app = App::new();
        app.tab = Tab::Operator;
        let snap = serde_json::json!({
            "runId": "run-1",
            "workspaceId": "ws-1",
            "version": 1,
            "snapshot": { "openCards": [{
                "correlationId": "corr-1",
                "prompt": "Allow Update(calc.js)?\nAdd 1 line, remove 1 line\n- return a - b;\n+ return a + b;",
                "details": "Raw arguments (Edit):\n{\"old_string\": \"return a - b;\"}",
                "presentation": { "kind": "radio", "options": [
                    { "id": "0", "label": "Approve" },
                    { "id": "1", "label": "Decline" }
                ]},
                "allowDecline": true,
                "createdAt": 1.0
            }]}
        })
        .to_string();
        app.card_state
            .apply_snapshot(crate::card_view::SnapshotEnvelope::from_json(&snap).unwrap());
        let text = render(&app, 110, 30);
        assert!(
            text.contains("Allow Update(calc.js)?"),
            "readable prompt renders"
        );
        assert!(text.contains("+ return a + b;"), "the diff renders");
        assert!(!text.contains("old_string"), "raw arguments stay hidden");
        assert!(
            text.contains("Ctrl+R details"),
            "the composer names the toggle"
        );
        app.chat_tools_expanded = true;
        let text = render(&app, 110, 30);
        assert!(
            text.contains("Raw arguments (Edit):"),
            "Ctrl+R shows the raw arguments"
        );
        assert!(text.contains("old_string"));
        assert!(text.contains("Ctrl+R hide details"));
    }

    #[test]
    fn operator_dock_hidden_on_narrow_terminal() {
        let mut app = App::new();
        app.tab = Tab::Plans;
        app.plans = vec![plan("alpha", "todo")];
        app.operator_dock_open = true;
        // Below SURFACE_B_MIN_WIDTH the dock is suppressed; Plans gets full width.
        let text = render(&app, 80, 20);
        assert!(text.contains("Title alpha"));
        // The dock's focus marker ("○ o" / "●") never appears when it isn't drawn.
        assert!(!text.contains("○ o"));
    }

    /// WI-2140985 regression (found by independent acceptance grading of
    /// pui-psu-exact-launch-and-task-latency-2026-09-01, card
    /// EI-22123862806145770): the Surface B cockpit must render at an ORDINARY
    /// terminal width, not only an ultra-wide one.
    ///
    /// The gate was `>= 260`, far past any ordinary terminal, so D-005's
    /// "always-visible" Agent Chat pane was invisible in practice. The suite
    /// could not see it: `operator_dock_hidden_on_narrow_terminal` renders at 80
    /// and `operator_dock_is_persistent_beside_tab_content` at 280, so both pass
    /// under a gate of 160 OR 260 and nothing covered the band between. This
    /// test renders exactly AT `SURFACE_B_MIN_WIDTH`, inside that band, and so
    /// FAILS under the old 260 gate.
    #[test]
    fn operator_dock_renders_at_ordinary_terminal_width() {
        let mut app = App::new();
        app.tab = Tab::Plans;
        app.plans = vec![plan("alpha", "todo")];
        app.set_chat_history(
            "c1".into(),
            vec![crate::models::ChatMessage::assistant("docked reply here")],
            false,
            None,
        );
        // A commonplace wide-but-not-ultrawide terminal, inside the band the
        // old gate excluded.
        let text = render(&app, 160, 20);
        assert!(
            text.contains("Title alpha"),
            "the Plans tab content still renders beside the dock at width 160"
        );
        assert!(
            text.contains("Agent Chat"),
            "the Agent Chat dock renders at an ordinary terminal width (regression: the gate was 260)"
        );
        assert!(
            text.contains("docked reply here"),
            "the dock shows its transcript at an ordinary terminal width"
        );
    }

    /// The gate must stay the layout's own arithmetic rather than drifting back
    /// into a magic number: dock `Length(40)` + presence rail `Length(30)` +
    /// body `Min(48)` = 118, and it must still fit an ordinary wide terminal.
    #[test]
    fn surface_b_min_width_matches_the_layout_constraints_it_guards() {
        // Hard geometric floor: dock 40 + presence rail 30 + body Min(48).
        const {
            assert!(
                SURFACE_B_MIN_WIDTH >= 40 + 30 + 48,
                "the gate must leave room for the dock, the presence rail and an unclipped body"
            );
        }
        // The real bar: the dock plus a conventional 120-column content body.
        const {
            assert!(
                SURFACE_B_MIN_WIDTH >= 40 + 120,
                "the body beside the dock must stay a usable content width, not just the unclipped minimum"
            );
        }
        const {
            assert!(
                SURFACE_B_MIN_WIDTH <= 200,
                "the gate must fit an ordinary maximized terminal — above this, D-005's always-visible pane is hidden in practice (WI-2140985)"
            );
        }
    }

    #[test]
    fn operator_dock_not_shown_on_operator_tab() {
        let mut app = App::new();
        app.tab = Tab::Operator; // the full tab IS the chat; no extra dock
        app.operator_dock_open = true;
        let text = render(&app, 120, 20);
        // The full-tab Operator render carries no dock focus marker.
        assert!(!text.contains("○ o"));
        assert!(!text.contains("● Operator"));
    }

    #[test]
    fn operator_dock_focus_marker_reflects_focus_state() {
        let mut app = App::new();
        app.tab = Tab::Plans;
        app.operator_dock_open = true;
        // Unfocused → "○ o" hint (press o to focus).
        let unfocused = render(&app, 280, 20);
        assert!(
            unfocused.contains("○ o"),
            "unfocused dock advertises the o key"
        );
        // Focused → "●" marker.
        app.operator_dock_focused = true;
        let focused = render(&app, 280, 20);
        assert!(focused.contains('●'), "focused dock shows the ● marker");
    }

    #[test]
    fn operator_dock_hint_in_status_bar_remains_available_for_focus() {
        let mut app = App::new();
        app.tab = Tab::Plans;
        let text = render(&app, 120, 20);
        assert!(
            text.contains("o:Agent Chat"),
            "status bar advertises Agent Chat when the dock is closed"
        );
    }

    #[test]
    fn operator_dock_right_carve_suppressed_on_overview() {
        // P-008: the Overview tab already hosts the operator (draw_overview
        // renders draw_operator_dock as its bottom strip, Brief 23), so the
        // right-dock carve must NOT also fire there — the chat renders exactly
        // once even with the dock explicitly opened.
        let mut app = App::new();
        app.tab = Tab::Overview;
        assert_eq!(app.tab, Tab::Overview);
        app.operator_dock_open = true; // user-opened right-dock…
        let text = render(&app, 120, 30);
        // …still exactly ONE unfocused dock marker (the strip's); a second one
        // would mean the right-dock double-rendered the conversation.
        assert_eq!(
            text.matches("○ o").count(),
            1,
            "operator must render exactly once on Overview"
        );
    }

    #[test]
    fn session_switcher_renders_all_states_in_normal_and_pinned_paths() {
        let mut app = App::new();
        app.session_switcher = Some(crate::app::SessionSwitcher {
            query: "crew".into(),
            rows: ["live", "parked", "ended", "recorded"]
                .into_iter()
                .enumerate()
                .map(|(index, state)| RosterEntry {
                    owner_id: format!("su-{state}"),
                    label: format!("{state} crew"),
                    source: "codex".into(),
                    role: Some("member".into()),
                    intent: Some("ship the cockpit".into()),
                    session_state: Some(state.into()),
                    adv_session_id: Some(index as i64 + 1),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        });

        let normal = render(&app, 120, 30);
        for expected in [
            "Sessions · Ctrl-S",
            "filter › crew",
            "LIVE",
            "PARKED",
            "ENDED",
            "RECORDED",
        ] {
            assert!(
                normal.contains(expected),
                "missing {expected:?}: {normal:?}"
            );
        }

        app.pinned = Some(Tab::Fleet);
        let pinned = render(&app, 120, 30);
        assert!(pinned.contains("Sessions · Ctrl-S"));
        assert!(pinned.contains("LIVE"));
        assert!(pinned.contains("RECORDED"));
    }

    #[test]
    fn session_browser_renders_facets_rows_preview_and_actions() {
        let mut app = App::new();
        app.tab = Tab::Sessions;
        app.session_browser.when_idx = 2;
        app.session_browser.rows = vec![crate::models::RosterEntry {
            owner_id: "su-browser".into(),
            label: "migration agent".into(),
            source: "codex".into(),
            agent: Some("codex".into()),
            fleet_slug: Some("pui-cockpit".into()),
            session_state: Some("recorded".into()),
            transcript_at: Some("2026-08-26T23:00:00Z".into()),
            ..Default::default()
        }];
        app.session_browser.transcript = vec![crate::models::SessionTranscriptTurn {
            speaker: "agent".into(),
            text: "Migration 981 is armed".into(),
            ..Default::default()
        }];
        let text = render(&app, 140, 24);
        for expected in [
            "STATE all",
            "FLEET any",
            "migration agent",
            "Migration 981 is armed",
            "Enter attach/resume",
            "save crew",
        ] {
            assert!(text.contains(expected), "missing {expected:?}: {text:?}");
        }
    }

    // --- change-card overlay (P-007) -------------------------------------

    /// An app holding one open change card, built through the REAL detector so
    /// the fixture cannot drift from what a live tool call resolves to.
    /// `chat_messages` is deliberately left EMPTY: the open card is a snapshot,
    /// and a paint that needed the transcript to still hold the message would
    /// go blank the moment history reloaded under it.
    fn card_app(scroll: usize) -> App {
        let mut app = App::new();
        app.tab = Tab::Operator;
        let tool = crate::models::ChatToolCall {
            name: "capability:edit".into(),
            id: Some("c1".into()),
            needs_approval: false,
            input: Some(serde_json::json!({
                "file_path": "apps/tui/src/app.rs",
                "old_string": "alpha\nbravo\ncharlie",
                "new_string": "alpha\nBRAVO\ncharlie",
            })),
            result: None,
            outcome: ToolOutcome::Ok,
        };
        let card =
            crate::change_card::card_for_tool(&tool, 0, 0).expect("fixture must resolve to a card");
        assert_eq!(
            card.render_lines().len(),
            7,
            "the scroll assertions below are written against this exact body"
        );
        app.open_change_card = Some(crate::app::OpenChangeCard { card, scroll });
        app
    }

    /// P-015: the frame drawn right after the answering keypress shows the card
    /// as ONE "✓ Approved" row — the options are gone, so the card can't look
    /// unanswered — and the composer says the answer is on its way.
    #[test]
    fn an_answered_approval_card_collapses_to_one_approved_row() {
        let mut app = App::new();
        app.tab = Tab::Operator;
        for (cid, command) in [("alpha", "echo ALPHA"), ("beta", "echo BETA")] {
            let data = serde_json::json!({
                "runId": cid, "workspaceId": "ws", "version": 1,
                "snapshot": { "openCards": [{
                    "correlationId": cid,
                    "prompt": format!("Allow Bash?\n$ {command}"),
                    "presentation": { "kind": "radio", "options": [
                        { "id": "0", "label": "Approve" }, { "id": "1", "label": "Decline" }] },
                    "allowDecline": true, "createdAt": 1.0 }] }
            })
            .to_string();
            app.card_state
                .apply_snapshot(crate::card_view::SnapshotEnvelope::from_json(&data).unwrap());
        }
        let open = render(&app, 100, 30);
        assert!(
            open.contains("Decline") && open.contains("echo ALPHA"),
            "{open}"
        );

        app.card_state.mark_answered(
            "alpha",
            "Approved".into(),
            crossterm::event::KeyCode::Char('1'),
        );
        let text = render(&app, 100, 30);
        assert!(text.contains("✓ Approved · Allow Bash? · 1 more"), "{text}");
        assert!(
            !text.contains("Decline"),
            "the answered card's options are still drawn: {text}"
        );
        assert!(
            !text.contains("echo BETA"),
            "the next card was focused under the answer: {text}"
        );
        assert!(text.contains("Waiting for the agent"), "{text}");
    }

    #[test]
    fn an_open_change_card_paints_its_diff_and_its_keys() {
        let text = render(&card_app(0), 120, 40);
        for expected in [
            " alpha", // context keeps the gutter column
            "-bravo", // removed
            "+BRAVO", // added
            "@@ hunk 1/1 @@",
            "app.rs",    // the frame's pager status line names the file
            "1-7/7",     // ...and where in it the reader is
            "Esc close", // the key footer
            "y copy",
        ] {
            assert!(text.contains(expected), "missing {expected:?}: {text:?}");
        }
    }

    /// The transcript must SAY a turn has diffs, and must name the key that
    /// works from where the reader is actually standing. With no cursor set,
    /// `effective_chat_focus()` still resolves to the newest block — so a hint
    /// keyed off that would promise "Enter opens the diff" on the very common
    /// turn whose last act was a file edit, where Enter in fact opens the
    /// composer. The wrong-key half of this test is the load-bearing half.
    #[test]
    fn a_turn_that_edited_a_file_advertises_its_diffs_with_the_key_that_applies() {
        let mut app = App::new();
        app.tab = Tab::Operator;
        let mut msg = crate::models::ChatMessage::assistant("patched it");
        msg.tools = vec![
            crate::models::ChatToolCall {
                name: "capability:edit".into(),
                id: Some("c1".into()),
                needs_approval: false,
                input: Some(serde_json::json!({
                    "file_path": "apps/tui/src/app.rs",
                    "old_string": "alpha",
                    "new_string": "omega",
                })),
                result: None,
                outcome: ToolOutcome::Ok,
            },
            // A non-editing call must not be counted.
            crate::models::ChatToolCall {
                name: "Bash".into(),
                id: Some("c2".into()),
                needs_approval: false,
                input: Some(serde_json::json!({ "command": "ls" })),
                result: None,
                outcome: ToolOutcome::Ok,
            },
        ];
        app.chat_messages = vec![msg];

        let uncursored = render(&app, 120, 40);
        assert!(
            uncursored.contains("1 change card"),
            "the turn must advertise its diff (and count only the edit): {uncursored:?}"
        );
        assert!(
            uncursored.contains("{ } to focus this turn"),
            "with no cursor, the hint must name the key that gets one: {uncursored:?}"
        );
        assert!(
            !uncursored.contains("Enter opens the diff"),
            "with no cursor Enter opens the COMPOSER — promising a diff is a lie: {uncursored:?}"
        );

        app.chat_focus = Some(0);
        let cursored = render(&app, 120, 40);
        assert!(
            cursored.contains("Enter opens the diff"),
            "once cursored, Enter really does open it: {cursored:?}"
        );
    }

    /// CALIBRATION. Every assertion above passes just as well if the overlay
    /// ignores `scroll` and always paints from line 0, or if it paints whenever
    /// the app is on the Operator tab rather than when a card is actually open.
    /// This is the test that can tell those apart.
    #[test]
    fn the_overlay_honours_scroll_and_paints_only_while_a_card_is_open() {
        // Scrolled past the removed line, it must leave the screen — and the
        // position indicator must agree with what is on it.
        let scrolled = render(&card_app(5), 120, 40);
        assert!(
            !scrolled.contains("-bravo"),
            "a scrolled viewport must drop the lines above it: {scrolled:?}"
        );
        assert!(scrolled.contains("+BRAVO"), "and keep the ones in it");
        assert!(
            scrolled.contains("6-7/7"),
            "the status line must report the visible range: {scrolled:?}"
        );

        // With no card open the overlay must not paint at all.
        let mut closed = card_app(0);
        closed.open_change_card = None;
        let text = render(&closed, 120, 40);
        for absent in ["Esc close", "@@ hunk 1/1 @@", "+BRAVO"] {
            assert!(
                !text.contains(absent),
                "the closed transcript must not paint {absent:?}: {text:?}"
            );
        }

        // The pinned single-pane dock returns early from `draw`, so it needs
        // the paint wired separately — the same omission that once left `N`
        // opening a notifications overlay that never drew in a dock pane. The
        // chat dock's operator pane is precisely where a card gets opened.
        let mut pinned = card_app(0);
        pinned.pinned = Some(Tab::Operator);
        let docked = render(&pinned, 120, 40);
        assert!(
            docked.contains("+BRAVO") && docked.contains("Esc close"),
            "the card must paint in a pinned dock pane too: {docked:?}"
        );
    }
}
