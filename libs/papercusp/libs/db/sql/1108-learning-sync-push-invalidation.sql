-- 1108-learning-sync-push-invalidation.sql — WI-6182.
--
-- The eight Learning-tab sync reads audited in WI-6182 had no change event:
-- they refreshed on mount/manual action only. Attach the established generic
-- change producer to their LOW-CHURN backing relations. The one high-volume
-- relation (agent_usage_samples) deliberately stays trigger-less and is handled
-- by append-heavy-invalidator's coalesced max(id) sweep.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'scout_lens_weights',
    'cup_keeper_instances', 'cup_keeper_runs', 'cup_keeper_scores',
    'pot_eval_instances', 'pot_eval_runs', 'pot_eval_scores',
    'scout_cycle_stage_artifacts', 'scout_ticks', 'scout_routed_ideas',
    'learning_governor_loops', 'calibration_predictions', 'regret_findings',
    'transfer_lessons', 'prompt_ablation_runs'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared'
         AND c.relname = t
         AND c.relkind = 'r'
    ) THEN
      EXECUTE format(
        'CREATE OR REPLACE TRIGGER emit_change_notify_trg '
        || 'AFTER INSERT OR UPDATE OR DELETE ON harness_shared.%I '
        || 'FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify()',
        t
      );
    END IF;
  END LOOP;
END $$;

-- `routines` is a shared heartbeat table, so a blanket row trigger would turn
-- every system routine fire into a notify storm. Frontier renders only the
-- declared Learning singletons: filter the producer to those rows while still
-- emitting on every visible liveness/control change for them.
DROP TRIGGER IF EXISTS learning_frontier_change_notify_upsert_trg ON harness_shared.routines;
CREATE TRIGGER learning_frontier_change_notify_upsert_trg
  AFTER INSERT OR UPDATE OF name, active, last_fired_at, next_fire_at, metadata, payload_template
  ON harness_shared.routines
  FOR EACH ROW
  WHEN (
    NEW.name IN (
      'graduation-scan', 'negative-space-mine', 'neologism-mine', 'fleet-ekg-scan',
      'calibration-resolve', 'deferral-interest-refit', 'prompt-ablation', 'regret-mine',
      'transfer-distill', 'red-queen-drill', 'change-ledger-scan', 'scout-cycle',
      'iq-battery-gen', 'memory-precision-bench', 'memory-live-recall-canary'
    )
    OR NEW.payload_template->>'blueprintId' IN (
      'graduation', 'negative-space', 'neologism', 'fleet-ekg', 'calibration',
      'deferral-interest', 'prompt-ablation', 'regret', 'transfer', 'red-queen',
      'change-ledger', 'scout', 'iq-battery', 'memory-precision', 'memory-live-recall-canary'
    )
  )
  EXECUTE FUNCTION harness_shared.emit_change_notify();

DROP TRIGGER IF EXISTS learning_frontier_change_notify_delete_trg ON harness_shared.routines;
CREATE TRIGGER learning_frontier_change_notify_delete_trg
  AFTER DELETE ON harness_shared.routines
  FOR EACH ROW
  WHEN (
    OLD.name IN (
      'graduation-scan', 'negative-space-mine', 'neologism-mine', 'fleet-ekg-scan',
      'calibration-resolve', 'deferral-interest-refit', 'prompt-ablation', 'regret-mine',
      'transfer-distill', 'red-queen-drill', 'change-ledger-scan', 'scout-cycle',
      'iq-battery-gen', 'memory-precision-bench', 'memory-live-recall-canary'
    )
    OR OLD.payload_template->>'blueprintId' IN (
      'graduation', 'negative-space', 'neologism', 'fleet-ekg', 'calibration',
      'deferral-interest', 'prompt-ablation', 'regret', 'transfer', 'red-queen',
      'change-ledger', 'scout', 'iq-battery', 'memory-precision', 'memory-live-recall-canary'
    )
  )
  EXECUTE FUNCTION harness_shared.emit_change_notify();
