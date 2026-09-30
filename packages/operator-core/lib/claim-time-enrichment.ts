/**
 * claim-time-enrichment — the ONE definition of the trap-guard set every claim
 * surface attaches, and the one place a new guard has to be wired.
 *
 * WI-41182. Six independent guards accumulated here over ~6 weeks, each added by
 * hand at whichever claim surfaces its author happened to be looking at. There
 * was no definition of "the set", so the honest answer to "which guards does a
 * claim carry?" was *it depends which verb you claimed with* — measured in source
 * before this module existed:
 *
 *   scheduler:get_next      6/6
 *   work_items:claim        6/6  (plus its own surface-specific hints)
 *   work_items:claim_next   5/6  — no planContradiction
 *   plan_items:claim        2/6  — no premises, retraction, authorship, planContradiction
 *
 * That drift is silent in both directions: an agent claiming through
 * `plan_items:claim` (the natural verb right after `coord:orient { planItems }`
 * declines to claim) got no premise check and no plan-says-done contradiction,
 * and nothing in the result said a guard had been skipped rather than passed.
 * WI-39498 is the zombie class planContradiction exists to stop — 9 successive
 * claimants on WI-36047 — and two of the four surfaces were still exposed to it.
 *
 * ⚠ THE POINT OF THIS MODULE IS THE REGISTRY, NOT THE CONVENIENCE. Adding a
 * seventh guard by hand at three surfaces and forgetting the fourth is exactly
 * how the four counts above diverged. `CLAIM_TIME_ENRICHMENT_LEGS` is what
 * `claim-time-enrichment-parity.test.ts` enumerates, so a leg added to the type
 * but not attached everywhere fails the build instead of shipping half-wired.
 *
 * ⚠ ADVISORY, TOTAL, NEVER THROWS. Every leg is independently fail-soft and the
 * result is a spreadable object with absent keys omitted, so this can never
 * change a claim's `ok` verdict or its payload shape. Saying nothing asserts
 * nothing — a swallowed read must never render as "the guard passed" (the
 * WI-6737 lesson: a null that means "the read failed" must not be read as a
 * null that means "there is nothing there"). Callers that need to distinguish
 * those two cases must do so at their own seam, as work_items:claim does for
 * its checkpoint hint.
 *
 * Surface-specific hints deliberately DO NOT live here: work_items:claim's
 * checkpoint hint, prior-work hint, concurrency, dependency blockers, suggested
 * watches and plan-lane collision are each a function of that surface's own
 * arguments or of state only it has resolved. This module holds exactly the legs
 * that are a pure function of the claimed subject, which is what makes them the
 * set that SHOULD be identical everywhere.
 */


import type { ClaimTimeStalePathHint, ClaimTimeStalePathRef } from './stale-path-hints-claim-port';

/**
 * The registry. Order is the order the guards were added; it carries no meaning
 * beyond keeping diffs small.
 *
 * ⚠ Adding a member here without attaching it in `buildClaimTimeEnrichment`
 * fails the parity test by design — that failure IS the wiring reminder.
 */
export const CLAIM_TIME_ENRICHMENT_LEGS = [
  'planDecisions',
  'priorAttemptBrief',
  'premises',
  'retraction',
  'authorship',
  'planContradiction',
  // P-011: WHICH promises a claimed item is on the hook for, at WHICH revision.
  // Registered here only once all four surfaces attach it — the three hand-wiring
  // surfaces call `getClaimTimeBehaviorContract` directly, plan_items:claim gets it
  // by delegating to this port. Registering earlier would have made the parity guard
  // assert a coverage the tree did not have.
  'behaviorContract',
  // EI-21267393427094356: which stored payload paths are dead at HEAD, and where
  // each moved to — a bounded git rename walk at the moment of the claim.
  'pathHints',
  // EI-18713141708830049: the plan item is still OPEN while a settled sibling already
  // implements it — "the tree says done", the mirror of `planContradiction` above.
  'planItemLanded',
  // EI-19329513980117751: another work-item shares this one's stored payload paths and
  // has already landed (or a peer holds it now). The three legs above all reach the
  // sibling through the PLAN; this one needs no plan at all, which is the point — every
  // measured instance of the duplicate-filing class was plan-less, so the plan-linked
  // legs are structurally silent for exactly the population that suffers it.
  'siblingPathOverlap',
  // EI-19418245218824265: the tree already CITES this item's own id — an
  // implementation usually names the item it closed. The ten legs above all read
  // the ROW (checkpoint, release history, terminal state, plan, siblings); this is
  // the first that reads the TREE, which is the only place the evidence exists when
  // the implementer never CLAIMED the row. That row is byte-indistinguishable from
  // never-started, so every other leg is structurally silent for it.
  'sourceCitation',
] as const;

