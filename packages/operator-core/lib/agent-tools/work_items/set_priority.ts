/**
 * work_items:set_priority — the Queen's steer-don't-dispatch lever for the SHARED backlog
 * (autoloop-pot-operator-rebuild B7 / decentralized-dispatch-scaling D-003/D-004, P-009/P-010).
 *
 * Set a feature-family work-item's BACKLOG PRIORITY — `feature_order`, the column the
 * decentralized claim path (`claimNextWorkItem`) orders by (ASC NULLS LAST, so LOWER =
 * claimed sooner). This is how the Queen "sets priorities" reading the rolled-up change
 * feed (`curation:change-feed`): she reorders the backlog the fleet claims against, never
 * assigning work item-by-item. Three shapes:
 *   - explicit  { workItem, priority }              — set an exact order (or `priority: null` to clear).
 *   - bump      { workItem, position: 'top'|'bottom' } — move to head (most urgent) / tail of the backlog.
 *   - read      { workItem }                          — report the current backlog priority, no write.
 *
 * ⚠ EI-6835 GOTCHA — `NULLS LAST` means ANY explicit `feature_order` (however large)
 * sorts BEFORE every unprioritized (`feature_order IS NULL`) item, no exceptions. So
 * setting a "large" priority number to try to DEPRIORITIZE an item you can't make
 * progress on right now (e.g. before releasing it) does the OPPOSITE: it PROMOTES the
 * item ahead of the entire unprioritized pool (typically the vast majority of the
 * backlog) — guaranteeing claim_next hands it right back out, worse than before.
 * `position: 'bottom'` has the SAME gotcha: it computes MAX(existing explicit
 * feature_order)+1, i.e. "last among the currently-EXPLICITLY-prioritized items," NOT
 * "last in the whole backlog" — it still lands well ahead of every unprioritized item.
 * There is currently NO way to place an item behind the unprioritized pool (NULLS LAST
 * is structurally the lowest position; no finite number can rank below it). If an item
 * is genuinely unresolvable right now, do NOT try to "deprioritize" it via this tool —
 * for a feature-family item, flip its state to `blocked` (excluded from claim_next's
 * readiness floor) instead; issue-family items (bug/change/task) have no such
 * transient-hold state today (see WI-2797 — the sibling follow-up filed for this gap;
 * a prior comment here pointed at WI-1671, which is unrelated — that was a stale ref).
 *
 * DISTINCT from `work_items:reorder`, which ranks ONE bee's already-CLAIMED work-list
 * (a per-assignee queue, post-claim). This sets the GLOBAL backlog order (pre-claim).
 *
 * ⚠ STALE-CLAIM CORRECTION (found live, 2026-07-04): this used to say "feature-family
 * only — a set on an issue-family item is a no-op returning applicable:false." That is
 * OUT OF DATE. Since SCHEDULER_ISSUES_CLAIMABLE (P-007, work-item-deps-and-readiness-
 * 2026-06-22) joined issue-family (bug/change/task) items into the SAME dispatched
 * backlog, `setWorkItemPriority` writes `feature_order` on the `harness_shared.work_items`
 * BASE row for them too (see work-items.ts ~L2164-2182) — confirmed empirically: calling
 * this on an issue-family item now returns `applicable:true, written:true`, NOT a no-op.
 * The EI-6835 promotion gotcha above therefore applies to issue-family items EXACTLY the
 * same way (verified against 3 live issue-family items this session — a "sink to
 * priority:5" attempt promoted them ahead of the unprioritized pool, then reverted to
 * null). `schedulerIssuesClaimableEnabled()` gates this — check that flag if this ever
 * reads as a no-op again; do not assume "issue-family = no-op" from memory.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): steer ONE item inline
 * ({ workItem, priority?|position? }) or MANY (items:[{ workItem, priority?, position?,
 * harness?, decision? }]) → { ok, results:[{ ok, workItem, mode, … | error }], counts }.
 * Each item independently picks read/set/bump and arms its own auto-revert tripwire;
 * one not-found item never fails the rest. Results self-describe by `workItem`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { setWorkItemPriority, getWorkItemPriority, bumpWorkItemPriority, explainIssueClaimFloors } from '../../work-items';
import { isStructurallyUnclaimable } from '../../claim-floor-classification';
import { planWorkItemArm, commitWorkItemArm } from './arm-reversible-work-item';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';

const decisionSpec = z
  .object({
    riskTier: z.enum(['trivial', 'low', 'moderate', 'high', 'critical']).optional(),
    authority: z.enum(['system', 'owner']).optional(),
  })
  .optional();

const itemSpec = z.object({
  workItem: z.string().min(1).max(120).describe('The work-item id to (re)prioritize (F-/WI-/EI-).'),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  priority: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe('Explicit backlog order (feature_order) — LOWER = claimed sooner; null clears. Overrides position. EI-6835: any explicit value (even a huge one) sorts BEFORE the unprioritized pool — this can only PROMOTE, never deprioritize below unset items.'),
  position: z.enum(['top', 'bottom']).optional().describe("Bump to head ('top') / tail ('bottom') of the backlog."),
  // P-114: an AUTONOMOUS agent declares the action's risk/authority so the auto-revert
  // tripwire arms faithfully. Absent ⇒ fail-safe `critical`. Ignored for human callers.
  decision: decisionSpec,
});

type Spec = z.infer<typeof itemSpec>;

/**
 * EI-19919820196426791 / EI-19932455002723461: an explicit priority write is a silent no-op
 * on claimability when the item sits behind ANY of the claim path's structural floors, not
 * just the original two surfaced classes (payload.lane='observation' /
 * payload.needsOwnerAction=true) — the write
 * reports ok:true/written:true exactly like a real steer, with nothing flagging the conflict.
 *
 * EI-19932455002723461 (MEASURED 2026-08-09): the original two-floor check missed the far
 * more common structural exclusions on this harness — `claim-hold` (61 open items),
 * `federation-detector` (98), `cross-machine-rig` (6) — so a priority set on any of THOSE
 * items reported success with zero warning, reproducing the exact "silently ineffective
 * steering lever" symptom the reporter measured. `explainIssueClaimFloors` already reports
 * ALL of these (plus `plan-lane-reserved` / `loop-noise` / `already-completed` /
 * `external-blocker` / `not-claimable-status`) via the SAME floor oracle the real claim path
 * reads — this just stops discarding everything but two of its verdicts.
 *
 * `already-taken` and `not-found` are deliberately EXCLUDED from the warning: a currently-held
 * item is a TRANSIENT state (priority steering IS effective the moment it's released — this is
 * not the "structurally invisible regardless of reordering" failure this warns about), and
 * `not-found`/`null` can't reach here (the caller already returned/skipped on those).
 *
 * Best-effort only: uses the SAME floor oracle the real claim path reads (so it can't drift),
 * and a lookup failure (or a feature-family id, which the oracle doesn't cover) silently
 * yields no warning rather than failing the priority write itself.
 */
