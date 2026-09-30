/**
 * work_items:completion_stats — completion-integrity and declared-outcome counts
 * (work-item-completion-integrity-2026-07-01 P-003, contract C-1 consumer).
 *
 * WI-1403's gate rejects a terminal transition missing an owner+completionRef UNLESS the
 * caller passes skipCompletionGate — the shape the watchdog/hygiene/revert dedup markers
 * use (WI-1404). That means the raw terminal-state count silently blends genuine
 * completions with dedup flips. This read separates them: `genuineCompletions` counts ONLY
 * terminal work-items carrying BOTH terminal_owner and terminal_completion_ref;
 * `dedupOrUnverified` is everything else terminal (a dedup flip, or a pre-migration-432
 * historical row). Neither value measures whether a new change landed. Only a
 * declared workOutcome can answer that narrower question, and legacy omissions
 * remain unknown.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { getCompletionIntegrityStats } from '../../work-items';

export default defineTool({
  name: 'work_items:completion_stats',
  profile: 'engineer',
  description:
    "Completion-integrity and declared-outcome counts for one harness. genuineCompletions means terminal owner plus completion ref or authority judgement; it does NOT mean a new change landed. declaredWorkOutcomes counts exact self-declared introduced-change, verified-existing, duplicate, invalid-or-expected, other-no-new-change, and unknown legacy/omitted outcomes across terminal rows. gateJudged is evidence-gate coverage, not a compliance score.",
  guidance: {
    when:
      'Reporting harness completion-integrity coverage or the exact split of declared work outcomes; do not equate a committed authority judgement with a new change.',
    notWhen: 'Per-item detail — that is work_items:get. A live roster of who is doing what — that is fleet:status / fleet:assignments.',
    seeAlso: [
      'work_items:get (per-item terminalOwner/terminalCompletionRef detail)',
      'harness:health (the harness health rollup)',
      'fleet:status (who is doing what right now)',
    ],
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1).max(80).describe('Harness slug to read the completion split for.'),
  }),
  async handler(args) {
    const stats = await getCompletionIntegrityStats(args.harness);
    // { data } shape (tool-data-shape ratchet P-003): the framework owns wire encoding.
    return { data: { ok: true, ...stats } };
  },
});
