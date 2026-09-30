//! session_panes.rs — reactive zellij panes for new LOCAL workbench launches
//! (pui-reactive-session-panes-2026-06-05).
//!
//! The desktop's new-session action RECORDS a session (does not spawn — D-001);
//! the pui, which already reads the roster, reactively opens a work-area pane for
//! any new LOCAL "pending workbench launch" it has not already paned. This module
//! is the PURE diff/dedup core (mirrors `mux.rs`'s pure `new_pane_argv`): it takes
//! the roster's `pending` tier + the set already paned and returns the panes to
//! open this tick. The event-loop wiring (`app.rs` roster handler) performs the
//! I/O — open each `MuxAction::NewPane`, mark the launch consumed, record the id.
//!
//! Why the `pending` tier (not `active`): the roster is presence-primary, so a
//! recorded-but-not-running session has no presence row. The backend synthesizes
//! pending launches into a separate `pending` array (`display == "workbench"`,
//! `liveness == "pending"`, local host). The pui panes ONLY those — a live
//! autonomous fleet agent (in `active`, `display == None`) is never paned (D-002),
//! and a live session is never paned on restart (it is never in `pending`), so a
//! pui restart cannot double-pane (P-010 is satisfied structurally).

use std::collections::HashSet;

use crate::models::RosterEntry;
use crate::mux::PaneSpec;

/// The set of `adv_session` ids the pui has already opened a pane for THIS run —
/// the dedup source of truth (D-003: keyed on the STABLE advSessionId, never pid).
/// Belt-and-suspenders against the open-pane→mark-launched race: the backend also
/// drops a consumed launch from the `pending` tier, but a roster refresh that
/// arrives before the mark lands must not re-pane it.
pub type TrackedPanes = HashSet<i64>;

/// One reactive pane to open: the session it belongs to + the command spec. The
/// caller opens `spec` via the multiplexer and marks `adv_session_id` launched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionPane {
    pub adv_session_id: i64,
    pub spec: PaneSpec,
}

/// Resolve THIS machine's hostname the way the backend stamps a pending launch's
/// `host` (Node `os.hostname()` = `gethostname(2)`), so the local-host predicate
/// matches on a single box (P-009). Resolved once at startup and cached on `App`.
/// Order: the `hostname` command (same syscall as `os.hostname()`), then
/// `$HOSTNAME`, then `/etc/hostname`; "" when none resolve (treated as local by
/// `is_local`, so a resolution miss never *suppresses* a local launch).
pub fn local_host() -> String {
    if let Ok(out) = std::process::Command::new("hostname").output() {
        if out.status.success() {
            let h = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !h.is_empty() {
                return h;
            }
        }
    }
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.trim().is_empty() {
            return h.trim().to_string();
        }
    }
    std::fs::read_to_string("/etc/hostname")
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Is this pending entry LOCAL to the pui's host? An empty host = unspecified =
/// treated as local (single-box dev: a pending launch is recorded by the local
/// backend). Kept explicit so a multi-host future is a one-line change (P-009).
fn is_local(entry: &RosterEntry, local_host: &str) -> bool {
    entry.host.is_empty() || entry.host == local_host
}

/// Is this entry a DISPLAYABLE workbench launch (D-002) — an interactive session
/// meant to be driven in a pane, never an autonomous background fleet agent? The
/// explicit `display == "workbench"` hint is the discriminator (set by the
/// desktop new-session; autonomous `fleet:spawn` launches leave it unset).
fn is_displayable(entry: &RosterEntry) -> bool {
    entry.display.as_deref() == Some("workbench")
}

/// Build the pane title for a session (P-005): the strongest context label
/// (feature → plan → role) alongside the agent.
fn pane_title(entry: &RosterEntry) -> String {
    let agent = entry.agent.clone().unwrap_or_else(|| "session".to_string());
    let ctx = entry
        .feature
        .clone()
        .or_else(|| entry.current_plan_slug.clone())
        .or_else(|| entry.role.clone())
        .filter(|c| !c.is_empty());
    match ctx {
        Some(c) => format!("{agent} · {c}"),
        None => agent,
    }
}

/// Build the `PaneSpec` that RUNS a pending launch (P-005): the recorded
/// `launch_argv` (a fresh `psu …`, the single launcher per D-001), titled by
/// role/plan + agent, run in the session's `cwd` when known. `None` when the
/// entry carries no runnable argv (nothing to launch).
pub fn pane_spec_for(entry: &RosterEntry) -> Option<PaneSpec> {
    if entry.launch_argv.is_empty() {
        return None;
    }
    let mut spec = PaneSpec::new(entry.launch_argv.clone()).titled(pane_title(entry));
    if let Some(cwd) = entry.cwd.clone().filter(|c| !c.is_empty()) {
        spec = spec.cwd(cwd);
    }
    Some(spec)
}

