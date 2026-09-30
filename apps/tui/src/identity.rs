//! Canonical PUI ↔ operator/store rendezvous and stable-session stamps.
//!
//! A stable zellij name is safe only when attach means "resume the same data
//! plane". Each create stamps the selected endpoint + server workspace/store
//! identity; each attach compares before zellij is invoked and refuses drift.
//!
//! The stamp ALSO records WHO launched the session (pui-tui-next-wave P-004,
//! EI-22440755576757822): the launcher pid, the host boot id, and the agent
//! identity env (`PAPERCUSP_SID` / `PAPERCUSP_AGENT`) when present. A live
//! survivor whose launcher is gone is an ORPHAN — attaching to it would hand
//! the new user every pane spawned from the dead launcher's environment (a
//! codex agent's `pui-wb` was attached to by the owner's launch on
//! 2026-09-05) — so `bind` reports `Binding::Orphaned` and the caller reaps and
//! re-creates instead. A legacy schema-1 stamp (no launcher block) keeps the
//! attach behaviour so an in-flight upgrade never kills a live owner session.

use crate::client::BackendIdentity;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Stamp schema: 1 = identity only; 2 = identity + launcher block.
pub const STAMP_SCHEMA_VERSION: u32 = 2;

/// Who created a stable session — enough to decide, later, whether that
/// process is still around to own it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Launcher {
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub created_at_epoch: u64,
}

impl Launcher {
    /// Short human label: `pid 123 (sid su-abc…, agent codex)`.
    pub fn label(&self) -> String {
        let mut s = format!("pid {}", self.pid);
        if let Some(sid) = &self.sid {
            let short: String = sid.chars().take(11).collect();
            s.push_str(&format!(", sid {short}…"));
        }
        if let Some(agent) = &self.agent {
            s.push_str(&format!(", agent {agent}"));
        }
        s
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStamp {
    schema_version: u32,
    session: String,
    identity: BackendIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launcher: Option<Launcher>,
}

/// Outcome of binding a stable session name to this launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Binding {
    /// No live survivor: a fresh stamp was written; the caller creates.
    Created,
    /// Live survivor with a live (or legacy-unknown) launcher: the caller attaches.
    Attached,
    /// Live survivor whose recorded launcher is gone: the caller must reap it
    /// and create afresh — never attach.
    Orphaned { reason: String },
}

/// Liveness of a stamp's recorded launcher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LauncherVerdict {
    Alive(Launcher),
    Dead {
        launcher: Launcher,
        reason: String,
    },
    /// Legacy schema-1 stamp — no launcher recorded, liveness unknown.
    Unknown,
}

fn stamp_path(session: &str) -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home dir")?;
    Ok(home
        .join(".papercusp")
        .join(format!("{session}.identity.json")))
}

/// Make every zellij/layout child inherit the already-normalized endpoint.
/// Setting BOTH variables prevents a helper that understands only the shared
/// seam from rediscovering a different operator than the PUI-specific seam.
pub fn inherited_operator_env(identity: &BackendIdentity) -> [(&'static str, String); 2] {
    [
        ("PUI_OPERATOR", identity.endpoint.clone()),
        ("PAPERCUSP_OPERATOR_URL", identity.endpoint.clone()),
    ]
}

pub fn inherit(identity: &BackendIdentity) {
    for (name, value) in inherited_operator_env(identity) {
        std::env::set_var(name, value);
    }
}

fn read_boot_id() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.is_empty())
}

/// The launcher block for THIS process.
pub fn current_launcher() -> Launcher {
    Launcher {
        pid: std::process::id(),
        boot_id: read_boot_id(),
        sid: env_nonempty("PAPERCUSP_SID"),
        agent: env_nonempty("PAPERCUSP_AGENT"),
        created_at_epoch: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    }
}

