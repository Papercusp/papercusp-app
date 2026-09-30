/**
 * two-channel-verifier — runtime implementation of P-075 (Phase 1b).
 *
 * Channel 1 — OAuth: `GET /user` must return an `id` matching the claimed
 *             `github_user_id`. Proves the caller holds a token issued for
 *             that user. This is the LOCAL self-attestation channel only — it
 *             is never part of remote admission.
 *
 * Channel 2 (the shared-repo contributor-file path: `verifyChannel2` +
 * `verifyBoth`) was REMOVED in the write-free-join work
 * (`non-collaborator-join-fork-pr-2026-06-02`). Remote admission now proves the
 * `device_pubkey ↔ github_user_id` binding from the device-signed announce
 * (carrying the attestation gist id) + `verifyAttestation` on that gist, with
 * NO shared-repo fetch and no upstream write at join — see
 * `lib/sync/hyperbee/verify-binding-adapter.ts`.
 *
 * Types are in `binding-verifier-types.ts`.
 */

import { ChannelResult } from './binding-verifier-types';

// ─── Channel 1 ────────────────────────────────────────────────────────────────

export interface VerifyChannel1Options {
  /** GitHub OAuth token scoped at least `read:user`. */
  token: string;
  /** The github user id the caller claims to have. */
  claimedGithubUserId: number;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
}

/**
 * Channel 1: verify a GitHub OAuth token identifies the claimed user.
 * Calls `GET /user` on GitHub's API and compares `id` to `claimedGithubUserId`.
 */
export async function verifyChannel1(
  opts: VerifyChannel1Options,
): Promise<ChannelResult> {
  const { token, claimedGithubUserId, fetchFn = fetch } = opts;
  try {
    const resp = await fetchFn('https://api.github.com/user', {
      headers: {
        Authorization: 'token ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (resp.status === 401) {
      return { kind: 'fail', reason: 'oauth_token_revoked' };
    }
    if (!resp.ok) {
      return { kind: 'fail', reason: 'github_api_down' };
    }
    const data = (await resp.json()) as { id?: unknown };
    if (typeof data.id !== 'number') {
      return { kind: 'fail', reason: 'github_api_down' };
    }
    if (data.id !== claimedGithubUserId) {
      return { kind: 'fail', reason: 'oauth_user_id_mismatch' };
    }
    return { kind: 'ok' };
  } catch {
    return { kind: 'fail', reason: 'github_api_down' };
  }
}
