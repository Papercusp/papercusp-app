/**
 * revokeContributorViaGithub — OWNER revocation of another contributor.
 *
 * Plan: non-collaborator-join-fork-pr-2026-06-02 D-001 (supersedes the old
 * substrate-revocation-v2 branch-delete design).
 *
 * ## Why this changed (write-free model)
 * Admission is now gated on the contributor's attestation GIST
 * (`read-admission` → `verifyAttestation`), NOT on a `user/<id>` contributor
 * branch in the shared repo. So the old "delete the user/<id> branch" was a
 * silent NO-OP, and the alternative "delete the gist" is INFEASIBLE — an admin
 * cannot delete another user's gist.
 *
 * The real revocation lever is `read-admission`'s `revoked_pubkeys` blocklist,
 * which `load-revoked-pubkeys` builds by UNIONing `revoked_pubkeys` across ALL
 * contributor rows for the harness. So owner-revocation = the owner adds the
 * target's device pubkeys to the OWNER's OWN contributor-row `revoked_pubkeys`
 * and publishes it (federates via the owner's log → projected to PG → honored
 * by every peer's admission union). This mirrors `revoke-self-device.ts` minus
 * the "must be your own key" check, plus the repo-admin authority gate.
 *
 * Authority model:
 *   - Only a GitHub repo ADMIN may invoke this (the caller's gh token must have
 *     admin on the shared repo). This is the harness-owner authority.
 *   - `githubUserId` (the TARGET) must be a positive integer.
 *
 * Seam design (all injected; real defaults below):
 *   - `resolveContext` — returns `{repoOwner, repoName, token}` from
 *     `.papercusp/shared.json` + `resolveLocalGithubIdentity` (for the admin check).
 *   - `octokit` — for the admin check (`repos.get` → `permissions.admin`).
 *   - `loadTargetPubkeys` — resolve the target's device pubkeys from
 *     `harness_shared.contributors`.
 *   - `publishRevocation` — add those pubkeys to the OWNER's own row's
 *     `revoked_pubkeys`, publish (federate), and live-revoke on the booted handle.
 */

import { resolveLocalGithubIdentity } from '../../identity/resolve-local-github-identity';
import { createRequire } from 'node:module';

// ESM shim (cf. EI-3/EI-8): operator-core is type:module → bare `require` is
// undefined under tsx; the lazy `require('./boot-all')` circular-dodge needs a
// real require.
const require = createRequire(import.meta.url);

// ─── public types ─────────────────────────────────────────────────────────────

export type RevokeContributorResult =
  | {
      ok: true;
      /** The target device pubkeys that were added to the revoked set. */
      revokedPubkeys: string[];
      /** True when a booted handle applied the revoke live; false when the row
       *  write is the only effect (takes effect on the next boot's union load). */
      live: boolean;
    }
  | { ok: false; code: 'no_context' }
  | { ok: false; code: 'not_admin' }
  | { ok: false; code: 'no_target' }
  | { ok: false; code: 'github_error'; detail: string }
  | { ok: false; code: 'revoke_failed'; detail: string };

export interface RevokeContributorInput {
  workspaceId: string;
  harnessSlug: string;
  /** Numeric GitHub user id of the contributor to revoke. Must be a positive integer. */
  githubUserId: number;
}

/** Resolved shared-repo context + the authenticated gh token (for the admin check). */
export interface RevokeContributorContext {
  repoOwner: string;
  repoName: string;
  token: string;
}

/** Injectable seams — all have real defaults wired below. */
export interface RevokeContributorSeams {
  /**
   * Resolve the shared repo `{repoOwner, repoName}` + the authenticated gh
   * token. Returns null when the harness is private or gh is not authed.
   */
  resolveContext?: (
    workspaceId: string,
    harnessSlug: string,
  ) => Promise<RevokeContributorContext | null>;

  /**
   * Authenticated Octokit (only `repos.get` is needed — the admin gate).
   * Default: `getOctokit()`.
   */
  octokit?: {
    rest: {
      repos: {
        get: (params: {
          owner: string;
          repo: string;
        }) => Promise<{ data: { permissions?: { admin?: boolean } } }>;
      };
    };
  };

  /**
   * Resolve the TARGET contributor's device pubkeys from
   * `harness_shared.contributors` (their `device_attestations[].device_pubkey`).
   * Empty array → nothing to revoke (`no_target`).
   */
  loadTargetPubkeys?: (opts: {
    workspaceId: string;
    harnessSlug: string;
    githubUserId: number;
  }) => Promise<string[]>;

