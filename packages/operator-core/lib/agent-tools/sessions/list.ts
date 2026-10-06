/**
 * sessions:list — unified session enumeration across every indexed client
 * (session-search-scope-2026-07-05 P-006): claude + omp + codex + harness
 * chats in ONE list (absorbs dev:claude_session op=list / omp:sessions
 * op=list, and adds codex — which had NO reader before this).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  sessionSearchEnabled,
  disabledResult,
  SESSION_SOURCE_KINDS,
  refreshLiveSessionsBeforeRead,
  normalizeWindowBound,
} from './_shared';
import { decodeSessionCursor, encodeSessionCursor, sessionCursorFingerprint } from './cursor';
import type { PapercuspUnifiedToolContext } from '../_tool-context';
import type { Sql } from 'postgres';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'kettle'] as const;

/**
 * The row shape this query returns. Declared as an interface and used to
 * ANNOTATE the `rows` const. EI-10968: the handler below is now typed
 * `ctx: PapercuspUnifiedToolContext` (`_tool-context.ts`), which gives `ctx.tx`
 * a real `Sql` type — `ctx.tx<Array<{…}>>` genuinely binds the row shape now
 * instead of silently discarding the type argument (see the fuller note on
 * sessions/digest.ts). The const annotation stays for readability/redundant safety.
 */
interface SessionListRow {
  source_kind: string;
  session_id: string;
  turns: number;
  prompt_count: number;
  owner: string | null;
  harness_slug: string | null;
  cwd: string | null;
  first_ts: string | null;
  last_ts: string | null;
  response_count: number | null;
  tool_call_count: number | null;
  total_matching: number;
}

/**
 * The projected row the caller reads. Real (indexed) rows carry every field but
 * `active`; the synthetic live-session fallback row (EI-11403) sets `active:true`
 * so `owner:'self'` never reports a LIVE session as absent when its turns are
 * indexed under a different owner stamp — or not yet indexed at all.
 */
interface OutSession {
  source_kind: string;
  session_id: string;
  turns: number;
  prompt_count: number;
  owner: string | null;
  harness_slug: string | null;
  cwd: string | null;
  first_ts: string | null;
  last_ts: string | null;
  response_count: number | null;
  tool_call_count: number | null;
  /** Only present (and true) on the injected live-session fallback row. */
  active?: boolean;
}

interface HistoricalSessionListRow {
  source_kind: string | null;
  session_id: string | null;
  owner: string;
  first_seen_at: string | null;
  first_event_at: string | null;
  last_event_at: string | null;
  event_count: number;
  event_sources: string[] | null;
  harness_slug: string | null;
  cwd: string | null;
  fleet_slug: string | null;
  fleet_role: string | null;
  model: string | null;
  effort: string | null;
  total_matching: number;
}

interface OutHistoricalSession {
  source_kind: string | null;
  session_id: string | null;
  owner: string;
  first_seen_at: string | null;
  first_event_at: string | null;
  last_event_at: string | null;
  event_count: number;
  event_sources: string[];
  harness_slug: string | null;
  cwd: string | null;
  fleet_slug: string | null;
  fleet_role: string | null;
  model: string | null;
  effort: string | null;
}

/**
 * Read a bounded historical session census. This is intentionally a separate
 * query path from the indexed transcript list below: a historical census must
 * begin with append-only events, not with a mutable live-session roster.
 */
