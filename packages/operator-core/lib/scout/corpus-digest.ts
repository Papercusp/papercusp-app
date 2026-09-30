/**
 * corpus-digest.ts — the "state of the Hive" corpus digest (Scout loop, step 1).
 *
 * Plan: hive-creative-ideation-2026-06-08 P-003 (build-item B1) — "Corpus
 * synthesis: a 'state of the Hive' digest of cross-corpus meta-patterns
 * (recurring friction, time/token sinks, chronic deferrals, capability gaps)
 * over the change feed + completions + reverts."
 *
 * This is the GENERATIVE-EXPLORATION substrate: the Scout loop's divergent
 * ideators (P-004) read this digest instead of per-turn context, because the
 * introspection it performs — rolling up META-patterns across the Hive's whole
 * operational history — is structurally impossible for the per-turn idea queue
 * (self-learning-central D-003: "the Hive's complete operational history is the
 * creative substrate").
 *
 * INTEGRATION CONTRACT (with su-797a5's scout/types.ts, affirmed by su-b6c3f's
 * verification-lane contract): the four ref-carrying lanes ARE the shared
 * {@link CorpusDigest} (types.ts is the single source of truth for the consumed
 * shape; this file is the production PRODUCER of it). {@link StateOfHiveDigest}
 * is a structural SUPERSET — the 4 `CorpusDigest` lanes plus a `reverts` churn
 * substrate (P-003's third input) and a `corpus` rollup — so it is directly
 * assignable to `CorpusDigest`; the ideators / `flattenDigest` / `digestRefSet`
 * read only the 4 lanes and ignore the extras. No adapter seam needed.
 *
 * DESIGN — deterministic, not an LLM call (mirrors curation/change-feed.ts):
 * the digest is a PURE, REGENERABLE rollup over injected readers. The creative
 * LEAP happens DOWNSTREAM (the P-004 ideators); the digest's job is to be the
 * grounded, queryable, ref-carrying substrate they leap FROM. Keeping it
 * deterministic makes it cheap (no per-cycle model spend just to summarise) and
 * exhaustively testable. Each pattern's `ref` drills back to the original (the
 * change-feed pattern — never a duplicated log).
 */

import { z } from 'zod';
import type { ChangeFeedEntry } from '../curation/change-feed';
import {
  DOMAIN_VOCAB,
  RISK_BANDS,
  SCOPE_BANDS,
  nicheKey as gymNicheKey,
  type RiskBand,
  type ScopeBand,
} from '../gym/qd/niche';
import { dedupSignature, findLikelyDuplicates, signatureRecurrence } from '../harness/improvements/digest';
import { clusterFrictionByEmbedding } from './digest-embed-cluster-leg';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import { computeDepthAwareCrowding, type FederatedEliteView } from './federated-priming';
import type { MetaPattern, MetaPatternCategory } from './types';

// ---------------------------------------------------------------------------
// Raw input records (what the readers gather; normalised by synthesize).
// ---------------------------------------------------------------------------

/**
 * A status-regression event = work that was UNDONE (the "reverts" substrate).
 * Sourced from feature_audit (field='status'): a transition whose new status is
 * LESS complete than the old (e.g. passed→failing, passed→todo, validating→todo,
 * passed→deprecated). The strongest revert is undoing terminal-good work.
 */
export interface RevertRecord {
  /** The work item whose status regressed (feature/issue id). */
  workItemId: string;
  harness?: string;
  /** Status before (e.g. "passed"). */
  from: string;
  /** Status after (e.g. "failing"). */
  to: string;
  /** Who/what caused the transition (audit actor), when recorded. */
  actor?: string | null;
  /** ISO timestamp of the transition. */
  ts: string;
  /** A reason attached to the terminal deprecation transition, when present. */
  reason?: string | null;
}

/**
 * One aggregated spend bucket = where time/tokens went. Sourced from
 * agent_usage_samples, grouped by (harness, role). `costUsd` is the spend;
 * `runs` is how many samples rolled up.
 */
export interface SpendRecord {
  harness?: string | null;
  role?: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  runs: number;
}

/**
 * A deferral = something the Hive explicitly put off. Two sources, one shape:
 *  - a plan ITEM whose status is `blocked` or `needs-human` (an explicit punt;
 *    a normal dependency-blocked todo is NOT a deferral and is excluded), or
 *  - a plan DECISION whose body marks a deferral ("deferred to a follow-up").
 */
export interface DeferralRecord {
  planSlug: string;
  /** The plan-item id (P-NNN) or decision id (D-NNN). */
  refId: string;
  /** 'item' | 'decision' — where the deferral lives. */
  source: 'item' | 'decision';
  /** Item status (`blocked`/`needs-human`) or 'decision' for a deferred decision. */
  status: string;
  /** The item text / decision title — the thing being deferred. */
  text: string;
}

/**
 * One criterion's rating inside a structured observation — the Record VALUE; the
 * criterion is the Record KEY (rubric-driven-observations-2026-06-20 D-003). The
 * rating is a value from the rubric criterion's scale (default
 * `healthy|degraded|broken|unknown`); `evidence` is mandatory per D-003.
 */
export interface ObservationRating {
  rating: string;
  evidence: string;
  /** OPTIONAL grader suggestion (blender-self-learning-2026-07-12 P-005): the
   *  grader's concrete improvement idea for this criterion — surfaced on the
   *  rubric-rating pattern detail so the ideators can adopt/adapt it. */
  suggestion?: string;
}

/**
 * The structured-observation view the digest groups over (D-003). The P-001 owner
 * surfaces it onto `ImprovementCandidate.observation`; the deps layer maps that
 * onto this clean record so this pure core never reaches into `payload`. A
 * free-text observation simply carries no `rubricRef`/`ratings` (free-text stays
 * first-class — it still flows through the friction lane). `ratings` is KEYED by
 * the rubric criterion `key` — one rating per criterion (a scorecard).
 */
export interface StructuredObservationRecord {
  /** The observation's engineer_issue id — the drill-back key. */
  id: string;
  /** The observation title — exemplar text for a rating-group summary. */
  title?: string;
  /** Hive the observation came FROM (auto-derived at capture). The grouping axis. */
  sourceHive?: string;
  /** Hive the observation is ABOUT (cross-hive observations); not grouped on in v1. */
  targetHive?: string;
  /** The rubric graded against (a `rubrics.rubric_id`). Required when `ratings` is set. */
  rubricRef?: string;
  /** Per-criterion ratings, keyed by the rubric criterion `key` (one per criterion). */
  ratings?: Record<string, ObservationRating>;
  /** When the observation was last seen (updated/created, ms) — picks the latest evidence. */
  lastSeenMs?: number;
}

/**
 * The minimal view of a rubric the gap-check needs (plan-templates-and-rubric-v2
 * P-008): its id + the text that defines what it MEASURES, so a recurring friction
 * cluster can be tested for an existing covering rubric. The deps layer maps the full
 * `Rubric` (lib/rubrics) → this, keeping the pure core decoupled from the DB types.
 */
export interface RubricSummary {
  rubricId: string;
  /** The umbrella domain (e.g. "hive-coordination") — the primary coverage signal. */
  characteristic: string;
  title: string;
  /** Criterion titles — extra coverage tokens (a rubric covers what its criteria name). */
  criteriaTitles?: string[];
}

