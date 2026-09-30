/**
 * activity:tool-log — the bare tool-call log surface
 * (deterministic-context-carry-2026-07-14 P-013).
 *
 * A DETERMINISTIC compact render of a session's tool ledger: one ~10–15-token
 * line per call (normalized name + primary target + ✓/✗), consecutive runs
 * collapsed, and over-budget history decayed to per-tool counts + a top-K
 * touched-set (errors out-age successes). The token-cheap answer to "what did
 * this session actually DO" — for a successor after compaction, a fleet peer,
 * or the Phase-4 carry-doc builder (which consumes the same lib in-process).
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { isSessionShapedOwnerId } from '../coordination/dead-session-recipient-guidance';
import { knownOwnerIdSet, resolveRecipientsAgainst } from '../coordination/recipient-resolve';
import { toolCallRowsFor } from '../../tool-call-log-store';
import { dedupeToolCalls, renderToolCallLog } from '../../tool-call-log';

/**
 * The activity ledger stores `created_at` as timestamptz. Keep these public
 * boundaries explicit and canonical so a relative duration such as `-15 min`
 * cannot reach PostgreSQL and fail as a structural handler error.
 */
const isoBoundary = z
  .string()
  .datetime({ offset: true })
  .describe('Absolute ISO 8601 timestamp (for example, 2026-08-12T18:00:00Z); relative durations are not supported.');

function normalizeIsoBoundary(value: string | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

// EI-23219101783641313: the handler returns a structured `data` root, so publish
// that shape for MCP/code:run discovery instead of leaving `returns` null. Without
// this contract, callers reasonably guessed the outer content envelope and then
// hit the structured_result_shape guard on their first call.
const ACTIVITY_TOOL_LOG_RESULT_SCHEMA = z.object({
  ok: z.boolean(),
  calls: z.number().int().nonnegative(),
  rawRows: z.number().int().nonnegative(),
  span: z
    .object({
      from: z.string().nullable(),
      to: z.string().nullable(),
    })
    .nullable(),
  log: z.string(),
});

type OwnerResolutionFailure = {
  ok: false;
  error: 'owner_resolution_unavailable' | 'owner_not_found' | 'owner_ambiguous';
  owner: string;
  matches?: string[];
  message: string;
};

type OwnerResolution = { ok: true; ownerId: string } | OwnerResolutionFailure;

/**
 * Resolve the display handle accepted by the activity reader to the canonical
 * owner id used by the ledger. Full session-shaped ids are intentionally kept
 * verbatim: unlike a live recipient, a historical activity owner may already
 * be absent from the current roster.
 */
async function resolveActivityOwner(
  owner: string,
  workspaceId?: string | null,
): Promise<OwnerResolution> {
  if (isSessionShapedOwnerId(owner)) return { ok: true, ownerId: owner };

  const known = await knownOwnerIdSet(workspaceId);
  if (!known) {
    return {
      ok: false,
      error: 'owner_resolution_unavailable',
      owner,
      message:
        `Cannot resolve owner '${owner}' because the live owner roster is unavailable. ` +
        'Retry with the full ownerId or after coord:presence is available.',
    };
  }

  const resolution = resolveRecipientsAgainst([owner], [...known]);
  const ambiguous = resolution.ambiguous[0];
  if (ambiguous) {
    return {
      ok: false,
      error: 'owner_ambiguous',
      owner,
      matches: ambiguous.matches,
      message: `Owner '${owner}' matches more than one live ownerId; pass the full ownerId.`,
    };
  }
  if (resolution.unknown.length > 0 || resolution.resolved.length === 0) {
    return {
      ok: false,
      error: 'owner_not_found',
      owner,
      message: `Owner '${owner}' matches no known ownerId; pass the full ownerId or check coord:presence.`,
    };
  }
  return { ok: true, ownerId: resolution.resolved[0]! };
}

function ownerResolutionError(failure: OwnerResolutionFailure) {
  return {
    isError: true as const,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          error: failure.error,
          owner: failure.owner,
          ...(failure.matches ? { matches: failure.matches } : {}),
          message: failure.message,
        }),
      },
    ],
  };
}

