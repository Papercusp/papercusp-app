/**
 * plan-cleanup/run-store — per-finding outcome rows for a PLAN-CLEANUP bulk run
 * (cleanup-report-flows-2026-08-24 P-002; migration 937).
 *
 * A plan-cleanup run rides the SAME `attention_bulk_runs` machinery as the inbox
 * bulk resolve (attention/bulk-run-store.ts, `runKind: 'plan-cleanup'`); this
 * module is the analog of that store's ITEM half: one row per scanner finding in
 * `plan_cleanup_run_findings`, keyed by the scanner's deterministic `findingId`
 * (`<kind>:<harness>/<plan>[#item]`), which is what makes seeding idempotent
 * across a resolver retry and lets an apply target a finding without
 * translation.
 *
 * The item store's two load-bearing properties hold here identically:
 *
 *  - **Findings are a RUN-SCOPED SNAPSHOT.** `seedFindings` persists what the
 *    scanner emitted for the run's click-time `seedRefs`; nothing re-derives
 *    membership after the owner clicked.
 *  - **Counters are DERIVED, never incremented blind.** `reportFindingOutcomes`
 *    recomputes the run's counters from the finding rows inside the same
 *    transaction, so a retried or re-reported finding cannot double-count.
 *
 * Counter mapping onto the run row's inbox-named columns (the strip renders the
 * same four numbers for either kind):
 *   auto_resolved = auto_applied + accepted   (applied — by the resolver, or by
 *                                              the owner via review accept)
 *   recommended   = recommended               (still awaiting the owner)
 *   skipped       = dismissed + skipped       (deliberately not applied)
 *   failed        = failed
 *
 * Access mirrors bulk-run-store.ts: plain `getOrgPg().sql` with an explicit
 * workspace_id predicate (org handle = table owner, RLS enforced for the
 * runtime app role and bypassed here, like every operator-state table).
 */

import { getOrgPg } from '@papercusp/db-org';
import type { Sql, TransactionSql } from 'postgres';
import { activeWorkspaceId } from '../workspace-registry';
import { RUNNING_PHASES, type BulkRunPhase, type BulkRunRow } from '../attention/bulk-run-store';
import type { CleanupConfidence, CleanupEvidenceRef, CleanupFindingKind } from './scanner';
import {
  canonicalDispositionForRow,
  type BulkConfidence,
  type BulkDispositionKind,
  type BulkRecommendation,
  type BulkRecommendationKind,
  type BulkResponsibility,
  isBulkDispositionKind,
  normalizeBulkAutomationPolicy,
} from '../attention/bulk-dispositions';

/**
 * Row-level finding kind: the scanner's mechanical kinds plus 'semantic' — the
 * resolver's own judgment-pass findings, which have no mechanical scanner rule
 * (migration 937's CHECK admits it for exactly that reason).
 */
export type CleanupRunFindingKind = CleanupFindingKind | 'semantic';

/**
 * Per-finding terminal disposition. Unlike the inbox items' outcome set this
 * distinguishes the OWNER's review verdicts (`accepted` / `dismissed`) from the
 * resolver's (`auto_applied` / `recommended` / `skipped` / `failed`), because a
 * plan-cleanup apply is a plan mutation the audit trail must attribute to the
 * right actor. `pending` is the seeded, not-yet-resolved state — a finding
 * still carrying it when the run settles keeps the run in `review` (see
 * bulk-run-store.settleRunPhase's kind-aware branch) rather than silently
 * vanishing.
 */
export type CleanupFindingOutcome =
  | 'pending'
  | 'auto_applied'
  | 'recommended'
  | 'accepted'
  | 'dismissed'
  | 'skipped'
  | 'failed';

/** What a caller must supply to seed one finding row. The scanner's
 *  `CleanupFinding` satisfies this structurally; a semantic-pass finding
 *  supplies the same fields with `kind: 'semantic'`. */
export interface SeedableCleanupFinding {
  findingId: string;
  kind: CleanupRunFindingKind;
  planSlug: string;
  harnessSlug?: string | null;
  itemId?: string | null;
  target?: string;
  from?: string;
  to?: string;
  confidence?: CleanupConfidence;
  evidence?: CleanupEvidenceRef[];
  recommendationKind?: BulkRecommendationKind | null;
  recommendationLabel?: string | null;
  recommendationRationale?: string | null;
  evidenceBasis?: string[] | null;
  responsibility?: BulkResponsibility | null;
  confidenceLevel?: BulkConfidence | null;
  retryCondition?: string | null;
}

