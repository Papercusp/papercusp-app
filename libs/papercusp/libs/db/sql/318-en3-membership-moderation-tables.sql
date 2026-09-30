-- 318: EN-3 membership-admission + moderation federated tables
-- (PLAN-owner-enforcement-layer Phase EN-3 / Brief EN-3 — P-MEMBER + P-MOD).
--
-- Two new federated tables, both mirroring hive_settings (mig 186) + hive_epoch_keys
-- (mig 316): the standard federation bookkeeping (fed_ts/fed_hlc LWW of record,
-- `origin` echo-guard, the BEFORE stamp_local_federated_write trigger + the AFTER
-- capture_substrate_outbox trigger), scope column `harness_slug` = the Hive HOME
-- slug (so the stock capture_substrate_outbox — which reads NEW.harness_slug for the
-- outbox scope — works directly, no custom capture fn; mirrors hive_settings, NOT the
-- hive_members `hive_home_slug` deviation). Both ride the hive-home→joiner seam
-- A-003 (a′) established, so they federate BIDIRECTIONALLY: the home-scoped
-- projection is active on BOTH the owner's home harness AND a joiner's member harness
-- (register-all hiveScoped binding), so a joiner's pending-join request / a member's
-- report reaches the OWNER, and the owner's decision reaches them back.
--
--   hive_pending_joins — approval-mode: a joiner writes a pending request that
--     federates to the owner; the owner decides (approve → upsertHiveMember +
--     status='approved'; deny → status='denied'). The joiner is NOT trust-admitted
--     (never in hive_members) until approved. (Brief EN-3 / P-MEMBER.)
--   hive_reports — moderation: any admitted member writes a report (content/member)
--     that federates to the owner's moderation queue; the owner actions/dismisses it.
--     (Brief EN-3 / P-MOD report endpoint.)
--
-- Takedowns + bans are NOT here — they ride EN-1's owner-SIGNED hive_policy
-- (moderation.takedownList / moderation.bannedGithubIds), which gives forgery-
-- resistance + monotonic-version no-resurrection for free. Reports go member→owner
-- (members write them, not the owner) so they cannot ride the signed policy — hence
-- this separate federated table.
--
-- DARK / additive: nothing writes origin='local' here until the EN-3 store/wiring
-- lands, so the capture triggers never fire until then — safe to land + auto-apply
-- (exactly as plan-parts mig 270/271 + hive_epoch_keys mig 316 shipped DARK).
--
-- The migration runner wraps each file in its own transaction (and strips psql
-- metacommands), so this file carries NO top-level BEGIN;/COMMIT;/\set — an inner
-- COMMIT would end the runner's wrapper txn early (migration-runner.js contract;
-- lint:migrations).

-- ── hive_pending_joins (P-MEMBER approval mode) ────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.hive_pending_joins (
    workspace_id         text NOT NULL,
    harness_slug         text NOT NULL,        -- the Hive's home_slug (identity; projection demux scope; mirrors hive_settings)
    github_user_id       bigint NOT NULL,      -- the prospective joiner's stable numeric GitHub id
    github_username      text NOT NULL,        -- the joiner's login (allowlist-match key on the owner side)
    display_name         text,
    avatar_url           text,
    device_attestations  jsonb NOT NULL DEFAULT '[]'::jsonb,  -- the joiner's devices (used to upsertHiveMember on approval)
    status               text NOT NULL DEFAULT 'pending',     -- 'pending' | 'approved' | 'denied'
    reason               text,                 -- optional owner note (e.g. deny reason)
    requested_at         bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
    decided_at           bigint,
    decided_by_github_user_id bigint,          -- the owner who approved/denied
    -- Federation bookkeeping (mirrors hive_settings + mig 314).
    author_pubkey        text,
    origin               text NOT NULL DEFAULT 'local',  -- echo-guard: capture skips origin<>'local'
    fed_ts               bigint,
    fed_hlc              text,
    -- The peer-log key for a pending-join row = the joiner's github id, unique within
    -- a Hive. capture_substrate_outbox keys on ONE column; the projection's composeKey
    -- returns the identical value (String(github_user_id)).
    pending_join_fed_key text GENERATED ALWAYS AS (github_user_id::text) STORED,
    created_at           bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
    updated_at           bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint
);

DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hive_pending_joins_pkey') THEN
    ALTER TABLE ONLY harness_shared.hive_pending_joins
      ADD CONSTRAINT hive_pending_joins_pkey PRIMARY KEY (workspace_id, harness_slug, github_user_id);
  END IF;
END
$body$;

-- Owner-queue read path: a Hive's pending requests by status.
CREATE INDEX IF NOT EXISTS hive_pending_joins_by_status
  ON harness_shared.hive_pending_joins (workspace_id, harness_slug, status);

ALTER TABLE harness_shared.hive_pending_joins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hive_pending_joins_workspace_isolation ON harness_shared.hive_pending_joins;
CREATE POLICY hive_pending_joins_workspace_isolation ON harness_shared.hive_pending_joins
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- fed_ts/fed_hlc local-write stamp (mig 214 + d001 mig 314).
CREATE OR REPLACE TRIGGER stamp_local_federated_write_trg
  BEFORE INSERT OR UPDATE ON harness_shared.hive_pending_joins
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();

-- CDC capture → substrate_outbox (mirrors hive_settings mig 186). INSERT always
-- captures; UPDATE captures when the federated content (status/reason/devices) moves.
CREATE OR REPLACE TRIGGER capture_hive_pending_joins_outbox_trg
  AFTER INSERT ON harness_shared.hive_pending_joins
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('pending_join_fed_key');

CREATE OR REPLACE TRIGGER capture_hive_pending_joins_outbox_upd_trg
  AFTER UPDATE ON harness_shared.hive_pending_joins
  FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.reason IS DISTINCT FROM NEW.reason
    OR OLD.device_attestations IS DISTINCT FROM NEW.device_attestations
  )
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('pending_join_fed_key');

-- ── hive_reports (P-MOD report endpoint) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.hive_reports (
    workspace_id              text NOT NULL,
    harness_slug              text NOT NULL,   -- the Hive's home_slug (identity; projection demux scope)
    report_id                 text NOT NULL,   -- caller-minted stable id (the peer-log key, single text col)
    reporter_github_user_id   bigint NOT NULL, -- the member who filed the report
    reporter_github_username  text,
    target_kind               text NOT NULL,   -- 'content' | 'member'
    target_ref                text NOT NULL,   -- content ref (feature/work-item id) or the reported member's github id
    report_reason             text,            -- free-text reason from the reporter
    status                    text NOT NULL DEFAULT 'open',  -- 'open' | 'actioned' | 'dismissed'
    -- Federation bookkeeping.
    author_pubkey             text,
    origin                    text NOT NULL DEFAULT 'local',
    fed_ts                    bigint,
    fed_hlc                   text,
    created_at                bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
    updated_at                bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint
);

DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hive_reports_pkey') THEN
    ALTER TABLE ONLY harness_shared.hive_reports
      ADD CONSTRAINT hive_reports_pkey PRIMARY KEY (workspace_id, harness_slug, report_id);
  END IF;
END
$body$;

-- Owner moderation-queue read path: a Hive's reports by status, newest first.
CREATE INDEX IF NOT EXISTS hive_reports_by_status
  ON harness_shared.hive_reports (workspace_id, harness_slug, status, created_at DESC);

ALTER TABLE harness_shared.hive_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hive_reports_workspace_isolation ON harness_shared.hive_reports;
CREATE POLICY hive_reports_workspace_isolation ON harness_shared.hive_reports
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

CREATE OR REPLACE TRIGGER stamp_local_federated_write_trg
  BEFORE INSERT OR UPDATE ON harness_shared.hive_reports
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();

-- INSERT always captures (a new report federates to the owner); UPDATE captures when
-- the owner's resolution (status) moves, so the dismissal/action federates back.
CREATE OR REPLACE TRIGGER capture_hive_reports_outbox_trg
  AFTER INSERT ON harness_shared.hive_reports
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('report_id');

CREATE OR REPLACE TRIGGER capture_hive_reports_outbox_upd_trg
  AFTER UPDATE ON harness_shared.hive_reports
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('report_id');
