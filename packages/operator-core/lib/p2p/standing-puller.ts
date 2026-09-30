/**
 * p2p/standing-puller.ts — the STANDING PULLER (the receiver-side pull loop's
 * DECISION CORE) (p2p-work-distribution-2026-07-02 P-103).
 *
 * Item spec (the plan item is the spec, D-016):
 *   Standing puller: opt-in = a supervisor-owned standing claim-spec (P-016
 *   machinery) filtered to opted-in fleets; respects P-002 windows + caps.
 * Baked amendments:
 *   C1→C4 — the PUBLISHER stamps the assignment (a designation) on the offer at
 *           publish time over an EPOCH-VERSIONED opt-in roster; receivers VERIFY
 *           the stamp; a soft designation is STEALABLE after T2 so a slow-but-
 *           alive designee cannot stall the work.
 *   X12   — steals are reliability-WEIGHTED and publisher-EXCLUDABLE (this is
 *           what defeats the claim → stall → expire → re-steal STARVATION loop:
 *           a low-reliability or publisher-excluded host can never win a steal).
 *   H6    — foreign claims carry a TTL + auto-release; a lease breach emits a
 *           loud receipt and feeds the HOST reliability signal (a PREEMPTION-
 *           class breach is EXCUSED per X8 — see inference-lease.classifyLeaseBreach).
 *   H9    — execution EPOCHS on offers: an (epoch, seq) watermark. A resurrected
 *           executor REVALIDATES its claim; results carry the epoch so a stale
 *           executor is rejected. (revalidateExecutionEpoch below.)
 *   H17   — the puller is DETERMINISTIC CODE, NEVER an LLM. It runs with HOST
 *           AUTHORITY, parsing UNTRUSTED payloads PRE-SANDBOX, so the intake gate
 *           (parseOfferPayload) is size-capped + strictly schema-validated and
 *           NEVER throws on hostile input; any downstream LLM triage must treat
 *           the offer text strictly as DATA, never as instructions.
 *   X11   — ACTIVATION was gated on the P-003 claim-path soak (both halves:
 *           the software soak — standing-puller.claim-path-soak.test.ts, 3000+
 *           2000 randomized fast-check runs, zero throws — AND a LIVE 2-device
 *           witness). BOTH landed 2026-07-10 (WI-1936): software soak green
 *           per WI-1936's own checkpoint; live witness via WI-3546 (state=passed,
 *           terminal 23:13:49Z — tower↔VM coord/data-merge witnessed BOTH
 *           directions live, verified by su-0e1a65bd + su-4c5f0 via direct psql
 *           on both machines). `PULLER_ACTIVATION_LANDED` is the ONE structural
 *           switch P-003 flips (mirrors rollout-tiers.TIER2_PREREQS_LANDED); it
 *           is now `true` and the puller is ACTIVE. `pullerActivationInvariant()`
 *           is the (now largely historical) dormancy-contract guard.
 *
 * PURE module (offer-authorship.ts / claim-authority.ts / rollout-tiers.ts
 * discipline): no PG, no IO, no clock, no keychain. Every world edge the receiver
 * resolves — the device→user attestation, the owner-signed publisher set + its
 * high-water epoch (P-102), the two-layer host availability (P-202), the current
 * P-002 settings, and the (already signature-verified) publisher DESIGNATION
 * stamp — is PASSED IN as an already-resolved value, so the whole pull decision
 * stays a property-testable set of pure functions. The receiver's IO layer
 * (the actual standing-claim runner, a P-016 supervisor-owned claim-spec) calls
 * these to decide, then performs the claim/steal/skip side effect.
 *
 * SECURITY POSTURE (H17): parseOfferPayload is the trust boundary. It takes the
 * RAW serialized bytes a peer sent and (1) rejects an oversized payload BEFORE
 * JSON.parse (a hostile 100MB string never reaches the parser), (2) strictly
 * validates every field of the offer / authorship / designation, failing CLOSED
 * on anything malformed. It returns a typed refusal — it never throws — so a
 * malformed or hostile payload can never crash the host-authority pull loop.
 */

