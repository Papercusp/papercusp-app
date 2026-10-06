-- 1300-connected-app-removed-creators.sql — WI-10004257 (external-app-access-to-workspaces-2026-09-29
-- follow-up to P-328, D-030 #5)
--
-- The creator-removed connected-app alert (P-328) asks whether a key's creator still belongs to the
-- organization. Membership lives on the portal. A hosted or relay-linked machine's own database has
-- no current membership rows, so the alert could never fire there.
--
-- The portal now reports, over the machine's connector socket, every address in the machine's
-- organization whose membership is no longer active (`membership.report`). The machine stores the
-- latest report here, replacing the organization's rows each time, and `loadSweepKeys` reads it
-- beside the papercusp_auth join.
--
-- This is a display-only fact for one alert. It is deliberately NOT written into
-- papercusp_auth.organization_memberships: that table is what hosted authorization reads, and a
-- machine has none of the organization, user or invitation rows its foreign keys require.
--
-- FORWARD-COMPAT: additive only (one new table). Nothing in the currently deployed release reads or
-- writes it; a machine on the previous release ignores the new connector frame.

CREATE TABLE IF NOT EXISTS harness_shared.connected_app_removed_creators (
  organization_id text        NOT NULL,
  -- lower(primary_email) of the removed member, as the portal sent it.
  email           text        NOT NULL,
  reported_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, email),
  CONSTRAINT connected_app_removed_creators_email_lower_ck CHECK (email = lower(email) AND email <> '')
);

CREATE INDEX IF NOT EXISTS connected_app_removed_creators_email_idx
  ON harness_shared.connected_app_removed_creators (email);

COMMENT ON TABLE harness_shared.connected_app_removed_creators IS
  'WI-10004257: addresses the portal reported as no longer active members of this machine''s organization (connector frame membership.report). Replaced per organization on every report. Read only by the connected-app creator-removed alert; never an authorization input.';
