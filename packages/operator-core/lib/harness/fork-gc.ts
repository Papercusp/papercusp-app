/**
 * fork-gc — stale-fork garbage collection for the fork→PR contribution path
 * (PLAN pr-system-completion-dogfood, PR-5 item 3; plan D-3).
 *
 * ## The gap this closes
 * The contribution path (ensure-fork.ts → open-fork-pr.ts) forks the upstream
 * shared-harness repo under the contributor's account on first contribution, but
 * NOTHING ever tears a fork down. Over time a contributor accumulates abandoned
 * forks — stale repos that contributed once and were never touched again.
 *
 * ## The policy (owner decision D-3): KEEP-on-merge + GC the abandoned
 * Deleting another account's fork is intrusive, and a merged contribution's fork
 * is harmless to keep, so the default is KEEP. This GC only collects ABANDONED
 * forks — and only the OPERATOR'S OWN forks (never another account's). A fork is
 * abandoned iff ALL of:
 *   - it is genuinely a fork of the named upstream (repo.fork && parent matches),
 *   - it has NO open PR against the upstream (an open PR ⇒ live contribution),
 *   - its last activity (pushed_at) is older than the retention window.
 * A recently-merged PR leaves a recent `pushed_at`, so the retention window keeps
 * just-merged forks and collects only the genuinely-dormant ones.
 *
 * SAFETY: deletion is OFF by default (`dryRun: true`) — the caller must opt into
 * the destructive pass. `repos.delete` needs the `delete_repo` gh scope; a missing
 * scope surfaces as a per-fork error, never a throw. The whole module is
 * seam-injected (Octokit + clock) so it is unit-testable with no GitHub.
 */

import { getOctokit } from '../identity/octokit-client';
import type { Octokit } from '@octokit/rest';

/** Default retention: a fork untouched for 30d with no open PR is collectable. */
export const DEFAULT_FORK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ForkGcDecision =
  | 'collect' // abandoned fork → eligible for deletion
  | 'keep_active_pr' // has an open PR against the upstream
  | 'keep_recent' // touched within the retention window
  | 'keep_not_a_fork' // the repo isn't a fork of this upstream (never touch)
  | 'keep_absent'; // the operator has no fork of this upstream

export interface ForkGcEvaluation {
  /** "<forkOwner>/<repo>" — the operator's fork (may equal the upstream when the
   *  operator IS the upstream owner; that case resolves to keep_not_a_fork). */
  forkFullName: string;
  /** The upstream this fork is evaluated against. */
  upstreamFullName: string;
  decision: ForkGcDecision;
  /** Open PRs from this fork against the upstream (0 ⇒ no live contribution). */
  openPrCount: number;
  /** ms since `pushed_at`; null when the fork is absent / not a fork. */
  ageMs: number | null;
}

export interface ForkGcEvalOpts {
  upstreamOwner: string;
  upstreamRepo: string;
  /** Injectable Octokit for tests; defaults to getOctokit(). Typed `unknown` so
   *  callers don't import @octokit/rest. */
  octokit?: unknown;
  /** Retention window. Default DEFAULT_FORK_RETENTION_MS (30d). */
  retentionMs?: number;
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number;
}

/**
 * Evaluate whether the AUTHENTICATED user's fork of `upstreamOwner/upstreamRepo`
 * is an abandoned fork eligible for GC. Pure decision over the injected Octokit —
 * NEVER deletes (that is `gcForksForUpstreams` with dryRun:false). Resolves to
 * `keep_*` for every non-collectable case so the reason is explicit.
 */