import {
  BUDGET_AXES,
  isOfferExpired,
  type AxisCap,
  type BudgetUnit,
  type WorkOffer,
} from './offer-budget';
import {
  verifyOfferAuthorship,
  type AuthorshipRefusalCode,
  type AuthorshipVerifyInput,
  type OfferAuthorship,
} from './offer-authorship';
import {
  evaluateClaimAuthority,
  type ClaimAxisGrant,
  type ClaimAxisRefusal,
  type HostAvailability,
} from './claim-authority';
import { resolveForeignWorkAdmission, type P2pSettings } from './settings';
import type { P2pEffectiveTier } from './rollout-tiers';

/* ─────────────────────────────────────────────────────────────────────────
 * X11 — the ONE activation switch. Flipped to `true` 2026-07-10 (WI-1936)
 * once BOTH gates were confirmed green:
 *   (a) software claim-path soak — standing-puller.claim-path-soak.test.ts,
 *       42/42 green, 3000+2000 randomized fast-check runs, zero throws;
 *   (b) LIVE 2-device witness — WI-3546 (state=passed, terminal 23:13:49Z):
 *       tower↔VM coord/data-merge witnessed BOTH directions live, one owner
 *       identity, both device pubkeys admitted, independently verified via
 *       direct psql on both machines (su-0e1a65bd + su-4c5f0956).
 * The puller is now ACTIVE: evaluatePull emits real claims/steals for a live
 * run (no `puller_inactive` short-circuit on the defaulted path).
 * ───────────────────────────────────────────────────────────────────────── */
export const PULLER_ACTIVATION_LANDED = true;

/* ─────────────────────────────────────────────────────────────────────────
 * The publisher DESIGNATION stamp (C1→C4) — resolved & signature-verified by
 * the receiver's IO edge (the publisher signs it over the epoch-versioned opt-in
 * roster; the receiver verifies that signature before calling in here, exactly
 * as offer-authorship's attestation is resolved outside the pure core).
 * ───────────────────────────────────────────────────────────────────────── */
export interface OfferDesignation {
  /** The host ref the publisher assigned this offer to (the soft designee). */
  readonly designatedHostRef: string;
  /** The epoch of the opt-in roster the designation was stamped against (C1→C4). */
  readonly rosterEpoch: number;
  /** ms epoch the designation was stamped — the T2 staleness clock (C1→C4). */
  readonly designatedAtMs: number;
  /** H9 execution watermark: the (epoch, seq) seq for this offer stream. */
  readonly seq: number;
}

/* ─────────────────────────────────────────────────────────────────────────
 * H17 — deterministic untrusted-payload INTAKE (the trust boundary)
 * ───────────────────────────────────────────────────────────────────────── */

export interface OfferPayloadLimits {
  /** Max raw serialized bytes. A payload above this is rejected BEFORE JSON.parse. */
  readonly maxBytes: number;
}

/** A sane default cap — an offer envelope is small; anything larger is hostile. */
export const DEFAULT_OFFER_PAYLOAD_LIMITS: OfferPayloadLimits = { maxBytes: 64 * 1024 };

export type OfferParseRefusalCode =
  | 'payload_too_large'
  | 'not_json'
  | 'not_object'
  | 'malformed_offer'
  | 'malformed_authorship'
  | 'malformed_designation';

/** The validated, trust-boundary-crossed payload. */
export interface ParsedOfferPayload {
  readonly offer: WorkOffer;
  readonly authorship: OfferAuthorship;
  /** null = the offer carries NO designation (an open pull — any opted-in host may claim). */
  readonly designation: OfferDesignation | null;
}

export type OfferParseResult =
  | { readonly ok: true; readonly payload: ParsedOfferPayload }
  | { readonly ok: false; readonly code: OfferParseRefusalCode; readonly detail: string };

