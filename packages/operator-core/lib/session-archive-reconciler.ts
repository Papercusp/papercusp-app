/**
 * session-archive-reconciler.ts — the BACKSTOP sweep
 * (plan session-db-archive-retire-dirs-2026-07-10 P-006, owner Q4).
 *
 * The fast path (session-archive-hook, fired from markAdvSessionEnded) misses
 * sessions whose process died without stamping: kill -9, OOM, host crash,
 * operator down at exit — the exact ghost class idle-session-reaper exists
 * for. This reconciler applies the same two-path doctrine to ARCHIVAL, one
 * bounded, idempotent tick at a time (hourly via periodic-workflows):
 *
 *  (a) DB-side: adv_sessions WHERE ended_at IS NOT NULL AND archived_at IS
 *      NULL (the migration-539 partial index) → runArchiveForAdvSession.
 *      Rows with NOTHING to archive (no native id, files already gone, a
 *      --no-session-persistence run — D-004) are stamped archived_at after a
 *      grace period so they leave the scan set: adv.archived_at means "needs
 *      no further archive attention"; the session_archives stamp row is the
 *      actual "archive exists" marker.
 *
 *  (b) disk-side: per-session dirs (claude owner dirs, codex homes — the
 *      session-dir-gc roots) whose identity is NOT in the live protected set
 *      (open adv row / live presence / running bee / armed wake — reused
 *      VERBATIM from session-dir-gc so the reapers can never disagree, the
 *      EI-311 rule) → every un-archived session id inside gets
 *      archive+delete; already-archived leftovers get the sha-checked delete.
 *      This same sweep IS the engine of the P-011 backlog drain. omp
 *      transcripts (flat files, no per-session dir) get the same treatment
 *      with an mtime grace, since a live omp session keeps its file fresh.
 *
 * Dir REMOVAL stays session-dir-gc's job — this module only ever removes the
 * files it has verifiably archived.
 */

import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { getOrgPg } from '@papercusp/db-org';
import {
  defaultSessionDirRoots,
  gatherProtectedSessionIdentity,
  isProtected,
  sessionDirKey,
  type ProtectedSessionIdentity,
  type SessionDirRoot,
} from './session-dir-gc';
import { ompSessionsRoot } from './omp-sessions';
import { isLiveSkipReason, runArchiveForAdvSession, type ArchiveHookResult } from './session-archive-hook';
import {
  archiveAndDeleteSession,
  collectSessionFiles,
  deleteArchivedSessionFiles,
  listClaudeSessionIds,
  listCodexRolloutSessionIds,
  pgSessionArchiveStore,
  type SessionArchiveStore,
} from './session-archive';

/** Per-tick bounds — the reconciler converges over ticks, never gulps.
 *  DB rows are scanned wide (a stamp-out of a nothing-to-archive row is one
 *  cheap UPDATE — the pre-plan backlog is ~19k such rows) while actual
 *  ARCHIVE work per tick is capped separately. */
const MAX_DB_ROWS_PER_TICK = 500;
const MAX_DB_ARCHIVES_PER_TICK = 50;
const MAX_DIRS_PER_TICK = 100;
const MAX_OMP_FILES_PER_TICK = 200;
/** ended_at must be at least this old before a nothing-to-archive row is
 *  stamped out of the scan set (gives a slow final flush every chance). */
const NOTHING_TO_ARCHIVE_GRACE_MS = 60 * 60 * 1000;
/** An omp transcript must be quiet this long before the disk sweep takes it —
 *  a LIVE omp session keeps appending, so its mtime stays fresh. */
const OMP_FILE_GRACE_MS = 24 * 60 * 60 * 1000;
/** claude/codex session files must be quiet this long before the disk sweep
 *  touches them (WI-3859 F5). A raw/untracked resumed session has NO adv row
 *  and NO presence — the protected set cannot see it; its only signal is a
 *  fresh mtime. Without this grace the sweep would archive and DELETE a live
 *  transcript out from under the CLI that is appending to it. */
const QUIET_FILE_GRACE_MS = 60 * 60 * 1000;

export interface ReconcilerDb {
  listEndedUnarchived(limit: number): Promise<Array<{ id: number; endedAtMs: number }>>;
  stampArchivedAt(advSessionId: number): Promise<void>;
  countEndedUnarchived(): Promise<number>;
}

