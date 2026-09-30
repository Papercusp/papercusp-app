/**
 * pause-clock — the DURABLE per-unit "how long has this been administratively
 * paused" clock behind EI-20003974512096022 fixes 1+2.
 *
 * ## Why this is not just a field on `flapStateByUnit`
 *
 * `unit-reconciler.ts`'s `flapStateByUnit` is a module-level in-memory Map. A
 * bg-host restart wipes it (already documented on that file for `wasDown`, in
 * EI-20083989508593730), and that amnesia is not a side-detail here — it is the
 * mechanism of the incident this exists to prevent, twice over:
 *
 *   1. the transition-only notify latch (`wasDown`) re-fires after every
 *      restart, which is how ONE 2-day pause of
 *      `papercup-live-federation-gate.timer` produced 16 identical
 *      "respecting the pause" broadcasts — read at the time as an ~8-minute
 *      repeat cadence, but actually one alert per process lifetime;
 *   2. more dangerously, a duration threshold computed from an in-memory clock
 *      RESETS WITH IT. An escalation gated on "paused > 4h" would then never
 *      fire on a box that restarts more often than every 4h — a guard that
 *      reports nothing and looks identical to a guard with nothing to report.
 *
 * systemd cannot supply the clock either. Measured 2026-08-12 against the real
 * paused unit: `systemctl --user show papercup-live-federation-gate.timer -p
 * InactiveEnterTimestamp` returns EMPTY, and `InactiveEnterTimestampMonotonic`
 * is `0`, for a `disabled` unit. A threshold built on that property would read
 * every pause as 0s old and, again, never fire.
 *
 * So the clock is ours and it is durable: migration 812,
 * `operator_supervision_pause_state`, read+written through the operator-state-pg
 * single-JSONB-row-per-workspace helpers — the same shape, and the same fix, as
 * migration 635 / `operator_liveness_flap_state` (EI-15126) applied to the same
 * class of bug one subsystem over.
 *
 * Everything here is FAIL-SOFT. A supervision tick must never be blocked or
 * crashed by its own bookkeeping, so a PG failure degrades to "decide against an
 * empty baseline" exactly as `liveness-alarm.ts`'s `defaultUpdateFlapState`
 * does. The cost of that degradation is one delayed escalation, never a wedged
 * reconciler.
 */

/** One supervised unit's pause bookkeeping. */
export interface UnitPauseRecord {
  /** Epoch ms at which this unit was FIRST observed administratively paused. */
  pausedSince: number;
  /** Epoch ms at which the persistent-pause EI was filed, or null if not yet. */
  escalatedAt: number | null;
  /** The last salience tier already broadcast, so a tier notifies once (see
   *  `PAUSE_SALIENCE_TIERS`). Null until the first pause notification. */
  lastNotifiedTier: string | null;
  /**
   * EI-20302762698704679: WHY this unit is paused, and WHO said so — the same
   * `{reason, by, reviewBy}` shape `routines:set`'s pause path already requires
   * (EI-18654017982759582 fixed the identical bug one layer over: a pause with no
   * recorded reason/owner stays silently off for days because every reader faces the
   * same unanswerable choice between re-arming it blind and leaving it alone).
   *
   * Pausing a systemd-user unit is NOT mediated by a Papercusp tool call (an operator
   * runs `systemctl --user disable --now <unit>` directly), so — unlike a routine pause
   * — there is no call site to REQUIRE this at pause time. It is instead set by
   * `supervision:annotate-pause` any time after the reconciler observes the pause (or
   * proactively, before its next tick), and PRESERVED verbatim by `decidePause` across
   * every tick until the unit resumes. Null/undefined means genuinely never annotated —
   * the reconciler's escalation treats that absence itself as the anomaly to report.
   */
  reason?: string | null;
  /** The ownerId (or role fallback) that recorded `reason`, via `supervision:annotate-pause`. */
  by?: string | null;
  /** ISO timestamp the annotator intends to re-review this pause by (the DARK_FLAGS_REVIEW_BY /
   *  routines-pause `reviewBy` analog for the same reason). Advisory only — nothing currently
   *  auto-acts on it past the existing PAUSE_SALIENCE_TIERS ramp. */
  reviewBy?: string | null;
}

/** The `{reason, by, reviewBy}` triple as seen by an annotator — every field optional so a
 *  partial re-annotation (e.g. only bumping `reviewBy`) does not require re-typing `reason`. */
export interface PauseAnnotation {
  reason?: string | null;
  by?: string | null;
  reviewBy?: string | null;
}

/** The whole durable payload: one record per unit name. */
export type PauseState = Record<string, UnitPauseRecord>;

