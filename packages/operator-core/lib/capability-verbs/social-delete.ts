/**
 * `social:delete` and the non-idempotent-verb confirmation rail (P-008).
 *
 * WHY DELETE IS NOT A THIRD WRITE VERB.
 *
 * `reply` and `post` are ADDITIVE, and their non-idempotency fails in a
 * forgiving direction: a duplicated reply is noise, correctable by a follow-up.
 * Delete is SUBTRACTIVE and terminal — the content is gone from the platform,
 * with no undo and no trash on any Wave A platform. It is also the one verb
 * whose RETRY IS INDISTINGUISHABLE FROM ITS SUCCESS: call it twice and the
 * second call sees exactly what a successful first call left behind.
 *
 * The plan admits it deliberately anyway, and the reasoning is worth keeping
 * where the code is: an agent that can post and cannot retract is WORSE than
 * one that can do neither, because the failure mode of the post verbs — a wrong
 * public post under the owner's identity — is precisely what delete remediates.
 * Withholding delete does not make the system safer; it makes `social:post`
 * unrecoverable.
 *
 * WHAT MAKES THE CONFIRMATION REAL RATHER THAN CEREMONIAL.
 *
 * A `confirm: true` boolean is not a confirmation. An injected instruction can
 * set a boolean exactly as easily as the owner can, so it authenticates nothing
 * and its only real effect is to make the caller feel careful. The same is true
 * of re-passing the postId: it is already in hand, so echoing it proves only
 * that the caller can copy a string.
 *
 * A confirmation is only worth anything if producing it REQUIRES having seen
 * the thing being destroyed. So the token here is derived from the resolved
 * post's own CONTENT (`socialDeleteToken`), handed out by the read path, and
 * recomputed server-side at delete time from the row as it stands NOW. That
 * gives three properties a boolean cannot:
 *
 *  - It cannot be REPLAYED onto a different post: the token is a function of
 *    the post, so one post's token never matches another's.
 *  - It cannot be GUESSED from the ref: an agent that fabricated or transposed
 *    a postId without reading it cannot produce the token, which is exactly the
 *    wrong-target deletion this rail exists to stop.
 *  - It goes STALE if the post changed between read and delete, which correctly
 *    refuses: you are no longer deleting what you looked at.
 *
 * This is the same move as D-007 ruling (a) one domain over — bind the
 * dangerous parameter to something the server derives, rather than trusting a
 * value the caller can vary independently.
 */
import type postgres from 'postgres';
import {
  assertSocialWriteAllowed,
  type SocialPlatformId,
} from '../external-triggers/social/platform-registry';
import {
  formatSocialPostRef,
  getSocialWriteAdapter,
  parseSocialPostRef,
  resolveSocialPost,
  resolveSocialReplyCoordinates,
  resolveSocialOutboundContext,
  type SocialDeleteOutcome,
  type SocialPostRef,
} from './social';
import type { CanonicalDocument } from './resolve';

/* -------------------------------------------------------------------------- */
/* The confirmation token                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A short, stable digest of WHAT a post is, used as the delete confirmation.
 *
 * Derived from the ref plus the post's own text so that seeing the post is the
 * only way to obtain it. The text is bounded before hashing so a long post and
 * its own prefix cannot produce different tokens for what a reader saw as the
 * same thing — the read path shows a bounded body, and the token must agree
 * with what was SHOWN rather than with bytes the caller never received.
 *
 * FNV-1a, matching the idempotency keys in social.ts. This is not a security
 * hash and does not need to be: it is a mismatch DETECTOR between two values
 * computed by the same server from the same row, not a secret. Its job is to
 * make "I have seen this post" checkable, and an attacker who can read the post
 * to forge the token could simply have deleted it through the normal path
 * anyway — the rail is against wrong-target and replayed deletion, not against
 * an adversary who already holds the owner's read grant.
 */
export const DELETE_TOKEN_TEXT_WINDOW = 240;

export function socialDeleteToken(ref: SocialPostRef, text: string): string {
  const subject = `${formatSocialPostRef(ref)}\x00${String(text ?? '')
    .trim()
    .slice(0, DELETE_TOKEN_TEXT_WINDOW)}`;
  let hash = 0x811c9dc5;
  for (const char of subject) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `pc-social-del-${hash.toString(16).padStart(8, '0')}`;
}

/** Delete's idempotency key. Disjoint from the reply/post key spaces by prefix. */
export function socialDeleteIdempotencyKey(ref: SocialPostRef): string {
  let hash = 0x811c9dc5;
  for (const char of formatSocialPostRef(ref)) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `pc-social-delete-${hash.toString(16).padStart(8, '0')}`;
}

export class SocialDeleteNotConfirmed extends Error {
  readonly reason: 'confirmation-missing' | 'confirmation-mismatch';
  constructor(reason: SocialDeleteNotConfirmed['reason'], detail: string) {
    super(`social_delete_not_confirmed:${reason}: ${detail}`);
    this.name = 'SocialDeleteNotConfirmed';
    this.reason = reason;
  }
}

