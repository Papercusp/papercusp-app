-- 616 — workspace_id stamping for the consolidated per-harness views (WI-5125).
--
-- SYMPTOM (owner-reported, 2026-07-16): clicking Chat on a work item spun on
-- "loading chat…" forever. The chat rows were created fine — they were simply
-- unreadable: every one landed in workspace_id='default' while the operator UI
-- (ws=papercusp-workspace) reads agent_chats_consolidated WITH a workspace
-- filter, so the read matched zero rows.
--
-- ROOT CAUSE — a CLASS, not a one-off. Each consolidation migration gave its
-- per-harness view a hardcoded literal default:
--
--     ALTER VIEW <schema>.agent_chats ALTER COLUMN workspace_id SET DEFAULT 'default'
--
-- (116 agent_chats · 118 feature_audit · 119 supervisor_notes +
-- directive_summaries · 120 messages + executed_actions · 170 agent_runs.)
-- A writer that omits workspace_id therefore SILENTLY SUCCEEDS with wrong data.
-- That literal is the trap: harness_features_consolidated has no such default —
-- its writers pass workspace_id explicitly — which is exactly why its rows carry
-- the right workspace and these tables' rows do not.
--
-- THE FIX has three layers; this migration is the schema half (the writer half —
-- explicit activeWorkspaceId() stamping in agent-chats-data.ts and
-- execute-action.ts — ships alongside it):
--
--   1. DROP the literal defaults (view + base table) so an omitted workspace_id
--      arrives as NULL instead of a plausible-looking lie.
--   2. Attach the EXISTING harness_shared.fill_workspace_id_from_projects()
--      trigger — already the mechanism on work_items, harness_issues_consolidated
--      and contributor_usage_events — as the fallback: NULL derives the workspace
--      from harness_shared.projects by harness_slug, else 'default'.
--   3. Backfill the agent_chats rows that map unambiguously to a live workspace.
--
-- WHY THIS CANNOT REGRESS ANYTHING: step 2 makes step 1 safe. A writer that still
-- omits workspace_id gets NULL → the trigger fills it → worst case it resolves to
-- 'default', which is EXACTLY today's behavior. Explicit writers get the correct
-- workspace. So the floor is today and the ceiling is correct; no writer can break
-- and no row can go NOT NULL. (The trigger alone is NOT sufficient as the primary
-- fix: harness_shared.projects is a near-empty legacy registry — 7 rows, no
-- 'papercusp' — so it would resolve the reported case straight back to 'default'.
-- The live registry is only known in-process, hence the explicit writer stamping.)
--
-- Idempotent: safe to re-run.

DO $mig$
DECLARE
  s text;
  v text;
  tbl text;
  consolidated text[] := ARRAY[
    'agent_chats_consolidated',
    'agent_runs_consolidated',
    'messages_consolidated',
    'executed_actions_consolidated',
    'supervisor_notes_consolidated',
    'directive_summaries_consolidated',
    'feature_audit_consolidated'
  ];
  views text[] := ARRAY[
    'agent_chats',
    'agent_runs',
    'messages',
    'executed_actions',
    'supervisor_notes',
    'directive_summaries',
    'feature_audit'
  ];
