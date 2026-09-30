/**
 * binding-service — embedded P-068 runtime implementation of the
 * canonical shared-repo binding service per
 * `dogfood-design-memo-binding-service-api-2026-05-24.md` (status:
 * accepted 2026-05-24).
 *
 * Consumes the types-only spine:
 *   - lib/harness/binding-types — wire shapes + 9-variant error union
 *   - lib/identity/octokit-client — gh-token-backed Octokit wrapper
 *   - harness_shared.shared_repo_binding_cache — PG mirror (P-013a)
 *
 * Two deployments share this surface (memo D-A):
 *   - Embedded: this module (Phase 1b P-068)
 *   - Cupboard server: apps/operator-public/lib/binding-service.ts (Phase 9 P-051a)
 *
 * Errors throw `BindingServiceErrorThrowable` instances; callers
 * catch + branch on `.error.code` per the typed error union.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { getOctokit } from '../identity/octokit-client';
import {
  CLAIM_REQUIRED_PERMISSION,
  SUPERSEDE_REQUIRED_PERMISSION,
  composeBindingId,
  hasRequiredPermission,
  parseBindingId,
  type BindingPrivacy,
  type BindingRecord,
  type BindingServiceError,
  type GithubRepoPermission,
} from './binding-types';

/**
 * Throwable wrapper around the typed error union. Lets callers do
 * `try { ... } catch (e) { if (e instanceof BindingServiceErrorThrowable) { switch (e.error.code) {...} } }`.
 */
// Re-export so existing callers (`import { BindingServiceErrorThrowable }
// from '.../binding-service'`) keep compiling; canonical location is
// now `binding-types.ts` so UI / client code can import the throwable
// without pulling in server-only imports.
export { BindingServiceErrorThrowable } from './binding-types';
import { BindingServiceErrorThrowable as _BindingServiceErrorThrowable } from './binding-types';

const fail = (err: BindingServiceError): never => {
  throw new _BindingServiceErrorThrowable(err);
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h per memo §"resolve cached"

// ── PG row → BindingRecord ──────────────────────────────────────

export type SrbcRow = {
  workspace_id: string;
  provider: 'github';
  github_repository_id: number;
  github_full_name: string;
  harness_topic: string;
  harness_slug: string;
  harness_link: string;
  privacy: BindingPrivacy;
  claim_status: BindingRecord['claim_status'];
  provisional_owner_github_user_id: number;
  provisional_owner_github_login: string;
  claimed_by_github_user_ids: number[];
  // getOrgPg (postgres-js 3.4.9) returns timestamptz columns as Postgres-text
  // STRINGS ("2026-06-02 08:12:44.631-04"), not Date — so these are `Date |
  // string` in practice. rowToBinding normalizes via `toIso`.
  created_at: Date | string;
  claimed_at: Date | string | null;
  last_permission_verified_at: Date | string | null;
  superseded_by_harness_topic: string | null;
  cached_at: Date | string;
};

/**
 * Normalize a timestamp column to an ISO-8601 string. getOrgPg yields
 * Postgres-text strings for timestamptz (not Date); `new Date(x)` parses that
 * format, an ISO string, an existing Date, and an epoch number alike.
 */
function toIso(v: Date | string | number): string {
  // getOrgPg never returns null for a NOT NULL timestamptz; a null here means
  // real corruption — surface it loudly rather than silently emitting the
  // 1970 epoch that `new Date(null)` produces. (Nullable columns are guarded by
  // the caller's `if (r.<col>)` before reaching toIso.)
  if (v == null) {
    throw new Error('toIso: null/undefined timestamp (NOT NULL column violated)');
  }
  return new Date(v).toISOString();
}

export function rowToBinding(r: SrbcRow): BindingRecord {
  const out: BindingRecord = {
    provider: r.provider,
    github_repository_id: Number(r.github_repository_id),
    github_full_name: r.github_full_name,
    harness_topic: r.harness_topic,
    harness_slug: r.harness_slug,
    harness_link: r.harness_link,
    privacy: r.privacy,
    claim_status: r.claim_status,
    provisional_owner_github_user_id: Number(r.provisional_owner_github_user_id),
    provisional_owner_github_login: r.provisional_owner_github_login ?? '',
    claimed_by_github_user_ids: (r.claimed_by_github_user_ids ?? []).map(Number),
    created_at: toIso(r.created_at),
  };
  if (r.claimed_at) out.claimed_at = toIso(r.claimed_at);
  if (r.last_permission_verified_at) {
    out.last_permission_verified_at = toIso(r.last_permission_verified_at);
  }
  if (r.superseded_by_harness_topic) {
    out.superseded_by_harness_topic = r.superseded_by_harness_topic;
  }
  return out;
}

// ── URL parsing ─────────────────────────────────────────────────

/**
 * Parse a GitHub URL → `{owner, repo}`. Accepts:
 *   https://github.com/<owner>/<repo>
 *   https://github.com/<owner>/<repo>.git
 *   git@github.com:<owner>/<repo>.git
 * Returns null for any other shape (caller maps null → 400, not to a
 * typed error variant).
 */
export function parseGithubRepoUrl(
  url: string,
): { owner: string; repo: string } | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  const trimmed = url.trim();
  const httpsMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/,
  );
  if (httpsMatch) return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1]!, repo: sshMatch[2]! };
  return null;
}

