/**
 * distributed-claim — orchestrator entry point for the LWW advisory claim.
 *
 * Plan: papercusp-substrate-model-b-rewrite-2026-05-31 (Stage 5).
 * Supersedes Phase-6 P-037's Autobase merge-order wiring.
 *
 * Single call orchestrator code makes to record a distributed claim:
 *
 *   const r = await attemptDistributedClaim({
 *     workspaceId, harnessSlug, feature_id, claimer_github_user_id,
 *   });
 *   if (r.reason === 'substrate-not-booted') {
 *     // fall back to legacy single-writer claim
 *   } else {
 *     // r.claimed === true — schedule the worker (advisory; may be clobbered)
 *   }
 *
 * D-002: the claim is an ADVISORY hint appended to the peer's OWN log
 * (`boot.ts` `ownLog`), not a race. There is no won/lost arbitration —
 * `claimFeature` appends + returns `{ claimed: true }`. It records one row
 * in the APPEND-ONLY `feature_claims` audit history (keyed
 * `<feature_id>/<seq>`); claims do not cross-author-collide, so there is no
 * LWW-clobber and no clobber-toast on the claim path. Who currently holds a
 * feature is a separate derived read (latest `claimed_at`); the GitHub PR
 * merge is the real authority.
 *
 * Composes:
 *   - getBootedHarness() to find the substrate handle
 *   - resolveMyPubkey() to extract our own-log key hex (for the audit row +
 *     sanity check that the log is ready)
 *   - attemptClaimWithAudit() to append the claim + write the audit row
 *
 * If the substrate hasn't booted (flag off, boot failed, etc.) returns a
 * sentinel with reason='substrate-not-booted' so the caller can fall back to
 * the legacy single-writer claim. Validation errors propagate (caller bug).
 *
 * Pure logic — fake handles in tests via boot-all's test hooks.
 */

import { getBootedHarness } from '../sync/hyperbee/boot-all';
import {
  attemptClaimWithAudit,
  type AttemptClaimResult,
} from './attempt-claim';
import type { BootedHarnessHandle } from '../sync/hyperbee/boot';

export interface AttemptDistributedClaimOpts {
  workspaceId: string;
  harnessSlug: string;
  feature_id: string;
  claimer_github_user_id: number;
  /** Override for tests; defaults to Date.now(). */
  now_ms?: number;
}

export type AttemptDistributedClaimResult =
  | (AttemptClaimResult & { reason: 'attempted'; my_pubkey: string })
  | {
      reason: 'substrate-not-booted';
      claimed: false;
      workspaceId: string;
      harnessSlug: string;
      feature_id: string;
    }
  | {
      reason: 'pubkey-unresolved';
      claimed: false;
      workspaceId: string;
      harnessSlug: string;
      feature_id: string;
    };

/**
 * Resolve our own-log key hex from the booted substrate handle.
 *
 * Model B: the local writer's hypercore key is the own log's `keyHex`
 * (64-hex). This is the claimer pubkey the wire claim record keys on.
 * Defensive: returns null if the own log isn't present / has no key.
 */
export function resolveMyPubkey(
  booted: BootedHarnessHandle,
): string | null {
  try {
    const ownKey = booted.ownLog?.keyHex;
    if (typeof ownKey === 'string' && ownKey.length > 0) return ownKey;
    return null;
  } catch {
    return null;
  }
}

export async function attemptDistributedClaim(
  opts: AttemptDistributedClaimOpts,
): Promise<AttemptDistributedClaimResult> {
  const booted = getBootedHarness(opts.workspaceId, opts.harnessSlug);
  if (!booted) {
    return {
      reason: 'substrate-not-booted',
      claimed: false,
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      feature_id: opts.feature_id,
    };
  }
  const myPubkey = resolveMyPubkey(booted);
  if (!myPubkey) {
    return {
      reason: 'pubkey-unresolved',
      claimed: false,
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      feature_id: opts.feature_id,
    };
  }
  // The own log IS the claim handle now — append the advisory claim + audit.
  const result = await attemptClaimWithAudit(booted.ownLog, {
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    feature_id: opts.feature_id,
    claimer_github_user_id: opts.claimer_github_user_id,
    now_ms: opts.now_ms,
  });
  return {
    ...result,
    reason: 'attempted' as const,
    my_pubkey: myPubkey,
  };
}
