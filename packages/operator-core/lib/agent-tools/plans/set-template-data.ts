/**
 * plans:set-template-data — write a plan's STRUCTURED template instance data,
 * validated against its template TYPE's registry zod schema on every write
 * (plan-templates-and-rubric-v2-2026-06-20 P-005).
 *
 * A template-instance plan declares a `template:` TYPE in its frontmatter (set via
 * plans:set-frontmatter-field, derived into the `template` column). THIS verb writes
 * the per-plan structured `template_data` jsonb — agents read/write the instance
 * data structured, never as markdown. The write is VALIDATED-ON-WRITE: `data` is
 * checked against the template type's code-registry zod schema
 * (template-registry.validateTemplateData) BEFORE it is persisted — an unknown type
 * or a schema violation rejects fail-loud, never silently stripping. A successful
 * write goes through withPlanLock (advisory-locked, version-bumped, revisioned) —
 * the structured-only path that writes template_data without touching content.
 *
 * The registry is the schema source. When the named type has no registered schema
 * yet (P-006 registers `rubric`; until then the registry may be empty), the write
 * rejects with `unknown_template` + the known types — the graceful no-schema case,
 * not a crash.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, type TemplateDataPatch } from './with-plan-lock';
import { parsePlan, type LegacyReason } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { validatePlanData } from './plan-input-validation';
import { softText, clampText, LIMITS } from '../limits';

export type SetTemplateDataValue =
  | { ok: true; slug: string; template: string | null; source: 'template' | 'input-schema' }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'legacy_plan'; reason?: LegacyReason }
  | { ok: false; code: 'no_template' }
  | { ok: false; code: 'schema_conflict'; template: string }
  | { ok: false; code: 'bad_schema'; issues: string[] }
  | { ok: false; code: 'unknown_template'; template: string; known: string[] }
  | { ok: false; code: 'invalid_data'; template: string | null; issues: string[] };

/**
 * The pure validate-on-write decision for a structured template_data write — the
 * sibling of evaluateSetContent (set-content.ts). Resolves the plan's template TYPE
 * from its `template:` frontmatter, validates `data` against that type's registry
 * zod schema, and returns the `template_data` patch to persist (the schema-COERCED
 * value) or a structured rejection. Exported so it unit-tests without a live PG —
 * the handler runs exactly this inside withPlanLock. Never throws.
 */
