/**
 * publish-plugin-core — the ONE server-side path that publishes an installed
 * distribution unit (a plugin OR a runtime-less code-tool pack) TO the Cupboard
 * as a `kind=plugin` / `kind=pack` listing.
 *
 * Extracted (cupboard-agent-tool-coverage-2026-07-14 P-001/P-004, D-001
 * reuse-first) from the inline body of `endpoint-route/routes/cupboard-publish-
 * plugin.ts` so BOTH the loopback HTTP route AND the agent-callable
 * `cupboard:publish-plugin` tool run the exact same validation + publish logic
 * — no fork. The listing kind auto-follows the installed manifest's `kind`
 * ('pack' → kind=pack listing, else plugin; D-001 of the pack model: plugin =
 * pack + runtime).
 *
 * All validation (slug shape, provides_tools shape, repo-coords resolution,
 * event-declaration validity, install-ability gate) lives HERE and returns a
 * structured result; each caller only maps its own input/output format.
 */
import { validateManifestEventDeclarations } from '@papercusp/plugin-sdk';
import { findInstalledPlugin } from './plugin-listings';
import { manifestToolNames, parseProvidedEvents, parseRequiredEvents } from './pack-catalog';
import { publishListingToCupboard } from './publish-listing';
import {
  resolveRepoCoordsFromDir,
  parseGithubRemote,
  gitOriginUrl,
  fetchGithubRepoMeta,
  fetchGithubRepoFile,
  type RepoCoords,
} from './resolve-repo-coords';
import { assertPluginManifestPublishable, PublishManifestError } from './publish-manifest-check';

export interface PublishInstalledUnitInput {
  /** The installed unit's manifest name (used as listing_ref unless overridden). */
  slug: string;
  /** Override the repo (else resolved from the installed unit's git origin). */
  github_url?: string;
  /** Papercupai project remote (D-008). */
  project_ref?: string;
  /** Override the within-repo listing ref (else the slug). */
  listing_ref?: string;
  /** Override title (else the manifest name). */
  title?: string;
  /** Override description (else the manifest description). */
  description?: string;
  /** Override the declared MCP tool names (else manifest-derived). Validated here. */
  provides_tools?: unknown;
}

export type PublishInstalledUnitResult =
  | { ok: true; listing_kind: 'plugin' | 'pack'; listing: unknown }
  | { ok: false; status: number; error: string; detail?: unknown; upstream_status?: number };

/**
 * Publish an installed plugin/pack to the Cupboard. Returns a structured result
 * — never throws for an expected failure (bad input, unresolvable repo, worker
 * error); the caller maps status+error to its own response shape.
 */
