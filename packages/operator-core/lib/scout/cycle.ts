/**
 * Scout loop — the end-to-end cycle composition (hive-creative-ideation-2026-06-08, the P-003…P-007 seam).
 *
 * `runScoutCycle` is the single entrypoint that wires the five Scout steps into
 * one autonomous, prompt-free pass:
 *
 *   corpus synthesis (P-003) → divergent generation (P-004) → adversarial
 *   critics (P-005) → debate + recombine (P-006) → routing (P-007).
 *
 * It is **pure orchestration over injected ports** — it owns no step's logic and
 * converges on the swarm's canonical contracts (`./types`, ce4bd's
 * {@link RoutingDecision} + {@link decisionsToProvenance}, su-80be9's
 * {@link RoutedIdeaProvenance}) rather than forking parallel types. So:
 *  - it unit-tests with fakes + `./test-support` (no network, $0, deterministic);
 *  - it couples to no peer's *implementation*, only their published contracts;
 *  - it is the entrypoint the verification lane drives (su-b6c3f P-014 / su-e8630
 *    P-009, contract invariant 7) and the cadence/budget layer wraps (su-80be9
 *    P-008: `tick → shouldRunScoutCycle → budget gate → runScoutCycle → routed`).
 *
 * Design rules carried from the plan's ratified decisions:
 *  - **Injected LLM (D-004 / gym:judge pattern):** every step takes the same
 *    {@link ScoutLlmCall}; the cycle wraps it in a recorder so spend + the
 *    "no human-authored prompt entered the loop" invariant (D-010) read from
 *    one place ({@link ScoutCycleResult.calls}).
 *  - **Survivors (D-005):** `keep` + `moonshot` proceed, `reject` is dropped (the
 *    recombine port re-filters internally; the cycle also surfaces `survivors`
 *    for observability + a no-survivors short-circuit, and the two agree).
 *  - **Per-cycle budget (D-010, softened by EI-10779):** `limits.maxCostUsd` is a
 *    SOFT cap. A zero/negative cap refuses to spend at all (halts before the first
 *    costed step); but once generation has been PAID FOR, the cap NEVER discards it
 *    — the cycle always finishes routing what it generated (routing is ~$0, the
 *    cheapest stage must never be the one skipped) and flags the result
 *    `overBudget` for observability. It is a belt to su-80be9's pre-fire
 *    budget-gate suspenders, not a mid-flight kill that destroys sunk cost.
 *
 * PROVENANCE (P-013, D-009): a {@link Proposal} *fuses* multiple source ideas
 * (`sourceIdeaIds[]`), and the creative `lens` lives on {@link Idea}. The router
 * dispatches once per proposal (ce4bd's `routeProposals` is per-proposal) and the
 * cycle expands each routed decision to per-idea lens provenance via ce4bd's
 * {@link decisionsToProvenance}, supplying a lens resolver over its own ideas —
 * the canonical rows su-80be9's `recordRoutedIdea` ledger persists.
 */
import type { CorpusDigest, Idea, Proposal, ScoredIdea, ScoutLlmCall } from './types';
import type { CorpusEntry } from './critique-core';
import type { RoutingDecision } from './router';
import type { RoutedIdeaProvenance } from './outcome-feedback';
import { flattenDigest } from './lenses';

/* ────────────────────────────────────────────────────────────────────────
 * Budget + observability
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Per-cycle limits (D-010). su-80be9's P-008 budget layer constructs these from
 * its per-cycle cap; the cycle reports actual spend back in
 * {@link ScoutCycleResult.costUsd} so the next-cycle decision reads real cost.
 */
export interface ScoutCycleLimits {
  /** Cap the ideator roster size (passed to the ideate port). */
  maxIdeators?: number;
  /**
   * SOFT per-cycle spend cap (USD). A zero/negative cap halts BEFORE the first
   * costed step (no spend at all, EI-305). A POSITIVE cap does NOT abort the cycle
   * mid-flight once generation is paid for — the cycle finishes routing what it
   * generated and flags {@link ScoutCycleResult.overBudget} instead of discarding
   * the paid-for output (EI-10779: killing the pipeline after generation but before
   * the ~$0 route stage is pure sunk-cost destruction).
   */
  maxCostUsd?: number;
}

/** The LLM-spending steps (also the `ScoutCallRecord.step` tags). Routing spends no LLM. */
export type ScoutStep = 'ideate' | 'critique' | 'recombine';

