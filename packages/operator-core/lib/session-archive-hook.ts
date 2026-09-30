/**
 * session-archive-hook.ts — the end-of-session FAST PATH
 * (plan session-db-archive-retire-dirs-2026-07-10 P-004).
 *
 * markAdvSessionEnded (adv-sessions.ts) fires scheduleArchiveForAdvSession(id)
 * fire-and-forget via dynamic import. After a short SETTLE delay (the CLI may
 * flush final transcript lines just after the end report — bootstrap-su's end
 * beacon arrives while the process is still exiting), the hook:
 *   1. resolves the adv row → a SessionArchiveRef (per-CLI session root),
 *   2. runs ingestFileNow on the session's transcript(s) so the session_turns
 *      recall INDEX has the tail before the file disappears,
 *   3. archiveAndDeleteSession — archive committed + sha-verified BEFORE any
 *      unlink; a post-archive write refuses deletion (left for the P-006
 *      reconciler to re-archive).
 *
 * Flag-gated by FLAGS.SESSION_ARCHIVE_AT_END (default ON; kill-switch). Fails
 * CLOSED on flag-system errors: skipping the fast path just means dirs
 * accumulate like the old world until the reconciler runs — never data loss.
 *
 * ⚠ LIVENESS GUARD (EI-22126624550252124 / WI-2140943). An adv row reading
 * `ended_at IS NOT NULL` is NOT proof the CLI is gone. A stale end-report can
 * land on a row that a carry-respawn / `claude --resume` successor has already
 * RE-STARTED on the same native session id — adv 22047 (da701a71), 2026-09-02:
 * resume-finalize reset started_at at 04:04:19Z, a stale `'self'` end landed at
 * 04:04:45Z, and this hook archived+DELETED the transcript at 04:05:00Z while
 * the CLI was still appending to it (the archived byte count GREW between the
 * two deletes: 734,384 → 949,887). The compaction watchdog and the death
 * detector both READ that jsonl, so every safety net went dark at once and the
 * session died at the context limit with no carry. The disk-side sweep already
 * refused such files (protected set + QUIET_FILE_GRACE_MS); this row-driven path
 * was the one archive path with no liveness check at all. It now refuses on any
 * of three independent signals — see {@link runArchiveForAdvSession}.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { codexHomeForSessionKey, sessionClaudeRoot } from '@papercusp/orchestrator/session-launch-dirs';
import { ompSessionsRoot } from './omp-sessions';
import { ompSessionsRootForSessionKey } from './session-transcript-resolvers';
import { ingestFileNow } from './search/session-ingest';
import {
  archiveAndDeleteSession,
  collectSessionFiles,
  isSessionKeyedRelpath,
  type ArchiveSessionResult,
  type DeleteArchivedResult,
  type SessionArchiveRef,
  type SessionArchiveStore,
} from './session-archive';
import { gatherProtectedSessionIdentity, isProtected, type ProtectedSessionIdentity } from './session-dir-gc';

/** Settle window between the end report and the archive pass. */
const SETTLE_DELAY_MS = 15_000;

/**
 * A session-keyed file modified within this window is treated as LIVE — a CLI
 * is appending to it, whatever the adv row says — and is neither archived nor
 * deleted this pass (EI-22126624550252124). The row stays in the reconciler's
 * scan set and is retried once the file goes quiet, so a real end costs at most
 * one grace of deferred disk hygiene; a wrongly-ended live session costs
 * nothing. Deliberately shorter than the disk sweep's QUIET_FILE_GRACE_MS: the
 * row path ALSO has the protected-set check, which is what covers a live CLI
 * idling longer than this between turns.
 */
export const LIVE_TRANSCRIPT_GRACE_MS = 10 * 60 * 1000;