// WI-2141964: the floor list that used to sit here is now the shared
// `STRUCTURAL_CLAIM_FLOORS` (claim-floor-classification.ts). It was one of THREE
// hand-rolled copies of one rule that had already diverged, and this copy classified
// NOTHING for 6 of the oracle's floors — so a steer on a row refused by any of those
// returned no warning at all, which is the "silently ineffective steering lever" symptom
// EI-19932455002723461 was filed for, still live for those 6. The shared set also adds
// `origin` (a true-peer federated row is never self-selectable from this node). A totality
// guard now fails when a floor is added to the claim path and left unclassified.

async function structuralClaimabilityWarning(harness: string | null, id: string): Promise<string | undefined> {
  if (!harness) return undefined;
  try {
    const [floor] = await explainIssueClaimFloors(harness, [id]);
    if (!floor || !isStructurallyUnclaimable(floor.refusedBy)) return undefined;
    const remediation =
      floor.refusedBy === 'needs-owner-action'
        ? ' Clear it with work_items:update { id, needsHuman:false } if it should actually be worked.'
        : floor.refusedBy === 'observation-lane'
          ? ' It was captured via improvements:capture { lane:\'observation\' }, which by design never enters the work queue — re-file/relocate it out of that lane if it should actually be worked.'
          : '';
    return (
      `⚠ backlog priority was set, but this item is structurally UNCLAIMABLE and will stay ` +
      `invisible to scheduler:get_next / claim_next regardless: ${floor.detail}. Reordering the ` +
      `backlog does not change this.${remediation}`
    );
  } catch {
    // best-effort signal only
  }
  return undefined;
}