export interface CleanupRunFindingRow {
  workspaceId: string;
  runId: string;
  findingId: string;
  kind: CleanupRunFindingKind;
  planSlug: string;
  harnessSlug: string | null;
  itemId: string | null;
  target: string;
  from: string;
  to: string;
  confidence: CleanupConfidence;
  evidence: CleanupEvidenceRef[];
  position: number;
  outcome: CleanupFindingOutcome;
  error: string | null;
  decidedAt: string | null;
  disposition?: BulkDispositionKind;
  legacyDisposition?: string | null;
  recommendation?: BulkRecommendation | null;
  recommendationKind?: BulkRecommendationKind | null;
  recommendationLabel?: string | null;
  recommendationRationale?: string | null;
  evidenceBasis?: string[];
  responsibility?: BulkResponsibility | null;
  confidenceLevel?: BulkConfidence | null;
  retryCondition?: string | null;
}

/** One resolver/review verdict for one finding. `evidence`, when present,
 *  REPLACES the stored evidence (the resolver re-verified at current state, so
 *  its refs supersede the scan-time ones). */
export interface CleanupFindingOutcomeReport {
  findingId: string;
  outcome: Exclude<CleanupFindingOutcome, 'pending'>;
  error?: string | null;
  evidence?: CleanupEvidenceRef[] | null;
  disposition?: BulkDispositionKind | null;
  recommendationKind?: BulkRecommendationKind | null;
  recommendationLabel?: string | null;
  recommendationRationale?: string | null;
  evidenceBasis?: string[] | null;
  responsibility?: BulkResponsibility | null;
  confidenceLevel?: BulkConfidence | null;
  retryCondition?: string | null;
}

function dispositionForFindingReport(report: CleanupFindingOutcomeReport): BulkDispositionKind {
  if (report.disposition && isBulkDispositionKind(report.disposition)) {
    return report.disposition;
  }
  if (report.outcome === 'auto_applied' || report.outcome === 'accepted') return 'auto_resolved';
  if (report.outcome === 'skipped') return 'legacy_skipped';
  return report.outcome as BulkDispositionKind;
}

/** Why a write was refused. Same contract shape as the item store's refusals:
 *  the DB is never half-written when one of these comes back. */
export type CleanupFindingWriteRefusal =
  | { reason: 'run_not_found'; phase: null }
  | { reason: 'run_wrong_kind'; phase: BulkRunPhase }
  | { reason: 'run_authority_revoked'; phase: BulkRunPhase }
  | { reason: 'resolver_owner_mismatch'; phase: BulkRunPhase }
  | { reason: 'finding_not_in_run'; phase: BulkRunPhase };

