/**
 * resolveCreatePotMembership — validate a `harness:create { hive }` request and
 * return the `hive_slug` to stamp on the new harness at CREATE time
 * (shared-hive-federation-2026-06-08, D-010 membership-producer gap, the
 * create-time half).
 *
 * `pot:add-member` (pot/_add-member.ts) makes an EXISTING harness a Hive
 * member; this is the complementary producer that lets a NEW harness be born
 * directly into a Hive — the case the harnesses-tab "add into hive" creation
 * fork + the cross-machine member E2E (P-011) need, without a create →
 * add-member two-step. Setting `hive_slug` is the registry edit ONLY: the
 * harness's substrate then federates over the Hive topic (resolveHiveSwarmBinding)
 * with `harness_slug` staying the within-Hive component scope (D-003).
 *
 * No nesting guard is needed here (unlike _add-member's `is_hive_home` check):
 * `harness:create` never sets `harness_kind`, so a harness it creates is never a
 * Hive home (Hive homes come only from `pot:create`, which stamps
 * `harness_kind:'hive'`). The new harness is therefore always a member-eligible
 * non-hive harness, so making it a member cannot nest a Hive.
 *
 * Pure over the registry snapshot so the validation is unit-testable without PG
 * or fs — mirrors the _add-member / fleet-selectors discipline.
 */
import type { HarnessRegistry } from '../../harness-registry';
import { isPotProject } from '../pot/_resolve';

export type CreatePotMembershipError = 'hive_not_found' | 'not_a_hive';

export type CreatePotMembershipResult =
  | { ok: true; hive_slug: string }
  | { ok: false; error: CreatePotMembershipError; message: string };

/**
 * Resolve the `hive_slug` to set on a harness being created into `potHomeSlug`.
 * Fails when the target is not a registered Hive home (`harness_kind:'hive'`).
 *
 * @param reg          the workspace harness registry (loaded by the caller).
 * @param potHomeSlug the requested Hive home slug (the `hive` create arg).
 */
export function resolveCreatePotMembership(
  reg: HarnessRegistry,
  potHomeSlug: string,
): CreatePotMembershipResult {
  const target = reg.projects.find((p) => p.slug === potHomeSlug);
  if (!target) {
    return {
      ok: false,
      error: 'hive_not_found',
      message: `no pot '${potHomeSlug}' in this workspace`,
    };
  }
  if (!isPotProject(target)) {
    return {
      ok: false,
      error: 'not_a_hive',
      message: `'${potHomeSlug}' is not a pot (harness_kind:'hive') — only a pot can own members`,
    };
  }
  return { ok: true, hive_slug: potHomeSlug };
}
