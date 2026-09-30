-- 1064: WI-2104919 — reclassify 3 pre-watchdog inbox-resolve runs out of untruthful phase='complete'.
--
-- bulk-03ab6013, bulk-a0407e8f, bulk-dab06de0 (all settled 2026-08-24) sit at phase='complete'
-- with EVERY item row still outcome='pending' (152+151+152 = 455) and heartbeat_at NULL —
-- 'complete' masking full abandonment. They pre-date both the deriveSettleOutcome earned-success
-- guard (EI-22013650201095388: settle now derives from item rows, so pending>0 routes to
-- 'review', and a no-evidence run refuses to 'failed') and the P-002 run watchdog. The watchdog
-- cannot repair them going forward: it strands only EXECUTING runs, and these are terminal.
--
-- This applies the strandStaleRun write shape retroactively:
--   * undecided items -> failed / retry_needed (decided outcomes untouched — there are none),
--   * run -> failed with an explanatory reason in `error`,
--   * stored counters recomputed from the item rows (mirrors recomputeCounters).
-- finished_at is preserved — the runs really did end on 2026-08-24; what was wrong is the verdict,
-- not the timestamp. phase='failed' keeps them restartable (restartRun accepts 'failed'), so the
-- 455 items remain one click / one scheduled tick from a fresh resolver.
--
-- Pure DML, no DDL. Idempotent: the items UPDATE is gated on outcome='pending' and the runs
-- UPDATE on phase='complete'; on installs without these run_ids both match zero rows.

UPDATE harness_shared.attention_bulk_run_items
   SET outcome = 'failed',
       disposition = 'failed',
       recommendation_kind = COALESCE(recommendation_kind, 'retry_needed'),
       retry_condition = COALESCE(retry_condition, 'restart the run'),
       error = 'Reclassified by migration 1064 (WI-2104919): this pre-watchdog run settled ''complete'' with every item still pending and no resolver heartbeat — this item was never decided. Marked failed retroactively, matching run-watchdog strand semantics.',
       decided_at = now(),
       updated_at = now()
 WHERE run_id IN (
         'bulk-03ab6013-0546-4adc-b727-fe4b6482bc20',
         'bulk-a0407e8f-4b0f-4748-b5c8-6b156f79ffe5',
         'bulk-dab06de0-29d3-4969-9006-dcbd2be96e06'
       )
   AND outcome = 'pending';

UPDATE harness_shared.attention_bulk_runs r
   SET phase = 'failed',
       error = 'Reclassified by migration 1064 (WI-2104919): settled ''complete'' on 2026-08-24 with every item row still pending and heartbeat_at NULL — no evidence the resolver ever ran (pre-dates the deriveSettleOutcome earned-success guard and the P-002 watchdog). The truthful terminal state is failed; the undecided items were marked failed/retry_needed. Restart the run to hand them to a fresh resolver.',
       auto_resolved = c.auto_resolved,
       recommended = c.recommended,
       skipped = c.skipped,
       failed = c.failed,
       updated_at = now()
  FROM (
    SELECT i.workspace_id, i.run_id,
           COUNT(*) FILTER (WHERE i.outcome = 'auto_resolved')::int          AS auto_resolved,
           COUNT(*) FILTER (WHERE i.outcome = 'recommended')::int            AS recommended,
           COUNT(*) FILTER (WHERE i.outcome IN ('skipped', 'dismissed'))::int AS skipped,
           COUNT(*) FILTER (WHERE i.outcome = 'failed')::int                 AS failed
      FROM harness_shared.attention_bulk_run_items i
     WHERE i.run_id IN (
             'bulk-03ab6013-0546-4adc-b727-fe4b6482bc20',
             'bulk-a0407e8f-4b0f-4748-b5c8-6b156f79ffe5',
             'bulk-dab06de0-29d3-4969-9006-dcbd2be96e06'
           )
     GROUP BY i.workspace_id, i.run_id
  ) c
 WHERE r.workspace_id = c.workspace_id
   AND r.run_id = c.run_id
   AND r.phase = 'complete';
