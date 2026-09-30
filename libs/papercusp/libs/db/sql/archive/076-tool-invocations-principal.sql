-- 076-tool-invocations-principal.sql
--
-- Phase 3b step 4 (principal-rfc-2026-05-20.md §6 Q4).
--
-- Add the three Principal audit columns to harness_shared.tool_invocations
-- so /dev → Sessions can filter by auth method (cookie vs JWT vs
-- bearer file vs loopback) and trust level. Without these, every row
-- looks identical at the auth layer; debugging "did this come from a
-- trusted caller?" requires reading the route source.
--
-- Set by the dispatcher at completion time. Backfill: NULL for
-- existing rows (the dispatcher tolerates missing values via the
-- nullable column shape; readers default to "unknown" in the UI).
--
-- Schema cardinality vs storage tradeoff: enums would save bytes, but
-- the kind/authMethod enums extended in Phase 3b step 1 are likely to
-- grow when Track A ships (service kinds, OAuth scopes). Plain
-- text columns avoid the alter-type churn. The values are short
-- (< 32 chars each); storage is negligible vs row size already.
--
-- Indexes: not adding any. /dev filters by toolName + workspaceId
-- (existing indexes); auth columns are projected into the row payload
-- for display, not used as WHERE keys at scale. If a per-auth-method
-- analytics panel emerges, revisit then.

ALTER TABLE harness_shared.tool_invocations
  ADD COLUMN IF NOT EXISTS principal_kind text,
  ADD COLUMN IF NOT EXISTS principal_auth_method text,
  ADD COLUMN IF NOT EXISTS principal_trust text;
