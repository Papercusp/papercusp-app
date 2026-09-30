-- 651-pot-membership-enforce-trigger.sql
--
-- Owner directive (VERIFIED — owner, interactive, 2026-07-20 11:21, sess a5e7a6e8):
-- "AUDIT ALL WORK ITEMS THEY SHOULD ALL BE PART OF A REAL POT ... WE ADDED
-- SOMETHING TO ENFORCE WORK ITEMS TO BE PART OF A REAL POT, RIGHT?"
-- Plan: pot-membership-enforcement-2026-07-20 (P-006 — the DB-layer backstop).
-- Migration 649 back-filled the existing mis-scoped rows; the app-layer resolver
-- (P-005, packages/operator-core/lib/pot-membership.ts, flag
-- POT_MEMBERSHIP_ENFORCEMENT) stops the drift at the tool paths. THIS is the
-- un-flagged DB backstop: a work-item row cannot be INSERTed (nor its
-- harness_slug UPDATEd) to a slug that is not a real Pot, even by a writer that
-- bypasses the tool layer.
--
-- SAFE BY CONSTRUCTION — the trigger is deliberately narrow so it can never break
-- a live writer it should not:
--   * ORIGIN GATE: federation replicas (origin <> 'local') carry the authoring
--     peer's slug verbatim — never reject them (the projection apply owns them).
--   * WORKSPACE GATE: only workspaces that HAVE a platform Pot
--     (harness_shared.workspace_platform_pot IS NOT NULL — today just
--     papercusp-workspace) are enforced. Un-potted tenants and the isolated
--     'default' / 'generic-test' fixtures fail OPEN, byte-identical to before —
--     this matches the mig-649 backfill scope and the P-005 resolver's fail-open.
--   * MEMBERSHIP CHECK: the (canonicalized) harness_slug must name a real Pot in
--     the row's workspace. canonical_harness_slug folds the legacy dogfood name.
-- The audited live drift (2026-07-20) was 100% issue-family creates via
-- createIssue (operator:<ws> / @singleton scope labels), all already re-homed by
-- P-005; this trigger rejects nothing P-005 lets through and catches any future
-- non-pot write from outside the tool layer.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS ... CREATE
-- TRIGGER. The runner provides the transaction — NO BEGIN/COMMIT here.

-- ── 1. workspace_platform_pot: the workspace's own "self" Pot (or NULL). ───────────
--   The single localized platform-slug assumption (mirrors pot-membership.ts
--   PLATFORM_POT_SLUG + the mig-649 catch-all). When a workspace has no platform
--   Pot, enforcement is skipped for it. Extend this when a second self-hosted
--   workspace gains its own platform Pot.
CREATE OR REPLACE FUNCTION harness_shared.workspace_platform_pot(p_ws text)
  RETURNS text LANGUAGE sql STABLE AS $$
  SELECT pot_home_slug
    FROM harness_shared.pots
   WHERE workspace_id = p_ws AND pot_home_slug = 'papercusp'
   LIMIT 1;
$$;

-- ── 2. pot_membership_ok: does the canonicalized slug name a real Pot here? ─────────
CREATE OR REPLACE FUNCTION harness_shared.pot_membership_ok(p_ws text, p_slug text)
  RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM harness_shared.pots p
     WHERE p.workspace_id = p_ws
       AND p.pot_home_slug = harness_shared.canonical_harness_slug(p_slug)
  );
$$;

-- ── 3. the BEFORE INSERT / UPDATE-OF-harness_slug guard. ────────────────────────────
--   SELF-HEALING, deploy-order-safe: a known workspace-global scope label
--   (operator:<ws> / operator / * / @singleton / all / hive-canary / the bare
--   workspace id) is REWRITTEN to the platform Pot — the same mapping migration 649
--   applied — so a writer that lacks the P-005 app-layer resolver (e.g. an operator
--   still running pre-P-005 code during a rolling deploy) still lands in a REAL Pot
--   instead of failing. Only a genuinely unmappable, made-up slug is REJECTED (a typo
--   must be loud). The app resolver (P-005) already homes these before the row arrives,
--   so for the tool paths the rewrite branch never fires — this is the backstop.
CREATE OR REPLACE FUNCTION harness_shared.assert_work_item_pot_membership()
  RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_platform text;
BEGIN
  -- Federation replicas own their slug — never touch a remote-origin write.
  IF COALESCE(NEW.origin, 'local') <> 'local' THEN RETURN NEW; END IF;
  -- Unscoped / cross-workspace SU rows have no per-workspace Pot set to enforce.
  IF NEW.workspace_id IS NULL OR NEW.workspace_id = '' OR NEW.workspace_id = '*' THEN
    RETURN NEW;
  END IF;
  -- Fail OPEN for a workspace with no platform Pot (isolated fixtures / un-potted tenant).
  v_platform := harness_shared.workspace_platform_pot(NEW.workspace_id);
  IF v_platform IS NULL THEN RETURN NEW; END IF;
  -- Already a real Pot (canonicalized) → nothing to do.
  IF harness_shared.pot_membership_ok(NEW.workspace_id, NEW.harness_slug) THEN
    RETURN NEW;
  END IF;
  -- Not a real Pot. A known workspace-global label self-heals to the platform Pot.
  IF NEW.harness_slug IS NULL OR NEW.harness_slug = ''
     OR NEW.harness_slug LIKE 'operator:%'
     OR NEW.harness_slug IN ('operator', '*', '@singleton', 'all', 'hive-canary')
     OR NEW.harness_slug = NEW.workspace_id THEN
    NEW.harness_slug := v_platform;
    RETURN NEW;
  END IF;
  -- A genuinely unmappable, made-up slug → reject.
  RAISE EXCEPTION
    'pot-membership violation: work_item %/% harness_slug ''%'' is not a real Pot in workspace ''%''',
    NEW.feature_id, NEW.item_kind, NEW.harness_slug, NEW.workspace_id
    USING ERRCODE = 'check_violation',
          HINT = 'Every work item must belong to a real Pot (harness_shared.pots). '
                 'File under a real Pot home slug, or file with no harness to use the '
                 'workspace platform Pot (pot-membership-enforcement-2026-07-20 P-006).';
  RETURN NEW;
END;
$$;

-- Names start with 'pot_membership_' so they fire AFTER the BEFORE-INSERT trigger
-- fill_ws_features_trg ('f' < 'p') has resolved NEW.workspace_id.
DROP TRIGGER IF EXISTS pot_membership_check_ins_trg ON harness_shared.work_items;
CREATE TRIGGER pot_membership_check_ins_trg
  BEFORE INSERT ON harness_shared.work_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.assert_work_item_pot_membership();

DROP TRIGGER IF EXISTS pot_membership_check_upd_trg ON harness_shared.work_items;
CREATE TRIGGER pot_membership_check_upd_trg
  BEFORE UPDATE OF harness_slug ON harness_shared.work_items
  FOR EACH ROW WHEN (NEW.harness_slug IS DISTINCT FROM OLD.harness_slug)
  EXECUTE FUNCTION harness_shared.assert_work_item_pot_membership();
