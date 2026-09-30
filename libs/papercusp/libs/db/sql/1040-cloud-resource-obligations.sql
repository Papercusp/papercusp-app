-- 1040-cloud-resource-obligations.sql — closes EI-21915296593490861.
--
-- WHY THIS EXISTS
-- ----------------
-- P-046 agents repeatedly create real, metered GCP infra (custom networks, subnets,
-- Cloud Routers, Cloud NATs) because the default network has no NAT and a clean-room /
-- Packer guest cannot reach the internet without one. Until now the teardown obligation
-- was recorded ONLY as prose in a work-item checkpoint ("TEARDOWN OWED — standing GCP
-- cost"). Nothing enforced or detected it, and prose does not survive the creating
-- agent's death: WI-40474 measured three successive holders dying/stalling in sequence
-- while the obligation sat undischarged in checkpoint text across every handoff (~18h
-- and counting at filing time).
--
-- This table makes the obligation a ROW, not a paragraph — written at (or shortly
-- after) the moment the resource is created, independent of any one agent's session
-- surviving to discharge it. A scheduled, owner-independent sweep (see
-- packages/operator-core/lib/dbos/periodic-workflows.ts, cloudResourceObligationSweep)
-- reads every still-open row past its grace period and files/refreshes a durable
-- escalation work-item — so detection no longer depends on the creating agent's prose
-- reaching a live successor.
--
-- Actually tearing down the resource still requires a working cloud credential (the
-- same gap the filing agent hit: `compute.routers.list` denied to the only working
-- credential on this box) — that remains a human/infra-owner action taken against the
-- escalation this sweep files. This migration closes the DETECTOR gap the issue names
-- as "the second bug": network-tier resources previously had no owner-independent
-- census trigger at all.
--
-- No top-level BEGIN/COMMIT: the migration runner wraps each file.

CREATE TABLE IF NOT EXISTS harness_shared.cloud_resource_obligations (
  id                       BIGSERIAL   PRIMARY KEY,
  workspace_id             TEXT        NOT NULL,
  provider                 TEXT        NOT NULL CHECK (provider IN ('gcp')),
  resource_kind            TEXT        NOT NULL CHECK (length(btrim(resource_kind)) BETWEEN 1 AND 80),
  resource_id              TEXT        NOT NULL CHECK (length(btrim(resource_id)) BETWEEN 1 AND 300),
  project_id               TEXT        NOT NULL DEFAULT '',
  purpose                  TEXT        NOT NULL DEFAULT '',
  created_by_owner_id      TEXT        NOT NULL DEFAULT '',
  source_work_item_id      TEXT        NOT NULL DEFAULT '',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- How long a fresh obligation is allowed to sit before the sweep may escalate it.
  -- Real release-cut NAT infra is legitimately needed for the duration of one build;
  -- the default gives a full working day before treating it as forgotten.
  grace_ms                 BIGINT      NOT NULL DEFAULT 21600000 CHECK (grace_ms >= 0),
  teardown_owed            BOOLEAN     NOT NULL DEFAULT true,
  closed_at                TIMESTAMPTZ,
  closed_reason            TEXT        NOT NULL DEFAULT '',
  last_escalated_at        TIMESTAMPTZ,
  escalation_work_item_id  TEXT        NOT NULL DEFAULT '',
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, resource_kind, resource_id)
);

-- The sweep's whole query shape: open, teardown-owed rows ordered by age. Partial on
-- the open condition so a large closed history never bloats the index the sweep walks.
CREATE INDEX IF NOT EXISTS cloud_resource_obligations_open_idx
  ON harness_shared.cloud_resource_obligations (workspace_id, created_at)
  WHERE closed_at IS NULL AND teardown_owed;

COMMENT ON TABLE harness_shared.cloud_resource_obligations IS
  'Durable per-resource teardown obligation, keyed to the RESOURCE (not a checkpoint paragraph). Written at creation time; closed by whoever discharges (deletes) the resource or confirms it never existed. Swept on a schedule independent of the creating agent''s liveness — see cloudResourceObligationSweep in periodic-workflows.ts. EI-21915296593490861.';

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.cloud_resource_obligations TO harness_app;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.cloud_resource_obligations_id_seq TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.cloud_resource_obligations TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.cloud_resource_obligations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cloud_resource_obligations_workspace_isolation
  ON harness_shared.cloud_resource_obligations;
CREATE POLICY cloud_resource_obligations_workspace_isolation
  ON harness_shared.cloud_resource_obligations
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
