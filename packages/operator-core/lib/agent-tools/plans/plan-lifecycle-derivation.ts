/**
 * plan-lifecycle-derivation.ts — gather the two I/O-bound signals the pure
 * lifecycle derivation needs, and compose them into a read-time verdict.
 *
 * P-003 of deterministic-plan-state-derivation-2026-08-31, the sibling of
 * P-002's `now-next-derivation`. The judgment lives in `@papercusp/plan-parser`
 * (`derivePlanLifecycle` / `reconcilePlanLifecycle`, pure); everything here is
 * the part that must touch Postgres, kept separate so the verdict logic stays
 * testable without a database and reusable by any surface.
 *
 * # The freshness signal reports only what has a real writer
 *
 * P-003 asked for three activity signals: last item transition, last linked
 * work-item transition, last plan write. Only TWO of them exist.
 *
 * `harness_shared.plan_items.updated_at` looks exactly like a per-item
 * transition stamp and is not one: `plan-index-rows.ts` rebuilds the whole
 * index by DELETE+INSERT on every plan write, so every row of a plan carries
 * the same value — the plan's write time. Verified 2026-08-31 across the
 * papercusp corpus: `min(updated_at) = max(updated_at) = harness_plans.updated_at`
 * on every sampled plan. Emitting it as `lastItemTransitionAt` would present
 * the plan-write timestamp twice under two names, the second of which promises
 * a granularity nothing measures — the exact defect class this plan exists to
 * remove. No per-item transition history exists (`plan_revisions` stores whole
 * content snapshots, not item edges).
 *
 * So item transitions are covered IMPLICITLY, by the plan write they cause: a
 * status flip goes through `plans:set-status`, which writes the plan. What is
 * lost is the ability to distinguish "an item moved" from "someone reworded the
 * prose" — and for the question this signal answers (has anything moved at
 * all?) that distinction does not change the verdict. `sources` names each
 * measured signal so a reader can see which ones actually contributed rather
 * than inferring it from a single fused timestamp.
 *
 * `harness_plans.updated_at` was checked for the bulk-touch failure mode before
 * being trusted (a column every sweep bumps reports everything as fresh):
 * across 1,572 papercusp plans the ages spread 0–103 days with 810 older than
 * 30, and no single day holds more than 87 rows. It tracks real writes.
 *
 * Read-only. Nothing here mutates a plan, and every query is best-effort: a
 * signal that cannot be read comes back UNMEASURED, never defaulted to a value
 * that would read as evidence.
 */

import {
  derivePlanLifecycle,
  reconcilePlanLifecycle,
  type PlanFreshnessSignal,
  type PlanItem,
  type PlanLifecycleReconciliation,
  type PlanLifecycleSignals,
} from '@papercusp/plan-parser';
import type { GrindingMark } from '../../verification-attempts/plan-grinding';
import type { IterationMetric } from '../../verification-attempts/plan-iteration-metrics';

/** One measured activity timestamp and where it came from. */
export interface PlanActivitySource {
  source: string;
  at: string | null;
}

/**
 * Normalize the timestamp shapes these tables actually store: `timestamptz`
 * (Date or ISO string) and epoch-millisecond `bigint` (number, or a string —
 * postgres-js returns bigint as a string to avoid precision loss).
 *
 * Returns `null` for anything unparseable rather than a fallback instant: a
 * bad value must not become evidence of activity.
 */
