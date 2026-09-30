/**
 * cycle-deps.ts — production wiring of the Scout cycle (hive-creative-ideation-2026-06-08).
 *
 * `buildScoutCycleDeps` assembles the concrete {@link ScoutCycleDeps} that
 * `runScoutCycle` (cycle.ts) drives — binding each injected port to its real
 * step module, mirroring `corpus-digest-deps.ts` / `router-deps.ts`. su-80be9's
 * `system:scout-cycle` action calls it: `buildScoutCycleDeps(opts) →
 * runScoutCycle(deps) → result.{routed,provenance,costUsd}`.
 *
 * THREE deps are irreducibly injected (a slug alone can't produce them in a pure
 * lib), so the action/scheduler supplies them:
 *  - `llmCall` — the real stateless LLM client (the gym:judge pattern);
 *  - `createPlanDraft` — the ctx-bound `plans:new` draft creator (plans:new needs
 *    operator ctx for the write-lock + revision + plan-event — the honest seam);
 *  - `archive` — su-8075f's gym QD `ArchivePort` for the gym rail (P-010/P-012).
 *
 * Everything else (the digest readers, the novelty corpus, the ideator/critic/
 * recombine/route wiring) is assembled here. The readers are overridable so this
 * is unit-testable without PG/LLM.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  buildFederatedMapLane,
  synthesizeStateOfHive,
  type StateOfHiveReaders,
  type SynthesizeOptions,
  type FederatedMapEliteRow,
} from './corpus-digest';
import { buildStateOfHiveReaders } from './corpus-digest-deps';
import { SHADOW_VARIANT_ORIGIN } from './shadow-variant-origin';
import { runIdeators, ScoutIdeatorsTransportError } from './ideators';
import { critiqueIdeas } from './critics';
import { recombineProposals } from './recombine';
import {
  DEFAULT_MAX_GOALS_PER_CYCLE,
  routeProposals,
  makeGoalScaleOverride,
  makeWholeSystemInstanceOverride,
  type CapturePort,
  type GoalAmendmentDispatchPort,
  type GoalDispatchPort,
  type GoalFeedbackConsultPort,
  type RouterPorts,
} from './router';
import {
  buildCapturePort,
  buildGoalAmendmentDispatchPort,
  buildGoalDispatchPort,
  buildGymDispatchPort,
  buildInstanceDispatchPort,
  buildPlansNewPort,
  type CapturePortOptions,
  type PlanDraftCreator,
} from './router-deps';
import { gatherSteppingStones, type ArchivePort } from './gym-bridge';
import {
  gatherGraderFeedbackPriming,
  gatherRecentScoutFilingPriming,
  type GradedIdeaView,
  type RecentScoutFilingView,
} from './ideator-feedback-priming';
import { getScoutLensWeights, readLensRecency } from './routed-ledger';
import { CREATIVE_LENSES, type CreativeLens, type Proposal } from './types';
import { DEFAULT_SCOUT_CONFIG, type ScoutConfig } from './config';
import type { CorpusEntry } from './critique-core';
import type { ScoutCycleDeps, ScoutCycleLimits } from './cycle';
import type { ExperimentDispatchPort } from './experiment-rail';
import { activeWorkspaceId } from '../workspace-registry';
import { getOwnerSteering } from '../owner-steering';
import { resolveFederatedPrimingConfig, type FederatedPrimingConfig } from './federated-priming';
import { buildGoalFeedbackConsultPort, readResolvedGoalConsultProposals } from './goal-consult';

export interface BuildScoutCycleDepsOptions {
  /** Harness this cycle runs for — scopes the concrete-rail improvement capture. */
  harnessSlug: string;
  /** Workspace that owns this Scout cycle (threaded into goal create+start). */
  workspaceId?: string;
  /** Real stateless LLM client (the gym:judge pattern); the action/scheduler supplies it. */
  llmCall: ScoutCycleDeps['llmCall'];
  /** Ctx-bound `plans:new` draft creator (the broad rail) — the action supplies it. */
  createPlanDraft: PlanDraftCreator;
  /** su-8075f's gym QD archive (the testable rail's seed target, P-012/D-008). */
  archive: ArchivePort;
  /** Per-cycle limits (D-010). */
  limits?: ScoutCycleLimits;
  /** Opaque cycle id (provenance grouping). */
  cycleId?: string;
  /**
   * WI-4644 — absolute epoch-ms deadline imposed by the owning Scout scheduler.
   * Preserve it on the assembled cycle deps so runScoutCycle can bound every
   * governor admission wait and the ideator can reserve its generation budget.
   */
  deadlineMs?: number;
  /** Best-effort phase reporter used by scheduler timeout diagnostics. */
  onPhase?: ScoutCycleDeps['onPhase'];
  /** Override the state-of-Hive digest readers (tests). Default: prod `buildStateOfHiveReaders()`. */
  stateOfHiveReaders?: StateOfHiveReaders;
  /** Options forwarded to `synthesizeStateOfHive` (e.g. `nowMs`/`perCategory`). */
  digestOptions?: SynthesizeOptions;
  /** Override the search-first novelty corpus reader (tests). Default: prod plans + decisions. */
  noveltyCorpus?: () => Promise<CorpusEntry[]>;
  /** Capture-port options for the concrete rail (default scope = `harness:<slug>`, filed as the Queen). */
  captureOptions?: CapturePortOptions;
  /**
   * Override the concrete rail's capture port entirely (tests / the live-LLM quality
   * lane, which routes to inert sinks — real LLM, no live improvement writes). Default:
   * the production `buildCapturePort` over the real `captureImprovement`.
   */
  capturePort?: CapturePort;
  /**
   * Override the graded-ledger read behind the C-4 grader-feedback priming
   * (tests). Default: prod `readRoutedIdeas` (B-02's reader), harness-scoped.
   */
  graderFeedbackReader?: () => Promise<GradedIdeaView[]>;
  /** Override the bounded recent Scout-filing read behind self-dedup priming (tests). */
  recentScoutFilingReader?: () => Promise<RecentScoutFilingView[]>;
  /** Override the dark experiment-rail dispatch port (tests). Default: the dry-run-only
   *  buildExperimentDispatchPort. Only consulted when SCOUT_EXPERIMENT_RAIL is ON. */
  experimentDispatch?: ExperimentDispatchPort;
  /** Override the goal rail's create+start dispatch (tests / drills — a live goal spawn
   *  is a real agent). Default: the production `buildGoalDispatchPort` (P-013 / D-005). */
  goalDispatch?: GoalDispatchPort;
  /** Override the existing-goal amendment dispatch (tests/drills). Default: the
   * production adapter over the registered goals:update tool (D-004/D-013). */
  goalAmendmentDispatch?: GoalAmendmentDispatchPort;
  /** Override D-010's get_feedback adapter (tests/drills). */
  goalFeedbackConsult?: GoalFeedbackConsultPort;
  /** Override the stage-artifact continuation read (tests/drills). */
  resolvedGoalConsultReader?: () => Promise<Proposal[]>;
  /** Evaluation retains generated proposals but suppresses every dispatch side rail and old consultation continuation. */
  deferDispatch?: boolean;
  /** Called when a deterministic Scout side rail authors a new draft plan that needs Queen review. */
  onScoutDraftCreated?: (draft: { slug: string; title: string }) => Promise<void>;
  /**
   * Per-blueprint Scout tuning (P-009 scout-config seam): the ideator lens roster, the
   * search-first novelty knobs, the verdict-bucket thresholds, and the routing default +
   * whole-system marker vocabulary. Defaults to {@link DEFAULT_SCOUT_CONFIG} (byte-identical
   * to the previous hardcoded constants); the runner resolves it from the blueprint `scout` block.
   */
  scoutConfig?: ScoutConfig;
  /**
   * P-007 dedup-burn guard (WI-39479): present when the runner's pre-cycle ledger
   * read found consecutive saturated cycles. `readCorpus` stamps it onto the digest
   * ({@link CorpusDigest.dedupSaturation}) so renderDigest drops the standing
   * patterns + leads with the saturation banner. The runner ALSO widens the
   * novelty band (applyDedupBurnToConfig) before passing `scoutConfig` — the two
   * levers travel together.
   */
  dedupSaturation?: { consecutiveSaturated: number; wideningSteps: number };
}

