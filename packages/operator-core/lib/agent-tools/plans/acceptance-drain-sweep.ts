/**
 * ACCEPTANCE-DRAIN sweep — P-020 of design-to-code-coverage-seam-2026-09-02 (D-032).
 *
 * This is the half that makes the acceptance ceremony a QUEUE rather than a WALL.
 *
 * `plan-drain-rule.ts` + `plan-drain-sweep.ts` push plans INTO
 * `awaiting-acceptance` automatically the moment their last item goes terminal.
 * `evaluatePlanAcceptanceGate` then holds them there until a seven-step ceremony
 * completes. Between those two mechanisms there is nothing at all: no filing, no
 * routing, no signal. The refusal is visible only to someone who explicitly
 * attempts a ship. So the state accumulates and never drains — measured 187
 * plans, 86.1% of which have never had `plans:audit` run even once, oldest
 * 2026-06-04 (D-032, a full census via the same evaluator the ship write uses).
 *
 * This sweep is the exit: for every held plan it files ONE work item, unassigned,
 * which any agent can claim through the ordinary claim path. Exactly the pairing
 * `spec-triad-sweep.ts` already uses for the identical defect on the spec-triad
 * gate, and it obeys the same standing mandate — a design that routes a decision
 * to a person is a defect; nothing here escalates, notifies, or waits for
 * approval, it files claimable work.
 *
 * ## Safety rails, in the order they matter
 *
 *  1. **Bounded filing.** At most {@link ACCEPTANCE_DRAIN_MAX_FILINGS_PER_RUN}
 *     items per run. The first tick faces a 187-plan accumulated backlog; filing
 *     all of it at once would be a real bulk write, and if the decision were
 *     wrong it would be wrong everywhere before anyone could look. A cap drains
 *     it over several ticks and costs nothing in the steady state, where a tick
 *     has 0–1 candidates.
 *  2. **Idempotent.** Each filing stamps `payload.acceptanceDrainPlan` and claims
 *     a unique condition key. Re-running refreshes the existing row in place;
 *     the key prevents duplicate creation but never suppresses a gate read.
 *  3. **The dedupe read precedes the expensive leg, not the other way round.**
 *     The gate is ~265ms per plan (five check families, citations re-resolved
 *     against the real tree). Evaluating first and deduping after would burn the
 *     whole budget re-deciding plans that are already filed — so candidates are
 *     filtered by the cheap payload read, and only the survivors are evaluated,
 *     and only up to the cap.
 *  4. **Never throws.** A thrown step makes DBOS mark the workflow permanently
 *     dead — a transient error would stop this sweep FOREVER, silently, which is
 *     precisely the invisible-stall shape it exists to fix. Every leg degrades to
 *     a warn.
 *
 * ## Why a plan that PASSES the gate is reported and not filed
 *
 * A plan sitting in `awaiting-acceptance` whose gate is satisfied is shippable
 * right now and owes nothing — filing work against it would be noise. But it is
 * also not nothing: it means a finished plan is one `plans:set-plan-status` call
 * from shipped and nobody has made it. It is counted as `shippableNow` so the
 * number is visible without manufacturing a task.
 *
 * Kill-switch: the `ACCEPTANCE_DRAIN_SWEEP` flag.
 */

import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { evaluatePlanAcceptanceGate } from '../../plan-acceptance-gate';
import { setWorkItemState } from '../../work-items';
import {
  ACCEPTANCE_DRAIN_ACTOR,
  ensureAcceptanceDrainFiling,
  ACCEPTANCE_DRAIN_NON_TERMINAL_STATUSES,
  acceptanceDrainObservationSignals,
  type AcceptanceDrainBacklogClass,
  type AcceptanceDrainGateObservation,
} from './acceptance-drain-filing';
import { listPlanIndexRowsForWorkspace, type PlanIndexRow } from './source';
import { activeWorkspaceId } from '../../workspace-registry';
import { isHarnessInScope, primeWorkScopePolicy } from '../../work-scope-policy';

/** Upper bound on work items filed in a single run. See the rails note above. */
export const ACCEPTANCE_DRAIN_MAX_FILINGS_PER_RUN = 25;

/**
 * Plan `template` values this sweep never files against.
 *
 * A rubric-template plan is exempt from carrying an acceptance rubric of its own
 * (infinite regress — `evaluatePlanAcceptanceGate` exempts it explicitly), so
 * filing "unstick this rubric" work would be a task nobody can ever complete.
 */
