/**
 * Plan → work-item promotion RUNNER (unified-work-item-ledger-2026-06-21 P-003).
 *
 * The I/O wrapper around the pure computePromotions(): on plans:start (behind the
 * default-OFF flag papercusp-plan-workitem-promotion), mint a placeable, UNCLAIMED
 * feature work-item for each OPEN plan-item that doesn't already have one — so a
 * started+eligible plan never sits at zero work-items and the Queen has work to
 * place (D-002: plans:start is the single promotion path; the Queen just calls it).
 *
 * TWO-PASS (work-item-dependency-edges-2026-08-02 P-006): mint every item, then translate
 * each one's plan-level `blockedBy` into real `blocks` edges. Before this, promotion carried
 * the plan's NODES but not its GRAPH — `blockedBy` was read only to pick a starting lane
 * (EI-14024), so the dependency structure the plan described existed nowhere the scheduler
 * could query. The pass split is load-bearing: a plan-item id only becomes a work-item id at
 * mint time, so a single pass silently drops every forward reference. See
 * `writePromotedDependencyEdges` for which writer to use — D-010, and it is not the obvious one.
 * P-009 now validates the complete executable plan candidate BEFORE pass 1, so a cycle or dangling
 * endpoint mints no node and no edge. The older edge-level cycle pre-flight remains a defense for
 * stored-index/read drift and cross-plan writer failures, not the primary admission boundary.
 *
 * Coherent with convert-at-pickup (plan-items/convert.ts): promotion reuses the
 * SAME idempotency truth (the `implements` coord_links edge via
 * listConvertedPlanItemRefs) and stamps the SAME payload.plan_item + writes the
 * SAME edge — so a later pickup RESUMES the promoted work-item rather than minting
 * a duplicate. The only difference from convert: promotion leaves the item
 * UNCLAIMED (no owner) — it is placeable, not picked-up.
 *
 * SAFE BY DEFAULT: the flag defaults OFF (dark) → this is a no-op. plans:start
 * calls it fire-and-forget + .catch(), so it can never break the start path. Ships
 * dark until the owner integration-verifies + flips it on.
 */
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { getOrgPg } from '@papercusp/db-org';
import { resolveEffectiveStatusForItems, type ItemStatus, type PlanItem } from '@papercusp/plan-parser';
import { systemDistinctId } from './flag-distinct-id';
import { readPlanBySlug, type PlanRow } from './agent-tools/plans/source';
import {
  getWorkItem,
  linkWorkItem,
  rebindOrphanedPlanFleetReservation,
  type ActiveFeatureFamilyKind,
  type WorkItemDesignStatus,
} from './work-items';
import { upsertConditionWorkItem } from './coord/condition-upsert';
import { resolvePlanPromotionGoal, stampPromotedGoal } from './goals/provenance-stamp';
import { PLAN_ITEM_KIND, planItemRef } from './issue-blocks-merge';
import {
  findConvertedWorkItemByStamp,
  IMPLEMENTS_REL,
  listConvertedPlanItemRefs,
  listCoveredPlanItemRefs,
  type PlanItemStamp,
} from './plan-items/convert';
import { getFeatureBlockers, syncFeatureBlockEdges } from './dbos/feature-blockers-edges';
import {
  syncLinkedWorkItemsToPlanLane,
  type PlanLaneSyncFailure,
  type PlanLaneSyncStatus,
} from './plan-items/reconcile-linked-work-items';
import { planItemTextHash } from './plan-items/text-drift';
import { computePromotions, type OpenPlanItem } from './plan-workitem-promotion';
import { phaseRequiresTwoMachineRig } from './plan-phase-rig';
import { listObjectTags } from './topics-feed';
import {
  evaluatePlanSpecQualityGate,
  type PlanSpecQualityGateVerdict,
} from './agent-tools/plans/plan-spec-quality-gate';
import type { AgenticPlanExecutionTarget } from './agentic-plan-execution-target';
import {
  validatePlanCandidateDependencies,
  type PlanCandidateDependencyDiagnostic,
} from './agent-tools/plans/plan-candidate-dependencies';
import {
  readAndEvaluateAcceptanceBarLifecycle,
  type AcceptanceBarLifecycleVerdict,
} from './acceptance-bar-lifecycle-evaluator';
import { ensureWorkItemSpecRevisionEdges } from './agent-tools/plans/spec-evidence-store';

export interface PromotePlanResult {
  /** new work-items minted this call */
  promoted: number;
  /** open items already covered by a work-item (idempotent skips) */
  skipped: number;
  /**
   * Fail-soft inline plan-lane sync errors, correlated to the minted work-item. Stage
   * `sync-rejection` is minted HERE (the reconciler call itself threw), so it widens this
   * field rather than the reconciler's own PlanLaneSyncFailure union, which never emits it.
   */
  laneGateFailures?: Array<
    Omit<PlanLaneSyncFailure, 'stage'> & {
      stage: PlanLaneSyncFailure['stage'] | 'sync-rejection';
      itemId: string;
      workItemId: string;
    }
  >;
  /**
   * WI-10005696: the goal this promotion attributed its lanes to (`goalId`), how many rows
   * actually gained a `work_items.goal_id` (`stamped` — a never-clobber re-run stamps 0), and
   * any per-row stamp failures (`errors`, fail-soft but never silent). Omitted when the
   * promotion served no goal and nothing failed — the common non-goal case.
   */
  goalStamp?: { goalId: string | null; stamped: number; errors: string[] };
  /** true when the flag is OFF — promotion was a no-op */
  flagOff?: boolean;
  /**
   * P-006: feature→feature `blocks` edges written from the plan's `blockedBy` this call.
   * Counts EDGES, not items — one item with two blockers contributes two.
   */
  edgesWritten: number;
  /**
   * P-006: edge writes that FAILED at the writer — after P-008's pre-flight this is the
   * exceptional path, not the expected one: a cross-plan cycle the plan-level pre-flight
   * cannot see (an edge from an already-promoted item back into this plan), or genuine I/O.
   * A plan-internal cycle no longer reaches the writer; it is counted in `edgesRejectedCyclic`.
   */
  edgeFailures: number;
  /**
   * P-008: edges REFUSED by the pre-flight because the plan's own `blockedBy` graph is cyclic
   * (either side of the edge is in a cycle). Counts EDGES, like `edgesWritten`. These items are
   * still minted and still gated — `resolveEffectiveStatusForItems` resolves every cycle member
   * to `blocked`, so pass 1's lane gate parks them; what is withheld is only the edge.
   */
  edgesRejectedCyclic: number;
  /**
   * okf-frontmatter-adoption H(b): promotion was REFUSED because the plan is in
   * scope for the SPEC TRIAD and owes a leg. Present only when it fired.
   *
   * This is the refusal with teeth — `plans:items { actionable }` is a read, but
   * THIS is where plan items become claimable work. It is paired with an
   * automatic filing (`specTriadWorkItem`), so the refusal always ships its own
   * exit: an agent claims that item, writes the sections, and re-running
   * promotion succeeds. Nothing waits on a human, and no EXISTING plan can hit
   * it (the scope test is creation-epoch based — see spec-triad-policy.ts).
   */
  specTriadBlocked?: true;
  /** The legs the plan owes, when `specTriadBlocked`. */
  specTriadMissing?: string[];
  /** The work item filed to resolve it — null if the filing itself failed. */
  specTriadWorkItem?: string | null;
  /** P-004: adopted first-class clauses failed the exact spec-quality scorecard gate. */
  specQualityBlocked?: true;
  /** Report-only or enforced exact specSetHash verdict evaluated before minting. */
  specQuality?: PlanSpecQualityGateVerdict;
  /** WI-10004234: the plan could not be read, so nothing was evaluated or minted. */
  planUnreadable?: true;
  /**
   * The plan row's `template` is not executable (spec-triad-policy SPEC_TRIAD_EXCLUDED_TEMPLATES,
   * e.g. an acceptance rubric): nothing was promoted and no gate ran or filed (WI-10005441).
   */
  templateExcluded?: string;
  /** P-003: the shared BAR contract was not ready for promotion. */
  acceptanceBarBlocked?: true;
  acceptanceBarLifecycle?: AcceptanceBarLifecycleVerdict;
  /** P-009: the executable plan candidate failed before any work-item was minted. */
  dependencyBlocked?: true;
  /** Exact cycle/endpoint evidence from the shared P-008 candidate validator. */
  dependencyDiagnostics?: PlanCandidateDependencyDiagnostic[];
  /**
   * P-008: `blockedBy` refs naming a plan item that DOES NOT EXIST in the plan — an authoring
   * error `plans:lint` already reports, split out from `blockersUnresolved` because the two
   * demand different responses (fix the plan text vs. investigate a promotion that should have
   * happened). Previously conflated into `blockersUnresolved`.
   */
  blockersDangling: number;
  /**
   * P-006: `blockedBy` refs naming a REAL, still-open plan item that nonetheless resolved to no
   * work-item — i.e. a promotion that should have happened and didn't, NOT the ordinary
   * done/dropped blocker (deliberately uncounted) and no longer the dangling ref (see above).
   */
  blockersUnresolved: number;
  /**
   * P-009/D-015: pre-existing blocker edges CARRIED THROUGH a union write rather than deleted by
   * `syncFeatureBlockEdges`' replace-semantics. Always 0 on the promotion path (a just-minted item
   * has no edges, so there is nothing to preserve) — it is the backfill's proof that reuse did not
   * silently destroy an edge some other author wrote. Counts EDGES, like `edgesWritten`.
   */
  edgesPreserved: number;
  /**
   * The concrete execution records covering this promotion's open plan items.
   * Includes idempotently-adopted rows, not only rows minted by this call, so a
   * replaying plan-run can deterministically resume assignment/wake without a
   * second provenance query.
   */
  workItems: PromotedPlanWorkItem[];
  /** Existing open lanes atomically rebound from a non-existent fleet to this run's fleet. */
  reservationsRebound?: number;
}

