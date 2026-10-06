//! Model + account pickers for the pui chat pane — P-005's final lane (WI-41189).
//!
//! Two axes the operator can change about the session a chat runs on:
//!
//!   • MODEL   — which model/tier the next SU-session launch runs at. The
//!     transport already exists in `su_session.rs`, so this lane is the MENU
//!     and the pick, never the wire.
//!   • ACCOUNT — which inference-gateway pool account the agent routes through.
//!
//! ── THE MODEL MENU IS SERVER-OWNED (do not hardcode it here) ──
//! `GET /api/agent-config` returns `effectiveTiers`: the workspace override when
//! present, otherwise the committed baseline. A tier list hardcoded in the pui
//! would be a second copy of a truth the server owns — the derived-truth-ladder
//! failure — and would silently diverge the moment someone edits the workspace
//! tiers. So the menu is whatever the server said, and an EMPTY menu renders as
//! empty rather than falling back to invented rows.
//!
//! ── THE ACCOUNT SEMANTICS ARE INHERITED, NOT INVENTED ──
//! Ported from the operator-side pill (`apps/operator/lib/chat-actions/
//! AccountAction.ts`, plan `hud-chat-owner-controls-2026-08-11` D-005/D-006/
//! D-009), which derived them by reading the writer (`agent-tools/gateway/
//! gateway.ts`). Restated because none of it is guessable from the verb names:
//!
//!   1. THE THREE VALUES ARE NOT THREE OF A KIND.
//!      · a pool account       → `accounts:pin`   (live, durable)
//!      · `auto`               → `accounts:unpin` (live; reverts to launch routing)
//!      · default system account → NOT REACHABLE. A `--account=default` session
//!      bypasses the gateway, so there is no pin to change; it must be
//!      RESPAWNED. It stays in the menu as a disabled row carrying that reason,
//!      because the owner asked for the option by name and a silently-dropped
//!      row misreports what the control does.
//!   2. A `--account=default` session makes EVERY row a no-op, so the whole menu
//!      disables with the reason. UNKNOWN launch argv is deliberately NOT treated
//!      as gateway-free — disabling on an absence is the same unsourced guess in
//!      the other direction.
//!   3. NEVER claim the session IS on an account. `accounts:pin` is SOFT by
//!      default (the gateway yields when the account is paused/exhausted; only
//!      `hard:true` never fails over), and the write can land durably while the
//!      live push fails (`appliedLive:false`). So we report the PIN IN FORCE.
//!   4. Report what the SETTER RETURNED, never the value the user picked — a
//!      control that echoes its own input is a silent no-op in a nicer costume.
//!
//! ── ONE THING THIS DOES THAT THE PRECEDENT DOES NOT (deliberate) ──
//! `accounts:status`'s own description mandates: "Treat `readingStatus !==
//! 'fresh'` or a present `lastProbeFailedAt` as UNKNOWN, not measured-
//! unavailable." The operator pill reads a bare `available === false` as the
//! live fact "rate-limited or usage-walled right now", which renders a reading
//! that may be days old as a present-tense measurement (the EI-18809949582687481
//! class: a caller could not tell "we just measured this" from "we haven't asked
//! in days"). Here availability is a TRI-STATE and an unfresh row says so.
//! Capacity is never a reason to HIDE an account — pinning to a paused account
//! is a legitimate choice, and it recovers.

use serde::Deserialize;

/// Credentials are never included in reducer/debug diagnostics.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct SetupToken(pub String);

impl std::fmt::Debug for SetupToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}

/// Reconnect replaces this PUI process, closing all old subscriptions together.
/// The draft travels in the child environment, never in argv or a tree file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupReconnect {
    pub endpoint: String,
    pub message: String,
    pub token: SetupToken,
    pub keep_existing_token: bool,
}

pub const SETUP_DRAFT_ENV: &str = "PUI_SETUP_DRAFT";
/// Why setup reopened (P-021): set when a cancelled or failed `l` / `h`
/// hand-off returns to setup, shown as setup's note.
pub const SETUP_NOTE_ENV: &str = "PUI_SETUP_NOTE";

/// New-session configuration is isolated from the currently bound chat.
#[derive(Debug, Clone)]
pub struct SessionSetup {
    pub step: u8,
    pub project: String,
    pub project_query: String,
    pub project_searching: bool,
    pub project_cursor: usize,
    pub project_entry: Option<u8>,
    pub project_name: String,
    pub project_path: String,
    pub project_pending: bool,
    pub endpoint: String,
    pub endpoint_input: Option<String>,
    pub token: SetupToken,
    pub editing_token: bool,
    pub show_help: bool,
    pub help_scroll: u16,
    pub backend: crate::su_session::SuSessionBackend,
    /// Whether the owner picked `backend` (the backend picker, or an explicit
    /// chat pick carried in). An unpicked backend follows the operator's
    /// configured engine, including when that read lands after the panel
    /// opened (D-010; measured: a fast Enter launched Claude on an OMP box).
    pub backend_chosen: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub account: Option<String>,
    pub mode: Option<String>,
    pub message: String,
    pub editing_message: bool,
    pub note: Option<String>,
}

