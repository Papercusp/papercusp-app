//! Inline terminal card system for the operator chat pane
//! (sentinel-tui-shared-backend-and-cards-2026-06-22, Phase 2a).
//!
//! The server-side card machinery is reused as-is: the brain calls
//! `chat:ask_choice` → `ctx.askUser` → the card-correlator mirrors the pending
//! set onto the state-channel `openCards` snapshot, streamed to clients over
//! `GET /api/operator/state-snapshot` (`snapshot` events carrying a
//! `VersionedSnapshot`). The user's pick POSTs to
//! `/api/operator/conversations/:id/card-response`, which resolves the brain's
//! blocked tool call. This module is the TUI's RENDERER + RESPONDER — the
//! ratatui analogue of the browser's `PendingCardsBar` / `AskChoiceCard` /
//! `InputCard`.
//!
//! Wire shapes mirrored here (server source of truth):
//!   - `OpenCardSnapshot`  — `libs/generic/tooldef/src/types.ts` (~L990)
//!   - `CardPresentation`  — same file (~L908)
//!   - submit payload      — `{ picks: [option_id, …] }` for radio/checkbox,
//!     `{ value: … }` for text/date/slider
//!     (`apps/operator/app/_components/chat/PendingCardsBar.tsx`)
//!   - `/card-response` body — `{ correlationId, workspaceId, action, payload? }`
//!     (`packages/operator-core/lib/post-card-response.ts`)

use std::time::{Duration, Instant};

use crossterm::event::KeyCode;
use serde::Deserialize;

use crate::chat_tags::Report;

/// How long after an answered card leaves the screen a repeat of the key that
/// answered it is still treated as that same press (P-015). Double taps, key
/// bounce and autorepeat all land well inside it; each swallowed repeat extends
/// it, so a held key stays swallowed for as long as it is held.
pub const CARD_REPEAT_WINDOW: Duration = Duration::from_millis(400);

/// The card this client just answered (P-015). It stays in the queue until the
/// server's close event, but renders as one summary line and takes no input,
/// so it cannot be answered twice and the next card is not focused under it.
#[derive(Debug, Clone, PartialEq)]
pub struct AnsweredCard {
    pub correlation_id: String,
    /// What the row says the answer was: "Approved", "Declined", "Skipped", or
    /// "Answered: <choice>".
    pub summary: String,
}

/// The one-line summary an answered card collapses to (P-015): what the user
/// chose, in words, from the `/card-response` action and payload about to be
/// sent. Approval cards read "Approved" / "Declined"; other choices name the
/// picked option labels; Esc reads "Skipped" (P-014: a skip is not a failure).
pub fn answer_summary(card: &OpenCard, action: &str, payload: Option<&serde_json::Value>) -> String {
    match action {
        "decline" => return "Skipped".to_string(),
        "cancel" => return "Cancelled".to_string(),
        _ => {}
    }
    let Some(payload) = payload else {
        return "Answered".to_string();
    };
    if let Some(picks) = payload.get("picks").and_then(|p| p.as_array()) {
        let labels: Vec<String> = picks
            .iter()
            .filter_map(|id| id.as_str())
            .map(|id| {
                card.presentation
                    .options()
                    .iter()
                    .find(|o| o.id == id)
                    .map(|o| o.label.clone())
                    .unwrap_or_else(|| id.to_string())
            })
            .collect();
        return match labels.as_slice() {
            [one] if one == "Approve" => "Approved".to_string(),
            [one] if one == "Decline" => "Declined".to_string(),
            _ => format!("Answered: {}", labels.join(", ")),
        };
    }
    match payload.get("value") {
        Some(serde_json::Value::String(s)) => format!("Answered: {s}"),
        Some(v) => format!("Answered: {v}"),
        None => "Answered".to_string(),
    }
}

/// The key that answered the last card, and until when a repeat of it is
/// swallowed rather than delivered to the next card.
#[derive(Debug, Clone)]
struct RepeatGuard {
    key: KeyCode,
    until: Instant,
}

/// One clickable option of a radio / checkbox card. Mirrors `CardOption`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CardOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub hint: Option<String>,
    #[serde(default)]
    pub style: Option<String>,
}

