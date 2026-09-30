/**
 * hive-moderation — the P-MOD owner-action core: takedown + ban, plus the PURE
 * enforcement predicates honest peers apply (Brief EN-3 / P-MOD).
 *
 * Takedown + ban are OWNER decisions, so they ride EN-1's owner-SIGNED policy
 * (moderation.takedownList / moderation.bannedGithubIds) via mutateHivePolicy
 * (read → append → bump version → re-SIGN → federate). Two properties fall out of the
 * signed policy for free:
 *   - forgery-resistance: a member can't forge a takedown/ban (no owner key), nor forge
 *     a REMOVAL from the list.
 *   - NO RESURRECTION: replaying an OLD signed policy that lacks the takedown loses on
 *     policy_version/fed_hlc newest-wins (EN-1's ordering). So once hidden, honest peers
 *     keep it hidden — the brief's "no resurrection" comes from EN-1's ordering, not a
 *     separate mechanism here.
 *
 * The BAN additionally calls revokeHiveContributor (the write-plane block now; the
 * C-001 re-key turns it into a read cut-off when its op-path lands — su-313d1/46b7a).
 * Ban PERSISTENCE (can't re-join) = the membership admission gate reading bannedGithubIds
 * (hive-membership-policy.isBannedGithubId), which composes with the revoke/re-key.
 *
 * The PURE predicates (isContentTakenDown / filterTakenDownContent) are what an honest
 * peer's content read/serve path + EN-4's policy-admission seam call to HIDE taken-down
 * content. Owner authority on the actions is enforced by mutateHivePolicy (hive-key) and
 * the calling route's claim gate; this module is the mechanism.
 */
import {
  mutateHivePolicy as realMutateHivePolicy,
  type AuthorHivePolicyResult,
} from './hive-policy-author';
import {
  revokeHiveContributor as realRevokeHiveContributor,
  type RevokeHiveContributorResult,
} from './hive-revoke-contributor';
import type { HivePolicy } from './hive-policy-schema';

// ── PURE enforcement predicates (honest-peer side) ──────────────────────────────

/** Add `value` to a list without duplicates (order-stable; trims for the match). */
function addUnique(list: string[] | undefined, value: string): string[] {
  const cur = Array.isArray(list) ? list : [];
  return cur.some((x) => typeof x === 'string' && x.trim() === value.trim()) ? cur : [...cur, value];
}

/** Remove every entry matching `value` (trim-tolerant) from a list. */
function removeAll(list: string[] | undefined, value: string): string[] {
  const cur = Array.isArray(list) ? list : [];
  return cur.filter((x) => !(typeof x === 'string' && x.trim() === value.trim()));
}

/** Is this content ref on the owner's signed takedown list? Pure; exact (trimmed) match. */
export function isContentTakenDown(
  policy: Pick<HivePolicy, 'moderation'> | null | undefined,
  ref: string,
): boolean {
  const list = policy?.moderation?.takedownList;
  if (!Array.isArray(list) || list.length === 0) return false;
  const r = ref.trim();
  return list.some((x) => typeof x === 'string' && x.trim() === r);
}

/**
 * Drop every row whose content ref is taken down — the honest-peer content HIDE.
 * Pure + re-applies on every read, so a re-federated taken-down content op stays
 * hidden (no resurrection). `refOf` extracts a row's content ref (e.g. r => r.feature_id).
 * No policy / empty takedownList ⇒ rows returned unchanged (existing hives unaffected).
 */
export function filterTakenDownContent<T>(
  policy: Pick<HivePolicy, 'moderation'> | null | undefined,
  rows: readonly T[],
  refOf: (row: T) => string,
): T[] {
  const list = policy?.moderation?.takedownList;
  if (!Array.isArray(list) || list.length === 0) return [...rows];
  const hidden = new Set(list.filter((x): x is string => typeof x === 'string').map((x) => x.trim()));
  return rows.filter((row) => !hidden.has(refOf(row).trim()));
}

// ── OWNER actions (ride the owner-signed policy) ────────────────────────────────

export interface ModerationDeps {
  mutateHivePolicy?: typeof realMutateHivePolicy;
  revokeHiveContributor?: typeof realRevokeHiveContributor;
}

/**
 * OWNER takedown: append a content ref to the signed policy's moderation.takedownList
 * (re-signed + federated). Idempotent (no duplicate). Honest peers then hide it via
 * filterTakenDownContent; the signed-policy ordering gives no-resurrection.
 */
