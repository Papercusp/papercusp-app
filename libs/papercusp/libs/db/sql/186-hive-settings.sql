-- 186: hive_settings — per-Hive settings federated as first-class HIVE state
-- (shared-hive-federation-2026-06-08 P-005).
--
-- Retires the "settings stay local" gap: a shared Hive's settings (the hive:update
-- config — concurrency ceiling, budget, automation tier, …) federate over the
-- HIVE's peer-log, scoped to the Hive's HOME harness slug (which carries the Hive
-- identity, migration 184) so they ride the Hive-pubkey topic (P-004) via the
-- EXISTING peer-log machinery. D-003: change only the key, reuse the transport —
-- this MIRRORS harness_plans (migrations 122/125), the closest analog (a
-- workspace-owned key riding the peer-log).
--
-- KEYING: (workspace_id, harness_slug, setting_key) where harness_slug = a Hive's
-- home_slug. No HARD FK to hives — the logical scope (a Hive home) is enforced at
-- the store layer (hive-settings-store.ts), and the read-side projection must stay
-- tolerant of applying a setting before the hive identity row materializes locally
-- on a peer (cross-machine join ordering). `value` is JSON-serialized TEXT (no
-- jsonb-binding dance; mirrors harness_plans' all-text federated subset).
-- origin/author_pubkey/fed_ts = the standard federation columns (echo-guard +
-- provenance + LWW). The projection (projections/hive-settings.ts, tableTag
-- 'hive-settings-by-key') applies inbound ops; the capture triggers below enqueue
-- local writes via capture_substrate_outbox (key = setting_key, TG_ARGV[0]).
--
-- Must land WITH the code (feature-issue-op-keys.ts mapping + register-all.ts
-- projection registration); apply after an operator restart so the drain can
-- dispatch the new table_name. Idempotent; RLS workspace isolation mirrors hives.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.hive_settings (
    workspace_id  text NOT NULL,
    harness_slug  text NOT NULL,        -- the Hive's home_slug (carries the identity)
    setting_key   text NOT NULL,
    value         text,                 -- JSON-serialized setting value (federated)
    author_pubkey text,
    origin        text NOT NULL DEFAULT 'local',
    fed_ts        bigint,
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL DEFAULT 0
);

DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hive_settings_pkey') THEN
    ALTER TABLE ONLY harness_shared.hive_settings
      ADD CONSTRAINT hive_settings_pkey PRIMARY KEY (workspace_id, harness_slug, setting_key);
  END IF;
END
$body$;

ALTER TABLE harness_shared.hive_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hive_settings_workspace_isolation ON harness_shared.hive_settings;
CREATE POLICY hive_settings_workspace_isolation ON harness_shared.hive_settings USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Federation capture (mirrors harness_plans mig 125). INSERT/DELETE always
-- capture (the echo-guard in capture_substrate_outbox skips origin<>'local');
-- UPDATE only when the federated `value` actually changes (not on updated_at bumps).
CREATE OR REPLACE TRIGGER capture_hive_settings_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.hive_settings
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('setting_key');

CREATE OR REPLACE TRIGGER capture_hive_settings_outbox_upd_trg
  AFTER UPDATE ON harness_shared.hive_settings
  FOR EACH ROW WHEN (OLD.value IS DISTINCT FROM NEW.value)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('setting_key');

COMMIT;
