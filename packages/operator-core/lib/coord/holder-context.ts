/**
 * holder-context.ts — P-026's SHARED `HolderContext` PROJECTION: the ONE resolver
 * every friction-point enrichment in D-055 consumes, so that eight injection
 * points do not invent eight shapes.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-026. Scoping ruling: **D-083**.
 *
 * THE QUESTION IT ANSWERS. A reader who is BLOCKED BY a specific holder (a lock
 * they cannot take, an item they cannot claim, a release they are waiting on)
 * wants two things about that holder: what are they trying to DO, and what are
 * they ASSUMING while they do it. Every D-055 Tier-A surface asks the same two
 * questions, so they resolve them here once rather than each reaching for its own
 * columns.
 *
 * ⚠ BUILT BEFORE ANY CONSUMER, ON PURPOSE (the item's own ordering rule). With
 * the shape fixed first, each injection point is a few lines; with the first
 * consumer shipping first, the other seven inherit its accidents.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE (a) — ONE derivation, and which leg goes through `getCell`.
 *
 * ⚠ STATUS, because this rule has MOVED and the history below is the reason it
 * moved — do not read the historical paragraph as current:
 *   · the GOAL leg **now passes the cell gate** — P-016 landed
 *     {@link AGENT_GOAL_CELL_ID}, and `resolveHolderContext` reads the goal only
 *     when `getCell(AGENT_GOAL_CELL_ID, reader)` discloses it (see the swap note
 *     on that function). This is the anticipated swap, not a deviation.
 *   · the ASSUMPTIONS leg **still does not**, and that is deliberate rather than
 *     pending: `agent_facts` carries its own `audience_scope`, applied IN SQL by
 *     `foldFacts`, so a cell in front of it would be a SECOND audience check on
 *     data that already has one — the re-implementation D-042 names as the failure.
 *
 * The original rationale, kept because it is why the assumptions leg stays as it
 * is: the item said the resolver "resolves through `getCell(cell, reader)`", and
 * measured against the registry before building (D-083 §2) **no goal cell and no
 * assumption cell existed** — only five infrastructure cells were registered, and
 * their producers (P-016 goal-as-ref, P-009 assumption stamping, P-011
 * conflicting-assumption cells) were all still `todo`. Building against a cell
 * that does not exist would satisfy the sentence and derive NOTHING — the exact
 * failure this plan had then hit three times (D-082, and the `currentFiles`
 * near-miss before it).
 *
 * So D-083 (i) ruled: honour the rule's INTENT — one audience oracle, no consumer
 * re-implementing the check — via the boundary each source's data actually has:
 *   · the goal → `plan_item_claims.intent`, whose audience boundary is the claim
 *     read itself (it is already disclosed unconditionally to anyone who collides
 *     with the claim — see `plan-items/claim-holder.ts`). ← SUPERSEDED by P-016's
 *     cell, per the status note above;
 *   · assumptions → `agent_facts`' own `audience_scope`, applied IN SQL by
 *     `foldFacts` (the store's conservative default folds only unrestricted
 *     facts, so a reader whose audience context is unknown receives none). ← STILL
 *     CURRENT.
 * P-016's cell swapped in behind {@link HolderContextSources} with NO consumer
 * change — which is precisely the "build it before any consumer" rationale paying
 * off. A cell read added here MUST use `getCell(cell, reader)` /
 * `listCells(reader)` and NEVER the `*Unchecked` accessors (D-042 / D-078 (c),
 * mechanically gated by `cell-access-parity.test.ts`).
 *
 * ⚠ RULE (b) — UNREADABLE == ABSENT, never a partial. A reader who may not see a
 * holder's assumptions gets `{ count: 0, keys: [] }` — the SAME answer as a holder
 * who has none, and never a locally-assembled approximation of the ones they may
 * not see. That indistinguishability is deliberate (it is why the item notes a
 * refusal is not a probe oracle): a reader must not be able to infer the EXISTENCE
 * of state it may not read by observing a refusal that looks different from empty.
 *
 * ⚠ RULE (e) — `stale` IS THE GOAL'S AGE, AND THAT DIFFERS FROM `ClaimHolder.stale`.
 * Read this before assuming the two are the same number:
 *   · `ClaimHolder.stale` (claim-holder.ts) is derived from `last_activity_ts` —
 *     "is this AGENT still moving?"
 *   · `HolderContext.stale` is derived from `declaredAt` — "is this GOAL still
 *     current, or is it a declaration from three hours ago?"
 * Both are correct for their question, and rule (e) binds this one to `declaredAt`
 * because an undated goal is exactly how a stale value reads as current — the
 * defect P-017 (c)'s detector exists to catch, which shipping this without it
 * would reintroduce one layer up. An agent can be busily active (fresh
 * `ClaimHolder.stale`) on a goal it declared long ago and never updated, and a
 * blocked peer needs to see THAT. Both reuse the ONE `computeIntentStale` /
 * `INTENT_STALE_SEC` derivation — no second staleness rule.
 *
 * ⚠ RULE (f) — PURE AND TOTAL. Every consumer is on a hot path (a lock acquire, a
 * claim, a presence read), so an enrichment must never be able to fail the
 * operation it decorates: the core takes plain data and cannot throw, every IO leg
 * is injected and fail-soft, and a dead source degrades ONE field rather than
 * taking down the read that called it.
 */