function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function asEvidence(v: unknown): CleanupEvidenceRef[] {
  return Array.isArray(v) ? (v as CleanupEvidenceRef[]) : [];
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((entry): entry is string => typeof entry === 'string');
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

interface RawFindingRow {
  workspace_id: string;
  run_id: string;
  finding_id: string;
  finding_kind: CleanupRunFindingKind;
  plan_slug: string;
  harness_slug: string | null;
  item_id: string | null;
  target: string;
  from_state: string;
  to_state: string;
  confidence: CleanupConfidence;
  evidence: unknown;
  position: number | string;
  outcome: CleanupFindingOutcome;
  error: string | null;
  decided_at: Date | string | null;
  disposition: string | null;
  recommendation_kind: BulkRecommendationKind | null;
  recommendation_label: string | null;
  recommendation_rationale: string | null;
  evidence_basis: unknown;
  responsibility: BulkResponsibility | null;
  confidence_level: BulkConfidence | null;
  retry_condition: string | null;
}

function mapFinding(r: RawFindingRow): CleanupRunFindingRow {
  const normalizedOutcome =
    r.outcome === 'auto_applied' || r.outcome === 'accepted'
      ? 'auto_resolved'
      : r.outcome;
  const rawDisposition = r.disposition;
  const canonical = canonicalDispositionForRow({
    outcome: normalizedOutcome,
    disposition:
      rawDisposition && isBulkDispositionKind(rawDisposition)
        ? rawDisposition
        : null,
    itemKind: 'plan-cleanup',
    title: r.target,
    error: r.error,
    itemId: r.finding_id,
  });
  const recommendation =
    r.recommendation_kind && r.recommendation_label && r.recommendation_rationale
      ? {
          kind: r.recommendation_kind,
          label: r.recommendation_label,
          rationale: r.recommendation_rationale,
          evidenceBasis: asStringArray(r.evidence_basis),
          confidence: r.confidence_level ?? 'insufficient',
          responsibility: r.responsibility ?? 'unknown',
          actionId: null,
          retryCondition: r.retry_condition,
          targetRef: r.finding_id,
        }
      : canonical.recommendation;
  return {
    workspaceId: r.workspace_id,
    runId: r.run_id,
    findingId: r.finding_id,
    kind: r.finding_kind,
    planSlug: r.plan_slug,
    harnessSlug: r.harness_slug,
    itemId: r.item_id,
    target: r.target,
    from: r.from_state,
    to: r.to_state,
    confidence: r.confidence,
    evidence: asEvidence(r.evidence),
    position: Number(r.position ?? 0),
    outcome: r.outcome,
    error: r.error,
    decidedAt: iso(r.decided_at),
    disposition: canonical.disposition,
    legacyDisposition:
      rawDisposition && rawDisposition !== canonical.disposition ? rawDisposition : null,
    recommendation,
    recommendationKind: r.recommendation_kind ?? recommendation?.kind ?? null,
    recommendationLabel: r.recommendation_label ?? recommendation?.label ?? null,
    recommendationRationale: r.recommendation_rationale ?? recommendation?.rationale ?? null,
    evidenceBasis: asStringArray(r.evidence_basis ?? recommendation?.evidenceBasis),
    responsibility: r.responsibility ?? recommendation?.responsibility ?? null,
    confidenceLevel: r.confidence_level ?? recommendation?.confidence ?? null,
    retryCondition: r.retry_condition ?? recommendation?.retryCondition ?? null,
  };
}

const FINDING_COLUMNS = `workspace_id, run_id, finding_id, finding_kind, plan_slug, harness_slug,
                         item_id, target, from_state, to_state, confidence, evidence, position,
                         outcome, error, decided_at, disposition, recommendation_kind,
                         recommendation_label, recommendation_rationale, evidence_basis,
                         responsibility, confidence_level, retry_condition`;

const RUN_COLUMNS = `run_id, workspace_id, harness_slug, requested_by, resolver_owner, phase,
                     run_kind, seed_refs, filter_snapshot, launch_snapshot,
                     automation_policy,
                     total_items, auto_resolved, recommended, skipped, failed,
                     error, created_at, updated_at, started_at, finished_at, heartbeat_at`;

type StoreSql = Sql | TransactionSql;

/**
 * Recompute the run's strip counters from its FINDING rows (the plan-cleanup
 * analog of the item store's recomputeCounters — same derive-don't-increment
 * rule, different source table and outcome mapping; see the module header).
 */
async function recomputeCountersFromFindings(sql: StoreSql, runId: string, workspaceId: string): Promise<void> {
  await sql`
    UPDATE harness_shared.attention_bulk_runs r
       SET auto_resolved = c.auto_resolved,
           recommended = c.recommended,
           skipped = c.skipped,
           failed = c.failed,
           updated_at = now()
      FROM (
        SELECT
          COUNT(*) FILTER (WHERE outcome IN ('auto_applied', 'accepted'))::int AS auto_resolved,
          COUNT(*) FILTER (WHERE outcome = 'recommended')::int                 AS recommended,
          COUNT(*) FILTER (WHERE outcome IN ('dismissed', 'skipped'))::int     AS skipped,
          COUNT(*) FILTER (WHERE outcome = 'failed')::int                      AS failed
          FROM harness_shared.plan_cleanup_run_findings
         WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
      ) c
     WHERE r.workspace_id = ${workspaceId} AND r.run_id = ${runId}
  `;
}

/** Lock the run row and refuse anything that is not a live plan-cleanup run.
 *  Shared preamble of both write paths, inside their transaction. */
async function lockLiveCleanupRun(
  tx: TransactionSql,
  runId: string,
  workspaceId: string,
  resolverOwner?: string | null,
): Promise<{ phase: BulkRunPhase; refused: CleanupFindingWriteRefusal | null }> {
  const rows = await tx<{ phase: BulkRunPhase; run_kind: string | null; resolver_owner: string | null }[]>`
    SELECT phase, run_kind, resolver_owner
      FROM harness_shared.attention_bulk_runs
     WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
     FOR UPDATE
  `;
  if (!rows[0]) return { phase: 'failed', refused: { reason: 'run_not_found', phase: null } };
  const { phase } = rows[0];
  if (rows[0].run_kind !== 'plan-cleanup') return { phase, refused: { reason: 'run_wrong_kind', phase } };
  if (resolverOwner && rows[0].resolver_owner !== resolverOwner)
    return { phase, refused: { reason: 'resolver_owner_mismatch', phase } };
  // Same rule as the item store's ACCEPTING_REPORTS: Stop/settle revokes the
  // resolver's authority, so a write after that must land nowhere.
  if (!RUNNING_PHASES.includes(phase)) return { phase, refused: { reason: 'run_authority_revoked', phase } };
  return { phase, refused: null };
}

/**
 * Seed (or refresh) the run's finding rows from a scan. Idempotent by
 * `findingId`: a retried resolver re-seeds the same identities without error, a
 * re-scan refreshes the descriptive fields (target/from/to/confidence/evidence/
 * position) — and `outcome`/`error`/`decided_at` are deliberately NOT touched,
 * so a re-seed can never roll back work already resolved.
 *
 * Position is the array index (the scanner emits a deterministic order), so the
 * review list renders stably across retries.
 */
export async function seedFindings(input: {
  runId: string;
  findings: readonly SeedableCleanupFinding[];
  resolverOwner?: string | null;
  workspaceId?: string;
}): Promise<{ findings: CleanupRunFindingRow[]; refused: CleanupFindingWriteRefusal | null }> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();

  // De-dupe defensively (mirror createRun): a duplicate findingId would make
  // the second upsert overwrite the first row's position mid-seed.
  const seen = new Set<string>();
  const unique = (input.findings ?? []).filter((f) => {
    if (!f?.findingId || seen.has(f.findingId)) return false;
    seen.add(f.findingId);
    return true;
  });

  return await sql.begin(async (tx) => {
    const { refused } = await lockLiveCleanupRun(tx, input.runId, ws, input.resolverOwner);
    if (refused) return { findings: [], refused };

    const rows: CleanupRunFindingRow[] = [];
    for (let i = 0; i < unique.length; i += 1) {
      const f = unique[i]!;
      const inserted = await tx<RawFindingRow[]>`
        INSERT INTO harness_shared.plan_cleanup_run_findings
          (workspace_id, run_id, finding_id, finding_kind, plan_slug, harness_slug,
           item_id, target, from_state, to_state, confidence, evidence, position,
           disposition, recommendation_kind, recommendation_label, recommendation_rationale,
           evidence_basis, responsibility, confidence_level, retry_condition)
        VALUES (${ws}, ${input.runId}, ${f.findingId}, ${f.kind}, ${f.planSlug},
                ${f.harnessSlug ?? null}, ${f.itemId ?? null}, ${f.target ?? ''},
                ${f.from ?? ''}, ${f.to ?? ''}, ${f.confidence ?? 'recommended'},
                ${JSON.stringify(f.evidence ?? [])}::jsonb, ${i}, 'pending',
                ${f.recommendationKind ?? null}, ${f.recommendationLabel ?? null},
                ${f.recommendationRationale ?? null},
                ${JSON.stringify(f.evidenceBasis ?? [])}::jsonb,
                ${f.responsibility ?? null},
                ${f.confidenceLevel ?? (f.confidence === 'provable' ? 'high' : 'medium')},
                ${f.retryCondition ?? null})
        ON CONFLICT (workspace_id, run_id, finding_id) DO UPDATE
          SET finding_kind = EXCLUDED.finding_kind,
              plan_slug = EXCLUDED.plan_slug,
              harness_slug = EXCLUDED.harness_slug,
              item_id = EXCLUDED.item_id,
              target = EXCLUDED.target,
              from_state = EXCLUDED.from_state,
              to_state = EXCLUDED.to_state,
              confidence = EXCLUDED.confidence,
              evidence = EXCLUDED.evidence,
              position = EXCLUDED.position,
              updated_at = now()
        RETURNING ${tx.unsafe(FINDING_COLUMNS)}
      `;
      if (inserted[0]) rows.push(mapFinding(inserted[0]));
    }
    return { findings: rows, refused: null };
  });
}

