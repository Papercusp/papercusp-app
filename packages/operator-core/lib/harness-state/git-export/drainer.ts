/**
 * Git-export drainer (plan harness-state-storage-unification-2026-06-01, P-003b).
 *
 * Reads undrained `git_export_outbox` rows for a (workspace, harness) and
 * projects each into a `.papercusp/state/<dir>/<key>.{md|json}` file (put) or
 * removes it (del), via the pure serialize module, then marks `exported_at`.
 * At-least-once: a row is marked exported ONLY after its file write resolves.
 *
 * Git COMMIT of the written files is intentionally NOT done here — pass an
 * `onChanged` hook (the boot wiring supplies a debounced committer) so this
 * module stays pure-IO + unit/integration testable without a git repo.
 */
import type postgres from 'postgres';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gitFilePath, hasRefreshStamps, isRefreshOnlyChange, serializeRow } from './serialize';
import { loadDerivedColumns, stripDerivedCols } from './derived-cols';

export interface DrainGitExportOpts {
  sql: postgres.Sql;
  workspaceId: string;
  harnessSlug: string;
  /** Absolute harness root (where `.papercusp/state/` lives). */
  harnessRoot: string;
  /** Max rows per drain. Default 500. */
  limit?: number;
  /** Called with the set of changed repo-relative paths after a successful drain. */
  onChanged?: (relPaths: string[]) => void | Promise<void>;
  /** Clock override (epoch ms) for the exported_at stamp — tests. */
  now?: number;
}

export interface GitExportResult {
  exported: number;
  deleted: number;
  /** Rows whose only change was a refresh stamp; marked exported, file left alone (WI-10003624). */
  unchanged: number;
  changedPaths: string[];
}

/** Drain one batch of git-export outbox rows for (workspace, harness). */
export async function drainGitExportOnce(opts: DrainGitExportOpts): Promise<GitExportResult> {
  const { sql, workspaceId, harnessSlug, harnessRoot, limit = 500 } = opts;
  const rows = await sql<
    { id: number; table_name: string; op: 'put' | 'del'; key: string; row: Record<string, unknown> | null }[]
  >`
    SELECT id, table_name, op, key, row
      FROM harness_shared.git_export_outbox
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND exported_at IS NULL
     ORDER BY id ASC
     LIMIT ${limit}`;

  let exported = 0;
  let deleted = 0;
  let unchanged = 0;
  const changedPaths: string[] = [];
  // EI-19900345996596896: never write a derived (vector) column into a git file — its
  // width tracks the embedding model, so a committed one breaks hydrate on every peer
  // the moment PROSE_VECTOR_DIMS moves. Memoised per drain pass, per table.
  const derivedByTable = new Map<string, Set<string>>();
  const derivedFor = async (table: string): Promise<Set<string>> => {
    let d = derivedByTable.get(table);
    if (!d) {
      d = await loadDerivedColumns(sql, table);
      derivedByTable.set(table, d);
    }
    return d;
  };

  for (const r of rows) {
    const rel = gitFilePath(r.table_name, r.key);
    const abs = join(harnessRoot, rel);
    if (r.op === 'del') {
      await rm(abs, { force: true });
      deleted += 1;
    } else {
      const row = stripDerivedCols(r.row ?? {}, await derivedFor(r.table_name));
      // WI-10003624: a re-UPSERT of an unchanged verdict that only moved its
      // refresh stamps must not rewrite (and so re-commit + re-announce) the file.
      if (hasRefreshStamps(r.table_name)) {
        const existing = await readFile(abs, 'utf8').catch(() => null);
        if (isRefreshOnlyChange(r.table_name, existing, row)) {
          unchanged += 1;
          await sql`UPDATE harness_shared.git_export_outbox SET exported_at = ${opts.now ?? Date.now()} WHERE id = ${r.id}`;
          continue;
        }
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, serializeRow(r.table_name, row), 'utf8');
      exported += 1;
    }
    changedPaths.push(rel);
    // mark exported ONLY after the file op resolved (at-least-once).
    const stamp = opts.now ?? Date.now();
    await sql`UPDATE harness_shared.git_export_outbox SET exported_at = ${stamp} WHERE id = ${r.id}`;
  }

  if (changedPaths.length > 0 && opts.onChanged) await opts.onChanged(changedPaths);
  return { exported, deleted, unchanged, changedPaths };
}

const GIT_EXPORT_NOTIFY = 'git_export_outbox';
const DEFAULT_GIT_POLL_MS = 5_000;