export type ClaimTimeEnrichmentLeg = (typeof CLAIM_TIME_ENRICHMENT_LEGS)[number];

/**
 * The claimed subject. Every field is optional because the four surfaces resolve
 * different amounts of the row: `scheduler:get_next` and `work_items:claim` hold
 * a full work-item, while `plan_items:claim`'s bare (non-converting) path holds
 * only a plan pointer and no work-item at all. A leg whose inputs are absent
 * returns nothing rather than guessing — see `buildClaimTimeEnrichment`.
 */
export interface ClaimTimeEnrichmentSubject {
  id?: string | null;
  family?: 'feature' | 'issue' | null;
  payload?: unknown;
  harness?: string | null;
  title?: string | null;
  summary?: string | null;
  state?: string | null;
  sourcePlanSlug?: string | null;
  sourcePlanItemIds?: string[] | null;
}

/**
 * The decoration. Field names are load-bearing: they are the names the four
 * surfaces already emitted, so rewiring them onto this port is a pure
 * de-duplication with no change to any caller's observed payload.
 */
export interface ClaimTimeEnrichment {
  planDecisions?: unknown;
  planDecisionsNote?: string;
  priorAttemptBrief?: unknown;
  premises?: unknown;
  retractionWarning?: string;
  authorshipRevalidation?: unknown;
  authorshipRevalidationWarning?: string;
  planItemContradiction?: unknown;
  planItemContradictionWarning?: string;
  /**
   * P-011: WHICH behavior clauses this item is on the hook for, at WHICH revision.
   * ⚠ ADVISORY (D-017) — the resolver reports; P-013 owns turning any of it into a
   * refusal. A consumer must not render it as a blocker.
   */
  behaviorContract?: unknown;
  behaviorContractNote?: string;
  /**
   * EI-21267393427094356: stored payload paths that no longer exist at HEAD, each
   * resolved to its current location when git can follow the renames. Advisory:
   * the claimant works from resolvedTo instead of taking the stored hint literally
   * and falling back to a repository-wide search.
   */
  pathHints?: ClaimTimeStalePathHint[];
  pathHintsNote?: string;
  /** EI-20049758099997696: unresolved repo-relative paths cited in title/summary. */
  stalePathRefs?: ClaimTimeStalePathRef[];
  stalePathRefsNote?: string;
  /**
   * EI-18713141708830049: the plan item this row belongs to is still NON-terminal
   * while a SIBLING work-item on the same item has already settled — "the tree says
   * done". Deliberately the MIRROR of `planItemContradiction` above and disjoint
   * from it: that one fires on a TERMINAL plan item, this one on a live plan item
   * whose work has in fact landed. Advisory; the warning stamps which evidence tier
   * resolved the link, because a prose-derived match must never read as a recorded one.
   */
  planItemLanded?: unknown;
  planItemLandedWarning?: string;
  /**
   * EI-19329513980117751: another work-item shares this one's stored `payload.paths`
   * and has already landed (or is held by a peer now). Deliberately a PATH check and
   * not a similarity score — the measured duplicate pairs diverge in prose and agree
   * only on paths, and the cosine edge for one of them does not exist at all. See the
   * port's module note for that measurement.
   */
  siblingPathOverlap?: unknown;
  siblingPathOverlapWarning?: string;
  /**
   * EI-19418245218824265 — evidence paths in the tree that name this item's own id.
   *
   * Absent for BOTH "nothing cites it" and "the probe could not run": the port
   * collapses those to `null` on purpose, because rendering the second as a claim
   * about the tree is the false negative the underlying Scout probe exists to
   * prevent. Saying nothing asserts nothing.
   */
  sourceCitation?: unknown;
  sourceCitationWarning?: string;
  /**
   * P-013 — what this claim's context actually contained, and what it did not.
   *
   * REQUIRED, unlike every other field here. The others are optional because a leg
   * legitimately produces nothing; this one is produced on every call by construction,
   * and making it optional would recreate exactly the ambiguity it exists to remove —
   * an absent delivery record is indistinguishable from a claim that delivered nothing.
   */
  enrichmentDelivery: ClaimTimeEnrichmentDelivery;
}

