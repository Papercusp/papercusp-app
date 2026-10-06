/**
 * p2p/pool-broker.ts — POOL / BROKER GATEWAY dual-signature verification
 * (p2p-work-distribution-2026-07-02 P-304, D-010 v2).
 *
 * Item spec (the plan item is the spec, D-016):
 *   Pool/broker gateways: hosts sign GRANTS to a pool {cap + constraints}; the
 *   pool signs ASSIGNMENTS {fleet F draws Y from host H}; the host verifies BOTH
 *   signatures at claim and enforces the constraints locally. The pool is a
 *   control-plane bookkeeper with auditable signed ledgers; INFERENCE BYTES NEVER
 *   ROUTE THROUGH THE POOL. The X7 authority table (billing-matrix.ts) governs
 *   pool ledgers too.
 *
 * The trust chain the HOST re-verifies at claim time, fail-closed at every link:
 *
 *   host GRANT  ── host device signs {pool, cap, constraints, grantEpoch} ──▶ pool
 *   pool ASSIGNMENT ── pool device signs {fleet F draws Y from host H, grantEpoch} ──▶ host
 *   host verifies:  host-grant-sig ∧ pool-assignment-sig ∧ both-devices-attested
 *                   ∧ owners-match ∧ assignment-binds-this-grant ∧ X6-epoch-fresh
 *                   ∧ constraints (fleet allowed, axis granted, unit agrees, amount ≤ cap)
 *                   ∧ X7 pool-ledger authority (pool-with-attribution, single-owner, no relay)
 *
 * This is a PURE module (offer-authorship.ts discipline): no PG, no IO, no clock,
 * no keychain. The things a real host resolves from the world — the device→owner
 * ATTESTATIONS (identity/attest.ts), the pool's accountable OWNER (P-101 directory),
 * and the host's own high-water EPOCH (grant-store.ts p2p_grantor_epochs) — are
 * PASSED IN as already-resolved verdicts, so the chain stays a property-testable
 * set of pure functions. The only crypto edge is a stateless Ed25519 signature
 * VERIFY over JCS-canonical bytes (identity/ed25519.ts).
 *
 * SECURITY POSTURE: the verdict's proven owner ids are the CRYPTOGRAPHICALLY-PROVEN
 * signers (device pubkey → attested user), never a self-claimed field. A host acts
 * on the proven ids; a lying pool/host can put anything in a body field but cannot
 * forge the device signatures, the attestation, or the host's own grant epoch.
 */

import { verifyEd25519 } from '../identity/ed25519';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { BudgetAxis, BudgetEnvelope, BudgetUnit } from './offer-budget';
import { resolveBillingAuthority, type BillingContext } from './billing-matrix';
import type { RefusalContract } from '../capability-envelope/refusal-contract-types';

/* ─────────────────────────────────────────────────────────────────────────
 * The signed objects
 * ───────────────────────────────────────────────────────────────────────── */

/** The body a HOST signs when it grants capacity to a pool. */
export interface PoolGrantBody {
  readonly poolId: string;
  readonly hostRef: string;
  /** The host's accountable OWNER — a numeric GitHub user id (X9). */
  readonly hostOwnerGithubUserId: number;
  /** X6: the host's epoch when this grant was signed (grant-store p2p_grantor_epochs). */
  readonly grantEpoch: number;
  /** The per-axis capacity the host lends to the pool (offer-budget envelope). */
  readonly cap: BudgetEnvelope;
  /**
   * Constraint: the fleets the pool may assign this grant to. FAIL-CLOSED — an
   * EMPTY list permits NO fleet (the pool must be granted explicit fleets), never
   * "all".
   */
  readonly allowedFleets: readonly string[];
  /** Optional clamp: no single assignment may exceed this (in the axis unit). null = no clamp. */
  readonly maxPerAssignment: number | null;
}

export interface SignedPoolGrant {
  readonly body: PoolGrantBody;
  /** The host signing device's RAW 32-byte Ed25519 pubkey, base64. */
  readonly hostDevicePubkey: string;
  /** Ed25519 signature over poolGrantSigningBytes(body), base64. */
  readonly signatureByHost: string;
}

/** The body a POOL signs when it assigns capacity from a host's grant to a fleet. */
export interface PoolAssignmentBody {
  readonly assignmentId: string;
  readonly poolId: string;
  readonly hostRef: string;
  readonly fleetSlug: string;
  readonly axis: BudgetAxis;
  readonly amount: number;
  readonly unit: BudgetUnit;
  /** The epoch of the GRANT this assignment draws on — the pool commits to it (X6). */
  readonly grantEpoch: number;
  /** The pool's own monotonic assignment sequence (advisory — for the pool's ledger). */
  readonly assignmentEpoch: number;
}

