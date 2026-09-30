//! First-run tutorial state (P9), persisted in `~/.papercusp/pui-state.json`.
//! Whether the guided overlay has been completed is **per-device first-run
//! state** — it should NOT sync across machines, and the TUI is IPC-only with no
//! direct PG, so a small local JSON file is the right home (PG-backed
//! cross-device *view-state* is the separate, deferred P12). The file is a JSON
//! object so P12 can grow it later; today it carries just `tutorialSeen`.
//! Best-effort: a missing/unwritable/malformed file just means the tutorial
//! shows again.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// Number of guided steps (kept in sync with `ui::draw_tutorial`).
pub const STEPS: usize = 4;

fn base_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".papercusp"))
}

fn state_path(base: &Path) -> PathBuf {
    base.join("pui-state.json")
}

/// Has the tutorial been completed on this device?
pub fn seen() -> bool {
    base_dir().map(|d| seen_at(&d)).unwrap_or(false)
}

/// Record the tutorial as completed (best-effort), preserving any other keys
/// already in the state file.
pub fn mark_seen() {
    if let Some(d) = base_dir() {
        mark_seen_at(&d);
    }
}

fn seen_at(base: &Path) -> bool {
    std::fs::read_to_string(state_path(base))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("tutorialSeen").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

fn mark_seen_at(base: &Path) {
    let _ = std::fs::create_dir_all(base);
    let path = state_path(base);
    // Merge into existing state so we don't clobber future P12 view-state keys.
    let mut state = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = state.as_object_mut() {
        obj.insert("tutorialSeen".to_string(), Value::Bool(true));
    }
    let _ = std::fs::write(&path, state.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unseen_then_seen_roundtrip() {
        let d = tempfile::tempdir().unwrap();
        assert!(!seen_at(d.path()));
        mark_seen_at(d.path());
        assert!(seen_at(d.path()));
    }

    #[test]
    fn mark_seen_preserves_other_keys() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(state_path(d.path()), r#"{"activeTab":"plans"}"#).unwrap();
        mark_seen_at(d.path());
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(state_path(d.path())).unwrap()).unwrap();
        assert_eq!(v["tutorialSeen"], serde_json::json!(true));
        assert_eq!(v["activeTab"], serde_json::json!("plans")); // untouched
    }

    #[test]
    fn malformed_state_reads_as_unseen() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(state_path(d.path()), "not json").unwrap();
        assert!(!seen_at(d.path()));
    }
}
