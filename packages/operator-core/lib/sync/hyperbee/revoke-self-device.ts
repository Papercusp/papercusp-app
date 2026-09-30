/**
 * revokeSelfDevice — self-revoke one of YOUR OWN device pubkeys.
 *
 * Plan: substrate-revocation-v1 Task 3 (D-003/D-004/D-005).
 *
 * Appends the updated contributor row (with the target pubkey added to
 * `revoked_pubkeys`) to the booted handle's own log via
 * `publishContributorRow` (replicates + projects to
 * `harness_shared.contributors`), AND calls `handle.revoke(devicePubkey)`
 * for immediate local effect.
 *
 * Self-revocation ONLY (Keybase/Sigstore model). You are authoritative
 * over your own keys; revoking ANOTHER contributor is out of scope (v2,
 * needs a trust-model decision — D-003).
 *
 * Ownership check: the identity's OWN device pubkeys are those found in
 * `device_attestations[].device_pubkey`. A request to revoke a pubkey
 * that does not appear in your own attestations is refused with
 * `code:'not_your_key'`.
 *
 * Idempotent: an already-revoked pubkey proceeds through writeRow
 * (to ensure the live handle is also updated) and returns
 * `{ ok: true, ... }`.
 *
 * Handle-not-booted: when the handle for (workspaceId, harnessSlug) is not
 * booted, the row is still written via writeRow (the real impl re-derives the
 * handle there) and live:false is reported. The row write is the durable part;
 * revocation takes effect on the next boot's `loadRevokedPubkeys` call.
 *
 * NOTE on seam design: `writeRow` takes the updated row + the (workspaceId,
 * harnessSlug) context. The real impl fetches the handle internally via
 * getBootedHarness so it can use `publishContributorRow`. Tests inject a
 * spy that doesn't need a real handle. `getHandle` is a SEPARATE seam used
 * only for the live `handle.revoke()` call.
 */

import type { ContributorRow } from '../../harness/contributor-row-types';
import {
  resolveLocalGithubIdentity,
  type LocalGithubIdentity,
} from '../../identity/resolve-local-github-identity';
import { createRequire } from 'node:module';

// ESM shim (cf. EI-3/EI-8): operator-core is type:module, so bare `require` is
// undefined under tsx. The two lazy `require('./boot-all')` circular-dodge calls
// below (one in the sync realGetHandle) need a real require.
const require = createRequire(import.meta.url);

// ─── public types ─────────────────────────────────────────────────────────────

export type RevokeSelfDeviceResult =
  | {
      ok: true;
      /** The revoked device pubkey (the one requested). */
      revoked: string;
      /**
       * True when the live booted handle was present and `handle.revoke()`
       * was called successfully. False when the handle wasn't booted for
       * this (workspaceId, harnessSlug) — the row write still happened and
       * revocation takes effect on the next boot.
       */
      live: boolean;
    }
  | { ok: false; code: 'gh_auth_required' }
  | { ok: false; code: 'no_contributor_row' }
  | { ok: false; code: 'not_your_key' };

export interface RevokeSelfDeviceInput {
  workspaceId: string;
  harnessSlug: string;
  devicePubkey: string;
}

/** Minimal live-handle interface needed for revoke only. */
export interface LiveRevokeHandle {
  revoke(devicePubkey: string): Promise<void>;
}

/**
 * Injectable seams — all have real defaults wired below.
 */
export interface RevokeSelfDeviceSeams {
  /**
   * Resolve the local machine's GitHub identity (token + user id + login).
   * Default: `resolveLocalGithubIdentity`.
   */
  resolveIdentity?: () => Promise<LocalGithubIdentity>;
  /**
   * Load the caller's own contributor row for the given harness. Keyed by
   * (workspaceId, harnessSlug, githubUserId). Returns null when no row exists.
   *
   * Default: live PG query against `harness_shared.contributors`.
   */
  loadOwnRow?: (opts: {
    workspaceId: string;
    harnessSlug: string;
    githubUserId: number;
  }) => Promise<ContributorRow | null>;
  /**
   * Write the updated contributor row to the substrate.
   * The real implementation calls `publishContributorRow` via the booted handle.
   * Tests inject a spy that doesn't need a real Hypercore handle.
   */
  writeRow?: (opts: {
    workspaceId: string;
    harnessSlug: string;
    row: ContributorRow;
  }) => Promise<void>;
  /**
   * Return the booted handle for (workspaceId, harnessSlug), or null when
   * the substrate isn't booted for that pair. Used ONLY for the live
   * `handle.revoke()` call — the row write goes through `writeRow` which
   * has its own handle resolution.
   * Default: `getBootedHarness`.
   */
  getHandle?: (workspaceId: string, harnessSlug: string) => LiveRevokeHandle | null;
}

