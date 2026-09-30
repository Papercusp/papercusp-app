/**
 * content-write-authority — author-scoped write authority for federated content
 * (dogfood-silent-canonical-hive-join P-018 / D-012).
 *
 * THE PROBLEM (D-012): federated plan/work-item rows are keyed GLOBALLY and merge by pure
 * last-writer-wins; the only existing gate (member-content-guard.decideMemberContentOp) checks
 * MEMBERSHIP, not per-row OWNERSHIP. So in a hive you're a member of, ANY member can overwrite or
 * tombstone (delete) ANY plan. That's acceptable for a TRUSTED team hive, but unsafe for an `open`
 * PUBLIC hive — a stranger-member could wipe everyone's plans.
 *
 * THE FIX: this PURE decision binds each federated key to the UNFORGEABLE identity of its first
 * writer (its owner) and, in author-scoped mode, honors a later overwrite/delete ONLY from that
 * same owner — or from a privileged identity (the hive owner / a moderator, for takedown). In
 * `member` mode it is a no-op (allow everything) so trusted hives are byte-identical to today.
 *
 * IDENTITY GRAIN — must be UNFORGEABLE. Callers MUST pass the receiver-stamped source-log identity
 * (the `sourceLogDevice` the membership guard uses), NEVER the op's caller-supplied `author_pubkey`
 * (peer-log.ts: that field is forgeable — keying authority on it would be a security hole). This
 * module is identity-agnostic (it compares opaque strings) but that contract is on the caller.
 */
import type { HivePolicy } from '../../hive-policy-schema';

/** 'member' = any member may write any row (today's behavior; trusted hives). 'author-scoped' =
 *  only a row's owner (first writer) or a privileged identity may overwrite/delete it. */
export type ContentWriteMode = 'member' | 'author-scoped';

export interface WriteAuthorityInput {
  mode: ContentWriteMode;
  /** The unforgeable identity already bound to this key as its owner; null ⇒ not yet bound. */
  ownerIdentity: string | null | undefined;
  /** The unforgeable (source-log) identity of THIS op's author; null ⇒ unidentified. */
  opIdentity: string | null | undefined;
  /** Identities with override authority — the hive owner + moderators (for takedown / repair). */
  privilegedIdentities?: ReadonlySet<string>;
}

export type WriteAuthorityDecision =
  | { decision: 'allow'; bindOwner: boolean; reason: string }
  | { decision: 'reject'; reason: 'not-owner' | 'unidentified' };

/**
 * Decide whether a federated write/delete op may apply to a row, and whether the caller should
 * record the op's identity as the row's owner (first-write binding). PURE + total.
 *
 *  - `member` mode → always allow, never bind (preserves today's trusted-hive behavior exactly).
 *  - `author-scoped` mode:
 *      • op author is privileged (hive owner / moderator) → allow (no rebind) — moderation override.
 *      • owner not yet bound → the FIRST identified writer claims ownership → allow + bindOwner.
 *        An UNIDENTIFIED op on an unbound key is rejected fail-closed (can't bind to nothing).
 *      • op author === owner → allow (the owner editing/deleting their own row).
 *      • otherwise → reject 'not-owner' (a non-owner member trying to overwrite/delete).
 */
export function decideContentWriteAuthority(input: WriteAuthorityInput): WriteAuthorityDecision {
  if (input.mode === 'member') {
    return { decision: 'allow', bindOwner: false, reason: 'member-mode' };
  }
  const op = input.opIdentity ?? null;
  const owner = input.ownerIdentity ?? null;

  if (op && input.privilegedIdentities?.has(op)) {
    return { decision: 'allow', bindOwner: false, reason: 'privileged' };
  }
  if (owner === null) {
    // First write claims ownership — but only an IDENTIFIED writer can own (fail-closed).
    if (!op) return { decision: 'reject', reason: 'unidentified' };
    return { decision: 'allow', bindOwner: true, reason: 'first-write-bind' };
  }
  if (op && op === owner) {
    return { decision: 'allow', bindOwner: false, reason: 'owner' };
  }
  return { decision: 'reject', reason: 'not-owner' };
}

/**
 * Resolve the effective write-authority mode from an owner-signed hive policy.
 *  - explicit `policy.contentWriteAuthority` wins ('member' | 'author-scoped');
 *  - else an `open` membership hive DEFAULTS to 'author-scoped' (a public hive must protect rows
 *    from stranger-members — D-012);
 *  - else 'member' (today's behavior for trusted allowlist/approval/no-policy hives).
 */
export function resolveContentWriteMode(policy: HivePolicy | null | undefined): ContentWriteMode {
  const explicit = policy?.contentWriteAuthority;
  if (explicit === 'member' || explicit === 'author-scoped') return explicit;
  if (policy?.membership === 'open') return 'author-scoped';
  return 'member';
}
