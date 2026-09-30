//! Typed models for the operator API responses the panels consume.
//!
//! Field sets match the live-probed shapes (SP-TUI plan, iteration 4). Unknown
//! fields are ignored (serde default) and nullable/absent fields are
//! Option/defaulted so a shape drift never hard-fails a deserialize.
#![allow(dead_code)] // DTOs mirror the full API shape; not every field is displayed yet.

use serde::{Deserialize, Serialize};

/// Address of the one canonical conversation/context projection row. The
/// source/session pair is producer-neutral; P-030 teaches the server about
/// foreign producers without changing this client contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationContextProjectionTarget {
    pub source_kind: String,
    pub session_id: String,
    pub harness: Option<String>,
}

/// What the Sessions destination currently knows about an indexed transcript.
/// `Unknown` is deliberately distinct from `Unavailable`: the initial
/// `sessions:search` seed is bounded, so absence from that page cannot prove
/// that a roster session has no indexed turns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionTranscriptAvailability {
    #[default]
    Unknown,
    Available,
    Unavailable,
}

/// Canonical result of resolving one exact roster session through
/// `sessions:search`. The ref is passed unchanged to `sessions:read`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTranscriptResolution {
    pub reference: String,
    pub excerpt: Option<String>,
    pub transcript_at: Option<String>,
}

impl ConversationContextProjectionTarget {
    pub fn new(
        source_kind: impl Into<String>,
        session_id: impl Into<String>,
        harness: Option<String>,
    ) -> Self {
        Self {
            source_kind: source_kind.into(),
            session_id: session_id.into(),
            harness,
        }
    }

