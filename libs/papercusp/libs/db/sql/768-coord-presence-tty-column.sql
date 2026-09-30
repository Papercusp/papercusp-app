-- 768-coord-presence-tty-column.sql
-- EI-19948333346987654: add harness_shared.coord_presence.tty — the terminal
-- device path (e.g. /dev/pts/21) a session's psu launcher owns, self-reported
-- by the supervisor beat (WI-3898 P1's pid/host sibling). Nullable, additive,
-- non-destructive — no FORWARD-COMPAT ack needed.
--
-- Purely metadata (nullable, no default expression to compute), so this is a
-- fast catalog-only ALTER (PG 11+) — but coord_presence is EXTREMELY hot
-- (every agent's heartbeat/declare-intent touches it), so apply it through
-- db:migrate's lock-retry wrapper (EI-9417), never a bare psql -f.

ALTER TABLE harness_shared.coord_presence
  ADD COLUMN IF NOT EXISTS tty text;
