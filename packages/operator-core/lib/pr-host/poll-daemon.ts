/**
 * pr-host/poll-daemon — the PR poll daemon (Phase 7 P-042, un-vaporware).
 *
 * P-042 was marked "shipped" in `papercusp-dogfood-phase7-pr-lifecycle` but the
 * file never existed (EI-479) — this is the real build. It is the missing SPINE of
 * the inbound PR flow: nothing else notices that a fork→PR appeared, so without it
 * a contribution is reviewed/merged only when a human clicks a button. With it the
 * loop is autonomous (PLAN-pr-system-completion-dogfood, Phase PR-1).
 *
 * Shape: a `system:pr-poll` routine action, registered into the same routines
 * engine git-sync uses (registerSystemAction below; the engine runs it INLINE as
 * one durable DBOS step per due routine). One routine per harness with the reviewer
 * role enabled (see `./pr-poll-routine.ts`); each tick, for THIS harness:
 *
 *   1. list open PRs on the upstream (Octokit, via the PrHost),
 *   2. diff against last-seen (per-PR {updated_at, head_sha} snapshot stored on the
 *      routine's metadata — survives restart ⇒ "resumes from last-seen"),
 *   3. for each NEW/UPDATED PR:
 *      (a) upsert `harness_feature_prs` (best-effort; PR-4 owns the rich producer),
 *      (b) refresh `pr_check_status_cache` from the head-SHA check-runs,
 *      (c) trigger the agent-reviewer (PR-2) via the launch-event seam (inert until
 *          PR-2's blueprint declares the event),
 *      (d) evaluate `decideAutoReview(pr, settings)` and, in AUTO mode, drive the
 *          EXISTING idempotent `tryAutoApprove` + `tryAutoMerge`.
 *
 * Safety (S0): auto-MERGE fires ONLY on `decideAutoReview` → `approve_and_merge`,
 * which itself requires checks-green (`success`) + trusted author + `auto_merge`
 * on. A red/pending/unknown check, an untrusted author, or a self-authored PR can
 * never reach `tryAutoMerge`. When a PR-2 review report exists, a
 * `request_changes`/`reject` recommendation additionally VETOES the auto path
 * (`reportGatesAutoApprove`) — but a missing report never blocks (PR-1 stands alone
 * before PR-2 lands).
 *
 * Idempotent + crash-safe: re-poll is a no-op for unchanged PRs (the last-seen
 * guard), and even with the guard neutered `tryAutoApprove`/`tryAutoMerge` are
 * idempotent (already-approved ⇒ skip; a merged PR drops off the open list). The
 * handler is one durable step, so a crash replays it from the top — every write
 * here is safe to re-run.
 *
 * Error handling (P-042c/d/e): a `listOpenPrs` failure runs the pure `decideRetry`
 * policy and pushes the routine's `next_fire_at` out with exponential backoff
 * (5xx/network), the rate-limit reset window (429), or the 5-min cap (terminal /
 * needs-reauth). A clean tick resets the backoff to the 60s cadence.
 *
 * Deps (and the PG `store`) are injectable (the codebase's runner-seam pattern) so
 * the whole flow is unit-testable without GitHub, PG, or DBOS — and so the daemon
 * does NOT touch the shared `PrHost` interface (checks are fetched through an
 * injected seam over Octokit, keeping this decoupled from the concurrent PR-2 edits
 * to types/github).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import {
  type Pr,
  type PrHost,
  type PrHostResult,
  type PrHostError,
  type PrChecksState,
  type PrMergeMethod,
  PR_MERGE_METHODS,
  ok,
  err,
  statusToErrorKind,
} from './types';
import { parseRemote } from './github';
import { decideAutoReview, type AutoReviewSettings } from './auto-review-decision-types';
import { tryAutoApprove, type AutoApproveContext } from './auto-approve';
import { tryAutoMerge, type AutoMergeContext } from './auto-merge';
import { decideRetry, DEFAULT_RETRY_POLICY, type RetryDecision } from './retry-policy-types';
import {
  summarizeCheckRuns,
  type CheckRunEntry,
  type CheckRunStatus,
  type CheckRunConclusion,
} from './pr-check-status-cache-types';
import { reportGatesAutoApprove } from './pr-review-report-types';
import { PR_POLL_TARGET } from './pr-poll-routine';
import { routineStorageSlug } from '../pot-membership';

/** The event key PR-2's agent-reviewer launch blueprint declares as its trigger. */
export const PR_REVIEW_EVENT = 'pr:review';

/** Check-run summary the auto-merge gate + the cache refresh both consume. */
export interface PollChecks {
  state: PrChecksState;
  runs: CheckRunEntry[];
}

/** The narrow viewer identity the daemon reviews AS (the authenticated operator). */
export interface PollViewer {
  id: number;
  login: string;
}

/** The reviewer settings row the daemon self-gates + drives the auto-flow on. */
export interface ReviewerSettingsRow {
  pr_reviewer_role_enabled: boolean;
  auto_review: boolean;
  auto_merge: boolean;
  merge_method: PrMergeMethod;
}