const BUDGET_UNITS: ReadonlySet<string> = new Set<BudgetUnit>(['usd-micros', 'tokens', 'slot-seconds', 'slots']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Strict AxisCap validator — fail-closed. Returns the cap or null (invalid). */
function validateAxisCap(v: unknown): AxisCap | null {
  if (v === null) return null;
  if (!isPlainObject(v)) return null;
  if (!isFiniteNumber(v.cap) || v.cap < 0) return null;
  if (typeof v.unit !== 'string' || !BUDGET_UNITS.has(v.unit)) return null;
  const mpc = v.maxPerCall;
  if (mpc !== null && (!isFiniteNumber(mpc) || mpc <= 0)) return null;
  return { cap: v.cap, unit: v.unit as BudgetUnit, maxPerCall: mpc === null ? null : (mpc as number) };
}

/** Distinguish "field absent/null" (a valid null axis) from "field present but malformed". */
function validateAxisSlot(v: unknown): { ok: true; cap: AxisCap | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, cap: null };
  const cap = validateAxisCap(v);
  return cap === null ? { ok: false } : { ok: true, cap };
}

function validateOffer(v: unknown): WorkOffer | null {
  if (!isPlainObject(v)) return null;
  if (!isNonEmptyString(v.offerId)) return null;
  if (!isNonEmptyString(v.fleetSlug)) return null;
  if (typeof v.publisherRef !== 'string') return null;
  if (typeof v.billedTo !== 'string') return null;
  if (typeof v.modelClass !== 'string') return null;
  if (!isFiniteNumber(v.priority)) return null;
  if (!Array.isArray(v.isolationReqs) || !v.isolationReqs.every((r) => typeof r === 'string')) return null;
  if (v.minRuntimeVersion !== undefined && typeof v.minRuntimeVersion !== 'string') return null;
  const lat = v.latencyToleranceMs;
  if (lat !== undefined && lat !== null && (!isFiniteNumber(lat) || lat < 0)) return null;
  if (!isPlainObject(v.budget)) return null;
  const remote = validateAxisSlot(v.budget.remote);
  const local = validateAxisSlot(v.budget.local);
  if (!remote.ok || !local.ok) return null;
  if (!isFiniteNumber(v.publishedAt) || v.publishedAt < 0) return null;
  if (!isFiniteNumber(v.ttlMs) || v.ttlMs < 0) return null;
  return {
    offerId: v.offerId,
    fleetSlug: v.fleetSlug,
    publisherRef: v.publisherRef,
    billedTo: v.billedTo,
    modelClass: v.modelClass,
    priority: v.priority,
    isolationReqs: [...(v.isolationReqs as string[])],
    ...(v.minRuntimeVersion !== undefined ? { minRuntimeVersion: v.minRuntimeVersion as string } : {}),
    ...(lat !== undefined ? { latencyToleranceMs: lat as number | null } : {}),
    budget: { remote: remote.cap, local: local.cap },
    publishedAt: v.publishedAt,
    ttlMs: v.ttlMs,
  };
}

function validateAuthorship(v: unknown): OfferAuthorship | null {
  if (!isPlainObject(v)) return null;
  if (!isNonEmptyString(v.devicePubkey)) return null;
  if (!isNonEmptyString(v.signatureByDevice)) return null;
  if (!isFiniteNumber(v.epoch) || v.epoch < 0) return null;
  return { devicePubkey: v.devicePubkey, signatureByDevice: v.signatureByDevice, epoch: v.epoch };
}

function validateDesignation(v: unknown): { ok: true; designation: OfferDesignation | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, designation: null };
  if (!isPlainObject(v)) return { ok: false };
  if (!isNonEmptyString(v.designatedHostRef)) return { ok: false };
  if (!isFiniteNumber(v.rosterEpoch) || v.rosterEpoch < 0) return { ok: false };
  if (!isFiniteNumber(v.designatedAtMs) || v.designatedAtMs < 0) return { ok: false };
  if (!isFiniteNumber(v.seq) || v.seq < 0) return { ok: false };
  return {
    ok: true,
    designation: {
      designatedHostRef: v.designatedHostRef,
      rosterEpoch: v.rosterEpoch,
      designatedAtMs: v.designatedAtMs,
      seq: v.seq,
    },
  };
}