/**
 * Check a caller's confirmation against the post as it stands NOW.
 *
 * Exported so the rail is directly testable: the property is "this token could
 * only have come from this post", and a function whose inputs are just the
 * document and the claim makes that checkable rather than merely asserted.
 */
export function assertDeleteConfirmed(
  doc: CanonicalDocument,
  ref: SocialPostRef,
  confirmToken: string | null | undefined,
): string {
  const expected = socialDeleteToken(ref, doc.text);
  const supplied = String(confirmToken ?? '').trim();
  if (!supplied) {
    throw new SocialDeleteNotConfirmed(
      'confirmation-missing',
      'delete is irreversible, so it requires the confirmation token returned by social:read for THIS post',
    );
  }
  if (supplied !== expected) {
    // The detail deliberately does NOT echo the expected token: handing it back
    // on a mismatch would turn the rail into a two-call oracle that confirms
    // any post without reading it.
    throw new SocialDeleteNotConfirmed(
      'confirmation-mismatch',
      'the confirmation does not match this post — it belongs to a different post, or the post changed since you read it; re-read it and confirm against what is actually there',
    );
  }
  return expected;
}

/* -------------------------------------------------------------------------- */
/* social:delete                                                              */
/* -------------------------------------------------------------------------- */

export interface SocialDeleteEcho {
  platform: SocialPlatformId;
  postId: string;
  /** Bounded preview of what is about to be destroyed, from the stored row. */
  preview: string;
  author: string;
  occurredAt: string | null;
  idempotencyKey: string;
}

export interface SocialDeleteResult {
  echo: SocialDeleteEcho;
  deleted: boolean;
  detail?: string;
}

const PREVIEW_CHARS = 240;

/**
 * `social:delete` — retract one post the owner already has.
 *
 * THE ORDERING BELOW IS THE SECURITY CONTENT, exactly as in
 * `postToCanonicalSocialDestination`: every gate can be individually present
 * and the verb still be unsafe if they run in the wrong order.
 *
 *  1. PARSE. An unknown or unverified platform fails with the registry's own
 *     reason before any vault or credential work happens.
 *  2. RESOLVE from the owner's vault. This is also the ONLY authorization that
 *     matters for the target: `resolveSocialPost` is scoped to
 *     (workspace, user), so this verb can only ever reach the owner's own
 *     posts. A guessed id belonging to someone else is not refused — it is
 *     simply not found, which is the stronger property.
 *  3. CONFIRM against the resolved row, BEFORE the credential is resolved. An
 *     unconfirmed delete must never reach a code path holding the owner's
 *     identity, for the same reason rail 2 refuses an injected destination
 *     before credential lookup.
 *  4. REGISTRY WRITE GATE for `delete` SPECIFICALLY. `write.verbs` is
 *     per-platform and several platforms declare reply/post without delete, so
 *     this is a real refusal rather than a formality — and it must precede the
 *     adapter lookup, because having written an adapter is not evidence that we
 *     know how to call the API correctly.
 *  5. ADAPTER. A missing one is reported as an adapter gap, distinct from a
 *     platform that cannot delete at all.
 */
export async function deleteCanonicalSocialPost(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    postId: string | SocialPostRef;
    confirmToken: string | null | undefined;
  },
): Promise<SocialDeleteResult> {
  const ref = typeof params.postId === 'string' ? parseSocialPostRef(params.postId) : params.postId;

  const resolved = await resolveSocialPost(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    ref,
  });

  assertDeleteConfirmed(resolved.doc, resolved.ref, params.confirmToken);

  assertSocialWriteAllowed(resolved.ref.platform, 'delete');

  const adapter = getSocialWriteAdapter(resolved.ref.platform);
  if (!adapter?.delete) {
    throw new Error(
      `social_delete_adapter_missing:${resolved.ref.platform} — the platform declares delete but no adapter implements it yet`,
    );
  }

  // Reuse the reply coordinate derivation: deleting needs the same
  // platform-native handle for the post that replying to it does, and a second
  // derivation would be a second copy of per-platform knowledge that could
  // drift into deleting the wrong object.
  const coordinates = resolveSocialReplyCoordinates(resolved.doc);
  const { context } = await resolveSocialOutboundContext(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    platform: resolved.ref.platform,
    verb: 'delete',
  });

  const idempotencyKey = socialDeleteIdempotencyKey(resolved.ref);
  const echo: SocialDeleteEcho = {
    platform: resolved.ref.platform,
    postId: formatSocialPostRef(resolved.ref),
    preview: resolved.doc.text.slice(0, PREVIEW_CHARS),
    author: resolved.doc.participants[0] ?? '',
    occurredAt: resolved.doc.occurredAt,
    idempotencyKey,
  };

  const outcome: SocialDeleteOutcome = await adapter.delete(
    { ref: resolved.ref, target: coordinates.target, idempotencyKey },
    context,
  );

  // `deleted:false` is carried through as-is rather than raised or smoothed
  // into success. "Nothing was there to delete" is a different fact from "I
  // deleted it", and only the adapter can tell them apart.
  return { echo, deleted: outcome.deleted, detail: outcome.detail };
}
