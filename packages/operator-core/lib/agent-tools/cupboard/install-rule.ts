/**
 * cupboard:install-rule — install a rule package from the Cupboard into this
 * workspace's rule store (portable-identity-packages-2026-09-26 P-011, D-023 §6).
 *
 * The agent-callable face of `installRuleFromCupboard`: git-clone the listing's
 * mirror repo, validate <listingRef>/ with the same reader the store enumerates with
 * (so a manifest mixing sync and async shapes, a guard off the pre-tool sink or an
 * unbounded condition is refused), and drop the dir into the writable user layer
 * (~/.papercusp/rules/installed/<ref>/).
 *
 * Unlike a rubric there is no seed step: an installed rule is inert until a
 * blueprint bundle pins it, and compile binds a sync context rule's provider then.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';

/** Canonical `{ data }` envelope — the framework owns wire encoding (auto-TOON on the MCP transport). */
const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:install-rule',
  capability: 'harness:write',
  description:
    "Install a rule package from the Cupboard into this workspace: give a listingId (resolves the mirror repo + ref from the listing) OR a githubUrl + listingRef directly; the operator clones the mirror, validates <listingRef>/rule.json and drops the dir into ~/.papercusp/rules/installed/<ref>/. An installed rule is inert until a blueprint bundle pins it. Returns { ok, ref, ruleId, delivery, sink?, installedTo }.",
  guidance: {
    when: "Installing a published rule so a blueprint can pin it — you found a rule listing (cupboard:search kind='rule').",
    notWhen:
      'Installing a rubric (cupboard:install-rubric) or an event listing (cupboard:install-event).',
    chaining:
      "cupboard:search { kind:'rule' } → cupboard:install-rule { listingId } → pin it in a blueprint bundle. Compile refuses a sync context rule whose provider is an operation or asynchronous.",
    seeAlso: [
      'cupboard:search (find the rule listing to install)',
      'cupboard:publish-rule (publish one of your own instead)',
    ],
  },
  args: z.object({
    listingId: z.string().max(200).optional().describe('The Cupboard listing id (or its listing_ref handle) — resolves the mirror repo URL + ref.'),
    githubUrl: z.string().max(500).optional().describe('Install a mirror repo directly instead of resolving a listing (needs listingRef).'),
    listingRef: z.string().max(200).optional().describe('Within-repo rule discriminator (the per-ref subdir). Required with githubUrl; resolved from the listing when only listingId is given.'),
    workspace: entityRef('workspace', { max: 120 }).optional(),
  }),
  async handler(args, ctx) {
    const subject = args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId();

    if (!args.listingId && !args.githubUrl) {
      return ok({ ok: false, error: 'listingId or githubUrl required' });
    }

    // D-045 §3a — the release chain decides BEFORE any bytes move.
    const { gateInstallDoor } = await import('../../cupboard/install-door-gate-io');
    const gate = await gateInstallDoor({
      idOrRef: args.listingId ?? args.listingRef,
      kind: 'rule',
      subject,
    });
    if (!gate.ok) {
      return ok({ ok: false, error: gate.code, detail: gate.detail, refusedBy: 'install-door-gate' });
    }

    const { installRuleFromCupboard } = await import('../../cupboard/install-rule-io');
    const outcome = await installRuleFromCupboard({
      workspaceId: subject,
      ...(args.listingId ? { listingId: args.listingId } : {}),
      ...(args.githubUrl ? { githubUrl: args.githubUrl } : {}),
      ...(args.listingRef ? { listingRef: args.listingRef } : {}),
    });

    if (!outcome.ok) {
      return ok({ ok: false, error: outcome.error, detail: outcome.detail, status: outcome.status });
    }
    const r = outcome.result;
    return ok({
      ok: true,
      ref: r.ref,
      ruleId: r.ruleId,
      title: r.title,
      version: r.version,
      delivery: r.delivery,
      ...(r.sink ? { sink: r.sink } : {}),
      installedTo: r.installedTo,
      verified: r.pin !== null,
      hint: `Installed. Pin it in a blueprint bundle to apply it; the rule does nothing until a wearer applies that artifact.`,
    });
  },
});