/** Per-PR last-seen fingerprint — change in either field re-processes the PR. */
export interface LastSeenEntry {
  updated_at: number;
  head_sha: string;
}

export interface PollMeta {
  last_seen: Record<string, LastSeenEntry>;
  consecutive_errors: number;
}

/**
 * The PG surface the daemon touches — extracted as a seam so the orchestration is
 * testable with an in-memory store (no tagged-template SQL faking). The default
 * impl (`makeSqlStore`) is thin raw-SQL, the same hand-written style as
 * auto-approve.ts's `writeAudit` + the pr-reviewer-settings route.
 */
export interface PollStore {
  readSettings(workspaceId: string, installSlug: string, viewerId: number): Promise<ReviewerSettingsRow | null>;
  readTrust(workspaceId: string, installSlug: string, viewerId: number): Promise<ReadonlySet<number>>;
  readMeta(installSlug: string): Promise<PollMeta>;
  patchMeta(installSlug: string, patch: Record<string, unknown>): Promise<void>;
  setNextFireAt(installSlug: string, at: Date): Promise<void>;
  /** Best-effort WI↔PR row (resolves feature_id via completion_ref; no-op if unlinked). */
  upsertFeaturePr(args: { workspaceId: string; installSlug: string; pr: Pr }): Promise<void>;
  /** Best-effort per-check-run cache refresh for a head SHA. */
  refreshChecks(args: { workspaceId: string; installSlug: string; headSha: string; runs: CheckRunEntry[] }): Promise<void>;
}

/**
 * Injectable seams. Production defaults wire the real GitHub host, Octokit
 * check-runs fetch, local gh identity, the launch-event reviewer trigger, PR-2's
 * report read, and the SQL-backed store. Tests pass fakes — no network, no PG.
 */
