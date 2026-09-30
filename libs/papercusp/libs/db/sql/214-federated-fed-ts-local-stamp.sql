-- 214-federated-fed-ts-local-stamp.sql
--
-- EI-117 central fix (PG half) — make the federation LWW clock honest for
-- LOCAL writes, and re-arm CDC capture after a projection write.
--
-- THE DEFECT (observed twice on 2026-06-09, fleet-federation-reanchor +
-- shared-hive-federation plan docs; root-caused in the 06:45-09:00 replay
-- storm after the morning auto-deploy):
--   1. Local writes to federated tables never touched `fed_ts`, so a row's
--      LWW clock stayed at whatever the LAST PROJECTION APPLY stamped (or
--      NULL). Any replayed/old federated op with ts >= that stale clock
--      passed the writers' `EXCLUDED.fed_ts >= fed_ts` guard and silently
--      REVERTED newer local content.
--   2. A row last written by a projection carries origin='remote' (or, for
--      own-log replays pre-skipOwnOps, 'local' with a fresh outbox echo).
--      Most local writers do not reset `origin` in their UPDATE / ON CONFLICT
--      branch, so the CDC capture trigger (`COALESCE(origin,'local') =
--      'local'`) skipped the NEXT genuine local write — it never reached the
--      outbox/log, leaving the log's head as the OLD content that the next
--      replay restored.
--
-- THE FIX: one BEFORE INSERT OR UPDATE trigger on every CDC-captured
-- federated table. Discriminator: a write that MOVES `fed_ts` is a projection
-- apply (every projection sets fed_ts = the op's wire ts explicitly) or a
-- deliberate repair — respected verbatim. A write that leaves `fed_ts`
-- untouched while changing the row is a LOCAL write — stamp `fed_ts` with the
-- wall clock (epoch ms, the same unit as op wire ts) and reset
-- `origin='local'` so the capture trigger federates it.
--
-- Paired TS-side changes (same changeset): projections skip own-log ops on
-- CDC tables (TableProjection.skipOwnOps — the echo-storm breaker) and drop
-- the `OR EXCLUDED.fed_ts IS NULL` clobber disjunct from the LWW guards.
--
-- Scope: the 11 CDC-captured federated tables. Log-first tables
-- (contributors / feature_queue / feature_working_set / shared_presence /
-- harness_feature_prs) are NOT touched — their PG rows arrive via the
-- projection (fed_ts explicit), and they have no capture trigger to re-arm.
--
-- Idempotent: CREATE OR REPLACE + DROP TRIGGER IF EXISTS. No table rewrites,
-- row-level BEFORE triggers only; deploy-safe under lock_timeout.

CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  -- A write that moves fed_ts is a projection apply (remote op; fed_ts = the
  -- op's wire ts) or an explicit repair/backfill — respect it verbatim.
  IF TG_OP = 'UPDATE' AND NEW.fed_ts IS DISTINCT FROM OLD.fed_ts THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A projection INSERT carries the op's fed_ts AND origin='remote'; a local
    -- INSERT carries neither. Gate the stamp on origin: `EXCLUDED` reflects the
    -- row AFTER BEFORE-INSERT triggers, so stamping a remote ts-less op here
    -- would hand it a fresh clock and let it through the writers' LWW guard.
    IF NEW.fed_ts IS NULL AND COALESCE(NEW.origin, 'local') = 'local' THEN
      NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE with fed_ts untouched = a local write. Stamp the LWW clock (so a
  -- replayed/older federated op can never beat this content) and reset origin
  -- (so the CDC capture trigger federates the change even when the row was
  -- last written by a projection). Bookkeeping-only writes (version bumps,
  -- updated_at touches, generated _search) keep the prior clock.
  IF (to_jsonb(NEW) - 'fed_ts' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'fed_ts' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version')
  THEN
    NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    NEW.origin := 'local';
  END IF;
  RETURN NEW;
END;
$fn$;

DO $body$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'harness_plans',
    'harness_features_consolidated',
    'harness_issues_consolidated',
    'coord_event_log',
    'coord_conversations',
    'coord_threads',
    'coord_thread_posts',
    'plan_item_assignments',
    'hive_settings',
    'hive_members',
    'engineer_issues'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.%I', t);
    EXECUTE format(
      'CREATE TRIGGER stamp_local_federated_write_trg
         BEFORE INSERT OR UPDATE ON harness_shared.%I
         FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write()', t);
  END LOOP;
END
$body$;
