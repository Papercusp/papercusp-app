/**
 * pot-git/scope-repo.ts — per-scope bare-repo provisioning (FS-D3, ratified
 * D-017; p2p-work-distribution-2026-07-02 P-006 §6 / P-108 option (b)).
 *
 * A FederationScope's git-plane unit is its OWN bare repo under the pot-git
 * root — NOT ref-filtering inside the hive repo. Rationale (D-017/D-018): git's
 * transport then structurally cannot leak sibling scopes' refs (upload-pack
 * inside one repo advertises only that repo), M14/H16 hold by construction,
 * the foreign/canonical boundary is provenance (a different repo) rather than
 * path parsing, and scope repos are independently GC-able/deletable on fleet
 * archive (H10) so rejected or expired foreign work never permanently bloats
 * the hive repo (X4).
 *
 * SCOPE ID (FS-D2): the canonical scope id is `fleet:<numeric-gh-user-id>/<slug>`
 * — grantor keyed by NUMERIC GitHub user id (X9: logins are mutable+reusable),
 * slug owner-prefixed (H5). Because the id contains `:` and `/` it is neither a
 * safe single path component nor a legal single git-ref segment, so this module
 * owns BOTH encodings (the one place the mapping lives, mirroring
 * `deviceNamespaceKey` discipline):
 *
 *   - PATH:  <potGitRoot>/<potHomeSlug>/scopes/fleet-<uid>/<slug>.git
 *   - REF:   a single segment `fleet-<uid>--<slug>` for the foreign-marked
 *            tracking family `refs/foreign/<segment>/…` — preserving the landed
 *            `isForeignMarkedRef` contract (foreign-merge-admission.ts), whose
 *            parser requires exactly one `[^/]+` segment after `refs/foreign/`.
 *
 * Serving a scope repo stays inside `potGitRoot()`, so fetch-transport's
 * `assertServeableRepo` backstop already covers it; the ROSTER serve-gate
 * (design §5.3/§6 — refuse a non-member's fetch with a P-004 receipt) wires in
 * the announce/disclosure stage (5.2) and consumes `parseScopeId` from here.
 *
 * Pure over storage.ts's RunGit seam; unit-tests without git, integration-tests
 * against a real temp bare repo (the storage.ts pattern).
 */

import { isAbsolute, join, relative, sep } from 'node:path';
import { mkdir, access } from 'node:fs/promises';
import { type RunGit, defaultRunGit, potGitRoot } from './storage';

/** A parsed FederationScope id (FS-D2). */
export interface ScopeId {
  kind: 'fleet';
  /** Grantor/owner GitHub NUMERIC user id (X9 — never a login). */
  ownerGithubUserId: number;
  /** Fleet slug (H5 owner-prefixed namespace; `^[a-z0-9][a-z0-9-]*$`). */
  slug: string;
}

/** Canonical wire form: `fleet:<uid>/<slug>`. */
export function formatScopeId(s: ScopeId): string {
  return `fleet:${s.ownerGithubUserId}/${s.slug}`;
}

const SCOPE_ID_RE = /^fleet:([1-9][0-9]{0,18})\/([a-z0-9][a-z0-9-]*)$/;
const SLUG_MAX = 100;

/**
 * Parse + validate a canonical scope id. Returns null on ANY malformation —
 * callers on enforcement paths must treat null as a refusal, never a fallback
 * (fail-closed; D-004 no-silent-drops: the refusal is the caller's receipt).
 */
export function parseScopeId(scopeId: string): ScopeId | null {
  if (typeof scopeId !== 'string' || scopeId.length > 32 + SLUG_MAX) return null;
  const m = SCOPE_ID_RE.exec(scopeId);
  if (!m) return null;
  const uid = Number(m[1]);
  if (!Number.isSafeInteger(uid) || uid <= 0) return null;
  if (m[2].length > SLUG_MAX) return null;
  return { kind: 'fleet', ownerGithubUserId: uid, slug: m[2] };
}

/**
 * The single git-ref-safe segment for a scope — used by the foreign-marked
 * tracking family. `fleet-<uid>--<slug>`: no `:`/`/`, unambiguous (the `--`
 * separator cannot appear in `<uid>` and the slug charset has no `--`-free
 * guarantee, so we parse from the LEFT: `fleet-` + digits + first `--`).
 */
export function scopeRefSegment(scope: ScopeId): string {
  return `fleet-${scope.ownerGithubUserId}--${scope.slug}`;
}

const SEGMENT_RE = /^fleet-([1-9][0-9]{0,18})--([a-z0-9][a-z0-9-]*)$/;

/** Round-trip a `scopeRefSegment` back to a ScopeId (null = not a scope segment). */
export function parseScopeRefSegment(segment: string): ScopeId | null {
  const m = SEGMENT_RE.exec(segment);
  if (!m) return null;
  const uid = Number(m[1]);
  if (!Number.isSafeInteger(uid) || uid <= 0) return null;
  return { kind: 'fleet', ownerGithubUserId: uid, slug: m[2] };
}

/**
 * WI-3641: the wire `repoKey` a pot-git-serve requester sends
 * (serve-wiring.ts's `ReqFrame.repoKey`) to fetch a `scopes/` repo. The wire
 * transport's `repoKey` is a single hiveGitRepoPath-style path component (no
 * `/`, storage.ts's `assertSafeComponent`) — reusing `scopeRefSegment`'s
 * `fleet-<uid>--<slug>` encoding directly would collide with (and be
 * indistinguishable from) a plain managed-repo key of that literal name, so
 * this prefixes it `scope:` (a `:` is a legal component char, and no
 * managed-repo key is ever minted with one) to make scope-family requests
 * self-describing on the wire. `parseScopeRepoWireKey` is the inverse; a
 * non-`scope:`-prefixed repoKey is a normal (non-scope) repo request.
 */
