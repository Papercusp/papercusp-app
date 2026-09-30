/**
 * intel:artifacts — list pack/diff scratch-dir outputs for a harness.
 *
 * Backs the Intel panel's Pack + Diff sub-tabs. Reads from
 * harness_shared.tool_invocations_artifacts (Migration 048) which is
 * just the subset of tool_invocations where output_ref is set + status
 * is 'ok'. Today the only producers are repomix.pack and
 * code2prompt.{diff,pack}.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';

export default defineTool({
  name: 'intel:artifacts',
  needsWorkspaceTx: true,
  profile: 'engineer',
  guidance: {
    when: 'You need the Intel-panel-shaped view of recent artifacts — grouped + summarized for UI display.',
    notWhen: 'For loading a specific artifact body, use `artifacts:load`. For listing artifacts a tool produced, use the tool\'s response. intel:artifacts is the panel feed.',
  },
  capability: 'intel:read',
  args: z.object({
    harness: z.string().min(1),
    /** Optional kind filter. 'pack' matches *.pack tools; 'diff' matches *.diff tools. */
    kind: z.enum(['pack', 'diff', 'all']).default('all'),
    sinceMs: z.number().int().optional(),
    limit: z.number().int().positive().max(500).default(100),
  }),
  async handler(args, ctx) {
    const sinceMs = args.sinceMs ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
    // SQL-friendly suffix predicates. .pack tools end with '.pack',
    // .diff tools end with '.diff'. 'all' keeps the predicate
    // tautological so the index plan is unchanged.
    const includePack = args.kind === 'pack' || args.kind === 'all';
    const includeDiff = args.kind === 'diff' || args.kind === 'all';
    type Row = {
      id: number;
      plugin_name: string;
      tool_name: string;
      role: string;
      feature_id: string | null;
      run_id: string | null;
      spawn_id: string;
      invoked_at: Date;
      duration_ms: number | null;
      output_ref: string | null;
      output_size: number | null;
    };
    const rows: Row[] = await ctx.tx`
      SELECT id, plugin_name, tool_name, role, feature_id, run_id, spawn_id,
             invoked_at, duration_ms, output_ref, output_size
        FROM harness_shared.tool_invocations_artifacts
       WHERE harness_slug = ${args.harness}
         AND invoked_at >= to_timestamp(${sinceMs}::double precision / 1000.0)
         AND (
           (${includePack}::boolean AND tool_name LIKE '%.pack')
           OR (${includeDiff}::boolean AND tool_name LIKE '%.diff')
         )
       ORDER BY invoked_at DESC
       LIMIT ${args.limit}
    `;
    return {
      data: rows.map((r) => ({
        id: r.id,
        pluginName: r.plugin_name,
        toolName: r.tool_name,
        role: r.role,
        featureId: r.feature_id,
        runId: r.run_id,
        spawnId: r.spawn_id,
        invokedAtMs: new Date(r.invoked_at).getTime(),
        durationMs: r.duration_ms,
        outputRef: r.output_ref,
        outputSize: r.output_size,
        kind: r.tool_name.endsWith('.pack') ? 'pack' : r.tool_name.endsWith('.diff') ? 'diff' : 'other',
      })),
    };
  },
});
