/**
 * blender:ideation-feedback — the SU IDEATE-pass read of "your own past graded proposals".
 *
 * su-loop-capability-parity-2026-07-03 P-005 (D-009): SU sessions ORIGINATE feature ideas
 * (improvements:capture kind:'feature'), which now earn `origin='su-ideate'` rows on the routed
 * ledger. This returns the owner/Queen grades + critiques on those su-ideate ideas as the SAME
 * grader-feedback PRIMING block Scout's own ideators consume (reuses formatGraderFeedbackPriming
 * via gatherGraderFeedbackPriming) — so an IDEATE pass builds on what landed and what the grader
 * flagged, instead of a cold start.
 *
 * su-ideate-learning-substrate-2026-07-10 P-003 adds the OUTCOME readback: every su-ideate
 * filing joined to its routed artifact's fate — `outcomes[]` (won / lost / pending via
 * classifyIdeaOutcome over the loss-augmented change feed: resolved wi ⇒ won, deprecated wi ⇒
 * lost, open wi ⇒ pending) + a `summary` roll-up — so the pass sees not just what the grader
 * SAID but what actually SHIPPED. Read-only, origin-scoped to 'su-ideate', so it NEVER touches
 * Scout's per-lens weight learning (which reads origin='scout').
 *
 * P-004 adds `lensWinRates[]`: the same outcome data tallied per {@link SuIdeationLens}
 * (grade-dominated like Scout's weight math), with an anti-strangle sampling weight
 * (samplingWeightsWithFloor) baked in — computed at READ TIME on every call, never written
 * to scout_lens_weights (D-003). Sentinel ('su-ideate'-lens / unlensed) filings appear in
 * `outcomes`/`summary` but in no lens row.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import type { ChangeFeedEntry } from '../../curation/change-feed';
import { gatherGraderFeedbackPriming } from '../../scout/ideator-feedback-priming';
import {
  classifyIdeaOutcome,
  computeLensOutcomes,
  samplingWeightsWithFloor,
  type IdeaOutcome,
  type RoutedIdeaProvenance,
} from '../../scout/outcome-feedback';
import { buildScoutOutcomeReaders } from '../../scout/routed-ledger';
import { resolveIntentSims, rankByIntent, type IntentRankDeps } from '../../scout/intent-rank-leg';
import {
  resolveObservationsImpact,
  type ObservationImpactDeps,
  type ObservationsImpact,
} from '../../scout/observation-impact-leg';
import { resolveAgentIdentity } from '../coordination/identity';
import { SU_IDEATION_LENSES, type SuIdeationLens } from '../../scout/types';
// P-012 (federated-scout-gym-learning D-004/D-005): the OPTIONAL federated priming
// fold. The pure math (crowding, config resolution, empty-frontier partition) is safe
// at module load; the PG frontier read + owner-steering read live behind the default
// deps' LAZY imports, so importing this tool never touches the PG edge.
import {
  computeDepthAwareCrowding,
  isControlHivePriming,
  resolveFederatedPrimingConfig,
  DEFAULT_FEDERATED_PRIMING,
  type FederatedPrimingConfig,
  type FederatedEliteView,
} from '../../scout/federated-priming';
import {
  hiveEmptyFrontierFromElites,
  type FrontierEliteView,
  type FrontierScope,
} from '../../scout/foreign-frontier';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

/** One su-ideate filing joined to its routed artifact's fate (P-003). */
export interface IdeationOutcomeEntry {
  ideaId: string;
  title?: string;
  rail: RoutedIdeaProvenance['rail'];
  routedRef: string;
  /** Grade-blind change-feed classification (D-002) — grades ride alongside. */
  outcome: IdeaOutcome;
  humanGrade?: number;
  gradedBy?: RoutedIdeaProvenance['gradedBy'];
}

/**
 * One su lens's win-rate row (P-004) — read-time only, never persisted (D-003).
 * `won`/`lost` are MASS, fractional when grades exist (a grade dominates the
 * change-feed outcome as winCredit, exactly like Scout's weight tally).
 */
export interface SuLensWinRate {
  lens: SuIdeationLens;
  /** su-ideate filings declared under this lens (sentinel/unlensed rows appear in no lens row). */
  ideas: number;
  won: number;
  lost: number;
  pending: number;
  /** won / (won + lost) over decided mass; null when nothing decided yet. */
  winRate: number | null;
  /** Sampling share over SU_IDEATION_LENSES with the anti-strangle floor baked in — sums to 1. */
  weight: number;
}