/** The injectable source bag — each reader returns one corpus substrate. */
export interface StateOfHiveReaders {
  /** The change feed: completions / proposals / plan-runs (curation/change-feed). */
  completions(): Promise<ChangeFeedEntry[]>;
  /** Reverts: status regressions (undone work). */
  reverts(): Promise<RevertRecord[]>;
  /** Captured friction (the papercusp-improvement queue) for recurrence + gaps. */
  friction(): Promise<ImprovementCandidate[]>;
  /** Spend buckets (where time/tokens went). */
  spend(): Promise<SpendRecord[]>;
  /** Explicit deferrals (blocked / needs-human items + deferred decisions). */
  deferrals(): Promise<DeferralRecord[]>;
  /**
   * Structured observations (rubric-graded scorecards) for the rubric-rating lane
   * (P-006). Distinct from `friction()` (which unions observations as FREE-TEXT
   * for clustering) — this returns the STRUCTURED view so Scout can group by
   * rubric/source-hive + surface ratings. An empty/absent list (no rubric usage
   * yet) just yields an empty lane.
   */
  observations(): Promise<StructuredObservationRecord[]>;
  /**
   * ACTIVE rubrics (plan-templates-and-rubric-v2 P-008) — used to test whether a
   * recurring friction cluster already has a covering rubric. Only ACTIVE rubrics
   * count as coverage (D-003: "an active rubric whose characteristic covers it").
   * An empty list means every recurring cluster is uncovered (max gaps) — the
   * loose, Queen-gated default. Optional so older readers (and the 4-lane fixtures)
   * stay valid; absent ⇒ no rubrics known ⇒ the gap lane treats all as uncovered.
   */
  rubrics?(): Promise<RubricSummary[]>;
  /**
   * OCCURRENCE FLOW per candidate id (EI-20587312505064997) — how many times each
   * friction was actually REPORTED, from `harness_shared.work_item_occurrences`.
   *
   * The friction lane counts STOCK (rows), but capture already records FLOW: dedup
   * collapses a repeat onto its canonical row and appends a ledger row instead of
   * creating a second work-item. So a friction reported 79× is ONE row, and every
   * stock-based measure reads it as a singleton that never recurred.
   *
   * Measured on the observation lane 2026-09-06: 113,785 rows, 97.0% singleton by
   * title; 618 canonicals reach ≥3 occurrences, and **582 of those are BOTH ≥3-flow
   * AND title-singletons** (498 still open) — invisible to clustering by construction,
   * because `findLikelyDuplicates` only ever emits clusters of ≥2 rows.
   *
   * Optional + fail-soft, exactly like `rubrics?()`: absent (or a failed read) ⇒ an
   * empty map ⇒ every count floors at one-per-member ⇒ output is byte-identical to
   * the pre-flow behaviour. That default is what keeps the 4-lane fixtures valid.
   */
  occurrences?(ids: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

// ---------------------------------------------------------------------------
// DigestSchema — the structured output the Scout ideators consume (B1).
// The MetaPattern shape MATCHES scout/types.ts (single source of truth for the
// consumed contract); this zod schema is the runtime validator for it.
// ---------------------------------------------------------------------------

/** The corpus-digest categories (mirrors scout/types.ts MetaPatternCategory):
 *  the four friction lanes + `rubric-rating` (structured measurements, P-006)
 *  + `standing-fact` (agent_facts fold, queen-memory-hybrid L1c). */
const META_PATTERN_CATEGORIES = [
  'recurring-friction',
  'time-token-sink',
  'chronic-deferral',
  'capability-gap',
  'rubric-rating',
  'standing-fact',
  'niche-map',
  'watchdog-health',
  'pty-host-health',
  'ci-test-health',
  'workspace-host-health',
  'system-health-flap',
  'rework-lesson',
  'browser-crash-health',
  'gate-pipeline-health',
  'coord-health',
  'tool-telemetry',
  'spend-anomaly',
  'owner-correction',
  'knowledge-reuse-gap',
  'plan-health',
  'recent-commit',
] as const;

/**
 * Zod validator for one grounded meta-pattern — structurally identical to
 * scout/types.ts `MetaPattern` (a colocated `satisfies` assertion in the tests
 * pins the two together). `weight` is the 0..1 salience the digest's own
 * ranking assigns (top pattern per lane = 1.0); `ref` is the drill-back key.
 */
export const MetaPatternSchema = z.object({
  category: z.enum(META_PATTERN_CATEGORIES).optional(),
  summary: z.string(),
  detail: z.string().optional(),
  ref: z.string(),
  weight: z.number().optional(),
});

/**
 * `DigestSchema` (B1 deliverable) — the validated shape of a "state of the Hive"
 * corpus digest. The four plan-named lanes (the shared {@link CorpusDigest}) +
 * a `reverts` churn substrate + a `corpus` coverage rollup.
 * `z.infer<typeof DigestSchema>` is {@link StateOfHiveDigest}.
 */
export const DigestSchema = z.object({
  /** ISO generation time (deterministic in tests via opts.nowMs). */
  generatedAt: z.string(),
  /** What corpus was scanned — honesty about coverage. */
  corpus: z.object({
    completions: z.number().int().nonnegative(),
    reverts: z.number().int().nonnegative(),
    frictionCaptured: z.number().int().nonnegative(),
    deferrals: z.number().int().nonnegative(),
    spendUsd: z.number(),
    spendBuckets: z.number().int().nonnegative(),
    /** Structured observations scanned (rubric-graded scorecards, P-006). */
    observations: z.number().int().nonnegative(),
    /** Active rubrics scanned for the gap-check (P-008). */
    rubrics: z.number().int().nonnegative(),
  }),
  // The four meta-pattern categories (plan P-003) — the shared CorpusDigest lanes.
  recurringFriction: z.array(MetaPatternSchema),
  timeTokenSinks: z.array(MetaPatternSchema),
  chronicDeferrals: z.array(MetaPatternSchema),
  capabilityGaps: z.array(MetaPatternSchema),
  /** Undone work — status regressions, churniest first (P-003's reverts input). */
  reverts: z.array(MetaPatternSchema),
  /** Structured rubric measurements grouped by (rubric, source-hive, criterion) —
   *  Scout ideates on MEASUREMENTS, not just free-text clusters (P-006). A 5th
   *  CorpusDigest lane (the ideators fold it in via flattenDigest). */
  rubricRatings: z.array(MetaPatternSchema),
  /** RUBRIC GAPS (plan-templates-and-rubric-v2 P-008) — recurring friction clusters
   *  (≥3 distinct authors, recurring across ≥2 day-cycles) with NO covering active
   *  rubric: the "we keep hitting this and have no shared standard for it" signal.
   *  NOT a flattenDigest ideator lane (its patterns carry no `category`, like reverts);
   *  the dedicated consumer is the Scout `rubric` router rail (P-009), which authors a
   *  rubric-template plan from the gap → the queen↔scout loop. Loose by design
   *  (over-propose; the Queen ratification is the real filter — D-003). */
  rubricGaps: z.array(MetaPatternSchema),
  /** STANDING FACTS (queen-memory-hybrid L1c) — live agent_facts (harness +
   *  workspace scopes) projected as patterns (`ref` = `fact:<scope>:<key>`), a
   *  6th flattenDigest ideator lane. OPTIONAL: populated by the cycle seam
   *  (cycle-deps readCorpus), not by synthesizeStateOfHive itself — absent means
   *  no facts stand (or the fold failed soft). */
  standingFacts: z.array(MetaPatternSchema).optional(),
  /** QD NICHE MAP (gym-unwedge NOV-1) — occupied gym_qd_archive niches so the
   *  ideators target unexplored behavior-space. OPTIONAL: populated by the
   *  cycle seam (cycle-deps readCorpus), like standingFacts. */
  nicheMap: z.array(MetaPatternSchema).optional(),
  /** WATCHDOG HEALTH (blender-self-learning-2026-07-12 P-007) — chronic
   *  collector signals + standing open conditions (watchdog_ticks). OPTIONAL:
   *  populated by the cycle seam (cycle-deps readCorpus), like nicheMap. */
  watchdogHealth: z.array(MetaPatternSchema).optional(),
  /** PTY host runtime failures and recovered retries from psu_pty_host_events.
   *  OPTIONAL: populated by the cycle seam, like watchdogHealth. */
  ptyHostHealth: z.array(MetaPatternSchema).optional(),
  /** CI test-run failure recurrence and same-commit local divergence. */
  ciTestHealth: z.array(MetaPatternSchema).optional(),
  /** Managed workspace-host operation failures and later host success. */
  workspaceHostHealth: z.array(MetaPatternSchema).optional(),
  /** Repeated critical health transitions and observed time back to OK. */
  systemHealthFlaps: z.array(MetaPatternSchema).optional(),
  /** Cause-backed lessons from the existing revert substrate. */
  reworkLessons: z.array(MetaPatternSchema).optional(),
  /** Redacted render-boundary crash summaries from local telemetry. */
  browserCrashHealth: z.array(MetaPatternSchema).optional(),
  /** GATE / PIPELINE HEALTH (blender-self-learning-2026-07-12 P-010) — the
   *  release ship-path: standing gate reds + stall, promotion/deploy lag, and
   *  chronic pipeline_events failure classes (WI-4455). OPTIONAL: populated by
   *  the cycle seam (cycle-deps readCorpus), like watchdogHealth. */
  gatePipelineHealth: z.array(MetaPatternSchema).optional(),
  /** COORD HEALTH (blender-self-learning-2026-07-12 P-008 / WI-4453) —
   *  coordination breakdown from coord_event_log: escalation storms, unanswered
   *  directed mail, inbox/wake floods, claim conflicts. OPTIONAL: populated by
   *  the cycle seam (cycle-deps readCorpus), like watchdogHealth. */
  coordHealth: z.array(MetaPatternSchema).optional(),
  /** TOOL TELEMETRY (blender-self-learning-2026-07-12 P-009 / WI-4454) — measured
   *  tool DX friction from tool_invocations: per-tool error rates, arg-limit
   *  rejections, retry/batching-waste loops, chronic p95 latency. OPTIONAL:
   *  populated by the cycle seam (cycle-deps readCorpus), like watchdogHealth. */
  toolTelemetry: z.array(MetaPatternSchema).optional(),
  /** BACKLOG / CURATION HEALTH (blender-self-learning-2026-07-12 P-011) — four
   *  deferred signal lanes projected from existing stores. OPTIONAL + fail-soft,
   *  populated together by the cycle seam before digest snapshot persistence. */
  spendAnomalies: z.array(MetaPatternSchema).optional(),
  ownerCorrections: z.array(MetaPatternSchema).optional(),
  knowledgeReuseGaps: z.array(MetaPatternSchema).optional(),
  planHealth: z.array(MetaPatternSchema).optional(),
  /** RECENT-COMMIT CHURN (NOV-2 / WI-4635) — a repo-area rollup of recently-touched
   *  file paths, the "external entropy" stimulus so ideation is not resampled
   *  purely from Scout's own operational-history readers. OPTIONAL + fail-soft,
   *  populated by the cycle seam (cycle-deps readCorpus), like watchdogHealth. */
  recentCommits: z.array(MetaPatternSchema).optional(),
  /** DELTA-FIRST rendering substrate (blender-self-learning-2026-07-12 P-003 /
   *  WI-4319): the refs the PREVIOUS cycle's persisted digest snapshot carried
   *  (scout_digest_snapshots, migration 582). renderDigest leads with the
   *  patterns NOT in this set ("NEW since your last cycle") before the
   *  standing ones — killing the stale-repetition → dedup-decline churn.
   *  OPTIONAL: stamped by the cycle seam (cycle-deps readCorpus), like
   *  standingFacts; absent ⇒ the legacy whole-digest rendering. */
  previousCycleRefs: z.array(z.string()).optional(),
  /** DEDUP-BURN saturation stamp (blender-loop-repair-and-opus5-xhigh-2026-08-16
   *  P-007 / WI-39479): the dedup-burn guard found consecutive ran-cycles burning
   *  ≥ threshold of their ideas as duplicates. renderDigest drops the standing
   *  patterns (fresh-signal-only when fresh signal exists) + leads with a
   *  saturation banner. OPTIONAL: stamped by the cycle seam (cycle-deps
   *  readCorpus); absent ⇒ unchanged rendering. */
  dedupSaturation: z
    .object({ consecutiveSaturated: z.number(), wideningSteps: z.number() })
    .optional(),
  /** One-line summary for a coord broadcast / the Scout trigger. */
  headline: z.string(),
});

/**
 * The production digest. A structural SUPERSET of the shared {@link CorpusDigest}
 * (the four lanes), adding the `reverts` churn substrate + the `corpus` rollup.
 * Assignable to `CorpusDigest`, so the P-004 ideators consume it directly.
 */
export type StateOfHiveDigest = z.infer<typeof DigestSchema>;

export interface FederatedMapEliteRow {
  nicheKey: string;
  fitness: number;
  sourceHive?: string | null;
  scope?: string | null;
  domain?: string | null;
  risk?: string | null;
  noveltyGift?: boolean | null;
}

export interface BuildFederatedMapLaneOptions {
  crowdedLimit?: number;
  emptyLimit?: number;
  fitnessBar?: number;
}

interface GymNicheCoords {
  scope: ScopeBand;
  domain: string;
  risk: RiskBand;
}

function parseGymCoords(row: FederatedMapEliteRow): GymNicheCoords | null {
  if (row.scope && row.domain && row.risk) {
    if (
      (SCOPE_BANDS as readonly string[]).includes(row.scope) &&
      (RISK_BANDS as readonly string[]).includes(row.risk)
    ) {
      return {
        scope: row.scope as ScopeBand,
        domain: row.domain.trim().toLowerCase(),
        risk: row.risk as RiskBand,
      };
    }
  }
  const m = /^([^|]+)\|([^|]+)\|([^|]+)$/.exec(row.nicheKey);
  if (!m) return null;
  const [, scope, domain, risk] = m;
  if (!(SCOPE_BANDS as readonly string[]).includes(scope) || !(RISK_BANDS as readonly string[]).includes(risk)) {
    return null;
  }
  return {
    scope: scope as ScopeBand,
    domain: domain.trim().toLowerCase(),
    risk: risk as RiskBand,
  };
}

function changedDims(a: GymNicheCoords, b: GymNicheCoords): number {
  return Number(a.scope !== b.scope) + Number(a.domain !== b.domain) + Number(a.risk !== b.risk);
}

function normalizeWeights(patterns: MetaPattern[]): MetaPattern[] {
  if (patterns.length === 0) return [];
  const denom = Math.max(1, patterns.length - 1);
  return patterns.map((pattern, index) => ({
    ...pattern,
    weight: patterns.length === 1 ? 1 : 1 - index / denom,
  }));
}

/**
 * Build the federated niche-map lane over the read-time union of local archive
 * rows and foreign-elite partitions. Crowded niches rank by depth-aware crowding;
 * empty niches prioritize one-step moves from locally occupied niches so Scout
 * proposes reachable novelty before remote leaps.
 */
export function buildFederatedMapLane(
  mergedArchive: readonly FederatedMapEliteRow[],
  opts: BuildFederatedMapLaneOptions = {},
): MetaPattern[] {
  const crowdedLimit = Math.max(0, opts.crowdedLimit ?? 5);
  const emptyLimit = Math.max(0, opts.emptyLimit ?? 5);
  const fitnessBar = Number.isFinite(opts.fitnessBar) ? (opts.fitnessBar as number) : 0;
  if (crowdedLimit === 0 && emptyLimit === 0) return [];

  const withCoords = mergedArchive
    .map((row) => {
      const coords = parseGymCoords(row);
      return coords ? { row, coords } : null;
    })
    .filter((row): row is { row: FederatedMapEliteRow; coords: GymNicheCoords } => row !== null);

  const crowding = computeDepthAwareCrowding(
    withCoords.map<FederatedEliteView>(({ row }) => ({
      nicheKey: row.nicheKey,
      fitness: row.fitness,
      sourceHive: row.sourceHive ?? null,
      noveltyGift: row.noveltyGift ?? false,
    })),
    { fitnessBar },
  );

  const localOccupied = withCoords.filter(({ row }) => !row.sourceHive).map(({ coords }) => coords);
  const occupied = new Set(withCoords.map(({ coords }) => gymNicheKey(coords)));

  const crowded = normalizeWeights(
    crowding.slice(0, crowdedLimit).map((stat) => ({
      category: 'niche-map' as const,
      summary: `crowded niche ${stat.nicheKey} — ${stat.totalElites} elites across ${stat.contributingSources} hives`,
      detail:
        `best fitness ${stat.bestFitness != null ? stat.bestFitness.toFixed(2) : 'n/a'}; ` +
        `${stat.elitesAboveBar} above crowding bar`,
      ref: `niche:v1:crowded:${stat.nicheKey}`,
    })),
  );

  const emptyCandidates = [];
  for (const scope of SCOPE_BANDS) {
    for (const domain of DOMAIN_VOCAB) {
      for (const risk of RISK_BANDS) {
        const coords: GymNicheCoords = { scope, domain, risk };
        const key = gymNicheKey(coords);
        if (occupied.has(key)) continue;
        const adjacentLocals = localOccupied
          .filter((local) => changedDims(local, coords) === 1)
          .map((local) => gymNicheKey(local))
          .sort();
        emptyCandidates.push({ coords, key, adjacentLocals });
      }
    }
  }

  const empty = normalizeWeights(
    emptyCandidates
      .sort(
        (a, b) =>
          Number(b.adjacentLocals.length > 0) - Number(a.adjacentLocals.length > 0) ||
          b.adjacentLocals.length - a.adjacentLocals.length ||
          a.key.localeCompare(b.key),
      )
      .slice(0, emptyLimit)
      .map(({ key, adjacentLocals }) => ({
        category: 'niche-map' as const,
        summary: `empty niche ${key} — ${adjacentLocals.length > 0 ? 'adjacent to local winners' : 'unoccupied frontier'}`,
        detail:
          adjacentLocals.length > 0
            ? `one-step move from local ${adjacentLocals.slice(0, 2).join(', ')}`
            : 'no one-step local neighbor; a farther novelty leap',
        ref: `niche:v1:empty:${key}`,
      })),
  );

  return [...crowded, ...empty];
}

// ---------------------------------------------------------------------------
// Pure synthesis — deterministic given `nowMs`.
// ---------------------------------------------------------------------------

export interface SynthesizeOptions {
  /** Now, in ms — passed for deterministic tests; the tool passes Date.now(). */
  nowMs?: number;
  /** Max patterns per category (default 20). */
  perCategory?: number;
}

/** Run a reader defensively — one bad source won't kill the whole digest. */
async function safe<T>(fn: () => Promise<T[]>, label: string): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[corpus-digest] reader "${label}" failed:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Status completeness rank — higher = more complete. A revert/regression is a
 * transition to a LOWER rank. Unknown statuses rank at 2 (neutral) so an
 * unmodelled status never spuriously reads as a regression in either direction.
 */
function statusRank(status: string): number {
  switch (status.toLowerCase()) {
    case 'deprecated':
    case 'dropped':
      return 0; // abandoned / killed
    case 'failing':
      return 1;
    case 'todo':
    case 'blocked':
    case 'needs-human':
      return 2;
    case 'validating':
    case 'in_progress':
    case 'wip':
      return 3;
    case 'passed':
    case 'done':
    case 'resolved':
    case 'closed':
      return 4; // terminal-good
    default:
      return 2;
  }
}

/** The churn weight of one revert: how far it fell, +2 extra for undoing
 *  terminal-good (rank-4) work. 0 when it is not a regression. */
export function revertWeight(from: string, to: string): number {
  const fromR = statusRank(from);
  const toR = statusRank(to);
  if (toR >= fromR) return 0; // not a regression (recovery or lateral)
  return fromR - toR + (fromR === 4 ? 2 : 0);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Most recent activity (resolution time when resolved, else creation) — the
 *  recurrence-decay clock for one candidate. */
function lastSeenMsOf(c: ImprovementCandidate): number {
  const ts = c.updatedAt ?? c.createdAt;
  const parsed = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function truncate(s: string, n = 120): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** Rubric-graded observation scorecards have their own structured lane
 *  (`rubricRatings`). Keeping them in free-text friction mining lets the every-wake
 *  scorecard emitter dominate `recurringFriction` by title volume, drowning real
 *  friction. Free-text observations stay eligible for friction clustering; only
 *  scorecard-shaped observations are excluded here. */
function isRubricScorecardObservation(c: ImprovementCandidate): boolean {
  const observation = c.observation;
  if (!observation) return false;
  if (typeof observation.rubricRef === 'string' && observation.rubricRef.trim()) return true;
  return (observation as { synthesized?: unknown }).synthesized === true;
}

function frictionMiningCandidates(friction: ImprovementCandidate[]): ImprovementCandidate[] {
  return friction.filter((c) => !isRubricScorecardObservation(c));
}

/** A scored, pre-normalisation row. We carry the raw salience so each lane can
 *  max-normalise it into MetaPattern.weight (0..1, top = 1.0). */
interface Scored {
  salience: number;
  pattern: Omit<MetaPattern, 'weight'>;
}

/** Sort by raw salience desc, slice to `limit`, then max-normalise into the
 *  shared MetaPattern.weight (top of the lane = 1.0). */
function finalize(scored: Scored[], limit: number): MetaPattern[] {
  const ranked = [...scored].sort((a, b) => b.salience - a.salience).slice(0, limit);
  const max = ranked.length ? ranked[0].salience : 0;
  return ranked.map((s) => ({
    ...s.pattern,
    weight: max > 0 ? round(s.salience / max) : 0,
  }));
}

/** recurringFriction — friction that RECURS: clusters of captures sharing a
 *  stable signature OR near-duplicate wording (Jaccard ≥ 0.8). Reuses the
 *  shipped keystone matcher `findLikelyDuplicates` (exact-then-near-dup) — NOT a
 *  second dedup — so the same underlying friction worded differently still
 *  collides (the "friction nobody named", which exact-signature-only misses on
 *  real, distinctly-worded captures). Open recurrence outweighs a quiet one. */
type DupCluster = ReturnType<typeof findLikelyDuplicates>[number];

/**
 * How many times a cluster's friction was actually REPORTED (EI-20587312505064997).
 *
 * STOCK (`ids.length`) counts work-item ROWS; FLOW counts reports. They diverge
 * precisely because dedup works: a repeat is collapsed onto its canonical row and
 * appended to `work_item_occurrences`, so the repetition lives in the ledger and the
 * row count stays at one.
 *
 * Each member FLOORS AT 1, which is what makes this a strict generalization rather
 * than a replacement: a row with no ledger entry still counts once, so a corpus with
 * no ledger at all scores exactly as it does today. That floor is load-bearing, not
 * defensive — measured 2026-09-06, 15,750 of the 30,870 improvement-topic rows predate
 * the ledger and have no occurrence row, and reading those as zero would DELETE half
 * the lane's salience.
 */
function flowCountOf(cluster: DupCluster, occurrencesById: ReadonlyMap<string, number>): number {
  return cluster.ids.reduce((sum, id) => sum + Math.max(1, occurrencesById.get(id) ?? 1), 0);
}

/**
 * Lane is PROVENANCE. It is not a severity verdict, and keeping those two apart is the
 * whole job of this string (EI-23782723592280521).
 *
 * It used to read `(agent reflection; not a bug)`. Measured 2026-09-20, the digest's #1
 * recurringFriction row was an `authorization_denied` that had recurred 4,902× across 14
 * open rows and was still firing ~2.5×/min — rendered with that parenthetical.
 * `source: observation lane` is a fact about WHO FILED IT; `not a bug` is a claim about
 * WHAT IT IS, and printing them as one phrase let the first silently supply the second.
 *
 * The suppression is structural, not cosmetic: observation rows are excluded from
 * `work_items:list / :search / :claimable` by default, so the corpus's highest-frequency
 * failure signal sits in the one lane guaranteed to produce no action — while the digest,
 * whose entire purpose is surfacing what needs attention, reassured the reader it needed
 * none. State the provenance, state its real operational consequence (UNTRIAGED), and
 * assert nothing whatsoever about the content.
 */
const OBSERVATION_SOURCE_DETAIL =
  ' · source: observation lane (provenance, not a triage verdict — excluded from claimable by default, so UNTRIAGED)';

/**
 * Report the COMPOSITION, not `.some()`.
 *
 * The predicate used to be `candidates.some(...)`, so a single observation member
 * labelled the whole cluster — a mostly-work-lane cluster carrying genuine triaged bug
 * rows was attributed to an agent reflection. That is the same defect one level down: a
 * property of ONE member read as a property of the SUBJECT. The ratio is derivable from
 * the members, needs no tunable threshold, and a mixed cluster is precisely the one a
 * reader must not dismiss — part of it is already real, triageable work.
 */
function observationSourceDetail(candidates: readonly ImprovementCandidate[]): string {
  const total = candidates.length;
  const observed = candidates.filter((candidate) => candidate.lane === 'observation').length;
  if (total === 0 || observed === 0) return '';
  if (observed === total) return OBSERVATION_SOURCE_DETAIL;
  return (
    ` · source: mixed — ${observed} of ${total} row(s) from the observation lane` +
    ' (UNTRIAGED: excluded from claimable by default), the rest triageable'
  );
}

/**
 * Read the occurrence ledger for exactly the candidates being mined, never the corpus.
 *
 * Fail-soft on purpose, and the failure mode is chosen deliberately: an ABSENT or
 * THROWING reader degrades to stock counting (today's behaviour), which under-reports
 * recurrence. It must never degrade to zero counts, which would erase the lane. A
 * digest is a regenerable rollup that rides on Scout's cycle, so a ledger blip may cost
 * this cycle's extra signal — it may not cost the cycle.
 */
async function readOccurrenceFlow(
  readers: StateOfHiveReaders,
  candidates: readonly ImprovementCandidate[],
): Promise<ReadonlyMap<string, number>> {
  if (!readers.occurrences || candidates.length === 0) return new Map();
  try {
    return await readers.occurrences(candidates.map((c) => c.id));
  } catch {
    return new Map();
  }
}

function buildRecurringFriction(
  clusters: DupCluster[],
  byId: Map<string, ImprovementCandidate>,
  nowMs: number,
  limit: number,
  // P-018(b): which clusterer produced these clusters. 'lexical' (the control +
  // DEFAULT) renders byte-identically to the pre-experiment output; 'embed' appends a
  // ` · via:embed-cluster` origin tag so the flag-gated experiment's patterns are
  // attributable in a downstream idea-grade/outcome comparison.
  clusterOrigin: 'lexical' | 'embed' = 'lexical',
  // EI-20587312505064997: report FLOW per candidate id. Defaulted to an empty map so
  // every existing caller (and fixture) keeps the exact stock-counted behaviour.
  occurrencesById: ReadonlyMap<string, number> = new Map(),
): MetaPattern[] {
  const originTag = clusterOrigin === 'embed' ? ' · via:embed-cluster' : '';
  const scored: Scored[] = clusters.map((cluster) => {
    const members = cluster.ids.map((id) => byId.get(id)).filter((c): c is ImprovementCandidate => Boolean(c));
    const openCount = members.filter((m) => (m.state ?? 'open') === 'open').length;
    // Exemplar + decay clock = the most-recently-seen member.
    const newest = [...members].sort((a, b) => lastSeenMsOf(b) - lastSeenMsOf(a))[0];
    const lastSeenMs = newest ? lastSeenMsOf(newest) : 0;
    const decayDays = lastSeenMs ? round((nowMs - lastSeenMs) / DAY_MS, 1) : 0;
    const openBoost = openCount > 0 ? 1 + openCount / members.length : 0.5;
    // Salience and the owner-facing "recurred N×" now read the SAME flow count. They
    // have to move together: quoting stock in the string while ranking on flow would
    // make the digest's most salient rows the ones whose number looks least impressive.
    const recurrence = flowCountOf(cluster, occurrencesById);
    return {
      salience: recurrence * openBoost,
      pattern: {
        category: 'recurring-friction' as MetaPatternCategory,
        summary: newest ? truncate(newest.title) : cluster.signature,
        detail:
          `recurred ${recurrence}× (${openCount} open), last ${decayDays}d ago${originTag}${observationSourceDetail(members)}` +
          // Name the two axes only when they disagree, so an ordinary multi-row
          // cluster's line is unchanged and a ledger-only recurrence is legible
          // rather than looking like a one-row cluster inexplicably ranked first.
          (recurrence !== members.length ? ` · ${members.length} row(s), ${recurrence} report(s)` : ''),
        ref: newest ? `wi:${newest.id}` : `friction:${cluster.signature.slice(0, 40)}`,
      },
    };
  });
  return finalize(scored, limit);
}

// ── rubricGaps (plan-templates-and-rubric-v2 P-008) ──────────────────────────
//
// A RUBRIC GAP = a recurring friction cluster the Hive keeps hitting but has NO
// shared standard (active rubric) for. D-003's loose, Queen-gated trigger: a
// recurring cluster with ≥3 DISTINCT authors AND recurrence across ≥2 cycles, with
// no covering active rubric. All three thresholds reuse data the digest already has
// (the same findLikelyDuplicates clusters as recurringFriction, the candidates'
// createdBy + timestamps, the active-rubric list). Loose by design — over-propose;
// the Queen ratification downstream (P-009) is the real quality filter.

/** ≥ this many distinct filing authors → a cross-author gap, not one agent repeating. */
const MIN_GAP_AUTHORS = 3;
/** ≥ this many distinct UTC days of activity — a loose proxy for "recurs across ≥2
 *  cycles" (the digest has timestamps, not cycle boundaries; tune later, D-003). */
const MIN_GAP_CYCLES = 2;
/** ≥ this many shared significant tokens for an active rubric to "cover" a cluster.
 *  Higher = stricter coverage = MORE gaps flagged (the over-propose direction). */
const MIN_RUBRIC_COVER_TOKENS = 2;

/** Generic words that carry no coverage signal — dropped before token-overlap. */
const GAP_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'not',
  'but',
  'are',
  'was',
  'has',
  'have',
  'via',
  'per',
  'when',
  'then',
  'than',
  'into',
  'from',
  'does',
  'did',
  'can',
  'cant',
  'won',
  'wont',
  'you',
  'your',
  'all',
  'any',
  'out',
  'get',
  'got',
  'its',
  'their',
  'there',
  'here',
  'over',
  'under',
  'about',
  'after',
  'before',
]);

/** Significant lowercase tokens (≥3 chars, non-stopword) — the coverage-match unit. */
function gapTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !GAP_STOPWORDS.has(t)),
  );
}

