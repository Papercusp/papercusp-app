/**
 * resolveActorIdentity — the FULL per-actor coordination identity:
 * the `(user, device, session)` triple of D-006
 * (distributed-coordination-shared-harness-2026-06-04, Phase 0.1).
 *
 * `resolveAgentIdentity` (identity.ts) resolves the SYNC, per-SESSION identity
 * (ownerId = the session id, userId = the acting-as human on the power-user
 * tier). That stays the hot-path primitive every coordination write already
 * uses. This is the additive ASYNC superset that also resolves the DEVICE
 * identity — the `(github_user_id, device_pubkey)` the Model-B federation mints
 * (resolveUsageActor) — so cross-machine attribution can carry a stable USER +
 * DEVICE, not just a per-session id:
 *
 *   session → ownerId   (su-<uuid> / pus-<uuid>, already resolved, per OS process)
 *   user    → userId (power-user human) AND githubUserId (federation identity)
 *   device  → devicePubkey (the Ed25519 key the swarm announces + the federation
 *             stamps as author_pubkey on a federated row)
 *
 * WHY a separate async helper (not folded into resolveAgentIdentity): the device
 * identity needs a (cached) `gh` lookup — async — and the sync resolver is on the
 * lock/coord hot path. Keeping this additive means existing callers are
 * unchanged; a caller that wants the full triple (presence aggregation per user,
 * a federated row's author, su-119ce's agent-name `owner_user`) opts in.
 *
 * DEV-BOX REALITY: `gh` is often unauthenticated here, so resolveUsageActor
 * returns null and `githubUserId`/`devicePubkey` are null. That is correct and
 * forward-compatible — the triple is fully populated once a real GitHub identity
 * + device keypair exist (the same regime in which cross-machine federation
 * itself lights up). Callers MUST treat the device fields as best-effort.
 */

import { resolveAgentIdentity, type AgentIdentity, type ResolveIdentityCtx } from './identity';
import { resolveUsageActor, type UsageActor } from '../../harness/usage-actor';

/** The full `(user, device, session)` coordination identity (D-006). */
export interface ActorIdentity extends AgentIdentity {
  /** Stable numeric GitHub user id — the cross-machine USER identity. Null when
   *  gh is unauthenticated (best-effort). */
  githubUserId: number | null;
  /** The device's Ed25519 public key (base64) — matches a federated row's
   *  author_pubkey + the swarm announce. Null when gh is unauthenticated. */
  devicePubkey: string | null;
}

export interface ResolveActorIdentityDeps {
  /** Inject the device-identity resolver (tests / a pre-resolved actor). */
  resolveUsageActor?: () => Promise<UsageActor | null>;
}

/**
 * Resolve the full actor identity: the sync session identity
 * ({@link resolveAgentIdentity}) plus the async device identity
 * ({@link resolveUsageActor}). Never throws beyond what resolveAgentIdentity
 * throws (an unattributable ctx is still a hard error — coordination writes must
 * be attributable); the device fields degrade to null, never error.
 */
export async function resolveActorIdentity(
  ctx: ResolveIdentityCtx,
  deps: ResolveActorIdentityDeps = {},
): Promise<ActorIdentity> {
  const base = resolveAgentIdentity(ctx);
  const resolveDevice = deps.resolveUsageActor ?? resolveUsageActor;
  let actor: UsageActor | null = null;
  try {
    actor = await resolveDevice();
  } catch {
    // Device identity is best-effort — a gh/network hiccup must not break a
    // coordination write that is otherwise fully attributable by session.
    actor = null;
  }
  return {
    ...base,
    githubUserId: actor?.githubUserId ?? null,
    devicePubkey: actor?.devicePubkey ?? null,
  };
}

/**
 * The best-effort stable USER key for a coordination row, given an actor
 * identity: prefer the cross-machine github user id, then the acting-as human
 * user, then the per-session ownerId. This is the `owner_user` shape
 * plan-item-assignment-claim-liveness-2026-06-04 asked for — stable enough today
 * (ownerId) and strictly stronger once a real user identity exists, with no
 * call-site change.
 */
export function actorUserKey(actor: ActorIdentity): string {
  if (actor.githubUserId != null) return `gh:${actor.githubUserId}`;
  if (actor.userId) return actor.userId;
  return actor.ownerId;
}

/**
 * EVERY stable key a returning session could be addressed by — the inverse of
 * {@link actorUserKey}'s pick-one. The offline-member mailbox (shared-hive-
 * collaboration P-016 / drainUserMailbox) addresses an `@user:<actorUserKey>`
 * slot, but the assigner and the returning member may resolve DIFFERENT rungs of
 * the ladder: the assigner picks `gh:<id>` from the membership roster, while the
 * member's own session may only resolve `userId`/`ownerId` today (the dev-box
 * gh-unauth case actor-identity.ts documents). Draining on ALL of a session's
 * candidate keys closes that gap — an assignment lands once the member returns,
 * by whichever key matches. Ordered strongest → weakest; deduped.
 */
export function actorMailboxKeys(actor: ActorIdentity): string[] {
  const keys: string[] = [];
  if (actor.githubUserId != null) keys.push(`gh:${actor.githubUserId}`);
  if (actor.userId) keys.push(actor.userId);
  if (actor.ownerId) keys.push(actor.ownerId);
  return [...new Set(keys)];
}
