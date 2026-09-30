-- 360-harness-docs-workspace-restamp.sql
--
-- workspace-data-isolation-leaks-2026-06-17 P-002 (docs sub-part) / D-003 — the
-- harness_docs leg of the WI-148 workspace-identity reconciliation, the docs analog
-- of migration 295's plan/feature/issue re-stamp.
--
-- LOCKSTEP with the harness/docs/* resolver flip (doc-record / merged-read /
-- manual-anchor / migrate-fs-docs / provenance / sweep-after-sync now DERIVE the
-- workspace from the harness via resolveWorkspaceForHarness → PAPERCUSP_WORKSPACE_ID
-- for the operator-home 'papercusp' harness, instead of silently defaulting an omitted
-- workspace to 'default'). The code flip and this data move MUST ship together: the
-- flip WITHOUT the move sends every papercusp Docs read to an EMPTY papercusp-workspace
-- (blank Docs tab) and strands new writes; the move WITHOUT the flip leaves reads on
-- 'default'. The embedded-pg deploy applies migrations-before-serve, so they land atomically.
--
-- WHAT: migration 295 moved papercup's plan/feature/issue rows 'default' →
-- 'papercusp-workspace' but NOT harness_shared.harness_docs (mig 172 — added after, and
-- not in 295's table list). So the operator-home harness's 14 doc records sit stranded
-- under workspace_id='default' (live census 2026-06-22: 14 rows, ALL default/'papercusp',
-- ZERO in 'papercusp-workspace'). Re-stamp them to the real workspace.
--
-- SAFE BY CONSTRUCTION:
--   * SCOPED to the operator-home harness slug 'papercusp' → 'papercusp-workspace'
--     (= PAPERCUSP_WORKSPACE_ID, the WI-148 part-B target). Other harnesses have NO
--     doc rows; genuine-'default' / operator-scoped rows are untouched.
--   * COLLISION-SAFE + IDEMPOTENT: moves a row only when no row with the same
--     (harness_slug, doc_id) already exists in 'papercusp-workspace' (the PK columns),
--     so a re-run is a no-op and a partial prior move never conflicts.
--   * In-txn GUARD: RAISE (→ rollback) if any 'papercusp' doc row is left under
--     'default' after the move (lockstep with the resolver flip → would blank Docs).
--
-- The embedded-pg migration runner wraps this file in ONE transaction; a failure
-- (incl. the guard) rolls the whole move back and restores the trigger. No
-- \set / BEGIN / COMMIT here (the runner owns the txn).

-- ── 0. quiet the updated_at trigger during the bulk re-stamp ──────────────────
-- harness_docs carries NO substrate_outbox/CDC capture trigger (mig 172 defines only
-- harness_docs_updated_at_trg); a workspace-id correction is not a doc edit, so disable
-- the updated_at bump for the txn so updated_at keeps tracking real content edits. The
-- runner's txn rollback restores it on any failure; the explicit ENABLE below restores
-- it on success.
ALTER TABLE harness_shared.harness_docs DISABLE TRIGGER harness_docs_updated_at_trg;

-- ── 1. re-stamp 'default' → 'papercusp-workspace' for the operator-home harness ─
UPDATE harness_shared.harness_docs t
   SET workspace_id = 'papercusp-workspace'
 WHERE t.workspace_id = 'default'
   AND t.harness_slug = 'papercusp'
   AND NOT EXISTS (
     SELECT 1 FROM harness_shared.harness_docs e
      WHERE e.workspace_id = 'papercusp-workspace'
        AND e.harness_slug = t.harness_slug
        AND e.doc_id = t.doc_id
   );

-- ── 2. in-txn GUARD: 'papercusp' MUST be fully evacuated from 'default' (lockstep
--       with the resolver flip → papercusp-workspace). Any residual = abort. ────
DO $hd360$
DECLARE leftover bigint;
BEGIN
  SELECT count(*) INTO leftover FROM harness_shared.harness_docs
   WHERE workspace_id = 'default' AND harness_slug = 'papercusp';
  IF leftover > 0 THEN
    RAISE EXCEPTION 'mig-360 guard: % papercusp harness_docs row(s) still under default after re-stamp — aborting (the resolver flip would blank the Docs tab)', leftover;
  END IF;
END $hd360$;

-- ── 3. restore the updated_at trigger (success path; rollback also restores it) ─
ALTER TABLE harness_shared.harness_docs ENABLE TRIGGER harness_docs_updated_at_trg;
