/**
 * coord:catch-up — pull the message HISTORY for an audience you belong to.
 *
 * The audience-keyed, member-scoped read counterpart to a fleet/topic broadcast
 * (fleet-broadcast-audience-history-integration-2026-06-30). Broadcasts are NOT
 * auto-polled, and `expandAudience` resolves a selector to the concrete ownerIds
 * live AT SEND TIME — so an agent that joins a fleet/topic later, or wakes after
 * being paused, has no way to see what was said to it via coord:inbox (its id was
 * never in the frozen `to`). This tool reads everything ever addressed to an
 * audience via the preserved `audience` key (D-003), so a late/returning member
 * catches up.
 *
 * GATE (D-006): low-tier `coord:read` — NOT the firehose `audit:read` that the
 * unscoped coord:feed carries — but the caller MUST currently BELONG to the
 * audience (a live fleet member / topic subscriber, or a `*` broadcast audience).
 * Membership is checked by resolving the audience's CURRENT members via the same
 * hostAudienceResolvers the send path uses and confirming the caller is among
 * them. "You can only catch up on a channel you're in."
 *
 * Bounds (D-005): a fleet may be paused for a week, so a time window is the wrong
 * knob — this takes `limit` (last N messages) and/or `token_budget` (as much as
 * fits in ~N tokens), newest-first, stopping at whichever is hit first; paginate
 * older with the returned next_cursor / next_cursor_msg_id pair
 * (before_ts / before_msg_id).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { expandAudience } from '../audience';
import { hostAudienceResolvers, canonicalizeAudienceSelector } from '../audience-host';
import { fetchPresenceFleet } from '../presence-fleet';
import { readCoordFeed, MAX_FEED_LIMIT } from '../feed';
import { COORD_ROLES } from '../roles';
import { boundRowField } from '../../_bound-output';
import { authoredFieldsMarker } from '../message-fields';

const CATCHUP_DEFAULT_LIMIT = 50;
const BODY_CAP = 200;
const BODY_BUDGET = 8_000;
const SUMMARY_CAP = 400;
const SUMMARY_BUDGET = 10_000;

export default defineTool({
  name: 'coord:catch-up',
  description:
    "Catch up on the message HISTORY for an audience you belong to — everything broadcast to a @fleet:<slug> / @topic:<slug> (or @plan:/@object:/@file:/*) you're a member of, newest-first. This is how you get the backlog after JOINING a fleet/topic or WAKING from a pause: broadcasts are not auto-polled, and your inbox only shows messages whose recipient list named you at send time. Bound the read by `limit` (last N messages) and/or `token_budget` (as much as fits in ~N tokens); paginate older by passing `next_cursor` / `next_cursor_msg_id` back as `before_ts` / `before_msg_id`. Returns { audience, count, total, tokens, next_cursor, next_cursor_msg_id, rows }. A row carrying `superseded_by` was CORRECTED by its own sender — read that correction (the msg_id it points to) before acting on the row. You must currently belong to the audience (low-tier, membership-checked) — use coord:feed for the unscoped, high-tier firehose.",
  guidance: {
    when:
      'You just joined a fleet/topic, or woke after being paused/offline, and want what was said to that audience while you were away. The pull counterpart to an @fleet:/@topic: broadcast.',
    notWhen:
      'For messages addressed to YOU personally use coord:inbox; for the all-agent firehose use coord:feed (audit:read). This is scoped to ONE audience you belong to.',
    seeAlso: [
      'coord:inbox (messages addressed to you personally)',
      'coord:roster { view:"history" } (who-was-ever-here for this audience)',
      'coord:feed (the all-agent firehose)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  // EI-20226779878046151: catch-up resolves membership/feed storage itself and
  // never reads ctx.tx. Do not hold the orient caller's ambient transaction
  // across the audience-history read.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    audience: z
      .string()
      .min(1)
      .describe('The audience selector to catch up on, e.g. @fleet:backend, @topic:federation, @plan:my-plan, or * (broadcast). Fleet names are slugified to match how they were stored.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_FEED_LIMIT)
      .optional()
      .describe(`Max messages (newest kept). Default ${CATCHUP_DEFAULT_LIMIT}, max ${MAX_FEED_LIMIT}. Paginate older with before_ts/next_cursor.`),
    token_budget: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Accumulate messages newest-first until ~this many tokens, then stop (≥1 always returned). The "as much history as fits in my context" knob — right for a long backlog. Composes with limit: stops at whichever is hit first.'),
    since_ts: z.string().optional().describe('Only messages strictly later than this ISO timestamp.'),
    before_ts: z
      .string()
      .optional()
      .describe('Timestamp half of the pagination cursor; pass back next_cursor together with next_cursor_msg_id for the next older page.'),
    before_msg_id: z
      .string()
      .optional()
      .describe('Message-id tie-breaker for before_ts; pass back next_cursor_msg_id so same-timestamp siblings are neither dropped nor repeated.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const audience = canonicalizeAudienceSelector(args.audience);

    // Membership gate (D-006): resolve the audience's CURRENT members via the same
    // resolvers the send path uses, and confirm the caller is among them — or it's a
    // '*' broadcast audience (anyone may catch up on what reached everyone). A plain
    // (non-@, non-*) value isn't an audience and is rejected.
    if (audience !== '*' && !audience.startsWith('@')) {
      return errorResult(`'${args.audience}' is not an audience selector (expected @fleet:/@topic:/@plan:/@object:/@file: or *).`);
    }
    if (audience !== '*') {
      const allowed = await callerBelongsTo(audience, identity.ownerId);
      if (!allowed) {
        return errorResult(`Not a member of ${audience} — you can only catch up on an audience you currently belong to.`);
      }
    }

    const { rows, nextCursor, nextCursorMsgId, total, tokens } = await readCoordFeed({
      audience,
      kinds: ['message', 'notify'],
      limit: args.limit ?? CATCHUP_DEFAULT_LIMIT,
      token_budget: args.token_budget,
      since_ts: args.since_ts,
      before_ts: args.before_ts,
      before_msg_id: args.before_msg_id,
    });

    let boundedRows = boundRowField(rows, 'body', BODY_CAP, BODY_BUDGET);
    boundedRows = boundRowField(boundedRows, 'summary', SUMMARY_CAP, SUMMARY_BUDGET);
    // P-033 (e): mark which rows carry AUTHORED structure. Catch-up is read precisely
    // when you were ABSENT for the conversation, so "this message rested on premises /
    // named a question it could not settle" is the signal most worth not losing — but
    // the rows are budget-bound (a fleet may have been paused a week), so this is the
    // compact marker; `coord:read <msg_id>` shows it in full.
    boundedRows = boundedRows.map((row) => {
      const authored = authoredFieldsMarker(row);
      return authored ? { ...row, authored } : row;
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            audience,
            count: boundedRows.length,
            total,
            tokens,
            next_cursor: nextCursor,
            next_cursor_msg_id: nextCursorMsgId,
            rows: boundedRows,
          }),
        },
      ],
    };
  },
});

/**
 * Does `ownerId` belong to `audience` (already canonicalized)? For FLEET audiences,
 * check MEMBERSHIP directly via the coord_presence.fleet_slug label — NOT the delivery
 * audience (listFleetMembers) — so a member who MUTED the fleet can still catch up on
 * its history. For topic/plan/object audiences, the current subscriber/presence set is
 * the right membership signal. `*` is handled by the caller (always allowed).
 */
async function callerBelongsTo(audience: string, ownerId: string): Promise<boolean> {
  for (const prefix of ['@fleet-leader:', '@fleet:']) {
    if (audience.startsWith(prefix)) {
      const slug = audience.slice(prefix.length);
      const membership = await fetchPresenceFleet([ownerId]);
      if (membership.get(ownerId)?.fleetSlug === slug) return true;
      // Multi-fleet leadership: the presence label holds only ONE fleet slug
      // (mig 407), so the leader of a second fleet fails the label check for
      // their older fleet. The durable registry is the authority on
      // leadership — a fleet's registry leader always belongs to it.
      const leaders = await hostAudienceResolvers.listFleetLeader(slug);
      return leaders.includes(ownerId);
    }
  }
  const members = await expandAudience([audience], hostAudienceResolvers, 'scoped');
  return members.includes('*') || members.includes(ownerId);
}

function errorResult(message: string) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
  };
}
