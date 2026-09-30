/**
 * config.ts — the per-blueprint Scout tuning surface (P-009 scout-config seam,
 * domain-generic-hive-architecture-2026-06-18 D-004).
 *
 * The Scout loop's behavior was tuned by constants scattered across the engine:
 * `CREATIVE_LENSES` (the ideator roster, types.ts), the search-first novelty knobs
 * and verdict-bucket thresholds (critique-core.ts), and the routing default + the
 * genome-axis `WHOLE_SYSTEM_MARKERS` vocabulary (router.ts). This module lifts those
 * into ONE `ScoutConfig` a blueprint can supply, so a `coding` hive and a `work` hive
 * can scout DIFFERENTLY — not just be worded differently (the "how the hive learns"
 * customization, D-002/D-004).
 *
 * KEY INVARIANT: {@link DEFAULT_SCOUT_CONFIG} is built FROM the engine's own exported
 * defaults, so an absent / partial blueprint `scout` block yields byte-identical
 * behavior to before this seam existed. The engine itself (the pipeline, the
 * critic spine's search-first novelty ceiling, the verdict buckets, the
 * `scout-ceiling` learning governor) stays hardcoded — the blueprint supplies domain
 * JUDGMENT (lenses, thresholds, routing, markers), not the mechanism.
 *
 * PURE — no IO, no LLM. Resolution + defensive parsing only; fully unit-testable.
 */
import { CREATIVE_LENSES, type CreativeLens } from './types';
import {
  DEFAULT_BUCKET_OPTIONS,
  DEFAULT_CORPUS_NOVELTY_OPTIONS,
  type BucketOptions,
  type CorpusNoveltyTuning,
} from './critique-core';
import {
  DEFAULT_GOAL_BUDGET_CENTS,
  DEFAULT_ROUTING_RAIL,
  GOAL_SCALE_MARKERS,
  WHOLE_SYSTEM_MARKERS,
} from './router';
import { DEFAULT_IDEATOR_MISSION } from './lenses';
import { DEFAULT_CRITIC_MISSION } from './critics';
import { DEFAULT_SCOUT_MODELS, type ScoutModelConfig } from './models';
import {
  DEFAULT_FEDERATED_PRIMING,
  resolveFederatedPrimingConfig,
  type FederatedPrimingConfig,
} from './federated-priming';
import type { RoutedRail } from './outcome-feedback';

/** The routing knobs a blueprint can tune (router.ts ClassifyOptions + the markers). */
export interface ScoutRoutingConfig {
  /** Rail used when a proposal carries no routeHint (default `improvement`). */
  defaultRail: RoutedRail;
  /**
   * The genome-axis vocabulary that bumps a testable proposal to the `instance` rail
   * (`isWholeSystemProposal`). Coding/Papercusp-specific by default — a `work` hive
   * supplies its own or `[]` (never bump to instance).
   */
  wholeSystemMarkers: readonly string[];
  /**
   * The goal-scale vocabulary that bumps a broad ('plan'-hinted) proposal to the `goal`
   * rail (`isGoalScaleProposal`, P-013 / D-005). Same seam shape as `wholeSystemMarkers`:
   * a hive supplies its own or `[]` (never auto-create goals from text).
   */
  goalScaleMarkers: readonly string[];
  /** Spend ceiling (cents) drafted onto auto-created goals (`draftGoalRails`). */
  goalBudgetCentsCap: number;
}

/**
 * The per-blueprint Scout PROMPT framing (P-010 scout prompt-overlay seam, D-004) —
 * the "prompt half" of scout customization that rides alongside the structured config
 * (the P-009 "config half"). These are the DOMAIN framing strings substituted into the
 * ideator + critic step prompts so a `coding` hive and a `work` hive frame ideation +
 * critique for their domain. The engine MECHANISM (lens stances, grounding rules,
 * novelty/feasibility scoring, JSON output contract) stays hardcoded (P-011) — only the
 * mission framing is overridable.
 */