// ── GitHub calls ────────────────────────────────────────────────

/**
 * Resolve owner/repo to GitHub's numeric repo id + canonical full_name.
 * Maps GitHub error codes to the typed BindingServiceError variants.
 */
async function resolveGithubRepoNumericId(
  owner: string,
  repo: string,
): Promise<{ id: number; full_name: string; private: boolean }> {
  const oc = await getOctokit();
  if (!oc) {
    fail({ code: 'GITHUB_API_DOWN', message: 'gh-token not authenticated' });
  }
  try {
    const { data } = await oc!.repos.get({ owner, repo });
    return { id: data.id, full_name: data.full_name, private: data.private };
  } catch (e: unknown) {
    const status = (e as { status?: number })?.status;
    if (status === 404) fail({ code: 'GITHUB_REPO_NOT_FOUND' });
    if (status === 403) {
      const remaining = (e as { response?: { headers?: Record<string, string> } })?.response
        ?.headers?.['x-ratelimit-remaining'];
      if (remaining === '0') {
        const reset = Number((e as { response?: { headers?: Record<string, string> } })?.response
          ?.headers?.['x-ratelimit-reset'] ?? '0');
        const nowSec = Math.floor(Date.now() / 1000);
        const retry_after_ms = Math.max(0, (reset - nowSec) * 1000);
        fail({ code: 'GITHUB_API_RATE_LIMIT', retry_after_ms });
      }
      fail({ code: 'GITHUB_REPO_PRIVATE_NO_ACCESS' });
    }
    fail({ code: 'GITHUB_API_DOWN', message: String((e as Error)?.message ?? e) });
  }
  // Unreachable — fail() throws.
  throw new Error('unreachable');
}

/**
 * Get the acting user's `(login, id)`. Throws GITHUB_API_DOWN on
 * failure; called by claim/supersede paths.
 */
async function getAuthenticatedUser(): Promise<{ login: string; id: number }> {
  const oc = await getOctokit();
  if (!oc) {
    fail({ code: 'GITHUB_API_DOWN', message: 'gh-token not authenticated' });
  }
  try {
    const { data } = await oc!.users.getAuthenticated();
    return { login: data.login, id: data.id };
  } catch (e: unknown) {
    fail({ code: 'GITHUB_API_DOWN', message: String((e as Error)?.message ?? e) });
    throw new Error('unreachable');
  }
}

/**
 * Get the acting user's permission level on `owner/repo`. Maps
 * GitHub's `RepositoryPermissionResponse.permission` to our
 * `GithubRepoPermission` enum. 404 → 'none'. Throws a BindingServiceError
 * (GITHUB_API_DOWN / GITHUB_API_RATE_LIMIT) when GitHub is unreachable —
 * callers that gate on it (the B11 hive-tier resolver) must fail CLOSED.
 * Exported for reuse by the hive role-tier resolver (member-tier-gate.ts).
 */
export async function getRepoPermission(
  owner: string,
  repo: string,
  username: string,
): Promise<GithubRepoPermission> {
  const oc = await getOctokit();
  if (!oc) {
    fail({ code: 'GITHUB_API_DOWN', message: 'gh-token not authenticated' });
  }
  try {
    const { data } = await oc!.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });
    const perm = data.permission;
    if (perm === 'admin' || perm === 'maintain' || perm === 'write' || perm === 'triage' || perm === 'read') {
      return perm;
    }
    return 'none';
  } catch (e: unknown) {
    const status = (e as { status?: number })?.status;
    if (status === 404) return 'none';
    fail({ code: 'GITHUB_API_DOWN', message: String((e as Error)?.message ?? e) });
    throw new Error('unreachable');
  }
}