/**
 * Fix 2 — salience ramps with duration.
 *
 * The incident's sharpest observation was that repetition WITHOUT escalation is
 * self-defeating: 16 identical FYIs trained every reader to filter them, so the
 * 16th carried strictly less information than the 1st. These tiers are the
 * answer — each one fires AT MOST ONCE per pause episode (gated by
 * `lastNotifiedTier` in durable state, so a host restart cannot replay a tier),
 * and each is louder than the last.
 *
 * Ordered ascending by `afterMs`; `pauseTierFor` picks the highest tier reached.
 * `kind:'escalation'` routes to the owner-visible escalation channel rather than
 * the ambient supervision category.
 */
export const PAUSE_SALIENCE_TIERS: readonly {
  id: string;
  afterMs: number;
  kind: 'message' | 'escalation';
  /** Human-readable duration used in the notification copy. */
  label: string;
}[] = [
  { id: 'observed', afterMs: 0, kind: 'message', label: 'just now' },
  { id: '1h', afterMs: 60 * 60 * 1000, kind: 'message', label: 'over an hour' },
  { id: '4h', afterMs: 4 * 60 * 60 * 1000, kind: 'escalation', label: 'over 4 hours' },
  { id: '24h', afterMs: 24 * 60 * 60 * 1000, kind: 'escalation', label: 'over a DAY' },
  { id: '72h', afterMs: 72 * 60 * 60 * 1000, kind: 'escalation', label: 'over THREE DAYS' },
] as const;

/**
 * Fix 1 — how long a pause must persist before it stops being an FYI and
 * becomes a filed, claimable work-item.
 *
 * The item specifies "hours, not days". 4h is deliberately the same boundary as
 * the first `escalation`-kind salience tier: the moment we judge a pause worth
 * waking the owner over is exactly the moment it is worth someone OWNING, and
 * splitting those two thresholds would only create a window where we shout
 * without filing — which is the original defect in miniature.
 */
export const PAUSE_ESCALATION_MS = 4 * 60 * 60 * 1000;

/** The highest salience tier reached by a pause of `durationMs`. Never null —
 *  the `observed` tier is `afterMs: 0`, so every pause has a tier. */
export function pauseTierFor(durationMs: number): (typeof PAUSE_SALIENCE_TIERS)[number] {
  let tier = PAUSE_SALIENCE_TIERS[0];
  for (const t of PAUSE_SALIENCE_TIERS) if (durationMs >= t.afterMs) tier = t;
  return tier;
}

/** What one tick decided for one paused unit. */
export interface PauseDecision {
  /** Epoch ms this unit was first seen paused (this tick's value, post-mutation). */
  pausedSince: number;
  /** How long it has been paused, per the durable clock. */
  durationMs: number;
  /** The salience tier reached. */
  tier: (typeof PAUSE_SALIENCE_TIERS)[number];
  /** True when this tier has NOT yet been broadcast for this episode — the
   *  transition gate that replaces the restart-amnesiac in-memory `wasDown`. */
  notify: boolean;
  /** True when the pause has outlived `PAUSE_ESCALATION_MS` and no EI has been
   *  filed yet for this episode — i.e. file one now (fix 1). */
  shouldEscalate: boolean;
}

/**
 * PURE: fold one observation of a PAUSED unit into its durable record, and
 * decide what this tick should do. Returns the next record alongside the
 * decision so the caller can persist it atomically.
 *
 * Split out from the store so the ramp/threshold logic is unit-testable without
 * PG — the same pure-decision + caller-persists shape as
 * `unit-reconciler.ts`'s `decideReconcile`.
 */
export function decidePause(
  prev: UnitPauseRecord | undefined,
  now: number,
): { next: UnitPauseRecord; decision: PauseDecision } {
  const pausedSince = prev?.pausedSince ?? now;
  const durationMs = Math.max(0, now - pausedSince);
  const tier = pauseTierFor(durationMs);

  const notify = prev?.lastNotifiedTier !== tier.id;
  const shouldEscalate = durationMs >= PAUSE_ESCALATION_MS && prev?.escalatedAt == null;

  return {
    next: {
      pausedSince,
      // Record the escalation the moment we decide to file, so a second tick
      // (or a second worker) cannot file a duplicate while the first file() is
      // still in flight. The EI escalator dedups too, but not until its own
      // round-trip completes.
      escalatedAt: shouldEscalate ? now : (prev?.escalatedAt ?? null),
      lastNotifiedTier: tier.id,
      // EI-20302762698704679: a tick-driven decision NEVER touches the annotation —
      // it is set only by `annotatePause` (via `supervision:annotate-pause`), and must
      // survive every tick unchanged. Dropping it here would silently un-annotate the
      // pause the moment the reconciler next ran.
      reason: prev?.reason ?? null,
      by: prev?.by ?? null,
      reviewBy: prev?.reviewBy ?? null,
    },
    decision: { pausedSince, durationMs, tier, notify, shouldEscalate },
  };
}

