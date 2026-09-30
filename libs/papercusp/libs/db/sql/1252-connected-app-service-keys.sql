-- 1252-connected-app-service-keys.sql
-- external-app-access-to-workspaces-2026-09-29 P-015 (WI-10004016).
--
-- WHY. An unattended app (a cron host, an automation server, a third-party integration) signs in
-- once, at setup, and then proves itself with a stored credential for every call, with nobody
-- signed in (owner question #936). That credential is a SERVICE KEY: a connected_apps row like an
-- app key (same pcapp_<id>_<secret> bearer, same scopes, same pause/revoke/expiry), except that:
--
--   * it belongs to the WORKSPACE, not to the person who created it. It has no expiry unless the
--     owner sets one, and it keeps authenticating after its creator leaves the organization (D-007).
--     user_email still records who created it, for display and for P-011's "creator removed"
--     alert. It is never an authorization input.
--   * a spending cap is MANDATORY (R-13), because a key that never expires could otherwise run up
--     unlimited LLM spend once leaked. The CHECK below enforces the cap at the storage layer, the
--     same way R-8's hash-shape CHECK does, so no issuance path can create an uncapped key.
--   * rotation has an OVERLAP WINDOW (R-11/R-12): rotating mints a new secret for the same id and
--     keeps the old secret's digest valid until a deadline, so the app can be re-configured with no
--     downtime. Only one previous secret is kept. Rotating again inside the window retires the
--     oldest secret at once.
--
-- The rotation columns apply to every key kind that carries a bearer ('app' and 'service'), so the
-- Remote access screen (P-010) can rotate any key. The spending-cap columns apply to every kind
-- too: P-011 enforces caps on every connected app (R-27), and only service keys REQUIRE one.
--
-- Cap shape mirrors harness_shared.goals.budget_cents + budget_window_sec (migration 914): a
-- ceiling in US cents, measured over a TRAILING window of that many seconds, NULL window = the
-- key's whole lifetime. Reusing that shape keeps one meaning of "a spend ceiling" in the schema.
--
-- FORWARD-COMPAT: the two constraints dropped below are re-created WIDER for everything the
-- deployed :3070 release writes. The release's app-key code (connected-apps/store.ts at P-002/P-005)
-- only inserts kind='app' rows and the phone code only inserts kind='mobile' rows through the
-- mobile_devices view; both values stay allowed by the new kind CHECK, and the new token-hash CHECK
-- only adds a condition on kind='service' rows, which that release never writes. Neither constraint
-- is an ON CONFLICT arbiter. Every added column is nullable with no default, so the release's
-- INSERT column lists stay valid.

DO $$
BEGIN
  -- Fresh-DB safe, like 1244: a database with no connected_apps table has nothing to extend.
  IF to_regclass('harness_shared.connected_apps') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE harness_shared.connected_apps
    ADD COLUMN IF NOT EXISTS spend_cap_cents            bigint,
    ADD COLUMN IF NOT EXISTS spend_cap_window_sec       integer,
    ADD COLUMN IF NOT EXISTS previous_token_hash        text,
    ADD COLUMN IF NOT EXISTS previous_token_valid_until timestamptz,
    ADD COLUMN IF NOT EXISTS rotated_at                 timestamptz;

  -- Widen the kind set: 'service' is the third kind of outside credential.
  ALTER TABLE harness_shared.connected_apps
    DROP CONSTRAINT IF EXISTS connected_apps_kind_check,
    ADD CONSTRAINT connected_apps_kind_check CHECK (kind IN ('mobile', 'app', 'service'));

  -- A bearer-carrying row without a digest is a key nobody can ever present (1244's rule, now
  -- covering service keys too).
  ALTER TABLE harness_shared.connected_apps
    DROP CONSTRAINT IF EXISTS connected_apps_app_has_token_hash,
    ADD CONSTRAINT connected_apps_app_has_token_hash
      CHECK (kind NOT IN ('app', 'service') OR token_hash IS NOT NULL);

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'harness_shared.connected_apps'::regclass
                    AND conname = 'connected_apps_service_has_spend_cap') THEN
    ALTER TABLE harness_shared.connected_apps
      -- R-13 at the storage layer: a service key cannot exist without a spending cap.
      ADD CONSTRAINT connected_apps_service_has_spend_cap
        CHECK (kind <> 'service' OR spend_cap_cents IS NOT NULL),
      -- A zero or negative ceiling is not a stricter cap, it is an undefined one.
      ADD CONSTRAINT connected_apps_spend_cap_positive
        CHECK (spend_cap_cents IS NULL OR spend_cap_cents > 0),
      -- A trailing window of length <= 0 selects no spend at all (same rule as goals, 914).
      ADD CONSTRAINT connected_apps_spend_cap_window_positive
        CHECK (spend_cap_window_sec IS NULL OR spend_cap_window_sec > 0),
      -- The previous secret is stored exactly like the current one: a sha256 hex digest only.
      ADD CONSTRAINT connected_apps_previous_token_hash_shape
        CHECK (previous_token_hash IS NULL OR previous_token_hash ~ '^[0-9a-f]{64}$'),
      -- A previous secret without a deadline would stay valid forever; a deadline without a
      -- secret is meaningless. They are written together or not at all.
      ADD CONSTRAINT connected_apps_previous_token_pair
        CHECK ((previous_token_hash IS NULL) = (previous_token_valid_until IS NULL)),
      -- Only bearer-carrying kinds rotate; a phone authenticates with its device JWT.
      ADD CONSTRAINT connected_apps_previous_token_kind
        CHECK (previous_token_hash IS NULL OR kind IN ('app', 'service'));
  END IF;
END
$$;

COMMENT ON COLUMN harness_shared.connected_apps.spend_cap_cents IS
  'LLM spending ceiling for this credential, in US cents, measured over spend_cap_window_sec (P-011 enforces it). REQUIRED for kind=service (R-13); optional for other kinds. Same shape as goals.budget_cents.';
COMMENT ON COLUMN harness_shared.connected_apps.spend_cap_window_sec IS
  'Trailing window for spend_cap_cents, in seconds. NULL = the cap covers the key''s whole lifetime. Same meaning as goals.budget_window_sec.';
COMMENT ON COLUMN harness_shared.connected_apps.previous_token_hash IS
  'sha256 hex of the key this row had before its last rotation. It authenticates until previous_token_valid_until (the rotation overlap window, R-11) and is refused after it (R-12).';
COMMENT ON COLUMN harness_shared.connected_apps.previous_token_valid_until IS
  'End of the rotation overlap window: the previous key is refused from this instant on.';
COMMENT ON COLUMN harness_shared.connected_apps.rotated_at IS
  'When the key was last rotated. NULL = never rotated.';
COMMENT ON COLUMN harness_shared.connected_apps.user_email IS
  'For a phone, the person who paired it. For an app or service key, the person who created it: display and audit data only. A service key belongs to the workspace and keeps working after its creator leaves the organization (D-007).';