// ── Cache lookup + write ────────────────────────────────────────

async function readCachedByRepoId(
  workspaceId: string,
  repositoryId: number,
): Promise<BindingRecord | null> {
  // The shared_repo_binding_cache table is created by migrations (000-baseline);
  // no runtime ensure needed.
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT * FROM harness_shared.shared_repo_binding_cache
    WHERE workspace_id = ${workspaceId}
      AND provider = 'github'
      AND github_repository_id = ${repositoryId}
    LIMIT 1
  `) as unknown as SrbcRow[];
  if (rows.length === 0) return null;
  return rowToBinding(rows[0]!);
}

async function upsertCacheRow(
  workspaceId: string,
  rec: BindingRecord,
): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.shared_repo_binding_cache
      (workspace_id, provider, github_repository_id, github_full_name,
       harness_topic, harness_slug, harness_link, privacy, claim_status,
       provisional_owner_github_user_id, provisional_owner_github_login,
       claimed_by_github_user_ids,
       created_at, claimed_at, last_permission_verified_at,
       superseded_by_harness_topic, cached_at)
    VALUES
      (${workspaceId}, ${rec.provider}, ${rec.github_repository_id}, ${rec.github_full_name},
       ${rec.harness_topic}, ${rec.harness_slug}, ${rec.harness_link}, ${rec.privacy}, ${rec.claim_status},
       ${rec.provisional_owner_github_user_id}, ${rec.provisional_owner_github_login},
       ${rec.claimed_by_github_user_ids as unknown as string},
       ${rec.created_at}, ${rec.claimed_at ?? null}, ${rec.last_permission_verified_at ?? null},
       ${rec.superseded_by_harness_topic ?? null}, now())
    ON CONFLICT (workspace_id, provider, github_repository_id) DO UPDATE SET
      github_full_name = EXCLUDED.github_full_name,
      harness_topic = EXCLUDED.harness_topic,
      harness_slug = EXCLUDED.harness_slug,
      harness_link = EXCLUDED.harness_link,
      privacy = EXCLUDED.privacy,
      claim_status = EXCLUDED.claim_status,
      provisional_owner_github_user_id = EXCLUDED.provisional_owner_github_user_id,
      provisional_owner_github_login = EXCLUDED.provisional_owner_github_login,
      claimed_by_github_user_ids = EXCLUDED.claimed_by_github_user_ids,
      claimed_at = EXCLUDED.claimed_at,
      last_permission_verified_at = EXCLUDED.last_permission_verified_at,
      superseded_by_harness_topic = EXCLUDED.superseded_by_harness_topic,
      cached_at = now()
  `;
}

// ── Public surface ──────────────────────────────────────────────

/** Resolved repo identity + any existing binding. The share-wizard binding
 *  step needs the GitHub-resolved repo id + owner/name EVEN WHEN no binding
 *  row exists yet (it feeds shared.json, whose repo id derives the swarm
 *  topic). resolveRepoBinding alone can't supply that — it returns null on a
 *  cache miss, discarding the resolved id. */
export interface RepoIdentity {
  github_repository_id: number;
  github_owner: string;
  github_repo: string;
  github_full_name: string;
  /** GitHub repo visibility. The share wizard rejects shared-public on a private
   *  repo up front (Cupboard, the public registry, refuses private repos). */
  private: boolean;
  existing_binding: BindingRecord | null;
}

/**
 * Resolve a GitHub URL to its canonical numeric repo id + owner/name (always,
 * via GitHub) AND any existing binding row (cache). owner/name come from
 * GitHub's canonical `full_name` (correct casing), not the user-typed URL.
 * Refreshes a cached row's full_name on rename. Throws BindingServiceError
 * (GITHUB_REPO_NOT_FOUND / RATE_LIMIT / etc.) on GitHub failures.
 */
