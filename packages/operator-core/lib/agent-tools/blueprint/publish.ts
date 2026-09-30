/**
 * blueprint:publish — list a local/private blueprint on the Comb
 * (domain-generic-hive-architecture-2026-06-18 P-016).
 *
 * The publish entry point for blueprints, mirroring `knowledge_packs:publish`: it
 * resolves the member repo's GitHub coords and publishes a `kind='blueprint'`
 * listing (listing_ref = blueprintId) through THE shared Cupboard publish core
 * (gh token + channel-2 attestation). The blueprint INSTALL side already exists
 * (cupboard/install-blueprint-core.ts); this closes the loop by adding the way to
 * promote a local/private blueprint to the published/installed tier.
 *
 * DELTA-NOT-COPY (P-016 / D-005): the blueprint is listed AS-IS, keeping its
 * `extends:` parent — so an install composes the delta against the upstream
 * parent and inherits upstream improvements, rather than freezing a flattened
 * copy. The publish never reads or rewrites the blueprint body; it only points
 * the listing at the repo location.
 *
 * Review policy (D-007): a `blueprint` listing lands PENDING and is publicly
 * invisible until an operator approves it — the response says so.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorResolveExtends } from '../../blueprint/installed-blueprints';
import { BlueprintLifecycleError, prepareBlueprintPublicRelease } from '../../cupboard/blueprint-release';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const DEFAULT_BLUEPRINT_RELEASE_TIMEOUT_MS = 20_000;
const DEFAULT_REPO_COORDS_TIMEOUT_MS = 12_000;

type BlueprintPublishStage = 'blueprint_release' | 'repo_coords';

class BlueprintPublishStageTimeoutError extends Error {
  constructor(
    readonly stage: BlueprintPublishStage,
    readonly timeoutMs: number,
  ) {
    super(`blueprint_publish_stage_timeout:${stage}`);
    this.name = 'BlueprintPublishStageTimeoutError';
  }
}

async function runBlueprintPublishStage<T>(
  stage: BlueprintPublishStage,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BlueprintPublishStageTimeoutError(stage, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([run(), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function publishStageTimeout(error: unknown): ReturnType<typeof text> | null {
  return error instanceof BlueprintPublishStageTimeoutError
    ? text({
        ok: false,
        error: 'blueprint_publish_timeout',
        status: 504,
        detail: { stage: error.stage, timeoutMs: error.timeoutMs },
      })
    : null;
}

/**
 * `repoDir` is caller-selected and the publish side effect is a workspace-global
 * Cupboard write. There is no trustworthy seam here to prove that an arbitrary
 * path belongs to the caller's workspace, so scoped callers must fail closed even
 * when the transport clamp is disabled. The transport's cross-workspace clamp
 * remains the first line of defense for normal scoped superuser requests.
 */
function refuseScopedPublish(ctx: { principal?: { workspaceId?: string | null } }): ReturnType<typeof text> | null {
  const workspaceId = ctx.principal?.workspaceId?.trim();
  if (!workspaceId || workspaceId === '*') return null;

  return text({
    ok: false,
    error: 'workspace_forbidden',
    status: 403,
    detail:
      'blueprint:publish cannot self-confine a caller-selected repoDir: it reads local/GitHub repository state and writes a workspace-global Cupboard listing.',
    hint:
      'Run blueprint:publish from an unscoped (--all-workspaces) superuser session. The optional workspace argument is informational only and does not change transport scope.',
  });
}