/**
 * Map a per-cycle ideator budget to an ideator roster. A budget below the lens
 * count runs only N lenses (one ideator each); at/above it, the default
 * one-per-lens roster runs. Never silences below one lens (D-004 floor).
 *
 * WI-5041 lens ROTATION: when the budget caps the roster AND `lensRecency`
 * (lens → last-routed ms; absent = never routed) is provided, the capped
 * window runs the STALEST lenses first instead of always `slice(0, n)` — the
 * pin that held the live system at 2 distinct lenses for weeks (the
 * multi-lens-routing v2 bar wants >=4 distinct/7d; after one capped cycle the
 * just-run lenses become the newest, so successive cycles alternate through
 * the whole set — 4 distinct within two routed cycles on a 2-ideator roster).
 * The sort is STABLE (ties keep configured order), so no/empty recency is
 * byte-identical to the legacy first-N behavior.
 */
export function rosterForBudget(
  maxIdeators?: number,
  lenses: readonly CreativeLens[] = CREATIVE_LENSES,
  lensRecency?: Readonly<Record<string, number>>,
): { lenses?: readonly CreativeLens[] } {
  if (maxIdeators == null || maxIdeators >= lenses.length) {
    // Full roster. Return {} ONLY for the engine-default lenses, so the default path keeps
    // deferring to the ideators' default roster + the meta-learned lens weighting
    // (behavior-neutral). A custom blueprint roster is passed explicitly (the weighting is
    // keyed to the default lenses, so it does not apply to a custom roster). (P-009)
    return lenses === CREATIVE_LENSES ? {} : { lenses: [...lenses] };
  }
  const n = Math.max(1, Math.floor(maxIdeators));
  const ordered = lensRecency ? [...lenses].sort((a, b) => (lensRecency[a] ?? 0) - (lensRecency[b] ?? 0)) : [...lenses];
  return { lenses: ordered.slice(0, n) };
}

type FederatedArchiveSqlRow = {
  niche_key: string;
  candidate_id: string;
  scope: string;
  domain: string;
  risk: string;
  fitness: number;
  rationale: string | null;
  source_hive: string | null;
  novelty_gift: boolean | null;
};

type FederatedSeedView = {
  ref: string;
  nicheKey: string;
  fitness: number;
  rationale: string | null;
  sourceHive: string;
  scope: string;
  domain: string;
  risk: string;
  adjacentLocalNiche?: string;
  noveltyGift: boolean;
};

function changedGymDims(
  a: { scope: string; domain: string; risk: string },
  b: { scope: string; domain: string; risk: string },
): number {
  return Number(a.scope !== b.scope) + Number(a.domain !== b.domain) + Number(a.risk !== b.risk);
}

function buildNicheMapPriming(
  nicheMap: readonly { summary: string; ref: string }[],
  cfg: FederatedPrimingConfig,
): string | undefined {
  if (cfg.crowded <= 0 && cfg.empty <= 0) return undefined;
  const crowded = nicheMap.filter((p) => p.ref.startsWith('niche:v1:crowded:')).slice(0, cfg.crowded);
  const empty = nicheMap.filter((p) => p.ref.startsWith('niche:v1:empty:')).slice(0, cfg.empty);
  if (crowded.length === 0 && empty.length === 0) return undefined;
  const lines = ['AVOID crowded niches and TARGET empty niches when you choose what to mutate next.'];
  if (crowded.length > 0) {
    lines.push('', 'Crowded niches to avoid:');
    for (const item of crowded) lines.push(`- ${item.summary} (ref: ${item.ref})`);
  }
  if (empty.length > 0) {
    lines.push('', 'Empty niches to target:');
    for (const item of empty) lines.push(`- ${item.summary} (ref: ${item.ref})`);
  }
  return lines.join('\n');
}