  /**
   * Add `pubkeys` to the OWNER's own contributor-row `revoked_pubkeys` and
   * publish (federates) + live-revoke on the booted handle. Returns `{live}`.
   */
  publishRevocation?: (opts: {
    workspaceId: string;
    harnessSlug: string;
    pubkeys: string[];
  }) => Promise<{ live: boolean }>;
}

// ─── core ─────────────────────────────────────────────────────────────────────

export async function revokeContributorViaGithub(
  input: RevokeContributorInput,
  seams: RevokeContributorSeams = {},
): Promise<RevokeContributorResult> {
  // Validate target id before any work — never operate on a non-positive-integer id.
  if (!Number.isInteger(input.githubUserId) || input.githubUserId <= 0) {
    return { ok: false, code: 'github_error', detail: 'githubUserId must be a positive integer' };
  }

  const {
    resolveContext = realResolveContext,
    octokit: octokitSeam,
    loadTargetPubkeys = realLoadTargetPubkeys,
    publishRevocation = realPublishRevocation,
  } = seams;

  // 1. Resolve shared-repo context (for the admin check).
  const ctx = await resolveContext(input.workspaceId, input.harnessSlug);
  if (!ctx) return { ok: false, code: 'no_context' };

  // 2. Resolve an Octokit instance.
  let oc = octokitSeam;
  if (!oc) {
    const realOc = await (await import('../../identity/octokit-client')).getOctokit();
    if (!realOc) return { ok: false, code: 'no_context' };
    oc = realOc as unknown as typeof oc;
  }

  // 3. Admin gate: only a repo admin (the harness owner) may revoke another.
  let repoData: { permissions?: { admin?: boolean } };
  try {
    const resp = await oc!.rest.repos.get({ owner: ctx.repoOwner, repo: ctx.repoName });
    repoData = resp.data;
  } catch (err: unknown) {
    return { ok: false, code: 'github_error', detail: err instanceof Error ? err.message : String(err) };
  }
  if (!repoData.permissions?.admin) {
    return { ok: false, code: 'not_admin' };
  }

  // 4. Resolve the target's device pubkeys (the things to revoke).
  let pubkeys: string[];
  try {
    pubkeys = await loadTargetPubkeys({
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      githubUserId: input.githubUserId,
    });
  } catch (err: unknown) {
    return { ok: false, code: 'github_error', detail: err instanceof Error ? err.message : String(err) };
  }
  if (!pubkeys || pubkeys.length === 0) {
    return { ok: false, code: 'no_target' };
  }

  // 5. Publish the revocation to the OWNER's own revoked_pubkeys (federates) +
  //    live-revoke. read-admission unions revoked_pubkeys across all rows, so
  //    every peer denies the target on its next re-verify.
  try {
    const { live } = await publishRevocation({
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      pubkeys,
    });
    return { ok: true, revokedPubkeys: pubkeys, live };
  } catch (err: unknown) {
    return { ok: false, code: 'revoke_failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

// ─── real default seams ───────────────────────────────────────────────────────

async function realResolveContext(
  workspaceId: string,
  harnessSlug: string,
): Promise<RevokeContributorContext | null> {
  let projectDir: string;
  try {
    const { resolveHarnessPaths } = await import('../../resolve-harness-paths');
    const resolved = await resolveHarnessPaths(harnessSlug, workspaceId);
    projectDir = resolved.projectDir;
  } catch {
    return null;
  }
  if (!projectDir || projectDir.startsWith('/tmp/papercusp-unresolved/')) return null;

  const { loadSharedConfigFromProjectDir } = await import('../../harness/load-shared-config');
  const cfg = loadSharedConfigFromProjectDir(projectDir);
  if (!cfg) return null;

  const { parseGithubUrl } = await import('../../harness/clone-github');
  const parsed = parseGithubUrl(cfg.github_remote);
  if (!parsed) return null;

  const identity = await resolveLocalGithubIdentity();
  if (identity.kind !== 'ok') return null;

  return { repoOwner: parsed.owner, repoName: parsed.repo, token: identity.token };
}

/**
 * Load the target contributor's device pubkeys from `harness_shared.contributors`.
 * Returns the union of `device_attestations[].device_pubkey` for that user.
 */
async function realLoadTargetPubkeys(opts: {
  workspaceId: string;
  harnessSlug: string;
  githubUserId: number;
}): Promise<string[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT device_attestations
       FROM harness_shared.contributors
      WHERE workspace_id = $1 AND harness_slug = $2 AND github_user_id = $3
      LIMIT 1`,
    [opts.workspaceId, opts.harnessSlug, opts.githubUserId] as never,
  )) as Array<{ device_attestations: Array<{ device_pubkey?: string }> | null }>;
  if (rows.length === 0) return [];
  const attestations = rows[0]?.device_attestations ?? [];
  const pubkeys = new Set<string>();
  for (const a of attestations) {
    if (a && typeof a.device_pubkey === 'string' && a.device_pubkey.length > 0) {
      pubkeys.add(a.device_pubkey);
    }
  }
  return [...pubkeys];
}

/**
 * Add `pubkeys` to the OWNER's own contributor-row `revoked_pubkeys` and publish
 * via the booted handle (federates), then live-revoke each on the handle.
 * Mirrors `revoke-self-device.ts` realWriteRow + the live revoke loop.
 */
async function realPublishRevocation(opts: {
  workspaceId: string;
  harnessSlug: string;
  pubkeys: string[];
}): Promise<{ live: boolean }> {
  // Resolve the OWNER's identity → load the owner's own contributor row.
  const identity = await resolveLocalGithubIdentity();
  if (identity.kind !== 'ok') {
    throw new Error('owner gh identity unavailable — cannot publish revocation');
  }

  const { getOrgPg } = await import('@papercusp/db-org');
  const { isContributorRow } = await import('../../harness/contributor-row-types');
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT
        harness_slug, github_user_id, github_username, display_name, avatar_url,
        device_attestations, revoked_pubkeys,
        EXTRACT(EPOCH FROM joined_at)::bigint * 1000 AS joined_at,
        CASE WHEN last_seen_at IS NULL THEN NULL
             ELSE EXTRACT(EPOCH FROM last_seen_at)::bigint * 1000 END AS last_seen_at,
        binding_status,
        CASE WHEN channel1_verified_at IS NULL THEN NULL
             ELSE EXTRACT(EPOCH FROM channel1_verified_at)::bigint * 1000 END AS channel1_verified_at,
        CASE WHEN channel2_verified_at IS NULL THEN NULL
             ELSE EXTRACT(EPOCH FROM channel2_verified_at)::bigint * 1000 END AS channel2_verified_at,
        channel2_branch_ref,
        CASE WHEN binding_last_checked_at IS NULL THEN NULL
             ELSE EXTRACT(EPOCH FROM binding_last_checked_at)::bigint * 1000 END AS binding_last_checked_at,
        schema_version
       FROM harness_shared.contributors
      WHERE workspace_id = $1 AND harness_slug = $2 AND github_user_id = $3
      LIMIT 1`,
    [opts.workspaceId, opts.harnessSlug, identity.githubUserId] as never,
  )) as unknown[];
  if (rows.length === 0) {
    throw new Error('owner has no contributor row — join the harness before revoking');
  }
  const ownRow = rows[0];
  if (!isContributorRow(ownRow)) {
    throw new Error('owner contributor row malformed');
  }

  // Union the target pubkeys into the owner's revoked set.
  const revokedSet = new Set(ownRow.revoked_pubkeys);
  for (const pk of opts.pubkeys) revokedSet.add(pk);
  const updatedRow = { ...ownRow, revoked_pubkeys: [...revokedSet] };

  // Publish via the booted handle (federates + projects to PG).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getBootedHarness } = require('./boot-all') as typeof import('./boot-all');
  const handle = getBootedHarness(opts.workspaceId, opts.harnessSlug);
  if (!handle) {
    throw new Error(
      `revokeContributorViaGithub: no booted handle for ${opts.workspaceId}::${opts.harnessSlug}`,
    );
  }
  const { publishContributorRow } = await import('./write-contributor-row');
  await publishContributorRow({ handle, row: updatedRow });

  // Live-revoke each pubkey on the handle for immediate local effect.
  let live = false;
  const h = handle as unknown as { revoke?: (pk: string) => Promise<void> };
  if (typeof h.revoke === 'function') {
    for (const pk of opts.pubkeys) await h.revoke(pk);
    live = true;
  }
  return { live };
}
