-- 391-coord-plane-workspace-restamp-followup.sql
--
-- Coord-plane workspace re-stamp — FOLLOW-UP to migration 361
-- (workspace-data-isolation-leaks-2026-06-17 F-C1 / D-006; WI-599).
--
-- WHY A SECOND RESTAMP: migration 361 (2026-06-22) moved the coord history off the
-- legacy shared 'default' partition onto 'papercusp-workspace', but the running
-- :3070 operator never picked up the cutover — log.ts caches `coordPerWorkspaceOn`
-- in ONE module-global boolean, resolved at boot via getFlag(systemDistinctId).
-- That boot resolution fell through to the FALSE code default of
-- `papercusp-coord-per-workspace` (no per-workspace override matched the boot scope,
-- no PostHog rollout), so coord READS + WRITES stayed on 'default' and ~5K fresh
-- rows (messages/plan-events/escalations) re-accumulated there after 361.
--
-- WI-599 flips the CODE DEFAULT of papercusp-coord-per-workspace to true
-- (libs/flags/src/types.ts), so the next operator boot resolves coordPerWorkspaceOn
-- = true and coord routes per active workspace (papercusp-workspace). This migration
-- moves the post-361 'default' residue so that cutover restart does NOT fragment the
-- live fleet's inboxes / read-positions / open-escalations (exactly 361's purpose,
-- re-run for the drip that accumulated since).
--
-- LOCKSTEP: like 361, this is paired with the coord-operator RESTART that picks up
-- the new default. The native boot-apply runner applies pending sql/ files BEFORE
-- the operator serves, so a single deploy does both: apply 391 (move residue) ->
-- serve with the flag default = true (coord on papercusp-workspace, history present).
--
-- SCOPE / SAFETY: identical contract to 361 —
--   * Moves ONLY workspace_id='default' (leaves generic-test / wsA / wsB / the
--     existing papercusp rows untouched).
--   * IDEMPOTENT: every move is `WHERE workspace_id='default'`; a re-run / a clean
--     DB with no 'default' coord rows moves 0.
--   * Quiets the same 3 UPDATE-firing coord_event_log triggers for the bulk move
--     (CDC capture / sync change-notify / federation HLC re-stamp) so a workspace
--     correction does not storm CDC + re-broadcast history as fresh local writes.
--   * coord_watermarks collision: drop a stale papercusp dupe when a live 'default'
--     read-position exists for the same owner ('default' wins — it is current).
--   * WHOLE body is ONE DO block — atomic under boot-apply (single txn wrap) AND a
--     plain `psql -f` autocommit.
--
-- DELIBERATELY SOFT GUARD (the one difference from 361): a leftover-'default' row
-- raises a NOTICE/WARNING, NOT an EXCEPTION. 361 hard-aborts; for a FOLLOW-UP drip
-- restamp a single row that trickles in during application must NOT fail the whole
-- deploy (a wedged :3070 is worse than one stranded coord row, and the move is
-- idempotent so a subsequent deploy catches any straggler). Once the operator boots
-- with the default true, no new 'default' coord rows are produced.
--
-- ROLLBACK: the flag is the fast kill-switch (set papercusp-coord-per-workspace
-- default false / runtime-OFF + restart -> coord returns to 'default'); to also move
-- data back, run the inverse one-off documented in 361's header.
--
-- NOT MOVED (same as 361): coord_presence (already per-workspace), event wake
-- namespace (deliberately global), lever-(b) conversations/threads/topics (separate
-- un-gated resolver), messages_consolidated (legacy), pending_wakes (already scoped).

DO $coord_restamp_followup$
DECLARE
  upd_trigs text[] := ARRAY[
    'capture_coord_event_upd_trg',
    'emit_change_notify_trg',
    'stamp_local_federated_write_trg'
  ];
  trg text;
  deleted_wm_dupes  bigint;
  moved_events      bigint;
  moved_wm          bigint;
  moved_esc         bigint;
  leftover_events   bigint;
  leftover_wm       bigint;
  leftover_esc      bigint;
BEGIN
  -- 0. quiet the UPDATE-firing CDC / change-notify / federation-restamp triggers
  --    for this bulk workspace-id correction (rolled back with the txn on failure;
  --    only those actually present are touched).
  FOREACH trg IN ARRAY upd_trigs LOOP
    IF EXISTS (
      SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared' AND c.relname = 'coord_event_log'
         AND t.tgname = trg AND NOT t.tgisinternal
    ) THEN
      EXECUTE format('ALTER TABLE harness_shared.coord_event_log DISABLE TRIGGER %I', trg);
    END IF;
  END LOOP;

  -- 1. watermark collision: drop the stale papercusp dupe for owners who also have
  --    a live 'default' read-position (the 'default' one wins — it is current).
  DELETE FROM harness_shared.coord_watermarks p
   WHERE p.workspace_id = 'papercusp-workspace'
     AND EXISTS (
       SELECT 1 FROM harness_shared.coord_watermarks d
        WHERE d.workspace_id = 'default' AND d.owner_id = p.owner_id
     );
  GET DIAGNOSTICS deleted_wm_dupes = ROW_COUNT;

  -- 2. re-stamp 'default' -> 'papercusp-workspace' (idempotent).
  UPDATE harness_shared.coord_event_log        SET workspace_id = 'papercusp-workspace' WHERE workspace_id = 'default';
  GET DIAGNOSTICS moved_events = ROW_COUNT;
  UPDATE harness_shared.coord_watermarks       SET workspace_id = 'papercusp-workspace' WHERE workspace_id = 'default';
  GET DIAGNOSTICS moved_wm = ROW_COUNT;
  UPDATE harness_shared.coord_open_escalations SET workspace_id = 'papercusp-workspace' WHERE workspace_id = 'default';
  GET DIAGNOSTICS moved_esc = ROW_COUNT;

  -- 3. SOFT GUARD: warn (do NOT abort) if anything remains under 'default' — a
  --    follow-up drip restamp must not wedge a deploy on a single concurrent straggler.
  SELECT count(*) INTO leftover_events FROM harness_shared.coord_event_log        WHERE workspace_id = 'default';
  SELECT count(*) INTO leftover_wm     FROM harness_shared.coord_watermarks       WHERE workspace_id = 'default';
  SELECT count(*) INTO leftover_esc    FROM harness_shared.coord_open_escalations WHERE workspace_id = 'default';
  IF leftover_events > 0 OR leftover_wm > 0 OR leftover_esc > 0 THEN
    RAISE WARNING 'coord-restamp 391 follow-up: % event / % watermark / % escalation row(s) still under default (concurrent writers?); idempotent — a later deploy will catch them',
      leftover_events, leftover_wm, leftover_esc;
  END IF;

  -- 4. restore the triggers (success path; a rollback restores them anyway).
  FOREACH trg IN ARRAY upd_trigs LOOP
    IF EXISTS (
      SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared' AND c.relname = 'coord_event_log'
         AND t.tgname = trg AND NOT t.tgisinternal
    ) THEN
      EXECUTE format('ALTER TABLE harness_shared.coord_event_log ENABLE TRIGGER %I', trg);
    END IF;
  END LOOP;

  RAISE NOTICE 'coord-restamp 391 follow-up: moved events=%, watermarks=%, escalations=% (dropped % stale papercusp watermark dupe(s))',
    moved_events, moved_wm, moved_esc, deleted_wm_dupes;
END
$coord_restamp_followup$;