/** The full cycle phases surfaced to the scheduler for timeout diagnostics. */
export type ScoutCyclePhase =
  | 'runner-bootstrap'
  | 'gateway-env'
  | 'llm-client-import'
  | 'resolve-archive'
  | 'build-cycle-deps'
  | 'run-cycle'
  | 'read-corpus'
  | 'ideate'
  | 'read-novelty-corpus'
  | 'critique'
  | 'recombine'
  | 'route';

/**
 * A recorded LLM invocation — the single place the no-human-prompt invariant
 * (D-010) and cost accounting read from. The cycle wraps the injected
 * {@link ScoutLlmCall} so every step's call lands here regardless of which peer
 * built the step.
 */
export interface ScoutCallRecord {
  /** Which step issued the call (provenance for the audit). */
  step: ScoutStep;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  responseFormat?: 'text' | 'json';
  costUsd: number;
}

/* ────────────────────────────────────────────────────────────────────────
 * Ports — one per Scout step, injected so the cycle owns no step's logic.
 * ──────────────────────────────────────────────────────────────────────── */

/** Options every LLM-touching port receives (the recorder-wrapped call). */
export interface ScoutStepCtx {
  llmCall: ScoutLlmCall;
  /**
   * WI-4475 — absolute epoch-ms deadline of the owning cycle, when the scheduler imposed one.
   * A port that wants to reserve part of the remaining budget (the ideator holds room back for
   * GENERATION, so queue-wait can't eat it) derives its own admission cap from this. Ports that
   * ignore it still get a deadline-derived bound automatically from the cycle's `recordingLlm`
   * wrapper — this is the opt-in for a port that needs a *more precise* one.
   */
  deadlineMs?: number;
}

export interface ScoutCyclePorts {
  /** P-003 (su-7a8ee): synthesize the "state of the Hive" digest (the grounded substrate). */
  readCorpus: () => Promise<CorpusDigest>;
  /** Search-first novelty corpus for the critics (prior plans/decisions/ideas/dropped-improvements). */
  readNoveltyCorpus: () => Promise<CorpusEntry[]>;
  /** P-004 (su-797a5): divergent generation → grounded ideas. `maxIdeators` clamps the roster (budget). */
  ideate: (digest: CorpusDigest, ctx: ScoutStepCtx & { maxIdeators?: number }) => Promise<Idea[]>;
  /** P-005 (su-d1170): adversarial novelty (search-first vs `corpus`) + feasibility critics → scored ideas. */
  critique: (ideas: Idea[], ctx: ScoutStepCtx & { corpus: CorpusEntry[] }) => Promise<ScoredIdea[]>;
  /** P-006 (su-d1170): debate + recombine survivors → proposals (the port filters verdict≠reject internally). */
  recombine: (scored: ScoredIdea[], ctx: ScoutStepCtx) => Promise<Proposal[]>;
  /** P-007 (su-ce4bd): route + dispatch each proposal once → per-proposal decisions (with `routedRef`). */
  route: (proposals: Proposal[]) => Promise<RoutingDecision[]>;
}

export interface ScoutCycleDeps extends ScoutCyclePorts {
  /** The injected LLM call (the gym:judge pattern; faked in tests). */
  llmCall: ScoutLlmCall;
  /** Optional per-cycle limits (D-010). */
  limits?: ScoutCycleLimits;
  /** Opaque cycle id for provenance/audit (su-80be9 stamps the ledger with it). */
  cycleId?: string;
  /** Best-effort phase reporter used by the scheduler's timeout/error diagnostics. */
  onPhase?: (phase: ScoutCyclePhase) => void;
  /**
   * WI-4475 — absolute epoch-ms deadline the scheduler will kill this cycle at. Every LLM call
   * the cycle makes gets its governor ADMISSION wait bounded by the time left on it (see
   * `recordingLlm`), so an inner wait can never equal or outlive the cycle that owns it.
   * Absent ⇒ no bound imposed (host default), i.e. pre-WI-4475 behavior.
   */
  deadlineMs?: number;
}

/**
 * Why the cycle stopped — `completed` is the full pass; the rest are early exits.
 * `budget-exhausted` is a PRE-SPEND refusal only (a zero/negative cap halts before
 * the first costed step); a cycle that overruns a POSITIVE cap after generation is
 * NOT budget-exhausted — it completes and routes, flagged `overBudget` (EI-10779).
 */
export type ScoutCycleStop =
  | 'completed'
  | 'empty-digest'
  | 'no-ideas'
  | 'no-survivors'
  | 'no-proposals'
  | 'budget-exhausted';

