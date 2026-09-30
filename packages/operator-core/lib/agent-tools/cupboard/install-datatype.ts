/**
 * cupboard:install-datatype — install a published Cupboard datatype into this workspace.
 *
 * The install half of the consolidated datatype storefront (P-027 / D-010). Two things
 * happen and both are required for the datatype to be usable: the verified package is
 * materialized on disk (distribution), and its `datatype_registry` row is seeded
 * (resolution — `work_items:create { kind }` resolves through the registry, never
 * through the installed directory). A failed seed is therefore reported as a failed
 * install rather than a success with a caveat.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:install-datatype',
  capability: 'harness:write',
  description:
    'Install a published Cupboard datatype into this workspace — materializes the verified package and seeds its datatype_registry row, so its work-item kind becomes usable. Pass update:true to replace an installed package explicitly.',
  guidance: {
    when: "Installing a result from cupboard:search { kind:'datatype' } so this workspace can create instances of its kind or depend on it from a blueprint.",
    notWhen:
      'Declaring a NEW datatype (meta:define-datatype). Copying an already-approved datatype between workspaces in this same database (datatypes:install).',
    chaining:
      "cupboard:search { kind:'datatype' } → cupboard:install-datatype { listingId } → work_items:create { kind } / blueprint dependencies.datatypes.",
    seeAlso: [
      'cupboard:publish-datatype (publish one)',
      "cupboard:search { kind:'datatype' } (browse installable datatypes)",
      'datatypes:list (what this workspace already resolves)',
    ],
  },
  args: z.object({
    listingId: z.string().max(200).optional().describe("a listing id or ref from cupboard:search { kind:'datatype' }"),
    githubUrl: z.string().max(500).optional().describe('direct mirror install — an UNVERIFIED tip clone (no content pin)'),
    listingRef: z.string().max(200).optional().describe('within-repo ref; required with githubUrl'),
    update: z.boolean().optional(),
    workspace: entityRef('workspace', { max: 120 }).optional(),
  }),
  async handler(args, ctx) {
    const subject = args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    if (!subject) return ok({ ok: false, status: 400, error: 'no_workspace', detail: 'no workspace in the request context' });
    const { gateInstallDoor } = await import('../../cupboard/install-door-gate-io');
    const gate = await gateInstallDoor({
      idOrRef: args.listingId ?? args.listingRef,
      kind: 'datatype',
      subject,
    });
    if (!gate.ok) return ok({ ok: false, error: gate.code, detail: gate.detail, refusedBy: 'install-door-gate' });
    const actor = resolveAgentIdentity(ctx).ownerId;
    const { installDatatypeFromCupboard } = await import('../../cupboard/install-datatype-io');
    const result = await installDatatypeFromCupboard({
      workspaceId: subject,
      ...(args.listingId ? { listingId: args.listingId } : {}),
      ...(args.githubUrl ? { githubUrl: args.githubUrl } : {}),
      ...(args.listingRef ? { listingRef: args.listingRef } : {}),
      ...(args.update ? { update: true } : {}),
      // resolveAgentIdentity, not ctx.principal: a Principal carries kind/slug/workspaceId
      // and has no agentId — this is the same resolver datatypes:declare attributes with.
      ...(actor ? { createdBy: actor } : {}),
    });
    if (!result.ok) return ok({ ok: false, status: result.status, error: result.error, detail: result.detail });
    return ok({
      ok: true,
      id: result.result.id,
      registryId: result.result.registryId,
      ref: result.result.ref,
      installedTo: result.result.installedTo,
      operation: result.result.operation,
      tier: result.result.tier,
      workItemKind: result.result.workItemKind,
      version: result.result.version,
      hint:
        result.result.tier === 'generic-kind' && result.result.workItemKind
          ? `Installed and resolvable — work_items:create { kind:"${result.result.workItemKind}" }.`
          : 'Installed and resolvable through datatypes:get / datatypes:list.',
    });
  },
});
