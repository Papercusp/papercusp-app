/**
 * Drain-fleet auto-mint (goal-mode-design-intent-hardening-2026-08-16 P-001).
 *
 * The GOAL contract requires ONE STANDING DRAIN FLEET PER GOAL — the cheap
 * correct route that makes never-implement livable (the goal agent files
 * work_items and the fleet drains them, instead of the agent editing code
 * itself). Before P-001 that requirement was prose plus a watchdog: the agent
 * had to remember to stand the fleet up, and in the measured run that motivated
 * the pair (WI-39348, su-b9e0ec11, 2026-08-16) it never did. This module makes
 * the requirement STRUCTURAL: `goals:start` mints the fleet registry row, its
 * goal-scoped claim-spec lane, and the `metadata.drainFleet` declaration in the
 * same call that opens the goal — zero agent action. The landed
 * goal-drain-fleet-watchdog demotes to backstop.
 *
 * D-005 (owner ruling, binding): the lane is STRICTLY goal-scoped — the claim
 * spec is hard-coded to `{field:'goal', op:'=', value:<goalId>}` and is NEVER
 * pot-wide. The POSITIVE form is load-bearing, not stylistic: `goal` is a
 * NULLABLE and sparsely-stamped column (claim-spec.ts `ITEM_FIELDS`, WI-37711 /
 * migration 785), so a positive fence can intentionally match zero while a
 * newly-created goal has no stamped rows yet. The NULL-safe `not`/`!=` polarity
 * admits unstamped rows and is not an ownership fence; use it only as a measured
 * exclusion fence that names every active goal. `scheduler:set_claim_spec` also
 * refuses a replacement that drops an authored positive fence unless the caller
 * explicitly confirms that exclusion transition (EI-22389918023611568). (This
 * overrules the pot-scoped fallback in Scout proposal EI-20611030815080063; the
 * proposal is otherwise adopted.)
 *
 * Deliberately ROWS-ONLY: fleet row + spec row + metadata stamp. The one
 * headless member the lane needs is spawned by `goals:start` itself AFTER its
 * goal-agent spawn succeeds — every write here is compensable
 * (`teardownDrainFleetMint`), a spawned process is not.
 */

import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';

import { createFleetIfAbsent, deleteFleet, setFleetLeader } from '../agent-fleets-store';
import { setPresenceFleet } from '../agent-tools/coordination/presence';
import { declareCoupling } from '../coord/couplings';
import { potHomeSlugForHarness } from '../hive-federation';
import { DEFAULT_CLAIM_SPEC } from '../scheduler/claim-spec';
import { clearClaimSpec, fleetSpecBeeKey, setClaimSpec } from '../scheduler/claim-spec-store';

/**
 * `goal-drain-<goalId>`, bounded to the 60-char fleet-slug budget. When the goal
 * id alone overflows it, the READABLE stem is trimmed and the id's trailing
 * collision-resistant hex (`-3f9a1c`) is preserved — a plain right-truncation
 * would cut exactly the part that keeps two long-titled goals' fleets distinct.
 */
/**
 * The slug prefix every auto-minted goal drain fleet carries.
 *
 * Exported so the READ side (`isDrainFleetSlug`, used by the delegation-count
 * provider's active-drain-fleet count) shares one constant with the WRITE side
 * below, instead of re-spelling the literal. Two copies of an identity prefix is
 * how a rename silently drops a whole population from a count while both sides
 * keep looking correct.
 */
export const DRAIN_FLEET_SLUG_PREFIX = 'goal-drain-';

/**
 * Does this fleet slug name an auto-minted goal drain fleet?
 *
 * Prefix-only by construction: `drainFleetSlugForGoal` truncates long goal ids,
 * so the slug's TAIL is lossy and cannot be matched back to a goal — the prefix
 * is the only stable part, and this predicate deliberately claims no more than
 * that.
 */
export function isDrainFleetSlug(fleetSlug: string | null | undefined): boolean {
  return typeof fleetSlug === 'string' && fleetSlug.startsWith(DRAIN_FLEET_SLUG_PREFIX);
}

