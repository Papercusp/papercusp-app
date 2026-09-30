-- Migration 656 — fold retired-slug plan rows into the canonical papercusp Pot,
-- and make the retired slug UNABLE to land in the plan tables again.
--
-- Work-item: WI-5720. Plan: papercup-to-papercusp-migration-2026-06-20 (Phase 6).
-- Owner-directed 2026-07-25: "papercup is no longer a harness, anything that is in
-- papercup slug should be in papercusp."
--
-- WHY -------------------------------------------------------------------------------
-- A plan's Pot IS its harness_slug (harness_shared.pots.pot_home_slug). 79 plans in
-- papercusp-workspace sat under slugs with no registered Pot — 78 under the retired
-- `papercup`, 1 under `hive-canary` — so they rendered as pot-less.
--
-- Migration 359 declared the papercup→papercusp rename COMPLETE in the primary stores
-- ("harness_plans: 539 papercusp / 0 papercup") and wrapped the substrate-outbox
-- CAPTURE (outbound) path in canonical_harness_slug(). But the rows here were WRITTEN
-- 2026-07-01 → 2026-07-09 — AFTER that migration. The gap is the INBOUND side: the
-- Hyperbee→PG projections apply a federated row under its AUTHORED harness_slug
-- verbatim (projections/harness-plans.ts writeToPg uses row.harness_slug;
-- projections/harness-plan-parts.ts line ~202 builds effOpts from row.harness_slug).
-- A peer or log-replay still tagging `papercup` therefore re-materialises June-era
-- snapshots under the dead slug, forever. The TS side is fixed in the same change;
-- this migration is the DATA repair plus a PG-level backstop that holds even for a
-- writer we have not thought of (a stale bg-host, an old bundle, a future path).
--
-- WHAT ------------------------------------------------------------------------------
--   1. canonicalize_plan_harness_slug() + BEFORE INSERT OR UPDATE triggers on
--      harness_plans and harness_plan_parts, gated by a WHEN clause so they cost
--      NOTHING on a normal write and fire only for a retired slug. The trigger
--      rewrites the slug to canonical; if the canonical row already exists it SKIPS
--      the write (RETURN NULL) rather than overwriting — same call migration 359 made
--      ("we deliberately do NOT re-route old chatter into papercusp, which would risk
--      injecting stale content"). A retired-slug row is by definition stale residue.
--   2. One-time, idempotent data fold for harness_plans / harness_plan_parts /
--      plan_revisions: MOVE each retired-slug row to papercusp with ON CONFLICT DO
--      NOTHING (so a live papercusp row is NEVER clobbered), then DELETE the retired
--      remainder. Net effect, verified against the live DB before writing this:
--        - 14 papercup plans have no papercusp twin  → they MOVE (Pot gains 14).
--        - 64 papercup + 1 hive-canary plan DO have a twin → the retired row is
--          dropped. Verified non-destructive: every one of those 65 carries ZERO
--          item-ids and ZERO decision-ids absent from its twin, and ZERO items where
--          the retired copy is ahead on status. They are pure stale shadows.
--
-- The `hive-canary` slug is folded in the DATA step only (its single plan is one of
-- the 65 duplicates); it is deliberately NOT in the trigger's retired-slug set —
-- hive-canary is a canary harness, not a papercup alias.
--
-- ⚠ AMENDED 2026-07-25, same day, after the first apply caused an incident: the
-- retired-slug DELETEs are now bracketed by DISABLE/ENABLE of the federation capture
-- trigger. See the comment above the harness_plans DELETE for the full mechanism, and
-- migration 657 for the repair. Any future migration that retires rows under an aliased
-- harness slug must do the same.
--
-- Idempotent: CREATE OR REPLACE + DROP/CREATE TRIGGER, and the fold matches nothing
-- once applied (or on a fresh / embedded-pg boot). Composes onto 000-baseline.
-- Runs as harness_admin.

\set ON_ERROR_STOP on

-- NO top-level BEGIN;/COMMIT; here. The migration runner wraps every file in
-- `BEGIN; SET LOCAL statement_timeout = 0; <this file>; INSERT INTO
-- schema_migrations …; COMMIT;` (embedded-postgres-server/src/migration-runner.js),
-- so this file is ALREADY inside a transaction. An inner COMMIT would end that
-- wrapper early, decoupling the apply from the ledger INSERT — a mid-file failure
-- would then leave schema_migrations claiming success. That also matters more here
-- than usual: the DISABLE/ENABLE of capture_substrate_outbox_trg below is only safe
-- because it is atomic with the DELETEs it brackets. Enforced by lint:migrations /
-- lint-migrations.test.ts (audit P-074, EI-170). plpgsql BEGIN…END inside $$ bodies
-- is unaffected.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Backstop trigger — a retired harness slug cannot land in the plan tables.
--    Reuses harness_shared.canonical_harness_slug(text) from migration 359 (the
--    SQL mirror of RETIRED_HARNESS_SLUG_ALIASES in operator-home-harness.ts).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION harness_shared.canonicalize_plan_harness_slug()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_canonical text := harness_shared.canonical_harness_slug(NEW.harness_slug);
  v_exists    boolean;
BEGIN
  -- Not a retired slug (belt-and-braces; the WHEN clause already filtered) → untouched.
  IF v_canonical IS NULL OR v_canonical = NEW.harness_slug THEN
    RETURN NEW;
  END IF;

  -- Would the canonical row collide? Then this retired-slug write is stale residue
  -- for a plan that already lives in the canonical Pot — drop it silently rather
  -- than overwrite live content (migration 359's precedent).
  IF TG_TABLE_NAME = 'harness_plans' THEN
    SELECT EXISTS (
      SELECT 1 FROM harness_shared.harness_plans
       WHERE workspace_id = NEW.workspace_id
         AND harness_slug = v_canonical
         AND plan_slug    = NEW.plan_slug
    ) INTO v_exists;
  ELSIF TG_TABLE_NAME = 'harness_plan_parts' THEN
    SELECT EXISTS (
      SELECT 1 FROM harness_shared.harness_plan_parts
       WHERE workspace_id = NEW.workspace_id
         AND harness_slug = v_canonical
         AND plan_slug    = NEW.plan_slug
         AND part_key     = NEW.part_key
    ) INTO v_exists;
  ELSE
    v_exists := false;
  END IF;

  IF v_exists THEN
    RETURN NULL; -- BEFORE-trigger skip: the write is discarded, no error raised.
  END IF;

  NEW.harness_slug := v_canonical;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION harness_shared.canonicalize_plan_harness_slug() IS
  'WI-5720 backstop: rewrites a retired harness_slug (papercup/papercup-hive) to its canonical Pot slug on write, or skips the write when the canonical row already exists. Fires only via the triggers WHEN clause, so a normal write pays nothing.';

DROP TRIGGER IF EXISTS harness_plans_canonicalize_slug ON harness_shared.harness_plans;
CREATE TRIGGER harness_plans_canonicalize_slug
  BEFORE INSERT OR UPDATE ON harness_shared.harness_plans
  FOR EACH ROW
  WHEN (NEW.harness_slug IN ('papercup', 'papercup-hive'))
  EXECUTE FUNCTION harness_shared.canonicalize_plan_harness_slug();

DROP TRIGGER IF EXISTS harness_plan_parts_canonicalize_slug ON harness_shared.harness_plan_parts;
CREATE TRIGGER harness_plan_parts_canonicalize_slug
  BEFORE INSERT OR UPDATE ON harness_shared.harness_plan_parts
  FOR EACH ROW
  WHEN (NEW.harness_slug IN ('papercup', 'papercup-hive'))
  EXECUTE FUNCTION harness_shared.canonicalize_plan_harness_slug();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. One-time data fold. MOVE-then-DELETE, never overwrite.
--    NOTE: the triggers above are INERT for these statements — the fold writes
--    harness_slug='papercusp' directly, so the WHEN clause never matches.
-- ─────────────────────────────────────────────────────────────────────────────

-- 2z. Recovery trail FIRST. The dev box runs native PG, so the workspace-dir kopia
--     snapshot does NOT cover harness_shared — these bak_ tables ARE the undo path
--     for the 65 dropped duplicate rows (same convention as bak_20260717_unify_work_items).
--     `IF NOT EXISTS` + the WHERE keeps a re-run inert once the fold has happened.
CREATE TABLE IF NOT EXISTS harness_shared.bak_wi5720_retired_slug_plans AS
  SELECT * FROM harness_shared.harness_plans
   WHERE harness_slug IN ('papercup', 'papercup-hive', 'hive-canary');

CREATE TABLE IF NOT EXISTS harness_shared.bak_wi5720_retired_slug_plan_parts AS
  SELECT * FROM harness_shared.harness_plan_parts
   WHERE harness_slug IN ('papercup', 'papercup-hive', 'hive-canary');

CREATE TABLE IF NOT EXISTS harness_shared.bak_wi5720_retired_slug_plan_revisions AS
  SELECT * FROM harness_shared.plan_revisions
   WHERE harness_slug IN ('papercup', 'papercup-hive', 'hive-canary');

COMMENT ON TABLE harness_shared.bak_wi5720_retired_slug_plans IS
  'WI-5720 undo trail: harness_plans rows under retired/pot-less slugs as they stood before migration 656 folded them into papercusp. Droppable once the fold is confirmed good.';

-- 2a. harness_plans — the plan documents themselves.
INSERT INTO harness_shared.harness_plans (
  workspace_id, harness_slug, plan_slug, title, status, created, updated, owner,
  supersedes, superseded_by, content, content_hash, version, op_status, op_started_at,
  op_updated_at, current_wave, op_priority, archived, is_legacy, created_at, updated_at,
  author_pubkey, origin, items, decisions, now_state, now_next, fed_ts, initiative,
  schedule, schedule_active, scheduled_at, expires_at, tzid, template_slug, run_seq,
  fed_hlc, promote_policy, template, template_data, owner_author_pubkey,
  embedding, embedding_mode
)
SELECT
  workspace_id, 'papercusp', plan_slug, title, status, created, updated, owner,
  supersedes, superseded_by, content, content_hash, version, op_status, op_started_at,
  op_updated_at, current_wave, op_priority, archived, is_legacy, created_at, updated_at,
  author_pubkey, origin, items, decisions, now_state, now_next, fed_ts, initiative,
  schedule, schedule_active, scheduled_at, expires_at, tzid, template_slug, run_seq,
  fed_hlc, promote_policy, template, template_data, owner_author_pubkey,
  embedding, embedding_mode
FROM harness_shared.harness_plans
WHERE harness_slug IN ('papercup', 'papercup-hive', 'hive-canary')
ON CONFLICT (workspace_id, harness_slug, plan_slug) DO NOTHING;

-- ⚠ DELETING a retired-slug row MUST NOT reach the federation capture.
--
-- harness_plans carries `capture_substrate_outbox_trg` (AFTER INSERT OR DELETE), and
-- migration 359 rewrote that capture function to route every op through
-- canonical_harness_slug(). A DELETE of a `papercup` row therefore emits a tombstone
-- keyed (papercusp, <plan_slug>) — against the LIVE plan, not the row being retired.
-- The first run of this migration did exactly that and the projection applied the
-- tombstones, destroying 78 harness_plans rows (repaired by migration 657). Retiring a
-- row under an aliased key is INDISTINGUISHABLE downstream from deleting the canonical
-- row, so the capture must be gated off for this purely-local cleanup: these deletes are
-- residue removal, never content deletions to federate. harness_admin owns the table.
ALTER TABLE harness_shared.harness_plans DISABLE TRIGGER capture_substrate_outbox_trg;

DELETE FROM harness_shared.harness_plans
WHERE harness_slug IN ('papercup', 'papercup-hive', 'hive-canary');

ALTER TABLE harness_shared.harness_plans ENABLE TRIGGER capture_substrate_outbox_trg;

-- 2b. harness_plan_parts — the per-part federation grain behind those plans.
-- (part_fed_key is GENERATED ALWAYS — never listed; PG recomputes it from the new row.)
INSERT INTO harness_shared.harness_plan_parts (
  workspace_id, harness_slug, plan_slug, part_key, kind, body, ordinal, fed_ts,
  author, tombstone, origin, created_at, updated_at, fed_hlc
)
SELECT
  workspace_id, 'papercusp', plan_slug, part_key, kind, body, ordinal, fed_ts,
  author, tombstone, origin, created_at, updated_at, fed_hlc
FROM harness_shared.harness_plan_parts
WHERE harness_slug IN ('papercup', 'papercup-hive', 'hive-canary')
ON CONFLICT (workspace_id, harness_slug, plan_slug, part_key) DO NOTHING;

DELETE FROM harness_shared.harness_plan_parts
WHERE harness_slug IN ('papercup', 'papercup-hive', 'hive-canary');

-- 2c. plan_revisions — the revision spine. Unique on (workspace, harness, plan, seq);
--     a seq already taken on the papercusp spine keeps the papercusp revision.
INSERT INTO harness_shared.plan_revisions (
  workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot,
  rationale, author_kind, author_id, session_id, session_kind, created_at
)
SELECT
  workspace_id, 'papercusp', plan_slug, seq, content_hash, content_snapshot,
  rationale, author_kind, author_id, session_id, session_kind, created_at
FROM harness_shared.plan_revisions
WHERE harness_slug IN ('papercup', 'papercup-hive', 'hive-canary')
ON CONFLICT (workspace_id, harness_slug, plan_slug, seq) DO NOTHING;

DELETE FROM harness_shared.plan_revisions
WHERE harness_slug IN ('papercup', 'papercup-hive', 'hive-canary');
