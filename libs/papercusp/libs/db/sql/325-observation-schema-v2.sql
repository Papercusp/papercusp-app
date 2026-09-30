-- 325-observation-schema-v2.sql
--
-- Observation schema v2 — BACKFILL of `sourceHive` onto the existing observation corpus
-- (rubric-driven-observations-2026-06-20 P-001 — the cross-plan convergence; brief B1).
--
-- The v2 observation EXTENSION itself — the engineer_issues.payload.observation
-- { sourceHive, targetHive, rubricRef, ratings } write/read contract (camelCase) — lands in
-- TypeScript (capture-core + observation-types + read-items), per plan D-003 (authored by
-- su-f8ee5, the P-001 owner). D-003 is deliberately ZERO-DDL: new observations get sourceHive
-- from the write path (ctx.hiveSlug). THIS migration is the ONE piece that write-path scope
-- leaves out — tagging the HISTORICAL observation rows with sourceHive so the workspace-scoped
-- Scout corpus-digest (P-006) can GROUP BY source hive over the WHOLE corpus, not just rows
-- filed after the schema shipped. (workspace-scoped-coordination-2026-06-20 D-003 names
-- source-hive tagging "the linchpin".)
--
-- WHAT — for every existing observation (engineer_issues.payload.lane = 'observation'), set
-- payload.observation.sourceHive (camelCase, per D-003) WHEN ABSENT, derived from the row's own
-- federated identity (scope + workspace_id):
--   * scope 'harness:<slug>'                 -> '<slug>'        (the harness's own hive identity)
--   * scope literal hive-ish (e.g. legacy 'papercusp')         -> the scope verbatim
--   * workspace_id 'default' | 'papercusp-workspace'           -> 'papercusp'
--         (the install home hive — ensure-papercusp-hive.ts. NB: engineer_issues.workspace_id is
--          the COORD workspace, not the domain workspace; the post-cutover main's observation
--          history lives in the legacy shared 'default' coord workspace, so both map to papercusp.)
--   * workspace_id 'generic-test'                              -> 'generic-test'
--         (isolate the test rows so they never pollute papercusp's source-hive grouping)
--   * else                                                     -> workspace_id  (safe proxy)
-- Verified against live data at authoring (546 obs rows -> papercusp 540, generic-test 3,
-- sb-devboard-hive 2, offsite-planner-demo 1; 0 already carried sourceHive). The harness->hive
-- map is approximated by the harness slug itself (the harness_registry stores no clean per-harness
-- hive_slug, and the only harness-scoped observation rows are standalone demo harnesses whose
-- slug IS their hive identity); a member->home refinement is a v2 concern.
--
-- SILENT + DETERMINISTIC + PER-PEER — the derivation reads ONLY federated row identity
-- (scope + workspace_id), so every peer's boot-apply of this migration computes the IDENTICAL
-- result; there is no need to FEDERATE the backfill. We therefore run the UPDATE with the
-- engineer_issues USER triggers disabled, so it:
--   - emits NO substrate-outbox / CDC op (capture_engineer_issues_outbox_upd_trg),
--   - emits NO change-notify (emit_change_notify_trg) and NO fleet-assignment notify
--     (fleet_assignment_issues_upd_trg) — a backfill must not churn the UI or wake the fleet,
--   - does NOT bump updated_at (engineer_issues_updated_at_trg) — bumping 546 historical rows to
--     now() would falsely mark them "just updated" and distort the Scout recency view, and
--   - does NOT re-stamp fed_ts/fed_hlc (stamp_local_federated_write_trg) — the rows keep their
--     LWW ordering key, so an unrelated later federated op still orders correctly.
-- harness_admin OWNS engineer_issues, so DISABLE TRIGGER is permitted; DISABLE/ENABLE TRIGGER is
-- transactional DDL, so if the UPDATE errors the rollback restores the triggers automatically.
-- (Trade-off, documented: a pre-v2 row that federates to a peer AFTER that peer ran this migration
-- would arrive without sourceHive — a rare edge in a workspace-local observation corpus; the read
-- projection treats sourceHive as optional, and any subsequent federated payload op for the row
-- re-carries the peer-local sourceHive once both peers have applied the schema.)
--
-- Idempotent: skips any row already carrying sourceHive (re-run safe; never clobbers a write-path
-- value). Plus supporting expression indexes so the Scout digest's GROUP BY sourceHive / rubricRef
-- stays cheap as the corpus grows (mirrors the payload->>'watchdogKey' indexed-lookup pattern).
--
-- Composes onto prior migrations; applies on :5432.

\set ON_ERROR_STOP on
BEGIN;

-- Silent backfill (see header): suppress every USER trigger on engineer_issues for this one
-- UPDATE. Only UPDATE-firing triggers matter here; the INSERT-only capture trigger is unaffected.
ALTER TABLE harness_shared.engineer_issues DISABLE TRIGGER USER;

UPDATE harness_shared.engineer_issues e
   SET payload = jsonb_set(
         COALESCE(e.payload, '{}'::jsonb),
         '{observation}',
         COALESCE(e.payload -> 'observation', '{}'::jsonb)
           || jsonb_build_object(
                'sourceHive',
                CASE
                  WHEN e.scope LIKE 'harness:%'                              THEN substring(e.scope FROM 9)
                  WHEN e.scope NOT IN ('operator', '')                       THEN e.scope
                  WHEN e.workspace_id IN ('default', 'papercusp-workspace')  THEN 'papercusp'
                  WHEN e.workspace_id = 'generic-test'                       THEN 'generic-test'
                  ELSE e.workspace_id
                END
              ),
         true /* create the observation object on the bare free-text rows that lack one */
       )
 WHERE e.payload ->> 'lane' = 'observation'
   AND NOT (COALESCE(e.payload -> 'observation', '{}'::jsonb) ? 'sourceHive');

ALTER TABLE harness_shared.engineer_issues ENABLE TRIGGER USER;

-- Supporting indexes for the workspace-scoped Scout corpus-digest (P-006): GROUP BY source hive,
-- and filter/group by rubric. Partial to the observation lane (the only rows carrying these keys),
-- so the bulk of engineer_issues (improvements/tasks) pays no write cost.
CREATE INDEX IF NOT EXISTS engineer_issues_obs_source_hive_idx
  ON harness_shared.engineer_issues
     (workspace_id, (payload -> 'observation' ->> 'sourceHive'))
  WHERE payload ->> 'lane' = 'observation';

CREATE INDEX IF NOT EXISTS engineer_issues_obs_rubric_ref_idx
  ON harness_shared.engineer_issues
     (workspace_id, (payload -> 'observation' ->> 'rubricRef'))
  WHERE payload ->> 'lane' = 'observation'
    AND (payload -> 'observation' ->> 'rubricRef') IS NOT NULL;

COMMIT;
