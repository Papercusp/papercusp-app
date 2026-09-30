/**
 * experiment:catalog — discover the registered experiment tests the self-learning
 * loop can run (`experiment-registry-invocation-api` P-030).
 *
 * The eval-battery `Subject`s are registered as {@link TestDescriptor}s; this tool is
 * that catalog exposed to a role: each entry's kind, fidelity tier (offline/shadow/
 * live), the knob-space slice it can vary, what it measures, and its cost class —
 * read-only, no spend. Pair with `experiment:run` to invoke one. Mirrors the
 * gym:signals discovery pattern (harness:read, the Queen-side self-improvement surface).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listTests } from '@papercusp/eval-battery';
import { QUEEN_PLACEMENT_ROLES } from '../coordination/roles';
import { registerExperimentDescriptors } from '../../experiment/descriptors';

export default defineTool({
  name: 'experiment:catalog',
  description:
    'Discover the registered experiment tests (eval-battery Subjects) the self-learning loop can run. Each entry: id, kind (replay|component|whole-instance|whole-hive|drill), fidelityTier (offline=~$0 deterministic replay, the default screen; shadow; live=real agent spend), knobSlice (the knob-space addresses it can vary), metrics (deterministic signals + judge rubric dimensions), costClass. Read-only. Filter by kind/tier. Pair with experiment:run to invoke one.',
  guidance: {
    when: 'Choosing which test to run against a knob change — list the catalog to see what kinds exist, which tier each runs at (offline replay is the cheap default screen), and which knobs each can vary. Filter by kind/tier.',
    notWhen: 'Running an experiment (experiment:run). Scoring one gym run’s deterministic guardrails (gym:signals). Subjective quality scoring (gym:judge).',
    chaining: 'experiment:catalog → pick a testId + read its knobSlice → experiment:run with arms addressing only that slice.',
    seeAlso: [
      'experiment:run (run a chosen test)',
      'experiment:results (past outcomes)',
      'gym:signals (deterministic guardrails for one gym run)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  // Mirror gym:signals — the Queen-side self-improvement surface; the worker-bee +
  // sentinel are excluded so [...COORD_ROLES] doesn't leak it. Overwatch excluded too
  // (overwatch-role-2026-06-15): not an experiment surface, and it carries harness:read.
  agentRoles: QUEEN_PLACEMENT_ROLES,
  args: z.object({
    kind: z
      .enum(['component', 'whole-instance', 'whole-hive', 'replay', 'drill'])
      .optional()
      .describe('Filter to one test kind.'),
    tier: z.enum(['offline', 'shadow', 'live']).optional().describe('Filter to one fidelity tier.'),
  }),
  async handler(args) {
    registerExperimentDescriptors();
    let tests = listTests();
    if (args.kind) tests = tests.filter((t) => t.kind === args.kind);
    if (args.tier) tests = tests.filter((t) => t.fidelityTier === args.tier);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, count: tests.length, tests }) }],
    };
  },
});
