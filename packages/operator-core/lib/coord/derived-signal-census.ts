/**
 * THE DEAD-DERIVED-SIGNAL CENSUS — the runtime half of the detector D-088 asked
 * for (auto-coupling-delivery-and-correctness-2026-08-09 P-007).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * The agent-state plane already ships three probes and NONE of them can see a
 * dead DERIVED signal:
 *
 *   · check-plane-producers.mjs   — is the FIELD written?      (a DB column fact)
 *   · check-declared-consumed.mjs — is the field READ in source? (a static fact)
 *   · check-plane-adoption.mjs    — does an AGENT ever call it? (a call count)
 *
 * A derived coupling relation has no column (so the census is blind to it), is
 * plainly read in source (so the sweep is green), and its enclosing TOOL does get
 * called (so the adoption probe is green) — while the relation itself emits
 * nothing, ever. Three green ticks over a dead signal.
 *
 * That is not hypothetical; it has now happened TWICE to the same dimension of
 * this same feature, and both times a human found it by hand-querying live data:
 *
 *   · `current_files` — a real roster field, 119 live rows, ZERO populated
 *     (EI-18772330418885814). The `shared-file` relation reads a field nothing
 *     writes.
 *   · `holds-a-lock-on` — introduced specifically to REPLACE that dead signal,
 *     and just as dead for a different reason: it silently inherited an unrelated
 *     flag's gate, so its input leg required `include_coupling` AND
 *     `include_detail`, a combination passed ZERO times in the entire retained
 *     history. Shipped, tested, documented, and silent for 12 days (D-088).
 *
 * Every unit test passed throughout, both times, because the fixtures supply the
 * input directly — which is exactly the blind spot: a test proves the derivation
 * is CORRECT GIVEN INPUT and can say nothing about whether production ever hands
 * it any.
 *
 * ── THE LOAD-BEARING DISTINCTION: `armed` IS NOT `emitted` ───────────────────
 *
 * A bare firing count cannot tell these two apart, and they have opposite
 * remedies:
 *
 *   · the leg was never WIRED into the call     → a dead gate. A code defect.
 *                                                 (`holds-a-lock-on`'s shape)
 *   · the leg was wired, ran, and had nothing   → honest scarcity, or a dead
 *     to work with                                UPSTREAM producer.
 *                                                 (`current_files`'s shape)
 *
 * So the census records both, per relation, per run: whether the input was
 * SUPPLIED (`armed`), how much input it delivered (`inputs`), and how many edges
 * actually reached the caller (`edges`). `scripts/check-derived-signal-firings.mjs`
 * turns a window of these into the verdict.
 *
 * ── WHY IT SHIPS ON `tool_invocations.metadata_json` ────────────────────────
 *
 * Deliberately no new table, no migration and no new write path: the per-call
 * structured metadata channel already exists, is heavily used (75k+ rows carrying
 * it in three days, measured 2026-08-09), and already carries retention,
 * indexing and workspace scoping. A dead-signal detector that needed a whole new
 * durable surface of its own would be the reuse-first smell this repo's own guide
 * names — and a new surface nobody writes to is the very failure being detected.
 */
import { DERIVED_COUPLING_RELATIONS, type DerivedCoupling, type DerivedCouplingRelation } from './couplings';

