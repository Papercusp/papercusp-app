-- 109-global-schemas-and-grants.sql
--
-- Close two completeness gaps the squashed 000-baseline.sql inherited from the
-- reference build's narrow dump (pg_dump --schema=harness_shared --schema=papercup_shared
-- --no-privileges), invisible to the schema-diff gate (which used the same narrow scope):
--
--   PART A — the core global schemas the 2-schema dump omitted: papercusp_auth (operator
--   identity: users/sessions/magic_link_requests) + audit (operator_actions/action_executions).
--   Previously built by archived migrations 004-auth / 006 / 007; without this, a fresh
--   migrations-only boot has no auth/audit schema. (papercusp_marketplace is plugin-created
--   at runtime — correctly NOT here. Per-harness harness_<slug>, dbos, zero* are runtime too.)
--
--   PART B — table/sequence GRANTs for the runtime roles. The --no-privileges dump dropped
--   every GRANT, so a fresh boot would build tables the app role (harness_app) cannot read or
--   write and the replication role (harness_zero) cannot SELECT. This restores the standard
--   role permissions (mirrors the embedded-pg boot's seed re-grant) across all 4 global schemas
--   + ALTER DEFAULT PRIVILEGES so future migration-created tables inherit them.
--
-- Idempotent: CREATE SCHEMA/TABLE/INDEX IF NOT EXISTS (Part A) + GRANT/ALTER DEFAULT
-- PRIVILEGES (Part B, naturally idempotent). Runs as harness_admin (the migration role).

-- ============ PART A: missing global schemas ============
CREATE SCHEMA IF NOT EXISTS audit;

CREATE SCHEMA IF NOT EXISTS papercusp_auth;

CREATE TABLE IF NOT EXISTS audit.action_executions (
    id bigint NOT NULL,
    harness_slug text NOT NULL,
    plugin_name text NOT NULL,
    action_name text NOT NULL,
    trigger_source text NOT NULL,
    idempotency_key text NOT NULL,
    params_json jsonb,
    status text DEFAULT 'running'::text NOT NULL,
    error_msg text,
    result_json jsonb,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    webhook_emitted_at timestamp with time zone,
    CONSTRAINT action_executions_status_check CHECK ((status = ANY (ARRAY['running'::text, 'ok'::text, 'error'::text, 'timeout'::text])))
);

CREATE SEQUENCE IF NOT EXISTS audit.action_executions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE audit.action_executions_id_seq OWNED BY audit.action_executions.id;

CREATE TABLE IF NOT EXISTS audit.operator_actions (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    action text NOT NULL,
    target text,
    details_json jsonb,
    http_method text,
    http_path text,
    actor text DEFAULT 'operator'::text NOT NULL,
    status_code integer NOT NULL,
    source_ip text
);

CREATE SEQUENCE IF NOT EXISTS audit.operator_actions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE audit.operator_actions_id_seq OWNED BY audit.operator_actions.id;

CREATE TABLE IF NOT EXISTS papercusp_auth.magic_link_requests (
    token text NOT NULL,
    email text NOT NULL,
    created_ts bigint NOT NULL,
    expires_ts bigint NOT NULL,
    consumed_ts bigint,
    ip text
);

CREATE TABLE IF NOT EXISTS papercusp_auth.sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    created_ts bigint NOT NULL,
    expires_ts bigint NOT NULL,
    user_agent text,
    ip text
);

CREATE TABLE IF NOT EXISTS papercusp_auth.users (
    id text NOT NULL,
    email text NOT NULL,
    display_name text,
    github_login text,
    created_ts bigint NOT NULL,
    last_login_ts bigint
);

ALTER TABLE ONLY audit.action_executions ALTER COLUMN id SET DEFAULT nextval('audit.action_executions_id_seq'::regclass);

ALTER TABLE ONLY audit.operator_actions ALTER COLUMN id SET DEFAULT nextval('audit.operator_actions_id_seq'::regclass);

DO $baseline_guard$ BEGIN
  ALTER TABLE ONLY audit.action_executions
    ADD CONSTRAINT action_executions_idempotency_key_key UNIQUE (idempotency_key);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
END $baseline_guard$;

DO $baseline_guard$ BEGIN
  ALTER TABLE ONLY audit.action_executions
    ADD CONSTRAINT action_executions_pkey PRIMARY KEY (id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
END $baseline_guard$;

DO $baseline_guard$ BEGIN
  ALTER TABLE ONLY audit.operator_actions
    ADD CONSTRAINT operator_actions_pkey PRIMARY KEY (id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
END $baseline_guard$;

DO $baseline_guard$ BEGIN
  ALTER TABLE ONLY papercusp_auth.magic_link_requests
    ADD CONSTRAINT magic_link_requests_pkey PRIMARY KEY (token);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
END $baseline_guard$;

DO $baseline_guard$ BEGIN
  ALTER TABLE ONLY papercusp_auth.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
END $baseline_guard$;

DO $baseline_guard$ BEGIN
  ALTER TABLE ONLY papercusp_auth.users
    ADD CONSTRAINT users_email_key UNIQUE (email);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
END $baseline_guard$;

DO $baseline_guard$ BEGIN
  ALTER TABLE ONLY papercusp_auth.users
    ADD CONSTRAINT users_github_login_key UNIQUE (github_login);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
END $baseline_guard$;

DO $baseline_guard$ BEGIN
  ALTER TABLE ONLY papercusp_auth.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
END $baseline_guard$;

CREATE INDEX IF NOT EXISTS action_executions_harness_idx ON audit.action_executions USING btree (harness_slug, started_at DESC);

CREATE INDEX IF NOT EXISTS action_executions_pending_webhook_idx ON audit.action_executions USING btree (id) WHERE ((status = ANY (ARRAY['error'::text, 'timeout'::text])) AND (webhook_emitted_at IS NULL));

CREATE INDEX IF NOT EXISTS action_executions_plugin_action_idx ON audit.action_executions USING btree (plugin_name, action_name, started_at DESC);

CREATE INDEX IF NOT EXISTS action_executions_status_idx ON audit.action_executions USING btree (status) WHERE (status <> 'ok'::text);

CREATE INDEX IF NOT EXISTS operator_actions_action_idx ON audit.operator_actions USING btree (action, ts DESC);

CREATE INDEX IF NOT EXISTS operator_actions_target_idx ON audit.operator_actions USING btree (target, ts DESC) WHERE (target IS NOT NULL);

CREATE INDEX IF NOT EXISTS operator_actions_ts_idx ON audit.operator_actions USING btree (ts DESC);

CREATE INDEX IF NOT EXISTS magic_email_idx ON papercusp_auth.magic_link_requests USING btree (email);

CREATE INDEX IF NOT EXISTS magic_expires_idx ON papercusp_auth.magic_link_requests USING btree (expires_ts);

CREATE INDEX IF NOT EXISTS sessions_expires_idx ON papercusp_auth.sessions USING btree (expires_ts);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON papercusp_auth.sessions USING btree (user_id);

CREATE INDEX IF NOT EXISTS users_email_idx ON papercusp_auth.users USING btree (email);

DO $baseline_guard$ BEGIN
  ALTER TABLE ONLY papercusp_auth.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES papercusp_auth.users(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
END $baseline_guard$;

-- ============ PART B: runtime-role grants ============
DO $grants$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['harness_shared','papercup_shared','papercusp_auth','audit'] LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO harness_app, harness_zero', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO harness_app', s);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO harness_zero', s);
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO harness_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO harness_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO harness_zero', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO harness_app', s);
  END LOOP;
END
$grants$;