/**
 * Why a leg produced nothing — the distinction the bare `null` could not carry.
 *
 * · `delivered`       — the leg ran and returned context.
 * · `empty`           — the leg ran against real inputs and legitimately found nothing.
 * · `skipped-no-input`— the surface had no work-item / payload / id for this leg to use.
 * · `failed`          — the leg THREW. Context the claimant should have had is missing.
 */
export type ClaimTimeLegOutcome = 'delivered' | 'empty' | 'skipped-no-input' | 'failed';

export interface ClaimTimeOmittedLeg {
  leg: ClaimTimeEnrichmentLeg;
  reason: Exclude<ClaimTimeLegOutcome, 'delivered'>;
}

/**
 * P-013 instrumentation — what this claim's context ACTUALLY contained.
 *
 * ⚠ THE DEFECT THIS CLOSES, not merely the measure it adds. Every leg below ends
 * `.catch(() => null)`, and that null is returned for THREE different situations: the
 * surface had no inputs for the leg, the leg ran and found nothing, or the leg BROKE.
 * The first two are correct and expected. The third means a claimant was handed less
 * context than the system believes it hands out — and it is invisible, to the claimant
 * and to everyone else, because a broken leg looks exactly like a quiet one. Nothing
 * anywhere records what a claim actually delivered.
 *
 * The catch itself is right (one broken guard must not take down a claim). What was
 * wrong is that it discarded WHY. So this records the reason instead of removing the
 * catch: same resilience, no silent hole.
 *
 * Deliberately derived at render time and NOT written to a new ledger table. The
 * measurement is of one call's own output and is complete in that call; persisting it
 * would be a second durable surface holding a copy of something the payload already
 * states, which is the drift class this plan exists to remove.
 */
export interface ClaimTimeEnrichmentDelivery {
  /** Legs that produced context, in registry order. */
  delivered: ClaimTimeEnrichmentLeg[];
  /**
   * Legs that did not, each with its reason. A `skipped-no-input` entry is ordinary on
   * a bare plan-item claim; a `failed` entry never is.
   */
  omitted: ClaimTimeOmittedLeg[];
  /**
   * Legs that THREW. Always a subset of `omitted`, hoisted because it is the only
   * outcome that indicates something is broken — a reader scanning one field should
   * not have to filter `omitted` to notice.
   */
  failed: ClaimTimeEnrichmentLeg[];
  /**
   * Serialized size of the enrichment context in characters — the CONTEXT SIZE half of
   * the measure.
   *
   * Named to match `BoundedPriorAttemptBrief.serializedChars` (P-017), which measures
   * the same quantity one level down, for the prior-attempt leg's own payload. The two
   * nest rather than compete: that one asks "how big is this brief, and what did it
   * leave out", this one asks "how big is the whole claim context, and which legs are
   * in it at all". Using a different name for the same measurement would make them look
   * like rival numbers.
   *
   * ⚠ It is the length of what this PORT returns, not of what any particular surface
   * finally renders — a surface may drop or reshape legs downstream. Read it as the
   * cost of the context assembled here, never as a token count.
   */
  serializedChars: number;
  /**
   * How to recover what is missing — the DRILL-DOWN half. Present only for `failed`
   * legs, because those are the only omissions that are both unexpected and
   * actionable: a `skipped-no-input` leg has nothing to recover, and an `empty` one
   * already answered.
   */
  recover?: string;
}