/**
 * Schema tag on the emitted record, so a reader can tell a census apart from any
 * other metadata and a future shape change is detectable rather than silent.
 *
 * ⚠ BUMP THIS WHEN A FIELD'S MEANING CHANGES, not only when a field is added or
 * removed. A rename reds something; a redefinition reds nothing, which is exactly
 * why it is the case this tag has to catch.
 *
 * v2 (2026-08-11, coupling-signal-liveness-and-lifecycle-2026-08-11 P-001/P-007):
 * `inputs` changed from the CANDIDATE POOL a leg would have examined to the
 * BINDING input that actually decides whether it can emit. Same field, same type,
 * opposite reading of the same run — a short-circuited derivation reported ~1023
 * under v1 and reports 0 under v2. Nothing about a v1 row's SHAPE reveals that, so
 * a window spanning the change silently averages two different measurements, and
 * `check-derived-signal-firings.mjs` derives `starved` vs `armed-silent` from
 * precisely this field. The probe therefore judges rows AT THE CURRENT VERSION
 * ONLY (its `CENSUS_VERSION` must equal this) and reports older rows as excluded
 * rather than folding them in.
 *
 * This bump is also what makes "re-read the census under the corrected instrument"
 * (WI-38032) an executable instruction instead of an inference from deploy times:
 * the corrected window is `v = 2`, readable straight off the row.
 */
export const DERIVED_SIGNAL_CENSUS_VERSION = 2;

/** The key this census is published under inside `tool_invocations.metadata_json`. */
export const DERIVED_SIGNAL_CENSUS_KEY = 'derivedSignals';

/** The INPUTS the derivation computes its relations from. */
export type DerivedSignalLeg =
  | 'roster'
  | 'heldFiles'
  | 'planEdges'
  | 'recentPartners'
  | 'obligations';

/**
 * Which input each derived relation is computed FROM.
 *
 * ⚠ THIS IS A RECURRENCE GUARD, not a lookup table. `satisfies Record<
 * DerivedCouplingRelation, …>` makes it a TYPE ERROR to add a relation to
 * `DERIVED_COUPLING_RELATIONS` without declaring the input it depends on — so a
 * new derived signal cannot be born unobservable, which is the condition that
 * produced both incidents above.
 */
export const DERIVED_SIGNAL_LEGS = {
  'holds-a-lock-on': 'heldFiles',
  awaits: 'roster',
  'blocks-me': 'planEdges',
  'blocked-by-me': 'planEdges',
  'coord-exchange': 'recentPartners',
  // Both directions read the SAME leg: an obligation is one stored pairwise fact, and
  // which side of it you are on is a property of that fact, not a separate input. Same
  // shape as `blocks-me`/`blocked-by-me` over `planEdges` — and it matters for the
  // verdict, because a starved `obligations` leg must report BOTH directions as starved
  // rather than leaving one looking independently healthy.
  'owes-me': 'obligations',
  'i-owe': 'obligations',
} as const satisfies Record<DerivedCouplingRelation, DerivedSignalLeg>;

/** What one input leg did on one run. */
export interface DerivedSignalLegState {
  /**
   * The input was SUPPLIED to this call at all — i.e. the gate that decides
   * whether the signal can fire was reachable. This is the bit that was silently
   * `false` on every production call for 12 days (D-088).
   */
  armed: boolean;
  /** How many input rows the leg actually delivered (0 is meaningful, not absent). */
  inputs: number;
}

/** One relation's observation on one run. */
export interface DerivedSignalObservation {
  armed: boolean;
  inputs: number;
  /** Edges that actually REACHED the caller — post-filter, never the raw emit. */
  edges: number;
}

export interface DerivedSignalCensus {
  v: number;
  relations: Record<string, DerivedSignalObservation>;
  /**
   * P-010: relations crowding out the rest with no explicit ruling. Present ONLY when
   * violated — its absence means "checked and clean", never "not checked", because
   * `censusDerivedSignals` evaluates it on every run. Optional so the field costs nothing
   * on the hot metadata path in the common case.
   */
  concentration?: RelationConcentrationViolation[];
}

function countEdgesByRelation(emitted: readonly DerivedCoupling[]): Map<string, number> {
  const byRelation = new Map<string, number>();
  for (const edge of emitted) {
    const relation = edge?.relation;
    if (typeof relation !== 'string' || !relation) continue;
    byRelation.set(relation, (byRelation.get(relation) ?? 0) + 1);
  }
  return byRelation;
}