export interface SignedPoolAssignment {
  readonly body: PoolAssignmentBody;
  /** The pool signing device's RAW 32-byte Ed25519 pubkey, base64. */
  readonly poolDevicePubkey: string;
  /** Ed25519 signature over poolAssignmentSigningBytes(body), base64. */
  readonly signatureByPool: string;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Canonical signing bytes — one source of truth for signer + verifier
 * ───────────────────────────────────────────────────────────────────────── */

/** The bytes a HOST signs over a grant. JCS-canonical so any body tamper voids the sig. */
export function poolGrantSigningBytes(body: PoolGrantBody): Buffer {
  return Buffer.from(canonicalJson({ kind: 'p2p-pool-grant', body }), 'utf8');
}

/** The bytes a POOL signs over an assignment. JCS-canonical so any body tamper voids the sig. */
export function poolAssignmentSigningBytes(body: PoolAssignmentBody): Buffer {
  return Buffer.from(canonicalJson({ kind: 'p2p-pool-assignment', body }), 'utf8');
}

/** Package a host-produced grant signature into the signed envelope (signing stays out — keychain-bound). */
export function buildSignedPoolGrant(args: { body: PoolGrantBody; hostDevicePubkey: string; signature: Buffer }): SignedPoolGrant {
  return { body: args.body, hostDevicePubkey: args.hostDevicePubkey, signatureByHost: args.signature.toString('base64') };
}

/** Package a pool-produced assignment signature into the signed envelope. */
export function buildSignedPoolAssignment(args: { body: PoolAssignmentBody; poolDevicePubkey: string; signature: Buffer }): SignedPoolAssignment {
  return { body: args.body, poolDevicePubkey: args.poolDevicePubkey, signatureByPool: args.signature.toString('base64') };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Verification input + verdict
 * ───────────────────────────────────────────────────────────────────────── */

export interface PoolAssignmentVerifyInput {
  /** The host's own grant to the pool (the host re-verifies its own signature). */
  readonly grant: SignedPoolGrant;
  /** The pool's assignment drawing on that grant. */
  readonly assignment: SignedPoolAssignment;
  /** The gh user the GRANT's host device is attested to (or null / unattested). */
  readonly hostDeviceAttestedGithubUserId: number | null;
  /** The gh user the ASSIGNMENT's pool device is attested to (or null / unattested). */
  readonly poolDeviceAttestedGithubUserId: number | null;
  /** The pool's accountable OWNER — numeric gh id (single-owner, M17; P-101 directory). */
  readonly poolOwnerGithubUserId: number;
  /** X6: the host's CURRENT high-water epoch for its own grants (grant-store). */
  readonly hostHighWaterEpoch: number;
  /**
   * X7 / D-009: the pool billing context. A pool ledger runs pool-with-attribution
   * (single-owner, receipts + reconciliation) with a quota-ledger leg only (no
   * relay). Absent / multi-owner / relay leg ⇒ pool_billing_unauthorized.
   */
  readonly billing?: BillingContext;
}

export type PoolAssignmentRefusalCode =
  | 'host_grant_sig_invalid'
  | 'host_device_not_attested'
  | 'host_owner_mismatch'
  | 'pool_sig_invalid'
  | 'pool_device_not_attested'
  | 'pool_owner_mismatch'
  | 'assignment_grant_mismatch'
  | 'grant_epoch_stale'
  | 'fleet_not_allowed'
  | 'axis_not_granted'
  | 'unit_mismatch'
  | 'invalid_amount'
  | 'amount_exceeds_cap'
  | 'amount_exceeds_max_per_assignment'
  | 'pool_billing_unauthorized';

export type PoolAssignmentVerdict =
  | {
      readonly ok: true;
      /** The proven pool-owner gh id (assignment pool device → attested user). */
      readonly authorizedPoolOwnerGithubUserId: number;
      /** The proven host-owner gh id (grant host device → attested user). */
      readonly authorizedHostOwnerGithubUserId: number;
      readonly poolId: string;
      readonly hostRef: string;
      readonly fleetSlug: string;
      readonly axis: BudgetAxis;
      readonly amount: number;
      readonly unit: BudgetUnit;
      readonly grantEpoch: number;
    }
  | {
      readonly ok: false;
      readonly code: PoolAssignmentRefusalCode;
      /** The exact link that failed — carried verbatim into a P-004 refusal receipt (D-004). */
      readonly detail: string;
      /**
       * WI-10005197: what would LIFT this refusal. Present on the constraint refusals a
       * lender can actually act on (today: `fleet_not_allowed`); crypto/attestation refusals
       * are not liftable by editing a grant, so they carry none.
       */
      readonly refusal?: RefusalContract;
    };

function decodeSig(b64: string): Buffer | null {
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * THE host-side dual-signature + constraint verifier
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Verify a pool assignment against the host's own grant, fail-closed at every
 * link. The host runs this at CLAIM time before drawing any capacity:
 *
 *   1. the host's grant signature verifies over the canonical grant bytes
 *   2. the grant's host device is attested to a gh user
 *   3. that attested user matches the grant's claimed host owner
 *   4. the pool's assignment signature verifies over the canonical assignment bytes
 *   5. the assignment's pool device is attested to a gh user
 *   6. that attested user matches the pool's accountable owner
 *   7. the assignment BINDS this exact grant (same pool, host, and grant epoch)
 *   8. X6: the grant epoch is not stale vs the host's high-water (a revoked/re-keyed
 *      grant that a stale assignment replays can never re-authorize a draw)
 *   9. the assignment's fleet is in the grant's allowed set (empty ⇒ none — fail-closed)
 *  10. the grant lends the requested axis, and the units agree (H14)
 *  11. the amount is valid and within cap (and any per-assignment clamp)
 *  12. X7/D-009: the pool ledger is authorized (pool-with-attribution single-owner,
 *      quota-ledger leg only — inference bytes never route through the pool)
 *
 * Every refusal is structured + loud so a P-004 receipt can name the exact link.
 */
export function verifyPoolAssignment(input: PoolAssignmentVerifyInput): PoolAssignmentVerdict {
  const { grant, assignment } = input;
  const g = grant.body;
  const a = assignment.body;

  // 1. Host grant signature over the canonical grant bytes.
  const hostSig = decodeSig(grant.signatureByHost);
  if (!hostSig || !verifyEd25519(poolGrantSigningBytes(g), grant.hostDevicePubkey, hostSig)) {
    return {
      ok: false,
      code: 'host_grant_sig_invalid',
      detail: `host grant signature failed to verify for device ${grant.hostDevicePubkey.slice(0, 12)}… over pool '${g.poolId}' grant (tampered grant or wrong key).`,
    };
  }

  // 2. The grant's host device is attested to a gh user.
  if (input.hostDeviceAttestedGithubUserId == null) {
    return { ok: false, code: 'host_device_not_attested', detail: `grant host device ${grant.hostDevicePubkey.slice(0, 12)}… is not attested to any GitHub user.` };
  }
  // 3. The attested host user matches the grant's claimed owner (no lying about whose host).
  if (input.hostDeviceAttestedGithubUserId !== g.hostOwnerGithubUserId) {
    return {
      ok: false,
      code: 'host_owner_mismatch',
      detail: `grant host device is attested to gh user ${input.hostDeviceAttestedGithubUserId} but the grant claims host owner ${g.hostOwnerGithubUserId}.`,
    };
  }

  // 4. Pool assignment signature over the canonical assignment bytes.
  const poolSig = decodeSig(assignment.signatureByPool);
  if (!poolSig || !verifyEd25519(poolAssignmentSigningBytes(a), assignment.poolDevicePubkey, poolSig)) {
    return {
      ok: false,
      code: 'pool_sig_invalid',
      detail: `pool assignment signature failed to verify for device ${assignment.poolDevicePubkey.slice(0, 12)}… over assignment ${a.assignmentId} (tampered assignment or wrong key).`,
    };
  }

  // 5. The assignment's pool device is attested to a gh user.
  if (input.poolDeviceAttestedGithubUserId == null) {
    return { ok: false, code: 'pool_device_not_attested', detail: `assignment pool device ${assignment.poolDevicePubkey.slice(0, 12)}… is not attested to any GitHub user.` };
  }
  // 6. The attested pool user matches the pool's accountable owner.
  if (input.poolDeviceAttestedGithubUserId !== input.poolOwnerGithubUserId) {
    return {
      ok: false,
      code: 'pool_owner_mismatch',
      detail: `assignment pool device is attested to gh user ${input.poolDeviceAttestedGithubUserId} but pool '${a.poolId}' owner is ${input.poolOwnerGithubUserId}.`,
    };
  }

  // 7. The assignment binds THIS grant: same pool, same host, same grant epoch.
  if (a.poolId !== g.poolId || a.hostRef !== g.hostRef || a.grantEpoch !== g.grantEpoch) {
    return {
      ok: false,
      code: 'assignment_grant_mismatch',
      detail: `assignment (pool '${a.poolId}', host '${a.hostRef}', grantEpoch ${a.grantEpoch}) does not bind this grant (pool '${g.poolId}', host '${g.hostRef}', grantEpoch ${g.grantEpoch}).`,
    };
  }

  // 8. X6 epoch fence — the grant epoch must not trail the host's high-water.
  if (g.grantEpoch < input.hostHighWaterEpoch) {
    return {
      ok: false,
      code: 'grant_epoch_stale',
      detail: `grant epoch ${g.grantEpoch} trails host ${g.hostOwnerGithubUserId}'s high-water ${input.hostHighWaterEpoch} (X6) — the host revoked/re-keyed since; refusing a replayed draw.`,
    };
  }

  // 9. Constraint: fleet must be in the allowed set (empty ⇒ none allowed — fail-closed).
  if (!g.allowedFleets.includes(a.fleetSlug)) {
    return {
      ok: false,
      code: 'fleet_not_allowed',
      detail: `fleet '${a.fleetSlug}' is not in the grant's allowed set [${g.allowedFleets.join(', ') || '(none)'}] (empty ⇒ no fleet is permitted).`,
      refusal: {
        observed: { fleetSlug: a.fleetSlug, allowedFleetCount: String(g.allowedFleets.length), poolId: g.poolId },
        liftsWhen:
          'the assignment\'s fleet is in the grant\'s allowedFleets. An empty allowedFleets permits NO fleet, so a ' +
          'grant lending to a fleet must list it. Retrying the same draw cannot lift it: the HOST owner re-issues the ' +
          'grant with that fleet added (a new grantEpoch), or the pool assigns the draw to an already-allowed fleet',
        whoCanMakeItTrue: ['owner', 'another-agent'],
      },
    };
  }

  // 10. Axis granted + unit agreement (H14 — no cross-unit comparison).
  const axisCap = g.cap[a.axis];
  if (axisCap == null) {
    return { ok: false, code: 'axis_not_granted', detail: `grant lends no '${a.axis}' axis capacity to pool '${g.poolId}'.` };
  }
  if (axisCap.unit !== a.unit) {
    return {
      ok: false,
      code: 'unit_mismatch',
      detail: `grant '${a.axis}' axis is denominated in '${axisCap.unit}' but the assignment draws '${a.unit}' (H14: units must agree).`,
    };
  }

  // 11. Amount validity + cap + per-assignment clamp.
  if (!(Number.isFinite(a.amount) && a.amount > 0)) {
    return { ok: false, code: 'invalid_amount', detail: `assignment amount must be finite and > 0 (got ${a.amount}).` };
  }
  if (a.amount > axisCap.cap) {
    return {
      ok: false,
      code: 'amount_exceeds_cap',
      detail: `assignment draws ${a.amount} ${a.unit} but the grant '${a.axis}' cap is ${axisCap.cap} ${axisCap.unit}.`,
    };
  }
  if (g.maxPerAssignment != null && a.amount > g.maxPerAssignment) {
    return {
      ok: false,
      code: 'amount_exceeds_max_per_assignment',
      detail: `assignment draws ${a.amount} > the grant's max-per-assignment clamp ${g.maxPerAssignment}.`,
    };
  }

  // 12. X7 / D-009: the pool ledger authority. A pool runs pool-with-attribution
  // (single-owner, receipts + reconciliation) with a quota-ledger leg only.
  const billing = resolveBillingAuthority('pool-with-attribution', input.billing ?? {});
  if (!billing.ok) {
    return {
      ok: false,
      code: 'pool_billing_unauthorized',
      detail: `pool ledger is not authorized under the X7 table (${billing.code}): ${billing.detail}`,
    };
  }

  return {
    ok: true,
    authorizedPoolOwnerGithubUserId: input.poolDeviceAttestedGithubUserId,
    authorizedHostOwnerGithubUserId: input.hostDeviceAttestedGithubUserId,
    poolId: g.poolId,
    hostRef: g.hostRef,
    fleetSlug: a.fleetSlug,
    axis: a.axis,
    amount: a.amount,
    unit: a.unit,
    grantEpoch: g.grantEpoch,
  };
}
