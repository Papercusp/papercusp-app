/**
 * POST /api/admin/substrate/revoke-contributor
 *
 * Plan: non-collaborator-join-fork-pr-2026-06-02 D-001 (supersedes the old
 * substrate-revocation-v2 branch-delete design) + shared-hive-federation-2026-06-08
 * P-006 (the Hive-scope generalization).
 *
 * OWNER action: revoke a bad-actor contributor by adding their device pubkeys to a
 * revocation set (the owner's own row's `revoked_pubkeys`, which federates and is
 * honored by every peer's `read-admission` union). The contributor is dropped from
 * live federation on the next admission re-verify. (The old branch-delete is a
 * no-op in the write-free model — admission is gated on the attestation gist.)
 *
 * Two scopes (exactly one of `harnessSlug` / `potSlug`):
 *   - `harnessSlug` — revoke from ONE shared harness. Authority = repo-admin token.
 *   - `potSlug`    — revoke from the WHOLE Hive's federation at once (P-006).
 *                     Authority = the Swarm that holds the Hive private key.
 *
 * Auth: `{ trust: ['verified', 'trusted'] }` — same gate as the sibling admin
 * substrate endpoints. Admin-only.
 *
 * Core logic is `handleRevokeContributor(input, deps)` (deps injected) so it's
 * unit-testable without a live GitHub / substrate / Hive key.
 *
 * Status-code mapping:
 *   ok:true                          → 200 (revokedPubkeys + live)
 *   harness: not_admin               → 403 · no_context → 404 · no_target → 404
 *            github_error            → 502 · revoke_failed → 500
 *   hive:    not_owner               → 403 · no_owner_identity → 400 · no_owner_row → 404
 *            no_target               → 404 · bad_target → 400 · revoke_failed → 500
 *   bad input                        → 400
 */

import { defineTool } from '@papercusp/agent-mcp';
import {
  revokeContributorViaGithub,
  type RevokeContributorSeams,
} from '../../../sync/hyperbee/revoke-contributor';
import {
  revokeHiveContributor,
  type RevokeHiveContributorResult,
} from '../../../hive-revoke-contributor';

// ─── injectable core ──────────────────────────────────────────────────────────

export interface RevokeContributorEndpointInput {
  workspaceId: string;
  /** Harness scope (provide exactly one of harnessSlug / potSlug). */
  harnessSlug?: string;
  /** Hive scope — revoke from the whole Hive's federation (P-006). */
  potSlug?: string;
  githubUserId: number;
}

export interface RevokeContributorEndpointDeps {
  revoke: (
    input: { workspaceId: string; harnessSlug: string; githubUserId: number },
    seams?: RevokeContributorSeams,
  ) => ReturnType<typeof revokeContributorViaGithub>;
  /** Hive-scope revoke (P-006). Defaults to the real `revokeHiveContributor`. */
  revokeHive?: (input: {
    workspaceId: string;
    potHomeSlug: string;
    githubUserId: number;
  }) => ReturnType<typeof revokeHiveContributor>;
}

const realDeps: RevokeContributorEndpointDeps = {
  revoke: (input) => revokeContributorViaGithub(input),
  revokeHive: (input) => revokeHiveContributor(input),
};

