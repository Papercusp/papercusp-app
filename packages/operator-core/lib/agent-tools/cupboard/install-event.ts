/**
 * cupboard:install-event — install a published Cupboard event vocabulary into this workspace.
 *
 * The install half of identities-v1-2026-08-30 P-029 (D-010/D-011). Two things happen and
 * BOTH are required for the key to be usable: the verified package is materialized on disk
 * (distribution), and its `event_key_registry` row is seeded (resolution — a rule's `on` and
 * an agent's `events:await` resolve through the registry, never through the installed
 * directory). A package installed without a seeded row is inert: a listener parked on a key
 * that resolves nowhere, which is precisely the silent-inertness failure P-029 names. So a
 * failed seed is reported as a failed INSTALL, never as a success with a caveat.
 *
 * A package carries only the CURATED half of a row (D-058). `emitter` / `emitterExists` /
 * `emitSiteCount` are measurements of the PUBLISHER's tree and are refused at parse time —
 * the derived half is re-derived against YOUR tree after install, or it does not exist here.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:install-event',
  capability: 'harness:write',
  description:
    'Install a published Cupboard event vocabulary into this workspace — materializes the verified package and seeds its event_key_registry row, so the key resolves for events:await and rule triggers. Pass update:true to replace an installed package explicitly.',
  guidance: {
    when: "Installing a result from cupboard:search { kind:'event' } so this workspace can await, emit, or declare requires_events against that key.",
    notWhen:
      'Registering a NEW first-party key locally, or awaiting a key that already resolves here (events:catalog lists those).',
    chaining:
      "cupboard:search { kind:'event' } → cupboard:install-event { listingId } → events:await / a rule's `on` / a listing's requires_events.",
    seeAlso: [
      'cupboard:publish-event (publish one)',
      "cupboard:search { kind:'event' } (browse installable event keys)",
      'events:catalog (what this workspace already resolves)',
    ],
  },
  args: z.object({
    listingId: z.string().max(200).optional().describe("a listing id or ref from cupboard:search { kind:'event' }"),
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
      kind: 'event',
      subject,
    });
    if (!gate.ok) return ok({ ok: false, error: gate.code, detail: gate.detail, refusedBy: 'install-door-gate' });
    const actor = resolveAgentIdentity(ctx).ownerId;
    const { installEventFromCupboard } = await import('../../cupboard/install-event-io');
    const result = await installEventFromCupboard({
      workspaceId: subject,
      ...(args.listingId ? { listingId: args.listingId } : {}),
      ...(args.githubUrl ? { githubUrl: args.githubUrl } : {}),
      ...(args.listingRef ? { listingRef: args.listingRef } : {}),
      ...(args.update ? { update: true } : {}),
      // resolveAgentIdentity, not ctx.principal: a Principal carries kind/slug/workspaceId
      // and has no agentId. This stamps who registered the key HERE.
      ...(actor ? { createdBy: actor } : {}),
    });
    if (!result.ok) return ok({ ok: false, status: result.status, error: result.error, detail: result.detail });
    return ok({
      ok: true,
      eventKey: result.result.eventKey,
      registeredKey: result.result.registeredKey,
      ref: result.result.ref,
      installedTo: result.result.installedTo,
      operation: result.result.operation,
      keyPattern: result.result.keyPattern,
      version: result.result.version,
      hint: `Installed and resolvable — events:await { event: "${result.result.registeredKey}" }. The derived half (emitter, emitSiteCount) is measured against THIS tree by a scan, never carried from the publisher.`,
    });
  },
});