impl SessionSetup {
    pub fn new(endpoint: String, message: String) -> Self {
        Self {
            step: 0,
            // A restored scope/list cursor is not an explicit project choice.
            project: String::new(),
            project_query: String::new(),
            project_searching: false,
            project_cursor: 0,
            project_entry: None,
            project_name: String::new(),
            project_path: String::new(),
            project_pending: false,
            endpoint,
            endpoint_input: None,
            token: SetupToken::default(),
            editing_token: false,
            show_help: false,
            help_scroll: 0,
            backend: crate::su_session::PUI_DEFAULT_SU_BACKEND,
            backend_chosen: false,
            model: None,
            effort: None,
            // WI-10004164 / D-011: an account the owner has not chosen is not
            // sent, so launch-su can resolve it (an OMP gateway model -> auto).
            account: None,
            mode: None,
            message,
            editing_message: false,
            note: None,
        }
    }
}

/// One pickable row, in either picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickerOption {
    /// The value applied when this row is chosen (a model spec, or an account id).
    pub id: String,
    pub label: String,
    /// Why it is disabled, or what is true about it. A disabled row ALWAYS
    /// carries one — a dead end without a reason is just a dead end.
    pub hint: Option<String>,
    pub disabled: bool,
}

// ───────────────────────── model ─────────────────────────

/// A row of the server's model-tier menu (`/api/agent-config`).
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelTier {
    pub name: String,
    pub spec: String,
    /// The server's own guidance for when to pick this tier.
    #[serde(default)]
    pub when: Option<String>,
    #[serde(default)]
    pub backend: Option<String>,
    /// Server-side classification against the in-process Agent Chat loop.
    /// `None` is retained for compatibility with older operators; current
    /// `/api/agent-config.effectiveTiers` rows annotate every effective tier.
    #[serde(default)]
    pub loop_capability: Option<LoopModelCapability>,
}

/// One launch-time mode projected from operator-core's canonical mode registry.
/// PUI deliberately stores only renderable fields; validation remains owned by
/// the launch-su route and the same registry.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchableMode {
    pub id: String,
    pub title: String,
    pub one_liner: String,
}

/// The owned Agent Chat loop's executable boundary for one model tier. The
/// generic tier menu may contain selectors understood only by an OMP
/// subprocess; those rows remain visible but cannot be selected for Agent Chat.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoopModelCapability {
    #[serde(default)]
    pub executable: bool,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// "Don't send a model — let the server pick." `__`-prefixed so it can never
/// collide with a real model spec.
pub const MODEL_INHERIT: &str = "__inherit";

/// The model menu. `surface_default` is the spec the server would use when we
/// send nothing (from `config.surfaceModels`), shown on the inherit row so the
/// default is a value rather than a blank.
pub fn model_options(tiers: &[ModelTier], surface_default: Option<&str>) -> Vec<PickerOption> {
    let mut out = Vec::with_capacity(tiers.len() + 1);
    out.push(PickerOption {
        id: MODEL_INHERIT.to_string(),
        label: match surface_default {
            Some(spec) if !spec.is_empty() => format!("Default ({spec})"),
            // UNKNOWN stays unknown — we do not invent the server's default.
            _ => "Default (server picks)".to_string(),
        },
        hint: Some(
            "Send no model override; the server applies this surface's configured model."
                .to_string(),
        ),
        disabled: false,
    });
    for t in tiers {
        let normal_hint = match (&t.when, &t.backend) {
            (Some(w), Some(b)) => Some(format!("{w} · runs on {b}")),
            (Some(w), None) => Some(w.clone()),
            (None, Some(b)) => Some(format!("runs on {b}")),
            (None, None) => None,
        };
        let (disabled, hint) = match t.loop_capability.as_ref() {
            Some(capability) if !capability.executable => {
                let reason = capability
                    .reason
                    .as_deref()
                    .filter(|reason| !reason.is_empty())
                    .unwrap_or("this tier is not executable by the Agent Chat loop");
                let capability_hint = format!("not executable by Agent Chat loop: {reason}");
                let hint = normal_hint
                    .map(|guidance| format!("{capability_hint} · {guidance}"))
                    .unwrap_or(capability_hint);
                (true, Some(hint))
            }
            _ => (false, normal_hint),
        };
        out.push(PickerOption {
            id: t.spec.clone(),
            label: format!("{} — {}", t.name, t.spec),
            hint,
            disabled,
        });
    }
    out
}