/**
 * Execute one cleanup mutation while holding the run row as the revocable
 * authority token. This is the plan-cleanup counterpart of
 * `executeBulkRunAction`: Stop/settle and the mutation serialize on the SAME
 * row lock, the finding is locked before the callback starts, and the outcome
 * plus counters commit before authority is released.
 *
 * The callback must dispatch through the canonical plan/claim write seam. It
 * deliberately receives the locked snapshot so a caller cannot accidentally
 * target a different finding after acquiring authority.
 */
export async function executeCleanupFindingAction<T>(input: {
  runId: string;
  findingId: string;
  /** Human-readable reason supplied by the resolver for this auto action.
   *  Persisted on the existing evidence ledger in the same transaction as the
   *  mutation outcome, so a reloaded report never loses the decision's why. */
  rationale?: string | null;
  recommendationKind?: BulkRecommendationKind | null;
  recommendationLabel?: string | null;
  recommendationRationale?: string | null;
  evidenceBasis?: string[] | null;
  responsibility?: BulkResponsibility | null;
  confidenceLevel?: BulkConfidence | null;
  retryCondition?: string | null;
  resolverOwner?: string | null;
  workspaceId?: string;
  execute: (finding: CleanupRunFindingRow) => Promise<T>;
}): Promise<{
  actionResult: T | null;
  finding: CleanupRunFindingRow | null;
  run: BulkRunRow | null;
  refused: CleanupFindingWriteRefusal | null;
}> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();

  return await sql.begin(async (tx) => {
    const { phase, refused } = await lockLiveCleanupRun(tx, input.runId, ws, input.resolverOwner);
    if (refused) return { actionResult: null, finding: null, run: null, refused };

    const findingRows = await tx<RawFindingRow[]>`
      SELECT ${tx.unsafe(FINDING_COLUMNS)}
        FROM harness_shared.plan_cleanup_run_findings
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
         AND finding_id = ${input.findingId}
       FOR UPDATE
    `;
    const locked = findingRows[0] ? mapFinding(findingRows[0]) : null;
    if (!locked) {
      return {
        actionResult: null,
        finding: null,
        run: null,
        refused: { reason: 'finding_not_in_run' as const, phase },
      };
    }

    const actionResult = await input.execute(locked);
    const rationale = input.rationale?.trim() ?? '';
    const rationaleNote = rationale ? `resolver auto-action rationale: ${rationale}` : null;
    const evidence =
      rationaleNote &&
      !locked.evidence.some(
        (entry) => entry.kind === 'plan' && entry.ref === locked.planSlug && entry.note === rationaleNote,
      )
        ? [...locked.evidence, { kind: 'plan' as const, ref: locked.planSlug, note: rationaleNote }]
        : locked.evidence;
    const updatedRows = await tx<RawFindingRow[]>`
      UPDATE harness_shared.plan_cleanup_run_findings
         SET outcome = 'auto_applied',
             disposition = 'auto_resolved',
             recommendation_kind = ${input.recommendationKind ?? null},
             recommendation_label = ${input.recommendationLabel ?? null},
             recommendation_rationale = ${input.recommendationRationale ?? input.rationale ?? null},
             evidence_basis = ${JSON.stringify(input.evidenceBasis ?? [])}::jsonb,
             responsibility = ${input.responsibility ?? null},
             confidence_level = ${input.confidenceLevel ?? 'high'},
             retry_condition = ${input.retryCondition ?? null},
             evidence = ${JSON.stringify(evidence)}::jsonb,
             error = NULL,
             decided_at = now(),
             updated_at = now()
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
         AND finding_id = ${input.findingId}
      RETURNING ${tx.unsafe(FINDING_COLUMNS)}
    `;
    await recomputeCountersFromFindings(tx, input.runId, ws);
    const runRows = await tx<Parameters<typeof mapRunLoose>[0][]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
    `;
    return {
      actionResult,
      finding: updatedRows[0] ? mapFinding(updatedRows[0]) : null,
      run: runRows[0] ? mapRunLoose(runRows[0]) : null,
      refused: null,
    };
  });
}

/**
 * Record resolver (or review) verdicts for findings and recompute the run's
 * counters in the same transaction. A findingId that was never seeded is
 * reported back in `missing` rather than silently dropped — the resolver
 * mis-targeting a finding is a bug its caller must see.
 */
export async function reportFindingOutcomes(input: {
  runId: string;
  reports: readonly CleanupFindingOutcomeReport[];
  resolverOwner?: string | null;
  workspaceId?: string;
}): Promise<{
  updated: CleanupRunFindingRow[];
  missing: string[];
  run: BulkRunRow | null;
  refused: CleanupFindingWriteRefusal | null;
}> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();

  return await sql.begin(async (tx) => {
    const { refused } = await lockLiveCleanupRun(tx, input.runId, ws, input.resolverOwner);
    if (refused) return { updated: [], missing: [], run: null, refused };

    const updated: CleanupRunFindingRow[] = [];
    const missing: string[] = [];
    for (const report of input.reports ?? []) {
      const disposition = dispositionForFindingReport(report);
      const rows = await tx<RawFindingRow[]>`
        UPDATE harness_shared.plan_cleanup_run_findings
           SET outcome = ${report.outcome},
               disposition = ${disposition},
               recommendation_kind = ${report.recommendationKind ?? null},
               recommendation_label = ${report.recommendationLabel ?? null},
               recommendation_rationale = ${report.recommendationRationale ?? null},
               evidence_basis = ${JSON.stringify(report.evidenceBasis ?? [])}::jsonb,
               responsibility = ${report.responsibility ?? null},
               confidence_level = ${report.confidenceLevel ?? null},
               retry_condition = ${report.retryCondition ?? null},
               error = ${report.error ?? null},
               evidence = CASE WHEN ${report.evidence != null}
                               THEN ${JSON.stringify(report.evidence ?? [])}::jsonb
                               ELSE evidence END,
               decided_at = now(),
               updated_at = now()
         WHERE workspace_id = ${ws} AND run_id = ${input.runId}
           AND finding_id = ${report.findingId}
        RETURNING ${tx.unsafe(FINDING_COLUMNS)}
      `;
      if (rows[0]) updated.push(mapFinding(rows[0]));
      else missing.push(report.findingId);
    }

    await recomputeCountersFromFindings(tx, input.runId, ws);
    const runRows = await tx<Parameters<typeof mapRunLoose>[0][]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
    `;
    return {
      updated,
      missing,
      run: runRows[0] ? mapRunLoose(runRows[0]) : null,
      refused: null,
    };
  });
}