export interface PollDaemonDeps {
  sql?: Sql;
  store?: PollStore;
  createHost?: () => Promise<PrHost | null>;
  fetchChecks?: (remote: string, headSha: string) => Promise<PrHostResult<PollChecks>>;
  resolveViewer?: () => Promise<PollViewer | null>;
  triggerReviewer?: (args: {
    installSlug: string;
    workspaceId: string;
    pr: Pr;
    reviewerGithubId: number;
  }) => Promise<void>;
  readReport?: (args: {
    installSlug: string;
    workspaceId: string;
    prNumber: number;
    /** Gap-2 staleness: when set, the reader returns a report ONLY if it reviewed THIS
     *  head_sha — a stale report (an earlier commit, e.g. after a force-push) reads as
     *  absent so the gate defers + re-reviews the new diff rather than gating on it. */
    headSha?: string;
  }) => Promise<{ recommendation: 'approve' | 'request_changes' | 'reject' } | null>;
  /**
   * PR-5 (contribution-admission): is the PR author a REVOKED contributor on this
   * harness's hive? The autonomous auto-flow MUST honor revocation just like the
   * manual reviewPr route does — a revoked contributor's PR is never auto-approved
   * /merged. Default: isPrAuthorRevoked (resolves harness→hive→revoked-set).
   */
  isAuthorRevoked?: (args: {
    workspaceId: string;
    harnessSlug: string;
    githubUserId: number;
  }) => Promise<boolean>;
  /**
   * After an AUTONOMOUS auto-merge, complete the WI→shipped + PR→merged tracking — the
   * same post-merge stamp the manual `reviewPr` route does (resolveMergedPrFeatureId →
   * stampCompletionRefOnMerge + markFeaturePrState('merged')). Without it a daemon-merged
   * PR never stamps `completion_ref` (feature stays un-shipped) nor flips the WI↔PR row,
   * so the dogfood round-trip + the "shipped ✓" stat never fire for autonomous merges.
   * Default: defaultStampMerge. Best-effort — the merge already succeeded.
   */
  stampMerge?: (args: {
    workspaceId: string;
    installSlug: string;
    remote: string;
    pr: Pr;
    mergeCommitSha: string;
  }) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface PollHarnessArgs {
  installSlug: string;
  workspaceId: string;
  /** Canonical `github.com/<owner>/<repo>` upstream remote to poll. */
  remote: string;
  /**
   * TEETH SEAM: skip the last-seen diff guard so EVERY open PR is re-processed.
   * The idempotency test flips this true on a re-poll and asserts NO second merge —
   * proving the state-level idempotency in tryAutoApprove/tryAutoMerge holds even
   * when the (normally load-bearing) last-seen guard is removed.
   */
  ignoreLastSeen?: boolean;
}

export interface PollOutcome {
  status: 'ok' | 'skipped' | 'error';
  reason?: string;
  prsSeen: number;
  prsProcessed: number;
  approved: number[];
  merged: number[];
  triggered: number[];
  vetoed: number[];
  /** PR-5: PRs whose author is a revoked contributor — refused the auto-flow. */
  revoked: number[];
  /** Gap 2 (su-pr2 handoff): PRs DEFERRED this pass — agent review in flight, no
   *  report yet. The auto path waits (does NOT auto-approve before the agent reviews);
   *  these are excluded from last_seen so the next poll re-checks once the report lands. */
  awaitingReview: number[];
  error?: { kind: string; message: string };
  /** Backoff applied to next_fire_at (ms from now) when status==='error'. */
  backoffMs?: number;
}

interface ResolvedDeps {
  store: PollStore;
  createHost: () => Promise<PrHost | null>;
  fetchChecks: (remote: string, headSha: string) => Promise<PrHostResult<PollChecks>>;
  resolveViewer: () => Promise<PollViewer | null>;
  triggerReviewer: (args: {
    installSlug: string;
    workspaceId: string;
    pr: Pr;
    reviewerGithubId: number;
  }) => Promise<void>;
  readReport: (args: {
    installSlug: string;
    workspaceId: string;
    prNumber: number;
    headSha?: string;
  }) => Promise<{ recommendation: 'approve' | 'request_changes' | 'reject' } | null>;
  isAuthorRevoked: (args: {
    workspaceId: string;
    harnessSlug: string;
    githubUserId: number;
  }) => Promise<boolean>;
  stampMerge: (args: {
    workspaceId: string;
    installSlug: string;
    remote: string;
    pr: Pr;
    mergeCommitSha: string;
  }) => Promise<void>;
  now: () => number;
  random: () => number;
}

function resolveDeps(deps: PollDaemonDeps): ResolvedDeps {
  return {
    store: deps.store ?? makeSqlStore(deps.sql ?? getOrgPg().sql),
    createHost: deps.createHost ?? defaultCreateHost,
    fetchChecks: deps.fetchChecks ?? defaultFetchChecks,
    resolveViewer: deps.resolveViewer ?? defaultResolveViewer,
    triggerReviewer: deps.triggerReviewer ?? defaultTriggerReviewer,
    readReport: deps.readReport ?? defaultReadReport,
    isAuthorRevoked: deps.isAuthorRevoked ?? defaultIsAuthorRevoked,
    stampMerge: deps.stampMerge ?? defaultStampMerge,
    now: deps.now ?? Date.now,
    random: deps.random ?? Math.random,
  };
}

const EMPTY_COUNTS = (): Pick<PollOutcome, 'prsSeen' | 'prsProcessed' | 'approved' | 'merged' | 'triggered' | 'vetoed' | 'revoked' | 'awaitingReview'> => ({
  prsSeen: 0,
  prsProcessed: 0,
  approved: [],
  merged: [],
  triggered: [],
  vetoed: [],
  revoked: [],
  awaitingReview: [],
});

// ── The testable core ─────────────────────────────────────────────────────────

/**
 * Poll one harness's open PRs and drive the inbound flow. All I/O goes through
 * `deps`, so a fake host + fake store exercise every branch. Returns a structured
 * outcome; also persists last-seen / backoff / status onto the routine metadata so
 * a restart resumes and a sustained GitHub outage backs off.
 */
export async function pollHarnessPrs(args: PollHarnessArgs, deps: PollDaemonDeps = {}): Promise<PollOutcome> {
  const d = resolveDeps(deps);
  const { installSlug, workspaceId, remote } = args;
  const counts = EMPTY_COUNTS();

  // gh identity (decision (c): review AS the authenticated operator).
  const viewer = await d.resolveViewer();
  if (!viewer) {
    await d.store.patchMeta(installSlug, { last_status: 'skipped', last_skip_reason: 'gh_unauth', last_polled_at: d.now() });
    return { ...counts, status: 'skipped', reason: 'gh_unauth' };
  }

  // Self-gate: the role may have been disabled after the routine was seeded.
  const settings = await d.store.readSettings(workspaceId, installSlug, viewer.id);
  if (!settings || !settings.pr_reviewer_role_enabled) {
    await d.store.patchMeta(installSlug, { last_status: 'skipped', last_skip_reason: 'role_disabled', last_polled_at: d.now() });
    return { ...counts, status: 'skipped', reason: 'role_disabled' };
  }

  const host = await d.createHost();
  if (!host) {
    await d.store.patchMeta(installSlug, { last_status: 'skipped', last_skip_reason: 'gh_unauth', last_polled_at: d.now() });
    return { ...counts, status: 'skipped', reason: 'gh_unauth' };
  }

  const listRes = await host.listOpenPrs({ remote });
  if (!listRes.ok) {
    return handleListError(d, installSlug, listRes.error, counts);
  }
  const prs = listRes.data;
  counts.prsSeen = prs.length;

  const trust = await d.store.readTrust(workspaceId, installSlug, viewer.id);
  const autoSettings: AutoReviewSettings = {
    pr_reviewer_role_enabled: settings.pr_reviewer_role_enabled,
    auto_review: settings.auto_review,
    auto_merge: settings.auto_merge,
    trust_list: trust,
    viewer_github_user_id: viewer.id,
  };
  const approveCtx: AutoApproveContext = {
    harnessSlug: installSlug,
    reviewerGithubId: viewer.id,
    reviewerLogin: viewer.login,
    trustedAuthorIds: trust,
    reviewerRoleEnabled: settings.pr_reviewer_role_enabled,
    autoReview: settings.auto_review,
  };
  const mergeCtx: AutoMergeContext = {
    harnessSlug: installSlug,
    reviewerGithubId: viewer.id,
    reviewerLogin: viewer.login,
    autoMerge: settings.auto_merge,
    mergeMethod: settings.merge_method,
  };

  const meta = await d.store.readMeta(installSlug);
  const lastSeen = args.ignoreLastSeen ? {} : meta.last_seen;
  // Gap 2 (su-pr2 handoff): PRs deferred this pass (agent review in flight) — excluded
  // from the last_seen snapshot below so the next poll re-checks once the report lands.
  const deferred = new Set<number>();

  for (const pr of prs) {
    const prevSeen = lastSeen[String(pr.ref.number)];
    const changed = !prevSeen || prevSeen.updated_at !== pr.updated_at || prevSeen.head_sha !== pr.head_sha;
    if (!changed) continue; // last-seen guard — the primary idempotency gate.
    counts.prsProcessed++;

    // Enrich: the list endpoint reports review_decision='none', checks/mergeable
    // 'unknown' — getPr fills review_decision + mergeable_state; fetchChecks fills
    // checks_state (the auto-merge gate needs an accurate `success`).
    const detail = await host.getPr(pr.ref);
    if (!detail.ok) {
      // 404 ⇒ gone upstream (P-042f); any error ⇒ skip this PR, keep polling the rest.
      continue;
    }
    let enriched = detail.data;

    const checks = await d.fetchChecks(remote, enriched.head_sha);
    if (checks.ok) {
      enriched = { ...enriched, checks_state: checks.data.state };
      await d.store.refreshChecks({ workspaceId, installSlug, headSha: enriched.head_sha, runs: checks.data.runs });
    }

    // (a) WI↔PR tracking row (best-effort; PR-4 owns the full producer).
    await d.store.upsertFeaturePr({ workspaceId, installSlug, pr: enriched });

    // (c) trigger the agent-reviewer (PR-2). Fires once per new/changed PR (last-seen
    //     guard above). A blueprint-declared `pr:review` task takes precedence; absent
    //     one, the default runs the deterministic reviewer in-process (PR-2 landed).
    await d.triggerReviewer({ installSlug, workspaceId, pr: enriched, reviewerGithubId: viewer.id });
    counts.triggered.push(enriched.ref.number);

    // (d) auto-flow gate.
    const decision = decideAutoReview(enriched, autoSettings);
    if (decision.kind === 'skip') continue;

    // PR-5 contribution-admission: a REVOKED contributor's PR never enters the auto
    // path — the strongest deny, ahead of trust/checks (the manual reviewPr route
    // enforces the same; this closes the autonomous-path hole where the daemon would
    // otherwise auto-approve+merge a revoked author's PR). The S0 invariant.
    const authorRevoked = await d.isAuthorRevoked({
      workspaceId,
      harnessSlug: installSlug,
      githubUserId: enriched.author.github_user_id,
    });
    if (authorRevoked) {
      counts.revoked.push(enriched.ref.number);
      continue;
    }

    // PR-2 agent-review gate (Gap 1+2, su-pr2 handoff). Auto-review is ON here
    // (decideAutoReview passed its role+auto_review gate), so the agent's report is PART
    // of the gate — require a PRESENT report before auto-approving:
    //   • present + request_changes/reject → VETO (blocks even a trusted+green PR);
    //   • ABSENT → WAIT this pass (the review is in flight, fired by triggerReviewer above).
    //     Do NOT auto-approve before the agent has reviewed — this closes the first-sight race
    //     where a brand-new trusted+green PR auto-merged on poll 1 before any report existed.
    //     The PR is added to `deferred` (excluded from last_seen) so the NEXT poll re-checks
    //     once the report lands. (NB known follow-up: readReport returns the latest report for
    //     ANY head_sha — a force-push could read a stale report; head_sha-scoping is the refinement
    //     tracked in findings-PR-2-reviewer-trigger-seam.md.)
    const report = await d.readReport({
      installSlug,
      workspaceId,
      prNumber: enriched.ref.number,
      headSha: enriched.head_sha, // staleness gate: a report for an older diff reads as absent
    });
    if (!report) {
      counts.awaitingReview.push(enriched.ref.number);
      deferred.add(enriched.ref.number);
      continue;
    }
    if (!reportGatesAutoApprove(report)) {
      counts.vetoed.push(enriched.ref.number);
      continue;
    }

    const approveRes = await tryAutoApprove(host, enriched, approveCtx);
    if (approveRes.action === 'approved') counts.approved.push(enriched.ref.number);

    if (
      decision.kind === 'approve_and_merge' &&
      (approveRes.action === 'approved' || approveRes.action === 'skipped_already_approved')
    ) {
      // The in-memory PR still carries its pre-approve review_decision; reflect the
      // approval we just posted so tryAutoMerge's "approved" gate sees the truth.
      const mergeRes = await tryAutoMerge(host, { ...enriched, review_decision: 'approved' }, mergeCtx);
      if (mergeRes.action === 'merged') {
        counts.merged.push(enriched.ref.number);
        // Complete the WI→shipped + PR→merged tracking on the AUTONOMOUS path, exactly as
        // the manual reviewPr route does — without this an auto-merge never stamps
        // completion_ref (feature stays un-shipped) nor flips the WI↔PR row. Best-effort:
        // the merge already succeeded, so a stamp failure must never surface as a poll error.
        await d.stampMerge({
          workspaceId,
          installSlug,
          remote,
          pr: enriched,
          mergeCommitSha: mergeRes.mergeCommitSha,
        });
      }
    }
  }

  // last_seen = snapshot of the CURRENT open set (merged/closed PRs drop off the
  // open list and thus out of the snapshot — bounded growth). Reset the backoff.
  const nextSeen: Record<string, LastSeenEntry> = {};
  for (const pr of prs) {
    // Gap 2: a DEFERRED PR (awaiting its review report) is left OUT of last_seen, so the
    // next poll treats it as "changed" and re-processes it — picking up the report once it
    // lands. Without this, the last_seen guard would skip it forever and it would never
    // auto-approve (the bug a naive "wait this cycle" introduces).
    if (deferred.has(pr.ref.number)) continue;
    nextSeen[String(pr.ref.number)] = { updated_at: pr.updated_at, head_sha: pr.head_sha };
  }
  await d.store.patchMeta(installSlug, {
    last_seen: nextSeen,
    consecutive_errors: 0,
    last_status: 'ok',
    last_polled_at: d.now(),
    last_error: null,
  });

  return { ...counts, status: 'ok' };
}

/** Map a listOpenPrs failure → backoff + recorded status (P-042c/d/e). */
async function handleListError(
  d: ResolvedDeps,
  installSlug: string,
  error: PrHostError,
  counts: ReturnType<typeof EMPTY_COUNTS>,
): Promise<PollOutcome> {
  const meta = await d.store.readMeta(installSlug);
  const attempt = meta.consecutive_errors;
  // oauth_refresh_attempted:true — getOctokit already does the 401→refresh→retry
  // internally, so a 401 that surfaces here means re-auth is genuinely needed.
  const decision = decideRetry(error, { attempt, oauth_refresh_attempted: true, now: d.now(), random: d.random() });
  const backoffMs = backoffMsFor(decision);
  await d.store.patchMeta(installSlug, {
    consecutive_errors: attempt + 1,
    last_status: 'error',
    last_error: `${error.kind}: ${error.message}`.slice(0, 400),
    last_error_at: d.now(),
    last_polled_at: d.now(),
    ...(decision.kind === 'alert_user' ? { needs_reauth: true } : {}),
  });
  await d.store.setNextFireAt(installSlug, new Date(d.now() + backoffMs));
  return { ...counts, status: 'error', reason: error.kind, error: { kind: error.kind, message: error.message }, backoffMs };
}

/** The delay a retry decision implies, capped at the policy's max backoff. */
export function backoffMsFor(decision: RetryDecision): number {
  switch (decision.kind) {
    case 'wait':
      return Math.min(decision.delay_ms, DEFAULT_RETRY_POLICY.max_backoff_ms);
    case 'oauth_refresh_then_retry':
      return Math.min(60_000, DEFAULT_RETRY_POLICY.max_backoff_ms);
    case 'give_up':
    case 'alert_user':
      // Terminal for this attempt — back off to the cap so we don't hammer a
      // misconfigured remote / revoked token; the user fixes it, the next tick recovers.
      return DEFAULT_RETRY_POLICY.max_backoff_ms;
  }
}

// ── The SQL-backed store (default impl) ─────────────────────────────────────────

/** Build the production `PollStore` over a postgres-js `Sql`. */
export function makeSqlStore(sql: Sql): PollStore {
  return {
    async readSettings(workspaceId, installSlug, viewerId) {
      const rows = await sql<
        Array<{ pr_reviewer_role_enabled: boolean; auto_review: boolean; auto_merge: boolean; merge_method: string }>
      >`
        SELECT pr_reviewer_role_enabled, auto_review, auto_merge, merge_method
          FROM harness_shared.pr_reviewer_settings
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${installSlug} AND github_user_id = ${viewerId}
         LIMIT 1
      `;
      const r = rows[0];
      if (!r) return null;
      return {
        pr_reviewer_role_enabled: !!r.pr_reviewer_role_enabled,
        auto_review: !!r.auto_review,
        auto_merge: !!r.auto_merge,
        merge_method: (PR_MERGE_METHODS as readonly string[]).includes(r.merge_method)
          ? (r.merge_method as PrMergeMethod)
          : 'squash',
      };
    },

    async readTrust(workspaceId, installSlug, viewerId) {
      const rows = await sql<Array<{ trusted_github_user_id: number | string }>>`
        SELECT trusted_github_user_id
          FROM harness_shared.trusted_authors
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${installSlug}
           AND trusted_by_github_user_id = ${viewerId}
      `;
      return new Set(rows.map((r) => Number(r.trusted_github_user_id)));
    },

    async readMeta(installSlug) {
      const rows = await sql<Array<{ m: { last_seen?: unknown; consecutive_errors?: unknown } | null }>>`
        SELECT metadata->'pr_poll' AS m
          FROM harness_shared.routines
         WHERE install_slug = ${installSlug} AND target_role = ${PR_POLL_TARGET}
         LIMIT 1
      `;
      return parsePollMeta(rows[0]?.m);
    },

    async patchMeta(installSlug, patch) {
      try {
        await sql.unsafe(
          `UPDATE harness_shared.routines
              SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('pr_poll', COALESCE(metadata->'pr_poll', '{}'::jsonb) || $2::jsonb),
                  updated_at = now()
            WHERE install_slug = $1 AND target_role = $3`,
          [installSlug, JSON.stringify(patch), PR_POLL_TARGET],
        );
      } catch {
        // Metadata is observability/idempotency state — never sink the poll on a write blip.
      }
    },

    async setNextFireAt(installSlug, at) {
      try {
        await sql`
          UPDATE harness_shared.routines
             SET next_fire_at = ${at.toISOString()}::timestamptz, updated_at = now()
           WHERE install_slug = ${installSlug} AND target_role = ${PR_POLL_TARGET}
        `;
      } catch {
        /* best-effort backoff; the cron-derived next_fire_at remains as a floor */
      }
    },

    async upsertFeaturePr({ workspaceId, installSlug, pr }) {
      try {
        // WI-6978 — the ONE re-homed relation this daemon touches. The feature-family
        // WRITE path resolves a member harness to its Pot home (work-items.ts:1316
        // resolveWorkItemPot, under FLAGS.POT_MEMBERSHIP_ENFORCEMENT, default ON), so
        // a raw-`installSlug` filter here matches ZERO ROWS for any member harness and
        // this function silently returns without ever linking a PR to its feature.
        // `routineStorageSlug` calls the SAME resolver the write path uses, so read and
        // write agree by construction; it fails open to the literal slug.
        //
        // ⚠ The pr_reviewer_settings and trusted_authors reads above deliberately keep
        // the RAW `installSlug` — both are per-install/workspace-scoped and NOT
        // re-homed (audited WI-6978; trusted_authors is SECURITY-classed and never
        // leaves the machine). Do not "fix" them to match this one.
        const featureStorageSlug = await routineStorageSlug(installSlug, workspaceId);
        const feat = await sql<Array<{ feature_id: string }>>`
          SELECT feature_id
            FROM harness_shared.harness_features_consolidated
           WHERE workspace_id = ${workspaceId}
             AND harness_slug = ${featureStorageSlug}
             AND (completion_ref->>'pr_url') = ${pr.url}
           LIMIT 1
        `;
        const featureId = feat[0]?.feature_id;
        if (!featureId) return;
        await sql`
          INSERT INTO harness_shared.harness_feature_prs
            (workspace_id, harness_slug, feature_id, pr_url, pr_state, opened_ts, updated_ts)
          VALUES (${workspaceId}, ${installSlug}, ${featureId}, ${pr.url}, ${pr.state}, ${pr.updated_at}, ${pr.updated_at})
          ON CONFLICT (workspace_id, harness_slug, feature_id) DO UPDATE SET
            pr_url     = EXCLUDED.pr_url,
            pr_state   = EXCLUDED.pr_state,
            updated_ts = EXCLUDED.updated_ts
        `;
      } catch {
        // harness_feature_prs is PR-4's table; a missing column / schema drift must
        // never sink the poll (the auto-flow is the load-bearing part).
      }
    },

    async refreshChecks({ workspaceId, installSlug, headSha, runs }) {
      try {
        for (const run of runs) {
          await sql`
            INSERT INTO harness_shared.pr_check_status_cache
              (workspace_id, harness_slug, head_sha, check_name, status, conclusion, details_url, fetched_at)
            VALUES (${workspaceId}, ${installSlug}, ${headSha}, ${run.name}, ${run.status},
                    ${run.conclusion}, ${run.details_url}, now())
            ON CONFLICT (workspace_id, harness_slug, head_sha, check_name) DO UPDATE SET
              status      = EXCLUDED.status,
              conclusion  = EXCLUDED.conclusion,
              details_url = EXCLUDED.details_url,
              fetched_at  = now()
          `;
        }
      } catch {
        /* the cache is a convenience for the PRs-tab detail expansion — never gate on it */
      }
    },
  };
}

/** Defensively parse the `routines.metadata->'pr_poll'` JSONB into a PollMeta. */
export function parsePollMeta(m: unknown): PollMeta {
  const obj = m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
  const rawSeen = obj.last_seen;
  const last_seen: Record<string, LastSeenEntry> = {};
  if (rawSeen && typeof rawSeen === 'object') {
    for (const [k, v] of Object.entries(rawSeen as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const ua = (v as { updated_at?: unknown }).updated_at;
        const hs = (v as { head_sha?: unknown }).head_sha;
        if (typeof ua === 'number' && typeof hs === 'string') last_seen[k] = { updated_at: ua, head_sha: hs };
      }
    }
  }
  return { last_seen, consecutive_errors: Number(obj.consecutive_errors ?? 0) || 0 };
}

// ── Production default seams (lazy-imported so boot stays light) ─────────────────

async function defaultCreateHost(): Promise<PrHost | null> {
  const { createGitHubPrHost } = await import('./github');
  return createGitHubPrHost();
}

async function defaultResolveViewer(): Promise<PollViewer | null> {
  try {
    const { getAuthenticatedGithubUser } = await import('../identity/resolve-local-github-identity');
    return await getAuthenticatedGithubUser();
  } catch {
    return null;
  }
}

/** Fetch the head-SHA check-runs via Octokit + summarize to a PrChecksState. */
async function defaultFetchChecks(remote: string, headSha: string): Promise<PrHostResult<PollChecks>> {
  const parsed = parseRemote(remote);
  if (!parsed) return err({ kind: 'validation', message: `Cannot parse remote: ${remote}` });
  const { getOctokit } = await import('../identity/octokit-client');
  const oc = await getOctokit();
  if (!oc) return err({ kind: 'unauthorized', message: 'gh not authenticated' });
  try {
    const { data } = await oc.checks.listForRef({
      owner: parsed.owner,
      repo: parsed.repo,
      ref: headSha,
      per_page: 100,
    });
    const runs: CheckRunEntry[] = (data.check_runs ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status as CheckRunStatus,
      conclusion: (r.conclusion ?? null) as CheckRunConclusion | null,
      details_url: r.details_url ?? null,
      started_at: r.started_at ? new Date(r.started_at).getTime() : null,
      completed_at: r.completed_at ? new Date(r.completed_at).getTime() : null,
    }));
    return ok({ state: summarizeCheckRuns(runs), runs });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 0;
    return err({
      kind: statusToErrorKind(status || 500),
      message: e instanceof Error ? e.message : String(e),
      status: status || undefined,
    });
  }
}

