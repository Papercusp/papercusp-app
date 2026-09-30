//! Typed client-side contract for the shared Papercusp SU-session host.
//!
//! The TUI deliberately consumes the backend-neutral `papercusp.su-session/v1`
//! wire contract instead of scraping provider terminals or inventing a second
//! conversation engine.  Identity, lifecycle, transcript, tool, card, and
//! refusal events are retained as typed values so the reducer can render the
//! same pane for Claude, Codex, and OMP.

use crate::models::NativeSessionHandle;
use crate::sse::SseFrame;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

pub const SU_SESSION_SCHEMA: &str = "papercusp.su-session/v1";
pub const SU_SESSION_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SuSessionBackend {
    Claude,
    Codex,
    Omp,
}

impl SuSessionBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Omp => "omp",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Omp => "OMP",
        }
    }
}

impl std::fmt::Display for SuSessionBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The backend an UNBOUND conversation opens on when the owner has not picked one.
///
/// Claude is the default because it is already the fallback every other unpicked
/// path in this file resolves to (the session-picker id parser twice), so the
/// cutover does not silently introduce a *second*, different default.
pub const PUI_DEFAULT_SU_BACKEND: SuSessionBackend = SuSessionBackend::Claude;

/// Which dispatch policy a persisted PUI conversation was CREATED under.
///
/// Mirrors `agent_chats_consolidated.su_runtime_class` (migration 1023).  This is
/// a statement about the conversation's permanent HOME, not about whether a
/// runtime is attached right now — that stays derived from the canonical snapshot
/// probe, so the two can never disagree about the same question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PuiRuntimeClass {
    /// Created after the cutover: the SU-session host is where its turns belong.
    SuSession,
    /// Created under the pre-cutover owned loop (or while the kill-switch was
    /// OFF).  Re-homing it onto an SU session would change an existing
    /// conversation's identity and backend, so the cutover deliberately does not.
    LegacyOwnedLoop,
    /// The row predates the stamp.  A THIRD answer, not a synonym for legacy: the
    /// PUI says so rather than guessing, because guessing "legacy" strands a
    /// post-cutover chat and guessing "su-session" re-homes a pre-cutover one.
    Unclassified,
}

impl PuiRuntimeClass {
    /// Parse the persisted stamp.  An unknown or absent value is `Unclassified`;
    /// it is never coerced into a plausible-looking policy.
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("su-session") => Self::SuSession,
            Some("legacy-owned-loop") => Self::LegacyOwnedLoop,
            _ => Self::Unclassified,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SuSession => "su-session",
            Self::LegacyOwnedLoop => "legacy-owned-loop",
            Self::Unclassified => "unclassified",
        }
    }
}

/// Where one PUI owner turn is dispatched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuDispatchTarget {
    /// Send into the SU session already attached to this conversation.
    AttachedSuSession,
    /// Open an SU session on the named backend and send the turn into it.
    OpenSuSession(SuSessionBackend),
    /// A legacy or unclassified conversation remains readable history but is no
    /// longer dispatchable now that the PUI-owned loop path is retired.
    ReadOnly,
}

/// WHY a turn went where it went.  P-011 requires the compatibility switch to be
/// OBSERVABLE and forbids a silent fallback to an untyped provider chat, so every
/// dispatch carries its reason and the PUI states it — a rollback is a disclosed
/// decision, not a quiet degradation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuDispatchReason {
    /// A live SU session is attached; the flag cannot strand it.
    AttachedSession,
    /// The owner picked a backend in the session picker.
    OwnerPickedBackend,
    /// Unbound conversation, cutover in force: the SU-session host is the default.
    CutoverDefault,
    /// A conversation recorded as SU-session-homed, whose session is not attached
    /// right now.  Re-opening its own runtime is the only answer that preserves
    /// its identity, so the kill-switch does not reach this case either — OFF is a
    /// rollback for NEW conversations, not a licence to move existing ones.
    HomedSuSession,
    /// A conversation created before the cutover is preserved as read-only
    /// history; it is never silently re-homed onto a new SU session.
    LegacyConversationReadOnly,
    /// The conversation's policy stamp is missing, so it remains explicitly
    /// unclassified and read-only rather than being guessed at.
    UnclassifiedConversationReadOnly,
}

impl SuDispatchReason {
    /// One line naming the runtime and the reason, for the status surface and the
    /// telemetry record.  Every variant says which runtime it chose: a reader must
    /// never have to infer the target from the reason.
    pub fn note(self) -> &'static str {
        match self {
            Self::AttachedSession => "SU session (attached)",
            Self::OwnerPickedBackend => "SU session (backend you picked)",
            Self::CutoverDefault => "SU session (default for a new conversation)",
            Self::HomedSuSession => "SU session (this conversation's recorded runtime)",
            Self::LegacyConversationReadOnly => {
                "read-only history — this conversation predates the SU-session default"
            }
            Self::UnclassifiedConversationReadOnly => {
                "read-only history — this conversation has no recorded runtime"
            }
        }
    }
}

/// One turn's routing decision: the target plus the reason it was taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SuDispatchDecision {
    pub target: SuDispatchTarget,
    pub reason: SuDispatchReason,
}

/// The state a dispatch decision reads.  Kept as a plain struct so the policy is
/// a pure function that tests can drive without an `App`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SuDispatchInputs {
    /// A LIVE SU session is attached to this conversation.
    pub attached: bool,
    /// The backend of a bound SU session whose runtime has ended or failed.
    /// Sending into it can never succeed, so the conversation reopens there.
    pub ended_backend: Option<SuSessionBackend>,
    /// The owner picked a backend in the session picker.
    pub picked_backend: Option<SuSessionBackend>,
    /// The persisted policy of the conversation currently loaded, if any is
    /// loaded at all.  `None` means no conversation is bound yet.
    pub loaded_class: Option<PuiRuntimeClass>,
    /// The operator's configured agent backend (`GET /api/agent-config`
    /// `effectiveBackend`), which is what the session-setup panel already
    /// defaults to. A conversation with no pick and no home of its own runs
    /// here (P-016), so a Codex or OMP user's bare `pui` is not silently
    /// Claude. `None` (not loaded yet, or unmapped) falls back to Claude.
    pub configured_backend: Option<SuSessionBackend>,
}