function buildFederatedSeedPriming(
  seeds: readonly FederatedSeedView[],
  cfg: FederatedPrimingConfig,
): string | undefined {
  if (cfg.foreignElites <= 0) return undefined;
  const picked = seeds.slice(0, cfg.foreignElites);
  if (picked.length === 0) return undefined;
  const lines = [
    '## Federated mutation seeds',
    'These won in a distant context. Recombine their mechanism with local friction; do not clone them verbatim. If you adapt one, cite it in `seededByRefs`.',
  ];
  for (const seed of picked) {
    const where = `${seed.scope}|${seed.domain}|${seed.risk}`;
    const adjacency = seed.adjacentLocalNiche ? `; one-step from local ${seed.adjacentLocalNiche}` : '';
    const novelty = seed.noveltyGift ? '; novelty gift' : '';
    lines.push(
      `- [${seed.sourceHive}] ${where} (fitness ${seed.fitness.toFixed(2)}, ref: ${seed.ref}${adjacency}${novelty})` +
        (seed.rationale ? ` — ${seed.rationale}` : ''),
    );
  }
  return lines.join('\n');
}

/**
 * Production search-first novelty corpus: prior plans (what's been designed) +
 * their ratified decisions (settled judgments) + routed-ledger idea titles (what
 * the Hive already generated and routed, with its won/lost outcome — P-008,
 * su-ideate-learning-substrate-2026-07-10) — the substrate the novelty critic
 * dedupes a fresh idea against (D-005, "reject the already-tried"). Defensive: a
 * failed query yields an empty corpus (the critic then leans on the LLM skeptic),
 * never a crashed cycle. Workspace-global on purpose — an idea must be novel vs the
 * whole Hive's history (D-003), not just one harness's.
 */
export async function readNoveltyCorpus(): Promise<CorpusEntry[]> {
  const out: CorpusEntry[] = [];
  try {
    const { sql } = getOrgPg();
    const plans = await sql<{ plan_slug: string; title: string | null; status: string | null }[]>`
      SELECT plan_slug, title, status
        FROM harness_shared.harness_plans
       WHERE archived = false
       ORDER BY updated DESC NULLS LAST
       LIMIT 500`;
    for (const p of plans) {
      out.push({
        ref: `plan:${p.plan_slug}`,
        kind: 'plan',
        text: p.title?.trim() || p.plan_slug.replace(/-/g, ' '),
        ...(p.status ? { state: p.status } : {}),
      });
    }
    const decisions = await sql<{ plan_slug: string; id: string | null; title: string | null }[]>`
      SELECT p.plan_slug, d->>'id' AS id, d->>'title' AS title
        FROM harness_shared.harness_plans p,
             jsonb_array_elements(COALESCE(p.decisions, '[]'::jsonb)) AS d
       WHERE d->>'title' IS NOT NULL
       LIMIT 1000`;
    for (const r of decisions) {
      if (!r.title) continue;
      out.push({ ref: `${r.plan_slug}#${r.id ?? ''}`, kind: 'decision', text: r.title });
    }
    // Routed-ledger idea titles (P-008): every idea the Hive already routed — the
    // outcome CACHE maps onto the corpus's decided-state vocabulary so a lost
    // idea reads as an already-tried prior ('dropped' ⇒ the alreadyTried penalty
    // + the "already tried, failed" priorArt signal) and a won one as 'shipped'.
    //
    // EI-18697783591503819: this leg was a bare `ORDER BY routed_at DESC LIMIT 500`,
    // which made the corpus FORGET precisely the priors it exists to remember.
    // Three compounding defects, measured 2026-08-03 against a 1,154-row ledger:
    //   1. `routed_ref` is NOT unique (a re-route appends a row), so 500 raw rows
    //      carried only 275 DISTINCT refs — 45% of the window re-read priors it
    //      already had.
    //   2. Recency eviction is BACKWARDS for this signal. An "already tried and
    //      failed" prior does not decay; it is the most decision-relevant entry in
    //      the corpus and only grows more authoritative with age. Evicting
    //      oldest-first drops exactly those: 630 of 697 distinct refs are decided,
    //      but only 488 survived the window.
    //   3. Together they slid the visible cutoff to 07-12 on a ledger reaching back
    //      to 06-11 — so the entire 07-01 immunology/self-tag cluster aged out of
    //      view and Scout re-generated that one already-falsified idea 21 more
    //      times, each re-filing costing an agent a wake to re-derive the same
    //      falsification (EI-5878/5850/5882/5896 all independently deprecated).
    // Fix: one row per ref (most recent), DECIDED priors first, then recency. At
    // LIMIT 1000 (the decisions leg's own bound) that covers the whole current
    // ledger — 697 distinct refs — while reading ~40% more rows than before.
    const ideas = await sql<{ routed_ref: string; title: string | null; outcome: string | null }[]>`
      SELECT routed_ref, title, outcome
        FROM (
          SELECT DISTINCT ON (routed_ref) routed_ref, title, outcome, routed_at
            FROM harness_shared.scout_routed_ideas
           WHERE title IS NOT NULL
             -- counterfactual-critique-lab D-001: shadow trial variants are
             -- synthetic re-writes of ideas ALREADY in this corpus, so admitting
             -- them would both double-count each source and let a trial artifact
             -- steer future generation — the "no prompt or routing behavior
             -- changes from trial results automatically" line. This is the leak
             -- that does NOT close itself: the two watchdog readers pin
             -- origin='su-ideate' and the lens-weight readers pin origin='scout',
             -- but this one filters on the title column alone.
             AND origin <> ${SHADOW_VARIANT_ORIGIN}
           ORDER BY routed_ref, routed_at DESC
        ) d
       ORDER BY (outcome IS NOT NULL) DESC, routed_at DESC
       LIMIT 1000`;
    for (const r of ideas) {
      const text = r.title?.trim();
      if (!text) continue;
      const state = r.outcome === 'won' ? 'shipped' : r.outcome === 'lost' ? 'dropped' : undefined;
      out.push({ ref: r.routed_ref, kind: 'idea', text, ...(state ? { state } : {}) });
    }
  } catch (err) {
    console.warn('[scout/cycle-deps] readNoveltyCorpus failed:', err instanceof Error ? err.message : err);
  }
  return out;
}

/**
 * Assemble the production {@link ScoutCycleDeps}. The router's three dispatch
 * ports are wired from `router-deps` (the broad rail through the injected ctx-bound
 * creator; the testable rail through su-8075f's archive; the concrete rail through
 * the real `captureImprovement`, harness-scoped). Each LLM step takes the
 * recorder-wrapped call `runScoutCycle` passes in.
 */
/** EI-13119: compact per-ideator outcome the ideate leg captures for the tick ledger. */
export interface IdeationSlotOutcome {
  lens: string;
  ok: boolean;
  raw: number;
  produced: number;
  error?: string;
  /** EI-13119: response-text head, present only on ok-but-zero-raw slots. */
  textHead?: string;
  textLen?: number;
  outputTokens?: number;
}

