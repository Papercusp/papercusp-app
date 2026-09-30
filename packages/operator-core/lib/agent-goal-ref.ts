/**
 * agent-goal-ref.ts — P-016's GOAL-REF RESOLVER: what an agent is currently
 * working toward, expressed as a REF into records that already exist.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-016. Rulings: D-011 (goal is the
 * third declaration scope and is a POINTER, not prose), D-051 (this is the
 * CURRENT-state surface; the tool-call stamp is the retrospective one), D-046 (a
 * ref must resolve — never a bare bigint), D-056 (the goal is a CELL; the
 * assumptions are FACTS, and they do not share an audience check).
 *
 * NO NEW STORAGE. Every leg below reads a record the fleet already writes: a
 * work-item claim (`work_items.taken_by`), a plan-item claim
 * (`plan_item_claims`), a fleet membership. That is the whole point of D-011's
 * "`why` is a pointer" framing — a goal expressed as prose is a stale snapshot at
 * send time, while a goal expressed as a ref stays LIVE: the receiver can ask
 * whether it is still open before acting on it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ WHAT THE MEASUREMENT CHANGED — READ THIS BEFORE EDITING THE PRECEDENCE
 *
 * The item states the rule as a flat precedence: "claimed work-item > plan item >
 * fleet mission". Measured against the live fleet on 2026-07-27 BEFORE building
 * (the D-091 discipline — measure the trigger before you build it), that rule is
 * UNDER-DETERMINED, in a way the sentence cannot show:
 *
 *   · 19 owners hold a work-item; 4 also hold a plan-item claim; **0 hold a
 *     plan-item claim alone**. So the plan-item leg never fires as a FALLBACK in
 *     the live population — it only ever appears ALONGSIDE a work-item.
 *   · **3 of 19 owners hold TWO work-items at once.** A flat "prefer the
 *     work-item" cannot say WHICH, and picking arbitrarily is precisely the
 *     confident-wrong-answer failure this plan keeps catching.
 *   · `work_items.source_plan_slug` is NULL on every co-held row, so the row
 *     itself cannot prove which claim is which goal.
 *
 * The disambiguator is REAL and already populated: a `coord_links` edge
 * (`rel='implements'`, `dst_kind='plan_item'`) joins a work-item to the plan item
 * it serves. Verified live: `WI-6407 implements unified-agent-state-plane-2026-07-27#P-016`
 * and `WI-6390 implements learning-tab-surface-public-release-2026-07-27#P-007`,
 * both held by the owner who also claims that exact plan item.
 *
 * So the two "competing" legs are USUALLY THE SAME GOAL DECLARED TWICE, and the
 * edge proves it. That turns precedence from an arbiter that DISCARDS a leg into
 * a rule that CORROBORATES one — and gives the multi-work-item case a principled
 * tiebreak instead of a coin flip.
 *
 * ⚠ AND WHEN THE LEGS GENUINELY DISAGREE, THE LOSER IS DISCLOSED, NEVER DROPPED
 * ({@link ResolvedGoal.competing}). A resolver that silently discards a claim the
 * agent actually holds manufactures a confident wrong answer — the reader is told
 * "this is their goal" when the agent is demonstrably holding something else too.
 * `agreement` hoists that at the RESULT level so a caller who never reads
 * `competing` still cannot miss it (D-039 hoisting, applied one layer down).
 *
 * ⚠ PURE AND TOTAL. No I/O, no throw, no clock. Every consumer is on a hot path
 * (a claim, a lock acquire, a presence read) and P-026 rule (f) makes it a
 * requirement rather than a courtesy: an enrichment must never be able to fail
 * the operation it decorates. The PG reads live in `agent-goal-sources.ts`.
 */

import { z } from 'zod';

/**
 * The registry id of the cell this resolver backs (`AGENT_GOAL_CELL.cell`).
 *
 * ⚠ IT LIVES HERE, NOT IN `cell-registrations.ts`, SO THERE IS ONE SPELLING.
 * Every holder surface gates its goal read on `getCell(AGENT_GOAL_CELL_ID,
 * reader)`, and a gate keyed on a hand-typed `'agent.goal'` that drifts from the
 * registration does not throw — `getCell` simply returns `undefined` and the
 * surface silently discloses NOTHING, forever, while every test that stubs the
 * registry still passes. Declaring it in the module the registration imports
 * makes that drift impossible.
 */
