//! Boot-time WebKitGTK localStorage WAL reclaim + runaway guard (EI-14135).
//!
//! WebKitGTK persists each origin's `window.localStorage` as a SQLite database
//! in WAL mode under
//! `<app_local_data_dir>/localstorage/<origin>.localstorage`
//! (e.g. `~/.local/share/com.papercusp.gui/localstorage/http_127.0.0.1_3070.localstorage`).
//!
//! ## The bug
//! The operator webview is a long-lived page that keeps a persistent read
//! connection open on that store. SQLite can only RESET a WAL past the oldest
//! reader, so with a permanent reader present an auto-checkpoint can never wrap
//! the WAL — every write just appends. And because the desktop shell is
//! frequently KILLED rather than closed gracefully (a crash, `pkill -9`,
//! `launchctl kickstart -k`, an OS logout), the on-close checkpoint that would
//! normally reset the WAL never runs either. The `-wal` therefore grows
//! without bound: observed at ~127 GiB, ~121,000x the ~1 MiB main DB
//! (EI-14135). A reader that opens the store `immutable=1` (a natural
//! crash-safe read choice) also SKIPS the WAL entirely and sees stale data.
//!
//! ## The fix (NOT deletion — that loses uncommitted frames AND regrows)
//! At every GUI boot, BEFORE the webview reopens the store (so no reader holds
//! an old frame), open each `*.localstorage` DB and run
//! `PRAGMA wal_checkpoint(TRUNCATE)`. That applies every WAL frame to the main
//! DB and truncates the `-wal` back to zero, losslessly, once per session — so
//! the WAL can never accumulate across restarts. It runs while the process is
//! still synchronously in `run()`'s `.setup()` callback, before the async page
//! load reaches JS that first touches `localStorage`, so no reader is present
//! and the TRUNCATE can fully complete. Even in a worst-case race (a reader
//! already holding a frame) the checkpoint reports `busy` and is a safe no-op
//! that reclaims on the next boot instead — it can never corrupt the store.
//!
//! A boot-time GUARD additionally logs a loud warning when a `-wal` is already
//! a pathological multiple of its main DB, so a future regression surfaces in
//! the boot log instead of silently eating disk.
//!
//! Scope: Linux/WebKitGTK only — macOS `WKWebView` and Windows WebView2 use
//! different localStorage backends under different paths, so the boot call in
//! `main.rs` is `#[cfg(target_os = "linux")]`. The functions here are portable
//! (plain fs + rusqlite) so the regression test runs on any platform.

use std::path::{Path, PathBuf};

/// A `-wal` is flagged as runaway when it is BOTH a large multiple of its main
/// DB AND past an absolute floor. The floor stops a tiny freshly-created store
/// (where a few KiB of WAL is naturally a big multiple of a near-empty DB) from
/// false-alarming.
const WAL_ALARM_RATIO: u64 = 20;
/// 128 MiB — below this a WAL is never "runaway" no matter the ratio.
const WAL_ALARM_MIN_BYTES: u64 = 128 * 1024 * 1024;

/// Pure predicate (unit-tested): is this `-wal` a runaway relative to its main
/// DB? `main_bytes` may be 0 (a brand-new / missing store); the absolute floor
/// still gates, so a 0-byte main DB only alarms once the WAL itself is huge.
pub fn wal_is_runaway(main_bytes: u64, wal_bytes: u64) -> bool {
    wal_bytes >= WAL_ALARM_MIN_BYTES && wal_bytes >= main_bytes.saturating_mul(WAL_ALARM_RATIO)
}