export interface ScoutFramingConfig {
  /** Ideator mission framing — who the scout is + what it scouts for ({@link DEFAULT_IDEATOR_MISSION}). */
  ideatorMission: string;
  /** Critic mission framing — the adversarial-critics intro naming the judged domain ({@link DEFAULT_CRITIC_MISSION}). */
  criticMission: string;
}

/**
 * Federated Scout↔gym migration-rate knobs (P-016 / D-004). The owner-ratified
 * default is intentionally small; an all-zero profile is the CONTROL hive.
 */
export interface ScoutFederatedPrimingConfig extends FederatedPrimingConfig {}

/**
 * The fully-resolved per-blueprint Scout tuning. Every field is concrete (no optionals)
 * so the engine call sites can use it directly. Build one with {@link resolveScoutConfig}.
 *
 * NOTE: `outcomeSignals` (what counts as "paid off" for the P-013 lens-attribution loop)
 * is a planned follow-on — the attribution path (`outcome-feedback.ts`) is not yet
 * parameterized, so it is intentionally NOT a field here yet (no dead config).
 */
export interface ScoutConfig {
  /** Forced-diversity ideator roster (D-004). Each lens is a distinct generative stance. */
  lenses: readonly CreativeLens[];
  /** Search-first novelty knobs (`corpusNovelty`). */
  novelty: CorpusNoveltyTuning;
  /** Verdict-bucket thresholds (`verdictFor`/`bucketByCritique`). */
  buckets: Required<BucketOptions>;
  /** Routing defaults + the whole-system marker vocabulary. */
  routing: ScoutRoutingConfig;
  /** Per-step prompt framing (P-010) — the ideator + critic mission strings. */
  framing: ScoutFramingConfig;
  /** Federated migration-rate knobs (P-016 control-hive baseline + future owner steering). */
  federatedPriming: ScoutFederatedPrimingConfig;
  /**
   * Per-step model ids. Defaults are behavior-neutral, but the live autonomous loop
   * can move Scout off an unhealthy provider/model lane without a deploy.
   */
  models: ScoutModelConfig;
}

/**
 * The default per-step framing — byte-identical to the pre-seam prompt strings, built
 * FROM the prompt builders' exported defaults so it can never drift (asserted in
 * config.test.ts).
 */
export const DEFAULT_SCOUT_FRAMING: ScoutFramingConfig = {
  ideatorMission: DEFAULT_IDEATOR_MISSION,
  criticMission: DEFAULT_CRITIC_MISSION,
};

/**
 * The default tuning — byte-identical to the previous hardcoded constants. Built FROM
 * the engine's exported defaults so it can never drift (asserted in config.test.ts).
 */
export const DEFAULT_SCOUT_CONFIG: ScoutConfig = {
  lenses: CREATIVE_LENSES,
  novelty: DEFAULT_CORPUS_NOVELTY_OPTIONS,
  buckets: DEFAULT_BUCKET_OPTIONS,
  routing: {
    defaultRail: DEFAULT_ROUTING_RAIL,
    wholeSystemMarkers: WHOLE_SYSTEM_MARKERS,
    goalScaleMarkers: GOAL_SCALE_MARKERS,
    goalBudgetCentsCap: DEFAULT_GOAL_BUDGET_CENTS,
  },
  framing: DEFAULT_SCOUT_FRAMING,
  federatedPriming: DEFAULT_FEDERATED_PRIMING,
  models: DEFAULT_SCOUT_MODELS,
};

/** A partial override a blueprint supplies — every field optional; missing → default. */
export interface ScoutConfigOverride {
  lenses?: readonly CreativeLens[];
  novelty?: Partial<CorpusNoveltyTuning>;
  buckets?: Partial<BucketOptions>;
  routing?: Partial<ScoutRoutingConfig>;
  framing?: Partial<ScoutFramingConfig>;
  federatedPriming?: Partial<ScoutFederatedPrimingConfig>;
  models?: Partial<ScoutModelConfig>;
}