    /// Resolve a roster-native handle into the shared projection address.
    /// Missing exact ids stay absent; guessing `--last` would bind Context to
    /// a different session and violate the shared-projection contract.
    pub fn from_native_session(
        handle: &NativeSessionHandle,
        harness: Option<String>,
    ) -> Option<Self> {
        let (source, id) = match handle {
            NativeSessionHandle::Claude { session_id, .. } => ("claude", session_id.as_deref()),
            NativeSessionHandle::Codex { rollout_id, .. } => ("codex", rollout_id.as_deref()),
            NativeSessionHandle::Omp { omp_thread_id, .. } => ("omp", omp_thread_id.as_deref()),
        };
        id.map(str::trim)
            .filter(|id| !id.is_empty())
            .map(|id| Self::new(source, id, harness))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationContextCapabilities {
    pub live_frames: bool,
    pub task_write: bool,
    pub approval_write: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationContextSession {
    pub source_kind: String,
    pub session_id: String,
    pub harness: Option<String>,
    pub role: Option<String>,
    pub linked_work_item_id: Option<String>,
    pub capability_tier: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ConversationContextBadge {
    pub label: String,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ConversationContextEntry {
    pub label: String,
    pub value: String,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub badges: Vec<ConversationContextBadge>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversationTaskLinkRelation {
    For,
    Relates,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTaskWorkItemLink {
    pub work_item_id: String,
    #[serde(default)]
    pub work_item_harness: Option<String>,
    pub relation: ConversationTaskLinkRelation,
}

/// Rust mirror of the server-normalized frame union. Conversational frames
/// intentionally carry only identity here: this pane renders context/tasks/
/// approvals while the chat renderer consumes message/tool frames.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ConversationContextFrame {
    Message {
        id: String,
    },
    Reasoning {
        id: String,
    },
    Tool {
        id: String,
    },
    Task {
        id: String,
        #[serde(rename = "taskId")]
        task_id: String,
        content: String,
        #[serde(rename = "activeForm")]
        active_form: String,
        status: String,
        #[serde(default, rename = "blockerRef")]
        blocker_ref: Option<String>,
        #[serde(default)]
        explanation: Option<String>,
        position: u32,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(default)]
        links: Vec<ConversationTaskWorkItemLink>,
    },
    Context {
        id: String,
        section: String,
        title: String,
        #[serde(default)]
        entries: Vec<ConversationContextEntry>,
    },
    Approval {
        id: String,
        #[serde(rename = "callId")]
        call_id: String,
        #[serde(default, rename = "toolName")]
        tool_name: Option<String>,
        status: String,
        #[serde(default)]
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationContextProjection {
    pub schema_version: String,
    pub session: ConversationContextSession,
    pub capabilities: ConversationContextCapabilities,
    #[serde(default)]
    pub frames: Vec<ConversationContextFrame>,
}

impl ConversationContextProjection {
    pub fn tasks(&self) -> Vec<&ConversationContextFrame> {
        let mut tasks = self
            .frames
            .iter()
            .filter(|frame| matches!(frame, ConversationContextFrame::Task { .. }))
            .collect::<Vec<_>>();
        tasks.sort_by_key(|frame| match frame {
            ConversationContextFrame::Task { position, .. } => *position,
            _ => u32::MAX,
        });
        tasks
    }
}

/// One row of `/api/admin/plans/list` → `{ plans: [...] }`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    pub slug: String,
    // title / status / updated are non-Option strings, but the wire sends them as
    // `string | null` for legacy plans — tolerate null → "" (a plain
    // `#[serde(default)]` only covers an ABSENT key, so a null would otherwise sink
    // the whole plans decode and blank the Plans + Fleet tabs).
    #[serde(default, deserialize_with = "null_as_default")]
    pub title: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub status: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub updated: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub archived: bool,
    // EI-7430: the `standard` payloadTier (list-shape.ts) renames this field to
    // `next` (and clips it) to keep the list compact — alias it so the same
    // struct decodes either the full tier's `nextAction` or the standard tier's
    // `next`.
    #[serde(default, alias = "next")]
    pub next_action: Option<String>,
    /// Item counts by effectiveStatus (`itemCounts`) — the fleet view aggregates
    /// these into plan progress (done/total). The wire sends `object | null`
    /// (legacy/empty plans report `null`), so tolerate null → all-zero default
    /// (a plain `#[serde(default)]` only covers an ABSENT key, NOT explicit null,
    /// and a null would otherwise hard-fail the whole plans decode).
    #[serde(default, deserialize_with = "null_as_default")]
    pub item_counts: ItemCounts,
    /// EI-7430: the `standard` tier flattens `itemCounts` into these two scalar
    /// fields instead of the full object (list-shape.ts openDoneCounts) — absent
    /// on the `full` tier, in which case `item_counts` above carries the detail.
    /// `PlansResponse` rehydrates these scalars into `item_counts` after decode
    /// so every renderer can continue using the same progress model.
    #[serde(default)]
    pub open: Option<u32>,
    #[serde(default)]
    pub done: Option<u32>,
    /// Plan priority (higher first); the fleet view orders active plans by it.
    #[serde(default)]
    pub priority: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct PlansResponseWire {
    #[serde(default)]
    plans: Vec<PlanSummary>,
}

#[derive(Debug, Clone)]
pub struct PlansResponse {
    pub plans: Vec<PlanSummary>,
}

impl<'de> Deserialize<'de> for PlansResponse {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = PlansResponseWire::deserialize(deserializer)?;
        let mut plans = wire.plans;
        for plan in &mut plans {
            plan.rehydrate_standard_counts();
        }
        Ok(Self { plans })
    }
}

impl PlanSummary {
    /// Restore the compact `standard` payload's aggregate counts to the
    /// renderer-facing model. The full payload has detailed `itemCounts` and
    /// omits both scalars, so it remains unchanged.
    fn rehydrate_standard_counts(&mut self) {
        let (Some(open), Some(done)) = (self.open, self.done) else {
            return;
        };
        self.item_counts = ItemCounts {
            todo: open,
            done,
            ..Default::default()
        };
    }
}

/// One pot chip on a goal row (`/api/tui/goals` → `goals[].pots[]`) — the
/// goals→plans join key for the Plans-tab spine (P-032): a plan belongs to a
/// goal's scope when its `harness` matches a chip's `harness_slug`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalPotChip {
    #[serde(default, deserialize_with = "null_as_default")]
    pub harness_slug: String,
    /// 'owner' | 'contributing' as stored; null tolerated.
    #[serde(default)]
    pub role: Option<String>,
    /// How many live goals this same pot serves (shared-spend visibility).
    #[serde(default)]
    pub serves_goals: i64,
}

/// One goals-column row (`GET /api/tui/goals`, P-032 — the same audited
/// GOAL-mode read the GUI uses, flattened by the route's shaper). Null-tolerant
/// on every scalar per the decode discipline above: a legacy/partial row must
/// never sink the whole goals decode and blank the Plans tab.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSummary {
    #[serde(default, deserialize_with = "null_as_default")]
    pub id: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub title: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub status: String,
    /// The status a reader should USE (server-derived dormancy fold), or null.
    #[serde(default)]
    pub effective_status: Option<String>,
    #[serde(default)]
    pub deactivated: bool,
    /// held | unheld | lost | unknown — the server's holder verdict.
    #[serde(default, deserialize_with = "null_as_default")]
    pub holder_liveness: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    /// The TRUE pot count — `pots` below is a bounded sample, never a total.
    #[serde(default)]
    pub pot_count: i64,
    #[serde(default)]
    pub pots: Vec<GoalPotChip>,
    #[serde(default)]
    pub open_work_items: i64,
    #[serde(default)]
    pub needs_human: i64,
    #[serde(default)]
    pub spend_usd: f64,
    #[serde(default)]
    pub budget_cents: Option<i64>,
    #[serde(default)]
    pub last_activity_at: Option<String>,
}

impl GoalSummary {
    /// The status to render: the server-derived effective status when present,
    /// else the raw declared one.
    pub fn shown_status(&self) -> &str {
        self.effective_status
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.status)
    }
}

/// `GET /api/tui/goals` → `{ goals, totalGoals, truncatedByLimit }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalsResponse {
    #[serde(default)]
    pub goals: Vec<GoalSummary>,
    /// The TRUE matching count — never render `goals.len()` as the total.
    #[serde(default)]
    pub total_goals: i64,
    #[serde(default)]
    pub truncated_by_limit: bool,
}

/// One row of `/api/adv/roster` → `{ active: [...] }`. Presence (primary) +
/// adv_sessions enrichment; field set mirrors `adv-roster.ts`'s `RosterEntry`.
/// The location/handle fields (pid/pidAlive/host/windowId/ompThreadId/cwd/mode/
/// advSessionId/hasLaunchRecord) drive Enter-by-location routing (pui-workbench-
/// usability D-001): they tell where the agent lives so Enter reaches it instead
/// of silently focusing an empty pane.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterEntry {
    // `null_as_default`: an `ended`-tier roster entry can carry `ownerId: null`
    // (a recorded session that never minted a coord owner id) — a bare required
    // `String` rejects both null and absent, failing the WHOLE roster decode.
    // The brain-view panes (the only `ended`-tier reader) key off role +
    // session_id, never owner_id, so "" is a safe default here; the Fleet roster
    // reads the `active` tier, where ownerId is always present.
    #[serde(default, deserialize_with = "null_as_default")]
    pub owner_id: String,
    // `null_as_default` on every non-Option scalar: the `ended` roster tier
    // (synthesized from listEndedAdvSessions, not the presence snapshot) nulls
    // fields the `active` tier always populates — e.g. a recorded console launch
    // has `label: null`. A bare required `String` rejects null AND aborts the
    // whole roster decode, so the brain-view pane regressed to "waiting…". This
    // hardens the whole class (label/source/liveness/host), not just the one
    // field that happened to be null today.
    #[serde(default, deserialize_with = "null_as_default")]
    pub label: String,
    /// client/source: claude · codex · omp · …
    #[serde(default, deserialize_with = "null_as_default")]
    pub source: String,
    #[serde(default)]
    pub intent: Option<String>,
    // `null_as_default`: the `ended` roster tier serializes these list fields as
    // JSON `null`, not `[]` — a bare `#[serde(default)]` only covers an ABSENT
    // field, so a present `null` aborts the whole roster decode ("invalid type:
    // null, expected a sequence"). That hard-error is what kept the Overwatch
    // brain-view pane on "waiting…" once the ended tier was read (its entries
    // carry `launchArgv: null`).
    #[serde(default, deserialize_with = "null_as_default")]
    pub current_files: Vec<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub liveness: String,
    /// Authoritative lifecycle verdict from the shared session-state oracle.
    /// `None` means the oracle leg was unavailable or the payload predates it;
    /// only then may callers fall back to the legacy heartbeat-age fields.
    #[serde(default)]
    pub session_state: Option<String>,
    /// Whether the oracle observed a turn in flight. This is an activity hint,
    /// not a second lifecycle verdict.
    #[serde(default)]
    pub live_turn: Option<bool>,
    /// Raw process-heartbeat freshness from the oracle. Kept explicitly named
    /// so no UI can mistake it for agent liveness.
    #[serde(default)]
    pub heartbeat_fresh: Option<bool>,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub feature: Option<String>,
    #[serde(default)]
    pub current_plan_slug: Option<String>,
    #[serde(default)]
    pub heartbeat_at: Option<String>,
    // ── location / control handles (D-001) ──
    /// OS pid of the agent process; null for a remote/console row.
    #[serde(default)]
    pub pid: Option<i64>,
    /// Is the OS process alive? `Some(false)` = fresh heartbeat but dead process
    /// (a zombie — do NOT focus, it's resumable). `None` = unknown (remote/stale).
    #[serde(default)]
    pub pid_alive: Option<bool>,
    /// Hostname the agent runs on ("" = unknown/local); window-focus only works
    /// same-host.
    #[serde(default, deserialize_with = "null_as_default")]
    pub host: String,
    /// X11 window id of the agent's external terminal window (console launches).
    #[serde(default)]
    pub window_id: Option<String>,
    /// OMP thread id (resume handle for omp sessions).
    #[serde(default)]
    pub omp_thread_id: Option<String>,
    /// Working directory the session was launched in (resume cd target).
    #[serde(default)]
    pub cwd: Option<String>,
    /// Launch mode: "omp" | "console" (null = plain presence, no launch record).
    #[serde(default)]
    pub mode: Option<String>,
    /// adv_sessions row id — the `psu --resume <id>` handle (D-001 ended-session
    /// route) and the `/api/adv/sessions/focus` `id` lookup. `alias = "id"`: the
    /// `ended` roster tier is raw `AdvSessionRow` JSON, which names this PK plainly
    /// `id` (never `advSessionId`), so the alias backfills it for ended entries.
    /// That gives the brain-view's newest-wake selection a real monotonic key
    /// (the PK rises with each wake) instead of all-zeros — so it picks the LATEST
    /// ended overwatch/queen wake deterministically, not whatever the server
    /// happened to list first. Safe: `active`/`pending` entries emit `advSessionId`
    /// (or omit both), never a conflicting `id`.
    #[serde(default, alias = "id")]
    pub adv_session_id: Option<i64>,
    /// Stable agent-chat identity when this roster/search row is backed by the
    /// operator-owned chat store.  Session controls key off this value rather
    /// than trying to reverse-engineer an id from a transcript reference.
    #[serde(default)]
    pub agent_chat_id: Option<String>,
    /// Exact harness carried by the indexed agent-chat provenance.  A missing
    /// value disables chat mutations; the ambient selected pot is never used as
    /// a guess because that could rename/archive a same-id fixture elsewhere.
    #[serde(default)]
    pub session_harness: Option<String>,
    /// Whether a joinable adv_sessions launch row exists (resume/focus eligible).
    #[serde(default)]
    pub has_launch_record: bool,
    // ── reactive workbench-pane hints (pui-reactive-session-panes D-002/D-006) ──
    /// Pane-worthiness hint: `Some("workbench")` on a PENDING launch the pui
    /// should reactively open a work-area pane for; `None` on a normal entry.
    /// The pui panes only `display == "workbench"` entries (the `pending` tier).
    #[serde(default)]
    pub display: Option<String>,
    /// The argv the pui pane runs for a pending workbench launch (a fresh
    /// `psu …`); empty for a normal entry. `null_as_default`: the `ended` tier
    /// serializes this as `null` (see current_files above) — without it the
    /// whole roster decode fails and the brain-view pane shows "waiting…".
    #[serde(default, deserialize_with = "null_as_default")]
    pub launch_argv: Vec<String>,
    // ── agent pane-kind (hive-agent-tabs-psu-tui P-001) ── stamped by the backend
    //    (adv-roster.ts via classifyAgentPane); parsed via agent_pane_kind.rs.
    //    Consumed in Phase 4 (P-010 color / P-011 grouping) — allow until wired.
    /// "queen" | "bee" | "sentinel" | "planner" (None on older/unknown payloads).
    #[serde(default)]
    #[allow(dead_code)]
    pub agent_pane_kind: Option<String>,
    /// "auto" | "responsive" — the default drive mode for the kind (P-001/D-005).
    #[serde(default)]
    #[allow(dead_code)]
    pub drive_mode: Option<String>,
    /// The bee's native claude session id (mig 203 spawned_agents.session_id) — the
    /// `claude --resume <id>` handle for the bee pane (P-004). None for non-bee /
    /// omp / pending entries. Consumed when the bee pane lands — allow until then.
    #[serde(default)]
    #[allow(dead_code)]
    pub session_id: Option<String>,
    /// Backend-neutral native session handle (adv-roster.ts nativeSession). This
    /// is the durable attach/resume contract for hive tabs: Claude session ids,
    /// Codex CODEX_HOME+rollout handles, and OMP thread ids.
    #[serde(default)]
    pub native_session: Option<NativeSessionHandle>,
    /// The agent's effective wake mode ("auto" | "manual"), the P-008 badge. None
    /// for pending entries / pre-flag payloads. Rendered in the Fleet roster.
    #[serde(default)]
    #[allow(dead_code)]
    pub wake_mode: Option<String>,
    /// Staged (manual-mode) wakes awaiting owner release — the P-008 badge's
    /// pending COUNT and the P-009 review-overlay trigger. 0 when nothing staged
    /// (or a pre-count payload).
    #[serde(default)]
    pub pending_wakes: i64,
    /// Declared on a plan but holding no claim backing it (claim-discipline-
    /// enforcement-2026-06-10; stamped by adv-roster.ts, same semantics as the
    /// fleet_assignment view). Rendered as a ⚠ in the Fleet/colony roster so an
    /// "active" agent without a claimed lane is visibly different.
    #[serde(default)]
    pub declared_unclaimed: bool,
    // ── fleet membership (fleet-color-schemes #3) ── stamped by adv-roster.ts.
    /// The named fleet this agent belongs to (`fleetSlug`; None = no fleet).
    /// Drives the Fleet-tab roster grouping.
    #[serde(default)]
    pub fleet_slug: Option<String>,
    /// Registry role inside `fleet_slug`; the leader cockpit binds only to the
    /// active row explicitly marked `leader`, never an arbitrary fleet member.
    #[serde(default)]
    pub fleet_role: Option<String>,
    /// The fleet's bound color-scheme ACCENT (hex, e.g. "#38bdf8") for the colored
    /// group header; None when no fleet / unresolved (the pui draws it neutral).
    #[serde(default)]
    pub fleet_color: Option<String>,
    /// Canonical `sessions:read` reference supplied by `sessions:search`.
    /// Browser and switcher rows share this field so transcript rendering never
    /// reconstructs a backend-specific session address locally.
    #[serde(default)]
    pub transcript_ref: Option<String>,
    /// Whether transcript presence has actually been established. The roster
    /// payload does not carry this field, so rows begin `unknown`; bounded seed
    /// hits promote them to `available`, and only an exact lazy lookup may mark
    /// them `unavailable`.
    #[serde(default)]
    pub transcript_availability: SessionTranscriptAvailability,
    /// Search-result excerpt used as the immediate preview while the canonical
    /// transcript tail is loading.
    #[serde(default)]
    pub transcript_excerpt: Option<String>,
    /// Indexed transcript timestamp. ISO/PG timestamps sort lexically and also
    /// drive the browser's coarse time-window facets.
    #[serde(default)]
    pub transcript_at: Option<String>,
}

/// One normalized `sessions:read` turn. The session browser deliberately keeps
/// the canonical speaker/time/text shape instead of parsing rendered transcript
/// strings, so every backend gets the same preview renderer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct SessionTranscriptTurn {
    #[serde(default)]
    pub speaker: String,
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetLeaderBrief {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub summary: FleetLeaderSummary,
    #[serde(default)]
    pub members: Vec<FleetLeaderMember>,
    /// None means the server's bounded discovery leg was unavailable; Some([])
    /// is a measured empty gate set.
    #[serde(default)]
    pub announced_gates: Option<Vec<FleetLeaderGate>>,
    #[serde(default)]
    pub custom_invariants: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub admission_blocked: Vec<serde_json::Value>,
    #[serde(default)]
    pub spec_revision: Option<i64>,
    #[serde(default)]
    pub spec_matched: Option<i64>,
    #[serde(default)]
    pub harness_wide_pool: Option<i64>,
    /// Canonical, spec-scoped work metrics from `fleet:leader-brief`. This is
    /// deliberately separate from the live member summary above: the two use
    /// different populations and must never be compared without the scope
    /// labels carried by this result.
    #[serde(default)]
    pub fleet_metrics: Option<FleetMetricsResult>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetMetricsResult {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub schema_version: String,
    #[serde(default)]
    pub snapshot: Option<FleetMetricsSnapshot>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub recover_via: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetMetricsSnapshot {
    #[serde(default)]
    pub scope: FleetMetricsScope,
    #[serde(default)]
    pub quality: FleetMetricsQuality,
    #[serde(default)]
    pub remaining: FleetMetricsRemaining,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetMetricsScope {
    #[serde(default)]
    pub window: FleetMetricsWindow,
    #[serde(default)]
    pub stock: FleetMetricsStockScope,
    #[serde(default)]
    pub population: FleetMetricsPopulation,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetMetricsWindow {
    #[serde(default)]
    pub kind: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetMetricsStockScope {
    #[serde(default)]
    pub spec_id: String,
    #[serde(default)]
    pub revision: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetMetricsPopulation {
    #[serde(default)]
    pub stock: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FleetMetricsQuality {
    #[serde(default)]
    pub exactness: FleetMetricsQualityStatus,
    #[serde(default)]
    pub freshness: FleetMetricsQualityStatus,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FleetMetricsQualityStatus {
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FleetMetricsRemaining {
    #[serde(default)]
    pub total: i64,
    #[serde(default)]
    pub unit: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FleetLeaderSummary {
    #[serde(default)]
    pub fleet: String,
    #[serde(default)]
    pub members: i64,
    #[serde(default)]
    pub speaking: i64,
    #[serde(default)]
    pub stalled: i64,
    #[serde(default)]
    pub dead: i64,
    #[serde(default)]
    pub high_context: i64,
    #[serde(default)]
    pub critical_context: i64,
    #[serde(default)]
    pub claimable_now: serde_json::Value,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetLeaderMember {
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub session_state: Option<String>,
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub context_pressure: Option<String>,
    #[serde(default)]
    pub last_tool_call_age_ms: Option<i64>,
    #[serde(default)]
    pub work_item_ids: Vec<String>,
    #[serde(default)]
    pub queued_count: i64,
    #[serde(default)]
    pub load: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetLeaderGate {
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub announced_by: String,
    #[serde(default)]
    pub fired: bool,
    #[serde(default)]
    pub fired_at: Option<String>,
    #[serde(default)]
    pub awaiters: i64,
}

impl RosterEntry {
    /// Is this session actively taking turns according to the shared oracle?
    /// Known oracle states always win; heartbeat age is compatibility-only for
    /// absent or unknown states from older/degraded payloads.
    pub fn is_online(&self) -> bool {
        match self
            .session_state
            .as_deref()
            .map(str::trim)
            .filter(|state| !state.is_empty())
        {
            Some("live") => true,
            Some("parked" | "draining" | "suspect" | "ended" | "recorded") => false,
            Some(_) | None => !self.stale && !self.liveness.eq_ignore_ascii_case("stale"),
        }
    }

    /// Sort key that GROUPS the roster by fleet for the Fleet-tab display (#3):
    /// fleets alphabetical by slug, agents in NO fleet last. A STABLE sort with
    /// this key keeps the server's within-fleet (newest-heartbeat) order.
    pub fn fleet_group_sort_key(&self) -> (u8, String) {
        match self.fleet_slug.as_deref().filter(|s| !s.is_empty()) {
            Some(s) => (0, s.to_string()),
            None => (1, String::new()),
        }
    }

    /// Is the agent's process running right now? A live/idle heartbeat AND not a
    /// known zombie (`pid_alive == Some(false)` is a fresh heartbeat over a dead
    /// process). Used to decide focus-vs-resume so a resume never double-spawns a
    /// still-live session (D-001 liveness-first).
    pub fn is_live(&self) -> bool {
        self.pid_alive != Some(false) && self.is_online()
    }

    /// Can this agent be resumed by id? It needs an adv_sessions launch record
    /// (the `psu --resume <adv_session_id>` handle) and a known agent CLI.
    pub fn is_resumable(&self) -> bool {
        self.adv_session_id.is_some() && self.agent.is_some()
    }

    /// Does it carry a same-host external-window handle the focus route can use
    /// (an explicit window id, or a pid the route can resolve via wmctrl)?
    /// Cross-host pids can't be focused locally (and could collide), so they
    /// don't count.
    pub fn has_window_handle(&self, local_host: &str) -> bool {
        let same_host = self.host.is_empty() || self.host == local_host;
        let has_wid = self
            .window_id
            .as_deref()
            .map(|w| !w.is_empty())
            .unwrap_or(false);
        has_wid || (same_host && self.pid.is_some())
    }

    /// The dock pane command for this entry as a fleet bee (hive-agent-tabs P-004
    /// / D-007). Prefer the backend-neutral native session handle; fall back to
    /// the legacy Claude `session_id` field for older roster payloads. `None` =
    /// no actionable backend handle yet, so the bee stays visible in rosters but
    /// gets no dock pane.
    pub fn dock_pane_argv(&self) -> Option<Vec<String>> {
        if let Some(handle) = &self.native_session {
            if let Some(argv) = handle.dock_pane_argv() {
                return Some(argv);
            }
        }
        self.session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|sid| {
                vec![
                    "claude".to_string(),
                    "--resume".to_string(),
                    sid.to_string(),
                ]
            })
    }

    /// A short summary of what this agent is currently doing — its declared coord
    /// intent, else the feature id it's on. For the bee pane title bar (P-012).
    /// None when nothing's declared (the title falls back to the owner id).
    pub fn work_summary(&self) -> Option<String> {
        let pick = |s: &Option<String>| {
            s.as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(|t| t.to_string())
        };
        pick(&self.intent).or_else(|| pick(&self.feature))
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "backend", rename_all = "camelCase")]
pub enum NativeSessionHandle {
    #[serde(rename = "claude", rename_all = "camelCase")]
    Claude {
        #[serde(default)]
        source: String,
        #[serde(default)]
        owner_id: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
        /// The session's isolated CLAUDE_CONFIG_DIR (adv-roster `configDir`) —
        /// the transcript lives under it, so the attach must run with this env
        /// set (the claude analog of `codex_home`). None on legacy payloads.
        #[serde(default)]
        config_dir: Option<String>,
        #[serde(default)]
        exact_resume_supported: bool,
        #[serde(default)]
        missing_reason: Option<String>,
    },
    #[serde(rename = "codex", rename_all = "camelCase")]
    Codex {
        #[serde(default)]
        source: String,
        #[serde(default)]
        owner_id: Option<String>,
        #[serde(default)]
        codex_home: String,
        #[serde(default)]
        rollout_id: Option<String>,
        #[serde(default)]
        exact_resume_supported: bool,
        #[serde(default)]
        missing_reason: Option<String>,
    },
    #[serde(rename = "omp", rename_all = "camelCase")]
    Omp {
        #[serde(default)]
        source: String,
        #[serde(default)]
        owner_id: Option<String>,
        #[serde(default)]
        omp_thread_id: Option<String>,
        #[serde(default)]
        agent_home: Option<String>,
        #[serde(default)]
        exact_resume_supported: bool,
        #[serde(default)]
        missing_reason: Option<String>,
    },
}

impl NativeSessionHandle {
    pub fn dock_pane_argv(&self) -> Option<Vec<String>> {
        match self {
            Self::Claude {
                session_id,
                config_dir,
                ..
            } => session_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|sid| {
                    // The transcript lives under the session's ISOLATED config
                    // dir, not the default one — a bare `claude --resume` finds
                    // nothing there. Wrap with env exactly like the Codex arm
                    // wraps CODEX_HOME; bare only for legacy payloads without
                    // a configDir.
                    match config_dir
                        .as_deref()
                        .map(str::trim)
                        .filter(|d| !d.is_empty())
                    {
                        Some(dir) => vec![
                            "env".to_string(),
                            format!("CLAUDE_CONFIG_DIR={dir}"),
                            "claude".to_string(),
                            "--resume".to_string(),
                            sid.to_string(),
                        ],
                        None => vec![
                            "claude".to_string(),
                            "--resume".to_string(),
                            sid.to_string(),
                        ],
                    }
                }),
            Self::Codex {
                codex_home,
                rollout_id,
                ..
            } => {
                let home = codex_home.trim();
                if home.is_empty() {
                    return None;
                }
                let mut argv = vec![
                    "env".to_string(),
                    format!("CODEX_HOME={home}"),
                    "codex".to_string(),
                    "resume".to_string(),
                ];
                if let Some(id) = rollout_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    argv.push(id.to_string());
                } else {
                    argv.push("--last".to_string());
                }
                Some(argv)
            }
            Self::Omp { omp_thread_id, .. } => omp_thread_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|thread| {
                    vec![
                        "omp".to_string(),
                        "-r".to_string(),
                        thread.to_string(),
                        "--approval-mode".to_string(),
                        "yolo".to_string(),
                    ]
                }),
        }
    }
}

/// One deployed cloud frame (`GET /api/deploy/frames` → `frames[]`) — the
/// per-frame-tab roster (hive-agent-tabs P-013). Registry-backed: a frame is
/// listed exactly while its deploy handle persists (deploy → teardown).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct DeployFrameRow {
    pub slug: String,
    #[serde(default)]
    pub frame: DeployFrameInfo,
    /// Whether the frame runs a desktop (streamable via the webview Frames tab).
    #[serde(default)]
    pub desktop: bool,
}

/// The frame handle inside a [`DeployFrameRow`].
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct DeployFrameInfo {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeployFramesResponse {
    #[serde(default)]
    pub frames: Vec<DeployFrameRow>,
}

/// One staged wake awaiting owner review (hive-agent-tabs P-009 / D-005) —
/// mirrors `pending-wakes.ts`'s `PendingWake`, carried inside the
/// `coord:wake-queue {action:'list'}` run-tool payload.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingWake {
    pub id: i64,
    #[serde(default)]
    pub owner_id: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub created_at: String,
    /// How many identical fires coalesced into this row (EI-312, migration
    /// 224; ≥1). Default 1 so a pre-coalescing payload still parses.
    #[serde(default = "default_wake_count")]
    pub count: i64,
    /// When the newest coalesced fire was staged (== created_at until a re-fire).
    #[serde(default)]
    pub last_seen_at: Option<String>,
}

fn default_wake_count() -> i64 {
    1
}

/// One agent's slice of the fleet-wide staged-wake board (the `pui wake-pane`
/// dock pane, EI-312): the roster identity + its queue. Assembled client-side
/// from the roster + per-agent `coord:wake-queue` lists, queen first.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WakeGroup {
    pub agent: String,
    pub label: String,
    /// The roster's pane-kind tag ("queen" | "bee" | …) — drives the glyph.
    pub kind: Option<String>,
    pub wake_mode: Option<String>,
    pub pending: Vec<PendingWake>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RosterResponse {
    // All three tiers use `null_as_default`, not bare `#[serde(default)]`: the
    // operator serializes an EMPTY tier as JSON `null` (not `[]` / absent), and
    // bare `default` only fills an ABSENT field — a present `null` still fails
    // with "invalid type: null, expected a sequence", aborting the WHOLE decode.
    // That is exactly the bug that made the Overwatch pane say "waiting…": adding
    // the `ended` tier surfaced an `"ended": null` payload that hard-errored
    // roster decode, so resolve_session bailed before selecting anything.
    #[serde(default, deserialize_with = "null_as_default")]
    pub active: Vec<RosterEntry>,
    /// Recently-ended sessions (`/api/adv/roster` `ended` tier) — the durable
    /// history half of the live roster. The brain-view panes MUST read this: a
    /// short-lived autonomous wake (the Overwatch's every-10-min invoke, a Queen
    /// wake between cycles) is `markAdvSessionEnded` the instant its run returns,
    /// so by the time a pane resolves it the row is already here, NOT in `active`.
    /// Tailing it from `ended` is exactly the pane's "keeps showing the last
    /// wake's transcript, which persists on disk after the process exits" contract
    /// (brain_view.rs). The Fleet roster ignores this tier (it renders `active`).
    #[serde(default, deserialize_with = "null_as_default")]
    pub ended: Vec<RosterEntry>,
    /// Pending workbench launches (pui-reactive-session-panes D-006): recorded but
    /// not-yet-running sessions, in a SEPARATE tier from `active`. The pui reads
    /// these to reactively open work-area panes; they never render in the roster.
    #[serde(default, deserialize_with = "null_as_default")]
    pub pending: Vec<RosterEntry>,
}

/// One action offered by the canonical attention adapter. The TUI preserves
/// this array instead of re-deriving policy from `kind`.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttentionAction {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub primary: bool,
}

/// One attention item from `/api/admin/plans/attention` (Inbox).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub harness_slug: Option<String>,
    #[serde(default)]
    pub plan_slug: Option<String>,
    #[serde(default)]
    pub item_ref: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub status: String,
    /// Canonical attention priority from the plans:attention wire
    /// (`urgent`/`high`/`normal`/`low`). Older or synthetic rows may omit it.
    #[serde(default)]
    pub importance: Option<String>,
    #[serde(default)]
    pub needs_human: bool,
    /// Inbox tier (inbox-tiering-and-message-agent D-006): decision | handled |
    /// alert | activity. Optional for back-compat with older payloads.
    #[serde(default)]
    pub tier: Option<String>,
    /// The owning agent (drives "Message owner").
    #[serde(default)]
    pub owner_agent_id: Option<String>,
    #[serde(default)]
    pub owner_label: Option<String>,
    /// Operator-triage overlay.
    #[serde(default)]
    pub triage_state: Option<String>,
    #[serde(default)]
    pub triage_note: Option<String>,
    /// Structured report payload (kind `operator-report` only) — the operator's
    /// `<report>` block, rendered natively as a two-tier plan→item list in the
    /// Inbox detail (report-cards-inbox-reconciliation-2026-06-05; chat is
    /// conversation-only).
    #[serde(default)]
    pub report: Option<crate::chat_tags::Report>,
    /// Server-authored action policy. Kept in full so `a`/Enter can dispatch
    /// only an action the selected snapshot actually offered.
    #[serde(default)]
    pub actions: Vec<AttentionAction>,
    /// Heterogeneous owning-source handle (`ref` on the wire). Opaque except
    /// for the small field reads in the action router; preserving the complete
    /// object prevents a client-side shadow identity from drifting.
    #[serde(default, rename = "ref")]
    pub reference: serde_json::Value,
}

/// The four inbox tiers (inbox-tiering-and-message-agent D-006), in display
/// order: Decisions ▸ Handled-by-operator ▸ Alerts ▸ Activity.
pub const INBOX_TIERS: [&str; 4] = ["decision", "handled", "alert", "activity"];

/// Human label for a tier string.
pub fn tier_label(tier: &str) -> &'static str {
    match tier {
        "decision" => "Decisions",
        "handled" => "Handled by operator",
        "alert" => "Alerts",
        _ => "Activity",
    }
}

/// Single-width, alignment-safe marker glyph for a tier (TUI in-line use).
/// Glyphs come from the shared vocabulary (`crate::glyph`, Brief 27) so a
/// vocabulary swap propagates here automatically.
pub fn tier_glyph(tier: &str) -> &'static str {
    match tier {
        "decision" => crate::glyph::status::NEEDS_HUMAN,
        "handled" => crate::glyph::status::DONE,
        "alert" => crate::glyph::severity::ALERT,
        _ => crate::glyph::severity::INFO,
    }
}

impl AttentionItem {
    /// Effective tier (older payloads without a tier read as activity).
    pub fn tier_str(&self) -> &str {
        self.tier.as_deref().unwrap_or("activity")
    }
    /// Sort rank — decision(0) ▸ handled(1) ▸ alert(2) ▸ activity(3).
    pub fn tier_rank(&self) -> u8 {
        match self.tier_str() {
            "decision" => 0,
            "handled" => 1,
            "alert" => 2,
            _ => 3,
        }
    }

    /// The P-013 Needs-you facet is deliberately broader than `needsHuman`:
    /// owner-wall and open-question cards remain actionable even when the
    /// source's liveness policy tiers them as Alerts.
    pub fn is_needs_you(&self) -> bool {
        self.needs_human || matches!(self.kind.as_str(), "owner-wall" | "conversation")
    }

    pub fn has_action(&self, id: &str) -> bool {
        self.actions.iter().any(|action| action.id == id)
    }

    pub fn primary_action(&self) -> Option<&AttentionAction> {
        self.actions.iter().find(|action| action.primary)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionGroup {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub plan_slug: Option<String>,
    #[serde(default)]
    pub items: Vec<AttentionItem>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AttentionResponse {
    #[serde(default)]
    pub groups: Vec<AttentionGroup>,
}

/// One feature from the `list_features` agent-tool payload.
#[derive(Debug, Clone, Deserialize)]
pub struct HarnessFeature {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub attempts: u32,
}

/// Inner JSON of the `list_features` MCP envelope (`content[0].text`).
#[derive(Debug, Clone, Deserialize)]
pub struct FeaturesPayload {
    #[serde(default)]
    pub features: Vec<HarnessFeature>,
}

/// One issue from `/api/harness/:slug/issues` (mirrors `app/harness/issues/types` Issue).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessIssue {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub found_during: Option<String>,
    #[serde(default)]
    pub linked_feature_id: Option<String>,
    #[serde(default)]
    pub attempts: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IssuesResponse {
    #[serde(default)]
    pub issues: Vec<HarnessIssue>,
}

/// One harness from `/api/harness/projects/lite`.
#[derive(Debug, Clone, Deserialize)]
pub struct HarnessRef {
    pub slug: String,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectsResponse {
    #[serde(default)]
    pub projects: Vec<HarnessRef>,
}

// ─── Create / share pot (D-010) ───

/// `POST /api/harness/projects` result — the registered project on success;
/// `error` carries the backend's message (e.g. "slug already exists") on 4xx.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateProjectResponse {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub project: Option<HarnessRef>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub provisioning: Option<ProjectProvisioning>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectProvisioning {
    pub ok: bool,
    pub error: Option<String>,
}

// NOTE: `BindingResolveResponse` was removed with the retired per-harness
// share flow (comb-retire-per-harness-sharing-2026-06-11; P-003 2026-08-24).

// ─── Cupboard tab (D-011) ───

/// One marketplace listing from `GET /api/cupboard/listings` (the operator's
/// proxy onto the Cupboard worker). Field-tolerant: every field defaults so a
/// worker-side schema addition never breaks the tab.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
pub struct CupboardListing {
    #[serde(default)]
    pub id: String,
    /// The live Cupboard listing kind. Older workers may send `tool-pack`; the
    /// action/filter helpers below normalize that compatibility value to `pack`.
    #[serde(default)]
    pub listing_kind: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// The Pot rollup key (D-008).
    #[serde(default)]
    pub project_ref: Option<String>,
    /// Within-project discriminator (blueprint/snapshot/plugin name).
    #[serde(default)]
    pub listing_ref: Option<String>,
    #[serde(default)]
    pub github_repository_id: Option<i64>,
    #[serde(default)]
    pub github_owner: Option<String>,
    #[serde(default)]
    pub github_name: Option<String>,
    #[serde(default)]
    pub github_url: Option<String>,
    /// 64-char hex Hypercore topic (harness listings).
    #[serde(default)]
    pub topic_hex: Option<String>,
    #[serde(default)]
    pub publisher_github_login: Option<String>,
    #[serde(default)]
    pub claim_status: Option<String>,
    #[serde(default)]
    pub stars: Option<i64>,
    #[serde(default)]
    pub contributor_count: Option<i64>,
    #[serde(default)]
    pub last_activity_at: Option<i64>,
    /// Ready-made `papercusp://harness?…` join link (harness listings; when
    /// absent the join flow derives it from topic/github/repo-id).
    #[serde(default)]
    pub harness_link: Option<String>,
    /// App distribution discriminator. `bundle` is installable in this
    /// workspace; `standalone` is a download-link handoff.
    #[serde(default)]
    pub delivery_type: Option<String>,
    /// Standalone-app updater manifest URL. A missing URL means the row is
    /// intentionally read-only until a release is published.
    #[serde(default)]
    pub latest_json_url: Option<String>,
}

impl CupboardListing {
    /// Normalize the one legacy wire spelling still accepted by the worker.
    pub fn normalized_kind(&self) -> &str {
        if self.listing_kind == "tool-pack" {
            "pack"
        } else {
            self.listing_kind.as_str()
        }
    }

    /// Return the safe action affordance for this row, or `None` when the TUI
    /// has no corresponding flow. Keeping unsupported kinds read-only is
    /// important: an arm/confirm affordance must never end in a generic
    /// "no action" error after the user confirms it.
    pub fn action_label(&self) -> Option<&'static str> {
        match self.normalized_kind() {
            "harness" => self.join_link().as_deref().map(|_| "join"),
            "blueprint" | "plugin" | "pack" | "template" => Some("install"),
            // This route only stages the pack in the local store. Installing it
            // into a Hive remains the normal reviewed Learnings flow.
            "knowledge-pack" => Some("stage"),
            "app" => match self.delivery_type.as_deref() {
                Some("bundle") => Some("install"),
                // Standalone apps are a release-link handoff. PUI shows the
                // manifest URL but does not pretend it can safely install or
                // launch the external artifact.
                _ => None,
            },
            _ => None,
        }
    }

    /// Display name: title > listing_ref > github repo > id.
    pub fn display_name(&self) -> &str {
        self.title
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(self.listing_ref.as_deref())
            .or(self.github_name.as_deref())
            .unwrap_or(&self.id)
    }

    /// The `papercusp://harness?…` join link for a harness listing — the
    /// published one, else derived from topic + github + repo id (the same
    /// fields `buildHarnessJoinLink` uses on the desktop).
    pub fn join_link(&self) -> Option<String> {
        if let Some(l) = self.harness_link.as_deref().filter(|s| !s.is_empty()) {
            return Some(l.to_string());
        }
        let topic = self.topic_hex.as_deref().filter(|s| !s.is_empty())?;
        let owner = self.github_owner.as_deref().filter(|s| !s.is_empty())?;
        let name = self.github_name.as_deref().filter(|s| !s.is_empty())?;
        let repo_id = self.github_repository_id?;
        Some(format!(
            "papercusp://harness?topic={topic}&github={owner}/{name}&repo_id={repo_id}"
        ))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct CupboardListingsResponse {
    #[serde(default)]
    pub listings: Vec<CupboardListing>,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub total: Option<usize>,
    #[serde(default)]
    pub kind_facets: std::collections::BTreeMap<String, usize>,
}

/// One discovered hive from `GET /api/discovery/pots` (p2p-hive-directory P-006).
/// The verified, browseable directory listing the Hives tab renders + joins.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct DiscoveredHiveRow {
    #[serde(rename = "hiveId", default)]
    pub hive_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub visibility: String,
    /// Full papercusp://harness?... join links per member harness (one-click join).
    #[serde(rename = "memberLinks", default)]
    pub member_links: Vec<String>,
    #[serde(rename = "memberCount", default)]
    pub member_count: u32,
}

/// `GET /api/discovery/pots` response envelope.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct DiscoveredHivesResponse {
    #[serde(default)]
    pub rows: Vec<DiscoveredHiveRow>,
}

/// Visibility accepted by the hive-native sharing writer
/// (`discovery:set_pot` / `POST /api/discovery/set-pot`).
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HiveVisibility {
    Public,
    Invite,
    Private,
}

impl HiveVisibility {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Invite => "invite",
            Self::Private => "private",
        }
    }
}

/// Owner-side prefill returned by `GET /api/discovery/pot-meta`.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HiveShareMeta {
    #[serde(default)]
    pub pot_id: String,
    #[serde(default)]
    pub found: bool,
    #[serde(default)]
    pub visibility: Option<HiveVisibility>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub invite_secret: Option<String>,
    #[serde(default)]
    pub hive_pubkey: Option<String>,
    #[serde(default)]
    pub member_repos: Vec<String>,
}

/// Typed body for `POST /api/discovery/set-pot`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetHiveListingRequest {
    pub pot_id: String,
    pub title: String,
    pub description: String,
    pub visibility: HiveVisibility,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_secret: Option<String>,
}

/// Outcome returned by the shared hive listing composition. A successful save
/// can still carry `announce_error`; callers must not call that "published".
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetHiveListingResponse {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub saved: bool,
    #[serde(default)]
    pub announced: bool,
    #[serde(default)]
    pub reachable_peers: Option<u64>,
    #[serde(default)]
    pub withdrawn: bool,
    #[serde(default)]
    pub tombstone_sent: bool,
    #[serde(default)]
    pub announce_error: Option<String>,
}

/// One network-board row — the PINNED C-3 contract
/// (hive-network-surface-2026-06-11, owner B-08): one hive-context over the
/// capability ladder. An absent optional field means that TIER lacks the data
/// (a tier-1 local hive has no beacon; a tier-4 gossip hive has no verified
/// presence) — renderers HIDE the section, never paint empties. Do not add or
/// rename fields without a plan edit + coord to every C-3 consumer.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct NetworkBoardRow {
    /// Capability tier: 1 this hive · 2 own/admin · 3 shared-Hive peer swarm
    /// (substrate-verified) · 4 foreign directory hive (self-reported beacon).
    #[serde(default)]
    pub tier: u8,
    /// Stable row identity: a harness/hive slug (tiers 1-2) or the peer's
    /// device pubkey base64 (tiers 3-4). The drill-in tab key (B-10 seam).
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub title: String,
    /// Trust label: local | admin | federated | gossip. Federated (substrate-
    /// verified) and gossip (self-reported) must render visually distinct.
    #[serde(default)]
    pub trust: String,
    #[serde(rename = "liveAgents")]
    pub live_agents: Option<u32>,
    #[serde(rename = "queueDepth")]
    pub queue_depth: Option<u32>,
    /// The hive's focus one-liner (beacon / curation:state-of-hive, ≤120).
    pub focus: Option<String>,
    /// ISO timestamp of the freshest signal (sorts lexically).
    #[serde(rename = "lastSeen")]
    pub last_seen: Option<String>,
    pub wake: Option<NetworkWake>,
    pub grants: Option<NetworkGrants>,
    pub asks: Option<NetworkAsks>,
}

/// C-3 `wake` section — the hive's wake/scheduling state (own hives).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct NetworkWake {
    #[serde(default)]
    pub active: bool,
    #[serde(rename = "nextFireAt")]
    pub next_fire_at: Option<String>,
}