import { getCell, type CellReader } from '../cell-registry';
import { computeIntentStale, INTENT_STALE_SEC } from '../agent-tools/coordination/presence-tier1';
import { declaredGoalOf } from '../plan-items/claim-holder';
import { asGoalRef, AGENT_GOAL_CELL_ID, type GoalAgreement } from '../agent-goal-ref';

/**
 * How many assumption KEYS are named before the projection relies on `count`
 * alone. Rule (d): assumptions render as a count plus an expansion, never inline
 * prose — an unbounded set per holder is a payload defect, measured: `coord:presence`
 * is already 28KB p50 / 66KB p90 against a 6000-token inline budget.
 */
export const HOLDER_ASSUMPTION_KEY_CAP = 12;

/**
 * What a holder is doing and assuming, as EVERY D-055 enrichment point renders it.
 *
 * ⚠ THE SHAPE IS FIXED BY D-055, RESTATED BY D-083 (iv), AND AMENDED ONCE BY
 * D-093 — these SEVEN fields, no more. `holder-context.test.ts` gates it, because
 * "one shape for eight consumers" is the entire reason this module exists and a
 * field added for one consumer's convenience is how that erodes. The amendment
 * rule is unchanged: a sixth (now eighth) field is a plan Decision, never a quiet
 * addition here.
 */
export interface HolderContext {
  /** The work-item / plan-item / cell ref the goal is ABOUT. Never a raw bigint
   *  (rule c, D-046: a bigint is not a read surface). */
  goalRef: string | null;
  /** The holder's DECLARED goal, or null — an honest unknown, never a fabricated
   *  goal and never a mechanism string dressed up as one (see {@link declaredGoalOf}). */
  goalText: string | null;
  /** Count plus a bounded key expansion — never the assumption BODIES (rule d). */
  assumptions: { count: number; keys: string[] };
  /** When the goal was declared. The input `stale` is derived from. */
  declaredAt: string | null;
  /** Goal older than INTENT_STALE_SEC. null ⇒ undated, so staleness is UNKNOWN —
   *  never `false`, which would read as "freshly declared". */
  stale: boolean | null;
  /**
   * D-093 / D-092 — do the INDEPENDENT legs agree about what this holder is doing?
   * `null` only when there is no resolvable goal at all.
   *
   * ⚠ NOT DECORATION. Measured 2026-07-27: 3 of 19 holders hold TWO work-items at
   * once, and the row carries no link back to the plan. `goalRef` alone tells a
   * blocked peer "this is their goal" in exactly the population where precedence
   * had to pick one arbitrarily; `agreement` is what says whether to believe it.
   */
  agreement: GoalAgreement | null;
  /**
   * The other ITEM refs this holder also holds, which `goalRef` does NOT subsume.
   * `[]` when there are none.
   *
   * ⚠ DISCLOSED, NEVER DROPPED (D-092). A projection that silently discards a
   * claim the agent demonstrably holds manufactures a confident wrong answer —
   * which is what this projection did before D-093, having computed the value and
   * thrown it away one line later. A FLEET MISSION is deliberately absent: it is
   * the container the work happens in, not a rival goal (D-092's refinement).
   */
  competing: string[];
}

/** The goal facts this projection reads — structural, so any producer (today a
 *  `plan_item_claims` row, tomorrow a P-016 goal cell) satisfies it without either
 *  side importing the other. */
export interface HolderGoalRecord {
  /** The claimed item id — becomes {@link HolderContext.goalRef}. */
  itemId: string;
  /** Raw claim intent. Split by {@link declaredGoalOf}, never echoed verbatim. */
  intent?: string | null;
  /** When the claim, and so the goal, was declared. */
  acquiredTs?: string | null;
  /** D-093 — the producer's leg-agreement verdict, carried through rather than
   *  recomputed here (the projection has only ONE leg's data and could not derive
   *  it). Absent from a producer that cannot answer ⇒ `agreement: null`. */
  agreement?: GoalAgreement | null;
  /** D-093 / D-092 — the other item refs the holder also holds. Absent ⇒ `[]`. */
  competing?: readonly string[] | null;
}

/**
 * The bounded, reader-scoped reads this projection needs. Each is OPTIONAL: an
 * unavailable source degrades that one field, never the whole derivation — and an
 * OMITTED source yields nothing rather than an approximation (rule b).
 */