/** Materialize P-001 typed recommendations for legacy skipped cleanup findings.
 * Metadata-only: finding outcome, run membership, and terminal outcomes are
 * preserved exactly. */
export async function reclassifyLegacyFindings(input: {
  runId: string;
  findingIds?: readonly string[];
  workspaceId?: string;
}): Promise<{
  updated: CleanupRunFindingRow[];
  run: BulkRunRow | null;
  refused: 'run_not_found' | 'not_in_review' | null;
}> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const requested = [...new Set((input.findingIds ?? []).map((id) => id.trim()).filter(Boolean))];
  return await sql.begin(async (tx) => {
    const runRows = await tx<Parameters<typeof mapRunLoose>[0][]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
       FOR UPDATE
    `;
    if (!runRows[0]) return { updated: [], run: null, refused: 'run_not_found' as const };
    const run = mapRunLoose(runRows[0]);
    if (run.phase !== 'review') return { updated: [], run, refused: 'not_in_review' as const };
    const rows = await tx<RawFindingRow[]>`
      SELECT ${tx.unsafe(FINDING_COLUMNS)}
        FROM harness_shared.plan_cleanup_run_findings
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
         AND outcome = 'skipped'
         AND (disposition IS NULL OR disposition IN ('legacy_skipped', 'skipped'))
         AND (${requested.length === 0} OR finding_id = ANY(${requested}))
       ORDER BY position ASC
       FOR UPDATE
    `;
    const updated: CleanupRunFindingRow[] = [];
    for (const row of rows) {
      const classified = canonicalDispositionForRow({
        outcome: 'skipped',
        disposition: 'legacy_skipped',
        itemKind: row.finding_kind,
        title: row.target,
        error: row.error,
        itemId: row.finding_id,
      });
      const rec = classified.recommendation;
      if (!rec) continue;
      const changed = await tx<RawFindingRow[]>`
        UPDATE harness_shared.plan_cleanup_run_findings
           SET disposition = ${classified.disposition},
               recommendation_kind = ${rec.kind},
               recommendation_label = ${rec.label},
               recommendation_rationale = ${rec.rationale},
               evidence_basis = ${JSON.stringify(rec.evidenceBasis)}::jsonb,
               responsibility = ${rec.responsibility},
               confidence_level = ${rec.confidence},
               retry_condition = ${rec.retryCondition ?? null},
               updated_at = now()
         WHERE workspace_id = ${ws} AND run_id = ${input.runId}
           AND finding_id = ${row.finding_id}
        RETURNING ${tx.unsafe(FINDING_COLUMNS)}
      `;
      if (changed[0]) updated.push(mapFinding(changed[0]));
    }
    const refreshed = await tx<Parameters<typeof mapRunLoose>[0][]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
    `;
    return {
      updated,
      run: refreshed[0] ? mapRunLoose(refreshed[0]) : run,
      refused: null,
    };
  });
}