/// Decide where one owner turn goes.
///
/// The ordering preserves identity while making the PUI's runtime explicit.  An
/// attached session (1), an owner's explicit pick (2), and a conversation's own
/// recorded policy (3) decide every dispatch. Legacy/unclassified conversations
/// are intentionally read-only after the owned-loop path is retired.
pub fn decide_su_dispatch(inputs: SuDispatchInputs) -> SuDispatchDecision {
    // 1. A live attached session always wins. Redirecting a turn away from the
    //    runtime that is holding the conversation would lose it.
    if inputs.attached {
        return SuDispatchDecision {
            target: SuDispatchTarget::AttachedSuSession,
            reason: SuDispatchReason::AttachedSession,
        };
    }
    // 2. An explicit owner pick is an instruction, not a default to be overridden.
    if let Some(backend) = inputs.picked_backend {
        return SuDispatchDecision {
            target: SuDispatchTarget::OpenSuSession(backend),
            reason: SuDispatchReason::OwnerPickedBackend,
        };
    }
    // 2b. A bound session whose runtime died is no longer a place a turn can go
    //     (P-009 R-06): reopen this conversation on the backend it ran on, never
    //     the default, so a Codex conversation does not come back as Claude.
    if let Some(backend) = inputs.ended_backend {
        return SuDispatchDecision {
            target: SuDispatchTarget::OpenSuSession(backend),
            reason: SuDispatchReason::HomedSuSession,
        };
    }
    // 3. A loaded conversation carries its own home, and every branch here is
    //    ABOVE the flag: an existing conversation's runtime is not the switch's to
    //    change, in either direction.
    match inputs.loaded_class {
        Some(PuiRuntimeClass::SuSession) => {
            return SuDispatchDecision {
                target: SuDispatchTarget::OpenSuSession(
                    inputs
                        .picked_backend
                        .or(inputs.configured_backend)
                        .unwrap_or(PUI_DEFAULT_SU_BACKEND),
                ),
                reason: SuDispatchReason::HomedSuSession,
            };
        }
        Some(PuiRuntimeClass::LegacyOwnedLoop) => {
            return SuDispatchDecision {
                target: SuDispatchTarget::ReadOnly,
                reason: SuDispatchReason::LegacyConversationReadOnly,
            };
        }
        Some(PuiRuntimeClass::Unclassified) => {
            return SuDispatchDecision {
                target: SuDispatchTarget::ReadOnly,
                reason: SuDispatchReason::UnclassifiedConversationReadOnly,
            };
        }
        None => {}
    }
    // 4. No conversation is loaded at all: the corrected SU-session host is the
    //    unconditional default, on the operator's configured engine.
    SuDispatchDecision {
        target: SuDispatchTarget::OpenSuSession(
            inputs.configured_backend.unwrap_or(PUI_DEFAULT_SU_BACKEND),
        ),
        reason: SuDispatchReason::CutoverDefault,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SuSessionLifecycleState {
    #[default]
    Starting,
    Ready,
    Running,
    #[serde(rename = "waiting-for-owner")]
    WaitingForOwner,
    Interrupted,
    Compacting,
    Resuming,
    Ended,
    Failed,
}

/// How a PUI process reconciled a durable SU session with the runtime it found
/// after startup or reconnect.  This is intentionally separate from the
/// backend lifecycle: `ended` is a provider/runtime state while
/// `ended-archived` tells the owner why the session remains selectable in the
/// PUI session picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SuSessionReconciliation {
    Pending,
    Attached,
    /// The durable session's files were archived at death and are being replayed
    /// back out of `harness_shared.session_archives`.  Distinct from
    /// `EndedArchived`, which is the settled resting state once that replay has
    /// caught up: without the in-progress variant an owner reattaching to a large
    /// archived transcript sees an empty pane and cannot tell it from a hang.
    Rematerializing,
    RuntimeReplaced,
    EndedArchived,
    FailedOrphaned,
}

impl SuSessionReconciliation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Attached => "attached",
            Self::Rematerializing => "rematerializing",
            Self::RuntimeReplaced => "runtime-replaced",
            Self::EndedArchived => "ended-archived",
            Self::FailedOrphaned => "failed-orphaned",
        }
    }
}

/// The action half of the host's restart reconciliation
/// (`RuntimeReconciliation` in `su-session-persistence.ts`).  PUI consumes the
/// server's classification rather than re-deriving one from pids it cannot see.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SuSessionRuntimeAction {
    Reattach,
    Rematerialize,
    Relaunch,
    Wait,
}

impl SuSessionRuntimeAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reattach => "reattach",
            Self::Rematerialize => "rematerialize",
            Self::Relaunch => "relaunch",
            Self::Wait => "wait",
        }
    }
}

/// How the host reconciled this session's durable row against the runtime it
/// found after a restart.  `None` on the snapshot means the host was created
/// live at launch and never rehydrated — deliberately NOT the same as a clean
/// reattach, so PUI renders no reconciliation banner for it at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionRuntimeReconciliation {
    pub action: SuSessionRuntimeAction,
    pub reason: String,
    #[serde(default)]
    pub stale_pid: bool,
}

/// Replay progress while an archived transcript is rematerialised.  The bounds
/// come from the host snapshot's retained-event window, so this is a real
/// measured fraction rather than a spinner: `floor` is the oldest replayable
/// sequence, `last` the newest the host holds, `applied` how far this pane has
/// reduced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SuSessionRematerializeProgress {
    pub floor_sequence: u64,
    pub last_sequence: u64,
    pub applied_sequence: u64,
}

impl SuSessionRematerializeProgress {
    /// Events still to replay before the archived transcript is whole.
    pub fn remaining(self) -> u64 {
        self.last_sequence.saturating_sub(self.applied_sequence)
    }

    pub fn is_complete(self) -> bool {
        self.remaining() == 0
    }

    /// Replayed / total, as whole percent. A zero-width window (nothing retained
    /// to replay) is complete by definition rather than a divide-by-zero.
    pub fn percent(self) -> u8 {
        let total = self.last_sequence.saturating_sub(self.floor_sequence);
        if total == 0 {
            return 100;
        }
        let done = self
            .applied_sequence
            .saturating_sub(self.floor_sequence)
            .min(total);
        ((done.saturating_mul(100)) / total) as u8
    }
}

impl std::fmt::Display for SuSessionReconciliation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl SuSessionLifecycleState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Running => "running",
            Self::WaitingForOwner => "waiting-for-owner",
            Self::Interrupted => "interrupted",
            Self::Compacting => "compacting",
            Self::Resuming => "resuming",
            Self::Ended => "ended",
            Self::Failed => "failed",
        }
    }
}