/** Per-run provenance stamped onto every work item promoted from an instance plan. */
export interface PlanRunPromotionContext {
  runId: number;
  runSeq: number;
  instancePlanSlug: string;
  templateSlug: string;
  inputs?: unknown;
  /** Direct-execution provenance inherited by every promoted descendant. */
  execution?: AgenticPlanExecutionTarget;
}

/** One open plan item and the canonical work item that executes it. */
export interface PromotedPlanWorkItem {
  planItemId: string;
  workItemId: string;
  /** True only when this call won the condition-key mint. */
  newlyPromoted: boolean;
  /** Canonical plan-DAG frontier verdict at promotion time. */
  actionable: boolean;
}

export interface PromotePlanItemsOptions {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  createdBy: string;
  /**
   * Scheduled/event/manual run context. The plan item still implements the
   * INSTANCE plan, while sourcePlanSlug groups the execution under the stable
   * TEMPLATE and payload.plan_run identifies this immutable fire.
   */
  planRun?: PlanRunPromotionContext;
  /** Preserve the plan template's authored, forward-active feature-family executor kind. */
  itemKind?: ActiveFeatureFamilyKind;
  /**
   * EI-21574373783224719: the fleet this promotion is minting a lane FOR. When set,
   * each promoted work-item carries `payload.fleet_slug`, which is leg 1 of
   * {@link import('./work-items').reservedPlanLaneExclusionSql} — "a fleet stamp is a
   * reservation in its own right, independently of plan lifecycle" (EI-13524).
   *
   * WHY THIS EXISTS. `fleet:launch-on-plan`'s promotion FAILSAFE mints a plan's lanes as
   * claimable work-items when the leader skipped `plans:start` (launch-on-plan.ts, the
   * "#3 FAILSAFE" block) — and deliberately does NOT flip `op_status='started'`, because
   * that would put the plan on the DBOS orchestrator frontier and give a fleet-driven plan
   * a SECOND dispatcher. Correct as far as it goes, but it left the minted rows with NO
   * reservation signal at all: the two execution legs of the floor read op_status/lifecycle
   * (never set on this path) and the fleet leg read a payload key NOTHING wrote. So the
   * failsafe made each lane claimable by the fleet AND by every unrelated agent in the pool
   * at the same time. Measured 2026-08-27: WI-41517 (plan
   * anti-babysitting-monitor-enforcement-2026-08-25, P-005) was served by self-select to two
   * different non-fleet agents 57 minutes apart while the fleet was demonstrably live on the
   * sibling lane; 37 open unclaimed lanes across 6 live-fleet plans sat in that same state,
   * and `payload.fleet_slug` had 0 producers across 123,735 rows.
   *
   * Stamping it is what ACTIVATES the existing primitive rather than adding a new one. The
   * owning fleet's members stay authorized (the claim paths thread `claimantFleetSlug`), a
   * spec that explicitly references the fleet field still passes, and a by-id claim bypasses
   * the floor as before — so this narrows ONLY unrelated agents' self-select.
   */
  fleetSlug?: string;
}

/** The zero-edge result shape shared by every early return (nothing minted ⇒ nothing to link). */
const NO_EDGES = {
  edgesWritten: 0,
  edgeFailures: 0,
  edgesRejectedCyclic: 0,
  blockersDangling: 0,
  blockersUnresolved: 0,
  edgesPreserved: 0,
  workItems: [] as PromotedPlanWorkItem[],
} as const;

function isOpenStatus(status: string | null): boolean {
  return status !== 'done' && status !== 'dropped';
}

/**
 * D-046: the migration-741 condition key that makes plan-item promotion single-winner —
 * at most ONE non-terminal promoted work-item may own a plan lane per
 * (workspace, harness, plan, item), enforced by `work_items_condition_key_uq`.
 * Exported so the concurrency regression asserts the exact key promotion writes.
 */
export function planPromotionConditionKey(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  itemId: string,
): string {
  return `plan-promotion:${workspaceId}/${harnessSlug}/${planSlug}/${itemId}`;
}

/** A plan item reduced to exactly what the edge write needs: identity, status, text, blockers. */
interface RawPlanItem {
  id: string;
  status: string | null;
  text: string;
  blockedBy: string[];
  phase: string | null;
}

interface AcceptedPlanItemDesignProvenance {
  needsDesign: boolean;
  designStatus: WorkItemDesignStatus;
  designSpecId: string;
  discardedDesignWork: boolean;
}

/**
 * Resolve the accepted design artifact that makes a plan item executable.
 *
 * The design workflow stores the canonical pointer on the promoted feature row,
 * not in plan prose or completion/checkpoint payloads. A dependent plan item
 * inherits that pointer from an accepted promoted blocker: `plan_items.blocked_by`
 * identifies the prerequisite, `source_plan_*` identifies its promoted row, and
 * `(harness_slug, design_spec_id, kind='spec')` validates the artifact join used
 * by `design-phase.get_accepted_spec`. This is deliberately tenant-scoped and
 * read-only; a missing/temporarily unavailable enrichment must not block minting.
 */
async function readAcceptedPlanItemDesignProvenance(args: {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
}): Promise<Partial<AcceptedPlanItemDesignProvenance>> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{
      needs_design: boolean | null;
      design_status: string | null;
      design_spec_id: string | null;
      discarded_design_work: boolean | null;
    }[]>`
      SELECT source.needs_design,
             source.design_status,
             source.design_spec_id,
             source.discarded_design_work
        FROM harness_shared.plan_items target
        JOIN harness_shared.harness_features_consolidated source
          ON source.workspace_id = target.workspace_id
         AND source.harness_slug = target.harness_slug
         AND source.source_plan_slug = target.plan_slug
         AND source.source_plan_item_ids && target.blocked_by
        JOIN harness_shared.harness_design_artifacts artifact
          ON artifact.harness_slug = source.harness_slug
         AND artifact.id = source.design_spec_id
         AND artifact.kind = 'spec'
       WHERE target.workspace_id = ${args.workspaceId}
         AND target.harness_slug = ${args.harnessSlug}
         AND target.plan_slug = ${args.planSlug}
         AND target.item_id = ${args.itemId}
         AND source.design_status = 'accepted'
         AND source.design_spec_id IS NOT NULL
       ORDER BY source.updated_ts DESC NULLS LAST, source.feature_id
       LIMIT 1
    `;
    const row = rows[0];
    if (!row?.design_spec_id || row.design_status !== 'accepted') return {};
    return {
      needsDesign: row.needs_design ?? true,
      designStatus: 'accepted',
      designSpecId: row.design_spec_id,
      discardedDesignWork: row.discarded_design_work ?? false,
    };
  } catch {
    return {};
  }
}

type PlanRead = NonNullable<Awaited<ReturnType<typeof readPlanBySlug>>>;

/**
 * Mirror convertPlanItem's item read: prefer the PG-canonical `row.items`, fall back to the
 * parsed markdown items. `blockedBy` is carried through too (EI-14024) so DAG-blocked items can
 * be minted already GATED instead of briefly claimable.
 *
 * Shared by promotion and P-009's backfill deliberately: the backfill's whole contract is "write
 * what promotion WOULD have written", so if these two ever read the plan differently the backfill
 * stops being a rehearsal of promotion and becomes a second, unreviewed source of edges.
 */
