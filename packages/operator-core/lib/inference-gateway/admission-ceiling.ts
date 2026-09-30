/**
 * WHY IS LIVE ADMISSION BELOW THE AIMD EFFECTIVE? — the derived cross-check that stops
 * `maxConcurrent: 4` sitting beside `aimd.effective: 24` from reading as an unexplained
 * contradiction.
 *
 * THE FAILURE THIS EXISTS TO PREVENT (measured 2026-08-18, and again the day before): an agent read
 * `gateway:status` and saw admission pinned at 4 while `aimd.effective` said 24, `pressure` 0,
 * `decreases` 0. Nothing in the payload connected the two, so the agent invented a story — the
 * WI-4541 "idle slots / tier work-conservation" signature — and carried it for a day. The real
 * cause was one field away and simply not forwarded: the serviceable-account clamp had computed a
 * recommendation of 4 from ONE serviceable account, and `/admin/config` did not include `clamp`.
 *
 * The general principle: a surface that reports a bounded number must also report WHAT BOUND IT.
 * Only the gateway can see both the AIMD effective and the serviceable recommendation, so the
 * gateway is the only place that can state which one is binding. An agent cross-checking by hand
 * forgets; the surface cannot.
 *
 * ⚠ ABSENCE IS REPORTED AS UNKNOWN, NEVER AS "NOT CLAMPED". A build that does not report clamp
 * state yields `boundBy: 'unknown'` with a `why` that says so. Defaulting a missing reading to the
 * reassuring answer is the same class of bug this module exists to close.
 */

/** What the clamp reported, as it appears on `GatewayStats.clamp`. Structurally typed (rather than
 *  imported from `./gateway`) to keep this module free of a cycle — gateway.ts imports THIS. */
export interface AdmissionClampSnapshot {
  mode: string;
  /** What the serviceable-count clamp WOULD cap live admission to; null = unbounded / not yet computed. */
  recommendation: number | null;
  applied: number;
  overridden: boolean;
  /** Serviceable accounts behind `recommendation`. null when the pool could not report a count. */
  serviceableAccounts?: number | null;
}

/** Which term is actually holding live admission down. */
export type AdmissionCeilingBinding = 'serviceable-clamp' | 'aimd' | 'configured-cap' | 'unknown';

export interface AdmissionCeilingReport {
  /** Live admission — what the queue actually enforces (`admission.maxConcurrent`). */
  applied: number;
  aimdEffective: number;
  configuredCap: number;
  serviceableRecommendation: number | null;
  serviceableAccounts: number | null;
  clampMode: string;
  boundBy: AdmissionCeilingBinding;
  /** Slots the AIMD would allow that admission is not using. 0 when nothing is withheld. */
  slotsWithheld: number;
  /** Plain-language statement of which term is binding and why. */
  why: string;
  /** The concrete lever that moves it, or null when waiting is the correct action. */
  lever: string | null;
}

export interface AdmissionCeilingInput {
  /** Live enforced concurrency (`admission.maxConcurrent`). */
  applied: number;
  /** `aimd.effective` — what the adaptive controller currently allows. */
  aimdEffective: number;
  /** `aimd.cap` / `concurrencyCap` — the configured ceiling. */
  configuredCap: number;
  /** `stats().clamp`; omit/undefined when the gateway did not report it. */
  clamp?: AdmissionClampSnapshot | null;
}

const READMIT_LEVER =
  'POST /admin/readmit converges the in-memory pool with the account store (a store-side accounts:reset-rate does NOT clear this process’s exhaustedUntil map); POST /admin/clamp-mode?mode=off admits at the AIMD effective while still computing and reporting the recommendation.';

/**
 * Name the term that is holding live admission down, and the lever that moves it.
 *
 * Pure and total: every input shape yields a report, and an unreadable clamp yields
 * `boundBy: 'unknown'` rather than a confident-looking default.
 */
export function describeAdmissionCeiling(input: AdmissionCeilingInput): AdmissionCeilingReport {
  const applied = Math.max(0, Math.floor(input.applied));
  const aimdEffective = Math.max(0, Math.floor(input.aimdEffective));
  const configuredCap = Math.max(0, Math.floor(input.configuredCap));
  const clamp = input.clamp ?? undefined;
  const recommendation =
    clamp && typeof clamp.recommendation === 'number' && Number.isFinite(clamp.recommendation)
      ? Math.floor(clamp.recommendation)
      : null;
  const serviceableAccounts =
    clamp && typeof clamp.serviceableAccounts === 'number' && Number.isFinite(clamp.serviceableAccounts)
      ? Math.floor(clamp.serviceableAccounts)
      : null;
  const clampMode = clamp?.mode ?? 'unknown';
  const slotsWithheld = Math.max(0, aimdEffective - applied);

  if (!clamp) {
    return {
      applied,
      aimdEffective,
      configuredCap,
      serviceableRecommendation: null,
      serviceableAccounts: null,
      clampMode: 'unknown',
      boundBy: 'unknown',
      slotsWithheld,
      why:
        `this gateway did not report clamp state, so WHY live admission sits at ${applied} is UNKNOWN` +
        `${slotsWithheld > 0 ? ` (${slotsWithheld} slot(s) below the AIMD effective of ${aimdEffective})` : ''}. ` +
        'Do NOT read this as "not clamped".',
      lever: 'GET /stats reports the serviceable-count clamp on builds that compute it.',
    };
  }

  // The clamp binds only when it is HONORED (`auto`) and its recommendation is genuinely tighter
  // than what the AIMD would allow. Under `off` the recommendation is still computed and reported,
  // but admission runs at the AIMD effective — so it is not the binding term.
  const clampBinds = clampMode !== 'off' && recommendation !== null && recommendation < aimdEffective;

  if (clampBinds) {
    const countPhrase =
      serviceableAccounts === null
        ? 'the serviceable-account count'
        : `${serviceableAccounts} serviceable account(s)`;
    return {
      applied,
      aimdEffective,
      configuredCap,
      serviceableRecommendation: recommendation,
      serviceableAccounts,
      clampMode,
      boundBy: 'serviceable-clamp',
      slotsWithheld,
      why:
        `live admission is ${applied} of a possible ${aimdEffective} — the SERVICEABLE-ACCOUNT CLAMP is binding, ` +
        `not AIMD. It recommends ${recommendation} from ${countPhrase}. That count reads this process's ` +
        "IN-MEMORY rotation state, which can be stale with respect to the account store and to upstream.",
      lever: READMIT_LEVER,
    };
  }

  if (aimdEffective < configuredCap) {
    return {
      applied,
      aimdEffective,
      configuredCap,
      serviceableRecommendation: recommendation,
      serviceableAccounts,
      clampMode,
      boundBy: 'aimd',
      slotsWithheld,
      why:
        `live admission is ${applied}; AIMD has shed ${configuredCap - aimdEffective} slot(s) off the ` +
        `configured cap of ${configuredCap} under sustained upstream throttling. It recovers additively ` +
        'as calls succeed.',
      lever: null,
    };
  }

  return {
    applied,
    aimdEffective,
    configuredCap,
    serviceableRecommendation: recommendation,
    serviceableAccounts,
    clampMode,
    boundBy: 'configured-cap',
    slotsWithheld,
    why:
      `live admission is ${applied}, which is the configured cap — nothing is withholding slots. ` +
      'Queueing at this point is real demand exceeding real capacity.',
    lever: null,
  };
}
