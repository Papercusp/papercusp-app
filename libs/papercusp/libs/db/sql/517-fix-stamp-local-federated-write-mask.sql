-- 517-fix-stamp-local-federated-write-mask.sql
--
-- WI-183 / WI-2845 / WI-2853: fix a same-op DOUBLE-APPLY (a replayed/re-folded
-- remote federation op — e.g. a projection retry or backfill re-running the
-- identical wire op) incorrectly flipping `origin` back to 'local' and advancing
-- the LWW clock (`fed_ts`/`fed_hlc`) on `harness_shared.work_items`.
--
-- ## Root cause (confirmed by a RED integration repro; see
-- packages/operator-core/lib/sync/hyperbee/projections/engineer-issues.integration.test.ts
-- 'a same-op double-apply ... does NOT flip origin/fed_ts/fed_hlc')
--
-- `stamp_local_federated_write_trg` (mig 214) was originally attached to
-- `harness_shared.harness_features_consolidated`. Mig 374's
-- `ALTER TABLE harness_features_consolidated RENAME TO work_items` PRESERVES
-- triggers across a rename (they bind to the table OID, not its name) — so this
-- BEFORE INSERT OR UPDATE trigger is STILL live on `work_items` today, just
-- carried over under its original name (invisible to a `grep ON
-- harness_shared.work_items` sweep of the migration history, since the
-- attachment SQL text names the pre-rename table).
--
-- The trigger's content-diff mask (mig 490, the latest CREATE OR REPLACE) is
-- `{fed_ts, fed_hlc, origin, author_pubkey, updated_at, _search, version,
-- local_disposition}` — it lists `updated_at`, but `work_items` has NO such
-- column at all (only its `engineer_issues` compat VIEW exposes a computed
-- `updated_at` alias; the base table's real bookkeeping columns are
-- `updated_ts` bigint + `ts` bigint). So `updated_ts` is NEVER excluded from the
-- diff — and every projection write (projections/engineer-issues.ts /
-- harness-features.ts) re-stamps `updated_ts` to a fresh wall-clock value on
-- EVERY apply, including a byte-identical replay of the same remote op. The
-- trigger therefore false-positives a "real content change" on every re-fold,
-- overwriting the projection's own explicit `origin='remote'`/`fed_ts`/`fed_hlc`
-- (already correctly set via `ON CONFLICT ... SET x = EXCLUDED.x`) with a fresh
-- `origin:='local'` + advanced fed clock — corrupting the row's federation state
-- (a remote-authored row gets mislabeled 'local', which can let a stale local
-- write later beat a legitimately newer remote write in the LWW compare).
--
-- ## The fix — TABLE-SCOPED, not a blanket mask change
--
-- This trigger function is SHARED across ~18 federated tables (harness_plans,
-- coord_event_log, coord_conversations, coord_threads, coord_thread_posts,
-- plan_item_assignments, hive_settings, hive_members, hive_epoch_keys,
-- hive_policy, hive_pending_joins, hive_reports, bee_claim_specs,
-- gate_verdicts, p2p_peer_grants, p2p_receipts, p2p_work_offers,
-- p2p_fleet_directory, work_items). Widening the mask to exclude 'updated_ts'
-- and 'ts' UNCONDITIONALLY would be unsafe: `coord_event_log` has a literal
-- `ts` column that is GENUINE CONTENT (the event's occurrence time, not
-- bookkeeping) and IS updated in place (the workspace-restamp migrations
-- 361/391 do `UPDATE coord_event_log SET workspace_id = ...`), so masking `ts`
-- globally could hide a real semantic change on that table. Every other table
-- either lacks these columns entirely (jsonb `-` on a missing key is a
-- documented no-op, so they are unaffected either way) or already uses
-- `updated_at` (matches the existing mask, e.g. p2p_fleet_directory mig 476,
-- verified safe against the same double-apply scenario by hand-trace).
--
-- So: branch on `TG_TABLE_NAME` and apply the EXTRA `updated_ts`/`ts` exclusion
-- ONLY for `work_items` — the one table with this exact column-naming mismatch.
-- Every other table's trigger behavior is byte-for-byte unchanged.
--
-- Idempotent: CREATE OR REPLACE, no table/data changes. Deploy-safe under
-- lock_timeout (function replace only, no rewrite).

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
      NEW.fed_hlc := harness_shared.hlc_now();
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE with fed_ts untouched = a local write (or a same-op re-fold; see
  -- header). Stamp the LWW clock + reset origin ONLY when a REAL content column
  -- changed. Bookkeeping-only writes (version bumps, updated_at/updated_ts
  -- touches, generated _search) keep the prior clock.
  --
  -- WI-183/WI-2853: `work_items` (renamed from harness_features_consolidated,
  -- mig 374) has no `updated_at` column — its bookkeeping timestamps are
  -- `updated_ts`/`ts`, which the base mask below does not name. Exclude them
  -- too, but ONLY for this table (see header for why not globally).
  IF TG_TABLE_NAME = 'work_items' THEN
    IF (to_jsonb(NEW) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition' - 'updated_ts' - 'ts')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition' - 'updated_ts' - 'ts')
    THEN
      NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      NEW.fed_hlc := harness_shared.hlc_now();
      NEW.origin := 'local';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition')
  THEN
    NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    NEW.fed_hlc := harness_shared.hlc_now();
    NEW.origin := 'local';
  END IF;
  RETURN NEW;
END;
$fn$;