export interface ClaimTimeEnrichmentOpts {
  /** The claimed work-item, when the surface has one. */
  workItem?: ClaimTimeEnrichmentSubject | null;
  /** Explicit plan pointer — `plan_items:claim` knows these from its own args. */
  planSlug?: string | null;
  planItemId?: string | null;
  harness?: string | null;
  workspaceId?: string | null;
  family?: 'feature' | 'issue' | null;
}

/**
 * Run every registered guard against the claimed subject, in parallel.
 *
 * Parallel because the legs are independent reads with no ordering between them;
 * serial would pay six round-trips on the one call an agent is waiting on before
 * it can start work. Each leg is separately `.catch`ed so one slow or broken
 * guard cannot take down the other five — or the claim.
 */
export async function buildClaimTimeEnrichment(opts: ClaimTimeEnrichmentOpts): Promise<ClaimTimeEnrichment> {
  const wi = opts.workItem ?? null;
  const harness = wi?.harness ?? opts.harness ?? null;
  const workspaceId = opts.workspaceId ?? undefined;
  const family = wi?.family ?? opts.family ?? null;
  const workItemId = wi?.id ?? null;
  // The behavior-contract resolver needs an id to read explicit edges. Keep the
  // partial-subject contract for the other legs, but only expose an identified
  // subject to this leg so an absent id cannot become a fabricated lookup key.
  const behaviorContractWorkItem = wi?.id ? { ...wi, id: wi.id } : null;

  /**
   * Run one leg, recording WHY it produced nothing.
   *
   * ⚠ The catch behaviour is UNCHANGED — a throwing leg still yields null and still
   * cannot take down the claim. The only difference is that the reason survives, so a
   * broken leg stops being indistinguishable from a quiet one. Keep it that way: an
   * unhandled throw here would turn a degraded claim into a failed one.
   *
   * `hasInput` is evaluated by the CALLER (each leg knows its own preconditions), so
   * the previous `cond ? … : Promise.resolve(null)` guards become the `hasInput`
   * argument rather than a second, differently-shaped path.
   */
  const outcomes = new Map<ClaimTimeEnrichmentLeg, ClaimTimeLegOutcome>();
  const runLeg = async <T, G>(
    leg: ClaimTimeEnrichmentLeg,
    // The gate may be the leg's INPUT VALUE, not just a boolean, and the leg
    // receives it NARROWED. A `Boolean(x)` gate is opaque to the compiler, so a
    // leg gated on `Boolean(workItemId)` still saw `string | null` inside and had
    // to re-check it or widen its callee — the gate and the leg's precondition
    // drifting into two separately-maintained facts. Passing the value makes them
    // one fact, checked once. Genuinely compound preconditions (`a || b`) stay
    // boolean: there is no single value to hand down.
    hasInput: G,
    run: (input: NonNullable<G>) => Promise<T | null>,
  ): Promise<T | null> => {
    if (!hasInput) {
      outcomes.set(leg, 'skipped-no-input');
      return null;
    }
    try {
      const value = await run(hasInput);
      outcomes.set(leg, value ? 'delivered' : 'empty');
      return value;
    } catch {
      outcomes.set(leg, 'failed');
      return null;
    }
  };

  const [
    planDecisions,
    priorAttemptBrief,
    premises,
    retractionWarning,
    authorship,
    planContradiction,
    behaviorContract,
    pathHintsEntry,
    planItemLandedEntry,
    siblingPathOverlapEntry,
    sourceCitationEntry,
  ] = await Promise.all([
      // What OTHERS ruled that governs this item. Available from either a
      // work-item payload stamp or an explicit plan pointer.
      runLeg('planDecisions', Boolean(opts.planSlug || wi), async () => {
        const m = await import('./plan-decisions-claim-port');
        // Takes both keys; the port prefers an explicit `planSlug` and falls
        // back to deriving one from the work-item payload stamp, so passing
        // whichever the surface has (or both) is correct.
        const brief = await m.getClaimTimePlanDecisions({
          ...(opts.planSlug ? { planSlug: opts.planSlug } : {}),
          ...(wi ? { workItem: { payload: wi.payload } } : {}),
          harness,
          workspaceId,
        });
        return brief ? { planDecisions: brief.decisions, planDecisionsNote: m.renderPlanDecisionsNote(brief) } : null;
      }),

      // What was already TRIED on this lane. The only leg that works from a bare
      // plan pointer with no work-item, which is why `plan_items:claim` had it.
      runLeg('priorAttemptBrief', Boolean(opts.planSlug || opts.planItemId || wi || workItemId), async () => {
        const m = await import('./prior-attempt-context');
        const brief = await m.getClaimTimePriorAttemptBrief({
            ...(opts.planSlug ? { planSlug: opts.planSlug } : {}),
            ...(opts.planItemId ? { planItemId: opts.planItemId } : {}),
            // Passed explicitly (not omitted-when-absent like its siblings): the
            // port resolves `opts.workItemId ?? opts.workItem?.id ?? <synthetic>`,
            // so an explicit null still falls through to the work-item's own id
            // when there is one — while on the bare plan-item path it STATES that
            // no work-item exists, rather than leaving that to be inferred from a
            // missing key.
            workItemId,
            ...(wi
              ? {
                  workItem: {
                    ...(wi.id ? { id: wi.id } : {}),
                    payload: wi.payload,
                    harness: wi.harness,
                    sourcePlanSlug: wi.sourcePlanSlug,
                    sourcePlanItemIds: wi.sourcePlanItemIds,
                  },
                }
              : {}),
          harness,
        });
        return brief ? { priorAttemptBrief: brief } : null;
      }),

      // What THIS item's own text assumes. An unverified absence premise ("X does
      // not exist yet") is the measured way a claimant rebuilds something that is
      // already there, so this fires on the item's own body, not on history.
      runLeg('premises', Boolean(wi), async () => {
        const m = await import('./premises-claim-port');
        const brief = await m.getClaimTimePremises({
          workItem: { id: wi?.id, payload: wi?.payload, title: wi?.title, summary: wi?.summary },
          harness,
          workspaceId,
        });
        return brief ? { premises: brief } : null;
      }),

      // Whether a finding this item rests on has since been RETRACTED in its own
      // thread. Needs a live (non-settled) work-item row.
      runLeg('retraction', wi, async (wi) => {
        const m = await import('./agent-tools/work_items/retraction-advisory');
        const advisory = await m.getClaimTimeRetractionAdvisory(wi, harness);
        return advisory ? { retractionWarning: advisory.retractionWarning } : null;
      }),

      // Whether the item's stated author is still the right one to revalidate it.
      runLeg('authorship', workItemId, async (workItemId) => {
        const m = await import('./work-item-prior-work');
        const hint = await m.getClaimTimeAuthorshipRevalidationHint({ harness, workItemId, workspaceId });
        const warning = m.authorshipRevalidationWarning(hint);
        return hint && warning ? { authorshipRevalidation: hint, authorshipRevalidationWarning: warning } : null;
      }),

      // WI-39498: the plan says this is already DONE while the row is still open,
      // so the work may already be finished. The zombie guard.
      runLeg('planContradiction', workItemId, async (workItemId) => {
        const m = await import('./work-item-plan-contradiction');
        const hint = await m.getClaimTimePlanItemContradiction({ workItemId, payload: wi?.payload });
        const warning = m.planItemContradictionWarning(hint, workItemId);
        return hint && warning ? { planItemContradiction: hint, planItemContradictionWarning: warning } : null;
      }),

      // P-011: WHICH promises this item is on the hook for, at WHICH revision.
      //
      // The claimant is exactly who needs this and the claim is exactly when — until
      // now the resolved contract was legible only to the COMPLETION gate, so an agent
      // discovered which clauses it had to satisfy by being REFUSED at the end, after
      // the work was done. Same port the gate uses (`resolveWorkItemBehaviorContract`),
      // so what a claimant is told cannot drift from what they will be held to.
      //
      // ⚠ ADVISORY (D-017): reported, never enforced here. P-013 owns any refusal.
      // Needs a live work-item — a bare plan-item claim has no item to resolve edges for.
      runLeg('behaviorContract', behaviorContractWorkItem, async (behaviorContractWorkItem) => {
        const m = await import('./behavior-contract-claim-port');
        return await m.getClaimTimeBehaviorContract(behaviorContractWorkItem, harness);
      }),

      // EI-21267393427094356: which stored payload paths are dead at HEAD, and where
      // each moved to. Hints freeze at filing time while modules relocate (hive/* →
      // pot/* being the measured instance); without this resolution the claimant's
      // literal affected-path check fails into a repository-wide fallback search.
      // Needs a work-item payload — a bare plan-item claim carries none.
      runLeg('pathHints', Boolean(wi?.payload || wi?.title || wi?.summary), async () => {
        const m = await import('./stale-path-hints-claim-port');
        return m.getClaimTimeStalePathAdvisory({
          workItem: wi,
        });
      }),

      // EI-18713141708830049: the MIRROR of the planContradiction leg above — the plan
      // item is still open while a SIBLING work-item on it has already settled, so the
      // work may already be in the tree even though the ledger says otherwise. The
      // measured failure this closes is an agent re-investigating (and nearly
      // re-implementing) finished work because it routes off the ledger, not the tree.
      //
      // Resolves the plan item through a TIERED evidence chain (payload stamp > column >
      // prose) because only 24 of 119 real work-items carry the stamp and 7 the column:
      // a machine-link-only leg is silent for four items in five. The hint STAMPS which
      // tier matched so a prose-derived guess can never read as a recorded link.
      // Needs an identified work-item — a bare plan-item claim has no row to compare.
      runLeg('planItemLanded', workItemId, async (workItemId) => {
        const m = await import('./work-item-plan-item-landed');
        const hint = await m.getClaimTimePlanItemLanded({
          workItemId,
          payload: wi?.payload,
          planSlug: opts.planSlug,
          planItemId: opts.planItemId,
          sourcePlanSlug: wi?.sourcePlanSlug,
          sourcePlanItemIds: wi?.sourcePlanItemIds,
          workspaceId,
        });
        const warning = m.planItemLandedWarning(hint, workItemId);
        return hint && warning ? { planItemLanded: hint, planItemLandedWarning: warning } : null;
      }),

      // EI-19329513980117751: a DIFFERENT work-item shares this one's stored paths and
      // has already landed. The three legs above all reach their sibling through the
      // PLAN; this one needs no plan, which is the whole point — every measured instance
      // of the duplicate-filing class was plan-less (one root cause filed 3x in minutes
      // by different agents), so the plan-linked legs are structurally silent for exactly
      // the population that suffers it. Needs an identified work-item AND a payload:
      // the paths ARE the signal, so without them there is nothing to compare.
      runLeg('siblingPathOverlap', workItemId && wi?.payload ? workItemId : '', async (workItemId) => {
        const m = await import('./sibling-path-overlap-claim-port');
        const hint = await m.getClaimTimeSiblingPathOverlap({
          workItemId,
          payload: wi?.payload,
          harness: wi?.harness,
          workspaceId,
        });
        const warning = m.siblingPathOverlapWarning(hint, workItemId);
        return hint && warning ? { siblingPathOverlap: hint, siblingPathOverlapWarning: warning } : null;
      }),
      // EI-19418245218824265: does the TREE already cite this id? Needs nothing but
      // the id — no payload, no plan, no row history — which is exactly why it still
      // fires for the population every other leg is blind to (implemented by someone
      // who never claimed the row). One `git grep`, already timeout- and buffer-bounded
      // by the searcher it reuses, and fail-open to silence.
      runLeg('sourceCitation', workItemId, async (workItemId) => {
        const m = await import('./source-citation-claim-port');
        const hint = await m.getClaimTimeSourceCitation({ workItemId, workspaceId, harness, family });
        const warning = m.sourceCitationWarning(hint, workItemId);
        return hint && warning ? { sourceCitation: hint, sourceCitationWarning: warning } : null;
      }),
    ]);

  const context = {
    ...(planDecisions ?? {}),
    ...(priorAttemptBrief ?? {}),
    ...(premises ?? {}),
    ...(retractionWarning ?? {}),
    ...(authorship ?? {}),
    ...(planContradiction ?? {}),
    ...(behaviorContract ?? {}),
    ...(pathHintsEntry ?? {}),
    ...(planItemLandedEntry ?? {}),
    ...(siblingPathOverlapEntry ?? {}),
    ...(sourceCitationEntry ?? {}),
  };

  return { ...context, enrichmentDelivery: summarizeDelivery(outcomes, context) };
}