export async function resolveRepoIdentity(githubUrl: string): Promise<RepoIdentity> {
  const parsed = parseGithubRepoUrl(githubUrl);
  if (!parsed) {
    fail({ code: 'GITHUB_API_DOWN', message: 'unparseable GitHub URL: ' + githubUrl });
  }
  const workspaceId = activeWorkspaceId();
  const { id, full_name, private: isPrivate } = await resolveGithubRepoNumericId(parsed!.owner, parsed!.repo);
  const cached = await readCachedByRepoId(workspaceId, id);
  if (cached && cached.github_full_name !== full_name) {
    // Refresh full_name if changed (rename); other fields untouched.
    cached.github_full_name = full_name;
    await upsertCacheRow(workspaceId, cached);
  }
  const [canonOwner, canonRepo] = full_name.split('/');
  return {
    github_repository_id: id,
    github_owner: canonOwner ?? parsed!.owner,
    github_repo: canonRepo ?? parsed!.repo,
    github_full_name: full_name,
    private: isPrivate,
    existing_binding: cached,
  };
}

/**
 * Per memo `resolveRepoBinding`. Resolves a GitHub URL to a canonical
 * record. Caches result for 24h. Returns null when no binding exists
 * for the repo (caller dispatches to createUnclaimedBinding). Thin wrapper
 * over `resolveRepoIdentity` for callers that only want the binding row.
 */
export async function resolveRepoBinding(githubUrl: string): Promise<BindingRecord | null> {
  return (await resolveRepoIdentity(githubUrl)).existing_binding;
}

/**
 * Per memo `createUnclaimedBinding`. Caller becomes
 * provisional_owner_github_user_id. Throws BINDING_EXISTS if the
 * repo already has an active binding.
 */
export async function createUnclaimedBinding(input: {
  githubUrl: string;
  privacy: BindingPrivacy;
  harness_topic: string;
  harness_slug: string;
}): Promise<BindingRecord> {
  const parsed = parseGithubRepoUrl(input.githubUrl);
  if (!parsed) {
    fail({ code: 'GITHUB_API_DOWN', message: 'unparseable GitHub URL: ' + input.githubUrl });
  }
  const workspaceId = activeWorkspaceId();
  const { id, full_name } = await resolveGithubRepoNumericId(parsed!.owner, parsed!.repo);
  const existing = await readCachedByRepoId(workspaceId, id);
  if (existing && existing.claim_status !== 'superseded') {
    fail({ code: 'BINDING_EXISTS', binding: existing });
  }
  const me = await getAuthenticatedUser();
  const harness_link =
    'papercusp://harness?topic=' +
    input.harness_topic +
    '&github=' +
    full_name +
    '&repo_id=' +
    String(id);
  const rec: BindingRecord = {
    provider: 'github',
    github_repository_id: id,
    github_full_name: full_name,
    harness_topic: input.harness_topic,
    harness_slug: input.harness_slug,
    harness_link,
    privacy: input.privacy,
    claim_status: 'unclaimed',
    provisional_owner_github_user_id: me.id,
    provisional_owner_github_login: me.login,
    claimed_by_github_user_ids: [],
    created_at: new Date().toISOString(),
  };
  await upsertCacheRow(workspaceId, rec);
  return rec;
}

/**
 * Per memo `claimBinding`. Caller must have maintain or admin on the
 * bound repo.
 */
export async function claimBinding(input: { binding_id: string }): Promise<BindingRecord> {
  const parsed = parseBindingId(input.binding_id);
  if (!parsed) {
    fail({ code: 'BINDING_NOT_FOUND' });
  }
  const workspaceId = activeWorkspaceId();
  const existing = await readCachedByRepoId(workspaceId, parsed!.repositoryId);
  if (!existing) fail({ code: 'BINDING_NOT_FOUND' });
  if (existing!.claim_status === 'superseded') {
    fail({ code: 'BINDING_NOT_CLAIMABLE', reason: 'binding superseded' });
  }
  const [owner, repo] = existing!.github_full_name.split('/');
  const me = await getAuthenticatedUser();
  const perm = await getRepoPermission(owner!, repo!, me.login);
  if (!hasRequiredPermission(perm, CLAIM_REQUIRED_PERMISSION)) {
    fail({
      code: 'CLAIM_PERMISSION_DENIED',
      actual: perm,
      required: 'maintain or admin',
    });
  }
  // EI-1626: append via a single atomic SQL set-union UPDATE instead of a JS
  // read→modify→write. The old code computed `[...existing.ids, me.id]` (and,
  // on the idempotent-reclaim branch, rewrote `existing` verbatim) from the
  // `existing` snapshot read above, then wrote it wholesale via upsertCacheRow
  // (ON CONFLICT DO UPDATE SET claimed_by_github_user_ids = EXCLUDED...). Two
  // maintainers claiming concurrently could both read the same stale snapshot
  // and last-write-wins one claimant out of the array — and the "idempotent"
  // branch had the identical bug (it rewrites `existing.claimed_by_github_user_ids`
  // verbatim, silently dropping any claimant added by a concurrent claim that
  // landed between this call's read and write). A single UPDATE's SET clause
  // is evaluated against the row's CURRENT (not snapshotted) column value, so
  // computing the union+dedupe inline makes read+write atomic per row —
  // regardless of interleaving, every concurrent claimant's id survives.
  const nowIso = new Date().toISOString();
  const { sql } = getOrgPg();
  const rows = (await sql`
    UPDATE harness_shared.shared_repo_binding_cache
    SET claimed_by_github_user_ids = ARRAY(
          SELECT DISTINCT unnest(claimed_by_github_user_ids || ARRAY[${me.id}::bigint])
          ORDER BY 1
        ),
        claim_status = 'claimed',
        claimed_at = COALESCE(claimed_at, ${nowIso}),
        last_permission_verified_at = ${nowIso}
    WHERE workspace_id = ${workspaceId}
      AND provider = 'github'
      AND github_repository_id = ${existing!.github_repository_id}
    RETURNING *
  `) as unknown as SrbcRow[];
  if (rows.length === 0) fail({ code: 'BINDING_NOT_FOUND' });
  return rowToBinding(rows[0]!);
}

