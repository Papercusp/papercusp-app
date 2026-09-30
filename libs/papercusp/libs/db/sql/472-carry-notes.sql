-- Migration 472 — the ONE shared carry-note substrate.
--
-- Plan: su-cold-auto-mode-2026-07-03 (Phase 1 / P-001; D-004) — the linchpin +
-- precondition for cold-auto. Converges the THREE per-role "note to my next
-- self" mechanisms that already exist into ONE durable PG store + shape:
--   * the Queen carry-journal  (hive:declare-wake { remember } → setHiveCarryNote,
--     previously bundled inside the hive_wake operator-state payload, mig 158)
--   * the bee checkpoint        (work_items:checkpoint → setWorkItemCheckpoint,
--     previously its own harness_shared.work_item_checkpoints table, mig 281)
--   * the su loop carry-note     (NEW: the SU AUTO loop's cold-wake anchor, P-002)
--
-- A COLD wake (fresh-context reset / recycle — Phase 2) reads this to reconstruct
-- working state instead of re-reading a grown transcript; cold-start is only as
-- safe as what it captures, so the substrate lands FIRST.
--
-- SCOPE-KEYED (the convergence): one row per (workspace_id, scope), where `scope`
-- is a stable, role-discriminated string — 'hive' | 'workitem:<harness>:<id>' |
-- 'loop:<harness>:<ownerId>'. The workspace_id column carries workspace isolation,
-- so 'hive' needs no workspace suffix.
--
-- D-003 SEMANTICS (shared, formerly duplicated in setHiveCarryNote +
-- setWorkItemCheckpoint): `note` is the current full state (TEXT, no cap),
-- replace-on-write; a blank/omitted note CLEARS `note` (the reader re-derives from
-- its floor). `journal` is an APPEND-mode, size-bounded ring of recent notes
-- (newest last; the Queen's carry-JOURNAL behavior, generalized to all three) so
-- the trajectory survives a clear. A row with a null note AND an empty journal is
-- deleted.
--
-- LOCAL working state, NOT federated (like mig 281): no author_pubkey/origin/fed_ts
-- columns and NO sync/hyperbee projection — an agent's in-flight carry-note is its
-- own machine's scratch, never replicated to peers. Do NOT add it to any
-- federation surface.
CREATE TABLE IF NOT EXISTS harness_shared.carry_notes (
  workspace_id  TEXT NOT NULL,
  -- Role-discriminated stable key: 'hive' | 'workitem:<harness>:<id>' | 'loop:<harness>:<ownerId>'.
  scope         TEXT NOT NULL,
  -- The current full "note to my next self" (any length, no cap). NULL when cleared
  -- (the journal ring below still carries trajectory). Structured shape (a template,
  -- not columns): what-I-did / what's-left / key-insight / next-action.
  note          TEXT,
  -- Bounded ring of recent notes (each entry { at:<ms>, note:<capped> }), newest
  -- last in storage; rendered newest-first. Preserves trajectory across a clear.
  journal       JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_ts    BIGINT NOT NULL,                 -- epoch ms of the last write
  PRIMARY KEY (workspace_id, scope)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.carry_notes TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.carry_notes TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.carry_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS carry_notes_workspace_isolation ON harness_shared.carry_notes;
CREATE POLICY carry_notes_workspace_isolation ON harness_shared.carry_notes
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- ── Data convergence: fold the two existing stores into carry_notes ───────────
-- Idempotent (ON CONFLICT DO NOTHING): the migration runner records this once,
-- but keep it safe to re-run against a partially-migrated DB.
--
-- EXPAND phase only (deploy hygiene): this migration is purely ADDITIVE — it
-- CREATEs carry_notes and COPIES existing data in, but does NOT drop the legacy
-- stores. The dev box shares one `:5432/papercusp` DB across the release (:3070,
-- old code that still writes work_item_checkpoints) and staging (:3170) operators,
-- so dropping the legacy table in the same migration that adds the new one would
-- break the still-running old code the instant this applies. The CONTRACT phase —
-- DROP work_item_checkpoints + stop reading the hive_wake carry keys — lands in a
-- follow-up migration once the re-pointed code is deployed everywhere.

-- (1) Bee checkpoints (mig 281) → scope 'workitem:<harness>:<work_item_id>'.
--     note = the full checkpoint; journal = [] (the bee checkpoint is a pure note,
--     journal:false — no trajectory ring, clear deletes the row).
DO $fold_bee$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'harness_shared' AND table_name = 'work_item_checkpoints'
  ) THEN
    INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, journal, updated_ts)
    SELECT
      c.workspace_id,
      'workitem:' || c.harness_slug || ':' || c.work_item_id,
      c.checkpoint,
      '[]'::jsonb,
      c.updated_ts
    FROM harness_shared.work_item_checkpoints c
    ON CONFLICT (workspace_id, scope) DO NOTHING;
  END IF;
END
$fold_bee$;

-- (2) Queen carry-journal (mig 158, inside the hive_wake operator-state payload) →
--     scope 'hive'. note = the legacy carryNote mirror; journal = the carryJournal
--     ring verbatim. The hive_wake payload keeps these keys physically (they become
--     dead/ignored — dropping individual JSON keys via DDL is not possible and
--     leaving them is not a shim: setHiveCarryNote/getHiveCarryJournal now read/write
--     carry_notes and never touch them again).
INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, journal, updated_ts)
SELECT
  w.workspace_id,
  'hive',
  w.payload->>'carryNote',
  COALESCE(w.payload->'carryJournal', '[]'::jsonb),
  COALESCE(w.updated_at, (extract(epoch from now()) * 1000)::bigint)
FROM harness_shared.hive_wake w
WHERE (w.payload ? 'carryJournal') OR (w.payload ? 'carryNote')
ON CONFLICT (workspace_id, scope) DO NOTHING;
