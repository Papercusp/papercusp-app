/**
 * own-log-fork-recovery — SKETCHED, flag-gated, default-OFF auto-recovery
 * for an own-log fork (own-log-fork-guard.ts).
 *
 * Plan: p2p-parity-parallel-lanes-2026-07-09 P-003 (WI-3535). The plan
 * explicitly allows sketching auto-recovery but requires it flag-gated
 * default-OFF because it's DESTRUCTIVE: the only supported recovery for a
 * forked own-log is a per-harness STORE RESET (delete the harness's
 * Corestore directory so Corestore lazily mints a fresh keypair on next
 * open) — this throws away any local hypercore-only history that hasn't
 * already merged into PG. `rekeyHarness` (boot-all.ts) does NOT do this; it
 * only re-binds the swarm topic.
 *
 * Gated on `FLAGS.OWN_LOG_FORK_AUTO_RECOVERY` — an owner-authority DARK flag
 * (libs/flags/src/types.ts). This module is NEVER wired into any automatic
 * pass (own-log-fork-guard.ts's detector only reports + files an EI); it is
 * meant to be invoked deliberately — a runbook step, an admin action, or an
 * agent that has already read the filed EI and decided recovery is
 * warranted for THIS specific harness — with the flag gate as the owner's
 * kill-switch on unattended destructive action, and `confirm: true` as a
 * second, in-code guard against an accidental call.
 */

import { closeHarnessStore, harnessStorePath } from './corestore';
import { clearOwnLogForkState, type OwnLogForkState } from './own-log-fork-guard';
import { resolveOwnLogForkEi } from './own-log-fork-ei';
import { forkedStoreAsidePath } from './own-log-supersession';

export interface OwnLogForkRecoveryOpts {
  workspaceRoot: string;
  workspaceId: string;
  harnessSlug: string;
  /** The forked own-log key being retired — threaded into the EI-resolve
   *  dedup title and the recovery detail note. */
  keyHex: string;
  /**
   * Explicit double-confirmation, mirroring the confirm-gated destructive
   * actions elsewhere in this repo (locks:dev:restart / db:migrate). Must be
   * `true` or this returns `{ ok: false, reason: 'not_confirmed' }` without
   * touching disk — a caller that didn't mean to run this must never get a
   * false sense that it ran.
   */
  confirm: true;
  /** DI seam for the destructive removal step — default `fs/promises.rm`.
   *  Tests MUST pass this (never exercise the real filesystem). */
  rm?: (path: string) => Promise<void>;
  /** DI seam for the flag check — default `@papercusp/flags` `getFlag`.
   *  Tests pass this to avoid a real flag-store round-trip. */
  isEnabled?: () => Promise<boolean>;
}

export type OwnLogForkRecoveryReason = 'flag_off' | 'not_confirmed';

export interface OwnLogForkRecoveryResult {
  ok: boolean;
  reason?: OwnLogForkRecoveryReason;
  resetPath?: string;
}

async function defaultIsEnabled(): Promise<boolean> {
  const [{ FLAGS }, { getFlag }] = await Promise.all([
    import('@papercusp/flags'),
    import('@papercusp/flags/server'),
  ]);
  return getFlag(FLAGS.OWN_LOG_FORK_AUTO_RECOVERY, 'system').catch(() => false);
}

async function defaultRm(path: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(path, { recursive: true, force: true });
}

/**
 * Perform the supported recovery: close the harness's cached Corestore
 * handle, then DELETE its on-disk directory so the next `getHarnessStore` /
 * `openOwnLog` lazily creates a brand-new keypair, clear the in-process fork
 * latch, and auto-resolve the durable EI the fork filed. The caller is
 * responsible for re-booting the harness afterward — composing that belongs
 * to whatever orchestrates harness lifecycle (e.g. boot-all.ts), not this
 * narrowly-scoped recovery step.
 *
 * No-ops (never touches disk) when `confirm` isn't `true` or the flag reads
 * off — both are reported via `reason`, never a silent success.
 */
