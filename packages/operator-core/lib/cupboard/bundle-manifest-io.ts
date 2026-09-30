/**
 * bundle-manifest-io — fetch + parse a Cupboard bundle-app's `bundle.yaml`
 * (cupboard-app-distribution-2026-07-14 P-008, "REMAINING for done" item 1).
 *
 * A `delivery_type: 'bundle'` app listing is GitHub-repo-backed, the same shape
 * as a blueprint/template listing (D-003 reuse-first): the listing points at a
 * repo whose `<listing_ref>/bundle.yaml` (or root `bundle.yaml` for a
 * single-bundle repo) declares the `BundleAppManifest` (bundle-app-manifest.ts)
 * — a named composition of datatypes/packs/plugins/an optional blueprint.
 * Fetching it = git-clone the repo, locate the file, parse + shape-check it.
 * Mirrors `install-blueprint-core.ts`'s clone+locate+parse pattern exactly, DI'd
 * the same way (clone / tmp dir injected) so it's unit-testable without git or
 * the network.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { BundleAppManifest, BundleContentUnit } from './bundle-app-manifest';

export interface FetchBundleManifestInput {
  /** The bundle repo's GitHub URL (https://github.com/owner/repo[.git]). */
  githubUrl: string;
  /** Within-repo subdir to look in first (a repo hosting several bundles). */
  listingRef?: string;
}

export interface FetchBundleManifestDeps {
  /** Shallow-clone `url` into `dest` (which does not yet exist). Throws on failure. */
  cloneRepo: (url: string, dest: string) => Promise<void>;
  /** A scratch dir for the clone (real: os.tmpdir()). */
  tmpDir: () => string;
}

const GITHUB_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}?(?:\.git)?\/?$/;

/** A within-repo subdir ref must be relative, charset-safe, and contain no `..`/empty segment. */
function isSafeListingRef(ref: string): boolean {
  if (!ref || ref.length > 200 || ref.startsWith('/')) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  return ref.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export class BundleManifestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BundleManifestError';
  }
}

/** Find `bundle.yaml` within a freshly-cloned repo: prefers the `listingRef`
 *  subdir, else the repo root (single-bundle repo). Same precedence as
 *  `locateBlueprintDir` (install-blueprint-core.ts). */
function locateBundleFile(cloneDir: string, listingRef: string | undefined): string {
  const candidates: string[] = [];
  if (listingRef && isSafeListingRef(listingRef)) candidates.push(join(cloneDir, listingRef));
  candidates.push(cloneDir);
  for (const dir of candidates) {
    const f = join(dir, 'bundle.yaml');
    if (existsSync(f)) return f;
  }
  throw new BundleManifestError('no bundle.yaml found in the bundle repo (checked listing_ref subdir + root)', 422);
}

function normStringArray(v: unknown, field: string): string[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new BundleManifestError(`bundle.yaml "${field}" must be an array of strings`, 422);
  }
  return v as string[];
}

function parseContentUnit(v: unknown, field: string): BundleContentUnit {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) {
    throw new BundleManifestError(`bundle.yaml "${field}" must contain mappings`, 422);
  }
  const unit = v as Record<string, unknown>;
  const id = typeof unit.id === 'string' ? unit.id.trim() : '';
  const githubUrl = typeof unit.githubUrl === 'string' ? unit.githubUrl.trim() : '';
  if (!id || !githubUrl) {
    throw new BundleManifestError(`bundle.yaml "${field}" entries need "id" and "githubUrl"`, 422);
  }
  const listingRef = typeof unit.listingRef === 'string' ? unit.listingRef.trim() : '';
  return { id, githubUrl, ...(listingRef ? { listingRef } : {}) };
}

function parseContentUnits(v: unknown, field: string): BundleContentUnit[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v)) {
    throw new BundleManifestError(`bundle.yaml "${field}" must be an array of mappings`, 422);
  }
  return v.map((unit) => parseContentUnit(unit, field));
}

/** Parse + shape-check raw YAML content into a `BundleAppManifest`. Exported
 *  standalone so a caller with the text already in hand (e.g. a future
 *  publish-time validator) can reuse the shape-check without cloning. */
export function parseBundleManifest(raw: string): BundleAppManifest {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new BundleManifestError(`bundle.yaml failed to parse: ${e instanceof Error ? e.message : String(e)}`, 422);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BundleManifestError('bundle.yaml is not a mapping', 422);
  }
  const raw2 = parsed as Record<string, unknown>;
  const name = typeof raw2.name === 'string' ? raw2.name.trim() : '';
  if (!name) throw new BundleManifestError('bundle.yaml has no "name"', 422);

  let blueprint: BundleAppManifest['blueprint'] = null;
  if (raw2.blueprint != null) {
    blueprint = parseContentUnit(raw2.blueprint, 'blueprint');
  }

  const blueprints = parseContentUnits(raw2.blueprints, 'blueprints');
  const templates = parseContentUnits(raw2.templates, 'templates');
  const rubrics = parseContentUnits(raw2.rubrics, 'rubrics');

  return {
    name,
    ...(typeof raw2.description === 'string' ? { description: raw2.description } : {}),
    ...(normStringArray(raw2.datatypes, 'datatypes')
      ? { datatypes: normStringArray(raw2.datatypes, 'datatypes') }
      : {}),
    ...(normStringArray(raw2.packs, 'packs') ? { packs: normStringArray(raw2.packs, 'packs') } : {}),
    ...(normStringArray(raw2.plugins, 'plugins') ? { plugins: normStringArray(raw2.plugins, 'plugins') } : {}),
    ...(blueprint ? { blueprint } : {}),
    ...(blueprints ? { blueprints } : {}),
    ...(templates ? { templates } : {}),
    ...(rubrics ? { rubrics } : {}),
    // `surfaces` is a reserved no-op field (see bundle-app-manifest.ts header) —
    // passed through verbatim if declared, never validated/used.
    ...(Array.isArray(raw2.surfaces) ? { surfaces: raw2.surfaces } : {}),
  };
}

/**
 * Clone the bundle repo, locate `bundle.yaml` (listingRef subdir, else root),
 * and parse + shape-check it into a `BundleAppManifest`. Never throws for an
 * expected shape/lookup failure — those raise `BundleManifestError`; a clone
 * failure propagates from `deps.cloneRepo` as-is.
 */
export async function fetchBundleManifest(
  input: FetchBundleManifestInput,
  deps: FetchBundleManifestDeps,
): Promise<BundleAppManifest> {
  const url = (input.githubUrl ?? '').trim();
  if (!GITHUB_URL_RE.test(url)) {
    throw new BundleManifestError(`invalid github_url "${url}" — must be https://github.com/<owner>/<repo>`, 400);
  }
  const cloneDir = join(deps.tmpDir(), `cupboard-bundle-${Date.now()}-${Math.floor(performance.now())}`);
  try {
    await deps.cloneRepo(url, cloneDir);
    const file = locateBundleFile(cloneDir, input.listingRef);
    const raw = await fs.readFile(file, 'utf8');
    return parseBundleManifest(raw);
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}