/**
 * EI-339: a permanently-failing drain target (e.g. a registry entry whose
 * harnessRoot is bogus — mkdir EACCES forever) used to retry at full poll
 * cadence and log every 5s, flooding the journal. Consecutive failures back
 * off exponentially (doubling from the poll cadence, capped at 10 min) and
 * log only on the first failure, on each doubling, and on recovery.
 */
export const DRAIN_BACKOFF_MAX_MS = 600_000;

/** Pure: backoff delay after `failures` consecutive drain errors (0 → none). */
export function drainBackoffMs(failures: number, baseMs: number, maxMs = DRAIN_BACKOFF_MAX_MS): number {
  if (failures <= 0) return 0;
  return Math.min(baseMs * 2 ** (failures - 1), maxMs);
}

/** Pure: log on the 1st failure and on each doubling (2, 4, 8, …) — not every retry. */
export function shouldLogDrainFailure(failures: number): boolean {
  return failures > 0 && (failures & (failures - 1)) === 0;
}

export interface StartGitExportDrainOpts extends DrainGitExportOpts {
  /** Poll-fallback cadence (ms). Default 5000. 0 disables the timer (tests). */
  pollMs?: number;
}

export interface GitExportDrainHandle {
  /** Stop the loop: clear the poll timer + close the LISTEN connection. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Start the per-harness git-export drain loop (mirrors `startOutboxDrain`):
 *   - an immediate catch-up drain (backlog from while the process was down);
 *   - a `LISTEN git_export_outbox` that drains when a NOTIFY payload matches
 *     this harness's `${workspaceId}::${harnessSlug}` (the capture trigger emits it);
 *   - a bounded poll-fallback timer (liveness if a NOTIFY is missed).
 *
 * Resilient: a drain error is logged, not fatal — the next NOTIFY/poll retries.
 * Drains are serialized + coalesced so passes can't overlap.
 */
export function startGitExportDrain(opts: StartGitExportDrainOpts): GitExportDrainHandle {
  const { sql, workspaceId, harnessSlug } = opts;
  const pollMs = Number.isFinite(opts.pollMs as number) ? (opts.pollMs as number) : DEFAULT_GIT_POLL_MS;
  const wantPayload = `${workspaceId}::${harnessSlug}`;

  let stopped = false;
  let draining = false;
  let runAgain = false;
  let consecutiveFailures = 0;
  let backoffUntil = 0;

  async function drainSafely(): Promise<void> {
    if (stopped) return;
    if (Date.now() < backoffUntil) return; // EI-339: in backoff after repeated failures
    if (draining) {
      runAgain = true;
      return;
    }
    draining = true;
    try {
      do {
        runAgain = false;
        await drainGitExportOnce(opts);
      } while (runAgain && !stopped);
      if (consecutiveFailures > 0) {
         
        console.log(
          `[git-export-drain] recovered for ${wantPayload} after ${consecutiveFailures} failure(s)`,
        );
      }
      consecutiveFailures = 0;
      backoffUntil = 0;
    } catch (e) {
      consecutiveFailures += 1;
      const delay = drainBackoffMs(consecutiveFailures, pollMs > 0 ? pollMs : DEFAULT_GIT_POLL_MS);
      backoffUntil = Date.now() + delay;
      if (shouldLogDrainFailure(consecutiveFailures)) {
         
        console.error(
          `[git-export-drain] drain failed for ${wantPayload} (failure #${consecutiveFailures}, next retry in ${Math.round(delay / 1000)}s):`,
          e instanceof Error ? e.message : String(e),
        );
      }
    } finally {
      draining = false;
    }
  }

  void drainSafely(); // immediate catch-up

  const listenReq = sql.listen(GIT_EXPORT_NOTIFY, (payload) => {
    if (stopped) return;
    if (payload === wantPayload) void drainSafely();
  });
  void Promise.resolve(listenReq).catch((e: unknown) => {
     
    console.error(
      `[git-export-drain] LISTEN setup failed for ${wantPayload}:`,
      e instanceof Error ? e.message : String(e),
    );
  });

  const pollTimer =
    pollMs > 0 ? managedSetInterval('git-export-drainer', pollMs, () => drainSafely(), { category: 'watchdog' }) : null;

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (pollTimer) {
        try {
          pollTimer.stop();
        } catch {
          // no-op
        }
      }
      try {
        const req = await listenReq;
        await req.unlisten();
      } catch {
        // no-op
      }
    },
  };
}
