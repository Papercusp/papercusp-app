-- Reuse the hosted preference blob for per-workspace tutorial UI progress.
-- No domain completion, task text, credentials or chats are stored here.
ALTER TABLE papercusp_auth.hosted_user_preferences OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_user_preferences FORCE ROW LEVEL SECURITY;
REVOKE ALL ON papercusp_auth.hosted_user_preferences FROM PUBLIC, harness_app, harness_zero;
GRANT SELECT, INSERT, UPDATE ON papercusp_auth.hosted_user_preferences TO hosted_app;
DROP POLICY IF EXISTS hosted_preferences_user_scope ON papercusp_auth.hosted_user_preferences;
CREATE POLICY hosted_preferences_user_scope ON papercusp_auth.hosted_user_preferences
  FOR ALL TO hosted_app
  USING (organization_id::text = NULLIF(current_setting('app.organization_id', true), '')
    AND user_id::text = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (organization_id::text = NULLIF(current_setting('app.organization_id', true), '')
    AND user_id::text = NULLIF(current_setting('app.user_id', true), ''));
