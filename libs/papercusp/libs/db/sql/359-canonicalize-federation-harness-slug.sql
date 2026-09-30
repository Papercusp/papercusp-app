-- Migration 359 — canonicalize harness_slug at the substrate-outbox capture boundary.
--
-- Plan: infra-fail-fast-build-integrity-2026-06-19 (round-4, Theme C · data-layer
-- growth control), item C1/P-009 "complete the papercup→papercusp rename / kill the
-- dual-slug write-amplification".
--
-- WHY -------------------------------------------------------------------------------
-- The papercup→papercusp rename (owner-directed, 2026-06-19/20) is COMPLETE in the
-- primary stores (harness_plans: 539 papercusp / 0 papercup; plan_revisions: 11273 /
-- 0). The residue lived ONLY in the federation outbox: a tail of stale-ctx agent
-- sessions kept writing federated rows (coord messages, engineer_issues, consolidated
-- features) tagged harness_slug='papercup'. The capture trigger faithfully copied
-- that slug into substrate_outbox, where it could never drain — there is no `papercup`
-- hive to federate to — so the rows piled up UNDRAINED forever (163 such rows at the
-- time of this migration). Same failure shape as EI-2224 (a lingering retired slug
-- darkening a fire-path), just on the federation lane.
--
-- canonicalHarnessSlug() (packages/operator-core/lib/harness/operator-home-harness.ts)
-- already self-heals retired slugs in the TS registry resolver, but the PG capture
-- trigger runs in the database and never saw it. This migration closes that gap AT
-- THE BOUNDARY: the capture function now canonicalizes the routing slug, so ANY future
-- write that slips through with a retired slug (a stale env, an un-restarted bg host,
-- persisted ctx) self-heals into the canonical hive instead of accreting dead backlog.
-- Non-retired slugs pass through byte-identical, so this is behavior-preserving for the
-- overwhelmingly common case.
--
-- WHAT ------------------------------------------------------------------------------
--   1. harness_shared.canonical_harness_slug(text) — IMMUTABLE SQL mirror of the TS
--      RETIRED_HARNESS_SLUG_ALIASES map. Keep the two in sync when a home/registered
--      harness is renamed (see operator-home-harness.ts).
--   2. CREATE OR REPLACE capture_substrate_outbox() — IDENTICAL to the live definition
--      except the routing slug is now canonical_harness_slug(...)-wrapped (this also
--      canonicalizes the pg_notify wake channel, so the right drainer is woken).
--   3. One-time, idempotent cleanup: mark the already-stuck dead-slug outbox backlog
--      drained so it stops counting against the undrained backlog (the local source
--      rows are untouched + still readable; we only discard an undeliverable federation
--      enqueue to a nonexistent hive — we deliberately do NOT re-route old chatter into
--      papercusp, which would risk injecting stale content).
--
-- Idempotent (CREATE OR REPLACE + bounded UPDATE that matches nothing once applied / on
-- a fresh or embedded-pg boot). Composes onto 000-baseline. Runs as harness_admin.

\set ON_ERROR_STOP on
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Canonicalizer — SQL mirror of RETIRED_HARNESS_SLUG_ALIASES
--    (packages/operator-core/lib/harness/operator-home-harness.ts). NULL-safe:
--    NULL IN (...) is NULL → ELSE → returns NULL (tables captured with no
--    harness_slug column yield NULL here, unchanged).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION harness_shared.canonical_harness_slug(p_slug text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
AS $$
  SELECT CASE
           WHEN p_slug IN ('papercup', 'papercup-hive') THEN 'papercusp'
           ELSE p_slug
         END;
$$;

COMMENT ON FUNCTION harness_shared.canonical_harness_slug(text) IS
  'Map a retired harness slug to its current canonical name (papercup/papercup-hive → papercusp). SQL mirror of RETIRED_HARNESS_SLUG_ALIASES in operator-home-harness.ts — update BOTH when a home/registered harness is renamed. Used by capture_substrate_outbox() to canonicalize the federation routing key.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Capture function — byte-identical to the live definition except v_slug is now
--    canonicalized. (CREATE OR REPLACE is atomic: in-flight trigger calls finish on
--    the old body, new calls use the new one.)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
    DECLARE
      v_op      TEXT;
      v_rec     RECORD;
      v_origin  TEXT;
      v_key     TEXT;
      v_row     JSONB;
      v_ws      TEXT;
      v_slug    TEXT;
      v_op_hlc  TEXT;
      v_keycol  TEXT := TG_ARGV[0];
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        v_op := 'del';
        v_rec := OLD;
      ELSE
        v_op := 'put';
        v_rec := NEW;
      END IF;

      v_row := to_jsonb(v_rec);
      v_origin := v_row ->> 'origin';

      -- Echo-loop guard: skip remote-origin writes (the projection's own writes).
      IF COALESCE(v_origin, 'local') <> 'local' THEN
        RETURN v_rec;
      END IF;

      v_key  := v_row ->> v_keycol;
      v_ws   := COALESCE(v_row ->> 'workspace_id', '');
      -- C1/P-009: canonicalize the federation routing key so a retired slug
      -- (papercup) self-heals into its current hive instead of accreting undrained
      -- dead-slug backlog. Pass-through for every non-retired slug.
      v_slug := harness_shared.canonical_harness_slug(v_row ->> 'harness_slug');

      -- D-001: the op's HLC ordering key, threaded onto the wire op by the drain.
      -- put → the row's fed_hlc (the BEFORE stamp trigger's value, identical to
      -- what the local row carries); del → a fresh hlc_now() (the del event's own
      -- causal clock; the OLD row's fed_hlc is stale). NULL on a table with no
      -- fed_hlc (append-only usage) → the drain's stampOpHlc generates a fallback.
      IF v_op = 'del' THEN
        v_op_hlc := harness_shared.hlc_now();
      ELSE
        v_op_hlc := v_row ->> 'fed_hlc';
      END IF;

      INSERT INTO harness_shared.substrate_outbox
        (workspace_id, harness_slug, table_name, op, key, row, ts, op_hlc)
      VALUES
        (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row,
         (extract(epoch from now()) * 1000)::bigint, v_op_hlc);

      PERFORM pg_notify('substrate_outbox', v_ws || '::' || v_slug);

      RETURN v_rec;
    END;
    $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. One-time backlog cleanup — drain the already-stuck dead-slug enqueues. These
--    targeted a nonexistent hive and would otherwise sit undrained until the >48h
--    backstop GC eventually reaped them. Bounded + idempotent (matches nothing once
--    drained / on a fresh boot). We mark drained rather than re-route: the local
--    source rows remain, and re-federating stale chatter into papercusp is not worth
--    the dup/ordering risk.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE harness_shared.substrate_outbox
   SET drained_at = (extract(epoch from now()) * 1000)::bigint
 WHERE harness_slug IN ('papercup', 'papercup-hive')
   AND drained_at IS NULL;

COMMIT;
