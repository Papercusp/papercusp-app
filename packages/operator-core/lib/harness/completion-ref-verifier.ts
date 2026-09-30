/**
 * completion-ref-verifier — Phase 2 P-016 of papercusp-dogfood-v5.
 *
 * Background daemon that polls every harness's `completion_ref`-tagged
 * features against the remote (via `git ls-remote`) and stamps a
 * verification timestamp. Source of truth for the tier-B ✓ badge per
 * §17 / D-030.
 *
 * Design notes
 * ────────────
 *
 *  - No GitHub API: `git ls-remote <remote-url> <sha>` uses git's
 *    native auth (credential helper / SSH agent) and connection pool.
 *    No rate-limit risk, no PAT plumbing.
 *
 *  - Divergence signal lives on the feature row (`verifier_last_error`),
 *    NOT in `harness_escalations`. The latter is a per-(slug, phase)
 *    file-mirror — wrong shape for a per-feature signal. The
 *    FeatureDetail UI (P-017) reads `verifier_last_error` directly
 *    and renders a ⚠ warning card.
 *
 *  - Dependency injection on `runGitLsRemote` lets tests stub the
 *    network without spawning real git or mocking child_process.
 *
 *  - Cadence: 60s default. Per-feature exponential backoff on
 *    consecutive network errors, capped at 5 min (P-016c). After 5
 *    consecutive errors a warning toast is written once. The backoff
 *    state resets as soon as a feature verifies cleanly or diverges.
 *
 *  - Recency cutoff for shipped features: 24h. Long-tail divergence
 *    is rare and an explicit "Re-check" button covers it (P-017c).
 *    Q-2 (7d vs 24h) resolved to 24h to match P-016d spec; revise if
 *    real dogfood shows late-divergence is a real problem.
 *
 *  - Network errors don't poison the row: they bump
 *    `verifier_last_checked_at` so the daemon knows it tried, but
 *    leave `verifier_last_error` untouched (so we don't false-positive
 *    a transient outage as divergence).
 */

import { spawn } from 'node:child_process';
import { getOrgPg, generated } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { notifySyncInvalidate } from '../sync-sse';

export type CompletionRef = {
  remote: string;
  branch: string;
  commit_sha: string;
  pr_url?: string;
  pr_number?: number;
};

export type GitLsRemoteResult =
  | { kind: 'found'; sha: string }
  | { kind: 'not_found' }
  | { kind: 'error'; reason: string };

export type RunGitLsRemote = (
  remote: string,
  sha: string,
  opts?: { timeoutMs?: number },
) => Promise<GitLsRemoteResult>;

export type VerificationOutcome = 'verified' | 'divergent' | 'error';

