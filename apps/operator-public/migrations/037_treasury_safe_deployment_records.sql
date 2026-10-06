-- Append-only log of every treasury Safe deployment record (agent-economy-flywheel
-- P-040 follow-up, WI-10004620).
--
-- treasury_safe_deployments (mig 027) is an upsert REGISTRY: re-recording the same
-- Safe after a roles-module upgrade overwrites the row, which is the right shape
-- for "what is deployed now" but cannot be hash-chained, because a link to an old
-- version of a row would read as tampering. This table is the ledger beside it:
-- recordSafeDeployment writes one row here in the same batch as the upsert, so
-- every deployment record ever made (including the values a later re-record
-- overwrote) is kept and chained as the `treasury.safe-deployment-records` stream
-- in src/ledger-chain-store.ts.
CREATE TABLE IF NOT EXISTS treasury_safe_deployment_records (
  record_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  safe_address TEXT NOT NULL,
  roles_module_address TEXT NOT NULL,
  roles_version TEXT NOT NULL,
  deployment_tx_hash TEXT NOT NULL,
  network TEXT NOT NULL,
  owners TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  automation_signer TEXT NOT NULL,
  deployed_at_ms INTEGER NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  recorded_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS treasury_safe_deployment_records_safe_idx
  ON treasury_safe_deployment_records (chain_id, safe_address, recorded_at_ms);

-- The log is append-only. The chain only makes tampering EVIDENT; refusing
-- in-place edits keeps an honest bug from rewriting a record it should append.
CREATE TRIGGER IF NOT EXISTS treasury_safe_deployment_records_no_update
  BEFORE UPDATE ON treasury_safe_deployment_records
  BEGIN
    SELECT RAISE(ABORT, 'treasury_safe_deployment_records is append-only');
  END;

CREATE TRIGGER IF NOT EXISTS treasury_safe_deployment_records_no_delete
  BEFORE DELETE ON treasury_safe_deployment_records
  BEGIN
    SELECT RAISE(ABORT, 'treasury_safe_deployment_records is append-only');
  END;

-- Seed the log with the current registry, so a deployment recorded before this
-- migration is still in the chained history. Only the latest version of such a
-- row survives in the registry, so that is all that can be seeded. The id is
-- deterministic, so re-running the migration seeds nothing twice.
INSERT OR IGNORE INTO treasury_safe_deployment_records
  (record_id, chain_id, safe_address, roles_module_address, roles_version, deployment_tx_hash,
   network, owners, threshold, automation_signer, deployed_at_ms, recorded_at_ms, recorded_by)
SELECT
  'seed:' || chain_id || ':' || lower(safe_address) || ':' || recorded_at_ms,
  chain_id, safe_address, roles_module_address, roles_version, deployment_tx_hash,
  network, owners, threshold, automation_signer, deployed_at_ms, recorded_at_ms, recorded_by
FROM treasury_safe_deployments;