function parseBody(body: unknown): RevokeContributorEndpointInput | { error: string } {
  if (body === null || typeof body !== 'object') {
    return { error: 'request body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  const workspaceId = typeof b.workspaceId === 'string' ? b.workspaceId.trim() : '';
  const harnessSlug = typeof b.harnessSlug === 'string' ? b.harnessSlug.trim() : '';
  const potSlug = typeof b.potSlug === 'string' ? b.potSlug.trim() : '';

  if (!workspaceId) return { error: 'workspaceId is required and must be a non-empty string' };
  if (!!harnessSlug === !!potSlug) {
    return { error: 'provide exactly one of harnessSlug (harness scope) or potSlug (Hive scope)' };
  }

  // githubUserId must be a positive integer.
  const rawId = b.githubUserId;
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) {
    return {
      error:
        'githubUserId is required and must be a positive integer (the numeric GitHub user id, not the login)',
    };
  }

  return potSlug
    ? { workspaceId, potSlug, githubUserId: rawId }
    : { workspaceId, harnessSlug, githubUserId: rawId };
}

/** Map a Hive-scope revoke result to its HTTP response (P-006). */
function hiveResponse(result: RevokeHiveContributorResult): Response {
  if (result.ok) return Response.json(result);
  switch (result.code) {
    case 'not_owner':
      return Response.json(
        {
          error:
            'Only the Swarm that holds the Hive private key may revoke a contributor Hive-wide',
          code: result.code,
        },
        { status: 403 },
      );
    case 'no_owner_identity':
      return Response.json(
        {
          error: 'Could not resolve the local owner GitHub identity (gh not authenticated)',
          code: result.code,
        },
        { status: 400 },
      );
    case 'no_owner_row':
      return Response.json(
        {
          error: 'The owner has no hive_members row — join the Hive before revoking',
          code: result.code,
          detail: result.detail,
        },
        { status: 404 },
      );
    case 'no_target':
      return Response.json(
        {
          error:
            'The target contributor has no known device pubkeys in this Hive — nothing to revoke',
          code: result.code,
        },
        { status: 404 },
      );
    case 'bad_target':
      return Response.json(
        { error: 'githubUserId must be a positive integer', code: result.code, detail: result.detail },
        { status: 400 },
      );
    case 'revoke_failed':
      return Response.json(
        {
          error: 'Failed to publish the Hive revocation to the substrate',
          code: result.code,
          detail: result.detail,
        },
        { status: 500 },
      );
    default:
      // All six failure codes are handled above; `RevokeHiveContributorResult`'s
      // failure is a single object with a union `code` (not a discriminated union),
      // so no `never`-exhaustiveness guard applies — return a defensive 500.
      return Response.json(
        { error: 'unexpected Hive revoke error', code: result.code, detail: result.detail },
        { status: 500 },
      );
  }
}

export async function handleRevokeContributor(
  input: RevokeContributorEndpointInput,
  deps: RevokeContributorEndpointDeps = realDeps,
): Promise<Response> {
  // ── Hive scope (P-006) ──
  if (input.potSlug) {
    const revokeHive = deps.revokeHive ?? realDeps.revokeHive!;
    return hiveResponse(
      await revokeHive({
        workspaceId: input.workspaceId,
        potHomeSlug: input.potSlug,
        githubUserId: input.githubUserId,
      }),
    );
  }

  // ── Harness scope (unchanged) ──
  const result = await deps.revoke({
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug!,
    githubUserId: input.githubUserId,
  });

  if (result.ok) {
    return Response.json(result);
  }

  switch (result.code) {
    case 'not_admin':
      return Response.json(
        {
          error:
            'The authenticated GitHub token does not have admin permissions on the shared repo — only repo admins may revoke another contributor',
          code: result.code,
        },
        { status: 403 },
      );
    case 'no_context':
      return Response.json(
        {
          error:
            'No shared repo context found — the harness may not be shared, or gh is not authenticated (`gh auth login`)',
          code: result.code,
        },
        { status: 404 },
      );
    case 'no_target':
      return Response.json(
        {
          error:
            'The target contributor has no known device pubkeys (no contributor row, or never federated) — nothing to revoke',
          code: result.code,
        },
        { status: 404 },
      );
    case 'github_error':
      return Response.json(
        {
          error: 'GitHub API returned an unexpected error',
          code: result.code,
          detail: result.detail,
        },
        { status: 502 },
      );
    case 'revoke_failed':
      return Response.json(
        {
          error: 'Failed to publish the revocation to the substrate',
          code: result.code,
          detail: result.detail,
        },
        { status: 500 },
      );
    default: {
      // TypeScript exhaustiveness guard.
      const _never: never = result;
      return Response.json({ error: 'unexpected error', detail: String(_never) }, { status: 500 });
    }
  }
}

// ─── endpoint ─────────────────────────────────────────────────────────────────

const post = defineTool({
  method: 'POST',
  path: '/admin/substrate/revoke-contributor',
  // Admin-only: same trust gate as the self-revoke and dogfood-substrate-health
  // endpoints (per D-005 decision).
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    const body = await req.json().catch(() => null);
    const parsed = parseBody(body);
    if ('error' in parsed) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    return handleRevokeContributor(parsed);
  },
});

export default [post];
