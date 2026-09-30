//! Fleet status view (pui-fleet-status-view-2026-06-04).
//!
//! The Fleet tab is the unified, fleet-wide dashboard the owner asked for —
//! "Claude's task panel, but with plan + subagent status, across the whole
//! fleet". It fuses four data sources:
//!   - **plan/work_item progress** — `app.plans` (itemCounts) + `work_items`.
//!   - **subagent status** — `app.roster` (coord presence), joined to each
//!     agent's latest activity + todo progress.
//!   - **a live activity overlay** — the worker-integration bridge stream
//!     (`/api/activity/stream`), seeded from `activity:recent`. Each row carries
//!     a server-enriched `summary` (`✎ generated.ts`, `▶ npm test`, `⇄ 3/5`).
//!   - **worker-todo mirroring** — the `kind:"todos"` activity rows, mapped to
//!     per-agent todo lists.
//!
//! Three modes: **curated** (default, calm — roster | dossier + plan
//! progress, whole-fleet by default, agent-filtered on selection, with a
//! `c`-toggled comms sub-view — pui-dock-consolidation-2026-06-07) and the
//! **faithful mirror** (the raw activity firehose), plus the semantic fleet
//! transition **tape** (P-026). All consume the same activity stream; `Tab`
//! cycles the mode.
//!
//! All state + render lives here; `app.rs`/`ui.rs` only hold a `fleet` field, a
//! `Tab::Fleet` arm, and a one-line `draw` delegation, so this barely collides
//! with the parallel pui work. Render is a pure function of `&App`.

use crate::app::App;
use crate::glyph;
use crate::models::{ActivityRow, BeeAssignment, RosterEntry, TodoSnapshot, WorkItem};
use crate::theme::Theme;
use crate::ui::trunc;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    text::{Line, Span},
    widgets::{List, ListItem, ListState, Paragraph},
    Frame,
};
use std::collections::HashMap;

/// Retained live-activity rows (newest-first). The mirror feed firehose is
/// bounded so a busy fleet never grows the ring without limit (P1 risk: render
/// perf / memory).
const ACTIVITY_CAP: usize = 400;

/// Which Fleet view mode is showing. Curated is the calm default, Mirror is the
/// drill-in firehose, and Tape is the lossless semantic transition ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FleetMode {
    /// Per-agent latest + plan progress; the calm default.
    Curated,
    /// The raw fleet-wide activity feed (every tool call).
    Mirror,
    /// The six durable fleet transition families, newest-first and ungrouped.
    Tape,
}

impl FleetMode {
    pub fn label(self) -> &'static str {
        match self {
            FleetMode::Curated => "curated",
            FleetMode::Mirror => "mirror",
            FleetMode::Tape => "tape",
        }
    }
    /// Parse a persisted label back to a mode (unknown → Curated, the default).
    pub fn from_label(s: &str) -> FleetMode {
        match s {
            "mirror" => FleetMode::Mirror,
            "tape" => FleetMode::Tape,
            _ => FleetMode::Curated,
        }
    }
}

/// Filter for the fleet transition Tape (P-026). The classes are shared with
/// the semantic transcript cards so both renderers interpret a row identically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TapeFilter {
    All,
    Exceptions,
    Claims,
    Gates,
}

impl TapeFilter {
    pub fn label(self) -> &'static str {
        match self {
            TapeFilter::All => "all",
            TapeFilter::Exceptions => "exceptions",
            TapeFilter::Claims => "claims",
            TapeFilter::Gates => "gates",
        }
    }

    fn matches(self, class: crate::semantic_tool_cards::FleetEventClass) -> bool {
        use crate::semantic_tool_cards::FleetEventClass;
        match self {
            TapeFilter::All => true,
            TapeFilter::Exceptions => class == FleetEventClass::Exception,
            TapeFilter::Claims => class == FleetEventClass::Claim,
            TapeFilter::Gates => class == FleetEventClass::Gate,
        }
    }
}

/// Which panel of the Fleet pane holds keyboard focus (owner ask 2026-06-14).
/// `h`/`l` (or ←/→) CYCLE through the visible panels — comms on:
/// Roster→Inbox→Outbox→Conversations; comms off: Roster→Dossier→PlanProgress —
/// and `j`/`k` (↑/↓) move WITHIN the focused panel (roster cursor / list
/// selection / scroll). Enter acts on the focused panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FleetPanel {
    Roster,
    Inbox,
    Outbox,
    Conversations,
    Dossier,
    PlanProgress,
}

impl FleetPanel {
    /// The ordered, cyclable panel set for the current Fleet layout: comms on =
    /// the mail/chat panels; comms off = the dossier + plan-progress panels.
    pub fn order(show_comms: bool) -> &'static [FleetPanel] {
        use FleetPanel::*;
        if show_comms {
            &[Roster, Inbox, Outbox, Conversations]
        } else {
            &[Roster, Dossier, PlanProgress]
        }
    }

    /// The panel `delta` steps away in the cyclic order (wraps both ends).
    pub fn cycle(self, show_comms: bool, delta: isize) -> FleetPanel {
        let order = FleetPanel::order(show_comms);
        let n = order.len() as isize;
        let cur = order.iter().position(|p| *p == self).unwrap_or(0) as isize;
        order[(((cur + delta) % n + n) % n) as usize]
    }

    /// Short display name for the nav legend.
    pub fn label(self) -> &'static str {
        match self {
            FleetPanel::Roster => "roster",
            FleetPanel::Inbox => "inbox",
            FleetPanel::Outbox => "outbox",
            FleetPanel::Conversations => "conversations",
            FleetPanel::Dossier => "task list",
            FleetPanel::PlanProgress => "plan progress",
        }
    }
}

/// One explicit leader-cockpit mutation. The reducer arms one of these from
/// the Fleet keymap, then a separate `y` press dispatches it through the
/// audited run-tool bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FleetControlKind {
    Bench,
    Wake,
    Relaunch,
    FireGate,
    BumpSpec,
}

impl FleetControlKind {
    pub fn verb(self) -> &'static str {
        match self {
            FleetControlKind::Bench => "fleet:bench",
            FleetControlKind::Wake => "coord:wake",
            FleetControlKind::Relaunch => "fleet:respawn-member",
            FleetControlKind::FireGate => "events:emit",
            FleetControlKind::BumpSpec => "scheduler:set_claim_spec",
        }
    }
}

/// Fully-resolved target captured at arm time. This is deliberately concrete:
/// member actions carry the roster cursor's owner id, and gate actions carry
/// the first currently-unfired announced gate. Confirmation never re-resolves
/// a moving cursor into a different target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FleetControlIntent {
    pub kind: FleetControlKind,
    pub fleet: String,
    pub member: String,
    pub member_label: String,
    /// The selected member's current CLI backend. A same-backend value is the
    /// explicit boot-setting delta `fleet:respawn-member` requires while still
    /// preserving model/account/carry and every other saved launch field.
    pub agent: Option<String>,
    pub gate: Option<String>,
}

