/**
 * The ACCEPTANCE-READINESS hold for self-select claims (plan
 * feature-drain-delivery-readiness-and-outcome-accounting-2026-10-01, P-002 part b;
 * BARs R-3 / R-16 / R-18; D-008 §5 as amended by D-011).
 *
 * The problem it closes: a plan-bound work-item whose acceptance requirement is still
 * INCOMPLETE — its mapped clause was never accepted (AUTO-BAR clauses are seeded
 * `draft`), it has no METHOD, or it has no runnable CHECK — used to be handed out
 * exactly like ready work. A worker then builds against a bar nobody can grade, and
 * the item either stalls at the acceptance gate or ships against an unfinished
 * contract. The scheduler should not hand that work out; it should route the gap to
 * whoever repairs the contract.
 *
 * Mechanism — two halves, both reusing an existing surface:
 *   1. VERDICT. Read the same `readAcceptanceBarContractSnapshot` the acceptance gate
 *      and the plan's `## Now` BAR-readiness stamp are computed from (D-011: the Now
 *      stamp is only restamped on item-dropped / decision-added writes, NOT on
 *      `rubrics:amend`, so it misses a freshly seeded draft clause — exactly R-18's
 *      case). A claimed item is HELD iff some BAR with a binding mapping to one of its
 *      plan items carries one of {@link ACCEPTANCE_READINESS_HOLD_CODES}.
 *   2. ROUTE. Find-or-file ONE repair task per plan (payload key
 *      `acceptanceContractRepairFor`), under a transaction advisory lock so two
 *      concurrent pulls cannot file twice (R-16), and write a `blocks` edge from that
 *      task to the held item. The edge IS the hold: the claim floor
 *      (`unsatisfiedBlockerSql`) then excludes the item from every claim surface, so
 *      claimable / awaiting signals stay honest, and closing the repair task releases
 *      it through the ordinary settle path. If the task closes while the contract is
 *      still incomplete, the next claim simply files a fresh one.
 *
 * Over-blocking control (R-18): the verdict is per ITEM, never per plan. An item whose
 * own mapped BARs are complete, or an item no BAR maps at all (independent work in the
 * same plan), is never held because a sibling is. A plan with no acceptance rubric yet
 * has no mapped BARs and holds nothing — rubrics are authored AFTER implementation, so
 * holding on a missing rubric would deadlock every plan.
 *
 * Wired as the second verdict at getNextForBee's post-claim plan-lane check
 * (claim-spec-store.ts), so the existing bounce → audit → release path runs unchanged
 * and `laneReason` distinguishes this hold from a plan-lane block.
 *
 * Fails OPEN (null) on a snapshot read failure, same contract as the lane guard: an
 * acceptance read hiccup must never wedge the shared claim path.
 */
import type { WorkItem } from '../work-items';
import type { AcceptanceBarContractSnapshot, AcceptanceBarSnapshotCode } from '../acceptance-bar-contract-snapshot';
import type { PlanItemLaneBlock, PlanItemStamp } from './plan-item-lane-guard';

/** The readiness codes that mean "this acceptance requirement is not yet a gradeable contract". */
export const ACCEPTANCE_READINESS_HOLD_CODES: readonly AcceptanceBarSnapshotCode[] = [
  'bar_snapshot_clause_not_accepted',
  'bar_snapshot_method_missing',
  'bar_snapshot_check_missing',
];

/**
 * Clause lifecycles that no longer bind an item. A `draft` clause DOES bind — it is the
 * unaccepted state this hold exists to catch. Absence of the field (older snapshots) is
 * treated as binding, matching the snapshot's own fail-closed convention.
 */
const NON_BINDING_LIFECYCLES: ReadonlySet<string> = new Set(['retired', 'superseded', 'exempt']);

/** Payload key that identifies a plan's acceptance-contract repair task. */
export const ACCEPTANCE_REPAIR_PAYLOAD_KEY = 'acceptanceContractRepairFor';

export interface HeldAcceptanceBar {
  barKey: string;
  /** The plan item(s) of the claimed work-item this BAR binds. */
  itemIds: string[];
  /** The hold codes this BAR carries (a subset of ACCEPTANCE_READINESS_HOLD_CODES). */
  codes: AcceptanceBarSnapshotCode[];
}

