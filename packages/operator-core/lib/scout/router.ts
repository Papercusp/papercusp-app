/**
 * router.ts — Scout loop routing (hive-creative-ideation-2026-06-08, P-007 / D-007).
 *
 * The Scout loop's hand-off: it takes the debate+recombine SURVIVORS (P-006
 * {@link Proposal}s) and routes each into exactly one of the Hive's three
 * EXISTING rails — "route into the existing rails; extend pillar 2, don't fork
 * the loop" (D-007):
 *
 *   • broad-scope    → a `plans:new` DRAFT plan      (owner/Queen-visible design surface)
 *   • testable-small → the gym quality-diversity rail (seedDistantNiches, P-012 / D-008)
 *   • concrete       → `improvements:capture`          (the self-improvement idea queue)
 *
 * It is the convergence seam of Phase 1: it CONSUMES su-d1170's P-006 `Proposal`
 * (which already carries a `routeHint` the recombine step computed with full idea
 * context — the router validates + dispatches it, and MAY override) and PRODUCES
 * the `{ ideaId, lens, rail, routedRef }` rows P-013 (`outcome-feedback`) reads
 * back to weight winning lenses (D-009). A recombined proposal fuses several
 * ideas, so provenance is expanded PER source idea — every contributing lens
 * gets attribution credit ({@link decisionsToProvenance}).
 *
 * Per the verification lane's invariant #5 (su-b6c3f) the module splits into:
 *   - a PURE decision spine ({@link classifyProposal} / {@link decideRoutes}) —
 *     zero IO, the part the tests pin hard; and
 *   - the side-effecting dispatch behind an INJECTED {@link RouterPorts} port
 *     (the gym:judge / corpus-digest-deps pattern), so {@link routeProposals}
 *     unit-tests with fakes — no PG, no LLM, no tool calls, no real writes.
 *
 * Provenance is not persisted here, but the per-idea EXPANSION primitive is:
 * {@link decisionsToProvenance} turns the lens-free decisions into P-013's
 * {@link RoutedIdeaProvenance} rows (one per source idea). The cycle (`cycle.ts`)
 * holds the ideas, so it calls it with a `lensOf` resolver over its own ideas;
 * su-80be9's scheduler then persists the result (`recordRoutedIdea` →
 * `harness_shared.scout_routed_ideas`). Production port wiring lives in
 * `router-deps.ts`.
 */

import type { CreativeLens, Proposal, ProposalConsultation, ProposalSourceIdeaProvenance } from './types';
import type { RoutedIdeaProvenance, RoutedRail } from './outcome-feedback';
import type { ScoutIdeaView, SeedDistantResult } from './gym-bridge';

/** Default rail for a proposal with no routeHint — the smallest-footprint, reversible
 *  rail. P-009 scout-config seam: a blueprint's `scout.routing.defaultRail` can override
 *  this per-hive (single source of truth, referenced by `scout/config.ts`). */
export const DEFAULT_ROUTING_RAIL: RoutedRail = 'improvement';

/* ────────────────────────────────────────────────────────────────────────
 * The routing decision (pure)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One routing decision (per proposal). `rail` + `reason` are decided purely;
 * `routedRef` is filled once {@link routeProposals} dispatches it (and stays
 * undefined when a dispatch fails — see `error`). `sourceIdeaIds` is carried so
 * P-013 can attribute the outcome to every lens that recombined into the proposal.
 */
export interface RoutingDecision {
  /** The proposal id (Proposal.id). */
  proposalId: string;
  /** The ideas that recombined into this proposal — P-013 attributes the outcome to each. */
  sourceIdeaIds: string[];
  /** The rail it routed to. */
  rail: RoutedRail;
  /** One line: why this rail (b6c3f invariant #5 — route + reason). */
  reason: string;
  /** False when the router overrode the proposal's `routeHint` (or there was none). */
  followedHint: boolean;
  /** One-line title (from the proposal framing), for the report drill-down. */
  title?: string;
  /** Corpus pattern refs the proposal targets — grounding + P-013 attribution (carried so
   *  the scheduler's `recordRoutedIdea` need not re-join to the proposal). */
  addressesPatternRefs?: string[];
  /** Federated mutation-seed lineage preserved for routed-ledger tagging. */
  seededByRefs?: string[];
  /** The change-feed ref of the created artifact: plan:<slug> | gym:<proposalId> | wi:<id>. */
  routedRef?: string;
  /** Dispatch error — defensive: one failed sink never aborts the batch. */
  error?: string;
  /** D-010 review disposition for goal creation/amendment. */
  consultation?: ProposalConsultation;
  /** A pending consult is a deliberate defer, not a failed dispatch. */
  deferred?: 'goal-consult';
  /** Lens snapshot used when an asynchronously reviewed proposal resumes later. */
  sourceIdeaProvenance?: ProposalSourceIdeaProvenance[];
}

