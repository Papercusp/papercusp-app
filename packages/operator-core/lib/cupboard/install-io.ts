/**
 * install-io — the REAL (git + network + host) wiring for installing a
 * Cupboard unit, shared by the install routes and the install-loop
 * (`tool-distribution-discovery-2026-06-08` P-002 / D-002).
 *
 * Both `cupboard:install-plugin` and the install-loop need the same IO: shallow
 * git-clone, the global-plugins dir, capability-grant, host-invalidate, and the
 * install-time dep-validation against the live pack catalog. This module is the
 * single source of those impls (DRY — previously inlined in the route), wrapping
 * the pure `installPluginFromCupboardCore`. A code-tool **pack** and a runtime
 * **plugin** install through the SAME core (a pack is a runtime-less plugin
 * manifest — base D-006 item 3), so one installer covers both.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createTextCollector } from '../child-output';
import { GLOBAL_PLUGINS_DIR } from '../plugin-catalog';
import { grantCapabilities } from '../plugin-grants';
import { resolveCupboardBaseUrl } from './base-url';
import {
  installPluginFromCupboardCore,
  InstallPluginError,
  type InstallPluginCoreDeps,
  type InstallPluginCoreInput,
  type InstallPluginManifestReview,
  type InstallPluginCoreResult,
} from './install-plugin-core';
import type { InstallableUnitRef } from './resolve-and-install';
import type { TreeDigestEntry } from '@papercusp/artifact-registry';
import type { InstallSelfDescribingDeps } from './install-self-describing-core';

/** Shallow `git clone --depth 1 url dest`. Rejects on non-zero exit. */
export function gitCloneShallow(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', '--', url, dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const err = createTextCollector(child.stderr);
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`git clone failed (exit ${code}): ${err.text().slice(0, 300)}`)),
    );
  });
}

/** Run one git command, resolving stdout on exit 0 and rejecting with a bounded
 *  stderr excerpt otherwise. `label` names the step in the rejection. */
function gitRun(args: string[], label: string, cwd?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) });
    const out: Buffer[] = [];
    const err = createTextCollector(child.stderr);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`${label} failed (exit ${code}): ${err.text().slice(0, 300)}`)),
    );
  });
}

/**
 * Fetch EXACTLY commit `sha` of `url` into `dest` (which does not yet exist) and check
 * it out detached — never the branch tip (cupboard-release-pipeline-content-trust
 * P-002). `git init` + `fetch --depth 1 origin <sha>` needs the server to serve
 * reachable shas by id, which GitHub does; an unreachable or garbage-collected sha
 * rejects here instead of silently degrading to the tip.
 */
export async function gitFetchAtSha(url: string, dest: string, sha: string): Promise<void> {
  await gitRun(['init', '-q', '--', dest], 'git init');
  await gitRun(['remote', 'add', 'origin', '--', url], 'git remote add', dest);
  await gitRun(['fetch', '-q', '--depth', '1', 'origin', sha], 'git fetch by sha', dest);
  await gitRun(['checkout', '-q', '--detach', 'FETCH_HEAD'], 'git checkout FETCH_HEAD', dest);
}

/**
 * Every BLOB under `<ref>/` at commit `sha` of the checkout at `cloneDir`, as
 * repo-relative paths (prefix kept) + git blob ids — the installer half of the
 * publisher's `pinListingContent` enumeration, so `canonicalTreeDigest` over these
 * equals the pinned digest exactly when the bytes are unchanged. Symlinks are blobs
 * on both sides; submodules (`commit`) are excluded on both.
 */
export async function gitListTreeBlobs(cloneDir: string, sha: string, ref: string): Promise<TreeDigestEntry[]> {
  const raw = await gitRun(['ls-tree', '-r', '-z', sha, '--', `${ref}/`], 'git ls-tree', cloneDir);
  const entries: TreeDigestEntry[] = [];
  // Records are `<mode> SP <type> SP <sha> TAB <path>` NUL-terminated; -z leaves paths unquoted.
  for (const rec of raw.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [, type, blobSha] = rec.slice(0, tab).split(' ');
    if (type !== 'blob' || !blobSha) continue;
    entries.push({ path: rec.slice(tab + 1), sha: blobSha });
  }
  return entries;
}