export function evaluateSetTemplateData(
  current: string | null,
  data: unknown,
  slug: string,
  inputSchema: unknown = null,
): { newBody: null; templateData?: TemplateDataPatch; value: SetTemplateDataValue } {
  if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };
  const parsed = parsePlan(current, { filePath: `${slug}.md` });
  if (parsed.isLegacy) {
    return {
      newBody: null,
      value: { ok: false, code: 'legacy_plan', reason: parsed.legacyReason ?? undefined },
    };
  }

  const template = parsed.frontmatter.template?.trim() ?? null;
  // P-004: dispatch on whichever schema SOURCE the plan declares — the code-registry
  // zod type or the plan's own JSON Schema (mig 714). Note this validates STRUCTURE
  // only: a required field may be absent and the write still succeeds, because a plan
  // is authored incrementally (D-004). Completeness is the START gate's job, not this
  // one's — evaluatePlanStartReadiness in plan-input-validation.ts.
  const result = validatePlanData({ template, inputSchema }, data);
  if (!result.ok) {
    switch (result.code) {
      // Kept as `no_template` rather than renamed to `no_schema`: this is the
      // long-standing error identity of this verb, and a plan declaring neither
      // source still has no schema to validate data against.
      case 'no_schema':
        return { newBody: null, value: { ok: false, code: 'no_template' } };
      case 'schema_conflict':
        return {
          newBody: null,
          value: { ok: false, code: 'schema_conflict', template: result.template },
        };
      case 'unknown_template':
        return {
          newBody: null,
          value: {
            ok: false,
            code: 'unknown_template',
            template: result.template,
            known: result.known,
          },
        };
      case 'bad_schema':
        return { newBody: null, value: { ok: false, code: 'bad_schema', issues: result.issues } };
      default:
        return {
          newBody: null,
          value: {
            ok: false,
            code: 'invalid_data',
            template: result.template ?? null,
            issues: result.issues,
          },
        };
    }
  }
  // Persist the schema-COERCED data — the registry path returns zod's parsed output;
  // the JSON Schema path validates without coercing and returns `data` unchanged.
  return {
    newBody: null,
    templateData: { data: result.data },
    value: { ok: true, slug, template, source: result.source },
  };
}

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
  data: z
    .unknown()
    .describe(
      'The structured template instance data (jsonb) to write. Validated against the plan\'s template TYPE\'s registry zod schema before persisting — an unknown type or a schema violation is rejected fail-loud.',
    ),
  rationale: softText(LIMITS.ANNOTATION).optional().describe('Why — stored on the plan revision. Auto-truncated to 2000 chars if longer.'),
});

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:set-template-data',
  description:
    "Write a plan's STRUCTURED data (the `template_data` jsonb) — both a template instance's fields AND a plan's input VALUES live here. Validated on write against whichever schema the plan declares: its code-registry `template:` type (zod) or its own `input_schema` (JSON Schema). Rejects fail-loud on an unknown type, a schema violation, or a plan declaring both — never silently strips. PARTIAL data is accepted (plans are authored incrementally); missing REQUIRED fields are caught when the plan STARTS, not here. Advisory-locked, version-bumped, revisioned.",
  guidance: {
    when: "Writing/updating a plan's structured data — a rubric instance's fields, or the input values a parameterized plan will run with.",
    notWhen:
      'Declaring the SCHEMA rather than the values — plans:set-input-schema (plan-authored) or plans:set-frontmatter-field { key:"template" } (registry type). Editing prose/items — plans:set-content. Reading the data back — plans:get-template-data.',
    chaining:
      'declare a schema (plans:set-input-schema | plans:set-frontmatter-field { key:"template" }) → plans:set-template-data { slug, data } → plans:get-input-schema to see what is still missing before starting.',
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
      clampText(args.rationale, LIMITS.ANNOTATION) ?? 'set template_data',
      harnessSlug ? { harnessSlug } : {},
    );

    const result = await withPlanLock<SetTemplateDataValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: 'plans:set-template-data',
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      // `meta.inputSchema` is read INSIDE the lock (P-004), so the data is validated
      // against the plan's schema as of THIS write — a concurrent set-input-schema
      // cannot slip between an unlocked read and the write.
      async (current, meta) =>
        evaluateSetTemplateData(current, args.data, args.slug, meta?.inputSchema ?? null),
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
      if (v.code === 'legacy_plan' && v.reason) {
        payload.reason = v.reason;
      } else if (v.code === 'unknown_template') {
        payload.template = v.template;
        payload.known = v.known;
        payload.hint =
          v.known.length > 0
            ? `No schema registered for template '${v.template}'. Known types: ${v.known.join(', ')}.`
            : `No template schemas are registered yet (P-006 registers 'rubric'). Cannot validate '${v.template}'.`;
      } else if (v.code === 'invalid_data') {
        payload.template = v.template;
        payload.issues = v.issues;
      } else if (v.code === 'no_template') {
        payload.hint =
          'This plan declares no schema, so there is nothing to validate against. Declare one ' +
          'first: plans:set-input-schema { slug, schema } for plan-authored inputs, or ' +
          'plans:set-frontmatter-field { key:"template", value:"<type>" } for a registry type.';
      } else if (v.code === 'schema_conflict') {
        payload.template = v.template;
        payload.hint =
          `This plan declares BOTH the registry template type '${v.template}' and its own ` +
          `input_schema, so which one governs is undefined. Clear one before writing data ` +
          `(plans:set-input-schema { schema: null }, or the template frontmatter).`;
      } else if (v.code === 'bad_schema') {
        payload.issues = v.issues;
        payload.hint =
          "This plan's input_schema is not a compilable JSON Schema, so data cannot be " +
          'validated against it. Re-declare it via plans:set-input-schema.';
      }
      return text(payload, true);
    }

    // Refresh the plans rail so any template-derived facet updates immediately.
    try {
      const { notifySyncInvalidate } = await import('../../sync-sse');
      await notifySyncInvalidate('plans.list', undefined);
    } catch {
      /* best-effort — the next natural refresh picks it up */
    }

    return text({
      ok: true,
      slug: v.slug,
      template: v.template,
      version: result.version,
      revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
      ...(result.activationAudit ? { activationAudit: result.activationAudit } : {}),
    });
  },
});
