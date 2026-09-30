-- Migration 276 — owner-keyed LOCAL user_trust_list.
--
-- Plan: shared-hive-trust-admission-2026-06-14 (Phase 3 / P-009; D-001).
--
-- The owner's trusted github user ids. The admission gate (work-items-admission.ts,
-- P-010) consults this LOCALLY to decide whether un-screened remote work whose
-- VERIFIED author (harness_features_consolidated.verified_author_github_user_id,
-- migration 273) is trusted may auto-run.
--
-- D-001 — LOCAL-CONSULTATION ONLY, OWNER-SCOPED, NEVER FEDERATED: this table is
-- consulted on the owner's OWN install when deciding whether to auto-run foreign
-- work, and applies across every hive the owner is in (owner-scoped, NOT
-- hive-scoped). It does NOT federate to peers — each peer enforces its own
-- owner's list. So it is a plain local table with NO sync/hyperbee projection and
-- NO author_pubkey/origin/fed_ts columns (those mark federated rows). Do NOT add
-- it to any federation surface.
--
-- workspace_id IS the owner's install scope (one workspace = one owner here).
-- trusted_github_user_id is BIGINT to match hive_members.github_user_id +
-- harness_features_consolidated.verified_author_github_user_id (273), so the
-- trust-leg join in autoPickableWhereSql is type-clean.
CREATE TABLE IF NOT EXISTS harness_shared.user_trust_list (
  workspace_id            TEXT NOT NULL,
  trusted_github_user_id  BIGINT NOT NULL,
  -- Optional human note ("alice@acme — co-maintainer"); diagnostic only.
  note                    TEXT,
  created_ts              BIGINT NOT NULL,                 -- epoch ms
  PRIMARY KEY (workspace_id, trusted_github_user_id)
);

-- The gate's lookup is "is <id> trusted in <workspace>?" — the PK covers it; an
-- explicit ws index helps the set-membership subquery on larger lists.
CREATE INDEX IF NOT EXISTS user_trust_list_ws_idx
  ON harness_shared.user_trust_list (workspace_id);

GRANT SELECT, INSERT, DELETE ON harness_shared.user_trust_list TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.user_trust_list TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.user_trust_list ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_trust_list_workspace_isolation ON harness_shared.user_trust_list;
CREATE POLICY user_trust_list_workspace_isolation ON harness_shared.user_trust_list
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
