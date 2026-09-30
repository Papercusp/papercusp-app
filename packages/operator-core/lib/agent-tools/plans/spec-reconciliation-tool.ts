/** plans:spec-reconciliation — the P-012 pre-enforcement reconciliation ledger. */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import {
  computeSpecReconciliationLedger,
  type AdoptionState,
  type SpecReconciliationRow,
} from './spec-reconciliation';
import { computeSpecEnforcementLatency } from './spec-enforcement-latency';
import { computeSpecEnforcementEscape } from './spec-enforcement-escape';
import { computeSpecEnforcementRepeatedApproach } from './spec-enforcement-repeated-approach';

const argsSchema = z.object({
  harness: harnessArg,
  adoption: z
    .array(z.enum(['adopted', 'legacy-val-only', 'no-behavior-declared']))
    .min(1)
    .optional()
    .describe('Restrict the returned ROWS to these adoption states. Never affects the rollup.'),
  includeHistorical: z
    .boolean()
    .optional()
    .describe('Include shipped/superseded plans in the returned rows. Default false.'),
  actionableOnly: z
    .boolean()
    .optional()
    .describe('Return only rows carrying at least one action. Default true.'),
  limit: z.number().int().positive().max(200).optional().describe('Max ROWS returned (default 25).'),
  includeLatency: z
    .boolean()
    .optional()
    .describe(
      'Include the work-item-axis outcome rollups — claim-to-completion latency, defect escape, ' +
        "and repeated failed work — each split by whether the item's plan was enforcement-" +
        'eligible. Default true.',
    ),
});

export default defineTool({
  name: 'plans:spec-reconciliation',
  description:
    'Pre-enforcement spec reconciliation ledger across plans: which plans adopted first-class clauses, which still carry only legacy VAL-* text, which declare no behavior at all, plus per-plan coverage/adequacy gaps and the action each needs. Report-only; never refuses.',
  guidance: {
    when: 'Before enabling clause enforcement, or to see what enforcement would actually be enforcing over. Answers "is this green because it is covered, or because nothing was ever declared?".',
    notWhen: 'One plan\'s clause detail — plans:get-specs. One plan\'s ship verdict — the acceptance gate.',
    chaining: 'plans:spec-reconciliation → plans:set-specs (backfill a legacy plan) → plans:bind-spec-evidence.',
    seeAlso: ['plans:get-specs (exact clause reads)'],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'kettle', 'worker'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const limit = args.limit ?? 25;
    const actionableOnly = args.actionableOnly ?? true;

    // The ledger censuses the WHOLE population; `limit` below bounds only the rows we
    // ship back. Deriving the rollup from a limited fetch would turn a floor into a
    // number a reader treats as a total — the defect `countsAreFloor` exists to prevent.
    const { rows, rollup } = await computeSpecReconciliationLedger({ harnessSlug });

    // The WORK-ITEM axis, computed alongside but kept structurally separate: it is returned as
    // its own top-level block and never merged into a plan row, because a per-item duration
    // living on a per-plan row is how a plan census quietly starts reporting an item statistic.
    // Its own `rows` (one per measured item) are deliberately NOT shipped — this tool's rows are
    // plans, and the latency question is answered by the distribution, not by 7,000 durations.
    const [latency, escape, repeatedWork] =
      args.includeLatency === false
        ? [undefined, undefined, undefined]
        : await Promise.all([
            computeSpecEnforcementLatency({}, { harnessSlug }).then((l) => l.rollup),
            computeSpecEnforcementEscape({}, { harnessSlug }).then((e) => e.rollup),
            computeSpecEnforcementRepeatedApproach({}, { harnessSlug }).then((r) => r.rollup),
          ]);

    const wanted = new Set<AdoptionState>(args.adoption ?? ['adopted', 'legacy-val-only', 'no-behavior-declared']);
    const matching = rows.filter((r) => {
      if (!args.includeHistorical && r.lane === 'historical') return false;
      if (!wanted.has(r.adoption)) return false;
      if (actionableOnly && r.actions.length === 0) return false;
      return true;
    });

    const shown = matching.slice(0, limit);
    return {
      data: {
        ok: true,
        harnessSlug,
        rollup,
        latency,
        escape,
        // Measure 4. Its `pairing` is the load-bearing field: the repeated-failure rate improves
        // if agents leave LESS behind, so it must never be read without `unbriefablePerThousand`.
        repeatedWork,
        rows: shown.map(compactRow),
        rowsMatched: matching.length,
        rowsShown: shown.length,
        rowsTruncatedByLimit: matching.length > shown.length,
        note:
          rollup.bounded.countsAreFloor
            ? 'Every rollup count is a FLOOR: the plan population or a per-plan census truncated. See rollup.bounded.'
            : undefined,
      },
    };
  },
});

/** Rows are for acting on, so ship the actions and the gap counts, not the full census. */
function compactRow(r: SpecReconciliationRow) {
  return {
    planSlug: r.planSlug,
    status: r.status,
    lane: r.lane,
    adoption: r.adoption,
    coverageUnavailableReason: r.coverageUnavailableReason,
    gaps: r.coverage
      ? {
          enforceable: r.coverage.clauses.enforceable,
          proven: r.coverage.coverage.proven,
          staleProof: r.coverage.coverage.staleProof,
          unproven: r.coverage.coverage.unproven,
          ungraded: r.coverage.adequacy.ungraded,
          falsifierDeclared: r.coverage.clauses.falsifierDeclared,
          censusTruncated:
            r.coverage.bounded.truncatedByLimit || r.coverage.bounded.adequacyTruncatedByLimit,
        }
      : null,
    actions: r.actions.map((a) => ({ kind: a.kind, detail: a.detail, specIds: a.specIds })),
  };
}