/** UTC calendar day of an epoch-ms — the cycle bucket. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Does an active rubric cover this cluster's theme? True when its characteristic +
 *  title + criterion titles share ≥ MIN_RUBRIC_COVER_TOKENS significant tokens with
 *  the cluster theme. Loose (Queen-gated downstream); the characteristic dominates. */
function rubricCovers(rubric: RubricSummary, clusterTokens: Set<string>): boolean {
  const rubricTokens = gapTokens(`${rubric.characteristic} ${rubric.title} ${(rubric.criteriaTitles ?? []).join(' ')}`);
  let overlap = 0;
  for (const t of clusterTokens) {
    if (rubricTokens.has(t) && ++overlap >= MIN_RUBRIC_COVER_TOKENS) return true;
  }
  return false;
}

/**
 * rubricGaps — recurring friction clusters with NO covering active rubric, gated by
 * the D-003 trigger (≥3 distinct authors AND ≥2 day-cycles). Shares the SAME clusters
 * as buildRecurringFriction (passed in, computed once). Patterns carry NO `category`
 * (like reverts) — this is the P-009 router-rail's lane, not a flattenDigest ideator
 * lane. salience = recurrence × author-spread (the strongest "shared-standard-missing"
 * signal). Empty when no rubrics are known is NOT special-cased — an empty rubric set
 * just means nothing is covered (max gaps), the loose default.
 */
