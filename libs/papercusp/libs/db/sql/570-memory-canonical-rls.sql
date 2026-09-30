-- 570: memory_canonical RLS — close the RLS-coverage gap flagged by
-- rls-coverage.integration (WI-4074, found during the cup-lexicon-rename
-- verification pass, WI-3467).
--
-- memory_canonical became a federated, workspace-scoped table across migs
-- 562 (shareable column), 563 (capture_memory_canonical_outbox triggers) and
-- 564 (federation columns: harness_slug/author_pubkey/origin/fed_ts/
-- source_hive) — but none of those added RLS, unlike every other federated
-- CDC table (mirrors mig-186/hive_settings, mig-317/hive_policy, mig-402/
-- work_items). `workspace_id` has been a GENERATED column (payload->>
-- 'workspace_id') since before mig 562. relrowsecurity=false, 0 policies,
-- confirmed live via psql.
--
-- SAFE TO ENABLE (the mem0-access-path question the issue asked): the ONLY
-- code path that reads/writes memory_canonical is CanonicalVectorStore
-- (libs/generic/memory/src/canonical-store.ts), wired via mem0-connection.ts
-- -> configureMemory({ getAdminUrl: getHarnessAdminUrl }) — i.e. it connects
-- EXCLUSIVELY as harness_admin, which is BYPASSRLS (connection.ts:
-- "the harness_admin role bypasses RLS policies"). It never sets
-- app.workspace_id and never touches harness_app. So enabling RLS here does
-- NOT touch mem0's current reads/writes at all (harness_admin bypasses RLS
-- regardless of policy state) - unlike the harness_issues_consolidated
-- RLS_EXEMPT case (rls-coverage.integration.test.ts), whose admin-conn
-- resolver gap is a DOCUMENTED accepted risk with no RLS fix possible; here
-- RLS is a pure defense-in-depth backstop for any FUTURE harness_app-scoped
-- surface (a sync resolver, mem0-federation Phase 3 egress reads, ad-hoc
-- tooling) that queries this table without its own explicit workspace
-- filter. Idempotent; mirrors mig-186/317's exact policy shape.

\set ON_ERROR_STOP on

-- NOTE (gate-green fix, su-08613 2026-07-11): no top-level BEGIN/COMMIT — the
-- migration runner wraps each enforced-era migration in its own transaction, and
-- lint-migrations.test.ts fails the release gate on explicit transaction control.
ALTER TABLE harness_shared.memory_canonical ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_canonical_workspace_isolation ON harness_shared.memory_canonical;
CREATE POLICY memory_canonical_workspace_isolation ON harness_shared.memory_canonical
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