/// Outcome of a boot reclaim pass over one localstorage directory.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct WalReclaimReport {
    /// `*.localstorage` DBs that had a non-empty `-wal` we tried to checkpoint.
    pub attempted: usize,
    /// DBs whose WAL was fully checkpoint-truncated (`busy == 0`).
    pub checkpointed: usize,
    /// DBs whose `-wal` looked runaway BEFORE the checkpoint (guard alarms).
    pub runaway_seen: usize,
    /// Total `-wal` bytes reclaimed across all DBs (best-effort, pre − post).
    pub bytes_reclaimed: u64,
    /// EI-18794661891306642: DBs where the checkpoint attempt was `busy` AND
    /// reclaimed ZERO bytes (`wal_after >= wal_before`) — a remediation that
    /// ran and did nothing, previously logged as if it were a normal outcome.
    /// This is the detector-failure half of the bug: we must be able to tell
    /// "attempted + reclaimed nothing" apart from "attempted + reclaimed
    /// something" without re-deriving it from the busy/log/ckpt numbers by
    /// hand. A DB counted here almost always means a PERSISTENT reader (most
    /// often an orphaned webview process from a prior crash/`pkill -9`, not a
    /// transient writer) is holding the store open — a boot-time retry with a
    /// short sleep cannot fix that, so this is surfaced as a loud alarm
    /// instead of silently retried.
    pub failed_reclaim: usize,
}

fn file_len(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// The `-wal` sibling of a `*.localstorage` main DB
/// (`foo.localstorage` → `foo.localstorage-wal`).
fn wal_path(db: &Path) -> PathBuf {
    let mut name = db.file_name().unwrap_or_default().to_os_string();
    name.push("-wal");
    db.with_file_name(name)
}

/// Open `db` and run `PRAGMA wal_checkpoint(TRUNCATE)`. Returns
/// `(busy, log_frames, checkpointed_frames)` per SQLite's checkpoint contract:
/// `busy == 0` means the WAL was fully reset AND truncated to zero.
fn checkpoint_truncate(db: &Path) -> rusqlite::Result<(i64, i64, i64)> {
    // Default open flags = read-write, no-create. If the file vanished between
    // scan and open, this errors and the caller logs + skips it.
    let conn = rusqlite::Connection::open(db)?;
    // A short busy timeout so a transient writer doesn't hard-fail the checkpoint.
    let _ = conn.busy_timeout(std::time::Duration::from_millis(2000));
    let row = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    Ok(row)
}

/// Scan `localstorage_dir` for `*.localstorage` DBs and TRUNCATE-checkpoint any
/// with a non-empty `-wal`. Best-effort and never panics: every per-DB failure
/// is logged and skipped so a broken store can't wedge boot. Returns a report
/// for the boot log (and the regression test).
pub fn reclaim_localstorage_wals(localstorage_dir: &Path) -> WalReclaimReport {
    let mut report = WalReclaimReport::default();
    let entries = match std::fs::read_dir(localstorage_dir) {
        Ok(e) => e,
        // Dir absent (first run, or a non-WebKitGTK backend) — nothing to do.
        Err(_) => return report,
    };
    for entry in entries.flatten() {
        let db = entry.path();
        // Only the main DBs: names ending exactly ".localstorage" (this skips
        // the "-wal"/"-shm" siblings, which end in "-wal"/"-shm").
        let is_main = db
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with(".localstorage"))
            .unwrap_or(false);
        if !is_main {
            continue;
        }
        let wal = wal_path(&db);
        let wal_before = file_len(&wal);
        if wal_before == 0 {
            continue; // no WAL to reclaim
        }
        let main_bytes = file_len(&db);
        report.attempted += 1;
        if wal_is_runaway(main_bytes, wal_before) {
            report.runaway_seen += 1;
            eprintln!(
                "[papercusp-desktop] localstorage WAL RUNAWAY: {} is {} bytes (main DB {} bytes, ~{}x) — reclaiming (EI-14135)",
                wal.display(),
                wal_before,
                main_bytes,
                wal_before / main_bytes.max(1),
            );
        }
        match checkpoint_truncate(&db) {
            Ok((busy, log, ckpt)) => {
                let wal_after = file_len(&wal);
                report.bytes_reclaimed += wal_before.saturating_sub(wal_after);
                if busy == 0 {
                    report.checkpointed += 1;
                }
                // EI-18794661891306642: `busy != 0` alone is not a failure — SQLite
                // legitimately reports transient busy while still reclaiming SOME
                // frames. The FAILED remediation is the combination the bug named:
                // busy AND zero bytes reclaimed. That combination previously logged
                // through the exact same `println!` as every successful checkpoint,
                // so a completely no-op remediation read as if an action had been
                // taken. Name it as its own, louder log line instead.
                let reclaimed_nothing = busy != 0 && wal_after >= wal_before;
                if reclaimed_nothing {
                    report.failed_reclaim += 1;
                    eprintln!(
                        "[papercusp-desktop] localstorage WAL RECLAIM FAILED: {} busy={busy} log={log} ckpt={ckpt} wal unchanged at {} bytes — a reader (most likely an orphaned webview process from a prior crash/kill, since this checkpoint runs before this process's OWN webview opens the store) is holding the store open and will keep it from truncating on every boot until it exits. Find and end that process; this WAL will keep growing until then.",
                        db.file_name().and_then(|n| n.to_str()).unwrap_or("?"),
                        wal_before,
                    );
                } else {
                    println!(
                        "[papercusp-desktop] localstorage checkpoint {}: busy={busy} log={log} ckpt={ckpt} wal {} -> {} bytes",
                        db.file_name().and_then(|n| n.to_str()).unwrap_or("?"),
                        wal_before,
                        wal_after,
                    );
                }
            }
            Err(e) => {
                eprintln!(
                    "[papercusp-desktop] localstorage checkpoint FAILED for {}: {e} (skipping; non-fatal)",
                    db.display()
                );
            }
        }
    }
    report
}