/// What a model pick puts on the SU-session launch: `None` ⇒ omit `model`
/// entirely (the server's default).
pub fn model_pick(id: &str) -> Option<String> {
    if id == MODEL_INHERIT || id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

// ───────────────────────── effort ─────────────────────────

pub const EFFORT_INHERIT: &str = "__inherit_effort";

pub fn effort_options(levels: &[String]) -> Vec<PickerOption> {
    std::iter::once(PickerOption {
        id: EFFORT_INHERIT.to_string(),
        label: "Model/default effort".to_string(),
        hint: Some(
            "Keep the selected model tier's effort suffix, or let the provider choose.".to_string(),
        ),
        disabled: false,
    })
    .chain(levels.iter().map(|effort| PickerOption {
        id: effort.clone(),
        label: effort.clone(),
        hint: Some(
            "The provider validates whether this model supports the requested effort.".to_string(),
        ),
        disabled: false,
    }))
    .collect()
}

// ───────────────────────── launch mode ─────────────────────────

pub const MODE_INHERIT: &str = "__inherit_mode";

pub fn mode_options(modes: &[LaunchableMode]) -> Vec<PickerOption> {
    std::iter::once(PickerOption {
        id: MODE_INHERIT.to_string(),
        label: "Manual (no launch mode)".to_string(),
        hint: Some(
            "Launch without an autonomy mode; it can still be entered later via mode:set."
                .to_string(),
        ),
        disabled: false,
    })
    .chain(modes.iter().map(|mode| PickerOption {
        id: mode.id.clone(),
        label: mode.title.clone(),
        hint: Some(mode.one_liner.clone()),
        disabled: false,
    }))
    .collect()
}

pub fn mode_pick(id: &str) -> Option<String> {
    if id == MODE_INHERIT || id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

pub fn effort_pick(id: &str) -> Option<String> {
    if id == EFFORT_INHERIT || id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

// ───────────────────────── account ─────────────────────────

/// Gateway AUTO routing — the ABSENCE of a dynamic pin, as a pickable value.
pub const ACCOUNT_AUTO: &str = "auto";
/// The un-settable "default system account" row. `__`-prefixed so it can never
/// collide with a real pool account id.
pub const ACCOUNT_DEFAULT: &str = "__default";

const GATEWAY_FREE_HINT: &str = "This session was launched --account=default, which bypasses the inference gateway — a live pin cannot reach it. Respawn it to change accounts.";

/// Capacity as `accounts:status` actually licenses us to state it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capacity {
    Available,
    /// Measured not-servable: a bounded rate pause.
    RatePaused,
    /// Measured not-servable: an exhausted usage window (retrying is futile
    /// until the window resets, whatever the pause says).
    UsageWalled,
    /// The reading is stale, never-observed, or the last probe got no answer.
    /// NOT "unavailable" — we simply do not know.
    Unknown,
}

impl Capacity {
    fn hint(self) -> Option<&'static str> {
        match self {
            Capacity::Available => None,
            Capacity::RatePaused => Some("rate-limited right now"),
            Capacity::UsageWalled => Some("usage window exhausted"),
            Capacity::Unknown => Some("capacity unknown — reading is stale or never observed"),
        }
    }
}

/// One row of `accounts:status`, narrowed to what this menu reads.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRow {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub available: Option<bool>,
    #[serde(default)]
    pub usage_walled: Option<bool>,
    #[serde(default)]
    pub reading_status: Option<String>,
    #[serde(default)]
    pub last_probe_failed_at: Option<i64>,
    #[serde(default)]
    pub burn: Option<AccountBurnVerdict>,
}

/// The burn-governor projection embedded in `accounts:status`. Its units come
/// from the writer: utilization fraction/hour and an epoch-millisecond
/// projected exhaustion instant. `pacing-projection` is policy, not a wall.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountBurnVerdict {
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub disposition: String,
    #[serde(default)]
    pub projected_exhaustion_at: Option<i64>,
}

/// Canonical per-provider rollup returned by `accounts:status`. Counts are
/// consumed as written; account rows from different providers are never
/// re-grouped or reinterpreted in the TUI.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPoolVerdict {
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub serviceable: usize,
    #[serde(default)]
    pub walled_fresh: usize,
    #[serde(default)]
    pub pacing: usize,
    #[serde(default)]
    pub unknown: usize,
}

#[derive(Debug, Clone, Default)]
pub struct AccountsStatus {
    pub accounts: Vec<AccountRow>,
    pub pool_verdict: Vec<ProviderPoolVerdict>,
}

impl AccountRow {
    pub fn display_label(&self) -> &str {
        match &self.label {
            Some(l) if !l.is_empty() => l,
            _ => &self.id,
        }
    }

    /// The tri-state read `accounts:status` mandates. A `false` is only a
    /// measured verdict when the reading is FRESH and the last probe answered.
    pub fn capacity(&self) -> Capacity {
        if self.last_probe_failed_at.is_some() {
            return Capacity::Unknown;
        }
        // Absent readingStatus (an older operator) is UNKNOWN too — not fresh.
        if self.reading_status.as_deref() != Some("fresh") {
            return Capacity::Unknown;
        }
        match (self.available, self.usage_walled) {
            (Some(true), _) => Capacity::Available,
            (Some(false), Some(true)) => Capacity::UsageWalled,
            (Some(false), _) => Capacity::RatePaused,
            (None, _) => Capacity::Unknown,
        }
    }
}

