/**
 * EI-19408574209859155: recover the EXACT TEXT an already-applied migration had
 * when it ran, so a content-drift entry can be classified instead of merely
 * reported.
 *
 * ── Why this has to go through git ─────────────────────────────────────────
 * `harness_shared.schema_migrations` has three columns — `filename`,
 * `applied_at`, `sha256`. The applied BYTES are not stored anywhere in the
 * database, only their hash. So there is no "recorded text" to strip comments
 * from and no stripped-recorded-hash to compare against; a
 * normalize-both-sides approach needs a "before" that the DB simply does not
 * have.
 *
 * The migration file is version-controlled, though, so the applied text still
 * exists as a historical git blob. Walk the file's history, sha256 each
 * version the same way the runner does, and the one matching `recordedSha256`
 * IS the text that ran. Verified against the live 727 case: commit
 * `e786f739` holds a blob hashing to exactly the recorded
 * `8ff1ba2ee1caf89a…`.
 *
 * Note git's own blob id cannot be used for the match — it is SHA-1 over
 * `blob <len>\0<content>`, a different digest — so each candidate's UTF-8 SQL
 * text is re-hashed with sha256, matching the migration runner's text hash.
 *
 * ── Cost — measure it, do not assume it ───────────────────────────────────
 * This is bounded (at most `maxCommits` revisions of one path, stopping at the
 * first match) but it is NOT cheap in aggregate, and the intuition that it is
 * turned out to be wrong by two orders of magnitude.
 *
 * The assumption was "it runs only for files whose raw hashes already differ,
 * which is ~one". Measured on this tree 2026-08-03: **68** files carry
 * byte-level drift, because a long-lived dev DB accumulates edits to
 * already-applied migrations. The original per-file `git log` plus repeated
 * `git show` path cost **8.5–10s**. The current caller batches files by history
 * depth and keeps a bounded cache of successful content-addressed results.
 *
 * That is why `checkMigrationDrift` gates this behind `classifyContent`
 * (default OFF). Boot, system-health and the watchdog all call it and none of
 * them read `contentDrift`; only `db:check_drift` opts in.
 *
 * ── Failure is never silent ───────────────────────────────────────────────
 * Every failure path returns `{ ok: false, reason }` and the caller reports
 * drift. That matters most on a packaged/headless install with no git repo at
 * all, where recovery is impossible by construction: the correct outcome there
 * is today's behavior (report the drift), never "no difference found".
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runGitBatch, type GitBatchCommand } from './git-batch';

/** The applied text, recovered from the git blob whose sha256 matches. */
export interface AppliedMigrationTextOk {
  ok: true;
  text: string;
  /** The commit whose blob matched — cited in the classification detail so a
   *  reader can re-derive the verdict by hand. */
  commit: string;
}

export interface AppliedMigrationTextFail {
  ok: false;
  reason: string;
}

export type AppliedMigrationTextResult = AppliedMigrationTextOk | AppliedMigrationTextFail;

export interface AppliedMigrationTextRequest {
  filename: string;
  recordedSha256: string;
}

/** Revisions of a single migration file to walk before giving up. */
const DEFAULT_MAX_COMMITS = 200;
const DEFAULT_TIMEOUT_MS = 10_000;
/** A migration file is text and small; this is headroom, not a target. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/** Keep positive content-addressed recoveries useful without retaining an unbounded corpus. */
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

interface CachedAppliedText {
  text: string;
  commit: string;
  /** Zero-based position in `git log`; smaller maxCommits values must still miss. */
  commitIndex: number;
  estimatedBytes: number;
}

interface PendingRecovery {
  key: string;
  filename: string;
  recordedSha256: string;
  resultIndexes: number[];
  resolved: boolean;
}

interface FileRecovery {
  filename: string;
  requests: PendingRecovery[];
  commits: string[];
  failure: string | null;
}

const recoveredTextCache = new Map<string, CachedAppliedText>();
let recoveredTextCacheBytes = 0;

function cacheKey(sqlDir: string, filename: string, recordedSha256: string): string {
  return JSON.stringify([path.resolve(sqlDir), filename, recordedSha256]);
}