impl FleetControlIntent {
    pub fn describe(&self) -> String {
        match self.kind {
            FleetControlKind::Bench => format!(
                "bench {} until {}",
                self.member_label,
                self.gate.as_deref().unwrap_or("the selected gate")
            ),
            FleetControlKind::Wake => format!("wake {}", self.member_label),
            FleetControlKind::Relaunch => format!("relaunch {}", self.member_label),
            FleetControlKind::FireGate => format!(
                "fire gate {}",
                self.gate.as_deref().unwrap_or("the selected gate")
            ),
            FleetControlKind::BumpSpec => {
                format!("bump claim spec for fleet {}", self.fleet)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FleetControlOutcome {
    pub ok: bool,
    pub message: String,
}

/// Fleet-tab state: the live activity ring, the fleet work-items, per-agent todo
/// snapshots, the view mode, and the agent-selection cursor.
pub struct FleetState {
    pub mode: FleetMode,
    pub tape_filter: TapeFilter,
    /// Live + backfilled activity rows, newest-first, capped at `ACTIVITY_CAP`.
    pub activity: Vec<ActivityRow>,
    /// Fleet-wide work items (features + issues + chunks).
    pub work_items: Vec<WorkItem>,
    /// Last `work_items:list` transport/decode error. This stays attached to
    /// the Fleet panel so a later successful poll of another panel cannot
    /// erase the diagnosis from the global status bar.
    pub work_items_error: Option<String>,
    /// Latest todo snapshot per worker (owner_id → snapshot), from `kind:"todos"`
    /// activity rows (D-004 worker-todo mirroring).
    pub agent_todos: HashMap<String, TodoSnapshot>,
    /// Selection cursor into the agent list (the roster).
    pub agent_sel: usize,
    /// Comms sub-view toggle (pui-dock-consolidation-2026-06-07, `c`): false =
    /// roster + dossier + plan-progress (default); true = roster + inbox/outbox
    /// (selected agent) over conversations (whole-fleet broadcasts + threads).
    pub show_comms: bool,
    /// Fleet-pane panel focus + per-panel cursors (owner ask 2026-06-14):
    /// which panel takes keys, the cursor into the SELECTED bee's inbox/outbox
    /// (rendered newest-first, so 0 = newest), the SELECTION cursor into the
    /// dossier (worklist) task list, and the SELECTION cursor into the
    /// plan-progress list (↑/↓ move them, Enter opens that row's detail popup —
    /// owner ask 2026-06-15). The conversations panel reuses `App::conversation_sel`.
    pub fleet_focus: FleetPanel,
    /// Two-level nav (owner ask 2026-06-15 #2): false = BROWSING panes (↑/↓
    /// switch the focused pane, Enter drills in); true = INSIDE the focused pane
    /// (↑/↓ move within, Enter acts, Esc steps back out). Reset to false whenever
    /// the focused pane changes via ←/→, the comms view toggles, or the mode flips.
    pub entered: bool,
    pub comms_inbox_sel: usize,
    pub comms_outbox_sel: usize,
    /// Selection cursor into the dossier (worklist) task list (owner ask
    /// 2026-06-16): ↑/↓ move a highlighted cursor over the tasks (skipping the
    /// per-bee header rows of the whole-fleet view), Enter opens the selected
    /// work item's detail popup — same idiom as plan-progress/mail/chat (it used
    /// to be a bare scroll offset with no item cursor).
    pub dossier_sel: usize,
    pub plan_progress_sel: usize,
    /// Whole-fleet assignments (every bee's ranked work-list), for the DEFAULT
    /// dossier when no agent is selected (#2: "show all tasks from the fleet").
    /// Refreshed on Fleet entry + periodically. A selection narrows to one bee's
    /// dossier (`app.bee`).
    pub all_assignments: Vec<crate::models::BeeAssignment>,
    /// Canonical whole-harness actionable frontier. This replaces the old
    /// corpus-shaped assignment list only when no individual agent is selected.
    pub frontier: Option<crate::models::WorkFrontier>,
    pub frontier_error: Option<String>,
    /// `/` toggles the bounded terminal archive sample already held in
    /// `work_items`; the exact archive count remains visible from `frontier`.
    pub frontier_archive_open: bool,
    /// The deterministic cockpit target: the active roster row whose
    /// `fleetRole` is `leader`.
    pub leader_fleet: Option<String>,
    pub leader_brief: Option<crate::models::FleetLeaderBrief>,
    pub leader_brief_error: Option<String>,
    /// Two-step cockpit action state. `pending` owns the modal y/n confirmation;
    /// `running` blocks double-fire while the async tool call is in flight; the
    /// last compact audited outcome remains visible until another action arms.
    pub control_pending: Option<FleetControlIntent>,
    pub control_running: Option<FleetControlIntent>,
    pub control_outcome: Option<FleetControlOutcome>,
}

impl Default for FleetState {
    fn default() -> Self {
        Self {
            mode: FleetMode::Curated,
            tape_filter: TapeFilter::All,
            activity: Vec::new(),
            work_items: Vec::new(),
            work_items_error: None,
            agent_todos: HashMap::new(),
            agent_sel: 0,
            show_comms: false,
            fleet_focus: FleetPanel::Roster,
            entered: false,
            comms_inbox_sel: 0,
            comms_outbox_sel: 0,
            dossier_sel: 0,
            plan_progress_sel: 0,
            all_assignments: Vec::new(),
            frontier: None,
            frontier_error: None,
            frontier_archive_open: false,
            leader_fleet: None,
            leader_brief: None,
            leader_brief_error: None,
            control_pending: None,
            control_running: None,
            control_outcome: None,
        }
    }
}

impl FleetState {
    /// Cycle curated → mirror → tape → curated.
    pub fn toggle_mode(&mut self) {
        self.mode = match self.mode {
            FleetMode::Curated => FleetMode::Mirror,
            FleetMode::Mirror => FleetMode::Tape,
            FleetMode::Tape => FleetMode::Curated,
        };
        // Mirror and Tape have no panes — drop any entered-pane state so
        // Curated reopens at the browsing level (owner ask 2026-06-15 #2).
        self.entered = false;
    }

    pub fn set_work_items(&mut self, items: Vec<WorkItem>) {
        self.work_items = items;
    }

    /// Replace the activity ring from a backfill (`activity:recent` returns
    /// newest-first), then ingest any todo snapshots it carries. Capped.
    pub fn seed_activity(&mut self, rows: Vec<ActivityRow>) {
        for r in &rows {
            self.ingest_todos(r);
        }
        self.activity = rows;
        self.activity.truncate(ACTIVITY_CAP);
    }

    /// Ingest a dedicated `kind:"todos"` backfill into the per-agent todo map
    /// WITHOUT touching the feed (todos are sparse; a kind-scoped fetch keeps the
    /// map current even when todo rows fall outside the general feed window).
    pub fn seed_todos(&mut self, rows: &[ActivityRow]) {
        for r in rows {
            self.ingest_todos(r);
        }
    }

    /// Prepend one live activity row (newest at index 0) + ingest todos. Capped.
    pub fn push_activity(&mut self, row: ActivityRow) {
        self.ingest_todos(&row);
        self.activity.insert(0, row);
        self.activity.truncate(ACTIVITY_CAP);
    }

    /// If `row` is a todo snapshot, record it as this agent's current todos.
    fn ingest_todos(&mut self, row: &ActivityRow) {
        if row.kind != "todos" {
            return;
        }
        if let Some(detail) = &row.detail {
            if let Ok(snap) = serde_json::from_value::<TodoSnapshot>(detail.clone()) {
                self.agent_todos.insert(row.owner_id.clone(), snap);
            }
        }
    }

    /// The most-recent activity row per `owner_id` (the ring is newest-first, so
    /// the first occurrence wins). Used to annotate each agent with what it's
    /// doing right now.
    pub fn latest_by_owner(&self) -> HashMap<&str, &ActivityRow> {
        let mut map: HashMap<&str, &ActivityRow> = HashMap::new();
        for r in &self.activity {
            map.entry(r.owner_id.as_str()).or_insert(r);
        }
        map
    }
}

/// A fleet-wide rollup computed at render time from plans + work-items + roster.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FleetAggregate {
    pub agents_online: usize,
    pub agents_total: usize,
    pub plan_items_done: u32,
    pub plan_items_total: u32,
    pub active_plans: usize,
    pub wi_total: usize,
    pub wi_features: usize,
    pub wi_issues: usize,
    pub wi_open_issues: usize,
    pub wi_features_passed: usize,
    /// Work items in a terminal/done state (features passed, issues resolved or
    /// closed) — the "done" half of D-002's work_item progress.
    pub wi_done: usize,
    /// Work items still open (total − done) — the "remaining" half.
    pub wi_remaining: usize,
}

/// Roll up the fleet headline numbers. Pure over `&App` (reads roster + plans +
/// fleet.work_items); no borrow of `app.fleet` is held mutably.
pub fn aggregate(app: &App) -> FleetAggregate {
    let agents_online = app.roster.iter().filter(|r| r.is_online()).count();
    let agents_total = app.roster.len();

    // Plan progress across the live (non-archived) plans — under the current
    // pot scope (D-003): All-Pots aggregates everything, pot scope just it.
    let mut plan_items_done = 0u32;
    let mut plan_items_total = 0u32;
    let mut active_plans = 0usize;
    for p in app.visible_plans().into_iter().filter(|p| !p.archived) {
        let total = p.item_counts.total();
        if total > 0 {
            active_plans += 1;
        }
        plan_items_done += p.item_counts.done;
        plan_items_total += total;
    }

    let wi = app.visible_work_items();
    let wi_features = wi.iter().filter(|w| w.family == "feature").count();
    let wi_issues = wi.iter().filter(|w| w.family == "issue").count();
    let wi_open_issues = wi
        .iter()
        .filter(|w| w.family == "issue" && w.state == "open")
        .count();
    let wi_features_passed = wi
        .iter()
        .filter(|w| w.family == "feature" && w.state == "passed")
        .count();
    // Done = features passed + issues resolved/closed (the terminal states).
    let wi_issues_done = wi
        .iter()
        .filter(|w| w.family == "issue" && (w.state == "resolved" || w.state == "closed"))
        .count();
    let wi_done = wi_features_passed + wi_issues_done;
    let wi_remaining = wi.len().saturating_sub(wi_done);

    FleetAggregate {
        agents_online,
        agents_total,
        plan_items_done,
        plan_items_total,
        active_plans,
        wi_total: wi.len(),
        wi_features,
        wi_issues,
        wi_open_issues,
        wi_features_passed,
        wi_done,
        wi_remaining,
    }
}

/// The HH:MM:SS slice of a Postgres timestamp like `2026-06-04 18:53:58.46-04`.
/// Falls back to the raw string (clipped) for an unexpected shape.
fn hms(ts: &str) -> String {
    // Prefer the time component after the date's space; else after a 'T'.
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

/// A fixed-width unicode progress bar, `done`/`total` filled over `width` cells.
fn progress_bar(done: u32, total: u32, width: usize) -> String {
    if total == 0 {
        return "─".repeat(width);
    }
    let filled = ((done as f64 / total as f64) * width as f64).round() as usize;
    let filled = filled.min(width);
    let mut s = String::with_capacity(width);
    for _ in 0..filled {
        s.push('█');
    }
    for _ in filled..width {
        s.push('░');
    }
    s
}

/// Render the Fleet tab. Pure over `&App`.
pub fn draw_fleet(f: &mut Frame, app: &App, area: Rect) {
    let agg = aggregate(app);

    // A 1-line headline strip above the body + a 1-line nav legend below it (the
    // legend makes the panel-cycle keys + the `c` layout toggle discoverable —
    // owner ask 2026-06-14). Curated mode only; the mirror firehose has no panels.
    let curated = app.fleet.mode == FleetMode::Curated;
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints(if curated {
            vec![
                Constraint::Length(1),
                Constraint::Min(1),
                Constraint::Length(1),
            ]
        } else {
            vec![Constraint::Length(1), Constraint::Min(1)]
        })
        .split(area);
    draw_headline(
        f,
        &agg,
        app.fleet.mode,
        app.fleet.work_items_error.as_deref(),
        rows[0],
    );

    let comms = app.fleet.show_comms && curated;
    if comms {
        // Comms sub-view (pui-dock-consolidation-2026-06-07, `c`): roster + the
        // selected agent's direct inbox/outbox over the whole-fleet conversations.
        draw_comms_view(f, app, rows[1]);
    } else {
        match app.fleet.mode {
            FleetMode::Curated => draw_curated(f, app, &agg, rows[1]),
            FleetMode::Mirror => draw_mirror(f, app, rows[1]),
            FleetMode::Tape => draw_tape(f, app, rows[1]),
        }
    }

    if curated {
        draw_fleet_legend(f, app, rows[2], comms);
    }
}

/// The always-visible nav legend (owner ask 2026-06-14): the focused panel + the
/// keys to move between/within panels + the `c` layout toggle. So the comms view
/// and panel navigation are discoverable without guessing `c`.
fn draw_fleet_legend(f: &mut Frame, app: &App, area: Rect, comms: bool) {
    if let Some(intent) = app.fleet.control_pending.as_ref() {
        let line = Line::from(vec![
            Span::styled(format!(" CONFIRM {} ", intent.describe()), Theme::warn()),
            Span::styled(" [y] execute · [n/Esc] cancel ", Theme::info()),
        ]);
        f.render_widget(Paragraph::new(line).style(Theme::status_bar()), area);
        return;
    }
    if let Some(intent) = app.fleet.control_running.as_ref() {
        let line = Line::from(Span::styled(
            format!(
                " … running {} via {} ",
                intent.describe(),
                intent.kind.verb()
            ),
            Theme::warn(),
        ));
        f.render_widget(Paragraph::new(line).style(Theme::status_bar()), area);
        return;
    }

    let toggle = if comms {
        "c: task-list+plans"
    } else {
        "c: mail+chat"
    };
    // Two-level nav (owner ask 2026-06-15 #2): the legend names which level you
    // are in — BROWSING panes (↑/↓ switch · ⏎ enter) vs INSIDE a pane (↑/↓ move ·
    // ⏎ open · Esc back).
    let (marker, keys) = if app.fleet.entered {
        (
            format!(" ▸ {} · inside ", app.fleet.fleet_focus.label()),
            "  ↑/↓ move · ⏎ open · Esc back · ",
        )
    } else {
        (
            format!(" ▸ {} ", app.fleet.fleet_focus.label()),
            "  ↑/↓ or ←/→ switch pane · ⏎ enter · ",
        )
    };
    // The roster cursor's agent leads the footer (WI-1355): its (shortened) id
    // plus the fleet it belongs to, so "who is the cursor on, and which fleet
    // are they in?" is answerable without leaving the roster. "—" when the
    // agent is in no fleet. Sourced from the roster entry already in the model
    // (RosterEntry.fleet_slug, stamped by adv-roster.ts).
    let mut spans: Vec<Span> = Vec::new();
    if let Some(outcome) = app.fleet.control_outcome.as_ref() {
        spans.push(Span::styled(
            format!(
                " {} {} · ",
                if outcome.ok { "✓" } else { "✗" },
                trunc(&outcome.message, 72)
            ),
            if outcome.ok {
                Theme::success()
            } else {
                Theme::warn()
            },
        ));
    }
    if let Some(sel) = app.selected_session() {
        spans.push(Span::styled(
            format!(" {} ", agent_id_fleet_label(sel)),
            Theme::info(),
        ));
        spans.push(Span::styled("·", Theme::dim()));
    }
    if control_target(app).is_some() {
        spans.push(Span::styled(
            " [b] bench [w] wake [r] relaunch [g] fire gate [s] bump spec · ",
            Theme::info(),
        ));
    }
    spans.push(Span::styled(marker, Theme::title_active()));
    spans.push(Span::styled(keys, Theme::info()));
    spans.push(Span::styled(toggle, Theme::info()));
    let line = Line::from(spans);
    f.render_widget(Paragraph::new(line).style(Theme::status_bar()), area);
}

/// The selected agent's identity for the Fleet footer (WI-1355): its shortened
/// owner id next to the fleet it belongs to — "—" when the agent is in no fleet
/// (or the slug is empty). Pure so it's unit-tested.
fn agent_id_fleet_label(entry: &crate::models::RosterEntry) -> String {
    let fleet = entry
        .fleet_slug
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("—");
    format!("id: {}  ·  fleet: {}", short_owner(&entry.owner_id), fleet)
}

/// Owner-id short form for display — up to the 2nd `-` (e.g. `su-b8fe880c`),
/// else the first 8 chars. Mirrors app.rs::short_owner so the footer id reads
/// the same as the rest of the TUI's owner shortening.
fn short_owner(owner: &str) -> String {
    let mut n = 0usize;
    for (i, c) in owner.char_indices() {
        if c == '-' {
            n += 1;
            if n == 2 {
                return owner[..i].to_string();
            }
        }
    }
    owner.chars().take(8).collect()
}

/// The comms sub-view (#3/#4): roster (left) | the selected agent's coord
/// **Inbox/Outbox** (right-top, direct messages — reused from `bee.rs`) over the
/// whole-fleet **Conversations** (right-bottom — broadcasts + multi-party
/// threads, the all-hands channel). The 3-way split (direct → inbox/outbox,
/// group → conversations, structured coord events → the dossier/swarm activity)
/// is how ALL fleet communication is captured.
fn draw_comms_view(f: &mut Frame, app: &App, area: Rect) {
    // The focused panel takes an active border + a highlighted row cursor; the
    // other three render quiet (owner ask 2026-06-14, `h`/`l`/`j`/`k` nav).
    let focus = app.fleet.fleet_focus;
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(46), Constraint::Percentage(54)])
        .split(area);
    draw_agents(f, app, cols[0], focus == FleetPanel::Roster);

    let right = Layout::default()
        .direction(Direction::Vertical)
        // inbox + outbox share the top half; conversations take the bottom half.
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(cols[1]);
    let mail = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(right[0]);
    let inbox_sel = (focus == FleetPanel::Inbox).then_some(app.fleet.comms_inbox_sel);
    let outbox_sel = (focus == FleetPanel::Outbox).then_some(app.fleet.comms_outbox_sel);
    let conv_sel = (focus == FleetPanel::Conversations).then_some(app.conversation_sel);
    crate::bee::draw_inbox(f, app, mail[0], inbox_sel);
    crate::bee::draw_outbox(f, app, mail[1], outbox_sel);
    draw_conversations_compact(f, app, right[1], conv_sel);
}

/// Whole-fleet conversations (broadcasts + multi-party threads) — the all-hands
/// channel. A compact list reusing the Conversations-tab data (`visible_conversations`).
fn draw_conversations_compact(f: &mut Frame, app: &App, area: Rect, sel: Option<usize>) {
    let convs = app.visible_conversations();
    let items: Vec<ListItem> = if convs.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "(no fleet conversations)",
            Theme::dim(),
        )))]
    } else {
        convs
            .iter()
            .enumerate()
            .map(|(idx, c)| {
                let k = match c.kind.as_str() {
                    "question" => "Q",
                    "discussion" => "D",
                    _ => "·",
                };
                let title = c.title.clone().unwrap_or_else(|| c.id.clone());
                let item = ListItem::new(Line::from(format!(
                    "{} {:<9} {}",
                    k,
                    trunc(&c.state, 9),
                    trunc(&title, 40)
                )));
                if sel == Some(idx) {
                    item.style(Theme::selected())
                } else {
                    item
                }
            })
            .collect()
    };
    let body = crate::ui::block_with_header(
        f,
        area,
        Theme::block(
            Line::from(format!(" {} conversations (fleet) ", glyph::nav::FLEET)),
            sel.is_some(),
        ),
        " all-hands — broadcasts + threads",
    );
    f.render_widget(List::new(items).style(Theme::panel()), body);
}

fn draw_headline(
    f: &mut Frame,
    agg: &FleetAggregate,
    mode: FleetMode,
    work_items_error: Option<&str>,
    area: Rect,
) {
    // SPAN ORDER IS THE DROP PRIORITY, and that is load-bearing rather than
    // cosmetic: this is a one-row `Paragraph` with no `.wrap()`, so ratatui
    // truncates at the right edge and the LAST spans are the ones that vanish
    // under width pressure. There is no separate elision pass to tune — ordering
    // is the whole mechanism.
    //
    // So the error goes immediately after the label, AHEAD of the stats blob.
    // WI-2141006: it used to follow that ~75-column blob, so a body under ~130
    // columns silently swallowed it — the headline dropped the one segment that
    // reports something is broken, precisely on the small terminals where a user
    // has least room to go looking. An error must be the last thing a headline
    // drops, not the first. Stats are recoverable by widening or by reading the
    // panels below; a dropped error is not recoverable at all, because nothing
    // tells you it was there.
    let mut spans = vec![
        // Label is "Fleet" — the cup-theme rename was reverted by the owner (2026-06-05).
        Span::styled(
            format!(" {} Fleet ", glyph::nav::FLEET),
            Theme::title_active(),
        ),
    ];
    if let Some(error) = work_items_error {
        spans.push(Span::styled(
            format!(" work-items error: {} · ", trunc(error, 48)),
            Theme::warn(),
        ));
    }
    spans.push(Span::raw(format!(
        " {}/{} online · plans {}/{} items ({} active) · work-items {}/{} done ({} open) · ",
        agg.agents_online,
        agg.agents_total,
        agg.plan_items_done,
        agg.plan_items_total,
        agg.active_plans,
        agg.wi_done,
        agg.wi_total,
        agg.wi_remaining,
    )));
    spans.push(Span::styled(
        format!("[{}]  Tab: curated→mirror→tape", mode.label()),
        Theme::info(),
    ));
    let line = Line::from(spans);
    f.render_widget(Paragraph::new(line).style(Theme::status_bar()), area);
}

/// Curated mode (D-006 — calm by default).
/// The default Swarm view (pui-dock-consolidation-2026-06-07): roster (left) |
/// dossier (right-top) + plan progress (right-bottom). The dossier + plan
/// progress default to the WHOLE FLEET; selecting an agent in the roster filters
/// both to that agent (#2). A leader cockpit is an explicit selected-leader view,
/// so an unrelated or stale brief never replaces the selected agent's dossier.
/// `c` swaps in the comms sub-view (handled in `draw_fleet`).
fn draw_curated(f: &mut Frame, app: &App, agg: &FleetAggregate, area: Rect) {
    // Whichever panel holds focus wears the active border (owner ask 2026-06-14);
    // `h`/`l` cycle Roster → Dossier → PlanProgress here.
    let focus = app.fleet.fleet_focus;
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(46), Constraint::Percentage(54)])
        .split(area);

    draw_agents(f, app, cols[0], focus == FleetPanel::Roster);

    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(56), Constraint::Percentage(44)])
        .split(cols[1]);
    if let Some(brief) = selected_leader_brief(app) {
        draw_leader_cockpit(f, app, brief, cols[1]);
    } else {
        draw_dossier(f, app, right[0], focus == FleetPanel::Dossier);
        draw_plan_progress(f, app, agg, right[1], focus == FleetPanel::PlanProgress);
    }
}

