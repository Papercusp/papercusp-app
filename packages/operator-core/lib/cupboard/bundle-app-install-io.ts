/**
 * bundle-app-install-io — the REAL (git + network + PG) wiring for installing a
 * Cupboard bundle-app (cupboard-app-distribution-2026-07-14 P-008, "REMAINING
 * for done" item 2).
 *
 * Composes the SAME per-kind installers every other Cupboard kind already
 * uses (D-002 no-second-install-runtime) behind the pure `installBundleApp`
 * core (bundle-app-manifest.ts):
 *   - packs/plugins → `resolveAndInstallDeps` (resolve-and-install.ts) with
 *     `installUnit: installCupboardUnitFromListing` (install-io.ts) — the exact
 *     loop `cupboard:install-plugin`'s dep-closure and `harness:create` use.
 *   - datatypes → `installPublishedDatatype` (datatype-registry-store.ts) —
 *     the same core `datatypes:install` calls.
 *   - blueprint → `installBlueprintFromCupboardCore` (install-blueprint-core.ts)
 *     — the same core `cupboard:install-blueprint` calls. Its result carries no
 *     durable "installed FROM this bundle" provenance on its own (a copied
 *     blueprint dir has no `.git`), so this module stamps a small sidecar file
 *     (`.papercusp-bundle-source.json`) after a successful install and reads it
 *     back for `installedBlueprintSource` — the ONLY way a later bundle-app
 *     conflict review can tell "already installed from THIS bundle" (duplicate,
 *     safe to skip) apart from "something else occupies this blueprint id"
 *     (conflict, never silently overwritten). A blueprint dir that exists
 *     without the sidecar (installed some other way — built-in, a direct
 *     cupboard:install-blueprint, hand-placed) is conservatively a conflict,
 *     never assumed same-source.
 *
 * Shared by the loopback POST /cupboard/install-app route AND the
 * agent-callable `cupboard:install-app` tool — no fork.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { getDatatype, installPublishedDatatype } from '../datatype-registry-store';
import { INSTALLED_BLUEPRINTS_DIR, operatorResolveExtends } from '../blueprint/installed-blueprints';
import { resolveCupboardBaseUrl } from './base-url';
import { derivePackCatalog, depHostSetsFromCatalog } from './pack-catalog';
import { gitCloneShallow, installCupboardUnitFromListing } from './install-io';
import { fetchCupboardBlueprintIds } from './install-blueprint-io';
import { installBlueprintFromCupboardCore, InstallBlueprintError } from './install-blueprint-core';
import { installTemplateFromCupboard } from './install-template-io';
import { userTemplatesDir } from './template-store';
import { installRubricFromCupboard } from './install-rubric-io';
import { userRubricsDir } from './rubric-store';
import { fetchBundleManifest, BundleManifestError } from './bundle-manifest-io';
import {
  planBundleAppInstall,
  installBundleApp,
  bundleUnitSource,
  type BundleAppManifest,
  type BundleContentUnit,
  type BundleHostState,
  type BundleAppInstallResult,
} from './bundle-app-manifest';
import {
  resolveAndInstallDeps,
  type DepSet,
  type ResolveAndInstallResult,
} from './resolve-and-install';

export interface InstallBundleAppInput {
  /** Resolve the repo URL + listing_ref from the Cupboard 'app' listing (delivery_type must be 'bundle'). */
  listingId?: string;
  /** OR install a repo directly (listingRef = the bundle subdir). */
  githubUrl?: string;
  listingRef?: string;
  /** Proceed even when the review finds unresolved conflicts (mirrors installBundleApp's opt-in). */
  allowConflicts?: boolean;
}

export interface InstallBundleAppOptions {
  workspaceId: string;
  /**
   * Install a content-only bundle before the operator/PG runtime exists. The
   * manifest is fail-closed to blueprints/templates/rubrics, catalog reads stay
   * local, and the ordinary dependency/datatype install paths remain disabled.
   */
  offlineContentOnly?: boolean;
  /** Place rubric directories now and let the ordinary post-PG lazy seed make
   * them live. Every interactive/API caller keeps the default seeded contract. */
  deferRubricSeed?: boolean;
}

export type InstallBundleAppOutcome =
  | { ok: true; manifest: BundleAppManifest; result: BundleAppInstallResult }
  | { ok: false; status: number; error: string; detail?: string };

