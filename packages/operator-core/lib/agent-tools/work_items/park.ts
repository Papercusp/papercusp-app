/**
 * work_items:park — shelve a work-item RESUMABLY: checkpoint + release + a
 * one-line coord note, atomically-in-intent (modes-and-intake-ux-2026-07-05
 * P-004; owner idea #0, 2026-07-05).
 *
 * Formalizes the observed fleet vocabulary "parked with a complete resume
 * checkpoint" (the neologism-miner pattern: recurring prose with no
 * primitive). Before this verb, parking was a 2–3 tool dance
 * (work_items:checkpoint → work_items:release → maybe a coord:send) that each
 * agent improvised and nothing could count. park is the named composite:
 *   1. write the checkpoint (the resume state a successor is re-injected with),
 *   2. release the claim (item stays claimable; state untouched — parking is
 *      NOT blocking: use set_state{blocked} for a dependency wall),
 *   3. broadcast a one-line lifecycle note so peers/the Queen see the shelf.
 * The note is best-effort: a coord hiccup never un-parks the item.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { sendMessage } from '../coordination/messages';
import { setWorkItemCheckpoint } from '../../work-item-checkpoint';
import { releaseWorkItem } from '../../work-items';
import { lookupWorkItem } from './_lookup';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'work_items:park',
  profile: 'engineer',
  description:
    'Park a work-item to resume later: writes the resume CHECKPOINT, releases your claim, and broadcasts a one-line ' +
    'note — one verb for the checkpoint→release→announce dance. { id, checkpoint, reason, harness? }. The item stays ' +
    'claimable (state untouched); the checkpoint is re-injected on the next pickup (yours or a successor’s).',
  guidance: {
    when:
      'You are deliberately shelving in-flight work to pick something else up (a redirect, a higher-priority item, ' +
      'end of a stint) and intend it to be RESUMED — by you or anyone. The checkpoint should let a cold successor ' +
      'continue without re-deriving: done / left / approach / gotchas.',
    notWhen:
      'The item is DONE (work_items:complete), blocked on an external condition (work_items:set_blocker records the typed reason), ' +
      'blocked by another work-item (work_items:link { rel:"blocks" } records the dependency), ' +
      'or you are abandoning it as wrong/obsolete (set_state{dropped}). Park = "good work, paused on purpose".',
    chaining:
      'work_items:park { id, checkpoint, reason } → later work_items:claim/pickup re-injects the checkpoint. ' +
      'For a do-not-self-select shelf add work_items:release { claimHold:true } semantics via a follow-up release call.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('the work-item id to park'),
    checkpoint: z
      .string()
      .min(20)
      .max(32000)
      .describe('the COMPLETE resume state (done / left / approach / gotchas) — a successor continues from this alone'),
    reason: z.string().min(1).max(500).describe('why you are parking it — broadcast to peers in the park note'),
    harness: z.string().max(80).optional().describe('harness the item lives under (else resolved from the item)'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const c = ctx as { harnessSlug?: string | null; workspaceId?: string | null };
    // EI-8805: key the parked checkpoint by the ITEM's OWN harness so it round-trips
    // on re-claim/re-injection. A harness-null item (an EI from an unscoped session)
    // must not be keyed under the session harness — the store canonicalizes a null
    // harness to the shared wildcard namespace the read side resolves it under.
    const hint = args.harness ?? c.harnessSlug ?? undefined;
    const hintHarness = hint && hint !== '*' ? hint : undefined;
    // WI-6746: park's whole purpose is to SAVE state, so a silent loss is the worst
    // outcome here. When the read fails we do not know the item's own harness, and the
    // old fallback wrote the checkpoint under the caller's HINT instead — a different
    // key namespace, which reads back as null forever (the EI-8805 loss mode) while
    // still reporting ok. Refuse loudly and keep the text in the caller's hands: an
    // agent that still has its state can retry, one that trusted a false ok cannot.
    const lookup = await lookupWorkItem(args.id, hintHarness);
    if (lookup.status === 'unreadable') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              id: args.id,
              error:
                `work_item_unreadable — could not read '${args.id}' to resolve its harness (${lookup.error}). ` +
                'Refusing rather than writing your checkpoint under a possibly-wrong harness key, where it would ' +
                'read back as null while reporting success. Your checkpoint text was NOT saved — retry (it is a ' +
                'READ FAILURE, not a missing item).',
            }),
          },
        ],
      };
    }
    const item = lookup.status === 'found' ? lookup.item : null;
    if (!item && !hintHarness) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, id: args.id, error: `could not resolve a harness for work_item '${args.id}' — pass { harness }` }) },
        ],
      };
    }
    const harness: string | null = item ? item.harness ?? null : hintHarness ?? null;
    // EI-8824: same wildcard-workspace bug as work_items:checkpoint — c.workspaceId
    // is '*' for an unscoped superuser session and must never be persisted literally.
    const stored = await setWorkItemCheckpoint(
      { harness, workItemId: args.id, workspaceId: resolveConcreteWorkspaceId(c.workspaceId) },
      args.checkpoint,
    );
    const released = await releaseWorkItem(args.id, {
      harness: harness ?? undefined,
      releasingOwnerId: ident.ownerId,
    });
    // Best-effort lifecycle note (never un-parks on failure).
    let noted = false;
    try {
      await sendMessage(ident, {
        to: ['*'],
        summary: `🅿 ${args.id} parked by ${ident.ownerId} — resume checkpoint saved (${stored?.length ?? 0} chars): ${args.reason.slice(0, 140)}`,
        harnessSlug: harness ?? undefined,
        extra: { auto: true, lifecycle: 'park', work_item: args.id },
      });
      noted = true;
    } catch { /* fail-soft */ }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            id: args.id,
            harness,
            checkpointChars: stored?.length ?? 0,
            released: Boolean(released),
            noted,
            by: ident.ownerId,
            note: released ? undefined : 'item was not claimed (or not found for release) — checkpoint still saved',
          }),
        },
      ],
    };
  },
});