/// Return the loaded leader brief only for the explicitly selected, live leader
/// it belongs to. Leader briefs are fetched from a fleet-level read, while the
/// roster cursor and bee selection identify the agent the dossier is showing;
/// comparing both scopes keeps a brief for another fleet from taking over that
/// dossier. Requiring the explicit bee selection also preserves the whole-fleet
/// dossier on first entry, before the owner selects a roster row.
fn selected_leader_brief(app: &App) -> Option<&crate::models::FleetLeaderBrief> {
    let selected = app.selected_session()?;
    if !selected.is_live()
        || selected.fleet_role.as_deref() != Some("leader")
        || app.bee.owner_id.as_deref() != Some(selected.owner_id.as_str())
    {
        return None;
    }
    let fleet = selected
        .fleet_slug
        .as_deref()
        .filter(|slug| !slug.is_empty())?;
    if app.fleet.leader_fleet.as_deref() != Some(fleet) {
        return None;
    }
    let brief = app.fleet.leader_brief.as_ref()?;
    (brief.summary.fleet == fleet).then_some(brief)
}

/// The live fleet/member pair targeted by cockpit action keys. Unlike the
/// render-only `selected_leader_brief`, this accepts any roster member in the
/// acting leader's fleet: moving the roster cursor is how the owner chooses the
/// bench/wake/relaunch target without adding a second member cursor.
pub(crate) fn control_target(
    app: &App,
) -> Option<(
    &crate::models::RosterEntry,
    &crate::models::FleetLeaderBrief,
)> {
    if app.tab != crate::app::Tab::Fleet || app.fleet.mode != FleetMode::Curated {
        return None;
    }
    let selected = app.selected_session()?;
    let fleet = app.fleet.leader_fleet.as_deref()?;
    if selected.fleet_slug.as_deref() != Some(fleet) || selected.owner_id.is_empty() {
        return None;
    }
    let brief = app.fleet.leader_brief.as_ref()?;
    (brief.ok && brief.summary.fleet == fleet).then_some((selected, brief))
}

pub(crate) fn first_unfired_gate(
    brief: &crate::models::FleetLeaderBrief,
) -> Option<&crate::models::FleetLeaderGate> {
    brief
        .announced_gates
        .as_ref()?
        .iter()
        .find(|gate| !gate.fired)
}

fn draw_leader_cockpit(
    f: &mut Frame,
    app: &App,
    brief: &crate::models::FleetLeaderBrief,
    area: Rect,
) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage(46),
            Constraint::Percentage(27),
            Constraint::Percentage(27),
        ])
        .split(area);

    let mut members = vec![Line::from(vec![
        Span::styled(format!("{} ", brief.summary.fleet), Theme::title_active()),
        Span::raw(format!(
            "{} members · {} speaking · {} stalled · {} dead · ctx {}/{} high/critical",
            brief.summary.members,
            brief.summary.speaking,
            brief.summary.stalled,
            brief.summary.dead,
            brief.summary.high_context,
            brief.summary.critical_context,
        )),
    ])];
    members.extend(brief.members.iter().map(|member| {
        let state = member
            .session_state
            .as_deref()
            .or(member.verdict.as_deref())
            .unwrap_or("unknown");
        let context = member.context_pressure.as_deref().unwrap_or("?");
        let spoke = member
            .last_tool_call_age_ms
            .map(|age| format!("{}s", age.max(0) / 1000))
            .unwrap_or_else(|| "never".into());
        let work = if member.work_item_ids.is_empty() {
            "—".into()
        } else {
            member.work_item_ids.join(",")
        };
        Line::from(format!(
            "{:<12} {:<9} ctx:{:<8} spoke:{:<7} lane:{} q:{} load:{}",
            trunc(member.label.as_deref().unwrap_or(&member.agent_id), 12),
            trunc(state, 9),
            trunc(context, 8),
            spoke,
            trunc(&work, 18),
            member.queued_count,
            member.load,
        ))
    }));
    f.render_widget(
        Paragraph::new(members).block(Theme::block(" leader members ".into(), false)),
        rows[0],
    );

    let gates = match brief.announced_gates.as_ref() {
        None => vec![Line::from(Span::styled(
            "(gate read unavailable)",
            Theme::warn(),
        ))],
        Some(gates) if gates.is_empty() => vec![Line::from(Span::styled(
            "(no announced gates)",
            Theme::dim(),
        ))],
        Some(gates) => gates
            .iter()
            .map(|gate| {
                Line::from(format!(
                    "{} {:<3} waiters:{:<2} {}",
                    if gate.fired { "✓" } else { "○" },
                    if gate.fired { "open" } else { "held" },
                    gate.awaiters,
                    trunc(&gate.event, 42),
                ))
            })
            .collect(),
    };
    f.render_widget(
        Paragraph::new(gates).block(Theme::block(" announced gates ".into(), false)),
        rows[1],
    );

    let invariant_count = brief.custom_invariants.as_ref().map(Vec::len);
    let claimable = brief
        .summary
        .claimable_now
        .get("value")
        .and_then(serde_json::Value::as_i64);
    let mut lower = vec![Line::from(format!(
        "invariants: {} · admission blocks: {}",
        invariant_count
            .map(|count| count.to_string())
            .unwrap_or_else(|| "unavailable".into()),
        brief.admission_blocked.len(),
    ))];
    lower.extend(
        fleet_metric_lines(brief, claimable)
            .into_iter()
            .map(Line::from),
    );
    if app.fleet.control_pending.is_none() && app.fleet.control_running.is_none() {
        lower.push(Line::from(Span::styled(
            "[b] bench · [w] wake · [r] relaunch · [g] fire gate · [s] bump spec",
            Theme::info(),
        )));
    }
    f.render_widget(
        Paragraph::new(lower).block(Theme::block(
            " declared invariants + admission ".into(),
            false,
        )),
        rows[2],
    );
}

/// Render the canonical stock scope before any count. The old top-level
/// specMatched/harnessWidePool aliases remain a compatibility fallback for an
/// older operator, but are labelled as legacy because they carry no population,
/// window, unit, or exactness contract and therefore cannot be compared to a
/// canonical fleetMetrics snapshot (fleet-spec-scoped-metrics D-001/D-005).
fn fleet_metric_lines(
    brief: &crate::models::FleetLeaderBrief,
    claimable: Option<i64>,
) -> Vec<String> {
    match brief.fleet_metrics.as_ref() {
        Some(metrics) if metrics.ok => {
            let Some(snapshot) = metrics.snapshot.as_ref() else {
                return vec!["fleet metrics unavailable · malformed successful payload".into()];
            };
            vec![
                format!(
                    "stock: {} · spec {}@{} · window {}",
                    snapshot.remaining.total,
                    snapshot.scope.stock.spec_id,
                    snapshot.scope.stock.revision,
                    snapshot.scope.window.kind,
                ),
                format!(
                    "population: {} · unit: {} · quality {}/{}",
                    snapshot.scope.population.stock,
                    snapshot.remaining.unit,
                    snapshot.quality.exactness.status,
                    snapshot.quality.freshness.status,
                ),
            ]
        }
        Some(metrics) => vec![format!(
            "fleet metrics unavailable · {} · recover {}",
            metrics.reason.as_deref().unwrap_or("unknown reason"),
            metrics.recover_via.as_deref().unwrap_or("fleet:leader-brief"),
        )],
        None => vec![format!(
            "legacy queue aliases (scope unavailable): claimable {} · matched {} / pool {} · revision {}",
            claimable
                .map(|value| value.to_string())
                .unwrap_or_else(|| "?".into()),
            brief
                .spec_matched
                .map(|value| value.to_string())
                .unwrap_or_else(|| "?".into()),
            brief
                .harness_wide_pool
                .map(|value| value.to_string())
                .unwrap_or_else(|| "?".into()),
            brief
                .spec_revision
                .map(|value| value.to_string())
                .unwrap_or_else(|| "?".into()),
        )],
    }
}

/// The dossier region (#2): when an agent is selected in the roster, that bee's
/// ranked task list (reused from `bee.rs`, driven by the in-process selection
/// fetch); with NO selection, the whole-fleet task list (every bee's claimed
/// work, from `fleet.all_assignments`). `focused` adds the active border; the
/// `fleet.dossier_sel` cursor highlights the task ↑/↓ navigates (owner ask
/// 2026-06-16) — shared with `selected_dossier_item` so highlight + Enter agree.
fn draw_dossier(f: &mut Frame, app: &App, area: Rect, focused: bool) {
    let sel = Some(app.fleet.dossier_sel);
    if app.bee.owner_id.is_some() {
        crate::bee::draw_tasklist(f, app, area, focused, sel);
    } else {
        draw_all_tasklist(f, app, area, focused, sel);
    }
}

/// Selectable-task count in the current dossier scope (per-bee selection or
/// whole-fleet) — the clamp bound for `fleet.dossier_sel`.
pub(crate) fn dossier_task_count(app: &App) -> usize {
    if app.bee.owner_id.is_some() {
        app.bee
            .assignment
            .as_ref()
            .map(|a| a.queued.len())
            .unwrap_or(0)
    } else if app.fleet.frontier_archive_open {
        frontier_archive_rows(app).len()
    } else {
        frontier_rows(app).len()
    }
}

#[derive(Clone, Copy)]
pub(crate) enum DossierItem<'a> {
    Bee(&'a crate::models::BeeWorkItem),
    Frontier(FrontierRow<'a>),
    Archive(&'a WorkItem),
}

#[derive(Clone, Copy)]
pub(crate) enum FrontierRow<'a> {
    Ready(&'a crate::models::WorkFrontierRow),
    InFlight(
        &'a crate::models::WorkFrontierRow,
        Option<&'a crate::models::BeeAssignment>,
    ),
    NeedsYou(&'a crate::models::WorkFrontierParkedRow),
    Controlled(&'a crate::models::WorkFrontierParkedRow),
    Stuck(
        &'a crate::models::WorkFrontierRow,
        Option<&'a crate::models::BeeAssignment>,
    ),
}

fn frontier_assignment<'a>(
    app: &'a App,
    row: &crate::models::WorkFrontierRow,
) -> Option<&'a crate::models::BeeAssignment> {
    let owner = row.assignee.as_deref()?;
    app.fleet
        .all_assignments
        .iter()
        .find(|assignment| assignment.agent_id == owner)
}

fn assignment_item_is_stuck(assignment: &crate::models::BeeAssignment, item_id: &str) -> bool {
    let holds_item = assignment.queued.iter().any(|item| item.id == item_id);
    (holds_item && assignment.stalled)
        || assignment.orphaned
        || matches!(
            assignment.session_state.as_deref(),
            Some("draining" | "suspect" | "ended")
        )
        || matches!(
            assignment.verdict.as_deref(),
            Some("dead" | "suspect" | "orphan" | "residue")
        )
}

fn frontier_rows(app: &App) -> Vec<FrontierRow<'_>> {
    let Some(frontier) = app.fleet.frontier.as_ref() else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    rows.extend(frontier.unclaimed.iter().map(FrontierRow::Ready));
    rows.extend(frontier.in_flight.iter().filter_map(|row| {
        let assignment = frontier_assignment(app, row);
        (!assignment.is_some_and(|a| assignment_item_is_stuck(a, &row.id)))
            .then_some(FrontierRow::InFlight(row, assignment))
    }));
    rows.extend(
        frontier
            .parked
            .iter()
            .filter(|row| row.mechanism == "needs-human")
            .map(FrontierRow::NeedsYou),
    );
    rows.extend(
        frontier
            .parked
            .iter()
            .filter(|row| row.mechanism != "needs-human")
            .map(FrontierRow::Controlled),
    );
    rows.extend(frontier.in_flight.iter().filter_map(|row| {
        let assignment = frontier_assignment(app, row);
        assignment
            .is_some_and(|a| assignment_item_is_stuck(a, &row.id))
            .then_some(FrontierRow::Stuck(row, assignment))
    }));
    rows
}

fn terminal_work_item(item: &WorkItem) -> bool {
    matches!(
        item.state.as_str(),
        "done" | "passed" | "resolved" | "closed" | "deprecated" | "dropped"
    )
}

fn frontier_archive_rows(app: &App) -> Vec<&WorkItem> {
    app.fleet
        .work_items
        .iter()
        .filter(|item| terminal_work_item(item))
        .collect()
}

/// The work item under the dossier cursor (`fleet.dossier_sel`), flattened across
/// the current scope in render order. `None` when the dossier is empty.
pub(crate) fn selected_dossier_item(app: &App) -> Option<DossierItem<'_>> {
    let sel = app.fleet.dossier_sel;
    if app.bee.owner_id.is_some() {
        app.bee
            .assignment
            .as_ref()?
            .queued
            .get(sel)
            .map(DossierItem::Bee)
    } else if app.fleet.frontier_archive_open {
        frontier_archive_rows(app)
            .get(sel)
            .copied()
            .map(DossierItem::Archive)
    } else {
        frontier_rows(app)
            .get(sel)
            .copied()
            .map(DossierItem::Frontier)
    }
}

/// The dossier-popup body: the selected work item's detail (owner ask
/// 2026-06-16 — the dossier's Enter, matching plan-progress/mail/chat).
pub(crate) fn dossier_detail_lines(app: &App) -> Vec<Line<'static>> {
    match selected_dossier_item(app) {
        Some(DossierItem::Bee(w)) => work_item_detail_lines(w),
        Some(DossierItem::Frontier(row)) => frontier_detail_lines(row),
        Some(DossierItem::Archive(row)) => vec![
            Line::from(Span::styled(row.title.clone(), Theme::title_active())),
            Line::from(vec![
                Span::styled("id       ", Theme::dim()),
                Span::raw(row.id.clone()),
            ]),
            Line::from(vec![
                Span::styled("archive  ", Theme::dim()),
                Span::raw(format!("{} · {}", row.kind, row.state)),
            ]),
        ],
        None => vec![Line::from(Span::styled(
            "(no work item selected)",
            Theme::dim(),
        ))],
    }
}