type SnapshotBars = Pick<AcceptanceBarContractSnapshot, 'bars'>;

/**
 * Pure verdict: the BARs that bind one of `itemIds` and are incomplete. Empty ⇒ not held.
 * Plan-item ids are compared case-insensitively ("p-002" and "P-002" are one item).
 */
export function incompleteAcceptanceBarsForItems(
  snapshot: SnapshotBars,
  itemIds: readonly string[],
): HeldAcceptanceBar[] {
  const wanted = new Set(itemIds.map((id) => id.trim().toUpperCase()).filter(Boolean));
  if (wanted.size === 0) return [];
  const held: HeldAcceptanceBar[] = [];
  for (const bar of snapshot.bars ?? []) {
    const bound = new Set<string>();
    for (const mapping of bar.mappings ?? []) {
      const itemId = mapping.planItemId?.trim().toUpperCase();
      if (!itemId || !wanted.has(itemId)) continue;
      if (mapping.lifecycleStatus && NON_BINDING_LIFECYCLES.has(mapping.lifecycleStatus)) continue;
      bound.add(itemId);
    }
    if (bound.size === 0) continue;
    const codes = (bar.readiness?.codes ?? []).filter((code) => ACCEPTANCE_READINESS_HOLD_CODES.includes(code));
    if (codes.length === 0) continue;
    held.push({ barKey: bar.barKey, itemIds: [...bound].sort(), codes: [...new Set(codes)] });
  }
  return held;
}

export interface AcceptanceRepairTaskInput {
  planSlug: string;
  harness?: string;
  workspaceId?: string;
  heldBars: HeldAcceptanceBar[];
  by: string;
}

export interface AcceptanceReadinessHoldDeps {
  resolveStamp: (workItem: AcceptanceHoldWorkItem) => Promise<PlanItemStamp | null>;
  readSnapshot: (planSlug: string, harnessSlug: string | undefined) => Promise<SnapshotBars>;
  /** Find the plan's open repair task, or file one. Must be exactly-once under concurrency. */
  findOrFileRepairTask: (input: AcceptanceRepairTaskInput) => Promise<{ id: string; filed: boolean }>;
  /** Write the `repair blocks held` edge. Idempotent; returns an error string when refused. */
  linkHold: (input: { repairId: string; heldId: string; harness?: string; by: string }) => Promise<string | null>;
}

export type AcceptanceHoldWorkItem = Pick<WorkItem, 'payload' | 'harness'> &
  Partial<Pick<WorkItem, 'id' | 'family' | 'sourcePlanSlug' | 'sourcePlanItemIds'>>;

function repairTaskTitle(planSlug: string, heldBars: HeldAcceptanceBar[]): string {
  const keys = heldBars.map((bar) => bar.barKey);
  const shown = keys.slice(0, 4).join(', ') + (keys.length > 4 ? ` +${keys.length - 4} more` : '');
  return `Repair acceptance contract for plan ${planSlug} (${shown})`;
}

function repairTaskSummary(planSlug: string, heldBars: HeldAcceptanceBar[]): string {
  const lines = heldBars.map((bar) => `- ${bar.barKey} (items ${bar.itemIds.join(', ')}): ${bar.codes.join(', ')}`);
  return [
    `The scheduler is holding plan-bound work in ${planSlug} because these acceptance requirements are not yet gradeable contracts:`,
    ...lines,
    '',
    'Repair each one (accept the draft clause, fill the METHOD, add a runnable check), then close this task.',
    'Closing it releases every held item through its blocks edge; if a contract is still incomplete,',
    'the next claim files a fresh repair task. Read the live state with readAcceptanceBarContractSnapshot',
    `or the plan's BAR readiness before closing.`,
  ].join('\n');
}

/** A postgres.js-shaped tagged-template transaction handle (only the shape this module uses). */
export type RepairTaskTx = <R = unknown[]>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<R>;