/**
 * EI-20302762698704679: record WHY (and by whom) a currently-paused unit is paused, and
 * optionally when to re-review it — the same durable annotation `routines:set`'s pause path
 * already requires, applied to the systemd-unit pause clock. Called by `supervision:annotate-pause`.
 *
 * Merges into the EXISTING record for `unit` when one exists (an annotation must never reset
 * `pausedSince`/`escalatedAt`/`lastNotifiedTier` — that would restart the clock this module
 * exists to make durable). When no record exists yet (annotating proactively, ahead of the
 * reconciler's next tick), seeds one with `pausedSince: now` so the annotation is not lost.
 *
 * A field OMITTED from `annotation` leaves the existing value untouched (a partial re-annotation,
 * e.g. bumping only `reviewBy`, does not require re-typing `reason`); a field explicitly passed as
 * `null` clears it.
 */
export async function annotatePause(
  unit: string,
  annotation: PauseAnnotation,
  now: number,
  deps?: PauseStoreDeps,
): Promise<UnitPauseRecord> {
  let result: UnitPauseRecord | undefined;
  await updatePauseState((current) => {
    const prev = current[unit];
    const next: UnitPauseRecord = {
      pausedSince: prev?.pausedSince ?? now,
      escalatedAt: prev?.escalatedAt ?? null,
      lastNotifiedTier: prev?.lastNotifiedTier ?? null,
      reason: 'reason' in annotation ? (annotation.reason ?? null) : (prev?.reason ?? null),
      by: 'by' in annotation ? (annotation.by ?? null) : (prev?.by ?? null),
      reviewBy: 'reviewBy' in annotation ? (annotation.reviewBy ?? null) : (prev?.reviewBy ?? null),
    };
    result = next;
    return { ...current, [unit]: next };
  }, deps);
  // `updatePauseState` always invokes the mutator synchronously (production, the VITEST
  // fallback, and the hermetic catch path alike), so `result` is always assigned above.
  return result!;
}

/** Render a pause duration for notification copy — coarse on purpose (the tier
 *  label carries the urgency; this carries the precision). */
export function formatPauseDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ── Durable store ───────────────────────────────────────────────────────────

/** DI seam so the reconciler's pause logic unit-tests without PG. */
export interface PauseStoreDeps {
  update(mutate: (current: PauseState) => PauseState): Promise<PauseState>;
}

/** Hermetic fallback used when no `deps` are injected AND PG is unreachable —
 *  mirrors `liveness-alarm.ts`'s `hermeticFlapStateFallback`. Process-local, so
 *  it restores exactly the pre-812 behaviour rather than inventing a new one. */
let hermeticFallback: PauseState = {};

/** Test seam. */
export function _resetPauseClockForTests(): void {
  hermeticFallback = {};
}

/**
 * Atomic read-modify-write of the durable pause state.
 *
 * Production wraps read+mutate+write in ONE PG transaction with
 * `SELECT … FOR UPDATE` (see operator-state-pg's `updateOperatorState`), so two
 * overlapping reconciler ticks cannot lost-update each other — the exact race
 * EI-18673998482704275 documented for the liveness alarm's flap counters. The
 * mutator MUST be pure + synchronous for that reason: it runs while the row is
 * held under `FOR UPDATE`.
 */
export async function updatePauseState(
  mutate: (current: PauseState) => PauseState,
  deps?: PauseStoreDeps,
): Promise<PauseState> {
  if (deps) return deps.update(mutate);
  // VITEST-without-`deps` safety gate (same rule as episodic-ei.ts): a unit test exercising the
  // reconciler's DETECTION logic must never reach production PG. It falls through to the
  // process-local fallback below, which `_resetPauseClockForTests` clears between tests.
  if (process.env.VITEST) {
    hermeticFallback = mutate(hermeticFallback);
    return hermeticFallback;
  }
  try {
    const { updateOperatorState } = await import('../operator-state-pg');
    let next: PauseState = {};
    await updateOperatorState<PauseState>('operator_supervision_pause_state', {}, (current) => {
      next = mutate(current ?? {});
      return next;
    });
    hermeticFallback = next;
    return next;
  } catch {
    // Fail-soft: a supervision tick must never be crashed by its own
    // bookkeeping. Degrading to process-local state costs at most a delayed
    // escalation; it re-derives on the next tick that reaches PG.
    hermeticFallback = mutate(hermeticFallback);
    return hermeticFallback;
  }
}
