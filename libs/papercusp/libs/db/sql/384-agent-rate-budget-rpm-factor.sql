-- 384-agent-rate-budget-rpm-factor.sql
-- C1 (inference-gateway-audit-2026-06-23): persist the adaptive-RPM learned factor cross-process.
--
-- The per-account governor learns a `rpmFactor ∈ [MIN,1]` (multiplicative-decrease on a rate-429, linear
-- recover) so `decideRate` paces an Anthropic-soft-throttled account UNDER its real sustainable rate instead of
-- re-429ing (the owner-requested predict→wait→learn→retry, 2026-06-22). But the cross-process PgGovernorStore
-- never persisted it: `transact` runs the rate gate against a freshly `rowToState`-loaded state where rpmFactor
-- is always undefined, and `syncSharedInto` doesn't carry it back — so with PAPERCUSP_AGENT_GOVERNOR_PG=1 (the
-- deployed mode) the entire adaptive pacing is computed on `effectiveRpmFactor === 1` every time. The account
-- keeps getting paced at the static floor and keeps walking into the same 429. These two columns let the learned
-- factor survive the round-trip.
--
-- Nullable: NULL = unset ⇒ effectiveRpmFactor treats it as 1 (byte-identical to today / legacy rows). Additive
-- + idempotent (ADD COLUMN IF NOT EXISTS).
ALTER TABLE harness_shared.agent_rate_budget
  ADD COLUMN IF NOT EXISTS rpm_factor    double precision,
  ADD COLUMN IF NOT EXISTS rpm_factor_at bigint;