export async function recoverForkedOwnLog(
  opts: OwnLogForkRecoveryOpts,
): Promise<OwnLogForkRecoveryResult> {
  if (opts.confirm !== true) return { ok: false, reason: 'not_confirmed' };
  const isEnabled = opts.isEnabled ?? defaultIsEnabled;
  if (!(await isEnabled())) return { ok: false, reason: 'flag_off' };

  const path = harnessStorePath({
    workspaceRoot: opts.workspaceRoot,
    harnessSlug: opts.harnessSlug,
  });
  // Best-effort close — an already-closed / never-opened store must not block
  // the reset (the whole point is recovering from a wedged/crash-looping boot).
  await closeHarnessStore({
    workspaceRoot: opts.workspaceRoot,
    harnessSlug: opts.harnessSlug,
  }).catch(() => {});

  const rm = opts.rm ?? defaultRm;
  await rm(path);

  clearOwnLogForkState(opts.workspaceId, opts.harnessSlug);
  await resolveOwnLogForkEi({
    harnessSlug: opts.harnessSlug,
    keyHex: opts.keyHex,
    detail: `store reset at ${path}`,
  }).catch(() => {
    /* best-effort: the reset itself already succeeded */
  });

  return { ok: true, resetPath: path };
}

// ─────────────────────────────────────────────────────────────────────────────
// EI-21150671414510762: the INVOKABLE recovery path.
//
// `recoverForkedOwnLog` above had no caller at all — no tool, route or admin
// action — so the "supported recovery" could only be performed by hand-deleting
// a store directory. `runOwnLogForkRecovery` is the orchestration that
// `dev:own_log_fork_recover` calls. Over the bare primitive it adds:
//
//   - a DRY RUN by default (the plan plus every blocker, nothing touched);
//   - proof the fork is REAL and is the one the caller named (`keyHex` is
//     REQUIRED to execute — never reset a store the caller did not identify);
//   - a refusal outside the substrate-owner process. On a request-only host
//     (:3070 under the dedicated bg-host topology) the booted handle and the
//     Corestore's single-instance lock live in ANOTHER process, so deleting the
//     directory from here would pull the store out from under its owner;
//   - the booted handle CLOSED BEFORE the store is touched (the primitive only
//     closes the Corestore, leaving the handle pointing at a dead store);
//   - the store MOVED ASIDE, never deleted, so the forked core stays inspectable
//     (named with the full key: the next boot announces it as superseded, so
//     peers drop the dead log instead of holding it with no replicator);
//   - a fresh boot afterwards (Corestore mints a new own-log key on first open),
//     attempted even when the retire step fails, so a failed recovery never
//     leaves the harness closed.
//
// Pure: every side effect is an injected dependency.
// ─────────────────────────────────────────────────────────────────────────────

export type OwnLogForkRecoveryBlocker =
  | 'not_forked'
  | 'key_required'
  | 'key_mismatch'
  | 'not_substrate_owner'
  | 'flag_off';

const BLOCKER_DETAIL: Record<OwnLogForkRecoveryBlocker, string> = {
  not_forked:
    'This process has no own-log fork recorded for the harness. A store reset is only warranted for a live fork, so nothing was touched.',
  key_required:
    'Pass keyHex (the forked own-log key, plan.forkedKeyHex) to execute. Naming the key is what proves you are retiring the store you inspected.',
  key_mismatch:
    'keyHex does not match the fork this process recorded. Re-read the fork state before retrying.',
  not_substrate_owner:
    'This process does not own the substrate: the booted handle and the store lock live in another process. Run this against the substrate-owner host (the bg-host on a split topology, or the single desktop/VM operator).',
  flag_off:
    'papercusp-own-log-fork-auto-recovery is off. It is an owner-authority kill-switch on this destructive reset; enable it on the owning host for the recovery window.',
};

export interface OwnLogForkRecoveryPlan {
  workspaceId: string;
  harnessSlug: string;
  forkedKeyHex: string | null;
  detectedAtMs: number | null;
  storePath: string;
  /** Where the forked store is moved to. It is never deleted by this path. */
  retireTo: string;
  flagEnabled: boolean;
  substrateOwner: boolean;
}

export interface RunOwnLogForkRecoveryArgs {
  workspaceId: string;
  harnessSlug: string;
  keyHex?: string;
  confirm?: boolean;
}

export interface RunOwnLogForkRecoveryDeps {
  getForkState: (workspaceId: string, harnessSlug: string) => OwnLogForkState;
  isSubstrateOwner: () => boolean;
  workspaceRoot: (workspaceId: string) => string;
  closeBootedHarness: (workspaceId: string, harnessSlug: string) => Promise<boolean>;
  retireStore: (from: string, to: string) => Promise<void>;
  reboot: (workspaceId: string, harnessSlug: string, opts: { workspaceRoot: string }) => Promise<unknown>;
  isEnabled?: () => Promise<boolean>;
  recover?: typeof recoverForkedOwnLog;
  now?: () => number;
}

