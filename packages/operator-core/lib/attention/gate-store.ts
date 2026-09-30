/**
 * gate-store.ts — the Postgres layer for session_pending_gates (migration 619,
 * owner-inbox-single-pane-2026-07-17 P-002): the client-agnostic owner-gate
 * tracker fed by both the ingest tool (hook push path) and the transcript
 * watcher (client-agnostic pull path, gate-watch.ts).
 *
 * `ref_id` is the correlation key across the open→close pair: the watcher uses
 * the transcript's own tool_use id; a hook generates its own uuid and repeats
 * it on the matching 'cleared' ingest event. The (workspace_id, session_id,
 * ref_id) unique index makes re-observing the same open ask idempotent — the
 * ON CONFLICT touch is scoped to still-open rows so a stale re-observation can
 * never reopen an already-closed gate.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { TransactionSql } from 'postgres';

export type GateClient = 'claude' | 'omp' | 'codex';
export type GateKind = 'ask' | 'permission_wait';
export type GateSource = 'watcher' | 'hook';
/**
 * Terminal reasons, split by what they REQUIRE to be written (WI-10002067).
 *
 * The first two are SESSION-DEPENDENT: both are written only by machinery that
 * needs the asking session alive to observe something (the watcher seeing a
 * tool_result; the hook/bulk path clearing a ref). For most of migration 619's
 * life those were the ONLY two members, which meant a gate whose asker had died
 * could not reach a terminal state by any code path that existed — 241 of them
 * had accumulated by 2026-09-20, the oldest open since 2026-07-17.
 *
 * The last two are SESSION-INDEPENDENT and exist to close that hole: they are
 * written by a sweep that needs nothing from the asking session. Adding them is
 * the root-cause fix, not a cleanup convenience.
 */
export type GateClosedReason =
  | 'tool_result_observed'
  | 'hook_cleared'
  | 'asker_gone'
  | 'default_applied';

/** The subset of {@link GateClosedReason} that a sweep may write without the
 *  asking session participating. Exported so a caller cannot widen the sweep to
 *  a session-dependent reason by passing a bare string. */
export type SessionIndependentCloseReason = Extract<GateClosedReason, 'asker_gone' | 'default_applied'>;

export interface PendingGateRow {
  id: string;
  workspace_id: string;
  session_id: string;
  client: GateClient;
  kind: GateKind;
  ref_id: string;
  owner_id: string | null;
  question: string | null;
  options: Array<{ label: string; description?: string }> | null;
  source: GateSource;
  raw_ref: string | null;
  harness_slug: string | null;
  opened_at: string;
  closed_at: string | null;
  closed_reason: GateClosedReason | null;
  /** Deadline the asker declared; past it the gate self-resolves rather than
   *  depending on the asking session surviving (WI-10002067). */
  decide_by: string | null;
  /** Disposition to apply when {@link decide_by} passes unanswered. */
  default_if_unanswered: unknown | null;
  created_at: string;
}

export interface OpenGateInput {
  workspaceId: string;
  sessionId: string;
  client: GateClient;
  kind: GateKind;
  refId: string;
  ownerId?: string | null;
  question?: string | null;
  options?: Array<{ label: string; description?: string }> | null;
  source: GateSource;
  rawRef?: string | null;
  harnessSlug?: string | null;
  /**
   * Deadline for this ask, declared by the ASKER (WI-10002067). Rides the exact
   * route `question`/`options` already prove: the agent does not write this row
   * itself — an observer (hook ingest or the transcript watcher) extracts the
   * field from the agent's ask and persists it here. No new seam.
   */
  decideBy?: Date | string | null;
  /** Disposition to apply when {@link decideBy} passes unanswered. Omit (or
   *  null) with a decideBy set to mean "expire it, with no default to apply". */
  defaultIfUnanswered?: unknown;
}

export type OpenGateOutcome = 'opened' | 'already_open';

/**
 * Open (or idempotently touch) a pending gate. The `WHERE
 * session_pending_gates.closed_at IS NULL` conflict-action guard means a
 * re-observation of a REF that already closed is a true no-op — it can never
 * reopen a resolved gate (both producers may observe the same ask more than
 * once; the watcher especially re-sees an unresolved tool_use every tick).
 */
