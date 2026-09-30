-- Migration 054 — plugin-private key/value store.
--
-- Backs the `ctx.kv` API exposed in @papercusp/plugin-sdk. Each plugin
-- gets its own namespace within its harness; cross-plugin reads are
-- impossible (the SDK shape enforces it; this table is just the
-- backing store).
--
-- Quotas (enforced in apps/operator/lib/plugin-kv.ts):
--   max bytes per key:     10 KiB (configurable per-plugin via manifest)
--   max bytes per plugin:  1 MiB  (configurable per-plugin via manifest)
--
-- Byte size is computed at write time from the JSON-stringified value
-- and stored alongside the row so quota checks don't re-stringify.

CREATE SCHEMA IF NOT EXISTS harness_shared;

CREATE TABLE IF NOT EXISTS harness_shared.plugin_kv (
  plugin_id    TEXT NOT NULL,
  harness_slug TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        JSONB NOT NULL,
  byte_size    INTEGER NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, harness_slug, key)
);

-- Per-plugin quota lookup (SUM byte_size GROUP BY plugin_id, harness_slug).
CREATE INDEX IF NOT EXISTS idx_plugin_kv_quota
  ON harness_shared.plugin_kv (plugin_id, harness_slug);

-- Prefix-scan support for ctx.kv.list({ prefix }).
CREATE INDEX IF NOT EXISTS idx_plugin_kv_prefix
  ON harness_shared.plugin_kv (plugin_id, harness_slug, key text_pattern_ops);