/**
 * Census one derivation run. PURE (legs + emitted edges -> record), so every
 * branch is testable with no database and no presence snapshot.
 *
 * ⚠ `emitted` MUST be the FILTERED result — the edges that actually reach the
 * caller — never the pre-filter union. An edge dropped by the roster access
 * boundary was never delivered to anybody, and counting it as a firing would
 * report a signal as alive on the strength of output nobody received.
 *
 * EVERY relation appears in the output, including the ones at zero. A census that
 * omitted its zeros would be unable to report the only thing it exists to report.
 */
export function censusDerivedSignals(
  legs: Readonly<Record<DerivedSignalLeg, DerivedSignalLegState>>,
  emitted: readonly DerivedCoupling[],
): DerivedSignalCensus {
  const byRelation = countEdgesByRelation(emitted);
  const relations: Record<string, DerivedSignalObservation> = {};
  for (const relation of DERIVED_COUPLING_RELATIONS) {
    const leg = legs[DERIVED_SIGNAL_LEGS[relation]];
    relations[relation] = {
      armed: leg?.armed === true,
      inputs: Number.isFinite(leg?.inputs) ? Math.max(0, Math.trunc(leg!.inputs)) : 0,
      edges: byRelation.get(relation) ?? 0,
    };
  }
  const base: DerivedSignalCensus = { v: DERIVED_SIGNAL_CENSUS_VERSION, relations };
  // P-010. Evaluated HERE, on every censused run, and attached to the record that already
  // reaches `tool_invocations.metadata_json` — because a guard nobody calls is the exact
  // "born unobservable" condition this module exists to detect, and shipping one as the
  // fix for that condition would be self-defeating. Present ONLY when violated, so the
  // common case adds no bytes to a hot metadata path and a reader can treat the key's
  // presence as the alarm.
  const concentration = relationConcentrationViolations(base);
  return concentration.length > 0 ? { ...base, concentration } : base;
}

/**
 * Build the `observe` sink for one tool invocation — the ONE place that knows how
 * a census reaches `tool_invocations.metadata_json`.
 *
 * Returns `undefined` when the ctx carries no metadata channel, so every call
 * site spreads it conditionally (`...(obs ? { observe: obs } : {})`) and a
 * non-tool caller — a test, a script, an internal re-use — wires nothing rather
 * than throwing.
 *
 * ⚠ EXISTS BECAUSE THE CAST IS THE DANGEROUS PART, NOT THE CALL. `ctx.metadata`
 * is `overwrite-not-merge, last write wins` (dispatch-stack.ts:550-552): the
 * accumulator is REPLACED by each call, never merged into. Two consequences that
 * a per-call-site inline cast quietly re-invites every time it is copied:
 *
 *   1. A tool that emits a census AND calls `ctx.metadata()` anywhere else keeps
 *      only whichever ran LAST. The census dies silently — no error, no row —
 *      which is indistinguishable from the dead signal it was built to detect.
 *      `coord:presence` is safe today only because it happens to have exactly one
 *      metadata call; adding a second would have killed the census with nothing
 *      failing. That is the same "born unobservable" condition D-088 records.
 *   2. On a BULK path (`coord:send` sends N messages per invocation) the sink
 *      fires once per message and the LAST census wins. That is acceptable and
 *      deliberate — the sender's roster and legs are identical across a bulk's
 *      messages, so the surviving record is representative rather than partial —
 *      but it is a sample, so never read a census count as a message count.
 *
 * Centralised so that if the substrate ever gains merge semantics, or the census
 * needs to compose with other metadata, exactly one function changes instead of
 * every wiring site being re-audited.
 */
