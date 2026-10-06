/**
 * tripwire-refresh.ts — plan blender-goal-amendment-rail-2026-08-19 P-004.
 *
 * THE DEFECT THIS CLOSES, as MEASURED rather than asserted (2026-08-19):
 * every tripwire on every ACTIVE goal carried `current: null`. The only goals
 * whose tripwires held a value were `achieved`/`killed` ones, filled in by hand
 * at close time. A kill criterion that is only ever scored after the goal is
 * over is decorative — it can never fire.
 *
 * ⚠ THE MEASUREMENT WAS NEVER MISSING. That is the whole finding, and it is why
 * this module is a JOIN rather than an instrument. `spend-rollup.ts` has been
 * computing fully-attributed goal spend for every active goal every 5 minutes
 * and writing it to `metadata.spentCents` — one field away from the tripwire it
 * was supposed to advance. Measured at the time of writing:
 *
 *   goal                                     metadata.spentCents   spend tripwire
 *   the-papercusp-desktop-app-…7273ca        34618 (measured)      threshold 50 usd, current NULL
 *
 * $346.18 of measured spend against a declared $50 ceiling, showing in the UI as
 * unmeasured. The number was right there. Nothing carried it across.
 *
 * ── WHY THIS LIVES BESIDE THE ROLLUP AND NOT IN THE BLENDER (D-014) ──────────
 * P-004 is worded "let the Blender refresh tripwires[].current", written before
 * the rollup tick was known to exist. Routing the SPEND metric through an
 * ideation agent would contradict D-003 of goal-mode-design-intent-hardening
 * ("spend truth comes from the platform cost ledger rolled up by goal_id; agents
 * never hand-write spentCents"). The advance therefore happens platform-side, in
 * the same sweep that already computed the number, with no agent in the loop.
 *
 * ── THE TWO RULES THAT KEEP THIS HONEST ──────────────────────────────────────
 *  1. NEVER INVENT. A metric with no generic resolver (`species_covered`,
 *     `hours_since_verdict_advance`) is left EXACTLY as it was. Only the goal's
 *     own executor can score those, and a plausible-looking number that nobody
 *     measured is worse than a blank.
 *  2. NEVER PROMOTE A FLOOR TO A MEASUREMENT. `computeGoalSpendRollup` reports
 *     `spentCents: null` when any attributed sample is unpriced — the priced
 *     total is then a lower bound. Advancing a ceiling-governing tripwire from a floor would read as
 *     "you are safely under" when the true figure is unknown, so an unmeasured
 *     rollup advances nothing. Measured live: the-gui-chat-surface-…8fa0ed had 8
 *     of 17 samples unpriced, and correctly stays blank.
 *
 * Both rules are one-directional: a refresh never clears or lowers a value it
 * cannot currently measure, so a transient unpriced sample cannot blank a
 * tripwire that was already scored.
 */

/**
 * The stored tripwire shape — mirrors `GoalTripwire` (sync-resolver/goals.ts).
 *
 * A `type` and not an `interface` deliberately: only a type alias gets TypeScript's
 * implicit index signature, and without one this is not assignable to postgres-js's
 * `JSONValue`, so the round-trip back into the jsonb column would not typecheck.
 */
export type GoalTripwireLike = {
  metric: string;
  label: string;
  threshold: number;
  current?: number | null;
  unit?: string;
  /**
   * PROVENANCE. Written ONLY by this module's platform-advance path; absent
   * means nobody measured this reading — an agent typed it (EI-21605510614702802).
   *
   * ⚠ This field is deliberately ABSENT from `TripwireSchema` (the zod shape
   * `goals:create` / `goals:update` / `goals:propose` validate against), and zod
   * strips unknown keys. An agent therefore cannot forge a stamp, and an agent
   * update that rewrites the tripwire array correctly DROPS the stamp — the
   * value it just hand-wrote reads as hand-set until the platform re-derives it.
   */
  measuredBy?: TripwireMeasuredBy | null;
  /**
   * An optional DECLARED evidence source for a metric the platform has no
   * built-in resolver for. Consulted only when `metric` has no entry in
   * RESOLVERS (see the precedence rule on {@link refreshTripwireCurrents}).
   */
  evidence?: TripwireEvidenceBinding | null;
};

