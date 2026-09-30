/**
 * rubrics:ratify — ratify one OR many proposed rubrics → status "active"
 * (rubric-driven-observations-2026-06-20 P-002 / D-001; bulk-standardized per
 * bulk-endpoint-standardization-2026-06-21). An active rubric is the shared
 * definition EVERY agent grades against, so the bar is higher than a one-off observation.
 *
 * D-001 GATE: ratification is an INDEPENDENT REVIEW step, not a self-approval. Any
 * coordination agent (or the owner/su) may ratify after reviewing a proposal, but the
 * persisted proposer≠ratifier check remains enforced by ratifyRubric. The retired Mug/Queen
 * worker is no longer a required counterparty; proposal dwell is surfaced by the rubric
 * proposal-dwell watchdog so an independent reviewer can pick it up.
 *
 * Bulk by default (the house keyed-array contract): ratify ONE inline ({ rubricRef
 * }), MANY (rubricRefs:[…]) → { ok, results:[{ ok, rubricRef, rubric? | error }],
 * counts }. Each result self-describes its rubricRef; one not-found ref never fails
 * the rest. The result key is deliberately the SAME spelling the input accepts, so
 * a ref read off a result can be passed straight back (P-005/EI-11400 retired
 * `rubricId` as a public argument — EI-22084112133846580).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { ratifyRubric, rubricCompleteness } from '../../rubrics';
import { validateRubricReplicationSql } from '../../rubrics-replication-sql';
import { mergeIds, runBulk, bulkContent } from '../_bulk';
import { trackDetached } from '../../detached-imports';

export default defineTool({
  name: 'rubrics:ratify',
  profile: 'engineer',
  description:
    'Ratify one OR many proposed rubrics → status "active" (D-001: an independent reviewer gate — any coordination agent or owner/su may ratify after review, but never the proposer). Single: { rubricRef }. Many: { rubricRefs:[…] }. Returns { ok, results:[{ ok, rubricRef, rubric?, completeness?, replicationSqlCheck? | error }], counts } — correlate by rubricRef, not by position; a not-found ref never fails the rest. Each result reports testing-procedure `completeness` (criteria lacking their own replication drill + whether the rubric-level methodRef is set) and `replicationSqlCheck` (drill SQL that fails against live PG — read its `summary`; `findings` is REAL defects only) — review the gaps before ratifying.',
  guidance: {
    when: 'You are an independent reviewer (or the owner/su) reviewing proposed rubric(s) and judge them sound shared standards. Activating one makes every agent grade structured observations against it. Ratify several at once via rubricRefs:[…].',
    notWhen: 'Authoring or revising content — rubrics:propose. If you are the proposer, leave it proposed for another reviewer; do not self-ratify.',
    chaining: 'rubrics:list { status: "proposed" } → rubrics:get → review the criteria/method → rubrics:ratify { rubricRefs:[…] }. Bulk: single | rubricRefs[] → { ok, results, counts }; correlate by rubricRef not position; one failure never fails the rest.',
    seeAlso: [
      'rubrics:propose (author or revise content, not activate)',
      'rubrics:list { status:"proposed" } (find rubrics awaiting ratification)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      rubricRef: z.string().min(1).optional().describe('single-ratify shorthand: the rubric ref/slug to activate'),
      rubricRefs: z.array(z.string().min(1)).min(1).max(100).optional().describe('rubric refs/slugs to activate (1–100)'),
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
        const rubric = await ratifyRubric(rubricRef, id.ownerId);
        if (!rubric) {
          return { ok: false as const, rubricRef, error: 'rubric not found' };
        }
        // WI-4287: report testing-procedure completeness at the ratification gate —
        // criteria lacking their own replication drill + a missing rubric methodRef
        // stay visible on every activation instead of being tribal knowledge.
        const completeness = rubricCompleteness(rubric);
        // EI-10514: schema-validate embedded replication-drill SQL against live PG at the
        // highest-stakes gate (ratifying makes it THE shared standard) — non-blocking.
        const replicationSqlCheck = await validateRubricReplicationSql(rubric.criteria);
        // Push-on-write (push-audit 2026-07-26): ratification flips governance
        // state the Rubrics pane + readiness strip both display.
        void trackDetached(import('../../sync-sse'))
          .then((m) => {
            m.notifySyncInvalidate('rubrics.list');
            m.notifySyncInvalidate('rubrics.trend');
            m.notifySyncInvalidate('learning.releaseReadiness');
          })
          .catch(() => {});
        return { ok: true as const, rubricRef, rubric, completeness, replicationSqlCheck };
      },
      { keyOf: (rubricRef) => ({ rubricRef }) },
    );
    return bulkContent(env);
  },
});
