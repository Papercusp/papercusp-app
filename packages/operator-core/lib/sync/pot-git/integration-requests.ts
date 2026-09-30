/**
 * pot-git/integration-requests.ts — the multi-owner integration-requests queue
 * (Phase 7 G-5c, cross-machine-coord-parity-and-trust-2026-07-01 / P-035;
 * D-010/D-011). Writer/reader for `harness_shared.pot_integration_requests`
 * (mig 441) + the tier GATE the integrator calls before merging member heads.
 *
 * QUEUE, DON'T INTEGRATE (the code-plane twin of P-013's coord_quarantine):
 * a namespace work head published by a member device whose verified author sits
 * BELOW the 'steer' comms tier is NOT auto-merged into staging by
 * integrator.ts. It lands here instead — visible on the requests surface,
 * promotable with ONE call ({@link ratifyIntegrationRequest}) — never silently
 * merged and never silently dropped. Ratification is PER-SHA: a newer head from
 * the same below-tier device queues again (you ratify the code you saw, not the
 * author's future pushes).
 *
 * FAIL-CLOSED at the gate: this is a TRUST decision, so any per-head resolution
 * failure (tier resolver threw, PG hiccup) excludes that head from integration
 * and reports it — the gate itself never throws (fail-soft on the hot path),
 * and an error can never widen trust.
 *
 * BOUNDED per author device (flood containment, mirroring the quarantine
 * writer): past the cap the oldest rows are evicted, PENDING FIRST — ratified
 * rows are the last to go, so an author's junk re-publishes cannot evict their
 * own owner-approved head.
 *
 * LOCAL-ONLY: never federates (no capture / HLC stamp trigger) — ratification
 * is the receiving integrator/owner's judgment about the sender.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import { commsTierAtLeast, type CommsTier } from '../../trust/comms-trust';
import { deviceNamespaceKey } from './storage';
import type { MemberHead } from './integrator';

/** Per-author-device row cap (oldest pending evicted first). Env-tunable. */
export const DEFAULT_INTEGRATION_REQUESTS_PER_AUTHOR_CAP =
  Number(process.env.PAPERCUSP_INTEGRATION_REQUESTS_PER_AUTHOR_CAP) || 50;

/** The tier at (or above) which a member's heads auto-integrate (P-029). */
export const AUTO_INTEGRATE_TIER: CommsTier = 'steer';

export type IntegrationRequestReason = 'below-steer-tier';
export type IntegrationRequestState = 'pending' | 'ratified';

/** One queue: per (workspace, hive, managed member repo) — G-1b scope. */
export interface IntegrationRequestScope {
  workspaceId: string;
  potSlug: string;
  repoKey: string;
}

export interface QueueIntegrationRequestInput extends IntegrationRequestScope {
  /** The publishing member device (identity pubkey, base64) — sigrefs-verified upstream. */
  devicePubkey: string;
  headSha: string;
  /** The device's attested author (hive_members chain), for the surface. */
  authorGithubUserId?: number | null;
  reason?: IntegrationRequestReason;
  nowMs?: number;
  /** Per-author bound override (tests / callers with their own budget). */
  cap?: number;
}

/**
 * Insert (idempotent on the (scope, device, sha) key — a re-queue of an
 * already-ratified head does NOT downgrade it) + evict the author's oldest
 * rows past the cap, pending first.
 *
 * WI-1552 fix (2): the eviction subquery is scoped to THIS (pot_slug,
 * repo_key) queue, matching the declared one-queue-per-(ws,hive,repo) scope
 * (see {@link IntegrationRequestScope}) — an author's cap is enforced
 * per-queue, not globally across every repo they publish to. Without this,
 * one author's flood of publishes to repo A could silently evict their own
 * PENDING rows in an unrelated repo B (never reported, contract-violating).
 */
export async function queueIntegrationRequest(
  input: QueueIntegrationRequestInput,
  sqlIn?: postgres.Sql,
): Promise<void> {
  const sql = sqlIn ?? getOrgPg().sql;
  const now = input.nowMs ?? Date.now();
  const cap = Math.max(1, input.cap ?? DEFAULT_INTEGRATION_REQUESTS_PER_AUTHOR_CAP);
  await sql`
    INSERT INTO harness_shared.pot_integration_requests
      (workspace_id, pot_slug, repo_key, device_pubkey, head_sha,
       author_github_user_id, reason, state, created_ts)
    VALUES
      (${input.workspaceId}, ${input.potSlug}, ${input.repoKey}, ${input.devicePubkey},
       ${input.headSha}, ${input.authorGithubUserId ?? null},
       ${input.reason ?? 'below-steer-tier'}, 'pending', ${now})
    ON CONFLICT (workspace_id, pot_slug, repo_key, device_pubkey, head_sha) DO NOTHING
  `;
  // Bound: keep the author's newest `cap` rows IN THIS (hive,repo) QUEUE,
  // preferring to keep RATIFIED ones (an author's junk flood must not evict
  // their own approved head — in this queue or any other).
  await sql`
    DELETE FROM harness_shared.pot_integration_requests d
    USING (
      SELECT workspace_id, pot_slug, repo_key, device_pubkey, head_sha
      FROM harness_shared.pot_integration_requests
      WHERE workspace_id = ${input.workspaceId}
        AND pot_slug = ${input.potSlug}
        AND repo_key = ${input.repoKey}
        AND device_pubkey = ${input.devicePubkey}
      ORDER BY (state = 'ratified') DESC, created_ts DESC, head_sha
      OFFSET ${cap}
    ) evict
    WHERE d.workspace_id = evict.workspace_id
      AND d.pot_slug = evict.pot_slug
      AND d.repo_key = evict.repo_key
      AND d.device_pubkey = evict.device_pubkey
      AND d.head_sha = evict.head_sha
  `;
}

