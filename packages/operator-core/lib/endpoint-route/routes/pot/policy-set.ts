/**
 * POST /api/pot/:id/policy — author the owner-signed Hive policy
 * (shared-hive-owner-enforcement-2026-06-19 EN-1, build step 4).
 *
 * GATE (the authoring authority, brief EN-1): ONLY when the Hive's binding is
 * `claim_status === 'claimed'` AND the local viewer's GitHub id is in
 * `claimed_by_github_user_ids`. An UNCLAIMED Hive returns 403 — a provisional owner
 * can't lock it down (the claim is what grants authority). The gate reuses the
 * `shared_repo_binding_cache` row (the same source as the claim-status route) +
 * `resolveLocalGithubIdentity` for the viewer.
 *
 * After the gate, {@link authorHivePolicy} signs the policy with the Hive private key
 * and writes it (it then federates to members, who verify the signature). A claimed
 * viewer on a Swarm that does NOT hold the Hive key gets 409 `not_owner_swarm` —
 * correct: only the canonical owner Swarm can produce the authoritative signed policy.
 *
 * Body: { policy: HivePolicy } (an OPEN record; unknown keys are preserved + signed).
 * The core (`runSetPolicy`) takes injected deps so the gate + author are unit-testable
 * without GitHub / PG / the keychain.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { resolveHiveWorkspaceId } from '../../../hive-store';
import { loadHivePubkey } from '../../../identity/hive-keypair';
import { deriveHiveFederationTopic, topicAsHex } from '../../../sync/hyperbee/derive-swarm-topic';
import { resolveLocalGithubIdentity } from '../../../identity/resolve-local-github-identity';
import { authorHivePolicy, type AuthorHivePolicyResult } from '../../../hive-policy-author';
import { getHivePolicy, type ResolvedHivePolicy } from '../../../hive-policy-store';
import { coerceHivePolicyInput } from '../../../hive-policy-schema';
import type { BindingClaimStatus } from '../../../harness/binding-types';

/** The claim-gate inputs resolved from the binding cache. */
export interface ClaimGateRow {
  claimStatus: BindingClaimStatus;
  claimedGithubUserIds: number[];
}

export type SetPolicyResult =
  | { status: 200; body: { ok: true; policy: ResolvedHivePolicy } }
  | { status: 400 | 401 | 403 | 409 | 500; body: { ok: false; error: string; detail?: string } };

export interface SetPolicyDeps {
  /** Resolve the local viewer's GitHub user id (null when gh-auth is missing). */
  viewerGithubId: () => Promise<number | null>;
  /** Read the Hive's binding claim row (null when there is no binding). */
  readClaimGate: (workspaceId: string, potHomeSlug: string) => Promise<ClaimGateRow | null>;
  /** Sign + write the policy on the owner Swarm. */
  author: (input: {
    workspaceId: string;
    potHomeSlug: string;
    policy: import('../../../hive-policy-schema').HivePolicy;
  }) => Promise<AuthorHivePolicyResult>;
}

/**
 * The gate + author core. Returns a typed {status, body} so the handler just serializes
 * it. The GATE is the brief's authority rule; the AUTHOR is the keypair-ownership half.
 */
export async function runSetPolicy(
  workspaceId: string,
  potHomeSlug: string,
  rawBody: unknown,
  deps: SetPolicyDeps,
): Promise<SetPolicyResult> {
  // 1. Body shape.
  const bodyObj = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : null;
  if (!bodyObj || !('policy' in bodyObj)) {
    return { status: 400, body: { ok: false, error: 'body must be { policy: {...} }' } };
  }
  const coerced = coerceHivePolicyInput(bodyObj.policy);
  if (!coerced.ok) {
    return { status: 400, body: { ok: false, error: coerced.error } };
  }

  // 2. CLAIM GATE — viewer must be a claimant of a claimed Hive.
  const viewer = await deps.viewerGithubId();
  if (viewer == null) {
    return { status: 401, body: { ok: false, error: 'gh_auth_required' } };
  }
  const gate = await deps.readClaimGate(workspaceId, potHomeSlug);
  if (!gate || gate.claimStatus !== 'claimed') {
    // An unclaimed (or absent-binding) Hive has NO enforceable policy — the
    // provisional owner can't lock it down. (brief EN-1: unclaimed ⇒ 403.)
    return { status: 403, body: { ok: false, error: 'hive_unclaimed' } };
  }
  if (!gate.claimedGithubUserIds.includes(viewer)) {
    return { status: 403, body: { ok: false, error: 'not_a_claimant' } };
  }

  // 3. AUTHOR — sign with the Hive key (owner Swarm only) + write (federates).
  const result = await deps.author({ workspaceId, potHomeSlug, policy: coerced.policy });
  if (result.ok) {
    return { status: 200, body: { ok: true, policy: result.policy } };
  }
  switch (result.code) {
    case 'not_owner_swarm':
      return { status: 409, body: { ok: false, error: result.code, detail: result.detail } };
    case 'no_owner_pubkey':
      return { status: 409, body: { ok: false, error: result.code, detail: result.detail } };
    default:
      return { status: 500, body: { ok: false, error: result.code, detail: result.detail } };
  }
}

