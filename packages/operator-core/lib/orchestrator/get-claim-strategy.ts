/**
 * getClaimStrategy — single decision the orchestrator makes before
 * picking up a feature.
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24 P-037.
 *
 * Returns:
 *   'distributed'    — substrate is booted for this (workspace,
 *                       harness); call attemptDistributedClaim.
 *   'single-writer'  — no substrate handle. Caller falls back to
 *                       the legacy single-writer claim path.
 *
 * Pure logic; thin convenience wrapper over getBootedHarness so the
 * orchestrator doesn't have to import substrate internals.
 */

import { getBootedHarness } from '../sync/hyperbee/boot-all';

export type ClaimStrategy = 'distributed' | 'single-writer';

export interface GetClaimStrategyOpts {
  workspaceId: string;
  harnessSlug: string;
}

export function getClaimStrategy(opts: GetClaimStrategyOpts): ClaimStrategy {
  const booted = getBootedHarness(opts.workspaceId, opts.harnessSlug);
  return booted ? 'distributed' : 'single-writer';
}
