/**
 * message-log-gc.ts — physical retention GC for the coord_event_log `messages`
 * surface, BOTH scopes, in one thread-atomic sweep.
 *
 * The surface is append-only and has two distinct classes, each with its own
 * horizon:
 *   - OPERATOR-SCOPE (`harness_slug IS NULL`) — local workspace coordination
 *     history. Never federates; retained `MESSAGE_GC_RETENTION_DAYS` (30).
 *   - HARNESS-SCOPED (`harness_slug IS NOT NULL`) — FEDERATED content (mig 150).
 *     Retained `FEDERATED_MESSAGE_GC_RETENTION_DAYS` (7).
 *
 * WHY THE FEDERATED CLASS IS SWEPT AT ALL (this file previously refused to touch
 * it — plan memory-corpus-hygiene-and-release-distribution-2026-08-03, D-010):
 * deleting a federated row is not a hazard, it is THE MECHANISM. Migration 150's
 * `capture_coord_event_del_trg` turns the DELETE into a `del` op on the peer-log,
 * which peers apply via the coord-message projection's `deleteFromPg` (HLC-ordered,
 * so a concurrent put still wins if it is causally later). In the snapshot builder
 * the del collapses the row's full body to a tiny TOMBSTONE row, and the tombstone
 * itself is GC'd out of the snapshot after `SNAPSHOT_TOMBSTONE_HORIZON_MS` (14d).
 * That is the only mechanism that removes coord history from a release seed: the
 * seed is a byte-level copy of a signed append-only log, so individual ops cannot
 * be excised at cut time (D-010 retracts "filter at cut" as architecturally
 * unavailable), and a SPARSE cut does not help either — every coord message is a
 * distinct `msg_id` key with exactly one live put, so sparsity (which collapses
 * SUPERSEDED versions of a key) collapses nothing here.
 *
 * The del trigger's own `origin = 'local'` echo-guard means only rows THIS machine
 * authored emit a del. Remote-origin rows are deleted locally without propagating
 * (each machine authoritatively expires what it authored, and every peer runs this
 * same sweep), which is also why an early-GC'd tombstone cannot durably resurrect a
 * row: the peer that still holds it expires it on its own horizon regardless.
 *
 * LIVE FEDERATION IS UNTOUCHED (D-010): this trims HISTORY. The capture triggers,
 * the stream, and cross-machine agent-to-agent messaging are unaffected.
 *
 * SCOPE — `messages` only, deliberately. `handoffs` and `escalations` also
 * federate, but their rows are LIVE COORDINATION STATE with their own lifecycle
 * collectors (escalation-log-gc deletes RESOLVED families only); aging out an OPEN
 * escalation would destroy live state, not history. Measured 2026-08-03 the excluded
 * federated remainder is 629 rows (628 escalations + 1 handoff) against 26,912
 * federated messages — 2.3% of the population for none of the risk.
 *
 * SAFETY:
 *   - THREAD-ATOMIC: coord:thread reconstructs messages by walking
 *     `related_msg_id` transitively, so delete a rooted thread only when its
 *     newest message is fully aged.
 *   - HEALTH STATE IS EXEMPT FROM THE SHORTER HORIZON: a thread carrying a
 *     single-primary condition alarm/resolution stays on the OPERATOR horizon
 *     whatever its scope, because the readers of that state bound their scan at
 *     exactly that horizon (see the `is_condition` note in the query).
 *   - SINGLE-SCOPE THREADS ONLY: a thread whose members span BOTH scopes is kept
 *     by either horizon — there is no defensible single answer for a mixed thread,
 *     and it cannot be split without orphaning replies.
 *   - POST-REF SAFE: coord_thread_posts is a separate surface with its own
 *     `post_msg_id`, but if a future path stores a post_msg_id that matches a
 *     coord_event_log msg_id, keep that message's whole thread rather than
 *     orphaning the post.
 *   - OLDEST-FIRST + BOUNDED: threads are taken oldest-first under `threadLimit`,
 *     so a large first drain converges over successive daily runs instead of
 *     emitting one unbounded burst of federated `del` ops.
 */

import { getOrgPg } from '@papercusp/db-org';

export const MESSAGE_GC_RETENTION_DAYS = 30;
export const MESSAGE_GC_THREAD_LIMIT = 5000;

