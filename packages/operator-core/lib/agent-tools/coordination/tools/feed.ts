/**
 * coord:feed — the WHOLE coordination firehose, read across every channel.
 *
 * Unlike coord:inbox (one owner) / coord:escalations (one channel), this is the
 * complete observer stream: every envelope every agent has exchanged — messages,
 * acks, notifies, broadcasts, handoffs + acceptances, escalations + resolutions,
 * plan events — folded chronological (newest-first) with a next-page cursor.
 *
 * It exposes ALL agents' traffic, so it is gated `audit:read` (high-tier) — the
 * same trust boundary as `audit:list`, NOT the low-tier `coord:read` the
 * per-owner readers use. Read-only.
 *
 * Backs the /adv Conversations "Feed" view (also reachable directly here for
 * diagnostics / forensic timelines).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../roles';
import {
  readCoordFeed,
  ALL_COORD_KINDS,
  MAX_FEED_LIMIT,
} from '../feed';
import { fleetSlugFromName } from '../../../agent-fleets-store';
import { boundRowField } from '../../_bound-output';
import { authoredFieldsMarker } from '../message-fields';

// EI-1597: the agent-facing default is lower than the UI's DEFAULT_FEED_LIMIT (100)
// because each feed row is a full envelope (body + summary + metadata) — at 100 rows
// the metadata floor alone threatens the agent result cap. 30 recent rows + the
// before_ts cursor is a safe, paginatable default; per-row body/summary are excerpted
// on top. An explicit higher `limit` still works (bodies stay excerpted) — paginate
// with the cursor for a deep timeline.
const AGENT_FEED_DEFAULT = 30;
const FEED_BODY_CAP = 200;
const FEED_BODY_BUDGET = 8_000;
const FEED_SUMMARY_CAP = 400;
const FEED_SUMMARY_BUDGET = 10_000;
const ISO_TIMESTAMP = z.string().datetime({ offset: true });

export default defineTool({
  name: 'coord:feed',
  description:
    'Read the COMPLETE coordination stream across every agent and channel — messages, acks, notifies, broadcasts, handoffs, escalations, resolutions, plan events — newest-first with a next-page cursor. Filter by kinds, owner (matches sender OR recipient; broadcasts match any owner), plan_slug, fleet (legacy alias for audience `@fleet:<slug>`), free-text `q` (over summary/body/from/to), and a since/before time window. `since` is the preferred timestamp filter; legacy `since_ts` remains accepted. Paginate by passing back both `next_cursor` / `next_cursor_msg_id` as `before_ts` / `before_msg_id`; the message id prevents loss at same-timestamp page boundaries. Returns `{ count, total, by_kind, next_cursor, next_cursor_msg_id, rows }`; each row is the raw envelope plus `surface` (messages|escalations|handoffs|plan-events) and a derived `broadcast` flag. A row carrying `superseded_by` was CORRECTED by its own sender — follow that msg_id to the current claim before acting on the row.',
  guidance: {
    when:
      'You need the full fleet-wide coordination timeline — auditing what agents said to each other, tracing a broadcast/handoff/escalation chain, or backing an observer UI. The all-traffic counterpart to the per-owner coord:inbox.',
    notWhen:
      'For YOUR addressed messages use coord:inbox; for open human escalations use coord:escalations; for live "who is active" use coord:presence. coord:feed is the read-everything firehose, not a working inbox.',
    // EI-22057308172107761: these are deliberately coord:inbox-only VIEW-shaping
    // controls. Keep the redirect on the failure path instead of expanding this
    // tool's prompt-weight-capped description or accepting args the firehose
    // cannot honor.
    argRedirects: {
      // EI-21830525619029268. This tool declares a `before_ts` / `before_msg_id` upper
      // bound but names its lower bound `since`, so a caller who has just read the
      // `before_*` pair reaches for the symmetric `after` — a reasonable inference from
      // this tool's OWN arg names, not a guess imported from another API. The rejection
      // could only list accepted keys, and `since` does not look like the counterpart of
      // `before_ts` unless you already know it is.
      //
      // Local target (`since — …`) per D-004 of tool-contract-repair-2026-09-05: a bare
      // prose target misrenders as "written by <the sentence>", i.e. it sends a caller
      // who is on the right tool somewhere else.
      after:
        'since — the lower (older) time bound is spelled `since` here, even though the UPPER bound is the symmetric-looking `before_ts` / `before_msg_id` pair; RENAME the key rather than dropping it, or the window silently widens to the whole retained stream. Legacy `since_ts` is also accepted.',
      include_ambient: {
        tool: 'coord:inbox',
        args: { include_ambient: true },
        note: 'coord:feed does not accept inbox VIEW shaping controls; use coord:inbox { include_ambient: true } to include ambient system broadcasts.',
      },
      includeAmbient: {
        tool: 'coord:inbox',
        args: { includeAmbient: true },
        note: 'coord:feed does not accept inbox VIEW shaping controls; use coord:inbox { includeAmbient: true } (compatibility alias) to include ambient system broadcasts.',
      },
      include_intents: {
        tool: 'coord:inbox',
        args: { include_intents: true },
        note: 'coord:feed does not accept inbox VIEW shaping controls; use coord:inbox { include_intents: true } to include auto intent-declare messages.',
      },
      max_body_chars: {
        tool: 'coord:inbox',
        args: { max_body_chars: 200 },
        note: 'coord:feed does not accept inbox VIEW shaping controls; use coord:inbox { max_body_chars } to bound entry body, summary, and section text.',
      },
    },
  },
  // High-tier: this surfaces every agent's traffic — same trust boundary as
  // audit:list (a forensic, all-actor read), NOT the low-tier coord:read the
  // per-owner inbox/outbox readers use.
  capability: 'audit:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    kinds: z
      .array(z.enum(ALL_COORD_KINDS))
      .optional()
      .describe('Restrict to these envelope kinds. Omitted = every kind.'),
    owner: z
      .string()
      .optional()
      .describe('An ownerId. Matches envelopes where this owner is the sender OR a recipient; broadcasts match any owner.'),
    from: z
      .string()
      .optional()
      .describe('Match the SENDER only (from === this ownerId). Unlike `owner`, does NOT match recipients and does NOT let broadcasts through — the precise "only what agent X SENT" filter (e.g. verify your own coord:send landed, or read one peer\'s messages).'),
    plan_slug: z.string().optional().describe('Restrict to one plan slug.'),
    audience: z
      .string()
      .optional()
      .describe('Restrict to envelopes addressed to this audience selector (@fleet:<slug> / @topic:<slug> / @plan:<slug> / @object:… / @file:… / *) — the audience-keyed HISTORY read. Catches up on everything sent to a fleet/topic even though your id was never in the resolved recipient list. (Members use coord:catch-up for the low-tier, membership-checked version.)'),
    fleet: z
      .string()
      .min(1)
      .optional()
      .describe('Compatibility alias for audience: a fleet slug or human name, normalized to @fleet:<slug>. If both fleet and audience are supplied, audience wins.'),
    q: z.string().optional().describe('Case-insensitive substring over summary/body/from/to/plan_slug.'),
    since: ISO_TIMESTAMP
      .optional()
      .describe('Preferred strictly-later-than ISO timestamp (older bound). Use this instead of legacy since_ts.'),
    since_ts: ISO_TIMESTAMP.optional().describe('Strictly later than this ISO timestamp (older bound).'),
    before_ts: ISO_TIMESTAMP
      .optional()
      .describe('Timestamp half of the pagination cursor; pass back the returned next_cursor together with next_cursor_msg_id.'),
    before_msg_id: z
      .string()
      .optional()
      .describe('Message-id tie-breaker for before_ts; pass back next_cursor_msg_id so same-timestamp siblings are neither dropped nor repeated.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_FEED_LIMIT)
      .optional()
      .describe(`Max rows (newest kept). Agent default ${AGENT_FEED_DEFAULT} (kept small because each row is a full envelope), max ${MAX_FEED_LIMIT}. Per-row body/summary are excerpted (body_truncated/_full_chars); paginate with before_ts/next_cursor for more.`),
    token_budget: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Accumulate rows newest-first until ~this many tokens, then stop (≥1 row always returned). The "as much history as fits in my context" knob — useful for a long backlog where a row count is hard to guess. Composes with limit: stops at whichever is hit first.'),
    include_retracted: z
      .boolean()
      .optional()
      .describe('Also show messages withdrawn via coord:retract (default false — retracted messages are suppressed from the feed; the retraction notice itself is always visible). The forensic/audit escape hatch; coord:thread shows both without a flag.'),
  }),
  async handler(args) {
    const { rows, nextCursor, nextCursorMsgId, total, byKind, tokens } = await readCoordFeed({
      kinds: args.kinds,
      owner: args.owner,
      from: args.from,
      plan_slug: args.plan_slug,
      audience: args.audience ?? (args.fleet ? `@fleet:${fleetSlugFromName(args.fleet)}` : undefined),
      q: args.q,
      // Keep the historical snake_case field wire-compatible while making the
      // surrounding coordination API's `since` convention available to callers.
      since_ts: args.since ?? args.since_ts,
      before_ts: args.before_ts,
      before_msg_id: args.before_msg_id,
      limit: args.limit ?? AGENT_FEED_DEFAULT,
      token_budget: args.token_budget,
      includeRetracted: args.include_retracted,
    });
    // EI-1597: excerpt the big per-row text fields so the firehose can't overflow the
    // agent result cap. The q-filter already ran (over full bodies) inside readCoordFeed,
    // so bounding here is display-only; full envelopes via the UI feed or a narrower query.
    let boundedRows = boundRowField(rows, 'body', FEED_BODY_CAP, FEED_BODY_BUDGET);
    boundedRows = boundRowField(boundedRows, 'summary', FEED_SUMMARY_CAP, FEED_SUMMARY_BUDGET);
    // P-033 (e): mark which rows carry AUTHORED structure (premises / forYouBecause /
    // youMayNotKnow / couldNotDetermine / clarify). The compact marker, not the full
    // projection — this is the firehose, whose rows are already excerpted precisely
    // because a full envelope per row threatens the result cap. `coord:read <msg_id>`
    // shows the structure in full. Absent on a row that authored nothing.
    boundedRows = boundedRows.map((row) => {
      const authored = authoredFieldsMarker(row);
      return authored ? { ...row, authored } : row;
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            count: boundedRows.length,
            total,
            tokens,
            by_kind: byKind,
            next_cursor: nextCursor,
            next_cursor_msg_id: nextCursorMsgId,
            rows: boundedRows,
          }),
        },
      ],
    };
  },
});
