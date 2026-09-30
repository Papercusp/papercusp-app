/**
 * Background-task provenance for capability:bash and every other launch seam that ledgers a task
 * (testing:run, release:cut) — who launched it, and for which work-item / plan / goal.
 *
 * Lives OUTSIDE bash.ts on purpose. It needs only identity + goal + held-claim readers, while
 * bash.ts drags in the whole shell runtime: exec-sandbox → auth-config-overrides, and bash-jobs,
 * whose module-scope `warmScopeProbe()` reads a flag at import. When testing/run.ts and
 * release/cut.ts imported this function from './bash', every test whose graph reached either of
 * them inherited that runtime — ~20 files on frozen candidate 5ec99902 died at collection under a
 * partial `@papercusp/flags/server` mock, and set-status.bulk's "getFlag is never consulted"
 * assertion saw the probe's import-time read. Keep this module light.
 */
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { resolveOwnerGoal } from '../coordination/agent-goal-sources';
import { readAgentStateStamp } from '../../agent-state-stamp';
import { readHeldWorkItems } from '../../carry-brief';

export interface BashTaskProvenance {
  launchedBy: string;
  sessionId: string | null;
  harnessSlug: string | null;
  workItemId: string | null;
  planSlug: string | null;
  goalRef: string | null;
}

interface BashTaskProvenanceDeps {
  resolveIdentity: typeof resolveAgentIdentity;
  readStamp: typeof readAgentStateStamp;
  resolveGoal: typeof resolveOwnerGoal;
  /**
   * EI-21548894457555139: the caller's held (assigned, non-terminal) work-items, used
   * ONLY as the fallback below when the goal ref is not itself a work-item id. Reuses
   * the same reader the carry brief and orient's recovery fold use, so the three
   * surfaces cannot disagree about what an agent holds.
   */
  readHeldWorkItems: typeof readHeldWorkItems;
}

const DEFAULT_BASH_PROVENANCE_DEPS: BashTaskProvenanceDeps = {
  resolveIdentity: resolveAgentIdentity,
  readStamp: readAgentStateStamp,
  resolveGoal: resolveOwnerGoal,
  readHeldWorkItems,
};

/**
 * Resolve background-task provenance at the launch seam, while the caller's
 * stable identity and live goal are still available.  The task ledger cannot
 * reconstruct either from a child pid later.  Resolution is fail-soft: an
 * unattributable caller still gets a working shell, but never a fabricated
 * work-item association.
 */
export async function resolveBashTaskProvenance(
  ctx: ResolveIdentityCtx,
  harnessSlug: string | null,
  deps: BashTaskProvenanceDeps = DEFAULT_BASH_PROVENANCE_DEPS,
): Promise<BashTaskProvenance> {
  let ownerId: string | null = null;
  try {
    ownerId = deps.resolveIdentity(ctx).ownerId;
  } catch {
    ownerId = null;
  }

  let goalRef = ownerId ? deps.readStamp(ownerId).goalRef : null;
  if (ownerId && !goalRef) {
    goalRef = (await deps.resolveGoal(ownerId, 'self'))?.ref ?? null;
  }

  let workItemId = goalRef && /^(?:WI|EI|F)-[A-Za-z0-9._-]+$/.test(goalRef) ? goalRef : null;
  // EI-21548894457555139: the goal ref is only SOMETIMES a work-item id. A fleet leader
  // or a plan-bound agent declares `fleet:<slug>` / `<plan>#P-NNN`, so the regex above
  // yields null and the task lands in the ledger unlinked — `processes:list` then cannot
  // answer "which work-item is this process for?" even though the agent is holding one.
  // Measured: an agent holding EI-21548894457555139 linked correctly, while the same
  // agent's fleet-scoped work would not have.
  //
  // Fall back to the caller's held claim, and ONLY when it is UNAMBIGUOUS. An agent
  // holding several items gives no basis for choosing between them, and a fabricated
  // work-item association is worse than an absent one: absent reads as "unknown", while
  // wrong reads as fact and misattributes the cost and the provenance of the run. That
  // is the same principle this function's own doc comment already states.
  if (!workItemId && ownerId) {
    try {
      const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? '';
      const held = await deps.readHeldWorkItems(ownerId, workspaceId, { limit: 2 });
      if (held.length === 1) workItemId = held[0].id;
    } catch {
      // Provenance is fail-soft by contract — an unreadable claim never blocks the shell.
    }
  }
  const planMatch = goalRef?.match(/^(?:plan:)?(.+?)#P-\d+$/) ?? null;
  const principalFallback = ctx.principal?.slug?.trim() || 'capability:bash';
  return {
    launchedBy: ownerId ?? principalFallback,
    sessionId: ownerId,
    harnessSlug,
    workItemId,
    planSlug: planMatch?.[1] ?? null,
    goalRef,
  };
}