function readRawPlanItems(read: PlanRead): RawPlanItem[] {
  return read.row.items.length > 0
    ? read.row.items.map((i) => ({
        id: i.id,
        status: i.status as string | null,
        text: (i.text as string | null) ?? '',
        blockedBy: Array.isArray((i as { blockedBy?: unknown }).blockedBy)
          ? ((i as { blockedBy: string[] }).blockedBy ?? [])
          : [],
        phase: i.phase ?? null,
      }))
    : read.parsed.items.map((i) => ({
        id: i.id,
        status: i.storedStatus as string | null,
        text: i.text ?? '',
        blockedBy: i.blockedBy ?? [],
        phase: i.phase ?? null,
      }));
}

/**
 * The SPEC TRIAD verdict for a plan about to be promoted (okf-frontmatter-adoption
 * H(b)), or `null` when the requirement does not apply here.
 *
 * FAILS OPEN at every step — an unreadable flag store, a policy throw, anything
 * unexpected returns `null` and promotion proceeds. The failure this must never
 * produce is "an outage in an unrelated subsystem silently stops plan-driven
 * work from entering the queue", which is indistinguishable from the fleet
 * freeze the whole design was corrected to avoid.
 */
async function evaluateSpecTriadForPromotion(
  row: PlanRow,
): Promise<{ gated: boolean; missing: string[]; gap: string; scopeReason: string } | null> {
  try {
    const flagEnabled = await getFlag(FLAGS.SPEC_TRIAD_REQUIRED, systemDistinctId());
    if (!flagEnabled) return null;
    const [{ specTriadGate, specTriadEpoch }, { describeSpecTriadGap }] = await Promise.all([
      import('./agent-tools/plans/spec-triad-policy'),
      import('@papercusp/plan-parser'),
    ]);
    const verdict = specTriadGate(
      {
        planSlug: row.planSlug,
        content: row.content,
        created: row.created,
        itemCount: Array.isArray(row.items) ? row.items.length : undefined,
        template: row.template,
      },
      { flagEnabled: true, epoch: specTriadEpoch() },
    );
    if (!verdict.gated || !verdict.triad) return null;
    return {
      gated: true,
      missing: verdict.missing,
      gap: describeSpecTriadGap(verdict.triad),
      scopeReason: verdict.scope.reason,
    };
  } catch {
    return null;
  }
}

/**
 * The operational `op_status` axis is retired for new fleet-driven execution, but
 * existing plans can still be in flight with only the canonical `## Now` index
 * recording that state. A report-only/no-clause plan already executing must be
 * allowed to continue promotion; otherwise the epoch-based triad rollout turns a
 * compatibility read into a new admission wall. Keep this exact and narrow so a
 * new plan, or one explicitly declaring `specTriad: required`, remains gated.
 */
function isAlreadyExecutingPlan(row: PlanRow): boolean {
  return row.opStatus === 'started' || row.nowState?.trim().toUpperCase() === 'EXECUTING';
}

function isLegacyExecutingReportOnlyPlan(
  row: PlanRow,
  specQuality: PlanSpecQualityGateVerdict,
  specTriad: { gated: boolean; scopeReason: string } | null,
): boolean {
  return (
    isAlreadyExecutingPlan(row) &&
    specQuality.applicable === false &&
    specQuality.mode === 'report-only' &&
    specQuality.wouldBlock.includes('no-first-class-spec-clauses') &&
    specTriad?.gated === true &&
    specTriad.scopeReason === 'created-after-epoch'
  );
}

/**
 * Promote a plan's open items to placeable, unclaimed work-items. Idempotent
 * (re-running mints only newly-open items, never duplicates). Throws on a genuine
 * error so a direct caller/test sees it; plans:start wraps the call in .catch().
 */
