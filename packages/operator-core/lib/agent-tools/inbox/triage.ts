/**
 * inbox:triage — the operator's inbox-triage PASS
 * (inbox-tiering-and-message-agent-2026-06-05, D-006, P-017).
 *
 * At each user-driven wake the operator manages the inbox FIRST: it
 * downgrades false-positive decisions, ESCALATES under-flagged items its bigger
 * context flags as urgent, and confirms/resolves the rest. Each call persists a
 * triage record (attention_triage) which plans:attention overlays via
 * applyTriage to produce the final tier:
 *   - downgrade / resolve → "Handled by operator" tier (VISIBLE + auditable —
 *     never a silent vanish; the note records WHY).
 *   - escalate / confirm  → Decision tier (escalate promotes; confirm vets).
 *
 * Surface-first invariant (D-006): triage is a PASS, not a gate — an
 * agent-surfaced need_human is user-visible immediately and only LATER triaged.
 * There is no operator-gated intermediate state.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): the triage key is the
 * COMPOUND per-item `{ itemId, action, note? }` (action + note are
 * heterogeneous), so several ride `items:[{ … }]`; pass a single `{ itemId,
 * action, note? }` for n=1. Returns { ok, results:[{ ok, itemId, action,
 * triageState, tier | error }], counts } — correlate each result by its itemId,
 * not by position; a bad item (e.g. note missing on a downgrade) fails ONLY
 * itself.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { type TriageAction, triageActionToState } from '../../attention/types';
import { upsertTriage } from '../../attention/triage-store';
import { runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import { softText, clampText, LIMITS } from '../limits';

const TriageItem = z
  .object({
    /** The AttentionItem id (`<kind>:<…>`, e.g. `coord-escalation:<msgId>`). */
    itemId: z.string().min(1),
    action: z.enum(['confirm', 'escalate', 'downgrade', 'resolve']),
    /** What the operator did + why — the audit note (and the operator's own
     *  learning signal). Required when downgrading/resolving. */
    note: softText(LIMITS.ANNOTATION).optional(),
  })
  .refine((d) => !(d.action === 'downgrade' || d.action === 'resolve') || !!d.note?.trim(), {
    message: 'note (the why) is required when downgrading or resolving',
    path: ['note'],
  });

export default defineTool({
  name: 'inbox:triage',
  description:
    'Triage one OR many attention items (the operator inbox PASS): downgrade a false positive or resolve it → the auditable "Handled by operator" tier; escalate an under-flagged item or confirm a real one → the Decisions tier. Pass a single `{ itemId, action, note? }` for one or `items:[{ itemId, action, note? }]` for several. Record WHY in `note` (required on downgrade/resolve). The downgrade is always visible + auditable, never a silent vanish. Returns { ok, results:[{ ok, itemId, action, triageState, tier | error }], counts } — correlate by itemId, not position; one bad item never fails the rest.',
  guidance: {
    when: 'Operator inbox PASS — run FIRST each wake over the Decisions tier: re-tier attention items after reading them (downgrade noise, escalate something a worker under-flagged, confirm/resolve a real decision), always recording the why in `note`. Triaging several at once? Pass them all via `items:[{ itemId, action, note? }]`. Leave the inbox clean before sleeping.',
    notWhen:
      'Acting on the item itself (resolve an escalation → coord:resolve; mark a plan item done → plans:set-status). Messaging the owning agent → coord:message-agent.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      itemId: z.string().min(1).optional().describe('a single attention item id (n=1 shorthand; pair with action)'),
      action: z.enum(['confirm', 'escalate', 'downgrade', 'resolve']).optional().describe('the triage action for the single `itemId` (n=1 shorthand)'),
      note: softText(LIMITS.ANNOTATION).optional().describe('the why for the single item (required on downgrade/resolve). Auto-truncated to 2000 chars if longer.'),
      items: z.array(TriageItem).min(1).max(100).optional().describe('triage actions to apply (1–100), each { itemId, action, note? }'),
    })
    .refine((a) => Boolean(a.items?.length) || (Boolean(a.itemId) && Boolean(a.action)), {
      message: 'pass `{ itemId, action }` (one) or `items:[{ itemId, action }]` (many)',
    })
    // n=1 inline form must also satisfy the note-on-downgrade/resolve rule.
    .refine(
      (a) =>
        Boolean(a.items?.length) ||
        !(a.action === 'downgrade' || a.action === 'resolve') ||
        !!a.note?.trim(),
      { message: 'note (the why) is required when downgrading or resolving', path: ['note'] },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const items = args.items?.length
      ? args.items
      : [{ itemId: args.itemId!, action: args.action!, note: args.note }];
    const env = await runBulk(
      items,
      async ({ itemId, action: rawAction, note }) => {
        const action: TriageAction = rawAction;
        await upsertTriage({
          itemId,
          action,
          note: clampText(note, LIMITS.ANNOTATION)?.trim() ?? null,
          triagedBy: identity.ownerId,
        });
        const triageState = triageActionToState(action);
        const tier = triageState === 'downgraded' || triageState === 'resolved' ? 'handled' : 'decision';
        return { ok: true as const, itemId, action, triageState, tier };
      },
      { keyOf: ({ itemId }) => ({ itemId }) },
    );
    return bulkContent(env);
  },
});