/// C-3 `grants` section — cross-hive grant kinds by direction. `in` is a Rust
/// keyword, hence the serde renames (no wire impact).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct NetworkGrants {
    #[serde(rename = "in", default)]
    pub inbound: Vec<String>,
    #[serde(rename = "out", default)]
    pub outbound: Vec<String>,
}

/// C-3 `asks` section — the P-002 cross-hive ask-ledger counts for this peer.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct NetworkAsks {
    #[serde(default)]
    pub pending: u32,
    #[serde(default)]
    pub answered: u32,
}

/// Network-board response envelope (B-08's data endpoint).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct NetworkBoardResponse {
    #[serde(default)]
    pub rows: Vec<NetworkBoardRow>,
}

/// One captured C-2 beacon snapshot (`network.hive.beacons`, migration 236) —
/// a tier-4 dossier's beacon-HISTORY row: how the foreign hive's self-reported
/// status evolved, newest-first (hive-network-surface P-014 item 2).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HiveBeaconSnapshot {
    #[serde(default)]
    pub hive_id: String,
    #[serde(default)]
    pub hive_pubkey: Option<String>,
    /// The C-2 beacon payload as announced (self-reported — gossip trust).
    #[serde(default)]
    pub beacon: BeaconFields,
    #[serde(default)]
    pub captured_at: String,
}

/// The C-2 beacon payload fields (all-or-none per D-002 v1 binary consent).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BeaconFields {
    #[serde(default)]
    pub live_agents: u32,
    #[serde(default)]
    pub queue_depth: u32,
    #[serde(default)]
    pub focus: String,
    #[serde(default)]
    pub last_completed: String,
    /// ISO-8601 build time of the beacon (the staleness key).
    #[serde(default)]
    pub ts: String,
}

/// One C-1 `cross_hive_asks` ledger row (`network.hive.asks`) — the tier-4
/// dossier's ask/answer traffic log, both directions, all states
/// (hive-network-surface P-014 item 2; the board row only carries counts).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrossHiveAskRow {
    #[serde(default)]
    pub peer_pubkey: String,
    /// 'out' (we asked them) | 'in' (they asked us).
    #[serde(default)]
    pub direction: String,
    /// 'ask' | 'work-request'.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub subject: String,
    /// queued | sent | answered | declined | expired.
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub reply_body: Option<String>,
    /// The asking owner's coord id (migration 235; null pre-235 / inbound).
    #[serde(default)]
    pub asked_by: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

// NOTE: the old Activity tab's `/api/harness/all/recent-activity` DTOs
// (ActivityEvent/ActivityResponse) were removed with the tab (D-004b) — the
// Fleet tab's `ActivityRow` (agent_activity) is the live activity surface.

/// One testing domain from `/api/harness/:slug/testing/domains`.
#[derive(Debug, Clone, Deserialize)]
pub struct TestingDomain {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tier: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TestingResponse {
    #[serde(default)]
    pub domains: Vec<TestingDomain>,
}

// ── Testing run-on-click (D-004a, pui-completion-and-polish-2026-06-05) ─────
//
// `GET /api/harness/:slug/testing/domain-detail?domainId=` resolves a domain's
// sections + their glob-walked files; the PUI flattens them into the runnable
// file list. `POST /api/harness/:slug/testing/run` runs one file (vitest,
// synchronous server-side) and returns the status + tail output.

/// One resolved file inside a testing-domain section (`{path,sizeBytes,mtimeMs}`;
/// only the path is rendered).
#[derive(Debug, Clone, Deserialize)]
pub struct TestingFileHit {
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TestingDomainSection {
    #[serde(default)]
    pub files: Vec<TestingFileHit>,
}

/// `GET /api/harness/:slug/testing/domain-detail` (only the file lists are kept).
#[derive(Debug, Clone, Deserialize)]
pub struct TestingDomainDetail {
    #[serde(default)]
    pub sections: Vec<TestingDomainSection>,
}

/// `POST /api/harness/:slug/testing/run` → the synchronous run result.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunResult {
    #[serde(default)]
    pub run_id: String,
    /// "pass" | "fail".
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub exit_code: i32,
    /// Tail of the runner output (server clips to the last 8000 chars).
    #[serde(default)]
    pub output: String,
}

/// Snapshot returned by the detached harness-testing lifecycle.  The shape is
/// shared by the start and status endpoints, so the TUI can paint rolling
/// output without holding a request open and can address cancellation by the
/// stable `run_id`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunSnapshot {
    #[serde(default)]
    pub run_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub command: Vec<String>,
    /// running | pass | fail | cancelled | error.
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub started_at: i64,
    #[serde(default)]
    pub finished_at: Option<i64>,
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub truncated: bool,
}

/// `/api/harness/:slug/claude-settings/effective` → the editable Config-tab
/// view (D-013): the raw file body (`content` — what `:set`/`:unset` edit and
/// PUT back), the *effective* settings (Claude Code defaults overlaid by the
/// file), which top-level keys the file provides, and a parse error when the
/// on-disk file is broken (the tab then shows defaults + the error).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveClaudeSettings {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub effective: serde_json::Value,
    #[serde(default)]
    pub file_keys: Vec<String>,
    #[serde(default)]
    pub parse_error: Option<String>,
}

/// One row of the merged docs tree (`/api/harness/:slug/docs`, harness-docs-
/// integration-2026-06-05 P-009): per-doc source + drift status for the badges.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocEntry {
    #[serde(default)]
    pub doc_id: String,
    /// generated | manual | augmented
    #[serde(default)]
    pub source: String,
    /// fresh | stale | review | untracked | unknown
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub subject_label: String,
}

/// The active doc's full entry — adds the human augmented overlay.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActiveDocEntry {
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub status_detail: Option<String>,
    #[serde(default)]
    pub subject_label: String,
    #[serde(default)]
    pub overlay: Option<String>,
}

/// `/api/harness/:slug/docs[?path=]` → the MERGED docs tree (generated · manual ·
/// augmented) with per-doc source + freshness + the active doc's overlay.
/// (Superset of the legacy project-docs shape, so old fields still deserialise.)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsResponse {
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub active_path: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub entries: Vec<DocEntry>,
    #[serde(default)]
    pub active_entry: Option<ActiveDocEntry>,
}

/// One row of `/api/toast-log` → `{ toasts: [...] }` (notification history, P8).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToastRow {
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub harness_slug: Option<String>,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToastsResponse {
    #[serde(default)]
    pub toasts: Vec<ToastRow>,
}

/// One pane the `plugins:tui_panes` agent-tool contributes (D-002, revive-plugin-
/// system-2026-06-04). `command` is the argv to run in a zellij pane (command[0]
/// is a PATH basename, e.g. `["sh","render.sh"]`); `cwd` is the dir to run it in.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuiPaneContribution {
    #[serde(default)]
    pub plugin_name: String,
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub cwd: String,
}

/// Inner JSON of the `plugins:tui_panes` MCP envelope (`content[0].text`).
#[derive(Debug, Clone, Deserialize)]
pub struct TuiPanesPayload {
    #[serde(default)]
    pub panes: Vec<TuiPaneContribution>,
}

/// One plugin manifest from `GET /api/plugins/global` (D-007/D-014) — the
/// fields the Plugins tab renders: identity, the frontend/backend contribution
/// surfaces, and the `configSchema` driving the settings view. Contribution
/// fields are deliberately loose `Value`s (manifests vary; the tab only counts
/// + names them via [`contribution_count`]/[`contribution_names`]).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    // Frontend contributions.
    #[serde(default)]
    pub ui: serde_json::Value,
    #[serde(default)]
    pub dashboard_tabs: serde_json::Value,
    #[serde(default)]
    pub sidebar_items: serde_json::Value,
    // Backend contributions.
    #[serde(default)]
    pub tools: serde_json::Value,
    #[serde(default)]
    pub actions: serde_json::Value,
    #[serde(default)]
    pub api_routes: serde_json::Value,
    #[serde(default)]
    pub routines: serde_json::Value,
    // Settings (D-014).
    #[serde(default)]
    pub config_schema: Option<serde_json::Value>,
    #[serde(default)]
    pub default_config: Option<serde_json::Value>,
}

impl PluginManifest {
    /// Frontend contribution count: ui[] + dashboardTabs[] + sidebarItems[].
    pub fn frontend_count(&self) -> usize {
        contribution_count(&self.ui)
            + contribution_count(&self.dashboard_tabs)
            + contribution_count(&self.sidebar_items)
    }

    /// Backend contribution count: tools + actions + apiRoutes + routines.
    pub fn backend_count(&self) -> usize {
        contribution_count(&self.tools)
            + contribution_count(&self.actions)
            + contribution_count(&self.api_routes)
            + contribution_count(&self.routines)
    }
}

/// How many contributions a loose manifest field declares — array length,
/// object key count, or 0 for anything else (absent/null/scalar).
pub fn contribution_count(v: &serde_json::Value) -> usize {
    match v {
        serde_json::Value::Array(a) => a.len(),
        serde_json::Value::Object(o) => o.len(),
        _ => 0,
    }
}

/// Human labels for a loose contribution field: array items' `name`/`label`/
/// `id`/`type` (first present), or object keys. Used by the detail pane.
pub fn contribution_names(v: &serde_json::Value) -> Vec<String> {
    match v {
        serde_json::Value::Array(a) => a
            .iter()
            .map(|item| {
                for k in ["name", "label", "id", "type"] {
                    if let Some(s) = item.get(k).and_then(|x| x.as_str()) {
                        return s.to_string();
                    }
                }
                if let Some(s) = item.as_str() {
                    return s.to_string();
                }
                "(unnamed)".to_string()
            })
            .collect(),
        serde_json::Value::Object(o) => o.keys().cloned().collect(),
        _ => Vec::new(),
    }
}

/// `GET /api/plugins/global` → `{plugins}`.
#[derive(Debug, Clone, Deserialize)]
pub struct PluginsGlobalResponse {
    #[serde(default)]
    pub plugins: Vec<PluginManifest>,
}

/// `GET /api/plugins/config?harness=&plugin=` → `{config}` (D-014).
#[derive(Debug, Clone, Deserialize)]
pub struct PluginConfigResponse {
    #[serde(default)]
    pub config: serde_json::Value,
}

/// One human-facing entry from `GET /api/coord/inbox` (P-002 / D-003b) — the
/// coord messages/escalations/handoffs addressed to the human. Field names match
/// the route's `HistoryItem` JSON (snake_case).
#[derive(Debug, Clone, Deserialize)]
pub struct CoordMsg {
    #[serde(default)]
    pub ts: String,
    #[serde(default)]
    pub msg_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub harness_slug: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CoordInboxResponse {
    #[serde(default)]
    pub items: Vec<CoordMsg>,
}

/// An in-app notification (P8), built from either a live `attention.notify` SSE
/// event or a `/api/toast-log` history row. Not deserialized directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notif {
    /// Severity/importance ("urgent"/"high"/… or a toast level like "error").
    pub level: String,
    pub message: String,
    pub harness: Option<String>,
    /// Source timestamp for history rows; `None` for a live ("now") event.
    pub ts: Option<String>,
}

// ─── Workbench persistence (P12 / D-002): tui_view_state / tui_layouts / tui_crews ───

