/**
 * Pot member role tiers (shared-hive-collaboration-2026-06-14 B11 / P-014, D-011).
 *
 * Three tiers, derived from a member's GitHub permission on the pot's repo (the
 * authoritative source — never federated/self-claimed state):
 *
 *   admin | maintain  → owner        (the repo authorities → destructive/owner actions)
 *   write | triage    → collaborator (can push / manage → claim/run items, edit plans)
 *   read  | none      → read-only     (not a repo writer → view only, no mutations)
 *
 * PURE — the GitHub fetch + caching + the actual gate live in member-tier-gate.ts.
 * The owner/collaborator split mirrors binding-types' CLAIM_REQUIRED_PERMISSION
 * (admin|maintain) so the two permission models agree.
 */
import type { GithubRepoPermission } from '../harness/binding-types';

export type PotMemberTier = 'owner' | 'collaborator' | 'read-only';

/** Ordering for {@link tierMeets} — a higher rank subsumes every lower one. */
const TIER_RANK: Record<PotMemberTier, number> = {
  'read-only': 0,
  collaborator: 1,
  owner: 2,
};

/**
 * Map a GitHub repo permission to a pot tier. TOTAL — every GithubRepoPermission
 * maps, and the `default` keeps it total if GitHub ever adds a level (a new,
 * unknown level is treated as the most restrictive tier — fail-safe).
 */
export function permissionToTier(p: GithubRepoPermission): PotMemberTier {
  switch (p) {
    case 'admin':
    case 'maintain':
      return 'owner';
    case 'write':
    case 'triage':
      return 'collaborator';
    case 'read':
    case 'none':
      return 'read-only';
    default:
      return 'read-only';
  }
}

/**
 * Does `actual` satisfy the `required` minimum tier?
 * owner ⊇ collaborator ⊇ read-only.
 */
export function tierMeets(actual: PotMemberTier, required: PotMemberTier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}