function getCachedAppliedText(key: string, maxCommits: number): AppliedMigrationTextOk | undefined {
  const cached = recoveredTextCache.get(key);
  if (!cached || cached.commitIndex >= maxCommits) return undefined;

  // Map insertion order is the LRU order.
  recoveredTextCache.delete(key);
  recoveredTextCache.set(key, cached);
  return { ok: true, text: cached.text, commit: cached.commit };
}

function cacheAppliedText(key: string, value: Omit<CachedAppliedText, 'estimatedBytes'>): void {
  const estimatedBytes = value.text.length * 2 + key.length * 2 + value.commit.length * 2;
  if (estimatedBytes > MAX_CACHE_BYTES) return;

  const existing = recoveredTextCache.get(key);
  if (existing) {
    recoveredTextCacheBytes -= existing.estimatedBytes;
    recoveredTextCache.delete(key);
  }
  const cached = { ...value, estimatedBytes };
  recoveredTextCache.set(key, cached);
  recoveredTextCacheBytes += estimatedBytes;

  while (recoveredTextCacheBytes > MAX_CACHE_BYTES) {
    const oldestKey = recoveredTextCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = recoveredTextCache.get(oldestKey);
    recoveredTextCache.delete(oldestKey);
    if (oldest) recoveredTextCacheBytes -= oldest.estimatedBytes;
  }
}

export interface RecoverAppliedTextOptions {
  maxCommits?: number;
  timeoutMs?: number;
  /** Optional whole-recovery budget, used by the bounded drift classifier. */
  budgetMs?: number;
}

/**
 * A migration filename must be a bare `*.sql` leaf. Rejecting anything else
 * keeps a path traversal, a directory component, or a leading `-` (which git
 * could read as a flag) out of the argv below. `runGitBatch` passes every
 * value through argv, so this is defence in depth rather than the only guard.
 */
function isSafeMigrationFilename(filename: string): boolean {
  return (
    filename.length > 0 &&
    filename.endsWith('.sql') &&
    !filename.startsWith('-') &&
    !filename.includes('/') &&
    !filename.includes('\\') &&
    !filename.includes('\0')
  );
}

/**
 * Find the historical version of `filename` whose sha256 equals
 * `recordedSha256` — i.e. the exact bytes that were applied.
 *
 * `sqlDir` is used as git's working directory, so the `./<filename>` pathspec
 * resolves relative to it. This matters here: migrations live inside the
 * `libs/papercusp` SUBMODULE, and `git -C <sqlDir>` correctly resolves that
 * submodule's own repository rather than the superproject.
 */