function buildRubricGaps(
  clusters: DupCluster[],
  byId: Map<string, ImprovementCandidate>,
  rubrics: RubricSummary[],
  limit: number,
): MetaPattern[] {
  const scored: Scored[] = [];
  for (const cluster of clusters) {
    const members = cluster.ids.map((id) => byId.get(id)).filter((c): c is ImprovementCandidate => Boolean(c));
    if (members.length < 2) continue; // not recurring

    // ≥3 DISTINCT authors (the filer's ownerId; unknown author contributes nothing).
    const authors = new Set(members.map((m) => m.createdBy).filter((a): a is string => Boolean(a)));
    if (authors.size < MIN_GAP_AUTHORS) continue;

    // ≥2 distinct day-cycles (loose proxy for "recurs across ≥2 cycles").
    const days = new Set(
      members
        .map((m) => lastSeenMsOf(m))
        .filter((ms) => ms > 0)
        .map(utcDay),
    );
    if (days.size < MIN_GAP_CYCLES) continue;

    // No covering ACTIVE rubric (D-003: "an active rubric whose characteristic covers it").
    const newest = [...members].sort((a, b) => lastSeenMsOf(b) - lastSeenMsOf(a))[0];
    const clusterTokens = gapTokens(`${newest?.title ?? ''} ${cluster.signature}`);
    if (rubrics.some((r) => rubricCovers(r, clusterTokens))) continue;

    scored.push({
      // recurrence × author-spread — a cross-author chronic gap ranks highest.
      salience: members.length * authors.size,
      pattern: {
        // No category — the gap is the P-009 rail's lane, not a flattenDigest ideator lane.
        summary: newest ? truncate(newest.title) : cluster.signature,
        detail: `recurring (${members.length}× · ${authors.size} authors · ${days.size} cycles), no covering rubric`,
        ref: newest ? `wi:${newest.id}` : `rubric-gap:${cluster.signature.slice(0, 40)}`,
      },
    });
  }
  return finalize(scored, limit);
}