/// The quiet UI/nav state the workbench persists + restores (one row per user,
/// `harness_shared.tui_view_state`). Every field defaults so an older/newer
/// shape never hard-fails a load. Round-trips both ways (sent on PUT, read on
/// GET); the empty `{}` the server returns when nothing's saved deserializes to
/// `ViewState::default()`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewState {
    /// Active tab by its title ("Plans", "Sessions", …) — title not index so a
    /// tab reorder doesn't move the user to the wrong place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
    /// Active harness slug.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    /// POTS scope axis (D-003): "all" | "pot". `None` (an older snapshot)
    /// keeps the app default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Which Harnesses column had focus ("features" | "issues").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_focus: Option<String>,
    #[serde(default)]
    pub plan_sel: usize,
    #[serde(default)]
    pub inbox_sel: usize,
    #[serde(default)]
    pub harness_sel: usize,
    #[serde(default)]
    pub feat_sel: usize,
    #[serde(default)]
    pub issue_sel: usize,
    #[serde(default)]
    pub doc_sel: usize,
    #[serde(default)]
    pub doc_scroll: u16,
    #[serde(default)]
    pub testing_sel: usize,
    #[serde(default)]
    pub pane_sel: usize,
    #[serde(default)]
    pub show_presence: bool,
    /// Operator dock (operator-always-visible-2026-06-05, Brief 24): whether the
    /// operator chat is docked beside the active tab. Persisted so the dock
    /// survives a restart; an older snapshot (absent) defaults closed.
    #[serde(default)]
    pub operator_dock_open: bool,
    /// Fleet tab (pui-fleet-status-view): the selected agent + the view mode
    /// ("curated" | "mirror"), so the dashboard restores where it was left.
    #[serde(default)]
    pub fleet_agent_sel: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fleet_mode: Option<String>,
    /// Plans filter (D-009): the selected plan slugs narrowing the Inbox list
    /// and the Fleet roster (empty = no filtering), plus whether the
    /// collapsible left rail is open.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plan_filter: Vec<String>,
    #[serde(default)]
    pub plan_filter_open: bool,
    /// Active theme name (workbench-theme-system P1 / D-002) — the `:theme`
    /// selection follows the user across launches/machines. Absent (older
    /// snapshot) or unknown (theme renamed/removed) keeps the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
}

/// `GET /api/tui/view-state` → `{ state: {...} }`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ViewStateResponse {
    #[serde(default)]
    pub state: ViewState,
}

/// One saved agent session inside a crew (`tui_crews.members[]`). All optional —
/// a pane may be a bare shell with no bound agent/harness/plan.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrewMember {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// A layout list row (`GET /api/tui/layouts` — summary, no kdl).
#[derive(Debug, Clone, Deserialize)]
pub struct LayoutSummary {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LayoutsResponse {
    #[serde(default)]
    pub layouts: Vec<LayoutSummary>,
}

/// A full layout (`GET /api/tui/layouts/:name`).
#[derive(Debug, Clone, Deserialize)]
pub struct LayoutRow {
    pub name: String,
    #[serde(default)]
    pub kdl: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

/// A crew list row (`GET /api/tui/crews` — summary, no members).
#[derive(Debug, Clone, Deserialize)]
pub struct CrewSummary {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub layout_name: Option<String>,
    #[serde(default)]
    pub member_count: u32,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CrewsResponse {
    #[serde(default)]
    pub crews: Vec<CrewSummary>,
}

/// A full crew (`GET /api/tui/crews/:name`).
#[derive(Debug, Clone, Deserialize)]
pub struct CrewRow {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub layout_name: Option<String>,
    #[serde(default)]
    pub members: Vec<CrewMember>,
}

/// `GET /api/flags/bootstrap` → `{ flags: {key: bool}, source, evaluatedAt }`.
/// The read-only Settings tab (P10) renders these. BTreeMap keeps the display
/// order stable (and tests deterministic).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FlagsResponse {
    #[serde(default)]
    pub flags: std::collections::BTreeMap<String, bool>,
    #[serde(default)]
    pub source: String,
}

// ─── Plan-item assignment / claim / liveness (P-005a, tui-workbench-ratatui) ───
//
// `GET /api/tui/plan-item-states?harness=&plan=` → the merged per-item disposition
// from plan-item-assignment-claim-liveness-2026-06-04 (assignment ⋈ live claim).
// Read-only surface: who a plan item is assigned to + who holds the live lease +
// whether the harness leases on availability (LOCAL) or activity (SHARED). camelCase
// wire (the operator DTO's field names).

/// One plan item's merged assignment+claim disposition.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItemState {
    pub item_id: String,
    /// The plan item's effective status (todo/wip/…); null for an orphan record.
    #[serde(default)]
    pub item_status: Option<String>,
    /// Direct plan-DAG dependencies. Roots and orphan records use an empty list.
    #[serde(default)]
    pub blocked_by: Vec<String>,
    #[serde(default)]
    pub in_plan: bool,
    /// pooled | assigned-idle | active | claimed-pooled | claimed-mismatch.
    #[serde(default)]
    pub disposition: String,
    /// Durable assignment (the stable agent-NAME the item belongs to), or null.
    #[serde(default)]
    pub assignee_name: Option<String>,
    /// Live claim holder's display label (ownerLabel ?? owner), or null.
    #[serde(default)]
    pub claim_owner: Option<String>,
    /// Stable live-claim owner id; joins the fleet assignment's context pressure.
    #[serde(default)]
    pub claim_owner_id: Option<String>,
    /// Live claim holder's agent-NAME, or null.
    #[serde(default)]
    pub claim_owner_name: Option<String>,
    /// Live claim's declared intent, or null.
    #[serde(default)]
    pub claim_intent: Option<String>,
    /// availability (LOCAL) | activity (SHARED), or null if no live claim.
    #[serde(default)]
    pub claim_liveness_mode: Option<String>,
    /// Live claim's lease expiry (ISO), or null.
    #[serde(default)]
    pub claim_expires_ts: Option<String>,
}

/// `GET /api/tui/plan-item-states` → `{ harness, plan, harnessLivenessMode, items }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItemStates {
    #[serde(default)]
    pub harness: String,
    #[serde(default)]
    pub plan: String,
    /// availability (LOCAL) | activity (SHARED) — the harness's claim-liveness split.
    #[serde(default)]
    pub harness_liveness_mode: String,
    #[serde(default)]
    pub items: Vec<PlanItemState>,
}

// ─── Operator config overview (P10b — read-only slice of the settings port) ───
//
// The Settings tab surfaces a READ-ONLY view of the operator's running config: the
// AI backend + per-role model routing (/api/agent-config) and which speech providers
// are connected (operator:credentials_status — booleans only, never secret values).
// The write-side settings (credential entry, OAuth sign-in, device pairing, wake-word)
// are interactive/desktop-native and intentionally NOT ported to the TUI.

/// The inner `config` of `/api/agent-config`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigInner {
    #[serde(default)]
    pub backend: String,
    #[serde(default)]
    pub cmd: String,
    /// Per-pipeline-role model overrides (worker → opus, merge-resolver → opus:xhigh).
    #[serde(default)]
    pub models: std::collections::BTreeMap<String, String>,
    /// Per-chat-surface model (operator → sonnet).
    #[serde(default)]
    pub surface_models: std::collections::BTreeMap<String, String>,
}

/// `GET /api/agent-config` → `{ config: {...}, effectiveTiers, effectiveBackend, … }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigResponse {
    #[serde(default)]
    pub config: AgentConfigInner,
    #[serde(default)]
    pub effective_backend: String,
    /// Server-discovered binaries; absent/null is unavailable.
    #[serde(default)]
    pub binaries: std::collections::BTreeMap<String, Option<String>>,
    /// Workspace override when present, otherwise the committed tier baseline,
    /// already classified by the server for Agent Chat execution.
    #[serde(default)]
    pub effective_tiers: Vec<crate::session_config::ModelTier>,
    /// The exact effort vocabulary the PSU launcher validates, projected by
    /// the operator from `MODEL_EFFORT_LEVELS`.
    #[serde(default)]
    pub effort_levels: Vec<String>,
    /// The exact launch-time modes from the shared mode registry.
    #[serde(default)]
    pub launchable_modes: Vec<crate::session_config::LaunchableMode>,
}

/// One provider's credential status from `operator:credentials_status` — whether a
/// key is set. `masked` is a display hint, never the secret itself.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CredStatus {
    #[serde(default)]
    pub set: bool,
    #[serde(default)]
    pub masked: Option<String>,
}

/// The assembled operator-config overview the Settings tab renders. Built in the
/// client from the agent-config GET + the credentials-status tool (NOT one wire
/// shape); `providers` is sorted (name, set) for a stable display.
#[derive(Debug, Clone, Default)]
pub struct OperatorConfig {
    pub agent: Option<AgentConfigResponse>,
    pub providers: Vec<(String, bool)>,
    /// The EFFECTIVE model-tier menu from `/api/agent-config.effectiveTiers`.
    /// Empty means the read has not landed or failed — never a hardcoded
    /// client fallback.
    pub tiers: Vec<crate::session_config::ModelTier>,
}

// ─── Fleet status view (pui-fleet-status-view-2026-06-04) ───────────────────────
//
// The Fleet tab is a unified, fleet-wide dashboard: plan/work_item progress +
// subagent status + a live activity overlay (the worker-integration bridge). The
// DTOs below back it; the view state + render live in `fleet.rs`.

/// Deserialize a possibly-`null` field as its `Default`. serde's
/// `#[serde(default)]` only fills an ABSENT key — an explicit `null` would still
/// hard-fail. Used for `itemCounts` (`object | null` on the wire).
fn null_as_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// Per-plan item counts by effectiveStatus, from `/api/admin/plans/list`'s
/// `itemCounts`. All optional — an empty plan reports `{}` → all-zero.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct ItemCounts {
    #[serde(default)]
    pub todo: u32,
    #[serde(default)]
    pub wip: u32,
    #[serde(default)]
    pub blocked: u32,
    #[serde(default, rename = "needs-human")]
    pub needs_human: u32,
    #[serde(default)]
    pub done: u32,
    #[serde(default)]
    pub dropped: u32,
    #[serde(default)]
    pub unknown: u32,
}

impl ItemCounts {
    /// All items across every status.
    pub fn total(&self) -> u32 {
        self.todo
            + self.wip
            + self.blocked
            + self.needs_human
            + self.done
            + self.dropped
            + self.unknown
    }
    /// Items still to do (everything that isn't done or dropped).
    pub fn remaining(&self) -> u32 {
        self.total().saturating_sub(self.done + self.dropped)
    }
}

/// One row of `work_items:list` (unify-work-items-2026-06-04). The tool wraps
/// `{ ok, count, items: [...] }` in an MCP envelope (`content[0].text`); the
/// client unwraps it. Only the fields the fleet view renders are kept.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub id: String,
    /// feature | research-task | chunk | bug | change.
    #[serde(default)]
    pub kind: String,
    /// feature | issue.
    #[serde(default)]
    pub family: String,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub title: String,
    /// Kind-specific lifecycle state (feature: status; issue: open|resolved|closed).
    #[serde(default)]
    pub state: String,
    /// Claimable owner (feature → taken_by; issue → assignee).
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub severity: Option<String>,
}

/// Inner JSON of the `work_items:list` envelope (`content[0].text`).
#[derive(Debug, Clone, Deserialize)]
pub struct WorkItemsPayload {
    #[serde(default)]
    pub items: Vec<WorkItem>,
}

/// One actionable row from `work_items:burn_down`. The same row shape is used
/// by READY NOW and IN FLIGHT; `blocks` is enriched client-side from one batched
/// `work_items:get { detail:true }` read for READY NOW.
#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkFrontierRow {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub last_progress_at: Option<String>,
    #[serde(skip)]
    pub blocks: usize,
    #[serde(default)]
    pub queue_control: Option<WorkQueueControl>,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkQueueControl {
    #[serde(default)]
    pub active_claim: Option<QueueControlClaim>,
    #[serde(default)]
    pub hold_open_lease: Option<QueueControlLease>,
    #[serde(default)]
    pub durable_park: Option<QueueControlPark>,
    #[serde(default)]
    pub agent_review: Option<QueueControlReview>,
    #[serde(default)]
    pub unattributed_claim_hold: bool,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueControlClaim {
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub claimed_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueControlLease {
    #[serde(default)]
    pub holder: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub held_at: Option<String>,
    #[serde(default)]
    pub age: QueueControlAge,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueControlAge {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub age_ms: Option<u64>,
    #[serde(default)]
    pub bucket: String,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueControlCondition {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueControlReleaseLiveness {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub contract_present: bool,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub trigger: Option<String>,
    #[serde(default)]
    pub reachability: Option<String>,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub findings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueControlPark {
    #[serde(default)]
    pub parker: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub parked_at: Option<String>,
    #[serde(default)]
    pub age: QueueControlAge,
    #[serde(default)]
    pub unpark_condition: QueueControlCondition,
    #[serde(default)]
    pub release_liveness: QueueControlReleaseLiveness,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueControlReview {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub submitted_by: String,
    #[serde(default)]
    pub ledger_idea_id: String,
    #[serde(default)]
    pub round: usize,
}

/// A parked frontier row. `mechanism == "needs-human"` is the NEEDS YOU
/// bucket; every other mechanism contributes to the visible blocked count.
#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkFrontierParkedRow {
    #[serde(flatten)]
    pub item: WorkFrontierRow,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub mechanism: String,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkFrontierCounts {
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub terminal: usize,
    #[serde(default)]
    pub in_flight: usize,
    #[serde(default)]
    pub parked: usize,
    #[serde(default)]
    pub unclaimed: usize,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
pub struct WorkFrontierTerminal {
    #[serde(default)]
    pub total: usize,
}

/// Canonical whole-harness frontier returned by `work_items:burn_down`.
#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkFrontier {
    #[serde(default)]
    pub harness: String,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub terminal: WorkFrontierTerminal,
    #[serde(default)]
    pub in_flight: Vec<WorkFrontierRow>,
    #[serde(default)]
    pub parked: Vec<WorkFrontierParkedRow>,
    #[serde(default)]
    pub unclaimed: Vec<WorkFrontierRow>,
    #[serde(default)]
    pub counts: WorkFrontierCounts,
}

/// One worker-activity row (papercusp-worker-integration-2026-06-04). Emitted by
/// both `activity:recent` (`{activity:[...]}`) and the `/api/activity/stream` SSE
/// (`event: activity`). The wire is snake_case; `summary` is already server-side
/// enriched (e.g. `✎ generated.ts`, `▶ npm test`).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ActivityRow {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub owner_id: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub harness_slug: Option<String>,
    /// tool | lifecycle | todos.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    /// JSONB detail — for a `kind:"todos"` row this is `{count,done,todos:[...]}`.
    #[serde(default)]
    pub detail: Option<serde_json::Value>,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActivityRecentPayload {
    #[serde(default)]
    pub activity: Vec<ActivityRow>,
}

/// One todo from a worker's TodoWrite/TaskCreate snapshot (D-004 worker-todo
/// mirroring), stored in `agent_activity.detail.todos` for a `kind:"todos"` row.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct TodoItem {
    #[serde(default)]
    pub content: String,
    /// pending | in_progress | completed | …
    #[serde(default)]
    pub status: Option<String>,
}

/// A worker's todo snapshot (the `detail` of a `kind:"todos"` activity row).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TodoSnapshot {
    #[serde(default)]
    pub count: u32,
    #[serde(default)]
    pub done: u32,
    #[serde(default)]
    pub todos: Vec<TodoItem>,
}

// ─── Memory tab (D-006 Step 2, pui-completion-and-polish-2026-06-05) ────────
//
// The PUI Memory tab reads the `memory:list` / `memory:search` agent tools
// (MCP envelope, `content[0].text` JSON = `{ok, reason?, results}`). The tab
// shows whatever the configured memory BACKEND holds (mem0 today, the
// MemoryBackend interface once D-006 Step 1 lands) — `ok:false` renders the
// backend-unavailable empty state rather than an error.

/// One memory entry (mem0 shape: `memory` is the fact text; `metadata.kind`
/// is identity|preference|project|correction; `score` only on search hits).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MemoryEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub memory: String,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub score: Option<f64>,
}

impl MemoryEntry {
    /// The entry's kind from metadata (empty when unset).
    pub fn kind(&self) -> String {
        self.metadata
            .as_ref()
            .and_then(|m| m.get("kind"))
            .and_then(|k| k.as_str())
            .unwrap_or("")
            .to_string()
    }
}

/// Inner JSON of the `memory:list` / `memory:search` envelopes.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MemoriesPayload {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub results: Vec<MemoryEntry>,
}

// ─── Command-palette tool discovery (PUI next-wave P-012) ───

/// One live catalog match returned by `tools:find`.
///
/// The palette deliberately keeps the server's compact schema text instead of
/// maintaining a second client-side catalog.  That makes each invocation use
/// the same schema generation an agent would read through the MCP surface.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct ToolPaletteHit {
    #[serde(default, rename = "tool", deserialize_with = "null_as_default")]
    pub name: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub description: String,
    #[serde(default, rename = "argSchema", deserialize_with = "null_as_default")]
    pub arg_schema: String,
    #[serde(default)]
    pub returns: Option<String>,
    #[serde(default)]
    pub via: Option<String>,
}

/// A reusable orchestration suggested beside tool matches by `recipes:search`.
/// Suggestions are informational in v1: selecting a tool still follows the
/// explicit schema prompt and audited `tools:invoke` path.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct ToolPaletteRecipe {
    #[serde(default, deserialize_with = "null_as_default")]
    pub id: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub title: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub description: String,
}

// ─── Operator chat pane (tui-operator-surface-2026-06-04) ───

/// How a tool call ENDED, as reported by the seam's `tool_result` frame.
///
/// Every call starts `Pending` — the loop has announced it but not yet reported
/// an outcome — and exactly one `tool_result` moves it to a terminal variant.
/// `Denied` is deliberately distinct from `Failed`: the tool did not run and
/// nothing went wrong, the operator said no, and a card that renders a refusal
/// as an error teaches the user to distrust their own decisions.
/// `Skipped` is the same rule for a question: the agent asked, the user chose
/// not to answer (Esc on the question card), and that is a choice, not a fault
/// (pui-chat-first-ux P-014).
#[derive(Debug, Clone, PartialEq)]
pub enum ToolOutcome {
    Pending,
    Ok,
    Failed(String),
    Denied,
    Skipped,
}

/// A tool the operator called mid-turn — rendered as a card under its message.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatToolCall {
    pub name: String,
    /// The loop's tool-call id. This is the `callId` the HITL approvals route is
    /// keyed by, so it is what an approve/deny POST must carry — losing it makes
    /// a parked call unresolvable from the pane. `None` on the legacy converse
    /// lane and on persisted history, neither of which carries a call id.
    ///
    /// It is ALSO the correlation key a `tool_result` frame arrives on, so the
    /// same id that makes a call answerable is what makes it completable.
    pub id: Option<String>,
    /// This call is parked server-side on a HITL approval decision (native seam
    /// only). While true the turn is STALLED, not failed: the loop is waiting.
    pub needs_approval: bool,
    /// The call's arguments, verbatim from the seam. Carried through the mapping
    /// per D-017 even though only the card lane reads it — re-widening a mapping
    /// every time a later slice needs a field is what cost a wake on slice 2.
    pub input: Option<serde_json::Value>,
    /// Bounded terminal result payload. Known tools use this for semantic rows;
    /// unknown tools keep the generic card and never render the raw envelope.
    pub result: Option<serde_json::Value>,
    /// Terminal outcome, or `Pending` while the loop is still working.
    pub outcome: ToolOutcome,
}

