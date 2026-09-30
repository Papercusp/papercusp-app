/**
 * plans:set-output-schema — declare (or clear) a plan's own JSON Schema for what it
 * PRODUCES (external-triggers-gmail-slack-2026-08-22 P-026 / D-017, mig 908).
 *
 * The symmetric half of plans:set-input-schema. That verb gave a plan an argument
 * list; this one gives it a RETURN VALUE. Until now a plan could be CALLED but could
 * not RETURN: a completing run left its product only in prose, and any consumer had
 * to re-derive it by reading the plan's output with an agent.
 *
 * That gap is what blocks workflow CHAINING (D-015). A chain is N single-target
 * bindings wired by internal-event edges, and an edge carries the upstream step's
 * product into the downstream step's declared inputs. With no declared outputs the
 * only carriable thing is the raw payload — precisely the rung a DETERMINISTIC
 * target (a recipe, or a one-step tool call) may not rely on, since no agent
 * interprets for it. So without this a chain may end in a plan but never pass
 * THROUGH one.
 *
 * OPTIONAL BY CONSTRUCTION (D-017: "outputs should be optional"). A plan that
 * declares nothing here is unchanged and needs no backfill and no flag. Absence is a
 * meaningful, readable state — "this is a terminal-only plan" — not a missing
 * configuration, and it composes with the mapping-rigor rule across a chain edge: a
 * plan with no declared outputs may still chain into a PLAN target (which can take
 * the loose redacted payload as agent context), while a DETERMINISTIC next step
 * requires the upstream plan to have declared outputs.
 *
 * NO TEMPLATE EXCLUSION — the one deliberate asymmetry with set-input-schema. That
 * verb refuses a plan carrying a code-registry `template:` type because `template`
 * and `input_schema` are two SOURCES for one thing: the shape of the plan's
 * arguments. A `template` says nothing about a plan's PRODUCT, so here there is no
 * second source to arbitrate and no conflict to refuse. A registry-typed plan can
 * declare outputs.
 *
 * VALIDATED-ON-DECLARE, for the same fail-loud reason as inputs: the schema must
 * ajv-compile before it is persisted, because a schema that cannot compile could not
 * have its fields checked at completion, and the completion gate must never render
 * "could not check" as "nothing was promised".
 *
 * Advisory-locked, version-bumped and revisioned through withPlanLock, exactly like
 * its input sibling.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, type OutputSchemaPatch } from './with-plan-lock';
import { parsePlan } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { isCompilableSchema, jsonSchemaRequiredKeys } from '../../json-schema-validation';
import { collectDatatypeRefs } from './plan-outputs';
import { softText, clampText, LIMITS } from '../limits';

export type SetOutputSchemaValue =
  | { ok: true; slug: string; required: string[]; cleared: boolean; datatypes: string[] }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'legacy_plan' }
  | { ok: false; code: 'bad_schema' }
  | { ok: false; code: 'unknown_datatype'; unknown: string[]; known: string[] };

/**
 * The pure declare-time decision — the sibling of evaluateSetInputSchema. Exported
 * so it unit-tests without a live PG; the handler runs exactly this inside
 * withPlanLock. Never throws.
 *
 * Note the deliberately ABSENT `template_conflict` branch (see the file header):
 * unlike inputs, a registry `template` type is not a competing source for a plan's
 * product, so a templated plan may declare outputs.
 */
export function evaluateSetOutputSchema(
  current: string | null,
  schema: Record<string, unknown> | null,
  slug: string,
  /**
   * The canonical datatype names that exist in the registry right now. Passed in
   * rather than looked up so this stays DB-free and unit-testable. `null` means the
   * caller could not resolve the registry, which SKIPS the reference check rather
   * than failing the declare — refusing a valid schema because the registry was
   * briefly unreadable would be a worse failure than accepting a reference that a
   * later publish will catch anyway.
   */
  knownDatatypes: readonly string[] | null = null,
): { newBody: null; outputSchema?: OutputSchemaPatch; value: SetOutputSchemaValue } {
  if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };
  const parsed = parsePlan(current, { filePath: `${slug}.md` });
  if (parsed.isLegacy) return { newBody: null, value: { ok: false, code: 'legacy_plan' } };

  // Clearing is always allowed — un-declaring a plan's outputs cannot conflict with
  // anything, and a plan wedged by a bad declaration must have a way out.
  if (schema === null) {
    return {
      newBody: null,
      outputSchema: { schema: null },
      value: { ok: true, slug, required: [], cleared: true, datatypes: [] },
    };
  }

  if (!isCompilableSchema(schema)) {
    return { newBody: null, value: { ok: false, code: 'bad_schema' } };
  }

  // D-004/D-017: a field may name a CANONICAL platform datatype instead of restating a
  // shape locally. Verify the reference resolves AT DECLARE TIME, for the same reason
  // the schema must compile here: a dangling reference could not be checked when the
  // run publishes, and the publish gate must never read "could not check" as "nothing
  // was promised". Catching it here also puts the error where the typo is.
  const datatypes = collectDatatypeRefs(schema);
  if (knownDatatypes !== null && datatypes.length > 0) {
    const known = new Set(knownDatatypes);
    const unknown = datatypes.filter((d) => !known.has(d));
    if (unknown.length > 0) {
      return {
        newBody: null,
        value: { ok: false, code: 'unknown_datatype', unknown, known: [...knownDatatypes] },
      };
    }
  }

  return {
    newBody: null,
    outputSchema: { schema },
    value: {
      ok: true,
      slug,
      required: jsonSchemaRequiredKeys(schema),
      cleared: false,
      datatypes,
    },
  };
}

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
  schema: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe(
      "The plan's JSON Schema for what a completing run PUBLISHES. List the outputs a run must fill in `required: [...]` — a declared-but-unfilled required output fails the run loudly rather than chaining undefined downstream. Pass null to un-declare the plan's outputs (a terminal-only plan).",
    ),
  rationale: softText(LIMITS.ANNOTATION)
    .optional()
    .describe('Why — stored on the plan revision. Auto-truncated to 2000 chars if longer.'),
});

