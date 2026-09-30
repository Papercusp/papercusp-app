/**
 * holder-context-sources.ts — the PRODUCTION reads behind P-026's `HolderContext`
 * projection (plan `unified-agent-state-plane-2026-07-27`, ruling **D-083**).
 *
 * WHY A SEPARATE MODULE. `coord/holder-context.ts` is pure: a goal record + keys
 * in, one projection out, no PG. That is what makes it unit-testable without a
 * database and what keeps rule (f)'s totality structural. This file is the only
 * part that touches a store, and it is INJECTED as `HolderContextSources` rather
 * than imported by the derivation — the same split as
 * coupling-derivation/coupling-sources (P-013) and coupled-topics/-sources (P-023).
 *
 * ⚠ BOTH LEGS WERE VERIFIED AGAINST THE PRODUCER BEFORE THIS WAS BUILT (D-083 §2,
 * measured live 2026-07-27), because on this plan the obvious field has been the
 * wrong one three times running:
 *   · `plan_item_claims.intent` — **7 of 7** live claims carry a non-blank intent;
 *   · `agent_facts` scope='owner' — **234 live rows across 225 distinct owners**.
 *
 * ⚠⚠ THE NEAR-MISS THAT SHAPES THE ASSUMPTIONS QUERY. `agent_facts.kind` has a
 * CHECK constraint admitting `'assumption'`, so `WHERE kind = 'assumption'` is the
 * reading the schema invites — and it is WRONG. `kind` is populated on **13 of
 * 2,076 rows**. That query typechecks, passes every hand-built fixture, and
 * derives essentially NOTHING in production. Assumptions are therefore the
 * holder's live owner-scoped facts BY KEY, never filtered by `kind`. This is the
 * same class as D-082 (`claimedItems` holding the wrong id space) and the
 * `currentFiles` near-miss before it: **a field's name is not evidence of its
 * contents.**
 *
 * ⚠ THE AUDIENCE BOUNDARY IS APPLIED IN SQL, NOT AFTER (rule b). `foldFacts` is
 * given no `audiences`, which is its documented CONSERVATIVE default: only facts
 * with `audience_scope IS NULL` are returned, so a reader whose audience
 * membership is unknown never receives an audience-scoped fact. Nothing the
 * reader may not see is ever loaded and then filtered — a partial the caller has
 * to trim is exactly what rule (b) forbids. When a reader's audience memberships
 * become resolvable, they are passed through here as `audiences`; that is a
 * widening of one argument, not a change to any consumer.
 *
 * ⚠ ON WORKSPACE SCOPING, deliberately NOT unified. The claim read uses
 * `coordWorkspaceId()` (every coord-table read in this directory does) and
 * `foldFacts` uses its own `activeWorkspaceId()` default (every `agent_facts`
 * read does). Cross-wiring one into the other would invent a third convention in
 * the one place least able to justify it; each leg follows its own store's rule.
 */
import type {
  HolderContextSources,
  HolderGoalRecord,
} from '../../coord/holder-context';
import type { CellReader } from '../../cell-registry';
import { foldFacts } from '../../agent-facts/store';
import { fetchHolderGoalRecord } from './agent-goal-sources';

/**
 * Ceiling on owner-scoped facts read for ONE holder. Far above the measured live
 * population (234 rows across 225 owners ⇒ ~1 per owner), so `count` is a true
 * total in practice while a pathological writer still cannot turn a lock-block
 * message into an unbounded read.
 */
export const HOLDER_ASSUMPTION_FOLD_LIMIT = 50;

/**
 * The holder's current goal — now P-016's FULL auto-derivation, not the
 * plan-item claim alone.
 *
 * ⚠ THIS USED TO BE A PLAN-ITEM-ONLY READ, AND THAT WAS A MEASURED BLIND SPOT.
 * A live plan-item claim is one of four legs, and it is the leg with zero
 * standalone traffic: on 2026-07-27, **0 of 19 holders held a plan-item claim
 * without also holding a work-item**, so this function returned `null` for 15 of
 * 19 holders who demonstrably had a goal — a blocked reader was told "no goal
 * declared" about an agent actively holding a work-item.
 *
 * It now delegates to {@link fetchHolderGoalRecord}, which applies the
 * precedence (override > work-item > plan-item > fleet mission), the
 * `coord_links` corroboration tiebreak, and the same live-claim and
 * prose-safety rules. This is the swap the module header of
 * `coord/holder-context.ts` anticipated — behind the SAME seam, with NO consumer
 * change.
 */
export async function fetchHolderGoal(holderOwnerId: string): Promise<HolderGoalRecord | null> {
  return fetchHolderGoalRecord(holderOwnerId);
}

/**
 * The assumption KEYS this reader may see for this holder.
 *
 * Returns KEYS ONLY — the bodies are read and discarded here rather than passed
 * up, so rule (d)'s "count plus an expansion, never inline prose" is enforced at
 * the SOURCE and a future consumer cannot quietly start rendering bodies by
 * reaching one level deeper.
 *
 * The `reader` argument is required by the {@link HolderContextSources} contract
 * and is the seam the audience filter widens through (see the module note above);
 * today's conservative default admits only unrestricted facts, for every reader.
 */
export async function fetchHolderAssumptionKeys(
  holderOwnerId: string,
  reader: CellReader,
): Promise<readonly string[]> {
  const owner = holderOwnerId.trim();
  if (!owner || !reader?.ownerId) return [];

  try {
    const facts = await foldFacts([{ scope: 'owner', scopeRef: owner }], {
      limitPerSelector: HOLDER_ASSUMPTION_FOLD_LIMIT,
      // audiences deliberately OMITTED — the conservative default (unrestricted
      // facts only). See the audience note in the module header.
    });
    return facts.map((f) => f.key).filter(Boolean);
  } catch {
    return [];
  }
}

/** Build the injected source set for one holder-context resolution. */
export function holderContextSources(): HolderContextSources {
  return {
    holderGoal: fetchHolderGoal,
    holderAssumptionKeys: fetchHolderAssumptionKeys,
  };
}
