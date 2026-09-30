/**
 * plans:get-input-schema — read a plan's declared input schema, which fields are
 * REQUIRED, and which of those are currently unsatisfied
 * (plan-structured-inputs-2026-08-01 P-003).
 *
 * The structured read complement of plans:set-input-schema. Deliberately returns
 * `missing` alongside the schema: "what does this plan need before it can start"
 * is the question every caller of this verb actually has — a UI rendering the input
 * form, an agent about to launch a plan, a human staring at a refused start — and
 * making them re-derive it from `required` minus the keys of `templateData` would
 * be three call sites re-implementing the gate's own rule slightly differently.
 * The value comes from the SAME helper the start gate uses, so the answer here and
 * the refusal there cannot disagree.
 *
 * Also reports `source` so a caller can tell the two schema sources apart without
 * inferring it: 'input-schema' (plan-authored JSON Schema), 'template' (a
 * code-registry zod type), or 'none'. Read-only.
 *
 * P-013 widened this into the ONE read the admin input form needs: it also returns
 * the current `values` and the full start verdict (`ready`, plus the refusal's
 * code/issues/hint). The alternative was a UI chaining get-input-schema +
 * get-template-data and then re-deriving readiness client-side — a third
 * implementation of the gate's rule, in TypeScript the gate does not own.
 *
 * That widening also FIXED a disagreement this file's own header promised could not
 * happen. `required`/`missing` were computed with the JSON-Schema-only helpers, which
 * see nothing on a `template:` (zod registry) plan — so such a plan reported
 * `missing: []` while plans:start refused it with `missing: ['x']`. Both now come
 * from `planRequiredKeys` / `evaluatePlanStartReadiness`, the very functions the gate
 * calls, so the promise in the header is now structural rather than aspirational.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getPlanRow } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { bulkContent, mergeIds, runBulk } from '../_bulk';
import { evaluatePlanStartReadiness, planRequiredKeys } from './plan-input-validation';

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
  name: 'plans:get-input-schema',
  description:
    "Read a plan's input contract AND whether it may start: { source: 'input-schema'|'template'|'none', inputSchema, template, required, missing, values, ready, code?, issues?, hint?, version }. `required`/`missing`/`ready` come from the start gate's own oracle, so they cannot disagree with a refusal — `ready:false` here means every start door would refuse, and `hint` is that refusal's message. `values` is the currently-supplied data, so one call renders a complete input form. Read-only.",
  guidance: {
    when: "Finding out what a plan needs before it can start — rendering an input form, or checking why a start was refused. `missing` + `hint` answer it directly.",
    notWhen:
      'Declaring the schema — plans:set-input-schema. Supplying the values — plans:set-template-data. Reading the values themselves — plans:get-template-data.',
    chaining:
      'plans:get-input-schema { slug } → plans:set-template-data { slug, data } to fill `missing` → plans:start.',
    seeAlso: [
      'plans:set-input-schema (declare it)',
      'plans:get-template-data (the values this schema constrains)',
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
        const schema = (row.inputSchema ?? null) as Record<string, unknown> | null;
        const source = schema ? 'input-schema' : row.template ? 'template' : 'none';
        // Both of these are the gate's OWN functions, not a re-derivation: whatever a
        // start door would say about this plan right now is what a caller reads here.
        // A registry `template` plan keeps its required-ness in zod rather than a
        // readable array, and planRequiredKeys introspects that shape — which is why
        // `required` is now populated for both sources instead of only the JSON one.
        const ref = { template: row.template, inputSchema: row.inputSchema };
        const readiness = evaluatePlanStartReadiness(ref, row.templateData);
        return {
          ok: true as const,
          slug: row.planSlug,
          source,
          inputSchema: schema,
          template: row.template,
          required: planRequiredKeys(ref),
          missing: readiness.ready ? [] : readiness.missing,
          // The values the schema constrains — returned so a form can render its
          // current state without a second round-trip to plans:get-template-data.
          values: row.templateData ?? null,
          // The verdict a start door would give, verbatim. `ready: true` means every
          // start door would admit this plan as it stands.
          ready: readiness.ready,
          ...(readiness.ready
            ? {}
            : { code: readiness.code, issues: readiness.issues, hint: readiness.hint }),
          version: row.version,
        };
      },
      { keyOf: (slug) => ({ slug }) },
    );
    return bulkContent(env);
  },
});
