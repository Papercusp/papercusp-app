/**
 * p2p/sandbox/gateway-attribution.ts — P-105 §3.1: per-foreign-session
 * inference-gateway credential attribution (the first of the three X1
 * loopback-boundary legs, DESIGN-p2p-P105-…md §3).
 *
 * WHY: today the inference gateway (`:8788`, pooled Anthropic account
 * credentials) is reachable from ANY shell on the box over loopback — a
 * foreign session bypasses every economic control (allotments, per-fleet
 * spend caps) simply by calling it directly. The fix is NOT a new mechanism:
 * the gateway's storm-circuit rate-governor already tracks calls per
 * account; this module adds a foreign-session identity to that attribution
 * key so an UNATTRIBUTED loopback call (no credential, or an expired one)
 * is refused rather than silently served.
 *
 * This module is PURE decision/issuance logic — no wiring into the live
 * gateway (`packages/operator-core/lib/inference-gateway/gateway.ts`) yet.
 * Per the p2p-parity-parallel-lanes-2026-07-09 P-004 scope note, the spawn
 * leg that would create real foreign sessions calling the gateway (WI-1937)
 * is explicitly OUT of scope here and is owner-sign-off-gated
 * (fact `wi-1937-spawn-leg-owner-signoff`). A future build lane wires
 * `decideGatewayAdmission` into the gateway's admission chokepoint.
 */

export interface ForeignGatewayCredential {
  /** The foreign session this credential attributes calls to (M21 threading). */
  sessionId: string;
  /** The hive/pot this session is scoped to — never crosses hive boundaries. */
  scopePotSlug: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface IssueCredentialInput {
  sessionId: string;
  scopePotSlug: string;
  now: number;
  /** Default 15 minutes — short-lived; a wedged/orphaned session's credential
   *  expires well inside the H13 orphan-supervision window rather than
   *  outliving the session it was issued to. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** Issue a short-lived, session-attributed gateway credential. Pure — no
 *  storage; production wiring persists this alongside the mig-467 foreign
 *  workspace row (or a sibling table) so the gateway can look it up by the
 *  bearer token it's handed over loopback. */
export function issueForeignGatewayCredential(input: IssueCredentialInput): ForeignGatewayCredential {
  const sessionId = input.sessionId?.trim();
  if (!sessionId) throw new Error('issueForeignGatewayCredential: sessionId is required');
  const scopePotSlug = input.scopePotSlug?.trim();
  if (!scopePotSlug) throw new Error('issueForeignGatewayCredential: scopePotSlug is required');
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  if (ttlMs <= 0) throw new Error('issueForeignGatewayCredential: ttlMs must be positive');
  return {
    sessionId,
    scopePotSlug,
    issuedAtMs: input.now,
    expiresAtMs: input.now + ttlMs,
  };
}

export type GatewayAdmissionDecision =
  | { allow: true; sessionId: string }
  | { allow: false; reason: 'unattributed_loopback_call' | 'credential_expired' | 'hive_scope_mismatch' };

/**
 * The admission chokepoint decision (X1 leg 1): a loopback call with no
 * credential, an expired one, or one scoped to a DIFFERENT hive than the
 * call claims, is refused. This is the pure decision the gateway's request
 * handler would call before forwarding to the account pool — never a
 * fail-open default.
 */
export function decideGatewayAdmission(input: {
  credential: ForeignGatewayCredential | null | undefined;
  now: number;
  requestedPotSlug: string;
}): GatewayAdmissionDecision {
  if (!input.credential) return { allow: false, reason: 'unattributed_loopback_call' };
  if (input.now >= input.credential.expiresAtMs) return { allow: false, reason: 'credential_expired' };
  if (input.credential.scopePotSlug !== input.requestedPotSlug) {
    return { allow: false, reason: 'hive_scope_mismatch' };
  }
  return { allow: true, sessionId: input.credential.sessionId };
}