/**
 * H17 intake gate. Take the RAW serialized payload a peer sent and turn it into
 * a validated { offer, authorship, designation } — or a typed refusal. NEVER
 * throws (a malformed/hostile payload can never crash the host-authority loop).
 *
 * Order matters for the security posture:
 *   1. SIZE-CAP first, on the raw string, BEFORE JSON.parse — a hostile giant
 *      payload is rejected without ever being parsed.
 *   2. JSON.parse inside a try/catch → 'not_json' on failure.
 *   3. strict per-field schema validation, fail-closed → a 'malformed_*' code.
 */
export function parseOfferPayload(rawText: string, limits: OfferPayloadLimits = DEFAULT_OFFER_PAYLOAD_LIMITS): OfferParseResult {
  // 1. size-cap BEFORE parse (H17 — never hand a hostile giant string to JSON.parse).
  if (typeof rawText !== 'string' || rawText.length > limits.maxBytes) {
    return {
      ok: false,
      code: 'payload_too_large',
      detail: `offer payload ${typeof rawText === 'string' ? rawText.length : '(non-string)'} bytes exceeds cap ${limits.maxBytes} (H17 size-cap, rejected pre-parse).`,
    };
  }
  // 2. parse — never throw.
  let root: unknown;
  try {
    root = JSON.parse(rawText);
  } catch {
    return { ok: false, code: 'not_json', detail: 'offer payload is not valid JSON.' };
  }
  if (!isPlainObject(root)) {
    return { ok: false, code: 'not_object', detail: 'offer payload is not a JSON object.' };
  }
  // 3. strict schema validation, fail-closed.
  const offer = validateOffer(root.offer);
  if (!offer) return { ok: false, code: 'malformed_offer', detail: 'offer payload `.offer` is missing or malformed.' };
  const authorship = validateAuthorship(root.authorship);
  if (!authorship) return { ok: false, code: 'malformed_authorship', detail: 'offer payload `.authorship` is missing or malformed.' };
  const designation = validateDesignation(root.designation);
  if (!designation.ok) return { ok: false, code: 'malformed_designation', detail: 'offer payload `.designation` is present but malformed.' };

  return { ok: true, payload: { offer, authorship, designation: designation.designation } };
}

/* ─────────────────────────────────────────────────────────────────────────
 * H9 — execution-epoch revalidation (a resurrected executor revalidates)
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * H9: an offer stream carries an (epoch, seq) watermark. A resurrected / paused
 * executor must revalidate its claim before acting, and any result it emits must
 * carry the epoch it acted under so a stale executor is rejected downstream. This
 * is the pure watermark check: the executor's (epoch, seq) must NOT trail the
 * host's current high-water for that stream.
 */
export function revalidateExecutionEpoch(args: {
  executorEpoch: number;
  executorSeq: number;
  hostHighWaterEpoch: number;
  hostHighWaterSeq: number;
}): { ok: true } | { ok: false; detail: string } {
  const { executorEpoch, executorSeq, hostHighWaterEpoch, hostHighWaterSeq } = args;
  if (executorEpoch < hostHighWaterEpoch || (executorEpoch === hostHighWaterEpoch && executorSeq < hostHighWaterSeq)) {
    return {
      ok: false,
      detail: `executor watermark (${executorEpoch},${executorSeq}) trails host high-water (${hostHighWaterEpoch},${hostHighWaterSeq}) — stale executor rejected (H9).`,
    };
  }
  return { ok: true };
}

/* ─────────────────────────────────────────────────────────────────────────
 * X12 — steal eligibility (reliability-weighted + publisher-excludable)
 * ───────────────────────────────────────────────────────────────────────── */