fn frontier_detail_lines(row: FrontierRow<'_>) -> Vec<Line<'static>> {
    let (bucket, item, assignment, reason) = match row {
        FrontierRow::Ready(item) => ("READY NOW", item, None, None),
        FrontierRow::InFlight(item, assignment) => ("IN FLIGHT", item, assignment, None),
        FrontierRow::NeedsYou(parked) => (
            "NEEDS YOU",
            &parked.item,
            None,
            Some(parked.reason.as_str()),
        ),
        FrontierRow::Controlled(parked) => (
            frontier_control_bucket(parked),
            &parked.item,
            None,
            Some(parked.reason.as_str()),
        ),
        FrontierRow::Stuck(item, assignment) => ("STUCK", item, assignment, None),
    };
    let mut lines = vec![
        Line::from(Span::styled(item.title.clone(), Theme::title_active())),
        Line::from(vec![
            Span::styled("bucket   ", Theme::dim()),
            Span::raw(bucket.to_string()),
        ]),
        Line::from(vec![
            Span::styled("id       ", Theme::dim()),
            Span::raw(item.id.clone()),
        ]),
        Line::from(vec![
            Span::styled("state    ", Theme::dim()),
            Span::raw(item.state.clone()),
        ]),
    ];
    if item.blocks > 0 {
        lines.push(Line::from(vec![
            Span::styled("blocks   ", Theme::dim()),
            Span::raw(item.blocks.to_string()),
        ]));
    }
    if let Some(owner) = item.assignee.as_deref() {
        lines.push(Line::from(vec![
            Span::styled("holder   ", Theme::dim()),
            Span::raw(owner.to_string()),
        ]));
    }
    if let Some(assignment) = assignment {
        lines.push(Line::from(vec![
            Span::styled("session  ", Theme::dim()),
            Span::raw(
                assignment
                    .session_state
                    .clone()
                    .unwrap_or_else(|| "unknown".into()),
            ),
            Span::styled(" · context ", Theme::dim()),
            Span::raw(
                assignment
                    .context_pressure
                    .clone()
                    .unwrap_or_else(|| "unknown".into()),
            ),
        ]));
    }
    if let Some(reason) = reason {
        lines.push(Line::from(vec![
            Span::styled("reason   ", Theme::dim()),
            Span::raw(reason.to_string()),
        ]));
    }
    if let Some(control) = item.queue_control.as_ref() {
        if let Some(lease) = control.hold_open_lease.as_ref() {
            lines.push(Line::from(format!(
                "lease    {} · since {} · age {} · {}",
                lease.holder,
                lease.held_at.as_deref().unwrap_or("unknown"),
                frontier_control_age(&lease.age),
                lease.reason.as_deref().unwrap_or("no reason")
            )));
        }
        if let Some(park) = control.durable_park.as_ref() {
            lines.push(Line::from(format!(
                "park     {} · at {} · age {} · {}",
                park.parker.as_deref().unwrap_or("unattributed"),
                park.parked_at.as_deref().unwrap_or("unknown"),
                frontier_control_age(&park.age),
                park.reason.as_deref().unwrap_or("no reason")
            )));
            lines.push(Line::from(format!(
                "UNPARK   {} · {} · {}",
                park.unpark_condition.status,
                park.release_liveness.status,
                park.unpark_condition
                    .text
                    .as_deref()
                    .unwrap_or("condition not stated")
            )));
        }
        if let Some(review) = control.agent_review.as_ref() {
            lines.push(Line::from(format!(
                "review   {} · submitted by {} · round {}",
                review.status, review.submitted_by, review.round
            )));
        }
    }
    lines
}

fn frontier_control_age(age: &crate::models::QueueControlAge) -> &str {
    if age.bucket.is_empty() {
        if age.status.is_empty() {
            "unknown"
        } else {
            age.status.as_str()
        }
    } else {
        age.bucket.as_str()
    }
}

fn frontier_control_bucket(row: &crate::models::WorkFrontierParkedRow) -> &'static str {
    let control = row.item.queue_control.as_ref();
    if control.and_then(|c| c.durable_park.as_ref()).is_some() {
        "DURABLE PARK"
    } else if control.and_then(|c| c.hold_open_lease.as_ref()).is_some() {
        "HOLD-OPEN LEASE"
    } else if control.and_then(|c| c.agent_review.as_ref()).is_some()
        || row.mechanism == "agent-review"
    {
        "AGENT REVIEW"
    } else {
        "BLOCKED"
    }
}

/// The detail-popup body for one work item (id · kind · status · rank · who
/// placed it). The dossier rows are thin (`fleet:assignments` queued items), so
/// the popup just surfaces those fields rather than re-fetching.
fn work_item_detail_lines(w: &crate::models::BeeWorkItem) -> Vec<Line<'static>> {
    let title = if w.title.is_empty() {
        w.id.clone()
    } else {
        w.title.clone()
    };
    let mut out = vec![
        Line::from(Span::styled(title, Theme::title_active())),
        Line::from(vec![
            Span::styled("id       ", Theme::dim()),
            Span::raw(w.id.clone()),
        ]),
    ];
    if let Some(k) = w.item_kind.clone().filter(|s| !s.is_empty()) {
        out.push(Line::from(vec![
            Span::styled("kind     ", Theme::dim()),
            Span::raw(k),
        ]));
    }
    out.push(Line::from(vec![
        Span::styled("status   ", Theme::dim()),
        Span::raw(w.status.clone().unwrap_or_else(|| "—".to_string())),
        Span::styled("    rank  ", Theme::dim()),
        Span::raw(
            w.rank
                .map(|r| format!("#{r}"))
                .unwrap_or_else(|| "—".to_string()),
        ),
    ]));
    if let Some(wri) = w.rank_writer.clone().filter(|s| !s.is_empty()) {
        out.push(Line::from(vec![
            Span::styled("placed by", Theme::dim()),
            Span::raw(format!(" {wri}")),
        ]));
    }
    out
}

fn frontier_row_line(row: FrontierRow<'_>) -> Line<'static> {
    let (item, suffix, style) = match row {
        FrontierRow::Ready(item) => {
            let gates = if item.blocks > 0 {
                format!(" · blocks {}", item.blocks)
            } else {
                String::new()
            };
            (item, gates, Theme::success())
        }
        FrontierRow::NeedsYou(parked) => (
            &parked.item,
            format!(" · {}", trunc(&parked.reason, 34)),
            Theme::warn(),
        ),
        FrontierRow::Controlled(parked) => (
            &parked.item,
            format!(
                " · {} · {}",
                frontier_control_bucket(parked),
                trunc(&parked.reason, 28)
            ),
            Theme::warn(),
        ),
        FrontierRow::InFlight(item, assignment) | FrontierRow::Stuck(item, assignment) => {
            let owner = assignment
                .and_then(|a| a.name.as_deref().or(a.label.as_deref()))
                .or(item.assignee.as_deref())
                .unwrap_or("unknown");
            let context = assignment
                .and_then(|a| a.context_pressure.as_deref())
                .unwrap_or("unknown");
            let spoke = assignment
                .and_then(|a| a.last_tool_call_at.as_deref())
                .map(hms)
                .unwrap_or_else(|| "—".into());
            let style = if matches!(row, FrontierRow::Stuck(_, _)) {
                Theme::danger()
            } else {
                Theme::info()
            };
            (
                item,
                format!(
                    " · {} · ctx {} · spoke {}",
                    trunc(owner, 16),
                    context,
                    spoke
                ),
                style,
            )
        }
    };
    Line::from(Span::styled(
        format!(
            " {}  {}{}",
            trunc(&item.id, 18),
            trunc(&item.title, 46),
            suffix
        ),
        style,
    ))
}

fn frontier_bucket(row: FrontierRow<'_>) -> &'static str {
    match row {
        FrontierRow::Ready(_) => "READY NOW",
        FrontierRow::InFlight(_, _) => "IN FLIGHT",
        FrontierRow::NeedsYou(_) => "NEEDS YOU",
        FrontierRow::Controlled(parked) => frontier_control_bucket(parked),
        FrontierRow::Stuck(_, _) => "STUCK",
    }
}

/// Whole-fleet WORK FRONTIER. Unlike the former assignment corpus, this opens
/// on what can be acted on now; selecting a roster agent still preserves that
/// agent's ranked dossier unchanged.
fn draw_all_tasklist(f: &mut Frame, app: &App, area: Rect, focused: bool, sel: Option<usize>) {
    let mut items: Vec<ListItem> = Vec::new();
    let mut task_flat_idx: Vec<usize> = Vec::new();
    let (title, hint) = if app.fleet.frontier_archive_open {
        let rows = frontier_archive_rows(app);
        if rows.is_empty() {
            items.push(ListItem::new(Line::from(Span::styled(
                "(archive sample empty — press / for the live frontier)",
                Theme::dim(),
            ))));
        } else {
            for row in rows {
                task_flat_idx.push(items.len());
                items.push(ListItem::new(Line::from(Span::styled(
                    format!(
                        " {}  {} · {}",
                        trunc(&row.id, 18),
                        trunc(&row.title, 52),
                        row.state
                    ),
                    Theme::dim(),
                ))));
            }
        }
        let total = app
            .fleet
            .frontier
            .as_ref()
            .map(|frontier| frontier.terminal.total)
            .unwrap_or_else(|| frontier_archive_rows(app).len());
        (
            format!(" {} ARCHIVE ({total}) ", glyph::nav::FLEET),
            "/ frontier · cached terminal sample".to_string(),
        )
    } else {
        let rows = frontier_rows(app);
        if app.fleet.frontier.is_none() {
            let message = app
                .fleet
                .frontier_error
                .as_deref()
                .map(|error| format!("frontier unavailable: {}", trunc(error, 64)))
                .unwrap_or_else(|| "(loading work frontier…)".into());
            items.push(ListItem::new(Line::from(Span::styled(
                message,
                Theme::dim(),
            ))));
        } else {
            let mut bucket = "";
            for row in rows {
                let next = frontier_bucket(row);
                if next != bucket {
                    bucket = next;
                    items.push(ListItem::new(Line::from(Span::styled(
                        format!("── {bucket} ──"),
                        match bucket {
                            "READY NOW" => Theme::success(),
                            "NEEDS YOU" => Theme::warn(),
                            "STUCK" => Theme::danger(),
                            _ => Theme::info(),
                        },
                    ))));
                }
                task_flat_idx.push(items.len());
                items.push(ListItem::new(frontier_row_line(row)));
            }
        }
        let (ready, in_flight, parked, archive) = app
            .fleet
            .frontier
            .as_ref()
            .map(|frontier| {
                (
                    frontier.counts.unclaimed,
                    frontier.counts.in_flight,
                    frontier.counts.parked,
                    frontier.terminal.total,
                )
            })
            .unwrap_or_default();
        let needs_you = app
            .fleet
            .frontier
            .as_ref()
            .map(|frontier| {
                frontier
                    .parked
                    .iter()
                    .filter(|row| row.mechanism == "needs-human")
                    .count()
            })
            .unwrap_or(0);
        let blocked = parked.saturating_sub(needs_you);
        (
            format!(" {} WORK FRONTIER ", glyph::nav::FLEET),
            format!(
                "select agent for fleet task list · / archive {archive} · ready {ready} · in flight {in_flight} · needs you {needs_you} shown · blocked {blocked}"
            ),
        )
    };
    let body =
        crate::ui::block_with_header(f, area, Theme::block(Line::from(title), focused), &hint);
    // Highlight + auto-scroll to the cursor's task row (owner ask 2026-06-16);
    // `sel=None` (or an empty list) just renders the rows.
    let mut state = ListState::default();
    if let Some(i) = sel {
        if let Some(&flat) = task_flat_idx.get(i.min(task_flat_idx.len().saturating_sub(1))) {
            state.select(Some(flat));
        }
    }
    let list = List::new(items)
        .style(Theme::panel())
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body, &mut state);
}

/// Authoritative lifecycle state for a roster row. Known shared-oracle values
/// always win. Heartbeat-age tones are compatibility-only for an older or
/// degraded payload whose oracle state is absent/unknown.
fn roster_session_state(r: &RosterEntry) -> &str {
    match r
        .session_state
        .as_deref()
        .map(str::trim)
        .filter(|state| !state.is_empty())
    {
        Some(state @ ("live" | "parked" | "draining" | "suspect" | "ended" | "recorded")) => state,
        Some(_) | None if r.stale || r.liveness.eq_ignore_ascii_case("stale") => "stale",
        Some(_) | None if r.liveness.eq_ignore_ascii_case("live") => "live",
        Some(_) | None if r.liveness.eq_ignore_ascii_case("idle") => "idle",
        Some(_) | None => "unknown",
    }
}

fn session_state_is_terminal(state: &str) -> bool {
    matches!(state, "draining" | "suspect" | "ended" | "stale")
}

fn assignment_for_owner<'a>(app: &'a App, owner_id: &str) -> Option<&'a BeeAssignment> {
    app.fleet
        .all_assignments
        .iter()
        .find(|a| a.agent_id == owner_id)
        .or_else(|| {
            app.bee
                .assignment
                .as_ref()
                .filter(|a| a.agent_id == owner_id)
        })
}

/// The roster's "spoke" clock comes ONLY from the assignments surface's
/// lastToolCallAt field. A heartbeat timestamp is deliberately not accepted.
fn spoke_text(assignment: Option<&BeeAssignment>) -> String {
    assignment
        .and_then(|a| a.last_tool_call_at.as_deref())
        .filter(|ts| !ts.trim().is_empty())
        .map(hms)
        .unwrap_or_else(|| "—".to_string())
}

fn context_pressure_style(bucket: &str) -> ratatui::style::Style {
    match bucket {
        "critical" => Theme::danger(),
        "high" => Theme::warn(),
        "ok" => Theme::success(),
        _ => Theme::dim(),
    }
}

/// Compact shared-oracle legend. These are lifecycle classes, not heartbeat
/// thresholds: a fresh keepalive on an ended session remains ended/dim.
fn liveness_legend_spans() -> Vec<Span<'static>> {
    let entries: [(&str, &str, bool, &str); 3] = [
        (glyph::liveness::LIVE, "live turn", false, "live"),
        (glyph::liveness::IDLE, "parked/recorded", false, "parked"),
        (
            glyph::liveness::STALE,
            "draining/suspect/ended",
            true,
            "ended",
        ),
    ];
    let mut spans: Vec<Span<'static>> = Vec::new();
    for (i, (dot, label, stale, liveness)) in entries.into_iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled(
                " · ",
                ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray),
            ));
        }
        spans.push(Span::styled(
            format!("{dot} {label}"),
            Theme::liveness_style(stale, liveness),
        ));
    }
    spans
}

/// The MANUAL wake-mode badge text (P-008): the staged-wake count rides on the
/// badge when anything is pending review (" ⏸MANUAL·3"), bare otherwise.
fn wake_badge_text(pending: i64) -> String {
    if pending > 0 {
        format!(" ⏸MANUAL·{pending}")
    } else {
        " ⏸MANUAL".to_string()
    }
}

/// Parse an `#rrggbb` hex string into a ratatui RGB color; None on any malformed
/// input (the caller falls back to a neutral header). (fleet-color-schemes #3)
fn parse_hex_color(hex: &str) -> Option<ratatui::style::Color> {
    let h = hex.strip_prefix('#').unwrap_or(hex);
    if h.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&h[0..2], 16).ok()?;
    let g = u8::from_str_radix(&h[2..4], 16).ok()?;
    let b = u8::from_str_radix(&h[4..6], 16).ok()?;
    Some(ratatui::style::Color::Rgb(r, g, b))
}

