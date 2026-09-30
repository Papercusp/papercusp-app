/**
 * capacity-errors.ts — the ONE pure classifier for "was this scout failure a
 * CAPACITY ceiling (the LLM pool had nothing to give) rather than a genuine cycle
 * failure?". A small shared classifier so BOTH consumers import the SAME notion:
 *
 *   - scheduler.ts (the WRITE path) — reclassifies a live capacity failure from
 *     status:'error' to a 'no-capacity' gate at record time, so the pool's
 *     busy-ness stops being counted as breakage AND stops false-paging the Mug's
 *     error-streak alarm.
 *   - quality-metrics.ts (the READ path) — re-classifies HISTORICAL error ticks
 *     the same way when computing the error rate, so the "cycle error rate < 5%"
 *     bar reflects genuine failures regardless of WHEN the write-path
 *     reclassification went live. Without this, every capacity-failure tick
 *     written before the scheduler change stays status:'error' in the DB forever
 *     and keeps the bar red for the ~10 days it takes to age out of the window —
 *     a metric judging a fixed condition on stale rows (the measure-across-a-fix-
 *     boundary trap, blender-self-learning-2026-07-12 WI-4475).
 *
 * One classifier, two consumers — the same reuse contract as invariants.ts's
 * digestRefSet delegating to lenses.ts, so the write and read can never drift
 * into disagreeing about what "a capacity failure" is.
 */

import { LEGACY_RATE_LIMIT_BLOCKED_REASON, type AdmissionDenial } from '@papercusp/papercusp-shared/agent';

/**
 * Persisted on every tick produced by the typed classifier. Its presence is the
 * boundary between legacy rows (whose only capacity evidence is provider prose)
 * and current rows (which must carry an authoritative AdmissionDenial).
 */
export const CAPACITY_CLASSIFIER_SCHEMA_VERSION = 1;

/** Extract the typed admission fact from a TurnError/LlmCallError or persisted tick detail.
 * Copies the `via` evidence stamp — dropping it here would strip the attestation the
 * classifier requires every time a denial round-trips through re-extraction (scheduler
 * re-extracts before persisting).
 *
 * THE LEDGER-COMPATIBILITY BOUNDARY (WI-5435). `rate-limit-blocked` was called
 * `all-accounts-paused` until the rename, and the ticks written under the old spelling are
 * immutable history this module still reads (quality-metrics re-classifies HISTORICAL error
 * ticks — see the READ path in the module header). So the legacy spelling is NORMALIZED to
 * the current one here, at the single extraction point, and every downstream comparison tests
 * exactly one literal.
 *
 * Dropping this normalization instead of writing it is the trap this comment exists to stop:
 * an unrecognized reason yields `undefined`, and a versioned row that classifies as
 * not-capacity is counted as a GENUINE error — so a bare rename would silently flip every
 * already-persisted capacity gate to an error and redden the cycle-error bar across the whole
 * release window. That is the measure-across-a-fix-boundary trap this module was built to
 * prevent, re-entered through the back door. Do not "simplify" it away while old rows remain
 * inside the rubric's window. */
export function admissionDenialFrom(input: unknown): AdmissionDenial | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Record<string, unknown>;
  const turn = value.turn && typeof value.turn === 'object' ? (value.turn as Record<string, unknown>) : undefined;
  const candidate = value.admissionDenial ?? turn?.admissionDenial;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const denial = candidate as Record<string, unknown>;
  const reason = denial.reason === LEGACY_RATE_LIMIT_BLOCKED_REASON ? 'rate-limit-blocked' : denial.reason;
  if (reason !== 'rate-limit-blocked' && reason !== 'no-free-slot' && reason !== 'provider-429') return undefined;
  return {
    reason,
    ...(denial.via === 'governor' || denial.via === 'http-429' ? { via: denial.via } : {}),
    ...(typeof denial.governorReason === 'string' ? { governorReason: denial.governorReason } : {}),
    ...(typeof denial.pausedAccounts === 'number' ? { pausedAccounts: denial.pausedAccounts } : {}),
    ...(typeof denial.totalAccounts === 'number' ? { totalAccounts: denial.totalAccounts } : {}),
    ...(typeof denial.freeSlots === 'number' ? { freeSlots: denial.freeSlots } : {}),
    // WI-38062: which concurrency gate refused, + that gate's real occupancy. Extracted here or
    // the discrimination is lost exactly where it is needed — this is the boundary through which
    // every HISTORICAL row is re-classified, so a field dropped here is invisible to the metric
    // no matter how faithfully the write path stamped it. Rows persisted before the stamp simply
    // carry no `gate`, which must stay distinguishable from 'bucket' (never default it).
    ...(denial.gate === 'bucket' || denial.gate === 'fleet' ? { gate: denial.gate } : {}),
    ...(typeof denial.gateInFlight === 'number' ? { gateInFlight: denial.gateInFlight } : {}),
    ...(typeof denial.gateLimit === 'number' ? { gateLimit: denial.gateLimit } : {}),
  };
}