export interface IntegrationRequest extends IntegrationRequestScope {
  devicePubkey: string;
  headSha: string;
  authorGithubUserId: number | null;
  reason: IntegrationRequestReason;
  state: IntegrationRequestState;
  createdTs: number;
  ratifiedTs: number | null;
}

/** The ratify queue, newest first — the "X wants their head integrated" surface. */
export async function listIntegrationRequests(
  opts: {
    workspaceId: string;
    potSlug?: string;
    repoKey?: string;
    devicePubkey?: string;
    state?: IntegrationRequestState;
    limit?: number;
  },
  sqlIn?: postgres.Sql,
): Promise<IntegrationRequest[]> {
  const sql = sqlIn ?? getOrgPg().sql;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await sql<
    Array<{
      workspace_id: string;
      pot_slug: string;
      repo_key: string;
      device_pubkey: string;
      head_sha: string;
      author_github_user_id: string | number | null;
      reason: IntegrationRequestReason;
      state: IntegrationRequestState;
      created_ts: string | number;
      ratified_ts: string | number | null;
    }>
  >`
    SELECT workspace_id, pot_slug, repo_key, device_pubkey, head_sha,
           author_github_user_id, reason, state, created_ts, ratified_ts
    FROM harness_shared.pot_integration_requests
    WHERE workspace_id = ${opts.workspaceId}
      ${opts.potSlug !== undefined ? sql`AND pot_slug = ${opts.potSlug}` : sql``}
      ${opts.repoKey !== undefined ? sql`AND repo_key = ${opts.repoKey}` : sql``}
      ${opts.devicePubkey !== undefined ? sql`AND device_pubkey = ${opts.devicePubkey}` : sql``}
      ${opts.state !== undefined ? sql`AND state = ${opts.state}` : sql``}
    ORDER BY created_ts DESC, head_sha
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    potSlug: r.pot_slug,
    repoKey: r.repo_key,
    devicePubkey: r.device_pubkey,
    headSha: r.head_sha,
    authorGithubUserId: r.author_github_user_id == null ? null : Number(r.author_github_user_id),
    reason: r.reason,
    state: r.state,
    createdTs: Number(r.created_ts),
    ratifiedTs: r.ratified_ts == null ? null : Number(r.ratified_ts),
  }));
}

/**
 * The one-call promote: mark exactly this (device, sha) ratified so the next
 * integrator pass merges it. Idempotent (re-ratifying keeps the original
 * ratified_ts). Returns false ONLY when no such queued row exists.
 */
export async function ratifyIntegrationRequest(
  key: IntegrationRequestScope & { devicePubkey: string; headSha: string; nowMs?: number },
  sqlIn?: postgres.Sql,
): Promise<boolean> {
  const sql = sqlIn ?? getOrgPg().sql;
  const now = key.nowMs ?? Date.now();
  const rows = await sql`
    UPDATE harness_shared.pot_integration_requests
    SET state = 'ratified', ratified_ts = COALESCE(ratified_ts, ${now})
    WHERE workspace_id = ${key.workspaceId}
      AND pot_slug = ${key.potSlug}
      AND repo_key = ${key.repoKey}
      AND device_pubkey = ${key.devicePubkey}
      AND head_sha = ${key.headSha}
    RETURNING head_sha
  `;
  return rows.length > 0;
}

/**
 * Targeted (device, sha) ratified-membership check — a lookup, not a scan.
 *
 * WI-1552 fix (1): {@link gateMemberHeadsForIntegration} previously checked
 * ratification via a top-500-newest-first window (`listIntegrationRequests`
 * ordered `created_ts DESC LIMIT 500`). Ratified rows have no TTL, so once a
 * (workspace,hive,repo) scope accumulated >500 ratified rows the OLDEST
 * ratified head silently fell out of that window: it would never integrate
 * again and would be misreported as `queued` even though it is already
 * ratified. Checking exact (device_pubkey, head_sha) membership for exactly
 * the heads being gated this pass has no window to fall out of, regardless
 * of how many ratified rows the scope has accumulated.
 */
export async function listRatifiedStates(
  scope: IntegrationRequestScope,
  keys: { devicePubkey: string; headSha: string }[],
  sqlIn?: postgres.Sql,
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const sql = sqlIn ?? getOrgPg().sql;
  const devicePubkeys = keys.map((k) => k.devicePubkey);
  const headShas = keys.map((k) => k.headSha);
  const rows = await sql<Array<{ device_pubkey: string; head_sha: string }>>`
    SELECT device_pubkey, head_sha
    FROM harness_shared.pot_integration_requests
    WHERE workspace_id = ${scope.workspaceId}
      AND pot_slug = ${scope.potSlug}
      AND repo_key = ${scope.repoKey}
      AND state = 'ratified'
      AND (device_pubkey, head_sha) IN (
        SELECT * FROM UNNEST(${sql.array(devicePubkeys)}::text[], ${sql.array(headShas)}::text[])
      )
  `;
  return new Set(rows.map((r) => `${r.device_pubkey}\n${r.head_sha}`));
}

/** A member head as the gate consumes it (pre-namespace-hex: identity pubkey + sha). */
export interface GateableHead {
  /** The member device's identity pubkey (base64) — sigrefs-verified upstream. */
  devicePubkeyBase64: string;
  sha: string;
}

export interface GatedHeads {
  /** Ready for integrateMemberHeads: steer-tier authors + owner-ratified heads. */
  integrate: MemberHead[];
  /** In the ratify queue (visible, NOT applied) after this pass. */
  queued: GateableHead[];
  /** Gate-check failures — excluded from integration (fail-closed), for logging. */
  errors: { devicePubkeyBase64: string; sha: string; error: string }[];
}

/**
 * The integrator's trust chokepoint (P-029 multi-owner mode): partition the
 * collected member heads into what integrates NOW vs what queues for
 * ratification. `resolveTier` is the comms-trust seam (comms-tier-gate /
 * effectiveCommsTier — device → attested author → tier); a null / unresolvable
 * tier is BELOW steer (conservative, matching FALLBACK_COMMS_TIER semantics).
 * Never throws: a per-head failure fails CLOSED into `errors`.
 */
export async function gateMemberHeadsForIntegration(
  opts: IntegrationRequestScope & {
    heads: GateableHead[];
    resolveTier: (devicePubkeyBase64: string) => CommsTier | null | Promise<CommsTier | null>;
    resolveAuthorGithubUserId?: (
      devicePubkeyBase64: string,
    ) => number | null | Promise<number | null>;
    sql?: postgres.Sql;
    nowMs?: number;
    /** Per-author bound override, threaded to {@link queueIntegrationRequest}. */
    cap?: number;
  },
): Promise<GatedHeads> {
  const out: GatedHeads = { integrate: [], queued: [], errors: [] };
  let ratified: Set<string>;
  try {
    // WI-1552 fix (1): a targeted membership check for exactly these heads,
    // not a top-500-newest window (see listRatifiedStates doc).
    ratified = await listRatifiedStates(
      { workspaceId: opts.workspaceId, potSlug: opts.potSlug, repoKey: opts.repoKey },
      opts.heads
        .filter((h) => h.sha)
        .map((h) => ({ devicePubkey: h.devicePubkeyBase64, headSha: h.sha })),
      opts.sql,
    );
  } catch (e) {
    // Can't read the ratified set → NOTHING below steer integrates this pass
    // (fail-closed), but steer-tier heads still can.
    ratified = new Set();
    out.errors.push({
      devicePubkeyBase64: '*',
      sha: '*',
      error: `ratified-set read failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  for (const head of opts.heads) {
    if (!head.sha) continue;
    try {
      const tier = await opts.resolveTier(head.devicePubkeyBase64);
      if (tier && commsTierAtLeast(tier, AUTO_INTEGRATE_TIER)) {
        out.integrate.push({ deviceHex: deviceNamespaceKey(head.devicePubkeyBase64), sha: head.sha });
        continue;
      }
      if (ratified.has(`${head.devicePubkeyBase64}\n${head.sha}`)) {
        out.integrate.push({ deviceHex: deviceNamespaceKey(head.devicePubkeyBase64), sha: head.sha });
        continue;
      }
      const authorGithubUserId = opts.resolveAuthorGithubUserId
        ? await opts.resolveAuthorGithubUserId(head.devicePubkeyBase64)
        : null;
      await queueIntegrationRequest(
        {
          workspaceId: opts.workspaceId,
          potSlug: opts.potSlug,
          repoKey: opts.repoKey,
          devicePubkey: head.devicePubkeyBase64,
          headSha: head.sha,
          authorGithubUserId,
          nowMs: opts.nowMs,
          cap: opts.cap,
        },
        opts.sql,
      );
      out.queued.push(head);
    } catch (e) {
      // Fail CLOSED: an errored head neither integrates nor claims to be queued.
      out.errors.push({
        devicePubkeyBase64: head.devicePubkeyBase64,
        sha: head.sha,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}
