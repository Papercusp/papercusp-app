/**
 * Dark-flag-age watchdog (enforce-system-on-generic-work-2026-06-29 P-013).
 *
 * The DARK_FLAGS allowlist (libs/flags/src/types.ts) is the consciously-default-OFF
 * set. Two invariants keep it from silently rotting into a parking lot: its
 * parked/incomplete subset must stay below DARK_FLAGS_HIGH_WATERMARK, and the full set
 * must be RE-REVIEWED by DARK_FLAGS_REVIEW_BY. production-defaults.test.ts already enforces both — but at
 * TEST time, so a breach only surfaces when someone runs the suite. This module is the
 * OPERATOR-scoped recurrence guard: on the watchdog cadence it surfaces the SAME two
 * concerns into the owner's improvement queue BEFORE the deadline lands / the ceiling
 * is hit, so the review is prompted, not discovered late by a red CI run.
 *
 * Mirrors done-without-test-detect.ts (its sibling P-009 guard): a PURE detector + a
 * tiny collector, no import from the large watchdog.ts (and no dependency on the
 * WatchdogSource union — the finding is its own type, structurally a WatchdogSignal).
 * Unlike the per-harness siblings this is WORKSPACE-GLOBAL — the dark set is ONE global
 * registry — so it emits ONE operator-scoped finding (no harness scope; deliberately
 * NOT in HARNESS_SCOPED_WATCHDOG_SOURCES). No flag gate: a healthy allowlist (well under
 * the watermark, review-by comfortably ahead) produces nothing by design, so it only
 * fires when the situation genuinely needs owner attention.
 */

/** One day in ms — the unit `daysToReview` is reported in. */
const DAY_MS = 86_400_000;

/**
 * Resolution cooldown for dark-flag-age findings (EI-9190, twin of EI-427 /
 * insight-staleness's DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS). Unlike the deploy-lag
 * case this isn't about a scanned tree lagging staging — it's that the underlying
 * state (dark count, review-by) genuinely does NOT change between watchdog ticks
 * unless a human edits libs/flags/src/types.ts. Without a cooldown, every 15-min
 * tick after a resolution (a peer reviewed the set and found nothing to change, or
 * just pushed review-by out) re-evaluates the SAME unchanged inputs and re-fires a
 * near-duplicate finding (observed: resolved 11:06Z, re-fired 12:31Z, ~85min /
 * ~6 ticks later, reporting the identical review-by + count). 24h comfortably
 * outlasts that churn while still letting a genuinely stale review re-surface within
 * a day of the cooldown lapsing.
 */
export const DEFAULT_DARK_FLAG_AGE_RESOLUTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Inputs the pure detector reasons over (the collector reads them from @papercusp/flags). */
export interface DarkFlagAgeInput {
  /** Count of parked/incomplete DARK_FLAGS entries subject to the parking budget. */
  darkCount: number;
  /** DARK_FLAGS_HIGH_WATERMARK — the size ceiling for parked/incomplete entries. */
  watermark: number;
  /** DARK_FLAGS_REVIEW_BY — the ISO date the allowlist must be re-reviewed by. */
  reviewBy: string;
  /** 'now' in ms (the runtime clock at the collector; injected in tests). */
  now: number;
  /** Emit when review-by is within this many days (or already past). Default 14. */
  reviewWithinDays?: number;
  /** Emit when darkCount >= watermark - this ("at/near the watermark"). Default 2. */
  nearWatermarkSlack?: number;
  /**
   * Suppression window (ms) after a resolved dup before this same-state finding may
   * re-file (EI-9190). Default DEFAULT_DARK_FLAG_AGE_RESOLUTION_COOLDOWN_MS.
   */
  resolutionCooldownMs?: number;
}

/** The structured metric carried on the finding (also rendered into `body`). */
export interface DarkFlagAgeMetric {
  darkCount: number;
  watermark: number;
  reviewBy: string;
  /** Whole days until reviewBy; negative once past it. */
  daysToReview: number;
}

/**
 * A dark-flag-age finding, shaped to map directly onto a WatchdogSignal at the
 * collector site (its own type so this pure module needs no import from watchdog.ts).
 * OPERATOR-scoped (workspace-global): one finding, a stable key, no harness scope.
 */
export interface DarkFlagAgeFinding {
  source: 'dark-flag-age';
  /** dedup key — a single, stable global finding. */
  key: 'dark-flags';
  /** STABLE title (no counts/dates — those live in body/metric so dedup matches across ticks). */
  title: string;
  body: string;
  /** minor while merely approaching; major once past review-by OR at/over the watermark. */
  severity: 'minor' | 'major';
  /** operator (workspace-global) — NOT a harness scope. */
  scope: 'operator';
  findingClass: 'flags:dark-flag-age';
  /** Structured detail (also embedded in `body`). */
  metric: DarkFlagAgeMetric;
  /**
   * Newest evidence timestamp (EI-9190 — the watchdog.ts resolution-cooldown feed
   * keys off this). Always 'now': a live-state re-evaluation, so its evidence is
   * always fresh relative to any prior resolution.
   */
  latestAt: string;
  /**
   * Suppression window after a resolved dup (EI-9190) — see
   * DEFAULT_DARK_FLAG_AGE_RESOLUTION_COOLDOWN_MS.
   */
  resolutionCooldownMs: number;
}