/**
 * Record the OWNER's acceptance after the client has successfully dispatched
 * the canonical hand-edit path. Resolve-first/record-second mirrors
 * `markItemAccepted` for Inbox bulk resolve: a bookkeeping failure may leave a
 * stale review row, but can never claim a plan mutation happened when it did
 * not. This seam also reconciles a manual edit after a live recheck proves the
 * finding disappeared, so every unresolved outcome is admissible in `review`;
 * already-terminal rows are immutable. The resolver's pending/running
 * authority uses executeCleanupFindingAction instead.
 */
export async function markCleanupFindingAccepted(input: {
  runId: string;
  findingId: string;
  note?: string | null;
  workspaceId?: string;
}): Promise<{ finding: CleanupRunFindingRow | null; run: BulkRunRow | null }> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();

  return await sql.begin(async (tx) => {
    const runRows = await tx<Parameters<typeof mapRunLoose>[0][]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
       FOR UPDATE
    `;
    const run = runRows[0] ? mapRunLoose(runRows[0]) : null;
    if (!run || run.runKind !== 'plan-cleanup' || run.phase !== 'review') {
      return { finding: null, run };
    }

    const rows = await tx<RawFindingRow[]>`
      SELECT ${tx.unsafe(FINDING_COLUMNS)}
        FROM harness_shared.plan_cleanup_run_findings
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
         AND finding_id = ${input.findingId}
       FOR UPDATE
    `;
    const current = rows[0] ? mapFinding(rows[0]) : null;
    if (!current || ['auto_applied', 'accepted', 'dismissed'].includes(current.outcome)) {
      return { finding: null, run };
    }

    const evidence = input.note?.trim()
      ? [
          ...current.evidence,
          { kind: 'plan' as const, ref: current.planSlug, note: `owner accepted: ${input.note.trim()}` },
        ]
      : current.evidence;
    const updatedRows = await tx<RawFindingRow[]>`
      UPDATE harness_shared.plan_cleanup_run_findings
         SET outcome = 'accepted',
             disposition = 'auto_resolved',
             evidence = ${JSON.stringify(evidence)}::jsonb,
             error = NULL,
             decided_at = now(),
             updated_at = now()
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
         AND finding_id = ${input.findingId}
      RETURNING ${tx.unsafe(FINDING_COLUMNS)}
    `;
    await recomputeCountersFromFindings(tx, input.runId, ws);
    const afterRows = await tx<Parameters<typeof mapRunLoose>[0][]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
    `;
    return {
      finding: updatedRows[0] ? mapFinding(updatedRows[0]) : null,
      run: afterRows[0] ? mapRunLoose(afterRows[0]) : null,
    };
  });
}

