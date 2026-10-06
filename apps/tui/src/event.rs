//! Event sources that feed the single update loop through one mpsc channel.
//!
//! Architecture (SP-TUI A2): all inputs — terminal keys, periodic ticks, and
//! async backend deltas — are normalised into `Event` and drained by one
//! `App::update`. crossterm's `event::read` is blocking, so it lives on a
//! dedicated OS thread that forwards into the async channel; the backend poller
//! (see `main`) forwards `Plans` / `Roster` / `Error`.

use crate::models::{
    ActivityRow, AttentionItem, BeeAssignment, BeeMailPayload, ChatMessage, ChatToolCall,
    ConvDetail, ConvSummary, DocsResponse, EffectiveClaudeSettings, FlagsResponse,
    FleetLeaderBrief, FleetRateStatus, GoalSummary, HarnessFeature, HarnessIssue, HarnessRef,
    LexiconPackPayload, Notif, OperatorConfig, PipelineStatus, PlanItemStates, PlanSummary,
    RosterEntry, SessionTranscriptResolution, SessionTranscriptTurn, TestingDomain, ToolPaletteHit,
    ToolPaletteRecipe, TuiPaneContribution, ViewState, WorkFrontier, WorkItem,
};
use crossterm::event::{self, Event as CtEvent, KeyEvent, MouseEvent};
use pui_companion_proto::Topology;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

/// Result of loading the Memory tab.  A backend that is disabled is a valid
/// response from `memory:list`; authentication and transport failures are
/// different states and must not be rendered as "backend unavailable".
#[derive(Debug, Clone)]
pub enum MemoryLoadState {
    Available {
        results: Vec<crate::models::MemoryEntry>,
    },
    BackendUnavailable {
        reason: Option<String>,
    },
    AuthFailure {
        message: String,
    },
    TransportFailure {
        message: String,
    },
}

