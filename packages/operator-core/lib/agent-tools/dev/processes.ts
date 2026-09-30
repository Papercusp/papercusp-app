/**
 * dev:processes — inventory of the six TRACKED agent process kinds on this
 * host. Deliberately NOT a general process list.
 *
 * Walks /proc, classifies internal cmdlines (run.sh, omp, claude, paperclip,
 * pty, next), then returns only stable executable/role/build metadata plus
 * cwd and start time. Arbitrary argv is never a client field.
 * Read-only; kill is design-blocked behind Tier 1 capability work.
 *
 * SCOPE IS INTENTIONAL — do not widen it (D-009, plan
 * bash-to-tool-substitution-2026-07-26). `listProcesses()` drops every
 * cmdline that classifies as 'other', so vitest/tsc/gate/deploy/container
 * jobs are invisible here by design. The P-008 audit measured the cost of
 * pretending otherwise: of 1,590 real ps/pgrep atoms across 62 of 86
 * sessions, 0 of a 24-command frozen sample had any dev:processes
 * expression, and of 815 `ps … | grep X` pairs exactly TWO grepped for
 * something inside the six kinds. Adding a pid selector + name filter here
 * would produce `ps` with extra steps and still not answer the question
 * actually being asked ("did my job FINISH, and what did it print") — that
 * belongs to the job-handle surface (capability:bash / capability:bash_output).
 * What this file owes the caller is an HONEST scope, not a wider one: the
 * description below must never claim the whole-host inventory question.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listProcesses } from '../../dev-data';

/**
 * The six tracked kinds. Exported so a test can pin the tool's DESCRIPTION to
 * it: widening this list without widening the description would make the doc
 * under-report what the tool returns (P-012).
 */
export const KIND_ENUM = ['run.sh', 'omp', 'claude', 'paperclip', 'pty', 'next'] as const;

export default defineTool({
  name: 'dev:processes',
  profile: 'engineer',
  description:
    'Inventory of the SIX tracked AGENT process kinds only (run.sh, omp, claude, paperclip, pty, next) with stable executable/role/build metadata, start time, cwd, and inferred harness/workspace. Arbitrary argv is never returned. NOT a general process list and NOT a `ps` substitute: every other process — vitest, tsc, npm, gate/deploy scripts, containers — is dropped before you see it, so a short/empty result means "no agent processes of those kinds", never "nothing is running".',
  capability: 'intel:read',
  guidance: {
    when: `You specifically want the AGENT inventory: which delegates / orchestrator children / pty hosts / paperclip / next-servers are up, and under which harness + cwd. The /dev panel view.`,
    notWhen: `NOT for "what is running on this host" — it filters to six agent shapes and silently drops the rest, so it will answer that question WRONG rather than empty. Plain \`ps\`/\`pgrep\` is the correct tool there and is never gated (D-009). NOT for "is MY job done" (vitest/tsc/gate/deploy/rig): those classify as 'other' and are never returned — start such a job with \`capability:bash { run_in_background: true }\` and poll \`capability:bash_output\`, which also survives a carry-respawn / cold-loop wake where a native run_in_background handle does not (EI-16611). For the ledger-backed live task inventory (who launched it, for which work-item, what it costs) use \`processes:list\`; for delegates, \`delegates:list\`.`,
    seeAlso: [
      'capability:bash_output (did MY background job finish, and what did it print)',
      'dev:sessions (the dev session list)',
      'dev:restart (restart a wedged service)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    kinds: z.array(z.enum(KIND_ENUM)).optional(),
  }),
  async handler(args) {
    const result = await listProcesses({ kinds: args.kinds });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count: result.processes.length, processes: result.processes }),
        },
      ],
    };
  },
});