export async function publishInstalledUnitToCupboard(
  input: PublishInstalledUnitInput,
): Promise<PublishInstalledUnitResult> {
  const slug = String(input.slug ?? '').trim();
  if (!/^@?[a-z0-9][a-z0-9._/-]{0,127}$/i.test(slug)) {
    return { ok: false, status: 400, error: `invalid plugin slug "${slug}"` };
  }

  // Explicit provides_tools override (validated to the worker's shape); else
  // derived from the installed manifest below.
  let providesToolsOverride: string[] | undefined;
  if (input.provides_tools != null) {
    const pt = input.provides_tools;
    if (
      !Array.isArray(pt) ||
      pt.length === 0 ||
      pt.length > 200 ||
      !pt.every((t) => typeof t === 'string' && t.trim().length > 0 && t.length <= 128)
    ) {
      return { ok: false, status: 400, error: 'invalid provides_tools (string[], 1–200 entries, ≤128 chars)' };
    }
    providesToolsOverride = pt as string[];
  }

  const installed = await findInstalledPlugin(slug);

  // Resolve the unit repo's GitHub coords: explicit github_url wins, else the
  // installed unit dir's `origin` remote.
  let coords: RepoCoords | { error: string };
  if (typeof input.github_url === 'string' && input.github_url.trim()) {
    const parsed = parseGithubRemote(input.github_url.trim());
    if (!parsed) {
      return { ok: false, status: 400, error: `invalid github_url "${input.github_url}"` };
    }
    const meta = await fetchGithubRepoMeta(parsed.owner, parsed.repo);
    coords = meta
      ? {
          github_repository_id: meta.id,
          github_owner: parsed.owner,
          github_name: parsed.repo,
          github_url: meta.html_url || `https://github.com/${parsed.owner}/${parsed.repo}`,
        }
      : { error: `could not resolve GitHub repo ${parsed.owner}/${parsed.repo}` };
  } else if (installed) {
    coords = await resolveRepoCoordsFromDir(installed.path, {
      getOriginUrl: gitOriginUrl,
      fetchRepoMeta: fetchGithubRepoMeta,
    });
  } else {
    return { ok: false, status: 404, error: `plugin "${slug}" is not installed and no github_url was given` };
  }
  if ('error' in coords) {
    return { ok: false, status: 422, error: coords.error };
  }

  // A runtime-less code-tool pack manifest (kind:'pack') lists as the canonical
  // 'pack' listing kind; everything else stays a plugin listing (D-001).
  const listingKind = installed?.kind === 'pack' ? ('pack' as const) : ('plugin' as const);
  const providesTools = providesToolsOverride ?? (installed ? manifestToolNames(installed) : []);
  const listingRef =
    typeof input.listing_ref === 'string' && input.listing_ref.trim() ? input.listing_ref.trim() : slug;

  // The EVENT axis (D-003; P-007 resolver + P-008 wire). Derived from the
  // installed manifest — NOT overridable like provides_tools, because a provided
  // family carries a keyTemplate that must match what the unit actually emits at
  // runtime. Without this the whole installable rung is inert (see publish-listing.ts).
  const providesEvents = installed ? parseProvidedEvents(installed.provides?.events) : [];
  const requiresEvents = installed ? parseRequiredEvents(installed.dependencies?.events) : [];

  // A malformed event declaration is LOUD at publish time — publishing YOUR OWN
  // manifest, silently dropping a family the author believes they declared ships
  // a listing that lies about itself.
  if (installed) {
    const issues = validateManifestEventDeclarations(installed);
    if (issues.length > 0) {
      return { ok: false, status: 422, error: 'invalid manifest event declarations', detail: issues };
    }
  }

  // Publish-time installability gate (EI-387 / P-005): a kind=plugin listing must
  // point at a repo the STANDARD install path can resolve — a papercusp.json with
  // {name, version} where the installer looks. Scoped to plugin per P-005.
  if (listingKind === 'plugin') {
    try {
      await assertPluginManifestPublishable(
        { owner: coords.github_owner, repo: coords.github_name, listingRef },
        { fetchRepoFile: fetchGithubRepoFile },
      );
    } catch (e) {
      if (e instanceof PublishManifestError) {
        return { ok: false, status: e.status, error: e.message };
      }
      throw e;
    }
  }

  const result = await publishListingToCupboard({
    listing_kind: listingKind,
    listing_ref: listingRef,
    project_ref: typeof input.project_ref === 'string' ? input.project_ref : undefined,
    ...coords,
    title: typeof input.title === 'string' ? input.title : (installed?.name ?? slug),
    description:
      typeof input.description === 'string'
        ? input.description
        : typeof installed?.description === 'string'
          ? installed.description
          : undefined,
    ...(providesTools.length > 0 ? { provides_tools: providesTools } : {}),
    ...(providesEvents.length > 0 ? { provides_events: providesEvents } : {}),
    ...(requiresEvents.length > 0 ? { requires_events: requiresEvents } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
      detail: result.detail,
      upstream_status: result.upstream_status,
    };
  }
  return { ok: true, listing_kind: listingKind, listing: result.data };
}
