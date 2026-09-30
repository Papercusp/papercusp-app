-- 415-operator-owner-pins.sql — account-dynamic-pin-2026-06-29.
--
-- operator_owner_pins — the DURABLE map of dynamic agent→account pins the inference gateway honors
-- per-request (keyed by the `x-papercusp-owner` header), OVERRIDING an agent's static spawn pin. Set via
-- accounts:pin (any agent pins any agent by its owner id; its OWN id to self-pin); cleared via accounts:unpin.
--   payload = { "<ownerId>": { "account": "<accountId>", "hard": <bool> } }   ("hard" ⇒ no failover)
--
-- WHY ITS OWN TABLE: single-row-per-workspace JSONB — the operator-state idiom (migration 020 / account
-- pool 190 / rate config 161 / account override 297). It lives APART from operator_account_pool (190) so the
-- gateway's high-churn rate-projection writes can never clobber the pins (the same reason the account
-- override got its own table, 297). The gateway loads it at startup + on its pool-reload poll so pins SURVIVE
-- a gateway restart — in-memory alone dropped them silently on the wedge-watchdog / deploy / crash restarts.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe. Holds only account-id + owner-id
-- references, never a secret — plaintext JSONB like its operator-state siblings.

CREATE TABLE IF NOT EXISTS harness_shared.operator_owner_pins (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_owner_pins TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_owner_pins TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_owner_pins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_owner_pins_workspace_isolation ON harness_shared.operator_owner_pins;
CREATE POLICY operator_owner_pins_workspace_isolation ON harness_shared.operator_owner_pins
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
