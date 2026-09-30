/**
 * get-claim-handle — Model B Stage-5 lookup helper.
 *
 * Plan: papercusp-substrate-model-b-rewrite-2026-05-31 (Stage 5).
 *
 * The single call orchestrator code makes when it wants the claim handle for
 * a harness:
 *
 *   const ownLog = getClaimHandleForHarness({ workspaceId, harnessSlug });
 *   if (!ownLog) return; // substrate not booted → legacy single-writer claim
 *   await attemptClaimWithAudit(ownLog, ...);
 *
 * D-002: the claim is an LWW advisory hint appended to the peer's OWN log, so
 * the own log IS the claim handle — there is no Autobase `base`, no adapter.
 * Returns the booted handle's `ownLog`, or null when the substrate hasn't
 * booted for this harness (the orchestrator then falls back to the legacy
 * single-writer claim).
 *
 * Pure logic — no PG, no FS. Tests inject fake substrate handles via the
 * boot-all test hooks.
 */

import { getBootedHarness } from '../sync/hyperbee/boot-all';
import type { ClaimOwnLog } from './feature-claim';

export interface GetClaimHandleOpts {
  workspaceId: string;
  harnessSlug: string;
}

/**
 * Resolve the own-log claim handle for the (workspace, harness) pair.
 * Returns null when the substrate hasn't booted for this harness.
 */
export function getClaimHandleForHarness(
  opts: GetClaimHandleOpts,
): ClaimOwnLog | null {
  const booted = getBootedHarness(opts.workspaceId, opts.harnessSlug);
  if (!booted) return null;
  const ownLog = booted.ownLog;
  // Defensive: a handle with no usable own log can't carry a claim.
  if (!ownLog || typeof ownLog.append !== 'function' || !ownLog.keyHex) {
    return null;
  }
  return ownLog;
}