export interface ClassifyOptions {
  /** Rail used when a proposal has no `routeHint`. Default 'improvement' (smallest footprint). */
  defaultRail?: RoutedRail;
  /**
   * Optional override hook: given a proposal, return a rail to FORCE (the router
   * overriding the recombine hint with richer signal — e.g. the cycle resolves
   * the source ideas' scope / moonshot bucket). Return undefined to defer to the
   * proposal's own `routeHint`. This is the "the router may override" seam.
   */
  override?: (p: Proposal) => RoutedRail | undefined;
  /**
   * Liveness gate for the gym rail (D-003, blender-loop-repair-2026-08-16 P-002 /
   * EI-20597534704604481): `false` reroutes every gym-bound proposal to the
   * improvement rail. The gym kept receiving ~14 ideas/day for 20 days after its
   * autoloop was disabled — outcomes froze, and 80.4% of all decided idea
   * outcomes became copies of 4 dead verdicts. The production caller resolves
   * this from `gym_autoloop_config.enabled`; default `true` (byte-identical
   * routing for callers that do not resolve it).
   */
  gymEnabled?: boolean;
  /**
   * Gate for the goal rail (P-013 / D-005): `false` reroutes every goal-bound
   * proposal to the PLAN rail — never dropped, so the idea still lands live on a
   * design surface (a goal-scale idea is multi-plan scope, so a draft plan is
   * its natural fallback). The production caller resolves this from the
   * `papercusp-blender-goal-rail` flag; default `true` (mirrors `gymEnabled`).
   */
  goalEnabled?: boolean;
  /**
   * Cap on goal dispatches per routing batch (default {@link DEFAULT_MAX_GOALS_PER_CYCLE}).
   * A goal dispatch CREATES AND STARTS a real goal — a headless GOAL-mode agent plus its
   * drain-fleet member — so a marker-vocabulary burst must not spawn five of them in one
   * cycle. Overflow decisions reroute to the plan rail (same never-drop principle as
   * `goalEnabled: false`), in input order.
   */
  maxGoalsPerCycle?: number;
}

/**
 * Decide the rail for ONE proposal (D-007). Pure + deterministic. The creative
 * judgment already happened upstream (critics P-005, debate/recombine P-006),
 * and recombine emits a `routeHint`; routing is the deterministic, dispatchable
 * decision over it, in priority order:
 *
 *   1. an explicit {@link ClassifyOptions.override} (the router overruling the
 *      hint with richer signal) — wins if it returns a rail;
 *   2. the proposal's own `routeHint` (recombine's recommendation);
 *   3. the {@link ClassifyOptions.defaultRail} (default 'improvement' — the
 *      smallest-footprint, reversible rail) when a proposal carries no hint.
 */
export function classifyProposal(
  p: Proposal,
  opts: ClassifyOptions = {},
): { rail: RoutedRail; reason: string; followedHint: boolean } {
  const forced = opts.override?.(p);
  if (forced) {
    return {
      rail: forced,
      reason:
        forced === p.routeHint
          ? `router confirmed routeHint → ${forced}`
          : `router override → ${forced}${p.routeHint ? ` (recombine hinted ${p.routeHint})` : ''}`,
      followedHint: forced === p.routeHint,
    };
  }
  if (p.routeHint) {
    return { rail: p.routeHint, reason: `followed recombine routeHint → ${p.routeHint}`, followedHint: true };
  }
  const def = opts.defaultRail ?? DEFAULT_ROUTING_RAIL;
  return {
    rail: def,
    reason: `no routeHint → default ${def} (smallest-footprint, reversible rail)`,
    followedHint: false,
  };
}

/**
 * Decide rails for a batch — the pure planning step (no IO, no `routedRef`).
 * Order-preserving so a caller can zip decisions back to proposals by index.
 */