impl std::fmt::Display for SuSessionLifecycleState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionIdentity {
    pub agent_chat_id: String,
    pub adv_session_id: i64,
    pub backend: SuSessionBackend,
    pub native_session_id: String,
    pub owner_id: String,
    pub workspace_id: String,
    pub harness_slug: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "backend", rename_all = "camelCase")]
pub enum SuSessionBackendExtension {
    Claude {
        #[serde(default)]
        #[serde(rename = "configDir")]
        config_dir: Option<String>,
        #[serde(default)]
        #[serde(rename = "configDirSource")]
        config_dir_source: Option<String>,
    },
    Codex {
        #[serde(default)]
        #[serde(rename = "codexHome")]
        codex_home: Option<String>,
    },
    Omp {
        #[serde(default)]
        #[serde(rename = "agentHome")]
        agent_home: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionCapabilitySupport {
    pub state: String,
    #[serde(default)]
    pub implementation: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SuSessionCapabilities {
    #[serde(default)]
    pub commands: std::collections::BTreeMap<String, SuSessionCapabilitySupport>,
    #[serde(default)]
    pub features: std::collections::BTreeMap<String, SuSessionCapabilitySupport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionDescriptor {
    pub identity: SuSessionIdentity,
    pub lifecycle: SuSessionLifecycleState,
    pub runtime_generation: u64,
    pub role: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub account_route: Option<String>,
    pub carry: String,
    #[serde(default)]
    pub modes: Vec<String>,
    pub capabilities: SuSessionCapabilities,
    pub backend_extension: SuSessionBackendExtension,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionSnapshot {
    #[serde(default)]
    pub ok: bool,
    pub descriptor: SuSessionDescriptor,
    pub floor_sequence: u64,
    pub last_sequence: u64,
    pub terminal: bool,
    #[serde(default)]
    pub executor_attached: bool,
    #[serde(default)]
    pub stream_ready: bool,
    /// Absent on a host that was never rehydrated; see
    /// [`SuSessionRuntimeReconciliation`].
    #[serde(default)]
    pub runtime_reconciliation: Option<SuSessionRuntimeReconciliation>,
    /// The directory this session was launched in (`adv_sessions.cwd`).
    /// `None` = not recorded or an older operator — unknown, never "matches".
    /// pui-chat-first-ux P-010 scopes `/resume` and startup reattach with it.
    #[serde(default)]
    pub launch_cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SuSessionCreateRequest {
    pub agent: SuSessionBackend,
    pub harness_slug: Option<String>,
    pub plan_slug: Option<String>,
    pub fleet: Option<String>,
    pub seat: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub account: Option<String>,
    pub mode: Option<String>,
    pub kickoff: Option<SuSessionKickoff>,
    pub kickoff_prompt: Option<String>,
    pub carry: String,
    pub attached_engine: bool,
    pub agent_chat_id: String,
    /// The directory `pui` was started in. The operator runs the session there
    /// when it can see that directory (Claude Code / Codex parity), and keeps
    /// the project checkout otherwise — e.g. a remote operator.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// The launch directory to send with a new session, if it can be named.
pub fn launch_cwd() -> Option<String> {
    std::env::current_dir()
        .ok()
        .and_then(|dir| dir.to_str().map(str::to_owned))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SuSessionKickoff {
    pub kind: String,
}

/// PUI's client-side selection state for a fresh SU session. Every field maps
/// onto the existing launch-su/agent-chat seams; this is not a second launcher.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SuSessionLaunchOptions {
    pub plan_slug: Option<String>,
    pub feature_id: Option<String>,
    pub fleet: Option<String>,
    pub seat: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub account: Option<String>,
    pub mode: Option<String>,
    pub kickoff: Option<SuSessionKickoff>,
    pub kickoff_prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SuSessionAttachRequest {
    pub agent: SuSessionBackend,
    pub attach_adv_session_id: i64,
    pub harness_slug: Option<String>,
    pub plan_slug: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[expect(
    clippy::large_enum_variant,
    reason = "Create carries the stable SU-session launch request; boxing it would churn the wire-adjacent client API"
)]
pub enum SuSessionOpenRequest {
    Create(SuSessionCreateRequest),
    Attach(SuSessionAttachRequest),
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionBinding {
    pub operation: String,
    pub backend: SuSessionBackend,
    pub adv_session_id: i64,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub harness_slug: Option<String>,
    #[serde(default)]
    pub plan_slug: Option<String>,
    #[serde(default)]
    pub native_session: Option<NativeSessionHandle>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SuSessionState {
    pub binding: SuSessionBinding,
    pub identity: Option<SuSessionIdentity>,
    pub descriptor: Option<SuSessionDescriptor>,
    pub lifecycle: SuSessionLifecycleState,
    pub last_sequence: u64,
    /// Head sequence of the newest applied snapshot. Events at or below it are
    /// the retained window being replayed: history the snapshot already
    /// reflects. They render, but they cannot fail a turn sent after the
    /// snapshot — a reconnect after an engine death replays that death.
    pub replay_head: u64,
    pub stale: bool,
    pub error: Option<String>,
    /// Startup/reconnect outcome surfaced beside the lifecycle in the PUI.
    pub reconciliation: SuSessionReconciliation,
    /// Present only while an archived transcript is being replayed back; cleared
    /// once the replay catches up so a stale bar can never outlive its own work.
    pub rematerialize: Option<SuSessionRematerializeProgress>,
}

impl SuSessionState {
    pub fn from_binding(binding: SuSessionBinding) -> Self {
        Self {
            lifecycle: SuSessionLifecycleState::Starting,
            binding,
            identity: None,
            descriptor: None,
            last_sequence: 0,
            replay_head: 0,
            stale: false,
            error: None,
            reconciliation: SuSessionReconciliation::Pending,
            rematerialize: None,
        }
    }

    /// Whether this bound session's runtime can still take a turn. A failed or
    /// ended runtime, or one the host reconciled as orphaned/archived, cannot.
    pub fn is_live(&self) -> bool {
        !matches!(
            self.lifecycle,
            SuSessionLifecycleState::Ended | SuSessionLifecycleState::Failed
        ) && !matches!(
            self.reconciliation,
            SuSessionReconciliation::FailedOrphaned | SuSessionReconciliation::EndedArchived
        )
    }

    /// The backend this session runs on, preferring the host's own identity.
    pub fn backend(&self) -> SuSessionBackend {
        self.identity
            .as_ref()
            .map(|identity| identity.backend)
            .unwrap_or(self.binding.backend)
    }

    pub fn selection_label(&self) -> String {
        let identity = self.identity.as_ref();
        let backend = identity
            .map(|i| i.backend.as_str())
            .unwrap_or_else(|| self.binding.backend.as_str());
        let adv = identity
            .map(|i| i.adv_session_id)
            .unwrap_or(self.binding.adv_session_id);
        let chat = identity.map(|i| i.agent_chat_id.as_str()).unwrap_or("");
        let short_chat: String = chat.chars().take(12).collect();
        format!(
            "SU · {backend} · adv {adv} · chat {short_chat} · {}",
            self.lifecycle
        )
    }
}

/// A bounded inventory row used by the session picker.  Inventory is derived
/// from the canonical per-chat SU-session snapshot; ended rows remain present
/// so their transcript can be inspected after the runtime is gone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuSessionInventoryEntry {
    pub agent_chat_id: String,
    pub adv_session_id: i64,
    pub backend: SuSessionBackend,
    pub lifecycle: SuSessionLifecycleState,
    pub runtime_generation: u64,
    pub native_session_id: String,
    pub terminal: bool,
    pub reconciliation: SuSessionReconciliation,
    /// The directory the session was launched in; `None` = unknown.
    pub cwd: Option<String>,
}

/// Whether a session launched in `session_cwd` belongs to a PUI started in
/// `launch_cwd` (pui-chat-first-ux P-010). Like Claude Code and Codex, a
/// conversation belongs to the directory it was started in. An unknown PUI
/// directory matches everything (nothing to scope by); an unknown session
/// directory matches nothing when the PUI directory is known.
pub fn session_in_directory(session_cwd: Option<&str>, launch_cwd: Option<&str>) -> bool {
    match (launch_cwd, session_cwd) {
        (None, _) => true,
        (Some(launch), Some(session)) => {
            launch.trim_end_matches('/') == session.trim_end_matches('/')
        }
        (Some(_), None) => false,
    }
}

/// The title a new conversation is saved under: the owner's first message,
/// the way Claude Code and Codex label their resume lists. The first non-empty
/// line, whitespace collapsed, capped at `CONVERSATION_TITLE_MAX` characters.
/// A conversation opened with no message yet is "New conversation" — never a
/// backend/runtime label like "Claude SU session" (P-005 review, P-007).
pub const CONVERSATION_TITLE_MAX: usize = 60;
pub fn conversation_title(first_message: Option<&str>) -> String {
    let line = first_message
        .and_then(|text| text.lines().map(str::trim).find(|line| !line.is_empty()))
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    if line.is_empty() {
        return "New conversation".to_string();
    }
    if line.chars().count() <= CONVERSATION_TITLE_MAX {
        return line;
    }
    let cut: String = line.chars().take(CONVERSATION_TITLE_MAX - 1).collect();
    format!("{}…", cut.trim_end())
}

impl SuSessionInventoryEntry {
    pub fn from_snapshot(snapshot: &SuSessionSnapshot) -> Self {
        let lifecycle = snapshot.descriptor.lifecycle;
        // The inventory row must reach the SAME verdict as the pane reducer.
        // Adoption keys off `reconciliation == Attached && !terminal`, so a row
        // that ignored the host's non-attachable verdicts would offer a
        // `relaunch`/`wait` session for adoption and attach a pane to a runtime
        // the host has already said is not there — the duplicate/phantom pane
        // P-010 exists to prevent.
        let runtime_action = snapshot
            .runtime_reconciliation
            .as_ref()
            .map(|reconciliation| reconciliation.action);
        let reconciliation = if lifecycle == SuSessionLifecycleState::Failed
            || runtime_action == Some(SuSessionRuntimeAction::Relaunch)
        {
            SuSessionReconciliation::FailedOrphaned
        } else if runtime_action == Some(SuSessionRuntimeAction::Wait) {
            SuSessionReconciliation::Pending
        } else if lifecycle == SuSessionLifecycleState::Ended || snapshot.terminal {
            SuSessionReconciliation::EndedArchived
        } else {
            SuSessionReconciliation::Attached
        };
        Self {
            agent_chat_id: snapshot.descriptor.identity.agent_chat_id.clone(),
            adv_session_id: snapshot.descriptor.identity.adv_session_id,
            backend: snapshot.descriptor.identity.backend,
            lifecycle,
            runtime_generation: snapshot.descriptor.runtime_generation,
            native_session_id: snapshot.descriptor.identity.native_session_id.clone(),
            terminal: snapshot.terminal,
            reconciliation,
            cwd: snapshot.launch_cwd.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionRefusal {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// Owner-facing controls exposed by P-009.  The common command envelope is
/// built here so every control targets the exact durable identity selected by
/// the reducer; callers cannot accidentally substitute a chat id or provider
/// default from another session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SuSessionControl {
    Interrupt { reason: Option<String> },
    Resume { cause: String },
    Fork { from_sequence: Option<u64> },
    Focus,
    End { reason: Option<String> },
}

impl SuSessionControl {
    pub fn command_type(&self) -> &'static str {
        match self {
            Self::Interrupt { .. } => "interrupt",
            Self::Resume { .. } => "resume",
            Self::Fork { .. } => "fork",
            Self::Focus => "focus",
            Self::End { .. } => "end",
        }
    }

    pub fn command_json(
        &self,
        identity: &SuSessionIdentity,
        command_id: &str,
        issued_at: &str,
    ) -> Value {
        let mut body = serde_json::json!({
            "schema": SU_SESSION_SCHEMA,
            "protocolVersion": SU_SESSION_PROTOCOL_VERSION,
            "type": self.command_type(),
            "commandId": command_id,
            "issuedAt": issued_at,
            "target": identity,
        });
        match self {
            Self::Interrupt { reason } | Self::End { reason } => {
                if let Some(reason) = reason {
                    body["reason"] = Value::String(reason.clone());
                }
            }
            Self::Resume { cause } => body["cause"] = Value::String(cause.clone()),
            Self::Fork { from_sequence } => {
                if let Some(sequence) = from_sequence {
                    body["fromSequence"] = serde_json::json!(sequence);
                }
            }
            Self::Focus => {}
        }
        body
    }
}

/// The reason a closing client stamps on its `end` command.
pub const CLIENT_EXIT_REASON: &str = "client exited";

/// What a closing client does to its session's engine (pui-chat-first-ux
/// P-009). Quitting ends it, the way Claude Code and Codex end with their
/// process; `/detach` asks the host to keep it running instead. A client that
/// dies without doing either (SIGKILL, a crash) is covered by the host's
/// attendance lease, which ends the engine once no client has renewed it.
#[derive(Debug, Clone, PartialEq)]
pub enum SuSessionExit {
    End {
        harness: String,
        chat_id: String,
        command: Value,
    },
    Detach {
        harness: String,
        chat_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionEventEnvelope {
    pub schema: String,
    pub protocol_version: u32,
    pub event_id: String,
    pub sequence: u64,
    pub at: String,
    pub session: SuSessionIdentity,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SuSessionEvent {
    Session {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        // Boxed to keep the enum small: an inline descriptor made this variant
        // ~592 bytes against a ~385-byte next-largest, so every SuSessionEvent
        // (including the far more frequent Lifecycle/Tool ones) paid that cost.
        descriptor: Box<SuSessionDescriptor>,
    },
    Lifecycle {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        #[serde(rename = "previousState")]
        previous_state: Option<SuSessionLifecycleState>,
        state: SuSessionLifecycleState,
        #[serde(rename = "runtimeGeneration")]
        runtime_generation: u64,
        #[serde(default)]
        reason: Option<String>,
    },
    CommandResult {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "commandType")]
        command_type: String,
        status: String,
        #[serde(default)]
        refusal: Option<SuSessionRefusal>,
    },
    Transcript {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        phase: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        role: String,
        channel: String,
        #[serde(default)]
        content: Option<String>,
    },
    Tool {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        phase: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        #[serde(default)]
        input: Option<Value>,
        #[serde(default)]
        output: Option<Value>,
        #[serde(default)]
        #[serde(rename = "isError")]
        is_error: bool,
    },
    Card {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        phase: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        #[serde(default)]
        card: Option<Value>,
        #[serde(default)]
        #[serde(rename = "correlationId")]
        correlation_id: Option<String>,
        #[serde(default)]
        resolution: Option<String>,
    },
    Backend {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        extension: SuSessionBackendExtension,
    },
    Error {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        scope: String,
        code: String,
        message: String,
        recoverable: bool,
        #[serde(default)]
        #[serde(rename = "commandId")]
        command_id: Option<String>,
        #[serde(default)]
        details: Option<Value>,
    },
}

impl SuSessionEvent {
    pub fn envelope(&self) -> &SuSessionEventEnvelope {
        match self {
            Self::Session { envelope, .. }
            | Self::Lifecycle { envelope, .. }
            | Self::CommandResult { envelope, .. }
            | Self::Transcript { envelope, .. }
            | Self::Tool { envelope, .. }
            | Self::Card { envelope, .. }
            | Self::Backend { envelope, .. }
            | Self::Error { envelope, .. } => envelope,
        }
    }
}

/// Decode one `session_event` SSE frame.  A mismatched schema/protocol is a
/// visible error; silently accepting it would make a restarted PUI render a
/// different contract as though it were the same durable session.
pub fn decode_su_session_event(frame: &SseFrame) -> Result<SuSessionEvent> {
    if frame.event != "session_event" && frame.event != "message" {
        bail!("unsupported SU-session SSE event `{}`", frame.event);
    }
    let event: SuSessionEvent =
        serde_json::from_str(&frame.data).with_context(|| "decode SU-session SSE payload")?;
    let envelope = event.envelope();
    if envelope.schema != SU_SESSION_SCHEMA {
        return Err(anyhow!(
            "unsupported SU-session schema `{}` (expected `{SU_SESSION_SCHEMA}`)",
            envelope.schema
        ));
    }
    if envelope.protocol_version != SU_SESSION_PROTOCOL_VERSION {
        return Err(anyhow!(
            "unsupported SU-session protocol {} (expected {})",
            envelope.protocol_version,
            SU_SESSION_PROTOCOL_VERSION
        ));
    }
    Ok(event)
}

pub type SuSessionEventStream = mpsc::UnboundedReceiver<Result<SuSessionEvent>>;

pub fn decode_su_session_stream(
    mut frames: mpsc::UnboundedReceiver<SseFrame>,
) -> SuSessionEventStream {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(frame) = frames.recv().await {
            // The shared SSE transport sends an initial heartbeat before its
            // replay, plus periodic keepalives. These carry no session event.
            if frame.event == "heartbeat" {
                continue;
            }
            if tx.send(decode_su_session_event(&frame)).is_err() {
                return;
            }
        }
        let _ = tx.send(Err(anyhow!("SU-session SSE stream closed")));
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope(kind: &str, extra: Value) -> SseFrame {
        let mut value = json!({
            "type": kind,
            "schema": SU_SESSION_SCHEMA,
            "protocolVersion": 1,
            "eventId": "chat-1:1",
            "sequence": 1,
            "at": "2026-08-28T00:00:00Z",
            "session": {
                "agentChatId": "chat-1", "advSessionId": 7, "backend": "claude",
                "nativeSessionId": "native-1", "ownerId": "su-1", "workspaceId": "ws-1",
                "harnessSlug": "papercup"
            }
        });
        if let (Some(dst), Some(src)) = (value.as_object_mut(), extra.as_object()) {
            dst.extend(src.clone());
        }
        SseFrame {
            event: "session_event".into(),
            data: value.to_string(),
        }
    }

    #[test]
    fn decodes_lifecycle_transcript_tool_and_refusal_events() {
        let lifecycle = decode_su_session_event(&envelope(
            "lifecycle",
            json!({
                "previousState": "starting", "state": "ready", "runtimeGeneration": 2
            }),
        ))
        .unwrap();
        assert!(matches!(
            lifecycle,
            SuSessionEvent::Lifecycle {
                state: SuSessionLifecycleState::Ready,
                ..
            }
        ));

        let transcript = decode_su_session_event(&envelope("transcript", json!({
            "phase": "delta", "turnId": "turn-1", "role": "assistant", "channel": "text", "content": "hello"
        }))).unwrap();
        assert!(
            matches!(transcript, SuSessionEvent::Transcript { content: Some(ref c), .. } if c == "hello")
        );

        let tool = decode_su_session_event(&envelope("tool", json!({
            "phase": "completed", "turnId": "turn-1", "callId": "call-1", "name": "read", "output": {"ok": true}, "isError": false
        }))).unwrap();
        assert!(matches!(tool, SuSessionEvent::Tool { ref call_id, .. } if call_id == "call-1"));

        let refusal = decode_su_session_event(&envelope(
            "command_result",
            json!({
                "commandId": "cmd-1", "commandType": "fork", "status": "refused",
                "refusal": {"code": "unsupported", "message": "not available", "retryable": false}
            }),
        ))
        .unwrap();
        assert!(matches!(
            refusal,
            SuSessionEvent::CommandResult {
                refusal: Some(_),
                ..
            }
        ));
    }

    #[tokio::test]
    async fn su_stream_keepalives_do_not_hide_replay_or_protocol_errors() {
        let (tx, frames) = mpsc::unbounded_channel();
        let mut events = decode_su_session_stream(frames);
        tx.send(SseFrame {
            event: "heartbeat".into(),
            data: "{\"tsMs\":1}".into(),
        })
        .unwrap();
        tx.send(envelope(
            "lifecycle",
            json!({"state":"ready", "runtimeGeneration":1}),
        ))
        .unwrap();
        tx.send(SseFrame {
            event: "heartbeat".into(),
            data: "{\"tsMs\":2}".into(),
        })
        .unwrap();
        let mut bad = envelope("lifecycle", json!({"state":"ready", "runtimeGeneration":1}));
        let mut payload: Value = serde_json::from_str(&bad.data).unwrap();
        payload["protocolVersion"] = json!(999);
        bad.data = payload.to_string();
        tx.send(bad).unwrap();
        drop(tx);
        assert!(matches!(
            events.recv().await.unwrap().unwrap(),
            SuSessionEvent::Lifecycle {
                state: SuSessionLifecycleState::Ready,
                ..
            }
        ));
        assert!(
            events.recv().await.unwrap().is_err(),
            "unknown protocol remains an error"
        );
        assert!(events
            .recv()
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("stream closed"));
    }

    #[test]
    fn rejects_schema_drift_instead_of_silently_rendering() {
        let mut frame = envelope(
            "lifecycle",
            json!({
                "previousState": null, "state": "starting", "runtimeGeneration": 0
            }),
        );
        frame.data = frame.data.replace(SU_SESSION_SCHEMA, "other/v9");
        let error = decode_su_session_event(&frame).unwrap_err().to_string();
        assert!(error.contains("unsupported SU-session schema"));
    }

    #[test]
    fn backend_and_lifecycle_labels_are_stable() {
        assert_eq!(
            [
                SuSessionBackend::Claude.as_str(),
                SuSessionBackend::Codex.as_str(),
                SuSessionBackend::Omp.as_str(),
            ],
            ["claude", "codex", "omp"]
        );
        assert_eq!(
            SuSessionLifecycleState::WaitingForOwner.to_string(),
            "waiting-for-owner"
        );
    }

    #[test]
    fn decodes_snapshot_with_backend_extension_and_capabilities() {
        let snapshot: SuSessionSnapshot = serde_json::from_value(json!({
            "ok": true,
            "descriptor": {
                "identity": {
                    "agentChatId":"chat-1", "advSessionId":7, "backend":"codex",
                    "nativeSessionId":"rollout-1", "ownerId":"su-1", "workspaceId":"ws-1", "harnessSlug":"papercup"
                },
                "lifecycle":"waiting-for-owner", "runtimeGeneration":2, "role":"su",
                "model":"gpt-5.5", "accountRoute":"auto", "carry":"warm", "modes":["auto"],
                "capabilities": {
                    "commands": {"owner_turn": {"state":"supported", "implementation":"native"}, "fork":{"state":"unsupported", "reason":"provider"}},
                    "features": {"tool-events": {"state":"supported", "implementation":"native"}}
                },
                "backendExtension": {"backend":"codex", "codexHome":"/tmp/codex"}
            },
            "floorSequence":1, "lastSequence":4, "terminal":false
        })).expect("decode snapshot");
        assert_eq!(
            snapshot.descriptor.identity.backend,
            SuSessionBackend::Codex
        );
        assert_eq!(
            snapshot.descriptor.lifecycle,
            SuSessionLifecycleState::WaitingForOwner
        );
        assert!(
            matches!(snapshot.descriptor.backend_extension, SuSessionBackendExtension::Codex { codex_home: Some(ref home) } if home == "/tmp/codex")
        );
        assert_eq!(snapshot.last_sequence, 4);
        // An operator that predates launchCwd leaves the directory unknown.
        assert_eq!(snapshot.launch_cwd, None);
        assert_eq!(SuSessionInventoryEntry::from_snapshot(&snapshot).cwd, None);
    }

    /// pui-chat-first-ux P-010: the snapshot names the session's launch
    /// directory and the inventory row carries it for /resume scoping.
    #[test]
    fn snapshot_launch_cwd_reaches_the_inventory_row() {
        let snapshot: SuSessionSnapshot = serde_json::from_value(json!({
            "ok": true,
            "descriptor": {
                "identity": {
                    "agentChatId":"chat-1", "advSessionId":7, "backend":"claude",
                    "nativeSessionId":"native-1", "ownerId":"su-1", "workspaceId":"ws-1", "harnessSlug":"papercup"
                },
                "lifecycle":"ended", "runtimeGeneration":1, "role":"su", "carry":"warm", "modes":[],
                "capabilities": {"commands":{}, "features":{}},
                "backendExtension": {"backend":"claude", "configDir":null, "configDirSource":null}
            },
            "floorSequence":1, "lastSequence":1, "terminal":true,
            "launchCwd": "/work/app"
        }))
        .expect("decode snapshot");
        assert_eq!(snapshot.launch_cwd.as_deref(), Some("/work/app"));
        assert_eq!(
            SuSessionInventoryEntry::from_snapshot(&snapshot)
                .cwd
                .as_deref(),
            Some("/work/app")
        );
    }

    #[test]
    fn conversation_title_is_the_first_message_not_a_runtime_label() {
        assert_eq!(conversation_title(Some("hi")), "hi");
        assert_eq!(
            conversation_title(Some("\n  Fix   the\tbuild  \nsecond line")),
            "Fix the build"
        );
        assert_eq!(conversation_title(None), "New conversation");
        assert_eq!(conversation_title(Some("  \n \n")), "New conversation");
        let long = "word ".repeat(40);
        let title = conversation_title(Some(&long));
        assert!(title.ends_with('…'), "{title}");
        assert!(title.chars().count() <= CONVERSATION_TITLE_MAX, "{title}");
        // Multi-byte text is cut on a character boundary, not a byte offset.
        let wide = "é".repeat(100);
        assert_eq!(
            conversation_title(Some(&wide)).chars().count(),
            CONVERSATION_TITLE_MAX
        );
        for backend in ["Claude", "Codex", "OMP"] {
            assert!(!conversation_title(None).contains(backend));
        }
    }

    #[test]
    fn session_in_directory_matches_only_the_same_directory() {
        assert!(session_in_directory(Some("/work/app"), Some("/work/app")));
        assert!(session_in_directory(Some("/work/app/"), Some("/work/app")));
        assert!(!session_in_directory(
            Some("/work/app-2"),
            Some("/work/app")
        ));
        assert!(!session_in_directory(Some("/work"), Some("/work/app")));
        assert!(!session_in_directory(None, Some("/work/app")));
        assert!(session_in_directory(None, None));
        assert!(session_in_directory(Some("/work/app"), None));
    }

    #[test]
    fn create_and_attach_requests_match_launch_su_wire_names() {
        let create = serde_json::to_value(SuSessionCreateRequest {
            agent: SuSessionBackend::Omp,
            harness_slug: Some("papercup".into()),
            plan_slug: Some("plan-a".into()),
            fleet: Some("fed-drill".into()),
            seat: Some("sonnet:high:auto".into()),
            model: Some("gpt-5.6-sol".into()),
            effort: Some("high".into()),
            account: Some("auto".into()),
            mode: Some("auto".into()),
            kickoff: Some(SuSessionKickoff {
                kind: "new-plan".into(),
            }),
            kickoff_prompt: Some("Start the selected plan.".into()),
            carry: "warm".into(),
            attached_engine: true,
            agent_chat_id: "chat-1".into(),
            cwd: Some("/work/app".into()),
        })
        .unwrap();
        assert_eq!(create["cwd"], "/work/app");
        assert_eq!(create["agent"], "omp");
        assert_eq!(create["harness_slug"], "papercup");
        assert_eq!(create["plan_slug"], "plan-a");
        assert_eq!(create["fleet"], "fed-drill");
        assert_eq!(create["seat"], "sonnet:high:auto");
        assert_eq!(create["model"], "gpt-5.6-sol");
        assert_eq!(create["effort"], "high");
        assert_eq!(create["account"], "auto");
        assert_eq!(create["mode"], "auto");
        assert_eq!(create["kickoff"]["kind"], "new-plan");
        assert_eq!(create["kickoff_prompt"], "Start the selected plan.");
        assert_eq!(create["attached_engine"], true);
        assert!(create.get("defer_spawn").is_none());
        assert_eq!(create["agent_chat_id"], "chat-1");
        assert!(create.get("harnessSlug").is_none());

        let attach = serde_json::to_value(SuSessionAttachRequest {
            agent: SuSessionBackend::Claude,
            attach_adv_session_id: 42,
            harness_slug: None,
            plan_slug: None,
        })
        .unwrap();
        assert_eq!(attach["attach_adv_session_id"], 42);
        assert!(attach.get("attachAdvSessionId").is_none());
    }

    #[test]
    fn controls_preserve_target_identity_and_explicit_refusal_shape() {
        let identity: SuSessionIdentity = serde_json::from_value(json!({
            "agentChatId":"chat-1", "advSessionId":7, "backend":"omp",
            "nativeSessionId":"thread-1", "ownerId":"su-1", "workspaceId":"ws-1", "harnessSlug":"papercup"
        })).unwrap();
        let command = SuSessionControl::Resume {
            cause: "pui-restart".into(),
        }
        .command_json(&identity, "cmd-1", "2026-08-28T00:00:00Z");
        assert_eq!(command["type"], "resume");
        assert_eq!(command["cause"], "pui-restart");
        assert_eq!(command["target"]["advSessionId"], 7);
        assert_eq!(command["target"]["backend"], "omp");

        let fork = SuSessionControl::Fork {
            from_sequence: Some(12),
        }
        .command_json(&identity, "cmd-2", "2026-08-28T00:00:00Z");
        assert_eq!(fork["fromSequence"], 12);
        assert_eq!(SuSessionControl::End { reason: None }.command_type(), "end");
    }
}

/// P-011 cutover policy (pui-su-session-runtime-correction-2026-08-27).
///
/// These cover the corrected SU-session default, explicit read-only treatment of
/// legacy history, dispatch telemetry, and the persisted migration stamp.
#[cfg(test)]
mod cutover_policy_tests {
    use super::*;

    /// No conversation loaded and no backend picked.
    fn unbound() -> SuDispatchInputs {
        SuDispatchInputs {
            attached: false,
            ended_backend: None,
            picked_backend: None,
            loaded_class: None,
            configured_backend: None,
        }
    }

    #[test]
    fn a_new_conversation_runs_on_the_configured_backend_below_every_explicit_choice() {
        // No pick, nothing loaded: the configured engine, not Claude (P-016).
        let d = decide_su_dispatch(SuDispatchInputs {
            configured_backend: Some(SuSessionBackend::Codex),
            ..unbound()
        });
        assert_eq!(
            d.target,
            SuDispatchTarget::OpenSuSession(SuSessionBackend::Codex)
        );
        assert_eq!(d.reason, SuDispatchReason::CutoverDefault);
        // A loaded SU conversation with no bound session also defaults there.
        let d = decide_su_dispatch(SuDispatchInputs {
            configured_backend: Some(SuSessionBackend::Omp),
            loaded_class: Some(PuiRuntimeClass::SuSession),
            ..unbound()
        });
        assert_eq!(d.target, SuDispatchTarget::OpenSuSession(SuSessionBackend::Omp));
        // An owner's pick and a conversation's own ended backend both outrank it.
        let d = decide_su_dispatch(SuDispatchInputs {
            configured_backend: Some(SuSessionBackend::Codex),
            picked_backend: Some(SuSessionBackend::Claude),
            ..unbound()
        });
        assert_eq!(
            d.target,
            SuDispatchTarget::OpenSuSession(SuSessionBackend::Claude)
        );
        let d = decide_su_dispatch(SuDispatchInputs {
            configured_backend: Some(SuSessionBackend::Codex),
            ended_backend: Some(SuSessionBackend::Omp),
            loaded_class: Some(PuiRuntimeClass::SuSession),
            ..unbound()
        });
        assert_eq!(d.target, SuDispatchTarget::OpenSuSession(SuSessionBackend::Omp));
        // Unknown configuration keeps the historical default.
        assert_eq!(
            decide_su_dispatch(unbound()).target,
            SuDispatchTarget::OpenSuSession(PUI_DEFAULT_SU_BACKEND)
        );
    }

    #[test]
    fn an_ended_session_reopens_the_conversation_on_its_own_backend() {
        let d = decide_su_dispatch(SuDispatchInputs {
            ended_backend: Some(SuSessionBackend::Codex),
            loaded_class: Some(PuiRuntimeClass::SuSession),
            ..unbound()
        });
        assert_eq!(
            d.target,
            SuDispatchTarget::OpenSuSession(SuSessionBackend::Codex)
        );
        assert_eq!(d.reason, SuDispatchReason::HomedSuSession);
        // An explicit owner pick still outranks it.
        let d = decide_su_dispatch(SuDispatchInputs {
            ended_backend: Some(SuSessionBackend::Codex),
            picked_backend: Some(SuSessionBackend::Claude),
            ..unbound()
        });
        assert_eq!(
            d.target,
            SuDispatchTarget::OpenSuSession(SuSessionBackend::Claude)
        );
    }

    // ── config default ──────────────────────────────────────────────────────

    #[test]
    fn a_new_conversation_defaults_to_the_su_session_host() {
        let d = decide_su_dispatch(unbound());
        assert_eq!(
            d.target,
            SuDispatchTarget::OpenSuSession(PUI_DEFAULT_SU_BACKEND)
        );
        assert_eq!(d.reason, SuDispatchReason::CutoverDefault);
    }

    #[test]
    fn the_default_backend_matches_the_pickers_own_fallback() {
        // The picker's id parser resolves an unrecognised/absent backend to
        // Claude in two places. If the cutover default ever diverges from it, the
        // PUI would have TWO different unpicked defaults and which one you got
        // would depend on whether you opened the picker first.
        assert_eq!(PUI_DEFAULT_SU_BACKEND, SuSessionBackend::Claude);
    }

    #[test]
    fn an_attached_session_always_wins() {
        let d = decide_su_dispatch(SuDispatchInputs {
            attached: true,
            ..unbound()
        });
        assert_eq!(d.target, SuDispatchTarget::AttachedSuSession);
        assert_eq!(d.reason, SuDispatchReason::AttachedSession);
    }

    #[test]
    fn an_su_homed_conversation_reopens_on_the_su_host() {
        let d = decide_su_dispatch(SuDispatchInputs {
            loaded_class: Some(PuiRuntimeClass::SuSession),
            ..unbound()
        });
        assert_eq!(
            d.target,
            SuDispatchTarget::OpenSuSession(PUI_DEFAULT_SU_BACKEND)
        );
        assert_eq!(d.reason, SuDispatchReason::HomedSuSession);
    }

    #[test]
    fn an_explicit_owner_pick_selects_that_su_backend() {
        let d = decide_su_dispatch(SuDispatchInputs {
            picked_backend: Some(SuSessionBackend::Codex),
            ..unbound()
        });
        assert_eq!(
            d.target,
            SuDispatchTarget::OpenSuSession(SuSessionBackend::Codex)
        );
        assert_eq!(d.reason, SuDispatchReason::OwnerPickedBackend);
    }

    // ── migration stamp: no conversation is silently re-homed ────────────────

    #[test]
    fn parses_the_persisted_stamp_and_treats_anything_else_as_unclassified() {
        assert_eq!(
            PuiRuntimeClass::parse(Some("su-session")),
            PuiRuntimeClass::SuSession
        );
        assert_eq!(
            PuiRuntimeClass::parse(Some("legacy-owned-loop")),
            PuiRuntimeClass::LegacyOwnedLoop
        );
        // Absent, empty, and unknown all mean UNCLASSIFIED — never a plausible
        // guess at a policy.
        for raw in [None, Some(""), Some("   "), Some("owned-loop"), Some("su")] {
            assert_eq!(
                PuiRuntimeClass::parse(raw),
                PuiRuntimeClass::Unclassified,
                "{raw:?} must not resolve to a policy"
            );
        }
    }

    #[test]
    fn the_rust_labels_round_trip_through_the_persisted_values() {
        // `as_str` is what a reader/logger renders and `parse` is what reads the
        // column; if they ever disagree, a correctly-stamped row starts reading
        // as UNCLASSIFIED and every classified conversation quietly loses its
        // recorded home. Round-tripping pins them to each other.
        for class in [PuiRuntimeClass::SuSession, PuiRuntimeClass::LegacyOwnedLoop] {
            assert_eq!(PuiRuntimeClass::parse(Some(class.as_str())), class);
        }
        // The migration's CHECK constraint admits exactly these two strings, so
        // they are pinned literally rather than only to each other.
        assert_eq!(PuiRuntimeClass::SuSession.as_str(), "su-session");
        assert_eq!(
            PuiRuntimeClass::LegacyOwnedLoop.as_str(),
            "legacy-owned-loop"
        );
        // `Unclassified` is a reading, not a storable value: it must never
        // round-trip into a policy.
        assert_eq!(
            PuiRuntimeClass::parse(Some(PuiRuntimeClass::Unclassified.as_str())),
            PuiRuntimeClass::Unclassified
        );
    }

    #[test]
    fn a_pre_cutover_conversation_is_never_re_homed_even_with_the_cutover_on() {
        let d = decide_su_dispatch(SuDispatchInputs {
            loaded_class: Some(PuiRuntimeClass::LegacyOwnedLoop),
            ..unbound()
        });
        assert_eq!(d.target, SuDispatchTarget::ReadOnly);
        assert_eq!(d.reason, SuDispatchReason::LegacyConversationReadOnly);
    }

    #[test]
    fn an_unclassified_conversation_is_held_not_guessed_at() {
        let d = decide_su_dispatch(SuDispatchInputs {
            loaded_class: Some(PuiRuntimeClass::Unclassified),
            ..unbound()
        });
        assert_eq!(d.target, SuDispatchTarget::ReadOnly);
        assert_eq!(d.reason, SuDispatchReason::UnclassifiedConversationReadOnly);
    }

    // ── telemetry: no silent fallback ───────────────────────────────────────

    #[test]
    fn every_dispatch_reason_names_the_runtime_it_chose() {
        use SuDispatchReason as R;
        for (reason, expect) in [
            (R::AttachedSession, "SU session"),
            (R::OwnerPickedBackend, "SU session"),
            (R::CutoverDefault, "SU session"),
            (R::HomedSuSession, "SU session"),
            (R::LegacyConversationReadOnly, "read-only history"),
            (R::UnclassifiedConversationReadOnly, "read-only history"),
        ] {
            let note = reason.note();
            assert!(
                note.starts_with(expect),
                "{reason:?} note {note:?} must lead with the runtime it chose"
            );
        }
    }
}