export interface StealContext {
  /** A soft designation becomes stealable once older than this (C1→C4 T2). */
  readonly t2StaleMs: number;
  /** This host's reliability score in [0, 1] (X12 reliability-weighting). */
  readonly selfReliability: number;
  /** The publisher's floor: a host below this may not steal (X12). */
  readonly minReliabilityToSteal: number;
  /** X12: hosts the publisher has EXCLUDED from stealing this offer. */
  readonly publisherExcludedHosts: readonly string[];
  /**
   * X12 reliability-weighting: a strictly-preferred alive candidate exists, so
   * THIS host must yield rather than race. Defeats the resteal starvation loop:
   * only the best eligible candidate wins, never a thundering herd.
   */
  readonly betterCandidateExists: boolean;
}

export type StealRefusalCode =
  | 'not_yet_stealable' // designation not older than T2 — the designee is still within its grace
  | 'publisher_excluded' // X12: this host is on the publisher's exclude list
  | 'reliability_too_low' // X12: below the publisher's reliability floor
  | 'better_candidate'; // X12: a strictly-preferred candidate should win instead

export type StealDecision =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly code: StealRefusalCode; readonly detail: string };

/**
 * X12 + C1→C4: may THIS host steal a soft-designated offer from its (stale)
 * designee? Eligible IFF ALL of: the designation is older than T2 (the designee
 * has had its grace), the host is not publisher-excluded, the host meets the
 * reliability floor, AND no strictly-better candidate is present. Every refusal
 * is a distinct, loud code so the resteal-starvation guard is auditable.
 */
export function evaluateSteal(designatedAtMs: number, nowMs: number, ctx: StealContext, selfHostRef: string): StealDecision {
  if (nowMs - designatedAtMs <= ctx.t2StaleMs) {
    return {
      eligible: false,
      code: 'not_yet_stealable',
      detail: `designation age ${nowMs - designatedAtMs}ms <= T2 ${ctx.t2StaleMs}ms — the designee is still within its grace (C1→C4).`,
    };
  }
  if (ctx.publisherExcludedHosts.includes(selfHostRef)) {
    return { eligible: false, code: 'publisher_excluded', detail: `host '${selfHostRef}' is on the publisher's steal-exclude list (X12).` };
  }
  if (ctx.selfReliability < ctx.minReliabilityToSteal) {
    return {
      eligible: false,
      code: 'reliability_too_low',
      detail: `host reliability ${ctx.selfReliability} < publisher floor ${ctx.minReliabilityToSteal} (X12 reliability-weighted).`,
    };
  }
  if (ctx.betterCandidateExists) {
    return {
      eligible: false,
      code: 'better_candidate',
      detail: `a strictly-preferred steal candidate exists — yielding to defeat the resteal starvation loop (X12).`,
    };
  }
  return { eligible: true };
}

/* ─────────────────────────────────────────────────────────────────────────
 * THE pull-decision pipeline — claim / steal / skip
 * ───────────────────────────────────────────────────────────────────────── */

export type PullSkipReason =
  | 'puller_inactive' // X11: P-003 soak not landed
  | 'kill-switch'
  | 'opt-in-off'
  | 'outside-window'
  | 'fleet_not_opted_in'
  | 'offer_expired'
  | 'execution_epoch_stale' // H9
  | `authorship:${AuthorshipRefusalCode}` // P-102 fail-closed
  | 'no_claim_authority' // P-202
  | 'not_designated' // C1→C4: not the designee, and not steal-eligible
  | `steal:${StealRefusalCode}`;

export interface PullClaim {
  readonly outcome: 'claim' | 'steal';
  /** true when this is a STEAL from a stale designee (X12), false for a direct claim. */
  readonly stole: boolean;
  /** The cryptographically-proven authorizing user (P-102). */
  readonly authorizedGithubUserId: number;
  readonly ownerGithubUserId: number;
  /** The authorship epoch this claim is bound to (X6). */
  readonly epoch: number;
  /** Per-axis effective caps (min offer×allotment×headroom) — seed a P-107 ledger. */
  readonly grants: readonly ClaimAxisGrant[];
}

