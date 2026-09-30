/**
 * signal-actor-registry — every monitoring/freshness SIGNAL must declare its
 * ACTING consumer, or an explicit accepted-risk waiver with an expiry
 * (EI-7347, 2026-07-05).
 *
 * The WI-2374 rubric-emission incident generalizes: `scorecards:freshness`
 * had 172 reads by 61 agents and ZERO consumers that ACTED on a stale
 * verdict — emission died silently for ~34h because a "signal" existed but
 * nothing was wired to DO anything when it went bad. The same read-only-
 * signal trap recurs across the platform: a health panel, a freshness
 * check, or an alarm interpreter that only ever returns `actionable: false`
 * is a signal with no teeth. `coord:conditions` is a confirmed live
 * instance (see its registration below) — its own docstring says "Read-only
 * … it never fires on a transition" (service-health-events.ts).
 *
 * This is a SMALL, MANUALLY-curated catalog (same shape as
 * `testing-domains-registry.ts` / `KNOWN_DARK_FLAGS`), not an automatic
 * codebase scan — "what counts as a monitoring signal" is not mechanically
 * decidable, so new signals are registered here as they are built or
 * discovered. The enforcement is the coverage invariant every entry must
 * satisfy:
 *
 *   - `actingConsumer` set (something concrete periodically re-evaluates
 *     the signal and takes action — fires an alarm, escalates, files a
 *     floor, wakes an await key, …), OR
 *   - a `waiver` whose `expiresAt` has not passed (an accepted, tracked,
 *     time-boxed gap — mirrors `KNOWN_DARK_FLAGS`' expiry discipline so a
 *     "we'll wire an actor later" can't linger silently forever).
 *
 * `signal-actor-registry.test.ts` REDS the moment either condition lapses —
 * a new signal registered with neither, or a waiver whose expiry has
 * passed — so "we built a signal" can no longer silently mean "the signal
 * is decorative."
 *
 * Companion sweep (provenance-diversity — flag any signal stream where
 * >95% of rows come from ONE emitter, the monoculture that made rubric
 * emission fragile) is a natural next step but is NOT built here; tracked
 * as a follow-up rather than scope-creeping this seed registry.
 */

/** An accepted, tracked, time-boxed exception to the actor mandate. */
export interface SignalActorWaiver {
  /** Why no actor exists yet / why acting is deliberately deferred. */
  reason: string;
  /** ISO timestamp this waiver must be revisited by — past this, coverage fails. */
  expiresAt: string;
  /** Who accepted the risk (ownerId / role). */
  acceptedBy: string;
  /** Tracking ref for the follow-up that will close the gap (WI-xxx / EI-xxx). */
  followUp?: string;
}

/** One registered monitoring/freshness signal. */
export interface SignalActorEntry {
  /** Stable, kebab-case id (matches the tool/panel name where practical). */
  id: string;
  /** What the signal reports and why it exists. */
  description: string;
  /** Where the signal is emitted/read from (file path or tool name). */
  source: string;
  /**
   * What ACTS on the signal — fires an alarm, opens/resolves an escalation,
   * files a floor, wakes an await key, self-debounces a re-fire, etc.
   * Required unless a live `waiver` is present.
   */
  actingConsumer?: string;
  /** file[#symbol] pointer(s) into the consumer, for spot-checking. */
  consumerRefs?: string[];
  waiver?: SignalActorWaiver;
}

const registry = new Map<string, SignalActorEntry>();

/** Register a signal. Throws on a duplicate id — ids are stable + unique. */
export function defineSignal(entry: SignalActorEntry): void {
  if (registry.has(entry.id)) {
    throw new Error(`signal-actor-registry: duplicate signal id "${entry.id}"`);
  }
  registry.set(entry.id, entry);
}

export function getSignal(id: string): SignalActorEntry | undefined {
  return registry.get(id);
}

export function listSignals(): SignalActorEntry[] {
  return [...registry.values()];
}

/** True when `entry` currently satisfies the actor-or-live-waiver mandate. */
export function isSignalCovered(entry: SignalActorEntry, now: number = Date.now()): boolean {
  if (entry.actingConsumer && entry.actingConsumer.trim().length > 0) return true;
  if (entry.waiver) return new Date(entry.waiver.expiresAt).getTime() > now;
  return false;
}

/** Every signal that is NEITHER actor-backed NOR waiver-covered right now. */
export function uncoveredSignals(now: number = Date.now()): SignalActorEntry[] {
  return listSignals().filter((e) => !isSignalCovered(e, now));
}