export function scopeRepoWireKey(scope: ScopeId): string {
  return `scope:${scopeRefSegment(scope)}`;
}

/** Inverse of {@link scopeRepoWireKey}. Null when `repoKey` isn't a
 *  scope-family wire key at all (caller falls back to the plain repoKey path)
 *  OR carries a malformed scope segment (caller must refuse, never guess). */
export function parseScopeRepoWireKey(repoKey: string): ScopeId | null {
  if (!repoKey.startsWith('scope:')) return null;
  return parseScopeRefSegment(repoKey.slice('scope:'.length));
}

/**
 * The foreign-marked tracking ref for a scope deliverable:
 * `refs/foreign/<segment>/<name>` — one segment after `refs/foreign/`, so the
 * landed `isForeignMarkedRef` / `foreignFleetFromRef` contract holds verbatim.
 */
export function scopeForeignRef(scope: ScopeId, name: string): string {
  if (!name || name.startsWith('/') || name.includes('..') || name.includes('\0')) {
    throw new Error(`scope-repo: unsafe foreign ref name: ${JSON.stringify(name)}`);
  }
  return `refs/foreign/${scopeRefSegment(scope)}/${name}`;
}

function assertSafeComponent(v: string, what: string): void {
  if (!v || v.includes('/') || v.includes('\\') || v.includes('..') || v.includes('\0')) {
    throw new Error(`scope-repo: unsafe ${what} path component: ${JSON.stringify(v)}`);
  }
}

/**
 * The bare-repo path for (hive home slug, scope). Lives under `potGitRoot()`
 * so the fetch-transport serve backstop covers it:
 * `<root>/<hive>/scopes/fleet-<uid>/<slug>.git`.
 */
export function scopeRepoPath(potHomeSlug: string, scope: ScopeId): string {
  assertSafeComponent(potHomeSlug, 'potHomeSlug');
  // Components are structurally safe by the ScopeId parse, but re-assert —
  // defense in depth against a hand-built ScopeId.
  const owner = `fleet-${scope.ownerGithubUserId}`;
  assertSafeComponent(owner, 'scope owner');
  assertSafeComponent(scope.slug, 'scope slug');
  return join(potGitRoot(), potHomeSlug, 'scopes', owner, `${scope.slug}.git`);
}

/** `repoPath` relative to `potGitRoot()` as clean components, or null when the
 *  path escapes the root (the family checks below are prefix-anchored). */
function rootRelativeComponents(repoPath: string): string[] | null {
  const rel = relative(potGitRoot(), repoPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep);
}

/**
 * True when `repoPath` sits anywhere inside a `scopes/` family under
 * `potGitRoot()` (`<root>/<hive>/scopes/...`) — the GATE TRIGGER for scope-repo
 * serving. Deliberately BROADER than {@link parseScopeRepoPath}: a malformed
 * path inside the family must still trip the serve gate (and then can never be
 * granted, because the strict parse fails) — fail-closed, never dodged by
 * malformation.
 */
export function isScopeRepoFamilyPath(repoPath: string): boolean {
  const parts = rootRelativeComponents(repoPath);
  return parts !== null && parts.length >= 2 && parts[1] === 'scopes';
}

const OWNER_DIR_RE = /^fleet-([1-9][0-9]{0,18})$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Strict inverse of {@link scopeRepoPath}: parse
 * `<root>/<hive>/scopes/fleet-<uid>/<slug>.git` back to its hive home slug +
 * ScopeId. Returns null on ANY malformation — enforcement callers (the §5.3
 * serve gate) must treat null as a refusal, never a fallback.
 */
export function parseScopeRepoPath(
  repoPath: string,
): { potHomeSlug: string; scope: ScopeId } | null {
  const parts = rootRelativeComponents(repoPath);
  if (!parts || parts.length !== 4 || parts[1] !== 'scopes') return null;
  const [potHomeSlug, , ownerDir, repoFile] = parts;
  if (!potHomeSlug || potHomeSlug.includes('..') || potHomeSlug.includes('\0')) return null;
  const m = OWNER_DIR_RE.exec(ownerDir);
  if (!m) return null;
  const uid = Number(m[1]);
  if (!Number.isSafeInteger(uid) || uid <= 0) return null;
  if (!repoFile.endsWith('.git')) return null;
  const slug = repoFile.slice(0, -'.git'.length);
  if (!slug || slug.length > SLUG_MAX || !SLUG_RE.test(slug)) return null;
  return { potHomeSlug, scope: { kind: 'fleet', ownerGithubUserId: uid, slug } };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the scope's bare repo exists (`git init --bare -q` when absent).
 * Idempotent, storage.ts `ensurePotGitRepo` semantics. Throws only on a
 * genuine init failure (disk/permissions).
 */
export async function ensureScopeRepo(
  potHomeSlug: string,
  scope: ScopeId,
  runGit: RunGit = defaultRunGit,
): Promise<string> {
  const repoPath = scopeRepoPath(potHomeSlug, scope);
  if (await pathExists(join(repoPath, 'HEAD'))) return repoPath;
  await mkdir(repoPath, { recursive: true });
  const r = await runGit(['init', '--bare', '-q', repoPath], potGitRoot());
  if (r.code !== 0) {
    throw new Error(`scope-repo: init --bare failed for ${repoPath}: ${r.stderr.trim()}`);
  }
  return repoPath;
}