/** Postgres BIGINT[] arrives as number[], string[], or a `{1,2}` literal. */
export function parseIdArray(raw: unknown): number[] {
  if (raw == null) return [];
  let arr: unknown[];
  if (Array.isArray(raw)) arr = raw;
  else {
    const s = String(raw).trim();
    if (!s || s === '{}' || s === '[]') return [];
    if (s.startsWith('{') && s.endsWith('}')) arr = s.slice(1, -1).split(',');
    else {
      try {
        const v = JSON.parse(s);
        arr = Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    }
  }
  return arr
    .map((v) => (typeof v === 'number' ? v : Number.parseInt(String(v).trim(), 10)))
    .filter((n) => Number.isInteger(n) && n > 0);
}

async function realViewerGithubId(): Promise<number | null> {
  try {
    const id = await resolveLocalGithubIdentity();
    return id.kind === 'ok' ? id.githubUserId : null;
  } catch {
    return null;
  }
}

async function queryBindingBySlug(workspaceId: string, slug: string): Promise<ClaimGateRow | null> {
  const { sql } = getOrgPg();
  try {
    const rows = (await sql`
      SELECT claim_status, claimed_by_github_user_ids
        FROM harness_shared.shared_repo_binding_cache
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${slug}
       LIMIT 1
    `) as unknown as Array<{
      claim_status: BindingClaimStatus;
      claimed_by_github_user_ids: unknown;
    }>;
    const row = rows[0];
    if (!row) return null;
    return {
      claimStatus: row.claim_status,
      claimedGithubUserIds: parseIdArray(row.claimed_by_github_user_ids),
    };
  } catch (e: unknown) {
    // Missing binding table ⇒ treat as no binding (⇒ unclaimed ⇒ 403), never a 500.
    const msg = e instanceof Error ? e.message : String(e);
    if (/does not exist|relation .* does not exist/i.test(msg)) return null;
    throw e;
  }
}

async function queryClaimedBindingsByTopic(workspaceId: string, topicHex: string): Promise<ClaimGateRow[]> {
  const { sql } = getOrgPg();
  try {
    const rows = (await sql`
      SELECT claim_status, claimed_by_github_user_ids
        FROM harness_shared.shared_repo_binding_cache
       WHERE workspace_id = ${workspaceId}
         AND harness_topic = ${topicHex}
         AND claim_status = 'claimed'
    `) as unknown as Array<{
      claim_status: BindingClaimStatus;
      claimed_by_github_user_ids: unknown;
    }>;
    return rows.map((row) => ({
      claimStatus: row.claim_status,
      claimedGithubUserIds: parseIdArray(row.claimed_by_github_user_ids),
    }));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/does not exist|relation .* does not exist/i.test(msg)) return [];
    throw e;
  }
}

/** Injectable seams for {@link readClaimGateWithTopicFallback} (unit-testable without PG/keychain). */
export interface ClaimGateReadSeams {
  querySlugRow?: (workspaceId: string, slug: string) => Promise<ClaimGateRow | null>;
  queryClaimedTopicRows?: (workspaceId: string, topicHex: string) => Promise<ClaimGateRow[]>;
  loadPubkey?: (workspaceId: string, potHomeSlug: string) => Promise<string | null>;
}