/// Is this session outside the gateway's reach? Only an explicit `default`
/// answers yes; `None` is UNKNOWN and must not disable the menu.
pub fn is_gateway_free(launch_account: Option<&str>) -> bool {
    launch_account == Some("default")
}

/// The account menu, given the live pool.
pub fn account_options(pool: &[AccountRow], launch_account: Option<&str>) -> Vec<PickerOption> {
    let gateway_free = is_gateway_free(launch_account);
    let mut out = Vec::with_capacity(pool.len() + 2);

    out.push(PickerOption {
        id: ACCOUNT_AUTO.to_string(),
        label: "Auto (gateway routing)".to_string(),
        hint: Some(if gateway_free {
            GATEWAY_FREE_HINT.to_string()
        } else {
            "The gateway picks an available account per call and fails over when one is rate-limited. Clears any pin on this session.".to_string()
        }),
        disabled: gateway_free,
    });

    out.push(PickerOption {
        id: ACCOUNT_DEFAULT.to_string(),
        label: "Default system account".to_string(),
        // PRESENT BUT NOT SETTABLE. The owner named this option, so it is here;
        // it bypasses the gateway and has no pin to change.
        hint: Some(
            "Not settable here — the default account bypasses the gateway, so a session must be RESPAWNED on it rather than re-pinned live."
                .to_string(),
        ),
        disabled: true,
    });

    let mut rows: Vec<&AccountRow> = pool.iter().collect();
    rows.sort_by(|a, b| {
        a.display_label()
            .to_lowercase()
            .cmp(&b.display_label().to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });

    for a in rows {
        let hint = if gateway_free {
            Some(GATEWAY_FREE_HINT.to_string())
        } else {
            let parts: Vec<String> = [
                a.provider.clone().filter(|p| !p.is_empty()),
                a.capacity().hint().map(|h| h.to_string()),
            ]
            .into_iter()
            .flatten()
            .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(" · "))
            }
        };
        out.push(PickerOption {
            id: a.id.clone(),
            label: a.display_label().to_string(),
            hint,
            disabled: gateway_free,
        });
    }
    out
}

/// Account rows for a native chat turn or a fresh SU-session launch. Unlike a
/// live external-session re-pin, a fresh launch can explicitly choose the
/// gateway-free `default` system credential.
pub fn chat_account_options(pool: &[AccountRow]) -> Vec<PickerOption> {
    let mut out = account_options(pool, None);
    if let Some(auto) = out.first_mut() {
        auto.hint = Some(
            "No request pin; the inference gateway auto-routes and can fail over.".to_string(),
        );
    }
    if let Some(default) = out.get_mut(1) {
        default.disabled = false;
        default.hint = Some(
            "Use the system credential directly; the inference gateway is skipped.".to_string(),
        );
    }
    out
}

/// How the setup panel and the status line name a fresh launch's account
/// (WI-10004164 / D-011). An account the owner never chose is omitted from the
/// launch and launch-su resolves it: the system `default`, except an OMP
/// gateway model, which it routes to `auto`. Printing a bare "default" for the
/// unchosen case would misname that route and read like an explicit choice.
pub fn account_label(account: Option<&str>, backend: crate::su_session::SuSessionBackend) -> String {
    match account {
        Some(account) => account.to_string(),
        None if backend == crate::su_session::SuSessionBackend::Omp => {
            "default (not chosen; a gateway model uses auto)".to_string()
        }
        None => "default (not chosen)".to_string(),
    }
}

pub fn chat_account_pick(id: &str) -> Option<String> {
    match id {
        "" => None,
        ACCOUNT_AUTO => Some("auto".to_string()),
        ACCOUNT_DEFAULT => Some("default".to_string()),
        account => Some(account.to_string()),
    }
}

/// What applying a pick actually requires — the three values are not three of a
/// kind, so the caller cannot treat "set the account" as one operation.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "account pin controls are staged for the session configuration UI"
    )
)]
pub enum AccountPick {
    /// `accounts:pin { agent, account }`
    Pin { account: String },
    /// `accounts:unpin { agent }`
    Unpin,
    /// Nothing to call; `reason` is why, for display.
    NotSettable { reason: String },
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "account pin controls are staged for the session configuration UI"
    )
)]
pub fn account_pick(id: &str, launch_account: Option<&str>) -> AccountPick {
    if is_gateway_free(launch_account) {
        return AccountPick::NotSettable {
            reason: GATEWAY_FREE_HINT.to_string(),
        };
    }
    match id {
        ACCOUNT_DEFAULT => AccountPick::NotSettable {
            reason: "The default system account bypasses the gateway — respawn the session on it rather than pinning live.".to_string(),
        },
        ACCOUNT_AUTO => AccountPick::Unpin,
        other => AccountPick::Pin {
            account: other.to_string(),
        },
    }
}

