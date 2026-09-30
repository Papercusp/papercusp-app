/**
 * goals:set-output-schema — declare (or clear) a goal's own JSON Schema for
 * what it PRODUCES (work-on-everything-goal-2026-08-23 P-021, migration 927).
 *
 * The goal sibling of plans:set-output-schema. Same fail-loud declare rule as
 * the input side (908's reasoning): a schema that cannot compile could not
 * have its fields checked at wind-down, and the wind-down gate must never
 * render "could not check" as "nothing was promised".
 *
 * Consequence of declaring: disposition 'achieved' then REQUIRES every
 * declared-required output filled (`outputs` on loop:end / session:end) —
 * optional to DECLARE, mandatory to FILL once declared, D-017's rule carried
 * over. 'killed' stays lenient (an abandoned goal need not have produced).
 *
 * Datatype-annotated fields (`{ datatype: 'email-message' }`, D-004) compile
 * fine (the shared ajv seam runs strict:false); the canonical-shape check at
 * wind-down is follow-up wiring — plan publication already enforces it and the
 * evaluation seam takes `datatypeSchemas`.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';
import { activeWorkspaceId } from '../../workspace-registry';
import { isCompilableSchema, jsonSchemaRequiredKeys } from '../../json-schema-validation';
import { assertGoalWriteAuthorityForCaller } from '../../goals/write-authority';

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'goals:set-output-schema',
  needsWorkspaceTx: true,
  description:
    "Declare a goal's own JSON Schema for what it PRODUCES (the `output_schema` jsonb, P-021). Refused fail-loud unless the schema ajv-compiles. Once declared, disposition 'achieved' requires every declared-required output filled (via `outputs` on loop:end / session:end); 'killed' stays lenient. Pass schema:null to un-declare.",
  guidance: {
    when: "Promising a goal's product in a machine-readable shape — what a downstream consumer (a chained plan, the package pipeline) can rely on at wind-down.",
    notWhen:
      'Reporting the VALUES — `outputs` on loop:end / session:end at wind-down. Declaring the goal\'s arguments — goals:set-input-schema.',
    chaining:
      "goals:set-output-schema { goalId, schema } → … pursue … → loop:end { disposition: 'achieved', outputs } (refused while a declared output is unfilled).",
    seeAlso: [
      'goals:set-input-schema (the argument-list half)',
      'plans:set-output-schema (the plan sibling this mirrors)',
    ],
  },
  capability: 'goals:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: z.object({
    goalId: z.string().min(1).describe('Goal id.'),
    schema: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe(
        "The goal's JSON Schema for what it produces. `required: [...]` marks the outputs an 'achieved' wind-down must fill. A field may reference a canonical datatype (`{ datatype: 'email-message' }`, D-004). Pass null to un-declare.",
      ),
  }),
  async handler(args, ctx) {
    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    if (!workspaceId) return text({ error: 'no_workspace' }, true);
    if (args.schema !== null && !isCompilableSchema(args.schema)) {
      return text(
        {
          error: 'bad_schema',
          goalId: args.goalId,
          hint:
            'The schema is not a compilable JSON Schema, so it is rejected here rather than ' +
            'stored — a promise that cannot be checked must never pass as one that was.',
        },
        true,
      );
    }
    await assertGoalWriteAuthorityForCaller(ctx, workspaceId, ctx.tx as never);
    const sql = ctx.tx as unknown as GoalSqlTag;
    const rows = await sql<Array<{ id: string }>>`
      UPDATE harness_shared.goals
         SET output_schema = ${args.schema ? JSON.stringify(args.schema) : null}::jsonb,
             updated_at = now()
       WHERE id = ${args.goalId} AND workspace_id = ${workspaceId}
       RETURNING id`;
    if (rows.length === 0) return text({ error: 'not_found', goalId: args.goalId }, true);
    return text({
      ok: true,
      goalId: args.goalId,
      cleared: args.schema === null,
      required: jsonSchemaRequiredKeys(args.schema),
    });
  },
});