/// Boot-time entry point: reclaim the GUI webview's localStorage WALs, resolving
/// the store dir as `<app_local_data_dir>/localstorage` (how WebKitGTK/wry lay
/// it out on Linux). Best-effort; logs a one-line summary when anything was
/// found. Called from `run()`'s `.setup()` for the GUI/dev role on Linux.
pub fn reclaim_on_boot(app_local_data_dir: &Path) {
    let dir = app_local_data_dir.join("localstorage");
    let report = reclaim_localstorage_wals(&dir);
    if report.attempted > 0 {
        println!(
            "[papercusp-desktop] localstorage WAL reclaim: {} attempted, {} truncated, {} runaway, {} failed (reader busy, 0 bytes reclaimed), {} bytes reclaimed ({})",
            report.attempted,
            report.checkpointed,
            report.runaway_seen,
            report.failed_reclaim,
            report.bytes_reclaimed,
            dir.display(),
        );
    }
    // EI-18794661891306642: a per-boot summary line is easy to scroll past (exactly
    // the complaint that motivated this fix) — a SEPARATE, unmissable alarm when
    // this boot leaves a genuinely runaway WAL still unreclaimed, so the failure
    // mode doesn't just quietly repeat forever across restarts.
    if report.failed_reclaim > 0 {
        eprintln!(
            "[papercusp-desktop] WARNING: {} localstorage WAL(s) could NOT be reclaimed this boot (reader still busy) — disk usage under {} will keep growing until the blocking process is found and ended.",
            report.failed_reclaim,
            dir.display(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wal_runaway_guard_flags_only_the_pathological_case() {
        // Normal operation: a WAL a few times the DB, well under the abs floor.
        assert!(!wal_is_runaway(1_000_000, 4_000_000)); // 4x, ~4 MiB
        assert!(!wal_is_runaway(1_000_000, 2_000_000)); // 2x
                                                        // A big multiple but still under the 128 MiB absolute floor — no alarm
                                                        // (a small store churning is normal; we only care about disk runaways).
        assert!(!wal_is_runaway(1_000, 100_000_000)); // 100k x but < 128 MiB
                                                      // Over the floor but only a modest multiple — not runaway.
        assert!(!wal_is_runaway(200_000_000, 200_000_000)); // 1x, 200 MiB main
                                                            // The exact EI-14135 shape: ~127 GiB WAL over a ~1.1 MiB main DB.
        assert!(wal_is_runaway(1_126_400, 136_862_255_312));
        // Over the floor AND a large multiple.
        assert!(wal_is_runaway(5_000_000, 30_000_000_000));
        // Missing/zero main DB with a huge WAL still alarms (floor gates it).
        assert!(wal_is_runaway(0, 200_000_000));
    }

    fn unique_tmp_dir(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "papercusp-lswal-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        ));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    /// Grow a WebKitGTK-shaped WAL DB with auto-checkpoint disabled, then prove
    /// `reclaim_localstorage_wals` TRUNCATE-checkpoints it back to ~0 WITHOUT
    /// losing committed data (the actual EI-14135 fix path).
    #[test]
    fn reclaim_truncate_shrinks_a_grown_wal_and_preserves_data() {
        let dir = unique_tmp_dir("shrink");
        let db = dir.join("http_127.0.0.1_3070.localstorage");
        let conn = rusqlite::Connection::open(&db).unwrap();
        // WAL mode + never auto-checkpoint → the -wal grows unbounded, exactly
        // the runaway condition.
        let mode: String = conn
            .query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        conn.execute("CREATE TABLE kv(k INTEGER PRIMARY KEY, v BLOB)", [])
            .unwrap();
        for i in 0..1500 {
            conn.execute(
                "INSERT INTO kv(k, v) VALUES (?1, zeroblob(8192))",
                rusqlite::params![i],
            )
            .unwrap();
        }

        let wal = wal_path(&db);
        let before = file_len(&wal);
        assert!(
            before > 4_000_000,
            "precondition: the -wal should have grown large, got {before} bytes"
        );

        // The writer connection above is idle (all INSERTs committed), so it
        // holds no read mark — a TRUNCATE checkpoint from reclaim's own
        // connection can fully complete, mirroring boot BEFORE the webview
        // reopens the store.
        let report = reclaim_localstorage_wals(&dir);
        assert_eq!(report.attempted, 1, "should have found the one DB");
        assert_eq!(
            report.checkpointed, 1,
            "TRUNCATE should have completed (busy=0)"
        );
        assert_eq!(
            report.failed_reclaim, 0,
            "a fully-completed checkpoint (busy=0) must never count as a failed reclaim"
        );

        let after = file_len(&wal);
        assert!(
            after < before / 10,
            "the -wal should be truncated: before={before} after={after}"
        );
        assert!(report.bytes_reclaimed >= before.saturating_sub(after));

        // Committed data survives the checkpoint (this is a checkpoint, not a
        // delete): the row count is intact through the SAME and a FRESH conn.
        let n: i64 = conn
            .query_row("SELECT count(*) FROM kv", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1500);
        drop(conn);
        let reopened = rusqlite::Connection::open(&db).unwrap();
        let n2: i64 = reopened
            .query_row("SELECT count(*) FROM kv", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n2, 1500, "data must survive across a reopen");
        drop(reopened);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// EI-18794661891306642: the actual reported bug — a checkpoint that reports
    /// `busy=1` and reclaims ZERO bytes must be counted + logged as a FAILED
    /// remediation, not silently folded into the same success path as a fully
    /// completed checkpoint. Simulated by holding a second connection inside an
    /// open read transaction (a `BEGIN` + `SELECT` with no `COMMIT`) — SQLite's
    /// TRUNCATE checkpoint cannot pass that reader's mark, so it comes back busy
    /// while leaving the `-wal` exactly as it was, the precise shape from the
    /// bug's log excerpt (`wal 553348992 -> 553348992 bytes`).
    #[test]
    fn a_busy_checkpoint_that_reclaims_nothing_is_reported_as_a_failed_reclaim() {
        let dir = unique_tmp_dir("busy-noop");
        let db = dir.join("http_127.0.0.1_34270.localstorage");
        let writer = rusqlite::Connection::open(&db).unwrap();
        let mode: String = writer
            .query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        writer
            .execute("CREATE TABLE kv(k INTEGER PRIMARY KEY, v BLOB)", [])
            .unwrap();
        for i in 0..1500 {
            writer
                .execute(
                    "INSERT INTO kv(k, v) VALUES (?1, zeroblob(8192))",
                    rusqlite::params![i],
                )
                .unwrap();
        }

        let wal = wal_path(&db);
        let before = file_len(&wal);
        assert!(
            before > 4_000_000,
            "precondition: -wal should have grown, got {before}"
        );

        // A third, merely-idle connection held open for the WHOLE test so that
        // dropping `reader` (and later `writer`) is never the LAST connection to
        // close — SQLite auto-checkpoints on the last connection's close, which
        // would silently truncate the WAL as a side effect of `drop()` and mask
        // the thing this test actually exercises (an explicit boot-time TRUNCATE
        // checkpoint succeeding once the BLOCKING reader, specifically, is gone).
        let _keepalive = rusqlite::Connection::open(&db).unwrap();

        // A second, still-open reader holding a read mark on the pre-checkpoint
        // WAL contents — this is what a lingering orphaned webview process (or
        // any other still-alive reader) looks like from the checkpointer's side.
        let reader = rusqlite::Connection::open(&db).unwrap();
        reader
            .execute_batch("BEGIN; SELECT count(*) FROM kv;")
            .unwrap();

        let report = reclaim_localstorage_wals(&dir);
        assert_eq!(report.attempted, 1);
        assert_eq!(
            report.checkpointed, 0,
            "the open reader must block a full (busy=0) checkpoint"
        );
        assert_eq!(
            report.failed_reclaim, 1,
            "busy + zero bytes reclaimed must be counted as a FAILED reclaim, not silently ignored"
        );

        let after = file_len(&wal);
        assert!(
            after >= before,
            "precondition of this test: the reader must fully block reclamation (before={before} after={after})"
        );

        // Releasing the reader and retrying (mirrors a LATER boot, once the
        // blocking process is gone) must now succeed and clear the failure.
        // NOTE: since our earlier busy attempt already fully checkpointed every
        // WAL frame back into the main DB (`log == ckpt` above — only the
        // truncate step was refused), SQLite may finish the reclaim itself as a
        // side effect of the blocking reader's own close, before our retry call
        // even runs — a genuinely-orphaned process's exit does the same. Either
        // way the observable contract holds: the WAL is gone/reclaimable and
        // reported as NO LONGER a failure, which is what this asserts (rather
        // than over-specifying which particular call physically truncated it).
        reader.execute_batch("COMMIT;").unwrap();
        drop(reader);
        drop(writer);
        let report2 = reclaim_localstorage_wals(&dir);
        assert!(
            report2.attempted == 0 || report2.checkpointed == 1,
            "once the reader is gone, the WAL must end up fully reclaimed (report2={report2:?})"
        );
        assert_eq!(
            report2.failed_reclaim, 0,
            "no failure should be reported once the blocking reader is gone"
        );
        assert_eq!(
            file_len(&wal),
            0,
            "the -wal must actually be gone once the blocking reader is gone"
        );
        drop(_keepalive);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reclaim_is_a_safe_noop_on_a_missing_or_walless_dir() {
        // Missing dir → empty report, no panic.
        let missing = std::env::temp_dir().join("papercusp-lswal-does-not-exist-xyz");
        assert_eq!(
            reclaim_localstorage_wals(&missing),
            WalReclaimReport::default()
        );

        // Dir with a non-WAL main DB (no -wal sibling) → nothing attempted.
        let dir = unique_tmp_dir("noop");
        let db = dir.join("http_127.0.0.1_3055.localstorage");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute("CREATE TABLE t(x INTEGER)", []).unwrap();
        drop(conn);
        let report = reclaim_localstorage_wals(&dir);
        assert_eq!(report.attempted, 0);
        std::fs::remove_dir_all(&dir).ok();
    }
}
