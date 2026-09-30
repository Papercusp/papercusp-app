-- 652-pot-membership-selfheal-reconcile.sql
--
-- RECONCILIATION (pot-membership-enforcement-2026-07-20 P-006).
--
-- WHY THIS EXISTS: migration 651 was EDITED after it had already applied. The
-- version that applied to the live shared DB (recorded sha 64c344a3…, applied
-- 2026-07-20 13:47:29) was an interim REJECT-ONLY trigger; the file was then
-- edited to the SELF-HEALING, deploy-order-safe version (on-disk sha 7877f7c1…),
-- but the runner applies each migration once BY FILENAME, so it never re-applied
-- and the live DB kept the reject-only function. Result: the live trigger
-- REJECTED every operator-scope write from a path lacking the P-005 app-layer
-- resolver — improvements:capture (harness_slug 'operator:papercusp-workspace')
-- was actively failing with 'not a real Pot' because P-005 is not deployed to
-- :3070 release. The self-heal design exists precisely to make such a
-- pre-P-005 / non-tool writer land in a REAL Pot instead of erroring.
--
-- FIX: re-install the SELF-HEALING trigger function (byte-equal to the on-disk
-- 651 final form). Idempotent CREATE OR REPLACE — a fresh DB that applied the
-- self-heal 651 gets an identical no-op replace; the live DB that applied the
-- reject-only 651 is upgraded to self-heal. Both converge on the same behavior.
-- Migrations are immutable once applied; NEVER edit an applied migration in
-- place — ship a follow-up like this one.
--
-- Behavior (unchanged from the intended 651): origin<>'local' skip; NULL/'' /'*'
-- workspace skip; workspace with no platform Pot fails OPEN; a known
-- workspace-global scope label (operator:<ws> / operator / * / @singleton / all /
-- hive-canary / the bare workspace id) is REWRITTEN to the platform Pot; only a
-- genuinely unmappable, made-up slug is REJECTED (a typo must be loud).
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS ... CREATE
-- TRIGGER. The runner provides the transaction — NO BEGIN/COMMIT here.

-- ── 1. workspace_platform_pot: the workspace's own "self" Pot (or NULL). ───────────
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

-- ── 3. the SELF-HEALING BEFORE INSERT / UPDATE-OF-harness_slug guard. ────────────────
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

-- Recreate the triggers (idempotent) so a DB that never had 651 still gets them.
DROP TRIGGER IF EXISTS pot_membership_check_ins_trg ON harness_shared.work_items;
CREATE TRIGGER pot_membership_check_ins_trg
  BEFORE INSERT ON harness_shared.work_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.assert_work_item_pot_membership();

DROP TRIGGER IF EXISTS pot_membership_check_upd_trg ON harness_shared.work_items;
CREATE TRIGGER pot_membership_check_upd_trg
  BEFORE UPDATE OF harness_slug ON harness_shared.work_items
  FOR EACH ROW WHEN (NEW.harness_slug IS DISTINCT FROM OLD.harness_slug)
  EXECUTE FUNCTION harness_shared.assert_work_item_pot_membership();
