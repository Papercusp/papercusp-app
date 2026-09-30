/**
 * events:graph — the inspectable reactive graph (event-reaction-system D-010).
 *
 * "What fires what": every registered reaction rule (from the Events file, the
 * `emits:` desugar, and plugin/blueprint contributions) as `on → fire` edges,
 * plus — with `recent:true` — the reactions that ACTUALLY fired, read from
 * `tool_invocations` with their cause-chain (every reaction is audited there, so
 * "why did this fire?" is always answerable). Hidden control flow is the events
 * system's main risk; this tool is the mitigation.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { listReactionRules, reactionGraph } from '../../events';
import type { Condition } from '@papercusp/rules';
import type { ToolInvocationEvent } from '../../events';

/** Describe a rule's `when` without leaking a non-serializable predicate. */
function describeCondition(when: Condition<ToolInvocationEvent> | undefined): {
  kind: 'none' | 'predicate' | 'data';
  data?: unknown;
} {
  if (when === undefined) return { kind: 'none' };
  if (typeof when === 'function') return { kind: 'predicate' };
  return { kind: 'data', data: when };
}

interface ReactionAuditRow {
  tool_name: string;
  status: string;
  invoked_at: string;
  duration_ms: number | null;
  reaction: unknown;
}

export default defineTool({
  name: 'events:graph',
  description:
    'Inspect the event-reaction reactive graph: every registered rule as an `on → fire` edge (the Events file + emits desugar + plugin/blueprint rules), with its condition kind, mode, and source. With recent:true, also returns the reactions that actually fired (from tool_invocations) with their cause-chain — the answer to "why did this fire?".',
  capability: 'events:read',
  guidance: {
    when: 'You want to see the declarative "when X, fire Y" wiring — what reactions exist, what triggers them, and (recent:true) what has actually fired lately with its cause-chain. Pass `on` to see only the rules that fire on a given tool.',
    notWhen:
      'To register a rule, use the events registry API in code (registerReactionRule) or a tool\'s `emits` field — there is no runtime "add a rule" tool by design (rules are curated code). For the live worker activity stream use `activity:recent`.',
    seeAlso: ['events:status (live pending awaits / deliveries)', 'activity:recent (the live worker activity stream)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    /** Only rules triggered by this tool name (e.g. 'coord:handoff'). */
    on: z.string().max(256).optional(),
    /** Also return the reactions that actually fired recently (from tool_invocations). */
    recent: z.boolean().optional(),
    /** Max recent-reaction rows (default 50, max 200). */
    limit: z.number().int().positive().max(200).optional(),
  }),
  async handler(args, ctx) {
    const allRules = listReactionRules();
    const rules = (
      args.on
        ? allRules.filter((r) => ([] as string[]).concat(r.on as string | string[]).includes(args.on as string))
        : allRules
    ).map((r) => ({
      id: r.id,
      on: r.on,
      fire: r.fire,
      mode: r.mode ?? 'durable',
      onlyOnSuccess: r.onlyOnSuccess ?? true,
      source: r.source ?? 'unknown',
      capability: r.capability,
      condition: describeCondition(r.when),
      argsKind: typeof r.args === 'function' ? 'function' : r.args === undefined ? 'none' : 'static',
    }));
    const edges = args.on ? reactionGraph().filter((e) => e.on === args.on) : reactionGraph();

    const out: Record<string, unknown> = { rules, edges, ruleCount: rules.length };

    if (args.recent) {
      const limit = args.limit ?? 50;
      const { sql } = getOrgPg();
      const workspacePredicate = ctx.workspaceId == null ? true : sql`workspace_id = ${ctx.workspaceId}`;
      // Every reaction is fired under spawn_id='event-reaction' and audited with
      // metadata_json.reaction = { depth, chain, ruleId, rootRunId } (D-010).
      const rows = await sql<ReactionAuditRow[]>`
        SELECT tool_name, status, invoked_at, duration_ms, metadata_json -> 'reaction' AS reaction
        FROM harness_shared.tool_invocations
        WHERE spawn_id = 'event-reaction'
          AND ${workspacePredicate}
        ORDER BY invoked_at DESC
        LIMIT ${limit}
      `;
      out.recent = rows;
      out.recentCount = rows.length;
    }

    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
  },
});
