/**
 * Local installed-event store — the data layer behind Cupboard `kind='event'`.
 *
 * An event package is an inert, self-describing directory:
 *
 *   <install-ref>/event.json   — versioned event-key DEFINITION manifest
 *   <install-ref>/listing.json — ordinary Cupboard/storefront metadata
 *
 * D-010 / identities-v1-2026-08-30 P-029: `event_key_registry` remains the
 * RESOLUTION layer and this store never becomes a second one — the same split
 * `datatype-store` holds against `datatype_registry`. The package is the
 * DISTRIBUTION layer only: repo dir in, registry row out. Reading a package here
 * resolves nothing and registers nothing; an event key only becomes resolvable
 * when the install seam seeds an `event_key_registry` row from this manifest.
 *
 * WHY A PACKAGE CARRIES ONLY THE CURATED HALF
 * -------------------------------------------
 * D-058 splits a registry row in two. The CURATED half (title, description,
 * keyPattern, tags) is what a human asserts ABOUT a key and travels fine. The
 * DERIVED half (`emitter`, `emitterExists`, `emitSiteCount`, `derivedFrom`,
 * `derivedAt`) is a measurement of a SPECIFIC TREE, produced by a scan and
 * writable only through `recordEventKeyDerivation` — `RegisterEventKeyInput`
 * cannot express it, and a CHECK constraint refuses an undated derived write.
 *
 * That makes a derived field in a PACKAGE incoherent by construction: it would
 * be a claim about the PUBLISHER's tree, installed as if it were a measurement
 * of YOURS. So this parser REFUSES such a manifest rather than dropping the
 * fields silently — a publisher who ships `emitSiteCount` has misunderstood what
 * they are distributing, and a silent drop would let them keep believing the
 * attestation shipped. The derived half is re-derived locally, after install, or
 * it does not exist here. (Derived-truth ladder: DERIVE over CURATED, always.)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '../papercusp-root';
import { normalizeEventKey } from '../event-key-registry-store';
import {
  enumerateSelfDescribingDirs,
  inRepoFallbackDir,
  selfDescribingRoots,
} from './self-describing-store';

export const EVENT_MANIFEST = 'event.json';
export const EVENT_PACKAGE_SCHEMA_VERSION = 1 as const;
const EVENT_MANIFEST_MAX_BYTES = 64 * 1024;
const LISTING_MANIFEST_MAX_BYTES = 32 * 1024;
const PACKAGE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Fields a package may NEVER carry: the D-058 derived half. Present in a
 * manifest, each is a measurement of the publisher's tree masquerading as one of
 * yours, so the package is refused rather than partially honoured.
 */
export const DERIVED_ONLY_MANIFEST_FIELDS: readonly string[] = [
  'emitter',
  'emitterExists',
  'emitSiteCount',
  'derivedFrom',
  'derivedAt',
];

/**
 * Fields the INSTALL SITE owns, never the publisher. `contributor` is who
 * registered the key HERE and `status`/`published`/`reviewStatus` are lifecycle
 * the local registry and the Cupboard own — a package asserting any of them is
 * claiming an authority it does not have, so they are refused on the same
 * footing as the derived half.
 */
export const INSTALL_SITE_ONLY_MANIFEST_FIELDS: readonly string[] = [
  'contributor',
  'status',
  'published',
  'reviewStatus',
];

export interface EventPackageManifest {
  schemaVersion: typeof EVENT_PACKAGE_SCHEMA_VERSION;
  /** The canonical key that becomes the `event_key_registry` PK on install. */
  eventKey: string;
  title: string;
  description: string;
  version: string;
  /** Optional glob family this key belongs to, e.g. `work-item:done:*`. */
  keyPattern?: string;
  tags?: string[];
}

export interface InstalledEvent {
  installed: true;
  packageRef: string;
  listingRef: string;
  /** Stable, opaque, package-scoped identity — never the registry key. */
  installedId: string;
  /** The key a later `event_key_registry` row is registered under. */
  eventKey: string;
  title: string;
  description: string;
  version: string;
  keyPattern: string | null;
  tags: string[];
  source: string;
  dir: string;
}