async function readHistoricalCensus(
  tx: Sql,
  options: {
    workspaceId: string;
    since: string;
    until: string;
    owner: string | null;
    sourceKind: string | undefined;
    cwdContains: string | undefined;
    limit: number;
    offset: number;
    fingerprint: string;
  },
) {
  const activityScopes = [...new Set([options.workspaceId, '*'])];
  const rows: HistoricalSessionListRow[] = await tx<HistoricalSessionListRow[]>`
    WITH raw_events AS (
      SELECT owner AS owner_id,
             session_id,
             source_kind,
             harness_slug,
             cwd,
             ts AS event_at,
             'session_turns'::text AS event_source
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${options.workspaceId} OR workspace_id = 'default')
         AND owner IS NOT NULL
         AND session_id IS NOT NULL
         AND ts >= ${options.since}::timestamptz
         AND ts < ${options.until}::timestamptz
      UNION ALL
      -- Keep the fallback timestamp disjoint from the indexed ts range above:
      -- wrapping both columns in COALESCE forced a full scan for bounded history.
      SELECT owner AS owner_id,
             session_id,
             source_kind,
             harness_slug,
             cwd,
             ingested_at AS event_at,
             'session_turns'::text AS event_source
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${options.workspaceId} OR workspace_id = 'default')
         AND owner IS NOT NULL
         AND session_id IS NOT NULL
         AND ts IS NULL
         AND ingested_at >= ${options.since}::timestamptz
         AND ingested_at < ${options.until}::timestamptz
      UNION ALL
      SELECT owner_id,
             session_id,
             agent AS source_kind,
             harness_slug,
             cwd,
             created_at AS event_at,
             'agent_activity'::text AS event_source
        FROM harness_shared.agent_activity
       WHERE workspace_id = ANY(${activityScopes}::text[])
         AND owner_id IS NOT NULL
         AND created_at >= ${options.since}::timestamptz
         AND created_at < ${options.until}::timestamptz
      UNION ALL
      SELECT coord_owner_id AS owner_id,
             NULL::text AS session_id,
             NULL::text AS source_kind,
             harness_slug,
             NULL::text AS cwd,
             invoked_at AS event_at,
             'tool_invocations'::text AS event_source
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ANY(${activityScopes}::text[])
         AND coord_owner_id IS NOT NULL
         AND invoked_at >= ${options.since}::timestamptz
         AND invoked_at < ${options.until}::timestamptz
    ),
    -- Each source event can repeat the same owner/session key many times.
    -- Resolve the immutable session evidence once per distinct key, then join
    -- it back to the event stream. Keeping this CTE materialized prevents the
    -- planner from pulling the lateral lookup back below the deduplication.
    session_map AS MATERIALIZED (
      SELECT k.owner_id,
             k.session_id AS raw_session_id,
             a.session_id AS adv_session_id,
             a.agent AS adv_agent,
             a.first_seen_at AS adv_first_seen_at,
             a.launch_spec AS adv_launch_spec,
             a.harness_slug AS adv_harness_slug,
             a.cwd AS adv_cwd
        FROM (
          SELECT DISTINCT owner_id, session_id
            FROM raw_events
        ) k
        LEFT JOIN LATERAL (
          SELECT session_id, agent, first_seen_at, launch_spec,
                 launch_spec->>'harnessSlug' AS harness_slug,
                 cwd
            FROM harness_shared.adv_sessions
           WHERE coord_owner_id = k.owner_id
             AND (k.session_id IS NULL OR session_id = k.session_id)
           ORDER BY CASE WHEN k.session_id IS NOT NULL AND session_id = k.session_id THEN 0 ELSE 1 END,
                    first_seen_at ASC NULLS LAST,
                    id ASC
           LIMIT 1
        ) a ON true
    ),
    enriched_events AS (
      SELECT e.*,
             a.adv_session_id,
             a.adv_agent,
             a.adv_first_seen_at,
             a.adv_launch_spec,
             a.adv_harness_slug,
             a.adv_cwd
        FROM raw_events e
        LEFT JOIN session_map a
          ON a.owner_id = e.owner_id
         AND a.raw_session_id IS NOT DISTINCT FROM e.session_id
    ),
    event_groups AS (
      SELECT owner_id AS owner,
             COALESCE(session_id, adv_session_id) AS session_id,
             COALESCE(max(adv_agent), max(source_kind), 'unknown') AS source_kind,
             min(adv_first_seen_at) AS first_seen_at,
             min(event_at) AS first_event_at,
             max(event_at) AS last_event_at,
             count(*)::int AS event_count,
             array_agg(DISTINCT event_source ORDER BY event_source) AS event_sources,
             COALESCE(max(adv_harness_slug), max(harness_slug)) AS harness_slug,
             COALESCE(max(adv_cwd), max(cwd)) AS cwd,
             max(adv_launch_spec->>'model') AS model,
             max(adv_launch_spec->>'effort') AS effort
        FROM enriched_events
       GROUP BY owner_id, COALESCE(session_id, adv_session_id)
    ),
    membership_as_of_window AS (
      SELECT DISTINCT ON (owner_id)
             owner_id,
             fleet_slug,
             fleet_role
        FROM harness_shared.fleet_membership_events
       WHERE workspace_id = ${options.workspaceId}
         AND at < ${options.until}::timestamptz
       ORDER BY owner_id, id DESC
    )
    SELECT e.source_kind,
           e.session_id,
           e.owner,
           to_json(e.first_seen_at) #>> '{}' AS first_seen_at,
           to_json(e.first_event_at) #>> '{}' AS first_event_at,
           to_json(e.last_event_at) #>> '{}' AS last_event_at,
           e.event_count,
           e.event_sources,
           e.harness_slug,
           e.cwd,
           m.fleet_slug,
           m.fleet_role,
           e.model,
           e.effort,
           count(*) OVER ()::int AS total_matching
      FROM event_groups e
      LEFT JOIN membership_as_of_window m ON m.owner_id = e.owner
     WHERE (${options.owner}::text IS NULL OR e.owner = ${options.owner})
       AND (${options.sourceKind ?? null}::text IS NULL OR e.source_kind = ${options.sourceKind ?? null})
       AND (${options.cwdContains ?? null}::text IS NULL OR e.cwd ILIKE '%' || ${options.cwdContains ?? null} || '%')
     ORDER BY e.last_event_at DESC NULLS LAST, e.owner, e.session_id NULLS LAST
     LIMIT ${options.limit + 1}
    OFFSET ${options.offset}
  `;

  const total = rows[0]?.total_matching ?? options.offset;
  const sessions: OutHistoricalSession[] = rows.slice(0, options.limit).map((r) => ({
    source_kind: r.source_kind,
    session_id: r.session_id,
    owner: r.owner,
    first_seen_at: r.first_seen_at,
    first_event_at: r.first_event_at,
    last_event_at: r.last_event_at,
    event_count: r.event_count,
    event_sources: r.event_sources ?? [],
    harness_slug: r.harness_slug,
    cwd: r.cwd,
    fleet_slug: r.fleet_slug,
    fleet_role: r.fleet_role,
    model: r.model,
    effort: r.effort,
  }));
  const hasMore = total > options.offset + sessions.length;
  const nextCursor = hasMore
    ? encodeSessionCursor('sessions:list', options.offset + sessions.length, options.fingerprint, { until: options.until })
    : undefined;

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ok: true,
        mode: 'historical',
        count: sessions.length,
        total,
        hasMore,
        window: { since: options.since, until: options.until },
        ...(nextCursor ? { nextCursor } : {}),
        ...(hasMore
          ? {
              truncated: `Showing ${sessions.length} historical sessions at offset ${options.offset} of ${total} (newest event first). Continue with nextCursor or narrow with owner / source_kind / cwd_contains.`,
            }
          : {}),
        note:
          'Historical census rows are selected from the UNION of bounded session_turns, agent_activity, and tool_invocations events. ' +
          'adv_sessions.first_seen_at, launch_spec, and the append-only fleet_membership_events ledger provide session birth, model, and as-of membership evidence. ' +
          'The census does not use mutable adv_sessions.started_at or current coord presence as historical evidence.',
        sessions,
      }),
    }],
  };
}

