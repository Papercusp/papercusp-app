/**
 * rubrics:retire — retire one OR many STANDARD rubrics → status "retired"
 * (EI-20276435149948191). The missing inverse of rubrics:ratify.
 *
 * WHY THIS VERB EXISTS WHEN THE STATE WAS ALREADY REACHABLE. A rubric is stored as a
 * plan row and `planStatusToRubricStatus` maps a `superseded` plan → a `retired` rubric,
 * so `plans:set-plan-status { slug: <rubricId>, status:'superseded' }` already worked.
 * It was simply undiscoverable: an agent needing to retire a rubric reads the `rubrics:*`
 * surface, finds no way out of `active`, and concludes the lifecycle is one-way — which
 * is precisely what EI-20276435149948191 filed. The fix belongs where the agent already
 * looks, not in a doc they would have to know to read.
 *
 * It also carries the invariant the generic plan verb structurally cannot: an ACCEPTANCE
 * rubric archives WITH its subject plan (acceptance-rubrics-on-every-plan-2026-08-11
 * P-005), so retiring one by hand desyncs it from the plan whose definition-of-done it is.
 * `retireRubric` refuses that; `plans:set-plan-status` cannot even see it.
 *
 * Bulk by default (the house keyed-array contract), and keyed on `rubricRef` — the same
 * spelling the input accepts, so a ref read off a result can be passed straight back.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { retireRubric } from '../../rubrics';
import { mergeIds, runBulk, bulkContent } from '../_bulk';
import { trackDetached } from '../../detached-imports';

export default defineTool({
  name: 'rubrics:retire',
  profile: 'engineer',
  description:
    'Retire one OR many STANDARD rubrics → status "retired" (the inverse of rubrics:ratify). Single: { rubricRef }. Many: { rubricRefs:[…] }, optional { reason } recorded on the audit revision. Returns { ok, results:[{ ok, rubricRef, rubric? | error }], counts } — correlate by rubricRef, not position; one bad ref never fails the rest. Idempotent: an already-retired rubric succeeds unchanged. REFUSES acceptance-kind rubrics — those archive with their subject plan, never by hand. Reversible via rubrics:ratify.',
  guidance: {
    when: "A standard rubric's subject is gone or superseded and it should stop being graded — its subsystem was deleted, or a replacement rubric now covers it. Retiring drops it from the staleness watchdog, which watches every active rubric and otherwise nags forever for scorecards nobody can emit.",
    notWhen:
      'Changing criteria (rubrics:amend / rubrics:propose). Marking where an old contract ended while keeping it live (rubrics:set-history-reset). An acceptance rubric — ship or supersede its subject plan instead.',
    chaining:
      'rubrics:list { status:"active" } → rubrics:get → confirm the subject is really dead → rubrics:retire { rubricRefs:[…] }. Bulk: single | rubricRefs[] → { ok, results, counts }.',
    seeAlso: ['rubrics:ratify (the inverse — reactivates a retired rubric)', 'rubrics:list { status:"active" }'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      rubricRef: z.string().min(1).optional().describe('single-retire shorthand: the rubric ref/slug to retire'),
      rubricRefs: z.array(z.string().min(1)).min(1).max(100).optional().describe('rubric refs/slugs to retire (1–100)'),
      reason: z.string().min(1).max(300).optional().describe('why it is being retired; recorded on the audit revision'),
    })
    .refine((a) => Boolean(a.rubricRef) || (a.rubricRefs?.length ?? 0) > 0, {
      message: 'pass `rubricRef` (one) or `rubricRefs` (many)',
    }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const ids = mergeIds(args.rubricRef, args.rubricRefs);
    const env = await runBulk(
      ids,
      async (rubricRef) => {
        // retireRubric THROWS for a governance violation (acceptance-kind) and returns
        // null only for not-found. runBulk isolates the throw to this entry, so one
        // refused ref never fails the rest of the batch.
        const rubric = await retireRubric(rubricRef, id.ownerId, args.reason);
        if (!rubric) {
          return { ok: false as const, rubricRef, error: 'rubric not found' };
        }
        // Push-on-write (push-audit 2026-07-26): retirement flips governance state the
        // Rubrics pane + readiness strip both display — same surfaces ratify invalidates.
        void trackDetached(import('../../sync-sse'))
          .then((m) => {
            m.notifySyncInvalidate('rubrics.list');
            m.notifySyncInvalidate('rubrics.trend');
            m.notifySyncInvalidate('learning.releaseReadiness');
          })
          .catch(() => {});
        return { ok: true as const, rubricRef, rubric };
      },
      { keyOf: (rubricRef) => ({ rubricRef }) },
    );
    return bulkContent(env);
  },
});
