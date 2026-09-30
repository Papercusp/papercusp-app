/**
 * dogfood-roundtrip — the WITNESS for the internal fork→PR dogfood loop (PLAN
 * pr-system-completion-dogfood, PR-5 item 2 / the "Done" assertion).
 *
 * The brief's success criterion is "a real internal contribution round-trips
 * Bee→fork→PR→agent-review→merge to canonical; the WI shows shipped + linked PR".
 * This is the programmatic check of that — given a harness + a PR url, it reads
 * each plane and reports which legs of the loop completed:
 *
 *   prTracked  — the WI↔PR producer (PR-4) wrote a harness_feature_prs row
 *                linking feature_id ↔ pr_url  [REQUIRED]
 *   reviewed   — the agent-reviewer (PR-2) emitted a report for the PR  [OPTIONAL —
 *                gated on PR-2 + the owner's review mode; reported, never required]
 *   merged     — the PR row reached pr_state='merged'  [REQUIRED]
 *   shipped    — the feature row is status='shipped' with a completion_ref stamped
 *                (completion-ref-writer, via the real row not the empty fallback) [REQUIRED]
 *   linked     — the feature_id resolves FROM the PR row, so the planes are
 *                connected, not drifted  [REQUIRED]
 *
 * `ok` is true iff every REQUIRED leg passed. The witness is DECOUPLED from the
 * still-landing PR-2/PR-4 modules: every read is an injected seam, so this
 * compiles + teeth-tests regardless of their state, and the live dogfood wires the
 * real readers. Each default reader is best-effort (null on any error) so the
 * witness degrades to "leg not yet present" rather than throwing.
 */
import type { Sql } from 'postgres';

export interface FeaturePrRowView {
  /** The WI/feature this PR contributes (the link). */
  featureId: string | null;
  /** Current PR state on the host ('open' | 'merged' | 'closed' | 'gone' | ...). */
  prState: string | null;
}

export interface FeatureStatusView {
  status: string | null;
  hasCompletionRef: boolean;
}

export interface ReviewReportView {
  /** approve | request_changes | reject (PR-2's recommendation). */
  recommendation: string | null;
}

export interface DogfoodRoundTripReaders {
  /** Read the WI↔PR row (PR-4 producer). Default: harness_feature_prs by pr_url. */
  readFeaturePrRow?: (opts: {
    workspaceId: string;
    harnessSlug: string;
    prUrl: string;
    sql?: Sql;
  }) => Promise<FeaturePrRowView | null>;
  /** Read the feature ship-state (completion-ref-writer). Default: harness_features_consolidated. */
  readFeatureStatus?: (opts: {
    harnessSlug: string;
    featureId: string;
    sql?: Sql;
  }) => Promise<FeatureStatusView | null>;
  /** Read the agent review report (PR-2). Default: none (gated until PR-2 wires its reader). */
  readReviewReport?: (opts: {
    workspaceId: string;
    harnessSlug: string;
    prUrl: string;
    sql?: Sql;
  }) => Promise<ReviewReportView | null>;
}

export type LegStatus = 'pass' | 'fail' | 'gated';

export interface DogfoodRoundTripVerdict {
  ok: boolean;
  stages: {
    prTracked: LegStatus;
    reviewed: LegStatus;
    merged: LegStatus;
    shipped: LegStatus;
    linked: LegStatus;
  };
  /** The feature this PR resolved to (null when the producer wrote no row). */
  featureId: string | null;
  /** Human-readable list of the legs that are not yet passing (for the runbook). */
  gaps: string[];
}

export interface VerifyDogfoodRoundTripOpts extends DogfoodRoundTripReaders {
  workspaceId: string;
  harnessSlug: string;
  prUrl: string;
  sql?: Sql;
}

/**
 * Check whether the fork→PR dogfood loop round-tripped for `prUrl`. Pure over the
 * injected readers; the REQUIRED legs (prTracked, merged, shipped, linked) decide
 * `ok`. `reviewed` is reported but optional (gated on PR-2 + owner review mode).
 */
