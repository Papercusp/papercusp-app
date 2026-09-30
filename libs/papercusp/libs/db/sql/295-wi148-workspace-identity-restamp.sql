-- 295-wi148-workspace-identity-restamp.sql
--
-- WI-148 Part B — workspace-identity reconciliation DATA MOVE (D-014/D-017).
-- Owner-gated; GO 2026-06-16. LOCKSTEP with the plans/source.ts resolver flip
-- (papercup → PAPERCUSP_WORKSPACE_ID) shipped in the SAME release — applied
-- atomically on the :3070 deploy-restart (deploy.ts: migrations-before-serve →
-- health + papercup-read path-verify → rollback-on-fail). Data-move-without-flip
-- OR flip-without-move each 404 every papercup read (su-833's footgun), so they
-- MUST land together.
--
-- WHAT: papercup's (and every other papercusp-workspace harness's) plan/feature/
-- issue rows are stranded under workspace_id='default' while the Queen + hive
-- infra survey 'papercusp-workspace' → empty frontier → idle. Re-stamp each
-- 'default' row to its harness's REAL workspace, resolved from the authoritative
-- harness_registry payload. Scratch-verified (papercusp_wi148_scratch): the
-- papercusp-workspace Queen frontier went 14 → 69; counts reconciled per table.
--
-- SAFE BY CONSTRUCTION:
--   * Registry-driven + COLLISION-SAFE: move a 'default' row only when its
--     harness maps to exactly ONE non-default workspace (a slug in >1 non-default
--     workspace, or in none, is LEFT — fail-safe). So genuine-'default' harnesses
--     (e.g. sheets/papercup-org/restart — owner DEFERRED) and operator/all-scoped
--     rows are untouched.
--   * IDEMPOTENT: re-running only moves rows still under 'default'; the projects
--     seed is NOT-EXISTS guarded.
--   * In-txn GUARD: RAISE (→ rollback) if any papercup plan row is left behind.
--
-- The embedded-pg migration runner wraps this file in ONE transaction, so a
-- failure (incl. the guard) rolls back the whole move + re-enables the triggers.
-- No \set / BEGIN / COMMIT here (the runner owns the txn).

-- ── 0. quiet the federation/CDC capture during the bulk re-stamp ──────────────
-- The AFTER-UPDATE capture trigger on the two CDC tables would enqueue one
-- substrate_outbox row per re-stamped feature/issue (~185) — a needless local
-- federation spike for a workspace-id correction. DISABLE for the txn; the
-- runner's txn rollback restores them on any failure, and the explicit ENABLE
-- below restores them on success.
ALTER TABLE harness_shared.harness_features_consolidated DISABLE TRIGGER capture_substrate_outbox_trg;
ALTER TABLE harness_shared.harness_features_consolidated DISABLE TRIGGER capture_substrate_outbox_upd_trg;
ALTER TABLE harness_shared.harness_issues_consolidated   DISABLE TRIGGER capture_substrate_outbox_trg;
ALTER TABLE harness_shared.harness_issues_consolidated   DISABLE TRIGGER capture_substrate_outbox_upd_trg;

-- ── 1. harness slug → its UNIQUE non-default workspace (collision-safe map) ────
-- Session-scoped temp (NOT ON COMMIT DROP) + explicit DROP at the end, so the
-- file is correct under BOTH the migration runner's single-txn wrap AND a plain
-- psql -f (autocommit) — the table must outlive each statement's implicit commit.
DROP TABLE IF EXISTS _wi148_ws_map;
CREATE TEMP TABLE _wi148_ws_map AS
SELECT slug, real_ws FROM (
  SELECT slug, max(workspace_id) AS real_ws, count(*) AS n FROM (
    SELECT DISTINCT r.workspace_id, p->>'slug' AS slug
      FROM harness_shared.harness_registry r,
           jsonb_array_elements(COALESCE(r.payload->'projects','[]'::jsonb)) p
     WHERE r.workspace_id NOT IN ('default','*','scratch')
  ) d GROUP BY slug
) m WHERE n = 1;

-- ── 2. seed the missing papercup projects row (NOT-EXISTS guard; slug has no
--       unique constraint) so the fill_workspace_id_from_projects BEFORE-INSERT
--       trigger stamps FUTURE papercup features into papercusp-workspace, not
--       'default' (else the split silently re-opens). ────────────────────────
INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
SELECT 'proj-papercup-wi148', 'Papercup', 'active', 'papercup', 'papercusp-workspace',
       (EXTRACT(EPOCH FROM now())*1000)::bigint, (EXTRACT(EPOCH FROM now())*1000)::bigint
 WHERE NOT EXISTS (SELECT 1 FROM harness_shared.projects WHERE slug = 'papercup');

-- ── 3. re-stamp 'default' → real workspace, per table (harness-keyed) ─────────
UPDATE harness_shared.harness_plans t            SET workspace_id = m.real_ws FROM _wi148_ws_map m WHERE t.workspace_id='default' AND t.harness_slug = m.slug;
UPDATE harness_shared.plan_revisions t           SET workspace_id = m.real_ws FROM _wi148_ws_map m WHERE t.workspace_id='default' AND t.harness_slug = m.slug;
UPDATE harness_shared.plan_item_claims t         SET workspace_id = m.real_ws FROM _wi148_ws_map m WHERE t.workspace_id='default' AND t.harness_slug = m.slug;
UPDATE harness_shared.harness_features_consolidated t SET workspace_id = m.real_ws FROM _wi148_ws_map m WHERE t.workspace_id='default' AND t.harness_slug = m.slug;
UPDATE harness_shared.decision_ledger t          SET workspace_id = m.real_ws FROM _wi148_ws_map m WHERE t.workspace_id='default' AND t.harness_slug = m.slug;
-- engineer_issues are harness-scoped via scope='harness:<slug>' (operator/all-scoped LEFT).
UPDATE harness_shared.engineer_issues t          SET workspace_id = m.real_ws FROM _wi148_ws_map m WHERE t.workspace_id='default' AND t.scope = 'harness:' || m.slug;

-- ── 4. in-txn GUARD: papercup MUST be fully evacuated from 'default' (lockstep
--       with the resolver flip → papercusp-workspace). Any residual = abort. ──
DO $wi148$
DECLARE leftover bigint;
BEGIN
  SELECT count(*) INTO leftover FROM harness_shared.harness_plans
   WHERE workspace_id='default' AND harness_slug='papercup';
  IF leftover > 0 THEN
    RAISE EXCEPTION 'WI-148 guard: % papercup plan row(s) still under default after re-stamp — aborting (resolver flip would 404)', leftover;
  END IF;
END $wi148$;

-- ── 5. restore the capture triggers (success path; rollback also restores them) ─
ALTER TABLE harness_shared.harness_features_consolidated ENABLE TRIGGER capture_substrate_outbox_trg;
ALTER TABLE harness_shared.harness_features_consolidated ENABLE TRIGGER capture_substrate_outbox_upd_trg;
ALTER TABLE harness_shared.harness_issues_consolidated   ENABLE TRIGGER capture_substrate_outbox_trg;
ALTER TABLE harness_shared.harness_issues_consolidated   ENABLE TRIGGER capture_substrate_outbox_upd_trg;

DROP TABLE _wi148_ws_map;