export default defineTool({
  name: 'sessions:list',
  needsWorkspaceTx: true,
  crossWorkspace: true,
  capability: 'search:read',
  description:
    'List indexed agent sessions across ALL clients (claude/omp/codex/harness chats) — newest first, with size/effort counts, owner, cwd, and time range. Filter by owner (self), source_kind, cwd substring, or time; continue a bounded result with nextCursor. ' +
    'Ended/dead sessions are ALREADY included (rows are indexed transcripts, not live presence) — there is no includeEnded arg. ' +
    'Pass mode:"historical" with both since and until for an explicit bounded [since, until) fleet census; it selects owners from append-only activity and maps immutable session/membership evidence. ' +
    'UNITS: `turns` counts indexed TEXT turns only — for cost/effort use prompt_count/response_count/tool_call_count (definitions under returns).',
  guidance: {
    when:
      '"What sessions has agent X had", "find my session from yesterday", or picking a session id for sessions:read. Covers the whole fleet, not one client. For a COST/EFFORT audit, compare prompt_count/response_count/tool_call_count, not turns — see description.',
    notWhen:
      'Searching CONTENT — sessions:search. Live "who is on what" — coord:presence / fleet:assignments.',
    chaining: 'session_id → sessions:read / sessions:search { session } / sessions:digest { session }.',
    // EI-10882: publish the RESPONSE shape. Arg schemas were published but return
    // shapes were not, so writing any code:run batch over this tool required calling
    // it once just to learn the field names — a guaranteed wasted round-trip per tool.
    returns:
      '{ ok, count (rows HERE), total (rows MATCHING), hasMore, nextCursor?, truncated?, note, sessions: [{ source_kind, session_id, turns, prompt_count, owner, harness_slug, cwd, first_ts, last_ts, response_count, tool_call_count, active? }] }. `active:true` (owner:\'self\', page one) marks your LIVE session surfaced even if its turns are not yet indexed under `self` (EI-11403). Timestamps are ISO-8601 with an explicit offset. Pass nextCursor back unchanged to continue the same filters. ' +
      'UNITS (EI-9970): `turns` = indexed TEXT-turn rows only (real user+assistant text; excludes tool_use/tool_result/thinking-only lines by design) — NOT a raw record count, NOT one row per model call; don\'t use it alone for cost/effort audits. Use `prompt_count` (real user prompts), `response_count` (distinct model-inference calls, deduped by request/message id — one call can span several raw lines), and `tool_call_count` (real tool invocations) instead; the latter two are null for source_kind=agent_chat (no tool-call signal in that shape).',
    seeAlso: ['sessions:search', 'sessions:read', 'sessions:digest', 'sessions:timeline'],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 100 } },
  args: z.object({
    owner: z.string().max(120).optional().describe("Filter to one agent ownerId ('self' = the caller)."),
    ownerId: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Compatibility alias for `owner`, for callers carrying the presence/roster field name; `owner` wins when both are supplied.',
      ),
    source_kind: z.enum(SESSION_SOURCE_KINDS).optional(),
    cwd_contains: z.string().max(200).optional().describe('Substring match on the session cwd.'),
    since: z.string().max(40).optional().describe('Only sessions active after this timestamp. Accepts ISO-8601 OR a relative window measured back from now, like "45m", "12h", "7d".'),
    until: z.string().max(40).optional().describe('Historical mode upper bound (exclusive); required with mode:"historical". Accepts ISO-8601 OR a relative window like "30m", "2h".'),
    mode: z.enum(['indexed', 'historical']).optional().describe('Default indexed transcript list; historical requires explicit since + until and returns an append-only event census.'),
    historical: z.boolean().optional().describe('Compatibility alias for mode:"historical"; still requires explicit since + until.'),
    limit: z.number().int().min(1).max(100).optional().describe('Default 30.'),
    cursor: z.string().min(1).max(512).optional().describe('Opaque nextCursor from a prior sessions:list call with the same filters.'),
  }),
  result: z
    .object({
      ok: z.boolean().optional(),
      mode: z.enum(['indexed', 'historical']).optional(),
      count: z.number().int().nonnegative().optional(),
      total: z.number().int().nonnegative().optional(),
      hasMore: z.boolean().optional(),
      nextCursor: z.string().optional(),
      truncated: z.string().optional(),
      note: z.string().optional(),
      window: z.unknown().optional(),
      sessions: z.array(z.unknown()).optional(),
    })
    .passthrough(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    if (!(await sessionSearchEnabled())) return disabledResult();
    // EI-21386375248907708: normalize relative windows FIRST — the fingerprint,
    // the cursor, and every SQL bound below must see the same resolved instant.
    const sinceNorm = normalizeWindowBound(args.since, 'since');
    if (sinceNorm.error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: sinceNorm.error }) }] };
    }
    const untilNorm = normalizeWindowBound(args.until, 'until');
    if (untilNorm.error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: untilNorm.error }) }] };
    }
    args.since = sinceNorm.iso;
    args.until = untilNorm.iso;
    // Non-null: `tx` is optional on PapercuspUnifiedToolContext (must match the
    // framework's own optional `ctx.tx` for defineTool's overload resolution to
    // accept this handler — see _tool-context.ts) but is always bound for an
    // authenticated tool call. Destructured once so every ctx.tx<T> below is
    // actually typed instead of a decorative type argument on `any` (EI-10968).
    const tx = ctx.tx!;
    const workspaceId = ctx.workspaceId ?? '';
    const limit = args.limit ?? 30;
    // EI-22378241430283590: presence/roster payloads name this selector
    // `ownerId`, while the original sessions:list schema named it `owner`.
    // Normalize both spellings before fingerprinting, resolving `self`, and
    // querying so the compatibility alias is behaviorally identical to `owner`.
    const requestedOwner = args.owner ?? args.ownerId;
    const owner = requestedOwner === 'self'
      ? (resolveAgentIdentity(ctx).ownerId ?? '')
      : (requestedOwner ?? null);
    const historicalMode = args.mode === 'historical' || args.historical === true;
    const fingerprint = sessionCursorFingerprint({
      owner: requestedOwner ?? null,
      source_kind: args.source_kind ?? null,
      cwd_contains: args.cwd_contains ?? null,
      since: args.since ?? null,
      // Keep the pre-census fingerprint byte-for-byte compatible for the
      // default indexed path; only the new mode adds new cursor dimensions.
      until: historicalMode ? args.until ?? null : undefined,
      mode: historicalMode ? 'historical' : undefined,
    }, {
      workspaceId,
      selfOwnerId: args.owner === 'self' ? owner ?? undefined : undefined,
    });
    const cursor = decodeSessionCursor(args.cursor, 'sessions:list', fingerprint);
    if (!cursor.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...cursor, ok: false }) }] };
    }
    const offset = cursor.offset;

    if (historicalMode) {
      const sinceDate = args.since ? new Date(args.since) : null;
      const untilDate = args.until ? new Date(args.until) : null;
      if (!sinceDate || Number.isNaN(sinceDate.getTime()) || !untilDate || Number.isNaN(untilDate.getTime())) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: 'mode:"historical" requires valid ISO since and until bounds' }),
          }],
        };
      }
      if (sinceDate.getTime() >= untilDate.getTime()) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: 'historical since must be earlier than until' }),
          }],
        };
      }
      return readHistoricalCensus(tx, {
        workspaceId,
        since: sinceDate.toISOString(),
        until: untilDate.toISOString(),
        owner,
        sourceKind: args.source_kind,
        cwdContains: args.cwd_contains,
        limit,
        offset,
        fingerprint,
      });
    }

    // Freeze the upper time boundary on page one and carry it in every cursor.
    // Without this, a newly-ingested live turn shifts OFFSET and page two can
    // repeat page one's session (the production recurrence that reopened P-009).
    const snapshotUntil = cursor.bounds.until ?? new Date().toISOString();

    // Read-time freshness applies to every owner filter and to the bounded set
    // of open Codex sessions on an unfiltered read, not only owner:'self'.
    await refreshLiveSessionsBeforeRead(tx, owner ? [owner] : null);

    // EI-9970: `turns` (session_turns row count) and the real prompt/
    // response/tool-call counts (session_ingest_state, accumulated at
    // ingest time over EVERY raw line — a superset of session_turns'
    // TEXT-TURNS-ONLY scope) are aggregated SEPARATELY, each grouped down
    // to one row per (source_kind, session_id) BEFORE being joined — a
    // direct join of the two raw tables would fan out session_turns' rows
    // by however many session_ingest_state rows share that session_id
    // (rare but possible — a rotated/split log file) and silently inflate
    // `turns` itself, which is exactly the kind of miscount this fix
    // exists to stop reintroducing.
    // EI-10891 (timestamps): emit ISO-8601 WITH an explicit offset — to_json() on a
    // timestamptz yields e.g. 2026-07-12T00:46:02.236-04:00 — instead of Postgres'
    // bare "2026-07-12 00:46:02.236-04" text cast. `since` is parsed as UTC, so
    // returning a bare local-offset string on the way OUT made the two ends of the
    // SAME tool speak different clocks: an auditing agent compared a 00:46 row
    // against an 04:43Z cutoff and nearly reported the filter as broken (it was
    // correct — 00:46-04 IS 04:46Z). Ordering still uses the raw timestamptz, never
    // the rendered text, so a mixed-offset corpus cannot mis-sort.
    //
    // NOTE: keep backticks out of the SQL template below — it is a JS template
    // literal, and a stray backtick in a comment silently terminates the string.
    const rows: SessionListRow[] = await tx<SessionListRow[]>`
      WITH turns_agg AS (
        SELECT source_kind, session_id, count(*)::int AS turns,
               count(*) FILTER (WHERE speaker = 'user')::int AS prompt_count,
               max(owner) AS owner, max(harness_slug) AS harness_slug, max(cwd) AS cwd,
               min(ts) AS first_ts_raw, max(ts) AS last_ts_raw
          FROM harness_shared.session_turns
         WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
           AND COALESCE(ts, ingested_at) < ${snapshotUntil}::timestamptz
           AND (${owner}::text IS NULL OR owner = ${owner})
           AND (${args.source_kind ?? null}::text IS NULL OR source_kind = ${args.source_kind ?? null})
           AND (${args.cwd_contains ?? null}::text IS NULL OR cwd ILIKE '%' || ${args.cwd_contains ?? null} || '%')
           AND (${args.since ?? null}::timestamptz IS NULL OR COALESCE(ts, ingested_at) >= ${args.since ?? null}::timestamptz)
         GROUP BY source_kind, session_id
      ),
      state_agg AS (
        SELECT source_kind, session_id,
               sum(response_count)::int AS response_count,
               sum(tool_call_count)::int AS tool_call_count
          FROM harness_shared.session_ingest_state
         WHERE session_id IS NOT NULL
         GROUP BY source_kind, session_id
      )
      SELECT t.source_kind, t.session_id, t.turns, t.prompt_count,
             t.owner, t.harness_slug, t.cwd,
             -- EI-10891: ISO-8601 with an explicit offset (see the note above).
             to_json(t.first_ts_raw) #>> '{}' AS first_ts,
             to_json(t.last_ts_raw)  #>> '{}' AS last_ts,
             s.response_count, s.tool_call_count,
             -- EI-10886: the true match count BEFORE the limit. A window function is
             -- evaluated ahead of LIMIT, so this is the unbounded total in one pass.
             count(*) OVER ()::int AS total_matching
        FROM turns_agg t
        LEFT JOIN state_agg s USING (source_kind, session_id)
       ORDER BY t.last_ts_raw DESC NULLS LAST
       LIMIT ${limit + 1}
      OFFSET ${offset}
    `;

    // EI-10886: `count` used to equal `limit` on a truncated read with nothing to
    // distinguish it from an exhaustive one — a caller could not tell whether the
    // window held 100 sessions or 500, and the max limit (100) made the ambiguity
    // permanent. Report the real total and say plainly whether more remain.
    let total = rows[0]?.total_matching ?? offset;
    // Project explicitly rather than rest-spreading `total_matching` away: the
    // window-function column is a transport detail of THIS query, and an explicit
    // projection guarantees it can never leak into a row the caller reads as data.
    const sessions: OutSession[] = rows.slice(0, limit).map((r) => ({
      source_kind: r.source_kind,
      session_id: r.session_id,
      turns: r.turns,
      prompt_count: r.prompt_count,
      owner: r.owner,
      harness_slug: r.harness_slug,
      cwd: r.cwd,
      first_ts: r.first_ts,
      last_ts: r.last_ts,
      response_count: r.response_count,
      tool_call_count: r.tool_call_count,
    }));
    // Pagination advances over the OWNER-matched rows only; the synthetic
    // fallback below is prepended OUTSIDE that offset stream, so it must never
    // shift the real-row window.
    const realPageCount = sessions.length;

    // EI-11403: sessions:list { owner:'self' } returned 0 for a LIVE Codex session
    // that sessions:search { session:'self' } and sessions:timeline { owner:'self' }
    // could both read. Root cause: those two resolve the session by session_id,
    // while list filters session_turns by `owner` — and a managed-Codex-home /
    // history.jsonl live session's turns are indexed under a different owner stamp
    // (or not yet indexed at all) than the coord ownerId `self` resolves to, so the
    // owner filter misses them. Merge an explicit active-session row (the issue's
    // recommended fix) so list AGREES the session exists. Owner-INDEPENDENT counts
    // (by session_id, the same lens search/timeline use) make the row match what
    // those tools see even when the owner stamp diverges. Page one only (the row is
    // not part of the offset stream); fail-soft (the fallback is a bonus, never
    // breaks the list).
    // WI-37867 GENERALISES the EI-11403 fallback from owner:'self' to ANY named
    // owner. The HUD conversation popup resolves an ARBITRARY agent's ownerId
    // through this tool, and a session that has produced ZERO turns is absent
    // from session_turns entirely — so the popup received null, built no stream
    // URL, and rendered a silently blank window (no banner: the fetch resolved
    // rather than threw). That is precisely the moment a human opens a chat: the
    // session is newest. adv_sessions carries session_id from the instant of
    // launch, so it can answer "which session is this agent running RIGHT NOW"
    // when the transcript index structurally cannot.
    if (offset === 0 && owner) {
      try {
        const { resolveSelfSession } = await import('../../search/self-session');
        // Discovery-record lens first — it is what EI-11403 needed, because a
        // managed-Codex live session's turns can be stamped under a different
        // owner. Then the adv_sessions lens, which covers the zero-turn case the
        // discovery record cannot (and does not depend on a pty record existing).
        const self = await resolveSelfSession(owner);
        let live: { sourceKind: string; sessionId: string } | null =
          self ? { sourceKind: self.sourceKind, sessionId: self.sessionId } : null;
        if (!live) {
          // ⚠ NO workspace predicate here, deliberately — do not "restore" one.
          // session_turns.workspace_id is the literal 'default' (a transcript
          // CORPUS namespace, not a tenant), which is why the main query above
          // can say `= workspaceId OR = 'default'`. adv_sessions is TENANT-keyed
          // ('papercusp-workspace'), so copying that predicate here matches
          // NOTHING whenever ctx.workspaceId is 'default'/'' — measured: it
          // silently returned zero rows for a live session that plainly exists,
          // i.e. it reproduced the very bug this block fixes. coord_owner_id is
          // a globally unique agent id, so it is already an exact scope.
          const advRows = await tx<Array<{ agent: string | null; session_id: string }>>`
            SELECT agent, session_id
              FROM harness_shared.adv_sessions
             WHERE coord_owner_id = ${owner}
               AND ended_at IS NULL
               AND session_id IS NOT NULL
             ORDER BY started_at DESC
             LIMIT 5`;
          // Filter in JS against SESSION_SOURCE_KINDS so that constant stays the
          // single source of truth (an agent value outside it has no lens here).
          const adv = advRows.find((r) => r.agent != null
            && (SESSION_SOURCE_KINDS as readonly string[]).includes(r.agent));
          if (adv?.agent) live = { sourceKind: adv.agent, sessionId: adv.session_id };
        }
        // Bind to a const so the null-check narrows inside the closure below.
        const liveSession = live;
        if (liveSession && !sessions.some((s) => s.source_kind === liveSession.sourceKind && s.session_id === liveSession.sessionId)) {
          const liveRows = await tx<Array<{
            turns: number; prompt_count: number;
            harness_slug: string | null; cwd: string | null;
            first_ts: string | null; last_ts: string | null;
          }>>`
            SELECT count(*)::int AS turns,
                   count(*) FILTER (WHERE speaker = 'user')::int AS prompt_count,
                   max(harness_slug) AS harness_slug, max(cwd) AS cwd,
                   to_json(min(ts)) #>> '{}' AS first_ts,
                   to_json(max(ts))  #>> '{}' AS last_ts
              FROM harness_shared.session_turns
             WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
               AND source_kind = ${liveSession.sourceKind} AND session_id = ${liveSession.sessionId}
               AND COALESCE(ts, ingested_at) < ${snapshotUntil}::timestamptz
               AND (${args.since ?? null}::timestamptz IS NULL OR COALESCE(ts, ingested_at) >= ${args.since ?? null}::timestamptz)
          `;
          const lr = liveRows[0];
          sessions.unshift({
            source_kind: liveSession.sourceKind,
            session_id: liveSession.sessionId,
            turns: lr?.turns ?? 0,
            prompt_count: lr?.prompt_count ?? 0,
            owner,
            harness_slug: lr?.harness_slug ?? null,
            cwd: lr?.cwd ?? null,
            first_ts: lr?.first_ts ?? null,
            last_ts: lr?.last_ts ?? null,
            response_count: null,
            tool_call_count: null,
            active: true,
          });
          total += 1;
        }
      } catch { /* fail-soft: the active-session fallback never breaks the list */ }
    }

    // hasMore/nextCursor track the REAL owner-matched rows (offset stream); the
    // synthetic active row lives on page one only and is excluded from the math.
    const realTotal = total - (sessions.length - realPageCount);
    const hasMore = realTotal > offset + realPageCount;
    const nextCursor = hasMore
      ? encodeSessionCursor('sessions:list', offset + realPageCount, fingerprint, { until: snapshotUntil })
      : undefined;

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          count: sessions.length,
          total,
          hasMore,
          window: { until: snapshotUntil },
          ...(nextCursor ? { nextCursor } : {}),
          ...(hasMore
            ? {
                truncated: `Showing ${sessions.length} matching sessions at offset ${offset} of ${total} (newest first). Continue with nextCursor or narrow with owner / source_kind / cwd_contains / since.`,
              }
            : {}),
          note:
            'Indexed sessions only (ingest window ~45d). Raw pre-window files: dev:claude_session / dev:omp_session. ' +
            'Timestamps are ISO-8601 with an explicit offset; `since` is parsed as UTC. ' +
            'UNITS (EI-9970): `turns` = indexed TEXT turns only (excludes tool_use/tool_result/thinking content) — for cost/effort audits use prompt_count/response_count/tool_call_count instead (see this tool\'s description for exact definitions). response_count/tool_call_count are null for source_kind=agent_chat (no tool-call signal in that transcript shape). ' +
            'EI-11403/WI-37867: a row with `active:true` is that owner\'s LIVE session surfaced even when it has produced NO indexed turns yet (or they are stamped under another owner) — such a row reads turns:0 and is NOT evidence the session is idle; sessions:search { session } reads its full content.',
          sessions,
        }),
      }],
    };
  },
});
