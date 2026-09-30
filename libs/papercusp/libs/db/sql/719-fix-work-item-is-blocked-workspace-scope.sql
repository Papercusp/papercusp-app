-- 719 — work_item_is_blocked(): resolve blockers in the BLOCKED ITEM'S workspace.
--
-- THE BUG (EI-19313459163394127, work-item-dependency-edges-2026-08-02 P-001).
-- Migration 640's oracle resolved a blocker ref like this:
--
--     -- feature leg: NO workspace predicate at all
--     EXISTS (SELECT 1 FROM work_items bf
--              WHERE (bf.harness_slug||'#'||bf.feature_id) = d.blocker_ref AND ...)
--     -- issue leg: workspace HARDCODED to 'default'
--     OR EXISTS (SELECT 1 FROM work_items bi
--                 WHERE bi.workspace_id = 'default' AND bi.feature_id = d.blocker_ref AND ...)
--
-- Both legs were wrong, in opposite directions:
--
--   * ISSUE leg (the damaging one) — issue-family work items live in
--     'papercusp-workspace' (27,893 rows), not 'default' (147). So the blocker was
--     never found; "an absent blocker never blocks" then let the item through.
--     Measured 2026-08-02: of 94 blocks-edges, 32 have an issue-family blocker and
--     32 of 32 were inert — 10 with a live non-terminal blocker, leaving 9 work
--     items claimable that should have been gated. EVERY issue-family blocking
--     edge in the system did nothing.
--
--   * FEATURE leg — no workspace predicate at all. This one is DEFENSIVE, not a live
--     bug: work_items' PK is (harness_slug, feature_id), so a harness-qualified ref
--     resolves to exactly one row and cannot cross-match today (measured: 0 rows share
--     a (harness_slug, feature_id) across workspaces, and 0 of the 54 feature-blocker
--     edges are cross-workspace, so adding the predicate changes no current verdict).
--     It is scoped anyway so both legs state the same rule, and so the leg stays
--     correct if that PK ever gains workspace_id — which is exactly the open question
--     in work-item-deps-and-readiness-2026-06-22 P-010.
--
-- The failure was invisible to every existing guard: it is PERMISSIVE (no error,
-- no log, no red test), and the drift detector cannot see it because the sidecar
-- and the oracle AGREE — the triggers faithfully materialize a predicate that is
-- itself wrong (reconcileReadiness reported missing=0/extra=0 while 10 edges were
-- silently dead).
--
-- THE FIX. A blocker ref resolves within the SAME workspace as the blocked item.
-- Verified against live data: for every existing papercusp edge, both endpoints
-- are in 'papercusp-workspace' — the intended semantics all along.
--
-- The workspace is now a REQUIRED third argument rather than a defaulted one, and
-- the 2-arg form is deleted rather than kept as a convenience wrapper. A defaulted
-- workspace would just reintroduce the bug: the whole defect was a caller that had
-- the right workspace in hand (sync_work_item_blocked receives p_ws and keys the
-- sidecar row with it) and silently dropped it. Making the argument mandatory turns
-- "forgot the workspace" into a call-site error instead of a wrong boolean, at every
-- present and future caller.
--
-- The issue leg genuinely needs it: blocker_ref there is a BARE feature_id
-- (issues:link), which is NOT unique on its own — 66 bare issue ids span more than
-- one harness_slug today — so bare-ref matching without a scope can select a foreign
-- row. The feature leg is scoped for symmetry (see below).
--
-- NOTE on `d.workspace_id = 'default'`, which is deliberately UNCHANGED: that is
-- the COORDINATION workspace the edge table itself is keyed in (DEFAULT_COORD_
-- WORKSPACE — every row is written there by design), a different axis from the
-- workspace the ITEMS live in. Scoping the edge lookup to p_workspace would match
-- zero rows and disable blocking entirely. Do not "fix" it to match.