export interface AdvRowForArchive {
  id: number;
  agent: string | null; // 'claude' | 'codex' | 'omp' | null
  mode: string; // 'omp' | 'console'
  cwd: string | null;
  coord_owner_id: string | null;
  session_id: string | null; // native CLI uuid
  omp_thread_id?: string | null; // OMP writes its native identity here
  /** Re-read at PASS time, not schedule time: `null` means a successor re-opened
   *  the row since the end was reported (→ `row_reopened`). `undefined` = the
   *  caller did not load it (legacy/test rows) — no verdict from this signal. */
  ended_at?: Date | string | null;
}

/** Reasons that mean "the session looked LIVE — nothing was touched; retry
 *  once it is quiet". The reconciler counts these separately from failures and
 *  never stamps such a row out of its scan set. */
export const LIVE_SKIP_REASONS = ['row_reopened', 'transcript_fresh', 'owner_live'] as const;
export type LiveSkipReason = (typeof LIVE_SKIP_REASONS)[number];
export function isLiveSkipReason(reason: unknown): reason is LiveSkipReason {
  return (LIVE_SKIP_REASONS as readonly unknown[]).includes(reason);
}

export interface ArchiveRoots {
  /** ~/.papercusp/session-claude — per-owner CLAUDE_CONFIG_DIRs live under it. */
  claudeSessionRoot: string;
  codexHomeFor: (advSessionId: number) => string;
  ompRoot: string;
  /** Tracked OMP launches isolate their transcripts by adv-session id. */
  ompRootFor?: (advSessionId: number) => string;
}

export function defaultArchiveRoots(): ArchiveRoots {
  return {
    claudeSessionRoot: sessionClaudeRoot(),
    codexHomeFor: (id) => codexHomeForSessionKey(id),
    ompRoot: ompSessionsRoot(),
    ompRootFor: (id) => {
      const tracked = ompSessionsRootForSessionKey(id);
      return existsSync(tracked) ? tracked : ompSessionsRoot();
    },
  };
}

/** Pure resolver: adv row → archive ref (null = not resolvable; the disk-side
 *  reconciler sweep is the catch-all for those). */
export function resolveArchiveRefForAdvRow(
  row: AdvRowForArchive,
  roots: ArchiveRoots,
): SessionArchiveRef | null {
  const agent = row.agent ?? (row.mode === 'omp' ? 'omp' : null);
  const nativeId = agent === 'omp' ? row.omp_thread_id ?? row.session_id : row.session_id;
  if (!nativeId) return null;
  const base = {
    sessionId: nativeId,
    owner: row.coord_owner_id,
    cwd: row.cwd,
    advSessionId: row.id,
    archivedBy: 'exit-hook' as const,
  };
  switch (agent) {
    case 'claude':
      if (!row.coord_owner_id) return null;
      return { ...base, sourceKind: 'claude', sessionRoot: join(roots.claudeSessionRoot, row.coord_owner_id) };
    case 'codex':
      return { ...base, sourceKind: 'codex', sessionRoot: roots.codexHomeFor(row.id) };
    case 'omp':
      return { ...base, sourceKind: 'omp', sessionRoot: roots.ompRootFor?.(row.id) ?? roots.ompRoot };
    default:
      return null;
  }
}

export interface ArchiveHookDeps {
  loadRow?: (advSessionId: number) => Promise<AdvRowForArchive | null>;
  roots?: ArchiveRoots;
  store?: SessionArchiveStore;
  ingestFile?: (filePath: string) => Promise<unknown>;
  /** The live/resumable identity set (the SAME instrument the disk sweep uses).
   *  Omitted ⇒ gathered per pass; the reconciler passes its per-tick set. */
  protectedIdentity?: ProtectedSessionIdentity;
  /** Clock for the mtime grace — injected so the boundary is testable. */
  nowMs?: number;
}

async function loadAdvRow(advSessionId: number): Promise<AdvRowForArchive | null> {
  const { sql } = getOrgPg();
  const rows = await sql<AdvRowForArchive[]>`
    SELECT id, agent, mode, cwd, coord_owner_id, session_id, omp_thread_id, ended_at
      FROM harness_shared.adv_sessions
     WHERE id = ${advSessionId}`;
  return rows[0] ?? null;
}