/**
 * Surface the dark allowlist for owner attention. Pure: the caller supplies the
 * current dark count, the watermark, the review-by date, and 'now'.
 *
 * Detection predicate — emit ONE finding when EITHER:
 *   (a) review-by is within `reviewWithinDays` (default 14) days OR already PAST, OR
 *   (b) the parked/incomplete count is at/near the watermark: darkCount >= watermark - `nearWatermarkSlack`
 *       (default slack 2).
 * Severity is MAJOR when the situation is already BREACHED — past review-by OR at/over
 * the watermark (darkCount >= watermark) — and MINOR while merely APPROACHING either.
 * A healthy allowlist (review-by comfortably ahead AND well under the watermark) yields
 * no finding. An unparseable review-by is treated as DUE NOW (fail loud, not silent — a
 * broken DARK_FLAGS_REVIEW_BY is itself something the owner must fix).
 */
export function detectDarkFlagAge(input: DarkFlagAgeInput): DarkFlagAgeFinding[] {
  const reviewWithinDays = input.reviewWithinDays ?? 14;
  const nearWatermarkSlack = input.nearWatermarkSlack ?? 2;

  const reviewByMs = Date.parse(input.reviewBy);
  // Unparseable date ⇒ treat the review as due NOW (msToReview = 0), never silent.
  const msToReview = Number.isFinite(reviewByMs) ? reviewByMs - input.now : 0;
  const daysToReview = Math.ceil(msToReview / DAY_MS);

  const reviewPast = msToReview < 0;
  const reviewSoon = msToReview <= reviewWithinDays * DAY_MS; // within N days OR past
  const atWatermark = input.darkCount >= input.watermark;
  const nearWatermark = input.darkCount >= input.watermark - nearWatermarkSlack;

  if (!reviewSoon && !nearWatermark) return [];

  const severity: 'minor' | 'major' = reviewPast || atWatermark ? 'major' : 'minor';
  const metric: DarkFlagAgeMetric = {
    darkCount: input.darkCount,
    watermark: input.watermark,
    reviewBy: input.reviewBy,
    daysToReview,
  };

  const reviewPhrase = reviewPast
    ? `is ${Math.abs(daysToReview)} day(s) PAST its review-by (${input.reviewBy})`
    : `comes due in ${daysToReview} day(s) (${input.reviewBy})`;
  const countPhrase = atWatermark
    ? `at/over the high-watermark (${input.darkCount}/${input.watermark})`
    : `${input.darkCount}/${input.watermark} (within ${nearWatermarkSlack} of the watermark)`;

  return [
    {
      source: 'dark-flag-age' as const,
      key: 'dark-flags' as const,
      title: 'Dark-flag allowlist needs owner review',
      body:
        `The DARK_FLAGS allowlist needs owner attention: the review-by ${reviewPhrase}` +
        (nearWatermark ? `, and the parked/incomplete subset is ${countPhrase}` : '') +
        `. Walk every dark flag in libs/flags/src/types.ts — flip the ones now ready to default-ON ` +
        `(remove them from DARK_FLAGS), then push DARK_FLAGS_REVIEW_BY out with a fresh look. ` +
        `Raising the watermark needs explicit owner sign-off. ` +
        `(enforce-system-on-generic-work P-013; the production-defaults guard turns this red in CI too.)`,
      severity,
      scope: 'operator' as const,
      findingClass: 'flags:dark-flag-age' as const,
      metric,
      // EI-9190: same-state re-evaluation is always "fresh" relative to any prior
      // resolution, so latestAt is always 'now' — the cooldown below is what
      // actually suppresses the near-duplicate re-file.
      latestAt: new Date(input.now).toISOString(),
      resolutionCooldownMs: input.resolutionCooldownMs ?? DEFAULT_DARK_FLAG_AGE_RESOLUTION_COOLDOWN_MS,
    },
  ];
}

/**
 * The collector that feeds the pure detector (P-013). Reads the parked/incomplete
 * count, watermark, and review-by from @papercusp/flags (the single source of truth) and the
 * runtime clock for 'now'. WORKSPACE-GLOBAL: takes no workspaceId — DARK_FLAGS is one
 * global registry. No PG, no flag gate; trivially cheap for the per-tick watchdog.
 */
export async function collectDarkFlagAgeSignals(
  now: number = Date.now(),
): Promise<{ signals: DarkFlagAgeFinding[]; note?: string }> {
  const { DARK_FLAGS_PARKING_COUNT, DARK_FLAGS_HIGH_WATERMARK, DARK_FLAGS_PARKING_REVIEW_BY } =
    await import('@papercusp/flags');
  const signals = detectDarkFlagAge({
    darkCount: DARK_FLAGS_PARKING_COUNT,
    watermark: DARK_FLAGS_HIGH_WATERMARK,
    reviewBy: DARK_FLAGS_PARKING_REVIEW_BY,
    now,
  });
  return { signals };
}