-- ── 1. Replace the oracle ────────────────────────────────────────────────────
-- Dropped rather than overloaded: adding a 3-arg with a DEFAULT alongside the
-- existing 2-arg makes every 2-arg call ambiguous (Postgres raises rather than
-- choosing), so the old signature must go first.
DROP FUNCTION IF EXISTS harness_shared.work_item_is_blocked(text, text);

CREATE OR REPLACE FUNCTION harness_shared.work_item_is_blocked(
    p_harness   text,
    p_feature   text,
    p_workspace text
)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
    SELECT EXISTS (
        SELECT 1
          FROM harness_shared.work_item_deps d
         WHERE d.workspace_id = 'default'   -- coordination workspace; see header note
           AND d.dep_type = 'blocks'
           AND d.blocked_ref = p_harness || '#' || p_feature
           AND (
             -- FEATURE-family blocker: harness-qualified ref, scoped to p_workspace.
             EXISTS (
               SELECT 1 FROM harness_shared.work_items bf
                WHERE bf.item_kind <> ALL (ARRAY['bug','change','task'])
                  AND bf.workspace_id = p_workspace
                  AND (bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref
                  AND bf.status NOT IN ('passed','deprecated','done','dropped')
             )
             -- ISSUE-family blocker: BARE ref (issues:link), scoped to p_workspace.
             OR EXISTS (
               SELECT 1 FROM harness_shared.work_items bi
                WHERE bi.item_kind = ANY (ARRAY['bug','change','task'])
                  AND bi.workspace_id = p_workspace
                  AND bi.feature_id = d.blocker_ref
                  AND bi.status NOT IN ('resolved','closed','done','dropped')
             )
           )
    );
$function$;

-- ── 2. Thread the workspace through the sidecar maintainer ───────────────────
-- sync_work_item_blocked ALREADY receives p_ws (it keys the sidecar row with it)
-- and simply dropped it on the floor when calling the oracle. That single missing
-- argument is the whole bug.
CREATE OR REPLACE FUNCTION harness_shared.sync_work_item_blocked(p_ws text, p_harness text, p_feature text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF harness_shared.work_item_is_blocked(p_harness, p_feature, p_ws) THEN
        INSERT INTO harness_shared.work_item_blocked (workspace_id, harness_slug, feature_id, updated_at)
        VALUES (p_ws, p_harness, p_feature, now())
        ON CONFLICT (workspace_id, harness_slug, feature_id) DO UPDATE SET updated_at = now();
    ELSE
        DELETE FROM harness_shared.work_item_blocked
         WHERE workspace_id = p_ws AND harness_slug = p_harness AND feature_id = p_feature;
    END IF;
END;
$function$;

-- ── 3. Re-materialize the sidecar under the corrected predicate ──────────────
-- The triggers only fire on future writes, so the existing sidecar still reflects
-- the OLD predicate. Both drift directions are repaired:
--   (a) MISSING — items the corrected oracle now says are blocked but that have no
--       row (the dangerous direction: they currently look ready and get served);
--   (b) EXTRA — rows whose item is no longer blocked under the corrected oracle
--       (they would starve).
-- Idempotent: re-running is a no-op once the sidecar agrees with the oracle.

-- (a) re-sync every feature-family item that is the blocked side of a blocks-edge
DO $$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT DISTINCT f.workspace_id, f.harness_slug, f.feature_id
          FROM harness_shared.work_item_deps d
          JOIN harness_shared.work_items f
            ON f.item_kind <> ALL (ARRAY['bug','change','task'])
           AND (f.harness_slug || '#' || f.feature_id) = d.blocked_ref
         WHERE d.dep_type = 'blocks'
    LOOP
        PERFORM harness_shared.sync_work_item_blocked(r.workspace_id, r.harness_slug, r.feature_id);
    END LOOP;
END $$;

-- (b) drop sidecar rows the corrected oracle no longer considers blocked (this
--     also clears rows for items that are not feature-family or no longer exist)
DELETE FROM harness_shared.work_item_blocked wb
 WHERE NOT harness_shared.work_item_is_blocked(wb.harness_slug, wb.feature_id, wb.workspace_id);