/** Trigger the agent-reviewer (PR-2). Preference order: a blueprint-declared `pr:review`
 *  task (a full Bee, if a hive opts into one) takes precedence; absent one, run PR-2's
 *  deterministic + safety-guarded reviewer IN-PROCESS. Either way fire-and-forget (the
 *  auto-flow gate reads the resulting `pr_review_reports` row on a later poll). */
async function defaultTriggerReviewer(args: {
  installSlug: string;
  workspaceId: string;
  pr: Pr;
  reviewerGithubId: number;
}): Promise<void> {
  try {
    const { resolveLaunchTargetForEvent } = await import('../blueprint/launch-blueprint');
    const target = await resolveLaunchTargetForEvent(PR_REVIEW_EVENT, {
      installSlug: args.installSlug,
      workspaceId: args.workspaceId,
    });
    if (target) {
      // A hive declares a `pr:review` Bee task — hand off to it (heavyweight agent path).
      const { loopbackFetch } = await import('../loopback-fetch');
      void loopbackFetch(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kickoff: `Review PR #${args.pr.ref.number} on ${args.pr.ref.remote}: ${args.pr.title}`,
          extra: [
            '--pr-review',
            JSON.stringify({
              remote: args.pr.ref.remote,
              number: args.pr.ref.number,
              head_sha: args.pr.head_sha,
              url: args.pr.url,
            }),
          ],
        }),
      }).catch(() => {});
      return;
    }
    // No blueprint: run the deterministic reviewer in-process (PR-2's default path).
    // Fire-and-forget so a multi-second LLM review never blocks the poll loop — the
    // report lands in `pr_review_reports` for the gate + GUI to read on a later poll.
    const { runPrReviewTask } = await import('./agent-reviewer');
    void runPrReviewTask({
      payload: {
        remote: args.pr.ref.remote,
        number: args.pr.ref.number,
        head_sha: args.pr.head_sha,
        url: args.pr.url,
      },
      workspaceId: args.workspaceId,
      harnessSlug: args.installSlug,
      reviewerGithubId: args.reviewerGithubId,
    }).catch(() => {});
  } catch {
    /* best-effort reviewer trigger; the auto-flow gate does not depend on it */
  }
}