BEGIN
  -- 1. Base tables: drop the literal default + attach the derive-from-projects
  --    trigger. The trigger fires when workspace_id IS NULL OR '' — so it also
  --    rescues the tables whose base default was '' rather than 'default'.
  FOREACH tbl IN ARRAY consolidated LOOP
    IF to_regclass(format('harness_shared.%I', tbl)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE harness_shared.%I ALTER COLUMN workspace_id DROP DEFAULT', tbl);

    EXECUTE format('DROP TRIGGER IF EXISTS fill_ws_trg ON harness_shared.%I', tbl);
    EXECUTE format(
      'CREATE TRIGGER fill_ws_trg BEFORE INSERT ON harness_shared.%I '
      'FOR EACH ROW EXECUTE FUNCTION harness_shared.fill_workspace_id_from_projects()',
      tbl);
  END LOOP;

  -- 2. Per-harness views: drop the literal default so an omitted column reaches
  --    the base table as NULL and the trigger above can fill it. Every other view
  --    default (harness_slug, created_at, …) is deliberately left untouched.
  --
  --    OWNERSHIP-TOLERANT BY DESIGN. These views span ~240 harness schemas and are
  --    not uniformly owned: most are owned by harness_admin (the migration role),
  --    but a handful — harness_org*, harness_papercup, harness_restart,
  --    harness_sheets* — are owned by postgres_app, and ALTER VIEW requires
  --    ownership. A single un-owned view would otherwise abort the WHOLE migration
  --    (it did, on first apply), leaving even the owned schemas unfixed.
  --
  --    Skipping is SAFE, not a silent half-fix: a skipped view simply keeps its
  --    literal default, i.e. EXACTLY today's behavior for that harness — and the
  --    real fix for every harness is the writer stamping workspace_id explicitly
  --    (an explicit value makes the view default irrelevant). This layer only
  --    converts a would-be SILENT mis-stamp into a trigger-derived one for the
  --    views we can reach. Each skip is RAISEd as a NOTICE — never silent.
  FOR s IN
    SELECT nspname FROM pg_namespace
    WHERE nspname LIKE 'harness\_%' AND nspname <> 'harness_shared'
  LOOP
    FOREACH v IN ARRAY views LOOP
      -- Only actual views (a schema may still hold a pre-consolidation table).
      IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = s AND c.relname = v AND c.relkind = 'v'
      ) THEN
        CONTINUE;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = s AND table_name = v AND column_name = 'workspace_id'
      ) THEN
        CONTINUE;
      END IF;
      BEGIN
        EXECUTE format('ALTER VIEW %I.%I ALTER COLUMN workspace_id DROP DEFAULT', s, v);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE
          '616: skipped %.% — not owned by % (keeps its literal default = today''s behavior; '
          'the writer-side explicit stamp still fixes it)', s, v, current_user;
      END;
    END LOOP;
  END LOOP;
END
$mig$;

-- 3. Backfill: re-home the agent_chats rows that are mis-stamped 'default' but
--    whose harness is registered in exactly ONE other workspace. The live
--    harness→workspace mapping lives in harness_registry.payload->'projects'
--    (jsonb), NOT in harness_shared.projects.
--
--    Deliberately CONSERVATIVE: only rows whose harness resolves to exactly one
--    non-'default' workspace move. A harness genuinely registered in 'default'
--    (sheets, restart) keeps its rows; an unregistered/ambiguous slug is left
--    alone rather than guessed at. This is a data-correcting UPDATE, so it stays
--    narrow by construction and is idempotent (re-running moves nothing new).
WITH reg AS (
  SELECT DISTINCT r.workspace_id, p->>'slug' AS slug
    FROM harness_shared.harness_registry r,
         LATERAL jsonb_array_elements(r.payload->'projects') p
   WHERE r.workspace_id <> 'default'
     AND p->>'slug' IS NOT NULL
), unambiguous AS (
  SELECT slug, min(workspace_id) AS workspace_id
    FROM reg
   GROUP BY slug
  HAVING count(DISTINCT workspace_id) = 1
)
UPDATE harness_shared.agent_chats_consolidated c
   SET workspace_id = u.workspace_id
  FROM unambiguous u
 WHERE c.harness_slug = u.slug
   AND c.workspace_id = 'default'
   -- Never collide with an existing row at the destination key
   -- (workspace_id, harness_slug, id) — the table's primary key.
   AND NOT EXISTS (
     SELECT 1 FROM harness_shared.agent_chats_consolidated x
      WHERE x.workspace_id = u.workspace_id
        AND x.harness_slug = c.harness_slug
        AND x.id = c.id
   );