export async function verifyDogfoodRoundTrip(
  opts: VerifyDogfoodRoundTripOpts,
): Promise<DogfoodRoundTripVerdict> {
  const readFeaturePrRow = opts.readFeaturePrRow ?? defaultReadFeaturePrRow;
  const readFeatureStatus = opts.readFeatureStatus ?? defaultReadFeatureStatus;
  const readReviewReport = opts.readReviewReport; // no default — gated until injected

  const base = { workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug, prUrl: opts.prUrl, ...(opts.sql ? { sql: opts.sql } : {}) };

  const row = await readFeaturePrRow(base).catch(() => null);
  const featureId = row?.featureId ?? null;

  // prTracked + linked: the producer wrote a row that links feature_id ↔ pr_url.
  const prTracked: LegStatus = featureId ? 'pass' : 'fail';
  const linked: LegStatus = featureId ? 'pass' : 'fail';

  // merged: the PR row reached 'merged'.
  const merged: LegStatus = row?.prState === 'merged' ? 'pass' : 'fail';

  // shipped: the feature is status='shipped' with a completion_ref stamped.
  let shipped: LegStatus = 'fail';
  if (featureId) {
    const status = await readFeatureStatus({
      harnessSlug: opts.harnessSlug,
      featureId,
      ...(opts.sql ? { sql: opts.sql } : {}),
    }).catch(() => null);
    shipped = status && status.status === 'shipped' && status.hasCompletionRef ? 'pass' : 'fail';
  }

  // reviewed: optional. Gated when no reader is wired (PR-2 not yet landed).
  let reviewed: LegStatus = 'gated';
  if (readReviewReport) {
    const report = await readReviewReport(base).catch(() => null);
    reviewed = report && report.recommendation ? 'pass' : 'fail';
  }

  const stages = { prTracked, reviewed, merged, shipped, linked };
  // `ok` requires every NON-gated required leg to pass. `reviewed` never blocks ok.
  const ok = prTracked === 'pass' && merged === 'pass' && shipped === 'pass' && linked === 'pass';

  const gaps: string[] = [];
  if (prTracked !== 'pass') gaps.push('WI↔PR producer wrote no row for this PR (PR-4 not firing / PR not opened via the tracked path)');
  if (linked !== 'pass') gaps.push('PR is not linked to a feature_id (planes drifted)');
  if (merged !== 'pass') gaps.push(`PR not merged (state=${row?.prState ?? 'unknown'})`);
  if (shipped !== 'pass') gaps.push('feature not status=shipped with a completion_ref (merge stamp did not fire)');
  if (reviewed === 'gated') gaps.push('agent-review leg not checked (PR-2 reader not wired — gated)');
  else if (reviewed !== 'pass') gaps.push('no agent review report for this PR (PR-2 did not run)');

  return { ok, stages, featureId, gaps };
}

// ─── default readers (best-effort PG; null on any error) ─────────────────────

async function defaultReadFeaturePrRow(opts: {
  workspaceId: string;
  harnessSlug: string;
  prUrl: string;
  sql?: Sql;
}): Promise<FeaturePrRowView | null> {
  try {
    const sql = opts.sql ?? (await import('@papercusp/db-org')).getOrgPg().sql;
    const rows = await sql<{ feature_id: string | null; pr_state: string | null }[]>`
      SELECT feature_id, pr_state
        FROM harness_shared.harness_feature_prs
       WHERE harness_slug = ${opts.harnessSlug} AND pr_url = ${opts.prUrl}
       LIMIT 1`;
    if (!rows[0]) return null;
    return { featureId: rows[0].feature_id ?? null, prState: rows[0].pr_state ?? null };
  } catch {
    return null;
  }
}

/**
 * Opt-in reader for the `reviewed` leg, wired to PR-2's report store. Pass it as
 * `readReviewReport` in the live dogfood to un-gate the agent-review leg (the
 * witness leaves the leg `gated` when no reader is supplied — it stays decoupled
 * from PR-2 by default). Parses the PR number from the URL → readLatestReviewReport.
 */
export async function defaultReadReviewReport(opts: {
  workspaceId: string;
  harnessSlug: string;
  prUrl: string;
  sql?: Sql;
}): Promise<ReviewReportView | null> {
  try {
    const m = /\/pull\/(\d+)/.exec(opts.prUrl);
    const prNumber = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(prNumber)) return null;
    const { readLatestReviewReport } = await import('./pr-review-report-store');
    const r = await readLatestReviewReport({
      harnessSlug: opts.harnessSlug,
      prNumber,
      workspaceId: opts.workspaceId,
      ...(opts.sql ? { sql: opts.sql } : {}),
    });
    return r ? { recommendation: r.recommendation } : null;
  } catch {
    return null;
  }
}

async function defaultReadFeatureStatus(opts: {
  harnessSlug: string;
  featureId: string;
  sql?: Sql;
}): Promise<FeatureStatusView | null> {
  try {
    const sql = opts.sql ?? (await import('@papercusp/db-org')).getOrgPg().sql;
    const rows = await sql<{ status: string | null; has_ref: boolean }[]>`
      SELECT status, (completion_ref IS NOT NULL) AS has_ref
        FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${opts.harnessSlug} AND feature_id = ${opts.featureId}
       LIMIT 1`;
    if (!rows[0]) return null;
    return { status: rows[0].status ?? null, hasCompletionRef: rows[0].has_ref === true };
  } catch {
    return null;
  }
}