export async function recoverAppliedMigrationTexts(
  sqlDir: string,
  requests: readonly AppliedMigrationTextRequest[],
  opts: RecoverAppliedTextOptions = {},
): Promise<AppliedMigrationTextResult[]> {
  if (requests.length === 0) return [];
  const maxCommits = opts.maxCommits ?? DEFAULT_MAX_COMMITS;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: Array<AppliedMigrationTextResult | undefined> = Array(requests.length);
  const pendingByKey = new Map<string, PendingRecovery>();
  const batchStartedAt = Date.now();

  for (const [resultIndex, request] of requests.entries()) {
    if (!isSafeMigrationFilename(request.filename)) {
      results[resultIndex] = {
        ok: false,
        reason: `unsafe migration filename: ${JSON.stringify(request.filename)}`,
      };
      continue;
    }

    const recordedSha256 = request.recordedSha256.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(recordedSha256)) {
      results[resultIndex] = { ok: false, reason: 'recorded sha256 is not a 64-hex digest' };
      continue;
    }

    const key = cacheKey(sqlDir, request.filename, recordedSha256);
    const cached = getCachedAppliedText(key, maxCommits);
    if (cached) {
      results[resultIndex] = cached;
      continue;
    }

    let pending = pendingByKey.get(key);
    if (!pending) {
      pending = {
        key,
        filename: request.filename,
        recordedSha256,
        resultIndexes: [],
        resolved: false,
      };
      pendingByKey.set(key, pending);
    }
    pending.resultIndexes.push(resultIndex);
  }

  if (pendingByKey.size > 0) {
    const filesByName = new Map<string, FileRecovery>();
    for (const pending of pendingByKey.values()) {
      let file = filesByName.get(pending.filename);
      if (!file) {
        file = { filename: pending.filename, requests: [], commits: [], failure: null };
        filesByName.set(pending.filename, file);
      }
      file.requests.push(pending);
    }
    const files = [...filesByName.values()];

    const runBatch = async (commands: readonly GitBatchCommand[]) => {
      if (commands.length === 0) return [];
      const remaining =
        opts.budgetMs === undefined ? timeout : opts.budgetMs - (Date.now() - batchStartedAt);
      if (remaining <= 0) return commands.map(() => null);
      try {
        return await runGitBatch(commands, {
          timeoutMs: Math.min(timeout, remaining),
          maxBuffer: MAX_BUFFER_BYTES,
          label: 'migration-applied-text',
        });
      } catch {
        // An incomplete batch is unknown, never an empty history or a match.
        return commands.map(() => null);
      }
    };

    const logCommands: GitBatchCommand[] = files.map((file) => ({
      repo: sqlDir,
      args: ['log', `--max-count=${maxCommits}`, '--pretty=%H', '--', `./${file.filename}`],
    }));
    const logResults = await runBatch(logCommands);
    files.forEach((file, i) => {
      const log = logResults[i];
      if (!log) {
        file.failure = 'git log batch did not complete before its timeout or recovery budget';
      } else if (log.code !== 0) {
        file.failure = `git log failed: ${log.stderr.trim() || `exit status ${log.code}`}`;
      } else {
        file.commits = log.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        if (file.commits.length === 0) file.failure = 'the file has no git history in this tree';
      }
    });

    for (let commitIndex = 0; commitIndex < maxCommits; commitIndex += 1) {
      const activeFiles = files.filter(
        (file) =>
          !file.failure &&
          commitIndex < file.commits.length &&
          file.requests.some((pending) => !pending.resolved),
      );
      if (activeFiles.length === 0) break;

      // Walk the same history depth for all files in one helper, so one node-host
      // fork handles each layer rather than one fork per migration.
      const showCommands: GitBatchCommand[] = activeFiles.map((file) => ({
        repo: sqlDir,
        args: ['show', `${file.commits[commitIndex]}:./${file.filename}`],
      }));
      const showResults = await runBatch(showCommands);
      activeFiles.forEach((file, i) => {
        const show = showResults[i];
        const unresolved = file.requests.filter((pending) => !pending.resolved);
        if (!show) {
          file.failure = 'git show batch did not complete before its timeout or recovery budget';
          return;
        }
        if (show.code !== 0) {
          // A migration may not exist at an intervening revision (for example,
          // a rename); just as before, keep walking older commits.
          return;
        }

        const blob = show.stdout;
        const digest = createHash('sha256').update(blob, 'utf8').digest('hex');
        for (const pending of unresolved) {
          if (pending.recordedSha256 !== digest) continue;
          const commit = file.commits[commitIndex]!;
          const recovered = { ok: true as const, text: blob, commit };
          cacheAppliedText(pending.key, { ...recovered, commitIndex });
          pending.resolved = true;
          for (const resultIndex of pending.resultIndexes) results[resultIndex] = recovered;
        }
      });
    }

    for (const file of files) {
      for (const pending of file.requests) {
        if (pending.resolved) continue;
        const failure: AppliedMigrationTextFail = file.failure
          ? { ok: false, reason: file.failure }
          : {
              ok: false,
              reason:
                `no blob in the last ${file.commits.length} commit(s) touching the file hashes to the recorded ` +
                `sha256 — the applied bytes were likely never committed (edited within the git-sync window)`,
            };
        for (const resultIndex of pending.resultIndexes) results[resultIndex] = failure;
      }
    }
  }

  return results.map((result) => result ?? { ok: false, reason: 'migration history batch omitted a result' });
}

export async function recoverAppliedMigrationText(
  sqlDir: string,
  filename: string,
  recordedSha256: string,
  opts: RecoverAppliedTextOptions = {},
): Promise<AppliedMigrationTextResult> {
  const [result] = await recoverAppliedMigrationTexts(sqlDir, [{ filename, recordedSha256 }], opts);
  return result ?? { ok: false, reason: 'migration history batch omitted a result' };
}
