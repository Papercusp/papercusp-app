/**
 * hive-membership-policy — the PURE membership-admission decision for the
 * shared-hive owner-enforcement layer (PLAN-owner-enforcement-layer Phase EN-3,
 * Brief EN-3 / P-MEMBER).
 *
 * This is the heart of P-MEMBER: given the owner-SIGNED hive policy (EN-1's
 * `hive_policy`, read via `getHivePolicy`) and a prospective joiner's GitHub
 * identity, decide whether the joiner is `admit`ted to the trust set, held
 * `pending` for owner approval, or `refuse`d. The DECISION is pure + deterministic
 * (no PG, no crypto, no I/O) so it is exhaustively teeth-testable; the WIRING that
 * consults it at the join / add-member seam (and the pending-join + owner-decision
 * stores) lives separately (hive-membership-admission.ts).
 *
 * Why a focused module (not the broader EN-4 `policy-admission.ts`): P-MEMBER is a
 * self-contained, fail-safe-by-default gate that must build AHEAD of EN-1's policy
 * storage landing and AHEAD of EN-4's general admission seam. It depends on the
 * policy SHAPE (a structural view), not EN-1's exact exported `HivePolicy` type, so
 * it compiles before `hive-policy-store.ts` exists; the caller passes whatever
 * `getHivePolicy` returns and it is structurally compatible.
 *
 * PRECEDENCE (the enforcement contract — order matters, tested):
 *   1. BAN overrides everything. A banned `github_user_id` is refused in EVERY
 *      mode, including `open` and even if separately allowlisted — a ban is the
 *      owner's strongest in-policy lever, composing with the C-001 re-key cut-off
 *      (EN-3 / P-MOD ban leg). Match is on the STABLE numeric id (a login renames;
 *      an id does not), so a banned user cannot rejoin under a renamed login.
 *   2. MODE decides the rest:
 *        - `open` (or absent policy)  → admit  (today's behavior; unaffected hives).
 *        - `allowlist`                → admit iff the joiner's login is pre-approved,
 *                                       else refuse. An EMPTY allowlist refuses all
 *                                       (the owner pre-approves explicitly).
 *        - `approval`                 → pending (federated request → owner decides).
 *        - unknown/forward-compat mode → pending (FAIL-SAFE: never auto-admit a mode
 *                                       an older peer doesn't understand; route to
 *                                       the owner rather than hard-refusing a
 *                                       legitimate joiner).
 *
 * GitHub login matching is case-INSENSITIVE (GitHub logins are), trimmed. The
 * numeric id match is exact. A null/absent policy ⇒ `open` ⇒ admit, so existing
 * hives with no policy are completely unaffected (EN-1 guarantee #2).
 */

/**
 * The membership/moderation subset of EN-1's `HivePolicy` that the admission gate
 * reads. A read-LENS structural SUPERTYPE of `HivePolicy` (hive-policy-schema.ts):
 * EN-1's full typed policy is assignable to this, so callers pass `getHivePolicy().policy`
 * directly, and the unit tests construct lite literals. Deliberately NO index signature
 * (an index sig would make a typed `HivePolicy` value un-assignable here) — this view
 * only reads the named fields below; unknown forward-compat keys on the real policy are
 * preserved by EN-1's signing/round-trip, they just aren't read here.
 */
export interface MembershipPolicyView {
  /** Admission mode. Absent ⇒ `open` (today's behavior). Unknown value ⇒ fail-safe
   *  to `pending` (owner-gated), never auto-admit. */
  membership?: 'open' | 'approval' | 'allowlist' | (string & {});
  /** GitHub LOGINS the owner pre-approved (consulted only under `allowlist`). */
  allowlist?: string[];
  /** Owner-authored moderation state (rides the owner-signed policy, EN-3 decision). */
  moderation?: {
    /** Stable numeric GitHub user ids (as strings) the owner banned — denied re-join
     *  in every mode. */
    bannedGithubIds?: string[];
    /** Owner enabled member reporting (the report tool gates on this). NOT read by
     *  membership admission — declared here only so a full HivePolicy.moderation (which
     *  carries it, hive-policy-schema.ts) type-checks where a MembershipPolicyView is
     *  expected (e.g. evaluateMembershipAdmission in the policy tests). */
    reportable?: boolean;
  };
}

/** The prospective joiner's GitHub identity (resolved before admission). */
export interface JoinerIdentity {
  /** Stable numeric GitHub user id — the ban-match key. */
  githubUserId: number;
  /** GitHub login — the allowlist-match key (case-insensitive). */
  githubUsername: string;
}

export type MembershipAdmissionDecision =
  | { decision: 'admit' }
  | { decision: 'pending'; reason: 'awaiting_owner_approval' | 'unknown_mode' }
  | { decision: 'refuse'; reason: 'banned' | 'not_allowlisted' };

const KNOWN_MODES = new Set(['open', 'approval', 'allowlist']);

/** Case-insensitive, trimmed GitHub login equality. */
function loginEq(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Is this joiner's stable numeric id in the owner's ban list? */
export function isBannedGithubId(
  policy: MembershipPolicyView | null | undefined,
  githubUserId: number,
): boolean {
  const banned = policy?.moderation?.bannedGithubIds;
  if (!Array.isArray(banned) || banned.length === 0) return false;
  const idStr = String(githubUserId);
  // Match on the stringified numeric id; tolerate stray whitespace in the stored list.
  return banned.some((b) => typeof b === 'string' && b.trim() === idStr);
}

/** Is this login pre-approved under an `allowlist`-mode policy? */
export function isAllowlisted(
  policy: MembershipPolicyView | null | undefined,
  githubUsername: string,
): boolean {
  const list = policy?.allowlist;
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.some((u) => typeof u === 'string' && loginEq(u, githubUsername));
}

/**
 * Decide a prospective joiner's admission against the owner-signed policy.
 *
 * Pure + deterministic. `null`/absent policy ⇒ `open` ⇒ `admit` (existing hives
 * unaffected). See the file header for the full precedence contract.
 */
export function evaluateMembershipAdmission(
  policy: MembershipPolicyView | null | undefined,
  joiner: JoinerIdentity,
): MembershipAdmissionDecision {
  // 1. Ban overrides every mode (and any allowlist entry). Strongest in-policy lever.
  if (isBannedGithubId(policy, joiner.githubUserId)) {
    return { decision: 'refuse', reason: 'banned' };
  }

  // 2. Mode. Absent policy / absent mode ⇒ open ⇒ admit (today's behavior).
  const mode = policy?.membership ?? 'open';

  if (mode === 'open') return { decision: 'admit' };

  if (mode === 'allowlist') {
    return isAllowlisted(policy, joiner.githubUsername)
      ? { decision: 'admit' }
      : { decision: 'refuse', reason: 'not_allowlisted' };
  }

  if (mode === 'approval') {
    return { decision: 'pending', reason: 'awaiting_owner_approval' };
  }

  // Forward-compat: a mode an older peer doesn't understand. FAIL-SAFE to pending
  // (owner decides) — never auto-admit under an unrecognized stricter mode, never
  // hard-refuse a possibly-legitimate joiner.
  if (!KNOWN_MODES.has(mode)) {
    return { decision: 'pending', reason: 'unknown_mode' };
  }

  // Unreachable (all known modes handled above), but keep the function total.
  return { decision: 'pending', reason: 'unknown_mode' };
}