async function defaultReadReport(args: {
  installSlug: string;
  workspaceId: string;
  prNumber: number;
  headSha?: string;
}): Promise<{ recommendation: 'approve' | 'request_changes' | 'reject' } | null> {
  try {
    const { readLatestReviewReport } = await import('./pr-review-report-store');
    const r = await readLatestReviewReport({
      harnessSlug: args.installSlug,
      prNumber: args.prNumber,
      workspaceId: args.workspaceId,
    });
    if (!r) return null;
    // Gap-2 staleness: the store returns the NEWEST report for the PR regardless of
    // head_sha. When the caller asks about a specific head_sha (the daemon's AUTO gate),
    // a report that reviewed a DIFFERENT (older) commit must read as absent — so the
    // gate defers + re-reviews the current diff rather than auto-approving on a stale
    // recommendation (e.g. a force-push after an approve). No head_sha given ⇒ latest
    // (back-compat, e.g. the GUI which shows a "reviewed earlier commit" badge instead).
    if (args.headSha && r.head_sha !== args.headSha) return null;
    return { recommendation: r.recommendation };
  } catch {
    return null; // PR-2's pr_review_reports table absent / no report yet ⇒ no veto.
  }
}

/** Resolve the PR author's contributor-revocation status (PR-5). Fail-safe: false
 *  on any error — a revocation-read blip must not block the auto-flow; the trust
 *  gate still protects (an untrusted author never reaches the merge). */