/// The fg colour for an agent's NAME (and glyph) in the fleet roster
/// (fleet-color-schemes): the fleet's bound accent when the agent is in a fleet
/// (so a fleet reads as one colour, independent of the per-type tint flag), else
/// the per-type colour when the hive_agent_tabs tint is on, else None (plain).
/// Precedence: fleet > type > none. Pure — unit-tested.
fn agent_name_color(
    fleet_fg: Option<ratatui::style::Color>,
    hive_agent_tabs: bool,
    kind: Option<crate::agent_pane_kind::AgentPaneKind>,
) -> Option<ratatui::style::Color> {
    fleet_fg.or_else(|| {
        if hive_agent_tabs {
            kind.map(|k| k.color())
        } else {
            None
        }
    })
}

/// The fleet a roster row groups under: its non-empty `fleet_slug`, else None
/// ("No fleet"). (fleet-color-schemes #3)
fn group_key(r: &crate::models::RosterEntry) -> Option<String> {
    r.fleet_slug
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// A non-selectable fleet group-header row for the agents roster: the fleet name +
/// member count, painted in the fleet's bound accent color (the "No fleet" group
/// stays neutral/dim). (fleet-color-schemes #3)
fn fleet_header_item(
    group: &Option<String>,
    count: usize,
    color_hex: Option<&str>,
) -> ListItem<'static> {
    match group {
        Some(slug) => {
            let label = format!("▸ {} ({})", slug, count);
            let base =
                ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::BOLD);
            let style = match color_hex.and_then(parse_hex_color) {
                Some(c) => base.fg(c),
                None => base,
            };
            ListItem::new(Line::from(Span::styled(label, style)))
        }
        None => ListItem::new(Line::from(Span::styled(
            format!("▸ No fleet ({})", count),
            Theme::dim(),
        ))),
    }
}

/// The agent list — roster joined to each agent's latest activity summary + todo
/// progress. The navigable spine of the Fleet tab (j/k). Grouped by fleet (#3):
/// a colored header per fleet + a neutral "No fleet" group, with the cursor
/// mapped past the (non-selectable) headers.
fn draw_agents(f: &mut Frame, app: &App, area: Rect, focused: bool) {
    let latest = app.fleet.latest_by_owner();
    // The plans-filtered roster (D-009) — `fleet.agent_sel` indexes THIS list.
    let roster = app.visible_roster();
    // Build the agent rows (content unchanged); fleet group headers are
    // interleaved in a second pass below so the row build + its lifetimes are
    // untouched. (fleet-color-schemes #3)
    let agent_items: Vec<ListItem> = roster
        .iter()
        .map(|r| {
            // Shared lifecycle verdict — heartbeat is only a compatibility
            // fallback when this payload lacks a known sessionState.
            let session_state = roster_session_state(r);
            let terminal = session_state_is_terminal(session_state);
            let dot = Theme::liveness_marker(terminal, session_state);
            let assignment = assignment_for_owner(app, &r.owner_id);
            let pressure = assignment
                .and_then(|a| a.context_pressure.as_deref())
                .filter(|bucket| !bucket.trim().is_empty())
                .unwrap_or("—");
            let spoke = spoke_text(assignment);
            // P-004 (progress-tab-agents-convergence, owner ask 2026-06-11): the
            // kind GLYPH leads each roster row — ☕ mug · 🫖 kettle · 🍵 cup ·
            // 🥤 papercup · 📋 planner · 🛠 su (the owner's own psu sessions) — so workers and
            // owner sessions read apart at a glance, same vocabulary as the pane
            // titles. Flag-on; flag-off keeps the legacy dot-only row.
            let kind = crate::agent_pane_kind::AgentPaneKind::from_opt(&r.agent_pane_kind);
            // fleet-color-schemes: an agent IN a fleet shares its fleet's accent
            // (the SAME colour as its group header) so the whole fleet reads as one
            // colour block; unfleeted agents keep the per-type tint (P-010). The
            // kind GLYPH still carries the type at a glance.
            let fleet_fg = r.fleet_color.as_deref().and_then(parse_hex_color);
            let glyph_cell = match (app.hive_agent_tabs, kind) {
                (true, Some(k)) => Span::styled(
                    format!("{} ", k.glyph()),
                    ratatui::style::Style::default().fg(fleet_fg.unwrap_or_else(|| k.color())),
                ),
                (true, None) => Span::raw("  ".to_string()),
                _ => Span::raw(String::new()),
            };
            let agent = r.agent.clone().unwrap_or_else(|| "-".into());
            // The "what it's doing" cell: live activity summary, else intent/role.
            let act = latest
                .get(r.owner_id.as_str())
                .and_then(|a| a.summary.clone())
                .filter(|s| !s.is_empty())
                .or_else(|| r.intent.clone().filter(|s| !s.is_empty()))
                .or_else(|| r.feature.clone().filter(|s| !s.is_empty()))
                .unwrap_or_default();
            let todo = app
                .fleet
                .agent_todos
                .get(&r.owner_id)
                .map(|t| format!("⇄{}/{}", t.done, t.count))
                .unwrap_or_default();
            // P-010: flag-on, tint the agent name by its pane-type (Queen/Bee/
            // Sentinel/Planner). zellij has no per-pane color (D-008), so pui draws
            // it here where it owns the chrome. Flag-off → plain (current).
            let agent_cell = format!(" {:<6} ", trunc(&agent, 6));
            // Name colour: the fleet accent when in a fleet (independent of the
            // hive_agent_tabs flag that drives the per-type tint — matching the
            // always-on group headers), else the per-type colour (P-010), else plain.
            let agent_span = match agent_name_color(fleet_fg, app.hive_agent_tabs, kind) {
                Some(c) => Span::styled(agent_cell, ratatui::style::Style::default().fg(c)),
                None => Span::raw(agent_cell),
            };
            // P-008: flag-on, a wake-mode badge — `manual` is the notable (paused)
            // state; `auto` is the default → no badge, uncluttered. The staged-wake
            // COUNT rides on the badge so the owner sees review-pending work at a
            // glance ('W' opens the P-009 review overlay).
            let wake_badge = if app.hive_agent_tabs && r.wake_mode.as_deref() == Some("manual") {
                Span::styled(
                    wake_badge_text(r.pending_wakes),
                    ratatui::style::Style::default().fg(ratatui::style::Color::Yellow),
                )
            } else {
                Span::raw("")
            };
            // Claim discipline: declared on a plan but holding no claim backing
            // it — the lane is invisible to the Queen/peers. Yellow ⚠ so an
            // "active" row without a claimed lane reads differently at a glance.
            let unclaimed_badge = if app.hive_agent_tabs && r.declared_unclaimed {
                Span::styled(
                    " ⚠unclaimed",
                    ratatui::style::Style::default().fg(ratatui::style::Color::Yellow),
                )
            } else {
                Span::raw("")
            };
            // Enter-route tag (owner ask 2026-06-11): what Enter will do for
            // THIS row — ⏎ pane / ⏎ window / ⏎ resume / ⏎ menu — so a
            // non-resumable agent is visible before the keypress, not after a
            // silent one. Resume is the high-signal route → green; the rest
            // stay dim chrome.
            let hint = app.enter_hint(r);
            let hint_span = if hint == "⏎ resume" {
                Span::styled(
                    format!(" {hint}"),
                    ratatui::style::Style::default().fg(ratatui::style::Color::Green),
                )
            } else {
                Span::styled(format!(" {hint}"), Theme::dim())
            };
            ListItem::new(Line::from(vec![
                dot,
                glyph_cell,
                agent_span,
                Span::raw(format!("{:<30} ", trunc(&act, 30))),
                Span::styled(format!("{:<8}", trunc(&todo, 7)), Theme::dim()),
                Span::styled(
                    format!("{:<10}", trunc(session_state, 9)),
                    Theme::liveness_style(terminal, session_state),
                ),
                Span::styled(
                    format!("{:<12}", format!("ctx:{pressure}")),
                    context_pressure_style(pressure),
                ),
                Span::styled(format!("spoke:{spoke}"), Theme::dim()),
                wake_badge,
                unclaimed_badge,
                hint_span,
            ]))
        })
        .collect();
    // Interleave fleet group headers (#3): visible_roster() already orders the
    // roster fleet-grouped (alphabetical, "No fleet" last), so same-fleet rows are
    // contiguous. A colored header opens each fleet; `agent_row_idx` maps the Nth
    // agent to its flat row so the agent_sel cursor skips headers (the
    // draw_all_tasklist task_flat_idx pattern).
    let mut counts: std::collections::HashMap<Option<String>, usize> =
        std::collections::HashMap::new();
    for &r in roster.iter() {
        *counts.entry(group_key(r)).or_insert(0) += 1;
    }
    let mut items: Vec<ListItem> = Vec::new();
    let mut agent_row_idx: Vec<usize> = Vec::new();
    let mut cur_group: Option<Option<String>> = None;
    let mut agent_iter = agent_items.into_iter();
    for &r in roster.iter() {
        let g = group_key(r);
        if cur_group.as_ref() != Some(&g) {
            let n = counts.get(&g).copied().unwrap_or(0);
            items.push(fleet_header_item(&g, n, r.fleet_color.as_deref()));
            cur_group = Some(g.clone());
        }
        agent_row_idx.push(items.len());
        if let Some(item) = agent_iter.next() {
            items.push(item);
        }
    }
    let mut state = ListState::default();
    if !agent_row_idx.is_empty() {
        // map agent_sel (an agents-only index) → its flat row (headers interleave)
        let sel = app
            .fleet
            .agent_sel
            .min(agent_row_idx.len().saturating_sub(1));
        state.select(Some(agent_row_idx[sel]));
    }
    let body = if items.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "(no agents in the fleet) — press n to launch one here",
            Theme::dim(),
        )))]
    } else {
        items
    };
    // The plans-filter badge (D-009) keeps an active-but-hidden rail visible.
    // `Enter: reach` advertises the Enter-by-location routing (D-001).
    let title = if app.plan_filter.is_empty() {
        format!(" Agents ({}) · Enter: reach · n: launch ", roster.len())
    } else {
        format!(
            " Agents ({}/{}) · F:plans({}) · Enter: reach · n: launch ",
            roster.len(),
            app.roster.len(),
            app.plan_filter.len()
        )
    };
    // Styled column header above the roster (D-005) — one compact legend line
    // rides above it (owner ask 2026-06-11): the kind glyphs (☕ 🫖 🍵 🥤 📋 🛠,
    // flag-on — flag-off rows carry no glyphs) + the liveness dots with their
    // shared-oracle lifecycle classes (always — the dots render regardless of flag).
    let header = format!(
        "    {:<7}{:<31}{:<8}{:<10}{:<12}{}",
        "agent", "doing now", "todos", "state", "context", "spoke"
    );
    let mut legend_spans: Vec<Span<'static>> = Vec::new();
    if app.hive_agent_tabs {
        legend_spans.extend(crate::agent_pane_kind::legend_line(&app.lexicon).spans);
        legend_spans.push(Span::raw("   "));
    } else {
        legend_spans.push(Span::raw(" "));
    }
    legend_spans.extend(liveness_legend_spans());
    let header_rows: Vec<Line<'static>> = vec![
        Line::from(legend_spans),
        Line::from(Span::styled(header, Theme::header())),
    ];
    let body_area = crate::ui::block_with_header_rows(
        f,
        area,
        Theme::block(Line::from(title), focused),
        header_rows,
    );
    let list = List::new(body)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);
}

/// The ordered plan list shown in the Plan Progress panel: live (non-archived)
/// plans that have items, ordered priority desc then remaining-work desc (the
/// plans that need attention float up). With an agent selected in the roster
/// (#2), narrows to the plans that agent is linked to (declared plan + claim
/// plan-slugs from `fleet:assignments`). Shared by the renderer and the
/// Enter-to-open-detail selection so the highlighted row and the popup never
/// describe different plans.
pub(crate) fn plan_progress_list(app: &App) -> Vec<&crate::models::PlanSummary> {
    // The selected agent's plan-set (None = no selection → whole fleet). Prefer
    // the whole-fleet snapshot; fall back to the per-bee dossier fetch.
    let agent_plans: Option<std::collections::HashSet<&str>> =
        app.bee.owner_id.as_deref().map(|owner| {
            app.fleet
                .all_assignments
                .iter()
                .find(|a| a.agent_id == owner)
                .or(app.bee.assignment.as_ref())
                .map(|a| a.plan_slugs())
                .unwrap_or_default()
        });

    // Pot-scope-filtered (D-003), matching the aggregate's headline numbers.
    let mut plans: Vec<&crate::models::PlanSummary> = app
        .visible_plans()
        .into_iter()
        .filter(|p| !p.archived && p.item_counts.total() > 0)
        .filter(|p| {
            agent_plans
                .as_ref()
                .is_none_or(|set| set.contains(p.slug.as_str()))
        })
        .collect();
    plans.sort_by(|a, b| {
        b.priority
            .unwrap_or(0)
            .cmp(&a.priority.unwrap_or(0))
            .then(b.item_counts.remaining().cmp(&a.item_counts.remaining()))
    });
    plans
}

/// The Fleet plan-progress popup body: resolve the plan under the cursor
/// (`plan_progress_list` + `fleet.plan_progress_sel`, so the popup always
/// describes the SAME plan the panel highlights), then render its detail.
/// `(no plan selected)` when the list is empty.
pub(crate) fn plan_detail_lines(app: &App) -> Vec<Line<'static>> {
    let plans = plan_progress_list(app);
    match plans.get(
        app.fleet
            .plan_progress_sel
            .min(plans.len().saturating_sub(1)),
    ) {
        Some(p) => plan_detail_lines_for(p),
        None => vec![Line::from(Span::styled("(no plan selected)", Theme::dim()))],
    }
}