export type VerificationResult = {
  harnessSlug: string;
  checked: number;
  verified: number;
  divergent: number;
  errors: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const SHIPPED_RECENCY_HOURS = 24;
const SHIPPED_RECENCY_MS = SHIPPED_RECENCY_HOURS * 60 * 60 * 1000;

/** P-016c: backoff cap and toast threshold */
const BACKOFF_CAP_MS = 5 * 60 * 1000;
const TOAST_AFTER_N_ERRORS = 5;

type BackoffEntry = {
  consecutiveErrors: number;
  nextCheckAt: number;
  toastedAt: number | null;
};

type BackoffSingleton = { __completionRefBackoff?: Map<string, BackoffEntry> };
const _bg = globalThis as unknown as BackoffSingleton;
function backoffMap(): Map<string, BackoffEntry> {
  _bg.__completionRefBackoff ??= new Map();
  return _bg.__completionRefBackoff;
}

function backoffKey(harnessSlug: string, featureId: string): string {
  return `${harnessSlug}\0${featureId}`;
}

function backoffDelayMs(consecutiveErrors: number): number {
  return Math.min(DEFAULT_POLL_INTERVAL_MS * Math.pow(2, consecutiveErrors - 1), BACKOFF_CAP_MS);
}

function shouldSkipFeature(harnessSlug: string, featureId: string): boolean {
  const entry = backoffMap().get(backoffKey(harnessSlug, featureId));
  if (!entry) return false;
  return Date.now() < entry.nextCheckAt;
}

function recordNetworkError(harnessSlug: string, featureId: string): BackoffEntry {
  const key = backoffKey(harnessSlug, featureId);
  const prev = backoffMap().get(key);
  const count = (prev?.consecutiveErrors ?? 0) + 1;
  const entry: BackoffEntry = {
    consecutiveErrors: count,
    nextCheckAt: Date.now() + backoffDelayMs(count),
    toastedAt: prev?.toastedAt ?? null,
  };
  backoffMap().set(key, entry);
  return entry;
}

function clearBackoffEntry(harnessSlug: string, featureId: string): void {
  backoffMap().delete(backoffKey(harnessSlug, featureId));
}

async function writeVerifierWarningToast(
  harnessSlug: string,
  featureId: string,
  lastReason: string,
  count: number,
): Promise<void> {
  try {
    const tl = generated.toastLogInHarnessShared;
    const { db } = getOrgPg();
    const RING_BUFFER_SIZE = 2000;
    await db.insert(tl).values({
      level: 'warning',
      message: `Completion ref verification failing — ${featureId}`,
      description: `git ls-remote has failed ${count} consecutive times for ${harnessSlug}/${featureId}. Last error: ${lastReason}. Check git credentials and the remote URL on the feature's completion_ref.`,
      harnessSlug,
      createdAt: Date.now(),
      actionLabel: null,
      actionHref: null,
    });
    void (async () => {
      const stale = await db.select({ id: tl.id }).from(tl).orderBy(desc(tl.createdAt)).offset(RING_BUFFER_SIZE);
      if (stale.length > 0) {
        await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
      }
    })().catch(() => {});
    void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
  } catch {
    // toast failure is non-fatal
  }
}

/**
 * Parse the stdout of `git ls-remote <remote> <sha>`. The command
 * prints one line per matching ref: "<sha>\t<refname>". If the
 * sha doesn't exist on the remote, the output is empty.
 *
 * Exported for testing — the parse rule is the part that's worth
 * pinning behavior on.
 */
export function parseLsRemoteOutput(
  stdout: string,
  expectedSha: string,
): GitLsRemoteResult {
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(expectedSha)) {
      return { kind: 'found', sha: expectedSha };
    }
  }
  return { kind: 'not_found' };
}

/**
 * Decide what to do with a single feature row given the git result.
 * Pure function — the SQL-writing layer maps the outcome to columns.
 *
 * Exported for testing — the decision table is small but the rule
 * "network errors don't write divergence" is load-bearing.
 */
export function decideVerificationOutcome(
  result: GitLsRemoteResult,
): VerificationOutcome {
  if (result.kind === 'found') return 'verified';
  if (result.kind === 'not_found') return 'divergent';
  return 'error';
}

/**
 * Default `git ls-remote` runner. Spawns the system git binary. Uses
 * git's native auth (no env-var fiddling). Resolves with a parsed
 * GitLsRemoteResult; never rejects.
 */
export const defaultRunGitLsRemote: RunGitLsRemote = (remote, sha, opts = {}) =>
  new Promise<GitLsRemoteResult>((resolve) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const proc = spawn('git', ['ls-remote', remote, sha], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      resolve({ kind: 'error', reason: err.message });
    });
    proc.on('close', (code, signal) => {
      if (signal !== null) {
        resolve({ kind: 'error', reason: 'signal ' + signal });
        return;
      }
      if (code !== 0) {
        const reason = stderr.trim() || 'exit ' + String(code);
        resolve({ kind: 'error', reason });
        return;
      }
      resolve(parseLsRemoteOutput(stdout, sha));
    });
  });

type FeatureRow = {
  feature_id: string;
  completion_ref: CompletionRef;
};