/**
 * How a reading came to be, stamped at the moment the platform produced it.
 *
 * `value` is the hinge that makes hand-editing DETECTABLE rather than merely
 * discouraged. A stamp records the number it was issued for, so a later
 * hand-written `current` no longer matches its own stamp and {@link isDerived}
 * reports false. Without `value` a stale stamp would keep vouching for a number
 * nobody measured — the exact "stale manual values persist" failure this closes.
 *
 * A `type`, not an `interface`, for the same JSONValue-assignability reason
 * documented on {@link GoalTripwireLike}.
 */
export type TripwireMeasuredBy = {
  /** `resolver:<metric>` for a built-in, `evidence:<kind>:<ref>` for a declared binding. */
  source: string;
  /** When the platform WROTE this reading (not necessarily when it last confirmed it). */
  atMs: number;
  /** The value this stamp was issued for. A `current` that has drifted from it is hand-set. */
  value: number;
};

/**
 * A declared pointer at an authoritative evidence source.
 *
 * Deliberately opaque and tiny: this module never executes anything. The tick
 * that owns the evidence resolves it and passes the numbers in, exactly as
 * `spend-rollup` already does for spend — which is what keeps this module pure
 * and keeps arbitrary author-supplied queries out of the platform.
 */
export type TripwireEvidenceBinding = {
  /** Evidence family, e.g. `work-item-count`. An unrecognised kind resolves to nothing. */
  kind: string;
  /** Kind-specific selector (a saved query name, a rubricRef, a census artifact ref). */
  ref?: string;
};

/** The key a caller supplies evidence under. Stable, and the `evidence:` stamp suffix. */
export function evidenceKey(binding: TripwireEvidenceBinding): string {
  return `${binding.kind}:${binding.ref ?? ''}`;
}

/**
 * The facts a tripwire may be advanced FROM. Deliberately tiny: every field here
 * is platform-measured, and anything not derivable from these is left alone by
 * rule 1 above.
 */
export interface TripwireMeasurement {
  /**
   * Total attributed spend in CENTS, or null when the rollup is a floor
   * (`measured: false`) or absent. Null advances no spend tripwire.
   */
  measuredSpentCents: number | null;
  /**
   * The window, in seconds, that `measuredSpentCents` was summed over (the
   * rollup's `windowSec` — the goal's budget window), or null/absent for a
   * lifetime or unknown window. A window-suffixed spend metric (`spend_usd_7d`)
   * resolves ONLY when this equals its suffix; any other window leaves it
   * unmeasured rather than relabelling a different population (WI-10004419).
   */
  measuredWindowSec?: number | null;
  /** Age of the goal at measurement time, in ms. Negative values are treated as 0. */
  goalAgeMs: number;
  /**
   * Values for DECLARED evidence bindings, keyed by {@link evidenceKey}. A
   * binding with no entry here — or a null one — advances nothing, per rule 2.
   */
  evidence?: Readonly<Record<string, number | null>> | null;
  /** Clock for the provenance stamp. Defaults to `Date.now()` at call time. */
  nowMs?: number;
}

/**
 * Is this reading currently backed by a platform measurement?
 *
 * True only when a stamp exists AND still vouches for the number actually
 * stored. Everything else — no stamp, a stamp whose `value` has drifted from
 * `current` — is hand-set, and callers must not present it as a reading.
 */
export function isDerived(t: GoalTripwireLike): boolean {
  const stamp = t.measuredBy;
  if (!stamp || typeof stamp.source !== 'string' || !Number.isFinite(stamp.value)) return false;
  const current = readCurrent(t);
  return current !== null && current === stamp.value;
}

/** Why a tripwire did or did not move. */
export type TripwireRefreshReason =
  /** advanced to a freshly measured value */
  | 'advanced'
  /** a resolver exists and produced the value already stored */
  | 'unchanged'
  /** no generic resolver for this metric — the executor's to score (rule 1) */
  | 'no-resolver'
  /** a resolver exists but the input was absent or a floor (rule 2) */
  | 'unmeasured';

export interface TripwireRefreshOutcome {
  metric: string;
  before: number | null;
  after: number | null;
  reason: TripwireRefreshReason;
  /** Which measurement produced it — the value stamped into `measuredBy.source`. */
  source?: string;
}