const text = (payload: Record<string, unknown>, isError = false) => ({
  data: payload,
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:set-output-schema',
  description:
    "Declare a plan's own JSON Schema for what it PRODUCES (the `output_schema` jsonb) — the symmetric half of plans:set-input-schema, giving a plan a RETURN VALUE so another step can consume its product. Rejected fail-loud unless the schema ajv-compiles, so the completion gate can never be left unable to check. Outputs are OPTIONAL: a plan that declares none is a valid terminal-only plan. Unlike input_schema this does NOT conflict with a code-registry `template:` type. Advisory-locked, version-bumped, revisioned. Pass schema:null to un-declare.",
  guidance: {
    when: "Giving a plan a return value — the fields a completing run publishes so a downstream step can consume them. Required-ness lives in the schema's `required` array.",
    notWhen:
      'Declaring what the plan is GIVEN — plans:set-input-schema. Reading the schema back — plans:get-output-schema. A plan whose product nothing consumes needs no output schema at all; outputs are optional by design.',
    chaining:
      'plans:set-output-schema { slug, schema } → the plan may then be the UPSTREAM half of a chain edge whose downstream step is deterministic (a recipe or one-step tool call), which requires declared outputs.',
    seeAlso: [
      'plans:get-output-schema (read it back, with the required-output list)',
      'plans:set-input-schema (the symmetric half — what the plan is GIVEN)',
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
        (args.schema === null ? 'clear output_schema' : 'set output_schema'),
      harnessSlug ? { harnessSlug } : {},
    );

    // Resolve the canonical datatype vocabulary so a `datatype:` reference can be
    // checked at declare time (D-004). Best-effort ON PURPOSE: a registry we cannot
    // read yields `null`, which SKIPS the reference check rather than refusing an
    // otherwise-valid schema — see evaluateSetOutputSchema's parameter doc.
    let knownDatatypes: string[] | null = null;
    try {
      const [{ getOrgPg }, { listRegisteredDatatypeNames }, { activeWorkspaceId }] =
        await Promise.all([
          import('@papercusp/db-org'),
          import('../../datatype-registry-store'),
          import('../../workspace-registry'),
        ]);
      const { sql } = getOrgPg();
      knownDatatypes = await listRegisteredDatatypeNames(sql, activeWorkspaceId());
    } catch {
      knownDatatypes = null;
    }

    const result = await withPlanLock<SetOutputSchemaValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: 'plans:set-output-schema',
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current) =>
        evaluateSetOutputSchema(
          current,
          args.schema as Record<string, unknown> | null,
          args.slug,
          knownDatatypes,
        ),
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
      if (v.code === 'bad_schema') {
        payload.hint =
          'The schema is not a compilable JSON Schema, so it is rejected here rather than ' +
          'stored — a schema that cannot compile could not be checked when the run completes, ' +
          'and the completion gate must never treat "could not check" as "nothing was promised".';
      } else if (v.code === 'unknown_datatype') {
        payload.unknown = v.unknown;
        payload.known = v.known;
        payload.hint =
          `No canonical datatype named ${v.unknown.map((u) => `'${u}'`).join(', ')} is ` +
          `registered. A \`datatype:\` reference names a CANONICAL platform shape ` +
          `(D-004 — apps do not invent their own version of an email or a post), so a ` +
          `dangling reference is rejected here rather than stored: it could not be ` +
          `checked when the run publishes. Either fix the name, or register the ` +
          `datatype first, or drop the \`datatype:\` annotation and describe the shape ` +
          `inline if it is genuinely plan-local.`;
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
      // The canonical shapes this plan's outputs are held to (D-004), echoed so the
      // caller can see which references actually resolved rather than assuming.
      datatypes: v.datatypes,
      version: result.version,
      revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
      ...(result.activationAudit ? { activationAudit: result.activationAudit } : {}),
    });
  },
});