/** The real git-backed deps every self-describing Cupboard installer shares. */
export function cupboardGitDeps(): InstallSelfDescribingDeps {
  return { cloneRepo: gitCloneShallow, fetchAtSha: gitFetchAtSha, listTreeBlobs: gitListTreeBlobs, tmpDir: tmpdir };
}

/** Drop the in-memory plugin-host + api-route caches so a new unit goes live. */
export async function invalidatePluginHost(): Promise<void> {
  try {
    const { _resetPluginHostForTests } = await import('../plugin-host-runtime');
    _resetPluginHostForTests();
  } catch {
    /* host runtime not initialized */
  }
  try {
    const { _resetPluginApiRoutesForTests } = await import('../plugin-api-mount');
    _resetPluginApiRoutesForTests();
  } catch {
    /* mount cache not initialized */
  }
}

/** Resolve a Cupboard listing id → { githubUrl, listingRef } via the worker. */
export async function resolveListingCoords(
  id: string,
): Promise<{ githubUrl: string; listingRef?: string } | null> {
  const base = resolveCupboardBaseUrl();
  try {
    const res = await fetch(`${base}/listings/${encodeURIComponent(id)}`, {
      headers: { 'User-Agent': 'papercusp-operator/1' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown> | null;
    const row =
      (data?.harness as Record<string, unknown> | undefined) ??
      (data?.listing as Record<string, unknown> | undefined) ??
      (data as Record<string, unknown>);
    const githubUrl = typeof row?.github_url === 'string' ? row.github_url : '';
    if (!githubUrl) return null;
    const listingRef = typeof row?.listing_ref === 'string' ? row.listing_ref : undefined;
    return { githubUrl, listingRef };
  } catch {
    return null;
  }
}

/**
 * Build the real `InstallPluginCoreDeps` (clone / global-plugins dir / grant /
 * host-invalidate / dep-validate-against-the-live-catalog). The dep-validator
 * mirrors the harness:create gate: a transient cupboard-unreachable must not
 * hard-fail pack/plugin deps that may be installable there; missing TOOLS still
 * fail (the in-process catalog is authoritative).
 */
export function buildInstallPluginDeps(): InstallPluginCoreDeps {
  return {
    cloneRepo: gitCloneShallow,
    globalPluginsDir: GLOBAL_PLUGINS_DIR,
    tmpDir: tmpdir,
    grant: (args) => grantCapabilities({ ...args, grantedBy: 'user', reason: 'cupboard install-consent' }),
    invalidateHost: invalidatePluginHost,
    validateDependencies: async (deps) => {
      const { validateBlueprintDependencies, resolveEventProvider } = await import('@papercusp/blueprint-distribution');
      const { derivePackCatalog, depHostSetsFromCatalog } = await import('./pack-catalog');
      const catalog = await derivePackCatalog({});
      const verdict = validateBlueprintDependencies(deps, depHostSetsFromCatalog(catalog));

      // The EVENT axis (D-003 / P-007). `validateBlueprintDependencies` covers
      // tools/packs/plugins/blueprints/datatypes — deliberately NOT events,
      // which are a UNIT-level axis, not a blueprint one. So resolve them here,
      // against the SAME derived catalog, and fold the result into the verdict.
      const missingEvents: string[] = [];
      const installableEvents: Array<{ family: string; optional?: boolean }> = [];
      const eventMessages: string[] = [];
      for (const dep of deps.events ?? []) {
        if (!dep?.family) continue;
        const r = resolveEventProvider(dep.family, catalog.view);
        if (r.status === 'available') continue;
        if (r.status === 'installable') {
          installableEvents.push({ family: dep.family, ...(dep.optional ? { optional: true } : {}) });
          continue;
        }
        // Unknown. A REQUIRED family is as hard as a missing tool; an OPTIONAL
        // one is listen-if-present and must never block the install.
        if (dep.optional) continue;
        missingEvents.push(dep.family);
        eventMessages.push(`needs event family "${dep.family}" — nothing on this host provides it`);
      }

      const merged = {
        ...verdict,
        ok: verdict.ok && missingEvents.length === 0,
        missing: { ...verdict.missing, events: missingEvents },
        installable: { ...verdict.installable, events: installableEvents },
        messages: [...verdict.messages, ...eventMessages],
      };

      // Cupboard-unreachable softening (mirrors the tool axis): a transient
      // outage can't disprove a listing, so don't hard-fail pack/plugin/event
      // deps it might have provided — but a missing TOOL still fails, because
      // the in-process catalog is authoritative for those. A missing EVENT is
      // NOT authoritative that way (a Cupboard unit we couldn't see may declare
      // it), so it softens with packs/plugins rather than failing with tools.
      if (!catalog.cupboardReachable && merged.missing.tools.length === 0) {
        return { ...merged, ok: true };
      }
      return merged;
    },
  };
}

export type InstallPluginFromCupboardResult =
  | { ok: true; result: InstallPluginCoreResult }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * The ONE orchestrated path that installs a plugin/pack from the Cupboard by
 * listing id OR direct github url: resolve coords → install through the core
 * (dep gate + capability grant wired via buildInstallPluginDeps) → fire the
 * `plugin_install` backup trigger. Shared by the loopback POST
 * /cupboard/install-plugin route AND the agent-callable `cupboard:install-plugin`
 * tool (cupboard-agent-tool-coverage-2026-07-14 P-006, D-001 reuse-first) — never
 * throws for an expected failure; the caller maps status+error to its response.
 */
export async function installPluginFromCupboard(input: {
  listingId?: string;
  githubUrl?: string;
  listingRef?: string;
  harness?: string;
  acceptCapabilities?: boolean;
}): Promise<InstallPluginFromCupboardResult> {
  let githubUrl = typeof input.githubUrl === 'string' ? input.githubUrl.trim() : '';
  let listingRef = typeof input.listingRef === 'string' ? input.listingRef.trim() : undefined;

  if (!githubUrl && input.listingId) {
    const resolved = await resolveListingCoords(String(input.listingId));
    if (!resolved) return { ok: false, status: 404, error: 'listing_not_found_or_unreachable' };
    githubUrl = resolved.githubUrl;
    listingRef = listingRef ?? resolved.listingRef;
  }
  if (!githubUrl) return { ok: false, status: 400, error: 'githubUrl or listingId required' };

  const coreInput: InstallPluginCoreInput = {
    githubUrl,
    listingRef,
    harness: typeof input.harness === 'string' ? input.harness.trim() : undefined,
    acceptCapabilities: input.acceptCapabilities === true,
  };

  try {
    // Install-time dep gate is wired in buildInstallPluginDeps(): hard-missing deps
    // 422 before the copy; installable ones surface advisorily.
    const result = await installPluginFromCupboardCore(coreInput, buildInstallPluginDeps());

    // Fire the `plugin_install` backup trigger — "After plugin install" in
    // /settings/backups (ON by default). Emitted here (not inside the pure core,
    // which injects all IO) so BOTH callers get it. Best-effort: a backup failure
    // must never turn a successful install into an error.
    try {
      const [{ triggerSnapshotEvent }, { activeWorkspaceId }] = await Promise.all([
        import('../backup'),
        import('../workspace-registry'),
      ]);
      await triggerSnapshotEvent(activeWorkspaceId(), 'plugin_install', {
        op: 'plugin_install',
        githubUrl: coreInput.githubUrl,
        listingRef,
        harness: coreInput.harness,
      }).catch(() => {
        /* ignore */
      });
    } catch {
      /* backup module not loaded — fine */
    }

    return { ok: true, result };
  } catch (e) {
    if (e instanceof InstallPluginError) {
      return { ok: false, status: e.status, error: e.message };
    }
    return {
      ok: false,
      status: 500,
      error: 'install failed',
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }
}

/**
 * Install one resolved Cupboard unit (plugin or pack) by its listing id. The
 * loop-shaped return: `{ ok, declaredDeps }` surfaces the unit's OWN installable
 * deps for transitive recursion; `{ ok:false, error }` on a resolve/install
 * failure. Matches `ResolveAndInstallDeps['installUnit']`.
 */
export async function installCupboardUnitFromListing(
  unit: InstallableUnitRef,
  opts: {
    harness?: string;
    acceptCapabilities?: boolean;
    expectedReview?: InstallPluginManifestReview;
  } = {},
): Promise<
  | {
      ok: true;
      declaredDeps?: {
        tools: string[];
        packs: string[];
        plugins: string[];
        // Carries the unit's own installable EVENT deps into the loop's next
        // round, so an event dep pulls its providing Cupboard unit in exactly
        // as a tool dep does (D-003 / P-007).
        events?: Array<{ family: string; optional?: boolean }>;
      };
      review: InstallPluginManifestReview;
    }
  | { ok: false; error: string }
> {
  if (!unit.listingId) {
    return { ok: false, error: `unit "${unit.name}" has no Cupboard listing id to resolve` };
  }
  const coords = await resolveListingCoords(unit.listingId);
  if (!coords) {
    return { ok: false, error: `listing ${unit.listingId} not found or Cupboard unreachable` };
  }
  try {
    const result = await installPluginFromCupboardCore(
      {
        githubUrl: coords.githubUrl,
        listingRef: coords.listingRef,
        harness: opts.harness,
        acceptCapabilities: opts.acceptCapabilities === true,
        ...(opts.expectedReview ? { expectedReview: opts.expectedReview } : {}),
      },
      buildInstallPluginDeps(),
    );
    return {
      ok: true,
      declaredDeps: result.installableDependencies,
      review: result.review,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Vet one Cupboard plugin/pack through the exact install core in a disposable
 * destination. This performs clone, manifest/trigger validation and dependency
 * classification, but persists no plugin, grant, or host invalidation.
 */
export async function reviewCupboardUnitFromListing(
  unit: InstallableUnitRef,
  expectedProviderVersion?: string,
): Promise<{ ok: true; review: InstallPluginManifestReview } | { ok: false; error: string }> {
  if (!unit.listingId) {
    return { ok: false, error: `unit "${unit.name}" has no Cupboard listing id to review` };
  }
  const coords = await resolveListingCoords(unit.listingId);
  if (!coords) {
    return { ok: false, error: `listing ${unit.listingId} not found or Cupboard unreachable` };
  }
  const reviewDir = await fs.mkdtemp(join(tmpdir(), 'cupboard-provider-review-'));
  try {
    const real = buildInstallPluginDeps();
    const result = await installPluginFromCupboardCore(
      { githubUrl: coords.githubUrl, listingRef: coords.listingRef },
      {
        ...real,
        globalPluginsDir: () => reviewDir,
        grant: async () => {},
        invalidateHost: async () => {},
      },
    );
    if (result.name !== unit.name) {
      return { ok: false, error: `listing ${unit.listingId} resolved to ${result.name}, not ${unit.name}` };
    }
    if (expectedProviderVersion && result.version !== expectedProviderVersion) {
      return {
        ok: false,
        error: `selected provider ${unit.name}@${expectedProviderVersion} resolved to version ${result.version}`,
      };
    }
    return { ok: true, review: result.review };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await fs.rm(reviewDir, { recursive: true, force: true }).catch(() => {});
  }
}
