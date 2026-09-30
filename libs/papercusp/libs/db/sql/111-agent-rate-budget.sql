-- 111-agent-rate-budget.sql
--
-- RB-007 (plan agent-turn-robustness-2026-06-02): the CROSS-PROCESS shared budget for the
-- agent RateLimitGovernor, so the whole fleet + the gym + this dev session pace against ONE
-- account budget instead of each process running its own in-memory limiter and co-bursting the
-- shared Anthropic/OpenAI account into a 429.
--
-- ONE row per bucket key `<provider>:<modelClass>` (e.g. 'anthropic:opus'). Mirrors the
-- in-memory GovernorState's RATE + PAUSE fields — the account-wide part. CONCURRENCY stays
-- per-process (a per-runner burst lever; the shared rate window already bounds aggregate request
-- rate), so there is no in_flight / lease column here by design.
--
-- Mutated under a single transactional read-modify-write (`SELECT … FOR UPDATE` then UPSERT) by
-- apps/operator/lib/agent-governor-pg-store.ts — the same pattern as harness_shared.operator_rate_limit.
-- The tumbling 60s window self-expires, so a crashed process leaks no state (its window ages out).
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.agent_rate_budget (
    -- '<provider>:<modelClass>', e.g. 'anthropic:opus' / 'openai:default'.
    bucket_key        text PRIMARY KEY,
    -- Tumbling 60s window accounting (epoch ms / counts), shared across processes.
    window_start      bigint NOT NULL DEFAULT 0,
    req_in_window     integer NOT NULL DEFAULT 0,
    in_tok_in_window  bigint NOT NULL DEFAULT 0,
    out_tok_in_window bigint NOT NULL DEFAULT 0,
    -- Account-wide pause: a 429 anywhere pauses every process until this epoch-ms reset.
    paused_until      bigint NOT NULL DEFAULT 0,
    -- Pre-emptive pacing gap (ms) derived from low *-remaining headers (review #7/#8).
    pace_delay_ms     integer NOT NULL DEFAULT 0,
    last_acquire_at   bigint NOT NULL DEFAULT 0,
    -- Auto-tuned limits (rpm/itpm/otpm/maxConcurrent) synced from provider headers (API-key mode).
    limits            jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at        bigint NOT NULL DEFAULT 0
);