export default defineTool({
  name: 'work_items:set_priority',
  profile: 'engineer',
  description:
    "The steer-don't-dispatch lever: set one or many work-items' BACKLOG priority — the order the decentralized claim layer pulls against (lower = claimed sooner). Single: { workItem, priority?|position? }; many via items:[…] (each: explicit priority, position:'top'|'bottom', or priority:null to clear). Returns { ok, results:[…], counts:{ ok, failed, written, proposed } }. Gate on `written` (or counts.written/proposed), NOT `ok`: a non-lease-holder proposal returns ok:true but writes nothing (issue-family items too). ⚠ EI-6835: `priority`/`position:'bottom'` set an EXPLICIT value, which under NULLS LAST ALWAYS sorts BEFORE the (usually much larger) unprioritized pool — do NOT use a 'large number' or 'bottom' to try to DEPRIORITIZE an item; that PROMOTES it instead. To deprioritize, clear it (`priority: null`) or (feature-family) flip it to `blocked`.",
  guidance: {
    when: "You are steering the SHARED backlog: promote/demote what the fleet claims next via position:'top'/'bottom' or an explicit integer; reprioritize several via items:[…]. Multi-Swarm: only the steering-lease holder commits (others get proposed:true).",
    notWhen:
      "Ranking a single bee's already-claimed work-list (work_items:reorder), pinning to a Swarm (work_items:co_locate), or changing lifecycle state (work_items:set_state). GLOBAL backlog order (incl. issue-family). To DEPRIORITIZE, don't use this — see the EI-6835 warning above.",
    chaining:
      "work_items:list (the backlog) → set_priority { workItem, position:'top' } → the next claim_next pulls it first.",
    seeAlso: [
      'work_items:reorder (a single bee\'s already-claimed work-list order, post-claim)',
      'work_items:co_locate (pin work to a Swarm)',
      'work_items:set_state (change lifecycle state, not backlog order)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      workItem: z.string().min(1).max(120).optional().describe('single shorthand: the work-item id to (re)prioritize (F-/WI-/EI-).'),
      harness: z.string().max(80).optional().describe('default harness for the inline workItem / items that omit one.'),
      priority: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe('single shorthand: explicit backlog order (feature_order) — LOWER = claimed sooner; null clears. Overrides position. EI-6835: any explicit value sorts BEFORE the unprioritized pool — cannot be used to deprioritize below unset items.'),
      position: z
        .enum(['top', 'bottom'])
        .optional()
        .describe("single shorthand: bump to head ('top', most urgent) or tail ('bottom') of this harness's backlog."),
      // P-114: an AUTONOMOUS agent declares the action's risk/authority so the
      // auto-revert tripwire arms faithfully (the verb has no inherent item risk).
      // Absent ⇒ fail-safe `critical`. Ignored for human callers.
      decision: decisionSpec,
      items: z
        .array(itemSpec)
        .min(1)
        .max(100)
        .optional()
        .describe('reprioritize many work-items at once — each { workItem, priority?, position?, harness?, decision? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || Boolean(a.workItem), {
      message: 'pass { workItem, priority?|position? } for one, or items:[{ workItem, … }] for many',
    }),
  async handler(args, ctx) {
    const items: Spec[] = args.items?.length
      ? args.items
      : [{ workItem: args.workItem as string, harness: args.harness, priority: args.priority, position: args.position, decision: args.decision }];

    const env = await runBulk(
      items,
      async (it): Promise<BulkItemResult & { workItem: string }> => {
        const harness = it.harness ?? args.harness;
        const opt = { harness };
        const decision = it.decision ?? args.decision;

        // Read mode — no directive → report the current backlog priority. No write, no arming.
        if (it.priority === undefined && !it.position) {
          const cur = await getWorkItemPriority(it.workItem, opt);
          if (!cur) return { ok: false, workItem: it.workItem, error: `work-item ${it.workItem} not found` };
          return { ok: true, workItem: cur.id, mode: 'read', priority: cur.priority, applicable: cur.applicable };
        }

        // P-114 arm-call-site: gate-FIRST (before the write) so the captured prior-priority
        // handle is faithful. `null` on the common path (human caller / disarmed / never-auto
        // = today's whole population, D-007); committed only when the write actually LANDS —
        // a non-lease-holder proposal (set.proposed) changed nothing, so it is never armed.
        const armPlan = await planWorkItemArm(
          ctx,
          'work_items:set_priority',
          'priority',
          it.workItem,
          harness,
          decision,
        ).catch(() => null);

        // WI-1376: the TRUTHFUL "did feature_order actually persist?" signal. `ok:true` only
        // means the request was processed without error — a steering-lease PROPOSAL (proposed:
        // this Swarm isn't the lease holder) and an inapplicable issue-family item (applicable:
        // false, scheduler-issues-claimable OFF) BOTH return ok:true yet write NOTHING. Callers
        // / bulk re-prioritizers must gate on `written`, not `ok`, or they silently miss the
        // no-op (the exact failure the report hit). `written` also gates the auto-revert arm —
        // never arm a revert for a write that never landed.
        const wroteResult = (r: { applicable: boolean; proposed?: boolean }) => r.applicable === true && !r.proposed;

        // Explicit mode — caller named the order (or null to clear); overrides position.
        if (it.priority !== undefined) {
          const set = await setWorkItemPriority(it.workItem, it.priority, opt);
          if (!set) return { ok: false, workItem: it.workItem, error: `work-item ${it.workItem} not found` };
          const written = wroteResult(set);
          if (armPlan && written) await commitWorkItemArm(armPlan).catch(() => {});
          const claimabilityWarning =
            written && it.priority !== null ? await structuralClaimabilityWarning(set.harness, set.id) : undefined;
          return {
            ok: true,
            workItem: set.id,
            mode: 'set',
            priority: set.priority,
            applicable: set.applicable,
            written,
            action: it.priority === null ? 'clear' : 'set',
            // P-011 steering lease (D-004): proposed=true ⇒ this Swarm is not the
            // lease holder — the write was NOT committed; a proposal was recorded
            // for the holding Queen (steeringHolder) to dispose.
            ...(set.proposed ? { proposed: true, steeringHolder: set.steeringHolder } : {}),
            ...(claimabilityWarning ? { claimabilityWarning } : {}),
          };
        }

        // Bump mode — move to the head/tail of the backlog relative to the current extreme.
        const set = await bumpWorkItemPriority(it.workItem, it.position!, opt);
        if (!set) return { ok: false, workItem: it.workItem, error: `work-item ${it.workItem} not found` };
        const written = wroteResult(set);
        if (armPlan && written) await commitWorkItemArm(armPlan).catch(() => {});
        const claimabilityWarning = written ? await structuralClaimabilityWarning(set.harness, set.id) : undefined;
        return {
          ok: true,
          workItem: set.id,
          mode: 'bump',
          priority: set.priority,
          applicable: set.applicable,
          written,
          action: it.position,
          ...(set.proposed ? { proposed: true, steeringHolder: set.steeringHolder } : {}),
          ...(claimabilityWarning ? { claimabilityWarning } : {}),
        };
      },
      { keyOf: (it) => ({ workItem: it.workItem }) },
    );
    // WI-1376 bulk-level truth. A steering-lease PROPOSAL (this Swarm isn't the
    // holder) and an inapplicable issue-family set BOTH return ok:true yet write
    // NOTHING, so a caller gating on `counts.ok` over a large bulk run (the exact
    // failure the report hit: a 648-item re-prioritization where 84 feature-family
    // items silently no-op'd) is fooled — the per-item `written:false` is easy to
    // miss across hundreds of rows. Roll `written` (feature_order actually persisted)
    // and `proposed` (recorded for the lease-holding Queen, NOT committed) up onto
    // `counts` so a bulk re-prioritizer sees the miss at a glance.
    const written = env.results.filter((r) => (r as { written?: boolean }).written === true).length;
    const proposed = env.results.filter((r) => (r as { proposed?: boolean }).proposed === true).length;
    return bulkContent({ ...env, counts: { ...env.counts, written, proposed } });
  },
});