/** Copy only the DEFINED own keys of `src` onto a shallow clone of `base`. */
function mergeDefined<T extends object>(base: T, src?: Partial<T>): T {
  if (!src) return { ...base };
  const out = { ...base };
  for (const k of Object.keys(src) as (keyof T)[]) {
    const v = src[k];
    if (v !== undefined) out[k] = v as T[keyof T];
  }
  return out;
}

/**
 * Resolve a blueprint override over {@link DEFAULT_SCOUT_CONFIG}. A null/empty override
 * yields the defaults; an empty `lenses` array is ignored (the D-004 floor — never
 * silence the ideators). Missing nested keys fall back per-field, so a blueprint can
 * tune just `buckets.moonshotFloorQuantile` without restating everything.
 */
export function resolveScoutConfig(override?: ScoutConfigOverride | null): ScoutConfig {
  if (!override) return DEFAULT_SCOUT_CONFIG;
  return {
    lenses:
      override.lenses && override.lenses.length > 0
        ? [...override.lenses]
        : DEFAULT_SCOUT_CONFIG.lenses,
    novelty: mergeDefined<CorpusNoveltyTuning>(DEFAULT_SCOUT_CONFIG.novelty, override.novelty),
    buckets: mergeDefined<Required<BucketOptions>>(DEFAULT_SCOUT_CONFIG.buckets, override.buckets),
    routing: mergeDefined<ScoutRoutingConfig>(DEFAULT_SCOUT_CONFIG.routing, override.routing),
    // A blank/whitespace mission falls back to the default (never silence the framing,
    // the prompt analog of the empty-lenses floor above).
    framing: {
      ideatorMission:
        nonBlank(override.framing?.ideatorMission) ?? DEFAULT_SCOUT_CONFIG.framing.ideatorMission,
      criticMission:
        nonBlank(override.framing?.criticMission) ?? DEFAULT_SCOUT_CONFIG.framing.criticMission,
    },
    federatedPriming: resolveFederatedPrimingConfig(override.federatedPriming),
    models: mergeDefined<ScoutModelConfig>(DEFAULT_SCOUT_CONFIG.models, override.models),
  };
}

/** A non-blank string, else undefined (so the default mission stands). */
function nonBlank(s: unknown): string | undefined {
  return typeof s === 'string' && s.trim().length > 0 ? s : undefined;
}

const ROUTED_RAILS: readonly RoutedRail[] = ['plan', 'gym', 'improvement', 'instance', 'goal'];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

/**
 * Defensively parse a blueprint's raw `scout` block (untrusted yaml/JSON) into a
 * {@link ScoutConfigOverride}. Unknown / malformed fields are DROPPED (never throws),
 * so a typo'd block degrades to the defaults rather than breaking the cycle — the same
 * fail-safe discipline as `parseScoutCycleConfig` (run.ts).
 */
