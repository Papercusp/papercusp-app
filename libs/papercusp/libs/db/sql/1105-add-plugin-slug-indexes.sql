-- 1105-add-plugin-slug-indexes.sql
--
-- WI-879057 — the generated schema declares plugin_slug indexes for both
-- plugin configuration tables, but the migration corpus only created the
-- workspace_id indexes. Add the missing indexes so fresh installs match the
-- shipped schema snapshot.

CREATE INDEX IF NOT EXISTS plugin_configs_plugin_idx
  ON harness_shared.plugin_configs USING btree (plugin_slug);

CREATE INDEX IF NOT EXISTS plugin_enables_plugin_idx
  ON harness_shared.plugin_enables USING btree (plugin_slug);