export async function promotePlanItems(opts: PromotePlanItemsOptions): Promise<PromotePlanResult> {
  if (opts.planRun) {
    if (opts.planRun.instancePlanSlug !== opts.planSlug) {
      throw new Error(`plan_run_instance_slug_mismatch:${opts.planRun.instancePlanSlug}:${opts.planSlug}`);
    }
    if (!Number.isSafeInteger(opts.planRun.runId) || opts.planRun.runId <= 0) {
      throw new Error('plan_run_id_invalid');
    }
  }
  const enabled = await getFlag(FLAGS.PLAN_WORKITEM_PROMOTION, systemDistinctId());
  if (!enabled) return { promoted: 0, skipped: 0, flagOff: true, ...NO_EDGES };

  const read = await readPlanBySlug(opts.planSlug, {
    harnessSlug: opts.harnessSlug,
    workspaceId: opts.workspaceId,
  });
  if (!read) return { promoted: 0, skipped: 0, ...NO_EDGES, planUnreadable: true };

  // WI-10005441: a rubric row is a grading bar, not a plan with work. Refuse it before any
  // gate, so no gate can file against it (the spec-triad gate filed 25 on 2026-10-02) and no
  // criterion is ever minted as a work-item. Promotion is reached from several callers
  // (plans:start, scout/autostart, routines), so the refusal belongs here, not in one of them.
  const { isSpecTriadExcludedTemplate } = await import('./agent-tools/plans/spec-triad-policy');
  if (isSpecTriadExcludedTemplate(read.row.template)) {
    return {
      promoted: 0,
      skipped: readRawPlanItems(read).filter((item) => isOpenStatus(item.status)).length,
      ...NO_EDGES,
      templateExcluded: read.row.template!,
    };
  }

  // P-003: promotion is independently callable (scout/autostart and routine
  // paths invoke this function directly), so plans:start cannot be its sole
  // authority. The shared snapshot is a no-op for legacy plans and fail-closed
  // for post-epoch contracts before any work-item is minted.
  // Scope to the canonical storage harness of the plan row just read: readPlanBySlug resolves
  // member/install aliases to their plan-storage home, but the acceptance snapshot reader uses
  // the supplied slug verbatim. Passing opts.harnessSlug here can therefore miss this same row
  // on a run-instance promotion and report a missing plan/BAR. A plan slug is unique only per
  // harness, so keep the exact resolved scope rather than widening to an ambiguous unscoped read.
  const acceptanceBarLifecycle = await readAndEvaluateAcceptanceBarLifecycle(opts.planSlug, 'pre-start', {
    harnessSlug: read.row.harnessSlug,
  });
  if (!acceptanceBarLifecycle.satisfied) {
    return {
      promoted: 0,
      skipped: readRawPlanItems(read).filter((item) => isOpenStatus(item.status)).length,
      ...NO_EDGES,
      acceptanceBarBlocked: true,
      acceptanceBarLifecycle,
    };
  }

  const rawItems = readRawPlanItems(read);
  const openItems: OpenPlanItem[] = rawItems
    .filter((i) => isOpenStatus(i.status))
    .map((i) => ({ id: i.id, text: i.text }));
  if (openItems.length === 0) return { promoted: 0, skipped: 0, ...NO_EDGES };

  // P-009: direct promotion is independently callable, so plans:start's guard
  // cannot be the authority. Validate the canonical markdown snapshot as
  // executable before spec gates or pass 1 can mint a single node. `started`
  // forces executable semantics even for a copied/draft frontmatter status.
  const dependencyVerdict = validatePlanCandidateDependencies(read.parsed, 'started');
  if (dependencyVerdict.state === 'rejected') {
    return {
      promoted: 0,
      skipped: openItems.length,
      ...NO_EDGES,
      dependencyBlocked: true,
      dependencyDiagnostics: dependencyVerdict.diagnostics,
    };
  }

  // P-004: direct promotion is a real entry door too. Re-check the same exact
  // specSetHash verdict plans:start uses so a caller cannot bypass the gate by
  // invoking the runner after revising a clause. No-clause plans are report-only.
  const specQuality = await evaluatePlanSpecQualityGate({
    harnessSlug: opts.harnessSlug,
    planSlug: opts.planSlug,
    planItemIds: rawItems.map((item) => item.id),
  });
  if (!specQuality.satisfied) {
    return {
      promoted: 0,
      skipped: openItems.length,
      ...NO_EDGES,
      specQualityBlocked: true,
      specQuality,
    };
  }

  // okf-frontmatter-adoption H(b): the SPEC TRIAD gate, at the point where plan
  // items actually become claimable work. `plans:items { actionable }` is a
  // read; this is the write, so the requirement means nothing unless it is also
  // checked here.
  //
  // Refusing here would ordinarily be the start of a wedge, which is why the
  // refusal FILES ITS OWN EXIT in the same breath rather than deferring to the
  // daily sweep: an agent claims that item, writes the sections, and the next
  // promotion succeeds. No human is in the loop, and nothing is silently
  // dropped — the caller gets `specTriadBlocked` plus the work-item id.
  //
  // No plan that predates the epoch can reach this branch: `specTriadGate`
  // short-circuits out-of-scope plans before evaluating anything. That is the
  // measured freeze guard, not an intention — 330 live plans would otherwise
  // stop promoting the moment the flag went on.
  const specTriad = await evaluateSpecTriadForPromotion(read.row);
  // Compatibility for the retired op_status axis: a plan already executing via
  // the canonical `now_state` index (or the legacy started value) may continue
  // when spec-quality is explicitly report-only because it has no first-class
  // clauses. This does not weaken an explicit `specTriad: required` declaration
  // (`scopeReason` is `required-declared`) or any genuinely new plan.
  const legacyExecutingContinuation = isLegacyExecutingReportOnlyPlan(read.row, specQuality, specTriad);
  if (specTriad?.gated && !legacyExecutingContinuation) {
    const { ensureSpecTriadFiling } = await import('./agent-tools/plans/spec-triad-filing');
    const filed = await ensureSpecTriadFiling({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      planSlug: opts.planSlug,
      missing: specTriad.missing,
      gap: specTriad.gap,
    });
    console.log(
      `[plan-promotion] '${opts.planSlug}' held by the spec triad (${specTriad.missing.join(', ')}) — ` +
        `filing ${filed.outcome}${filed.id ? ` (${filed.id})` : ''}`,
    );
    return {
      promoted: 0,
      skipped: openItems.length,
      ...NO_EDGES,
      specTriadBlocked: true,
      specTriadMissing: specTriad.missing,
      specTriadWorkItem: filed.id,
      specQuality,
    };
  }

  // EI-14024: resolve each item's EFFECTIVE status (blocked-by graph aware, same
  // algorithm scheduler/plan-item-lane-guard.ts checks post-claim) over the FULL
  // item set (a blocker outside `openItems` — e.g. itself blocked — must still
  // resolve correctly), so a freshly-promoted item whose plan-level blockers are
  // still open can be minted already gated instead of briefly claimable.
  const planItemsForResolve: PlanItem[] = rawItems.map((i) => ({
    id: i.id,
    text: i.text,
    storedStatus: (i.status ?? 'todo') as ItemStatus,
    importance: 'normal',
    blockedBy: i.blockedBy,
    decisionRefs: [],
    phase: i.phase,
    lineNumber: 0,
    rawLine: '',
  }));
  // P-008: the SAME resolve also returns `cycleMembers` — the pre-flight the edge write needs,
  // computed here for free, over the FULL item set, BEFORE anything is minted. Promotion used to
  // destructure only `{ items }` and discard it, which is why cycle handling could only ever be
  // post-hoc (catch the writer's throw). See `writePromotedDependencyEdges` for the policy.
  const { items: resolvedItems, cycleMembers } = resolveEffectiveStatusForItems(planItemsForResolve);
  const effectiveById = new Map(resolvedItems.map((i) => [i.id, i]));
  const cyclicPlanItemIds = new Set(cycleMembers);

  // Idempotency: an item already COVERED — an `implements` edge (canonical
  // convert-at-pickup/promotion mint), a `relates` edge (ad-hoc
  // work_items:create{targetPlanItem} coverage — see _create-core.ts §"Forward
  // edge"), or a bare `payload.plan_item` stamp — is never re-promoted.
  // EI-19946482711398073 / WI-37359: this used to call listConvertedPlanItemRefs()
  // alone (implements-only), so a plan item covered ONLY by an ad-hoc work-item
  // (relates + stamp, no implements edge) read as un-promoted and a re-run would
  // mint a DUPLICATE. listCoveredPlanItemRefs() sees both. It is intentionally
  // TENANT-COMPLETE for the edge read (deliberately NOT `opts.workspaceId` — see
  // listConvertedPlanItemRefs' header: the implements/relates plane is split BY
  // FAMILY across two workspaces, so a single-tenant read would be blind to
  // whichever family lives in the other one). Idempotency must over-include,
  // never under-include.
  const coveredRefs = await listCoveredPlanItemRefs(
    opts.planSlug,
    opts.harnessSlug,
    openItems.map((i) => i.id),
  );
  const alreadyIds = openItems.map((i) => i.id).filter((id) => coveredRefs.has(planItemRef(opts.planSlug, id)));

  let reservationsRebound = 0;
  for (const itemId of alreadyIds) {
    const existing = await findConvertedWorkItemByStamp(opts.planSlug, itemId, opts.harnessSlug);
    const payload =
      existing?.payload && typeof existing.payload === 'object' && !Array.isArray(existing.payload)
        ? (existing.payload as Record<string, unknown>)
        : null;
    const expectedFleetSlug = typeof payload?.fleet_slug === 'string' ? payload.fleet_slug.trim() : '';
    if (
      opts.fleetSlug &&
      existing?.id &&
      expectedFleetSlug &&
      (await rebindOrphanedPlanFleetReservation({
        id: existing.id,
        harness: opts.harnessSlug,
        workspaceId: opts.workspaceId,
        fleetSlug: opts.fleetSlug,
      }))
    )
      reservationsRebound++;
  }

  const specs = computePromotions({
    planSlug: opts.planSlug,
    harness: opts.harnessSlug,
    openItems,
    existingPromotedItemIds: alreadyIds,
  });
  const allRunSpecsByPlanItem = opts.planRun
    ? new Map(
        computePromotions({
          planSlug: opts.planSlug,
          harness: opts.harnessSlug,
          openItems,
          existingPromotedItemIds: [],
        }).map((spec) => [spec.sourcePlanItemIds[0], spec]),
      )
    : new Map<string, ReturnType<typeof computePromotions>[number]>();

  // EI-18802263047567602: a promoted work-item belongs to the same explicit
  // relevance areas as its source plan. Before this inheritance, plans tagged
  // through topics:tag were routable to topic subscribers while every WI-* row
  // minted from them was born untagged, so topics:feed and coupled-topic views
  // went blind exactly when planning turned into execution. Read the canonical
  // coord topic edges once per promotion run and pass them through the existing
  // createWorkItem `topics` seam; that seam writes BOTH the routing edge and the
  // claim-spec-visible tag column. Do not infer topics from prose here — explicit
  // plan tags are the reusable source of truth and avoid a second classifier.
  // Topic routing enriches promotion; it must not become a new availability gate
  // on the primary plan→work path if the coordination store is temporarily down.
  const planTopics = await listObjectTags('plan', opts.planRun?.templateSlug ?? opts.planSlug).catch(() => []);

  const textById = new Map(openItems.map((i) => [i.id, i.text]));
  const stampForPlanItem = (itemId: string): PlanItemStamp => {
    const itemTextHash = planItemTextHash(textById.get(itemId));
    return {
      plan_slug: opts.planSlug,
      item_id: itemId,
      harness_slug: opts.harnessSlug,
      ...(itemTextHash ? { item_text_hash: itemTextHash } : {}),
    };
  };
  let promoted = 0;
  /**
   * WI-10005696: stamp every minted OR adopted lane with the goal this promotion serves, so a
   * goal-fenced drain claim spec (`goal` matches positively — a NULL row is invisible) sees the
   * work its own plan just created. Resolved lazily ONCE per call (plan goal, else the
   * promoter's session goal — see `resolvePlanPromotionGoal`), and fail-soft per row: a
   * promotion that succeeded must not be failed for lack of provenance, but the failure is
   * RECORDED on the result (`goalStamp.errors`) instead of swallowed (EI-20075667133396690 —
   * an empty catch made a stamp that THREW indistinguishable from one that declined).
   */
  const goalStamp = { goalId: null as string | null, stamped: 0, errors: [] as string[] };
  let goalIdPending: Promise<string | null> | undefined;
  const stampPromotedLaneGoal = async (workItemId: string, harness: string | null | undefined): Promise<void> => {
    try {
      goalIdPending ??= resolvePlanPromotionGoal({
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
        planSlug: opts.planSlug,
        ownerId: opts.createdBy,
      });
      const goalId = await goalIdPending;
      goalStamp.goalId = goalId;
      if (await stampPromotedGoal({ id: workItemId, harness }, opts.workspaceId, goalId)) goalStamp.stamped++;
    } catch (err) {
      goalStamp.errors.push(`${workItemId}:${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const laneGateFailures: NonNullable<PromotePlanResult['laneGateFailures']> = [];
  /**
   * P-006 PASS 1 — mint every item first, recording `planItemId → workItemId`.
   *
   * The two-pass split is the whole point: a plan item's `blockedBy` names a PLAN-item id
   * (`P-004`), and the work-item id it becomes (`WI-6923`) is not known until that item is
   * minted. A single pass can only translate blockers that happen to appear EARLIER in the
   * list, so any forward reference — an item blocked by one declared below it — would be
   * silently dropped. Minting first makes the whole map available before any edge is written,
   * so translation is order-independent.
   */
  const mintedByPlanItem = new Map<string, string>();
  const newlyPromotedPlanItemIds = new Set<string>();
  const rawByPlanItem = new Map(rawItems.map((item) => [item.id, item]));
  for (const spec of specs) {
    const itemId = spec.sourcePlanItemIds[0];
    // WI-40825: stamp the item-text fingerprint on the PROMOTE path too, not only on
    // convert-at-pickup. `plans:start` → promote is the dominant way a plan item becomes a
    // work-item, so hashing only in convert.ts would leave the read-side drift verdict
    // (`work_items:get.planItemTextDrift`) answering `unknown` for most rows — honest, but
    // inert. `textById` already holds the parser's SEMANTIC text (readRawPlanItems takes
    // `.text` from the PG-canonical row or the parsed item, never the raw line), which is
    // why a status flip or a blocked-by edit still does not read as drift.
    const stamp = stampForPlanItem(itemId);
    const designProvenance = await readAcceptedPlanItemDesignProvenance({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      planSlug: opts.planSlug,
      itemId,
    });
    // D-046 (byoc-cloud-workspaces-gcp-aws-azure-2026-08-22 / WI-40754): ONE canonical
    // promoted work-item per (workspace, harness, plan, item), serialized IN POSTGRES —
    // not by the coverage read above. That read stays as a cheap idempotency
    // optimization, but it is check-then-act: two CONCURRENT promotePlanItems calls both
    // pass it and both mint (live: P-036 minted identical open WI-40504/WI-40513 six
    // seconds apart). `upsertConditionWorkItem` rides migration 741's partial unique
    // index: exactly one caller CREATES (`created:true`), the race-loser's optimistic row
    // is dropped by settleConditionClaim, and BOTH callers get the winner's id back. Both
    // then link + lane-sync the winner — linkWorkItem is ON CONFLICT DO NOTHING, so the
    // double write is idempotent — and only the creator increments `promoted`, keeping
    // `skipped = openItems.length - promoted` correct for adopted/race-lost rows.
    const minted = await upsertConditionWorkItem(
      planPromotionConditionKey(opts.workspaceId, opts.harnessSlug, opts.planSlug, itemId),
      {
        kind: opts.itemKind ?? spec.kind,
        title: spec.title,
        summary: textById.get(itemId) ?? undefined,
        harness: spec.harness,
        workspaceId: opts.workspaceId,
        sourcePlanSlug: opts.planRun?.templateSlug ?? spec.sourcePlanSlug,
        sourcePlanItemIds: [itemId],
        ...designProvenance,
        topics: planTopics,
        payload: {
          plan_item: stamp,
          ...(opts.planRun ? { plan_run: opts.planRun } : {}),
          // EI-21574373783224719: reserve the minted lane for the fleet it was minted FOR
          // (see PromotePlanItemsOptions.fleetSlug). Omitted when this promotion is not
          // fleet-scoped, so an ordinary plans:start keeps today's unreserved behaviour.
          ...(opts.fleetSlug ? { fleet_slug: opts.fleetSlug } : {}),
          needs_2_machine_rig: phaseRequiresTwoMachineRig(rawByPlanItem.get(itemId)?.phase),
        },
        createdBy: opts.createdBy,
        // NO assignee — placeable, UNCLAIMED; the Queen places it.
      },
    );
    // WI-10004234: a lost claim race whose stand-down failed even after retries left a
    // second OPEN lane for this plan item. Fail the promotion loudly instead of reporting
    // success over a duplicate.
    if (minted.duplicateLeftOpen) {
      throw new Error(`plan_promotion_duplicate_left_open:${opts.planSlug}#${itemId}:${minted.duplicateLeftOpen}`);
    }
    if (!minted.id) {
      // The winner settled/vanished between the claim settlement and the holder read — a
      // narrow re-race. Never link against a null id; the next promotion run re-resolves.
      console.warn(
        `[plan-promotion] '${opts.planSlug}#${itemId}' condition upsert returned no winner id — skipped this run`,
      );
      continue;
    }
    // Re-read the WINNER row (created or adopted) so the link + lane sync use the row's
    // ACTUAL stored harness — createWorkItem can normalize a member harness to its Pot
    // home slug (see condition-upsert.ts's header), and the pre-D-046 code linked with
    // the created row's own `wi.harness` for exactly that reason.
    const wi = (await getWorkItem(minted.id, spec.harness)) ?? (await getWorkItem(minted.id));
    const winnerHarness = wi?.harness ?? spec.harness;
    await stampPromotedLaneGoal(minted.id, winnerHarness);
    await linkWorkItem(minted.id, { kind: PLAN_ITEM_KIND, ref: planItemRef(opts.planSlug, itemId) }, IMPLEMENTS_REL, {
      harness: winnerHarness ?? undefined,
      by: opts.createdBy,
    });
    // P-006: activation seeds the immutable BAR/spec projection before a work-item
    // exists.  Promotion is the join point that can now attach the canonical
    // work-item id to every CURRENT clause revision for this plan item.  The
    // append-only edge preserves old proof when a later amendment supersedes it;
    // the completion gate and BAR snapshot classify that old edge as stale.
    await ensureWorkItemSpecRevisionEdges({
      workspaceId: opts.workspaceId,
      harnessSlug: winnerHarness ?? spec.harness,
      planSlug: opts.planSlug,
      planItemIds: [itemId],
      workItemId: minted.id,
      actorId: opts.createdBy,
    });
    // EI-14024: if this item's plan-level blockers are still open (or it needs a
    // human decision), gate it the SAME way the periodic lane-sync sweep
    // (reconcile-linked-work-items.ts's syncLinkedWorkItemsToPlanLane, EI-14699)
    // already does — reused here at MINT time so there is no window where a
    // DAG-blocked item sits plainly claimable. `blockerCompletionUnblocksDependents`
    // (the reverse leg — a blocker's own completion) is already covered: the
    // orphan-reconcile periodic sweep + reconcile-rule.ts re-derive this item's
    // lane on every relevant transition and un-gate it once actionable.
    const effective = effectiveById.get(itemId);
    const laneStatus: PlanLaneSyncStatus | null =
      effective?.effectiveStatus === 'blocked' ? 'blocked' : effective?.needsHuman ? 'needs-human' : null;
    if (laneStatus) {
      try {
        const laneSync = await syncLinkedWorkItemsToPlanLane(
          { planSlug: opts.planSlug, itemId, harnessSlug: opts.harnessSlug },
          laneStatus,
        );
        for (const failure of laneSync.failures ?? []) {
          laneGateFailures.push({
            itemId,
            workItemId: minted.id,
            stage: failure.stage,
            message: failure.message,
          });
        }
      } catch (error) {
        // The reconciler is fail-soft internally; keep minting if its contract
        // regresses, but make the exceptional rejection visible to the caller.
        const failure = {
          itemId,
          workItemId: minted.id,
          stage: 'sync-rejection' as const,
          message: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        };
        laneGateFailures.push(failure);
        console.warn(`[plan-promotion] mint-time lane sync failure ${JSON.stringify(failure)}`);
      }
    }
    mintedByPlanItem.set(itemId, minted.id);
    if (minted.created) {
      promoted++;
      newlyPromotedPlanItemIds.add(itemId);
    }
  }

  // A deterministic run replay must recover the SAME execution records even
  // when this invocation minted none. Resolve every open item's canonical
  // stamp after the write pass; newly-minted ids stay query-free.
  const workItemByPlanItem = new Map(mintedByPlanItem);
  for (const item of openItems) {
    if (workItemByPlanItem.has(item.id)) continue;
    const existing = await findConvertedWorkItemByStamp(opts.planSlug, item.id, opts.harnessSlug);
    if (existing?.id) {
      workItemByPlanItem.set(item.id, existing.id);
      continue;
    }
    if (!opts.planRun) continue;

    // The plan-run replay path has a stronger identity oracle than the generic
    // stamp read: the per-instance promotion condition key. The stamp helper's
    // legacy read resolves feature rows through the process-global active
    // workspace, which can legitimately differ from this explicit run's
    // workspace. Adopt the condition-key winner instead of returning an empty
    // replay mapping (or silently fabricating success). This also self-heals a
    // missing implements edge on the canonical winner.
    const spec = allRunSpecsByPlanItem.get(item.id);
    if (!spec) continue;
    const designProvenance = await readAcceptedPlanItemDesignProvenance({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      planSlug: opts.planSlug,
      itemId: item.id,
    });
    const adopted = await upsertConditionWorkItem(
      planPromotionConditionKey(opts.workspaceId, opts.harnessSlug, opts.planSlug, item.id),
      {
        kind: opts.itemKind ?? spec.kind,
        title: spec.title,
        summary: textById.get(item.id) ?? undefined,
        harness: spec.harness,
        workspaceId: opts.workspaceId,
        sourcePlanSlug: opts.planRun.templateSlug,
        sourcePlanItemIds: [item.id],
        ...designProvenance,
        topics: planTopics,
        payload: {
          plan_item: stampForPlanItem(item.id),
          plan_run: opts.planRun,
          // EI-21574373783224719: same fleet reservation as the mint path above — an
          // ADOPTED row is just as self-selectable by outsiders as a freshly minted one.
          ...(opts.fleetSlug ? { fleet_slug: opts.fleetSlug } : {}),
          needs_2_machine_rig: phaseRequiresTwoMachineRig(rawByPlanItem.get(item.id)?.phase),
        },
        createdBy: opts.createdBy,
      },
    );
    if (adopted.duplicateLeftOpen) {
      throw new Error(`plan_promotion_duplicate_left_open:${opts.planSlug}#${item.id}:${adopted.duplicateLeftOpen}`);
    }
    if (!adopted.id) continue;
    workItemByPlanItem.set(item.id, adopted.id);
    if (adopted.created) {
      promoted++;
      newlyPromotedPlanItemIds.add(item.id);
    }
    const wi = (await getWorkItem(adopted.id, spec.harness)) ?? (await getWorkItem(adopted.id));
    await stampPromotedLaneGoal(adopted.id, wi?.harness ?? spec.harness);
    await linkWorkItem(adopted.id,{ kind: PLAN_ITEM_KIND, ref: planItemRef(opts.planSlug, item.id) }, IMPLEMENTS_REL, {
      harness: wi?.harness ?? spec.harness,
      by: opts.createdBy,
    });
    await ensureWorkItemSpecRevisionEdges({
      workspaceId: opts.workspaceId,
      harnessSlug: wi?.harness ?? spec.harness,
      planSlug: opts.planSlug,
      planItemIds: [item.id],
      workItemId: adopted.id,
      actorId: opts.createdBy,
    });
  }

  const workItems: PromotedPlanWorkItem[] = openItems.flatMap((item) => {
    const workItemId = workItemByPlanItem.get(item.id);
    if (!workItemId) return [];
    const effective = effectiveById.get(item.id);
    return [
      {
        planItemId: item.id,
        workItemId,
        newlyPromoted: newlyPromotedPlanItemIds.has(item.id),
        actionable:
          effective?.effectiveStatus === 'todo' && effective.unresolvedBlockers.length === 0 && !effective.needsHuman,
      },
    ];
  });

  const edgeCounts = await writePromotedDependencyEdges({
    planSlug: opts.planSlug,
    harnessSlug: opts.harnessSlug,
    // Ordinary plans retain the original "new rows only" write. A run replay
    // deliberately replays the full run-local graph so a crash after node mint
    // but before edge completion heals rather than staying permanently partial.
    mintedByPlanItem: opts.planRun ? workItemByPlanItem : mintedByPlanItem,
    blockedByById: new Map(rawItems.map((i) => [i.id, i.blockedBy])),
    statusById: new Map(rawItems.map((i) => [i.id, i.status])),
    cyclicPlanItemIds,
    knownPlanItemIds: new Set(rawItems.map((i) => i.id)),
    preserveExistingEdges: Boolean(opts.planRun),
    failOnTransientEdgeFailure: true,
  });

  return {
    promoted,
    skipped: openItems.length - promoted,
    ...edgeCounts,
    workItems,
    specQuality,
    reservationsRebound,
    ...(laneGateFailures.length > 0 ? { laneGateFailures } : {}),
    ...(goalStamp.goalId || goalStamp.errors.length > 0 ? { goalStamp } : {}),
  };
}

/**
 * WI-10003675: a promotion whose dependency edges could not be written because of
 * serialization contention, even after the bounded re-attempts. Thrown AFTER the whole edge
 * pass, so every other item's edges are still written. Before this, the error was swallowed
 * into `edgeFailures`, which no caller reads, and a join item was left with zero blockers.
 */
export class PromotionDependencyEdgeError extends Error {
  readonly failedItems: readonly string[];
  constructor(harnessSlug: string, planSlug: string, failedItems: string[]) {
    super(
      `plan promotion could not write blocker edges for ${failedItems.length} item(s) in ` +
        `${harnessSlug}/${planSlug} after exhausting serialization-contention retries: ` +
        `${failedItems.join('; ')}. The items are minted but not dependency-gated; re-run the ` +
        `promotion (a plan run replays the full graph), or run backfillPromotedDependencyEdges.`,
    );
    this.name = 'PromotionDependencyEdgeError';
    this.failedItems = failedItems;
  }
}

/** Serialization contention (SSI abort / deadlock), directly or after in-txn retry exhaustion. */
export function isTransientDependencyWriteError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'SerializableRetryExhaustedError' || e.code === '40001' || e.code === '40P01';
}