/** Record the OWNER deliberately declining one unresolved cleanup finding.
 * Resolver `skipped`/`failed` and never-reached `pending` are evidence about
 * the pass, not owner decisions; this distinct terminal outcome is what lets
 * settlement close honestly without hiding the unresolved row. */
export async function markCleanupFindingDismissed(input: {
  runId: string;
  findingId: string;
  note?: string | null;
  workspaceId?: string;
}): Promise<{ finding: CleanupRunFindingRow | null; run: BulkRunRow | null }> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();

  return await sql.begin(async (tx) => {
    const runRows = await tx<Parameters<typeof mapRunLoose>[0][]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
       FOR UPDATE
    `;
    const run = runRows[0] ? mapRunLoose(runRows[0]) : null;
    if (!run || run.runKind !== 'plan-cleanup' || run.phase !== 'review') {
      return { finding: null, run };
    }

    const rows = await tx<RawFindingRow[]>`
      SELECT ${tx.unsafe(FINDING_COLUMNS)}
        FROM harness_shared.plan_cleanup_run_findings
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
         AND finding_id = ${input.findingId}
       FOR UPDATE
    `;
    const current = rows[0] ? mapFinding(rows[0]) : null;
    if (!current || ['auto_applied', 'accepted', 'dismissed'].includes(current.outcome)) {
      return { finding: null, run };
    }
    const note = input.note?.trim() || 'Owner deliberately dismissed this review finding';
    const evidence = [
      ...current.evidence,
      { kind: 'plan' as const, ref: current.planSlug, note: `owner dismissed: ${note}` },
    ];
    const updatedRows = await tx<RawFindingRow[]>`
      UPDATE harness_shared.plan_cleanup_run_findings
         SET outcome = 'dismissed',
             disposition = 'dismissed',
             evidence = ${JSON.stringify(evidence)}::jsonb,
             error = NULL,
             decided_at = now(),
             updated_at = now()
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
         AND finding_id = ${input.findingId}
      RETURNING ${tx.unsafe(FINDING_COLUMNS)}
    `;
    await recomputeCountersFromFindings(tx, input.runId, ws);
    const afterRows = await tx<Parameters<typeof mapRunLoose>[0][]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
    `;
    return {
      finding: updatedRows[0] ? mapFinding(updatedRows[0]) : null,
      run: afterRows[0] ? mapRunLoose(afterRows[0]) : null,
    };
  });
}