export function normalizeActivityTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // An all-digit string is an epoch-millisecond bigint, not a date literal.
    // `Date.parse('1756645200000')` is NaN, so without this branch every
    // work-item timestamp would silently read as unmeasurable.
    if (/^\d+$/.test(trimmed)) {
      const ms = Number(trimmed);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

/**
 * Fuse the measured activity sources into the freshness signal.
 *
 * The fused `lastActivityAt` is the NEWEST of them — the question is "has
 * anything moved", so any one source moving is enough. Sources that could not
 * be read ride along with `at: null` rather than being dropped, so the reader
 * can tell a signal that was checked and empty from one never checked at all.
 */
export function buildPlanFreshness(
  sources: readonly PlanActivitySource[],
  now: string,
): PlanFreshnessSignal {
  const normalized = sources.map((s) => ({ source: s.source, at: normalizeActivityTimestamp(s.at) }));
  let newest: string | null = null;
  for (const s of normalized) {
    if (s.at && (newest === null || Date.parse(s.at) > Date.parse(newest))) newest = s.at;
  }
  return { lastActivityAt: newest, sources: normalized, now };
}

/**
 * Which plans have an ACTIVE acceptance rubric, for a batch of slugs.
 *
 * ⚠ THE `NULLIF(... ) IS NOT NULL` PREDICATE IS LOAD-BEARING — DO NOT "SIMPLIFY"
 * IT AWAY. It is redundant to a human reading the query (a `subjectPlan` that
 * equals a non-empty slug is obviously not empty) and it is what lets Postgres
 * prove this query implies the predicate of the partial unique index
 * `harness_plans_one_active_acceptance_per_subject_plan`. Measured on live data
 * 2026-08-31, dropping it costs a full table scan of `harness_plans` on EVERY
 * plan read: Seq Scan, 726 buffers, 6.07ms → Index Scan, 8 buffers, 0.12ms with
 * it. Every other conjunct is likewise copied from the index predicate for the
 * same reason, not from a guess about what "active" should mean.
 *
 * Returns slug → the rubric plan's slug. An absent key means NO active
 * acceptance rubric; a thrown query means the caller reports the acceptance
 * axis as unmeasured (see `gatherPlanLifecycleSignals`), which the derivation
 * keeps distinct from "measured false".
 */
/** Shared statement: both the standalone reader and the source-read subquery
 * use this exact predicate, including the partial-index conjuncts. */
export function activeAcceptanceRubricsQuery(
  tx: import('postgres').Sql,
  input: { workspaceId: string; planSlugs: readonly string[] },
) {
  return tx<{ plan_slug: string; subject_plan: string }[]>`
    SELECT plan_slug, template_data ->> 'subjectPlan' AS subject_plan
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${input.workspaceId}
       AND template = 'rubric'
       AND template_slug IS NULL
       AND archived = false
       AND status = ANY(ARRAY['active', 'ready'])
       AND template_data ->> 'kind' = 'acceptance'
       AND NULLIF(template_data ->> 'subjectPlan', '') IS NOT NULL
       AND template_data ->> 'subjectPlan' = ANY(${[...input.planSlugs]})
  `;
}

export async function readActiveAcceptanceRubrics(input: {
  workspaceId: string;
  planSlugs: readonly string[];
  timings?: Record<string, number>;
}): Promise<Map<string, string>> {
  if (input.planSlugs.length === 0) return new Map();
  let stageStarted = input.timings ? performance.now() : 0;
  const mark = (stage: string) => {
    if (!input.timings) return;
    const now = performance.now();
    input.timings[`lifecycle.${stage}`] = Math.max(0, now - stageStarted);
    stageStarted = now;
  };
  const { withWorkspace } = await import('@papercusp/db-org');
  mark('loadReader');
  const rows = await withWorkspace(
    input.workspaceId,
    async (tx) => {
      mark('acquireAndSetup');
      const rows = await activeAcceptanceRubricsQuery(tx, input);
      mark('query');
      return rows;
    },
  );
  mark('finishTransaction');
  return new Map(rows.map((r) => [r.subject_plan, r.plan_slug] as const));
}

/**
 * Which plans have a RETIRED acceptance rubric — the trace of a validation that CLOSED
 * (EI-22078741539479611). An acceptance rubric retires WITH its shipped plan, so on a
 * shipped plan the active read above is empty by design, and a verdict built from that
 * alone says "the validation path has not begun" about a plan whose validation finished.
 *
 * ⚠ NOT covered by the partial unique index the active read leans on (that index is
 * active-only), so this is a workspace index scan + filter — measured 2026-09-01 at
 * ~12ms / 3.3k buffers over ~1.7k plan rows. Callers must run it only when it can change
 * the answer: a SHIPPED plan with no active rubric (`derivePlanLifecycleForRead` does).
 * Returns slug → the newest retired rubric plan's slug.
 */
export async function readRetiredAcceptanceRubrics(input: {
  workspaceId: string;
  planSlugs: readonly string[];
}): Promise<Map<string, string>> {
  if (input.planSlugs.length === 0) return new Map();
  const { withWorkspace } = await import('@papercusp/db-org');
  const rows = await withWorkspace(
    input.workspaceId,
    async (tx) => tx<{ plan_slug: string; subject_plan: string }[]>`
      SELECT plan_slug, template_data ->> 'subjectPlan' AS subject_plan
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${input.workspaceId}
         AND template = 'rubric'
         AND template_slug IS NULL
         AND (archived = true OR status = ANY(ARRAY['superseded', 'shipped']))
         AND template_data ->> 'kind' = 'acceptance'
         AND NULLIF(template_data ->> 'subjectPlan', '') IS NOT NULL
         AND template_data ->> 'subjectPlan' = ANY(${[...input.planSlugs]})
       ORDER BY updated_at DESC NULLS LAST
    `,
  );
  const out = new Map<string, string>();
  // Newest first, so the first row per subject wins — the rubric the ship was judged against.
  for (const r of rows) if (!out.has(r.subject_plan)) out.set(r.subject_plan, r.plan_slug);
  return out;
}

export interface GatherPlanLifecycleSignalsInput {
  workspaceId: string;
  planSlug: string;
  /** `harness_plans.updated_at` — the last write to this plan. */
  planUpdatedAt?: unknown;
  /** Newest transition across work-items linked to this plan, if measured. */
  linkedWorkItemUpdatedAt?: unknown;
  /** Injected clock — defaults to now, overridden by tests. */
  now?: string;
  /** Injected reader, so callers that already batched the lookup skip the query. */
  readAcceptance?: typeof readActiveAcceptanceRubrics;
  /** Request-local wall times for the existing plans:get diagnostic metadata. */
  timings?: Record<string, number>;
  /** Injected RETIRED-rubric reader (read only for a shipped plan with no active rubric). */
  readRetiredAcceptance?: typeof readRetiredAcceptanceRubrics;
  /**
   * A pre-resolved acceptance answer from a batched caller. `undefined` means
   * "not supplied, go look"; `null` means "looked, found none".
   */
  acceptanceRubricRef?: string | null;
}

/**
 * Assemble the signals for one plan. Best-effort throughout: a failed lookup
 * degrades to an unmeasured axis, never to a fabricated value.
 */
export async function gatherPlanLifecycleSignals(
  input: GatherPlanLifecycleSignalsInput,
): Promise<PlanLifecycleSignals> {
  const now = input.now ?? new Date().toISOString();
  const freshness = buildPlanFreshness(
    [
      { source: 'plan-write', at: normalizeActivityTimestamp(input.planUpdatedAt) },
      {
        source: 'linked-work-item',
        at: normalizeActivityTimestamp(input.linkedWorkItemUpdatedAt),
      },
    ],
    now,
  );

  if (input.acceptanceRubricRef !== undefined) {
    return {
      freshness,
      acceptance: {
        rubricActive: input.acceptanceRubricRef !== null,
        rubricRef: input.acceptanceRubricRef,
      },
    };
  }

  try {
    const read = input.readAcceptance ?? readActiveAcceptanceRubrics;
    const found = await read({ workspaceId: input.workspaceId, planSlugs: [input.planSlug],
      ...(input.timings ? { timings: input.timings } : {}) });
    const ref = found.get(input.planSlug) ?? null;
    return { freshness, acceptance: { rubricActive: ref !== null, rubricRef: ref } };
  } catch {
    // Unmeasured, NOT false. `derivePlanLifecycle` reports the gap in
    // `unmeasured` so a verdict reached without this signal is never mistaken
    // for one that checked it and found nothing.
    return { freshness };
  }
}

/**
 * The whole read-time overlay for one plan: gather signals, derive the verdict,
 * reconcile it against the stored `status`.
 *
 * `items` MUST be the plan's COMPLETE item list. Deriving from a caller-narrowed
 * selection (`plans:get { items: ['P-003'] }`) would census one item and report
 * a one-item plan as drained — a confidently wrong verdict rather than a
 * missing one.
 */
export async function derivePlanLifecycleForRead(input: {
  items: readonly PlanItem[];
  storedStatus: string | null | undefined;
  signals: GatherPlanLifecycleSignalsInput;
  /**
   * expensive-verification-loops P-002 (R-3): opt-in grinding reader; plans:get passes
   * readGrindingItems. Absent → no `grinding` field (not measured), so pure callers and
   * unit tests stay DB-free.
   */
  readGrinding?: (q: { workspaceId: string; planSlug: string; itemIds: readonly string[] }) => Promise<
    GrindingMark[] | null
  >;
  /**
   * expensive-verification-loops P-007 (R-12): opt-in reader for each item's
   * attempts-until-pass and failure-class split; plans:get passes readIterationMetrics.
   * Reads every item (done ones included). Absent → no `iterations` field.
   */
  readIterations?: (q: {
    workspaceId: string;
    planSlug: string;
    itemIds: readonly string[];
    /** Item text by id — carries each item's declared `attempt-cost:` / `iteration-budget:`. */
    itemTexts: Readonly<Record<string, string>>;
  }) => Promise<IterationMetric[] | null>;
}): Promise<PlanLifecycleReconciliation & { grinding?: GrindingMark[] | null; iterations?: IterationMetric[] | null }> {
  const reconciled = await deriveReconciledLifecycle(input);
  let iterations: IterationMetric[] | null | undefined;
  if (input.readIterations) {
    try {
      iterations = await input.readIterations({
        workspaceId: input.signals.workspaceId,
        planSlug: input.signals.planSlug,
        itemIds: input.items.map((it) => it.id),
        itemTexts: Object.fromEntries(input.items.map((it) => [it.id, it.text])),
      });
    } catch {
      iterations = null;
    }
  }
  const withIterations = iterations !== undefined ? { ...reconciled, iterations } : reconciled;
  if (!input.readGrinding) return withIterations;
  const open = input.items
    .filter((it) => it.storedStatus !== 'done' && it.storedStatus !== 'dropped')
    .map((it) => it.id);
  let grinding: GrindingMark[] | null = null;
  try {
    grinding = await input.readGrinding({
      workspaceId: input.signals.workspaceId,
      planSlug: input.signals.planSlug,
      itemIds: open,
    });
  } catch {
    grinding = null;
  }
  return { ...withIterations, grinding };
}

async function deriveReconciledLifecycle(input: {
  items: readonly PlanItem[];
  storedStatus: string | null | undefined;
  signals: GatherPlanLifecycleSignalsInput;
}): Promise<PlanLifecycleReconciliation> {
  const signals = await gatherPlanLifecycleSignals(input.signals);
  // EI-22078741539479611: on a SHIPPED plan, "no active acceptance rubric" is the
  // expected shape of a validation that CLOSED (the rubric retired with the ship), not
  // of one that never began. Look the retired rubric up — only here, where it changes
  // the answer — so the derived text can say which. Best-effort: a failed lookup leaves
  // the axis as measured-false rather than fabricating a ref.
  const stored = (input.storedStatus ?? '').trim();
  if (stored === 'shipped' && signals.acceptance && !signals.acceptance.rubricActive) {
    try {
      const read = input.signals.readRetiredAcceptance ?? readRetiredAcceptanceRubrics;
      const found = await read({ workspaceId: input.signals.workspaceId, planSlugs: [input.signals.planSlug] });
      const ref = found.get(input.signals.planSlug) ?? null;
      if (ref) signals.acceptance = { ...signals.acceptance, retiredRubricRef: ref };
    } catch {
      /* measured-false stands; the text simply cannot name the retired rubric */
    }
  }
  return reconcilePlanLifecycle(input.storedStatus, derivePlanLifecycle(input.items, signals));
}
