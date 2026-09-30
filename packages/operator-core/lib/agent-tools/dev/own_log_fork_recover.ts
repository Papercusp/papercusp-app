/**
 * dev:own_log_fork_recover — the invokable recovery for a harness whose OWN
 * hyperbee log forked (Hypercore equivocation: "[hypercore] conflict detected",
 * filed as an `own_log_forked` EI by own-log-fork-guard.ts).
 *
 * EI-21150671414510762: the supported recovery (a per-harness store reset,
 * `recoverForkedOwnLog`) existed but had NO caller — no tool, route or admin
 * action — so recovering a forked harness meant hand-deleting a Corestore
 * directory. This tool is that caller. All decisions live in
 * `runOwnLogForkRecovery` (own-log-fork-recovery.ts); this file only wires the
 * real process, filesystem and substrate seams into it.
 *
 * Safety model, in order:
 *   1. dry run unless `confirm: true` — returns the plan and every blocker;
 *   2. `keyHex` must name the fork this process actually recorded;
 *   3. only the substrate-owner process may execute (a request-only host would
 *      pull the store out from under the process that holds its lock);
 *   4. the owner-authority kill-switch flag `papercusp-own-log-fork-auto-recovery`
 *      must be on;
 *   5. the store is MOVED ASIDE (`<store>.forked-<full key>-<ts>`), never deleted.
 *      The next boot reads the key back from that name and announces it as
 *      superseded, so peers drop the dead log (WI-10002600).
 */
import { rename } from 'node:fs/promises';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { isSubstrateOwnerProcess } from '../../background-workers';
import {
  closeBootedHarness,
  rebootHarness,
  workspaceRootForId,
} from '../../sync/hyperbee/boot-all';
import { getOwnLogForkState } from '../../sync/hyperbee/own-log-fork-guard';
import {
  runOwnLogForkRecovery,
  type RunOwnLogForkRecoveryDeps,
} from '../../sync/hyperbee/own-log-fork-recovery';

/** The production wiring; exported so the tool test can assert what is bound. */
export function productionRecoveryDeps(): RunOwnLogForkRecoveryDeps {
  return {
    getForkState: getOwnLogForkState,
    isSubstrateOwner: () => isSubstrateOwnerProcess(),
    workspaceRoot: workspaceRootForId,
    closeBootedHarness,
    retireStore: (from, to) => rename(from, to),
    reboot: (workspaceId, harnessSlug, opts) => rebootHarness(workspaceId, harnessSlug, opts),
  };
}

export default defineTool({
  name: 'dev:own_log_fork_recover',
  profile: 'engineer',
  description:
    'Recover a harness whose OWN hyperbee log forked (an own_log_forked EI): close the booted harness, move its Corestore aside, and boot fresh so a new own-log key is minted. Dry run by default. To execute it needs confirm:true, the forked keyHex, the substrate-owner process, and the papercusp-own-log-fork-auto-recovery flag.',
  capability: 'intel:write',
  timeoutSec: 180,
  requirePrincipal: false,
  // Closing and re-booting a harness can outlast Postgres's idle-in-transaction
  // timeout, and the handler never reads ctx.tx (same reasoning as dev:restart).
  skipWorkspaceTx: true,
  agentRoles: ['operator', 'debugger'],
  guidance: {
    when: 'dev:dogfood_substrate_status shows ownLogFork.forked=true for a harness (its local writes are frozen). Run it dry first and read plan + blockers.',
    notWhen:
      'A stalled REMOTE log (no_replicator) or a swarm topic change: that is the self-heal loop or rekeyHarness, not a store reset. Never on a healthy own log.',
    chaining:
      'dev:dogfood_substrate_status (ownLogFork, ownLogOps) → this dry → confirm:true + keyHex on the substrate-owner host → dev:dogfood_substrate_status again.',
  },
  args: z.object({
    harnessSlug: z.string().min(1),
    workspaceId: z.string().min(1).optional(),
    keyHex: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'keyHex is the 64-char hex own-log key (plan.forkedKeyHex)')
      .optional(),
    confirm: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const workspaceId =
      args.workspaceId ??
      (ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId());
    const data = await runOwnLogForkRecovery(
      { workspaceId, harnessSlug: args.harnessSlug, keyHex: args.keyHex, confirm: args.confirm },
      productionRecoveryDeps(),
    );
    return { data };
  },
});