export const AGENT_GOAL_CELL_ID = 'agent.goal';

/** WHICH record produced the ref, in precedence order. */
export type GoalSource =
  /** The agent said its true purpose differs from its claimed lane (D-011). */
  | 'author-override'
  /** A held work-item claim — the strongest auto-derived signal. */
  | 'work-item'
  /** A held plan-item claim. */
  | 'plan-item'
  /** Fleet membership — the weakest, and a MISSION rather than a task. */
  | 'fleet-mission';

/**
 * D-038 axis 1 for this cell, hoisted to the result. Do the INDEPENDENT legs
 * agree about what this agent is doing?
 *
 * ⚠ `divergent` IS NOT AN ERROR. It is the honest reading of an agent holding two
 * unrelated things, and for an `author-override` it is the EXPECTED value — an
 * override exists precisely because true purpose differs from the claimed lane,
 * which is "the high-signal case" D-011 names.
 */
export type GoalAgreement =
  /** Exactly one leg produced a candidate — there is nothing to disagree with. */
  | 'sole'
  /** Two legs, joined by an `implements` edge: ONE goal, declared twice. */
  | 'corroborated'
  /** Two or more legs with no edge joining them. See `competing`. */
  | 'divergent';

/** A work-item this owner currently holds. `id` is already a resolvable ref. */
export interface HeldWorkItem {
  /** `work_items.feature_id` — e.g. `WI-6407`, `EI-18810823481386446`. */
  id: string;
  /** `taken_at` — when this claim, and so this goal, was declared. */
  takenAt?: string | null;
}

/** A plan-item claim this owner currently holds. */
export interface HeldPlanItem {
  planSlug: string;
  /** e.g. `P-016`. */
  itemId: string;
  /** `acquired_ts`. */
  acquiredTs?: string | null;
  /**
   * Whether the claim's TTL lease is still in the future.
   *
   * ⚠ `undefined` MEANS NOT MEASURED, AND THAT IS A THIRD STATE, NOT A `false`.
   * The peer lens filters to live claims in SQL, so every row it produces is valid
   * by construction and carries no flag; only the self lens, which deliberately
   * reads lapsed rows, measures it. Collapsing absent into `false` would mark every
   * peer goal cold — the precise inversion of the honesty this field exists for.
   */
  leaseValid?: boolean;
}

/** The fleet this owner belongs to. A mission, not a task — hence last. */
export interface HeldFleet {
  slug: string;
  joinedAt?: string | null;
}

/**
 * D-011's explicit author-override path: "an agent authors one only when its true
 * purpose differs from its claimed lane, which is precisely the high-signal case."
 */
export interface GoalOverride {
  /** Must still be a REF (D-046) — an override is not a licence to write prose. */
  ref: string;
  declaredAt?: string | null;
}

/**
 * One `coord_links` edge: the work-item IMPLEMENTS the plan item. This is the
 * corroboration signal the module note above measured, and the ONLY thing that
 * can prove two claims name one goal.
 */
export interface GoalLink {
  /** `coord_links.src_ref` — the work-item id. */
  workItemId: string;
  /** `coord_links.dst_ref` — already in `<planSlug>#<itemId>` form. */
  planItemRef: string;
}

/** Everything the resolver may consider. Every field optional: a leg with no data
 *  contributes nothing rather than an approximation. */
export interface GoalCandidates {
  override?: GoalOverride | null;
  workItems?: readonly HeldWorkItem[];
  planItems?: readonly HeldPlanItem[];
  fleet?: HeldFleet | null;
  links?: readonly GoalLink[];
}

/** The resolved goal. `null` from {@link resolveAgentGoal} means the agent holds
 *  nothing — an honest "no goal", never a fabricated one. */