export interface PullSkip {
  readonly outcome: 'skip';
  readonly reason: PullSkipReason;
  readonly detail: string;
  /** Populated on a 'no_claim_authority' skip — the per-axis P-202 refusals. */
  readonly claimRefusals?: readonly ClaimAxisRefusal[];
}

export type PullDecision = PullClaim | PullSkip;

export interface PullEvaluationInput {
  /** X11: is the puller activated (P-003 soak landed)? Defaults to PULLER_ACTIVATION_LANDED. */
  readonly active?: boolean;
  /** This host's ref (matched against the designation's designee). */
  readonly selfHostRef: string;
  /** The effective P-002 settings (kill-switch, opt-in mode/fleets/windows/caps). */
  readonly settings: P2pSettings;
  /** Host-local wall clock (ms). */
  readonly nowMs: number;
  /** P-005 resolved max rollout tier (the caller resolves it from the flag state). */
  readonly maxRolloutTier: P2pEffectiveTier;
  /** The fully-resolved P-102 authorship-verify input (embeds the offer). */
  readonly authorship: AuthorshipVerifyInput;
  /** P-202 two-layer host availability per axis. */
  readonly hostAvailability: HostAvailability;
  /** The (signature-verified) publisher designation stamp, or null (open offer). */
  readonly designation: OfferDesignation | null;
  /** H9 host high-water watermark for this offer's execution stream. */
  readonly hostHighWaterEpoch: number;
  readonly hostHighWaterSeq: number;
  /** X12 steal inputs — only consulted when the host is NOT the designee. */
  readonly steal: StealContext;
}

function skip(reason: PullSkipReason, detail: string, claimRefusals?: readonly ClaimAxisRefusal[]): PullSkip {
  return claimRefusals ? { outcome: 'skip', reason, detail, claimRefusals } : { outcome: 'skip', reason, detail };
}

/**
 * The standing puller's DECISION for one offer — pure and deterministic (H17).
 * Fail-closed gate order (cheapest / most-decisive first, security gates before
 * capacity):
 *   0. X11 activation (dormant until P-003)
 *   1. P-002/P-005 admission (kill-switch → opt-in → window, + rollout tier)
 *   2. opt-in FLEET filter (the standing claim-spec's opted-in set)
 *   3. offer TTL expiry (H16)
 *   4. P-102 authorship chain (device → user → publisher set → owner, + X6 epoch, C5 host)
 *   5. P-202 host-gateway claim authority (min(allotment, headroom) > 0 per axis)
 *   6. H9 execution-epoch watermark (reject a stale stream)
 *   7. C1→C4 designation: I am the designee → CLAIM; else X12 steal → STEAL / skip
 *
 * Returns a CLAIM (or STEAL) carrying the proven authority + per-axis effective
 * caps (seed a P-107 ledger), or a loud, structured SKIP naming the first gate
 * that refused (so a P-004 receipt can quote it — no silent drops, D-004).
 */
