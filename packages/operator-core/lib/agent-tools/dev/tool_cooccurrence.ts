/**
 * dev:tool_cooccurrence — which agent tools fire TOGETHER in one turn.
 *
 * Groups harness_shared.tool_invocations by spawn_id (one agent turn) and
 * computes pairwise co-occurrence with support / confidence / lift over
 * MCP-transport calls only. The deterministic candidate-generator for
 * wrapper/bundle tools and for code-recipes promotion (plan
 * tool-call-batching-wrappers, P-001/P-004). It NOMINATES bonded pairs;
 * a human/gate judges determinism before anything is wrapped (D-009).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { toolCooccurrence } from '../../dev-data';

export default defineTool({
  name: 'dev:tool_cooccurrence',
  profile: 'engineer',
  description:
    'Pairwise tool co-occurrence (support / confidence / lift) grouped by spawn_id over MCP tool_invocations — which tools get invoked together in one agent turn. The deterministic candidate-generator for wrapper/bundle tools.',
  capability: 'intel:read',
  guidance: {
    when: `Find which agent tools are invoked TOGETHER in the same turn (spawn), ranked by support / confidence / lift — to spot bundle/wrapper candidates and feed code-recipes candidate generation. Analytical / offline; MCP-transport calls only.`,
    notWhen: `For per-tool counts or latency use \`dev:telemetry\`; for a forensic per-agent timeline use \`audit:list\`. A high lift on tiny support is spurious — keep a support floor (minSupport), and remember lift != determinism: this NOMINATES pairs, a human/gate judges whether the steps are mechanical before wrapping.`,
    chaining: `dev:tool_cooccurrence (find bonded pairs) → judge determinism → wrap as a composite (e.g. extend coord:orient) or feed code-recipes promotion.`,
    seeAlso: [
      'dev:telemetry (raw per-tool call counts)',
      'dev:code_run_adoption (adoption view built on co-occurrence)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    workspaceIds: z.array(z.string()).nullable().optional(),
    hours: z.number().int().positive().max(168).optional(),
    /** Noise floor: drop pairs seen in fewer than this many turns. Default 3. */
    minSupport: z.number().int().positive().max(100000).optional(),
    limit: z.number().int().positive().max(500).optional(),
    orderBy: z.enum(['support', 'lift', 'confidence']).optional(),
  }),
  async handler(args) {
    const result = await toolCooccurrence({
      workspaceIds: args.workspaceIds ?? null,
      hours: args.hours,
      minSupport: args.minSupport,
      limit: args.limit,
      orderBy: args.orderBy,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            count: result.entries.length,
            total_turns: result.totalTurns,
            entries: result.entries,
          }),
        },
      ],
    };
  },
});