/** The repair task the hold files: a plain `task`, deliberately NOT plan-stamped. */
export interface RepairWorkItemInput {
  kind: 'task';
  title: string;
  summary: string;
  harness?: string;
  workspaceId: string;
  createdBy: string;
  admission: 'auto';
  admittedBy: string;
  payload: Record<string, unknown>;
}

/** The I/O {@link findOrFileAcceptanceRepairTask} runs against — PG in production, a fake in tests. */
export interface RepairTaskStore {
  workspaceId: string;
  /** One transaction; the advisory lock taken inside it is held until `fn` settles. */
  begin: <T>(fn: (tx: RepairTaskTx) => Promise<T>) => Promise<T>;
  isTerminal: (status: string) => boolean;
  createWorkItem: (input: RepairWorkItemInput) => Promise<{ id: string }>;
}

/**
 * Find the plan's open acceptance-contract repair task, or file one — exactly once per plan
 * under concurrency (R-16). The transaction advisory lock is taken BEFORE the read, so a
 * second concurrent caller blocks until the first commits and then reads the task it filed
 * (READ COMMITTED). A terminal (closed) repair task is never reused: a contract still
 * incomplete after its repair closed gets a fresh one.
 */
export async function findOrFileAcceptanceRepairTask(
  input: AcceptanceRepairTaskInput,
  store: RepairTaskStore,
): Promise<{ id: string; filed: boolean }> {
  const workspaceId = input.workspaceId ?? store.workspaceId;
  const lockKey = `acceptance-contract-repair:${workspaceId}:${input.planSlug}`;
  return store.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const rows = await tx<Array<{ feature_id: string; status: string | null }>>`
      SELECT feature_id, status
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND payload->>${ACCEPTANCE_REPAIR_PAYLOAD_KEY} = ${input.planSlug}
       ORDER BY feature_id`;
    const open = rows.find((row) => !store.isTerminal(String(row.status ?? '')));
    if (open) return { id: open.feature_id, filed: false };
    // Deliberately NOT stamped with sourcePlanSlug/sourcePlanItemIds: a plan-bound repair
    // task would itself be held behind the contract it exists to repair.
    const created = await store.createWorkItem({
      kind: 'task',
      title: repairTaskTitle(input.planSlug, input.heldBars),
      summary: repairTaskSummary(input.planSlug, input.heldBars),
      harness: input.harness,
      workspaceId,
      createdBy: input.by,
      // Derived from the measured contract gap; delaying its admission would also
      // delay every reviewed item held behind the repair's blocks edge.
      admission: 'auto',
      admittedBy: 'bypass:acceptance-contract-repair',
      payload: {
        [ACCEPTANCE_REPAIR_PAYLOAD_KEY]: input.planSlug,
        heldBars: input.heldBars,
      },
    });
    return { id: created.id, filed: true };
  });
}

async function defaultFindOrFileRepairTask(input: AcceptanceRepairTaskInput): Promise<{ id: string; filed: boolean }> {
  const [{ getOrgPg }, { ALL_TERMINAL_STATUSES }, { createWorkItem }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../work-item-blocking'),
    import('../work-items'),
  ]);
  const workspaceId = input.workspaceId ?? (await import('../workspace-registry')).activeWorkspaceId();
  const { sql } = getOrgPg();
  return findOrFileAcceptanceRepairTask(input, {
    workspaceId,
    begin: <T>(fn: (tx: RepairTaskTx) => Promise<T>) =>
      sql.begin((tx) => fn(tx as unknown as RepairTaskTx)) as Promise<T>,
    isTerminal: (status) => ALL_TERMINAL_STATUSES.has(status),
    createWorkItem: async (wi) => ({ id: (await createWorkItem(wi)).id }),
  });
}

async function defaultLinkHold(input: { repairId: string; heldId: string; harness?: string; by: string }): Promise<string | null> {
  const { linkWorkItemRefDependencies } = await import('../agent-tools/work_items/work-item-ref-blocker-edges');
  const res = await linkWorkItemRefDependencies({
    dependentId: input.heldId,
    harness: input.harness,
    referents: [input.repairId],
    by: input.by,
  });
  return res.ok ? null : res.error;
}