export function evaluatePull(input: PullEvaluationInput): PullDecision {
  const active = input.active ?? PULLER_ACTIVATION_LANDED;
  const offer = input.authorship.offer;

  // 0. X11 — dormant until the P-003 claim-path soak lands.
  if (!active) {
    return skip('puller_inactive', 'standing puller is dormant — activation gated on the P-003 claim-path soak (X11).');
  }

  // 1. P-002/P-005 admission — kill-switch beats opt-in beats window.
  const admission = resolveForeignWorkAdmission(input.settings, input.nowMs, { maxRolloutTier: input.maxRolloutTier });
  if (!admission.admitNewClaims) {
    const reason = (admission.refusalReason ?? 'opt-in-off') as PullSkipReason;
    return skip(reason, `admission refused new claims: ${admission.refusalReason} (P-002/P-005).`);
  }

  // 2. opt-in FLEET filter — the standing claim-spec only pulls opted-in fleets.
  if (admission.optedInFleets !== null && !admission.optedInFleets.includes(offer.fleetSlug)) {
    return skip('fleet_not_opted_in', `offer fleet '${offer.fleetSlug}' is not in the opted-in set [${admission.optedInFleets.join(', ')}].`);
  }

  // 3. offer TTL expiry (H16) — an expired unclaimed offer is dead.
  if (isOfferExpired(offer, input.nowMs)) {
    return skip('offer_expired', `offer ${offer.offerId} expired (published ${offer.publishedAt} + ttl ${offer.ttlMs} < now ${input.nowMs}) (H16).`);
  }

  // 4. P-102 authorship chain — fail-closed at every link.
  const authorship = verifyOfferAuthorship(input.authorship);
  if (!authorship.ok) {
    return skip(`authorship:${authorship.code}`, `authorship chain refused: ${authorship.detail}`);
  }

  // 5. P-202 host-gateway claim authority — min(allotment, headroom) > 0 per axis.
  const claim = evaluateClaimAuthority(offer, input.hostAvailability);
  if (!claim.claimable) {
    return skip('no_claim_authority', `host claim authority refused (P-202): ${claim.refusals.map((r) => r.detail).join('; ')}`, claim.refusals);
  }

  // 6. H9 execution-epoch watermark — reject a stale stream (a resurrected/old
  //    designation whose seq trails our high-water for this stream).
  if (input.designation) {
    const reval = revalidateExecutionEpoch({
      executorEpoch: authorship.epoch,
      executorSeq: input.designation.seq,
      hostHighWaterEpoch: input.hostHighWaterEpoch,
      hostHighWaterSeq: input.hostHighWaterSeq,
    });
    if (!reval.ok) return skip('execution_epoch_stale', reval.detail);
  }

  const won = (stole: boolean): PullClaim => ({
    outcome: stole ? 'steal' : 'claim',
    stole,
    authorizedGithubUserId: authorship.authorizedGithubUserId,
    ownerGithubUserId: authorship.ownerGithubUserId,
    epoch: authorship.epoch,
    grants: claim.grants,
  });

  // 7. C1→C4 designation. No designation ⇒ an OPEN offer any opted-in host may
  //    claim. Designated to ME ⇒ CLAIM. Designated to another ⇒ X12 steal path.
  if (input.designation === null) return won(false);
  if (input.designation.designatedHostRef === input.selfHostRef) return won(false);

  const steal = evaluateSteal(input.designation.designatedAtMs, input.nowMs, input.steal, input.selfHostRef);
  if (steal.eligible) return won(true);
  return skip(`steal:${steal.code}`, `not the designee ('${input.designation.designatedHostRef}') and not steal-eligible: ${steal.detail}`);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Recurrence guard for the X11 dormancy contract (called by the test; cheap
 * enough to assert at boot). Returns the list of VIOLATED invariants (empty =
 * healthy). Mirrors rollout-tiers.rolloutTiersInvariant.
 *
 * X11 LANDED 2026-07-10 (WI-1936, PULLER_ACTIVATION_LANDED now `true`): the
 * real call site (the default-arg `pullerActivationInvariant()`) always
 * resolves `activationLanded` to the current (now-true) module constant, so
 * its `!activationLanded` branch below no longer fires there — the dormancy
 * contract it encodes only ever applied to the pre-landing world. The branch
 * is kept (not deleted) purely so a caller who explicitly passes `false` (a
 * hypothetical "what if it were still dormant" check) still gets a correctly
 * worded violation rather than a silently-vacuous pass.
 * ───────────────────────────────────────────────────────────────────────── */
export function pullerActivationInvariant(activationLanded = PULLER_ACTIVATION_LANDED): string[] {
  const violations: string[] = [];
  // The dormancy contract: while activation has NOT landed, an evaluatePull with
  // active defaulted (i.e. reading PULLER_ACTIVATION_LANDED) MUST NOT emit a
  // claim/steal — it must skip 'puller_inactive'. We can only assert the shape
  // when the module constant is still false (the pre-P-003 world).
  if (!activationLanded && (PULLER_ACTIVATION_LANDED as boolean) !== false) {
    violations.push('PULLER_ACTIVATION_LANDED must be false until the P-003 claim-path soak lands (X11).');
  }
  return violations;
}
