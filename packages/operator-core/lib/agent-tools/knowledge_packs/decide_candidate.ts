/**
 * knowledge_packs:decide_candidate — adopt/dismiss on one OR many staged
 * fleet→pack candidates (self-improvement-consume-edges-2026-06-12 P-032,
 * brief B-11; bulk-standardized per bulk-endpoint-standardization-2026-06-21;
 * auto-adopt reversal owner-auto-adopt-fleet-lessons-2026-07-19 / WI-5414).
 *
 * Most candidates are decided AUTOMATICALLY: an improvement-triage-cadence
 * sweep (knowledge-packs/candidates.ts's autoAdoptPendingCandidates) runs an
 * automated review (the same conflict-check machinery the install/upgrade
 * review already runs) against every pending candidate and calls THIS core
 * with the machine `by` identity ('fleet-candidate-auto-review') — adopt on a
 * passing review, dismiss (with the verdict as the note) on a failing one.
 * This tool remains the OWNER'S manual override — adopt/dismiss any
 * still-pending candidate ahead of (or instead of) the automated sweep;
 * calling it after the sweep already decided a candidate returns
 * `not_pending`, never a double-decide.
 *
 * Adoption materializes the (optionally edited) draft into the fleet-lessons
 * pack under the installed packs root and bumps the pack's patch version — it
 * NEVER writes a hive's memory pool. Hives adopt the new item through the
 * existing knowledge_packs:install/upgrade conflict review (which already has
 * its own no-human path: `acceptDefaults: true`).
 *
 * Bulk by default (the house keyed-array contract): decide ONE inline ({ id,
 * action, note?, title?, text? }), MANY with the SAME action (ids:[…] + action),
 * or MANY heterogeneous (items:[{ id, action, note?, title?, text? }]) → { ok,
 * results:[{ ok, id, action?, … | error }], counts }. Each result self-describes
 * its id; one bad candidate never fails the rest. Owner-edited title/text apply
 * per-candidate, so use the inline single or items[] form when editing.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { getSessionUserOrDefault } from '../../auth';
import { FLAG_OFF, knowledgePacksEnabled, text } from './_shared';
import { runBulk, bulkContent } from '../_bulk';
import { hardText, softText, clampText, LIMITS } from '../limits';

const ACTION = z.enum(['adopt', 'dismiss']);

const itemSpec = z.object({
  id: z.string().min(1).max(80).describe('Candidate id (from knowledge_packs:candidates).'),
  action: ACTION,
  note: softText(LIMITS.ANNOTATION).optional().describe('Decision note recorded on the candidate. Auto-truncated to 2000 chars if longer.'),
  title: hardText(LIMITS.SHORT_TITLE).optional().describe('Owner-edited title (adopt only).'),
  text: hardText(8000).optional().describe('Owner-edited lesson body (adopt only).'),
});

type DecideItem = z.infer<typeof itemSpec>;

const ADOPT_HINT =
  'Adopted into the fleet-lessons pack. Hives with the pack installed now show updateAvailable (adopt via knowledge_packs:upgrade); others can knowledge_packs:install it — both through the normal conflict review.';

export default defineTool({
  name: 'knowledge_packs:decide_candidate',
  capability: 'memory:write',
  description:
    'Decide one OR many pending knowledge-pack candidates: adopt (write it into the fleet-lessons pack — version bumps so hives see updateAvailable; optionally edit title/text first) or dismiss (terminal — the signature never re-stages). Most candidates are auto-decided by a scheduled review sweep; this tool is the manual OVERRIDE. Single: { id, action, note?, title?, text? }. Many same action: { ids:[…], action }. Many heterogeneous: items:[{ id, action, note?, title?, text? }]. Returns { ok, results:[{ ok, id, action?, … | error }], counts } — correlate by id, not by position; one bad candidate never fails the rest.',
  guidance: {
    when:
      'The owner asks you to adopt/dismiss a candidate now, overriding the automated review sweep. Decide several at once via ids:[…]+action or items:[…].',
    notWhen:
      'Routine unattended candidates — the automated sweep already decides those. To seed a lesson into a hive pool directly (adoption only updates the PACK; hives adopt via knowledge_packs:install/upgrade).',
    chaining:
      'knowledge_packs:candidates first (ids + drafts). After adopt: hives with fleet-lessons installed show updateAvailable → knowledge_packs:upgrade { hive, pack: "fleet-lessons" }; others via knowledge_packs:install. Bulk: single | items[] (or ids) → { ok, results, counts }; correlate by id not position; one failure never fails the rest.',
    seeAlso: [
      'knowledge_packs:candidates (the candidate pool + drafts)',
      'knowledge_packs:upgrade (hives adopt the accepted item)',
    ],
  },
  crossWorkspace: true,
  args: z
    .object({
      id: z.string().min(1).max(80).optional().describe('single-decide shorthand: the candidate id'),
      action: ACTION.optional().describe('applies to the inline id / every id in `ids`'),
      note: softText(LIMITS.ANNOTATION).optional().describe('decision note for the inline id / every id in `ids`. Auto-truncated to 2000 chars if longer.'),
      title: hardText(LIMITS.SHORT_TITLE).optional().describe('Owner-edited title for the inline id (adopt only).'),
      text: hardText(8000).optional().describe('Owner-edited lesson body for the inline id (adopt only).'),
      ids: z.array(z.string().min(1).max(80)).min(1).max(100).optional().describe('decide MANY candidates with the same `action` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(100).optional().describe('decide many candidates at once — each { id, action, note?, title?, text? }'),
      workspace: z.string().max(120).optional(),
    })
    .refine(
      (a) => (a.items?.length ?? 0) > 0 || (Boolean(a.action) && ((a.ids?.length ?? 0) > 0 || Boolean(a.id))),
      {
        message: 'pass { id, action } for one, { ids:[…], action } for many of the same action, or items:[{ id, action }] for many',
      },
    ),
  async handler(args, ctx) {
    if (!(await knowledgePacksEnabled())) return text(FLAG_OFF);
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.principal?.workspaceId);
    const by = (await getSessionUserOrDefault()).id;
    const { decideKnowledgePackCandidate } = await import('../../knowledge-packs/candidates');

    const list: DecideItem[] = args.items?.length
      ? args.items
      : args.ids?.length
        ? args.ids.map((id) => ({ id, action: args.action as z.infer<typeof ACTION>, note: args.note }))
        : [{ id: args.id as string, action: args.action as z.infer<typeof ACTION>, note: args.note, title: args.title, text: args.text }];

    const env = await runBulk(
      list,
      async (it) => {
        const result = await decideKnowledgePackCandidate({
          id: it.id,
          action: it.action,
          by,
          ...(it.note ? { note: clampText(it.note, LIMITS.ANNOTATION) } : {}),
          ...(it.title ? { title: it.title } : {}),
          ...(it.text ? { text: it.text } : {}),
          workspaceId,
        });
        if (!result.ok) {
          return { ok: false as const, id: it.id, reason: result.reason, ...(result.error ? { error: result.error } : {}) };
        }
        // Spread the core result FIRST, then pin the bulk key fields so they win.
        return {
          ...result,
          ...(result.action === 'adopt' ? { hint: ADOPT_HINT } : {}),
          ok: true as const,
          id: it.id,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