const DEFAULT_DEPS: AcceptanceReadinessHoldDeps = {
  resolveStamp: async (workItem) => (await import('./plan-item-lane-guard')).resolvePlanItemStamp(workItem),
  readSnapshot: async (planSlug, harnessSlug) => {
    const { readAcceptanceBarContractSnapshot } = await import('../acceptance-bar-contract-snapshot');
    return readAcceptanceBarContractSnapshot(planSlug, {}, harnessSlug ? { harnessSlug } : {});
  },
  findOrFileRepairTask: defaultFindOrFileRepairTask,
  linkHold: defaultLinkHold,
};

/** A hold verdict, plus the routing the caller runs once the claim is released. */
export interface AcceptanceReadinessHold extends PlanItemLaneBlock {
  /**
   * Route the held item behind the plan's (found-or-filed) repair task. The caller MUST run
   * this AFTER releasing the claim: the dependency store refuses a new unresolved `blocks`
   * edge behind an ACTIVE dependant (work-item-deps-store ACTIVE_DEPENDANT — `taken_by` set
   * or status wip/in_progress/validating), so linking while the item is still claimed is
   * always refused and the item would re-bounce on every pull. Never throws; returns a
   * one-line routing note for the claim audit. If another puller re-claims the item between
   * the release and the link, its own hold routes it the same way (find-or-file and the edge
   * are both idempotent).
   */
  routeAfterRelease: () => Promise<string>;
}

/**
 * Whether a just-claimed work-item is bound to an incomplete acceptance requirement. On a
 * hold, returns the block for the caller's existing bounce path, with the repair routing
 * deferred to {@link AcceptanceReadinessHold.routeAfterRelease}; otherwise null.
 */
export async function acceptanceReadinessHold(
  workItem: AcceptanceHoldWorkItem,
  ctx: { by: string; workspaceId?: string },
  deps: Partial<AcceptanceReadinessHoldDeps> = {},
): Promise<AcceptanceReadinessHold | null> {
  const d: AcceptanceReadinessHoldDeps = { ...DEFAULT_DEPS, ...deps };
  let stamp: PlanItemStamp | null;
  let heldBars: HeldAcceptanceBar[];
  try {
    stamp = await d.resolveStamp(workItem);
    if (!stamp) return null;
    const snapshot = await d.readSnapshot(stamp.plan_slug, workItem.harness ?? undefined);
    heldBars = incompleteAcceptanceBarsForItems(snapshot, stamp.item_ids);
  } catch {
    // Fail OPEN — an acceptance read hiccup must never wedge the shared claim path.
    return null;
  }
  if (heldBars.length === 0) return null;

  const planSlug = stamp.plan_slug;
  const itemId = heldBars[0]!.itemIds[0]!;
  const detail = heldBars.map((bar) => `${bar.barKey}: ${bar.codes.join('+')}`).join('; ');
  const routeAfterRelease = async (): Promise<string> => {
    try {
      const repair = await d.findOrFileRepairTask({
        planSlug,
        harness: workItem.harness ?? undefined,
        workspaceId: ctx.workspaceId,
        heldBars,
        by: ctx.by,
      });
      const linkError = workItem.id
        ? await d.linkHold({ repairId: repair.id, heldId: workItem.id, harness: workItem.harness ?? undefined, by: ctx.by })
        : 'held work-item has no id';
      return linkError
        ? `repair task ${repair.id}${repair.filed ? ' filed' : ''}, but the blocks edge was not written (${linkError})`
        : `held behind repair task ${repair.id}${repair.filed ? ' (filed now)' : ''}`;
    } catch (error) {
      // The verdict stands even when routing fails: the claim was already released, so a
      // confirmed-incomplete contract is never handed out. The next claim retries routing.
      return `repair routing failed (${error instanceof Error ? error.message : String(error)})`;
    }
  };
  return {
    reason: `plan-item ${planSlug}#${itemId} is bound to an incomplete acceptance requirement (${detail})`,
    planSlug,
    itemId,
    effectiveStatus: 'acceptance-incomplete',
    staleBlockedHint: null,
    routeAfterRelease,
  };
}
