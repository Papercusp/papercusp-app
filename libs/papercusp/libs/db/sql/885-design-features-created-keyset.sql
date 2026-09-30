-- 885 — stable Design feature-queue keyset (P-011).
--
-- `updated_ts` moves on claims, status changes, ranking, tags, and other
-- routine work-item mutations. The bounded Design queue therefore pages on the
-- immutable birth key `(created_ts, feature_id)`. Keep the index partial to the
-- exact feature-family queue population exposed by the compatibility view.

CREATE INDEX IF NOT EXISTS work_items_design_created_keyset_idx
  ON harness_shared.work_items (
    workspace_id,
    harness_slug,
    (coalesce(created_ts, 0)) DESC,
    feature_id DESC
  )
  WHERE needs_design = TRUE
    AND item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text]);