export type RunOwnLogForkRecoveryResult =
  | { outcome: 'dry_run'; plan: OwnLogForkRecoveryPlan; blockers: OwnLogForkRecoveryBlocker[]; blockerDetail: string[] }
  | { outcome: 'refused'; plan: OwnLogForkRecoveryPlan; reason: OwnLogForkRecoveryBlocker; detail: string }
  | {
      outcome: 'recovered';
      plan: OwnLogForkRecoveryPlan;
      closedHandle: boolean;
      reboot: unknown;
      forkStateAfter: OwnLogForkState;
    }
  | {
      outcome: 'failed';
      plan: OwnLogForkRecoveryPlan;
      closedHandle: boolean;
      stage: 'retire';
      error: string;
      /** The re-boot attempted after the failure (the old store is still in place). */
      reboot: unknown;
    };

export async function runOwnLogForkRecovery(
  args: RunOwnLogForkRecoveryArgs,
  deps: RunOwnLogForkRecoveryDeps,
): Promise<RunOwnLogForkRecoveryResult> {
  const { workspaceId, harnessSlug } = args;
  const state = deps.getForkState(workspaceId, harnessSlug);
  const workspaceRoot = deps.workspaceRoot(workspaceId);
  const storePath = harnessStorePath({ workspaceRoot, harnessSlug });
  const stamp = new Date((deps.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
  const plan: OwnLogForkRecoveryPlan = {
    workspaceId,
    harnessSlug,
    forkedKeyHex: state.keyHex,
    detectedAtMs: state.detectedAtMs,
    storePath,
    // WI-10002600: the FULL key, because the next boot reads it back from this
    // name and announces it as superseded (own-log-supersession.ts).
    retireTo: forkedStoreAsidePath(storePath, state.keyHex ?? 'unknown', stamp),
    flagEnabled: await (deps.isEnabled ?? defaultIsEnabled)(),
    substrateOwner: deps.isSubstrateOwner(),
  };

  const blockers: OwnLogForkRecoveryBlocker[] = [];
  if (!state.forked || !state.keyHex) blockers.push('not_forked');
  else if (!args.keyHex) blockers.push('key_required');
  else if (args.keyHex.toLowerCase() !== state.keyHex.toLowerCase()) blockers.push('key_mismatch');
  if (!plan.substrateOwner) blockers.push('not_substrate_owner');
  if (!plan.flagEnabled) blockers.push('flag_off');

  if (args.confirm !== true) {
    return { outcome: 'dry_run', plan, blockers, blockerDetail: blockers.map((b) => BLOCKER_DETAIL[b]) };
  }
  if (blockers.length > 0) {
    const reason = blockers[0]!;
    return { outcome: 'refused', plan, reason, detail: BLOCKER_DETAIL[reason] };
  }

  const closedHandle = await deps.closeBootedHarness(workspaceId, harnessSlug);
  const recover = deps.recover ?? recoverForkedOwnLog;
  let retireError: string | null = null;
  try {
    const res = await recover({
      workspaceRoot,
      workspaceId,
      harnessSlug,
      keyHex: state.keyHex!,
      confirm: true,
      rm: (path) => deps.retireStore(path, plan.retireTo),
      // Already evaluated above; re-reading could flip mid-call.
      isEnabled: async () => plan.flagEnabled,
    });
    if (!res.ok) retireError = `recoverForkedOwnLog refused: ${res.reason ?? 'unknown'}`;
  } catch (err) {
    retireError = err instanceof Error ? err.message : String(err);
  }

  // Boot again whatever happened: after a successful retire this mints a fresh
  // own-log key; after a failed one it restores the harness to its prior
  // (forked but open) state instead of leaving it closed.
  const reboot = await deps
    .reboot(workspaceId, harnessSlug, { workspaceRoot })
    .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));

  if (retireError !== null) {
    return { outcome: 'failed', plan, closedHandle, stage: 'retire', error: retireError, reboot };
  }
  return {
    outcome: 'recovered',
    plan,
    closedHandle,
    reboot,
    forkStateAfter: deps.getForkState(workspaceId, harnessSlug),
  };
}
