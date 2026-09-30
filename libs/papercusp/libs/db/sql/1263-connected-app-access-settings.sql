-- 1263-connected-app-access-settings.sql
-- external-app-access-to-workspaces-2026-09-29 P-010 (WI-10004023), decision D-025.
--
-- WHY. Settings → Remote access carries one on/off switch per workspace. Off is the instant kill
-- switch: every connected-app credential for that workspace — app keys and service keys
-- (harness_shared.connected_apps kind 'app'/'service') and the client-credentials access tokens
-- they issued (connected_app_access_tokens) — is refused on its NEXT request (R-24, R-41).
-- verifyAppKey reads this row with the key on every call, so there is no cache to wait out.
--
-- One row per workspace. NO ROW MEANS ON: a workspace that never touched the switch keeps working,
-- so this migration changes nothing for existing keys. Phones (kind 'mobile') are not covered:
-- they have their own pairing auth and revoke (R-24 names connected-app keys only).
--
-- Reads: verifyAppKey and the token endpoint's client check read it over the admin connection
-- (the key is resolved before the workspace is known). Writes: the Remote access screen's loopback
-- route, inside withWorkspace, so the policy below bounds it to its own workspace.
--
-- Additive only: a new table, policy and grant. Nothing the deployed release reads changes.

CREATE TABLE IF NOT EXISTS harness_shared.connected_app_access_settings (
  workspace_id text        PRIMARY KEY,
  -- false = every connected-app credential of this workspace is refused ('remote_access_off').
  enabled      boolean     NOT NULL DEFAULT true,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  -- Who flipped it last (a user email, or 'system:<id>' for an automated change). Audit only.
  changed_by   text
);

ALTER TABLE harness_shared.connected_app_access_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connected_app_access_settings_workspace_isolation
  ON harness_shared.connected_app_access_settings;
CREATE POLICY connected_app_access_settings_workspace_isolation
  ON harness_shared.connected_app_access_settings
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE ON harness_shared.connected_app_access_settings TO harness_app;

COMMENT ON TABLE harness_shared.connected_app_access_settings IS
  'Per-workspace Remote access switch (external-app-access P-010, D-025). enabled=false refuses every connected-app key and access token of the workspace on its next request (reason remote_access_off). No row = on.';
