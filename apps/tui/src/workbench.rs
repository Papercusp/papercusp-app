//! Workbench persistence glue (P12 / D-002): the per-user owner key + the pure
//! command/spec builders for SAVING the current zellij layout and RESTORING a
//! saved crew into panes. The backend CRUD is in `client.rs` (the `/api/tui/*`
//! routes); this module is the local, zellij-facing half.
//!
//! The live spawn (running `zellij action dump-layout`, `zellij --layout`, and
//! `psu --resume`) is wired into the command palette in a supervised follow-on
//! (it needs a real zellij session, which the shared-box no-keystroke rule keeps
//! out of automated tests). These builders are pure + unit-tested so that wiring
//! stays mechanical.
#![allow(dead_code)]

use crate::models::{CrewMember, CrewRow, RosterEntry};
use crate::mux::PaneSpec;

/// A stable per-user owner key for workbench rows. Prefers an explicit override
/// (`PAPERCUSP_TUI_OWNER`), then `$USER@$HOSTNAME`, then a constant — never empty
/// (the `/api/tui/*` routes reject a blank owner).
pub fn workbench_owner() -> String {
    if let Ok(o) = std::env::var("PAPERCUSP_TUI_OWNER") {
        let o = o.trim();
        if !o.is_empty() {
            return o.to_string();
        }
    }
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    let user = user.trim();
    if user.is_empty() {
        return "pui-local".to_string();
    }
    let host = std::env::var("HOSTNAME").unwrap_or_default();
    let host = host.trim();
    if host.is_empty() {
        user.to_string()
    } else {
        format!("{user}@{host}")
    }
}

/// argv that captures the current zellij layout to stdout (for SAVE — the caller
/// stores the captured KDL via `client.save_layout`).
pub fn dump_layout_argv() -> Vec<String> {
    ["zellij", "action", "dump-layout"]
        .into_iter()
        .map(String::from)
        .collect()
}

/// argv that starts a session from a saved layout file (for RESTORE).
pub fn restore_layout_argv(kdl_path: &str) -> Vec<String> {
    vec![
        "zellij".to_string(),
        "--layout".to_string(),
        kdl_path.to_string(),
    ]
}

/// Build the `psu` pane specs that relaunch a saved crew's agents (RESTORE).
/// A member with a `resume_id` resumes that session; otherwise a fresh agent is
/// launched. Harness/plan/cwd are threaded through when present.
pub fn crew_pane_specs(crew: &CrewRow) -> Vec<PaneSpec> {
    crew.members.iter().map(member_pane_spec).collect()
}

/// The liveness partition of a crew RESTORE (P-031 — crews are the multi-
/// session switch, not a blind pane spawner): each saved member is routed by
/// what its session is doing RIGHT NOW instead of unconditionally spawning a
/// pane per row. `fresh` members spawn as before; `live` members get focused;
/// `parked` members get a `coord:wake`; `ended` members surface a prompt in
/// the reducer rather than silently returning a smaller workspace (D-009).
#[derive(Debug, Clone, Default)]
pub struct CrewRestorePartition {
    /// No (parseable) resume handle → spawn the pane spec unchanged.
    pub fresh: Vec<PaneSpec>,
    /// Session is LIVE → focus it, never respawn (double-spawn guard, D-001).
    pub live: Vec<RosterEntry>,
    /// Session parked/draining/suspect → wake it via `coord:wake`.
    pub parked: Vec<RosterEntry>,
    /// Session ended/recorded, or absent from the active roster → ask before
    /// resuming (the reducer's crew-restore prompt).
    pub ended: Vec<CrewMember>,
}

/// Partition a crew's members against the ACTIVE roster (P-031). Match key:
/// the saved `resume_id` (an adv_sessions row id) parsed as i64 against
/// `RosterEntry.adv_session_id`. The session-state oracle verdict picks the
/// bucket; an entry without a verdict falls back to the legacy `is_live()`
/// heartbeat read (present-but-not-live ⇒ parked — a wake is safe, a silent
/// drop is not), and a member whose session is missing from the active roster
/// entirely is ENDED.
pub fn partition_crew(members: &[CrewMember], roster: &[RosterEntry]) -> CrewRestorePartition {
    let mut part = CrewRestorePartition::default();
    for m in members {
        let resume_id: Option<i64> = m.resume_id.as_deref().and_then(|r| r.trim().parse().ok());
        let Some(rid) = resume_id else {
            // No numeric resume handle — unchanged spawn path (a non-numeric
            // resume_id still rides in the spec's `--resume` argv).
            part.fresh.push(member_pane_spec(m));
            continue;
        };
        let Some(entry) = roster.iter().find(|r| r.adv_session_id == Some(rid)) else {
            part.ended.push(m.clone());
            continue;
        };
        match entry.session_state.as_deref() {
            Some("live") => part.live.push(entry.clone()),
            Some("parked") | Some("draining") | Some("suspect") => part.parked.push(entry.clone()),
            Some("ended") | Some("recorded") => part.ended.push(m.clone()),
            _ => {
                if entry.is_live() {
                    part.live.push(entry.clone());
                } else {
                    part.parked.push(entry.clone());
                }
            }
        }
    }
    part
}

