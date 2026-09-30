-- 442-gate-verdicts.sql
-- cross-machine-coord-parity-and-trust-2026-07-01 P-044 (DG-1): the distributed
-- test gate's VERDICT FACTS — content-addressed, device-SIGNED shard-run
-- results {repo_key, staging_sha, shard_id, inputs_hash, verdict, duration_ms,
-- device_pubkey, ts, sig}, federated as DATA over the hive peer-log so the
-- DG-5 aggregator on any member machine can assemble green(S) from every
-- runner's verdicts.
--
-- Pattern = mig 438/439 (bee_claim_specs, the newest federated table):
-- federation columns + WHEN-gated CDC capture triggers + the
-- stamp_local_federated_write BEFORE trigger (the M7 trap — the
-- stamp-trigger-coverage guard REDs without it). harness_slug is the demux:
-- NULL = machine-local verdict (never federates); set = the hive HOME slug,
-- rides that hive's peer-log topic.
--
-- Rows are IMMUTABLE FACTS: verdict_id = sha256 of the signed payload
-- (verdicts.ts gateVerdictId), so writers INSERT … ON CONFLICT DO NOTHING and
-- there is no UPDATE path (no UPDATE capture trigger needed; the stamp trigger
-- stays BEFORE INSERT OR UPDATE per the mig-214 convention). DELETE federates
-- for hive-wide GC of superseded verdicts.

BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.gate_verdicts (
  workspace_id  text NOT NULL,
  -- Content address: sha256(hex) over the domain-tagged signed payload
  -- (verdicts.ts). The peer-log key + the dedup identity.
  verdict_id    text NOT NULL,
  -- Federation scope (438 idiom): NULL = local-only; set = hive HOME slug.
  harness_slug  text,
  -- Verdict wire-schema version (part of the signed bytes — needed to re-verify).
  schema_v      int NOT NULL DEFAULT 1,
  -- The managed repo whose gate this verdict feeds (G-1b: repo per (hive, repo)).
  repo_key      text NOT NULL,
  staging_sha   text NOT NULL,
  shard_id      text NOT NULL,
  inputs_hash   text NOT NULL,
  verdict       text NOT NULL CHECK (verdict IN ('pass', 'fail')),
  duration_ms   bigint NOT NULL DEFAULT 0,
  -- The RUNNER device's raw-32 Ed25519 pubkey (base64) — the signer.
  device_pubkey text NOT NULL,
  -- Signer's clock at signing (epoch ms) — part of the signed bytes.
  verdict_ts    bigint NOT NULL,
  -- base64 Ed25519 signature over the domain-tagged payload.
  sig           text NOT NULL,
  -- Standard federation provenance (mig 150/186/438 idiom).
  origin        text NOT NULL DEFAULT 'local',
  author_pubkey text,
  fed_ts        bigint,
  fed_hlc       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, verdict_id)
);

COMMENT ON TABLE harness_shared.gate_verdicts IS
  'Distributed test gate (DG-1 P-044): content-addressed, device-signed shard-run verdicts. Immutable facts — INSERT-only, dedup by verdict_id. The projection (gate-verdicts.ts) verifies signature + content address + signer membership on receive; whether a verdict COUNTS toward green is the DG-4/DG-5 trust decision.';
COMMENT ON COLUMN harness_shared.gate_verdicts.harness_slug IS
  'Federation scope: NULL = machine-local (never federates); set = the hive HOME slug — rides that hive''s peer-log.';
COMMENT ON COLUMN harness_shared.gate_verdicts.verdict_id IS
  'sha256(hex) of the domain-tagged signed payload (verdicts.ts gateVerdictId) — the content address, the peer-log key, and the dedup identity.';

-- The aggregator's coverage read: verdicts for a (hive, repo, shard) matched by
-- inputs_hash (reuse across staging shas — the DG-2 incremental contract).
CREATE INDEX IF NOT EXISTS gate_verdicts_shard_inputs_idx
  ON harness_shared.gate_verdicts (workspace_id, harness_slug, repo_key, shard_id, inputs_hash);
-- Audit / spot-check targeting: everything recorded at one staging sha.
CREATE INDEX IF NOT EXISTS gate_verdicts_staging_sha_idx
  ON harness_shared.gate_verdicts (workspace_id, harness_slug, repo_key, staging_sha);

-- M7 (mig 439 lesson): the BEFORE stamp trigger MUST accompany the capture
-- triggers on every fed_hlc-bearing table — without it local writes capture
-- op_hlc = NULL and LWW ordering silently breaks on peers.
DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.gate_verdicts;
CREATE TRIGGER stamp_local_federated_write_trg
  BEFORE INSERT OR UPDATE ON harness_shared.gate_verdicts
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();

-- CDC capture (echo-guard for origin<>'local' lives inside
-- capture_substrate_outbox). INSERT + DELETE only — verdict rows never UPDATE.
CREATE OR REPLACE TRIGGER capture_gate_verdicts_outbox_trg
  AFTER INSERT ON harness_shared.gate_verdicts
  FOR EACH ROW WHEN (NEW.harness_slug IS NOT NULL)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('verdict_id');

CREATE OR REPLACE TRIGGER capture_gate_verdicts_outbox_del_trg
  AFTER DELETE ON harness_shared.gate_verdicts
  FOR EACH ROW WHEN (OLD.harness_slug IS NOT NULL)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('verdict_id');

COMMIT;