export interface ResolvedGoal {
  /** The headline. Always a resolvable ref (D-046). */
  ref: string;
  source: GoalSource;
  /** When the underlying claim was taken. The input `stale` is derived from
   *  (P-026 rule e) — computed by the consumer, not here, because this is
   *  clock-free by construction. */
  declaredAt: string | null;
  /** A SECOND ref naming the SAME goal, proven by an `implements` edge. */
  corroboratedBy: string | null;
  /** Refs this agent also holds that `ref` does NOT subsume. Disclosed, never
   *  dropped — see the module note. Sorted, so the value is stable. */
  competing: string[];
  /** Axis 1, hoisted. */
  agreement: GoalAgreement;
  /**
   * The plan-item claim this answer names has LAPSED its TTL lease — the goal is
   * still yours, but the lease is cold and must be re-taken before you edit.
   *
   * ONE RULE: true when the answer names a plan-item claim (as `ref`, or as the
   * `corroboratedBy` edge) whose `leaseValid` is explicitly `false`. False when the
   * answer names no plan-item claim at all, and false when the lease was never
   * measured — see {@link HeldPlanItem.leaseValid} for why absent ≠ cold.
   *
   * ⚠ THIS FIELD IS WHY DROPPING THE EXPIRY FILTER IS SAFE. The self lens reads
   * lapsed claims so an agent stops losing its own goal after 20 minutes
   * (`plan_item_claims.ttl_sec` default 1200); without a way to SAY the lease is
   * cold, that fix would trade a silent disappearance for a silent overstatement —
   * a lapsed claim rendered as an exclusive hold. The original expiry filter's
   * stated reason ("a stale value reads as current") is honoured by disclosing the
   * staleness, not by deleting the row.
   *
   * Clock-free like the rest of this module: the boolean is an INPUT, measured by
   * the SQL that read the row, never derived from a clock here.
   */
  leaseCold: boolean;
}

/**
 * A bigint id masquerading as a ref — rejected by D-046: a reader handed `184073`
 * can do nothing with it, whereas `WI-6407` resolves.
 *
 * ⚠ THE CANONICAL HOME OF THIS GUARD IS HERE. `coord/holder-context.ts`
 * re-exports it rather than keeping its own copy: two implementations of "is this
 * a usable goal ref" is exactly the second derivation D-038 axis 5 forbids, and
 * the ref rule belongs with the module that MINTS refs.
 */
const BARE_BIGINT = /^\d+$/;

/**
 * Guard a goal ref. Returns null for a blank or bigint-shaped id rather than
 * passing it through: the ref is the field a reader is meant to ACT on, so an
 * unusable one must read as absent, not as present-and-broken.
 */
export function asGoalRef(itemId: string | null | undefined): string | null {
  const s = (itemId ?? '').trim();
  if (!s || BARE_BIGINT.test(s)) return null;
  return s;
}

/**
 * The wire validator for an explicitly declared goal ref.
 *
 * Keep this beside {@link asGoalRef}: the same guard defines whether a ref is
 * usable on both the derived goal cell and the declaration tools. A declared
 * ref may be a generated goal slug, a WI-/EI- work-item ref, or another
 * resolvable pointer. Blank values and bare numeric ids are not actionable.
 *
 * This is intentionally a `z.preprocess` over a plain string schema rather
 * than a transform/refine. Tool argument schemas are converted to JSON Schema
 * at registration time; the preprocess keeps the published wire shape a
 * string while still applying the canonical runtime guard and whitespace
 * normalization.
 */
export const goalRefSchema = z.preprocess(
  (value) => (typeof value === 'string' ? (asGoalRef(value) ?? '') : value),
  z.string().min(1, 'goal ref required'),
);

/**
 * The plan-item ref form — `<planSlug>#<itemId>`.
 *
 * ⚠ THIS MUST MATCH `coord_links.dst_ref` BYTE-FOR-BYTE, because that is what
 * makes the corroboration join possible at all. It is not a display choice.
 */
export function planItemRef(planSlug: string, itemId: string): string | null {
  const slug = (planSlug ?? '').trim();
  const item = (itemId ?? '').trim();
  if (!slug || !item) return null;
  return `${slug}#${item}`;
}

