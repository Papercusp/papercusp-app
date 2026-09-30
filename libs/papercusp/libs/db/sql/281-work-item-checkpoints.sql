-- Migration 281 — work-item-scoped bee checkpoint store.
--
-- Plan: bee-context-efficiency-2026-06-14 (Phase 3 / P-010; D-002, D-003) — the
-- bee translation of the Queen's self-authored carry-note
-- (queen-brief-cache-assembly-2026-06-13 P-015 / setHiveCarryNote).
--
-- A bee writes a compressed snapshot of its in-flight state here at a task
-- boundary / on graceful eviction. The next invocation on the SAME work-item
-- re-injects it (P-011), so a bee re-woken fresh — OR a SUCCESSOR bee after the
-- prior one is evicted/dies — resumes from the checkpoint instead of a cold
-- start (a cheap handoff). This is what lets Phase-1 fresh-context warm-inject
-- (D-001) drop the grown transcript without losing continuity.
--
-- D-002 — WORK-ITEM-SCOPED, not bee-scoped: the checkpoint lives on the
-- work-item (keyed by work_item_id), so an evicted bee's successor inherits it.
-- Keyed by (workspace_id, harness_slug, work_item_id) — the work-item identity
-- used across the work-item family (mirrors work_item_replicas), so it covers
-- every kind (feature / bug / change / chunk), not just the feature row.
--
-- D-003 — setHiveCarryNote semantics, stored in PG (storage-policy: PG by
-- default, no file state / module Map): any length (TEXT, no cap),
-- replace-on-write (upsert), omitted/blank ⇒ cleared (the store DELETEs the row;
-- the next invocation re-derives from the dossier alone — graceful degradation).
-- A dedicated table (the "typed record" option in D-003) rather than a column on
-- harness_features_consolidated, so a large checkpoint blob never bloats the
-- hot feature-row reads + the store is uniform across all work-item kinds.
--
-- LOCAL working state, NOT federated: no author_pubkey/origin/fed_ts columns and
-- NO sync/hyperbee projection — a bee's in-flight checkpoint is its own machine's
-- scratch, never replicated to peers. Do NOT add it to any federation surface.
CREATE TABLE IF NOT EXISTS harness_shared.work_item_checkpoints (
  workspace_id  TEXT NOT NULL,
  harness_slug  TEXT NOT NULL,
  work_item_id  TEXT NOT NULL,
  -- The bee's compressed in-flight state. Any length (no cap — mirrors the
  -- Queen carry-note); replace-on-write; the row is DELETEd to clear.
  checkpoint    TEXT NOT NULL,
  updated_ts    BIGINT NOT NULL,                 -- epoch ms of the last write
  PRIMARY KEY (workspace_id, harness_slug, work_item_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.work_item_checkpoints TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.work_item_checkpoints TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.work_item_checkpoints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_item_checkpoints_workspace_isolation ON harness_shared.work_item_checkpoints;
CREATE POLICY work_item_checkpoints_workspace_isolation ON harness_shared.work_item_checkpoints
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