export interface IdeationFeedbackResult {
  priming: string;
  entries: string[];
  count: number;
  /**
   * One per su-ideate ledger row (P-003). Newest-first by default; when the caller
   * passes `intent`, ranked most-relevant-first by cosine(intent, routed-artifact
   * vector) (P-019), falling back to newest-first when the embedder is down.
   */
  outcomes: IdeationOutcomeEntry[];
  summary: { won: number; lost: number; pending: number; graded: number; total: number };
  /** Per-su-lens win-rates + floored sampling weights, SU_IDEATION_LENSES order (P-004). */
  lensWinRates: SuLensWinRate[];
  /** Present only when the outcome leg failed — the priming leg still returns (fail-open, D-016). */
  outcomesError?: string;
  /**
   * OPTIONAL federated priming (P-012): this hive's read-time view of the SHARED
   * gym-QD frontier — nearby foreign elites, the most-crowded niches, and this hive's
   * empty-frontier slice. Absent on a CONTROL-arm hive (P-016 baseline) or a
   * NON-federated workspace (no foreign elites) — fail-soft empty either way.
   */
  federated?: FederatedPrimingBlock;
  /** Present only when the federated leg threw — the rest of the read still returns. */
  federatedError?: string;
  /**
   * OPTIONAL demand-pull observation→impact readback (P-021) — folded ONLY when the
   * caller passes `scope:'mine'`. Walks the funnel: your last 7 days of
   * `lane:observation` filings → the corpus-digest meta-patterns that cite them →
   * the routed ideas grounded on those patterns → which of those SHIPPED. An
   * observation visibly becoming pattern → idea → shipped change is the strongest
   * filing motivator (D-017). Absent without `scope:'mine'`, or when the leg is
   * disabled (kill switch); fail-soft to a filings-only block on a downstream error.
   */
  observationsImpact?: ObservationsImpact;
}

const NO_GRADES_FALLBACK =
  'No graded su-ideate proposals yet — file features (improvements:capture kind:"feature") and they appear here once the owner/Queen grades them.';

/** One nearby FOREIGN elite surfaced to prime an IDEATE pass (P-012). */
export interface FederatedForeignElite {
  nicheKey: string;
  fitness: number;
  sourceHive: string;
  rationale?: string;
}

/** One CROWDED niche across the local ∪ foreign frontier (depth-aware, P-012). */
export interface FederatedCrowdedNiche {
  nicheKey: string;
  totalElites: number;
  elitesAboveBar: number;
  contributingSources: number;
  sourcesAboveBar: number;
  bestFitness: number | null;
}

/** The OPTIONAL federated priming block folded into the ideation-feedback read (P-012). */
export interface FederatedPrimingBlock {
  /** Nearby foreign elites, best-fitness first (≤ cfg.foreignElites). */
  foreignElites: FederatedForeignElite[];
  /** Most-crowded niches across local ∪ foreign, deepest first (≤ cfg.crowded). */
  crowdedNiches: FederatedCrowdedNiche[];
  /** This hive's disjoint slice of the empty niche frontier to claim (≤ cfg.empty). */
  emptyNiches: string[];
}

/** Injectable read seam for the federated fold — unit tests drive it with no PG. */
export interface FederatedPrimingDeps {
  /** Effective federated-priming config: owner-steering override ?? DEFAULT_FEDERATED_PRIMING. */
  readConfig: (workspaceId: string, harnessSlug: string) => Promise<FederatedPrimingConfig>;
  /** Read-time union of local gym_qd_archive ∪ foreign gym_qd_foreign_elites elites. */
  readFrontier: (scope: FrontierScope) => Promise<FrontierEliteView[]>;
}

export const defaultFederatedPrimingDeps: FederatedPrimingDeps = {
  readConfig: async (workspaceId, harnessSlug) => {
    const { getOwnerSteering } = await import('../../owner-steering');
    const steering = await getOwnerSteering(workspaceId, harnessSlug);
    return resolveFederatedPrimingConfig(steering.federatedPriming ?? DEFAULT_FEDERATED_PRIMING);
  },
  readFrontier: async (scope) => {
    const [{ listFrontierElites }, { getOrgPg }] = await Promise.all([
      import('../../scout/foreign-frontier'),
      import('@papercusp/db-org'),
    ]);
    return listFrontierElites(getOrgPg().sql, scope);
  },
};

/**
 * Resolve the frontier scope for a caller. The frontier is keyed by
 * (workspace_id, harness_slug); an su read with no explicit harness defaults to
 * 'papercusp' (this workspace's primary harness) over the active workspace.
 */