/**
 * The plan-DECISION ref form — `<planSlug>#D-NNN`.
 *
 * WHY this exists rather than calling `planItemRef` with a `D-NNN`: the two
 * share a shape but not an identity. `planItemRef` is pinned byte-for-byte to
 * `coord_links.dst_ref` for the corroboration join (see its note above), so a
 * future change made to satisfy that join must NOT silently move decision refs
 * with it. Same convention, separate namespace, separate reason to change.
 *
 * WHY a qualified form is the default a caller should cite: `D-NNN` is
 * allocated per-plan, so the number alone is not a reference at all. Measured
 * 2026-09-05 on harness `papercusp`: 9,088 decisions across 927 plans collapse
 * onto just 298 distinct numbers — `D-001` is defined by 904 different plans,
 * `D-002` by 792, `D-003` by 705. A bare `D-001` in a carry-note or a code
 * comment therefore names ~904 candidate rulings, and the reader has no way to
 * tell which. Handing the caller the qualified ref is what stops the bare form
 * being copied onward; see `plans:add-decision`.
 */
export function planDecisionRef(planSlug: string, decisionId: string): string | null {
  const slug = (planSlug ?? '').trim();
  const decision = (decisionId ?? '').trim();
  if (!slug || !decision) return null;
  return `${slug}#${decision}`;
}

/** The fleet-mission ref form. Namespaced so a reader can tell a MISSION from a
 *  task at a glance — the two warrant very different responses. */
export function fleetMissionRef(fleetSlug: string): string | null {
  const slug = (fleetSlug ?? '').trim();
  return slug ? `fleet:${slug}` : null;
}

/** Newest-first, with a deterministic id tiebreak so an undated or tied pair
 *  never resolves differently between two callers reading the same state. */
function byRecency<T>(rows: readonly T[], ts: (r: T) => string | null | undefined, key: (r: T) => string): T[] {
  return [...rows].sort((a, b) => {
    const ta = Date.parse(ts(a) ?? '');
    const tb = Date.parse(ts(b) ?? '');
    const va = Number.isNaN(ta) ? -Infinity : ta;
    const vb = Number.isNaN(tb) ? -Infinity : tb;
    if (va !== vb) return vb - va;
    return key(a).localeCompare(key(b));
  });
}

/**
 * THE AUTO-DERIVATION RULE. Precedence: author override > work-item > plan-item >
 * fleet mission — refined by the corroboration step the module note measured.
 *
 * Returns null when the agent holds nothing at all. That is an HONEST unknown and
 * the consumer must render it as absent; it must never be padded into a
 * placeholder goal, and (D-056) it is deliberately the same answer a reader gets
 * for a holder whose goal it may not read.
 */
