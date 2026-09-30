/**
 * Pot member role-tier resolution + the owner-action gate
 * (shared-hive-collaboration-2026-06-14 B11 / P-014, D-011).
 *
 * SECURITY MODEL. An owner-action on a SHARED pot (one bound to a GitHub repo)
 * is permitted only when THIS install's owner is an owner-tier member
 * (admin|maintain) on the pot's repo, re-derived LIVE from GitHub — the
 * authoritative source, NEVER federated/self-claimed state. Identity is the
 * local machine's gh-resolved owner (resolveLocalGithubIdentity), matched to a
 * VERIFIED hive_members row (binding_status='verified'); an unverified or
 * non-member identity earns no tier.
 *
 * FAIL MODE (owner-directed): a SHARED pot whose permission can't be resolved
 * (GitHub down / not a collaborator / no gh auth) → DENY owner actions
 * (fail-closed). A SOLO/unbound pot (no repo binding) → the local owner keeps
 * owner tier (never lock the owner out of their own single-user pot).
 *
 * FRESHNESS (owner-directed): owner-actions re-derive LIVE; routine
 * (collaborator) reads use the persisted cache (hive_members.repo_permission,
 * refreshed by the daily recheck). Gated behind FLAGS.POT_ROLE_TIERS
 * (DEFAULT-ON; OFF = today's behavior — existing root-only/source gates only).
 */
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { getHiveMember } from '../hive-membership-store';
import { resolveFederatedPotScope } from '../federated-pot-scope';
import { getRepoPermission } from '../harness/binding-service';
import type { GithubRepoPermission } from '../harness/binding-types';
import {
  resolveLocalGithubIdentity,
  type LocalGithubIdentity,
} from '../identity/resolve-local-github-identity';
import { permissionToTier, tierMeets, type PotMemberTier } from './member-tiers';

export interface PotBindingRepo {
  owner: string;
  repo: string;
  fullName: string;
}

/**
 * Reverse-lookup the GitHub repo a pot is bound to, by its home-harness slug.
 * `null` = SOLO/unbound (no active, non-superseded binding). The binding cache
 * is keyed by repo id, so there is no shipped reverse-by-slug helper — this is it.
 */
export async function resolvePotRepo(
  workspaceId: string,
  potHomeSlug: string,
): Promise<PotBindingRepo | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ github_full_name: string }[]>`
    SELECT github_full_name
      FROM harness_shared.shared_repo_binding_cache
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${potHomeSlug}
       AND claim_status <> 'superseded'
     LIMIT 1`;
  const full = rows[0]?.github_full_name;
  if (!full) return null;
  const slash = full.indexOf('/');
  if (slash <= 0 || slash >= full.length - 1) return null; // malformed "owner/repo"
  return { owner: full.slice(0, slash), repo: full.slice(slash + 1), fullName: full };
}

export type TierReason =
  | 'solo-unbound' // no repo binding → owner (the local owner's own pot)
  | 'github' // live-derived from the collaborator graph
  | 'cache' // read from the persisted cache (non-live calls)
  | 'not-a-member' // shared, caller not in hive_members → read-only (denied)
  | 'unverified' // shared, member binding_status != 'verified' → read-only (denied)
  | 'github-unresolvable'; // shared, GitHub down / not a collaborator → read-only (fail-closed)

export interface ResolvedTier {
  tier: PotMemberTier;
  reason: TierReason;
}

export interface ResolveTierOpts {
  workspaceId: string;
  potSlug: string;
  githubUserId: number;
  /** Live = re-derive from GitHub (owner-actions); else read the cache, fall back to live. */
  live?: boolean;
}

/** Cached-read freshness window for routine (non-owner-action) tier reads. */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h; owner-actions bypass with live=true.

/**
 * Derive a member's tier for a pot. Solo/unbound → owner. Shared → the verified
 * member's live GitHub permission (fail-closed on any resolution failure), with
 * a write-through cache. NEVER trusts federated/self-claimed state — the github
 * permission comes from GitHub and the identity must be a verified pot member.
 */
