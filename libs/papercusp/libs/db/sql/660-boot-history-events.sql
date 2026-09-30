-- 660-boot-history-events.sql
-- EI-18655247267756605: boot-history is process-local (two in-memory rings in
-- boot-history.ts) and clears on restart — unavailable for exactly the
-- restart-class federation bugs it exists to diagnose (the restart IS the
-- event that destroys it). WI-5781 already mirrors the sparse
-- admission/join/peer/boot-fail kinds to stdout (the cheap half of the fix,
-- see STDOUT_MIRROR_KINDS in boot-history.ts); this table is the durable half
-- (storage-policy default: Postgres) — a cross-restart, queryable record of
-- those same sparse forensic events.
--
-- Deliberately excludes the high-frequency epoch-decrypt-gate trace kinds
-- (epoch_gate_seen/epoch_defer/epoch_decrypt_fail/epoch_applied) and
-- peer_connected (already ~110/run per WI-3827/EI-9108's own two-ring split
-- rationale) — this table holds only the sparse, edge-triggered kinds, so it
-- can never become a hot-write path. Bounded per (workspace_id, harness_slug)
-- with oldest-evicted-past-cap (mirrors harness_shared.coord_quarantine,
-- migration 436) so a noisy harness cannot grow this table unbounded.

-- NOTE: no top-level BEGIN;/COMMIT; here. The migration runner already wraps each file in
-- its own transaction, so an inner COMMIT ENDS that wrapper early and the remainder of the
-- file runs unprotected (migration 657 carries the same warning). lint-migrations enforces
-- this for enforced-era migrations, and it was failing the green gate fleet-wide on this
-- file until removed.
CREATE TABLE IF NOT EXISTS harness_shared.boot_history_events (
    id              bigserial PRIMARY KEY,
    workspace_id    text NOT NULL DEFAULT '',
    harness_slug    text NOT NULL,
    kind            text NOT NULL,
    message         text,
    -- The event's own timestamp (epoch ms, boot-history.ts's `_nowImpl()` at
    -- record time) + when this row was durably persisted.
    ts              bigint NOT NULL,
    created_ts      bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS boot_history_events_scope_idx
  ON harness_shared.boot_history_events (workspace_id, harness_slug, created_ts);

COMMENT ON TABLE harness_shared.boot_history_events IS
  'Durable mirror of boot-history.ts''s sparse (non-high-frequency) event kinds (EI-18655247267756605) — survives process restart, unlike the in-memory rings. Local-only; never federates. Bounded per (workspace_id, harness_slug), oldest evicted past the per-scope cap.';