/// Derive a `CrewMember` from a launched `PaneSpec`, if it's a `psu` agent
/// session (the thing a crew restores). Non-agent panes (git/plugin) → None.
/// The inverse of `member_pane_spec`; handles both `--resume X` and `--k=v`.
pub fn crew_member_from_spec(spec: &PaneSpec) -> Option<CrewMember> {
    if spec.argv.first().map(String::as_str) != Some("psu") {
        return None;
    }
    let mut m = CrewMember::default();
    let mut i = 1;
    while i < spec.argv.len() {
        let a = &spec.argv[i];
        if let Some(v) = a.strip_prefix("--agent=") {
            m.agent = Some(v.to_string());
        } else if let Some(v) = a.strip_prefix("--harness=") {
            m.harness = Some(v.to_string());
        } else if let Some(v) = a.strip_prefix("--plan=") {
            m.plan = Some(v.to_string());
        } else if let Some(v) = a.strip_prefix("--resume=") {
            m.resume_id = Some(v.to_string());
        } else if a == "--resume" {
            if let Some(v) = spec.argv.get(i + 1) {
                m.resume_id = Some(v.clone());
                i += 1;
            }
        }
        i += 1;
    }
    m.cwd = spec.cwd.clone();
    Some(m)
}

/// Capture the current zellij layout as KDL (`zellij action dump-layout`). Only
/// works inside a zellij session — returns None otherwise. LIVE (a subprocess);
/// invoked only by the palette `:save-layout` command in a running pui.
pub fn capture_zellij_layout() -> Option<String> {
    let out = std::process::Command::new("zellij")
        .args(["action", "dump-layout"])
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        None
    }
}

