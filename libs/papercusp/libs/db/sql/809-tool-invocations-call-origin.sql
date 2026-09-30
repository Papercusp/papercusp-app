-- 809: distinguish HOOK-emitted tool calls from MODEL-CHOSEN ones (EI-20267598379696870).
--
-- `harness_shared.tool_invocations` is named for the TOOL, not for who CHOSE it, and every
-- existing provenance column (principal_kind, principal_auth_method, principal_trust, role,
-- transport) is identical — usually NULL — for both populations. Measured 2026-08-12 over 3h:
-- 37,121 of ~50,400 mcp rows (74%) were emitted by per-turn hooks, across 182 owners, spanning
-- only 9 tool names — all coordination verbs. So any agent-behavior metric computed from raw
-- counts is ~74% not-agent-behavior, and because hooks emit ONLY coordination verbs and never
-- work verbs the error is DIRECTIONAL: it never averages out, and it always renders agents as
-- coordinating rather than working.
--
-- Two columns, not one, because the failure this fixes was a wrong classification being
-- INDISTINGUISHABLE from a right one:
--   call_origin        — agent | hook | ui | system | unknown
--   call_origin_source — declared (the caller said so) | derived (we inferred it)
-- A consumer that needs certainty filters on call_origin_source='declared'; one that wants
-- coverage takes both and knows which half it is trusting. 'unknown' is deliberately a real,
-- storable value: an honest refusal to classify beats a confident guess, which is the whole
-- lesson of this bug.
--
-- Additive only: two nullable columns, no default, no backfill, no index. ADD COLUMN without a
-- default is O(1) in PG11+ and this table takes ~800K inserts/day, so it must stay that way.
-- Existing rows keep NULL, which reads correctly as "recorded before origin was tracked" and is
-- distinct from the 'unknown' we write when we looked and could not tell.

ALTER TABLE harness_shared.tool_invocations
  ADD COLUMN IF NOT EXISTS call_origin text,
  ADD COLUMN IF NOT EXISTS call_origin_source text;

COMMENT ON COLUMN harness_shared.tool_invocations.call_origin IS
  'Who CHOSE this call: agent (the model) | hook (per-turn harness automation) | ui | system | unknown. NULL = row predates migration 809. See lib/telemetry-call-origin.ts.';

COMMENT ON COLUMN harness_shared.tool_invocations.call_origin_source IS
  'How call_origin was determined: declared (caller marked itself, e.g. &origin=hook on the MCP url) | derived (inferred from request shape). Filter on declared for certainty.';