/// Everything the update loop reacts to.
#[derive(Debug, Clone)]
pub enum Event {
    /// A terminal key press.
    Key(KeyEvent),
    /// A bracketed paste — the literal pasted text, delivered as ONE event.
    ///
    /// This exists because of what happens WITHOUT it: the terminal replays a
    /// paste as ordinary keystrokes, so every embedded newline arrives as
    /// `Enter` and SUBMITS. Pasting a three-line snippet into the composer sent
    /// three separate half-messages. The paste must therefore reach the reducer
    /// as data, never as input to the key bindings.
    Paste(String),
    /// The terminal (or multiplexer pane) lost keyboard focus.
    ///
    /// This exists for the same reason `Paste` does — because of what happens
    /// WITHOUT it. Hold-to-talk starts recording on a key press and stops on
    /// that key's RELEASE. Move focus away mid-hold and the release is delivered
    /// to whoever has focus now, never to us, so the microphone stays open with
    /// nothing on screen explaining why. Focus loss is the only signal that the
    /// keys we believe are held cannot be released to us any more, so it is
    /// treated as releasing all of them (`App::release_held`).
    ///
    /// Only arrives while focus-change reporting is enabled (main pushes it
    /// alongside bracketed paste). A terminal or multiplexer that does not
    /// report focus simply never sends it — the pre-existing behaviour, not a
    /// regression. `FocusGained` is deliberately NOT forwarded: nothing is
    /// re-armed by regaining focus, and a held key cannot resume.
    FocusLost,
    /// The terminal was resized to (cols, rows). It guarantees the redraw happens
    /// NOW — before this was forwarded an idle PUI kept painting the old
    /// geometry until some unrelated event arrived, so neither the compact
    /// layout nor "resize resumes the prior surface and draft"
    /// (PUBLIC_RELEASE_UX.md) held. The geometry lets the app hold input while
    /// the terminal is below the supported minimum (`ui::too_small`); ratatui
    /// still re-reads the size itself on each draw.
    Resize(u16, u16),
    /// A mouse wheel notch or a left-button press, drag or release
    /// (pui-chat-first-ux P-018). Only the chat-first surface turns mouse
    /// reporting on (main.rs), because without it the terminal turns the wheel
    /// into Up/Down keys on the alternate screen, which in the message box
    /// cycle your sent messages instead of scrolling the conversation. Pointer
    /// motion and the other buttons are dropped by the reader, so moving the
    /// mouse wakes nothing.
    Mouse(MouseEvent),
    /// Idle tick (emitted when no input arrives within the poll window).
    Tick,
    /// A signal asked pui to stop: SIGHUP when its terminal closes, SIGTERM,
    /// or SIGINT (pui-chat-first-ux P-009). It quits exactly like `/exit`, so
    /// the attached conversation's engine ends with it.
    Terminate,
    /// Fresh plans list from the backend poller.
    Plans(Vec<PlanSummary>),
    /// Fresh goals list from the backend poller (the Plans-tab spine, P-032).
    Goals(Vec<GoalSummary>),
    /// Fresh agent roster from the backend poller. `active` is the presence-
    /// primary roster (rendered); `pending` is the recorded-but-not-running
    /// workbench-launch tier (pui-reactive-session-panes D-006) the reducer diffs
    /// to reactively open work-area panes — never rendered in the roster.
    Roster {
        active: Vec<RosterEntry>,
        pending: Vec<RosterEntry>,
    },
    /// Rows for the global session-switcher overlay. `query` guards against a
    /// slower, older fuzzy search painting over newer input.
    SessionSwitcher {
        query: String,
        result: Result<Vec<RosterEntry>, String>,
    },
    /// Rows for the full Sessions destination. It shares the switcher's merged
    /// live + indexed model, but keeps its own stale-query guard and facets.
    SessionBrowser {
        query: String,
        result: Result<Vec<RosterEntry>, String>,
    },
    /// Result of lazily resolving one selected roster row against its exact
    /// native session id. `Ok(None)` is the explicit unavailable verdict.
    SessionTranscriptResolved {
        session_key: String,
        result: Result<Option<SessionTranscriptResolution>, String>,
    },
    /// Canonical transcript tail for the currently selected browser row.
    SessionTranscript {
        session_key: String,
        result: Result<Vec<SessionTranscriptTurn>, String>,
    },
    /// Completion of a Sessions rename/archive write. `session_key` prevents a
    /// late result from clearing the busy state of a newer selection.
    SessionBrowserMutation {
        session_key: String,
        result: Result<String, String>,
    },
    /// A linked continuation row was created. The reducer verifies the returned
    /// lineage before rebinding the Agent Chat pane and opening its SU runtime.
    SessionBrowserContinued {
        session_key: String,
        source_chat_id: String,
        harness: String,
        result: Result<crate::agent_chats::AgentChat, String>,
    },
    /// Fresh inbox (attention) items from the backend poller.
    Inbox(Vec<AttentionItem>),
    /// Fresh fleet rate/usage read-model (Overview top-bar, Brief 23 P-005).
    FleetRate(FleetRateStatus),
    /// Four registered release-pipeline cells for the Overview pipeline tile.
    PipelineStatus(Box<PipelineStatus>),
    /// EI-358: a pending-launch CLAIM failed in transport (operator blip) — the
    /// reducer un-tracks the id so a later roster tick retries. A LOST claim
    /// (another pui instance won) never emits this; it stays tracked/skipped.
    LaunchClaimRetry(i64),
    /// Realtime operator voice session updates (voice-realtime-tui-2026-06-05).
    ConvAi(crate::voice_convai::ConvAiUpdate),
    /// P2P voice-channel updates (holepunch-voice-channels P-008): socket
    /// status/error/mic + HTTP-fetched channel list / prefs, folded into the
    /// Voice tab's state by the reducer.
    VoiceUi(crate::voice_ui::VoiceUiEvent),
    /// Fresh features for a harness. The slug guards against an in-flight
    /// response for the previous pot repainting the newly selected pot.
    Features {
        harness: String,
        features: Vec<HarnessFeature>,
    },
    /// Fresh issues for a harness. The slug guards against an in-flight
    /// response for the previous pot repainting the newly selected pot.
    Issues {
        harness: String,
        issues: Vec<HarnessIssue>,
    },
    /// The harness list (for the selector).
    Harnesses(Vec<HarnessRef>),
    /// Project docs (file list + active doc content) for a harness. The slug
    /// guards against a stale response after switching pots.
    Docs { harness: String, docs: DocsResponse },
    /// Testing domains for a harness. The slug guards against a stale response
    /// after switching pots.
    Testing {
        harness: String,
        testing: Vec<TestingDomain>,
    },
    /// The selected testing domain's runnable files (D-004a, from domain-detail).
    /// Carries the domain id so a stale fetch never paints the wrong domain.
    TestingFiles {
        domain_id: String,
        files: Vec<String>,
    },
    /// Typed memory-list outcome. This keeps auth/transport failures distinct
    /// from the backend's intentional `ok:false` unavailable envelope.
    MemoryLoad(MemoryLoadState),
    /// Semantic hits from `memory:search` for the query the user typed (D-006).
    MemoryHits {
        query: String,
        results: Vec<crate::models::MemoryEntry>,
    },
    /// Rolling snapshot from the detached test lifecycle (D-004a).  The first
    /// snapshot binds the UI to a run id; subsequent snapshots update output
    /// until a terminal status arrives.
    TestRunProgress {
        file: String,
        snapshot: crate::models::TestRunSnapshot,
    },
    /// A test run finished (legacy synchronous seam, retained for compatibility
    /// with older callers and reducer tests).
    ///
    /// Deliberately unconstructed in the binary: the live path is
    /// `TestRunProgress`, whose terminal snapshot ends a run. This variant and
    /// its reducer arm are kept as the compatibility seam the doc above
    /// describes, and are exercised by the reducer tests — so the dead_code
    /// warning is a statement about the bin build only, not unreachable code.
    #[allow(dead_code)]
    TestRunDone {
        file: String,
        result: crate::models::TestRunResult,
    },
    /// Plugin-contributed TUI panes for a harness (D-002). The slug guards
    /// against a stale response after switching pots.
    TuiPanes {
        harness: String,
        panes: Vec<TuiPaneContribution>,
    },
    /// All installed plugin manifests for the Plugins tab (D-007) — identity +
    /// frontend/backend contribution surfaces + configSchema.
    Plugins(Vec<crate::models::PluginManifest>),
    /// One plugin's saved per-harness config (D-014) — loaded on Enter in the
    /// Plugins list, refreshed after each `:pset`/`:punset` round-trip. Carries
    /// the plugin name so a stale fetch never paints another plugin's config.
    PluginConfig {
        plugin: String,
        config: serde_json::Value,
    },
    /// A harness's effective claude-settings view (D-013) — defaults overlaid
    /// by the file, plus the raw file body the `:set`/`:unset` editor
    /// round-trips. The slug guards against a stale response after switching
    /// pots.
    Config {
        harness: String,
        config: EffectiveClaudeSettings,
    },
    /// Feature flags + values for the read-only Settings tab (P10).
    Flags(FlagsResponse),
    /// Merged plan-item assignment/claim/liveness for the SELECTED plan (P-005a) —
    /// rendered in the Plans detail pane.
    PlanItemStates(PlanItemStates),
    /// P-034 read-only `scheduler:preview_spec_delta` result, guarded by the
    /// fleet name currently shown in the launcher modal.
    FleetLaunchPreview {
        fleet: String,
        result: Result<serde_json::Value, String>,
    },
    /// P-034's confirmed `fleet:launch-on-plan` result. The invocation itself
    /// is the durable audit trail; this event only paints its terminal outcome.
    FleetLaunchFinished {
        fleet: String,
        result: Result<serde_json::Value, String>,
    },
    /// Read-only operator-config overview (P10b) for the Settings tab — AI backend
    /// + per-role models + connected speech providers.
    OperatorConfig(OperatorConfig),
    /// Fresh inference-gateway pool rows for the Agent Chat account picker.
    AccountRows(Vec<crate::session_config::AccountRow>),
    /// Canonical per-provider capacity rollups from the same accounts:status read.
    AccountPoolVerdicts(Vec<crate::session_config::ProviderPoolVerdict>),
    /// Fleet-wide work items (work_items:list) for the Fleet tab (P0).
    /// Keep transport failures with this panel instead of routing them through
    /// the global status error, where a later poll can erase the diagnosis.
    WorkItems {
        result: Result<Vec<WorkItem>, String>,
    },
    /// Activity backfill (activity:recent, newest-first) seeding the Fleet feed (P1).
    ActivitySeed(Vec<ActivityRow>),
    /// A dedicated todos backfill (activity:recent kind=todos) for the per-agent
    /// todo map (P2) — keeps todos current even when they fall outside the feed.
    ActivityTodos(Vec<ActivityRow>),
    /// One live activity row from /api/activity/stream — prepended to the feed (P1).
    ActivityLive(ActivityRow),
    // --- Bee-dossier dock pane (pui-bee-dossier-pane-2026-06-06) ---
    /// The Fleet-tab bee selection changed (applied in-process by the run loop's
    /// `PublishBeeSelection` arm — pui-dock-consolidation-2026-06-07). The
    /// reducer updates `bee`, clearing the stale dossier on a change.
    BeeSelection {
        owner_id: Option<String>,
        name: Option<String>,
    },
    /// A fetched bee dossier (assignment + coord inbox/outbox). Carries the
    /// owner_id so a stale fetch never paints the wrong bee (the standard guard).
    BeeDossier {
        owner_id: String,
        assignment: Option<BeeAssignment>,
        mail: Option<BeeMailPayload>,
    },
    /// Whole-fleet assignments (every bee's ranked work-list), for the default
    /// Swarm dossier (pui-dock-consolidation-2026-06-07 #2). The reducer stores
    /// them in `fleet.all_assignments`.
    FleetAssignments(Vec<BeeAssignment>),
    /// Canonical whole-harness actionable frontier for the unfiltered dossier.
    WorkFrontier {
        harness: String,
        result: Result<WorkFrontier, String>,
    },
    /// Acting-leader cockpit snapshot. The fleet slug guards stale async reads.
    FleetLeaderBrief {
        fleet: String,
        result: Result<FleetLeaderBrief, String>,
    },
    /// Terminal result from one y-confirmed leader-cockpit mutation. The fleet
    /// label is retained for the durable/audited outcome line and refresh.
    FleetControlFinished {
        fleet: String,
        result: Result<String, String>,
    },
    /// A manual-mode agent's staged wakes (hive-agent-tabs P-009) — the result of
    /// `FetchWakeQueue` (and the auto-refresh after a release/skip). Carries the
    /// agent so a stale response never paints another agent's review overlay.
    WakeQueue {
        agent: String,
        result: Result<Vec<crate::models::PendingWake>, String>,
    },
    /// The fleet-wide staged-wake board (the `pui wake-pane` dock pane,
    /// EI-312): per-agent groups (queen first) + the GLOBAL default wake-mode.
    /// A whole snapshot — it replaces the pane's state each refresh.
    WakeBoard {
        result: Result<(Vec<crate::models::WakeGroup>, Option<String>), String>,
    },
    /// The agent-context pane snapshot (dock 4-pane split, owner ask
    /// 2026-06-11) — brief / mail / work data for ONE agent, replacing the
    /// pinned `Tab::AgentCtx` pane's state each refresh.
    AgentCtx {
        result: Result<crate::models::AgentCtxData, String>,
    },
    /// The deployed cloud frames (hive-agent-tabs P-013) from
    /// `/api/deploy/frames` — drives the per-frame zellij tabs in the dock.
    Frames(Vec<crate::models::DeployFrameRow>),
    /// The federated p2p roster for the Hives tab (pui-hives-tab-2026-06-07) —
    /// every remote peer announced into `shared_presence`, via `coord:presence`.
    Hives(Vec<crate::models::PresenceRow>),
    /// The P2P hive directory (p2p-hive-directory P-006) — verified hives
    /// announced on the directory topic, via `GET /api/discovery/pots`.
    HiveDirectory(Vec<crate::models::DiscoveredHiveRow>),
    /// The cross-Hive network board (hive-network-surface-2026-06-11 B-09) —
    /// one pinned-C-3 row per hive-context over the capability ladder, from
    /// B-08's data endpoint. A whole snapshot; replaces the pane's rows.
    NetworkBoard(Vec<crate::models::NetworkBoardRow>),
    /// The per-hive drill-in dossier data (hive-network-surface P-014 item 2):
    /// a foreign hive's captured beacon HISTORY + the full C-1 ask log for the
    /// `pui hive-pane <key>` instance's pinned key. A whole snapshot; replaces
    /// both lists each refetch (rides the standard SSE + 60s cadence).
    HiveDossier {
        beacons: Vec<crate::models::HiveBeaconSnapshot>,
        asks: Vec<crate::models::CrossHiveAskRow>,
    },
    /// The active Hive lexicon pack, fetched once at startup
    /// (pui-hive-lexicon-2026-06-06). The reducer stores the term→label map.
    LexiconPack(LexiconPackPayload),
    /// Marketplace listings for the Cupboard tab (D-011) — the result of a
    /// `FetchCupboard` action. Carries the (kind, query) the fetch was for so a
    /// stale response never paints a newer filter's view. Action outcomes
    /// (join/fork/install) ride the ordinary `Notify`/`Error` events.
    CupboardListings {
        kind: String,
        query: String,
        requested_cursor: Option<String>,
        append: bool,
        failed: bool,
        listings: Vec<crate::models::CupboardListing>,
        next_cursor: Option<String>,
        total: Option<usize>,
        kind_facets: std::collections::BTreeMap<String, usize>,
    },
    /// The conversations list for the Conversations tab (Brief 25) — the result
    /// of a `FetchConversations` action under the current state/kind/topic filter.
    Conversations(Vec<ConvSummary>),
    /// One conversation's full detail (thread + topics + accepted answer + linked
    /// work-item) loaded on selection. Carries the id so a stale fetch never
    /// paints another conversation's detail (the TestingFiles/PluginConfig guard).
    ConversationDetail { id: String, detail: ConvDetail },
    /// Results for one `:tool <query>` catalog search. Both legs are kept
    /// independent: recipe suggestions may degrade without hiding valid tool
    /// matches, while the query guards against an older async result repainting
    /// a newer search.
    ToolPaletteSearchFinished {
        query: String,
        tools: Result<Vec<ToolPaletteHit>, String>,
        recipes: Result<Vec<ToolPaletteRecipe>, String>,
    },
    /// Terminal result from invoking the selected catalog entry through
    /// `tools:invoke`. The query + tool name provide the same stale-result guard
    /// as every other async palette-backed surface.
    ToolPaletteInvocationFinished {
        query: String,
        tool: ToolPaletteHit,
        args: serde_json::Value,
        result: Result<serde_json::Value, String>,
    },
    /// A live `attention.notify` event (P8) — raise a toast + OS notification.
    Notify(Notif),
    /// Backfilled notification history from `/api/toast-log` (P8).
    ToastHistory(Vec<Notif>),
    /// A backend fetch failed (shown in the status bar).
    Error(String),
    /// An install-lifecycle preview or result for the palette panel (P-011 / D-016).
    Lifecycle(crate::self_install::LifecycleView),
    /// Canonical endpoint/workspace/store/build/chat identity. Unlike ordinary
    /// polling errors, a failed identity probe remains visible until fixed.
    BackendIdentity(Result<crate::client::BackendIdentity, String>),
    SetupProjectCreated {
        slug: String,
        result: Result<Vec<HarnessRef>, String>,
    },
    /// The persisted workbench view-state loaded on startup (P12 / D-002) —
    /// restore the active tab/selections/scroll where the user left off.
    ViewStateLoaded(ViewState),
    /// An agent control intent (P12b / D-002 A6 — tui:dispatch) arrived over the
    /// `/api/tui/intents/stream` SSE. Applied to AppState; the result is POSTed
    /// back to `/api/tui/intents/:id/result`.
    TuiIntent {
        id: i64,
        intent: String,
        args: serde_json::Value,
    },
    // --- Operator chat pane (tui-operator-surface-2026-06-04) ---
    /// The operator conversation loaded on open (GET /api/operator/conversations):
    /// the conversation id + recent turns (oldest first) + whether older history
    /// exists. Seeds the transcript.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "operator chat history loading is staged for the native pane"
        )
    )]
    ChatHistory {
        conversation_id: String,
        messages: Vec<ChatMessage>,
        has_more_earlier: bool,
        /// Lowest `seq` in this page — the load-earlier cursor. `None` if empty.
        oldest_seq: Option<i64>,
    },
    /// An older page of turns (load-earlier / infinite scroll-back) — prepended
    /// to the transcript. Carries the new oldest cursor + whether more remain.
    ChatEarlier {
        messages: Vec<ChatMessage>,
        has_more_earlier: bool,
        oldest_seq: Option<i64>,
    },
    /// A streamed `delta` chunk of the in-flight operator turn — appended to the
    /// streaming assistant bubble's raw buffer.
    ChatDelta(String),
    /// A `tool_call` the operator made mid-turn — a chip on the streaming bubble.
    ChatToolCall(ChatToolCall),
    /// The in-flight operator turn finished (`done`) — finalize the bubble.
    ChatDone,
    /// The operator converse stream errored (`error`, or transport failure).
    ChatError(String),
    /// A card answer's `/card-response` POST failed (P-015). Only that card goes
    /// back to answerable; the run it belongs to is still waiting on it, so this
    /// is never a turn failure (which `ChatError` would make it).
    CardRespondFailed {
        correlation_id: String,
        error: String,
    },
    /// The transcript row backing the attached SU session resolved. Emitted by
    /// SU-session create/attach so later control commands keep one durable chat.
    AgentChatBound(String),
    AgentChatLoaded {
        harness: String,
        chat_id: Option<String>,
        role: String,
        load_token: u64,
        summaries: Vec<crate::agent_chats::AgentChatSummary>,
        messages: Vec<crate::models::ChatMessage>,
        owner_turn_ids: Vec<String>,
        approvals: Vec<crate::models::PendingApproval>,
    },
    /// The conversation LIST alone refreshed (P-027 G-12): updates the /resume
    /// inventory without touching the open conversation, unlike
    /// `AgentChatLoaded`.
    AgentChatListLoaded {
        harness: String,
        summaries: Vec<crate::agent_chats::AgentChatSummary>,
    },
    /// Listing this pot's conversations failed (P-027 G-12). The /resume
    /// picker says so in plain words instead of loading forever.
    AgentChatListFailed { harness: String, message: String },
    /// A parked historical HITL request was decided through the resolve POST.
    AgentChatApprovalResolved { call_id: String, approved: bool },
    /// A PUI SU-session create/attach completed through launch-su.  The
    /// binding carries the stable advSessionId and backend identity used by
    /// every subsequent snapshot/stream/control call.
    SuSessionOpened(crate::su_session::SuSessionBinding),
    /// Async session work belongs to the selection which started it. The
    /// generation covers create, attach, stream and command replies together.
    SuSessionAsync {
        harness: String,
        load_token: u64,
        event: Box<Event>,
    },
    /// Initial canonical SU-session descriptor snapshot after attach/restart.
    SuSessionSnapshot(crate::su_session::SuSessionSnapshot),
    /// One typed lifecycle/transcript/tool/card/refusal event from the shared
    /// SU-session host.  The reducer keeps sequence ordering and identity
    /// checks here rather than inferring state from transcript text.
    SuSessionEvent(crate::su_session::SuSessionEvent),
    /// A failed snapshot/stream/open operation.  The existing chat pane stays
    /// usable, but the error remains explicit instead of silently falling back
    /// to an untyped provider path.
    SuSessionError(String),
    /// launch-su answered and refused to start the engine (WI-10004158). The
    /// operator was reached, so this is not a lost connection; `message` is
    /// the operator's reason, which the default chat shows.
    SuSessionRefused { code: String, message: String },
    /// A stream-scoped failure.  The chat id lets the reducer discard a late
    /// EOF/error from a session that the owner has already switched away from.
    SuSessionStreamError { chat_id: String, message: String },
    /// Immediate acknowledgement from a SU-session control POST. Terminal
    /// completion/refusal still arrives on the ordered session stream.
    SuSessionCommandResult(String),
    /// Owner-turn delivery is correlated separately from session controls.
    /// A network failure retains the exact command for an idempotent retry.
    SuTurnPrepared {
        command_id: String,
        command: serde_json::Value,
    },
    SuTurnAcknowledged {
        command_id: String,
        session: crate::su_session::SuSessionIdentity,
        /// Replaying a saved receipt emits no new command events. Reconcile
        /// the current host state so an already finished turn cannot stay busy.
        replay_snapshot: Option<Box<crate::su_session::SuSessionSnapshot>>,
    },
    SuTurnFailed {
        command_id: String,
        message: String,
        uncertain: bool,
    },
    /// Bounded startup inventory of every chat that has a durable SU-session
    /// binding.  This is separate from the selected session state so ended
    /// sessions remain inspectable in the picker.
    SuSessionInventory {
        harness: String,
        selected_chat_id: Option<String>,
        entries: Vec<crate::su_session::SuSessionInventoryEntry>,
    },
    /// Snapshot from the one shared conversations.contextProjection query.
    /// `None` is an honest capability-tier absence for the requested target.
    ConversationContextProjectionLoaded {
        target: crate::models::ConversationContextProjectionTarget,
        projection: Option<crate::models::ConversationContextProjection>,
    },
    /// Result of an owner task mutation. Failures remain typed here instead of
    /// collapsing into the generic error event so the Context editor can keep
    /// its exact draft and become retryable.
    AgentChatTaskMutationFinished {
        target: crate::models::ConversationContextProjectionTarget,
        result: Result<crate::models::ConversationContextProjection, String>,
    },
    // --- Inline cards (sentinel-tui-shared-backend-and-cards-2026-06-22 Phase 2a) ---
    /// One per-run state-channel snapshot from `/api/operator/state-snapshot` —
    /// the union of open `chat:ask_choice` cards for a run. The reducer folds it
    /// into `card_state`; the focused card renders inline in the operator pane.
    CardSnapshot(crate::card_view::SnapshotEnvelope),
    /// The active workspace id the card loop resolved at startup — stamped onto
    /// app state so a `/card-response` can carry the defense-in-depth gate.
    CardWorkspace(Option<String>),
    // --- Companion zellij plugin (P-004 / D-008): the in-zellij vantage point.
    // Sourced from the `zellij pipe` child's stdout, not the backend. ---
    /// The companion plugin linked up (carries its version).
    CompanionReady(String),
    /// Fresh live workbench topology (tabs + panes) from the companion plugin.
    Topology(Topology),
    /// A command pane's command exited — the crash/finish signal (offer relaunch).
    PaneExited {
        pane_id: u32,
        exit_code: Option<i32>,
    },
    /// A pane was fully closed in the live session.
    PaneClosed { pane_id: u32 },
    // --- Voice mode (voice-mode-tui-port-2026-06-05) ---
    /// A terminal key RELEASE. Only delivered when the kitty keyboard protocol
    /// is active (most terminals never emit it); drives hold-to-talk PTT. Press
    /// + Repeat still arrive as `Key`, so every existing binding is unaffected.
    KeyRelease(KeyEvent),
    /// A voice-pipeline state change (record → transcribe → converse → speak),
    /// sourced from the PTT turn task. See `app::VoicePhase`.
    Voice(VoiceMsg),
    /// A crew RESTORE resolved against the live roster (P-031 — crews are the
    /// multi-session switch): `fresh_spawned` panes were opened, `live`
    /// members should be focused (the reducer focuses the first), `woken` /
    /// `wake_failed` report the `coord:wake` results for parked members, and
    /// `ended` members await the user's go-ahead in the reducer's
    /// crew-restore prompt instead of silently vanishing (D-009).
    CrewRestoreResolved {
        name: String,
        fresh_spawned: usize,
        live: Vec<RosterEntry>,
        woken: Vec<String>,
        wake_failed: Vec<String>,
        ended: Vec<crate::models::CrewMember>,
    },
}

