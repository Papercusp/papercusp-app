/**
 * plans:set-input-schema — declare (or clear) a plan's own JSON Schema for its
 * INPUTS (plan-structured-inputs-2026-08-01 P-003).
 *
 * This is the second of two schema SOURCES a plan can have. A plan declares EITHER
 * a code-registry `template:` type (zod, in-tree — e.g. `rubric`) OR this
 * runtime-authored JSON Schema, never both (D-002 / D-008 Q3): mutual exclusion
 * means the precedence question never arises, and relaxing it later is additive
 * whereas retrofitting it onto plans that already declare both would not be.
 * The runtime-authored source has to exist because agents author plans while the
 * operator runs and cannot ship code to add a registry type.
 *
 * The VALUES this schema constrains live in the same `template_data` jsonb the
 * registry path uses (D-001 — one value slot, two schema sources). Its `required`
 * array is what makes a field mandatory: `plans:set-template-data` still accepts
 * PARTIAL data (a plan is authored incrementally — D-004), and completeness is
 * enforced at the START doors by evaluatePlanStartReadiness (P-005/P-006).
 *
 * VALIDATED-ON-DECLARE: the schema must ajv-compile before it is persisted. That
 * ordering is load-bearing — a schema that cannot compile could not have its
 * required fields checked at start time, and the gate must never render "could not
 * check" as "nothing was required". Rejecting here keeps that from ever being a
 * question the gate has to answer.
 *
 * Advisory-locked, version-bumped and revisioned through withPlanLock, exactly like
 * plans:set-template-data.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, type InputSchemaPatch } from './with-plan-lock';
import { parsePlan } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { isCompilableSchema, jsonSchemaRequiredKeys } from '../../json-schema-validation';
import { softText, clampText, LIMITS } from '../limits';

export type SetInputSchemaValue =
  | { ok: true; slug: string; required: string[]; cleared: boolean }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'legacy_plan' }
  | { ok: false; code: 'template_conflict'; template: string }
  | { ok: false; code: 'bad_schema' };

/**
 * The pure declare-time decision — the sibling of evaluateSetTemplateData
 * (set-template-data.ts). Exported so it unit-tests without a live PG; the handler
 * runs exactly this inside withPlanLock. Never throws.
 */
export function evaluateSetInputSchema(
  current: string | null,
  schema: Record<string, unknown> | null,
  slug: string,
): { newBody: null; inputSchema?: InputSchemaPatch; value: SetInputSchemaValue } {
  if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };
  const parsed = parsePlan(current, { filePath: `${slug}.md` });
  if (parsed.isLegacy) return { newBody: null, value: { ok: false, code: 'legacy_plan' } };

  // Clearing is always allowed — un-declaring a plan's inputs cannot conflict with
  // anything, and a plan wedged by a bad declaration must have a way out.
  if (schema === null) {
    return {
      newBody: null,
      inputSchema: { schema: null },
      value: { ok: true, slug, required: [], cleared: true },
    };
  }

  const template = parsed.frontmatter.template?.trim();
  if (template) {
    return { newBody: null, value: { ok: false, code: 'template_conflict', template } };
  }
  if (!isCompilableSchema(schema)) {
    return { newBody: null, value: { ok: false, code: 'bad_schema' } };
  }
  return {
    newBody: null,
    inputSchema: { schema },
    value: { ok: true, slug, required: jsonSchemaRequiredKeys(schema), cleared: false },
  };
}

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
  schema: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe(
      "The plan's JSON Schema for its inputs. List mandatory fields in `required: [...]` — that array is what the start gate enforces. `additionalProperties: false` makes a mistyped argument name an error rather than a silently ignored key. Pass null to un-declare the plan's inputs.",
    ),
  rationale: softText(LIMITS.ANNOTATION)
    .optional()
    .describe('Why — stored on the plan revision. Auto-truncated to 2000 chars if longer.'),
});

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:set-input-schema',
  description:
    "Declare a plan's own JSON Schema for its INPUTS (the `input_schema` jsonb) — mark fields required or optional via the schema's `required` array. Rejected fail-loud unless the schema ajv-compiles, so the start gate can never be left unable to check. Mutually exclusive with a code-registry `template:` type. The VALUES live in template_data (plans:set-template-data), which still accepts partial data; completeness is enforced when the plan STARTS. Advisory-locked, version-bumped, revisioned. Pass schema:null to un-declare.",
  guidance: {
    when: "Giving a plan an argument list — the fields a run must be supplied with. Required-ness lives in the schema's `required` array.",
    notWhen:
      'Supplying the VALUES for those fields — plans:set-template-data. Declaring a code-registry template TYPE — plans:set-frontmatter-field { key:"template" } (mutually exclusive with this). Reading the schema back — plans:get-input-schema.',
    chaining:
      'plans:set-input-schema { slug, schema } → plans:set-template-data { slug, data } (the values) → plans:start / plans:launch (refused while a required field is missing).',
    seeAlso: [
      'plans:get-input-schema (read it back, with the required-field list)',
      'plans:set-template-data (supply the values this schema constrains)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      clampText(args.rationale, LIMITS.ANNOTATION) ??
        (args.schema === null ? 'clear input_schema' : 'set input_schema'),
      harnessSlug ? { harnessSlug } : {},
    );

    const result = await withPlanLock<SetInputSchemaValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: 'plans:set-input-schema',
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current) =>
        evaluateSetInputSchema(current, args.schema as Record<string, unknown> | null, args.slug),
    );

    if (result.kind === 'busy') {
      return text(
        {
          error: 'busy',
          busy: result.busy.map((b) => ({
            path: b.path,
            owner_label: b.owner_label,
            intent: b.intent,
            expires_ts: b.expires_ts,
          })),
        },
        true,
      );
    }

    const v = result.value;
    if (!v.ok) {
      const payload: Record<string, unknown> = { error: v.code, slug: args.slug };
      if (v.code === 'template_conflict') {
        payload.template = v.template;
        payload.hint =
          `This plan already declares the code-registry template type '${v.template}'. A plan ` +
          `has ONE schema source: clear the template frontmatter first ` +
          `(plans:set-frontmatter-field { key:"template", value:"" }) if you meant to author ` +
          `an input schema instead.`;
      } else if (v.code === 'bad_schema') {
        payload.hint =
          'The schema is not a compilable JSON Schema, so it is rejected here rather than ' +
          'stored — a schema that cannot compile could not be checked at start time, and the ' +
          'start gate must never treat "could not check" as "nothing was required".';
      }
      return text(payload, true);
    }

    // Refresh the plans rail so any schema-derived facet updates immediately.
    try {
      const { notifySyncInvalidate } = await import('../../sync-sse');
      await notifySyncInvalidate('plans.list', undefined);
    } catch {
      /* best-effort — the next natural refresh picks it up */
    }

    return text({
      ok: true,
      slug: v.slug,
      cleared: v.cleared,
      required: v.required,
      version: result.version,
      revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
      ...(result.activationAudit ? { activationAudit: result.activationAudit } : {}),
    });
  },
});
