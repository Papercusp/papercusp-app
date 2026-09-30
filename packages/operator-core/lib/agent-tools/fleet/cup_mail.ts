/**
 * fleet:cup_mail — read one bee's coord INBOX + OUTBOX by ownerId
 * (pui-bee-dossier-pane-2026-06-06).
 *
 * The bee-dossier dock pane's bottom half: UPPER = messages addressed TO the
 * bee (inbox), LOWER = messages FROM the bee (outbox). Unlike coord:inbox (which
 * reads the CALLER's own inbox via ctx identity), this reads an ARBITRARY bee's
 * mail by ownerId — the dock's bee pane is not that bee, it's an observer.
 *
 * Read-only over the coord message log; no heartbeat side effect (we're not the
 * bee). Each side is capped + newest-last (ascending by ts, like coord:inbox).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_READ_ROLES } from '../coordination/roles';
import { readInboxWindow, readOutboxWindow } from '../coordination/messages';

const DEFAULT_LIMIT = 50;

export default defineTool({
  name: 'fleet:cup_mail',
  profile: 'engineer',
  description:
    "Read one cup's coordination mail by ownerId: its INBOX (messages addressed to it, or broadcast) and its OUTBOX (messages it sent). The observer view behind the bee-dossier dock pane — distinct from coord:inbox, which reads YOUR own inbox. Read-only; no heartbeat. Each side reads a bounded newest-first window: `exhausted:false` means older mail exists beyond it, so treat that side's `total` as a floor, not a census.",
  guidance: {
    when: 'Rendering the cup-dossier pane, or inspecting what a specific cup has received/sent without being that cup.',
    notWhen:
      'Reading YOUR own inbox (use coord:inbox — it also heartbeats your presence). Deriving fleet state / who is on what (use fleet:assignments).',
    chaining:
      'fleet:selected_cup {} (poll the selection) → fleet:cup_mail { owner_id } + fleet:assignments { agent: owner_id } for the full dossier.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_READ_ROLES],
  args: z.object({
    owner_id: z
      .string()
      .min(1)
      .max(200)
      .describe("The cup's ownerId (from fleet:assignments / the swarm roster)."),
    since_ts: z
      .string()
      .optional()
      .describe('Only entries strictly later than this ISO timestamp (both sides).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(`Max entries per side, most-recent kept. Default ${DEFAULT_LIMIT}.`),
  }),
  async handler(args) {
    const limit = args.limit ?? DEFAULT_LIMIT;
    // EI-19340198432470691: bound BOTH sides instead of reading all history to
    // then throw >99% of it away. This is the DENSE case the window was built
    // for — `tail` is a pure slice with no selective predicate above it, so the
    // stopping rule is the raw count and the first page satisfies it. (Contrast
    // the SPARSE case in workspace fact `bounded-inbox-window-only-helps-dense-
    // filters`, where a caller's own filters reject most of a page and paging to
    // find `limit` survivors costs MORE than the single capped read.)
    //
    // The *Window forms, not `readInbox(…, window)`, because that shape returns
    // only `entries` — and a bounded read that reports a COUNT must also report
    // whether it reached the end (see `exhausted` in the response below).
    const enough = (entries: unknown[]) => entries.length >= limit;
    const [inboxWin, outboxWin] = await Promise.all([
      readInboxWindow(args.owner_id, { since_ts: args.since_ts }, enough),
      readOutboxWindow(args.owner_id, { since_ts: args.since_ts }, enough),
    ]);
    // Both readers return ascending by (ts, msg_id); keep the most-recent `limit`.
    // Sound under a bounded read because the pager walks NEWEST-first, so the
    // window is a suffix of history — never an arbitrary middle slice.
    const tail = <T>(arr: T[]) => (arr.length > limit ? arr.slice(arr.length - limit) : arr);
    const inbox = tail(inboxWin.entries);
    const outbox = tail(outboxWin.entries);

    // `total` counts what this read SAW, which `exhausted` makes interpretable:
    // exhausted ⇒ the window reached the end of this owner's history, so `total`
    // IS the true total; !exhausted ⇒ older matching mail exists beyond it.
    //
    // ⚠ This is not a regression introduced by bounding — `total` was NEVER
    // whole-history. readInbox/readOutbox each cap at 25,000 rows (…_FAST_PATH_
    // ROW_CAP, ORDER BY id DESC), so the old `total` was already "rows within a
    // much larger window" with NO machine-readable boundary at all; the cap only
    // console.warn'd, where no tool caller can see it. Narrowing the window and
    // reporting its edge is strictly more honest than a wide silent one.
    //
    // Named `exhausted` (the window plumbing's own term) rather than `truncated`
    // deliberately: sibling tool coord:inbox already exports `truncated` as a
    // COUNT of entries dropped by its limit slice, so reusing that word here for
    // a boolean about history depth would collide on meaning.
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            owner_id: args.owner_id,
            inbox: {
              total: inboxWin.entries.length,
              returned: inbox.length,
              exhausted: inboxWin.exhausted,
              entries: inbox,
            },
            outbox: {
              total: outboxWin.entries.length,
              returned: outbox.length,
              exhausted: outboxWin.exhausted,
              entries: outbox,
            },
          }),
        },
      ],
    };
  },
});
