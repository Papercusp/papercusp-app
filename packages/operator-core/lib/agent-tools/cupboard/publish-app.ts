/**
 * cupboard:publish-app — list a whole standalone application on the Cupboard's
 * new "Apps" tab (cupboard-app-distribution-2026-07-14 P-003 / D-001
 * [owner 2026-07-14]).
 *
 * A STANDALONE app (e.g. Oddsmith, a Tauri desktop app built on the papercusp
 * platform) is a separate downloadable product — NOT a plugin that runs inside
 * papercusp. "Install" is a DOWNLOAD-LINK HANDOFF (v1): the Cupboard stores the
 * URL of the app's signed `latest.json` and the download flow (P-005) reads it to
 * hand off the platform installer from the app's OWN GitHub release. The Cupboard
 * never re-hosts the binary.
 *
 * This tool mirrors `blueprint:publish` / `knowledge_packs:publish` — resolve the
 * repo's GitHub coords, publish a `kind='app'` listing through THE shared publish
 * core (gh token + attestation) — with one added guard: it VALIDATES the
 * `latest.json` manifest RESOLVES first (assertAppManifestResolves), so a broken
 * release can't publish a listing whose every download dead-ends. The validated
 * platform keys are denormalized onto the listing for the storefront card.
 *
 * Review policy: `app` is fail-closed (REVIEW_POLICY_KINDS) — an app distributes
 * runnable installers, the highest-trust kind, so it lands PENDING and is
 * publicly invisible until an operator approves it. The response says so.
 *
 * Phase 2 (bundle apps — a papercusp-native composition installed into the
 * workspace) is NOT wired here; this tool publishes standalone apps only.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { activeWorkspaceId } from '../../workspace-registry';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const HTTPS = /^https:\/\//;
const RELEASE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export default defineTool({
  name: 'cupboard:publish-app',
  capability: 'harness:write',
  description:
    "List a whole STANDALONE application (a separate downloadable product like Oddsmith, not a plugin) on the Cupboard's Apps tab: resolves the repo's GitHub coords + publishes a kind='app' listing pointing at the app's signed latest.json. VALIDATES the manifest resolves first (fetch + shape-check) so a broken release can't publish a dead download, and denormalizes the available platform keys onto the card. \"Install\" is a download-link handoff — the Cupboard never re-hosts the binary. Lands PENDING (app is fail-closed) — an operator must approve it before it is publicly visible.",
  guidance: {
    when: "Distributing a standalone app you built on the papercusp platform (its own Tauri installer + a published GitHub release with a signed latest.json), so users can find and download it from the Cupboard's Apps tab.",
    notWhen:
      "Publishing a plugin/pack that runs INSIDE papercusp (that's knowledge_packs:publish / a plugin publish); a blueprint (blueprint:publish); or before the app's release + latest.json are live on GitHub — this tool validates the manifest resolves, so cut the release first.",
    chaining:
      'Cut the app release first (its latest.json must be reachable). The response carries review_status=pending — the submitter sees their own listing; operators approve at /admin/cupboard-moderation, after which it appears on the Apps tab.',
    seeAlso: [
      'blueprint:publish (publish a blueprint instead)',
      'knowledge_packs:publish (publish a knowledge pack instead)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    appId: z
      .string()
      .min(1)
      .max(120)
      .describe('Kebab-case app id — becomes the Cupboard listing_ref (the within-project discriminator).'),
    title: hardText(LIMITS.SHORT_TITLE),
    description: hardText(LIMITS.ANNOTATION),
    repoDir: z
      .string()
      .min(1)
      .describe("Absolute path of the app's repo (its origin remote names the GitHub repo)."),
    latestJsonUrl: z
      .string()
      .min(1)
      .max(500)
      .describe("https URL of the app's signed latest.json updater manifest (from @papercusp/tauri-release-kit)."),
    releaseRepo: z
      .string()
      .max(200)
      .optional()
      .describe("`<owner>/<repo>` whose GitHub Releases host the installers, if different from the source repo."),
    iconUrl: z.string().max(500).optional().describe('https URL of the app icon for the storefront card.'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    void (args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId());

    if (!HTTPS.test(args.latestJsonUrl)) {
      return text({ ok: false, error: 'invalid_field', field: 'latestJsonUrl', reason: 'must_be_https' });
    }
    if (args.releaseRepo != null && !RELEASE_REPO.test(args.releaseRepo)) {
      return text({ ok: false, error: 'invalid_field', field: 'releaseRepo', reason: 'must_be_owner/repo' });
    }
    if (args.iconUrl != null && !HTTPS.test(args.iconUrl)) {
      return text({ ok: false, error: 'invalid_field', field: 'iconUrl', reason: 'must_be_https' });
    }

    // 1. VALIDATE the latest.json resolves before publishing — a broken release
    //    must not publish a listing whose every download dead-ends.
    const { assertAppManifestResolves, AppManifestError } = await import('../../cupboard/validate-app-manifest');
    let manifest: { version: string; platforms: string[] };
    try {
      manifest = await assertAppManifestResolves(args.latestJsonUrl, {
        fetchText: async (url) => {
          const r = await fetch(url, { headers: { 'User-Agent': 'papercusp-cupboard-app-publish' } });
          return { ok: r.ok, status: r.status, text: await r.text() };
        },
      });
    } catch (e) {
      if (e instanceof AppManifestError) {
        return text({ ok: false, error: 'latest_json_invalid', reason: e.reason, detail: e.message, status: e.status });
      }
      throw e;
    }

    // 2. Resolve the repo's GitHub coords — the SAME path blueprint/knowledge-pack publish use.
    const { resolveRepoCoordsFromDir, gitOriginUrl, fetchGithubRepoMeta } = await import(
      '../../cupboard/resolve-repo-coords'
    );
    const coords = await resolveRepoCoordsFromDir(args.repoDir, {
      getOriginUrl: gitOriginUrl,
      fetchRepoMeta: fetchGithubRepoMeta,
    });
    if (!coords || 'error' in coords) {
      return text({
        ok: false,
        error: 'repo_coords_unresolvable',
        ...(coords && 'error' in coords ? { detail: coords.error } : {}),
        hint: 'repoDir must be a git repo with a GitHub origin remote.',
      });
    }

    // 3. Publish the kind='app' standalone listing through the one shared publish core.
    const { publishListingToCupboard } = await import('../../cupboard/publish-listing');
    const result = await publishListingToCupboard({
      listing_kind: 'app',
      listing_ref: args.appId,
      delivery_type: 'standalone',
      project_ref: `${coords.github_owner}/${coords.github_name}`,
      github_repository_id: coords.github_repository_id,
      github_owner: coords.github_owner,
      github_name: coords.github_name,
      github_url: coords.github_url,
      title: args.title,
      description: args.description,
      latest_json_url: args.latestJsonUrl,
      platforms: manifest.platforms,
      ...(args.releaseRepo ? { release_repo: args.releaseRepo } : {}),
      ...(args.iconUrl ? { icon_url: args.iconUrl } : {}),
    });
    if (!result.ok) {
      return text({ ok: false, error: result.error, detail: result.detail, status: result.status });
    }
    const data = result.data as { id?: string; review_status?: string; pending_review?: boolean };
    return text({
      ok: true,
      listingId: data.id,
      deliveryType: 'standalone',
      manifestVersion: manifest.version,
      platforms: manifest.platforms,
      review_status: data.review_status ?? 'pending',
      hint:
        data.review_status === 'pending' || data.pending_review
          ? 'Published PENDING — an app distributes runnable installers, so an operator must approve it before it appears on the Apps tab (you can watch your own listing meanwhile).'
          : undefined,
    });
  },
});