export function drainFleetSlugForGoal(goalId: string): string {
  const prefix = DRAIN_FLEET_SLUG_PREFIX;
  const budget = 60 - prefix.length;
  if (goalId.length <= budget) return `${prefix}${goalId}`;
  const tail = goalId.slice(-7);
  const head = goalId.slice(0, budget - tail.length).replace(/-+$/, '');
  return `${prefix}${head}${tail}`;
}

/**
 * The goal lane. Pure + exported so a test can pin the shape — above all the
 * D-005 invariant that the filter is the positive `=` leaf on `goal`.
 * Rank/limits inherit the default ordering unchanged (same choice as
 * `buildFleetPlanClaimSpec`): the lane narrows WHAT is served, not how it is
 * ranked. No `states` pin — goal-filed items vary in kind, and the unified
 * `['open']` floor default already serves the drain case.
 */
export function buildGoalDrainClaimSpec(goalId: string): Record<string, unknown> {
  return {
    specVersion: '1.0',
    specId: `goal-drain-${goalId}`,
    revision: 1,
    view: { filter: { field: 'goal', op: '=', value: goalId } },
    rank: DEFAULT_CLAIM_SPEC.rank,
    limits: DEFAULT_CLAIM_SPEC.limits,
  };
}

export interface DrainFleetMintArgs {
  workspaceId: string;
  /** The concrete install_slug stored on the goal. */
  harnessSlug: string;
  goalId: string;
  goalTitle: string;
  /** The goal agent's pre-pinned identity — the portfolio owner of this fleet.
   *  Its delegated leader is installed only after a separate process opens. */
  agentOwnerId: string;
  /** The SQL tag the goal row was just written with — the `metadata.drainFleet`
   *  stamp rides the same handle so the declaration lands beside the row it
   *  declares for (and dies with it under `deleteGoalRow` on rollback). */
  goalTx: GoalSqlTag;
}

export interface DrainFleetMintResult {
  fleetSlug: string;
  created: boolean;
  specRevision: number | null;
}

/**
 * Mint the fleet row, its goal-scoped claim-spec lane, and the goal's
 * `metadata.drainFleet` declaration. Throws on any failure AFTER compensating
 * what it already wrote — a fleet whose lane could not be scoped is torn back
 * down rather than left pulling the pot-wide DEFAULT_CLAIM_SPEC, which is the
 * exact shape D-005 forbids.
 */
export async function mintDrainFleetForGoal(args: DrainFleetMintArgs): Promise<DrainFleetMintResult> {
  const fleetSlug = drainFleetSlugForGoal(args.goalId);
  // Claim-spec rows use the Hive home slug as their harness binding. Resolve it
  // from the goal's actual install instead of writing an operator-local null;
  // an unbound fleet spec makes its members' scoped ptool calls fail closed.
  const potSlug = await potHomeSlugForHarness(args.workspaceId, args.harnessSlug);
  const { created } = await createFleetIfAbsent({
    workspaceId: args.workspaceId,
    fleetSlug,
    title: `goal drain · ${args.goalTitle.slice(0, 48)}`,
    description: `Standing drain fleet for goal ${args.goalId} — auto-minted by goals:start (P-001); lane is goal-scoped per D-005.`,
    owner: args.agentOwnerId,
    // A GOAL holder must never be the execution fleet's leader. The row is
    // truthfully leaderless until the delegated agent has actually opened.
    leaderOwnerId: null,
  });
  try {
    const applied = await setClaimSpec({
      cupId: fleetSpecBeeKey(fleetSlug),
      workspaceId: args.workspaceId,
      spec: buildGoalDrainClaimSpec(args.goalId),
      updatedBy: args.agentOwnerId,
      potSlug,
    });
    if (!applied.ok) {
      throw new Error(`goal-scoped claim spec rejected: ${applied.errors.join('; ') || 'no detail'}`);
    }
    await args.goalTx`
      UPDATE harness_shared.goals
         SET metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object('drainFleet', ${fleetSlug}::text)
       WHERE id = ${args.goalId} AND workspace_id = ${args.workspaceId}
    `;
    return { fleetSlug, created, specRevision: applied.revision ?? null };
  } catch (e) {
    // Only unwind a fleet THIS call created — an idempotent re-mint onto an
    // existing fleet must never delete somebody else's registry row.
    if (created) await teardownDrainFleetMint({ workspaceId: args.workspaceId, fleetSlug }).catch(() => {});
    throw e;
  }
}