/**
 * WI-10003675: call the canonical edge writer, re-attempting the WHOLE writer when it fails
 * with serialization contention. The writer already retries inside its own SERIALIZABLE
 * boundary; this is the outer, slower tier that spaces attempts past a burst of concurrent
 * promotions. Non-contention errors (a live-graph cycle, I/O) propagate on the first try.
 */
export async function syncBlockEdgesWithContentionRetry(
  sync: (harnessSlug: string, workItemId: string, blockers: string[]) => Promise<unknown>,
  harnessSlug: string,
  workItemId: string,
  blockers: string[],
  opts: { extraAttempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const extraAttempts = opts.extraAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      await sync(harnessSlug, workItemId, blockers);
      return;
    } catch (err) {
      if (attempt >= extraAttempts || !isTransientDependencyWriteError(err)) throw err;
      // Half fixed + half jitter, so contending promoters de-synchronise.
      const ceil = baseDelayMs * 2 ** attempt;
      await sleep(Math.floor(ceil / 2 + Math.random() * (ceil / 2)));
    }
  }
}

/**
 * P-006 PASS 2 — translate each newly-minted item's plan-level `blockedBy` into real
 * `blocks` edges, so a promoted plan carries its DAG into the scheduler instead of only its
 * nodes. Until now promotion read `blockedBy` solely to pick a lane (EI-14024's gate), which
 * parks an item as `blocked` but records no edge — so nothing ever un-gated it from the
 * dependency side, and the graph the plan described existed nowhere queryable.
 *
 * ⚠ WHICH WRITER — this is the part that is easy to get wrong and impossible to notice.
 * Per D-010, edges go through `syncFeatureBlockEdges`, the policy-bearing canonical writer,
 * rather than issuing raw work_item_deps DML here. That keeps replacement semantics and the
 * acyclicity guard centralized even though the physical store is now singular.
 *
 * Endpoint form follows D-009 rule 1: promoted items are FEATURE-family (computePromotions
 * hardcodes `kind: 'feature'`), so `featureRef()`'s harness-qualified `<harness>#<id>` is the
 * correct form on both sides — the form a feature-family floor can actually see.
 *
 * ⚠ CYCLES + UNRESOLVABLE REFS — P-008's ruling, replacing P-006's interim (D-012).
 * PRE-FLIGHT AND REJECT, at EDGE granularity: an edge is refused BEFORE the write when either
 * side is in a plan-level `blockedBy` cycle. This matches the house convention set by
 * `POST /features/import` (validate the union graph, refuse before writing — D-011) and by
 * `syncFeatureBlockEdges` itself, which rejects a cycle-closing set at the authoritative writer.
 *
 * REJECT THE EDGES, NOT THE PROMOTION — the one place this deliberately departs from features.ts,
 * which 400s the whole batch. Three reasons: (1) promotion's stated purpose is that a started plan
 * never sits at zero work-items, so refusing 20 healthy items over one cyclic pair defeats the
 * runner; (2) plans:start calls this fire-and-forget under `.catch()`, so a throw is swallowed
 * invisibly — an aborted promotion would be indistinguishable from a disabled one; (3) refusing
 * the edge costs no safety, because a cycle member is ALREADY gated: it resolves to
 * effectiveStatus `blocked`, so pass 1's lane gate parks it. features.ts has no such fallback —
 * its batch IS edges, so rejecting the request and rejecting the edges are the same act.
 *
 * Withholding the edge is also the RECOVERABLE choice. A cycle is a plan-authoring error that
 * `plans:lint` already reports; once the plan is fixed the periodic lane sweep re-derives the
 * item's status and un-gates it. Had we written the cyclic edges instead, fixing the plan would
 * NOT clear them — nothing rewrites promoted edges after the fact — leaving a permanent frontier
 * deadlock in the graph.
 *
 * Pre-flighting also makes the outcome ORDER-INDEPENDENT, which the interim was not: catching the
 * writer's throw per item meant that for a 2-cycle the FIRST write succeeded and only the second
 * was refused, persisting one arbitrary arrow of the cycle. Which arrow survived depended on mint
 * order. The pre-flight sees the whole set at once and refuses all of it.
 *
 * The writer's own guard is KEPT as the backstop, and now means something specific: a cross-plan
 * cycle the plan-level graph cannot see (an existing edge from an earlier-promoted item back into
 * this plan) or genuine I/O — counted in `edgeFailures`, no longer the expected path.
 */