/// The work-area panes to open for this roster tick (P-004). `pending` is the
/// roster's `pending` tier (recorded-but-not-running workbench launches). An entry
/// becomes a pane when it is (a) NOT already tracked, (b) LOCAL, (c) DISPLAYABLE
/// (workbench, per D-002), and (d) carries a stable `adv_session_id` + a runnable
/// argv. PURE — the caller performs the I/O and records the returned ids into
/// `tracked`. Dedups within the call too, so a duplicated row never double-opens.
pub fn panes_to_open(
    tracked: &TrackedPanes,
    pending: &[RosterEntry],
    local_host: &str,
) -> Vec<SessionPane> {
    let mut seen: HashSet<i64> = tracked.clone();
    let mut out = Vec::new();
    for entry in pending {
        let Some(id) = entry.adv_session_id else {
            continue;
        };
        if seen.contains(&id) {
            continue; // dedup on the stable advSessionId (D-003)
        }
        if !is_local(entry, local_host) || !is_displayable(entry) {
            continue;
        }
        let Some(spec) = pane_spec_for(entry) else {
            continue;
        };
        seen.insert(id);
        out.push(SessionPane {
            adv_session_id: id,
            spec,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pending workbench launch as it arrives in the roster's `pending` tier.
    fn pending_entry(id: i64, agent: &str) -> RosterEntry {
        RosterEntry {
            owner_id: format!("pending:adv:{id}"),
            host: "box-1".into(),
            liveness: "pending".into(),
            agent: Some(agent.into()),
            adv_session_id: Some(id),
            has_launch_record: true,
            display: Some("workbench".into()),
            launch_argv: vec![
                "psu".into(),
                "--no-picker".into(),
                format!("--agent={agent}"),
            ],
            ..Default::default()
        }
    }

    #[test]
    fn new_local_interactive_session_opens_one_pane() {
        let tracked = TrackedPanes::new();
        let pending = vec![pending_entry(7, "claude")];
        let out = panes_to_open(&tracked, &pending, "box-1");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].adv_session_id, 7);
        // The pane RUNS the recorded launch argv verbatim (the single launcher).
        assert_eq!(
            out[0].spec.argv,
            vec!["psu", "--no-picker", "--agent=claude"]
        );
        assert_eq!(out[0].spec.title.as_deref(), Some("claude"));
    }

    #[test]
    fn already_tracked_session_is_not_reopened() {
        let mut tracked = TrackedPanes::new();
        tracked.insert(7);
        let pending = vec![pending_entry(7, "claude")];
        assert!(panes_to_open(&tracked, &pending, "box-1").is_empty());
    }

    #[test]
    fn remote_session_is_not_paned() {
        let tracked = TrackedPanes::new();
        let mut e = pending_entry(7, "claude");
        e.host = "other-box".into();
        assert!(panes_to_open(&tracked, &[e], "box-1").is_empty());
    }

    #[test]
    fn empty_host_is_treated_as_local() {
        let tracked = TrackedPanes::new();
        let mut e = pending_entry(7, "claude");
        e.host = String::new();
        assert_eq!(panes_to_open(&tracked, &[e], "box-1").len(), 1);
    }

    #[test]
    fn non_workbench_entry_is_not_paned() {
        // An autonomous background agent (or any non-workbench row) → no pane (D-002).
        let tracked = TrackedPanes::new();
        let mut e = pending_entry(7, "worker");
        e.display = None;
        assert!(panes_to_open(&tracked, &[e], "box-1").is_empty());
    }

    #[test]
    fn entry_without_adv_session_id_is_skipped() {
        let tracked = TrackedPanes::new();
        let mut e = pending_entry(7, "claude");
        e.adv_session_id = None;
        assert!(panes_to_open(&tracked, &[e], "box-1").is_empty());
    }

    #[test]
    fn entry_without_launch_argv_is_skipped() {
        // A recorded row with nothing runnable → no pane (can't launch it).
        let tracked = TrackedPanes::new();
        let mut e = pending_entry(7, "claude");
        e.launch_argv.clear();
        assert!(panes_to_open(&tracked, &[e], "box-1").is_empty());
    }

    #[test]
    fn cwd_is_carried_onto_the_pane_when_set() {
        let tracked = TrackedPanes::new();
        let mut e = pending_entry(7, "claude");
        e.cwd = Some("/repo/papercup".into());
        let out = panes_to_open(&tracked, &[e], "box-1");
        assert_eq!(out[0].spec.cwd.as_deref(), Some("/repo/papercup"));
    }

    #[test]
    fn title_prefers_feature_then_plan_then_role() {
        let tracked = TrackedPanes::new();
        let mut e = pending_entry(7, "codex");
        e.current_plan_slug = Some("my-plan".into());
        let out = panes_to_open(&tracked, &[e], "box-1");
        assert_eq!(out[0].spec.title.as_deref(), Some("codex · my-plan"));
    }

    #[test]
    fn multiple_pending_open_multiple_deduped_against_tracked() {
        let mut tracked = TrackedPanes::new();
        tracked.insert(1); // already paned
        let pending = vec![
            pending_entry(1, "claude"),
            pending_entry(2, "codex"),
            pending_entry(3, "omp"),
        ];
        let out = panes_to_open(&tracked, &pending, "box-1");
        let ids: Vec<i64> = out.iter().map(|p| p.adv_session_id).collect();
        assert_eq!(ids, vec![2, 3]);
    }

    #[test]
    fn duplicate_pending_row_opens_only_once() {
        let tracked = TrackedPanes::new();
        let pending = vec![pending_entry(5, "claude"), pending_entry(5, "claude")];
        assert_eq!(panes_to_open(&tracked, &pending, "box-1").len(), 1);
    }

    #[test]
    fn decodes_live_3170_roster_pending_tier_and_opens_a_pane() {
        // The EXACT `/api/adv/roster` wire shape captured live from the staging
        // operator (:3170, running this branch) after a defer_spawn record — guards
        // the TS↔Rust serde contract for the new `pending`/`display`/`launchArgv`
        // fields (the #1 integration risk a live e2e catches: a camelCase mismatch).
        let json = r#"{
          "active": [],
          "ended": [],
          "orphanedClaims": [],
          "pending": [{
            "ownerId": "pending:adv:608",
            "label": "claude · pui-reactive-session-panes-2026-06-05",
            "source": "claude",
            "intent": "pending workbench launch",
            "currentFiles": [],
            "host": "dev-box-linux",
            "pid": null,
            "startedAt": "2026-06-06T04:16:25.864Z",
            "heartbeatAt": "2026-06-06T04:16:25.864Z",
            "liveness": "pending",
            "stale": false,
            "workspaceId": "papercusp-workspace",
            "userId": null,
            "revoked": false,
            "pidAlive": null,
            "claims": [],
            "hasLaunchRecord": true,
            "advSessionId": 608,
            "currentPlanSlug": "pui-reactive-session-panes-2026-06-05",
            "role": null,
            "feature": null,
            "agent": "claude",
            "mode": "console",
            "windowId": null,
            "ompThreadId": null,
            "cwd": null,
            "launchStartedAt": "2026-06-06T04:16:25.864Z",
            "display": "workbench",
            "launchArgv": [
              "/home/dev/.local/bin/psu",
              "--no-picker",
              "--agent=claude",
              "--plan=pui-reactive-session-panes-2026-06-05"
            ]
          }]
        }"#;
        let resp: crate::models::RosterResponse =
            serde_json::from_str(json).expect("decode live /adv/roster");
        assert!(resp.active.is_empty());
        assert_eq!(resp.pending.len(), 1);
        let e = &resp.pending[0];
        assert_eq!(e.display.as_deref(), Some("workbench"));
        assert_eq!(e.adv_session_id, Some(608));
        assert!(e.has_launch_record);
        assert_eq!(e.liveness, "pending");
        assert_eq!(e.launch_argv.len(), 4);

        // The pure diff produces exactly the pane that RUNS this launch.
        let out = panes_to_open(&TrackedPanes::new(), &resp.pending, "dev-box-linux");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].adv_session_id, 608);
        assert_eq!(out[0].spec.argv, e.launch_argv);
        assert_eq!(
            out[0].spec.title.as_deref(),
            Some("claude · pui-reactive-session-panes-2026-06-05"),
        );
    }

    #[test]
    fn live_active_sessions_are_never_paned() {
        // pui-restart reconciliation (P-010): a live session has display=None and
        // lives in `active`, never the `pending` tier. Even if such a row were
        // passed here, it is not paned → a restart (empty tracked) cannot double-
        // pane a running session.
        let tracked = TrackedPanes::new();
        let mut live = pending_entry(9, "claude");
        live.display = None; // a normal live/active row
        live.liveness = "live".into();
        assert!(panes_to_open(&tracked, &[live], "box-1").is_empty());
    }
}
