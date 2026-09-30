//! Semantic summaries for well-known agent tools in the existing chat-card lane.
//!
//! This is deliberately a pure registry over [`ChatToolCall`]. The transport owns
//! ingestion/bounding, the transcript owns layout, and unknown tools return `None`
//! so the generic card remains the lossless fallback.

use crate::models::{ActivityRow, ChatToolCall, ToolOutcome};
use serde_json::Value;

const ROW_VALUE_CHARS: usize = 180;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SemanticTone {
    Neutral,
    Positive,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SemanticRow {
    pub label: &'static str,
    pub value: String,
    pub tone: SemanticTone,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SemanticToolCard {
    pub title: String,
    pub rows: Vec<SemanticRow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FleetEventClass {
    Exception,
    Claim,
    Gate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FleetEventSemantic {
    pub transition: String,
    pub fleet_slug: String,
    pub class: FleetEventClass,
    pub title: String,
    pub subject: String,
    pub detail: String,
}

pub(crate) fn card_for_tool(tool: &ChatToolCall) -> Option<SemanticToolCard> {
    let (name, input) = effective_call(tool);
    if tool_name_is(name, "work_items:complete") {
        return Some(completion_card(input, tool.result.as_ref(), &tool.outcome));
    }
    if tool_name_is(name, "locks:acquire") {
        return lock_block_card(input, tool.result.as_ref());
    }
    if tool_name_is(name, "coord:send") {
        return Some(send_card(input, tool.result.as_ref(), &tool.outcome));
    }
    if tool_name_is(name, "plans:set-status") {
        return Some(plan_flip_card(input, tool.result.as_ref()));
    }
    if tool_name_is(name, "tasks:ops") {
        return Some(task_card(input, tool.result.as_ref()));
    }
    if tool_name_is(name, "work_items:checkpoint") {
        return Some(checkpoint_card(input, tool.result.as_ref()));
    }
    None
}

/// Build the semantic card shown by the command palette after an explicit
/// `tools:invoke`. Known tools reuse the exact chat-card registry above;
/// everything else gets a bounded, common-field summary rather than a raw JSON
/// dump. This keeps palette and transcript semantics on one source of truth.
pub(crate) fn card_for_invocation(
    name: &str,
    args: &Value,
    result: Result<&Value, &str>,
) -> SemanticToolCard {
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            return SemanticToolCard {
                title: format!("Tool failed · {name}"),
                rows: vec![row("error", error.to_string(), SemanticTone::Warning)],
            };
        }
    };
    let call = ChatToolCall {
        name: name.to_string(),
        id: None,
        needs_approval: false,
        input: Some(args.clone()),
        result: Some(result.clone()),
        outcome: ToolOutcome::Ok,
    };
    card_for_tool(&call).unwrap_or_else(|| generic_invocation_card(name, result))
}

fn generic_invocation_card(name: &str, result: &Value) -> SemanticToolCard {
    let mut rows = Vec::new();
    push_found(
        &mut rows,
        "status",
        Some(result),
        &["status", "state", "verdict", "outcome"],
        SemanticTone::Positive,
    );
    push_found(
        &mut rows,
        "summary",
        Some(result),
        &["summary", "message", "note", "reason"],
        SemanticTone::Neutral,
    );
    push_found(
        &mut rows,
        "subject",
        Some(result),
        &["id", "slug", "name", "ref"],
        SemanticTone::Neutral,
    );
    push_found(
        &mut rows,
        "count",
        Some(result),
        &["count", "total", "totalMatches", "matched"],
        SemanticTone::Neutral,
    );
    if rows.is_empty() {
        rows.push(row(
            "result",
            compact(result).unwrap_or_else(|| "ok".into()),
            SemanticTone::Neutral,
        ));
    }
    SemanticToolCard {
        title: format!("Tool result · {name}"),
        rows,
    }
}

/// Interpret the activity-ledger row written by the fleet event bridge. This is
/// shared by the leader tape and the agent's inline transcript cards so the two
/// renderers cannot disagree about an event's meaning.
pub(crate) fn fleet_event_semantic(row: &ActivityRow) -> Option<FleetEventSemantic> {
    if row.tool_name.as_deref() != Some("fleet:event") {
        return None;
    }
    let detail = row.detail.as_ref()?.as_object()?;
    let transition = detail.get("transition")?.as_str()?.to_string();
    let fleet_slug = detail.get("fleetSlug")?.as_str()?.to_string();
    let payload = detail.get("payload").and_then(Value::as_object);
    let value = |key: &str| payload.and_then(|p| p.get(key)).and_then(compact);
    let actor = value("agentId")
        .or_else(|| value("assignee"))
        .or_else(|| value("priorAssignee"))
        .unwrap_or_else(|| row.owner_id.clone());
    let item = value("id");
    let state = value("state");
    let from = value("from");
    let to = value("to");

    let (class, title, subject, event_detail) = match transition.as_str() {
        "member-dead" => (
            FleetEventClass::Exception,
            "Fleet member died",
            actor,
            format!(
                "{} → {}",
                from.unwrap_or_else(|| "unknown".into()),
                to.unwrap_or_else(|| "ended".into())
            ),
        ),
        "context-critical" => (
            FleetEventClass::Exception,
            "Context critical",
            actor,
            format!(
                "{} → {}",
                from.unwrap_or_else(|| "unknown".into()),
                to.unwrap_or_else(|| "critical".into())
            ),
        ),
        "admission-blocked" => (
            FleetEventClass::Exception,
            "Fleet admission blocked",
            fleet_slug.clone(),
            format!(
                "{} → {}",
                from.unwrap_or_else(|| "0".into()),
                to.unwrap_or_else(|| "1".into())
            ),
        ),
        "claim-released" => (
            FleetEventClass::Claim,
            "Claim released",
            item.unwrap_or_else(|| "work item".into()),
            format!("by {actor} · re-placeable"),
        ),
        "item-completed" => (
            FleetEventClass::Claim,
            "Item completed",
            item.unwrap_or_else(|| "work item".into()),
            format!("{} · by {actor}", state.unwrap_or_else(|| "done".into())),
        ),
        "drained" => (
            FleetEventClass::Gate,
            "Fleet drained",
            fleet_slug.clone(),
            "all claimable lanes settled".into(),
        ),
        _ => return None,
    };

    Some(FleetEventSemantic {
        transition,
        fleet_slug,
        class,
        title: title.into(),
        subject,
        detail: event_detail,
    })
}

pub(crate) fn card_for_activity(row: &ActivityRow) -> Option<SemanticToolCard> {
    let event = fleet_event_semantic(row)?;
    let tone = match event.class {
        FleetEventClass::Exception => SemanticTone::Warning,
        FleetEventClass::Claim | FleetEventClass::Gate => SemanticTone::Positive,
    };
    Some(SemanticToolCard {
        title: event.title,
        rows: vec![
            self::row("fleet", event.fleet_slug, SemanticTone::Neutral),
            self::row("subject", event.subject, tone),
            self::row("detail", event.detail, SemanticTone::Neutral),
        ],
    })
}

fn effective_call(tool: &ChatToolCall) -> (&str, Option<&Value>) {
    if tool_name_is(&tool.name, "tools:invoke") {
        if let Some(input) = tool.input.as_ref() {
            if let Some(name) = input.get("name").and_then(Value::as_str) {
                return (name, input.get("args"));
            }
        }
    }
    (&tool.name, tool.input.as_ref())
}

fn tool_name_is(actual: &str, canonical: &str) -> bool {
    // Model families record the same tool under different manglings:
    //   - canonical / prefixed-canonical: `work_items:complete`
    //   - Claude-family MCP ids: `mcp__papercusp-su__work_items_complete` (':' → '_')
    //   - double-underscore family: `work_items__complete` (':' → '__')
    actual == canonical
        || actual.ends_with(canonical)
        || actual.ends_with(&canonical.replace(':', "_"))
        || actual.ends_with(&canonical.replace(':', "__"))
}

fn completion_card(
    input: Option<&Value>,
    result: Option<&Value>,
    outcome: &ToolOutcome,
) -> SemanticToolCard {
    let id = input
        .and_then(|v| find_key(v, "id", 0))
        .or_else(|| result.and_then(|v| find_key(v, "id", 0)))
        .and_then(compact)
        .unwrap_or_else(|| "work item".into());
    let title = match outcome {
        ToolOutcome::Ok => format!("Completed {id}"),
        ToolOutcome::Failed(_) => format!("Completion failed · {id}"),
        ToolOutcome::Denied => format!("Completion denied · {id}"),
        ToolOutcome::Skipped => format!("Completion skipped · {id}"),
        ToolOutcome::Pending => format!("Completing {id}"),
    };
    let mut rows = Vec::new();
    push_found(
        &mut rows,
        "evidence",
        input,
        &["summary"],
        SemanticTone::Positive,
    );
    push_found(
        &mut rows,
        "tests",
        input,
        &["testResult", "test_result", "testsRun", "tests"],
        SemanticTone::Neutral,
    );
    push_found(
        &mut rows,
        "verified",
        input,
        &["verifiedHow", "verified_how"],
        SemanticTone::Neutral,
    );
    if rows.is_empty() {
        push_found(
            &mut rows,
            "result",
            result,
            &["summary", "state", "status"],
            SemanticTone::Neutral,
        );
    }
    SemanticToolCard { title, rows }
}

fn lock_block_card(input: Option<&Value>, result: Option<&Value>) -> Option<SemanticToolCard> {
    let busy = result.and_then(|v| find_key(v, "busy", 0))?;
    let busy = busy.as_array().and_then(|a| a.first()).unwrap_or(busy);
    let mut rows = Vec::new();
    push_found(
        &mut rows,
        "path",
        Some(busy),
        &["path", "file"],
        SemanticTone::Neutral,
    );
    if rows.is_empty() {
        push_found(
            &mut rows,
            "path",
            input,
            &["paths", "path"],
            SemanticTone::Neutral,
        );
    }
    push_found(
        &mut rows,
        "holder",
        Some(busy),
        &["owner_label", "ownerLabel", "holder", "owner"],
        SemanticTone::Warning,
    );
    push_found(
        &mut rows,
        "intent",
        Some(busy),
        &["intent"],
        SemanticTone::Neutral,
    );
    push_found(
        &mut rows,
        "queue",
        result,
        &["queue_position", "queuePosition", "position"],
        SemanticTone::Neutral,
    );
    Some(SemanticToolCard {
        title: "Lock blocked".into(),
        rows,
    })
}

fn send_card(
    input: Option<&Value>,
    result: Option<&Value>,
    outcome: &ToolOutcome,
) -> SemanticToolCard {
    let woken = result
        .and_then(|v| find_key(v, "woken", 0))
        .and_then(Value::as_i64);
    let missed = result
        .and_then(|v| {
            find_key(v, "recipient_absent", 0).or_else(|| find_key(v, "recipient_dead", 0))
        })
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let title = if missed || matches!(outcome, ToolOutcome::Failed(_)) {
        "Message missed"
    } else if woken.unwrap_or(0) > 0 {
        "Message delivered + woke recipient"
    } else {
        "Message delivered"
    };
    let mut rows = Vec::new();
    push_found(
        &mut rows,
        "recipient",
        input,
        &["to"],
        SemanticTone::Neutral,
    );
    if let Some(n) = woken {
        rows.push(row(
            "woken",
            n.to_string(),
            if n > 0 {
                SemanticTone::Positive
            } else {
                SemanticTone::Warning
            },
        ));
    }
    push_found(
        &mut rows,
        "message",
        result,
        &["msg_id", "msgId"],
        SemanticTone::Neutral,
    );
    SemanticToolCard {
        title: title.into(),
        rows,
    }
}

fn plan_flip_card(input: Option<&Value>, result: Option<&Value>) -> SemanticToolCard {
    let item = result
        .and_then(|v| find_key(v, "itemId", 0).or_else(|| find_key(v, "item_id", 0)))
        .or_else(|| input.and_then(|v| find_key(v, "item", 0)))
        .and_then(compact)
        .unwrap_or_else(|| "plan item".into());
    let status = result
        .and_then(|v| find_key(v, "newStatus", 0).or_else(|| find_key(v, "new_status", 0)))
        .or_else(|| input.and_then(|v| find_key(v, "status", 0)))
        .and_then(compact)
        .unwrap_or_else(|| "updated".into());
    let mut rows = Vec::new();
    push_found(
        &mut rows,
        "plan",
        input,
        &["slug", "plan"],
        SemanticTone::Neutral,
    );
    if let Some(old) = result
        .and_then(|v| find_key(v, "oldStatus", 0).or_else(|| find_key(v, "old_status", 0)))
        .and_then(compact)
    {
        rows.push(row(
            "transition",
            format!("{old} → {status}"),
            SemanticTone::Positive,
        ));
    }
    push_found(
        &mut rows,
        "note",
        input,
        &["note", "rationale"],
        SemanticTone::Neutral,
    );
    SemanticToolCard {
        title: format!("{item} → {status}"),
        rows,
    }
}

fn task_card(input: Option<&Value>, result: Option<&Value>) -> SemanticToolCard {
    let op = input
        .and_then(|v| find_key(v, "op", 0))
        .or_else(|| result.and_then(|v| find_key(v, "op", 0)))
        .and_then(compact)
        .unwrap_or_else(|| "updated".into());
    let changed = result
        .and_then(|v| find_key(v, "changedTaskId", 0).or_else(|| find_key(v, "changed_task_id", 0)))
        .or_else(|| {
            input.and_then(|v| find_key(v, "task_id", 0).or_else(|| find_key(v, "taskId", 0)))
        })
        .and_then(compact);
    let mut rows = Vec::new();
    if let Some(id) = changed.as_ref() {
        rows.push(row("task", id.clone(), SemanticTone::Neutral));
    }
    push_found(
        &mut rows,
        "content",
        input,
        &["content", "activeForm", "active_form"],
        SemanticTone::Neutral,
    );
    push_found(
        &mut rows,
        "blocker",
        input,
        &["blocker_ref", "blockerRef"],
        SemanticTone::Warning,
    );
    push_found(
        &mut rows,
        "explanation",
        input,
        &["explanation"],
        SemanticTone::Neutral,
    );
    push_found(
        &mut rows,
        "status",
        result,
        &["status"],
        SemanticTone::Positive,
    );
    let target = changed.map(|id| format!(" · {id}")).unwrap_or_default();
    SemanticToolCard {
        title: format!("Task {op}{target}"),
        rows,
    }
}

fn checkpoint_card(input: Option<&Value>, result: Option<&Value>) -> SemanticToolCard {
    let id = input
        .and_then(|v| find_key(v, "id", 0))
        .or_else(|| result.and_then(|v| find_key(v, "id", 0)))
        .and_then(compact)
        .unwrap_or_else(|| "work item".into());
    let mut rows = Vec::new();
    push_found(
        &mut rows,
        "checkpoint",
        input,
        &["checkpoint"],
        SemanticTone::Neutral,
    );
    push_found(
        &mut rows,
        "stored",
        result,
        &["checkpointUpdatedAt", "updatedAt", "cleared"],
        SemanticTone::Positive,
    );
    SemanticToolCard {
        title: format!("Checkpoint saved · {id}"),
        rows,
    }
}

fn push_found(
    rows: &mut Vec<SemanticRow>,
    label: &'static str,
    root: Option<&Value>,
    keys: &[&str],
    tone: SemanticTone,
) {
    let Some(root) = root else { return };
    if let Some(value) = keys
        .iter()
        .find_map(|key| find_key(root, key, 0))
        .and_then(compact)
    {
        rows.push(row(label, value, tone));
    }
}

fn row(label: &'static str, value: String, tone: SemanticTone) -> SemanticRow {
    SemanticRow {
        label,
        value: truncate(&flatten(&value), ROW_VALUE_CHARS),
        tone,
    }
}

fn find_key<'a>(value: &'a Value, key: &str, depth: u8) -> Option<&'a Value> {
    if depth > 4 {
        return None;
    }
    match value {
        Value::Object(map) => map
            .get(key)
            .or_else(|| map.values().find_map(|v| find_key(v, key, depth + 1))),
        Value::Array(items) => items.iter().find_map(|v| find_key(v, key, depth + 1)),
        _ => None,
    }
}