async function writePromotedDependencyEdges(args: {
  planSlug: string;
  harnessSlug: string;
  /** planItemId → workItemId for the items minted THIS call. */
  mintedByPlanItem: ReadonlyMap<string, string>;
  blockedByById: ReadonlyMap<string, string[]>;
  statusById: ReadonlyMap<string, string | null>;
  /** P-008 pre-flight: plan items in a `blockedBy` cycle (from resolveEffectiveStatusForItems). */
  cyclicPlanItemIds: ReadonlySet<string>;
  /** Every plan item id, so a `blockedBy` ref naming no item is distinguishable from an unpromoted one. */
  knownPlanItemIds: ReadonlySet<string>;
  /**
   * P-009/D-015: UNION the plan-derived blockers with the item's CURRENT edges instead of
   * replacing them. Default false, which keeps the promotion path byte-identical.
   *
   * `syncFeatureBlockEdges` is DELETE-all-then-INSERT on the blocked side. That is safe at
   * promotion only because pass 1 minted the item microseconds earlier, so its edge set is
   * necessarily empty — a precondition of the CALLER, invisible here. A backfill targets items
   * that have existed for weeks and may already carry edges from another author entirely
   * (measured: 3 of 185, all agent-authored, all naming a plan item the plan's own `blockedBy`
   * does not). Replacing them would silently delete a gate, which is the same bug class this
   * plan exists to fix, pointed the other way.
   */
  preserveExistingEdges?: boolean;
  /**
   * Compute every counter but perform NO write. Deliberately gates only the
   * `syncFeatureBlockEdges` call, not the resolution logic above it — a dry run that skipped
   * the stamp lookups, the cycle pre-flight or the terminal-blocker skip would measure a
   * different function than the real run and be worse than no rehearsal at all.
   */
  dryRun?: boolean;
  /**
   * WI-10003675: throw {@link PromotionDependencyEdgeError} after the pass when any edge write
   * exhausted its serialization-contention retries. Promotion sets this so the caller sees the
   * failure (a plan-run replay then heals the full graph). The backfill leaves it off: it
   * sweeps many plans and must not abort the rest on one contended item. It counts the
   * failure instead and re-covers the item on its next run.
   */
  failOnTransientEdgeFailure?: boolean;
}): Promise<{
  edgesWritten: number;
  edgeFailures: number;
  edgesRejectedCyclic: number;
  blockersDangling: number;
  blockersUnresolved: number;
  edgesPreserved: number;
}> {
  let edgesWritten = 0;
  let edgeFailures = 0;
  const transientEdgeFailures: string[] = [];
  let edgesRejectedCyclic = 0;
  let blockersDangling = 0;
  let blockersUnresolved = 0;
  let edgesPreserved = 0;

  // D-015: ONE read of the live blocks graph for the whole plan (not one per item) — the union
  // source. Loaded up front so a plan with no pre-existing edges costs exactly one query.
  const existingBlockers = args.preserveExistingEdges ? await getFeatureBlockers(args.harnessSlug) : null;

  if (args.cyclicPlanItemIds.size > 0) {
    // Loud, once per plan: the plan cannot express a valid ordering for these items, so their
    // edges are withheld until a human fixes the plan (plans:lint reports the same cycle).
    console.warn(
      `[plan-workitem-promotion] plan '${args.planSlug}' has a blocked-by CYCLE among ` +
        `[${[...args.cyclicPlanItemIds].join(', ')}] — dependency edges touching these items are ` +
        `REFUSED (they stay gated via their blocked lane); fix the plan's blocked-by graph`,
    );
  }

  // A blocker may have been promoted by an EARLIER run (this call only mints newly-open
  // items), so the map alone is not enough: without the stamp lookup, incremental promotion
  // — the common case, an item added to a plan that already started — would drop exactly the
  // edges pointing back at the plan's existing work. Cached: one lookup per distinct blocker.
  const resolvedByStamp = new Map<string, string | null>();
  const resolveBlocker = async (planItemId: string): Promise<string | null> => {
    const minted = args.mintedByPlanItem.get(planItemId);
    if (minted) return minted;
    const cached = resolvedByStamp.get(planItemId);
    if (cached !== undefined) return cached;
    const wi = await findConvertedWorkItemByStamp(args.planSlug, planItemId, args.harnessSlug);
    const id = wi?.id ?? null;
    resolvedByStamp.set(planItemId, id);
    return id;
  };

  for (const [planItemId, workItemId] of args.mintedByPlanItem) {
    const blockers = args.blockedByById.get(planItemId) ?? [];
    if (blockers.length === 0) continue;

    const blockedSideCyclic = args.cyclicPlanItemIds.has(planItemId);
    const blockerWorkItemIds: string[] = [];
    for (const blockerPlanItemId of blockers) {
      // A done/dropped blocker is SATISFIED, not missing — it never promoted (openItems
      // filters it out) and must not gate anything. Skipped silently, and deliberately NOT
      // counted as unresolved: counting it would make every healthy plan look anomalous.
      if (!isOpenStatus(args.statusById.get(blockerPlanItemId) ?? null)) continue;
      // P-008 PRE-FLIGHT: refuse the edge if EITHER side sits in a cycle. Both directions
      // matter — a cyclic blocker is permanently non-terminating, so gating an otherwise
      // healthy item on it would propagate the deadlock outward from the cycle.
      if (blockedSideCyclic || args.cyclicPlanItemIds.has(blockerPlanItemId)) {
        edgesRejectedCyclic++;
        continue;
      }
      if (!args.knownPlanItemIds.has(blockerPlanItemId)) {
        // A `blockedBy` naming no plan item at all — an authoring error, not a promotion gap.
        // Checked before the stamp lookup: there is nothing for it to find.
        blockersDangling++;
        continue;
      }
      const resolved = await resolveBlocker(blockerPlanItemId);
      if (!resolved) {
        // A REAL, still-open blocker that resolved to no work-item: a promotion that should
        // have happened and didn't. Surfaced in the result rather than dropped on the floor —
        // a silently-missing edge is precisely this plan's bug class.
        blockersUnresolved++;
        continue;
      }
      if (resolved !== workItemId) blockerWorkItemIds.push(resolved);
    }
    // Nothing to write. Note we do NOT call the sync with an empty set: it has REPLACE
    // semantics, so an empty call would clear edges rather than leave them alone.
    if (blockerWorkItemIds.length === 0) continue;

    // D-015: under `preserveExistingEdges`, carry the item's current blockers through the
    // replace. Order puts the pre-existing set first so the write is stable across re-runs.
    const carried = (existingBlockers?.get(workItemId) ?? []).filter(
      (b) => b !== workItemId && !blockerWorkItemIds.includes(b),
    );
    const toWrite = carried.length > 0 ? [...carried, ...blockerWorkItemIds] : blockerWorkItemIds;

    if (args.dryRun) {
      edgesWritten += blockerWorkItemIds.length;
      edgesPreserved += carried.length;
      continue;
    }

    try {
      await syncBlockEdgesWithContentionRetry(syncFeatureBlockEdges, args.harnessSlug, workItemId, toWrite);
      edgesWritten += blockerWorkItemIds.length;
      edgesPreserved += carried.length;
    } catch (err) {
      if (isTransientDependencyWriteError(err)) {
        // WI-10003675: serialization contention is NOT the cycle/I-O backstop below. Swallowing
        // it minted a join with zero blocker edges under concurrent promotion. After the bounded
        // re-attempts are exhausted, record it and fail the promotion LOUD once the pass is done.
        edgeFailures++;
        transientEdgeFailures.push(`${workItemId} (plan item ${planItemId})`);
        console.error(
          `[plan-workitem-promotion] blocks-edge write EXHAUSTED contention retries for ` +
            `${args.harnessSlug}#${workItemId} (plan ${args.planSlug} item ${planItemId}, ` +
            `blockers [${blockerWorkItemIds.join(', ')}]):`,
          err,
        );
        continue;
      }
      // BACKSTOP (P-008/D-012), no longer the expected path: the plan-level pre-flight above
      // has already refused every edge the plan's OWN graph makes cyclic, so reaching here means
      // a cycle only the LIVE graph shows — an existing edge from an earlier-promoted item back
      // into this plan, which no plan-level check can see — or genuine I/O. Still non-fatal for
      // the same reason the pre-flight refuses edges rather than the promotion: the items are
      // already minted, and plans:start's `.catch()` would swallow a throw invisibly. Counted on
      // the result so a caller can see it rather than infer it from a log line.
      edgeFailures++;
      console.warn(
        `[plan-workitem-promotion] blocks-edge write failed for ${args.harnessSlug}#${workItemId} ` +
          `(plan ${args.planSlug} item ${planItemId}, blockers [${blockerWorkItemIds.join(', ')}]):`,
        err,
      );
    }
  }

  if (args.failOnTransientEdgeFailure && transientEdgeFailures.length > 0) {
    throw new PromotionDependencyEdgeError(args.harnessSlug, args.planSlug, transientEdgeFailures);
  }

  return {
    edgesWritten,
    edgeFailures,
    edgesRejectedCyclic,
    blockersDangling,
    blockersUnresolved,
    edgesPreserved,
  };
}