/**
 * Minimal run mapper for this module's refreshed-run read. Kept local (rather
 * than importing bulk-run-store's private mapRun) but shaped identically to
 * BulkRunRow, so callers see one run type either way.
 */
function mapRunLoose(r: {
  run_id: string;
  workspace_id: string;
  harness_slug: string | null;
  requested_by: string | null;
  resolver_owner: string | null;
  phase: BulkRunPhase;
  run_kind: string | null;
  seed_refs: unknown;
  filter_snapshot: unknown;
  launch_snapshot: unknown;
  automation_policy?: unknown;
  total_items: number | string;
  auto_resolved: number | string;
  recommended: number | string;
  skipped: number | string;
  failed: number | string;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  heartbeat_at: Date | string | null;
}): BulkRunRow {
  return {
    runId: r.run_id,
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    requestedBy: r.requested_by,
    resolverOwner: r.resolver_owner,
    phase: r.phase,
    runKind: (r.run_kind ?? 'inbox-resolve') as BulkRunRow['runKind'],
    seedRefs: Array.isArray(r.seed_refs) ? (r.seed_refs as string[]) : [],
    filterSnapshot: (r.filter_snapshot ?? {}) as BulkRunRow['filterSnapshot'],
    launchSnapshot: (r.launch_snapshot ?? {}) as BulkRunRow['launchSnapshot'],
    automationPolicy: normalizeBulkAutomationPolicy(
      (r.automation_policy ?? {}) as Record<string, unknown>,
    ),
    totalItems: Number(r.total_items ?? 0),
    autoResolved: Number(r.auto_resolved ?? 0),
    recommended: Number(r.recommended ?? 0),
    skipped: Number(r.skipped ?? 0),
    failed: Number(r.failed ?? 0),
    error: r.error,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    heartbeatAt: iso(r.heartbeat_at),
  };
}

/** One run's findings, in scanner order (the review list's read — migration
 *  937's plan_cleanup_run_findings_run_idx covers exactly this). */
export async function getRunFindings(runId: string, workspaceId?: string): Promise<CleanupRunFindingRow[]> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawFindingRow[]>`
    SELECT ${sql.unsafe(FINDING_COLUMNS)}
      FROM harness_shared.plan_cleanup_run_findings
     WHERE workspace_id = ${ws} AND run_id = ${runId}
     ORDER BY position ASC
  `;
  return rows.map(mapFinding);
}

/**
 * Findings still awaiting the OWNER's review verdict: what the resolver
 * recommended. Mirrors the item store's getPendingReviewItems (outcome =
 * 'recommended' only): a still-`pending` finding was never reached by the
 * resolver — it keeps the run out of `complete` (settleRunPhase's kind-aware
 * branch), but it is not a recommendation the owner can act on.
 */
export async function getPendingReviewFindings(runId: string, workspaceId?: string): Promise<CleanupRunFindingRow[]> {
  const findings = await getRunFindings(runId, workspaceId);
  return findings.filter((f) => f.outcome === 'recommended');
}