/// Pure liveness verdict: a recorded launcher is dead when the host has
/// rebooted since (boot id differs) or its pid is gone. `None` launcher =
/// legacy stamp = `Unknown` (never reaped on that basis alone).
pub fn launcher_verdict_for(
    launcher: Option<&Launcher>,
    current_boot_id: Option<&str>,
    pid_alive: impl Fn(u32) -> bool,
) -> LauncherVerdict {
    let Some(launcher) = launcher else {
        return LauncherVerdict::Unknown;
    };
    if let (Some(recorded), Some(current)) = (launcher.boot_id.as_deref(), current_boot_id) {
        if recorded != current {
            return LauncherVerdict::Dead {
                launcher: launcher.clone(),
                reason: format!("host rebooted since launch (boot {recorded} → {current})"),
            };
        }
    }
    if !pid_alive(launcher.pid) {
        return LauncherVerdict::Dead {
            launcher: launcher.clone(),
            reason: format!("launcher pid {} is gone", launcher.pid),
        };
    }
    LauncherVerdict::Alive(launcher.clone())
}

/// Read `session`'s stamp and classify its launcher against THIS host.
/// `None` = no readable stamp at all (an unstamped or foreign session).
pub fn launcher_verdict(session: &str) -> Option<LauncherVerdict> {
    let bytes = std::fs::read(stamp_path(session).ok()?).ok()?;
    let stamp: SessionStamp = serde_json::from_slice(&bytes).ok()?;
    Some(launcher_verdict_for(
        stamp.launcher.as_ref(),
        read_boot_id().as_deref(),
        crate::reap::pid_alive,
    ))
}

/// `Some(true)` alive, `Some(false)` dead, `None` unknown/no stamp — the
/// shape `reap::plan_stable` consumes.
pub fn launcher_alive(session: &str) -> Option<bool> {
    match launcher_verdict(session)? {
        LauncherVerdict::Alive(_) => Some(true),
        LauncherVerdict::Dead { .. } => Some(false),
        LauncherVerdict::Unknown => None,
    }
}

/// Validate a live stable session (attach / orphan verdict), or stamp a
/// newly-created one.
pub fn bind(session: &str, identity: &BackendIdentity, live: bool) -> Result<Binding> {
    bind_at(
        &stamp_path(session)?,
        session,
        identity,
        live,
        &current_launcher(),
        read_boot_id().as_deref(),
        crate::reap::pid_alive,
    )
}

pub fn clear(session: &str) {
    if let Ok(path) = stamp_path(session) {
        let _ = std::fs::remove_file(path);
    }
}

