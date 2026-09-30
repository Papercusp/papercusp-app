/**
 * unlist-hive-rows — withdraw a hive's member-repo listings from the Cupboard
 * (hive-from-github-url-2026-06-11 P-015, the public→private flip's central
 * half; the directory half is ceasing to re-announce + peer TTL).
 *
 * For each member repo with a known id: GET /binding/:repoId → the active
 * listing id → DELETE /listings/:id (publisher-or-claimant authed via the
 * gh token, same posture as publish). Best-effort per row; never throws.
 */

import { loadHarnessRegistry, type ProjectEntry } from '../harness-registry';

export interface UnlistHiveRowsOutcome {
  attempted: number;
  unlisted: number;
  alreadyUnlisted: number;
  notFound: number;
  failed: number;
  errors?: string[];
}

export interface UnlistHiveRowsDeps {
  loadRegistry?: typeof loadHarnessRegistry;
  /** Resolve the active listing id for a repo (GET /binding/:repoId). */
  lookupListingId?: (githubRepositoryId: number) => Promise<number | string | null>;
  /** DELETE /listings/:id → outcome. */
  deleteListing?: (
    listingId: number | string,
  ) => Promise<{ ok: boolean; alreadyUnlisted?: boolean; error?: string }>;
}

async function defaultLookupListingId(repoId: number): Promise<number | string | null> {
  const { resolveCupboardBaseUrl } = await import(
    './base-url'
  );
  const res = await fetch(`${resolveCupboardBaseUrl()}/binding/${repoId}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { exists: boolean; harness?: { id: number | string } };
  return body.exists && body.harness ? body.harness.id : null;
}

async function defaultDeleteListing(
  listingId: number | string,
): Promise<{ ok: boolean; alreadyUnlisted?: boolean; error?: string }> {
  // The DELETE /listings/:id primitive lives in delete-listing.ts (P-009 D-001) —
  // shared with the cupboard:unpublish agent tool so there is one authed unlist path.
  const { deleteCupboardListing } = await import('./delete-listing');
  const res = await deleteCupboardListing(listingId);
  return { ok: res.ok, ...(res.alreadyUnlisted ? { alreadyUnlisted: true } : {}), ...(res.error ? { error: res.error } : {}) };
}

export async function unlistHiveCupboardRows(
  opts: { workspaceId: string; potSlug: string },
  deps: UnlistHiveRowsDeps = {},
): Promise<UnlistHiveRowsOutcome> {
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;
  const lookupListingId = deps.lookupListingId ?? defaultLookupListingId;
  const deleteListing = deps.deleteListing ?? defaultDeleteListing;

  const out: UnlistHiveRowsOutcome = {
    attempted: 0,
    unlisted: 0,
    alreadyUnlisted: 0,
    notFound: 0,
    failed: 0,
  };
  const errors: string[] = [];

  const reg = await loadRegistry(opts.workspaceId).catch(
    () => ({ projects: [] as ProjectEntry[] }),
  );
  const members = reg.projects.filter(
    (p) =>
      (p.slug === opts.potSlug || p.hive_slug === opts.potSlug) &&
      typeof p.github_repository_id === 'number',
  );
  for (const m of members) {
    out.attempted += 1;
    try {
      const id = await lookupListingId(m.github_repository_id!);
      if (id == null) {
        out.notFound += 1;
        continue;
      }
      const res = await deleteListing(id);
      if (res.ok && res.alreadyUnlisted) out.alreadyUnlisted += 1;
      else if (res.ok) out.unlisted += 1;
      else {
        out.failed += 1;
        if (res.error) errors.push(`${m.slug}: ${res.error}`);
      }
    } catch (e) {
      out.failed += 1;
      errors.push(`${m.slug}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (errors.length) out.errors = errors;
  return out;
}