export function parseScoutConfigBlock(raw: unknown): ScoutConfigOverride {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: ScoutConfigOverride = {};

  const lenses = asStringArray(r.lenses)?.filter((l): l is CreativeLens =>
    (CREATIVE_LENSES as readonly string[]).includes(l),
  );
  if (lenses && lenses.length > 0) out.lenses = lenses;

  if (r.novelty && typeof r.novelty === 'object') {
    const n = r.novelty as Record<string, unknown>;
    const nov: Partial<CorpusNoveltyTuning> = {};
    if (isFiniteNumber(n.matchFloor)) nov.matchFloor = n.matchFloor;
    if (isFiniteNumber(n.maxMatches)) nov.maxMatches = n.maxMatches;
    if (isFiniteNumber(n.decidedPenalty)) nov.decidedPenalty = n.decidedPenalty;
    if (isFiniteNumber(n.semanticBaselineQuantile)) {
      nov.semanticBaselineQuantile = n.semanticBaselineQuantile;
    }
    const ds = asStringArray(n.decidedStates);
    if (ds) nov.decidedStates = ds;
    if (Object.keys(nov).length > 0) out.novelty = nov;
  }

  if (r.buckets && typeof r.buckets === 'object') {
    const b = r.buckets as Record<string, unknown>;
    const bk: Partial<BucketOptions> = {};
    if (isFiniteNumber(b.noveltyFloor)) bk.noveltyFloor = b.noveltyFloor;
    if (isFiniteNumber(b.feasibilityFloor)) bk.feasibilityFloor = b.feasibilityFloor;
    if (isFiniteNumber(b.moonshotNoveltyFloor)) bk.moonshotNoveltyFloor = b.moonshotNoveltyFloor;
    if (isFiniteNumber(b.maxMoonshots)) bk.maxMoonshots = b.maxMoonshots;
    // WI-39492 — the batch-relative moonshot floor's two knobs.
    if (isFiniteNumber(b.moonshotFloorQuantile)) bk.moonshotFloorQuantile = b.moonshotFloorQuantile;
    if (isFiniteNumber(b.moonshotFloorMin)) bk.moonshotFloorMin = b.moonshotFloorMin;
    if (Object.keys(bk).length > 0) out.buckets = bk;
  }

  if (r.routing && typeof r.routing === 'object') {
    const rt = r.routing as Record<string, unknown>;
    const routing: Partial<ScoutRoutingConfig> = {};
    if (typeof rt.defaultRail === 'string' && ROUTED_RAILS.includes(rt.defaultRail as RoutedRail)) {
      routing.defaultRail = rt.defaultRail as RoutedRail;
    }
    const markers = asStringArray(rt.wholeSystemMarkers);
    if (markers) routing.wholeSystemMarkers = markers.map((m) => m.toLowerCase());
    const goalMarkers = asStringArray(rt.goalScaleMarkers);
    if (goalMarkers) routing.goalScaleMarkers = goalMarkers.map((m) => m.toLowerCase());
    if (isFiniteNumber(rt.goalBudgetCentsCap) && rt.goalBudgetCentsCap >= 0) {
      routing.goalBudgetCentsCap = Math.round(rt.goalBudgetCentsCap);
    }
    if (Object.keys(routing).length > 0) out.routing = routing;
  }

  if (r.framing && typeof r.framing === 'object' && !Array.isArray(r.framing)) {
    const f = r.framing as Record<string, unknown>;
    const framing: Partial<ScoutFramingConfig> = {};
    // Only non-blank strings are kept; a blank/typo'd mission degrades to the default.
    if (typeof f.ideatorMission === 'string' && f.ideatorMission.trim().length > 0) {
      framing.ideatorMission = f.ideatorMission;
    }
    if (typeof f.criticMission === 'string' && f.criticMission.trim().length > 0) {
      framing.criticMission = f.criticMission;
    }
    if (Object.keys(framing).length > 0) out.framing = framing;
  }

  if (r.federatedPriming && typeof r.federatedPriming === 'object' && !Array.isArray(r.federatedPriming)) {
    const fp = r.federatedPriming as Record<string, unknown>;
    const priming: Partial<ScoutFederatedPrimingConfig> = {};
    if (isFiniteNumber(fp.foreignElites)) priming.foreignElites = fp.foreignElites;
    if (isFiniteNumber(fp.crowded)) priming.crowded = fp.crowded;
    if (isFiniteNumber(fp.empty)) priming.empty = fp.empty;
    if (Object.keys(priming).length > 0) out.federatedPriming = priming;
  }

  if (r.models && typeof r.models === 'object' && !Array.isArray(r.models)) {
    const m = r.models as Record<string, unknown>;
    const models: Partial<ScoutModelConfig> = {};
    const ideator = nonBlank(m.ideator);
    const critic = nonBlank(m.critic);
    const recombine = nonBlank(m.recombine);
    const revision = nonBlank(m.revision);
    const experiment = nonBlank(m.experiment);
    if (ideator) models.ideator = ideator;
    if (critic) models.critic = critic;
    if (recombine) models.recombine = recombine;
    if (revision) models.revision = revision;
    if (experiment) models.experiment = experiment;
    if (Object.keys(models).length > 0) out.models = models;
  }

  return out;
}