/// What the SETTER reported — never what the user picked.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "account pin controls are staged for the session configuration UI"
    )
)]
pub struct PinOutcome {
    /// Is the pin actually in force on the live session? A durable write whose
    /// live push failed (`appliedLive:false`) is NOT in force.
    pub in_force: bool,
    pub summary: String,
}

/// Read `accounts:pin` / `accounts:unpin`'s own reply. Never asserts the session
/// IS on an account — only what the setter said about the PIN.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "account pin controls are staged for the session configuration UI"
    )
)]
pub fn describe_pin_outcome(reply: &serde_json::Value, picked_label: &str) -> PinOutcome {
    let get_bool = |k: &str| reply.get(k).and_then(|v| v.as_bool());
    let get_str = |k: &str| {
        reply
            .get(k)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };

    if get_bool("ok") == Some(false) {
        return PinOutcome {
            in_force: false,
            summary: format!(
                "account change FAILED: {}",
                get_str("error").unwrap_or_else(|| "unknown error".to_string())
            ),
        };
    }
    if get_bool("cleared") == Some(true) {
        return PinOutcome {
            in_force: true,
            summary: "pin cleared — routing reverted to the session's launch routing".to_string(),
        };
    }
    // `appliedLive` absent is NOT a failure claim — say what we know.
    match get_bool("appliedLive") {
        Some(false) => PinOutcome {
            in_force: false,
            summary: format!(
                "pin to {picked_label} saved but NOT live yet{}",
                get_str("warn")
                    .map(|w| format!(" — {w}"))
                    .unwrap_or_default()
            ),
        },
        Some(true) => PinOutcome {
            in_force: true,
            summary: format!("pinned to {picked_label} (soft — the gateway may fail over)"),
        },
        None => PinOutcome {
            in_force: true,
            summary: format!("pin to {picked_label} accepted"),
        },
    }
}

// ───────────────────────── picker state ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickerAxis {
    /// Switch Agent Chat between EXISTING conversations. Deliberately not a
    /// launcher: new SU sessions come from the real PSU picker, opened from
    /// the Sessions destination (`psu --role=su --tui=pui`,
    /// pui-psu-exact-launch-and-task-latency-2026-09-01 D-001/D-003).
    Conversation,
    Backend,
    Model,
    Effort,
    Account,
    Mode,
    /// D-026 (P-027 G-6): the approvals mode of the RUNNING conversation.
    Approvals,
}

/// D-026: the three engine-neutral approvals modes, in Shift+Tab order, with
/// the one-line description each row and toast shows. There is deliberately no
/// full-access mode (D-026 "Ruled out").
pub const APPROVALS_MODES: [(&str, &str); 3] = [
    ("ask", "ask before edits and commands"),
    ("auto-edit", "make edits without asking, ask before other commands"),
    ("read-only", "look and plan, change nothing"),
];

/// The /approvals picker rows. `current` is the mode the engine reports now
/// and `pending` the one already picked for the next message; both are marked
/// so the owner can see what a pick would change.
pub fn approvals_options(current: Option<&str>, pending: Option<&str>) -> Vec<PickerOption> {
    APPROVALS_MODES
        .iter()
        .map(|(mode, about)| {
            let mark = if pending == Some(*mode) {
                " (next message)"
            } else if current == Some(*mode) {
                " (current)"
            } else {
                ""
            };
            PickerOption {
                id: mode.to_string(),
                label: format!("{mode}{mark}"),
                hint: Some(about.to_string()),
                disabled: false,
            }
        })
        .collect()
}

/// The open picker overlay. Pure state — navigation and the disabled-row rule
/// live here rather than in the key handler, so both are unit-testable.
#[derive(Debug, Clone)]
pub struct SessionPicker {
    pub axis: PickerAxis,
    pub options: Vec<PickerOption>,
    pub sel: usize,
}

impl SessionPicker {
    pub fn new(axis: PickerAxis, options: Vec<PickerOption>) -> Self {
        Self {
            axis,
            options,
            sel: 0,
        }
    }