export function resolveAgentGoal(candidates: GoalCandidates): ResolvedGoal | null {
  const workItems = (candidates.workItems ?? []).filter((w) => asGoalRef(w.id));
  const planItems = (candidates.planItems ?? []).filter((p) => planItemRef(p.planSlug, p.itemId));
  const fleetRef = candidates.fleet ? fleetMissionRef(candidates.fleet.slug) : null;

  // Every ref the agent holds, so a losing leg can be DISCLOSED rather than dropped.
  const allRefs = new Set<string>();
  for (const w of workItems) allRefs.add(asGoalRef(w.id)!);
  for (const p of planItems) allRefs.add(planItemRef(p.planSlug, p.itemId)!);
  if (fleetRef) allRefs.add(fleetRef);

  // Lease state, keyed by the ref form the answer actually names. Only rows the
  // caller MEASURED land here (`leaseValid === false`), so an unmeasured peer read
  // can never colour an answer cold — see `HeldPlanItem.leaseValid`.
  const coldPlanRefs = new Set(
    planItems
      .filter((p) => p.leaseValid === false)
      .map((p) => planItemRef(p.planSlug, p.itemId)!),
  );

  const finish = (
    ref: string,
    source: GoalSource,
    declaredAt: string | null,
    corroboratedBy: string | null,
  ): ResolvedGoal => {
    const competing = [...allRefs]
      .filter((r) => r !== ref && r !== corroboratedBy)
      // ⚠ A FLEET MISSION IS A CONTAINER, NOT A COMPETITOR — measured, not assumed.
      // Running the resolver over the live fleet, 12 of 16 owners came back
      // `divergent`, but NINE of those were nothing more than "holds a work-item
      // AND belongs to a fleet". That is the normal state of every fleet member,
      // so counting it as divergence makes the signal fire constantly and mean
      // nothing — the same cry-wolf failure D-091 caught in P-010's trigger.
      // A mission is the context the work happens IN; only same-granularity
      // ITEM claims can genuinely be the goal instead of one another. The fleet
      // is one `fleet:status` call away and is not lost by omitting it here.
      .filter((r) => r !== fleetRef)
      .sort();
    return {
      ref,
      source,
      declaredAt: declaredAt ?? null,
      corroboratedBy,
      competing,
      agreement: corroboratedBy ? 'corroborated' : competing.length > 0 ? 'divergent' : 'sole',
      // The answer's OWN claim, whether it arrived as the headline or as the
      // corroborating edge — in both readings the named plan-item claim is the one
      // the reader would act on, so both must be able to say "re-claim first".
      leaseCold: coldPlanRefs.has(ref) || (corroboratedBy != null && coldPlanRefs.has(corroboratedBy)),
    };
  };

  // ── 1. AUTHOR OVERRIDE. Wins unconditionally (D-011). It is authored ONLY when
  // true purpose differs from the claimed lane, so `divergent` here is the
  // expected, informative reading rather than a defect.
  const overrideRef = asGoalRef(candidates.override?.ref);
  if (overrideRef) {
    allRefs.add(overrideRef);
    return finish(overrideRef, 'author-override', candidates.override?.declaredAt ?? null, null);
  }

  // ── 2. WORK-ITEM, with the corroboration tiebreak.
  if (workItems.length > 0) {
    const heldPlanRefs = new Set(planItems.map((p) => planItemRef(p.planSlug, p.itemId)!));
    // An edge only corroborates when its plan item is one this agent ACTUALLY
    // CLAIMS. A work-item implementing some other plan item says nothing about
    // which of two claims is this agent's current goal.
    const corroborating = (candidates.links ?? []).filter((l) => heldPlanRefs.has((l.planItemRef ?? '').trim()));

    for (const w of byRecency(workItems, (r) => r.takenAt, (r) => r.id)) {
      const ref = asGoalRef(w.id)!;
      const edge = corroborating.find((l) => (l.workItemId ?? '').trim() === ref);
      if (edge) return finish(ref, 'work-item', w.takenAt ?? null, edge.planItemRef.trim());
    }

    // No edge: precedence picks the most recent claim, and every other ref the
    // agent holds — including the plan-item claim this just outranked — lands in
    // `competing` with `agreement:'divergent'`.
    const newest = byRecency(workItems, (r) => r.takenAt, (r) => r.id)[0]!;
    return finish(asGoalRef(newest.id)!, 'work-item', newest.takenAt ?? null, null);
  }

  // ── 3. PLAN ITEM. Measured to have ZERO live traffic as a standalone leg
  // (0 of 19 owners), so it is a real fallback rather than a hot path — but it
  // is the leg a plan-only agent depends on entirely, so it is not optional.
  if (planItems.length > 0) {
    // A LIVE lease outranks a cold one before recency is consulted. Both are the
    // agent's own work, but only one is still fenced against a peer taking it, so
    // answering with the cold claim when a live one exists would name the weaker
    // hold. Recency alone cannot express this: `ttl_sec` is per-claim, so a claim
    // acquired LATER can expire EARLIER. Held here rather than left to the caller's
    // ORDER BY, so the rule survives a caller that reads the rows in any order.
    const ranked = byRecency(planItems, (r) => r.acquiredTs, (r) => `${r.planSlug}#${r.itemId}`);
    const newest = ranked.find((p) => p.leaseValid !== false) ?? ranked[0]!;
    return finish(
      planItemRef(newest.planSlug, newest.itemId)!,
      'plan-item',
      newest.acquiredTs ?? null,
      null,
    );
  }

  // ── 4. FLEET MISSION. A mission, not a task: it says what the agent was sent to
  // do, not what it is doing. Weakest on purpose.
  if (fleetRef) return finish(fleetRef, 'fleet-mission', candidates.fleet?.joinedAt ?? null, null);

  return null;
}
