-- 379-maintained-ready-column.sql
--
-- work-item-deps-and-readiness-2026-06-22 P-005 — MAINTAINED readiness (the un-landed half).
--
-- WHAT LANDED BEFORE: only the inline F1 fix — the scheduler claim (claimFloorsWhereSql in
-- work-items.ts) respects blocking via a correlated `NOT EXISTS (work_item_deps … non-terminal
-- blocker)`. Correct, but O(in-degree) recomputed PER CLAIM. P-005 / D-003 wanted readiness
-- MAINTAINED (exact, indexed, NOT cached) so the claim is a plain indexed read.
--
-- SCHEMA REALITY (verified live 2026-06-22): the P-010 unification has LANDED physically —
-- harness_features_consolidated + engineer_issues are auto-updatable VIEWS over
-- harness_shared.work_items (features = item_kind NOT IN (bug,change,task); issues = the rest;
-- engineer_issues.state IS work_items.status). So ONE status column + ONE terminal set
-- {passed,deprecated,resolved,closed} cover both families.
--
-- WHY A SIDECAR, NOT A COLUMN ON work_items (D-007): work_items is FEDERATED. A `ready` column
-- there would replicate a LOCALLY-DERIVED value: stamp_local_federated_write_trg (BEFORE UPDATE)
-- bumps fed_ts on any write, and capture_work_items_feature_upd_trg fires on a whole-row diff —
-- so a readiness flip would federate, and an incoming stale federated `ready` could overwrite a
-- node's local recompute (→ a bee claims blocked work). Readiness must be derived locally on each
-- node from the (federated) edges + statuses. So readiness lives in a LOCAL, NON-FEDERATED sidecar:
--
--   harness_shared.work_item_blocked — PRESENCE of a row = the item is NOT ready (blocked).
--   ABSENCE = ready. Maintained by triggers that write ONLY this table (never work_items), so none
--   of work_items' federation / churn / stamp triggers fire from readiness maintenance.
--
-- The claim (behind a flag, next change) reads `AND NOT EXISTS (work_item_blocked …)` — an indexed
-- anti-join against a SMALL set (only blocked items) — replacing the inline correlated subquery.
-- The inline predicate stays as the reconciliation ORACLE.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS). Backfill at the end.

-- ── 1. The sidecar (local, non-federated) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.work_item_blocked (
    workspace_id text        NOT NULL DEFAULT 'default',
    harness_slug text        NOT NULL,
    feature_id   text        NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, harness_slug, feature_id)
);

COMMENT ON TABLE harness_shared.work_item_blocked IS
  'Maintained readiness sidecar (work-item-deps-and-readiness P-005 / D-007). PRESENCE of a row = the work-item is NOT ready (has >=1 unsatisfied blocks-edge); ABSENCE = ready. LOCAL + non-federated (readiness is derived per-node from the federated work_item_deps + statuses; the value itself must never replicate). Maintained by the wir_* triggers; read by the scheduler claim as an indexed anti-join. The inline NOT EXISTS predicate in claimFloorsWhereSql is the reconciliation oracle.';

