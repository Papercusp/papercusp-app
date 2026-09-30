/**
 * rubrics:set-history-reset — declare a rubric's CONTRACT-GENERATION BOUNDARY
 * (goal-mode-rubric-v2-2026-08-10 D-015).
 *
 * WHY THIS IS NOT AN ARG ON rubrics:propose. A propose is a whole-document replace: it
 * resets status to 'proposed' and drops ratifiedBy, correctly, because the rubric's
 * CONTENT changed. Declaring where a previous contract ended changes no criterion, so
 * routing it through propose would demote a live ratified instrument — and an author
 * facing a re-ratification would simply not declare the boundary, which is the outcome
 * this exists to prevent. It therefore takes the shape rubrics:ratify already uses for
 * governance state: an audited, locked template_data patch that preserves everything else.
 *
 * WHY IT CANNOT BE INFERRED. The trend joins purely on criterion KEY, and the cases that
 * break comparability share a key: on goal-mode-e2e, `dedup-before-creating` kept its key
 * while its question narrowed (D-009), and `child-execution-proven` kept its key while its
 * drill could not measure at all (5/5 unknown, D-012). The plan `version` column cannot
 * separate those from a typo fix — it bumps for both.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { setRubricHistoryReset } from '../../rubrics';
import { trackDetached } from '../../detached-imports';

export default defineTool({
  name: 'rubrics:set-history-reset',
  profile: 'engineer',
  description:
    'Declare a rubric\'s contract-generation boundary: gradings filed BEFORE `at` measured a materially different contract, so scorecardTrend excludes them (reported as `preContractResetExcluded`, never silently). Use after rewriting a rubric against a rewritten contract. Preserves status/criteria/provenance — unlike rubrics:propose, this does NOT demote a ratified rubric. Returns { ok, rubricId, rubric }.',
  guidance: {
    when: 'You have revised a rubric because the CONTRACT it grades was rewritten, and its stored gradings now measure a contract that no longer exists. Set `at` to the instant the new revision took effect (normally its ratification).',
    notWhen:
      'A single scorecard was wrong — that is a `revises` link (a correction), not a generation boundary. Editing criteria — rubrics:propose. Retiring the rubric itself — rubrics:propose with status.',
    chaining: 'rubrics:propose → rubrics:ratify (by a non-author) → rubrics:set-history-reset { rubricRef, at } → rubrics:trend to confirm preContractResetExcluded.',
    seeAlso: ['rubrics:trend (confirm what the boundary excluded)', 'rubrics:propose (change criteria — demotes to proposed)'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    rubricRef: z.string().min(1).describe('the rubric ref/slug whose boundary to declare'),
    at: z
      .string()
      .min(1)
      .describe(
        'ISO instant; gradings created BEFORE it are excluded from the trend. Normally the ratification time of the revision that rewrote the rubric',
      ),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const rubric = await setRubricHistoryReset(args.rubricRef, args.at, id.ownerId);
    if (!rubric) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, rubricId: args.rubricRef, error: 'rubric not found' }) },
        ],
      };
    }
    // Push-on-write: the boundary changes what the Rubrics pane's trend column reports.
    void trackDetached(import('../../sync-sse'))
      .then((m) => {
        m.notifySyncInvalidate('rubrics.list');
        m.notifySyncInvalidate('rubrics.trend');
      })
      .catch(() => {});
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, rubricId: rubric.rubricId, rubric }) },
      ],
    };
  },
});
