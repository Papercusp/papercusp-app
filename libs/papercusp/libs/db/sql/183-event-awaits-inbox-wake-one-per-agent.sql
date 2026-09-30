-- 183-event-awaits-inbox-wake-one-per-agent.sql
--
-- turn-lifecycle-control-2026-06-08 D-002 / P-001 + P-006.
--
-- Always-arm makes the operator (re-)register an agent's standing inbox-wake
-- watch on every SessionStart, so arming must be IDEMPOTENT: one live standing
-- inbox-wake await per agent, refreshed in place rather than duplicated. This
-- migration (1) dedupes the rows that accumulated under the old register-on-
-- demand path, then (2) adds the partial unique index the upsert's ON CONFLICT
-- arbiter relies on.
--
-- Scope is deliberately narrowed to the inbox-wake key family
-- (`coord:inbox-wake:%`) so OTHER standing watches (pot:declare-wake,
-- watch:create on arbitrary keys) keep their existing insert semantics and are
-- unaffected. Idempotent + re-runnable.

-- 1. Dedupe: keep only the most-recent active standing inbox-wake await per
--    (workspace, subscriber, key); cancel the rest. (Standing rows are never
--    consumed — fired_at stays NULL — so "active" = not cancelled.)
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY workspace_id, subscriber_id, event_key
           ORDER BY created_at DESC, id DESC
         ) AS rn
    FROM harness_shared.event_awaits
   WHERE policy = 'wake'
     AND once = false
     AND cancelled_at IS NULL
     AND event_key LIKE 'coord:inbox-wake:%'
)
UPDATE harness_shared.event_awaits e
   SET cancelled_at = now(),
       fired_reason = COALESCE(e.fired_reason, 'deduped-by-183')
  FROM ranked r
 WHERE e.id = r.id
   AND r.rn > 1;

-- 2. One live standing inbox-wake await per (workspace, subscriber, key).
--    The predicate MUST match the ON CONFLICT inference predicate in
--    store.ts upsertInboxWakeAwait exactly.
CREATE UNIQUE INDEX IF NOT EXISTS event_awaits_inbox_wake_one_per_agent
    ON harness_shared.event_awaits (workspace_id, subscriber_id, event_key)
 WHERE policy = 'wake'
   AND once = false
   AND cancelled_at IS NULL
   AND event_key LIKE 'coord:inbox-wake:%';