/**
 * EI-303: a digest with zero meta-patterns in every lane is an empty substrate —
 * nothing exists to ground an idea in, so running the ideator roster over it is
 * pure spend (a fresh/quiet hive paid the full 4-lens roster just to exit
 * 'no-ideas'). `headline`/`generatedAt` don't count; only patterns ground ideas.
 *
 * DRIFT FIX (blender-self-learning-2026-07-12 P-013): "every lane" must mean EVERY
 * grounding lane, not the four free-text lanes this check hardcoded at EI-303 time.
 * Since then `rubricRatings`, `reverts`, `standingFacts`, `nicheMap`, and the P-008/
 * P-009/P-010 signal lanes were added, and each grounds ideas (they're in
 * `flattenDigest` — the canonical valid-ref set an idea cites). Hardcoding four lanes
 * silently UNDERCOUNTED: a digest whose ONLY signal is a MEASURED rubric regression —
 * exactly the case P-004 rubric-seeding exists to ideate on, and exactly what a drill
 * injects — read as "empty" and short-circuited before the seeded slot ever ran. Reuse
 * `flattenDigest` (the single source of truth for "what grounds an idea", the same set
 * `digestRefSet`/invariants ride) so this can never drift from the grounding set again.
 */
export function digestIsEmpty(digest: CorpusDigest): boolean {
  return flattenDigest(digest).length === 0;
}

/**
 * The full result of one Scout cycle. Carries every intermediate stage so the
 * P-009 invariants suite can assert at each boundary (grounded / forced-diversity
 * / non-duplicate / bettable) and P-014 can assert the full-cycle outcome.
 * Superset of contract invariant 7's `{ digest, ideas, proposals, routed }`.
 */
export interface ScoutCycleResult {
  cycleId?: string;
  digest: CorpusDigest;
  ideas: Idea[];
  /** Every idea after the critics (P-005). */
  scored: ScoredIdea[];
  /** keep + moonshot (reject dropped) — the proposals' source pool (D-005). */
  survivors: ScoredIdea[];
  proposals: Proposal[];
  /** Per-proposal routing decisions (ce4bd's canonical shape, with `routedRef`). */
  routed: RoutingDecision[];
  /** Per-idea lens provenance for P-013 (ce4bd's `decisionsToProvenance` over the cycle's ideas). */
  provenance: RoutedIdeaProvenance[];
  /** Every LLM call the cycle issued, in order (no-human-prompt + cost). */
  calls: ScoutCallRecord[];
  /** Total LLM spend this cycle (sum of `calls[].costUsd`). */
  costUsd: number;
  /**
   * True when spend exceeded a POSITIVE `limits.maxCostUsd`. The cycle no longer
   * discards paid-for generation on an overrun (EI-10779) — it routes what it
   * generated and raises this flag so the tick ledger can still surface the overrun
   * for cadence/roster tuning. (A zero/negative-cap pre-spend refusal spends $0, so
   * it reports `overBudget: false` — it did not overrun, it declined to start.)
   */
  overBudget: boolean;
  /** Why the cycle ended. */
  stop: ScoutCycleStop;
}

/* ────────────────────────────────────────────────────────────────────────
 * The composition
 * ──────────────────────────────────────────────────────────────────────── */

/** keep + moonshot survive (D-005); reject is pruned. */
export function selectSurvivors(scored: ScoredIdea[]): ScoredIdea[] {
  return scored.filter((s) => s.verdict !== 'reject');
}

/**
 * Expand the per-proposal routing decisions into per-idea lens provenance rows
 * (P-013 / D-009) — the canonical {@link RoutedIdeaProvenance} su-80be9's
 * `recordRoutedIdea` ledger persists. A {@link Proposal} fuses several ideas, so
 * EVERY contributing lens earns attribution for the routed artifact's outcome.
 * Decisions that never dispatched (`routedRef` unset) and source ideas whose lens
 * can't be resolved are skipped — there is nothing to attribute. The cycle owns
 * this expansion because it (not the router) holds the ideas → lens mapping.
 */
export function deriveProvenance(
  routed: readonly RoutingDecision[],
  ideas: readonly Idea[],
  cycleId?: string,
): RoutedIdeaProvenance[] {
  const ideaById = new Map(ideas.map((i) => [i.id, i]));
  const out: RoutedIdeaProvenance[] = [];
  for (const d of routed) {
    if (!d.routedRef) continue;
    // Defensive: a decision missing sourceIdeaIds (an incomplete edge/mock path —
    // the real router always sets it, router.ts) yields no attribution rather than
    // crashing the whole cycle (matches the skip-non-attributable philosophy below).
    for (const ideaId of d.sourceIdeaIds ?? []) {
      const carried = d.sourceIdeaProvenance?.find((source) => source.id === ideaId);
      const idea = ideaById.get(ideaId) ?? carried;
      if (!idea) continue;
      const seededByTags = (d.seededByRefs ?? []).map((ref) => `seededBy:${ref}`);
      const addressesPatternRefs = [
        ...new Set([...(idea.addressesPatternRefs ?? []), ...(d.addressesPatternRefs ?? []), ...seededByTags]),
      ];
      out.push({
        ideaId,
        lens: idea.lens,
        rail: d.rail,
        routedRef: d.routedRef,
        ...(cycleId ? { cycleId } : {}),
        ...(d.title ? { title: d.title } : {}),
        ...(addressesPatternRefs.length > 0 ? { addressesPatternRefs } : {}),
      });
    }
  }
  return out;
}

