//! Backend client over a **pluggable transport** (D-009): `/api/*` routes go
//! through either the operator's IPC `sys:http` tool (local Unix socket,
//! zero-auth) or direct HTTP+bearer (remote / Claude Code plugin). The typed
//! method surface + the UI are transport-agnostic; only `Transport` knows the
//! wire. Selection happens at `from_discovery()`: an explicit launcher target
//! first, then IPC if the socket connects, else HTTP from `operator.json`.
#![allow(dead_code)] // some typed methods are consumed as the panels grow.

use crate::agent_chats::{
    self, AgentChat, AgentChatApprovalDecision, AgentChatApprovalsResponse, AgentChatListOptions,
    AgentChatListResponse, AgentChatTaskMutation, AgentChatTaskMutationResponse, NewAgentChat,
    PendingAgentChatApproval,
};
use crate::app::InboxActionTarget;
use crate::event::MemoryLoadState;
use crate::http::{HttpClient, HttpStatusError};
use crate::ipc::{CallEvent, CallFrame, IpcClient};
use crate::models;
use crate::models::{
    ActivityRecentPayload, ActivityRow, AgentConfigResponse, AttentionItem, AttentionResponse,
    BeeAssignment, BeeMailEntry, BeeMailPayload, BeeMailSide, ConvDetail, ConvGetResponse,
    ConvListResponse, ConvSummary, ConversationLoad, CoordFeedPayload, CoordInboxResponse,
    CoordMsg, CrewMember, CrewRow, CrewSummary, CrewsResponse, DocsResponse, FeaturesPayload,
    FlagsResponse, FleetAssignmentsPayload, HarnessFeature, HarnessIssue, HarnessRef,
    IssuesResponse, LayoutRow, LayoutSummary, LayoutsResponse, LexiconPackPayload, Notif,
    OperatorConfig, PlanItemStates, PlanSummary, PlansResponse, ProjectsResponse, RosterEntry,
    RosterResponse, SessionTranscriptAvailability, SessionTranscriptResolution,
    SessionTranscriptTurn, TestingDomain, TestingResponse, ToastsResponse, TuiPanesPayload,
    TurnsPage, ViewState, ViewStateResponse, WorkFrontier, WorkItem, WorkItemsPayload,
};
use crate::shared_cache;
use crate::sse::{parse_sse_frames, SseFrame};
use crate::su_session::{
    decode_su_session_stream, SuSessionBackend, SuSessionBinding, SuSessionEventStream,
    SuSessionOpenRequest, SuSessionSnapshot,
};
use anyhow::{anyhow, Context, Result};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

fn decode_optional_native_session(
    value: &serde_json::Value,
) -> Result<Option<models::NativeSessionHandle>> {
    value
        .get("nativeSession")
        .filter(|native| !native.is_null())
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .context("decode SU-session native handle")
}

/// The wire `OperatorClient` rides. `Ipc` is the local zero-auth Unix socket;
/// `Http` is remote HTTP+bearer. An enum (not a `dyn` trait) keeps the async
/// methods simple — no async-trait / object-safety dance.
#[derive(Clone)]
enum Transport {
    Ipc(Arc<IpcClient>),
    Http(HttpClient),
}

impl Transport {
    fn name(&self) -> &'static str {
        match self {
            Transport::Ipc(_) => "ipc",
            Transport::Http(_) => "http",
        }
    }
}

impl Transport {
    async fn sys_http(&self, method: &str, path: &str, body: Option<String>) -> Result<Vec<u8>> {
        match self {
            Transport::Ipc(c) => c.sys_http(method, path, body).await,
            Transport::Http(c) => c.sys_http(method, path, body).await,
        }
    }

    /// Subscribe to an SSE route (GET); yields parsed `SseFrame`s regardless of wire.
    async fn subscribe_sse(&self, path: &str) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        match self {
            Transport::Http(c) => c.subscribe_sse(path).await,
            Transport::Ipc(c) => {
                // IPC: stream the `sys:http` tool, pull `sse-chunk` strings, and
                // parse them into frames so callers see the same SseFrame stream.
                let frames = c
                    .invoke_stream(
                        "sys:http",
                        serde_json::json!({ "method": "GET", "path": path }),
                    )
                    .await?;
                Ok(ipc_sse_pipe(frames))
            }
        }
    }

    /// Subscribe to an SSE route via a streaming POST + JSON body (the
    /// operator-converse turn). Same uniform `SseFrame` stream as the GET path,
    /// over either wire — HTTP streams the response; IPC forwards method+body to
    /// the `sys:http` bridge, which emits the upstream `text/event-stream` as
    /// `sse-chunk` frames regardless of method.
    async fn subscribe_sse_post(
        &self,
        path: &str,
        body: String,
    ) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        match self {
            Transport::Http(c) => c.subscribe_sse_post(path, body).await,
            Transport::Ipc(c) => {
                let frames = c
                    .invoke_stream(
                        "sys:http",
                        serde_json::json!({
                            "method": "POST",
                            "path": path,
                            "headers": { "content-type": "application/json" },
                            "body": body,
                        }),
                    )
                    .await?;
                Ok(ipc_sse_pipe(frames))
            }
        }
    }
}

/// Drain an IPC streaming call's `sse-chunk` frames into a uniform `SseFrame`
/// channel — the shared pipe for both GET (`subscribe_sse`) and streaming-POST
/// (`subscribe_sse_post`) over the `sys:http` bridge.
fn ipc_sse_pipe(
    mut frames: mpsc::UnboundedReceiver<CallFrame>,
) -> mpsc::UnboundedReceiver<SseFrame> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut buf = String::new();
        while let Some(cf) = frames.recv().await {
            match cf {
                CallFrame::Event(CallEvent::Json { name, data }) if name == "sse-chunk" => {
                    if let Some(s) = data.as_str() {
                        buf.push_str(s);
                    }
                    let (parsed, rest) = parse_sse_frames(&buf);
                    buf = rest;
                    for f in parsed {
                        if tx.send(f).is_err() {
                            return;
                        }
                    }
                }
                // Terminal frames end the upstream stream → close our side
                // promptly so the caller resubscribes (don't wait for the next
                // implicit sender-drop).
                CallFrame::Done(_) | CallFrame::Error { .. } | CallFrame::ConnLost => return,
                // `head` + other event names: ignore, keep reading.
                _ => {}
            }
        }
    });
    rx
}

/// Bootstrap may outlast an ordinary HTTP request. Its existing POST/SSE pipe
/// carries the final launch response before the canonical session stream opens.
async fn read_su_launch_result(
    mut frames: mpsc::UnboundedReceiver<SseFrame>,
) -> Result<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while let Some(frame) = tokio::time::timeout_at(deadline, frames.recv())
        .await
        .context("SU launch did not finish; draft retained for the same conversation")?
    {
        if frame.event == "error" {
            anyhow::bail!("SU launch stream: {}", frame.data);
        }
        if frame.event != "launch-result" {
            continue;
        }
        let result: serde_json::Value =
            serde_json::from_str(&frame.data).context("decode SU launch result")?;
        let status = result
            .get("httpStatus")
            .and_then(|value| value.as_u64())
            .ok_or_else(|| anyhow!("SU launch result omitted its status"))?;
        let body = result
            .get("body")
            .filter(|value| value.is_object())
            .ok_or_else(|| anyhow!("SU launch result omitted its response"))?;
        if !(200..300).contains(&status) {
            if let Some(refused) = SuLaunchRefused::from_body(body) {
                return Err(refused.into());
            }
            anyhow::bail!("SU launch -> {status}: {body}");
        }
        return Ok(body.clone());
    }
    anyhow::bail!(
        "SU launch stream closed before its result; draft retained for the same conversation"
    )
}

/// launch-su answered and refused the session (WI-10004158). The operator was
/// reached, so this is not a lost connection, and its message is the reason
/// the owner needs (for example which account or model to choose).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuLaunchRefused {
    pub code: String,
    pub message: String,
}

impl SuLaunchRefused {
    fn from_body(body: &serde_json::Value) -> Option<Self> {
        let message = body.get("error").and_then(|v| v.as_str())?.trim();
        if message.is_empty() {
            return None;
        }
        let code = body
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("launch_failed");
        Some(Self {
            code: code.to_owned(),
            message: message.to_owned(),
        })
    }
}

impl std::fmt::Display for SuLaunchRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SuLaunchRefused {}

/// Thin typed client over the operator API, transport-agnostic (D-009).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreIdentity {
    pub id: String,
    pub target: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildIdentity {
    pub version: String,
    pub sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatIdentity {
    pub scope: String,
    pub route: String,
}

/// Optional operator capabilities added without changing the rendezvous schema
/// version.  An older operator decodes as all-false, which is intentionally
/// fail-closed for launch paths that otherwise open native terminal windows.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorCapabilities {
    #[serde(default)]
    pub attached_su_session: bool,
    #[serde(default)]
    pub attached_su_session_approvals: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerIdentity {
    schema_version: u32,
    workspace_id: String,
    store: StoreIdentity,
    build: BuildIdentity,
    agent_chat: AgentChatIdentity,
    #[serde(default)]
    capabilities: OperatorCapabilities,
}

fn su_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The complete, non-secret rendezvous record shown by `pui doctor`, stamped
/// onto stable zellij sessions, and rendered in the UI status line.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendIdentity {
    pub schema_version: u32,
    pub endpoint: String,
    pub selection_source: String,
    pub transport: String,
    pub workspace_id: String,
    pub store: StoreIdentity,
    pub build: BuildIdentity,
    pub agent_chat: AgentChatIdentity,
    pub capabilities: OperatorCapabilities,
}

impl BackendIdentity {
    /// Build changes do not change where a stable session stores or reads data.
    /// Endpoint + workspace + store + agent-chat scope are the rendezvous key.
    pub fn same_rendezvous(&self, other: &Self) -> bool {
        self.endpoint == other.endpoint
            && self.workspace_id == other.workspace_id
            && self.store.id == other.store.id
            && self.agent_chat.scope == other.agent_chat.scope
    }

    pub fn compact(&self) -> String {
        format!(
            "op {} · {} · ws {} · store {} · v{} · chat {}",
            self.endpoint,
            self.transport,
            self.workspace_id,
            self.store.id,
            self.build.version,
            self.agent_chat.scope
        )
    }
}

#[derive(Clone)]
pub struct OperatorClient {
    transport: Transport,
    endpoint: String,
    selection_source: String,
}

/// Ordered write plan for one Inbox quick action. Kept as data so tests can
/// assert the exact owning verbs/arguments without a fake HTTP server.
#[derive(Debug, Clone, PartialEq)]
enum InboxActionStep {
    Tool {
        name: &'static str,
        args: serde_json::Value,
    },
    OwnerReply(serde_json::Value),
    Triage {
        item_id: String,
    },
}

fn target_ref_str<'a>(target: &'a InboxActionTarget, key: &str) -> &'a str {
    target
        .reference
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
}

fn with_harness(mut args: serde_json::Value, harness: Option<&str>) -> serde_json::Value {
    if let (Some(harness), Some(object)) = (
        harness.filter(|value| !value.is_empty()),
        args.as_object_mut(),
    ) {
        object.insert(
            "harness".into(),
            serde_json::Value::String(harness.to_string()),
        );
    }
    args
}

fn inbox_action_steps(
    target: &InboxActionTarget,
    action_id: &str,
    answer_text: Option<&str>,
) -> Result<Vec<InboxActionStep>> {
    if !target.actions.iter().any(|action| action.id == action_id) {
        anyhow::bail!(
            "attention action '{action_id}' was not offered by {}",
            target.id
        );
    }
    let kind = target_ref_str(target, "kind");
    let answer = answer_text.map(str::trim).filter(|value| !value.is_empty());
    let harness = target.harness_slug.as_deref();

    match (kind, action_id) {
        ("plan-item", "answer") => {
            let body = answer.ok_or_else(|| anyhow!("plan answer cannot be blank"))?;
            let slug = target_ref_str(target, "slug");
            let item = target_ref_str(target, "itemId");
            if slug.is_empty() || item.is_empty() {
                anyhow::bail!("plan answer is missing ref.slug/ref.itemId");
            }
            Ok(vec![
                InboxActionStep::Tool {
                    name: "plans:add-decision",
                    args: with_harness(
                        serde_json::json!({
                            "slug": slug,
                            "title": format!("Answer to {item}"),
                            "body": body,
                            "refs": [item],
                        }),
                        harness,
                    ),
                },
                InboxActionStep::Tool {
                    name: "plans:set-status",
                    args: with_harness(
                        serde_json::json!({
                            "slug": slug,
                            "item": item,
                            "status": "done",
                            "rationale": "Owner answered from PUI Needs-you",
                        }),
                        harness,
                    ),
                },
            ])
        }
        ("conversation", "answer") => {
            let body = answer.ok_or_else(|| anyhow!("conversation answer cannot be blank"))?;
            let conversation_id = target_ref_str(target, "conversationId");
            if conversation_id.is_empty() {
                anyhow::bail!("conversation answer is missing ref.conversationId");
            }
            Ok(vec![InboxActionStep::Tool {
                name: "conversations:resolve",
                args: serde_json::json!({
                    "conversation_id": conversation_id,
                    "accepted_answer": body,
                }),
            }])
        }
        ("coord-message", "ack") => {
            let msg_id = target_ref_str(target, "msgId");
            if msg_id.is_empty() {
                anyhow::bail!("coord acknowledgement is missing ref.msgId");
            }
            Ok(vec![InboxActionStep::Tool {
                name: "coord:ack",
                args: serde_json::json!({ "msg_id": msg_id }),
            }])
        }
        ("owner-wall", "resolve") if target_ref_str(target, "wallSource") == "standing-fact" => {
            let scope = target_ref_str(target, "factScope");
            let key = target_ref_str(target, "factKey");
            if scope.is_empty() || key.is_empty() {
                anyhow::bail!("standing wall is missing exact fact scope/key coordinates");
            }
            let mut args = serde_json::json!({
                "scope": scope,
                "key": key,
                "reason": "Owner cleared this wall from PUI Needs-you",
            });
            if let Some(scope_ref) = target
                .reference
                .get("factScopeRef")
                .and_then(serde_json::Value::as_str)
            {
                if !scope_ref.is_empty() {
                    args["scopeRef"] = serde_json::Value::String(scope_ref.to_string());
                }
            }
            Ok(vec![InboxActionStep::Tool {
                name: "facts:retract",
                args,
            }])
        }
        ("work-item-needs-human" | "owner-wall", "answer") => {
            let body = answer.ok_or_else(|| anyhow!("owner-wall answer cannot be blank"))?;
            let asker_id = target
                .owner_agent_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("owner-wall answer has no live asker target"))?;
            Ok(vec![
                InboxActionStep::OwnerReply(serde_json::json!({
                    "askerId": asker_id,
                    "text": body,
                    "summary": format!("Owner answered your {} ({})", target.kind, target.id),
                    "planSlug": target.plan_slug,
                })),
                InboxActionStep::Triage {
                    item_id: target.id.clone(),
                },
            ])
        }
        _ => anyhow::bail!("unsupported PUI attention action {kind}/{action_id}"),
    }
}

