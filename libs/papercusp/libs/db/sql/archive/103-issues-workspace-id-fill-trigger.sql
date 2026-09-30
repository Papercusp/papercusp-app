-- 103-issues-workspace-id-fill-trigger.sql
--
-- Feature-content + issue federation, Stage 1 fix.
-- Plan: papercusp-feature-content-federation-2026-06-01.
--
-- BUG (confirmed): the Stage-1 capture trigger (migration 102) copies
-- substrate_outbox.workspace_id from the consolidated row's workspace_id. For
-- FEATURES that column is real; for ISSUES it was always '' — so issue outbox
-- rows get workspace_id='' and the Stage-3 drain (keyed on the booted harness's
-- REAL workspaceId) would never match them → issues would silently never
-- federate. (Verified live: all harness_issues_consolidated rows had
-- workspace_id=''.)
--
-- ROOT CAUSE — and why this is NOT what the plan first guessed. The plan said
-- "mirror migration 012 by patching sync_issues_consolidated()". That function
-- is DEAD: migration 032 dropped the per-harness physical tables and replaced
-- them with auto-updatable VIEWs over the *_consolidated tables, so writes now
-- hit the consolidated tables DIRECTLY and no trigger calls
-- sync_issues_consolidated()/sync_features_consolidated() anymore (verified live:
-- both functions exist but are attached to zero triggers). The mechanism that
-- ACTUALLY populates features' workspace_id today is a BEFORE INSERT trigger
-- `fill_ws_features_trg` running `harness_shared.fill_workspace_id_from_projects()`
-- on harness_features_consolidated. That function resolves workspace_id from
-- harness_shared.projects by slug, falling back to 'default'. ISSUES had no such
-- trigger — hence the '' values.
--
-- FIX (faithful to the live features mechanism, not the dead one):
--   1. (RE)DEFINE harness_shared.fill_workspace_id_from_projects() in source.
--      It currently exists ONLY as an ad-hoc object on the dev box — it was
--      never committed to a migration (a separate drift). Capturing it here with
--      CREATE OR REPLACE means a FRESH embedded-pg boot gets it too (the G1
--      fresh-boot-parity lesson), and keeps features + issues on ONE function.
--   2. Attach `fill_ws_issues_trg` BEFORE INSERT on harness_issues_consolidated,
--      mirroring fill_ws_features_trg. BEFORE-INSERT fires before the row is
--      stored, so the AFTER-INSERT capture trigger (102) sees the filled
--      workspace_id and enqueues the real value.
--   3. Backfill the existing workspace_id='' issue rows from projects.
--
-- Named dollar-quote ($body$, NOT $$) per the repo PG-migration convention.
-- Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE.
-- No \set / BEGIN / COMMIT: the embedded-pg migration runner strips psql
-- metacommands and wraps each file in its own txn.

-- ── 1. the fill function (captured into source; features + issues share it) ────
CREATE OR REPLACE FUNCTION harness_shared.fill_workspace_id_from_projects()
RETURNS TRIGGER AS $body$
BEGIN
  IF NEW.workspace_id IS NULL OR NEW.workspace_id = '' THEN
    SELECT workspace_id INTO NEW.workspace_id
      FROM harness_shared.projects WHERE slug = NEW.harness_slug LIMIT 1;
    IF NEW.workspace_id IS NULL OR NEW.workspace_id = '' THEN
      NEW.workspace_id := 'default';
    END IF;
  END IF;
  RETURN NEW;
END;
$body$ LANGUAGE plpgsql;

-- ── 1b. parity: ensure features also carries the trigger from source ──────────
-- (It exists ad-hoc on the dev box as fill_ws_features_trg, but was never in a
-- migration. Re-assert it so a fresh boot gets features' workspace_id too.)
DROP TRIGGER IF EXISTS fill_ws_features_trg
  ON harness_shared.harness_features_consolidated;
CREATE TRIGGER fill_ws_features_trg
  BEFORE INSERT ON harness_shared.harness_features_consolidated
  FOR EACH ROW EXECUTE FUNCTION harness_shared.fill_workspace_id_from_projects();

-- ── 2. the issues trigger (the actual fix) ────────────────────────────────────
DROP TRIGGER IF EXISTS fill_ws_issues_trg
  ON harness_shared.harness_issues_consolidated;
CREATE TRIGGER fill_ws_issues_trg
  BEFORE INSERT ON harness_shared.harness_issues_consolidated
  FOR EACH ROW EXECUTE FUNCTION harness_shared.fill_workspace_id_from_projects();

-- ── 3. backfill existing empty-workspace_id issue rows ────────────────────────
UPDATE harness_shared.harness_issues_consolidated AS i
   SET workspace_id = COALESCE(NULLIF(p.workspace_id, ''), 'default')
  FROM harness_shared.projects AS p
 WHERE p.slug = i.harness_slug
   AND (i.workspace_id IS NULL OR i.workspace_id = '');

-- Any issue whose harness has no projects row still gets 'default' (mirrors the
-- function's fallback) so the drain has a non-empty key to match on.
UPDATE harness_shared.harness_issues_consolidated
   SET workspace_id = 'default'
 WHERE workspace_id IS NULL OR workspace_id = '';
