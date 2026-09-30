/**
 * Local installed-datatype store — the data layer behind Cupboard `kind='datatype'`.
 *
 * A datatype package is an inert, self-describing directory:
 *
 *   <install-ref>/datatype.json — versioned datatype-DEFINITION manifest
 *   <install-ref>/listing.json  — ordinary Cupboard/storefront metadata
 *
 * D-010 / identities-v1-2026-08-30 P-027: `datatype_registry` remains the
 * RESOLUTION layer and this store never becomes a second one. The package is the
 * DISTRIBUTION layer only — repo dir in, registry row out, exactly the
 * install-rubric-core shape ("the store's dir is NOT the live rubric"). Reading a
 * package here resolves nothing and registers nothing; a datatype only becomes
 * live when the install path seeds a `datatype_registry` row from this manifest.
 *
 * Validation is deliberately the DECLARE-time gate, re-run at the package
 * boundary: a package whose payloadSchema does not compile, or whose
 * generic-kind/first-class tier omits the P-010 self-improvement surface, is not
 * a usable package. Distributing a definition must not be a way to smuggle in a
 * datatype that `meta:define-datatype` would have refused.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '../papercusp-root';
import { isCompilableSchema } from '../datatype-payload-validation';
import {
  isDatatypeTier,
  slugifyDatatype,
  type DatatypeTier,
} from '../datatype-registry-store';
import {
  enumerateSelfDescribingDirs,
  inRepoFallbackDir,
  selfDescribingRoots,
} from './self-describing-store';

export const DATATYPE_MANIFEST = 'datatype.json';
export const DATATYPE_PACKAGE_SCHEMA_VERSION = 1 as const;
const DATATYPE_MANIFEST_MAX_BYTES = 256 * 1024;
const LISTING_MANIFEST_MAX_BYTES = 32 * 1024;
const PACKAGE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const WORK_ITEM_KIND_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

/** Tiers whose declaration requires the P-010 self-improvement surface. */
const SELF_IMPROVING_TIERS: readonly DatatypeTier[] = ['generic-kind', 'first-class'];

export interface DatatypePackageManifest {
  schemaVersion: typeof DATATYPE_PACKAGE_SCHEMA_VERSION;
  /** The kebab slug that becomes the `datatype_registry` id on install. */
  id: string;
  title: string;
  description: string;
  version: string;
  tier: DatatypeTier;
  /** generic-kind: the `work_items:create` kind this datatype registers. */
  workItemKind?: string;
  payloadSchema?: Record<string, unknown>;
  display?: Record<string, unknown>;
  /** projection tier: the external single-writer (D-008). */
  authoritativeWriter?: string;
  selfImprovement?: Record<string, unknown>;
  tags?: string[];
}

export interface InstalledDatatype {
  installed: true;
  packageRef: string;
  listingRef: string;
  /** Stable, opaque, package-scoped identity — never the registry id. */
  installedId: string;
  /** The slug a later `datatype_registry` row is declared under. */
  id: string;
  title: string;
  description: string;
  version: string;
  tier: DatatypeTier;
  workItemKind: string | null;
  payloadSchema: Record<string, unknown> | null;
  display: Record<string, unknown> | null;
  authoritativeWriter: string | null;
  selfImprovement: Record<string, unknown> | null;
  tags: string[];
  source: string;
  dir: string;
}

export interface DatatypeRoot {
  dir: string;
  layer: 'bundled' | 'user';
}

const inRepoDatatypesDir = inRepoFallbackDir('datatypes', import.meta.url);

export function userInstalledDatatypesDir(): string {
  return papercuspPath('datatypes', 'installed');
}

export function installedDatatypeRoots(): DatatypeRoot[] {
  return selfDescribingRoots({
    envVar: 'PAPERCUSP_DATATYPES_DIR',
    devFallbackDir: inRepoDatatypesDir,
    userSubdir: 'datatypes/installed',
  });
}