/** Resolve a Cupboard 'app'/bundle listing id → { githubUrl, listingRef }. */
async function resolveBundleAppListing(
  id: string,
): Promise<{ githubUrl: string; listingRef?: string } | { error: string; status: number }> {
  const base = resolveCupboardBaseUrl();
  let row: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${base}/listings/${encodeURIComponent(id)}`, {
      headers: { 'User-Agent': 'papercusp-operator/1' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { error: 'listing_not_found_or_unreachable', status: 404 };
    const data = (await res.json()) as Record<string, unknown> | null;
    row =
      (data?.harness as Record<string, unknown> | undefined) ??
      (data?.listing as Record<string, unknown> | undefined) ??
      (data as Record<string, unknown>);
  } catch {
    return { error: 'listing_not_found_or_unreachable', status: 404 };
  }
  if (row?.listing_kind !== 'app' || row?.delivery_type !== 'bundle') {
    return {
      error: `listing is kind=${String(row?.listing_kind ?? 'unknown')}/delivery_type=${String(row?.delivery_type ?? 'none')}, not a bundle app`,
      status: 422,
    };
  }
  const githubUrl = typeof row.github_url === 'string' ? row.github_url : '';
  if (!githubUrl) return { error: 'listing has no github_url', status: 422 };
  const listingRef = typeof row.listing_ref === 'string' ? row.listing_ref : undefined;
  return { githubUrl, listingRef };
}

const BUNDLE_SOURCE_SIDECAR = '.papercusp-bundle-source.json';

/** Read the bundle-install provenance sidecar for an installed content dir.
 *  `null` = the unit isn't installed; an installed unit with no sidecar
 *  (unknown provenance — the caller treats that as a conflict, never a
 *  same-source duplicate). */
/** @internal Exported only for the provenance recurrence guard. */
export async function readBundleSource(dir: string, manifestFile: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(join(dir, BUNDLE_SOURCE_SIDECAR), 'utf8');
    const parsed = JSON.parse(raw) as { source?: unknown };
    return typeof parsed.source === 'string' && parsed.source ? parsed.source : null;
  } catch {
    // Sidecar absent — but the blueprint dir itself may still exist (installed
    // some other way). Distinguish "not installed at all" (→ clean, per
    // BundleHostState's contract) from "installed, unknown provenance" (→ must
    // read as a real, non-matching source string so planBundleAppInstall calls
    // it a conflict rather than silently treating it as absent/clean).
    try {
      await fs.access(join(dir, manifestFile));
      return 'unknown (not installed via a bundle app)';
    } catch {
      return null;
    }
  }
}

/** @internal Exported only for the provenance recurrence guard. */
export async function writeBundleSource(dir: string, unit: BundleContentUnit): Promise<void> {
  await fs.writeFile(
    join(dir, BUNDLE_SOURCE_SIDECAR),
    JSON.stringify({
      source: bundleUnitSource(unit),
      githubUrl: unit.githubUrl,
      ...(unit.listingRef ? { listingRef: unit.listingRef } : {}),
      installedAt: new Date().toISOString(),
    }),
    'utf8',
  );
}

/** Real `BundleHostState` — the live workspace's datatype registry + pack
 *  catalog + installed-blueprint provenance. */
function makeHostState(workspaceId: string, opts: InstallBundleAppOptions): BundleHostState {
  return {
    hasDatatype: async (id) => {
      if (opts.offlineContentOnly) {
        throw new Error(`offline content bootstrap refuses datatype "${id}"`);
      }
      return (await getDatatype(getOrgPg().sql, workspaceId, id)) != null;
    },
    deriveCatalog: () =>
      derivePackCatalog(
        opts.offlineContentOnly
          ? { includeCupboard: false, warmHost: false }
          : {},
      ),
    installedBlueprintSource: (unit) => readBundleSource(join(INSTALLED_BLUEPRINTS_DIR(), unit.id), 'blueprint.yaml'),
    installedTemplateSource: (unit) =>
      readBundleSource(join(userTemplatesDir(), unit.listingRef ?? unit.id), 'template.yaml'),
    installedRubricSource: (unit) =>
      readBundleSource(join(userRubricsDir(), unit.listingRef ?? unit.id), 'rubric.json'),
  };
}

/** Real `BundleAppInstallers` — reuses `resolveAndInstallDeps` verbatim for
 *  packs/plugins (D-002: no second install runtime), `installPublishedDatatype`
 *  for datatypes, and `installBlueprintFromCupboardCore` (+ the provenance
 *  sidecar) for the optional blueprint leg. */
/** @internal Exported for the offline/deferred-seed recurrence guard. */
export function makeBundleAppInstallers(workspaceId: string, opts: InstallBundleAppOptions) {
  return {
    resolveAndInstallDeps: (declared: Partial<DepSet>): Promise<ResolveAndInstallResult> => {
      if (opts.offlineContentOnly) {
        const packs = declared.packs ?? [];
        const plugins = declared.plugins ?? [];
        if (packs.length > 0 || plugins.length > 0) {
          return Promise.resolve({
            ok: false,
            installed: [],
            stillMissing: { tools: [], packs, plugins, events: [] },
            advisory: ['offline content bootstrap refuses pack/plugin installation'],
            rounds: 0,
          });
        }
        return Promise.resolve({
          ok: true,
          installed: [],
          stillMissing: { tools: [], packs: [], plugins: [], events: [] },
          advisory: [],
          rounds: 0,
        });
      }
      return resolveAndInstallDeps(
        { packs: declared.packs ?? [], plugins: declared.plugins ?? [] },
        { deriveCatalog: () => derivePackCatalog({}), installUnit: (u) => installCupboardUnitFromListing(u) },
      );
    },
    installDatatype: async (id: string) => {
      if (opts.offlineContentOnly) {
        return { ok: false as const, error: `offline content bootstrap refuses datatype "${id}"` };
      }
      const res = await installPublishedDatatype(getOrgPg().sql, id, workspaceId);
      return res.ok ? { ok: true as const } : { ok: false as const, error: res.reason };
    },
    installBlueprint: async (blueprint: BundleContentUnit) => {
      try {
        const res = await installBlueprintFromCupboardCore(
          { githubUrl: blueprint.githubUrl, listingRef: blueprint.listingRef },
          {
            cloneRepo: gitCloneShallow,
            installedBlueprintsDir: INSTALLED_BLUEPRINTS_DIR,
            tmpDir: tmpdir,
            resolveExtends: operatorResolveExtends(),
            resolveHostSets: async () => {
              const catalog = await derivePackCatalog(
                opts.offlineContentOnly
                  ? { includeCupboard: false, warmHost: false }
                  : {},
              );
              const cupboardBlueprints = opts.offlineContentOnly
                ? new Set<string>()
                : await fetchCupboardBlueprintIds();
              return {
                ...depHostSetsFromCatalog(catalog),
                cupboardBlueprints,
                cupboardReachable: catalog.cupboardReachable,
              };
            },
          },
        );
        if (res.id !== blueprint.id) {
          return {
            ok: false as const,
            error: `bundle declared blueprint id "${blueprint.id}" but the repo's blueprint.yaml declares "${res.id}"`,
          };
        }
        await writeBundleSource(join(INSTALLED_BLUEPRINTS_DIR(), res.id), blueprint);
        return { ok: true as const };
      } catch (e) {
        if (e instanceof InstallBlueprintError) return { ok: false as const, error: e.message };
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    },
    installTemplate: async (template: BundleContentUnit) => {
      const res = await installTemplateFromCupboard({
        githubUrl: template.githubUrl,
        listingRef: template.listingRef ?? template.id,
      });
      if (!res.ok) return { ok: false as const, error: res.error };
      if (res.result.id !== template.id) {
        return {
          ok: false as const,
          error: `bundle declared template id "${template.id}" but the installed template declares "${res.result.id}"`,
        };
      }
      try {
        await writeBundleSource(res.result.installedTo, template);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    },
    installRubric: async (rubric: BundleContentUnit) => {
      const res = await installRubricFromCupboard({
        githubUrl: rubric.githubUrl,
        listingRef: rubric.listingRef ?? rubric.id,
        skipSeed: opts.deferRubricSeed === true,
      });
      if (!res.ok) return { ok: false as const, error: res.error };
      if (res.result.rubricId !== rubric.id) {
        return {
          ok: false as const,
          error: `bundle declared rubric id "${rubric.id}" but the installed rubric declares "${res.result.rubricId}"`,
        };
      }
      try {
        await writeBundleSource(res.result.installedTo, rubric);
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
      if (!res.result.seeded && !opts.deferRubricSeed) {
        return {
          ok: false as const,
          error: `rubric "${rubric.id}" installed but did not seed${res.result.seedError ? `: ${res.result.seedError}` : ''}`,
        };
      }
      return { ok: true as const };
    },
  };
}

