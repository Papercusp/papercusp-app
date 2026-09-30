/**
 * plans:set-property — write ONE typed property value on a plan
 * (work-on-everything-goal-2026-08-23 P-023, migration 923).
 *
 * The plan sibling of goals:set-property and the ONLY writer of
 * `harness_shared.harness_plans.properties`. Structured-column state like the
 * schedule/op_* columns — never authored markdown, so no plan lock / revision
 * machinery: the write cycle serializes on a row-level SELECT ... FOR UPDATE
 * inside its own workspace transaction (the same scoping setPlanSchedule uses).
 *
 * Datatype-validated (datatype_registry payload_schema), editable_by-enforced,
 * CAS-guarded, provenance-stamped; a successful write emits `property_changed`
 * on the existing plan-events rail with the rendered delta line in `detail`.
 */

import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { resolvePlanScope } from './source';
import { applyPlanPropertyWrite } from '../../typed-properties-db';
import { PROPERTY_NAME, renderPropertyDelta } from '../../typed-properties';
import { ADMIN_COORD_UI_OWNER, resolveAgentIdentity } from '../coordination/identity';
import { emitPlanEventForCaller } from '../coordination/plan-events';

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:set-property',
  description:
    "Write ONE typed property value on a plan (P-023). The property must be DECLARED in the plan's property_schema; the value is validated against its datatype's payload_schema; editable_by is enforced (owner-edit vs agent-edit provenance derived from the caller); expectedVersion is a CAS guard (0 = no explicit value yet — 'stale' means re-read and retry). An array-length reduction is refused as shrink_blocked unless confirmShrink:true explicitly authorizes the destructive replacement after a full read. Emits a property_changed delta event on the plan-events rail.",
  guidance: {
    when: "Changing a declared property's VALUE on a plan — owner steering and agent typed-state updates.",
    notWhen:
      'DECLARING properties — plans:new { propertySchema } at creation. Plan content/frontmatter — plans:set-content / set-frontmatter-field. Item status — plans:set-status. Goal properties — goals:set-property.',
    chaining:
      "plans:get-properties { slug } (declarations + COMPLETE values + per-property versions) → plans:set-property { slug, property, value, expectedVersion } → on 'stale', re-read and retry; on 'shrink_blocked', confirm the full authoritative list before deliberately retrying with confirmShrink:true.",
    seeAlso: ['goals:set-property (the goal sibling)', 'plans:get-properties (read them back)'],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: z.object({
    harness: harnessArg,
    slug: z.string().min(1).describe('Plan slug (filename stem).'),
    property: z
      .string()
      .regex(PROPERTY_NAME)
      .describe("Declared property name (a key of the plan's property_schema)."),
    value: z
      .unknown()
      .describe("The new value — validated against the property's datatype payload_schema."),
    expectedVersion: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'CAS guard: the per-property version you last read; 0 = the property has no explicit value yet.',
      ),
    confirmShrink: z
      .boolean()
      .optional()
      .describe(
        'Required only when the proposed array is shorter than the authoritative prior array. Pass true only after a full, untruncated plans:get-properties read proves the removals are intentional; omitted/false returns shrink_blocked without writing.',
      ),
  }),
  async handler(args, ctx) {
    const opts = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
    const { workspaceId, harnessSlug } = await resolvePlanScope(opts);

    let actorId = 'system';
    let ownerAuthority = false;
    try {
      const ident = resolveAgentIdentity(ctx);
      actorId = ident.ownerId;
      ownerAuthority = ident.ownerId === ADMIN_COORD_UI_OWNER;
    } catch {
      /* unresolvable identity → agent-edit under 'system' */
    }
    const provenance = ownerAuthority ? ('owner-edit' as const) : ('agent-edit' as const);

    const result = await withWorkspace(workspaceId, (tx) =>
      applyPlanPropertyWrite(tx as unknown as postgres.Sql, {
        workspaceId,
        harnessSlug,
        planSlug: args.slug,
        property: args.property,
        value: args.value,
        expectedVersion: args.expectedVersion,
        confirmShrink: args.confirmShrink,
        provenance,
        actorId,
      }),
    );
    if (!result.ok) {
      const { ok: _ok, code, ...detail } = result;
      return text({ error: code, slug: args.slug, ...detail }, true);
    }

    const delta = renderPropertyDelta(args.property, result.priorValue, result.entry.value);
    await emitPlanEventForCaller(ctx, {
      planSlug: args.slug,
      event: 'property_changed',
      before: result.priorValue,
      after: result.entry.value,
      detail: `[${provenance === 'owner-edit' ? 'owner' : actorId}] ${delta}`,
    });

    return text({
      ok: true,
      slug: args.slug,
      property: args.property,
      version: result.entry.version,
      provenance,
      delta,
    });
  },
});
