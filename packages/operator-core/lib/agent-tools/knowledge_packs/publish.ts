/**
 * knowledge_packs:export + knowledge_packs:publish — distill a hive's learnings
 * into a pack and list it on the Comb (learning-packs-2026-06-11 P-016).
 *
 * Two deliberate steps:
 *   export  — write `knowledge-packs/<packId>/` into a member repo's working
 *             tree (the project's normal commit/push flow carries the files).
 *   publish — once the files are on GitHub, create the Comb listing
 *             (kind 'knowledge-pack', listing_ref = packId) via the standard
 *             publish core (gh token + attestation). The listing lands
 *             PENDING (D-007) — an operator approves before it goes public;
 *             the response says so.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { activeWorkspaceId } from '../../workspace-registry';
import { FLAG_OFF, knowledgePacksEnabled, text } from './_shared';

export const exportTool = defineTool({
  name: 'knowledge_packs:export',
  capability: 'memory:read',
  // Writes `knowledge-packs/<packId>/` files into a member repo's working tree — a real FS
  // mutation, so it must be dry-run/confirm-gated even though its capability is the shared
  // read cap `memory:read`. An explicit override (not WRITE_CAPABILITIES) so memory:read's
  // genuine readers stay read. B-CX-EFFECT audit.
  effect: 'write',
  description:
    "Export a hive's shared learnings into the standard pack shape (knowledge-packs/<packId>/ — manifest + one-learning-per-file) inside a member repo's working tree, ready to commit + publish. Defaults to the hive's ORGANIC learnings only; includePackRows re-exports installed-pack content too (explicit opt-in).",
  guidance: {
    when: "The user wants to share their pot's accumulated learnings — first step of the publish flow.",
    notWhen: 'Installing or browsing packs — knowledge_packs:list/install.',
    chaining:
      "After the files are committed + pushed by the project's normal flow, knowledge_packs:publish lists the pack on the Comb (it publishes PENDING — operator approval gates public visibility, D-007).",
    seeAlso: [
      'knowledge_packs:publish (list the pack on the Comb after export + push)',
      'knowledge_packs:list (browse / install packs instead)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    pot: entityRef('pot', { soft: true, max: 120 }),
    packId: z.string().min(1).max(120).describe('Kebab-case pack id (becomes the Comb listing_ref).'),
    title: hardText(LIMITS.SHORT_TITLE),
    description: hardText(LIMITS.ANNOTATION),
    version: z.string().optional().describe('Three-part semver. Default 1.0.0.'),
    targetDir: z.string().min(1).describe("Absolute path of the member repo's working tree to write into."),
    includePackRows: z.boolean().optional(),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args) {
    if (!(await knowledgePacksEnabled())) return text(FLAG_OFF);
    const { exportHiveLearningsToPack } = await import('../../knowledge-packs/export');
    const result = await exportHiveLearningsToPack({
      potSlug: args.pot,
      packId: args.packId,
      title: args.title,
      description: args.description,
      ...(args.version ? { version: args.version } : {}),
      targetDir: args.targetDir,
      ...(args.includePackRows !== undefined ? { includePackRows: args.includePackRows } : {}),
    });
    return text({
      ...result,
      ...(result.ok
        ? { hint: "Commit + push these files via the project's normal flow, then knowledge_packs:publish." }
        : {}),
    });
  },
});

export const publishTool = defineTool({
  name: 'knowledge_packs:publish',
  capability: 'harness:write',
  description:
    "List an exported knowledge pack on the Comb: resolves the member repo's GitHub coords, publishes a kind='knowledge-pack' listing (listing_ref = packId) with the operator's gh token + attestation. The listing lands PENDING (D-007) — an operator must approve it before anyone else sees it.",
  guidance: {
    when: 'After knowledge_packs:export and the files are pushed to the GitHub repo.',
    notWhen: 'The pack files are not on GitHub yet — publish points at the repo; export first, push, then publish.',
    chaining: 'The response carries review_status pending — the submitter sees it on their own listing; operators approve at /admin/cupboard-moderation.',
    seeAlso: [
      'knowledge_packs:export (run first — export, push, then publish)',
      'knowledge_packs:list (browse published packs)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    packId: z.string().min(1).max(120),
    title: hardText(LIMITS.SHORT_TITLE),
    description: hardText(LIMITS.ANNOTATION),
    repoDir: z.string().min(1).describe('Absolute path of the member repo (its origin remote names the GitHub repo).'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    if (!(await knowledgePacksEnabled())) return text(FLAG_OFF);
    void (args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId());

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

    const { publishListingToCupboard } = await import('../../cupboard/publish-listing');
    const result = await publishListingToCupboard({
      listing_kind: 'knowledge-pack',
      listing_ref: args.packId,
      project_ref: `${coords.github_owner}/${coords.github_name}`,
      github_repository_id: coords.github_repository_id,
      github_owner: coords.github_owner,
      github_name: coords.github_name,
      github_url: coords.github_url,
      title: args.title,
      description: args.description,
    });
    if (!result.ok) return text({ ok: false, error: result.error, detail: result.detail, status: result.status });
    const data = result.data as { id?: string; review_status?: string; pending_review?: boolean };
    return text({
      ok: true,
      listingId: data.id,
      review_status: data.review_status ?? 'pending',
      hint:
        data.review_status === 'pending' || data.pending_review
          ? 'Published PENDING — an operator must approve it before it is publicly visible (you can watch your own listing meanwhile).'
          : undefined,
    });
  },
});

export default exportTool;