/// The visual presentation hint — the discriminated `CardPresentation` union.
/// `kind` is the discriminant; unknown kinds map to `Unknown` (fallbackText).
#[derive(Debug, Clone, PartialEq)]
pub enum CardPresentation {
    Radio {
        options: Vec<CardOption>,
    },
    Checkbox {
        options: Vec<CardOption>,
    },
    Text {
        placeholder: Option<String>,
        multiline: bool,
    },
    Date {
        min: Option<String>,
        max: Option<String>,
    },
    Slider {
        min: f64,
        max: f64,
        step: f64,
    },
    /// No presentation / an unrecognized kind — render `fallbackText` only.
    Unknown,
}

impl CardPresentation {
    fn from_json(v: Option<&serde_json::Value>) -> Self {
        let Some(v) = v else { return Self::Unknown };
        let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        match kind {
            "radio" => Self::Radio {
                options: parse_options(v),
            },
            "checkbox" => Self::Checkbox {
                options: parse_options(v),
            },
            "text" => Self::Text {
                placeholder: v
                    .get("placeholder")
                    .and_then(|p| p.as_str())
                    .map(str::to_string),
                multiline: v
                    .get("multiline")
                    .and_then(|m| m.as_bool())
                    .unwrap_or(false),
            },
            "date" => Self::Date {
                min: v.get("min").and_then(|m| m.as_str()).map(str::to_string),
                max: v.get("max").and_then(|m| m.as_str()).map(str::to_string),
            },
            "slider" => Self::Slider {
                min: v.get("min").and_then(|m| m.as_f64()).unwrap_or(0.0),
                max: v.get("max").and_then(|m| m.as_f64()).unwrap_or(100.0),
                step: v.get("step").and_then(|m| m.as_f64()).unwrap_or(1.0),
            },
            _ => Self::Unknown,
        }
    }

    /// Options for a choice card (radio/checkbox), else empty.
    pub fn options(&self) -> &[CardOption] {
        match self {
            Self::Radio { options } | Self::Checkbox { options } => options,
            _ => &[],
        }
    }
}

