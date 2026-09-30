-- 066-tool-invocations-event-count.sql
--
-- Add `event_count` column to harness_shared.tool_invocations so the
-- replay/Last-Event-ID work (Phase 4+ T2.2) can size per-tool ring
-- buffers from empirical data instead of the plan's initial guess.
--
-- Set by the dispatcher at completion time — the wrapped ctx.emit
-- in dispatch-projected.ts increments a counter; when the handler
-- returns (ok / error / timeout), recordInvocation writes the
-- counter into this column.
--
-- Backfill: NULL for existing rows. Readers tolerate null.
--
-- Indexes: not adding one — the column is read in aggregate
-- (p99 per toolName) by a one-off analytics query, not in hot paths.
-- Add later if /dev surfaces a per-tool-event-count panel.
--
-- Plan ref: phase-4-endpoint-system-2026-05-12.md § T2.2.

ALTER TABLE harness_shared.tool_invocations
  ADD COLUMN IF NOT EXISTS event_count integer;
