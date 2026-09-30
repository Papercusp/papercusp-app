//! Typed wire contract for the operator's native `agent-chats` session API.
//!
//! The operator owns the transport and conversation store. The TUI uses the
//! lifecycle, transcript, task, and approval REST surfaces; writable owner turns
//! use the separate typed SU-session host.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentChatListOptions {
    pub include_archived: bool,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NewAgentChat {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feature_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentChatApprovalDecision {
    pub approved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// User-side task controls exposed by the Context pane. These are UI verbs;
/// the operator maps them onto the canonical tasks:ops engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentChatTaskAction {
    Add,
    Edit,
    Start,
    Check,
    Drop,
    Block,
    ClearBlocker,
    Reopen,
    MoveUp,
    MoveDown,
    Promote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatTaskMutation {
    pub action: AgentChatTaskAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocker_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatTask {
    pub id: String,
    pub content: String,
    pub active_form: String,
    pub status: String,
    #[serde(default)]
    pub blocker_ref: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    pub position: u32,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub links: Vec<crate::models::ConversationTaskWorkItemLink>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatTaskMutationResponse {
    pub ok: bool,
    pub action: AgentChatTaskAction,
    pub op: String,
    #[serde(default)]
    pub changed_task_id: Option<String>,
    #[serde(default)]
    pub tasks: Vec<AgentChatTask>,
    /// The initiating renderer receives the same canonical projection that
    /// the sync invalidation makes available to every other subscriber.
    pub projection: crate::models::ConversationContextProjection,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChatSummary {
    pub id: String,
    pub role: String,
    #[serde(default)]
    pub feature_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// @see `AgentChat::su_runtime_class` — `None` is UNCLASSIFIED, not legacy.
    #[serde(default)]
    pub su_runtime_class: Option<String>,
    #[serde(default)]
    pub continued_from_chat_id: Option<String>,
    #[serde(default)]
    pub continued_from_turn_count: Option<u32>,
    #[serde(default)]
    pub turn_count: u32,
    #[serde(default)]
    pub total_input_tokens: Option<u64>,
    #[serde(default)]
    pub total_output_tokens: Option<u64>,
    #[serde(default)]
    pub total_cost_usd_cents: Option<f64>,
    /// False means at least one assistant frame omitted usage measurements.
    #[serde(default)]
    pub usage_complete: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChatListResponse {
    #[serde(default)]
    pub chats: Vec<AgentChatSummary>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChat {
    pub id: String,
    pub role: String,
    #[serde(default)]
    pub feature_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// Which dispatch policy this conversation was CREATED under
    /// (`su-session` | `legacy-owned-loop`), stamped server-side by migration
    /// 1023 / `createChat`. `None` means the row predates the stamp, which is a
    /// third answer — UNCLASSIFIED — and never a licence to assume either policy.
    /// See `crate::su_session::PuiRuntimeClass`.
    #[serde(default)]
    pub su_runtime_class: Option<String>,
    #[serde(default)]
    pub continued_from_chat_id: Option<String>,
    #[serde(default)]
    pub continued_from_turn_count: Option<u32>,
    #[serde(default)]
    pub transcript: Vec<AgentChatTranscriptTurn>,
    #[serde(default)]
    pub total_input_tokens: Option<u64>,
    #[serde(default)]
    pub total_output_tokens: Option<u64>,
    #[serde(default)]
    pub total_cost_usd_cents: Option<f64>,
    /// False means at least one assistant frame omitted usage measurements.
    #[serde(default)]
    pub usage_complete: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub feature_lock: Option<AgentChatFeatureLock>,
}

/// Measurements the selected Agent Chat can state without inference.
/// `None` is preserved so an omitted provider measurement never becomes a
/// fabricated zero in the PUI.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentChatUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_usd_cents: Option<f64>,
}

impl From<&AgentChatSummary> for AgentChatUsage {
    fn from(chat: &AgentChatSummary) -> Self {
        if !chat.usage_complete {
            return Self::default();
        }
        Self {
            input_tokens: chat.total_input_tokens,
            output_tokens: chat.total_output_tokens,
            cost_usd_cents: chat.total_cost_usd_cents,
        }
    }
}

impl From<&AgentChat> for AgentChatUsage {
    fn from(chat: &AgentChat) -> Self {
        if !chat.usage_complete {
            return Self::default();
        }
        Self {
            input_tokens: chat.total_input_tokens,
            output_tokens: chat.total_output_tokens,
            cost_usd_cents: chat.total_cost_usd_cents,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChatTranscriptTurn {
    #[serde(default)]
    pub su_command: Option<Value>,
    pub role: String,
    pub content: String,
    pub ts: String,
    #[serde(default)]
    pub tokens_in: Option<u64>,
    #[serde(default)]
    pub tokens_out: Option<u64>,
    #[serde(default)]
    pub cost_cents: Option<f64>,
    #[serde(default)]
    pub tools: Vec<AgentChatTranscriptToolCall>,
    #[serde(default)]
    pub error: bool,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub account_route: Option<String>,
    #[serde(default, rename = "unreportedFrames")]
    pub unreported_frames: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChatTranscriptToolCall {
    pub name: String,
    #[serde(default)]
    pub input: Option<Value>,
    #[serde(default)]
    pub answered: Option<AgentChatTranscriptAnswer>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChatTranscriptAnswer {
    #[serde(default)]
    pub picks: Vec<AgentChatTranscriptPick>,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AgentChatTranscriptPick {
    pub option_id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AgentChatFeatureLock {
    #[serde(default)]
    pub taken_by: Option<String>,
    #[serde(default)]
    pub taken_at: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAgentChatApproval {
    pub chat_id: String,
    pub call_id: String,
    pub workspace_id: String,
    pub tool_name: String,
    pub tool_input: Value,
    pub step_index: u32,
    pub requested_at: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChatApprovalsResponse {
    #[serde(default)]
    pub approvals: Vec<PendingAgentChatApproval>,
}

pub(crate) fn agent_chats_list_path(harness: &str, options: &AgentChatListOptions) -> String {
    let mut path = format!("/api/harness/{}/agent-chats", encode_segment(harness));
    let mut query = Vec::new();
    if options.include_archived {
        query.push("include=archived".to_string());
    }
    if let Some(limit) = options.limit {
        query.push(format!("limit={limit}"));
    }
    if let Some(offset) = options.offset {
        query.push(format!("offset={offset}"));
    }
    if !query.is_empty() {
        path.push('?');
        path.push_str(&query.join("&"));
    }
    path
}

pub(crate) fn agent_chat_path(harness: &str, chat_id: &str) -> String {
    format!(
        "/api/harness/{}/agent-chats/{}",
        encode_segment(harness),
        encode_segment(chat_id)
    )
}

pub(crate) fn agent_chat_tasks_path(harness: &str, chat_id: &str) -> String {
    format!("{}/tasks", agent_chat_path(harness, chat_id))
}

pub(crate) fn agent_chat_approvals_path(harness: &str, chat_id: &str) -> String {
    format!("{}/approvals", agent_chat_path(harness, chat_id))
}

pub(crate) fn agent_chat_approval_path(harness: &str, chat_id: &str, call_id: &str) -> String {
    format!(
        "{}/{}",
        agent_chat_approvals_path(harness, chat_id),
        encode_segment(call_id)
    )
}

fn encode_segment(value: &str) -> String {
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

/// `2026-09-30T01:12:05.123Z` → (`2026-09-30T01:12:05`, 123_000_000). UTC
/// instants only (what the operator writes); anything else is `None`.
fn instant_key(ts: &str) -> Option<(&str, u32)> {
    let bytes = ts.as_bytes();
    if !ts.is_ascii() || ts.len() < 20 || bytes[10] != b'T' || !ts.ends_with('Z') {
        return None;
    }
    let (secs, rest) = ts.split_at(19);
    let rest = &rest[..rest.len() - 1];
    let frac = match rest.strip_prefix('.') {
        None if rest.is_empty() => 0,
        Some(digits) if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) => {
            let mut nanos = String::from(&digits[..digits.len().min(9)]);
            while nanos.len() < 9 {
                nanos.push('0');
            }
            nanos.parse().ok()?
        }
        _ => return None,
    };
    Some((secs, frac))
}

/// Put a loaded transcript in the order the turns happened. The array is
/// appended by more than one writer — owner turns when the command is
/// accepted, assistant turns when the runtime's reply is recorded — so its
/// storage order can put every owner turn ahead of every reply (P-005 review:
/// the resumed conversation read "you, you, you, you, agent, agent, …").
/// Each turn carries the instant it happened; a stable sort on it restores the
/// conversation. If any timestamp is unreadable the stored order is kept
/// rather than guessed at.
pub fn in_time_order(turns: &mut [AgentChatTranscriptTurn]) {
    if turns.iter().all(|turn| instant_key(&turn.ts).is_some()) {
        turns.sort_by(|a, b| instant_key(&a.ts).cmp(&instant_key(&b.ts)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn turn(role: &str, content: &str, ts: &str) -> AgentChatTranscriptTurn {
        serde_json::from_value(json!({ "role": role, "content": content, "ts": ts })).unwrap()
    }

    #[test]
    fn a_transcript_stored_owner_turns_first_reads_back_in_the_order_it_happened() {
        let mut turns = vec![
            turn("user", "hi", "2026-09-30T01:10:00Z"),
            turn("user", "read calc.js", "2026-09-30T01:10:20.5Z"),
            turn("assistant", "Hi!", "2026-09-30T01:10:09.100Z"),
            turn("assistant", "calc.js defines…", "2026-09-30T01:10:26.000Z"),
            turn(
                "assistant",
                "same second, later",
                "2026-09-30T01:10:20.600Z",
            ),
        ];
        in_time_order(&mut turns);
        let order: Vec<&str> = turns.iter().map(|t| t.content.as_str()).collect();
        assert_eq!(
            order,
            vec![
                "hi",
                "Hi!",
                "read calc.js",
                "same second, later",
                "calc.js defines…"
            ]
        );

        // An unreadable timestamp keeps the stored order untouched.
        let mut odd = vec![
            turn("user", "b", "2026-09-30T01:10:20Z"),
            turn("assistant", "a", "yesterday"),
        ];
        in_time_order(&mut odd);
        assert_eq!(odd[0].content, "b");
    }

    #[test]
    fn decodes_lifecycle_payloads() {
        let list: AgentChatListResponse = serde_json::from_value(json!({
            "chats": [{
                "id": "chat-1",
                "role": "worker",
                "feature_id": "WI-1",
                "title": "Native chat",
                "turn_count": 2,
                "total_input_tokens": 11,
                "total_output_tokens": 7,
                "total_cost_usd_cents": 1.25,
                "usage_complete": true,
                "created_at": "2026-08-24T00:00:00.000Z",
                "updated_at": "2026-08-24T00:01:00.000Z",
                "archived_at": null
            }]
        }))
        .expect("decode list");
        assert_eq!(list.chats[0].turn_count, 2);
        assert_eq!(list.chats[0].feature_id.as_deref(), Some("WI-1"));
        assert_eq!(list.chats[0].total_input_tokens, Some(11));
        assert_eq!(list.chats[0].total_output_tokens, Some(7));
        assert_eq!(list.chats[0].total_cost_usd_cents, Some(1.25));
        assert!(list.chats[0].usage_complete);

        let chat: AgentChat = serde_json::from_value(json!({
            "id": "chat-1",
            "role": "worker",
            "feature_id": "WI-1",
            "title": "Native chat",
            "transcript": [{
                "role": "assistant",
                "content": "done",
                "ts": "2026-08-24T00:01:00.000Z",
                "tokens_in": 11,
                "tokens_out": 7,
                "cost_cents": 1.25,
                "engine": "loop",
                "model": "claude-sonnet-4-6:high",
                "account_route": "auto",
                "unreportedFrames": 1,
                "tools": [{
                    "name": "chat:ask_choice",
                    "input": {"question": "ship?"},
                    "answered": {"picks": [{"option_id": "yes", "label": "Yes"}], "at": 1}
                }]
            }],
            "total_input_tokens": 11,
            "total_output_tokens": 7,
            "total_cost_usd_cents": 1.25,
            "usage_complete": false,
            "created_at": "2026-08-24T00:00:00.000Z",
            "updated_at": "2026-08-24T00:01:00.000Z",
            "archived_at": null,
            "feature_lock": {"taken_by": "su-1", "taken_at": null, "expires_at": null, "active": true}
        }))
        .expect("decode chat");
        assert_eq!(chat.transcript[0].unreported_frames, Some(1));
        assert_eq!(chat.transcript[0].engine.as_deref(), Some("loop"));
        assert_eq!(
            chat.transcript[0].model.as_deref(),
            Some("claude-sonnet-4-6:high")
        );
        assert_eq!(chat.transcript[0].account_route.as_deref(), Some("auto"));
        assert_eq!(chat.total_input_tokens, Some(11));
        assert_eq!(chat.total_output_tokens, Some(7));
        assert_eq!(chat.total_cost_usd_cents, Some(1.25));
        assert!(!chat.usage_complete);
        assert_eq!(
            chat.transcript[0].tools[0].answered.as_ref().unwrap().picks[0].option_id,
            "yes"
        );
        assert!(chat.feature_lock.unwrap().active);
    }

    #[test]
    fn missing_usage_fields_remain_unknown_instead_of_becoming_zero() {
        let chat: AgentChat = serde_json::from_value(json!({
            "id": "legacy-chat",
            "role": "operator",
            "transcript": []
        }))
        .expect("decode chat without optional usage");
        let usage = AgentChatUsage::from(&chat);
        assert_eq!(usage.input_tokens, None);
        assert_eq!(usage.output_tokens, None);
        assert_eq!(usage.cost_usd_cents, None);
    }

    #[test]
    fn incomplete_usage_aggregate_stays_unknown_even_when_stored_totals_are_zero() {
        let chat: AgentChat = serde_json::from_value(json!({
            "id": "incomplete-chat",
            "role": "operator",
            "transcript": [],
            "total_input_tokens": 0,
            "total_output_tokens": 0,
            "total_cost_usd_cents": 0,
            "usage_complete": false
        }))
        .expect("decode incomplete usage");
        assert_eq!(AgentChatUsage::from(&chat), AgentChatUsage::default());
    }

    #[test]
    fn builds_lifecycle_and_approval_wire_exactly() {
        assert_eq!(
            agent_chats_list_path(
                "hive one",
                &AgentChatListOptions {
                    include_archived: true,
                    limit: Some(25),
                    offset: Some(50),
                }
            ),
            "/api/harness/hive%20one/agent-chats?include=archived&limit=25&offset=50"
        );
        assert_eq!(
            agent_chat_tasks_path("hive/one", "chat/a"),
            "/api/harness/hive%2Fone/agent-chats/chat%2Fa/tasks"
        );
        assert_eq!(
            agent_chat_approval_path("hive", "chat-1", "call/1"),
            "/api/harness/hive/agent-chats/chat-1/approvals/call%2F1"
        );

        let decision = serde_json::to_value(AgentChatApprovalDecision {
            approved: false,
            reason: Some("unsafe".to_string()),
        })
        .unwrap();
        assert_eq!(decision, json!({"approved": false, "reason": "unsafe"}));

        let mutation = serde_json::to_value(AgentChatTaskMutation {
            action: AgentChatTaskAction::ClearBlocker,
            task_id: Some("task-1".to_string()),
            content: None,
            active_form: None,
            blocker_ref: None,
            expected_updated_at: Some("2026-08-26T00:00:00.000Z".to_string()),
            explanation: Some("Cleared by operator".to_string()),
        })
        .unwrap();
        assert_eq!(
            mutation,
            json!({
                "action": "clear_blocker",
                "taskId": "task-1",
                "expectedUpdatedAt": "2026-08-26T00:00:00.000Z",
                "explanation": "Cleared by operator"
            })
        );
        assert_eq!(
            serde_json::to_value(AgentChatTaskAction::Promote).unwrap(),
            json!("promote")
        );
    }

    #[test]
    fn decodes_task_mutation_response_contract() {
        let response: AgentChatTaskMutationResponse = serde_json::from_value(json!({
            "ok": true,
            "action": "check",
            "op": "done",
            "changedTaskId": "task-1",
            "tasks": [{
                "id": "task-1",
                "content": "Ship it",
                "activeForm": "Shipping it",
                "status": "completed",
                "blockerRef": null,
                "explanation": "Checked in Context",
                "position": 0,
                "createdAt": "2026-08-26T00:00:00.000Z",
                "updatedAt": "2026-08-26T00:00:01.000Z",
                "links": [{
                    "workItemId": "WI-9",
                    "workItemHarness": "papercusp",
                    "relation": "for"
                }]
            }],
            "projection": {
                "schemaVersion": "conversation-context-v1",
                "session": {
                    "sourceKind": "agent_chat",
                    "sessionId": "chat-1",
                    "harness": "papercusp",
                    "role": "worker",
                    "linkedWorkItemId": null,
                    "capabilityTier": "owned-loop"
                },
                "capabilities": {
                    "liveFrames": true,
                    "taskWrite": true,
                    "approvalWrite": true
                },
                "frames": [{
                    "id": "task:task-1",
                    "kind": "task",
                    "taskId": "task-1",
                    "content": "Ship it",
                    "activeForm": "Shipping it",
                    "status": "completed",
                    "blockerRef": null,
                    "explanation": "Checked in Context",
                    "position": 0,
                    "updatedAt": "2026-08-26T00:00:01.000Z",
                    "links": [{
                        "workItemId": "WI-9",
                        "workItemHarness": "papercusp",
                        "relation": "for"
                    }]
                }]
            }
        }))
        .expect("decode task mutation response");
        assert_eq!(response.action, AgentChatTaskAction::Check);
        assert_eq!(response.op, "done");
        assert_eq!(response.tasks[0].status, "completed");
        assert_eq!(response.tasks[0].links[0].work_item_id, "WI-9");
        assert_eq!(
            response.tasks[0].links[0].relation,
            crate::models::ConversationTaskLinkRelation::For
        );
        assert_eq!(response.projection.session.session_id, "chat-1");
        assert!(matches!(
            &response.projection.frames[0],
            crate::models::ConversationContextFrame::Task { links, .. }
                if links[0].work_item_id == "WI-9"
                    && links[0].relation == crate::models::ConversationTaskLinkRelation::For
        ));
    }

    #[test]
    fn decodes_pending_approvals_camel_case_contract() {
        let response: AgentChatApprovalsResponse = serde_json::from_value(json!({
            "approvals": [{
                "chatId": "chat-1",
                "callId": "call-1",
                "workspaceId": "ws-1",
                "toolName": "capability:write",
                "toolInput": {"path": "x"},
                "stepIndex": 2,
                "requestedAt": "2026-08-24T00:00:00.000Z"
            }]
        }))
        .expect("decode approvals");
        assert_eq!(response.approvals[0].call_id, "call-1");
        assert_eq!(response.approvals[0].step_index, 2);
    }
}