export interface ArchiveHookResult {
  ok: boolean;
  reason?: 'row_not_found' | 'unresolvable' | LiveSkipReason | ArchiveSessionResult['reason'];
  archive?: ArchiveSessionResult;
  delete?: DeleteArchivedResult;
  /** Set on a live-skip: the evidence behind the refusal (log/checkpoint-ready). */
  liveEvidence?: string;
}

/**
 * The liveness verdict for a row-driven archive pass — PURE given its inputs so
 * the boundary is unit-tested. Returns null when the session may be archived.
 * Three independent signals, any one of which refuses the pass:
 *   1. `row_reopened` — the adv row is no longer ended (a successor re-opened
 *      it between the end report and this pass);
 *   2. `transcript_fresh` — the newest session-keyed file changed within
 *      {@link LIVE_TRANSCRIPT_GRACE_MS} (a CLI is appending, whatever the row says);
 *   3. `owner_live` — the row's owner (claude) / adv id (codex) is in the
 *      protected set: live presence, an open adv row, or a pending wake. A
 *      DEGRADED set is INCOMPLETE and counts as protected (fail closed, exactly
 *      like the disk sweep's `skippedDisk`).
 */
export function assessArchiveLiveness(input: {
  row: Pick<AdvRowForArchive, 'id' | 'coord_owner_id' | 'ended_at'>;
  ref: Pick<SessionArchiveRef, 'sourceKind' | 'sessionId'>;
  files: ReadonlyArray<{ rel: string; mtimeMs: number }>;
  protectedIdentity: ProtectedSessionIdentity;
  nowMs: number;
  graceMs?: number;
}): { reason: LiveSkipReason; evidence: string } | null {
  const { row, ref, files, protectedIdentity: prot, nowMs } = input;
  const graceMs = input.graceMs ?? LIVE_TRANSCRIPT_GRACE_MS;
  if (row.ended_at === null) {
    return { reason: 'row_reopened', evidence: `adv ${row.id} ended_at is NULL at pass time (re-opened since the end report)` };
  }
  let newestMs = 0;
  let newestRel: string | null = null;
  for (const f of files) {
    if (!isSessionKeyedRelpath(ref.sessionId, f.rel)) continue;
    if (f.mtimeMs > newestMs) {
      newestMs = f.mtimeMs;
      newestRel = f.rel;
    }
  }
  if (newestRel && nowMs - newestMs < graceMs) {
    return {
      reason: 'transcript_fresh',
      evidence: `${newestRel} modified ${Math.round((nowMs - newestMs) / 1000)}s ago (< ${Math.round(graceMs / 1000)}s grace)`,
    };
  }
  if (prot.degraded) {
    return { reason: 'owner_live', evidence: 'protected-set read DEGRADED — treated as protected (fail closed)' };
  }
  const candidate =
    ref.sourceKind === 'codex'
      ? { keyKind: 'session' as const, key: String(row.id) }
      : row.coord_owner_id
        ? { keyKind: 'owner' as const, key: row.coord_owner_id }
        : null;
  if (candidate && isProtected(candidate, prot)) {
    return { reason: 'owner_live', evidence: `${candidate.keyKind} ${candidate.key} is in the protected set (live presence / open adv row / pending wake)` };
  }
  return null;
}

/** The actual pass — exported with injectable deps for tests + the P-006
 *  reconciler (which calls it directly, no settle timer). */