/** timeTokenSinks — the heaviest spend buckets (where time/tokens went). */
function buildTimeTokenSinks(spend: SpendRecord[], limit: number): MetaPattern[] {
  const scored: Scored[] = spend
    .filter((s) => s.costUsd > 0 || s.outputTokens > 0)
    .map((s) => {
      const harness = s.harness ?? '(unattributed)';
      const role = s.role ?? '(any role)';
      const tokens = s.inputTokens + s.outputTokens;
      return {
        salience: s.costUsd > 0 ? s.costUsd : tokens / 1_000_000, // $ first; tokens as a tiny tiebreak
        pattern: {
          category: 'time-token-sink' as MetaPatternCategory,
          summary: `$${round(s.costUsd)} on ${harness} · ${role}`,
          detail: `${s.runs} run(s), ${tokens.toLocaleString()} tokens`,
          ref: `usage:${harness}/${role}`,
        },
      };
    });
  return finalize(scored, limit);
}

/** chronicDeferrals — deferrals aggregated by stable signature so the SAME thing
 *  deferred repeatedly (across items / plans / decisions) reads as *chronic*
 *  (high salience). needs-human punts weigh above blocked; a one-off deferral is
 *  a low-salience current deferral, not yet chronic. */
function buildChronicDeferrals(deferrals: DeferralRecord[], limit: number): MetaPattern[] {
  const groups = new Map<string, DeferralRecord[]>();
  for (const d of deferrals) {
    const sig = dedupSignature(d.text) || d.text.toLowerCase().slice(0, 40);
    const arr = groups.get(sig) ?? [];
    arr.push(d);
    groups.set(sig, arr);
  }
  const weightOf = (status: string): number => (status === 'needs-human' ? 1.5 : status === 'blocked' ? 1.2 : 1);
  const scored: Scored[] = [...groups.values()].map((members) => {
    // Recurrence is the chronic signal; punt-severity is the tiebreak.
    const severity = members.reduce((acc, m) => acc + weightOf(m.status), 0);
    const salience = members.length * 10 + severity;
    const exemplar = members[0];
    const plans = [...new Set(members.map((m) => m.planSlug))];
    const statuses = [...new Set(members.map((m) => m.status))];
    return {
      salience,
      pattern: {
        category: 'chronic-deferral' as MetaPatternCategory,
        summary: truncate(exemplar.text),
        detail: `deferred ${members.length}× across ${plans.length} plan(s) [${statuses.join(', ')}]`,
        ref: `plan:${exemplar.planSlug}#${exemplar.refId}`,
      },
    };
  });
  return finalize(scored, limit);
}

