/**
 * inbox-reply — deliver an owner-Inbox-authored reply to a LIVE asker, with
 * authoritative turn-provenance (owner-inbox-single-pane-2026-07-17 P-006,
 * D-006/D-007).
 *
 * D-007 (reply routing by liveness): the caller (attention-card.ts) resolves
 * the ask item first (existing per-kind path), then calls
 * `deliverInboxOwnerReply` here. A LIVE asker (coord:presence) gets the reply
 * delivered to their coord inbox AND woken (`wakeRecipients`, mirroring
 * `coord:send { wake:'required' }`). A dead asker gets nothing here —
 * `live:false` tells the caller to fall back to the existing Papercup-discuss
 * path; we never silently drop (the resolve/answer itself already landed via
 * the caller's separate call).
 *
 * D-006 (provenance): an inbox reply is authored by the AUTHENTICATED HUMAN
 * via the admin UI — never a spoofable agent claim — so the delivered wake
 * turn is tagged with the distinguished turn-provenance origin
 * `coord-inject:owner` (see agent-insights/turn-provenance-owner-vs-agent and
 * ../../turn-provenance/turn-provenance.ts). wake-executor's `tagWakeText`
 * reads the `INBOX_OWNER_REPLY_MARKER` payload flag this module stamps on
 * the wake (mirroring the existing loop-fire cold-loop marker pattern) and
 * mints that origin instead of the generic `wake-pump` tag — so the
 * recipient's UserPromptSubmit hook classifies the resumed turn VERIFIED
 * AGENT-ORIGIN(coord-inject:owner), which downstream persona
 * directive-provenance rules (compaction-strategy.md) may treat as a
 * genuine owner directive, unlike an ordinary peer's `coord-inject:<peerId>`.
 *
 * SECURITY: `coord-inject:owner` must NEVER be mintable through the
 * general-purpose, agent-callable `coord:send` MCP tool — any agent could
 * otherwise forge an "owner directive" to a peer (exactly the confusion
 * class the turn-provenance protocol exists to kill). This module is reached
 * ONLY from the admin-UI-only `/api/admin/coord-inbox-reply` route
 * (loopback/verified trust, same posture as `/api/admin/coord/*`) — it is
 * deliberately NOT registered as a defineTool in the agent-tools catalog.
 */

import { listPresence } from './presence';
import { sendMessage } from './messages';
import { wakeRecipients } from './inbox-wake';
import { ADMIN_COORD_UI_OWNER } from './identity';
import type { AgentIdentity } from './identity';
import { ownerMessageDefaults } from './owner-message';

/** Payload marker wake-executor's `tagWakeText` reads to choose the
 *  `coord-inject:owner` turn-provenance origin instead of the generic
 *  wake-pump/loop-fire tag. Exported so wake-executor + tests share ONE
 *  definition (mirrors the cold-loop marker convention in su-cold-loop.ts). */
export const INBOX_OWNER_REPLY_MARKER = 'inboxOwnerReply' as const;

/** True when an events:await delivery payload carries the inbox-owner-reply
 *  marker this module stamps. Pure — safe to call from wake-executor's hot
 *  path with an untyped `unknown` payload. */
export function isInboxOwnerReplyPayload(payload: unknown): boolean {
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>)[INBOX_OWNER_REPLY_MARKER] === true,
  );
}

/** The coord identity an inbox-authored reply is SENT as — the same stable
 *  human-side owner id the admin coord UI already resolves/acks as
 *  (`ADMIN_COORD_UI_OWNER`), so the reply's `from` field is consistent with
 *  every other inbox action. */
function inboxReplyIdentity(workspaceId?: string | null): AgentIdentity {
  return {
    ownerId: ADMIN_COORD_UI_OWNER,
    ownerLabel: 'Owner (Inbox reply)',
    source: 'static-client',
    workspaceId: workspaceId ?? null,
    userId: null,
  };
}

export interface InboxReplyResult {
  /** False when the asker isn't in the live presence roster — the caller
   *  falls back to the Discuss (Papercup) path per D-007. */
  live: boolean;
  /** True once the reply has been durably delivered to the asker's coord
   *  inbox (only set when `live`). */
  delivered: boolean;
  /** How many live watchers the wake fan actually re-invoked (0 is normal
   *  when the asker is live but not currently parked on their inbox-wake
   *  key — the reply still lands, seen on their next natural turn). */
  woken: number;
  msgId?: string;
}

/**
 * Deliver an inbox-authored reply to `askerId`. D-007: only wakes a LIVE
 * asker; a dead one gets `{ live: false, delivered: false, woken: 0 }` and
 * the caller falls back to Discuss. Never throws for a dead/absent asker —
 * only a genuine delivery fault (sendMessage/wakeRecipients erroring) does,
 * which the caller treats as best-effort (the item's own resolve/answer
 * already landed separately).
 */
export async function deliverInboxOwnerReply(input: {
  askerId: string;
  text: string;
  summary: string;
  workspaceId?: string;
  planSlug?: string;
}): Promise<InboxReplyResult> {
  const presence = await listPresence({ workspaceId: input.workspaceId }).catch(() => []);
  const live = presence.some((p) => p.ownerId === input.askerId);
  if (!live) return { live: false, delivered: false, woken: 0 };

  const identity = inboxReplyIdentity(input.workspaceId);
  // P-033 (c): the OTHER owner-authored send path. It calls sendMessage directly
  // — deliberately, so an agent cannot forge this route's `coord-inject:owner`
  // provenance through the agent-callable tool — so it never hit the `expects`
  // break, but it also carried none of the new fields.
  //
  // `expects` is passed EXPLICITLY rather than derived: this is a REPLY to a
  // question the asker already asked, so nothing further is expected back. The
  // wrapper's shape-derivation would read the body and say 'action', which would
  // wrongly park the owner's own answer in `unanswered_directed` forever.
  const ownerFields = ownerMessageDefaults({
    body: input.text,
    expects: 'none',
    forYouBecause: {
      relation: 'other',
      note: 'the owner is answering the question you asked',
    },
  });
  const env = await sendMessage(identity, {
    to: [input.askerId],
    summary: input.summary,
    body: input.text,
    plan_slug: input.planSlug,
    expectsReply: false,
    extra: {
      expects: ownerFields.expects,
      blocking: ownerFields.blocking,
      sections: [{ text: input.text, forYouBecause: ownerFields.forYouBecause }],
      ...(Object.keys(ownerFields.fieldProvenance).length
        ? { fieldProvenance: ownerFields.fieldProvenance }
        : {}),
    },
  });
  const fan = await wakeRecipients([input.askerId], {
    summary: input.summary,
    payload: { [INBOX_OWNER_REPLY_MARKER]: true },
    source: identity.ownerId,
    workspaceId: input.workspaceId,
  });
  return { live: true, delivered: true, woken: fan.woken, msgId: env.msg_id };
}