export default defineTool({
  name: 'blueprint:publish',
  capability: 'harness:write',
  description:
    "UNSCOPED-ONLY: Publish a local/private blueprint to the Comb from its member repo's GitHub coordinates. This workspace-global write requires an unscoped (--all-workspaces) superuser; scoped calls fail. Keeps `extends:` so installs compose upstream improvements. Lands PENDING (D-007) until operator approval.",
  guidance: {
    when: "From an unscoped (--all-workspaces) superuser session, sharing a blueprint you authored or customized — a local/private blueprint living at <repo>/.papercusp/blueprints/<id>/ — so others can install it from the Comb.",
    notWhen:
      "Browsing/installing blueprints (blueprint:catalog lists what's installable); authoring one (blueprint:create / blueprint:extend); calling from a workspace-scoped session (the transport and handler refuse this global publication; the workspace argument cannot make it safe); or when the blueprint files are not on GitHub yet — publish points at the repo, so commit + push first.",
    chaining:
      'Run from an unscoped (--all-workspaces) superuser session after the blueprint files are committed + pushed via the project\'s normal flow. The response carries review_status=pending — operators approve at /admin/cupboard-moderation; once approved it installs via the Cupboard like any blueprint listing.',
    seeAlso: [
      'blueprint:validate (validate before publishing)',
      'blueprint:catalog (where the published blueprint appears)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    blueprintId: z
      .string()
      .min(1)
      .max(120)
      .describe(
        'The blueprint id to list — resolved from <repoDir>/.papercusp/blueprints/<blueprintId>/ or the official <repoDir>/packages/harness/blueprints/<blueprintId>/ library, and it becomes the Comb listing_ref.',
      ),
    title: hardText(LIMITS.SHORT_TITLE),
    description: hardText(LIMITS.ANNOTATION),
    repoDir: z
      .string()
      .min(1)
      .describe(
        'Absolute path of the member repo (its origin remote names the GitHub repo; must contain .papercusp/blueprints/<blueprintId>/blueprint.yaml).',
      ),
    workspace: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Compatibility label only; it does not make a workspace-scoped call eligible or change transport scope. Because repoDir is arbitrary and publication is global, use an unscoped (--all-workspaces) superuser session.',
      ),
  }),
  async handler(args, ctx) {
    const scopedRefusal = refuseScopedPublish(ctx);
    if (scopedRefusal) return scopedRefusal;

    void (args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId());

    // 1. The blueprint must already be a file tree in the repo (delta-not-copy:
    //    we list it, never materialize/flatten it). Read its `kind` for the
    //    Cupboard "Hives" tab discriminator (blueprint_kind — hive | harness).
    const authoredRoot = join(args.repoDir, '.papercusp', 'blueprints');
    const libraryRoot = join(args.repoDir, 'packages', 'harness', 'blueprints');
    const sourceRoot = [authoredRoot, libraryRoot].find((root) =>
      existsSync(join(root, args.blueprintId, 'blueprint.yaml')),
    );
    const bpYaml = sourceRoot
      ? join(sourceRoot, args.blueprintId, 'blueprint.yaml')
      : join(authoredRoot, args.blueprintId, 'blueprint.yaml');
    if (!sourceRoot) {
      return text({
        ok: false,
        error: 'blueprint_not_in_repo',
        hint:
          `Expected ${join(authoredRoot, args.blueprintId, 'blueprint.yaml')} or ` +
          `${join(libraryRoot, args.blueprintId, 'blueprint.yaml')}. ` +
          'Author/materialize the blueprint into one of those canonical repo layouts and push it before publishing.',
      });
    }
    // 2. Resolve and sign the release while resolving the repo's GitHub coords.
    // These are independent read/preflight legs. Running them sequentially made
    // their individually bounded GitHub/keychain paths add up past the enclosing
    // MCP deadline before the publish core's own bounded attestation + POST even
    // began (EI-22810897251728336). Bound both and overlap them so the full tool
    // retains enough budget to return a structured success or stage failure.
    const { resolveRepoCoordsFromDir, gitOriginUrl, fetchGithubRepoMeta } = await import(
      '../../cupboard/resolve-repo-coords'
    );
    const [preparedResult, coordsResult] = await Promise.allSettled([
      runBlueprintPublishStage('blueprint_release', DEFAULT_BLUEPRINT_RELEASE_TIMEOUT_MS, () =>
        prepareBlueprintPublicRelease({
          blueprintFile: bpYaml,
          listingRef: args.blueprintId,
          resolveExtends: operatorResolveExtends({ localDirs: [sourceRoot] }),
        }),
      ),
      runBlueprintPublishStage('repo_coords', DEFAULT_REPO_COORDS_TIMEOUT_MS, () =>
        resolveRepoCoordsFromDir(args.repoDir, {
          getOriginUrl: gitOriginUrl,
          fetchRepoMeta: fetchGithubRepoMeta,
        }),
      ),
    ]);
    if (preparedResult.status === 'rejected') {
      const timeout = publishStageTimeout(preparedResult.reason);
      if (timeout) return timeout;
      const error = preparedResult.reason;
      return text({
        ok: false,
        error: 'blueprint_release_invalid',
        detail: error instanceof Error ? error.message : String(error),
        status: error instanceof BlueprintLifecycleError ? error.status : 422,
      });
    }
    if (coordsResult.status === 'rejected') {
      const timeout = publishStageTimeout(coordsResult.reason);
      if (timeout) return timeout;
      return text({
        ok: false,
        error: 'repo_coords_unresolvable',
        detail: coordsResult.reason instanceof Error ? coordsResult.reason.message : String(coordsResult.reason),
        hint: 'repoDir must be a git repo with a GitHub origin remote.',
      });
    }
    const prepared = preparedResult.value;
    const coords = coordsResult.value;
    if (!coords || 'error' in coords) {
      return text({
        ok: false,
        error: 'repo_coords_unresolvable',
        ...(coords && 'error' in coords ? { detail: coords.error } : {}),
        hint: 'repoDir must be a git repo with a GitHub origin remote.',
      });
    }
    const blueprintKind: 'hive' | 'harness' =
      prepared.source.raw.kind === 'hive' || prepared.source.raw.kind === 'pot' ? 'hive' : 'harness';

    // 3. Publish the kind='blueprint' listing through the one shared Cupboard core.
    const { publishListingToCupboard } = await import('../../cupboard/publish-listing');
    const result = await publishListingToCupboard({
      listing_kind: 'blueprint',
      listing_ref: args.blueprintId,
      blueprint_kind: blueprintKind,
      project_ref: `${coords.github_owner}/${coords.github_name}`,
      github_repository_id: coords.github_repository_id,
      github_owner: coords.github_owner,
      github_name: coords.github_name,
      github_url: coords.github_url,
      title: args.title,
      description: args.description,
      release: prepared.release,
    });
    if (!result.ok) {
      return text({ ok: false, error: result.error, detail: result.detail, status: result.status });
    }
    const data = result.data as { id?: string; review_status?: string; pending_review?: boolean };
    return text({
      ok: true,
      listingId: data.id,
      blueprintKind,
      release: {
        version: prepared.source.version,
        contentHash: prepared.source.archive.package.rootHash,
        packageContentHash: prepared.source.archive.root.contentHash,
        pins: prepared.source.archive.pins.map((pin) => ({
          kind: pin.packageKind,
          ref: pin.ref,
          version: pin.revision,
          contentHash: pin.contentHash,
        })),
      },
      review_status: data.review_status ?? 'pending',
      hint:
        data.review_status === 'pending' || data.pending_review
          ? 'Published PENDING — an operator must approve it before it is publicly visible (you can watch your own listing meanwhile).'
          : undefined,
    });
  },
});
