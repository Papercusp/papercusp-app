/**
 * Goal-holder-authorized local cross-pot placement.
 *
 * The hive clamp deliberately refuses ordinary calls that name a sibling Hive:
 * a scoped superuser must not turn a per-call `harness` argument into a tenant
 * escape. A GOAL holder is the narrow, positive-proof exception for a different
 * case: a goal may be pursued through several local pots, including a
 * `contributing` pot that is not directory-published and therefore has no
 * cross-Hive boundary for `pot:request_work`.
 *
 * This is not a general "goal context" check. Inherited goal context belongs to
 * descendants that execute the goal's work; only the elected holder (or a live
 * handoff predecessor) is authorized to place another fleet. The target must
 * also be an active goal-pot link and an owned, unpublished/private local pot.
 * Published pots and joined remote views stay on their existing federated
 * routes.
 *
 * All reads fail closed. A missing or unreadable authority/link/registry signal
 * must preserve the hive clamp rather than turn absence of evidence into a
 * cross-pot launch grant.
 */
import type { GoalPotLink } from '@papercusp/db-org';
import { getOrgPg, potsForGoal } from '@papercusp/db-org';
import { getOwnedHiveMeta } from '../../../hive-directory-meta';
import { loadHarnessRegistry } from '../../../harness-registry';
import { potHomeSlugForHarness } from '../../../hive-federation';
import {
  readGoalHolderAuthority,
  type GoalHolderAuthority,
  type GoalHolderAuthorityStatus,
} from '../../../goals/holder-authority';

export interface GoalLocalPlacementInput {
  workspaceId: string;
  callerOwnerId: string;
  /** The Hive home containing the caller's scoped session. */
  scopeHive: string;
  /** The requested target harness from the launch tool's per-call args. */
  targetHarness: string;
}

export interface GoalLocalPlacementDeps {
  readAuthority: (workspaceId: string, ownerId: string) => Promise<GoalHolderAuthority>;
  listGoalPots: (workspaceId: string, goalId: string) => Promise<readonly GoalPotLink[]>;
  resolvePotHome: (workspaceId: string, harnessSlug: string) => Promise<string | null>;
  isRemotePot: (workspaceId: string, potHomeSlug: string) => Promise<boolean>;
  ownedPotVisibility: (
    workspaceId: string,
    potHomeSlug: string,
  ) => Promise<string | null | undefined>;
}

const LIVE_HOLDER_STATUSES: ReadonlySet<GoalHolderAuthorityStatus> = new Set([
  'elected',
  'handoff',
]);

const productionDeps: GoalLocalPlacementDeps = {
  readAuthority: async (workspaceId, ownerId) =>
    readGoalHolderAuthority(getOrgPg().sql, workspaceId, ownerId),
  listGoalPots: async (workspaceId, goalId) =>
    potsForGoal(getOrgPg().sql, { workspaceId, goalId }),
  resolvePotHome: potHomeSlugForHarness,
  isRemotePot: async (workspaceId, potHomeSlug) => {
    const registry = await loadHarnessRegistry(workspaceId);
    return registry.projects.find((project) => project.slug === potHomeSlug)?.remote_hive === true;
  },
  ownedPotVisibility: async (workspaceId, potHomeSlug) =>
    (await getOwnedHiveMeta(potHomeSlug, workspaceId))?.visibility,
};

function targetIsCoveredByLink(
  link: Pick<GoalPotLink, 'harnessSlug'>,
  targetHarness: string,
  targetHome: string,
): boolean {
  return link.harnessSlug === targetHarness || link.harnessSlug === targetHome;
}

/**
 * Return true only for the narrow local placement escape described above.
 *
 * This helper intentionally returns a boolean rather than a refusal message:
 * callers already own the domain-specific refusal and must keep the normal
 * `harness_forbidden` response for every failed proof. A positive result merely
 * lets the caller continue with its normal launch path.
 */
export async function goalHolderMayPlaceIntoLocalPot(
  input: GoalLocalPlacementInput,
  deps: GoalLocalPlacementDeps = productionDeps,
): Promise<boolean> {
  const workspaceId = input.workspaceId.trim();
  const callerOwnerId = input.callerOwnerId.trim();
  const scopeHive = input.scopeHive.trim();
  const targetHarness = input.targetHarness.trim();
  if (
    !workspaceId ||
    workspaceId === '*' ||
    !callerOwnerId ||
    !scopeHive ||
    !targetHarness ||
    targetHarness === 'all' ||
    targetHarness === '*' ||
    targetHarness === scopeHive
  ) {
    return false;
  }

  try {
    const authority = await deps.readAuthority(workspaceId, callerOwnerId);
    if (!LIVE_HOLDER_STATUSES.has(authority.status) || !authority.goalId) return false;

    const targetHome = await deps.resolvePotHome(workspaceId, targetHarness);
    if (!targetHome || targetHome === scopeHive) return false;

    const links = await deps.listGoalPots(workspaceId, authority.goalId);
    if (!links.some((link) => targetIsCoveredByLink(link, targetHarness, targetHome))) {
      return false;
    }

    // `remote_hive` is the registry's durable joined-view marker. An owned
    // pot with no directory metadata, or explicit private metadata, has no
    // boot-wired cross-Hive boundary and is exactly the local case this door
    // exists to unblock.
    if (await deps.isRemotePot(workspaceId, targetHome)) return false;
    const visibility = await deps.ownedPotVisibility(workspaceId, targetHome);
    return visibility == null || visibility === 'private';
  } catch {
    return false;
  }
}

/** TEST seam: expose the production dependency shape without exporting mutable state. */
export function goalLocalPlacementProductionDeps(): GoalLocalPlacementDeps {
  return productionDeps;
}
