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
 * `blob <len>\0<content>`, a different digest of different bytes — so each
 * candidate is re-hashed with sha256 over the raw blob.
 *
 * ── Cost — measure it, do not assume it ───────────────────────────────────
 * This is bounded (at most `maxCommits` revisions of one path, stopping at the
 * first match) but it is NOT cheap in aggregate, and the intuition that it is
 * turned out to be wrong by two orders of magnitude.
 *
 * The assumption was "it runs only for files whose raw hashes already differ,
 * which is ~one". Measured on this tree 2026-08-03: **68** files carry
 * byte-level drift, because a long-lived dev DB accumulates every edit ever
 * made to an already-applied migration. Classifying all of them costs
 * **8.5–10s** — one `git log` plus up to N `git show` subprocesses per file.
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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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

/** Revisions of a single migration file to walk before giving up. */
const DEFAULT_MAX_COMMITS = 200;
const DEFAULT_TIMEOUT_MS = 10_000;
/** A migration file is text and small; this is headroom, not a target. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export interface RecoverAppliedTextOptions {
  maxCommits?: number;
  timeoutMs?: number;
}

/**
 * A migration filename must be a bare `*.sql` leaf. Rejecting anything else
 * keeps a path traversal, a directory component, or a leading `-` (which git
 * could read as a flag) out of the argv below. `execFileSync` already runs
 * without a shell, so this is defence in depth rather than the only guard.
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
export function recoverAppliedMigrationText(
  sqlDir: string,
  filename: string,
  recordedSha256: string,
  opts: RecoverAppliedTextOptions = {},
): AppliedMigrationTextResult {
  if (!isSafeMigrationFilename(filename)) {
    return { ok: false, reason: `unsafe migration filename: ${JSON.stringify(filename)}` };
  }
  const recorded = recordedSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recorded)) {
    return { ok: false, reason: 'recorded sha256 is not a 64-hex digest' };
  }

  const maxCommits = opts.maxCommits ?? DEFAULT_MAX_COMMITS;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const git = (args: string[]): Buffer =>
    execFileSync('git', ['-C', sqlDir, ...args], {
      encoding: 'buffer',
      timeout,
      maxBuffer: MAX_BUFFER_BYTES,
      // Inherit nothing, and never let git prompt for credentials.
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

  let commits: string[];
  try {
    commits = git(['log', `--max-count=${maxCommits}`, '--pretty=%H', '--', `./${filename}`])
      .toString('utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    // No repo (packaged install), git absent, timeout, or an unreadable tree.
    return { ok: false, reason: `git log failed: ${(err as Error)?.message ?? 'unknown error'}` };
  }

  if (commits.length === 0) {
    return { ok: false, reason: 'the file has no git history in this tree' };
  }

  for (const commit of commits) {
    let blob: Buffer;
    try {
      blob = git(['show', `${commit}:./${filename}`]);
    } catch {
      // The path did not exist at that revision (a rename, or the commit that
      // deleted it) — not an error, just not a candidate.
      continue;
    }
    // Hash the raw bytes: the runner hashes the utf8 TEXT, and hashing the utf8
    // bytes of that same text yields the identical digest.
    if (createHash('sha256').update(blob).digest('hex') === recorded) {
      return { ok: true, text: blob.toString('utf8'), commit };
    }
  }

  return {
    ok: false,
    reason:
      `no blob in the last ${commits.length} commit(s) touching the file hashes to the recorded ` +
      `sha256 — the applied bytes were likely never committed (edited within the git-sync window)`,
  };
}
