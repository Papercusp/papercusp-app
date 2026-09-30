-- 064-users-primary-key-fix.sql
--
-- Recovery: migration 058 declared PRIMARY KEYs on users / user_sessions /
-- user_preferences, but on machines where the tables were created by an
-- earlier partial migration the constraints never materialized. All three
-- tables are in publication "zero_harness" — without a replica identity,
-- UPDATE and DELETE on them fail with "cannot update/delete table because
-- it does not have a replica identity and publishes ...".
--
-- That broke:
--   - login() — UPDATE last_login_at on users
--   - changePassword() — UPDATE password_hash on users + DELETE other sessions
--   - logout() — DELETE on user_sessions
--   - session expiry cleanup — DELETE on user_sessions
--   - per-user pref upserts (writes to user_preferences)
--
-- The fix is idempotent: add the PKs (and the username UNIQUE) if missing.

DO LANGUAGE plpgsql $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid='harness_shared.users'::regclass AND contype='p') THEN
    EXECUTE 'ALTER TABLE harness_shared.users ADD PRIMARY KEY (id)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid='harness_shared.users'::regclass AND contype='u'
                    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                         WHERE attrelid='harness_shared.users'::regclass
                                           AND attname='username')]) THEN
    EXECUTE 'ALTER TABLE harness_shared.users ADD CONSTRAINT users_username_key UNIQUE (username)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid='harness_shared.user_sessions'::regclass AND contype='p') THEN
    EXECUTE 'ALTER TABLE harness_shared.user_sessions ADD PRIMARY KEY (token)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid='harness_shared.user_preferences'::regclass AND contype='p') THEN
    EXECUTE 'ALTER TABLE harness_shared.user_preferences ADD PRIMARY KEY (user_id)';
  END IF;
END
$body$;