/** capabilityGaps — absent capabilities: net-new feature-kind asks + friction
 *  that NAMES a missing capability, aggregated by signature so a repeatedly
 *  requested capability ranks highest. */
const GAP_KEYWORDS = [
  'no way to',
  'cannot ',
  "can't ",
  'unable to',
  'missing',
  'there is no',
  "there's no",
  'wish there was',
  'would be nice',
  'lacks',
  'not possible',
  'need a tool',
  'no tool',
  'unsupported',
  'no support for',
  'add support',
];

function namesMissingCapability(c: ImprovementCandidate): boolean {
  const hay = `${c.title} ${c.body ?? ''}`.toLowerCase();
  return GAP_KEYWORDS.some((k) => hay.includes(k));
}

function buildCapabilityGaps(friction: ImprovementCandidate[], nowMs: number, limit: number): MetaPattern[] {
  const gapCandidates = friction.filter((c) => c.kind === 'feature' || namesMissingCapability(c));
  const recurrences = signatureRecurrence(gapCandidates, { nowMs });
  const byId = new Map(gapCandidates.map((c) => [c.id, c] as const));
  const scored: Scored[] = recurrences.map((r) => {
    const exemplar = byId.get(r.ids[0]);
    const members = r.ids.map((id) => byId.get(id)).filter((c): c is ImprovementCandidate => Boolean(c));
    const isFeature = exemplar?.kind === 'feature';
    const salience = r.count * (isFeature ? 2 : 1) + (r.openCount > 0 ? 1 : 0);
    return {
      salience,
      pattern: {
        category: 'capability-gap' as MetaPatternCategory,
        summary: exemplar ? truncate(exemplar.title) : r.signature,
        detail:
          `${isFeature ? 'net-new ask' : 'named missing capability'}${r.count > 1 ? `, asked ${r.count}×` : ''} (${r.openCount} open)` +
          observationSourceDetail(members),
        ref: `wi:${r.ids[0]}`,
      },
    };
  });
  return finalize(scored, limit);
}