    pub fn title(&self) -> &'static str {
        match self.axis {
            PickerAxis::Conversation => " Conversation — Enter select · Esc close ",
            PickerAxis::Backend => " Backend — Enter select · Esc close ",
            PickerAxis::Model => " Model — Enter select · Esc close ",
            PickerAxis::Effort => " Effort — Enter select · Esc close ",
            PickerAxis::Account => " Account route — Enter select · Esc close ",
            PickerAxis::Mode => " Launch mode — Enter select · Esc close ",
            PickerAxis::Approvals => " Approvals — Enter select · Esc close ",
        }
    }

    /// Move the selection, clamped. An empty menu stays at 0.
    pub fn move_sel(&mut self, delta: isize) {
        if self.options.is_empty() {
            self.sel = 0;
            return;
        }
        let last = self.options.len() - 1;
        let next = (self.sel as isize + delta).clamp(0, last as isize);
        self.sel = next as usize;
    }

    pub fn selected(&self) -> Option<&PickerOption> {
        self.options.get(self.sel)
    }

    /// The row Enter would apply — or why it cannot. A disabled row NEVER
    /// applies, and always answers with its reason rather than silently
    /// doing nothing.
    pub fn commit(&self) -> Result<&PickerOption, String> {
        let Some(opt) = self.selected() else {
            return Err("nothing to select".to_string());
        };
        if opt.disabled {
            return Err(opt
                .hint
                .clone()
                .unwrap_or_else(|| format!("{} is not settable here", opt.label)));
        }
        Ok(opt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: &str) -> AccountRow {
        AccountRow {
            id: id.to_string(),
            ..Default::default()
        }
    }

    // ---- model ----

    #[test]
    fn model_menu_leads_with_inherit_and_names_the_surface_default() {
        let opts = model_options(&[], Some("sonnet[1m]"));
        assert_eq!(opts.len(), 1);
        assert_eq!(opts[0].id, MODEL_INHERIT);
        assert_eq!(opts[0].label, "Default (sonnet[1m])");
    }

    #[test]
    fn model_menu_does_not_invent_a_default_it_was_not_told() {
        let opts = model_options(&[], None);
        assert_eq!(opts[0].label, "Default (server picks)");
    }

    #[test]
    fn model_menu_is_exactly_the_server_tiers_and_empty_stays_empty() {
        // The guard against hardcoding a fallback menu: no tiers ⇒ only inherit.
        assert_eq!(model_options(&[], None).len(), 1);
        let tiers = vec![
            ModelTier {
                name: "quick".into(),
                spec: "haiku".into(),
                when: Some("trivial work".into()),
                backend: None,
                loop_capability: Some(LoopModelCapability {
                    executable: true,
                    provider: Some("gateway-anthropic".into()),
                    reason: None,
                }),
            },
            ModelTier {
                name: "deep".into(),
                spec: "opus[1m]:high".into(),
                when: None,
                backend: Some("codex".into()),
                loop_capability: None,
            },
        ];
        let opts = model_options(&tiers, None);
        assert_eq!(opts.len(), 3);
        assert_eq!(opts[1].id, "haiku");
        assert_eq!(opts[1].label, "quick — haiku");
        assert_eq!(opts[1].hint.as_deref(), Some("trivial work"));
        assert_eq!(opts[2].hint.as_deref(), Some("runs on codex"));
    }

    #[test]
    fn model_menu_keeps_omp_only_rows_visible_but_disabled_with_the_server_reason() {
        let tiers = vec![
            ModelTier {
                name: "omp-only".into(),
                spec: "openrouter/stealth/ox-alpha:max".into(),
                when: Some("special OMP models".into()),
                backend: Some("omp".into()),
                loop_capability: Some(LoopModelCapability {
                    executable: false,
                    provider: None,
                    reason: Some("unsupported loop provider \"openrouter\"".into()),
                }),
            },
            ModelTier {
                name: "owned".into(),
                spec: "sonnet[1m]".into(),
                when: None,
                backend: None,
                loop_capability: Some(LoopModelCapability {
                    executable: true,
                    provider: Some("gateway-anthropic".into()),
                    reason: None,
                }),
            },
        ];
        let opts = model_options(&tiers, None);
        assert_eq!(
            opts.len(),
            3,
            "unsupported rows remain visible for explanation"
        );
        assert!(opts[1].disabled);
        assert!(opts[1]
            .hint
            .as_deref()
            .unwrap()
            .contains("unsupported loop provider \"openrouter\""));
        assert!(opts[1]
            .hint
            .as_deref()
            .unwrap()
            .contains("special OMP models"));
        assert!(!opts[2].disabled);
    }

    #[test]
    fn model_menu_tolerates_legacy_tiers_without_capability_metadata() {
        let tiers = vec![ModelTier {
            name: "legacy".into(),
            spec: "sonnet".into(),
            when: None,
            backend: None,
            loop_capability: None,
        }];
        let opts = model_options(&tiers, None);
        assert!(
            !opts[1].disabled,
            "old operators did not send capability metadata"
        );
    }

    #[test]
    fn model_pick_maps_inherit_to_omitting_the_field() {
        assert_eq!(model_pick(MODEL_INHERIT), None);
        assert_eq!(model_pick(""), None);
        assert_eq!(model_pick("opus:high"), Some("opus:high".to_string()));
    }

    #[test]
    fn effort_and_mode_menus_only_project_server_vocabularies() {
        assert_eq!(
            effort_options(&[]).len(),
            1,
            "inherit only until config loads"
        );
        let efforts = vec!["low".to_string(), "xhigh".to_string()];
        let effort_rows = effort_options(&efforts);
        assert_eq!(
            effort_rows
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec![EFFORT_INHERIT, "low", "xhigh"]
        );

        assert_eq!(mode_options(&[]).len(), 1, "manual only until config loads");
        let modes = vec![LaunchableMode {
            id: "auto".into(),
            title: "AUTO".into(),
            one_liner: "Act without confirmation stops.".into(),
        }];
        let mode_rows = mode_options(&modes);
        assert_eq!(mode_rows[1].id, "auto");
        assert_eq!(mode_rows[1].label, "AUTO");
        assert_eq!(
            mode_rows[1].hint.as_deref(),
            Some("Act without confirmation stops.")
        );
        assert_eq!(mode_pick(MODE_INHERIT), None);
        assert_eq!(mode_pick("auto"), Some("auto".to_string()));
    }

    // ---- capacity tri-state ----

    #[test]
    fn unavailable_is_only_measured_when_the_reading_is_fresh() {
        let mut r = row("a");
        r.available = Some(false);
        r.reading_status = Some("stale".into());
        assert_eq!(r.capacity(), Capacity::Unknown);
        r.reading_status = Some("never-observed".into());
        assert_eq!(r.capacity(), Capacity::Unknown);
        r.reading_status = Some("fresh".into());
        assert_eq!(r.capacity(), Capacity::RatePaused);
    }

    #[test]
    fn a_failed_probe_makes_even_a_fresh_row_unknown() {
        let mut r = row("a");
        r.available = Some(false);
        r.reading_status = Some("fresh".into());
        r.last_probe_failed_at = Some(1_700_000_000_000);
        assert_eq!(r.capacity(), Capacity::Unknown);
    }

    #[test]
    fn absent_reading_status_is_unknown_not_fresh() {
        let mut r = row("a");
        r.available = Some(true);
        assert_eq!(r.capacity(), Capacity::Unknown);
    }

    #[test]
    fn usage_walled_is_distinguished_from_a_rate_pause() {
        let mut r = row("a");
        r.available = Some(false);
        r.reading_status = Some("fresh".into());
        r.usage_walled = Some(true);
        assert_eq!(r.capacity(), Capacity::UsageWalled);
    }

    // ---- account menu ----

    #[test]
    fn menu_leads_with_auto_then_an_always_disabled_default_row() {
        let opts = account_options(&[], None);
        assert_eq!(opts[0].id, ACCOUNT_AUTO);
        assert!(!opts[0].disabled);
        assert_eq!(opts[1].id, ACCOUNT_DEFAULT);
        assert!(opts[1].disabled, "default system account is never settable");
        assert!(
            opts[1].hint.as_deref().unwrap().contains("RESPAWNED"),
            "a disabled row must carry its reason"
        );
    }

    #[test]
    fn fresh_launch_menu_enables_the_default_system_account() {
        let opts = chat_account_options(&[]);
        assert_eq!(opts[1].id, ACCOUNT_DEFAULT);
        assert!(
            !opts[1].disabled,
            "fresh launch can choose gateway-free default"
        );
        assert!(opts[1]
            .hint
            .as_deref()
            .unwrap()
            .contains("gateway is skipped"));
        assert_eq!(
            chat_account_pick(ACCOUNT_DEFAULT),
            Some("default".to_string())
        );
        assert_eq!(chat_account_pick(ACCOUNT_AUTO), Some("auto".to_string()));
        assert_eq!(chat_account_pick("acct-7"), Some("acct-7".to_string()));
    }

    #[test]
    fn an_unavailable_account_is_listed_not_hidden() {
        let mut r = row("acct-1");
        r.available = Some(false);
        r.reading_status = Some("fresh".into());
        r.provider = Some("anthropic".into());
        let opts = account_options(&[r], None);
        let row = opts.iter().find(|o| o.id == "acct-1").expect("listed");
        assert!(!row.disabled, "capacity never disables a row");
        assert_eq!(
            row.hint.as_deref(),
            Some("anthropic · rate-limited right now")
        );
    }

    #[test]
    fn a_stale_row_says_unknown_rather_than_claiming_it_is_limited() {
        let mut r = row("acct-1");
        r.available = Some(false);
        r.reading_status = Some("stale".into());
        let opts = account_options(&[r], None);
        let hint = opts
            .iter()
            .find(|o| o.id == "acct-1")
            .unwrap()
            .hint
            .clone()
            .unwrap();
        assert!(hint.contains("capacity unknown"), "got {hint}");
        assert!(!hint.contains("rate-limited"));
    }

    #[test]
    fn a_gateway_free_session_disables_every_row_with_the_reason() {
        let opts = account_options(&[row("acct-1")], Some("default"));
        assert!(
            opts.iter().all(|o| o.disabled),
            "nothing routed through the gateway can re-route a --account=default session"
        );
        assert!(opts[0].hint.as_deref().unwrap().contains("Respawn"));
        assert_eq!(opts.len(), 3, "rows stay VISIBLE rather than being dropped");
    }

    #[test]
    fn unknown_launch_argv_does_not_disable_the_menu() {
        // Disabling on an absence is the same unsourced guess in the other direction.
        let opts = account_options(&[row("acct-1")], None);
        assert!(!opts[0].disabled);
        assert!(!opts.iter().find(|o| o.id == "acct-1").unwrap().disabled);
    }

    #[test]
    fn accounts_sort_by_display_label() {
        let mut b = row("zzz");
        b.label = Some("alpha".into());
        let a = row("mmm");
        let opts = account_options(&[a, b], None);
        let ids: Vec<&str> = opts[2..].iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, vec!["zzz", "mmm"], "sorted by label, not id");
    }

    // ---- pick routing ----

    #[test]
    fn the_three_values_route_to_three_different_operations() {
        assert_eq!(account_pick(ACCOUNT_AUTO, None), AccountPick::Unpin);
        assert_eq!(
            account_pick("acct-1", None),
            AccountPick::Pin {
                account: "acct-1".to_string()
            }
        );
        assert!(matches!(
            account_pick(ACCOUNT_DEFAULT, None),
            AccountPick::NotSettable { .. }
        ));
    }

    #[test]
    fn every_pick_is_unsettable_on_a_gateway_free_session() {
        for id in [ACCOUNT_AUTO, ACCOUNT_DEFAULT, "acct-1"] {
            assert!(
                matches!(
                    account_pick(id, Some("default")),
                    AccountPick::NotSettable { .. }
                ),
                "{id} must not issue a call that cannot reach the session"
            );
        }
    }

    #[test]
    fn account_status_wire_preserves_burn_and_provider_rollup_units() {
        let row: AccountRow = serde_json::from_value(json!({
            "id": "acct-1",
            "burn": {
                "action": "throttle",
                "disposition": "pacing-projection",
                "projectedExhaustionAt": 1_900_000_000_000_i64
            }
        }))
        .unwrap();
        let burn = row.burn.expect("burn projection");
        assert_eq!(burn.disposition, "pacing-projection");
        assert_eq!(burn.projected_exhaustion_at, Some(1_900_000_000_000));

        let verdict: ProviderPoolVerdict = serde_json::from_value(json!({
            "provider": "codex",
            "total": 4,
            "serviceable": 2,
            "walledFresh": 1,
            "paused": 1,
            "pacing": 1,
            "unknown": 1,
            "atCapacity": false,
            "binding": "none"
        }))
        .unwrap();
        assert_eq!(verdict.total, 4);
        assert_eq!(verdict.serviceable, 2);
        assert_eq!(verdict.walled_fresh, 1);
        assert_eq!(verdict.pacing, 1);
        assert_eq!(verdict.unknown, 1);
    }

    // ---- outcome reporting ----

    #[test]
    fn a_durable_but_not_live_pin_is_reported_as_not_in_force() {
        let out = describe_pin_outcome(
            &json!({ "ok": true, "appliedLive": false, "warn": "session not reachable" }),
            "acct-1",
        );
        assert!(!out.in_force, "appliedLive:false is not in force");
        assert!(out.summary.contains("NOT live"), "got {}", out.summary);
        assert!(out.summary.contains("session not reachable"));
    }

    #[test]
    fn a_live_pin_still_never_claims_the_session_is_on_the_account() {
        let out = describe_pin_outcome(&json!({ "ok": true, "appliedLive": true }), "acct-1");
        assert!(out.in_force);
        assert!(
            out.summary.contains("soft"),
            "a soft pin may fail over; got {}",
            out.summary
        );
    }

    #[test]
    fn an_unpin_reports_cleared() {
        let out = describe_pin_outcome(&json!({ "ok": true, "cleared": true }), "Auto");
        assert!(out.in_force);
        assert!(out.summary.contains("cleared"));
    }

    // ---- picker state ----

    #[test]
    fn navigation_clamps_at_both_ends_and_tolerates_an_empty_menu() {
        let mut p = SessionPicker::new(PickerAxis::Account, account_options(&[], None));
        p.move_sel(-1);
        assert_eq!(p.sel, 0);
        p.move_sel(99);
        assert_eq!(p.sel, p.options.len() - 1);

        let mut empty = SessionPicker::new(PickerAxis::Model, vec![]);
        empty.move_sel(1);
        assert_eq!(empty.sel, 0);
        assert!(empty.commit().is_err(), "an empty menu applies nothing");
    }

    #[test]
    fn enter_on_a_disabled_row_refuses_with_its_reason() {
        let mut p = SessionPicker::new(PickerAxis::Account, account_options(&[], None));
        // Row 1 is the always-disabled "Default system account".
        p.sel = 1;
        let err = p.commit().expect_err("must not apply");
        assert!(err.contains("RESPAWNED"), "got {err}");
    }

    #[test]
    fn enter_on_an_enabled_row_yields_the_id_to_apply() {
        let p = SessionPicker::new(PickerAxis::Account, account_options(&[], None));
        assert_eq!(p.commit().expect("auto is settable").id, ACCOUNT_AUTO);
    }

    #[test]
    fn a_failed_setter_is_reported_as_failed_not_applied() {
        let out = describe_pin_outcome(
            &json!({ "ok": false, "error": "no such account" }),
            "acct-9",
        );
        assert!(!out.in_force);
        assert!(out.summary.contains("FAILED"));
        assert!(out.summary.contains("no such account"));
    }
}