export interface EventRoot {
  dir: string;
  layer: 'bundled' | 'user';
}

const inRepoEventsDir = inRepoFallbackDir('events', import.meta.url);

export function userInstalledEventsDir(): string {
  return papercuspPath('events', 'installed');
}

export function installedEventRoots(): EventRoot[] {
  return selfDescribingRoots({
    envVar: 'PAPERCUSP_EVENTS_DIR',
    devFallbackDir: inRepoEventsDir,
    userSubdir: 'events/installed',
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

/** The forbidden-field names actually present in a manifest, in declared order.
 *  Exported so the publish path can refuse with the SAME list the parser uses,
 *  rather than a second copy of the rule that can drift from it. */
export function forbiddenManifestFields(manifest: Record<string, unknown>): string[] {
  return [...DERIVED_ONLY_MANIFEST_FIELDS, ...INSTALL_SITE_ONLY_MANIFEST_FIELDS].filter(
    (field) => manifest[field] !== undefined,
  );
}

/** A stable, opaque, package-scoped identity. Deliberately NOT the event key:
 * two workspaces may install the same definition, and the registry PK is the
 * key, so the install layer needs its own collision-resistant handle. */
export function installedEventId(source: string, listingRef: string): string {
  const digest = createHash('sha256')
    .update(`${source.trim().toLowerCase()}\0${listingRef.trim()}`)
    .digest('hex')
    .slice(0, 16);
  return `installed:${digest}`;
}

/** The on-disk directory name — readable, with the hash supplying collision
 * resistance when long owner/repo/ref combinations are truncated. */
export function installedEventRef(githubUrl: string, listingRef: string): string {
  let repo = 'event';
  try {
    const url = new URL(githubUrl);
    repo = url.pathname.replace(/\.git\/?$/, '').replace(/^\/+|\/+$/g, '') || repo;
  } catch {
    /* fall through to the default stem */
  }
  const stem = `${repo}/${listingRef}`
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const digest = createHash('sha256')
    .update(`${githubUrl.trim().toLowerCase()}\0${listingRef.trim()}`)
    .digest('hex')
    .slice(0, 8);
  return `${stem || 'event'}-${digest}`;
}

/**
 * Parse the two package files with the exact validation used by enumeration and
 * install. Null means the directory is not a usable event package.
 */
export function readEventDir(
  dir: string,
  packageRef: string,
  _layer: 'bundled' | 'user' = 'user',
): InstalledEvent | null {
  const manifest = readJsonObject(join(dir, EVENT_MANIFEST), EVENT_MANIFEST_MAX_BYTES);
  const listing = readJsonObject(join(dir, 'listing.json'), LISTING_MANIFEST_MAX_BYTES);
  if (!manifest || !listing) return null;
  if (listing.kind !== 'event' && listing.listing_kind !== 'event' && listing.scope !== 'event') {
    return null;
  }
  if (manifest.schemaVersion !== EVENT_PACKAGE_SCHEMA_VERSION) return null;

  // D-058: the derived half and the install-site lifecycle are not distributable.
  // Refuse the package outright — see the file header for why a silent drop is
  // the worse failure.
  if (forbiddenManifestFields(manifest).length > 0) return null;

  const eventKey = stringValue(manifest.eventKey, 200);
  // The key IS the registry PK on install, so it must already be canonical —
  // never silently re-normalized here, or the package and the row it seeds would
  // disagree about the event's identity (and every `on`/`await` referencing the
  // published key would resolve to a row filed under a different one).
  if (!eventKey || normalizeEventKey(eventKey) !== eventKey) return null;

  const title = stringValue(manifest.title, 200) ?? stringValue(listing.title, 200);
  const description = stringValue(manifest.description, 2000) ?? stringValue(listing.description, 2000);
  const version = stringValue(manifest.version, 64) ?? stringValue(listing.version, 64);
  const source =
    stringValue(listing.source, 500) ??
    stringValue(listing.github_url, 500) ??
    stringValue(listing.githubUrl, 500);
  const listingRef = stringValue(listing.ref, 200) ?? stringValue(listing.listing_ref, 200) ?? eventKey;
  if (!title || !description || !version || !source) return null;
  if (!PACKAGE_VERSION_RE.test(version)) return null;

  let keyPattern: string | null = null;
  if (manifest.keyPattern !== undefined) {
    keyPattern = stringValue(manifest.keyPattern, 200);
    if (!keyPattern) return null;
  }

  const tags = tagList(manifest.tags);
  if (!tags) return null;

  return {
    installed: true,
    packageRef,
    listingRef,
    // Trust the source-qualified local package ref chosen by the installer, not
    // a publisher-authored `source` string inside listing.json.
    installedId: installedEventId(`package:${packageRef}`, listingRef),
    eventKey,
    title,
    description,
    version,
    keyPattern,
    tags,
    source,
    dir,
  };
}

export function readEventDirForInstall(dir: string, packageRef: string): InstalledEvent | null {
  return readEventDir(dir, packageRef, 'user');
}

export function listInstalledEvents(roots: EventRoot[] = installedEventRoots()): InstalledEvent[] {
  return enumerateSelfDescribingDirs(roots, readEventDir);
}

export function resolveInstalledEvent(
  idOrRef: string,
  roots: EventRoot[] = installedEventRoots(),
): InstalledEvent | null {
  const key = idOrRef.trim();
  if (!key) return null;
  return (
    listInstalledEvents(roots).find(
      (entry) => entry.eventKey === key || entry.packageRef === key || entry.installedId === key,
    ) ?? null
  );
}

export interface WrittenEventPackage {
  ref: string;
  dir: string;
  manifestPath: string;
  listingPath: string;
  manifest: EventPackageManifest;
}

/** The registry-row shape `writeEventPackageDir` exports from. Structurally the
 * CURATED SUBSET of an `event_key_registry` row (D-058), so a publisher hands the
 * row it already has and the derived half is dropped by the TYPE rather than by
 * a hand-written pick that could quietly start including it. */
export interface EventExportSource {
  eventKey: string;
  title?: string | null;
  description?: string | null;
  keyPattern?: string | null;
  tags?: string[] | null;
}

/**
 * Materialize a locally-registered event key as a self-describing package ready
 * to push to a Cupboard mirror. Re-exporting the same key replaces only its
 * export directory; it never writes to the installed layer or the registry.
 */
export function writeEventPackageDir(
  input: EventExportSource,
  opts: {
    ref?: string;
    version?: string;
    description?: string;
    source: string;
    targetDir?: string;
  },
): WrittenEventPackage {
  const eventKey = String(input?.eventKey ?? '').trim();
  if (!eventKey || normalizeEventKey(eventKey) !== eventKey) {
    throw new Error(`invalid event key ${JSON.stringify(eventKey)} — expected a canonical event key`);
  }

  const ref = (opts.ref ?? eventKey).trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  if (!SAFE_REF_RE.test(ref)) throw new Error(`unsafe event ref ${JSON.stringify(ref)}`);
  const version = (opts.version ?? '0.1.0').trim();
  if (!PACKAGE_VERSION_RE.test(version)) throw new Error(`invalid event version ${JSON.stringify(version)}`);
  const source = opts.source.trim();
  if (!source || source.length > 500) {
    throw new Error('event package source is required and must be ≤ 500 characters');
  }

  const description = (opts.description ?? input.description ?? '').trim();
  if (!description) throw new Error('event package description is required');

  const root = opts.targetDir ?? papercuspPath('events', 'exports');
  const dir = join(root, ref);
  mkdirSync(dir, { recursive: true });
  const manifest: EventPackageManifest = {
    schemaVersion: EVENT_PACKAGE_SCHEMA_VERSION,
    eventKey,
    title: (input.title ?? eventKey).trim() || eventKey,
    description,
    version,
    ...(input.keyPattern ? { keyPattern: input.keyPattern } : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
  };
  const manifestPath = join(dir, EVENT_MANIFEST);
  const listingPath = join(dir, 'listing.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(
    listingPath,
    `${JSON.stringify(
      {
        kind: 'event',
        ref,
        eventKey,
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
