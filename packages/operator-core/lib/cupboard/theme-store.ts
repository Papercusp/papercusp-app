/**
 * Local installed-theme store — the data layer behind Cupboard `kind='theme'`.
 *
 * A theme is an inert, self-describing directory:
 *
 *   <install-ref>/theme.json   — versioned semantic-token manifest
 *   <install-ref>/listing.json — ordinary Cupboard/storefront metadata
 *
 * Built-ins remain generated CSS and locally-authored themes remain in
 * themes/custom.json. This reader composes neither one: it exposes the installed
 * layer so custom-themes.ts can combine the three origins in one catalog.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '../papercusp-root';
import {
  DEFAULT_THEME_ID,
  THEME_TOKENS,
  isBuiltinThemeId,
  isSafeCssValue,
  isThemeToken,
  slugifyThemeId,
  validateCustomTheme,
  type BuiltinThemeId,
  type CustomTheme,
  type ThemeColorScheme,
  type ThemeToken,
} from '../theme-tokens';
import {
  enumerateSelfDescribingDirs,
  inRepoFallbackDir,
  selfDescribingRoots,
} from './self-describing-store';

export const THEME_MANIFEST = 'theme.json';
export const THEME_PACKAGE_SCHEMA_VERSION = 1 as const;
const THEME_MANIFEST_MAX_BYTES = 64 * 1024;
const LISTING_MANIFEST_MAX_BYTES = 32 * 1024;
const PACKAGE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const INTERNAL_THEME_ID_RE = /^installed:[0-9a-f]{16}$/;
const SEMANTIC_VAR_RE = /var\(\s*--([a-z0-9-]+)(?:\s*,[^)]*)?\)/gi;

export interface ThemePackageManifest {
  schemaVersion: typeof THEME_PACKAGE_SCHEMA_VERSION;
  id: string;
  label: string;
  description: string;
  version: string;
  baseTheme: BuiltinThemeId;
  colorScheme: ThemeColorScheme;
  tokens: Partial<Record<ThemeToken, string>>;
}

export interface InstalledTheme extends CustomTheme {
  installed: true;
  packageRef: string;
  listingRef: string;
  baseTheme: BuiltinThemeId;
  colorScheme: ThemeColorScheme;
  version: string;
  source: string;
  description: string;
  dir: string;
}

export interface ThemeRoot {
  dir: string;
  layer: 'bundled' | 'user';
}

const inRepoThemesDir = inRepoFallbackDir('themes', import.meta.url);

export function userInstalledThemesDir(): string {
  return papercuspPath('themes', 'installed');
}

export function installedThemeRoots(): ThemeRoot[] {
  return selfDescribingRoots({
    envVar: 'PAPERCUSP_THEMES_DIR',
    devFallbackDir: inRepoThemesDir,
    userSubdir: 'themes/installed',
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

/** A stable, opaque id that a local editor can never produce: its validator
 * slugifies punctuation, while installed ids deliberately retain the colon. */
export function installedThemeId(source: string, listingRef: string): string {
  const digest = createHash('sha256')
    .update(`${source.trim().toLowerCase()}\0${listingRef.trim()}`)
    .digest('hex')
    .slice(0, 16);
  return `installed:${digest}`;
}

/** The on-disk directory name. It remains readable while the hash supplies the
 * collision resistance when long owner/repo/ref combinations are truncated. */
export function installedThemeRef(githubUrl: string, listingRef: string): string {
  let repo = 'theme';
  try {
    const url = new URL(githubUrl);
    repo = url.pathname.replace(/\.git\/?$/, '').replace(/^\/+|\/+$/g, '') || repo;
  } catch {
    // The common installer rejects invalid GitHub URLs before this is used. Keep
    // this helper total for callers/tests that only need deterministic naming.
  }
  const readable = slugifyThemeId(`${repo}-${listingRef}`).slice(0, 40);
  const hash = createHash('sha256')
    .update(`${githubUrl.trim().toLowerCase()}\0${listingRef.trim()}`)
    .digest('hex')
    .slice(0, 12);
  return `${readable}-${hash}`;
}

function hasOnlySemanticReferences(value: string): boolean {
  SEMANTIC_VAR_RE.lastIndex = 0;
  for (let match = SEMANTIC_VAR_RE.exec(value); match; match = SEMANTIC_VAR_RE.exec(value)) {
    if (!isThemeToken(match[1])) return false;
  }
  return true;
}

function readTokens(value: unknown): Partial<Record<ThemeToken, string>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > THEME_TOKENS.length) return null;
  const tokens: Partial<Record<ThemeToken, string>> = {};
  for (const [key, raw] of entries) {
    if (!isThemeToken(key) || !isSafeCssValue(raw)) return null;
    const tokenValue = (raw as string).trim();
    if (!hasOnlySemanticReferences(tokenValue)) return null;
    tokens[key] = tokenValue;
  }
  return tokens;
}

function defaultColorScheme(baseTheme: BuiltinThemeId): ThemeColorScheme {
  return baseTheme === 'portal-light' ? 'light' : 'dark';
}

/** Parse the two package files with the exact validation used by enumeration and
 * install. Null means the directory is not a usable theme package. */