export interface TripwireRefreshResult {
  /** The tripwire array to persist. Referentially equal to the input when nothing moved. */
  next: GoalTripwireLike[];
  outcomes: TripwireRefreshOutcome[];
  /** How many tripwires took a new value. */
  advanced: number;
  /**
   * How many kept their value but gained or corrected a provenance stamp. Counted
   * separately so "the number moved" stays answerable — `advanced` means what it
   * always did, and a caller can still tell a measurement change from a stamp fix.
   */
  restamped: number;
  /** Whether anything needs persisting: `advanced + restamped > 0`. */
  changed: boolean;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * A resolver returns the value a metric should now hold, or null for "I cannot
 * measure this right now" (which never overwrites).
 *
 * Keyed by METRIC NAME, not the free-text `unit` field: the metric name is the
 * contract a goal author writes against, while `unit` is a display label that
 * has been observed to disagree with it. `spend_usd` therefore yields dollars
 * whatever `unit` says.
 */
type Resolver = (m: TripwireMeasurement) => number | null;

/**
 * Window suffixes a spend metric may carry, mapped to the rollup window (seconds)
 * each one names (WI-10004419).
 *
 * A goal that declares `spend_usd_7d` ("trailing-7d spend vs a weekly ceiling")
 * used to fall through to the no-resolver path and keep whatever number it was
 * authored with — a kill criterion that silently never moved while the rollup
 * measured the real spend. The suffix is a CLAIM about the window, so it is
 * honoured only when the measurement was actually taken over that window: a 7d
 * metric fed a 24h or lifetime rollup stays unmeasured (rule 2), never a
 * mislabelled number.
 */
const SPEND_WINDOW_SUFFIXES: Readonly<Record<string, number>> = {
  '24h': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
};

/** Measured cents over exactly `windowSec`, or null when the window differs or is unknown. */
function windowedSpendCents(m: TripwireMeasurement, windowSec: number): number | null {
  if (m.measuredSpentCents === null || m.measuredWindowSec !== windowSec) return null;
  return Math.round(m.measuredSpentCents);
}

const WINDOWED_SPEND_RESOLVERS: Record<string, Resolver> = Object.fromEntries(
  Object.entries(SPEND_WINDOW_SUFFIXES).flatMap(([suffix, windowSec]): Array<[string, Resolver]> => [
    [
      `spend_usd_${suffix}`,
      (m) => {
        const cents = windowedSpendCents(m, windowSec);
        return cents === null ? null : cents / 100;
      },
    ],
    [`spend_cents_${suffix}`, (m) => windowedSpendCents(m, windowSec)],
  ]),
);

const RESOLVERS: Record<string, Resolver> = {
  /** Dollars, 2dp — the ceiling most goals declare. */
  spend_usd: (m) => (m.measuredSpentCents === null ? null : Math.round(m.measuredSpentCents) / 100),
  /** Cents, as stored. */
  spend_cents: (m) => (m.measuredSpentCents === null ? null : Math.round(m.measuredSpentCents)),
  /** `spend_{usd,cents}_{24h,7d,30d}` — only when the rollup window matches the suffix. */
  ...WINDOWED_SPEND_RESOLVERS,
  /** Whole days since the goal was created. */
  days_elapsed: (m) => Math.floor(Math.max(0, m.goalAgeMs) / MS_PER_DAY),
  /** Whole hours since the goal was created. */
  hours_elapsed: (m) => Math.floor(Math.max(0, m.goalAgeMs) / MS_PER_HOUR),
};

/** The metrics this module can advance without an executor. Exported for tests + docs. */
export const GENERICALLY_MEASURABLE_METRICS: readonly string[] = Object.keys(RESOLVERS).sort();

/**
 * What POPULATION each metric's `current` actually measured
 * (spend-attribution…-2026-09-04 P-004).
 *
 * A breach reason reading `spend_usd 62 reached threshold 100` invites the
 * reader to hear "this goal has spent $62" — a fact about the goal. It is not:
 * the spend resolvers are fed `measuredSpentCents`, which the rollup sets from
 * the goal-attributed (lineage) stream over the goal's budget window (D-011),
 * so it is a fact about that window, not the goal's lifetime, and excludes the
 * diagnostic pot and session legs entirely. At a breach that misreading is
 * expensive, because the readout is attached to a pause.
 *
 * Kept HERE, next to RESOLVERS, rather than at the readout site: this is a
 * description of what each resolver reads, and it goes stale the moment the two
 * drift apart. `tripwire-metric-populations.test.ts` fails if a resolver is
 * added without a population, so the pair cannot silently separate.
 */
export const METRIC_POPULATION: Record<string, string> = {
  spend_usd: 'attributed-by-lineage:authoritative',
  spend_cents: 'attributed-by-lineage:authoritative',
  // Same lineage stream; the suffix only restricts WHEN it resolves.
  ...Object.fromEntries(
    Object.keys(WINDOWED_SPEND_RESOLVERS).map((metric) => [metric, 'attributed-by-lineage:authoritative']),
  ),
  days_elapsed: 'goal-lifetime',
  hours_elapsed: 'goal-lifetime',
};

/**
 * The population label for a metric, or null when the metric is not one this
 * module resolves (a declared evidence binding supplies its own meaning, and
 * inventing a label for it here would be exactly the drift above).
 */
export function populationForMetric(metric: string): string | null {
  return METRIC_POPULATION[metric] ?? null;
}

/**
 * A tripwire that READS as platform-measured but that nothing will ever measure
 * (WI-10004424).
 *
 * The no-resolver path is correct by rule 1 — but it is silent, and a metric
 * named like a platform metric (`spend_usd_week`, `spend_total`, `days_left`)
 * takes it while looking exactly like one the rollup advances. Its `current`
 * then keeps whatever was authored forever, so the kill criterion reads as
 * measured while being decorative. Observed on goal 60d3a8: a spend bar
 * showing $34.91 against $102.78 actually measured (WI-10004419).
 *
 * Advisory, never a refusal: a metric the platform cannot resolve is still a
 * legitimate executor-scored metric. The goal write tools surface these so the
 * author learns at write time, not from a bar that never moves.
 */
export interface TripwireMeasurabilityAdvisory {
  metric: string;
  code: 'platform-shaped-metric-unresolved' | 'spend-window-never-measured';
  /** The resolvable metric to use instead, or null when none fits. */
  suggestedMetric: string | null;
  message: string;
}

const WINDOW_ALIASES: Readonly<Record<string, string>> = {
  '24h': '24h', '1d': '24h', day: '24h', daily: '24h',
  '7d': '7d', '1w': '7d', week: '7d', weekly: '7d',
  '30d': '30d', month: '30d', monthly: '30d',
};

/*
 * "Platform-shaped" is decided by VOCABULARY, not by prefix alone. A prefix
 * rule flags `hours_since_verdict_advance` (a live executor-scored metric, see
 * the tests) and would tell its author to swap it for goal age, which is a
 * different quantity. A name qualifies only when every word after the family
 * is one the platform's own metrics use, so `spend_usd_week` and `days_left`
 * qualify while `spend_ads_usd` and `hours_since_verdict_advance` do not.
 */
const SPEND_WORDS = new Set([
  'usd', 'cents', 'cent', 'dollars', 'total', 'all', 'lifetime', 'cumulative', 'measured',
  'attributed', 'so', 'far', 'to', 'date', 'fleet', 'agent', 'agents', 'compute', 'llm',
  'inference', 'goal', ...Object.keys(WINDOW_ALIASES),
]);
const GOAL_AGE_WORDS = new Set([
  'elapsed', 'left', 'remaining', 'total', 'used', 'running', 'active', 'open', 'age', 'since',
  'start', 'started', 'creation', 'created', 'launch', 'launched', 'kickoff', 'in', 'so', 'far', 'goal',
]);

/** The platform family a metric name claims, or null when it reads as a domain metric. */
function platformShapedFamily(metric: string): 'spend' | 'days' | 'hours' | null {
  const [family, ...rest] = metric.toLowerCase().split('_');
  const vocab = family === 'spend' ? SPEND_WORDS : family === 'days' || family === 'hours' ? GOAL_AGE_WORDS : null;
  if (!vocab) return null;
  return rest.filter(Boolean).every((w) => vocab.has(w)) ? (family as 'spend' | 'days' | 'hours') : null;
}

/** The resolvable metric nearest to a platform-shaped name, or null. */
function nearestResolvableMetric(metric: string): string | null {
  const lower = metric.toLowerCase();
  if (RESOLVERS[lower]) return lower;
  const family = platformShapedFamily(lower);
  if (family === 'days') return 'days_elapsed';
  if (family === 'hours') return 'hours_elapsed';
  if (family !== 'spend') return null;
  const unit = lower.includes('cent') ? 'cents' : 'usd';
  const window = lower
    .split('_')
    .map((part) => WINDOW_ALIASES[part])
    .find((w) => w !== undefined);
  const suggestion = window ? `spend_${unit}_${window}` : `spend_${unit}`;
  return RESOLVERS[suggestion] ? suggestion : null;
}

/**
 * Tripwires whose metric will never be measured although it looks as if it
 * will, with the nearest metric that would be.
 *
 * Two cases:
 *  - a platform-shaped name with no resolver and no declared evidence binding;
 *  - a window-suffixed spend metric whose suffix differs from the goal's budget
 *    window, which the resolver deliberately never answers (WI-10004419).
 *    Checked only when `budgetWindowSec` is supplied: `null` means a lifetime
 *    window, `undefined` means the caller does not know it.
 */
export function unmeasuredTripwireAdvisories(
  tripwires: ReadonlyArray<{ metric: string; evidence?: unknown }> | null | undefined,
  opts: { budgetWindowSec?: number | null } = {},
): TripwireMeasurabilityAdvisory[] {
  const out: TripwireMeasurabilityAdvisory[] = [];
  for (const t of tripwires ?? []) {
    if (typeof t?.metric !== 'string') continue;
    const metric = t.metric;
    if (RESOLVERS[metric]) {
      if (opts.budgetWindowSec === undefined) continue;
      const suffix = Object.keys(SPEND_WINDOW_SUFFIXES).find((s) => metric.endsWith(`_${s}`));
      if (!suffix || !metric.startsWith('spend_')) continue;
      const windowSec = SPEND_WINDOW_SUFFIXES[suffix];
      if (opts.budgetWindowSec === windowSec) continue;
      const unbounded = metric.slice(0, -(suffix.length + 1));
      out.push({
        metric,
        code: 'spend-window-never-measured',
        suggestedMetric: opts.budgetWindowSec === null ? unbounded : null,
        message:
          `tripwire "${metric}" is resolved only when the goal's budget window is ${windowSec}s, ` +
          `but it is ${opts.budgetWindowSec === null ? 'unset (lifetime)' : `${opts.budgetWindowSec}s`}, so it will never be measured. ` +
          `Set budgetWindowSec to ${windowSec}${opts.budgetWindowSec === null ? `, or use "${unbounded}"` : ''}.`,
      });
      continue;
    }
    const family = platformShapedFamily(metric);
    if (!family) continue;
    const evidence = t.evidence as { kind?: unknown } | null | undefined;
    if (evidence && typeof evidence.kind === 'string' && evidence.kind) continue;
    const suggestedMetric = nearestResolvableMetric(metric);
    const countsUp = family === 'spend' ? '' : ' (it counts up from goal creation, so its threshold is the total)';
    out.push({
      metric,
      code: 'platform-shaped-metric-unresolved',
      suggestedMetric,
      message:
        `tripwire "${metric}" looks platform-measured, but no resolver measures it, so its current stays as written and it never fires on a measurement. ` +
        (suggestedMetric
          ? `Use "${suggestedMetric}"${countsUp} for a measured bar, or keep it and report current yourself.`
          : `Measured metrics: ${GENERICALLY_MEASURABLE_METRICS.join(', ')}.`),
    });
  }
  return out;
}

/** Normalise a stored `current` (absent | null | non-finite) to null. */
function readCurrent(t: GoalTripwireLike): number | null {
  return typeof t.current === 'number' && Number.isFinite(t.current) ? t.current : null;
}

/**
 * Advance every generically-measurable tripwire, leaving the rest untouched.
 *
 * PURE — no clock, no I/O. The caller supplies the measurement, which is what
 * makes the whole policy (rules 1 and 2 above) testable without a database.
 */
export function refreshTripwireCurrents(
  tripwires: readonly GoalTripwireLike[] | null | undefined,
  measurement: TripwireMeasurement,
): TripwireRefreshResult {
  const input = tripwires ?? [];
  if (input.length === 0) {
    return { next: [], outcomes: [], advanced: 0, restamped: 0, changed: false };
  }

  const outcomes: TripwireRefreshOutcome[] = [];
  const next: GoalTripwireLike[] = [];
  const nowMs = Number.isFinite(measurement.nowMs) ? (measurement.nowMs as number) : Date.now();
  let advanced = 0;
  let restamped = 0;

  for (const t of input) {
    const before = readCurrent(t);
    const resolver = RESOLVERS[t.metric];

    /*
     * PRECEDENCE, and it is a security property rather than a preference: a
     * built-in resolver ALWAYS wins over a declared binding. Spend truth comes
     * from the platform cost ledger (goal-mode-design-intent-hardening D-003),
     * so a goal author must not be able to point `spend_usd` at an evidence ref
     * of their choosing and have the platform stamp the result as measured.
     * Bindings therefore only reach metrics the platform has no opinion about.
     */
    let value: number | null = null;
    let source: string | null = null;
    if (resolver) {
      value = resolver(measurement);
      source = `resolver:${t.metric}`;
    } else if (t.evidence && typeof t.evidence.kind === 'string' && t.evidence.kind) {
      const key = evidenceKey(t.evidence);
      const supplied = measurement.evidence?.[key];
      value = typeof supplied === 'number' && Number.isFinite(supplied) ? supplied : null;
      source = `evidence:${key}`;
    }

    if (source === null) {
      // Rule 1 — no resolver and no binding. The executor's to score. Byte-identical.
      outcomes.push({ metric: t.metric, before, after: before, reason: 'no-resolver' });
      next.push(t);
      continue;
    }

    if (value === null || !Number.isFinite(value)) {
      // Rule 2 — a floor, an absent binding value, or nothing measured. Never
      // clears an existing value, and never touches its stamp: a binding that
      // stops resolving leaves the last reading standing with its ORIGINAL
      // `atMs`, which is what lets a reader see it going stale.
      outcomes.push({ metric: t.metric, before, after: before, reason: 'unmeasured', source });
      next.push(t);
      continue;
    }

    if (before !== null && before === value) {
      /*
       * The value is right, but the STAMP may not be: an unstamped reading (one
       * written before provenance existed, or hand-typed to coincidentally the
       * measured number) would otherwise read as hand-set forever. Re-stamp it —
       * the platform did just produce this number — while still skipping the
       * write when the stamp already vouches for it.
       */
      if (isDerived(t) && t.measuredBy?.source === source) {
        outcomes.push({ metric: t.metric, before, after: before, reason: 'unchanged', source });
        next.push(t);
        continue;
      }
      outcomes.push({ metric: t.metric, before, after: value, reason: 'unchanged', source });
      next.push({ ...t, current: value, measuredBy: { source, atMs: nowMs, value } });
      restamped += 1;
      continue;
    }

    outcomes.push({ metric: t.metric, before, after: value, reason: 'advanced', source });
    next.push({ ...t, current: value, measuredBy: { source, atMs: nowMs, value } });
    advanced += 1;
  }

  // Referential identity when nothing moved, so a caller can skip the write.
  // A re-stamp counts as movement even though no number changed: the stamp is
  // what separates a measurement from a hand-set value, so it has to persist.
  if (advanced === 0 && restamped === 0) {
    return { next: input as GoalTripwireLike[], outcomes, advanced: 0, restamped: 0, changed: false };
  }
  return { next, outcomes, advanced, restamped, changed: true };
}

/**
 * Which PLATFORM-MEASURED tripwires are now AT OR PAST their threshold.
 *
 * The point of advancing `current` at all: a kill criterion that scores itself
 * can fire. This reports the breaches for the caller to log/surface — it does
 * NOT act on them. Killing a goal on a measured breach is a separate, deliberate
 * decision (and an owner-facing one); silently escalating a reporting sweep into
 * a terminal action is exactly the kind of leap this plan is written against.
 *
 * Executor-owned domain metrics are deliberately excluded. The platform has no
 * resolver for them, so their stored `current` may be a seeded value, a stale
 * snapshot, or a decreasing-to-zero progress count. Treating every numeric value
 * as an upper-bound measurement previously auto-killed goals such as
 * `openReleaseWalls: current=2, threshold=0` even though zero had not been
 * reached. Only metrics in RESOLVERS have the measurement semantics required for
 * a platform-side terminal transition; executors remain responsible for acting
 * on their own domain tripwires.
 */
export function breachedTripwires(
  tripwires: readonly GoalTripwireLike[],
): Array<{ metric: string; current: number; threshold: number; unit?: string }> {
  const out: Array<{ metric: string; current: number; threshold: number; unit?: string }> = [];
  for (const t of tripwires) {
    if (!RESOLVERS[t.metric]) continue;
    const current = readCurrent(t);
    if (current === null || !Number.isFinite(t.threshold)) continue;
    if (current >= t.threshold) {
      out.push({
        metric: t.metric,
        current,
        threshold: t.threshold,
        ...(t.unit ? { unit: t.unit } : {}),
      });
    }
  }
  return out;
}