function resolveFrontierScope(args: { harness?: string }, ctx: unknown): FrontierScope {
  const ctxHarness = (ctx as { harnessSlug?: unknown } | undefined)?.harnessSlug;
  const harnessSlug =
    (args.harness && args.harness !== '*' ? args.harness : undefined) ??
    (typeof ctxHarness === 'string' && ctxHarness && ctxHarness !== '*' ? ctxHarness : 'papercusp');
  const workspaceId = resolveConcreteWorkspaceId(
    (ctx as { workspaceId?: string | null } | undefined)?.workspaceId,
  );
  return { workspaceId, harnessSlug };
}

/**
 * The OPTIONAL federated priming fold (P-012, federated-scout-gym-learning
 * D-004/D-005): this hive's read-time view of the SHARED gym-QD frontier, so an
 * IDEATE pass leans on what PEER hives have already explored — nearby FOREIGN elites,
 * the most-CROWDED niches (local ∪ foreign), and this hive's disjoint slice of the
 * EMPTY niche frontier to claim. Counts come from the effective FederatedPrimingConfig
 * (owner-steering override ?? DEFAULT_FEDERATED_PRIMING).
 *
 * Two omissions keep the block honest — either returns `undefined`:
 *  - CONTROL arm (isControlHivePriming, all-zero counts): the P-016 falsifiability
 *    baseline runs the IDENTICAL code path with NO foreign priming, so "more peers"
 *    can be measured against "same code, no federation".
 *  - NON-federated workspace (zero foreign elites on the frontier): nothing federated
 *    to surface, so the block stays absent (fail-soft empty) rather than padding the
 *    output with this hive's own empty niches.
 *
 * Empty-frontier note: uses the PURE hiveEmptyFrontierFromElites (the core of
 * computeHiveEmptyFrontier) over the SINGLE frontier read — no redundant PG round trip.
 * The HRW roster is derived from the frontier itself: potId = this workspace, hiveIds =
 * this workspace + the distinct foreign source hives.
 */
export async function computeFederatedPriming(
  scope: FrontierScope,
  deps: FederatedPrimingDeps = defaultFederatedPrimingDeps,
): Promise<FederatedPrimingBlock | undefined> {
  const cfg = await deps.readConfig(scope.workspaceId, scope.harnessSlug);
  if (isControlHivePriming(cfg)) return undefined; // P-016 baseline: no federated priming.

  const frontier = await deps.readFrontier(scope);
  const foreign = frontier.filter(
    (e) => typeof e.sourceHive === 'string' && e.sourceHive.trim().length > 0,
  );
  if (foreign.length === 0) return undefined; // non-federated workspace → fail-soft empty.

  const foreignElites: FederatedForeignElite[] = foreign.slice(0, cfg.foreignElites).map((e) => ({
    nicheKey: e.nicheKey,
    fitness: e.fitness,
    sourceHive: e.sourceHive!.trim(),
    ...(e.rationale ? { rationale: e.rationale } : {}),
  }));

  // Depth-aware crowding over the FULL union (local ∪ foreign), deepest first.
  // fitnessBar 0 — the su read has no per-cycle fitness gate, so every elite counts.
  const crowdedNiches: FederatedCrowdedNiche[] = computeDepthAwareCrowding(
    frontier.map<FederatedEliteView>((e) => ({
      nicheKey: e.nicheKey,
      fitness: e.fitness,
      sourceHive: e.sourceHive,
    })),
    { fitnessBar: 0 },
  )
    .slice(0, cfg.crowded)
    .map((s) => ({
      nicheKey: s.nicheKey,
      totalElites: s.totalElites,
      elitesAboveBar: s.elitesAboveBar,
      contributingSources: s.contributingSources,
      sourcesAboveBar: s.sourcesAboveBar,
      bestFitness: s.bestFitness,
    }));

  // This hive's disjoint HRW slice of the empty niche frontier (pure core of
  // computeHiveEmptyFrontier over the single frontier read). Roster derived from the
  // frontier: potId = this workspace, hiveIds = this workspace + distinct foreign hives.
  const foreignHiveIds = [...new Set(foreign.map((e) => e.sourceHive!.trim()))];
  const emptyNiches = hiveEmptyFrontierFromElites(
    frontier,
    [scope.workspaceId, ...foreignHiveIds],
    scope.workspaceId,
  ).slice(0, cfg.empty);

  return { foreignElites, crowdedNiches, emptyNiches };
}