/** Per-plan counters from the backfill, so a surprising total is attributable to a plan. */
export interface BackfillPlanEdgeResult {
  planSlug: string;
  itemsConsidered: number;
  edgesWritten: number;
  edgeFailures: number;
  edgesRejectedCyclic: number;
  blockersDangling: number;
  blockersUnresolved: number;
  edgesPreserved: number;
}

export interface BackfillDependencyEdgesResult {
  dryRun: boolean;
  /** Plans carrying ≥1 promoted item — the candidate set actually read. */
  plansScanned: number;
  /** Plans that contributed ≥1 considered item (the rest had no open, promoted, blocked item). */
  plansTouched: number;
  /** Already-promoted, still-open plan items with ≥1 `blockedBy` — the iteration set. */
  itemsConsidered: number;
  edgesWritten: number;
  edgeFailures: number;
  edgesRejectedCyclic: number;
  blockersDangling: number;
  blockersUnresolved: number;
  edgesPreserved: number;
  /** Only plans with a nonzero counter, so the report stays readable at 150+ plans. */
  perPlan: BackfillPlanEdgeResult[];
}

/**
 * P-009 BACKFILL — give ALREADY-promoted plan items the dependency edges promotion would write
 * for them today. Promotion (P-006) only writes edges for items it mints in that call, so every
 * plan promoted before P-006 landed carries its NODES with none of its GRAPH.
 *
 * This is deliberately NOT a second edge writer. It reuses `writePromotedDependencyEdges` whole
 * (D-014) by feeding it the ALREADY-PROMOTED `planItemId → workItemId` pairs where promotion
 * feeds the newly-minted ones — the parameter is named `mintedByPlanItem` but its actual meaning
 * is "the pairs to write edges FOR", and everything downstream of it (the stamp lookup for
 * blockers promoted by an earlier run, D-012's per-edge cycle pre-flight, the terminal-blocker
 * skip, the dangling-vs-unresolved split, the never-call-sync-with-an-empty-set rule) is already
 * backfill-correct. Consequently the backfill inherits D-010's authoritative writer and cannot
 * trip P-007's `lint:no-raw-block-edge` guard.
 *
 * ONE behavior differs, and it is a correction rather than a variation — see D-015: the writer is
 * called with `preserveExistingEdges`, because `syncFeatureBlockEdges` replaces the blocked side's
 * whole edge set and these items, unlike freshly-minted ones, may already carry edges another
 * author wrote.
 *
 * NOT flag-gated, on purpose. `FLAGS.PLAN_WORKITEM_PROMOTION` gates the automatic write-path so a
 * plan start cannot mint work-items unexpectedly; this is an explicitly-invoked, idempotent repair
 * of data that already exists. Gating it behind that flag would make the repair unavailable in
 * exactly the state that most needs it (items promoted while the flag was on, flag since off).
 *
 * Idempotent: re-running converges rather than duplicating — `syncFeatureBlockEdges` is
 * set-to-exactly-this-list and the union in D-015 is order-stable.
 */