export async function takedownContent(
  input: { workspaceId: string; potHomeSlug: string; contentRef: string },
  deps: ModerationDeps = {},
): Promise<AuthorHivePolicyResult> {
  const mutate = deps.mutateHivePolicy ?? realMutateHivePolicy;
  return mutate({
    workspaceId: input.workspaceId,
    potHomeSlug: input.potHomeSlug,
    mutate: (p: HivePolicy): HivePolicy => ({
      ...p,
      moderation: {
        ...p.moderation,
        takedownList: addUnique(p.moderation?.takedownList, input.contentRef),
      },
    }),
  });
}

/** OWNER restore (un-takedown): remove a content ref from the signed takedown list.
 *  Owner-authored + signed — legitimate owner action, distinct from a malicious resurrection. */
export async function restoreContent(
  input: { workspaceId: string; potHomeSlug: string; contentRef: string },
  deps: ModerationDeps = {},
): Promise<AuthorHivePolicyResult> {
  const mutate = deps.mutateHivePolicy ?? realMutateHivePolicy;
  return mutate({
    workspaceId: input.workspaceId,
    potHomeSlug: input.potHomeSlug,
    mutate: (p: HivePolicy): HivePolicy => ({
      ...p,
      moderation: {
        ...p.moderation,
        takedownList: removeAll(p.moderation?.takedownList, input.contentRef),
      },
    }),
  });
}

export interface BanMemberResult {
  /** The signed-policy ban append (adds to bannedGithubIds → rejoin-deny). */
  policy: AuthorHivePolicyResult;
  /** The revoke (write-plane block now; read cut-off when the C-001 re-key lands). */
  revoke: RevokeHiveContributorResult | { skipped: true };
}

/**
 * OWNER ban-for-repeat-abuse — the teeth. Two legs:
 *   1. append the github id to the signed moderation.bannedGithubIds (federates the ban;
 *      the admission gate then denies re-join — ban PERSISTENCE).
 *   2. revokeHiveContributor (drop their devices from federation; the C-001 re-key turns
 *      this into a read cut-off at the next epoch — gated on the re-key op-path landing).
 *
 * `revoke` defaults ON; pass `revoke:false` to ban-without-revoke (policy-only). The
 * ban append is attempted first; if it fails (not owner Swarm), revoke is skipped.
 */
export async function banMember(
  input: { workspaceId: string; potHomeSlug: string; githubUserId: number; revoke?: boolean },
  deps: ModerationDeps = {},
): Promise<BanMemberResult> {
  const mutate = deps.mutateHivePolicy ?? realMutateHivePolicy;
  const revokeFn = deps.revokeHiveContributor ?? realRevokeHiveContributor;
  const gid = String(input.githubUserId);

  const policy = await mutate({
    workspaceId: input.workspaceId,
    potHomeSlug: input.potHomeSlug,
    mutate: (p: HivePolicy): HivePolicy => ({
      ...p,
      moderation: {
        ...p.moderation,
        bannedGithubIds: addUnique(p.moderation?.bannedGithubIds, gid),
      },
    }),
  });

  // Only attempt the revoke teeth once the ban is authoritatively recorded (the owner
  // Swarm). A policy-write failure (not_owner_swarm) means we shouldn't revoke either.
  if (input.revoke === false || !policy.ok) {
    return { policy, revoke: { skipped: true } };
  }
  const revoke = await revokeFn({
    workspaceId: input.workspaceId,
    potHomeSlug: input.potHomeSlug,
    githubUserId: input.githubUserId,
  });
  return { policy, revoke };
}

/** OWNER unban: remove the github id from the signed ban list (re-join allowed again). */
export async function unbanMember(
  input: { workspaceId: string; potHomeSlug: string; githubUserId: number },
  deps: ModerationDeps = {},
): Promise<AuthorHivePolicyResult> {
  const mutate = deps.mutateHivePolicy ?? realMutateHivePolicy;
  const gid = String(input.githubUserId);
  return mutate({
    workspaceId: input.workspaceId,
    potHomeSlug: input.potHomeSlug,
    mutate: (p: HivePolicy): HivePolicy => ({
      ...p,
      moderation: {
        ...p.moderation,
        bannedGithubIds: removeAll(p.moderation?.bannedGithubIds, gid),
      },
    }),
  });
}