/**
 * Retention for FEDERATED (harness-scoped) coord messages, in days.
 *
 * Chosen from what a JOINING peer genuinely needs, not from what is convenient to
 * keep: a joiner needs the recent coordination stream (live handoffs, claims,
 * in-flight threads) to participate, and nothing needs a six-week-old declared-intent
 * message — durable work-item-scoped direction lives in work_items:comment /
 * work_items:checkpoint by design, not in coord. A week spans any realistic
 * catch-up window for an agent that has been away.
 *
 * Note the read-side bounds that cite MESSAGE_GC_RETENTION_DAYS (conditions.ts,
 * single-primary-check.ts) stay CORRECT — a 30d bound over data that now only
 * reaches back 7d for one class is loose, never wrong.
 */
export const FEDERATED_MESSAGE_GC_RETENTION_DAYS = 7;

export interface CoordMessageGcResult {
  /** Operator-scope (`harness_slug IS NULL`) rows deleted — never federated. */
  operator: number;
  /** Harness-scoped rows deleted — each local-origin one emits a federated `del`. */
  federated: number;
  total: number;
}

export async function gcOldCoordMessages(
  retentionDays = MESSAGE_GC_RETENTION_DAYS,
  federatedRetentionDays = FEDERATED_MESSAGE_GC_RETENTION_DAYS,
  threadLimit = MESSAGE_GC_THREAD_LIMIT,
): Promise<CoordMessageGcResult> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ operator_n: number; federated_n: number }>>`
    WITH RECURSIVE base AS (
      SELECT workspace_id,
             msg_id,
             body->>'related_msg_id' AS related_msg_id,
             harness_slug,
             ts,
             -- CONDITION-CARRYING: a single-primary alarm / resolution. NOT chatter —
             -- it is health state, read back by openSinglePrimaryConditions and the
             -- coord conditions fast path, both of which bound their scan at exactly
             -- MESSAGE_GC_RETENTION_DAYS on the stated grounds that "nothing older
             -- survives GC anyway". Expiring these on the shorter FEDERATED horizon
             -- would silently shrink that window to 7d for the harness-scoped ones,
             -- and an alarm aged out with no resolution reads as RESOLVED rather than
             -- as missing. Measured 2026-08-03: 52 such rows are harness-scoped, so
             -- exempting them costs nothing and removes the whole failure class.
             (body ? 'condition_key' OR body ? 'resolves_condition') AS is_condition
        FROM harness_shared.coord_event_log
       WHERE surface = 'messages'
    ),
    thread AS (
      -- Only rooted threads are eligible. A reply whose root is already missing is
      -- kept; deleting an orphaned fragment cannot improve thread integrity.
      SELECT workspace_id, msg_id AS root_id, msg_id, harness_slug, ts, is_condition
        FROM base
       WHERE related_msg_id IS NULL
      UNION
      SELECT t.workspace_id, t.root_id, b.msg_id, b.harness_slug, b.ts, b.is_condition
        FROM thread t
        JOIN base b
          ON b.workspace_id = t.workspace_id
         AND b.related_msg_id = t.msg_id
    ),
    eligible_threads AS (
      SELECT workspace_id, root_id
        FROM (
          SELECT t.workspace_id,
                 t.root_id,
                 max(t.ts) AS newest_ts,
                 bool_and(t.harness_slug IS NULL) AS operator_scope_only,
                 bool_and(t.harness_slug IS NOT NULL) AS federated_only,
                 bool_or(t.is_condition) AS carries_condition,
                 bool_or(p.post_msg_id IS NOT NULL) AS referenced_by_thread_posts
            FROM thread t
            LEFT JOIN harness_shared.coord_thread_posts p
              ON p.workspace_id = t.workspace_id
             AND p.post_msg_id = t.msg_id
           GROUP BY t.workspace_id, t.root_id
        ) g
       WHERE NOT g.referenced_by_thread_posts
         -- Per-scope horizon. A MIXED-scope thread satisfies neither branch and is
         -- kept (see SINGLE-SCOPE THREADS ONLY above). A condition-carrying thread
         -- stays on the LONGER operator horizon whatever its scope, so the health
         -- readers' 30d window is unchanged by federated retention.
         AND (
           (g.operator_scope_only
             AND g.newest_ts < now() - make_interval(days => ${retentionDays}))
           OR
           (g.federated_only
             -- ::int on BOTH branches: a bare parameter inside CASE loses the type
             -- inference make_interval(days => ...) gets from a lone parameter, and
             -- resolves to text ("function make_interval(days => text) does not exist").
             AND g.newest_ts < now() - make_interval(days => CASE
                   WHEN g.carries_condition THEN ${retentionDays}::int
                   ELSE ${federatedRetentionDays}::int
                 END))
         )
       ORDER BY g.newest_ts ASC
       LIMIT ${threadLimit}
    ),
    victims AS (
      SELECT t.workspace_id, t.msg_id
        FROM thread t
        JOIN eligible_threads e
          ON e.workspace_id = t.workspace_id
         AND e.root_id = t.root_id
    ),
    d AS (
      DELETE FROM harness_shared.coord_event_log e
       USING victims v
       WHERE e.workspace_id = v.workspace_id
         AND e.surface = 'messages'
         AND e.msg_id = v.msg_id
      RETURNING e.harness_slug
    )
    SELECT count(*) FILTER (WHERE harness_slug IS NULL)::int     AS operator_n,
           count(*) FILTER (WHERE harness_slug IS NOT NULL)::int AS federated_n
      FROM d
  `;
  const operator = rows[0]?.operator_n ?? 0;
  const federated = rows[0]?.federated_n ?? 0;
  return { operator, federated, total: operator + federated };
}

