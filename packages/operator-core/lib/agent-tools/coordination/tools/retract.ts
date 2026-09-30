/**
 * coord:retract — withdraw a sent coord message (coord-authority-hardening-
 * 2026-07-11 P-011 / WI-4176, H5c).
 *
 * The append-only log cannot unsend a row; retraction is a NOTICE row
 * addressed to the ORIGINALLY-DELIVERED audience carrying the retracted
 * msg_id on RETRACTS_FIELD (see ../retraction.ts for the model + the
 * suppression fold every read surface applies). The notice does triple duty:
 * durable retracted-mark, visible "disregard that" delivery, idempotency
 * marker.
 *
 * INVOKER GUARD (v1): the original sender, THEIR fleet's current leader, a
 * system-authority pane, or the owner (su pane — the owner-proxy rule).
 * Everyone else is refused with nothing written.
 *
 * ⚠ The system-authority arm is `classifyRetractInvoker`'s `'queen'` return, and
 * that literal is a LIVE wire value — do NOT "clean it up" as tier residue.
 * `classifyAgentPane` maps the presence role `overwatch`/`kettle` to pane kind
 * `'kettle'` (overwatch/liveness.ts pins `OVERWATCH_ROLE = 'kettle'`), so a live
 * Overwatch session reaches this arm today. Only the AGENT-FACING prose was
 * corrected here (WI-1726926): it named a retired executor as the current
 * authority, which is a different defect from the identifier the code keys on.
 *
 * THE NOTICE IS SENT FROM A SYSTEM PRINCIPAL, deliberately: (a) v1 records no
 * who-acted (per the plan item) — the guard gates the act, the ledger stays
 * lean; (b) it sidesteps the H5a audience⊆authority seam for the one
 * legitimate case where a fleet-scoped invoker must reach a hive-wide
 * audience — retracting a '*' blast (the EI-9501 cleanup!) — without lying
 * about authority: a retraction is platform-mediated cleanup, not a control
 * cue; (c) the 'system' prefix keeps the notice itself exempt from the H5b
 * allHive detector.
 */

import { z } from 'zod';
import { defineTool, classifyAgentPane } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, type AgentIdentity } from '../identity';
import { getMessageById, sendMessage } from '../messages';
import { getPresence } from '../presence';
import { fetchPresenceFleet } from '../presence-fleet';
import { hostAudienceResolvers } from '../audience-host';
import { wakeRecipients } from '../inbox-wake';
import { coordLog, coordSql, coordWorkspaceId, coordHasPgFastPath } from '../log';
import { COORD_ROLES } from '../roles';
import {
  RETRACTS_FIELD,
  classifyRetractInvoker,
  readRetractionTarget,
  type RetractInvoker,
} from '../retraction';

/** The system principal the retraction notice is written as (see module
 *  docstring for why it is not the invoker). */
export const RETRACT_NOTICE_OWNER = 'system:coord-retract';

