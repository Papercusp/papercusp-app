/**
 * waitForHyperbeeBootstrap — Phase 5b P-034.
 *
 * Plan: papercusp-dogfood-phase5b-hyperbee-ui-integration-2026-05-24.
 * v5 §3 Entry 4 step 4: after the link-join wizard kicks off the
 * Hyperbee replication for a newly-joined harness, hold the wizard's
 * "routing to Insights" until the substrate has caught up enough to
 * render meaningful state — OR the user runs out of patience.
 *
 * Signal: `getBootstrapProgress(workspaceId, harnessSlug).caughtUp`,
 * the boolean the existing P-066 BootstrapProgressIndicator already
 * tracks (no progress for the substrate's idle window).
 *
 * Outcome: `{ caughtUp, timedOut, observed }`. Timeout is NOT an
 * error; the orchestrator step completes with detail "still syncing"
 * so the UI can surface the "continue anyway" affordance per §3 Entry
 * 4 sub-acceptance P-034b.
 *
 * Pure: clock + getProgress injected so the wait loop is unit-test-
 * able without a real timer or substrate.
 */

import type { BootstrapProgressSnapshot } from '../sync/hyperbee/bootstrap-progress';

export interface WaitForBootstrapOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Default 120000 (2 minutes, per v5 §3 Entry 4). */
  timeoutMs?: number;
  /** Default 1000. */
  pollMs?: number;
  /** Test-injectable. Runtime passes `getBootstrapProgress`. */
  getProgress: (
    workspaceId: string,
    harnessSlug: string,
  ) => BootstrapProgressSnapshot | null;
  /** Test-injectable. Runtime passes `() => new Promise(r => setTimeout(r, ms))`. */
  sleep: (ms: number) => Promise<void>;
  /** Test-injectable. Runtime passes Date.now. */
  now?: () => number;
  /** Optional per-tick observer (UI progress callback). */
  onTick?: (snap: BootstrapProgressSnapshot | null) => void;
}

export interface WaitForBootstrapResult {
  caughtUp: boolean;
  timedOut: boolean;
  /** Highest mergedOps value seen during the wait. 0 if substrate never reported. */
  observed: number;
  /** True when the substrate never reported a snapshot for this harness during the wait. */
  substrateInactive: boolean;
}

export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 120_000;
export const DEFAULT_BOOTSTRAP_POLL_MS = 1_000;

export async function waitForHyperbeeBootstrap(
  opts: WaitForBootstrapOpts,
): Promise<WaitForBootstrapResult> {
  if (!opts.workspaceId) throw new Error('waitForHyperbeeBootstrap: workspaceId required');
  if (!opts.harnessSlug) throw new Error('waitForHyperbeeBootstrap: harnessSlug required');
  if (typeof opts.getProgress !== 'function') throw new Error('getProgress required');
  if (typeof opts.sleep !== 'function') throw new Error('sleep required');

  const timeoutMs = opts.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_BOOTSTRAP_POLL_MS;
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;

  let observed = 0;
  let substrateInactive = true;

  while (true) {
    const snap = opts.getProgress(opts.workspaceId, opts.harnessSlug);
    if (opts.onTick) opts.onTick(snap);
    if (snap) {
      substrateInactive = false;
      if (snap.highestSeen > observed) observed = snap.highestSeen;
      if (snap.caughtUp) {
        return { caughtUp: true, timedOut: false, observed, substrateInactive: false };
      }
    }
    if (now() >= deadline) {
      return {
        caughtUp: false,
        timedOut: true,
        observed,
        substrateInactive,
      };
    }
    await opts.sleep(pollMs);
  }
}
