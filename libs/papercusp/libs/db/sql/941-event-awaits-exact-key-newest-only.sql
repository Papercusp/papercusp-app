-- 941-event-awaits-exact-key-newest-only.sql.DRAFT
--
-- EI-21338411229452662: direct events:await, watch auto-arm, and events sugar
-- all register ordinary exact one-shot rows through the same store. Retire
-- older live rows before inserting a replacement, and enforce that invariant
-- for writers that bypass the TypeScript store.
--
-- This remains a DRAFT until the runtime guard and its real-PG regression are
-- verified. The statements are idempotent so the migration can be re-run.

-- 1. Reconcile rows created before the serialized store guard. Keep the newest
-- live ordinary exact, unfiltered, non-announce, non-composed one-shot per
-- subscriber/key. Payload-filtered rows are distinct predicates and
-- leader-managed fleet benches are a separate coordination surface, so both
-- remain coexistable with an ordinary wait.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY workspace_id, subscriber_id, event_key
           ORDER BY created_at DESC, id DESC
         ) AS rn
    FROM harness_shared.event_awaits
   WHERE policy <> 'announce'
     AND once = true
     AND root_id IS NULL
     AND payload_filter IS NULL
     AND (note IS NULL OR note NOT LIKE '[fleet:bench] %')
     AND event_key NOT LIKE '%*%'
     AND event_key NOT LIKE '@%'
     AND fired_at IS NULL
     AND cancelled_at IS NULL
     AND superseded_at IS NULL
)
UPDATE harness_shared.event_awaits e
   SET cancelled_at = now(),
       cancel_reason = COALESCE(e.cancel_reason, 'deduped-by-941')
  FROM ranked r
 WHERE e.id = r.id
   AND r.rn > 1;

-- 2. Prevent a concurrent or out-of-band writer from recreating the duplicate
-- active-row state. The predicate mirrors the runtime exactOneShot guard.
CREATE UNIQUE INDEX IF NOT EXISTS event_awaits_exact_one_shot_one_per_subscriber_key
    ON harness_shared.event_awaits (workspace_id, subscriber_id, event_key)
 WHERE policy <> 'announce'
   AND once = true
   AND root_id IS NULL
   AND payload_filter IS NULL
   AND (note IS NULL OR note NOT LIKE '[fleet:bench] %')
   AND event_key NOT LIKE '%*%'
   AND event_key NOT LIKE '@%'
   AND fired_at IS NULL
   AND cancelled_at IS NULL
   AND superseded_at IS NULL;