fn compact(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) if s.trim().is_empty() => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(v) => Some(v.to_string()),
        Value::Number(v) => Some(v.to_string()),
        Value::Array(values) => {
            let values: Vec<_> = values.iter().filter_map(compact).take(4).collect();
            (!values.is_empty()).then(|| values.join(", "))
        }
        Value::Object(_) => serde_json::to_string(value).ok(),
    }
}

fn flatten(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(name: &str, input: Value, result: Option<Value>) -> ChatToolCall {
        ChatToolCall {
            name: name.into(),
            id: Some("call-1".into()),
            needs_approval: false,
            input: Some(input),
            result,
            outcome: ToolOutcome::Ok,
        }
    }

    fn fleet_activity(transition: &str, payload: Value) -> ActivityRow {
        ActivityRow {
            owner_id: payload
                .get("agentId")
                .and_then(Value::as_str)
                .unwrap_or("fleet:pui-cockpit")
                .into(),
            kind: "lifecycle".into(),
            tool_name: Some("fleet:event".into()),
            detail: Some(json!({
                "eventKey": format!("fleet:{transition}:pui-cockpit"),
                "fleetSlug": "pui-cockpit",
                "transition": transition,
                "payload": payload,
            })),
            ..ActivityRow::default()
        }
    }

    #[test]
    fn completion_surfaces_evidence_not_raw_envelope() {
        let card = card_for_tool(&call(
            "work_items:complete",
            json!({"id":"WI-7","completion":{"summary":"landed it","testResult":"12 passed"}}),
            Some(json!({"ok":true})),
        ))
        .unwrap();
        assert_eq!(card.title, "Completed WI-7");
        assert!(card
            .rows
            .iter()
            .any(|r| r.label == "evidence" && r.value == "landed it"));
        assert!(card
            .rows
            .iter()
            .any(|r| r.label == "tests" && r.value == "12 passed"));
    }

    #[test]
    fn lock_block_names_holder_intent_and_queue() {
        let card = card_for_tool(&call("locks:acquire", json!({"paths":["a.rs"]}), Some(json!({"busy":[{"path":"a.rs","holder":"su-1","intent":"editing"}],"queuePosition":2})))).unwrap();
        assert_eq!(card.title, "Lock blocked");
        assert!(card
            .rows
            .iter()
            .any(|r| r.label == "holder" && r.value == "su-1"));
        assert!(card
            .rows
            .iter()
            .any(|r| r.label == "intent" && r.value == "editing"));
        assert!(card
            .rows
            .iter()
            .any(|r| r.label == "queue" && r.value == "2"));
    }

    #[test]
    fn send_distinguishes_wake_from_miss() {
        let woke = card_for_tool(&call(
            "coord:send",
            json!({"to":["su-1"]}),
            Some(json!({"woken":1})),
        ))
        .unwrap();
        assert!(woke.title.contains("woke"));
        let missed = card_for_tool(&call(
            "coord:send",
            json!({"to":["su-dead"]}),
            Some(json!({"woken":0,"recipient_dead":true})),
        ))
        .unwrap();
        assert_eq!(missed.title, "Message missed");
    }

    #[test]
    fn plan_task_and_checkpoint_cards_keep_their_semantics() {
        let plan = card_for_tool(&call(
            "plans:set-status",
            json!({"slug":"cockpit","item":"P-007","status":"done"}),
            Some(json!({"results":[{"itemId":"P-007","oldStatus":"wip","newStatus":"done"}]})),
        ))
        .unwrap();
        assert_eq!(plan.title, "P-007 → done");
        let task = card_for_tool(&call("tasks:ops", json!({"op":"block","task_id":"t-2","blocker_ref":"lock:a.rs","explanation":"waiting for holder"}), Some(json!({"changedTaskId":"t-2"})))).unwrap();
        assert!(task.rows.iter().any(|r| r.label == "explanation"));
        let checkpoint = card_for_tool(&call(
            "work_items:checkpoint",
            json!({"id":"WI-7","checkpoint":"next: tests"}),
            Some(json!({"ok":true})),
        ))
        .unwrap();
        assert_eq!(checkpoint.title, "Checkpoint saved · WI-7");
    }

    #[test]
    fn tools_invoke_is_unwrapped_and_unknown_tools_fall_back() {
        let wrapped = call(
            "tools:invoke",
            json!({"name":"tasks:ops","args":{"op":"done","task_id":"t-1"}}),
            Some(json!({"changedTaskId":"t-1"})),
        );
        assert_eq!(card_for_tool(&wrapped).unwrap().title, "Task done · t-1");
        assert!(card_for_tool(&call("capability:read", json!({"file_path":"x"}), None)).is_none());
    }

    #[test]
    fn palette_invocation_reuses_known_cards_and_bounds_unknown_results() {
        let args = json!({"op":"done","task_id":"t-1"});
        let known = card_for_invocation("tasks:ops", &args, Ok(&json!({"changedTaskId":"t-1"})));
        assert_eq!(known.title, "Task done · t-1");

        let unknown_result = json!({
            "status":"green",
            "summary":"the requested operation completed",
            "ignored":{"very":"large"}
        });
        let unknown = card_for_invocation("custom:probe", &json!({}), Ok(&unknown_result));
        assert_eq!(unknown.title, "Tool result · custom:probe");
        assert!(unknown
            .rows
            .iter()
            .any(|row| row.label == "status" && row.value == "green"));
        assert!(unknown.rows.iter().any(|row| row.label == "summary"));

        let failed = card_for_invocation("custom:probe", &json!({}), Err("denied"));
        assert_eq!(failed.title, "Tool failed · custom:probe");
        assert_eq!(failed.rows[0].tone, SemanticTone::Warning);
    }

    #[test]
    fn alias_shims_match_every_first_wave_verb_per_model_family() {
        // Proven card-producing payloads per verb (mirrors the tests above —
        // the card fns are deliberately None-y on empty input).
        let cases: [(&str, Value, Option<Value>); 6] = [
            (
                "work_items:complete",
                json!({"id":"WI-7","completion":{"summary":"landed it","testResult":"12 passed"}}),
                Some(json!({"ok":true})),
            ),
            (
                "locks:acquire",
                json!({"paths":["a.rs"]}),
                Some(
                    json!({"busy":[{"path":"a.rs","holder":"su-1","intent":"editing"}],"queuePosition":2}),
                ),
            ),
            (
                "coord:send",
                json!({"to":["su-1"]}),
                Some(json!({"woken":1})),
            ),
            (
                "plans:set-status",
                json!({"slug":"cockpit","item":"P-007","status":"done"}),
                Some(json!({"results":[{"itemId":"P-007","oldStatus":"wip","newStatus":"done"}]})),
            ),
            (
                "tasks:ops",
                json!({"op":"block","task_id":"t-2","blocker_ref":"lock:a.rs","explanation":"waiting for holder"}),
                Some(json!({"changedTaskId":"t-2"})),
            ),
            (
                "work_items:checkpoint",
                json!({"id":"WI-7","checkpoint":"next: tests"}),
                Some(json!({"ok":true})),
            ),
        ];
        for (verb, input, result) in cases {
            let canonical = card_for_tool(&call(verb, input.clone(), result.clone()))
                .unwrap_or_else(|| panic!("canonical {verb} produced no card"));
            let aliases = [
                // Claude-family MCP id: mcp__<server>__<verb with ':' → '_'>
                format!("mcp__papercusp-su__{}", verb.replace(':', "_")),
                // double-underscore mangling: ':' → '__'
                verb.replace(':', "__"),
                // prefixed canonical (suffix arm)
                format!("papercusp-su:{verb}"),
            ];
            for alias in aliases {
                let card = card_for_tool(&call(&alias, input.clone(), result.clone()))
                    .unwrap_or_else(|| panic!("alias {alias} produced no card for {verb}"));
                assert_eq!(
                    card.title, canonical.title,
                    "alias {alias} diverged from {verb}"
                );
            }
        }
        // A non-card tool stays cardless under the same manglings.
        assert!(
            card_for_tool(&call("mcp__papercusp-su__capability_read", json!({}), None)).is_none()
        );
    }

    #[test]
    fn fleet_activity_cards_share_typed_semantics_with_the_tape() {
        let row = fleet_activity(
            "member-dead",
            json!({"fleetSlug":"pui-cockpit","agentId":"su-a","from":"live","to":"ended"}),
        );
        let event = fleet_event_semantic(&row).unwrap();
        assert_eq!(event.class, FleetEventClass::Exception);
        assert_eq!(event.subject, "su-a");
        assert_eq!(event.detail, "live → ended");
        let card = card_for_activity(&row).unwrap();
        assert_eq!(card.title, "Fleet member died");
        assert!(card
            .rows
            .iter()
            .any(|r| r.label == "fleet" && r.value == "pui-cockpit"));
    }
}