export function buildScoutCycleDeps(
  opts: BuildScoutCycleDepsOptions,
): ScoutCycleDeps & { readonly lastIdeation: IdeationSlotOutcome[] | undefined } {
  // EI-13119: the ideate leg's per-slot outcomes, written by generate() below and read
  // back by the cycle runner AFTER runScoutCycle resolves (via the getter on the returned
  // deps) so the scheduler can persist them on the 'ran' tick detail.
  let lastIdeation: IdeationSlotOutcome[] | undefined;
  const goalFeedbackConsult =
    opts.goalFeedbackConsult ??
    buildGoalFeedbackConsultPort({
      harnessSlug: opts.harnessSlug,
      cycleId: opts.cycleId ?? 'scout-cycle-unscoped',
      workspaceId: activeWorkspaceId(),
    });
  const resolvedGoalConsultReader =
    opts.resolvedGoalConsultReader ??
    (() =>
      readResolvedGoalConsultProposals({
        harnessSlug: opts.harnessSlug,
        workspaceId: activeWorkspaceId(),
      }));
  let goalConsultContinuationDrained = false;
  // P-011: runScoutCycle routes twice — resolved consult continuations first,
  // then fresh proposals. Keep the creation decision budget on the deps instance
  // so those calls share the documented one-goal-per-cycle ceiling instead of
  // each resetting decideRoutes' batch-local counter.
  let remainingGoalCreations = DEFAULT_MAX_GOALS_PER_CYCLE;
  const routerPorts: RouterPorts = {
    plansNew: buildPlansNewPort(opts.createPlanDraft),
    gymDispatch: buildGymDispatchPort(opts.archive),
    capture: opts.capturePort ?? buildCapturePort({ scope: `harness:${opts.harnessSlug}`, ...opts.captureOptions }),
    // whole-system → InstanceSubject (reconciliation P-005). Acknowledge-only until the
    // apiary's intake queue is built — the routed-idea ledger (rail='instance') is the
    // pending-candidate record the apiary reads.
    instanceDispatch: buildInstanceDispatchPort(),
    // goal-scale → goals create+start (P-013 / D-005): the full-auto goal rail. The
    // BLENDER_GOAL_RAIL flag gates it at route time (goalEnabled below), not here.
    goalDispatch:
      opts.goalDispatch ??
      buildGoalDispatchPort({ harnessSlug: opts.harnessSlug, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) }),
    // goal-with-target → goals:update (D-004/D-013): zero spend and no launch.
    // This is deliberately a sibling port on the SAME rail, not a sixth rail.
    goalAmendmentDispatch:
      opts.goalAmendmentDispatch ?? buildGoalAmendmentDispatchPort({ harnessSlug: opts.harnessSlug }),
    // D-010: independent feedback before either goal-rail write shape.
    goalFeedbackConsult,
  };

  const baseReaders = opts.stateOfHiveReaders ?? buildStateOfHiveReaders();
  // P-004 / D-028 (learning-loop-identity-and-consumption-2026-08-08): capture the ids
  // the friction lane actually READ this cycle, so `readCorpus` can stamp them as
  // consumed. Wrapping the reader — rather than re-querying the lane afterwards — is
  // what makes the stamped set provably the set the digest saw: a second read is a
  // different recency window and would drift from it under load.
  let lastFrictionIds: string[] = [];
  const readers: typeof baseReaders = {
    ...baseReaders,
    friction: async () => {
      const rows = await baseReaders.friction();
      lastFrictionIds = rows.map((r) => r.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
      return rows;
    },
  };
  const noveltyCorpus = opts.noveltyCorpus ?? readNoveltyCorpus;
  const scoutConfig = opts.scoutConfig ?? DEFAULT_SCOUT_CONFIG;
  const baseFederatedPriming = scoutConfig.federatedPriming;

  async function readFederatedPriming(): Promise<FederatedPrimingConfig> {
    try {
      const steering = await getOwnerSteering(activeWorkspaceId(), opts.harnessSlug);
      return resolveFederatedPrimingConfig(steering.federatedPriming ?? baseFederatedPriming);
    } catch {
      return { ...baseFederatedPriming };
    }
  }

  async function readFederatedArchive(): Promise<{
    merged: FederatedMapEliteRow[];
    foreignSeeds: FederatedSeedView[];
  }> {
    try {
      const { sql } = getOrgPg();
      const rows = (await sql<FederatedArchiveSqlRow[]>`
        SELECT
          niche_key,
          candidate_id,
          scope,
          domain,
          risk,
          fitness,
          rationale,
          NULL::text AS source_hive,
          NULL::boolean AS novelty_gift
        FROM harness_shared.gym_qd_archive
        WHERE workspace_id = ${activeWorkspaceId()}
          AND harness_slug = ${opts.harnessSlug}

        UNION ALL

        SELECT
          niche_key,
          candidate_id,
          scope,
          domain,
          risk,
          fitness,
          rationale,
          source_hive,
          novelty_gift
        FROM harness_shared.gym_qd_foreign_elites
        WHERE workspace_id = ${activeWorkspaceId()}
          AND harness_slug = ${opts.harnessSlug}
      `) as FederatedArchiveSqlRow[];

      const local = rows
        .filter((row) => !row.source_hive)
        .map((row) => ({
          nicheKey: row.niche_key,
          scope: row.scope,
          domain: row.domain,
          risk: row.risk,
        }));

      const foreignSeeds = rows
        .filter((row) => !!row.source_hive)
        .map<FederatedSeedView>((row) => {
          const adjacentLocal = local
            .filter((candidate) => changedGymDims(candidate, row) === 1)
            .map((candidate) => candidate.nicheKey)
            .sort()[0];
          return {
            ref: `elite:${row.source_hive}:${row.niche_key}:${row.candidate_id}`,
            nicheKey: row.niche_key,
            fitness: Number(row.fitness),
            rationale: row.rationale,
            sourceHive: row.source_hive!,
            scope: row.scope,
            domain: row.domain,
            risk: row.risk,
            ...(adjacentLocal ? { adjacentLocalNiche: adjacentLocal } : {}),
            noveltyGift: row.novelty_gift === true,
          };
        })
        .sort(
          (a, b) =>
            Number(!!b.adjacentLocalNiche) - Number(!!a.adjacentLocalNiche) ||
            Number(b.noveltyGift) - Number(a.noveltyGift) ||
            b.fitness - a.fitness ||
            a.nicheKey.localeCompare(b.nicheKey) ||
            a.sourceHive.localeCompare(b.sourceHive),
        );

      return {
        merged: rows.map((row) => ({
          nicheKey: row.niche_key,
          fitness: Number(row.fitness),
          sourceHive: row.source_hive,
          scope: row.scope,
          domain: row.domain,
          risk: row.risk,
          noveltyGift: row.novelty_gift,
        })),
        foreignSeeds,
      };
    } catch {
      return { merged: [], foreignSeeds: [] };
    }
  }

  return {
    llmCall: opts.llmCall,
    limits: opts.limits,
    cycleId: opts.cycleId,
    get lastIdeation() {
      return lastIdeation;
    },
    ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
    ...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
    readCorpus: async () => {
      const federatedPriming = await readFederatedPriming();
      const digest = await synthesizeStateOfHive(readers, opts.digestOptions);
      // L1c (queen-memory-hybrid): fold live standing facts (harness + workspace
      // scopes) into the digest as a pattern lane so ideation is grounded in the
      // fleet's deterministic conclusions. Fail-soft — a facts outage never
      // disturbs the digest or the cycle.
      try {
        const { foldFacts } = await import('../agent-facts/store');
        const facts = await foldFacts([{ scope: 'workspace' }, { scope: 'harness', scopeRef: opts.harnessSlug }], {});
        if (facts.length > 0) {
          digest.standingFacts = facts.map((f) => ({
            summary: f.body,
            ref: `fact:${f.scope}${f.scopeRef ? `:${f.scopeRef}` : ''}:${f.key}`,
            ...(f.sourceRef ? { detail: `src ${f.sourceRef}` } : {}),
          }));
        }
      } catch {
        /* best-effort */
      }
      // NOV-1 (gym-unwedge-scout-novelty): the QD NICHE MAP lane — occupied
      // gym_qd_archive niches (behavior space: scope × domain × risk) so the
      // ideators actively steer toward UNEXPLORED territory (quality-diversity
      // novelty search). Fail-soft; an empty archive adds nothing.
      try {
        const { merged } = await readFederatedArchive();
        const nicheMap = buildFederatedMapLane(merged, {
          crowdedLimit: federatedPriming.crowded,
          emptyLimit: federatedPriming.empty,
        });
        if (nicheMap.length > 0) digest.nicheMap = nicheMap;
      } catch {
        /* best-effort */
      }
      // Scout `rubric` rail (plan-templates-and-rubric-v2 P-009, SCOUT_RUBRIC_RAIL,
      // default OFF): on a detected RUBRIC GAP (digest.rubricGaps, P-008) AUTHOR a
      // `template: rubric` DRAFT plan → the existing queen↔scout loop ratifies it into
      // an active rubric. Forked HERE (not the `route` port) because this is the seam
      // that holds the full StateOfHiveDigest (rubricGaps lives off the digest, not the
      // proposal flow). Best-effort + idempotent (a stable per-gap slug no-ops on
      // re-run): a failure or missing PG NEVER disturbs the digest or the cycle.
      try {
        if (!opts.deferDispatch && digest.rubricGaps.length > 0) {
          const { getFlag } = await import('@papercusp/flags/server');
          const { FLAGS } = await import('@papercusp/flags');
          if (await getFlag(FLAGS.SCOUT_RUBRIC_RAIL, 'scout-rubric-rail')) {
            const { authorRubricGapPlans } = await import('./rubric-rail');
            const { createScoutPlanDraft } = await import('./scout-plan-draft');
            await authorRubricGapPlans(
              digest.rubricGaps,
              { harnessSlug: opts.harnessSlug },
              opts.onScoutDraftCreated
                ? {
                    createDraft: async (input) => {
                      const res = await createScoutPlanDraft(input);
                      if (res.created) {
                        try {
                          await opts.onScoutDraftCreated?.({ slug: res.slug, title: input.title });
                        } catch {
                          /* best-effort — a notify never breaks rubric authoring */
                        }
                      }
                      return res;
                    },
                  }
                : undefined,
            );
          }
        }
      } catch (err) {
        console.warn(
          '[scout/cycle-deps] rubric-rail author failed (cycle unaffected):',
          err instanceof Error ? err.message : err,
        );
      }
      // WATCHDOG-HEALTH lane (blender-self-learning-2026-07-12 P-007): chronic
      // collector signals + standing open conditions from watchdog_ticks, fed
      // to ideation directly. Fail-soft (the lane module returns [] on outage).
      try {
        const { buildWatchdogHealthLane } = await import('./watchdog-health-lane');
        const lane = await buildWatchdogHealthLane();
        if (lane.length > 0) digest.watchdogHealth = lane;
      } catch {
        /* best-effort */
      }
      // PTY-HOST-HEALTH: the host's durable event stream already reaches
      // Postgres; surface failures and recovered retries to the same grounded
      // corpus the ideators read. An unavailable store drops only this lane.
      try {
        const { buildPtyHostHealthLane } = await import('./pty-host-health-lane');
        const lane = await buildPtyHostHealthLane();
        if (lane.length > 0) digest.ptyHostHealth = lane;
      } catch {
        /* best-effort */
      }
      // Keep gate file-run evidence separate from local flakiness, and only
      // call a local pass a divergence when it used the same clean commit.
      try {
        const { buildCiTestHealthLane } = await import('./ci-test-health-lane');
        const lane = await buildCiTestHealthLane();
        if (lane.length > 0) digest.ciTestHealth = lane;
      } catch {
        /* best-effort */
      }
      try {
        const { buildWorkspaceHostHealthLane } = await import('./workspace-host-health-lane');
        const lane = await buildWorkspaceHostHealthLane();
        if (lane.length > 0) digest.workspaceHostHealth = lane;
      } catch {
        /* best-effort */
      }
      try {
        const { buildSystemHealthFlapLane } = await import('./system-health-flap-lane');
        const lane = await buildSystemHealthFlapLane();
        if (lane.length > 0) digest.systemHealthFlaps = lane;
      } catch {
        /* best-effort */
      }
      try {
        const { buildBrowserCrashHealthLane } = await import('./browser-crash-health-lane');
        const lane = await buildBrowserCrashHealthLane();
        if (lane.length > 0) digest.browserCrashHealth = lane;
      } catch {
        /* best-effort */
      }
      // GATE / PIPELINE-HEALTH lane (blender-self-learning-2026-07-12 P-010 /
      // WI-4455): the release ship-path — standing gate reds + stall,
      // promotion/deploy lag, and chronic pipeline_events failures, joined into
      // one incident. Fail-soft (the lane module returns [] on outage / no gate).
      try {
        const { buildGatePipelineHealthLane } = await import('./gate-pipeline-health-lane');
        const gpLane = await buildGatePipelineHealthLane();
        if (gpLane.length > 0) digest.gatePipelineHealth = gpLane;
      } catch {
        /* best-effort */
      }
      // COORD-HEALTH lane (blender-self-learning-2026-07-12 P-008 / WI-4453):
      // coordination breakdown from coord_event_log — re-mounting escalation
      // storms (leaking dedup gate), fleet-wide unanswered directed mail, per-
      // recipient inbox/wake floods, claim conflicts. Fail-soft (the lane module
      // returns [] on outage).
      try {
        const { buildCoordHealthLane } = await import('./coord-health-lane');
        const chLane = await buildCoordHealthLane();
        if (chLane.length > 0) digest.coordHealth = chLane;
      } catch {
        /* best-effort */
      }
      // TOOL-TELEMETRY lane (blender-self-learning-2026-07-12 P-009 / WI-4454):
      // measured tool DX friction from tool_invocations — per-tool error rates,
      // arg-limit rejections, retry/batching-waste loops, chronic p95 latency.
      // Fail-soft (the lane module returns [] on outage).
      try {
        const { buildToolTelemetryLane } = await import('./tool-telemetry-lane');
        const ttLane = await buildToolTelemetryLane();
        if (ttLane.length > 0) digest.toolTelemetry = ttLane;
      } catch {
        /* best-effort */
      }
      // P-011 (blender-self-learning): the four deferred curation signals reuse
      // existing spend, owner-feedback/facts, knowledge-demand/recipe, and plan
      // stores. One source failing drops only its lane; the module is fail-soft.
      try {
        const { buildCurationSignalLanes } = await import('./curation-signal-lanes');
        const lanes = await buildCurationSignalLanes({ harnessSlug: opts.harnessSlug });
        if (lanes.spendAnomalies.length > 0) digest.spendAnomalies = lanes.spendAnomalies;
        if (lanes.ownerCorrections.length > 0) digest.ownerCorrections = lanes.ownerCorrections;
        if (lanes.knowledgeReuseGaps.length > 0) digest.knowledgeReuseGaps = lanes.knowledgeReuseGaps;
        if (lanes.planHealth.length > 0) digest.planHealth = lanes.planHealth;
      } catch {
        /* best-effort */
      }
      // RECENT-COMMIT CHURN lane (NOV-2 / WI-4635): repo-area rollup of recently-
      // touched file paths — the exogenous stimulus so ideation also sees where
      // the tree is actively morphing, independent of whether a work-item tracked
      // the edit. Fail-soft (the lane module returns [] on a non-git tree / spawn
      // failure / outage).
      try {
        const { buildRecentCommitLane } = await import('./exogenous-commit-lane');
        const commitLane = await buildRecentCommitLane();
        if (commitLane.length > 0) digest.recentCommits = commitLane;
      } catch {
        /* best-effort */
      }
      // P-007 dedup-burn guard (WI-39479): stamp the runner's saturation verdict
      // so renderDigest drops the standing patterns + leads with the banner.
      // Stamped BEFORE the snapshot persist below, so the persisted row records
      // that this cycle ran saturated (Learning-tab diagnosability). flattenDigest
      // walks lanes only, so the stamp never feeds the next cycle's ref baseline.
      if (opts.dedupSaturation) digest.dedupSaturation = opts.dedupSaturation;
      // DELTA-FIRST substrate (blender-self-learning-2026-07-12 P-003 /
      // WI-4319): diff this digest against the previous fired cycle's persisted
      // snapshot — read the previous refs, persist the CLEAN fresh digest as
      // the new snapshot, then stamp `previousCycleRefs` so renderDigest leads
      // the ideator prompt with "NEW since your last cycle". Best-effort by
      // contract: a snapshot outage never disturbs the digest or the cycle,
      // and no stamp = the legacy whole-digest rendering.
      try {
        const { readPreviousSnapshotRefs, persistDigestSnapshot } = await import('./digest-snapshots');
        const prevRefs = await readPreviousSnapshotRefs();
        // Stamp BEFORE persist (owner-reported 2026-07-19: every Signals cycle showed
        // "delta leg was empty"): the persisted row is what the Learning-tab reader
        // splits new-vs-standing from, and the old persist-then-stamp order meant NO
        // row ever carried its baseline — the delta split was structurally empty for
        // every cycle. flattenDigest walks lanes only, so the stamped key never
        // feeds the next cycle's readPreviousSnapshotRefs baseline (chain unchanged).
        if (prevRefs.size > 0) digest.previousCycleRefs = [...prevRefs];
        await persistDigestSnapshot({
          digest,
          installSlug: opts.harnessSlug,
          cycleId: opts.cycleId ?? null,
        });
      } catch (err) {
        console.warn(
          '[scout/cycle-deps] digest-snapshot leg failed (cycle unaffected):',
          err instanceof Error ? err.message : err,
        );
      }
      // P-004 / D-028: WRITE BACK that this cycle read these observations. The
      // ratified defect (D-001) is precisely that the blender reads every new
      // observation and records nothing, leaving a mined row byte-identical to an
      // unread one. Stamps `payload.consumption`; deliberately touches NO lifecycle
      // state — D-005 makes the observation lane a time series where `status='open'`
      // is its designed resting state, and a prior bulk-close of 806 rows was a
      // mistake. Runs LAST so every digest lane is populated and the pattern refs
      // are complete. Fail-soft by contract (the helper never throws).
      if (opts.cycleId) {
        const { recordObservationConsumption } = await import('../harness/improvements/observation-consumption');
        const res = await recordObservationConsumption({
          workspaceId: activeWorkspaceId(),
          readIds: lastFrictionIds,
          digest,
          cycleId: opts.cycleId,
        });
        if (res.error) {
          console.warn('[scout/cycle-deps] observation-consumption stamp failed (cycle unaffected):', res.error);
        }
      }
      return digest;
    },
    readNoveltyCorpus: noveltyCorpus,
    // D-009 closure (P-013 → P-004 meta-learning): bias the EXTRA ideators toward
    // the lenses that have been winning, read from the PERSISTED scout_lens_weights
    // table (written by refreshScoutOutcomes after each cycle — P-033). Uniform at
    // cold start / on a PG hiccup, and the sampling floor (≥15% of uniform per lens)
    // keeps every lens alive (D-004). BUT when the per-cycle budget clamps
    // the roster (D-010), the cap wins — skip the meta-learned extras so the cycle
    // never over-spends (extraIdeatorBudget would otherwise add ideators past the cap).
    ideate: async (digest, ctx) => {
      const federatedPriming = await readFederatedPriming();
      // WI-5041 lens rotation: only when the budget will actually cap the roster,
      // read per-lens last-routed recency so the capped window runs the STALEST
      // lenses first (>=4 distinct/7d bar). Fail-soft: a ledger hiccup degrades
      // to the legacy configured-order truncation, never blocks the cycle.
      const capped = ctx.maxIdeators != null && ctx.maxIdeators < scoutConfig.lenses.length;
      const lensRecency = capped
        ? await readLensRecency().catch((err) => {
            console.warn(
              '[scout/cycle-deps] lens-recency read failed (rotation degraded to configured order):',
              err instanceof Error ? err.message : err,
            );
            return undefined;
          })
        : undefined;
      const roster = rosterForBudget(ctx.maxIdeators, scoutConfig.lenses, lensRecency);
      const weighting = roster.lenses ? {} : await getScoutLensWeights({ harnessSlug: opts.harnessSlug });
      // P-012 archive→Scout FEED: prime the ideators with the gym QD archive's diverse
      // elites (stepping-stones), so Scout builds on / leaps away from what the gym has
      // found. Empty/no-op archive ⇒ no stones ⇒ no priming block (clean cold start).
      const { stones, priming } = gatherSteppingStones(opts.archive);
      // C-4 grader feedback (scout-idea-grading P-005): owner/Queen grades on recently
      // routed ideas, concatenated BELOW the stepping-stones on the same priming
      // channel. No graded rows / read failure ⇒ no block (clean cold start).
      const grader = await gatherGraderFeedbackPriming({
        harnessSlug: opts.harnessSlug,
        ...(opts.graderFeedbackReader ? { readRows: opts.graderFeedbackReader } : {}),
      });
      // EI-20220012252019651: remind each ideator of recent Scout-origin filings
      // from this harness so a repeated standing query becomes an amendment (or
      // a consciously new angle) instead of another near-duplicate. The reader
      // is bounded and fail-open like grader priming, so history availability
      // never blocks a cycle.
      const recentScoutFilings = await gatherRecentScoutFilingPriming({
        harnessSlug: opts.harnessSlug,
        ...(opts.recentScoutFilingReader ? { readRows: opts.recentScoutFilingReader } : {}),
      });
      const { foreignSeeds } = await readFederatedArchive();
      const nicheMapPriming = buildNicheMapPriming(digest.nicheMap ?? [], federatedPriming);
      const federatedSeedPriming = buildFederatedSeedPriming(foreignSeeds, federatedPriming);
      const primingBlocks = [
        ...(federatedSeedPriming ? [federatedSeedPriming] : []),
        ...(stones.length ? [priming] : []),
        ...(grader.priming ? [grader.priming] : []),
        ...(recentScoutFilings.priming ? [recentScoutFilings.priming] : []),
      ];
      const ideated = await runIdeators(digest, {
        llmCall: ctx.llmCall,
        ...roster,
        ...weighting,
        ...(primingBlocks.length ? { priming: primingBlocks.join('\n\n') } : {}),
        ...(nicheMapPriming ? { nicheMapPriming } : {}),
        // P-010: per-blueprint ideator mission framing (default ⇒ byte-identical).
        mission: scoutConfig.framing.ideatorMission,
        model: scoutConfig.models.ideator,
        // WI-4475: the owning cycle's deadline bounds the ADMISSION wait (queueing behind the
        // shared rate-limit governor), while the ideator's own cap bounds GENERATION. Absent ⇒
        // unchanged behavior.
        ...(ctx.deadlineMs !== undefined ? { cycleDeadlineMs: ctx.deadlineMs } : {}),
      });
      // P-002 (transport-death observability): if EVERY ideator errored AND zero ideas
      // resulted, this is a TOTAL transport failure (gateway wedge / token 401 — $0 spent),
      // NOT a healthy 'no-ideas' cycle. Throw so the scheduler records an error tick + backs
      // the autoloop fire-gate off, instead of a benign 'ran/no-ideas' that hammers a dead
      // gateway every cadence. Partial failures still return their ideas (one dead ideator
      // never kills the batch — the existing defensive contract in runIdeators).
      if (ideated.ideas.length === 0 && ideated.ideators.length > 0 && ideated.ideators.every((i) => !i.ok)) {
        throw new ScoutIdeatorsTransportError(
          ideated.ideators.length,
          ideated.ideators.find((i) => i.error)?.error,
          ideated.ideators.find((i) => i.admissionDenial)?.admissionDenial,
        );
      }
      // EI-13119: persist the per-slot outcomes for the tick ledger — a 'ran/no-ideas'
      // tick must be distinguishable (quiet corpus vs parse-swallow vs partial failures)
      // without re-probing the live path from scratch (the 07-14..16 outage class).
      lastIdeation = ideated.ideators.map((i) => ({
        lens: i.lens,
        ok: i.ok,
        raw: i.raw,
        produced: i.produced,
        ...(i.error ? { error: String(i.error).slice(0, 120) } : {}),
        ...(i.textHead !== undefined ? { textHead: i.textHead, textLen: i.textLen, outputTokens: i.outputTokens } : {}),
      }));
      return ideated.ideas;
    },
    critique: async (ideas, ctx) =>
      (
        await critiqueIdeas(
          ideas,
          ctx.corpus,
          { llmCall: ctx.llmCall },
          {
            novelty: scoutConfig.novelty,
            bucket: scoutConfig.buckets,
            // P-010: per-blueprint critic mission framing (default ⇒ byte-identical).
            critic: {
              mission: scoutConfig.framing.criticMission,
              model: scoutConfig.models.critic,
              ...(ctx.deadlineMs !== undefined ? { cycleDeadlineMs: ctx.deadlineMs } : {}),
            },
          },
        )
      ).critiques,
    recombine: async (scored, ctx) =>
      (
        await recombineProposals(
          scored,
          { llmCall: ctx.llmCall },
          {
            model: scoutConfig.models.recombine,
            ...(ctx.deadlineMs !== undefined ? { cycleDeadlineMs: ctx.deadlineMs } : {}),
          },
        )
      ).proposals,
    // The whole-system override realizes the P-005 split: a testable WHOLE-SYSTEM proposal
    // (genome's interacting wholes) routes to the InstanceSubject; a component idea stays on
    // the gym (HarnessSubject). plan/improvement/unhinted ideas are untouched.
    route: async (proposals) => {
      // This port runs once with [] BEFORE ideation, then with fresh proposals.
      // Exit before consultation reads as well as every proposal/experiment sink.
      // Returning no routing receipts keeps the ledger honest; cycle.proposals
      // still retains the generated proposals for separate bounded evaluation.
      if (opts.deferDispatch) return [];
      // D-003 (blender-loop-repair-2026-08-16 P-002): resolve gym liveness and
      // gate the rail — a disabled autoloop must not receive routed ideas (its
      // frozen archive verdicts poisoned 80.4% of decided outcomes). Fail-open
      // to enabled: a broken liveness read must not silently divert routing.
      let gymEnabled = true;
      try {
        const { sql } = getOrgPg();
        const { listAutoloopsForWorkspace } = await import('../gym/control-plane');
        const loops = await listAutoloopsForWorkspace(sql, { workspaceId: activeWorkspaceId() });
        gymEnabled = loops.some((l) => l.enabled === true);
      } catch (err) {
        console.warn(
          '[scout/cycle-deps] gym-liveness read failed — gym rail stays enabled (fail-open):',
          err instanceof Error ? err.message : err,
        );
      }
      // P-013 / D-005: the goal rail's gate — the BLENDER_GOAL_RAIL flag (default ON,
      // the cuttable kill-switch). Fail-open to ON like the gym read above: a broken
      // flag read must not silently divert routing off the default.
      let goalEnabled = true;
      try {
        const { getFlag } = await import('@papercusp/flags/server');
        const { FLAGS } = await import('@papercusp/flags');
        goalEnabled = await getFlag(FLAGS.BLENDER_GOAL_RAIL, 'scout-goal-rail');
      } catch (err) {
        console.warn(
          '[scout/cycle-deps] goal-rail flag read failed — goal rail stays enabled (fail-open):',
          err instanceof Error ? err.message : err,
        );
      }
      // Compose the two hint-bumping overrides: their domains are disjoint by
      // construction (goal bumps 'plan'-hinted proposals, instance bumps 'gym'-hinted).
      const goalOverride = makeGoalScaleOverride(scoutConfig.routing.goalScaleMarkers);
      const instanceOverride = makeWholeSystemInstanceOverride(scoutConfig.routing.wholeSystemMarkers);
      // D-010 continuation: terminal consults from older stage-artifact rows
      // re-enter BEFORE new proposals, so the one-goal-per-cycle cap favors the
      // already-reviewed work. Open consults remain deferred and are not polled.
      let resumedGoalProposals: Proposal[] = [];
      if (!goalConsultContinuationDrained) {
        goalConsultContinuationDrained = true;
        try {
          resumedGoalProposals = await resolvedGoalConsultReader();
        } catch (err) {
          console.warn(
            '[scout/cycle-deps] goal-consult continuation read failed — new goal proposals still consult normally:',
            err instanceof Error ? err.message : err,
          );
        }
      }
      const routedProposals = [...resumedGoalProposals, ...proposals];
      const creationProposalIds = new Set(
        routedProposals.filter((proposal) => !proposal.targetGoalId?.trim()).map((proposal) => proposal.id),
      );
      const result = await routeProposals(routedProposals, routerPorts, {
        override: (p) => goalOverride(p) ?? instanceOverride(p),
        defaultRail: scoutConfig.routing.defaultRail,
        gymEnabled,
        goalEnabled,
        maxGoalsPerCycle: remainingGoalCreations,
        goalBudgetCentsCap: scoutConfig.routing.goalBudgetCentsCap,
        cycleId: opts.cycleId,
      });
      const creationDecisions = result.decisions.filter(
        (decision) => decision.rail === 'goal' && creationProposalIds.has(decision.proposalId),
      ).length;
      remainingGoalCreations = Math.max(0, remainingGoalCreations - creationDecisions);
      // Dark Scout→experiment rail (SCOUT_EXPERIMENT_RAIL, default OFF — #2 "close the
      // loop"): ADDITIVELY express each testable (gym-rail) proposal as a DRY-RUN
      // experiment spec — proves the Scout→experiment:run loop with NO spend + NO change
      // to gym routing. Best-effort: a failure never disturbs the cycle's routing.
      try {
        const { getFlag } = await import('@papercusp/flags/server');
        const { FLAGS } = await import('@papercusp/flags');
        if (await getFlag(FLAGS.SCOUT_EXPERIMENT_RAIL, 'scout-experiment-rail')) {
          const { forkTestableToExperiments, buildExperimentDispatchPort } = await import('./experiment-rail');
          const { generateExperimentRequest } = await import('./experiment-generate');
          // Armed: LLM-generate a sharp candidate overlay + case per proposal (spends ~1
          // small LLM call each, bounded by the ≤maxGroups testable proposals/cycle),
          // falling back to the mechanical mapping on any failure. The dry-run after is $0.
          await forkTestableToExperiments(
            result.decisions,
            proposals,
            opts.experimentDispatch ?? buildExperimentDispatchPort(),
            (p) => generateExperimentRequest(p, opts.llmCall, { model: scoutConfig.models.experiment }),
          );
        }
      } catch (err) {
        console.warn(
          '[scout/cycle-deps] experiment-rail fork failed (cycle unaffected):',
          err instanceof Error ? err.message : err,
        );
      }
      return result.decisions;
    },
  };
}