export async function evaluateForkForGc(opts: ForkGcEvalOpts): Promise<ForkGcEvaluation> {
  const oc = ((opts.octokit as Octokit | undefined) ?? (await getOctokit())) as Octokit | null;
  if (!oc) {
    throw new Error(
      'evaluateForkForGc: no Octokit instance available — inject opts.octokit or run `gh auth login`.',
    );
  }
  const retentionMs = opts.retentionMs ?? DEFAULT_FORK_RETENTION_MS;
  const now = opts.now ?? (() => Date.now());
  const upstreamFullName = `${opts.upstreamOwner}/${opts.upstreamRepo}`;

  const { data: me } = await oc.rest.users.getAuthenticated();
  const forkOwner = me.login;

  // The operator IS the upstream owner ⇒ no fork exists / nothing to GC.
  if (forkOwner === opts.upstreamOwner) {
    return {
      forkFullName: upstreamFullName,
      upstreamFullName,
      decision: 'keep_not_a_fork',
      openPrCount: 0,
      ageMs: null,
    };
  }

  const forkFullName = `${forkOwner}/${opts.upstreamRepo}`;

  // Fetch the fork repo. 404 ⇒ no fork to collect.
  let repo: { fork?: boolean; parent?: { full_name?: string } | null; pushed_at?: string | null } | null;
  try {
    const { data } = await oc.rest.repos.get({ owner: forkOwner, repo: opts.upstreamRepo });
    repo = data as typeof repo;
  } catch (err: unknown) {
    if ((err as { status?: number }).status === 404) {
      return { forkFullName, upstreamFullName, decision: 'keep_absent', openPrCount: 0, ageMs: null };
    }
    throw err;
  }

  // Only ever touch a genuine fork of THIS upstream — never an unrelated repo
  // that happens to share the name, and never an original (non-fork) repo. The
  // guard narrows `repo` to non-null for the staleness read below.
  if (!repo || repo.fork !== true || (repo.parent?.full_name ?? '') !== upstreamFullName) {
    return { forkFullName, upstreamFullName, decision: 'keep_not_a_fork', openPrCount: 0, ageMs: null };
  }

  // An open PR from this fork against the upstream ⇒ live contribution, keep. Match by
  // HEAD REPO OWNER in code rather than the `head=<owner>:` API filter: an empty ref after
  // the colon is NOT a reliable "all PRs from this fork" filter, and getting it wrong would
  // mean collecting a fork that has an active (esp. stale-but-open) PR. (per_page 100 is the
  // bound; a fork's open PR also keeps its `pushed_at` recent, so `keep_recent` backstops the
  // common case — the in-code owner match is what protects a long-open, un-pushed PR.)
  const { data: openPrs } = await oc.rest.pulls.list({
    owner: opts.upstreamOwner,
    repo: opts.upstreamRepo,
    state: 'open',
    per_page: 100,
  });
  const openPrCount = Array.isArray(openPrs)
    ? openPrs.filter(
        (pr) =>
          (pr as { head?: { repo?: { owner?: { login?: string } } | null } }).head?.repo?.owner
            ?.login === forkOwner,
      ).length
    : 0;

  const pushedMs = repo.pushed_at ? Date.parse(repo.pushed_at) : NaN;
  const ageMs = Number.isFinite(pushedMs) ? now() - pushedMs : null;

  if (openPrCount > 0) {
    return { forkFullName, upstreamFullName, decision: 'keep_active_pr', openPrCount, ageMs };
  }
  // Unknown/unparseable last-activity ⇒ fail-safe KEEP (never delete on a guess).
  if (ageMs == null || ageMs < retentionMs) {
    return { forkFullName, upstreamFullName, decision: 'keep_recent', openPrCount, ageMs };
  }
  return { forkFullName, upstreamFullName, decision: 'collect', openPrCount, ageMs };
}

export interface ForkGcReport {
  evaluations: ForkGcEvaluation[];
  /** Fork full-names actually deleted (always empty when dryRun). */
  collected: string[];
  /** Fork full-names eligible (decision 'collect') but NOT deleted (dryRun). */
  wouldCollect: string[];
  dryRun: boolean;
  errors: Array<{ upstream: string; error: string }>;
}

export interface GcForksOpts {
  /** The upstreams to evaluate the operator's forks against. */
  upstreams: ReadonlyArray<{ owner: string; repo: string }>;
  octokit?: unknown;
  retentionMs?: number;
  now?: () => number;
  /**
   * SAFETY: deletion is OFF unless explicitly `dryRun: false`. Default true — the
   * default pass only REPORTS what it would collect.
   */
  dryRun?: boolean;
  log?: (msg: string) => void;
}

/**
 * Sweep the operator's forks of the given upstreams and GC the abandoned ones.
 * Best-effort: one upstream's failure is recorded and never aborts the sweep.
 * Deletes ONLY when `dryRun: false` AND the decision is 'collect'; deletes ONLY
 * the operator's own fork (`forkOwner/repo`), never the upstream or another
 * account's fork. Logs every collection — no silent destructive action.
 */
export async function gcForksForUpstreams(opts: GcForksOpts): Promise<ForkGcReport> {
  const oc = ((opts.octokit as Octokit | undefined) ?? (await getOctokit())) as Octokit | null;
  if (!oc) {
    throw new Error(
      'gcForksForUpstreams: no Octokit instance available — inject opts.octokit or run `gh auth login`.',
    );
  }
  const dryRun = opts.dryRun ?? true;
  const evaluations: ForkGcEvaluation[] = [];
  const collected: string[] = [];
  const wouldCollect: string[] = [];
  const errors: Array<{ upstream: string; error: string }> = [];

  for (const up of opts.upstreams) {
    const upstreamFullName = `${up.owner}/${up.repo}`;
    try {
      const evaluation = await evaluateForkForGc({
        upstreamOwner: up.owner,
        upstreamRepo: up.repo,
        octokit: oc,
        ...(opts.retentionMs !== undefined ? { retentionMs: opts.retentionMs } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
      evaluations.push(evaluation);
      if (evaluation.decision !== 'collect') continue;

      if (dryRun) {
        wouldCollect.push(evaluation.forkFullName);
        opts.log?.(`[fork-gc] would collect abandoned fork ${evaluation.forkFullName} (dry-run)`);
        continue;
      }
      // Destructive pass: delete only the operator's own fork.
      const [forkOwner, forkRepo] = evaluation.forkFullName.split('/');
      try {
        await oc.rest.repos.delete({ owner: forkOwner, repo: forkRepo });
        collected.push(evaluation.forkFullName);
        opts.log?.(`[fork-gc] collected abandoned fork ${evaluation.forkFullName}`);
      } catch (delErr: unknown) {
        const msg = delErr instanceof Error ? delErr.message : String(delErr);
        errors.push({ upstream: upstreamFullName, error: `delete failed: ${msg}` });
        opts.log?.(`[fork-gc] delete failed for ${evaluation.forkFullName}: ${msg}`);
      }
    } catch (err: unknown) {
      errors.push({ upstream: upstreamFullName, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { evaluations, collected, wouldCollect, dryRun, errors };
}
