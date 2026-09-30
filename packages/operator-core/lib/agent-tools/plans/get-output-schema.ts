/**
 * plans:get-output-schema — read a plan's declared OUTPUT schema and which outputs a
 * completing run is required to publish (external-triggers-gmail-slack-2026-08-22
 * P-026 / D-017, mig 908).
 *
 * The structured read complement of plans:set-output-schema, and the symmetric half
 * of plans:get-input-schema.
 *
 * Deliberately narrower than its input sibling, and the asymmetry is the point.
 * get-input-schema also answers "may this plan start" — it returns `missing` and
 * `ready` from the start gate's own oracle, because inputs are checked at a door
 * that exists NOW and three callers would otherwise re-derive that rule. Outputs
 * have no such door yet: they are checked when a run COMPLETES, against that run's
 * published values, which are a property of the run and not of the plan. So this
 * verb answers only what the plan itself can honestly answer — what it PROMISES —
 * and does not manufacture a readiness verdict it has no oracle for. Asking a plan
 * "are your outputs satisfied?" is a category error; the run is what has outputs.
 *
 * `chainable` is the one derived field, and it exists because it is the actual
 * question every caller has: may this plan be the UPSTREAM half of a chain edge
 * whose downstream step is DETERMINISTIC (a recipe, or a one-step tool call)? Per
 * D-015 that requires declared outputs — a deterministic target has no agent to
 * interpret a loose payload for it. A plan with no declared outputs may still chain
 * into a PLAN target, which can take the redacted payload as agent context. So
 * `chainable:false` never means "misconfigured"; it means "terminal-only, or chain
 * it into a plan".
 *
 * Read-only.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getPlanRow } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { bulkContent, mergeIds, runBulk } from '../_bulk';
import { jsonSchemaRequiredKeys } from '../../json-schema-validation';

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z.string().min(1).optional().describe('Plan slug (filename stem).'),
    slugs: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .optional()
      .describe('Plan slugs to read in one call.'),
  })
  .refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
    message: 'pass `slug` or `slugs`',
  });

export default defineTool({
  name: 'plans:get-output-schema',
  description:
    "Read what a plan PROMISES to produce: { declared, outputSchema, required, chainable, version }. `required` is the outputs a completing run must publish; `chainable` says whether this plan may be the upstream half of a chain edge into a DETERMINISTIC step (which needs declared outputs — D-015). `declared:false` is a valid terminal-only plan, not a misconfiguration. Read-only.",
  guidance: {
    when: "Finding out what a plan produces — before wiring it as the upstream half of a chain, or rendering what a completed run will publish. `chainable` answers the wiring question directly.",
    notWhen:
      'Declaring the schema — plans:set-output-schema. Reading what the plan is GIVEN — plans:get-input-schema. Reading what a specific run actually published — that lives on the run, not the plan.',
    chaining:
      'plans:get-output-schema { slug } → if `chainable`, the plan may feed a deterministic downstream step; if not, chain it into a PLAN target instead, or declare outputs with plans:set-output-schema.',
    seeAlso: [
      'plans:set-output-schema (declare it)',
      'plans:get-input-schema (the symmetric half — what the plan is GIVEN, plus its start verdict)',
    ],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'kettle'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) => {
        const row = await getPlanRow(slug, opts);
        if (!row) return { ok: false as const, slug, error: 'not_found' };
        const schema = (row.outputSchema ?? null) as Record<string, unknown> | null;
        return {
          ok: true as const,
          slug: row.planSlug,
          // Absence is a real, readable state (D-017), so it is reported as one
          // rather than left for the caller to infer from a null.
          declared: schema !== null,
          outputSchema: schema,
          required: schema ? jsonSchemaRequiredKeys(schema) : [],
          // D-015: a deterministic downstream step has no agent to interpret a loose
          // payload, so it may only be fed by an upstream that declared its product.
          chainable: schema !== null,
          version: row.version,
        };
      },
      { keyOf: (slug) => ({ slug }) },
    );
    return bulkContent(env);
  },
});