/**
 * Fetch the per-harness feature rows that need verification:
 *  - any pending_done with a completion_ref, regardless of age
 *  - any shipped with a completion_ref updated within 24h
 */
async function selectVerifiableFeatures(
  harnessSlug: string,
  getPg: typeof getOrgPg = getOrgPg,
): Promise<FeatureRow[]> {
  const { sql } = getPg();
  const recencyCutoffMs = Date.now() - SHIPPED_RECENCY_MS;
  return sql<FeatureRow[]>`
    SELECT feature_id, completion_ref
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${harnessSlug}
       AND completion_ref IS NOT NULL
       AND (
         status = 'pending_done'
         OR (status = 'shipped' AND COALESCE(updated_ts, 0) > ${recencyCutoffMs})
       )
  `;
}

async function applyOutcomeToRow(
  harnessSlug: string,
  featureId: string,
  outcome: VerificationOutcome,
  getPg: typeof getOrgPg = getOrgPg,
): Promise<void> {
  const { sql } = getPg();
  if (outcome === 'verified') {
    await sql`
      UPDATE harness_shared.harness_features_consolidated
         SET verified_done_at_remote_ts = NOW(),
             verifier_last_error = NULL,
             verifier_last_checked_at = NOW()
       WHERE harness_slug = ${harnessSlug}
         AND feature_id = ${featureId}
    `;
    return;
  }
  if (outcome === 'divergent') {
    await sql`
      UPDATE harness_shared.harness_features_consolidated
         SET verifier_last_error = 'sha_not_found',
             verifier_last_checked_at = NOW()
       WHERE harness_slug = ${harnessSlug}
         AND feature_id = ${featureId}
    `;
    return;
  }
  // 'error' — transient network/timeout; bump the checked-at so the UI
  // can show "last attempted" but don't poison verifier_last_error.
  await sql`
    UPDATE harness_shared.harness_features_consolidated
       SET verifier_last_checked_at = NOW()
     WHERE harness_slug = ${harnessSlug}
       AND feature_id = ${featureId}
  `;
}

export type VerifyHarnessFeaturesDeps = {
  runGitLsRemote?: RunGitLsRemote;
  /**
   * Injectable PG accessor (tests) — defaults to getOrgPg. Lets a test
   * simulate "PG unavailable" by throwing here, without depending on a live
   * connection (and without relying on getOrgPg crashing, which it no longer
   * does). The PG read happens before any git call, so a throw rejects before
   * runGitLsRemote is invoked.
   */
  getPg?: typeof getOrgPg;
};

/**
 * Verify completion_refs for one harness. Reads pending_done +
 * recently-shipped features with non-null completion_ref, polls the
 * remote for each, updates the row with the result.
 *
 * On-demand callable from the UI "Re-check verification" button
 * (P-017c) — should return within ~5s for a harness with <50 features.
 * Does NOT apply backoff filtering (always checks all eligible features).
 */
export async function verifyHarnessFeatures(
  harnessSlug: string,
  deps: VerifyHarnessFeaturesDeps = {},
): Promise<VerificationResult> {
  const runGit = deps.runGitLsRemote ?? defaultRunGitLsRemote;
  const getPg = deps.getPg ?? getOrgPg;
  const rows = await selectVerifiableFeatures(harnessSlug, getPg);
  let verified = 0;
  let divergent = 0;
  let errors = 0;
  for (const row of rows) {
    const result = await runGit(row.completion_ref.remote, row.completion_ref.commit_sha);
    const outcome = decideVerificationOutcome(result);
    await applyOutcomeToRow(harnessSlug, row.feature_id, outcome, getPg);
    if (outcome === 'verified') verified += 1;
    else if (outcome === 'divergent') divergent += 1;
    else errors += 1;
  }
  return { harnessSlug, checked: rows.length, verified, divergent, errors };
}

