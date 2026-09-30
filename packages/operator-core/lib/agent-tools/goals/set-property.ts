/**
 * goals:set-property — write ONE typed property value on a goal
 * (work-on-everything-goal-2026-08-23 P-023, migration 923).
 *
 * The ONLY writer of `harness_shared.goals.properties` (the migration's column
 * comment is the contract). Each write is validated against the property's
 * declared datatype (`datatype_registry.payload_schema`), authorized against
 * its `editable_by`, CAS-guarded by `expectedVersion`, and provenance-stamped
 * (owner-edit for the admin-UI identity, agent-edit for every agent session).
 *
 * A successful write emits a `property_changed` event on the EXISTING
 * plan-events rail keyed by the goal id (D-005 §2: no parallel channel), with
 * `detail` carrying the rendered delta line — which is exactly what the owning
 * agent's next orient/wake folds as `[owner] worklist: +"docs sweeps" −"perf"`.
 */

import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { applyGoalPropertyWrite } from '../../typed-properties-db';
import { PROPERTY_NAME, renderPropertyDelta } from '../../typed-properties';
import { ADMIN_COORD_UI_OWNER, resolveAgentIdentity } from '../coordination/identity';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { isGoalHolderAuthorityError } from '../../modes/goal-context';
import { assertGoalWriteAuthorityForCaller } from '../../goals/write-authority';

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'goals:set-property',
  needsWorkspaceTx: true,
  description:
    "Write ONE typed property value on a goal (P-023). The property must be DECLARED in the goal's property_schema; the value is validated against its datatype's payload_schema; editable_by is enforced (owner-edit vs agent-edit provenance is derived from the caller, never self-declared); expectedVersion is a CAS guard (0 = no explicit value yet — a 'stale' refusal means re-read and retry). An array-length reduction is refused as shrink_blocked unless confirmShrink:true explicitly authorizes the destructive replacement after a full read. Emits a property_changed delta event the owning agent's next orient folds.",
  guidance: {
    when: "Changing a declared property's VALUE on a goal — the owner steering surface and the agent's own typed state updates both land here.",
    notWhen:
      "DECLARING properties — that is the property_schema document, set at creation (goals:create / goals:start { propertySchema }). Free-form goal fields (title, body, criterion) — goals:update. Plan properties — plans:set-property.",
    chaining:
      "goals:get { id, detail:'full' } (read property_schema + COMPLETE properties incl. each version) → goals:set-property { goalId, property, value, expectedVersion } → on 'stale', re-read and retry with the reported actualVersion; on 'shrink_blocked', confirm the full authoritative list before deliberately retrying with confirmShrink:true.",
    seeAlso: ['plans:set-property (the plan sibling)', 'goals:get (read the declarations + values back)'],
  },
  capability: 'goals:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: z.object({
    goalId: z.string().min(1).describe('Goal id.'),
    property: z
      .string()
      .regex(PROPERTY_NAME)
      .describe("Declared property name (a key of the goal's property_schema)."),
    value: z
      .unknown()
      .describe("The new value — validated against the property's datatype payload_schema."),
    expectedVersion: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'CAS guard: the per-property version you last read; 0 = the property has no explicit value yet. A mismatch refuses as stale with the actual version.',
      ),
    confirmShrink: z
      .boolean()
      .optional()
      .describe(
        'Required only when the proposed array is shorter than the authoritative prior array. Pass true only after a full, untruncated goals:get read proves the removals are intentional; omitted/false returns shrink_blocked without writing.',
      ),
  }),
  async handler(args, ctx) {
    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    if (!workspaceId) return text({ error: 'no_workspace' }, true);

    // Provenance is DERIVED from the caller's resolved identity, never
    // self-declared: the admin coord UI (the owner surface) is the one
    // identity that stamps owner-edit; every agent session stamps agent-edit.
    let actorId = 'system';
    let ownerAuthority = false;
    try {
      const ident = resolveAgentIdentity(ctx);
      actorId = ident.ownerId;
      ownerAuthority = ident.ownerId === ADMIN_COORD_UI_OWNER;
    } catch {
      actorId = (ctx as { ownerId?: string }).ownerId ?? 'system';
    }
    const provenance = ownerAuthority ? ('owner-edit' as const) : ('agent-edit' as const);

    try {
      await assertGoalWriteAuthorityForCaller(ctx, workspaceId, ctx.tx as unknown as postgres.Sql);
    } catch (error) {
      if (isGoalHolderAuthorityError(error)) {
        return text({
          error: error.code,
          message: error.message,
          goalId: args.goalId,
          authority: error.authority,
        }, true);
      }
      throw error;
    }

    const result = await applyGoalPropertyWrite(ctx.tx as unknown as postgres.Sql, {
      workspaceId,
      goalId: args.goalId,
      property: args.property,
      value: args.value,
      expectedVersion: args.expectedVersion,
      confirmShrink: args.confirmShrink,
      provenance,
      actorId,
    });
    if (!result.ok) {
      const { ok: _ok, code, ...detail } = result;
      return text({ error: code, goalId: args.goalId, ...detail }, true);
    }

    const delta = renderPropertyDelta(args.property, result.priorValue, result.entry.value);
    // Best-effort observability (emitPlanEventForCaller swallows): the goal id
    // keys the ONE plan-events rail — the orient fold renders `detail` as-is.
    await emitPlanEventForCaller(ctx, {
      planSlug: args.goalId,
      event: 'property_changed',
      before: result.priorValue,
      after: result.entry.value,
      detail: `[${provenance === 'owner-edit' ? 'owner' : actorId}] ${delta}`,
    });

    return text({
      ok: true,
      goalId: args.goalId,
      property: args.property,
      version: result.entry.version,
      provenance,
      delta,
    });
  },
});