/**
 * Run one full Scout cycle. Prompt-free: the only input is `deps` (an injected
 * LLM call + step ports); there is NO human-input parameter and the cycle never
 * prompts a human — autonomy is structural (D-010). Returns the digest, the
 * ideas, the scored ideas + survivors, the proposals, the routing decisions, the
 * per-idea provenance, and the recorded spend.
 */
export async function runScoutCycle(deps: ScoutCycleDeps): Promise<ScoutCycleResult> {
  const calls: ScoutCallRecord[] = [];
  let currentStep: ScoutStep = 'ideate';
  const markPhase = (phase: ScoutCyclePhase): void => {
    deps.onPhase?.(phase);
  };

  // Wrap the injected call so every step's LLM use is recorded once (cost +
  // the no-human-prompt invariant), tagged with the step that issued it.
  //
  // WI-4475 — this wrapper is also where the cycle's DEADLINE becomes every call's ADMISSION
  // bound. `llmCall` blocks in the shared rate-limit governor waiting for a permit before it
  // issues a request; with no bound, that inner wait defaults to 600s — which EQUALS the whole
  // @singleton cycle budget. So a single call queued behind a rate-limit pause could consume
  // the entire cycle and kill it ("Scout cycle timed out after 600000ms during phase
  // route|critique|recombine"). Bounding admission HERE means no port can forget to: ideate,
  // critique and recombine all inherit it. A caller that computed a more precise budget of its
  // own (the ideator reserves room for generation) keeps it — we only fill the gap.
  const admissionBudgetMs = (): number | undefined => {
    if (deps.deadlineMs === undefined || !Number.isFinite(deps.deadlineMs)) return undefined;
    return Math.max(0, deps.deadlineMs - Date.now());
  };
  // WI-5391: how much of the cycle budget is reserved for CONCLUDING after the last
  // retry bails — the phase must still return, the tick classify + persist. 10s is
  // generous for bookkeeping while costing <2% of the default 600s cycle budget.
  const RETRY_LADDER_DEADLINE_MARGIN_MS = 10_000;
  const recordingLlm: ScoutLlmCall = async (opts) => {
    const budget = opts.governorMaxWaitMs ?? admissionBudgetMs();
    // WI-5391: bound the transport's transient-RETRY ladder by the cycle deadline too.
    // governorMaxWaitMs caps one admission wait, but the ladder (8 attempts + backoff)
    // was deadline-blind — under a mid-cycle pool pause it outlived the cycle's 600s
    // timer, which then recorded "Scout cycle timed out during phase ideate" (a hard
    // error tick) instead of the honest, capacity-classifiable 429/529. The margin keeps
    // the true error arriving while the phase can still conclude and the tick record it.
    const retryDeadline =
      opts.retryDeadlineMs ??
      (deps.deadlineMs !== undefined && Number.isFinite(deps.deadlineMs)
        ? deps.deadlineMs - RETRY_LADDER_DEADLINE_MARGIN_MS
        : undefined);
    const result = await deps.llmCall({
      ...opts,
      ...(budget !== undefined ? { governorMaxWaitMs: budget } : {}),
      ...(retryDeadline !== undefined ? { retryDeadlineMs: retryDeadline } : {}),
    });
    calls.push({
      step: currentStep,
      system: opts.system,
      messages: opts.messages,
      responseFormat: opts.responseFormat,
      costUsd: result.costUsd,
    });
    return result;
  };

  const spent = () => calls.reduce((sum, c) => sum + c.costUsd, 0);
  const overBudget = () => {
    const cap = deps.limits?.maxCostUsd;
    return cap != null && spent() > cap;
  };

  // D-010 continuation is cost-free and higher priority than fresh ideation.
  // Drain it before ANY early-exit branch so an answered consult cannot remain
  // stranded merely because this cycle's digest/ideator/recombine output is empty.
  // buildScoutCycleDeps makes this the only continuation read per deps instance;
  // the ordinary route call later handles current proposals without replaying it.
  markPhase('route');
  const resumedRouted = await deps.route([]);
  const resumedProvenance = deriveProvenance(resumedRouted, [], deps.cycleId);

  const finish = (
    stop: ScoutCycleStop,
    partial: {
      digest: CorpusDigest;
      ideas?: Idea[];
      scored?: ScoredIdea[];
      survivors?: ScoredIdea[];
      proposals?: Proposal[];
      routed?: RoutingDecision[];
      provenance?: RoutedIdeaProvenance[];
    },
  ): ScoutCycleResult => ({
    cycleId: deps.cycleId,
    digest: partial.digest,
    ideas: partial.ideas ?? [],
    scored: partial.scored ?? [],
    survivors: partial.survivors ?? [],
    proposals: partial.proposals ?? [],
    routed: [...resumedRouted, ...(partial.routed ?? [])],
    provenance: [...resumedProvenance, ...(partial.provenance ?? [])],
    calls,
    costUsd: spent(),
    overBudget: overBudget(),
    stop,
  });

  // 1. Corpus synthesis (P-003) — the grounded substrate. No LLM cost attributed
  //    to the cycle (the digest reader owns its own budget upstream).
  markPhase('read-corpus');
  const digest = await deps.readCorpus();

  // EI-305: a zero cap means NO spend — halt before the first costed step.
  // (The between-steps gate below uses strict `spent > cap`, which a
  // 0-spent/0-cap start would pass.)
  if (deps.limits?.maxCostUsd != null && deps.limits.maxCostUsd <= 0) {
    return finish('budget-exhausted', { digest });
  }

  // EI-303: an empty (fresh/quiet-hive) digest grounds nothing — exit before
  // paying the ideator roster.
  if (digestIsEmpty(digest)) {
    return finish('empty-digest', { digest });
  }

  // 2. Divergent generation (P-004).
  markPhase('ideate');
  currentStep = 'ideate';
  const ideas = await deps.ideate(digest, {
    llmCall: recordingLlm,
    maxIdeators: deps.limits?.maxIdeators,
    // WI-4475: the ideator reserves room for GENERATION out of the remaining budget, so it
    // needs the raw deadline rather than the wrapper's whole-remaining default.
    ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
  });
  if (ideas.length === 0) return finish('no-ideas', { digest, ideas });
  // EI-10779: generation is now PAID FOR — do NOT discard it on a budget overrun.
  // The old between-stage `budget-exhausted` exit here killed the pipeline right
  // after paying for the (dominant-cost) ideate stage but BEFORE routing, destroying
  // the entire generation for routed=0 (measured: ~$3.6 burned per tick under a $1
  // cap, ideas_routed=0). We instead continue: critique/recombine are the cheaper
  // stages and routing is ~$0, so completing the pipeline to route what we already
  // paid to generate is strictly better than throwing it away. The overrun is not
  // lost — `overBudget` is flagged on the result (the cap is a soft ceiling, not a
  // mid-flight kill). Pre-flight feasibility + mid-stage bounding (the other two
  // flaws in EI-10779) are a follow-up; the sunk-cost destruction is the harm here.

  // 3. Adversarial critics (P-005) — search-first novelty vs the corpus + feasibility.
  markPhase('read-novelty-corpus');
  currentStep = 'critique';
  const corpus = await deps.readNoveltyCorpus();
  markPhase('critique');
  const scored = await deps.critique(ideas, { llmCall: recordingLlm, corpus });
  const survivors = selectSurvivors(scored);
  if (survivors.length === 0) return finish('no-survivors', { digest, ideas, scored, survivors });
  // EI-10779: same salvage rule — a budget overrun here never discards the paid-for
  // survivors; the cycle proceeds to recombine + route (see the note after ideate).

  // 4. Debate + recombine survivors → proposals (P-006). The port re-filters
  //    verdict≠reject internally (su-d1170's recombineProposals), so passing all
  //    `scored` is safe + matches its published wiring.
  markPhase('recombine');
  currentStep = 'recombine';
  const proposals = await deps.recombine(scored, { llmCall: recordingLlm });
  if (proposals.length === 0) {
    return finish('no-proposals', { digest, ideas, scored, survivors, proposals });
  }

  // 5. Route + dispatch each proposal once (P-007); expand to per-idea lens
  //    provenance (P-013) over our ideas (the cycle holds the idea→lens map).
  markPhase('route');
  const routed = await deps.route(proposals);
  const provenance = deriveProvenance(routed, ideas, deps.cycleId);

  return finish('completed', {
    digest,
    ideas,
    scored,
    survivors,
    proposals,
    routed,
    provenance,
  });
}