function pgReconcilerDb(): ReconcilerDb {
  return {
    async listEndedUnarchived(limit) {
      const { sql } = getOrgPg();
      const rows = await sql<Array<{ id: number; ended_at: Date }>>`
        SELECT id, ended_at FROM harness_shared.adv_sessions
         WHERE ended_at IS NOT NULL AND archived_at IS NULL
         ORDER BY ended_at ASC
         LIMIT ${limit}`;
      return rows.map((r) => ({ id: r.id, endedAtMs: new Date(r.ended_at).getTime() }));
    },
    async stampArchivedAt(advSessionId) {
      const { sql } = getOrgPg();
      await sql`
        UPDATE harness_shared.adv_sessions SET archived_at = now()
         WHERE id = ${advSessionId} AND archived_at IS NULL`;
    },
    async countEndedUnarchived() {
      const { sql } = getOrgPg();
      const rows = await sql<Array<{ n: string | number }>>`
        SELECT count(*) AS n FROM harness_shared.adv_sessions
         WHERE ended_at IS NOT NULL AND archived_at IS NULL`;
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export interface ReconcileStats {
  dbScanned: number;
  dbArchived: number;
  /** Nothing-to-archive rows stamped out of the scan set (post-grace). */
  dbStampedEmpty: number;
  /** Ended-but-unarchived rows whose session looked LIVE this tick
   *  (`row_reopened` / `transcript_fresh` / `owner_live`, EI-22126624550252124)
   *  — nothing touched, NOT stamped, retried next tick. Distinct from
   *  `dbFailed`: this is the guard working, not an error. A row that stays here
   *  for a long time is an adv row wrongly marked ended under a live owner. */
  dbSkippedLive: number;
  dbFailed: number;
  diskDirsScanned: number;
  diskSessionsArchived: number;
  diskLeftoversDeleted: number;
  /** Manifest entries left ON DISK because they are not keyed by the session
   *  being archived — directory-shared state a sibling session still needs
   *  (`isSessionKeyedRelpath`, WI-38706). Nonzero is EXPECTED while pre-fix
   *  codex manifests survive; it is the guard working, not a failure. */
  diskLeftoversRetained: number;
  diskFailed: number;
  /** Sessions skipped this tick: files still CHANGING (possibly a live
   *  untracked session the protected set cannot see) — retried once quiet. */
  diskSkippedFresh: number;
  ompFilesArchived: number;
  /** Gauge after the tick — the P-007 watchdog reads this trend. */
  endedUnarchivedRemaining: number;
  /** INVARIANT (EI-22126624550252124, fix direction 4): age of the OLDEST
   *  ended-but-unarchived row at SCAN TIME, or null when the scan set was empty.
   *
   *  `dbSkippedLive` says the liveness guard refused a pass THIS tick, which is
   *  the guard working and is expected. It cannot distinguish that from the one
   *  shape it must not hide: a row wrongly marked `ended` under a still-live
   *  owner, which is refused EVERY tick and so is never archived and never
   *  stamped. That row is invisible in a per-tick count — it looks identical to
   *  a different session being correctly protected each time — but it holds
   *  `ended_at` old while `archived_at` stays NULL, so its AGE is the signal.
   *
   *  Read as a scan-time observation, not a post-tick gauge: a row counted here
   *  may have been archived later in the same tick. Bounded by
   *  MAX_DB_ROWS_PER_TICK, but the query is ORDER BY ended_at ASC, so the oldest
   *  row is always in the window even when it truncates. */
  oldestEndedUnarchivedAgeMs: number | null;
  /** INVARIANT (EI-20419472483823685): codex home dirs examined for the
   *  "every codex home contains a config.toml" property. Deliberately NOT
   *  `diskDirsScanned` — that counter is filtered by the protected set, by
   *  `ids.length`, and by `dirBudget`, so it cannot see the case this exists
   *  to catch (WI-38706 hit a LIVE, protected home). See runCodexHomeConfigInvariant. */
  codexHomesScanned: number;
  /** Codex homes that exist but have NO config.toml — `codex resume` against
   *  one dies with "Model provider papercusp-codex-gateway not found". */
  codexHomesMissingConfig: number;
  /** The offending dirs (bounded), since the repair is mechanical from here. */
  codexHomesMissingConfigDirs: string[];
  /** Set when the invariant could NOT be evaluated. Without this, a sweep that
   *  threw reports `codexHomesMissingConfig: 0`, which is indistinguishable
   *  from "checked, all healthy" — the precise ambiguity that let WI-38706's
   *  damage sit unnoticed. Readers must treat a set value as UNKNOWN, not OK. */
  codexHomeInvariantError?: string;
  /** Set when the disk-side sweep was ABORTED before touching anything
   *  (fail-closed, mirrors session-dir-gc's degraded abort). */
  skippedDisk?: 'degraded-protected-set';
}

export interface ReconcilerDeps {
  db?: ReconcilerDb;
  store?: SessionArchiveStore;
  dirRoots?: SessionDirRoot[];
  ompRoot?: string;
  protectedIdentity?: ProtectedSessionIdentity;
  runAdvArchive?: (advSessionId: number) => Promise<ArchiveHookResult>;
  nowMs?: number;
}

async function dirents(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * INVARIANT SWEEP (EI-20419472483823685) — "every codex home dir contains a
 * config.toml". The recurrence guard for WI-38706's whole class: that bug
 * deleted the SHARED per-home config.toml, and while the CAUSE is fixed,
 * nothing DETECTED the damage — one home sat unresumable for up to ~4 days
 * and was found only because a human-directed census happened to run.
 *
 * ⚠ This deliberately walks the roots ITSELF instead of riding the archive
 * loop in runSessionArchiveReconcileOnce, even though that loop also visits
 * these dirs. That loop CANNOT see the failing case: it skips dirs in the
 * protected set, dirs with no archivable rollout ids, and anything past
 * `dirBudget` — and the home that actually broke was LIVE, hence protected,
 * hence skipped. Riding it would have produced a detector that misses exactly
 * what it exists to catch. Cost here is one stat() per home, no archive work.
 *
 * `missing` is the TRUE count and is NOT bounded by `limitNamed`, which caps
 * only the named list — a capped census rendered as a total is how a floor
 * gets read as a verdict.
 */
export async function runCodexHomeConfigInvariant(
  roots: SessionDirRoot[] = defaultSessionDirRoots(),
  limitNamed = 10,
): Promise<{ scanned: number; missing: number; missingDirs: string[] }> {
  let scanned = 0;
  const missing: string[] = [];
  for (const rootSpec of roots) {
    // config.toml is a CODEX home artifact; the claude/mcp owner dirs have none.
    if (rootSpec.keyKind !== 'session') continue;
    for (const d of await dirents(rootSpec.root)) {
      if (!d.isDirectory()) continue;
      const dirPath = join(rootSpec.root, d.name);
      scanned++;
      try {
        const st = await stat(join(dirPath, 'config.toml'));
        if (!st.isFile()) missing.push(dirPath);
      } catch {
        missing.push(dirPath); // ENOENT — the WI-38706 deletion signature
      }
    }
  }
  return { scanned, missing: missing.length, missingDirs: missing.slice(0, limitNamed) };
}

export async function runSessionArchiveReconcileOnce(deps: ReconcilerDeps = {}): Promise<ReconcileStats> {
  const db = deps.db ?? pgReconcilerDb();
  const store = deps.store ?? pgSessionArchiveStore();
  const nowMs = deps.nowMs ?? Date.now();
  // The protected set is gathered ONCE per tick and shared by BOTH sides: the
  // row-driven archive pass refuses a live owner with the same instrument the
  // disk sweep uses (EI-22126624550252124), so the two paths cannot disagree
  // about who is alive.
  const prot = deps.protectedIdentity ?? (await gatherProtectedSessionIdentity());
  const runAdv =
    deps.runAdvArchive ?? ((id: number) => runArchiveForAdvSession(id, { store, protectedIdentity: prot, nowMs }));
  const stats: ReconcileStats = {
    dbScanned: 0,
    dbArchived: 0,
    dbStampedEmpty: 0,
    dbSkippedLive: 0,
    dbFailed: 0,
    diskDirsScanned: 0,
    diskSessionsArchived: 0,
    diskLeftoversDeleted: 0,
    diskLeftoversRetained: 0,
    diskFailed: 0,
    diskSkippedFresh: 0,
    ompFilesArchived: 0,
    endedUnarchivedRemaining: 0,
    oldestEndedUnarchivedAgeMs: null,
    codexHomesScanned: 0,
    codexHomesMissingConfig: 0,
    codexHomesMissingConfigDirs: [],
  };

  // ── (a) DB-side: ended-but-unarchived adv rows ──────────────────────────
  const endedRows = await db.listEndedUnarchived(MAX_DB_ROWS_PER_TICK);
  // ORDER BY ended_at ASC (see pgReconcilerDb), so row 0 is the oldest even when
  // the window truncates at MAX_DB_ROWS_PER_TICK.
  if (endedRows.length > 0) stats.oldestEndedUnarchivedAgeMs = Math.max(0, nowMs - endedRows[0]!.endedAtMs);
  for (const row of endedRows) {
    if (stats.dbArchived >= MAX_DB_ARCHIVES_PER_TICK) break; // archive-work cap; stamps stay cheap
    stats.dbScanned++;
    try {
      const r = await runAdv(row.id);
      if (r.ok) {
        stats.dbArchived++; // runArchiveForAdvSession stamps adv via the store
      } else if (isLiveSkipReason(r.reason)) {
        // Live session under an 'ended' row — never stamp it out (that would
        // strand the transcript un-archived forever), never count it failed.
        stats.dbSkippedLive++;
      } else if (
        (r.reason === 'no_files' || r.reason === 'unresolvable' || r.reason === 'row_not_found') &&
        nowMs - row.endedAtMs > NOTHING_TO_ARCHIVE_GRACE_MS
      ) {
        await db.stampArchivedAt(row.id);
        stats.dbStampedEmpty++;
      } else if (!r.ok && r.reason !== 'no_files' && r.reason !== 'unresolvable') {
        stats.dbFailed++;
      }
    } catch (e) {
      stats.dbFailed++;
      console.warn(`[session-archive-reconciler] adv ${row.id}: ${(e as Error)?.message ?? e}`);
    }
  }

  // ── (b) disk-side: unprotected per-session dirs with un-archived files ──
  // FAIL CLOSED (WI-3859 F3, mirrors runSessionDirGc): the protected-set reads
  // fail OPEN per-source, so a degraded set is INCOMPLETE — sweeping against it
  // with a working archive PG would archive and DELETE a live session's files
  // mid-flight. Skip the whole disk side this tick; the next one sweeps.
  if (prot.degraded) {
    console.warn(
      '[session-archive-reconciler] protected-set read DEGRADED (presence/PG unavailable) — disk-side sweep SKIPPED, nothing touched',
    );
    stats.skippedDisk = 'degraded-protected-set';
  }
  let dirBudget = stats.skippedDisk ? 0 : MAX_DIRS_PER_TICK;
  for (const rootSpec of deps.dirRoots ?? defaultSessionDirRoots()) {
    if (dirBudget <= 0) break;
    const sourceKind = rootSpec.keyKind === 'owner' ? ('claude' as const) : ('codex' as const);
    for (const d of await dirents(rootSpec.root)) {
      if (dirBudget <= 0) break;
      if (!d.isDirectory()) continue;
      const key = sessionDirKey(d.name, rootSpec.keyKind);
      if (isProtected({ keyKind: rootSpec.keyKind, key }, prot)) continue;
      const dirPath = join(rootSpec.root, d.name);
      const ids =
        sourceKind === 'claude'
          ? await listClaudeSessionIds(dirPath)
          : await listCodexRolloutSessionIds(dirPath);
      if (!ids.length) continue; // nothing archivable — dir removal is session-dir-gc's job
      dirBudget--;
      stats.diskDirsScanned++;
      for (const sessionId of ids) {
        try {
          // Quiet grace (WI-3859 F5): a fresh mtime may be a LIVE session the
          // protected set cannot see (a raw/untracked resume has no adv row
          // and no presence). Only touch sessions whose files stopped changing.
          const collected = await collectSessionFiles({ sourceKind, sessionId, sessionRoot: dirPath });
          const newestMs = collected.reduce((mx, f) => Math.max(mx, f.mtimeMs), 0);
          if (collected.length && nowMs - newestMs < QUIET_FILE_GRACE_MS) {
            stats.diskSkippedFresh++;
            continue;
          }
          if (await store.readStamp(sourceKind, sessionId)) {
            const del = await deleteArchivedSessionFiles(
              { sourceKind, sessionId, sessionRoot: dirPath },
              store,
            );
            stats.diskLeftoversDeleted += del.deleted;
            stats.diskLeftoversRetained += del.retained.length;
            if (!del.ok && del.refused.length) {
              // bytes drifted since the stamp — re-archive fresh, then delete
              const r = await archiveAndDeleteSession(
                {
                  sourceKind,
                  sessionId,
                  sessionRoot: dirPath,
                  owner: sourceKind === 'claude' ? d.name : null,
                  advSessionId: sourceKind === 'codex' ? Number(key) || null : null,
                  archivedBy: 'reconciler',
                },
                store,
              );
              if (r.archive.ok) stats.diskSessionsArchived++;
            }
            continue;
          }
          const r = await archiveAndDeleteSession(
            {
              sourceKind,
              sessionId,
              sessionRoot: dirPath,
              owner: sourceKind === 'claude' ? d.name : null,
              advSessionId: sourceKind === 'codex' ? Number(key) || null : null,
              archivedBy: 'reconciler',
            },
            store,
          );
          if (r.archive.ok) stats.diskSessionsArchived++;
          else if (r.archive.reason !== 'no_files') stats.diskFailed++;
        } catch (e) {
          stats.diskFailed++;
          console.warn(
            `[session-archive-reconciler] ${sourceKind}/${sessionId} @ ${dirPath}: ${(e as Error)?.message ?? e}`,
          );
        }
      }
    }
  }

  // ── (b′) omp: flat transcripts, mtime-graced ────────────────────────────
  const ompRoot = deps.ompRoot ?? ompSessionsRoot();
  let ompBudget = MAX_OMP_FILES_PER_TICK;
  for (const d of await dirents(ompRoot)) {
    if (ompBudget <= 0) break;
    if (!d.isDirectory()) continue;
    for (const f of await dirents(join(ompRoot, d.name))) {
      if (ompBudget <= 0) break;
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const stem = f.name.slice(0, -'.jsonl'.length);
      const us = stem.indexOf('_');
      const sessionId = us >= 0 ? stem.slice(us + 1) : stem;
      try {
        const { lstat } = await import('node:fs/promises');
        const st = await lstat(join(ompRoot, d.name, f.name));
        if (!st.isFile() || nowMs - st.mtimeMs < OMP_FILE_GRACE_MS) continue;
        ompBudget--;
        if (await store.readStamp('omp', sessionId)) {
          const del = await deleteArchivedSessionFiles(
            { sourceKind: 'omp', sessionId, sessionRoot: ompRoot },
            store,
          );
          stats.diskLeftoversDeleted += del.deleted;
          stats.diskLeftoversRetained += del.retained.length;
          continue;
        }
        const r = await archiveAndDeleteSession(
          { sourceKind: 'omp', sessionId, sessionRoot: ompRoot, archivedBy: 'reconciler' },
          store,
        );
        if (r.archive.ok) stats.ompFilesArchived++;
      } catch (e) {
        stats.diskFailed++;
        console.warn(`[session-archive-reconciler] omp/${sessionId}: ${(e as Error)?.message ?? e}`);
      }
    }
  }

  try {
    stats.endedUnarchivedRemaining = await db.countEndedUnarchived();
  } catch {
    /* gauge is best-effort */
  }

  // ── (c) INVARIANT: every codex home has its config.toml (EI-20419472483823685)
  // Runs unconditionally — including when the disk sweep was skipped as
  // degraded — because it only READS and its whole value is being present on
  // the ticks where something else went wrong.
  try {
    const inv = await runCodexHomeConfigInvariant(deps.dirRoots ?? defaultSessionDirRoots());
    stats.codexHomesScanned = inv.scanned;
    stats.codexHomesMissingConfig = inv.missing;
    stats.codexHomesMissingConfigDirs = inv.missingDirs;
  } catch (e) {
    // Never let a read-only invariant fail the tick — but never let it report
    // a silent zero either (see codexHomeInvariantError).
    stats.codexHomeInvariantError = (e as Error)?.message ?? String(e);
  }
  return stats;
}