impl ChatToolCall {
    /// A chip with no call id and no approval gate — the legacy converse lane
    /// and replayed history, which carry neither. Such a lane emits no
    /// `tool_result` either, so these stay `Pending` and render without a
    /// status glyph rather than claiming an outcome nobody reported.
    pub fn plain(name: String) -> Self {
        Self {
            name,
            id: None,
            needs_approval: false,
            input: None,
            result: None,
            outcome: ToolOutcome::Pending,
        }
    }
}

/// One HITL request parked on the native agent-chat seam, awaiting the operator's
/// approve/deny. Held on `App` so the pane can render the prompt and resolve it;
/// re-hydrated from `list_agent_chat_approvals` so a reconnect does not strand a
/// parked call with no visible way to answer it.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingApproval {
    pub call_id: String,
    pub tool_name: String,
}

/// One rendered chat message in the operator pane. Built from a persisted turn
/// (history load) or live during a turn — NOT deserialized directly. While an
/// assistant message is `streaming`, `content` holds the raw accumulated delta
/// text (rendered through `chat_tags::live_preview`); once the turn finalizes it
/// holds the user-visible `<say>` body (`chat_tags::finalize`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatProvenance {
    pub engine: String,
    pub model: String,
    pub account_route: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    pub reasoning: String,
    pub provenance: Option<ChatProvenance>,
    pub tools: Vec<ChatToolCall>,
    pub streaming: bool,
}

impl ChatMessage {
    pub fn user(text: &str) -> Self {
        Self {
            role: "user".into(),
            content: text.into(),
            reasoning: String::new(),
            provenance: None,
            tools: Vec::new(),
            streaming: false,
        }
    }
    pub fn assistant(text: &str) -> Self {
        Self {
            role: "assistant".into(),
            content: text.into(),
            reasoning: String::new(),
            provenance: None,
            tools: Vec::new(),
            streaming: false,
        }
    }
    /// A line the owner composed that was NEVER delivered, preserved in the
    /// transcript instead of discarded.
    ///
    /// The plan's product-flow contract is that no state "accepts a message
    /// that will simply disappear". A queued line whose conversation turns out
    /// to refuse writes is exactly that state, and the composer holds at most
    /// ONE line — so everything past the first needs a home that stays visible
    /// and copyable rather than being dropped with a count.
    ///
    /// The role is deliberately NOT `user`: a `user` bubble asserts the message
    /// was sent, and this one asserts the opposite. It also keeps the text off
    /// the markdown path in the transcript renderer (only `assistant` prose is
    /// markdown), so the owner's literal line is shown back unrestyled.
    pub fn undelivered(text: &str) -> Self {
        Self {
            role: "undelivered".into(),
            content: text.into(),
            reasoning: String::new(),
            provenance: None,
            tools: Vec::new(),
            streaming: false,
        }
    }
    /// The in-flight assistant bubble — empty, `streaming`, accumulates deltas.
    pub fn streaming_assistant() -> Self {
        Self {
            role: "assistant".into(),
            content: String::new(),
            reasoning: String::new(),
            provenance: None,
            tools: Vec::new(),
            streaming: true,
        }
    }
}

/// `GET /api/operator/conversations?limit=N` → the workspace's active operator
/// conversation + recent turns (oldest first). Only the fields the pane needs;
/// the rest of the conversation/turn shape is ignored.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationLoad {
    pub conversation: ConversationRef,
    #[serde(default)]
    pub turns: Vec<TurnDto>,
    #[serde(default)]
    pub has_more_earlier: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConversationRef {
    pub id: String,
}

/// One persisted operator turn (`operator_turns`). seq/role/text/tools are what
/// the pane renders; el_conv_id/audio_url/created_at/source are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct TurnDto {
    #[serde(default)]
    pub seq: i64,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub tools: Option<Vec<TurnToolDto>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TurnToolDto {
    #[serde(default)]
    pub name: String,
}

/// `GET /api/operator/conversations/:id/turns?beforeSeq=N&limit=M` → an older
/// page of turns (oldest first within the page) + whether more exist before it.
/// The chat pane's load-earlier cursor reads `turns` + `has_more_earlier`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnsPage {
    #[serde(default)]
    pub turns: Vec<TurnDto>,
    #[serde(default)]
    pub has_more_earlier: bool,
}

// ── Conversations (Brief 25, conversations-tab-2026-06-05) ───────────────────
// The coord conversations browse surface. Shapes match the snake_case JSON the
// `conversations:*` tools return (NO camelCase rename, unlike the plan/issue
// DTOs above): conversations:list → ConvListResponse, conversations:get →
// ConvGetResponse (the conversation fields are nested under `conversation`,
// with topics/posts/subscriber_count as top-level siblings).

/// One row of `conversations:list` → `{ conversations: [...] }`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConvSummary {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub harness_slug: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub asker_id: String,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub promoted_issue_id: Option<String>,
    #[serde(default)]
    pub created_ts: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConvListResponse {
    #[serde(default)]
    pub conversations: Vec<ConvSummary>,
}

/// The conversation object nested under `conversation` in conversations:get.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConvCore {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub harness_slug: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub asker_id: String,
    #[serde(default)]
    pub accepted_answer: Option<String>,
    #[serde(default)]
    pub promoted_issue_id: Option<String>,
    #[serde(default)]
    pub created_ts: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConvPost {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub author_id: Option<String>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub created_ts: String,
}

/// `conversations:get` → conversation + topics + posts + subscriber_count as
/// top-level siblings. Stored whole as the selected-conversation detail.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ConvDetail {
    #[serde(default)]
    pub conversation: Option<ConvCore>,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub posts: Vec<ConvPost>,
    #[serde(default)]
    pub subscriber_count: i64,
}

/// Per-item result in the keyed-array `conversations:get` response. The
/// endpoint is bulk even for a single id, so `ok:false`/`error` must remain
/// attached to the requested id instead of being discarded while unwrapping.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConvGetResult {
    #[serde(default)]
    pub ok: bool,
    pub id: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(flatten)]
    pub detail: ConvDetail,
}

/// Counts accompanying the standardized keyed-array bulk response.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConvGetCounts {
    #[serde(default)]
    pub ok: usize,
    #[serde(default)]
    pub failed: usize,
}

/// The complete `conversations:get` tool payload. `results` is keyed by each
/// result's `id`; callers must not rely on array position.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConvGetResponse {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub results: Vec<ConvGetResult>,
    #[serde(default)]
    pub counts: ConvGetCounts,
}

/// Fleet rate/usage read-model (rate-limit-layer-v2 P-013/D-004): the `status`
/// half of GET `/api/operator/rate-limit-config` (`buildFleetRateStatus`).
/// Rendered in the Overview top-bar (overview-dashboard Brief 23 P-005);
/// `config.max_simultaneous_agents` is the user-editable hard cap (`+`/`-`
/// on the Overview tab → PUT).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FleetRateStatus {
    #[serde(default)]
    pub config: FleetRateConfig,
    #[serde(default)]
    pub fleet: FleetRateFleet,
    #[serde(default)]
    pub buckets: Vec<FleetRateBucket>,
    #[serde(default)]
    pub usage: FleetRateUsage,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FleetRateConfig {
    #[serde(default)]
    pub max_simultaneous_agents: u32,
    #[serde(default)]
    pub concurrency_floor: u32,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FleetRateFleet {
    #[serde(default)]
    pub cap: u32,
    #[serde(default)]
    pub in_flight: u32,
    /// Real non-stale fleet-wide agent count from coord_presence. This is
    /// distinct from `in_flight`, which only counts rate-governed dispatches.
    #[serde(default)]
    pub live_agents: u32,
    #[serde(default)]
    pub effective: u32,
    #[serde(default)]
    pub floor: u32,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FleetRateBucket {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub paused: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FleetRateUsage {
    #[serde(default)]
    pub spend_usd: f64,
    #[serde(default)]
    pub calls: u64,
    #[serde(default)]
    pub buckets: Vec<FleetRateUsageBucket>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FleetRateUsageBucket {
    #[serde(default)]
    pub key: String,
    /// Bucket usage 0..100; None when the provider exposes no ceiling
    /// (subscription paths) — never fabricated (rate-limit v2 D-002).
    #[serde(default)]
    pub usage_pct: Option<f64>,
}

impl FleetRateStatus {
    /// Headline usage%: the WORST known bucket. None when no bucket exposes a
    /// ceiling — render a dash, never fabricate. Mirrors the desktop's
    /// `headlineUsagePct`.
    pub fn headline_usage_pct(&self) -> Option<f64> {
        self.usage
            .buckets
            .iter()
            .filter_map(|b| b.usage_pct)
            .filter(|p| p.is_finite())
            .fold(None, |worst: Option<f64>, p| {
                Some(match worst {
                    Some(w) if w >= p => w,
                    _ => p,
                })
            })
    }
    /// Count of currently rate-limit-paused governor buckets.
    pub fn paused_count(&self) -> usize {
        self.buckets.iter().filter(|b| b.paused).count()
    }
}

/// One `state:read` result as returned by the operator's generic run-tool
/// bridge. The three-way `status` value is intentionally kept as data rather
/// than collapsed into an `Option`: `unknown` and `absent` prescribe different
/// UI copy and neither may be rendered as a healthy value.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StateCellRead {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub cell: String,
    #[serde(default)]
    pub value: serde_json::Value,
    #[serde(default)]
    pub assessment: Option<StateCellAssessment>,
    #[serde(default)]
    pub unknown: Option<StateCellUnknown>,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StateCellAssessment {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StateCellUnknown {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub detail: String,
}

/// A pipeline cell plus transport/decode state. A failed operator request is
/// represented in-band here so one broken cell cannot erase the other three.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PipelineCellRead {
    pub cell: String,
    pub read: Option<StateCellRead>,
    pub error: Option<String>,
}

/// P-008's Overview read model: four independently-readable registered cells.
/// These are populated concurrently through `state:read`, never re-derived by
/// the TUI from git, routine metadata, or a second bespoke state endpoint.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PipelineStatus {
    pub gate_verdict: PipelineCellRead,
    pub frozen_candidate: PipelineCellRead,
    pub main_behind_staging: PipelineCellRead,
    pub deployed_sha: PipelineCellRead,
}

// ─── Bee-dossier dock pane (pui-bee-dossier-pane-2026-06-06) ─────────────────

/// One item on a bee's ordered work-list — a `queued`/`doing` entry from the
/// `fleet:assignments` view (the externalized per-bee TodoWrite the Queen reads).
/// Wire is camelCase (`itemKind`, `rankWriter`).
#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BeeWorkItem {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub item_kind: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: Option<String>,
    /// Position in the holder's ordered work-list (rank ASC; NULL = unranked, last).
    #[serde(default)]
    pub rank: Option<i64>,
    /// Who placed it — "bee" (self) | "queen" (overlay) | null (unranked).
    #[serde(default)]
    pub rank_writer: Option<String>,
}

/// One agent's assignment from `fleet:assignments` (`agents[]`) — the dossier's
/// top region. Only the fields the bee pane renders are kept.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BeeAssignment {
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub alive: bool,
    /// The same shared lifecycle verdict projected by `fleet:assignments`.
    #[serde(default)]
    pub session_state: Option<String>,
    /// Coarse context-pressure bucket (`ok` | `high` | `critical`).
    #[serde(default)]
    pub context_pressure: Option<String>,
    /// Latest genuine tool invocation for this member. This is the sole source
    /// for the Fleet roster's "spoke" column; heartbeat timestamps never proxy.
    #[serde(default)]
    pub last_tool_call_at: Option<String>,
    /// Shared lifecycle/activity verdict (speaking, waiting, monitoring, dead…).
    #[serde(default)]
    pub verdict: Option<String>,
    /// True when at least one held work-item has stopped making item-scoped progress.
    #[serde(default)]
    pub stalled: bool,
    /// True when at least one active claim's holder is gone.
    #[serde(default)]
    pub orphaned: bool,
    #[serde(default)]
    pub intent: String,
    /// The bee's work-items in rank order (head-of-line first; unranked last).
    #[serde(default)]
    pub queued: Vec<BeeWorkItem>,
    /// Work-item count — the load signal.
    #[serde(default)]
    pub load: i64,
    /// Self-declared current plan (presence) — feeds the per-agent plan filter
    /// (pui-dock-consolidation-2026-06-07 #2).
    #[serde(default)]
    pub declared_plan_slug: Option<String>,
    /// The agent's claims (plan-item + work-item) — only the plan linkage is
    /// kept; the rest of the wire claim is ignored.
    #[serde(default)]
    pub claims: Vec<BeeClaim>,
}

/// One claim row on a `fleet:assignments` agent — trimmed to the plan linkage
/// the Fleet plan-progress filter needs (#2).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BeeClaim {
    #[serde(default)]
    pub plan_slug: Option<String>,
}

impl BeeAssignment {
    /// Every plan slug this agent is linked to — its declared plan + any plan
    /// its claims touch. Backs the agent-filtered plan-progress view (#2).
    pub fn plan_slugs(&self) -> std::collections::HashSet<&str> {
        let mut set: std::collections::HashSet<&str> = self
            .claims
            .iter()
            .filter_map(|c| c.plan_slug.as_deref())
            .collect();
        if let Some(p) = self.declared_plan_slug.as_deref() {
            set.insert(p);
        }
        set
    }
}

/// Inner JSON of the `fleet:assignments` envelope (`content[0].text`).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct FleetAssignmentsPayload {
    #[serde(default)]
    pub agents: Vec<BeeAssignment>,
}

/// One coord-mail entry on the bee-dossier pane (a `fleet:bee_mail` envelope
/// inbox/outbox line). The wire is the raw coord envelope (snake_case).
#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
pub struct BeeMailEntry {
    #[serde(default)]
    pub ts: String,
    #[serde(default)]
    pub msg_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub from: Option<String>,
    /// Recipients (["*"] = broadcast, ["human"] = surfaced to the user).
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
}

/// One side (inbox/outbox) of `fleet:bee_mail`.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct BeeMailSide {
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub entries: Vec<BeeMailEntry>,
}

/// Inner JSON of the `fleet:bee_mail` envelope (`content[0].text`).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct BeeMailPayload {
    #[serde(default)]
    pub owner_id: String,
    #[serde(default)]
    pub inbox: BeeMailSide,
    #[serde(default)]
    pub outbox: BeeMailSide,
}

/// Inner JSON of the `coord:feed` envelope (`content[0].text`) — only the rows
/// leg (each row is the raw coord envelope, the same wire shape as a mail
/// entry). Backs the bee-dossier mail split since the `fleet:bee_mail`
/// transport was retired (P-003 own-tui-full-divorce-2026-08-24).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct CoordFeedPayload {
    #[serde(default)]
    pub rows: Vec<BeeMailEntry>,
}

/// The agent-context pane's fetched snapshot (dock 4-pane split, owner ask
/// 2026-06-11) — assembled per [`crate::app::AgentCtxMode`]: only the mode's
/// own field is fetched/populated; the header fields ride every mode.
#[derive(Debug, Clone, Default)]
pub struct AgentCtxData {
    /// Resolved agent owner id (`None` = the scope found no live agent, e.g.
    /// no queen on the roster yet).
    pub owner: Option<String>,
    /// Display label from the roster, when resolved.
    pub label: Option<String>,
    /// Prompt mode: the prompt the agent runs on. `prompt` is the full text —
    /// a spawn's RECORDED prompt_body or a live role-persona render
    /// (`source`: "recorded" | "rendered" | "none"); `brief` is the
    /// parent-authored brief led separately (the per-agent signal), with the
    /// model/tier the spawn launched at.
    pub prompt: Option<String>,
    pub source: Option<String>,
    pub brief: Option<String>,
    pub model: Option<String>,
    pub tier: Option<String>,
    /// Mail mode: the agent's coord inbox/outbox.
    pub mail: Option<BeeMailPayload>,
    /// Work mode: the agent's ranked work-list + plan linkage.
    pub assignment: Option<BeeAssignment>,
}

// ─── Hives tab (p2p swarm roster — pui-hives-tab-2026-06-07) ─────────────────

/// One unified `coord:roster` row — only the fields the Hives tab reads.
/// Federated rows (remote peers projected from `shared_presence` announces)
/// carry `federated: true` plus the machine/device identity; local session
/// rows are filtered out client-side. Wire is camelCase.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PresenceRow {
    #[serde(default)]
    pub owner_id: String,
    #[serde(default)]
    pub owner_label: String,
    #[serde(default)]
    pub intent: String,
    /// The peer's machine label (federation identity half; `host` on the wire).
    #[serde(default)]
    pub host: String,
    /// The gh user id (stringified) for federated rows.
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub stale: bool,
    /// True for a row sourced from the p2p swarm (`shared_presence`).
    #[serde(default)]
    pub federated: bool,
    /// The peer's device pubkey (raw-32-byte-base64 Ed25519 — the hive identity).
    #[serde(default)]
    pub device_pubkey: Option<String>,
    /// The harness the peer announced presence in (shared_presence is per-harness).
    #[serde(default)]
    pub harness_slug: Option<String>,
    /// The peer's current view (the federated analogue of currentPlanSlug).
    #[serde(default)]
    pub current_view: Option<String>,
    /// ISO timestamp of the peer's last announce (freshness; ISO sorts lexically).
    #[serde(default)]
    pub heartbeat_at: Option<String>,
}

/// Inner JSON of the unified roster envelope (`content[0].text`). The active
/// projection is the only collection needed here; federated rows retain their
/// per-row `stale` marker because the retired presence endpoint no longer
/// provides a separate stale collection.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct PresencePayload {
    #[serde(default)]
    pub active: Vec<PresenceRow>,
}

// ─── Hive lexicon (pui-hive-lexicon-2026-06-06) ──────────────────────────────

/// Singular/plural display forms for one lexicon term.
#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
pub struct TermForms {
    #[serde(default)]
    pub one: String,
    #[serde(default)]
    pub other: String,
}

/// Inner JSON of the `lexicon:active_pack` envelope (`content[0].text`): the
/// active brand pack id + the full term → forms map (presentation only).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct LexiconPackPayload {
    #[serde(default, rename = "packId")]
    pub pack_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub terms: std::collections::HashMap<String, TermForms>,
}

#[cfg(test)]
mod fleet_rate_tests {
    use super::*;