-- The PK (workspace_id, harness_slug, feature_id) is exactly the key the claim anti-join probes
-- (claimFloorsWhereSql filters work_items by workspace_id + harness_slug + feature_id), so the
-- claim's `NOT EXISTS (… WHERE wb.workspace_id=f.workspace_id AND wb.harness_slug=f.harness_slug
-- AND wb.feature_id=f.feature_id)` is a single index probe.

-- ── 2. The readiness predicate — MIRROR of claimFloorsWhereSql's inline NOT EXISTS ───────────────
-- Is the FEATURE-family item (p_harness#p_feature) blocked? A blocks-edge is unsatisfied iff its
-- blocker is PRESENT + NON-TERMINAL. Feature blocker: harness-qualified ref, terminal=passed/deprecated.
-- Issue blocker: bare id in ws 'default', terminal=resolved/closed. (Both families live in work_items;
-- the engineer_issues view maps status->state, so issue terminal is on work_items.status too.)
CREATE OR REPLACE FUNCTION harness_shared.work_item_is_blocked(p_harness text, p_feature text)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $$
    SELECT EXISTS (
        SELECT 1
          FROM harness_shared.work_item_deps d
         WHERE d.workspace_id = 'default'
           AND d.dep_type = 'blocks'
           AND d.blocked_ref = p_harness || '#' || p_feature
           AND (
             EXISTS (
               SELECT 1 FROM harness_shared.work_items bf
                WHERE bf.item_kind <> ALL (ARRAY['bug','change','task'])
                  AND (bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref
                  AND bf.status NOT IN ('passed','deprecated')
             )
             OR EXISTS (
               SELECT 1 FROM harness_shared.work_items bi
                WHERE bi.item_kind = ANY (ARRAY['bug','change','task'])
                  AND bi.workspace_id = 'default'
                  AND bi.feature_id = d.blocker_ref
                  AND bi.status NOT IN ('resolved','closed')
             )
           )
    );
$$;

-- ── 3. Sync one feature item's sidecar membership ────────────────────────────
CREATE OR REPLACE FUNCTION harness_shared.sync_work_item_blocked(p_ws text, p_harness text, p_feature text)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF harness_shared.work_item_is_blocked(p_harness, p_feature) THEN
        INSERT INTO harness_shared.work_item_blocked (workspace_id, harness_slug, feature_id, updated_at)
        VALUES (p_ws, p_harness, p_feature, now())
        ON CONFLICT (workspace_id, harness_slug, feature_id) DO UPDATE SET updated_at = now();
    ELSE
        DELETE FROM harness_shared.work_item_blocked
         WHERE workspace_id = p_ws AND harness_slug = p_harness AND feature_id = p_feature;
    END IF;
END;
$$;

-- ── 4. Trigger: a blocks-edge changed → re-sync the BLOCKED feature item ──────
-- Resolves the blocked_ref to its feature-family work_items row(s) (for its real workspace_id) and
-- syncs. Issue-family blocked items are not claimable (claim floor excludes them) so they need no
-- sidecar entry — and their refs are bare ids, never matching 'harness#feature', so the join skips them.
CREATE OR REPLACE FUNCTION harness_shared.wir_deps_sync() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_ref text := COALESCE(NEW.blocked_ref, OLD.blocked_ref);
    r     record;
BEGIN
    IF COALESCE(NEW.dep_type, OLD.dep_type) <> 'blocks' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    FOR r IN
        SELECT f.workspace_id, f.harness_slug, f.feature_id
          FROM harness_shared.work_items f
         WHERE f.item_kind <> ALL (ARRAY['bug','change','task'])
           AND (f.harness_slug || '#' || f.feature_id) = v_ref
    LOOP
        PERFORM harness_shared.sync_work_item_blocked(r.workspace_id, r.harness_slug, r.feature_id);
    END LOOP;
    RETURN COALESCE(NEW, OLD);
-- Best-effort: a readiness-sync error must NEVER wedge the underlying edge write. Drift is caught
-- by the inline-predicate oracle + the reconciliation sweep; the claim falls back to the inline
-- predicate while the flag is off.
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wir_deps_sync: readiness sync failed (non-fatal): %', SQLERRM;
    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS wir_deps_sync_trg ON harness_shared.work_item_deps;
CREATE TRIGGER wir_deps_sync_trg
    AFTER INSERT OR UPDATE OR DELETE ON harness_shared.work_item_deps
    FOR EACH ROW EXECUTE FUNCTION harness_shared.wir_deps_sync();

-- ── 5. Trigger: a work-item's status crossed the TERMINAL boundary → re-sync its DEPENDENTS ──────
-- One-hop, O(in-degree): only the items THIS row blocks can change readiness. Gated by a WHEN clause
-- to the actual terminal crossing (most status writes — todo->wip->in_progress — change nothing).
-- NEW can be a feature blocker (ref 'harness#feature') or an issue blocker (bare feature_id).
CREATE OR REPLACE FUNCTION harness_shared.wir_status_sync_dependents() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT f.workspace_id, f.harness_slug, f.feature_id
          FROM harness_shared.work_item_deps d
          JOIN harness_shared.work_items f
            ON f.item_kind <> ALL (ARRAY['bug','change','task'])
           AND (f.harness_slug || '#' || f.feature_id) = d.blocked_ref
         WHERE d.workspace_id = 'default'
           AND d.dep_type = 'blocks'
           AND (
             d.blocker_ref = NEW.harness_slug || '#' || NEW.feature_id
             OR (NEW.item_kind = ANY (ARRAY['bug','change','task']) AND d.blocker_ref = NEW.feature_id)
           )
    LOOP
        PERFORM harness_shared.sync_work_item_blocked(r.workspace_id, r.harness_slug, r.feature_id);
    END LOOP;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wir_status_sync_dependents: readiness sync failed (non-fatal): %', SQLERRM;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wir_status_sync_dependents_trg ON harness_shared.work_items;
CREATE TRIGGER wir_status_sync_dependents_trg
    AFTER UPDATE OF status ON harness_shared.work_items
    FOR EACH ROW
    WHEN (
      (OLD.status IN ('passed','deprecated','resolved','closed'))
      IS DISTINCT FROM
      (NEW.status IN ('passed','deprecated','resolved','closed'))
    )
    EXECUTE FUNCTION harness_shared.wir_status_sync_dependents();

-- ── 6. Trigger: a new feature item may have pre-existing blocker edges → sync its own membership ──
-- Covers re-import / out-of-order insert (edges before the item). The normal flow (edges added after
-- insert via syncWorkItemDepEdges) is already covered by wir_deps_sync_trg.
CREATE OR REPLACE FUNCTION harness_shared.wir_insert_sync_own() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.item_kind <> ALL (ARRAY['bug','change','task']) THEN
        PERFORM harness_shared.sync_work_item_blocked(NEW.workspace_id, NEW.harness_slug, NEW.feature_id);
    END IF;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wir_insert_sync_own: readiness sync failed (non-fatal): %', SQLERRM;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wir_insert_sync_own_trg ON harness_shared.work_items;
CREATE TRIGGER wir_insert_sync_own_trg
    AFTER INSERT ON harness_shared.work_items
    FOR EACH ROW EXECUTE FUNCTION harness_shared.wir_insert_sync_own();

-- ── 7. Trigger: a deleted item leaves no stale sidecar row ────────────────────
CREATE OR REPLACE FUNCTION harness_shared.wir_delete_cleanup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    DELETE FROM harness_shared.work_item_blocked
     WHERE workspace_id = OLD.workspace_id AND harness_slug = OLD.harness_slug AND feature_id = OLD.feature_id;
    RETURN OLD;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wir_delete_cleanup: readiness sync failed (non-fatal): %', SQLERRM;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS wir_delete_cleanup_trg ON harness_shared.work_items;
CREATE TRIGGER wir_delete_cleanup_trg
    AFTER DELETE ON harness_shared.work_items
    FOR EACH ROW EXECUTE FUNCTION harness_shared.wir_delete_cleanup();

-- ── 8. Backfill — seed the blocked-set from the current graph ─────────────────
-- Only feature-family items that are actually blocked get a row (absence = ready is the default).
INSERT INTO harness_shared.work_item_blocked (workspace_id, harness_slug, feature_id)
SELECT f.workspace_id, f.harness_slug, f.feature_id
  FROM harness_shared.work_items f
 WHERE f.item_kind <> ALL (ARRAY['bug','change','task'])
   AND harness_shared.work_item_is_blocked(f.harness_slug, f.feature_id)
ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING;