export async function resolvePotMemberTier(opts: ResolveTierOpts): Promise<ResolvedTier> {
  const { workspaceId, potSlug, githubUserId } = opts;
  const repo = await resolvePotRepo(workspaceId, potSlug);
  if (!repo) return { tier: 'owner', reason: 'solo-unbound' };

  // ⚠ SCOPE (WI-6312): `potSlug` is the LOCAL registry handle — correct for
  // `resolvePotRepo` above, WRONG for every `pot_members` access below, which the
  // projections write under the FEDERATED scope. Resolved ONCE here and threaded,
  // because this flow touches pot_members THREE times (the getHiveMember read plus
  // the two raw-SQL permission-cache statements) and only the first is type-policed
  // — resolving per-call would leave the untyped two silently on the local handle.
  // On a divergent joiner the local handle made getHiveMember return null, and
  // `!member` is indistinguishable from "not a member", so a REAL verified member
  // was silently demoted to read-only.
  const potScope = await resolveFederatedPotScope(workspaceId, potSlug);

  const { sql } = getOrgPg();
  const member = await getHiveMember(workspaceId, potScope, githubUserId);
  if (!member) return { tier: 'read-only', reason: 'not-a-member' };
  if (member.bindingStatus !== 'verified') return { tier: 'read-only', reason: 'unverified' };

  // Cached read path (non-live): use a fresh cache if present.
  if (!opts.live) {
    const cached = await sql<{ repo_permission: string | null; permission_checked_at: string | null }[]>`
      SELECT repo_permission, permission_checked_at
        FROM harness_shared.pot_members
       WHERE workspace_id = ${workspaceId} AND pot_home_slug = ${potScope} AND github_user_id = ${githubUserId}
       LIMIT 1`;
    const row = cached[0];
    const at = row?.permission_checked_at != null ? Number(row.permission_checked_at) : null;
    if (row?.repo_permission && at != null && Date.now() - at < CACHE_TTL_MS) {
      return { tier: permissionToTier(row.repo_permission as GithubRepoPermission), reason: 'cache' };
    }
  }

  // Live derivation from GitHub (authoritative). Fail CLOSED on ANY error.
  let perm: GithubRepoPermission;
  try {
    perm = await getRepoPermission(repo.owner, repo.repo, member.githubUsername);
  } catch {
    return { tier: 'read-only', reason: 'github-unresolvable' };
  }
  // Write-through cache (best-effort; advisory — owner-actions always re-derive).
  try {
    await sql`
      UPDATE harness_shared.pot_members
         SET repo_permission = ${perm}, permission_checked_at = ${Date.now()}
       WHERE workspace_id = ${workspaceId} AND pot_home_slug = ${potScope} AND github_user_id = ${githubUserId}`;
  } catch {
    /* cache is advisory */
  }
  return { tier: permissionToTier(perm), reason: 'github' };
}

export interface PotTierGateResult {
  ok: boolean;
  tier?: PotMemberTier;
  reason?: TierReason | 'flag-off' | 'gh-auth-required';
  message?: string;
}

/**
 * The owner-action gate. Returns `ok:true` when the LOCAL OWNER meets `minTier`
 * on the pot's repo. Composes WITH (does not replace) the existing
 * root-only/source/confirm gates at each chokepoint.
 *
 * - Flag OFF → ok:true (no-op, today's behavior).
 * - SOLO/unbound pot → ok:true (owner; never lock the owner out of their pot).
 * - SHARED pot + unresolvable identity/permission → ok:false (fail-closed).
 *
 * `resolveIdentity` is injectable for tests; defaults to resolveLocalGithubIdentity.
 */
export async function requirePotTier(args: {
  workspaceId: string;
  potSlug: string;
  minTier: PotMemberTier;
  resolveIdentity?: () => Promise<LocalGithubIdentity>;
}): Promise<PotTierGateResult> {
  if (!(await getFlag(FLAGS.POT_ROLE_TIERS, 'system'))) {
    return { ok: true, reason: 'flag-off' };
  }

  // SOLO short-circuit: the local owner always passes on their own unbound pot,
  // even without gh auth — a single-user pot must never lock its owner out.
  const repo = await resolvePotRepo(args.workspaceId, args.potSlug);
  if (!repo) return { ok: true, tier: 'owner', reason: 'solo-unbound' };

  const identity = await (args.resolveIdentity ?? resolveLocalGithubIdentity)();
  if (identity.kind !== 'ok') {
    // Shared pot + no resolvable GitHub identity → fail CLOSED for owner actions.
    return {
      ok: false,
      reason: 'gh-auth-required',
      message: `'${args.potSlug}' is a shared pot (${repo.fullName}); a '${args.minTier}' action needs your GitHub identity. Run \`gh auth login\`.`,
    };
  }

  const resolved = await resolvePotMemberTier({
    workspaceId: args.workspaceId,
    potSlug: args.potSlug,
    githubUserId: identity.githubUserId,
    live: args.minTier === 'owner', // high-stakes → live re-derive (no stale cache)
  });
  if (!tierMeets(resolved.tier, args.minTier)) {
    return {
      ok: false,
      tier: resolved.tier,
      reason: resolved.reason,
      message: `Your access to ${repo.fullName} is '${resolved.tier}' (${resolved.reason}); this action requires '${args.minTier}'.`,
    };
  }
  return { ok: true, tier: resolved.tier, reason: resolved.reason };
}
