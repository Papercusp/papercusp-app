-- 535-rekey-stranded-workitem-checkpoints.sql
--
-- EI-9013 data repair (plan fleet-retro-hardening-2026-07-10 P-001).
--
-- Before the EI-8805 fix, work_items:checkpoint keyed a checkpoint's carry_notes
-- scope by the WRITING SESSION's harness instead of the item's own — so an
-- unscoped su session (session harness '*') writing a checkpoint for a
-- concrete-harness feature item persisted `workitem:*:<id>` while every read
-- (work_items:get, the orient recovery fold) resolves the item's own harness and
-- looks under `workitem:<harness>:<id>`. The rows were never lost — just
-- stranded under a scope no reader consults (measured 2026-07-10: 377 stranded
-- rows, 53 of them on still-in-flight items; incident row: workitem:*:WI-3535).
--
-- Repair: re-key each stranded row onto the item's concrete-harness scope, but
-- ONLY when the work-item id maps to exactly ONE concrete harness in that
-- workspace (ambiguous ids are skipped — never guess an owner). Rows whose item
-- is genuinely harness-null (issue-family EIs from unscoped sessions) do not
-- join to a concrete-harness work_items row and are correctly left under the
-- '*' sentinel (that IS their canonical scope, per EI-8805).
--
-- Idempotent: a re-run finds no stranded rows with a unique concrete mapping
-- left (they were re-keyed or folded), so every statement no-ops.

-- Map each stranded row to its unique concrete-harness target scope.
CREATE TEMP TABLE _ei9013_rekey_map AS
SELECT cn.workspace_id,
       cn.scope AS old_scope,
       'workitem:' || min(w.harness_slug) || ':' ||
         substring(cn.scope FROM '^workitem:\*:(.+)$') AS new_scope
  FROM harness_shared.carry_notes cn
  JOIN harness_shared.work_items w
    ON w.workspace_id = cn.workspace_id
   AND w.feature_id = substring(cn.scope FROM '^workitem:\*:(.+)$')
   AND w.harness_slug IS NOT NULL
   AND w.harness_slug NOT IN ('', '*')
   AND w.harness_slug NOT LIKE 'operator:%'
 WHERE cn.scope LIKE 'workitem:*:%'
 GROUP BY cn.workspace_id, cn.scope
HAVING count(DISTINCT w.harness_slug) = 1;

-- (a) A concrete-scope row already exists (someone checkpointed again after the
--     fix): keep the NEWER note on the concrete row...
UPDATE harness_shared.carry_notes t
   SET note = s.note,
       updated_ts = s.updated_ts
  FROM harness_shared.carry_notes s,
       _ei9013_rekey_map m
 WHERE s.workspace_id = m.workspace_id AND s.scope = m.old_scope
   AND t.workspace_id = m.workspace_id AND t.scope = m.new_scope
   AND s.updated_ts > t.updated_ts;

--     ...then drop the stranded duplicate either way.
DELETE FROM harness_shared.carry_notes s
 USING _ei9013_rekey_map m
 WHERE s.workspace_id = m.workspace_id AND s.scope = m.old_scope
   AND EXISTS (
     SELECT 1 FROM harness_shared.carry_notes t
      WHERE t.workspace_id = m.workspace_id AND t.scope = m.new_scope);

-- (b) No conflict: plain re-key onto the item's concrete scope.
UPDATE harness_shared.carry_notes s
   SET scope = m.new_scope
  FROM _ei9013_rekey_map m
 WHERE s.workspace_id = m.workspace_id AND s.scope = m.old_scope;

DROP TABLE _ei9013_rekey_map;