fn parse_options(v: &serde_json::Value) -> Vec<CardOption> {
    v.get("options")
        .and_then(|o| o.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|o| serde_json::from_value::<CardOption>(o.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// One open card, mirroring the wire `OpenCardSnapshot` plus its owning `runId`
/// (needed to scope a `/run-cancel`; the per-card answer needs only the
/// correlationId + workspace).
#[derive(Debug, Clone, PartialEq)]
pub struct OpenCard {
    pub correlation_id: String,
    pub run_id: String,
    /// The workspace this card is scoped to — the `/card-response`
    /// `expectedWorkspaceId` gate. Carried on the wire (`VersionedSnapshot`)
    /// so the renderer answers without out-of-band workspace knowledge.
    pub workspace_id: Option<String>,
    pub prompt: String,
    pub presentation: CardPresentation,
    pub fallback_text: Option<String>,
    /// The wire `details` field: shown only behind the details toggle.
    pub details: Option<String>,
    pub allow_decline: bool,
    pub report: Option<Report>,
    pub created_at: f64,
}

impl OpenCard {
    /// Supporting detail shown only behind Ctrl+R (pui-chat-first-ux P-008):
    /// a tool approval's raw arguments under its readable prompt.
    pub fn details(&self) -> Option<&str> {
        self.details.as_deref()
    }
}

/// A versioned per-run state snapshot, mirroring `VersionedSnapshot` /
/// `SnapshotEnvelope` (`apps/operator/lib/use-state-snapshots.ts`). Only
/// `openCards` is consumed; `toolState` is ignored here.
#[derive(Debug, Clone)]
pub struct SnapshotEnvelope {
    pub run_id: String,
    pub workspace_id: Option<String>,
    pub version: u64,
    pub cards: Vec<OpenCard>,
}

impl SnapshotEnvelope {
    /// Parse one `snapshot` SSE frame's JSON `data` into an envelope. Returns
    /// `None` on a shape mismatch (defensive — a server-side bug must not crash
    /// the pane), mirroring `isValidSnapshotEnvelope`.
    pub fn from_json(data: &str) -> Option<Self> {
        let v: serde_json::Value = serde_json::from_str(data).ok()?;
        let run_id = v.get("runId").and_then(|r| r.as_str())?.to_string();
        if run_id.is_empty() {
            return None;
        }
        let version = v.get("version").and_then(|x| x.as_u64())?;
        let workspace_id = v
            .get("workspaceId")
            .and_then(|w| w.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let snapshot = v.get("snapshot")?;
        let open_cards = snapshot.get("openCards").and_then(|c| c.as_array())?;
        let cards = open_cards
            .iter()
            .filter_map(|c| parse_open_card(c, &run_id, workspace_id.as_deref()))
            .collect();
        Some(Self {
            run_id,
            workspace_id,
            version,
            cards,
        })
    }
}

fn parse_open_card(
    v: &serde_json::Value,
    run_id: &str,
    workspace_id: Option<&str>,
) -> Option<OpenCard> {
    let correlation_id = v.get("correlationId").and_then(|c| c.as_str())?.to_string();
    if correlation_id.is_empty() {
        return None;
    }
    let prompt = v
        .get("prompt")
        .and_then(|p| p.as_str())
        .unwrap_or("")
        .to_string();
    let presentation = CardPresentation::from_json(v.get("presentation"));
    let fallback_text = v
        .get("fallbackText")
        .and_then(|t| t.as_str())
        .map(str::to_string);
    let details = v
        .get("details")
        .and_then(|d| d.as_str())
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(str::to_string);
    // Default true (matches the server: only an explicit `false` hides decline).
    let allow_decline = v
        .get("allowDecline")
        .and_then(|a| a.as_bool())
        .unwrap_or(true);
    let report = v
        .get("report")
        .and_then(|r| serde_json::from_value::<Report>(r.clone()).ok());
    let created_at = v.get("createdAt").and_then(|c| c.as_f64()).unwrap_or(0.0);
    Some(OpenCard {
        correlation_id,
        run_id: run_id.to_string(),
        workspace_id: workspace_id.map(str::to_string),
        prompt,
        presentation,
        fallback_text,
        details,
        allow_decline,
        report,
        created_at,
    })
}

/// What the user produced for the focused card — the run loop turns this into a
/// `/card-response` POST body.
#[derive(Debug, Clone, PartialEq)]
pub enum CardResponse {
    /// Choice card — the picked option ids (one for radio, ≥1 for checkbox).
    SubmitPicks(Vec<String>),
    /// Input card — a string value (text/date) or a number rendered as a string.
    SubmitValue(serde_json::Value),
}

/// The live interaction state for the focused card: the highlighted option,
/// the checkbox toggles, and the input buffer / slider value. Reset whenever
/// the focused correlationId changes.
#[derive(Debug, Clone, Default)]
pub struct CardState {
    /// The union of open cards across every run, createdAt-ascending within a
    /// run (the correlator's order), runs in snapshot-arrival order. The HEAD
    /// is the focused card (mirrors `selectFocusedCard` — oldest first).
    cards: Vec<OpenCard>,
    /// The per-run snapshot versions seen, so a stale (lower-version) snapshot
    /// for a run never overwrites a newer one. runId → version.
    versions: std::collections::HashMap<String, u64>,
    /// Per-run ordering: the order runs first appeared (deterministic flatten).
    run_order: Vec<String>,
    /// runId → its current cards (rebuilt into `cards` on each change).
    by_run: std::collections::HashMap<String, Vec<OpenCard>>,
    /// Correlation ids the user answered locally — optimistically hidden until
    /// the next snapshot drops them (the SSE-disconnected bridge, matching the
    /// browser's `dismissed` set).
    dismissed: std::collections::HashSet<String>,
    /// The card answered on this client and awaiting the server's close (P-015).
    answered: Option<AnsweredCard>,
    /// Swallows a repeat of the answering key (P-015).
    repeat_guard: Option<RepeatGuard>,
    /// Highlighted option index (radio/checkbox) for the focused card.
    pub sel: usize,
    /// Checkbox toggles (option index → checked) for the focused card.
    checked: std::collections::HashSet<usize>,
    /// Text/date input buffer for the focused card.
    pub input: String,
    /// Slider value for the focused card.
    pub slider: f64,
    /// The correlationId the interaction state above is bound to (detects a
    /// focus change so we reset selection/input).
    bound: Option<String>,
}

impl CardState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply a fresh per-run snapshot. Monotonic per run (later version wins);
    /// rebuilds the flattened focus order and re-binds the interaction state if
    /// the focused card changed.
    pub fn apply_snapshot(&mut self, mut env: SnapshotEnvelope) {
        if let Some(&seen) = self.versions.get(&env.run_id) {
            if seen >= env.version {
                return; // stale — a newer snapshot already landed
            }
        }
        self.versions.insert(env.run_id.clone(), env.version);
        if !self.run_order.contains(&env.run_id) {
            self.run_order.push(env.run_id.clone());
        }
        if env.cards.is_empty() {
            self.by_run.remove(&env.run_id);
        } else {
            // Backfill any card missing a per-card workspace from the envelope's
            // run-level workspaceId (defense in depth for the /card-response gate).
            if let Some(ws) = &env.workspace_id {
                for c in env.cards.iter_mut() {
                    if c.workspace_id.is_none() {
                        c.workspace_id = Some(ws.clone());
                    }
                }
            }
            self.by_run.insert(env.run_id.clone(), env.cards);
        }
        self.rebuild();
    }

    /// SU session events describe one card change, not a full run snapshot.
    /// Merge them before using the shared snapshot/version/focus machinery.
    pub fn apply_delta(&mut self, mut env: SnapshotEnvelope, closed_id: Option<&str>) {
        let mut cards = self.by_run.get(&env.run_id).cloned().unwrap_or_default();
        for card in env.cards {
            if let Some(existing) = cards
                .iter_mut()
                .find(|c| c.correlation_id == card.correlation_id)
            {
                *existing = card;
            } else {
                cards.push(card);
            }
        }
        if let Some(id) = closed_id {
            cards.retain(|card| card.correlation_id != id);
        }
        env.cards = cards;
        self.apply_snapshot(env);
    }

    /// Rebuild the flattened `cards` list (run-order, createdAt within a run)
    /// minus locally-dismissed ids, then re-bind interaction state to the head.
    fn rebuild(&mut self) {
        let mut out: Vec<OpenCard> = Vec::new();
        for rid in &self.run_order {
            if let Some(cards) = self.by_run.get(rid) {
                for c in cards {
                    if !self.dismissed.contains(&c.correlation_id) {
                        out.push(c.clone());
                    }
                }
            }
        }
        // Drop dismissed ids that the server has now removed from every run, so
        // the set can't grow unboundedly.
        let live: std::collections::HashSet<&str> = self
            .by_run
            .values()
            .flatten()
            .map(|c| c.correlation_id.as_str())
            .collect();
        self.dismissed.retain(|d| live.contains(d.as_str()));
        // The server closed the card this client answered: the next card can be
        // focused now, but a repeat of the answering key still belongs to the
        // closed card, so the window restarts from the moment it disappears.
        if self
            .answered
            .as_ref()
            .is_some_and(|a| !live.contains(a.correlation_id.as_str()))
        {
            self.answered = None;
            if let Some(guard) = self.repeat_guard.as_mut() {
                guard.until = guard.until.max(Instant::now() + CARD_REPEAT_WINDOW);
            }
        }
        self.cards = out;
        self.rebind();
    }

    /// Record that the focused card was just answered with `key` (P-015). It
    /// collapses to one summary line at once and takes no further input until
    /// the server closes it or the answer fails to send.
    pub fn mark_answered(&mut self, correlation_id: &str, summary: String, key: KeyCode) {
        self.answered = Some(AnsweredCard {
            correlation_id: correlation_id.to_string(),
            summary,
        });
        self.repeat_guard = Some(RepeatGuard {
            key,
            until: Instant::now() + CARD_REPEAT_WINDOW,
        });
    }

    /// The focused card's answered state, when the focused card is the one this
    /// client answered and the server has not closed it yet.
    pub fn focused_answered(&self) -> Option<&AnsweredCard> {
        let head = self.cards.first()?;
        self.answered
            .as_ref()
            .filter(|a| a.correlation_id == head.correlation_id)
    }

    /// The answer to `correlation_id` did not reach the server: the card is
    /// answerable again, and nothing about it is treated as a repeat.
    pub fn restore_answer(&mut self, correlation_id: &str) {
        if self
            .answered
            .as_ref()
            .is_some_and(|a| a.correlation_id == correlation_id)
        {
            self.answered = None;
            self.repeat_guard = None;
        }
    }

    /// Whether `key` must be swallowed instead of acting on the focused card
    /// (P-015). True for every key while the focused card is already answered,
    /// and for a repeat of the answering key inside the repeat window (which
    /// the repeat extends). Any other key ends the guard: the user has moved on.
    pub fn swallow_key(&mut self, key: KeyCode, now: Instant) -> bool {
        if self.focused_answered().is_some() {
            if let Some(guard) = self.repeat_guard.as_mut() {
                if guard.key == key {
                    guard.until = guard.until.max(now + CARD_REPEAT_WINDOW);
                }
            }
            return true;
        }
        match self.repeat_guard.as_mut() {
            Some(guard) if guard.key == key && now < guard.until => {
                guard.until = now + CARD_REPEAT_WINDOW;
                true
            }
            Some(_) => {
                self.repeat_guard = None;
                false
            }
            None => false,
        }
    }

    /// Let the repeat window lapse (tests stand in for the wall clock).
    #[cfg(test)]
    pub fn expire_repeat_guard(&mut self) {
        if let Some(guard) = self.repeat_guard.as_mut() {
            guard.until = Instant::now() - Duration::from_millis(1);
        }
    }

    /// Re-initialize selection / input when the focused card changes.
    fn rebind(&mut self) {
        let head_id = self.cards.first().map(|c| c.correlation_id.clone());
        if head_id == self.bound {
            // Same focused card — keep the user's in-progress selection/input,
            // but clamp the selection in case the option set shrank.
            if let Some(head) = self.cards.first() {
                let n = head.presentation.options().len();
                if n > 0 && self.sel >= n {
                    self.sel = n - 1;
                }
            }
            return;
        }
        self.bound = head_id;
        self.sel = 0;
        self.checked.clear();
        self.input.clear();
        if let Some(CardPresentation::Slider { min, max, step }) =
            self.cards.first().map(|c| &c.presentation)
        {
            // Initialize to the midpoint snapped to the step (matches the web
            // SliderInputCard default).
            let mid = (min + max) / 2.0;
            self.slider = snap(mid, *min, *step);
        } else {
            self.slider = 0.0;
        }
    }

    /// The focused card (front of queue), or `None` when no card is open.
    pub fn focused(&self) -> Option<&OpenCard> {
        self.cards.first()
    }

    /// How many cards remain after the focused one (the queue indicator).
    pub fn remaining(&self) -> usize {
        self.cards.len().saturating_sub(1)
    }

    pub fn has_card(&self) -> bool {
        !self.cards.is_empty()
    }

    /// Whether option index `i` is toggled (checkbox cards).
    pub fn is_checked(&self, i: usize) -> bool {
        self.checked.contains(&i)
    }

    // ─── interaction ────────────────────────────────────────────────────

    /// Move the highlight (radio/checkbox) by `delta` (wraps within bounds).
    pub fn move_sel(&mut self, down: bool) {
        let Some(head) = self.cards.first() else {
            return;
        };
        let n = head.presentation.options().len();
        if n == 0 {
            return;
        }
        if down {
            self.sel = (self.sel + 1) % n;
        } else {
            self.sel = (self.sel + n - 1) % n;
        }
    }

    /// Toggle the highlighted option (checkbox cards only).
    pub fn toggle_checked(&mut self) {
        if let Some(CardPresentation::Checkbox { .. }) = self.cards.first().map(|c| &c.presentation)
        {
            if self.checked.contains(&self.sel) {
                self.checked.remove(&self.sel);
            } else {
                self.checked.insert(self.sel);
            }
        }
    }

    /// Select option by 1-based number (radio: commits, returns a response;
    /// checkbox: toggles that option). Returns the response when a number-pick
    /// commits a radio card.
    pub fn pick_number(&mut self, n: usize) -> Option<CardResponse> {
        let head = self.cards.first()?;
        let opts = head.presentation.options();
        if n == 0 || n > opts.len() {
            return None;
        }
        let idx = n - 1;
        match head.presentation {
            CardPresentation::Radio { .. } => {
                self.sel = idx;
                self.submit()
            }
            CardPresentation::Checkbox { .. } => {
                self.sel = idx;
                self.toggle_checked();
                None
            }
            _ => None,
        }
    }

    /// Adjust a slider by `delta` steps (clamped).
    pub fn nudge_slider(&mut self, up: bool) {
        if let Some(CardPresentation::Slider { min, max, step }) =
            self.cards.first().map(|c| &c.presentation)
        {
            let next = if up {
                self.slider + step
            } else {
                self.slider - step
            };
            self.slider = snap(next.clamp(*min, *max), *min, *step);
        }
    }

    /// Append a char to the text/date input buffer.
    pub fn type_char(&mut self, c: char) {
        if matches!(
            self.cards.first().map(|c| &c.presentation),
            Some(CardPresentation::Text { .. }) | Some(CardPresentation::Date { .. })
        ) {
            self.input.push(c);
        }
    }

    /// Backspace the input buffer.
    pub fn backspace(&mut self) {
        self.input.pop();
    }

    /// Commit the current selection/input into a `CardResponse`. Returns `None`
    /// when the response would be empty (no option highlighted, empty text) so
    /// the caller can no-op rather than POST a rejected payload.
    pub fn submit(&self) -> Option<CardResponse> {
        let head = self.cards.first()?;
        match &head.presentation {
            CardPresentation::Radio { options } => {
                let opt = options.get(self.sel)?;
                Some(CardResponse::SubmitPicks(vec![opt.id.clone()]))
            }
            CardPresentation::Checkbox { options } => {
                let mut picks: Vec<String> = self
                    .checked
                    .iter()
                    .filter_map(|&i| options.get(i).map(|o| o.id.clone()))
                    .collect();
                if picks.is_empty() {
                    // Nothing toggled — treat the highlighted row as the pick so
                    // Enter on a fresh checkbox still commits something.
                    let opt = options.get(self.sel)?;
                    picks.push(opt.id.clone());
                }
                Some(CardResponse::SubmitPicks(picks))
            }
            CardPresentation::Text { .. } | CardPresentation::Date { .. } => {
                let trimmed = self.input.trim();
                if trimmed.is_empty() {
                    return None;
                }
                Some(CardResponse::SubmitValue(serde_json::Value::String(
                    trimmed.to_string(),
                )))
            }
            CardPresentation::Slider { .. } => {
                Some(CardResponse::SubmitValue(serde_json::json!(self.slider)))
            }
            CardPresentation::Unknown => None,
        }
    }

    /// The focused card's correlationId — what a `/card-response` POST targets.
    pub fn focused_correlation_id(&self) -> Option<String> {
        self.cards.first().map(|c| c.correlation_id.clone())
    }

    /// The focused card's workspace (the `/card-response` `expectedWorkspaceId`
    /// gate), when the wire carried one.
    pub fn focused_workspace_id(&self) -> Option<String> {
        self.cards.first().and_then(|c| c.workspace_id.clone())
    }

    /// Optimistically hide a card the user just answered (the SSE-disconnected
    /// bridge). The next snapshot that drops it from `openCards` is the
    /// authoritative removal; until then we hide it locally.
    #[cfg(test)]
    pub fn dismiss(&mut self, correlation_id: &str) {
        self.dismissed.insert(correlation_id.to_string());
        self.rebuild();
    }
}

/// Snap `v` to the nearest `step` boundary anchored at `min` (matches the web
/// slider's `round(v/step)*step` with a `min` origin).
fn snap(v: f64, min: f64, step: f64) -> f64 {
    if step <= 0.0 {
        return v;
    }
    min + ((v - min) / step).round() * step
}

#[cfg(test)]
mod tests {
    use super::*;

    fn radio_snapshot(run: &str, cid: &str, version: u64) -> SnapshotEnvelope {
        let data = serde_json::json!({
            "runId": run,
            "workspaceId": "ws-test",
            "version": version,
            "snapshot": {
                "openCards": [{
                    "correlationId": cid,
                    "prompt": "Pick one",
                    "presentation": {
                        "kind": "radio",
                        "options": [
                            { "id": "a", "label": "Alpha" },
                            { "id": "b", "label": "Beta", "hint": "the second" }
                        ]
                    },
                    "fallbackText": "Pick one:\n 1. Alpha\n 2. Beta",
                    "allowDecline": true,
                    "createdAt": 1000.0
                }]
            }
        })
        .to_string();
        SnapshotEnvelope::from_json(&data).expect("parses")
    }

    #[test]
    fn parses_radio_snapshot() {
        let env = radio_snapshot("run-1", "corr-1", 1);
        assert_eq!(env.run_id, "run-1");
        assert_eq!(env.workspace_id.as_deref(), Some("ws-test"));
        assert_eq!(env.version, 1);
        assert_eq!(env.cards.len(), 1);
        let c = &env.cards[0];
        assert_eq!(c.correlation_id, "corr-1");
        assert_eq!(c.run_id, "run-1");
        assert_eq!(c.workspace_id.as_deref(), Some("ws-test"));
        assert_eq!(c.prompt, "Pick one");
        assert!(c.allow_decline);
        match &c.presentation {
            CardPresentation::Radio { options } => {
                assert_eq!(options.len(), 2);
                assert_eq!(options[0].id, "a");
                assert_eq!(options[1].hint.as_deref(), Some("the second"));
            }
            other => panic!("expected radio, got {other:?}"),
        }
    }

    #[test]
    fn radio_arrow_select_and_submit() {
        let mut s = CardState::new();
        s.apply_snapshot(radio_snapshot("run-1", "corr-1", 1));
        assert!(s.has_card());
        assert_eq!(s.sel, 0);
        s.move_sel(true);
        assert_eq!(s.sel, 1);
        // wrap
        s.move_sel(true);
        assert_eq!(s.sel, 0);
        s.move_sel(false);
        assert_eq!(s.sel, 1);
        let resp = s.submit().expect("submit");
        assert_eq!(resp, CardResponse::SubmitPicks(vec!["b".into()]));
        // The focused card exposes its workspace for the /card-response gate.
        assert_eq!(s.focused_workspace_id().as_deref(), Some("ws-test"));
        assert_eq!(s.focused_correlation_id().as_deref(), Some("corr-1"));
    }

    #[test]
    fn radio_number_pick_commits() {
        let mut s = CardState::new();
        s.apply_snapshot(radio_snapshot("run-1", "corr-1", 1));
        let resp = s.pick_number(1).expect("commit");
        assert_eq!(resp, CardResponse::SubmitPicks(vec!["a".into()]));
        // out of range → no commit
        assert!(s.pick_number(9).is_none());
    }

    #[test]
    fn checkbox_toggle_and_submit() {
        let data = serde_json::json!({
            "runId": "r", "version": 1,
            "snapshot": { "openCards": [{
                "correlationId": "c", "prompt": "Select all",
                "presentation": { "kind": "checkbox", "options": [
                    {"id":"x","label":"X"},{"id":"y","label":"Y"},{"id":"z","label":"Z"}
                ]},
                "createdAt": 1.0
            }]}
        })
        .to_string();
        let env = SnapshotEnvelope::from_json(&data).unwrap();
        let mut s = CardState::new();
        s.apply_snapshot(env);
        s.toggle_checked(); // index 0 (x)
        s.move_sel(true);
        s.move_sel(true);
        s.toggle_checked(); // index 2 (z)
        let resp = s.submit().expect("submit");
        match resp {
            CardResponse::SubmitPicks(mut picks) => {
                picks.sort();
                assert_eq!(picks, vec!["x".to_string(), "z".to_string()]);
            }
            other => panic!("expected picks, got {other:?}"),
        }
    }

    #[test]
    fn text_input_submit_and_empty_noop() {
        let data = serde_json::json!({
            "runId": "r", "version": 1,
            "snapshot": { "openCards": [{
                "correlationId": "c", "prompt": "Name?",
                "presentation": { "kind": "text", "placeholder": "type" },
                "createdAt": 1.0
            }]}
        })
        .to_string();
        let mut s = CardState::new();
        s.apply_snapshot(SnapshotEnvelope::from_json(&data).unwrap());
        assert!(s.submit().is_none()); // empty → no-op
        for ch in "hi".chars() {
            s.type_char(ch);
        }
        let resp = s.submit().expect("submit");
        assert_eq!(
            resp,
            CardResponse::SubmitValue(serde_json::Value::String("hi".into()))
        );
    }

    #[test]
    fn slider_nudge_and_submit() {
        let data = serde_json::json!({
            "runId": "r", "version": 1,
            "snapshot": { "openCards": [{
                "correlationId": "c", "prompt": "How many?",
                "presentation": { "kind": "slider", "min": 0, "max": 10, "step": 2 },
                "createdAt": 1.0
            }]}
        })
        .to_string();
        let mut s = CardState::new();
        s.apply_snapshot(SnapshotEnvelope::from_json(&data).unwrap());
        // midpoint = 5, snapped to step-2 from min-0 → 6 (round(5/2)*2 = 6)
        assert_eq!(s.slider, 6.0);
        s.nudge_slider(true);
        assert_eq!(s.slider, 8.0);
        s.nudge_slider(false);
        s.nudge_slider(false);
        s.nudge_slider(false);
        s.nudge_slider(false);
        s.nudge_slider(false); // clamp at 0
        assert_eq!(s.slider, 0.0);
        let resp = s.submit().expect("submit");
        assert_eq!(resp, CardResponse::SubmitValue(serde_json::json!(0.0)));
    }

    #[test]
    fn newer_version_wins_stale_ignored() {
        let mut s = CardState::new();
        s.apply_snapshot(radio_snapshot("run-1", "corr-1", 5));
        // A stale (lower-version) snapshot must NOT clobber the live card.
        let empty = serde_json::json!({
            "runId": "run-1", "version": 2, "snapshot": { "openCards": [] }
        })
        .to_string();
        s.apply_snapshot(SnapshotEnvelope::from_json(&empty).unwrap());
        assert!(s.has_card(), "stale empty snapshot should be ignored");
        // A newer empty snapshot DOES clear it.
        let empty_new = serde_json::json!({
            "runId": "run-1", "version": 6, "snapshot": { "openCards": [] }
        })
        .to_string();
        s.apply_snapshot(SnapshotEnvelope::from_json(&empty_new).unwrap());
        assert!(!s.has_card());
    }

    #[test]
    fn dismiss_hides_until_snapshot_drops() {
        let mut s = CardState::new();
        s.apply_snapshot(radio_snapshot("run-1", "corr-1", 1));
        assert!(s.has_card());
        s.dismiss("corr-1");
        assert!(!s.has_card(), "dismissed card hidden immediately");
        // Server-side resolution arrives — the card leaves openCards; dismissed
        // set self-prunes.
        let empty = serde_json::json!({
            "runId": "run-1", "version": 2, "snapshot": { "openCards": [] }
        })
        .to_string();
        s.apply_snapshot(SnapshotEnvelope::from_json(&empty).unwrap());
        assert!(!s.has_card());
    }

    #[test]
    fn focus_order_is_oldest_first_across_runs() {
        let mut s = CardState::new();
        s.apply_snapshot(radio_snapshot("run-1", "corr-1", 1));
        s.apply_snapshot(radio_snapshot("run-2", "corr-2", 1));
        assert_eq!(s.focused().unwrap().correlation_id, "corr-1");
        assert_eq!(s.remaining(), 1);
    }

    #[test]
    fn malformed_snapshot_rejected() {
        assert!(SnapshotEnvelope::from_json("{not json}").is_none());
        // missing runId
        assert!(
            SnapshotEnvelope::from_json(r#"{"version":1,"snapshot":{"openCards":[]}}"#).is_none()
        );
        // missing snapshot
        assert!(SnapshotEnvelope::from_json(r#"{"runId":"r","version":1}"#).is_none());
    }
}
