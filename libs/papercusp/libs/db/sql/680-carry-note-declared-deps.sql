-- 680 — carry-note declared dependencies (agent-protocol-authority-semantics-2026-07-26 P-007, D-013).
--
-- The freshness axis: replace TTL guessing with declared dependencies that
-- invalidate on change. A carry-note may declare what it was derived FROM; each
-- dependency resolves to a VERSION TOKEN stamped here at write time, and a reader
-- re-resolves the tokens and diffs them to decide Fresh / Stale / Recomputed.
--
-- Why a stamp column and not a generation-counter table (D-013): every dependency
-- worth declaring ALREADY carries a durable monotonic version — a work-item's
-- updated_at, a file's content hash, a plan's version. Stamping the observed token
-- needs no counters, no LISTEN/NOTIFY and no in-process state, so the verdict stays
-- correct across processes, sessions and operator restarts BY CONSTRUCTION. That is
-- required here: a checkpoint's reader is a SUCCESSOR in a different process, which
-- is exactly the case the operator's L1-only cache generations cannot serve.
--
-- Shape (v1):
--   { "v": 1,
--     "stamps": [ { "dep": "file:packages/x/y.ts", "token": "sha256:ab…", "at": 1737… } ],
--     "recomputed": false }
--
-- `recomputed` is stamped at WRITE time when the note being replaced was already
-- stale — i.e. the author refreshed it after its world moved, so a reader knows the
-- narrative may only be partially updated rather than continuously valid.
--
-- NULL ⇒ no declared dependencies ⇒ readers fall back to the existing time
-- heuristics (undeclared verdict). Every pre-existing row is therefore unchanged in
-- behaviour, so this migration is purely additive.
--
-- Scope guard (P-007): the column lands on the SHARED carry-note substrate so the
-- Queen carry-journal and the su loop carry-note inherit the mechanism for free when
-- their conversions land; only the work-item checkpoint seam reads/writes it today.

ALTER TABLE harness_shared.carry_notes
  ADD COLUMN IF NOT EXISTS deps JSONB;

COMMENT ON COLUMN harness_shared.carry_notes.deps IS
  'P-007/D-013 declared-dependency freshness stamps: { v, stamps:[{dep,token,at}], recomputed }. NULL ⇒ undeclared (time-heuristic fallback).';