export function decideRoutes(proposals: readonly Proposal[], opts: ClassifyOptions = {}): RoutingDecision[] {
  const maxGoals = opts.maxGoalsPerCycle ?? DEFAULT_MAX_GOALS_PER_CYCLE;
  let goalsDecided = 0;
  return proposals.map((p) => {
    let { rail, reason, followedHint } = classifyProposal(p, opts);
    const isGoalAmendment = rail === 'goal' && Boolean(p.targetGoalId?.trim());
    // D-003: never route onto a disabled gym — manufactured outcomes are worse
    // than no outcomes. Rerouted (not dropped) so the idea still lands on a
    // live rail and its outcome is real.
    if (rail === 'gym' && opts.gymEnabled === false) {
      rail = 'improvement';
      reason = `${reason}; gym rail gated OFF (autoloop disabled, D-003) → improvement`;
      followedHint = false;
    }
    // P-013 / D-005: the goal rail's gate + per-cycle cap. Both reroute to the
    // PLAN rail — a goal-scale idea is multi-plan scope, so a draft plan is its
    // live fallback surface; dropping it would lose the idea entirely.
    if (rail === 'goal' && !isGoalAmendment && opts.goalEnabled === false) {
      rail = 'plan';
      reason = `${reason}; goal rail gated OFF → plan`;
      followedHint = false;
    } else if (rail === 'goal' && !isGoalAmendment && goalsDecided >= maxGoals) {
      rail = 'plan';
      reason = `${reason}; goal cap reached (${maxGoals}/cycle) → plan`;
      followedHint = false;
    } else if (rail === 'goal' && !isGoalAmendment) {
      goalsDecided += 1;
    }
    const title = proposalTitle(p);
    const refs = p.addressesPatternRefs ?? [];
    const seededByRefs = p.seededByRefs ?? [];
    return {
      proposalId: p.id,
      sourceIdeaIds: [...(p.sourceIdeaIds ?? [])],
      rail,
      reason,
      followedHint,
      ...(title ? { title } : {}),
      ...(refs.length ? { addressesPatternRefs: [...refs] } : {}),
      ...(seededByRefs.length ? { seededByRefs: [...seededByRefs] } : {}),
      ...(p.sourceIdeaProvenance?.length
        ? { sourceIdeaProvenance: p.sourceIdeaProvenance.map((source) => ({ ...source })) }
        : {}),
      ...(p.consultation ? { consultation: { ...p.consultation } } : {}),
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * The injected dispatch ports
 * ──────────────────────────────────────────────────────────────────────── */

export interface PlanDraftRequest {
  proposal: Proposal;
  /** A valid kebab-case slug stem ({@link deriveSlugStem}); the port may refine it. */
  slugStem: string;
}

/** broad → plans:new. Returns the created (or pre-existing) draft plan's slug. */
export type PlansNewPort = (req: PlanDraftRequest) => Promise<{ slug: string }>;

/** testable → gym. Seeds the QD archive's distant niches in one batch (P-012). */
export type GymDispatchPort = (ideas: ScoutIdeaView[]) => Promise<SeedDistantResult>;

export interface CaptureRequest {
  proposal: Proposal;
}

/** concrete → improvements:capture. Returns the issue id + whether it was newly created. */
export type CapturePort = (req: CaptureRequest) => Promise<{ id: string; created: boolean }>;

/**
 * A whole-system proposal shaped for the eval-battery InstanceSubject (the apiary). The
 * InstanceSubject's variant is a GENOME delta over the interacting wholes; this view
 * carries the proposal text the apiary turns into one (mirrors {@link ScoutIdeaView}).
 */
export interface InstanceVariantView {
  id: string;
  rationale: string;
  text: string;
}

/** The result of registering whole-system proposals as InstanceSubject variant candidates. */
export interface InstanceSeedResult {
  /** The proposal ids registered as pending instance-eval (genome-variant) candidates. */
  registered: string[];
}

/** whole-system → InstanceSubject (the eval-battery's whole-instance subject — the missing
 *  rail, reconciliation P-005). Registers genome-variant candidates for the apiary to eval;
 *  batch-shaped like the gym rail. */
export type InstanceDispatchPort = (variants: InstanceVariantView[]) => Promise<InstanceSeedResult>;

/** One goal creation+start request (P-013 / D-005). The rails are DRAFTED by the router
 *  ({@link draftGoalRails}) and REQUIRED here by type — an auto-created goal never starts
 *  without both, which is what replaces the confirm card. */
export interface GoalDispatchRequest {
  proposal: Proposal;
  /** The goal's outcome statement ({@link proposalTitle} of the proposal). */
  title: string;
  /** The drafted abandonment condition — rides inside the goal record. */
  killCriterion: string;
  /** The drafted spend ceiling in cents — rides inside the goal record. */
  budgetCents: number;
}

/** goal-scale → goals create+start. Returns the created goal's id (the `goal:<id>`
 *  provenance ref P-013's outcome feedback joins on). Production wiring creates the
 *  `harness_shared.goals` row AND starts its GOAL-mode agent (router-deps.ts). */
export type GoalDispatchPort = (req: GoalDispatchRequest) => Promise<{ goalId: string }>;

/** One existing-goal amendment request (D-004/D-013). The production port maps
 * the proposal onto the existing `goals:update` door; the router deliberately
 * carries no parallel amendment verb or approval surface. */
export interface GoalAmendmentDispatchRequest {
  proposal: Proposal;
  /** The existing goal named by {@link Proposal.targetGoalId}. */
  targetGoalId: string;
}

/** goal-with-target → goals:update. Returns the amended id for the ordinary
 * `goal:<id>` provenance ref — amendment is the goal rail, not a sixth rail. */
export type GoalAmendmentDispatchPort = (req: GoalAmendmentDispatchRequest) => Promise<{ goalId: string }>;

export interface GoalFeedbackConsultRequest {
  proposal: Proposal;
  /** Present for amendment, absent for creation. */
  targetGoalId?: string;
}

/** D-010 high-stakes review. The port returns the proposal carrying a durable
 * disposition; an answered consult may also fold critique into it. */
export type GoalFeedbackConsultPort = (
  req: GoalFeedbackConsultRequest,
) => Promise<{ proposal: Proposal; consultation: ProposalConsultation }>;

/**
 * The injected effect port. Every rail's side-effect goes through here so
 * {@link routeProposals} is testable with fakes (invariant #5: assert routing
 * without real writes). Production wiring: `router-deps.ts`.
 */
export interface RouterPorts {
  plansNew: PlansNewPort;
  gymDispatch: GymDispatchPort;
  capture: CapturePort;
  /**
   * whole-system → InstanceSubject (reconciliation P-005). OPTIONAL: a router with no
   * InstanceSubject wired routes nothing to 'instance' (no proposal hints/overrides to it);
   * if one is routed there without a port, the dispatch fails defensively (recorded in
   * `error`/`failed`, never aborting the batch).
   */
  instanceDispatch?: InstanceDispatchPort;
  /**
   * goal-scale → goals create+start (P-013 / D-005). OPTIONAL, same contract as
   * `instanceDispatch`: a goal-routed decision with no port wired fails defensively
   * per-decision, never aborting the batch.
   */
  goalDispatch?: GoalDispatchPort;
  /**
   * goal-with-target → goals:update (D-004/D-013). OPTIONAL for defensive
   * embeddings; a targeted goal proposal must never fall through to creation
   * merely because this port is absent.
   */
  goalAmendmentDispatch?: GoalAmendmentDispatchPort;
  /** D-010: consult:get_feedback before either shape consumes the goal rail. */
  goalFeedbackConsult?: GoalFeedbackConsultPort;
}

/* ────────────────────────────────────────────────────────────────────────
 * Adapters
 * ──────────────────────────────────────────────────────────────────────── */

/** First non-empty line of the framing, capped — the proposal's human title. */
export function proposalTitle(p: Proposal): string {
  const framing = (p.framing ?? '').trim();
  const firstLine =
    framing
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  return firstLine.slice(0, 200);
}

/**
 * Map a gym-routed proposal onto the gym-bridge's {@link ScoutIdeaView}. The
 * view `id` is the PROPOSAL id, so the niche the bridge seeds carries the same
 * candidateId the gym's change-feed entry will — which is what makes the
 * `gym:<proposalId>` provenance ref join in P-013. The real `Proposal` carries
 * no behaviour-space tags, so the descriptor falls back to gym-bridge's
 * graceful defaults; the cycle may inject a richer mapper via
 * {@link RouteOptions.gymView} once it resolves the source ideas' scope/risk.
 */
export function proposalToGymView(p: Proposal): ScoutIdeaView {
  const title = proposalTitle(p);
  return {
    id: p.id,
    rationale: title,
    text: [p.framing, p.mechanism]
      .map((s) => (s ?? '').trim())
      .filter(Boolean)
      .join(' — '),
  };
}

/**
 * Map a whole-system proposal onto an {@link InstanceVariantView} (the InstanceSubject's
 * intake). The view `id` is the PROPOSAL id, so the `instance:<proposalId>` provenance ref
 * joins the apiary's eval verdict in the change feed (reconciliation P-006).
 */
export function proposalToInstanceView(p: Proposal): InstanceVariantView {
  const title = proposalTitle(p);
  return {
    id: p.id,
    rationale: title,
    text: [p.framing, p.mechanism]
      .map((s) => (s ?? '').trim())
      .filter(Boolean)
      .join(' — '),
  };
}

/** The genome surface's "interacting wholes" vocabulary (reconciliation D-002: Queen prompt
 *  × placement policy × memory architecture × wake policy × coordination economy) — the
 *  markers of a WHOLE-SYSTEM (instance-level) idea vs a component one. */
export const WHOLE_SYSTEM_MARKERS = [
  'genome',
  'whole instance',
  'whole-instance',
  'whole system',
  'whole-system',
  'system-level',
  'instance-level',
  'interacting wholes',
  'queen prompt',
  'queen persona',
  'queen placement',
  'placement policy',
  'wake policy',
  'min-sleep',
  'coordination economy',
  'memory architecture',
  'memory-seeding',
  'memory seeding',
  'the operator itself',
  'papercusp itself',
  'across harnesses',
  'across the hive',
] as const;

/**
 * Does this proposal vary the WHOLE INSTANCE (the genome's interacting wholes) rather than
 * one component? The HarnessSubject/InstanceSubject split (reconciliation P-005): a
 * component idea → the gym (HarnessSubject), a whole-system idea → the apiary
 * (InstanceSubject). An explicit `routeHint: 'instance'` always counts; otherwise the
 * proposal text is scanned for the genome-axis vocabulary (a conservative heuristic — the
 * recombine step may set the hint directly for a stronger signal).
 */
export function isWholeSystemProposal(p: Proposal, markers: readonly string[] = WHOLE_SYSTEM_MARKERS): boolean {
  if (p.routeHint === 'instance') return true;
  const hay = [p.framing, p.mechanism, p.whyNew].map((s) => (s ?? '').toLowerCase()).join(' \n ');
  return markers.some((m) => hay.includes(m));
}

/**
 * A ready-made {@link ClassifyOptions.override} that realizes the P-005 split: bump a
 * TESTABLE proposal (hint 'gym') to the `instance` rail when it varies the whole instance
 * ({@link isWholeSystemProposal}); leave 'plan' (design), 'improvement' (concrete), and
 * unhinted (smallest-footprint default) ideas alone. The production cycle wires this as the
 * router's `override`.
 */
export function wholeSystemInstanceOverride(p: Proposal): RoutedRail | undefined {
  return makeWholeSystemInstanceOverride()(p);
}

/**
 * Build a {@link ClassifyOptions.override} that bumps a TESTABLE proposal (hint 'gym')
 * to the `instance` rail when it varies the whole instance, using a CONFIGURABLE marker
 * vocabulary (P-009 scout-config seam). The genome-axis markers are coding/Papercusp-specific,
 * so the `coding` blueprint carries them while a `work` hive can supply its own / none.
 * Defaults to {@link WHOLE_SYSTEM_MARKERS} (behavior-neutral).
 */
export function makeWholeSystemInstanceOverride(
  markers: readonly string[] = WHOLE_SYSTEM_MARKERS,
): (p: Proposal) => RoutedRail | undefined {
  return (p) => (p.routeHint === 'gym' && isWholeSystemProposal(p, markers) ? 'instance' : undefined);
}

/* ────────────────────────────────────────────────────────────────────────
 * The goal rail (blender-loop-repair-and-opus5-xhigh-2026-08-16 P-013 / D-005)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The vocabulary of a GOAL-SCALE idea — one whose scope is MULTIPLE plans and whose
 * end-state is a weeks-long measurable outcome, vs a single plan's design surface.
 * Deliberately CONSERVATIVE (the instance-rail marker discipline): a goal dispatch
 * creates and starts a real goal with an agent behind it, so a false positive costs
 * far more than a false negative (which still lands as a draft plan).
 */
export const GOAL_SCALE_MARKERS = [
  'goal-scale',
  'goal mode',
  'multi-plan',
  'multiple plans',
  'several plans',
  'spans plans',
  'weeks-long',
  'weeks long',
  'over weeks',
  'multi-week',
  'long-horizon',
  'long horizon',
  'measurable end-state',
  'measurable end state',
  'north star',
  'kill criterion',
  'spend ceiling',
  'standing outcome',
  'campaign',
] as const;

/** The proposal fields the goal-scale vocabulary is scanned over, in scan order. */
export const GOAL_SCALE_SCANNED_FIELDS = ['framing', 'mechanism', 'bet', 'whyNew'] as const;
export type GoalScaleScannedField = (typeof GOAL_SCALE_SCANNED_FIELDS)[number];

/**
 * Blank out CODE-ISH spans, preserving offsets and length so a field's prose reads
 * identically minus the code (plan blender-goal-amendment-rail-2026-08-19 P-009 / D-012).
 *
 * WHY THIS EXISTS, measured rather than imagined: D-012 measured `GOAL_SCALE_MARKERS`
 * at a precision of 0/1 on the live corpus. The single override-path draft in 30 cycles
 * (proposal SP-001) is about a tool-policy TABLE and reaches the goal rail solely because
 * the literal string `goal mode` appears inside a quoted SQL value in its `mechanism` —
 * `reason='goal mode: delegate, do not natively mutate'`. The author was writing a SQL
 * INSERT, not asking for the goal rail. A marker quoted inside code is a mention, not a
 * request, and treating the two alike is what makes the whole heuristic untrustworthy.
 *
 * WHAT IS STRIPPED, and why each is safe:
 *  • fenced blocks (```…```) and inline code (`…`) — unambiguous by construction;
 *  • quoted string LITERALS, but ONLY in a code position: the opening quote must follow
 *    `=`, `(`, `[`, `,` or `:` (optionally spaced). That is the shape of `reason='…'`,
 *    `action='deny'`, `f("…")` — and it deliberately does NOT match an English
 *    apostrophe, because in `don't` / `the goal's mode` the quote follows a LETTER.
 *    A naive quote-pair matcher eats real prose between two apostrophes, which would
 *    trade this false positive for a worse false negative.
 *
 * Replacement is spaces of EQUAL length, never deletion: field offsets stay honest, so a
 * caller reporting *where* a marker matched cannot be shifted by the stripping itself.
 */
export function stripCodeSpans(text: string): string {
  const blank = (s: string): string => ' '.repeat(s.length);
  return (
    text
      // Fenced blocks first — they may legally contain backticks and quotes.
      .replace(/```[\s\S]*?```/g, blank)
      .replace(/`[^`\n]*`/g, blank)
      // Quoted literals in a CODE position only (see header): keep the leading
      // operator/punctuation, blank the literal itself.
      .replace(/([=(\[,:]\s*)('[^'\n]*'|"[^"\n]*")/g, (_m, lead: string, lit: string) => lead + blank(lit))
  );
}

/** One goal-scale marker that appears in a proposal, with the provenance a reader needs
 *  to judge whether it is a genuine ask or an incidental mention (D-012). */
export interface GoalScaleMarkerHit {
  /** The vocabulary entry that matched, verbatim. */
  marker: string;
  /** Which scanned fields it appears in — a marker present ONLY in `mechanism` reads very
   *  differently from one in the `framing`, which is the proposal's actual thesis. */
  fields: GoalScaleScannedField[];
  /** True when EVERY occurrence sits inside a code-ish span — D-012's measured
   *  false-positive shape, and the reason this match does not escalate the rail. */
  onlyInCodeSpan: boolean;
}

/**
 * Which goal-scale markers a proposal matches, and WHERE — the shared primitive behind
 * both the routing predicate and the draft queue's reader-facing provenance.
 *
 * Returns every marker present in the raw text (so a false positive stays VISIBLE and
 * auditable rather than silently vanishing), each flagged with whether it survives the
 * code-span strip. Callers decide what to do with a code-span-only hit: routing ignores
 * it, the draft queue shows it and says why.
 */
export function goalScaleMarkerHits(
  p: Proposal,
  markers: readonly string[] = GOAL_SCALE_MARKERS,
): GoalScaleMarkerHit[] {
  const raw: Record<string, string> = {};
  const prose: Record<string, string> = {};
  for (const f of GOAL_SCALE_SCANNED_FIELDS) {
    const v = ((p as unknown as Record<string, unknown>)[f] as string | undefined) ?? '';
    raw[f] = v.toLowerCase();
    prose[f] = stripCodeSpans(v).toLowerCase();
  }
  const hits: GoalScaleMarkerHit[] = [];
  for (const m of markers) {
    const fields = GOAL_SCALE_SCANNED_FIELDS.filter((f) => (raw[f] ?? '').includes(m));
    if (fields.length === 0) continue;
    hits.push({
      marker: m,
      fields: [...fields],
      onlyInCodeSpan: !fields.some((f) => (prose[f] ?? '').includes(m)),
    });
  }
  return hits;
}

/**
 * Is this proposal GOAL-SCALE (multi-plan scope, weeks-long measurable end-state)
 * rather than plan-scale? An explicit `routeHint: 'goal'` always counts; otherwise
 * the proposal text is scanned for the goal-scale vocabulary — the same conservative
 * text heuristic as {@link isWholeSystemProposal}, and like it, a stronger signal is
 * for the hint producer to set `routeHint` directly.
 *
 * P-009 / D-012: a marker that appears ONLY inside a code-ish span does not count. See
 * {@link stripCodeSpans} for the measurement that forced this. Pass
 * `includeCodeSpans: true` to get the pre-P-009 behaviour — that exists so the historical
 * false positive stays reproducible as evidence, NOT as a production option.
 */
export function isGoalScaleProposal(
  p: Proposal,
  markers: readonly string[] = GOAL_SCALE_MARKERS,
  opts: { includeCodeSpans?: boolean } = {},
): boolean {
  if (p.routeHint === 'goal') return true;
  const hits = goalScaleMarkerHits(p, markers);
  return opts.includeCodeSpans === true ? hits.length > 0 : hits.some((h) => !h.onlyInCodeSpan);
}

/**
 * Build a {@link ClassifyOptions.override} that bumps a BROAD proposal (hint 'plan')
 * to the `goal` rail when it is goal-scale ({@link isGoalScaleProposal}), with a
 * configurable marker vocabulary (the P-009 scout-config seam, mirroring
 * {@link makeWholeSystemInstanceOverride}). Only 'plan'-hinted proposals are bumped:
 * a goal subsumes plans, so the escalation path is plan → goal, and gym/improvement
 * ideas are never goal-scale by construction. Compose with the instance override in
 * the cycle wiring — their hint domains ('plan' vs 'gym') are disjoint.
 */
export function makeGoalScaleOverride(
  markers: readonly string[] = GOAL_SCALE_MARKERS,
  opts: { includeCodeSpans?: boolean } = {},
): (p: Proposal) => RoutedRail | undefined {
  return (p) => (p.routeHint === 'plan' && isGoalScaleProposal(p, markers, opts) ? 'goal' : undefined);
}

/**
 * Default spend ceiling drafted onto an auto-created goal (cents). Deliberately small
 * for an autonomous creation — the ceiling is one of the two rails D-005 requires to
 * ride INSIDE the goal record in place of a confirm card; the goal's own agent can
 * argue it up with the owner later. Configurable per-blueprint via
 * `scout.routing.goalBudgetCentsCap`.
 */
export const DEFAULT_GOAL_BUDGET_CENTS = 20000;

/** Default {@link ClassifyOptions.maxGoalsPerCycle} — one auto-started goal per routing
 *  batch. A goal is a weeks-long commitment with an agent behind it; one per cycle is
 *  already an aggressive autonomous pace, and overflow lands as draft plans, not on the
 *  floor. */
export const DEFAULT_MAX_GOALS_PER_CYCLE = 1;

/**
 * Draft the two D-005 rails from the idea itself — PURE. An auto-created goal must
 * carry BOTH a written kill criterion and a spend ceiling before it starts (the
 * confirm card's replacement), so this never returns an empty criterion: the
 * cheap experiment's falsifiable signal (D-006 — every proposal has one) is the
 * natural abandonment condition, with the framing as fallback context.
 */
export function draftGoalRails(
  p: Proposal,
  opts: { budgetCentsCap?: number } = {},
): { killCriterion: string; budgetCents: number } {
  const signal = (p.cheapExperiment?.falsifiableSignal ?? '').trim();
  const framing = proposalTitle(p);
  const killCriterion = (
    signal
      ? `Kill this goal if its cheap experiment falsifies: ${signal}`
      : `Kill this goal if no measurable progress toward "${framing}" lands within 30 days`
  ).slice(0, 2000);
  return { killCriterion, budgetCents: opts.budgetCentsCap ?? DEFAULT_GOAL_BUDGET_CENTS };
}

/**
 * Derive a valid `plans:new` slug stem from the proposal framing — lowercased,
 * non-alnum collapsed to single hyphens, trimmed, capped, and `scout-`-prefixed
 * (so Scout drafts are identifiable + the slug always satisfies plans:new's
 * `^[a-z0-9][a-z0-9-]*[a-z0-9]$`, min-3 rule). plans:new appends the date.
 */
export function deriveSlugStem(framing: string): string {
  const core = (framing ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return core.length > 0 ? `scout-${core}` : 'scout-idea';
}

/* ────────────────────────────────────────────────────────────────────────
 * Dispatch
 * ──────────────────────────────────────────────────────────────────────── */

export interface RouteResult {
  /** One decision per input proposal, in input order, `routedRef` filled where dispatched. */
  decisions: RoutingDecision[];
  /** Count routed to each rail (counted even if the dispatch then failed). */
  byRail: Record<RoutedRail, number>;
  /** The gym seed result (coverage gain), present when ≥1 proposal routed to the gym. */
  gymSeed?: SeedDistantResult;
  /** The instance seed result, present when ≥1 proposal routed to the InstanceSubject (P-005). */
  instanceSeed?: InstanceSeedResult;
  /** proposalIds whose dispatch threw (their decision carries the `error`). */
  failed: string[];
  /** proposalIds waiting on a live consult reply; deliberately not failures. */
  deferred: string[];
}

export interface RouteOptions extends ClassifyOptions {
  /** Custom proposal→gym-view mapper (default {@link proposalToGymView}). */
  gymView?: (p: Proposal) => ScoutIdeaView;
  /** Spend ceiling drafted onto auto-created goals (default {@link DEFAULT_GOAL_BUDGET_CENTS});
   *  the P-009 scout-config seam carries it as `routing.goalBudgetCentsCap`. */
  goalBudgetCentsCap?: number;
  /** Stable cycle id stamped on a pre-open consult failure disposition. */
  cycleId?: string;
}

/**
 * Route a batch of proposals through the injected ports (P-007). Classifies
 * purely, then dispatches: the gym rail in ONE batch (`seedDistantNiches` is
 * batch-shaped); plan + improvement per-proposal. Defensive — a sink that throws
 * fails only that decision (recorded in `error` + `failed`), never the whole
 * batch (the ideators.ts "one failed ideator never kills the batch" discipline).
 */
export async function routeProposals(
  proposals: readonly Proposal[],
  ports: RouterPorts,
  opts: RouteOptions = {},
): Promise<RouteResult> {
  const decisions = decideRoutes(proposals, opts);
  const byProposal = new Map(proposals.map((p) => [p.id, p]));
  const gymView = opts.gymView ?? proposalToGymView;

  // ── gym rail (batched) ──────────────────────────────────────────────────
  const gymDecisions = decisions.filter((d) => d.rail === 'gym');
  let gymSeed: SeedDistantResult | undefined;
  if (gymDecisions.length > 0) {
    const views = gymDecisions.map((d) => gymView(byProposal.get(d.proposalId)!));
    try {
      gymSeed = await ports.gymDispatch(views);
      for (const d of gymDecisions) {
        const seeded = gymSeed.seeded.find((entry) => entry.ideaId === d.proposalId);
        if (seeded?.admitted === true) {
          d.routedRef = `gym:${d.proposalId}`;
          continue;
        }

        const skipped = gymSeed.skipped.find((entry) => entry.ideaId === d.proposalId);
        d.error = seeded
          ? `gym seed was not admitted for ${d.proposalId} (niche ${seeded.nicheKey})`
          : skipped
            ? `gym seed was skipped for ${d.proposalId}: ${skipped.reason}`
            : `gym dispatch returned no admission result for ${d.proposalId}`;
      }
    } catch (e) {
      const msg = errMsg(e);
      for (const d of gymDecisions) d.error = msg;
    }
  }

  // ── instance rail (batched) — whole-system → InstanceSubject (reconciliation P-005) ──
  const instanceDecisions = decisions.filter((d) => d.rail === 'instance');
  let instanceSeed: InstanceSeedResult | undefined;
  if (instanceDecisions.length > 0) {
    if (!ports.instanceDispatch) {
      // No InstanceSubject wired — record it on each decision; never abort the batch.
      for (const d of instanceDecisions) d.error = 'no InstanceSubject dispatch wired (instanceDispatch port missing)';
    } else {
      const views = instanceDecisions.map((d) => proposalToInstanceView(byProposal.get(d.proposalId)!));
      try {
        instanceSeed = await ports.instanceDispatch(views);
        for (const d of instanceDecisions) d.routedRef = `instance:${d.proposalId}`;
      } catch (e) {
        const msg = errMsg(e);
        for (const d of instanceDecisions) d.error = msg;
      }
    }
  }

  // ── plan + improvement + goal rails (per-proposal) ────────────────────────
  for (const d of decisions) {
    if (d.rail === 'gym' || d.rail === 'instance') continue; // handled above (batched)
    const p = byProposal.get(d.proposalId)!;
    try {
      if (d.rail === 'plan') {
        const { slug } = await ports.plansNew({ proposal: p, slugStem: deriveSlugStem(p.framing) });
        d.routedRef = `plan:${slug}`;
      } else if (d.rail === 'goal') {
        const targetGoalId = p.targetGoalId?.trim();
        let reviewedProposal = p;

        // D-010: review both creation and amendment BEFORE either write port.
        // A live reply is asynchronous: persist the pending disposition and
        // resume it from the existing stage-artifact store in a later cycle.
        // Unavailable/failed review is recorded but is not a permission gate.
        if (!p.consultation) {
          if (!ports.goalFeedbackConsult) {
            d.error = 'no goal feedback consult wired (goalFeedbackConsult port missing)';
            continue;
          }
          try {
            const reviewed = await ports.goalFeedbackConsult({
              proposal: p,
              ...(targetGoalId ? { targetGoalId } : {}),
            });
            reviewedProposal = reviewed.proposal;
            // The cycle persists its original proposal array after routing. Mutate
            // that exact object so the stage-artifact row becomes the durable
            // continuation record; no second queue or table is introduced.
            Object.assign(p, reviewedProposal);
            d.consultation = reviewed.consultation;
          } catch (e) {
            const consultation: ProposalConsultation = {
              originCycleId: opts.cycleId ?? 'unscoped-cycle',
              originalProposalId: p.id,
              conversationId: null,
              status: 'unavailable',
              state: 'binding_error',
              verdict: 'failed',
              reason: errMsg(e).slice(0, 1000),
            };
            p.consultation = consultation;
            d.consultation = consultation;
          }
        } else {
          d.consultation = p.consultation;
        }

        if (d.consultation?.status === 'pending') {
          d.deferred = 'goal-consult';
          continue;
        }
        reviewedProposal = p;
        if (targetGoalId) {
          // D-004/D-013: goal WITH a target is an amendment through the existing
          // goals:update door. Never fall through to creation if the amendment
          // port is missing — that would mint an autonomous goal by accident.
          if (!ports.goalAmendmentDispatch) {
            d.error = 'no goal amendment dispatch wired (goalAmendmentDispatch port missing)';
          } else {
            const { goalId } = await ports.goalAmendmentDispatch({
              proposal: reviewedProposal,
              targetGoalId,
            });
            d.routedRef = `goal:${goalId}`;
          }
        } else {
          // P-013 / D-005: goal WITHOUT a target remains creation. Draft the
          // two rails HERE so no new goal can reach the port without them.
          if (!ports.goalDispatch) {
            d.error = 'no goal dispatch wired (goalDispatch port missing)';
          } else {
            const rails = draftGoalRails(reviewedProposal, {
              ...(opts.goalBudgetCentsCap !== undefined ? { budgetCentsCap: opts.goalBudgetCentsCap } : {}),
            });
            const { goalId } = await ports.goalDispatch({
              proposal: reviewedProposal,
              title: proposalTitle(reviewedProposal) || `Scout goal ${reviewedProposal.id}`,
              ...rails,
            });
            d.routedRef = `goal:${goalId}`;
          }
        }
      } else {
        const { id } = await ports.capture({ proposal: p });
        d.routedRef = `wi:${id}`;
      }
    } catch (e) {
      d.error = errMsg(e);
    }
  }

  const byRail: Record<RoutedRail, number> = { plan: 0, gym: 0, improvement: 0, instance: 0, goal: 0 };
  for (const d of decisions) byRail[d.rail] += 1;
  const failed = decisions.filter((d) => d.error).map((d) => d.proposalId);
  const deferred = decisions.filter((d) => d.deferred).map((d) => d.proposalId);

  return {
    decisions,
    byRail,
    ...(gymSeed ? { gymSeed } : {}),
    ...(instanceSeed ? { instanceSeed } : {}),
    failed,
    deferred,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Provenance expansion (→ P-013)
 * ──────────────────────────────────────────────────────────────────────── */

/** Resolve a source idea's creative lens (P-004 Idea.lens) for attribution (D-009). */
export type LensResolver = (ideaId: string) => CreativeLens | undefined;

export interface ProvenanceContext {
  /** The Scout cycle this routing belongs to (P-013 grouping). */
  cycleId?: string;
  /** ISO timestamp the routing ran (injected for determinism). */
  routedAt?: string;
}

/**
 * Expand the dispatched decisions into P-013's {@link RoutedIdeaProvenance} ledger
 * rows — ONE per source idea, so every lens that recombined into a routed proposal
 * earns attribution for the outcome (D-009). The router is lens-free; the CYCLE
 * holds the ideas, so it calls this with a `lensOf` resolver over its own ideas
 * (`cycle.ts` → `ScoutCycleResult.provenance`), and su-80be9's scheduler persists
 * the rows (`recordRoutedIdea`). A decision with no `routedRef` (never dispatched),
 * or a source idea whose lens can't be resolved, is skipped — there is nothing to
 * attribute.
 */
export function decisionsToProvenance(
  decisions: readonly RoutingDecision[],
  lensOf: LensResolver,
  ctx: ProvenanceContext = {},
): RoutedIdeaProvenance[] {
  const out: RoutedIdeaProvenance[] = [];
  for (const d of decisions) {
    if (!d.routedRef) continue;
    for (const ideaId of d.sourceIdeaIds) {
      const carried = d.sourceIdeaProvenance?.find((source) => source.id === ideaId);
      const lens = lensOf(ideaId) ?? carried?.lens;
      if (!lens) continue;
      out.push({
        ideaId,
        lens,
        rail: d.rail,
        routedRef: d.routedRef,
        ...(ctx.cycleId ? { cycleId: ctx.cycleId } : {}),
        ...(d.title ? { title: d.title } : {}),
        ...(ctx.routedAt ? { routedAt: ctx.routedAt } : {}),
        ...(d.addressesPatternRefs?.length || carried?.addressesPatternRefs?.length
          ? {
              addressesPatternRefs: [
                ...new Set([...(carried?.addressesPatternRefs ?? []), ...(d.addressesPatternRefs ?? [])]),
              ],
            }
          : {}),
      });
    }
  }
  return out;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
