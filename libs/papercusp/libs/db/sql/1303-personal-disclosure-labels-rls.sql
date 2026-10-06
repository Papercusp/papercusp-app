-- 1303 — Workspace RLS + explicit grants for the reader-set label tables.
--
-- Plan personal-data-reader-set-labels-2026-10-01 P-001 (WI-10004864). 1302
-- created personal_privacy_rules and personal_disclosures without the
-- boundary every other Personal Vault table carries (874): RLS keyed on
-- app.workspace_id, a workspace-isolation policy, and explicit grants to
-- harness_app / harness_admin. This adds it, mirroring 874 exactly.
--
-- Same transaction context as the rest of the vault: personal:search and the
-- outbound mail/calendar/chat/social tools read these tables through ctx.tx,
-- which already has to carry app.workspace_id for authorizePersonalAccess to
-- see the caller's personal_grants. A transaction without it is refused at
-- authorization before either table is read.
--
-- Idempotent: ENABLE is a no-op when already on, the policy is guarded by a
-- pg_policies lookup, and GRANT is repeatable.

ALTER TABLE harness_shared.personal_privacy_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.personal_disclosures ENABLE ROW LEVEL SECURITY;

DO $personal_label_policies$
DECLARE
  tbl text;
  pol text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['personal_privacy_rules', 'personal_disclosures']
  LOOP
    pol := tbl || '_workspace_isolation';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'harness_shared'
         AND tablename = tbl
         AND policyname = pol
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON harness_shared.%I FOR ALL TO public '
        || 'USING (workspace_id = current_setting(''app.workspace_id'', true)) '
        || 'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
        pol, tbl
      );
    END IF;
  END LOOP;
END
$personal_label_policies$;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.personal_privacy_rules TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.personal_disclosures TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.personal_privacy_rules IS
  'Owner-authored Personal Vault privacy rules (reader-set labels). Absent a matching rule a document is unrestricted. Loosening requires an owner directive (authority_ref).';
COMMENT ON TABLE harness_shared.personal_disclosures IS
  'Append-only ledger of restricted Personal Vault documents delivered to an agent identity. Outbound sinks refuse recipients outside the intersection of active reader sets. No TTL; released only by owner directive.';