async function defaultIsAuthorRevoked(args: {
  workspaceId: string;
  harnessSlug: string;
  githubUserId: number;
}): Promise<boolean> {
  try {
    const { isPrAuthorRevoked } = await import('./contribution-admission');
    return await isPrAuthorRevoked(args);
  } catch {
    return false;
  }
}

/** Default post-merge stamp for the AUTONOMOUS path — mirrors the manual `reviewPr` route
 *  (resolveMergedPrFeatureId → stampCompletionRefOnMerge + markFeaturePrState('merged')) so a
 *  daemon-merged PR completes the WI→shipped + PR→merged tracking. Best-effort: never throws
 *  (the merge already succeeded; a tracking-stamp failure must not surface as a poll error). */
async function defaultStampMerge(args: {
  workspaceId: string;
  installSlug: string;
  remote: string;
  pr: Pr;
  mergeCommitSha: string;
}): Promise<void> {
  try {
    const [{ resolveMergedPrFeatureId, stampCompletionRefOnMerge }, { markFeaturePrState }] =
      await Promise.all([
        import('../harness/completion-ref-writer'),
        import('../harness/feature-pr-producer'),
      ]);
    // Fork-PR convention: the PR title IS the feature id (fork-pr-on-feature-pass sets
    // `title: ${featureId}`); resolveMergedPrFeatureId falls back to the harness_feature_prs
    // row by pr_url when the title isn't a feature id (a non-matching id stamps nothing).
    const featureId = await resolveMergedPrFeatureId({
      harnessSlug: args.installSlug,
      prUrl: args.pr.url,
      bodyFeatureId: args.pr.title,
    });
    await stampCompletionRefOnMerge({
      harnessSlug: args.installSlug,
      featureId,
      remote: args.remote,
      branch: args.pr.base_ref,
      mergeCommitSha: args.mergeCommitSha,
      prUrl: args.pr.url,
      prNumber: args.pr.ref.number,
    });
    await markFeaturePrState({ harnessSlug: args.installSlug, prUrl: args.pr.url, prState: 'merged' });
  } catch {
    /* best-effort — see doc comment */
  }
}

