-- 1023 — PUI session runtime classification (pui-su-session-runtime-correction
-- 2026-08-27, P-011 / WI-287136).
--
-- WHY THIS EXISTS. P-011 cuts the PUI (apps/tui) new-session and resume flows over
-- to the canonical SU-session host as the DEFAULT. Once that default is on, a
-- resumed conversation that has no SU binding is ambiguous, and the two readings
-- have opposite correct behaviours:
--
--   (a) a PRE-CUTOVER chat, whose turns were served by the PUI-owned agent loop.
--       It has no live SU runtime and never will. Opening one for it would give an
--       existing conversation a NEW identity and a NEW backend — precisely the
--       silent re-homing P-011 forbids.
--   (b) a POST-CUTOVER chat created moments ago whose bind() has not landed yet.
--       Here the SU session is the right target and waiting for it is correct.
--
-- Absence of a row in `adv_sessions.su_agent_chat_id` cannot separate those two,
-- so the classification is DERIVABLE only while the population is uniform — i.e.
-- only until the first post-cutover chat exists. That is why it is STAMPED here
-- rather than derived at read time: this migration is the one moment at which the
-- whole persisted population is known to be pre-cutover, and the stamp preserves
-- that knowledge afterwards. (Measured at authoring time: 206 chats, 0 with an
-- `adv_sessions` binding.)
--
-- Post-migration the stamp is maintained by the writer: agent-chats-data.ts
-- `createChat` stamps every new row, so a NULL after this migration means a writer
-- that predates the cutover — which readers surface rather than guess about.
--
-- Idempotent: safe to re-run. Additive only — no column is dropped, nothing is made
-- NOT NULL, and the deployed release simply ignores a column it does not select.

ALTER TABLE harness_shared.agent_chats_consolidated
  ADD COLUMN IF NOT EXISTS su_runtime_class text;

DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.agent_chats_consolidated'::regclass
       AND conname = 'agent_chats_consolidated_su_runtime_class_chk'
  ) THEN
    ALTER TABLE harness_shared.agent_chats_consolidated
      ADD CONSTRAINT agent_chats_consolidated_su_runtime_class_chk
      CHECK (su_runtime_class IS NULL
             OR su_runtime_class IN ('su-session', 'legacy-owned-loop'));
  END IF;
END
$mig$;

COMMENT ON COLUMN harness_shared.agent_chats_consolidated.su_runtime_class IS
  'Which dispatch policy this PUI conversation was CREATED under — its permanent '
  'home, not its current live state. ''su-session'': created after the P-011 '
  'cutover, so the canonical SU-session host is where its turns belong. '
  '''legacy-owned-loop'': created under the pre-cutover PUI-owned agent loop (or '
  'while the papercusp-pui-su-session-host kill-switch was OFF), so it must never '
  'be re-homed onto an SU session — that would change an existing conversation''s '
  'identity and backend. Deliberately NOT a statement about whether a runtime is '
  'currently attached: that stays derived from adv_sessions.su_agent_chat_id, so '
  'this column has nothing to drift against. Stamped by migration 1023 for the '
  'pre-cutover population and by agent-chats-data.ts createChat thereafter. NULL '
  'means UNCLASSIFIED (a writer that predates the cutover) and readers must '
  'surface that rather than assume either policy '
  '(pui-su-session-runtime-correction-2026-08-27 P-011).';

-- Backfill. A chat already bound to a durable SU session is ''su-session''; every
-- other persisted chat is a pre-cutover owned-loop conversation.
UPDATE harness_shared.agent_chats_consolidated c
   SET su_runtime_class = CASE
         WHEN EXISTS (
           SELECT 1 FROM harness_shared.adv_sessions a
            WHERE a.workspace_id = c.workspace_id
              AND a.su_agent_chat_id = c.id
         ) THEN 'su-session'
         ELSE 'legacy-owned-loop'
       END
 WHERE c.su_runtime_class IS NULL;

-- Per-harness views are `SELECT *` but Postgres freezes their column list at
-- creation time, so an existing view keeps hiding the new column until it is
-- replaced. CREATE OR REPLACE VIEW may append columns at the end (which is where
-- ALTER TABLE ADD COLUMN puts it) and preserves the views' grants and per-column
-- DEFAULTs, so the replacement is behaviour-preserving for every existing writer.
--
-- OWNERSHIP-TOLERANT, following migration 616's precedent: these views span ~240
-- harness schemas and are not uniformly owned (harness_org*, harness_papercup,
-- harness_restart and harness_sheets* are owned by postgres_app, the rest by
-- harness_admin). A single un-owned view would otherwise abort the whole
-- migration. Skipping one is safe rather than a silent half-fix: that harness's
-- view simply keeps today's column list, and the classification still lives on the
-- base table where every consolidated reader looks. Each skip is RAISEd as a
-- NOTICE — never silent.
-- The harness slug is read back OUT of each view's own definition rather than
-- reconstructed from its schema name: `harness_<slug>` is not reversible (a slug
-- containing '-' becomes '_' in the schema name), and a reconstructed-but-wrong
-- literal would leave a syntactically valid view matching ZERO rows — a silent
-- data outage for that harness. A view whose filter cannot be read is skipped, not
-- guessed at. `pg_get_viewdef` expands the original `SELECT *` into an explicit
-- column list, which is exactly why the definition cannot simply be replayed.
DO $mig$
DECLARE
  s text;
  slug text;
  check_opt text;
  skipped int := 0;
  replaced int := 0;
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace
     WHERE nspname LIKE 'harness\_%' AND nspname <> 'harness_shared'
     ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.agent_chats', s)) IS NULL THEN
      CONTINUE;
    END IF;

    SELECT (regexp_match(
              pg_get_viewdef(format('%I.agent_chats', s)::regclass),
              'harness_slug = ''([^'']*)''::text'))[1]
      INTO slug;
    IF slug IS NULL THEN
      skipped := skipped + 1;
      RAISE NOTICE '1023: skipped %.agent_chats (harness_slug filter unreadable)', s;
      CONTINUE;
    END IF;

    SELECT v.check_option INTO check_opt
      FROM information_schema.views v
     WHERE v.table_schema = s AND v.table_name = 'agent_chats';

    BEGIN
      EXECUTE format(
        'CREATE OR REPLACE VIEW %1$I.agent_chats AS '
        'SELECT * FROM harness_shared.agent_chats_consolidated '
        'WHERE harness_slug = %2$L%3$s',
        s,
        slug,
        CASE
          WHEN check_opt = 'CASCADED' THEN ' WITH CASCADED CHECK OPTION'
          WHEN check_opt = 'LOCAL' THEN ' WITH LOCAL CHECK OPTION'
          ELSE ''
        END);
      replaced := replaced + 1;
    EXCEPTION WHEN insufficient_privilege OR wrong_object_type THEN
      skipped := skipped + 1;
      RAISE NOTICE '1023: skipped %.agent_chats (not replaceable by this role)', s;
    END;
  END LOOP;
  RAISE NOTICE '1023: replaced % per-harness agent_chats views, skipped %',
    replaced, skipped;
END
$mig$;
