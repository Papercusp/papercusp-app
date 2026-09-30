/**
 * activity:recent — read recent worker-activity rows from the cross-CLI activity
 * bridge sink (harness_shared.agent_activity).
 *
 * The pull-side companion to the /api/activity/stream SSE push (both read the same
 * table the per-CLI hooks write via activity:report). The curator reads this to
 * decide what matters; the fleet view seeds from it before subscribing to the
 * stream; tests assert against it.
 *
 * Filters are ANDed: `owner` (one worker's pane), `session_id` (one CLI session of
 * that worker), `harness`, `agent` (claude/codex/omp), `kind`. `since_id` returns only
 * rows newer than a cursor (the stream-catch-up shape); default returns the most-recent
 * `limit` rows newest-first.
 *
 * EI-20309400427356782: `session_id` is the row's own column and always came back on
 * every row, but there was no way to filter BY it — so recovering one session's tool
 * stream meant over-fetching `owner` and filtering client-side, and an owner spans many
 * sessions across respawns. Owner is the worker; session is one CLI run of it.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

// + overwatch (overwatch-role-2026-06-15 B-01): reads recent activity to sense drift.
const ALL_ROLES = [...SU_ROLES, 'papercup', 'kettle'] as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const ACTIVITY_ROW_SCHEMA = z.object({
  id: z.string(),
  owner_id: z.string(),
  agent: z.string().nullable(),
  session_id: z.string().nullable(),
  harness_slug: z.string().nullable(),
  kind: z.string(),
  tool_name: z.string().nullable(),
  phase: z.string().nullable(),
  tool_use_id: z.string().nullable(),
  summary: z.string().nullable(),
  status: z.string().nullable(),
  detail: z.unknown(),
  cwd: z.string().nullable(),
  created_at: z.string(),
});

type ActivityRow = z.infer<typeof ACTIVITY_ROW_SCHEMA>;

const ACTIVITY_RECENT_RESULT_SCHEMA = z.object({
  activity: z.array(ACTIVITY_ROW_SCHEMA),
  count: z.number().int().nonnegative(),
});

export default defineTool({
  name: 'activity:recent',
  description:
    "Read recent worker-activity rows (native tool calls / lifecycle / todos) from the cross-CLI activity bridge. Filter by owner (one worker's pane), session_id (one CLI run of it), harness, agent (claude/codex/omp), kind (tool/lifecycle/todos); since_id pages forward from a cursor. The curator + fleet view read this; the live push is /api/activity/stream.",
  capability: 'activity:read',
  guidance: {
    when: 'You want to inspect what a worker (or the whole fleet) has been doing — the recent native tool-call stream, todo snapshots, or lifecycle transitions. Pass owner for one pane, session_id for one CLI run of it, harness for one project, since_id to page forward.',
    notWhen: 'For a LIVE feed subscribe to the /api/activity/stream SSE (the pui does this). To report activity (you almost never need to) use `activity:report`. For coord messages use `coord:inbox`.',
    // EI-22047814129755519. This tool and activity:tool-log read the SAME ledger but
    // window it with OPPOSITE vocabularies: here it is `since_id` + `limit`, there it is
    // `since`/`until` + `max_lines`/`top_k`. `session_id` is already spelled identically
    // in both ON PURPOSE (see its .describe() below), so a caller has direct evidence
    // that these two agree on arg names — which makes the time/budget divergence a
    // reasonable thing to get wrong, not carelessness. Zero prompt weight (argRedirects
    // is excluded from describeFromGuidance), paid only on the rejection that needs it.
    argRedirects: {
      since:
        'since_id — this read pages by monotonic ROW ID, not by clock: pass the `since_id` from a prior response to catch up (rows then come oldest-first). If you actually want a WALL-CLOCK window, this tool has none — activity:tool-log { since, until } takes absolute ISO 8601 bounds over the same underlying activity.',
      until: {
        tool: 'activity:tool-log',
        args: { owner: 'self', since: '<ISO 8601>', until: '<ISO 8601>' },
        note: 'activity:recent has NO upper time bound at all — it pages forward from `since_id` and stops at `limit`, so there is no key to rename `until` to. activity:tool-log windows the same activity by absolute ISO 8601 `since`/`until` (relative durations like "-15 min" are rejected there too).',
      },
    },
    seeAlso: [
      'activity:report (inject a synthetic activity marker)',
      'coord:inbox (peer coord messages, not the tool stream)',
      'dev:telemetry (aggregate tool observability)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    /** Scope to one worker's coordination id (PAPERCUSP_SID). */
    owner: z.string().max(256).optional(),
    /**
     * Scope to one CLI session of that worker (the row's own session_id). Same
     * spelling + bounds as activity:tool-log's session_id, deliberately: `.min(1)`
     * because an empty string is not a filter — it would match `session_id = ''`
     * and return an empty result that reads like "this session did nothing".
     */
    session_id: z.string().min(1).max(256).optional(),
    /** Scope to one harness. */
    harness: z.string().max(256).optional(),
    /** Scope to one CLI: 'claude' | 'codex' | 'omp'. */
    agent: z.string().max(32).optional(),
    /** Scope to one kind. */
    kind: z.enum(['tool', 'lifecycle', 'todos']).optional(),
    /** Only rows with id > since_id (stream catch-up; returns oldest-first then). */
    // A string cursor is accepted so callers can preserve BIGINT precision, but
    // it must still be an unsigned decimal. Passing "NaN" through to Number()
    // makes Postgres reject the bigint comparison instead of returning a typed
    // argument-validation error.
    since_id: z
      .union([
        z.number().finite().int().nonnegative(),
        z.string().regex(/^\d+$/),
      ])
      .optional(),
    /** Max rows (default 50, max 500). */
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  }),
  // EI-23112015757282201: code:run receives the unwrapped, typed data root from
  // every nested tool call. Without a result schema, code:tools could only
  // advertise Promise<unknown> for this tool, so a caller reasonably guessed
  // the outer MCP content[] envelope and hit the intentional fail-loud
  // structured_result_shape guard. Declare the data shape here so both the MCP
  // outputSchema and the generated code:run facade point at activity/count.
  result: ACTIVITY_RECENT_RESULT_SCHEMA,
  // Freshness negotiation (agent-tool-delta-protocol-2026-06-22, P-015 — Lane F rollout,
  // mirrors the P-013 plans:attention exemplar). The repeated "what's recent" poll (no
  // since_id) is a stable, high-churn view: the diffable unit is the `activity` row set,
  // keyed by the BIGINT `id`. Rows are append-only/immutable (a content-hash revision means
  // a row is never `updated`; the window churns as new rows are `added` and old ones fall
  // out → `removed`). The framework hashes the CANONICAL ARGS into the view fingerprint
  // (owner/session_id/harness/agent/kind/limit/since_id — a new filter self-folds, it is
  // not a maintained list), so a since_id catch-up call gets its own cursor and
  // a changed window → full; `scope` adds the workspace dimension (the handler scopes the
  // feed to the active workspace). Dormant until the papercusp-tool-delta-protocol flag flips.
  delta: {
    rows: (data) => {
      const activity = (data as { activity?: unknown[] } | null | undefined)?.activity;
      return Array.isArray(activity) ? activity : null;
    },
    itemKey: (row) => (row as ActivityRow).id,
    itemKeyField: 'id',
    rowType: (row) => (row as ActivityRow).kind,
    orderKey: 'id',
    scope: (_args, ctx) => (ctx as { workspaceId?: string }).workspaceId ?? '',
    schemaVersion: 'activity-v1',
    // Periodic forced-full reconciliation (bounds incremental-merge drift), as the exemplar.
    maxDeltaAge: 5 * 60_000,
  },
  async handler(args) {
    const limit = args.limit ?? DEFAULT_LIMIT;
    // Keep string cursors as strings so callers can preserve BIGINT precision;
    // the schema above has already ruled out non-numeric values.
    const sinceId =
      args.since_id == null
        ? null
        : typeof args.since_id === 'string'
          ? args.since_id
          : String(args.since_id);
    const { sql } = getOrgPg();
    // F-B5 (workspace-data-isolation-leaks): agent_activity has workspace_id but
    // RLS is off + getOrgPg() bypasses it, so scope the feed to the active
    // workspace explicitly (else B's activity:recent returns A's agent activity).
    // Keep the legacy '*' partition during the writer cutover: migration 143
    // defaulted old rows there, while activity:report now writes concrete
    // workspaces. The workspace-leading index serves the concrete leg; the
    // wildcard leg is deliberately retained only for backward compatibility.
    const ws = activeWorkspaceId();

    // since_id present → forward-paging (oldest-first, the catch-up order a stream
    // consumer wants); absent → most-recent-first.
    const rows = sinceId != null
      ? await sql<ActivityRow[]>`
          SELECT id::text AS id, owner_id, agent, session_id, harness_slug, kind, tool_name,
                 phase, tool_use_id, summary, status, detail, cwd, created_at
          FROM harness_shared.agent_activity
          WHERE id > ${sinceId}
            AND workspace_id IN (${ws}, '*')
            AND (${args.owner ?? null}::text IS NULL OR owner_id = ${args.owner ?? null})
            AND (${args.session_id ?? null}::text IS NULL OR session_id = ${args.session_id ?? null})
            AND (${args.harness ?? null}::text IS NULL OR harness_slug = ${args.harness ?? null})
            AND (${args.agent ?? null}::text IS NULL OR agent = ${args.agent ?? null})
            AND (${args.kind ?? null}::text IS NULL OR kind = ${args.kind ?? null})
          -- Order by the BIGINT column, NOT the "id::text AS id" output alias in the
          -- SELECT: a bare ORDER BY id binds to that text alias and sorts
          -- lexicographically ("1000" < "999"), which silently froze this read at the
          -- last 3-digit id once the sequence crossed 999 to 1000. Keep the ::bigint cast.
          ORDER BY id::bigint ASC
          LIMIT ${limit}
        `
      : await sql<ActivityRow[]>`
          SELECT id::text AS id, owner_id, agent, session_id, harness_slug, kind, tool_name,
                 phase, tool_use_id, summary, status, detail, cwd, created_at
          FROM harness_shared.agent_activity
          WHERE workspace_id IN (${ws}, '*')
            AND (${args.owner ?? null}::text IS NULL OR owner_id = ${args.owner ?? null})
            AND (${args.session_id ?? null}::text IS NULL OR session_id = ${args.session_id ?? null})
            AND (${args.harness ?? null}::text IS NULL OR harness_slug = ${args.harness ?? null})
            AND (${args.agent ?? null}::text IS NULL OR agent = ${args.agent ?? null})
            AND (${args.kind ?? null}::text IS NULL OR kind = ${args.kind ?? null})
          -- ::bigint, not a bare ORDER BY id -- see the note on the since_id branch
          -- above (the text alias sorts lexicographically and froze this at id 999).
          ORDER BY id::bigint DESC
          LIMIT ${limit}
        `;

    return { data: { activity: rows, count: rows.length } };
  },
});