/** The testable core: priming + outcome readback composed over the su-ideate ledger scope. */
export async function runIdeationFeedback(
  args: { harness?: string; maxEntries?: number; intent?: string; scope?: 'mine'; createdBy?: string },
  ctx?: unknown,
  deps: {
    federated?: FederatedPrimingDeps;
    intentRank?: IntentRankDeps;
    observationImpact?: ObservationImpactDeps;
  } = {},
): Promise<IdeationFeedbackResult> {
  const scope = args.harness ? { harnessSlug: args.harness } : {};
  const intent = args.intent?.trim() ? args.intent.trim() : undefined;

  let outcomes: IdeationOutcomeEntry[] = [];
  const summary = { won: 0, lost: 0, pending: 0, graded: 0, total: 0 };
  let lensWinRates: SuLensWinRate[] = [];
  let outcomesError: string | undefined;
  // P-019: resolved ONCE from the provenance refs, then shared by BOTH the outcomes
  // reorder here and the grades block (fed to gatherGraderFeedbackPriming) — a single
  // intent embed + cosine join drives the whole read. Stays undefined (⇒ newest-first
  // everywhere) with no intent OR when the embedder is down (fail-open, D-016).
  let intentSimByRef: IntentSimByRef | undefined;
  try {
    const readers = buildScoutOutcomeReaders({ origin: 'su-ideate', ...scope });
    const [provenance, completions] = await Promise.all([
      readers.routedIdeas(),
      readers.completions(),
    ]);
    const byRef = new Map<string, ChangeFeedEntry>();
    for (const e of completions) {
      // First-wins matches gatherCompletions' dedup; refs are unique per artifact.
      if (!byRef.has(e.ref)) byRef.set(e.ref, e);
    }
    outcomes = provenance.map((p) => ({
      ideaId: p.ideaId,
      ...(p.title ? { title: p.title } : {}),
      rail: p.rail,
      routedRef: p.routedRef,
      outcome: classifyIdeaOutcome(p, byRef),
      ...(p.humanGrade != null ? { humanGrade: p.humanGrade } : {}),
      ...(p.gradedBy ? { gradedBy: p.gradedBy } : {}),
    }));
    summary.total = outcomes.length;
    for (const o of outcomes) {
      summary[o.outcome] += 1;
      if (o.humanGrade != null) summary.graded += 1;
    }

    // P-004: per-su-lens win-rates, READ-TIME only (D-003 — no scout_lens_weights
    // write; Scout's persist→read-back floor becomes a same-call floor here).
    // Grade-dominated tally (a graded filing counts as fractional win/loss mass),
    // sentinel/unlensed rows land in no lens row but stay in the report total.
    const report = computeLensOutcomes(provenance, completions, { lenses: SU_IDEATION_LENSES });
    const floored = samplingWeightsWithFloor(
      Object.fromEntries(
        SU_IDEATION_LENSES.map((l) => [l, report.byLens[l].weight]),
      ) as Partial<Record<SuIdeationLens, number>>,
      { lenses: SU_IDEATION_LENSES },
    );
    lensWinRates = SU_IDEATION_LENSES.map((l) => {
      const s = report.byLens[l];
      return {
        lens: l,
        ideas: s.routed,
        won: s.won,
        lost: s.lost,
        pending: s.pending,
        winRate: s.winRate,
        weight: floored[l],
      };
    });

    // P-019: intent-ranked priming. Resolve cosine(intent, routed-artifact) ONCE over
    // the ledger refs; when it lands, surface the most-relevant filings first (outcomes
    // here, grades below via intentSimByRef) instead of newest-first. Fail-open: a null
    // verdict (no intent / embedder down / dims-mismatch) leaves both blocks newest-first.
    if (intent) {
      const sims = await resolveIntentSims(
        intent,
        provenance.map((p) => p.routedRef),
        deps.intentRank,
      );
      if (sims) {
        intentSimByRef = sims;
        outcomes = rankByIntent(outcomes, (o) => o.routedRef, sims);
      }
    }
  } catch (err) {
    // Fail-open (D-016): a broken outcome join degrades to the pre-P-003
    // priming-only read instead of failing the whole grounding pre-pass.
    outcomesError = err instanceof Error ? err.message : String(err);
  }

  // C-4 grader-feedback priming — gathered AFTER the outcome read so a resolved P-019
  // intent order (intentSimByRef) reorders this block too; absent it, newest-first.
  const { priming, entries } = await gatherGraderFeedbackPriming({
    origin: 'su-ideate',
    ...scope,
    ...(args.maxEntries ? { maxEntries: args.maxEntries } : {}),
    ...(intentSimByRef ? { intentSimByRef } : {}),
  });

  // P-012: OPTIONAL federated priming fold. Fully fail-soft — a frontier / steering
  // read error degrades to NO block (the priming + outcome legs still return),
  // matching the D-016 fail-open posture. Absent on a control-arm hive or a
  // non-federated workspace.
  let federated: FederatedPrimingBlock | undefined;
  let federatedError: string | undefined;
  try {
    federated = await computeFederatedPriming(resolveFrontierScope(args, ctx), deps.federated);
  } catch (err) {
    federatedError = err instanceof Error ? err.message : String(err);
  }

  // P-021: OPTIONAL demand-pull observation→impact readback — only when the caller
  // asked for `scope:'mine'` AND their originating id is resolved (the handler
  // stamps it from ctx). Fully fail-soft: resolveObservationsImpact never throws
  // (returns undefined when disabled / VITEST-inert / blank), so a heavy digest
  // read can never break the priming + outcome legs that already returned.
  const observationsImpact =
    args.scope === 'mine' && args.createdBy?.trim()
      ? await resolveObservationsImpact(args.createdBy, {}, deps.observationImpact)
      : undefined;

  return {
    priming: priming || NO_GRADES_FALLBACK,
    entries,
    count: entries.length,
    outcomes,
    summary,
    lensWinRates,
    ...(outcomesError ? { outcomesError } : {}),
    ...(federated ? { federated } : {}),
    ...(federatedError ? { federatedError } : {}),
    ...(observationsImpact ? { observationsImpact } : {}),
  };
}

