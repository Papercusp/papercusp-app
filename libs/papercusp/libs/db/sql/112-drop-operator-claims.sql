-- 112-drop-operator-claims.sql
--
-- dbos-flows P-002 (plan dbos-durable-flows-adoption-2026-06-02), full DBOS-only
-- cutover: the hand-rolled `provision/operator-claims` machinery — the PG
-- advisory-lock + 30s heartbeat that serialized concurrent (harness, plugin)
-- provisions — was DELETED with no shim once DBOS provisioning was live
-- crash-resume-verified (commit c98a7a6d8; the SIGKILL-mid-provision test on the
-- real :3070 host: recovery_attempts 1->2, PENDING->SUCCESS). Provision now runs
-- exclusively through the DBOS provision workflow, whose `deduplicationID` is the
-- cross-request mutex and whose recovery is the liveness — so the
-- `operator_claims` table has no remaining reader or writer (verified: zero TS
-- importers of `operatorClaimsInHarnessShared`).
--
-- Drop the now-dead table. Idempotent. After this applies, regenerate the drizzle
-- schema (`node libs/papercusp/libs/db/scripts/pull-schema.mjs`) to remove the
-- orphaned `operatorClaimsInHarnessShared` definition from the generated schema.

DROP TABLE IF EXISTS harness_shared.operator_claims;
