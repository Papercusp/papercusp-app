-- 440 — hive_placements.last_loss_spawn_id (WI-677 round 2, 2026-07-02).
--
-- The placement watchdog's pathology counter (fail_count) was charged once per
-- SWEEP over a failed placement, not once per failed ATTEMPT: the same dead
-- serving bee stays in the spawn window across sweeps (and a not-yet-re-placed
-- recovering item has NO bee at all), so every recoveryDebounce expiry counted a
-- fresh "loss". Observed live 2026-07-02 00:27: items reset to `recovering`
-- accrued fail_count 3 and re-CURSED within 12 minutes with ZERO new bees
-- spawned. EI-865's latch fixed exactly this recount for the `cursed` state but
-- not for `recovering`.
--
-- This column records WHICH dead attempt (bee spawn id) was last counted, so
-- the sweep counts each corpse ONCE: same spawn id → re-place wake only, no
-- count; a NEW dead bee (a genuinely failed fresh attempt) → count. NULL means
-- no loss counted yet for the current attempt lineage.
ALTER TABLE harness_shared.hive_placements
  ADD COLUMN IF NOT EXISTS last_loss_spawn_id text;