/**
 * Per memo `supersedeBinding`. Stricter — requires admin (not just maintain).
 */
export async function supersedeBinding(input: {
  old_binding_id: string;
  new_harness_topic: string;
  new_harness_slug: string;
  reason: string;
}): Promise<{ old: BindingRecord; new: BindingRecord }> {
  const parsed = parseBindingId(input.old_binding_id);
  if (!parsed) fail({ code: 'BINDING_NOT_FOUND' });
  const workspaceId = activeWorkspaceId();
  const existing = await readCachedByRepoId(workspaceId, parsed!.repositoryId);
  if (!existing) fail({ code: 'BINDING_NOT_FOUND' });
  if (existing!.claim_status === 'superseded') {
    fail({ code: 'BINDING_NOT_CLAIMABLE', reason: 'already superseded' });
  }
  const [owner, repo] = existing!.github_full_name.split('/');
  const me = await getAuthenticatedUser();
  const perm = await getRepoPermission(owner!, repo!, me.login);
  if (!hasRequiredPermission(perm, SUPERSEDE_REQUIRED_PERMISSION)) {
    fail({
      code: 'SUPERSEDE_PERMISSION_DENIED',
      actual: perm,
      required: 'admin',
    });
  }
  void input.reason; // recorded by caller in plan/audit; not persisted on the row in v1
  const nowIso = new Date().toISOString();
  const newRec: BindingRecord = {
    provider: 'github',
    github_repository_id: existing!.github_repository_id,
    github_full_name: existing!.github_full_name,
    harness_topic: input.new_harness_topic,
    harness_slug: input.new_harness_slug,
    harness_link:
      'papercusp://harness?topic=' +
      input.new_harness_topic +
      '&github=' +
      existing!.github_full_name +
      '&repo_id=' +
      String(existing!.github_repository_id),
    privacy: existing!.privacy,
    claim_status: 'claimed',
    provisional_owner_github_user_id: me.id,
    provisional_owner_github_login: me.login,
    claimed_by_github_user_ids: [me.id],
    created_at: nowIso,
    claimed_at: nowIso,
    last_permission_verified_at: nowIso,
  };
  // Old row stays in cache flipped to superseded, pointer to new
  // harness_topic for audit lookup. NOTE: the PG row's PK is
  // (workspace, provider, repo_id) so we can't have BOTH old + new
  // active simultaneously in the cache. v1 behavior: keep the new
  // active record; the audit trail of supersession lives in the
  // harness_decisions plan-doc the caller writes. Future v2 may
  // extend the schema with an `epoch` column to allow multiple
  // rows per repo_id.
  await upsertCacheRow(workspaceId, newRec);
  const oldRec: BindingRecord = {
    ...existing!,
    claim_status: 'superseded',
    superseded_by_harness_topic: input.new_harness_topic,
  };
  return { old: oldRec, new: newRec };
}

/**
 * Per memo `recheckClaimantPermissions`. Daemon job — re-verifies
 * every claimant's GitHub permission. On revocation of all
 * claimants, flips claim_status → 'stale'.
 *
 * Returns the list of bindings whose status changed.
 */
export async function recheckClaimantPermissions(): Promise<
  Array<{ binding_id: string; old_status: string; new_status: string }>
