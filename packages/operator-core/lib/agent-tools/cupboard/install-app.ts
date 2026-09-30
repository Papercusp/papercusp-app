/**
 * cupboard:install-app — install a BUNDLE app from the Cupboard
 * (cupboard-app-distribution-2026-07-14 P-008).
 *
 * The agent-callable face of `installBundleAppFromCupboard` — the SAME core the
 * loopback POST /cupboard/install-app route calls (D-001 reuse-first, no fork):
 * git-clone the listing's repo, fetch + parse its `bundle.yaml`, run the one
 * conflict review across every declared datatype/pack/plugin/blueprint, and
 * fan clean+duplicate units out to the same per-kind installers every other
 * Cupboard kind uses. A STANDALONE app (delivery_type 'standalone') has no
 * install action — download it instead (cupboard:search → the listing's
 * `latest_json_url`, or the desktop app-download UI).
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:install-app',
  capability: 'harness:write',
  description:
    "Install a BUNDLE app from the Cupboard: give a listingId (resolves the repo + ref from the listing, must be a kind='app'/delivery_type='bundle' listing) OR a githubUrl directly; the operator git-clones the repo, fetches + parses <listingRef>/bundle.yaml, and runs ONE conflict review across every declared datatype/pack/plugin/blueprint before fanning clean+duplicate units out to the standard per-kind installers (datatypes:install's core, cupboard:install-plugin's core, cupboard:install-blueprint's core). Unresolved conflicts BLOCK the install by default (nothing is installed) — pass allowConflicts:true to proceed anyway. Returns the manifest + the review + per-unit install results.",
  guidance: {
    when: "Installing a bundle-app listing from the Cupboard into this workspace — the user found a bundle app (cupboard:search / the Cupboard Apps tab) and wants it installed.",
    notWhen:
      "The listing is a STANDALONE app (delivery_type 'standalone') — that's a downloadable product, not something to install here; hand off its latest_json_url instead. Installing a blueprint alone (cupboard:install-blueprint), a plugin alone (cupboard:install-plugin), or a datatype alone (datatypes:install).",
    chaining:
      'Find the listing first (cupboard:search) for its listingId — confirm delivery_type is \'bundle\'. On blockedByConflicts:true, either resolve the collision manually or re-call with allowConflicts:true to proceed anyway.',
    seeAlso: [
      'cupboard:search (browse installable app listings)',
      'cupboard:install-blueprint (install a blueprint alone)',
      'cupboard:install-plugin (install a plugin alone)',
      'datatypes:install (install a datatype alone)',
    ],
  },
  args: z.object({
    listingId: z.string().max(200).optional().describe("The Cupboard listing id — resolves the repo URL + listing_ref from the listing. Must be kind='app'/delivery_type='bundle'."),
    githubUrl: z.string().max(500).optional().describe('Install a repo directly instead of resolving a listing (listingRef = the bundle subdir).'),
    listingRef: z.string().max(200).optional().describe('Within-repo bundle discriminator (the subdir to look in first, for bundle.yaml).'),
    allowConflicts: z
      .boolean()
      .optional()
      .describe('Proceed even when the review finds unresolved conflicts (default: blocked, nothing installed).'),
    workspace: entityRef('workspace', { max: 120 }).optional(),
  }),
  async handler(args, ctx) {
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.principal?.workspaceId);

    if (!args.listingId && !args.githubUrl) {
      return text({ ok: false, error: 'listingId or githubUrl required' });
    }

    // D-045 §3a — the release chain decides BEFORE any bytes move.
    const { gateInstallDoor } = await import('../../cupboard/install-door-gate-io');
    const gate = await gateInstallDoor({
      idOrRef: args.listingId ?? args.listingRef,
      kind: 'app',
      subject: workspaceId,
    });
    if (!gate.ok) {
      return text({ ok: false, error: gate.code, detail: gate.detail, refusedBy: 'install-door-gate' });
    }

    const { installBundleAppFromCupboard } = await import('../../cupboard/bundle-app-install-io');
    const outcome = await installBundleAppFromCupboard(
      {
        ...(args.listingId ? { listingId: args.listingId } : {}),
        ...(args.githubUrl ? { githubUrl: args.githubUrl } : {}),
        ...(args.listingRef ? { listingRef: args.listingRef } : {}),
        allowConflicts: args.allowConflicts === true,
      },
      { workspaceId },
    );

    if (!outcome.ok) {
      return text({ ok: false, error: outcome.error, detail: outcome.detail, status: outcome.status });
    }
    const r = outcome.result;
    return text({
      ok: r.ok,
      blockedByConflicts: r.blockedByConflicts,
      manifest: { name: outcome.manifest.name, description: outcome.manifest.description },
      review: r.review,
      deps: r.deps,
      datatypes: r.datatypes,
      blueprint: r.blueprint,
      ...(r.blockedByConflicts
        ? { note: 'Unresolved conflicts blocked the install — nothing was installed. Re-call with allowConflicts:true to proceed anyway.' }
        : {}),
    });
  },
});
