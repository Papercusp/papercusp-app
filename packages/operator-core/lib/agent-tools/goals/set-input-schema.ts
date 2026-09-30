/**
 * goals:set-input-schema — declare (or clear) a goal's own JSON Schema for its
 * start-time INPUTS (work-on-everything-goal-2026-08-23 P-021, migration 927).
 *
 * The goal sibling of plans:set-input-schema, simpler by construction: a goal
 * has ONE schema source (no code-registry `template:` competitor, so no
 * mutual-exclusion case), and one row (no plan-lock/revision machinery — the
 * write is a scoped UPDATE like every other goal mutation).
 *
 * VALIDATED-ON-DECLARE, 714's load-bearing rule: the schema must ajv-compile
 * before it is persisted, because a schema that cannot compile could not have
 * its required fields checked at start time, and the start gate must never
 * render "could not check" as "nothing was required".
 *
 * Mostly useful BEFORE a goal starts (a stub via goals:create, or the P-006
 * package pipeline stamping schemas at install); on an already-started goal it
 * changes what a future re-start / package upgrade would collect, not the
 * inputs already recorded.
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
  name: 'goals:set-input-schema',
  needsWorkspaceTx: true,
  description:
    "Declare a goal's own JSON Schema for its start-time INPUTS (the `input_schema` jsonb, P-021) — `required: [...]` is what the start gate enforces. Refused fail-loud unless the schema ajv-compiles, so the start gate can never be left unable to check. Pass schema:null to un-declare. The VALUES are collected at the start door (goals:start { inputs }) and recorded on the goal row.",
  guidance: {
    when: "Giving a goal an argument list — the typed fields a start must be supplied with (budget window, scope, …). Usually on a stub before it starts, or from the package pipeline.",
    notWhen:
      'Supplying the VALUES — goals:start { inputs } collects them at start. Declaring what the goal PRODUCES — goals:set-output-schema. Creating the goal — goals:create / goals:start (both take the schemas directly).',
    chaining:
      'goals:set-input-schema { goalId, schema } → goals:start / the P-017 package start door (refused while a required input is missing).',
    seeAlso: [
      'goals:set-output-schema (the declared-product half)',
      'plans:set-input-schema (the plan sibling this mirrors)',
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
        "The goal's JSON Schema for its start-time inputs. List mandatory fields in `required: [...]` — that array is what the start gate enforces. `additionalProperties: false` makes a mistyped argument name an error rather than a silently ignored key. Pass null to un-declare.",
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
            'stored — a schema that cannot compile could not be checked at start time, and ' +
            'the start gate must never treat "could not check" as "nothing was required".',
        },
        true,
      );
    }
    await assertGoalWriteAuthorityForCaller(ctx, workspaceId, ctx.tx as never);
    const sql = ctx.tx as unknown as GoalSqlTag;
    const rows = await sql<Array<{ id: string }>>`
      UPDATE harness_shared.goals
         SET input_schema = ${args.schema ? JSON.stringify(args.schema) : null}::jsonb,
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
