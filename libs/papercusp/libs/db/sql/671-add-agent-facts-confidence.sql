-- 671-add-agent-facts-confidence.sql — WI-6052 (EI-18681964809855890 follow-up)
--
-- WHY: `confidence` (evidence-strength: 'verified'|'provisional'|'suspected')
-- reached the AgentFact TypeScript contract, the write-side TTL shortening
-- (defaultTtlSecForConfidence), and the confidence_lint write-time nudge — but
-- never reached the SCHEMA. harness_shared.agent_facts had no `confidence`
-- column, so `assertFact`'s INSERT never wrote it and every SELECT/RETURNING
-- omitted it — the value was computed then silently discarded on every
-- assert, and `rowToFact` had to hardcode `confidence: null` for every row
-- (see store.ts's WI-6052 comment, now removed by the matching code change).
--
-- Nullable (backward compatible: existing rows + any caller that omits
-- `confidence` get NULL, which is the documented "unset — renders unbadged"
-- legacy shape). CHECK constraint mirrors agent_facts_scope_check's style —
-- validate the 3-tier enum at the DB layer too, not just in TS
-- (FACT_CONFIDENCE_LEVELS in store.ts), so a raw/out-of-band write can't
-- silently smuggle in an unrecognized tier.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS + DROP/ADD CONSTRAINT IF EXISTS).
-- Applied via the runner (db:migrate / A1 boot-apply).

ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS confidence text;

ALTER TABLE harness_shared.agent_facts
  DROP CONSTRAINT IF EXISTS agent_facts_confidence_check;

ALTER TABLE harness_shared.agent_facts
  ADD CONSTRAINT agent_facts_confidence_check
    CHECK (confidence IS NULL OR confidence = ANY (ARRAY['verified'::text, 'provisional'::text, 'suspected'::text]));