> {
  const workspaceId = activeWorkspaceId();
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT * FROM harness_shared.shared_repo_binding_cache
    WHERE workspace_id = ${workspaceId}
      AND provider = 'github'
      AND claim_status = 'claimed'
  `) as unknown as SrbcRow[];
  const changes: Array<{ binding_id: string; old_status: string; new_status: string }> = [];
  for (const row of rows) {
    const bind = rowToBinding(row);
    const [owner, repo] = bind.github_full_name.split('/');
    if (!owner || !repo) continue; // malformed full_name — skip (can't verify safely)
    const ids = bind.claimed_by_github_user_ids;

    // Resolve numeric claimant ids → GitHub logins via the contributors mirror
    // (github_user_id is globally unique; same join the claim-status route uses).
    // Best-effort: a missing/unreachable contributors table leaves logins
    // unresolved, which we treat as "cannot verify" → KEEP (never demote on
    // uncertainty).
    const loginMap: Record<number, string> = {};
    if (ids.length > 0) {
      try {
        const cRows = (await sql`
          SELECT DISTINCT github_user_id, github_username
            FROM harness_shared.contributors
           WHERE workspace_id = ${workspaceId}
             AND github_user_id = ANY(${ids as unknown as string})
        `) as unknown as Array<{ github_user_id: number | string; github_username: string }>;
        for (const r of cRows) {
          const id = Number(r.github_user_id);
          if (Number.isFinite(id) && r.github_username) loginMap[id] = r.github_username;
        }
      } catch {
        // contributors table missing / unreachable — can't resolve logins; the
        // per-claimant loop below treats every id as unverifiable → keeps all.
      }
    }

    // Re-check each claimant LIVE. A claimant is dropped ONLY on a definitive
    // GitHub result below maintain/admin. Two fail-SAFE rules so a transient
    // GitHub outage (or an unresolvable login) never wrongly demotes a real
    // owner: (1) unresolved login → keep; (2) getRepoPermission throw
    // (GITHUB_API_DOWN / RATE_LIMIT) → keep.
    const stillClaimers: number[] = [];
    for (const userId of ids) {
      const login = loginMap[userId];
      if (!login) {
        stillClaimers.push(userId); // can't resolve login → can't verify → keep
        continue;
      }
      let perm: GithubRepoPermission;
      try {
        perm = await getRepoPermission(owner, repo, login);
      } catch {
        stillClaimers.push(userId); // GitHub unreachable → never demote on a transient error
        continue;
      }
      if (hasRequiredPermission(perm, CLAIM_REQUIRED_PERMISSION)) {
        stillClaimers.push(userId); // still maintain/admin
      }
      // else: a DEFINITIVE read/write/triage/none → this claimant lost the
      // permission they claimed with → dropped.
    }

    if (ids.length === 0) {
      // Inconsistent state: claimed with no claimants → stale (cleanup; this was
      // the only branch the v1 stub could ever reach).
      await upsertCacheRow(workspaceId, { ...bind, claim_status: 'stale' });
      changes.push({
        binding_id: composeBindingId('github', bind.github_repository_id),
        old_status: bind.claim_status,
        new_status: 'stale',
      });
    } else if (stillClaimers.length === 0) {
      // EVERY claimant definitively lost permission → stale; the trust signal no
      // longer holds and provisional-owner controls re-enable (memo / scenario 5).
      await upsertCacheRow(workspaceId, {
        ...bind,
        claim_status: 'stale',
        claimed_by_github_user_ids: [],
      });
      changes.push({
        binding_id: composeBindingId('github', bind.github_repository_id),
        old_status: bind.claim_status,
        new_status: 'stale',
      });
    } else if (stillClaimers.length !== ids.length) {
      // SOME (not all) claimants lost permission → prune them; the binding stays
      // claimed because ≥1 verified maintainer remains. No status change.
      await upsertCacheRow(workspaceId, {
        ...bind,
        claimed_by_github_user_ids: stillClaimers,
      });
      changes.push({
        binding_id: composeBindingId('github', bind.github_repository_id),
        old_status: bind.claim_status,
        new_status: 'claimed', // status unchanged; the change is a claimant prune
      });
    }
    // else: all claimants still valid → no change.
  }
  return changes;
}

/**
 * Expose cache TTL so callers + tests share one source of truth.
 */
export const BINDING_CACHE_TTL_MS = CACHE_TTL_MS;