export async function openOrTouchGate(input: OpenGateInput): Promise<{ id: string; outcome: OpenGateOutcome }> {
  const { sql } = getOrgPg();
  const optionsJson = input.options ? JSON.stringify(input.options) : null;
  const rows = await sql<Array<{ id: string; opened_at: string; touched_opened_at: string }>>`
    INSERT INTO harness_shared.session_pending_gates
      (workspace_id, session_id, client, kind, ref_id, owner_id, question, options, source, raw_ref, harness_slug)
    VALUES (
      ${input.workspaceId}, ${input.sessionId}, ${input.client}, ${input.kind}, ${input.refId},
      ${input.ownerId ?? null}, ${input.question ?? null}, ${optionsJson}::text::jsonb,
      ${input.source}, ${input.rawRef ?? null}, ${input.harnessSlug ?? null}
    )
    ON CONFLICT (workspace_id, session_id, ref_id) DO UPDATE
      SET updated_at = now()
      WHERE session_pending_gates.closed_at IS NULL
    RETURNING id::text AS id, opened_at::text AS opened_at, updated_at::text AS touched_opened_at
  `;
  const row = rows[0];
  if (!row) {
    // The conflict-action WHERE excluded the row (already closed) AND it
    // wasn't a fresh insert either — look it up to report its id honestly.
    const existing = await sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM harness_shared.session_pending_gates
      WHERE workspace_id = ${input.workspaceId} AND session_id = ${input.sessionId} AND ref_id = ${input.refId}
    `;
    return { id: existing[0]?.id ?? '', outcome: 'already_open' };
  }
  const outcome: OpenGateOutcome = row.opened_at === row.touched_opened_at ? 'opened' : 'already_open';
  return { id: row.id, outcome };
}

export type CloseGateResult = 'closed' | 'not_found' | 'already_closed';

export type ReopenGateResult = 'reopened' | 'not_found' | 'already_open' | 'source_changed';

/** Close a gate by its correlation ref. Idempotent: closing an already-closed
 *  or never-opened ref is reported, never an error. */
export async function closeGate(input: {
  workspaceId: string;
  sessionId: string;
  refId: string;
  reason: GateClosedReason;
}): Promise<CloseGateResult> {
  const { sql } = getOrgPg();
  const updated = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.session_pending_gates
       SET closed_at = now(), closed_reason = ${input.reason}, updated_at = now()
     WHERE workspace_id = ${input.workspaceId}
       AND session_id = ${input.sessionId}
       AND ref_id = ${input.refId}
       AND closed_at IS NULL
     RETURNING id::text AS id
  `;
  if (updated.length > 0) return 'closed';
  const existing = await sql<Array<{ closed_at: string | null }>>`
    SELECT closed_at::text AS closed_at FROM harness_shared.session_pending_gates
    WHERE workspace_id = ${input.workspaceId} AND session_id = ${input.sessionId} AND ref_id = ${input.refId}
  `;
  if (existing.length === 0) return 'not_found';
  return 'already_closed';
}

/**
 * Re-open a gate closed by the Inbox bulk resolver.
 *
 * This is intentionally NOT part of {@link openOrTouchGate}: watcher/hook
 * re-observation must remain unable to resurrect a gate the owner already
 * cleared. Only the bounded compensation path calls this explicit inverse.
 * The expected close reason is a compare-and-set guard: if another producer
 * closed the row, undo refuses instead of overwriting that newer authority.
 * Supplying `tx` joins the source restore to the immutable bulk receipt's
 * reverted_at/revert_note transaction.
 */
export async function reopenGate(
  input: {
    workspaceId: string;
    sessionId: string;
    refId: string;
    expectedClosedReason: GateClosedReason;
  },
  tx?: TransactionSql,
): Promise<ReopenGateResult> {
  const sql = tx ?? getOrgPg().sql;
  const updated = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.session_pending_gates
       SET closed_at = NULL,
           closed_reason = NULL,
           updated_at = now()
     WHERE workspace_id = ${input.workspaceId}
       AND session_id = ${input.sessionId}
       AND ref_id = ${input.refId}
       AND closed_at IS NOT NULL
       AND closed_reason = ${input.expectedClosedReason}
     RETURNING id::text AS id
  `;
  if (updated.length > 0) return 'reopened';

  const existing = await sql<Array<{ closed_at: string | null; closed_reason: GateClosedReason | null }>>`
    SELECT closed_at::text AS closed_at, closed_reason
      FROM harness_shared.session_pending_gates
     WHERE workspace_id = ${input.workspaceId}
       AND session_id = ${input.sessionId}
       AND ref_id = ${input.refId}
  `;
  if (existing.length === 0) return 'not_found';
  if (existing[0]?.closed_at == null) return 'already_open';
  return 'source_changed';
}

/**
 * Close every still-open gate for a session by transcript tool_use id — the
 * watcher's job when it sees a tool_result line. Returns the closed count.
 */
export async function closeGateByToolUseId(input: {
  workspaceId: string;
  sessionId: string;
  toolUseId: string;
}): Promise<number> {
  const { sql } = getOrgPg();
  const updated = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.session_pending_gates
       SET closed_at = now(), closed_reason = 'tool_result_observed', updated_at = now()
     WHERE workspace_id = ${input.workspaceId}
       AND session_id = ${input.sessionId}
       AND ref_id = ${input.toolUseId}
       AND closed_at IS NULL
     RETURNING id::text AS id
  `;
  return updated.length;
}

/** The blocked-sessions surface + the attention adapter's read: open gates,
 *  oldest-blocking-first by default (the longest-waiting session is the most
 *  actionable). */
export async function listPendingGates(filter: {
  workspaceId: string;
  sessionId?: string;
  includeClosed?: boolean;
  order?: 'oldest' | 'newest';
  limit?: number;
}): Promise<PendingGateRow[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const rows = await sql<PendingGateRow[]>`
    SELECT g.id::text AS id, g.workspace_id, g.session_id, g.client, g.kind, g.ref_id,
           COALESCE(g.owner_id, latest_owner.coord_owner_id) AS owner_id,
           g.question, g.options, g.source, g.raw_ref, g.harness_slug,
           g.opened_at::text AS opened_at, g.closed_at::text AS closed_at,
           g.closed_reason, g.created_at::text AS created_at
    FROM harness_shared.session_pending_gates AS g
    LEFT JOIN LATERAL (
      SELECT s.coord_owner_id
        FROM harness_shared.adv_sessions AS s
       WHERE s.workspace_id = g.workspace_id
         AND s.session_id = g.session_id
         AND s.coord_owner_id IS NOT NULL
       ORDER BY s.started_at DESC, s.id DESC
       LIMIT 1
    ) AS latest_owner ON true
    WHERE g.workspace_id = ${filter.workspaceId}
      ${filter.includeClosed ? sql`` : sql`AND g.closed_at IS NULL`}
      ${filter.sessionId ? sql`AND g.session_id = ${filter.sessionId}` : sql``}
    ORDER BY g.opened_at ${filter.order === 'newest' ? sql`DESC` : sql`ASC`}
    LIMIT ${limit}
  `;
  return rows;
}

/**
 * Every OPEN gate's (session, ref) key for a workspace — the transcript
 * watcher's set-membership test, and deliberately NOT {@link listPendingGates}.
 *
 * WI-10002079/R2. `listPendingGates` is the DISPLAY read: it is hard-clamped to
 * 200 rows (`Math.min(..., 200)` — a ceiling no caller can raise) and ordered
 * `opened_at ASC`. Using it to decide "is this tool_result closing a gate we
 * have open?" made the watcher's close path silently blind to every gate past
 * the 200th, and because the order is oldest-first the excluded set was always
 * the NEWEST gates — precisely the ones with a live session and a fresh
 * tool_result. The bias is self-reinforcing: it grows as the backlog grows.
 *
 * A correctness-critical membership test must see the WHOLE set, so this
 * projects only the two key columns (no lateral owner join, no display
 * payload) and takes no limit. At the 241-gate backlog that measured this bug
 * the result is ~241 short string pairs.
 */
export async function listOpenGateRefs(filter: {
  workspaceId: string;
}): Promise<Array<{ session_id: string; ref_id: string }>> {
  const { sql } = getOrgPg();
  return await sql<Array<{ session_id: string; ref_id: string }>>`
    SELECT session_id, ref_id
      FROM harness_shared.session_pending_gates
     WHERE workspace_id = ${filter.workspaceId}
       AND closed_at IS NULL
  `;
}

/**
 * Closed `ask` gates (an AskUserQuestion the owner actually answered) since a
 * given ISO timestamp — the feed `decision-owed-source.ts` (EI-147) scans for
 * possibly-unrecorded owner decisions. Distinct from {@link listPendingGates}
 * (which defaults to still-OPEN gates and covers both kinds): this reads the
 * RESOLVED-ask history, newest-first, bounded by `sinceIso` so a long-lived
 * workspace never full-scans the table.
 */
export async function listClosedAskGatesSince(filter: {
  workspaceId: string;
  sinceIso: string;
  limit?: number;
}): Promise<PendingGateRow[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const rows = await sql<PendingGateRow[]>`
    SELECT id::text AS id, workspace_id, session_id, client, kind, ref_id, owner_id, question, options,
           source, raw_ref, harness_slug, opened_at::text AS opened_at, closed_at::text AS closed_at,
           closed_reason, created_at::text AS created_at
    FROM harness_shared.session_pending_gates
    WHERE workspace_id = ${filter.workspaceId}
      AND kind = 'ask'
      AND closed_at IS NOT NULL
      AND closed_at >= ${filter.sinceIso}
    ORDER BY closed_at DESC
    LIMIT ${limit}
  `;
  return rows;
}