/// The detail-popup body for a single plan (owner ask 2026-06-15): identity
/// (slug/title/status/priority/owner/harness/updated), the full per-status item
/// breakdown with a progress bar, and the plan's `## Now` next action. Shared by
/// the Fleet plan-progress popup AND the Plans-tab popup so both surfaces show
/// the same rich detail.
pub(crate) fn plan_detail_lines_for(p: &crate::models::PlanSummary) -> Vec<Line<'static>> {
    let c = &p.item_counts;
    let title = if p.title.is_empty() {
        p.slug.clone()
    } else {
        p.title.clone()
    };
    let mut out = vec![
        Line::from(Span::styled(title, Theme::title_active())),
        Line::from(vec![
            Span::styled("slug     ", Theme::dim()),
            Span::raw(p.slug.clone()),
        ]),
        Line::from(vec![
            Span::styled("status   ", Theme::dim()),
            Span::raw(if p.status.is_empty() {
                "—".to_string()
            } else {
                p.status.clone()
            }),
            Span::styled("    priority  ", Theme::dim()),
            Span::raw(
                p.priority
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "—".to_string()),
            ),
        ]),
    ];
    if let Some(owner) = p.owner.clone().filter(|s| !s.is_empty()) {
        out.push(Line::from(vec![
            Span::styled("owner    ", Theme::dim()),
            Span::raw(owner),
        ]));
    }
    if let Some(h) = p.harness.clone().filter(|s| !s.is_empty()) {
        out.push(Line::from(vec![
            Span::styled("harness  ", Theme::dim()),
            Span::raw(h),
        ]));
    }
    if !p.updated.is_empty() {
        out.push(Line::from(vec![
            Span::styled("updated  ", Theme::dim()),
            Span::raw(p.updated.clone()),
        ]));
    }
    out.push(Line::from(Span::styled("─".repeat(44), Theme::dim())));
    out.push(Line::from(vec![
        Span::styled("progress ", Theme::dim()),
        Span::styled(progress_bar(c.done, c.total(), 16), Theme::selected()),
        Span::raw(format!(
            " {}/{} done · {} remaining",
            c.done,
            c.total(),
            c.remaining()
        )),
    ]));
    // Per-status breakdown — only the buckets that have items, so the popup stays
    // compact for a simple plan.
    let buckets = [
        ("todo", c.todo),
        ("wip", c.wip),
        ("blocked", c.blocked),
        ("needs-human", c.needs_human),
        ("done", c.done),
        ("dropped", c.dropped),
        ("unknown", c.unknown),
    ];
    for (label, n) in buckets.into_iter().filter(|(_, n)| *n > 0) {
        out.push(Line::from(vec![
            Span::styled(format!("  {label:<12}"), Theme::dim()),
            Span::raw(n.to_string()),
        ]));
    }
    if let Some(next) = p.next_action.clone().filter(|s| !s.is_empty()) {
        out.push(Line::from(Span::styled("─".repeat(44), Theme::dim())));
        out.push(Line::from(Span::styled("next", Theme::info())));
        for l in next.lines() {
            out.push(Line::from(l.to_string()));
        }
    }
    out
}

/// Fleet-wide plan progress — one bar per live plan from `plan_progress_list`.
/// A SELECTABLE list (owner ask 2026-06-15): the `fleet.plan_progress_sel` cursor
/// highlights the plan Enter opens in a detail popup, and a `ListState` gives the
/// highlight + auto-scroll (same idiom as the roster). With an agent selected in
/// the roster (#2) the list narrows to that agent's plans; Esc clears.
fn draw_plan_progress(f: &mut Frame, app: &App, agg: &FleetAggregate, area: Rect, focused: bool) {
    let plans = plan_progress_list(app);
    let agent_filtered = app.bee.owner_id.is_some();

    let items: Vec<ListItem> = plans
        .iter()
        .map(|p| {
            let c = &p.item_counts;
            ListItem::new(Line::from(vec![
                Span::raw(format!("{:<26} ", trunc(&p.slug, 26))),
                Span::styled(progress_bar(c.done, c.total(), 10), Theme::selected()),
                Span::raw(format!(" {}/{}", c.done, c.total())),
            ]))
        })
        .collect();
    let empty = items.is_empty();
    let body = if empty {
        vec![ListItem::new(Line::from(Span::styled(
            if agent_filtered {
                "(no plans for this agent — Esc for the whole fleet)"
            } else {
                "(no plan items)"
            },
            Theme::dim(),
        )))]
    } else {
        items
    };
    let title = match app.bee.name.as_deref().or(app.bee.owner_id.as_deref()) {
        Some(who) if agent_filtered => {
            format!(" Plan progress — {} (Esc clears) ", trunc(who, 24))
        }
        _ => format!(
            " Plan progress — {}/{} items done ",
            agg.plan_items_done, agg.plan_items_total
        ),
    };
    // Clamp the cursor against a shrinking list (an agent selection can narrow
    // it). No separate scroll offset — ListState auto-scrolls to the selection.
    let mut state = ListState::default();
    if !empty {
        state.select(Some(
            app.fleet
                .plan_progress_sel
                .min(plans.len().saturating_sub(1)),
        ));
    }
    let list = List::new(body)
        .style(Theme::panel())
        .highlight_style(Theme::selected())
        .highlight_symbol("> ")
        .block(Theme::block(Line::from(title), focused));
    f.render_stateful_widget(list, area, &mut state);
}

/// Mirror mode: the raw fleet-wide activity firehose, newest-first.
fn draw_mirror(f: &mut Frame, app: &App, area: Rect) {
    // Pot-scope-filtered (D-003).
    let activity = app.visible_fleet_activity();
    let items: Vec<ListItem> = activity
        .iter()
        .map(|a| {
            let agent = a.agent.clone().unwrap_or_else(|| "-".into());
            let harness = a.harness_slug.clone().unwrap_or_default();
            let summary = a
                .summary
                .clone()
                .unwrap_or_else(|| a.tool_name.clone().unwrap_or_else(|| a.kind.clone()));
            ListItem::new(Line::from(vec![
                Span::styled(format!("{:<8} ", hms(&a.created_at)), Theme::dim()),
                Span::raw(format!("{:<6} ", trunc(&agent, 6))),
                Span::styled(format!("{:<12} ", trunc(&harness, 12)), Theme::dim()),
                Span::raw(trunc(&summary, 48)),
            ]))
        })
        .collect();
    let body = if items.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "(no activity yet — the fleet is quiet, or the bridge hasn't reported)",
            Theme::dim(),
        )))]
    } else {
        items
    };
    // Styled column header above the firehose (D-005). No highlight symbol on
    // this list, so the header has no selection indent.
    let body_area = crate::ui::block_with_header(
        f,
        area,
        Theme::block(
            Line::from(format!(
                " Activity mirror ({}) — every tool call, newest first ",
                activity.len()
            )),
            !activity.is_empty(),
        ),
        &format!("{:<9}{:<7}{:<13}{}", "time", "agent", "pot", "summary"),
    );
    f.render_widget(List::new(body).style(Theme::panel()), body_area);
}

