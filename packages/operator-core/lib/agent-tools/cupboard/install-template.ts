/**
 * cupboard:install-template — install an app-template from the Cupboard into the
 * local template store (cupboard-agent-tool-coverage-2026-07-14 P-007).
 *
 * The agent-callable face of `installTemplateFromCupboard` — the SAME core the
 * loopback POST /cupboard/install-template route calls (D-001 reuse-first, no
 * fork): git-clone the listing's mirror repo, locate <listingRef>/, validate it as
 * a self-describing template dir (template.yaml), and drop it into the writable
 * user template layer (~/.papercusp/templates/<ref>/) where it shadows the bundled
 * floor. After install, the ref is a LOCAL template — templates:new-app
 * materializes it via the same resolution as a bundled one, independent of
 * FLAGS.TEMPLATES_MARKETPLACE (that flag only gates the automatic remote MERGE in
 * templates:list/new-app, not an explicit install-by-url). Completes the
 * install-leg symmetry with cupboard:install-plugin / cupboard:install-blueprint.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:install-template',
  capability: 'harness:write',
  description:
    "Install an app-template from the Cupboard into the local template store: give a listingId (resolves the mirror repo + ref from the listing) OR a githubUrl + listingRef (the per-ref subdir) directly; the operator git-clones the mirror, validates <listingRef>/template.yaml, and drops it into ~/.papercusp/templates/<ref>/ where it shadows the bundled floor. After install the ref is a LOCAL template — templates:new-app materializes it into a new app. Returns { ok, ref, id, title, version, installedTo }.",
  guidance: {
    when: "Installing an app-template FROM the Cupboard into the local store so templates:new-app / templates:list can use it — the user found a template listing (cupboard:search kind='template') and wants it available locally to build from.",
    notWhen:
      "Building an app from an ALREADY-local/bundled template (skip straight to templates:new-app — it materializes + kicks off a builder). Just reading a template's build guide (templates:get-guide). Installing a blueprint (cupboard:install-blueprint) or plugin (cupboard:install-plugin). Publishing a template (cupboard:publish-template).",
    chaining:
      "cupboard:search { kind:'template' } → cupboard:install-template { listingId } → templates:new-app { template: <ref>, slug } to materialize it into a new app.",
    seeAlso: [
      'cupboard:search (find the template listing to install)',
      'templates:new-app (materialize the installed template into a new app)',
      'cupboard:install-blueprint (install a blueprint instead)',
    ],
  },
  args: z.object({
    listingId: z.string().max(200).optional().describe('The Cupboard listing id — resolves the mirror repo URL + listing_ref from the listing.'),
    githubUrl: z.string().max(500).optional().describe('Install a mirror repo directly instead of resolving a listing (needs listingRef).'),
    listingRef: z.string().max(200).optional().describe('Within-repo template discriminator (the per-ref subdir to install). Required with githubUrl; resolved from the listing when only listingId is given.'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    const subject = args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId();

    if (!args.listingId && !args.githubUrl) {
      return text({ ok: false, error: 'listingId or githubUrl required' });
    }

    // D-045 §3a — the release chain decides BEFORE any bytes move.
    const { gateInstallDoor } = await import('../../cupboard/install-door-gate-io');
    const gate = await gateInstallDoor({
      idOrRef: args.listingId ?? args.listingRef,
      kind: 'template',
      subject,
    });
    if (!gate.ok) {
      return text({ ok: false, error: gate.code, detail: gate.detail, refusedBy: 'install-door-gate' });
    }

    const { installTemplateFromCupboard } = await import('../../cupboard/install-template-io');
    const outcome = await installTemplateFromCupboard({
      ...(args.listingId ? { listingId: args.listingId } : {}),
      ...(args.githubUrl ? { githubUrl: args.githubUrl } : {}),
      ...(args.listingRef ? { listingRef: args.listingRef } : {}),
    });

    if (!outcome.ok) {
      return text({ ok: false, error: outcome.error, detail: outcome.detail, status: outcome.status });
    }
    const r = outcome.result;
    return text({
      ok: true,
      ref: r.ref,
      id: r.id,
      title: r.title,
      version: r.version,
      installedTo: r.installedTo,
      hint: `Installed. Build from it with templates:new-app { template: "${r.ref}", slug: "<new-app-slug>" }.`,
    });
  },
});
