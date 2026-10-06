/**
 * cupboard:install-plugin — install a plugin (or runtime-less code-tool pack)
 * from the Cupboard (cupboard-agent-tool-coverage-2026-07-14 P-006).
 *
 * The agent-callable face of `installPluginFromCupboard` — the SAME core the
 * loopback POST /cupboard/install-plugin route calls (D-001 reuse-first, no
 * fork): resolve the listing's repo coords → git-clone + install through the
 * capability-gated core → fire the plugin_install backup trigger. Install-time
 * dep validation hard-fails a unit whose required deps nothing provides (422);
 * installable ones surface advisorily.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import type { InstallPluginManifestReview } from '../../cupboard/install-plugin-core';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:install-plugin',
  capability: 'harness:write',
  description:
    "Install a plugin (or runtime-less code-tool pack) from the Cupboard: give a listingId (resolves the repo + ref from the listing) OR a githubUrl directly; the operator git-clones the repo and installs it into the global plugins dir, running the install-time dependency gate (a required dep nothing provides hard-fails; installable ones are reported). Pass harness + acceptCapabilities to grant the manifest's declared capabilities for that harness at install time.",
  guidance: {
    when: "Installing a plugin or code-tool pack from the Cupboard so its tools/events become available on this host — the user found a listing (cupboard:search) and wants it installed.",
    notWhen:
      "Installing a blueprint (cupboard:install-blueprint), a knowledge pack (knowledge_packs:install), or materializing an app-template (templates:new-app); PUBLISHING a unit (cupboard:publish-plugin).",
    chaining:
      "Find the listing first (cupboard:search) to get its listingId. The result reports installableDependencies — a unit's own resolvable deps you may want to install next. Granting capabilities needs harness + acceptCapabilities.",
    seeAlso: [
      'cupboard:search (find the listing to install)',
      'cupboard:install-blueprint (install a blueprint instead)',
      'cupboard:publish-plugin (publish a plugin/pack instead)',
    ],
  },
  args: z.object({
    listingId: z.string().max(200).optional().describe('The Cupboard listing id — resolves the repo URL + listing_ref from the listing.'),
    githubUrl: z.string().max(500).optional().describe('Install a repo directly instead of resolving a listing (listingRef = the plugin subdir/slug).'),
    listingRef: z.string().max(200).optional().describe('Within-repo plugin discriminator (a subdir to look in + the slug to match).'),
    harness: z.string().max(120).optional().describe('Target harness for capability grants (with acceptCapabilities).'),
    acceptCapabilities: z
      .boolean()
      .optional()
      .describe("Grant the manifest's declared capabilities for `harness` at install (install-consent)."),
    expectedReview: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Echo data.review from a provider_install_consent_required refusal (with acceptCapabilities).'),
    triggerPackConfig: z
      .object({
        sourceMappings: z.record(z.string(), z.string().uuid()).optional(),
        inputs: z.record(z.string(), z.unknown()).optional(),
      })
      .optional()
      .describe('Trigger pack in `harness`: pack binding id → local source id, and pack inputs.'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    const subject = args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId();

    if (!args.listingId && !args.githubUrl) {
      return text({ ok: false, error: 'listingId or githubUrl required' });
    }

    // D-045 §3a — the release chain decides BEFORE any bytes move: an unentitled
    // or yanked release, or a paid listing publishing no chain to check against,
    // is refused here rather than after the repo has already been cloned.
    const { gateInstallDoor } = await import('../../cupboard/install-door-gate-io');
    const gate = await gateInstallDoor({
      idOrRef: args.listingId ?? args.listingRef,
      kind: 'plugin',
      subject,
    });
    if (!gate.ok) {
      return text({ ok: false, error: gate.code, detail: gate.detail, refusedBy: 'install-door-gate' });
    }

    const { installPluginFromCupboard } = await import('../../cupboard/install-io');
    const outcome = await installPluginFromCupboard({
      ...(args.listingId ? { listingId: args.listingId } : {}),
      ...(args.githubUrl ? { githubUrl: args.githubUrl } : {}),
      ...(args.listingRef ? { listingRef: args.listingRef } : {}),
      ...(args.harness ? { harness: args.harness } : {}),
      acceptCapabilities: args.acceptCapabilities === true,
      ...(args.expectedReview
        ? { expectedReview: args.expectedReview as unknown as InstallPluginManifestReview }
        : {}),
      ...(args.triggerPackConfig ? { triggerPackConfig: args.triggerPackConfig } : {}),
    });

    if (!outcome.ok) {
      return text({
        ok: false,
        error: outcome.error,
        detail: outcome.detail,
        status: outcome.status,
        ...(outcome.code ? { code: outcome.code } : {}),
        ...(outcome.data ? { data: outcome.data } : {}),
      });
    }
    const r = outcome.result;
    return text({
      ok: true,
      name: r.name,
      version: r.version,
      kind: r.kind,
      installedTo: r.installedTo,
      granted: r.granted,
      ...(r.triggerPackInstallation ? { triggerPackInstallation: r.triggerPackInstallation } : {}),
      ...(r.installableDependencies ? { installableDependencies: r.installableDependencies } : {}),
    });
  },
});