/**
 * WI-1918 (P-009): the binding-cache rows of a from-repo Hive are keyed by
 * MEMBER slug — `hive-publish-from-repo` step 6 passes `m.slug`, one row per
 * member repo, keyed (workspace, provider, github_repository_id) — so the hive
 * HOME slug never has a row (it is not repo-bound), and the slug-only lookup
 * made this gate return `hive_unclaimed` FOREVER for that hive class, even
 * after a legitimate `claimBinding`. The member rows DO carry
 * `harness_topic` = the hive federation topic (derived from the hive pubkey),
 * so when the direct slug lookup misses: resolve the hive's pubkey (the same
 * loader the author step uses — only the owner Swarm holds it), derive its
 * topic, and accept CLAIMED member bindings on that topic as the hive's claim
 * gate (claimants = union across claimed rows). A claimant proved GitHub
 * authority over a repo OF this hive — the EN-1 authority intent.
 */
export async function readClaimGateWithTopicFallback(
  workspaceId: string,
  potHomeSlug: string,
  seams: ClaimGateReadSeams = {},
): Promise<ClaimGateRow | null> {
  const {
    querySlugRow = queryBindingBySlug,
    queryClaimedTopicRows = queryClaimedBindingsByTopic,
    loadPubkey = loadHivePubkey,
  } = seams;
  const direct = await querySlugRow(workspaceId, potHomeSlug);
  if (direct) return direct;
  const pubkey = await loadPubkey(workspaceId, potHomeSlug).catch(() => null);
  if (!pubkey) return null; // not the owner Swarm / unknown hive — keep 403 semantics
  const topicHex = topicAsHex(deriveHiveFederationTopic(pubkey));
  const rows = await queryClaimedTopicRows(workspaceId, topicHex);
  if (rows.length === 0) return null;
  const ids = new Set<number>();
  for (const r of rows) for (const id of r.claimedGithubUserIds) ids.add(id);
  return { claimStatus: 'claimed', claimedGithubUserIds: [...ids] };
}

async function realReadClaimGate(workspaceId: string, potHomeSlug: string): Promise<ClaimGateRow | null> {
  return readClaimGateWithTopicFallback(workspaceId, potHomeSlug);
}

const realDeps: SetPolicyDeps = {
  viewerGithubId: realViewerGithubId,
  readClaimGate: realReadClaimGate,
  author: authorHivePolicy,
};

const post = defineTool({
  method: 'POST',
  path: '/pot/:id/policy',
  auth: 'loopback',
  async handler(req, ctx) {
    const potHomeSlug = ctx.params.id as string;
    // WI-5321/WI-5061: resolve the caller's ambient workspaceId to whatever the
    // Hive's row + keypair are ACTUALLY stamped with (fast path: unchanged when
    // they already match) — same ambient-'default' family as authorHivePolicy's
    // own gate; without this, the claim gate below (and the keypair lookup it
    // falls back to) looks up a workspace-partition the Hive was never minted
    // under and returns hive_unclaimed even for a genuinely claimed, owner-held Hive.
    const workspaceId = await resolveHiveWorkspaceId(activeWorkspaceId(), potHomeSlug);
    const body = await req.json().catch(() => null);
    const result = await runSetPolicy(workspaceId, potHomeSlug, body, realDeps);
    return Response.json(result.body, { status: result.status });
  },
});

const get = defineTool({
  method: 'GET',
  path: '/pot/:id/policy',
  auth: 'public',
  async handler(_req, ctx) {
    const potHomeSlug = ctx.params.id as string;
    // WI-5321/WI-5061: same ambient-workspace resolution as the POST handler above —
    // a read under the ambient (wrong) partition would silently return { policy: null }
    // (permissive) instead of the Hive's real signed policy.
    const workspaceId = await resolveHiveWorkspaceId(activeWorkspaceId(), potHomeSlug);
    try {
      const policy = await getHivePolicy(workspaceId, potHomeSlug);
      // null ⇒ no policy set (permissive). Return a stable shape for the GUI.
      return Response.json({ ok: true, policy });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/does not exist|relation .* does not exist/i.test(msg)) {
        return Response.json({ ok: true, policy: null });
      }
      throw e;
    }
  },
});

export default [post, get];