export interface HolderContextSources {
  /** The holder's current goal record, or null when they have declared none. */
  holderGoal?: (holderOwnerId: string) => Promise<HolderGoalRecord | null>;
  /**
   * The assumption KEYS this READER may see for this holder. Reader-relative by
   * construction: the implementation applies the audience boundary in SQL, and
   * returns only what survives it. It must NEVER return keys the reader may not
   * see for the caller to filter afterwards — that is the partial rule (b) forbids.
   */
  holderAssumptionKeys?: (holderOwnerId: string, reader: CellReader) => Promise<readonly string[]>;
}

/**
 * Guard {@link HolderContext.goalRef} — rule (c) / D-046: a bigint is not a read
 * surface, so an unusable id must read as ABSENT rather than present-and-broken.
 *
 * ⚠ RE-EXPORTED, NOT REDEFINED. P-016 made `agent-goal-ref.ts` the canonical home
 * of the ref rule, because that is the module which MINTS refs. Keeping a second
 * copy here would be exactly the second derivation D-038 axis 5 forbids — and the
 * two could then disagree about what counts as a usable goal ref, which is the
 * one thing every consumer of this projection relies on.
 */
export { asGoalRef };

function cleanKey(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Seconds since a timestamp; null when absent or unparseable (⇒ `stale` unknown,
 *  not `false` — an unreadable stamp must never read as "freshly declared"). */
function secAgo(ts: string | null | undefined, nowMs: number): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/**
 * THE PURE CORE: a goal record + the assumption keys this reader may see → the
 * one projection.
 *
 * Returns **null when there is nothing disclosable** — no resolvable goal and no
 * visible assumptions. A consumer then omits the field entirely rather than
 * padding its payload with an all-null object, and (per rule b) that null is
 * deliberately the same answer a reader gets for a holder whose state it may not
 * read: absent and unreadable are indistinguishable by design.
 *
 * TOTAL by construction (rule f): no throw, no I/O, and every malformed input —
 * a null record, a bigint id, an unparseable timestamp, a non-string key —
 * degrades one field instead of failing.
 */
export function projectHolderContext(
  goal: HolderGoalRecord | null | undefined,
  assumptionKeys: readonly string[] = [],
  nowMs: number = Date.now(),
): HolderContext | null {
  const rawItemId = cleanKey(goal?.itemId);
  const goalRef = asGoalRef(rawItemId);

  // `declaredGoalOf` needs the RAW id (it detects the auto-convert mechanism
  // string, which embeds it) even when that id is unusable as a ref.
  const { goalText } = rawItemId
    ? declaredGoalOf(goal?.intent, rawItemId)
    : { goalText: null as string | null };

  const keys = [...new Set(assumptionKeys.map(cleanKey).filter(Boolean))].sort();
  // `count` is the TRUE total; `keys` is the bounded expansion. That split is the
  // whole point of rule (d) — a reader learns "11 assumptions" even when only the
  // first few are named, so the cap never silently understates the holder's state.
  const assumptions = { count: keys.length, keys: keys.slice(0, HOLDER_ASSUMPTION_KEY_CAP) };

  if (!goalRef && !goalText && assumptions.count === 0) return null;

  const declaredAt = goal?.acquiredTs ?? null;
  // ⚠ THE DISCLOSURE IS BOUND TO A RESOLVED GOAL (D-093). With no `goalRef` there
  // is nothing for a competing ref to compete WITH, and reporting `divergent`
  // beside an absent goal would be an unreadable verdict about a value the reader
  // cannot see — so the pair collapses to (null, []) exactly when `goalRef` does.
  const competing = goalRef
    ? [...new Set((goal?.competing ?? []).map(cleanKey).filter(Boolean))].sort()
    : [];
  return {
    goalRef,
    goalText,
    assumptions,
    declaredAt,
    stale: computeIntentStale(secAgo(declaredAt, nowMs)),
    agreement: goalRef ? (goal?.agreement ?? null) : null,
    competing,
  };
}

/**
 * Re-project a holder's context ONTO ONE SUBJECT — the item/lock/plan-item the
 * reader is actually looking at, or being refused.
 *
 * ⚠⚠ A HOLDER-LEVEL FACT MUST NEVER NAME THE SUBJECT IT IS RENDERED ON (D-094).
 * `competing` means "the OTHER refs this holder also holds". Rendered against a
 * subject, the unfiltered list names that subject as a rival to itself: on row
 * `WI-6410`, with the holder's resolved goal being `EI-1881…`, it read *"…and
 * they are also competing on WI-6410"*. Measured live 2026-07-27: 3 of 18
 * decorated rows — every multi-item holder, i.e. exactly the population the field
 * exists to serve. A fixture cannot catch it, because a fixture author already
 * knows which row is which; it only appears when ONE holder's context lands on
 * TWO subjects of one response.
 *
 * ⚠ IT LIVES HERE, NOT AT THE CALL SITES. P-030 discovered the rule inside
 * `work_items/_holder-lens.ts` and implemented it privately there. P-027 renders
 * this same projection against four MORE subjects (a claim refusal, a release
 * request, a lock queue entry, a plan-item conflict), and four copies of a
 * one-line filter is precisely the second-derivation trap D-038 axis 5 forbids —
 * they would drift, and the drift would be invisible because each looks correct
 * alone. So the rule is stated once, where the shape is defined.
 *
 * Dropping the self-reference loses NOTHING (the reader knows which subject they
 * asked about) and sharpens the real signal: when `goalRef` differs from the
 * subject, the holder is holding this thing while working on something else —
 * exactly what a reader deciding whether to wait needs to know.
 *
 * TOTAL, like everything else here: a blank/absent subject returns the context
 * unchanged rather than throwing, and the identical object is returned when
 * nothing was filtered so callers can cheaply detect a no-op.
 */
export function forSubject(
  ctx: HolderContext,
  subjectRef: string | null | undefined,
): HolderContext {
  const id = (subjectRef ?? '').trim();
  if (!id || ctx.competing.length === 0) return ctx;
  const competing = ctx.competing.filter((ref) => ref !== id);
  return competing.length === ctx.competing.length ? ctx : { ...ctx, competing };
}

/**
 * THE ORCHESTRATOR: resolve one holder's context for one reader.
 *
 * FAILS CLOSED ON A MISSING READER. `reader` is required rather than optional for
 * the reason `getCell` requires it (cell-registry.ts): an optional audience is a
 * defaulted audience, and a defaulted access check fails OPEN. A caller that
 * cannot identify its reader gets `null` — no context — which is also what makes
 * it safe for a consumer to thread the reader optionally from its own call sites.
 *
 * FAIL-SOFT PER LEG: a thrown or rejected source contributes nothing while the
 * other still lands, so a dead facts store costs the assumptions field and leaves
 * the goal intact.
 *
 * ⚠ THE GOAL LEG NOW PASSES THE CELL GATE — this is the swap the module header
 * above anticipated ("when P-016/P-009 land their cells they swap in behind
 * `HolderContextSources` with NO consumer change"), and P-016 landed
 * {@link AGENT_GOAL_CELL_ID}. The goal is read ONLY when
 * `getCell(AGENT_GOAL_CELL_ID, reader)` discloses the cell to THIS reader, so
 * every holder surface — the lock-block message, P-030's work-item lens, the six
 * D-051 surfaces still to come — inherits ONE audience check instead of each
 * re-implementing it. D-042 names re-implementation as the failure; P-028's
 * parity suite is what mechanically holds this to it.
 *
 * ⚠ AND A REFUSAL IS INDISTINGUISHABLE FROM AN ABSENCE (rule b / D-056). A reader
 * the gate refuses gets `goal: null` — byte-identical to a holder who has
 * declared nothing — never a distinct error, a flag, or a differently-shaped
 * result. That is deliberate: a refusal that LOOKS different from empty is a
 * probe oracle for the existence of state the reader may not read.
 */
export async function resolveHolderContext(
  holderOwnerId: string,
  reader: CellReader | null | undefined,
  sources: HolderContextSources = {},
  opts: { nowMs?: number } = {},
): Promise<HolderContext | null> {
  const holder = cleanKey(holderOwnerId);
  if (!holder) return null;
  if (!cleanKey(reader?.ownerId)) return null; // no identified reader ⇒ no reader-relative state

  // GATE 1 (P-019 audience) for the goal leg. Pure — a Map lookup plus
  // `canReadCell`, no I/O and no throw — so it cannot violate rule (f) on the hot
  // paths this decorates. An unregistered cell fails CLOSED here, which is the
  // correct reading of "the goal cell does not exist in this process".
  const goalDisclosed = getCell(AGENT_GOAL_CELL_ID, reader as CellReader) !== undefined;

  const settle = async <T>(f: (() => Promise<T>) | undefined, fallback: T): Promise<T> => {
    if (!f) return fallback;
    try {
      return await f();
    } catch {
      return fallback;
    }
  };

  const [goal, keys] = await Promise.all([
    settle(
      goalDisclosed && sources.holderGoal ? () => sources.holderGoal!(holder) : undefined,
      null as HolderGoalRecord | null,
    ),
    settle(
      sources.holderAssumptionKeys
        ? () => sources.holderAssumptionKeys!(holder, reader as CellReader)
        : undefined,
      [] as readonly string[],
    ),
  ]);

  return projectHolderContext(goal, keys, opts.nowMs ?? Date.now());
}

export { INTENT_STALE_SEC };