/**
 * Fold the per-leg outcomes into the delivery record.
 *
 * Iterates {@link CLAIM_TIME_ENRICHMENT_LEGS} rather than the outcome map's own keys,
 * so a leg that was REGISTERED but never attached (the exact failure the parity guard
 * exists to catch) reports as `skipped-no-input` instead of silently disappearing from
 * the census. A delivery record that only lists legs that ran cannot report a missing
 * leg — which is the one thing it is for.
 */
function summarizeDelivery(
  outcomes: Map<ClaimTimeEnrichmentLeg, ClaimTimeLegOutcome>,
  context: Record<string, unknown>,
): ClaimTimeEnrichmentDelivery {
  const delivered: ClaimTimeEnrichmentLeg[] = [];
  const omitted: ClaimTimeOmittedLeg[] = [];
  const failed: ClaimTimeEnrichmentLeg[] = [];

  for (const leg of CLAIM_TIME_ENRICHMENT_LEGS) {
    const outcome = outcomes.get(leg) ?? 'skipped-no-input';
    if (outcome === 'delivered') {
      delivered.push(leg);
      continue;
    }
    omitted.push({ leg, reason: outcome });
    if (outcome === 'failed') failed.push(leg);
  }

  // Size of the CONTEXT, deliberately measured before the delivery record is attached:
  // including the record in its own measurement would report a size no consumer of the
  // context actually pays, and would change whenever this record's shape changed.
  let serializedChars = 0;
  try {
    serializedChars = JSON.stringify(context)?.length ?? 0;
  } catch {
    // A leg returned something non-serializable. The context is still valid to return;
    // only the SIZE is unmeasurable, and 0 would read as "empty" rather than "unknown".
    serializedChars = -1;
  }

  return {
    delivered,
    omitted,
    failed,
    serializedChars,
    ...(failed.length > 0
      ? {
          recover:
            `${failed.length} claim-context leg(s) FAILED and their context is missing from this claim: ` +
            `${failed.join(', ')}. This is a broken read, not an empty one — the claim was not degraded on ` +
            `purpose. Re-run the claim to retry, and treat any conclusion that depended on the missing leg ` +
            `(prior attempts, governing decisions, behavior contract) as UNVERIFIED rather than absent.`,
        }
      : {}),
  };
}