/**
 * One cross-provider fallback attempt (WI-5391 item 3): a capacity-attested Claude-pool
 * denial answered by ONE retry on the Codex bridge. Persisted on the tick detail as a
 * DISCRIMINATOR, not a metric: `succeeded:true` after a Claude denial proves the cycle had
 * somewhere to go when the pool said no — cross-PROVIDER recovery evidence. It is NOT
 * within-Claude-pool failover evidence (that is the contradiction/snapshot path + WI-4475).
 */
export interface CapacityFallbackEvent {
  /** The model the capacity-denied call was routed to. */
  from: string;
  /** The fallback model the one retry used. */
  to: string;
  /** Whether the fallback call returned (false = both providers failed the call). */
  succeeded: boolean;
  /** The original denial's attestation leg, copied for audit (`governor` | `http-429`). */
  via?: string;
  /** The original denial's typed reason. */
  reason?: string;
}

/** Read persisted/attached cross-provider fallback events from an error object or tick
 * detail. Shape-validated per entry — a malformed entry is dropped, never trusted. */
export function capacityFallbacksFrom(input: unknown): CapacityFallbackEvent[] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = (input as Record<string, unknown>).capacityFallbacks;
  if (!Array.isArray(raw)) return undefined;
  const out: CapacityFallbackEvent[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.from !== 'string' || typeof e.to !== 'string' || typeof e.succeeded !== 'boolean') continue;
    out.push({
      from: e.from,
      to: e.to,
      succeeded: e.succeeded,
      ...(typeof e.via === 'string' ? { via: e.via } : {}),
      ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Read the persisted classifier boundary from a scout tick detail. */
export function capacityClassifierVersionFrom(input: unknown): number | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Record<string, unknown>;
  return typeof value.capacityClassifierVersion === 'number' ? value.capacityClassifierVersion : undefined;
}

/**
 * Compatibility-only classifier for rows written before
 * {@link CAPACITY_CLASSIFIER_SCHEMA_VERSION} existed. These are the exact
 * provider-ceiling signatures the old writer persisted. Never call this on a
 * versioned row: current failures must be decided from the typed denial.
 */
export function isLegacyCapacityError(input: unknown): boolean {
  const message =
    typeof input === 'string'
      ? input
      : input && typeof input === 'object' && typeof (input as Record<string, unknown>).error === 'string'
        ? ((input as Record<string, unknown>).error as string)
        : '';
  const m = message.toLowerCase();
  return (
    m.includes('rate-limit pause exceeds maxwait') ||
    m.includes('rate_limit_error') ||
    (m.includes('429') && m.includes('rate limit')) ||
    m.includes('rate limit exceeded')
  );
}

/**
 * PURE: is this failure a CAPACITY ceiling (the pool had nothing to give) rather than a
 * genuine cycle failure? The governor/gateway's typed denial is the only authoritative input.
 *
 * The typed reasons are deliberately small: `rate-limit-blocked` and `provider-429` are
 * capacity signals; `no-free-slot` is an admission-path defect signal and stays loud.
 *
 * NOTE `rate-limit-blocked` is a per-bucket CLASS label, not a pool-wide claim (WI-5435) — it
 * says this bucket was withheld for a rate-limit-ish reason, NOT that the pool was exhausted.
 * The pool-aware evidence is `pausedAccounts`/`totalAccounts` (a different read), and whether
 * the caller then attempted failover to a healthy sibling is not observable from the denial at
 * all — that needs the cycle-top poolSnapshot (WI-5397/WI-4475). Do not read this reason as
 * proof the withhold was correct.
 *
 * Deliberately NARROW: a TIMEOUT is NOT capacity. The REASON changed on 2026-07-13 (WI-4475) —
 * read this before you "fix" the classifier, because the obvious change is the wrong one.
 *
 * The ORIGINAL reason was "the timeout<->capacity link is unproven". That reason was WRONG, and
 * it was wrong in an instructive way: the correlation test behind it compared two error classes
 * the classifier CANNOT CO-EMIT (a tick records a timeout OR a maxWait bail, never both), so it
 * was structurally incapable of finding a link. Its null result was an ARTIFACT, not a finding.
 * WI-4475 then root-caused the timeout class outright: those calls were blocked in
 * governor.acquire() waiting out a shared rate-limit pause, having never sent a byte. The link is
 * PROVEN. Timeouts were capacity-induced all along.
 *
 * And yet they still do NOT belong in the capacity bucket. "We failed to get admitted" is not the
 * same proposition as "the pool was at its ceiling", and the message alone cannot tell them apart:
 *   - pool genuinely walled  => capacity (correctly excluded from the error rate)
 *   - the ADMISSION PATH is broken => a code defect that merely LOOKS like capacity
 * The second is not hypothetical — WI-4541 (same day) found the inference gateway serializing the
 * whole fleet through ONE admission slot with 9-10 of 12 idle. Under a "never admitted => capacity"
 * rule that defect would have been silently excluded from the very metric that should have caught
 * it: the classifier's own inversion, pointed the other way.
 *
 * So the tiebreak is ASYMMETRY OF HARM, not correlation: counting a capacity event as an error
 * OVER-reports breakage (visible, annoying, self-correcting); classifying an admission-path bug as
 * capacity UNDER-reports it (silent, hides defects). Prefer the loud failure. Timeouts stay errors.
 *
 * The governor now carries WHY it withheld a permit (every account paused/walled = capacity;
 * no free slot while accounts sit idle = defect), so this module never infers intent from prose.
 *
 * EVIDENCE-REQUIRED (WI-5391 Part B): the reason alone is not enough — the denial must also
 * carry its `via` attestation stamp ('governor' = the governor's own admission decision;
 * 'http-429' = a real HTTP 429 status from the provider/gateway). Every live mint site stamps
 * it; a denial WITHOUT the stamp is evidence-free (e.g. a future mint site pattern-matching
 * prose) and fails CLOSED — counted as a loud error, per the asymmetry-of-harm tiebreak above.
 */
export function isCapacityError(input: unknown): boolean {
  const denial = admissionDenialFrom(input);
  if (!denial || (denial.via !== 'governor' && denial.via !== 'http-429')) return false;
  return denial.reason === 'rate-limit-blocked' || denial.reason === 'provider-429';
}

/** Read the record-time pool-snapshot contradiction flag from a persisted tick detail.
 * Set by the scheduler when a capacity-shaped denial arrived while the gateway pool
 * REPORTED healthy accounts — the WI-4541 signature (admission-path defect masquerading
 * as capacity). */
export function capacityContradictedFrom(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  return (input as Record<string, unknown>).capacityContradicted === true;
}

/**
 * Ledger-read classifier. Typed evidence always wins; only an UNVERSIONED
 * historical row may fall back to the old provider-prose signatures. This
 * preserves the 48h release window across the schema transition without
 * letting a new untyped admission-path defect disappear into the capacity bucket.
 *
 * A row the WRITE path deliberately counted as an error because the pool snapshot
 * contradicted the denial (`capacityContradicted:true`) is NEVER re-excluded here —
 * otherwise the read path would silently undo the write path's discrimination and
 * the metric could be greened by relabeling alone.
 */
export function isPersistedCapacityError(input: unknown): boolean {
  if (capacityContradictedFrom(input)) return false;
  if (isCapacityError(input)) return true;
  if (capacityClassifierVersionFrom(input) !== undefined) return false;
  return isLegacyCapacityError(input);
}
