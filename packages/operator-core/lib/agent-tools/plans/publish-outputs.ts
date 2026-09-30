/**
 * plans:publish-outputs — a completing plan run PUBLISHES the values its plan promised
 * (external-triggers-gmail-slack-2026-08-22 P-026 / D-017, mig 908).
 *
 * The third door of the outputs feature, after set-output-schema (declare) and
 * get-output-schema (read). D-017 states the publication rule directly: "the executing
 * agent fills declared outputs at plan-run completion; a declared-but-unfilled output
 * fails the run loudly rather than silently chaining undefined values."
 *
 * WHY A SEPARATE VERB rather than an argument on a status transition: a run reaches a
 * terminal state through several paths, including ones no agent is present for — the
 * orphan sweep transitions an abandoned `running` row to `failed`, and the reconciler
 * settles others. Attaching publication to the status write would put a promise-keeping
 * gate on code paths that exist precisely BECAUSE no one is there to keep the promise.
 * Publication is an act of the executing agent, so it gets its own door, and the
 * validation is refused loudly rather than defaulted.
 *
 * The decision itself is pure and lives in plan-outputs.ts, shared with nothing else
 * yet — but deliberately factored that way so the chained-binding engine (D-015), when
 * it carries these values on a plan-completed event, validates with the same function
 * rather than a second implementation that could disagree about what "filled" means.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getPlanRow } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { setPlanRunOutputs } from './runs';
import { collectDatatypeRefs, evaluatePublishOutputs, type DatatypeSchemas } from './plan-outputs';

const argsSchema = z.object({
  harness: harnessArg,
  runId: z.number().int().positive().describe('The plan_runs id of the completing run.'),
  slug: z.string().min(1).describe("The run's plan slug (filename stem)."),
  outputs: z
    .record(z.string(), z.unknown())
    .describe(
      "The values this run produced, keyed by the output names the plan declared. Every field in the schema's `required` array must be present and non-null — a declared-but-unfilled output is refused rather than published, so a downstream step never receives undefined.",
    ),
});

const text = (payload: Record<string, unknown>, isError = false) => ({
  data: payload,
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:publish-outputs',
  description:
    "Publish a completing plan run's declared OUTPUTS to plan_runs.outputs, validated against the plan's output_schema. Refuses loudly — never partially — when a declared output is unfilled (`missing_outputs`), when the values do not satisfy the schema (`invalid_outputs`), or when a field bound to a canonical datatype does not match that shape (`datatype_mismatch`). A plan that declared no outputs refuses with `no_outputs_declared`.",
  guidance: {
    when: "Finishing a plan run whose plan declares an output schema — fill every required output and publish before the run settles, so a chained downstream step can consume typed values.",
    notWhen:
      'Declaring what a plan produces — plans:set-output-schema. Checking what it promised — plans:get-output-schema. A plan with no declared outputs needs no publication at all.',
    chaining:
      'plans:get-output-schema { slug } (what must be filled) → plans:publish-outputs { runId, slug, outputs } → the run may then settle.',
    seeAlso: [
      'plans:get-output-schema (what this run is required to publish)',
      'plans:set-output-schema (declare the promise)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const row = await getPlanRow(args.slug, opts);
    if (!row) return text({ error: 'not_found', slug: args.slug }, true);

    const schema = (row.outputSchema ?? null) as Record<string, unknown> | null;

    // Resolve the canonical shapes this schema references (D-004) so each bound field
    // is held to the PLATFORM type rather than to whatever the plan restated. A
    // datatype we cannot resolve contributes no constraint — it is not silently
    // treated as a mismatch, because an unreadable registry is not evidence the value
    // is wrong; the declare door already rejected dangling references.
    const datatypeSchemas: Record<string, Record<string, unknown> | null> = {};
    const refs = schema ? collectDatatypeRefs(schema) : [];
    if (refs.length > 0) {
      try {
        const [{ getOrgPg }, { getDatatype }, { activeWorkspaceId }] = await Promise.all([
          import('@papercusp/db-org'),
          import('../../datatype-registry-store'),
          import('../../workspace-registry'),
        ]);
        const { sql } = getOrgPg();
        const wsId = activeWorkspaceId();
        await Promise.all(
          refs.map(async (name) => {
            const dt = await getDatatype(sql, wsId, name);
            datatypeSchemas[name] =
              (dt?.payloadSchema as Record<string, unknown> | null | undefined) ?? null;
          }),
        );
      } catch {
        /* best-effort — an unresolved datatype imposes no extra constraint */
      }
    }

    const verdict = evaluatePublishOutputs(schema, args.outputs, datatypeSchemas as DatatypeSchemas);

    if (!verdict.ok) {
      const payload: Record<string, unknown> = {
        error: verdict.code,
        slug: args.slug,
        runId: args.runId,
      };
      if (verdict.code === 'missing_outputs') {
        payload.missing = verdict.missing;
        payload.hint =
          `This plan declares ${verdict.missing.length === 1 ? 'an output' : 'outputs'} ` +
          `that this run did not fill: ${verdict.missing.join(', ')}. Publication is ` +
          `refused rather than partially applied — a declared output is a promise to a ` +
          `downstream step, and a deterministic consumer (a recipe or a one-step tool) ` +
          `has no agent to notice an undefined value. Fill every required output, or ` +
          `un-declare the ones this plan does not actually produce with ` +
          `plans:set-output-schema.`;
      } else if (verdict.code === 'invalid_outputs') {
        payload.issues = verdict.errors;
      } else if (verdict.code === 'datatype_mismatch') {
        payload.datatype = verdict.datatype;
        payload.field = verdict.field;
        payload.issues = verdict.errors;
        payload.hint =
          `Output '${verdict.field}' is bound to the canonical datatype ` +
          `'${verdict.datatype}', so it is held to that platform shape rather than to a ` +
          `plan-local restatement of it (D-004). Fix the value, or drop the ` +
          `\`datatype:\` annotation if this field is genuinely not that concept.`;
      } else if (verdict.code === 'no_outputs_declared') {
        payload.hint =
          'This plan declares no output schema, so there is nothing to publish. Outputs ' +
          'are optional by design — a plan with none is a valid terminal-only plan. If ' +
          'this run is meant to produce values, declare them first with ' +
          'plans:set-output-schema.';
      } else if (verdict.code === 'bad_schema') {
        payload.hint =
          "The plan's stored output schema will not compile, so what it promised cannot " +
          'be checked. Re-declare it with plans:set-output-schema (which validates on ' +
          'declare, so this state should be unreachable).';
      }
      return text(payload, true);
    }

    const written = await setPlanRunOutputs(args.runId, verdict.published);
    if (!written) {
      return text(
        {
          error: 'run_not_found',
          runId: args.runId,
          slug: args.slug,
          hint:
            'No plan_runs row matched that id in this workspace. The outputs validated ' +
            'but were not stored — nothing was published.',
        },
        true,
      );
    }

    try {
      const { notifySyncInvalidate } = await import('../../sync-sse');
      await notifySyncInvalidate('plans.runs', undefined);
    } catch {
      /* best-effort — the next natural refresh picks it up */
    }

    return text({ ok: true, runId: args.runId, slug: args.slug, published: verdict.keys });
  },
});