export default defineTool({
  name: 'blender:ideation-feedback',
  description:
    "Your IDEATE-pass read of your OWN past proposals: owner/Mug grades + critiques on features you filed (improvements:capture kind:'feature'), each filing's real-world outcome (outcomes[]: won/lost/pending — resolved ⇒ won, deprecated ⇒ lost), and lensWinRates[] (per-lens win-rates, floored sampling weight) so you lean into stances that land. Open every pass { scope:'mine', intent:'<your pass focus>' }: scope:'mine' also folds observationsImpact — your 7d lane:observation filings and the pattern → idea → shipped chain they seeded; intent re-ranks grades+outcomes by semantic relevance to this pass (fail-open to newest-first). A federated workspace also gets federated — nearby foreign elites, crowded niches, and this hive's empty-frontier slice. Read-only; su-ideate origin only — never touches Blender's lens-weight learning.",
  capability: 'curation:read',
  guidance: {
    when: 'Opening an IDEATE-mode grounding pre-pass — how your past proposals were graded AND how they fared. Pairs with curation:state-of-pot + rubrics:list + scorecards:freshness as the IDEATE grounding reads.',
    notWhen:
      "Grading an idea — that is blender:grade-idea. Reading Blender's OWN lens-routed ideas or lens weights — a different, lens-learning surface; this returns your su-ORIGINATED ideas only.",
    chaining:
      "curation:state-of-pot + rubrics:list + scorecards:freshness + blender:ideation-feedback { scope:'mine', intent } → your IDEATE pass, grounded → improvements:capture { ideation:{lens} } → blender:route-idea → blender:ideate-pass-record.",
    seeAlso: [
      'blender:grade-idea (record a grade on a routed idea)',
      'improvements:capture (file a kind:"feature" — it becomes a su-ideate ledger row)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    harness: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('scope to one harness (default: the whole workspace)'),
    maxEntries: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('priming window size (default 10, newest-first)'),
    intent: z
      .string()
      .min(1)
      .max(400)
      .optional()
      .describe(
        "this pass's one-line focus — when set, the grades + outcomes rank by semantic relevance to it (cosine of your intent against each past proposal's routed artifact) instead of newest-first, so the window surfaces what's relevant to THIS pass; silently falls back to newest-first if the embedder is unavailable",
      ),
    scope: z
      .enum(['mine'])
      .optional()
      .describe(
        "pass 'mine' to ALSO fold observationsImpact — your last 7 days of lane:observation filings, which corpus-digest meta-patterns cite them, and which routed ideas grounded on those patterns actually shipped (an observation visibly becoming pattern → idea → shipped change). Demand-pull: omitted unless you ask for it",
      ),
  }),
  async handler(args, ctx) {
    // scope:'mine' folds the observation→impact readback (P-021), attributed to the
    // CALLER's originating id (resolved from ctx — never caller-supplied input).
    const createdBy = args.scope === 'mine' ? resolveAgentIdentity(ctx).ownerId : undefined;
    const out = await runIdeationFeedback(
      { ...args, ...(createdBy ? { createdBy } : {}) },
      ctx,
    );
    return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
  },
});