    #[test]
    fn fleet_rate_status_decodes_wire_and_derives() {
        let json = r#"{
          "config": {"maxSimultaneousAgents": 6, "concurrencyFloor": 1},
          "fleet": {"cap": 6, "inFlight": 3, "liveAgents": 165, "effective": 4, "floor": 1},
          "buckets": [
            {"key":"anthropic:big","paused":true,"pausedUntil":null},
            {"key":"openai:big","paused":false}
          ],
          "usage": {"spendUsd": 1.234, "calls": 42, "buckets":[
            {"key":"a","usagePct":37.5},
            {"key":"b","usagePct":null},
            {"key":"c","usagePct":80.0}
          ]}
        }"#;
        let s: FleetRateStatus = serde_json::from_str(json).unwrap();
        assert_eq!(s.config.max_simultaneous_agents, 6);
        assert_eq!(s.fleet.in_flight, 3);
        assert_eq!(s.fleet.live_agents, 165);
        assert_eq!(s.fleet.effective, 4);
        assert_eq!(s.paused_count(), 1);
        // Headline = the WORST known bucket; null-ceiling buckets ignored.
        assert_eq!(s.headline_usage_pct(), Some(80.0));
    }

    #[test]
    fn fleet_rate_headline_is_none_when_no_ceiling_known() {
        // Subscription paths expose no ceiling → None, never fabricated.
        let s: FleetRateStatus =
            serde_json::from_str(r#"{"usage":{"buckets":[{"key":"x","usagePct":null}]}}"#).unwrap();
        assert_eq!(s.headline_usage_pct(), None);
        // And a fully-empty payload decodes via defaults.
        let empty: FleetRateStatus = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.paused_count(), 0);
        assert_eq!(empty.headline_usage_pct(), None);
    }

    #[test]
    fn state_cell_read_preserves_value_unknown_and_absent() {
        let value: StateCellRead = serde_json::from_str(
            r#"{"status":"value","cell":"gate.greenCheckpoint.verdict","value":0,"assessment":{"status":"resolved","code":"passing-current"}}"#,
        )
        .unwrap();
        assert_eq!(value.status, "value");
        assert_eq!(value.value, serde_json::json!(0));
        assert_eq!(
            value.assessment.as_ref().and_then(|a| a.code.as_deref()),
            Some("passing-current")
        );

        let unknown: StateCellRead = serde_json::from_str(
            r#"{"status":"unknown","cell":"deploy.3070.sha","unknown":{"code":"resolver-failed","detail":"probe timed out"}}"#,
        )
        .unwrap();
        assert_eq!(unknown.status, "unknown");
        assert_eq!(unknown.unknown.unwrap().code, "resolver-failed");

        let absent: StateCellRead =
            serde_json::from_str(r#"{"status":"absent","cell":"git.mainBehindStaging"}"#).unwrap();
        assert_eq!(absent.status, "absent");
        assert!(absent.assessment.is_none());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_coord_inbox_shape() {
        // Trimmed from the /api/coord/inbox HistoryItem shape (snake_case).
        let j = r#"{"items":[
            {"ts":"2026-06-04T16:00:00Z","msg_id":"m-1","source":"message","kind":"message",
             "from":"su-30a41","to":["human"],"plan_slug":null,"harness_slug":"papercup",
             "summary":"please review the carve","payload":{}},
            {"ts":"2026-06-04T15:00:00Z","msg_id":"m-2","source":"escalation","kind":"coord-escalation",
             "from":"su-9e6b8","to":["human"],"summary":"needs a decision","payload":{}}
        ]}"#;
        let r: CoordInboxResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.items.len(), 2);
        assert_eq!(r.items[0].msg_id, "m-1");
        assert_eq!(r.items[0].from.as_deref(), Some("su-30a41"));
        assert_eq!(r.items[0].harness_slug.as_deref(), Some("papercup"));
        assert_eq!(r.items[1].kind, "coord-escalation");
    }

    #[test]
    fn parses_toast_log_shape() {
        let j = r#"{"toasts":[
            {"id":7,"level":"error","message":"build failed","description":null,
             "harnessSlug":"papercup","createdAt":1780560000000},
            {"id":6,"level":"default","message":"ok","harnessSlug":null,"createdAt":1780559000000}
        ]}"#;
        let r: ToastsResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.toasts.len(), 2);
        assert_eq!(r.toasts[0].level, "error");
        assert_eq!(r.toasts[0].message, "build failed");
        assert_eq!(r.toasts[0].harness_slug.as_deref(), Some("papercup"));
        assert_eq!(r.toasts[1].harness_slug, None);
    }

    #[test]
    fn parses_plans_list_shape() {
        // Trimmed from the live /api/admin/plans/list probe.
        let j = r#"{"plans":[
            {"slug":"a-2026-05-14","title":"Plan A","status":"shipped","updated":"2026-05-30",
             "owner":"x@y.z","archived":false,"isLegacy":false,"itemCounts":{},
             "nextAction":"review state","harness":"papercup","startStatus":null}
        ]}"#;
        let r: PlansResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.plans.len(), 1);
        let p = &r.plans[0];
        assert_eq!(p.slug, "a-2026-05-14");
        assert_eq!(p.status, "shipped");
        assert_eq!(p.harness.as_deref(), Some("papercup"));
        assert_eq!(p.next_action.as_deref(), Some("review state"));
        assert!(!p.archived);
    }

    #[test]
    fn parses_plans_list_standard_tier_shape() {
        // EI-7430: the `standard` payloadTier (list-shape.ts) flattens itemCounts
        // into scalar open/done and renames nextAction -> next — the TUI struct
        // must decode this shape too, plus tolerate the synthetic truncation row.
        let j = r#"{"plans":[
            {"slug":"a-2026-05-14","title":"Plan A","status":"shipped","updated":"2026-05-30",
             "harness":"papercup","next":"review state","open":3,"done":5,
             "owner":"x@y.z","initiative":null,"template":null,"startStatus":null,
             "priority":null,"scheduled":null},
            {"slug":"(truncated)","title":"showing 150 of 400 — narrow with status/updatedSince/limit/order, plans:get {slug} for detail, or payloadTier:\"full\"",
             "status":null,"harness":null,"updated":null,"next":null,"open":0}
        ]}"#;
        let r: PlansResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.plans.len(), 2);
        let p = &r.plans[0];
        assert_eq!(p.slug, "a-2026-05-14");
        assert_eq!(p.next_action.as_deref(), Some("review state"));
        assert_eq!(p.open, Some(3));
        assert_eq!(p.done, Some(5));
        // The second row is the synthetic notice — decodes fine (uniform shape),
        // filtering it out is client.rs's plans_typed() responsibility, tested
        // where that helper lives.
        assert_eq!(r.plans[1].slug, "(truncated)");
    }

    #[test]
    fn parses_roster_shape_with_nulls() {
        // Trimmed from the live /api/adv/roster probe (nulls + extra fields).
        let j = r#"{"active":[
            {"ownerId":"su-c8859","label":"su · su-c8859","source":"omp-hook-session",
             "intent":"work","currentFiles":[],"host":"","pid":null,
             "startedAt":"2026-06-03 21:06:01-04","heartbeatAt":"2026-06-04 02:01:56-04",
             "liveness":"live","sessionState":"parked","liveTurn":false,
             "heartbeatFresh":true,"stale":false,"workspaceId":"*","userId":null,"revoked":false,
             "pidAlive":null,"hasLaunchRecord":true,"advSessionId":341,"currentPlanSlug":null,
             "role":null,"feature":null,"agent":"claude","mode":"console"}
        ]}"#;
        let r: RosterResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.active.len(), 1);
        let e = &r.active[0];
        assert_eq!(e.owner_id, "su-c8859");
        assert_eq!(e.liveness, "live");
        assert_eq!(e.session_state.as_deref(), Some("parked"));
        assert_eq!(e.live_turn, Some(false));
        assert_eq!(e.heartbeat_fresh, Some(true));
        assert!(!e.is_online());
        assert_eq!(e.agent.as_deref(), Some("claude"));
        assert_eq!(e.role, None);
        assert!(e.current_files.is_empty());
        assert!(!e.stale);
    }

    #[test]
    fn parses_assignment_liveness_context_and_spoke_fields() {
        let j = r#"{
            "agentId":"su-a",
            "alive":false,
            "sessionState":"ended",
            "contextPressure":"critical",
            "lastToolCallAt":"2026-08-26T20:21:22.456Z"
        }"#;
        let a: BeeAssignment = serde_json::from_str(j).unwrap();
        assert_eq!(a.session_state.as_deref(), Some("ended"));
        assert_eq!(a.context_pressure.as_deref(), Some("critical"));
        assert_eq!(
            a.last_tool_call_at.as_deref(),
            Some("2026-08-26T20:21:22.456Z")
        );
    }

    #[test]
    fn parses_work_frontier_buckets_and_assignment_activity() {
        let frontier: WorkFrontier = serde_json::from_str(
            r#"{
                "harness":"papercusp",
                "terminal":{"total":41},
                "counts":{"total":50,"terminal":41,"inFlight":2,"parked":3,"unclaimed":4},
                "unclaimed":[{"id":"WI-ready","kind":"feature","title":"Ready","state":"open"}],
                "inFlight":[{"id":"WI-live","kind":"feature","title":"Live","state":"open","assignee":"su-a"}],
                "parked":[
                    {"id":"WI-human","kind":"bug","title":"Human","state":"needs-human","reason":"credential","mechanism":"needs-human"},
                    {"id":"WI-park","kind":"feature","title":"Parked","state":"open","reason":"release once P-003 lands","mechanism":"claimHold","queueControl":{"durablePark":{"parker":"su-park","reason":"release once P-003 lands","parkedAt":null,"age":{"status":"missing","ageMs":null,"bucket":"unknown"},"unparkCondition":{"status":"stated","text":"release once P-003 lands"},"releaseLiveness":{"status":"unverified","contractPresent":false,"condition":null,"owner":null,"trigger":null,"reachability":null,"evidence":null,"findings":["owner-missing"]}}}}
                ]
            }"#,
        )
        .unwrap();
        assert_eq!(frontier.counts.in_flight, 2);
        assert_eq!(frontier.terminal.total, 41);
        assert_eq!(frontier.unclaimed[0].id, "WI-ready");
        assert_eq!(frontier.parked[0].mechanism, "needs-human");
        let park = frontier.parked[1]
            .item
            .queue_control
            .as_ref()
            .and_then(|control| control.durable_park.as_ref())
            .unwrap();
        assert_eq!(park.parker.as_deref(), Some("su-park"));
        assert_eq!(park.age.status, "missing");
        assert_eq!(park.age.bucket, "unknown");
        assert_eq!(park.unpark_condition.status, "stated");
        assert!(!park.release_liveness.contract_present);
        assert_eq!(park.release_liveness.condition, None);
        assert_eq!(park.release_liveness.evidence, None);
        assert_eq!(park.release_liveness.findings, vec!["owner-missing"]);

        let assignment: BeeAssignment = serde_json::from_str(
            r#"{"agentId":"su-a","verdict":"suspect","stalled":true,"orphaned":false}"#,
        )
        .unwrap();
        assert_eq!(assignment.verdict.as_deref(), Some("suspect"));
        assert!(assignment.stalled);
    }

    #[test]
    fn roster_decodes_fleet_fields() {
        // #3: the adv-roster DTO now carries fleetSlug + fleetColor; both are
        // optional, so an entry without them decodes to None (no fleet), and the
        // whole roster decode never fails on their absence.
        let j = r##"{"active":[
            {"ownerId":"su-1","fleetSlug":"atlas-fleet","fleetColor":"#d8b4fe"},
            {"ownerId":"su-2"}
        ]}"##;
        let r: RosterResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.active[0].fleet_slug.as_deref(), Some("atlas-fleet"));
        assert_eq!(r.active[0].fleet_color.as_deref(), Some("#d8b4fe"));
        assert_eq!(r.active[1].fleet_slug, None);
        assert_eq!(r.active[1].fleet_color, None);
    }

    #[test]
    fn fleet_group_sort_key_groups_fleets_alphabetically_then_no_fleet_last() {
        let mk = |slug: Option<&str>| RosterEntry {
            fleet_slug: slug.map(|s| s.to_string()),
            ..Default::default()
        };
        // fleets sort alphabetically; "no fleet" (None or empty slug) sorts LAST.
        assert!(
            mk(Some("atlas")).fleet_group_sort_key() < mk(Some("nimbus")).fleet_group_sort_key()
        );
        assert!(mk(Some("zzz")).fleet_group_sort_key() < mk(None).fleet_group_sort_key());
        assert_eq!(
            mk(Some("")).fleet_group_sort_key(),
            mk(None).fleet_group_sort_key()
        );

        // A STABLE sort by this key makes same-fleet rows contiguous (so the
        // draw_agents header interleave emits one header per fleet), no-fleet last.
        let mut v = [
            mk(None),
            mk(Some("nimbus")),
            mk(Some("atlas")),
            mk(None),
            mk(Some("atlas")),
        ];
        v.sort_by_key(|r| r.fleet_group_sort_key());
        let order: Vec<Option<&str>> = v.iter().map(|r| r.fleet_slug.as_deref()).collect();
        assert_eq!(
            order,
            vec![Some("atlas"), Some("atlas"), Some("nimbus"), None, None]
        );
    }

    #[test]
    fn parses_ended_tier_overwatch_with_null_fields_and_id_alias() {
        // Regression (overwatch "not running — waiting…"): the brain-view panes
        // resolve the autonomous session from the `ended` tier too — a short-lived
        // overwatch/queen wake is markAdvSessionEnded the instant its invoke
        // returns, so by the time a pane polls it's in `ended`, NOT `active`.
        //
        // The `ended` tier is RAW AdvSessionRow JSON (NOT a presence RosterEntry),
        // so it (a) names the PK `id`, never `advSessionId`, and (b) nulls list +
        // scalar fields the active tier always populates (`launchArgv`, `ownerId`,
        // `label`). Both shapes must decode or the WHOLE roster fails and the pane
        // shows "waiting…". Trimmed verbatim from the live /api/adv/roster probe.
        let j = r#"{"active":null,"ended":[
            {"id":6946,"ownerId":null,"label":null,"role":"overwatch","agent":"claude",
             "mode":"console","planSlug":null,"feature":null,"terminalBin":null,
             "pid":null,"windowId":null,"ompThreadId":null,"display":null,
             "launchArgv":null,"launchedAt":null,
             "sessionId":"5fb7d772-655e-4a64-bba3-2bf522c1d1d9","exitCode":0,
             "workspaceId":"papercusp-workspace","endedAt":"2026-06-23T01:45:07.987Z"}
        ],"pending":null}"#;
        let r: RosterResponse = serde_json::from_str(j).expect("ended tier must decode");
        assert!(r.active.is_empty()); // `null` tier → [], not a decode failure
        assert_eq!(r.ended.len(), 1, "ended tier must deserialize");
        let e = &r.ended[0];
        assert_eq!(e.role.as_deref(), Some("overwatch"));
        assert_eq!(e.owner_id, ""); // null ownerId → default, not an error
        assert!(e.launch_argv.is_empty()); // null launchArgv → [], not an error
                                           // The native uuid the brain-view pane locates + tails MUST survive the
                                           // round-trip — empty here = the pane filters the entry out (= "waiting…").
        let want_sid = "5fb7d772-655e-4a64-bba3-2bf522c1d1d9";
        assert_eq!(e.session_id.as_deref(), Some(want_sid));
        // `id` (the AdvSessionRow PK) backfills adv_session_id via the alias, so the
        // pane's newest-wake sort has a real monotonic key for ended entries.
        assert_eq!(e.adv_session_id, Some(6946));
    }

    #[test]
    fn parses_live_mixed_source_attention_shape() {
        // Trimmed from the live /api/admin/plans/attention response. The feed
        // combines plan, coordination, harness, and operator sources; all
        // sources use the canonical string importance vocabulary.
        let j = r#"{"groups":[
            {"key":"p-1","kind":"plan","planSlug":"p-1","harnessSlug":"papercusp","title":"P 1","maxImportance":"urgent",
             "items":[
               {"id":"plan-item:p-1:P-001","kind":"plan-item","source":"plan","harnessSlug":null,
                "planSlug":"p-1","itemRef":"P-001","title":"Do X","body":"Body of X","status":"todo",
                "importance":"normal","needsHuman":false,"actions":[{"id":"answer","label":"Answer"}],
                "ref":{"kind":"plan-item","slug":"p-1","itemId":"P-001"}},
               {"id":"coord:esc:9","kind":"coord-escalation","source":"coord","harnessSlug":null,
                "planSlug":null,"itemRef":null,"title":"Escalation!","body":null,"status":"needs-human",
                "importance":"urgent","needsHuman":true},
               {"id":"coord:msg:4","kind":"coord-message","source":"coord","harnessSlug":null,
                "planSlug":null,"itemRef":null,"title":"FYI","body":"A message","status":"message",
                "importance":"high","needsHuman":false}
             ]},
            {"key":"alerts:papercusp","kind":"alerts","planSlug":null,"harnessSlug":"papercusp",
             "title":"Alerts — papercusp","maxImportance":"low",
             "items":[
               {"id":"smoke-fail:papercusp","kind":"smoke-fail","source":"harness","harnessSlug":"papercusp",
                "planSlug":null,"itemRef":null,"title":"Smoke test failing","body":"failure","status":"fail",
                "importance":"low","needsHuman":false}
             ]}
        ]}"#;
        let r: AttentionResponse =
            serde_json::from_str(j).expect("live attention response must decode");
        assert_eq!(r.groups.len(), 2);
        assert_eq!(r.groups[0].items.len(), 3);
        let first = &r.groups[0].items[0];
        assert_eq!(first.item_ref.as_deref(), Some("P-001"));
        assert_eq!(first.status, "todo");
        assert_eq!(first.importance.as_deref(), Some("normal"));
        assert_eq!(first.actions[0].id, "answer");
        assert_eq!(first.reference["kind"], "plan-item");
        assert_eq!(first.reference["itemId"], "P-001");
        assert!(!first.needs_human);
        let esc = &r.groups[0].items[1];
        assert_eq!(esc.kind, "coord-escalation");
        assert_eq!(esc.importance.as_deref(), Some("urgent"));
        assert!(esc.needs_human);
        let msg = &r.groups[0].items[2];
        assert_eq!(msg.source, "coord");
        assert_eq!(msg.importance.as_deref(), Some("high"));
        let smoke = &r.groups[1].items[0];
        assert_eq!(smoke.source, "harness");
        assert_eq!(smoke.importance.as_deref(), Some("low"));
    }

    #[test]
    fn parses_features_payload() {
        let j = r#"{"slug":"papercup","count":2,"features":[
            {"id":"F-001","title":"A","status":"todo","attempts":0},
            {"id":"F-002","title":"B","status":"passed","attempts":3}]}"#;
        let r: FeaturesPayload = serde_json::from_str(j).unwrap();
        assert_eq!(r.features.len(), 2);
        assert_eq!(r.features[1].status, "passed");
        assert_eq!(r.features[1].attempts, 3);
    }

    #[test]
    fn parses_tui_panes_payload() {
        // Mirrors the documented `plugins:tui_panes` inner JSON (camelCase wire).
        let j = r#"{"panes":[
            {"pluginName":"my-plugin","slug":"papercup","label":"Logs","icon":"📜",
             "command":["sh","render.sh"],"cwd":"/repo/papercup"},
            {"pluginName":"other","slug":"papercup","label":"Watch",
             "command":["watch","-n1","ls"],"cwd":"/tmp"}
        ]}"#;
        let r: TuiPanesPayload = serde_json::from_str(j).unwrap();
        assert_eq!(r.panes.len(), 2);
        let p = &r.panes[0];
        assert_eq!(p.plugin_name, "my-plugin");
        assert_eq!(p.slug, "papercup");
        assert_eq!(p.label, "Logs");
        assert_eq!(p.icon.as_deref(), Some("📜"));
        assert_eq!(p.command, vec!["sh", "render.sh"]);
        assert_eq!(p.cwd, "/repo/papercup");
        // icon is optional; absent → None.
        assert_eq!(r.panes[1].icon, None);
        assert_eq!(r.panes[1].command, vec!["watch", "-n1", "ls"]);
    }

    #[test]
    fn parses_plugin_manifest_loosely() {
        // Backend-only manifest (github-repo shape): no ui/tools, actions list,
        // configSchema object — and unknown extra keys are ignored.
        let j = r#"{"plugins":[{
            "name":"@papercupai/github-repo","version":"0.1.0",
            "description":"Create a GitHub repo","icon":"GitBranch",
            "actions":[{"name":"create-repo"}],
            "configSchema":{"type":"object","required":["github_token"],
                "properties":{"github_token":{"type":"string","secret":true},"owner":{"type":"string"}}},
            "capabilities":["net"],"provision":{},"oauth":[{"provider":"github"}]
        },{
            "name":"ui-plugin","version":"1.0.0",
            "ui":[{"type":"tui-pane","label":"Logs"}],
            "dashboardTabs":[{"id":"x","label":"X"}],
            "tools":{"my_tool":{}}
        }]}"#;
        let r: PluginsGlobalResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.plugins.len(), 2);
        let gh = &r.plugins[0];
        assert_eq!(gh.frontend_count(), 0);
        assert_eq!(gh.backend_count(), 1); // 1 action
        assert!(gh.config_schema.is_some());
        assert_eq!(contribution_names(&gh.actions), vec!["create-repo"]);
        let uip = &r.plugins[1];
        assert_eq!(uip.frontend_count(), 2); // 1 ui + 1 dashboardTab
        assert_eq!(uip.backend_count(), 1); // tools as an OBJECT counts keys
        assert_eq!(contribution_names(&uip.tools), vec!["my_tool"]);
        assert!(uip.config_schema.is_none());
        // PluginConfigResponse default-tolerates an empty body.
        let c: PluginConfigResponse = serde_json::from_str(r#"{"config":{"owner":"me"}}"#).unwrap();
        assert_eq!(c.config["owner"], "me");
    }

    #[test]
    fn parses_issues_shape() {
        let j = r#"{"issues":[{"id":"I-1","title":"Bug","severity":"major","source":"validator",
            "foundAt":"t","foundDuring":"F-3","status":"open","linkedFeatureId":"F-FIX-1",
            "attempts":1,"notes":[]}],"nextId":2}"#;
        let r: IssuesResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.issues.len(), 1);
        let i = &r.issues[0];
        assert_eq!(i.severity, "major");
        assert_eq!(i.found_during.as_deref(), Some("F-3"));
        assert_eq!(i.linked_feature_id.as_deref(), Some("F-FIX-1"));
    }

    #[test]
    fn parses_projects_shape() {
        let j = r#"{"projects":[
            {"slug":"papercup","path":"/repo/papercup","harness_kind":null,"is_shared":true},
            {"slug":"restart","path":"/repo/restart"}]}"#;
        let r: ProjectsResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.projects.len(), 2);
        assert_eq!(r.projects[0].slug, "papercup");
        assert_eq!(r.projects[0].path.as_deref(), Some("/repo/papercup"));
    }

    #[test]
    fn parses_testing_domains_shape() {
        let j = r#"{"domains":[{"id":"unit","label":"Unit","description":"fast","tier":"universal","sections":[]},
            {"id":"e2e","label":"E2E","description":"browser","tier":"project"}],
            "tierLabels":{"universal":"Universal"}}"#;
        let r: TestingResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.domains.len(), 2);
        assert_eq!(r.domains[0].id, "unit");
        assert_eq!(r.domains[1].tier, "project");
    }

    #[test]
    fn parses_testing_domain_detail_and_run_result() {
        // domain-detail (D-004a): only the per-section file paths are kept.
        let j = r#"{"id":"unit","label":"Unit","tier":"universal","totalFiles":2,"sections":[
            {"id":"s1","label":"S1","files":[{"path":"a.test.ts","sizeBytes":10,"mtimeMs":1}],"runners":[]},
            {"id":"s2","label":"S2","files":[{"path":"b.test.ts"}],"runners":[]}
        ]}"#;
        let d: TestingDomainDetail = serde_json::from_str(j).unwrap();
        let files: Vec<String> = d
            .sections
            .into_iter()
            .flat_map(|s| s.files)
            .map(|f| f.path)
            .collect();
        assert_eq!(files, vec!["a.test.ts", "b.test.ts"]);

        // run result (camelCase wire).
        let r: TestRunResult = serde_json::from_str(
            r#"{"runId":"h-1","status":"fail","exitCode":1,"output":"1 failed","finishedAt":2}"#,
        )
        .unwrap();
        assert_eq!(r.run_id, "h-1");
        assert_eq!(r.status, "fail");
        assert_eq!(r.exit_code, 1);
        assert_eq!(r.output, "1 failed");
        // Empty body decodes to defaults (defensive).
        let e: TestRunResult = serde_json::from_str("{}").unwrap();
        assert!(e.status.is_empty());
    }

    #[test]
    fn parses_effective_claude_settings_shape() {
        let r: EffectiveClaudeSettings = serde_json::from_str(
            r#"{"ok":true,"content":"{\"model\":\"opus\"}","effective":{"model":"opus","env":{}},"fileKeys":["model"]}"#,
        )
        .unwrap();
        assert_eq!(r.content, "{\"model\":\"opus\"}");
        assert_eq!(r.file_keys, vec!["model"]);
        assert_eq!(r.effective["model"], "opus");
        assert!(r.parse_error.is_none());
        // Empty body decodes to defaults (defensive) — effective is Null until fetched.
        let empty: EffectiveClaudeSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.content, "");
        assert!(empty.effective.is_null());
        // A broken file surfaces parseError.
        let bad: EffectiveClaudeSettings =
            serde_json::from_str(r#"{"parseError":"invalid JSON: x","effective":{}}"#).unwrap();
        assert_eq!(bad.parse_error.as_deref(), Some("invalid JSON: x"));
    }

    #[test]
    fn parses_docs_shape() {
        let j = r##"{"ok":true,"projectPath":"/r","files":["a.md","sub/b.md"],
            "activePath":"a.md","content":"# A\nbody"}"##;
        let r: DocsResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.files.len(), 2);
        assert_eq!(r.active_path.as_deref(), Some("a.md"));
        assert!(r.content.unwrap().contains("# A"));
        // no_docs case (nulls)
        let e: DocsResponse =
            serde_json::from_str(r#"{"ok":true,"files":[],"activePath":null,"content":null}"#)
                .unwrap();
        assert!(e.files.is_empty());
        assert!(e.content.is_none());
    }

    #[test]
    fn empty_and_missing_arrays_default() {
        assert_eq!(
            serde_json::from_str::<PlansResponse>("{}")
                .unwrap()
                .plans
                .len(),
            0
        );
        assert_eq!(
            serde_json::from_str::<RosterResponse>("{}")
                .unwrap()
                .active
                .len(),
            0
        );
    }

    #[test]
    fn view_state_empty_object_is_default() {
        // The server returns { state: {} } when nothing's saved.
        let r: ViewStateResponse = serde_json::from_str(r#"{"state":{}}"#).unwrap();
        assert_eq!(r.state, ViewState::default());
        // A missing `state` key also defaults.
        let r2: ViewStateResponse = serde_json::from_str("{}").unwrap();
        assert_eq!(r2.state, ViewState::default());
    }

    #[test]
    fn view_state_round_trips_and_skips_none() {
        let vs = ViewState {
            tab: Some("Sessions".into()),
            harness: Some("papercup".into()),
            harness_focus: Some("issues".into()),
            plan_sel: 2,
            doc_scroll: 7,
            show_presence: true,
            theme: Some("honeycomb".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&vs).unwrap();
        // None fields are omitted; defaulted scalars round-trip.
        assert!(!json.contains("\"harness_focus\":null") || json.contains("issues"));
        let back: ViewState = serde_json::from_str(&json).unwrap();
        assert_eq!(back, vs);
    }

    #[test]
    fn parses_layouts_crews_shapes() {
        let l: LayoutsResponse = serde_json::from_str(
            r#"{"layouts":[{"name":"main","description":"my main","updated_at":"2026-06-04T16:00:00Z"}]}"#,
        )
        .unwrap();
        assert_eq!(l.layouts.len(), 1);
        assert_eq!(l.layouts[0].name, "main");

        let lr: LayoutRow = serde_json::from_str(
            r#"{"name":"main","kdl":"layout {}","description":null,"updated_at":"t"}"#,
        )
        .unwrap();
        assert_eq!(lr.kdl, "layout {}");

        let c: CrewsResponse = serde_json::from_str(
            r#"{"crews":[{"name":"morning","description":null,"layout_name":"main","member_count":2,"updated_at":"t"}]}"#,
        )
        .unwrap();
        assert_eq!(c.crews[0].member_count, 2);
        assert_eq!(c.crews[0].layout_name.as_deref(), Some("main"));

        let cr: CrewRow = serde_json::from_str(
            r#"{"name":"morning","layout_name":"main","members":[{"slot":0,"agent":"claude","resume_id":"r1","harness":"papercup"}]}"#,
        )
        .unwrap();
        assert_eq!(cr.members.len(), 1);
        assert_eq!(cr.members[0].agent.as_deref(), Some("claude"));
        assert_eq!(cr.members[0].plan, None);
    }

    #[test]
    fn empty_crew_members_default() {
        let cr: CrewRow = serde_json::from_str(r#"{"name":"empty"}"#).unwrap();
        assert!(cr.members.is_empty());
        assert_eq!(cr.layout_name, None);
    }

    #[test]
    fn roster_entry_dock_pane_argv_bee_resume_vs_none() {
        use super::{NativeSessionHandle, RosterEntry};
        let bee = RosterEntry {
            owner_id: "s-1".into(),
            session_id: Some("uuid-x".into()),
            ..Default::default()
        };
        // Legacy claude session id → claude --resume (Claude TUI, P-004/D-007)
        assert_eq!(
            bee.dock_pane_argv(),
            Some(vec![
                "claude".to_string(),
                "--resume".to_string(),
                "uuid-x".to_string()
            ])
        );
        // Claude handle WITH a configDir → env-wrapped resume (the transcript
        // lives under the isolated config dir; a bare resume attaches to nothing).
        let claude = RosterEntry {
            owner_id: "s-claude".into(),
            native_session: Some(NativeSessionHandle::Claude {
                source: "adv_sessions".into(),
                owner_id: Some("s-claude".into()),
                session_id: Some("uuid-y".into()),
                config_dir: Some("/home/me/.papercusp/session-claude/s-claude".into()),
                exact_resume_supported: true,
                missing_reason: None,
            }),
            ..Default::default()
        };
        assert_eq!(
            claude.dock_pane_argv(),
            Some(vec![
                "env".to_string(),
                "CLAUDE_CONFIG_DIR=/home/me/.papercusp/session-claude/s-claude".to_string(),
                "claude".to_string(),
                "--resume".to_string(),
                "uuid-y".to_string(),
            ])
        );
        // Claude handle WITHOUT a configDir (legacy payload) → bare resume.
        let claude_legacy = RosterEntry {
            owner_id: "s-claude-legacy".into(),
            native_session: Some(NativeSessionHandle::Claude {
                source: "adv_sessions".into(),
                owner_id: Some("s-claude-legacy".into()),
                session_id: Some("uuid-z".into()),
                config_dir: None,
                exact_resume_supported: true,
                missing_reason: None,
            }),
            ..Default::default()
        };
        assert_eq!(
            claude_legacy.dock_pane_argv(),
            Some(vec![
                "claude".to_string(),
                "--resume".to_string(),
                "uuid-z".to_string(),
            ])
        );
        let codex = RosterEntry {
            owner_id: "s-codex".into(),
            native_session: Some(NativeSessionHandle::Codex {
                source: "spawned_agents".into(),
                owner_id: Some("s-codex".into()),
                codex_home: "/tmp/codex-home".into(),
                rollout_id: Some("019eeb2b-0742-72a0-85a4-5dc505cfe62d".into()),
                exact_resume_supported: true,
                missing_reason: None,
            }),
            ..Default::default()
        };
        assert_eq!(
            codex.dock_pane_argv(),
            Some(vec![
                "env".to_string(),
                "CODEX_HOME=/tmp/codex-home".to_string(),
                "codex".to_string(),
                "resume".to_string(),
                "019eeb2b-0742-72a0-85a4-5dc505cfe62d".to_string(),
            ])
        );
        let omp = RosterEntry {
            owner_id: "s-omp".into(),
            native_session: Some(NativeSessionHandle::Omp {
                source: "spawned_agents".into(),
                owner_id: Some("s-omp".into()),
                omp_thread_id: Some("thread-1".into()),
                agent_home: Some("/home/me/.omp/agent".into()),
                exact_resume_supported: true,
                missing_reason: None,
            }),
            ..Default::default()
        };
        assert_eq!(
            omp.dock_pane_argv(),
            Some(vec![
                "omp".to_string(),
                "-r".to_string(),
                "thread-1".to_string(),
                "--approval-mode".to_string(),
                "yolo".to_string(),
            ])
        );
        // no handle → no dock pane (P-014 retired the read-only watch-pane fallback).
        let nosid = RosterEntry {
            owner_id: "s-2".into(),
            session_id: None,
            ..Default::default()
        };
        assert_eq!(nosid.dock_pane_argv(), None);
    }

    #[test]
    fn roster_entry_work_summary_prefers_intent_then_feature() {
        use super::RosterEntry;
        let mut e = RosterEntry {
            owner_id: "s".into(),
            intent: Some("fixing the dock driver".into()),
            feature: Some("F-012".into()),
            ..Default::default()
        };
        assert_eq!(e.work_summary().as_deref(), Some("fixing the dock driver"));
        e.intent = None; // falls back to the feature id
        assert_eq!(e.work_summary().as_deref(), Some("F-012"));
        e.intent = Some("   ".into()); // whitespace-only intent is ignored
        assert_eq!(e.work_summary().as_deref(), Some("F-012"));
        e.feature = None;
        assert_eq!(e.work_summary(), None); // nothing declared
    }

    #[test]
    fn parses_flags_bootstrap_shape() {
        let f: FlagsResponse = serde_json::from_str(
            r#"{"flags":{"papercusp-oracle":false,"papercusp-snapshots":true},"evaluatedAt":1,"source":"defaults"}"#,
        )
        .unwrap();
        assert_eq!(f.source, "defaults");
        assert_eq!(f.flags.get("papercusp-snapshots"), Some(&true));
        assert_eq!(f.flags.get("papercusp-oracle"), Some(&false));
        // Missing flags map defaults to empty.
        assert!(serde_json::from_str::<FlagsResponse>("{}")
            .unwrap()
            .flags
            .is_empty());
    }

    #[test]
    fn parses_plan_item_states_shape() {
        // Mirrors the /api/tui/plan-item-states DTO (camelCase wire): one pooled
        // item (no assignment/claim) + one active (assigned + live claim by the
        // assignee, with a liveness mode + intent).
        let j = r#"{"harness":"papercup","plan":"my-plan","harnessLivenessMode":"availability","items":[
            {"itemId":"P-001","itemStatus":"todo","blockedBy":[],"inPlan":true,"disposition":"pooled",
             "assigneeName":null,"claimOwner":null,"claimOwnerId":null,"claimOwnerName":null,"claimIntent":null,
             "claimLivenessMode":null,"claimExpiresTs":null},
            {"itemId":"P-002","itemStatus":"wip","blockedBy":["P-001"],"inPlan":true,"disposition":"active",
             "assigneeName":"builder-1","claimOwner":"su · abc","claimOwnerId":"su-abc","claimOwnerName":"builder-1",
             "claimIntent":"building","claimLivenessMode":"activity","claimExpiresTs":"2026-06-04T00:20:00Z"}
        ]}"#;
        let r: PlanItemStates = serde_json::from_str(j).unwrap();
        assert_eq!(r.harness, "papercup");
        assert_eq!(r.harness_liveness_mode, "availability");
        assert_eq!(r.items.len(), 2);
        assert_eq!(r.items[0].item_id, "P-001");
        assert_eq!(r.items[0].disposition, "pooled");
        assert!(r.items[0].blocked_by.is_empty());
        assert_eq!(r.items[0].assignee_name, None);
        assert_eq!(r.items[1].disposition, "active");
        assert_eq!(r.items[1].blocked_by, ["P-001"]);
        assert_eq!(r.items[1].claim_owner_id.as_deref(), Some("su-abc"));
        assert_eq!(r.items[1].assignee_name.as_deref(), Some("builder-1"));
        assert_eq!(r.items[1].claim_owner_name.as_deref(), Some("builder-1"));
        assert_eq!(r.items[1].claim_liveness_mode.as_deref(), Some("activity"));
        // Missing keys default cleanly (no hard-fail).
        let e: PlanItemStates = serde_json::from_str("{}").unwrap();
        assert!(e.items.is_empty());
    }

    #[test]
    fn parses_agent_config_shape() {
        // Trimmed from the live /api/agent-config probe.
        let j = r#"{"config":{"backend":"claude-code","cmd":"claude -p --model haiku",
            "models":{"worker":"opus","merge-resolver":"opus:xhigh"},"backends":{},
            "surfaceModels":{"operator":"sonnet"}},"binaries":{"claude":"/x/claude"},
            "effectiveBackend":"claude-code","effectiveTiers":[
              {"name":"quick","spec":"haiku","when":"small work",
               "loopCapability":{"executable":true,"provider":"gateway-anthropic"}}
            ],"effortLevels":["low","high"],
            "launchableModes":[{"id":"auto","title":"AUTO","oneLiner":"Act without asks."}],
            "envOverrides":{"AGENT_BACKEND":"claude-code"}}"#;
        let r: AgentConfigResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.config.backend, "claude-code");
        assert_eq!(r.effective_backend, "claude-code");
        assert_eq!(r.effective_tiers.len(), 1);
        assert_eq!(r.effective_tiers[0].name, "quick");
        assert_eq!(r.effective_tiers[0].spec, "haiku");
        assert_eq!(
            r.effective_tiers[0]
                .loop_capability
                .as_ref()
                .and_then(|capability| capability.provider.as_deref()),
            Some("gateway-anthropic")
        );
        assert_eq!(r.config.cmd, "claude -p --model haiku");
        assert_eq!(
            r.config.models.get("worker").map(String::as_str),
            Some("opus")
        );
        assert_eq!(
            r.config.models.get("merge-resolver").map(String::as_str),
            Some("opus:xhigh")
        );
        assert_eq!(
            r.config.surface_models.get("operator").map(String::as_str),
            Some("sonnet")
        );
        assert_eq!(r.effort_levels, ["low", "high"]);
        assert_eq!(r.launchable_modes.len(), 1);
        assert_eq!(r.launchable_modes[0].id, "auto");
        assert_eq!(r.launchable_modes[0].one_liner, "Act without asks.");
        // Empty shape defaults cleanly.
        assert!(serde_json::from_str::<AgentConfigResponse>("{}")
            .unwrap()
            .config
            .backend
            .is_empty());
    }

    #[test]
    fn parses_credentials_status_shape() {
        // Inner JSON of the operator:credentials_status envelope (no secret values).
        let j = r#"{"openai":{"set":true,"masked":"sk-…abc"},"elevenlabs":{"set":false,"masked":null}}"#;
        let m: std::collections::BTreeMap<String, CredStatus> = serde_json::from_str(j).unwrap();
        assert!(m.get("openai").unwrap().set);
        assert!(!m.get("elevenlabs").unwrap().set);
        assert_eq!(m.get("openai").unwrap().masked.as_deref(), Some("sk-…abc"));
        assert_eq!(m.get("elevenlabs").unwrap().masked, None);
    }

    // --- Fleet status view (pui-fleet-status-view-2026-06-04) ---

    #[test]
    fn parses_work_items_list_shape() {
        // Trimmed from the live work_items:list envelope inner JSON.
        let j = r#"{"ok":true,"count":2,"items":[
            {"id":"EI-7","kind":"bug","family":"issue","harness":null,"title":"role pin",
             "summary":"found while…","state":"open","assignee":null,"severity":"major",
             "parent":null,"payload":null,"createdAt":"2026-06-04T00:00:00Z","updatedAt":"t"},
            {"id":"F-9","kind":"feature","family":"feature","harness":"papercup","title":"A",
             "summary":"","state":"passed","assignee":"su-x","severity":null,
             "createdAt":"t","updatedAt":"t"}
        ]}"#;
        let r: WorkItemsPayload = serde_json::from_str(j).unwrap();
        assert_eq!(r.items.len(), 2);
        assert_eq!(r.items[0].family, "issue");
        assert_eq!(r.items[0].state, "open");
        assert_eq!(r.items[0].severity.as_deref(), Some("major"));
        assert!(r.items[0].harness.is_none());
        assert_eq!(r.items[1].family, "feature");
        assert_eq!(r.items[1].state, "passed");
        assert_eq!(r.items[1].assignee.as_deref(), Some("su-x"));
        assert_eq!(r.items[1].harness.as_deref(), Some("papercup"));
    }

    #[test]
    fn parses_activity_recent_shape() {
        // Trimmed from the live activity:recent envelope inner JSON (snake_case);
        // extra fields (session_id/phase/tool_use_id) are ignored.
        let j = r#"{"activity":[
            {"id":"9","owner_id":"su-c8ca5-smoke","agent":"claude","session_id":"live-1",
             "harness_slug":"papercup","kind":"tool","tool_name":"Bash","phase":"post",
             "tool_use_id":null,"summary":"▶ npm run test:affected","status":"ok",
             "detail":{"command":"npm run test:affected"},"cwd":null,
             "created_at":"2026-06-04 18:53:58.46-04"},
            {"id":"8","owner_id":"omp-x","agent":"omp","kind":"tool","tool_name":"write",
             "phase":"pre","summary":"✎ x.ts","detail":null,"created_at":"t"}
        ],"count":2}"#;
        let r: ActivityRecentPayload = serde_json::from_str(j).unwrap();
        assert_eq!(r.activity.len(), 2);
        assert_eq!(r.activity[0].owner_id, "su-c8ca5-smoke");
        assert_eq!(r.activity[0].agent.as_deref(), Some("claude"));
        assert_eq!(r.activity[0].kind, "tool");
        assert_eq!(
            r.activity[0].summary.as_deref(),
            Some("▶ npm run test:affected")
        );
        assert!(r.activity[0].detail.is_some());
        assert_eq!(r.activity[1].agent.as_deref(), Some("omp"));
    }

    #[test]
    fn parses_todos_snapshot_detail() {
        let j = r#"{"count":3,"done":1,"todos":[
            {"content":"build fleet.rs","status":"in_progress"},
            {"content":"wire pollers","status":"pending"}
        ]}"#;
        let s: TodoSnapshot = serde_json::from_str(j).unwrap();
        assert_eq!(s.count, 3);
        assert_eq!(s.done, 1);
        assert_eq!(s.todos.len(), 2);
        assert_eq!(s.todos[0].content, "build fleet.rs");
        assert_eq!(s.todos[0].status.as_deref(), Some("in_progress"));
    }

    #[test]
    fn item_counts_total_and_remaining() {
        let c = ItemCounts {
            todo: 3,
            wip: 1,
            blocked: 0,
            needs_human: 1,
            done: 2,
            dropped: 0,
            unknown: 0,
        };
        assert_eq!(c.total(), 7);
        assert_eq!(c.remaining(), 5); // total - (done + dropped)
                                      // An empty `{}` (a plan with no items) → all-zero.
        let empty: ItemCounts = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.total(), 0);
        assert_eq!(empty.remaining(), 0);
    }

    #[test]
    fn plan_summary_parses_item_counts_and_priority() {
        // The plans:list row carries itemCounts (camelCase) + priority; the
        // `needs-human` key maps to `needs_human`.
        let j = r#"{"slug":"p","title":"P","status":"active","updated":"t","archived":false,
            "nextAction":"do","harness":"papercup","priority":5,
            "itemCounts":{"todo":2,"done":3,"needs-human":1}}"#;
        let p: PlanSummary = serde_json::from_str(j).unwrap();
        assert_eq!(p.priority, Some(5));
        assert_eq!(p.item_counts.done, 3);
        assert_eq!(p.item_counts.needs_human, 1);
        assert_eq!(p.item_counts.total(), 6);
        // A plan list row without itemCounts defaults to all-zero.
        let q: PlanSummary = serde_json::from_str(r#"{"slug":"q","status":"draft"}"#).unwrap();
        assert_eq!(q.item_counts.total(), 0);
        assert_eq!(q.priority, None);
    }

    #[test]
    fn plan_summary_tolerates_null_legacy_fields() {
        // The EXACT live legacy-plan shape that broke plans_typed: title / updated
        // / itemCounts all null. A non-Option field with only #[serde(default)]
        // chokes on explicit null and sinks the WHOLE plans list → the Plans +
        // Fleet tabs blank on real data. Must decode to all-empty defaults.
        let p: PlanSummary = serde_json::from_str(
            r#"{"archived":false,"harness":"papercup","isLegacy":true,"itemCounts":null,
                "nextAction":null,"owner":null,"priority":null,"slug":"legacy-plan",
                "startStatus":null,"status":"draft","title":null,"updated":null}"#,
        )
        .unwrap();
        assert_eq!(p.slug, "legacy-plan");
        assert_eq!(p.title, "");
        assert_eq!(p.updated, "");
        assert_eq!(p.status, "draft");
        assert_eq!(p.item_counts.total(), 0);
        assert_eq!(p.priority, None);
        // A list mixing null + object itemCounts decodes fully (no row sinks it).
        let r: PlansResponse = serde_json::from_str(
            r#"{"plans":[
                {"slug":"a","status":"active","itemCounts":null},
                {"slug":"b","status":"active","itemCounts":{"todo":1,"done":2}}
            ]}"#,
        )
        .unwrap();
        assert_eq!(r.plans.len(), 2);
        assert_eq!(r.plans[0].item_counts.total(), 0);
        assert_eq!(r.plans[1].item_counts.done, 2);
    }

    #[test]
    fn plans_response_rehydrates_standard_flat_counts() {
        // The TUI requests the standard tier, whose writer replaces itemCounts
        // with aggregate open/done scalars. Restore those values before any
        // renderer reads the shared ItemCounts model.
        let r: PlansResponse = serde_json::from_str(
            r#"{"plans":[
                {"slug":"standard-plan","status":"active","open":4,"done":2}
            ]}"#,
        )
        .unwrap();
        let p = &r.plans[0];
        assert_eq!(p.open, Some(4));
        assert_eq!(p.done, Some(2));
        assert_eq!(p.item_counts.todo, 4);
        assert_eq!(p.item_counts.done, 2);
        assert_eq!(p.item_counts.total(), 6);
        assert_eq!(p.item_counts.remaining(), 4);
    }

    #[test]
    fn parses_memory_payloads() {
        // memory:list / memory:search inner JSON (D-006 Step 2).
        let j = r#"{"ok":true,"results":[
            {"id":"m-1","memory":"prefers rust","metadata":{"kind":"preference"},"score":0.91},
            {"id":"m-2","memory":"tz is ET","metadata":{"kind":"identity"}}
        ]}"#;
        let p: MemoriesPayload = serde_json::from_str(j).unwrap();
        assert!(p.ok);
        assert_eq!(p.results.len(), 2);
        assert_eq!(p.results[0].kind(), "preference");
        assert_eq!(p.results[0].score, Some(0.91));
        assert_eq!(p.results[1].kind(), "identity");
        // The unavailable shape ({ok:false, reason}) decodes cleanly.
        let u: MemoriesPayload =
            serde_json::from_str(r#"{"ok":false,"reason":"mem0_unavailable","results":[]}"#)
                .unwrap();
        assert!(!u.ok);
        assert_eq!(u.reason.as_deref(), Some("mem0_unavailable"));
        // Metadata-less entries report an empty kind.
        let bare: MemoryEntry = serde_json::from_str(r#"{"id":"x","memory":"y"}"#).unwrap();
        assert_eq!(bare.kind(), "");
    }

    #[test]
    fn parses_conversation_load_shape() {
        // Trimmed from GET /api/operator/conversations (conversation = ConversationRow,
        // turns = TurnRow[]; both camelCase, hasMoreEarlier camelCase).
        let j = r#"{
            "conversation": {"id":"conv-1","workspaceId":"ws","harnessSlug":null,
                "title":null,"status":"active","startedAt":1,"endedAt":null,
                "elConversationIds":[],"hasAudio":false},
            "turns": [
                {"id":"t1","conversationId":"conv-1","seq":0,"role":"user","text":"hi",
                 "source":"text_typed","elConvId":null,"audioUrl":null,"createdAt":1,"tools":null},
                {"id":"t2","conversationId":"conv-1","seq":1,"role":"assistant","text":"hello there",
                 "source":"text_typed","createdAt":2,
                 "tools":[{"name":"harness:list","input":{}}]}
            ],
            "hasMoreEarlier": true
        }"#;
        let r: ConversationLoad = serde_json::from_str(j).unwrap();
        assert_eq!(r.conversation.id, "conv-1");
        assert!(r.has_more_earlier);
        assert_eq!(r.turns.len(), 2);
        assert_eq!(r.turns[0].role, "user");
        assert_eq!(r.turns[1].text, "hello there");
        assert_eq!(r.turns[1].tools.as_ref().unwrap()[0].name, "harness:list");
        assert!(r.turns[0].tools.is_none());
        // Empty shape (force-created conversation, no turns) still decodes.
        let e: ConversationLoad =
            serde_json::from_str(r#"{"conversation":{"id":"c2"},"turns":[]}"#).unwrap();
        assert_eq!(e.conversation.id, "c2");
        assert!(!e.has_more_earlier);
        assert!(e.turns.is_empty());
    }

    #[test]
    fn parses_turns_page_shape() {
        // GET /api/operator/conversations/:id/turns?beforeSeq=N → TurnsPage.
        let j = r#"{"turns":[
            {"id":"t","conversationId":"c","seq":3,"role":"user","text":"older","createdAt":1,"tools":null}
        ],"hasMoreEarlier":true}"#;
        let p: TurnsPage = serde_json::from_str(j).unwrap();
        assert!(p.has_more_earlier);
        assert_eq!(p.turns.len(), 1);
        assert_eq!(p.turns[0].seq, 3);
        assert_eq!(p.turns[0].text, "older");
        // Empty page (tail reached) decodes to defaults.
        let e: TurnsPage = serde_json::from_str("{}").unwrap();
        assert!(e.turns.is_empty());
        assert!(!e.has_more_earlier);
    }

    #[test]
    fn parses_cupboard_pagination_summary_beyond_one_page() {
        let page: CupboardListingsResponse = serde_json::from_str(
            r#"{
                "listings":[{"id":"deep","listing_kind":"plugin","title":"Deep plugin"}],
                "next_cursor":"v1:50:deep",
                "total":137,
                "kind_facets":{"harness":100,"plugin":37}
            }"#,
        )
        .unwrap();
        assert_eq!(page.listings.len(), 1);
        assert_eq!(page.next_cursor.as_deref(), Some("v1:50:deep"));
        assert_eq!(page.total, Some(137));
        assert_eq!(page.kind_facets.get("plugin"), Some(&37));

        let legacy: CupboardListingsResponse = serde_json::from_str(r#"{"listings":[]}"#).unwrap();
        assert!(legacy.next_cursor.is_none());
        assert!(legacy.total.is_none());
        assert!(legacy.kind_facets.is_empty());
    }

    #[test]
    fn hive_share_models_follow_the_discovery_contract() {
        let meta: HiveShareMeta = serde_json::from_str(
            r#"{
                "potId":"acme-hive",
                "found":true,
                "visibility":"invite",
                "title":"Acme Hive",
                "description":"Shared workspace",
                "inviteSecret":"0123456789abcdef0123456789abcdef",
                "hivePubkey":"cHVia2V5",
                "memberRepos":["acme/api#7"]
            }"#,
        )
        .unwrap();
        assert_eq!(meta.pot_id, "acme-hive");
        assert_eq!(meta.visibility, Some(HiveVisibility::Invite));
        assert_eq!(meta.member_repos, vec!["acme/api#7".to_string()]);

        let body = serde_json::to_value(SetHiveListingRequest {
            pot_id: meta.pot_id,
            title: meta.title,
            description: meta.description,
            visibility: HiveVisibility::Public,
            invite_secret: None,
        })
        .unwrap();
        assert_eq!(body["potId"], "acme-hive");
        assert_eq!(body["visibility"], "public");
        assert!(body.get("inviteSecret").is_none());

        let outcome: SetHiveListingResponse =
            serde_json::from_str(r#"{"ok":true,"saved":true,"announced":true,"reachablePeers":0}"#)
                .unwrap();
        assert!(outcome.announced);
        assert_eq!(outcome.reachable_peers, Some(0));
    }

    #[test]
    fn cupboard_listing_actions_cover_live_kinds_without_false_affordances() {
        let template: CupboardListing = serde_json::from_str(
            r#"{"id":"template-1","listing_kind":"template","listing_ref":"webapp"}"#,
        )
        .unwrap();
        assert_eq!(template.normalized_kind(), "template");
        assert_eq!(template.action_label(), Some("install"));

        let knowledge_pack: CupboardListing =
            serde_json::from_str(r#"{"id":"knowledge-1","listing_kind":"knowledge-pack"}"#)
                .unwrap();
        assert_eq!(knowledge_pack.action_label(), Some("stage"));

        let legacy_pack: CupboardListing =
            serde_json::from_str(r#"{"id":"pack-1","listing_kind":"tool-pack"}"#).unwrap();
        assert_eq!(legacy_pack.normalized_kind(), "pack");
        assert_eq!(legacy_pack.action_label(), Some("install"));

        let bundle: CupboardListing =
            serde_json::from_str(r#"{"id":"app-1","listing_kind":"app","delivery_type":"bundle"}"#)
                .unwrap();
        assert_eq!(bundle.action_label(), Some("install"));

        let standalone_without_release: CupboardListing = serde_json::from_str(
            r#"{"id":"app-2","listing_kind":"app","delivery_type":"standalone"}"#,
        )
        .unwrap();
        assert_eq!(standalone_without_release.action_label(), None);

        let standalone_with_release: CupboardListing = serde_json::from_str(
            r#"{"id":"app-3","listing_kind":"app","delivery_type":"standalone","latest_json_url":"https://example.test/latest.json"}"#,
        )
        .unwrap();
        assert_eq!(standalone_with_release.action_label(), None);

        let plan: CupboardListing =
            serde_json::from_str(r#"{"id":"plan-1","listing_kind":"plan"}"#).unwrap();
        assert_eq!(plan.action_label(), None);

        let unknown: CupboardListing =
            serde_json::from_str(r#"{"id":"future-1","listing_kind":"future-kind"}"#).unwrap();
        assert_eq!(unknown.action_label(), None);
    }

    #[test]
    fn parses_conversations_list_shape() {
        // conversations:list (snake_case) → rows carry topics + promoted link.
        let j = r#"{"ok":true,"count":2,"conversations":[
            {"id":"conv-1","kind":"question","state":"open","scope":"operator","harness_slug":null,
             "title":"why freeze?","asker_id":"agA","topics":["zero-cache","firefox"],
             "promoted_issue_id":null,"created_ts":"2026-06-05T00:00:00.000Z","resolved":false},
            {"id":"conv-2","kind":"discussion","state":"closed","scope":"harness","harness_slug":"papercup",
             "title":null,"asker_id":"agB","topics":[],"promoted_issue_id":"EI-9","created_ts":"x"}
        ]}"#;
        let p: ConvListResponse = serde_json::from_str(j).unwrap();
        assert_eq!(p.conversations.len(), 2);
        assert_eq!(p.conversations[0].topics, vec!["zero-cache", "firefox"]);
        assert_eq!(
            p.conversations[1].promoted_issue_id.as_deref(),
            Some("EI-9")
        );
        assert_eq!(p.conversations[1].harness_slug.as_deref(), Some("papercup"));
        assert!(p.conversations[1].title.is_none());
    }

    #[test]
    fn parses_conversation_detail_shape() {
        // conversations:get — conversation nested; topics/posts/subscriber_count siblings.
        let j = r#"{"ok":true,"conversation":{"id":"conv-1","kind":"question","state":"resolved",
            "scope":"operator","harness_slug":null,"title":"q","body":"the body","asker_id":"agA",
            "accepted_answer":"because X","promoted_issue_id":null,"created_ts":"x"},
            "topics":["zero-cache"],"posts":[{"id":7,"author_id":"agB","body":"a reply","created_ts":"x"}],
            "subscriber_count":3}"#;
        let d: ConvDetail = serde_json::from_str(j).unwrap();
        let c = d.conversation.expect("conversation present");
        assert_eq!(c.id, "conv-1");
        assert_eq!(c.accepted_answer.as_deref(), Some("because X"));
        assert_eq!(d.topics, vec!["zero-cache"]);
        assert_eq!(d.posts.len(), 1);
        assert_eq!(d.posts[0].id, 7);
        assert_eq!(d.subscriber_count, 3);
        // not_found shape decodes to an empty detail (no conversation).
        let nf: ConvDetail = serde_json::from_str(r#"{"ok":false,"reason":"not_found"}"#).unwrap();
        assert!(nf.conversation.is_none());
    }

    #[test]
    fn parses_conversation_get_success_envelope() {
        let j = r#"{"ok":true,"results":[{"ok":true,"id":"conv-1",
            "conversation":{"id":"conv-1","kind":"question","state":"open",
            "scope":"operator","harness_slug":null,"title":"q","body":"seed",
            "asker_id":"agA","accepted_answer":null,"promoted_issue_id":null,"created_ts":"x"},
            "topics":["coord"],"posts":[],"subscriber_count":2}],
            "counts":{"ok":1,"failed":0}}"#;
        let p: ConvGetResponse = serde_json::from_str(j).unwrap();
        assert!(p.ok);
        assert_eq!(p.counts.ok, 1);
        assert_eq!(p.counts.failed, 0);
        let result = &p.results[0];
        assert!(result.ok);
        assert_eq!(result.id, "conv-1");
        assert_eq!(result.detail.conversation.as_ref().unwrap().body, "seed");
        assert_eq!(result.detail.topics, vec!["coord"]);
    }

    #[test]
    fn preserves_conversation_get_per_item_not_found_error() {
        let j = r#"{"ok":true,"results":[
            {"ok":false,"id":"missing","error":"not_found"}],
            "counts":{"ok":0,"failed":1}}"#;
        let p: ConvGetResponse = serde_json::from_str(j).unwrap();
        let result = &p.results[0];
        assert!(!result.ok);
        assert_eq!(result.id, "missing");
        assert_eq!(result.error.as_deref(), Some("not_found"));
        assert!(result.detail.conversation.is_none());
    }

    #[test]
    fn conversation_get_results_are_correlated_by_id_not_position() {
        let j = r#"{"ok":true,"results":[
            {"ok":true,"id":"conv-2","conversation":{"id":"conv-2"}},
            {"ok":true,"id":"conv-1","conversation":{"id":"conv-1"}}],
            "counts":{"ok":2,"failed":0}}"#;
        let p: ConvGetResponse = serde_json::from_str(j).unwrap();
        let result = p
            .results
            .iter()
            .find(|result| result.id == "conv-1")
            .expect("matching result");
        assert_eq!(result.detail.conversation.as_ref().unwrap().id, "conv-1");
    }

    #[test]
    fn tool_palette_catalog_rows_tolerate_nullable_descriptive_fields() {
        let hit: ToolPaletteHit = serde_json::from_str(
            r#"{"tool":"tools:find","description":null,"argSchema":null,"returns":null,"via":null}"#,
        )
        .unwrap();
        assert_eq!(hit.name, "tools:find");
        assert!(hit.description.is_empty());
        assert!(hit.arg_schema.is_empty());

        let recipe: ToolPaletteRecipe =
            serde_json::from_str(r#"{"id":"recipe-1","title":null,"description":null}"#).unwrap();
        assert_eq!(recipe.id, "recipe-1");
        assert!(recipe.title.is_empty());
        assert!(recipe.description.is_empty());
    }
}