export function readThemeDir(
  dir: string,
  packageRef: string,
  _layer: 'bundled' | 'user' = 'user',
): InstalledTheme | null {
  const manifest = readJsonObject(join(dir, THEME_MANIFEST), THEME_MANIFEST_MAX_BYTES);
  const listing = readJsonObject(join(dir, 'listing.json'), LISTING_MANIFEST_MAX_BYTES);
  if (!manifest || !listing) return null;
  if (listing.kind !== 'theme' && listing.listing_kind !== 'theme' && listing.scope !== 'theme') return null;
  if (manifest.schemaVersion !== THEME_PACKAGE_SCHEMA_VERSION) return null;

  const authorId = stringValue(manifest.id, 80);
  const label = stringValue(manifest.label, 60) ?? stringValue(listing.title, 60);
  const version = stringValue(manifest.version, 64) ?? stringValue(listing.version, 64);
  const source =
    stringValue(listing.source, 500) ??
    stringValue(listing.github_url, 500) ??
    stringValue(listing.githubUrl, 500);
  const listingRef =
    stringValue(listing.ref, 200) ??
    stringValue(listing.listing_ref, 200) ??
    authorId;
  if (!authorId || slugifyThemeId(authorId) !== authorId || !label || !version || !source || !listingRef) return null;
  if (!PACKAGE_VERSION_RE.test(version)) return null;

  const baseTheme = manifest.baseTheme === undefined ? DEFAULT_THEME_ID : manifest.baseTheme;
  if (!isBuiltinThemeId(baseTheme)) return null;
  const colorScheme = manifest.colorScheme ?? defaultColorScheme(baseTheme);
  if (colorScheme !== 'light' && colorScheme !== 'dark') return null;
  const tokens = readTokens(manifest.tokens);
  if (!tokens) return null;

  // Trust the source-qualified local package ref chosen by the installer, not a
  // publisher-authored `source` string inside listing.json.
  const id = installedThemeId(`package:${packageRef}`, listingRef);
  if (!INTERNAL_THEME_ID_RE.test(id)) return null;
  try {
    // Reuse the local validator as the final semantic-token and CSS-safety gate.
    validateCustomTheme({ id: authorId, label, tokens });
  } catch {
    return null;
  }

  return {
    id,
    label,
    tokens,
    installed: true,
    packageRef,
    listingRef,
    baseTheme,
    colorScheme,
    version,
    source,
    description: stringValue(manifest.description, 1000) ?? stringValue(listing.description, 1000) ?? '',
    dir,
  };
}

export function readThemeDirForInstall(dir: string, packageRef: string): InstalledTheme | null {
  return readThemeDir(dir, packageRef, 'user');
}

export function listInstalledThemes(roots: ThemeRoot[] = installedThemeRoots()): InstalledTheme[] {
  return enumerateSelfDescribingDirs(roots, readThemeDir);
}

export function resolveInstalledTheme(
  idOrRef: string,
  roots: ThemeRoot[] = installedThemeRoots(),
): InstalledTheme | null {
  const key = idOrRef.trim();
  if (!key) return null;
  return listInstalledThemes(roots).find((theme) => theme.id === key || theme.packageRef === key) ?? null;
}

const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

export interface WrittenThemePackage {
  ref: string;
  dir: string;
  manifestPath: string;
  listingPath: string;
  manifest: ThemePackageManifest;
}

/** Materialize a locally-authored theme as a self-describing package ready to
 * push to a Cupboard mirror. Re-exporting the same local theme replaces only its
 * export directory; it never writes to the installed or custom-theme layers. */
export function writeThemePackageDir(
  input: unknown,
  opts: {
    ref?: string;
    version?: string;
    baseTheme?: BuiltinThemeId;
    colorScheme?: ThemeColorScheme;
    description?: string;
    source: string;
    targetDir?: string;
  },
): WrittenThemePackage {
  const theme = validateCustomTheme(input);
  const ref = (opts.ref ?? theme.id).trim();
  if (!SAFE_REF_RE.test(ref)) throw new Error(`unsafe theme ref ${JSON.stringify(ref)}`);
  const version = (opts.version ?? '0.1.0').trim();
  if (!PACKAGE_VERSION_RE.test(version)) throw new Error(`invalid theme version ${JSON.stringify(version)}`);
  const baseTheme = opts.baseTheme ?? DEFAULT_THEME_ID;
  if (!isBuiltinThemeId(baseTheme)) throw new Error(`invalid base theme ${JSON.stringify(baseTheme)}`);
  const colorScheme = opts.colorScheme ?? defaultColorScheme(baseTheme);
  const source = opts.source.trim();
  if (!source || source.length > 500) throw new Error('theme package source is required and must be ≤ 500 characters');

  const root = opts.targetDir ?? papercuspPath('themes', 'exports');
  const dir = join(root, ref);
  mkdirSync(dir, { recursive: true });
  const manifest: ThemePackageManifest = {
    schemaVersion: THEME_PACKAGE_SCHEMA_VERSION,
    id: theme.id,
    label: theme.label,
    description: opts.description?.trim() ?? '',
    version,
    baseTheme,
    colorScheme,
    tokens: theme.tokens,
  };
  const manifestPath = join(dir, THEME_MANIFEST);
  const listingPath = join(dir, 'listing.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(listingPath, `${JSON.stringify({
    kind: 'theme', ref, id: theme.id, title: theme.label,
    description: manifest.description, version, source,
  }, null, 2)}\n`, 'utf8');
  return { ref, dir, manifestPath, listingPath, manifest };
}