/// A message from the voice PTT pipeline (voice-mode-tui-port-2026-06-05).
#[derive(Debug, Clone)]
pub enum VoiceMsg {
    /// Mic capture opened (or failed to open — `Err` carries why).
    Started(std::result::Result<(), String>),
    /// Whisper transcribed the utterance — inject it as the user's turn.
    Transcribed(String),
    /// The reply is being synthesized + played.
    Speaking,
    /// The turn finished (reply spoken, or nothing to say) — back to idle.
    Finished,
    /// The pipeline failed (STT/converse/TTS) — surfaced in the status line.
    Error(String),
}

/// The mouse events the app acts on (P-018): the wheel, and the left button's
/// press, drag and release, which make a text selection. Mouse capture reports
/// every pointer move as well; forwarding those would wake the update loop on
/// each one for nothing.
pub fn mouse_event_wanted(m: &MouseEvent) -> bool {
    use crossterm::event::{MouseButton, MouseEventKind};
    matches!(
        m.kind,
        MouseEventKind::ScrollUp
            | MouseEventKind::ScrollDown
            | MouseEventKind::Down(MouseButton::Left)
            | MouseEventKind::Drag(MouseButton::Left)
            | MouseEventKind::Up(MouseButton::Left)
    )
}

/// Spawn the blocking input reader. Emits `Key` on input and `Tick` otherwise,
/// so the loop stays responsive without a busy-wait. Returns when the channel
/// receiver is dropped.
///
/// Press + Repeat forward as `Key` (so held nav keys still autorepeat and every
/// existing binding is untouched); Release forwards as `KeyRelease` (only ever
/// emitted when the kitty keyboard protocol is active — see main's enhancement
/// push — which drives hold-to-talk PTT). Without the protocol no Release events
/// arrive, so PTT falls back to press-to-toggle (voice-mode-tui-port D-007).
pub fn spawn_input_listener(tx: UnboundedSender<Event>) {
    use crossterm::event::KeyEventKind;
    std::thread::spawn(move || loop {
        match event::poll(Duration::from_millis(250)) {
            Ok(true) => {
                let ev = match event::read() {
                    Ok(CtEvent::Key(key)) => match key.kind {
                        KeyEventKind::Release => Some(Event::KeyRelease(key)),
                        // Press + Repeat → Key (preserves pre-enhancement behavior).
                        _ => Some(Event::Key(key)),
                    },
                    // Only arrives while bracketed paste is enabled (main pushes
                    // it alongside the alternate screen). Forwarded as DATA so a
                    // pasted newline can never be mistaken for a submit.
                    Ok(CtEvent::Paste(text)) => Some(Event::Paste(text)),
                    // Only arrives while focus-change reporting is enabled (main
                    // pushes it alongside bracketed paste). Releases every key
                    // we believe is held — see Event::FocusLost.
                    Ok(CtEvent::FocusLost) => Some(Event::FocusLost),
                    Ok(CtEvent::Resize(cols, rows)) => Some(Event::Resize(cols, rows)),
                    Ok(CtEvent::Mouse(m)) if mouse_event_wanted(&m) => Some(Event::Mouse(m)),
                    _ => None,
                };
                if let Some(ev) = ev {
                    if tx.send(ev).is_err() {
                        break;
                    }
                }
            }
            Ok(false) => {
                if tx.send(Event::Tick).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    });
}

#[cfg(test)]
mod tests {
    use super::mouse_event_wanted;
    use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

    fn at(kind: MouseEventKind) -> MouseEvent {
        MouseEvent {
            kind,
            column: 4,
            row: 2,
            modifiers: KeyModifiers::NONE,
        }
    }

    /// pui-chat-first-ux P-018: the wheel and the left button reach the app;
    /// pointer motion and the other buttons stay in the reader.
    #[test]
    fn only_the_wheel_and_the_left_button_are_forwarded() {
        for kind in [
            MouseEventKind::ScrollUp,
            MouseEventKind::ScrollDown,
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Drag(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            assert!(mouse_event_wanted(&at(kind)), "{kind:?} is dropped");
        }
        for kind in [
            MouseEventKind::Moved,
            MouseEventKind::Down(MouseButton::Right),
            MouseEventKind::Drag(MouseButton::Middle),
            MouseEventKind::ScrollLeft,
        ] {
            assert!(!mouse_event_wanted(&at(kind)), "{kind:?} is forwarded");
        }
    }
}
