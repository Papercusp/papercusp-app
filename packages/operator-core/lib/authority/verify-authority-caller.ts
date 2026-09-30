/**
 * verify-authority-caller — the receiving-side caller-authentication for an
 * authority RPC (EI-322). Built as a small injectable factory so the route wires
 * production deps while unit tests drive it directly.
 *
 * Three gates, in order (cheapest + most fundamental first):
 *
 *   1. SIGNATURE + FRESHNESS — `verifyAuthorityRpc` proves the caller holds the
 *      private key for `auth.device_pubkey` and the op fields are unmodified +
 *      within the freshness window. This is the property the whole fix turns on:
 *      without it, the op's holder identity is self-reported.
 *   2. IDENTITY BINDING — if the op payload names a `holderPubkey` (claim
 *      leases do), it MUST equal the proven `auth.device_pubkey`. This is what
 *      stops impersonation: a caller can only act as the device it can sign for,
 *      so the EI-284 revocation gate (which keys on holderPubkey) becomes sound.
 *   3. REVOCATION — defense-in-depth: the proven device must not be in the
 *      hive's revoked set for the op's scope. FAIL-OPEN on an unreadable store
 *      (D-004): an unknowable standing allows, so a PG blip never wedges
 *      legitimate cross-machine ops. Only an AFFIRMATIVE revocation refuses.
 *      Skipped when the payload carries no `workspaceId` (file-lock ops) — those
 *      rely on gates 1+2; revocation for claims is also re-checked at the
 *      handler (EI-284), now trustworthy because holderPubkey is bound.
 */

import type { AuthorityRpcEnvelope, VerifyCallerResult } from './authority-op-registry';
import { verifyAuthorityRpc } from './authority-rpc-envelope';
import { loadRevokedPubkeys } from '../sync/hyperbee/load-revoked-pubkeys';

export interface BuildAuthorityCallerVerifierOpts {
  /** Affirmative-revocation check for a proven device in a (workspace, harness)
   *  scope. Default: the durable `harness_shared.contributors.revoked_pubkeys`
   *  set, fail-open on error. */
  isRevoked?: (devicePubkey: string, scope: { workspaceId: string; harnessSlug: string }) => Promise<boolean>;
  /** Clock override (tests). */
  nowMs?: number;
  /** Freshness window override (tests). */
  windowMs?: number;
}

const defaultIsRevoked = async (
  devicePubkey: string,
  scope: { workspaceId: string; harnessSlug: string },
): Promise<boolean> => {
  try {
    const revoked = await loadRevokedPubkeys({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug });
    return revoked.has(devicePubkey);
  } catch {
    return false; // fail-open: standing unknowable ≠ revoked
  }
};

/** Pull a string field off an unknown payload, or undefined. */
function payloadString(payload: unknown, key: string): string | undefined {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * Build the `verifyCaller` hook for `handleAuthorityRpc`. The route wires this
 * (flag-gated); when the flag is OFF the route passes no verifyCaller and the
 * legacy (unsigned-accepted) path runs.
 */
export function buildAuthorityCallerVerifier(
  opts: BuildAuthorityCallerVerifierOpts = {},
): (env: AuthorityRpcEnvelope) => Promise<VerifyCallerResult> {
  const isRevoked = opts.isRevoked ?? defaultIsRevoked;

  return async (env: AuthorityRpcEnvelope): Promise<VerifyCallerResult> => {
    // 1. signature + freshness
    if (!env.auth) return { ok: false, reason: 'missing caller auth envelope' };
    if (!verifyAuthorityRpc(env, env.auth, { nowMs: opts.nowMs, windowMs: opts.windowMs })) {
      return { ok: false, reason: 'invalid or stale caller signature' };
    }
    const provenPubkey = env.auth.device_pubkey;

    // 2. identity binding — the proven device must be the op's named holder.
    const holderPubkey = payloadString(env.payload, 'holderPubkey');
    if (holderPubkey !== undefined && holderPubkey !== provenPubkey) {
      return {
        ok: false,
        reason: `holderPubkey ${holderPubkey.slice(0, 12)}… does not match signed device ${provenPubkey.slice(0, 12)}…`,
      };
    }

    // 3. revocation (defense-in-depth; scoped only when the payload carries it).
    //    FAIL-OPEN (D-004): an error consulting the store is treated as "standing
    //    unknowable ≠ revoked" — the verifier owns this guarantee regardless of
    //    the injected isRevoked, so a PG blip never wedges legitimate ops.
    const workspaceId = payloadString(env.payload, 'workspaceId');
    if (workspaceId) {
      let revoked = false;
      try {
        revoked = await isRevoked(provenPubkey, { workspaceId, harnessSlug: env.harnessSlug });
      } catch {
        revoked = false;
      }
      if (revoked) {
        return { ok: false, reason: `device ${provenPubkey.slice(0, 12)}… is revoked for ${env.harnessSlug}` };
      }
    }

    return { ok: true, devicePubkey: provenPubkey };
  };
}