export default defineTool({
  name: 'activity:tool-log',
  profile: 'engineer',
  description:
    "Compact deterministic tool-call log for a session or owner: one short line per call (tool + primary target + ✓/✗), consecutive same-tool runs collapsed ×N, over-budget history decayed to per-tool counts + top-K touched files/commands (error lines survive longest). Rendered from the same ledger activity:recent reads, at a fraction of the tokens — the post-compaction / peer-catch-up view of what a session actually did.",
  capability: 'activity:read',
  guidance: {
    when: "You want the cheap chronological picture of what a session DID (yours pre-compaction, or a peer's) — not the full row stream. Pass owner:'self' for your own trail; use absolute ISO 8601 timestamps for since/until to window it (relative durations such as '-15 min' are not supported).",
    notWhen: 'For raw rows with detail payloads use `activity:recent`; for the agent-authored turn notes use `journal:recent`.',
    seeAlso: ['activity:recent (raw ledger rows)', 'journal:recent (per-turn journal notes)'],
    // EI-21837773431817305 — the mirror image of activity:recent's redirects, filed by a
    // caller who was forced into a broader owner-scoped retry. The two tools read the
    // same ledger with OPPOSITE vocabularies (`limit`/`since_id` there,
    // `max_lines`/`top_k` + `since`/`until` here) while deliberately sharing the spelling
    // of `session_id`, so the divergence is genuinely hard to predict from either side.
    argRedirects: {
      limit:
        'max_lines — this tool budgets ITEMIZED LINES rather than rows (default 40, 5-200), and older successes decay out first, so it is a display budget and not a row count. RENAME the key rather than dropping it, or you silently get the default 40 lines. `limit` is the spelling used by the sibling raw-row read, activity:recent. Use `top_k` to size the touched-set on the decay line.',
      // EI-21149038705756492 — filed alongside `limit` by the SAME rejection: a cold-wake
      // monitor arrived with the remembered `ownerId` + `limit` pair and got one bare
      // unrecognized-key list naming neither remedy. `limit` above was repaired and this
      // half was not, which is why the filing stayed open against a tool that looked fixed.
      // Pure rename, unlike `limit`: the scope is identical, only the spelling differs.
      ownerId:
        "owner — same scope, different spelling. This tool's key is `owner`, and it takes the literal 'self' to resolve you, a full coordination ownerId, or a unique prefix matched against the live roster (an unknown or ambiguous prefix is refused BY NAME rather than silently returning an empty log). RENAME the key; dropping it instead leaves the call unscoped, which is refused with scope_required unless you pass `session_id`. `ownerId` is the spelling coord and presence surfaces use, which is why callers arrive holding it.",
      // OBJECT form deliberately, not a plain string. The remedy here is "there is no
      // such filter — go to the sibling", and the renderer has exactly two shapes: a
      // local relocation, or "`tool` is not an arg of this tool — it is written by
      // <target>". A prose string containing its own em-dash would be split by
      // splitLocalSchemaTarget, fail the path regex, and render as
      // "…it is written by DROP the key. …" — the D-004 misattribution, reintroduced.
      // Naming the sibling call makes that same sentence read correctly.
      tool: {
        tool: 'activity:recent',
        args: { kind: 'tool', owner: '<owner>' },
        note: 'activity:tool-log has NO per-tool filter: it returns ONE chronological, decayed digest of what a session did (older successes decay out first), so narrowing to a single tool name is not a view it can produce. activity:recent { kind: \'tool\' } returns the raw ledger rows with their detail payloads, which you can filter yourself.',
      },
    },
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  rolesQuota: { operator: { perRun: 60 } },
  result: ACTIVITY_TOOL_LOG_RESULT_SCHEMA,
  args: z.object({
    /** Scope to one owner (coordination id); the literal 'self' resolves you. */
    owner: z.string().min(1).max(256).optional(),
    /** Scope to one native session id. */
    session_id: z.string().min(1).max(256).optional(),
    /** Only calls strictly after this absolute ISO timestamp. Relative durations are not supported. */
    since: isoBoundary.optional(),
    /** Only calls at or before this absolute ISO timestamp. Relative durations are not supported. */
    until: isoBoundary.optional(),
    /** Itemized-line budget; older successes decay first (default 40). */
    max_lines: z.number().int().min(5).max(200).optional(),
    /** Touched-set size on the decay line (default 8). */
    top_k: z.number().int().min(1).max(25).optional(),
  }),
  async handler(args, ctx) {
    const identity = args.owner ? resolveAgentIdentity(ctx) : null;
    const requestedOwnerId = args.owner === 'self' ? identity!.ownerId : args.owner;
    let ownerId = requestedOwnerId;
    if (requestedOwnerId) {
      const resolved = await resolveActivityOwner(requestedOwnerId, identity?.workspaceId);
      if (!resolved.ok) return ownerResolutionError(resolved);
      ownerId = resolved.ownerId;
    }
    if (!ownerId && !args.session_id) {
      return {
        isError: true,
        content: [{ type: 'text', text: "scope_required: pass owner (or 'self') and/or session_id." }],
      };
    }
    const rows = await toolCallRowsFor({
      ownerId: ownerId ?? undefined,
      sessionId: args.session_id,
      sinceIso: normalizeIsoBoundary(args.since),
      untilIso: normalizeIsoBoundary(args.until),
    });
    const calls = dedupeToolCalls(rows);
    const log = renderToolCallLog(rows, { maxLines: args.max_lines, topK: args.top_k });
    return {
      data: {
        ok: true,
        calls: calls.length,
        rawRows: rows.length,
        span: rows.length
          ? { from: rows[0].createdAt ?? null, to: rows[rows.length - 1].createdAt ?? null }
          : null,
        log,
      },
    };
  },
});
