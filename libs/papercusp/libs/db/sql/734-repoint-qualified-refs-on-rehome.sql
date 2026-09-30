-- 734-repoint-qualified-refs-on-rehome.sql
--
-- EI-19374236094682800 — a pot/harness RE-HOME leaves stale harness-qualified refs
-- in the coordination plane, silently deactivating every edge that names the old slug.
--
-- ── The defect ────────────────────────────────────────────────────────────────────
-- A feature-family endpoint is stored as '<harness_slug>#<feature_id>' and matched by
-- its FULL qualified ref. When a work item's harness_slug changes, every ref naming the
-- OLD slug resolves to nothing — the edge is still form-valid, still mirrored, still
-- counted by every row-shape check, and INERT. For a `blocks` edge that is a live
-- dependency the claim floor cannot see; for a coord_thread it is work-item-scoped
-- direction (comments) orphaned from the item it belongs to.
--
-- ── Why this is NOT a one-time backfill artifact ──────────────────────────────────
-- The obvious reading is "migration 649 re-homed ~2448 rows and forgot the refs", and
-- 649 is indeed where the measured residue comes from (its rename table maps exactly
-- onto the stale slugs found live: oddsmith->oddsmith-hive, papercup->papercusp,
-- papercusp-public-site->papercusp-public-site-pot, hiveloop->hiveloop-hive,
-- shared-hive-test->shared-hive-test-hive, plus its 'papercusp' catch-all).
--
-- But re-home is CONTINUOUS, not historical. `assert_work_item_pot_membership` (the
-- BEFORE trigger installed by 651/652) REWRITES `NEW.harness_slug := v_platform` on any
-- local write carrying a workspace-global scope label. Every one of those rewrites
-- strands any qualified ref naming the old slug, forever, silently. So the durable fix
-- has to live at the seam, not in a repair script.
--
-- ── Why a trigger, and why THIS trigger ───────────────────────────────────────────
-- AFTER UPDATE OF harness_slug on work_items is the one chokepoint every re-home passes
-- through: the self-heal BEFORE trigger's own rewrite (a BEFORE trigger mutates NEW, so
-- the AFTER trigger sees the real OLD->NEW pair), a migration/backfill UPDATE, an import,
-- and a hand-written SQL fix all land here. App-layer code cannot be the seam because
-- SQL re-homes bypass it — 649 was exactly that.
--
-- ⚠ A future bulk backfill that DISABLEs triggers to avoid a federation spike (as 649
-- did, by name) must NOT include repoint_qualified_refs_trg in that list, or it
-- re-creates this defect wholesale.
--
-- ⚠⚠ EI-19389225060317498: THAT WARNING IS INCOMPLETE ON ITS OWN — a SECOND trigger is
-- equally load-bearing and is not named above. `work_item_deps` UPDATEs done by
-- repoint_qualified_refs() (below) only resync the `work_item_blocked` readiness
-- sidecar as a CASCADE through `wir_deps_sync_trg` (migration 379). Preserving
-- repoint_qualified_refs_trg while disabling wir_deps_sync_trg for the same reason
-- (avoiding trigger-cascade overhead on a big UPDATE) repoints every ref correctly and
-- STILL silently strands readiness at the OLD harness_slug — measured in
-- rename-drift-effectiveness.integration.test.ts ("and it is wir_deps_sync_trg doing
-- it"). Any future trigger-disable window for a bulk re-home must keep BOTH
-- repoint_qualified_refs_trg (work_items) AND wir_deps_sync_trg (work_item_deps)
-- enabled, or re-run a readiness reconciliation sweep before serving claims again. A
-- boot-time guard now detects (does not prevent) this: see
-- packages/operator-core/lib/startup/validate-repoint-triggers.ts.
--
-- ── Deliberately NOT scoped by workspace_id ───────────────────────────────────────
-- This looks like it violates the multi-tenant "scope both workspace_id AND slug" rule.
-- It does not, and scoping here would BREAK it: the coordination plane writes its rows
-- under DEFAULT_COORD_WORKSPACE ('default') while the work_items row being re-homed
-- lives in e.g. 'papercusp-workspace' — measured live, 73 of the 75 stale coord_links
-- refs sit in 'default' pointing at 'papercusp-workspace' items. A workspace-scoped
-- match would silently repair nothing.
-- It is SAFE because a qualified ref is globally unique: feature_ids are global
-- (WI-/EI-/F-...) and the work_items PK is (harness_slug, feature_id) with NO
-- workspace_id, so '<slug>#<id>' identifies exactly one logical item everywhere. This is
-- the same reasoning `resolveDepEndpoint` documents for its own unscoped family lookup.
--
-- ── Collision handling differs BY TABLE, and the difference is load-bearing ────────
-- Re-pointing can collide with a row that already sits at the new ref. All three tables
-- have a unique index that would raise — and raising here would abort the RE-HOME
-- itself, i.e. a stale ref could start rejecting ordinary work-item writes. So each
-- collision is resolved, never allowed to surface:
--   * coord_links / work_item_deps — an edge is a pure RELATION carrying no payload, so
--     a duplicate is redundant by definition: DELETE the stale row, keep the existing one.
--   * coord_threads — a thread OWNS POSTS (post_count, posts keyed by thread_id).
--     Deleting one destroys work-item comments, so on collision the stale thread is LEFT
--     IN PLACE, untouched. A ref that stays stale is a reporting problem; a deleted
--     thread is unrecoverable data loss. Never trade the second for the first.
--
-- Idempotent: CREATE OR REPLACE + DROP TRIGGER IF EXISTS; the backfill only ever sees
-- rows that are still stale, so a re-run is a no-op.
-- The migration runner provides the transaction — NO BEGIN/COMMIT here.

-- ── 1. the re-point primitive (shared by the trigger and the backfill) ────────────
CREATE OR REPLACE FUNCTION harness_shared.repoint_qualified_refs(
  p_old_slug text, p_new_slug text, p_feature_id text)
RETURNS void LANGUAGE plpgsql AS $rq$
DECLARE
  v_old text;
  v_new text;
BEGIN
  IF p_old_slug IS NULL OR p_new_slug IS NULL OR p_feature_id IS NULL
     OR p_old_slug = '' OR p_new_slug = '' OR p_feature_id = ''
     OR p_old_slug = p_new_slug THEN
    RETURN;
  END IF;
  v_old := p_old_slug || '#' || p_feature_id;
  v_new := p_new_slug || '#' || p_feature_id;

  -- coord_links, src side. Dedup FIRST (coord_links_edge_uq), then re-point.
  DELETE FROM harness_shared.coord_links a
   WHERE a.src_kind = 'feature' AND a.src_ref = v_old
     AND EXISTS (SELECT 1 FROM harness_shared.coord_links b
                  WHERE b.workspace_id = a.workspace_id
                    AND b.src_kind = a.src_kind AND b.src_ref = v_new
                    AND b.dst_kind = a.dst_kind AND b.dst_ref = a.dst_ref
                    AND b.rel = a.rel);
  UPDATE harness_shared.coord_links
     SET src_ref = v_new
   WHERE src_kind = 'feature' AND src_ref = v_old;

  -- coord_links, dst side (same invariant, same index).
  DELETE FROM harness_shared.coord_links a
   WHERE a.dst_kind = 'feature' AND a.dst_ref = v_old
     AND EXISTS (SELECT 1 FROM harness_shared.coord_links b
                  WHERE b.workspace_id = a.workspace_id
                    AND b.src_kind = a.src_kind AND b.src_ref = a.src_ref
                    AND b.dst_kind = a.dst_kind AND b.dst_ref = v_new
                    AND b.rel = a.rel);
  UPDATE harness_shared.coord_links
     SET dst_ref = v_new
   WHERE dst_kind = 'feature' AND dst_ref = v_old;

  -- work_item_deps, blocked side (work_item_deps_edge_uniq).
  DELETE FROM harness_shared.work_item_deps a
   WHERE a.blocked_kind = 'feature' AND a.blocked_ref = v_old
     AND EXISTS (SELECT 1 FROM harness_shared.work_item_deps b
                  WHERE b.workspace_id = a.workspace_id
                    AND b.blocked_kind = a.blocked_kind AND b.blocked_ref = v_new
                    AND b.blocker_kind = a.blocker_kind AND b.blocker_ref = a.blocker_ref
                    AND b.dep_type = a.dep_type);
  UPDATE harness_shared.work_item_deps
     SET blocked_ref = v_new
   WHERE blocked_kind = 'feature' AND blocked_ref = v_old;

  -- work_item_deps, blocker side.
  DELETE FROM harness_shared.work_item_deps a
   WHERE a.blocker_kind = 'feature' AND a.blocker_ref = v_old
     AND EXISTS (SELECT 1 FROM harness_shared.work_item_deps b
                  WHERE b.workspace_id = a.workspace_id
                    AND b.blocked_kind = a.blocked_kind AND b.blocked_ref = a.blocked_ref
                    AND b.blocker_kind = a.blocker_kind AND b.blocker_ref = v_new
                    AND b.dep_type = a.dep_type);
  UPDATE harness_shared.work_item_deps
     SET blocker_ref = v_new
   WHERE blocker_kind = 'feature' AND blocker_ref = v_old;

  -- coord_threads. NEVER delete on collision (a thread owns posts) — skip instead, so a
  -- collided thread keeps its comments and merely stays reportable.
  UPDATE harness_shared.coord_threads t
     SET parent_ref = v_new
   WHERE t.parent_kind = 'feature' AND t.parent_ref = v_old
     AND NOT EXISTS (SELECT 1 FROM harness_shared.coord_threads u
                      WHERE u.workspace_id = t.workspace_id
                        AND u.parent_kind = t.parent_kind
                        AND u.parent_ref = v_new);
END;
$rq$;

-- ── 2. the seam: fire it on every harness_slug change ─────────────────────────────
CREATE OR REPLACE FUNCTION harness_shared.repoint_qualified_refs_on_rehome()
RETURNS trigger LANGUAGE plpgsql AS $rt$
BEGIN
  PERFORM harness_shared.repoint_qualified_refs(OLD.harness_slug, NEW.harness_slug, NEW.feature_id);
  RETURN NULL;  -- AFTER trigger: return value is ignored
END;
$rt$;

DROP TRIGGER IF EXISTS repoint_qualified_refs_trg ON harness_shared.work_items;
CREATE TRIGGER repoint_qualified_refs_trg
AFTER UPDATE OF harness_slug ON harness_shared.work_items
FOR EACH ROW
WHEN (OLD.harness_slug IS DISTINCT FROM NEW.harness_slug)
EXECUTE FUNCTION harness_shared.repoint_qualified_refs_on_rehome();

-- ── 3. one-time backfill of the residue already on disk ───────────────────────────
-- Only UNAMBIGUOUS refs are repaired. Two shapes are deliberately left alone, because
-- they need different (and opposite) repairs that this migration must not guess at:
--   * bare id resolves NOWHERE  -> a genuinely stale ref (the item was deleted or never
--     created). The repair is to DELETE the edge, which is a judgment call about a real
--     dependency; measured live: 10 'research-desk' refs.
--   * bare id resolves to MORE THAN ONE harness -> the target is ambiguous; picking one
--     would invent a dependency. Measured live: 'hiveloop' ids present under three slugs.
-- Both remain visible to reconcileWorkItemDepEndpoints, which reports `bare_id_found_in`
-- precisely so a human can tell these two apart.
DO $bf734$
DECLARE
  r record;
  v_fixed int := 0;
BEGIN
  FOR r IN
    WITH refs AS (
      SELECT DISTINCT src_ref AS ref FROM harness_shared.coord_links
       WHERE src_kind = 'feature' AND strpos(src_ref, '#') > 0
      UNION
      SELECT DISTINCT dst_ref FROM harness_shared.coord_links
       WHERE dst_kind = 'feature' AND strpos(dst_ref, '#') > 0
      UNION
      SELECT DISTINCT blocked_ref FROM harness_shared.work_item_deps
       WHERE blocked_kind = 'feature' AND strpos(blocked_ref, '#') > 0
      UNION
      SELECT DISTINCT blocker_ref FROM harness_shared.work_item_deps
       WHERE blocker_kind = 'feature' AND strpos(blocker_ref, '#') > 0
      UNION
      SELECT DISTINCT parent_ref FROM harness_shared.coord_threads
       WHERE parent_kind = 'feature' AND strpos(parent_ref, '#') > 0
    ),
    split AS (
      -- Split on the LAST '#', identical to reconcileWorkItemDepEndpoints, so a slug
      -- containing a '#' cannot truncate the id. Must not drift from that detector.
      SELECT ref,
             substring(ref from 1 for length(ref) - strpos(reverse(ref), '#')) AS old_slug,
             substring(ref from length(ref) - strpos(reverse(ref), '#') + 2)  AS bare_id
        FROM refs
    )
    SELECT s.old_slug, s.bare_id, t.slug AS new_slug
      FROM split s
      JOIN LATERAL (
        SELECT min(w.harness_slug) AS slug, count(DISTINCT w.harness_slug) AS n
          FROM harness_shared.work_items w
         WHERE w.feature_id = s.bare_id
      ) t ON t.n = 1
     WHERE s.old_slug <> t.slug
       AND NOT EXISTS (SELECT 1 FROM harness_shared.work_items w2
                        WHERE w2.feature_id = s.bare_id
                          AND w2.harness_slug = s.old_slug)
  LOOP
    PERFORM harness_shared.repoint_qualified_refs(r.old_slug, r.new_slug, r.bare_id);
    v_fixed := v_fixed + 1;
  END LOOP;
  RAISE NOTICE '734: re-pointed % stale qualified ref group(s) left by earlier re-homes', v_fixed;
END
$bf734$;