/// Fold indexed transcript hits into the live/ended roster without duplicating
/// a session already represented by its native handle or coord owner.
fn merge_session_switcher_rows(
    mut rows: Vec<RosterEntry>,
    inner: &serde_json::Value,
) -> Vec<RosterEntry> {
    for hit in inner
        .get("results")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(provenance) = hit.get("provenance") else {
            continue;
        };
        let source = provenance
            .get("source_kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim();
        let session_id = provenance
            .get("session_id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim();
        if source.is_empty() || session_id.is_empty() {
            continue;
        }
        let owner = provenance
            .get("owner")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        let transcript_ref = hit
            .get("readMore")
            .and_then(|value| value.get("args"))
            .and_then(|value| value.get("ref"))
            .or_else(|| hit.get("ref"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let transcript_excerpt = hit
            .get("excerpt")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let transcript_at = provenance
            .get("ts")
            .or_else(|| hit.get("ts"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let provenance_harness = provenance
            .get("harness_slug")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let agent_chat_id = (source == "agent_chat").then(|| session_id.to_string());
        let session_harness = (source == "agent_chat")
            .then_some(provenance_harness)
            .flatten();
        let already_present = rows.iter().position(|row| {
            agent_chat_id
                .as_deref()
                .is_some_and(|chat_id| row.agent_chat_id.as_deref() == Some(chat_id))
                || row
                    .native_session
                    .as_ref()
                    .and_then(|native| {
                        models::ConversationContextProjectionTarget::from_native_session(
                            native, None,
                        )
                    })
                    .is_some_and(|target| {
                        target.source_kind == source && target.session_id == session_id
                    })
                || (!owner.is_empty() && row.owner_id == owner)
        });
        if let Some(index) = already_present {
            let row = &mut rows[index];
            if transcript_ref.is_some() {
                row.transcript_ref = transcript_ref;
                row.transcript_availability = SessionTranscriptAvailability::Available;
            }
            if transcript_excerpt.is_some() {
                row.transcript_excerpt = transcript_excerpt;
            }
            if transcript_at.is_some() {
                row.transcript_at = transcript_at;
            }
            if agent_chat_id.is_some() {
                row.agent_chat_id = agent_chat_id;
                row.session_harness = session_harness;
            }
            continue;
        }
        let missing = Some("indexed transcript has no resumable launch record".to_string());
        let native_session = match source {
            "claude" => Some(models::NativeSessionHandle::Claude {
                source: source.to_string(),
                owner_id: (!owner.is_empty()).then_some(owner.clone()),
                session_id: Some(session_id.to_string()),
                config_dir: None,
                exact_resume_supported: false,
                missing_reason: missing,
            }),
            "codex" => Some(models::NativeSessionHandle::Codex {
                source: source.to_string(),
                owner_id: (!owner.is_empty()).then_some(owner.clone()),
                codex_home: String::new(),
                rollout_id: Some(session_id.to_string()),
                exact_resume_supported: false,
                missing_reason: missing,
            }),
            "omp" => Some(models::NativeSessionHandle::Omp {
                source: source.to_string(),
                owner_id: (!owner.is_empty()).then_some(owner.clone()),
                omp_thread_id: Some(session_id.to_string()),
                agent_home: None,
                exact_resume_supported: false,
                missing_reason: missing,
            }),
            _ => None,
        };
        rows.push(RosterEntry {
            owner_id: owner.clone(),
            label: if owner.is_empty() {
                format!("{source} · {}", &session_id[..session_id.len().min(12)])
            } else {
                owner
            },
            source: source.to_string(),
            agent: Some(source.to_string()),
            session_state: Some("recorded".to_string()),
            native_session,
            transcript_ref,
            transcript_availability: SessionTranscriptAvailability::Available,
            transcript_excerpt,
            transcript_at,
            agent_chat_id,
            session_harness,
            ..RosterEntry::default()
        });
    }
    rows
}

fn session_search_args(query: &str) -> Option<serde_json::Value> {
    let trimmed = query.trim();
    (!trimmed.is_empty()).then(|| {
        serde_json::json!({
            "query": trimmed,
            "mode": "hybrid",
            "limit": 20,
            "context": 0,
        })
    })
}

fn merge_agent_chat_summaries(
    mut rows: Vec<RosterEntry>,
    chats: &[crate::agent_chats::AgentChatSummary],
    harness: &str,
    query: &str,
) -> Vec<RosterEntry> {
    let query = query.trim().to_ascii_lowercase();
    for chat in chats {
        let title = chat
            .title
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| chat.id.clone());
        if let Some(row) = rows
            .iter_mut()
            .find(|row| row.agent_chat_id.as_deref() == Some(chat.id.as_str()))
        {
            row.label = title;
            row.agent_chat_id = Some(chat.id.clone());
            row.session_harness = Some(harness.to_string());
            continue;
        }
        if !query.is_empty() && !title.to_ascii_lowercase().contains(&query) {
            continue;
        }
        rows.push(RosterEntry {
            owner_id: format!("agent-chat:{}", chat.id),
            label: title,
            source: "agent_chat".into(),
            agent: Some("agent_chat".into()),
            role: Some(chat.role.clone()),
            session_state: Some("recorded".into()),
            heartbeat_at: Some(chat.updated_at.clone()),
            transcript_at: Some(chat.updated_at.clone()),
            transcript_availability: SessionTranscriptAvailability::Unknown,
            agent_chat_id: Some(chat.id.clone()),
            session_harness: Some(harness.to_string()),
            ..RosterEntry::default()
        });
    }
    rows
}

/// Parse the first hit from an exact-session `sessions:search`. A true empty
/// page is `Ok(None)`; a malformed hit is an error so it can never be rendered
/// as proof that the transcript is unavailable.
fn session_transcript_resolution(
    inner: &serde_json::Value,
) -> Result<Option<SessionTranscriptResolution>> {
    let Some(hit) = inner
        .get("results")
        .and_then(serde_json::Value::as_array)
        .and_then(|results| results.first())
    else {
        return Ok(None);
    };
    let reference = hit
        .get("readMore")
        .and_then(|value| value.get("args"))
        .and_then(|value| value.get("ref"))
        .or_else(|| hit.get("ref"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .context("exact sessions:search hit omitted its canonical ref")?
        .to_string();
    Ok(Some(SessionTranscriptResolution {
        reference,
        excerpt: hit
            .get("excerpt")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        transcript_at: hit
            .get("provenance")
            .and_then(|value| value.get("ts"))
            .or_else(|| hit.get("ts"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    }))
}

/// Normalize the structured `sessions:read` response into the browser's shared
/// transcript model. Invalid synthetic notice rows are ignored instead of
/// leaking transport shaping into the renderer.
fn session_transcript_turns(inner: &serde_json::Value) -> Vec<SessionTranscriptTurn> {
    inner
        .get("turns")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|turn| {
            let text = turn
                .get("text")
                .and_then(serde_json::Value::as_str)?
                .trim()
                .to_string();
            if text.is_empty() {
                return None;
            }
            Some(SessionTranscriptTurn {
                speaker: turn
                    .get("speaker")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                ts: turn
                    .get("ts")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                text,
            })
        })
        .collect()
}

/// The canonical `work_items:list` result is a bare array. Keep accepting the
/// older `{ items: [...] }` wrapper so a pui can talk to a mixed-version
/// operator during rollout.
#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
enum WorkItemsListPayload {
    Array(Vec<WorkItem>),
    Legacy(WorkItemsPayload),
}

fn parse_work_items_list_payload(text: &str) -> Result<Vec<WorkItem>> {
    match serde_json::from_str::<WorkItemsListPayload>(text)
        .context("parse work_items:list payload")?
    {
        WorkItemsListPayload::Array(items) => Ok(items),
        WorkItemsListPayload::Legacy(payload) => Ok(payload.items),
    }
}

/// Lock-resolve's node:test fixtures use `lockresolve-<pid>-<case>` names.
/// Older operators may still have leaked manifests on disk, so the TUI keeps
/// them out even when talking to a mixed-version backend.
fn is_lock_resolve_fixture_name(name: &str) -> bool {
    let mut parts = name.splitn(3, '-');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some("lockresolve"), Some(pid), Some(case_name))
            if !pid.is_empty()
                && pid.bytes().all(|b| b.is_ascii_digit())
                && !case_name.is_empty()
    )
}

fn filter_lock_resolve_fixtures(
    plugins: Vec<models::PluginManifest>,
) -> Vec<models::PluginManifest> {
    plugins
        .into_iter()
        .filter(|plugin| !is_lock_resolve_fixture_name(&plugin.name))
        .collect()
}

impl OperatorClient {
    /// Resolve a backend. EXPLICIT selection wins (P-001 refit): `PUI_OPERATOR`
    /// = `staging` (:3170) | `release` (:3070) | a full http(s) URL pins the
    /// operator over HTTP. A launcher may use the standard
    /// `PAPERCUSP_OPERATOR_URL` child env when `PUI_OPERATOR` is absent; it is
    /// normalized to the same bare origin. This is important on a multi-operator
    /// home: the shared IPC singleton is last-writer-wins and cannot identify the
    /// operator that launched this pui. Unset/empty → the legacy chain: local
    /// IPC socket, else HTTP+bearer from `~/.papercusp/operator.json`.
    pub async fn from_discovery() -> Result<Self> {
        let selection = resolve_operator_selection(
            std::env::var("PUI_OPERATOR").ok().as_deref(),
            std::env::var("PAPERCUSP_OPERATOR_URL").ok().as_deref(),
            std::env::var("PAPERCUSP_HONO_PORT").ok().as_deref(),
        )?;
        if selection.explicit {
            return Self::from_resolved_selection(selection);
        }
        match IpcClient::connect_discovered().await {
            Ok(ipc) => Ok(Self {
                transport: Transport::Ipc(Arc::new(ipc)),
                endpoint: selection.base,
                selection_source: selection.source,
            }),
            Err(_ipc_err) => Self::from_resolved_selection(selection),
        }
    }

    /// Build the client for an explicit operator selection (P-001): HTTP
    /// transport; bearer from `~/.papercusp/operator.json` when present —
    /// harmless on endpoints that don't require it.
    pub fn from_selection(sel: &str) -> Result<Self> {
        let base = crate::http::base_for_selection(sel)?;
        Self::from_resolved_selection(OperatorSelection {
            base,
            source: "explicit argument".to_string(),
            explicit: true,
        })
    }

    fn from_resolved_selection(selection: OperatorSelection) -> Result<Self> {
        // PUI_OPERATOR_TOKEN wins; otherwise the endpoint-scoped local bearer.
        // Never an unscoped credential — see http::resolve_token_for (R3).
        let token = crate::http::token_for_endpoint(&selection.base);
        Ok(Self {
            transport: Transport::Http(HttpClient::new(selection.base.clone(), token)),
            endpoint: selection.base,
            selection_source: selection.source,
        })
    }

    /// Construct over an existing IPC client (tests / shared client).
    pub fn new(ipc: Arc<IpcClient>) -> Self {
        Self {
            transport: Transport::Ipc(ipc),
            endpoint: "ipc:test".to_string(),
            selection_source: "test".to_string(),
        }
    }

    /// Probe the selected operator for the server half of the canonical
    /// identity. The timeout is the fail-fast contract for startup/doctor: a
    /// dead or mismatched backend becomes an actionable error, not a hung UI.
    pub async fn backend_identity(&self) -> Result<BackendIdentity> {
        const PROBE_BUDGET: Duration = Duration::from_secs(3);
        let value = tokio::time::timeout(PROBE_BUDGET, self.get_json("/api/tui/identity"))
            .await
            // Typed (R2): an expired probe budget is an UNREACHABLE operator,
            // and only the type carries that — a bare message would fall through
            // to the classifier's "answered, but not usably" bucket.
            .map_err(|_| {
                anyhow::Error::new(crate::http::ProbeTimeout {
                    endpoint: self.endpoint.clone(),
                    budget: PROBE_BUDGET,
                })
            })??;
        let server: ServerIdentity =
            serde_json::from_value(value).context("decode /api/tui/identity")?;
        if server.schema_version != 1 {
            anyhow::bail!(
                "unsupported operator identity schema {}",
                server.schema_version
            );
        }
        let expected_scope = format!("workspace:{}", server.workspace_id);
        if server.agent_chat.scope != expected_scope {
            return Err(anyhow::Error::new(crate::http::IdentityMismatchError {
                endpoint: self.endpoint.clone(),
                detail: format!(
                    "operator identity is internally inconsistent: workspace {} but agent-chat scope {}",
                    server.workspace_id, server.agent_chat.scope
                ),
            }));
        }
        Ok(BackendIdentity {
            schema_version: server.schema_version,
            endpoint: self.endpoint.clone(),
            selection_source: self.selection_source.clone(),
            transport: self.transport.name().to_string(),
            workspace_id: server.workspace_id,
            store: server.store,
            build: server.build,
            agent_chat: server.agent_chat,
            capabilities: server.capabilities,
        })
    }

    /// Subscribe to an SSE route, yielding parsed frames (transport-agnostic).
    pub async fn subscribe_sse(&self, path: &str) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        self.transport.subscribe_sse(path).await
    }

    // ─── Operator chat (tui-operator-surface-2026-06-04) ───
    // Same backend path the desktop operator uses: POST /api/agent-mcp/operator-converse
    // for the streaming brain turn + /api/operator/conversations/* for history +
    // turn persistence. No persona fork — the TUI is a second client over the
    // existing `operator` role (D-001/D-002).

    /// Open the operator-converse SSE stream for a turn (streaming POST). `body`
    /// is the full converse payload (messages, trigger, modality, surface:"tui",
    /// uiClientId, conversationId). Yields `delta`/`tool_call`/`done`/`error`
    /// frames (+ `heartbeat`).
    pub async fn subscribe_converse(
        &self,
        body: serde_json::Value,
    ) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        self.transport
            .subscribe_sse_post("/api/agent-mcp/operator-converse", body.to_string())
            .await
    }

    /// Subscribe to the state-channel snapshot SSE for the active workspace
    /// (sentinel-tui-shared-backend-and-cards-2026-06-22 Phase 2a). Each
    /// `snapshot` frame's `data` is a `VersionedSnapshot` (`{runId, version,
    /// snapshot:{openCards}}`) — the SAME stream the browser PendingCardsBar
    /// consumes via `useStateSnapshots`. The TUI is a second consumer: it
    /// renders the open `chat:ask_choice` cards inline and answers them through
    /// `/card-response`. The route scopes to `activeWorkspaceId()` server-side,
    /// so no query param is needed.
    pub async fn subscribe_state_snapshot(&self) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        self.subscribe_sse("/api/operator/state-snapshot").await
    }

    /// Answer a pending `ctx.askUser` card (POST /card-response). `correlation_id`
    /// targets the blocked tool call; `workspace_id` is the defense-in-depth
    /// `expectedWorkspaceId` gate. `action` ∈ {submit, decline, cancel}; `payload`
    /// is the submit body (`{picks:[…]}` for choice, `{value:…}` for input).
    /// The `conversation_id` only feeds the route's :id audit segment (the
    /// correlator looks up by correlationId). Mirrors `postCardResponse`.
    pub async fn card_respond(
        &self,
        conversation_id: &str,
        correlation_id: &str,
        workspace_id: &str,
        action: &str,
        payload: Option<serde_json::Value>,
        reason: Option<&str>,
    ) -> Result<()> {
        let mut body = serde_json::json!({
            "correlationId": correlation_id,
            "workspaceId": workspace_id,
            "action": action,
        });
        if let Some(p) = payload {
            body["payload"] = p;
        }
        if let Some(r) = reason {
            body["reason"] = serde_json::Value::String(r.to_string());
        }
        self.post_json(
            &format!(
                "/api/operator/conversations/{}/card-response",
                urlencode(conversation_id)
            ),
            body,
        )
        .await?;
        Ok(())
    }

    /// Cancel every pending card under a runId (the chat-level "Cancel all").
    /// Mirrors `postRunCancel` → POST /run-cancel.
    pub async fn run_cancel(
        &self,
        conversation_id: &str,
        run_id: &str,
        workspace_id: &str,
    ) -> Result<()> {
        self.post_json(
            &format!(
                "/api/operator/conversations/{}/run-cancel",
                urlencode(conversation_id)
            ),
            serde_json::json!({ "runId": run_id, "workspaceId": workspace_id }),
        )
        .await?;
        Ok(())
    }

    /// Load the workspace's active operator conversation + recent turns (oldest
    /// first). Auto-creates the conversation server-side if none exists.
    pub async fn load_conversation(&self, limit: u32) -> Result<ConversationLoad> {
        let v = self
            .get_json(&format!("/api/operator/conversations?limit={limit}"))
            .await?;
        serde_json::from_value::<ConversationLoad>(v).context("decode conversation")
    }

    /// Append a turn to a conversation (persist the user message + the finalized
    /// assistant reply, so the thread stays consistent with the desktop surface).
    /// `tools` is the per-turn tool-call array (`[{name, input?}]`); pass `&[]`
    /// for none. `report` is the optional `<report>` payload (structured-report-protocol).
    pub async fn append_turn(
        &self,
        conversation_id: &str,
        role: &str,
        text: &str,
        tools: &[serde_json::Value],
        report: Option<&serde_json::Value>,
    ) -> Result<()> {
        let mut body = serde_json::json!({
            "role": role,
            "text": text,
            "source": "text_typed",
        });
        if !tools.is_empty() {
            body["tools"] = serde_json::Value::Array(tools.to_vec());
        }
        if let Some(r) = report {
            body["report"] = r.clone();
        }
        self.post_json(
            &format!("/api/operator/conversations/{conversation_id}/turns"),
            body,
        )
        .await?;
        Ok(())
    }

    /// Fetch an older page of turns (the load-earlier cursor): turns with
    /// `seq < before_seq`, oldest-first, plus whether more exist before them.
    pub async fn load_earlier_turns(
        &self,
        conversation_id: &str,
        before_seq: i64,
        limit: u32,
    ) -> Result<TurnsPage> {
        let v = self
            .get_json(&format!(
                "/api/operator/conversations/{}/turns?beforeSeq={before_seq}&limit={limit}",
                urlencode(conversation_id)
            ))
            .await?;
        serde_json::from_value::<TurnsPage>(v).context("decode earlier turns")
    }

    // ─── Native agent-chats session protocol (P-004 / D-009 / D-011) ───

    /// List agent-chat sessions for one harness. The server bounds every page;
    /// callers can request archived rows and advance with `offset`.
    pub async fn list_agent_chats(
        &self,
        harness: &str,
        options: &AgentChatListOptions,
    ) -> Result<Vec<crate::agent_chats::AgentChatSummary>> {
        let path = agent_chats::agent_chats_list_path(harness, options);
        let value = self.get_json(&path).await?;
        Ok(serde_json::from_value::<AgentChatListResponse>(value)
            .context("decode agent-chat list")?
            .chats)
    }

    /// Create a session on the operator-owned agent-chats store.
    pub async fn create_agent_chat(
        &self,
        harness: &str,
        request: &NewAgentChat,
    ) -> Result<AgentChat> {
        let body = serde_json::to_value(request).context("encode new agent chat")?;
        let value = self
            .post_json(
                &agent_chats::agent_chats_list_path(harness, &AgentChatListOptions::default()),
                body,
            )
            .await?;
        serde_json::from_value(value).context("decode created agent chat")
    }

    /// Load one session including transcript and feature-lock projection.
    pub async fn get_agent_chat(&self, harness: &str, chat_id: &str) -> Result<AgentChat> {
        let value = self
            .get_json(&agent_chats::agent_chat_path(harness, chat_id))
            .await?;
        serde_json::from_value(value).context("decode agent chat")
    }

    /// Archive one session. This intentionally does not mutate a feature lock.
    pub async fn archive_agent_chat(&self, harness: &str, chat_id: &str) -> Result<()> {
        self.delete_json(&agent_chats::agent_chat_path(harness, chat_id))
            .await?;
        Ok(())
    }

    /// Rename one stable agent-chat identity.
    pub async fn rename_agent_chat(
        &self,
        harness: &str,
        chat_id: &str,
        title: &str,
    ) -> Result<String> {
        let value = self
            .put_json(
                &agent_chats::agent_chat_path(harness, chat_id),
                serde_json::json!({ "title": title }),
            )
            .await?;
        value
            .get("title")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .context("rename agent chat response omitted title")
    }

    /// Continue immutable history into a fresh linked, writable agent-chat.
    pub async fn continue_agent_chat(
        &self,
        harness: &str,
        source_chat_id: &str,
    ) -> Result<AgentChat> {
        let value = self
            .post_json(
                &format!(
                    "{}/continue",
                    agent_chats::agent_chat_path(harness, source_chat_id)
                ),
                serde_json::json!({}),
            )
            .await?;
        serde_json::from_value(value).context("decode continued agent chat")
    }

    /// Apply one user-side task action to the selected SU-session chat. The
    /// response includes the canonical shared projection; the PG write also
    /// invalidates conversations.contextProjection for sibling renderers.
    pub async fn mutate_agent_chat_task(
        &self,
        harness: &str,
        chat_id: &str,
        mutation: &AgentChatTaskMutation,
    ) -> Result<AgentChatTaskMutationResponse> {
        let body = serde_json::to_value(mutation).context("encode agent-chat task mutation")?;
        let value = self
            .post_json(&agent_chats::agent_chat_tasks_path(harness, chat_id), body)
            .await?;
        serde_json::from_value(value).context("decode agent-chat task mutation")
    }

    /// Rehydrate unresolved HITL requests after a client reconnect.
    pub async fn list_agent_chat_approvals(
        &self,
        harness: &str,
        chat_id: &str,
    ) -> Result<Vec<PendingAgentChatApproval>> {
        let value = self
            .get_json(&agent_chats::agent_chat_approvals_path(harness, chat_id))
            .await?;
        Ok(serde_json::from_value::<AgentChatApprovalsResponse>(value)
            .context("decode pending agent-chat approvals")?
            .approvals)
    }

    /// Resolve one pending HITL request. The route is PG-backed, so this works
    /// even when the POST lands on a different operator cluster worker.
    pub async fn resolve_agent_chat_approval(
        &self,
        harness: &str,
        chat_id: &str,
        call_id: &str,
        decision: &AgentChatApprovalDecision,
    ) -> Result<()> {
        let body = serde_json::to_value(decision).context("encode approval decision")?;
        self.post_json(
            &agent_chats::agent_chat_approval_path(harness, chat_id, call_id),
            body,
        )
        .await?;
        Ok(())
    }

    // ─── Shared SU-session host (P-008) ─────────────────────────────────────

    /// Create or attach one durable SU session through the canonical launch-su
    /// door. Bootstrap streams progress, then the durable binding; reattachment
    /// resumes that same recorded identity. The explicit
    /// backend is mandatory on both paths so PUI cannot silently inherit a
    /// different configured provider after a restart.
    pub async fn open_su_session(
        &self,
        request: &SuSessionOpenRequest,
    ) -> Result<SuSessionBinding> {
        let identity = self
            .backend_identity()
            .await
            .context("verify selected operator supports attached SU sessions")?;
        if !identity.capabilities.attached_su_session {
            anyhow::bail!(
                "selected operator {} does not advertise attached, windowless SU sessions; PUI refused before launch so it cannot open a native agent terminal. Update the selected operator, or select a current one with PUI_OPERATOR=<url>",
                identity.endpoint
            );
        }
        let body = match request {
            SuSessionOpenRequest::Create(request) => serde_json::to_value(request),
            SuSessionOpenRequest::Attach(request) => serde_json::to_value(request),
        }
        .context("encode SU-session open request")?;
        let frames = self
            .transport
            .subscribe_sse_post("/api/adv/sessions/launch-su?stream=1", body.to_string())
            .await
            .context("open SU session")?;
        let value = read_su_launch_result(frames)
            .await
            .context("open SU session")?;
        if value.get("status").and_then(|v| v.as_str()) != Some("ok") {
            let refused = SuLaunchRefused::from_body(&value).unwrap_or_else(|| SuLaunchRefused {
                code: "launch_failed".into(),
                message: "launch-su refused the SU session".into(),
            });
            return Err(refused.into());
        }
        let operation = match request {
            SuSessionOpenRequest::Create(_) => "created",
            SuSessionOpenRequest::Attach(_) => "attached",
        };
        let backend = value
            .get("agent")
            .cloned()
            .map(serde_json::from_value::<SuSessionBackend>)
            .transpose()
            .context("decode SU-session backend")?
            .ok_or_else(|| anyhow!("launch-su omitted the resolved backend"))?;
        let expected_backend = match request {
            SuSessionOpenRequest::Create(request) => request.agent,
            SuSessionOpenRequest::Attach(request) => request.agent,
        };
        if backend != expected_backend {
            anyhow::bail!("launch-su returned backend {backend}; expected {expected_backend}");
        }
        let adv_session_id = value
            .get("advSessionId")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| anyhow!("launch-su returned no stable advSessionId"))?;
        Ok(SuSessionBinding {
            operation: operation.to_string(),
            backend,
            adv_session_id,
            owner_id: value
                .get("ownerId")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            workspace_id: value
                .get("workspaceId")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            harness_slug: value
                .get("harnessSlug")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            plan_slug: value
                .get("planSlug")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            native_session: decode_optional_native_session(&value)?,
        })
    }

    /// Read the canonical descriptor/lifecycle snapshot for one attached chat.
    pub async fn su_session_snapshot(
        &self,
        harness: &str,
        chat_id: &str,
    ) -> Result<SuSessionSnapshot> {
        let value = self
            .get_json(&format!(
                "/api/harness/{}/agent-chats/{}/su-session",
                su_segment(harness),
                su_segment(chat_id)
            ))
            .await?;
        serde_json::from_value(value).context("decode SU-session snapshot")
    }

    /// Subscribe to the typed canonical session stream. `Last-Event-ID` is
    /// handled by the existing transport/SSE layer; the decoder validates the
    /// contract schema and leaves sequence-gap policy to the reducer.
    pub async fn subscribe_su_session(
        &self,
        harness: &str,
        chat_id: &str,
    ) -> Result<SuSessionEventStream> {
        let frames = self
            .subscribe_sse(&format!(
                "/api/harness/{}/agent-chats/{}/su-session/events",
                su_segment(harness),
                su_segment(chat_id)
            ))
            .await?;
        Ok(decode_su_session_stream(frames))
    }

    /// Send one typed SU-session command to the real runtime. Commands are
    /// deliberately opaque JSON here; the protocol module owns the stable
    /// envelope and backend adapters own command-specific details.
    pub async fn send_su_session_command(
        &self,
        harness: &str,
        chat_id: &str,
        command: serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.post_json(
            &format!(
                "/api/harness/{}/agent-chats/{}/su-session/commands",
                su_segment(harness),
                su_segment(chat_id)
            ),
            command,
        )
        .await
    }

    /// Ask the host to keep this chat's engine running after pui quits
    /// (pui-chat-first-ux P-009 `/detach`). Without it the engine ends once no
    /// client has been attached for the host's attendance lease.
    pub async fn detach_su_session(
        &self,
        harness: &str,
        chat_id: &str,
    ) -> Result<serde_json::Value> {
        self.post_json(
            &format!(
                "/api/harness/{}/agent-chats/{}/su-session/detach",
                su_segment(harness),
                su_segment(chat_id)
            ),
            serde_json::json!({}),
        )
        .await
    }

    async fn get_json(&self, path: &str) -> Result<serde_json::Value> {
        let bytes = self.transport.sys_http("GET", path, None).await?;
        serde_json::from_slice(&bytes).with_context(|| format!("parse JSON from {path}"))
    }

    async fn post_json(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value> {
        let bytes = self
            .transport
            .sys_http("POST", path, Some(body.to_string()))
            .await?;
        serde_json::from_slice(&bytes).with_context(|| format!("parse JSON from {path}"))
    }

    async fn put_json(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value> {
        let bytes = self
            .transport
            .sys_http("PUT", path, Some(body.to_string()))
            .await?;
        serde_json::from_slice(&bytes).with_context(|| format!("parse JSON from {path}"))
    }

    async fn delete_json(&self, path: &str) -> Result<serde_json::Value> {
        let bytes = self.transport.sys_http("DELETE", path, None).await?;
        serde_json::from_slice(&bytes).with_context(|| format!("parse JSON from {path}"))
    }

    // --- raw ---
    pub async fn roster(&self) -> Result<serde_json::Value> {
        self.roster_scoped(None).await
    }

    /// The live roster, optionally scoped to ONE workspace (`?workspace=<id>`);
    /// `None` keeps the unscoped fleet-wide default. The brain-view panes pass
    /// the active workspace so the ♛ queen / 👁 overwatch tails follow it.
    pub async fn roster_scoped(&self, workspace: Option<&str>) -> Result<serde_json::Value> {
        self.get_json(&roster_path(workspace)).await
    }

    /// The active workspace id from the operator registry (`GET /api/workspaces`
    /// → `current`). `None` when the registry has no current (dev / webapp), so
    /// callers fall back to the unscoped roster. A workspace SWITCH rewrites
    /// `registry.current` (desktop `workspaces::switch`), so re-reading this
    /// follows the switch — which is how the brain panes re-scope live.
    pub async fn current_workspace(&self) -> Result<Option<String>> {
        let v = self.get_json("/api/workspaces").await?;
        Ok(v.get("current")
            .and_then(|c| c.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string))
    }

    /// Invoke any palette-eligible server tool over the loopback run-tool route
    /// (POST /api/agent-mcp/run-tool → `{ ok, result }`, where `result` holds the
    /// tool's content). The generic pui→server-tool bridge: the wake-mode UI
    /// (`coord:wake-mode` / `coord:wake-queue`, hive-agent-tabs P-008/P-009) + any
    /// future pui tool-call go through it.
    pub async fn run_tool(&self, name: &str, args: serde_json::Value) -> Result<serde_json::Value> {
        self.post_json("/api/agent-mcp/run-tool", run_tool_body(name, args, false))
            .await
    }

    /// Execute a mutation the TUI already confirmed in its own y/n modal. The
    /// server still re-checks eligibility, authorization and capability, and
    /// the ordinary projected-tool dispatcher still writes the audit record;
    /// this bool only satisfies the loopback route's high-risk confirmation
    /// rail after the human's separate `y` keypress.
    pub async fn run_tool_confirmed(
        &self,
        name: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.post_json("/api/agent-mcp/run-tool", run_tool_body(name, args, true))
            .await
    }

    pub async fn fleet_leader_brief(
        &self,
        fleet: &str,
        harness: &str,
    ) -> Result<crate::models::FleetLeaderBrief> {
        let envelope = self
            .run_tool(
                "fleet:leader-brief",
                serde_json::json!({ "fleet": fleet, "harness": harness }),
            )
            .await?;
        let inner = run_tool_inner_json(&envelope)?;
        serde_json::from_value(inner).context("decode fleet:leader-brief")
    }

    /// The inference-gateway account pool, for the chat pane's account picker
    /// (P-005, WI-41189). `accounts:status` is the row shape the menu reads
    /// (id/label/provider/available + the freshness fields); `accounts:list` is
    /// the pool INVENTORY and carries no capacity reading, so it is the wrong
    /// read for a picker that must say whether an account can serve.
    ///
    /// A pool that fails to parse yields an EMPTY menu rather than an error: the
    /// picker still renders Auto (and the disabled default row), which is the
    /// honest degradation — those two do not depend on the pool.
    pub async fn accounts_status(&self) -> Result<crate::session_config::AccountsStatus> {
        let env = self
            .run_tool("accounts:status", serde_json::json!({}))
            .await?;
        let inner = run_tool_inner_json(&env)?;
        let accounts = inner
            .get("accounts")
            .cloned()
            .and_then(|rows| serde_json::from_value(rows).ok())
            .unwrap_or_default();
        let pool_verdict = inner
            .get("poolVerdict")
            .cloned()
            .and_then(|rows| serde_json::from_value(rows).ok())
            .unwrap_or_default();
        Ok(crate::session_config::AccountsStatus {
            accounts,
            pool_verdict,
        })
    }

    /// Pin `agent` to a pool account. ⚠ `accounts:pin`/`accounts:unpin` are
    /// defined in `agent-tools/gateway/gateway.ts`, NOT in `agent-tools/
    /// accounts/` — grepping the accounts directory for them finds nothing.
    ///
    /// Returns the tool's OWN reply so the caller can tell a pin that is in
    /// force from one that is merely durable (`appliedLive:false`); see
    /// `session_config::describe_pin_outcome`. NOT `accounts:set-session-
    /// override`, which reads like the natural setter but is a FLEET-WIDE steer
    /// over which account NEW spawns get.
    pub async fn account_pin(&self, agent: &str, account: &str) -> Result<serde_json::Value> {
        let env = self
            .run_tool(
                "accounts:pin",
                serde_json::json!({ "agent": agent, "account": account }),
            )
            .await?;
        run_tool_inner_json(&env)
    }

    /// Remove a dynamic pin; the agent reverts to its spawn-time routing.
    pub async fn account_unpin(&self, agent: &str) -> Result<serde_json::Value> {
        let env = self
            .run_tool("accounts:unpin", serde_json::json!({ "agent": agent }))
            .await?;
        run_tool_inner_json(&env)
    }
    /// Cross-process cache key for `plans_list`'s response (D-004 of
    /// `fleet-deltas-leader-primitives-2026-07-10`) — bump this if the query
    /// shape below ever changes, so a stale-shaped cache entry from an older
    /// binary can never be misread as a hit for a new shape.
    const PLANS_LIST_CACHE_KEY: &'static str = "plans-list-standard-v1";
    /// How long a cached `plans:list` response is trusted before a fresh
    /// fetch is required. Short on purpose: this exists ONLY to collapse a
    /// same-machine burst of independent `pui` processes waking off the
    /// SAME SSE-invalidate signal within milliseconds of each other (see
    /// `shared_cache.rs`), not to genuinely slow the read cadence — 3s is
    /// comfortably inside the SSE loop's own 250ms invalidate-debounce +
    /// 60s safety-net cadence, so it adds no perceptible staleness.
    const PLANS_LIST_CACHE_FRESH_FOR: Duration = Duration::from_secs(3);

    pub async fn plans_list(&self) -> Result<serde_json::Value> {
        // EI-7430: `standard` tier is ~6x smaller than the default `full` tier for
        // the same list (521KB -> 87KB live-measured) — the TUI only ever renders
        // the summary fields anyway. `/api/admin/plans/:verb` forwards unknown
        // query params straight through (bodyFromSearchParams), so this needs no
        // server-side change.
        //
        // D-004 (fleet-deltas-leader-primitives-2026-07-10): this admin-proxy
        // route carries ZERO cursor/delta negotiation — SYNC_RESOURCE_DELTA only
        // wires the desktop webview's `@papercusp/sync` rest-query path, which
        // this call never touches, so the flag being ON can't help this traffic.
        // The remaining structural waste is duplicate fetches: several `pui`
        // processes (Fleet/Plans/Inbox panes, …) react to the SAME
        // SSE-invalidate push and each independently re-fetch within
        // milliseconds of each other. A short shared-disk cache (`shared_cache`)
        // collapses that burst into one real call + N-1 free local reads.
        if let Some(cached) =
            shared_cache::read_fresh(Self::PLANS_LIST_CACHE_KEY, Self::PLANS_LIST_CACHE_FRESH_FOR)
        {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&cached) {
                return Ok(v);
            }
            // Corrupt/partial cache entry (shouldn't happen — writes are
            // atomic — but never let a bad cache file break the read): fall
            // through to a real fetch rather than erroring.
        }
        let v = self
            .get_json("/api/admin/plans/list?payloadTier=standard")
            .await?;
        if let Ok(bytes) = serde_json::to_vec(&v) {
            shared_cache::write_best_effort(Self::PLANS_LIST_CACHE_KEY, &bytes);
        }
        Ok(v)
    }

    /// Bring an agent's external terminal window to the foreground via the
    /// `/api/adv/sessions/focus` route (wmctrl `-ia`). The route resolves a
    /// window id from (in order) an explicit `windowId`, the adv_sessions row's
    /// stored `window_id` (looked up by `id`), the `pid` (`wmctrl -lp`), or the
    /// `[adv:<id>]` title fragment. Best-effort: `Ok(false)` when no window can
    /// be resolved (no wmctrl / no DISPLAY / pid has no window) — the caller
    /// surfaces a "couldn't focus" toast rather than treating it as a hard error.
    /// Enter-by-location external-window route (pui-workbench-usability D-001).
    pub async fn focus_session(
        &self,
        adv_session_id: Option<i64>,
        pid: Option<i64>,
        window_id: Option<String>,
    ) -> Result<bool> {
        let mut body = serde_json::Map::new();
        if let Some(id) = adv_session_id {
            body.insert("id".into(), serde_json::json!(id));
        }
        if let Some(p) = pid {
            body.insert("pid".into(), serde_json::json!(p));
        }
        if let Some(w) = window_id.filter(|w| !w.is_empty()) {
            body.insert("windowId".into(), serde_json::json!(w));
        }
        // The route returns 404 (window unresolvable) / 500 (wmctrl failed) with
        // a JSON `{status:'error'}` body; the transport surfaces non-2xx as an
        // Err, so treat any failure as "couldn't focus" (Ok(false)) — only a
        // parsed `{status:'ok'}` is success.
        match self
            .post_json("/api/adv/sessions/focus", serde_json::Value::Object(body))
            .await
        {
            Ok(v) => Ok(v.get("status").and_then(|s| s.as_str()) == Some("ok")),
            Err(_) => Ok(false),
        }
    }

    /// Atomically CLAIM a pending workbench launch (EI-358 claim-then-open):
    /// the route stamps `launched_at` only when unset, so `stamped == true`
    /// for exactly ONE caller across every pui process — the claim winner
    /// opens the pane; losers skip. A transport error is `Err` (retryable —
    /// the caller un-tracks the id so a later roster tick can retry), distinct
    /// from a LOST claim (`Ok(false)` — another instance owns it, skip forever).
    pub async fn mark_session_launched(&self, adv_session_id: i64) -> Result<bool> {
        let body = serde_json::json!({ "id": adv_session_id });
        let v = self
            .post_json("/api/adv/sessions/mark-launched", body)
            .await?;
        Ok(v.get("stamped").and_then(|s| s.as_bool()).unwrap_or(false))
    }

    // --- typed ---
    /// The live roster: `(active, pending)`. `active` is the presence-primary
    /// roster (rendered); `pending` is the recorded-but-not-running workbench-
    /// launch tier the reducer diffs to reactively open panes (D-006).
    pub async fn roster_typed(&self) -> Result<(Vec<RosterEntry>, Vec<RosterEntry>)> {
        self.roster_typed_scoped(None).await
    }

    /// `roster_typed` scoped to one workspace (`None` → fleet-wide). The brain
    /// panes pass the active workspace so queen/overwatch follow a switch.
    pub async fn roster_typed_scoped(
        &self,
        workspace: Option<&str>,
    ) -> Result<(Vec<RosterEntry>, Vec<RosterEntry>)> {
        let v = self.roster_scoped(workspace).await?;
        let resp = serde_json::from_value::<RosterResponse>(v).context("decode roster")?;
        Ok((resp.active, resp.pending))
    }

    /// The brain-view roster: the `active` AND `ended` tiers concatenated, scoped
    /// to one workspace (`None` → fleet-wide). The read-only queen/overwatch panes
    /// (`brain_view.rs`) resolve the NEWEST wake-with-a-transcript across BOTH
    /// tiers — a short-lived autonomous wake is `markAdvSessionEnded` the instant
    /// its invoke run returns, so it lands in `ended`, not `active`. Reading only
    /// `active` (the old behavior) made the Overwatch pane permanently say
    /// "not running right now — waiting…": every overwatch wake is a ~seconds-to-
    /// minutes invoke whose adv_sessions row is ENDED by the time the pane polls,
    /// so it never appeared in the `active`-only set even though its transcript
    /// sits on disk. The Queen happened to keep many `active` rows (overlapping
    /// wakes), which is why only Overwatch showed the bug. `ended` is appended
    /// after `active` so a still-live wake (if any) is seen first; the caller
    /// sorts by `adv_session_id` regardless, so ordering here is not load-bearing.
    pub async fn roster_brain_scoped(&self, workspace: Option<&str>) -> Result<Vec<RosterEntry>> {
        let v = self.roster_scoped(workspace).await?;
        let resp = serde_json::from_value::<RosterResponse>(v).context("decode roster")?;
        let mut entries = resp.active;
        entries.extend(resp.ended);
        Ok(entries)
    }

    /// Global session-switcher rows: live + ended launch records from the roster,
    /// enriched by the owner-scoped indexed transcript search. Search hits with
    /// no launch record remain visible as `recorded` rows; routing them still
    /// goes through the ordinary resolver, which truthfully offers its menu.
    pub async fn session_switcher_rows(
        &self,
        harness: Option<&str>,
        query: &str,
    ) -> Result<Vec<RosterEntry>> {
        let v = self.roster().await?;
        let resp = serde_json::from_value::<RosterResponse>(v).context("decode roster")?;
        let mut rows = resp.active;
        rows.extend(resp.ended);

        // `sessions:search` owns content search and its verbatim query is a
        // literal substring. The old empty-query sentinel `%` therefore
        // searched for a literal percent sign and returned no indexed
        // agent-chat rows, leaving the Sessions destination empty even when
        // the chat store contained fresh history. Enumerate the current
        // harness's agent chats for the browse-all case, and only invoke
        // content search when the owner supplied a real filter.
        let chats = if let Some(harness) = harness.filter(|value| !value.trim().is_empty()) {
            Some((
                harness.to_string(),
                self.list_agent_chats(
                    harness,
                    &crate::agent_chats::AgentChatListOptions {
                        include_archived: true,
                        limit: Some(100),
                        ..Default::default()
                    },
                )
                .await?,
            ))
        } else {
            None
        };
        let title_match = chats.as_ref().is_some_and(|(_, chats)| {
            let query = query.trim().to_ascii_lowercase();
            !query.is_empty()
                && chats.iter().any(|chat| {
                    chat.title
                        .as_deref()
                        .is_some_and(|title| title.to_ascii_lowercase().contains(&query))
                })
        });
        let search_rows = if !title_match {
            if let Some(args) = session_search_args(query) {
                let env = self.run_tool("sessions:search", args).await?;
                merge_session_switcher_rows(rows, &run_tool_inner_json(&env)?)
            } else {
                rows
            }
        } else {
            rows
        };
        if let Some((harness, chats)) = chats {
            Ok(merge_agent_chat_summaries(
                search_rows,
                &chats,
                &harness,
                query,
            ))
        } else {
            Ok(search_rows)
        }
    }

    /// Resolve transcript availability for one exact roster-native session.
    /// This is the lazy second leg for rows outside the bounded 20-hit seed;
    /// an empty exact result is the only client-side evidence for `unavailable`.
    pub async fn resolve_session_transcript(
        &self,
        target: &models::ConversationContextProjectionTarget,
    ) -> Result<Option<SessionTranscriptResolution>> {
        let env = self
            .run_tool(
                "sessions:search",
                serde_json::json!({
                    "query": "%",
                    "mode": "verbatim",
                    "limit": 1,
                    "context": 0,
                    "session": target.session_id,
                    "source_kind": target.source_kind,
                }),
            )
            .await?;
        let inner = run_tool_inner_json(&env)?;
        session_transcript_resolution(&inner)
    }

    /// Read a canonical transcript reference returned by `sessions:search` and
    /// normalize every backend onto one preview shape.
    pub async fn session_transcript(&self, reference: &str) -> Result<Vec<SessionTranscriptTurn>> {
        let env = self
            .run_tool(
                "sessions:read",
                serde_json::json!({ "ref": reference, "context": 12, "order": "asc" }),
            )
            .await?;
        let inner = run_tool_inner_json(&env)?;
        Ok(session_transcript_turns(&inner))
    }

    pub async fn plans_typed(&self) -> Result<Vec<PlanSummary>> {
        let v = self.plans_list().await?;
        let mut plans = serde_json::from_value::<PlansResponse>(v)
            .context("decode plans")?
            .plans;
        // EI-7430: the `standard` payloadTier appends a synthetic notice row
        // (slug == "(truncated)") when the 150-row recency cap trims the list
        // (list-shape.ts) — the TUI has no use for it (150 rows is already more
        // than any pane renders), so drop it rather than showing a fake plan.
        plans.retain(|p| p.slug != "(truncated)");
        Ok(plans)
    }

    /// Goals for the Plans-tab spine (`GET /api/tui/goals`, P-032): the same
    /// audited GOAL-mode read the GUI uses, flattened for the goals column.
    pub async fn goals_list(&self) -> Result<crate::models::GoalsResponse> {
        let v = self.get_json("/api/tui/goals").await?;
        serde_json::from_value(v).context("decode goals")
    }

    /// Deployed cloud frames (`/api/deploy/frames`) — the per-frame-tab roster
    /// (hive-agent-tabs P-013).
    pub async fn deploy_frames(&self) -> Result<Vec<crate::models::DeployFrameRow>> {
        let v = self.get_json("/api/deploy/frames").await?;
        Ok(
            serde_json::from_value::<crate::models::DeployFramesResponse>(v)
                .context("decode deploy frames")?
                .frames,
        )
    }

    pub async fn attention_typed(&self) -> Result<Vec<AttentionItem>> {
        let v = self.get_json("/api/admin/plans/attention").await?;
        let groups = serde_json::from_value::<AttentionResponse>(v)
            .context("decode attention")?
            .groups;
        Ok(groups.into_iter().flat_map(|g| g.items).collect())
    }

    /// Execute one frozen P-013 Inbox action through the source's owning verb.
    /// `inbox_action_steps` validates that the action existed on the captured
    /// server row before any write occurs; ordered multi-write paths preserve
    /// browser parity (decision then status, delivery then triage).
    pub async fn run_inbox_action(
        &self,
        target: &InboxActionTarget,
        action_id: &str,
        answer_text: Option<&str>,
    ) -> Result<()> {
        for step in inbox_action_steps(target, action_id, answer_text)? {
            match step {
                InboxActionStep::Tool { name, args } => {
                    let envelope = self.run_tool(name, args).await?;
                    let inner = run_tool_inner_json(&envelope)?;
                    if inner.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
                        let error = inner
                            .get("error")
                            .or_else(|| inner.get("detail"))
                            .map(ToString::to_string)
                            .unwrap_or_else(|| format!("{name} refused"));
                        anyhow::bail!(error);
                    }
                    if let Some(failed) = inner
                        .get("results")
                        .and_then(serde_json::Value::as_array)
                        .and_then(|results| {
                            results.iter().find(|row| {
                                row.get("ok").and_then(serde_json::Value::as_bool) == Some(false)
                            })
                        })
                    {
                        let error = failed
                            .get("error")
                            .or_else(|| failed.get("detail"))
                            .map(ToString::to_string)
                            .unwrap_or_else(|| format!("{name} item failed"));
                        anyhow::bail!(error);
                    }
                }
                InboxActionStep::OwnerReply(body) => {
                    let response = self.post_json("/api/admin/coord-inbox-reply", body).await?;
                    if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true)
                        || response
                            .get("delivered")
                            .and_then(serde_json::Value::as_bool)
                            != Some(true)
                    {
                        let error = response
                            .get("error")
                            .map(ToString::to_string)
                            .unwrap_or_else(|| "owner reply did not reach a live asker".into());
                        anyhow::bail!(error);
                    }
                }
                InboxActionStep::Triage { item_id } => {
                    self.resolve_inbox_item(&item_id, "Owner answer delivered from PUI Needs-you")
                        .await?;
                }
            }
        }
        Ok(())
    }

    /// Fleet rate/usage read-model for the Overview top-bar (Brief 23 P-005;
    /// rate-limit-layer-v2 P-013). The `status` half of
    /// GET `/api/operator/rate-limit-config`.
    pub async fn fleet_rate_status(&self) -> Result<models::FleetRateStatus> {
        let v = self.get_json("/api/operator/rate-limit-config").await?;
        let status = v.get("status").cloned().unwrap_or(serde_json::Value::Null);
        serde_json::from_value(status).context("decode fleet rate status")
    }

    /// Read one registered cell through the generic operator tool bridge. A
    /// transport/decode failure stays attached to this cell so the Overview can
    /// render it as unknown without hiding sibling measurements.
    async fn pipeline_cell(&self, cell: &'static str) -> models::PipelineCellRead {
        let result: Result<models::StateCellRead> = async {
            let envelope = self
                .run_tool("state:read", serde_json::json!({ "cell": cell }))
                .await?;
            let inner = run_tool_inner_json(&envelope)?;
            serde_json::from_value(inner)
                .with_context(|| format!("decode state:read response for {cell}"))
        }
        .await;

        match result {
            Ok(read) => models::PipelineCellRead {
                cell: cell.to_string(),
                read: Some(read),
                error: None,
            },
            Err(error) => models::PipelineCellRead {
                cell: cell.to_string(),
                read: None,
                error: Some(error.to_string()),
            },
        }
    }

    /// P-008 Overview pipeline snapshot. All four cells share the canonical
    /// `state:read` door and are fetched concurrently so one slow resolver does
    /// not serialize four copies of the same pipeline probe.
    pub async fn pipeline_status(&self) -> models::PipelineStatus {
        let (gate_verdict, frozen_candidate, main_behind_staging, deployed_sha) = tokio::join!(
            self.pipeline_cell("gate.greenCheckpoint.verdict"),
            self.pipeline_cell("gate.greenCheckpoint.candidate"),
            self.pipeline_cell("git.mainBehindStaging"),
            self.pipeline_cell("deploy.3070.sha"),
        );
        models::PipelineStatus {
            gate_verdict,
            frozen_candidate,
            main_behind_staging,
            deployed_sha,
        }
    }

    /// Edit the user-editable hard cap (`maxSimultaneousAgents`) — persists to
    /// PG and propagates live to the governor + dispatcher (no restart).
    pub async fn set_max_agents(&self, n: u32) -> Result<()> {
        self.put_json(
            "/api/operator/rate-limit-config",
            serde_json::json!({ "maxSimultaneousAgents": n }),
        )
        .await?;
        Ok(())
    }

    /// Features via the `list_features` agent-tool (MCP envelope unwrapped).
    pub async fn features_for(&self, slug: &str) -> Result<Vec<HarnessFeature>> {
        let env = self
            .post_json(
                "/api/agent-tools/harness/list_features",
                serde_json::json!({ "slug": slug }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("list_features: missing content[0].text")?;
        Ok(serde_json::from_str::<FeaturesPayload>(text)
            .context("parse features payload")?
            .features)
    }

    /// TUI panes plugins contribute (D-002) via the `plugins:tui_panes`
    /// agent-tool (MCP envelope unwrapped, exactly like `features_for`).
    pub async fn tui_panes_for(&self, slug: &str) -> Result<Vec<models::TuiPaneContribution>> {
        let env = self
            .post_json(
                "/api/agent-tools/plugins/tui_panes",
                serde_json::json!({ "harness": slug }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("tui_panes: missing content[0].text")?;
        Ok(serde_json::from_str::<TuiPanesPayload>(text)
            .context("parse tui_panes payload")?
            .panes)
    }

    /// P2P voice channel registry via the `voice:channels` agent-tool
    /// (holepunch-voice-channels P-008). MCP envelope → inner `{ok,channels}`.
    pub async fn voice_channels_list(&self) -> Result<Vec<crate::voice_ui::VoiceChannelRow>> {
        let env = self
            .post_json(
                "/api/agent-tools/voice/channels",
                serde_json::json!({ "op": "list" }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("voice:channels: missing content[0].text")?;
        #[derive(serde::Deserialize)]
        struct P {
            channels: Vec<crate::voice_ui::VoiceChannelRow>,
        }
        Ok(serde_json::from_str::<P>(text)
            .context("parse voice channels")?
            .channels)
    }

    /// Create a voice channel by name, returning the refreshed list.
    pub async fn voice_channel_create(
        &self,
        name: &str,
    ) -> Result<Vec<crate::voice_ui::VoiceChannelRow>> {
        let _ = self
            .post_json(
                "/api/agent-tools/voice/channels",
                serde_json::json!({ "op": "create", "name": name }),
            )
            .await?;
        self.voice_channels_list().await
    }

    /// Read the operator voice-prefs (the Voice Settings overlay, P-017).
    pub async fn voice_prefs_get(&self) -> Result<crate::voice_ui::VoicePrefsView> {
        let env = self
            .post_json(
                "/api/agent-tools/operator/voice_prefs",
                serde_json::json!({ "op": "get" }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("voice_prefs: missing content[0].text")?;
        serde_json::from_str::<crate::voice_ui::VoicePrefsView>(text).context("parse voice prefs")
    }

    /// Patch one voice-pref field, returning the refreshed view.
    pub async fn voice_prefs_set(
        &self,
        key: &str,
        value: serde_json::Value,
    ) -> Result<crate::voice_ui::VoicePrefsView> {
        let _ = self
            .post_json(
                "/api/agent-tools/operator/voice_prefs",
                serde_json::json!({ "op": "set", "patch": { key: value } }),
            )
            .await?;
        self.voice_prefs_get().await
    }

    pub async fn issues_for(&self, slug: &str) -> Result<Vec<HarnessIssue>> {
        let v = self
            .get_json(&format!("/api/harness/{slug}/issues"))
            .await?;
        Ok(serde_json::from_value::<IssuesResponse>(v)
            .context("decode issues")?
            .issues)
    }

    /// Conversations (Brief 25) via the `conversations:list` agent-tool — optional
    /// state/kind/topic filters; MCP envelope unwrapped like `features_for`. Each
    /// row carries its topic tags + the promoted-issue link (D-002/D-004).
    pub async fn conversations_list(
        &self,
        state: Option<&str>,
        kind: Option<&str>,
        topic: Option<&str>,
    ) -> Result<Vec<ConvSummary>> {
        let mut body = serde_json::Map::new();
        if let Some(s) = state {
            body.insert("state".into(), serde_json::json!(s));
        }
        if let Some(k) = kind {
            body.insert("kind".into(), serde_json::json!(k));
        }
        if let Some(t) = topic {
            if !t.is_empty() {
                body.insert("topic".into(), serde_json::json!(t));
            }
        }
        let env = self
            .post_json(
                "/api/agent-tools/conversations/list",
                serde_json::Value::Object(body),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("conversations:list: missing content[0].text")?;
        Ok(serde_json::from_str::<ConvListResponse>(text)
            .context("parse conversations payload")?
            .conversations)
    }

    /// Full conversation detail (seed + topics + thread + accepted answer + the
    /// linked work-item) via the `conversations:get` agent-tool.
    pub async fn conversation_get(&self, id: &str) -> Result<ConvDetail> {
        let env = self
            .post_json(
                "/api/agent-tools/conversations/get",
                serde_json::json!({ "id": id }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("conversations:get: missing content[0].text")?;
        parse_conversation_get_payload(text, id)
    }

    /// Promote a conversation into an engineer issue (carries its thread). Returns
    /// the new issue id, or an Err carrying the tool's `reason` on failure.
    pub async fn conversation_promote(&self, id: &str) -> Result<String> {
        let env = self
            .post_json(
                "/api/agent-tools/conversations/promote",
                serde_json::json!({ "conversation_id": id }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("conversations:promote: missing content[0].text")?;
        let v: serde_json::Value = serde_json::from_str(text).context("parse promote result")?;
        if v.get("ok").and_then(|b| b.as_bool()) == Some(false) {
            let reason = v
                .get("reason")
                .and_then(|r| r.as_str())
                .unwrap_or("promote_failed");
            return Err(anyhow!("promote failed: {reason}"));
        }
        Ok(v.get("issue")
            .and_then(|i| i.get("id"))
            .and_then(|i| i.as_str())
            .unwrap_or("")
            .to_string())
    }

    /// "Message owner" (inbox-tiering D-004): open a work-item-scoped conversation
    /// with an attention item's owning agent via the /api/admin/coord proxy
    /// (coord:message-agent). The admin proxy unwraps the MCP envelope, so the
    /// response is the plain `{ ok, conversation_id, … }`. Returns the new
    /// conversation id (browsable in the Conversations tab).
    pub async fn message_agent(
        &self,
        to: Option<&str>,
        harness: Option<&str>,
        plan_slug: Option<&str>,
        item_ref: Option<&str>,
        title: &str,
        body: &str,
    ) -> Result<String> {
        let mut payload = serde_json::Map::new();
        if let Some(t) = to {
            payload.insert("to".into(), serde_json::json!(t));
        }
        payload.insert("body".into(), serde_json::json!(body));
        if let Some(h) = harness {
            payload.insert("harness".into(), serde_json::json!(h));
        }
        if let Some(p) = plan_slug {
            payload.insert("plan_slug".into(), serde_json::json!(p));
        }
        if let Some(r) = item_ref {
            payload.insert("item_ref".into(), serde_json::json!(r));
        }
        let title_trunc: String = title.chars().take(120).collect();
        payload.insert("title".into(), serde_json::json!(title_trunc));
        let v = self
            .post_json(
                "/api/admin/coord/message-agent",
                serde_json::Value::Object(payload),
            )
            .await?;
        if v.get("ok").and_then(|b| b.as_bool()) == Some(false) {
            let err = v
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("message_failed");
            return Err(anyhow!("message owner failed: {err}"));
        }
        Ok(v.get("conversation_id")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string())
    }

    /// Triage-resolve one attention item (EI-50: TUI parity with the desktop
    /// detail-pane's inbox Resolve) via the /api/admin/inbox proxy
    /// (inbox:triage `{ itemId, action: "resolve", note }`). Generic across
    /// every attention kind — the same overlay the desktop uses, so no
    /// per-kind branching is needed here. `note` is required by the tool on
    /// resolve; caller must not pass an empty string.
    ///
    /// inbox:triage is a BULK tool even for this n=1 call: its top-level `ok`
    /// is unconditionally `true` (runBulk's envelope), so a failure surfaces
    /// ONLY in `results[0].ok`/`.error` — checking the top-level flag alone
    /// would silently swallow every resolve failure.
    pub async fn resolve_inbox_item(&self, item_id: &str, note: &str) -> Result<()> {
        let payload = serde_json::json!({
            "itemId": item_id,
            "action": "resolve",
            "note": note,
        });
        let v = self.post_json("/api/admin/inbox/triage", payload).await?;
        let first = v
            .get("results")
            .and_then(|r| r.as_array())
            .and_then(|a| a.first());
        let item_ok = first.and_then(|it| it.get("ok")).and_then(|b| b.as_bool());
        if v.get("ok").and_then(|b| b.as_bool()) == Some(false) || item_ok == Some(false) {
            let err = first
                .and_then(|it| it.get("error"))
                .and_then(|e| e.as_str())
                .or_else(|| v.get("error").and_then(|e| e.as_str()))
                .unwrap_or("triage_failed");
            return Err(anyhow!("resolve failed: {err}"));
        }
        Ok(())
    }

    pub async fn harnesses(&self) -> Result<Vec<HarnessRef>> {
        let v = self.get_json("/api/harness/projects/lite").await?;
        Ok(serde_json::from_value::<ProjectsResponse>(v)
            .context("decode projects")?
            .projects)
    }

    /// Operator feature flags + values for the read-only Settings tab (P10).
    pub async fn flags(&self) -> Result<FlagsResponse> {
        let v = self.get_json("/api/flags/bootstrap").await?;
        serde_json::from_value::<FlagsResponse>(v).context("decode flags")
    }

    /// Merged plan-item assignment/claim/liveness for one plan (P-005a). Read-only
    /// surface over plan-item-assignment-claim-liveness-2026-06-04 — backs the
    /// per-item disposition markers in the Plans detail pane.
    pub async fn plan_item_states(&self, harness: &str, plan: &str) -> Result<PlanItemStates> {
        let v = self
            .get_json(&format!(
                "/api/tui/plan-item-states?harness={}&plan={}",
                urlencode(harness),
                urlencode(plan)
            ))
            .await?;
        serde_json::from_value::<PlanItemStates>(v).context("decode plan-item states")
    }

    /// Convert-at-pickup (project-centric-harness-rethink D-015): pick up a plan
    /// item by converting it to a claimed work_item — the WRITE half of the
    /// plan-item surface (`plan_item_states` is the read half). POSTs
    /// /api/tui/plan-item-convert, which dispatches the `plan_items:convert`
    /// tool (lease + mint/resume + claim + back-link; emits fire server-side).
    /// Returns the tool's JSON payload: `{ ok, status, workItem, claim, … }` on
    /// success, `{ ok:false, status:'refused'|'conflict', … }` otherwise.
    pub async fn plan_item_convert(
        &self,
        owner: &str,
        harness: &str,
        plan: &str,
        item: &str,
    ) -> Result<serde_json::Value> {
        self.post_json(
            "/api/tui/plan-item-convert",
            serde_json::json!({ "owner": owner, "harness": harness, "plan": plan, "item": item }),
        )
        .await
    }

    /// Put a picked-up plan item back (P-005b release half — the `:pickup`
    /// inverse). POSTs /api/tui/plan-item-release, which releases the
    /// converted work_item via `work_items:release` (server-side reflect rules
    /// flip the item back to todo + drop the lease) or, with no live execution
    /// record, drops the bare plan-item lease via `plan_items:release`.
    /// Returns the tool's JSON payload stamped with `via`:
    /// `{ ok, via, workItem?, released?, note?, … }`.
    pub async fn plan_item_release(
        &self,
        owner: &str,
        harness: &str,
        plan: &str,
        item: &str,
    ) -> Result<serde_json::Value> {
        self.post_json(
            "/api/tui/plan-item-release",
            serde_json::json!({ "owner": owner, "harness": harness, "plan": plan, "item": item }),
        )
        .await
    }

    /// Read-only operator-config overview (P10b): the AI backend + per-role models
    /// (`/api/agent-config`) and which speech providers are connected
    /// (`operator:credentials_status` — booleans, never secret values). Assembled
    /// from two reads; a partial failure still returns what loaded (a read-only
    /// overview degrades to "—" rather than erroring the whole Settings tab).
    pub async fn operator_config(&self) -> Result<OperatorConfig> {
        let agent = match self.get_json("/api/agent-config").await {
            Ok(v) => serde_json::from_value::<AgentConfigResponse>(v).ok(),
            Err(_) => None,
        };
        let providers = match self
            .post_json(
                "/api/agent-tools/operator/credentials_status",
                serde_json::json!({}),
            )
            .await
        {
            Ok(env) => {
                let text = env
                    .get("content")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("{}");
                let map: std::collections::BTreeMap<String, models::CredStatus> =
                    serde_json::from_str(text).unwrap_or_default();
                map.into_iter().map(|(k, v)| (k, v.set)).collect()
            }
            Err(_) => Vec::new(),
        };
        // `/api/agent-config` already carries the server-computed effective
        // tier menu. Reuse it instead of issuing `config:tiers-get`: that tool
        // rides the generic palette route, whose cold registry initialization
        // can otherwise delay the startup picker beyond its deadline. A failed
        // config read remains an empty menu (the honest unknown state).
        let tiers = agent
            .as_ref()
            .map(|response| response.effective_tiers.clone())
            .unwrap_or_default();
        Ok(OperatorConfig {
            agent,
            providers,
            tiers,
        })
    }

    // --- Fleet status view (pui-fleet-status-view-2026-06-04) ---

    /// Fleet-wide work items via the `work_items:list` agent-tool (unify-work-
    /// items; MCP envelope unwrapped, exactly like `features_for`). No filters →
    /// the whole fleet (features + issues + chunks). The legacy full-list entry
    /// point remains for explicit refreshes; startup uses the bounded variant so
    /// the first paint never waits on the entire queue.
    pub async fn work_items_list(&self) -> Result<Vec<WorkItem>> {
        self.work_items_list_bounded(500).await
    }

    /// Read a bounded current work-item snapshot. P-003's first-paint path uses
    /// this smaller window, then the normal refetch reconciles the full list in
    /// the background. Keeping the limit at the client seam makes the response
    /// shape and budget explicit instead of relying on a server default.
    pub async fn work_items_list_bounded(&self, limit: u32) -> Result<Vec<WorkItem>> {
        let limit = limit.clamp(1, 500);
        let env = self
            .post_json(
                "/api/agent-tools/work_items/list",
                work_items_list_args(limit),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("work_items:list: missing content[0].text")?;
        parse_work_items_list_payload(text)
    }

    /// Recent worker-activity rows via the `activity:recent` agent-tool (worker-
    /// integration; the pull-side companion to the /api/activity/stream SSE; MCP
    /// envelope unwrapped). `kind` scopes to tool|lifecycle|todos; None → all.
    pub async fn activity_recent(
        &self,
        kind: Option<&str>,
        limit: u32,
    ) -> Result<Vec<ActivityRow>> {
        let mut body = serde_json::json!({ "limit": limit });
        if let Some(k) = kind {
            body["kind"] = serde_json::Value::String(k.to_string());
        }
        let env = self
            .post_json("/api/agent-tools/activity/recent", body)
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("activity:recent: missing content[0].text")?;
        Ok(serde_json::from_str::<ActivityRecentPayload>(text)
            .context("parse activity payload")?
            .activity)
    }

    /// Subscribe to the live worker-activity SSE (`/api/activity/stream`). Each
    /// `activity` frame's `data` is an `ActivityRow`. No filter → the whole fleet;
    /// the stream pushes only rows that arrive AFTER connect (seed history via
    /// `activity_recent`).
    pub async fn subscribe_activity(&self) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        self.subscribe_sse("/api/activity/stream").await
    }

    // ─── Bee-dossier dock pane (pui-bee-dossier-pane-2026-06-06) ───
    // The dossier renders the selected agent's ranked work-list
    // (fleet:assignments) + coord inbox/outbox (coord:feed, split client-side).
    // Selection is in-process (Fleet-tab roster cursor) — the old
    // fleet:selected_bee relay + fleet:bee_mail were retired with the bee tier
    // (P-003 own-tui-full-divorce-2026-08-24).

    /// The selected bee's ordered work-list via `fleet:assignments { agent }`
    /// (MCP envelope unwrapped). Returns the matching `AgentAssignment` (or None
    /// when the bee holds nothing / isn't present).
    pub async fn bee_assignment(&self, owner_id: &str) -> Result<Option<BeeAssignment>> {
        let env = self
            .post_json(
                "/api/agent-tools/fleet/assignments",
                serde_json::json!({ "agent": owner_id, "include_stale": true }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("fleet:assignments: missing content[0].text")?;
        let payload: FleetAssignmentsPayload =
            serde_json::from_str(text).context("parse fleet assignments payload")?;
        // The `agent` filter returns just this bee, but match defensively on id/name.
        Ok(payload
            .agents
            .into_iter()
            .find(|a| a.agent_id == owner_id || a.name.as_deref() == Some(owner_id)))
    }

    /// The federated p2p roster — every remote hive announced into
    /// `shared_presence`, via the unified `coord:roster { view: "live" }`
    /// lens (MCP envelope unwrapped). Local (non-federated) session rows are
    /// dropped; stale federated rows remain in the unified active projection
    /// and stay marked on each row (pui-hives-tab-2026-06-07).
    pub async fn federated_hives(&self) -> Result<Vec<crate::models::PresenceRow>> {
        let (path, body) = federated_hives_request();
        let env = self.post_json(path, body).await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("coord:roster: missing content[0].text")?;
        parse_federated_hives(text)
    }

    /// The P2P hive directory — verified hives announced on the well-known
    /// directory topic (`GET /api/discovery/pots`, p2p-hive-directory P-006).
    pub async fn discovered_hives(&self) -> Result<Vec<crate::models::DiscoveredHiveRow>> {
        let v = self.get_json("/api/discovery/pots").await?;
        let resp: crate::models::DiscoveredHivesResponse =
            serde_json::from_value(v).context("parse discovered-hives response")?;
        Ok(resp.rows)
    }

    /// The cross-Hive network board (hive-network-surface-2026-06-11 P-006):
    /// one pinned-C-3 row per hive-context over the capability ladder. The
    /// live surface is B-08's NAMED SYNC QUERY `network.board` over the
    /// zero-harness rest-query route (announced coord 2026-06-11 — there is
    /// deliberately no raw route); its invalidations ride the same
    /// `/api/zero-harness/sse` stream the refetch loop already subscribes, so
    /// freshness is the standard pui convention (SSE invalidate + 60s safety
    /// net). Response: `{ rows: NetworkBoardRow[], version }`.
    pub async fn network_board(&self) -> Result<Vec<crate::models::NetworkBoardRow>> {
        let v = self
            .get_json("/api/zero-harness/rest-query?name=network.board&args=%7B%7D")
            .await?;
        let resp: crate::models::NetworkBoardResponse =
            serde_json::from_value(v).context("parse network-board response")?;
        Ok(resp.rows)
    }

    /// One named sync query over the zero-harness rest-query route, returning
    /// its `rows` (`{ rows, version }` envelope — version unused; the SSE
    /// invalidate stream drives the refetch cadence, not row versions).
    async fn rest_query_rows<T: serde::de::DeserializeOwned>(
        &self,
        name: &str,
        args: &serde_json::Value,
    ) -> Result<Vec<T>> {
        let v = self
            .get_json(&format!(
                "/api/zero-harness/rest-query?name={}&args={}",
                name,
                urlencode(&args.to_string())
            ))
            .await?;
        let rows = v
            .get("rows")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        serde_json::from_value(rows).with_context(|| format!("parse {name} rows"))
    }

    /// Read the one server-normalized context projection consumed by both pui
    /// and the operator GUI. An empty row set is a supported capability-tier
    /// absence, not an error and not permission to synthesize local frames.
    pub async fn conversation_context_projection(
        &self,
        target: &crate::models::ConversationContextProjectionTarget,
    ) -> Result<Option<crate::models::ConversationContextProjection>> {
        let mut args = serde_json::json!({
            "sourceKind": target.source_kind,
            "sessionId": target.session_id,
        });
        if let Some(harness) = &target.harness {
            args["harness"] = serde_json::Value::String(harness.clone());
        }
        let rows = self
            .rest_query_rows::<crate::models::ConversationContextProjection>(
                "conversations.contextProjection",
                &args,
            )
            .await?;
        Ok(rows.into_iter().next())
    }

    /// A foreign hive's beacon HISTORY (`network.hive.beacons`, hive-network-
    /// surface P-014 item 2): captured C-2 snapshots newest-first. `hive_key`
    /// is the C-3 tier-4 row key (pubkey-b64 or hiveId — either resolves).
    pub async fn hive_beacons(
        &self,
        hive_key: &str,
    ) -> Result<Vec<crate::models::HiveBeaconSnapshot>> {
        self.rest_query_rows(
            "network.hive.beacons",
            &serde_json::json!({ "hiveKey": hive_key }),
        )
        .await
    }

    /// The full C-1 ask log (`network.hive.asks`, P-014 item 2), newest-first,
    /// narrowed to one peer pubkey — the tier-4 dossier's traffic view.
    pub async fn hive_asks(
        &self,
        peer_pubkey: &str,
    ) -> Result<Vec<crate::models::CrossHiveAskRow>> {
        self.rest_query_rows(
            "network.hive.asks",
            &serde_json::json!({ "peerPubkey": peer_pubkey }),
        )
        .await
    }

    /// The hive-SCOPED staged-wake queue (`network.hive.wakes`, P-014 item 3 /
    /// D-007 GAP 1): every hive-attributed owner's pending wakes, filtered
    /// server-side (owner ASC, oldest-first — assemble groups per owner).
    pub async fn hive_wakes(&self, hive: &str) -> Result<Vec<crate::models::PendingWake>> {
        self.rest_query_rows("network.hive.wakes", &serde_json::json!({ "hive": hive }))
            .await
    }

    /// The FLEET-WIDE staged-wake queue (`network.fleet.wakes`, EI-597 Step B):
    /// every owner's pending wakes in the active workspace — the SSE-rail
    /// replacement for the non-Hive scopes' old `coord:wake-queue{action:list}`
    /// poll. The caller's existing client-side `filter_wake_groups` narrows it to
    /// the fleet/queen/owner scope, so this is payload-equivalent to the poll.
    pub async fn fleet_wakes(&self) -> Result<Vec<crate::models::PendingWake>> {
        self.rest_query_rows("network.fleet.wakes", &serde_json::json!({}))
            .await
    }

    /// Join one member harness of a discovered hive (`POST /api/harness/join-link`).
    /// The joiner's GitHub identity + device keychain are resolved server-side.
    pub async fn join_hive_link(
        &self,
        slug: &str,
        harness_link_url: &str,
    ) -> Result<serde_json::Value> {
        self.post_json(
            "/api/harness/join-link",
            serde_json::json!({ "slug": slug, "harnessLinkUrl": harness_link_url }),
        )
        .await
    }

    /// Whole-fleet assignments — every bee's ranked work-list in one call
    /// (`fleet:assignments {}` with NO `agent` filter). Drives the default Swarm
    /// dossier (pui-dock-consolidation-2026-06-07 #2 "show all tasks from the
    /// fleet"); a roster selection narrows to one bee via `bee_assignment`.
    pub async fn fleet_assignments_all(&self) -> Result<Vec<BeeAssignment>> {
        let env = self
            .post_json(
                "/api/agent-tools/fleet/assignments",
                serde_json::json!({ "include_stale": true }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("fleet:assignments: missing content[0].text")?;
        let payload: FleetAssignmentsPayload =
            serde_json::from_str(text).context("parse fleet assignments payload")?;
        Ok(payload.agents)
    }

    /// Whole-harness actionable frontier. The stock/bucket truth comes from the
    /// canonical `work_items:burn_down` writer; READY NOW's downstream-gate count
    /// is enriched by one batched detail read rather than N per-row calls.
    pub async fn work_frontier(&self, harness: &str) -> Result<WorkFrontier> {
        let envelope = self
            .run_tool(
                "work_items:burn_down",
                work_frontier_burn_down_args(harness),
            )
            .await?;
        let mut frontier: WorkFrontier = serde_json::from_value(run_tool_inner_json(&envelope)?)
            .context("decode work_items:burn_down frontier")?;

        let ids: Vec<String> = frontier
            .unclaimed
            .iter()
            .map(|row| row.id.clone())
            .filter(|id| !id.is_empty())
            .collect();
        if !ids.is_empty() {
            let detail = self
                .run_tool("work_items:get", work_frontier_detail_args(ids, harness))
                .await?;
            apply_frontier_block_counts(&mut frontier, &run_tool_inner_json(&detail)?);
        }
        Ok(frontier)
    }

    /// The prompt an agent runs on (`GET /api/fleet/agent-prompt`, dock
    /// prompt-pane): a spawn's recorded prompt_body + brief/model/tier, or a
    /// live role-persona render when only a `role` hint is available (the
    /// interactive queen). Returns the raw JSON — the caller maps fields.
    pub async fn agent_prompt(
        &self,
        owner: Option<&str>,
        role: Option<&str>,
    ) -> Result<serde_json::Value> {
        let mut q: Vec<String> = Vec::new();
        if let Some(o) = owner {
            q.push(format!("owner={}", urlencode(o)));
        }
        if let Some(r) = role {
            q.push(format!("role={}", urlencode(r)));
        }
        self.get_json(&format!("/api/fleet/agent-prompt?{}", q.join("&")))
            .await
    }

    /// The selected agent's coord inbox + outbox via `coord:feed { owner }`
    /// (MCP envelope unwrapped). The feed matches envelopes where the owner is
    /// sender OR recipient (broadcasts included); the inbox/outbox split happens
    /// here — outbox = sent BY the owner, inbox = everything else (addressed to
    /// it, or broadcast at it). Replaces the RETIRED `fleet:bee_mail` transport
    /// (the bee/nursery tier is gone — P-003 own-tui-full-divorce-2026-08-24;
    /// verified live: the old path answers `unknown_tool`).
    pub async fn bee_mail(&self, owner_id: &str, limit: u32) -> Result<BeeMailPayload> {
        let env = self
            .post_json(
                "/api/agent-tools/coord/feed",
                serde_json::json!({ "owner": owner_id, "limit": limit }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("coord:feed: missing content[0].text")?;
        let feed: CoordFeedPayload =
            serde_json::from_str(text).context("parse coord feed payload")?;
        let (outbox, inbox): (Vec<BeeMailEntry>, Vec<BeeMailEntry>) = feed
            .rows
            .into_iter()
            .partition(|r| r.from.as_deref() == Some(owner_id));
        Ok(BeeMailPayload {
            owner_id: owner_id.to_string(),
            inbox: BeeMailSide {
                total: inbox.len(),
                entries: inbox,
            },
            outbox: BeeMailSide {
                total: outbox.len(),
                entries: outbox,
            },
        })
    }

    /// The active brand pack's term→label map via `lexicon:active_pack`
    /// (pui-hive-lexicon-2026-06-06; MCP envelope unwrapped). Fetched once at
    /// startup; the pui falls back to its built-in classic labels on any error.
    pub async fn lexicon_active_pack(&self) -> Result<LexiconPackPayload> {
        let env = self
            .post_json(
                "/api/agent-tools/lexicon/active_pack",
                serde_json::json!({}),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("lexicon:active_pack: missing content[0].text")?;
        serde_json::from_str::<LexiconPackPayload>(text).context("parse lexicon pack payload")
    }

    // --- Workbench persistence (P12 / D-002): /api/tui/* ---

    /// The quiet UI/nav state for `owner` (`ViewState::default()` if none saved).
    pub async fn get_view_state(&self, owner: &str) -> Result<ViewState> {
        let v = self
            .get_json(&format!("/api/tui/view-state?owner={}", urlencode(owner)))
            .await?;
        Ok(serde_json::from_value::<ViewStateResponse>(v)
            .context("decode view-state")?
            .state)
    }

    /// Upsert the quiet UI/nav state for `owner`.
    pub async fn put_view_state(&self, owner: &str, state: &ViewState) -> Result<()> {
        self.put_json(
            "/api/tui/view-state",
            serde_json::json!({ "owner": owner, "state": state }),
        )
        .await?;
        Ok(())
    }

    pub async fn list_layouts(&self, owner: &str) -> Result<Vec<LayoutSummary>> {
        let v = self
            .get_json(&format!("/api/tui/layouts?owner={}", urlencode(owner)))
            .await?;
        Ok(serde_json::from_value::<LayoutsResponse>(v)
            .context("decode layouts")?
            .layouts)
    }

    pub async fn get_layout(&self, owner: &str, name: &str) -> Result<Option<LayoutRow>> {
        let v = self
            .get_json(&format!(
                "/api/tui/layouts/{}?owner={}",
                urlencode(name),
                urlencode(owner)
            ))
            .await?;
        if v.get("error").is_some() {
            return Ok(None);
        }
        Ok(Some(
            serde_json::from_value::<LayoutRow>(v).context("decode layout")?,
        ))
    }

    pub async fn save_layout(
        &self,
        owner: &str,
        name: &str,
        kdl: &str,
        description: Option<&str>,
    ) -> Result<()> {
        self.put_json(
            "/api/tui/layouts",
            serde_json::json!({ "owner": owner, "name": name, "kdl": kdl, "description": description }),
        )
        .await?;
        Ok(())
    }

    pub async fn delete_layout(&self, owner: &str, name: &str) -> Result<()> {
        self.delete_json(&format!(
            "/api/tui/layouts/{}?owner={}",
            urlencode(name),
            urlencode(owner)
        ))
        .await?;
        Ok(())
    }

    pub async fn list_crews(&self, owner: &str) -> Result<Vec<CrewSummary>> {
        let v = self
            .get_json(&format!("/api/tui/crews?owner={}", urlencode(owner)))
            .await?;
        Ok(serde_json::from_value::<CrewsResponse>(v)
            .context("decode crews")?
            .crews)
    }

    pub async fn get_crew(&self, owner: &str, name: &str) -> Result<Option<CrewRow>> {
        let v = self
            .get_json(&format!(
                "/api/tui/crews/{}?owner={}",
                urlencode(name),
                urlencode(owner)
            ))
            .await?;
        if v.get("error").is_some() {
            return Ok(None);
        }
        Ok(Some(
            serde_json::from_value::<CrewRow>(v).context("decode crew")?,
        ))
    }

    pub async fn save_crew(
        &self,
        owner: &str,
        name: &str,
        members: &[CrewMember],
        layout_name: Option<&str>,
        description: Option<&str>,
    ) -> Result<()> {
        self.put_json(
            "/api/tui/crews",
            serde_json::json!({
                "owner": owner,
                "name": name,
                "members": members,
                "layout_name": layout_name,
                "description": description,
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn delete_crew(&self, owner: &str, name: &str) -> Result<()> {
        self.delete_json(&format!(
            "/api/tui/crews/{}?owner={}",
            urlencode(name),
            urlencode(owner)
        ))
        .await?;
        Ok(())
    }

    /// Subscribe to this pui's agent-intent SSE stream (P12b / tui:dispatch).
    pub async fn subscribe_intents(
        &self,
        owner: &str,
    ) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        self.subscribe_sse(&format!(
            "/api/tui/intents/stream?client_id={}",
            urlencode(owner)
        ))
        .await
    }

    /// POST an applied agent-intent result back (P12b / tui:dispatch). `result_json`
    /// is the JSON result payload; `error` is set on failure.
    pub async fn post_intent_result(
        &self,
        id: i64,
        result_json: &str,
        error: Option<&str>,
    ) -> Result<()> {
        let result: serde_json::Value =
            serde_json::from_str(result_json).unwrap_or(serde_json::Value::Null);
        self.post_json(
            &format!("/api/tui/intents/{id}/result"),
            serde_json::json!({ "result": result, "error": error }),
        )
        .await?;
        Ok(())
    }

    pub async fn docs_for(&self, slug: &str, path: Option<&str>) -> Result<DocsResponse> {
        // Merged docs tree (harness-docs-integration-2026-06-05): generated · manual ·
        // augmented with per-doc source + drift status + the active overlay. Supersedes
        // the FS-only /project-docs read. Cached status (the git-sync sweep keeps it
        // fresh) — no per-fetch recompute, so the poller stays cheap.
        let p = match path {
            Some(rel) => format!("/api/harness/{slug}/docs?path={}", urlencode(rel)),
            None => format!("/api/harness/{slug}/docs"),
        };
        let v = self.get_json(&p).await?;
        serde_json::from_value::<DocsResponse>(v).context("decode docs")
    }

    /// POST a docs action (regenerate | verify) for one doc (P-009 actions).
    pub async fn docs_action(
        &self,
        slug: &str,
        action: &str,
        doc_id: &str,
    ) -> Result<serde_json::Value> {
        let path = format!("/api/harness/{slug}/docs/{action}");
        self.post_json(&path, serde_json::json!({ "docId": doc_id }))
            .await
    }

    pub async fn testing_domains(&self, slug: &str) -> Result<Vec<TestingDomain>> {
        let v = self
            .get_json(&format!("/api/harness/{slug}/testing/domains"))
            .await?;
        Ok(serde_json::from_value::<TestingResponse>(v)
            .context("decode testing domains")?
            .domains)
    }

    /// The runnable file paths of one testing domain (D-004a): domain-detail's
    /// sections flattened to their glob-walked file paths.
    pub async fn testing_domain_files(&self, slug: &str, domain_id: &str) -> Result<Vec<String>> {
        let v = self
            .get_json(&format!(
                "/api/harness/{slug}/testing/domain-detail?domainId={}",
                urlencode(domain_id)
            ))
            .await?;
        let detail = serde_json::from_value::<models::TestingDomainDetail>(v)
            .context("decode domain detail")?;
        Ok(detail
            .sections
            .into_iter()
            .flat_map(|s| s.files)
            .map(|f| f.path)
            .collect())
    }

    /// Run one test file in the harness worktree (D-004a). The backend runs
    /// vitest SYNCHRONOUSLY (up to ~120s) and returns status + tail output.
    pub async fn testing_run(&self, slug: &str, file: &str) -> Result<models::TestRunResult> {
        let v = self
            .post_json(
                &format!("/api/harness/{slug}/testing/run"),
                serde_json::json!({ "runner": { "kind": "vitest", "filePath": file } }),
            )
            .await?;
        serde_json::from_value::<models::TestRunResult>(v).context("decode test run result")
    }

    /// Start one test file through the observable detached harness lifecycle.
    /// The returned run id is used by the status poller and cancellation route.
    pub async fn testing_run_detached(
        &self,
        slug: &str,
        file: &str,
    ) -> Result<models::TestRunSnapshot> {
        let v = self
            .post_json(
                &format!("/api/harness/{slug}/testing/run-detached"),
                serde_json::json!({ "filePath": file }),
            )
            .await?;
        serde_json::from_value::<models::TestRunSnapshot>(v)
            .context("decode detached test run start")
    }

    /// Read the current rolling snapshot for one detached test run.
    pub async fn testing_run_status(
        &self,
        slug: &str,
        run_id: &str,
    ) -> Result<models::TestRunSnapshot> {
        let v = self
            .get_json(&format!(
                "/api/harness/{slug}/testing/run-detached/{}",
                urlencode(run_id)
            ))
            .await?;
        serde_json::from_value::<models::TestRunSnapshot>(v)
            .context("decode detached test run status")
    }

    /// Request cancellation of one detached test run.  A false response means
    /// the run was already terminal (or evicted), so the status poller remains
    /// the authority for the final UI state.
    pub async fn testing_run_cancel(&self, slug: &str, run_id: &str) -> Result<bool> {
        let v = self
            .post_json(
                &format!(
                    "/api/harness/{slug}/testing/run-detached/{}/cancel",
                    urlencode(run_id)
                ),
                serde_json::json!({}),
            )
            .await?;
        Ok(v.get("ok")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false))
    }

    /// The effective Config-tab view (D-013): Claude Code defaults overlaid by
    /// the harness's `.claude/settings.json`, plus the raw file body for edits.
    pub async fn claude_settings_effective(
        &self,
        slug: &str,
    ) -> Result<models::EffectiveClaudeSettings> {
        let v = self
            .get_json(&format!("/api/harness/{slug}/claude-settings/effective"))
            .await?;
        serde_json::from_value::<models::EffectiveClaudeSettings>(v)
            .context("decode claude-settings effective")
    }

    /// Write `.claude/settings.json` for a harness (D-013). Empty content
    /// deletes the file (the backend clears the PG row + unlinks the mirror).
    pub async fn put_claude_settings(&self, slug: &str, content: &str) -> Result<()> {
        let v = self
            .put_json(
                &format!("/api/harness/{slug}/claude-settings"),
                serde_json::json!({ "content": content }),
            )
            .await?;
        if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
            Ok(())
        } else {
            anyhow::bail!(
                "put claude-settings: {}",
                v.get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("unknown error")
            )
        }
    }

    // ─── Plugins tab (D-007 contributions + D-014 settings) ───

    /// All installed plugin manifests (`GET /api/plugins/global`) — identity +
    /// contribution surfaces + configSchema for the Plugins tab.
    pub async fn plugins_global(&self) -> Result<Vec<models::PluginManifest>> {
        let v = self.get_json("/api/plugins/global").await?;
        let plugins = serde_json::from_value::<models::PluginsGlobalResponse>(v)
            .context("decode plugins global")?
            .plugins;
        Ok(filter_lock_resolve_fixtures(plugins))
    }

    /// One plugin's saved per-harness config (D-014). Empty object when unset.
    pub async fn plugin_config(&self, harness: &str, plugin: &str) -> Result<serde_json::Value> {
        let v = self
            .get_json(&format!(
                "/api/plugins/config?harness={}&plugin={}",
                urlencode(harness),
                urlencode(plugin)
            ))
            .await?;
        Ok(serde_json::from_value::<models::PluginConfigResponse>(v)
            .context("decode plugin config")?
            .config)
    }

    /// Save a plugin's per-harness config (D-014) — the same `PUT
    /// /api/plugins/config` the desktop form uses (validates against the
    /// manifest's configSchema server-side; mirrors to PG encrypted).
    pub async fn put_plugin_config(
        &self,
        harness: &str,
        plugin: &str,
        config: &serde_json::Value,
    ) -> Result<()> {
        let v = self
            .put_json(
                "/api/plugins/config",
                serde_json::json!({ "harness": harness, "plugin": plugin, "config": config }),
            )
            .await?;
        if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
            Ok(())
        } else {
            anyhow::bail!(
                "put plugin config: {}",
                v.get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("unknown error")
            )
        }
    }

    // ─── Memory tab (D-006 Step 2) ───

    /// Desktop reads use the existing, gated human-facing tool bridge. A
    /// native PUI process is not an agent principal, so the projected agent
    /// route rejects its otherwise valid memory request. Remote operators
    /// retain the bearer-authenticated route; never send them to a
    /// loopback-only endpoint or weaken either authorization boundary.
    async fn memory_tool(
        &self,
        verb: &str,
        args: serde_json::Value,
    ) -> Result<models::MemoriesPayload> {
        let local = matches!(&self.transport, Transport::Ipc(_))
            || reqwest::Url::parse(&self.endpoint)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))
                .is_some_and(|host| {
                    host == "localhost"
                        || host
                            .trim_matches(['[', ']'])
                            .parse::<std::net::IpAddr>()
                            .is_ok_and(|ip| ip.is_loopback())
                });
        let envelope = if local {
            self.run_tool(&format!("memory:{verb}"), args).await?
        } else {
            let result = self
                .post_json(&format!("/api/agent-tools/memory/{verb}"), args)
                .await?;
            serde_json::json!({ "ok": true, "result": result })
        };
        serde_json::from_value(run_tool_inner_json(&envelope)?).context("decode memory payload")
    }

    /// All memories for the current user (+ the active harness's pool) via the
    /// `memory:list` agent tool. `ok:false` (backend unavailable) is a VALID
    /// payload — the Memory tab renders its empty state from it, not an error.
    pub async fn memory_list(&self, harness: Option<&str>) -> Result<models::MemoriesPayload> {
        let mut body = serde_json::json!({});
        if let Some(h) = harness {
            body["harness_slug"] = serde_json::Value::String(h.to_string());
        }
        self.memory_tool("list", body).await
    }

    /// Load the Memory tab while preserving the distinction between a valid
    /// disabled-backend envelope and request failures.  The latter are typed
    /// for the reducer so the UI cannot misreport a 401/403 as unavailable.
    pub async fn memory_list_state(&self, harness: Option<&str>) -> MemoryLoadState {
        match self.memory_list(harness).await {
            Ok(payload) if payload.ok => MemoryLoadState::Available {
                results: payload.results,
            },
            Ok(payload) => MemoryLoadState::BackendUnavailable {
                reason: payload.reason,
            },
            Err(error) => Self::memory_load_error(error),
        }
    }

    fn memory_load_error(error: anyhow::Error) -> MemoryLoadState {
        let status = error
            .chain()
            .find_map(|cause| cause.downcast_ref::<HttpStatusError>().map(|e| e.status))
            .or_else(|| status_from_error_text(&format!("{error:#}")));
        let message = format!("{error:#}");
        match status {
            Some(401 | 403) => MemoryLoadState::AuthFailure { message },
            _ => MemoryLoadState::TransportFailure { message },
        }
    }

    /// Semantic recall via the `memory:search` agent tool (same envelope).
    pub async fn memory_search(
        &self,
        query: &str,
        harness: Option<&str>,
        limit: u32,
    ) -> Result<models::MemoriesPayload> {
        let mut body = serde_json::json!({ "query": query, "limit": limit });
        if let Some(h) = harness {
            body["harness_slug"] = serde_json::Value::String(h.to_string());
        }
        self.memory_tool("search", body).await
    }

    /// Human-facing coord inbox (P-002) — messages/escalations/handoffs with
    /// 'human' in `to`. The pui consumer refetches this on a coord-inbox SSE wake.
    pub async fn coord_inbox(&self) -> Result<Vec<CoordMsg>> {
        let v = self.get_json("/api/coord/inbox").await?;
        Ok(serde_json::from_value::<CoordInboxResponse>(v)
            .context("decode coord inbox")?
            .items)
    }

    // ─── Voice mode (voice-mode-tui-port-2026-06-05 P1) ───
    // The TUI can't reach this box's localhost voicemode/kokoro services
    // directly (remote-HTTP deployment) and its IPC `sys:http` bridge is
    // binary-unsafe, so audio crosses as base64 JSON through two operator
    // proxy routes (D-006). Engine/voice defaults come from the operator's
    // voice prefs server-side — the TUI just sends audio + text.

    /// Transcribe a 16 kHz mono PCM16 WAV via the operator STT proxy
    /// (`POST /api/agent-mcp/operator-stt` → voicemode Whisper). Returns the
    /// recognized text (empty string when Whisper heard nothing).
    pub async fn stt_transcribe(&self, wav: &[u8]) -> Result<String> {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(wav);
        let v = self
            .post_json(
                "/api/agent-mcp/operator-stt",
                serde_json::json!({ "audioBase64": b64, "format": "wav" }),
            )
            .await?;
        if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
            let err = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("stt failed");
            return Err(anyhow!("{err}"));
        }
        Ok(v.get("text")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string())
    }

    /// Synthesize `text` to speech via the operator TTS proxy
    /// (`POST /api/agent-mcp/operator-tts`). Engine + voice resolve from the
    /// operator's voice prefs server-side. Returns the decoded audio bytes
    /// (wav from kokoro, mp3 from the cloud engines) for `rodio` playback.
    pub async fn tts_speak(&self, text: &str) -> Result<Vec<u8>> {
        use base64::Engine as _;
        let v = self
            .post_json(
                "/api/agent-mcp/operator-tts",
                serde_json::json!({ "text": text }),
            )
            .await?;
        if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
            let err = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("tts failed");
            return Err(anyhow!("{err}"));
        }
        let b64 = v
            .get("audioBase64")
            .and_then(|x| x.as_str())
            .context("operator-tts: missing audioBase64")?;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .context("operator-tts: bad base64 audio")
    }

    /// Recent toast-log entries → notification history (P8).
    pub async fn recent_toasts(&self, limit: u32) -> Result<Vec<Notif>> {
        let v = self
            .get_json(&format!("/api/toast-log?limit={limit}"))
            .await?;
        let toasts = serde_json::from_value::<ToastsResponse>(v)
            .context("decode toast-log")?
            .toasts;
        Ok(toasts
            .into_iter()
            .map(|t| Notif {
                level: t.level,
                message: t.message,
                harness: t.harness_slug,
                ts: Some(t.created_at.to_string()),
            })
            .collect())
    }

    // ─── Create / hive-native share ───

    /// Register a new pot. `source` is either an existing local directory or a
    /// GitHub URL (`https://github.com/…` / `git@github.com:…`) to clone —
    /// `POST /api/harness/projects` supports both entry points. The backend's
    /// 4xx errors ("slug already exists", "path does not exist") come back as
    /// `error` in the decoded response, not a transport Err.
    pub async fn create_harness(
        &self,
        slug: &str,
        source: &str,
    ) -> Result<models::CreateProjectResponse> {
        let body = if source.starts_with("https://") || source.starts_with("git@") {
            serde_json::json!({ "slug": slug, "githubUrl": source })
        } else {
            serde_json::json!({ "slug": slug, "path": source })
        };
        let v = self.post_json("/api/harness/projects", body).await?;
        serde_json::from_value::<models::CreateProjectResponse>(v).context("decode create project")
    }

    /// Read the owner-side hive share prefill. This is the current sharing
    /// generation; it replaces the retired per-harness ShareWizard routes.
    pub async fn hive_share_meta(&self, pot_id: &str) -> Result<models::HiveShareMeta> {
        let path = hive_share_meta_path(pot_id);
        let v = self.get_json(&path).await?;
        serde_json::from_value(v).context("decode hive share metadata")
    }

    /// Create, edit, or withdraw one hive listing through the same composition
    /// used by the desktop Share-Hive dialog and `discovery:set_pot`.
    pub async fn set_hive_listing(
        &self,
        input: &models::SetHiveListingRequest,
    ) -> Result<models::SetHiveListingResponse> {
        let body = serde_json::to_value(input).context("encode hive listing request")?;
        let v = self.post_json("/api/discovery/set-pot", body).await?;
        serde_json::from_value(v).context("decode hive listing outcome")
    }

    // NOTE: the retired `binding/resolve`, `:slug/share/finalize`, and
    // `harness/cupboard/publish` routes intentionally have no compatibility
    // clients here (pui-tui-next-wave D-005).

    // ─── Cupboard tab (D-011) ───

    /// Browse/search marketplace listings (`GET /api/cupboard/listings`).
    /// `kind` is one of the live facet keys returned by the catalog; `q` is
    /// full-text. Unknown future kinds remain browseable without client churn.
    pub async fn cupboard_listings(
        &self,
        kind: Option<&str>,
        q: Option<&str>,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<models::CupboardListingsResponse> {
        let mut path = format!("/api/cupboard/listings?limit={limit}");
        if let Some(k) = kind.filter(|k| !k.is_empty() && *k != "all") {
            path.push_str(&format!("&kind={}", urlencode(k)));
        }
        if let Some(q) = q.filter(|q| !q.is_empty()) {
            path.push_str(&format!("&q={}", urlencode(q)));
        }
        if let Some(cursor) = cursor.filter(|cursor| !cursor.is_empty()) {
            path.push_str(&format!("&cursor={}", urlencode(cursor)));
        }
        let v = self.get_json(&path).await?;
        serde_json::from_value::<models::CupboardListingsResponse>(v)
            .context("decode cupboard listings")
    }

    /// Install a plugin or runtime-less code-tool pack listing
    /// (`POST /api/cupboard/install-plugin`).
    /// `acceptCapabilities` auto-grants the manifest's capability requests —
    /// the TUI confirm step happens BEFORE this call (the `y` confirm).
    pub async fn cupboard_install_plugin(&self, listing_id: &str) -> Result<serde_json::Value> {
        self.post_json(
            "/api/cupboard/install-plugin",
            serde_json::json!({ "listingId": listing_id, "acceptCapabilities": true }),
        )
        .await
    }

    /// Install (fork) a blueprint listing (`POST /api/cupboard/install-blueprint`),
    /// auto-installing its declared plugin deps from the Cupboard.
    pub async fn cupboard_install_blueprint(&self, listing_id: &str) -> Result<serde_json::Value> {
        self.post_json(
            "/api/cupboard/install-blueprint",
            serde_json::json!({ "listingId": listing_id, "installPlugins": true }),
        )
        .await
    }

    /// Install an app-template into the local template store. Materializing a
    /// new app remains a separate `templates:new-app` action.
    pub async fn cupboard_install_template(&self, listing_id: &str) -> Result<serde_json::Value> {
        self.post_json(
            "/api/cupboard/install-template",
            serde_json::json!({ "listingId": listing_id }),
        )
        .await
    }

    /// Stage a Comb-listed knowledge pack in the local store. Installing it
    /// into a Hive remains the normal reviewed Learnings flow.
    pub async fn cupboard_stage_knowledge_pack(
        &self,
        listing_id: &str,
    ) -> Result<serde_json::Value> {
        self.post_json(
            "/api/knowledge-packs/fetch-from-comb",
            serde_json::json!({ "listingId": listing_id }),
        )
        .await
    }

    /// Install a bundle app and its declared dependencies into this workspace.
    /// Standalone apps intentionally never call this route.
    pub async fn cupboard_install_app(&self, listing_id: &str) -> Result<serde_json::Value> {
        self.post_json(
            "/api/cupboard/install-app",
            serde_json::json!({ "listingId": listing_id }),
        )
        .await
    }

    // NOTE: `snapshot_fork_from_cupboard` was REMOVED — the Cupboard's
    // `snapshot` listing kind is retired and `/api/snapshots/
    // fork-from-cupboard` has no successor route (P-003, 2026-08-24).

    /// Join a shared harness from its `papercusp://harness?…` link
    /// (`POST /api/harness/join-link` — clones, registers, scaffolds).
    pub async fn harness_join_link(&self, slug: &str, link: &str) -> Result<serde_json::Value> {
        self.post_json(
            "/api/harness/join-link",
            serde_json::json!({ "slug": slug, "harnessLinkUrl": link }),
        )
        .await
    }
}

/// Build the two raw tool argument payloads used by [`OperatorClient::work_frontier`].
/// `payloadTier` is framework-reserved and must be nested in the target tool's
/// args when the call goes through `/api/agent-mcp/run-tool`; leaving it out lets
/// the result-door apply its default clipped tier, which can splice a literal
/// truncation marker into the inner JSON and make the frontier undecodable.
fn work_frontier_burn_down_args(harness: &str) -> serde_json::Value {
    serde_json::json!({
        "harness": harness,
        "limit": 2000,
        "payloadTier": "full",
    })
}

fn work_frontier_detail_args(ids: Vec<String>, harness: &str) -> serde_json::Value {
    serde_json::json!({
        "ids": ids,
        "harness": harness,
        "detail": true,
        "payloadTier": "full",
    })
}

/// The Fleet backfill is a direct projected-tool HTTP call (rather than the
/// loopback `run-tool` bridge), so it must opt into the same untrimmed target
/// payload explicitly. Otherwise a large row array can be cut in the middle of
/// `content[0].text` and the Fleet pane reports a JSON parse error.
fn work_items_list_args(limit: u32) -> serde_json::Value {
    serde_json::json!({
        "limit": limit,
        "payloadTier": "full",
    })
}

/// IPC wraps `sys:http` status failures in anyhow text rather than exposing
/// the HTTP error type. Keep the same auth classification on that transport.
fn status_from_error_text(message: &str) -> Option<u16> {
    message.split(" -> ").find_map(|part| {
        part.split(':')
            .next()
            .and_then(|code| code.trim().parse::<u16>().ok())
    })
}

/// Fold outgoing typed `blocks` edges onto READY NOW rows. Missing/clipped detail
/// degrades to zero without losing the canonical burn-down result.
fn apply_frontier_block_counts(frontier: &mut WorkFrontier, detail: &serde_json::Value) {
    let mut counts = std::collections::HashMap::<&str, usize>::new();
    for result in detail
        .get("results")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = result.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let count = result
            .pointer("/workItem/links")
            .and_then(serde_json::Value::as_array)
            .map(|links| {
                links
                    .iter()
                    .filter(|link| {
                        link.get("rel").and_then(serde_json::Value::as_str) == Some("blocks")
                    })
                    .count()
            })
            .unwrap_or(0);
        counts.insert(id, count);
    }
    for row in &mut frontier.unclaimed {
        row.blocks = counts.get(row.id.as_str()).copied().unwrap_or(0);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OperatorSelection {
    base: String,
    source: String,
    explicit: bool,
}

/// Resolve exactly one canonical endpoint. Two explicit selectors are allowed
/// only when they normalize to the same origin; neither may silently outrank
/// the other. With no explicit selector the per-port IPC record and HTTP
/// fallback are both bound to the same `PAPERCUSP_HONO_PORT` origin.
/// The endpoint this process WOULD talk to, resolved from the same selectors as
/// `from_discovery`. Exists for the FAILURE path: when the client cannot be
/// built or the probe never lands, a diagnostic that cannot name the endpoint it
/// was talking about is not actionable on a multi-operator box.
pub fn selected_endpoint_label() -> String {
    let pui = std::env::var("PUI_OPERATOR").ok();
    let shared = std::env::var("PAPERCUSP_OPERATOR_URL").ok();
    let hono = std::env::var("PAPERCUSP_HONO_PORT").ok();
    match resolve_operator_selection(pui.as_deref(), shared.as_deref(), hono.as_deref()) {
        Ok(selection) => selection.base,
        // The SELECTION itself is what failed, so there is no canonical base to
        // report — echo the raw selector, which is the thing the user actually
        // set and the thing they have to fix.
        Err(_) => pui
            .or(shared)
            .map(|raw| format!("(unresolved selector {raw:?})"))
            .unwrap_or_else(|| "(no operator selected)".to_string()),
    }
}

fn resolve_operator_selection(
    pui_operator: Option<&str>,
    papercusp_operator_url: Option<&str>,
    hono_port: Option<&str>,
) -> Result<OperatorSelection> {
    let pui = pui_operator
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(crate::http::base_for_selection)
        .transpose()?;
    let shared = papercusp_operator_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(crate::http::base_for_selection)
        .transpose()?;
    if let (Some(a), Some(b)) = (&pui, &shared) {
        if a != b {
            anyhow::bail!(
                "conflicting operator selectors: PUI_OPERATOR resolves to {a}, but PAPERCUSP_OPERATOR_URL resolves to {b}; set both to the same operator or unset one"
            );
        }
    }
    if let Some(base) = pui.or(shared) {
        let source = match (
            pui_operator.filter(|v| !v.trim().is_empty()),
            papercusp_operator_url.filter(|v| !v.trim().is_empty()),
        ) {
            (Some(_), Some(_)) => "PUI_OPERATOR + PAPERCUSP_OPERATOR_URL",
            (Some(_), None) => "PUI_OPERATOR",
            _ => "PAPERCUSP_OPERATOR_URL",
        };
        return Ok(OperatorSelection {
            base,
            source: source.to_string(),
            explicit: true,
        });
    }
    let port = hono_port
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("3070")
        .parse::<u16>()
        .context("PAPERCUSP_HONO_PORT must be a valid TCP port")?;
    if port == 0 {
        anyhow::bail!("PAPERCUSP_HONO_PORT must be greater than zero");
    }
    Ok(OperatorSelection {
        base: format!("http://127.0.0.1:{port}"),
        source: if hono_port.is_some() {
            "PAPERCUSP_HONO_PORT"
        } else {
            "release default"
        }
        .to_string(),
        explicit: false,
    })
}

/// Minimal percent-encoding for a docs relative path.
/// Build the run-tool request body (POST /api/agent-mcp/run-tool). Pure —
/// unit-tested. `confirmed:false` so the server's §3 re-check still gates a
/// destructive/high-risk tool (it replies 409 confirmation_required if so).
/// EI-1751: every pui process's run-tool calls loop back through the SAME
/// server-side `spawnId='palette'` (capabilities/invoke.ts), so per-caller
/// telemetry (which is the #1/#2 volume tool pair, coord:wake-queue /
/// coord:wake-mode, driven by HOW MANY pui instances) is otherwise
/// impossible to attribute — `tool_invocations` collapses every pui on the
/// box to one indistinguishable row shape. `callerSid` is a process-stable
/// id (same convention as the `pui-{kind}-{pid}` pane ids in layout.rs) the
/// server folds into `ctx.uiClientId` for attribution ONLY — it does not
/// touch the `spawnId='palette'` label any existing consumer keys on
/// (fleet-ekg/features.ts, decision-ledger/emit.ts's isReadShapedCoordPoll).
fn run_tool_caller_sid() -> String {
    format!("pui-{}", std::process::id())
}

fn run_tool_body(name: &str, args: serde_json::Value, confirmed: bool) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "args": args,
        "confirmed": confirmed,
        "callerSid": run_tool_caller_sid(),
    })
}

/// Unwrap a run-tool envelope (`{ ok, result: { content: [{ text }] } }`) to the
/// tool's own inner JSON payload (every tooldef tool returns one JSON text
/// block). Pure — unit-tested; the P-009 wake-queue review parses through this.
pub fn run_tool_inner_json(v: &serde_json::Value) -> Result<serde_json::Value> {
    if v.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let msg = v
            .get("message")
            .or_else(|| v.get("error"))
            .map(|m| m.to_string())
            .unwrap_or_else(|| "run-tool failed".into());
        anyhow::bail!("{msg}");
    }
    let result = v
        .get("result")
        .ok_or_else(|| anyhow::anyhow!("run-tool: no result"))?;
    if result.get("isError").and_then(serde_json::Value::as_bool) == Some(true) {
        let text = result
            .pointer("/content/0/text")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("tool error");
        anyhow::bail!("{text}");
    }
    let text = result
        .pointer("/content/0/text")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("run-tool: no content text"))?;
    serde_json::from_str(text).with_context(|| "run-tool: inner payload is not JSON")
}

/// Decode the standardized keyed-array `conversations:get` payload for one
/// requested conversation. The endpoint stays bulk-shaped even for the
/// single-id shorthand, so correlate by id and preserve the per-item error.
fn parse_conversation_get_payload(text: &str, requested_id: &str) -> Result<ConvDetail> {
    let payload: ConvGetResponse =
        serde_json::from_str(text).context("parse conversations:get payload")?;
    let result = payload
        .results
        .into_iter()
        .find(|result| result.id == requested_id)
        .ok_or_else(|| {
            anyhow!("conversations:get: response omitted requested id {requested_id}")
        })?;

    if !result.ok {
        anyhow::bail!(
            "conversations:get {requested_id}: {}",
            result.error.as_deref().unwrap_or("request failed")
        );
    }

    let detail = result.detail;
    match detail.conversation.as_ref() {
        Some(conversation) if conversation.id == requested_id => Ok(detail),
        Some(conversation) => anyhow::bail!(
            "conversations:get {requested_id}: payload conversation id mismatch ({})",
            conversation.id
        ),
        None => anyhow::bail!(
            "conversations:get {requested_id}: successful result omitted conversation"
        ),
    }
}

/// Parse a `coord:wake-queue {action:'list'}` run-tool response into the staged
/// wakes (hive-agent-tabs P-009). Pure — unit-tested.
pub fn parse_wake_queue_list(v: &serde_json::Value) -> Result<Vec<crate::models::PendingWake>> {
    let inner = run_tool_inner_json(v)?;
    if inner.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        anyhow::bail!(
            "wake-queue: {}",
            inner
                .get("reason")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("not ok")
        );
    }
    let pending = inner
        .get("pending")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    serde_json::from_value(pending).with_context(|| "wake-queue: bad pending rows")
}

/// Assemble the fleet-wide wake board (the `pui wake-pane`, EI-312) from an
/// agent-LESS `coord:wake-queue` list (every owner's staged wakes) + the live
/// roster: one group per owner with a queue, labelled/kinded from the roster
/// when present (a stale owner falls back to its raw id), queen-rank first.
/// Pure — unit-tested.
pub fn assemble_wake_board(
    all_pending: Vec<crate::models::PendingWake>,
    roster: &[crate::models::RosterEntry],
) -> Vec<crate::models::WakeGroup> {
    use crate::agent_pane_kind::AgentPaneKind;
    let mut groups: Vec<crate::models::WakeGroup> = Vec::new();
    for pw in all_pending {
        if let Some(g) = groups.iter_mut().find(|g| g.agent == pw.owner_id) {
            g.pending.push(pw);
            continue;
        }
        let entry = roster.iter().find(|r| r.owner_id == pw.owner_id);
        groups.push(crate::models::WakeGroup {
            agent: pw.owner_id.clone(),
            label: entry
                .map(|r| r.label.clone())
                .filter(|l| !l.is_empty())
                .unwrap_or_else(|| pw.owner_id.clone()),
            kind: entry.and_then(|r| r.agent_pane_kind.clone()),
            wake_mode: entry.and_then(|r| r.wake_mode.clone()),
            pending: vec![pw],
        });
    }
    // Queen-rank first, then label — the queen's queue is what the dock pane
    // exists for, so it leads even when other agents have older rows.
    groups.sort_by(|a, b| {
        let rank = |g: &crate::models::WakeGroup| {
            AgentPaneKind::from_opt(&g.kind).map_or(u8::MAX, |k| k.group_rank())
        };
        rank(a).cmp(&rank(b)).then_with(|| a.label.cmp(&b.label))
    });
    groups
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn hive_share_meta_path(pot_id: &str) -> String {
    format!("/api/discovery/pot-meta?potId={}", urlencode(pot_id))
}

/// Build the roster route, scoping to `workspace` when a non-empty id is given
/// (`?workspace=<id>`), else the unscoped fleet-wide path. Pure so the brain-view
/// workspace scoping has a regression guard without a live operator.
fn roster_path(workspace: Option<&str>) -> String {
    match workspace.map(str::trim).filter(|s| !s.is_empty()) {
        Some(ws) => format!("/api/adv/roster?workspace={}", urlencode(ws)),
        None => "/api/adv/roster".to_string(),
    }
}

/// Build the unified roster request used by the Hives tab. Keep this separate
/// from the transport method so the retired presence stale-roster argument
/// cannot quietly return in a future client edit.
fn federated_hives_request() -> (&'static str, serde_json::Value) {
    (
        "/api/agent-tools/coord/roster",
        serde_json::json!({ "view": "live" }),
    )
}

fn parse_federated_hives(text: &str) -> Result<Vec<crate::models::PresenceRow>> {
    let payload: crate::models::PresencePayload =
        serde_json::from_str(text).context("parse coord:roster payload")?;
    Ok(payload
        .active
        .into_iter()
        .filter(|row| row.federated)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operator_config_reads_effective_tiers_from_agent_config_without_palette_dispatch() {
        let src = include_str!("client.rs");
        let body = src
            .split_once("pub async fn operator_config(&self) -> Result<OperatorConfig> {")
            .expect("operator_config not found")
            .1
            .split_once("\n    // --- Fleet status view")
            .expect("could not delimit operator_config")
            .0;
        assert!(body.contains("response.effective_tiers.clone()"));
        assert!(
            !body.contains("run_tool(\"config:tiers-get\""),
            "startup must not initialize the generic tool palette just to populate the model picker"
        );
    }

    /// WI-10004158: an answered refusal is typed, so PUI can show its reason
    /// instead of calling it a lost connection; an unparseable 5xx is not.
    #[tokio::test]
    async fn a_refused_su_launch_is_a_typed_refusal_not_a_transport_error() {
        let (tx, rx) = mpsc::unbounded_channel();
        tx.send(SseFrame {
            event: "launch-result".into(),
            data: serde_json::json!({ "httpStatus": 503, "body": {
                "status": "error", "code": "attached_engine_start_failed",
                "error": "OMP default account cannot use gateway model 'x'." } })
            .to_string(),
        })
        .unwrap();
        drop(tx);
        let error = read_su_launch_result(rx).await.unwrap_err();
        let refused = error
            .downcast_ref::<SuLaunchRefused>()
            .expect("an answered refusal must stay typed");
        assert_eq!(refused.code, "attached_engine_start_failed");
        assert_eq!(
            refused.message,
            "OMP default account cannot use gateway model 'x'."
        );

        let (tx, rx) = mpsc::unbounded_channel();
        tx.send(SseFrame {
            event: "launch-result".into(),
            data: serde_json::json!({ "httpStatus": 502, "body": {} }).to_string(),
        })
        .unwrap();
        drop(tx);
        let error = read_su_launch_result(rx).await.unwrap_err();
        assert!(error.downcast_ref::<SuLaunchRefused>().is_none());
    }

    #[tokio::test]
    async fn su_launch_stream_waits_for_the_final_binding_after_progress() {
        let (tx, rx) = mpsc::unbounded_channel();
        let pending = tokio::spawn(read_su_launch_result(rx));
        tx.send(SseFrame {
            event: "launch-starting".into(),
            data: "{}".into(),
        })
        .unwrap();
        tx.send(SseFrame {
            event: "heartbeat".into(),
            data: "{}".into(),
        })
        .unwrap();
        tokio::task::yield_now().await;
        assert!(!pending.is_finished());
        tx.send(SseFrame {
            event: "launch-result".into(),
            data: serde_json::json!({
                "httpStatus": 200, "body": { "status": "ok", "advSessionId": 42, "ready": false }
            })
            .to_string(),
        })
        .unwrap();
        assert_eq!(pending.await.unwrap().unwrap()["advSessionId"], 42);
    }

    #[tokio::test]
    async fn su_launch_stream_preserves_refusal_and_rejects_a_missing_result() {
        let (tx, rx) = mpsc::unbounded_channel();
        tx.send(SseFrame {
            event: "launch-result".into(),
            data: serde_json::json!({
                "httpStatus": 429, "body": { "error": "fixture admission refusal" }
            })
            .to_string(),
        })
        .unwrap();
        // An answered refusal stays typed with its reason (WI-10004158).
        let error = read_su_launch_result(rx).await.unwrap_err();
        let refused = error
            .downcast_ref::<SuLaunchRefused>()
            .expect("typed refusal");
        assert_eq!(refused.message, "fixture admission refusal");
        assert!(error.to_string().contains("fixture admission refusal"));
        let (tx, rx) = mpsc::unbounded_channel();
        tx.send(SseFrame {
            event: "launch-starting".into(),
            data: "{}".into(),
        })
        .unwrap();
        drop(tx);
        assert!(read_su_launch_result(rx)
            .await
            .unwrap_err()
            .to_string()
            .contains("before its result"));
    }

    #[test]
    fn old_operator_identity_fails_closed_for_attached_su_sessions() {
        let old: ServerIdentity = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "workspaceId": "ws-pui",
            "store": { "id": "pg-test", "target": "postgresql://test", "source": "test" },
            "build": { "version": "old", "sha": "abc123" },
            "agentChat": { "scope": "workspace:ws-pui", "route": "/api/agent-chats" }
        }))
        .unwrap();
        assert!(!old.capabilities.attached_su_session);

        let current: ServerIdentity = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "workspaceId": "ws-pui",
            "store": { "id": "pg-test", "target": "postgresql://test", "source": "test" },
            "build": { "version": "current", "sha": "def456" },
            "agentChat": { "scope": "workspace:ws-pui", "route": "/api/agent-chats" },
            "capabilities": { "attachedSuSession": true }
        }))
        .unwrap();
        assert!(current.capabilities.attached_su_session);
    }

    fn inbox_action(id: &str) -> crate::models::AttentionAction {
        crate::models::AttentionAction {
            id: id.into(),
            label: id.into(),
            primary: true,
        }
    }

    fn inbox_target(
        id: &str,
        kind: &str,
        action_id: &str,
        reference: serde_json::Value,
    ) -> InboxActionTarget {
        InboxActionTarget {
            id: id.into(),
            kind: kind.into(),
            title: format!("title {id}"),
            harness_slug: Some("papercusp".into()),
            plan_slug: Some("plan-alpha".into()),
            owner_agent_id: Some("su-asker".into()),
            actions: vec![inbox_action(action_id)],
            reference,
        }
    }

    #[test]
    fn inbox_action_router_answers_plan_item_in_order_with_exact_coordinates() {
        let target = inbox_target(
            "plan:plan-alpha:P-007",
            "plan-item",
            "answer",
            serde_json::json!({
                "kind": "plan-item",
                "slug": "plan-alpha",
                "itemId": "P-007",
            }),
        );

        assert_eq!(
            inbox_action_steps(&target, "answer", Some("  use option B  ")).unwrap(),
            vec![
                InboxActionStep::Tool {
                    name: "plans:add-decision",
                    args: serde_json::json!({
                        "slug": "plan-alpha",
                        "title": "Answer to P-007",
                        "body": "use option B",
                        "refs": ["P-007"],
                        "harness": "papercusp",
                    }),
                },
                InboxActionStep::Tool {
                    name: "plans:set-status",
                    args: serde_json::json!({
                        "slug": "plan-alpha",
                        "item": "P-007",
                        "status": "done",
                        "rationale": "Owner answered from PUI Needs-you",
                        "harness": "papercusp",
                    }),
                },
            ]
        );
    }

    #[test]
    fn inbox_action_router_resolves_conversation_with_the_owner_answer() {
        let target = inbox_target(
            "conversation:conv-42",
            "conversation",
            "answer",
            serde_json::json!({ "kind": "conversation", "conversationId": "conv-42" }),
        );

        assert_eq!(
            inbox_action_steps(&target, "answer", Some(" settled answer ")).unwrap(),
            vec![InboxActionStep::Tool {
                name: "conversations:resolve",
                args: serde_json::json!({
                    "conversation_id": "conv-42",
                    "accepted_answer": "settled answer",
                }),
            }]
        );
    }

    #[test]
    fn inbox_action_router_acknowledges_the_exact_coord_message() {
        let target = inbox_target(
            "coord:msg-42",
            "coord-message",
            "ack",
            serde_json::json!({ "kind": "coord-message", "msgId": "msg-42" }),
        );

        assert_eq!(
            inbox_action_steps(&target, "ack", None).unwrap(),
            vec![InboxActionStep::Tool {
                name: "coord:ack",
                args: serde_json::json!({ "msg_id": "msg-42" }),
            }]
        );
    }

    #[test]
    fn inbox_action_router_retracts_a_standing_wall_by_its_frozen_fact_ref() {
        let target = inbox_target(
            "wall:credential",
            "owner-wall",
            "resolve",
            serde_json::json!({
                "kind": "owner-wall",
                "wallSource": "standing-fact",
                "factScope": "harness",
                "factScopeRef": "papercusp",
                "factKey": "wall:credential",
            }),
        );

        assert_eq!(
            inbox_action_steps(&target, "resolve", None).unwrap(),
            vec![InboxActionStep::Tool {
                name: "facts:retract",
                args: serde_json::json!({
                    "scope": "harness",
                    "scopeRef": "papercusp",
                    "key": "wall:credential",
                    "reason": "Owner cleared this wall from PUI Needs-you",
                }),
            }]
        );
    }

    #[test]
    fn inbox_action_router_delivers_needs_human_answer_before_triage() {
        let target = inbox_target(
            "work-item:WI-42",
            "work-item-needs-human",
            "answer",
            serde_json::json!({ "kind": "work-item-needs-human", "workItemId": "WI-42" }),
        );

        assert_eq!(
            inbox_action_steps(&target, "answer", Some(" proceed with B ")).unwrap(),
            vec![
                InboxActionStep::OwnerReply(serde_json::json!({
                    "askerId": "su-asker",
                    "text": "proceed with B",
                    "summary": "Owner answered your work-item-needs-human (work-item:WI-42)",
                    "planSlug": "plan-alpha",
                })),
                InboxActionStep::Triage {
                    item_id: "work-item:WI-42".into(),
                },
            ]
        );
    }

    #[test]
    fn inbox_action_router_refuses_unoffered_or_incomplete_actions() {
        let unoffered = inbox_target(
            "plan:plan-alpha:P-007",
            "plan-item",
            "ack",
            serde_json::json!({
                "kind": "plan-item",
                "slug": "plan-alpha",
                "itemId": "P-007",
            }),
        );
        let error = inbox_action_steps(&unoffered, "answer", Some("yes")).unwrap_err();
        assert!(error.to_string().contains("was not offered"), "{error:#}");

        let missing_ref = inbox_target(
            "coord:missing",
            "coord-message",
            "ack",
            serde_json::json!({ "kind": "coord-message" }),
        );
        let error = inbox_action_steps(&missing_ref, "ack", None).unwrap_err();
        assert!(error.to_string().contains("missing ref.msgId"), "{error:#}");

        let blank = inbox_target(
            "conversation:conv-42",
            "conversation",
            "answer",
            serde_json::json!({ "kind": "conversation", "conversationId": "conv-42" }),
        );
        let error = inbox_action_steps(&blank, "answer", Some("  ")).unwrap_err();
        assert!(error.to_string().contains("cannot be blank"), "{error:#}");
    }

    #[tokio::test]
    #[ignore = "requires a running operator and a disposable PUI_LIVE_WALL_KEY fact fixture"]
    async fn live_needs_you_standing_wall_round_trips_through_its_owning_verb() {
        async fn attention_until(
            client: &OperatorClient,
            fact_key: &str,
            should_exist: bool,
        ) -> Vec<AttentionItem> {
            // plans:attention intentionally serves a 20s SWR cache for its
            // append-heavy/mixed source union. Polling here models the PUI's
            // existing 60s safety refetch without adding a production poller.
            // A stale read can arrive at the 20s edge while the bounded cache
            // rebuild itself legitimately consumes up to 45s. Leave margin for
            // that documented 65s worst-case path on a loaded staging host.
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(90);
            loop {
                let items = client
                    .attention_typed()
                    .await
                    .expect("fetch live attention");
                let wall_keys: Vec<String> = items
                    .iter()
                    .filter(|item| item.kind == "owner-wall")
                    .filter_map(|item| {
                        item.reference
                            .get("factKey")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned)
                    })
                    .take(12)
                    .collect();
                let exists = items.iter().any(|item| {
                    item.reference
                        .get("factKey")
                        .and_then(serde_json::Value::as_str)
                        == Some(fact_key)
                });
                if exists == should_exist {
                    return items;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "live attention did not converge for {fact_key}: expected present={should_exist}; endpoint={}; decoded_items={}; first_wall_keys={wall_keys:?}",
                    client.endpoint,
                    items.len(),
                );
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }

        let fact_key = std::env::var("PUI_LIVE_WALL_KEY")
            .expect("set PUI_LIVE_WALL_KEY to the unique disposable standing-wall fact key");
        let client = OperatorClient::from_discovery()
            .await
            .expect("discover live operator");

        let before = attention_until(&client, &fact_key, true).await;
        let item = before
            .iter()
            .find(|item| {
                item.reference
                    .get("factKey")
                    .and_then(serde_json::Value::as_str)
                    == Some(fact_key.as_str())
            })
            .unwrap_or_else(|| panic!("disposable wall {fact_key} missing from live attention"));
        assert_eq!(item.kind, "owner-wall");
        assert!(item.is_needs_you(), "standing wall must enter Needs-you");
        assert!(item.has_action("resolve"));
        assert_eq!(item.reference["wallSource"], "standing-fact");
        assert_eq!(item.reference["factKey"], fact_key);

        client
            .run_inbox_action(&InboxActionTarget::from(item), "resolve", None)
            .await
            .expect("facts:retract through the PUI action router");

        let after = attention_until(&client, &fact_key, false).await;
        assert!(after.iter().all(|item| {
            item.reference
                .get("factKey")
                .and_then(serde_json::Value::as_str)
                != Some(fact_key.as_str())
        }));
    }

    #[test]
    fn deferred_su_session_accepts_a_null_native_handle() {
        let deferred = serde_json::json!({ "nativeSession": null });
        let omitted = serde_json::json!({});

        assert!(decode_optional_native_session(&deferred).unwrap().is_none());
        assert!(decode_optional_native_session(&omitted).unwrap().is_none());
    }

    #[test]
    fn su_session_rejects_a_malformed_non_null_native_handle() {
        let malformed = serde_json::json!({ "nativeSession": true });
        let error = decode_optional_native_session(&malformed).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("decode SU-session native handle"),
            "{error:#}"
        );
    }

    #[test]
    fn memory_load_error_classifies_typed_http_auth_failures() {
        let state = OperatorClient::memory_load_error(anyhow::Error::new(HttpStatusError {
            method: "POST".into(),
            path: "/api/agent-tools/memory/list".into(),
            status: 401,
            body: "principal required".into(),
        }));

        match state {
            MemoryLoadState::AuthFailure { message } => {
                assert!(message.contains("401"), "{message}");
                assert!(message.contains("principal required"), "{message}");
            }
            other => panic!("expected auth failure, got {other:?}"),
        }
    }

    #[test]
    fn memory_load_error_keeps_ipc_auth_and_transport_failures_distinct() {
        let auth = OperatorClient::memory_load_error(anyhow::anyhow!(
            "sys:http: POST /api/agent-tools/memory/list -> 403: forbidden"
        ));
        assert!(matches!(auth, MemoryLoadState::AuthFailure { .. }));

        let transport = OperatorClient::memory_load_error(anyhow::anyhow!("connection refused"));
        assert!(matches!(
            transport,
            MemoryLoadState::TransportFailure { .. }
        ));
    }

    async fn memory_http_fixture(
        payload: serde_json::Value,
        status: u16,
        remote: bool,
    ) -> (
        OperatorClient,
        tokio::task::JoinHandle<(String, serde_json::Value)>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let client = OperatorClient {
            transport: Transport::Http(HttpClient::new(base.clone(), Some("fixture-token".into()))),
            // The transport remains loopback for isolation; only the routing
            // classification is remote in the authenticated-path control.
            endpoint: if remote {
                "https://operator.example".into()
            } else {
                base
            },
            selection_source: "test".into(),
        };
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let (headers, body) = loop {
                let mut chunk = [0; 4096];
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0, "request ended before its body");
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
                    let len = headers
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + len {
                        break (
                            headers,
                            serde_json::from_slice(&bytes[end + 4..end + 4 + len]).unwrap(),
                        );
                    }
                }
            };
            let response_body = payload.to_string();
            socket.write_all(format!(
                "HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                response_body.len()
            ).as_bytes()).await.unwrap();
            (headers, body)
        });
        (client, task)
    }

    #[tokio::test]
    async fn memory_desktop_list_and_search_use_the_human_bridge() {
        for verb in ["list", "search"] {
            let inner = serde_json::json!({
                "ok": true, "results": [{"id":"memory-1", "memory":"A remembered fact", "metadata":{}}]
            });
            let (client, request) = memory_http_fixture(
                serde_json::json!({
                    "ok":true, "result":{"content":[{"type":"text","text":inner.to_string()}]}
                }),
                200,
                false,
            )
            .await;
            let result = if verb == "list" {
                client.memory_list(Some("project-a")).await
            } else {
                client
                    .memory_search("exact query λ", Some("project-a"), 7)
                    .await
            }
            .unwrap();
            assert!(result.ok);
            assert_eq!(result.results[0].memory, "A remembered fact");
            let (headers, body) = request.await.unwrap();
            assert!(headers.starts_with("POST /api/agent-mcp/run-tool "));
            assert_eq!(body["name"], format!("memory:{verb}"));
            assert_eq!(body["args"]["harness_slug"], "project-a");
            assert_eq!(body["confirmed"], false);
            if verb == "search" {
                assert_eq!(body["args"]["query"], "exact query λ");
                assert_eq!(body["args"]["limit"], 7);
            }
        }
    }

    #[tokio::test]
    async fn memory_remote_keeps_authenticated_agent_route_and_backend_unavailability() {
        let (client, request) = memory_http_fixture(serde_json::json!({
            "content":[{"type":"text","text":r#"{"ok":false,"reason":"memory_timeout","results":[]}"#}]
        }), 200, true).await;
        assert!(matches!(client.memory_list_state(None).await,
            MemoryLoadState::BackendUnavailable { reason: Some(reason) } if reason == "memory_timeout"));
        let (headers, body) = request.await.unwrap();
        assert!(headers.starts_with("POST /api/agent-tools/memory/list "));
        assert!(headers
            .to_lowercase()
            .contains("authorization: bearer fixture-token"));
        assert_eq!(body, serde_json::json!({}));
    }

    #[tokio::test]
    async fn memory_bridge_refusal_stays_an_auth_failure() {
        let (client, request) = memory_http_fixture(
            serde_json::json!({"ok":false,"error":"forbidden"}),
            403,
            false,
        )
        .await;
        assert!(matches!(
            client.memory_list_state(None).await,
            MemoryLoadState::AuthFailure { .. }
        ));
        request.await.unwrap();
    }

    #[test]
    fn conversation_get_parser_selects_the_requested_keyed_result() {
        let payload = r#"{"ok":true,"results":[
            {"ok":true,"id":"conv-other","conversation":{"id":"conv-other"}},
            {"ok":true,"id":"conv-target","conversation":{"id":"conv-target","body":"seed"},
             "topics":["coord"],"posts":[],"subscriber_count":2}],
            "counts":{"ok":2,"failed":0}}"#;

        let detail = parse_conversation_get_payload(payload, "conv-target").unwrap();
        let conversation = detail.conversation.expect("conversation present");
        assert_eq!(conversation.id, "conv-target");
        assert_eq!(conversation.body, "seed");
        assert_eq!(detail.topics, vec!["coord"]);
        assert_eq!(detail.subscriber_count, 2);
    }

    #[test]
    fn conversation_get_parser_preserves_per_item_errors() {
        let payload = r#"{"ok":true,"results":[
            {"ok":false,"id":"conv-missing","error":"not_found"}],
            "counts":{"ok":0,"failed":1}}"#;

        let error = parse_conversation_get_payload(payload, "conv-missing").unwrap_err();
        assert!(error.to_string().contains("not_found"), "{error:#}");
    }

    #[test]
    fn conversation_get_parser_rejects_omitted_or_mismatched_results() {
        let omitted = r#"{"ok":true,"results":[],"counts":{"ok":0,"failed":0}}"#;
        let error = parse_conversation_get_payload(omitted, "conv-target").unwrap_err();
        assert!(
            error.to_string().contains("omitted requested id"),
            "{error:#}"
        );

        let mismatched = r#"{"ok":true,"results":[
            {"ok":true,"id":"conv-target","conversation":{"id":"conv-other"}}],
            "counts":{"ok":1,"failed":0}}"#;
        let error = parse_conversation_get_payload(mismatched, "conv-target").unwrap_err();
        assert!(error.to_string().contains("id mismatch"), "{error:#}");
    }

    #[test]
    fn parses_current_array_root_work_items_list_shape() {
        // Current `work_items:list` wire shape: the inner JSON is the rows
        // array itself, not the legacy `{ "items": [...] }` envelope.
        let j = r#"[
            {"id":"EI-7","kind":"bug","family":"issue","harness":null,
             "title":"role pin","state":"open","assignee":null,"severity":"major"},
            {"id":"F-9","kind":"feature","family":"feature","harness":"papercusp",
             "title":"A","state":"passed","assignee":"su-x","severity":null}
        ]"#;

        let rows = parse_work_items_list_payload(j).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "EI-7");
        assert_eq!(rows[0].family, "issue");
        assert_eq!(rows[1].id, "F-9");
        assert_eq!(rows[1].state, "passed");
    }

    #[test]
    fn parses_legacy_object_root_work_items_list_shape() {
        let j = r#"{"ok":true,"count":1,"items":[
            {"id":"EI-7","kind":"bug","family":"issue","title":"role pin","state":"open"}
        ]}"#;

        let rows = parse_work_items_list_payload(j).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "EI-7");
    }

    #[test]
    fn filters_leaked_lock_resolve_fixture_manifests() {
        let plugins = vec![
            models::PluginManifest {
                name: "lockresolve-12345-root".into(),
                version: "0.1.0".into(),
                ..Default::default()
            },
            models::PluginManifest {
                name: "real-plugin".into(),
                version: "1.0.0".into(),
                ..Default::default()
            },
        ];

        let filtered = filter_lock_resolve_fixtures(plugins);
        assert_eq!(
            filtered.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            ["real-plugin"]
        );
    }

    #[test]
    fn lock_resolve_fixture_filter_has_a_narrow_name_boundary() {
        for fixture in ["lockresolve-1-root", "lockresolve-987654-lone"] {
            assert!(
                is_lock_resolve_fixture_name(fixture),
                "{fixture} should be hidden"
            );
        }
        for real_name in [
            "lockresolve",
            "lockresolve-dev-root",
            "lockresolve-abc-root",
            "lockresolve-123",
            "my-lockresolve-123-root",
        ] {
            assert!(
                !is_lock_resolve_fixture_name(real_name),
                "{real_name} should remain visible"
            );
        }
    }

    #[test]
    fn frontier_block_counts_fold_one_batched_detail_response() {
        let mut frontier = WorkFrontier {
            unclaimed: vec![
                crate::models::WorkFrontierRow {
                    id: "WI-1".into(),
                    ..Default::default()
                },
                crate::models::WorkFrontierRow {
                    id: "WI-2".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        apply_frontier_block_counts(
            &mut frontier,
            &serde_json::json!({
                "results": [
                    {"id":"WI-1","workItem":{"links":[
                        {"rel":"blocks","dst":{"kind":"feature","ref":"WI-A"}},
                        {"rel":"relates","dst":{"kind":"feature","ref":"WI-B"}},
                        {"rel":"blocks","dst":{"kind":"issue","ref":"EI-C"}}
                    ]}},
                    {"id":"WI-2","workItem":{}}
                ]
            }),
        );
        assert_eq!(frontier.unclaimed[0].blocks, 2);
        assert_eq!(frontier.unclaimed[1].blocks, 0);
    }

    #[test]
    fn session_switcher_merge_keeps_roster_and_dedupes_recorded_hits() {
        let roster = vec![
            RosterEntry {
                owner_id: "su-live".into(),
                label: "live row".into(),
                session_state: Some("live".into()),
                native_session: Some(models::NativeSessionHandle::Codex {
                    source: "codex".into(),
                    owner_id: Some("su-live".into()),
                    codex_home: "/tmp/codex".into(),
                    rollout_id: Some("rollout-live".into()),
                    exact_resume_supported: true,
                    missing_reason: None,
                }),
                ..Default::default()
            },
            RosterEntry {
                owner_id: "su-ended".into(),
                label: "ended row".into(),
                session_state: Some("ended".into()),
                ..Default::default()
            },
        ];
        let hits = serde_json::json!({ "results": [
            { "ref": "session_turn:codex:rollout-live:7", "excerpt": "live preview", "provenance": {
                "source_kind": "codex", "session_id": "rollout-live", "owner": "", "ts": "2026-08-26T10:00:00Z"
            }},
            { "readMore": { "args": { "ref": "session_turn:claude:ended-transcript:9" }},
              "excerpt": "ended preview", "provenance": {
                "source_kind": "claude", "session_id": "ended-transcript", "owner": "su-ended", "ts": "2026-08-26T09:00:00Z"
            }},
            { "ref": "session_turn:codex:recorded-only:3", "excerpt": "recorded preview", "provenance": {
                "source_kind": "codex", "session_id": "recorded-only", "owner": "su-recorded", "ts": "2026-08-25T08:00:00Z"
            }}
        ]});

        let rows = merge_session_switcher_rows(roster, &hits);
        assert_eq!(rows.len(), 3, "both duplicate forms must be suppressed");
        assert_eq!(rows[0].session_state.as_deref(), Some("live"));
        assert_eq!(
            rows[0].transcript_availability,
            SessionTranscriptAvailability::Available
        );
        assert_eq!(
            rows[0].transcript_ref.as_deref(),
            Some("session_turn:codex:rollout-live:7")
        );
        assert_eq!(rows[0].transcript_excerpt.as_deref(), Some("live preview"));
        assert_eq!(rows[1].session_state.as_deref(), Some("ended"));
        assert_eq!(
            rows[1].transcript_availability,
            SessionTranscriptAvailability::Available
        );
        assert_eq!(
            rows[1].transcript_ref.as_deref(),
            Some("session_turn:claude:ended-transcript:9")
        );
        assert_eq!(rows[2].owner_id, "su-recorded");
        assert_eq!(rows[2].session_state.as_deref(), Some("recorded"));
        assert_eq!(
            rows[2].transcript_availability,
            SessionTranscriptAvailability::Available
        );
        assert_eq!(
            rows[2].transcript_excerpt.as_deref(),
            Some("recorded preview")
        );
        assert_eq!(
            rows[2].transcript_at.as_deref(),
            Some("2026-08-25T08:00:00Z")
        );
        assert!(matches!(
            rows[2].native_session,
            Some(models::NativeSessionHandle::Codex {
                rollout_id: Some(ref id),
                exact_resume_supported: false,
                ..
            }) if id == "recorded-only"
        ));
    }

    #[test]
    fn empty_session_search_is_browse_mode_not_a_literal_wildcard() {
        assert!(session_search_args("").is_none());
        assert!(session_search_args("  ").is_none());
        assert_eq!(
            session_search_args("P8 source"),
            Some(serde_json::json!({
                "query": "P8 source",
                "mode": "hybrid",
                "limit": 20,
                "context": 0,
            }))
        );
    }

    #[test]
    fn session_switcher_merge_preserves_exact_agent_chat_identity_and_harness() {
        let hits = serde_json::json!({ "results": [
            {
                "ref": "session_turn:agent_chat:chat-42:2",
                "excerpt": "historic answer",
                "provenance": {
                    "source_kind": "agent_chat",
                    "session_id": "chat-42",
                    "harness_slug": "papercusp",
                    "owner": "su-history",
                    "ts": "2026-09-01T00:00:01Z"
                }
            },
            {
                "ref": "session_turn:codex:native-42:2",
                "excerpt": "native answer",
                "provenance": {
                    "source_kind": "codex",
                    "session_id": "native-42",
                    "harness_slug": "must-not-be-used",
                    "owner": "su-native",
                    "ts": "2026-09-01T00:00:01Z"
                }
            }
        ]});

        let rows = merge_session_switcher_rows(Vec::new(), &hits);
        assert_eq!(rows.len(), 2);
        let chat = rows
            .iter()
            .find(|row| row.source == "agent_chat")
            .expect("agent-chat search hit becomes a Sessions row");
        assert_eq!(chat.agent_chat_id.as_deref(), Some("chat-42"));
        assert_eq!(chat.session_harness.as_deref(), Some("papercusp"));
        assert!(chat.native_session.is_none());

        let native = rows
            .iter()
            .find(|row| row.source == "codex")
            .expect("native search hit remains visible");
        assert!(native.agent_chat_id.is_none());
        assert!(
            native.session_harness.is_none(),
            "ambient/native provenance must never authorize an agent-chat mutation"
        );
    }

    #[test]
    fn session_switcher_merge_enriches_matching_roster_row_with_agent_chat_provenance() {
        let roster = vec![RosterEntry {
            owner_id: "su-live".into(),
            label: "live session".into(),
            source: "codex".into(),
            session_state: Some("live".into()),
            ..Default::default()
        }];
        let hits = serde_json::json!({ "results": [{
            "ref": "session_turn:agent_chat:chat-live:3",
            "provenance": {
                "source_kind": "agent_chat",
                "session_id": "chat-live",
                "harness_slug": "papercusp",
                "owner": "su-live"
            }
        }]});

        let rows = merge_session_switcher_rows(roster, &hits);
        assert_eq!(rows.len(), 1, "owner-identical live/indexed rows dedupe");
        assert_eq!(rows[0].agent_chat_id.as_deref(), Some("chat-live"));
        assert_eq!(rows[0].session_harness.as_deref(), Some("papercusp"));
    }

    #[test]
    fn exact_session_resolution_distinguishes_empty_from_malformed_hits() {
        assert!(
            session_transcript_resolution(&serde_json::json!({ "results": [] }))
                .unwrap()
                .is_none()
        );

        let resolved = session_transcript_resolution(&serde_json::json!({ "results": [{
            "readMore": { "args": { "ref": "session_turn:codex:rollout:8" } },
            "excerpt": "latest turn",
            "provenance": { "ts": "2026-08-27T12:00:00Z" }
        }] }))
        .unwrap()
        .unwrap();
        assert_eq!(resolved.reference, "session_turn:codex:rollout:8");
        assert_eq!(resolved.excerpt.as_deref(), Some("latest turn"));
        assert_eq!(
            resolved.transcript_at.as_deref(),
            Some("2026-08-27T12:00:00Z")
        );

        assert!(session_transcript_resolution(&serde_json::json!({ "results": [{}] })).is_err());
    }

    #[test]
    fn session_transcript_normalizes_structured_turns() {
        let inner = serde_json::json!({ "turns": [
            { "speaker": "user", "ts": "2026-08-26T10:00:00Z", "text": "  open it  " },
            { "speaker": "assistant", "text": "done" },
            { "speaker": "tool", "text": "   " },
            { "text": "legacy" }
        ]});

        let turns = session_transcript_turns(&inner);
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].speaker, "user");
        assert_eq!(turns[0].text, "open it");
        assert_eq!(turns[0].ts.as_deref(), Some("2026-08-26T10:00:00Z"));
        assert_eq!(turns[2].speaker, "unknown");
        assert_eq!(turns[2].text, "legacy");
    }

    /// R2's most consequential clause: "No code path substitutes a loopback
    /// operator when a remote one was explicitly selected."
    ///
    /// This is the failure with no symptom — a silent loopback substitution
    /// does not error, it just reads and writes the WRONG store while the user
    /// believes they are on the remote. It is guarded at the source because the
    /// property is an ORDERING one: `from_discovery` must return for an
    /// explicit selection BEFORE it ever attempts the local IPC socket, and
    /// moving one line would reintroduce the fallback with every test still
    /// green.
    ///
    /// Falsifiable by construction: delete the explicit early-return, or move
    /// it below the IPC attempt, and this fails.
    #[test]
    fn an_explicit_selection_never_falls_back_to_the_local_ipc_socket() {
        let src = include_str!("client.rs");
        // Assembled, not literal: this test lives in the file it searches, so a
        // literal needle risks matching this test instead of the function.
        let open = format!("pub async fn from_{}() -> Result<Self> {{", "discovery");
        let body = src
            .split_once(open.as_str())
            .expect("from_discovery not found — did it get renamed?")
            .1
            .split_once("\n    /// Build the client for an explicit operator selection")
            .expect("could not delimit from_discovery body")
            .0;

        let explicit_return = body.find("if selection.explicit").expect(
            "from_discovery must special-case an explicit selection; \
                     without it an unreachable remote falls through to the local \
                     IPC socket and silently serves the WRONG store",
        );
        let ipc_attempt = body.find("IpcClient::connect_discovered").expect(
            "positive control failed: the IPC attempt was not found in \
                     from_discovery, so this guard is measuring the wrong region",
        );

        assert!(
            explicit_return < ipc_attempt,
            "an explicit operator selection must return BEFORE the local IPC \
             attempt, or a remote selection silently degrades to loopback:\n{body}"
        );
    }

    #[test]
    fn canonical_selection_rejects_conflicting_explicit_endpoints() {
        let err = resolve_operator_selection(
            Some("release"),
            Some("http://localhost:3170/api/mcp"),
            None,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("conflicting operator selectors"), "{err}");
        assert!(err.contains("set both to the same operator"), "{err}");
    }

    #[test]
    fn canonical_selection_accepts_equivalent_names_and_urls() {
        let selected = resolve_operator_selection(
            Some("release"),
            Some("http://localhost:3070/api/mcp"),
            Some("3170"),
        )
        .unwrap();
        assert_eq!(selected.base, "http://127.0.0.1:3070");
        assert_eq!(selected.source, "PUI_OPERATOR + PAPERCUSP_OPERATOR_URL");
        assert!(selected.explicit);
    }

    #[test]
    fn ambient_selection_binds_ipc_and_http_to_one_port() {
        let selected = resolve_operator_selection(None, None, Some("3270")).unwrap();
        assert_eq!(selected.base, "http://127.0.0.1:3270");
        assert_eq!(selected.source, "PAPERCUSP_HONO_PORT");
        assert!(!selected.explicit);
        assert!(resolve_operator_selection(None, None, Some("0")).is_err());
        assert!(resolve_operator_selection(None, None, Some("not-a-port")).is_err());
    }

    fn identity(endpoint: &str, workspace: &str, store: &str) -> BackendIdentity {
        BackendIdentity {
            schema_version: 1,
            endpoint: endpoint.into(),
            selection_source: "test".into(),
            transport: "http".into(),
            workspace_id: workspace.into(),
            store: StoreIdentity {
                id: store.into(),
                target: "postgresql://127.0.0.1:5432/papercusp".into(),
                source: "test".into(),
            },
            build: BuildIdentity {
                version: "1.0.0".into(),
                sha: Some("abc".into()),
            },
            agent_chat: AgentChatIdentity {
                scope: format!("workspace:{workspace}"),
                route: "/api/agent-chats".into(),
            },
            capabilities: OperatorCapabilities {
                attached_su_session: true,
                attached_su_session_approvals: true,
            },
        }
    }

    #[test]
    fn rendezvous_ignores_build_but_refuses_endpoint_workspace_or_store_drift() {
        let base = identity("http://127.0.0.1:3070", "ws", "pg-a");
        let mut rebuild = base.clone();
        rebuild.build.version = "2.0.0".into();
        rebuild.build.sha = Some("def".into());
        assert!(base.same_rendezvous(&rebuild));
        assert!(!base.same_rendezvous(&identity("http://127.0.0.1:3170", "ws", "pg-a")));
        assert!(!base.same_rendezvous(&identity("http://127.0.0.1:3070", "other-ws", "pg-a")));
        assert!(!base.same_rendezvous(&identity("http://127.0.0.1:3070", "ws", "pg-b")));
    }

    #[test]
    fn urlencode_keeps_path_chars_escapes_specials() {
        assert_eq!(
            urlencode("decisions/routine-durability.md"),
            "decisions/routine-durability.md"
        );
        assert_eq!(urlencode("a b.md"), "a%20b.md");
        assert_eq!(urlencode("x?y&z"), "x%3Fy%26z");
    }

    #[test]
    fn hive_share_meta_path_targets_the_current_owner_projection() {
        assert_eq!(
            hive_share_meta_path("my hive?"),
            "/api/discovery/pot-meta?potId=my%20hive%3F"
        );
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_hive_share_meta_decodes_the_current_route() {
        let client = OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let slug =
            std::env::var("PAPERCUSP_HARNESS_SLUG").unwrap_or_else(|_| "papercusp".to_string());
        let meta = client
            .hive_share_meta(&slug)
            .await
            .expect("decode GET /api/discovery/pot-meta over the live wire");
        assert_eq!(meta.pot_id, slug);
        assert!(!meta.title.is_empty());
    }

    #[test]
    fn federated_hives_uses_unified_roster_without_retired_presence_arg() {
        let (path, body) = federated_hives_request();
        assert_eq!(path, "/api/agent-tools/coord/roster");
        assert_eq!(body, serde_json::json!({ "view": "live" }));
        assert!(body.get("include_stale").is_none());
    }

    #[test]
    fn parse_federated_hives_filters_unified_active_roster() {
        let text = serde_json::json!({
            "view": "live",
            "active": [
                { "ownerId": "fed:1@box-a", "federated": true },
                { "ownerId": "su-local", "federated": false },
                { "ownerId": "fed:2@box-b", "federated": true, "stale": true }
            ]
        })
        .to_string();
        let rows = parse_federated_hives(&text).expect("parses unified roster");
        assert_eq!(
            rows.iter()
                .map(|row| row.owner_id.as_str())
                .collect::<Vec<_>>(),
            ["fed:1@box-a", "fed:2@box-b"]
        );
        assert!(rows[1].stale);
    }

    #[test]
    fn roster_path_scopes_to_workspace_else_fleet_wide() {
        // No / empty / whitespace workspace → the unscoped fleet-wide path
        // (preserves the prior behavior for dev / webapp with no registry).
        assert_eq!(roster_path(None), "/api/adv/roster");
        assert_eq!(roster_path(Some("")), "/api/adv/roster");
        assert_eq!(roster_path(Some("   ")), "/api/adv/roster");
        // A concrete workspace id scopes the roster — this is what makes the
        // brain panes show THAT workspace's queen/overwatch, not the fleet-wide
        // newest. (Regression guard for the workspace-switch bug.)
        assert_eq!(
            roster_path(Some("papercusp-workspace")),
            "/api/adv/roster?workspace=papercusp-workspace"
        );
        // Ids needing escaping are percent-encoded (space → %20).
        assert_eq!(
            roster_path(Some("ws 1")),
            "/api/adv/roster?workspace=ws%201"
        );
    }

    #[test]
    fn run_tool_body_has_name_args_and_unconfirmed() {
        let b = super::run_tool_body(
            "coord:wake-mode",
            serde_json::json!({ "agent": "s-1", "mode": "manual" }),
            false,
        );
        assert_eq!(b["name"], "coord:wake-mode");
        assert_eq!(b["args"]["agent"], "s-1");
        assert_eq!(b["args"]["mode"], "manual");
        assert_eq!(b["confirmed"], false);
    }

    #[test]
    fn work_frontier_reads_request_nested_full_payload_tier() {
        // `payloadTier` is a framework control on the target tool, so it must
        // survive inside run-tool's nested `args` object. Without this opt-in,
        // the result door can splice its truncation marker into the JSON text
        // and the Fleet pane reports a misleading parse error.
        let burn_down = super::run_tool_body(
            "work_items:burn_down",
            super::work_frontier_burn_down_args("papercusp"),
            false,
        );
        assert_eq!(burn_down["args"]["payloadTier"], "full");
        assert_eq!(burn_down["args"]["harness"], "papercusp");

        let detail = super::run_tool_body(
            "work_items:get",
            super::work_frontier_detail_args(vec!["WI-ready".into()], "papercusp"),
            false,
        );
        assert_eq!(detail["args"]["payloadTier"], "full");
        assert_eq!(detail["args"]["ids"][0], "WI-ready");
    }

    #[test]
    fn work_items_list_backfill_requests_full_payload_tier() {
        let args = super::work_items_list_args(500);
        assert_eq!(args["limit"], 500);
        assert_eq!(args["payloadTier"], "full");
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_work_frontier_fetch_decodes_the_full_payload() {
        // This is the exact Fleet request path, over the real discovered
        // operator transport. A clipped result used to leave a literal
        // truncation marker in content[0].text and surface as a parse error.
        let client = OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let frontier = client
            .work_frontier("papercup")
            .await
            .expect("decode work frontier over the live wire");
        eprintln!(
            "live work frontier: harness={} total={} terminal={} unclaimed={} in-flight={} parked={}",
            frontier.harness,
            frontier.counts.total,
            frontier.counts.terminal,
            frontier.counts.unclaimed,
            frontier.counts.in_flight,
            frontier.counts.parked,
        );
        assert!(
            frontier.counts.total >= frontier.counts.terminal,
            "frontier totals must include its terminal bucket"
        );
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_work_items_list_backfill_decodes_the_full_payload() {
        // The Fleet startup backfill uses the direct projected-tool route, not
        // run-tool. Keep this acceptance leg separate so either transport's
        // payload-tier contract can regress independently without hiding it.
        let client = OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let rows = client
            .work_items_list_bounded(500)
            .await
            .expect("decode work_items:list backfill over the live wire");
        eprintln!("live work-items list backfill: {} rows", rows.len());
    }

    #[test]
    fn run_tool_body_carries_a_process_stable_caller_sid() {
        // EI-1751: every call from this process must carry the SAME callerSid
        // (so the server can attribute per-instance telemetry), in the
        // established `pui-<pid>` shape (layout.rs's pane-id convention).
        let a = super::run_tool_body("coord:wake-mode", serde_json::json!({}), false);
        let b = super::run_tool_body("coord:wake-queue", serde_json::json!({}), false);
        let sid_a = a["callerSid"].as_str().expect("callerSid must be a string");
        let sid_b = b["callerSid"].as_str().expect("callerSid must be a string");
        assert!(sid_a.starts_with("pui-"), "got {sid_a:?}");
        assert_eq!(
            sid_a, sid_b,
            "callerSid must be stable across calls from one process"
        );
        assert_eq!(sid_a, format!("pui-{}", std::process::id()));
    }

    #[test]
    fn confirmed_run_tool_body_is_explicit_and_keeps_caller_attribution() {
        let body = super::run_tool_body(
            "fleet:bench",
            serde_json::json!({ "member": "su-1", "wakeEvent": "gate:ready" }),
            true,
        );
        assert_eq!(body["confirmed"], true);
        assert_eq!(body["name"], "fleet:bench");
        assert_eq!(body["args"]["member"], "su-1");
        assert!(body["callerSid"].as_str().unwrap().starts_with("pui-"));
    }

    #[test]
    fn parse_wake_queue_list_unwraps_the_run_tool_envelope() {
        // The full envelope: route { ok, result } → MCP { content:[{text}] } →
        // the tool's own { ok, pending } JSON.
        let inner = serde_json::json!({
            "ok": true,
            "pending": [
                { "id": 7, "ownerId": "bee-1", "summary": "routine tick", "source": "routinesTick", "createdAt": "2026-06-09" },
                { "id": 9, "ownerId": "bee-1", "summary": null, "createdAt": "2026-06-09" },
            ],
        });
        let envelope = serde_json::json!({
            "ok": true,
            "result": { "content": [ { "type": "text", "text": inner.to_string() } ] },
        });
        let got = super::parse_wake_queue_list(&envelope).expect("parses");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].id, 7);
        assert_eq!(got[0].summary.as_deref(), Some("routine tick"));
        assert_eq!(got[1].summary, None);
        // A pre-coalescing payload (no count field) defaults to count 1.
        assert_eq!(got[0].count, 1);
    }

    #[test]
    fn assemble_wake_board_groups_by_owner_queen_first_with_roster_join() {
        // EI-312: three owners' wakes interleaved; the bee + queen are on the
        // roster, the third owner is stale (gone from the roster).
        let pw = |id: i64, owner: &str, summary: &str, count: i64| crate::models::PendingWake {
            id,
            owner_id: owner.into(),
            summary: Some(summary.into()),
            count,
            ..Default::default()
        };
        let roster = vec![
            crate::models::RosterEntry {
                owner_id: "su-bee".into(),
                label: "bee one".into(),
                agent_pane_kind: Some("bee".into()),
                wake_mode: Some("manual".into()),
                ..Default::default()
            },
            crate::models::RosterEntry {
                owner_id: "su-queen".into(),
                label: "the queen".into(),
                agent_pane_kind: Some("queen".into()),
                wake_mode: Some("manual".into()),
                ..Default::default()
            },
        ];
        let groups = super::assemble_wake_board(
            vec![
                pw(1, "su-bee", "placement", 1),
                pw(2, "su-gone", "orphaned tick", 2),
                pw(3, "su-queen", "boot storm", 11),
                pw(4, "su-queen", "cadence", 4),
            ],
            &roster,
        );
        // Queen rank leads; the stale owner (no kind) sorts last under its raw id.
        assert_eq!(
            groups.iter().map(|g| g.agent.as_str()).collect::<Vec<_>>(),
            ["su-queen", "su-bee", "su-gone"]
        );
        assert_eq!(groups[0].label, "the queen");
        assert_eq!(groups[0].kind.as_deref(), Some("queen"));
        assert_eq!(
            groups[0].pending.iter().map(|w| w.id).collect::<Vec<_>>(),
            [3, 4]
        );
        assert_eq!(groups[1].wake_mode.as_deref(), Some("manual"));
        // Stale owner: raw-id label, no kind/mode — still fully reviewable.
        assert_eq!(groups[2].label, "su-gone");
        assert_eq!(groups[2].kind, None);
        assert_eq!(groups[2].pending[0].count, 2);
    }

    #[test]
    fn parse_wake_queue_list_surfaces_tool_errors() {
        // Route-level failure.
        let denied = serde_json::json!({ "ok": false, "error": "forbidden" });
        assert!(super::parse_wake_queue_list(&denied).is_err());
        // MCP isError text block.
        let tool_err = serde_json::json!({
            "ok": true,
            "result": { "isError": true, "content": [ { "type": "text", "text": "handler_error: boom" } ] },
        });
        let err = super::parse_wake_queue_list(&tool_err)
            .unwrap_err()
            .to_string();
        assert!(err.contains("boom"), "{err}");
    }

    // End-to-end IPC round-trips for the client live in ipc.rs (fake Unix-socket
    // server). Here we just cover the pure path-encoding; the typed decoders are
    // covered by models.rs serde tests.
}
