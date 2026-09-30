/**
 * orders:disposition — close an open owner directive (EI-11484): done (you
 * carried it out — say how) or declined (you are not doing it — say why). The
 * note is MANDATORY: a disposition without evidence is how an order gets
 * silently dropped with extra steps. Batchable via `items`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_REPLY_ROLES } from '../coordination/roles';
import { dispositionOwnerDirective, type OwnerDirectiveDisposition } from '../../owner-directives';
import { directiveActionVerdict } from '../../owner-directive-agenda';
import { activeWorkspaceId } from '../../workspace-registry';

const entry = z.object({
  id: z.number().int().positive().describe('The directive id (from orders:record / orders:list).'),
  status: z.enum(['done', 'declined']).describe('done = carried out; declined = consciously not doing it.'),
  note: z
    .string()
    // Trimmed first: four spaces is not a reason, and a decline without a real
    // reason is exactly what D-001 forbids.
    .trim()
    .min(4)
    .max(2000)
    .describe('MANDATORY evidence: what was done (with pointers), or why it was declined.'),
});

export default defineTool({
  name: 'orders:disposition',
  profile: 'engineer',
  description:
    'Close an open owner directive: done (carried out) or declined (consciously refused), with a MANDATORY evidence note. Closing stops it rendering above every wake/orient/anchor. Single { id, status, note } or batch via items[].',
  guidance: {
    when:
      'You finished (or consciously declined) a recorded owner directive — close it WITH evidence the moment the completion report goes to the owner. An open directive keeps rendering to you and every workspace peer; a stale-open one erodes the surface.',
    notWhen:
      'Work still in progress (checkpoint the work-item). Never pick the id by matching text — use the "YOUR owner directive #N" your turn carried; identical text is often open in other sessions.',
    chaining: 'orders:list { open: true } → work → orders:disposition. Re-record a re-issued order as a new row.',
    seeAlso: ['orders:record', 'orders:list', 'orders:get'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_REPLY_ROLES],
  args: z
    .object({
      id: entry.shape.id.optional(),
      status: entry.shape.status.optional(),
      note: entry.shape.note.optional(),
      items: z.array(entry).min(1).max(50).optional().describe('Batch form — each { id, status, note }.'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.id != null && a.status != null && a.note != null), {
      message: 'pass { id, status, note } or items:[{ id, status, note }, …]',
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const entries =
      args.items ??
      ([{ id: args.id!, status: args.status! as OwnerDirectiveDisposition, note: args.note! }] as Array<
        z.infer<typeof entry>
      >);
    const workspaceId = activeWorkspaceId();
    const results = [];
    for (const e of entries) {
      // P-008 / D-008, the same rail orders:summarize carries: `done` and
      // `declined` are CLAIMS ABOUT THE OWNER'S ORDER, and closing it stops it
      // rendering for EVERYONE — so a session that is neither the addressee nor
      // a holder of work linking the directive may not speak for it.
      //
      // Applied PER ENTRY rather than rejecting the whole batch: one foreign id
      // in a batch of fifty must not discard forty-nine legitimate closes, and
      // a caller told only "batch refused" cannot tell which id was foreign.
      // directive-ownership-clarity-2026-09-23 D-003: FAIL CLOSED. This used to be
      // `.catch(() => null)`, which let the close through whenever the ownership
      // read errored — the one moment the rail could not say whose directive it
      // was. A refused close is retryable; a wrong close stops the directive
      // rendering for its real addressee and is not observably reversible.
      let verdict: Awaited<ReturnType<typeof directiveActionVerdict>>;
      try {
        verdict = await directiveActionVerdict({ directiveId: e.id, ownerId: identity.ownerId, workspaceId });
      } catch (err) {
        results.push({
          ok: false,
          id: e.id,
          error: 'verdict_unavailable',
          retryable: true,
          hint: `Could not confirm whose directive #${e.id} is (${String(err).slice(0, 160)}), so it was NOT closed. Retry shortly.`,
        });
        continue;
      }
      if (!verdict.allowed && !('notFound' in verdict)) {
        results.push({
          ok: false,
          id: e.id,
          error: 'foreign_directive',
          addressedTo: verdict.addressedTo,
          holders: verdict.holders,
          // Clearing is an AGENDA action this verb does not have; the hint
          // names the verb that does, so the refusal redirects, never dead-ends.
          hint: `Directive #${e.id} was addressed to ${verdict.addressedTo}${verdict.holders.length ? ` and is held by ${verdict.holders.join(', ')}` : ''}. Closing it would stop it rendering for THEM. To take it off your OWN banner only, use orders:clear { id, reason }.`,
        });
        continue;
      }
      const r = await dispositionOwnerDirective({
        id: e.id,
        status: e.status,
        note: e.note,
        dispositionedBy: identity.ownerId,
      }).catch((err: unknown) => ({ ok: false as const, error: 'write_failed' as const, detail: String(err) }));
      results.push(
        r.ok
          ? { ok: true, id: e.id, status: e.status }
          : { ok: false, id: e.id, error: 'error' in r ? r.error : 'write_failed' },
      );
    }
    const failed = results.filter((r) => !r.ok).length;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: failed === 0, results, counts: { ok: results.length - failed, failed } }),
        },
      ],
      ...(failed === results.length ? { isError: true } : {}),
    };
  },
});