fn bind_at(
    path: &Path,
    session: &str,
    identity: &BackendIdentity,
    live: bool,
    launcher: &Launcher,
    current_boot_id: Option<&str>,
    pid_alive: impl Fn(u32) -> bool,
) -> Result<Binding> {
    if live {
        let bytes = std::fs::read(path).with_context(|| {
            format!(
                "refusing to attach to {session}: its operator identity stamp is missing ({}); close the session with `zellij kill-session {session}` or relaunch with the original PUI_OPERATOR",
                path.display()
            )
        })?;
        let prior: SessionStamp = serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "refusing to attach to {session}: its operator identity stamp is unreadable ({}); close the session with `zellij kill-session {session}`",
                path.display()
            )
        })?;
        // Orphan check FIRST: a dead launcher makes the survivor reapable
        // whatever operator it was bound to — there is nobody left to keep
        // its environment honest.
        if let LauncherVerdict::Dead { launcher, reason } =
            launcher_verdict_for(prior.launcher.as_ref(), current_boot_id, &pid_alive)
        {
            return Ok(Binding::Orphaned {
                reason: format!("{reason} (launched by {})", launcher.label()),
            });
        }
        if prior.session != session || !prior.identity.same_rendezvous(identity) {
            // Typed (R2): this is the canonical identity-mismatch — a backend
            // that answers but is not the one this session is bound to. Carrying
            // the type means `RendezvousError::classify` recognises it without
            // matching on the message text below.
            return Err(anyhow::Error::new(crate::http::IdentityMismatchError {
                endpoint: identity.endpoint.clone(),
                detail: format!(
                    "refusing to attach to {session}: running session is bound to [{}], but this launch selected [{}]. Close it with `zellij kill-session {session}` or relaunch with matching PUI_OPERATOR/PAPERCUSP_OPERATOR_URL",
                    prior.identity.compact(),
                    identity.compact()
                ),
            }));
        }
        return Ok(Binding::Attached);
    }

    let parent = path.parent().context("identity stamp has no parent")?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("create identity stamp dir {}", parent.display()))?;
    let stamp = SessionStamp {
        schema_version: STAMP_SCHEMA_VERSION,
        session: session.to_string(),
        identity: identity.clone(),
        launcher: Some(launcher.clone()),
    };
    let bytes = serde_json::to_vec_pretty(&stamp).context("encode PUI session identity")?;
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    std::fs::write(&tmp, bytes)
        .with_context(|| format!("write identity stamp {}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("publish identity stamp {}", path.display()))?;
    Ok(Binding::Created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::{AgentChatIdentity, BuildIdentity, OperatorCapabilities, StoreIdentity};

    fn ident(endpoint: &str, workspace: &str, store: &str) -> BackendIdentity {
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

    fn launcher(pid: u32) -> Launcher {
        Launcher {
            pid,
            boot_id: Some("boot-A".into()),
            sid: Some("su-ed29de9b-4ca0-4107-a9db-b776d506f17e".into()),
            agent: Some("codex".into()),
            created_at_epoch: 1_700_000_000,
        }
    }

    const BOOT_A: Option<&str> = Some("boot-A");

    #[test]
    fn fresh_session_stamps_launcher_and_live_launcher_attach_passes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pui-wb.identity.json");
        let current = ident("http://127.0.0.1:3070", "ws", "pg-a");
        let me = launcher(4242);
        let created = bind_at(&path, "pui-wb", &current, false, &me, BOOT_A, |_| true).unwrap();
        assert_eq!(created, Binding::Created);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("http://127.0.0.1:3070"));
        assert!(text.contains("pg-a"));
        assert!(text.contains("\"pid\": 4242"), "{text}");
        assert!(text.contains("\"schemaVersion\": 2"), "{text}");
        // CONTROL for the orphan rule below: an ALIVE launcher must attach.
        let attached = bind_at(&path, "pui-wb", &current, true, &me, BOOT_A, |pid| {
            pid == 4242
        })
        .unwrap();
        assert_eq!(attached, Binding::Attached);
    }

    #[test]
    fn live_survivor_with_dead_launcher_is_orphaned_not_attached() {
        // EI-22440755576757822: the codex agent's pui-wb outlived the agent.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pui-wb.identity.json");
        let current = ident("http://127.0.0.1:3070", "ws", "pg-a");
        bind_at(
            &path,
            "pui-wb",
            &current,
            false,
            &launcher(2053474),
            BOOT_A,
            |_| true,
        )
        .unwrap();
        let verdict = bind_at(
            &path,
            "pui-wb",
            &current,
            true,
            &launcher(1345546),
            BOOT_A,
            |pid| pid != 2053474,
        )
        .unwrap();
        match verdict {
            Binding::Orphaned { reason } => {
                assert!(reason.contains("pid 2053474 is gone"), "{reason}");
                assert!(reason.contains("agent codex"), "{reason}");
            }
            other => panic!("expected Orphaned, got {other:?}"),
        }
    }

    #[test]
    fn live_survivor_from_a_previous_boot_is_orphaned_even_if_pid_reused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pui-wb.identity.json");
        let current = ident("http://127.0.0.1:3070", "ws", "pg-a");
        bind_at(
            &path,
            "pui-wb",
            &current,
            false,
            &launcher(77),
            BOOT_A,
            |_| true,
        )
        .unwrap();
        // pid 77 "alive" again after reboot — pid reuse must not count.
        let verdict = bind_at(
            &path,
            "pui-wb",
            &current,
            true,
            &launcher(1),
            Some("boot-B"),
            |_| true,
        )
        .unwrap();
        assert!(matches!(verdict, Binding::Orphaned { ref reason } if reason.contains("rebooted")));
    }

    #[test]
    fn orphan_verdict_outranks_rendezvous_mismatch() {
        // A dead launcher's session is reapable whatever operator it was bound
        // to; the mismatch error would otherwise tell the user to kill it by hand.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pui-wb.identity.json");
        bind_at(
            &path,
            "pui-wb",
            &ident("http://127.0.0.1:3070", "ws", "pg-a"),
            false,
            &launcher(9),
            BOOT_A,
            |_| true,
        )
        .unwrap();
        let verdict = bind_at(
            &path,
            "pui-wb",
            &ident("http://127.0.0.1:3170", "ws", "pg-b"),
            true,
            &launcher(10),
            BOOT_A,
            |_| false,
        )
        .unwrap();
        assert!(matches!(verdict, Binding::Orphaned { .. }));
    }

    #[test]
    fn legacy_stamp_without_launcher_still_attaches() {
        // Schema-1 stamps predate the launcher block: an in-flight upgrade must
        // not reap a live owner session it cannot judge.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pui-wb.identity.json");
        let current = ident("http://127.0.0.1:3070", "ws", "pg-a");
        let legacy = serde_json::json!({
            "schemaVersion": 1,
            "session": "pui-wb",
            "identity": current,
        });
        std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let verdict = bind_at(
            &path,
            "pui-wb",
            &current,
            true,
            &launcher(1),
            BOOT_A,
            |_| false,
        )
        .unwrap();
        assert_eq!(verdict, Binding::Attached);
        let bytes = std::fs::read(&path).unwrap();
        let stamp: SessionStamp = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            launcher_verdict_for(stamp.launcher.as_ref(), BOOT_A, |_| false),
            LauncherVerdict::Unknown
        );
    }

    #[test]
    fn launcher_verdict_pure_cases() {
        let l = launcher(5);
        assert_eq!(
            launcher_verdict_for(Some(&l), BOOT_A, |pid| pid == 5),
            LauncherVerdict::Alive(l.clone())
        );
        assert!(matches!(
            launcher_verdict_for(Some(&l), BOOT_A, |_| false),
            LauncherVerdict::Dead { ref reason, .. } if reason.contains("pid 5 is gone")
        ));
        assert!(matches!(
            launcher_verdict_for(Some(&l), Some("boot-Z"), |_| true),
            LauncherVerdict::Dead { ref reason, .. } if reason.contains("rebooted")
        ));
        // No boot id on either side (non-Linux) → pid decides.
        let mut no_boot = l.clone();
        no_boot.boot_id = None;
        assert_eq!(
            launcher_verdict_for(Some(&no_boot), None, |_| true),
            LauncherVerdict::Alive(no_boot)
        );
        assert_eq!(
            launcher_verdict_for(None, BOOT_A, |_| true),
            LauncherVerdict::Unknown
        );
    }

    #[test]
    fn every_zellij_child_receives_both_canonical_endpoint_seams() {
        let current = ident("http://127.0.0.1:3170", "ws", "pg-a");
        assert_eq!(
            inherited_operator_env(&current),
            [
                ("PUI_OPERATOR", "http://127.0.0.1:3170".to_string()),
                (
                    "PAPERCUSP_OPERATOR_URL",
                    "http://127.0.0.1:3170".to_string()
                ),
            ]
        );
    }

    #[test]
    fn stable_attach_refuses_cross_operator_or_store_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pui-wb.identity.json");
        bind_at(
            &path,
            "pui-wb",
            &ident("http://127.0.0.1:3070", "ws", "pg-a"),
            false,
            &launcher(9),
            BOOT_A,
            |_| true,
        )
        .unwrap();
        let err = bind_at(
            &path,
            "pui-wb",
            &ident("http://127.0.0.1:3170", "ws", "pg-b"),
            true,
            &launcher(9),
            BOOT_A,
            |_| true,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("refusing to attach to pui-wb"), "{err}");
        assert!(err.contains("zellij kill-session pui-wb"), "{err}");
        assert!(err.contains("3070") && err.contains("3170"), "{err}");
    }

    #[test]
    fn live_session_without_a_valid_stamp_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.json");
        let me = launcher(1);
        assert!(bind_at(
            &missing,
            "pui-wb",
            &ident("http://127.0.0.1:3070", "ws", "pg-a"),
            true,
            &me,
            BOOT_A,
            |_| true,
        )
        .unwrap_err()
        .to_string()
        .contains("stamp is missing"));
        std::fs::write(&missing, "not json").unwrap();
        assert!(bind_at(
            &missing,
            "pui-wb",
            &ident("http://127.0.0.1:3070", "ws", "pg-a"),
            true,
            &me,
            BOOT_A,
            |_| true,
        )
        .unwrap_err()
        .to_string()
        .contains("stamp is unreadable"));
    }
}