/* ---------------------------------------------------------------- *
 * Seed registrations — the 4 signal categories named in EI-7347.
 * Extend this list as new monitoring/freshness signals ship; a signal
 * with neither an actor nor a live waiver fails signal-actor-registry.test.ts.
 * ---------------------------------------------------------------- */

defineSignal({
  id: 'scorecards-freshness',
  description:
    "Has the Kettle emitted a COMPLETE rubric scorecard since its last wake? The WI-2374 " +
    'incident signal: 172 reads / 61 agents, zero actors, died silently for ~34h.',
  source: 'packages/operator-core/lib/scorecard-freshness.ts (checkScorecardFreshness / interpretOverwatchEmission)',
  actingConsumer:
    'scorecard-emission-pulse files a deterministic synthesized floor whenever the freshness window ' +
    'is empty (decoupled from overwatch aliveness, WI-2374); interpretOverwatchEmission classifies ' +
    'a real gap as loop-dead vs agent-skipping, and the infra-liveness alarm escalates both ' +
    "(`rubric-emission-dark`, `overwatch-scorecard-skipped`) to the owner.",
  consumerRefs: [
    'packages/operator-core/lib/scorecard-emission-pulse.ts#runScorecardEmissionPulse',
    'packages/operator-core/lib/system-health/liveness-alarm.ts#evaluateLivenessAlarm',
  ],
});

defineSignal({
  id: 'liveness-alarm',
  description:
    'The request-path infra-supervision signal: dead routines, queen/overwatch dark, a stale ' +
    'health-tick snapshot, an all-paused LLM account pool, or any panel self-reporting `crit`.',
  source: 'packages/operator-core/lib/system-health/liveness-alarm.ts (evaluateLivenessAlarm)',
  actingConsumer:
    'runLivenessAlarmTick opens a durably-deduped (per-signature) owner escalation for every NEW ' +
    'signal and auto-resolves it the moment the condition clears — self-contained signal+action, ' +
    'ticked every ~2min on a request worker (startInfraLivenessAlarm).',
  consumerRefs: ['packages/operator-core/lib/system-health/liveness-alarm.ts#runLivenessAlarmTick'],
});

defineSignal({
  id: 'hive-watchdog-fires',
  description:
    'The shared `harness_shared.pot_watchdog_fires` ledger every *-watchdog.ts source writes a row ' +
    'to on each fire (scorecard-pulse, overwatch, hive queen, scout draft-review, release-deploy-staleness, …).',
  source: 'harness_shared.pot_watchdog_fires (mig 212)',
  actingConsumer:
    'Each watchdog reads its OWN recent fire count from this ledger to self-debounce re-firing — the ' +
    "ledger is a durable per-source cooldown gate, not a passive log nobody reads. Not the same trap " +
    'as scorecards-freshness (which had a reader with no actor); here every writer is also a reader-actor.',
  consumerRefs: [
    'packages/operator-core/lib/hive/watchdog.ts',
    'packages/operator-core/lib/overwatch/watchdog.ts',
    'packages/operator-core/lib/scout/draft-review-watchdog.ts',
  ],
});

defineSignal({
  id: 'coord-conditions',
  description:
    "coord:conditions folds condition-keyed alarm/resolution broadcasts (severe-event-broadcast.ts) " +
    'into current open/resolved state — the live "what is wrong RIGHT NOW" view (EI-6138).',
  source: 'packages/operator-core/lib/agent-tools/coordination/tools/conditions.ts (computeConditionStates)',
  // WI-2965 (closed): condition-staleness-alarm.ts is the periodic ACTOR — it re-folds
  // computeConditionStates() on a managedSetInterval tick (startConditionStalenessAlarm,
  // wired in apps/operator/bin/hono-host.ts alongside startInfraLivenessAlarm) and fires ONE
  // durably-deduped/auto-resolved reminder escalation for any condition still OPEN past
  // staleMs (default 45min) — deliberately NOT a re-alert on every open condition (each
  // source watchdog already fires its own immediate owner alert at open-time; this only
  // catches the "stayed open and nobody actioned it" gap, namespaced stale-condition:<key>
  // so it can never collide with a source's own signature).
  actingConsumer:
    'condition-staleness-alarm.ts: startConditionStalenessAlarm() ticks runConditionStalenessTick() ' +
    'every 5min (default), escalating any condition open > 45min (default) with a debounced, ' +
    'durably-deduped reminder, and auto-resolving it once the condition clears.',
  consumerRefs: [
    'packages/operator-core/lib/system-health/condition-staleness-alarm.ts',
    'apps/operator/bin/hono-host.ts',
  ],
});
