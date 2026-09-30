/**
 * verify-binding-adapter — the read-admission `verifyBinding` (Stage 4c).
 *
 * Write-free join (`non-collaborator-join-fork-pr-2026-06-02`): a remote peer's
 * binding is proven entirely from material it carries on the SIGNED announce —
 * `device_pubkey`, `github_user_id`, and `attestation_gist_id` — plus the public
 * attestation gist. The admission gate is:
 *
 *   verifyAnnounce(frame)  (done upstream → sigValid)  AND
 *   verifyAttestation(attestation_gist_id, device_pubkey, github_user_id)
 *
 * `verifyAttestation` pins gist `owner.id === github_user_id`, the gist body's
 * `device_pubkey === device_pubkey`, and a valid device signature — so a peer can
 * only bind a (key, identity) pair for a gist it actually owns. There is NO
 * shared-repo contributor-file read and NO repo write at join (the prior
 * `verifyChannel2` over `{repoOwner, repoName, token}` is gone), and gists are
 * public so the adapter needs no repo context — `verifyAttestation` does
 * attach the box's own gh token opportunistically, but ONLY for API quota
 * (WI-1544: the unauthenticated 60 req/hr-per-IP window wedged admission
 * behind shared NATs), never for authority.
 *
 * D-002 (no collaborator gate): any real GitHub identity is admissible; GitHub's
 * PR-merge gate is the real authority over what lands. D-006 (3-state): the
 * adapter returns `'verified' | 'pending' | 'fail'`. `'pending'` is reserved for
 * OUR transient failure (GitHub unreachable / a thrown call) so the boot
 * pending-retry loop re-checks rather than permanently rejecting; every
 * conclusive attestation failure (gist gone, owner/pubkey mismatch, bad sig,
 * malformed body) is `'fail'`. Gist-deletion (`gist_not_found`) is the
 * owner/self revocation signal — `reverifyAdmitted` drops the peer on `'fail'`.
 *
 * `skipCache: true` is used so a deleted gist (revocation) is detected promptly
 * rather than masked by `verifyAttestation`'s 24h success cache.
 */

import { verifyAttestation } from '../../identity/attest';
import type { AttestationVerificationResult } from '../../identity/attestation-types';

/**
 * The signature `makeAdmissionDecider` expects: given the announce's device
 * pubkey, GitHub login + numeric id, and attestation gist id, return
 * `'verified' | 'pending' | 'fail'`. `githubLogin` is accepted for parity with
 * the announce/decider shape but is not needed for the gist check.
 */
export type VerifyBinding = (
  devicePubkeyBase64: string,
  githubLogin: string,
  githubUserId: number,
  attestationGistId: string,
) => Promise<'verified' | 'pending' | 'fail'>;

export interface VerifyBindingAdapterOpts {
  /**
   * Override `verifyAttestation` (tests). Defaults to the real one with
   * `skipCache: true`. Mirrors the `fetchFn` seam style elsewhere.
   */
  verifyAttestationImpl?: (
    gistId: string,
    devicePubkeyBase64: string,
    githubUserId: number,
  ) => Promise<AttestationVerificationResult>;
}

/**
 * Build the read-admission `verifyBinding`. Stateless — gists are public, so
 * there is no harness/repo context to resolve or cache.
 */
export function buildVerifyBindingAdapter(opts: VerifyBindingAdapterOpts = {}): VerifyBinding {
  const verify =
    opts.verifyAttestationImpl ??
    ((gistId, pk, uid) => verifyAttestation(gistId, pk, uid, { skipCache: true }));

  return async (
    devicePubkeyBase64: string,
    _githubLogin: string,
    githubUserId: number,
    attestationGistId: string,
  ): Promise<'verified' | 'pending' | 'fail'> => {
    // No gist id on the announce → nothing to verify against → reject.
    if (!attestationGistId) return 'fail';

    let result: AttestationVerificationResult;
    try {
      result = await verify(attestationGistId, devicePubkeyBase64, githubUserId);
    } catch {
      // OUR transient failure (network) — keep the peer; the retry loop re-checks.
      return 'pending';
    }
    if (result.valid) return 'verified';
    // A→B admission diagnostic (PAPERCUSP_A003_TRACE, off by default): the caller only
    // sees 'fail', so name the attestation reason here (WI-10003109).
    if (process.env.PAPERCUSP_A003_TRACE === '1') {
      console.error(
        `[A-003] ${new Date().toISOString()} verify-binding: gist=${attestationGistId} ` +
          `device=${devicePubkeyBase64.slice(0, 10)} uid=${githubUserId} → ${result.reason}`,
      );
    }
    // Only OUR transient unavailability is retryable; every conclusive
    // attestation failure (gist_not_found / *_mismatch / signature_invalid /
    // gist_body_invalid) rejects.
    if (result.reason === 'github_api_unavailable') return 'pending';
    return 'fail';
  };
}