/** reverts — status regressions grouped by work item; the churniest (most-/
 *  hardest-reverted) work first. The substrate signal for "where rework lives".
 *  Not one of the four CorpusDigest lanes, so its patterns carry no `category`. */
function buildReverts(reverts: RevertRecord[], limit: number): MetaPattern[] {
  const groups = new Map<string, { records: RevertRecord[]; weight: number }>();
  for (const r of reverts) {
    const w = revertWeight(r.from, r.to);
    if (w <= 0) continue; // not a regression
    const g = groups.get(r.workItemId) ?? { records: [], weight: 0 };
    g.records.push(r);
    g.weight += w;
    groups.set(r.workItemId, g);
  }
  const scored: Scored[] = [...groups.entries()].map(([workItemId, g]) => {
    const latest = [...g.records].sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
    return {
      salience: g.weight,
      pattern: {
        summary: `${workItemId} reverted ${g.records.length}× (latest ${latest.from}→${latest.to})`,
        detail: latest.actor ? `last by ${latest.actor}` : `latest ${latest.ts}`,
        ref: `wi:${workItemId}`,
      },
    };
  });
  return finalize(scored, limit);
}

/** A status flip alone explains no cause. Only explicit, non-generic
 * deprecation reasons can become grounded ideation lessons. */