/// Tape mode (P-026): the exact fleet-event families projected onto the
/// existing activity SSE ledger. The source ring is already newest-first; this
/// renderer deliberately preserves every row and its order so causal pairs
/// such as member-dead + claim-released cannot collapse into roster state.
fn draw_tape(f: &mut Frame, app: &App, area: Rect) {
    let events: Vec<(&ActivityRow, crate::semantic_tool_cards::FleetEventSemantic)> = app
        .visible_fleet_activity()
        .into_iter()
        .filter_map(|row| {
            crate::semantic_tool_cards::fleet_event_semantic(row).and_then(|event| {
                app.fleet
                    .tape_filter
                    .matches(event.class)
                    .then_some((row, event))
            })
        })
        .collect();

    let items: Vec<ListItem> = events
        .iter()
        .map(|(row, event)| {
            let (badge, style) = match event.class {
                crate::semantic_tool_cards::FleetEventClass::Exception => {
                    ("! exception", Theme::warn())
                }
                crate::semantic_tool_cards::FleetEventClass::Claim => ("↪ claim", Theme::info()),
                crate::semantic_tool_cards::FleetEventClass::Gate => ("◆ gate", Theme::success()),
            };
            ListItem::new(Line::from(vec![
                Span::styled(format!("{:<8} ", hms(&row.created_at)), Theme::dim()),
                Span::styled(format!("{:<12} ", badge), style),
                Span::styled(format!("{:<18} ", trunc(&event.title, 18)), Theme::dim()),
                Span::raw(format!("{:<22} ", trunc(&event.subject, 22))),
                Span::raw(trunc(&event.detail, 48)),
            ]))
        })
        .collect();
    let body = if items.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            format!(
                "(no {} fleet transitions in the current activity window)",
                app.fleet.tape_filter.label()
            ),
            Theme::dim(),
        )))]
    } else {
        items
    };
    let body_area = crate::ui::block_with_header(
        f,
        area,
        Theme::block(
            Line::from(format!(
                " Transition tape ({}) · filter: {} · ! exceptions · a all · c claims · g gates ",
                events.len(),
                app.fleet.tape_filter.label()
            )),
            !events.is_empty(),
        ),
        &format!(
            "{:<9}{:<13}{:<19}{:<23}{}",
            "time", "class", "transition", "subject", "detail"
        ),
    );
    f.render_widget(List::new(body).style(Theme::panel()), body_area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ActivityRow, RosterEntry, TodoItem, WorkItem};
    use serde_json::json;

    #[test]
    fn agent_name_color_precedence_fleet_over_type_over_plain() {
        use crate::agent_pane_kind::AgentPaneKind;
        use ratatui::style::Color;
        let fleet = Color::Rgb(0x86, 0xef, 0xac); // a fleet's bound accent
                                                  // In a fleet → the fleet accent wins, regardless of type or the tint flag.
        assert_eq!(
            agent_name_color(Some(fleet), true, Some(AgentPaneKind::Bee)),
            Some(fleet)
        );
        assert_eq!(
            agent_name_color(Some(fleet), false, None),
            Some(fleet),
            "fleet colour applies even with the per-type tint flag OFF (matches the always-on group headers)"
        );
        // No fleet, tint flag ON → the per-type colour (P-010).
        assert_eq!(
            agent_name_color(None, true, Some(AgentPaneKind::Bee)),
            Some(AgentPaneKind::Bee.color())
        );
        // No fleet, tint flag OFF → plain (None); no kind + flag on → plain.
        assert_eq!(
            agent_name_color(None, false, Some(AgentPaneKind::Bee)),
            None
        );
        assert_eq!(agent_name_color(None, true, None), None);
    }

    #[test]
    fn parse_hex_color_parses_rrggbb_and_rejects_malformed() {
        use ratatui::style::Color;
        assert_eq!(
            parse_hex_color("#86efac"),
            Some(Color::Rgb(0x86, 0xef, 0xac))
        );
        assert_eq!(
            parse_hex_color("86efac"),
            Some(Color::Rgb(0x86, 0xef, 0xac))
        );
        assert_eq!(parse_hex_color("#fff"), None);
        assert_eq!(parse_hex_color("nope!!"), None);
    }

    #[test]
    fn wake_badge_text_carries_the_pending_count() {
        // P-008: bare badge when nothing staged; the count rides on it otherwise.
        assert_eq!(wake_badge_text(0), " ⏸MANUAL");
        assert_eq!(wake_badge_text(3), " ⏸MANUAL·3");
    }

    #[test]
    fn liveness_legend_names_shared_oracle_states() {
        // The legend documents lifecycle verdicts, never heartbeat-age bands.
        let text: String = liveness_legend_spans()
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert_eq!(
            text,
            format!(
                "{} live turn · {} parked/recorded · {} draining/suspect/ended",
                glyph::liveness::LIVE,
                glyph::liveness::IDLE,
                glyph::liveness::STALE
            )
        );
        // Each entry is tinted with the same style the roster dot uses.
        let spans = liveness_legend_spans();
        assert_eq!(
            spans[0].style,
            Theme::liveness_style(false, "live"),
            "live entry mis-styled"
        );
        assert_eq!(spans[4].style, Theme::liveness_style(true, "stale"));
    }

    #[test]
    fn ended_oracle_state_beats_a_fresh_heartbeat_and_spoke_uses_tool_calls() {
        let mut ended = roster_entry("su-ended", false);
        ended.session_state = Some("ended".into());
        ended.heartbeat_fresh = Some(true);
        ended.liveness = "live".into();

        assert!(!ended.is_online(), "fresh heartbeat must not revive ended");
        assert_eq!(roster_session_state(&ended), "ended");
        let terminal = session_state_is_terminal(roster_session_state(&ended));
        let marker = Theme::liveness_marker(terminal, roster_session_state(&ended));
        assert_eq!(marker.content.as_ref(), glyph::liveness::STALE);
        assert_eq!(marker.style, Theme::liveness_style(true, "ended"));

        let mut app = App::new();
        app.set_roster(vec![ended]);
        assert_eq!(aggregate(&app).agents_online, 0);

        let assignment = BeeAssignment {
            agent_id: "su-ended".into(),
            last_tool_call_at: Some("2026-08-26T20:21:22.456Z".into()),
            ..Default::default()
        };
        assert_eq!(spoke_text(Some(&assignment)), "20:21:22");
        assert_eq!(spoke_text(None), "—");
    }

    fn row(owner: &str, kind: &str, summary: &str) -> ActivityRow {
        ActivityRow {
            id: "1".into(),
            owner_id: owner.into(),
            agent: Some("claude".into()),
            harness_slug: Some("papercup".into()),
            kind: kind.into(),
            tool_name: None,
            summary: Some(summary.into()),
            status: None,
            detail: None,
            created_at: "2026-06-04 18:53:58.46-04".into(),
        }
    }

    fn todos_row(owner: &str, done: u32, count: u32, active: &str) -> ActivityRow {
        let mut r = row(owner, "todos", "⇄ todos");
        r.detail = Some(json!({
            "count": count,
            "done": done,
            "todos": [
                {"content": active, "status": "in_progress"},
                {"content": "later", "status": "pending"},
            ],
        }));
        r
    }

    fn fleet_event_row(transition: &str, payload: serde_json::Value) -> ActivityRow {
        ActivityRow {
            id: transition.into(),
            owner_id: "su-a".into(),
            agent: Some("codex".into()),
            harness_slug: Some("papercusp".into()),
            kind: "lifecycle".into(),
            tool_name: Some("fleet:event".into()),
            summary: Some(format!("fleet:{transition}")),
            status: Some("ok".into()),
            detail: Some(serde_json::json!({
                "eventKey": format!("fleet:pui-cockpit:{transition}"),
                "fleetSlug": "pui-cockpit",
                "transition": transition,
                "payload": payload,
            })),
            created_at: "2026-08-26T22:00:00Z".into(),
        }
    }

    #[test]
    fn agent_id_fleet_label_shows_id_and_fleet() {
        // In a fleet → shortened id + the fleet slug (WI-1355).
        let mut r = roster_entry("su-b8fe880c-8fd9-4550", false);
        r.fleet_slug = Some("atlas-fleet".into());
        assert_eq!(
            agent_id_fleet_label(&r),
            "id: su-b8fe880c  ·  fleet: atlas-fleet"
        );
        // No fleet → em-dash placeholder.
        r.fleet_slug = None;
        assert_eq!(agent_id_fleet_label(&r), "id: su-b8fe880c  ·  fleet: —");
        // Empty-string slug reads as no fleet too.
        r.fleet_slug = Some(String::new());
        assert_eq!(agent_id_fleet_label(&r), "id: su-b8fe880c  ·  fleet: —");
    }

    #[test]
    fn mode_toggles() {
        let mut s = FleetState::default();
        assert_eq!(s.mode, FleetMode::Curated);
        s.toggle_mode();
        assert_eq!(s.mode, FleetMode::Mirror);
        s.toggle_mode();
        assert_eq!(s.mode, FleetMode::Tape);
        s.toggle_mode();
        assert_eq!(s.mode, FleetMode::Curated);
        assert_eq!(FleetMode::from_label("tape"), FleetMode::Tape);
    }

    #[test]
    fn push_activity_is_newest_first_and_capped() {
        let mut s = FleetState::default();
        for i in 0..(ACTIVITY_CAP + 50) {
            s.push_activity(row("su-a", "tool", &format!("m{i}")));
        }
        assert_eq!(s.activity.len(), ACTIVITY_CAP);
        // Newest pushed is at index 0.
        assert_eq!(
            s.activity[0].summary.as_deref(),
            Some(format!("m{}", ACTIVITY_CAP + 49).as_str())
        );
    }

    #[test]
    fn seed_activity_replaces_and_caps() {
        let mut s = FleetState::default();
        s.push_activity(row("su-a", "tool", "live"));
        let backfill: Vec<ActivityRow> = (0..3)
            .map(|i| row("su-b", "tool", &format!("b{i}")))
            .collect();
        s.seed_activity(backfill);
        assert_eq!(s.activity.len(), 3);
        assert_eq!(s.activity[0].summary.as_deref(), Some("b0"));
    }

    #[test]
    fn todos_ingested_into_per_agent_map() {
        let mut s = FleetState::default();
        s.push_activity(todos_row("su-a", 2, 5, "build fleet.rs"));
        let snap = s.agent_todos.get("su-a").expect("todos for su-a");
        assert_eq!(snap.done, 2);
        assert_eq!(snap.count, 5);
        assert_eq!(snap.todos[0].content, "build fleet.rs");
        assert_eq!(
            snap.todos[0],
            TodoItem {
                content: "build fleet.rs".into(),
                status: Some("in_progress".into()),
            }
        );
        // A newer todos row replaces the snapshot.
        s.push_activity(todos_row("su-a", 4, 5, "wire pollers"));
        assert_eq!(s.agent_todos.get("su-a").unwrap().done, 4);
    }

    #[test]
    fn latest_by_owner_keeps_newest() {
        let mut s = FleetState::default();
        // Pushed newest-last here, but push prepends, so su-a's newest is "second".
        s.push_activity(row("su-a", "tool", "first"));
        s.push_activity(row("su-a", "tool", "second"));
        let latest = s.latest_by_owner();
        assert_eq!(
            latest.get("su-a").unwrap().summary.as_deref(),
            Some("second")
        );
    }

    #[test]
    fn tape_filters_shared_semantic_classes_without_collapsing_rows() {
        let rows = [
            fleet_event_row("member-dead", json!({"agentId":"su-a"})),
            fleet_event_row(
                "claim-released",
                json!({"id":"WI-1","priorAssignee":"su-a"}),
            ),
            fleet_event_row("drained", json!({})),
        ];
        let semantics: Vec<_> = rows
            .iter()
            .map(|row| crate::semantic_tool_cards::fleet_event_semantic(row).unwrap())
            .collect();
        assert_eq!(
            semantics
                .iter()
                .filter(|event| TapeFilter::All.matches(event.class))
                .count(),
            3
        );
        assert_eq!(
            semantics
                .iter()
                .filter(|event| TapeFilter::Exceptions.matches(event.class))
                .count(),
            1
        );
        assert_eq!(
            semantics
                .iter()
                .filter(|event| TapeFilter::Claims.matches(event.class))
                .count(),
            1
        );
        assert_eq!(
            semantics
                .iter()
                .filter(|event| TapeFilter::Gates.matches(event.class))
                .count(),
            1
        );
    }

    fn roster_entry(owner: &str, stale: bool) -> RosterEntry {
        RosterEntry {
            owner_id: owner.into(),
            label: format!("su · {owner}"),
            intent: Some("working".into()),
            current_files: vec![],
            liveness: if stale { "dead".into() } else { "live".into() },
            stale,
            agent: Some("claude".into()),
            role: Some("worker".into()),
            feature: None,
            current_plan_slug: None,
            heartbeat_at: None,
            ..Default::default()
        }
    }

    fn wi(kind: &str, family: &str, state: &str) -> WorkItem {
        WorkItem {
            id: "X-1".into(),
            kind: kind.into(),
            family: family.into(),
            harness: Some("papercup".into()),
            title: "t".into(),
            state: state.into(),
            assignee: None,
            severity: None,
        }
    }

    #[test]
    fn aggregate_rolls_up_plans_workitems_roster() {
        let mut app = App::new();
        app.set_roster(vec![
            roster_entry("su-a", false),
            roster_entry("su-b", true),
        ]);
        // Two plans: one with progress, one archived (excluded).
        let mut p1 = crate::models::PlanSummary {
            slug: "p1".into(),
            title: "P1".into(),
            status: "active".into(),
            updated: "x".into(),
            owner: None,
            harness: None,
            archived: false,
            next_action: None,
            item_counts: crate::models::ItemCounts {
                todo: 3,
                done: 2,
                ..Default::default()
            },
            open: None,
            done: None,
            priority: Some(5),
        };
        let mut p2 = p1.clone();
        p2.slug = "archived".into();
        p2.archived = true;
        p1.slug = "p1".into();
        app.set_plans(vec![p1, p2]);
        app.fleet.set_work_items(vec![
            wi("feature", "feature", "passed"),
            wi("feature", "feature", "todo"),
            wi("bug", "issue", "open"),
        ]);

        let agg = aggregate(&app);
        assert_eq!(agg.agents_online, 1);
        assert_eq!(agg.agents_total, 2);
        assert_eq!(agg.plan_items_done, 2); // archived plan excluded
        assert_eq!(agg.plan_items_total, 5);
        assert_eq!(agg.active_plans, 1);
        assert_eq!(agg.wi_total, 3);
        assert_eq!(agg.wi_features, 2);
        assert_eq!(agg.wi_issues, 1);
        assert_eq!(agg.wi_open_issues, 1);
        assert_eq!(agg.wi_features_passed, 1);
        // Done = passed features + resolved/closed issues; remaining = total − done.
        assert_eq!(agg.wi_done, 1); // 1 passed feature, the lone issue is open
        assert_eq!(agg.wi_remaining, 2); // 1 todo feature + 1 open issue
    }

    #[test]
    fn aggregate_counts_resolved_and_closed_issues_as_done() {
        let mut app = App::new();
        app.fleet.set_work_items(vec![
            wi("bug", "issue", "resolved"),
            wi("change", "issue", "closed"),
            wi("bug", "issue", "open"),
            wi("feature", "feature", "passed"),
        ]);
        let agg = aggregate(&app);
        assert_eq!(agg.wi_total, 4);
        assert_eq!(agg.wi_done, 3); // resolved + closed + passed
        assert_eq!(agg.wi_remaining, 1); // the open bug
        assert_eq!(agg.wi_open_issues, 1);
    }

    #[test]
    fn work_items_error_is_visible_in_the_fleet_headline() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;
        app.fleet.work_items_error = Some("array-root decode failed".into());

        // Back at 160 — the width this was authored against — now that
        // WI-2141006 is fixed. It was temporarily moved to 200 to keep a
        // 160-column body once the Surface B dock (WI-2140985) started taking
        // its fixed 40 columns; that was a fixture number papering over a real
        // elision, and widening the fixture is exactly the move that would have
        // hidden the bug instead of fixing it.
        let view = render_fleet(&app, 160, 24);
        assert!(view.contains("work-items error: array-root decode failed"));
        assert!(app.last_error.is_none());
    }

    /// WI-2141006 regression guard. The headline is a single unwrapped
    /// `Paragraph`, so span ORDER decides what survives truncation: this renders
    /// narrow enough that the headline provably cannot hold every segment, and
    /// pins which one is allowed to go. It fails on the pre-fix ordering, where
    /// the error trailed the ~75-column stats blob and was clipped from ~130
    /// columns down.
    ///
    /// 120 is below SURFACE_B_MIN_WIDTH, so no dock is carved and the body IS
    /// the full 120 — the assertion is about headline priority alone and does
    /// not silently re-test the dock gate.
    #[test]
    fn work_items_error_outranks_the_stats_blob_when_the_headline_cannot_fit_both() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;
        app.fleet.work_items_error = Some("array-root decode failed".into());

        let view = render_fleet(&app, 120, 24);

        // The error survives...
        assert!(
            view.contains("work-items error: array-root decode failed"),
            "the error segment must outrank the stats blob under width pressure; \
             an error is the last thing a headline may drop"
        );
        // ...and this is a real forced choice, not a width that happens to fit
        // everything: the trailing mode/Tab hint is the segment that gives way.
        // If this ever passes, the headline stopped being under pressure and the
        // assertion above stopped proving anything — re-derive the width.
        assert!(
            !view.contains("Tab: curated→mirror→tape"),
            "120 columns must not fit the whole headline, or this guard proves nothing"
        );
    }

    #[test]
    fn tape_renders_semantic_transition_title() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;
        app.fleet.mode = FleetMode::Tape;
        app.fleet.activity.push(fleet_event_row(
            "claim-released",
            json!({"id":"WI-1","priorAssignee":"su-a"}),
        ));

        let view = render_fleet(&app, 160, 24);
        assert!(view.contains("Transition tape"));
        assert!(view.contains("Claim released"));
    }

    #[test]
    fn hms_extracts_clock() {
        assert_eq!(hms("2026-06-04 18:53:58.46-04"), "18:53:58");
        assert_eq!(hms("2026-06-04T09:01:02Z"), "09:01:02");
    }

    #[test]
    fn progress_bar_fills_proportionally() {
        assert_eq!(progress_bar(0, 0, 4), "────");
        assert_eq!(progress_bar(0, 10, 4), "░░░░");
        assert_eq!(progress_bar(10, 10, 4), "████");
        assert_eq!(progress_bar(5, 10, 4), "██░░");
    }

    fn render_fleet(app: &App, w: u16, h: u16) -> String {
        use ratatui::{backend::TestBackend, Terminal};
        let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
        term.draw(|f| crate::ui::draw(f, app)).unwrap();
        term.backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect()
    }

    fn leader_brief(fleet: &str) -> crate::models::FleetLeaderBrief {
        crate::models::FleetLeaderBrief {
            ok: true,
            summary: crate::models::FleetLeaderSummary {
                fleet: fleet.into(),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn leader_cockpit_requires_explicit_matching_live_leader_selection() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;
        app.fleet.leader_fleet = Some("standalone-drain".into());
        app.fleet.leader_brief = Some(leader_brief("standalone-drain"));

        // A loaded brief must not replace an explicitly selected worker's
        // dossier merely because the brief belongs to some live leader.
        let mut worker = roster_entry("su-worker", false);
        worker.fleet_slug = Some("bulk-work-queue-sol-xhigh".into());
        worker.fleet_role = Some("member".into());
        worker.session_state = Some("live".into());
        app.set_roster(vec![worker]);
        app.bee.set_selection(Some("su-worker".into()), None);
        let worker_view = render_fleet(&app, 120, 24);
        assert!(
            !worker_view.contains("leader members"),
            "unrelated leader brief replaced the selected worker dossier"
        );

        // Even when the cursor is on a leader, the cockpit is opt-in: entering
        // Fleet starts with the whole-fleet dossier until the row is selected.
        let mut leader = roster_entry("su-leader", false);
        leader.fleet_slug = Some("standalone-drain".into());
        leader.fleet_role = Some("leader".into());
        leader.session_state = Some("live".into());
        app.set_roster(vec![leader]);
        // The roster reducer clears a brief whenever the leader fleet changes;
        // a real fetch lands after that refresh, so load the matching snapshot
        // at the same point in this fixture.
        app.fleet.leader_brief = Some(leader_brief("standalone-drain"));
        app.bee.set_selection(None, None);
        let unselected_leader_view = render_fleet(&app, 120, 24);
        assert!(!unselected_leader_view.contains("leader members"));

        // The loaded cockpit still appears for the explicitly selected live
        // leader whose fleet matches both the fetch target and brief.
        app.bee.set_selection(Some("su-leader".into()), None);
        let leader_view = render_fleet(&app, 120, 24);
        assert!(leader_view.contains("leader members"));
    }

    #[test]
    fn cockpit_controls_follow_roster_target_and_render_confirmation_and_outcome() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;

        let mut leader = roster_entry("su-leader", false);
        leader.fleet_slug = Some("cockpit".into());
        leader.fleet_role = Some("leader".into());
        leader.session_state = Some("live".into());
        let mut member = roster_entry("su-member", false);
        member.fleet_slug = Some("cockpit".into());
        member.fleet_role = Some("member".into());
        member.session_state = Some("parked".into());
        app.set_roster(vec![leader, member]);
        app.fleet.leader_brief = Some(crate::models::FleetLeaderBrief {
            ok: true,
            summary: crate::models::FleetLeaderSummary {
                fleet: "cockpit".into(),
                ..Default::default()
            },
            announced_gates: Some(vec![crate::models::FleetLeaderGate {
                event: "fleet:cockpit:ready".into(),
                ..Default::default()
            }]),
            ..Default::default()
        });
        app.fleet.agent_sel = app
            .visible_roster()
            .iter()
            .position(|row| row.owner_id == "su-member")
            .unwrap();

        let (_, brief) = control_target(&app).expect("same-fleet member is actionable");
        assert_eq!(
            first_unfired_gate(brief).unwrap().event,
            "fleet:cockpit:ready"
        );
        let controls = render_fleet(&app, 220, 32);
        assert!(controls.contains("[b] bench"));
        assert!(controls.contains("[s] bump spec"));

        app.fleet.control_pending = Some(FleetControlIntent {
            kind: FleetControlKind::Bench,
            fleet: "cockpit".into(),
            member: "su-member".into(),
            member_label: "worker lane".into(),
            agent: Some("codex".into()),
            gate: Some("fleet:cockpit:ready".into()),
        });
        let confirmation = render_fleet(&app, 220, 32);
        assert!(confirmation.contains("CONFIRM bench worker lane until fleet:cockpit:ready"));
        assert!(confirmation.contains("[y] execute · [n/Esc] cancel"));

        app.fleet.control_pending = None;
        app.fleet.control_outcome = Some(FleetControlOutcome {
            ok: true,
            message: "fleet:bench audited · registered true · lane gated".into(),
        });
        let outcome = render_fleet(&app, 220, 32);
        assert!(outcome.contains("fleet:bench audited"));
    }

    #[test]
    fn fleet_metric_lines_show_scope_and_quality_before_counts() {
        let brief = crate::models::FleetLeaderBrief {
            fleet_metrics: Some(crate::models::FleetMetricsResult {
                ok: true,
                schema_version: "fleet-metrics-v1".into(),
                snapshot: Some(crate::models::FleetMetricsSnapshot {
                    scope: crate::models::FleetMetricsScope {
                        window: crate::models::FleetMetricsWindow {
                            kind: "fleet-lifetime".into(),
                        },
                        stock: crate::models::FleetMetricsStockScope {
                            spec_id: "spec-42".into(),
                            revision: 7,
                        },
                        population: crate::models::FleetMetricsPopulation {
                            stock: "current-spec-work-items".into(),
                        },
                    },
                    quality: crate::models::FleetMetricsQuality {
                        exactness: crate::models::FleetMetricsQualityStatus {
                            status: "exact".into(),
                        },
                        freshness: crate::models::FleetMetricsQualityStatus {
                            status: "fresh".into(),
                        },
                    },
                    remaining: crate::models::FleetMetricsRemaining {
                        total: 12,
                        unit: "distinct canonical issue-family work-item ids".into(),
                    },
                }),
                ..Default::default()
            }),
            ..Default::default()
        };

        let lines = fleet_metric_lines(&brief, Some(99));
        assert_eq!(
            lines[0],
            "stock: 12 · spec spec-42@7 · window fleet-lifetime"
        );
        assert!(lines[1].contains("population: current-spec-work-items"));
        assert!(lines[1].contains("quality exact/fresh"));
        assert!(!lines.iter().any(|line| line.contains("99")));
    }

    #[test]
    fn fleet_metric_lines_explain_unavailable_snapshot_and_recovery() {
        let brief = crate::models::FleetLeaderBrief {
            fleet_metrics: Some(crate::models::FleetMetricsResult {
                ok: false,
                schema_version: "fleet-metrics-v1".into(),
                reason: Some("historical revision missing".into()),
                recover_via: Some("work_items:burn_down { window: fleet-lifetime }".into()),
                ..Default::default()
            }),
            ..Default::default()
        };

        let lines = fleet_metric_lines(&brief, None);
        assert_eq!(
            lines,
            vec![
                "fleet metrics unavailable · historical revision missing · recover work_items:burn_down { window: fleet-lifetime }"
                    .to_string()
            ]
        );
    }

    #[test]
    fn fleet_metric_lines_label_legacy_aliases_when_metrics_are_absent() {
        let brief = crate::models::FleetLeaderBrief {
            spec_matched: Some(5),
            harness_wide_pool: Some(20),
            spec_revision: Some(3),
            ..Default::default()
        };

        let lines = fleet_metric_lines(&brief, Some(2));
        assert!(lines[0].starts_with("legacy queue aliases (scope unavailable):"));
        assert!(lines[0].contains("claimable 2"));
        assert!(lines[0].contains("matched 5 / pool 20 · revision 3"));
    }

    #[test]
    fn curated_default_shows_roster_fleet_tasklist_and_plan_progress() {
        // The default curated layout (pui-dock-consolidation-2026-06-07 #2):
        // roster (left) | whole-fleet task list + plan progress (right). No
        // agent selected → the fleet-wide dossier, not a single bee's.
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;
        let text = render_fleet(&app, 120, 24);
        assert!(text.contains("Agents"));
        assert!(text.contains("WORK FRONTIER"));
        assert!(text.contains("Plan progress"));
    }

    #[test]
    fn whole_fleet_dossier_is_bucketed_frontier_and_slash_reveals_archive() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;
        app.fleet.frontier = Some(crate::models::WorkFrontier {
            terminal: crate::models::WorkFrontierTerminal { total: 91 },
            counts: crate::models::WorkFrontierCounts {
                terminal: 91,
                in_flight: 2,
                parked: 2,
                unclaimed: 1,
                total: 96,
            },
            unclaimed: vec![crate::models::WorkFrontierRow {
                id: "WI-ready".into(),
                title: "opens three lanes".into(),
                blocks: 3,
                ..Default::default()
            }],
            in_flight: vec![
                crate::models::WorkFrontierRow {
                    id: "WI-live".into(),
                    title: "moving".into(),
                    assignee: Some("su-live".into()),
                    ..Default::default()
                },
                crate::models::WorkFrontierRow {
                    id: "WI-stuck".into(),
                    title: "not progressing".into(),
                    assignee: Some("su-stuck".into()),
                    ..Default::default()
                },
            ],
            parked: vec![
                crate::models::WorkFrontierParkedRow {
                    item: crate::models::WorkFrontierRow {
                        id: "WI-human".into(),
                        title: "credential required".into(),
                        ..Default::default()
                    },
                    reason: "needs operator credential".into(),
                    mechanism: "needs-human".into(),
                },
                serde_json::from_value(json!({
                    "id": "WI-park",
                    "kind": "feature",
                    "title": "wait for the migration",
                    "state": "open",
                    "reason": "durably parked by su-park: release once P-003 lands",
                    "mechanism": "claimHold",
                    "queueControl": {
                        "durablePark": {
                            "parker": "su-park",
                            "reason": "release once P-003 lands",
                            "parkedAt": "2026-08-25T12:00:00.000Z",
                            "age": { "status": "known", "ageMs": 172800000, "bucket": "1-7d" },
                            "unparkCondition": { "status": "stated", "text": "release once P-003 lands" },
                            "releaseLiveness": { "status": "tracked", "owner": "su-owner", "trigger": "plan-item:done:P-003" }
                        }
                    }
                })).unwrap(),
            ],
            ..Default::default()
        });
        app.fleet.all_assignments = vec![
            BeeAssignment {
                agent_id: "su-live".into(),
                session_state: Some("live".into()),
                verdict: Some("speaking".into()),
                queued: vec![crate::models::BeeWorkItem {
                    id: "WI-live".into(),
                    ..Default::default()
                }],
                ..Default::default()
            },
            BeeAssignment {
                agent_id: "su-stuck".into(),
                session_state: Some("live".into()),
                verdict: Some("waiting".into()),
                stalled: true,
                queued: vec![crate::models::BeeWorkItem {
                    id: "WI-stuck".into(),
                    ..Default::default()
                }],
                ..Default::default()
            },
        ];
        let buckets: Vec<&str> = frontier_rows(&app)
            .into_iter()
            .map(frontier_bucket)
            .collect();
        assert_eq!(
            buckets,
            [
                "READY NOW",
                "IN FLIGHT",
                "NEEDS YOU",
                "DURABLE PARK",
                "STUCK"
            ]
        );
        let text = render_fleet(&app, 160, 32);
        assert!(text.contains("READY NOW"));
        assert!(text.contains("blocks 3"));
        assert!(text.contains("STUCK"));
        assert!(text.contains("DURABLE PARK"));
        assert!(text.contains("/ archive 91"));

        app.fleet.dossier_sel = 3;
        let detail = dossier_detail_lines(&app)
            .into_iter()
            .map(|line| {
                line.spans
                    .into_iter()
                    .map(|span| span.content.into_owned())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(detail.contains("park     su-park · at 2026-08-25T12:00:00.000Z · age 1-7d"));
        assert!(detail.contains("UNPARK   stated · tracked · release once P-003 lands"));

        app.fleet.work_items = vec![WorkItem {
            id: "WI-done".into(),
            kind: "feature".into(),
            family: "feature".into(),
            harness: Some("papercusp".into()),
            title: "finished item".into(),
            state: "done".into(),
            assignee: None,
            severity: None,
        }];
        app.fleet.frontier_archive_open = true;
        assert_eq!(dossier_task_count(&app), 1);
        let text = render_fleet(&app, 160, 32);
        assert!(text.contains("ARCHIVE (91)"));
        assert!(text.contains("finished item"));
    }

    #[test]
    fn plan_progress_filters_to_selected_agents_plans() {
        // #2: selecting an agent narrows plan progress to ITS plans (declared
        // plan + claim plan-slugs from fleet:assignments); Esc clears.
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;
        let mk = |slug: &str| crate::models::PlanSummary {
            slug: slug.into(),
            title: slug.to_uppercase(),
            status: "active".into(),
            updated: "x".into(),
            owner: None,
            harness: None,
            archived: false,
            next_action: None,
            item_counts: crate::models::ItemCounts {
                todo: 1,
                done: 1,
                ..Default::default()
            },
            open: None,
            done: None,
            priority: None,
        };
        app.set_plans(vec![mk("plan-mine"), mk("plan-other")]);
        app.fleet.all_assignments = vec![crate::models::BeeAssignment {
            agent_id: "su-a".into(),
            declared_plan_slug: Some("plan-mine".into()),
            ..Default::default()
        }];
        // No selection → both plans render.
        let text = render_fleet(&app, 120, 30);
        assert!(text.contains("plan-mine"));
        assert!(text.contains("plan-other"));
        // Selection → only the agent's plan; the title names the agent.
        app.bee
            .set_selection(Some("su-a".into()), Some("forager".into()));
        let text = render_fleet(&app, 120, 30);
        assert!(text.contains("plan-mine"));
        assert!(!text.contains("plan-other"));
        assert!(text.contains("forager"));
        assert!(text.contains("Esc clears"));
    }

    #[test]
    fn bee_assignment_plan_slugs_unions_declared_and_claims() {
        let a = crate::models::BeeAssignment {
            declared_plan_slug: Some("p-declared".into()),
            claims: vec![
                crate::models::BeeClaim {
                    plan_slug: Some("p-claimed".into()),
                },
                crate::models::BeeClaim { plan_slug: None },
            ],
            ..Default::default()
        };
        let set = a.plan_slugs();
        assert!(set.contains("p-declared"));
        assert!(set.contains("p-claimed"));
        assert_eq!(set.len(), 2);
    }

    /// Brief 27 / P-010: buffer-level width safety. Render the Fleet view
    /// (agent roster + work-item rollup) at 80 and 120 cols
    /// and assert (a) no double-width symbol appears anywhere in the frame
    /// outside the header-only set (`glyph::header::SET` — Block-title emoji),
    /// and (b) the roster labels align in a single column across rows (a wide
    /// glyph upstream of a label would shift it right by one cell).
    #[test]
    fn fleet_render_width_safe_and_aligned_at_80_and_120() {
        use unicode_width::UnicodeWidthStr;

        // Frame-wide scan: every cell symbol must be ≤1 column wide unless it
        // is one of the sanctioned header emoji.
        fn scan(app: &App, w: u16, h: u16) -> Vec<String> {
            use ratatui::{backend::TestBackend, Terminal};
            let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
            term.draw(|f| crate::ui::draw(f, app)).unwrap();
            let buf = term.backend().buffer().clone();
            let mut rows: Vec<String> = Vec::with_capacity(h as usize);
            for y in 0..h {
                let mut row = String::with_capacity(w as usize);
                for x in 0..w {
                    let sym = buf.cell((x, y)).unwrap().symbol();
                    if UnicodeWidthStr::width(sym) > 1 {
                        assert!(
                            glyph::header::SET.contains(&sym),
                            "width-2 symbol {sym:?} leaked into row content at ({x},{y}) \
                             width {w} — only glyph::header::* may be wide"
                        );
                    }
                    row.push_str(sym);
                }
                rows.push(row);
            }
            rows
        }

        // Heuristic (no curator) mode — per-agent roster rows render.
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;
        app.set_roster(vec![
            roster_entry("su-alpha", false),
            roster_entry("su-bee", true),
            roster_entry("su-much-longer-name", false),
        ]);
        app.fleet.set_work_items(vec![
            wi("feature", "feature", "passed"),
            wi("feature", "feature", "todo"),
            wi("bug", "issue", "open"),
        ]);

        for &(w, h) in &[(80u16, 30u16), (120, 30)] {
            let rows = scan(&app, w, h);
            // Roster rows: every agent label starts at the same column (a wide
            // glyph in the liveness-dot cell would shift the label by one).
            let cols: Vec<usize> = rows.iter().filter_map(|r| r.find("claude")).collect();
            assert!(
                cols.len() >= 3,
                "expected 3 roster rows in the {w}-col render, got {cols:?}"
            );
            assert!(
                cols.windows(2).all(|p| p[0] == p[1]),
                "roster label column drifted at width {w}: {cols:?}"
            );
        }
    }

    /// Live read-only QA (feedback-no-live-keystroke-drive-pui): fetch REAL fleet
    /// data via the operator client, populate a Fleet App, and render both modes
    /// to a TestBackend. No live pui process, no keystrokes — just the real wire +
    /// the pure renderer. `PUI_DUMP=1` writes the renders for manual inspection.
    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_fleet_render() {
        use ratatui::{backend::TestBackend, Terminal};
        let c = crate::client::OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false; // full width for the dashboard
        match c.plans_typed().await {
            Ok(v) => {
                let with_items = v.iter().filter(|p| p.item_counts.total() > 0).count();
                eprintln!(
                    "plans: {} loaded, {} with item progress",
                    v.len(),
                    with_items
                );
                app.set_plans(v);
            }
            Err(e) => eprintln!("plans_typed ERR: {e}"),
        }
        if let Ok((active, _pending)) = c.roster_typed().await {
            app.set_roster(active);
        }
        if let Ok(v) = c.work_items_list().await {
            app.fleet.set_work_items(v);
        }
        if let Ok(v) = c.activity_recent(None, 100).await {
            app.fleet.seed_activity(v);
        }
        if let Ok(v) = c.activity_recent(Some("todos"), 50).await {
            app.fleet.seed_todos(&v);
        }

        let agg = aggregate(&app);
        eprintln!(
            "live fleet: agents {}/{}, plan items {}/{} ({} active plans), work-items {} ({} feat / {} issue, {} passed, {} open-issue), activity {} rows, todo-maps {}",
            agg.agents_online, agg.agents_total, agg.plan_items_done, agg.plan_items_total,
            agg.active_plans, agg.wi_total, agg.wi_features, agg.wi_issues,
            agg.wi_features_passed, agg.wi_open_issues, app.fleet.activity.len(),
            app.fleet.agent_todos.len(),
        );

        let render = |app: &App| -> String {
            let mut term = Terminal::new(TestBackend::new(200, 50)).unwrap();
            term.draw(|f| crate::ui::draw(f, app)).unwrap();
            term.backend()
                .buffer()
                .content()
                .iter()
                .map(|cell| cell.symbol())
                .collect()
        };
        let wrap = |s: &str| -> String {
            s.chars()
                .collect::<Vec<_>>()
                .chunks(200)
                .map(|c| c.iter().collect::<String>())
                .collect::<Vec<_>>()
                .join("\n")
        };

        // Curated (default) renders the dashboard.
        let curated = render(&app);
        let nonblank = curated.chars().filter(|ch| !ch.is_whitespace()).count();
        assert!(nonblank > 0, "fleet curated rendered blank");
        assert!(curated.contains("Fleet"), "headline missing");
        assert!(curated.contains("online"), "agent rollup missing");
        assert!(curated.contains("[curated]"), "mode indicator missing");

        // Mirror renders the firehose.
        app.fleet.mode = FleetMode::Mirror;
        let mirror = render(&app);
        assert!(mirror.contains("Activity mirror"), "mirror feed missing");
        assert!(mirror.contains("[mirror]"));

        app.fleet.activity.insert(
            0,
            fleet_event_row(
                "claim-released",
                json!({"id":"WI-1","priorAssignee":"su-a"}),
            ),
        );
        app.fleet.mode = FleetMode::Tape;
        let tape = render(&app);
        assert!(tape.contains("Transition tape"), "transition tape missing");
        assert!(
            tape.contains("Claim released"),
            "semantic transition missing"
        );
        assert!(tape.contains("[tape]"));

        if std::env::var("PUI_DUMP").is_ok() {
            let _ = std::fs::write("/tmp/fleet-curated.txt", wrap(&curated));
            let _ = std::fs::write("/tmp/fleet-mirror.txt", wrap(&mirror));
            let _ = std::fs::write("/tmp/fleet-tape.txt", wrap(&tape));
            eprintln!("dumped /tmp/fleet-curated.txt + /tmp/fleet-mirror.txt");
        }
    }
}