pub fn member_pane_spec(m: &CrewMember) -> PaneSpec {
    let mut argv = vec!["psu".to_string()];
    match (&m.resume_id, &m.agent) {
        (Some(rid), _) => {
            argv.push("--resume".to_string());
            argv.push(rid.clone());
        }
        (None, Some(agent)) => argv.push(format!("--agent={agent}")),
        (None, None) => {}
    }
    if let Some(h) = &m.harness {
        argv.push(format!("--harness={h}"));
    }
    if let Some(p) = &m.plan {
        argv.push(format!("--plan={p}"));
    }
    let title = match (&m.agent, &m.harness) {
        (Some(a), Some(h)) => format!("{a} · {h}"),
        (Some(a), None) => a.clone(),
        _ => "session".to_string(),
    };
    let mut spec = PaneSpec::new(argv).titled(title);
    if let Some(cwd) = &m.cwd {
        spec = spec.cwd(cwd.clone());
    }
    spec
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_is_never_blank_or_spaced() {
        let o = workbench_owner();
        assert!(!o.is_empty());
        assert!(!o.contains(' '));
    }

    #[test]
    fn dump_and_restore_argv() {
        assert_eq!(dump_layout_argv(), vec!["zellij", "action", "dump-layout"]);
        assert_eq!(
            restore_layout_argv("/tmp/x.kdl"),
            vec!["zellij", "--layout", "/tmp/x.kdl"]
        );
    }

    #[test]
    fn crew_member_with_resume_id_resumes() {
        let crew = CrewRow {
            name: "c".into(),
            description: None,
            layout_name: None,
            members: vec![CrewMember {
                slot: Some(0),
                agent: Some("claude".into()),
                resume_id: Some("r1".into()),
                harness: Some("papercup".into()),
                plan: Some("plan-x".into()),
                cwd: Some("/repo".into()),
            }],
        };
        let specs = crew_pane_specs(&crew);
        assert_eq!(specs.len(), 1);
        let argv = &specs[0].argv;
        assert_eq!(argv[0], "psu");
        assert!(argv.iter().any(|a| a == "--resume"));
        assert!(argv.iter().any(|a| a == "r1"));
        assert!(argv.iter().any(|a| a == "--harness=papercup"));
        assert!(argv.iter().any(|a| a == "--plan=plan-x"));
        assert_eq!(specs[0].cwd.as_deref(), Some("/repo"));
    }

    #[test]
    fn crew_member_without_resume_launches_fresh() {
        let crew = CrewRow {
            name: "c".into(),
            description: None,
            layout_name: None,
            members: vec![CrewMember {
                agent: Some("codex".into()),
                ..Default::default()
            }],
        };
        let argv = &crew_pane_specs(&crew)[0].argv;
        assert!(argv.iter().any(|a| a == "--agent=codex"));
        assert!(!argv.iter().any(|a| a == "--resume"));
    }

    #[test]
    fn empty_crew_has_no_specs() {
        let crew = CrewRow {
            name: "e".into(),
            description: None,
            layout_name: None,
            members: vec![],
        };
        assert!(crew_pane_specs(&crew).is_empty());
    }

    #[test]
    fn crew_member_from_spec_parses_psu_launch() {
        let spec = PaneSpec::new(vec![
            "psu".to_string(),
            "--no-picker".to_string(),
            "--agent=claude".to_string(),
            "--harness=papercup".to_string(),
            "--plan=plan-x".to_string(),
        ])
        .cwd("/repo");
        let m = crew_member_from_spec(&spec).unwrap();
        assert_eq!(m.agent.as_deref(), Some("claude"));
        assert_eq!(m.harness.as_deref(), Some("papercup"));
        assert_eq!(m.plan.as_deref(), Some("plan-x"));
        assert_eq!(m.cwd.as_deref(), Some("/repo"));
        assert_eq!(m.resume_id, None);
    }

    #[test]
    fn crew_member_from_spec_resume_forms_and_rejects_nonpsu() {
        let s1 = PaneSpec::new(vec![
            "psu".to_string(),
            "--resume".to_string(),
            "r1".to_string(),
        ]);
        assert_eq!(
            crew_member_from_spec(&s1).unwrap().resume_id.as_deref(),
            Some("r1")
        );
        let s2 = PaneSpec::new(vec!["psu".to_string(), "--resume=r2".to_string()]);
        assert_eq!(
            crew_member_from_spec(&s2).unwrap().resume_id.as_deref(),
            Some("r2")
        );
        assert!(crew_member_from_spec(&PaneSpec::new(vec!["lazygit".to_string()])).is_none());
    }

    #[test]
    fn crew_member_round_trips_through_pane_spec() {
        // An agent-only (fresh) launch round-trips fully.
        let m = CrewMember {
            slot: Some(0),
            agent: Some("codex".into()),
            resume_id: None,
            harness: Some("h".into()),
            plan: Some("p".into()),
            cwd: Some("/c".into()),
        };
        let back = crew_member_from_spec(&member_pane_spec(&m)).unwrap();
        assert_eq!(back.agent, m.agent);
        assert_eq!(back.harness, m.harness);
        assert_eq!(back.plan, m.plan);
        assert_eq!(back.cwd, m.cwd);
        // A resume launch recovers the resume_id; agent is implied by the session
        // (intentionally not in argv), so it doesn't round-trip.
        let r = CrewMember {
            resume_id: Some("rid".into()),
            agent: Some("codex".into()),
            ..Default::default()
        };
        let rb = crew_member_from_spec(&member_pane_spec(&r)).unwrap();
        assert_eq!(rb.resume_id.as_deref(), Some("rid"));
    }

    #[test]
    fn partition_crew_routes_members_by_liveness() {
        let m = |rid: &str| CrewMember {
            resume_id: Some(rid.to_string()),
            ..Default::default()
        };
        let entry = |id: i64, state: &str| RosterEntry {
            owner_id: format!("su-{id}"),
            adv_session_id: Some(id),
            session_state: Some(state.to_string()),
            ..Default::default()
        };
        let fresh = CrewMember {
            agent: Some("claude".into()),
            ..Default::default()
        };
        let roster = vec![
            entry(11, "live"),
            entry(22, "parked"),
            entry(33, "recorded"),
        ];
        let members = vec![fresh, m("11"), m("22"), m("33"), m("44")];
        let p = partition_crew(&members, &roster);
        assert_eq!(p.fresh.len(), 1, "no-resume member spawns fresh");
        assert_eq!(
            p.fresh[0].argv,
            vec!["psu".to_string(), "--agent=claude".to_string()]
        );
        assert_eq!(p.live.len(), 1);
        assert_eq!(p.live[0].owner_id, "su-11");
        assert_eq!(p.parked.len(), 1);
        assert_eq!(p.parked[0].owner_id, "su-22");
        // ended: the recorded session AND the absent-from-roster one.
        assert_eq!(p.ended.len(), 2);
        assert_eq!(p.ended[0].resume_id.as_deref(), Some("33"));
        assert_eq!(p.ended[1].resume_id.as_deref(), Some("44"));
    }

    #[test]
    fn partition_crew_falls_back_to_legacy_liveness_without_oracle_verdict() {
        // No session_state verdict: a PRESENT entry routes live/parked by the
        // legacy heartbeat read — never ended (ended means gone/recorded).
        let m = CrewMember {
            resume_id: Some("5".to_string()),
            ..Default::default()
        };
        let unverdicted = RosterEntry {
            owner_id: "su-stale".into(),
            adv_session_id: Some(5),
            stale: true,
            ..Default::default()
        };
        let p = partition_crew(&[m], &[unverdicted]);
        assert!(p.ended.is_empty(), "present-but-unverdicted is never ended");
        assert!(p.fresh.is_empty());
        assert_eq!(p.live.len() + p.parked.len(), 1);
    }

    #[test]
    fn partition_crew_draining_and_suspect_are_parked() {
        let m = |rid: &str| CrewMember {
            resume_id: Some(rid.to_string()),
            ..Default::default()
        };
        let entry = |id: i64, state: &str| RosterEntry {
            owner_id: format!("su-{id}"),
            adv_session_id: Some(id),
            session_state: Some(state.to_string()),
            ..Default::default()
        };
        let p = partition_crew(
            &[m("1"), m("2")],
            &[entry(1, "draining"), entry(2, "suspect")],
        );
        assert_eq!(p.parked.len(), 2);
        assert!(p.live.is_empty() && p.ended.is_empty() && p.fresh.is_empty());
    }
}
