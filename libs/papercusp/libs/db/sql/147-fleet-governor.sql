-- Migration 147 — fleet backpressure governor (the runaway bound).
--
-- Plan: fleet-as-supervised-blackboard-2026-06-04 (P2, D-005). No single primitive
-- bounds a runaway fleet; the curator's control loop COMPOSES four, all keyed off this
-- one table by a `kind` discriminator + `scope_key`:
--
--   • kind='bucket'  — a TOKEN BUCKET. The global LLM-spend ceiling (scope_key='global')
--     AND, via per-harness/per-user scope keys, the BULKHEAD that isolates a runaway in
--     one harness/user from draining the fleet pool. refill_per_sec caps long-run cost;
--     capacity allows bursts.
--   • kind='circuit' — a CIRCUIT BREAKER per harness/role/dependency: stop pouring
--     tokens into something that keeps failing (closed → open → half_open).
--   • kind='credit'  — CREDIT-BASED per-stage admission: a slow downstream role grants
--     credits as it drains; the orchestrator can't spawn into it beyond them.
--
-- Opt-in: a scope with NO row is UNCONSTRAINED (the governor only enforces configured
-- scopes), so the default fleet behaves exactly as before until the curator seeds a cell.
--
-- Composes onto 000-baseline.sql for fresh/embedded-pg. Idempotent. Runs as harness_admin.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.fleet_governor (
  workspace_id   text        NOT NULL,
  -- 'bucket' | 'circuit' | 'credit'
  kind           text        NOT NULL,
  -- scope identifier, e.g. 'global', 'harness:papercup', 'user:alice', 'role:worker'.
  scope_key      text        NOT NULL,

  -- ── token bucket (kind='bucket') ───────────────────────────────────────────
  capacity       numeric,                 -- max tokens (burst ceiling)
  refill_per_sec numeric,                 -- refill rate (long-run cost cap)
  tokens         numeric,                 -- current tokens
  updated_at     timestamptz,             -- last refill timestamp

  -- ── circuit breaker (kind='circuit') ───────────────────────────────────────
  cb_state       text,                    -- 'closed' | 'open' | 'half_open'
  cb_failures    integer     NOT NULL DEFAULT 0,
  cb_threshold   integer,                 -- failures to trip open
  cb_cooldown_sec integer,                -- open → half_open after this
  cb_opened_at   timestamptz,

  -- ── credits (kind='credit') ────────────────────────────────────────────────
  credits        integer,                 -- available admission credits
  credit_max     integer,                 -- ceiling for grants

  created_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, kind, scope_key),
  CONSTRAINT fleet_governor_kind_chk CHECK (kind IN ('bucket', 'circuit', 'credit'))
);

COMMENT ON TABLE harness_shared.fleet_governor IS
  'Fleet backpressure governor cells (plan fleet-as-supervised-blackboard D-005): token buckets (global ceiling + per-harness/user bulkhead), circuit breakers, and per-stage credits. A scope with no row is unconstrained. Read/written by the governor engine (operator-core/lib/fleet/governor.ts).';

COMMIT;
