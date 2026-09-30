-- 361-coord-plane-workspace-restamp.sql
--
-- Coord-plane workspace re-stamp (workspace-data-isolation-leaks-2026-06-17
-- P-002 / F-C1, D-006). Owner-greenlit 2026-06-22 (via su-815e2); built su-9d080.
--
-- WHAT: move the LEVER-(a) flag-gated coordination tables off the legacy shared
-- 'default' partition onto 'papercusp-workspace':
--     harness_shared.coord_event_log        (~69.5K rows — messages/handoffs/escalations/plan-events)
--     harness_shared.coord_watermarks        (~961 rows  — per-owner read positions)
--     harness_shared.coord_open_escalations  (~116 rows  — the open-escalation projection)
--
-- WHY (the real state, not "read-side only"): the coord seam resolves its
-- workspace via coordScopeWorkspace() (agent-tools/coordination/log.ts), gated by
-- the flag `papercusp-coord-per-workspace`. The flag reads ON, registry.current =
-- papercusp-workspace, and there is no PAPERCUSP_WORKSPACE_ID env pin — so once a
-- coord-writing operator RE-READS the flag, activeWorkspaceId() (and thus the
-- coord scope) resolves to papercusp-workspace. The running operator cached the
-- flag = false at boot (log.ts coordPerWorkspaceOn; emitFlagChange is in-process
-- only, no cross-process NOTIFY), so coord READS + WRITES are BOTH still on
-- 'default'. This migration moves the 'default' history so that when the operator
-- restarts (refreshing the cache → coord scopes to papercusp-workspace) the live
-- fleet's inboxes / read-positions / open-escalations do NOT fragment.
--
-- LOCKSTEP: this migration is meaningless without, and must be paired with, the
-- coord-operator RESTART that refreshes the flag cache. The native boot-apply
-- runner applies pending sql/ files BEFORE the operator serves, so a single
-- restart does both: apply 361 (move history) -> serve with the flag effective
-- (coord on papercusp-workspace, history present). Coordinate the restart window
-- with the owner (it affects every live agent). Sequence AFTER su-57d34's P-009
-- schema rename — do not run the two migrations concurrently.
--
-- NOT MOVED (deliberate):
--   * coord_presence            — already correctly per-workspace (identity-based).
--   * event_wake_deliveries / event_awaits — deliberately one global 'default'
--                                 namespace (eventsWs()); moving them splits the
--                                 wake namespace.
--   * lever-(b) conversations/threads/thread_posts/topics/entity_subscriptions/
--     links — a SEPARATE un-gated resolver (conversationsScopeWorkspace, terminal
--     ?? 'default') with no flag kill-switch; out of this pass (scope confirmed
--     by su-815e2 = lever-(a) only).
--   * messages_consolidated     — legacy/stale (last write 2026-06-10).
--   * pending_wakes             — already activeWorkspaceId()-scoped (F-C3).
--
-- SAFE BY CONSTRUCTION:
--   * Moves ONLY workspace_id='default' (leaves generic-test / test-coord-conformance
--     / wsA / wsB / the existing papercusp rows untouched).
--   * COLLISION-VERIFIED (2026-06-22 live census): 0 msg_id overlap between
--     'default' and 'papercusp-workspace' in coord_event_log (so none of the three
--     partial unique indexes — event_uq / fanout_uq / fed_uq — can be violated);
--     0 (workspace_id,msg_id) overlap in coord_open_escalations. coord_watermarks
--     has exactly 3 owners present in BOTH (a stale Jun-18 partial-write papercusp
--     row + a current 'default' row) — the 'default' read-position is live and
--     authoritative, so the stale papercusp dupe is dropped first.
--   * IDEMPOTENT: every move is `WHERE workspace_id='default'`; a re-run moves 0.
--   * Quiets the 3 UPDATE-firing triggers on coord_event_log for the bulk move
--     (capture_coord_event_upd_trg = CDC/substrate-outbox, emit_change_notify_trg
--     = sync change-notify, stamp_local_federated_write_trg = BEFORE-UPDATE
--     federation re-stamp). Without this a 69.5K-row workspace correction would
--     storm CDC + re-broadcast all of history as fresh local federated writes.
--   * In-txn GUARD: RAISE (-> rollback) if any row is left under 'default'.
--   * WHOLE body is ONE DO block, so it is atomic under BOTH the boot-apply
--     single-txn wrap AND a plain `psql -f` (db:migrate) autocommit — a failure
--     (incl. the guard) rolls back the move AND the trigger-disable together.
--
-- ROLLBACK (tested): the flag is the fast kill-switch (set papercusp-coord-per-workspace
-- OFF + restart -> coord reads/writes return to 'default'); to also move the data
-- back, run the inverse (a one-off, NOT a forward migration):
--     UPDATE harness_shared.coord_event_log        SET workspace_id='default' WHERE workspace_id='papercusp-workspace';
--     UPDATE harness_shared.coord_watermarks       SET workspace_id='default' WHERE workspace_id='papercusp-workspace';
--     UPDATE harness_shared.coord_open_escalations SET workspace_id='default' WHERE workspace_id='papercusp-workspace';
-- (acceptable for the single dogfood workspace, where 'default' and
-- papercusp-workspace coord are the same fleet's history; do it BEFORE any other
-- workspace starts writing real coord, then restart with the flag OFF.)

DO $coord_restamp$
DECLARE
  -- the UPDATE-firing triggers on coord_event_log to quiet for the bulk move:
  --   capture_coord_event_upd_trg    AFTER UPDATE  — CDC / substrate_outbox capture
  --   emit_change_notify_trg         AFTER UPDATE  — sync change-notify
  --   stamp_local_federated_write_trg BEFORE UPDATE — federation HLC/origin re-stamp
  -- Toggled via an existence guard so the migration is robust whether or not a
  -- given DB has them (the live operator DB does; a fresh/variant DB may not).
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

  -- 3. GUARD: nothing may remain under 'default' in the re-stamped tables.
  SELECT count(*) INTO leftover_events FROM harness_shared.coord_event_log        WHERE workspace_id = 'default';
  SELECT count(*) INTO leftover_wm     FROM harness_shared.coord_watermarks       WHERE workspace_id = 'default';
  SELECT count(*) INTO leftover_esc    FROM harness_shared.coord_open_escalations WHERE workspace_id = 'default';
  IF leftover_events > 0 OR leftover_wm > 0 OR leftover_esc > 0 THEN
    RAISE EXCEPTION 'coord-restamp 361 guard: rows still under default after move (events=%, watermarks=%, escalations=%) — aborting',
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

  RAISE NOTICE 'coord-restamp 361: moved events=%, watermarks=%, escalations=% (dropped % stale papercusp watermark dupe(s))',
    moved_events, moved_wm, moved_esc, deleted_wm_dupes;
END
$coord_restamp$;