export function buildReworkLessons(reverts: readonly RevertRecord[], limit: number): MetaPattern[] {
  const causal = reverts
    .filter((row) => row.to === 'deprecated' && revertWeight(row.from, row.to) > 0)
    .filter((row) => {
      const reason = row.reason?.trim();
      return Boolean(reason && reason.length >= 12 && !/^(?:deprecated|reverted|cancelled|passed|failed)$/i.test(reason));
    })
    .sort((a, b) => b.ts.localeCompare(a.ts) || a.workItemId.localeCompare(b.workItemId));
  const seen = new Set<string>();
  const out: MetaPattern[] = [];
  for (const row of causal) {
    if (seen.has(row.workItemId)) continue;
    seen.add(row.workItemId);
    out.push({
      category: 'rework-lesson',
      ref: `wi:${row.workItemId}`,
      summary: `${row.workItemId} deprecated after ${row.from}: ${row.reason!.trim().slice(0, 180)}`,
      detail: `Reason is the work item's recorded deprecation reason; status transition at ${row.ts}. Inspect the work item before applying this lesson elsewhere.`,
      weight: Math.min(1, 0.55 + revertWeight(row.from, row.to) / 20),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Severity of one rating — how strongly a measurement signals a problem worth
 * ideating on (rubric-driven-observations P-006). `healthy` = 0 (a healthy
 * measurement is not a problem to scout); `unknown` carries a small weight (a
 * persistently not-assessable criterion is itself a weak signal — a measurement
 * gap). An UNMODELLED rating (a per-criterion scale override outside the default
 * vocabulary) reads as a mild signal (1) rather than vanishing. Case-insensitive.
 */
const RATING_SEVERITY: Record<string, number> = { broken: 3, degraded: 2, unknown: 0.5, healthy: 0 };

function ratingSeverity(rating: string): number {
  const known = RATING_SEVERITY[rating.toLowerCase()];
  return known === undefined ? 1 : known;
}

/** The most-severe rating present in a group — the headline for the criterion. */
function worstRating(ratings: readonly string[]): string {
  return [...ratings].sort((a, b) => ratingSeverity(b) - ratingSeverity(a))[0] ?? 'unknown';
}

/** A scratch accumulator for one (rubric, source-hive, criterion) measurement group. */
interface RatingGroup {
  rubricRef: string;
  sourceHive?: string;
  criterion: string;
  /** rating value → how many observations gave it. */
  counts: Map<string, number>;
  /** Σ ratingSeverity over the observations — the salience (recurrence × severity). */
  severity: number;
  /** Total observations contributing a rating to this criterion. */
  total: number;
  /** The most-recent rating + its evidence (for the detail line). */
  latest?: { rating: string; evidence: string; ms: number };
  /** The most-recent non-empty grader suggestion (P-005 — a seed the ideators see). */
  suggestion?: { text: string; ms: number };
}

/**
 * rubricRatings — STRUCTURED observations grouped by (rubricRef, sourceHive,
 * criterion): surface the measured rating per criterion so Scout ideates on
 * MEASUREMENTS, not just free-text clusters (P-006). Each surfaced pattern is one
 * criterion's standing in one hive under one rubric, ranked by severity ×
 * recurrence. Pure-healthy groups (nothing to ideate on) are DROPPED — mirroring
 * how `buildReverts` drops non-regressions — but every scanned observation is
 * still counted in `corpus.observations` for honesty. `ratings` is a Record keyed
 * by criterion (D-003), so `Object.entries` is the grouping seam.
 */
function buildRubricRatings(observations: StructuredObservationRecord[], limit: number): MetaPattern[] {
  const groups = new Map<string, RatingGroup>();
  for (const obs of observations) {
    // A rating needs its rubric (D-003: rubricRef REQUIRED when ratings present).
    if (!obs.rubricRef || !obs.ratings) continue;
    const ms = obs.lastSeenMs ?? 0;
    for (const [criterion, r] of Object.entries(obs.ratings)) {
      const rating = r?.rating;
      if (!criterion || typeof rating !== 'string' || !rating.trim()) continue;
      const key = `${obs.rubricRef}\u0000${obs.sourceHive ?? ''}\u0000${criterion}`;
      const g: RatingGroup = groups.get(key) ?? {
        rubricRef: obs.rubricRef,
        sourceHive: obs.sourceHive,
        criterion,
        counts: new Map<string, number>(),
        severity: 0,
        total: 0,
      };
      g.counts.set(rating, (g.counts.get(rating) ?? 0) + 1);
      g.severity += ratingSeverity(rating);
      g.total += 1;
      if (!g.latest || ms >= g.latest.ms) {
        g.latest = { rating, evidence: (r.evidence ?? '').trim(), ms };
      }
      const sugg = (r?.suggestion ?? '').trim();
      if (sugg && (!g.suggestion || ms >= g.suggestion.ms)) {
        g.suggestion = { text: sugg, ms };
      }
      groups.set(key, g);
    }
  }

  const scored: Scored[] = [];
  for (const g of groups.values()) {
    if (g.severity <= 0) continue; // pure-healthy — no problem to ideate on
    const worst = worstRating([...g.counts.keys()]);
    const dist = [...g.counts.entries()]
      .sort((a, b) => ratingSeverity(b[0]) - ratingSeverity(a[0]))
      .map(([rating, n]) => `${rating} ${n}×`)
      .join(', ');
    const hiveSuffix = g.sourceHive ? ` @ ${g.sourceHive}` : '';
    const evidence = g.latest?.evidence ? `; latest: ${truncate(g.latest.evidence, 100)}` : '';
    const suggests = g.suggestion ? `; grader suggests: ${truncate(g.suggestion.text, 160)}` : '';
    scored.push({
      salience: g.severity,
      pattern: {
        category: 'rubric-rating' as MetaPatternCategory,
        summary: `${g.rubricRef} · ${g.criterion}${hiveSuffix}: ${worst}`,
        detail: `${dist} over ${g.total} obs${evidence}${suggests}`,
        ref: `rubric:${g.rubricRef}#${g.criterion}${g.sourceHive ? `@${g.sourceHive}` : ''}`,
      },
    });
  }
  return finalize(scored, limit);
}

/**
 * Synthesize the "state of the Hive" corpus digest. Pure + deterministic given
 * `nowMs`. Gathers all substrates (defensively), rolls each into its
 * meta-pattern lane, and returns a `DigestSchema`-valid digest (a structural
 * superset of the shared CorpusDigest).
 */
export async function synthesizeStateOfHive(
  readers: StateOfHiveReaders,
  opts: SynthesizeOptions = {},
): Promise<StateOfHiveDigest> {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.perCategory ?? 20;

  const [completions, reverts, friction, spend, deferrals, observations, rubrics] = await Promise.all([
    safe(() => readers.completions(), 'completions'),
    safe(() => readers.reverts(), 'reverts'),
    safe(() => readers.friction(), 'friction'),
    safe(() => readers.spend(), 'spend'),
    safe(() => readers.deferrals(), 'deferrals'),
    safe(() => readers.observations(), 'observations'),
    // rubrics() is optional (P-008) — absent ⇒ no rubrics known ⇒ every recurring
    // cluster reads as uncovered (the loose default).
    safe(() => (readers.rubrics ? readers.rubrics() : Promise.resolve([])), 'rubrics'),
  ]);

  // Shared friction clustering (computed ONCE): recurringFriction + rubricGaps read
  // the SAME clusters (P-008 "reuse data the digest already has"), so the O(n²)
  // near-dup pass runs once, not twice.
  //
  // P-018(b) frontier experiment: the lexical `findLikelyDuplicates` (token-set
  // Jaccard) is the CONTROL + DEFAULT; the flag-gated embedding-cosine clusterer
  // returns null — fail-open — unless PAPERCUSP_SU_DIGEST_EMBED_CLUSTER=on AND it
  // resolves a verdict, in which case its `{signature,ids}` clusters drop in
  // unchanged and recurringFriction is origin-tagged for a falsifiable comparison.
  const frictionForMining = frictionMiningCandidates(friction);
  const frictionById = new Map(frictionForMining.map((c) => [c.id, c] as const));
  const embedClusters = await clusterFrictionByEmbedding(frictionForMining);
  const clusterOrigin: 'lexical' | 'embed' = embedClusters ? 'embed' : 'lexical';
  const allFrictionClusters = embedClusters ?? findLikelyDuplicates(frictionForMining);
  // Clusters of ≥2 ROWS — the historical set. `rubricGaps` keeps reading exactly this,
  // so widening the recurrence lane below cannot move the gap lane (its ≥3-distinct-author
  // trigger would reject a one-row cluster anyway; not relying on that is what makes this
  // change surgical rather than merely harmless-looking).
  const frictionClusters = allFrictionClusters.filter((c) => c.ids.length > 1);

  // EI-20587312505064997 — FLOW, the recurrence the row count cannot show.
  //
  // `findLikelyDuplicates` only ever emits clusters of ≥2 rows (every push is guarded by
  // `ids.length > 1`), so a friction that recurred 79× as ONE deduped row is not merely
  // ranked low here — it is never emitted as a cluster at all, and no re-ranking or
  // re-sizing downstream could ever surface it. The fix therefore has to SYNTHESIZE the
  // one-row groups, not relax a filter.
  //
  // Fail-soft: a missing or throwing reader yields an empty map, every count floors at
  // one-per-member, no singletons are synthesized, and the lane renders exactly as before.
  const occurrencesById = await readOccurrenceFlow(readers, frictionForMining);
  const clusteredIds = new Set(allFrictionClusters.flatMap((c) => c.ids));
  const flowOnlyClusters: DupCluster[] = frictionForMining
    .filter((c) => !clusteredIds.has(c.id) && (occurrencesById.get(c.id) ?? 1) > 1)
    .map((c) => ({ signature: `flow:${c.id}`, ids: [c.id] }));

  const recurringFriction = buildRecurringFriction(
    [...frictionClusters, ...flowOnlyClusters],
    frictionById,
    nowMs,
    limit,
    clusterOrigin,
    occurrencesById,
  );
  const timeTokenSinks = buildTimeTokenSinks(spend, limit);
  const chronicDeferrals = buildChronicDeferrals(deferrals, limit);
  const capabilityGaps = buildCapabilityGaps(frictionForMining, nowMs, limit);
  const revertPatterns = buildReverts(reverts, limit);
  const reworkLessons = buildReworkLessons(reverts, limit);
  const rubricRatings = buildRubricRatings(observations, limit);
  const rubricGaps = buildRubricGaps(frictionClusters, frictionById, rubrics, limit);

  const spendUsd = round(spend.reduce((acc, s) => acc + (s.costUsd || 0), 0));
  const corpus = {
    completions: completions.length,
    reverts: reverts.length,
    frictionCaptured: frictionForMining.length,
    deferrals: deferrals.length,
    spendUsd,
    spendBuckets: spend.length,
    observations: observations.length,
    rubrics: rubrics.length,
  };

  const headline =
    `State of the Hive: ${recurringFriction.length} recurring friction, ` +
    `${timeTokenSinks.length} spend sink(s) ($${spendUsd}), ` +
    `${chronicDeferrals.length} chronic deferral(s), ` +
    `${capabilityGaps.length} capability gap(s), ` +
    `${revertPatterns.length} reverted item(s), ` +
    `${rubricRatings.length} rubric measurement(s), ` +
    `${rubricGaps.length} rubric gap(s) ` +
    `over ${completions.length} completions`;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    corpus,
    recurringFriction,
    timeTokenSinks,
    chronicDeferrals,
    capabilityGaps,
    reverts: revertPatterns,
    reworkLessons,
    rubricRatings,
    rubricGaps,
    headline,
  };
}
