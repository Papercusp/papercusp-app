-- 1210-operator-embed-device.sql — memory-reduction-2026-09-24 P-008 / D-003 / D-008
-- (WI-10002872).
--
-- Single-row-per-workspace JSONB setting: WHICH device the local embedding
-- models run on — the "Auto / GPU / CPU" choice on Settings → Memory. The
-- operator-state idiom (migration 020; exact sibling of
-- operator_consult_expert_routing, 1202 / knowledge_pack_config, 639), so
-- readOperatorState/writeOperatorState drive it with ON CONFLICT (workspace_id).
--
-- Payload shape:
--   { "preference": "auto" | "cuda" | "cpu", "updatedBy": "<actor>" }
--
-- WHY THE TABLE MAY BE EMPTY, AND WHY THAT IS SAFE. No row means "auto": use the
-- GPU when its runtime and driver are present, else the CPU — the owner's chosen
-- default (D-003). Every process that embeds (the operator host, the embed
-- sidecar) reads this row at boot, before warming models, and a host-level
-- PAPERCUSP_EMBED_DEVICE=cpu|gpu still outranks it (D-008), so a read failure
-- degrades to the env/auto behaviour, never to "no embeddings".
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_embed_device (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_embed_device TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_embed_device TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_embed_device ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_embed_device_workspace_isolation ON harness_shared.operator_embed_device;
CREATE POLICY operator_embed_device_workspace_isolation ON harness_shared.operator_embed_device
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
