/**
 * Detect the harness slug for a papercusp-su shell session.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 1, P-002).
 *
 * Resolution order (D-003):
 *   1. `PAPERCUSP_HARNESS_SLUG` env var (explicit override)
 *   2. Walk cwd upward looking for a `.papercusp/slug` marker file
 *   3. Walk cwd upward for the Papercusp meta-repo marker (a monorepo
 *      root that vendors `libs/papercusp`; package name
 *      papercup|papercusp[-monorepo], npm-scope-tolerant — the "I'm
 *      working on Papercusp itself" case). The slug is the configured
 *      operator-home pointer (`PAPERCUSP_POT_HOME_SLUG`), NOT a baked
 *      literal, so a papercup→papercusp switch is an env change, not a
 *      code edit here.
 *   4. Otherwise return null — memory injection falls back to user
 *      scope only
 *
 * Async variant additionally consults the harness registry (PG /
 * workspace-registry file) for the cwd. Costs one async lookup;
 * caller decides whether to pay for it.
 *
 * Pure-sync helpers are testable without PG/FS mocking beyond
 * `node:fs` itself.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  HOME_HARNESS_ENV,
  LEGACY_DEFAULT_HOME_HARNESS,
} from '../harness/operator-home-harness';

export type DetectSource =
  | 'env'
  | 'marker-file'
  | 'meta-papercup'
  | 'registry'
  | null;

export interface DetectResult {
  slug: string | null;
  source: DetectSource;
}

/**
 * Maximum levels to walk upward from cwd before giving up. Most projects
 * sit ≤ 10 dirs deep from /; 32 is comfortable headroom.
 */
const MAX_WALK_DEPTH = 32;

/**
 * Slug validation — kebab-case, 1+ alnum chars, no slashes / dots /
 * whitespace. Matches the existing harness-slug convention used in
 * harness_<slug> PG schema names.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function validSlug(s: string | null | undefined): s is string {
  return !!s && SLUG_RE.test(s);
}

function readSlugMarker(dir: string): string | null {
  const markerPath = path.join(dir, '.papercusp', 'slug');
  try {
    const raw = fs.readFileSync(markerPath, 'utf8').trim();
    return validSlug(raw) ? raw : null;
  } catch {
    return null;
  }
}

function looksLikePapercupRepo(dir: string): boolean {
  // Recognize the Papercusp dogfood monorepo root: a package.json whose
  // (npm-scope-stripped) name is papercup|papercusp, optionally
  // `-monorepo`, PLUS a vendored `libs/papercusp` submodule. The name is
  // matched tolerantly (anchored) so the papercup→papercusp rename — and
  // the scoped `@papercupai/papercusp-monorepo` package name — need no edit
  // here, while a foreign repo that merely contains `papercup` in its name
  // (e.g. "not-papercup") is still rejected. The libs/papercusp check keeps
  // false-positives ~zero. Detection ONLY — the returned slug is the
  // configured home pointer (see step 3 below), never a baked literal.
  const pkgPath = path.join(dir, 'package.json');
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { name?: string };
    const bareName = (pkg?.name ?? '').replace(/^@[^/]+\//, ''); // strip npm scope
    if (!/^papercu(p|sp)(-monorepo)?$/.test(bareName)) return false;
  } catch {
    return false;
  }
  try {
    return fs.statSync(path.join(dir, 'libs', 'papercusp')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk `cwd` upward (inclusive). Returns each directory until either
 * the filesystem root or MAX_WALK_DEPTH ancestors are exhausted.
 *
 * Optional `boundary`: a directory the walk will not ascend ABOVE. The
 * boundary dir itself is yielded, then iteration stops — so detection is
 * confined to the `boundary` subtree. Omitted ⇒ walk to the filesystem
 * root, the normal su-shell behavior. (If `cwd` is not within `boundary`
 * the boundary is simply never hit, so the walk falls back to unbounded —
 * a missing/mismatched boundary can never make the walk MORE eager.)
 */