function readJsonObject(path: string, maxBytes: number): Record<string, unknown> | null {
  try {
    if (!existsSync(path) || statSync(path).size > maxBytes) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tagList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return null;
  const tags: string[] = [];
  for (const entry of value) {
    const tag = stringValue(entry, 60);
    if (!tag) return null;
    tags.push(tag);
  }
  return tags;
}

/** A stable, opaque, package-scoped identity. Deliberately NOT the registry id:
 * two workspaces may install the same definition, and the registry PK is the
 * slug, so the install layer needs its own collision-resistant handle. */
export function installedDatatypeId(source: string, listingRef: string): string {
  const digest = createHash('sha256')
    .update(`${source.trim().toLowerCase()}\0${listingRef.trim()}`)
    .digest('hex')
    .slice(0, 16);
  return `installed:${digest}`;
}

/** The on-disk directory name — readable, with the hash supplying collision
 * resistance when long owner/repo/ref combinations are truncated. */
export function installedDatatypeRef(githubUrl: string, listingRef: string): string {
  let repo = 'datatype';
  try {
    const url = new URL(githubUrl);
    repo = url.pathname.replace(/\.git\/?$/, '').replace(/^\/+|\/+$/g, '') || repo;
  } catch {
    /* fall through to the default stem */
  }
  const stem = `${repo}/${listingRef}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const digest = createHash('sha256')
    .update(`${githubUrl.trim().toLowerCase()}\0${listingRef.trim()}`)
    .digest('hex')
    .slice(0, 8);
  return `${stem || 'datatype'}-${digest}`;
}

/**
 * Parse the two package files with the exact validation used by enumeration and
 * install. Null means the directory is not a usable datatype package.
 */
export function readDatatypeDir(
  dir: string,
  packageRef: string,
  _layer: 'bundled' | 'user' = 'user',
): InstalledDatatype | null {
  const manifest = readJsonObject(join(dir, DATATYPE_MANIFEST), DATATYPE_MANIFEST_MAX_BYTES);
  const listing = readJsonObject(join(dir, 'listing.json'), LISTING_MANIFEST_MAX_BYTES);
  if (!manifest || !listing) return null;
  if (listing.kind !== 'datatype' && listing.listing_kind !== 'datatype' && listing.scope !== 'datatype') {
    return null;
  }
  if (manifest.schemaVersion !== DATATYPE_PACKAGE_SCHEMA_VERSION) return null;

  const id = stringValue(manifest.id, 120);
  // The id IS the registry PK on install, so it must already be the canonical
  // slug — never silently re-slugified here, or the package and the row it seeds
  // would disagree about the datatype's identity.
  if (!id || slugifyDatatype(id) !== id) return null;

  const title = stringValue(manifest.title, 200) ?? stringValue(listing.title, 200);
  const description = stringValue(manifest.description, 2000) ?? stringValue(listing.description, 2000);
  const version = stringValue(manifest.version, 64) ?? stringValue(listing.version, 64);
  const source =
    stringValue(listing.source, 500) ??
    stringValue(listing.github_url, 500) ??
    stringValue(listing.githubUrl, 500);
  const listingRef = stringValue(listing.ref, 200) ?? stringValue(listing.listing_ref, 200) ?? id;
  if (!title || !description || !version || !source) return null;
  if (!PACKAGE_VERSION_RE.test(version)) return null;

  const tier = stringValue(manifest.tier, 40);
  if (!tier || !isDatatypeTier(tier)) return null;

  const workItemKind = manifest.workItemKind === undefined ? null : stringValue(manifest.workItemKind, 80);
  if (manifest.workItemKind !== undefined && (!workItemKind || !WORK_ITEM_KIND_RE.test(workItemKind))) return null;

  let payloadSchema: Record<string, unknown> | null = null;
  if (manifest.payloadSchema !== undefined) {
    payloadSchema = objectValue(manifest.payloadSchema);
    // Same P-001 gate `meta:define-datatype` applies: an instance of this
    // datatype must be validatable, so a schema that cannot compile is not a
    // package we will install.
    if (!payloadSchema || !isCompilableSchema(payloadSchema)) return null;
  }

  let display: Record<string, unknown> | null = null;
  if (manifest.display !== undefined) {
    display = objectValue(manifest.display);
    if (!display) return null;
  }

  let selfImprovement: Record<string, unknown> | null = null;
  if (manifest.selfImprovement !== undefined) {
    selfImprovement = objectValue(manifest.selfImprovement);
    if (!selfImprovement) return null;
  }
  // P-010 survives the distribution boundary: a generic-kind/first-class
  // datatype is self-improvable by construction, and shipping one as a package
  // must not be the way that stops being true.
  if (SELF_IMPROVING_TIERS.includes(tier) && !selfImprovement) return null;

  const authoritativeWriter =
    manifest.authoritativeWriter === undefined ? null : stringValue(manifest.authoritativeWriter, 120);
  if (manifest.authoritativeWriter !== undefined && !authoritativeWriter) return null;

  const tags = tagList(manifest.tags);
  if (!tags) return null;

  return {
    installed: true,
    packageRef,
    listingRef,
    // Trust the source-qualified local package ref chosen by the installer, not
    // a publisher-authored `source` string inside listing.json.
    installedId: installedDatatypeId(`package:${packageRef}`, listingRef),
    id,
    title,
    description,
    version,
    tier,
    workItemKind,
    payloadSchema,
    display,
    authoritativeWriter,
    selfImprovement,
    tags,
    source,
    dir,
  };
}

export function readDatatypeDirForInstall(dir: string, packageRef: string): InstalledDatatype | null {
  return readDatatypeDir(dir, packageRef, 'user');
}

export function listInstalledDatatypes(
  roots: DatatypeRoot[] = installedDatatypeRoots(),
): InstalledDatatype[] {
  return enumerateSelfDescribingDirs(roots, readDatatypeDir);
}

export function resolveInstalledDatatype(
  idOrRef: string,
  roots: DatatypeRoot[] = installedDatatypeRoots(),
): InstalledDatatype | null {
  const key = idOrRef.trim();
  if (!key) return null;
  return (
    listInstalledDatatypes(roots).find(
      (entry) => entry.id === key || entry.packageRef === key || entry.installedId === key,
    ) ?? null
  );
}

export interface WrittenDatatypePackage {
  ref: string;
  dir: string;
  manifestPath: string;
  listingPath: string;
  manifest: DatatypePackageManifest;
}

/** The registry-row shape `writeDatatypePackageDir` exports from. Structurally a
 * subset of a `datatype_registry` row, so a publisher hands the row it already
 * has rather than re-typing the definition. */
export interface DatatypeExportSource {
  id: string;
  title?: string | null;
  description?: string | null;
  tier: string;
  workItemKind?: string | null;
  payloadSchema?: Record<string, unknown> | null;
  display?: Record<string, unknown> | null;
  authoritativeWriter?: string | null;
  selfImprovement?: Record<string, unknown> | null;
  tags?: string[] | null;
}

/**
 * Materialize a locally-declared datatype as a self-describing package ready to
 * push to a Cupboard mirror. Re-exporting the same datatype replaces only its
 * export directory; it never writes to the installed layer or the registry.
 */
export function writeDatatypePackageDir(
  input: DatatypeExportSource,
  opts: {
    ref?: string;
    version?: string;
    description?: string;
    source: string;
    targetDir?: string;
  },
): WrittenDatatypePackage {
  const id = String(input?.id ?? '').trim();
  if (!id || slugifyDatatype(id) !== id) {
    throw new Error(`invalid datatype id ${JSON.stringify(id)} — expected a canonical kebab slug`);
  }
  const tier = String(input?.tier ?? '').trim();
  if (!isDatatypeTier(tier)) throw new Error(`invalid datatype tier ${JSON.stringify(tier)}`);

  const ref = (opts.ref ?? id).trim();
  if (!SAFE_REF_RE.test(ref)) throw new Error(`unsafe datatype ref ${JSON.stringify(ref)}`);
  const version = (opts.version ?? '0.1.0').trim();
  if (!PACKAGE_VERSION_RE.test(version)) throw new Error(`invalid datatype version ${JSON.stringify(version)}`);
  const source = opts.source.trim();
  if (!source || source.length > 500) {
    throw new Error('datatype package source is required and must be ≤ 500 characters');
  }

  const description = (opts.description ?? input.description ?? '').trim();
  if (!description) throw new Error('datatype package description is required');
  if (input.payloadSchema && !isCompilableSchema(input.payloadSchema)) {
    throw new Error('payloadSchema is not a valid JSON Schema — fix it before publishing');
  }
  if (SELF_IMPROVING_TIERS.includes(tier) && !input.selfImprovement) {
    throw new Error(
      `a ${tier} datatype must carry its self-improvement surface (P-010) to be published`,
    );
  }

  const root = opts.targetDir ?? papercuspPath('datatypes', 'exports');
  const dir = join(root, ref);
  mkdirSync(dir, { recursive: true });
  const manifest: DatatypePackageManifest = {
    schemaVersion: DATATYPE_PACKAGE_SCHEMA_VERSION,
    id,
    title: (input.title ?? id).trim() || id,
    description,
    version,
    tier,
    ...(input.workItemKind ? { workItemKind: input.workItemKind } : {}),
    ...(input.payloadSchema ? { payloadSchema: input.payloadSchema } : {}),
    ...(input.display ? { display: input.display } : {}),
    ...(input.authoritativeWriter ? { authoritativeWriter: input.authoritativeWriter } : {}),
    ...(input.selfImprovement ? { selfImprovement: input.selfImprovement } : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
  };
  const manifestPath = join(dir, DATATYPE_MANIFEST);
  const listingPath = join(dir, 'listing.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(
    listingPath,
    `${JSON.stringify(
      {
        kind: 'datatype',
        ref,
        id,
        title: manifest.title,
        description: manifest.description,
        version,
        source,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { ref, dir, manifestPath, listingPath, manifest };
}