// ── The registered `system:pr-poll` handler ─────────────────────────────────────

/** The action the routines engine runs inline (one durable step) per due routine. */
export async function handlePrPoll(ctx: SystemActionCtx): Promise<void> {
  const { installSlug, workspaceId, triggerConfig } = ctx;
  let remote = typeof triggerConfig.remote === 'string' ? triggerConfig.remote : '';
  if (!remote) {
    // No remote on the routine — resolve from the registry (a row that predates the
    // remote-on-trigger_config seed). Skip quietly if still unresolved.
    try {
      const { normalizeRemote } = await import('./pr-poll-routine');
      const { loadHarnessRegistry } = await import('../harness-registry');
      const reg = await loadHarnessRegistry(workspaceId);
      remote = normalizeRemote(reg.projects.find((p) => p.slug === installSlug)?.github_remote) ?? '';
    } catch {
      remote = '';
    }
  }
  if (!remote) {
    console.warn(`[pr-poll] ${installSlug}: no upstream remote resolvable — skipping tick`);
    return;
  }
  const outcome = await pollHarnessPrs({ installSlug, workspaceId, remote });
  if (outcome.status === 'error') {
    console.warn(
      `[pr-poll] ${installSlug}: poll error (${outcome.error?.kind}: ${outcome.error?.message}) — backing off ${Math.round((outcome.backoffMs ?? 0) / 1000)}s`,
    );
  } else if (outcome.merged.length || outcome.approved.length) {
    console.log(
      `[pr-poll] ${installSlug}: approved [${outcome.approved.join(', ')}] merged [${outcome.merged.join(', ')}] (${outcome.prsProcessed}/${outcome.prsSeen} PRs)`,
    );
  }
}

registerSystemAction('pr-poll', handlePrPoll);
