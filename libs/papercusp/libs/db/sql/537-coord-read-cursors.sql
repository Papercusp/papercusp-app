-- Migration 537 — coord_read_cursors: server-side per-agent read cursors
-- (fleet-deltas-leader-primitives-2026-07-10 P-004, owner-ratified design D-002).
--
-- One row per (workspace, owner, surface). Two-phase ACK-ON-NEXT-READ:
--   * `pending`   — the compact state fingerprint delivered by the LAST call;
--   * `committed` — the fingerprint the caller has PROVABLY seen: the arrival of
--                   call N+1 promotes N's `pending` into `committed` (the ack).
-- A caller that dies after delivery N never makes call N+1, so `pending` is never
-- promoted — the next call diffs against the old `committed` and RE-DELIVERS
-- delivery N's content: at-least-once, never a skip (the same recovery contract
-- as coord_watermarks' non-monotonic cursors, generalized to arbitrary state
-- fingerprints instead of timestamps). The agent carries NOTHING — no since_ts
-- argument exists anywhere in this protocol (the WI-1600 trap is structurally
-- impossible).
--
-- First consumer: coord:orient mode:'monitor' fleet-delta fold (surface
-- 'fleet:monitor'). The EI-2042 messages_shown_ts inbox cursor is the SAME idea
-- specialized to a ts — the P-005 rollout migrates surfaces onto this store.

CREATE TABLE IF NOT EXISTS harness_shared.coord_read_cursors (
  workspace_id text NOT NULL,
  owner_id     text NOT NULL,
  surface      text NOT NULL,
  committed    jsonb,
  pending      jsonb,
  pending_at   timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, owner_id, surface)
);

COMMENT ON TABLE harness_shared.coord_read_cursors IS
  'Server-side per-agent read cursors, two-phase ack-on-next-read (P-004 fleet-deltas-leader-primitives, mig 537): pending = state delivered by the last call; committed = state provably seen (promoted from pending when the NEXT call arrives). A missed next-call re-delivers — at-least-once, never a skip.';
