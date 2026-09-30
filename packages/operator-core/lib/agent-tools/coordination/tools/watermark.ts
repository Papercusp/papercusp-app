/**
 * coord:watermark — read the caller's last-read pointers.
 *
 * agent-coordination-architecture-v2 §7.2. The OMP turn-start
 * extension calls this, then passes `messages_since_ts` to
 * `coord:inbox` so only genuinely-new entries are surfaced.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { readWatermark } from '../watermarks';

export default defineTool({
  name: 'coord:watermark',
  description:
    "Read a coordination watermark — last-read ISO timestamps for messages / escalations / plan-events + the notify msg_ids surfaced. DEFAULT: your own. Pass `agent` to read a PEER's: their `read_through_ts` (messages_shown_ts) is a READ-RECEIPT — ≥ your message's ts ⇒ they've SEEN it (ping them, don't re-route); behind ⇒ not yet seen (wait, or wake if idle). With `agent`+`sent_ts` you get a direct `seen` boolean.",
  guidance: {
    when: 'Turn start — the OMP coordination extension calls this to scope the inbox to new entries. To check if a PEER has seen a message you sent (READ-RECEIPT, EI-2042): coord:watermark { agent: <their ownerId from coord:presence>, sent_ts: <your message ts> } → seen:true means it was injected into their context.',
    notWhen: 'Routine reads — coord:inbox without a watermark returns the full inbox.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent: z
      .string()
      .optional()
      .describe(
        "Read a PEER's watermark instead of your own (their full ownerId, e.g. from coord:presence). Their `read_through_ts` (messages_shown_ts) is the READ-RECEIPT: ≥ your message's ts ⇒ they've SEEN it.",
      ),
    sent_ts: z
      .string()
      .optional()
      .describe(
        "With `agent`: the ISO ts of the message you sent. The tool returns `seen: <peer read_through_ts ≥ sent_ts>` so you needn't compare timestamps by hand.",
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Default to self; `agent` reads a PEER's read-position (read-only) for a read-receipt (EI-2042).
    const targetOwner = args.agent && args.agent.trim() ? args.agent.trim() : identity.ownerId;
    const wm = await readWatermark(targetOwner);
    const out: Record<string, unknown> = {
      owner_id: targetOwner,
      self: targetOwner === identity.ownerId,
      watermark: wm,
      // The read-receipt cursor — messages SHOWN to this agent (injected into their [coord+N]) up to here.
      read_through_ts: wm.messages_shown_ts,
    };
    // Direct read-receipt answer when the sender passes their message's ts.
    if (args.sent_ts) {
      out.seen = !!wm.messages_shown_ts && wm.messages_shown_ts >= args.sent_ts;
    }
    return { data: out };
  },
});
