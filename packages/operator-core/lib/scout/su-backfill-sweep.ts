/**
 * su-backfill-sweep.ts — su-ideate-learning-substrate-2026-07-10 P-016: the one-shot,
 * idempotent backfill that starts the su ideation learning loop with SIGNAL instead
 * of cold. Three legs, each a no-op on re-run:
 *
 *  (a) PRE-BRIDGE FILINGS → LEDGER. su feature filings made BEFORE the capture bridge
 *      (su-loop-capability-parity P-005, live 2026-07-03) never earned a routed-ledger
 *      row. Identification signature (derived live against the corpus, P-016):
 *      engineer_issues with source='su' AND payload->>'improvementKind'='feature' AND
 *      created_at < cutoff AND not already in the ledger. The signature keys on
 *      capture provenance, NOT tags or item_kind — the tags column is empty on these
 *      items and post-bridge filings land item_kind 'change'/'bug'; live separation
 *      is exact (80/80 of in-ledger filings match it, 0/1942 non-ledger items do).
 *      Upserted via {@link recordRoutedIdea} (ON CONFLICT idea_id) with
 *      routed_at = the filing's own created_ts — NOT now — so the D-013 enablement
 *      epoch floor (ungraded-filings-watchdog) keeps the backfilled corpus silent.
 *
 *  (b) created_by BACKFILL. Ledger rows written before migration 558 carry
 *      created_by NULL. Deviation from the sized source, disclosed: P-016 sized this
 *      off feature_audit_consolidated first-actor, but that table audits F- features
 *      only (0/85 EI coverage live); the engineer_issues view exposes the filer
 *      DIRECTLY (created_by — 100% corpus coverage), so the backfill is one
 *      UPDATE-join from it. NULL stays NULL where unrecoverable.
 *
 *  (c) OUTCOME SWEEP. refreshScoutOutcomes over origin='su-ideate' with NO
 *      since-window: the ref-scoped completions read (routed-ledger P-016) joins
 *      every routed ref to its work item's REAL terminal status, immune to the
 *      change feed's top-500 recency window (which covered 2/50 of the resolved
 *      corpus live). No harnessSlug is passed, so the whole workspace corpus sweeps
 *      in one pass; the D-003 guard inside refreshScoutOutcomes keeps
 *      scout_lens_weights untouched for the su origin. Lens history is
 *      UNRECOVERABLE (D-013): legacy rows keep the 'su-ideate' sentinel lens and
 *      per-lens learning accrues from P-002 forward.
 */

import { getOrgPg } from '@papercusp/db-org';
import { recordRoutedIdea, refreshScoutOutcomes } from './routed-ledger';

/** The su-ideate capture bridge went live 2026-07-03 (su-loop-capability-parity P-005). */
export const PRE_BRIDGE_CUTOFF_MS = Date.parse('2026-07-03T00:00:00Z');

/**
 * The harness a scope-less (operator) filing folds under — the same fallback the
 * capture bridge applies at routing time (agent-tools/improvements/capture.ts), so
 * backfilled rows are indistinguishable from what the bridge would have written.
 */
export const DEFAULT_LEDGER_HARNESS = 'papercusp';

/** One pre-bridge su feature filing that is missing from the routed ledger. */
export interface PreBridgeSuFiling {
  issueId: string;
  title: string | null;
  createdBy: string | null;
  /** engineer_issues scope: 'operator' or 'harness:<slug>'. */
  scope: string | null;
  workspaceId: string | null;
  state: string | null;
  /** The filing's created_ts (epoch ms) — becomes the ledger row's routed_at. */
  createdAtMs: number;
}

/** 'harness:<slug>' → slug; operator/blank → the bridge's default harness. */
function harnessFromScope(scope: string | null): string {
  return scope && scope.startsWith('harness:')
    ? scope.slice('harness:'.length)
    : DEFAULT_LEDGER_HARNESS;
}

/**
 * The clause-(c) identification signature, exported so the integration test pins
 * it directly: pre-cutoff su feature filings with no ledger row, oldest first.
 */
export async function findPreBridgeSuFilings(
  cutoffMs = PRE_BRIDGE_CUTOFF_MS,
): Promise<PreBridgeSuFiling[]> {
  const { sql } = getOrgPg();
  const rows = await sql<
    {
      issue_id: string;
      title: string | null;
      created_by: string | null;
      scope: string | null;
      workspace_id: string | null;
      state: string | null;
      created_ms: string;
    }[]
  >`
    SELECT e.issue_id, e.title, e.created_by, e.scope, e.workspace_id, e.state,
           round(EXTRACT(EPOCH FROM e.created_at) * 1000)::bigint AS created_ms
      FROM harness_shared.engineer_issues e
     WHERE e.source = 'su'
       AND e.payload->>'improvementKind' = 'feature'
       AND e.created_at < to_timestamp(${cutoffMs} / 1000.0)
       AND NOT EXISTS (
             SELECT 1 FROM harness_shared.scout_routed_ideas s
              WHERE s.idea_id = e.issue_id
           )
     ORDER BY e.created_at`;
  return rows.map((r) => ({
    issueId: r.issue_id,
    title: r.title,
    createdBy: r.created_by,
    scope: r.scope,
    workspaceId: r.workspace_id,
    state: r.state,
    createdAtMs: Number(r.created_ms),
  }));
}