const RETRACT_IDENTITY: AgentIdentity = {
  ownerId: RETRACT_NOTICE_OWNER,
  ownerLabel: 'system · coord-retract',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** One-line clamp for the retracted summary quoted in the notice. */
function clampSummary(s: string | undefined, max = 140): string {
  if (!s) return '(no summary)';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/**
 * Find an existing retraction notice targeting `msgId` (the idempotency
 * check). PG fast path scans the messages surface for the RETRACTS_FIELD
 * stamp (rare call — coord:retract is human-scale — so no dedicated index);
 * the seam read is for test/fs backends only — on PG a query error PROPAGATES
 * (host-memory-reduction-2026-09-27 D-011). Returns the notice's `from`+`ts`,
 * or null.
 */
async function findExistingRetraction(
  msgId: string,
): Promise<{ from: string; ts: string } | null> {
  if (coordHasPgFastPath()) {
    const sql = coordSql();
    const rows = await sql<{ body: unknown }[]>`
      SELECT body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         AND body->>${RETRACTS_FIELD} = ${msgId}
       LIMIT 1
    `;
    if (rows.length) {
      const env = (typeof rows[0].body === 'string' ? JSON.parse(rows[0].body) : rows[0].body) as {
        from?: string;
        ts?: string;
      };
      return { from: env.from ?? RETRACT_NOTICE_OWNER, ts: env.ts ?? '' };
    }
    return null;
  }
  const lines = await coordLog.readLines('messages');
  const hit = lines.find((l) => readRetractionTarget(l) === msgId);
  return hit ? { from: hit.from, ts: hit.ts } : null;
}

export default defineTool({
  name: 'coord:retract',
  description:
    'Withdraw a coord message you are authorized over: marks it retracted (a durable retraction-notice row — the log is append-only) and delivers the notice to the ORIGINALLY-DELIVERED audience so every recipient sees "disregard that". Read surfaces (coord:inbox, the [coord+N] injection, coord:feed, coord:catch-up, orient folds) then SUPPRESS the retracted message; coord:thread deliberately keeps both (forensics). Invoker must be the original sender, THEIR fleet\'s current leader, an Overwatch (system-authority) pane, or the owner. Idempotent — retracting an already-retracted message reports alreadyRetracted without a duplicate notice. Pass wake:true to also re-invoke sleeping concrete recipients so they see the retraction NOW (a broadcast audience cannot be woken). v1 records no who-retracted ledger.',
  guidance: {
    when:
      'A sent message is wrong/dangerous and recipients must disregard it — a mistaken directive, a leaked-scope broadcast (the EI-9501 cleanup), superseded instructions.',
    notWhen:
      'To CORRECT a message, just send a follow-up reply (related_msg_id) — retraction hides the original from every feed, which is heavier than most corrections need. Not an edit tool; the original text stays in the log (coord:thread) for forensics.',
    seeAlso: [
      'coord:send { related_msg_id } (a correction/follow-up that keeps the original visible)',
      'coord:thread (forensic view — shows a retracted original + its notice)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    msg_id: z.string().min(1).describe('The msg_id of the message to retract (from your outbox/inbox/feed line).'),
    reason: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Why it is retracted — travels verbatim on the notice so recipients know what to disregard and why.'),
    wake: z
      .boolean()
      .optional()
      .describe('Also wake sleeping CONCRETE recipients of the original now (default false — the notice lands in inboxes either way). A broadcast (*) audience cannot be woken.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);

    const original = await getMessageById(args.msg_id);
    if (!original) {
      return json({ ok: false, error: 'message_not_found', message: `no coord message '${args.msg_id}' — pass the msg_id from your inbox/feed line` }, true);
    }
    if (readRetractionTarget(original)) {
      return json({ ok: false, error: 'cannot_retract_retraction', message: 'that message IS a retraction notice — retracting it would silently un-warn its audience' }, true);
    }

    // Idempotency BEFORE the guard: an already-retracted message reports the
    // fact to anyone (harmless read), with no duplicate notice.
    const existing = await findExistingRetraction(args.msg_id);
    if (existing) {
      return json({ ok: true, msg_id: args.msg_id, alreadyRetracted: true, retractedAt: existing.ts || undefined });
    }

    // Invoker guard — sender / THEIR leader / queen / owner (../retraction.ts).
    // IO inputs resolved fail-soft: a presence hiccup only narrows which arms
    // can match, never throws.
    const senderOwnerId = typeof original.from === 'string' ? original.from : '';
    let paneKind: ReturnType<typeof classifyAgentPane>['kind'] | null = null;
    try {
      const pres = await getPresence(identity.ownerId).catch(() => null);
      paneKind = classifyAgentPane({ role: pres?.agentRole ?? null, ownerId: identity.ownerId }).kind;
    } catch {
      paneKind = classifyAgentPane({ role: null, ownerId: identity.ownerId }).kind;
    }
    let senderFleetLeaders: string[] = [];
    if (identity.ownerId !== senderOwnerId) {
      try {
        const senderFleet = (await fetchPresenceFleet([senderOwnerId])).get(senderOwnerId)?.fleetSlug;
        if (senderFleet) senderFleetLeaders = await hostAudienceResolvers.listFleetLeader(senderFleet);
      } catch {
        senderFleetLeaders = [];
      }
    }
    const invokedAs: RetractInvoker | null = classifyRetractInvoker({
      callerOwnerId: identity.ownerId,
      senderOwnerId,
      senderFleetLeaders,
      paneKind,
    });
    if (!invokedAs) {
      return json(
        {
          ok: false,
          error: 'not_authorized',
          message:
            `coord:retract on ${args.msg_id} refused: only the original sender (${senderOwnerId || 'unknown'}), ` +
            `their fleet leader, an Overwatch (system-authority) pane, or the owner may retract a message (H5c, the EI-9501 hardening family). ` +
            'Nothing was retracted.',
        },
        true,
      );
    }

    // The notice: to the ORIGINALLY-DELIVERED audience, from the system
    // principal, carrying the marker fields. related_msg_id threads it to the
    // original (coord:thread shows both).
    const audience = Array.isArray(original.to) && original.to.length ? original.to : [senderOwnerId];
    const notice = await sendMessage(RETRACT_IDENTITY, {
      to: audience,
      summary: `⛔ RETRACTED: "${clampSummary(original.summary)}" (${args.msg_id})${args.reason ? ` — ${args.reason}` : ''}`,
      body:
        `The message ${args.msg_id} from ${senderOwnerId}${original.ts ? ` (sent ${original.ts})` : ''} has been ` +
        `RETRACTED — disregard it${args.reason ? `: ${args.reason}` : '.'} ` +
        'It is suppressed from inbox/feed/catch-up reads from now on; the original text remains visible only in the ' +
        'forensic thread view (coord:thread).',
      plan_slug: typeof original.plan_slug === 'string' ? original.plan_slug : undefined,
      related_msg_id: args.msg_id,
      extra: { [RETRACTS_FIELD]: args.msg_id },
    });

    // Optional wake: concrete ownerIds only — '*'/'human'/selectors are not
    // wakeable targets; the inbox delivery already covers them. Fail-soft.
    let woken: number | undefined;
    if (args.wake) {
      const concrete = audience.filter((t) => t !== '*' && t !== 'human' && !t.startsWith('@'));
      if (concrete.length) {
        try {
          const r = await wakeRecipients(concrete, {
            summary: `retraction of ${args.msg_id}: disregard it`,
            source: RETRACT_NOTICE_OWNER,
            workspaceId: identity.workspaceId ?? undefined,
          });
          woken = (r as { woken?: number }).woken ?? 0;
        } catch {
          woken = 0;
        }
      } else {
        woken = 0;
      }
    }

    return json({
      ok: true,
      msg_id: args.msg_id,
      retracted: true,
      invokedAs,
      notice_msg_id: notice.msg_id,
      audience,
      ...(woken !== undefined ? { woken } : {}),
    });
  },
});

function json(payload: unknown, isError = false) {
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  };
}