export const ACCEPTANCE_DRAIN_EXEMPT_TEMPLATES = new Set(['rubric']);

export interface AcceptanceDrainSweepFiled {
  planSlug: string;
  harnessSlug: string;
  /** The gate's first refusal code — what this filing is actually about. */
  code: string;
  workItemId: string | null;
}

export interface AcceptanceDrainSweepResult {
  /** Plans enumerated in `awaiting-acceptance`. */
  scanned: number;
  /** Of those, how many already had an open filing (skipped before the gate ran). */
  alreadyFiled: number;
  /** Of those evaluated, how many the gate said are shippable right now. */
  shippableNow: number;
  /** Existing keyed filings refreshed with a current gate observation. */
  refreshed: number;
  /** Existing keyed filings whose current gate is ready for shipment. */
  ready: number;
  /** Existing keyed filings whose gate read was unknown/unreadable. */
  unknown: number;
  /** Existing keyed filings past the durable escalation age. */
  escalated: number;
  /** Existing filings closed after observing a terminal plan disposition. */
  reconciled: number;
  /**
   * P-016: extra open filings for a plan that already has a canonical one
   * (ACCEPTANCE_DRAIN_CANONICAL_ORDER), closed as duplicates. A duplicate
   * somebody has claimed is left alone and counted in `duplicatesHeld`.
   */
  duplicatesRetired: number;
  duplicatesHeld: number;
  /**
   * P-016: how this pass classified every plan it evaluated — the backlog census,
   * recorded on each filing as `payload.backlogClass` + `payload.nextRepairAction`.
   */
  byClass: Partial<Record<AcceptanceDrainBacklogClass, number>>;
  filed: AcceptanceDrainSweepFiled[];
  /** Refusing plans left unfiled because the per-run cap was hit. */
  deferred: number;
  /**
   * workspace-work-scope-policy-2026-09-04 P-008: rows whose harness the workspace
   * work-scope policy excludes — held, never filed against, never deleted.
   */
  scopeSkipped: number;
  /** Per-plan failures, reported rather than thrown. */
  errors: string[];
  /** Set when the sweep declined to run at all. */
  skipped?: 'flag-off' | 'candidate-read-failed' | 'dedupe-read-failed';
  summary: string;
}

/**
 * The pure candidate filter — which enumerated rows this sweep may file against.
 *
 * Split out from the I/O so the exclusions (template exemption, already-filed
 * dedupe) are testable without a database, exactly as spec-triad-sweep splits
 * its decision from its plumbing.
 */
export function selectAcceptanceDrainCandidates(
  rows: PlanIndexRow[],
  alreadyFiledRefs: Set<string>,
  workspaceId: string,
): PlanIndexRow[] {
  return rows.filter((row) => {
    // `PlanIndexRow` is camelCase (`Omit<PlanRow, 'content'>`), NOT the snake_case
    // of the underlying `harness_plans` columns. Reading the column names here
    // yields `undefined` for every row and silently drops the whole population —
    // which reads as "everything is already filed", i.e. a clean no-op tick. That
    // is the false-negative this comment exists to stop coming back; the fixture
    // in the sibling test uses the real row shape for the same reason.
    if (!row.planSlug || !row.harnessSlug) return false;
    if (row.template && ACCEPTANCE_DRAIN_EXEMPT_TEMPLATES.has(row.template)) return false;
    return !alreadyFiledRefs.has(`${workspaceId}/${row.harnessSlug}/${row.planSlug}`);
  });
}

export interface AcceptanceDrainSweepOptions {
  /** Defaults to the active workspace. */
  workspaceId?: string;
  /** Override the per-run filing cap (tests). */
  maxFilings?: number;
}

function empty(summary: string, skipped?: AcceptanceDrainSweepResult['skipped']): AcceptanceDrainSweepResult {
  return {
    scanned: 0,
    alreadyFiled: 0,
    shippableNow: 0,
    refreshed: 0,
    ready: 0,
    unknown: 0,
    escalated: 0,
    reconciled: 0,
    duplicatesRetired: 0,
    duplicatesHeld: 0,
    byClass: {},
    filed: [],
    deferred: 0,
    scopeSkipped: 0,
    errors: [],
    ...(skipped ? { skipped } : {}),
    summary,
  };
}