/**
 * The ONE orchestrated path that installs a bundle-app from the Cupboard by
 * listing id OR direct github url: resolve coords → fetch + parse bundle.yaml
 * → review + install through the pure core (real host state + installers).
 * Never throws for an expected failure; the caller maps status+error.
 */
export async function installBundleAppFromCupboard(
  input: InstallBundleAppInput,
  opts: InstallBundleAppOptions,
): Promise<InstallBundleAppOutcome> {
  let githubUrl = typeof input.githubUrl === 'string' ? input.githubUrl.trim() : '';
  let listingRef = typeof input.listingRef === 'string' ? input.listingRef.trim() : undefined;

  if (!githubUrl && input.listingId) {
    const resolved = await resolveBundleAppListing(String(input.listingId));
    if ('error' in resolved) return { ok: false, status: resolved.status, error: resolved.error };
    githubUrl = resolved.githubUrl;
    listingRef = listingRef ?? resolved.listingRef;
  }
  if (!githubUrl) return { ok: false, status: 400, error: 'githubUrl or listingId required' };

  let manifest: BundleAppManifest;
  try {
    manifest = await fetchBundleManifest({ githubUrl, listingRef }, { cloneRepo: gitCloneShallow, tmpDir: tmpdir });
  } catch (e) {
    if (e instanceof BundleManifestError) return { ok: false, status: e.status, error: e.message };
    return {
      ok: false,
      status: 500,
      error: 'manifest fetch failed',
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }

  try {
    if (
      opts.offlineContentOnly &&
      ((manifest.datatypes?.length ?? 0) > 0 ||
        (manifest.packs?.length ?? 0) > 0 ||
        (manifest.plugins?.length ?? 0) > 0)
    ) {
      return {
        ok: false,
        status: 422,
        error: 'offline content bootstrap accepts only blueprints, templates, and rubrics',
      };
    }
    const host = makeHostState(opts.workspaceId, opts);
    const installers = makeBundleAppInstallers(opts.workspaceId, opts);
    const result = await installBundleApp(manifest, host, installers, {
      allowConflicts: input.allowConflicts === true,
    });
    return { ok: true, manifest, result };
  } catch (e) {
    return {
      ok: false,
      status: 500,
      error: 'install failed',
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }
}

/**
 * Review-only: resolve + fetch the manifest and run the conflict classification
 * WITHOUT installing anything — the UI's "what would this do" preview before
 * the user commits (mirrors knowledge_packs:install's dry review step).
 */
export async function reviewBundleAppFromCupboard(
  input: Omit<InstallBundleAppInput, 'allowConflicts'>,
  opts: { workspaceId: string },
): Promise<
  | { ok: true; manifest: BundleAppManifest; review: Awaited<ReturnType<typeof planBundleAppInstall>> }
  | { ok: false; status: number; error: string; detail?: string }
> {
  let githubUrl = typeof input.githubUrl === 'string' ? input.githubUrl.trim() : '';
  let listingRef = typeof input.listingRef === 'string' ? input.listingRef.trim() : undefined;

  if (!githubUrl && input.listingId) {
    const resolved = await resolveBundleAppListing(String(input.listingId));
    if ('error' in resolved) return { ok: false, status: resolved.status, error: resolved.error };
    githubUrl = resolved.githubUrl;
    listingRef = listingRef ?? resolved.listingRef;
  }
  if (!githubUrl) return { ok: false, status: 400, error: 'githubUrl or listingId required' };

  let manifest: BundleAppManifest;
  try {
    manifest = await fetchBundleManifest({ githubUrl, listingRef }, { cloneRepo: gitCloneShallow, tmpDir: tmpdir });
  } catch (e) {
    if (e instanceof BundleManifestError) return { ok: false, status: e.status, error: e.message };
    return {
      ok: false,
      status: 500,
      error: 'manifest fetch failed',
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }

  try {
    const review = await planBundleAppInstall(manifest, makeHostState(opts.workspaceId, opts));
    return { ok: true, manifest, review };
  } catch (e) {
    return {
      ok: false,
      status: 500,
      error: 'review failed',
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }
}