/**
 * Plan events are an append-only working-memory stream, not a threaded event
 * family. Every reader asks for a bounded recent tail, so a plain age sweep is
 * sufficient and avoids making the daily coord GC walk the whole history.
 */
export const PLAN_EVENTS_GC_RETENTION_DAYS = 30;
export const PLAN_EVENTS_GC_ROW_LIMIT = 5000;

export async function gcOldPlanEvents(
  retentionDays = PLAN_EVENTS_GC_RETENTION_DAYS,
  rowLimit = PLAN_EVENTS_GC_ROW_LIMIT,
): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ n: number }>>`
    WITH victims AS (
      SELECT workspace_id, id
        FROM harness_shared.coord_event_log
       WHERE surface = 'plan-events'
         AND ts < now() - make_interval(days => ${retentionDays})
       ORDER BY ts ASC, id ASC
       LIMIT ${rowLimit}
    ),
    d AS (
      DELETE FROM harness_shared.coord_event_log e
       USING victims v
       WHERE e.workspace_id = v.workspace_id
         AND e.id = v.id
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM d
  `;
  return rows[0]?.n ?? 0;
}

/**
 * Handoffs are immutable families: an opening `handoff` row is paired with
 * acceptance/expiry/re-ping siblings through related_msg_id. A terminal
 * family can be removed only as a whole. Open families, federated families,
 * and families whose newest sibling is still inside the horizon remain intact.
 */
export const HANDOFF_GC_RETENTION_DAYS = 30;
export const HANDOFF_GC_FAMILY_LIMIT = 5000;

export async function gcTerminalHandoffFamilies(
  retentionDays = HANDOFF_GC_RETENTION_DAYS,
  familyLimit = HANDOFF_GC_FAMILY_LIMIT,
): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ n: number }>>`
    WITH families AS (
      SELECT workspace_id,
             COALESCE(body->>'related_msg_id', msg_id) AS root_id,
             bool_or(body->>'kind' = 'handoff') AS has_root,
             bool_or(body->>'kind' IN ('handoff_accepted', 'handoff_expired')) AS terminal,
             bool_and(harness_slug IS NULL) AS operator_scope_only,
             max(ts) AS newest_ts
        FROM harness_shared.coord_event_log
       WHERE surface = 'handoffs'
         AND body->>'kind' IN ('handoff', 'handoff_accepted', 'handoff_expired', 'handoff_repinged')
       GROUP BY workspace_id, COALESCE(body->>'related_msg_id', msg_id)
    ),
    eligible AS (
      SELECT workspace_id, root_id
        FROM families
       WHERE has_root
         AND terminal
         AND operator_scope_only
         AND newest_ts < now() - make_interval(days => ${retentionDays})
       ORDER BY newest_ts ASC, root_id ASC
       LIMIT ${familyLimit}
    ),
    d AS (
      DELETE FROM harness_shared.coord_event_log e
       USING eligible f
       WHERE e.workspace_id = f.workspace_id
         AND e.surface = 'handoffs'
         AND e.body->>'kind' IN ('handoff', 'handoff_accepted', 'handoff_expired', 'handoff_repinged')
         AND COALESCE(e.body->>'related_msg_id', e.msg_id) = f.root_id
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM d
  `;
  return rows[0]?.n ?? 0;
}