function* walkUp(cwd: string, boundary?: string): Generator<string> {
  let cur = path.resolve(cwd);
  const stopAt = boundary ? path.resolve(boundary) : null;
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    yield cur;
    if (stopAt && cur === stopAt) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

/**
 * Synchronous detection — env var + marker file + meta-papercup check.
 *
 * Never throws; returns `{ slug: null, source: null }` if nothing
 * matches. Safe in any context.
 */
export function detectHarnessSlugSync(opts: {
  cwd: string;
  // Only `PAPERCUSP_HARNESS_SLUG` is read — a plain env record (not the
  // full `NodeJS.ProcessEnv`, which requires `NODE_ENV`) so callers/tests
  // can pass a partial `{ PAPERCUSP_HARNESS_SLUG }` map.
  env?: Record<string, string | undefined>;
  // Optional upper bound for the cwd walk: detection will not ascend above
  // this directory (see walkUp). The su shell omits it (walk to `/`); tests
  // pass their isolated temp root so the walk can't escape into whatever
  // repo the temp dir happens to live under (e.g. vitest's project-local
  // TMPDIR=.vitest-tmp inside this monorepo — EI-5541).
  boundary?: string;
}): DetectResult {
  const env = opts.env ?? process.env;

  // 1. Env override (highest precedence — explicit user/installer intent)
  const envSlug = env.PAPERCUSP_HARNESS_SLUG?.trim();
  if (validSlug(envSlug)) {
    return { slug: envSlug, source: 'env' };
  }

  // 2. Walk for .papercusp/slug marker
  for (const dir of walkUp(opts.cwd, opts.boundary)) {
    const marker = readSlugMarker(dir);
    if (marker) return { slug: marker, source: 'marker-file' };
  }

  // 3. Walk for the Papercusp meta-repo. The slug is the configured
  //    operator-home pointer (PAPERCUSP_POT_HOME_SLUG, read from the same
  //    `env` resolved above), NOT a baked literal — papercup→papercusp is
  //    an env switch, not a code change. Falls back to the legacy default
  //    only when the pointer is unset (pre-pointer installs).
  for (const dir of walkUp(opts.cwd, opts.boundary)) {
    if (looksLikePapercupRepo(dir)) {
      const home = env[HOME_HARNESS_ENV]?.trim();
      return {
        slug: home && home.length > 0 ? home : LEGACY_DEFAULT_HOME_HARNESS,
        source: 'meta-papercup',
      };
    }
  }

  return { slug: null, source: null };
}

/**
 * Async detection — same as sync, but also consults the harness
 * registry as a final fallback. Pass `registryLookup` to consult PG /
 * the workspace registry file; if omitted, behaves like the sync
 * variant.
 *
 * The registryLookup callback shape lets callers wire either the
 * synchronous workspace-registry file reader OR the async PG query
 * without this module depending on either.
 */
export async function detectHarnessSlug(opts: {
  cwd: string;
  // Plain env record (not full NodeJS.ProcessEnv) — see detectHarnessSlugSync.
  env?: Record<string, string | undefined>;
  // Optional upper bound for the cwd walk — see detectHarnessSlugSync.
  boundary?: string;
  registryLookup?: (cwd: string) => Promise<string | null>;
}): Promise<DetectResult> {
  const sync = detectHarnessSlugSync(opts);
  if (sync.slug) return sync;

  if (opts.registryLookup) {
    try {
      const fromRegistry = await opts.registryLookup(opts.cwd);
      if (validSlug(fromRegistry)) {
        return { slug: fromRegistry, source: 'registry' };
      }
    } catch {
      // registry lookup failed — fall through to null
    }
  }

  return { slug: null, source: null };
}

export const _testing = {
  validSlug,
  readSlugMarker,
  looksLikePapercupRepo,
  walkUp,
  MAX_WALK_DEPTH,
};