export async function runArchiveForAdvSession(
  advSessionId: number,
  deps: ArchiveHookDeps = {},
): Promise<ArchiveHookResult> {
  const row = await (deps.loadRow ?? loadAdvRow)(advSessionId);
  if (!row) return { ok: false, reason: 'row_not_found' };
  const ref = resolveArchiveRefForAdvRow(row, deps.roots ?? defaultArchiveRoots());
  if (!ref) {
    console.warn(
      `[session-archive] adv ${advSessionId} not resolvable (agent=${row.agent}, owner=${row.coord_owner_id}, native=${row.session_id}, omp=${row.omp_thread_id ?? null}) — left for the disk-side reconciler`,
    );
    return { ok: false, reason: 'unresolvable' };
  }
  // LIVENESS GUARD — before the ingest, before the archive, before the unlink.
  // Cheap (one stat per file + the protected-set read the disk sweep already
  // pays) and it is the ONLY thing standing between a stale end-report and the
  // deletion of a transcript a live CLI is appending to. See the module header.
  let collected: Awaited<ReturnType<typeof collectSessionFiles>> = [];
  try {
    collected = await collectSessionFiles(ref);
  } catch (e) {
    console.warn(`[session-archive] adv ${advSessionId} file enumeration failed: ${(e as Error)?.message ?? e}`);
  }
  const prot = deps.protectedIdentity ?? (await gatherProtectedSessionIdentity());
  const live = assessArchiveLiveness({ row, ref, files: collected, protectedIdentity: prot, nowMs: deps.nowMs ?? Date.now() });
  if (live) {
    console.log(
      `[session-archive] adv ${advSessionId} (${ref.sourceKind}/${ref.sessionId}) looks LIVE — nothing touched (${live.reason}: ${live.evidence}); retried once quiet`,
    );
    return { ok: false, reason: live.reason, liveEvidence: live.evidence };
  }
  // Final ingest: the recall index gets the transcript tail BEFORE the file
  // is deleted. Best-effort per file — an ingest failure never blocks archival
  // (the archive itself preserves the bytes the index missed).
  const ingest = deps.ingestFile ?? ingestFileNow;
  try {
    for (const f of collected) {
      if (!f.rel.endsWith('.jsonl')) continue;
      try {
        await ingest(f.abs);
      } catch (e) {
        console.warn(`[session-archive] final ingest failed for ${f.rel}: ${(e as Error)?.message ?? e}`);
      }
    }
  } catch (e) {
    console.warn(`[session-archive] final-ingest enumeration failed: ${(e as Error)?.message ?? e}`);
  }
  const r = deps.store
    ? await archiveAndDeleteSession(ref, deps.store)
    : await archiveAndDeleteSession(ref);
  if (!r.archive.ok) {
    // 'no_files' is normal for --no-session-persistence / already-archived
    // sessions (D-004); anything else deserves a visible line.
    if (r.archive.reason !== 'no_files') {
      console.warn(`[session-archive] adv ${advSessionId} archive failed: ${r.archive.reason}`);
    }
    return { ok: false, reason: r.archive.reason, archive: r.archive };
  }
  if (r.delete && !r.delete.ok) {
    console.warn(
      `[session-archive] adv ${advSessionId} archived but ${r.delete.refused.length} file(s) refused deletion (post-archive writes) — reconciler will re-archive`,
    );
  } else {
    console.log(
      `[session-archive] adv ${advSessionId} (${ref.sourceKind}/${ref.sessionId}): archived ${r.archive.fileCount} file(s), ${r.archive.bytesRaw}B → ${r.archive.bytesStored}B, deleted ${r.delete?.deleted ?? 0}`,
    );
  }
  return { ok: true, archive: r.archive, delete: r.delete };
}

/** The markAdvSessionEnded entry point: flag-gate, settle, run. */
export async function scheduleArchiveForAdvSession(
  advSessionId: number,
  opts?: { delayMs?: number },
): Promise<{ stop(): Promise<void> } | null> {
  const enabled = await getFlag(FLAGS.SESSION_ARCHIVE_AT_END, 'system').catch(() => false);
  if (!enabled) return null;
  let running: Promise<unknown> | undefined;
  const t = setTimeout(() => {
    running = runArchiveForAdvSession(advSessionId).catch((e) =>
      console.warn(`[session-archive] adv ${advSessionId} pass failed: ${(e as Error)?.message ?? e}`),
    );
  }, opts?.delayMs ?? SETTLE_DELAY_MS);
  t.unref?.();
  return { async stop() { clearTimeout(t); await running; } };
}
