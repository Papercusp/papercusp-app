-- Migration 055 — hot-reload state preservation.
--
-- Backs the getStateForReload/restoreFromReload hooks in
-- @papercusp/plugin-sdk PluginHooks. Pure cache: deleting any row is
-- always safe, just means the next reload starts fresh.
--
-- Size budget: state ≤ 64 KiB, enforced at write time. Bigger state
-- belongs in pluginDataDir (files) or ctx.kv (PG K/V); this table is
-- for the small in-memory state that needs to survive a single reload.

CREATE SCHEMA IF NOT EXISTS harness_shared;

CREATE TABLE IF NOT EXISTS harness_shared.plugin_reload_state (
  plugin_id    TEXT NOT NULL,
  harness_slug TEXT NOT NULL,
  state        JSONB NOT NULL,
  byte_size    INTEGER NOT NULL,
  saved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, harness_slug)
);