export async function backfillPromotedDependencyEdges(opts: {
  workspaceId: string;
  harnessSlug: string;
  /** Restrict to these plans; default = every plan with ≥1 promoted item. */
  planSlugs?: readonly string[];
  /** Compute and report without writing. Run this FIRST — it yields the true expected write count. */
  dryRun?: boolean;
}): Promise<BackfillDependencyEdgesResult> {
  const dryRun = opts.dryRun ?? false;

  // The candidate plans: every plan with at least one `implements` edge, i.e. at least one
  // promoted item. Derived from the SAME truth promotion uses for idempotency, so the backfill
  // cannot consider a plan promotion would not have.
  let planSlugs: string[];
  if (opts.planSlugs) {
    planSlugs = [...opts.planSlugs];
  } else {
    // Tenant-COMPLETE discovery (see listConvertedPlanItemRefs' header). Reading a SINGLE
    // workspace here is a SILENT under-coverage: the implements plane is split by family, and
    // measured 2026-08-02 the single-tenant read discovered 18 of 24 edges and missed 4 plans
    // outright while every counter reported healthy (0 failures / 0 dangling / 0 unresolved).
    // A migration that half-runs and reports success is worse than one that fails loudly.
    const refs = await listConvertedPlanItemRefs();
    const slugs = new Set<string>();
    for (const ref of refs) {
      // planItemRef is `<planSlug>#<itemId>`; split on the LAST '#' so a slug containing one
      // cannot truncate the plan name (item ids never contain '#').
      const hash = ref.lastIndexOf('#');
      if (hash > 0) slugs.add(ref.slice(0, hash));
    }
    planSlugs = [...slugs].sort();
  }

  const totals: BackfillDependencyEdgesResult = {
    dryRun,
    plansScanned: 0,
    plansTouched: 0,
    itemsConsidered: 0,
    edgesWritten: 0,
    edgeFailures: 0,
    edgesRejectedCyclic: 0,
    blockersDangling: 0,
    blockersUnresolved: 0,
    edgesPreserved: 0,
    perPlan: [],
  };

  for (const planSlug of planSlugs) {
    const read = await readPlanBySlug(planSlug, {
      harnessSlug: opts.harnessSlug,
      workspaceId: opts.workspaceId,
    });
    // A converted ref for a plan in ANOTHER workspace/harness — not ours to touch.
    if (!read) continue;
    totals.plansScanned++;

    const rawItems = readRawPlanItems(read);
    if (rawItems.length === 0) continue;

    // Same resolve promotion runs, over the FULL item set, for the same reason: `cycleMembers`
    // IS D-012's pre-flight, and a blocker outside the open set must still resolve correctly.
    const planItemsForResolve: PlanItem[] = rawItems.map((i) => ({
      id: i.id,
      text: i.text,
      storedStatus: (i.status ?? 'todo') as ItemStatus,
      importance: 'normal',
      blockedBy: i.blockedBy,
      decisionRefs: [],
      phase: i.phase,
      lineNumber: 0,
      rawLine: '',
    }));
    const { cycleMembers } = resolveEffectiveStatusForItems(planItemsForResolve);

    // The iteration set: items promotion WOULD write an edge for — still-open, ≥1 blocker — that
    // are ALREADY promoted. Openness is judged on PLAN-item status, matching promotion's
    // `openItems` filter, so the backfill covers exactly the items promotion would have.
    const existingByPlanItem = new Map<string, string>();
    for (const item of rawItems) {
      if (!isOpenStatus(item.status) || item.blockedBy.length === 0) continue;
      const wi = await findConvertedWorkItemByStamp(planSlug, item.id, opts.harnessSlug);
      if (wi?.id) existingByPlanItem.set(item.id, wi.id);
    }
    if (existingByPlanItem.size === 0) continue;

    const counts = await writePromotedDependencyEdges({
      planSlug,
      harnessSlug: opts.harnessSlug,
      mintedByPlanItem: existingByPlanItem,
      blockedByById: new Map(rawItems.map((i) => [i.id, i.blockedBy])),
      statusById: new Map(rawItems.map((i) => [i.id, i.status])),
      cyclicPlanItemIds: new Set(cycleMembers),
      knownPlanItemIds: new Set(rawItems.map((i) => i.id)),
      preserveExistingEdges: true,
      dryRun,
    });

    totals.plansTouched++;
    totals.itemsConsidered += existingByPlanItem.size;
    totals.edgesWritten += counts.edgesWritten;
    totals.edgeFailures += counts.edgeFailures;
    totals.edgesRejectedCyclic += counts.edgesRejectedCyclic;
    totals.blockersDangling += counts.blockersDangling;
    totals.blockersUnresolved += counts.blockersUnresolved;
    totals.edgesPreserved += counts.edgesPreserved;

    const nonZero =
      counts.edgesWritten > 0 ||
      counts.edgeFailures > 0 ||
      counts.edgesRejectedCyclic > 0 ||
      counts.blockersDangling > 0 ||
      counts.blockersUnresolved > 0 ||
      counts.edgesPreserved > 0;
    if (nonZero) {
      totals.perPlan.push({
        planSlug,
        itemsConsidered: existingByPlanItem.size,
        ...counts,
      });
    }
  }

  return totals;
}