/**
 * Verify completion_refs for one harness respecting per-feature
 * exponential backoff (P-016c). Used by the daemon tick only.
 *
 * On network error:
 *   - Increments per-feature consecutive-error counter
 *   - Schedules next check at base × 2^(count-1), capped at 5 min
 *   - After 5 consecutive errors writes a warning toast (once per streak)
 *
 * On verified or divergent: clears the backoff entry for that feature.
 */
async function verifyHarnessFeaturesWithBackoff(
  harnessSlug: string,
  runGit: RunGitLsRemote,
): Promise<VerificationResult> {
  const rows = await selectVerifiableFeatures(harnessSlug);
  let verified = 0;
  let divergent = 0;
  let errors = 0;

  for (const row of rows) {
    const { feature_id } = row;
    if (shouldSkipFeature(harnessSlug, feature_id)) {
      // still in backoff window — skip without bumping checked_at
      errors += 1;
      continue;
    }

    const result = await runGit(row.completion_ref.remote, row.completion_ref.commit_sha);
    const outcome = decideVerificationOutcome(result);
    await applyOutcomeToRow(harnessSlug, feature_id, outcome);

    if (outcome === 'verified' || outcome === 'divergent') {
      clearBackoffEntry(harnessSlug, feature_id);
      if (outcome === 'verified') verified += 1;
      else divergent += 1;
    } else {
      const reason = result.kind === 'error' ? result.reason : 'unknown';
      const entry = recordNetworkError(harnessSlug, feature_id);
      errors += 1;

      if (entry.consecutiveErrors >= TOAST_AFTER_N_ERRORS && entry.toastedAt === null) {
        entry.toastedAt = Date.now();
        void writeVerifierWarningToast(harnessSlug, feature_id, reason, entry.consecutiveErrors);
      }
    }
  }

  return { harnessSlug, checked: rows.length, verified, divergent, errors };
}

/**
 * Find the harness slugs that have ≥1 feature needing verification.
 * Coalesces the per-tick work to harnesses with actual activity.
 */
async function selectHarnessesWithVerifiableWork(): Promise<string[]> {
  const { sql } = getOrgPg();
  const recencyCutoffMs = Date.now() - SHIPPED_RECENCY_MS;
  const rows = await sql<{ harness_slug: string }[]>`
    SELECT DISTINCT harness_slug
      FROM harness_shared.harness_features_consolidated
     WHERE completion_ref IS NOT NULL
       AND (
         status = 'pending_done'
         OR (status = 'shipped' AND COALESCE(updated_ts, 0) > ${recencyCutoffMs})
       )
  `;
  return rows.map((r) => r.harness_slug);
}

type StartOpts = {
  pollIntervalMs?: number;
  runGitLsRemote?: RunGitLsRemote;
};

type Singleton = { __completionRefVerifierTimer?: NodeJS.Timeout | null };
const _g = globalThis as unknown as Singleton;

/**
 * Start the periodic verifier. Idempotent across HMR / multiple
 * instrumentation.register() calls — second call is a no-op.
 */
/**
 * One full verifier pass across every harness with verifiable work.
 * Exposed for the periodic scheduler: both the legacy daemon path and the
 * lightweight in-process periodic check delegate to this single-run tick.
 */
export async function runCompletionRefVerifierOnce(
  runGit: RunGitLsRemote = defaultRunGitLsRemote,
): Promise<void> {
  const slugs = await selectHarnessesWithVerifiableWork();
  for (const slug of slugs) {
    await verifyHarnessFeaturesWithBackoff(slug, runGit);
  }
}

// Legacy startCompletionRefVerifier removed (consolidation P-005). The
// in-process periodic scheduler (dbos/in-process-periodic.ts) owns the cadence;
// `runCompletionRefVerifierOnce` above is the single-run tick it calls.

export function stopCompletionRefVerifier(): void {
  if (_g.__completionRefVerifierTimer) {
    clearInterval(_g.__completionRefVerifierTimer);
    _g.__completionRefVerifierTimer = null;
  }
}
