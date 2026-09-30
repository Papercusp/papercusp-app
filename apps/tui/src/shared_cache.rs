//! Cross-process, best-effort response cache for hot admin-proxy GETs.
//!
//! Root-cause context (WI-3776 / D-004 of
//! `fleet-deltas-leader-primitives-2026-07-10`, extending
//! `agent-insights/plans-egress-is-poll-frequency-not-payload.mdx`):
//! `/api/admin/plans/list` carries ZERO cursor/delta negotiation —
//! `FLAGS.SYNC_RESOURCE_DELTA` only wires the desktop webview's
//! `@papercusp/sync` rest-query path (`useSyncQuery`), which this admin
//! proxy never touches. `pui` (this binary) is a genuinely separate
//! client of a genuinely separate route, so flipping that flag ON can
//! never engage for this traffic — there was no code path connecting
//! the two.
//!
//! Several independent `pui` processes on one box (Fleet / PlansBoard /
//! Plans / Inbox-pinned panes, the full workbench, …) each subscribe to
//! the operator's own SSE-invalidate stream and, on a debounced signal,
//! each independently issue a FULL re-fetch (`refetch_all` in
//! `main.rs`). Because they react to the SAME server-side push, they
//! land within milliseconds of each other (observed live: two calls
//! 11ms apart in `harness_shared.tool_invocations`) — pure duplicate
//! work, not genuinely-different reads.
//!
//! This is a small, protocol-agnostic stand-in for the cursor/`ETag`
//! negotiation a full delta client would do: a short-lived, on-disk,
//! last-writer-wins cache shared by every `pui` process on the machine.
//! A near-simultaneous burst collapses into one real network call + N-1
//! free local reads, at the cost of a few seconds of extra staleness —
//! well inside the SSE invalidation loop's own 250ms debounce and the
//! 60s safety-net cadence it already tolerates.
//!
//! Deliberately dumb: no locking, no cross-process coordination beyond
//! the filesystem. A reader racing a writer never sees a torn write —
//! every write lands via a per-process temp file + atomic rename, so a
//! concurrent read observes either the complete prior file or the
//! complete new one.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

fn cache_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".papercusp").join("cache"))
}

fn cache_path_at(base: &Path, key: &str) -> PathBuf {
    base.join(format!("{key}.json"))
}

/// Read `key`'s cached bytes if the file exists and was written within
/// `max_age`. Any I/O error, missing file, or stale mtime is a plain
/// cache miss (`None`) — this is a pure optimization layer over the real
/// fetch, so a failure here must never surface as an error to the caller.
fn read_fresh_at(base: &Path, key: &str, max_age: Duration) -> Option<Vec<u8>> {
    let path = cache_path_at(base, key);
    let meta = std::fs::metadata(&path).ok()?;
    let modified = meta.modified().ok()?;
    let age = SystemTime::now().duration_since(modified).ok()?;
    if age > max_age {
        return None;
    }
    std::fs::read(&path).ok()
}

/// Best-effort write-through: temp file + atomic rename, so a concurrent
/// reader from another `pui` process on the same machine never observes a
/// partial write. Any failure (missing home dir, disk full, permission
/// denied, a concurrent writer winning the rename race) is silently
/// swallowed — this is a cache, not a store of record, and a write that
/// never lands just means the next process pays for a real fetch.
fn write_best_effort_at(base: &Path, key: &str, bytes: &[u8]) {
    if std::fs::create_dir_all(base).is_err() {
        return;
    }
    let path = cache_path_at(base, key);
    let tmp = base.join(format!(".{key}.{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Read `key`'s cached bytes from `~/.papercusp/cache/<key>.json` if
/// fresher than `max_age`. `None` on any miss (absent, stale, unreadable,
/// or no resolvable home dir) — always safe to fall through to a real fetch.
pub fn read_fresh(key: &str, max_age: Duration) -> Option<Vec<u8>> {
    let base = cache_dir()?;
    read_fresh_at(&base, key, max_age)
}

/// Write `bytes` to `~/.papercusp/cache/<key>.json` for other local `pui`
/// processes to pick up. Best-effort; never panics, never surfaces an error.
pub fn write_best_effort(key: &str, bytes: &[u8]) {
    if let Some(base) = cache_dir() {
        write_best_effort_at(&base, key, bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn miss_on_absent_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_fresh_at(dir.path(), "plans-list", Duration::from_secs(3)).is_none());
    }

    #[test]
    fn hit_on_fresh_write() {
        let dir = tempfile::tempdir().unwrap();
        write_best_effort_at(dir.path(), "plans-list", b"{\"plans\":[]}");
        let got = read_fresh_at(dir.path(), "plans-list", Duration::from_secs(3));
        assert_eq!(got.as_deref(), Some(&b"{\"plans\":[]}"[..]));
    }

    #[test]
    fn miss_when_older_than_max_age() {
        let dir = tempfile::tempdir().unwrap();
        write_best_effort_at(dir.path(), "plans-list", b"{}");
        // Back-date the file's mtime past the freshness window instead of a
        // real sleep — deterministic, no wall-clock flake. `File::set_modified`
        // (stable) avoids pulling in a new crate just for this one test.
        let path = cache_path_at(dir.path(), "plans-list");
        let stale = SystemTime::now() - Duration::from_secs(10);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(stale)
            .unwrap();
        assert!(read_fresh_at(dir.path(), "plans-list", Duration::from_secs(3)).is_none());
    }

    #[test]
    fn distinct_keys_do_not_collide() {
        let dir = tempfile::tempdir().unwrap();
        write_best_effort_at(dir.path(), "plans-list", b"A");
        write_best_effort_at(dir.path(), "attention", b"B");
        assert_eq!(
            read_fresh_at(dir.path(), "plans-list", Duration::from_secs(3)).as_deref(),
            Some(&b"A"[..])
        );
        assert_eq!(
            read_fresh_at(dir.path(), "attention", Duration::from_secs(3)).as_deref(),
            Some(&b"B"[..])
        );
    }

    #[test]
    fn a_later_write_overwrites_an_earlier_one() {
        let dir = tempfile::tempdir().unwrap();
        write_best_effort_at(dir.path(), "plans-list", b"first");
        write_best_effort_at(dir.path(), "plans-list", b"second");
        assert_eq!(
            read_fresh_at(dir.path(), "plans-list", Duration::from_secs(3)).as_deref(),
            Some(&b"second"[..])
        );
    }

    #[test]
    fn write_creates_missing_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("does").join("not").join("exist");
        write_best_effort_at(&nested, "plans-list", b"{}");
        assert_eq!(
            read_fresh_at(&nested, "plans-list", Duration::from_secs(3)).as_deref(),
            Some(&b"{}"[..])
        );
    }

    #[test]
    fn no_leftover_tmp_file_after_a_successful_write() {
        let dir = tempfile::tempdir().unwrap();
        write_best_effort_at(dir.path(), "plans-list", b"{}");
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["plans-list.json".to_string()]);
    }
}