/**
 * Install an OPENED delegated leader with a compare-and-set. A concurrent
 * takeover wins over this recovery; the goal holder is never impersonated as
 * the caller. A missing coupling is returned as a partial result so the next
 * watchdog sweep can repair it without relaunching either agent.
 */
export async function registerGoalDrainFleetLeader(args: {
  workspaceId: string;
  goalId: string;
  fleetSlug: string;
  holderOwnerId: string;
  leaderOwnerId: string;
  declaredBy: string;
  expectedLeaderOwnerId: string | null;
}): Promise<{ registered: boolean; coupled: boolean; warning: string | null }> {
  const record = await setFleetLeader(
    args.workspaceId, args.fleetSlug, args.leaderOwnerId, undefined, args.expectedLeaderOwnerId,
  );
  if (!record) return { registered: false, coupled: false, warning: 'fleet leadership changed during launch' };
  let warning: string | null = null;
  try {
    await setPresenceFleet(args.workspaceId, args.leaderOwnerId, args.fleetSlug, 'leader');
  } catch (error) {
    warning = `leader presence could not be labelled: ${String(error)}`;
  }
  try {
    const edge = await ensureGoalDrainLeaderCoupling(args);
    if (edge) return { registered: true, coupled: true, warning };
    warning = [warning, 'coupling store returned no edge'].filter(Boolean).join('; ');
  } catch (error) {
    warning = [warning, `coupling failed: ${String(error)}`].filter(Boolean).join('; ');
  }
  return { registered: true, coupled: false, warning };
}

/** Repair an omitted/failed holder↔leader edge without replacing a live leader. */
export async function ensureGoalDrainLeaderCoupling(args: {
  workspaceId: string;
  goalId: string;
  fleetSlug: string;
  holderOwnerId: string;
  leaderOwnerId: string;
  declaredBy: string;
}): Promise<boolean> {
  const edge = await declareCoupling({
    workspaceId: args.workspaceId,
    agentA: args.holderOwnerId,
    agentB: args.leaderOwnerId,
    declaredBy: args.declaredBy,
    reason: `GOAL ${args.goalId} delegated drain fleet ${args.fleetSlug} leadership`,
  });
  return edge?.state === 'coupled';
}

/**
 * Compensate `mintDrainFleetForGoal` — the goals:start rollback leg. The
 * `metadata.drainFleet` stamp is not touched here: rollback deletes the whole
 * goal row, and teardown outside rollback has no goal left to un-stamp.
 */
export async function teardownDrainFleetMint(args: {
  workspaceId: string;
  fleetSlug: string;
}): Promise<void> {
  await clearClaimSpec({ cupId: fleetSpecBeeKey(args.fleetSlug), workspaceId: args.workspaceId }).catch(
    () => {},
  );
  await deleteFleet(args.workspaceId, args.fleetSlug).catch(() => {});
}

/**
 * FLAGS.GOAL_DRAIN_FLEET_AUTOMINT, default ON. Fail-OPEN on flag-infra errors
 * (the opposite of the watchdog's quiet-on-error choice, deliberately): the
 * watchdog failing open would SPAM, the mint failing open just provides the
 * structural guarantee this flag exists to provide — and the mint call site is
 * itself fail-soft, so a broken early-boot flag read cannot fail a goal start.
 */
export async function drainFleetAutoMintEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.GOAL_DRAIN_FLEET_AUTOMINT, 'system');
  } catch {
    return true;
  }
}
