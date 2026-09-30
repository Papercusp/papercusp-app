/**
 * gates:degenerate-check — read the gate-decision log and report gates that CANNOT DISCRIMINATE
 * (EI-10619). The on-demand READER that closes the Shape-4 loop: a detector nothing calls is not a
 * check (agent-insights/prove-it-discriminates-before-it-acts). `findDegenerateGates` exists to be
 * read, and this is where it is read.
 *
 * It reports three things `tool_invocations` structurally cannot:
 *   - a discriminating gate whose verdict distribution collapsed to one side (EI-10372 / EI-10562);
 *   - the MARGIN — how far off-scale a threshold sits vs the observed value range (the proof, not a
 *     guess);
 *   - a REGISTERED gate that emitted nothing at all (never-ran) — the severest state, found by
 *     diffing the declaration against the data rather than eyeballing the rows that exist.
 *
 * See `gates/degenerate.ts` for the rule, and note WHY it needs `expect`: without the declared
 * intent, a broken discriminator and a healthy limit-that-never-trips are indistinguishable, which
 * is exactly how EI-10609's fire-rate watchdog died.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { findDegenerateGates } from '../../gates/degenerate';

export default defineTool({
  name: 'gates:degenerate-check',
  description:
    'Read harness_shared.gate_decisions and report gates that CANNOT DISCRIMINATE: a gate declared `discriminates` whose verdict collapsed to one side (its branch is unreachable — EI-10372/EI-10562 class), a REGISTERED gate that emitted no decisions at all (never-ran — the severest state), or a `guards` limit firing so constantly it is mis-declared. Each finding carries the value/threshold MARGIN that proves the branch is off-scale rather than merely unlucky. This is the reader for the decision log that tool_invocations could never provide (a gate\'s decision is not an event).',
  guidance: {
    when:
      'Auditing whether the memory recall gates (or any registered gate) are actually discriminating on live traffic — especially before trusting a green health panel, since a floor that admits nothing reports the tool as ok. Also the direct check for the cannot-discriminate class.',
    notWhen:
      'The decision log is empty because the emitting code path has not run since deploy — a never-ran on EVERY gate means "no data yet", not "all broken". Verify the window has traffic first.',
    chaining:
      'gates:degenerate-check → a `never-admits` with "unreachable by scale" is a proof: fix the constant, not the store. A `never-ran` means the emit is unwired or the gate is not executing — check the call site (gates/decision-wiring.test.ts is the guard).',
    seeAlso: ['gates:canary-check', 'dev:service_health'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  // Acceptance judges run this read-only distribution audit as part of the
  // grading-integrity rubric; keep the admission local instead of widening
  // SU_ROLES and exposing judge to unrelated coordination tools.
  agentRoles: [...SU_ROLES, 'judge'],
  args: z.object({
    sinceHours: z
      .number()
      .positive()
      .max(720)
      .optional()
      .describe('Window to judge over, in hours (default 24). A gate must clear the min-decisions floor within it to be judged.'),
    minDecisions: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Decisions a gate needs before a one-sided distribution means anything (default 30). Below this the gate is not judged — too few calls to conclude.'),
  }),
  async handler(args) {
    const { getOrgPg } = await import('@papercusp/db-org');
    const findings = await findDegenerateGates(getOrgPg().sql, {
      sinceMs: args.sinceHours != null ? args.sinceHours * 60 * 60 * 1000 : undefined,
      minDecisions: args.minDecisions,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            windowHours: args.sinceHours ?? 24,
            degenerateCount: findings.length,
            findings,
          }),
        },
      ],
    };
  },
});