/**
 * One sweep pass. Never throws.
 */
export async function runAcceptanceDrainSweepOnce(
  opts: AcceptanceDrainSweepOptions = {},
): Promise<AcceptanceDrainSweepResult> {
  const enabled = await getFlag(FLAGS.ACCEPTANCE_DRAIN_SWEEP, 'system').catch(() => true);
  if (!enabled) return empty('acceptance-drain sweep: flag off', 'flag-off');

  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const maxFilings = opts.maxFilings ?? ACCEPTANCE_DRAIN_MAX_FILINGS_PER_RUN;

  // Phase 1 — cheap metadata scan. Instances are excluded by default, matching
  // plan-drain-sweep: a scheduled run instance is an auto-generated recurrence,
  // not authored work owed an acceptance ceremony.
  let rows: PlanIndexRow[];
  try {
    rows = await listPlanIndexRowsForWorkspace({
      workspaceId,
      status: 'awaiting-acceptance',
    });
  } catch (err) {
    return empty(
      `acceptance-drain sweep: candidate read failed: ${(err as Error).message}`,
      'candidate-read-failed',
    );
  }

  // Phase 2 — the dedupe read, BEFORE the expensive gate (rail 3).
  const alreadyFiledRefs = new Set<string>();
  const existingFilings = new Map<string, {
    featureId: string;
    harnessSlug: string;
    gateObservation?: string | null;
    payload?: Record<string, unknown> | null;
    planStatus?: string | null;
    archived?: boolean | null;
  }>();
  // P-016: open filings that lose to an earlier canonical filing for the same plan.
  const duplicateFilings: Array<{ featureId: string; harnessSlug: string; ref: string; canonical: string; takenBy: string | null }> = [];
  try {
    const { sql } = getOrgPg();
    // Ordered by ACCEPTANCE_DRAIN_CANONICAL_ORDER so the FIRST row per ref is the
    // one the carry and refresh writers also pick; later rows are duplicates.
    const existing = (await sql`
      SELECT wi.feature_id,
             wi.harness_slug,
             wi.payload->>'acceptanceDrainPlan' AS ref,
             payload->>'gateObservation' AS gate_observation,
             wi.payload,
             wi.taken_by,
             p.status AS plan_status,
             p.archived
        FROM harness_shared.work_items wi
        LEFT JOIN harness_shared.harness_plans p
          ON p.workspace_id = wi.workspace_id
         AND (p.workspace_id || '/' || p.harness_slug || '/' || p.plan_slug) = wi.payload->>'acceptanceDrainPlan'
       WHERE payload->>'acceptanceDrainPlan' IS NOT NULL
         AND wi.status = ANY(${ACCEPTANCE_DRAIN_NON_TERMINAL_STATUSES})
       ORDER BY wi.created_ts, wi.feature_id
    `) as unknown as Array<{
      feature_id: string;
      harness_slug: string;
      ref: string | null;
      gate_observation?: string | null;
      payload?: Record<string, unknown> | null;
      taken_by?: string | null;
      plan_status?: string | null;
      archived?: boolean | null;
    }>;
    // A P-025 carry row is an ownership handoff, not a completed gate
    // observation. Let the first sweep evaluate it and replace the placeholder
    // in-place; only a known blocker suppresses duplicate filing.
    for (const e of existing) {
      if (e.ref && existingFilings.has(e.ref)) {
        duplicateFilings.push({
          featureId: e.feature_id,
          harnessSlug: e.harness_slug,
          ref: e.ref,
          canonical: existingFilings.get(e.ref)!.featureId,
          takenBy: e.taken_by ?? null,
        });
        continue;
      }
      if (e.ref) {
        existingFilings.set(e.ref, {
          featureId: e.feature_id,
          harnessSlug: e.harness_slug,
          gateObservation: e.gate_observation,
          payload: e.payload,
          planStatus: e.plan_status,
          archived: e.archived,
        });
        if (e.gate_observation !== 'pending') alreadyFiledRefs.add(e.ref);
      }
    }
  } catch (err) {
    return empty(
      `acceptance-drain sweep: dedupe read failed: ${(err as Error).message}`,
      'dedupe-read-failed',
    );
  }

  // Dedupe gates only NEW filing creation. Existing rows must still be re-read
  // through the canonical gate so changed blockers and readiness refresh the
  // same ledger row rather than becoming a permanent sink.
  const candidates = selectAcceptanceDrainCandidates(rows, new Set(), workspaceId);
  const alreadyFiled = rows.filter((row) => existingFilings.has(`${workspaceId}/${row.harnessSlug}/${row.planSlug}`)).length;

  // Phase 3 — evaluate and file, capped.
  const filed: AcceptanceDrainSweepFiled[] = [];
  const errors: string[] = [];
  let shippableNow = 0;
  let refreshed = 0;
  let ready = 0;
  let unknown = 0;
  let escalated = 0;
  let deferred = 0;
  let scopeSkipped = 0;
  const byClass: Partial<Record<AcceptanceDrainBacklogClass, number>> = {};
  const countClass = (c: AcceptanceDrainBacklogClass | undefined) => {
    if (c) byClass[c] = (byClass[c] ?? 0) + 1;
  };

  // PRIME BEFORE FILTERING (WI-10002448) — never drop this await. `isHarnessInScope`'s
  // default policy is a SYNC read of a cache an async refresh fills, and an empty cache
  // reads as "not enforced", so the first sweep after a boot would file acceptance-drain
  // work into harnesses the STORED policy forbids. Priming makes that tick judge the stored
  // policy; with no stored policy it still never skips (the P-007 contract below holds).
  await primeWorkScopePolicy();
  for (const row of candidates) {
    // workspace-work-scope-policy-2026-09-04 P-007: a plan homed outside the workspace
    // work-scope policy gets no acceptance-drain filing — filing it would place work in an
    // out-of-scope harness. Counted, never dropped. No policy ⇒ never skips.
    if (!isHarnessInScope(row.harnessSlug)) {
      scopeSkipped++;
      continue;
    }
    const planSlug = row.planSlug;
    const harnessSlug = row.harnessSlug;
    // P-016: the plan's last recorded write drives the abandonment-candidate class.
    const planUpdated = row.updated ?? null;
    const ref = `${workspaceId}/${harnessSlug}/${planSlug}`;
    const existing = existingFilings.get(ref);
    // Existing accountability rows are always refreshed. The cap applies only
    // to minting new rows into the shared work queue.
    if (!existing && filed.length >= maxFilings) {
      deferred++;
      continue;
    }
    try {
      const verdict = await evaluatePlanAcceptanceGate(planSlug);
      const observation: AcceptanceDrainGateObservation = verdict;
      const signals = acceptanceDrainObservationSignals(observation, existing?.payload, new Date(), planSlug);
      if (signals.escalation === 'due') escalated++;
      if (verdict.satisfied) {
        if (existing) {
          refreshed++;
          ready++;
        } else {
          shippableNow++;
        }
        countClass('ready');
        if (existing) {
          await ensureAcceptanceDrainFiling({
            workspaceId, harnessSlug, planSlug, code: null,
            message: verdict.message ?? 'acceptance gate satisfied', observation, planUpdated,
          });
        }
        continue;
      }
      // A verdict that could not be EVALUATED is not a refusal to file work
      // against: "could not evaluate" and "is blocked" are different claims, and
      // filing the first as the second would put a fabricated blocker code in
      // front of whoever picks the item up.
      if (!verdict.code && !existing) {
        unknown++;
        errors.push(`${planSlug}: refused with no code (unavailable?), not filed`);
        continue;
      }
      const res = await ensureAcceptanceDrainFiling({
        workspaceId,
        harnessSlug,
        planSlug,
        code: verdict.code ?? null,
        message: verdict.message ?? `(gate refused with ${verdict.code} and no message)`,
        observation,
        planUpdated,
      });
      countClass(res.backlogClass);
      if (res.outcome === 'created' && !existing) {
        filed.push({ planSlug, harnessSlug, code: verdict.code ?? 'unknown', workItemId: res.id });
      } else if (existing || res.outcome === 'already-open') {
        refreshed++;
        if (signals.gateObservation === 'unknown') unknown++;
      } else if (res.outcome === 'error') {
        errors.push(`${planSlug}: filing failed: ${res.error}`);
      }
    } catch (err) {
      if (existing) {
        const observation: AcceptanceDrainGateObservation = { satisfied: false, message: (err as Error).message };
        const res = await ensureAcceptanceDrainFiling({
          workspaceId, harnessSlug, planSlug, code: null,
          message: (err as Error).message, observation, planUpdated,
        });
        countClass(res.backlogClass);
        refreshed++;
        unknown++;
      }
      errors.push(`${planSlug}: ${(err as Error).message}`);
    }
  }

  // A plan leaves awaiting-acceptance only through a terminal disposition. Close
  // the one keyed filing on that observed edge; readiness alone deliberately does
  // not close it because the CAS shipment write is a separate lifecycle hop.
  const awaitingRefs = new Set(rows.map((row) => `${workspaceId}/${row.harnessSlug}/${row.planSlug}`));
  let reconciled = 0;
  for (const [ref, filing] of existingFilings) {
    if (awaitingRefs.has(ref) || filing.planStatus === undefined) continue;
    const terminal = filing.archived === true || filing.planStatus === null || filing.planStatus === 'shipped' || filing.planStatus === 'superseded';
    if (!terminal) continue;
    const state = filing.planStatus === 'shipped' ? 'resolved' : 'dropped';
    try {
      await setWorkItemState(filing.featureId, state, {
        harness: filing.harnessSlug,
        by: ACCEPTANCE_DRAIN_ACTOR,
        completionRef: `Acceptance filing ${state === 'resolved' ? 'resolved' : 'dropped'}: plan ${ref} observed ${filing.planStatus ?? 'missing'}${filing.archived ? ' and archived' : ''}.`,
      });
      reconciled++;
    } catch (err) {
      errors.push(`${ref}: terminal filing reconciliation failed: ${(err as Error).message}`);
    }
  }

  // P-016: a second open filing for a plan is never refreshed (the writers pick
  // the canonical row) and never reconciled (the terminal pass above walks the
  // canonical map), so without this it stays open forever. Retire it — unless
  // somebody has claimed it, in which case retiring would silently drop their claim.
  let duplicatesRetired = 0;
  let duplicatesHeld = 0;
  for (const dup of duplicateFilings) {
    if (dup.takenBy) {
      duplicatesHeld++;
      continue;
    }
    try {
      await setWorkItemState(dup.featureId, 'dropped', {
        harness: dup.harnessSlug,
        by: ACCEPTANCE_DRAIN_ACTOR,
        completionRef: `Duplicate acceptance filing for ${dup.ref}; the canonical filing is ${dup.canonical}.`,
      });
      duplicatesRetired++;
    } catch (err) {
      errors.push(`${dup.ref}: duplicate filing ${dup.featureId} retirement failed: ${(err as Error).message}`);
    }
  }

  const byCode = new Map<string, number>();
  for (const f of filed) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
  const codeBreakdown = [...byCode.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c}×${n}`)
    .join(', ');
  const classBreakdown = Object.entries(byClass)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([c, n]) => `${c}×${n}`)
    .join(', ');

  const summary =
    `acceptance-drain sweep: ${rows.length} in awaiting-acceptance · ` +
    `${alreadyFiled} already filed · ${shippableNow} SHIPPABLE NOW · ` +
    `${filed.length} filed${codeBreakdown ? ` (${codeBreakdown})` : ''} · ` +
    `${refreshed} refreshed · ${ready} ready · ${unknown} unknown · ${escalated} escalated · ${reconciled} reconciled` +
    (classBreakdown ? ` · classes: ${classBreakdown}` : '') +
    (duplicatesRetired > 0 ? ` · ${duplicatesRetired} duplicate filing(s) retired` : '') +
    (duplicatesHeld > 0 ? ` · ${duplicatesHeld} claimed duplicate(s) left open` : '') +
    (deferred > 0 ? ` · ${deferred} DEFERRED past the ${maxFilings}/run cap` : '') +
    (scopeSkipped > 0 ? ` · ${scopeSkipped} skipped (harness outside the work-scope policy)` : '') +
    (errors.length > 0 ? ` · ${errors.length} error(s)` : '');

  return {
    scanned: rows.length,
    alreadyFiled,
    shippableNow,
    refreshed,
    ready,
    unknown,
    escalated,
    reconciled,
    duplicatesRetired,
    duplicatesHeld,
    byClass,
    filed,
    deferred,
    scopeSkipped,
    errors,
    summary,
  };
}