export interface SuBackfillSweepOptions {
  /**
   * The workspace the corpus lives in — where 'default'-scoped legacy filings fold
   * (the tool-dispatch ALS quirk, EI-346) and the scope of legs (b) and (c).
   */
  workspaceId: string;
  cutoffMs?: number;
  /** Report what WOULD change (candidates + backfillable count) without writing. */
  dryRun?: boolean;
}

export interface SuBackfillSweepResult {
  preBridge: { candidates: number; upserted: string[] };
  createdByBackfilled: number;
  /** origin='su-ideate' outcome distribution after the sweep (current state on dryRun). */
  outcomes: Record<string, number>;
  total: number;
}

/** Run the full P-016 backfill sweep. Idempotent — a second run changes nothing. */
export async function runSuBackfillSweep(
  opts: SuBackfillSweepOptions,
): Promise<SuBackfillSweepResult> {
  const { sql } = getOrgPg();
  const cutoffMs = opts.cutoffMs ?? PRE_BRIDGE_CUTOFF_MS;

  // (a) pre-bridge filings → idempotent ledger upserts. The NOT-EXISTS in the
  // signature makes re-runs find nothing; the upsert itself is conflict-safe anyway.
  const candidates = await findPreBridgeSuFilings(cutoffMs);
  const upserted: string[] = [];
  if (!opts.dryRun) {
    for (const c of candidates) {
      await recordRoutedIdea({
        origin: 'su-ideate',
        ideaId: c.issueId,
        // D-013: lens history is unrecoverable — the sentinel, never a guessed lens.
        lens: 'su-ideate',
        rail: 'improvement',
        routedRef: `wi:${c.issueId}`,
        harnessSlug: harnessFromScope(c.scope),
        workspaceId:
          c.workspaceId && c.workspaceId !== 'default' ? c.workspaceId : opts.workspaceId,
        ...(c.title ? { title: c.title } : {}),
        ...(c.createdBy ? { createdBy: c.createdBy } : {}),
        routedAt: c.createdAtMs,
      });
      upserted.push(c.issueId);
    }
  }

  // (b) created_by backfill — fills NULLs only, so re-runs touch 0 rows.
  let createdByBackfilled = 0;
  if (opts.dryRun) {
    const rows = await sql<{ n: string }[]>`
      SELECT count(*) AS n
        FROM harness_shared.scout_routed_ideas s
        JOIN harness_shared.engineer_issues e
          ON e.issue_id = s.idea_id AND e.created_by IS NOT NULL
       WHERE s.origin = 'su-ideate'
         AND s.created_by IS NULL
         AND s.workspace_id = ${opts.workspaceId}`;
    createdByBackfilled = Number(rows[0]?.n ?? 0);
  } else {
    const updated = await sql<{ idea_id: string }[]>`
      UPDATE harness_shared.scout_routed_ideas s
         SET created_by = e.created_by
        FROM harness_shared.engineer_issues e
       WHERE s.origin = 'su-ideate'
         AND s.created_by IS NULL
         AND s.workspace_id = ${opts.workspaceId}
         AND e.issue_id = s.idea_id
         AND e.created_by IS NOT NULL
       RETURNING s.idea_id`;
    createdByBackfilled = updated.length;
  }

  // (c) the outcome sweep — whole-workspace su corpus, no harness filter.
  if (!opts.dryRun) {
    await refreshScoutOutcomes({ origin: 'su-ideate', workspaceId: opts.workspaceId });
  }

  const dist = await sql<{ outcome: string | null; n: string }[]>`
    SELECT outcome, count(*) AS n
      FROM harness_shared.scout_routed_ideas
     WHERE origin = 'su-ideate' AND workspace_id = ${opts.workspaceId}
     GROUP BY outcome`;
  const outcomes: Record<string, number> = {};
  let total = 0;
  for (const r of dist) {
    outcomes[r.outcome ?? 'null'] = Number(r.n);
    total += Number(r.n);
  }

  return {
    preBridge: { candidates: candidates.length, upserted },
    createdByBackfilled,
    outcomes,
    total,
  };
}
