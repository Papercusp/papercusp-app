-- Plugin capability grants — Tier 2 of the two-tier capability check.
-- Tier 1 is the plugin's manifest-declared capabilities[]; Tier 2 is the
-- user's per-(plugin@version, harness, cap) consent. Both must allow a
-- request for it to succeed.
--
-- Rust-port-feedback item 3. PG-canonical (per `feedback_pg_by_default`);
-- the legacy ~/.papercusp/granted-capabilities.json is read-only fallback
-- for one release cycle and removed after.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS harness_shared.plugin_capability_grants (
  plugin_name      TEXT NOT NULL,           -- '@papercupai/cloudflare-pages' or bare 'foo'
  plugin_version   TEXT NOT NULL,           -- semver pinned at grant time
  harness_slug     TEXT NOT NULL,           -- '' for global / not-yet-bound grants
  capability       TEXT NOT NULL,           -- exact cap or wildcard (e.g. http:fetch:*.foo.com)
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by       TEXT,                    -- operator user id, or 'system' for backfill
  reason           TEXT,                    -- optional note: 'install consent', 'backfill', etc.
  PRIMARY KEY (plugin_name, plugin_version, harness_slug, capability)
);

CREATE INDEX IF NOT EXISTS plugin_caps_by_harness
  ON harness_shared.plugin_capability_grants (harness_slug, plugin_name);

CREATE INDEX IF NOT EXISTS plugin_caps_by_plugin
  ON harness_shared.plugin_capability_grants (plugin_name, plugin_version);