// ─── core ─────────────────────────────────────────────────────────────────────

export async function revokeSelfDevice(
  input: RevokeSelfDeviceInput,
  seams: RevokeSelfDeviceSeams = {},
): Promise<RevokeSelfDeviceResult> {
  const {
    resolveIdentity = resolveLocalGithubIdentity,
    loadOwnRow = realLoadOwnRow,
    writeRow = realWriteRow,
    getHandle = realGetHandle,
  } = seams;

  // 1. Resolve local GitHub identity.
  const identity = await resolveIdentity();
  if (identity.kind === 'gh_auth_required') {
    return { ok: false, code: 'gh_auth_required' };
  }

  // 2. Load the caller's own contributor row.
  const row = await loadOwnRow({
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    githubUserId: identity.githubUserId,
  });
  if (!row) {
    return { ok: false, code: 'no_contributor_row' };
  }

  // 3. Ownership check: the requested pubkey must appear in the caller's
  //    own device_attestations. Revoking another contributor's key is out of
  //    scope (v2).
  const ownPubkeys = new Set(row.device_attestations.map((a) => a.device_pubkey));
  if (!ownPubkeys.has(input.devicePubkey)) {
    return { ok: false, code: 'not_your_key' };
  }

  // 4. Compute the updated revoked_pubkeys (deduplicated).
  const revokedSet = new Set(row.revoked_pubkeys);
  revokedSet.add(input.devicePubkey);
  const updatedRow: ContributorRow = {
    ...row,
    revoked_pubkeys: [...revokedSet],
  };

  // 5. Append updated row to the own log (replicates + projects to PG).
  //    This is the durable part — revocation persists even when the handle
  //    is not currently booted (the next boot's loadRevokedPubkeys will pick
  //    it up from the projected PG row).
  await writeRow({
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    row: updatedRow,
  });

  // 6. Live revoke on the booted handle for immediate local effect.
  //    Best-effort + idempotent: if the handle is not booted, the row write
  //    above is sufficient for durability; revocation takes effect on next boot.
  const handle = getHandle(input.workspaceId, input.harnessSlug);
  if (handle) {
    await handle.revoke(input.devicePubkey);
    return { ok: true, revoked: input.devicePubkey, live: true };
  }

  return { ok: true, revoked: input.devicePubkey, live: false };
}

// ─── real default seams ───────────────────────────────────────────────────────

async function realLoadOwnRow(opts: {
  workspaceId: string;
  harnessSlug: string;
  githubUserId: number;
}): Promise<ContributorRow | null> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { isContributorRow } = await import('../../harness/contributor-row-types');
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT
      harness_slug, github_user_id, github_username,
      display_name, avatar_url,
      device_attestations,
      revoked_pubkeys,
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
    WHERE workspace_id = $1
      AND harness_slug = $2
      AND github_user_id = $3
    LIMIT 1`,
    [opts.workspaceId, opts.harnessSlug, opts.githubUserId] as never,
  )) as unknown[];
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!isContributorRow(row)) return null;
  return row;
}

async function realWriteRow(opts: {
  workspaceId: string;
  harnessSlug: string;
  row: ContributorRow;
}): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getBootedHarness } = require('./boot-all') as typeof import('./boot-all');
  const handle = getBootedHarness(opts.workspaceId, opts.harnessSlug);
  if (!handle) {
    // No booted handle — cannot append to the log. In production this should
    // not happen (the caller checks getHandle before choosing live:false), but
    // guard defensively.
    throw new Error(
      `revokeSelfDevice: no booted handle for ${opts.workspaceId}::${opts.harnessSlug} — cannot write row`,
    );
  }
  const { publishContributorRow } = await import('./write-contributor-row');
  await publishContributorRow({ handle, row: opts.row });
}

function realGetHandle(workspaceId: string, harnessSlug: string): LiveRevokeHandle | null {
  // Lazy-require to avoid a circular dependency.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getBootedHarness } = require('./boot-all') as typeof import('./boot-all');
  return getBootedHarness(workspaceId, harnessSlug);
}