/**
 * Share of all emitted edges above which ONE relation is presumed to be crowding the
 * others out, absent an explicit ruling.
 *
 * Measured on the live firings ledger (`tool_invocations.metadata_json.derivedSignals`,
 * workspace papercusp-workspace, 7 days, 17,422 censused invocations):
 *
 *   coord-exchange 28,356 (92.1%) · awaits 2,316 (7.5%) · holds-a-lock-on 93 (0.3%)
 *   blocks-me 13 (0.0%) · blocked-by-me 2 (0.0%)
 *
 * 0.75 sits below the 92.1% that must FAIL and above the largest share a healthy mix has
 * shown, so the guard fires on the real pre-fix distribution rather than on a hypothetical.
 */
export const RELATION_CONCENTRATION_THRESHOLD = 0.75;

/**
 * An explicit acknowledgement that one relation legitimately dominates.
 *
 * ⚠ THE RULING ESCAPE HATCH IS THE DESIGN, NOT A LOOPHOLE — and it is what keeps this
 * guard from being disabled six weeks from now. Concentration has two causes that look
 * identical in the numbers: the other relations are BROKEN (the condition this exists to
 * catch — `blocks-me` + `blocked-by-me` together produced 15 edges in a week because they
 * read a table agents rarely write), or one relation legitimately has enormous fan-out
 * (a fleet leader supervising 234 members produces 234 supervision edges from one read,
 * and every one of them is true). A bare threshold cannot tell those apart, so it would
 * fire constantly on the healthy case and be silenced — taking the unhealthy case with it.
 * Requiring a stated REASON forces the distinction to be made by someone, once, in writing.
 */
export interface RelationConcentrationRuling {
  relation: string;
  /** WHY this relation is expected to dominate. A ruling with no reason is not a ruling. */
  reason: string;
}

/** One relation crowding out the rest with no ruling to justify it. */
export interface RelationConcentrationViolation {
  relation: string;
  edges: number;
  totalEdges: number;
  /** 0..1 share of all emitted edges. */
  share: number;
}

/**
 * Relations whose share of emitted edges exceeds the threshold with no explicit ruling
 * (P-010 recurrence guard).
 *
 * PURE over a census, so its falsifiability is provable without a database: the tests feed
 * it the REAL measured 92.1% distribution and require a violation, rather than asserting
 * against a shape invented to pass.
 *
 * Returns `[]` when no edges were emitted at all — a run that produced nothing is not a
 * concentrated run, and reporting 0/0 as 100% would make every idle census a violation.
 */
export function relationConcentrationViolations(
  census: DerivedSignalCensus,
  rulings: readonly RelationConcentrationRuling[] = [],
): RelationConcentrationViolation[] {
  const relations = census?.relations ?? {};
  const ruled = new Set(
    rulings.filter((r) => r?.relation && (r.reason ?? '').trim()).map((r) => r.relation),
  );
  let totalEdges = 0;
  for (const obs of Object.values(relations)) {
    const n = obs?.edges;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) totalEdges += n;
  }
  if (totalEdges <= 0) return [];
  const out: RelationConcentrationViolation[] = [];
  for (const [relation, obs] of Object.entries(relations)) {
    const edges = obs?.edges;
    if (typeof edges !== 'number' || !Number.isFinite(edges) || edges <= 0) continue;
    if (ruled.has(relation)) continue;
    const share = edges / totalEdges;
    if (share > RELATION_CONCENTRATION_THRESHOLD) {
      out.push({ relation, edges, totalEdges, share });
    }
  }
  return out.sort((a, b) => b.share - a.share);
}

export function censusObserverFor(ctx: unknown): ((census: DerivedSignalCensus) => void) | undefined {
  const emit = (ctx as { metadata?: (d: Record<string, unknown>) => void } | null | undefined)?.metadata;
  if (typeof emit !== 'function') return undefined;
  return (census: DerivedSignalCensus) => {
    // Fail-soft, like every other leg of the derivation: an observer that can
    // break what it observes is worse than no observer (coupling-derivation.ts).
    try {
      emit({ [DERIVED_SIGNAL_CENSUS_KEY]: census });
    } catch {
      /* the census is an instrument; it must never fail the tool it measures */
    }
  };
}
